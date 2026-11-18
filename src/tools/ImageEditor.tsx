import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

const FORMATS = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;
type Format = keyof typeof FORMATS;
type Src = HTMLImageElement | HTMLCanvasElement;
type Rect = { x: number; y: number; w: number; h: number }; // crop selection, 0..1 of the canvas
type Mode = "none" | "crop" | "erase" | "bg";

type BgTool = "pick" | "keep" | "remove";
const MAGENTA = [214, 0, 143]; // Word-style "will be removed" color

// Alpha after removing pixels close to `key` (tol = max per-channel difference, 0..255).
// A small band above tol fades softly so edges (e.g. signature ink) stay smooth.
// mask (RGBA, same size): green = force keep, red = force remove.
function bgAlpha(px: Uint8ClampedArray, key: [number, number, number], tol: number, mask?: Uint8ClampedArray) {
  const soft = 20;
  const out = new Uint8ClampedArray(px.length / 4);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const a = px[i + 3];
    const d = Math.max(Math.abs(px[i] - key[0]), Math.abs(px[i + 1] - key[1]), Math.abs(px[i + 2] - key[2]));
    out[j] = d <= tol ? 0 : d < tol + soft ? Math.round((a * (d - tol)) / soft) : a;
    if (mask?.[i + 1]! > 127) out[j] = a;
    else if (mask?.[i]! > 127) out[j] = 0;
  }
  return out;
}
const hex = (rgb: number[]) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];

const DEFAULTS = { rotate: 0, flipH: false, flipV: false, brightness: 100, contrast: 100, saturate: 100 };
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const dims = (s: Src) => (s instanceof HTMLImageElement ? { w: s.naturalWidth, h: s.naturalHeight } : { w: s.width, h: s.height });

export default function ImageEditor({ file }: { file?: File }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [original, setOriginal] = useState<Src | null>(null);
  const [img, setImg] = useState<Src | null>(null);
  const [history, setHistory] = useState<Src[]>([]);
  const [name, setName] = useState("image");
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [keepRatio, setKeepRatio] = useState(true);
  const [fx, setFx] = useState(DEFAULTS);
  const [format, setFormat] = useState<Format>("png");
  const [quality, setQuality] = useState(90);
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState<Mode>("none");
  const [sel, setSel] = useState<Rect | null>(null);
  const [brush, setBrush] = useState(30);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0 }); // canvas position on screen
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [bgColor, setBgColor] = useState("#ffffff");
  const [tolerance, setTolerance] = useState(60);
  const raw = useRef<ImageData | null>(null); // canvas before bg-removal preview
  const mask = useRef<HTMLCanvasElement | null>(null); // keep/remove marks for bg removal
  const [bgTool, setBgTool] = useState<BgTool>("pick");
  const [maskVer, setMaskVer] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null); // null = fit to view, 1 = actual pixels
  const viewRef = useRef<HTMLElement>(null);

  function show(s: Src) {
    setImg(s);
    setSize(dims(s));
    setFx(DEFAULTS);
    setSel(null);
  }

  function open(file: File) {
    const el = new Image();
    el.onload = () => {
      if (original instanceof HTMLImageElement) URL.revokeObjectURL(original.src);
      setOriginal(el);
      setHistory([]);
      setMode("none");
      setZoom(null);
      show(el);
      setName(file.name.replace(/\.[^.]+$/, ""));
      setStatus("");
    };
    el.onerror = () => setStatus("เปิดไฟล์นี้ไม่ได้");
    el.src = URL.createObjectURL(file);
  }

  useEffect(() => {
    if (file) open(file);
  }, [file]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!img || !c || !size.w || !size.h) return;
    const sideways = fx.rotate % 180 !== 0;
    c.width = sideways ? size.h : size.w;
    c.height = sideways ? size.w : size.h;
    const ctx = c.getContext("2d")!;
    if (format === "jpg") {
      ctx.fillStyle = "#fff"; // jpg has no transparency
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.filter = `brightness(${fx.brightness}%) contrast(${fx.contrast}%) saturate(${fx.saturate}%)`;
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((fx.rotate * Math.PI) / 180);
    ctx.scale(fx.flipH ? -1 : 1, fx.flipV ? -1 : 1);
    ctx.drawImage(img, -size.w / 2, -size.h / 2, size.w, size.h);
    raw.current = null;
    if (mode === "bg") {
      // live preview, Word-style: areas to be removed are tinted magenta
      const data = ctx.getImageData(0, 0, c.width, c.height);
      raw.current = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
      if (mask.current?.width !== c.width || mask.current.height !== c.height) {
        mask.current = Object.assign(document.createElement("canvas"), { width: c.width, height: c.height });
      }
      const m = mask.current.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      const alpha = bgAlpha(data.data, fromHex(bgColor), tolerance, m);
      const px = data.data;
      for (let i = 0, j = 0; i < px.length; i += 4, j++) {
        if (!px[i + 3]) continue;
        const f = 1 - alpha[j] / px[i + 3]; // fraction removed
        for (let k = 0; k < 3; k++) px[i + k] = px[i + k] * (1 - f) + MAGENTA[k] * f;
      }
      ctx.putImageData(data, 0, 0);
    }
  }, [img, size, fx, format, mode, bgColor, tolerance, maskVer]);

  // keep the overlay aligned with the canvas as the window/image resizes
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() =>
      setBox({ left: c.offsetLeft, top: c.offsetTop, width: c.offsetWidth, height: c.offsetHeight }),
    );
    ro.observe(c);
    ro.observe(c.parentElement!);
    return () => ro.disconnect();
  }, [img]);

  const cw = fx.rotate % 180 ? size.h : size.w; // canvas width in px
  const shownZoom = zoom ?? (cw ? box.width / cw : 1);
  const zoomBy = (f: number) => setZoom(Math.min(16, Math.max(0.05, shownZoom * f)));

  // Ctrl + wheel zooms (native listener: React's onWheel is passive, can't preventDefault)
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  function setWidth(w: number) {
    const n = img && dims(img);
    setSize((s) => ({ w, h: keepRatio && n ? Math.round((w * n.h) / n.w) : s.h }));
  }
  function setHeight(h: number) {
    const n = img && dims(img);
    setSize((s) => ({ h, w: keepRatio && n ? Math.round((h * n.w) / n.h) : s.w }));
  }

  const c = canvasRef.current;
  const cropPx = sel && c && {
    x: Math.round(sel.x * c.width), y: Math.round(sel.y * c.height),
    w: Math.round(sel.w * c.width), h: Math.round(sel.h * c.height),
  };

  // bakes the current canvas (all edits, optionally a region of it) into the new source image
  function bake(r = { x: 0, y: 0, w: c!.width, h: c!.height }, from: CanvasImageSource = c!) {
    const out = document.createElement("canvas");
    out.width = r.w;
    out.height = r.h;
    out.getContext("2d")!.drawImage(from, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    setHistory((h) => [...h.slice(-29), img!]); // ponytail: 30 full-size copies max; store diffs if memory hurts
    show(out);
  }

  function pixelAt(p: { x: number; y: number }) {
    const x = Math.min(c!.width - 1, Math.floor(p.x * c!.width));
    const y = Math.min(c!.height - 1, Math.floor(p.y * c!.height));
    if (raw.current) return Array.from(raw.current.data.slice((y * c!.width + x) * 4, (y * c!.width + x) * 4 + 3));
    return Array.from(c!.getContext("2d")!.getImageData(x, y, 1, 1).data).slice(0, 3);
  }

  function startBg() {
    mask.current = null;
    setBgTool("pick");
    setBgColor(hex(pixelAt({ x: 0, y: 0 }))); // guess: top-left corner
    toggleMode("bg");
  }

  function removeBg() {
    const r = raw.current!;
    const m = mask.current!.getContext("2d")!.getImageData(0, 0, r.width, r.height).data;
    const alpha = bgAlpha(r.data, fromHex(bgColor), tolerance, m);
    const out = new ImageData(new Uint8ClampedArray(r.data), r.width, r.height);
    for (let j = 0; j < alpha.length; j++) out.data[j * 4 + 3] = alpha[j];
    const cv = Object.assign(document.createElement("canvas"), { width: r.width, height: r.height });
    cv.getContext("2d")!.putImageData(out, 0, 0);
    bake(undefined, cv);
    setMode("none");
  }

  const point = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };

  type Pt = { x: number; y: number };
  function line(target: HTMLCanvasElement, from: Pt, to: Pt, color: string, op: GlobalCompositeOperation = "source-over") {
    const ctx = target.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.globalCompositeOperation = op;
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.lineWidth = brush * (target.width / box.width); // brush size is in screen px
    ctx.beginPath();
    ctx.moveTo(from.x * target.width, from.y * target.height);
    ctx.lineTo(to.x * target.width, to.y * target.height);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
  }
  function paint(from: Pt, to: Pt) {
    if (mode === "erase") return line(c!, from, to, "#000", "destination-out");
    const color = bgTool === "keep" ? "#00ff00" : "#ff0000";
    line(mask.current!, from, to, color); // marks keep overriding each other: last stroke wins
    line(c!, from, to, bgTool === "keep" ? "rgba(0,200,0,0.6)" : "rgba(214,0,143,0.8)"); // instant feedback
  }

  function onDown(e: React.PointerEvent<HTMLDivElement>) {
    const p = point(e);
    if (mode === "bg" && bgTool === "pick") return setBgColor(hex(pixelAt(p)));
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = p;
    if (mode === "crop") setSel(null);
    else paint(p, p);
  }
  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const p = point(e);
    setHover(p);
    const s = dragStart.current;
    if (!s) return;
    if (mode === "crop") {
      setSel({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
    } else {
      paint(s, p);
      dragStart.current = p;
    }
  }
  function onUp() {
    if (dragStart.current && mode === "erase") bake(); // keep the stroke
    if (dragStart.current && mode === "bg") setMaskVer((v) => v + 1); // recompute preview with new marks
    dragStart.current = null;
  }

  async function exportImage() {
    const blob = await new Promise<Blob | null>((r) => c!.toBlob(r, FORMATS[format], quality / 100));
    if (!blob) return setStatus("แปลงรูปไม่สำเร็จ");
    const path = await save({
      defaultPath: `${name}-edited.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;
    try {
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      setStatus(`บันทึกแล้ว: ${path}`);
    } catch (e) {
      setStatus(`บันทึกไม่สำเร็จ: ${e}`);
    }
  }

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) open(f);
    e.target.value = ""; // allow re-opening the same file
  };

  const slider = (label: string, key: "brightness" | "contrast" | "saturate") => (
    <label className="block text-sm">
      <span className="flex justify-between">
        {label} <span className="text-neutral-500">{fx[key]}%</span>
      </span>
      <input
        type="range" min={0} max={200} value={fx[key]} className="w-full"
        onChange={(e) => setFx({ ...fx, [key]: +e.target.value })}
      />
    </label>
  );
  const btn = "rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-40";
  const primary = "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40";
  const active = "rounded-md border border-blue-600 bg-blue-50 px-3 py-1.5 text-sm text-blue-700";
  const field = "w-full rounded-md border border-neutral-300 px-2 py-1 text-sm";
  const heading = "mb-2 text-xs font-semibold uppercase text-neutral-500";
  const brushMode = mode === "erase" || (mode === "bg" && bgTool !== "pick");
  const toggleMode = (m: Mode) => { setMode(mode === m ? "none" : m); setSel(null); };

  return (
    <div className="flex h-full">
      <section ref={viewRef} className="relative flex min-w-0 flex-1 overflow-auto p-6">
        {img ? (
          <>
            <canvas
              ref={canvasRef}
              style={zoom ? { width: cw * zoom } : undefined}
              className={`m-auto shrink-0 shadow-md [background:repeating-conic-gradient(#cfcfcf_0_25%,#fff_0_50%)_0_0/20px_20px] ${zoom ? "max-w-none" : "max-h-full max-w-full object-contain"}`}
            />
            <div className="fixed bottom-4 left-4 z-10 flex items-center gap-1 rounded-md border border-neutral-300 bg-white p-1 text-sm shadow">
              <button className="rounded px-2 hover:bg-neutral-100" onClick={() => zoomBy(1 / 1.25)}>−</button>
              <button className="w-14 rounded hover:bg-neutral-100" title="ขนาดจริง (100%)" onClick={() => setZoom(1)}>
                {Math.round(shownZoom * 100)}%
              </button>
              <button className="rounded px-2 hover:bg-neutral-100" onClick={() => zoomBy(1.25)}>+</button>
              <button className="rounded px-2 hover:bg-neutral-100" onClick={() => setZoom(null)}>พอดีจอ</button>
            </div>
            {mode !== "none" && (
              <div
                style={box}
                className={`absolute touch-none overflow-hidden ${brushMode ? "cursor-none" : "cursor-crosshair"}`}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerLeave={() => setHover(null)}
              >
                {mode === "crop" && sel && (
                  <div
                    className="absolute border-2 border-dashed border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]"
                    style={{ left: `${sel.x * 100}%`, top: `${sel.y * 100}%`, width: `${sel.w * 100}%`, height: `${sel.h * 100}%` }}
                  />
                )}
                {brushMode && hover && (
                  <div
                    className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white shadow-[0_0_0_1px_black]"
                    style={{ left: `${hover.x * 100}%`, top: `${hover.y * 100}%`, width: brush, height: brush }}
                  />
                )}
              </div>
            )}
          </>
        ) : (
          <label className="cursor-pointer rounded-xl border-2 border-dashed border-neutral-300 px-16 py-20 text-center text-neutral-500 hover:border-blue-500 hover:text-blue-600">
            คลิกเพื่อเลือกรูปภาพ
            <input type="file" accept="image/*" hidden onChange={pick} />
          </label>
        )}
      </section>

      <aside className="w-72 shrink-0 space-y-5 overflow-y-auto border-l border-neutral-200 bg-white p-4">
        <label className={`${btn} block cursor-pointer text-center`}>
          เปิดรูปภาพ…
          <input type="file" accept="image/*" hidden onChange={pick} />
        </label>

        <fieldset disabled={!img} className="space-y-5 disabled:opacity-50">
          <div>
            <h2 className={heading}>เครื่องมือ</h2>
            <div className="grid grid-cols-3 gap-2">
              <button className={mode === "crop" ? active : btn} onClick={() => toggleMode("crop")}>✂ ครอป</button>
              <button className={mode === "erase" ? active : btn} onClick={() => toggleMode("erase")}>⌫ ยางลบ</button>
              <button
                className={btn}
                disabled={!history.length}
                onClick={() => { show(history[history.length - 1]); setHistory(history.slice(0, -1)); }}
              >
                ↶ Undo
              </button>
            </div>
            <button
              className={`${mode === "bg" ? active : btn} mt-2 w-full`}
              onClick={() => (mode === "bg" ? toggleMode("bg") : startBg())}
            >
              🪄 ลบพื้นหลัง
            </button>

            {mode === "bg" && (
              <div className="mt-3 space-y-3">
                <p className="text-xs text-neutral-500">
                  <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: `rgb(${MAGENTA})` }} />
                  สีม่วงชมพู = ส่วนที่จะถูกลบ
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  {([["pick", "🎯 เลือกสี"], ["keep", "＋ จะเก็บ"], ["remove", "－ จะลบ"]] as const).map(([t, label]) => (
                    <button key={t} className={`${bgTool === t ? active : btn} px-1 text-xs`} onClick={() => setBgTool(t)}>
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-neutral-500">
                  {bgTool === "pick"
                    ? "คลิกบนรูปตรงพื้นหลังเพื่อเลือกสีที่จะลบ"
                    : bgTool === "keep"
                      ? "ระบายส่วนที่อยากเก็บไว้"
                      : "ระบายส่วนที่อยากลบเพิ่ม"}
                </p>
                {bgTool !== "pick" && (
                  <label className="block text-sm">
                    <span className="flex justify-between">
                      ขนาดแปรง <span className="text-neutral-500">{brush}px</span>
                    </span>
                    <input type="range" min={2} max={200} value={brush} onChange={(e) => setBrush(+e.target.value)} className="w-full" />
                  </label>
                )}
                <label className="flex items-center gap-2 text-sm">
                  สีพื้นหลัง
                  <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="h-7 w-12" />
                  <span className="text-xs text-neutral-500">{bgColor}</span>
                </label>
                <label className="block text-sm">
                  <span className="flex justify-between">
                    ความไว <span className="text-neutral-500">{tolerance}</span>
                  </span>
                  <input type="range" min={0} max={200} value={tolerance} onChange={(e) => setTolerance(+e.target.value)} className="w-full" />
                </label>
                <button
                  className={`${btn} w-full text-xs`}
                  onClick={() => { mask.current = null; setMaskVer((v) => v + 1); }}
                >
                  ล้างเครื่องหมายทั้งหมด
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button className={primary} onClick={removeBg}>เก็บการเปลี่ยนแปลง</button>
                  <button className={btn} onClick={() => toggleMode("bg")}>ยกเลิก</button>
                </div>
              </div>
            )}

            {mode === "crop" && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-neutral-500">
                  {cropPx ? `${cropPx.w} × ${cropPx.h} px` : "ลากบนรูปเพื่อเลือกพื้นที่"}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button className={primary} disabled={!cropPx?.w || !cropPx?.h} onClick={() => { bake(cropPx!); setMode("none"); }}>
                    ใช้ครอป
                  </button>
                  <button className={btn} onClick={() => toggleMode("crop")}>ยกเลิก</button>
                </div>
              </div>
            )}

            {mode === "erase" && (
              <label className="mt-3 block text-sm">
                <span className="flex justify-between">
                  ขนาดยางลบ <span className="text-neutral-500">{brush}px</span>
                </span>
                <input type="range" min={2} max={200} value={brush} onChange={(e) => setBrush(+e.target.value)} className="w-full" />
              </label>
            )}
          </div>

          <div>
            <h2 className={heading}>หมุน / พลิก</h2>
            <div className="grid grid-cols-2 gap-2">
              <button className={btn} onClick={() => setFx({ ...fx, rotate: (fx.rotate + 270) % 360 })}>↺ 90°</button>
              <button className={btn} onClick={() => setFx({ ...fx, rotate: (fx.rotate + 90) % 360 })}>↻ 90°</button>
              <button className={btn} onClick={() => setFx({ ...fx, flipH: !fx.flipH })}>⇋ แนวนอน</button>
              <button className={btn} onClick={() => setFx({ ...fx, flipV: !fx.flipV })}>⇵ แนวตั้ง</button>
            </div>
          </div>

          <div>
            <h2 className={heading}>ขนาด (px)</h2>
            <div className="flex items-center gap-2">
              <input type="number" min={1} value={size.w} onChange={(e) => setWidth(+e.target.value)} className={field} />
              ×
              <input type="number" min={1} value={size.h} onChange={(e) => setHeight(+e.target.value)} className={field} />
            </div>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={keepRatio} onChange={(e) => setKeepRatio(e.target.checked)} /> คงอัตราส่วน
            </label>
          </div>

          <div className="space-y-3">
            <h2 className={heading}>ปรับแสง / สี</h2>
            {slider("ความสว่าง", "brightness")}
            {slider("คอนทราสต์", "contrast")}
            {slider("ความอิ่มสี", "saturate")}
          </div>

          <button
            className={`${btn} w-full`}
            onClick={() => {
              if (!original) return;
              setHistory([]);
              setMode("none");
              show(original);
            }}
          >
            รีเซ็ต (กลับเป็นรูปต้นฉบับ)
          </button>

          <div className="space-y-3 border-t border-neutral-200 pt-4">
            <h2 className="text-xs font-semibold uppercase text-neutral-500">ส่งออก</h2>
            <select value={format} onChange={(e) => setFormat(e.target.value as Format)} className={field}>
              <option value="png">PNG</option>
              <option value="jpg">JPG</option>
              <option value="webp">WEBP</option>
            </select>
            {format !== "png" && (
              <label className="block text-sm">
                <span className="flex justify-between">
                  คุณภาพ <span className="text-neutral-500">{quality}%</span>
                </span>
                <input type="range" min={1} max={100} value={quality} onChange={(e) => setQuality(+e.target.value)} className="w-full" />
              </label>
            )}
            <button onClick={exportImage} className={`${primary} w-full py-2`}>
              บันทึกรูป
            </button>
          </div>
        </fieldset>
        {status && <p className="break-all text-xs text-neutral-600">{status}</p>}
      </aside>
    </div>
  );
}

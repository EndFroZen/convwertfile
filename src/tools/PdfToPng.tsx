import { useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { open } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const SCALES = [1, 2, 3, 4]; // 1 = 72 DPI

async function renderPage(doc: pdfjs.PDFDocumentProxy, n: number, scale: number) {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;
  page.cleanup();
  return canvas;
}

export default function PdfToPng({ openInEditor }: { openInEditor?: (f: File) => void }) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [name, setName] = useState("");
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [scale, setScale] = useState(2);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function load(file: File) {
    await doc?.loadingTask.destroy();
    setDoc(null);
    setThumbs([]);
    setStatus("กำลังเปิด…");
    try {
      const d = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      setDoc(d);
      setName(file.name.replace(/\.pdf$/i, ""));
      setSelected(new Set(Array.from({ length: d.numPages }, (_, i) => i + 1)));
      setStatus("");
      for (let n = 1; n <= d.numPages; n++) {
        const url = (await renderPage(d, n, 0.4)).toDataURL();
        setThumbs((t) => [...t, url]);
      }
    } catch (e) {
      setStatus(`เปิดไฟล์ไม่ได้: ${e}`);
    }
  }

  async function exportPages() {
    if (!doc) return;
    const dir = await open({ directory: true, title: "เลือกโฟลเดอร์ที่จะบันทึก" });
    if (!dir) return;
    setBusy(true);
    const pages = [...selected].sort((a, b) => a - b);
    try {
      for (const [i, n] of pages.entries()) {
        setStatus(`กำลังบันทึก ${i + 1}/${pages.length}…`);
        const canvas = await renderPage(doc, n, scale);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
        if (!blob) throw new Error(`หน้า ${n} แปลงไม่สำเร็จ`);
        await writeFile(await join(dir, `${name}-p${n}.png`), new Uint8Array(await blob.arrayBuffer()));
      }
      setStatus(`บันทึก ${pages.length} ไฟล์ไปที่ ${dir}`);
    } catch (e) {
      setStatus(`บันทึกไม่สำเร็จ: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function sendToEditor() {
    const [n] = selected;
    setBusy(true);
    try {
      const canvas = await renderPage(doc!, n, scale);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error(`หน้า ${n} แปลงไม่สำเร็จ`);
      openInEditor?.(new File([blob], `${name}-p${n}.png`, { type: "image/png" }));
    } catch (e) {
      setStatus(`แปลงไม่สำเร็จ: ${e}`);
      setBusy(false);
    }
  }

  const toggle = (n: number) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });

  const btn = "rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-40";
  const picker = (
    <input
      type="file" accept="application/pdf,.pdf" hidden
      onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); e.target.value = ""; }}
    />
  );

  return (
    <div className="flex h-full">
      <section className="min-w-0 flex-1 overflow-y-auto p-6">
        {doc ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
            {Array.from({ length: doc.numPages }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                onClick={() => toggle(n)}
                className={`rounded-lg border-2 bg-white p-2 text-xs ${selected.has(n) ? "border-blue-600" : "border-transparent opacity-50"}`}
              >
                {thumbs[n - 1] ? (
                  <img src={thumbs[n - 1]} className="mx-auto max-h-48 shadow" />
                ) : (
                  <div className="flex h-48 items-center justify-center text-neutral-400">…</div>
                )}
                <div className="mt-1">หน้า {n}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <label className="cursor-pointer rounded-xl border-2 border-dashed border-neutral-300 px-16 py-20 text-center text-neutral-500 hover:border-blue-500 hover:text-blue-600">
              คลิกเพื่อเลือกไฟล์ PDF
              {picker}
            </label>
          </div>
        )}
      </section>

      <aside className="w-72 shrink-0 space-y-5 overflow-y-auto border-l border-neutral-200 bg-white p-4">
        <label className={`${btn} block cursor-pointer text-center`}>
          เปิดไฟล์ PDF…
          {picker}
        </label>

        <fieldset disabled={!doc || busy} className="space-y-5 disabled:opacity-50">
          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase text-neutral-500">
              หน้าที่เลือก ({selected.size}/{doc?.numPages ?? 0})
            </h2>
            <div className="grid grid-cols-2 gap-2">
              <button className={btn} onClick={() => setSelected(new Set(Array.from({ length: doc!.numPages }, (_, i) => i + 1)))}>
                เลือกทั้งหมด
              </button>
              <button className={btn} onClick={() => setSelected(new Set())}>ไม่เลือก</button>
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase text-neutral-500">ความละเอียด</h2>
            <select value={scale} onChange={(e) => setScale(+e.target.value)} className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm">
              {SCALES.map((s) => (
                <option key={s} value={s}>{s}x ({s * 72} DPI)</option>
              ))}
            </select>
          </div>

          <button
            onClick={exportPages}
            disabled={!selected.size}
            className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            แปลงเป็น PNG
          </button>
          {selected.size === 1 && openInEditor && (
            <button onClick={sendToEditor} className={`${btn} w-full`}>
              🖼️ ส่งต่อไปที่ Image Editor
            </button>
          )}
        </fieldset>
        {status && <p className="break-all text-xs text-neutral-600">{status}</p>}
      </aside>
    </div>
  );
}

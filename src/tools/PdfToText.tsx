import { useState } from "react";

// ponytail: endpoint hardcoded via env; add a settings field if users need to change it at runtime
const API_URL = import.meta.env.VITE_PDF2TEXT_URL ?? "http://localhost:8000/pdf-to-text";

export default function PdfToText() {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function convert() {
    if (!file) return;
    setBusy(true);
    setText("");
    setStatus("กำลังส่งไฟล์และรอผลลัพธ์…");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(API_URL, { method: "POST", body: form });
      const body = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${body}`);
      setText(body);
      setStatus("เสร็จแล้ว");
    } catch (e) {
      setStatus(`แปลงไม่สำเร็จ: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  const btn = "rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-40";

  return (
    <div className="flex h-full">
      <section className="min-w-0 flex-1 p-6">
        <textarea
          readOnly value={text} placeholder="ผลลัพธ์จะแสดงที่นี่"
          className="h-full w-full resize-none rounded-lg border border-neutral-300 bg-white p-4 font-mono text-sm"
        />
      </section>

      <aside className="w-72 shrink-0 space-y-5 overflow-y-auto border-l border-neutral-200 bg-white p-4">
        <label className={`${btn} block cursor-pointer text-center`}>
          {file ? file.name : "เปิดไฟล์ PDF…"}
          <input
            type="file" accept="application/pdf,.pdf" hidden
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }}
          />
        </label>
        <button
          onClick={convert}
          disabled={!file || busy}
          className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? "กำลังแปลง…" : "แปลงเป็นข้อความ"}
        </button>
        <button onClick={() => navigator.clipboard.writeText(text)} disabled={!text} className={`${btn} w-full`}>
          คัดลอกข้อความ
        </button>
        {status && <p className="break-all text-xs text-neutral-600">{status}</p>}
      </aside>
    </div>
  );
}

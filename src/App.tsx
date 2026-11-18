import { Component as ReactComponent, useState, type ComponentType, type ReactNode } from "react";
import "./App.css";
import ImageEditor from "./tools/ImageEditor";
import PdfToPng from "./tools/PdfToPng";
import PdfToText from "./tools/PdfToText";

type Item = { id: string; name: string; desc: string; icon: string; Component?: ComponentType<{ file?: File; openInEditor: (f: File) => void }>; children?: Item[] };

const tools: Item[] = [
  { id: "image", name: "Image Editor", desc: "หมุน ปรับขนาด ปรับสี แปลงไฟล์รูป", icon: "🖼️", Component: ImageEditor },
  {
    id: "convert", name: "Convert", desc: "แปลงไฟล์ระหว่างรูปแบบต่างๆ", icon: "🔄",
    children: [
      { id: "pdf2png", name: "PDF → PNG", desc: "แปลงแต่ละหน้า PDF เป็นรูป PNG", icon: "📄", Component: PdfToPng },
      { id: "pdf2text", name: "PDF → Text", desc: "ส่ง PDF ไปแปลงเป็นข้อความ", icon: "📝", Component: PdfToText },
    ],
  },
];

// a crash inside one tool shows a message instead of a blank white window
class Boundary extends ReactComponent<{ children: ReactNode; onBack: () => void }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <p className="font-semibold">เกิดข้อผิดพลาด</p>
        <pre className="max-w-xl whitespace-pre-wrap text-xs text-red-600">{String(this.state.error)}</pre>
        <button onClick={this.props.onBack} className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm">
          ← กลับ
        </button>
      </div>
    );
  }
}

function App() {
  const [path, setPathRaw] = useState<Item[]>([]);
  const [handoff, setHandoff] = useState<File>(); // file one tool passes to another
  const setPath = (p: Item[]) => { setHandoff(undefined); setPathRaw(p); };
  const openInEditor = (f: File) => { setHandoff(f); setPathRaw([tools[0]]); };
  const current = path[path.length - 1] as Item | undefined;
  const items = current ? current.children ?? [] : tools;

  return (
    <div className="flex h-screen flex-col bg-neutral-100 text-neutral-900">
      {current && (
        <header className="flex items-center gap-1 border-b border-neutral-200 bg-white px-3 py-2 text-sm">
          <button onClick={() => setPath(path.slice(0, -1))} className="mr-2 rounded-md px-3 py-1.5 hover:bg-neutral-100">
            ← กลับ
          </button>
          <button onClick={() => setPath([])} className="rounded px-1.5 py-1 text-neutral-500 hover:bg-neutral-100">
            หน้าแรก
          </button>
          {path.map((p, i) => (
            <span key={p.id} className="flex items-center gap-1">
              <span className="text-neutral-400">/</span>
              <button
                onClick={() => setPath(path.slice(0, i + 1))}
                className={`rounded px-1.5 py-1 hover:bg-neutral-100 ${i === path.length - 1 ? "font-semibold" : "text-neutral-500"}`}
              >
                {p.icon} {p.name}
              </button>
            </span>
          ))}
        </header>
      )}

      <main className="min-h-0 flex-1 overflow-auto">
        {current?.Component ? (
          <Boundary key={current.id} onBack={() => setPath(path.slice(0, -1))}>
            <current.Component file={handoff} openInEditor={openInEditor} />
          </Boundary>
        ) : (
          <div className="p-10">
            <h1 className="mb-8 text-2xl font-bold">{current ? current.name : "เครื่องมือ"}</h1>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-5">
              {items.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setPath([...path, t])}
                  className="flex flex-col items-center gap-3 rounded-2xl bg-white p-6 text-center shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                >
                  <span className="text-5xl">{t.icon}</span>
                  <span className="font-semibold">{t.name}</span>
                  <span className="text-xs text-neutral-500">{t.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;

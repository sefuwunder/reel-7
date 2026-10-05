/* REEL-7 static server. Bun + zero dependencies. */
const PORT = Number(process.env.REEL7_PORT || 3024);
const ROOT = import.meta.dir;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webm": "audio/webm",
  ".wav": "audio/wav",
};

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path === "/" || path === "") path = "/index.html";
    // block path traversal
    const file = Bun.file(ROOT + path);
    if (path.includes("..") || !(await file.exists())) {
      // SPA fallback for unknown paths (except asset-looking ones)
      if (!/\.[a-z0-9]+$/i.test(path)) {
        return new Response(Bun.file(ROOT + "/index.html"), {
          headers: { "Content-Type": TYPES[".html"] },
        });
      }
      return new Response("not found", { status: 404 });
    }
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    return new Response(file, {
      headers: { "Content-Type": TYPES[ext] || "application/octet-stream" },
    });
  },
});

console.log(`REEL-7 listening on http://127.0.0.1:${PORT}`);

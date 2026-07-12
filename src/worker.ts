interface Env {
  UPSTREAM_REPO?: string;
  REFRESH_TOKEN?: string;
}

const DEFAULT_UPSTREAM = "https://ipogo.app/repo";
const edgeCache = (caches as unknown as { default: Cache }).default;
const METADATA_PATHS = [
  "/Release",
  "/Packages",
  "/Packages.gz",
  "/Packages.bz2",
  "/CydiaIcon.png",
  "/repo.xml",
  "/depictions/",
  "/depictions/index.html",
  "/depictions/screenshots.html",
  "/depictions/changelog.html",
  "/depictions/style.css",
  "/depictions/js/jquery.querystring.js",
  "/depictions/js/data-loader-engine.js",
  "/depictions/js/ios_version_check.js",
  "/depictions/com.iteam.ipogo/info.xml",
];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

type PackageVersion = { id: string; name: string; version: string; sha256: string | null };

function currentPackages(packages: string): PackageVersion[] {
  const latest = new Map<string, PackageVersion>();
  for (const record of packages.trim().split(/\n\s*\n/)) {
    const id = record.match(/^Package: ([^\r\n]+)$/m)?.[1];
    const version = record.match(/^Version: ([^\r\n]+)$/m)?.[1];
    const name = record.match(/^Name: ([^\r\n]+)$/m)?.[1] ?? id;
    const sha256 = record.match(/^SHA256: ([^\r\n]+)$/m)?.[1] ?? null;
    if (id && name && version) latest.set(id, { id, name, version, sha256 });
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function homePage(origin: string, env: Env, ctx: ExecutionContext): Promise<Response> {
  const key = cacheRequest("/Packages");
  let index = await edgeCache.match(key);
  if (!index) index = await cacheUpstreamPath("/Packages", env);
  else ctx.waitUntil(cacheUpstreamPath("/Packages", env).catch(() => undefined));

  const packages = currentPackages(await index.text());
  const updated = index.headers.get("Last-Modified") || new Date().toUTCString();
  const ipogo = packages.find((item) => item.id === "com.iteam.ipogo");
  const remaining = packages.filter((item) => item.id !== "com.iteam.ipogo");
  const sileo = `sileo://source/${origin}`;
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>iPoGo Repository Mirror</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{position:relative;width:min(620px,calc(100% - 36px));padding:64px 0}.github{position:absolute;top:28px;right:0;color:#aaa;text-decoration:none;font-size:.85rem}.github:hover{color:#fff}.eyebrow,.label{color:#888;font-size:.72rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{margin:8px 0 10px;font-size:clamp(2.25rem,7vw,3.6rem);line-height:1;letter-spacing:-.045em}.intro{max-width:430px;margin:0;color:#aaa;font-size:1.05rem}.actions{display:flex;gap:10px;flex-wrap:wrap;margin:28px 0 42px}.button{padding:10px 15px;border:1px solid #fff;border-radius:999px;color:#fff;text-decoration:none;font-size:.9rem;font-weight:650}.button.primary{background:#fff;color:#000}.updated{margin:0 0 10px;color:#777;font-size:.78rem}.package{padding:20px;border:1px solid #292929;border-radius:14px;background:#080808}.package-head{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-top:7px;font-size:1.15rem;font-weight:650}.version,.hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.hash-label{display:block;margin:20px 0 6px;color:#777;font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.hash{overflow-wrap:anywhere;padding-top:10px;border-top:1px solid #292929;color:#aaa;font-size:.73rem;line-height:1.7}.versions{margin:10px 0 0;padding:0;list-style:none;border-top:1px solid #292929}.versions li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid #292929}.versions span:last-child{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}details{margin-top:16px;color:#888;font-size:.9rem}summary{cursor:pointer;user-select:none}details[open] summary{color:#fff}.empty{color:#888}@media(max-width:520px){.card{padding-top:72px}.github{top:24px}h1{font-size:2.7rem}.actions{margin-bottom:34px}.package{padding:17px}.package-head{font-size:1rem}}</style></head>
<body><main class="card"><a class="github" href="https://github.com/AlexSpaces/ipogo-mirror">GitHub ↗</a><span class="eyebrow">Repository mirror</span><h1>iPoGo</h1><p class="intro">A fast, automatically refreshed mirror of the iPoGo package repository.</p><div class="actions"><a class="button primary" href="${sileo}">Add to Sileo</a><a class="button" href="https://ipogo.app/repo">View origin</a></div><p class="updated">Updated ${escapeHtml(updated)}</p>${ipogo ? `<section class="package"><span class="label">Latest package</span><div class="package-head"><span>${escapeHtml(ipogo.name)}</span><span class="version">${escapeHtml(ipogo.version)}</span></div>${ipogo.sha256 ? `<span class="hash-label">SHA-256 checksum</span><div class="hash">${escapeHtml(ipogo.sha256)}</div>` : ""}</section>` : `<p class="empty">Package information is temporarily unavailable.</p>`}<details><summary>Other packages (${remaining.length})</summary><ul class="versions">${remaining.map(({ name, version }) => `<li><span>${escapeHtml(name)}</span><span>${escapeHtml(version)}</span></li>`).join("")}</ul></details></main></body></html>`, {
    headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" },
  });
}

function upstreamBase(env: Env): string {
  return (env.UPSTREAM_REPO || DEFAULT_UPSTREAM).replace(/\/$/, "");
}

function isAllowedPath(pathname: string): boolean {
  return METADATA_PATHS.includes(pathname) || pathname.startsWith("/debs/");
}

function cacheRequest(pathname: string): Request {
  return new Request(new URL(pathname, "https://mirror-cache.invalid").toString(), { method: "GET" });
}

function cacheable(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  headers.set("X-Repo-Mirror", "cloudflare-worker");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function cacheUpstreamPath(pathname: string, env: Env): Promise<Response> {
  const upstream = new URL(`${upstreamBase(env)}${pathname}`);
  const response = await fetch(upstream, { redirect: "follow" });
  if (!response.ok) throw new Error(`${pathname}: upstream returned ${response.status}`);

  const cached = cacheable(response);
  await edgeCache.put(cacheRequest(pathname), cached.clone());
  return cached;
}

function latestDebPath(packages: string): string | null {
  const records = packages.trim().split(/\n\s*\n/);
  const ipogo = records.filter((record) => /^(?:Package: com\.iteam\.ipogo)$/m.test(record));
  const latest = ipogo.at(-1);
  return latest?.match(/^Filename: \.\/(debs\/[^\r\n]+)$/m)?.[1] ?? null;
}

async function refresh(env: Env): Promise<{ refreshed: string[]; latestDeb: string | null }> {
  const refreshed: string[] = [];
  for (const path of ["/Release", "/Packages", "/Packages.gz", "/Packages.bz2"]) {
    await cacheUpstreamPath(path, env);
    refreshed.push(path);
  }

  const packages = await (await fetch(new URL("Packages", `${upstreamBase(env)}/`))).text();
  const latestDeb = latestDebPath(packages);
  if (latestDeb) {
    await cacheUpstreamPath(`/${latestDeb}`, env);
    refreshed.push(`/${latestDeb}`);
  }
  return { refreshed, latestDeb };
}

async function serveMirror(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (!isAllowedPath(pathname)) return new Response("Not found", { status: 404 });

  const key = cacheRequest(pathname);
  const hit = await edgeCache.match(key);
  if (hit) {
    ctx.waitUntil(cacheUpstreamPath(pathname, env).catch(() => undefined));
    return hit;
  }
  try {
    return await cacheUpstreamPath(pathname, env);
  } catch (error) {
    return new Response(`Upstream unavailable: ${(error as Error).message}`, { status: 502 });
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") return homePage(url.origin, env, ctx);
    if (url.pathname === "/health") return Response.json({ ok: true, upstream: upstreamBase(env) });
    if (url.pathname === "/refresh") {
      if (request.method !== "GET" && request.method !== "POST") return new Response("Use GET or POST /refresh", { status: 405 });
      const expected = env.REFRESH_TOKEN;
      if (expected && request.headers.get("Authorization") !== `Bearer ${expected}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        return Response.json({ ok: true, ...(await refresh(env)) });
      } catch (error) {
        return Response.json({ ok: false, error: (error as Error).message }, { status: 502 });
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    return serveMirror(request, env, ctx);
  },

  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(refresh(env));
  },
} satisfies ExportedHandler<Env>;

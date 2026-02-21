function extractScriptSrcsFromHtml(html: string): string[] {
  const out: string[] = [];
  const pattern = /<script\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    const src = match[1] ?? match[2] ?? '';
    if (!src) continue;
    out.push(src);
  }
  return out;
}

export function resolveScriptUrlsFromHtml(html: string, baseUrl: string): string[] {
  const srcs = extractScriptSrcsFromHtml(html);
  const out: string[] = [];
  for (const src of srcs) {
    try {
      out.push(new URL(src, baseUrl).toString());
    } catch {
      // ignore invalid urls
    }
  }
  return out;
}

export function selectPrimaryAppScriptUrl(urls: readonly string[]): string | null {
  const prefer = (u: string) =>
    u.includes('index.bundle')
    || u.includes('bundle.js')
    || u.includes('main.js');

  const match = urls.find((u) => prefer(u)) ?? null;
  return match ?? (urls[0] ?? null);
}


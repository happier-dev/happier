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
  const score = (url: string): number => {
    if (url.includes('index.bundle')) return 6;
    if (url.includes('entry.bundle')) return 5;
    if (url.includes('expo-router/entry')) return 4;
    if (url.includes('AppEntry')) return 3;
    if (url.includes('bundle.js')) return 2;
    if (url.includes('main.js')) return 1;
    return 0;
  };

  let bestUrl: string | null = null;
  let bestScore = -1;
  for (const url of urls) {
    const nextScore = score(url);
    if (nextScore > bestScore) {
      bestUrl = url;
      bestScore = nextScore;
    }
  }
  return bestUrl ?? (urls[0] ?? null);
}

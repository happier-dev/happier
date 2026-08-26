export type DetectedTerminalUrl = Readonly<{
  url: string;
  kind: 'auth' | 'generic';
  suggestOpen?: boolean;
}>;

function stripOscSequences(input: string): string {
  return input.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
}

function stripCsiSequences(input: string): string {
  return input.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function stripAnsi(input: string): string {
  return stripCsiSequences(stripOscSequences(input));
}

function trimUrlPunctuation(raw: string): string {
  let out = raw.trim();
  out = out.replace(/[),.;:!?\\\]\}]+$/g, '');
  return out.trim();
}

function coerceHttpUrl(raw: string): string | null {
  const trimmed = trimUrlPunctuation(raw);
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function classifyUrl(url: string, context: string): { kind: 'auth' | 'generic'; suggestOpen?: boolean } {
  const lowerUrl = url.toLowerCase();
  const lowerContext = context.toLowerCase();

  const authHints =
    lowerUrl.includes('oauth')
    || lowerUrl.includes('authorize')
    || lowerUrl.includes('device')
    || lowerUrl.includes('login')
    || lowerUrl.includes('signin')
    || lowerUrl.includes('auth');

  const kind: 'auth' | 'generic' = authHints ? 'auth' : 'generic';
  const suggestOpen =
    kind === 'auth'
    || (lowerContext.includes('continue') && lowerContext.includes('browser'))
    || (lowerContext.includes('open') && lowerContext.includes('browser'));

  return suggestOpen ? { kind, suggestOpen: true } : { kind };
}

function retainIncompleteTail(input: string): string {
  const match = input.match(/[^\s<>"'`]*$/);
  return match?.[0] ?? '';
}

export type TerminalUrlDetector = Readonly<{
  ingest: (chunk: string) => readonly DetectedTerminalUrl[];
  flush: () => readonly DetectedTerminalUrl[];
}>;

export function createTerminalUrlDetector(params: Readonly<{ bufferLimit: number; seenLimit?: number }>): TerminalUrlDetector {
  const bufferLimit = Math.max(0, Math.trunc(params.bufferLimit));
  const seenLimit = Math.max(1, Math.trunc(params.seenLimit ?? 1024));
  let buffer = '';
  const seen = new Set<string>();
  const seenOrder: string[] = [];

  const remember = (url: string): void => {
    if (seen.has(url)) return;
    seen.add(url);
    seenOrder.push(url);
    while (seenOrder.length > seenLimit) {
      const removed = seenOrder.shift();
      if (removed) {
        seen.delete(removed);
      }
    }
  };

  const extractUrls = (allowBufferEnd: boolean, context: string): readonly DetectedTerminalUrl[] => {
    const out: DetectedTerminalUrl[] = [];
    const regex = /(https?:\/\/[^\s<>"'`]+)/g;
    let match: RegExpExecArray | null = null;
    while ((match = regex.exec(buffer))) {
      const rawUrl = match[1] ?? '';
      const endIndex = (match.index ?? 0) + rawUrl.length;
      if (!allowBufferEnd && endIndex >= buffer.length) continue;
      const url = coerceHttpUrl(rawUrl);
      if (!url) continue;
      if (seen.has(url)) continue;
      remember(url);
      out.push({ url, ...classifyUrl(url, context) });
    }
    return out;
  };

  const ingest = (chunk: string): readonly DetectedTerminalUrl[] => {
    const clean = stripAnsi(String(chunk ?? ''));
    if (!clean) return [];

    buffer = buffer + clean;
    if (bufferLimit > 0 && buffer.length > bufferLimit) {
      buffer = buffer.slice(buffer.length - bufferLimit);
    }

    const out = extractUrls(false, clean);

    buffer = retainIncompleteTail(buffer);
    return out;
  };

  const flush = (): readonly DetectedTerminalUrl[] => {
    const out = extractUrls(true, buffer);
    buffer = '';
    return out;
  };

  return { ingest, flush };
}

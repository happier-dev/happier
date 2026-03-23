export type DetectedTerminalUrl = Readonly<{
  url: string;
  kind: 'auth' | 'generic';
  suggestOpen?: boolean;
}>;

function stripOscSequences(input: string): string {
  // OSC: ESC ] ... BEL  or  ESC ] ... ESC \
  return input.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
}

function stripCsiSequences(input: string): string {
  // CSI: ESC [ ... <final byte>
  // https://en.wikipedia.org/wiki/ANSI_escape_code#CSI_(Control_Sequence_Introducer)_sequences
  return input.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function stripAnsi(input: string): string {
  return stripCsiSequences(stripOscSequences(input));
}

function trimUrlPunctuation(raw: string): string {
  let out = raw.trim();
  // Common trailing punctuation in terminal output: `)`, `.`, `,`, `;`, `:`, `!`, `?`, `]`, `}`
  // Be conservative and only trim from the end.
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

export type TerminalUrlDetector = Readonly<{
  ingest: (chunk: string) => readonly DetectedTerminalUrl[];
}>;

export function createTerminalUrlDetector(params: Readonly<{ bufferLimit: number }>): TerminalUrlDetector {
  const bufferLimit = Math.max(0, Math.trunc(params.bufferLimit));
  let buffer = '';
  const seen = new Set<string>();

  const ingest = (chunk: string): readonly DetectedTerminalUrl[] => {
    const clean = stripAnsi(String(chunk ?? ''));
    if (!clean) return [];

    buffer = buffer + clean;
    if (bufferLimit > 0 && buffer.length > bufferLimit) {
      buffer = buffer.slice(buffer.length - bufferLimit);
    }

    const out: DetectedTerminalUrl[] = [];
    const regex = /(https?:\/\/[^\s<>"'`]+)/g;
    let match: RegExpExecArray | null = null;
    while ((match = regex.exec(buffer))) {
      const rawUrl = match[1] ?? '';
      const endIndex = (match.index ?? 0) + rawUrl.length;
      // If the URL ends at the end of the current parse buffer, it may be incomplete (chunk boundary).
      // Wait for a terminator (whitespace/punctuation) to arrive in a later chunk before emitting it.
      if (endIndex >= buffer.length) continue;
      const url = coerceHttpUrl(rawUrl);
      if (!url) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, ...classifyUrl(url, clean) });
    }

    return out;
  };

  return { ingest };
}

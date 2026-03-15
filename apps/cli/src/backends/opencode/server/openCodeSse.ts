export type SseJsonSubscription<T> = Readonly<{
  close: () => void;
  done: Promise<void>;
}>;

function concatDataLines(lines: string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n');
}

function parseSseFrame(frame: string): { id?: string; data: string } | null {
  const lines = frame.split('\n');
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    if (line.startsWith(':')) continue;
    if (line.startsWith('id:')) {
      id = line.slice(3).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
  }

  const data = concatDataLines(dataLines);
  if (!data) return null;
  return { ...(id ? { id } : {}), data };
}

export async function subscribeSseJson<T>(params: Readonly<{
  url: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  onMessage: (msg: T, meta: { id?: string }) => void;
}>): Promise<SseJsonSubscription<T>> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(params.signal.reason ?? 'abort');
  params.signal.addEventListener('abort', onAbort, { once: true });

  const close = () => controller.abort('closed');

  const done = (async () => {
    try {
      const response = await fetch(params.url, {
        method: 'GET',
        headers: params.headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`OpenCode SSE failed: ${response.status} ${response.statusText}`);
      }
      if (!response.body) {
        throw new Error('OpenCode SSE response missing body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const idx = buffer.indexOf('\n\n');
          if (idx === -1) break;
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          try {
            const msg = JSON.parse(parsed.data) as T;
            params.onMessage(msg, { id: parsed.id });
          } catch {
            // ignore malformed frames
          }
        }
      }
    } finally {
      params.signal.removeEventListener('abort', onAbort);
    }
  })();

  return { close, done };
}

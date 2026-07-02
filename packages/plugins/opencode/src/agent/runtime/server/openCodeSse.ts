import { raceWithTimeout } from './raceWithTimeout.js';

export type SseJsonSubscription<T> = Readonly<{
  close: () => void;
  done: Promise<void>;
}>;

export class OpenCodeSseReadIdleTimeoutError extends Error {
  readonly code = 'OPENCODE_SSE_READ_IDLE_TIMEOUT';
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`OpenCode SSE read idle timeout after ${timeoutMs}ms`);
    this.name = 'OpenCodeSseReadIdleTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

type StreamReadResult<T> =
  | Readonly<{ done: true; value?: T }>
  | Readonly<{ done: false; value: T }>;

function concatDataLines(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n');
}

function parseSseFrame(frame: string): Readonly<{ id?: string; data: string }> | null {
  const lines = frame.split('\n');
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('id:')) {
      id = line.slice(3).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  const data = concatDataLines(dataLines);
  if (!data) return null;
  return { ...(id ? { id } : {}), data };
}

function normalizeReadIdleTimeoutMs(value: number | null | undefined): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 30_000;
  return Math.trunc(value);
}

export async function subscribeSseJson<T>(params: Readonly<{
  url: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  readIdleTimeoutMs?: number | null;
  onMessage: (msg: T, meta: { id?: string }) => void;
}>): Promise<SseJsonSubscription<T>> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(params.signal.reason ?? 'abort');
  params.signal.addEventListener('abort', onAbort, { once: true });

  const close = () => controller.abort('closed');
  const readIdleTimeoutMs = normalizeReadIdleTimeoutMs(params.readIdleTimeoutMs);

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
        const readPromise = reader.read() as Promise<StreamReadResult<Uint8Array>>;
        const readOutcome = readIdleTimeoutMs === null
          ? { type: 'resolved' as const, value: await readPromise }
          : await raceWithTimeout(readPromise, readIdleTimeoutMs);

        if (readOutcome.type === 'timeout') {
          const error = new OpenCodeSseReadIdleTimeoutError(readIdleTimeoutMs ?? 0);
          controller.abort(error);
          await reader.cancel(error).catch(() => undefined);
          throw error;
        }
        if (readOutcome.type === 'rejected') throw readOutcome.error;

        const { done: readerDone, value } = readOutcome.value;
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
            params.onMessage(msg, { ...(parsed.id ? { id: parsed.id } : {}) });
          } catch {
            // Ignore malformed provider frames; the next valid frame can still recover the stream.
          }
        }
      }
    } finally {
      params.signal.removeEventListener('abort', onAbort);
    }
  })();

  return { close, done };
}

import { raceWithTimeout } from '@happier-dev/plugin-sdk/async';

import type { OpenCodeNativeFetch } from './transport.js';

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

export class OpenCodeSseHttpError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`OpenCode SSE failed: ${status} ${statusText}`);
    this.name = 'OpenCodeSseHttpError';
    this.status = status;
  }
}

type StreamReadResult<T> =
  | Readonly<{ done: true; value?: T }>
  | Readonly<{ done: false; value: T }>;

function concatDataLines(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n');
}

/**
 * Only `data:` lines carry payload. Comment lines (`: heartbeat`) and every
 * other field — `id:`, `event:`, `retry:` — are skipped rather than surfaced.
 * OpenCode does not use the SSE id for resumption; the V2 session route resumes
 * from the durable aggregate sequence in its JSON payload and `after` query.
 */
function parseSseFrame(frame: string): Readonly<{ data: string }> | null {
  const dataLines: string[] = [];

  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  const data = concatDataLines(dataLines);
  if (!data) return null;
  return { data };
}

/**
 * No read-idle deadline unless a caller names one.
 *
 * Both OpenCode event routes do write keepalives, on different cadences and in
 * different shapes (`comparators/opencode` at
 * `70a24697ea0028e19f22712fd63059538cb4bee7`): the V1 instance route merges a
 * `server.heartbeat` *event* every 10 seconds after dropping its first tick
 * (`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`),
 * while the V2 route merges a `": heartbeat"` *comment* frame every 15 seconds
 * (`packages/server/src/handlers/event.ts`). Neither interval is a published
 * contract, so a default deadline derived from them would still be a cadence
 * Happier chose on the provider's behalf, and server death is already observed
 * by the managed service health check, which owns that question.
 *
 * Residual risk: a half-open socket that neither errors nor delivers is not
 * detected by this reader; only its caller's own deadline would catch it.
 */
function normalizeReadIdleTimeoutMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

export async function subscribeSseJson<T>(params: Readonly<{
  url: string;
  headers?: Record<string, string>;
  fetch: OpenCodeNativeFetch;
  signal: AbortSignal;
  readIdleTimeoutMs?: number | null;
  onOpen?: () => void;
  onMessage: (msg: T) => void | Promise<void>;
}>): Promise<SseJsonSubscription<T>> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(params.signal.reason ?? 'abort');
  params.signal.addEventListener('abort', onAbort, { once: true });

  const close = () => controller.abort('closed');
  const readIdleTimeoutMs = normalizeReadIdleTimeoutMs(params.readIdleTimeoutMs);

  const done = (async () => {
    try {
      const response = await params.fetch(params.url, {
        interactive: true,
        method: 'GET',
        headers: params.headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OpenCodeSseHttpError(response.status, response.statusText);
      }
      if (!response.body) {
        throw new Error('OpenCode SSE response missing body');
      }
      params.onOpen?.();

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
          let msg: T;
          try {
            msg = JSON.parse(parsed.data) as T;
          } catch {
            // Ignore malformed provider frames; the next valid frame can still recover the stream.
            continue;
          }
          await params.onMessage(msg);
        }
      }
    } finally {
      params.signal.removeEventListener('abort', onAbort);
    }
  })();

  return { close, done };
}

import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

function splitLines(s) {
  return String(s ?? '').split(/\r?\n/);
}

function supportsAnsi() {
  if (!process.stdout.isTTY) return false;
  if (process.env.NO_COLOR) return false;
  if ((process.env.TERM ?? '').toLowerCase() === 'dumb') return false;
  return true;
}

function dim(s) {
  return supportsAnsi() ? `\x1b[2m${s}\x1b[0m` : String(s);
}

/**
 * Lightweight file log forwarder (tail-like) with pause/resume.
 *
 * - Always advances the file offset (prevents backpressure issues).
 * - While paused, it buffers the last N lines and prints them once resumed.
 */
export function createFileLogForwarder({
  path,
  enabled = true,
  pollMs = 200,
  maxBytesPerTick = 256 * 1024,
  bufferedLinesWhilePaused = 120,
  startFromEnd = true,
  label = 'logs',
} = {}) {
  const p = String(path ?? '').trim();
  if (!enabled || !p) {
    return {
      ok: false,
      start: async () => {},
      stop: async () => {},
      pause: () => {},
      resume: () => {},
      isPaused: () => false,
      path: p,
    };
  }

  let running = false;
  let paused = false;
  let offset = 0;
  let partial = '';
  let buffered = [];

  const pushBufferedLine = (line) => {
    if (!line) return;
    buffered.push(line);
    if (buffered.length > bufferedLinesWhilePaused) {
      buffered = buffered.slice(buffered.length - bufferedLinesWhilePaused);
    }
  };

  const flushBuffered = () => {
    if (!buffered.length) return;
    // eslint-disable-next-line no-console
    console.log(dim(`[${label}] (showing last ${buffered.length} lines while paused)`));
    for (const l of buffered) {
      // eslint-disable-next-line no-console
      console.log(l);
    }
    buffered = [];
  };

  const readNewBytes = async () => {
    if (!existsSync(p)) return;
    let st = null;
    try {
      st = await stat(p);
    } catch {
      return;
    }
    const size = Number(st?.size ?? 0);
    if (!Number.isFinite(size) || size <= 0) return;
    if (size < offset) {
      // truncated/rotated
      offset = 0;
    }
    if (size === offset) return;

    const end = Math.min(size, offset + maxBytesPerTick);
    const start = offset;
    offset = end;

    await new Promise((resolvePromise) => {
      const chunks = [];
      const stream = createReadStream(p, { start, end: end - 1 });
      stream.on('data', (d) => chunks.push(Buffer.from(d)));
      stream.on('error', () => resolvePromise());
      stream.on('close', () => {
        const text = partial + Buffer.concat(chunks).toString('utf-8');
        const lines = splitLines(text);
        partial = lines.pop() ?? '';
        for (const line of lines) {
          if (paused) {
            pushBufferedLine(line);
          } else {
            // eslint-disable-next-line no-console
            console.log(line);
          }
        }
        resolvePromise();
      });
    });
  };

  const loop = async () => {
    while (running) {
      // eslint-disable-next-line no-await-in-loop
      await readNewBytes();
      // eslint-disable-next-line no-await-in-loop
      await delay(pollMs);
    }
  };

  return {
    ok: true,
    path: p,
    start: async () => {
      if (running) return;
      running = true;
      // By default, start at end (don't replay historical logs).
      if (startFromEnd) {
        try {
          const st = await stat(p);
          offset = Number(st?.size ?? 0) || 0;
        } catch {
          offset = 0;
        }
      } else {
        offset = 0;
      }
      void loop();
    },
    stop: async () => {
      running = false;
    },
    pause: () => {
      paused = true;
      buffered = [];
    },
    resume: () => {
      paused = false;
      flushBuffered();
    },
    isPaused: () => paused,
  };
}


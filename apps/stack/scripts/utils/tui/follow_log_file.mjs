import { open, stat } from 'node:fs/promises';

export function followLogFile({
  path,
  onLine,
  intervalMs = 250,
  maxInitialBytes = 64 * 1024,
} = {}) {
  const logPath = String(path ?? '').trim();
  let closed = false;
  let polling = false;
  let position = 0;
  let partial = '';
  let initialized = false;
  let discardInitialPartial = false;

  const emit = (line) => {
    try {
      onLine?.(line);
    } catch {
      // A log observer must not disrupt the TUI lifecycle.
    }
  };

  const consume = (text) => {
    const combined = partial + text;
    const parts = combined.split(/\r?\n/);
    partial = parts.pop() ?? '';
    if (discardInitialPartial) {
      parts.shift();
      discardInitialPartial = false;
    }
    for (const line of parts) emit(line);
  };

  const poll = async () => {
    if (closed || polling || !logPath) return;
    polling = true;
    try {
      const fileStat = await stat(logPath);
      if (!fileStat.isFile()) return;
      if (!initialized) {
        position = Math.max(0, fileStat.size - Math.max(1, Number(maxInitialBytes) || 1));
        discardInitialPartial = position > 0;
        initialized = true;
      } else if (fileStat.size < position) {
        position = 0;
        partial = '';
        discardInitialPartial = false;
      }
      if (fileStat.size <= position) return;

      const length = fileStat.size - position;
      const buffer = Buffer.alloc(length);
      const handle = await open(logPath, 'r');
      try {
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        position += bytesRead;
        if (bytesRead > 0) consume(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Log following is deliberately best-effort; a later poll may recover.
      }
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => void poll(), Math.max(10, Number(intervalMs) || 250));
  timer.unref?.();
  void poll();

  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}

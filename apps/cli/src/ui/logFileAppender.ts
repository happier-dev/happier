import { appendFileSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_LOG_FLUSH_INTERVAL_MS = 250;
export const DEFAULT_LOG_MAX_BUFFERED_BYTES = 256 * 1024;

/**
 * Buffered async log appender.
 *
 * Hot log call sites enqueue lines in memory; a short unref'd timer flushes them
 * with async `appendFile`, so logging never performs synchronous I/O on the hot
 * path. Crash forensics are preserved by:
 * - a short flush interval (default 250ms),
 * - an early async flush when the buffered byte budget is exceeded,
 * - `flushSync()` wired to `process.on('exit')` / `uncaughtExceptionMonitor` by the owner.
 *
 * All writes are best-effort and never throw (log files must not break the CLI).
 */
export class BufferedFileAppender {
  private readonly filePath: string;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedBytes: number;
  private readonly onWriteError: ((error: unknown) => void) | null;

  private pendingLines: string[] = [];
  private pendingBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private thresholdFlushToken: object | null = null;
  private flushInFlight = false;

  constructor(params: {
    filePath: string;
    flushIntervalMs?: number;
    maxBufferedBytes?: number;
    onWriteError?: (error: unknown) => void;
  }) {
    this.filePath = params.filePath;
    this.flushIntervalMs = params.flushIntervalMs ?? DEFAULT_LOG_FLUSH_INTERVAL_MS;
    this.maxBufferedBytes = params.maxBufferedBytes ?? DEFAULT_LOG_MAX_BUFFERED_BYTES;
    this.onWriteError = params.onWriteError ?? null;
  }

  append(line: string): void {
    this.pendingLines.push(line);
    this.pendingBytes += line.length;

    if (this.pendingBytes >= this.maxBufferedBytes) {
      this.clearFlushTimer();
      this.scheduleThresholdFlush();
      return;
    }
    this.scheduleFlush();
  }

  /**
   * Synchronously drain the buffer (exit/fatal handlers and tests).
   * Never throws.
   */
  flushSync(): void {
    this.clearFlushTimer();
    this.thresholdFlushToken = null;
    const chunk = this.takePendingChunk();
    if (chunk === null) return;
    try {
      appendFileSync(this.filePath, chunk);
    } catch (error) {
      const retried = this.retrySyncAfterEnoent(error, chunk);
      if (!retried) this.reportWriteError(error);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const timer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushAsync();
    }, this.flushIntervalMs);
    timer.unref?.();
    this.flushTimer = timer;
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private scheduleThresholdFlush(): void {
    if (this.thresholdFlushToken) return;
    const token = {};
    this.thresholdFlushToken = token;
    queueMicrotask(() => {
      if (this.thresholdFlushToken !== token) return;
      this.thresholdFlushToken = null;
      void this.flushAsync();
    });
  }

  private takePendingChunk(): string | null {
    if (this.pendingLines.length === 0) return null;
    const chunk = this.pendingLines.join('');
    this.pendingLines = [];
    this.pendingBytes = 0;
    return chunk;
  }

  private async flushAsync(): Promise<void> {
    if (this.flushInFlight) return;
    this.flushInFlight = true;
    try {
      // Drain in a loop: lines appended while a write is in flight are picked up
      // by the next iteration instead of waiting for another timer tick.
      for (;;) {
        const chunk = this.takePendingChunk();
        if (chunk === null) return;
        try {
          await appendFile(this.filePath, chunk);
        } catch (error) {
          const retried = await this.retryAsyncAfterEnoent(error, chunk);
          if (!retried) this.reportWriteError(error);
        }
      }
    } finally {
      this.flushInFlight = false;
    }
  }

  private ensureParentDir(): boolean {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  private retrySyncAfterEnoent(error: unknown, chunk: string): boolean {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return false;
    if (!this.ensureParentDir()) return false;
    try {
      appendFileSync(this.filePath, chunk);
      return true;
    } catch (retryError) {
      this.reportWriteError(retryError);
      return true;
    }
  }

  private async retryAsyncAfterEnoent(error: unknown, chunk: string): Promise<boolean> {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return false;
    if (!this.ensureParentDir()) return false;
    try {
      await appendFile(this.filePath, chunk);
      return true;
    } catch (retryError) {
      this.reportWriteError(retryError);
      return true;
    }
  }

  private reportWriteError(error: unknown): void {
    try {
      this.onWriteError?.(error);
    } catch {
      // Never let error reporting break logging.
    }
  }
}

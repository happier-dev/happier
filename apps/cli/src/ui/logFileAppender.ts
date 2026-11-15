import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
  private readonly tailWindowBytes: number | null;
  private fileBytes: number | null = null;

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
    /**
     * Newest bytes the file must keep readable. Once the file reaches twice this, it is
     * rewritten to its newest whole lines within the window, so it stays under 2x the window.
     * The file must have this appender as its only writer.
     */
    tailWindowBytes?: number;
  }) {
    this.filePath = params.filePath;
    this.flushIntervalMs = params.flushIntervalMs ?? DEFAULT_LOG_FLUSH_INTERVAL_MS;
    this.maxBufferedBytes = params.maxBufferedBytes ?? DEFAULT_LOG_MAX_BUFFERED_BYTES;
    this.onWriteError = params.onWriteError ?? null;
    this.tailWindowBytes = params.tailWindowBytes !== undefined && params.tailWindowBytes > 0
      ? Math.floor(params.tailWindowBytes)
      : null;
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
    // A synchronous drain may race an in-flight async append; trimming waits for the next async flush.
    this.noteAppended(chunk);
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
        // No other write of this appender is pending here, so a synchronous trim cannot drop one.
        if (this.noteAppended(chunk)) this.trimToTailWindow();
      }
    } finally {
      this.flushInFlight = false;
    }
  }

  /** Returns true when the file may have reached twice the tail window. */
  private noteAppended(chunk: string): boolean {
    if (this.tailWindowBytes === null) return false;
    if (this.fileBytes === null) {
      try { this.fileBytes = statSync(this.filePath).size; } catch { this.fileBytes = 0; }
    } else {
      this.fileBytes += Buffer.byteLength(chunk);
    }
    return this.fileBytes >= this.tailWindowBytes * 2;
  }

  private trimToTailWindow(): void {
    const windowBytes = this.tailWindowBytes;
    if (windowBytes === null) return;
    const tempPath = `${this.filePath}.trim`;
    try {
      const size = statSync(this.filePath).size;
      this.fileBytes = size;
      if (size < windowBytes * 2) return;
      // Read one byte before the window so a window that starts on a line boundary keeps that line.
      const buffer = Buffer.allocUnsafe(windowBytes + 1);
      const descriptor = openSync(this.filePath, 'r');
      let bytesRead: number;
      try {
        bytesRead = readSync(descriptor, buffer, 0, buffer.length, size - buffer.length);
      } finally {
        closeSync(descriptor);
      }
      const firstNewline = buffer.subarray(0, bytesRead).indexOf(0x0A);
      const tail = firstNewline >= 0 && firstNewline < bytesRead - 1
        ? buffer.subarray(firstNewline + 1, bytesRead)
        : buffer.subarray(1, bytesRead);
      writeFileSync(tempPath, tail);
      renameSync(tempPath, this.filePath);
      this.fileBytes = tail.length;
    } catch (error) {
      try { unlinkSync(tempPath); } catch { /* the temp file may not exist */ }
      // Retry only after another window of writes, not on every flush.
      if (this.fileBytes !== null) this.fileBytes -= windowBytes;
      this.reportWriteError(error);
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

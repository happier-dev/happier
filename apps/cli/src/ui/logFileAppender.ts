import { appendFileSync, closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_LOG_FLUSH_INTERVAL_MS = 250;
export const DEFAULT_LOG_MAX_BUFFERED_BYTES = 256 * 1024;

export class BufferedFileAppender {
    private readonly filePath: string;
    private readonly flushIntervalMs: number;
    private readonly maxBufferedBytes: number;
    private readonly onWriteError: ((error: unknown) => void) | null;
    private readonly tailWindowBytes: number | null;
    private fileBytes: number | null = null;
    private trimCount = 0;
    private pendingLines: string[] = [];
    private pendingReportsWriteErrors = false;
    private pendingBytes = 0;
    private flushTimer: NodeJS.Timeout | null = null;
    private thresholdFlushToken: object | null = null;
    private flushInFlight = false;

    constructor(params: Readonly<{
        filePath: string;
        flushIntervalMs?: number;
        maxBufferedBytes?: number;
        onWriteError?: (error: unknown) => void;
        /**
         * Newest bytes the file must keep readable. Once the file reaches twice this, it is
         * rewritten in place to its newest whole lines within the window, so it stays under 2× the window.
         * The file must have this appender as its only writer.
         */
        tailWindowBytes?: number;
    }>) {
        this.filePath = params.filePath;
        this.flushIntervalMs = params.flushIntervalMs ?? DEFAULT_LOG_FLUSH_INTERVAL_MS;
        this.maxBufferedBytes = params.maxBufferedBytes ?? DEFAULT_LOG_MAX_BUFFERED_BYTES;
        this.onWriteError = params.onWriteError ?? null;
        this.tailWindowBytes = params.tailWindowBytes !== undefined && params.tailWindowBytes > 0
            ? Math.floor(params.tailWindowBytes)
            : null;
    }

    /** `silent` lines never report a write failure on their own (isolated diagnostic sinks). */
    append(line: string, options?: Readonly<{ silent?: boolean }>): void {
        this.pendingLines.push(line);
        if (options?.silent !== true) this.pendingReportsWriteErrors = true;
        this.pendingBytes += line.length;
        if (this.pendingBytes >= this.maxBufferedBytes) {
            this.clearFlushTimer();
            this.scheduleThresholdFlush();
            return;
        }
        this.scheduleFlush();
    }

    flushSync(): void {
        this.clearFlushTimer();
        this.thresholdFlushToken = null;
        const pending = this.takePendingChunk();
        if (pending === null) return;
        const { chunk, reportsWriteErrors } = pending;
        try {
            appendFileSync(this.filePath, chunk);
        } catch (error) {
            const retried = this.retrySyncAfterEnoent(error, chunk, reportsWriteErrors);
            if (!retried && reportsWriteErrors) this.reportWriteError(error);
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

    private takePendingChunk(): Readonly<{ chunk: string; reportsWriteErrors: boolean }> | null {
        if (this.pendingLines.length === 0) return null;
        const chunk = this.pendingLines.join('');
        const reportsWriteErrors = this.pendingReportsWriteErrors;
        this.pendingLines = [];
        this.pendingBytes = 0;
        this.pendingReportsWriteErrors = false;
        return { chunk, reportsWriteErrors };
    }

    private async flushAsync(): Promise<void> {
        if (this.flushInFlight) return;
        this.flushInFlight = true;
        try {
            for (;;) {
                const pending = this.takePendingChunk();
                if (pending === null) return;
                const { chunk, reportsWriteErrors } = pending;
                try {
                    await appendFile(this.filePath, chunk);
                } catch (error) {
                    const retried = await this.retryAsyncAfterEnoent(error, chunk, reportsWriteErrors);
                    if (!retried && reportsWriteErrors) this.reportWriteError(error);
                }
                // No other write of this appender is pending here, so a synchronous trim cannot drop one.
                if (this.noteAppended(chunk)) this.trimToTailWindow();
            }
        } finally {
            this.flushInFlight = false;
        }
    }

    /** Increments each time the file is rewritten to its tail; byte offsets read before it are stale. */
    get trimGeneration(): number {
        return this.trimCount;
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
        let descriptor: number | null = null;
        try {
            // In place, never rename/replace: Windows refuses those while another process
            // (a viewer, a bug-report read) holds the log open; writing and truncating stay allowed.
            descriptor = openSync(this.filePath, 'r+');
            const size = fstatSync(descriptor).size;
            this.fileBytes = size;
            if (size < windowBytes * 2) return;
            // Read one byte before the window so a window that starts on a line boundary keeps that line.
            const buffer = Buffer.allocUnsafe(windowBytes + 1);
            const bytesRead = readSync(descriptor, buffer, 0, buffer.length, size - buffer.length);
            const firstNewline = buffer.subarray(0, bytesRead).indexOf(0x0A);
            const tail = firstNewline >= 0 && firstNewline < bytesRead - 1
                ? buffer.subarray(firstNewline + 1, bytesRead)
                : buffer.subarray(1, bytesRead);
            let written = 0;
            while (written < tail.length) written += writeSync(descriptor, tail, written, tail.length - written, written);
            ftruncateSync(descriptor, tail.length);
            this.fileBytes = tail.length;
            this.trimCount += 1;
        } catch (error) {
            // Retry only after another window of writes, not on every flush.
            if (this.fileBytes !== null) this.fileBytes -= windowBytes;
            this.reportWriteError(error);
        } finally {
            if (descriptor !== null) {
                try { closeSync(descriptor); } catch { /* already reported or harmless */ }
            }
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

    private retrySyncAfterEnoent(error: unknown, chunk: string, reportsWriteErrors: boolean): boolean {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return false;
        if (!this.ensureParentDir()) return false;
        try {
            appendFileSync(this.filePath, chunk);
            return true;
        } catch (retryError) {
            if (reportsWriteErrors) this.reportWriteError(retryError);
            return true;
        }
    }

    private async retryAsyncAfterEnoent(error: unknown, chunk: string, reportsWriteErrors: boolean): Promise<boolean> {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return false;
        if (!this.ensureParentDir()) return false;
        try {
            await appendFile(this.filePath, chunk);
            return true;
        } catch (retryError) {
            if (reportsWriteErrors) this.reportWriteError(retryError);
            return true;
        }
    }

    private reportWriteError(error: unknown): void {
        try {
            this.onWriteError?.(error);
        } catch {
            // Logging must never throw.
        }
    }
}

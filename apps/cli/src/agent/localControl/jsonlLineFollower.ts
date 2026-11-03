import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

import {
    normalizeJsonlFollowPolicy,
    resolveJsonlFollowPollDelayMs,
    type JsonlFollowPolicyInput,
    type JsonlFollowPolicyV1,
    type JsonlFollowPollMode,
} from './jsonlFollowPolicy';
import {
    emitJsonlFollowerMetric,
    type JsonlFollowerDrainSource,
    type JsonlFollowerMetrics,
    type JsonlFollowerResetReason,
} from './jsonlFollowMetrics';

const JSONL_READ_CHUNK_BYTES = 64 * 1024;

export type JsonlFileIdentity = Readonly<{
    dev: number | bigint;
    ino: number | bigint;
}>;

export type JsonlLineFollowerOptions = Readonly<{
    filePath: string;
    pollIntervalMs?: number;
    pollPolicy?: JsonlFollowPolicyInput;
    startAtEnd?: boolean;
    startOffsetBytes?: number;
    onLine: (line: string, source: JsonlLineSource) => void | Promise<void>;
    /** Report proven discontinuity before replacement rows, even when the file is empty. */
    onReset?: (reason: JsonlFollowerResetReason) => void;
    onError?: (error: unknown) => void;
    metrics?: JsonlFollowerMetrics;
}>;

export type JsonlLineSource = Readonly<{
    lineStartOffsetBytes: number;
    fileIdentity: JsonlFileIdentity;
}>;

type JsonlFollowerDrainOutcome = Readonly<{
    bytesRead: number;
    rowsEmitted: number;
    hadError: boolean;
    hadReset: boolean;
    fileMissing: boolean;
    hasBufferedCompleteRows: boolean;
}>;

export class JsonlLineFollower {
    private readonly filePath: string;
    private readonly pollPolicy: JsonlFollowPolicyV1;
    private readonly startAtEnd: boolean;
    private readonly startOffsetBytes: number | null;
    private readonly onLine: (line: string, source: JsonlLineSource) => void | Promise<void>;
    private readonly onReset?: (reason: JsonlFollowerResetReason) => void;
    private readonly onError?: (error: unknown) => void;
    private readonly metrics?: JsonlFollowerMetrics;

    private offsetBytes = 0;
    private bufferStartOffsetBytes = 0;
    private buffer = '';
    private timer: NodeJS.Timeout | null = null;
    private startPromise: Promise<void> | null = null;
    private inFlight: Promise<void> | null = null;
    private drainQueued = false;
    private pollingActive = false;
    private idlePolls = 0;
    private stopped = false;
    private decoder = new StringDecoder('utf8');
    private fileIdentity: JsonlFileIdentity | null = null;
    private bufferFileIdentity: JsonlFileIdentity | null = null;
    private activeStartedAtMs = Date.now();
    private mode: JsonlFollowPollMode = 'active';

    constructor(opts: JsonlLineFollowerOptions) {
        this.filePath = opts.filePath;
        this.pollPolicy = normalizeJsonlFollowPolicy(opts.pollPolicy, opts.pollIntervalMs);
        this.startAtEnd = Boolean(opts.startAtEnd);
        this.startOffsetBytes = normalizeStartOffsetBytes(opts.startOffsetBytes);
        this.onLine = opts.onLine;
        this.onError = opts.onError;
        this.onReset = opts.onReset;
        this.metrics = opts.metrics;
    }

    async start(): Promise<void> {
        if (this.pollingActive) return;
        if (this.startPromise) {
            await this.startPromise;
            return;
        }
        this.startPromise = (async () => {
            this.stopped = false;
            this.pollingActive = true;
            this.mode = 'active';
            this.activeStartedAtMs = Date.now();
            if (this.startOffsetBytes !== null) {
                try {
                    const s = await stat(this.filePath);
                    this.fileIdentity = { dev: s.dev, ino: s.ino };
                    this.offsetBytes = this.startOffsetBytes <= s.size ? this.startOffsetBytes : 0;
                    this.bufferStartOffsetBytes = this.offsetBytes;
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
                    if (code !== 'ENOENT') {
                        throw error;
                    }
                    this.offsetBytes = 0;
                }
            } else if (this.startAtEnd) {
                try {
                    const s = await stat(this.filePath);
                    this.fileIdentity = { dev: s.dev, ino: s.ino };
                    this.offsetBytes = s.size;
                    this.bufferStartOffsetBytes = this.offsetBytes;
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
                    if (code !== 'ENOENT') {
                        throw error;
                    }
                }
            }
            await this.drain('manual');
        })().finally(() => {
            this.startPromise = null;
        });
        await this.startPromise;
        if (!this.stopped) {
            this.emitMetric({ type: 'started' });
        }
    }

    async stop(): Promise<void> {
        const wasStopped = this.stopped;
        this.stopped = true;
        this.pollingActive = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.drainQueued = false;
        if (this.inFlight) {
            await this.inFlight.catch(() => undefined);
            this.inFlight = null;
        }
        if (!wasStopped) {
            this.emitMetric({ type: 'stopped' });
        }
    }

    setMode(mode: JsonlFollowPollMode): void {
        if (this.mode === mode) return;
        this.mode = mode;
        this.activeStartedAtMs = Date.now();
        this.idlePolls = 0;
        this.emitMetric({ type: 'mode_changed', mode });
    }

    async drainNow(source: JsonlFollowerDrainSource = 'manual'): Promise<void> {
        await this.drain(source);
    }

    private async drain(source: JsonlFollowerDrainSource): Promise<void> {
        if (this.stopped) return;
        this.emitMetric({ type: 'drain_requested', source });
        if (this.inFlight) {
            this.drainQueued = true;
            this.emitMetric({ type: 'drain_queued' });
            await this.inFlight.catch(() => undefined);
            return;
        }

        const work = this.drainLoop(source).finally(() => {
            this.inFlight = null;
        });
        this.inFlight = work;
        await work;
    }

    private async drainLoop(initialSource: JsonlFollowerDrainSource): Promise<void> {
        let source = initialSource;
        let aggregate = emptyDrainOutcome();
        do {
            this.drainQueued = false;
            const outcome = await this.drainInner(source);
            aggregate = mergeDrainOutcome(aggregate, outcome);
            if (outcome.hadError) {
                this.drainQueued = false;
            } else if (outcome.hasBufferedCompleteRows && !this.drainQueued) {
                this.drainQueued = true;
            }
            source = 'queued';
        } while (this.drainQueued && !this.stopped);
        this.scheduleNextPoll(aggregate);
    }

    /** Preserve the cursor while the path is absent; only proven replacement or truncation resets it before row delivery. */
    private async drainInner(source: JsonlFollowerDrainSource): Promise<JsonlFollowerDrainOutcome> {
        let size = 0;
        let hadReset = false;
        try {
            const s = await stat(this.filePath);
            hadReset = this.handleFileIdentity(s);
            size = s.size;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
            if (code !== 'ENOENT') {
                this.onError?.(error);
                return { ...emptyDrainOutcome(), hadError: true };
            }
            // Path absence alone does not prove a transcript discontinuity. Preserve
            // the cursor/buffer until the path returns; identity/size then proves
            // whether continuity held or a replaced/truncated reset is required.
            return { ...emptyDrainOutcome(), fileMissing: true };
        }

        if (size < this.offsetBytes) {
            this.resetReadState('truncated');
            hadReset = true;
        }

        let bytesReadTotal = 0;
        let hadError = false;
        const toRead = size - this.offsetBytes;
        if (toRead > 0) {
            this.emitMetric({ type: 'drain_started', source });
            try {
                bytesReadTotal = await this.readNextChunk(Math.min(toRead, this.pollPolicy.maxDrainBytesPerTick));
            } catch (error) {
                this.onError?.(error);
                return { bytesRead: bytesReadTotal, rowsEmitted: 0, hadError: true, hadReset, fileMissing: false, hasBufferedCompleteRows: false };
            }
        }

        const emitted = await this.emitBufferedCompleteLines();
        hadError = emitted.hadError;
        const outcome = {
            bytesRead: bytesReadTotal,
            rowsEmitted: emitted.rowsEmitted,
            hadError,
            hadReset,
            fileMissing: false,
            hasBufferedCompleteRows: emitted.hasBufferedCompleteRows || size > this.offsetBytes,
        };
        if (bytesReadTotal > 0 || emitted.rowsEmitted > 0) {
            this.emitMetric({ type: 'drain_finished', bytesRead: bytesReadTotal, rowsEmitted: emitted.rowsEmitted });
        }
        return outcome;
    }

    private async readNextChunk(maxBytes: number): Promise<number> {
        const fh = await open(this.filePath, 'r');
        let bytesReadTotal = 0;
        try {
            const openedStats = await fh.stat();
            const openedIdentity = { dev: openedStats.dev, ino: openedStats.ino };
            if (this.fileIdentity && !isSameFileIdentity(this.fileIdentity, openedIdentity)) {
                this.resetReadState('replaced');
            }
            this.fileIdentity = openedIdentity;
            if (this.bufferFileIdentity && !isSameFileIdentity(this.bufferFileIdentity, openedIdentity)) {
                this.resetReadState('replaced');
                this.fileIdentity = openedIdentity;
            }
            this.bufferFileIdentity = openedIdentity;

            let position = this.offsetBytes;
            let remaining = Math.min(maxBytes, Math.max(0, openedStats.size - position));
            const chunkBuffer = Buffer.allocUnsafe(Math.min(JSONL_READ_CHUNK_BYTES, remaining));

            while (remaining > 0) {
                const bytesToRead = Math.min(chunkBuffer.byteLength, remaining);
                const res = await fh.read(chunkBuffer, 0, bytesToRead, position);
                if (res.bytesRead <= 0) break;
                position += res.bytesRead;
                remaining -= res.bytesRead;
                bytesReadTotal += res.bytesRead;
                this.emitMetric({ type: 'bytes_read', bytes: res.bytesRead });
                this.buffer += this.decoder.write(chunkBuffer.subarray(0, res.bytesRead));
            }
            this.offsetBytes = position;
        } finally {
            await fh.close();
        }
        return bytesReadTotal;
    }

    private async emitBufferedCompleteLines(): Promise<Readonly<{
        rowsEmitted: number;
        hadError: boolean;
        hasBufferedCompleteRows: boolean;
    }>> {
        const newlineIndex = this.buffer.lastIndexOf('\n');
        if (newlineIndex < 0) {
            return { rowsEmitted: 0, hadError: false, hasBufferedCompleteRows: false };
        }

        const complete = this.buffer.slice(0, newlineIndex);
        const trailing = this.buffer.slice(newlineIndex + 1);
        const lines = complete.split('\n');
        const emitLines = lines.slice(0, this.pollPolicy.maxDrainRowsPerTick);

        let rowsEmitted = 0;
        let hadError = false;
        let consumedLines = 0;
        let consumedBytes = 0;
        const fileIdentity = this.bufferFileIdentity;
        if (!fileIdentity) {
            throw new Error('JSONL follower buffered complete lines without a source file identity');
        }
        for (const line of emitLines) {
            const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
            const lineStartOffsetBytes = this.bufferStartOffsetBytes + consumedBytes;
            if (line.trim() === '') {
                consumedLines += 1;
                consumedBytes += lineBytes;
                continue;
            }
            try {
                await this.onLine(line, { lineStartOffsetBytes, fileIdentity });
                rowsEmitted += 1;
                consumedLines += 1;
                consumedBytes += lineBytes;
                this.emitMetric({ type: 'row_emitted' });
            } catch (error) {
                this.onError?.(error);
                hadError = true;
                break;
            }
        }
        const remainingLines = lines.slice(consumedLines);
        this.buffer = remainingLines.length > 0
            ? `${remainingLines.join('\n')}\n${trailing}`
            : trailing;
        this.bufferStartOffsetBytes += consumedBytes;

        return {
            rowsEmitted,
            hadError,
            hasBufferedCompleteRows: remainingLines.length > 0,
        };
    }

    /** Reset on a changed device/inode pair before adopting the replacement file, reporting whether continuity was lost. */
    private handleFileIdentity(statResult: Awaited<ReturnType<typeof stat>>): boolean {
        const nextIdentity = { dev: statResult.dev, ino: statResult.ino };
        if (this.fileIdentity && !isSameFileIdentity(this.fileIdentity, nextIdentity)) {
            this.resetReadState('replaced');
            this.fileIdentity = nextIdentity;
            return true;
        }
        this.fileIdentity = nextIdentity;
        return false;
    }

    /** Discard bytes from the old file and notify discontinuity before any replacement rows, including an empty replacement. */
    private resetReadState(reason: JsonlFollowerResetReason): void {
        this.offsetBytes = 0;
        this.bufferStartOffsetBytes = 0;
        this.buffer = '';
        this.bufferFileIdentity = null;
        this.decoder = new StringDecoder('utf8');
        this.emitMetric({ type: 'file_reset', reason });
        try {
            this.onReset?.(reason);
        } catch (error) {
            this.onError?.(error);
        }
    }

    private scheduleNextPoll(outcome: JsonlFollowerDrainOutcome): void {
        if (!this.pollingActive || this.stopped) return;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const lastDrainHadActivity = outcome.bytesRead > 0 || outcome.rowsEmitted > 0 || outcome.hadReset || outcome.hasBufferedCompleteRows;
        this.idlePolls = lastDrainHadActivity ? 0 : this.idlePolls + 1;
        const delayMs = resolveJsonlFollowPollDelayMs(this.pollPolicy, {
            mode: this.mode,
            elapsedActiveMs: Date.now() - this.activeStartedAtMs,
            idlePolls: this.idlePolls,
            lastDrainHadActivity,
            lastDrainHadError: outcome.hadError,
            fileMissing: outcome.fileMissing,
        });
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.drain('poll');
        }, delayMs);
        this.timer.unref?.();
        this.emitMetric({ type: 'poll_scheduled', delayMs });
    }

    private emitMetric(event: Parameters<typeof emitJsonlFollowerMetric>[1]): void {
        emitJsonlFollowerMetric(this.metrics, event);
    }
}

function isSameFileIdentity(left: JsonlFileIdentity, right: JsonlFileIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function normalizeStartOffsetBytes(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.trunc(value);
}

function emptyDrainOutcome(): JsonlFollowerDrainOutcome {
    return {
        bytesRead: 0,
        rowsEmitted: 0,
        hadError: false,
        hadReset: false,
        fileMissing: false,
        hasBufferedCompleteRows: false,
    };
}

function mergeDrainOutcome(
    left: JsonlFollowerDrainOutcome,
    right: JsonlFollowerDrainOutcome,
): JsonlFollowerDrainOutcome {
    return {
        bytesRead: left.bytesRead + right.bytesRead,
        rowsEmitted: left.rowsEmitted + right.rowsEmitted,
        hadError: left.hadError || right.hadError,
        hadReset: left.hadReset || right.hadReset,
        fileMissing: left.fileMissing || right.fileMissing,
        hasBufferedCompleteRows: left.hasBufferedCompleteRows || right.hasBufferedCompleteRows,
    };
}

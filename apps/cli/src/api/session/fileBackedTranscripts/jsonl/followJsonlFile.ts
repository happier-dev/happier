import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

import { emitJsonlFollowerMetric } from './followMetrics';
import type { JsonlFollowerDrainSource, JsonlFollowerMetrics, JsonlFollowerResetReason } from './followMetrics';
import { normalizeJsonlFollowPolicy, resolveJsonlFollowPollDelayMs } from './followPolicy';
import type { JsonlFollowPolicyV1, JsonlFollowPolicyInputV1 } from './followPolicy';

const JSONL_READ_CHUNK_BYTES = 64 * 1024;

type JsonlFileIdentity = Readonly<{
    dev: number | bigint;
    ino: number | bigint;
}>;

export type JsonlFollowerOptions = Readonly<{
    filePath: string;
    pollIntervalMs: number;
    startAtEnd?: boolean;
    onLine: (line: string) => void | Promise<void>;
    onError?: (error: unknown) => void;
    metrics?: JsonlFollowerMetrics;
    pollPolicy?: JsonlFollowPolicyInputV1;
    getPollState?: () => Readonly<{ idle?: boolean }>;
}>;

type JsonlFollowerDrainOutcome = Readonly<{
    bytesRead: number;
    rowsEmitted: number;
    hadError: boolean;
    hadReset: boolean;
    missingFile: boolean;
}>;

export class JsonlFollower {
    private readonly filePath: string;
    private readonly pollPolicy: JsonlFollowPolicyV1;
    private readonly startAtEnd: boolean;
    private readonly onLine: (line: string) => void | Promise<void>;
    private readonly onError?: (error: unknown) => void;
    private readonly metrics?: JsonlFollowerMetrics;
    private readonly getPollState?: () => Readonly<{ idle?: boolean }>;

    private offsetBytes = 0;
    private buffer = '';
    private timer: NodeJS.Timeout | null = null;
    private startPromise: Promise<void> | null = null;
    private inFlight: Promise<void> | null = null;
    private drainQueued = false;
    private pollingActive = false;
    private lastActivityAtMs: number | null = null;
    private stopped = false;
    private lineCallbackDepth = 0;
    private decoder = new StringDecoder('utf8');
    private fileIdentity: JsonlFileIdentity | null = null;

    constructor(opts: JsonlFollowerOptions) {
        this.filePath = opts.filePath;
        this.pollPolicy = normalizeJsonlFollowPolicy(opts.pollPolicy, opts.pollIntervalMs);
        this.startAtEnd = Boolean(opts.startAtEnd);
        this.onLine = opts.onLine;
        this.onError = opts.onError;
        this.metrics = opts.metrics;
        this.getPollState = opts.getPollState;
    }

    async start(): Promise<void> {
        if (this.startPromise) {
            await this.startPromise;
            return;
        }
        if (this.pollingActive) return;
        this.startPromise = (async () => {
            this.stopped = false;
            this.pollingActive = true;
            this.lastActivityAtMs = Date.now();
            if (this.startAtEnd) {
                try {
                    const s = await stat(this.filePath);
                    this.fileIdentity = { dev: s.dev, ino: s.ino };
                    this.offsetBytes = s.size;
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
                    if (code !== 'ENOENT') {
                        throw error;
                    }
                }
            }
            await this.drain();
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
            if (this.lineCallbackDepth === 0) {
                await this.inFlight.catch(() => undefined);
                this.inFlight = null;
            }
        }
        if (!wasStopped) {
            this.emitMetric({ type: 'stopped' });
        }
    }

    async drainNow(source: JsonlFollowerDrainSource = 'manual'): Promise<void> {
        await this.drain(source);
    }

    private async drain(source: JsonlFollowerDrainSource = 'poll'): Promise<void> {
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
        let aggregate: JsonlFollowerDrainOutcome = emptyDrainOutcome();
        do {
            this.drainQueued = false;
            const outcome = await this.drainInner(source);
            aggregate = mergeDrainOutcome(aggregate, outcome);
            source = 'queued';
        } while (this.drainQueued && !this.stopped);
        this.scheduleNextPoll(aggregate);
    }

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
            } else if (this.fileIdentity) {
                this.resetReadState('missing');
                return { ...emptyDrainOutcome(), hadReset: true, missingFile: true };
            }
            return { ...emptyDrainOutcome(), missingFile: true };
        }

        if (size < this.offsetBytes) {
            this.resetReadState('truncated');
            hadReset = true;
        }

        const toRead = Math.min(size - this.offsetBytes, this.pollPolicy.maxDrainBytesPerTick);
        if (toRead <= 0) {
            const buffered = await this.emitBufferedCompleteLines();
            return {
                ...emptyDrainOutcome(),
                rowsEmitted: buffered.rowsEmitted,
                hadError: buffered.hadError,
                hadReset,
            };
        }

        this.emitMetric({ type: 'drain_started', source });
        let bytesReadTotal = 0;
        let rowsEmitted = 0;
        let hadError = false;
        try {
            const fh = await open(this.filePath, 'r');
            try {
                let position = this.offsetBytes;
                let remaining = toRead;
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
        } catch (error) {
            this.onError?.(error);
            return { bytesRead: bytesReadTotal, rowsEmitted, hadError: true, hadReset, missingFile: false };
        }

        const emitted = await this.emitBufferedCompleteLines();
        rowsEmitted += emitted.rowsEmitted;
        hadError = hadError || emitted.hadError;
        this.emitMetric({ type: 'drain_finished', bytesRead: bytesReadTotal, rowsEmitted });
        return { bytesRead: bytesReadTotal, rowsEmitted, hadError, hadReset, missingFile: false };
    }

    private async emitBufferedCompleteLines(): Promise<Readonly<{ rowsEmitted: number; hadError: boolean }>> {
        const lines = this.buffer.split('\n');
        const trailing = lines.pop() ?? '';
        if (lines.length === 0) {
            this.buffer = trailing;
            return { rowsEmitted: 0, hadError: false };
        }

        let rowsEmitted = 0;
        let hadError = false;
        const remainingLines: string[] = [];
        let capReached = false;
        for (const line of lines) {
            if (this.stopped) {
                remainingLines.push(line);
                continue;
            }
            if (capReached) {
                remainingLines.push(line);
                continue;
            }
            if (rowsEmitted >= this.pollPolicy.maxDrainRowsPerTick) {
                capReached = true;
                remainingLines.push(line);
                continue;
            }
            try {
                this.lineCallbackDepth += 1;
                await this.onLine(line);
                rowsEmitted += 1;
                this.emitMetric({ type: 'row_emitted' });
            } catch (error) {
                this.onError?.(error);
                hadError = true;
            } finally {
                this.lineCallbackDepth -= 1;
            }
        }

        if (remainingLines.length > 0) {
            this.buffer = `${remainingLines.join('\n')}\n${trailing}`;
        } else {
            this.buffer = trailing;
        }
        return { rowsEmitted, hadError };
    }

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

    private resetReadState(reason: JsonlFollowerResetReason): void {
        this.offsetBytes = 0;
        this.buffer = '';
        this.decoder = new StringDecoder('utf8');
        if (reason === 'missing') {
            this.fileIdentity = null;
        }
        this.emitMetric({ type: 'file_reset', reason });
    }

    private emitMetric(event: Parameters<typeof emitJsonlFollowerMetric>[1]): void {
        emitJsonlFollowerMetric(this.metrics, event);
    }

    private scheduleNextPoll(outcome: JsonlFollowerDrainOutcome): void {
        if (!this.pollingActive || this.stopped) return;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const lastDrainHadActivity = outcome.bytesRead > 0 || outcome.rowsEmitted > 0 || outcome.hadReset;
        if (lastDrainHadActivity) {
            this.lastActivityAtMs = Date.now();
        }
        const delayMs = resolveJsonlFollowPollDelayMs(this.pollPolicy, {
            nowMs: Date.now(),
            lastActivityAtMs: this.lastActivityAtMs,
            idle: this.getPollState?.().idle === true,
            missingFile: outcome.missingFile,
        });
        if (outcome.missingFile) {
            this.emitMetric({ type: 'missing_file_retry_scheduled', delayMs });
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.emitMetric({ type: 'poll_wakeup' });
            void this.drain('poll');
        }, delayMs);
    }
}

function isSameFileIdentity(left: JsonlFileIdentity, right: JsonlFileIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function emptyDrainOutcome(): JsonlFollowerDrainOutcome {
    return {
        bytesRead: 0,
        rowsEmitted: 0,
        hadError: false,
        hadReset: false,
        missingFile: false,
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
        missingFile: left.missingFile || right.missingFile,
    };
}

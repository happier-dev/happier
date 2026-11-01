import { createBackoff, delay, linearBackoffDelay, SupersededOperationError } from "@/utils/timing/time";
import type { PauseController } from "@/utils/timing/pauseController";

type InvalidateSyncCycleOutcome =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: unknown }>;

type InvalidateSyncCyclePending = (outcome: InvalidateSyncCycleOutcome) => void;

const INVALIDATE_SYNC_CYCLE_SUCCEEDED: InvalidateSyncCycleOutcome = { ok: true };

export type SyncQueueWaitOutcome =
    | Readonly<{ status: 'completed' }>
    | Readonly<{ status: 'wait_budget_expired' }>
    | Readonly<{ status: 'stopped' }>;

type SyncQueuePending = (outcome: SyncQueueWaitOutcome) => void;

type SyncQueueWaitOptions = { timeoutMs?: number; signal?: AbortSignal };

const SYNC_QUEUE_COMPLETED: SyncQueueWaitOutcome = { status: 'completed' };
const SYNC_QUEUE_STOPPED: SyncQueueWaitOutcome = { status: 'stopped' };

export class InvalidateSync {
    private _invalidated = false;
    private _invalidatedDouble = false;
    private _stopped = false;
    private _command: () => Promise<void>;
    private _hasStartedCommandThisCycle = false;
    private _cyclePendings: InvalidateSyncCyclePending[] = [];
    private _nextCyclePendings: InvalidateSyncCyclePending[] = [];
    private _queuePendings: SyncQueuePending[] = [];
    private _onError?: (e: any) => void;
    private _onSuccess?: () => void;
    private _onRetryFailure?: (e: any, info: { failuresCount: number; nextDelayMs: number; nextRetryAt: number }) => void;
    private _onRetry?: (info: { failuresCount: number; nextDelayMs: number; nextRetryAt: number }) => void;
    private _pause?: PauseController;
    private _backoff: {
        minDelayMs: number;
        maxDelayMs: number;
        maxFailureCount: number | 'infinite';
    };
    private _shouldRetry: (e: any, failuresCount: number) => boolean;

    constructor(
        command: () => Promise<void>,
        opts?: {
            onError?: (e: any) => void;
            onSuccess?: () => void;
            onRetryFailure?: (e: any, info: { failuresCount: number; nextDelayMs: number; nextRetryAt: number }) => void;
            onRetry?: (info: { failuresCount: number; nextDelayMs: number; nextRetryAt: number }) => void;
            pause?: PauseController;
            backoff?: { minDelayMs: number; maxDelayMs: number; maxFailureCount: number | 'infinite' };
            shouldRetry?: (e: any, failuresCount: number) => boolean;
        }
    ) {
        this._command = command;
        this._onError = opts?.onError;
        this._onSuccess = opts?.onSuccess;
        this._onRetryFailure = opts?.onRetryFailure;
        this._onRetry = opts?.onRetry;
        this._pause = opts?.pause;
        const backoff = opts?.backoff;
        this._backoff = {
            minDelayMs: Math.max(0, Math.trunc(Number.isFinite(backoff?.minDelayMs) ? backoff!.minDelayMs : 500)),
            maxDelayMs: Math.max(0, Math.trunc(Number.isFinite(backoff?.maxDelayMs) ? backoff!.maxDelayMs : 30_000)),
            maxFailureCount: backoff?.maxFailureCount ?? 'infinite',
        };
        this._shouldRetry =
            opts?.shouldRetry
            ?? ((e: any) => {
                // Default: do not retry explicitly non-retryable errors.
                // Duck-typed to avoid coupling this util to higher-level error classes.
                if (e && typeof e === 'object') {
                    if ((e as any).retryable === false) {
                        return false;
                    }
                    if (typeof (e as any).canTryAgain === 'boolean' && (e as any).canTryAgain === false) {
                        return false;
                    }
                }
                return true;
            });
    }

    invalidate() {
        if (this._stopped) {
            return;
        }
        if (!this._invalidated) {
            this._invalidated = true;
            this._invalidatedDouble = false;
            this._doSync();
        } else {
            // When paused (e.g. endpoint supervision offline or app backgrounded), multiple
            // invalidations before the first command attempt should coalesce into a single run
            // once resumed. Only schedule a second post-run cycle if a command attempt already
            // started for the current cycle.
            if (!this._invalidatedDouble && this._hasStartedCommandThisCycle) {
                this._invalidatedDouble = true;
            }
        }
    }

    invalidateCoalesced() {
        if (this._stopped) {
            return;
        }
        if (this._invalidated) {
            return;
        }
        this._invalidated = true;
        this._invalidatedDouble = false;
        this._doSync();
    }

    async invalidateAndAwait(): Promise<void>;
    async invalidateAndAwait(opts: SyncQueueWaitOptions): Promise<SyncQueueWaitOutcome>;
    async invalidateAndAwait(opts?: SyncQueueWaitOptions): Promise<void | SyncQueueWaitOutcome> {
        if (opts) return this._invalidateAndAwaitQueue(opts);
        if (this._stopped) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const pending: InvalidateSyncCyclePending = (outcome) => {
                if (!outcome.ok) {
                    reject(outcome.error);
                    return;
                }
                resolve();
            };
            if (this._invalidated && this._hasStartedCommandThisCycle) {
                this._nextCyclePendings.push(pending);
            } else {
                this._cyclePendings.push(pending);
            }
            this.invalidate();
        });
    }

    private async _invalidateAndAwaitQueue(opts: SyncQueueWaitOptions): Promise<SyncQueueWaitOutcome> {
        if (opts.signal?.aborted) throw new SupersededOperationError();
        if (this._stopped) return SYNC_QUEUE_STOPPED;
        let pending!: InvalidateSyncCyclePending;
        const cycle = new Promise<InvalidateSyncCycleOutcome>((resolve) => {
            pending = resolve;
            if (this._invalidated && this._hasStartedCommandThisCycle) {
                this._nextCyclePendings.push(pending);
            } else {
                this._cyclePendings.push(pending);
            }
        });
        this.invalidate();
        try {
            const queue = await this.awaitQueue(opts);
            if (queue.status !== 'completed') return queue;
            const outcome = await cycle;
            if (!outcome.ok) throw outcome.error;
            return queue;
        } finally {
            this._cyclePendings = this._cyclePendings.filter((entry) => entry !== pending);
            this._nextCyclePendings = this._nextCyclePendings.filter((entry) => entry !== pending);
        }
    }

    async awaitQueue(opts?: SyncQueueWaitOptions) {
        if (opts?.signal?.aborted) throw new SupersededOperationError();
        if (this._stopped) {
            return SYNC_QUEUE_STOPPED;
        }
        if (!this._invalidated && this._queuePendings.length === 0) {
            return SYNC_QUEUE_COMPLETED;
        }
        const timeoutMs = opts?.timeoutMs;
        if (!opts?.signal && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
            return await new Promise<SyncQueueWaitOutcome>(resolve => {
                this._queuePendings.push(resolve);
            });
        }

        return await new Promise<SyncQueueWaitOutcome>((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const cleanup = () => {
                clearTimeout(timer);
                opts?.signal?.removeEventListener('abort', cancel);
                this._queuePendings = this._queuePendings.filter((entry) => entry !== pending);
            };
            const pending: SyncQueuePending = (outcome) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(outcome);
            };
            const cancel = () => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new SupersededOperationError());
            };

            this._queuePendings.push(pending);
            opts?.signal?.addEventListener('abort', cancel, { once: true });
            if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
                timer = setTimeout(() => pending({ status: 'wait_budget_expired' }), timeoutMs);
            }
        });
    }

    stop() {
        if (this._stopped) {
            return;
        }
        this._stopped = true;
        this._notifyPendings();
    }

    private _notifyPendings = () => {
        for (let pending of this._cyclePendings) {
            pending(INVALIDATE_SYNC_CYCLE_SUCCEEDED);
        }
        for (let pending of this._nextCyclePendings) {
            pending(INVALIDATE_SYNC_CYCLE_SUCCEEDED);
        }
        for (let pending of this._queuePendings) {
            pending(SYNC_QUEUE_STOPPED);
        }
        this._cyclePendings = [];
        this._nextCyclePendings = [];
        this._queuePendings = [];
    }

    private _notifyCyclePendings = (outcome: InvalidateSyncCycleOutcome) => {
        for (let pending of this._cyclePendings) {
            pending(outcome);
        }
        this._cyclePendings = [];
    }

    private _promoteNextCyclePendings = () => {
        if (this._nextCyclePendings.length === 0) {
            return;
        }
        this._cyclePendings.push(...this._nextCyclePendings);
        this._nextCyclePendings = [];
    }

    private _notifyQueuePendings = () => {
        for (let pending of this._queuePendings) {
            pending(SYNC_QUEUE_COMPLETED);
        }
        this._queuePendings = [];
    }

    private _runWithBackoff = async (): Promise<void> => {
        let failuresCount = 0;
        while (true) {
            if (this._stopped) {
                return;
            }
            if (this._pause) {
                await this._pause.waitUntilResumed();
            }

            try {
                this._hasStartedCommandThisCycle = true;
                await this._command();
                return;
            } catch (e) {
                if (e instanceof SupersededOperationError) continue;
                failuresCount += 1;

                if (!this._shouldRetry(e, failuresCount)) {
                    throw e;
                }

                const maxFailureCount = this._backoff.maxFailureCount === 'infinite'
                    ? Number.POSITIVE_INFINITY
                    : Math.max(1, Math.trunc(this._backoff.maxFailureCount));
                if (failuresCount >= maxFailureCount) {
                    throw e;
                }

                // Pause-aware: do not schedule retry timers while paused.
                if (this._pause) {
                    await this._pause.waitUntilResumed();
                }

                const minDelayMs = this._backoff.minDelayMs;
                const maxDelayMs = this._backoff.maxDelayMs;
                const nextDelayMs = linearBackoffDelay(failuresCount, minDelayMs, Math.max(minDelayMs, maxDelayMs), Math.min(50, maxFailureCount));
                const retryInfo = { failuresCount, nextDelayMs, nextRetryAt: Date.now() + nextDelayMs };
                this._onRetryFailure?.(e, retryInfo);
                this._onRetry?.(retryInfo);
                await delay(nextDelayMs);
            }
        }
    };

    private _doSync = async () => {
        this._hasStartedCommandThisCycle = false;
        let outcome: InvalidateSyncCycleOutcome = INVALIDATE_SYNC_CYCLE_SUCCEEDED;
        try {
            await this._runWithBackoff();
            this._onSuccess?.();
        } catch (e) {
            // Non-retryable errors (e.g. auth/config) should not brick the sync queue.
            // We treat this as a "give up for now" and allow future invalidations to retry.
            this._onError?.(e);
            outcome = { ok: false, error: e };
        }
        if (this._stopped) {
            this._notifyPendings();
            return;
        }
        this._notifyCyclePendings(outcome);
        if (this._invalidatedDouble) {
            this._invalidatedDouble = false;
            this._promoteNextCyclePendings();
            this._doSync();
        } else if (this._nextCyclePendings.length > 0) {
            this._promoteNextCyclePendings();
            this._doSync();
        } else {
            this._invalidated = false;
            this._notifyQueuePendings();
        }
    }
}

export class ValueSync<T> {
    private _latestValue: T | undefined;
    private _hasValue = false;
    private _processing = false;
    private _stopped = false;
    private _command: (value: T) => Promise<void>;
    private _pendings: SyncQueuePending[] = [];

    constructor(command: (value: T) => Promise<void>) {
        this._command = command;
    }

    setValue(value: T) {
        if (this._stopped) {
            return;
        }
        this._latestValue = value;
        this._hasValue = true;
        if (!this._processing) {
            this._processing = true;
            this._doSync();
        }
    }

    async setValueAndAwait(value: T) {
        if (this._stopped) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(() => resolve());
            this.setValue(value);
        });
    }

    async awaitQueue(opts?: { timeoutMs?: number }) {
        if (this._stopped) {
            return SYNC_QUEUE_STOPPED;
        }
        if (!this._processing && this._pendings.length === 0) {
            return SYNC_QUEUE_COMPLETED;
        }
        const timeoutMs = opts?.timeoutMs;
        if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return await new Promise<SyncQueueWaitOutcome>(resolve => {
                this._pendings.push(resolve);
            });
        }

        return await new Promise<SyncQueueWaitOutcome>((resolve) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout>;
            const pending: SyncQueuePending = (outcome) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(outcome);
            };

            this._pendings.push(pending);
            timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                this._pendings = this._pendings.filter((entry) => entry !== pending);
                resolve({ status: 'wait_budget_expired' });
            }, timeoutMs);
        });
    }

    stop() {
        if (this._stopped) {
            return;
        }
        this._stopped = true;
        this._notifyPendings();
    }

    private _notifyPendings = () => {
        for (let pending of this._pendings) {
            pending(SYNC_QUEUE_STOPPED);
        }
        this._pendings = [];
    }

    private _doSync = async () => {
        while (this._hasValue && !this._stopped) {
            const value = this._latestValue!;
            this._hasValue = false;
            
            try {
                const backoffForever = createBackoff({
                    maxFailureCount: Number.POSITIVE_INFINITY,
                    onError: (e: unknown) => {
                        console.warn(e);
                    },
                });
                await backoffForever(async () => {
                    if (this._stopped) {
                        return;
                    }
                    await this._command(value);
                });
            } catch (e) {
                // Non-retryable errors should stop this processing loop, but not deadlock awaiters.
                console.warn(e);
                break;
            }
            
            if (this._stopped) {
                this._notifyPendings();
                return;
            }
        }
        
        this._processing = false;
        for (const pending of this._pendings) pending(SYNC_QUEUE_COMPLETED);
        this._pendings = [];
    }
}

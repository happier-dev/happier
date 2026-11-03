import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';

import { JsonlFollower } from './jsonlFollower';
import { DEFAULT_JSONL_FOLLOW_POLICY, normalizeJsonlFollowPolicy, type JsonlFollowPolicyInput, type JsonlFollowPolicyV1 } from './jsonlFollowPolicy';
import type { JsonlFollowerMetrics, JsonlFollowerResetReason } from './jsonlFollowMetrics';
import type { JsonlLineSource } from './jsonlLineFollower';

export type JsonlFollowControllerState = 'idle' | 'active' | 'completed' | 'closed';

export type JsonlFollowControllerWatchFile = (
    file: string,
    onFileChange: (file: string) => void,
) => () => void | Promise<void>;

export type JsonlFollowControllerOptions = Readonly<{
    filePath: string;
    startAtEnd?: boolean;
    startOffsetBytes?: number;
    pollIntervalMs?: number;
    pollPolicy?: JsonlFollowPolicyInput;
    metrics?: JsonlFollowerMetrics;
    watchFile?: JsonlFollowControllerWatchFile;
    onJson: (value: unknown, source?: JsonlLineSource) => void | Promise<void>;
    onReset?: (reason: JsonlFollowerResetReason) => void;
    onError?: (error: unknown) => void;
    onClosed?: () => void;
}>;

export class JsonlFollowController {
    private readonly follower: JsonlFollower;
    private readonly filePath: string;
    private readonly watchFile: JsonlFollowControllerWatchFile;
    private readonly policy: JsonlFollowPolicyV1;
    private readonly onClosed?: () => void;

    private stopWatcher: (() => void) | null = null;
    private completionTimer: NodeJS.Timeout | null = null;
    private startPromise: Promise<void> | null = null;
    private closedNotified = false;
    private state: JsonlFollowControllerState = 'idle';

    constructor(opts: JsonlFollowControllerOptions) {
        this.filePath = opts.filePath;
        this.watchFile = opts.watchFile ?? startFileWatcher;
        this.policy = normalizeJsonlFollowPolicy(opts.pollPolicy, opts.pollIntervalMs);
        this.onClosed = opts.onClosed;
        this.follower = new JsonlFollower({
            filePath: opts.filePath,
            pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_JSONL_FOLLOW_POLICY.activeBurstPollIntervalMs,
            pollPolicy: this.policy,
            startAtEnd: opts.startAtEnd,
            startOffsetBytes: opts.startOffsetBytes,
            metrics: opts.metrics,
            onJson: opts.onJson,
            onError: opts.onError,
            onReset: opts.onReset,
        });
    }

    getState(): JsonlFollowControllerState {
        return this.state;
    }

    async start(): Promise<void> {
        if (this.state === 'closed') return;
        if (this.startPromise) {
            await this.startPromise;
            return;
        }
        if (!this.stopWatcher) {
            this.stopWatcher = this.watchFile(this.filePath, () => {
                void this.drainNow('watcher');
            });
        }
        this.state = 'active';
        this.follower.setMode('active');
        this.startPromise = this.follower.start().finally(() => {
            this.startPromise = null;
        });
        await this.startPromise;
    }

    async drainNow(source: 'manual' | 'watcher' = 'manual'): Promise<void> {
        if (this.state === 'closed') return;
        await this.follower.drainNow(source);
    }

    markIdle(): void {
        if (this.state === 'closed') return;
        this.state = 'idle';
        this.follower.setMode('idle');
    }

    markCompleted(graceMs = this.policy.sidechainCompletionGraceMs): void {
        if (this.state === 'closed') return;
        this.state = 'completed';
        this.follower.setMode('idle');
        if (this.completionTimer) {
            clearTimeout(this.completionTimer);
            this.completionTimer = null;
        }
        this.completionTimer = setTimeout(() => {
            this.completionTimer = null;
            void this.closeAfterFinalDrain();
        }, Math.max(0, Math.trunc(graceMs)));
        this.completionTimer.unref?.();
    }

    async stop(): Promise<void> {
        if (this.state === 'closed') return;
        this.state = 'closed';
        if (this.completionTimer) {
            clearTimeout(this.completionTimer);
            this.completionTimer = null;
        }
        await this.stopWatcher?.();
        this.stopWatcher = null;
        await this.follower.stop();
        this.notifyClosed();
    }

    private async closeAfterFinalDrain(): Promise<void> {
        if (this.state === 'closed') return;
        await this.follower.drainNow('manual').catch(() => undefined);
        await this.stop();
    }

    private notifyClosed(): void {
        if (this.closedNotified) return;
        this.closedNotified = true;
        try {
            this.onClosed?.();
        } catch {
            // Closing a follower must not fail resource cleanup.
        }
    }
}

export function createJsonlFollowController(opts: JsonlFollowControllerOptions): JsonlFollowController {
    return new JsonlFollowController(opts);
}

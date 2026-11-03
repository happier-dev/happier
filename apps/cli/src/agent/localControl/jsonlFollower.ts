import { JsonlLineFollower, type JsonlLineSource } from './jsonlLineFollower';
import type { JsonlFollowPolicyInput } from './jsonlFollowPolicy';
import type { JsonlFollowerDrainSource, JsonlFollowerMetrics, JsonlFollowerResetReason } from './jsonlFollowMetrics';

export type JsonlFollowerOptions = Readonly<{
    filePath: string;
    pollIntervalMs: number;
    pollPolicy?: JsonlFollowPolicyInput;
    startAtEnd?: boolean;
    startOffsetBytes?: number;
    onJson: (value: unknown, source?: JsonlLineSource) => void | Promise<void>;
    onReset?: (reason: JsonlFollowerResetReason) => void;
    onError?: (error: unknown) => void;
    metrics?: JsonlFollowerMetrics;
}>;

export class JsonlFollower {
    private readonly follower: JsonlLineFollower;

    constructor(opts: JsonlFollowerOptions) {
        this.follower = new JsonlLineFollower({
            filePath: opts.filePath,
            pollIntervalMs: opts.pollIntervalMs,
            pollPolicy: opts.pollPolicy,
            startAtEnd: opts.startAtEnd,
            startOffsetBytes: opts.startOffsetBytes,
            metrics: opts.metrics,
            onError: opts.onError,
            onReset: opts.onReset,
            onLine: async (line, source) => {
                let parsed: unknown | undefined;
                try {
                    parsed = parseJsonlCompatibility(line);
                } catch (error) {
                    opts.onError?.(error);
                    return;
                }
                if (parsed === undefined) return;
                await opts.onJson(parsed, source);
            },
        });
    }

    async start(): Promise<void> {
        await this.follower.start();
    }

    async stop(): Promise<void> {
        await this.follower.stop();
    }

    setMode(mode: 'active' | 'idle'): void {
        this.follower.setMode(mode);
    }

    async drainNow(source: JsonlFollowerDrainSource = 'manual'): Promise<void> {
        await this.follower.drainNow(source);
    }
}

export function parseJsonlCompatibility(line: string): unknown | undefined {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    return JSON.parse(trimmed) as unknown;
}

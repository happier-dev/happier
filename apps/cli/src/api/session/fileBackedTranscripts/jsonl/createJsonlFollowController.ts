import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';

import { JsonlFollower } from './followJsonlFile';
import { emitJsonlFollowerMetric } from './followMetrics';
import type { JsonlFollowerMetrics } from './followMetrics';
import { normalizeJsonlFollowPolicy } from './followPolicy';
import type { JsonlFollowPolicyV1, JsonlFollowPolicyInputV1 } from './followPolicy';

type WatchFile = (file: string, onFileChange: (file: string) => void) => () => void;

export type JsonlFollowController = Readonly<{
    attach: (options?: Readonly<{ keepAlive?: boolean }>) => Promise<void>;
    detach: (options?: Readonly<{ keepAlive?: boolean }>) => Promise<void>;
    drainNow: () => Promise<void>;
    dispose: (options?: Readonly<{ finalDrain?: boolean }>) => Promise<void>;
    getPolicy: () => JsonlFollowPolicyV1;
}>;

export type JsonlFollowControllerOptions = Readonly<{
    filePath: string;
    startAtEnd?: boolean;
    onLine: (line: string) => void | Promise<void>;
    onError?: (error: unknown) => void;
    policy?: JsonlFollowPolicyInputV1;
    metrics?: JsonlFollowerMetrics;
    watchFile?: WatchFile;
}>;

export function createJsonlFollowController(options: JsonlFollowControllerOptions): JsonlFollowController {
    const policy = normalizeJsonlFollowPolicy(options.policy);
    const watchFile = options.watchFile ?? startFileWatcher;
    let follower: JsonlFollower | null = null;
    let stopWatcher: (() => void) | null = null;
    let startupPromise: Promise<void> | null = null;
    let retainers = 0;
    let keepAlive = false;
    let disposed = false;
    let generation = 0;

    const stop = async (): Promise<void> => {
        generation += 1;
        stopWatcher?.();
        stopWatcher = null;
        const current = follower;
        follower = null;
        startupPromise = null;
        await current?.stop();
        if (current) {
            emitJsonlFollowerMetric(options.metrics, { type: 'controller_stopped' });
        }
    };

    const shouldRun = (): boolean => !disposed && (retainers > 0 || keepAlive);

    const ensureStarted = async (): Promise<void> => {
        if (startupPromise) {
            await startupPromise;
            return;
        }
        if (follower || disposed || !shouldRun()) return;

        const startupGeneration = generation;
        const nextFollower = new JsonlFollower({
            filePath: options.filePath,
            pollIntervalMs: policy.activeBurstPollIntervalMs,
            startAtEnd: options.startAtEnd,
            onLine: options.onLine,
            onError: options.onError,
            metrics: options.metrics,
            pollPolicy: policy,
            getPollState: () => ({ idle: retainers === 0 && keepAlive }),
        });
        follower = nextFollower;
        stopWatcher = watchFile(options.filePath, () => {
            if (follower !== nextFollower || disposed) return;
            emitJsonlFollowerMetric(options.metrics, { type: 'watcher_wakeup' });
            void nextFollower.drainNow('watcher');
        });

        const started = (async () => {
            await nextFollower.start();
            if (generation !== startupGeneration || follower !== nextFollower || !shouldRun()) {
                await nextFollower.stop();
                if (follower === nextFollower) {
                    follower = null;
                }
                return;
            }
            emitJsonlFollowerMetric(options.metrics, { type: 'controller_started' });
        })().catch(async (error) => {
            if (follower === nextFollower) {
                follower = null;
            }
            stopWatcher?.();
            stopWatcher = null;
            await nextFollower.stop().catch(() => undefined);
            throw error;
        }).finally(() => {
            if (startupPromise === started) {
                startupPromise = null;
            }
        });
        startupPromise = started;
        await started;
    };

    return {
        async attach(attachOptions) {
            if (disposed) return;
            if (attachOptions?.keepAlive === true) {
                keepAlive = true;
            } else {
                retainers += 1;
            }
            await ensureStarted();
        },
        async detach(detachOptions) {
            if (detachOptions?.keepAlive === true) {
                keepAlive = false;
            } else {
                retainers = Math.max(0, retainers - 1);
            }
            if (!shouldRun()) {
                await stop();
            }
        },
        async drainNow() {
            await follower?.drainNow();
        },
        async dispose(disposeOptions) {
            if (disposed) {
                return;
            }
            if (disposeOptions?.finalDrain === true && !follower) {
                follower = new JsonlFollower({
                    filePath: options.filePath,
                    pollIntervalMs: policy.activeBurstPollIntervalMs,
                    startAtEnd: false,
                    onLine: options.onLine,
                    onError: options.onError,
                    metrics: options.metrics,
                    pollPolicy: policy,
                    getPollState: () => ({ idle: true }),
                });
            }
            if (disposeOptions?.finalDrain === true) {
                await follower?.drainNow();
            }
            disposed = true;
            retainers = 0;
            keepAlive = false;
            await stop();
            emitJsonlFollowerMetric(options.metrics, { type: 'controller_disposed' });
        },
        getPolicy() {
            return policy;
        },
    };
}

import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { createJsonlFollowController } from './createJsonlFollowController';
import type { JsonlFollowerMetricEvent } from './followMetrics';
import type { StartFileWatcherOptions } from '@/integrations/watcher/startFileWatcher';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void, opts?: { timeoutMs?: number; intervalMs?: number }) {
    const timeoutMs = opts?.timeoutMs ?? 5_000;
    const intervalMs = opts?.intervalMs ?? 10;
    const start = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            assertion();
            return;
        } catch (error) {
            if (Date.now() - start > timeoutMs) {
                throw error;
            }
            await delay(intervalMs);
        }
    }
}

describe('createJsonlFollowController', () => {
    it('parks healthy native watches while preserving append, partial rows, truncation and replacement', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-native-'));
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, 'initial\n');
        const received: string[] = [];
        const events: JsonlFollowerMetricEvent[] = [];
        const controller = createJsonlFollowController({
            filePath,
            onLine: (line) => { received.push(line); },
            metrics: { onEvent: (event) => { events.push(event); } },
            policy: { activeBurstPollIntervalMs: 10, activeFallbackPollIntervalMs: 20, idleFallbackPollIntervalMs: 30 },
        });
        try {
            await controller.attach();
            await delay(150);
            events.length = 0;
            await delay(100);
            expect(events.filter((event) => event.type === 'poll_wakeup')).toEqual([]);
            await appendFile(filePath, 'partial');
            await delay(50);
            expect(received).toEqual(['initial']);
            await appendFile(filePath, '-complete\n');
            await waitFor(() => expect(received).toEqual(['initial', 'partial-complete']));
            await writeFile(filePath, 'short\n');
            await waitFor(() => expect(received).toEqual(['initial', 'partial-complete', 'short']));
            const replacement = join(root, 'replacement.jsonl');
            await writeFile(replacement, 'replacement\n');
            await rename(replacement, filePath);
            await waitFor(() => expect(received.at(-1)).toBe('replacement'));
            await promisify(execFile)(process.execPath, [
                '-e',
                'require("node:fs").appendFileSync(process.argv[1], "after-replacement\\n")',
                filePath,
            ]);
            await waitFor(() => expect(received.at(-1)).toBe('after-replacement'));
            await controller.dispose();
            await appendFile(filePath, 'after-disposal\n');
            await delay(100);
            expect(received.at(-1)).toBe('after-replacement');
        } finally {
            await controller.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });

    it('polls only during watch loss and catches up when attachment recovers', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-recovery-'));
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '');
        let watcherOptions: StartFileWatcherOptions | undefined;
        const received: string[] = [];
        const events: JsonlFollowerMetricEvent[] = [];
        const controller = createJsonlFollowController({
            filePath,
            onLine: (line) => { received.push(line); },
            watchFile: (_file, _onChange, options) => { watcherOptions = options; return () => {}; },
            metrics: { onEvent: (event) => { events.push(event); } },
            policy: { activeBurstPollIntervalMs: 10 },
        });
        try {
            await controller.attach();
            watcherOptions?.onWatcherAttached?.();
            await delay(50);
            events.length = 0;
            await delay(50);
            expect(events.filter((event) => event.type === 'poll_wakeup')).toEqual([]);
            watcherOptions?.onWatcherUnavailable?.(new Error('native watch failed'));
            await appendFile(filePath, 'during-loss\n');
            await waitFor(() => expect(received).toEqual(['during-loss']));
            await appendFile(filePath, 'registration-gap\n');
            watcherOptions?.onWatcherAttached?.();
            await waitFor(() => expect(received).toEqual(['during-loss', 'registration-gap']));
            events.length = 0;
            await delay(60);
            expect(events.filter((event) => event.type === 'poll_wakeup')).toEqual([]);
        } finally {
            await controller.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });

    it('continues draining a capped backlog without requiring another filesystem event', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-backlog-'));
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, 'one\ntwo\nthree\n');
        const received: string[] = [];
        const controller = createJsonlFollowController({ filePath,
            onLine: (line) => { received.push(line); },
            policy: { maxDrainRowsPerTick: 1, maxDrainBytesPerTick: 5, activeBurstPollIntervalMs: 10 },
        });
        try {
            await controller.attach();
            await waitFor(() => expect(received).toEqual(['one', 'two', 'three']));
        } finally {
            await controller.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });

    it('recovers a missing parent and returns to native watching', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-parent-'));
        const filePath = join(root, 'missing', 'session.jsonl');
        const received: string[] = [];
        const controller = createJsonlFollowController({ filePath,
            onLine: (line) => { received.push(line); },
            policy: { missingFileRetryIntervalMs: 10 },
        });
        try {
            await controller.attach();
            await mkdir(join(root, 'missing'));
            await writeFile(filePath, 'created\n');
            await waitFor(() => expect(received).toEqual(['created']));
            await delay(1_100);
            await appendFile(filePath, 'native-append\n');
            await waitFor(() => expect(received).toEqual(['created', 'native-append']));
        } finally {
            await controller.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });
    it('observes missing file creation and emits complete lines after the file appears', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-missing-'));
        const filePath = join(root, 'session.jsonl');
        const received: string[] = [];
        const controller = createJsonlFollowController({
            filePath,
            onLine: (line) => {
                received.push(line);
            },
            policy: {
                missingFileRetryIntervalMs: 10,
                activeBurstPollIntervalMs: 10,
                activeBurstDurationMs: 50,
                activeFallbackPollIntervalMs: 25,
                idleFallbackPollIntervalMs: 50,
            },
        });

        try {
            await controller.attach();
            await writeFile(filePath, '{"created":true}\n');
            await waitFor(() => {
                expect(received).toEqual(['{"created":true}']);
            });
        } finally {
            await controller.dispose().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('stops when detached unless explicitly hot attached', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-detach-'));
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"first":1}\n');
        const metrics: string[] = [];
        const controller = createJsonlFollowController({
            filePath,
            onLine: () => {},
            policy: {
                activeBurstPollIntervalMs: 10,
                activeBurstDurationMs: 50,
                activeFallbackPollIntervalMs: 25,
                idleFallbackPollIntervalMs: 50,
            },
            metrics: {
                onEvent: (event) => metrics.push(event.type),
            },
        });

        try {
            await controller.attach();
            await controller.detach();
            await controller.attach({ keepAlive: true });
            await controller.detach();
            await controller.dispose();
            expect(metrics.filter((type) => type === 'controller_started')).toHaveLength(2);
            expect(metrics.filter((type) => type === 'controller_stopped')).toHaveLength(2);
            expect(metrics).toContain('controller_disposed');
        } finally {
            await controller.dispose().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('keeps keep-alive sources on the burst interval immediately after activity', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-idle-'));
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"first":1}\n');
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const controller = createJsonlFollowController({
            filePath,
            onLine: () => {},
            watchFile: () => () => {},
            policy: {
                activeBurstPollIntervalMs: 10,
                activeBurstDurationMs: 5_000,
                activeFallbackPollIntervalMs: 25,
                idleFallbackPollIntervalMs: 75,
            },
        });

        try {
            await controller.attach({ keepAlive: true });
            const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
            expect(delays).toContain(10);
        } finally {
            setTimeoutSpy.mockRestore();
            await controller.dispose().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('runs a bounded final drain before disposing', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-final-'));
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"first":1}\n{"second":2}\n');
        const received: string[] = [];
        const controller = createJsonlFollowController({
            filePath,
            onLine: (line) => {
                received.push(line);
            },
            policy: {
                maxDrainRowsPerTick: 1,
                maxDrainBytesPerTick: 64,
            },
        });

        try {
            await controller.dispose({ finalDrain: true });
            expect(received).toEqual(['{"first":1}']);
        } finally {
            await controller.dispose().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('records watcher wakeups separately from manual drains', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-watcher-metric-'));
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '');
        const events: JsonlFollowerMetricEvent[] = [];
        const watcherCallbacks: Array<(file: string) => void> = [];
        const controller = createJsonlFollowController({
            filePath,
            onLine: () => {},
            metrics: {
                onEvent: (event) => events.push(event),
            },
            watchFile: (_file, onFileChange) => {
                watcherCallbacks.push(onFileChange);
                return () => {};
            },
            policy: {
                activeBurstPollIntervalMs: 10_000,
            },
        });

        try {
            await controller.attach();
            watcherCallbacks[0]?.(filePath);

            await waitFor(() => {
                expect(events).toContainEqual({ type: 'watcher_wakeup' });
                expect(events).toContainEqual({ type: 'drain_requested', source: 'watcher' });
            });
        } finally {
            await controller.dispose().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rolls back a failed attach so a later successful attach can stop on detach', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-attach-rollback-'));
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"first":1}\n');
        let failStart = true;
        const metrics: string[] = [];
        const controller = createJsonlFollowController({
            filePath,
            onLine: () => {},
            watchFile: () => {
                if (failStart) {
                    throw new Error('watcher unavailable');
                }
                return () => {};
            },
            metrics: {
                onEvent: (event) => metrics.push(event.type),
            },
        });

        try {
            await expect(controller.attach()).rejects.toThrow(/watcher unavailable/);
            failStart = false;
            await controller.attach();
            await controller.detach();

            expect(metrics.filter((type) => type === 'controller_started')).toHaveLength(1);
            expect(metrics).toContain('controller_stopped');
        } finally {
            await controller.dispose().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('waits for startup drain when attach is called concurrently', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-concurrent-startup-'));
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"first":1}\n');
        let releaseFirst: (() => void) | null = null;
        const releaseFirstIfWaiting = () => {
            releaseFirst?.();
        };
        let firstRowSeen!: () => void;
        const firstRowPromise = new Promise<void>((resolve) => {
            firstRowSeen = resolve;
        });
        const metrics: string[] = [];
        const controller = createJsonlFollowController({
            filePath,
            metrics: {
                onEvent: (event) => metrics.push(event.type),
            },
            onLine: async () => {
                firstRowSeen();
                await new Promise<void>((release) => {
                    releaseFirst = release;
                });
            },
        });

        try {
            const firstAttach = controller.attach();
            await firstRowPromise;
            let secondAttachResolved = false;
            const secondAttach = controller.attach().then(() => {
                secondAttachResolved = true;
            });
            const thirdAttach = controller.attach();
            await delay(30);
            expect(secondAttachResolved).toBe(false);
            releaseFirstIfWaiting();
            await Promise.all([firstAttach, secondAttach, thirdAttach]);
            expect(secondAttachResolved).toBe(true);
            expect(metrics.filter((type) => type === 'controller_started')).toHaveLength(1);
        } finally {
            releaseFirstIfWaiting();
            await controller.dispose().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createJsonlFollowController } from './createJsonlFollowController';
import type { JsonlFollowerMetricEvent } from './followMetrics';

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
    it('retries missing file discovery and emits complete lines after the file appears', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-missing-'));
        const filePath = join(root, 'session.jsonl');
        const received: string[] = [];
        const metrics: string[] = [];
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
            metrics: {
                onEvent: (event) => metrics.push(event.type),
            },
        });

        try {
            await controller.attach();
            await writeFile(filePath, '{"created":true}\n');
            await waitFor(() => {
                expect(received).toEqual(['{"created":true}']);
            });
            expect(metrics).toContain('missing_file_retry_scheduled');
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

    it('starts only once for concurrent attach calls', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-concurrent-'));
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"first":1}\n');
        const metrics: string[] = [];
        const controller = createJsonlFollowController({
            filePath,
            onLine: () => {},
            metrics: {
                onEvent: (event) => metrics.push(event.type),
            },
        });

        try {
            await Promise.all([controller.attach(), controller.attach(), controller.attach()]);
            expect(metrics.filter((type) => type === 'controller_started')).toHaveLength(1);
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
        const controller = createJsonlFollowController({
            filePath,
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
            await delay(30);
            expect(secondAttachResolved).toBe(false);
            releaseFirstIfWaiting();
            await Promise.all([firstAttach, secondAttach]);
            expect(secondAttachResolved).toBe(true);
        } finally {
            releaseFirstIfWaiting();
            await controller.dispose().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });
});

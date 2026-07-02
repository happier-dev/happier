import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { JsonlFollower } from './followJsonlFile';
import type { JsonlFollowerMetricEvent } from './followMetrics';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void, opts?: { timeoutMs?: number; intervalMs?: number }) {
    const timeoutMs = opts?.timeoutMs ?? 5000;
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

describe('JsonlFollower', () => {
    it('emits complete raw lines without decoding JSON in the low-level follower', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-lines-'));
        const filePath = join(root, 'rollout.jsonl');

        await writeFile(filePath, '');

        const received: string[] = [];
        const follower = new JsonlFollower({
            filePath,
            pollIntervalMs: 60_000,
            onLine: (line) => {
                received.push(line);
            },
        });

        try {
            await appendFile(filePath, '{"valid":true}\nnot-json\n  spaced  \n\n');
            await follower.drainNow();
            expect(received).toEqual(['{"valid":true}', 'not-json', '  spaced  ', '']);
        } finally {
            await follower.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('waits for the initial drain when start is called concurrently', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-concurrent-start-'));
        const filePath = join(root, 'rollout.jsonl');
        await writeFile(filePath, '{"seq":1}\n');
        let releaseFirst: (() => void) | null = null;
        const releaseFirstIfWaiting = () => {
            releaseFirst?.();
        };
        let firstRowSeen!: () => void;
        const firstRowPromise = new Promise<void>((resolve) => {
            firstRowSeen = resolve;
        });
        const follower = new JsonlFollower({
            filePath,
            pollIntervalMs: 60_000,
            onLine: async () => {
                firstRowSeen();
                await new Promise<void>((release) => {
                    releaseFirst = release;
                });
            },
        });

        try {
            const firstStart = follower.start();
            await firstRowPromise;
            let secondStartResolved = false;
            const secondStart = follower.start().then(() => {
                secondStartResolved = true;
            });
            await delay(30);
            expect(secondStartResolved).toBe(false);
            releaseFirstIfWaiting();
            await Promise.all([firstStart, secondStart]);
            expect(secondStartResolved).toBe(true);
        } finally {
            releaseFirstIfWaiting();
            await follower.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('does not deadlock when stopped from inside a row callback', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-stop-inside-callback-'));
        const filePath = join(root, 'rollout.jsonl');
        await writeFile(filePath, '{"seq":1}\n');
        let follower!: JsonlFollower;
        follower = new JsonlFollower({
            filePath,
            pollIntervalMs: 60_000,
            onLine: async () => {
                await follower.stop();
            },
        });

        try {
            const result = await Promise.race([
                follower.drainNow().then(() => 'drained' as const),
                delay(200).then(() => 'timed-out' as const),
            ]);
            expect(result).toBe('drained');
        } finally {
            await follower.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('starts only one policy scheduled poll when started concurrently', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-start-once-'));
        const filePath = join(root, 'rollout.jsonl');
        await writeFile(filePath, '');

        const follower = new JsonlFollower({
            filePath,
            pollIntervalMs: 5,
            startAtEnd: true,
            onLine: () => {},
        });

        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        try {
            await Promise.all([follower.start(), follower.start()]);
            expect(setIntervalSpy).not.toHaveBeenCalled();
            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
        } finally {
            setIntervalSpy.mockRestore();
            setTimeoutSpy.mockRestore();
            await follower.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('buffers partial last line until newline is written', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-'));
        const filePath = join(root, 'rollout.jsonl');

        await writeFile(filePath, '');

        const received: unknown[] = [];
        const follower = new JsonlFollower({
            filePath,
            pollIntervalMs: 5,
            onLine: (line) => {
                received.push(JSON.parse(line) as unknown);
            },
        });
        await follower.start();

        try {
            await appendFile(filePath, '{"a":1}');
            await delay(30);
            expect(received).toEqual([]);

            await appendFile(filePath, '\n');
            await waitFor(() => {
                expect(received).toEqual([{ a: 1 }]);
            });
        } finally {
            await follower.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('can start at end and only emit newly appended lines', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-end-'));
        const filePath = join(root, 'rollout.jsonl');

        await writeFile(filePath, '{"old":1}\n');

        const received: unknown[] = [];
        const follower = new JsonlFollower({
            filePath,
            pollIntervalMs: 5,
            startAtEnd: true,
            onLine: (line) => {
                received.push(JSON.parse(line) as unknown);
            },
        });
        await follower.start();

        try {
            await delay(30);
            expect(received).toEqual([]);

            await appendFile(filePath, '{"new":2}\n');
            await waitFor(() => {
                expect(received).toEqual([{ new: 2 }]);
            });
        } finally {
            await follower.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('preserves multi-byte UTF-8 characters that are split across reads', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-utf8-'));
        const filePath = join(root, 'rollout.jsonl');

        await writeFile(filePath, '');

        const received: unknown[] = [];
        const errors: unknown[] = [];
        const follower = new JsonlFollower({
            filePath,
            pollIntervalMs: 5,
            onLine: (line) => {
                received.push(JSON.parse(line) as unknown);
            },
            onError: (error: unknown) => errors.push(error),
        });
        await follower.start();

        try {
            const prefix = Buffer.from('{"t":"', 'utf8');
            const emoji = Buffer.from('💩', 'utf8');
            const suffix = Buffer.from('"}\n', 'utf8');

            await appendFile(filePath, prefix);
            await appendFile(filePath, emoji.subarray(0, 2));
            await delay(30);

            await appendFile(filePath, emoji.subarray(2));
            await appendFile(filePath, suffix);

            await waitFor(() => {
                expect(received).toEqual([{ t: '💩' }]);
            }, { timeoutMs: 500 });
            expect(errors).toEqual([]);
        } finally {
            await follower.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('runs one queued drain after a drain request arrives while another drain is in flight', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-queued-'));
        const filePath = join(root, 'rollout.jsonl');

        await writeFile(filePath, '{"seq":1}\n');

        const received: unknown[] = [];
        let releaseFirst: (() => void) | null = null;
        const releaseFirstIfWaiting = () => {
            releaseFirst?.();
        };
        let firstRowSeen!: () => void;
        const firstRowPromise = new Promise<void>((resolve) => {
            firstRowSeen = resolve;
        });
        const follower = new JsonlFollower({
            filePath,
            pollIntervalMs: 60_000,
            onLine: async (line) => {
                const value = JSON.parse(line) as unknown;
                received.push(value);
                if ((value as { seq?: number }).seq === 1) {
                    firstRowSeen();
                    await new Promise<void>((release) => {
                        releaseFirst = release;
                    });
                }
            },
        });

        try {
            const firstDrain = follower.drainNow();
            await firstRowPromise;
            await appendFile(filePath, '{"seq":2}\n');
            const queuedDrain = follower.drainNow();
            await delay(30);
            expect(received).toEqual([{ seq: 1 }]);
            releaseFirstIfWaiting();
            await Promise.all([firstDrain, queuedDrain]);
            expect(received).toEqual([{ seq: 1 }, { seq: 2 }]);
        } finally {
            releaseFirstIfWaiting();
            await follower.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('resets the offset when the file identity changes without shrinking', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-replaced-'));
        const filePath = join(root, 'rollout.jsonl');
        const replacementPath = join(root, 'replacement.jsonl');

        await writeFile(filePath, '{"a":1}\n');

        const received: unknown[] = [];
        const follower = new JsonlFollower({
            filePath,
            pollIntervalMs: 60_000,
            onLine: (line) => {
                received.push(JSON.parse(line) as unknown);
            },
        });

        try {
            await follower.drainNow();
            expect(received).toEqual([{ a: 1 }]);

            await writeFile(replacementPath, '{"b":2}\n');
            await rename(replacementPath, filePath);

            await follower.drainNow();
            expect(received).toEqual([{ a: 1 }, { b: 2 }]);
        } finally {
            await follower.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('resets buffered partial content after truncation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-truncated-'));
        const filePath = join(root, 'rollout.jsonl');

        await writeFile(filePath, '{"partial":"this line is intentionally longer than the replacement"');

        const received: unknown[] = [];
        const follower = new JsonlFollower({
            filePath,
            pollIntervalMs: 60_000,
            onLine: (line) => {
                received.push(JSON.parse(line) as unknown);
            },
        });

        try {
            await follower.drainNow();
            await writeFile(filePath, '{"fresh":1}\n');
            await follower.drainNow();
            expect(received).toEqual([{ fresh: 1 }]);
        } finally {
            await follower.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('emits metrics for queued drains and stops only once', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-metrics-'));
        const filePath = join(root, 'rollout.jsonl');

        await writeFile(filePath, '{"seq":1}\n');

        const received: unknown[] = [];
        const metricTypes: string[] = [];
        let releaseFirst: (() => void) | null = null;
        const releaseFirstIfWaiting = () => {
            releaseFirst?.();
        };
        let firstRowSeen!: () => void;
        const firstRowPromise = new Promise<void>((resolve) => {
            firstRowSeen = resolve;
        });
        const follower = new JsonlFollower({
            filePath,
            pollIntervalMs: 60_000,
            onLine: async (line) => {
                const value = JSON.parse(line) as unknown;
                received.push(value);
                if ((value as { seq?: number }).seq === 1) {
                    firstRowSeen();
                    await new Promise<void>((release) => {
                        releaseFirst = release;
                    });
                }
            },
            metrics: {
                onEvent: (event: JsonlFollowerMetricEvent) => {
                    metricTypes.push(event.type);
                },
            },
        });

        try {
            const firstDrain = follower.drainNow();
            await firstRowPromise;
            await appendFile(filePath, '{"seq":2}\n');
            const queuedDrain = follower.drainNow();
            releaseFirstIfWaiting();
            await Promise.all([firstDrain, queuedDrain]);

            await follower.stop();
            await follower.stop();

            expect(received).toEqual([{ seq: 1 }, { seq: 2 }]);
            expect(metricTypes).toContain('drain_queued');
            expect(metricTypes).toContain('row_emitted');
            expect(metricTypes.filter((type) => type === 'stopped')).toHaveLength(1);
        } finally {
            releaseFirstIfWaiting();
            await follower.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });
});

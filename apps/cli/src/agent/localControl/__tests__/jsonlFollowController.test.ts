import { describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJsonlFollowController, type JsonlFollowControllerWatchFile } from '../jsonlFollowController';

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

describe('JsonlFollowController', () => {
    it.each(['truncated', 'replaced'] as const)('notifies an empty %s reset and continues following the new file', async reason => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-controller-reset-'));
        const filePath = join(root, 'rollout.jsonl');
        const replacement = join(root, 'replacement.jsonl');
        await writeFile(filePath, '{"old":true}\n');
        const events: unknown[] = [];
        const controller = createJsonlFollowController({
            filePath,
            pollIntervalMs: 60_000,
            watchFile: () => () => {},
            onJson: value => { events.push(value); },
            onReset: resetReason => { events.push(resetReason); },
        });
        try {
            await controller.start();
            // An absent path alone must preserve the original file's cursor.
            await rename(filePath, replacement);
            await controller.drainNow();
            await rename(replacement, filePath);
            await controller.drainNow();
            expect(events).toEqual([{ old: true }]);
            if (reason === 'replaced') {
                await writeFile(replacement, '');
                await rename(replacement, filePath);
            } else {
                await writeFile(filePath, '');
            }
            await controller.drainNow();
            expect(events).toEqual([{ old: true }, reason]);
            await appendFile(filePath, '{"new":true}\n');
            await controller.drainNow();
            expect(events).toEqual([{ old: true }, reason, { new: true }]);
        } finally {
            await controller.stop();
            await rm(root, { recursive: true, force: true });
        }
    });

    it('drains immediately when the watcher reports a file change', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follow-controller-watch-'));
        const filePath = join(root, 'rollout.jsonl');
        await writeFile(filePath, '');

        const watcherCallbackRef: { current?: (file: string) => void } = {};
        const stopWatcher = vi.fn();
        const watchFile: JsonlFollowControllerWatchFile = (file, callback) => {
            expect(file).toBe(filePath);
            watcherCallbackRef.current = callback;
            return stopWatcher;
        };

        const received: unknown[] = [];
        const controller = createJsonlFollowController({
            filePath,
            pollIntervalMs: 60_000,
            watchFile,
            onJson: (value) => {
                received.push(value);
            },
        });

        try {
            await controller.start();
            await appendFile(filePath, '{"a":1}\n');
            const onFileChange = watcherCallbackRef.current;
            if (!onFileChange) throw new Error('Expected watcher callback to be registered');
            onFileChange(filePath);

            await waitFor(() => {
                expect(received).toEqual([{ a: 1 }]);
            });
        } finally {
            await controller.stop();
            expect(stopWatcher).toHaveBeenCalledTimes(1);
            await rm(root, { recursive: true, force: true });
        }
    });

    it('awaits asynchronous watcher closure before reporting stopped', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follow-controller-async-stop-'));
        const filePath = join(root, 'rollout.jsonl');
        await writeFile(filePath, '');

        let finishWatcherClose!: () => void;
        const watcherClosed = new Promise<void>((resolve) => {
            finishWatcherClose = resolve;
        });
        const watchFile: JsonlFollowControllerWatchFile = () => async () => {
            await watcherClosed;
        };
        const controller = createJsonlFollowController({
            filePath,
            pollIntervalMs: 60_000,
            watchFile,
            onJson: () => undefined,
        });

        try {
            await controller.start();
            let stopSettled = false;
            const stopPromise = controller.stop().then(() => {
                stopSettled = true;
            });

            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(stopSettled).toBe(false);

            finishWatcherClose();
            await stopPromise;
            expect(controller.getState()).toBe('closed');
        } finally {
            finishWatcherClose?.();
            await controller.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });

    it('final-drains and closes resources after completion grace', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follow-controller-complete-'));
        const filePath = join(root, 'rollout.jsonl');
        await writeFile(filePath, '{"a":1}\n');

        const stopWatcher = vi.fn();
        const onClosed = vi.fn();
        const received: unknown[] = [];
        const controller = createJsonlFollowController({
            filePath,
            pollIntervalMs: 60_000,
            pollPolicy: { sidechainCompletionGraceMs: 1 },
            watchFile: () => stopWatcher,
            onClosed,
            onJson: (value) => {
                received.push(value);
            },
        });

        try {
            await controller.start();
            expect(received).toEqual([{ a: 1 }]);

            await appendFile(filePath, '{"b":2}\n');
            controller.markCompleted();
            expect(controller.getState()).toBe('completed');

            await waitFor(() => {
                expect(received).toEqual([{ a: 1 }, { b: 2 }]);
                expect(controller.getState()).toBe('closed');
                expect(stopWatcher).toHaveBeenCalledTimes(1);
                expect(onClosed).toHaveBeenCalledTimes(1);
            });
        } finally {
            await controller.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });
});

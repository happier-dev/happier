import type { ExecutionRunHostMessageV1 } from '../runtime/session.js';
import { describe, expect, it, vi } from 'vitest';

import { createSingleShotExecutionRunHostBackend } from './singleShot.js';

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolveValue, rejectValue) => {
        resolve = resolveValue;
        reject = rejectValue;
    });
    return { promise, resolve, reject };
}

function createModelOutputMessage(fullText: string): ExecutionRunHostMessageV1 {
    return { type: 'model-output', fullText } as unknown as ExecutionRunHostMessageV1;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

describe('createSingleShotExecutionRunHostBackend', () => {
    it('provisions a single-shot session and emits returned host messages', async () => {
        const backend = createSingleShotExecutionRunHostBackend({
            backendId: 'sample',
            sessionIdPrefix: 'sample',
            run: async ({ prompt }) => ({
                messages: [createModelOutputMessage(`review:${prompt}`)],
            }),
        });
        const messages: ExecutionRunHostMessageV1[] = [];
        const unsubscribe = backend.subscribeMessages((message) => {
            messages.push(message);
        });

        await expect(backend.provisionSession({ initialPrompt: 'boot' }))
            .resolves.toEqual({ sessionId: expect.stringMatching(/^sample_/) });
        unsubscribe();
        await backend.dispose();

        expect(messages).toEqual([createModelOutputMessage('review:boot')]);
    });

    it('isolates subscriber failures from run completion and other subscribers', async () => {
        const backend = createSingleShotExecutionRunHostBackend({
            backendId: 'sample',
            sessionIdPrefix: 'sample',
            run: async () => ({
                messages: [createModelOutputMessage('reviewed')],
            }),
        });
        const received: ExecutionRunHostMessageV1[] = [];
        backend.subscribeMessages(() => {
            throw new Error('subscriber failed');
        });
        backend.subscribeMessages((message) => {
            received.push(message);
        });
        const provisioned = await backend.provisionSession();

        await expect(backend.sendPrompt(provisioned.sessionId, 'review'))
            .resolves.toBeUndefined();
        await backend.dispose();

        expect(received).toEqual([createModelOutputMessage('reviewed')]);
    });

    it('rejects concurrent prompts for the same session with an execution-run-local busy error', async () => {
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        const backend = createSingleShotExecutionRunHostBackend({
            backendId: 'sample',
            sessionIdPrefix: 'sample',
            run: async () => {
                started.resolve();
                await release.promise;
                return { messages: [] };
            },
        });

        const provisioned = await backend.provisionSession();
        const firstPrompt = backend.sendPrompt(provisioned.sessionId, 'first');
        await started.promise;

        await expect(backend.sendPrompt(provisioned.sessionId, 'second'))
            .rejects.toMatchObject({
                executionRunErrorCode: 'single_shot_busy',
            });

        release.resolve();
        await firstPrompt;
        await backend.dispose();
    });

    it('aborts the active run on cancellation and cleans the pending slot', async () => {
        let receivedSignal: AbortSignal | null = null;
        const started = createDeferred<void>();
        const aborted = createDeferred<void>();
        const backend = createSingleShotExecutionRunHostBackend({
            backendId: 'sample',
            sessionIdPrefix: 'sample',
            run: async ({ prompt, signal }) => {
                if (prompt === 'after cancel') return { messages: [] };
                receivedSignal = signal;
                started.resolve();
                if (signal.aborted) {
                    aborted.resolve();
                    return { messages: [] };
                }
                await new Promise<void>((resolve) => {
                    signal.addEventListener('abort', () => {
                        aborted.resolve();
                        resolve();
                    }, { once: true });
                });
                return { messages: [] };
            },
        });
        const provisioned = await backend.provisionSession();

        const running = backend.sendPrompt(provisioned.sessionId, 'cancel me');
        await started.promise;
        await backend.cancel(provisioned.sessionId);

        await aborted.promise;
        await running;
        expect(receivedSignal?.aborted).toBe(true);

        await expect(backend.sendPrompt(provisioned.sessionId, 'after cancel'))
            .resolves.toBeUndefined();
        await backend.dispose();
    });

    it('aborts all active runs on disposal and unsubscribes handlers', async () => {
        const started = createDeferred<void>();
        const aborted = createDeferred<void>();
        const handler = vi.fn();
        const backend = createSingleShotExecutionRunHostBackend({
            backendId: 'sample',
            sessionIdPrefix: 'sample',
            run: async ({ signal }) => {
                started.resolve();
                await new Promise<void>((resolve) => {
                    signal.addEventListener('abort', () => {
                        aborted.resolve();
                        resolve();
                    }, { once: true });
                });
                return { messages: [createModelOutputMessage('after dispose')] };
            },
        });
        const provisioned = await backend.provisionSession();
        const unsubscribe = backend.subscribeMessages(handler);
        const running = backend.sendPrompt(provisioned.sessionId, 'dispose me');
        await started.promise;

        await backend.dispose();
        unsubscribe();
        await aborted.promise;
        await running;

        expect(handler).not.toHaveBeenCalled();
    });

    it('cleans the pending slot after plugin run failure', async () => {
        let attempt = 0;
        const backend = createSingleShotExecutionRunHostBackend({
            backendId: 'sample',
            sessionIdPrefix: 'sample',
            run: async () => {
                attempt += 1;
                if (attempt === 1) throw new Error('first failure');
                return { messages: [] };
            },
        });
        const provisioned = await backend.provisionSession();

        await expect(backend.sendPrompt(provisioned.sessionId, 'fail'))
            .rejects.toThrow('first failure');
        await expect(backend.sendPrompt(provisioned.sessionId, 'retry'))
            .resolves.toBeUndefined();
        await backend.dispose();
    });

    it('cleans the pending slot after a synchronous plugin run failure', async () => {
        let attempt = 0;
        const backend = createSingleShotExecutionRunHostBackend({
            backendId: 'sample',
            sessionIdPrefix: 'sample',
            run: () => {
                attempt += 1;
                if (attempt === 1) throw new Error('sync failure');
                return { messages: [] };
            },
        });
        const provisioned = await backend.provisionSession();

        await expect(backend.sendPrompt(provisioned.sessionId, 'fail'))
            .rejects.toThrow('sync failure');
        await expect(backend.sendPrompt(provisioned.sessionId, 'retry'))
            .resolves.toBeUndefined();
        await backend.dispose();
    });

    it('rejects resume and replay capture for single-shot execution runs', async () => {
        const backend = createSingleShotExecutionRunHostBackend({
            backendId: 'sample',
            sessionIdPrefix: 'sample',
            run: async () => ({ messages: [] }),
        });

        await expect(backend.readResumeSupport()).resolves.toBe(false);
        await expect(backend.provisionSession({ resumeSessionId: 'old-session' }))
            .rejects.toMatchObject({ executionRunErrorCode: 'single_shot_resume_unsupported' });
        await expect(backend.provisionSession({ captureReplay: true }))
            .rejects.toMatchObject({ executionRunErrorCode: 'single_shot_replay_unsupported' });
        await backend.dispose();
    });

    it('aborts active runs when the parent signal aborts', async () => {
        const parentController = new AbortController();
        let receivedSignal: AbortSignal | null = null;
        const started = createDeferred<void>();
        const backend = createSingleShotExecutionRunHostBackend({
            backendId: 'sample',
            sessionIdPrefix: 'sample',
            signal: parentController.signal,
            run: async ({ signal }) => {
                receivedSignal = signal;
                started.resolve();
                await waitFor(() => signal.aborted);
                return { messages: [] };
            },
        });
        const provisioned = await backend.provisionSession();
        const running = backend.sendPrompt(provisioned.sessionId, 'parent abort');
        await started.promise;

        parentController.abort();

        await running;
        expect(receivedSignal?.aborted).toBe(true);
        await backend.dispose();
    });
});

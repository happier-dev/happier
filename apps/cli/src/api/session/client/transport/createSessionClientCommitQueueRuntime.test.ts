import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createSessionClientCommitQueueRuntime,
    isDefinitiveSessionMessageCommitError,
} from './createSessionClientCommitQueueRuntime';

function createRuntime(overrides: Partial<Parameters<typeof createSessionClientCommitQueueRuntime>[0]> = {}) {
    return createSessionClientCommitQueueRuntime({
        token: 'token-1',
        sessionId: 'session-1',
        transcriptStorage: 'persisted',
        sessionEncryptionMode: 'plain',
        encryptionKey: new Uint8Array(),
        encryptionVariant: 'dataKey',
        getSocket: () => ({
            connected: true,
            timeout: () => ({
                connected: true,
                emitWithAck: async () => ({ ok: false, error: 'server rejected commit' }),
            }),
        } as never),
        getClosed: () => false,
        addPendingMaterializedLocalId: vi.fn(),
        hasPendingMaterializedLocalId: () => true,
        markCommittedLocalIdAwaitingEcho: vi.fn(),
        deleteMaterializedLocalId: vi.fn(),
        observeCommittedAck: vi.fn(),
        ...overrides,
    });
}

describe('createSessionClientCommitQueueRuntime definitive commit failures', () => {
    it('marks explicit server commit rejection as definitive', async () => {
        const runtime = createRuntime();

        let thrown: unknown;
        await runtime.commitSessionMessage({
            message: { t: 'plain', v: { role: 'agent', content: 'hello' } },
            localId: 'local-1',
            sidechainId: null,
            messageRole: 'agent',
            requireCommit: true,
        }).catch((error: unknown) => {
            thrown = error;
        });

        expect(isDefinitiveSessionMessageCommitError(thrown)).toBe(true);
    });
});

describe('createSessionClientCommitQueueRuntime retry intent ordering', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([
        {
            label: 'plain',
            first: { t: 'plain' as const, v: { revision: 1, updatedAt: 100 } },
            second: { t: 'plain' as const, v: { revision: 2, updatedAt: 50 } },
        },
        {
            label: 're-encrypted E2EE',
            first: 'ciphertext-for-revision-1',
            second: 'different-ciphertext-for-revision-2',
        },
    ])('does not let a stale $label retry overwrite a newer same-localId intent', async ({ first, second }) => {
        vi.useFakeTimers();
        const emitted: unknown[] = [];
        const runtime = createRuntime({
            getSocket: () => ({
                connected: true,
                timeout: () => ({
                    connected: true,
                    emitWithAck: async (_event: string, payload: unknown) => {
                        emitted.push(payload);
                        if (emitted.length === 1) return null;
                        return { ok: true, id: 'message-2', seq: 2, localId: 'stable-local-id' };
                    },
                }),
            } as never),
        });

        await runtime.commitSessionMessage({
            message: first,
            localId: 'stable-local-id',
            sidechainId: null,
            messageRole: 'agent',
            requireCommit: false,
        });
        await runtime.commitSessionMessage({
            message: second,
            localId: 'stable-local-id',
            sidechainId: null,
            messageRole: 'agent',
            requireCommit: false,
        });
        await vi.advanceTimersByTimeAsync(1_100);

        expect(emitted.map((entry) => (entry as { message: unknown }).message)).toEqual([first, second]);
    });

    it('cancels scheduled retry timers when the runtime is cleared', async () => {
        vi.useFakeTimers();
        const emitted: unknown[] = [];
        const runtime = createRuntime({
            getSocket: () => ({
                connected: true,
                timeout: () => ({
                    connected: true,
                    emitWithAck: async (_event: string, payload: unknown) => {
                        emitted.push(payload);
                        return null;
                    },
                }),
            } as never),
        });

        await runtime.commitSessionMessage({
            message: { t: 'plain', v: { revision: 1 } },
            localId: 'cleared-local-id',
            sidechainId: null,
            messageRole: 'agent',
            requireCommit: false,
        });
        runtime.clearState();
        await vi.advanceTimersByTimeAsync(3_100);

        expect(emitted).toHaveLength(1);
    });

    it('flushes only the latest same-localId payload after reconnect', async () => {
        let connected = false;
        const emitted: unknown[] = [];
        const runtime = createRuntime({
            getSocket: () => ({
                connected,
                timeout: () => ({
                    connected,
                    emitWithAck: async (_event: string, payload: unknown) => {
                        emitted.push(payload);
                        return {
                            ok: true,
                            id: 'message-1',
                            seq: 1,
                            localId: 'stable-local-id',
                        };
                    },
                }),
            } as never),
        });

        await runtime.commitSessionMessage({
            message: { t: 'plain', v: { revision: 1 } },
            localId: 'stable-local-id',
            sidechainId: null,
            messageRole: 'agent',
            requireCommit: false,
        });
        await runtime.commitSessionMessage({
            message: { t: 'plain', v: { revision: 2 } },
            localId: 'stable-local-id',
            sidechainId: null,
            messageRole: 'agent',
            requireCommit: false,
        });

        connected = true;
        await runtime.flushQueuedSessionMessagesOnReconnect();

        expect(emitted.map((entry) => (entry as { message: unknown }).message)).toEqual([
            { t: 'plain', v: { revision: 2 } },
        ]);
    });

    it('does not reset the bounded retry budget across reconnects', async () => {
        vi.useFakeTimers();
        let connected = true;
        const emitted: unknown[] = [];
        const runtime = createRuntime({
            getSocket: () => ({
                connected,
                timeout: () => ({
                    connected,
                    emitWithAck: async (_event: string, payload: unknown) => {
                        emitted.push(payload);
                        return null;
                    },
                }),
            } as never),
        });

        await runtime.commitSessionMessage({
            message: { t: 'plain', v: { revision: 1 } },
            localId: 'bounded-reconnect-local-id',
            sidechainId: null,
            messageRole: 'agent',
            requireCommit: false,
        });

        for (let reconnect = 0; reconnect < 6; reconnect += 1) {
            connected = false;
            await vi.runOnlyPendingTimersAsync();
            connected = true;
            await runtime.flushQueuedSessionMessagesOnReconnect();
        }

        expect(emitted).toHaveLength(4);
    });
});

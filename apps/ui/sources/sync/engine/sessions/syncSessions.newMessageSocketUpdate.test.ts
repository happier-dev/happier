import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/domains/state/storageTypes';
import { handleNewMessageSocketUpdate } from './sessionSocketUpdate';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { createSessionMessageApplyCoalescer } from './sessionMessageApplyCoalescer';

function buildUpdate(params: {
    sid?: string;
    messageId: string;
    messageSeq: number;
    content?: { t: 'encrypted'; c: string } | { t: 'plain'; v: unknown };
}): {
    id: string;
    seq: number;
    createdAt: number;
    body: {
        t: 'new-message';
        sid?: string;
        message: {
            id: string;
            seq: number;
                content: { t: 'encrypted'; c: string } | { t: 'plain'; v: unknown };
            localId: null;
            createdAt: number;
            updatedAt: number;
        };
    };
} {
    return {
        id: 'u1',
        seq: 100,
        createdAt: 1_000,
        body: {
            t: 'new-message',
            sid: params.sid ?? 's1',
            message: {
                id: params.messageId,
                seq: params.messageSeq,
                content: params.content ?? { t: 'encrypted', c: 'x' },
                localId: null,
                createdAt: 1_000,
                updatedAt: 1_000,
            },
        },
    };
}

function buildSession(sessionId: string, seq = 1): Session {
    return {
        id: sessionId,
        seq,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function buildHarness(overrides: Partial<Parameters<typeof handleNewMessageSocketUpdate>[0]> = {}): {
    params: Parameters<typeof handleNewMessageSocketUpdate>[0];
    applyMessages: ReturnType<typeof vi.fn>;
    applySessions: ReturnType<typeof vi.fn>;
    fetchSessions: ReturnType<typeof vi.fn>;
    onMessageGapDetected: ReturnType<typeof vi.fn>;
    markSessionMaterializedMaxSeq: ReturnType<typeof vi.fn>;
} {
    const applyMessages = vi.fn();
    const applySessions = vi.fn();
    const fetchSessions = vi.fn();
    const onMessageGapDetected = vi.fn();
    const markSessionMaterializedMaxSeq = vi.fn();
    const params: Parameters<typeof handleNewMessageSocketUpdate>[0] = {
        updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
        getSessionEncryption: () => ({
            decryptMessage: async () => ({
                id: 'm2',
                localId: null,
                createdAt: 1_000,
                content: { role: 'user', content: { type: 'text', text: 'hi' } },
            }),
        }),
        getSession: () => buildSession('s1'),
        applySessions,
        fetchSessions,
        applyMessages,
        isMutableToolCall: () => false,
        invalidateScmStatus: () => {},
        isSessionMessagesLoaded: () => true,
        getSessionMaterializedMaxSeq: () => 1,
        markSessionMaterializedMaxSeq,
        onMessageGapDetected,
        ...overrides,
    };
    return { params, applyMessages, applySessions, fetchSessions, onMessageGapDetected, markSessionMaterializedMaxSeq };
}

describe('handleNewMessageSocketUpdate', () => {
    it('preserves update message seq on normalized messages', async () => {
        const { params, applyMessages } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
        });

        await handleNewMessageSocketUpdate(params);

        const normalized = applyMessages.mock.calls?.[0]?.[1]?.[0] as NormalizedMessage | undefined;
        expect(normalized?.seq).toBe(2);
    });

    it('does not trigger catch-up when message seq is contiguous', async () => {
        const { params, fetchSessions, applyMessages, onMessageGapDetected, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
            getSessionMaterializedMaxSeq: () => 1,
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 2);
        expect(onMessageGapDetected).not.toHaveBeenCalled();
    });

    it('applies plaintext realtime messages when the session is plain and session encryption is unavailable', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { params, fetchSessions, applyMessages, applySessions, markSessionMaterializedMaxSeq } = buildHarness({
                updateData: buildUpdate({
                    sid: 's1',
                    messageId: 'm2',
                    messageSeq: 2,
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'hello from plain realtime' } },
                    },
                }),
                getSessionEncryption: () => null as any,
                getSession: () => ({ ...buildSession('s1'), encryptionMode: 'plain' } as Session),
            });

            await handleNewMessageSocketUpdate(params);

            expect(fetchSessions).not.toHaveBeenCalled();
            expect(consoleError).not.toHaveBeenCalled();
            expect(applyMessages).toHaveBeenCalledTimes(1);
            expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 2);
            expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
                id: 'm2',
                seq: 2,
                role: 'user',
            });
            expect(applySessions).toHaveBeenCalledTimes(1);
        } finally {
            consoleError.mockRestore();
        }
    });

    it('triggers catch-up when a gap is detected for a loaded transcript', async () => {
        const { params, fetchSessions, applyMessages, onMessageGapDetected, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm5', messageSeq: 5 }),
            getSessionMaterializedMaxSeq: () => 1,
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 5);
        expect(onMessageGapDetected).toHaveBeenCalledWith('s1', { prevMaterializedMaxSeq: 1, messageSeq: 5 });
    });

    it('does not trigger catch-up when transcript is not loaded (even if a gap exists)', async () => {
        const { params, onMessageGapDetected } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm5', messageSeq: 5 }),
            getSessionMaterializedMaxSeq: () => 1,
            isSessionMessagesLoaded: () => false,
        });

        await handleNewMessageSocketUpdate(params);

        expect(onMessageGapDetected).not.toHaveBeenCalled();
    });

    it('does not trigger catch-up when previous materialized seq is unknown (0)', async () => {
        const { params, onMessageGapDetected } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm5', messageSeq: 5 }),
            getSessionMaterializedMaxSeq: () => 0,
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        expect(onMessageGapDetected).not.toHaveBeenCalled();
    });

    it('falls back to invalidate messages when decryption fails for a loaded transcript', async () => {
        const { params, fetchSessions, onMessageGapDetected } = buildHarness({
            getSessionEncryption: () => ({
                decryptMessage: async () => null,
            }),
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        expect(onMessageGapDetected).toHaveBeenCalledWith('s1', { prevMaterializedMaxSeq: 1, messageSeq: 2 });
        expect(fetchSessions).not.toHaveBeenCalled();
    });

    it('fetches sessions when decryption fails and transcript is not loaded', async () => {
        const { params, fetchSessions, onMessageGapDetected } = buildHarness({
            getSessionEncryption: () => ({
                decryptMessage: async () => null,
            }),
            isSessionMessagesLoaded: () => false,
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).toHaveBeenCalledTimes(1);
        expect(onMessageGapDetected).not.toHaveBeenCalled();
    });

    it('fetches sessions when decrypted message arrives for an unknown session', async () => {
        const { params, applySessions, fetchSessions } = buildHarness({
            getSession: () => undefined,
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).toHaveBeenCalledTimes(1);
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('does not log an error when session encryption is missing for an unknown session (fetches sessions)', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { params, fetchSessions } = buildHarness({
                getSessionEncryption: () => null as any,
                getSession: () => undefined,
            });

            await handleNewMessageSocketUpdate(params);

            expect(fetchSessions).toHaveBeenCalledTimes(1);
            expect(consoleError).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('returns early for invalid update payloads without side effects', async () => {
        const { params, fetchSessions, applyMessages } = buildHarness({
            updateData: buildUpdate({ sid: '', messageId: 'm1', messageSeq: 1 }),
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('emits lifecycle callback for turn_aborted socket messages', async () => {
        const onTaskLifecycleEvent = vi.fn();
        const { params } = buildHarness({
            getSessionEncryption: () => ({
                decryptMessage: async () => ({
                    id: 'm2',
                    localId: null,
                    createdAt: 1_000,
                    content: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            provider: 'kimi',
                            data: { type: 'turn_aborted', id: 'task_1' },
                        },
                    },
                }),
            }),
            onTaskLifecycleEvent,
        });

        await handleNewMessageSocketUpdate(params);

        expect(onTaskLifecycleEvent).toHaveBeenCalledWith('s1', {
            type: 'turn_aborted',
            id: 'task_1',
            createdAt: 1_000,
        });
    });

    it('notifies onNormalizedMessagesApplied after applying a decrypted message', async () => {
        const onNormalizedMessagesApplied = vi.fn();
        const { params } = buildHarness({
            onNormalizedMessagesApplied,
            getSessionEncryption: () => ({
                decryptMessage: async () => ({
                    id: 'm2',
                    localId: null,
                    createdAt: 1_000,
                    content: { role: 'user', content: { type: 'text', text: 'hi' } },
                }),
            }),
        } as any);

        await handleNewMessageSocketUpdate(params);

        expect(onNormalizedMessagesApplied).toHaveBeenCalledTimes(1);
        expect(onNormalizedMessagesApplied.mock.calls[0]?.[0]).toBe('s1');
        expect(Array.isArray(onNormalizedMessagesApplied.mock.calls[0]?.[1])).toBe(true);
        expect(onNormalizedMessagesApplied.mock.calls[0]?.[1]?.[0]?.id).toBe('m2');
    });

    it('enqueues messages when enqueueMessages is provided (instead of applying immediately)', async () => {
        const enqueueMessages = vi.fn();
        const onNormalizedMessagesApplied = vi.fn();
        const { params, applyMessages } = buildHarness({
            enqueueMessages,
            onNormalizedMessagesApplied,
        } as any);

        await handleNewMessageSocketUpdate(params);

        expect(enqueueMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages).not.toHaveBeenCalled();
        expect(onNormalizedMessagesApplied).not.toHaveBeenCalled();
    });

    it('can coalesce socket message applies by passing a coalescer enqueue function', async () => {
        vi.useFakeTimers();
        const applied: Array<{ sessionId: string; ids: string[] }> = [];
        const applyMessages = vi.fn((sessionId: string, messages: NormalizedMessage[]) => {
            applied.push({ sessionId, ids: messages.map((m) => m.id) });
        });
        const onNormalizedMessagesApplied = vi.fn();

        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 200 }),
            applyBatch: applyMessages,
            onBatchApplied: onNormalizedMessagesApplied,
        });

        const baseParams = buildHarness({
            applyMessages,
            enqueueMessages: (sessionId: string, messages: NormalizedMessage[]) => coalescer.enqueue(sessionId, messages),
            onNormalizedMessagesApplied,
            getSessionEncryption: () => ({
                decryptMessage: async (encrypted: any) => ({
                    id: encrypted.id,
                    localId: null,
                    createdAt: 1_000,
                    content: { role: 'user', content: { type: 'text', text: 'hi' } },
                }),
            }),
            getSessionMaterializedMaxSeq: () => 1,
        } as any).params;

        await handleNewMessageSocketUpdate({
            ...baseParams,
            updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
        });
        await handleNewMessageSocketUpdate({
            ...baseParams,
            updateData: buildUpdate({ sid: 's1', messageId: 'm3', messageSeq: 3 }),
        });

        expect(applyMessages).not.toHaveBeenCalled();
        expect(onNormalizedMessagesApplied).not.toHaveBeenCalled();

        vi.advanceTimersByTime(16);

        expect(applied).toEqual([{ sessionId: 's1', ids: ['m2', 'm3'] }]);
        expect(onNormalizedMessagesApplied).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
    });
});

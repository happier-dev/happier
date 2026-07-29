import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { handleMessageUpdatedSocketUpdate } from './sessionSocketUpdate';

type TestAttentionImpact = {
    affectsUnread: boolean;
    affectsMeaningfulActivity: boolean;
};

const userAttentionImpact = {
    affectsUnread: true,
    affectsMeaningfulActivity: true,
} satisfies TestAttentionImpact;

function buildUpdate(params: {
    sid?: string;
    messageId: string;
    messageSeq: number;
    content?: { t: 'encrypted'; c: string } | { t: 'plain'; v: unknown };
    attentionImpact?: TestAttentionImpact;
    updateCreatedAt?: number;
    messageCreatedAt?: number;
    messageUpdatedAt?: number;
}): {
    id: string;
    seq: number;
    createdAt: number;
    body: {
        t: 'message-updated';
        sid?: string;
        message: {
            id: string;
            seq: number;
                content: { t: 'encrypted'; c: string } | { t: 'plain'; v: unknown };
            attentionImpact?: TestAttentionImpact;
            localId: null;
            sidechainId: null;
            createdAt: number;
            updatedAt: number;
        };
    };
} {
    return {
        id: 'u1',
        seq: 100,
        createdAt: params.updateCreatedAt ?? 1_000,
        body: {
            t: 'message-updated',
            sid: params.sid ?? 's1',
            message: {
                id: params.messageId,
                seq: params.messageSeq,
                content: params.content ?? { t: 'encrypted', c: 'x' },
                ...(params.attentionImpact ? { attentionImpact: params.attentionImpact } : {}),
                localId: null,
                sidechainId: null,
                createdAt: params.messageCreatedAt ?? 1_000,
                updatedAt: params.messageUpdatedAt ?? 2_000,
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

function buildHarness(
    overrides: Partial<Parameters<typeof handleMessageUpdatedSocketUpdate>[0]> = {},
): {
    params: Parameters<typeof handleMessageUpdatedSocketUpdate>[0];
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
    const params: Parameters<typeof handleMessageUpdatedSocketUpdate>[0] = {
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

describe('handleMessageUpdatedSocketUpdate', () => {
    it('preserves update message seq on normalized messages and advances session seq', async () => {
        const { params, applyMessages, applySessions } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
        });

        await handleMessageUpdatedSocketUpdate(params);

        const normalized = applyMessages.mock.calls?.[0]?.[1]?.[0] as NormalizedMessage | undefined;
        expect(normalized?.seq).toBe(2);

        const updatedSession = applySessions.mock.calls?.[0]?.[0]?.[0] as Session | undefined;
        expect(updatedSession?.seq).toBe(2);
    });

    it('applies plaintext message updates when the session is plain and session encryption is unavailable', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { params, applyMessages, applySessions } = buildHarness({
                updateData: buildUpdate({
                    sid: 's1',
                    messageId: 'm2',
                    messageSeq: 2,
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'plaintext update' } },
                    },
                }),
                getSessionEncryption: () => null as any,
                getSession: () => ({ ...buildSession('s1'), encryptionMode: 'plain' } as Session),
            });

            await handleMessageUpdatedSocketUpdate(params);

            expect(consoleError).not.toHaveBeenCalled();
            expect(applyMessages).toHaveBeenCalledTimes(1);
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

    it('applies loaded stale message edits to the transcript without spending a session projection update', async () => {
        const decryptMessage = vi.fn(async () => ({
            id: 'm2',
            localId: null,
            createdAt: 1_000,
            content: { role: 'assistant', content: { type: 'text', text: 'edited' } },
        }));
        const { params, applyMessages, applySessions, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({
                sid: 's1',
                messageId: 'm2',
                messageSeq: 2,
                updateCreatedAt: 2_000,
                messageCreatedAt: 1_000,
            }),
            getSession: () => ({
                ...buildSession('s1', 5),
                updatedAt: 1_500,
                meaningfulActivityAt: 1_000,
            } as Session),
            getSessionEncryption: () => ({ decryptMessage }),
            getSessionMaterializedMaxSeq: () => 2,
            isSessionMessagesLoaded: () => true,
            isSessionFullContentConsumerActive: () => true,
        });

        await handleMessageUpdatedSocketUpdate(params);

        expect(decryptMessage).toHaveBeenCalledTimes(1);
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 2);
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('marks hidden complete-projection message updates stale without decrypting transcript content', async () => {
        const decryptMessage = vi.fn(async () => ({
            id: 'm2',
            localId: null,
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'hi' } },
        }));
        const markSessionKnownRemoteSeq = vi.fn();
        const markSessionTranscriptStale = vi.fn();
        const { params, applyMessages, applySessions, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({
                sid: 's1',
                messageId: 'm2',
                messageSeq: 2,
                attentionImpact: userAttentionImpact,
            }),
            getSessionEncryption: () => ({ decryptMessage }),
            getSession: () => ({
                ...buildSession('s1'),
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 900,
            } as Session),
            isSessionActivelyViewed: () => false,
            isSessionFullContentConsumerActive: () => false,
            realtimeProjectionMode: 'enabled',
            markSessionKnownRemoteSeq,
            markSessionTranscriptStale,
        } as Partial<Parameters<typeof handleMessageUpdatedSocketUpdate>[0]>);

        await handleMessageUpdatedSocketUpdate(params);

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's1',
                seq: 2,
                updatedAt: 1_000,
                meaningfulActivityAt: 1_000,
            }),
        ]);
        expect(markSessionKnownRemoteSeq).toHaveBeenCalledWith('s1', 2);
        expect(markSessionTranscriptStale).toHaveBeenCalledWith('s1', {
            updateType: 'message-updated',
            seq: 2,
            messageId: 'm2',
        });
    });

    it('does not spend a session-list projection apply for hidden stale edits that do not advance visible row state', async () => {
        const decryptMessage = vi.fn(async () => ({
            id: 'm2',
            localId: null,
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'edited' } },
        }));
        const markSessionKnownRemoteSeq = vi.fn();
        const markSessionTranscriptStale = vi.fn();
        const { params, applySessions, applyMessages, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
            getSession: () => ({
                ...buildSession('s1', 10),
                updatedAt: 5_000,
                meaningfulActivityAt: 5_000,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 4_500,
            } as Session),
            getSessionEncryption: () => ({ decryptMessage }),
            getSessionMaterializedMaxSeq: () => 7,
            isSessionActivelyViewed: () => false,
            isSessionFullContentConsumerActive: () => false,
            realtimeProjectionMode: 'enabled',
            markSessionKnownRemoteSeq,
            markSessionTranscriptStale,
        } as Partial<Parameters<typeof handleMessageUpdatedSocketUpdate>[0]>);

        await handleMessageUpdatedSocketUpdate(params);

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
        expect(markSessionKnownRemoteSeq).toHaveBeenCalledWith('s1', 2);
        expect(markSessionTranscriptStale).toHaveBeenCalledWith('s1', expect.objectContaining({
            messageId: 'm2',
            seq: 2,
        }));
    });

    it('marks already-loaded hidden message updates stale while still advancing projection', async () => {
        const decryptMessage = vi.fn(async () => ({
            id: 'm2',
            localId: null,
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'edited' } },
        }));
        const markSessionKnownRemoteSeq = vi.fn();
        const markSessionTranscriptStale = vi.fn();
        const { params, applyMessages, applySessions, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({
                sid: 's1',
                messageId: 'm2',
                messageSeq: 2,
                attentionImpact: userAttentionImpact,
            }),
            getSession: () => ({
                ...buildSession('s1'),
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 900,
            } as Session),
            getSessionEncryption: () => ({ decryptMessage }),
            getSessionMaterializedMaxSeq: () => 2,
            isSessionActivelyViewed: () => false,
            isSessionFullContentConsumerActive: () => false,
            realtimeProjectionMode: 'enabled',
            markSessionKnownRemoteSeq,
            markSessionTranscriptStale,
        } as Partial<Parameters<typeof handleMessageUpdatedSocketUpdate>[0]>);

        await handleMessageUpdatedSocketUpdate(params);

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(markSessionKnownRemoteSeq).toHaveBeenCalledWith('s1', 2);
        expect(markSessionTranscriptStale).toHaveBeenCalledWith('s1', {
            updateType: 'message-updated',
            seq: 2,
            messageId: 'm2',
        });
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's1',
                seq: 2,
                updatedAt: 1_000,
                meaningfulActivityAt: 1_000,
            }),
        ]);
    });

    it('applies decrypted message updates even when the session is not yet hydrated, while still refreshing sessions', async () => {
        const { params, applyMessages, applySessions, markSessionMaterializedMaxSeq, fetchSessions } = buildHarness({
            getSession: () => undefined,
        });

        await handleMessageUpdatedSocketUpdate(params);

        expect(fetchSessions).toHaveBeenCalledTimes(1);
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages.mock.calls[0]?.[0]).toBe('s1');
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 2);
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('triggers catch-up when a gap is detected for a loaded transcript', async () => {
        const { params, onMessageGapDetected, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm5', messageSeq: 5 }),
            getSessionMaterializedMaxSeq: () => 1,
            isSessionMessagesLoaded: () => true,
        });

        await handleMessageUpdatedSocketUpdate(params);

        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 5);
        expect(onMessageGapDetected).toHaveBeenCalledWith('s1', { prevMaterializedMaxSeq: 1, messageSeq: 5 });
    });
});

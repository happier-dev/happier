import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/domains/state/storageTypes';
import { handleNewMessageSocketUpdate } from './sessionSocketUpdate';

function buildUpdate(params: {
    sid?: string;
    messageId: string;
    messageSeq: number;
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
            content: { t: 'encrypted'; c: string };
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
                content: { t: 'encrypted', c: 'x' },
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
    invalidateMessagesForSession: ReturnType<typeof vi.fn>;
    markSessionMaterializedMaxSeq: ReturnType<typeof vi.fn>;
} {
    const applyMessages = vi.fn();
    const applySessions = vi.fn();
    const fetchSessions = vi.fn();
    const invalidateMessagesForSession = vi.fn();
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
        invalidateGitStatus: () => {},
        isSessionMessagesLoaded: () => true,
        getSessionMaterializedMaxSeq: () => 1,
        markSessionMaterializedMaxSeq,
        invalidateMessagesForSession,
        ...overrides,
    };
    return { params, applyMessages, applySessions, fetchSessions, invalidateMessagesForSession, markSessionMaterializedMaxSeq };
}

describe('handleNewMessageSocketUpdate', () => {
    it('does not trigger catch-up when message seq is contiguous', async () => {
        const { params, fetchSessions, applyMessages, invalidateMessagesForSession, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
            getSessionMaterializedMaxSeq: () => 1,
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 2);
        expect(invalidateMessagesForSession).not.toHaveBeenCalled();
    });

    it('triggers catch-up when a gap is detected for a loaded transcript', async () => {
        const { params, fetchSessions, applyMessages, invalidateMessagesForSession, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm5', messageSeq: 5 }),
            getSessionMaterializedMaxSeq: () => 1,
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 5);
        expect(invalidateMessagesForSession).toHaveBeenCalledWith('s1');
    });

    it('does not trigger catch-up when transcript is not loaded (even if a gap exists)', async () => {
        const { params, invalidateMessagesForSession } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm5', messageSeq: 5 }),
            getSessionMaterializedMaxSeq: () => 1,
            isSessionMessagesLoaded: () => false,
        });

        await handleNewMessageSocketUpdate(params);

        expect(invalidateMessagesForSession).not.toHaveBeenCalled();
    });

    it('does not trigger catch-up when previous materialized seq is unknown (0)', async () => {
        const { params, invalidateMessagesForSession } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm5', messageSeq: 5 }),
            getSessionMaterializedMaxSeq: () => 0,
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        expect(invalidateMessagesForSession).not.toHaveBeenCalled();
    });

    it('falls back to invalidate messages when decryption fails for a loaded transcript', async () => {
        const { params, fetchSessions, invalidateMessagesForSession } = buildHarness({
            getSessionEncryption: () => ({
                decryptMessage: async () => null,
            }),
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        expect(invalidateMessagesForSession).toHaveBeenCalledWith('s1');
        expect(fetchSessions).not.toHaveBeenCalled();
    });

    it('fetches sessions when decryption fails and transcript is not loaded', async () => {
        const { params, fetchSessions, invalidateMessagesForSession } = buildHarness({
            getSessionEncryption: () => ({
                decryptMessage: async () => null,
            }),
            isSessionMessagesLoaded: () => false,
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).toHaveBeenCalledTimes(1);
        expect(invalidateMessagesForSession).not.toHaveBeenCalled();
    });

    it('fetches sessions when decrypted message arrives for an unknown session', async () => {
        const { params, applySessions, fetchSessions } = buildHarness({
            getSession: () => undefined,
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).toHaveBeenCalledTimes(1);
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('returns early for invalid update payloads without side effects', async () => {
        const { params, fetchSessions, applyMessages } = buildHarness({
            updateData: buildUpdate({ sid: '', messageId: 'm1', messageSeq: 1 }),
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
    });
});

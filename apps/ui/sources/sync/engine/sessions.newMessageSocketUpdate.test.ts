import { describe, expect, it, vi } from 'vitest';
import { handleNewMessageSocketUpdate } from './newMessageSocketUpdate';

function buildUpdate(params: { sid: string; messageId: string; messageSeq: number }) {
    return {
        id: 'u1',
        seq: 100,
        createdAt: 1_000,
        body: {
            t: 'new-message',
            sid: params.sid,
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

describe('handleNewMessageSocketUpdate', () => {
    it('does not trigger catch-up when message seq is contiguous', async () => {
        const applyMessages = vi.fn();
        const applySessions = vi.fn();
        const fetchSessions = vi.fn();
        const invalidateMessagesForSession = vi.fn();
        const markSessionMaterializedMaxSeq = vi.fn();

        await handleNewMessageSocketUpdate({
            updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
            getSessionEncryption: () => ({
                decryptMessage: async () => ({
                    id: 'm2',
                    localId: null,
                    createdAt: 1_000,
                    content: { role: 'user', content: { type: 'text', text: 'hi' } },
                }),
            }),
            getSession: () => ({ id: 's1', seq: 1 } as any),
            applySessions,
            fetchSessions,
            applyMessages,
            isMutableToolCall: () => false,
            invalidateGitStatus: () => {},
            isSessionMessagesLoaded: () => true,
            getSessionMaterializedMaxSeq: () => 1,
            markSessionMaterializedMaxSeq,
            invalidateMessagesForSession,
        });

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 2);
        expect(invalidateMessagesForSession).not.toHaveBeenCalled();
    });

    it('triggers catch-up when a gap is detected for a loaded transcript', async () => {
        const applyMessages = vi.fn();
        const applySessions = vi.fn();
        const fetchSessions = vi.fn();
        const invalidateMessagesForSession = vi.fn();
        const markSessionMaterializedMaxSeq = vi.fn();

        await handleNewMessageSocketUpdate({
            updateData: buildUpdate({ sid: 's1', messageId: 'm5', messageSeq: 5 }),
            getSessionEncryption: () => ({
                decryptMessage: async () => ({
                    id: 'm5',
                    localId: null,
                    createdAt: 1_000,
                    content: { role: 'user', content: { type: 'text', text: 'hi' } },
                }),
            }),
            getSession: () => ({ id: 's1', seq: 1 } as any),
            applySessions,
            fetchSessions,
            applyMessages,
            isMutableToolCall: () => false,
            invalidateGitStatus: () => {},
            isSessionMessagesLoaded: () => true,
            getSessionMaterializedMaxSeq: () => 1,
            markSessionMaterializedMaxSeq,
            invalidateMessagesForSession,
        });

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 5);
        expect(invalidateMessagesForSession).toHaveBeenCalledWith('s1');
    });

    it('does not trigger catch-up when transcript is not loaded (even if a gap exists)', async () => {
        const invalidateMessagesForSession = vi.fn();

        await handleNewMessageSocketUpdate({
            updateData: buildUpdate({ sid: 's1', messageId: 'm5', messageSeq: 5 }),
            getSessionEncryption: () => ({
                decryptMessage: async () => ({
                    id: 'm5',
                    localId: null,
                    createdAt: 1_000,
                    content: { role: 'user', content: { type: 'text', text: 'hi' } },
                }),
            }),
            getSession: () => ({ id: 's1', seq: 1 } as any),
            applySessions: () => {},
            fetchSessions: () => {},
            applyMessages: () => {},
            isMutableToolCall: () => false,
            invalidateGitStatus: () => {},
            isSessionMessagesLoaded: () => false,
            getSessionMaterializedMaxSeq: () => 1,
            markSessionMaterializedMaxSeq: () => {},
            invalidateMessagesForSession,
        });

        expect(invalidateMessagesForSession).not.toHaveBeenCalled();
    });

    it('falls back to invalidate messages when decryption fails for a loaded transcript', async () => {
        const invalidateMessagesForSession = vi.fn();
        const fetchSessions = vi.fn();

        await handleNewMessageSocketUpdate({
            updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
            getSessionEncryption: () => ({
                decryptMessage: async () => null,
            }),
            getSession: () => ({ id: 's1', seq: 1 } as any),
            applySessions: () => {},
            fetchSessions,
            applyMessages: () => {},
            isMutableToolCall: () => false,
            invalidateGitStatus: () => {},
            isSessionMessagesLoaded: () => true,
            getSessionMaterializedMaxSeq: () => 1,
            markSessionMaterializedMaxSeq: () => {},
            invalidateMessagesForSession,
        });

        expect(invalidateMessagesForSession).toHaveBeenCalledWith('s1');
        expect(fetchSessions).not.toHaveBeenCalled();
    });
});

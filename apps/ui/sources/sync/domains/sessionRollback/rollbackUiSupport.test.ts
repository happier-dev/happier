import { describe, expect, it } from 'vitest';

import { resolveTranscriptRollbackActions } from './rollbackUiSupport';

describe('resolveTranscriptRollbackActions', () => {
    it('exposes rollback-to-point on each active user message for Codex app-server sessions', () => {
        const session: any = {
            active: true,
            metadata: { flavor: 'codex', codexBackendMode: 'appServer' },
        };
        const messagesById: Record<string, any> = {
            u1: { kind: 'user-text', id: 'u1', seq: 1, text: 'first prompt' },
            a1: { kind: 'agent-text', id: 'a1', seq: 2, text: 'reply' },
            u2: { kind: 'user-text', id: 'u2', seq: 3, text: 'second prompt' },
            a2: { kind: 'agent-text', id: 'a2', seq: 4, text: 'second reply' },
        };

        expect(resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst: ['u1', 'a1', 'u2', 'a2'],
            messagesById,
            rollbackRanges: [],
        })).toEqual({
            u1: {
                target: { type: 'before_user_message', userMessageSeq: 1 },
                restoredDraftText: 'first prompt',
            },
            u2: {
                target: { type: 'before_user_message', userMessageSeq: 3 },
                restoredDraftText: 'second prompt',
            },
        });
    });

    it('excludes historical user messages from rollback-to-point actions', () => {
        const session: any = {
            active: true,
            metadata: {
                flavor: 'codex',
                codexBackendMode: 'appServer',
            },
        };
        const messagesById: Record<string, any> = {
            u1: { kind: 'user-text', id: 'u1', seq: 1, text: 'first prompt' },
            a1: { kind: 'agent-text', id: 'a1', seq: 2, text: 'reply' },
            u2: { kind: 'user-text', id: 'u2', seq: 3, text: 'second prompt' },
        };

        expect(resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst: ['u1', 'a1', 'u2'],
            messagesById,
            rollbackRanges: [{ startSeqInclusive: 1, endSeqInclusive: 2 }],
        })).toEqual({
            u2: {
                target: { type: 'before_user_message', userMessageSeq: 3 },
                restoredDraftText: 'second prompt',
            },
        });
    });
});

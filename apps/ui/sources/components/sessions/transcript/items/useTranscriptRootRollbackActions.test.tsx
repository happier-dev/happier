import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';

import { useTranscriptRootRollbackActions } from './useTranscriptRootRollbackActions';

function completedTurn(turnId: string, startUserMessageSeq: number) {
    return {
        turnId,
        status: 'completed' as const,
        startedAt: startUserMessageSeq,
        updatedAt: startUserMessageSeq,
        terminalAt: startUserMessageSeq,
        transcriptAnchors: {
            startUserMessageSeq,
            userMessageSeqs: [startUserMessageSeq],
            startSeqInclusive: startUserMessageSeq,
            endSeqInclusive: startUserMessageSeq + 1,
        },
        rollback: { state: 'eligible' as const, updatedAt: startUserMessageSeq },
    };
}

describe('useTranscriptRootRollbackActions', () => {
    it('recomputes rollback actions when the transcript store mutates stable message containers', async () => {
        const messageIdsOldestFirst = ['u1'];
        const messagesById: Record<string, Message> = {
            u1: {
                kind: 'user-text',
                id: 'u1',
                seq: 1,
                localId: 'u1',
                createdAt: 1,
                text: 'first',
            },
        };
        const session = {
            id: 's1',
            active: true,
            metadata: { flavor: 'codex', codexBackendMode: 'appServer' },
            sessionTurns: {
                v: 1,
                sessionId: 's1',
                latestTurnId: 'turn-2',
                updatedAt: 4,
                turns: [completedTurn('turn-1', 1), completedTurn('turn-2', 4)],
            },
        } as unknown as Session;

        const hook = await renderHook(
            ({ revision }: { revision: number }) => {
                void revision;
                return useTranscriptRootRollbackActions({
                    messageIdsOldestFirst,
                    messagesById,
                    session,
                    sessionMetadataSignature: 'codex-app-server',
                    stableSessionMetadata: session.metadata,
                });
            },
            { initialProps: { revision: 1 } },
        );

        expect(hook.getCurrent().rollbackActionsByMessageId).toHaveProperty('u1');

        messageIdsOldestFirst.push('u2');
        messagesById.u2 = {
            kind: 'user-text',
            id: 'u2',
            seq: 4,
            localId: 'u2',
            createdAt: 4,
            text: 'second',
        };
        await hook.rerender({ revision: 2 });

        expect(hook.getCurrent().rollbackActionsByMessageId).toMatchObject({
            u1: {
                target: { type: 'before_user_message', userMessageSeq: 1 },
                restoredDraftText: 'first',
            },
            u2: {
                target: { type: 'before_user_message', userMessageSeq: 4 },
                restoredDraftText: 'second',
            },
        });

        await hook.unmount();
    });
});

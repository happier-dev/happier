import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';

import { useTranscriptRootRollbackActions } from './useTranscriptRootRollbackActions';

const metadata = {
    path: '/workspace',
    host: 'localhost',
    flavor: 'codex',
    codexBackendMode: 'appServer',
} as const;

const messagesById: Readonly<Record<string, Message>> = {
    user: {
        kind: 'user-text',
        id: 'user',
        seq: 1,
        localId: 'local-user',
        createdAt: 1,
        text: 'first prompt',
    },
};

function createSession(rollbackEligibleTurnStarts?: readonly number[]): Session {
    return {
        id: 'session-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...(rollbackEligibleTurnStarts ? { rollbackEligibleTurnStarts } : {}),
    };
}

describe('useTranscriptRootRollbackActions', () => {
    it('recomputes point rollback actions when the server publishes eligible turn starts', async () => {
        const initialProps = {
            messageIdsOldestFirst: ['user'],
            messagesById,
            session: createSession(),
            sessionMetadataSignature: 'metadata-v1',
            stableSessionMetadata: metadata,
        };
        const hook = await renderHook(
            (props: typeof initialProps) => useTranscriptRootRollbackActions(props),
            { initialProps },
        );

        expect(hook.getCurrent().rollbackActionsByMessageId).toEqual({});

        await hook.rerender({
            ...initialProps,
            session: createSession([1]),
        });

        expect(hook.getCurrent().rollbackActionsByMessageId).toEqual({
            user: {
                target: { type: 'before_user_message', userMessageSeq: 1 },
                restoredDraftText: 'first prompt',
            },
        });

        await hook.unmount();
    });

    it('keeps rollback actions stable when only the unused turns projection changes', async () => {
        const eligibleTurnStarts = [1] as const;
        const session = {
            ...createSession(eligibleTurnStarts),
            sessionTurns: { v: 1, sessionId: 'session-1', updatedAt: 1, turns: [] },
        } as Session;
        const initialProps = {
            messageIdsOldestFirst: ['user'],
            messagesById,
            session,
            sessionMetadataSignature: 'metadata-v1',
            stableSessionMetadata: metadata,
        };
        const hook = await renderHook(
            (props: typeof initialProps) => useTranscriptRootRollbackActions(props),
            { initialProps },
        );
        const initialActions = hook.getCurrent().rollbackActionsByMessageId;

        await hook.rerender({
            ...initialProps,
            session: {
                ...session,
                sessionTurns: { v: 1, sessionId: 'session-1', updatedAt: 2, turns: [] },
            } as Session,
        });

        expect(hook.getCurrent().rollbackActionsByMessageId).toBe(initialActions);

        await hook.unmount();
    });

    it('recomputes rollback actions when the transcript store mutates stable message containers', async () => {
        const messageIdsOldestFirst = ['user'];
        const stableMessagesById: Record<string, Message> = { ...messagesById };
        const session = createSession([1, 4]);
        const hook = await renderHook(
            ({ revision }: { revision: number }) => {
                void revision;
                return useTranscriptRootRollbackActions({
                    messageIdsOldestFirst,
                    messagesById: stableMessagesById,
                    session,
                    sessionMetadataSignature: 'metadata-v1',
                    stableSessionMetadata: metadata,
                });
            },
            { initialProps: { revision: 1 } },
        );

        expect(hook.getCurrent().rollbackActionsByMessageId).toHaveProperty('user');

        messageIdsOldestFirst.push('second-user');
        stableMessagesById['second-user'] = {
            kind: 'user-text',
            id: 'second-user',
            seq: 4,
            localId: 'local-second-user',
            createdAt: 4,
            text: 'second prompt',
        };
        await hook.rerender({ revision: 2 });

        expect(hook.getCurrent().rollbackActionsByMessageId).toMatchObject({
            user: {
                target: { type: 'before_user_message', userMessageSeq: 1 },
                restoredDraftText: 'first prompt',
            },
            'second-user': {
                target: { type: 'before_user_message', userMessageSeq: 4 },
                restoredDraftText: 'second prompt',
            },
        });

        await hook.unmount();
    });
});

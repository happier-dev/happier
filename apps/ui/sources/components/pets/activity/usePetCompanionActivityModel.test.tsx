import { afterEach, describe, expect, it } from 'vitest';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { storage } from '@/sync/domains/state/storageStore';
import { createReducer } from '@/sync/reducer/reducer';
import type { SessionMessages } from '@/sync/store/domains/messages';

import { usePetCompanionActivityModel } from './usePetCompanionActivityModel';

function createSessionMessages(messages: readonly Message[]): SessionMessages {
    const messagesById: Record<string, Message> = {};
    const messageIdsOldestFirst: string[] = [];
    for (const message of messages) {
        messagesById[message.id] = message;
        messageIdsOldestFirst.push(message.id);
    }

    return {
        messageIdsOldestFirst,
        messagesById,
        messagesMap: messagesById,
        reducerState: createReducer(),
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        messagesVersion: messages.length,
        isLoaded: true,
    };
}

describe('usePetCompanionActivityModel', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('maps real transcript failure status to failed activity', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'failed-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });
        const failedToolMessage: Message = {
            kind: 'tool-call',
            id: 'tool-failed',
            localId: null,
            createdAt: 2_000,
            tool: {
                id: 'tool-1',
                name: 'Bash',
                state: 'error',
                input: { command: 'exit 1' },
                createdAt: 2_000,
                startedAt: 2_000,
                completedAt: 2_100,
                description: null,
                result: { error: 'Command failed' },
            },
            children: [],
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionMessages: {
                    ...state.sessionMessages,
                    [session.id]: createSessionMessages([failedToolMessage]),
                },
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'failed',
                reason: 'failed',
                sessionId: session.id,
                trayItems: [
                    expect.objectContaining({
                        sessionId: session.id,
                        status: 'failed',
                    }),
                ],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });
});

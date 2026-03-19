import { useEffect } from 'react';
import { storage } from '@/sync/domains/state/storage';
import { Message } from '@/sync/domains/messages/messageTypes';
import { createReducer } from '@/sync/reducer/reducer';

const DEMO_SESSION_ID = 'demo-messages-session';

export function useDemoMessages(messages: Message[]) {
    useEffect(() => {
        const messagesById: Record<string, Message> = {};
        for (const msg of messages) {
            messagesById[msg.id] = msg;
        }

        const messageIdsOldestFirst = [...messages]
            .sort((a, b) => {
                if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
                return String(a.id).localeCompare(String(b.id));
            })
            .map((m) => m.id);

        let latestThinkingMessageId: string | null = null;
        for (let i = messageIdsOldestFirst.length - 1; i >= 0; i -= 1) {
            const id = messageIdsOldestFirst[i]!;
            const msg = messagesById[id];
            if (msg?.kind === 'agent-text' && msg.isThinking === true) {
                latestThinkingMessageId = id;
                break;
            }
        }

        // Write the demo messages to the hardcoded session
        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                ...state.sessionMessages,
                [DEMO_SESSION_ID]: {
                    messageIdsOldestFirst,
                    messagesById,
                    messagesMap: messagesById,
                    draftsByLocalId: {},
                    reducerState: createReducer(),
                    latestThinkingMessageId,
                    latestThinkingMessageActivityAtMs: null,
                    messagesVersion: 1,
                    isLoaded: true,
                },
            },
        }));

        // Cleanup function to remove the demo session
        return () => {
            storage.setState((state) => {
                const { [DEMO_SESSION_ID]: _ignored, ...restSessions } = state.sessionMessages;
                return {
                    ...state,
                    sessionMessages: restSessions,
                };
            });
        };
    }, [messages]);

    return DEMO_SESSION_ID;
}

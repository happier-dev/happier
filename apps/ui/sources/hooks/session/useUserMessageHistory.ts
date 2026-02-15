import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useSessionMessages } from '@/sync/domains/state/storage';

import type { AgentInputHistoryScope, UserMessageHistoryNavigator } from './userMessageHistory';
import {
    collectUserMessageHistoryEntries,
    createUserMessageHistoryNavigator,
} from './userMessageHistory';

type SessionMessagesLike = { messages?: ReadonlyArray<Message> } | undefined;

function useAllSessionMessages(): Record<string, ReadonlyArray<Message> | undefined> {
    // `sessionMessages` holds a per-session reducer view; for history we only need the flattened message arrays.
    return getStorage()(
        useShallow((state: any) => {
            const sessionMessages: Record<string, SessionMessagesLike> = state.sessionMessages ?? {};
            const out: Record<string, ReadonlyArray<Message> | undefined> = {};
            for (const [sessionId, value] of Object.entries(sessionMessages)) {
                out[sessionId] = value?.messages as any;
            }
            return out;
        })
    );
}

export function useUserMessageHistory(opts: {
    scope: AgentInputHistoryScope;
    sessionId: string | null;
    maxEntries?: number;
}): UserMessageHistoryNavigator {
    // Safe: for null sessionId, subscribe to a non-existent key and get empty arrays.
    const sessionIdForHook = opts.sessionId ?? '__none__';
    const { messages: sessionMessages } = useSessionMessages(sessionIdForHook);
    const allSessionMessages = useAllSessionMessages();

    const entries = React.useMemo(() => {
        const messagesBySessionId =
            opts.scope === 'perSession'
                ? { [sessionIdForHook]: sessionMessages as ReadonlyArray<Message> }
                : allSessionMessages;

        return collectUserMessageHistoryEntries({
            scope: opts.scope,
            sessionId: opts.sessionId,
            messagesBySessionId,
            maxEntries: opts.maxEntries,
        });
    }, [opts.scope, opts.sessionId, opts.maxEntries, sessionIdForHook, sessionMessages, allSessionMessages]);

    const navigator = React.useMemo(() => createUserMessageHistoryNavigator(entries), [entries]);

    React.useEffect(() => {
        // If the user switches sessions or scope, drop any in-progress history browsing state.
        navigator.reset();
    }, [navigator, opts.sessionId, opts.scope]);

    return navigator;
}


import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { readStoredSessionMessagesFromStateLike } from '@/sync/domains/messages/readStoredSessionMessages';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useSessionMessagesById, useSessionTranscriptIds } from '@/sync/domains/state/storage';

import type { AgentInputHistoryScope, UserMessageHistoryNavigator } from './userMessageHistory';
import {
    collectUserMessageHistoryEntries,
    createUserMessageHistoryNavigator,
} from './userMessageHistory';

type SessionMessagesStateLike = {
    messageIdsOldestFirst?: ReadonlyArray<string>;
    messagesById?: Record<string, Message>;
    // Back-compat alias (older store snapshots/tests).
    messagesMap?: Record<string, Message>;
};

export function collectUserTextMessagesBySessionIdFromSessionMessagesState(
    sessionMessages: Record<string, SessionMessagesStateLike> | undefined,
): Record<string, ReadonlyArray<Message> | undefined> {
    const out: Record<string, ReadonlyArray<Message> | undefined> = {};
    const map = sessionMessages ?? {};

    for (const [sessionId, value] of Object.entries(map)) {
        const messages = readStoredSessionMessagesFromStateLike(value);

        if (messages.length === 0) {
            out[sessionId] = [];
            continue;
        }

        const userMessages: Message[] = [];
        for (const m of messages) {
            if (!m || m.kind !== 'user-text') continue;
            userMessages.push(m);
        }
        out[sessionId] = userMessages;
    }

    return out;
}

function useAllSessionMessages(enabled: boolean): Record<string, ReadonlyArray<Message> | undefined> {
    // IMPORTANT:
    // Do not derive new objects/arrays inside a Zustand selector. React 18 may call getSnapshot twice, and if
    // the selector allocates new references for the same store state it can trigger:
    // - "The result of getSnapshot should be cached…"
    // - "Maximum update depth exceeded"
    //
    // Instead, subscribe to the store's stable `sessionMessages` reference and derive via `useMemo`.
    const emptySessionMessages = React.useMemo(() => ({} as Record<string, any>), []);
    const sessionMessages = getStorage()(
        useShallow((state: any) => (enabled === true ? state.sessionMessages : emptySessionMessages))
    );

    return React.useMemo(() => {
        if (enabled !== true) return emptySessionMessages;
        return collectUserTextMessagesBySessionIdFromSessionMessagesState(sessionMessages);
    }, [enabled, sessionMessages, emptySessionMessages]);
}

export function useUserMessageHistory(opts: {
    scope: AgentInputHistoryScope;
    sessionId: string | null;
    maxEntries?: number;
}): UserMessageHistoryNavigator {
    // Safe: for null sessionId, subscribe to a non-existent key and get empty arrays.
    const sessionIdForHook = opts.sessionId ?? '__none__';
    const { ids: sessionMessageIds } = useSessionTranscriptIds(sessionIdForHook);
    const sessionMessagesById = useSessionMessagesById(sessionIdForHook);
    const allSessionMessages = useAllSessionMessages(opts.scope === 'global');

    const sessionUserMessages = React.useMemo(() => {
        if (opts.scope !== 'perSession') return [] as Message[];
        if (!Array.isArray(sessionMessageIds) || sessionMessageIds.length === 0) return [] as Message[];
        const out: Message[] = [];
        for (const id of sessionMessageIds) {
            const m = sessionMessagesById[id];
            if (!m || m.kind !== 'user-text') continue;
            out.push(m);
        }
        return out;
    }, [opts.scope, sessionMessageIds, sessionMessagesById]);

    const entries = React.useMemo(() => {
        const messagesBySessionId =
            opts.scope === 'perSession'
                ? { [sessionIdForHook]: sessionUserMessages as ReadonlyArray<Message> }
                : allSessionMessages;

        return collectUserMessageHistoryEntries({
            scope: opts.scope,
            sessionId: opts.sessionId,
            messagesBySessionId,
            maxEntries: opts.maxEntries,
        });
    }, [opts.scope, opts.sessionId, opts.maxEntries, sessionIdForHook, sessionUserMessages, allSessionMessages]);

    const navigator = React.useMemo(() => createUserMessageHistoryNavigator(entries), [entries]);

    React.useEffect(() => {
        // If the user switches sessions or scope, drop any in-progress history browsing state.
        navigator.reset();
    }, [navigator, opts.sessionId, opts.scope]);

    return navigator;
}

import type { Message } from '../../domains/messages/messageTypes';
import type { DiscardedPendingMessage, PendingMessage } from '../../domains/state/storageTypes';

import type { StoreGet, StoreSet } from './_shared';

export type SessionPending = {
    messages: PendingMessage[];
    discarded: DiscardedPendingMessage[];
    isLoaded: boolean;
};

export type PendingDomain = {
    sessionPending: Record<string, SessionPending>;
    applyPendingLoaded: (sessionId: string) => void;
    applyPendingMessages: (sessionId: string, messages: PendingMessage[]) => void;
    applyDiscardedPendingMessages: (sessionId: string, messages: DiscardedPendingMessage[]) => void;
    upsertPendingMessage: (sessionId: string, message: PendingMessage) => void;
    removePendingMessage: (sessionId: string, pendingId: string) => void;
};

type PendingDomainDependencies = {
    sessionMessages?: Record<string, {
        messagesById?: Record<string, Message>;
        messagesMap?: Record<string, Message>;
    } | undefined>;
};

function collectCommittedUserLocalIds<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    candidateLocalIds: ReadonlySet<string>,
): Set<string> {
    if (candidateLocalIds.size === 0) return new Set();

    const sessionMessages = state.sessionMessages?.[sessionId];
    const messagesById = sessionMessages?.messagesById ?? sessionMessages?.messagesMap;
    if (!messagesById) return new Set();

    const committed = new Set<string>();
    for (const message of Object.values(messagesById)) {
        if (message?.kind !== 'user-text') continue;
        const localId = typeof message.localId === 'string' ? message.localId : '';
        if (localId && candidateLocalIds.has(localId)) {
            committed.add(localId);
        }
    }
    return committed;
}

function filterUncommittedPendingMessages<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    messages: PendingMessage[],
): PendingMessage[] {
    const candidateLocalIds = new Set<string>();
    for (const message of messages) {
        if (message.localId) candidateLocalIds.add(message.localId);
    }

    const committedLocalIds = collectCommittedUserLocalIds(state, sessionId, candidateLocalIds);
    if (committedLocalIds.size === 0) return messages;

    return messages.filter((message) => !message.localId || !committedLocalIds.has(message.localId));
}

function isPendingMessageAlreadyCommitted<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    message: PendingMessage,
): boolean {
    if (!message.localId) return false;
    return collectCommittedUserLocalIds(state, sessionId, new Set([message.localId])).size > 0;
}

export function createPendingDomain<S extends PendingDomain & PendingDomainDependencies>({
    set,
    get: _get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): PendingDomain {
    return {
        sessionPending: {},
        applyPendingLoaded: (sessionId: string) => set((state) => {
            const existing = state.sessionPending[sessionId];
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        messages: existing?.messages ?? [],
                        discarded: existing?.discarded ?? [],
                        isLoaded: true
                    }
                }
            };
        }),
        applyPendingMessages: (sessionId: string, messages: PendingMessage[]) => set((state) => {
            const filteredMessages = filterUncommittedPendingMessages(state, sessionId, messages);
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        messages: filteredMessages,
                        discarded: state.sessionPending[sessionId]?.discarded ?? [],
                        isLoaded: true
                    }
                }
            };
        }),
        applyDiscardedPendingMessages: (sessionId: string, messages: DiscardedPendingMessage[]) => set((state) => ({
            ...state,
            sessionPending: {
                ...state.sessionPending,
                [sessionId]: {
                    messages: state.sessionPending[sessionId]?.messages ?? [],
                    discarded: messages,
                    isLoaded: state.sessionPending[sessionId]?.isLoaded ?? false,
                },
            },
        })),
        upsertPendingMessage: (sessionId: string, message: PendingMessage) => set((state) => {
            if (isPendingMessageAlreadyCommitted(state, sessionId, message)) {
                return state;
            }
            const existing = state.sessionPending[sessionId] ?? { messages: [], discarded: [], isLoaded: false };
            const idx = existing.messages.findIndex((m) => m.id === message.id);
            const next = idx >= 0
                ? [...existing.messages.slice(0, idx), message, ...existing.messages.slice(idx + 1)]
                : [...existing.messages, message];
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        messages: next,
                        discarded: existing.discarded,
                        isLoaded: existing.isLoaded
                    }
                }
            };
        }),
        removePendingMessage: (sessionId: string, pendingId: string) => set((state) => {
            const existing = state.sessionPending[sessionId];
            if (!existing) return state;
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        ...existing,
                        messages: existing.messages.filter((m) => m.id !== pendingId)
                    }
                }
            };
        }),
    };
}

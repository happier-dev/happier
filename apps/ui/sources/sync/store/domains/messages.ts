import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { isMutableTool } from '@/components/tools/catalog';
import { parsePermissionIntentAlias } from '@happier-dev/agents';

import { createReducer, reducer, type ReducerState } from '../../reducer/reducer';
import type { Message } from '../../domains/messages/messageTypes';
import type { NormalizedMessage } from '../../typesRaw';
import type { Session } from '../../domains/state/storageTypes';

import { persistSessionPermissionData } from './sessionPermissionPersistence';
import type { SessionPending } from './pending';
import type { StoreGet, StoreSet } from './_shared';

function normalizeSeq(seq: unknown): number | null {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
    return Math.trunc(seq);
}

function compareTranscriptMessagesNewestFirst(a: Message, b: Message): number {
    const aSeq = normalizeSeq((a as any).seq);
    const bSeq = normalizeSeq((b as any).seq);
    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
        return bSeq - aSeq;
    }

    if (a.createdAt !== b.createdAt) {
        return b.createdAt - a.createdAt;
    }

    // Tie-breaker: prefer higher seq when timestamps match (helps deterministic ordering).
    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
        return bSeq - aSeq;
    }
    // Stable deterministic fallback.
    return String(b.id).localeCompare(String(a.id));
}

export type SessionMessages = {
    messages: Message[];
    messagesMap: Record<string, Message>;
    reducerState: ReducerState;
    isLoaded: boolean;
};

export type MessagesDomain = {
    sessionMessages: Record<string, SessionMessages>;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => { changed: string[]; hasReadyEvent: boolean };
    applyMessagesLoaded: (sessionId: string) => void;
};

type MessagesDomainDependencies = {
    sessions: Record<string, Session>;
    sessionPending: Record<string, SessionPending>;
};

export function inferLatestUserPermissionModeFromMessages(messages: ReadonlyArray<Message>): { mode: PermissionMode; updatedAt: number } | null {
    for (const message of messages) {
        if (message.kind !== 'user-text') continue;
        const rawMode = message.meta?.permissionMode;
        const modeStr = typeof rawMode === 'string' ? rawMode : null;
        if (!modeStr) continue;

        const parsed = parsePermissionIntentAlias(modeStr);
        if (!parsed) continue;

        const at = message.createdAt;
        if (typeof at !== 'number' || !Number.isFinite(at)) continue;

        // parsed is a PermissionIntent (subset) but assignable to PermissionMode for now.
        return { mode: parsed as PermissionMode, updatedAt: at };
    }
    return null;
}

export function applyAgentStateUpdateToSessionMessages(params: Readonly<{
    existing: SessionMessages;
    agentState: Session['agentState'] | null;
}>): {
    sessionMessages: SessionMessages;
    sessionLatestUsage?: Session['latestUsage'];
    sessionTodos?: Session['todos'];
} {
    const existing = params.existing;
    const reducerResult = reducer(existing.reducerState, [], params.agentState);
    const processedMessages = reducerResult.messages;

    const mergedMessagesMap = { ...existing.messagesMap };
    for (const message of processedMessages) {
        mergedMessagesMap[message.id] = message;
    }

    const messagesArray = Object.values(mergedMessagesMap)
        .sort(compareTranscriptMessagesNewestFirst);

    const latestUsage = existing.reducerState.latestUsage
        ? { ...existing.reducerState.latestUsage }
        : undefined;

    return {
        sessionMessages: {
            ...existing,
            messages: messagesArray,
            messagesMap: mergedMessagesMap,
            reducerState: existing.reducerState,
        },
        sessionLatestUsage: latestUsage,
        sessionTodos: reducerResult.todos,
    };
}

export function createMessagesDomain<S extends MessagesDomain & MessagesDomainDependencies>({
    set,
    get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): MessagesDomain {
    return {
        sessionMessages: {},
        isMutableToolCall: (sessionId: string, callId: string) => {
            const sessionMessages = get().sessionMessages[sessionId];
            if (!sessionMessages) {
                return true;
            }
            const toolCall = sessionMessages.reducerState.toolIdToMessageId.get(callId);
            if (!toolCall) {
                return true;
            }
            const toolCallMessage = sessionMessages.messagesMap[toolCall];
            if (!toolCallMessage || toolCallMessage.kind !== 'tool-call') {
                return true;
            }
            return toolCallMessage.tool?.name ? isMutableTool(toolCallMessage.tool?.name) : true;
        },
        applyMessages: (sessionId: string, messages: NormalizedMessage[]) => {
            let changed = new Set<string>();
            let hasReadyEvent = false;
            set((state) => {
                const DEBUG_MESSAGE_DECRYPT =
                    typeof globalThis !== 'undefined'
                    && (
                        (globalThis as any).__HAPPIER_DEBUG_MESSAGE_DECRYPT__ === true
                        || (typeof localStorage !== 'undefined' && localStorage.getItem('happier.debug.messageDecrypt') === '1')
                    );

                // Resolve session messages state
                const existingSession = state.sessionMessages[sessionId] || {
                    messages: [],
                    messagesMap: {},
                    reducerState: createReducer(),
                    isLoaded: false
                };

                // Get the session's agentState if available
                const session = state.sessions[sessionId];
                const agentState = session?.agentState;

                // Messages are already normalized, no need to process them again
                const normalizedMessages = messages;

                // Run reducer with agentState
                const reducerResult = reducer(existingSession.reducerState, normalizedMessages, agentState);
                const processedMessages = reducerResult.messages;
                for (let message of processedMessages) {
                    changed.add(message.id);
                }
                if (reducerResult.hasReadyEvent) {
                    hasReadyEvent = true;
                }

                if (DEBUG_MESSAGE_DECRYPT) {
                    const byKind: Record<string, number> = {};
                    for (const m of processedMessages) {
                        byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
                    }
                    // eslint-disable-next-line no-console
                    console.log(
                        `[debug] applyMessages ${sessionId}: `
                            + `normalized=${normalizedMessages.length} `
                            + `reducerOut=${processedMessages.length} `
                            + `kinds=${Object.entries(byKind).map(([k, v]) => `${k}:${v}`).join(',') || 'none'}`
                    );
                }

                // Merge messages
                const mergedMessagesMap = { ...existingSession.messagesMap };
                processedMessages.forEach(message => {
                    mergedMessagesMap[message.id] = message;
                });

                // Convert to array and sort by createdAt
                const messagesArray = Object.values(mergedMessagesMap)
                    .sort(compareTranscriptMessagesNewestFirst);

                const inferred = inferLatestUserPermissionModeFromMessages(messagesArray);
                const inferredPermissionMode = inferred?.mode ?? null;
                const inferredPermissionModeAt = inferred?.updatedAt ?? null;

                // Clear server-pending items once we see the corresponding user message in the transcript.
                // We key this off localId, which is preserved when a pending item is materialized into a SessionMessage.
                let updatedSessionPending = state.sessionPending;
                const pendingState = state.sessionPending[sessionId];
                if (pendingState && pendingState.messages.length > 0) {
                    const localIdsToClear = new Set<string>();
                    for (const m of processedMessages) {
                        if (m.kind === 'user-text' && m.localId) {
                            localIdsToClear.add(m.localId);
                        }
                    }
                    if (localIdsToClear.size > 0) {
                        const filtered = pendingState.messages.filter((p) => !p.localId || !localIdsToClear.has(p.localId));
                        if (filtered.length !== pendingState.messages.length) {
                            updatedSessionPending = {
                                ...state.sessionPending,
                                [sessionId]: {
                                    ...pendingState,
                                    messages: filtered
                                }
                            };
                        }
                    }
                }

                // Update session with todos and latestUsage
                // IMPORTANT: We extract latestUsage from the mutable reducerState and copy it to the Session object
                // This ensures latestUsage is available immediately on load, even before messages are fully loaded
                let updatedSessions = state.sessions;
                const needsUpdate = (reducerResult.todos !== undefined || existingSession.reducerState.latestUsage) && session;

                const canInferPermissionMode = Boolean(
                    session &&
                    inferredPermissionMode &&
                    inferredPermissionModeAt &&
                    // If the session has a canonical permission mode in metadata, that is the source of truth.
                    // Message-level permissionMode is per-turn and must not rewrite the session's stored mode.
                    !(typeof (session.metadata as any)?.permissionMode === 'string' && (session.metadata as any).permissionMode.trim().length > 0) &&
                    // NOTE: inferredPermissionModeAt comes from message.createdAt (server timestamp for remote messages,
                    // and best-effort server-aligned timestamp for locally-created optimistic messages).
                    // permissionModeUpdatedAt is stamped using nowServerMs() for clock-safe ordering across devices.
                    inferredPermissionModeAt > (session.permissionModeUpdatedAt ?? 0)
                );

                const shouldWritePermissionMode =
                    canInferPermissionMode &&
                    (session!.permissionMode ?? 'default') !== inferredPermissionMode;

                if (needsUpdate || shouldWritePermissionMode) {
                    updatedSessions = {
                        ...state.sessions,
                        [sessionId]: {
                            ...session,
                            ...(reducerResult.todos !== undefined && { todos: reducerResult.todos }),
                            // Copy latestUsage from reducerState to make it immediately available
                            latestUsage: existingSession.reducerState.latestUsage ? {
                                ...existingSession.reducerState.latestUsage
                            } : session.latestUsage,
                            ...(shouldWritePermissionMode && {
                                permissionMode: inferredPermissionMode,
                                permissionModeUpdatedAt: inferredPermissionModeAt
                            })
                        }
                    };

                    // Persist permission modes (only non-default values to save space)
                    // Note: this includes modes inferred from session messages so they load instantly on app restart.
                    if (shouldWritePermissionMode) {
                        persistSessionPermissionData(updatedSessions);
                    }
                }

                return {
                    ...state,
                    sessions: updatedSessions,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            ...existingSession,
                            messages: messagesArray,
                            messagesMap: mergedMessagesMap,
                            reducerState: existingSession.reducerState, // Explicitly include the mutated reducer state
                            isLoaded: true
                        }
                    },
                    sessionPending: updatedSessionPending
                };
            });

            return { changed: Array.from(changed), hasReadyEvent };
        },
        applyMessagesLoaded: (sessionId: string) => set((state) => {
            const existingSession = state.sessionMessages[sessionId];

            if (!existingSession) {
                // First time loading - check for AgentState
                const session = state.sessions[sessionId];
                const agentState = session?.agentState;

                // Create new reducer state
                const reducerState = createReducer();

                // Process AgentState if it exists
                let messages: Message[] = [];
                let messagesMap: Record<string, Message> = {};

                if (agentState) {
                    // Process AgentState through reducer to get initial permission messages
                    const reducerResult = reducer(reducerState, [], agentState);
                    const processedMessages = reducerResult.messages;

                    processedMessages.forEach(message => {
                        messagesMap[message.id] = message;
                    });

                    messages = Object.values(messagesMap)
                        .sort((a, b) => b.createdAt - a.createdAt);
                }

                // Extract latestUsage from reducerState if available and update session
                let updatedSessions = state.sessions;
                if (session && reducerState.latestUsage) {
                    updatedSessions = {
                        ...state.sessions,
                        [sessionId]: {
                            ...session,
                            latestUsage: { ...reducerState.latestUsage }
                        }
                    };
                }

                return {
                    ...state,
                    sessions: updatedSessions,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            reducerState,
                            messages,
                            messagesMap,
                            isLoaded: true
                        } satisfies SessionMessages
                    }
                };
            }

            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        ...existingSession,
                        isLoaded: true
                    } satisfies SessionMessages
                }
            };
        }),
    };
}

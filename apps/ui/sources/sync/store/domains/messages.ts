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

function compareTranscriptMessagesOldestFirst(a: Message, b: Message): number {
    const aSeq = normalizeSeq((a as any).seq);
    const bSeq = normalizeSeq((b as any).seq);
    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
        return aSeq - bSeq;
    }

    if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt;
    }

    // Stable deterministic fallback.
    return String(a.id).localeCompare(String(b.id));
}

export type SessionMessages = {
    messageIdsOldestFirst: string[];
    messagesById: Record<string, Message>;
    // Back-compat alias for older call sites (do not use in new code).
    messagesMap: Record<string, Message>;
    /**
     * IMPORTANT ARCHITECTURE NOTE:
     * `messagesById` is intentionally mutated in-place for streaming performance.
     *
     * As a result:
     * - Do NOT rely on `messagesById` referential identity changes to detect updates.
     * - Prefer id-based subscriptions (`useMessage(sessionId, messageId)`) or
     *   selectors keyed on stable primitives (ids/version counters).
     */
    reducerState: ReducerState;
    latestThinkingMessageId: string | null;
    latestThinkingMessageActivityAtMs: number | null;
    messagesVersion: number;
    isLoaded: boolean;
};

export type MessagesDomain = {
    sessionMessages: Record<string, SessionMessages>;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => { changed: string[]; hasReadyEvent: boolean };
    applyMessagesLoaded: (sessionId: string) => void;
    resetSessionMessages: (sessionId: string) => void;
};

type MessagesDomainDependencies = {
    sessions: Record<string, Session>;
    sessionPending: Record<string, SessionPending>;
};

function mergeSortedMessageIdsOldestFirst(params: Readonly<{
    existingSortedIds: readonly string[];
    insertSortedIds: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let i = 0;
    let j = 0;

    const compare = (aId: string, bId: string): number => {
        if (aId === bId) return 0;
        const a = params.messagesById[aId];
        const b = params.messagesById[bId];
        if (!a && !b) return String(aId).localeCompare(String(bId));
        if (!a) return -1;
        if (!b) return 1;
        return compareTranscriptMessagesOldestFirst(a, b);
    };

    while (i < params.existingSortedIds.length || j < params.insertSortedIds.length) {
        const aId = i < params.existingSortedIds.length ? params.existingSortedIds[i]! : null;
        const bId = j < params.insertSortedIds.length ? params.insertSortedIds[j]! : null;

        const nextId = (() => {
            if (aId === null) return bId!;
            if (bId === null) return aId!;
            return compare(aId, bId) <= 0 ? aId : bId;
        })();

        if (!seen.has(nextId)) {
            out.push(nextId);
            seen.add(nextId);
        }

        if (aId !== null && nextId === aId) i += 1;
        if (bId !== null && nextId === bId) j += 1;
    }

    return out;
}

function coerceSessionMessages(input: unknown): SessionMessages {
    const raw = input as any;
    const reducerState: ReducerState = raw?.reducerState ? (raw.reducerState as ReducerState) : createReducer();

    const messagesById: Record<string, Message> =
        raw?.messagesById && typeof raw.messagesById === 'object'
            ? (raw.messagesById as Record<string, Message>)
            : (raw?.messagesMap && typeof raw.messagesMap === 'object'
                ? (raw.messagesMap as Record<string, Message>)
                : {});

    const messageIdsOldestFirst: string[] = Array.isArray(raw?.messageIdsOldestFirst)
        ? (raw.messageIdsOldestFirst as string[])
        : (() => {
            const fromMessages: Message[] | null = Array.isArray(raw?.messages) ? (raw.messages as Message[]) : null;
            const list = fromMessages ?? Object.values(messagesById);
            return list.slice().sort(compareTranscriptMessagesOldestFirst).map((m) => m.id);
        })();

    const latestThinkingMessageId: string | null =
        typeof raw?.latestThinkingMessageId === 'string'
            ? (raw.latestThinkingMessageId as string)
            : findLatestThinkingMessageId({ idsOldestFirst: messageIdsOldestFirst, messagesById });

    const latestThinkingMessageActivityAtMs: number | null =
        typeof raw?.latestThinkingMessageActivityAtMs === 'number' && Number.isFinite(raw.latestThinkingMessageActivityAtMs)
            ? Math.trunc(raw.latestThinkingMessageActivityAtMs)
            : null;

    const messagesVersion: number =
        typeof raw?.messagesVersion === 'number' && Number.isFinite(raw.messagesVersion)
            ? Math.trunc(raw.messagesVersion)
            : 0;

    const isLoaded = raw?.isLoaded === true;

    return {
        messageIdsOldestFirst,
        messagesById,
        messagesMap: messagesById,
        reducerState,
        latestThinkingMessageId,
        latestThinkingMessageActivityAtMs,
        messagesVersion,
        isLoaded,
    };
}

function inferLatestUserPermissionModeFromChangedMessages(
    messages: ReadonlyArray<Message>,
): { mode: PermissionMode; updatedAt: number } | null {
    let best: { mode: PermissionMode; updatedAt: number } | null = null;

    for (const message of messages) {
        if (message.kind !== 'user-text') continue;
        const rawMode = message.meta?.permissionMode;
        const modeStr = typeof rawMode === 'string' ? rawMode : null;
        if (!modeStr) continue;

        const parsed = parsePermissionIntentAlias(modeStr);
        if (!parsed) continue;

        const at = message.createdAt;
        if (typeof at !== 'number' || !Number.isFinite(at)) continue;

        if (!best || at > best.updatedAt) {
            best = { mode: parsed as PermissionMode, updatedAt: at };
        }
    }

    return best;
}

export function inferLatestUserPermissionModeFromMessages(
    messages: ReadonlyArray<Message>,
): { mode: PermissionMode; updatedAt: number } | null {
    return inferLatestUserPermissionModeFromChangedMessages(messages);
}

function findLatestThinkingMessageId(params: Readonly<{
    idsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): string | null {
    for (let i = params.idsOldestFirst.length - 1; i >= 0; i -= 1) {
        const id = params.idsOldestFirst[i]!;
        const message = params.messagesById[id];
        if (!message) continue;
        if (message.kind !== 'agent-text') continue;
        if (message.isThinking === true) return message.id;
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
    const existing = coerceSessionMessages(params.existing);
    const reducerResult = reducer(existing.reducerState, [], params.agentState);
    const processedMessages = reducerResult.messages;

    const messagesById = existing.messagesById;
    const idsToRemove = new Set<string>();
    const idsToInsert: string[] = [];

    let latestThinkingMessageId = existing.latestThinkingMessageId;
    let shouldRecomputeLatestThinking = false;
    let didSeeThinkingTextChange = false;
    let latestThinkingMessageActivityAtMs = existing.latestThinkingMessageActivityAtMs ?? null;

    for (const message of processedMessages) {
        const prev = messagesById[message.id];
        if (!prev) {
            idsToInsert.push(message.id);
        } else {
            const prevSeq = normalizeSeq((prev as any).seq);
            const nextSeq = normalizeSeq((message as any).seq);
            if (prev.createdAt !== message.createdAt || prevSeq !== nextSeq) {
                idsToRemove.add(message.id);
                idsToInsert.push(message.id);
            }
        }

        if (message.kind === 'agent-text' && message.isThinking === true) {
            const prevText = prev && prev.kind === 'agent-text' ? prev.text : null;
            if (!prev || prev.kind !== 'agent-text' || prev.isThinking !== true || prevText !== message.text) {
                didSeeThinkingTextChange = true;
            }
        }

        messagesById[message.id] = message;

        if (message.kind === 'agent-text' && message.isThinking === true) {
            if (latestThinkingMessageId == null) {
                latestThinkingMessageId = message.id;
            } else {
                const curr = messagesById[latestThinkingMessageId];
                if (!curr || compareTranscriptMessagesOldestFirst(curr, message) < 0) {
                    latestThinkingMessageId = message.id;
                }
            }
        } else if (latestThinkingMessageId === message.id) {
            shouldRecomputeLatestThinking = true;
        }
    }

    const nextIds = (() => {
        const existingIds = existing.messageIdsOldestFirst;
        if (idsToInsert.length === 0 && idsToRemove.size === 0) return existingIds;

        const filtered = idsToRemove.size > 0
            ? existingIds.filter((id) => !idsToRemove.has(id))
            : existingIds.slice();

        const uniqueInsertIds = Array.from(new Set(idsToInsert));
        uniqueInsertIds.sort((a, b) => compareTranscriptMessagesOldestFirst(messagesById[a]!, messagesById[b]!));

        return mergeSortedMessageIdsOldestFirst({
            existingSortedIds: filtered,
            insertSortedIds: uniqueInsertIds,
            messagesById,
        });
    })();

    if (shouldRecomputeLatestThinking) {
        latestThinkingMessageId = findLatestThinkingMessageId({ idsOldestFirst: nextIds, messagesById });
    }

    if (latestThinkingMessageId == null) {
        latestThinkingMessageActivityAtMs = null;
    } else if (didSeeThinkingTextChange) {
        latestThinkingMessageActivityAtMs = Date.now();
    }

    const latestUsage = existing.reducerState.latestUsage
        ? { ...existing.reducerState.latestUsage }
        : undefined;

    return {
        sessionMessages: {
            ...existing,
            messageIdsOldestFirst: nextIds,
            messagesById,
            messagesMap: messagesById,
            reducerState: existing.reducerState,
            latestThinkingMessageId,
            latestThinkingMessageActivityAtMs,
            messagesVersion: existing.messagesVersion + (processedMessages.length > 0 ? 1 : 0),
        },
        sessionLatestUsage: latestUsage,
        sessionTodos: reducerResult.todos,
    };
}

function createEmptySessionMessages(): SessionMessages {
    const messagesById: Record<string, Message> = {};
    return {
        messageIdsOldestFirst: [],
        messagesById,
        messagesMap: messagesById,
        reducerState: createReducer(),
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        messagesVersion: 0,
        isLoaded: false,
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
            const rawSessionMessages = get().sessionMessages[sessionId];
            if (!rawSessionMessages) {
                return true;
            }
            const sessionMessages = coerceSessionMessages(rawSessionMessages);
            const toolCall = sessionMessages.reducerState.toolIdToMessageId.get(callId);
            if (!toolCall) {
                return true;
            }
            const toolCallMessage = sessionMessages.messagesById[toolCall] ?? sessionMessages.messagesMap[toolCall];
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
                const existingSession = coerceSessionMessages(state.sessionMessages[sessionId]);

                // Get the session's agentState if available
                const session = state.sessions[sessionId];
                const agentState = session?.agentState;

                // Messages are already normalized, no need to process them again
                const normalizedMessages = messages;
                const didSeeThinkingUpdateFromInput = normalizedMessages.some((m) => {
                    if (!m || (m as any).role !== 'agent') return false;
                    const content = (m as any).content;
                    if (!Array.isArray(content)) return false;
                    return content.some((c) => c && (c as any).type === 'thinking');
                });

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
                    const sample = processedMessages.slice(0, 8).map((m) => ({
                        id: m.id,
                        kind: m.kind,
                        seq: normalizeSeq((m as any).seq),
                        createdAt: m.createdAt,
                    }));
                    // eslint-disable-next-line no-console
                    console.log(
                        `[debug] applyMessages ${sessionId}: `
                            + `normalized=${normalizedMessages.length} `
                            + `reducerOut=${processedMessages.length} `
                            + `kinds=${Object.entries(byKind).map(([k, v]) => `${k}:${v}`).join(',') || 'none'}`,
                        { sample }
                    );
                }

                const messagesById = existingSession.messagesById;
                const idsToRemove = new Set<string>();
                const idsToInsert: string[] = [];

                let latestThinkingMessageId = existingSession.latestThinkingMessageId;
                let shouldRecomputeLatestThinking = false;
                let didSeeThinkingTextChange = false;
                let latestThinkingMessageActivityAtMs = existingSession.latestThinkingMessageActivityAtMs ?? null;

                for (const message of processedMessages) {
                    const prev = messagesById[message.id];
                    if (!prev) {
                        idsToInsert.push(message.id);
                    } else {
                        const prevSeq = normalizeSeq((prev as any).seq);
                        const nextSeq = normalizeSeq((message as any).seq);
                        if (prev.createdAt !== message.createdAt || prevSeq !== nextSeq) {
                            idsToRemove.add(message.id);
                            idsToInsert.push(message.id);
                        }
                    }

                    if (message.kind === 'agent-text' && message.isThinking === true) {
                        const prevText = prev && prev.kind === 'agent-text' ? prev.text : null;
                        if (!prev || prev.kind !== 'agent-text' || prev.isThinking !== true || prevText !== message.text) {
                            didSeeThinkingTextChange = true;
                        }
                    }

                    messagesById[message.id] = message;

                    if (message.kind === 'agent-text' && message.isThinking === true) {
                        if (latestThinkingMessageId == null) {
                            latestThinkingMessageId = message.id;
                        } else {
                            const curr = messagesById[latestThinkingMessageId];
                            if (!curr || compareTranscriptMessagesOldestFirst(curr, message) < 0) {
                                latestThinkingMessageId = message.id;
                            }
                        }
                    } else if (latestThinkingMessageId === message.id) {
                        shouldRecomputeLatestThinking = true;
                    }
                }

                let nextIds = (() => {
                    const existingIds = existingSession.messageIdsOldestFirst;
                    if (idsToInsert.length === 0 && idsToRemove.size === 0) return existingIds;

                    const filtered = idsToRemove.size > 0
                        ? existingIds.filter((id) => !idsToRemove.has(id))
                        : existingIds.slice();

                    const uniqueInsertIds = Array.from(new Set(idsToInsert));
                    uniqueInsertIds.sort((a, b) => compareTranscriptMessagesOldestFirst(messagesById[a]!, messagesById[b]!));

                    return mergeSortedMessageIdsOldestFirst({
                        existingSortedIds: filtered,
                        insertSortedIds: uniqueInsertIds,
                        messagesById,
                    });
                })();

                // If we previously surfaced orphan sidechain messages as root transcript entries,
                // remove them once their owning tool-call arrives. Root transcript IDs should not
                // include sidechain children when the owner exists (they are rendered as nested
                // `children` of the owning tool-call message).
                const attachedSidechainChildIds = new Set<string>();
                for (const [sidechainId, chain] of existingSession.reducerState.sidechains.entries()) {
                    if (!existingSession.reducerState.toolIdToMessageId.has(sidechainId)) continue;
                    for (const m of chain) attachedSidechainChildIds.add(m.id);
                }
                if (attachedSidechainChildIds.size > 0) {
                    const pruned = nextIds.filter((id) => !attachedSidechainChildIds.has(id));
                    if (pruned.length !== nextIds.length) {
                        for (const removedId of nextIds) {
                            if (!attachedSidechainChildIds.has(removedId)) continue;
                            delete messagesById[removedId];
                            idsToRemove.add(removedId);
                            if (latestThinkingMessageId === removedId) {
                                shouldRecomputeLatestThinking = true;
                            }
                        }
                        nextIds = pruned;
                    }
                }

                if (shouldRecomputeLatestThinking) {
                    latestThinkingMessageId = findLatestThinkingMessageId({ idsOldestFirst: nextIds, messagesById });
                }

                if (latestThinkingMessageId == null) {
                    latestThinkingMessageActivityAtMs = null;
                } else if (didSeeThinkingUpdateFromInput || didSeeThinkingTextChange) {
                    latestThinkingMessageActivityAtMs = Date.now();
                }

                const inferred = inferLatestUserPermissionModeFromChangedMessages(processedMessages);
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
                            messageIdsOldestFirst: nextIds,
                            messagesById,
                            messagesMap: messagesById,
                            reducerState: existingSession.reducerState, // Explicitly include the mutated reducer state
                            latestThinkingMessageId,
                            latestThinkingMessageActivityAtMs,
                            messagesVersion: existingSession.messagesVersion + (processedMessages.length > 0 ? 1 : 0),
                            isLoaded: true
                        }
                    },
                    sessionPending: updatedSessionPending
                };
            });

            return { changed: Array.from(changed), hasReadyEvent };
        },
        applyMessagesLoaded: (sessionId: string) => set((state) => {
            const rawExistingSession = state.sessionMessages[sessionId];
            const existingSession = rawExistingSession ? coerceSessionMessages(rawExistingSession) : null;

            if (!existingSession) {
                // First time loading - check for AgentState
                const session = state.sessions[sessionId];
                const agentState = session?.agentState;

                // Create new reducer state
                const reducerState = createReducer();

                // Process AgentState if it exists
                const messagesById: Record<string, Message> = {};
                let messageIdsOldestFirst: string[] = [];
                let latestThinkingMessageId: string | null = null;
                let latestThinkingMessageActivityAtMs: number | null = null;
                let messagesVersion = 0;

                if (agentState) {
                    // Process AgentState through reducer to get initial permission messages
                    const reducerResult = reducer(reducerState, [], agentState);
                    const processedMessages = reducerResult.messages;

                    for (const message of processedMessages) {
                        messagesById[message.id] = message;
                    }
                    messageIdsOldestFirst = Object.values(messagesById)
                        .sort(compareTranscriptMessagesOldestFirst)
                        .map((m) => m.id);
                    latestThinkingMessageId = findLatestThinkingMessageId({ idsOldestFirst: messageIdsOldestFirst, messagesById });
                    latestThinkingMessageActivityAtMs = latestThinkingMessageId ? Date.now() : null;
                    if (processedMessages.length > 0) messagesVersion = 1;
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
                            messageIdsOldestFirst,
                            messagesById,
                            messagesMap: messagesById,
                            latestThinkingMessageId,
                            latestThinkingMessageActivityAtMs,
                            messagesVersion,
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
        resetSessionMessages: (sessionId: string) => set((state) => {
            const existingSession = state.sessionMessages[sessionId];
            if (!existingSession) {
                return state;
            }

            const messagesById: Record<string, Message> = {};
            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        messageIdsOldestFirst: [],
                        messagesById,
                        messagesMap: messagesById,
                        reducerState: createReducer(),
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        messagesVersion: 0,
                        isLoaded: false,
                    } satisfies SessionMessages,
                },
            };
        }),
    };
}

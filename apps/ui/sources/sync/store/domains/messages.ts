import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import {
    inferLatestUserPermissionModeIntent,
    readPermissionModeIntentFromMetadata,
} from '@happier-dev/agents';

import { createReducer, reducer, type ReducerState } from '../../reducer/reducer';
import type { Message } from '../../domains/messages/messageTypes';
import type { NormalizedMessage } from '../../typesRaw';
import type { Session } from '../../domains/state/storageTypes';
import { readSessionPresentationCompletedRequests } from '../../domains/session/presentation/readSessionPresentationCompletedRequests';
import {
    loadSessionPermissionModeUpdatedAts,
    loadSessionPermissionModes,
} from '../../domains/state/sessionPersistence';
import { isToolPotentiallyMutableForScm } from '@/sync/domains/tools/toolMutationClassification';
import { syncPerformanceTelemetry } from '../../runtime/syncPerformanceTelemetry';
import { buildSessionListRenderableFromSession, type SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    applyMessageChangeToTranscriptRenderableAggregate,
    buildTranscriptRenderableAggregate,
    canReuseTranscriptRenderableAggregateRequestStates,
    isTranscriptRenderableAggregate,
    type TranscriptRenderableAggregate,
} from '@/sync/domains/session/listing/transcriptRenderableAggregate';
import { areSessionValuesDeepEqual } from './areStoredSessionsEqual';
import { mutateSessionPermissionModeField } from '@/sync/state/mutators';
import { shouldIncludeSubagentSourceMessage } from '@/sync/domains/session/subagents/subagentSourceMessageDetection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    compareTranscriptMessagesOldestFirst,
    hasTranscriptMessageOrderChanged,
    normalizeTranscriptSeq,
} from '@/sync/domains/messages/transcriptOrdering';
import { buildMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import {
    reconcilePersistedSessionMessagePinRouteIds,
} from '@/sync/domains/state/sessionMessagePinsPersistence';
import type {
    SessionMessagePinRole,
} from '@/sync/domains/messages/pins/sessionMessagePinIdentity';
import type {
    SessionMessagePinRouteHydrationFact,
} from '@/sync/domains/messages/pins/sessionMessagePins';
import { shouldPreservePendingProjectionAfterCommittedUserLocalId } from '@/sync/domains/pending/pendingTranscriptProjection';
import { isRecoveredHistoryTranscriptObservation } from '@/sync/domains/messages/transcriptObservationProvenance';
import { clearSessionTranscriptDerivedCachesForSession } from '../../runtime/sessionTranscriptDerivedCaches';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

import { persistSessionPermissionData } from './sessionPermissionPersistence';
import type { SessionPending } from './pending';
import type { StoreGet, StoreSet } from './_shared';
import { finalizeSessionListIndexUpdate } from './sessionListIndexFinalization';
import { resolveSessionListRenderableChangeImpact } from './sessionListRenderableChange';

export type SessionMessages = {
    messageIdsOldestFirst: string[];
    messagesById: Record<string, Message>;
    messageRevisionsById?: Record<string, number>;
    // Back-compat alias for older call sites (do not use in new code).
    messagesMap: Record<string, Message>;
    /**
     * IMPORTANT ARCHITECTURE NOTE:
     * `messagesById` AND `messageRevisionsById` are intentionally mutated
     * in-place for streaming performance.
     *
     * As a result:
     * - Do NOT rely on their referential identity changes to detect updates.
     * - Prefer id-based subscriptions (`useMessage(sessionId, messageId)`) or
     *   selectors keyed on stable primitives (ids/version counters).
     */
    /**
     * Incrementally-maintained transcript aggregates backing the session-list
     * renderable refresh (O(changed) per apply instead of a full transcript
     * walk). Mutated in place like `reducerState`; `undefined` when
     * invalidated — rebuilt lazily at the next renderable refresh.
     */
    renderableAggregate?: TranscriptRenderableAggregate;
    reducerState: ReducerState;
    /**
     * `reducerState` is mutated in-place for performance.
     * Use this version counter to subscribe to reducer-only changes.
     */
    reducerVersion?: number;
    latestThinkingMessageId: string | null;
    latestThinkingMessageActivityAtMs: number | null;
    latestReadyEventSeq?: number | null;
    latestReadyEventAt?: number | null;
    messagesVersion: number;
    subagentSourceVersion?: number;
    lastAppliedAgentStateVersion?: number | null;
    isLoaded: boolean;
};

export type MessagesDomain = {
    sessionMessages: Record<string, SessionMessages>;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
    applyMessages: (
        sessionId: string,
        messages: NormalizedMessage[],
    ) => {
        changed: string[];
        hasReadyEvent: boolean;
        latestReadyEventSeq?: number;
        latestReadyEventAt?: number;
    };
    applyMessagesLoaded: (sessionId: string) => void;
    evictSessionMessages: (sessionId: string) => void;
    resetSessionMessages: (sessionId: string) => void;
};

type MessagesDomainDependencies = {
    sessions: Record<string, Session>;
    sessionLocalStateScope?: ServerAccountScope | null;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    sessionListRowStateByServerId: Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;
    sessionListIndexByServerId: Readonly<Record<string, import('../../domains/sessionList/sessionListIndex').SessionListIndexItem[] | null | undefined>>;
    concurrentSessionListCacheByServerId: import('../../domains/session/listing/concurrentSessionListCache').ConcurrentSessionListCacheByServerId;
    machines: Record<string, import('../../domains/state/storageTypes').Machine>;
    machineDisplayById: Record<string, import('../../domains/machines/machineDisplayRenderable').MachineDisplayRenderable>;
    profile: { id?: string | null } | null;
    settings: {
        groupInactiveSessionsByProject?: boolean;
        sessionListActiveGroupingV1?: 'project' | 'date';
        sessionListInactiveGroupingV1?: 'project' | 'date';
        sessionListSectionModeV1?: 'activity' | 'single';
    };
    getProjectForSession?: (sessionId: string) => import('../../runtime/orchestration/projectManager').Project | null;
    sessionPending: Record<string, SessionPending>;
};

function mergeLatestNumber(existing: number | null | undefined, incoming: number | null | undefined): number | null {
    if (typeof incoming !== 'number' || !Number.isFinite(incoming)) {
        return typeof existing === 'number' && Number.isFinite(existing) ? Math.trunc(existing) : null;
    }
    const normalizedIncoming = Math.trunc(incoming);
    return typeof existing === 'number' && Number.isFinite(existing)
        ? Math.max(Math.trunc(existing), normalizedIncoming)
        : normalizedIncoming;
}

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

function appendSortedMessageIdsOldestFirst(params: Readonly<{
    existingSortedIds: readonly string[];
    insertSortedIds: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): string[] | null {
    if (params.insertSortedIds.length === 0) return params.existingSortedIds as string[];
    if (params.existingSortedIds.length === 0) return params.insertSortedIds.slice();

    const lastExistingId = params.existingSortedIds[params.existingSortedIds.length - 1];
    const firstInsertId = params.insertSortedIds[0];
    if (!lastExistingId || !firstInsertId) return null;

    const lastExisting = params.messagesById[lastExistingId];
    const firstInsert = params.messagesById[firstInsertId];
    if (!lastExisting || !firstInsert) return null;

    if (compareTranscriptMessagesOldestFirst(lastExisting, firstInsert) <= 0) {
        return [...params.existingSortedIds, ...params.insertSortedIds];
    }

    return null;
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
    // In-place mutation contract (see SessionMessages): reuse the record.
    const messageRevisionsById: Record<string, number> =
        raw?.messageRevisionsById && typeof raw.messageRevisionsById === 'object'
            ? (raw.messageRevisionsById as Record<string, number>)
            : {};
    const renderableAggregate: TranscriptRenderableAggregate | undefined =
        isTranscriptRenderableAggregate(raw?.renderableAggregate)
            ? raw.renderableAggregate
            : undefined;

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
    const latestReadyEventSeq: number | null =
        typeof raw?.latestReadyEventSeq === 'number' && Number.isFinite(raw.latestReadyEventSeq)
            ? Math.trunc(raw.latestReadyEventSeq)
            : null;
    const latestReadyEventAt: number | null =
        typeof raw?.latestReadyEventAt === 'number' && Number.isFinite(raw.latestReadyEventAt)
            ? raw.latestReadyEventAt
            : null;

    const messagesVersion: number =
        typeof raw?.messagesVersion === 'number' && Number.isFinite(raw.messagesVersion)
            ? Math.trunc(raw.messagesVersion)
            : 0;
    const subagentSourceVersion: number =
        typeof raw?.subagentSourceVersion === 'number' && Number.isFinite(raw.subagentSourceVersion)
            ? Math.trunc(raw.subagentSourceVersion)
            : messagesVersion;

    const lastAppliedAgentStateVersion: number | null =
        typeof raw?.lastAppliedAgentStateVersion === 'number' && Number.isFinite(raw.lastAppliedAgentStateVersion)
            ? Math.trunc(raw.lastAppliedAgentStateVersion)
            : null;

    const isLoaded = raw?.isLoaded === true;

    return {
        messageIdsOldestFirst,
        messagesById,
        messageRevisionsById,
        messagesMap: messagesById,
        renderableAggregate,
        reducerState,
        latestThinkingMessageId,
        latestThinkingMessageActivityAtMs,
        latestReadyEventSeq,
        latestReadyEventAt,
        messagesVersion,
        subagentSourceVersion,
        lastAppliedAgentStateVersion,
        isLoaded,
    };
}

function inferLatestUserPermissionModeFromChangedMessages(
    messages: ReadonlyArray<Message>,
): { mode: PermissionMode; updatedAt: number } | null {
    const inferred = inferLatestUserPermissionModeIntent(
        messages.filter((message) => !isRecoveredHistoryTranscriptObservation(message)),
    );
    return inferred ? { mode: inferred.permissionMode as PermissionMode, updatedAt: inferred.updatedAt } : null;
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
        if (isRecoveredHistoryTranscriptObservation(message)) continue;
        if (message.kind !== 'agent-text') continue;
        if (message.isThinking === true) return message.id;
    }
    return null;
}

function deriveLatestCommittedMessageSeq(messages: ReadonlyArray<Message>): number | null {
    let latest: number | null = null;
    for (const message of messages) {
        const seq = normalizeTranscriptSeq((message as { seq?: unknown }).seq);
        if (seq === null) continue;
        latest = latest === null ? seq : Math.max(latest, seq);
    }
    return latest;
}

function resolvePinRoleForMessage(message: Message): SessionMessagePinRole | null {
    if (message.kind === 'user-text') return 'user';
    if (message.kind === 'agent-text') return 'assistant';
    if (message.kind === 'tool-call') return 'tool';
    return null;
}

function buildPinRouteHydrationFacts(messages: ReadonlyArray<Message>): readonly SessionMessagePinRouteHydrationFact[] {
    const facts: SessionMessagePinRouteHydrationFact[] = [];
    for (const message of messages) {
        const role = resolvePinRoleForMessage(message);
        if (!role) continue;
        const candidateLocalId = (message as { localId?: unknown }).localId;
        const localId = typeof candidateLocalId === 'string' && candidateLocalId.trim().length > 0
            ? candidateLocalId
            : '';
        const previousRouteMessageIds = localId ? [`local:${localId}`] : [];
        facts.push({
            seq: normalizeTranscriptSeq((message as { seq?: unknown }).seq),
            transcriptBlockIndex: (message as { transcriptBlockIndex?: number | null }).transcriptBlockIndex ?? null,
            routeMessageId: buildMessageRouteId(message),
            previousRouteMessageIds,
            role,
        });
    }
    return facts;
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
    const messageRevisionsById = existing.messageRevisionsById ?? {};
    const idsToRemove = new Set<string>();
    const idsToInsert: string[] = [];

    let latestThinkingMessageId = existing.latestThinkingMessageId;
    let shouldRecomputeLatestThinking = false;
    let didSeeThinkingTextChange = false;
    let latestThinkingMessageActivityAtMs = existing.latestThinkingMessageActivityAtMs ?? null;
    let didSubagentSourceChange = false;

    for (const message of processedMessages) {
        const prev = messagesById[message.id];
        if ((prev && shouldIncludeSubagentSourceMessage(prev)) || shouldIncludeSubagentSourceMessage(message)) {
            didSubagentSourceChange = true;
        }
        if (!prev) {
            idsToInsert.push(message.id);
        } else if (hasTranscriptMessageOrderChanged(prev, message)) {
            idsToRemove.add(message.id);
            idsToInsert.push(message.id);
        }

        if (message.kind === 'agent-text' && message.isThinking === true) {
            const prevText = prev && prev.kind === 'agent-text' ? prev.text : null;
            if (!prev || prev.kind !== 'agent-text' || prev.isThinking !== true || prevText !== message.text) {
                didSeeThinkingTextChange = true;
            }
        }

        messagesById[message.id] = message;
        messageRevisionsById[message.id] = (messageRevisionsById[message.id] ?? 0) + 1;

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

    const didMessageChange = processedMessages.length > 0 || reducerResult.reducerStateChanged === true;
    const didThinkingMetadataChange =
        latestThinkingMessageId !== existing.latestThinkingMessageId
        || latestThinkingMessageActivityAtMs !== (existing.latestThinkingMessageActivityAtMs ?? null);

    if (!didMessageChange && !didThinkingMetadataChange) {
        return {
            sessionMessages: existing,
            sessionLatestUsage: latestUsage,
            sessionTodos: reducerResult.todos,
        };
    }

    return {
        sessionMessages: {
            ...existing,
            messageIdsOldestFirst: nextIds,
            messagesById,
            messageRevisionsById,
            messagesMap: messagesById,
            // This reconcile path bypasses the incremental aggregate
            // maintenance, so a stored aggregate must be rebuilt on next use.
            renderableAggregate: processedMessages.length > 0 ? undefined : existing.renderableAggregate,
            reducerState: existing.reducerState,
            reducerVersion: (existing.reducerVersion ?? 0) + 1,
            latestThinkingMessageId,
            latestThinkingMessageActivityAtMs,
            messagesVersion: existing.messagesVersion + (processedMessages.length > 0 ? 1 : 0),
            subagentSourceVersion: (existing.subagentSourceVersion ?? existing.messagesVersion) + (didSubagentSourceChange ? 1 : 0),
            lastAppliedAgentStateVersion: existing.lastAppliedAgentStateVersion,
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
        messageRevisionsById: {},
        messagesMap: messagesById,
        reducerState: createReducer(),
        reducerVersion: 0,
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        messagesVersion: 0,
        subagentSourceVersion: 0,
        lastAppliedAgentStateVersion: null,
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
            return toolCallMessage.tool?.name ? isToolPotentiallyMutableForScm(toolCallMessage.tool?.name) : true;
        },
        applyMessages: (sessionId: string, messages: NormalizedMessage[]) => {
            const telemetryFields: Record<string, number> = { messages: messages.length };
            return syncPerformanceTelemetry.measure(
                'sync.store.messages.apply',
                telemetryFields,
                () => {
            let changed = new Set<string>();
            let hasReadyEvent = false;
            let latestReadyEventSeq: number | null = null;
            let latestReadyEventAt: number | null = null;
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
                const agentStateVersion =
                    typeof session?.agentStateVersion === 'number' && Number.isFinite(session.agentStateVersion)
                        ? Math.trunc(session.agentStateVersion)
                        : null;
                const shouldApplyAgentState = agentState != null && (
                    messages.length > 0
                    || agentStateVersion === null
                    || existingSession.lastAppliedAgentStateVersion !== agentStateVersion
                );
                telemetryFields.agentStateApplied = shouldApplyAgentState ? 1 : 0;
                if (messages.length === 0 && !shouldApplyAgentState) {
                    telemetryFields.processed = 0;
                    telemetryFields.changed = 0;
                    telemetryFields.noop = 1;
                    telemetryFields.stateChanged = 0;
                    return state;
                }

                // Messages are already normalized, no need to process them again
                const normalizedMessages = messages;
                const didSeeThinkingUpdateFromInput = normalizedMessages.some((m) => {
                    if (isRecoveredHistoryTranscriptObservation(m)) return false;
                    if (!m || (m as any).role !== 'agent') return false;
                    const content = (m as any).content;
                    if (!Array.isArray(content)) return false;
                    return content.some((c) => c && (c as any).type === 'thinking');
                });

                // Run reducer with agentState
                const reducerResult = syncPerformanceTelemetry.measure(
                    'sync.store.messages.reducer',
                    {
                        messages: normalizedMessages.length,
                        agentStateApplied: shouldApplyAgentState ? 1 : 0,
                    },
                    () => reducer(
                        existingSession.reducerState,
                        normalizedMessages,
                        shouldApplyAgentState ? agentState : null,
                    ),
                );
                const processedMessages = reducerResult.messages;
                telemetryFields.processed = processedMessages.length;
                telemetryFields.reducerStateChanged = reducerResult.reducerStateChanged === true ? 1 : 0;
                if (processedMessages.length > 0) {
                    reconcilePersistedSessionMessagePinRouteIds(
                        sessionId,
                        buildPinRouteHydrationFacts(processedMessages),
                        state.sessionLocalStateScope ?? null,
                    );
                }
                for (let message of processedMessages) {
                    changed.add(message.id);
                }
                if (reducerResult.hasReadyEvent) {
                    hasReadyEvent = true;
                    latestReadyEventSeq = mergeLatestNumber(latestReadyEventSeq, reducerResult.latestReadyEventSeq ?? null);
                    latestReadyEventAt = mergeLatestNumber(latestReadyEventAt, reducerResult.latestReadyEventAt ?? null);
                }

                if (DEBUG_MESSAGE_DECRYPT) {
                    const byKind: Record<string, number> = {};
                    for (const m of processedMessages) {
                        byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
                    }
                    const sample = processedMessages.slice(0, 8).map((m) => ({
                        id: m.id,
                        kind: m.kind,
                        seq: normalizeTranscriptSeq((m as any).seq),
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
                const messageRevisionsById = existingSession.messageRevisionsById ?? {};
                const idsToRemove = new Set<string>();
                const idsToInsert: string[] = [];

                let latestThinkingMessageId = existingSession.latestThinkingMessageId;
                let shouldRecomputeLatestThinking = false;
                let didSeeThinkingTextChange = false;
                let latestThinkingMessageActivityAtMs = existingSession.latestThinkingMessageActivityAtMs ?? null;
                let didSubagentSourceChange = false;
                // Incremental transcript aggregates (O(changed) instead of a
                // full transcript walk per apply). Invalidated when a change
                // is non-monotone; rebuilt lazily at the renderable refresh.
                let renderableAggregate = existingSession.renderableAggregate;

                for (const message of processedMessages) {
                    const prev = messagesById[message.id];
                    if (renderableAggregate) {
                        const appliedToAggregate = applyMessageChangeToTranscriptRenderableAggregate({
                            aggregate: renderableAggregate,
                            previous: prev ?? null,
                            next: message,
                        });
                        if (!appliedToAggregate) {
                            renderableAggregate = undefined;
                        }
                    }
                    if ((prev && shouldIncludeSubagentSourceMessage(prev)) || shouldIncludeSubagentSourceMessage(message)) {
                        didSubagentSourceChange = true;
                    }
                    if (!prev) {
                        idsToInsert.push(message.id);
                    } else if (hasTranscriptMessageOrderChanged(prev, message)) {
                        idsToRemove.add(message.id);
                        idsToInsert.push(message.id);
                    }

                    if (
                        !isRecoveredHistoryTranscriptObservation(message)
                        && message.kind === 'agent-text'
                        && message.isThinking === true
                    ) {
                        const prevText = prev && prev.kind === 'agent-text' ? prev.text : null;
                        if (!prev || prev.kind !== 'agent-text' || prev.isThinking !== true || prevText !== message.text) {
                            didSeeThinkingTextChange = true;
                        }
                    }

                    messagesById[message.id] = message;
                    messageRevisionsById[message.id] = (messageRevisionsById[message.id] ?? 0) + 1;

                    if (
                        !isRecoveredHistoryTranscriptObservation(message)
                        && message.kind === 'agent-text'
                        && message.isThinking === true
                    ) {
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

                const indexTelemetryFields: Record<string, number> = {
                    processed: processedMessages.length,
                    insertedOrMoved: idsToInsert.length,
                    removedForReorder: idsToRemove.size,
                };
                let nextIds = syncPerformanceTelemetry.measure(
                    'sync.store.messages.index',
                    indexTelemetryFields,
                    () => {
                    const existingIds = existingSession.messageIdsOldestFirst;
                    if (idsToInsert.length === 0 && idsToRemove.size === 0) {
                        indexTelemetryFields.idsChanged = 0;
                        indexTelemetryFields.uniqueInsertedOrMoved = 0;
                        return existingIds;
                    }

                    const filtered = idsToRemove.size > 0
                        ? existingIds.filter((id) => !idsToRemove.has(id))
                        : existingIds.slice();

                    const uniqueInsertIds = Array.from(new Set(idsToInsert));
                    uniqueInsertIds.sort((a, b) => compareTranscriptMessagesOldestFirst(messagesById[a]!, messagesById[b]!));
                    indexTelemetryFields.idsChanged = 1;
                    indexTelemetryFields.uniqueInsertedOrMoved = uniqueInsertIds.length;

                    if (idsToRemove.size === 0) {
                        const appended = appendSortedMessageIdsOldestFirst({
                            existingSortedIds: existingIds,
                            insertSortedIds: uniqueInsertIds,
                            messagesById,
                        });
                        if (appended) {
                            indexTelemetryFields.appendOnly = 1;
                            return appended;
                        }
                    }
                    indexTelemetryFields.appendOnly = 0;

                    return mergeSortedMessageIdsOldestFirst({
                        existingSortedIds: filtered,
                        insertSortedIds: uniqueInsertIds,
                        messagesById,
                    });
                    },
                );
                telemetryFields.insertedOrMoved = indexTelemetryFields.insertedOrMoved ?? 0;
                telemetryFields.removedForReorder = indexTelemetryFields.removedForReorder ?? 0;
                telemetryFields.uniqueInsertedOrMoved = indexTelemetryFields.uniqueInsertedOrMoved ?? 0;
                telemetryFields.idsChanged = indexTelemetryFields.idsChanged ?? 0;

                if (shouldRecomputeLatestThinking) {
                    latestThinkingMessageId = findLatestThinkingMessageId({ idsOldestFirst: nextIds, messagesById });
                }

                if (latestThinkingMessageId == null) {
                    latestThinkingMessageActivityAtMs = null;
                } else if (didSeeThinkingUpdateFromInput || didSeeThinkingTextChange) {
                    latestThinkingMessageActivityAtMs = Date.now();
                }
                const didThinkingMetadataChange =
                    latestThinkingMessageId !== existingSession.latestThinkingMessageId
                    || latestThinkingMessageActivityAtMs !== (existingSession.latestThinkingMessageActivityAtMs ?? null);
                telemetryFields.thinkingMetadataChanged = didThinkingMetadataChange ? 1 : 0;

                const inferred = inferLatestUserPermissionModeFromChangedMessages(processedMessages);
                const inferredPermissionMode = inferred?.mode ?? null;
                const inferredPermissionModeAt = inferred?.updatedAt ?? null;

                // Under claim-until-accept, local optimistic pending projections can be cleared
                // by a committed same-localId user message. Server-owned pending rows remain
                // visible until the server pending state resolves them.
                let updatedSessionPending = state.sessionPending;
                const pendingState = state.sessionPending[sessionId];
                if (pendingState && pendingState.messages.length > 0) {
                    const localIdsToClear = new Set<string>();
                    for (const m of processedMessages) {
                        if (
                            !isRecoveredHistoryTranscriptObservation(m)
                            && m.kind === 'user-text'
                            && m.localId
                        ) {
                            localIdsToClear.add(m.localId);
                        }
                    }
                    if (localIdsToClear.size > 0) {
                        const filtered = pendingState.messages.filter((p) => (
                            !p.localId
                            || !localIdsToClear.has(p.localId)
                            || shouldPreservePendingProjectionAfterCommittedUserLocalId(p)
                        ));
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
                let updatedSessionListRenderables = state.sessionListRenderables;
                let needsSessionListIndexRebuild = false;
                let didAnyImmediateWarmCacheRelevantRenderableChange = false;
                const latestCommittedMessageSeq = deriveLatestCommittedMessageSeq(processedMessages);
                const nextLatestReadyEventSeq = mergeLatestNumber(
                    existingSession.latestReadyEventSeq,
                    reducerResult.latestReadyEventSeq ?? null,
                );
                const nextLatestReadyEventAt = mergeLatestNumber(
                    existingSession.latestReadyEventAt,
                    reducerResult.latestReadyEventAt ?? null,
                );
                const didReadyMetadataChange =
                    nextLatestReadyEventSeq !== existingSession.latestReadyEventSeq
                    || nextLatestReadyEventAt !== existingSession.latestReadyEventAt;
                const currentSessionSeq = normalizeTranscriptSeq(session?.seq) ?? 0;
                const shouldAdvanceSessionSeq =
                    session != null
                    && latestCommittedMessageSeq !== null
                    && latestCommittedMessageSeq > currentSessionSeq;
                // Only produce a new Session identity when a session-visible
                // value actually changed. The reducer surfaces `todos` and
                // holds `latestUsage` on every apply, so presence alone must
                // not churn every `useSession` subscriber at streaming rate.
                const reducerLatestUsage = existingSession.reducerState.latestUsage ?? null;
                const didLatestUsageChange =
                    session != null
                    && reducerLatestUsage !== null
                    && !areSessionValuesDeepEqual(session.latestUsage ?? null, reducerLatestUsage);
                const didTodosChange =
                    session != null
                    && reducerResult.todos !== undefined
                    && session.todos !== reducerResult.todos
                    && !areSessionValuesDeepEqual(session.todos ?? null, reducerResult.todos);
                const needsUpdate = didTodosChange || didLatestUsageChange;
                const didApplyNewAgentStateVersion =
                    shouldApplyAgentState
                    && agentStateVersion !== null
                    && existingSession.lastAppliedAgentStateVersion !== agentStateVersion;

                const canInferPermissionMode = Boolean(
                    session &&
                    inferredPermissionMode &&
                    inferredPermissionModeAt &&
                    // If the session has a canonical permission mode in metadata, that is the source of truth.
                    // Message-level permissionMode is per-turn and must not rewrite the session's stored mode.
                    !readPermissionModeIntentFromMetadata((readSessionOwnerMetadataView(session) ?? {}) as any) &&
                    // NOTE: inferredPermissionModeAt comes from message.createdAt (server timestamp for remote messages,
                    // and best-effort server-aligned timestamp for locally-created optimistic messages).
                    // permissionModeUpdatedAt is stamped using nowServerMs() for clock-safe ordering across devices.
                    inferredPermissionModeAt > (session.permissionModeUpdatedAt ?? 0)
                );

                const shouldWritePermissionMode =
                    canInferPermissionMode &&
                    (session!.permissionMode ?? 'default') !== inferredPermissionMode;
                let nextSessionForRenderable = session ?? null;

                if (needsUpdate || shouldWritePermissionMode || shouldAdvanceSessionSeq || (session && didReadyMetadataChange)) {
                    const baseSession: Session = {
                        ...session,
                        ...(shouldAdvanceSessionSeq && { seq: latestCommittedMessageSeq }),
                        ...(didReadyMetadataChange && {
                            latestReadyEventSeq: nextLatestReadyEventSeq,
                            latestReadyEventAt: nextLatestReadyEventAt,
                        }),
                        ...(didTodosChange && { todos: reducerResult.todos }),
                        // Copy latestUsage from the mutable reducerState only when
                        // its value actually changed, so the Session identity (and
                        // every useSession subscriber) stays stable per tick.
                        ...(didLatestUsageChange && reducerLatestUsage
                            ? { latestUsage: { ...reducerLatestUsage } }
                            : {}),
                    };
                    const nextSession = shouldWritePermissionMode
                        ? mutateSessionPermissionModeField({
                            session: baseSession,
                            mode: inferredPermissionMode ?? 'default',
                            updatedAt: inferredPermissionModeAt ?? 0,
                        })
                        : baseSession;

                    updatedSessions = {
                        ...state.sessions,
                        [sessionId]: nextSession
                    };
                    nextSessionForRenderable = nextSession;

                    // Persist timestamped permission modes inferred from session messages so they load instantly on app restart.
                    if (shouldWritePermissionMode) {
                        const sessionLocalStateScope = state.sessionLocalStateScope ?? null;
                        persistSessionPermissionData(updatedSessions, sessionLocalStateScope, {
                            modes: loadSessionPermissionModes(sessionLocalStateScope),
                            updatedAts: loadSessionPermissionModeUpdatedAts(sessionLocalStateScope),
                        });
                    }
                }

                const previousRenderable = state.sessionListRenderables?.[sessionId];
                const shouldRefreshSessionListRenderable = Boolean(
                    previousRenderable
                    && nextSessionForRenderable
                    && (
                        shouldAdvanceSessionSeq
                        || didReadyMetadataChange
                        || didApplyNewAgentStateVersion
                        || processedMessages.length > 0
                        || reducerResult.reducerStateChanged === true
                    ),
                );
                if (previousRenderable && nextSessionForRenderable && shouldRefreshSessionListRenderable) {
                    const renderableCompletedRequests =
                        readSessionPresentationCompletedRequests(nextSessionForRenderable);
                    const canReuseAggregate =
                        renderableAggregate != null
                        && canReuseTranscriptRenderableAggregateRequestStates(renderableAggregate, renderableCompletedRequests);
                    telemetryFields.aggregateReused = canReuseAggregate ? 1 : 0;
                    if (!canReuseAggregate) {
                        // Cold start / fallback: one full transcript walk, then
                        // the aggregate is maintained incrementally.
                        const renderableMessages = nextIds
                            .map((id) => messagesById[id])
                            .filter((message): message is Message => Boolean(message));
                        renderableAggregate = buildTranscriptRenderableAggregate({
                            messages: renderableMessages,
                            completedRequests: renderableCompletedRequests,
                        });
                    }
                    const nextRenderable = buildSessionListRenderableFromSession(
                        nextSessionForRenderable,
                        previousRenderable,
                        undefined,
                        renderableAggregate,
                    );
                    if (nextRenderable !== previousRenderable) {
                        const renderableChangeImpact = resolveSessionListRenderableChangeImpact(previousRenderable, nextRenderable, {
                            sessionListIndexSettings: {
                                groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
                                activeGroupingV1: state.settings.sessionListActiveGroupingV1,
                                inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
                                sectionModeV1: state.settings.sessionListSectionModeV1,
                            },
                        });
                        needsSessionListIndexRebuild = needsSessionListIndexRebuild || renderableChangeImpact.needsSessionListIndexRebuild;
                        didAnyImmediateWarmCacheRelevantRenderableChange =
                            didAnyImmediateWarmCacheRelevantRenderableChange
                            || renderableChangeImpact.didWarmCacheRelevantRenderableChange;
                        updatedSessionListRenderables = {
                            ...updatedSessionListRenderables,
                            [sessionId]: nextRenderable,
                        };
                    }
                }

                const didSessionMessagesChange =
                    processedMessages.length > 0
                    || reducerResult.reducerStateChanged === true
                    || didThinkingMetadataChange
                    || didReadyMetadataChange
                    || didApplyNewAgentStateVersion;
                telemetryFields.agentStateVersionChanged = didApplyNewAgentStateVersion ? 1 : 0;
                telemetryFields.messageStateChanged = didSessionMessagesChange ? 1 : 0;
                telemetryFields.sessionChanged = updatedSessions === state.sessions ? 0 : 1;
                telemetryFields.renderableChanged = updatedSessionListRenderables === state.sessionListRenderables ? 0 : 1;
                telemetryFields.pendingChanged = updatedSessionPending === state.sessionPending ? 0 : 1;
                if (
                    !didSessionMessagesChange
                    && updatedSessions === state.sessions
                    && updatedSessionListRenderables === state.sessionListRenderables
                    && updatedSessionPending === state.sessionPending
                ) {
                    telemetryFields.noop = 1;
                    telemetryFields.stateChanged = 0;
                    return state;
                }
                telemetryFields.noop = 0;
                telemetryFields.stateChanged = 1;

                const nextStateBase = {
                    ...state,
                    sessions: updatedSessions,
                    sessionListRenderables: updatedSessionListRenderables,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            ...existingSession,
                            messageIdsOldestFirst: nextIds,
                            messagesById,
                            messageRevisionsById,
                            messagesMap: messagesById,
                            renderableAggregate,
                            reducerState: existingSession.reducerState, // Explicitly include the mutated reducer state
                            reducerVersion: (existingSession.reducerVersion ?? 0) + 1,
                            latestThinkingMessageId,
                            latestThinkingMessageActivityAtMs,
                            latestReadyEventSeq: nextLatestReadyEventSeq,
                            latestReadyEventAt: nextLatestReadyEventAt,
                            messagesVersion: existingSession.messagesVersion + (processedMessages.length > 0 ? 1 : 0),
                            subagentSourceVersion: (existingSession.subagentSourceVersion ?? existingSession.messagesVersion) + (didSubagentSourceChange ? 1 : 0),
                            lastAppliedAgentStateVersion: shouldApplyAgentState
                                ? agentStateVersion
                                : existingSession.lastAppliedAgentStateVersion,
                            isLoaded: existingSession.isLoaded
                        }
                    },
                    sessionPending: updatedSessionPending
                };
                if (updatedSessionListRenderables === state.sessionListRenderables) {
                    return nextStateBase;
                }
                return finalizeSessionListIndexUpdate(
                    state,
                    nextStateBase,
                    needsSessionListIndexRebuild,
                    didAnyImmediateWarmCacheRelevantRenderableChange,
                    false,
                    undefined,
                    undefined,
                    {
                        changedSessionIds: [sessionId],
                        removedSessionIds: [],
                    },
                );
            });

                telemetryFields.changed = changed.size;
                return {
                    changed: Array.from(changed),
                    hasReadyEvent,
                    ...(latestReadyEventSeq !== null && { latestReadyEventSeq }),
                    ...(latestReadyEventAt !== null && { latestReadyEventAt }),
                };
                },
            );
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
                const messageRevisionsById: Record<string, number> = {};
                let messageIdsOldestFirst: string[] = [];
                let latestThinkingMessageId: string | null = null;
                let latestThinkingMessageActivityAtMs: number | null = null;
                let latestReadyEventSeq: number | null = null;
                let latestReadyEventAt: number | null = null;
                let messagesVersion = 0;
                let subagentSourceVersion = 0;

                if (agentState) {
                    // Process AgentState through reducer to get initial permission messages
                    const reducerResult = reducer(reducerState, [], agentState);
                    const processedMessages = reducerResult.messages;

                    for (const message of processedMessages) {
                        messagesById[message.id] = message;
                        messageRevisionsById[message.id] = 1;
                    }
                    messageIdsOldestFirst = Object.values(messagesById)
                        .sort(compareTranscriptMessagesOldestFirst)
                        .map((m) => m.id);
                    latestThinkingMessageId = findLatestThinkingMessageId({ idsOldestFirst: messageIdsOldestFirst, messagesById });
                    latestThinkingMessageActivityAtMs = latestThinkingMessageId ? Date.now() : null;
                    if (processedMessages.length > 0) messagesVersion = 1;
                    if (processedMessages.some(shouldIncludeSubagentSourceMessage)) subagentSourceVersion = 1;
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
                            reducerVersion: agentState ? 1 : 0,
                            messageIdsOldestFirst,
                            messagesById,
                            messageRevisionsById,
                            messagesMap: messagesById,
                            latestThinkingMessageId,
                            latestThinkingMessageActivityAtMs,
                            latestReadyEventSeq,
                            latestReadyEventAt,
                            messagesVersion,
                            subagentSourceVersion,
                            lastAppliedAgentStateVersion:
                                typeof session?.agentStateVersion === 'number' && Number.isFinite(session.agentStateVersion)
                                    ? Math.trunc(session.agentStateVersion)
                                    : null,
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
        evictSessionMessages: (sessionId: string) => set((state) => {
            const existingSession = state.sessionMessages[sessionId];
            if (!existingSession) {
                return state;
            }

            // Bounded transcript retention: drop the whole materialized transcript
            // (messages, reducer state, renderable aggregate). Re-opening the session
            // re-runs the first-open load pipeline because the entry — and with it the
            // `isLoaded` flag — no longer exists. Unlike `resetSessionMessages` (which
            // keeps an empty entry for in-place truncation under a mounted view), this
            // is only safe when no mounted surface renders the transcript; the caller
            // (sessionTranscriptRetention) enforces that.
            const { [sessionId]: _evicted, ...remainingSessionMessages } = state.sessionMessages;
            clearSessionTranscriptDerivedCachesForSession(sessionId);
            return {
                ...state,
                sessionMessages: remainingSessionMessages,
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
                        messageRevisionsById: {},
                        messagesMap: messagesById,
                        reducerState: createReducer(),
                        reducerVersion: 0,
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 0,
                        subagentSourceVersion: 0,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: false,
                    } satisfies SessionMessages,
                },
            };
        }),
    };
}

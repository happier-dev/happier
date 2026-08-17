import type { NormalizedMessage, RawMessageNormalizationSequenceState } from '@/sync/typesRaw';
import { normalizeRawMessage, normalizeRawMessageInSequence } from '@/sync/typesRaw';
import { computeNextSessionSeqFromUpdate } from '@/sync/domains/session/sequence/realtimeSessionSeq';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import { markStreamingMessagesAppliedForSessionUiTelemetry } from '@/sync/runtime/performance/sessionUiTelemetry';
import { recordRealtimeFanoutSocketMessageRoute } from '@/sync/runtime/performance/realtimeFanoutTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    storedSessionMessageAttentionImpact,
    storedSessionMessageAttentionImpactOrNull,
} from '@/sync/domains/messages/messageUserAttention';
import type {
    SessionRealtimeProjectionCandidate,
    SessionRealtimeProjectionMode,
} from '@/sync/domains/session/realtime/sessionRealtimeRouting';
import { decideDurableSessionRealtimeRoute } from '@/sync/domains/session/realtime/sessionRealtimeRouting';
import { getTaskLifecycleEventFromRawContent, type TaskLifecycleEvent } from './taskLifecycle';
import { isLegacyMemoryArtifactTranscriptRow } from './legacyMemoryArtifactTranscriptRows';
import {
    advanceSessionReceivedMessageCurrentness,
    isSessionMessageRowCurrent,
    type SessionReceivedMessages,
} from './sessionMessageCurrentness';
import {
    applyTranscriptObservationMetadata,
    isRecoveredHistoryTranscriptObservation,
} from '@/sync/domains/messages/transcriptObservationProvenance';

type SessionMessageEncryption = {
    decryptMessage: (message: any) => Promise<any>;
};

type SocketMessageTelemetryFields = Readonly<{
    encrypted: number;
    plain: number;
    newMessage: number;
    messageUpdated: number;
    sessionKnown: number;
    activeViewingSession: number;
    backgroundSession: number;
    messagesLoaded: number;
}>;

function buildSocketMessageTelemetryFields(params: Readonly<{
    message: any;
    inferLifecycle: boolean;
    session: Session | undefined;
    isSessionActivelyViewed: boolean;
    isSessionMessagesLoaded: boolean;
}>): SocketMessageTelemetryFields | undefined {
    if (!syncPerformanceTelemetry.isEnabled()) return undefined;
    return {
        encrypted: params.message?.content?.t === 'encrypted' ? 1 : 0,
        plain: params.message?.content?.t === 'plain' ? 1 : 0,
        newMessage: params.inferLifecycle ? 1 : 0,
        messageUpdated: params.inferLifecycle ? 0 : 1,
        sessionKnown: params.session ? 1 : 0,
        activeViewingSession: params.isSessionActivelyViewed ? 1 : 0,
        backgroundSession: params.isSessionActivelyViewed ? 0 : 1,
        messagesLoaded: params.isSessionMessagesLoaded ? 1 : 0,
    };
}

function inferTaskLifecycleFromMessageContent(content: unknown, createdAt: number): {
    isTaskComplete: boolean;
    isTaskStarted: boolean;
    lifecycleEvent: TaskLifecycleEvent | null;
} {
    const lifecycleEvent = getTaskLifecycleEventFromRawContent(content, createdAt);
    const isTaskComplete =
        lifecycleEvent?.type === 'task_complete'
        || lifecycleEvent?.type === 'turn_failed'
        || lifecycleEvent?.type === 'turn_cancelled'
        || lifecycleEvent?.type === 'turn_aborted';
    const isTaskStarted = lifecycleEvent?.type === 'task_started';

    return { isTaskComplete, isTaskStarted, lifecycleEvent };
}

function latestTurnStatusFromLifecycleEvent(event: TaskLifecycleEvent | null) {
    if (!event) return undefined;
    if (event.type === 'task_started') return 'in_progress' as const;
    if (event.type === 'task_complete') return 'completed' as const;
    if (event.type === 'turn_failed') return 'failed' as const;
    if (event.type === 'turn_cancelled' || event.type === 'turn_aborted') return 'cancelled' as const;
    return undefined;
}

function isTerminalLatestTurnStatus(status: Session['latestTurnStatus']): boolean {
    return status === 'completed' || status === 'cancelled' || status === 'failed';
}

function shouldApplyLifecycleLatestTurnStatus(params: Readonly<{
    session: Session;
    lifecycleEvent: TaskLifecycleEvent | null;
    latestTurnStatus: Session['latestTurnStatus'] | undefined;
}>): boolean {
    if (!params.lifecycleEvent || !params.latestTurnStatus) return false;
    if (params.latestTurnStatus !== 'in_progress') return true;
    if (!isTerminalLatestTurnStatus(params.session.latestTurnStatus)) return true;

    // A task_started row seen during replay/catch-up can predate the terminal projection
    // already held locally. Only let it reopen the turn when it is ordered after that projection.
    return Number.isFinite(params.lifecycleEvent.createdAt)
        && params.lifecycleEvent.createdAt > params.session.updatedAt;
}

type HandleSessionMessageSocketUpdateParams = {
    updateData: any;
    /** Captured server/account scope fence supplied by the socket owner. */
    shouldContinue?: () => boolean;
    getSessionEncryption: (sessionId: string) => SessionMessageEncryption | null;
    getSession: (sessionId: string) => Session | undefined;
    getSessionProjection?: (sessionId: string) => SessionRealtimeProjectionCandidate | undefined;
    applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
    fetchSessions: () => void;
    requestSessionShellRefresh?: (sessionId: string) => void;
    applyCacheOnlySessionProjectionPatch?: (params: Readonly<{
        sessionId: string;
        updateData: any;
        rawMessage: ApiMessage | undefined;
        messageSeq: number | null;
        updateType: 'new-message' | 'message-updated';
    }>) => boolean;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    /** Shared page/socket row watermark; owned by Sync and advanced only after a direct authoritative apply. */
    sessionReceivedMessages?: SessionReceivedMessages;
    enqueueMessages?: (sessionId: string, messages: NormalizedMessage[]) => void;
    onNormalizedMessagesApplied?: (sessionId: string, messages: NormalizedMessage[]) => void;
    rawMessageNormalizationState?: RawMessageNormalizationSequenceState;
    isMutableToolCall: (sessionId: string, toolUseId: string) => boolean;
    invalidateScmStatus: (sessionId: string) => void;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
    isSessionActivelyViewed?: (sessionId: string) => boolean;
    getSessionMaterializedMaxSeq: (sessionId: string) => number;
    markSessionMaterializedMaxSeq: (sessionId: string, seq: number) => void;
    onMessageGapDetected: (sessionId: string, info: { prevMaterializedMaxSeq: number; messageSeq: number | null }) => void;
    onTaskLifecycleEvent?: (sessionId: string, event: TaskLifecycleEvent) => void;
    realtimeProjectionMode?: SessionRealtimeProjectionMode;
    isSessionFullContentConsumerActive?: (sessionId: string) => boolean;
    markSessionKnownRemoteSeq?: (sessionId: string, seq: number) => void;
    markSessionTranscriptDeferred?: (sessionId: string, marker: {
        updateType: 'new-message' | 'message-updated';
        seq: number | null;
        messageId?: string;
    }) => void;
    markSessionTranscriptStale?: (sessionId: string, marker: {
        updateType: 'new-message' | 'message-updated';
        seq: number | null;
        messageId?: string;
    }) => void;
    /**
     * Invoked when a durable message update is routed away from full transcript apply
     * (projection-only / stale marking) so side channels (e.g. SCM workspace-mutation
     * detection) can consume the raw envelope without hydrating the transcript.
     */
    onTranscriptSkippedDurableMessage?: (params: Readonly<{
        sessionId: string;
        rawMessage: ApiMessage | undefined;
        updateType: 'new-message' | 'message-updated';
    }>) => void;
};

function normalizeMessageSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : null;
}

function recordDurableRealtimeRouteDecision(params: Readonly<{
    mode: SessionRealtimeProjectionMode;
    sessionId: string;
    updateType: 'new-message' | 'message-updated';
    route: string;
    visible: boolean;
    fullContentConsumerActive: boolean;
    messagesLoaded: boolean;
    messageSeq: number | null;
}>): void {
    if (!syncPerformanceTelemetry.isEnabled()) return;
    recordRealtimeFanoutSocketMessageRoute({
        sessionId: params.sessionId,
        updateType: params.updateType,
        route: params.route,
        visible: params.visible,
        fullContentConsumerActive: params.fullContentConsumerActive,
        messagesLoaded: params.messagesLoaded,
        messageSeq: params.messageSeq,
    });
    syncPerformanceTelemetry.count('sync.sessions.socket.message.routeDecision', {
        newMessage: params.updateType === 'new-message' ? 1 : 0,
        messageUpdated: params.updateType === 'message-updated' ? 1 : 0,
        projectionOnly: params.route === 'projectionOnly' ? 1 : 0,
        fullTranscriptApply: params.route === 'fullTranscriptApply' ? 1 : 0,
        legacyFallback: params.route === 'legacyFallback' ? 1 : 0,
        messageUpdatedStale: params.route === 'markTranscriptStale' ? 1 : 0,
        visibleSession: params.visible ? 1 : 0,
        fullContentConsumer: params.fullContentConsumerActive ? 1 : 0,
        messagesLoaded: params.messagesLoaded ? 1 : 0,
        seqKnown: params.messageSeq === null ? 0 : 1,
        shadowMode: params.mode === 'shadow' ? 1 : 0,
        enabledMode: params.mode === 'enabled' ? 1 : 0,
    });
}

function applyProjectionOnlySessionPatch(params: Readonly<{
    session: Session | undefined;
    sessionId: string;
    updateData: any;
    rawMessage: ApiMessage | undefined;
    messageSeq: number | null;
    updateType: 'new-message' | 'message-updated';
    applySessions: HandleSessionMessageSocketUpdateParams['applySessions'];
    fetchSessions: () => void;
    requestSessionShellRefresh?: (sessionId: string) => void;
    applyCacheOnlySessionProjectionPatch?: HandleSessionMessageSocketUpdateParams['applyCacheOnlySessionProjectionPatch'];
}>): void {
    if (storedSessionMessageAttentionImpactOrNull(params.rawMessage) === null) {
        if (params.requestSessionShellRefresh) {
            params.requestSessionShellRefresh(params.sessionId);
        } else {
            params.fetchSessions();
        }
        return;
    }
    if (params.applyCacheOnlySessionProjectionPatch?.({
        sessionId: params.sessionId,
        updateData: params.updateData,
        rawMessage: params.rawMessage,
        messageSeq: params.messageSeq,
        updateType: params.updateType,
    }) === true) {
        return;
    }
    if (!params.session) {
        if (params.requestSessionShellRefresh) {
            params.requestSessionShellRefresh(params.sessionId);
        } else {
            params.fetchSessions();
        }
        return;
    }
    const currentSeq = params.session.seq ?? 0;
    const isRecoveredHistory = isRecoveredHistoryTranscriptObservation(params.rawMessage);
    const nextSessionSeq = computeNextSessionSeqFromUpdate({
        currentSessionSeq: currentSeq,
        updateType: 'new-message',
        containerSeq: params.updateData.seq,
        messageSeq: params.messageSeq ?? undefined,
    });
    const updateCreatedAt = finiteNumber(params.updateData?.createdAt);
    const messageCreatedAt = finiteNumber(params.rawMessage?.createdAt);
    const nextMeaningfulActivityAt = isRecoveredHistory ? null : messageCreatedAt ?? updateCreatedAt;
    const currentUpdatedAt = finiteNumber(params.session.updatedAt) ?? 0;
    const currentMeaningfulActivityAt = finiteNumber(params.session.meaningfulActivityAt);
    const advancesSeq = nextSessionSeq > currentSeq;
    const advancesUpdatedAt = !isRecoveredHistory && updateCreatedAt !== null && updateCreatedAt > currentUpdatedAt;
    const advancesMeaningfulActivityAt = nextMeaningfulActivityAt !== null
        && (currentMeaningfulActivityAt === null || nextMeaningfulActivityAt > currentMeaningfulActivityAt);

    if (!advancesSeq && !advancesUpdatedAt && !advancesMeaningfulActivityAt) return;

    params.applySessions([{
        ...params.session,
        ...(advancesSeq ? { seq: nextSessionSeq } : {}),
        ...(advancesUpdatedAt ? { updatedAt: updateCreatedAt } : {}),
        ...(advancesMeaningfulActivityAt ? { meaningfulActivityAt: nextMeaningfulActivityAt } : {}),
    }]);
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

function applyAlreadyLoadedReplayProjectionPatch(params: Readonly<{
    session: Session | undefined;
    updateData: any;
    rawMessage: ApiMessage | undefined;
    messageSeq: number | null;
    applySessions: HandleSessionMessageSocketUpdateParams['applySessions'];
}>): void {
    if (!params.session) return;

    const patch = buildMessageSessionProjectionPatch({
        session: params.session,
        updateData: params.updateData,
        rawMessage: params.rawMessage,
        messageSeq: params.messageSeq,
        updateType: 'new-message',
    });

    if (!hasSessionProjectionPatch(patch)) return;

    params.applySessions([{
        ...params.session,
        ...patch,
    }]);
}

type SessionProjectionPatch = Partial<Pick<Session, 'seq' | 'updatedAt' | 'meaningfulActivityAt'>>;

function hasSessionProjectionPatch(patch: SessionProjectionPatch): boolean {
    return Object.keys(patch).length > 0;
}

function buildMessageSessionProjectionPatch(params: Readonly<{
    session: Session;
    updateData: any;
    rawMessage: ApiMessage | undefined;
    messageSeq: number | null;
    updateType: 'new-message' | 'message-updated';
}>): SessionProjectionPatch {
    const currentSeq = params.session.seq ?? 0;
    const isRecoveredHistory = isRecoveredHistoryTranscriptObservation(params.rawMessage);
    const attentionImpact = storedSessionMessageAttentionImpact(params.rawMessage);
    const nextSessionSeq = computeNextSessionSeqFromUpdate({
        currentSessionSeq: currentSeq,
        updateType: 'new-message',
        containerSeq: params.updateData.seq,
        messageSeq: params.messageSeq ?? undefined,
    });
    const updateCreatedAt = finiteNumber(params.updateData?.createdAt);
    const messageCreatedAt = finiteNumber(params.rawMessage?.createdAt);
    const nextMeaningfulActivityAt = attentionImpact.affectsMeaningfulActivity
        ? messageCreatedAt ?? updateCreatedAt
        : null;
    const currentUpdatedAt = finiteNumber(params.session.updatedAt) ?? 0;
    const currentMeaningfulActivityAt = finiteNumber(params.session.meaningfulActivityAt);

    const advancesSeq = nextSessionSeq > currentSeq;
    const advancesMeaningfulActivityAt = nextMeaningfulActivityAt !== null
        && (currentMeaningfulActivityAt === null || nextMeaningfulActivityAt > currentMeaningfulActivityAt);
    // Loaded message edits can arrive for every streaming content update. When they only advance the
    // socket event timestamp, the transcript apply below is sufficient and a session projection update
    // just adds session-list churn.
    const advancesUpdatedAt = !isRecoveredHistory
        && updateCreatedAt !== null
        && updateCreatedAt > currentUpdatedAt
        && (params.updateType === 'new-message' || advancesSeq || advancesMeaningfulActivityAt);

    return {
        ...(advancesSeq ? { seq: nextSessionSeq } : {}),
        ...(advancesUpdatedAt ? { updatedAt: updateCreatedAt } : {}),
        ...(advancesMeaningfulActivityAt ? { meaningfulActivityAt: nextMeaningfulActivityAt } : {}),
    };
}

async function handleSessionMessageSocketUpdate(params: HandleSessionMessageSocketUpdateParams & {
    inferLifecycle: boolean;
}): Promise<void> {
    const {
        updateData,
        getSessionEncryption,
        getSession,
        applySessions,
        fetchSessions,
        applyMessages,
        enqueueMessages,
        isMutableToolCall,
        invalidateScmStatus,
        isSessionMessagesLoaded,
        getSessionMaterializedMaxSeq,
        markSessionMaterializedMaxSeq,
        onMessageGapDetected,
        inferLifecycle,
    } = params;

    const body = updateData?.body;
    if (params.shouldContinue?.() === false) {
        return;
    }
    if (!body || typeof body !== 'object') {
        return;
    }

    const sessionId = (body as any).sid as string;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return;
    }

    const messageSeq = (body as any).message?.seq;
    const normalizedMessageSeq = normalizeMessageSeq(messageSeq);
    const rawMessage = 'message' in body
        ? (body as { message?: ApiMessage }).message
        : undefined;
    const isRecoveredHistory = isRecoveredHistoryTranscriptObservation(rawMessage);
    const updateType = inferLifecycle ? 'new-message' : 'message-updated';
    const isCurrentDirectMessageUpdate = (): boolean => {
        if (updateType !== 'message-updated' || !rawMessage || !params.sessionReceivedMessages) {
            return true;
        }
        const socketUpdatedAt = finiteNumber(rawMessage.updatedAt)
            ?? finiteNumber(rawMessage.createdAt);
        if (socketUpdatedAt === null) return true;
        return isSessionMessageRowCurrent({
            existingUpdatedAt: params.sessionReceivedMessages.get(sessionId)?.get(rawMessage.id),
            incomingUpdatedAt: socketUpdatedAt,
            isAuthoritativeUpdate: true,
        });
    };
    const prevMaterializedMaxSeq = getSessionMaterializedMaxSeq(sessionId);
    const sessionMessagesLoaded = isSessionMessagesLoaded(sessionId);
    const session = getSession(sessionId);
    // A message-updated row corrects an existing durable row; it cannot create
    // a transcript shell. In particular, a local Voice History delete may win
    // before this async socket handler begins. Refresh the shell if useful,
    // but never let that stale update recreate transcript/currentness state.
    if (updateType === 'message-updated' && !session) {
        if (params.requestSessionShellRefresh) {
            params.requestSessionShellRefresh(sessionId);
        } else {
            fetchSessions();
        }
        return;
    }
    if (
        inferLifecycle
        &&
        normalizedMessageSeq !== null
        && prevMaterializedMaxSeq >= normalizedMessageSeq
        && sessionMessagesLoaded
    ) {
        if (params.realtimeProjectionMode === 'enabled') {
            applyAlreadyLoadedReplayProjectionPatch({
                session,
                updateData,
                rawMessage,
                messageSeq: normalizedMessageSeq,
                applySessions,
            });
        }
        if (inferLifecycle) {
            syncPerformanceTelemetry.count('sync.sessions.socket.newMessage.replaySkipped', {
                prevMaterializedMaxSeq,
                messageSeq: normalizedMessageSeq,
            });
        }
        return;
    }

    const sessionActivelyViewed = params.isSessionActivelyViewed?.(sessionId) === true;
    const realtimeProjectionMode = params.realtimeProjectionMode ?? 'disabled';
    const fullContentConsumerActive = params.isSessionFullContentConsumerActive?.(sessionId) === true;
    const sessionProjection = session ?? params.getSessionProjection?.(sessionId);
    const routeDecision = decideDurableSessionRealtimeRoute({
        updateType,
        mode: realtimeProjectionMode,
        session,
        sessionProjection,
        visible: sessionActivelyViewed,
        fullContentConsumerActive,
    });
    recordDurableRealtimeRouteDecision({
        mode: realtimeProjectionMode,
        sessionId,
        updateType,
        route: routeDecision.route,
        visible: sessionActivelyViewed,
        fullContentConsumerActive,
        messagesLoaded: sessionMessagesLoaded,
        messageSeq: normalizedMessageSeq,
    });
    // Durable transcript application needs a current session shell. A visible
    // or mounted consumer can outlive local retirement; it must not turn a
    // late new-message into orphan transcript/currentness state.
    if (routeDecision.route === 'fullTranscriptApply' && !session) {
        if (params.requestSessionShellRefresh) {
            params.requestSessionShellRefresh(sessionId);
        } else {
            fetchSessions();
        }
        return;
    }
    if (realtimeProjectionMode === 'enabled' && routeDecision.route === 'projectionOnly') {
        applyProjectionOnlySessionPatch({
            session,
            sessionId,
            updateData,
            rawMessage,
            messageSeq: normalizedMessageSeq,
            updateType,
            applySessions,
            fetchSessions,
            requestSessionShellRefresh: params.requestSessionShellRefresh,
            applyCacheOnlySessionProjectionPatch: params.applyCacheOnlySessionProjectionPatch,
        });
        if (normalizedMessageSeq !== null) {
            params.markSessionKnownRemoteSeq?.(sessionId, normalizedMessageSeq);
        }
        params.markSessionTranscriptDeferred?.(sessionId, {
            updateType,
            seq: normalizedMessageSeq,
            messageId: rawMessage?.id,
        });
        params.onTranscriptSkippedDurableMessage?.({ sessionId, rawMessage, updateType });
        return;
    }
    if (realtimeProjectionMode === 'enabled' && routeDecision.route === 'markTranscriptStale') {
        applyProjectionOnlySessionPatch({
            session,
            sessionId,
            updateData,
            rawMessage,
            messageSeq: normalizedMessageSeq,
            updateType,
            applySessions,
            fetchSessions,
            requestSessionShellRefresh: params.requestSessionShellRefresh,
            applyCacheOnlySessionProjectionPatch: params.applyCacheOnlySessionProjectionPatch,
        });
        if (normalizedMessageSeq !== null) {
            params.markSessionKnownRemoteSeq?.(sessionId, normalizedMessageSeq);
        }
        params.markSessionTranscriptStale?.(sessionId, {
            updateType,
            seq: normalizedMessageSeq,
            messageId: rawMessage?.id,
        });
        params.onTranscriptSkippedDurableMessage?.({ sessionId, rawMessage, updateType });
        return;
    }

    // A direct message-updated event is authoritative only for an equal
    // revision. Do not let an older socket row regress a newer page/socket
    // application that already owns this transcript row.
    if (!isCurrentDirectMessageUpdate()) return;

    const expectsEncryptedMessages = session?.encryptionMode !== 'plain';
    const encryption = expectsEncryptedMessages ? getSessionEncryption(sessionId) : null;
    if (!encryption && expectsEncryptedMessages && session) {
        console.error(`Session encryption not found for ${sessionId} - this should never happen`);
    }

    const telemetryFields = buildSocketMessageTelemetryFields({
        message: rawMessage,
        inferLifecycle,
        session,
        isSessionActivelyViewed: sessionActivelyViewed,
        isSessionMessagesLoaded: sessionMessagesLoaded,
    });

    let lastMessage: NormalizedMessage | null = null;
    if (rawMessage) {
        const readMessage = () => readStoredSessionMessage({
            message: rawMessage,
            decryptMessage: encryption ? (message) => encryption.decryptMessage(message) : undefined,
        });
        const decrypted = telemetryFields
            ? await syncPerformanceTelemetry.measureAsync(
                'sync.sessions.socket.message.readMessage',
                telemetryFields,
                readMessage,
            )
            : await readMessage();
        // `socket.ts` fences its callbacks, but a callback no-op does not tell
        // this owner whether application happened. Stop here when the captured
        // server/account scope retired so no projection, row watermark, or
        // materialized-seq state can outlive the decrypt boundary.
        if (params.shouldContinue?.() === false) {
            return;
        }
        const sessionAfterRead = getSession(sessionId);
        if (!sessionAfterRead) {
            return;
        }
        // The decrypt boundary can let a newer page/socket row advance the
        // shared watermark after the early route check. Recheck immediately
        // before normalization and projection so the stale row has no effects.
        if (!isCurrentDirectMessageUpdate()) return;
        const sessionForApply = sessionAfterRead;
        if (decrypted) {
            if (isLegacyMemoryArtifactTranscriptRow(decrypted)) {
                return;
            }
            const normalizedSeq =
                typeof messageSeq === 'number' && Number.isFinite(messageSeq)
                    ? Math.trunc(messageSeq)
                    : (
                        typeof decrypted.seq === 'number' && Number.isFinite(decrypted.seq)
                            ? Math.trunc(decrypted.seq)
                            : undefined
                    );
            const normalizeMessage = () => params.rawMessageNormalizationState
                ? normalizeRawMessageInSequence({
                    id: decrypted.id,
                    localId: decrypted.localId,
                    createdAt: decrypted.createdAt,
                    raw: decrypted.content,
                    seq: normalizedSeq,
                    messageRole: decrypted.messageRole ?? undefined,
                }, params.rawMessageNormalizationState)
                : normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content, {
                    seq: normalizedSeq,
                    messageRole: decrypted.messageRole ?? undefined,
                });
            lastMessage = telemetryFields
                ? syncPerformanceTelemetry.measure(
                    'sync.sessions.socket.message.normalize',
                    {
                        ...telemetryFields,
                        seqKnown: typeof normalizedSeq === 'number' ? 1 : 0,
                    },
                    normalizeMessage,
                )
                : normalizeMessage();

            if (lastMessage) {
                applyTranscriptObservationMetadata(lastMessage, rawMessage);
                if (updateType === 'message-updated') {
                    lastMessage.isAuthoritativeUpdate = true;
                }
            }

            const shouldInferLifecycle = inferLifecycle && !isRecoveredHistory;
            const { isTaskComplete, isTaskStarted, lifecycleEvent } = shouldInferLifecycle
                ? inferTaskLifecycleFromMessageContent(decrypted.content, decrypted.createdAt)
                : { isTaskComplete: false, isTaskStarted: false, lifecycleEvent: null };
            const latestTurnStatus = latestTurnStatusFromLifecycleEvent(lifecycleEvent);
            if (lifecycleEvent) {
                params.onTaskLifecycleEvent?.(sessionId, lifecycleEvent);
            }

            if (sessionForApply) {
                const shouldApplyLifecycleStatus = shouldApplyLifecycleLatestTurnStatus({
                    session: sessionForApply,
                    lifecycleEvent,
                    latestTurnStatus,
                });
                const sessionProjectionPatch = buildMessageSessionProjectionPatch({
                    session: sessionForApply,
                    updateData,
                    rawMessage,
                    messageSeq: typeof normalizedSeq === 'number' ? normalizedSeq : null,
                    updateType,
                });
                const lifecyclePatch: Partial<Session> = {
                    ...(shouldInferLifecycle && isTaskComplete ? { thinking: false } : {}),
                    ...(shouldInferLifecycle && isTaskStarted && shouldApplyLifecycleStatus ? { thinking: true } : {}),
                    ...(shouldApplyLifecycleStatus ? {
                        latestTurnStatus,
                        latestTurnStatusObservedAt: lifecycleEvent?.createdAt ?? updateData.createdAt,
                    } : {}),
                };
                const nextSessionPatch: Partial<Session> = {
                    ...sessionProjectionPatch,
                    ...lifecyclePatch,
                };

                if (Object.keys(nextSessionPatch).length > 0) {
                    const applySession = () => applySessions([
                        {
                            ...sessionForApply,
                            ...nextSessionPatch,
                        },
                    ]);
                    if (telemetryFields) {
                        syncPerformanceTelemetry.measure(
                            'sync.sessions.socket.message.applySession',
                            {
                                ...telemetryFields,
                                sessions: 1,
                                taskStarted: isTaskStarted ? 1 : 0,
                                taskComplete: isTaskComplete ? 1 : 0,
                            },
                            applySession,
                        );
                    } else {
                        applySession();
                    }
                }
            } else {
                fetchSessions();
            }

            if (lastMessage) {
                const normalizedMessage = lastMessage;
                if (enqueueMessages) {
                    // Queue admission is not a transcript apply. The production
                    // message-updated route is direct; do not publish currentness
                    // here for an optional deferred caller.
                    enqueueMessages(sessionId, [normalizedMessage]);
                    if (telemetryFields) {
                        syncPerformanceTelemetry.count('sync.sessions.socket.message.apply', {
                            ...telemetryFields,
                            normalized: 1,
                            queued: 1,
                            direct: 0,
                        });
                    }
                } else {
                    const applyMessage = () => {
                        applyMessages(sessionId, [normalizedMessage]);
                    };
                    if (telemetryFields) {
                        syncPerformanceTelemetry.measure(
                            'sync.sessions.socket.message.apply',
                            {
                                ...telemetryFields,
                                normalized: 1,
                                queued: 0,
                                direct: 1,
                            },
                            applyMessage,
                        );
                    } else {
                        applyMessage();
                    }
                    if (updateType === 'message-updated' && normalizedMessage.isAuthoritativeUpdate === true) {
                        const socketUpdatedAt = finiteNumber(rawMessage?.updatedAt)
                            ?? finiteNumber(rawMessage?.createdAt);
                        if (socketUpdatedAt !== null && params.sessionReceivedMessages) {
                            advanceSessionReceivedMessageCurrentness(
                                params.sessionReceivedMessages,
                                sessionId,
                                normalizedMessage.id,
                                socketUpdatedAt,
                            );
                        }
                    }
                    params.onNormalizedMessagesApplied?.(sessionId, [normalizedMessage]);
                    if (typeof messageSeq === 'number') {
                        markSessionMaterializedMaxSeq(sessionId, messageSeq);
                    }
                }

                let hasMutableTool = false;
                if (!enqueueMessages) {
                    markStreamingMessagesAppliedForSessionUiTelemetry({
                        sessionId,
                        messages: [normalizedMessage],
                        source: 'socketMessage',
                    });
                }
                if (
                    lastMessage.role === 'agent' &&
                    Array.isArray(lastMessage.content) &&
                    lastMessage.content.length > 0 &&
                    lastMessage.content[0] &&
                    (lastMessage.content[0] as any).type === 'tool-result'
                ) {
                    hasMutableTool = isMutableToolCall(sessionId, (lastMessage.content[0] as any).tool_use_id);
                }
                if (hasMutableTool) {
                    invalidateScmStatus(sessionId);
                }
            }

            if (
                typeof messageSeq === 'number' &&
                prevMaterializedMaxSeq > 0 &&
                messageSeq > prevMaterializedMaxSeq + 1 &&
                isSessionMessagesLoaded(sessionId)
            ) {
                onMessageGapDetected(sessionId, { prevMaterializedMaxSeq, messageSeq });
            }
        } else {
            if (!sessionForApply) {
                fetchSessions();
            } else if (isSessionMessagesLoaded(sessionId)) {
                onMessageGapDetected(sessionId, { prevMaterializedMaxSeq, messageSeq: typeof messageSeq === 'number' ? messageSeq : null });
            } else {
                fetchSessions();
            }
        }
    }
}

export async function handleNewMessageSocketUpdate(params: HandleSessionMessageSocketUpdateParams): Promise<void> {
    return syncPerformanceTelemetry.measureAsync(
        'sync.sessions.socket.newMessage',
        { hasMessage: params.updateData?.body?.message ? 1 : 0 },
        async () => handleSessionMessageSocketUpdate({ ...params, inferLifecycle: true }),
    );
}

export async function handleMessageUpdatedSocketUpdate(params: HandleSessionMessageSocketUpdateParams): Promise<void> {
    return syncPerformanceTelemetry.measureAsync(
        'sync.sessions.socket.messageUpdated',
        { hasMessage: params.updateData?.body?.message ? 1 : 0 },
        async () => handleSessionMessageSocketUpdate({ ...params, inferLifecycle: false }),
    );
}

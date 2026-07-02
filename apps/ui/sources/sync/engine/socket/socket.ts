import type { ApiEphemeralActivityUpdate, ApiMessage, ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Encryption } from '@/sync/encryption/encryption';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { EphemeralUpdate } from '@happier-dev/protocol/updates';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { Machine } from '@/sync/domains/state/storageTypes';
import {
    getSessionSurfaceVisibilitySnapshot,
    isSessionSurfaceVisible,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { isSessionFullContentConsumerActive as decideSessionFullContentConsumerActive } from '@/sync/domains/session/realtime/sessionRealtimeVisibility';
import type { DeferredTranscriptMarker } from '@/sync/domains/session/realtime/deferredTranscriptState';
import { computeNextSessionSeqFromUpdate } from '@/sync/domains/session/sequence/realtimeSessionSeq';
import {
    deriveSessionListRenderableHasUnreadMessagesFromMetadataPatch,
    summarizeSessionListReadableActivityFromMessageRecords,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import type { MachineActivityUpdate } from '@/sync/reducer/machineActivityAccumulator';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    readMountedSessionRealtimeScmConsumerScopes,
    resolveSessionRealtimeScmScopeForMountedConsumers,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import { readMountedSessionRealtimeTranscriptConsumerSessionIds } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { ingestWorkspaceMutationMessages } from '@/scm/refresh/workspaceMutationIngestionRuntime';
import { voiceHooks } from '@/voice/context/voiceHooks';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { reportNewAgentRequestsFromSessionTransition } from '@/voice/context/reportNewAgentRequestsFromSessionTransition';
import { deriveNewAgentRequests } from '@/sync/domains/permissions/deriveNewAgentRequests';
import { notifyActivityAgentRequest } from '@/activity/notifications/runtime/activityLocalNotificationBus';
import { didControlReturnToMobile } from '@/sync/domains/session/control/controlledByUserTransitions';
import { writeSyncDebugLog } from '@/sync/runtime/syncDebugLogging';
import {
    resolveSessionRuntimePresenceFields,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/runtimePresentation';
import {
    createSessionApplyCoalescer,
    type SessionApplyCoalescerSession,
} from '@/sync/engine/sessions/sessionApplyCoalescer';
import { createSessionListRenderableProjectionPatchCoalescer } from '@/sync/engine/sessions/sessionListRenderableProjectionPatchCoalescer';
import { createSessionMessageApplyCoalescer } from '@/sync/engine/sessions/sessionMessageApplyCoalescer';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import {
    buildUpdatedSessionProjectionFromSocketUpdate,
    buildUpdatedSessionListRenderablePatchFromSocketUpdate,
    buildUpdatedSessionFromSocketUpdate,
    handleDeleteSessionSocketUpdate,
    handleMessageUpdatedSocketUpdate,
    handleNewMessageSocketUpdate,
} from '@/sync/engine/sessions/syncSessions';
import { handleTranscriptStreamSegmentEphemeralUpdate } from '@/sync/engine/sessions/handleTranscriptStreamSegmentEphemeralUpdate';
import {
    createTranscriptStreamSegmentSocketQueueController,
    type TranscriptStreamSegmentSocketQueueEntry,
} from './transcriptStreamSegmentSocketQueue';
import {
    buildMachineFromMachineActivityEphemeralUpdate,
    buildUpdatedMachineFromSocketUpdate,
} from '@/sync/engine/machines/syncMachines';
import { handleUpdateAccountSocketUpdate } from '@/sync/engine/account/syncAccount';
import {
    handleDeleteArtifactSocketUpdate,
    handleNewArtifactSocketUpdate,
    handleUpdateArtifactSocketUpdate,
} from '@/sync/engine/artifacts/syncArtifacts';
import {
    handleNewFeedPostUpdate,
    handleRelationshipUpdatedSocketUpdate,
    handleTodoKvBatchUpdate,
} from '@/sync/engine/social/syncFeed';
import { applyAutomationSocketUpdate } from '@/sync/engine/automations/automationSocketApply';
import { normalizeRelationshipUpdatedUpdateBody } from '@/sync/engine/social/relationshipUpdate';
import { parseEphemeralUpdate, parseUpdateContainer } from './socketParse';
import type { ExternalSessionTranscriptUpdatedEphemeralUpdate } from './socketParse';
import { FeedBodySchema } from '@/sync/domains/social/feedTypes';
export { parseEphemeralUpdate, parseUpdateContainer } from './socketParse';

type ApplySessions = (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

type SocketMessageApplyHandlers = Readonly<{
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onNormalizedMessagesApplied?: (sessionId: string, messages: NormalizedMessage[]) => void;
    markSessionMaterializedMaxSeq?: (sessionId: string, seq: number) => void;
}>;

type DurableMessageProjectionPatchPayload = Readonly<{
    updateData: ApiUpdateContainer;
    rawMessage: ApiMessage | undefined;
    messageSeq: number | null;
}>;

type CacheOnlySessionUpdateProjectionPatchPayload = Readonly<{
    patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
    updateSeq: number;
}>;

type SocketSessionHydrationReason =
    | 'socket-update-missing-session'
    | 'socket-update-unpatchable'
    | 'share-visibility-change';

type ActivityRenderablePatch = Readonly<{
    active: boolean;
    activeAt: number;
    thinking: boolean;
    thinkingAt: number;
    presence: 'online' | number;
    updatedAt: number;
}>;

const CACHE_ONLY_ACTIVITY_TIMESTAMP_PATCH_MIN_INTERVAL_MS = Math.floor(SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS / 2);

let socketMessageApplyHandlers: SocketMessageApplyHandlers | null = null;
let socketSessionApplyHandlers: { applySessions: ApplySessions } | null = null;
const socketSessionApplyTuning = loadSyncTuning();

const socketSessionApplyCoalescer = createSessionApplyCoalescer({
    getConfig: () => ({
        enabled: socketSessionApplyTuning.sessionSocketApplyCoalescingEnabled,
        windowMs: socketSessionApplyTuning.sessionSocketApplyCoalescingWindowMs,
        maxBatchSize: socketSessionApplyTuning.sessionSocketApplyCoalescingMaxBatchSize,
    }),
    applyBatch: (sessions) => {
        socketSessionApplyHandlers?.applySessions(sessions);
    },
});

const durableMessageProjectionPatchCoalescer = createSessionListRenderableProjectionPatchCoalescer<DurableMessageProjectionPatchPayload>({
    getConfig: () => ({
        enabled: socketSessionApplyTuning.sessionSocketApplyCoalescingEnabled,
        windowMs: socketSessionApplyTuning.activityUpdateDebounceMs,
        maxBatchSize: socketSessionApplyTuning.sessionSocketApplyCoalescingMaxBatchSize,
    }),
    readRenderable: (sessionId) => storage.getState().sessionListRenderables[sessionId],
    buildPatch: ({ renderable, payload }) => buildCacheOnlyDurableMessageProjectionPatch({
        renderable,
        updateData: payload.updateData,
        rawMessage: payload.rawMessage,
        messageSeq: payload.messageSeq,
    }),
    applyPatches: (patches) => storage.getState().applySessionListRenderablePatches(patches),
});

const cacheOnlySessionUpdateSeqBySession = new Map<string, number>();

const cacheOnlySessionUpdateProjectionPatchCoalescer = createSessionListRenderableProjectionPatchCoalescer<CacheOnlySessionUpdateProjectionPatchPayload>({
    getConfig: () => ({
        enabled: socketSessionApplyTuning.sessionSocketApplyCoalescingEnabled,
        windowMs: socketSessionApplyTuning.activityUpdateDebounceMs,
        maxBatchSize: socketSessionApplyTuning.sessionSocketApplyCoalescingMaxBatchSize,
    }),
    readRenderable: (sessionId) => storage.getState().sessionListRenderables[sessionId],
    buildPatch: ({ renderable, payload }) => {
        const previousSeq = cacheOnlySessionUpdateSeqBySession.get(renderable.id) ?? 0;
        cacheOnlySessionUpdateSeqBySession.set(renderable.id, Math.max(previousSeq, Math.trunc(payload.updateSeq)));
        return payload.patch;
    },
    applyPatches: (patches) => storage.getState().applySessionListRenderablePatches(patches),
});

function getSocketMessageApplyConfig() {
    const settings = storage.getState().settings;
    return {
        enabled: settings.transcriptStreamingCoalesceEnabled === true,
        windowMs: clampInt(
            settings.transcriptStreamingCoalesceWindowMs,
            settingsDefaults.transcriptStreamingCoalesceWindowMs,
            0,
            200,
        ),
        maxBatchSize: clampInt(
            settings.transcriptStreamingCoalesceMaxBatchSize,
            settingsDefaults.transcriptStreamingCoalesceMaxBatchSize,
            1,
            2000,
        ),
    };
}

function setSocketSessionApplyHandler(applySessions: ApplySessions): void {
    if (socketSessionApplyHandlers && socketSessionApplyHandlers.applySessions !== applySessions) {
        socketSessionApplyCoalescer.flushAll();
    }
    socketSessionApplyHandlers = { applySessions };
}

function normalizeSocketSession(session: SessionApplyCoalescerSession): Session {
    return {
        ...session,
        presence: session.presence ?? 'online',
    };
}

function getSocketSessionApplyBase(sessionId: string): Session | undefined {
    const queued = socketSessionApplyCoalescer.getQueuedSession(sessionId);
    if (queued) return normalizeSocketSession(queued);
    return storage.getState().sessions[sessionId];
}

function enqueueSocketSessionApplyGuarded(
    applySessions: ApplySessions,
    sessions: SessionApplyCoalescerSession[],
    shouldContinue: () => boolean,
    options?: Readonly<{ deferLeadingBatch?: boolean }>,
): void {
    setSocketSessionApplyHandler(applySessions);
    socketSessionApplyCoalescer.enqueue(sessions, {
        shouldContinue,
        deferLeadingBatch: options?.deferLeadingBatch,
    });
}

function flushQueuedSocketSessionApplies(applySessions: ApplySessions, sessionIds: readonly string[]): void {
    setSocketSessionApplyHandler(applySessions);
    socketSessionApplyCoalescer.flushSessionIds(sessionIds);
}

function applySessionsAfterFlushingQueued(applySessions: ApplySessions, sessions: SessionApplyCoalescerSession[]): void {
    flushQueuedSocketSessionApplies(applySessions, sessions.map((session) => session.id));
    applySessions(sessions);
}

function isTimestampOnlyActivityPatch(
    current: Pick<SessionListRenderableSession, 'active' | 'thinking' | 'presence'>,
    patch: ActivityRenderablePatch,
): boolean {
    return current.active === patch.active
        && current.thinking === patch.thinking
        && current.presence === patch.presence;
}

function getActivityRuntimeTimestamp(value: Pick<SessionListRenderableSession, 'activeAt' | 'thinkingAt'>): number {
    return Math.max(
        finiteNumber(value.activeAt) ?? 0,
        finiteNumber(value.thinkingAt) ?? 0,
    );
}

function isStaleTimestampOnlyActivityPatch(
    current: Pick<SessionListRenderableSession, 'activeAt' | 'thinkingAt'>,
    patch: ActivityRenderablePatch,
): boolean {
    return getActivityRuntimeTimestamp(patch) <= getActivityRuntimeTimestamp(current);
}

function shouldSkipFreshTimestampOnlyRenderableActivityPatch(
    renderable: SessionListRenderableSession,
    patch: ActivityRenderablePatch,
): boolean {
    if (!isTimestampOnlyActivityPatch(renderable, patch)) return false;
    const previousRuntimeTimestamp = getActivityRuntimeTimestamp(renderable);
    const nextRuntimeTimestamp = getActivityRuntimeTimestamp(patch);
    return nextRuntimeTimestamp <= previousRuntimeTimestamp
        || nextRuntimeTimestamp - previousRuntimeTimestamp < CACHE_ONLY_ACTIVITY_TIMESTAMP_PATCH_MIN_INTERVAL_MS;
}

const socketMessageApplyCoalescer = createSessionMessageApplyCoalescer({
    getConfig: getSocketMessageApplyConfig,
    applyBatch: (sessionId, messages) => {
        socketMessageApplyHandlers?.applyMessages(sessionId, messages);
    },
    onBatchApplied: (sessionId, messages) => {
        socketMessageApplyHandlers?.onNormalizedMessagesApplied?.(sessionId, messages);

        let maxSeq: number | null = null;
        for (const message of messages) {
            const seq = message.seq;
            if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
            const normalized = Math.trunc(seq);
            maxSeq = maxSeq === null ? normalized : Math.max(maxSeq, normalized);
        }
        if (maxSeq !== null) {
            socketMessageApplyHandlers?.markSessionMaterializedMaxSeq?.(sessionId, maxSeq);
        }
    },
});

function setSocketMessageApplyHandlerForTranscriptStreamSegment(entry: TranscriptStreamSegmentSocketQueueEntry): void {
    if (!entry.applyMessages) return;
    const currentApplyHandlers = socketMessageApplyHandlers;
    socketMessageApplyHandlers = {
        applyMessages: entry.applyMessages,
        ...(currentApplyHandlers?.onNormalizedMessagesApplied
            ? { onNormalizedMessagesApplied: currentApplyHandlers.onNormalizedMessagesApplied }
            : {}),
        ...(currentApplyHandlers?.markSessionMaterializedMaxSeq
            ? { markSessionMaterializedMaxSeq: currentApplyHandlers.markSessionMaterializedMaxSeq }
            : {}),
    };
}

function getVoiceBoundTargetSessionIds(): string[] {
    const ids: string[] = [];
    for (const binding of voiceSessionBindingStore.getState().list()) {
        const targetSessionId = typeof binding.targetSessionId === 'string' ? binding.targetSessionId.trim() : '';
        if (targetSessionId) ids.push(targetSessionId);
        const conversationSessionId = typeof binding.conversationSessionId === 'string' ? binding.conversationSessionId.trim() : '';
        if (conversationSessionId) ids.push(conversationSessionId);
        const controlSessionId = typeof binding.controlSessionId === 'string' ? binding.controlSessionId.trim() : '';
        if (controlSessionId) ids.push(controlSessionId);
    }
    return ids;
}

function isSessionFullContentConsumerActiveForRealtime(sessionId: string, sourceServerId?: string | null): boolean {
    const targetState = useVoiceTargetStore.getState();
    const scmMountedScopes = readMountedSessionRealtimeScmConsumerScopes();
    return decideSessionFullContentConsumerActive({
        sessionId,
        isVisible: isSessionSurfaceVisible(sessionId, sourceServerId),
        explicitTranscriptConsumerSessionIds: readMountedSessionRealtimeTranscriptConsumerSessionIds(sourceServerId),
        voicePrimaryActionSessionId: targetState.primaryActionSessionId,
        voiceTrackedSessionIds: targetState.trackedSessionIds,
        voiceReadbackSessionIds: targetState.lastFocusedSessionId ? [targetState.lastFocusedSessionId] : [],
        voiceBoundTargetSessionIds: getVoiceBoundTargetSessionIds(),
        sessionScmScope: scmMountedScopes.length > 0
            ? resolveSessionRealtimeScmScopeForMountedConsumers(storage.getState(), sessionId, scmMountedScopes)
            : null,
        scmMountedScopes,
    });
}

const transcriptStreamSegmentSocketQueueController = createTranscriptStreamSegmentSocketQueueController({
    getConfig: getSocketMessageApplyConfig,
    isSessionVisible: isSessionFullContentConsumerActiveForRealtime,
    messageCoalescer: socketMessageApplyCoalescer,
    prepareApplyEntry: setSocketMessageApplyHandlerForTranscriptStreamSegment,
    handleTranscriptStreamSegment: handleTranscriptStreamSegmentEphemeralUpdate,
    onDeferredRawQueued: (fields) => {
        syncPerformanceTelemetry.count('sync.socket.transcriptStreamSegment.deferredRaw.queued', fields);
    },
    onDeferredRawDroppedHidden: (fields) => {
        syncPerformanceTelemetry.count('sync.socket.transcriptStreamSegment.deferredRaw.droppedHidden', fields);
    },
});

function normalizeProjectionSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.trunc(value));
}

function readProjectedPendingCount(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.trunc(value));
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

function readProjectionTimestamp(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : fallback;
}

function finiteTimestamp(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeShareAccessLevel(value: unknown): Session['accessLevel'] | undefined {
    return value === 'view' || value === 'edit' || value === 'admin' ? value : undefined;
}

function readShareSessionId(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const candidate = (body as { sessionId?: unknown; sid?: unknown }).sessionId ?? (body as { sid?: unknown }).sid;
    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : null;
}

function buildPendingChangedSessionPatch(body: unknown): Pick<Session, 'pendingCount' | 'pendingVersion'> & Pick<Partial<Session>, 'meaningfulActivityAt'> {
    const pendingBody = body as { pendingCount: number; pendingVersion: number; meaningfulActivityAt?: unknown };
    const meaningfulActivityAt = finiteTimestamp(pendingBody.meaningfulActivityAt);
    return {
        pendingCount: pendingBody.pendingCount,
        pendingVersion: pendingBody.pendingVersion,
        ...(meaningfulActivityAt === undefined ? {} : { meaningfulActivityAt }),
    };
}

function buildShareSessionPatch(body: unknown): Partial<Pick<Session, 'accessLevel' | 'canApprovePermissions' | 'updatedAt'>> {
    if (!body || typeof body !== 'object') return {};
    const shareBody = body as { accessLevel?: unknown; canApprovePermissions?: unknown; updatedAt?: unknown; createdAt?: unknown };
    const accessLevel = normalizeShareAccessLevel(shareBody.accessLevel);
    const updatedAt = finiteTimestamp(shareBody.updatedAt) ?? finiteTimestamp(shareBody.createdAt);
    return {
        ...(accessLevel === undefined ? {} : { accessLevel }),
        ...(typeof shareBody.canApprovePermissions === 'boolean'
            ? { canApprovePermissions: shareBody.canApprovePermissions }
            : {}),
        ...(updatedAt === undefined ? {} : { updatedAt }),
    };
}

function hasSelfSufficientSharePermission(body: unknown): boolean {
    return Boolean(
        body
        && typeof body === 'object'
        && typeof (body as { canApprovePermissions?: unknown }).canApprovePermissions === 'boolean',
    );
}

function requestTargetedSessionHydration(params: Readonly<{
    sessionId: string;
    reason: SocketSessionHydrationReason;
    hydrateSessionById?: (sessionId: string, reason: SocketSessionHydrationReason) => void;
    invalidateSessions: () => void;
}>): void {
    if (params.hydrateSessionById) {
        params.hydrateSessionById(params.sessionId, params.reason);
        return;
    }
    params.invalidateSessions();
}

function isCacheOnlySessionHydrationAnchorActive(sessionId: string, sourceServerId?: string | null): boolean {
    if (isSessionSurfaceVisible(sessionId, sourceServerId)) return true;
    if (typeof sourceServerId === 'string' && sourceServerId.trim().length > 0) return false;
    const visibilitySnapshot = getSessionSurfaceVisibilitySnapshot();
    return visibilitySnapshot.routeAnchorSessionId === sessionId
        || visibilitySnapshot.focusedSessionId === sessionId;
}

function requestVisibleCacheOnlySessionHydration(params: Readonly<{
    sessionId: string;
    sourceServerId?: string | null;
    hydrateSessionById?: (sessionId: string, reason: SocketSessionHydrationReason) => void;
    invalidateSessions: () => void;
}>): void {
    if (!isCacheOnlySessionHydrationAnchorActive(params.sessionId, params.sourceServerId)) return;
    requestTargetedSessionHydration({
        sessionId: params.sessionId,
        reason: 'socket-update-missing-session',
        hydrateSessionById: params.hydrateSessionById,
        invalidateSessions: params.invalidateSessions,
    });
}

function readCacheOnlyRenderablePatchReadableActivity(sessionId: string) {
    const sessionMessages = storage.getState().sessionMessages?.[sessionId];
    if (!sessionMessages) return undefined;
    return summarizeSessionListReadableActivityFromMessageRecords(
        sessionMessages.messageIdsOldestFirst,
        sessionMessages.messagesById,
    );
}

function isTerminalProjectionStatus(value: unknown): boolean {
    return value === 'completed' || value === 'cancelled' || value === 'failed';
}

function hasSafeCacheOnlySessionProjectionFields(updateBody: any): boolean {
    return (
        typeof updateBody.lastViewedSessionSeq === 'number'
        || typeof updateBody.pendingPermissionRequestCount === 'number'
        || typeof updateBody.pendingUserActionRequestCount === 'number'
        || typeof updateBody.pendingRequestObservedAt === 'number'
        || updateBody.pendingRequestObservedAt === null
        || typeof updateBody.active === 'boolean'
        || typeof updateBody.activeAt === 'number'
        || typeof updateBody.thinking === 'boolean'
        || typeof updateBody.thinkingAt === 'number'
        || typeof updateBody.latestTurnId === 'string'
        || updateBody.latestTurnId === null
        || typeof updateBody.latestTurnStatus === 'string'
        || updateBody.latestTurnStatus === null
        || typeof updateBody.latestTurnStatusObservedAt === 'number'
        || updateBody.latestTurnStatusObservedAt === null
        || typeof updateBody.latestReadyEventSeq === 'number'
        || updateBody.latestReadyEventSeq === null
        || typeof updateBody.latestReadyEventAt === 'number'
        || updateBody.latestReadyEventAt === null
        || typeof updateBody.meaningfulActivityAt === 'number'
        || typeof updateBody.archivedAt === 'number'
        || updateBody.archivedAt === null
        || updateBody.lastRuntimeIssue === null
        || (updateBody.lastRuntimeIssue && typeof updateBody.lastRuntimeIssue === 'object')
    );
}

function buildCacheOnlySessionProjectionPatch(params: Readonly<{
    renderable: SessionListRenderableSession;
    updateBody: any;
    updateSeq: number;
    updateCreatedAt: number;
}>): Partial<SessionListRenderableSession> {
    const { renderable, updateBody, updateSeq, updateCreatedAt } = params;
    const nextSessionSeq = computeNextSessionSeqFromUpdate({
        currentSessionSeq: renderable.seq ?? 0,
        updateType: 'update-session',
        containerSeq: updateSeq,
        messageSeq: undefined,
    });
    const nextLastViewedSessionSeq =
        typeof updateBody.lastViewedSessionSeq === 'number'
            ? updateBody.lastViewedSessionSeq
            : renderable.lastViewedSessionSeq ?? null;
    const nextLatestTurnStatus =
        typeof updateBody.latestTurnStatus === 'string' || updateBody.latestTurnStatus === null
            ? updateBody.latestTurnStatus
            : renderable.latestTurnStatus;
    const nextLatestReadyEventSeq =
        typeof updateBody.latestReadyEventSeq === 'number' || updateBody.latestReadyEventSeq === null
            ? updateBody.latestReadyEventSeq
            : renderable.latestReadyEventSeq;
    const nextActive =
        typeof updateBody.active === 'boolean'
            ? updateBody.active
            : renderable.active;
    const nextActiveAt = readProjectionTimestamp(updateBody.activeAt, renderable.activeAt);
    const nextThinking =
        typeof updateBody.thinking === 'boolean'
            ? updateBody.thinking
            : updateBody.active === false
                ? false
                : renderable.thinking;
    const nextThinkingAt = readProjectionTimestamp(
        updateBody.thinkingAt,
        typeof updateBody.thinking === 'boolean' || updateBody.active === false
            ? nextActiveAt
            : renderable.thinkingAt,
    );
    const shouldRecomputeUnread =
        typeof updateBody.lastViewedSessionSeq === 'number'
        || typeof updateBody.latestReadyEventSeq === 'number'
        || isTerminalProjectionStatus(updateBody.latestTurnStatus);
    return {
        seq: nextSessionSeq,
        updatedAt: updateCreatedAt,
        meaningfulActivityAt:
            typeof updateBody.meaningfulActivityAt === 'number'
                ? updateBody.meaningfulActivityAt
                : renderable.meaningfulActivityAt,
        active: nextActive,
        activeAt: nextActiveAt,
        thinking: nextThinking,
        thinkingAt: nextThinkingAt,
        archivedAt:
            typeof updateBody.archivedAt === 'number' || updateBody.archivedAt === null
                ? updateBody.archivedAt
                : renderable.archivedAt,
        lastViewedSessionSeq:
            typeof updateBody.lastViewedSessionSeq === 'number'
                ? updateBody.lastViewedSessionSeq
                : renderable.lastViewedSessionSeq,
        hasPendingPermissionRequests:
            typeof updateBody.pendingPermissionRequestCount === 'number'
                ? updateBody.pendingPermissionRequestCount > 0
                : renderable.hasPendingPermissionRequests,
        hasPendingUserActionRequests:
            typeof updateBody.pendingUserActionRequestCount === 'number'
                ? updateBody.pendingUserActionRequestCount > 0
                : renderable.hasPendingUserActionRequests,
        pendingRequestObservedAt:
            typeof updateBody.pendingRequestObservedAt === 'number' || updateBody.pendingRequestObservedAt === null
                ? updateBody.pendingRequestObservedAt
                : renderable.pendingRequestObservedAt,
        latestTurnId:
            typeof updateBody.latestTurnId === 'string' || updateBody.latestTurnId === null
                ? updateBody.latestTurnId
                : renderable.latestTurnId,
        latestTurnStatus:
            nextLatestTurnStatus,
        latestTurnStatusObservedAt:
            typeof updateBody.latestTurnStatusObservedAt === 'number' || updateBody.latestTurnStatusObservedAt === null
                ? updateBody.latestTurnStatusObservedAt
                : renderable.latestTurnStatusObservedAt,
        latestReadyEventSeq:
            nextLatestReadyEventSeq,
        latestReadyEventAt:
            typeof updateBody.latestReadyEventAt === 'number' || updateBody.latestReadyEventAt === null
                ? updateBody.latestReadyEventAt
                : renderable.latestReadyEventAt,
        lastRuntimeIssue:
            updateBody.lastRuntimeIssue === null
            || (updateBody.lastRuntimeIssue && typeof updateBody.lastRuntimeIssue === 'object')
                ? updateBody.lastRuntimeIssue
                : renderable.lastRuntimeIssue,
        hasUnreadMessages: deriveSessionListRenderableHasUnreadMessagesFromMetadataPatch({
            metadata: undefined,
            nextSessionSeq,
            nextLastViewedSessionSeq,
            nextLatestTurnStatus,
            nextLatestReadyEventSeq,
            readableActivity: readCacheOnlyRenderablePatchReadableActivity(renderable.id),
            previousHasUnreadMessages: renderable.hasUnreadMessages,
            recomputeUnread: shouldRecomputeUnread,
        }),
    };
}

function buildCacheOnlyDurableMessageProjectionPatch(params: Readonly<{
    renderable: SessionListRenderableSession;
    updateData: ApiUpdateContainer;
    rawMessage: ApiMessage | undefined;
    messageSeq: number | null;
}>): Partial<SessionListRenderableSession> {
    const { renderable, updateData, rawMessage, messageSeq } = params;
    const currentSeq = renderable.seq ?? 0;
    const nextSessionSeq = computeNextSessionSeqFromUpdate({
        currentSessionSeq: currentSeq,
        updateType: 'new-message',
        containerSeq: updateData.seq,
        messageSeq: messageSeq ?? undefined,
    });
    const updateCreatedAt = finiteNumber(updateData.createdAt);
    const messageCreatedAt = finiteNumber(rawMessage?.createdAt);
    const nextMeaningfulActivityAt = messageCreatedAt ?? updateCreatedAt;
    const currentUpdatedAt = finiteNumber(renderable.updatedAt) ?? 0;
    const currentMeaningfulActivityAt = finiteNumber(renderable.meaningfulActivityAt);
    const advancesSeq = nextSessionSeq > currentSeq;
    const advancesUpdatedAt = updateCreatedAt !== null && updateCreatedAt > currentUpdatedAt;
    const advancesMeaningfulActivityAt = nextMeaningfulActivityAt !== null
        && (currentMeaningfulActivityAt === null || nextMeaningfulActivityAt > currentMeaningfulActivityAt);
    const readableActivity = messageSeq !== null
        ? {
            latestCommittedMessageSeq: messageSeq,
            latestCommittedMessageCreatedAt: nextMeaningfulActivityAt ?? updateCreatedAt,
        }
        : undefined;

    return {
        ...(advancesSeq ? { seq: nextSessionSeq } : {}),
        ...(advancesUpdatedAt ? { updatedAt: updateCreatedAt } : {}),
        ...(advancesMeaningfulActivityAt ? { meaningfulActivityAt: nextMeaningfulActivityAt } : {}),
        hasUnreadMessages: deriveSessionListRenderableHasUnreadMessagesFromMetadataPatch({
            metadata: undefined,
            nextSessionSeq,
            nextLastViewedSessionSeq: renderable.lastViewedSessionSeq ?? null,
            nextLatestTurnStatus: renderable.latestTurnStatus ?? null,
            nextLatestReadyEventSeq: renderable.latestReadyEventSeq ?? null,
            readableActivity,
            previousHasUnreadMessages: renderable.hasUnreadMessages,
            recomputeUnread: messageSeq !== null,
        }),
    };
}

function shouldDeferLeadingDurableMessageProjectionPatch(params: Readonly<{
    renderable: SessionListRenderableSession;
    patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
}>): boolean {
    return (params.renderable.hasUnreadMessages === true) === (params.patch.hasUnreadMessages === true);
}

function hasPatchField(
    patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>,
    key: keyof Omit<SessionListRenderableSession, 'id'>,
): boolean {
    return Object.prototype.hasOwnProperty.call(patch, key);
}

function patchBooleanFieldChanged(
    renderable: SessionListRenderableSession,
    patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>,
    key: keyof Omit<SessionListRenderableSession, 'id'>,
): boolean {
    if (!hasPatchField(patch, key)) return false;
    return (renderable[key] === true) !== (patch[key] === true);
}

function patchNullableFieldChanged(
    renderable: SessionListRenderableSession,
    patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>,
    key: keyof Omit<SessionListRenderableSession, 'id'>,
): boolean {
    if (!hasPatchField(patch, key)) return false;
    return (renderable[key] ?? null) !== (patch[key] ?? null);
}

function pruneUnchangedSessionRenderablePatch(
    renderable: SessionListRenderableSession,
    patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>,
): Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>> {
    const pruned: Partial<Omit<SessionListRenderableSession, 'id'>> = {};
    for (const key of Object.keys(patch) as Array<keyof Omit<SessionListRenderableSession, 'id'>>) {
        const nextValue = patch[key];
        if (renderable[key] === nextValue) continue;
        pruned[key] = nextValue as never;
    }
    return pruned;
}

function shouldApplyCacheOnlySessionUpdateProjectionPatchImmediately(params: Readonly<{
    renderable: SessionListRenderableSession;
    patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
}>): boolean {
    const { renderable, patch } = params;
    return hasPatchField(patch, 'metadata')
        || hasPatchField(patch, 'metadataVersion')
        || patchBooleanFieldChanged(renderable, patch, 'active')
        || patchBooleanFieldChanged(renderable, patch, 'thinking')
        || patchNullableFieldChanged(renderable, patch, 'archivedAt')
        || patchNullableFieldChanged(renderable, patch, 'lastRuntimeIssue')
        || patchBooleanFieldChanged(renderable, patch, 'hasUnreadMessages')
        || patchBooleanFieldChanged(renderable, patch, 'hasPendingPermissionRequests')
        || patchBooleanFieldChanged(renderable, patch, 'hasPendingUserActionRequests');
}

function applyCacheOnlySessionUpdateProjectionPatch(params: Readonly<{
    sessionId: string;
    renderable: SessionListRenderableSession;
    patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
    updateSeq: number;
    shouldContinue?: () => boolean;
}>): void {
    const patch = pruneUnchangedSessionRenderablePatch(params.renderable, params.patch);
    if (Object.keys(patch).length === 0) return;
    const forceImmediate = shouldApplyCacheOnlySessionUpdateProjectionPatchImmediately({
        renderable: params.renderable,
        patch,
    });
    const patchUpdatedAt = finiteNumber(patch.updatedAt);
    const patchSeq = finiteNumber(patch.seq);
    const shouldContinue = () => {
        if (params.shouldContinue && !params.shouldContinue()) return false;
        if (patchUpdatedAt === null) return true;
        const currentRenderable = storage.getState().sessionListRenderables[params.sessionId];
        const currentUpdatedAt = finiteNumber(currentRenderable?.updatedAt) ?? 0;
        if (currentUpdatedAt < patchUpdatedAt) return true;
        if (currentUpdatedAt > patchUpdatedAt) return false;
        const currentUpdateSeq = cacheOnlySessionUpdateSeqBySession.get(params.sessionId) ?? 0;
        if (currentUpdateSeq < params.updateSeq) return true;
        if (patchSeq === null) return false;
        const currentSeq = finiteNumber(currentRenderable?.seq) ?? 0;
        return currentSeq < patchSeq;
    };
    cacheOnlySessionUpdateProjectionPatchCoalescer.enqueue(
        params.sessionId,
        { patch, updateSeq: params.updateSeq },
        {
            shouldContinue,
            deferLeadingPatch: !forceImmediate,
            forceImmediate,
        },
    );
}

function applyCacheOnlyDurableMessageProjectionPatch(params: Readonly<{
    sessionId: string;
    updateData: ApiUpdateContainer;
    rawMessage: ApiMessage | undefined;
    messageSeq: number | null;
    shouldContinue?: () => boolean;
}>): boolean {
    const renderable = storage.getState().sessionListRenderables[params.sessionId];
    if (!renderable) return false;
    const leadingPatch = buildCacheOnlyDurableMessageProjectionPatch({
        renderable,
        updateData: params.updateData,
        rawMessage: params.rawMessage,
        messageSeq: params.messageSeq,
    });
    durableMessageProjectionPatchCoalescer.enqueue(
        params.sessionId,
        {
            updateData: params.updateData,
            rawMessage: params.rawMessage,
            messageSeq: params.messageSeq,
        },
        {
            ...(params.shouldContinue ? { shouldContinue: params.shouldContinue } : {}),
            deferLeadingPatch: shouldDeferLeadingDurableMessageProjectionPatch({
                renderable,
                patch: leadingPatch,
            }),
        },
    );
    return true;
}

function shouldReportReadyProjectionAdvance(
    previous: Pick<Session, 'latestReadyEventSeq' | 'lastViewedSessionSeq'> | SessionListRenderableSession,
    nextReadySeq: unknown,
): number | null {
    const normalizedReadySeq = normalizeProjectionSeq(nextReadySeq);
    if (normalizedReadySeq === null) return null;
    const previousReadySeq = normalizeProjectionSeq(previous.latestReadyEventSeq);
    const previousViewedSeq = normalizeProjectionSeq(previous.lastViewedSessionSeq);
    if (previousReadySeq !== null && normalizedReadySeq <= previousReadySeq) return null;
    if (previousViewedSeq !== null && normalizedReadySeq <= previousViewedSeq) return null;
    return normalizedReadySeq;
}

function shouldHydrateEncryptedAgentStateForHiddenSession(params: Readonly<{
    session: Session;
    updateBody: any;
}>): boolean {
    if (params.updateBody.agentState == null) return false;
    if (params.session.agentState?.controlledByUser === true) return true;

    const nextPermissionCount = readProjectedPendingCount(params.updateBody.pendingPermissionRequestCount);
    const nextUserActionCount = readProjectedPendingCount(params.updateBody.pendingUserActionRequestCount);
    if (nextPermissionCount === null || nextUserActionCount === null) {
        return true;
    }

    const previousPermissionCount = readProjectedPendingCount(params.session.pendingPermissionRequestCount) ?? 0;
    const previousUserActionCount = readProjectedPendingCount(params.session.pendingUserActionRequestCount) ?? 0;

    return nextPermissionCount > previousPermissionCount || nextUserActionCount > previousUserActionCount;
}

export async function handleSocketUpdate(params: {
    update: unknown;
    encryption: Encryption;
    settingsScope?: AccountSettingsScope | null;
    sourceServerId?: string | null;
    shouldContinue?: () => boolean;
    artifactDataKeys: Map<string, Uint8Array>;
    applySessions: ApplySessions;
    fetchSessions: () => void;
    hydrateSessionById?: (sessionId: string, reason: SocketSessionHydrationReason) => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onSessionVisible: (sessionId: string) => void;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
    getSessionMaterializedMaxSeq: (sessionId: string) => number;
    markSessionMaterializedMaxSeq: (sessionId: string, seq: number) => void;
    markSessionKnownRemoteSeq?: (sessionId: string, seq: number) => void;
    markSessionTranscriptDeferred?: (sessionId: string, marker: DeferredTranscriptMarker) => void;
    markSessionTranscriptStale?: (sessionId: string, marker: DeferredTranscriptMarker) => void;
    markSessionStateHydrationDeferred?: (sessionId: string) => void;
    onReadyProjectionAdvance?: (sessionId: string, seq: number) => void;
    onMessageGapDetected: (sessionId: string, info: { prevMaterializedMaxSeq: number; messageSeq: number | null }) => void;
    assumeUsers: (userIds: string[]) => Promise<void>;
    applyTodoSocketUpdates: (changes: any[]) => Promise<void>;
    invalidateMachines: () => void;
    invalidateSessions: () => void;
    invalidateArtifacts: () => void;
    invalidateFriends: () => void;
    invalidateFriendRequests: () => void;
    invalidateFeed: () => void;
    invalidateAutomations: () => void;
    invalidateAutomationsCoalesced?: () => void;
    invalidateTodos: () => void;
    onTaskLifecycleEvent?: (sessionId: string, event: import('@/sync/engine/sessions/taskLifecycle').TaskLifecycleEvent) => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const {
        update,
        encryption,
        settingsScope,
        sourceServerId,
        shouldContinue = () => true,
        artifactDataKeys,
        applySessions,
        fetchSessions,
        hydrateSessionById,
        applyMessages,
        onSessionVisible,
        isSessionMessagesLoaded,
        getSessionMaterializedMaxSeq,
        markSessionMaterializedMaxSeq,
        markSessionKnownRemoteSeq,
        markSessionTranscriptDeferred,
        markSessionTranscriptStale,
        markSessionStateHydrationDeferred,
        onReadyProjectionAdvance,
        onMessageGapDetected,
        assumeUsers,
        applyTodoSocketUpdates,
        invalidateMachines,
        invalidateSessions,
        invalidateArtifacts,
        invalidateFriends,
        invalidateFriendRequests,
        invalidateFeed,
        invalidateAutomations,
        invalidateAutomationsCoalesced,
        invalidateTodos,
        onTaskLifecycleEvent,
        log,
    } = params;

    const updateData = parseUpdateContainer(update);
    if (!updateData) return;
    if (!shouldContinue()) return;

    await handleUpdateContainer({
        updateData,
        encryption,
        settingsScope,
        sourceServerId,
        shouldContinue,
        artifactDataKeys,
        applySessions,
        fetchSessions,
        hydrateSessionById,
        applyMessages,
        onSessionVisible,
        isSessionMessagesLoaded,
        getSessionMaterializedMaxSeq,
        markSessionMaterializedMaxSeq,
        markSessionKnownRemoteSeq,
        markSessionTranscriptDeferred,
        markSessionTranscriptStale,
        markSessionStateHydrationDeferred,
        onReadyProjectionAdvance,
        onMessageGapDetected,
        assumeUsers,
        applyTodoSocketUpdates,
        invalidateMachines,
        invalidateSessions,
        invalidateArtifacts,
        invalidateFriends,
        invalidateFriendRequests,
        invalidateFeed,
        invalidateAutomations,
        invalidateAutomationsCoalesced,
        invalidateTodos,
        onTaskLifecycleEvent,
        log,
    });
}

export async function handleUpdateContainer(params: {
    updateData: ApiUpdateContainer;
    encryption: Encryption;
    settingsScope?: AccountSettingsScope | null;
    sourceServerId?: string | null;
    shouldContinue?: () => boolean;
    artifactDataKeys: Map<string, Uint8Array>;
    applySessions: ApplySessions;
    fetchSessions: () => void;
    hydrateSessionById?: (sessionId: string, reason: SocketSessionHydrationReason) => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onSessionVisible: (sessionId: string) => void;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
    getSessionMaterializedMaxSeq: (sessionId: string) => number;
    markSessionMaterializedMaxSeq: (sessionId: string, seq: number) => void;
    markSessionKnownRemoteSeq?: (sessionId: string, seq: number) => void;
    markSessionTranscriptDeferred?: (sessionId: string, marker: DeferredTranscriptMarker) => void;
    markSessionTranscriptStale?: (sessionId: string, marker: DeferredTranscriptMarker) => void;
    markSessionStateHydrationDeferred?: (sessionId: string) => void;
    onReadyProjectionAdvance?: (sessionId: string, seq: number) => void;
    onMessageGapDetected: (sessionId: string, info: { prevMaterializedMaxSeq: number; messageSeq: number | null }) => void;
    assumeUsers: (userIds: string[]) => Promise<void>;
    applyTodoSocketUpdates: (changes: any[]) => Promise<void>;
    invalidateMachines: () => void;
    invalidateSessions: () => void;
    invalidateArtifacts: () => void;
    invalidateFriends: () => void;
    invalidateFriendRequests: () => void;
    invalidateFeed: () => void;
    invalidateAutomations: () => void;
    invalidateAutomationsCoalesced?: () => void;
    invalidateTodos: () => void;
    onTaskLifecycleEvent?: (sessionId: string, event: import('@/sync/engine/sessions/taskLifecycle').TaskLifecycleEvent) => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const {
        updateData,
        encryption,
        settingsScope,
        sourceServerId,
        shouldContinue = () => true,
        artifactDataKeys,
        applySessions,
        fetchSessions,
        hydrateSessionById,
        applyMessages,
        onSessionVisible,
        isSessionMessagesLoaded,
        getSessionMaterializedMaxSeq,
        markSessionMaterializedMaxSeq,
        markSessionKnownRemoteSeq,
        markSessionTranscriptDeferred,
        markSessionTranscriptStale,
        markSessionStateHydrationDeferred,
        onReadyProjectionAdvance,
        onMessageGapDetected,
        assumeUsers,
        applyTodoSocketUpdates,
        invalidateMachines,
        invalidateSessions,
        invalidateArtifacts,
        invalidateFriends,
        invalidateFriendRequests,
        invalidateFeed,
        invalidateAutomations,
        invalidateAutomationsCoalesced,
        invalidateTodos,
        onTaskLifecycleEvent,
        log,
    } = params;

    if (!shouldContinue()) return;

    if (updateData.body.t === 'new-message') {
        const getSessionMaterializedMaxSeqForGapDetection = (sessionId: string) =>
            Math.max(
                getSessionMaterializedMaxSeq(sessionId),
                socketMessageApplyCoalescer.getQueuedMaxSeq(sessionId),
            );

        socketMessageApplyHandlers = {
            applyMessages,
            onNormalizedMessagesApplied: ingestWorkspaceMutationMessages,
            markSessionMaterializedMaxSeq,
        };
        await handleNewMessageSocketUpdate({
            updateData,
            getSessionEncryption: (sessionId) => encryption.getSessionEncryption(sessionId),
            getSession: getSocketSessionApplyBase,
            getSessionProjection: (sessionId) => storage.getState().sessionListRenderables[sessionId],
            applySessions: (sessions) => {
                if (!shouldContinue()) return;
                enqueueSocketSessionApplyGuarded(applySessions, sessions, shouldContinue, {
                    deferLeadingBatch: sessions.every((session) => !isSessionFullContentConsumerActiveForRealtime(session.id, sourceServerId)),
                });
            },
            fetchSessions: () => {
                if (!shouldContinue()) return;
                fetchSessions();
            },
            applyCacheOnlySessionProjectionPatch: ({ sessionId, updateData, rawMessage, messageSeq }) => {
                if (!shouldContinue()) return false;
                return applyCacheOnlyDurableMessageProjectionPatch({
                    sessionId,
                    updateData,
                    rawMessage,
                    messageSeq,
                    shouldContinue,
                });
            },
            applyMessages: (sessionId, messages) => {
                if (!shouldContinue()) return;
                applyMessages(sessionId, messages);
            },
            enqueueMessages: (sessionId, messages) => socketMessageApplyCoalescer.enqueue(sessionId, messages, {
                deferLeadingBatch: !isSessionFullContentConsumerActiveForRealtime(sessionId, sourceServerId),
                shouldContinue,
            }),
            isMutableToolCall: (sessionId, toolUseId) => storage.getState().isMutableToolCall(sessionId, toolUseId),
            invalidateScmStatus: (sessionId) => scmStatusSync.invalidateFromMutation(sessionId),
            isSessionMessagesLoaded,
            isSessionActivelyViewed: (sessionId) => isSessionSurfaceVisible(sessionId, sourceServerId),
            isSessionFullContentConsumerActive: (sessionId) => isSessionFullContentConsumerActiveForRealtime(sessionId, sourceServerId),
            realtimeProjectionMode: socketSessionApplyTuning.sessionRealtimeProjectionMode,
            getSessionMaterializedMaxSeq: getSessionMaterializedMaxSeqForGapDetection,
            markSessionMaterializedMaxSeq,
            markSessionKnownRemoteSeq,
            markSessionTranscriptDeferred,
            markSessionTranscriptStale,
            onMessageGapDetected,
            onTaskLifecycleEvent: onTaskLifecycleEvent
                ? (sessionId, event) => {
                    if (!shouldContinue()) return;
                    onTaskLifecycleEvent(sessionId, event);
                }
                : undefined,
        });
    } else if (updateData.body.t === 'message-updated') {
        const getSessionMaterializedMaxSeqForGapDetection = (sessionId: string) =>
            Math.max(
                getSessionMaterializedMaxSeq(sessionId),
                socketMessageApplyCoalescer.getQueuedMaxSeq(sessionId),
            );

        socketMessageApplyCoalescer.dropQueuedMessageIds(updateData.body.sid, [updateData.body.message.id]);

        await handleMessageUpdatedSocketUpdate({
            updateData,
            getSessionEncryption: (sessionId) => encryption.getSessionEncryption(sessionId),
            getSession: getSocketSessionApplyBase,
            getSessionProjection: (sessionId) => storage.getState().sessionListRenderables[sessionId],
            applySessions: (sessions) => {
                if (!shouldContinue()) return;
                const hiddenProjectionSessions = sessions.filter((session) => (
                    !isSessionFullContentConsumerActiveForRealtime(session.id, sourceServerId)
                ));
                const liveTranscriptSessions = sessions.filter((session) => (
                    isSessionFullContentConsumerActiveForRealtime(session.id, sourceServerId)
                ));
                if (hiddenProjectionSessions.length > 0) {
                    enqueueSocketSessionApplyGuarded(applySessions, hiddenProjectionSessions, shouldContinue, {
                        deferLeadingBatch: true,
                    });
                }
                if (liveTranscriptSessions.length > 0) {
                    applySessionsAfterFlushingQueued(applySessions, liveTranscriptSessions);
                }
            },
            fetchSessions: () => {
                if (!shouldContinue()) return;
                fetchSessions();
            },
            applyCacheOnlySessionProjectionPatch: ({ sessionId, updateData, rawMessage, messageSeq }) => {
                if (!shouldContinue()) return false;
                return applyCacheOnlyDurableMessageProjectionPatch({
                    sessionId,
                    updateData,
                    rawMessage,
                    messageSeq,
                    shouldContinue,
                });
            },
            applyMessages: (sessionId, messages) => {
                if (!shouldContinue()) return;
                applyMessages(sessionId, messages);
            },
            onNormalizedMessagesApplied: ingestWorkspaceMutationMessages,
            isMutableToolCall: (sessionId, toolUseId) => storage.getState().isMutableToolCall(sessionId, toolUseId),
            invalidateScmStatus: (sessionId) => scmStatusSync.invalidateFromMutation(sessionId),
            isSessionMessagesLoaded,
            isSessionActivelyViewed: (sessionId) => isSessionSurfaceVisible(sessionId, sourceServerId),
            isSessionFullContentConsumerActive: (sessionId) => isSessionFullContentConsumerActiveForRealtime(sessionId, sourceServerId),
            realtimeProjectionMode: socketSessionApplyTuning.sessionRealtimeProjectionMode,
            getSessionMaterializedMaxSeq: getSessionMaterializedMaxSeqForGapDetection,
            markSessionMaterializedMaxSeq,
            markSessionKnownRemoteSeq,
            markSessionTranscriptDeferred,
            markSessionTranscriptStale,
            onMessageGapDetected,
            onTaskLifecycleEvent: onTaskLifecycleEvent
                ? (sessionId, event) => {
                    if (!shouldContinue()) return;
                    onTaskLifecycleEvent(sessionId, event);
                }
                : undefined,
        });
    } else if (updateData.body.t === 'new-session') {
        log.log('🆕 New session update received');
        if (!shouldContinue()) return;
        invalidateSessions();
    } else if (updateData.body.t === 'delete-session') {
        log.log('🗑️ Delete session update received');
        socketSessionApplyCoalescer.dropSessionIds([updateData.body.sid]);
        socketMessageApplyCoalescer.dropSessionIds([updateData.body.sid]);
        durableMessageProjectionPatchCoalescer.dropSessionIds([updateData.body.sid]);
        cacheOnlySessionUpdateProjectionPatchCoalescer.dropSessionIds([updateData.body.sid]);
        cacheOnlySessionUpdateSeqBySession.delete(updateData.body.sid);
        transcriptStreamSegmentSocketQueueController.drop(updateData.body.sid);
        handleDeleteSessionSocketUpdate({
            sessionId: updateData.body.sid,
            deleteSession: (sessionId) => storage.getState().deleteSession(sessionId),
            removeSessionEncryption: (sessionId) => encryption.removeSessionEncryption(sessionId),
            removeProjectManagerSession: (sessionId) => projectManager.removeSession(sessionId),
            clearScmStatusForSession: (sessionId) => scmStatusSync.clearForSession(sessionId),
            log,
        });
    } else if (updateData.body.t === 'pending-changed') {
        const sessionId = updateData.body.sid;
        const state = storage.getState();
        const session = getSocketSessionApplyBase(sessionId);
        const pendingPatch = buildPendingChangedSessionPatch(updateData.body);
        if (!session) {
            const cachedRenderable = state.sessionListRenderables[sessionId];
            if (cachedRenderable) {
                state.applySessionListRenderablePatches([
                    {
                        sessionId,
                        patch: pendingPatch,
                    },
                ]);
                requestVisibleCacheOnlySessionHydration({
                    sessionId,
                    sourceServerId,
                    hydrateSessionById,
                    invalidateSessions,
                });
                return;
            }

            if (!shouldContinue()) return;
            requestTargetedSessionHydration({
                sessionId,
                reason: 'socket-update-missing-session',
                hydrateSessionById,
                invalidateSessions,
            });
            return;
        }

        enqueueSocketSessionApplyGuarded(applySessions, [{
            ...session,
            ...pendingPatch,
        }], shouldContinue);
    } else if (updateData.body.t === 'update-session') {
        const state = storage.getState();
        const session = getSocketSessionApplyBase(updateData.body.id);
        if (!session) {
            const cachedRenderable = state.sessionListRenderables[updateData.body.id];
            if (!cachedRenderable) {
                if (!shouldContinue()) return;
                requestTargetedSessionHydration({
                    sessionId: updateData.body.id,
                    reason: 'socket-update-missing-session',
                    hydrateSessionById,
                    invalidateSessions,
                });
                return;
            }

            const hasStatePayload = Boolean(updateData.body.metadata || updateData.body.agentState);
            const sessionEncryption = encryption.getSessionEncryption(updateData.body.id);
            if (hasStatePayload && sessionEncryption && updateData.body.metadata == null) {
                if (!shouldContinue()) return;
                requestTargetedSessionHydration({
                    sessionId: updateData.body.id,
                    reason: 'socket-update-unpatchable',
                    hydrateSessionById,
                    invalidateSessions,
                });
                return;
            }
            const renderablePatch = !hasStatePayload && hasSafeCacheOnlySessionProjectionFields(updateData.body)
                ? buildCacheOnlySessionProjectionPatch({
                    renderable: cachedRenderable,
                    updateBody: updateData.body,
                    updateSeq: updateData.seq,
                    updateCreatedAt: updateData.createdAt,
                })
                : await buildUpdatedSessionListRenderablePatchFromSocketUpdate({
                    renderable: cachedRenderable,
                    updateBody: updateData.body,
                    updateSeq: updateData.seq,
                    updateCreatedAt: updateData.createdAt,
                    sessionEncryption,
                    hydrateState: sessionEncryption
                        ? {
                            metadata: updateData.body.metadata != null,
                            agentState: false,
                        }
                        : undefined,
                });
            const readySeq = shouldReportReadyProjectionAdvance(cachedRenderable, updateData.body.latestReadyEventSeq);
            if (!shouldContinue()) return;
            applyCacheOnlySessionUpdateProjectionPatch({
                sessionId: updateData.body.id,
                renderable: cachedRenderable,
                patch: renderablePatch,
                updateSeq: updateData.seq,
                shouldContinue,
            });
            if (sessionEncryption && updateData.body.agentState != null) {
                markSessionStateHydrationDeferred?.(updateData.body.id);
            }
            requestVisibleCacheOnlySessionHydration({
                sessionId: updateData.body.id,
                sourceServerId,
                hydrateSessionById,
                invalidateSessions,
            });
            if (readySeq !== null) {
                onReadyProjectionAdvance?.(updateData.body.id, readySeq);
            }
            return;
        }

        const fullContentConsumerActive = isSessionFullContentConsumerActiveForRealtime(updateData.body.id, sourceServerId);
        const sessionEncryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
        const sessionEncryption = sessionEncryptionMode === 'plain'
            ? null
            : encryption.getSessionEncryption(updateData.body.id);
        const shouldHydrateMetadata =
            updateData.body.metadata != null
            && (
                sessionEncryptionMode === 'plain'
                || sessionEncryption != null
            );
        const shouldHydrateAgentState =
            updateData.body.agentState != null
            && (
                sessionEncryptionMode === 'plain'
                || (
                    sessionEncryption != null
                    && (
                        fullContentConsumerActive
                        || shouldHydrateEncryptedAgentStateForHiddenSession({
                            session,
                            updateBody: updateData.body,
                        })
                    )
                )
            );
        const shouldHydrateSessionState = shouldHydrateMetadata || shouldHydrateAgentState;
        if (
            (updateData.body.metadata != null && !shouldHydrateMetadata)
            || (updateData.body.agentState != null && !shouldHydrateAgentState)
        ) {
            markSessionStateHydrationDeferred?.(updateData.body.id);
        }
        if (sessionEncryptionMode === 'e2ee' && shouldHydrateSessionState && !sessionEncryption) {
            console.error(`Session encryption not found for ${updateData.body.id} - this should never happen`);
            return;
        }

        const { nextSession, agentState } = shouldHydrateSessionState
            ? await buildUpdatedSessionFromSocketUpdate({
                session,
                updateBody: updateData.body,
                updateSeq: updateData.seq,
                updateCreatedAt: updateData.createdAt,
                sessionEncryption,
                hydrateState: {
                    metadata: shouldHydrateMetadata,
                    agentState: shouldHydrateAgentState,
                },
            })
            : {
                nextSession: buildUpdatedSessionProjectionFromSocketUpdate({
                    session,
                    updateBody: updateData.body,
                    updateSeq: updateData.seq,
                    updateCreatedAt: updateData.createdAt,
                }),
                agentState: session.agentState,
            };
        const readySeq = shouldReportReadyProjectionAdvance(session, nextSession.latestReadyEventSeq);

        if (!shouldContinue()) return;
        enqueueSocketSessionApplyGuarded(applySessions, [nextSession], shouldContinue);
        if (readySeq !== null) {
            onReadyProjectionAdvance?.(updateData.body.id, readySeq);
        }

        // Agent state updates can be very frequent and are not a reliable proxy for SCM changes.
        // SCM refresh cadence is handled by screen-scoped intervals (session/files views) and
        // by explicit invalidations after SCM mutations.
        if (shouldHydrateSessionState && updateData.body.agentState) {
            for (const nextRequest of deriveNewAgentRequests(session.agentState?.requests, agentState?.requests)) {
                notifyActivityAgentRequest({
                    sessionId: updateData.body.id,
                    requestId: nextRequest.requestId,
                    requestKind: nextRequest.requestKind,
                    toolName: nextRequest.toolName,
                    toolArgs: nextRequest.toolArgs,
                });
            }

            // Check for new permission requests and notify voice assistant
            reportNewAgentRequestsFromSessionTransition(
                { id: updateData.body.id, agentState: session.agentState ?? null } as Session,
                { id: updateData.body.id, agentState: agentState ?? null } as Session,
            );

            // Re-fetch messages when control returns to mobile (local -> remote mode switch)
            // This catches up on any messages that were exchanged while desktop had control
            const wasControlledByUser = session.agentState?.controlledByUser;
            const isNowControlledByUser = agentState?.controlledByUser;
            if (didControlReturnToMobile(wasControlledByUser, isNowControlledByUser)) {
                writeSyncDebugLog(log, `🔄 Control returned to mobile for session ${updateData.body.id}, re-fetching messages`);
                if (!shouldContinue()) return;
                onSessionVisible(updateData.body.id);
            }
        }
    } else if (updateData.body.t === 'update-account') {
        const accountUpdate = updateData.body;
        const currentProfile = storage.getState().profile;

        await handleUpdateAccountSocketUpdate({
            accountUpdate,
            updateCreatedAt: updateData.createdAt,
            currentProfile,
            encryption,
            settingsScope,
            applyProfile: (profile) => {
                if (!shouldContinue()) return;
                if (settingsScope) {
                    storage.getState().applyProfileForScope(settingsScope, profile);
                    return;
                }
                storage.getState().applyProfile(profile);
            },
            applySettings: (settings, version) => {
                if (!shouldContinue()) return;
                storage.getState().applySettings(settings, version);
            },
            applySettingsForScope: (scope, settings, version) =>
                shouldContinue() ? storage.getState().applySettingsForScope(scope, settings, version) : undefined,
            getLocalSettings: () => storage.getState().settings,
            log,
        });
    } else if (updateData.body.t === 'new-machine') {
        log.log('🖥️ New machine update received');
        const machineUpdate = updateData.body;
        const machineId = machineUpdate.machineId;

        // Initialize machine encryption immediately when possible so the subsequent
        // update-machine event (emitted for backward compatibility) can be decrypted
        // without racing a full machines refresh.
        //
        // NOTE: When the dataEncryptionKey is null, we still initialize with null so
        // the machine has a fallback encryptor available (legacy path).
        let decryptedDataKey: Uint8Array | null = null;
        if (typeof (machineUpdate as any).dataEncryptionKey === 'string' && (machineUpdate as any).dataEncryptionKey.length > 0) {
            try {
                decryptedDataKey = await encryption.decryptEncryptionKey((machineUpdate as any).dataEncryptionKey);
            } catch (error) {
                console.error(`Failed to decrypt machine dataEncryptionKey for ${machineId}; falling back to legacy machine encryption.`, error);
            }
        }
        if (!shouldContinue()) return;
        await encryption.initializeMachines(new Map([[machineId, decryptedDataKey]]));
        if (!shouldContinue()) return;

        // Apply a placeholder immediately so UI state (e.g. onboarding) can react
        // even if machine-activity ephemerals arrive before a full machines refresh.
        storage.getState().applyMachines([{
            id: machineId,
            seq: machineUpdate.seq,
            createdAt: machineUpdate.createdAt,
            updatedAt: machineUpdate.updatedAt,
            active: machineUpdate.active,
            activeAt: machineUpdate.activeAt,
            revokedAt: null,
            metadata: null,
            metadataVersion: machineUpdate.metadataVersion,
            daemonState: null,
            daemonStateVersion: machineUpdate.daemonStateVersion,
        }], false, { sourceServerId });

        // Hydrate machine details + encryption keys via the existing machines sync pipeline.
        invalidateMachines();
    } else if (updateData.body.t === 'update-machine') {
        const machineUpdate = updateData.body;
        const machineId = machineUpdate.machineId; // Changed from .id to .machineId
        const machine = storage.getState().machines[machineId];

        const updatedMachine = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate,
            updateSeq: updateData.seq,
            updateCreatedAt: updateData.createdAt,
            existingMachine: machine,
            getMachineEncryption: (id) => encryption.getMachineEncryption(id),
        });
        if (!updatedMachine) {
            invalidateMachines();
            return;
        }
        if (!shouldContinue()) return;

        // Update storage via applyMachines, which may rebuild the active-server session list index if
        // the machine update affects project-group headers (but should stay stable for activity-only changes).
        storage.getState().applyMachines([updatedMachine], false, { sourceServerId });
        if (!encryption.getMachineEncryption(machineId)) {
            invalidateMachines();
        }
    } else if (updateData.body.t === 'relationship-updated') {
        log.log('👥 Received relationship-updated update');
        const normalized = normalizeRelationshipUpdatedUpdateBody(updateData.body, {
            currentUserId: storage.getState().profile?.id ?? null,
        });
        if (!normalized) {
            invalidateFriends();
            invalidateFriendRequests();
            invalidateFeed();
            return;
        }

        handleRelationshipUpdatedSocketUpdate({
            relationshipUpdate: normalized,
            applyRelationshipUpdate: (update) => storage.getState().applyRelationshipUpdate(update),
            invalidateFriends,
            invalidateFriendRequests,
            invalidateFeed,
        });
    } else if (updateData.body.t === 'new-artifact') {
        log.log('📦 Received new-artifact update');
        const artifactUpdate = updateData.body;
        const artifactId = artifactUpdate.artifactId;

        await handleNewArtifactSocketUpdate({
            artifactId,
            dataEncryptionKey: artifactUpdate.dataEncryptionKey,
            header: artifactUpdate.header,
            headerVersion: artifactUpdate.headerVersion,
            body: artifactUpdate.body,
            bodyVersion: artifactUpdate.bodyVersion,
            seq: artifactUpdate.seq,
            createdAt: artifactUpdate.createdAt,
            updatedAt: artifactUpdate.updatedAt,
            encryption,
            artifactDataKeys,
            addArtifact: (artifact) => storage.getState().addArtifact(artifact),
            log,
        });
    } else if (updateData.body.t === 'update-artifact') {
        log.log('📦 Received update-artifact update');
        const artifactUpdate = updateData.body;
        const artifactId = artifactUpdate.artifactId;

        await handleUpdateArtifactSocketUpdate({
            artifactId,
            createdAt: updateData.createdAt,
            header: artifactUpdate.header,
            body: artifactUpdate.body,
            artifactDataKeys,
            getExistingArtifact: (id) => storage.getState().artifacts[id],
            updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
            invalidateArtifactsSync: invalidateArtifacts,
            log,
        });
    } else if (updateData.body.t === 'delete-artifact') {
        log.log('📦 Received delete-artifact update');
        const artifactUpdate = updateData.body;
        const artifactId = artifactUpdate.artifactId;

        handleDeleteArtifactSocketUpdate({
            artifactId,
            deleteArtifact: (id) => storage.getState().deleteArtifact(id),
            artifactDataKeys,
        });
    } else if (updateData.body.t === 'new-feed-post') {
        log.log('📰 Received new-feed-post update');
        const feedUpdate = updateData.body;

        const parsedBody = FeedBodySchema.safeParse((feedUpdate as any).body);
        if (!parsedBody.success) {
            invalidateFeed();
            return;
        }

        await handleNewFeedPostUpdate({
            feedUpdate: {
                ...feedUpdate,
                body: parsedBody.data,
            },
            assumeUsers,
            getUsers: () => storage.getState().users,
            applyFeedItems: (items) => storage.getState().applyFeedItems(items),
            log,
        });
    } else if (updateData.body.t === 'kv-batch-update') {
        log.log('📝 Received kv-batch-update');
        const kvUpdate = updateData.body;

        await handleTodoKvBatchUpdate({
            kvUpdate,
            applyTodoSocketUpdates,
            invalidateTodosSync: invalidateTodos,
            log,
        });
    } else if (applyAutomationSocketUpdate({
        updateType: updateData.body.t,
        invalidateAutomations,
        invalidateAutomationsCoalesced,
    })) {
        // handled by automation domain
    } else if (
        updateData.body.t === 'session-shared' ||
        updateData.body.t === 'session-share-updated'
    ) {
        const sessionId = readShareSessionId(updateData.body);
        if (!sessionId) {
            invalidateSessions();
            return;
        }

        const patch = buildShareSessionPatch(updateData.body);
        const hasPermissionProjection = hasSelfSufficientSharePermission(updateData.body);
        const session = getSocketSessionApplyBase(sessionId);
        if (session) {
            enqueueSocketSessionApplyGuarded(applySessions, [{
                ...session,
                ...patch,
            }], shouldContinue);
            if (!hasPermissionProjection) {
                requestTargetedSessionHydration({
                    sessionId,
                    reason: 'share-visibility-change',
                    hydrateSessionById,
                    invalidateSessions,
                });
            }
            return;
        }

        const renderable = storage.getState().sessionListRenderables[sessionId];
        if (renderable) {
            storage.getState().applySessionListRenderablePatches([{
                sessionId,
                patch,
            }]);
            if (!hasPermissionProjection) {
                requestTargetedSessionHydration({
                    sessionId,
                    reason: 'share-visibility-change',
                    hydrateSessionById,
                    invalidateSessions,
                });
            }
            return;
        }

        requestTargetedSessionHydration({
            sessionId,
            reason: 'share-visibility-change',
            hydrateSessionById,
            invalidateSessions,
        });
    } else if (updateData.body.t === 'session-share-revoked') {
        const sessionId = readShareSessionId(updateData.body);
        if (!sessionId) {
            invalidateSessions();
            return;
        }
        socketSessionApplyCoalescer.dropSessionIds([sessionId]);
        socketMessageApplyCoalescer.dropSessionIds([sessionId]);
        durableMessageProjectionPatchCoalescer.dropSessionIds([sessionId]);
        cacheOnlySessionUpdateProjectionPatchCoalescer.dropSessionIds([sessionId]);
        cacheOnlySessionUpdateSeqBySession.delete(sessionId);
        transcriptStreamSegmentSocketQueueController.drop(sessionId);
        handleDeleteSessionSocketUpdate({
            sessionId,
            deleteSession: (targetSessionId) => storage.getState().deleteSession(targetSessionId),
            removeSessionEncryption: (targetSessionId) => encryption.removeSessionEncryption(targetSessionId),
            removeProjectManagerSession: (targetSessionId) => projectManager.removeSession(targetSessionId),
            clearScmStatusForSession: (targetSessionId) => scmStatusSync.clearForSession(targetSessionId),
            log,
        });
    } else if (
        updateData.body.t === 'public-share-created' ||
        updateData.body.t === 'public-share-updated' ||
        updateData.body.t === 'public-share-deleted'
    ) {
        // Sharing changes affect which sessions are visible/accessible and some metadata
        // shown in UI. For now, refresh the session list; sharing screens fetch details
        // via explicit endpoints.
        invalidateSessions();
    }
}

export function flushActivityUpdates(params: {
    updates: Map<string, ApiEphemeralActivityUpdate>;
    applySessions: ApplySessions;
    sourceServerId?: string | null;
    shouldContinue?: () => boolean;
    hydrateSessionById?: (sessionId: string, reason: SocketSessionHydrationReason) => void;
}): void {
    const { updates, applySessions, sourceServerId, shouldContinue = () => true, hydrateSessionById } = params;
    if (!shouldContinue()) return;

    const sessions: Session[] = [];
    const renderablePatches: Array<{
        sessionId: string;
        patch: ActivityRenderablePatch;
    }> = [];
    let renderableTimestampOnlyPatchCount = 0;
    let renderableTimestampOnlySkippedFreshPatchCount = 0;

    for (const [sessionId, update] of updates) {
        const session = storage.getState().sessions[sessionId];
        if (session) {
            const runtimePresence = resolveSessionRuntimePresenceFields({
                thinking: update.thinking ?? false,
                thinkingAt: update.activeAt,
                latestTurnStatus: session.latestTurnStatus,
                latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
            });
            const nextThinking = runtimePresence.thinking;
            const patch: ActivityRenderablePatch = {
                active: update.active,
                activeAt: update.activeAt,
                thinking: nextThinking,
                thinkingAt: runtimePresence.thinkingAt,
                presence: update.active ? 'online' as const : update.activeAt,
                updatedAt: update.activeAt,
            };
            const isTimestampOnlyPatch = isTimestampOnlyActivityPatch(session, patch);
            const isTurningOff = update.active === false && nextThinking === false;
            const isThinkingResurrection = nextThinking === true && session.thinking !== true;

            // Most state-changing activity ephemerals should be ignored when they predate a newer durable/lifecycle update
            // (for example a recent turn_aborted/task_complete clear). Otherwise old "thinking=true" ephemerals
            // can resurrect a completed session into a stuck state.
            //
            // Timestamp-only runtime heartbeats are different: durable message/session projections can advance
            // `updatedAt` while the runtime remains actively thinking. Those heartbeats must still refresh
            // activeAt/thinkingAt so the visible working status does not expire while the daemon is still active.
            //
            // Exception: when we receive a "turn off" activity update (active=false, thinking=false), apply it
            // even if it predates session.updatedAt, as long as it is not older than the session's last-known
            // activity timestamp. This prevents "session ended" updates from being dropped when a terminal
            // shutdown message (or similar durable update) bumps updatedAt slightly after activeAt.
            if (isTimestampOnlyPatch && isStaleTimestampOnlyActivityPatch(session, patch)) {
                continue;
            }
            if (!isTimestampOnlyPatch) {
                if (isTurningOff) {
                    if (update.activeAt < session.activeAt) continue;
                } else {
                    // Be slightly stricter when an activity update would re-enable thinking, because some
                    // server clocks/reporting paths can produce equal timestamps for the lifecycle clear and
                    // the older "thinking=true" activity update. Using `<=` here prevents resurrecting sessions
                    // into a stuck "working" state after the turn has completed.
                    if (isThinkingResurrection) {
                        if (update.activeAt <= session.updatedAt) continue;
                    } else {
                        if (update.activeAt < session.updatedAt) continue;
                    }
                }
            }
            sessions.push({
                ...session,
                active: update.active,
                activeAt: update.activeAt,
                thinking: nextThinking,
                thinkingAt: runtimePresence.thinkingAt,
            });
            continue;
        }

        const renderable = storage.getState().sessionListRenderables[sessionId];
        if (renderable) {
            if (isCacheOnlySessionHydrationAnchorActive(sessionId, sourceServerId)) {
                hydrateSessionById?.(sessionId, 'socket-update-missing-session');
            }
            const runtimePresence = resolveSessionRuntimePresenceFields({
                thinking: update.thinking ?? false,
                thinkingAt: update.activeAt,
                latestTurnStatus: renderable.latestTurnStatus,
                latestTurnStatusObservedAt: renderable.latestTurnStatusObservedAt,
            });
            const nextThinking = runtimePresence.thinking;
            const patch = {
                active: update.active,
                activeAt: update.activeAt,
                thinking: nextThinking,
                thinkingAt: runtimePresence.thinkingAt,
                presence: update.active ? 'online' as const : update.activeAt,
                updatedAt: Math.max(finiteNumber(renderable.updatedAt) ?? update.activeAt, update.activeAt),
            };
            const isTimestampOnlyPatch = isTimestampOnlyActivityPatch(renderable, patch);
            const isTurningOff = update.active === false && nextThinking === false;
            if (!isTimestampOnlyPatch) {
                if (isTurningOff) {
                    if (update.activeAt < renderable.activeAt) continue;
                } else if (update.activeAt < renderable.updatedAt) {
                    continue;
                }
            }
            if (isTimestampOnlyPatch && shouldSkipFreshTimestampOnlyRenderableActivityPatch(renderable, patch)) {
                renderableTimestampOnlySkippedFreshPatchCount += 1;
                continue;
            }
            if (isTimestampOnlyPatch) {
                renderableTimestampOnlyPatchCount += 1;
            }
            renderablePatches.push({
                sessionId,
                patch,
            });
        }
    }

    if (sessions.length > 0 || renderablePatches.length > 0 || renderableTimestampOnlySkippedFreshPatchCount > 0) {
        syncPerformanceTelemetry.count('sync.socket.sessions.activity.flush', {
            updates: updates.size,
            sessions: sessions.length,
            renderablePatches: renderablePatches.length,
            renderableTimestampOnlyPatches: renderableTimestampOnlyPatchCount,
            renderableTimestampOnlySkippedFreshPatches: renderableTimestampOnlySkippedFreshPatchCount,
            renderableStateChangePatches: renderablePatches.length - renderableTimestampOnlyPatchCount,
        });
    }
    if (sessions.length > 0) {
        if (!shouldContinue()) return;
        applySessionsAfterFlushingQueued(applySessions, sessions);
    }
    if (renderablePatches.length > 0) {
        if (!shouldContinue()) return;
        storage.getState().applySessionListRenderablePatches(renderablePatches);
    }
}

export function flushMachineActivityUpdates(params: {
    updates: Map<string, MachineActivityUpdate>;
    applyMachines: (machines: Machine[], options?: { sourceServerId?: string | null }) => void;
    sourceServerId?: string | null;
    shouldContinue?: () => boolean;
}): void {
    const { updates, applyMachines, sourceServerId, shouldContinue = () => true } = params;
    if (!shouldContinue()) return;
    const machines: Machine[] = [];

    for (const [, updateData] of updates) {
        const existing = storage.getState().machines[updateData.id];
        const machine: Machine = existing ?? {
            id: updateData.id,
            seq: 0,
            createdAt: updateData.activeAt,
            updatedAt: updateData.activeAt,
            active: updateData.active,
            activeAt: updateData.activeAt,
            revokedAt: null,
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        machines.push(buildMachineFromMachineActivityEphemeralUpdate({ machine, updateData }));
    }

    if (machines.length > 0) {
        if (!shouldContinue()) return;
        applyMachines(machines, { sourceServerId });
    }
}

export function handleEphemeralSocketUpdate(params: {
    update: unknown;
    sourceServerId?: string | null;
    shouldContinue?: () => boolean;
    addActivityUpdate: (update: ApiEphemeralActivityUpdate) => void;
    addMachineActivityUpdate: (update: MachineActivityUpdate) => void;
    getSessionEncryption: Encryption['getSessionEncryption'];
    getSession: (sessionId: string) => Session | undefined;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    updateExternalSessionTranscript?: (update: ExternalSessionTranscriptUpdatedEphemeralUpdate) => Promise<void> | void;
}): Promise<void> {
    const {
        update,
        sourceServerId = null,
        shouldContinue = () => true,
        addActivityUpdate,
        addMachineActivityUpdate,
        getSessionEncryption,
        getSession,
        applyMessages,
        updateExternalSessionTranscript,
    } = params;

    const updateData = parseEphemeralUpdate(update);
    if (!updateData) return Promise.resolve();
    if (!shouldContinue()) return Promise.resolve();

    // Process activity updates through smart debounce accumulator
    if (updateData.type === 'activity') {
        if (!shouldContinue()) return Promise.resolve();
        addActivityUpdate(updateData);
    } else if (updateData.type === 'machine-activity') {
        // Handle machine activity updates through batching accumulator
        if (!shouldContinue()) return Promise.resolve();
        addMachineActivityUpdate({ id: updateData.id, active: updateData.active, activeAt: updateData.activeAt });
    } else if (updateData.type === 'execution-run-updated') {
        if (!shouldContinue()) return Promise.resolve();
        notifyExecutionRunActivity(updateData.sessionId);
    } else if (updateData.type === 'direct-session-transcript-delta') {
        if (!shouldContinue()) return Promise.resolve();
        return Promise.resolve(updateExternalSessionTranscript?.(updateData as ExternalSessionTranscriptUpdatedEphemeralUpdate));
    } else if (updateData.type === 'transcript-stream-segment') {
        const entry: TranscriptStreamSegmentSocketQueueEntry = {
            update: updateData,
            sourceServerId,
            shouldContinue,
            getSessionEncryption,
            getSession,
            applyMessages,
        };
        return transcriptStreamSegmentSocketQueueController.handle(entry);
    }

    // daemon-status ephemeral updates are deprecated, machine status is handled via machine-activity
    return Promise.resolve();
}

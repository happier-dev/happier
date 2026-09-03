import type { ApiEphemeralActivityUpdate, ApiMessage, ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Encryption } from '@/sync/encryption/encryption';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { EphemeralUpdate } from '@happier-dev/protocol/updates';
import type { ActionOperationRevisionEphemeralV1 } from '@happier-dev/protocol';
import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { buildPendingChangedSessionPatch } from './pendingChangedSessionPatch';
import { isSessionVisible } from '@/sync/domains/session/activeViewingSession';
import { computeNextSessionSeqFromUpdate } from '@/sync/domains/session/sequence/realtimeSessionSeq';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import { resolveSessionReadableSeq } from '@/sync/domains/session/readCursor/resolveSessionReadableSeq';
import { resolveSessionLiveConsumption } from '@/sync/runtime/sessionLiveConsumption';
import type { MachineActivityUpdate } from '@/sync/reducer/machineActivityAccumulator';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { ingestWorkspaceMutationMessages } from '@/scm/refresh/workspaceMutationIngestionRuntime';
import { deliverHiddenSessionScmMutationSignal } from '@/sync/engine/sessions/hiddenSessionScmMutationSignal';
import { voiceHooks } from '@/voice/context/voiceHooks';
import { reportNewAgentRequestsFromSessionTransition } from '@/voice/context/reportNewAgentRequestsFromSessionTransition';
import { deriveNewAgentRequests } from '@/sync/domains/permissions/deriveNewAgentRequests';
import { notifyActivityAgentRequest } from '@/activity/notifications/runtime/activityLocalNotificationBus';
import { didControlReturnToMobile } from '@/sync/domains/session/control/controlledByUserTransitions';
import { writeSyncDebugLog } from '@/sync/runtime/syncDebugLogging';
import {
    resolveSessionRuntimePresenceFields,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import {
    createSessionApplyCoalescer,
    type SessionApplyCoalescerSession,
} from '@/sync/engine/sessions/sessionApplyCoalescer';
import { createSessionListRenderableProjectionPatchCoalescer } from '@/sync/engine/sessions/sessionListRenderableProjectionPatchCoalescer';
import { createSessionMessageApplyCoalescer } from '@/sync/engine/sessions/sessionMessageApplyCoalescer';
import {
    setReceivedSessionMessageApplier,
    settleReceivedSessionMessages,
    trackSessionMessageMaterialization,
} from '@/sync/engine/sessions/sessionMessageMaterializationBarrier';
import { createSessionShellRefreshCoalescer } from '@/sync/engine/sessions/sessionShellRefreshCoalescer';
import { recordSessionInvalidationRequested } from '@/sync/engine/sessions/sessionInvalidationTelemetry';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { Settings } from '@/sync/domains/settings/settings';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import {
    buildUpdatedSessionProjectionFromSocketUpdate,
    buildUpdatedSessionFromSocketUpdate,
    handleDeleteSessionSocketUpdate,
    handleMessageUpdatedSocketUpdate,
    handleNewMessageSocketUpdate,
    isStrictlyNewerSessionMetadataVersion,
} from '@/sync/engine/sessions/syncSessions';
import {
    buildSessionRuntimeActivityProjectionPatch,
    hasSessionRuntimeActivityProjectionFields,
} from '@/sync/engine/sessions/sessionRuntimeActivityProjection';
import {
    buildSessionListRenderableMetadata,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import {
    storedSessionMessageAttentionImpact,
    storedSessionMessageAttentionImpactOrNull,
} from '@/sync/domains/messages/messageUserAttention';
import {
    handleTranscriptStreamSegmentEphemeralUpdate,
    type AnyTranscriptStreamSegmentEphemeralUpdate,
    type TranscriptStreamSegmentSessionMessageEncryption,
} from '@/sync/engine/sessions/handleTranscriptStreamSegmentEphemeralUpdate';
import { parsePlainSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import {
    buildMachineFromMachineActivityEphemeralUpdate,
    buildUpdatedMachineFromSocketUpdate,
} from '@/sync/engine/machines/syncMachines';
import { handleUpdateAccountSocketUpdate } from '@/sync/engine/account/syncAccount';
import {
    handleDeleteArtifactSocketUpdate,
    handleNewArtifactSocketUpdate,
    handleUpdateArtifactSocketUpdate,
    type ArtifactDataKeyCache,
} from '@/sync/engine/artifacts/syncArtifacts';
import {
    handleNewFeedPostUpdate,
    handleRelationshipUpdatedSocketUpdate,
    handleTodoKvBatchUpdate,
} from '@/sync/engine/social/syncFeed';
import { applyAutomationSocketUpdate } from '@/sync/engine/automations/automationSocketApply';
import { normalizeRelationshipUpdatedUpdateBody } from '@/sync/engine/social/relationshipUpdate';
import { parseEphemeralUpdate, parseUpdateContainer } from './socketParse';
import type { DirectSessionTranscriptUpdatedEphemeralUpdate } from './socketParse';
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
    updateData: Pick<ApiUpdateContainer, 'seq' | 'createdAt'>;
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
    | 'socket-update-attention-unknown'
    | 'socket-update-turn-projection'
    | 'share-visibility-change';

type ActivityRenderablePatch = Readonly<{
    active: boolean;
    activeAt: number;
    thinking: boolean;
    thinkingAt: number;
    presence: 'online' | number;
    updatedAt: number;
}>;

type ActivityRenderableProjectionPatchPayload = Readonly<{
    patch: ActivityRenderablePatch;
}>;

const CACHE_ONLY_ACTIVITY_TIMESTAMP_PATCH_MIN_INTERVAL_MS = Math.floor(SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS / 2);

let socketMessageApplyHandlers: SocketMessageApplyHandlers | null = null;
let socketSessionApplyHandlers: { applySessions: ApplySessions } | null = null;
const socketSessionApplyTuning = loadSyncTuning();

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

const cacheOnlySessionUpdateProjectionPatchCoalescer = createSessionListRenderableProjectionPatchCoalescer<CacheOnlySessionUpdateProjectionPatchPayload>({
    getConfig: () => ({
        enabled: socketSessionApplyTuning.sessionSocketApplyCoalescingEnabled,
        windowMs: socketSessionApplyTuning.activityUpdateDebounceMs,
        maxBatchSize: socketSessionApplyTuning.sessionSocketApplyCoalescingMaxBatchSize,
    }),
    readRenderable: (sessionId) => storage.getState().sessionListRenderables[sessionId],
    buildPatch: ({ payload, renderable }) => {
        const previousSeq = cacheOnlySessionUpdateSeqBySession.get(renderable.id) ?? 0;
        cacheOnlySessionUpdateSeqBySession.set(renderable.id, Math.max(previousSeq, Math.trunc(payload.updateSeq)));
        return payload.patch;
    },
    applyPatches: (patches) => storage.getState().applySessionListRenderablePatches(patches),
});

const activityRenderableProjectionPatchCoalescer = createSessionListRenderableProjectionPatchCoalescer<ActivityRenderableProjectionPatchPayload>({
    getConfig: () => ({
        enabled: socketSessionApplyTuning.sessionSocketApplyCoalescingEnabled,
        windowMs: socketSessionApplyTuning.sessionSocketApplyCoalescingWindowMs,
        maxBatchSize: socketSessionApplyTuning.sessionSocketApplyCoalescingMaxBatchSize,
    }),
    readRenderable: (sessionId) => storage.getState().sessionListRenderables[sessionId],
    buildPatch: ({ payload }) => payload.patch,
    applyPatches: (patches) => storage.getState().applySessionListRenderablePatches(patches),
});

const cacheOnlySessionUpdateSeqBySession = new Map<string, number>();

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

function isSessionFullContentConsumerActiveForRealtime(
    sessionId: string,
    sourceServerId?: string | null,
): boolean {
    // Delegate to the shared selector so realtime routing and catch-up consume the identical
    // live-content-consumer fan-out (single source of truth — the divergence is unrepresentable).
    return resolveSessionLiveConsumption(sessionId, sourceServerId).isFullContentConsumer;
}

function isSessionActivelyViewedForRealtime(
    sessionId: string,
    sourceServerId?: string | null,
): boolean {
    return resolveSessionLiveConsumption(sessionId, sourceServerId).isVisible;
}

function normalizeProjectionSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function shouldReportReadyProjectionAdvance(
    previous: Pick<SessionListRenderableSession, 'latestReadyEventSeq' | 'lastViewedSessionSeq' | 'metadata'> | Pick<Session, 'latestReadyEventSeq' | 'lastViewedSessionSeq' | 'metadata'> | null | undefined,
    nextReadySeq: unknown,
): nextReadySeq is number {
    const normalizedReadySeq = normalizeProjectionSeq(nextReadySeq);
    if (normalizedReadySeq === null) return false;
    const previousReadySeq = normalizeProjectionSeq(previous?.latestReadyEventSeq) ?? 0;
    const lastViewedSessionSeq =
        normalizeProjectionSeq(previous?.lastViewedSessionSeq)
        ?? normalizeProjectionSeq(previous?.metadata?.readStateV1?.sessionSeq)
        ?? 0;
    return normalizedReadySeq > previousReadySeq && normalizedReadySeq > lastViewedSessionSeq;
}

function isTerminalTurnStatus(value: unknown): boolean {
    return value === 'completed' || value === 'cancelled' || value === 'failed';
}

function shouldHydrateTurnsProjectionForSessionUpdate(params: Readonly<{
    updateBody: unknown;
    fullContentConsumerActive: boolean;
}>): boolean {
    if (!params.fullContentConsumerActive) return false;
    if (!params.updateBody || typeof params.updateBody !== 'object') return false;
    const latestTurnStatus = (params.updateBody as { latestTurnStatus?: unknown }).latestTurnStatus;
    return isTerminalTurnStatus(latestTurnStatus);
}

function buildCacheOnlySessionProjectionPatch(params: Readonly<{
    renderable: SessionListRenderableSession;
    updateBody: any;
    updateSeq: number;
    updateCreatedAt: number;
}>): Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>> {
    const { renderable, updateBody, updateSeq, updateCreatedAt } = params;
    const patch: Partial<Omit<SessionListRenderableSession, 'id'>> = {
        updatedAt: updateCreatedAt,
        seq: computeNextSessionSeqFromUpdate({
            currentSessionSeq: renderable.seq ?? 0,
            updateType: 'update-session',
            containerSeq: updateSeq,
            messageSeq: undefined,
        }),
    };
    const projectedActive =
        typeof updateBody.active === 'boolean'
            ? updateBody.active
            : renderable.active;
    const projectedActiveAt =
        typeof updateBody.activeAt === 'number' && Number.isFinite(updateBody.activeAt)
            ? Math.trunc(updateBody.activeAt)
            : renderable.activeAt;
    const projectedThinking =
        typeof updateBody.thinking === 'boolean'
            ? updateBody.thinking
            : updateBody.active === false
                ? false
                : renderable.thinking;
    const projectedThinkingAt =
        typeof updateBody.thinkingAt === 'number' && Number.isFinite(updateBody.thinkingAt)
            ? Math.trunc(updateBody.thinkingAt)
            : typeof updateBody.thinking === 'boolean' || updateBody.active === false
                ? projectedActiveAt
                : renderable.thinkingAt;
    if (typeof updateBody.active === 'boolean') patch.active = projectedActive;
    if (typeof updateBody.activeAt === 'number' && Number.isFinite(updateBody.activeAt)) patch.activeAt = projectedActiveAt;
    if (typeof updateBody.thinking === 'boolean' || updateBody.active === false) patch.thinking = projectedThinking;
    if (
        typeof updateBody.thinkingAt === 'number' && Number.isFinite(updateBody.thinkingAt)
        || typeof updateBody.thinking === 'boolean'
        || updateBody.active === false
    ) {
        patch.thinkingAt = projectedThinkingAt;
    }
    if (typeof updateBody.lastViewedSessionSeq === 'number') patch.lastViewedSessionSeq = updateBody.lastViewedSessionSeq;
    if (typeof updateBody.pendingPermissionRequestCount === 'number') {
        patch.hasPendingPermissionRequests = updateBody.pendingPermissionRequestCount > 0;
    }
    if (typeof updateBody.pendingUserActionRequestCount === 'number') {
        patch.hasPendingUserActionRequests = updateBody.pendingUserActionRequestCount > 0;
    }
    if (typeof updateBody.pendingRequestObservedAt === 'number' || updateBody.pendingRequestObservedAt === null) {
        patch.pendingRequestObservedAt = updateBody.pendingRequestObservedAt;
    }
    if (typeof updateBody.latestReadyEventSeq === 'number' || updateBody.latestReadyEventSeq === null) {
        patch.latestReadyEventSeq = updateBody.latestReadyEventSeq;
    }
    if (typeof updateBody.latestReadyEventAt === 'number' || updateBody.latestReadyEventAt === null) {
        patch.latestReadyEventAt = updateBody.latestReadyEventAt;
    }
    if (
        typeof updateBody.latestTurnId === 'string'
        || updateBody.latestTurnId === null
    ) {
        patch.latestTurnId = updateBody.latestTurnId;
    }
    if (
        updateBody.latestTurnStatus === 'in_progress'
        || updateBody.latestTurnStatus === 'completed'
        || updateBody.latestTurnStatus === 'cancelled'
        || updateBody.latestTurnStatus === 'failed'
        || updateBody.latestTurnStatus === null
    ) {
        patch.latestTurnStatus = updateBody.latestTurnStatus;
    }
    if (typeof updateBody.latestTurnStatusObservedAt === 'number' || updateBody.latestTurnStatusObservedAt === null) {
        patch.latestTurnStatusObservedAt = updateBody.latestTurnStatusObservedAt;
    }
    if (updateBody.lastRuntimeIssue === null || (updateBody.lastRuntimeIssue && typeof updateBody.lastRuntimeIssue === 'object')) {
        patch.lastRuntimeIssue = updateBody.lastRuntimeIssue;
    }
    if (typeof updateBody.archivedAt === 'number' || updateBody.archivedAt === null) {
        patch.archivedAt = updateBody.archivedAt;
    }
    if (typeof updateBody.meaningfulActivityAt === 'number' && Number.isFinite(updateBody.meaningfulActivityAt)) {
        patch.meaningfulActivityAt = updateBody.meaningfulActivityAt;
    }
    Object.assign(patch, buildSessionRuntimeActivityProjectionPatch(renderable, updateBody));
    patch.hasUnreadMessages = computeCacheOnlySessionRenderableHasUnreadMessages(renderable, patch);
    return patch;
}

function computeCacheOnlySessionRenderableHasUnreadMessages(
    renderable: SessionListRenderableSession,
    patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>,
    readableSeqOverride?: Readonly<{ seq: number | null; affectsUnread: boolean }> | null,
): boolean {
    const nextMetadata = patch.metadata === undefined ? renderable.metadata : patch.metadata;
    const nextLastViewedSessionSeq = patch.lastViewedSessionSeq === undefined
        ? renderable.lastViewedSessionSeq
        : patch.lastViewedSessionSeq;
    const shouldUsePatchedSessionSeq = readableSeqOverride?.affectsUnread !== false;
    const projectedReadableSeq = resolveSessionReadableSeq({
        messages: null,
        sessionSeq: shouldUsePatchedSessionSeq ? patch.seq ?? renderable.seq : renderable.seq,
        latestReadyEventSeq: patch.latestReadyEventSeq === undefined
            ? renderable.latestReadyEventSeq
            : patch.latestReadyEventSeq,
        latestTurnStatus: patch.latestTurnStatus === undefined
            ? renderable.latestTurnStatus
            : patch.latestTurnStatus,
        includeTerminalSessionSeq: true,
    }) ?? 0;
    const explicitReadableSeq = readableSeqOverride?.affectsUnread === true ? readableSeqOverride.seq : null;
    const readableSeq = explicitReadableSeq === null || explicitReadableSeq === undefined
        ? projectedReadableSeq
        : Math.max(projectedReadableSeq, Math.max(0, Math.trunc(explicitReadableSeq)));

    return computeHasUnreadActivity({
        sessionSeq: readableSeq,
        pendingActivityAt: 0,
        lastViewedSessionSeq: resolveLastViewedSessionSeq({
            lastViewedSessionSeq: nextLastViewedSessionSeq,
            metadata: nextMetadata,
        }),
        lastViewedPendingActivityAt: nextMetadata?.readStateV1?.pendingActivityAt,
    });
}

async function resolveCacheOnlySessionRenderableMetadata(params: Readonly<{
    updateBody: any;
    sessionEncryption: { decryptMetadata: (metadataVersion: number, metadata: string) => Promise<Metadata | null> } | null;
}>): Promise<Metadata | null | undefined> {
    const metadataPayload = params.updateBody.metadata;
    if (!metadataPayload) return undefined;
    if (params.sessionEncryption) {
        return params.sessionEncryption.decryptMetadata(metadataPayload.version, metadataPayload.value);
    }
    return parsePlainSessionMetadata(metadataPayload.value);
}

async function buildCacheOnlySessionUpdatePatch(params: Readonly<{
    renderable: SessionListRenderableSession;
    updateBody: any;
    updateSeq: number;
    updateCreatedAt: number;
    sessionEncryption: { decryptMetadata: (metadataVersion: number, metadata: string) => Promise<Metadata | null> } | null;
}>): Promise<Readonly<{
    patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
    stateHydrationDeferred: boolean;
}>> {
    const patch: Partial<Omit<SessionListRenderableSession, 'id'>> = {
        ...buildCacheOnlySessionProjectionPatch(params),
    };
    // Skip stale/out-of-order metadata so a lower-version payload cannot overwrite a newer title.
    // Equal versions are a no-op. Projection fields still apply (built above).
    const shouldApplyMetadata =
        params.updateBody.metadata != null
        && isStrictlyNewerSessionMetadataVersion(params.updateBody.metadata.version, params.renderable.metadataVersion);
    if (!shouldApplyMetadata) {
        return { patch, stateHydrationDeferred: false };
    }
    const metadata = await resolveCacheOnlySessionRenderableMetadata({
        updateBody: params.updateBody,
        sessionEncryption: params.sessionEncryption,
    });
    if (metadata === null) {
        return { patch, stateHydrationDeferred: true };
    }
    if (metadata !== undefined) {
        patch.metadata = buildSessionListRenderableMetadata(metadata);
        patch.metadataVersion = params.updateBody.metadata.version;
        patch.hasUnreadMessages = computeCacheOnlySessionRenderableHasUnreadMessages(params.renderable, patch);
    }
    return { patch, stateHydrationDeferred: false };
}

function hasSafeCacheOnlySessionProjectionFields(updateBody: any): boolean {
    return [
        'active',
        'activeAt',
        'thinking',
        'thinkingAt',
        'lastViewedSessionSeq',
        'pendingPermissionRequestCount',
        'pendingUserActionRequestCount',
        'pendingRequestObservedAt',
        'latestReadyEventSeq',
        'latestReadyEventAt',
        'latestTurnId',
        'latestTurnStatus',
        'latestTurnStatusObservedAt',
        'lastRuntimeIssue',
        'archivedAt',
        'meaningfulActivityAt',
    ].some((key) => Object.prototype.hasOwnProperty.call(updateBody, key))
        || hasSessionRuntimeActivityProjectionFields(updateBody);
}

function readProjectedPendingCount(updateBody: any, key: 'pendingPermissionRequestCount' | 'pendingUserActionRequestCount'): number | null {
    const value = updateBody[key];
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function shouldHydrateEncryptedAgentStateForHiddenSession(params: Readonly<{
    session: Session;
    updateBody: any;
}>): boolean {
    if (params.updateBody.agentState == null) return false;
    if (params.session.agentState?.controlledByUser === true) {
        return true;
    }

    const nextPermissionCount = readProjectedPendingCount(params.updateBody, 'pendingPermissionRequestCount');
    const nextUserActionCount = readProjectedPendingCount(params.updateBody, 'pendingUserActionRequestCount');
    if (nextPermissionCount === null || nextUserActionCount === null) {
        return true;
    }

    const previousPermissionCount =
        typeof params.session.pendingPermissionRequestCount === 'number'
            ? Math.max(0, Math.trunc(params.session.pendingPermissionRequestCount))
            : 0;
    const previousUserActionCount =
        typeof params.session.pendingUserActionRequestCount === 'number'
            ? Math.max(0, Math.trunc(params.session.pendingUserActionRequestCount))
            : 0;

    return nextPermissionCount > previousPermissionCount || nextUserActionCount > previousUserActionCount;
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
    invalidationReason: Parameters<typeof recordSessionInvalidationRequested>[0];
    invalidationFields?: Parameters<typeof recordSessionInvalidationRequested>[1];
}>): void {
    if (params.hydrateSessionById) {
        params.hydrateSessionById(params.sessionId, params.reason);
        return;
    }
    recordSessionInvalidationRequested(params.invalidationReason, params.invalidationFields);
    params.invalidateSessions();
}

function requestVisibleCacheOnlySessionHydration(params: Readonly<{
    sessionId: string;
    sourceServerId?: string | null;
    hydrateSessionById?: (sessionId: string, reason: SocketSessionHydrationReason) => void;
    invalidateSessions: () => void;
    invalidationReason: Parameters<typeof recordSessionInvalidationRequested>[0];
    invalidationFields?: Parameters<typeof recordSessionInvalidationRequested>[1];
}>): void {
    if (!isSessionVisible(params.sessionId, params.sourceServerId)) return;
    requestTargetedSessionHydration({
        sessionId: params.sessionId,
        reason: 'socket-update-missing-session',
        hydrateSessionById: params.hydrateSessionById,
        invalidateSessions: params.invalidateSessions,
        invalidationReason: params.invalidationReason,
        invalidationFields: params.invalidationFields,
    });
}

function buildCacheOnlyDurableMessageProjectionPatch(params: Readonly<{
    renderable: SessionListRenderableSession;
    updateData: Pick<ApiUpdateContainer, 'seq' | 'createdAt'>;
    rawMessage: ApiMessage | undefined;
    messageSeq: number | null;
}>): Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>> {
    const { renderable, updateData, rawMessage, messageSeq } = params;
    const attentionImpact = storedSessionMessageAttentionImpact(rawMessage);
    const nextSessionSeq = computeNextSessionSeqFromUpdate({
        currentSessionSeq: renderable.seq ?? 0,
        updateType: 'new-message',
        containerSeq: updateData.seq,
        messageSeq: messageSeq ?? undefined,
    });
    const updateCreatedAt = finiteNumber(updateData.createdAt);
    const messageCreatedAt = finiteNumber(rawMessage?.createdAt);
    const meaningfulActivityCandidate = attentionImpact.affectsMeaningfulActivity
        ? messageCreatedAt ?? updateCreatedAt
        : null;
    const currentUpdatedAt = finiteNumber(renderable.updatedAt);
    const currentMeaningfulActivityAt = finiteNumber(renderable.meaningfulActivityAt);
    const patch: Partial<Omit<SessionListRenderableSession, 'id'>> = {
        seq: nextSessionSeq,
        updatedAt: updateCreatedAt === null
            ? renderable.updatedAt
            : Math.max(currentUpdatedAt ?? updateCreatedAt, updateCreatedAt),
        meaningfulActivityAt: meaningfulActivityCandidate === null
            ? renderable.meaningfulActivityAt
            : Math.max(currentMeaningfulActivityAt ?? meaningfulActivityCandidate, meaningfulActivityCandidate),
    };
    patch.hasUnreadMessages = computeCacheOnlySessionRenderableHasUnreadMessages(
        renderable,
        patch,
        { seq: messageSeq, affectsUnread: attentionImpact.affectsUnread },
    );
    return patch;
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

function patchNumberFieldChanged(
    renderable: SessionListRenderableSession,
    patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>,
    key: keyof Omit<SessionListRenderableSession, 'id'>,
): boolean {
    if (!hasPatchField(patch, key)) return false;
    return renderable[key] !== patch[key];
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
        || patchNumberFieldChanged(renderable, patch, 'runtimeActivityActiveCount')
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
    const forceImmediate = shouldApplyCacheOnlySessionUpdateProjectionPatchImmediately({
        renderable: params.renderable,
        patch: params.patch,
    });
    const patchUpdatedAt = finiteNumber(params.patch.updatedAt);
    const patchSeq = finiteNumber(params.patch.seq);
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
        { patch: params.patch, updateSeq: params.updateSeq },
        {
            shouldContinue,
            deferLeadingPatch: !forceImmediate,
            forceImmediate,
        },
    );
}

function applyCacheOnlyDurableMessageProjectionPatch(params: Readonly<{
    sessionId: string;
    updateData: Pick<ApiUpdateContainer, 'seq' | 'createdAt'>;
    rawMessage: ApiMessage | undefined;
    messageSeq: number | null;
    shouldContinue?: () => boolean;
}>): boolean {
    if (storedSessionMessageAttentionImpactOrNull(params.rawMessage) === null) {
        return false;
    }

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

function shouldApplyCacheOnlyActivityRenderablePatch(
    sessionId: string,
    patch: ActivityRenderablePatch,
): boolean {
    if (storage.getState().sessions[sessionId]) return false;
    const renderable = storage.getState().sessionListRenderables[sessionId];
    if (!renderable) return false;

    const isTimestampOnlyPatch = isTimestampOnlyActivityPatch(renderable, patch);
    const isTurningOff = patch.active === false && patch.thinking === false;
    if (!isTimestampOnlyPatch) {
        if (isTurningOff) {
            if (patch.activeAt < renderable.activeAt) return false;
        } else if (patch.activeAt < renderable.updatedAt) {
            return false;
        }
    }
    if (isTimestampOnlyPatch && shouldSkipFreshTimestampOnlyRenderableActivityPatch(renderable, patch)) {
        return false;
    }
    return true;
}

// Legacy-server fallback: hidden durable messages whose fan-out payload lacks
// attentionImpact (or whose session shell is unknown) trigger a targeted
// per-session shell refresh instead of a full session-list refetch. The floor
// bounds refresh traffic for bursts while the trailing trigger guarantees
// convergence. The hydration closure is refreshed per socket update (same
// pattern as `socketMessageApplyHandlers`).
const SESSION_SHELL_REFRESH_FLOOR_MS = 5_000;
let sessionShellRefreshHydration: ((sessionId: string) => void) | null = null;
const sessionShellRefreshCoalescer = createSessionShellRefreshCoalescer({
    floorMs: SESSION_SHELL_REFRESH_FLOOR_MS,
    trigger: (sessionId) => {
        sessionShellRefreshHydration?.(sessionId);
    },
});

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

/**
 * The socket delivers a materialization as TWO bodies, in order: the committed `new-message`, then
 * the `pending-changed` that reports the queue empty
 * (`apps/server/sources/app/session/pending/acceptedPendingSettlementCoordinator.ts` emits them in
 * exactly that sequence from one settlement transaction).
 *
 * This client discards that order. Socket events are dispatched to `handleSocketUpdate` WITHOUT
 * awaiting the previous one (`sync/api/session/apiSocket.ts#installSocketEventHandlers`), the
 * `new-message` path always yields at least once (it awaits `readStoredSessionMessage`, plus the
 * decrypt for an e2ee session) and may then hand its message to the apply coalescer, while
 * `pending-changed` runs to completion synchronously. So the prune can retire the pending row
 * BEFORE the committed twin it is the receipt for has been applied.
 *
 * `sync/engine/sessions/sessionMessageMaterializationBarrier.ts` owns that question for every writer
 * that retires pending rows; this module owns the two halves it can see — which messages are in
 * flight, and how to apply the ones still queued in its coalescer.
 */
setReceivedSessionMessageApplier((sessionId) => socketMessageApplyCoalescer.flush(sessionId));

type DeferredTranscriptStreamSegmentEntry = Readonly<{
    update: AnyTranscriptStreamSegmentEphemeralUpdate;
    sourceServerId?: string | null;
    shouldContinue: () => boolean;
    getSessionEncryption: (sessionId: string) => TranscriptStreamSegmentSessionMessageEncryption | null;
    getSession: (sessionId: string) => Session | undefined;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    skipWhenHidden: boolean;
}>;

type DeferredTranscriptStreamSegmentQueueState = {
    queued: DeferredTranscriptStreamSegmentEntry[];
    timer: ReturnType<typeof setTimeout> | null;
};

const deferredTranscriptStreamSegmentQueues = new Map<string, DeferredTranscriptStreamSegmentQueueState>();

function getOrCreateDeferredTranscriptStreamSegmentQueue(sessionId: string): DeferredTranscriptStreamSegmentQueueState {
    const existing = deferredTranscriptStreamSegmentQueues.get(sessionId);
    if (existing) return existing;
    const created: DeferredTranscriptStreamSegmentQueueState = { queued: [], timer: null };
    deferredTranscriptStreamSegmentQueues.set(sessionId, created);
    return created;
}

function clearDeferredTranscriptStreamSegmentTimer(state: DeferredTranscriptStreamSegmentQueueState): void {
    if (!state.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
}

function setSocketMessageApplyHandlerForTranscriptStreamSegment(entry: DeferredTranscriptStreamSegmentEntry): void {
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

function hasLiveTranscriptConsumerForDeferredTranscriptStreamSegments(
    sessionId: string,
    state: DeferredTranscriptStreamSegmentQueueState,
): boolean {
    return state.queued.some((entry) => (
        isSessionFullContentConsumerActiveForRealtime(sessionId, entry.sourceServerId)
    ));
}

async function applyDeferredTranscriptStreamSegment(entry: DeferredTranscriptStreamSegmentEntry): Promise<void> {
    if (!entry.shouldContinue()) return;
    const hasLiveTranscriptConsumer = isSessionFullContentConsumerActiveForRealtime(
        entry.update.sessionId,
        entry.sourceServerId,
    );
    if (!hasLiveTranscriptConsumer) {
        return;
    }
    if (entry.skipWhenHidden) {
        socketMessageApplyCoalescer.flush(entry.update.sessionId);
    }
    setSocketMessageApplyHandlerForTranscriptStreamSegment(entry);
    await handleTranscriptStreamSegmentEphemeralUpdate({
        update: entry.update,
        getSessionEncryption: entry.getSessionEncryption,
        getSession: entry.getSession,
        applyMessages: (sessionId, messages) => socketMessageApplyCoalescer.enqueue(sessionId, messages, {
            shouldContinue: entry.shouldContinue,
        }),
        isSessionActivelyViewed: () => true,
        skipWhenHidden: false,
    });
}

async function flushDeferredTranscriptStreamSegments(sessionId: string): Promise<number> {
    const state = deferredTranscriptStreamSegmentQueues.get(sessionId);
    if (!state) return 0;
    clearDeferredTranscriptStreamSegmentTimer(state);
    const entries = state.queued.splice(0, state.queued.length);
    deferredTranscriptStreamSegmentQueues.delete(sessionId);
    for (const entry of entries) {
        await applyDeferredTranscriptStreamSegment(entry);
        socketMessageApplyCoalescer.flush(sessionId);
    }
    return entries.length;
}

function dropDeferredTranscriptStreamSegments(sessionId: string): void {
    const state = deferredTranscriptStreamSegmentQueues.get(sessionId);
    if (!state) return;
    clearDeferredTranscriptStreamSegmentTimer(state);
    const dropped = state.queued.length;
    deferredTranscriptStreamSegmentQueues.delete(sessionId);
    if (dropped > 0) {
        syncPerformanceTelemetry.count('sync.socket.transcriptStreamSegment.deferredRaw.droppedHidden', {
            messages: dropped,
        });
    }
}

function scheduleDeferredTranscriptStreamSegmentFlush(
    sessionId: string,
    state: DeferredTranscriptStreamSegmentQueueState,
    windowMs: number,
): void {
    if (state.timer) return;
    state.timer = setTimeout(() => {
        state.timer = null;
        if (!hasLiveTranscriptConsumerForDeferredTranscriptStreamSegments(sessionId, state)) {
            dropDeferredTranscriptStreamSegments(sessionId);
            return;
        }
        void flushDeferredTranscriptStreamSegments(sessionId);
    }, windowMs);
}

function enqueueDeferredTranscriptStreamSegment(entry: DeferredTranscriptStreamSegmentEntry): void {
    const sessionId = entry.update.sessionId;
    const config = getSocketMessageApplyConfig();
    const state = getOrCreateDeferredTranscriptStreamSegmentQueue(sessionId);
    const existingIndex = state.queued.findIndex((queuedEntry) =>
        queuedEntry.update.message.localId === entry.update.message.localId
            && (queuedEntry.update.message.sidechainId ?? null) === (entry.update.message.sidechainId ?? null),
    );
    if (existingIndex >= 0) {
        state.queued[existingIndex] = entry;
    } else {
        state.queued.push(entry);
    }
    syncPerformanceTelemetry.count('sync.socket.transcriptStreamSegment.deferredRaw.queued', {
        queued: state.queued.length,
        windowMs: config.windowMs,
        maxBatchSize: config.maxBatchSize,
    });

    if (state.queued.length >= config.maxBatchSize) {
        if (!hasLiveTranscriptConsumerForDeferredTranscriptStreamSegments(sessionId, state)) {
            dropDeferredTranscriptStreamSegments(sessionId);
            return;
        }
        void flushDeferredTranscriptStreamSegments(sessionId);
        return;
    }

    scheduleDeferredTranscriptStreamSegmentFlush(sessionId, state, config.windowMs);
}

export async function handleSocketUpdate(params: {
    update: unknown;
    encryption: Encryption;
    settingsScope?: AccountSettingsScope | null;
    getPendingSettings?: () => Partial<Settings>;
    sourceServerId?: string | null;
    shouldContinue?: () => boolean;
    artifactDataKeys: ArtifactDataKeyCache;
    applySessions: ApplySessions;
    fetchSessions: () => void;
    hydrateSessionById?: (sessionId: string, reason: SocketSessionHydrationReason) => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onSessionVisible: (sessionId: string) => void;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
    getSessionMaterializedMaxSeq: (sessionId: string) => number;
    markSessionMaterializedMaxSeq: (sessionId: string, seq: number) => void;
    onMessageGapDetected: (sessionId: string, info: { prevMaterializedMaxSeq: number; messageSeq: number | null }) => void;
    markSessionKnownRemoteSeq?: (sessionId: string, seq: number) => void;
    markSessionTranscriptDeferred?: (sessionId: string, marker: { updateType: 'new-message' | 'message-updated'; seq: number | null; messageId?: string }) => void;
    markSessionTranscriptStale?: (sessionId: string, marker: { updateType: 'new-message' | 'message-updated'; seq: number | null; messageId?: string }) => void;
    markSessionStateHydrationDeferred?: (sessionId: string) => void;
    onReadyProjectionAdvance?: (sessionId: string, seq: number) => void;
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
        getPendingSettings,
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
        onMessageGapDetected,
        markSessionKnownRemoteSeq,
        markSessionTranscriptDeferred,
        markSessionTranscriptStale,
        markSessionStateHydrationDeferred,
        onReadyProjectionAdvance,
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
        getPendingSettings,
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
        onMessageGapDetected,
        markSessionKnownRemoteSeq,
        markSessionTranscriptDeferred,
        markSessionTranscriptStale,
        markSessionStateHydrationDeferred,
        onReadyProjectionAdvance,
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
    getPendingSettings?: () => Partial<Settings>;
    sourceServerId?: string | null;
    shouldContinue?: () => boolean;
    artifactDataKeys: ArtifactDataKeyCache;
    applySessions: ApplySessions;
    fetchSessions: () => void;
    hydrateSessionById?: (sessionId: string, reason: SocketSessionHydrationReason) => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onSessionVisible: (sessionId: string) => void;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
    getSessionMaterializedMaxSeq: (sessionId: string) => number;
    markSessionMaterializedMaxSeq: (sessionId: string, seq: number) => void;
    onMessageGapDetected: (sessionId: string, info: { prevMaterializedMaxSeq: number; messageSeq: number | null }) => void;
    markSessionKnownRemoteSeq?: (sessionId: string, seq: number) => void;
    markSessionTranscriptDeferred?: (sessionId: string, marker: { updateType: 'new-message' | 'message-updated'; seq: number | null; messageId?: string }) => void;
    markSessionTranscriptStale?: (sessionId: string, marker: { updateType: 'new-message' | 'message-updated'; seq: number | null; messageId?: string }) => void;
    markSessionStateHydrationDeferred?: (sessionId: string) => void;
    onReadyProjectionAdvance?: (sessionId: string, seq: number) => void;
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
        getPendingSettings,
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
        onMessageGapDetected,
        markSessionKnownRemoteSeq,
        markSessionTranscriptDeferred,
        markSessionTranscriptStale,
        markSessionStateHydrationDeferred,
        onReadyProjectionAdvance,
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
        await trackSessionMessageMaterialization(updateData.body.sid, handleNewMessageSocketUpdate({
            updateData,
            getSessionEncryption: (sessionId) => encryption.getSessionEncryption(sessionId),
            getSession: getSocketSessionApplyBase,
            getSessionProjection: (sessionId) => getSocketSessionApplyBase(sessionId) ?? storage.getState().sessionListRenderables[sessionId],
            applyCacheOnlySessionProjectionPatch: (patchParams) => applyCacheOnlyDurableMessageProjectionPatch({
                ...patchParams,
                shouldContinue,
            }),
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
            requestSessionShellRefresh: (sessionId) => {
                if (!shouldContinue()) return;
                sessionShellRefreshHydration = (targetSessionId) => requestTargetedSessionHydration({
                    sessionId: targetSessionId,
                    reason: 'socket-update-attention-unknown',
                    hydrateSessionById,
                    invalidateSessions,
                    invalidationReason: 'socketMessageAttentionUnknown',
                });
                sessionShellRefreshCoalescer.request(sessionId);
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
            isSessionActivelyViewed: (sessionId) => isSessionActivelyViewedForRealtime(sessionId, sourceServerId),
            isSessionFullContentConsumerActive: (sessionId) => isSessionFullContentConsumerActiveForRealtime(sessionId, sourceServerId),
            realtimeProjectionMode: socketSessionApplyTuning.sessionRealtimeProjectionMode,
            getSessionMaterializedMaxSeq: getSessionMaterializedMaxSeqForGapDetection,
            markSessionMaterializedMaxSeq,
            onMessageGapDetected,
            markSessionKnownRemoteSeq,
            markSessionTranscriptDeferred,
            markSessionTranscriptStale,
            onTranscriptSkippedDurableMessage: ({ sessionId, rawMessage }) => {
                if (!shouldContinue()) return;
                void deliverHiddenSessionScmMutationSignal({
                    sessionId,
                    sourceServerId,
                    rawMessage,
                    getSessionEncryption: (targetSessionId) => encryption.getSessionEncryption(targetSessionId),
                });
            },
            onTaskLifecycleEvent: onTaskLifecycleEvent
                ? (sessionId, event) => {
                    if (!shouldContinue()) return;
                    onTaskLifecycleEvent(sessionId, event);
                }
                : undefined,
        }));
    } else if (updateData.body.t === 'message-updated') {
        const getSessionMaterializedMaxSeqForGapDetection = (sessionId: string) =>
            Math.max(
                getSessionMaterializedMaxSeq(sessionId),
                socketMessageApplyCoalescer.getQueuedMaxSeq(sessionId),
            );

        socketMessageApplyCoalescer.dropQueuedMessageIds(updateData.body.sid, [updateData.body.message.id]);

        await trackSessionMessageMaterialization(updateData.body.sid, handleMessageUpdatedSocketUpdate({
            updateData,
            getSessionEncryption: (sessionId) => encryption.getSessionEncryption(sessionId),
            getSession: getSocketSessionApplyBase,
            getSessionProjection: (sessionId) => getSocketSessionApplyBase(sessionId) ?? storage.getState().sessionListRenderables[sessionId],
            applyCacheOnlySessionProjectionPatch: (patchParams) => applyCacheOnlyDurableMessageProjectionPatch({
                ...patchParams,
                shouldContinue,
            }),
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
            requestSessionShellRefresh: (sessionId) => {
                if (!shouldContinue()) return;
                sessionShellRefreshHydration = (targetSessionId) => requestTargetedSessionHydration({
                    sessionId: targetSessionId,
                    reason: 'socket-update-attention-unknown',
                    hydrateSessionById,
                    invalidateSessions,
                    invalidationReason: 'socketMessageAttentionUnknown',
                });
                sessionShellRefreshCoalescer.request(sessionId);
            },
            applyMessages: (sessionId, messages) => {
                if (!shouldContinue()) return;
                applyMessages(sessionId, messages);
            },
            onNormalizedMessagesApplied: ingestWorkspaceMutationMessages,
            isMutableToolCall: (sessionId, toolUseId) => storage.getState().isMutableToolCall(sessionId, toolUseId),
            invalidateScmStatus: (sessionId) => scmStatusSync.invalidateFromMutation(sessionId),
            isSessionMessagesLoaded,
            isSessionActivelyViewed: (sessionId) => isSessionActivelyViewedForRealtime(sessionId, sourceServerId),
            isSessionFullContentConsumerActive: (sessionId) => isSessionFullContentConsumerActiveForRealtime(sessionId, sourceServerId),
            realtimeProjectionMode: socketSessionApplyTuning.sessionRealtimeProjectionMode,
            getSessionMaterializedMaxSeq: getSessionMaterializedMaxSeqForGapDetection,
            markSessionMaterializedMaxSeq,
            onMessageGapDetected,
            markSessionKnownRemoteSeq,
            markSessionTranscriptDeferred,
            markSessionTranscriptStale,
            onTranscriptSkippedDurableMessage: ({ sessionId, rawMessage }) => {
                if (!shouldContinue()) return;
                void deliverHiddenSessionScmMutationSignal({
                    sessionId,
                    sourceServerId,
                    rawMessage,
                    getSessionEncryption: (targetSessionId) => encryption.getSessionEncryption(targetSessionId),
                });
            },
            onTaskLifecycleEvent: onTaskLifecycleEvent
                ? (sessionId, event) => {
                    if (!shouldContinue()) return;
                    onTaskLifecycleEvent(sessionId, event);
                }
                : undefined,
        }));
    } else if (updateData.body.t === 'new-session') {
        log.log('🆕 New session update received');
        if (!shouldContinue()) return;
        recordSessionInvalidationRequested('socketNewSession');
        invalidateSessions();
    } else if (updateData.body.t === 'delete-session') {
        log.log('🗑️ Delete session update received');
        if (!shouldContinue()) return;
        socketSessionApplyCoalescer.dropSessionIds([updateData.body.sid]);
        socketMessageApplyCoalescer.dropSessionIds([updateData.body.sid]);
        durableMessageProjectionPatchCoalescer.dropSessionIds([updateData.body.sid]);
        cacheOnlySessionUpdateProjectionPatchCoalescer.dropSessionIds([updateData.body.sid]);
        activityRenderableProjectionPatchCoalescer.dropSessionIds([updateData.body.sid]);
        cacheOnlySessionUpdateSeqBySession.delete(updateData.body.sid);
        dropDeferredTranscriptStreamSegments(updateData.body.sid);
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
        const pendingPatch = buildPendingChangedSessionPatch(updateData.body);
        // The SESSION-LEVEL count is applied in ARRIVAL ORDER, before the barrier below can yield.
        // It is a whole-session write through `socketSessionApplyCoalescer` and the next body builds
        // on the queued session (`getSocketSessionApplyBase`), so deferring it would let a newer
        // `pending-changed` apply first and then be overwritten by this older, smaller count.
        // Only the ROW RETIREMENT has to wait for the messages it is the receipt for.
        const state = storage.getState();
        const session = getSocketSessionApplyBase(sessionId);
        if (!session) {
            const cachedRenderable = state.sessionListRenderables[sessionId];
            if (cachedRenderable) {
                state.applySessionListRenderablePatches([{
                    sessionId,
                    patch: pendingPatch,
                }]);
                requestVisibleCacheOnlySessionHydration({
                    sessionId,
                    sourceServerId,
                    hydrateSessionById,
                    invalidateSessions,
                    invalidationReason: 'socketPendingChangedMissingSession',
                    invalidationFields: {
                        hasCachedRenderable: 1,
                        visibleCacheOnly: 1,
                    },
                });
            } else {
                requestTargetedSessionHydration({
                    sessionId,
                    reason: 'socket-update-missing-session',
                    hydrateSessionById,
                    invalidateSessions,
                    invalidationReason: 'socketPendingChangedMissingSession',
                    invalidationFields: {
                        hasCachedRenderable: 0,
                    },
                });
            }
        } else {
            enqueueSocketSessionApplyGuarded(applySessions, [{
                ...session,
                ...pendingPatch,
            }], shouldContinue);
        }

        if (pendingPatch.pendingCount === 0) {
            // An empty queue is the RECEIPT for messages this client may still be materializing.
            // Retiring the pending rows first publishes a transcript frame carrying neither the
            // pending row nor its committed twin. See the barrier's contract above.
            await settleReceivedSessionMessages(sessionId);
            if (!shouldContinue()) return;
            storage.getState().pruneServerPendingMessages(sessionId);
        }
    } else if (updateData.body.t === 'update-session') {
        const session = getSocketSessionApplyBase(updateData.body.id);
        if (!session) {
            const cachedRenderable = storage.getState().sessionListRenderables[updateData.body.id];
            const canPatchRenderableWithoutFullSession =
                Boolean(cachedRenderable)
                && (
                    updateData.body.metadata != null
                    || hasSafeCacheOnlySessionProjectionFields(updateData.body)
                );
            if (canPatchRenderableWithoutFullSession) {
                if (!shouldContinue()) return;
                const previousRenderable = cachedRenderable as SessionListRenderableSession;
                const patchResult = await buildCacheOnlySessionUpdatePatch({
                    renderable: previousRenderable,
                    updateBody: updateData.body,
                    updateSeq: updateData.seq,
                    updateCreatedAt: updateData.createdAt,
                    sessionEncryption: encryption.getSessionEncryption(updateData.body.id),
                });
                if (
                    shouldReportReadyProjectionAdvance(previousRenderable, updateData.body.latestReadyEventSeq)
                    && typeof updateData.body.latestReadyEventSeq === 'number'
                ) {
                    onReadyProjectionAdvance?.(updateData.body.id, Math.trunc(updateData.body.latestReadyEventSeq));
                }
                if (updateData.body.agentState != null || patchResult.stateHydrationDeferred) {
                    markSessionStateHydrationDeferred?.(updateData.body.id);
                }
                applyCacheOnlySessionUpdateProjectionPatch({
                    sessionId: updateData.body.id,
                    renderable: previousRenderable,
                    patch: patchResult.patch,
                    updateSeq: updateData.seq,
                    shouldContinue,
                });
                requestVisibleCacheOnlySessionHydration({
                    sessionId: updateData.body.id,
                    sourceServerId,
                    hydrateSessionById,
                    invalidateSessions,
                    invalidationReason: 'socketUpdateSessionMissingVisible',
                    invalidationFields: {
                        hasCachedRenderable: 1,
                        visibleCacheOnly: 1,
                    },
                });
                return;
            }
            requestTargetedSessionHydration({
                sessionId: updateData.body.id,
                reason: 'socket-update-unpatchable',
                hydrateSessionById,
                invalidateSessions,
                invalidationReason: 'socketUpdateSessionMissingUnpatchable',
                invalidationFields: {
                    hasCachedRenderable: cachedRenderable ? 1 : 0,
                },
            });
            return;
        }

        const sessionEncryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
        const fullContentConsumerActive = isSessionFullContentConsumerActiveForRealtime(updateData.body.id, sourceServerId);
        const shouldHydrateMetadata = updateData.body.metadata != null;
        const shouldHydrateAgentState =
            fullContentConsumerActive
            || (
                sessionEncryptionMode === 'plain'
                && updateData.body.agentState != null
            )
            || (
                sessionEncryptionMode === 'e2ee'
                && shouldHydrateEncryptedAgentStateForHiddenSession({
                    session,
                    updateBody: updateData.body,
                })
            );
        const shouldHydrateSessionState = shouldHydrateMetadata || shouldHydrateAgentState;
        if (
            (updateData.body.metadata != null && !shouldHydrateMetadata)
            || (updateData.body.agentState != null && !shouldHydrateAgentState)
        ) {
            markSessionStateHydrationDeferred?.(updateData.body.id);
        }
        const sessionEncryption = sessionEncryptionMode === 'plain'
            ? null
            : encryption.getSessionEncryption(updateData.body.id);
        // A missing e2ee key means we cannot decrypt this payload, but it must NOT also drop the
        // session's public projection update (turn/pending/ready/seq/updatedAt). Degrade to a
        // projection-only patch and defer state hydration until the key is available, instead of
        // returning early and discarding the whole update.
        const missingEncryptionForState = shouldHydrateSessionState && sessionEncryptionMode === 'e2ee' && !sessionEncryption;
        if (missingEncryptionForState) {
            console.error(`Session encryption not found for ${updateData.body.id} - applying projection-only update`);
            markSessionStateHydrationDeferred?.(updateData.body.id);
        }
        const hydrateSessionStateEffective = shouldHydrateSessionState && !missingEncryptionForState;

        const { nextSession, agentState } = hydrateSessionStateEffective
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

        if (!shouldContinue()) return;
        if (
            shouldReportReadyProjectionAdvance(session, nextSession.latestReadyEventSeq)
            && typeof nextSession.latestReadyEventSeq === 'number'
        ) {
            onReadyProjectionAdvance?.(updateData.body.id, nextSession.latestReadyEventSeq);
        }
        enqueueSocketSessionApplyGuarded(applySessions, [nextSession], shouldContinue);
        if (shouldHydrateTurnsProjectionForSessionUpdate({
            updateBody: updateData.body,
            fullContentConsumerActive,
        })) {
            requestTargetedSessionHydration({
                sessionId: updateData.body.id,
                reason: 'socket-update-turn-projection',
                hydrateSessionById,
                invalidateSessions,
                invalidationReason: 'socketUpdateSessionTurnsProjection',
                invalidationFields: {
                    fullContentConsumerActive: 1,
                },
            });
        }

        // Agent state updates can be very frequent and are not a reliable proxy for SCM changes.
        // SCM refresh cadence is handled by screen-scoped intervals (session/files views) and
        // by explicit invalidations after SCM mutations.
        if (hydrateSessionStateEffective && updateData.body.agentState) {
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
                storage.getState().applyProfile(profile);
            },
            applySettings: (settings, version) => {
                if (!shouldContinue()) return;
                storage.getState().applySettings(settings, version);
            },
            applySettingsForScope: (scope, settings, version) =>
                shouldContinue() ? storage.getState().applySettingsForScope(scope, settings, version) : undefined,
            getLocalSettings: () => storage.getState().settings,
            getPendingSettings,
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
        const decryptedDataKey =
            typeof (machineUpdate as any).dataEncryptionKey === 'string' && (machineUpdate as any).dataEncryptionKey.length > 0
                ? await encryption.decryptEncryptionKey((machineUpdate as any).dataEncryptionKey)
                : null;
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

        // Machine encryption is derived from the machine's dataEncryptionKey, which can
        // arrive slightly later (e.g. after a machines refresh). Fail closed and
        // trigger a rehydrate instead of logging errors or applying undecryptable updates.
        if (!encryption.getMachineEncryption(machineId)) {
            invalidateMachines();
            return;
        }

        const updatedMachine = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate,
            updateSeq: updateData.seq,
            updateCreatedAt: updateData.createdAt,
            existingMachine: machine,
            getMachineEncryption: (id) => encryption.getMachineEncryption(id),
        });
        if (!updatedMachine) return;
        if (!shouldContinue()) return;

        // Update storage using applyMachines which rebuilds sessionListViewData
        storage.getState().applyMachines([updatedMachine], false, { sourceServerId });
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
            applyRelationshipUpdate: (update) => {
                if (!shouldContinue()) return;
                storage.getState().applyRelationshipUpdate(update);
            },
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
            addArtifact: (artifact) => {
                if (!shouldContinue()) return;
                storage.getState().addArtifact(artifact);
            },
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
            updateArtifact: (artifact) => {
                if (!shouldContinue()) return;
                storage.getState().updateArtifact(artifact);
            },
            invalidateArtifactsSync: invalidateArtifacts,
            log,
        });
    } else if (updateData.body.t === 'delete-artifact') {
        log.log('📦 Received delete-artifact update');
        const artifactUpdate = updateData.body;
        const artifactId = artifactUpdate.artifactId;

        handleDeleteArtifactSocketUpdate({
            artifactId,
            deleteArtifact: (id) => {
                if (!shouldContinue()) return;
                storage.getState().deleteArtifact(id);
            },
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
            shouldContinue,
            applyFeedItems: (items) => {
                if (!shouldContinue()) return;
                storage.getState().applyFeedItems(items);
            },
            log,
        });
    } else if (updateData.body.t === 'kv-batch-update') {
        log.log('📝 Received kv-batch-update');
        const kvUpdate = updateData.body;

        await handleTodoKvBatchUpdate({
            kvUpdate,
            applyTodoSocketUpdates: async (changes) => {
                if (!shouldContinue()) return;
                await applyTodoSocketUpdates(changes);
            },
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
            recordSessionInvalidationRequested('socketSharingChanged');
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
                    invalidationReason: 'socketSharingChanged',
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
                    invalidationReason: 'socketSharingChanged',
                });
            }
            return;
        }
        requestTargetedSessionHydration({
            sessionId,
            reason: 'share-visibility-change',
            hydrateSessionById,
            invalidateSessions,
            invalidationReason: 'socketSharingChanged',
        });
    } else if (updateData.body.t === 'session-share-revoked') {
        const sessionId = readShareSessionId(updateData.body);
        if (!sessionId) {
            recordSessionInvalidationRequested('socketSharingChanged');
            invalidateSessions();
            return;
        }
        socketSessionApplyCoalescer.dropSessionIds([sessionId]);
        socketMessageApplyCoalescer.dropSessionIds([sessionId]);
        durableMessageProjectionPatchCoalescer.dropSessionIds([sessionId]);
        cacheOnlySessionUpdateProjectionPatchCoalescer.dropSessionIds([sessionId]);
        activityRenderableProjectionPatchCoalescer.dropSessionIds([sessionId]);
        cacheOnlySessionUpdateSeqBySession.delete(sessionId);
        dropDeferredTranscriptStreamSegments(sessionId);
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
        recordSessionInvalidationRequested('socketSharingChanged');
        invalidateSessions();
    }
}

export function flushActivityUpdates(params: {
    updates: Map<string, ApiEphemeralActivityUpdate>;
    applySessions: ApplySessions;
    sourceServerId?: string | null;
    shouldContinue?: () => boolean;
}): void {
    const { updates, applySessions, shouldContinue = () => true } = params;
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
            const isThinkingStop =
                nextThinking === false
                && session.thinking === true
                && update.active === session.active
                && update.activeAt >= session.activeAt;

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
            // A durable terminal projection can advance `updatedAt` before the
            // daemon's activity-off event arrives. That event is still the
            // authoritative working -> online transition when its activity
            // timestamp is newer than the last activity heartbeat.
            if (!isTimestampOnlyPatch && !isThinkingStop) {
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
        for (const { sessionId, patch } of renderablePatches) {
            activityRenderableProjectionPatchCoalescer.enqueue(
                sessionId,
                { patch },
                {
                    shouldContinue: () => shouldContinue()
                        && shouldApplyCacheOnlyActivityRenderablePatch(sessionId, patch),
                    deferLeadingPatch: true,
                },
            );
        }
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
    getSessionEncryption: (sessionId: string) => TranscriptStreamSegmentSessionMessageEncryption | null;
    getSession: (sessionId: string) => Session | undefined;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    updateDirectSessionTranscript?: (update: DirectSessionTranscriptUpdatedEphemeralUpdate) => Promise<void> | void;
    applyActionOperationRevision?: (update: ActionOperationRevisionEphemeralV1) => Promise<void> | void;
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
        updateDirectSessionTranscript,
        applyActionOperationRevision,
    } = params;

    const updateData = parseEphemeralUpdate(update);
    if (!updateData) return Promise.resolve();
    if (!shouldContinue()) return Promise.resolve();

    // Process activity updates through smart debounce accumulator
    if (updateData.type === 'action-operation-updated') {
        if (!shouldContinue()) return Promise.resolve();
        return Promise.resolve(applyActionOperationRevision?.(updateData));
    } else if (updateData.type === 'activity') {
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
        return Promise.resolve(updateDirectSessionTranscript?.(updateData));
    } else if (updateData.type === 'transcript-stream-segment') {
        const needsLiveTranscript = isSessionFullContentConsumerActiveForRealtime(updateData.sessionId, sourceServerId);
        const entry: DeferredTranscriptStreamSegmentEntry = {
            update: updateData,
            sourceServerId,
            shouldContinue,
            getSessionEncryption,
            getSession,
            applyMessages,
            skipWhenHidden: !needsLiveTranscript,
        };
        const config = getSocketMessageApplyConfig();
        if (config.enabled && config.windowMs > 0 && !needsLiveTranscript) {
            enqueueDeferredTranscriptStreamSegment(entry);
            return Promise.resolve();
        }
        if (needsLiveTranscript) {
            return flushDeferredTranscriptStreamSegments(updateData.sessionId)
                .then((deferredEntryCount) => {
                    if (deferredEntryCount > 0) {
                        socketMessageApplyCoalescer.flush(updateData.sessionId);
                    }
                    return applyDeferredTranscriptStreamSegment(entry);
                });
        }
        return applyDeferredTranscriptStreamSegment(entry);
    } else if (updateData.type === 'transcript-stream-segment-delta') {
        // Delta ticks are useful only to a live transcript consumer: they chain onto in-memory
        // assembly state and the ~1s full-snapshot checkpoints keep background sessions fresh.
        // Dropping them here (never deferring) keeps hidden sessions off the hot path; the
        // assembly layer resyncs from the next checkpoint when the session becomes visible.
        const needsLiveTranscript = isSessionFullContentConsumerActiveForRealtime(updateData.sessionId, sourceServerId);
        if (!needsLiveTranscript) {
            syncPerformanceTelemetry.count('sync.socket.transcriptStreamSegmentDelta.droppedHidden', { messages: 1 });
            return Promise.resolve();
        }
        const entry: DeferredTranscriptStreamSegmentEntry = {
            update: updateData,
            sourceServerId,
            shouldContinue,
            getSessionEncryption,
            getSession,
            applyMessages,
            skipWhenHidden: false,
        };
        return flushDeferredTranscriptStreamSegments(updateData.sessionId)
            .then((deferredEntryCount) => {
                if (deferredEntryCount > 0) {
                    socketMessageApplyCoalescer.flush(updateData.sessionId);
                }
                return applyDeferredTranscriptStreamSegment(entry);
            });
    }

    // daemon-status ephemeral updates are deprecated, machine status is handled via machine-activity
    return Promise.resolve();
}

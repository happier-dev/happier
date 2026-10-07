import { type SessionMessagesPageV1 } from '@happier-dev/protocol';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import { computeNextSessionSeqFromUpdate } from '@/sync/domains/session/sequence/realtimeSessionSeq';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { AgentState, Metadata } from '@happier-dev/session-core/state';
import { preserveSessionRuntimeLocalMetadata } from '@/sync/domains/session/preserveSessionRuntimeLocalMetadata';
import {
    deriveSessionListRenderableHasUnreadMessagesFromMetadataPatch,
    derivePendingRequestFlagsFromAgentState,
    readSessionListRenderableSourceMetadata,
    summarizeSessionListReadableActivityFromMessageRecords,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListRenderableMetadataComparison } from '@/sync/domains/session/listing/sessionListRenderableMetadataComparison';
import { isSessionListRenderableOwnerProjection } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';

import { storage } from '@/sync/domains/state/storage';
import { readExternalSessionStorageState } from './sessionHttpCompat';
import { shouldRetireSessionCarrierForServer } from '@/sync/store/domains/sessions';
import { classifySessionTupleApplyCurrentness } from '@/sync/store/domains/sessionTupleApplyCurrentness';
import { retireSessionListQueryAddress } from '@/sync/domains/session/listing/sessionListQueryInvalidation';
import { readRollbackEligibleTurnStarts } from '@/sync/domains/session/rollback/rollbackEligibleTurnStarts';
import {
    captureEncryptionGenerationCurrentness,
    isCapturedEncryptionGenerationScopeCurrent,
    type Encryption,
    type EncryptionGenerationScopeAuthority,
} from '@/sync/encryption/encryption';
import { deriveSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import {
    createSessionDataKeyHydrationPlan,
    hydrateSessionDataKeys,
} from '@/sync/encryption/sessionDataKeyHydration';
import { writeSyncDebugLog } from '@/sync/runtime/syncDebugLogging';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { nowServerMs } from '@/sync/runtime/time';
import { getTaskLifecycleEventFromRawContent, type TaskLifecycleEvent } from './taskLifecycle';
import {
    compareSessionMetadataRevisions,
    parseDecryptedSessionMetadata,
    parsePlainSessionAgentState,
    parsePlainSessionMetadata,
    readSessionMetadataLayoutVersion,
    tryParsePlainSessionAgentState,
    tryParsePlainSessionMetadata,
} from './parsePlainSessionPayload';
import {
    runSessionMessagesPagePipeline,
    type SessionMessagesEncryption,
    type SessionMessagesPageOptions,
} from './sessionMessagesPagePipeline';
import {
    type SessionReceivedMessages,
} from "@happier-dev/session-core/transcript";
import {
    resolveSessionRuntimeActivityProjectionFields,
    type SessionRuntimeActivityResyncHandler,
} from './sessionRuntimeActivityProjection';
import { parseSessionAgentActivityHeadlineV1 } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineV1';
import { SessionAccessAccountSummaryV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessPrincipalV1';
import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { resolveSessionViewerProjectionUpdate } from '@/sync/domains/session/readState/sessionViewer';
export { handleNewMessageSocketUpdate } from './sessionSocketUpdate';
export { handleMessageUpdatedSocketUpdate } from './sessionSocketUpdate';
export { fetchAndApplySessions } from './sessionSnapshot';
export type { SessionListEncryption } from './sessionSnapshot';

function readLatestTurnStatus(value: unknown, fallback: PrimaryTurnStatusV1 | null | undefined): PrimaryTurnStatusV1 | null | undefined {
    return value === 'in_progress'
        || value === 'completed'
        || value === 'cancelled'
        || value === 'failed'
        ? value
        : value === null
            ? null
            : fallback;
}

function readNullableTimestamp(value: unknown, fallback: number | null | undefined): number | null | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : value === null
            ? null
            : fallback;
}

function readTimestamp(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : fallback;
}

function isTerminalPrimaryTurnStatus(value: PrimaryTurnStatusV1 | null | undefined): boolean {
    return value === 'completed' || value === 'cancelled' || value === 'failed';
}

type SessionResponsibilityResyncHandler = () => void;

function resolveSessionResponsibilitySocketPatch(
    updateBody: unknown,
    onResyncRequired?: SessionResponsibilityResyncHandler,
): Partial<Pick<Session, 'responsibleAccountId' | 'responsibleAccount'>> {
    if (!updateBody || typeof updateBody !== 'object' || Array.isArray(updateBody)) return {};
    const record = updateBody as Record<string, unknown>;
    const hasId = Object.prototype.hasOwnProperty.call(record, 'responsibleAccountId');
    const hasSummary = Object.prototype.hasOwnProperty.call(record, 'responsibleAccount');
    if (!hasId && !hasSummary) return {};
    if (hasId && hasSummary) {
        if (record.responsibleAccountId === null && record.responsibleAccount === null) {
            return { responsibleAccountId: null, responsibleAccount: null };
        }
        if (typeof record.responsibleAccountId === 'string' && record.responsibleAccountId.length > 0) {
            const summary = SessionAccessAccountSummaryV1Schema.safeParse(record.responsibleAccount);
            if (summary.success && summary.data.accountId === record.responsibleAccountId) {
                return { responsibleAccountId: record.responsibleAccountId, responsibleAccount: summary.data };
            }
        }
    }
    onResyncRequired?.();
    return {};
}

function readRenderablePatchReadableActivity(sessionId: string) {
    const sessionMessages = storage.getState().sessionMessages?.[sessionId];
    if (!sessionMessages) return undefined;
    return summarizeSessionListReadableActivityFromMessageRecords(
        sessionMessages.messageIdsOldestFirst,
        sessionMessages.messagesById,
    );
}

type SessionEncryption = {
    decryptAgentState: (version: number, value: string | null) => Promise<AgentState>;
    decryptMetadata: (version: number, value: string, options?: import('@/sync/encryption/encryptor').DecryptOptions) => Promise<Metadata | null>;
    decryptMetadataPayload: (version: number, value: string, options?: import('@/sync/encryption/encryptor').DecryptOptions) => Promise<unknown | null>;
    decryptSessionSnapshotState?: (
        metadataVersion: number,
        metadata: string,
        agentStateVersion: number,
        agentState: string | null | undefined,
        options?: import('@/sync/encryption/encryptor').DecryptOptions,
    ) => Promise<{ metadata: Metadata | null; agentState: AgentState }>;
};

type NewSessionSocketEncryption = {
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeSessions: Encryption['initializeSessions'];
    getSessionEncryption: (sessionId: string) => SessionEncryption | null;
    removeSessionEncryption?: Encryption['removeSessionEncryption'];
    getCurrentEncryptionGenerationScope?: Encryption['getCurrentEncryptionGenerationScope'];
    isCurrentEncryptionGenerationScope?: Encryption['isCurrentEncryptionGenerationScope'];
};

type NewSessionSocketUpdateBody = Readonly<{
    t: 'new-session';
    viewer?: unknown;
    id?: unknown;
    sid?: unknown;
    seq?: unknown;
    metadata?: unknown;
    metadataLayoutVersion?: unknown;
    metadataVersion?: unknown;
    agentState?: unknown;
    agentStateVersion?: unknown;
    dataEncryptionKey?: unknown;
    encryptionMode?: unknown;
    active?: unknown;
    activeAt?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    meaningfulActivityAt?: unknown;
    currentStorageState?: unknown;
}>;

function readNewSessionId(body: NewSessionSocketUpdateBody): string | null {
    const id = typeof body.id === 'string' && body.id.trim().length > 0
        ? body.id.trim()
        : typeof body.sid === 'string' && body.sid.trim().length > 0
            ? body.sid.trim()
            : '';
    return id || null;
}

/**
 * Session mode is parsed explicitly, never inferred from key presence
 * (`docs/encryption.md`, "Session System Records in the UI"). A body that states a
 * mode must state one this client understands: anything else is inconsistent
 * material and fails closed as `null` rather than being reinterpreted as either
 * representation. Only a body that omits the field falls back to the envelope,
 * because the released predecessor server emits `new-session` without
 * `encryptionMode` at all (`../0.2/apps/server/sources/app/events/eventPayloadBuilders.ts`).
 */
function resolveNewSessionEncryptionMode(body: NewSessionSocketUpdateBody): 'e2ee' | 'plain' | null {
    if (body.encryptionMode !== undefined && body.encryptionMode !== null) {
        if (body.encryptionMode === 'plain') return 'plain';
        return body.encryptionMode === 'e2ee' ? 'e2ee' : null;
    }
    if (typeof body.dataEncryptionKey === 'string' && body.dataEncryptionKey.length > 0) return 'e2ee';
    return null;
}

export async function buildNewSessionFromSocketUpdate(params: {
    updateBody: NewSessionSocketUpdateBody;
    updateSeq: number;
    updateCreatedAt: number;
    sourceServerId?: string | null;
    encryption: NewSessionSocketEncryption | null;
    shouldContinue?: () => boolean;
}): Promise<Session | null> {
    const { updateBody, encryption } = params;
    const sessionId = readNewSessionId(updateBody);
    const metadataPayload = typeof updateBody.metadata === 'string' ? updateBody.metadata : null;
    if (!sessionId || metadataPayload === null) {
        return null;
    }

    const encryptionMode = resolveNewSessionEncryptionMode(updateBody);
    if (!encryptionMode) {
        return null;
    }

    const metadataVersion = readTimestamp(updateBody.metadataVersion, 0);
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(updateBody.metadataLayoutVersion);
    const agentStateVersion = readTimestamp(updateBody.agentStateVersion, 0);
    const agentStatePayload = typeof updateBody.agentState === 'string' ? updateBody.agentState : null;

    const decryptedState = await (async (): Promise<{ metadata: Metadata | null; agentState: AgentState | null } | null> => {
        try {
            if (encryptionMode === 'plain') {
                return {
                    metadata: parsePlainSessionMetadata(metadataPayload, metadataLayoutVersion),
                    agentState: metadataLayoutVersion === 1 || agentStatePayload === null
                        ? null
                        : parsePlainSessionAgentState(agentStatePayload),
                };
            }

            if (updateBody.dataEncryptionKey == null) {
                return { metadata: null, agentState: null };
            }
            if (!encryption) {
                return { metadata: null, agentState: null };
            }
            const generationAuthority: EncryptionGenerationScopeAuthority | null =
                encryption.getCurrentEncryptionGenerationScope
                && encryption.isCurrentEncryptionGenerationScope
                    ? {
                        getCurrentEncryptionGenerationScope: (scope) => encryption.getCurrentEncryptionGenerationScope!(scope),
                        isCurrentEncryptionGenerationScope: (scope) => encryption.isCurrentEncryptionGenerationScope!(scope),
                    }
                    : null;
            let capturedEncryptionScope = captureEncryptionGenerationCurrentness(generationAuthority, {
                serverId: params.sourceServerId ?? null,
            }).capturedScope;
            const shouldContinue = () => (
                params.shouldContinue?.() !== false
                && isCapturedEncryptionGenerationScopeCurrent(generationAuthority, capturedEncryptionScope)
            );
            // Socket bootstrap has no Account credential or owner authority. It can open a
            // present Session envelope; absent envelopes are resolved by exact by-ID hydration.
            const sessionDataKeys = new Map<string, Uint8Array>();
            const hydration = await hydrateSessionDataKeys({
                plan: createSessionDataKeyHydrationPlan({
                    sessions: [{
                        id: sessionId,
                        encryptionMode,
                        dataEncryptionKey: updateBody.dataEncryptionKey,
                        viewerRole: 'recipient',
                    }],
                    credentialKind: 'keyless',
                    sessionDataKeys,
                }),
                encryption: {
                    decryptEncryptionKeys: (values) => Promise.all(values.map((value) => encryption.decryptEncryptionKey(value))),
                    ...(encryption.getCurrentEncryptionGenerationScope ? {
                        getCurrentEncryptionGenerationScope: (scope) => encryption.getCurrentEncryptionGenerationScope!(scope),
                    } : {}),
                    ...(encryption.isCurrentEncryptionGenerationScope ? {
                        isCurrentEncryptionGenerationScope: (scope) => encryption.isCurrentEncryptionGenerationScope!(scope),
                    } : {}),
                },
                sessionDataKeys,
                scope: { serverId: params.sourceServerId ?? null },
                shouldContinue,
            });
            if (hydration.stale) return null;
            for (const id of hydration.sessionEncryptionClears) encryption.removeSessionEncryption?.(id);
            if (hydration.states.get(sessionId) !== 'ready') return null;
            const initializedScope = await encryption.initializeSessions(hydration.sessionKeys, {
                serverId: params.sourceServerId ?? null,
                shouldContinue,
            });
            if (initializedScope === null) return null;
            if (initializedScope) capturedEncryptionScope = initializedScope;
            if (!shouldContinue()) return null;
            const sessionEncryption = encryption.getSessionEncryption(sessionId);
            if (!sessionEncryption) {
                return { metadata: null, agentState: {} };
            }

            if (
                metadataLayoutVersion !== 1
                && sessionEncryption.decryptSessionSnapshotState
            ) {
                const state = await sessionEncryption.decryptSessionSnapshotState(
                    metadataVersion,
                    metadataPayload,
                    agentStateVersion,
                    agentStatePayload,
                );
                return {
                    ...state,
                    metadata: parseDecryptedSessionMetadata(
                        state.metadata,
                        metadataLayoutVersion,
                    ),
                };
            }

            const [metadata, agentState] = await Promise.all([
                metadataLayoutVersion === 1
                    ? sessionEncryption.decryptMetadataPayload(metadataVersion, metadataPayload)
                    : sessionEncryption.decryptMetadata(metadataVersion, metadataPayload),
                metadataLayoutVersion === 1
                    ? Promise.resolve(null)
                    : sessionEncryption.decryptAgentState(agentStateVersion, agentStatePayload),
            ]);
            return {
                metadata: parseDecryptedSessionMetadata(
                    metadata,
                    metadataLayoutVersion,
                ),
                agentState,
            };
        } catch {
            return null;
        }
    })();

    if (!decryptedState || (encryptionMode === 'e2ee' && decryptedState.metadata == null)) {
        return null;
    }

    const active = typeof updateBody.active === 'boolean' ? updateBody.active : true;
    const activeAt = readTimestamp(updateBody.activeAt, params.updateCreatedAt);
    const pendingFlags = derivePendingRequestFlagsFromAgentState(decryptedState.agentState);
    const currentStorageState = readExternalSessionStorageState(updateBody.currentStorageState);

    return {
        id: sessionId,
        viewer: resolveSessionViewerProjectionUpdate(updateBody.viewer, undefined),
        ...(typeof params.sourceServerId === 'string' && params.sourceServerId.trim().length > 0
            ? { serverId: params.sourceServerId.trim() }
            : {}),
        seq: readTimestamp(updateBody.seq, params.updateSeq),
        encryptionMode,
        encryptedContentAvailability: 'ready',
        createdAt: readTimestamp(updateBody.createdAt, params.updateCreatedAt),
        updatedAt: readTimestamp(updateBody.updatedAt, params.updateCreatedAt),
        meaningfulActivityAt: readTimestamp(updateBody.meaningfulActivityAt, params.updateCreatedAt),
        active,
        activeAt,
        archivedAt: null,
        ...(metadataLayoutVersion > 0 ? { metadataLayoutVersion } : {}),
        metadata: decryptedState.metadata,
        metadataVersion,
        agentState: decryptedState.agentState,
        agentStateVersion,
        thinking: false,
        thinkingAt: 0,
        pendingPermissionRequestCount: pendingFlags.hasPendingPermissionRequests ? 1 : 0,
        pendingUserActionRequestCount: pendingFlags.hasPendingUserActionRequests ? 1 : 0,
        // Where the transcript lives. A fresh external-session import is `machine_only`; without
        // the field the transcript authority would read it as a legacy linked session.
        ...(currentStorageState ? { currentStorageState } : {}),
    };
}

/**
 * The one Session teardown choke point, reached by the socket `delete-session` and
 * `session-share-revoked` branches and by `Sync.retireLocalSession`.
 *
 * `serverId` names the Home whose authority produced the deletion; `null` is a
 * Home-agnostic retirement of the whole id. The same Session id can exist on two Homes,
 * so this decides ONCE whether the deletion also retires the shared per-id carrier —
 * transcript, encryption key, project, SCM status and the state `deleteSession` clears —
 * and otherwise removes only that Home's row.
 */
export function handleDeleteSessionSocketUpdate(params: {
    sessionId: string;
    serverId: string | null;
    /**
     * Socket owns its queued/coalesced work; callers inject its per-session teardown.
     * `retireActiveCarrier` tells it whether this deletion owns the carrier those
     * bare-id queues belong to: a non-carrier Home must not drop another Home's
     * admitted-but-unflushed work for the same Session id.
     */
    dropSocketSessionWork?: (sessionId: string, retireActiveCarrier: boolean) => void;
    invalidateSessionHydration?: (sessionId: string) => void;
    resetSessionTranscriptState?: (sessionId: string) => void;
    deleteSession: (sessionId: string, serverId: string | null) => void;
    removeSessionEncryption: (sessionId: string) => void;
    removeProjectManagerSession: (sessionId: string) => void;
    clearScmStatusForSession: (sessionId: string, serverId: string | null) => void;
    log: { log: (message: string) => void };
}) {
    const {
        sessionId,
        serverId,
        dropSocketSessionWork,
        invalidateSessionHydration,
        resetSessionTranscriptState,
        deleteSession,
        removeSessionEncryption,
        removeProjectManagerSession,
        clearScmStatusForSession,
        log,
    } = params;

    // Read before `deleteSession` removes the record: the carrier's own Home is the
    // key the SCM owner registered this Session under, and an unaddressed deletion
    // has no other Home to clear it by.
    const carrierServerId = storage.getState().sessions[sessionId]?.serverId ?? null;
    const retireActiveCarrier = shouldRetireSessionCarrierForServer(carrierServerId, serverId);

    // Drop admitted socket work before it can flush back into the just-deleted
    // carrier. The socket module owns this queue/raw-normalization inventory; the
    // address-qualified half answers for the named Home, the bare-id half answers
    // for the carrier, so it is told which of the two this deletion retires.
    dropSocketSessionWork?.(sessionId, retireActiveCarrier);

    if (retireActiveCarrier) {
        // Fence older by-id responses before removing local state or encryption.
        // Otherwise an already-started hydration can reapply the deleted tuple/key.
        invalidateSessionHydration?.(sessionId);

        // Sync owns the transcript's map, pagination and deferred state. Reset it
        // before the session disappears so a later same-id carrier is a fresh row.
        resetSessionTranscriptState?.(sessionId);
    }

    // Remove the addressed Home's row (and, when it owns the carrier, the rest).
    deleteSession(sessionId, serverId);
    // The mounted filtered lists hold their own applied membership for that exact Home.
    retireSessionListQueryAddress(serverId ?? null, sessionId);

    if (retireActiveCarrier) {
        // Remove encryption keys from memory
        removeSessionEncryption(sessionId);

        // Remove from project manager
        removeProjectManagerSession(sessionId);

        // Clear any cached git status. The SCM owner keys an exact mapping by Home,
        // so the addressed Home leads and the carrier's own Home answers for an
        // unaddressed retirement.
        clearScmStatusForSession(sessionId, serverId ?? carrierServerId);
    }

    log.log(`🗑️ Session ${sessionId} deleted from local storage${serverId ? ` for Home ${serverId}` : ''}`);
}

// Session `metadata.version` is strictly monotonic per session on the server: every metadata write
// uses optimistic concurrency (`metadataVersion = expectedVersion + 1` guarded by a CAS update) and
// no flow (re-key/reset/re-create by tag) ever decreases it. So an incoming metadata version that is
// not strictly greater than the stored version is stale/out-of-order and must not overwrite a newer
// title. Equal versions are a no-op. Mirrors the machine metadata guard in syncMachines.ts.
export function isStrictlyNewerSessionMetadataVersion(
    incomingVersion: unknown,
    storedVersion: number | null | undefined,
): boolean {
    if (typeof incomingVersion !== 'number' || !Number.isFinite(incomingVersion)) {
        return false;
    }
    const normalizedStored = typeof storedVersion === 'number' && Number.isFinite(storedVersion)
        ? storedVersion
        : 0;
    return incomingVersion > normalizedStored;
}

export function buildUpdatedSessionProjectionFromSocketUpdate(params: {
    session: Session;
    updateBody: any;
    updateSeq: number;
    updateCreatedAt: number;
    onRuntimeActivityResyncRequired?: SessionRuntimeActivityResyncHandler;
    onResponsibilityResyncRequired?: SessionResponsibilityResyncHandler;
}): Session {
    const { session, updateBody, updateSeq, updateCreatedAt } = params;
    const encryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const nextLatestTurnStatus = readLatestTurnStatus(updateBody.latestTurnStatus, session.latestTurnStatus);
    const rollbackEligibleTurnStarts = readRollbackEligibleTurnStarts(updateBody.rollbackEligibleTurnStarts);
    const clearsStaleThinking = isTerminalPrimaryTurnStatus(nextLatestTurnStatus)
        && updateBody.latestTurnStatus === nextLatestTurnStatus;
    const projectedActive =
        typeof updateBody.active === 'boolean'
            ? updateBody.active
            : session.active;
    const projectedActiveAt = readTimestamp(updateBody.activeAt, session.activeAt);
    const projectedThinking =
        clearsStaleThinking
            ? false
            : typeof updateBody.thinking === 'boolean'
                ? updateBody.thinking
                : updateBody.active === false
                    ? false
                    : session.thinking;
    const projectedThinkingAt =
        readTimestamp(
            updateBody.thinkingAt,
            typeof updateBody.thinking === 'boolean' || updateBody.active === false
                ? projectedActiveAt
                : session.thinkingAt,
        );

    // The `update-session` event carries no access projection; access changes
    // reach the client through the list/detail readers instead.
    return {
        ...session,
        viewer: resolveSessionViewerProjectionUpdate(updateBody.viewer, session.viewer),
        encryptionMode,
        active: projectedActive,
        activeAt: projectedActiveAt,
        thinking: projectedThinking,
        thinkingAt: projectedThinkingAt,
        lastViewedSessionSeq:
            typeof updateBody.lastViewedSessionSeq === 'number'
                ? updateBody.lastViewedSessionSeq
                : session.lastViewedSessionSeq,
        pendingPermissionRequestCount:
            typeof updateBody.pendingPermissionRequestCount === 'number'
                ? updateBody.pendingPermissionRequestCount
                : session.pendingPermissionRequestCount,
        pendingUserActionRequestCount:
            typeof updateBody.pendingUserActionRequestCount === 'number'
                ? updateBody.pendingUserActionRequestCount
                : session.pendingUserActionRequestCount,
        pendingRequestObservedAt: readNullableTimestamp(
            updateBody.pendingRequestObservedAt,
            session.pendingRequestObservedAt,
        ),
        latestTurnId:
            typeof updateBody.latestTurnId === 'string' && updateBody.latestTurnId.trim().length > 0
                ? updateBody.latestTurnId
                : updateBody.latestTurnId === null
                    ? null
                    : session.latestTurnId,
        latestTurnStatus: nextLatestTurnStatus,
        latestTurnStatusObservedAt: readNullableTimestamp(
            updateBody.latestTurnStatusObservedAt,
            session.latestTurnStatusObservedAt,
        ),
        latestReadyEventSeq: readNullableTimestamp(updateBody.latestReadyEventSeq, session.latestReadyEventSeq),
        latestReadyEventAt: readNullableTimestamp(updateBody.latestReadyEventAt, session.latestReadyEventAt),
        lastRuntimeIssue:
            updateBody.lastRuntimeIssue === null
            || (updateBody.lastRuntimeIssue && typeof updateBody.lastRuntimeIssue === 'object')
                ? updateBody.lastRuntimeIssue
                : session.lastRuntimeIssue,
        ...resolveSessionRuntimeActivityProjectionFields(
            session,
            updateBody,
            params.onRuntimeActivityResyncRequired,
        ),
        ...(rollbackEligibleTurnStarts !== undefined ? { rollbackEligibleTurnStarts } : {}),
        ...(clearsStaleThinking ? {
            optimisticThinkingAt: null,
            thinkingGraceUntil: null,
        } : {}),
        archivedAt:
            typeof updateBody.archivedAt === 'number' || updateBody.archivedAt === null
                ? updateBody.archivedAt
                : session.archivedAt,
        // Only an explicit projection changes responsibility. An update that omits
        // the field says nothing about it and must not turn a known assignee, or a
        // server that does not project responsibility at all, into "No one".
        ...resolveSessionResponsibilitySocketPatch(updateBody, params.onResponsibilityResyncRequired),
        updatedAt: updateCreatedAt,
        meaningfulActivityAt:
            typeof updateBody.meaningfulActivityAt === 'number'
                ? updateBody.meaningfulActivityAt
                : session.meaningfulActivityAt,
        seq: computeNextSessionSeqFromUpdate({
            currentSessionSeq: session.seq ?? 0,
            updateType: 'update-session',
            containerSeq: updateSeq,
            messageSeq: undefined,
        }),
    };
}

export async function buildUpdatedSessionFromSocketUpdate(params: {
    session: Session;
    updateBody: any;
    updateSeq: number;
    updateCreatedAt: number;
    sessionEncryption: SessionEncryption | null;
    hydrateState?: Readonly<{
        agentState?: boolean;
        metadata?: boolean;
    }>;
    onRuntimeActivityResyncRequired?: SessionRuntimeActivityResyncHandler;
    onResponsibilityResyncRequired?: SessionResponsibilityResyncHandler;
}): Promise<{ nextSession: Session; agentState: any }> {
    const { session, updateBody, updateSeq, updateCreatedAt, sessionEncryption } = params;

    const encryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    if (encryptionMode === 'e2ee' && !sessionEncryption) {
        throw new Error(`Session encryption not found for ${session.id}`);
    }
    const projectionSession = buildUpdatedSessionProjectionFromSocketUpdate({
        session,
        updateBody,
        updateSeq,
        updateCreatedAt,
        onRuntimeActivityResyncRequired: params.onRuntimeActivityResyncRequired,
        onResponsibilityResyncRequired: params.onResponsibilityResyncRequired,
    });
    const storedMetadataLayoutVersion = readSessionMetadataLayoutVersion(session.metadataLayoutVersion);
    const nextMetadataLayoutVersion = Math.max(
        storedMetadataLayoutVersion,
        readSessionMetadataLayoutVersion(updateBody.metadataLayoutVersion),
    );
    const tupleCurrentness = classifySessionTupleApplyCurrentness(session, {
        ...session,
        metadataLayoutVersion: updateBody.metadataLayoutVersion ?? session.metadataLayoutVersion,
        metadataVersion: updateBody.metadata?.version ?? session.metadataVersion,
        agentStateVersion: updateBody.agentState?.version ?? session.agentStateVersion,
    });
    const metadataRevisionAdvances = tupleCurrentness.metadataCurrent && compareSessionMetadataRevisions({
        incomingLayoutVersion: nextMetadataLayoutVersion,
        incomingMetadataVersion: updateBody.metadata?.version,
        storedLayoutVersion: storedMetadataLayoutVersion,
        storedMetadataVersion: session.metadataVersion,
    }) > 0;

    const hydrateAgentState = updateBody.agentState
        ? params.hydrateState?.agentState !== false && tupleCurrentness.agentStateCurrent
        : false;
    const hydrateMetadata = updateBody.metadata
        ? params.hydrateState?.metadata !== false
            && metadataRevisionAdvances
        : false;
    const hasStatePayload = hydrateMetadata || hydrateAgentState;
    const shouldBatchDecryptState = Boolean(
        hydrateMetadata
        && hydrateAgentState
        && encryptionMode === 'e2ee'
        && nextMetadataLayoutVersion !== 1
        && sessionEncryption?.decryptSessionSnapshotState,
    );
    let metadataAuthenticationFailed = false;
    const metadataDecryptOptions = { onAuthenticationFailure: () => { metadataAuthenticationFailed = true; } };
    const resolveUpdatedState = async (): Promise<{
        agentState: AgentState | null;
        metadata: Metadata | null;
    }> => {
        if (shouldBatchDecryptState) {
            const decryptedState = await sessionEncryption!.decryptSessionSnapshotState!(
                updateBody.metadata.version,
                updateBody.metadata.value,
                updateBody.agentState.version,
                updateBody.agentState.value,
                metadataDecryptOptions,
            );
            return {
                metadata: parseDecryptedSessionMetadata(
                    decryptedState.metadata,
                    nextMetadataLayoutVersion,
                ),
                agentState: decryptedState.agentState,
            };
        }

        const agentStatePromise = nextMetadataLayoutVersion === 1
            ? Promise.resolve(null)
            : updateBody.agentState && hydrateAgentState
            ? encryptionMode === 'plain'
                ? Promise.resolve(parsePlainSessionAgentState(updateBody.agentState.value))
                : sessionEncryption!.decryptAgentState(updateBody.agentState.version, updateBody.agentState.value)
            : Promise.resolve(session.agentState);

        const metadataPromise = updateBody.metadata && hydrateMetadata
            ? encryptionMode === 'plain'
                ? Promise.resolve(parsePlainSessionMetadata(
                    updateBody.metadata.value,
                    nextMetadataLayoutVersion,
                ))
                : (
                    nextMetadataLayoutVersion === 1
                        ? sessionEncryption!.decryptMetadataPayload(
                            updateBody.metadata.version,
                            updateBody.metadata.value,
                            metadataDecryptOptions,
                        )
                        : sessionEncryption!.decryptMetadata(
                            updateBody.metadata.version,
                            updateBody.metadata.value,
                            metadataDecryptOptions,
                        )
                )
                    .then((value) => parseDecryptedSessionMetadata(
                        value,
                        nextMetadataLayoutVersion,
                    ))
            : Promise.resolve(session.metadata);

        const [agentState, metadata] = await Promise.all([agentStatePromise, metadataPromise]);
        return { agentState, metadata };
    };
    const { agentState, metadata } = hasStatePayload
        ? await syncPerformanceTelemetry.measureAsync(
            'sync.sessions.socket.updateSession.decryptState',
            {
                encrypted: encryptionMode === 'e2ee' ? 1 : 0,
                plain: encryptionMode === 'plain' ? 1 : 0,
                metadata: hydrateMetadata ? 1 : 0,
                agentState: hydrateAgentState ? 1 : 0,
                batched: shouldBatchDecryptState ? 1 : 0,
            },
            resolveUpdatedState,
        )
        : await resolveUpdatedState();
    const mergedMetadata = nextMetadataLayoutVersion === 1
        ? metadata
        : preserveSessionRuntimeLocalMetadata(session.metadata, metadata);

    const nextSession: Session = {
        ...projectionSession,
        ...(hydrateMetadata ? {
            encryptedContentAvailability: deriveSessionContentAvailability({
                hydrationState: encryptionMode === 'plain' ? 'not_required' : 'ready',
                contentAuthenticationFailed: metadataAuthenticationFailed,
            }),
        } : {}),
        metadataLayoutVersion: hydrateMetadata
            ? nextMetadataLayoutVersion
            : session.metadataLayoutVersion,
        agentState,
        agentStateVersion: hydrateAgentState ? updateBody.agentState.version : session.agentStateVersion,
        metadata: mergedMetadata,
        metadataVersion: hydrateMetadata ? updateBody.metadata.version : session.metadataVersion,
        // A layout-1 socket patch carries only the shared metadata; the owner view for the new
        // revision is re-read by the caller's targeted owner hydration. Until that lands the
        // last-known owner view stays (from `projectionSession`): clearing it made the owner's
        // row unknown-hidden and title-less on every metadata write, so the list lost and
        // regained rows while idle. The hydration replaces it, or locks it when unreadable.
    };

    return { nextSession, agentState };
}

export async function buildUpdatedSessionListRenderablePatchFromSocketUpdate(params: {
    renderable: SessionListRenderableSession;
    updateBody: any;
    updateSeq: number;
    updateCreatedAt: number;
    sessionEncryption: SessionEncryption | null;
    hydrateState?: {
        agentState?: boolean;
        metadata?: boolean;
    };
    onRuntimeActivityResyncRequired?: SessionRuntimeActivityResyncHandler;
    onResponsibilityResyncRequired?: SessionResponsibilityResyncHandler;
}): Promise<Partial<SessionListRenderableSession>> {
    const { renderable, updateBody, updateSeq, updateCreatedAt, sessionEncryption } = params;
    const storedMetadataLayoutVersion = readSessionMetadataLayoutVersion(renderable.metadataLayoutVersion);
    const nextMetadataLayoutVersion = Math.max(
        storedMetadataLayoutVersion,
        readSessionMetadataLayoutVersion(updateBody.metadataLayoutVersion),
    );
    const tupleCurrentness = classifySessionTupleApplyCurrentness(renderable, {
        ...renderable,
        metadataLayoutVersion: updateBody.metadataLayoutVersion ?? renderable.metadataLayoutVersion,
        metadataVersion: updateBody.metadata?.version ?? renderable.metadataVersion,
        agentStateVersion: updateBody.agentState?.version ?? renderable.agentStateVersion,
    });
    const metadataRevisionAdvances = tupleCurrentness.metadataCurrent && compareSessionMetadataRevisions({
        incomingLayoutVersion: nextMetadataLayoutVersion,
        incomingMetadataVersion: updateBody.metadata?.version,
        storedLayoutVersion: storedMetadataLayoutVersion,
        storedMetadataVersion: renderable.metadataVersion,
    }) > 0;
    const hydrateMetadata = updateBody.metadata
        ? params.hydrateState?.metadata !== false
            && metadataRevisionAdvances
        : false;
    const hydrateAgentState = updateBody.agentState
        ? params.hydrateState?.agentState !== false && tupleCurrentness.agentStateCurrent
        : false;

    let metadataAuthenticationFailed = false;
    const metadataDecryptOptions = { onAuthenticationFailure: () => { metadataAuthenticationFailed = true; } };
    const parsedMetadata =
        !updateBody.metadata || !hydrateMetadata
            ? undefined
            : sessionEncryption
                ? parseDecryptedSessionMetadata(
                    await (
                        nextMetadataLayoutVersion === 1
                            ? sessionEncryption.decryptMetadataPayload(
                                updateBody.metadata.version,
                                updateBody.metadata.value,
                                metadataDecryptOptions,
                            )
                            : sessionEncryption.decryptMetadata(
                                updateBody.metadata.version,
                                updateBody.metadata.value,
                                metadataDecryptOptions,
                            )
                    ),
                    nextMetadataLayoutVersion,
                )
                : typeof updateBody.metadata.value === 'string'
                    ? tryParsePlainSessionMetadata(
                        updateBody.metadata.value,
                        nextMetadataLayoutVersion,
                    )
                    : updateBody.metadata.value === null
                        ? null
                        : undefined;

    const parsedAgentState =
        !updateBody.agentState || !hydrateAgentState
            ? undefined
            : nextMetadataLayoutVersion === 1
                ? null
            : sessionEncryption
                ? await sessionEncryption.decryptAgentState(updateBody.agentState.version, updateBody.agentState.value)
                : tryParsePlainSessionAgentState(updateBody.agentState.value);

    const pendingFlags =
        typeof updateBody.pendingPermissionRequestCount === 'number' || typeof updateBody.pendingUserActionRequestCount === 'number'
            ? {
                hasPendingPermissionRequests: (updateBody.pendingPermissionRequestCount ?? 0) > 0,
                hasPendingUserActionRequests: (updateBody.pendingUserActionRequestCount ?? 0) > 0,
            }
            : parsedAgentState !== undefined
                ? derivePendingRequestFlagsFromAgentState(parsedAgentState)
                : {
                    hasPendingPermissionRequests: renderable.hasPendingPermissionRequests === true,
                    hasPendingUserActionRequests: renderable.hasPendingUserActionRequests === true,
                };
    const nextSessionSeq = computeNextSessionSeqFromUpdate({
        currentSessionSeq: renderable.seq ?? 0,
        updateType: 'update-session',
        containerSeq: updateSeq,
        messageSeq: undefined,
    });
    // The frame's metadata reaches the row through the same audience projection the row builder
    // uses (strict shared schema and Agent presentation for a recipient), never raw.
    const parsedRenderableMetadata = parsedMetadata === undefined
        ? undefined
        : buildSessionListRenderableMetadataComparison(readSessionListRenderableSourceMetadata({
            metadata: parsedMetadata,
            metadataLayoutVersion: nextMetadataLayoutVersion,
            ownerMetadataView: null,
            access: renderable.access,
            accessLevel: renderable.accessLevel,
        }), renderable.metadata);
    // Shared-only socket content cannot replace an existing owner's composed list projection. The
    // row keeps that projection's own revision, so the next list refresh or warm hydration re-reads
    // the owner view instead of treating the retained title as current.
    const retainOwnerProjection = isSessionListRenderableOwnerProjection(renderable);
    const mergedRenderableMetadata = parsedRenderableMetadata === undefined || retainOwnerProjection
        ? renderable.metadata
        : nextMetadataLayoutVersion === 1
            ? parsedRenderableMetadata
            : preserveSessionRuntimeLocalMetadata(renderable.metadata, parsedRenderableMetadata);
    // The concurrent Home list is the only qualified source a background
    // same-id Session can use. Project the canonical compact headline through
    // this socket patch too, rather than leaving that Home stale until its next
    // complete list refresh.
    const agentActivityHeadline = parsedMetadata === undefined
        ? renderable.agentActivityHeadline ?? null
        : parseSessionAgentActivityHeadlineV1(parsedMetadata?.sessionAgentActivityHeadlineV1);
    const nextLatestTurnStatus = readLatestTurnStatus(updateBody.latestTurnStatus, renderable.latestTurnStatus);
    const nextLatestTurnId =
        typeof updateBody.latestTurnId === 'string' || updateBody.latestTurnId === null
            ? updateBody.latestTurnId
            : renderable.latestTurnId;
    const nextLatestTurnStatusObservedAt = readNullableTimestamp(
        updateBody.latestTurnStatusObservedAt,
        renderable.latestTurnStatusObservedAt,
    );
    const nextLatestReadyEventSeq =
        typeof updateBody.latestReadyEventSeq === 'number' || updateBody.latestReadyEventSeq === null
            ? updateBody.latestReadyEventSeq
            : renderable.latestReadyEventSeq ?? null;
    const nextLatestReadyEventAt =
        typeof updateBody.latestReadyEventAt === 'number'
            ? updateBody.latestReadyEventAt
            : renderable.latestReadyEventAt ?? null;
    const rollbackEligibleTurnStarts = readRollbackEligibleTurnStarts(updateBody.rollbackEligibleTurnStarts);
    const nextLastViewedSessionSeq =
        typeof updateBody.lastViewedSessionSeq === 'number'
            ? updateBody.lastViewedSessionSeq
            : renderable.lastViewedSessionSeq ?? null;
    const nextPendingRequestObservedAt =
        typeof updateBody.pendingRequestObservedAt === 'number' || updateBody.pendingRequestObservedAt === null
            ? updateBody.pendingRequestObservedAt
            : renderable.pendingRequestObservedAt ?? null;
    const clearsStaleThinking = isTerminalPrimaryTurnStatus(nextLatestTurnStatus)
        && updateBody.latestTurnStatus === nextLatestTurnStatus;
    const nextActive =
        typeof updateBody.active === 'boolean'
            ? updateBody.active
            : renderable.active;
    const nextActiveAt = readTimestamp(updateBody.activeAt, renderable.activeAt);
    const nextThinking =
        clearsStaleThinking
            ? false
            : typeof updateBody.thinking === 'boolean'
                ? updateBody.thinking
                : updateBody.active === false
                    ? false
                    : renderable.thinking;
    const nextThinkingAt = readTimestamp(
        updateBody.thinkingAt,
        typeof updateBody.thinking === 'boolean' || updateBody.active === false
            ? nextActiveAt
            : renderable.thinkingAt,
    );
    const viewer = resolveSessionViewerProjectionUpdate(updateBody.viewer, renderable.viewer);
    const shouldRecomputeUnread =
        typeof updateBody.lastViewedSessionSeq === 'number'
        || typeof updateBody.latestReadyEventSeq === 'number'
        || (
            isTerminalPrimaryTurnStatus(nextLatestTurnStatus)
            && updateBody.latestTurnStatus === nextLatestTurnStatus
        );

    return {
        viewer,
        ...resolveSessionResponsibilitySocketPatch(updateBody, params.onResponsibilityResyncRequired),
        ...(hydrateMetadata && (sessionEncryption || renderable.encryptionMode === 'plain') ? {
            encryptedContentAvailability: deriveSessionContentAvailability({
                hydrationState: renderable.encryptionMode === 'plain' ? 'not_required' : 'ready',
                contentAuthenticationFailed: metadataAuthenticationFailed,
            }),
        } : {}),
        seq: nextSessionSeq,
        updatedAt: updateCreatedAt,
        active: nextActive,
        activeAt: nextActiveAt,
        thinking: nextThinking,
        thinkingAt: nextThinkingAt,
        // A durable update can invalidate a previous ephemeral observation, but `active` itself
        // is not evidence that this device can currently reach the runtime.
        ...(typeof updateBody.active === 'boolean' ? { presence: undefined } : {}),
        meaningfulActivityAt:
            typeof updateBody.meaningfulActivityAt === 'number'
                ? updateBody.meaningfulActivityAt
                : renderable.meaningfulActivityAt,
        metadataLayoutVersion: updateBody.metadata && hydrateMetadata && !retainOwnerProjection
            ? nextMetadataLayoutVersion
            : renderable.metadataLayoutVersion,
        metadataVersion: updateBody.metadata && hydrateMetadata && !retainOwnerProjection
            ? updateBody.metadata.version
            : renderable.metadataVersion,
        agentStateVersion: updateBody.agentState && hydrateAgentState ? updateBody.agentState.version : renderable.agentStateVersion,
        metadata: mergedRenderableMetadata,
        agentActivityHeadline,
        archivedAt:
            typeof updateBody.archivedAt === 'number' || updateBody.archivedAt === null
                ? updateBody.archivedAt
                : renderable.archivedAt,
        lastViewedSessionSeq: nextLastViewedSessionSeq,
        latestTurnId: nextLatestTurnId,
        latestTurnStatus: nextLatestTurnStatus,
        latestTurnStatusObservedAt: nextLatestTurnStatusObservedAt,
        latestReadyEventSeq: nextLatestReadyEventSeq,
        latestReadyEventAt: nextLatestReadyEventAt,
        ...(rollbackEligibleTurnStarts !== undefined ? { rollbackEligibleTurnStarts } : {}),
        pendingRequestObservedAt: nextPendingRequestObservedAt,
        lastRuntimeIssue:
            updateBody.lastRuntimeIssue === null
            || (updateBody.lastRuntimeIssue && typeof updateBody.lastRuntimeIssue === 'object')
                ? updateBody.lastRuntimeIssue
                : renderable.lastRuntimeIssue,
        ...resolveSessionRuntimeActivityProjectionFields(
            renderable,
            updateBody,
            params.onRuntimeActivityResyncRequired,
        ),
        ...(clearsStaleThinking ? {
            optimisticThinkingAt: null,
            thinkingGraceUntil: null,
        } : {}),
        hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
        hasUnreadMessages: deriveSessionListRenderableHasUnreadMessagesFromMetadataPatch({
            viewer,
            owner: renderable.owner,
            access: renderable.access,
            accessLevel: renderable.accessLevel,
            metadata: parsedMetadata,
            nextSessionSeq,
            nextLastViewedSessionSeq,
            nextLatestTurnStatus,
            nextLatestReadyEventSeq,
            readableActivity: readRenderablePatchReadableActivity(renderable.id),
            previousHasUnreadMessages: renderable.hasUnreadMessages,
            recomputeUnread: shouldRecomputeUnread,
        }),
    };
}

export async function fetchAndApplyMessages(params: {
    sessionId: string;
    shouldContinue?: () => boolean;
    scope?: 'main' | 'sidechain' | 'all';
    sidechainId?: string | null;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    isSessionKnown?: (sessionId: string) => boolean;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: SessionReceivedMessages;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent) => void;
    markMessagesLoaded: (sessionId: string) => void;
    onMessagesPage?: (page: SessionMessagesPageV1) => void;
    log: { log: (message: string) => void };
} & SessionMessagesPageOptions): Promise<void> {
    const scope = params.scope ?? 'main';
    const sidechainId = typeof params.sidechainId === 'string' && params.sidechainId.trim().length > 0 ? params.sidechainId.trim() : null;
    if (scope === 'sidechain' && sidechainId === null) {
        throw new Error('fetchMessages: sidechainId is required when scope=sidechain');
    }
    const qs = new URLSearchParams();
    if (scope !== 'all') {
        qs.set('scope', scope);
    } else {
        qs.set('scope', 'all');
    }
    if (scope === 'sidechain' && sidechainId) {
        qs.set('sidechainId', sidechainId);
    }
    const result = await runSessionMessagesPagePipeline({
        sessionId: params.sessionId,
        purpose: 'initial',
        shouldContinue: params.shouldContinue,
        serverId: params.serverId,
        page: {
            direction: 'initial',
            requestPath: `/v1/sessions/${params.sessionId}/messages?${qs.toString()}`,
            scope,
            sidechainId,
        },
        lifecyclePolicy: 'emit',
        getSessionEncryption: params.getSessionEncryption,
        isSessionKnown: params.isSessionKnown,
        request: params.request,
        sessionReceivedMessages: params.sessionReceivedMessages,
        applyMessages: params.applyMessages,
        applyMessageMetadata: params.applyMessageMetadata,
        onTaskLifecycleEvent: params.onTaskLifecycleEvent,
        onMessagesPage: params.onMessagesPage,
        log: params.log,
        sessionEncryptionMode: params.sessionEncryptionMode,
        onContentAuthenticationFailure: params.onContentAuthenticationFailure,
        isCurrent: params.isCurrent,
        initialMessageDecryptBatchSize: params.initialMessageDecryptBatchSize,
        messageDecryptBatchSize: params.messageDecryptBatchSize,
        messageDecryptYieldDelayMs: params.messageDecryptYieldDelayMs,
        yieldToMessageDecryptBatch: params.yieldToMessageDecryptBatch,
    });

    if (result.skippedMissingSession || result.skippedSuperseded || params.isSessionKnown?.(params.sessionId) === false) return;

    params.markMessagesLoaded(params.sessionId);
    writeSyncDebugLog(
        params.log,
        `💬 fetchMessages completed for session ${params.sessionId} - processed ${result.applied} messages`,
    );
}

export async function fetchAndApplyOlderMessages(params: {
    sessionId: string;
    beforeSeq: number;
    limit: number;
    scope?: 'main' | 'sidechain' | 'all';
    sidechainId?: string | null;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    isSessionKnown?: (sessionId: string) => boolean;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: SessionReceivedMessages;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent) => void;
    onMessagesPage?: (page: SessionMessagesPageV1) => void;
    onNormalizedMessages?: (messages: NormalizedMessage[]) => void;
    log: { log: (message: string) => void };
} & SessionMessagesPageOptions): Promise<{ applied: number; page: SessionMessagesPageV1 }> {
    const { sessionId, beforeSeq, limit, request, sessionReceivedMessages, applyMessages, log } = params;

    const scope = params.scope ?? 'main';
    const sidechainId = typeof params.sidechainId === 'string' && params.sidechainId.trim().length > 0 ? params.sidechainId.trim() : null;
    if (scope === 'sidechain' && sidechainId === null) {
        throw new Error('fetchOlderMessages: sidechainId is required when scope=sidechain');
    }

    const qs = new URLSearchParams({ beforeSeq: String(beforeSeq), limit: String(limit), scope });
    if (scope === 'sidechain' && sidechainId) {
        qs.set('sidechainId', sidechainId);
    }
    const result = await runSessionMessagesPagePipeline({
        sessionId,
        purpose: 'older',
        serverId: params.serverId,
        page: {
            direction: 'older',
            requestPath: `/v1/sessions/${sessionId}/messages?${qs.toString()}`,
            scope,
            sidechainId,
            beforeSeq,
            limit,
        },
        lifecyclePolicy: 'suppress',
        getSessionEncryption: params.getSessionEncryption,
        isSessionKnown: params.isSessionKnown,
        request,
        sessionReceivedMessages,
        applyMessages,
        applyMessageMetadata: params.applyMessageMetadata,
        onMessagesPage: params.onMessagesPage,
        onNormalizedMessages: params.onNormalizedMessages,
        log,
        sessionEncryptionMode: params.sessionEncryptionMode,
        onContentAuthenticationFailure: params.onContentAuthenticationFailure,
        isCurrent: params.isCurrent,
        initialMessageDecryptBatchSize: params.initialMessageDecryptBatchSize,
        messageDecryptBatchSize: params.messageDecryptBatchSize,
        messageDecryptYieldDelayMs: params.messageDecryptYieldDelayMs,
        yieldToMessageDecryptBatch: params.yieldToMessageDecryptBatch,
    });
    writeSyncDebugLog(log, `💬 fetchOlderMessages completed for session ${sessionId} - applied ${result.applied} messages`);
    return { applied: result.applied, page: result.page };
}

export async function fetchAndApplyNewerMessages(params: {
    sessionId: string;
    afterSeq: number;
    limit: number;
    /** Exact server rows whose hidden message-updated event authorized replacement. */
    authoritativeUpdateMessageIds?: ReadonlySet<string>;
    scope?: 'main' | 'sidechain' | 'all';
    sidechainId?: string | null;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    isSessionKnown?: (sessionId: string) => boolean;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: SessionReceivedMessages;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent) => void;
    onMessagesPage?: (page: SessionMessagesPageV1) => void;
    onNormalizedMessages?: (messages: NormalizedMessage[]) => void;
    log: { log: (message: string) => void };
} & SessionMessagesPageOptions): Promise<{ applied: number; page: SessionMessagesPageV1 }> {
    const { sessionId, afterSeq, limit, request, sessionReceivedMessages, applyMessages, log } = params;

    const scope = params.scope ?? 'main';
    const sidechainId = typeof params.sidechainId === 'string' && params.sidechainId.trim().length > 0 ? params.sidechainId.trim() : null;
    if (scope === 'sidechain' && sidechainId === null) {
        throw new Error('fetchNewerMessages: sidechainId is required when scope=sidechain');
    }

    const qs = new URLSearchParams({ afterSeq: String(afterSeq), limit: String(limit), scope });
    if (scope === 'sidechain' && sidechainId) {
        qs.set('sidechainId', sidechainId);
    }
    const result = await runSessionMessagesPagePipeline({
        sessionId,
        purpose: 'newer',
        serverId: params.serverId,
        page: {
            direction: 'newer',
            requestPath: `/v1/sessions/${sessionId}/messages?${qs.toString()}`,
            scope,
            sidechainId,
            afterSeq,
            limit,
        },
        lifecyclePolicy: 'emit',
        getSessionEncryption: params.getSessionEncryption,
        isSessionKnown: params.isSessionKnown,
        authoritativeUpdateMessageIds: params.authoritativeUpdateMessageIds,
        request,
        sessionReceivedMessages,
        applyMessages,
        applyMessageMetadata: params.applyMessageMetadata,
        onTaskLifecycleEvent: params.onTaskLifecycleEvent,
        onMessagesPage: params.onMessagesPage,
        onNormalizedMessages: params.onNormalizedMessages,
        log,
        sessionEncryptionMode: params.sessionEncryptionMode,
        onContentAuthenticationFailure: params.onContentAuthenticationFailure,
        isCurrent: params.isCurrent,
        initialMessageDecryptBatchSize: params.initialMessageDecryptBatchSize,
        messageDecryptBatchSize: params.messageDecryptBatchSize,
        messageDecryptYieldDelayMs: params.messageDecryptYieldDelayMs,
        yieldToMessageDecryptBatch: params.yieldToMessageDecryptBatch,
    });
    writeSyncDebugLog(log, `💬 fetchNewerMessages completed for session ${sessionId} - applied ${result.applied} messages`);
    return { applied: result.applied, page: result.page };
}

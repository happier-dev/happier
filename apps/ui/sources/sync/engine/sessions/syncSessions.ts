import type { NormalizedMessage } from '@/sync/typesRaw';
import { computeNextSessionSeqFromUpdate } from '@/sync/domains/session/sequence/realtimeSessionSeq';
import type { AgentState, Metadata, Session } from '@/sync/domains/state/storageTypes';
import { computeNextReadStateV1 } from '@/sync/domains/state/readStateV1';
import { preserveSessionRuntimeLocalMetadata } from '@/sync/domains/session/preserveSessionRuntimeLocalMetadata';
import {
    deriveSessionListRenderableHasUnreadMessagesFromMetadataPatch,
    derivePendingRequestFlagsFromAgentState,
    summarizeSessionListReadableActivityFromMessageRecords,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListRenderableMetadataComparison } from '@/sync/domains/session/listing/sessionListRenderableMetadataComparison';
import type { ApiSessionMessagesResponse } from '@/sync/api/types/apiTypes';
import { storage } from '@/sync/domains/state/storage';
import { readRollbackEligibleTurnStarts } from '@/sync/domains/session/rollback/rollbackEligibleTurnStarts';
import type { Encryption } from '@/sync/encryption/encryption';
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
} from './sessionMessageCurrentness';
import {
    resolveSessionRuntimeActivityProjectionFields,
    type SessionRuntimeActivityResyncHandler,
} from './sessionRuntimeActivityProjection';
import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol';
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

function readRenderablePatchReadableActivity(sessionId: string) {
    const sessionMessages = storage.getState().sessionMessages?.[sessionId];
    if (!sessionMessages) return undefined;
    return summarizeSessionListReadableActivityFromMessageRecords(
        sessionMessages.messageIdsOldestFirst,
        sessionMessages.messagesById,
    );
}

function applySidechainScopeMetadata(params: Readonly<{
    normalizedMessage: NormalizedMessage;
    inputSidechainId: unknown;
    scope?: 'main' | 'sidechain' | 'all';
    requestedSidechainId?: string | null;
}>): void {
    const inputSidechainId = typeof params.inputSidechainId === 'string' && params.inputSidechainId.trim().length > 0
        ? params.inputSidechainId.trim()
        : null;
    const requestedSidechainId = typeof params.requestedSidechainId === 'string' && params.requestedSidechainId.trim().length > 0
        ? params.requestedSidechainId.trim()
        : null;
    const resolvedSidechainId = inputSidechainId ?? (params.scope === 'sidechain' ? requestedSidechainId : null);
    if (!resolvedSidechainId) return;
    params.normalizedMessage.sidechainId = resolvedSidechainId;
    params.normalizedMessage.isSidechain = true;
}

type SessionEncryption = {
    decryptAgentState: (version: number, value: string | null) => Promise<AgentState>;
    decryptMetadata: (version: number, value: string) => Promise<Metadata | null>;
    decryptMetadataPayload: (version: number, value: string) => Promise<unknown | null>;
    decryptSessionSnapshotState?: (
        metadataVersion: number,
        metadata: string,
        agentStateVersion: number,
        agentState: string | null | undefined,
    ) => Promise<{ metadata: Metadata | null; agentState: AgentState }>;
};

type NewSessionSocketEncryption = {
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeSessions: (sessionKeys: Map<string, Uint8Array | null>) => Promise<void>;
    getSessionEncryption: (sessionId: string) => SessionEncryption | null;
};

type NewSessionSocketUpdateBody = Readonly<{
    t: 'new-session';
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
}>;

function readNewSessionId(body: NewSessionSocketUpdateBody): string | null {
    const id = typeof body.id === 'string' && body.id.trim().length > 0
        ? body.id.trim()
        : typeof body.sid === 'string' && body.sid.trim().length > 0
            ? body.sid.trim()
            : '';
    return id || null;
}

function resolveNewSessionEncryptionMode(body: NewSessionSocketUpdateBody): 'e2ee' | 'plain' | null {
    if (body.encryptionMode === 'plain') return 'plain';
    if (body.encryptionMode === 'e2ee') return 'e2ee';
    if (typeof body.dataEncryptionKey === 'string' && body.dataEncryptionKey.length > 0) return 'e2ee';
    return null;
}

export async function buildNewSessionFromSocketUpdate(params: {
    updateBody: NewSessionSocketUpdateBody;
    updateSeq: number;
    updateCreatedAt: number;
    sourceServerId?: string | null;
    encryption: NewSessionSocketEncryption | null;
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
                    agentState: metadataLayoutVersion === 1
                        ? null
                        : parsePlainSessionAgentState(agentStatePayload),
                };
            }

            if (typeof updateBody.dataEncryptionKey !== 'string' || updateBody.dataEncryptionKey.length === 0) {
                return { metadata: null, agentState: {} };
            }
            if (!encryption) {
                return { metadata: null, agentState: {} };
            }
            const dataEncryptionKey: string = updateBody.dataEncryptionKey;

            const dataKey = await encryption.decryptEncryptionKey(dataEncryptionKey);
            await encryption.initializeSessions(new Map([[sessionId, dataKey]]));
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

    return {
        id: sessionId,
        ...(typeof params.sourceServerId === 'string' && params.sourceServerId.trim().length > 0
            ? { serverId: params.sourceServerId.trim() }
            : {}),
        seq: readTimestamp(updateBody.seq, params.updateSeq),
        encryptionMode,
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
        presence: active ? 'online' : activeAt,
        pendingPermissionRequestCount: pendingFlags.hasPendingPermissionRequests ? 1 : 0,
        pendingUserActionRequestCount: pendingFlags.hasPendingUserActionRequests ? 1 : 0,
    };
}

export function handleDeleteSessionSocketUpdate(params: {
    sessionId: string;
    /** Socket owns its queued/coalesced work; callers inject its per-session teardown. */
    dropSocketSessionWork?: (sessionId: string) => void;
    invalidateSessionHydration?: (sessionId: string) => void;
    resetSessionTranscriptState?: (sessionId: string) => void;
    deleteSession: (sessionId: string) => void;
    removeSessionEncryption: (sessionId: string) => void;
    removeProjectManagerSession: (sessionId: string) => void;
    clearScmStatusForSession: (sessionId: string) => void;
    log: { log: (message: string) => void };
}) {
    const {
        sessionId,
        dropSocketSessionWork,
        invalidateSessionHydration,
        resetSessionTranscriptState,
        deleteSession,
        removeSessionEncryption,
        removeProjectManagerSession,
        clearScmStatusForSession,
        log,
    } = params;

    // Drop admitted socket work before it can flush back into the just-deleted
    // carrier. The socket module owns this queue/raw-normalization inventory.
    dropSocketSessionWork?.(sessionId);

    // Fence older by-id responses before removing local state or encryption.
    // Otherwise an already-started hydration can reapply the deleted tuple/key.
    invalidateSessionHydration?.(sessionId);

    // Sync owns the transcript's map, pagination and deferred state. Reset it
    // before the session disappears so a later same-id carrier is a fresh row.
    resetSessionTranscriptState?.(sessionId);

    // Remove session from storage
    deleteSession(sessionId);

    // Remove encryption keys from memory
    removeSessionEncryption(sessionId);

    // Remove from project manager
    removeProjectManagerSession(sessionId);

    // Clear any cached git status
    clearScmStatusForSession(sessionId);

    log.log(`🗑️ Session ${sessionId} deleted from local storage`);
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

    return {
        ...session,
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
    });
    const storedMetadataLayoutVersion = readSessionMetadataLayoutVersion(session.metadataLayoutVersion);
    const nextMetadataLayoutVersion = Math.max(
        storedMetadataLayoutVersion,
        readSessionMetadataLayoutVersion(updateBody.metadataLayoutVersion),
    );
    const metadataRevisionAdvances = compareSessionMetadataRevisions({
        incomingLayoutVersion: nextMetadataLayoutVersion,
        incomingMetadataVersion: updateBody.metadata?.version,
        storedLayoutVersion: storedMetadataLayoutVersion,
        storedMetadataVersion: session.metadataVersion,
    }) > 0;

    const hydrateAgentState = updateBody.agentState
        ? params.hydrateState?.agentState !== false
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
                        )
                        : sessionEncryption!.decryptMetadata(
                            updateBody.metadata.version,
                            updateBody.metadata.value,
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
        metadataLayoutVersion: hydrateMetadata
            ? nextMetadataLayoutVersion
            : session.metadataLayoutVersion,
        agentState,
        agentStateVersion: hydrateAgentState ? updateBody.agentState.version : session.agentStateVersion,
        metadata: mergedMetadata,
        metadataVersion: hydrateMetadata ? updateBody.metadata.version : session.metadataVersion,
        ...(hydrateMetadata && nextMetadataLayoutVersion === 1
            ? {
                ownerMetadataView: null,
            }
            : {}),
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
}): Promise<Partial<SessionListRenderableSession>> {
    const { renderable, updateBody, updateSeq, updateCreatedAt, sessionEncryption } = params;
    const storedMetadataLayoutVersion = readSessionMetadataLayoutVersion(renderable.metadataLayoutVersion);
    const nextMetadataLayoutVersion = Math.max(
        storedMetadataLayoutVersion,
        readSessionMetadataLayoutVersion(updateBody.metadataLayoutVersion),
    );
    const metadataRevisionAdvances = compareSessionMetadataRevisions({
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
        ? params.hydrateState?.agentState !== false
        : false;

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
                            )
                            : sessionEncryption.decryptMetadata(
                                updateBody.metadata.version,
                                updateBody.metadata.value,
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
    const parsedRenderableMetadata = parsedMetadata === undefined
        ? undefined
        : buildSessionListRenderableMetadataComparison(parsedMetadata, renderable.metadata);
    const mergedRenderableMetadata = parsedRenderableMetadata === undefined
        ? renderable.metadata
        : nextMetadataLayoutVersion === 1
            ? parsedRenderableMetadata
            : preserveSessionRuntimeLocalMetadata(renderable.metadata, parsedRenderableMetadata);
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
    const shouldRecomputeUnread =
        typeof updateBody.lastViewedSessionSeq === 'number'
        || typeof updateBody.latestReadyEventSeq === 'number'
        || (
            isTerminalPrimaryTurnStatus(nextLatestTurnStatus)
            && updateBody.latestTurnStatus === nextLatestTurnStatus
        );

    return {
        seq: nextSessionSeq,
        updatedAt: updateCreatedAt,
        active: nextActive,
        activeAt: nextActiveAt,
        thinking: nextThinking,
        thinkingAt: nextThinkingAt,
        presence: nextActive ? 'online' : nextActiveAt,
        meaningfulActivityAt:
            typeof updateBody.meaningfulActivityAt === 'number'
                ? updateBody.meaningfulActivityAt
                : renderable.meaningfulActivityAt,
        metadataLayoutVersion: updateBody.metadata && hydrateMetadata
            ? nextMetadataLayoutVersion
            : renderable.metadataLayoutVersion,
        metadataVersion: updateBody.metadata && hydrateMetadata ? updateBody.metadata.version : renderable.metadataVersion,
        agentStateVersion: updateBody.agentState && hydrateAgentState ? updateBody.agentState.version : renderable.agentStateVersion,
        metadata: mergedRenderableMetadata,
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

export async function repairInvalidReadStateV1(params: {
    sessionId: string;
    sessionSeqUpperBound: number;
    attempted: Set<string>;
    inFlight: Set<string>;
    getSession: (sessionId: string) => {
        metadata?: Metadata | null;
        metadataLayoutVersion?: number;
    } | undefined;
    updateSessionMetadataWithRetry: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
    now: () => number;
}): Promise<void> {
    const { sessionId, sessionSeqUpperBound, attempted, inFlight, getSession, updateSessionMetadataWithRetry, now } = params;

    if (attempted.has(sessionId) || inFlight.has(sessionId)) {
        return;
    }

    const session = getSession(sessionId);
    if (readSessionMetadataLayoutVersion(session?.metadataLayoutVersion) !== 0) return;
    const readState = session?.metadata?.readStateV1;
    if (!readState) return;
    if (readState.sessionSeq <= sessionSeqUpperBound) return;

    attempted.add(sessionId);
    inFlight.add(sessionId);
    try {
        await updateSessionMetadataWithRetry(sessionId, (metadata) => {
            const prev = metadata.readStateV1;
            if (!prev) return metadata;
            if (prev.sessionSeq <= sessionSeqUpperBound) return metadata;

            const result = computeNextReadStateV1({
                prev,
                sessionSeq: sessionSeqUpperBound,
                pendingActivityAt: prev.pendingActivityAt,
                now: now(),
            });
            if (!result.didChange) return metadata;
            return { ...metadata, readStateV1: result.next };
        });
    } catch {
        // ignore
    } finally {
        inFlight.delete(sessionId);
    }
}

export async function fetchAndApplyMessages(params: {
    sessionId: string;
    scope?: 'main' | 'sidechain' | 'all';
    sidechainId?: string | null;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    isSessionKnown?: (sessionId: string) => boolean;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: SessionReceivedMessages;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent) => void;
    markMessagesLoaded: (sessionId: string) => void;
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
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
        onTaskLifecycleEvent: params.onTaskLifecycleEvent,
        onMessagesPage: params.onMessagesPage,
        log: params.log,
        sessionEncryptionMode: params.sessionEncryptionMode,
        initialMessageDecryptBatchSize: params.initialMessageDecryptBatchSize,
        messageDecryptBatchSize: params.messageDecryptBatchSize,
        messageDecryptYieldDelayMs: params.messageDecryptYieldDelayMs,
        yieldToMessageDecryptBatch: params.yieldToMessageDecryptBatch,
    });

    if (result.skippedMissingSession || params.isSessionKnown?.(params.sessionId) === false) return;

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
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
    onNormalizedMessages?: (messages: NormalizedMessage[]) => void;
    log: { log: (message: string) => void };
} & SessionMessagesPageOptions): Promise<{ applied: number; page: ApiSessionMessagesResponse }> {
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
        onMessagesPage: params.onMessagesPage,
        onNormalizedMessages: params.onNormalizedMessages,
        log,
        sessionEncryptionMode: params.sessionEncryptionMode,
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
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
    onNormalizedMessages?: (messages: NormalizedMessage[]) => void;
    log: { log: (message: string) => void };
} & SessionMessagesPageOptions): Promise<{ applied: number; page: ApiSessionMessagesResponse }> {
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
        onTaskLifecycleEvent: params.onTaskLifecycleEvent,
        onMessagesPage: params.onMessagesPage,
        onNormalizedMessages: params.onNormalizedMessages,
        log,
        sessionEncryptionMode: params.sessionEncryptionMode,
        initialMessageDecryptBatchSize: params.initialMessageDecryptBatchSize,
        messageDecryptBatchSize: params.messageDecryptBatchSize,
        messageDecryptYieldDelayMs: params.messageDecryptYieldDelayMs,
        yieldToMessageDecryptBatch: params.yieldToMessageDecryptBatch,
    });
    writeSyncDebugLog(log, `💬 fetchNewerMessages completed for session ${sessionId} - applied ${result.applied} messages`);
    return { applied: result.applied, page: result.page };
}

import type { NormalizedMessage, RawRecord } from '@/sync/typesRaw';
import { normalizeRawMessage } from '@/sync/typesRaw';
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
import type { ApiMessage, ApiSessionMessagesResponse } from '@/sync/api/types/apiTypes';
import { ApiSessionMessagesResponseSchema } from '@/sync/api/types/apiTypes';
import { storage } from '@/sync/domains/state/storage';
import { readRollbackEligibleTurnStarts } from '@/sync/domains/session/rollback/rollbackEligibleTurnStarts';
import type { Encryption } from '@/sync/encryption/encryption';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import { writeSyncDebugLog } from '@/sync/runtime/syncDebugLogging';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { nowServerMs } from '@/sync/runtime/time';
import { getTaskLifecycleEventFromRawContent, type TaskLifecycleEvent } from './taskLifecycle';
import {
    parsePlainSessionAgentState,
    parsePlainSessionMetadata,
    tryParsePlainSessionAgentState,
    tryParsePlainSessionMetadata,
} from './parsePlainSessionPayload';
import { isLegacyMemoryArtifactTranscriptRow } from './legacyMemoryArtifactTranscriptRows';
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
    decryptSessionSnapshotState?: (
        metadataVersion: number,
        metadata: string,
        agentStateVersion: number,
        agentState: string | null | undefined,
    ) => Promise<{ metadata: Metadata | null; agentState: AgentState }>;
};

export function handleDeleteSessionSocketUpdate(params: {
    sessionId: string;
    deleteSession: (sessionId: string) => void;
    removeSessionEncryption: (sessionId: string) => void;
    removeProjectManagerSession: (sessionId: string) => void;
    clearScmStatusForSession: (sessionId: string) => void;
    log: { log: (message: string) => void };
}) {
    const { sessionId, deleteSession, removeSessionEncryption, removeProjectManagerSession, clearScmStatusForSession, log } = params;

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
    });

    const hydrateAgentState = updateBody.agentState
        ? params.hydrateState?.agentState !== false
        : false;
    const hydrateMetadata = updateBody.metadata
        ? params.hydrateState?.metadata !== false
            && isStrictlyNewerSessionMetadataVersion(updateBody.metadata.version, session.metadataVersion)
        : false;
    const hasStatePayload = hydrateMetadata || hydrateAgentState;
    const shouldBatchDecryptState = Boolean(
        hydrateMetadata
        && hydrateAgentState
        && encryptionMode === 'e2ee'
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
                metadata: decryptedState.metadata,
                agentState: decryptedState.agentState,
            };
        }

        const agentStatePromise = updateBody.agentState && hydrateAgentState
            ? encryptionMode === 'plain'
                ? Promise.resolve(parsePlainSessionAgentState(updateBody.agentState.value))
                : sessionEncryption!.decryptAgentState(updateBody.agentState.version, updateBody.agentState.value)
            : Promise.resolve(session.agentState);

        const metadataPromise = updateBody.metadata && hydrateMetadata
            ? encryptionMode === 'plain'
                ? Promise.resolve(parsePlainSessionMetadata(updateBody.metadata.value))
                : sessionEncryption!.decryptMetadata(updateBody.metadata.version, updateBody.metadata.value)
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
    const mergedMetadata = preserveSessionRuntimeLocalMetadata(session.metadata, metadata);

    const nextSession: Session = {
        ...projectionSession,
        agentState,
        agentStateVersion: hydrateAgentState ? updateBody.agentState.version : session.agentStateVersion,
        metadata: mergedMetadata,
        metadataVersion: hydrateMetadata ? updateBody.metadata.version : session.metadataVersion,
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
}): Promise<Partial<SessionListRenderableSession>> {
    const { renderable, updateBody, updateSeq, updateCreatedAt, sessionEncryption } = params;
    const hydrateMetadata = updateBody.metadata
        ? params.hydrateState?.metadata !== false
            && isStrictlyNewerSessionMetadataVersion(updateBody.metadata.version, renderable.metadataVersion)
        : false;
    const hydrateAgentState = updateBody.agentState
        ? params.hydrateState?.agentState !== false
        : false;

    const parsedMetadata =
        !updateBody.metadata || !hydrateMetadata
            ? undefined
            : sessionEncryption
                ? await sessionEncryption.decryptMetadata(updateBody.metadata.version, updateBody.metadata.value)
                : typeof updateBody.metadata.value === 'string'
                    ? tryParsePlainSessionMetadata(updateBody.metadata.value)
                    : updateBody.metadata.value === null
                        ? null
                        : undefined;

    const parsedAgentState =
        !updateBody.agentState || !hydrateAgentState
            ? undefined
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
    getSession: (sessionId: string) => { metadata?: Metadata | null } | undefined;
    updateSessionMetadataWithRetry: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
    now: () => number;
}): Promise<void> {
    const { sessionId, sessionSeqUpperBound, attempted, inFlight, getSession, updateSessionMetadataWithRetry, now } = params;

    if (attempted.has(sessionId) || inFlight.has(sessionId)) {
        return;
    }

    const session = getSession(sessionId);
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

type SessionMessagesEncryption = {
    decryptMessages: (messages: ApiMessage[]) => Promise<Array<DecryptedSessionMessage | null>>;
};

type SessionMessagesEncryptionMode = 'e2ee' | 'plain';

type DecryptedSessionMessage = Readonly<{
    id: string;
    seq?: number | null;
    localId: string | null;
    content: unknown | null;
    createdAt: number;
}>;

type MessageDecryptBatchOptions = {
    initialMessageDecryptBatchSize?: number;
    messageDecryptBatchSize?: number;
    messageDecryptYieldDelayMs?: number;
    yieldToMessageDecryptBatch?: (delayMs: number) => Promise<void>;
};

type SessionMessagesPageOptions = MessageDecryptBatchOptions & {
    sessionEncryptionMode?: SessionMessagesEncryptionMode;
};

const DEFAULT_MESSAGE_DECRYPT_BATCH_SIZE = 8;
const DEFAULT_INITIAL_MESSAGE_DECRYPT_BATCH_SIZE = 64;

const plainSessionMessagesEncryption: SessionMessagesEncryption = {
    decryptMessages: async (messages) => Promise.all(
        messages.map((message) => readStoredSessionMessage({ message })),
    ),
};

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(1, Math.trunc(value));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(0, Math.trunc(value));
}

function resolveMessageDecryptBatchSize(kind: MessagePageTelemetryKind, options: MessageDecryptBatchOptions): number {
    if (kind === 'initial') {
        return normalizePositiveInteger(
            options.initialMessageDecryptBatchSize ?? options.messageDecryptBatchSize,
            DEFAULT_INITIAL_MESSAGE_DECRYPT_BATCH_SIZE,
        );
    }
    return normalizePositiveInteger(options.messageDecryptBatchSize, DEFAULT_MESSAGE_DECRYPT_BATCH_SIZE);
}

async function yieldToMessageDecryptBatch(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
    });
}

function resolveSessionMessagesEncryption(params: Readonly<{
    sessionId: string;
    sessionEncryptionMode?: SessionMessagesEncryptionMode;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
}>): SessionMessagesEncryption | null {
    if (params.sessionEncryptionMode === 'plain') {
        return plainSessionMessagesEncryption;
    }
    return params.getSessionEncryption(params.sessionId);
}

type MessagePageTelemetryKind = 'initial' | 'older' | 'newer';
type MessagePageScope = 'main' | 'sidechain' | 'all';

function messagePageTelemetryFields(
    kind: MessagePageTelemetryKind,
    fields: Record<string, number>,
): Record<string, number> {
    return {
        initial: kind === 'initial' ? 1 : 0,
        older: kind === 'older' ? 1 : 0,
        newer: kind === 'newer' ? 1 : 0,
        ...fields,
    };
}

function messagePageScopeTelemetryFields(
    kind: MessagePageTelemetryKind,
    scope: MessagePageScope,
    sidechainId: string | null,
    fields: Record<string, number> = {},
): Record<string, number> {
    return messagePageTelemetryFields(kind, {
        scopeMain: scope === 'main' ? 1 : 0,
        scopeSidechain: scope === 'sidechain' ? 1 : 0,
        scopeAll: scope === 'all' ? 1 : 0,
        hasSidechainId: sidechainId ? 1 : 0,
        ...fields,
    });
}

async function fetchSessionMessagesPageWithTelemetry(params: Readonly<{
    kind: MessagePageTelemetryKind;
    request: (path: string) => Promise<Response>;
    path: string;
    scope: MessagePageScope;
    sidechainId: string | null;
    limit?: number;
    beforeSeq?: number;
    afterSeq?: number;
}>): Promise<ApiSessionMessagesResponse> {
    const rangeFields: Record<string, number> = {};
    if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
        rangeFields.limit = Math.trunc(params.limit);
    }
    if (typeof params.beforeSeq === 'number' && Number.isFinite(params.beforeSeq)) {
        rangeFields.beforeSeq = Math.trunc(params.beforeSeq);
    }
    if (typeof params.afterSeq === 'number' && Number.isFinite(params.afterSeq)) {
        rangeFields.afterSeq = Math.trunc(params.afterSeq);
    }

    const requestFields = messagePageScopeTelemetryFields(
        params.kind,
        params.scope,
        params.sidechainId,
        rangeFields,
    );
    const response = await syncPerformanceTelemetry.measureAsync(
        'sync.sessions.messages.request',
        requestFields,
        () => params.request(params.path),
    );
    const json = await syncPerformanceTelemetry.measureAsync(
        'sync.sessions.messages.responseJson',
        {
            ...requestFields,
            status: typeof response.status === 'number' && Number.isFinite(response.status)
                ? Math.trunc(response.status)
                : 0,
        },
        () => response.json(),
    );
    const parsed = syncPerformanceTelemetry.measure(
        'sync.sessions.messages.parseResponse',
        requestFields,
        () => ApiSessionMessagesResponseSchema.safeParse(json),
    );
    if (!parsed.success) {
        throw new Error(`Invalid /messages response: ${parsed.error.message}`);
    }
    return parsed.data;
}

function recordMessagePageTelemetry(kind: MessagePageTelemetryKind, fetched: number): void {
    syncPerformanceTelemetry.count('sync.sessions.messages.page', messagePageTelemetryFields(kind, { fetched }));
}

function recordMessageDedupeTelemetry(kind: MessagePageTelemetryKind, fetched: number, toDecrypt: number): void {
    syncPerformanceTelemetry.count('sync.sessions.messages.dedupe', messagePageTelemetryFields(kind, {
        fetched,
        toDecrypt,
        skipped: Math.max(0, fetched - toDecrypt),
    }));
}

async function decryptMessagesInBatchesWithTelemetry(
    kind: MessagePageTelemetryKind,
    encryption: SessionMessagesEncryption,
    messages: ApiMessage[],
    options: MessageDecryptBatchOptions,
): Promise<Array<DecryptedSessionMessage | null>> {
    const batchSize = resolveMessageDecryptBatchSize(kind, options);
    return syncPerformanceTelemetry.measureAsync(
        'sync.sessions.messages.decrypt',
        messagePageTelemetryFields(kind, {
            messages: messages.length,
            batchSize,
            yieldDelayMs: normalizeNonNegativeInteger(options.messageDecryptYieldDelayMs, 0),
        }),
        () => decryptMessagesInBatches(encryption, messages, options, batchSize),
    );
}

function recordMessageApplyTelemetry(
    kind: MessagePageTelemetryKind,
    decrypted: number,
    sessionId: string,
    normalizedMessages: NormalizedMessage[],
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void,
): void {
    syncPerformanceTelemetry.measure(
        'sync.sessions.messages.apply',
        messagePageTelemetryFields(kind, {
            decrypted,
            normalized: normalizedMessages.length,
        }),
        () => applyMessages(sessionId, normalizedMessages),
    );
}

function measureMessageNormalization<T>(
    kind: MessagePageTelemetryKind,
    decrypted: number,
    normalize: () => T,
): T {
    return syncPerformanceTelemetry.measure(
        'sync.sessions.messages.normalize',
        messagePageTelemetryFields(kind, { decrypted }),
        normalize,
    );
}

async function decryptMessagesInBatches(
    encryption: SessionMessagesEncryption,
    messages: ApiMessage[],
    options: MessageDecryptBatchOptions,
    batchSize: number,
): Promise<Array<DecryptedSessionMessage | null>> {
    if (messages.length === 0) return [];

    if (messages.length <= batchSize) {
        return encryption.decryptMessages(messages);
    }

    const yieldDelayMs = normalizeNonNegativeInteger(options.messageDecryptYieldDelayMs, 0);
    const yieldToBatch = options.yieldToMessageDecryptBatch ?? yieldToMessageDecryptBatch;
    const decryptedMessages: Array<DecryptedSessionMessage | null> = [];
    for (let index = 0; index < messages.length; index += batchSize) {
        const batch = messages.slice(index, index + batchSize);
        decryptedMessages.push(...await encryption.decryptMessages(batch));
        if (index + batchSize < messages.length) {
            await yieldToBatch(yieldDelayMs);
        }
    }
    return decryptedMessages;
}

export async function fetchAndApplyMessages(params: {
    sessionId: string;
    scope?: 'main' | 'sidechain' | 'all';
    sidechainId?: string | null;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    isSessionKnown?: (sessionId: string) => boolean;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: Map<string, Map<string, number>>;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent) => void;
    markMessagesLoaded: (sessionId: string) => void;
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
    log: { log: (message: string) => void };
} & SessionMessagesPageOptions): Promise<void> {
    const { sessionId, request, sessionReceivedMessages, applyMessages, markMessagesLoaded, log } =
        params;

    writeSyncDebugLog(log, `💬 fetchMessages starting for session ${sessionId} - acquiring lock`);

    const DEBUG_MESSAGE_DECRYPT =
        typeof globalThis !== 'undefined'
        && (
            (globalThis as any).__HAPPIER_DEBUG_MESSAGE_DECRYPT__ === true
            || (typeof localStorage !== 'undefined' && localStorage.getItem('happier.debug.messageDecrypt') === '1')
        );

    // Get encryption - may not be ready yet if session was just created
    // Throwing an error triggers backoff retry in InvalidateSync
    const encryption = resolveSessionMessagesEncryption(params);
    if (!encryption) {
        if (params.isSessionKnown?.(sessionId) === false) {
            writeSyncDebugLog(log, `💬 fetchMessages: Session ${sessionId} is not known on this server; skipping message fetch`);
            return;
        }
        writeSyncDebugLog(log, `💬 fetchMessages: Session encryption not ready for ${sessionId}, will retry`);
        throw new Error(`Session encryption not ready for ${sessionId}`);
    }

    // Request (apiSocket.request calibrates server time best-effort from the HTTP Date header)
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
    const data = await fetchSessionMessagesPageWithTelemetry({
        kind: 'initial',
        request,
        path: `/v1/sessions/${sessionId}/messages?${qs.toString()}`,
        scope,
        sidechainId,
    });
    params.onMessagesPage?.(data);
    recordMessagePageTelemetry('initial', data.messages.length);

    // Collect existing messages
    let existingMessages = sessionReceivedMessages.get(sessionId);
    if (!existingMessages) {
        existingMessages = new Map<string, number>();
        sessionReceivedMessages.set(sessionId, existingMessages);
    }

    // Decrypt and normalize messages
    const normalizedMessages: NormalizedMessage[] = [];

    // Filter out existing messages and prepare for batch decryption
    const messagesToDecrypt: ApiMessage[] = [];
    for (const msg of [...data.messages].reverse()) {
        const msgUpdatedAt = typeof msg.updatedAt === 'number' ? msg.updatedAt : msg.createdAt;
        const existingUpdatedAt = existingMessages.get(msg.id);
        if (existingUpdatedAt === undefined || msgUpdatedAt > existingUpdatedAt) {
            messagesToDecrypt.push(msg);
        }
    }
    recordMessageDedupeTelemetry('initial', data.messages.length, messagesToDecrypt.length);

    const decryptedMessages = await decryptMessagesInBatchesWithTelemetry('initial', encryption, messagesToDecrypt, params);

    // Process decrypted messages
    const debugDecryptStats = DEBUG_MESSAGE_DECRYPT
        ? {
            fetched: data.messages.length,
            toDecrypt: messagesToDecrypt.length,
            decryptedEntries: decryptedMessages.length,
            decryptedWithContent: 0,
            normalized: 0,
        }
        : null;

    measureMessageNormalization('initial', decryptedMessages.length, () => {
        for (let i = 0; i < decryptedMessages.length; i++) {
            const decrypted = decryptedMessages[i];
            const inputMessage = messagesToDecrypt[i];
            const inputWasEncrypted = inputMessage?.content?.t === 'encrypted';
            if (decrypted) {
                if (debugDecryptStats && decrypted.content !== null) {
                    debugDecryptStats.decryptedWithContent++;
                }

                const inputUpdatedAt = inputMessage
                    ? (typeof inputMessage.updatedAt === 'number' ? inputMessage.updatedAt : inputMessage.createdAt)
                    : decrypted.createdAt;
                // IMPORTANT: Do not mark encrypted messages as "received" when decryption failed.
                // Otherwise a keyless device (or a device with delayed key init) can permanently
                // treat encrypted history as empty until runtime state is fully reset.
                if (decrypted.content !== null || !inputWasEncrypted) {
                    existingMessages.set(decrypted.id, inputUpdatedAt);
                }

                // Expected: encrypted history can be present even when this device lacks the secret key.
                // In that case decryption yields null and we must not attempt to normalize/log it.
                if (inputWasEncrypted && decrypted.content === null) {
                    continue;
                }
                if (isLegacyMemoryArtifactTranscriptRow(decrypted)) {
                    continue;
                }

                const lifecycleEvent = getTaskLifecycleEventFromRawContent(decrypted.content, decrypted.createdAt);
                if (lifecycleEvent) {
                    params.onTaskLifecycleEvent?.(lifecycleEvent);
                }
                // Normalize the decrypted message
                const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content, { seq: decrypted.seq ?? undefined });
                if (normalized) {
                    applySidechainScopeMetadata({
                        normalizedMessage: normalized,
                        inputSidechainId: inputMessage?.sidechainId,
                        scope: params.scope,
                        requestedSidechainId: params.sidechainId ?? null,
                    });
                    normalizedMessages.push(normalized);
                }
            }
        }
    });

    if (debugDecryptStats) {
        debugDecryptStats.normalized = normalizedMessages.length;
        const sample = messagesToDecrypt[0];
        const sampleCipherPreview =
            sample && sample.content?.t === 'encrypted' && typeof sample.content.c === 'string'
                ? `${sample.content.c.slice(0, 24)}…(${sample.content.c.length})`
                : null;

        log.log(
            `[debug] fetchMessages decrypt stats for ${sessionId}: `
                + `fetched=${debugDecryptStats.fetched} `
                + `toDecrypt=${debugDecryptStats.toDecrypt} `
                + `decryptedWithContent=${debugDecryptStats.decryptedWithContent} `
                + `normalized=${debugDecryptStats.normalized}`
                + (sample ? ` sample={id:${sample.id} seq:${sample.seq} cipher:${sampleCipherPreview}}` : '')
        );
    }

    // Apply to storage
    recordMessageApplyTelemetry('initial', decryptedMessages.length, sessionId, normalizedMessages, applyMessages);

    markMessagesLoaded(sessionId);
    writeSyncDebugLog(log, `💬 fetchMessages completed for session ${sessionId} - processed ${normalizedMessages.length} messages`);
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
    sessionReceivedMessages: Map<string, Map<string, number>>;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent) => void;
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
    onNormalizedMessages?: (messages: NormalizedMessage[]) => void;
    log: { log: (message: string) => void };
} & SessionMessagesPageOptions): Promise<{ applied: number; page: ApiSessionMessagesResponse }> {
    const { sessionId, beforeSeq, limit, request, sessionReceivedMessages, applyMessages, log } = params;

    // Get encryption - may not be ready yet if session was just created
    const encryption = resolveSessionMessagesEncryption(params);
    if (!encryption) {
        if (params.isSessionKnown?.(sessionId) === false) {
            writeSyncDebugLog(log, `💬 fetchOlderMessages: Session ${sessionId} is not known on this server; skipping page fetch`);
            return {
                applied: 0,
                page: {
                    messages: [],
                    hasMore: false,
                    nextBeforeSeq: null,
                },
            };
        }
        throw new Error(`Session encryption not ready for ${sessionId}`);
    }

    const scope = params.scope ?? 'main';
    const sidechainId = typeof params.sidechainId === 'string' && params.sidechainId.trim().length > 0 ? params.sidechainId.trim() : null;
    if (scope === 'sidechain' && sidechainId === null) {
        throw new Error('fetchOlderMessages: sidechainId is required when scope=sidechain');
    }

    const qs = new URLSearchParams({ beforeSeq: String(beforeSeq), limit: String(limit), scope });
    if (scope === 'sidechain' && sidechainId) {
        qs.set('sidechainId', sidechainId);
    }
    const data = await fetchSessionMessagesPageWithTelemetry({
        kind: 'older',
        request,
        path: `/v1/sessions/${sessionId}/messages?${qs.toString()}`,
        scope,
        sidechainId,
        limit,
        beforeSeq,
    });
    params.onMessagesPage?.(data);
    recordMessagePageTelemetry('older', data.messages.length);

    let existingMessages = sessionReceivedMessages.get(sessionId);
    if (!existingMessages) {
        existingMessages = new Map<string, number>();
        sessionReceivedMessages.set(sessionId, existingMessages);
    }

    const messagesToDecrypt: ApiMessage[] = [];
    for (const msg of [...data.messages].reverse()) {
        const msgUpdatedAt = typeof msg.updatedAt === 'number' ? msg.updatedAt : msg.createdAt;
        const existingUpdatedAt = existingMessages.get(msg.id);
        if (existingUpdatedAt === undefined || msgUpdatedAt > existingUpdatedAt) {
            messagesToDecrypt.push(msg);
        }
    }
    recordMessageDedupeTelemetry('older', data.messages.length, messagesToDecrypt.length);

    const decryptedMessages = await decryptMessagesInBatchesWithTelemetry('older', encryption, messagesToDecrypt, params);

    const normalizedMessages: NormalizedMessage[] = [];
    measureMessageNormalization('older', decryptedMessages.length, () => {
        for (let i = 0; i < decryptedMessages.length; i++) {
            const decrypted = decryptedMessages[i];
            if (decrypted) {
                const inputMessage = messagesToDecrypt[i];
                const inputWasEncrypted = inputMessage?.content?.t === 'encrypted';

                const inputUpdatedAt = inputMessage
                    ? (typeof inputMessage.updatedAt === 'number' ? inputMessage.updatedAt : inputMessage.createdAt)
                    : decrypted.createdAt;
                if (decrypted.content !== null || !inputWasEncrypted) {
                    existingMessages.set(decrypted.id, inputUpdatedAt);
                }
                if (inputWasEncrypted && decrypted.content === null) {
                    continue;
                }
                if (isLegacyMemoryArtifactTranscriptRow(decrypted)) {
                    continue;
                }
                // Older pages can include historical lifecycle markers (task_complete/turn_aborted) that
                // should not clobber current in-flight UI state. Lifecycle handling is reserved for
                // newer/socket flows.
                const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content, { seq: decrypted.seq ?? undefined });
                if (normalized) {
                    applySidechainScopeMetadata({
                        normalizedMessage: normalized,
                        inputSidechainId: inputMessage?.sidechainId,
                        scope,
                        requestedSidechainId: sidechainId,
                    });
                    normalizedMessages.push(normalized);
                }
            }
        }
    });

    params.onNormalizedMessages?.(normalizedMessages);
    recordMessageApplyTelemetry('older', decryptedMessages.length, sessionId, normalizedMessages, applyMessages);
    writeSyncDebugLog(log, `💬 fetchOlderMessages completed for session ${sessionId} - applied ${normalizedMessages.length} messages`);
    return { applied: normalizedMessages.length, page: data };
}

export async function fetchAndApplyNewerMessages(params: {
    sessionId: string;
    afterSeq: number;
    limit: number;
    scope?: 'main' | 'sidechain' | 'all';
    sidechainId?: string | null;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    isSessionKnown?: (sessionId: string) => boolean;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: Map<string, Map<string, number>>;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent) => void;
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
    onNormalizedMessages?: (messages: NormalizedMessage[]) => void;
    log: { log: (message: string) => void };
} & SessionMessagesPageOptions): Promise<{ applied: number; page: ApiSessionMessagesResponse }> {
    const { sessionId, afterSeq, limit, request, sessionReceivedMessages, applyMessages, log } = params;

    const encryption = resolveSessionMessagesEncryption(params);
    if (!encryption) {
        if (params.isSessionKnown?.(sessionId) === false) {
            writeSyncDebugLog(log, `💬 fetchNewerMessages: Session ${sessionId} is not known on this server; skipping page fetch`);
            return {
                applied: 0,
                page: {
                    messages: [],
                    nextAfterSeq: null,
                },
            };
        }
        throw new Error(`Session encryption not ready for ${sessionId}`);
    }

    const scope = params.scope ?? 'main';
    const sidechainId = typeof params.sidechainId === 'string' && params.sidechainId.trim().length > 0 ? params.sidechainId.trim() : null;
    if (scope === 'sidechain' && sidechainId === null) {
        throw new Error('fetchNewerMessages: sidechainId is required when scope=sidechain');
    }

    const qs = new URLSearchParams({ afterSeq: String(afterSeq), limit: String(limit), scope });
    if (scope === 'sidechain' && sidechainId) {
        qs.set('sidechainId', sidechainId);
    }
    const data = await fetchSessionMessagesPageWithTelemetry({
        kind: 'newer',
        request,
        path: `/v1/sessions/${sessionId}/messages?${qs.toString()}`,
        scope,
        sidechainId,
        limit,
        afterSeq,
    });
    params.onMessagesPage?.(data);
    recordMessagePageTelemetry('newer', data.messages.length);

    let existingMessages = sessionReceivedMessages.get(sessionId);
    if (!existingMessages) {
        existingMessages = new Map<string, number>();
        sessionReceivedMessages.set(sessionId, existingMessages);
    }

    // Server returns ascending order in forward mode; decrypt/apply in that same order.
    const messagesToDecrypt: ApiMessage[] = [];
    for (const msg of data.messages) {
        const msgUpdatedAt = typeof msg.updatedAt === 'number' ? msg.updatedAt : msg.createdAt;
        const existingUpdatedAt = existingMessages.get(msg.id);
        if (existingUpdatedAt === undefined || msgUpdatedAt > existingUpdatedAt) {
            messagesToDecrypt.push(msg);
        }
    }
    recordMessageDedupeTelemetry('newer', data.messages.length, messagesToDecrypt.length);

    const decryptedMessages = await decryptMessagesInBatchesWithTelemetry('newer', encryption, messagesToDecrypt, params);

    const normalizedMessages: NormalizedMessage[] = [];
    measureMessageNormalization('newer', decryptedMessages.length, () => {
        for (let i = 0; i < decryptedMessages.length; i++) {
            const decrypted = decryptedMessages[i];
            if (decrypted) {
                const inputMessage = messagesToDecrypt[i];
                const inputWasEncrypted = inputMessage?.content?.t === 'encrypted';

                const inputUpdatedAt = inputMessage
                    ? (typeof inputMessage.updatedAt === 'number' ? inputMessage.updatedAt : inputMessage.createdAt)
                    : decrypted.createdAt;
                if (decrypted.content !== null || !inputWasEncrypted) {
                    existingMessages.set(decrypted.id, inputUpdatedAt);
                }
                if (inputWasEncrypted && decrypted.content === null) {
                    continue;
                }
                if (isLegacyMemoryArtifactTranscriptRow(decrypted)) {
                    continue;
                }
                const lifecycleEvent = getTaskLifecycleEventFromRawContent(decrypted.content, decrypted.createdAt);
                if (lifecycleEvent) {
                    params.onTaskLifecycleEvent?.(lifecycleEvent);
                }
                const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content, { seq: decrypted.seq ?? undefined });
                if (normalized) {
                    applySidechainScopeMetadata({
                        normalizedMessage: normalized,
                        inputSidechainId: inputMessage?.sidechainId,
                        scope,
                        requestedSidechainId: sidechainId,
                    });
                    normalizedMessages.push(normalized);
                }
            }
        }
    });

    params.onNormalizedMessages?.(normalizedMessages);
    recordMessageApplyTelemetry('newer', decryptedMessages.length, sessionId, normalizedMessages, applyMessages);
    writeSyncDebugLog(log, `💬 fetchNewerMessages completed for session ${sessionId} - applied ${normalizedMessages.length} messages`);
    return { applied: normalizedMessages.length, page: data };
}

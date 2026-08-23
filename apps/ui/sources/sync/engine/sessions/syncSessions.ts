import type { NormalizedMessage, RawRecord } from '@/sync/typesRaw';
import { computeNextSessionSeqFromUpdate } from '@/sync/domains/session/sequence/realtimeSessionSeq';
import type { AgentState, Metadata, Session } from '@/sync/domains/state/storageTypes';
import { computeNextReadStateV1 } from '@/sync/domains/state/readStateV1';
import type { ApiSessionMessagesResponse } from '@/sync/api/types/apiTypes';
import { buildSessionMessagesPath } from '@/sync/api/session/sessionMessagesApi';
import { storage } from '@/sync/domains/state/storage';
import type { Encryption } from '@/sync/encryption/encryption';
import { writeSyncDebugLog } from '@/sync/runtime/syncDebugLogging';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { nowServerMs } from '@/sync/runtime/time';
import type { TaskLifecycleEvent } from './taskLifecycle';
import { parsePlainSessionAgentState, parsePlainSessionMetadata } from './parsePlainSessionPayload';
import {
    runSessionMessagesPagePipeline,
    type SessionMessagesEncryption,
    type SessionMessagesPageOptions,
} from './sessionMessagesPagePipeline';
import {
    buildSessionRuntimeActivityProjectionPatch,
} from './sessionRuntimeActivityProjection';
export { handleNewMessageSocketUpdate } from './sessionSocketUpdate';
export { handleMessageUpdatedSocketUpdate } from './sessionSocketUpdate';
export { fetchAndApplySessions } from './sessionSnapshot';
export type { SessionListEncryption } from './sessionSnapshot';

function readRollbackEligibleTurnStarts(value: unknown): readonly number[] | null | undefined {
    if (value === null) return null;
    if (!Array.isArray(value)) return undefined;

    const starts: number[] = [];
    for (const entry of value) {
        if (typeof entry !== 'number' || !Number.isFinite(entry)) continue;
        const seq = Math.trunc(entry);
        if (seq < 0 || starts.includes(seq)) continue;
        starts.push(seq);
    }
    return starts;
}

function readFiniteTimestamp(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : undefined;
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
    const rollbackEligibleTurnStarts = readRollbackEligibleTurnStarts(updateBody.rollbackEligibleTurnStarts);
    const projectedActive =
        typeof updateBody.active === 'boolean'
            ? updateBody.active
            : session.active;
    const projectedActiveAt = readFiniteTimestamp(updateBody.activeAt) ?? session.activeAt;
    const projectedThinking =
        typeof updateBody.thinking === 'boolean'
            ? updateBody.thinking
            : updateBody.active === false
                ? false
                : session.thinking;
    const projectedThinkingAt =
        readFiniteTimestamp(updateBody.thinkingAt)
        ?? (typeof updateBody.thinking === 'boolean' || updateBody.active === false
            ? projectedActiveAt
            : session.thinkingAt);
    const runtimeActivityPatch = buildSessionRuntimeActivityProjectionPatch(session, updateBody);

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
        pendingRequestObservedAt:
            typeof updateBody.pendingRequestObservedAt === 'number'
            && Number.isFinite(updateBody.pendingRequestObservedAt)
                ? Math.trunc(updateBody.pendingRequestObservedAt)
                : updateBody.pendingRequestObservedAt === null
                    ? null
                    : session.pendingRequestObservedAt,
        latestReadyEventSeq:
            typeof updateBody.latestReadyEventSeq === 'number'
            && Number.isFinite(updateBody.latestReadyEventSeq)
                ? Math.trunc(updateBody.latestReadyEventSeq)
                : updateBody.latestReadyEventSeq === null
                    ? null
                    : session.latestReadyEventSeq,
        latestReadyEventAt:
            typeof updateBody.latestReadyEventAt === 'number'
            && Number.isFinite(updateBody.latestReadyEventAt)
                ? Math.trunc(updateBody.latestReadyEventAt)
                : updateBody.latestReadyEventAt === null
                    ? null
                    : session.latestReadyEventAt,
        latestTurnId:
            typeof updateBody.latestTurnId === 'string'
            && updateBody.latestTurnId.trim().length > 0
                ? updateBody.latestTurnId
                : updateBody.latestTurnId === null
                    ? null
                    : session.latestTurnId,
        latestTurnStatus:
            updateBody.latestTurnStatus === 'in_progress'
            || updateBody.latestTurnStatus === 'completed'
            || updateBody.latestTurnStatus === 'cancelled'
            || updateBody.latestTurnStatus === 'failed'
                ? updateBody.latestTurnStatus
                : updateBody.latestTurnStatus === null
                    ? null
                    : session.latestTurnStatus,
        latestTurnStatusObservedAt:
            typeof updateBody.latestTurnStatusObservedAt === 'number'
            && Number.isFinite(updateBody.latestTurnStatusObservedAt)
                ? Math.trunc(updateBody.latestTurnStatusObservedAt)
                : updateBody.latestTurnStatusObservedAt === null
                    ? null
                    : session.latestTurnStatusObservedAt,
        ...runtimeActivityPatch,
        lastRuntimeIssue:
            updateBody.lastRuntimeIssue === null
            || (updateBody.lastRuntimeIssue && typeof updateBody.lastRuntimeIssue === 'object')
                ? updateBody.lastRuntimeIssue
                : session.lastRuntimeIssue,
        rollbackEligibleTurnStarts:
            rollbackEligibleTurnStarts !== undefined
                ? rollbackEligibleTurnStarts
                : session.rollbackEligibleTurnStarts,
        archivedAt:
            typeof updateBody.archivedAt === 'number' || updateBody.archivedAt === null
                ? updateBody.archivedAt
                : session.archivedAt,
        meaningfulActivityAt:
            typeof updateBody.meaningfulActivityAt === 'number' && Number.isFinite(updateBody.meaningfulActivityAt)
                ? updateBody.meaningfulActivityAt
                : session.meaningfulActivityAt,
        updatedAt: updateCreatedAt,
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

    const nextSession: Session = {
        ...projectionSession,
        agentState,
        agentStateVersion: hydrateAgentState ? updateBody.agentState.version : session.agentStateVersion,
        metadata,
        metadataVersion: hydrateMetadata ? updateBody.metadata.version : session.metadataVersion,
    };

    return { nextSession, agentState };
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

export async function fetchAndApplyMessages(params: {
    sessionId: string;
    scope?: 'main' | 'sidechain' | 'all';
    sidechainId?: string | null;
    limit?: number;
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

    const scope = params.scope ?? 'main';
    const sidechainId = typeof params.sidechainId === 'string' && params.sidechainId.trim().length > 0 ? params.sidechainId.trim() : null;
    if (scope === 'sidechain' && sidechainId === null) {
        throw new Error('fetchMessages: sidechainId is required when scope=sidechain');
    }
    const requestPath = buildSessionMessagesPath({
        sessionId,
        scope,
        sidechainId,
        limit: params.limit,
    });

    const result = await runSessionMessagesPagePipeline({
        sessionId,
        purpose: 'initial',
        page: {
            direction: 'initial',
            requestPath,
            scope,
            sidechainId,
        },
        lifecyclePolicy: 'emit',
        getSessionEncryption: params.getSessionEncryption,
        isSessionKnown: params.isSessionKnown,
        request,
        sessionReceivedMessages,
        applyMessages,
        onTaskLifecycleEvent: params.onTaskLifecycleEvent,
        onMessagesPage: params.onMessagesPage,
        log,
        sessionEncryptionMode: params.sessionEncryptionMode,
        initialMessageDecryptBatchSize: params.initialMessageDecryptBatchSize,
        messageDecryptBatchSize: params.messageDecryptBatchSize,
        messageDecryptYieldDelayMs: params.messageDecryptYieldDelayMs,
        yieldToMessageDecryptBatch: params.yieldToMessageDecryptBatch,
    });
    if (result.skippedMissingSession) {
        return;
    }

    if (DEBUG_MESSAGE_DECRYPT) {
        const stats = result.debugDecryptStats;
        const sample = stats.sample;
        log.log(
            `[debug] fetchMessages decrypt stats for ${sessionId}: `
                + `fetched=${stats.fetched} `
                + `toDecrypt=${stats.toDecrypt} `
                + `decryptedWithContent=${stats.decryptedWithContent} `
                + `normalized=${stats.normalized}`
                + (sample ? ` sample={id:${sample.id} seq:${sample.seq} cipher:${sample.cipherPreview}}` : '')
        );
    }

    markMessagesLoaded(sessionId);
    writeSyncDebugLog(log, `💬 fetchMessages completed for session ${sessionId} - processed ${result.applied} messages`);
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

    const scope = params.scope ?? 'main';
    const sidechainId = typeof params.sidechainId === 'string' && params.sidechainId.trim().length > 0 ? params.sidechainId.trim() : null;
    if (scope === 'sidechain' && sidechainId === null) {
        throw new Error('fetchOlderMessages: sidechainId is required when scope=sidechain');
    }

    const requestPath = buildSessionMessagesPath({
        sessionId,
        scope,
        sidechainId,
        beforeSeq,
        limit,
    });
    const result = await runSessionMessagesPagePipeline({
        sessionId,
        purpose: 'older',
        page: {
            direction: 'older',
            requestPath,
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

    const scope = params.scope ?? 'main';
    const sidechainId = typeof params.sidechainId === 'string' && params.sidechainId.trim().length > 0 ? params.sidechainId.trim() : null;
    if (scope === 'sidechain' && sidechainId === null) {
        throw new Error('fetchNewerMessages: sidechainId is required when scope=sidechain');
    }

    const requestPath = buildSessionMessagesPath({
        sessionId,
        scope,
        sidechainId,
        afterSeq,
        limit,
    });
    const result = await runSessionMessagesPagePipeline({
        sessionId,
        purpose: 'newer',
        page: {
            direction: 'newer',
            requestPath,
            scope,
            sidechainId,
            afterSeq,
            limit,
        },
        lifecyclePolicy: 'emit',
        getSessionEncryption: params.getSessionEncryption,
        isSessionKnown: params.isSessionKnown,
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

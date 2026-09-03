import { V2SessionListResponseSchema, type V2SessionListResponse } from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import type { Session } from '@/sync/domains/state/storageTypes';
import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import { resolveSessionReadableSeq } from '@/sync/domains/session/readCursor/resolveSessionReadableSeq';
import { reportNewAgentRequestsFromSessionTransition } from '@/voice/context/reportNewAgentRequestsFromSessionTransition';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    buildSessionListRenderableFromSession,
    readRollbackEligibleTurnStarts,
    type SessionListRenderableMetadata,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveSessionRuntimePresenceFields } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import type { SessionListCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import { isSessionListCacheEntryMetadataUsable } from '@/sync/domains/state/warmCacheAdapters';
import {
    createSessionDataKeyHydrationPlan,
    hydrateSessionDataKeys,
    type SessionDataKeyHydrationEncryption,
} from '@/sync/encryption/sessionDataKeyHydration';
import type { EncryptionScopeInput } from '@/sync/encryption/encryption';

import { parsePlainSessionAgentState, parsePlainSessionMetadata } from './parsePlainSessionPayload';
import { fetchSessionListPageCompat } from './sessionHttpCompat';
import { resolveSessionRuntimeActivityProjectionFields } from './sessionRuntimeActivityProjection';
import {
    isSessionListRowAttentionHydrationPriority,
    normalizeSessionListHydrationSessionIds,
    orderRowsForSessionListHydration,
} from './sessionListHydrationPriority';

type SessionEncryption = {
    decryptAgentState: (version: number, value: string | null) => Promise<any>;
    decryptMetadata: (version: number, value: string) => Promise<any>;
    decryptSessionSnapshotState?: (
        metadataVersion: number,
        metadata: string,
        agentStateVersion: number,
        agentState: string | null | undefined,
    ) => Promise<{ metadata: any; agentState: any }>;
};

type SessionDataKeyEnvelopeCache = Map<string, string>;

export type SessionListEncryption = SessionDataKeyHydrationEncryption & {
    initializeSessions: (sessionKeys: Map<string, Uint8Array | null>, scope?: EncryptionScopeInput) => Promise<void>;
    removeSessionEncryption: (sessionId: string) => void;
    getSessionEncryption: (sessionId: string) => SessionEncryption | null;
};

type SessionListRow = V2SessionListResponse['sessions'][number];
type HydratedSession = Omit<Session, 'presence'> & {
    presence?: 'online' | number;
    metadataUnavailable?: boolean;
};
export type SessionListFetchResult = Readonly<{
    sessionIds: string[];
    nextCursor: string | null;
    hasNext: boolean;
    source: 'v2' | 'v1';
}>;
type HydrationApplyFlushReason = 'size' | 'timer' | 'required' | 'final' | 'manual';
type CurrentSessionListRenderableLookup = (sessionId: string) => SessionListRenderableSession | null | undefined;
type HydratedSessionApplyBatcherStats = Readonly<{
    appliedRows: number;
    staleSkippedRows: number;
}>;
type BackgroundHydrationAttribution = {
    startedRows: number;
    completedRows: number;
    enqueuedRows: number;
    failedRows: number;
    cancelledRows: number;
    staleBeforeEnqueueRows: number;
    scheduleWaitMs: number;
    maxScheduleWaitMs: number;
    rowWorkMs: number;
    yieldMs: number;
    gateWaitMs: number;
    decryptRowMs: number;
    applyEnqueueMs: number;
    finalFlushMs: number;
};
type SessionListRenderablePatch = Readonly<{
    sessionId: string;
    patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
}>;
type HydrationCandidateAttribution = Readonly<{
    rows: SessionListRow[];
    fields: Record<string, number>;
}>;

const DEFAULT_SESSION_LIST_PATH = '/v2/sessions';
const NO_SERVER_ID_ABORT_KEY = '__default__';
const DEFAULT_BACKGROUND_HYDRATION_APPLY_BATCH_SIZE = 4;
const DEFAULT_BACKGROUND_HYDRATION_APPLY_FLUSH_DELAY_MS = 64;
const activeSessionListDataKeyHydrationControllers = new WeakMap<SessionDataKeyHydrationEncryption, Map<string, AbortController>>();

function normalizeSessionListAbortKey(params: Readonly<{
    serverId?: string | null;
    sessionListPath?: string;
    sessionListCursor?: string | null;
    sessionListPageSize?: number;
    sessionListMaxPages?: number;
    includeActiveSessionRows?: boolean;
}>): string {
    const serverId = String(params.serverId ?? '').trim() || NO_SERVER_ID_ABORT_KEY;
    const sessionListPath = String(params.sessionListPath ?? '').trim() || DEFAULT_SESSION_LIST_PATH;
    return `${serverId}\u0000${sessionListPath}`;
}

function createSessionListDataKeyHydrationAbortController(params: Readonly<{
    encryption: SessionDataKeyHydrationEncryption;
    serverId?: string | null;
    sessionListPath?: string;
}>): AbortController {
    let controllers = activeSessionListDataKeyHydrationControllers.get(params.encryption);
    if (!controllers) {
        controllers = new Map();
        activeSessionListDataKeyHydrationControllers.set(params.encryption, controllers);
    }

    const key = normalizeSessionListAbortKey(params);
    controllers.get(key)?.abort();
    const controller = new AbortController();
    controllers.set(key, controller);
    return controller;
}

function buildSessionListInitialPath(params: {
    includeActiveRows: boolean;
    includeAttentionRows: boolean;
}): string | undefined {
    const query: string[] = [];
    if (params.includeActiveRows) {
        query.push('includeActive=true');
    }
    if (params.includeAttentionRows) {
        query.push('includeAttention=true');
    }
    return query.length > 0 ? `/v2/sessions?${query.join('&')}` : undefined;
}

function normalizeAccessLevel(accessLevel: unknown): 'view' | 'edit' | 'admin' | undefined {
    return accessLevel === 'view' || accessLevel === 'edit' || accessLevel === 'admin' ? accessLevel : undefined;
}

function normalizeLastViewedSessionSeq(value: number | null | undefined): number | null {
    return normalizeSessionListSeq(value);
}

function normalizeSessionListSeq(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

/**
 * Accepts `unknown` because session-list rows are a `.passthrough()` protocol
 * shape: fields the schema does not declare (see `rowRecord` below) arrive
 * typed as `unknown` and are validated here rather than at each call site.
 */
function normalizeSessionListTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function buildHydratedSessionFromDecryptedRow(
    row: SessionListRow,
    encryptionMode: 'e2ee' | 'plain',
    decryptedState: Readonly<{ metadata: any; agentState: any }>,
    serverId?: string | null,
): HydratedSession {
    const runtimeActivityProjection = resolveSessionRuntimeActivityProjectionFields({}, row);
    const latestTurnStatus = row.latestTurnStatus ?? null;
    const latestTurnStatusObservedAt = row.latestTurnStatusObservedAt ?? null;
    const runtimePresence = resolveSessionRuntimePresenceFields({
        thinking: row.thinking === true,
        thinkingAt: normalizeSessionListTimestamp(row.thinkingAt ?? null) ?? 0,
        latestTurnStatus,
        latestTurnStatusObservedAt,
    });

    return {
        ...row,
        serverId: typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : undefined,
        encryptionMode,
        thinking: runtimePresence.thinking,
        thinkingAt: runtimePresence.thinkingAt,
        metadata: decryptedState.metadata,
        agentState: decryptedState.agentState,
        metadataUnavailable: row.metadata != null && decryptedState.metadata == null,
        accessLevel: normalizeAccessLevel(row.share?.accessLevel),
        canApprovePermissions: row.share?.canApprovePermissions ?? undefined,
        latestReadyEventSeq: normalizeSessionListSeq(row.latestReadyEventSeq ?? null),
        latestReadyEventAt: normalizeSessionListTimestamp(row.latestReadyEventAt ?? null),
        pendingRequestObservedAt: normalizeSessionListTimestamp(row.pendingRequestObservedAt ?? null),
        latestTurnStatus,
        latestTurnStatusObservedAt,
        ...runtimeActivityProjection,
        rollbackEligibleTurnStarts: (row as Record<string, unknown>).rollbackEligibleTurnStarts === undefined
            ? null
            : readRollbackEligibleTurnStarts((row as Record<string, unknown>).rollbackEligibleTurnStarts),
        presence: row.active ? 'online' : row.activeAt,
    };
}

function buildPlainHydratedSessionFromRow(row: SessionListRow): HydratedSession | null {
    if (row.encryptionMode !== 'plain') return null;
    return buildHydratedSessionFromDecryptedRow(row, 'plain', {
        metadata: parsePlainSessionMetadata(row.metadata),
        agentState: parsePlainSessionAgentState(row.agentState),
    });
}

function buildRenderableFromRowAndCache(
    row: SessionListRow,
    cachedEntry: SessionListCacheEntryV1 | undefined,
    existingSession?: Session | null | undefined,
    currentRenderable?: SessionListRenderableSession | null | undefined,
): SessionListRenderableSession {
    const rowRecord = row as Record<string, unknown>;
    const metadataMatches = cachedEntry?.metadataVersion === row.metadataVersion;
    const agentStateMatches = cachedEntry?.agentStateVersion === row.agentStateVersion;
    const existingRenderable = existingSession ? buildSessionListRenderableFromSession(existingSession) : undefined;
    const existingMetadataMatches = existingSession?.metadataVersion === row.metadataVersion
        && existingRenderable?.metadata != null;
    const existingAgentStateMatches = existingSession?.agentStateVersion === row.agentStateVersion;
    const currentMetadataMatches = row.encryptionMode === 'plain'
        && currentRenderable?.metadataVersion === row.metadataVersion
        && currentRenderable.metadata != null;
    const currentAgentStateMatches = row.encryptionMode === 'plain'
        && currentRenderable?.agentStateVersion === row.agentStateVersion;
    const metadataFromCache: SessionListRenderableMetadata | null = isSessionListCacheEntryMetadataUsable(cachedEntry)
        ? {
            name: cachedEntry.name,
            summaryText: cachedEntry.summaryText ?? null,
            path: cachedEntry.path,
            homeDir: cachedEntry.homeDir ?? null,
            host: cachedEntry.host ?? null,
            machineId: cachedEntry.machineId ?? null,
            flavor: cachedEntry.flavor ?? null,
            directSessionV1: cachedEntry.directSessionV1 ?? null,
            hiddenSystemSession: cachedEntry.hiddenSystemSession === true,
        }
        : null;
    const useMatchingCacheMetadata = metadataMatches && metadataFromCache != null;
    const useExistingSessionMetadata = !useMatchingCacheMetadata && existingMetadataMatches;
    const useCurrentRenderableMetadata =
        !useMatchingCacheMetadata && !useExistingSessionMetadata && currentMetadataMatches;
    const staleCacheMetadataVersion = cachedEntry?.metadataVersion ?? row.metadataVersion;
    const plainHydratedSession = !useMatchingCacheMetadata && !useExistingSessionMetadata && !useCurrentRenderableMetadata
        ? buildPlainHydratedSessionFromRow(row)
        : null;
    const plainRenderable = plainHydratedSession?.metadata != null
        ? buildSessionListRenderableFromSession(plainHydratedSession as Session)
        : null;
    if (plainRenderable && !existingSession && !currentRenderable && metadataFromCache == null) {
        return plainRenderable;
    }
    const usePlainRenderableMetadata =
        !useMatchingCacheMetadata
        && !useExistingSessionMetadata
        && !useCurrentRenderableMetadata
        && plainRenderable?.metadata != null;
    const useStaleCacheMetadata =
        !useMatchingCacheMetadata
        && !useExistingSessionMetadata
        && !useCurrentRenderableMetadata
        && !usePlainRenderableMetadata
        && metadataFromCache != null;
    const renderableMetadata = useMatchingCacheMetadata || useStaleCacheMetadata
        ? metadataFromCache
        : useExistingSessionMetadata
            ? existingRenderable?.metadata ?? null
            : useCurrentRenderableMetadata
                ? currentRenderable?.metadata ?? null
                : usePlainRenderableMetadata
                    ? plainRenderable?.metadata ?? null
                    : null;

    const hasPendingPermissionRequests =
        typeof row.pendingPermissionRequestCount === 'number'
            ? row.pendingPermissionRequestCount > 0
            : agentStateMatches
                ? cachedEntry?.hasPendingPermissionRequests === true
                : existingAgentStateMatches
                    ? existingRenderable?.hasPendingPermissionRequests === true
                    : currentAgentStateMatches
                        ? currentRenderable?.hasPendingPermissionRequests === true
                        : plainRenderable
                            ? plainRenderable.hasPendingPermissionRequests === true
                            : undefined;
    const hasPendingUserActionRequests =
        typeof row.pendingUserActionRequestCount === 'number'
            ? row.pendingUserActionRequestCount > 0
            : agentStateMatches
                ? cachedEntry?.hasPendingUserActionRequests === true
                : existingAgentStateMatches
                    ? existingRenderable?.hasPendingUserActionRequests === true
                    : currentAgentStateMatches
                        ? currentRenderable?.hasPendingUserActionRequests === true
                        : plainRenderable
                            ? plainRenderable.hasPendingUserActionRequests === true
                            : undefined;
    const lastViewedSessionSeq = normalizeLastViewedSessionSeq(row.lastViewedSessionSeq);
    const latestReadyEventSeq =
        normalizeSessionListSeq(row.latestReadyEventSeq ?? null)
        ?? normalizeSessionListSeq(existingSession?.latestReadyEventSeq ?? null);
    const latestReadyEventAt =
        normalizeSessionListTimestamp(row.latestReadyEventAt ?? null)
        ?? normalizeSessionListTimestamp(existingSession?.latestReadyEventAt ?? null);
    const pendingRequestObservedAt =
        normalizeSessionListTimestamp(row.pendingRequestObservedAt ?? null)
        ?? normalizeSessionListTimestamp(existingRenderable?.pendingRequestObservedAt ?? null)
        ?? normalizeSessionListTimestamp(currentRenderable?.pendingRequestObservedAt ?? null)
        ?? normalizeSessionListTimestamp(plainRenderable?.pendingRequestObservedAt ?? null);
    const runtimeActivityProjection = resolveSessionRuntimeActivityProjectionFields({}, row);
    const latestTurnStatus = row.latestTurnStatus ?? null;
    const latestTurnStatusObservedAt = row.latestTurnStatusObservedAt ?? null;
    const runtimePresence = resolveSessionRuntimePresenceFields({
        thinking: typeof row.thinking === 'boolean'
            ? row.thinking
            : existingRenderable?.thinking === true,
        thinkingAt:
            normalizeSessionListTimestamp(row.thinkingAt ?? null)
            ?? normalizeSessionListTimestamp(existingRenderable?.thinkingAt ?? null)
            ?? 0,
        latestTurnStatus,
        latestTurnStatusObservedAt,
    });
    const readableSessionSeq = resolveSessionReadableSeq({
        messages: null,
        sessionSeq: row.seq,
        latestReadyEventSeq,
        latestTurnStatus: row.latestTurnStatus ?? null,
        includeTerminalSessionSeq: true,
    }) ?? 0;
    const hasUnreadMessages = computeHasUnreadActivity({
        sessionSeq: readableSessionSeq,
        pendingActivityAt: 0,
        lastViewedSessionSeq: lastViewedSessionSeq ?? undefined,
        lastViewedPendingActivityAt: undefined,
    });

    return {
        id: row.id,
        seq: row.seq,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        meaningfulActivityAt: row.meaningfulActivityAt ?? row.createdAt,
        active: row.active,
        activeAt: row.activeAt,
        archivedAt: row.archivedAt ?? null,
        pendingCount: row.pendingCount,
        pendingBlockedCount: row.pendingBlockedCount,
        pendingVersion: row.pendingVersion,
        pendingActivationAuthorization: row.pendingActivationAuthorization ?? null,
        lastViewedSessionSeq,
        metadataVersion: useStaleCacheMetadata
            ? staleCacheMetadataVersion
            : row.metadataVersion,
        agentStateVersion: row.agentStateVersion,
        metadata: renderableMetadata,
        thinking: runtimePresence.thinking,
        thinkingAt: runtimePresence.thinkingAt,
        presence: row.active ? 'online' : row.activeAt,
        latestTurnId: row.latestTurnId ?? null,
        rollbackEligibleTurnStarts: rowRecord.rollbackEligibleTurnStarts === undefined
            ? null
            : readRollbackEligibleTurnStarts(rowRecord.rollbackEligibleTurnStarts),
        accessLevel: normalizeAccessLevel(row.share?.accessLevel),
        canApprovePermissions: row.share?.canApprovePermissions ?? undefined,
        hasPendingPermissionRequests,
        hasPendingUserActionRequests,
        latestTurnStatus,
        latestTurnStatusObservedAt,
        ...runtimeActivityProjection,
        lastRuntimeIssue: row.lastRuntimeIssue ?? null,
        latestReadyEventSeq,
        latestReadyEventAt,
        pendingRequestObservedAt,
        hasUnreadMessages,
        // Warm first paint must already hold the stable ordering key. Dropping
        // it here would order this row by its (moving) activity time until
        // hydration lands and supplies the server value — the exact reorder the
        // materialized entry fact exists to remove. Server value only, same as
        // `buildSessionListRenderableFromSession`: a client stamp here would be
        // indistinguishable from a materialized one, and the renderable merge
        // owner is the single place allowed to stamp the fallback.
        unreadSince: hasUnreadMessages ? normalizeSessionListTimestamp(rowRecord.unreadSince) : null,
    };
}

function isCurrentRenderableCompleteForWarmHydration(
    row: SessionListRow,
    currentRenderable: SessionListRenderableSession | null | undefined,
): boolean {
    if (!currentRenderable) return false;
    if (currentRenderable.seq < row.seq) return false;
    if (currentRenderable.updatedAt < row.updatedAt) return false;
    if (currentRenderable.metadataVersion < row.metadataVersion) return false;
    if (currentRenderable.agentStateVersion < row.agentStateVersion) return false;
    if ((currentRenderable.archivedAt ?? null) !== (row.archivedAt ?? null)) return false;
    if ((currentRenderable.runtimeActivityState ?? null) !== (row.runtimeActivityState ?? null)) return false;
    if ((currentRenderable.runtimeActivityActiveCount ?? null) !== (row.runtimeActivityActiveCount ?? null)) return false;
    if ((currentRenderable.runtimeActivityObservedAt ?? null) !== (row.runtimeActivityObservedAt ?? null)) return false;
    if ((currentRenderable.runtimeActivityRevision ?? null) !== (row.runtimeActivityRevision ?? null)) return false;
    if (row.metadata != null && currentRenderable.metadata == null) return false;
    if (
        row.agentState != null
        && (
            typeof currentRenderable.hasPendingPermissionRequests !== 'boolean'
            || typeof currentRenderable.hasPendingUserActionRequests !== 'boolean'
        )
    ) {
        return false;
    }
    return true;
}

/**
 * Single owner of "this row's plaintext is already decrypted and current".
 *
 * Keyed on the server's `metadataVersion` / `agentStateVersion`, which are safe
 * discriminators: both session metadata writers compare-and-swap on the expected
 * version and write `expectedVersion + 1` whenever the stored ciphertext changes,
 * and the only path that leaves the version alone requires a byte-identical
 * payload (or, for `plain` sessions, deeply equal JSON). An unchanged version
 * therefore cannot conceal changed plaintext.
 *
 * Consumed both by the hydration-candidate filter and by the hydration row
 * itself, so the "already decrypted" decision has exactly one definition.
 */
function canReuseDecryptedSessionPayload(
    row: SessionListRow,
    existingSession: Session | null | undefined,
): existingSession is Session {
    if (!existingSession) return false;
    const metadataMatches = existingSession.metadataVersion === row.metadataVersion
        && (row.metadata == null || existingSession.metadata != null);
    const agentStateMatches = existingSession.agentStateVersion === row.agentStateVersion
        && (row.agentState == null || existingSession.agentState != null || row.agentStateVersion === 0);
    return metadataMatches && agentStateMatches;
}

function needsWarmHydration(params: {
    row: SessionListRow;
    existingSession?: Session | null | undefined;
    currentRenderable?: SessionListRenderableSession | null | undefined;
    isRequiredHydrationRow?: boolean;
}): boolean {
    const { row } = params;
    // A required row is always re-applied: its moving scalar projection
    // (`seq`, `updatedAt`, the runtime-activity tuple) has to reach the stored
    // session even when the encrypted payload did not change. Whether that
    // re-application costs a decrypt is a separate question, answered by
    // `canReuseDecryptedSessionPayload` at hydration time.
    if (params.isRequiredHydrationRow) return true;
    const existingSession = params.existingSession;
    if (existingSession) {
        if (canReuseDecryptedSessionPayload(row, existingSession)) {
            return false;
        }
        return true;
    }
    return !isCurrentRenderableCompleteForWarmHydration(row, params.currentRenderable);
}

function buildMissingEncryptedDataKeySessionIdSet(
    dataKeyHydrationPlan: ReturnType<typeof createSessionDataKeyHydrationPlan>,
): ReadonlySet<string> {
    const sessionIds = new Set<string>();
    for (const entry of dataKeyHydrationPlan.entries) {
        if (entry.shouldClearRuntimeEncryption && !entry.hasEnvelope) {
            sessionIds.add(entry.sessionId);
        }
    }
    return sessionIds;
}

function canHydrateSessionRow(params: {
    row: SessionListRow;
    missingEncryptedDataKeySessionIds: ReadonlySet<string>;
    encryption: SessionListEncryption;
}): boolean {
    if (!params.missingEncryptedDataKeySessionIds.has(params.row.id)) return true;
    return params.encryption.getSessionEncryption(params.row.id) != null;
}

function yieldToSessionListBackgroundHydration(delayMs: number): Promise<void> {
    const safeDelayMs = Math.max(0, Math.trunc(Number.isFinite(delayMs) ? delayMs : 0));
    return new Promise((resolve) => {
        setTimeout(resolve, safeDelayMs);
    });
}

function nowMs(): number {
    const perf = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
    if (typeof perf?.now === 'function') {
        return perf.now();
    }
    return Date.now();
}

function countRowsWithIds(rows: readonly SessionListRow[], ids: ReadonlySet<string>): number {
    if (ids.size === 0) return 0;
    let count = 0;
    for (const row of rows) {
        if (ids.has(row.id)) count += 1;
    }
    return count;
}

function countBackgroundRows(totalRows: number, requiredRows: number): number {
    return Math.max(0, totalRows - Math.max(0, requiredRows));
}

function buildHydrationCandidateAttribution(params: Readonly<{
    sessions: readonly SessionListRow[];
    requiredHydrationSessionIds: ReadonlySet<string>;
    missingEncryptedDataKeySessionIds: ReadonlySet<string>;
    encryption: SessionListEncryption;
    getExistingSession?: (sessionId: string) => Session | null | undefined;
    getCurrentSessionListRenderable?: CurrentSessionListRenderableLookup;
}>): HydrationCandidateAttribution {
    const rows: SessionListRow[] = [];
    let requiredRows = 0;
    let missingDataKeyRows = 0;
    let requiredRowsMissingDataKey = 0;
    let alreadyWarmRows = 0;
    let requiredAlreadyWarmRows = 0;
    let requiredCandidateRows = 0;

    for (const row of params.sessions) {
        const isRequiredHydrationRow = params.requiredHydrationSessionIds.has(row.id);
        if (isRequiredHydrationRow) {
            requiredRows += 1;
        }
        if (!canHydrateSessionRow({
            row,
            missingEncryptedDataKeySessionIds: params.missingEncryptedDataKeySessionIds,
            encryption: params.encryption,
        })) {
            missingDataKeyRows += 1;
            if (isRequiredHydrationRow) {
                requiredRowsMissingDataKey += 1;
            }
            continue;
        }
        if (!needsWarmHydration({
            row,
            existingSession: params.getExistingSession?.(row.id),
            currentRenderable: params.getCurrentSessionListRenderable?.(row.id),
            isRequiredHydrationRow,
        })) {
            alreadyWarmRows += 1;
            if (isRequiredHydrationRow) {
                requiredAlreadyWarmRows += 1;
            }
            continue;
        }
        rows.push(row);
        if (isRequiredHydrationRow) {
            requiredCandidateRows += 1;
        }
    }

    return {
        rows,
        fields: {
            totalRows: params.sessions.length,
            requiredIds: params.requiredHydrationSessionIds.size,
            requiredRows,
            missingRequiredRows: Math.max(0, params.requiredHydrationSessionIds.size - requiredRows),
            candidateRows: rows.length,
            requiredCandidateRows,
            backgroundCandidateRows: Math.max(0, rows.length - requiredCandidateRows),
            alreadyWarmRows,
            requiredAlreadyWarmRows,
            missingDataKeyRows,
            requiredRowsMissingDataKey,
        },
    };
}

function isDeferrableHydrationReason(reason: string | undefined): boolean {
    return reason === 'eager' || reason === 'background';
}

function createBackgroundHydrationAttribution(): BackgroundHydrationAttribution {
    return {
        startedRows: 0,
        completedRows: 0,
        enqueuedRows: 0,
        failedRows: 0,
        cancelledRows: 0,
        staleBeforeEnqueueRows: 0,
        scheduleWaitMs: 0,
        maxScheduleWaitMs: 0,
        rowWorkMs: 0,
        yieldMs: 0,
        gateWaitMs: 0,
        decryptRowMs: 0,
        applyEnqueueMs: 0,
        finalFlushMs: 0,
    };
}

function addBackgroundHydrationDuration(
    attribution: BackgroundHydrationAttribution,
    key: 'scheduleWaitMs' | 'rowWorkMs' | 'yieldMs' | 'gateWaitMs' | 'decryptRowMs' | 'applyEnqueueMs' | 'finalFlushMs',
    durationMs: number,
): void {
    const safeDurationMs = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
    attribution[key] += safeDurationMs;
    if (key === 'scheduleWaitMs') {
        attribution.maxScheduleWaitMs = Math.max(attribution.maxScheduleWaitMs, safeDurationMs);
    }
}

function recordBackgroundHydrationAttribution(params: Readonly<{
    startedAtMs: number;
    totalRows: number;
    requiredRows: number;
    backgroundRows: number;
    concurrencyLimit: number;
    yieldEveryRows: number;
    applyBatchSize: number;
    applyFlushDelayMs: number;
    attribution: BackgroundHydrationAttribution;
}>): void {
    const wallMs = Math.max(0, nowMs() - params.startedAtMs);
    const measuredWorkMs = params.attribution.yieldMs
        + params.attribution.gateWaitMs
        + params.attribution.decryptRowMs
        + params.attribution.applyEnqueueMs
        + params.attribution.finalFlushMs;
    syncPerformanceTelemetry.recordDuration('sync.sessions.snapshot.backgroundHydration.attribution', wallMs, {
        sessions: params.totalRows,
        requiredRows: params.requiredRows,
        backgroundRows: params.backgroundRows,
        concurrencyLimit: params.concurrencyLimit,
        yieldEveryRows: params.yieldEveryRows,
        applyBatchSize: params.applyBatchSize,
        applyFlushDelayMs: params.applyFlushDelayMs,
        startedRows: params.attribution.startedRows,
        completedRows: params.attribution.completedRows,
        enqueuedRows: params.attribution.enqueuedRows,
        failedRows: params.attribution.failedRows,
        cancelledRows: params.attribution.cancelledRows,
        staleBeforeEnqueueRows: params.attribution.staleBeforeEnqueueRows,
        scheduleWaitMs: params.attribution.scheduleWaitMs,
        maxScheduleWaitMs: params.attribution.maxScheduleWaitMs,
        rowWorkMs: params.attribution.rowWorkMs,
        yieldMs: params.attribution.yieldMs,
        gateWaitMs: params.attribution.gateWaitMs,
        decryptRowMs: params.attribution.decryptRowMs,
        applyEnqueueMs: params.attribution.applyEnqueueMs,
        finalFlushMs: params.attribution.finalFlushMs,
        measuredWorkMs,
        rowWorkOverheadMs: Math.max(0, params.attribution.rowWorkMs - measuredWorkMs),
        wallMs,
    });
}

function countStaleMetadataPreservedRows(
    renderables: readonly SessionListRenderableSession[],
    getCurrentSessionListRenderable: CurrentSessionListRenderableLookup | undefined,
): number {
    if (!getCurrentSessionListRenderable) return 0;
    let count = 0;
    for (const renderable of renderables) {
        if (renderable.metadata != null) continue;
        const currentRenderable = getCurrentSessionListRenderable(renderable.id);
        if (currentRenderable?.metadata != null) {
            count += 1;
        }
    }
    return count;
}

function recordFirstUsableListTelemetry(params: Readonly<{
    snapshotStartedAtMs: number;
    sessions: readonly SessionListRow[];
    renderables: readonly SessionListRenderableSession[];
    cachedSessionListEntries: Readonly<Record<string, SessionListCacheEntryV1>>;
    requiredHydrationSessionIds: ReadonlySet<string>;
    staleMetadataPreservedRows: number;
    serverIdPresent: number;
}>): void {
    const elapsedMs = Math.max(0, nowMs() - params.snapshotStartedAtMs);
    let cachedRows = 0;
    let placeholderRows = 0;
    let staleWarmCacheMetadataRows = 0;
    const rowMetadataVersionById = new Map<string, number>();
    for (const row of params.sessions) {
        rowMetadataVersionById.set(row.id, row.metadataVersion);
    }
    for (const renderable of params.renderables) {
        if (renderable.metadata == null) {
            placeholderRows += 1;
        }
        const cachedEntry = params.cachedSessionListEntries[renderable.id];
        if (
            cachedEntry?.metadataVersion === renderable.metadataVersion
            && cachedEntry.agentStateVersion === renderable.agentStateVersion
        ) {
            cachedRows += 1;
        }
        if (
            renderable.metadata != null
            && cachedEntry
            && cachedEntry.metadataVersion === renderable.metadataVersion
            && cachedEntry.metadataVersion !== rowMetadataVersionById.get(renderable.id)
        ) {
            staleWarmCacheMetadataRows += 1;
        }
    }
    const requiredRows = countRowsWithIds(params.sessions, params.requiredHydrationSessionIds);
    syncPerformanceTelemetry.recordDuration('sync.sessions.snapshot.firstUsableList', elapsedMs, {
        sessions: params.sessions.length,
        totalRows: params.sessions.length,
        renderableRows: params.renderables.length,
        cachedRows,
        placeholderRows,
        nullMetadataRows: placeholderRows,
        requiredRows,
        backgroundRows: countBackgroundRows(params.renderables.length, requiredRows),
        staleMetadataPreserved: params.staleMetadataPreservedRows + staleWarmCacheMetadataRows,
        staleWarmCacheMetadataRows,
        serverIdPresent: params.serverIdPresent,
        elapsedMs,
    });
}

function recordFullyHydratedListTelemetry(params: Readonly<{
    snapshotStartedAtMs: number;
    totalRows: number;
    renderableRows: number;
    hydrationRows: number;
    requiredRows: number;
    backgroundRows: number;
    hydratedRows: number;
    failedRows: number;
    staleSkippedRows: number;
}>): void {
    const elapsedMs = Math.max(0, nowMs() - params.snapshotStartedAtMs);
    syncPerformanceTelemetry.recordDuration('sync.sessions.snapshot.fullyHydratedList', elapsedMs, {
        sessions: params.totalRows,
        totalRows: params.totalRows,
        renderableRows: params.renderableRows,
        hydrationRows: params.hydrationRows,
        requiredRows: params.requiredRows,
        backgroundRows: params.backgroundRows,
        hydratedRows: params.hydratedRows,
        failedRows: params.failedRows,
        staleSkippedRows: params.staleSkippedRows,
        elapsedMs,
    });
}

function isHydratedSessionCurrentForListState(
    session: HydratedSession,
    getCurrentSessionListRenderable: CurrentSessionListRenderableLookup | undefined,
): boolean {
    if (!getCurrentSessionListRenderable) return true;

    const currentRenderable = getCurrentSessionListRenderable(session.id);
    if (!currentRenderable) return false;

    if (currentRenderable.seq > session.seq) return false;
    if (currentRenderable.updatedAt > session.updatedAt) return false;
    if (currentRenderable.metadataVersion > session.metadataVersion) return false;
    if (currentRenderable.agentStateVersion > session.agentStateVersion) return false;
    if ((currentRenderable.archivedAt ?? null) !== (session.archivedAt ?? null)) return false;

    return true;
}

function buildStaleHydratedSessionRenderablePatch(
    session: HydratedSession,
    currentRenderable: SessionListRenderableSession | null | undefined,
): SessionListRenderablePatch | null {
    if (!currentRenderable) return null;
    if ((currentRenderable.archivedAt ?? null) !== (session.archivedAt ?? null)) return null;

    const hydratedRenderable = buildSessionListRenderableFromSession(session as Session);
    const patch: Partial<Omit<SessionListRenderableSession, 'id'>> = {};

    const shouldPatchMetadata =
        hydratedRenderable.metadata != null
        && currentRenderable.metadataVersion <= hydratedRenderable.metadataVersion
        && (
            currentRenderable.metadata == null
            || currentRenderable.metadataVersion < hydratedRenderable.metadataVersion
        );
    if (shouldPatchMetadata) {
        patch.metadata = hydratedRenderable.metadata;
        patch.metadataVersion = hydratedRenderable.metadataVersion;
    }

    const shouldPatchPendingFlags =
        currentRenderable.agentStateVersion <= hydratedRenderable.agentStateVersion
        && (
            typeof currentRenderable.hasPendingPermissionRequests !== 'boolean'
            || typeof currentRenderable.hasPendingUserActionRequests !== 'boolean'
        );
    if (shouldPatchPendingFlags) {
        patch.agentStateVersion = hydratedRenderable.agentStateVersion;
        if (typeof hydratedRenderable.hasPendingPermissionRequests === 'boolean') {
            patch.hasPendingPermissionRequests = hydratedRenderable.hasPendingPermissionRequests;
        }
        if (typeof hydratedRenderable.hasPendingUserActionRequests === 'boolean') {
            patch.hasPendingUserActionRequests = hydratedRenderable.hasPendingUserActionRequests;
        }
    }

    if (Object.keys(patch).length === 0) return null;
    return {
        sessionId: session.id,
        patch,
    };
}

function applyStaleHydratedSessionRenderablePatches(params: Readonly<{
    sessions: readonly HydratedSession[];
    getCurrentSessionListRenderable?: CurrentSessionListRenderableLookup;
    applySessionListRenderablePatches?: (patches: readonly SessionListRenderablePatch[]) => void;
    phase: 'beforeEnqueue' | 'flush';
    batchSize: number;
    flushDelayMs: number;
}>): number {
    if (!params.getCurrentSessionListRenderable || !params.applySessionListRenderablePatches) return 0;
    const patches: SessionListRenderablePatch[] = [];
    for (const session of params.sessions) {
        const patch = buildStaleHydratedSessionRenderablePatch(
            session,
            params.getCurrentSessionListRenderable(session.id),
        );
        if (patch) {
            patches.push(patch);
        }
    }
    if (patches.length === 0) return 0;
    params.applySessionListRenderablePatches(patches);
    syncPerformanceTelemetry.count('sync.sessions.snapshot.hydrationApply.displayPatch', {
        sessions: patches.length,
        batchSize: params.batchSize,
        flushDelayMs: params.flushDelayMs,
        beforeEnqueue: params.phase === 'beforeEnqueue' ? 1 : 0,
        flush: params.phase === 'flush' ? 1 : 0,
    });
    return patches.length;
}

function buildMetadataUnavailableRenderablePatches(params: Readonly<{
    sessions: readonly HydratedSession[];
    previousRenderables: ReadonlyMap<string, SessionListRenderableSession | null | undefined>;
}>): SessionListRenderablePatch[] {
    const patches: SessionListRenderablePatch[] = [];
    for (const session of params.sessions) {
        if (session.metadataUnavailable !== true) continue;
        const previousRenderable = params.previousRenderables.get(session.id);
        if (previousRenderable?.metadata != null) {
            patches.push({
                sessionId: session.id,
                patch: {
                    metadata: previousRenderable.metadata,
                    metadataVersion: previousRenderable.metadataVersion,
                    metadataUnavailable: false,
                },
            });
            continue;
        }
        patches.push({
            sessionId: session.id,
            patch: {
                metadataUnavailable: true,
            },
        });
    }
    return patches;
}

function buildFailedHydrationUnavailableRenderablePatch(
    row: SessionListRow,
    currentRenderable: SessionListRenderableSession | null | undefined,
): SessionListRenderablePatch | null {
    if (row.metadata == null) return null;
    if (currentRenderable?.metadata != null) return null;
    if (currentRenderable?.metadataUnavailable === true) return null;

    return {
        sessionId: row.id,
        patch: {
            metadataUnavailable: true,
        },
    };
}

function stripHydratedSessionListUiState(session: HydratedSession): HydratedSession {
    if (session.metadataUnavailable !== true) return session;
    const { metadataUnavailable: _metadataUnavailable, ...sessionForStore } = session;
    return sessionForStore;
}

function reportStaleHydratedSessionsSkipped(params: Readonly<{
    sessions: number;
    phase: 'beforeEnqueue' | 'flush';
    batchSize: number;
    flushDelayMs: number;
}>): void {
    if (params.sessions <= 0) return;
    syncPerformanceTelemetry.count('sync.sessions.snapshot.hydrationApply.stale', {
        sessions: params.sessions,
        batchSize: params.batchSize,
        flushDelayMs: params.flushDelayMs,
        beforeEnqueue: params.phase === 'beforeEnqueue' ? 1 : 0,
        flush: params.phase === 'flush' ? 1 : 0,
    });
}

/**
 * Re-projects a row onto plaintext this client already decrypted, without
 * touching the crypto path.
 *
 * A row is re-hydrated whenever any of its scalars move — `seq`, `updatedAt`,
 * the runtime-activity tuple — and those move on every streaming tick. Only the
 * encrypted payload is expensive, and only `metadataVersion` /
 * `agentStateVersion` say whether it changed. Splitting the two lets a required
 * row keep publishing its fresh scalars while the unchanged envelope is decrypted
 * once instead of once per refresh.
 */
function reuseHydratedSessionForRow(
    row: SessionListRow,
    existingSession: Session | null | undefined,
    serverId?: string | null,
): HydratedSession | null {
    if (!canReuseDecryptedSessionPayload(row, existingSession)) return null;
    const encryptionMode: 'e2ee' | 'plain' = row.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const hydrated = buildHydratedSessionFromDecryptedRow(
        row,
        encryptionMode,
        { metadata: existingSession.metadata, agentState: existingSession.agentState },
        serverId,
    );
    syncPerformanceTelemetry.count('sync.sessions.snapshot.decryptRow.reusedPayload', {
        sessions: 1,
        encrypted: encryptionMode === 'plain' ? 0 : 1,
        plain: encryptionMode === 'plain' ? 1 : 0,
    });
    return hydrated;
}

async function decryptSessionRow(
    row: SessionListRow,
    encryption: SessionListEncryption,
    serverId?: string | null,
): Promise<HydratedSession | null> {
    return syncPerformanceTelemetry.measureAsync(
        'sync.sessions.snapshot.decryptRow',
        {
            encrypted: row.encryptionMode === 'plain' ? 0 : 1,
            plain: row.encryptionMode === 'plain' ? 1 : 0,
        },
        async () => {
            const encryptionMode: 'e2ee' | 'plain' = row.encryptionMode === 'plain' ? 'plain' : 'e2ee';
            const sessionEncryption = encryptionMode === 'plain' ? null : encryption.getSessionEncryption(row.id);
            if (encryptionMode === 'e2ee' && !sessionEncryption) {
                syncPerformanceTelemetry.count('sync.sessions.snapshot.decryptRow.missingSessionEncryption', {
                    sessions: 1,
                });
                return null;
            }

            try {
                const decryptedState = encryptionMode === 'plain'
                    ? {
                        metadata: parsePlainSessionMetadata(row.metadata),
                        agentState: parsePlainSessionAgentState(row.agentState),
                    }
                    : sessionEncryption!.decryptSessionSnapshotState
                        ? await sessionEncryption!.decryptSessionSnapshotState(
                            row.metadataVersion,
                            row.metadata,
                            row.agentStateVersion,
                            row.agentState,
                        )
                        : await (async () => {
                            const [metadata, agentState] = await Promise.all([
                                sessionEncryption!.decryptMetadata(row.metadataVersion, row.metadata),
                                sessionEncryption!.decryptAgentState(row.agentStateVersion, row.agentState),
                            ]);
                            return { metadata, agentState };
                        })();

                return buildHydratedSessionFromDecryptedRow(row, encryptionMode, decryptedState, serverId);
            } catch (error) {
                console.error(`[sessionsSnapshot] Failed to decrypt session ${row.id}`, error);
                return null;
            }
        },
    );
}

function applyHydratedSessions(params: {
    sessions: HydratedSession[];
    applySessions: (sessions: HydratedSession[]) => void;
    applySessionListRenderablePatches?: (patches: readonly SessionListRenderablePatch[]) => void;
    getExistingSession?: (sessionId: string) => Session | null | undefined;
    getCurrentSessionListRenderable?: CurrentSessionListRenderableLookup;
    batchSize?: number;
    flushDelayMs?: number;
}): HydratedSession[] {
    const staleSessions: HydratedSession[] = [];
    const currentSessions = params.getCurrentSessionListRenderable
        ? params.sessions.filter((session) => {
            const isCurrent = isHydratedSessionCurrentForListState(
                session,
                params.getCurrentSessionListRenderable,
            );
            if (!isCurrent) {
                staleSessions.push(session);
            }
            return isCurrent;
        })
        : params.sessions;
    if (currentSessions.length !== params.sessions.length) {
        applyStaleHydratedSessionRenderablePatches({
            sessions: staleSessions,
            getCurrentSessionListRenderable: params.getCurrentSessionListRenderable,
            applySessionListRenderablePatches: params.applySessionListRenderablePatches,
            phase: 'flush',
            batchSize: params.batchSize ?? params.sessions.length,
            flushDelayMs: params.flushDelayMs ?? 0,
        });
        reportStaleHydratedSessionsSkipped({
            sessions: params.sessions.length - currentSessions.length,
            phase: 'flush',
            batchSize: params.batchSize ?? params.sessions.length,
            flushDelayMs: params.flushDelayMs ?? 0,
        });
    }
    if (currentSessions.length === 0) return currentSessions;
    syncPerformanceTelemetry.measure(
        'sync.sessions.snapshot.applyHydrated',
        { sessions: currentSessions.length },
        () => {
            const previousSessionsById = new Map<string, Session | null | undefined>();
            const previousRenderablesById = new Map<string, SessionListRenderableSession | null | undefined>();
            for (const session of currentSessions) {
                previousSessionsById.set(session.id, params.getExistingSession?.(session.id));
                previousRenderablesById.set(session.id, params.getCurrentSessionListRenderable?.(session.id));
            }
            const sessionsForStore = currentSessions.map(stripHydratedSessionListUiState);
            params.applySessions(sessionsForStore);
            const metadataUnavailablePatches = buildMetadataUnavailableRenderablePatches({
                sessions: currentSessions,
                previousRenderables: previousRenderablesById,
            });
            if (metadataUnavailablePatches.length > 0 && params.applySessionListRenderablePatches) {
                params.applySessionListRenderablePatches(metadataUnavailablePatches);
            }
            for (const session of sessionsForStore) {
                reportNewAgentRequestsFromSessionTransition(previousSessionsById.get(session.id), session as Session);
            }
        },
    );
    return currentSessions.map(stripHydratedSessionListUiState);
}

function createHydratedSessionApplyBatcher(params: {
    applySessions: (sessions: HydratedSession[]) => void;
    applySessionListRenderablePatches?: (patches: readonly SessionListRenderablePatch[]) => void;
    getExistingSession?: (sessionId: string) => Session | null | undefined;
    getCurrentSessionListRenderable?: CurrentSessionListRenderableLookup;
    repairInvalidReadStateV1: (params: { sessionId: string; sessionSeqUpperBound: number }) => Promise<void>;
    shouldContinue: () => boolean;
    batchSize: number;
    flushDelayMs: number;
    coalesceRequiredRows?: boolean;
}): {
    enqueue: (session: HydratedSession, options?: { required?: boolean }) => void;
    flush: (reason?: HydrationApplyFlushReason) => void;
    getStats: () => HydratedSessionApplyBatcherStats;
} {
    const batchSize = Math.max(1, Math.trunc(params.batchSize));
    const flushDelayMs = Math.max(0, Math.trunc(params.flushDelayMs));
    let pending: HydratedSession[] = [];
    let pendingRequiredRows = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimerReason: HydrationApplyFlushReason | null = null;
    let firstQueuedAtMs: number | null = null;
    let appliedRows = 0;
    let staleSkippedRows = 0;

    const clearFlushTimer = (): void => {
        if (!flushTimer) return;
        clearTimeout(flushTimer);
        flushTimer = null;
        flushTimerReason = null;
    };

    const flush = (reason: HydrationApplyFlushReason = 'manual'): void => {
        clearFlushTimer();
        if (pending.length === 0) return;
        if (!params.shouldContinue()) {
            syncPerformanceTelemetry.count('sync.sessions.snapshot.hydrationApply.cancelled', {
                sessions: pending.length,
                requiredRows: pendingRequiredRows,
                backgroundRows: countBackgroundRows(pending.length, pendingRequiredRows),
                batchSize,
                flushDelayMs,
            });
            pending = [];
            pendingRequiredRows = 0;
            firstQueuedAtMs = null;
            return;
        }

        const batch = pending;
        const batchRequiredRows = pendingRequiredRows;
        const queuedAtMs = firstQueuedAtMs;
        pending = [];
        pendingRequiredRows = 0;
        firstQueuedAtMs = null;
        const queueWaitMs = queuedAtMs == null ? 0 : Math.max(0, nowMs() - queuedAtMs);
        syncPerformanceTelemetry.recordDuration('sync.sessions.snapshot.hydrationApply.queueWait', queueWaitMs, {
            sessions: batch.length,
            requiredRows: batchRequiredRows,
            backgroundRows: countBackgroundRows(batch.length, batchRequiredRows),
            batchSize,
            flushDelayMs,
            bySize: reason === 'size' ? 1 : 0,
            byTimer: reason === 'timer' ? 1 : 0,
            byRequired: reason === 'required' ? 1 : 0,
            byFinal: reason === 'final' ? 1 : 0,
            byManual: reason === 'manual' ? 1 : 0,
        });
        const appliedSessions = applyHydratedSessions({
            sessions: batch,
            applySessions: (sessions) => syncPerformanceTelemetry.measure(
                'sync.sessions.snapshot.hydrationApply.flush',
                {
                    sessions: sessions.length,
                    requiredRows: batchRequiredRows,
                    backgroundRows: countBackgroundRows(batch.length, batchRequiredRows),
                    batchSize,
                    flushDelayMs,
                    bySize: reason === 'size' ? 1 : 0,
                    byTimer: reason === 'timer' ? 1 : 0,
                    byRequired: reason === 'required' ? 1 : 0,
                    byFinal: reason === 'final' ? 1 : 0,
                    byManual: reason === 'manual' ? 1 : 0,
                },
                () => params.applySessions(sessions),
            ),
            applySessionListRenderablePatches: params.applySessionListRenderablePatches,
            getExistingSession: params.getExistingSession,
            getCurrentSessionListRenderable: params.getCurrentSessionListRenderable,
            batchSize,
            flushDelayMs,
        });
        appliedRows += appliedSessions.length;
        staleSkippedRows += batch.length - appliedSessions.length;
        if (params.shouldContinue()) {
            scheduleReadStateRepair({
                sessions: appliedSessions,
                repairInvalidReadStateV1: params.repairInvalidReadStateV1,
            });
        }
    };

    const scheduleFlush = (delayMs = flushDelayMs, reason: HydrationApplyFlushReason = 'timer'): void => {
        if (flushTimer) {
            if (reason !== 'size' || flushTimerReason === 'size') return;
            clearFlushTimer();
        }
        flushTimerReason = reason;
        flushTimer = setTimeout(() => flush(reason), delayMs);
    };

    return {
        enqueue: (session, options) => {
            if (!params.shouldContinue()) return;
            if (pending.length === 0) {
                firstQueuedAtMs = nowMs();
            }
            pending.push(session);
            const requiredRows = options?.required === true ? 1 : 0;
            pendingRequiredRows += requiredRows;
            syncPerformanceTelemetry.count('sync.sessions.snapshot.hydrationApply.enqueue', {
                sessions: 1,
                pending: pending.length,
                batchSize,
                flushDelayMs,
                required: requiredRows,
                requiredRows,
                backgroundRows: requiredRows === 1 ? 0 : 1,
            });
            if (pending.length >= batchSize) {
                if (pendingRequiredRows > 0) {
                    if (params.coalesceRequiredRows === true) {
                        scheduleFlush();
                    } else {
                        flush('size');
                    }
                    return;
                }
                scheduleFlush(flushDelayMs, 'size');
                return;
            }
            scheduleFlush();
        },
        flush,
        getStats: () => ({
            appliedRows,
            staleSkippedRows,
        }),
    };
}

function scheduleReadStateRepair(params: {
    sessions: HydratedSession[];
    repairInvalidReadStateV1: (params: { sessionId: string; sessionSeqUpperBound: number }) => Promise<void>;
}): void {
    void (async () => {
        for (const session of params.sessions) {
            try {
                const readState = session.metadata?.readStateV1;
                if (!readState) continue;
                if (readState.sessionSeq <= (session.seq ?? 0)) continue;
                await params.repairInvalidReadStateV1({ sessionId: session.id, sessionSeqUpperBound: session.seq ?? 0 });
            } catch (err) {
                console.error('[sessionsSnapshot] Failed to repair invalid readStateV1', { sessionId: session.id, err });
            }
        }
    })().catch((err) => {
        console.error('[sessionsSnapshot] Invalid readStateV1 repair loop failed', { err });
    });
}

export async function fetchAndApplySessions(params: {
    sessionListPath?: string;
    sessionListCursor?: string | null;
    sessionListPageSize?: number;
    sessionListMaxPages?: number;
    includeActiveSessionRows?: boolean;
    includeSessionListAttentionRows?: boolean;
    priorityHydrationSessionIds?: ReadonlyArray<string>;
    serverId?: string | null;
    credentials: AuthCredentials;
    encryption: SessionListEncryption;
    sessionDataKeys: Map<string, Uint8Array>;
    sessionDataKeyEnvelopes?: SessionDataKeyEnvelopeCache;
    request?: (path: string, init: RequestInit) => Promise<Response>;
    applySessions: (sessions: HydratedSession[]) => void;
    onSnapshotFetched?: (sessionIds: string[]) => void;
    applySessionListRenderables?: (sessions: SessionListRenderableSession[], options?: { replace?: boolean }) => void;
    cachedSessionListEntries?: Record<string, SessionListCacheEntryV1>;
    getCurrentSessionListRenderable?: CurrentSessionListRenderableLookup;
    applySessionListRenderablePatches?: (patches: readonly SessionListRenderablePatch[]) => void;
    prioritizeSessionIds?: ReadonlyArray<string>;
    activeSessionIds?: ReadonlyArray<string>;
    requiredHydrationSessionIds?: ReadonlyArray<string>;
    awaitSessionListHydration?: boolean;
    sessionListEagerHydrationCount?: number;
    sessionListHydrationConcurrencyLimit?: number;
    sessionListBackgroundHydrationConcurrencyLimit?: number;
    sessionListBackgroundHydrationMaxRows?: number;
    sessionListBackgroundHydrationYieldDelayMs?: number;
    sessionListBackgroundHydrationYieldEveryRows?: number;
    sessionListBackgroundHydrationGate?: () => Promise<void>;
    sessionListBackgroundHydrationApplyBatchSize?: number;
    sessionListBackgroundHydrationApplyFlushDelayMs?: number;
    sessionListBackgroundHydrationYield?: () => Promise<void>;
    getExistingSession?: (sessionId: string) => Session | null | undefined;
    shouldContinue?: () => boolean;
    repairInvalidReadStateV1: (params: { sessionId: string; sessionSeqUpperBound: number }) => Promise<void>;
    log: { log: (message: string) => void };
}): Promise<SessionListFetchResult> {
    const { credentials, encryption, sessionDataKeys, applySessions, repairInvalidReadStateV1 } = params;
    const snapshotStartedAtMs = nowMs();
    const request =
        params.request
        ?? ((path: string, init: RequestInit) => serverFetch(path, init, { includeAuth: false }));

    const sessionListPageSize = Math.max(1, Math.min(200, Math.trunc(params.sessionListPageSize ?? 50)));
    const sessionListMaxPages = Math.max(1, Math.trunc(params.sessionListMaxPages ?? 1));
    const sessions: V2SessionListResponse['sessions'] = [];
    const seenSessionIds = new Set<string>();
    const concurrencyLimit = Math.max(1, Math.trunc(params.sessionListHydrationConcurrencyLimit ?? 4));
    const backgroundHydrationConcurrencyLimit = Math.max(1, Math.trunc(params.sessionListBackgroundHydrationConcurrencyLimit ?? 1));
    const backgroundHydrationYieldEveryRows = Math.max(1, Math.trunc(params.sessionListBackgroundHydrationYieldEveryRows ?? 1));
    const backgroundHydrationApplyBatchSize = Math.max(1, Math.trunc(
        params.sessionListBackgroundHydrationApplyBatchSize ?? DEFAULT_BACKGROUND_HYDRATION_APPLY_BATCH_SIZE,
    ));
    const backgroundHydrationApplyFlushDelayMs = Math.max(0, Math.trunc(
        params.sessionListBackgroundHydrationApplyFlushDelayMs ?? DEFAULT_BACKGROUND_HYDRATION_APPLY_FLUSH_DELAY_MS,
    ));
    const backgroundHydrationYield = params.sessionListBackgroundHydrationYield
        ?? (() => yieldToSessionListBackgroundHydration(params.sessionListBackgroundHydrationYieldDelayMs ?? 0));
    const dataKeyHydrationAbortController = createSessionListDataKeyHydrationAbortController({
        encryption,
        serverId: params.serverId,
        sessionListPath: params.sessionListPath,
    });
    const rawShouldContinue = params.shouldContinue ?? (() => true);
    const shouldContinue = () => {
        if (dataKeyHydrationAbortController.signal.aborted) return false;
        const canContinue = rawShouldContinue();
        if (!canContinue) {
            dataKeyHydrationAbortController.abort();
        }
        return canContinue;
    };

    let cursor: string | null = params.sessionListCursor ?? null;
    const seenCursors = new Set<string>();
    let fetchedPages = 0;
    let nextCursorForMore: string | null = cursor;
    let hasNextForMore = false;
    let source: 'v2' | 'v1' = 'v2';
    const buildFetchResult = (): SessionListFetchResult => ({
        sessionIds: sessions.map((session) => session.id),
        nextCursor: nextCursorForMore,
        hasNext: hasNextForMore,
        source,
    });
    const appendRows = (rows: V2SessionListResponse['sessions']): void => {
        for (const row of rows) {
            if (seenSessionIds.has(row.id)) continue;
            seenSessionIds.add(row.id);
            sessions.push(row);
        }
    };

    // The initial page asks the server to merge the active-session rows into the response it already
    // builds. That removes an entire ~1 MB round trip on every foreground, and — because both
    // requests contend for the same server DB connection — the serialization edge behind it.
    const wantsInitialActiveRows = params.includeActiveSessionRows === true && !cursor && !params.sessionListPath;
    let servedActiveRowsWithInitialPage = false;
    const initialSessionListPath = !cursor && !params.sessionListPath
        ? buildSessionListInitialPath({
            includeActiveRows: wantsInitialActiveRows,
            includeAttentionRows: params.includeSessionListAttentionRows === true,
        })
        : undefined;
    while (fetchedPages < sessionListMaxPages) {
        const pageLimit = sessionListPageSize;
        const fetchPageFields = {
            loadedSessions: sessions.length,
            limit: pageLimit,
            cursorPresent: cursor ? 1 : 0,
            activePage: 0,
            listPage: 1,
        };
        const page = await syncPerformanceTelemetry.measureAsync(
            'sync.sessions.snapshot.fetchPage',
            fetchPageFields,
            async () => fetchSessionListPageCompat({
                request,
                token: credentials.token,
                sessionListPath: params.sessionListPath ?? initialSessionListPath,
                cursor,
                limit: pageLimit,
                telemetryFields: fetchPageFields,
            }),
        );

        let shouldStopAfterPage = false;
        let nextCursor: string | null = cursor;
        syncPerformanceTelemetry.measure(
            'sync.sessions.snapshot.fetchPage.process',
            {
                ...fetchPageFields,
                fetchedSessions: page.sessions.length,
                totalRows: sessions.length + page.sessions.length,
                hasNext: page.hasNext ? 1 : 0,
                nextCursorPresent: page.nextCursor ? 1 : 0,
                sourceV2: page.source === 'v2' ? 1 : 0,
                sourceV1: page.source === 'v1' ? 1 : 0,
            },
            () => {
                appendRows(page.sessions);
                source = page.source;
                if (fetchedPages === 0) {
                    servedActiveRowsWithInitialPage = page.includedActiveRows;
                }
                shouldStopAfterPage = !page.hasNext || !page.nextCursor || page.source === 'v1';
                nextCursor = page.nextCursor;
                nextCursorForMore = page.nextCursor;
                hasNextForMore = page.hasNext === true && typeof page.nextCursor === 'string' && page.source === 'v2';
            },
        );

        fetchedPages += 1;
        if (shouldStopAfterPage) break;
        if (nextCursor && seenCursors.has(nextCursor)) break;
        if (nextCursor) seenCursors.add(nextCursor);
        cursor = nextCursor;
    }

    if (wantsInitialActiveRows && !servedActiveRowsWithInitialPage) {
        const activePageFields = {
            loadedSessions: sessions.length,
            limit: 500,
            cursorPresent: 0,
            activePage: 1,
            listPage: 0,
        };
        const activePage = await syncPerformanceTelemetry.measureAsync(
            'sync.sessions.snapshot.fetchPage',
            activePageFields,
            async () => fetchSessionListPageCompat({
                request,
                token: credentials.token,
                sessionListPath: '/v2/sessions/active',
                cursor: null,
                limit: 500,
                telemetryFields: activePageFields,
            }),
        );
        // A server that does not merge the family still owes the snapshot the same rows in the same
        // order it had when this call led the sequence: active rows first, winning the de-dupe
        // against the cursor page.
        const pageRows = sessions.slice();
        sessions.length = 0;
        seenSessionIds.clear();
        appendRows(activePage.sessions);
        appendRows(pageRows);
    }

    const sessionsNeedingEncryption = sessions.filter((session) => session.encryptionMode !== 'plain');
    const sessionDataKeyEnvelopes = params.sessionDataKeyEnvelopes;
    if (!shouldContinue()) {
        return buildFetchResult();
    }
    for (const session of sessions) {
        if (session.encryptionMode === 'plain') {
            sessionDataKeys.delete(session.id);
            sessionDataKeyEnvelopes?.delete(session.id);
        }
    }

    const cachedSessionListEntries = params.cachedSessionListEntries ?? {};
    const requestedRequiredHydrationSessionIds = normalizeSessionListHydrationSessionIds(params.requiredHydrationSessionIds);
    const nonAwaitedRequiredHydrationLimit = params.sessionListBackgroundHydrationMaxRows === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.trunc(params.sessionListBackgroundHydrationMaxRows));
    const requiredHydrationSessionIds = new Set(
        params.awaitSessionListHydration === true
            ? requestedRequiredHydrationSessionIds
            : requestedRequiredHydrationSessionIds.slice(0, nonAwaitedRequiredHydrationLimit),
    );
    const shouldApplyRenderables = typeof params.applySessionListRenderables === 'function';
    let appliedRenderableCount = 0;
    const requiredSnapshotRows = countRowsWithIds(sessions, requiredHydrationSessionIds);
    const backgroundSnapshotRows = countBackgroundRows(sessions.length, requiredSnapshotRows);
    const encryptionScope: EncryptionScopeInput = typeof params.serverId === 'string' && params.serverId.trim().length > 0
        ? { serverId: params.serverId.trim() }
        : {};
    const dataKeyHydrationScope: EncryptionScopeInput = {
        ...encryptionScope,
        signal: dataKeyHydrationAbortController.signal,
        shouldContinue,
    };

    params.onSnapshotFetched?.(sessions.map((session) => session.id));
    if (shouldApplyRenderables) {
        const renderables = syncPerformanceTelemetry.measure(
            'sync.sessions.snapshot.renderableBuild',
            {
                sessions: sessions.length,
                cachedEntries: Object.keys(cachedSessionListEntries).length,
                requiredRows: requiredSnapshotRows,
                backgroundRows: backgroundSnapshotRows,
            },
            () => sessions.map((row) => buildRenderableFromRowAndCache(
                row,
                cachedSessionListEntries[row.id],
                params.getExistingSession?.(row.id),
                params.getCurrentSessionListRenderable?.(row.id),
            )),
        );
        appliedRenderableCount = renderables.length;
        const staleMetadataPreservedRows = countStaleMetadataPreservedRows(
            renderables,
            params.getCurrentSessionListRenderable,
        );
        syncPerformanceTelemetry.measure(
            'sync.sessions.snapshot.applyRenderables',
            {
                sessions: renderables.length,
                requiredRows: requiredSnapshotRows,
                backgroundRows: countBackgroundRows(renderables.length, requiredSnapshotRows),
            },
            () => params.applySessionListRenderables!(renderables, { replace: true }),
        );
        recordFirstUsableListTelemetry({
            snapshotStartedAtMs,
            sessions,
            renderables,
            cachedSessionListEntries,
            requiredHydrationSessionIds,
            staleMetadataPreservedRows,
            serverIdPresent: typeof params.serverId === 'string' && params.serverId.trim().length > 0 ? 1 : 0,
        });
    }

    const dataKeyHydrationPlan = createSessionDataKeyHydrationPlan({
        sessions,
        sessionDataKeys,
        sessionDataKeyEnvelopes,
    });
    const keyHydration = await syncPerformanceTelemetry.measureAsync(
        'sync.sessions.snapshot.decryptDataKeys',
        {
            sessions: sessions.length,
            encrypted: sessionsNeedingEncryption.length,
            plain: sessions.length - sessionsNeedingEncryption.length,
            concurrencyLimit,
            cached: dataKeyHydrationPlan.cachedDataKeyHits,
            decrypts: dataKeyHydrationPlan.dataKeyDecryptCount,
        },
        async () => hydrateSessionDataKeys({
            plan: dataKeyHydrationPlan,
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
            scope: dataKeyHydrationScope,
            shouldContinue,
        }),
    );
    if (keyHydration.stale) {
        return buildFetchResult();
    }
    const { sessionKeys, sessionEncryptionClears } = keyHydration;
    for (const sessionId of sessionEncryptionClears) {
        encryption.removeSessionEncryption(sessionId);
    }
    if (sessionKeys.size > 0) {
        await syncPerformanceTelemetry.measureAsync(
            'sync.sessions.snapshot.initializeSessions',
            { sessions: sessionKeys.size },
            async () => encryption.initializeSessions(
                sessionKeys,
                encryptionScope,
            ),
        );
    }
    const missingEncryptedDataKeySessionIds = buildMissingEncryptedDataKeySessionIdSet(dataKeyHydrationPlan);
    if (missingEncryptedDataKeySessionIds.size > 0) {
        syncPerformanceTelemetry.count('sync.sessions.snapshot.missingEncryptedDataKeys', {
            sessions: missingEncryptedDataKeySessionIds.size,
        });
    }

    if (shouldApplyRenderables) {
        const priorityHydrationSessionIds = new Set([
            ...normalizeSessionListHydrationSessionIds(params.priorityHydrationSessionIds),
        ]);
        for (const row of sessions) {
            if (isSessionListRowAttentionHydrationPriority(row)) {
                priorityHydrationSessionIds.add(row.id);
            }
        }
        const hydrationCandidates = buildHydrationCandidateAttribution({
            sessions,
            requiredHydrationSessionIds,
            missingEncryptedDataKeySessionIds,
            encryption,
            getExistingSession: params.getExistingSession,
            getCurrentSessionListRenderable: params.getCurrentSessionListRenderable,
        });
        syncPerformanceTelemetry.count(
            'sync.sessions.snapshot.hydrationCandidates',
            hydrationCandidates.fields,
        );
        const hydrationPriority = orderRowsForSessionListHydration({
            rows: hydrationCandidates.rows,
            requiredSessionIds: requiredHydrationSessionIds,
            routeSessionIds: params.prioritizeSessionIds,
            activeSessionIds: params.activeSessionIds,
            prioritySessionIds: priorityHydrationSessionIds,
            eagerHydrationCount: params.sessionListEagerHydrationCount,
            maxBackgroundHydrationRows: params.sessionListBackgroundHydrationMaxRows,
        });
        const rowsNeedingHydration = hydrationPriority.rows;
        const skippedBackgroundHydrationRows = hydrationPriority.counts.skippedBackground;
        syncPerformanceTelemetry.count(
            'sync.sessions.snapshot.hydrationPriority',
            hydrationPriority.counts,
        );
        if (rowsNeedingHydration.length === 0 && skippedBackgroundHydrationRows === 0) {
            recordFullyHydratedListTelemetry({
                snapshotStartedAtMs,
                totalRows: sessions.length,
                renderableRows: appliedRenderableCount,
                hydrationRows: 0,
                requiredRows: 0,
                backgroundRows: 0,
                hydratedRows: 0,
                failedRows: 0,
                staleSkippedRows: 0,
            });
        }
        if (rowsNeedingHydration.length > 0) {
            const requiredRowsNeedingHydration = rowsNeedingHydration.filter((row) => requiredHydrationSessionIds.has(row.id));
            const pendingRequiredHydrationIds = new Set(requiredRowsNeedingHydration.map((row) => row.id));
            const requiredHydrationResults: HydratedSession[] = [];
            let failedHydrationRows = 0;
            let staleSkippedRowsBeforeEnqueue = 0;
            let resolveRequiredHydration: (sessions: HydratedSession[]) => void = () => {};
            let rejectRequiredHydration: (error: unknown) => void = () => {};
            const requiredHydrationPromise = pendingRequiredHydrationIds.size === 0
                ? Promise.resolve(requiredHydrationResults)
                : new Promise<HydratedSession[]>((resolve, reject) => {
                    resolveRequiredHydration = resolve;
                    rejectRequiredHydration = reject;
                });
            const completeRequiredHydrationIfReady = (): void => {
                if (pendingRequiredHydrationIds.size === 0) {
                    resolveRequiredHydration(requiredHydrationResults);
                }
            };
            const markRequiredHydrationResult = (
                row: SessionListRow,
                session: HydratedSession | null,
            ): void => {
                if (!pendingRequiredHydrationIds.delete(row.id)) return;
                if (session) {
                    requiredHydrationResults.push(session);
                }
                completeRequiredHydrationIfReady();
            };
            const hydratedSessionBatcher = createHydratedSessionApplyBatcher({
                applySessions,
                applySessionListRenderablePatches: params.applySessionListRenderablePatches,
                getExistingSession: params.getExistingSession,
                getCurrentSessionListRenderable: params.getCurrentSessionListRenderable,
                repairInvalidReadStateV1,
                shouldContinue,
                batchSize: backgroundHydrationApplyBatchSize,
                flushDelayMs: backgroundHydrationApplyFlushDelayMs,
                coalesceRequiredRows: params.awaitSessionListHydration === true,
            });
            const hydrationAttribution = createBackgroundHydrationAttribution();
            const hydrationPromise = syncPerformanceTelemetry.measureAsync(
                'sync.sessions.snapshot.backgroundHydration',
                {
                    sessions: rowsNeedingHydration.length,
                    concurrencyLimit: backgroundHydrationConcurrencyLimit,
                    yieldDelayMs: params.sessionListBackgroundHydrationYieldDelayMs ?? 0,
                    yieldEveryRows: backgroundHydrationYieldEveryRows,
                    applyBatchSize: backgroundHydrationApplyBatchSize,
                    applyFlushDelayMs: backgroundHydrationApplyFlushDelayMs,
                    requiredRows: requiredRowsNeedingHydration.length,
                    backgroundRows: countBackgroundRows(rowsNeedingHydration.length, requiredRowsNeedingHydration.length),
                    ...hydrationPriority.counts,
                },
                async () => {
                    const backgroundHydrationStartedAtMs = nowMs();
                    const taskQueuedAtMs = backgroundHydrationStartedAtMs;
                    let backgroundRowsSinceLastYield = backgroundHydrationYieldEveryRows;
                    const shouldYieldBeforeBackgroundRow = (): boolean => {
                        if (backgroundRowsSinceLastYield < backgroundHydrationYieldEveryRows) return false;
                        backgroundRowsSinceLastYield = 0;
                        return true;
                    };
                    const markBackgroundRowProcessed = (): void => {
                        backgroundRowsSinceLastYield += 1;
                    };
                    const results = await runTasksWithLimit(
                        rowsNeedingHydration.map((row) => async () => {
                            const taskStartedAtMs = nowMs();
                            addBackgroundHydrationDuration(
                                hydrationAttribution,
                                'scheduleWaitMs',
                                taskStartedAtMs - taskQueuedAtMs,
                            );
                            hydrationAttribution.startedRows += 1;
                            const rowStartedAtMs = taskStartedAtMs;
                            const isRequiredHydrationRow = pendingRequiredHydrationIds.has(row.id);
                            const hydrationReason = hydrationPriority.reasonById.get(row.id);
                            const shouldGateHydrationRow = !isRequiredHydrationRow && isDeferrableHydrationReason(hydrationReason);
                            return syncPerformanceTelemetry.measureAsync(
                                'sync.sessions.snapshot.hydrationRow',
                                {
                                    rows: 1,
                                    required: isRequiredHydrationRow ? 1 : 0,
                                    requiredRows: isRequiredHydrationRow ? 1 : 0,
                                    backgroundRows: isRequiredHydrationRow ? 0 : 1,
                                },
                                async () => {
                                    try {
                                        if (!shouldContinue()) {
                                            hydrationAttribution.cancelledRows += 1;
                                            markRequiredHydrationResult(row, null);
                                            return null;
                                        }
                                        if (shouldGateHydrationRow && params.sessionListBackgroundHydrationGate) {
                                            const gateStartedAtMs = nowMs();
                                            await syncPerformanceTelemetry.measureAsync(
                                                'sync.sessions.snapshot.hydrationGate',
                                                {
                                                    rows: 1,
                                                    eagerRows: hydrationReason === 'eager' ? 1 : 0,
                                                    backgroundRows: hydrationReason === 'background' ? 1 : 0,
                                                },
                                                params.sessionListBackgroundHydrationGate,
                                            );
                                            addBackgroundHydrationDuration(
                                                hydrationAttribution,
                                                'gateWaitMs',
                                                nowMs() - gateStartedAtMs,
                                            );
                                        }
                                        if (!shouldContinue()) {
                                            hydrationAttribution.cancelledRows += 1;
                                            markRequiredHydrationResult(row, null);
                                            return null;
                                        }
                                        if (!isRequiredHydrationRow && shouldYieldBeforeBackgroundRow()) {
                                            const yieldStartedAtMs = nowMs();
                                            await syncPerformanceTelemetry.measureAsync(
                                                'sync.sessions.snapshot.hydrationYield',
                                                {
                                                    rows: 1,
                                                    requiredRows: 0,
                                                    backgroundRows: 1,
                                                },
                                                backgroundHydrationYield,
                                            );
                                            addBackgroundHydrationDuration(
                                                hydrationAttribution,
                                                'yieldMs',
                                                nowMs() - yieldStartedAtMs,
                                            );
                                        }
                                        if (!shouldContinue()) {
                                            hydrationAttribution.cancelledRows += 1;
                                            markRequiredHydrationResult(row, null);
                                            return null;
                                        }
                                        const decryptStartedAtMs = nowMs();
                                        const decryptedSession = reuseHydratedSessionForRow(
                                            row,
                                            params.getExistingSession?.(row.id),
                                            params.serverId,
                                        ) ?? await decryptSessionRow(row, encryption, params.serverId);
                                        addBackgroundHydrationDuration(
                                            hydrationAttribution,
                                            'decryptRowMs',
                                            nowMs() - decryptStartedAtMs,
                                        );
                                        if (!shouldContinue()) {
                                            hydrationAttribution.cancelledRows += 1;
                                            markRequiredHydrationResult(row, null);
                                            return null;
                                        }
                                        if (!decryptedSession) {
                                            failedHydrationRows += 1;
                                            hydrationAttribution.failedRows += 1;
                                            const unavailablePatch = buildFailedHydrationUnavailableRenderablePatch(
                                                row,
                                                params.getCurrentSessionListRenderable?.(row.id),
                                            );
                                            if (unavailablePatch && params.applySessionListRenderablePatches) {
                                                params.applySessionListRenderablePatches([unavailablePatch]);
                                            }
                                            markRequiredHydrationResult(row, null);
                                            return null;
                                        }
                                        if (!isHydratedSessionCurrentForListState(
                                            decryptedSession,
                                            params.getCurrentSessionListRenderable,
                                        )) {
                                            applyStaleHydratedSessionRenderablePatches({
                                                sessions: [decryptedSession],
                                                getCurrentSessionListRenderable: params.getCurrentSessionListRenderable,
                                                applySessionListRenderablePatches: params.applySessionListRenderablePatches,
                                                phase: 'beforeEnqueue',
                                                batchSize: backgroundHydrationApplyBatchSize,
                                                flushDelayMs: backgroundHydrationApplyFlushDelayMs,
                                            });
                                            reportStaleHydratedSessionsSkipped({
                                                sessions: 1,
                                                phase: 'beforeEnqueue',
                                                batchSize: backgroundHydrationApplyBatchSize,
                                                flushDelayMs: backgroundHydrationApplyFlushDelayMs,
                                            });
                                            staleSkippedRowsBeforeEnqueue += 1;
                                            hydrationAttribution.staleBeforeEnqueueRows += 1;
                                            markRequiredHydrationResult(row, null);
                                            return null;
                                        }
                                        const enqueueStartedAtMs = nowMs();
                                        hydratedSessionBatcher.enqueue(decryptedSession, { required: isRequiredHydrationRow });
                                        addBackgroundHydrationDuration(
                                            hydrationAttribution,
                                            'applyEnqueueMs',
                                            nowMs() - enqueueStartedAtMs,
                                        );
                                        hydrationAttribution.enqueuedRows += 1;
                                        markRequiredHydrationResult(row, decryptedSession);
                                        if (
                                            isRequiredHydrationRow
                                            && params.awaitSessionListHydration === true
                                            && pendingRequiredHydrationIds.size === 0
                                        ) {
                                            hydratedSessionBatcher.flush('required');
                                        }
                                        return decryptedSession;
                                    } catch (error) {
                                        if (pendingRequiredHydrationIds.has(row.id)) {
                                            rejectRequiredHydration(error);
                                        }
                                        throw error;
                                    } finally {
                                        if (!isRequiredHydrationRow) {
                                            markBackgroundRowProcessed();
                                        }
                                        hydrationAttribution.completedRows += 1;
                                        addBackgroundHydrationDuration(
                                            hydrationAttribution,
                                            'rowWorkMs',
                                            nowMs() - rowStartedAtMs,
                                        );
                                    }
                                },
                            );
                        }),
                        backgroundHydrationConcurrencyLimit,
                    );
                    const finalFlushStartedAtMs = nowMs();
                    if (
                        params.awaitSessionListHydration !== true
                        && backgroundHydrationApplyFlushDelayMs > 0
                    ) {
                        await yieldToSessionListBackgroundHydration(backgroundHydrationApplyFlushDelayMs);
                    }
                    hydratedSessionBatcher.flush('final');
                    addBackgroundHydrationDuration(
                        hydrationAttribution,
                        'finalFlushMs',
                        nowMs() - finalFlushStartedAtMs,
                    );
                    if (shouldContinue() && skippedBackgroundHydrationRows === 0) {
                        const batcherStats = hydratedSessionBatcher.getStats();
                        recordFullyHydratedListTelemetry({
                            snapshotStartedAtMs,
                            totalRows: sessions.length,
                            renderableRows: appliedRenderableCount,
                            hydrationRows: rowsNeedingHydration.length,
                            requiredRows: requiredRowsNeedingHydration.length,
                            backgroundRows: countBackgroundRows(rowsNeedingHydration.length, requiredRowsNeedingHydration.length),
                            hydratedRows: batcherStats.appliedRows,
                            failedRows: failedHydrationRows,
                            staleSkippedRows: staleSkippedRowsBeforeEnqueue + batcherStats.staleSkippedRows,
                        });
                    }
                    recordBackgroundHydrationAttribution({
                        startedAtMs: backgroundHydrationStartedAtMs,
                        totalRows: rowsNeedingHydration.length,
                        requiredRows: requiredRowsNeedingHydration.length,
                        backgroundRows: countBackgroundRows(rowsNeedingHydration.length, requiredRowsNeedingHydration.length),
                        concurrencyLimit: backgroundHydrationConcurrencyLimit,
                        yieldEveryRows: backgroundHydrationYieldEveryRows,
                        applyBatchSize: backgroundHydrationApplyBatchSize,
                        applyFlushDelayMs: backgroundHydrationApplyFlushDelayMs,
                        attribution: hydrationAttribution,
                    });
                    return results;
                },
            );
            const logBackgroundHydrationError = (error: unknown): void => {
                console.error('[sessionsSnapshot] Background hydration failed', error);
            };

            if (params.awaitSessionListHydration === true) {
                void hydrationPromise.catch(logBackgroundHydrationError);
                // The gate's contract is "every required row reached a terminal state", which
                // `requiredHydrationPromise` already enforces: it resolves only once
                // `pendingRequiredHydrationIds` is empty, and a genuine hydration error rejects it
                // through `rejectRequiredHydration`. A required row that decrypted to nothing or was
                // superseded by newer list state has a terminal disposition that was already applied
                // (unavailable / stale renderable patches), so the refresh completed. Treating those
                // as a failed refresh made the caller's `refreshedByCatchUp.sessions` stay false and
                // the resume tail repeat the entire session-list refresh — the second foreground
                // catch-up wave measured on device.
                await syncPerformanceTelemetry.measureAsync(
                    'sync.sessions.snapshot.requiredHydration.wait',
                    {
                        requiredRows: requiredRowsNeedingHydration.length,
                        hydrationRows: rowsNeedingHydration.length,
                    },
                    async () => requiredHydrationPromise,
                );
                if (!shouldContinue()) {
                    return buildFetchResult();
                }
            } else {
                void hydrationPromise.catch(logBackgroundHydrationError);
            }
        }

        return buildFetchResult();
    }

    const decryptedResults = await syncPerformanceTelemetry.measureAsync(
        'sync.sessions.snapshot.decryptRows',
        { sessions: sessions.length, concurrencyLimit },
        async () => runTasksWithLimit(
            sessions
                .filter((row) => canHydrateSessionRow({
                    row,
                    missingEncryptedDataKeySessionIds,
                    encryption,
                }))
                .map((row) => async () => reuseHydratedSessionForRow(
                    row,
                    params.getExistingSession?.(row.id),
                    params.serverId,
                ) ?? decryptSessionRow(row, encryption, params.serverId)),
            concurrencyLimit,
        ),
    );
    const decryptedSessions = decryptedResults.filter((session): session is NonNullable<typeof session> => Boolean(session));

    const appliedSessions = applyHydratedSessions({
        sessions: decryptedSessions,
        applySessions,
        getExistingSession: params.getExistingSession,
        getCurrentSessionListRenderable: params.getCurrentSessionListRenderable,
        batchSize: decryptedSessions.length,
        flushDelayMs: 0,
    });
    scheduleReadStateRepair({
        sessions: appliedSessions,
        repairInvalidReadStateV1,
    });

    return buildFetchResult();
}

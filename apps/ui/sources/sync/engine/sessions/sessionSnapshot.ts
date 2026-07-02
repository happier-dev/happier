import { type V2SessionListResponse } from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import type { Session } from '@/sync/domains/state/storageTypes';
import { reportNewAgentRequestsFromSessionTransition } from '@/voice/context/reportNewAgentRequestsFromSessionTransition';
import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type {
    SessionListRenderableMetadata,
    SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { preserveSessionRuntimeLocalMetadata } from '@/sync/domains/session/preserveSessionRuntimeLocalMetadata';
import {
    buildSessionListRenderableFromSession,
    resolveSessionListReadableSeq,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveSessionRuntimePresenceFields } from '@/sync/domains/session/attention/runtimePresentation';
import { readRollbackEligibleTurnStarts } from '@/sync/domains/session/rollback/rollbackEligibleTurnStarts';
import type { SessionListCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import {
    buildSessionListRenderableFromCacheEntry,
    isSessionListCacheEntryMetadataUsable,
} from '@/sync/domains/state/warmCacheAdapters';
import {
    createSessionDataKeyHydrationPlan,
    hydrateSessionDataKeys,
    type SessionDataKeyHydrationEncryption,
} from '@/sync/encryption/sessionDataKeyHydration';
import type { EncryptionScopeInput } from '@/sync/encryption/encryption';

import { parsePlainSessionAgentState, parsePlainSessionMetadata } from './parsePlainSessionPayload';
import { fetchSessionListPageCompat } from './sessionHttpCompat';
import { orderRowsForSessionListHydration } from './sessionListHydrationPriority';

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

const DEFAULT_SESSION_LIST_PATH = '/v2/sessions';
const NO_SERVER_ID_ABORT_KEY = '__default__';
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

function normalizeSessionListPinnedSessionIds(values: ReadonlyArray<string> | undefined): string[] {
    if (!values) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const value of values) {
        const id = String(value ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

function buildSessionListInitialPath(params: {
    pinnedSessionIds: readonly string[];
    includeAttentionRows: boolean;
}): string | undefined {
    const query: string[] = [];
    if (params.pinnedSessionIds.length > 0) {
        query.push(`pinnedSessionIds=${encodeURIComponent(params.pinnedSessionIds.join(','))}`);
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

function normalizeSessionListTimestamp(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function isSessionListRowAttentionHydrationPriority(row: SessionListRow): boolean {
    if ((row.pendingPermissionRequestCount ?? 0) > 0 || (row.pendingUserActionRequestCount ?? 0) > 0) {
        return true;
    }
    if (row.latestTurnStatus === 'failed' && row.lastRuntimeIssue != null) {
        return true;
    }
    const latestReadyEventSeq = normalizeSessionListSeq(row.latestReadyEventSeq);
    return latestReadyEventSeq !== null
        && latestReadyEventSeq > (normalizeSessionListSeq(row.lastViewedSessionSeq) ?? 0);
}

function buildRenderableFromRowAndCache(
    row: SessionListRow,
    cachedEntry: SessionListCacheEntryV1 | undefined,
    existingSession?: Session | null | undefined,
    currentRenderable?: SessionListRenderableSession | null | undefined,
): SessionListRenderableSession {
    const metadataMatches = cachedEntry?.metadataVersion === row.metadataVersion;
    const agentStateMatches = cachedEntry?.agentStateVersion === row.agentStateVersion;
    const existingSessionRenderable = existingSession
        ? buildSessionListRenderableFromSession(existingSession, currentRenderable ?? undefined)
        : undefined;
    const existingRenderable = currentRenderable ?? existingSessionRenderable;
    const existingMetadataMatches = existingSession?.metadataVersion === row.metadataVersion
        && existingSessionRenderable?.metadata != null;
    const existingAgentStateMatches = existingSession?.agentStateVersion === row.agentStateVersion;
    const cachedRenderableMetadata: SessionListRenderableMetadata | null = isSessionListCacheEntryMetadataUsable(cachedEntry)
        ? {
            name: cachedEntry.name,
            summaryText: cachedEntry.summaryText ?? null,
            path: cachedEntry.path,
            homeDir: cachedEntry.homeDir ?? null,
            host: cachedEntry.host ?? null,
            machineId: cachedEntry.machineId ?? null,
            flavor: cachedEntry.flavor ?? null,
            externalSessionV1: cachedEntry.externalSessionV1 ?? null,
            hiddenSystemSession: cachedEntry.hiddenSystemSession === true,
        }
        : null;
    const useMatchingCacheMetadata = metadataMatches && cachedRenderableMetadata != null;
    const useExistingSessionMetadata = !useMatchingCacheMetadata && existingMetadataMatches;
    const useStaleCacheMetadata = !useMatchingCacheMetadata && !useExistingSessionMetadata && cachedRenderableMetadata != null;
    const renderableMetadata = useMatchingCacheMetadata || useStaleCacheMetadata
        ? cachedRenderableMetadata
        : useExistingSessionMetadata
            ? existingSessionRenderable?.metadata ?? null
            : null;
    const hasPendingPermissionRequests =
        typeof row.pendingPermissionRequestCount === 'number'
            ? row.pendingPermissionRequestCount > 0
            : agentStateMatches
                ? cachedEntry?.hasPendingPermissionRequests === true
                : existingAgentStateMatches
                    ? existingRenderable?.hasPendingPermissionRequests === true
                    : undefined;
    const hasPendingUserActionRequests =
        typeof row.pendingUserActionRequestCount === 'number'
            ? row.pendingUserActionRequestCount > 0
            : agentStateMatches
                ? cachedEntry?.hasPendingUserActionRequests === true
                : existingAgentStateMatches
                    ? existingRenderable?.hasPendingUserActionRequests === true
                    : undefined;
    const lastViewedSessionSeq = normalizeLastViewedSessionSeq(row.lastViewedSessionSeq);
    const latestReadyEventSeq =
        normalizeLastViewedSessionSeq(row.latestReadyEventSeq)
        ?? existingRenderable?.latestReadyEventSeq
        ?? normalizeLastViewedSessionSeq(cachedEntry?.latestReadyEventSeq)
        ?? null;
    const latestReadyEventAt =
        normalizeSessionListTimestamp(row.latestReadyEventAt)
        ?? existingRenderable?.latestReadyEventAt
        ?? normalizeSessionListTimestamp(cachedEntry?.latestReadyEventAt)
        ?? null;
    const pendingRequestObservedAt =
        normalizeSessionListTimestamp(row.pendingRequestObservedAt)
        ?? normalizeSessionListTimestamp(existingRenderable?.pendingRequestObservedAt)
        ?? normalizeSessionListTimestamp(cachedEntry?.pendingRequestObservedAt)
        ?? null;
    const latestTurnStatus = row.latestTurnStatus ?? null;
    const latestTurnStatusObservedAt = row.latestTurnStatusObservedAt ?? null;
    const runtimePresence = resolveSessionRuntimePresenceFields({
        thinking: typeof row.thinking === 'boolean'
            ? row.thinking
            : existingRenderable?.thinking === true,
        thinkingAt:
            normalizeSessionListTimestamp(row.thinkingAt)
            ?? normalizeSessionListTimestamp(existingRenderable?.thinkingAt)
            ?? 0,
        latestTurnStatus,
        latestTurnStatusObservedAt,
    });
    const readableSeq = resolveSessionListReadableSeq({
        seq: row.seq,
        latestTurnStatus: row.latestTurnStatus ?? null,
        latestReadyEventSeq,
    }, undefined);
    const computedHasUnreadMessages = computeHasUnreadActivity({
        sessionSeq: readableSeq,
        pendingActivityAt: 0,
        lastViewedSessionSeq: lastViewedSessionSeq ?? undefined,
        lastViewedPendingActivityAt: undefined,
    });
    const hasUnreadMessages =
        computedHasUnreadMessages
        || (
            readableSeq <= 0
            && (cachedEntry?.hasUnreadMessages === true || existingRenderable?.hasUnreadMessages === true)
        );
    const rowRecord = row as Record<string, unknown>;
    const rollbackEligibleTurnStarts = Object.prototype.hasOwnProperty.call(rowRecord, 'rollbackEligibleTurnStarts')
        ? readRollbackEligibleTurnStarts(rowRecord.rollbackEligibleTurnStarts) ?? null
        : existingRenderable?.rollbackEligibleTurnStarts ?? null;

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
        pendingVersion: row.pendingVersion,
        lastViewedSessionSeq,
        metadataVersion: useStaleCacheMetadata
            ? cachedEntry?.metadataVersion ?? row.metadataVersion
            : row.metadataVersion,
        agentStateVersion: row.agentStateVersion,
        metadata: renderableMetadata,
        thinking: runtimePresence.thinking,
        thinkingAt: runtimePresence.thinkingAt,
        presence: row.active ? 'online' : row.activeAt,
        accessLevel: normalizeAccessLevel(row.share?.accessLevel),
        canApprovePermissions: row.share?.canApprovePermissions ?? undefined,
        hasPendingPermissionRequests,
        hasPendingUserActionRequests,
        latestTurnStatus,
        latestTurnStatusObservedAt,
        latestReadyEventSeq,
        latestReadyEventAt,
        lastRuntimeIssue: row.lastRuntimeIssue ?? null,
        rollbackEligibleTurnStarts,
        pendingRequestObservedAt,
        hasUnreadMessages,
    };
}

function buildRenderableFromCachedEntry(cachedEntry: SessionListCacheEntryV1): SessionListRenderableSession {
    return buildSessionListRenderableFromCacheEntry(cachedEntry);
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

function needsWarmHydration(params: {
    row: SessionListRow;
    cachedEntry: SessionListCacheEntryV1 | undefined;
    existingSession?: Session | null | undefined;
    currentRenderable?: SessionListRenderableSession | null | undefined;
    isRequiredHydrationRow?: boolean;
}): boolean {
    const { row, cachedEntry, existingSession } = params;
    if (!existingSession) {
        if (params.isRequiredHydrationRow) return true;
        return !isCurrentRenderableCompleteForWarmHydration(row, params.currentRenderable);
    }
    if (row.metadata != null && existingSession.metadata == null) return true;
    if (!cachedEntry) return true;
    if (cachedEntry.metadataVersion !== row.metadataVersion) return true;
    if (cachedEntry.agentStateVersion !== row.agentStateVersion) return true;
    return false;
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

async function decryptSessionRow(
    row: SessionListRow,
    encryption: SessionListEncryption,
    serverId?: string | null,
    cachedEntry?: SessionListCacheEntryV1,
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
                const mergedMetadata = preserveSessionRuntimeLocalMetadata(
                    cachedEntry
                        ? {
                            path: cachedEntry.path,
                            homeDir: cachedEntry.homeDir ?? undefined,
                            host: cachedEntry.host ?? undefined,
                            machineId: cachedEntry.machineId ?? undefined,
                            flavor: cachedEntry.flavor ?? undefined,
                            externalSessionV1: cachedEntry.externalSessionV1 ?? undefined,
                        }
                        : null,
                    decryptedState.metadata,
                );

                const latestTurnStatus = row.latestTurnStatus ?? null;
                const latestTurnStatusObservedAt = row.latestTurnStatusObservedAt ?? null;
                const runtimePresence = resolveSessionRuntimePresenceFields({
                    thinking: row.thinking === true,
                    thinkingAt: normalizeSessionListTimestamp(row.thinkingAt) ?? 0,
                    latestTurnStatus,
                    latestTurnStatusObservedAt,
                });

                return {
                    ...row,
                    serverId: typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : undefined,
                    encryptionMode,
                    thinking: runtimePresence.thinking,
                    thinkingAt: runtimePresence.thinkingAt,
                    metadata: mergedMetadata,
                    agentState: decryptedState.agentState,
                    metadataUnavailable: row.metadata != null && mergedMetadata == null,
                    accessLevel: normalizeAccessLevel(row.share?.accessLevel),
                    canApprovePermissions: row.share?.canApprovePermissions ?? undefined,
                    latestTurnStatus,
                    latestTurnStatusObservedAt,
                    latestReadyEventSeq: normalizeLastViewedSessionSeq(row.latestReadyEventSeq),
                    latestReadyEventAt: normalizeSessionListTimestamp(row.latestReadyEventAt),
                    rollbackEligibleTurnStarts: readRollbackEligibleTurnStarts(
                        (row as Record<string, unknown>).rollbackEligibleTurnStarts,
                    ) ?? null,
                    pendingRequestObservedAt: normalizeSessionListTimestamp(row.pendingRequestObservedAt),
                    presence: row.active ? 'online' : row.activeAt,
                };
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
    let firstQueuedAtMs: number | null = null;
    let appliedRows = 0;
    let staleSkippedRows = 0;

    const clearFlushTimer = (): void => {
        if (!flushTimer) return;
        clearTimeout(flushTimer);
        flushTimer = null;
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

    const scheduleFlush = (): void => {
        if (flushTimer) return;
        flushTimer = setTimeout(() => flush('timer'), flushDelayMs);
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
                flush('size');
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
    serverId?: string | null;
    sessionListPath?: string;
    sessionListCursor?: string | null;
    sessionListPageSize?: number;
    sessionListMaxPages?: number;
    includeActiveSessionRows?: boolean;
    includeSessionListAttentionRows?: boolean;
    sessionListPinnedSessionIds?: ReadonlyArray<string>;
    priorityHydrationSessionIds?: ReadonlyArray<string>;
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
    const { credentials, encryption, sessionDataKeys, applySessions, repairInvalidReadStateV1, log } = params;
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
    const backgroundHydrationApplyBatchSize = Math.max(1, Math.trunc(params.sessionListBackgroundHydrationApplyBatchSize ?? 1));
    const backgroundHydrationApplyFlushDelayMs = Math.max(0, Math.trunc(params.sessionListBackgroundHydrationApplyFlushDelayMs ?? 16));
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
    let usedLegacyV1Snapshot = false;

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

    const pinnedSessionIds = normalizeSessionListPinnedSessionIds(params.sessionListPinnedSessionIds);
    const initialSessionListPath = !cursor && !params.sessionListPath
        ? buildSessionListInitialPath({
            pinnedSessionIds,
            includeAttentionRows: params.includeSessionListAttentionRows === true,
        })
        : undefined;

    if (params.includeActiveSessionRows === true && !cursor && !params.sessionListPath) {
        const activePage = await fetchSessionListPageCompat({
            request,
            token: credentials.token,
            sessionListPath: '/v2/sessions/active',
            cursor: null,
            limit: 500,
            allowLegacyV1Fallback: false,
        });
        appendRows(activePage.sessions);
    }

    while (fetchedPages < sessionListMaxPages) {
        const pageLimit = sessionListPageSize;
        const fetchPageFields = {
            loadedSessions: sessions.length,
            limit: pageLimit,
            cursorPresent: cursor ? 1 : 0,
        };
        const timedRequest: typeof request = (path, init) => syncPerformanceTelemetry.measureAsync(
            'sync.sessions.snapshot.fetchPage.request',
            fetchPageFields,
            async () => request(path, init),
        );
        const page = await syncPerformanceTelemetry.measureAsync(
            'sync.sessions.snapshot.fetchPage',
            fetchPageFields,
            async () => fetchSessionListPageCompat({
                request: timedRequest,
                token: credentials.token,
                sessionListPath: params.sessionListPath ?? initialSessionListPath,
                cursor,
                limit: pageLimit,
                allowLegacyV1Fallback: (params.sessionListPath ?? initialSessionListPath) ? false : undefined,
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
                if (page.source === 'v1') {
                    usedLegacyV1Snapshot = true;
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

    const sessionsNeedingEncryption = sessions.filter((session) => session.encryptionMode !== 'plain');
    const sessionDataKeyEnvelopes = params.sessionDataKeyEnvelopes;

    const cachedSessionListEntries = params.cachedSessionListEntries ?? {};
    const fetchedSessionIds = sessions.map((session) => session.id);
    const fetchedSessionIdSet = new Set(fetchedSessionIds);
    const retainedCachedSessionIds = usedLegacyV1Snapshot
        ? Object.keys(cachedSessionListEntries).filter((sessionId) => !fetchedSessionIdSet.has(sessionId))
        : [];
    const shouldApplyRenderables = typeof params.applySessionListRenderables === 'function';
    let appliedRenderableCount = 0;
    const requiredHydrationSessionIds = new Set(
        (params.requiredHydrationSessionIds ?? [])
            .map((sessionId) => String(sessionId ?? '').trim())
            .filter(Boolean),
    );
    const requiredSnapshotRows = countRowsWithIds(sessions, requiredHydrationSessionIds);
    const backgroundSnapshotRows = countBackgroundRows(sessions.length, requiredSnapshotRows);

    params.onSnapshotFetched?.([...fetchedSessionIds, ...retainedCachedSessionIds]);
    if (shouldApplyRenderables) {
        const renderables = syncPerformanceTelemetry.measure(
            'sync.sessions.snapshot.renderableBuild',
            {
                sessions: sessions.length,
                cachedEntries: Object.keys(cachedSessionListEntries).length,
                retainedCachedSessions: retainedCachedSessionIds.length,
                requiredRows: requiredSnapshotRows,
                backgroundRows: backgroundSnapshotRows,
            },
            () => [
                ...sessions.map((row) => buildRenderableFromRowAndCache(
                    row,
                    cachedSessionListEntries[row.id],
                    params.getExistingSession?.(row.id),
                    params.getCurrentSessionListRenderable?.(row.id),
                )),
                ...retainedCachedSessionIds.map((sessionId) => buildRenderableFromCachedEntry(cachedSessionListEntries[sessionId]!)),
            ],
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

    if (!shouldContinue()) {
        return buildFetchResult();
    }

    const encryptionScope: EncryptionScopeInput = typeof params.serverId === 'string' && params.serverId.trim().length > 0
        ? { serverId: params.serverId.trim() }
        : {};
    const dataKeyHydrationScope: EncryptionScopeInput = {
        ...encryptionScope,
        signal: dataKeyHydrationAbortController.signal,
        shouldContinue,
    };
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
            async () => encryption.initializeSessions(sessionKeys, encryptionScope),
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
            ...normalizeSessionListPinnedSessionIds(params.priorityHydrationSessionIds),
            ...pinnedSessionIds,
        ]);
        for (const row of sessions) {
            if (isSessionListRowAttentionHydrationPriority(row)) {
                priorityHydrationSessionIds.add(row.id);
            }
        }
        const hydrationPriority = orderRowsForSessionListHydration({
            rows: sessions.filter((row) =>
                canHydrateSessionRow({
                    row,
                    missingEncryptedDataKeySessionIds,
                    encryption,
                })
                && needsWarmHydration({
                    row,
                    cachedEntry: cachedSessionListEntries[row.id],
                    existingSession: params.getExistingSession?.(row.id),
                    currentRenderable: params.getCurrentSessionListRenderable?.(row.id),
                    isRequiredHydrationRow: requiredHydrationSessionIds.has(row.id),
                }),
            ),
            requiredSessionIds: requiredHydrationSessionIds,
            routeSessionIds: params.prioritizeSessionIds,
            activeSessionIds: params.activeSessionIds,
            prioritySessionIds: priorityHydrationSessionIds,
            eagerHydrationCount: params.sessionListEagerHydrationCount,
            maxBackgroundHydrationRows: params.sessionListBackgroundHydrationMaxRows,
        });
        const rowsNeedingHydration = hydrationPriority.rows;
        const skippedBackgroundHydrationRows = hydrationPriority.reasonCounts.skippedBackground;
        syncPerformanceTelemetry.count(
            'sync.sessions.snapshot.hydrationPriority',
            hydrationPriority.reasonCounts,
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
            void requiredHydrationPromise.catch(() => {});
            const resolveRequiredHydrationIfReady = (): void => {
                if (pendingRequiredHydrationIds.size === 0) {
                    resolveRequiredHydration(requiredHydrationResults);
                }
            };
            const markRequiredHydrationResult = (row: SessionListRow, session: HydratedSession | null): void => {
                if (!pendingRequiredHydrationIds.delete(row.id)) return;
                if (session) {
                    requiredHydrationResults.push(session);
                }
                resolveRequiredHydrationIfReady();
            };
            const rejectPendingRequiredHydration = (error: unknown): void => {
                if (pendingRequiredHydrationIds.size === 0) return;
                pendingRequiredHydrationIds.clear();
                rejectRequiredHydration(error);
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
                    ...hydrationPriority.reasonCounts,
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
                                        const decryptedSession = await decryptSessionRow(
                                            row,
                                            encryption,
                                            params.serverId,
                                            cachedSessionListEntries[row.id],
                                        );
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
                                        if (isRequiredHydrationRow && params.awaitSessionListHydration === true) {
                                            hydratedSessionBatcher.flush('required');
                                        }
                                        addBackgroundHydrationDuration(
                                            hydrationAttribution,
                                            'applyEnqueueMs',
                                            nowMs() - enqueueStartedAtMs,
                                        );
                                        hydrationAttribution.enqueuedRows += 1;
                                        markRequiredHydrationResult(row, decryptedSession);
                                        return decryptedSession;
                                    } catch (error) {
                                        rejectPendingRequiredHydration(error);
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
            ).catch((error) => {
                rejectPendingRequiredHydration(error);
                throw error;
            });
            const logBackgroundHydrationError = (error: unknown): void => {
                console.error('[sessionsSnapshot] Background hydration failed', error);
            };

            if (params.awaitSessionListHydration === true) {
                void hydrationPromise.catch(logBackgroundHydrationError);
                const hydratedSessions = await syncPerformanceTelemetry.measureAsync(
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
                hydratedSessionBatcher.flush('required');
                if (requiredRowsNeedingHydration.length > 0) {
                    const hydratedSessionIds = new Set(
                        hydratedSessions
                            .filter((session): session is HydratedSession => Boolean(session))
                            .map((session) => session.id),
                    );
                    const missingRequiredHydration = requiredRowsNeedingHydration.find((row) => !hydratedSessionIds.has(row.id));
                    if (missingRequiredHydration) {
                        throw new Error(`Required session hydration failed for ${missingRequiredHydration.id}`);
                    }
                }
            } else {
                void hydrationPromise.catch(logBackgroundHydrationError);
            }
        }

        log.log(`📥 fetchSessions completed - rendered ${appliedRenderableCount} session list rows before selective hydration`);
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
                .map((row) => async () => decryptSessionRow(
                    row,
                    encryption,
                    params.serverId,
                    cachedSessionListEntries[row.id],
                )),
            concurrencyLimit,
        ),
    );
    const decryptedSessions = decryptedResults.filter((session): session is NonNullable<typeof session> => Boolean(session));

    if (!shouldContinue()) {
        return buildFetchResult();
    }

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

    log.log(`📥 fetchSessions completed - processed ${decryptedSessions.length} sessions`);
    return buildFetchResult();
}

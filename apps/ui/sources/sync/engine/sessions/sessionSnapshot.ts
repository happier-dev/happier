import { normalizeSessionAccessProjection, readSessionAccessRole } from './normalizeSessionAccessProjection';
import { projectComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import {
    captureSessionListRetirementFence,
    wasSessionRetiredSinceFence,
} from '@/sync/store/domains/sessions';
import { parseSessionRuntimeActivityProjectionFields } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';
import { SessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { isSessionEncryptionModeAllowedByClientRequirement, type ClientEncryptionRequirement } from '@happier-dev/protocol/encryption/clientEncryptionRequirement';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import type { V2SessionListResponse } from '@happier-dev/protocol/sessions/control/contract';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import { AccountEncryptionCurrentnessReadinessError, fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import {
    deriveSessionContentAvailability,
    isSessionContentReadable,
    type RecipientEncryptionReadiness,
    type SessionContentAvailability,
} from '@/sync/domains/session/encryptedContentAvailability';
import type { Session } from '@/sync/domains/state/storageTypes';
import { reportNewAgentRequestsFromSessionTransition } from '@/voice/context/reportNewAgentRequestsFromSessionTransition';
import { classifySessionTupleApplyCurrentness } from '@/sync/store/domains/sessionTupleApplyCurrentness';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type {
    SessionListRenderableSession,
    SessionListRenderableSource,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { preserveSessionRuntimeLocalMetadata } from '@/sync/domains/session/preserveSessionRuntimeLocalMetadata';
import {
    buildSessionListRenderableFromSession,
    preserveSessionListRenderableStaleFields,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveSessionRuntimePresenceFields } from '@/sync/domains/session/attention/runtimePresentation';
import { readRollbackEligibleTurnStarts } from '@/sync/domains/session/rollback/rollbackEligibleTurnStarts';
import type { SessionListCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import { buildSessionListRenderableFromCacheEntry } from '@/sync/domains/state/warmCacheAdapters';
import {
    createSessionDataKeyHydrationPlan,
    hydrateSessionDataKeys,
    readSessionDataKeyCredentialKind,
    type SessionDataKeyHydrationEncryption,
    type SessionDataKeyHydrationState,
} from '@/sync/encryption/sessionDataKeyHydration';
import type {
    EncryptionGenerationScope,
    EncryptionScopeInput,
    SessionEncryptionScopeInput,
} from '@/sync/encryption/encryption';

import {
    parseDecryptedSessionMetadata,
    parsePlainSessionAgentState,
    parsePlainSessionMetadata,
    readSessionMetadataLayoutVersion,
} from './parsePlainSessionPayload';
import {
    DEFAULT_SESSION_LIST_PATH,
    fetchSessionListPageCompat,
    type SessionListPageSource,
} from './sessionHttpCompat';
import { orderRowsForSessionListHydration } from './sessionListHydrationPriority';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
    buildSessionOwnerMetadataUnavailableShell,
    projectSessionLayout1LockedOwnerVisibility,
    projectSessionLayout1OwnerMetadata,
    readSessionLayout1OwnerMetadata,
    type SessionLayout1OwnerMetadataRead,
} from './readSessionLayout1OwnerProjection';

type SessionEncryption = {
    decryptAgentState: (version: number, value: string | null) => Promise<any>;
    decryptMetadata: (version: number, value: string, options?: import('@/sync/encryption/encryptor').DecryptOptions) => Promise<any>;
    decryptMetadataPayload?: (version: number, value: string, options?: import('@/sync/encryption/encryptor').DecryptOptions) => Promise<unknown | null>;
    decryptSessionSnapshotState?: (
        metadataVersion: number,
        metadata: string,
        agentStateVersion: number,
        agentState: string | null | undefined,
        options?: import('@/sync/encryption/encryptor').DecryptOptions,
    ) => Promise<{ metadata: any; agentState: any }>;
};

type SessionDataKeyEnvelopeCache = Map<string, string>;

export type SessionListEncryption = SessionDataKeyHydrationEncryption & {
    initializeSessions: (
        sessionKeys: Map<string, Uint8Array | null>,
        scope?: SessionEncryptionScopeInput,
    ) => Promise<EncryptionGenerationScope | null | void>;
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
    /** In-process admission only: retirement may commit after this promise resolves. */
    isSessionCurrent?: (sessionId: string) => boolean;
    nextCursor: string | null;
    hasNext: boolean;
    attentionNextCursor: string | null;
    attentionHasNext: boolean;
    current: boolean;
    source: 'v2' | 'v1';
    accountCurrentness?: AccountEncryptionCurrentnessResponse;
    /**
     * Historical rows the Home selected for this read but withheld from this viewer
     * until their owner migrates the Session metadata (released layout 0). Non-zero
     * means the pages were read to the end yet the corpus is not whole.
     */
    metadataUpgradeRequiredCount?: number;
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

// Bound one cold-sync pump so a malformed or moving server cursor cannot make a
// single fetch open-ended. The owning runtime retains and resumes the returned
// attention cursor; this is a work bound, never a corpus-completeness limit.
const DEFAULT_SESSION_LIST_ATTENTION_CONTINUATION_MAX_PAGES = 100;

function readSessionListRowAgentStateVersion(row: SessionListRow): number {
    return row.agentStateVersion ?? 0;
}

function normalizeSessionListHydrationSessionIds(values: ReadonlyArray<string> | undefined): string[] {
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
    includeAttentionRows: boolean;
}): string | undefined {
    const query: string[] = [];
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

function readCompleteRuntimeActivityProjection(
    value: unknown,
): Partial<Pick<
    SessionListRenderableSession,
    'runtimeActivityState'
    | 'runtimeActivityActiveCount'
    | 'runtimeActivityObservedAt'
    | 'runtimeActivityRevision'
>> {
    const parsed = parseSessionRuntimeActivityProjectionFields(value);
    if (parsed.kind !== 'valid') return {};
    return {
        runtimeActivityState: parsed.projection.state,
        runtimeActivityActiveCount: parsed.projection.activeCount,
        runtimeActivityObservedAt: parsed.projection.observedAt,
        runtimeActivityRevision: parsed.projection.revision,
    };
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

function buildHydratedSessionFromRowState(params: {
    row: SessionListRow;
    encryptionMode: 'e2ee' | 'plain';
    metadata: any;
    agentState: any;
    ownerMetadataView?: Session['ownerMetadataView'];
    composerOptionsInput?: Session['composerOptionsInput'];
    cachedEntry?: SessionListCacheEntryV1;
    serverId?: string | null;
    encryptedContentAvailability?: SessionContentAvailability;
}): HydratedSession {
    const { row, cachedEntry } = params;
    const {
        ownerMetadata: _ownerMetadataEnvelope,
        // This title is produced only by the in-process Session store after an authorized read.
        // The HTTP schema preserves additive fields, but a plaintext wire value is not provenance.
        lockedDisplayTitle: _wireLockedDisplayTitle,
        ...sessionRow
    } = row;
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(row.metadataLayoutVersion);
    const mergedMetadata = metadataLayoutVersion === 1
        ? params.metadata
        : preserveSessionRuntimeLocalMetadata(
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
            params.metadata,
        );

    const access = normalizeSessionAccessProjection(row, { allowLegacy: true });
    const latestTurnStatus = row.latestTurnStatus;
    const latestTurnStatusObservedAt = row.latestTurnStatusObservedAt;
    const runtimePresence = resolveSessionRuntimePresenceFields({
        thinking: row.thinking === true,
        thinkingAt: normalizeSessionListTimestamp(row.thinkingAt) ?? 0,
        ...(latestTurnStatus !== undefined ? { latestTurnStatus } : {}),
        ...(latestTurnStatusObservedAt !== undefined ? { latestTurnStatusObservedAt } : {}),
    });

    return {
        ...sessionRow,
        serverId: typeof params.serverId === 'string' && params.serverId.trim().length > 0
            ? params.serverId.trim()
            : undefined,
        encryptionMode: params.encryptionMode,
        encryptedContentAvailability: params.encryptedContentAvailability
            ?? (params.encryptionMode === 'plain' ? 'ready' : undefined),
        ...(metadataLayoutVersion > 0 ? { metadataLayoutVersion } : {}),
        thinking: runtimePresence.thinking,
        thinkingAt: runtimePresence.thinkingAt,
        metadata: mergedMetadata,
        metadataProjection: undefined,
        ownerMetadataView: metadataLayoutVersion === 0 ? undefined : params.ownerMetadataView ?? null,
        composerOptionsInput: params.composerOptionsInput ?? (metadataLayoutVersion === 0 && mergedMetadata
            ? projectComposerOptionsInputV1(mergedMetadata) : null),
        agentState: params.agentState,
        agentStateVersion: readSessionListRowAgentStateVersion(row),
        metadataUnavailable: row.metadata != null && mergedMetadata == null,
        access,
        ...('responsibleAccountId' in row ? { responsibleAccountId: row.responsibleAccountId } : {}),
        ...('responsibleAccount' in row ? { responsibleAccount: (row as { responsibleAccount?: unknown }).responsibleAccount as never } : {}),
        accessLevel: normalizeAccessLevel(access?.level),
        canApprovePermissions: access?.capabilities.approveRuntimePermissions,
        ...(latestTurnStatus !== undefined ? { latestTurnStatus } : {}),
        ...(latestTurnStatusObservedAt !== undefined ? { latestTurnStatusObservedAt } : {}),
        ...readCompleteRuntimeActivityProjection(row),
        latestReadyEventSeq: normalizeLastViewedSessionSeq(row.latestReadyEventSeq),
        latestReadyEventAt: normalizeSessionListTimestamp(row.latestReadyEventAt),
        rollbackEligibleTurnStarts: readRollbackEligibleTurnStarts(
            (row as Record<string, unknown>).rollbackEligibleTurnStarts,
        ) ?? null,
        pendingRequestObservedAt: normalizeSessionListTimestamp(row.pendingRequestObservedAt),
    };
}

function readSessionListRowOwnerMetadata(params: Readonly<{
    row: SessionListRow;
    credentials: AuthCredentials;
    accountCurrentness: AccountEncryptionCurrentnessResponse | undefined;
}>): SessionLayout1OwnerMetadataRead | null {
    if (readSessionMetadataLayoutVersion(params.row.metadataLayoutVersion) !== 1) {
        return null;
    }
    return readSessionLayout1OwnerMetadata({
        access: normalizeSessionAccessProjection(params.row, { allowLegacy: true }),
        accountMode: params.accountCurrentness?.mode,
        ownerMetadataEnvelope: params.row.ownerMetadata,
        credentials: params.credentials,
    });
}

function buildLockedHydratedSessionFromRow(
    row: SessionListRow,
    encryptionMode: 'e2ee' | 'plain',
    cachedEntry?: SessionListCacheEntryV1,
    serverId?: string | null,
    encryptedContentAvailability?: SessionContentAvailability,
    ownerMetadataView?: Session['ownerMetadataView'],
): HydratedSession {
    return buildHydratedSessionFromRowState({
        row,
        encryptionMode,
        metadata: null,
        ownerMetadataView: ownerMetadataView ?? null,
        agentState: null,
        cachedEntry,
        serverId,
        encryptedContentAvailability,
    });
}

function buildPlainHydratedSessionFromRow(
    row: SessionListRow,
    credentials: AuthCredentials,
    accountCurrentness: AccountEncryptionCurrentnessResponse | undefined,
    cachedEntry?: SessionListCacheEntryV1,
    serverId?: string | null,
): HydratedSession {
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(row.metadataLayoutVersion);
    const metadata = parsePlainSessionMetadata(row.metadata, row.metadataLayoutVersion);
    const sharedMetadata = metadataLayoutVersion === 1
        ? SessionSharedMetadataV1Schema.safeParse(metadata)
        : null;
    const ownerMetadataRead = readSessionListRowOwnerMetadata({
        row,
        credentials,
        accountCurrentness,
    });
    const ownerProjection = sharedMetadata?.success && ownerMetadataRead
        ? projectSessionLayout1OwnerMetadata({
            sharedMetadata: sharedMetadata.data,
            ownerMetadataRead,
        })
        : null;
    const isOwner = ownerProjection?.kind === 'owner';
    const readableMetadata = ownerProjection?.kind === 'unavailable'
        ? null
        : metadata;
    const hydratedSession = buildHydratedSessionFromRowState({
        row,
        encryptionMode: 'plain',
        metadata: readableMetadata,
        ownerMetadataView: isOwner ? ownerProjection.ownerMetadataView : null,
        composerOptionsInput: isOwner ? ownerProjection.composerOptionsInput : null,
        agentState: row.agentState == null
            ? null
            : metadataLayoutVersion === 1
                ? isOwner
                    ? parsePlainSessionAgentState(row.agentState)
                    : null
                : parsePlainSessionAgentState(row.agentState),
        cachedEntry,
        serverId,
    });
    return ownerProjection?.kind === 'unavailable'
        ? buildSessionOwnerMetadataUnavailableShell(hydratedSession)
        : hydratedSession;
}

function buildRenderableFromRowAndCache(
    row: SessionListRow,
    credentials: AuthCredentials,
    accountCurrentness: AccountEncryptionCurrentnessResponse | undefined,
    cachedEntry: SessionListCacheEntryV1 | undefined,
    existingSession?: Session | null | undefined,
    currentRenderable?: SessionListRenderableSession | null | undefined,
): SessionListRenderableSession {
    const rowMetadataLayoutVersion = readSessionMetadataLayoutVersion(row.metadataLayoutVersion);
    const existingSessionRenderable = existingSession
        ? buildSessionListRenderableFromSession(existingSession, currentRenderable ?? undefined)
        : undefined;
    const existingRenderable = currentRenderable ?? existingSessionRenderable;
    const cachedRenderable = cachedEntry ? buildRenderableFromCachedEntry(cachedEntry) : undefined;
    // This refresh opens no Session key, so it cannot decide what the viewer can read: the hydrated
    // Session owns that fact, else the row already applied, else the settled fact persisted with the
    // warm-cache row. Left unset, the row reads as unsettled (never readable, never blocked).
    const knownContentAvailability = existingSession?.encryptedContentAvailability
        ?? currentRenderable?.encryptedContentAvailability
        ?? cachedRenderable?.encryptedContentAvailability
        ?? undefined;
    const ownerMetadataRead = readSessionListRowOwnerMetadata({
        row,
        credentials,
        accountCurrentness,
    });
    if (ownerMetadataRead?.kind === 'unavailable') {
        const lockedSession = buildSessionOwnerMetadataUnavailableShell(buildLockedHydratedSessionFromRow(
            row,
            row.encryptionMode === 'plain' ? 'plain' : 'e2ee',
            cachedEntry,
            undefined,
            knownContentAvailability,
        ));
        return preserveSessionListRenderableStaleFields(
            existingRenderable ?? cachedRenderable,
            buildSessionListRenderableFromSession(
                lockedSession,
                existingRenderable ?? undefined,
            ),
        );
    }
    if (row.encryptionMode === 'plain') {
        const hydratedSession = buildPlainHydratedSessionFromRow(
            row,
            credentials,
            accountCurrentness,
            cachedEntry,
        );
        const renderable = preserveSessionListRenderableStaleFields(
            existingRenderable ?? cachedRenderable,
            buildSessionListRenderableFromSession(hydratedSession as Session, existingRenderable ?? undefined),
        );
        return hydratedSession.metadataUnavailable === true && renderable.metadata == null
            ? { ...renderable, metadataUnavailable: true }
            : renderable;
    }
    // E2EE: no key opens here, so the row goes through the one projector as a Session whose
    // projection is undecided. The projection this device already holds for the row's revision is
    // the previous row the projector keeps: the matching warm-cache row, else the hydrated Session's,
    // else a same-layout warm-cache row from an older revision (its own, truthful revision is kept,
    // so warm hydration re-reads it). With none, the row carries no projection and the store's
    // apply keeps the applied row's (`preserveSessionListRenderableStaleFields`), as before.
    const cachedProjectionUsable = cachedRenderable?.metadata != null
        && readSessionMetadataLayoutVersion(cachedEntry?.metadataLayoutVersion) === rowMetadataLayoutVersion;
    const existingSessionProjectionMatches = existingSessionRenderable?.metadata != null
        && readSessionMetadataLayoutVersion(existingSession?.metadataLayoutVersion) === rowMetadataLayoutVersion
        && existingSession?.metadataVersion === row.metadataVersion;
    const projectionSource = cachedProjectionUsable && cachedEntry?.metadataVersion === row.metadataVersion
        ? cachedRenderable
        : existingSessionProjectionMatches
            ? existingSessionRenderable
            : cachedProjectionUsable
                ? cachedRenderable
                : undefined;
    const undecidedSession: SessionListRenderableSource = {
        ...buildHydratedSessionFromRowState({
            row,
            encryptionMode: 'e2ee',
            metadata: null,
            agentState: null,
            encryptedContentAvailability: knownContentAvailability,
        }) as Session,
        // The Home-qualified applied row may retain the store's safe title even with no metadata.
        // Carry only that memory projection; buildHydratedSessionFromRowState stripped wire input.
        lockedDisplayTitle: currentRenderable?.lockedDisplayTitle,
        metadataUndecided: true,
    };
    return buildSessionListRenderableFromSession(undecidedSession, projectionSource ?? undefined);
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
    if (!classifySessionTupleApplyCurrentness({
        metadataLayoutVersion: row.metadataLayoutVersion,
        metadataVersion: row.metadataVersion,
        agentStateVersion: readSessionListRowAgentStateVersion(row),
    }, currentRenderable).fullyCurrent) return false;
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
    isAttentionHydrationRow?: boolean;
}): boolean {
    const { row, cachedEntry, existingSession } = params;
    if (params.isRequiredHydrationRow) return true;
    if (!existingSession) {
        if (params.isAttentionHydrationRow) return true;
        return !isCurrentRenderableCompleteForWarmHydration(row, params.currentRenderable);
    }
    if (row.metadata != null && existingSession.metadata == null) return true;
    if (!cachedEntry) return true;
    if (
        readSessionMetadataLayoutVersion(cachedEntry.metadataLayoutVersion)
            !== readSessionMetadataLayoutVersion(row.metadataLayoutVersion)
    ) return true;
    if (cachedEntry.metadataVersion !== row.metadataVersion) return true;
    if (cachedEntry.agentStateVersion !== readSessionListRowAgentStateVersion(row)) return true;
    return false;
}

/**
 * Rows for which no reader exists and none can be established, so attempting content hydration
 * would only produce noise. An `unopenable_envelope` row deliberately stays out of this set: it
 * still flows through hydration so it settles as unavailable instead of waiting silently.
 */
function buildMissingEncryptedDataKeySessionIdSet(
    hydrationStates: ReadonlyMap<string, SessionDataKeyHydrationState>,
): ReadonlySet<string> {
    const sessionIds = new Set<string>();
    for (const [sessionId, state] of hydrationStates) {
        if (state === 'missing_envelope') {
            sessionIds.add(sessionId);
        }
    }
    return sessionIds;
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
    if (!classifySessionTupleApplyCurrentness(currentRenderable, session).fullyCurrent) return false;
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
    const tupleCurrentness = classifySessionTupleApplyCurrentness(currentRenderable, hydratedRenderable);
    const metadataRevisionAdvances = tupleCurrentness.metadataCurrent
        && !classifySessionTupleApplyCurrentness(hydratedRenderable, currentRenderable).metadataCurrent;

    const shouldPatchMetadata =
        hydratedRenderable.metadata != null
        && tupleCurrentness.metadataCurrent
        && (
            currentRenderable.metadata == null
            || metadataRevisionAdvances
        );
    if (shouldPatchMetadata) {
        patch.metadata = hydratedRenderable.metadata;
        patch.metadataLayoutVersion = hydratedRenderable.metadataLayoutVersion;
        patch.metadataVersion = hydratedRenderable.metadataVersion;
        // The projector's availability travels with the metadata it produced; a row that failed an
        // earlier hydration must not keep `metadataUnavailable` beside readable metadata.
        patch.metadataUnavailable = hydratedRenderable.metadataUnavailable;
    }

    const shouldPatchPendingFlags =
        tupleCurrentness.agentStateCurrent
        && (
            hydratedRenderable.agentStateVersion > currentRenderable.agentStateVersion
            ||
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
        if (
            readSessionMetadataLayoutVersion(session.metadataLayoutVersion) !== 1
            && previousRenderable?.metadata != null
        ) {
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
                ...(readSessionMetadataLayoutVersion(session.metadataLayoutVersion) === 1
                    ? {
                        metadata: null,
                        metadataLayoutVersion: session.metadataLayoutVersion,
                        metadataVersion: session.metadataVersion,
                    }
                    : {}),
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
    credentials: AuthCredentials,
    accountCurrentness: AccountEncryptionCurrentnessResponse | undefined,
    encryption: SessionListEncryption | null,
    serverId?: string | null,
    cachedEntry?: SessionListCacheEntryV1,
    hydrationState: SessionDataKeyHydrationState = 'missing_envelope',
    recipientReadiness?: RecipientEncryptionReadiness,
): Promise<HydratedSession | null> {
    return syncPerformanceTelemetry.measureAsync(
        'sync.sessions.snapshot.decryptRow',
        {
            encrypted: row.encryptionMode === 'plain' ? 0 : 1,
            plain: row.encryptionMode === 'plain' ? 1 : 0,
        },
        async () => {
            const encryptionMode: 'e2ee' | 'plain' = row.encryptionMode === 'plain' ? 'plain' : 'e2ee';
            const contentAvailability = deriveSessionContentAvailability({
                hydrationState,
                recipientReadiness,
            });
            // The Session DEK and the owner-metadata envelope have different custody. An owner can
            // still open the latter to classify a hidden system Session while shared content is
            // locked; recipients never receive or open this envelope.
            const ownerMetadataRead = readSessionListRowOwnerMetadata({
                row,
                credentials,
                accountCurrentness,
            });
            const lockedOwnerVisibility = projectSessionLayout1LockedOwnerVisibility(
                ownerMetadataRead,
            );
            if (!isSessionContentReadable(contentAvailability)) {
                return buildLockedHydratedSessionFromRow(
                    row,
                    encryptionMode,
                    cachedEntry,
                    serverId,
                    contentAvailability,
                    lockedOwnerVisibility,
                );
            }
            const sessionEncryption = encryptionMode === 'plain' ? null : encryption?.getSessionEncryption(row.id);
            if (encryptionMode === 'e2ee' && !sessionEncryption) {
                syncPerformanceTelemetry.count('sync.sessions.snapshot.decryptRow.missingSessionEncryption', {
                    sessions: 1,
                });
                return null;
            }

            try {
                const metadataLayoutVersion = readSessionMetadataLayoutVersion(
                    row.metadataLayoutVersion,
                );
                // The owner view will not open: install a locked shell that scrubs any private
                // metadata a previous Account state left behind, and carries the content fact this
                // hydration just settled (the Session DEK opened), never an unset one.
                if (ownerMetadataRead?.kind === 'unavailable') {
                    return buildSessionOwnerMetadataUnavailableShell(buildLockedHydratedSessionFromRow(
                        row,
                        encryptionMode,
                        cachedEntry,
                        serverId,
                        contentAvailability,
                    ));
                }
                let metadataAuthenticationFailed = false;
                const metadataDecryptOptions = { onAuthenticationFailure: () => { metadataAuthenticationFailed = true; } };
                const decryptedState = encryptionMode === 'plain'
                    ? {
                        metadata: parsePlainSessionMetadata(
                            row.metadata,
                            row.metadataLayoutVersion,
                        ),
                        agentState: row.agentState == null
                            ? null
                            : metadataLayoutVersion === 1
                                ? ownerMetadataRead?.kind === 'owner'
                                    ? parsePlainSessionAgentState(row.agentState)
                                    : null
                                : parsePlainSessionAgentState(row.agentState),
                    }
                    : metadataLayoutVersion === 1
                        ? await (async () => {
                            const [metadata, agentState] = await Promise.all([
                                sessionEncryption!.decryptMetadataPayload?.(
                                    row.metadataVersion,
                                    row.metadata,
                                    metadataDecryptOptions,
                                ) ?? Promise.resolve(null),
                                ownerMetadataRead?.kind === 'owner'
                                    ? sessionEncryption!.decryptAgentState(
                                        row.agentStateVersion ?? 0,
                                        row.agentState ?? null,
                                    )
                                    : Promise.resolve(null),
                            ]);
                            return { metadata, agentState };
                        })()
                    : sessionEncryption!.decryptSessionSnapshotState
                        ? await sessionEncryption!.decryptSessionSnapshotState(
                            row.metadataVersion,
                            row.metadata,
                            row.agentStateVersion ?? 0,
                            row.agentState ?? null,
                            metadataDecryptOptions,
                        )
                        : await (async () => {
                            const [metadata, agentState] = await Promise.all([
                                sessionEncryption!.decryptMetadata(row.metadataVersion, row.metadata, metadataDecryptOptions),
                                sessionEncryption!.decryptAgentState(
                                    row.agentStateVersion ?? 0,
                                    row.agentState ?? null,
                                ),
                            ]);
                            return { metadata, agentState };
                        })();
                if (encryptionMode === 'e2ee' && metadataAuthenticationFailed) {
                    return buildLockedHydratedSessionFromRow(row, encryptionMode, cachedEntry, serverId,
                        deriveSessionContentAvailability({ hydrationState, contentAuthenticationFailed: true }),
                        lockedOwnerVisibility);
                }
                const metadata = encryptionMode === 'plain'
                    ? decryptedState.metadata
                    : parseDecryptedSessionMetadata(
                        decryptedState.metadata,
                        row.metadataLayoutVersion,
                    );
                const sharedMetadata = metadataLayoutVersion === 1
                    ? SessionSharedMetadataV1Schema.safeParse(metadata)
                    : null;
                const ownerProjection = sharedMetadata?.success
                    ? projectSessionLayout1OwnerMetadata({
                        sharedMetadata: sharedMetadata.data,
                        ownerMetadataRead: ownerMetadataRead!,
                    })
                    : null;
                if (ownerProjection?.kind === 'unavailable') {
                    return buildSessionOwnerMetadataUnavailableShell(buildLockedHydratedSessionFromRow(
                        row, encryptionMode, cachedEntry, serverId, contentAvailability,
                    ));
                }
                if (metadataLayoutVersion === 1 && !sharedMetadata?.success) {
                    return null;
                }
                const agentState = decryptedState.agentState;
                return buildHydratedSessionFromRowState({
                    row,
                    serverId,
                    encryptionMode,
                    metadata,
                    ownerMetadataView: ownerProjection?.kind === 'owner'
                        ? ownerProjection.ownerMetadataView
                        : null,
                    composerOptionsInput: ownerProjection?.kind === 'owner' ? ownerProjection.composerOptionsInput : null,
                    agentState,
                    cachedEntry,
                    encryptedContentAvailability: contentAvailability,
                });
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
    isSessionCurrent?: (sessionId: string) => boolean;
    batchSize?: number;
    flushDelayMs?: number;
}): HydratedSession[] {
    const admittedSessions = params.isSessionCurrent
        ? params.sessions.filter((session) => params.isSessionCurrent!(session.id))
        : params.sessions;
    const staleSessions: HydratedSession[] = [];
    const currentSessions = params.getCurrentSessionListRenderable
        ? admittedSessions.filter((session) => {
            const isCurrent = isHydratedSessionCurrentForListState(
                session,
                params.getCurrentSessionListRenderable,
            );
            if (!isCurrent) {
                staleSessions.push(session);
            }
            return isCurrent;
        })
        : admittedSessions;
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
    shouldContinue: () => boolean;
    isSessionCurrent: (sessionId: string) => boolean;
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
            isSessionCurrent: params.isSessionCurrent,
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

export async function fetchAndApplySessions(params: {
    serverId?: string | null;
    source?: SessionListPageSource;
    sessionListPath?: string;
    /** Cancellation belongs to this acquisition's caller, not its corpus or Encryption object. */
    signal?: AbortSignal;
    sessionListCursor?: string | null;
    sessionListAttentionCursor?: string | null;
    sessionListPageSize?: number;
    sessionListMaxPages?: number;
    sessionListAttentionMaxPages?: number;
    includeActiveSessionRows?: boolean;
    includeSessionListAttentionRows?: boolean;
    priorityHydrationSessionIds?: ReadonlyArray<string>;
    credentials: AuthCredentials;
    accountCurrentness?: AccountEncryptionCurrentnessResponse;
    encryption: SessionListEncryption | null;
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
    log: { log: (message: string) => void };
    clientEncryptionRequirement?: ClientEncryptionRequirement;
}): Promise<SessionListFetchResult> {
    const { credentials, encryption, sessionDataKeys } = params;
    const isQuerySource = params.source?.kind === 'query';
    const applySessions = isQuerySource ? (_sessions: HydratedSession[]) => {} : params.applySessions;
    const snapshotStartedAtMs = nowMs();
    // Captured before the first request: a retirement committed after this point
    // wins over whatever this read's pages still carry for that exact Home.
    const retirementFence = captureSessionListRetirementFence();
    const isSessionCurrent = (sessionId: string) => !wasSessionRetiredSinceFence(retirementFence, params.serverId, sessionId);
    const applySessionListRenderablePatches = params.applySessionListRenderablePatches
        ? (patches: readonly SessionListRenderablePatch[]) => {
            const currentPatches = patches.filter((patch) => isSessionCurrent(patch.sessionId));
            if (currentPatches.length > 0) params.applySessionListRenderablePatches!(currentPatches);
        }
        : undefined;
    const performRequest =
        params.request
        ?? ((path: string, init: RequestInit) => serverFetch(path, init, { includeAuth: false }));
    const request = (path: string, init: RequestInit) => performRequest(path, {
        ...init,
        ...(params.signal ? { signal: params.signal } : {}),
    });

    const sessionListPageSize = Math.max(1, Math.min(200, Math.trunc(params.sessionListPageSize ?? 50)));
    const sessionListMaxPages = Math.max(1, Math.trunc(params.sessionListMaxPages ?? 1));
    const sessionListAttentionMaxPages = Math.max(
        1,
        Math.min(
            DEFAULT_SESSION_LIST_ATTENTION_CONTINUATION_MAX_PAGES,
            Math.trunc(
                params.sessionListAttentionMaxPages
                ?? DEFAULT_SESSION_LIST_ATTENTION_CONTINUATION_MAX_PAGES,
            ),
        ),
    );
    const sessions: V2SessionListResponse['sessions'] = [];
    const seenSessionIds = new Set<string>();
    const concurrencyLimit = Math.max(1, Math.trunc(params.sessionListHydrationConcurrencyLimit ?? 4));
    const backgroundHydrationConcurrencyLimit = Math.max(1, Math.trunc(params.sessionListBackgroundHydrationConcurrencyLimit ?? 1));
    const backgroundHydrationYieldEveryRows = Math.max(1, Math.trunc(params.sessionListBackgroundHydrationYieldEveryRows ?? 1));
    const backgroundHydrationApplyBatchSize = Math.max(1, Math.trunc(params.sessionListBackgroundHydrationApplyBatchSize ?? 1));
    const backgroundHydrationApplyFlushDelayMs = Math.max(0, Math.trunc(params.sessionListBackgroundHydrationApplyFlushDelayMs ?? 16));
    const backgroundHydrationYield = params.sessionListBackgroundHydrationYield
        ?? (() => yieldToSessionListBackgroundHydration(params.sessionListBackgroundHydrationYieldDelayMs ?? 0));
    // Legacy ordinary owners expose a currentness predicate rather than a signal.
    // Its adapter is private to this read: no other reader can supersede it.
    const dataKeyHydrationAbortController = params.signal ? null : new AbortController();
    const dataKeyHydrationSignal = params.signal ?? dataKeyHydrationAbortController!.signal;
    const rawShouldContinue = params.shouldContinue ?? (() => true);
    const shouldContinue = () => {
        if (dataKeyHydrationSignal.aborted) return false;
        const canContinue = rawShouldContinue();
        if (!canContinue) {
            dataKeyHydrationAbortController?.abort();
        }
        return canContinue;
    };
    let usedLegacyV1Snapshot = false;

    let cursor: string | null = params.sessionListCursor !== undefined
        ? params.sessionListCursor
        : params.source?.kind === 'query'
            ? params.source.body.cursor ?? null
            : null;
    const requestedAttentionCursor = params.sessionListAttentionCursor !== undefined
        ? params.sessionListAttentionCursor
        : params.source?.kind === 'query'
            ? params.source.body.attentionCursor ?? null
            : null;
    const isAttentionContinuation = typeof requestedAttentionCursor === 'string' && requestedAttentionCursor.length > 0;
    const includeSessionListAttentionRows = params.source?.kind === 'query'
        ? params.source.body.includeAttention === true
        : params.includeSessionListAttentionRows === true;
    const seenCursors = new Set<string>();
    let fetchedPages = 0;
    let nextCursorForMore: string | null = cursor;
    let hasNextForMore = false;
    let attentionNextCursor: string | null = null;
    let attentionHasNext = false;
    let fetchedAttentionPages = 0;
    let source: 'v2' | 'v1' = 'v2';
    let accountCurrentness = params.accountCurrentness;
    let metadataUpgradeRequiredCount = 0;
    const buildFetchResult = (): SessionListFetchResult => ({
        sessionIds: sessions.map((session) => session.id).filter(isSessionCurrent),
        isSessionCurrent,
        nextCursor: nextCursorForMore,
        hasNext: hasNextForMore,
        attentionNextCursor,
        attentionHasNext,
        current: shouldContinue(),
        source,
        ...(accountCurrentness ? { accountCurrentness } : {}),
        metadataUpgradeRequiredCount,
    });
    const appendRows = (rows: V2SessionListResponse['sessions']): void => {
        for (const row of rows) {
            if (seenSessionIds.has(row.id)) continue;
            seenSessionIds.add(row.id);
            sessions.push(row);
        }
    };

    const initialSessionListPath = !isQuerySource && !cursor && !params.sessionListPath
        ? buildSessionListInitialPath({
            includeAttentionRows: includeSessionListAttentionRows,
        })
        : undefined;

    if (!isQuerySource && params.includeActiveSessionRows === true && !cursor && !params.sessionListPath) {
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
                allowLegacyV1Fallback: false,
                telemetryFields: activePageFields,
            }),
        );
        appendRows(activePage.sessions);
        metadataUpgradeRequiredCount += activePage.metadataUpgradeRequiredCount;
    }

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
                source: params.source,
                sessionListPath: params.sessionListPath ?? initialSessionListPath,
                cursor: isAttentionContinuation ? undefined : cursor,
                attentionCursor: isAttentionContinuation ? requestedAttentionCursor : undefined,
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
                metadataUpgradeRequiredCount += page.metadataUpgradeRequiredCount;
                source = page.source;
                if (page.source === 'v1') {
                    usedLegacyV1Snapshot = true;
                }
                if (isAttentionContinuation) {
                    attentionNextCursor = page.attentionNextCursor;
                    attentionHasNext = page.attentionHasNext;
                    fetchedAttentionPages += 1;
                    shouldStopAfterPage = true;
                } else {
                    shouldStopAfterPage = !page.hasNext || !page.nextCursor || page.source === 'v1';
                    nextCursor = page.nextCursor;
                    nextCursorForMore = page.nextCursor;
                    hasNextForMore = page.hasNext === true && typeof page.nextCursor === 'string' && page.source === 'v2';
                    if (fetchedPages === 0 && includeSessionListAttentionRows) {
                        attentionNextCursor = page.attentionNextCursor;
                        attentionHasNext = page.attentionHasNext;
                    }
                }
            },
        );

        fetchedPages += 1;
        if (shouldStopAfterPage) break;
        if (nextCursor && seenCursors.has(nextCursor)) break;
        if (nextCursor) seenCursors.add(nextCursor);
        cursor = nextCursor;
    }

    if (
        includeSessionListAttentionRows
        && source === 'v2'
    ) {
        const seenAttentionCursors = new Set<string>();

        while (
            attentionHasNext
            && attentionNextCursor
            && fetchedAttentionPages < sessionListAttentionMaxPages
        ) {
            if (seenAttentionCursors.has(attentionNextCursor)) break;
            seenAttentionCursors.add(attentionNextCursor);

            const attentionPage = await fetchSessionListPageCompat({
                request,
                token: credentials.token,
                source: params.source,
                sessionListPath: isQuerySource ? undefined : DEFAULT_SESSION_LIST_PATH,
                attentionCursor: attentionNextCursor,
                limit: sessionListPageSize,
                allowLegacyV1Fallback: false,
            });
            appendRows(attentionPage.sessions);
            metadataUpgradeRequiredCount += attentionPage.metadataUpgradeRequiredCount;
            fetchedAttentionPages += 1;
            attentionNextCursor = attentionPage.attentionNextCursor;
            attentionHasNext = attentionPage.attentionHasNext;
        }
    }

    if (params.clientEncryptionRequirement === 'require_e2ee') {
        for (let index = sessions.length - 1; index >= 0; index -= 1) {
            const session = sessions[index];
            if (session && !isSessionEncryptionModeAllowedByClientRequirement(
                params.clientEncryptionRequirement,
                session.encryptionMode === 'plain' ? 'plain' : 'e2ee',
            )) {
                sessions.splice(index, 1);
            }
        }
    }

    if (
        !accountCurrentness
        && sessions.some((row) => (
            readSessionMetadataLayoutVersion(row.metadataLayoutVersion) === 1
            && readSessionAccessRole(row, { allowLegacy: true }) === 'owner'
            && row.ownerMetadata != null
        ))
    ) {
        accountCurrentness = await fetchAccountEncryptionCurrentness(
            credentials,
            { request },
        );
        if (!shouldContinue()) return buildFetchResult();
    }

    const sessionsNeedingEncryption = sessions.filter((session) => session.encryptionMode !== 'plain');
    const sessionDataKeyEnvelopes = params.sessionDataKeyEnvelopes;

    const cachedSessionListEntries = params.cachedSessionListEntries ?? {};
    const fetchedSessionIds = sessions.map((session) => session.id);
    const fetchedSessionIdSet = new Set(fetchedSessionIds);
    const retainedCachedSessionIds = usedLegacyV1Snapshot
        ? Object.keys(cachedSessionListEntries).filter((sessionId) => (
            !fetchedSessionIdSet.has(sessionId)
            && isSessionCurrent(sessionId)
        ))
        : [];
    const shouldApplyRenderables = typeof params.applySessionListRenderables === 'function';
    let appliedRenderableCount = 0;
    const requiredHydrationSessionIds = new Set(
        (params.requiredHydrationSessionIds ?? [])
            .map((sessionId) => String(sessionId ?? '').trim())
            .filter(Boolean),
    );
    for (const row of sessions) {
        const existingSession = params.getExistingSession?.(row.id);
        if (
            existingSession
            && readSessionMetadataLayoutVersion(row.metadataLayoutVersion)
                > readSessionMetadataLayoutVersion(existingSession.metadataLayoutVersion)
        ) {
            requiredHydrationSessionIds.add(row.id);
        }
    }
    const requiredSnapshotRows = countRowsWithIds(sessions, requiredHydrationSessionIds);
    const backgroundSnapshotRows = countBackgroundRows(sessions.length, requiredSnapshotRows);

    if (!shouldContinue()) {
        return buildFetchResult();
    }
    // Rows and membership only: a Session this exact Home retired (deleted or
    // revoked) while the pages were in flight is not reinserted, and the rest of the
    // page still applies. From here to the renderable application below is
    // synchronous, so no later retirement can slip between this check and the store.
    for (let index = sessions.length - 1; index >= 0; index -= 1) {
        const row = sessions[index];
        if (row && !isSessionCurrent(row.id)) {
            sessions.splice(index, 1);
        }
    }
    if (!isQuerySource) {
        params.onSnapshotFetched?.([...sessions.map((row) => row.id), ...retainedCachedSessionIds]);
    }
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
                    credentials,
                    accountCurrentness,
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
    let capturedEncryptionGeneration = encryption?.getCurrentEncryptionGenerationScope?.(
        encryptionScope,
    ) ?? null;
    const isDataKeyHydrationCurrent = () => (
        shouldContinue()
        && (!capturedEncryptionGeneration
            || encryption?.isCurrentEncryptionGenerationScope?.(
                capturedEncryptionGeneration,
            ) !== false)
    );
    const dataKeyHydrationScope: EncryptionScopeInput = {
        ...encryptionScope,
        signal: dataKeyHydrationSignal,
        shouldContinue: isDataKeyHydrationCurrent,
    };
    // The snapshot owns one speculative hydration batch. Keep its cache writes
    // private until the Account/Home encryption generation is still current
    // after runtime initialization, so a superseded snapshot cannot publish or
    // evict material belonging to the replacement generation.
    const stagedSessionDataKeys = new Map(sessionDataKeys);
    const stagedSessionDataKeyEnvelopes = sessionDataKeyEnvelopes
        ? new Map(sessionDataKeyEnvelopes)
        : undefined;
    const dataKeyHydrationPlan = createSessionDataKeyHydrationPlan({
        sessions: sessions.map((session) => ({
            id: session.id,
            encryptionMode: session.encryptionMode,
            dataEncryptionKey: session.dataEncryptionKey,
            viewerRole: readSessionAccessRole(session, { allowLegacy: true }) === 'owner' ? 'owner' : 'recipient',
        })),
        credentialKind: readSessionDataKeyCredentialKind(credentials),
        sessionDataKeys: stagedSessionDataKeys,
        sessionDataKeyEnvelopes: stagedSessionDataKeyEnvelopes,
    });
    let missingEncryptedDataKeySessionIds: ReadonlySet<string>;
    let hydrationStates: ReadonlyMap<string, SessionDataKeyHydrationState>;
    if (encryption) {
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
                sessionDataKeys: stagedSessionDataKeys,
                sessionDataKeyEnvelopes: stagedSessionDataKeyEnvelopes,
                scope: dataKeyHydrationScope,
                shouldContinue: isDataKeyHydrationCurrent,
            }),
        );
        if (keyHydration.stale || !isDataKeyHydrationCurrent()) {
            return buildFetchResult();
        }
        const { sessionKeys, sessionEncryptionClears } = keyHydration;
        if (sessionKeys.size > 0) {
            const initializedScope = await syncPerformanceTelemetry.measureAsync(
                'sync.sessions.snapshot.initializeSessions',
                { sessions: sessionKeys.size },
                async () => encryption.initializeSessions(sessionKeys, {
                    ...encryptionScope,
                    signal: dataKeyHydrationSignal,
                    shouldContinue: isDataKeyHydrationCurrent,
                    isSessionCurrent,
                }),
            );
            if (initializedScope) capturedEncryptionGeneration = initializedScope;
        }
        if (!isDataKeyHydrationCurrent()) return buildFetchResult();

        for (const entry of dataKeyHydrationPlan.entries) {
            if (!isSessionCurrent(entry.sessionId)) continue;
            const stagedKey = stagedSessionDataKeys.get(entry.sessionId);
            if (stagedKey) sessionDataKeys.set(entry.sessionId, stagedKey);
            else sessionDataKeys.delete(entry.sessionId);
            if (sessionDataKeyEnvelopes) {
                const stagedEnvelope = stagedSessionDataKeyEnvelopes?.get(entry.sessionId);
                if (stagedEnvelope) sessionDataKeyEnvelopes.set(entry.sessionId, stagedEnvelope);
                else sessionDataKeyEnvelopes.delete(entry.sessionId);
            }
        }
        for (const sessionId of sessionEncryptionClears) {
            if (!isSessionCurrent(sessionId)) continue;
            encryption.removeSessionEncryption(sessionId);
        }
        missingEncryptedDataKeySessionIds = buildMissingEncryptedDataKeySessionIdSet(keyHydration.states);
        hydrationStates = keyHydration.states;
    } else {
        const keyHydration = await hydrateSessionDataKeys({
            plan: dataKeyHydrationPlan,
            encryption: {
                decryptEncryptionKeys: async (values) => values.map(() => null),
            },
            sessionDataKeys: stagedSessionDataKeys,
            sessionDataKeyEnvelopes: stagedSessionDataKeyEnvelopes,
            scope: dataKeyHydrationScope,
            shouldContinue,
        });
        if (keyHydration.stale || !shouldContinue()) return buildFetchResult();
        for (const entry of dataKeyHydrationPlan.entries) {
            if (!isSessionCurrent(entry.sessionId)) continue;
            const stagedKey = stagedSessionDataKeys.get(entry.sessionId);
            if (stagedKey) sessionDataKeys.set(entry.sessionId, stagedKey);
            else sessionDataKeys.delete(entry.sessionId);
            if (sessionDataKeyEnvelopes) {
                const stagedEnvelope = stagedSessionDataKeyEnvelopes?.get(entry.sessionId);
                if (stagedEnvelope) sessionDataKeyEnvelopes.set(entry.sessionId, stagedEnvelope);
                else sessionDataKeyEnvelopes.delete(entry.sessionId);
            }
        }
        hydrationStates = keyHydration.states;
        missingEncryptedDataKeySessionIds = buildMissingEncryptedDataKeySessionIdSet(
            keyHydration.states,
        );
    }
    let recipientReadiness = accountCurrentness?.recipientEnvelopeReadiness;
    if (missingEncryptedDataKeySessionIds.size > 0 && !recipientReadiness) {
        try {
            accountCurrentness = await fetchAccountEncryptionCurrentness(credentials, { request });
            recipientReadiness = accountCurrentness.recipientEnvelopeReadiness;
        } catch (error) {
            if (!(error instanceof AccountEncryptionCurrentnessReadinessError)) throw error;
            recipientReadiness = error.recipientEnvelopeReadiness;
        }
        if (!shouldContinue()) return buildFetchResult();
    }
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
        const hydrationPriority = orderRowsForSessionListHydration({
            rows: sessions.filter((row) =>
                isSessionCurrent(row.id) && needsWarmHydration({
                    row,
                    cachedEntry: cachedSessionListEntries[row.id],
                    existingSession: params.getExistingSession?.(row.id),
                    currentRenderable: params.getCurrentSessionListRenderable?.(row.id),
                    isRequiredHydrationRow: requiredHydrationSessionIds.has(row.id),
                    isAttentionHydrationRow: isSessionListRowAttentionHydrationPriority(row),
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
                applySessionListRenderablePatches,
                getExistingSession: params.getExistingSession,
                getCurrentSessionListRenderable: params.getCurrentSessionListRenderable,
                shouldContinue,
                isSessionCurrent,
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
                                        if (!shouldContinue() || !isSessionCurrent(row.id)) {
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
                                        if (!shouldContinue() || !isSessionCurrent(row.id)) {
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
                                        if (!shouldContinue() || !isSessionCurrent(row.id)) {
                                            hydrationAttribution.cancelledRows += 1;
                                            markRequiredHydrationResult(row, null);
                                            return null;
                                        }
                                        const decryptStartedAtMs = nowMs();
                                        const decryptedSession = await decryptSessionRow(
                                            row,
                                            credentials,
                                            accountCurrentness,
                                            encryption,
                                            params.serverId,
                                            cachedSessionListEntries[row.id],
                                            hydrationStates.get(row.id),
                                            recipientReadiness,
                                        );
                                        addBackgroundHydrationDuration(
                                            hydrationAttribution,
                                            'decryptRowMs',
                                            nowMs() - decryptStartedAtMs,
                                        );
                                        if (!shouldContinue() || !isSessionCurrent(row.id)) {
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
                                            if (unavailablePatch && applySessionListRenderablePatches) {
                                                applySessionListRenderablePatches([unavailablePatch]);
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
                                                applySessionListRenderablePatches,
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
                    const missingRequiredHydration = requiredRowsNeedingHydration.find((row) => isSessionCurrent(row.id) && !hydratedSessionIds.has(row.id));
                    if (missingRequiredHydration) {
                        throw new Error(`Required session hydration failed for ${missingRequiredHydration.id}`);
                    }
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
                .map((row) => async () => decryptSessionRow(
                    row,
                    credentials,
                    accountCurrentness,
                    encryption,
                    params.serverId,
                    cachedSessionListEntries[row.id],
                    hydrationStates.get(row.id),
                    recipientReadiness,
                )),
            concurrencyLimit,
        ),
    );
    const decryptedSessions = decryptedResults.filter((session): session is NonNullable<typeof session> => Boolean(session));

    if (!shouldContinue()) {
        return buildFetchResult();
    }

    applyHydratedSessions({
        sessions: decryptedSessions,
        isSessionCurrent,
        applySessions,
        getExistingSession: params.getExistingSession,
        getCurrentSessionListRenderable: params.getCurrentSessionListRenderable,
        batchSize: decryptedSessions.length,
        flushDelayMs: 0,
    });

    return buildFetchResult();
}

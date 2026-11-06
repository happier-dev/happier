import type { SessionListBackgroundWorkAttentionMode } from './sessionListBackgroundWorkAttention';
import { nestSessionListReports, resolveWorkflowRunParentSessionId } from './nestSessionListReports';
import { mergeWorkflowRunGroups, type WorkflowRunGroup } from './mergeWorkflowRunGroups';
import { canSessionListFilterIncludeRunsV1, normalizeSessionListFilterV1, type SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { compileSessionListRowLocalFilter, compileSessionListSpaceFilter, compileWorkflowRunSessionListFilter, type SessionListSpaceMembership } from './sessionListWorkFilter';
import type { SessionListFilterMatchV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { EntityListFilterResultV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { buildSessionListDateGroups } from './sessionListDateGroups';
import { t } from '@/text';
import { isTerminalWorkflowRunState, resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import type { ServerSelectionPresentation } from '@/sync/domains/server/selection/serverSelectionTypes';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListIndexEntityId } from '@/sync/domains/sessionList/sessionListIndexIdentity';
import { projectSessionListIndexGroupRollups,
    type SessionListGroupSubject, type SessionListIndexGroupRollupProjection } from '@/sync/domains/sessionList/sessionListGroupRollups';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { reconcileSupplementalSessionListAttention } from './sessionListSupplementalAttention';
import { inboxItemViewV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { getSessionStorageKind } from '../sessionStorageKind';
import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { projectSessionListConditionValueCounts, type SessionListConditionValueCountProjection,
    type SessionListConditionValueCountRequest, type SessionListConditionValueCounts } from './sessionListConditionValueCounts';
export type { SessionListConditionValueCountRequest, SessionListConditionValueCounts } from './sessionListConditionValueCounts';

import { applySessionListIndexPresentation, restoreSessionListContextHeaders } from './sessionListIndexPresentation';
import {
    buildSessionListGlobalPlacements,
    type SessionListAttentionPlacementOptions,
    type SessionListWorkingPlacementOptions,
} from './sessionListAttentionPlacement';
import {
    completeSessionProjectGroupOrder,
    type SessionWorkspaceOrderV1,
} from './sessionWorkspaceOrderStateV1';
import { normalizeTrimmedStringArrayWithSharedEmpty } from './normalizeTrimmedStringArrayWithSharedEmpty';
import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import { isSessionListFolderOrderItemKey } from './sessionListOrderingStateV1';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { createSessionProjectKeyResolverV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { buildProjectGroupDisplayIndex, projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { buildSessionProjectGroupingIdentity, resolveSessionProjectGroupingKeyParts, sessionProjectGroupingIdentityKey } from './sessionListProjectGroupingKeys';
import { buildSessionWorkspaceFallbackOrderKey, readSessionWorkspaceFallbackIdentity } from './sessionWorkspaceOrderKeys';
import { admitProjectWorkspaceCensusForSubject } from '@/sync/domains/workspaces/projectWorkspaceCensusAdmission';
import { normalizeSessionFolderWorkspaceRef } from '@/sync/domains/session/folders/workspaceRefs';
import {
    buildSessionListSessionOrderingKey,
    compareSessionListSessionOrderingKeys,
    readSessionListMeaningfulActivityAt,
    resolveEffectiveSessionListOrderingModeForGroup,
    type SessionListOrderingModeV1,
    type SessionListSessionOrderingKey,
} from './sessionListOrderingRules';
import {
    projectSessionListIndexForLayout,
    resolveSessionListLayoutPresentation,
    type SessionListLayoutChoice,
} from './sessionListLayout';

export type { SessionListFolderSortModeV1, SessionListOrderingModeV1 } from './sessionListOrderingRules';

export type ComputeVisibleSessionListIndexParams = Readonly<{
    source: ReadonlyArray<SessionListIndexItem> | null;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    hideInactiveSessions: boolean;
    /**
     * Homes whose rows the corpus itself already narrowed by activity — the strict
     * query carries `includeInactive` and returns an inactive row only when the
     * server's own attention predicate admitted it. Re-running the client rule over
     * those rows would delete exactly the rows that were deliberately kept, so their
     * membership is authoritative here. Homes served by the released GET adapter are
     * absent from this set and keep the client rule.
     */
    serverFilteredInactiveServerIds?: ReadonlySet<string> | null;
    corpusStorage?: 'active' | 'archived';
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    sessionWorkspaceOrderV1?: SessionWorkspaceOrderV1;
    sessionListLayoutChoice?: SessionListLayoutChoice;
    sessionListAttentionPlacementV1?: 'both' | 'top' | 'inPlace';
    previousPresentedIndex?: ReadonlyArray<SessionListIndexItem> | null;
    attentionInteractionHeld?: boolean;
    /** P6 supplies already-authorized, attention-eligible out-of-space entities. */
    supplementalNeedsYouSessionKeys?: ReadonlySet<string>;
    /** Captured authorized rows already held by the ordinary source, never another loader. */
    attentionSource?: readonly SessionListIndexItem[] | null;
    includeNeedsYouEverywhere?: boolean;
    fixedTeam?: Readonly<{ serverId: string; teamId: string }>;
    /** Exact currently applied structural query pages that proved the fixed Team. */
    fixedTeamQueryServerIds?: ReadonlySet<string>;
    backgroundWorkAttentionMode?: SessionListBackgroundWorkAttentionMode;
    attentionPlacement?: SessionListAttentionPlacementOptions;
    workingPlacement?: SessionListWorkingPlacementOptions;
    presentation: Readonly<{
        enabled: boolean;
        presentation: ServerSelectionPresentation;
        selectedServerIds?: ReadonlyArray<string>;
    }>;
    storageFilterApplied?: boolean;
    nowMs?: number;
    workFilter?: SessionListFilterV1;
    spaceMembership?: SessionListSpaceMembership;
    workspaceRefs?: readonly WorkspaceRefV1[];
    workspaceRefsServerId?: string;
    viewerAccountIdByServerId?: ReadonlyMap<string, string>;
    workflowRuns?: readonly Readonly<{ serverId: string; summary: WorkflowRunSummaryV1 }>[];
    workflowRunUnderSessionId?: string;
    sessionFolderAssignmentsBySessionKey?: Readonly<Record<string, string | null>>;
    sessionTagIdsBySessionKey?: Readonly<Record<string, readonly string[]>>;
    /** Explicit privacy preference joined with current native recording and existing organization tags. */
    querySectionIdsByServerId?: ReadonlyMap<string, readonly string[]>;
    previousMembership?: SessionListWorkMembershipProjection;
    conditionValueCountRequest?: SessionListConditionValueCountRequest | null;
    /** Coverage of the admitted source window; a loaded page is not a complete corpus. */
    groupCoverage?: SessionListGroupSubject['coverage'];
}>;

type SessionMembership = Readonly<{
    row: SessionListRenderableSession | null;
    storageKind: 'persisted' | 'direct' | undefined;
    sourceKind?: 'persisted' | 'direct';
    sectionId: string | null | undefined;
    viewerAccountId: string | undefined;
    tagIds: readonly string[] | undefined;
    match: SessionListFilterMatchV1;
    ordinary: boolean;
    status?: WorkStatusPresentation;
}>;
type RunMembership = Readonly<{
    serverId: string;
    summary: WorkflowRunSummaryV1;
    viewerAccountId: string | undefined;
    match: SessionListFilterMatchV1;
}>;

/** Retained by the visible projection's existing lifecycle, with only its held entity keys. */
export type SessionListWorkMembershipProjection = Readonly<{
    filter: SessionListFilterV1;
    filterInput: SessionListFilterV1 | undefined;
    spaceMembership: SessionListSpaceMembership | undefined;
    workspaceRefs: readonly WorkspaceRefV1[] | undefined;
    workspaceRefsServerId: string | undefined;
    projectKeyResolver: ReturnType<typeof createSessionProjectKeyResolverV1>;
    nowMs: number;
    workflowRunUnderSessionId: string | undefined;
    querySectionIdsByServerId: ReadonlyMap<string, readonly string[]> | undefined;
    sessions: ReadonlyMap<string, SessionMembership>;
    runs: ReadonlyMap<string, RunMembership>;
    sessionPredicates: ReadonlyMap<string, ReturnType<typeof compileSessionListRowLocalFilter>>;
    runPredicate: ReturnType<typeof compileWorkflowRunSessionListFilter>;
    groupSubjects?: ReadonlyMap<string, SessionListGroupSubject>;
    groupRollups?: SessionListIndexGroupRollupProjection;
    runFactsUnavailable: boolean;
    conditionValueCountProjection?: SessionListConditionValueCountProjection;
}>;

export type VisibleSessionListProjection = Readonly<{
    items: SessionListIndexItem[] | null;
    filterResult: EntityListFilterResultV1;
    matchedEntityIds: ReadonlySet<string>;
    attentionSupplementEntityIds: ReadonlySet<string>;
    membership: SessionListWorkMembershipProjection;
    conditionValueCounts?: SessionListConditionValueCounts;
}>;

function projectWorkMembership(params: ComputeVisibleSessionListIndexParams): SessionListWorkMembershipProjection {
    const nowMs = params.nowMs ?? Date.now();
    const previous = params.previousMembership;
    const defaultHomeIds = params.workFilter ? [] : [...new Set([...(params.source ?? []).flatMap(item => item.serverId ? [item.serverId] : []),
        ...params.workflowRuns?.map(run => run.serverId) ?? []])];
    const filter = params.workFilter ?? (previous && previous.filterInput === undefined
        && previous.filter.homeServerIds.length === defaultHomeIds.length
        && defaultHomeIds.every(id => previous.filter.homeServerIds.includes(id)) ? previous.filter : normalizeSessionListFilterV1({ scope: 'all_accessible',
        startedBy: ['you', 'triggers', 'agents'],
        homeServerIds: defaultHomeIds,
    }));
    const sameFilter = previous?.filter === filter && previous?.spaceMembership === params.spaceMembership;
    const sameProjects = previous?.workspaceRefs === params.workspaceRefs
        && previous?.workspaceRefsServerId === params.workspaceRefsServerId;
    const usesProjects = [filter, params.spaceMembership?.filter].some(value => Boolean(value?.projects && value.projects.include.length + value.projects.exclude.length));
    const usesStatus = [filter, params.spaceMembership?.filter].some(value => Boolean(value?.statuses?.length || value?.excludedStatuses?.length));
    const sessionPredicates = new Map<string, ReturnType<typeof compileSessionListRowLocalFilter>>();
    const sessions = new Map<string, SessionMembership>();
    const sessionProjectKeyResolver = previous && sameProjects ? previous.projectKeyResolver
        : createSessionProjectKeyResolverV1(params.workspaceRefs, workspaceRefResolutionContextV1());
    const ordinaryKeys = new Set((params.source ?? []).flatMap(item => item.type === 'session'
        ? [JSON.stringify([item.serverId ?? '', item.sessionId])] : []));
    const heldSource = params.includeNeedsYouEverywhere ? [...params.source ?? [], ...params.attentionSource ?? []] : params.source ?? [];
    for (const item of heldSource) {
        if (item.type !== 'session') continue;
        const key = JSON.stringify([item.serverId ?? '', item.sessionId]);
        if (sessions.has(key)) continue;
        const serverId = item.serverId ?? '';
        const ordinary = ordinaryKeys.has(key);
        if (!ordinary && !filter.homeServerIds.some(home => (resolveServerProfileScopeIdForIdentifier(home) || home)
            === (resolveServerProfileScopeIdForIdentifier(serverId) || serverId))) continue;
        const row = params.resolveSessionRow(serverId, item.sessionId);
        const viewerAccountId = params.viewerAccountIdByServerId?.get(resolveServerProfileScopeIdForIdentifier(serverId) || serverId);
        const sectionId = params.sessionFolderAssignmentsBySessionKey?.[key];
        const tagIds = params.sessionTagIdsBySessionKey?.[key];
        const scopeId = resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
        const sectionProof = params.querySectionIdsByServerId?.get(scopeId);
        const previousProof = previous?.querySectionIdsByServerId?.get(scopeId);
        const sameProof = sectionProof === previousProof || Boolean(sectionProof && previousProof
            && sectionProof.length === previousProof.length && sectionProof.every((id, index) => id === previousProof[index]));
        let predicate = sessionPredicates.get(serverId);
        if (!predicate) {
            predicate = sameFilter && sameProof ? previous?.sessionPredicates.get(serverId) : undefined;
            predicate ??= params.spaceMembership ? compileSessionListSpaceFilter(filter, serverId, params.spaceMembership, sectionProof)
                : compileSessionListRowLocalFilter(filter, serverId, sectionProof);
            sessionPredicates.set(serverId, predicate);
        }
        const old = previous?.sessions.get(key);
        const sourceKind = filter.source === 'all' ? undefined : item.storageKind
            ?? (old?.row === row && old.storageKind === item.storageKind && old.sourceKind !== undefined
                ? old.sourceKind : getSessionStorageKind(row));
        const unchanged = old && old.row === row && old.viewerAccountId === viewerAccountId && old.ordinary === ordinary
            && old.storageKind === item.storageKind && old.sectionId === sectionId && old.tagIds === tagIds
            && previous?.sessionPredicates.get(serverId) === predicate
            && (!usesProjects || sameProjects) && (!usesStatus || previous?.nowMs === nowMs);
        const match = !ordinary ? 'miss' : unchanged ? old.match : !params.workFilter && !params.workflowRuns ? 'match' : predicate(row, {
            nowMs, workspaceRefs: params.workspaceRefs, storageKind: sourceKind ?? item.storageKind, viewerAccountId,
            workspaceRefsServerId: params.workspaceRefsServerId,
            sessionProjectKeyResolver,
            tagIds,
            section: sectionId === undefined ? undefined : sectionId === null ? null : { serverId, sectionId },
        });
        const status = params.includeNeedsYouEverywhere && row && sessionListRowMatchesCorpus(row, params.corpusStorage)
            ? old?.row === row && old.viewerAccountId === viewerAccountId && previous?.nowMs === nowMs && old.status
                ? old.status : resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(row, nowMs) })
            : undefined;
        sessions.set(key, unchanged && old.status === status && old.sourceKind === sourceKind ? old
            : { row, storageKind: item.storageKind, sourceKind, sectionId, tagIds, viewerAccountId, match, ordinary, status });
    }
    const runPredicate = previous && sameFilter && previous.workflowRunUnderSessionId === params.workflowRunUnderSessionId ? previous.runPredicate : (() => {
        const refinement = compileWorkflowRunSessionListFilter(filter);
        const space = params.spaceMembership;
        if (!space) return refinement;
        const smart = compileWorkflowRunSessionListFilter(space.filter);
        const predicate: ReturnType<typeof compileWorkflowRunSessionListFilter> = (summary, serverId, viewerAccountId, underProven) => {
            if (space.membership.mode === 'manual_only') return 'miss';
            const outer = refinement(summary, serverId, viewerAccountId, underProven);
            const member = smart(summary, serverId, viewerAccountId,
                params.workflowRunUnderSessionId === space.filter.underSessionId && space.filter.underSessionId !== undefined ? true : undefined);
            return outer === 'miss' || member === 'miss' ? 'miss' : outer === 'unavailable' || member === 'unavailable' ? 'unavailable' : 'match';
        };
        return predicate;
    })();
    const runs = new Map<string, RunMembership>();
    let runFactsUnavailable = false;
    for (const run of params.workflowRuns ?? []) {
        const key = JSON.stringify([run.serverId, run.summary.id]);
        if (runs.has(key)) continue;
        const viewerAccountId = params.viewerAccountIdByServerId?.get(resolveServerProfileScopeIdForIdentifier(run.serverId) || run.serverId);
        const old = previous?.runs.get(key);
        const unchanged = old && old.summary === run.summary && old.viewerAccountId === viewerAccountId
            && previous?.runPredicate === runPredicate && previous?.workflowRunUnderSessionId === params.workflowRunUnderSessionId;
        const match = unchanged ? old.match : runPredicate(run.summary, run.serverId, viewerAccountId,
            params.workflowRunUnderSessionId === filter.underSessionId && filter.underSessionId !== undefined);
        runFactsUnavailable ||= match === 'unavailable';
        runs.set(key, unchanged ? old : { serverId: run.serverId, summary: run.summary, viewerAccountId, match });
    }
    return { filter, filterInput: params.workFilter, spaceMembership: params.spaceMembership, workspaceRefs: params.workspaceRefs,
        workspaceRefsServerId: params.workspaceRefsServerId, projectKeyResolver: sessionProjectKeyResolver, nowMs,
        querySectionIdsByServerId: params.querySectionIdsByServerId, workflowRunUnderSessionId: params.workflowRunUnderSessionId,
        sessions, runs, sessionPredicates, runPredicate, runFactsUnavailable };
}

const PINNED_GROUP_KEY_V1 = 'pinned-v1';

function sessionListRowMatchesCorpus(row: SessionListRenderableSession, corpusStorage: ComputeVisibleSessionListIndexParams['corpusStorage']): boolean {
    return corpusStorage === 'archived' ? row.archivedAt != null : row.archivedAt == null || row.archiving === true;
}

type VisibleSessionListSourceState = Readonly<{
    hasArchivedSessionItems: boolean;
    hasMissingSessionRows: boolean;
    hasInactiveSessionsThatNeedFiltering: boolean;
    hasOrphanHeaders: boolean;
    visiblePlaceholderRows: number;
}>;

function resolveSessionRowForItem(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): SessionListRenderableSession | null {
    const sessionId = normalizeTrimmedString(item.sessionId);
    if (!sessionId) return null;
    const serverId = normalizeTrimmedString(item.serverId) || null;
    return resolveSessionRow(serverId, sessionId);
}

function isPrimarySessionListSectionHeader(item: Extract<SessionListIndexItem, { type: 'header' }>): boolean {
    return item.headerKind === 'active' || item.headerKind === 'inactive' || item.headerKind === 'sessions';
}

function inspectVisibleSessionListSourceState(
    items: ReadonlyArray<SessionListIndexItem>,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): VisibleSessionListSourceState {
    let hasArchivedSessionItems = false;
    let hasMissingSessionRows = false;
    let hasInactiveSessionsThatNeedFiltering = false;
    let visiblePlaceholderRows = 0;
    let pendingSectionHeader: Extract<SessionListIndexItem, { type: 'header' }> | null = null;
    let pendingGroupHeader: Extract<SessionListIndexItem, { type: 'header' }> | null = null;

    for (const item of items) {
        if (item.type === 'header') {
            if (isPrimarySessionListSectionHeader(item)) {
                pendingSectionHeader = item;
                pendingGroupHeader = null;
            } else {
                pendingGroupHeader = item;
            }
            continue;
        }

        if (item.type !== 'session') {
            continue;
        }

        pendingSectionHeader = null;
        pendingGroupHeader = null;

        const row = resolveSessionRowForItem(item, resolveSessionRow);
        if (!row) {
            hasMissingSessionRows = true;
            visiblePlaceholderRows += 1;
            continue;
        }

        if (row.metadata == null) {
            visiblePlaceholderRows += 1;
        }

        if (!hasArchivedSessionItems && row.archivedAt != null) {
            hasArchivedSessionItems = true;
        }

        if (
            !hasInactiveSessionsThatNeedFiltering
            && item.section !== 'active'
            && row.active !== true
            && row.keepVisibleWhenInactive !== true
        ) {
            hasInactiveSessionsThatNeedFiltering = true;
        }
    }

    return {
        hasArchivedSessionItems,
        hasMissingSessionRows,
        hasInactiveSessionsThatNeedFiltering,
        hasOrphanHeaders: pendingSectionHeader != null || pendingGroupHeader != null,
        visiblePlaceholderRows,
    };
}

function countOrderedGroups(orderByGroupKey: Readonly<Record<string, ReadonlyArray<string> | undefined>> | undefined): number {
    if (!orderByGroupKey) return 0;
    return Object.values(orderByGroupKey).filter((keys) => Array.isArray(keys) && keys.length > 0).length;
}

function countPinnedSessionKeys(keys: ReadonlyArray<string> | undefined): number {
    return (keys ?? []).filter((key) => typeof key === 'string' && key.trim().length > 0).length;
}

function buildCanonicalSessionKeyAliases(
    source: ReadonlyArray<SessionListIndexItem>,
): ReadonlyMap<string, string> {
    const aliases = new Map<string, string>();
    const ambiguousLegacyAliases = new Set<string>();
    for (const item of source) {
        if (item.type !== 'session') continue;
        const parts = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts);
        if (!parts.sessionKey) continue;
        aliases.set(parts.sessionKey, parts.sessionKey);

        // Account settings historically persisted this delimiter-based shape.
        // Resolve it only against the current qualified corpus so an ambiguous
        // legacy key cannot alias either of two delimiter-bearing addresses.
        const legacyKey = `${parts.serverId}:${parts.sessionId}`;
        const existing = aliases.get(legacyKey);
        if (existing && existing !== parts.sessionKey) {
            aliases.delete(legacyKey);
            ambiguousLegacyAliases.add(legacyKey);
        } else if (!ambiguousLegacyAliases.has(legacyKey)) {
            aliases.set(legacyKey, parts.sessionKey);
        }
    }
    return aliases;
}

function canonicalizeSessionKeyReferences(
    keys: ReadonlyArray<string> | ReadonlySet<string> | null | undefined,
    aliases: ReadonlyMap<string, string>,
): ReadonlyArray<string> {
    const source = keys ? Array.from(keys) : undefined;
    return normalizeTrimmedStringArrayWithSharedEmpty(source).map((key) => aliases.get(key) ?? key);
}

function canonicalizeSessionListGroupOrder(
    orderByGroupKey: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
    aliases: ReadonlyMap<string, string>,
): Readonly<Record<string, ReadonlyArray<string> | undefined>> {
    return Object.fromEntries(Object.entries(orderByGroupKey).map(([groupKey, keys]) => [
        groupKey,
        keys
            ? normalizeTrimmedStringArrayWithSharedEmpty(keys)
                .filter((key) => !isSessionListFolderOrderItemKey(key))
                .map((key) => aliases.get(key) ?? key)
            : keys,
    ]));
}

function countVisiblePlaceholderRows(params: Readonly<{
    result: ReadonlyArray<SessionListIndexItem>;
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'];
}>): number {
    let count = 0;
    for (const item of params.result) {
        if (item.type !== 'session') continue;
        const row = resolveSessionRowForItem(item, params.resolveSessionRow);
        if (!row || row.metadata == null) {
            count += 1;
        }
    }
    return count;
}

function countSessionItems(items: ReadonlyArray<SessionListIndexItem>): number {
    let count = 0;
    for (const item of items) {
        if (item.type === 'session') {
            count += 1;
        }
    }
    return count;
}

function hasNonCustomEffectiveSessionOrdering(
    source: ReadonlyArray<SessionListIndexItem>,
    orderingMode: SessionListOrderingModeV1,
): boolean {
    for (const item of source) {
        if (item.type !== 'session') continue;
        if (resolveEffectiveOrderingModeForSessionItem(item, orderingMode) !== 'custom') {
            return true;
        }
    }
    return false;
}

function nowMs(): number {
    const perf = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
    if (typeof perf?.now === 'function') {
        return perf.now();
    }
    return Date.now();
}

type SessionIndexItem = Extract<SessionListIndexItem, { type: 'session' }>;

function resolveEffectiveOrderingModeForSessionItem(
    item: SessionIndexItem,
    orderingMode: SessionListOrderingModeV1,
): SessionListOrderingModeV1 {
    return resolveEffectiveSessionListOrderingModeForGroup({
        groupKind: item.groupKind,
        userOrderingMode: orderingMode,
    });
}

function resolveSessionOrderingScopeKey(item: SessionIndexItem): string | null {
    const groupKey = normalizeTrimmedString(item.groupKey);
    if (!groupKey) return null;
    return groupKey;
}

function buildOrderingKeyCache(
    sessions: ReadonlyArray<SessionIndexItem>,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): Map<SessionIndexItem, SessionListSessionOrderingKey> {
    const cache = new Map<SessionIndexItem, SessionListSessionOrderingKey>();
    for (const item of sessions) {
        cache.set(item, buildSessionListSessionOrderingKey({
            item,
            row: resolveSessionRowForItem(item, resolveSessionRow),
        }));
    }
    return cache;
}

function compareSessionItemsByOrderingKey(
    a: SessionIndexItem,
    b: SessionIndexItem,
    orderingMode: SessionListOrderingModeV1,
    keyCache: ReadonlyMap<SessionIndexItem, SessionListSessionOrderingKey>,
): number {
    const keyA = keyCache.get(a);
    const keyB = keyCache.get(b);
    if (!keyA || !keyB) return 0;
    return compareSessionListSessionOrderingKeys(keyA, keyB, orderingMode);
}

function isSessionListIndexItemsAlreadyOrderedByOrderingMode(
    source: ReadonlyArray<SessionListIndexItem>,
    orderingMode: SessionListOrderingModeV1,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): boolean {
    const lastSessionByScopeKey = new Map<string, SessionIndexItem>();
    const keyCache = new Map<SessionIndexItem, SessionListSessionOrderingKey>();

    for (const item of source) {
        if (item.type !== 'session') continue;

        const scopeKey = resolveSessionOrderingScopeKey(item);
        if (!scopeKey) continue;
        const effectiveMode = resolveEffectiveOrderingModeForSessionItem(item, orderingMode);
        if (effectiveMode === 'custom') continue;
        keyCache.set(item, buildSessionListSessionOrderingKey({
            item,
            row: resolveSessionRowForItem(item, resolveSessionRow),
        }));

        const previous = lastSessionByScopeKey.get(scopeKey);
        if (previous && compareSessionItemsByOrderingKey(previous, item, effectiveMode, keyCache) > 0) {
            return false;
        }

        lastSessionByScopeKey.set(scopeKey, item);
    }

    return lastSessionByScopeKey.size > 0;
}

function sortSessionListIndexItemsByOrderingMode(
    source: ReadonlyArray<SessionListIndexItem>,
    orderingMode: SessionListOrderingModeV1,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): SessionListIndexItem[] {
    if (isSessionListIndexItemsAlreadyOrderedByOrderingMode(source, orderingMode, resolveSessionRow)) {
        return source as SessionListIndexItem[];
    }

    const sessionsByScopeKey = new Map<string, SessionIndexItem[]>();
    const effectiveModeByScopeKey = new Map<string, SessionListOrderingModeV1>();
    for (const item of source) {
        if (item.type !== 'session') continue;
        const scopeKey = resolveSessionOrderingScopeKey(item);
        if (!scopeKey) continue;
        const effectiveMode = resolveEffectiveOrderingModeForSessionItem(item, orderingMode);
        if (effectiveMode === 'custom') continue;
        if (!sessionsByScopeKey.has(scopeKey)) {
            sessionsByScopeKey.set(scopeKey, []);
            effectiveModeByScopeKey.set(scopeKey, effectiveMode);
        }
        sessionsByScopeKey.get(scopeKey)!.push(item);
    }

    const sortedByScopeKey = new Map<string, SessionIndexItem[]>();
    for (const [scopeKey, sessions] of sessionsByScopeKey.entries()) {
        if (sessions.length < 2) continue;
        const effectiveMode = effectiveModeByScopeKey.get(scopeKey) ?? orderingMode;
        const keyCache = buildOrderingKeyCache(sessions, resolveSessionRow);
        const next = [...sessions].sort((a, b) => compareSessionItemsByOrderingKey(a, b, effectiveMode, keyCache));
        sortedByScopeKey.set(scopeKey, next);
    }

    if (sortedByScopeKey.size === 0) {
        return source as SessionListIndexItem[];
    }

    const indicesByScopeKey = new Map<string, number>();
    const out: SessionListIndexItem[] = [];
    let didChange = false;
    for (const item of source) {
        if (item.type !== 'session') {
            out.push(item);
            continue;
        }
        const scopeKey = resolveSessionOrderingScopeKey(item);
        if (!scopeKey) {
            out.push(item);
            continue;
        }
        const replacementList = sortedByScopeKey.get(scopeKey);
        if (!replacementList) {
            out.push(item);
            continue;
        }
        const index = indicesByScopeKey.get(scopeKey) ?? 0;
        const replacement = replacementList[index] ?? item;
        if (replacement !== item) {
            didChange = true;
        }
        out.push(replacement);
        indicesByScopeKey.set(scopeKey, index + 1);
    }

    return didChange ? out : (source as SessionListIndexItem[]);
}

function reorderSessionItemsByKeys(
    items: ReadonlyArray<Extract<SessionListIndexItem, { type: 'session' }>>,
    keys: ReadonlyArray<string> | undefined,
): Array<Extract<SessionListIndexItem, { type: 'session' }>> {
    if (!keys || keys.length === 0 || items.length < 2) {
        return [...items];
    }

    const byKey = new Map<string, Extract<SessionListIndexItem, { type: 'session' }>>();
    for (const item of items) {
        const k = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
        if (k) {
            byKey.set(k, item);
        }
    }

    const out: Array<Extract<SessionListIndexItem, { type: 'session' }>> = [];
    const used = new Set<Extract<SessionListIndexItem, { type: 'session' }>>();

    for (const key of keys) {
        const normalized = typeof key === 'string' ? key.trim() : '';
        if (!normalized) continue;
        const found = byKey.get(normalized);
        if (found && !used.has(found)) {
            out.push(found);
            used.add(found);
        }
    }

    const unordered = items.filter((item) => !used.has(item));
    return [...unordered, ...out];
}

function reorderPinnedSessionItemsByStructuralKeys(
    items: ReadonlyArray<SessionIndexItem>,
    structuralKeys: ReadonlyArray<string> | undefined,
    fallbackKeys: ReadonlyArray<string> | undefined,
): SessionIndexItem[] {
    if (items.length < 2) {
        return [...items];
    }

    const byKey = new Map<string, SessionIndexItem>();
    for (const item of items) {
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
        if (key) {
            byKey.set(key, item);
        }
    }

    const out: SessionIndexItem[] = [];
    const used = new Set<SessionIndexItem>();
    const appendKnownKeys = (keys: ReadonlyArray<string> | undefined) => {
        for (const key of keys ?? []) {
            const normalized = normalizeTrimmedString(key);
            if (!normalized) continue;
            const found = byKey.get(normalized);
            if (found && !used.has(found)) {
                out.push(found);
                used.add(found);
            }
        }
    };

    appendKnownKeys(structuralKeys);
    appendKnownKeys(fallbackKeys);

    const remaining = items
        .filter((item) => !used.has(item))
        .sort((a, b) => {
            const keyA = normalizeSessionListKeyParts(a.serverId, a.sessionId, a.keyParts).sessionKey || a.sessionId;
            const keyB = normalizeSessionListKeyParts(b.serverId, b.sessionId, b.keyParts).sessionKey || b.sessionId;
            return keyA.localeCompare(keyB);
        });
    return [...out, ...remaining];
}

function orderPinnedSessionItems(params: Readonly<{
    items: ReadonlyArray<SessionIndexItem>;
    structuralKeys: ReadonlyArray<string> | undefined;
    fallbackKeys: ReadonlyArray<string> | undefined;
    orderingMode: SessionListOrderingModeV1;
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'];
}>): SessionIndexItem[] {
    if (params.orderingMode === 'custom') {
        return reorderPinnedSessionItemsByStructuralKeys(
            params.items,
            params.structuralKeys,
            params.fallbackKeys,
        );
    }

    return sortSessionListIndexItemsByOrderingMode(
        params.items,
        params.orderingMode,
        params.resolveSessionRow,
    ) as SessionIndexItem[];
}

function isManualSessionOrderSupported(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
): boolean {
    return resolveEffectiveOrderingModeForSessionItem(item, 'custom') === 'custom';
}

function applySessionOnlyGroupOrdering(
    source: ReadonlyArray<SessionListIndexItem>,
    orderByGroupKey: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
): SessionListIndexItem[] {
    const sessionsByScope = new Map<string, {
        groupKey: string;
        items: Array<Extract<SessionListIndexItem, { type: 'session' }>>;
    }>();

    for (const item of source) {
        if (item.type !== 'session') continue;
        if (!isManualSessionOrderSupported(item)) continue;
        const groupKey = typeof item.groupKey === 'string' ? item.groupKey : '';
        if (!groupKey) continue;
        const scopeKey = resolveSessionOrderingScopeKey(item);
        if (!scopeKey) continue;
        if (!sessionsByScope.has(scopeKey)) {
            sessionsByScope.set(scopeKey, { groupKey, items: [] });
        }
        sessionsByScope.get(scopeKey)!.items.push(item);
    }

    const reorderedByScope = new Map<string, Array<Extract<SessionListIndexItem, { type: 'session' }>>>();
    for (const [scopeKey, { groupKey, items }] of sessionsByScope.entries()) {
        const keys = orderByGroupKey[groupKey];
        if (!keys || keys.length === 0) continue;
        reorderedByScope.set(scopeKey, reorderSessionItemsByKeys(items, keys));
    }

    if (reorderedByScope.size === 0) {
        return source as SessionListIndexItem[];
    }

    const indicesByScope = new Map<string, number>();
    const out: SessionListIndexItem[] = [];
    let didChange = false;
    for (const item of source) {
        if (item.type !== 'session') {
            out.push(item);
            continue;
        }
        const scopeKey = resolveSessionOrderingScopeKey(item);
        if (!scopeKey) {
            out.push(item);
            continue;
        }
        const replacementList = reorderedByScope.get(scopeKey);
        if (!replacementList) {
            out.push(item);
            continue;
        }
        const index = indicesByScope.get(scopeKey) ?? 0;
        const replacement = replacementList[index] ?? item;
        if (replacement !== item) {
            didChange = true;
        }
        out.push(replacement);
        indicesByScope.set(scopeKey, index + 1);
    }

    return didChange ? out : (source as SessionListIndexItem[]);
}

type VisibleSessionListHeaderState = {
    pendingServerHeader: Extract<SessionListIndexItem, { type: 'header' }> | null;
    pendingSectionHeader: Extract<SessionListIndexItem, { type: 'header' }> | null;
    pendingGroupHeaders: Array<Extract<SessionListIndexItem, { type: 'header' }>>;
};

function createVisibleSessionListHeaderState(): VisibleSessionListHeaderState {
    return {
        pendingServerHeader: null,
        pendingSectionHeader: null,
        pendingGroupHeaders: [],
    };
}

function pendingHeadersContainFolder(headers: ReadonlyArray<Extract<SessionListIndexItem, { type: 'header' }>>): boolean {
    return headers.some((item) => item.headerKind === 'folder');
}

function flushPendingFolderHeaders(params: Readonly<{
    out: SessionListIndexItem[];
    headerState: VisibleSessionListHeaderState;
    keepEmptyFolders?: boolean;
}>): boolean {
    if (params.keepEmptyFolders === false || !pendingHeadersContainFolder(params.headerState.pendingGroupHeaders)) return false;
    if (params.headerState.pendingServerHeader) {
        params.out.push(params.headerState.pendingServerHeader);
        params.headerState.pendingServerHeader = null;
    }
    if (params.headerState.pendingSectionHeader) {
        params.out.push(params.headerState.pendingSectionHeader);
    }
    params.out.push(...params.headerState.pendingGroupHeaders);
    params.headerState.pendingSectionHeader = null;
    params.headerState.pendingGroupHeaders = [];
    return true;
}

/**
 * Drops headers with nothing under them. Account Section headers retain their assignment/count context
 * even when members are off-window or displayed under a lead, except in a Runs-only projection.
 */
export function pruneOrphanHeaders(
    items: ReadonlyArray<SessionListIndexItem>,
    options: Readonly<{ keepEmptyFolders?: boolean }> = {},
): SessionListIndexItem[] {
    const out: SessionListIndexItem[] = [];
    const headerState = createVisibleSessionListHeaderState();
    const keepEmptyFolders = options.keepEmptyFolders;

    for (const item of items) {
        if (item.type === 'header') {
            // The single-section "Sessions" label would sit over Runs it does not hold.
            if (keepEmptyFolders === false && item.headerKind === 'sessions') continue;
            flushPendingFolderHeaders({ out, headerState, keepEmptyFolders });
            if (item.headerKind === 'server') {
                headerState.pendingServerHeader = item;
                headerState.pendingSectionHeader = null;
                headerState.pendingGroupHeaders = [];
                continue;
            }
            // Flat shortcut/pin bands cannot own a following group's rows. A
            // final Top suppression may have removed their last base occurrence.
            headerState.pendingGroupHeaders = headerState.pendingGroupHeaders.filter(pending => (
                pending.headerKind !== 'pinned' && pending.headerKind !== 'attention' && pending.headerKind !== 'working'
            ));
            if (isPrimarySessionListSectionHeader(item)) {
                headerState.pendingSectionHeader = item;
                headerState.pendingGroupHeaders = [];
            } else {
                // Only a folder can extend a pending ancestor's context. Peer
                // Project/date bands followed by another band own no rows.
                if (keepEmptyFolders === false || item.headerKind !== 'folder') headerState.pendingGroupHeaders = [];
                headerState.pendingGroupHeaders.push(item);
            }
            continue;
        }
        if (headerState.pendingServerHeader) {
            out.push(headerState.pendingServerHeader);
            headerState.pendingServerHeader = null;
        }
        if (headerState.pendingSectionHeader) {
            out.push(headerState.pendingSectionHeader);
            headerState.pendingSectionHeader = null;
        }
        if (headerState.pendingGroupHeaders.length > 0) {
            out.push(...headerState.pendingGroupHeaders);
            headerState.pendingGroupHeaders = [];
        }
        out.push(item);
    }

    flushPendingFolderHeaders({ out, headerState, keepEmptyFolders });
    return out;
}

function filterHideInactiveSessions(
    items: ReadonlyArray<SessionListIndexItem>,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
    serverFilteredInactiveServerIds?: ReadonlySet<string> | null,
): SessionListIndexItem[] {
    // Activity chooses rows, while the single header owner retains their Home,
    // primary band and genuine empty Account Sections.
    return pruneOrphanHeaders(items.filter(item => {
        if (item.type === 'header') return item.headerKind !== 'inactive';
        if (item.type !== 'session') return false;
        const row = resolveSessionRowForItem(item, resolveSessionRow);
        const isActive = item.section === 'active' || row?.active === true;
        const keepVisible = item.keepVisibleWhenInactive === true || row?.keepVisibleWhenInactive === true;
        const serverFiltered = item.serverId
            ? serverFilteredInactiveServerIds?.has(item.serverId) === true
            : false;
        return isActive || keepVisible || serverFiltered || row?.origin?.kind === 'run_step';
    }));
}

function applyPinnedSessionListIndexFlags(params: Readonly<{
    ordered: ReadonlyArray<SessionListIndexItem>;
    pinnedSessionKeys: ReadonlyArray<string>;
    trackMissingPinnedSessionKeys: boolean;
}>): Readonly<{
    ordered: SessionListIndexItem[];
    missingPinnedSessionKeys: number;
}> {
    if (params.pinnedSessionKeys.length === 0 || params.ordered.length === 0) {
        return {
            ordered: params.ordered as SessionListIndexItem[],
            missingPinnedSessionKeys: params.trackMissingPinnedSessionKeys ? params.pinnedSessionKeys.length : 0,
        };
    }

    const pinnedSet = new Set(params.pinnedSessionKeys);
    const missingPinnedSet = params.trackMissingPinnedSessionKeys
        ? new Set(params.pinnedSessionKeys)
        : null;
    let changed = false;
    const next = params.ordered.map((item) => {
        if (item.type !== 'session') return item;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
        if (!key || !pinnedSet.has(key)) return item;
        missingPinnedSet?.delete(key);
        if (item.pinned === true && item.variant === 'default') return item;
        changed = true;
        return {
            ...item,
            pinned: true,
            variant: 'default' as const,
        };
    });

    return {
        ordered: changed ? next : params.ordered as SessionListIndexItem[],
        missingPinnedSessionKeys: missingPinnedSet?.size ?? 0,
    };
}

function buildPinnedSessionListIndexItems(params: Readonly<{
    ordered: ReadonlyArray<SessionListIndexItem>;
    pinnedSessionKeys: ReadonlyArray<string>;
}>): Readonly<{
    pinnedSessions: Array<Extract<SessionListIndexItem, { type: 'session' }>>;
    remainder: SessionListIndexItem[];
}> {
    const pinnedSet = new Set(params.pinnedSessionKeys);
    const pinnedSessions: Array<Extract<SessionListIndexItem, { type: 'session' }>> = [];
    const remainder: SessionListIndexItem[] = [];

    for (const item of params.ordered) {
        if (item.type !== 'session') {
            remainder.push(item);
            continue;
        }
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
        if (key && pinnedSet.has(key)) {
            pinnedSessions.push({
                ...item,
                pinned: true,
                groupKey: PINNED_GROUP_KEY_V1,
                groupKind: 'pinned',
                variant: 'default',
                attentionPlacementReason: undefined,
                workingPlacementReason: undefined,
            });
            continue;
        }
        remainder.push(item);
    }

    return { pinnedSessions, remainder };
}

type VisibleSessionListProjectionTelemetry = Readonly<{
    missingPinnedSessionKeys: number;
    visiblePlaceholderRows: number;
}>;

type VisibleSessionListTelemetrySink = {
    projectionTelemetry?: VisibleSessionListProjectionTelemetry;
};

function recordSourceProjectionTelemetry(
    telemetrySink: VisibleSessionListTelemetrySink | undefined,
    visiblePlaceholderRows: number,
): void {
    if (!telemetrySink) return;
    telemetrySink.projectionTelemetry = {
        missingPinnedSessionKeys: 0,
        visiblePlaceholderRows,
    };
}

type VisibleSessionListGlobalPlacementPlan = Readonly<{
    attentionPlacement: Readonly<{ attentionItems: SessionListIndexItem[] }> | null;
    workingPlacement: Readonly<{ workingItems: SessionListIndexItem[] }> | null;
    remainder: SessionListIndexItem[];
}>;

function buildVisibleSessionListGlobalPlacementPlan(params: Readonly<{
    ordered: ReadonlyArray<SessionListIndexItem>;
    options: ComputeVisibleSessionListIndexParams;
    nowMs: number;
}>): VisibleSessionListGlobalPlacementPlan {
    const globalAttentionSource = pruneOrphanHeaders(params.ordered);
    const globalPlacements = buildSessionListGlobalPlacements({
        source: globalAttentionSource,
        // Top base suppression follows final filtering and parent-work nesting.
        placement: params.options.sessionListAttentionPlacementV1 === 'inPlace' ? 'inPlace' : 'both',
        previousPresentedIndex: params.options.previousPresentedIndex,
        holdMembership: params.options.attentionInteractionHeld,
        supplementalNeedsYouSessionKeys: params.options.supplementalNeedsYouSessionKeys,
        backgroundWorkAttentionMode: params.options.backgroundWorkAttentionMode,
        attentionOptions: { ...params.options.attentionPlacement, mode: 'global' },
        workingOptions: { ...params.options.workingPlacement, mode: 'global' },
        resolveSessionRow: params.options.resolveSessionRow,
        nowMs: params.nowMs,
    });
    const attentionPlacement = globalPlacements && globalPlacements.attentionPromotedCount > 0
        ? { attentionItems: globalPlacements.attentionItems }
        : null;
    const workingPlacement = globalPlacements && globalPlacements.workingPromotedCount > 0
        ? { workingItems: globalPlacements.workingItems }
        : null;

    return {
        attentionPlacement,
        workingPlacement,
        remainder: globalPlacements
            ? pruneOrphanHeaders(globalPlacements.remainder)
            : globalAttentionSource,
    };
}

function computeVisibleSessionListIndexUnmeasured(
    params: ComputeVisibleSessionListIndexParams,
    telemetrySink?: VisibleSessionListTelemetrySink,
): SessionListIndexItem[] | null {
    const inputSource = params.source;
    if (!inputSource) return null;

    const layoutChoice = params.sessionListLayoutChoice ?? 'projects';
    const source = projectSessionListIndexForLayout({
        source: inputSource,
        choice: layoutChoice,
        resolveSessionRow: params.resolveSessionRow,
        nowMs: params.nowMs,
    });
    const sessionKeyAliases = buildCanonicalSessionKeyAliases(source);
    const pinnedSessionKeys = canonicalizeSessionKeyReferences(params.pinnedSessionKeysV1, sessionKeyAliases);
    const sessionListGroupOrderV1 = canonicalizeSessionListGroupOrder(
        params.sessionListGroupOrderV1 ?? {},
        sessionKeyAliases,
    );
    const effectiveParams: ComputeVisibleSessionListIndexParams = {
        ...params,
        pinnedSessionKeysV1: pinnedSessionKeys,
        sessionListGroupOrderV1,
        attentionPlacement: params.attentionPlacement
            ? {
                ...params.attentionPlacement,
                includeArchived: (params.corpusStorage ?? 'active') === 'archived',
            }
            : undefined,
        workingPlacement: params.workingPlacement
            ? {
                ...params.workingPlacement,
                retainSessionKeys: canonicalizeSessionKeyReferences(
                    params.workingPlacement.retainSessionKeys,
                    sessionKeyAliases,
                ),
            }
            : undefined,
    };

    const sessionListOrderingModeV1 = layoutChoice === 'recent_activity' ? 'updated' : 'custom';
    const presentationEnabled = params.presentation.enabled === true;
    const attentionPlacementEnabled = params.sessionListAttentionPlacementV1 !== 'inPlace';
    const workingPlacementEnabled = attentionPlacementEnabled;
    const placementNowMs = params.nowMs ?? Date.now();
    const corpusStorage = params.corpusStorage ?? 'active';
    const hideInactiveSessions = corpusStorage === 'active' && params.hideInactiveSessions;
    const noOrderingOverrides = !Object.values(sessionListGroupOrderV1).some(
        (keys) => Array.isArray(keys) && keys.length > 0,
    ) && !Object.values(params.sessionWorkspaceOrderV1 ?? {}).some(
        (keys) => Array.isArray(keys) && keys.length > 0,
    );
    const sourceState = inspectVisibleSessionListSourceState(source, params.resolveSessionRow);
    const hasNonCustomSessionOrdering = hasNonCustomEffectiveSessionOrdering(source, sessionListOrderingModeV1);

    if (
        sessionListOrderingModeV1 === 'custom'
        && corpusStorage === 'active'
        && !hideInactiveSessions
        && pinnedSessionKeys.length === 0
        && !attentionPlacementEnabled
        && !workingPlacementEnabled
        && !presentationEnabled
        && noOrderingOverrides
        && !sourceState.hasArchivedSessionItems
        && !sourceState.hasMissingSessionRows
        && !sourceState.hasOrphanHeaders
        && !hasNonCustomSessionOrdering
    ) {
        recordSourceProjectionTelemetry(telemetrySink, sourceState.visiblePlaceholderRows);
        return source as SessionListIndexItem[];
    }

    const orderedByGroup = sessionListOrderingModeV1 === 'custom'
        ? applySessionOnlyGroupOrdering(source, sessionListGroupOrderV1)
        : source;
    if (
        sessionListOrderingModeV1 === 'custom'
        && orderedByGroup === source
        && corpusStorage === 'active'
        && !hideInactiveSessions
        && pinnedSessionKeys.length === 0
        && !attentionPlacementEnabled
        && !workingPlacementEnabled
        && !presentationEnabled
        && !sourceState.hasArchivedSessionItems
        && !sourceState.hasMissingSessionRows
        && !sourceState.hasOrphanHeaders
        && !hasNonCustomSessionOrdering
    ) {
        recordSourceProjectionTelemetry(telemetrySink, sourceState.visiblePlaceholderRows);
        return source as SessionListIndexItem[];
    }

    const ordered = sortSessionListIndexItemsByOrderingMode(
        orderedByGroup,
        sessionListOrderingModeV1,
        params.resolveSessionRow,
    );
    if (
        sessionListOrderingModeV1 !== 'custom'
        && ordered === source
        && corpusStorage === 'active'
        && !hideInactiveSessions
        && pinnedSessionKeys.length === 0
        && !attentionPlacementEnabled
        && !workingPlacementEnabled
        && !presentationEnabled
        && !sourceState.hasArchivedSessionItems
        && !sourceState.hasMissingSessionRows
        && !sourceState.hasOrphanHeaders
    ) {
        recordSourceProjectionTelemetry(telemetrySink, sourceState.visiblePlaceholderRows);
        return source as SessionListIndexItem[];
    }

    if (
        sessionListOrderingModeV1 === 'custom'
        && corpusStorage === 'active'
        && hideInactiveSessions
        && pinnedSessionKeys.length === 0
        && !attentionPlacementEnabled
        && !workingPlacementEnabled
        && !presentationEnabled
        && noOrderingOverrides
        && !sourceState.hasArchivedSessionItems
        && !sourceState.hasMissingSessionRows
        && !sourceState.hasOrphanHeaders
        && !sourceState.hasInactiveSessionsThatNeedFiltering
        && !hasNonCustomSessionOrdering
    ) {
        recordSourceProjectionTelemetry(telemetrySink, sourceState.visiblePlaceholderRows);
        return source as SessionListIndexItem[];
    }

    const orderedForCorpus = ordered.filter((item) => {
        if (!item || item.type !== 'session') return true;
        const row = resolveSessionRowForItem(item, params.resolveSessionRow);
        if (!row) {
            return layoutChoice === 'recent_activity' && item.groupKind === 'loading';
        }
        return sessionListRowMatchesCorpus(row, corpusStorage);
    });

    const {
        ordered: orderedWithPinnedFlags,
        missingPinnedSessionKeys,
    } = applyPinnedSessionListIndexFlags({
        ordered: orderedForCorpus,
        pinnedSessionKeys,
        trackMissingPinnedSessionKeys: telemetrySink != null,
    });

    const globalPlacement = buildVisibleSessionListGlobalPlacementPlan({
        // Native Runs are appended below. Nest only at the final combined owner:
        // a Session-only fold would discard their still-unresolved step children.
        ordered: orderedWithPinnedFlags,
        options: effectiveParams,
        nowMs: placementNowMs,
    });
    const { attentionPlacement, workingPlacement } = globalPlacement;

    const { pinnedSessions, remainder: nonPinnedRemainder } = buildPinnedSessionListIndexItems({
        ordered: globalPlacement.remainder,
        pinnedSessionKeys,
    });

    const pinnedHeader: Extract<SessionListIndexItem, { type: 'header' }> | null =
        pinnedSessions.length > 0
            ? { type: 'header', title: t('projects.groups.pinned'), headerKind: 'pinned', groupKey: PINNED_GROUP_KEY_V1 }
            : null;

    const pinnedOrdered = orderPinnedSessionItems({
        items: pinnedSessions,
        structuralKeys: sessionListGroupOrderV1[PINNED_GROUP_KEY_V1],
        fallbackKeys: pinnedSessionKeys,
        orderingMode: sessionListOrderingModeV1,
        resolveSessionRow: params.resolveSessionRow,
    });

    const remainderAfterAttentionPruned = pruneOrphanHeaders(nonPinnedRemainder);
    const remainderFiltered = hideInactiveSessions
        ? filterHideInactiveSessions(
            remainderAfterAttentionPruned,
            params.resolveSessionRow,
            params.serverFilteredInactiveServerIds,
        )
        : remainderAfterAttentionPruned;

    const remainderPresented = applySessionListIndexPresentation(remainderFiltered, {
        enabled: params.presentation.enabled,
        presentation: resolveSessionListLayoutPresentation(layoutChoice, params.presentation.presentation),
        selectedServerIds: params.presentation.selectedServerIds,
    });

    // Placed rows left the remainder before it was filtered, so the same
    // hide-inactive filter has to run over the placed band too. Every earned
    // attention reason stamps `keepVisibleWhenInactive` and passes through
    // untouched; only a row standing purely by the account default is hidden
    // here, like any other inactive row.
    const attentionItems = attentionPlacement
        ? (hideInactiveSessions
            ? filterHideInactiveSessions(
                attentionPlacement.attentionItems,
                params.resolveSessionRow,
                params.serverFilteredInactiveServerIds,
            )
            : attentionPlacement.attentionItems)
        : [];

    const result = [
        ...attentionItems,
        ...(workingPlacement ? workingPlacement.workingItems : []),
        ...(pinnedHeader ? [pinnedHeader, ...pinnedOrdered] : []),
        ...remainderPresented,
    ];
    if (telemetrySink) {
        telemetrySink.projectionTelemetry = {
            missingPinnedSessionKeys,
            visiblePlaceholderRows: countVisiblePlaceholderRows({
                result,
                resolveSessionRow: params.resolveSessionRow,
            }),
        };
    }
    return result;
}

/**
 * One row resolution per Session per compute: the placement passes and the `manager` nesting pass
 * read the same rows, so they share one lookup instead of each resolving the row again.
 */
function resolveEachSessionRowOnce(
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): ComputeVisibleSessionListIndexParams['resolveSessionRow'] {
    const rows = new Map<string, SessionListRenderableSession | null>();
    return (serverId, sessionId) => {
        const key = `${serverId ?? ''}\u0000${sessionId}`;
        if (rows.has(key)) return rows.get(key) ?? null;
        const row = resolveSessionRow(serverId, sessionId);
        rows.set(key, row);
        return row;
    };
}

function projectWorkflowRunRows(
    visible: SessionListIndexItem[],
    params: ComputeVisibleSessionListIndexParams,
    membership: SessionListWorkMembershipProjection,
): SessionListIndexItem[] {
    if (!params.workFilter && !params.workflowRuns) {
        const nested = nestSessionListReports(visible, params.resolveSessionRow);
        // A report pulled under its lead can empty its own group's header.
        return nested === visible ? visible : pruneOrphanHeaders(nested);
    }
    const filter = membership.filter;
    const runs = params.corpusStorage === 'archived' || !canSessionListFilterIncludeRunsV1(filter) ? [] : (params.workflowRuns ?? [])
        .filter((run) => membership.runs.get(JSON.stringify([run.serverId, run.summary.id]))?.match === 'match')
;
    const resolveRunProject = membership.projectKeyResolver;
    const projectDisplay = buildProjectGroupDisplayIndex(params.workspaceRefs ?? []);
    const sessionItems = visible.filter((item) => {
        if (item.type !== 'session') return item.type === 'header';
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
        return Boolean(key && params.supplementalNeedsYouSessionKeys?.has(key))
            || sessionListItemMatchesWorkFilter(item, filter, membership);
    });
    const summaryByKey = new Map(runs.map((run) => [JSON.stringify([run.serverId, run.summary.id]), run.summary]));
    const runGroups = new Map<string, WorkflowRunGroup>();
    for (const { serverId, summary } of runs) {
        const section = isTerminalWorkflowRunState(summary.state) ? 'inactive' : 'active';
        const where = summary.where;
        const scope = where ? normalizeSessionFolderWorkspaceRef({
            t: 'workspaceScope', serverId, machineId: where.machineId, rootPath: where.directory,
        }) : null;
        const reference = where?.workspaceRefId ? normalizeSessionFolderWorkspaceRef({
            t: 'workspaceRef', serverId, workspaceRefId: where.workspaceRefId,
        }) : null;
        const census = admitProjectWorkspaceCensusForSubject({
            subject: { kind: 'run', ownerAccountId: summary.ownerAccountId }, rowServerId: serverId,
            censusServerId: params.workspaceRefsServerId,
            viewerAccountId: params.viewerAccountIdByServerId?.get(resolveServerProfileScopeIdForIdentifier(serverId) || serverId),
            workspaceRefs: params.workspaceRefs, sessionProjectKeyResolver: resolveRunProject,
        });
        const resolved = census.sessionProjectKeyResolver?.(where ? {
            ...(where.workspaceRefId ? { workspaceId: where.workspaceRefId } : {}), machineId: where.machineId, path: where.directory,
        } : null, serverId);
        const project = resolved?.kind === 'resolved' ? resolved.projectKey : undefined;
        const groupKey = project ? projectGroupIdentityKey(project) : sessionProjectGroupingIdentityKey(buildSessionProjectGroupingIdentity(
            serverId, resolveSessionProjectGroupingKeyParts(where ? { machineId: where.machineId, path: where.directory } : null),
        ));
        const fallbackIdentity = project ? null : readSessionWorkspaceFallbackIdentity(groupKey);
        const workspace = reference ?? scope;
        const baseline = project ? projectDisplay.get(groupKey)?.baseline : null;
        const row: Extract<SessionListIndexItem, { type: 'workflow_run' }> = {
            type: 'workflow_run', runId: summary.id, serverId, groupKey, groupKind: 'project', section,
            ...(workspace ? { workspace } : {}),
        };
        const group = runGroups.get(groupKey);
        if (group) {
            group.rows.push(row);
            continue;
        }
        runGroups.set(groupKey, { rows: [row], header: { type: 'header', headerKind: 'project', groupKey,
            workspaceKey: fallbackIdentity ? buildSessionWorkspaceFallbackOrderKey(fallbackIdentity) : groupKey, serverId,
            title: project ? projectDisplay.get(groupKey)?.title ?? t('common.loading') : where?.directory ?? t('workflows.title'),
            ...(project ? { projectKey: project } : {}), ...(workspace ? { workspace } : {}),
            ...(project ? { workspaceScopeHint: baseline
                ? { serverId, machineId: baseline.machineId, rootPath: baseline.rootPath } : null }
                : where ? { workspaceScopeHint: { serverId, machineId: where.machineId, rootPath: where.directory } } : {}),
        } });
    }
    const output = mergeWorkflowRunGroups(sessionItems, runGroups);
    // Placement has already assigned these bands through the canonical Session
    // owner. Adding Runs must not reclassify those rows into ordinary sections.
    const placed: SessionListIndexItem[] = [];
    const ordinary: SessionListIndexItem[] = [];
    let inPlacedBand = false;
    for (const item of output) {
        if (item.type === 'header') inPlacedBand = item.headerKind === 'attention'
            || item.headerKind === 'working' || item.headerKind === 'pinned';
        (inPlacedBand ? placed : ordinary).push(item);
    }
    let arranged = output;
    if (params.sessionListLayoutChoice === 'recent_activity') {
        const activity = (item: Exclude<SessionListIndexItem, { type: 'header' }>) => item.type === 'session'
            ? readSessionListMeaningfulActivityAt(params.resolveSessionRow(item.serverId, item.sessionId))
            : Date.parse(summaryByKey.get(JSON.stringify([item.serverId, item.runId]))?.updatedAt ?? '') || 0;
        const loading = ordinary.filter((item) => item.type === 'header'
            ? item.headerKind === 'loading' : item.groupKind === 'loading');
        const work = ordinary.filter((item): item is Exclude<SessionListIndexItem, { type: 'header' }> => item.type !== 'header' && item.groupKind !== 'loading')
            .sort((a, b) => activity(b) - activity(a));
        arranged = [...placed, ...buildSessionListDateGroups({ items: work, readMeaningfulActivityAt: activity, nowMs: params.nowMs })
            .flatMap((group): SessionListIndexItem[] => [{ type: 'header', headerKind: 'date', groupKey: `recent:day:${group.dateKey}`, title: group.title },
                ...group.items.map((item) => ({ ...item, groupKey: `recent:day:${group.dateKey}`, groupKind: 'date' as const }))]), ...loading];
    }
    const nested = nestSessionListReports(arranged, params.resolveSessionRow, (serverId, runId) => {
        const summary = summaryByKey.get(JSON.stringify([serverId, runId]));
        return resolveWorkflowRunParentSessionId(summary);
    });
    return pruneOrphanHeaders(nested, { keepEmptyFolders: filter.show !== 'runs' });
}

function sessionListItemMatchesWorkFilter(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
    filter: SessionListFilterV1,
    membership: SessionListWorkMembershipProjection,
): boolean {
    const entry = membership.sessions.get(JSON.stringify([item.serverId ?? '', item.sessionId]));
    const step = entry?.row?.origin?.kind === 'run_step';
    // A step represents an admitted native Run; only its Run's protected starter
    // is filtered. The nesting owner removes a step when its Run is absent.
    return entry?.match === 'match' && (step ? filter.show !== 'sessions' : filter.show !== 'runs');
}

function admitSupplementalAttention(params: ComputeVisibleSessionListIndexParams,
    membership: SessionListWorkMembershipProjection): ComputeVisibleSessionListIndexParams {
    if (!params.workFilter || (!params.supplementalNeedsYouSessionKeys?.size
        && !(params.attentionInteractionHeld && params.previousPresentedIndex?.length))) return params;
    const ordinaryKeys = new Set<string>();
    const sourceKeys = new Set<string>();
    for (const item of params.source ?? []) {
        if (item.type !== 'session' || !params.resolveSessionRow(item.serverId, item.sessionId)) continue;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
        if (!key) continue;
        sourceKeys.add(key);
        if (sessionListItemMatchesWorkFilter(item, params.workFilter, membership)) ordinaryKeys.add(key);
    }
    const supplementalKeys = new Set<string>();
    for (const key of params.supplementalNeedsYouSessionKeys ?? []) {
        if (sourceKeys.has(key) && !ordinaryKeys.has(key)) supplementalKeys.add(key);
    }
    if (params.attentionInteractionHeld) {
        for (const item of params.previousPresentedIndex ?? []) {
            if (item.type !== 'session' || item.supplementalAttention !== true) continue;
            const key = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
            if (key && sourceKeys.has(key)) supplementalKeys.add(key);
        }
    }
    // Filter before nesting: an outside shortcut cannot bring quiet relatives or
    // lend a Top occurrence a base anchor that is absent from the selected space.
    const source = pruneOrphanHeaders((params.source ?? []).flatMap((item): SessionListIndexItem[] => {
        if (item.type !== 'session') return [item];
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
        if (!key || (!ordinaryKeys.has(key) && !supplementalKeys.has(key))) return [];
        if (supplementalKeys.has(key)) return [item.supplementalAttention ? item : { ...item, supplementalAttention: true }];
        if (!item.supplementalAttention) return [item];
        const { supplementalAttention: _previousSupplement, ...ordinary } = item;
        return [ordinary];
    }));
    return { ...params, source, supplementalNeedsYouSessionKeys: supplementalKeys };
}

function projectVisibleSessionListRows(visible: SessionListIndexItem[], params: ComputeVisibleSessionListIndexParams,
    membership: SessionListWorkMembershipProjection): SessionListIndexItem[] {
    const withRuns = projectWorkflowRunRows(visible, params, membership);
    const projected = (params.sessionListLayoutChoice ?? 'projects') === 'projects'
        ? completeSessionProjectGroupOrder({ source: withRuns, creationSeed: params.source ?? [],
            previousPresentedIndex: params.previousPresentedIndex, savedOrder: params.sessionWorkspaceOrderV1 ?? {} })
        : withRuns;
    if (params.sessionListAttentionPlacementV1 === 'top') {
        const promoted = new Set(projected.flatMap(item => item.type === 'session'
            && (item.occurrenceRole === 'needsYou' || item.occurrenceRole === 'working')
            ? [normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey] : []));
        return pruneOrphanHeaders(projected.filter(item => item.type !== 'session'
            || item.occurrenceRole === 'needsYou' || item.occurrenceRole === 'working'
            || item.reportsParent === true
            || !promoted.has(normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey)));
    }
    return params.sessionListAttentionPlacementV1 === 'inPlace' && params.supplementalNeedsYouSessionKeys?.size
        ? restoreSessionListContextHeaders(reconcileSupplementalSessionListAttention({ source: projected,
            supplementalKeys: params.supplementalNeedsYouSessionKeys,
            previousPresentedIndex: params.previousPresentedIndex,
            holdMembership: params.attentionInteractionHeld === true }), projected)
        : projected;
}

function computeVisibleSessionListIndexWithMembership(
    inputParams: ComputeVisibleSessionListIndexParams,
    membership: SessionListWorkMembershipProjection,
    observeEligibleItems: (items: readonly SessionListIndexItem[]) => void,
): SessionListIndexItem[] | null {
    const source = inputParams.source ?? (inputParams.workflowRuns?.length ? [] : null);
    if (!source) return null;
    const params = admitSupplementalAttention({
        ...inputParams,
        source,
        resolveSessionRow: resolveEachSessionRowOnce(inputParams.resolveSessionRow),
    }, membership);
    if (!syncPerformanceTelemetry.isEnabled()) {
        const visible = computeVisibleSessionListIndexUnmeasured(params);
        observeEligibleItems(visible ?? []);
        return visible ? projectVisibleSessionListRows(visible, params, membership) : visible;
    }

    const startedAtMs = nowMs();
    const telemetrySink: VisibleSessionListTelemetrySink = {};
    const result = computeVisibleSessionListIndexUnmeasured(params, telemetrySink);
    observeEligibleItems(result ?? []);
    const sessionCount = countSessionItems(source);
    const projectionTelemetry = telemetrySink.projectionTelemetry ?? {
        missingPinnedSessionKeys: 0,
        visiblePlaceholderRows: 0,
    };
    syncPerformanceTelemetry.recordDuration(
        'sync.sessions.list.visible.compute',
        nowMs() - startedAtMs,
        {
            items: source.length,
            sessions: sessionCount,
            headers: source.length - sessionCount,
            fastPath: result === source ? 1 : 0,
            hideInactive: params.corpusStorage === 'archived'
                ? 0
                : params.hideInactiveSessions === true ? 1 : 0,
            pins: countPinnedSessionKeys(params.pinnedSessionKeysV1),
            missingPinnedSessionKeys: projectionTelemetry.missingPinnedSessionKeys,
            visiblePlaceholderRows: projectionTelemetry.visiblePlaceholderRows,
            customOrder: countOrderedGroups(params.sessionListGroupOrderV1),
            attentionPlacementEnabled: params.sessionListAttentionPlacementV1 !== 'inPlace' ? 1 : 0,
            attentionPlacementGlobal: params.sessionListAttentionPlacementV1 !== 'inPlace' ? 1 : 0,
            workingPlacementEnabled: params.sessionListAttentionPlacementV1 !== 'inPlace' ? 1 : 0,
            workingPlacementGlobal: params.sessionListAttentionPlacementV1 !== 'inPlace' ? 1 : 0,
            presentationEnabled: params.presentation.enabled === true ? 1 : 0,
            storageFilter: params.storageFilterApplied === true ? 1 : 0,
        },
    );
    return result ? projectVisibleSessionListRows(result, params, membership) : result;
}

/** Membership and distinct result truth accompany the same existing arranged list projection. */
export function computeVisibleSessionListProjection(inputParams: ComputeVisibleSessionListIndexParams): VisibleSessionListProjection {
    let params: ComputeVisibleSessionListIndexParams = { ...inputParams, resolveSessionRow: resolveEachSessionRowOnce(inputParams.resolveSessionRow) };
    let membership = projectWorkMembership(params);
    const conditionValueCountProjection = projectSessionListConditionValueCounts(params, membership);
    membership = { ...membership, conditionValueCountProjection };
    let attentionFactsUnavailable = false;
    const liveSupplementKeys = params.includeNeedsYouEverywhere ? new Set<string>() : undefined;
    if (params.includeNeedsYouEverywhere && membership.filter.show !== 'runs') {
        const keys = new Set(params.supplementalNeedsYouSessionKeys);
        const appended: SessionListIndexItem[] = [];
        const seen = new Set<string>();
        const retained = params.attentionInteractionHeld ? new Set(params.previousPresentedIndex?.flatMap(item => item.type === 'session'
            && item.supplementalAttention ? [normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey] : [])) : undefined;
        for (const item of [...params.source ?? [], ...params.attentionSource ?? []]) {
            if (item.type !== 'session') continue;
            const key = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const entry = membership.sessions.get(JSON.stringify([item.serverId ?? '', item.sessionId]));
            const attention = entry?.status?.attentionType;
            const needsYou = Boolean(attention && inboxItemViewV1(attention) === 'needs_you');
            if (!entry?.row || entry.match === 'match' || (!needsYou && !retained?.has(key))
                || !sessionListRowMatchesCorpus(entry.row, params.corpusStorage)
                || membership.filter.source !== 'all' && entry.sourceKind !== membership.filter.source) continue;
            // The structural query proves its fixed Team audience only for its
            // own corpus. Ordinary compact rows carry no admitted Team census.
            const homeId = resolveServerProfileScopeIdForIdentifier(item.serverId) || item.serverId || '';
            if (params.fixedTeam && (!entry.ordinary || !params.fixedTeamQueryServerIds?.has(homeId))) {
                attentionFactsUnavailable ||= needsYou;
                continue;
            }
            keys.add(key);
            if (needsYou) liveSupplementKeys?.add(key);
            if (!entry.ordinary) appended.push(item);
        }
        params = { ...params, source: appended.length ? [...params.source ?? [], ...appended] : params.source,
            supplementalNeedsYouSessionKeys: keys };
    }
    const matchedEntityIds = new Set<string>();
    let items = computeVisibleSessionListIndexWithMembership(params, membership, eligibleItems => {
        if (membership.filter.show === 'runs') return;
        for (const item of eligibleItems) {
            if (item.type !== 'session') continue;
            const entry = membership.sessions.get(JSON.stringify([item.serverId ?? '', item.sessionId]));
            if (entry?.ordinary && entry.match === 'match' && entry.row?.origin?.kind !== 'run_step') matchedEntityIds.add(buildSessionListIndexEntityId(item));
        }
    });
    const attentionSupplementEntityIds = new Set<string>();
    if (params.supplementalNeedsYouSessionKeys?.size) {
        for (const item of params.source ?? []) {
            if (item.type !== 'session') continue;
            const key = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
            if (!key || !params.supplementalNeedsYouSessionKeys.has(key)) continue;
            if (liveSupplementKeys && !liveSupplementKeys.has(key)) continue;
            const entry = membership.sessions.get(JSON.stringify([item.serverId ?? '', item.sessionId]));
            if (entry?.row && entry.match !== 'match') attentionSupplementEntityIds.add(buildSessionListIndexEntityId(item));
        }
    }
    let unavailable = attentionFactsUnavailable;
    for (const entry of membership.sessions.values()) {
        if (!entry.ordinary) continue;
        if (membership.filter.show === 'runs' || entry.row?.origin?.kind === 'run_step') continue;
        if (entry.match === 'unavailable') unavailable = true;
    }
    if (params.corpusStorage !== 'archived' && canSessionListFilterIncludeRunsV1(membership.filter)) {
        for (const entry of membership.runs.values()) {
            if (entry.match === 'unavailable') unavailable = true;
            if (entry.match === 'match') {
                matchedEntityIds.add(buildSessionListIndexEntityId({ type: 'workflow_run', serverId: entry.serverId, runId: entry.summary.id }));
            }
        }
    }
    const matchedCount = matchedEntityIds.size;
    if (items) {
        const previous = params.previousMembership;
        const changedSubjectKeys = new Set<string>();
        const derivedSubjects = new Map<string, SessionListGroupSubject>();
        const deriveSubject = (item: Exclude<SessionListIndexItem, { type: 'header' }>): SessionListGroupSubject => {
            const key = buildSessionListIndexEntityId(item);
            const derived = derivedSubjects.get(key);
            if (derived) return derived;
            const membershipKey = JSON.stringify([item.serverId ?? '', item.type === 'session' ? item.sessionId : item.runId]);
            const entry = item.type === 'session' ? membership.sessions.get(membershipKey) : membership.runs.get(membershipKey);
            const oldEntry = item.type === 'session' ? previous?.sessions.get(membershipKey) : previous?.runs.get(membershipKey);
            const oldSubject = previous?.groupSubjects?.get(key);
            const unchanged = oldEntry?.viewerAccountId === entry?.viewerAccountId && previous?.nowMs === membership.nowMs
                && (item.type === 'session'
                    ? previous?.sessions.get(membershipKey)?.row === membership.sessions.get(membershipKey)?.row
                    : previous?.runs.get(membershipKey)?.summary === membership.runs.get(membershipKey)?.summary);
            let subject: SessionListGroupSubject;
            if (unchanged && oldSubject) subject = oldSubject;
            else if (item.type === 'session') {
                const row = membership.sessions.get(membershipKey)?.row;
                if (!row) subject = { status: null, coverage: 'unavailable' };
                else {
                    const facts = readSessionWorkStatusFacts(row, membership.nowMs);
                    subject = { status: membership.sessions.get(membershipKey)?.status ?? resolveWorkStatusTone({ kind: 'session', facts }),
                        coverage: isSessionAwarenessContentReadableV1(facts.awareness.encryption ?? 'unknown') ? 'complete' : 'unavailable' };
                }
            } else {
                const summary = membership.runs.get(membershipKey)?.summary;
                subject = summary ? { status: resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(summary) }), coverage: 'complete' }
                    : { status: null, coverage: 'unavailable' };
            }
            derivedSubjects.set(key, subject);
            if (subject !== oldSubject) changedSubjectKeys.add(key);
            return subject;
        };
        // Admission follows the final arranged rows, including retained attention and
        // project/date ordering. Reuse payload facts, never infer grouping from inputs.
        for (const item of items) {
            if (item.type !== 'header') deriveSubject(item);
        }
        const groupRollups = projectSessionListIndexGroupRollups({ items, subjects: derivedSubjects, changedSubjectKeys: [...changedSubjectKeys],
            previous: previous?.groupRollups,
            coverage: params.groupCoverage === 'unavailable' ? 'unavailable'
                : unavailable ? matchedCount > 0 ? 'partial' : 'unavailable' : params.groupCoverage });
        items = groupRollups.items;
        membership = { ...membership, groupSubjects: derivedSubjects, groupRollups };
    }
    return { items, membership, conditionValueCounts: conditionValueCountProjection?.result, matchedEntityIds, attentionSupplementEntityIds, filterResult: { matchedCount, attentionSupplementCount: attentionSupplementEntityIds.size,
        coverage: unavailable ? matchedCount > 0 ? 'partial' : 'unavailable' : items === null ? 'unavailable' : 'complete' } };
}

export function computeVisibleSessionListIndex(inputParams: ComputeVisibleSessionListIndexParams): SessionListIndexItem[] | null {
    return computeVisibleSessionListProjection(inputParams).items;
}

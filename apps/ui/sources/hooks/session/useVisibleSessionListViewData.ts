import * as React from 'react';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { SessionListViewItem, useLocalSetting, useOpenApprovalSessionIds, useSessionListViewData, useSessionListViewDataByServerId, useSessionOrganizationProjection, useSetting } from '@/sync/domains/state/storage';
import { buildSessionListShellViewItemSignature } from '@/sync/store/hooks';
import { resolveNextSessionRuntimePresentationFreshnessAtMs } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import { resolveSessionListSourceData } from '@/sync/domains/session/listing/sessionListPresentation';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { isSessionListWorkingPlacementReason } from '@/sync/domains/session/listing/placement/sessionListPlacementProjection';
import { buildSessionListIndexFromViewData } from '@/sync/domains/session/listing/sessionListIndex';
import { buildSessionListViewDataFromIndex } from '@/sync/domains/session/listing/sessionListViewDataFromIndex';
import { applySessionFoldersToSessionListViewData } from '@/sync/domains/session/listing/sessionListViewData';
import {
    normalizeSessionListGroupOrderV1ForSource,
    normalizeSessionListGroupOrderV1ForStructuralSource,
} from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import {
    normalizeSessionWorkspaceOrderV1ForSource,
    type SessionWorkspaceOrderV1,
} from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';
import { filterSessionListViewDataByStorageKind } from '@/sync/domains/session/listing/filterSessionListViewDataByStorageKind';
import {
    normalizeSessionListWorkingPlacementMode,
    type SessionListAttentionPromotionMode,
    type SessionListAttentionPromotionOptions,
    type SessionListRetainedAttentionPlacement,
    type SessionListWorkingPlacementMode,
    type SessionListWorkingPlacementOptions,
} from '@/sync/domains/session/listing/attentionPromotion/sessionListAttentionPromotion';
import {
    normalizeSessionListFolderSortModeV1,
    type SessionListFolderSortModeV1,
} from '@/sync/domains/session/listing/sessionListFolderSortMode';
import {
    normalizeSessionListOrderingSectionMode,
    normalizeSessionListOrderingModeV1,
    type SessionListOrderingSectionMode,
    type SessionListOrderingModeV1,
} from '@/sync/domains/session/listing/sessionListOrderingRules';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { normalizeSessionFolders } from '@/sync/domains/session/folders';
import type { SessionAttentionStandingPolicy } from '@/sync/domains/session/organization/attentionStanding';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { fetchAndApplySessionFolderAssignments } from '@/sync/ops/sessionOrganization';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useSessionAttentionStandingInputs } from './useSessionAttentionStandingInputs';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from './sessionListRuntimeClock';

const EMPTY_SESSION_LIST_GROUP_ORDER: Readonly<Record<string, ReadonlyArray<string> | undefined>> = Object.freeze({});
const EMPTY_SESSION_WORKSPACE_ORDER: SessionWorkspaceOrderV1 = Object.freeze({});
const DISABLED_ATTENTION_PROMOTION_OPTIONS: SessionListAttentionPromotionOptions = Object.freeze({
    mode: 'off',
});
const DISABLED_WORKING_PLACEMENT_OPTIONS: SessionListWorkingPlacementOptions = Object.freeze({
    mode: 'off',
});
const EMPTY_RETAINED_ATTENTION_PLACEMENTS: ReadonlyArray<SessionListRetainedAttentionPlacement> = Object.freeze([]);
const EMPTY_WORKING_RETAIN_KEYS: ReadonlyArray<string> = Object.freeze([]);
const EMPTY_SELECTED_SESSION_LIST_SERVER_IDS: ReadonlyArray<string> = Object.freeze([]);
const EMPTY_OPEN_APPROVAL_SESSION_ID_SET: ReadonlySet<string> = Object.freeze(new Set<string>());

export type VisibleSessionListViewDataOptions = Readonly<{
    activeSessionId?: string | null;
    retainedSessionListViewData?: ReadonlyArray<SessionListViewItem> | null;
    sessionListSurfaceDataActive?: boolean;
}>;

type SessionListDataState = Readonly<{
    hideInactiveSessions: boolean;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionAttentionStandingPolicy: SessionAttentionStandingPolicy;
    sessionListAttentionPromotionMode: SessionListAttentionPromotionMode;
    sessionListWorkingPlacementMode: SessionListWorkingPlacementMode;
    sessionListFolderSortModeV1: SessionListFolderSortModeV1;
    sessionListOrderingModeV1: SessionListOrderingModeV1;
    sessionListSectionModeV1: SessionListOrderingSectionMode;
    selection: Readonly<{
        enabled: boolean;
        activeServerId: string;
        allowedServerIds: ReadonlyArray<string>;
        presentation: ReturnType<typeof useResolvedActiveServerSelection>['presentation'];
    }>;
    source: SessionListViewItem[] | null;
    normalizedGroupOrder: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    normalizedWorkspaceOrder: SessionWorkspaceOrderV1;
    folderSource: SessionListViewItem[] | null;
    sessionFoldersEnabled: boolean;
}>;

function collectVisibleSessionIdsByServer(items: ReadonlyArray<SessionListViewItem> | null): Record<string, string[]> {
    const idsByServer: Record<string, string[]> = {};
    if (!items) return idsByServer;
    for (const item of items) {
        if (item.type !== 'session') continue;
        const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
        const sessionId = typeof item.session?.id === 'string' ? item.session.id.trim() : '';
        if (!serverId || !sessionId) continue;
        const bucket = idsByServer[serverId] ?? [];
        if (!bucket.includes(sessionId)) bucket.push(sessionId);
        idsByServer[serverId] = bucket;
    }
    return idsByServer;
}

function applySessionListStorageFilter(
    data: SessionListViewItem[] | null,
    storageFilter: SessionListStorageFilter,
): SessionListViewItem[] | null {
    if (!data || storageFilter === 'all') return data;
    return filterSessionListViewDataByStorageKind(data, storageFilter);
}

function applyOpenApprovalFlagsToSessionListSource(
    data: SessionListViewItem[] | null,
    sessionIdsWithOpenApprovals: ReadonlySet<string>,
): SessionListViewItem[] | null {
    if (!data || sessionIdsWithOpenApprovals.size === 0) return data;

    let next: SessionListViewItem[] | null = null;
    for (let index = 0; index < data.length; index += 1) {
        const item = data[index];
        const sessionKey = item.type === 'session'
            ? buildSessionListSessionKey(item)
            : null;
        const hasOpenApproval = item.type === 'session' && (
            (sessionKey != null && sessionIdsWithOpenApprovals.has(sessionKey))
            || sessionIdsWithOpenApprovals.has(item.session.id)
        );
        if (!hasOpenApproval) {
            if (next) next.push(item);
            continue;
        }

        const nextItem = item.session.hasPendingPermissionRequests === true
            ? item
            : {
                ...item,
                session: {
                    ...item.session,
                    hasPendingPermissionRequests: true,
                },
            };
        if (!next) next = data.slice(0, index);
        next.push(nextItem);
    }

    return next ?? data;
}

function buildSessionRowResolver(source: ReadonlyArray<SessionListViewItem>) {
    const byKey = new Map<string, Extract<SessionListViewItem, { type: 'session' }>['session']>();
    for (const item of source) {
        if (item.type !== 'session') continue;
        const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
        const sessionId = typeof item.session?.id === 'string' ? item.session.id.trim() : '';
        if (!serverId || !sessionId) continue;
        byKey.set(`${serverId}:${sessionId}`, item.session);
    }
    return (serverIdRaw: string | null | undefined, sessionIdRaw: string) => {
        const serverId = typeof serverIdRaw === 'string' ? serverIdRaw.trim() : '';
        const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
        if (!serverId || !sessionId) return null;
        return byKey.get(`${serverId}:${sessionId}`) ?? null;
    };
}

function buildVisibleSessionListIndexForState(
    state: SessionListDataState,
    storageFilter: SessionListStorageFilter,
    hideInactiveSessions: boolean,
    options: Readonly<{
        retainedAttentionPlacements?: ReadonlyArray<SessionListRetainedAttentionPlacement>;
        retainWorkingSessionKeys?: ReadonlyArray<string>;
        nowMs?: number;
    }> = {},
): Readonly<{
    sourceIndex: NonNullable<ReturnType<typeof buildSessionListIndexFromViewData>>;
    visibleIndex: NonNullable<ReturnType<typeof computeVisibleSessionListIndex>>;
}> | null {
    if (!state.folderSource) return null;

    const maybeSourceIndex = buildSessionListIndexFromViewData(state.folderSource);
    if (maybeSourceIndex === null) return null;
    const sourceIndex: NonNullable<ReturnType<typeof buildSessionListIndexFromViewData>> = maybeSourceIndex;

    const maybeVisibleIndex = computeVisibleSessionListIndex({
        source: sourceIndex,
        resolveSessionRow: buildSessionRowResolver(state.folderSource),
        hideInactiveSessions,
        pinnedSessionKeysV1: state.pinnedSessionKeysV1,
        sessionListGroupOrderV1: state.normalizedGroupOrder,
        sessionWorkspaceOrderV1: state.normalizedWorkspaceOrder,
        normalizedOrganizationProjection: {
            pinnedSessionKeys: state.pinnedSessionKeysV1,
            sessionListGroupOrder: state.normalizedGroupOrder,
            sessionWorkspaceOrder: state.normalizedWorkspaceOrder,
        },
        sessionListFolderSortModeV1: state.sessionListFolderSortModeV1,
        sessionListOrderingModeV1: state.sessionListOrderingModeV1,
        sessionListSectionModeV1: state.sessionListSectionModeV1,
        presentation: {
            enabled: state.selection.enabled,
            presentation: state.selection.presentation,
            selectedServerIds: state.selection.allowedServerIds,
        },
        storageFilterApplied: storageFilter !== 'all',
        attentionPromotion: state.sessionListAttentionPromotionMode !== 'off'
            ? {
                mode: state.sessionListAttentionPromotionMode,
                retainedPlacements: options.retainedAttentionPlacements,
                standingPolicy: state.sessionAttentionStandingPolicy,
            }
            : DISABLED_ATTENTION_PROMOTION_OPTIONS,
        workingPlacement: state.sessionListWorkingPlacementMode !== 'off'
            ? {
                mode: state.sessionListWorkingPlacementMode,
            }
            : DISABLED_WORKING_PLACEMENT_OPTIONS,
        retainWorkingSessionKeys: options.retainWorkingSessionKeys,
        nowMs: options.nowMs,
    });
    if (maybeVisibleIndex === null) return null;
    const visibleIndex: NonNullable<ReturnType<typeof computeVisibleSessionListIndex>> = maybeVisibleIndex;

    return { sourceIndex, visibleIndex };
}

function buildVisibleSessionListViewData(
    state: SessionListDataState,
    storageFilter: SessionListStorageFilter,
    hideInactiveSessions: boolean,
    options: Readonly<{
        retainedAttentionPlacements?: ReadonlyArray<SessionListRetainedAttentionPlacement>;
        retainWorkingSessionKeys?: ReadonlyArray<string>;
        nowMs?: number;
        previousVisible?: ReadonlyArray<SessionListViewItem> | null;
    }> = {},
): SessionListViewItem[] | null {
    if (!state.folderSource) return state.folderSource;

    const indexResult = buildVisibleSessionListIndexForState(state, storageFilter, hideInactiveSessions, options);
    if (!indexResult) return null;

    return buildSessionListViewDataFromIndex({
        index: indexResult.visibleIndex,
        source: state.folderSource,
        sourceIndex: indexResult.sourceIndex,
        previous: options.previousVisible,
    });
}

function buildSessionListSessionKey(item: Extract<SessionListViewItem, { type: 'session' }>): string | null {
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
    const sessionId = typeof item.session?.id === 'string' ? item.session.id.trim() : '';
    if (!serverId || !sessionId) return null;
    return `${serverId}:${sessionId}`;
}

function collectRetainedAttentionPlacements(params: Readonly<{
    previousVisible: ReadonlyArray<SessionListViewItem> | null | undefined;
    activeSessionId: string | null | undefined;
    mode: SessionListAttentionPromotionMode;
}>): ReadonlyArray<SessionListRetainedAttentionPlacement> {
    if (params.mode === 'off') return EMPTY_RETAINED_ATTENTION_PLACEMENTS;
    const activeSessionId = typeof params.activeSessionId === 'string' ? params.activeSessionId.trim() : '';
    if (!activeSessionId || !params.previousVisible) return EMPTY_RETAINED_ATTENTION_PLACEMENTS;
    for (const item of params.previousVisible) {
        if (item.type !== 'session') continue;
        if (item.groupKind !== 'attention' && !item.attentionPromotionReason) continue;
        // Standing is the user's own instruction, so removing it must take
        // effect immediately. Retention exists to stop a row the user is
        // READING from sliding away under them; retaining a standing row would
        // instead pin it in the band until they navigate elsewhere.
        if (item.attentionPromotionReason === 'standing') continue;
        if (item.session.id !== activeSessionId) continue;
        const key = buildSessionListSessionKey(item);
        const reason = item.attentionPromotionReason;
        return key && reason
            ? [{ key, reason }]
            : EMPTY_RETAINED_ATTENTION_PLACEMENTS;
    }
    return EMPTY_RETAINED_ATTENTION_PLACEMENTS;
}

function collectRetainedWorkingSessionKeys(params: Readonly<{
    previousVisible: ReadonlyArray<SessionListViewItem> | null | undefined;
    mode: SessionListWorkingPlacementMode;
}>): ReadonlyArray<string> {
    if (params.mode === 'off' || !params.previousVisible) return EMPTY_WORKING_RETAIN_KEYS;
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const item of params.previousVisible) {
        if (item.type !== 'session') continue;
        if (item.groupKind !== 'working' && !isSessionListWorkingPlacementReason(item.workingPlacementReason)) continue;
        const key = buildSessionListSessionKey(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
    }
    return keys.length > 0 ? keys : EMPTY_WORKING_RETAIN_KEYS;
}

function resolveNextVisibleSessionListRuntimeFreshnessAtMs(
    source: ReadonlyArray<SessionListViewItem> | null,
    nowMs: number,
): number | null {
    let nextAt: number | null = null;
    for (const item of source ?? []) {
        if (item.type !== 'session') continue;
        const freshnessAt = resolveNextSessionRuntimePresentationFreshnessAtMs(item.session, nowMs);
        if (freshnessAt === null) continue;
        nextAt = nextAt === null ? freshnessAt : Math.min(nextAt, freshnessAt);
    }
    return nextAt;
}

function useVisibleSessionListRuntimeNowMs(
    source: ReadonlyArray<SessionListViewItem> | null,
    enabled: boolean,
): number {
    // Shared session-list runtime clock: group placement and per-row working
    // indicators must derive freshness from the same timestamp in the same
    // render cycle, so this hook subscribes to the canonical clock and only
    // contributes its own wake horizon (earliest freshness expiry in view).
    // Inactive surfaces neither subscribe nor schedule wakes; their data is
    // frozen downstream, so ticking them would only churn renders.
    const runtimeNowMs = useSessionListRuntimeNowMs(enabled);
    const nextFreshnessAtMs = React.useMemo(
        () => (enabled ? resolveNextVisibleSessionListRuntimeFreshnessAtMs(source, runtimeNowMs) : null),
        [enabled, source, runtimeNowMs],
    );
    useSessionListRuntimeWake(nextFreshnessAtMs, enabled);
    return runtimeNowMs;
}

type VisibleSessionListComputation = Readonly<{
    visible: SessionListViewItem[] | null;
    buildWithHiddenFilter: (hideInactiveSessions: boolean) => SessionListViewItem[] | null;
}>;

/**
 * Single owner of the visible session-list computation shared by
 * `useVisibleSessionListViewData`, `useVisibleSessionListPaneState`, and
 * `useHasHiddenInactiveSessions`: previous-render retention seeding,
 * retained attention/working key collection, clock-timed placement build,
 * and stable-row reuse. Keeping one implementation guarantees every list
 * surface derives placement from the same shared runtime clock.
 */
function useVisibleSessionListComputation(
    state: SessionListDataState,
    storageFilter: SessionListStorageFilter,
    options: VisibleSessionListViewDataOptions,
): VisibleSessionListComputation {
    const surfaceDataActive = options.sessionListSurfaceDataActive !== false;
    const runtimeNowMs = useVisibleSessionListRuntimeNowMs(state.folderSource, surfaceDataActive);
    const previousVisibleRef = React.useRef<SessionListViewItem[] | null>(null);

    const computation = React.useMemo<VisibleSessionListComputation>(() => {
        const previousVisible = resolvePreviousVisibleSessionListForRetention(
            previousVisibleRef.current,
            options.retainedSessionListViewData,
        );
        const retainedAttentionPlacements = collectRetainedAttentionPlacements({
            previousVisible,
            activeSessionId: options.activeSessionId,
            mode: state.sessionListAttentionPromotionMode,
        });
        const retainWorkingSessionKeys = collectRetainedWorkingSessionKeys({
            previousVisible,
            mode: state.sessionListWorkingPlacementMode,
        });
        const buildWithHiddenFilter = (hideInactiveSessions: boolean) =>
            buildVisibleSessionListViewData(state, storageFilter, hideInactiveSessions, {
                retainedAttentionPlacements,
                retainWorkingSessionKeys,
                nowMs: runtimeNowMs,
                previousVisible,
            });
        return {
            visible: reuseStableVisibleSessionListRows(
                previousVisible,
                buildWithHiddenFilter(state.hideInactiveSessions),
            ),
            buildWithHiddenFilter,
        };
    }, [options.activeSessionId, options.retainedSessionListViewData, runtimeNowMs, state, storageFilter]);

    React.useEffect(() => {
        previousVisibleRef.current = computation.visible;
    }, [computation.visible]);

    return computation;
}

function countRenderedSessions(data: SessionListViewItem[] | null): number {
    if (!data) return 0;
    return data.reduce((count, item) => count + (item.type === 'session' ? 1 : 0), 0);
}

function resolvePreviousVisibleSessionListForRetention(
    previousVisible: SessionListViewItem[] | null,
    retainedVisible: ReadonlyArray<SessionListViewItem> | null | undefined,
): ReadonlyArray<SessionListViewItem> | null {
    return previousVisible ?? retainedVisible ?? null;
}

export function countVisibleSessionListSessions(data: SessionListViewItem[] | null): number {
    return countRenderedSessions(data);
}

export type VisibleSessionListSessionSummary = Readonly<{
    sessionsReady: boolean;
    visibleSessionCount: number;
}>;

function countVisibleSessionListSummaryItems(
    source: SessionListViewItem[] | null,
    hideInactiveSessions: boolean,
): VisibleSessionListSessionSummary {
    if (!source) {
        return { sessionsReady: false, visibleSessionCount: 0 };
    }

    let visibleSessionCount = 0;
    for (const item of source) {
        if (item.type !== 'session') continue;
        if (item.session.archivedAt != null) continue;
        const isActive = item.section === 'active' || item.session.active === true;
        if (hideInactiveSessions && !isActive && item.session.keepVisibleWhenInactive !== true) continue;
        visibleSessionCount += 1;
    }
    return { sessionsReady: true, visibleSessionCount };
}

function areVisibleSessionListRowsEquivalent(
    previousItem: SessionListViewItem | undefined,
    nextItem: SessionListViewItem,
): boolean {
    if (previousItem === nextItem) return true;
    if (!previousItem || previousItem.type !== nextItem.type) return false;
    return buildSessionListShellViewItemSignature(previousItem) === buildSessionListShellViewItemSignature(nextItem);
}

/**
 * Value-equivalence backstop for rows the build could not preserve by identity.
 *
 * `buildSessionListViewDataFromIndex` owns identity for rows whose index item and source
 * row are unchanged, which covers every row a normal push leaves alone; this pass only
 * has to catch the narrower case where a row was rebuilt around a *different but equal*
 * session object (a full source refresh), which identity cannot see. Rows the build
 * already reused short-circuit on the first `previousItem === nextItem` comparison, so
 * the signature scan runs for genuinely changed rows only.
 */
function reuseStableVisibleSessionListRows(
    previousVisible: ReadonlyArray<SessionListViewItem> | null | undefined,
    nextVisible: SessionListViewItem[] | null,
): SessionListViewItem[] | null {
    if (previousVisible === nextVisible) {
        return nextVisible;
    }
    if (!previousVisible || !nextVisible || previousVisible.length !== nextVisible.length) {
        return nextVisible;
    }

    const previousIndex = buildSessionListIndexFromViewData(previousVisible);
    const nextIndex = buildSessionListIndexFromViewData(nextVisible, previousIndex);
    if (!previousIndex || !nextIndex || previousIndex.length !== nextIndex.length) {
        return nextVisible;
    }

    let reusedAllRows = true;
    let reusedAnyRow = false;
    const out = nextVisible.map((nextItem, index) => {
        const previousItem = previousVisible[index];
        const canReuseIndex = previousIndex[index] != null && previousIndex[index] === nextIndex[index];
        const canReuseItem = canReuseIndex && areVisibleSessionListRowsEquivalent(previousItem, nextItem);
        if (canReuseItem && previousItem) {
            reusedAnyRow = true;
            return previousItem;
        }
        reusedAllRows = false;
        return nextItem;
    });

    if (reusedAllRows) return previousVisible as SessionListViewItem[];
    return reusedAnyRow ? out : nextVisible;
}

function useSessionListDataState(
    storageFilter: SessionListStorageFilter,
    options: Pick<VisibleSessionListViewDataOptions, 'sessionListSurfaceDataActive'> = {},
): SessionListDataState {
    const sessionListSurfaceDataActive = options.sessionListSurfaceDataActive !== false;
    const activeData = useSessionListViewData();
    const openApprovalSessionIdList = useOpenApprovalSessionIds();
    const hideInactiveSessions = useSetting('hideInactiveSessions') === true;
    const sessionListWorkingPlacementMode = normalizeSessionListWorkingPlacementMode(useSetting('sessionListWorkingPlacementModeV1'));
    const sessionListFolderSortModeV1 = normalizeSessionListFolderSortModeV1(useLocalSetting('sessionListFolderSortModeV1'));
    const sessionListOrderingModeV1 = normalizeSessionListOrderingModeV1(useSetting('sessionListOrderingModeV1'));
    const sessionListSectionModeV1 = normalizeSessionListOrderingSectionMode(useSetting('sessionListSectionModeV1'));
    const sessionFoldersEnabled = useFeatureEnabled('sessions.folders');
    const sessionFolderViewModeV1 = useSetting('sessionFolderViewModeV1');
    const selection = useResolvedActiveServerSelection();
    const organizationProjection = useSessionOrganizationProjection(selection.activeServerId);
    const organizationListViewState = React.useMemo(() => buildSessionOrganizationListViewState({
        serverId: selection.activeServerId,
        projection: organizationProjection,
    }), [organizationProjection, selection.activeServerId]);
    const pinnedSessionKeysV1 = organizationListViewState.pinnedSessionKeysV1;
    const attentionStanding = useSessionAttentionStandingInputs(
        organizationListViewState.attentionStandingOverridesBySessionKey,
    );
    const sessionAttentionStandingPolicy = attentionStanding.policy;
    const sessionListAttentionPromotionMode = attentionStanding.promotionMode;
    const sessionFoldersV1 = organizationListViewState.sessionFoldersV1;
    const sessionFolderAssignmentsBySessionKey = organizationListViewState.sessionFolderAssignmentsBySessionKey;
    const groupOrder = organizationListViewState.sessionListGroupOrderV1 ?? EMPTY_SESSION_LIST_GROUP_ORDER;
    const workspaceOrder = organizationListViewState.sessionWorkspaceOrderV1 ?? EMPTY_SESSION_WORKSPACE_ORDER;
    const selectedServerIdsKey = React.useMemo(() => selection.allowedServerIds.join('\u0000'), [selection.allowedServerIds]);
    const selectedServerIdsForCache = selection.enabled
        ? selection.allowedServerIds
        : EMPTY_SELECTED_SESSION_LIST_SERVER_IDS;
    const dataByServerId = useSessionListViewDataByServerId(selectedServerIdsForCache);

    const source = React.useMemo(() => {
        return resolveSessionListSourceData({
            enabled: selection.enabled,
            activeServerId: selection.activeServerId,
            activeData,
            byServerId: dataByServerId,
            selectedServerIds: selection.allowedServerIds,
        });
    }, [
        activeData,
        dataByServerId,
        selectedServerIdsKey,
        selection.activeServerId,
        selection.enabled,
    ]);

    const storageFilteredSource = React.useMemo(
        () => applySessionListStorageFilter(source, storageFilter),
        [source, storageFilter],
    );

    const normalizedSessionFolders = React.useMemo(
        () => normalizeSessionFolders(sessionFoldersV1 ?? { v: 1, folders: [] }),
        [sessionFoldersV1],
    );
    const sessionFoldersAvailableForStorage = storageFilter !== 'direct';
    const folderTreeSourceActive = sessionFoldersAvailableForStorage
        && sessionFoldersEnabled
        && sessionFolderViewModeV1 === 'tree';

    const folderSource = React.useMemo(() => {
        if (!storageFilteredSource) return storageFilteredSource;
        if (!folderTreeSourceActive) {
            return storageFilteredSource;
        }
        return applySessionFoldersToSessionListViewData(storageFilteredSource, {
            enabled: true,
            folders: normalizedSessionFolders,
            assignmentsBySessionKey: sessionFolderAssignmentsBySessionKey,
        });
    }, [
        folderTreeSourceActive,
        normalizedSessionFolders,
        sessionFolderAssignmentsBySessionKey,
        storageFilteredSource,
    ]);

    const normalizedGroupOrder = React.useMemo(() => {
        if (!folderSource) return groupOrder;
        if (sessionListOrderingModeV1 !== 'custom' && !folderTreeSourceActive) {
            return groupOrder;
        }
        const normalizeGroupOrder = sessionListOrderingModeV1 === 'custom'
            ? normalizeSessionListGroupOrderV1ForSource
            : normalizeSessionListGroupOrderV1ForStructuralSource;
        return normalizeGroupOrder({
            source: folderSource,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1: groupOrder,
        });
    }, [folderSource, folderTreeSourceActive, groupOrder, pinnedSessionKeysV1, sessionListOrderingModeV1]);

    const normalizedWorkspaceOrder = React.useMemo(() => {
        if (!folderSource) return workspaceOrder;
        return normalizeSessionWorkspaceOrderV1ForSource({
            source: folderSource,
            sessionWorkspaceOrderV1: workspaceOrder,
        });
    }, [folderSource, workspaceOrder]);

    const openApprovalSessionIds = React.useMemo(() => (
        openApprovalSessionIdList.length === 0
            ? EMPTY_OPEN_APPROVAL_SESSION_ID_SET
            : new Set(openApprovalSessionIdList)
    ), [openApprovalSessionIdList]);
    const attentionSource = React.useMemo(
        () => applyOpenApprovalFlagsToSessionListSource(folderSource, openApprovalSessionIds),
        [folderSource, openApprovalSessionIds],
    );

    const assignmentFetchBatches = React.useMemo(
        () => sessionFoldersAvailableForStorage && sessionFoldersEnabled && sessionFolderViewModeV1 === 'tree'
            ? collectVisibleSessionIdsByServer(storageFilteredSource)
            : {},
        [sessionFolderViewModeV1, sessionFoldersAvailableForStorage, sessionFoldersEnabled, storageFilteredSource],
    );

    React.useEffect(() => {
        if (!sessionListSurfaceDataActive) return;
        if (!sessionFoldersEnabled || sessionFolderViewModeV1 !== 'tree') return;
        let cancelled = false;
        for (const [serverId, sessionIds] of Object.entries(assignmentFetchBatches)) {
            if (sessionIds.length === 0) continue;
            const profile = getServerProfileById(serverId);
            if (!profile) continue;
            void (async () => {
                const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id });
                if (!credentials || cancelled) return;
                await fetchAndApplySessionFolderAssignments({
                    credentials,
                    serverId: profile.id,
                    serverUrl: profile.serverUrl,
                    sessionIds,
                    fetchPolicy: 'missing',
                    shouldContinue: () => !cancelled,
                });
            })().catch(() => undefined);
        }
        return () => {
            cancelled = true;
        };
    }, [assignmentFetchBatches, sessionFolderViewModeV1, sessionFoldersEnabled, sessionListSurfaceDataActive]);

    return React.useMemo(() => ({
        hideInactiveSessions,
        pinnedSessionKeysV1,
        sessionAttentionStandingPolicy,
        sessionListAttentionPromotionMode,
        sessionListWorkingPlacementMode,
        sessionListFolderSortModeV1,
        sessionListOrderingModeV1,
        sessionListSectionModeV1,
        selection: {
            enabled: selection.enabled,
            activeServerId: selection.activeServerId,
            allowedServerIds: selection.allowedServerIds,
            presentation: selection.presentation,
        },
        source,
        folderSource: attentionSource,
        normalizedGroupOrder,
        normalizedWorkspaceOrder,
        sessionFoldersEnabled,
    }), [
        attentionSource,
        folderSource,
        hideInactiveSessions,
        normalizedGroupOrder,
        normalizedWorkspaceOrder,
        pinnedSessionKeysV1,
        sessionAttentionStandingPolicy,
        sessionListAttentionPromotionMode,
        sessionListWorkingPlacementMode,
        sessionListFolderSortModeV1,
        sessionListOrderingModeV1,
        sessionListSectionModeV1,
        sessionFoldersEnabled,
        selectedServerIdsKey,
        selection.activeServerId,
        selection.enabled,
        selection.presentation,
        source,
    ]);
}

export function useVisibleSessionListSessionSummary(
    storageFilter: SessionListStorageFilter = 'all',
    _options: Pick<VisibleSessionListViewDataOptions, 'sessionListSurfaceDataActive'> = {},
): VisibleSessionListSessionSummary {
    const activeData = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions') === true;
    const selection = useResolvedActiveServerSelection();
    const selectedServerIdsKey = React.useMemo(() => selection.allowedServerIds.join('\u0000'), [selection.allowedServerIds]);
    const selectedServerIdsForCache = selection.enabled
        ? selection.allowedServerIds
        : EMPTY_SELECTED_SESSION_LIST_SERVER_IDS;
    const dataByServerId = useSessionListViewDataByServerId(selectedServerIdsForCache);

    const source = React.useMemo(() => {
        return resolveSessionListSourceData({
            enabled: selection.enabled,
            activeServerId: selection.activeServerId,
            activeData,
            byServerId: dataByServerId,
            selectedServerIds: selection.allowedServerIds,
        });
    }, [
        activeData,
        dataByServerId,
        selectedServerIdsKey,
        selection.activeServerId,
        selection.enabled,
    ]);

    const storageFilteredSource = React.useMemo(
        () => applySessionListStorageFilter(source, storageFilter),
        [source, storageFilter],
    );

    return React.useMemo(
        () => countVisibleSessionListSummaryItems(storageFilteredSource, hideInactiveSessions),
        [hideInactiveSessions, storageFilteredSource],
    );
}

export function useVisibleSessionListViewData(
    storageFilter: SessionListStorageFilter = 'all',
    options: VisibleSessionListViewDataOptions = {},
): SessionListViewItem[] | null {
    const state = useSessionListDataState(storageFilter, options);
    return useVisibleSessionListComputation(state, storageFilter, options).visible;
}

export function useHasHiddenInactiveSessions(
    storageFilter: SessionListStorageFilter = 'all',
    options: VisibleSessionListViewDataOptions = {},
): boolean {
    const state = useSessionListDataState(storageFilter, options);
    const computation = useVisibleSessionListComputation(state, storageFilter, options);

    return React.useMemo(() => {
        if (!state.source || state.hideInactiveSessions !== true) return false;
        const visibleSessionCount = countRenderedSessions(computation.visible);
        if (visibleSessionCount > 0) return false;
        const unhidden = computation.buildWithHiddenFilter(false);
        return countRenderedSessions(unhidden) > visibleSessionCount;
    }, [computation, state.hideInactiveSessions, state.source]);
}

export function useVisibleSessionListPaneState(
    storageFilter: SessionListStorageFilter = 'all',
    options: VisibleSessionListViewDataOptions = {},
): Readonly<{
    sessionListViewData: SessionListViewItem[] | null;
    visibleSessionCount: number;
    hasHiddenInactiveSessions: boolean;
}> {
    const state = useSessionListDataState(storageFilter, options);
    const computation = useVisibleSessionListComputation(state, storageFilter, options);
    const previousPaneStateRef = React.useRef<Readonly<{
        sessionListViewData: SessionListViewItem[] | null;
        visibleSessionCount: number;
        hasHiddenInactiveSessions: boolean;
    }> | null>(null);

    const paneState = React.useMemo(() => {
        const sessionListViewData = computation.visible;
        const visibleSessionCount = countRenderedSessions(sessionListViewData);
        const reusePreviousPaneState = (hasHiddenInactiveSessions: boolean) => {
            const previous = previousPaneStateRef.current;
            if (
                previous
                && previous.sessionListViewData === sessionListViewData
                && previous.visibleSessionCount === visibleSessionCount
                && previous.hasHiddenInactiveSessions === hasHiddenInactiveSessions
            ) {
                return previous;
            }
            return {
                sessionListViewData,
                visibleSessionCount,
                hasHiddenInactiveSessions,
            };
        };

        if (!state.source || state.hideInactiveSessions !== true) {
            return reusePreviousPaneState(false);
        }

        if (visibleSessionCount > 0) {
            return reusePreviousPaneState(false);
        }

        const unhidden = computation.buildWithHiddenFilter(false);
        return reusePreviousPaneState(countRenderedSessions(unhidden) > visibleSessionCount);
    }, [computation, state.hideInactiveSessions, state.source]);

    React.useEffect(() => {
        previousPaneStateRef.current = paneState;
    }, [paneState]);

    return paneState;
}

import * as React from 'react';
import { usePathname } from 'expo-router';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    useLocalSetting,
    useOpenApprovalSessionIds,
    useSessionListRowStateByServerId,
    useSessionOrganizationProjection,
    useSetting,
} from '@/sync/domains/state/storage';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { normalizeSessionListWorkingPlacementMode } from '@/sync/domains/session/listing/sessionListAttentionPlacement';
import {
    isSessionListWorkingPlacementReason,
} from '@/sync/domains/session/listing/sessionListAttentionPlacementTypes';
import { normalizeSessionListKeyParts } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { resolveSelectedSessionIdForList } from '@/sync/domains/session/listing/resolveSelectedSessionIdForList';
import { normalizeSessionListGroupOrderV1ForIndexSource } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import {
    normalizeSessionWorkspaceOrderV1ForSource,
    type SessionWorkspaceOrderV1,
} from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';
import { filterSessionListIndexByStorageKind } from '@/sync/domains/session/listing/filterSessionListIndexByStorageKind';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { areSessionListIndexItemsEqual, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    applySessionFolderTreeToSessionListIndex,
    type SessionFolderFocusScope,
    type FolderAwareSessionListIndexResult,
    type SessionFolderList,
    type SessionListFocusedFolderV1,
} from '@/sync/domains/session/folders';
import type { SessionAttentionStandingPolicy } from '@/sync/domains/session/organization/attentionStanding';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { useSessionAttentionStandingInputs } from './useSessionAttentionStandingInputs';
import { useFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { useVisibleSessionListSourceState } from './useVisibleSessionListSourceState';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionRuntimePresentationFreshnessExpirations } from '@/sync/domains/session/attention/runtimePresentation';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from './sessionListRuntimeClock';
import {
    readExternalAgentObservationPresentationInput,
    resolveExternalAgentPresentationState,
} from '@/components/sessions/presentation/externalSessionRuntimePresentation';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';

type SessionListGroupOrderV1 = Readonly<Record<string, ReadonlyArray<string> | undefined>>;
type PinnedSessionKeysV1 = ReadonlyArray<string>;
const EMPTY_OPEN_APPROVAL_SESSION_ID_SET: ReadonlySet<string> = Object.freeze(new Set<string>());

export type VisibleSessionListViewState = Readonly<{
    visibleSessionListIndex: ReadonlyArray<SessionListIndexItem> | null;
    hasHiddenInactiveSessions: boolean;
    folderFocus: SessionFolderFocusScope | null;
}>;

export type VisibleSessionListViewStateOptions = Readonly<{
    pathname?: string;
    retainedPathname?: string | null;
    retainedVisibleSessionListIndex?: ReadonlyArray<SessionListIndexItem> | null;
    sessionListSurfaceDataActive?: boolean;
}>;

function buildFolderAwareSessionListIndex(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    collapsedGroupKeysV1: Readonly<Record<string, boolean>>;
    sessionFoldersFeatureEnabled: boolean;
    storageFilter: SessionListStorageFilter;
    folderFocusInput: SessionListFocusedFolderV1;
    sessionFoldersV1: SessionFolderList;
    sessionFolderViewModeV1: unknown;
    sessionFolderAssignmentsBySessionKey: Readonly<Record<string, string | null>>;
}>): FolderAwareSessionListIndexResult {
    const folderTreeEnabled = params.sessionFoldersFeatureEnabled
        && params.sessionFolderViewModeV1 === 'tree';
    if (!folderTreeEnabled) {
        return { items: params.source, folderFocus: null };
    }
    return applySessionFolderTreeToSessionListIndex({
        source: params.source,
        folders: params.sessionFoldersV1,
        assignmentsBySessionKey: params.sessionFolderAssignmentsBySessionKey,
        collapsedGroupKeys: params.collapsedGroupKeysV1,
        focusedFolder: params.folderFocusInput,
    });
}

function countSessionItems(index: ReadonlyArray<SessionListIndexItem> | null): number {
    if (!index) return 0;
    let count = 0;
    for (const item of index) {
        if (item.type === 'session') {
            count += 1;
        }
    }
    return count;
}

function reuseStableVisibleSessionListIndex(
    previous: ReadonlyArray<SessionListIndexItem> | null | undefined,
    next: ReadonlyArray<SessionListIndexItem> | null,
): ReadonlyArray<SessionListIndexItem> | null {
    if (!previous || !next || previous.length !== next.length) {
        return next;
    }

    let reusedAllItems = true;
    let reusedAnyItem = false;
    const out = next.map((nextItem, index) => {
        const previousItem = previous[index];
        if (areSessionListIndexItemsEqual(previousItem, nextItem)) {
            reusedAnyItem = true;
            return previousItem;
        }
        reusedAllItems = false;
        return nextItem;
    });

    if (reusedAllItems) {
        return previous;
    }
    return reusedAnyItem ? out : next;
}

function resolvePreviousVisibleSessionListIndexForRetention(
    previousVisibleIndex: ReadonlyArray<SessionListIndexItem> | null,
    retainedVisibleIndex: ReadonlyArray<SessionListIndexItem> | null | undefined,
): ReadonlyArray<SessionListIndexItem> | null {
    return previousVisibleIndex ?? retainedVisibleIndex ?? null;
}

function resolveSessionRowFromState(
    sessionRowStateByServerId: ReturnType<typeof useSessionListRowStateByServerId>,
    serverId: string | null | undefined,
    sessionId: string,
    sessionIdsWithOpenApprovals: ReadonlySet<string>,
) {
    const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedServerId || !normalizedSessionId) {
        return null;
    }
    const row = readSessionListRowForServerId(sessionRowStateByServerId, normalizedServerId, normalizedSessionId);
    const scopedSessionKey = normalizeSessionListKeyParts(normalizedServerId, normalizedSessionId).sessionKey;
    const hasOpenApproval =
        (scopedSessionKey ? sessionIdsWithOpenApprovals.has(scopedSessionKey) : false)
        || sessionIdsWithOpenApprovals.has(normalizedSessionId);
    if (!row || !hasOpenApproval || row.hasPendingPermissionRequests === true) {
        return row;
    }
    return {
        ...row,
        hasPendingPermissionRequests: true,
    };
}

/**
 * Keys only. Retention exists so the row the user is READING cannot slide out
 * of the band under them; the reason that put it there is a live fact about the
 * session, so placement re-derives it rather than replaying the one that has
 * since been resolved.
 */
function resolveRetainedAttentionSessionKeys(params: Readonly<{
    previousVisibleIndex: ReadonlyArray<SessionListIndexItem> | null | undefined;
    activeSessionId: string | null;
}>): ReadonlyArray<string> {
    const activeSessionId = String(params.activeSessionId ?? '').trim();
    if (!activeSessionId) return [];
    if (!params.previousVisibleIndex) return [];
    for (const item of params.previousVisibleIndex) {
        if (item.type !== 'session' || item.sessionId !== activeSessionId) continue;
        if (item.groupKind !== 'attention' && !item.attentionPlacementReason) continue;
        // Standing is the user's own instruction, so removing it must take effect
        // immediately. Retention exists to stop a row the user is READING from
        // sliding away under them; retaining a standing row would instead pin it
        // in the band until they navigate elsewhere.
        if (item.attentionPlacementReason === 'standing') continue;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        return key ? [key] : [];
    }
    return [];
}

function resolveRetainedWorkingSessionKeys(
    previousVisibleIndex: ReadonlyArray<SessionListIndexItem> | null | undefined,
): ReadonlyArray<string> {
    if (!previousVisibleIndex) return [];
    const retainedKeys: string[] = [];
    const seen = new Set<string>();
    for (const item of previousVisibleIndex) {
        if (item.type !== 'session') continue;
        if (item.groupKind !== 'working' && !isSessionListWorkingPlacementReason(item.workingPlacementReason)) continue;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        retainedKeys.push(key);
    }
    return retainedKeys;
}

function buildVisibleSessionListIndex(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    sessionRowStateByServerId: ReturnType<typeof useSessionListRowStateByServerId>;
    hideInactiveSessions: boolean;
    pinnedSessionKeysV1: PinnedSessionKeysV1;
    sessionListOrderingModeV1: 'custom' | 'created' | 'updated';
    sessionListSectionModeV1: 'activity' | 'single';
    sessionListAttentionPromotionModeV1: 'off' | 'global' | 'withinGroups';
    sessionAttentionStandingPolicy: SessionAttentionStandingPolicy;
    sessionListWorkingPlacementModeV1: 'off' | 'global' | 'withinGroups';
    sessionListFolderSortModeV1: 'foldersFirst' | 'mixed';
    activeSessionId: string | null;
    normalizedGroupOrder: SessionListGroupOrderV1;
    sessionListGroupOrderV1: SessionListGroupOrderV1;
    normalizedWorkspaceOrder: SessionWorkspaceOrderV1;
    sessionWorkspaceOrderV1: SessionWorkspaceOrderV1;
    collapsedGroupKeysV1: Readonly<Record<string, boolean>>;
    sessionFoldersFeatureEnabled: boolean;
    selection: ReturnType<typeof useVisibleSessionListSourceState>['selection'];
    storageFilter: SessionListStorageFilter;
    folderFocusInput: SessionListFocusedFolderV1;
    sessionFoldersV1: SessionFolderList;
    sessionFolderViewModeV1: unknown;
    sessionFolderAssignmentsBySessionKey: Readonly<Record<string, string | null>>;
    sessionIdsWithOpenApprovals: ReadonlySet<string>;
    retainAttentionSessionKeys: ReadonlyArray<string>;
    retainWorkingSessionKeys: ReadonlyArray<string>;
    nowMs: number;
}>): ReadonlyArray<SessionListIndexItem> | null {
    const folderAwareSource = buildFolderAwareSessionListIndex(params).items;
    const resolveSessionRow = (
        serverId: string | null | undefined,
        sessionId: string,
    ) => resolveSessionRowFromState(
        params.sessionRowStateByServerId,
        serverId,
        sessionId,
        params.sessionIdsWithOpenApprovals,
    );
    const visible = computeVisibleSessionListIndex({
        source: folderAwareSource,
        resolveSessionRow,
        hideInactiveSessions: params.hideInactiveSessions,
        pinnedSessionKeysV1: params.pinnedSessionKeysV1,
        sessionListGroupOrderV1: params.sessionListOrderingModeV1 === 'custom'
            ? params.normalizedGroupOrder
            : params.sessionListGroupOrderV1,
        sessionWorkspaceOrderV1: params.sessionListOrderingModeV1 === 'custom'
            ? params.normalizedWorkspaceOrder
            : params.sessionWorkspaceOrderV1,
        sessionListOrderingModeV1: params.sessionListOrderingModeV1,
        sessionListSectionModeV1: params.sessionListSectionModeV1,
        sessionListFolderSortModeV1: params.sessionListFolderSortModeV1,
        attentionPlacement: {
            mode: params.sessionListAttentionPromotionModeV1,
            retainSessionKeys: params.retainAttentionSessionKeys,
            standingPolicy: params.sessionAttentionStandingPolicy,
        },
        workingPlacement: {
            mode: params.sessionListWorkingPlacementModeV1,
            retainSessionKeys: params.retainWorkingSessionKeys,
        },
        presentation: {
            enabled: params.selection.enabled,
            presentation: params.selection.presentation,
            selectedServerIds: params.selection.allowedServerIds,
        },
        storageFilterApplied: params.storageFilter !== 'all',
        nowMs: params.nowMs,
    });
    if (!visible || params.storageFilter === 'all') return visible;
    return filterSessionListIndexByStorageKind(visible, params.storageFilter, resolveSessionRow);
}

export function useVisibleSessionListViewState(
    storageFilter: SessionListStorageFilter = 'all',
    options: VisibleSessionListViewStateOptions = {},
): VisibleSessionListViewState {
    const pathname = usePathname();
    const effectivePathname = options.pathname ?? pathname;
    const focusedSessionId = useFocusedSessionId();
    const previousVisibleSessionListIndexRef = React.useRef<ReadonlyArray<SessionListIndexItem> | null>(null);
    const { selection, source } = useVisibleSessionListSourceState();
    const sessionRowStateByServerId = useSessionListRowStateByServerId();
    const openApprovalSessionIdList = useOpenApprovalSessionIds();
    const hideInactiveSessions = useSetting('hideInactiveSessions') as boolean | null;
    const sessionListOrderingModeV1 = useSetting('sessionListOrderingModeV1') as
        | 'custom'
        | 'created'
        | 'updated';
    const sessionListSectionModeV1 = useSetting('sessionListSectionModeV1') === 'single'
        ? 'single'
        : 'activity';
    const sessionListFolderSortModeV1 = useSetting('sessionListFolderSortModeV1') === 'mixed'
        ? 'mixed'
        : 'foldersFirst';
    const sessionListWorkingPlacementModeV1 = normalizeSessionListWorkingPlacementMode(
        useSetting('sessionListWorkingPlacementModeV1'),
    );
    const sessionFolderViewModeV1 = useSetting('sessionFolderViewModeV1');
    const sessionFoldersFeatureEnabled = useFeatureEnabled('sessions.folders');
    const collapsedGroupKeysV1 = (useLocalSetting('collapsedGroupKeysV1') ?? {}) as Readonly<Record<string, boolean>>;
    const folderFocusInput = useLocalSetting('sessionListFocusedFolderV1') as SessionListFocusedFolderV1;
    const activeOrganizationServerId = typeof selection.activeServerId === 'string'
        ? selection.activeServerId.trim()
        : '';
    const organizationProjection = useSessionOrganizationProjection(activeOrganizationServerId);
    const organizationListViewState = React.useMemo(() => buildSessionOrganizationListViewState({
        serverId: activeOrganizationServerId,
        projection: organizationProjection,
    }), [activeOrganizationServerId, organizationProjection]);
    // One owner for both halves of the Keep in Needs attention inputs: the band
    // mode the action depends on, and the account default joined with the
    // per-session overrides this projection already holds.
    const attentionStanding = useSessionAttentionStandingInputs(
        organizationListViewState.attentionStandingOverridesBySessionKey,
    );
    const sessionListAttentionPromotionModeV1 = attentionStanding.placementMode;
    const sessionAttentionStandingPolicy = attentionStanding.policy;
    const pinnedSessionKeysV1 = organizationListViewState.pinnedSessionKeysV1 as PinnedSessionKeysV1;
    const sessionListGroupOrderV1 = organizationListViewState.sessionListGroupOrderV1;
    const sessionWorkspaceOrderV1 = organizationListViewState.sessionWorkspaceOrderV1;
    const sessionFoldersV1 = organizationListViewState.sessionFoldersV1;
    const sessionFolderAssignmentsBySessionKey = organizationListViewState.sessionFolderAssignmentsBySessionKey;
    const sessionIdsWithOpenApprovals = React.useMemo(() => (
        openApprovalSessionIdList.length === 0
            ? EMPTY_OPEN_APPROVAL_SESSION_ID_SET
            : new Set(openApprovalSessionIdList)
    ), [openApprovalSessionIdList]);
    const previousVisibleSessionListIndexForRetention = resolvePreviousVisibleSessionListIndexForRetention(
        previousVisibleSessionListIndexRef.current,
        options.retainedVisibleSessionListIndex,
    );
    const selectedSessionPathname = previousVisibleSessionListIndexRef.current === null
        && previousVisibleSessionListIndexForRetention
        && options.retainedPathname
        ? options.retainedPathname
        : effectivePathname;
    const activeSessionId = React.useMemo(() => resolveSelectedSessionIdForList({
        selectable: true,
        pathname: selectedSessionPathname,
        focusedSessionId,
    }), [selectedSessionPathname, focusedSessionId]);

    const normalizedGroupOrder = React.useMemo(() => {
        if (!source) return sessionListGroupOrderV1;
        if (sessionListOrderingModeV1 !== 'custom') return sessionListGroupOrderV1;
        const folderAwareSource = buildFolderAwareSessionListIndex({
            source,
            collapsedGroupKeysV1,
            sessionFoldersFeatureEnabled,
            storageFilter,
            folderFocusInput,
            sessionFoldersV1,
            sessionFolderViewModeV1,
            sessionFolderAssignmentsBySessionKey,
        }).items;
        return normalizeSessionListGroupOrderV1ForIndexSource({
            source: folderAwareSource,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1,
        });
    }, [
        collapsedGroupKeysV1,
        folderFocusInput,
        pinnedSessionKeysV1,
        sessionFolderAssignmentsBySessionKey,
        sessionFolderViewModeV1,
        sessionFoldersFeatureEnabled,
        sessionFoldersV1,
        sessionListGroupOrderV1,
        sessionListOrderingModeV1,
        source,
        storageFilter,
    ]);

    const normalizedWorkspaceOrder = React.useMemo(() => {
        if (!source) return sessionWorkspaceOrderV1;
        if (sessionListOrderingModeV1 !== 'custom') return sessionWorkspaceOrderV1;
        return normalizeSessionWorkspaceOrderV1ForSource({
            source,
            sessionWorkspaceOrderV1,
        });
    }, [sessionListOrderingModeV1, sessionWorkspaceOrderV1, source]);

    // Shared session-list runtime clock: placement and per-row working
    // indicators must derive freshness from the same timestamp in the same
    // render cycle. This hook subscribes to the canonical clock and (below)
    // contributes the earliest freshness expiry of the visible rows as its
    // wake horizon so the index recomputes exactly when placement can change
    // without a store update.
    const surfaceDataActive = options.sessionListSurfaceDataActive !== false;
    const runtimeNowMs = useSessionListRuntimeNowMs(surfaceDataActive);

    const visibleSessionListIndex = React.useMemo(() => {
        if (!source) return source;
        const retainAttentionSessionKeys = resolveRetainedAttentionSessionKeys({
            previousVisibleIndex: previousVisibleSessionListIndexForRetention,
            activeSessionId,
        });
        const retainWorkingSessionKeys = resolveRetainedWorkingSessionKeys(previousVisibleSessionListIndexForRetention);
        return reuseStableVisibleSessionListIndex(previousVisibleSessionListIndexForRetention, buildVisibleSessionListIndex({
            source,
            sessionRowStateByServerId,
            hideInactiveSessions: hideInactiveSessions === true,
            pinnedSessionKeysV1,
            sessionListOrderingModeV1,
            sessionListSectionModeV1,
            sessionListFolderSortModeV1,
            sessionListAttentionPromotionModeV1,
            sessionAttentionStandingPolicy,
            sessionListWorkingPlacementModeV1,
            activeSessionId,
            normalizedGroupOrder,
            sessionListGroupOrderV1,
            normalizedWorkspaceOrder,
            sessionWorkspaceOrderV1,
            collapsedGroupKeysV1,
            sessionFoldersFeatureEnabled,
            selection,
            storageFilter,
            folderFocusInput,
            sessionFoldersV1,
            sessionFolderViewModeV1,
            sessionFolderAssignmentsBySessionKey,
            sessionIdsWithOpenApprovals,
            retainAttentionSessionKeys,
            retainWorkingSessionKeys,
            nowMs: runtimeNowMs,
        }));
    }, [
        runtimeNowMs,
        folderFocusInput,
        activeSessionId,
        collapsedGroupKeysV1,
        hideInactiveSessions,
        selection.allowedServerIds,
        selection.enabled,
        pinnedSessionKeysV1,
        normalizedGroupOrder,
        normalizedWorkspaceOrder,
        selection.presentation,
        sessionListGroupOrderV1,
        sessionWorkspaceOrderV1,
        sessionListAttentionPromotionModeV1,
        sessionAttentionStandingPolicy,
        sessionListWorkingPlacementModeV1,
        sessionRowStateByServerId,
        sessionIdsWithOpenApprovals,
        sessionFolderAssignmentsBySessionKey,
        sessionFoldersFeatureEnabled,
        sessionFolderViewModeV1,
        sessionFoldersV1,
        source,
        storageFilter,
        previousVisibleSessionListIndexForRetention,
        sessionListOrderingModeV1,
        sessionListSectionModeV1,
        sessionListFolderSortModeV1,
    ]);

    React.useEffect(() => {
        previousVisibleSessionListIndexRef.current = visibleSessionListIndex;
    }, [visibleSessionListIndex]);

    const nextRuntimeFreshnessAtMs = React.useMemo(() => {
        if (!surfaceDataActive || !visibleSessionListIndex) return null;
        let nextAtMs: number | null = null;
        for (const item of visibleSessionListIndex) {
            if (item.type !== 'session') continue;
            const row = readSessionListRowForServerId(sessionRowStateByServerId, item.serverId, item.sessionId);
            if (!row) continue;
            for (const expiresAtMs of readSessionRuntimePresentationFreshnessExpirations(row, runtimeNowMs)) {
                nextAtMs = nextAtMs === null ? expiresAtMs : Math.min(nextAtMs, expiresAtMs);
            }
            if (readExternalSessionLink(row.metadata)) {
                const externalAgentExpiryAtMs = resolveExternalAgentPresentationState(
                    readExternalAgentObservationPresentationInput(row.metadata),
                    runtimeNowMs,
                ).nextExpiryAtMs;
                if (externalAgentExpiryAtMs !== null) {
                    nextAtMs = nextAtMs === null
                        ? externalAgentExpiryAtMs
                        : Math.min(nextAtMs, externalAgentExpiryAtMs);
                }
            }
        }
        return nextAtMs;
    }, [runtimeNowMs, sessionRowStateByServerId, surfaceDataActive, visibleSessionListIndex]);
    useSessionListRuntimeWake(nextRuntimeFreshnessAtMs, surfaceDataActive);

    const hasHiddenInactiveSessions = React.useMemo(() => {
        if (!source || !hideInactiveSessions) {
            return false;
        }

        if (countSessionItems(visibleSessionListIndex) > 0) {
            return false;
        }

        const retainAttentionSessionKeys = resolveRetainedAttentionSessionKeys({
            previousVisibleIndex: previousVisibleSessionListIndexForRetention,
            activeSessionId,
        });
        const retainWorkingSessionKeys = resolveRetainedWorkingSessionKeys(previousVisibleSessionListIndexForRetention);
        const visibleWithoutInactiveFilter = buildVisibleSessionListIndex({
            source,
            sessionRowStateByServerId,
            hideInactiveSessions: false,
            pinnedSessionKeysV1,
            sessionListOrderingModeV1,
            sessionListSectionModeV1,
            sessionListFolderSortModeV1,
            sessionListAttentionPromotionModeV1,
            sessionAttentionStandingPolicy,
            sessionListWorkingPlacementModeV1,
            activeSessionId,
            normalizedGroupOrder,
            sessionListGroupOrderV1,
            normalizedWorkspaceOrder,
            sessionWorkspaceOrderV1,
            collapsedGroupKeysV1,
            sessionFoldersFeatureEnabled,
            selection,
            storageFilter,
            folderFocusInput,
            sessionFoldersV1,
            sessionFolderViewModeV1,
            sessionFolderAssignmentsBySessionKey,
            sessionIdsWithOpenApprovals,
            retainAttentionSessionKeys,
            retainWorkingSessionKeys,
            nowMs: runtimeNowMs,
        });

        return countSessionItems(visibleWithoutInactiveFilter) > 0;
    }, [
        runtimeNowMs,
        folderFocusInput,
        activeSessionId,
        collapsedGroupKeysV1,
        hideInactiveSessions,
        normalizedGroupOrder,
        normalizedWorkspaceOrder,
        pinnedSessionKeysV1,
        selection.allowedServerIds,
        selection.enabled,
        selection.presentation,
        sessionListGroupOrderV1,
        sessionWorkspaceOrderV1,
        sessionListAttentionPromotionModeV1,
        sessionAttentionStandingPolicy,
        sessionListWorkingPlacementModeV1,
        sessionListOrderingModeV1,
        sessionListSectionModeV1,
        sessionListFolderSortModeV1,
        sessionRowStateByServerId,
        sessionIdsWithOpenApprovals,
        sessionFolderAssignmentsBySessionKey,
        sessionFoldersFeatureEnabled,
        sessionFolderViewModeV1,
        sessionFoldersV1,
        source,
        storageFilter,
        previousVisibleSessionListIndexForRetention,
        visibleSessionListIndex,
    ]);

    const folderFocus = React.useMemo(() => {
        if (!sessionFoldersFeatureEnabled || sessionFolderViewModeV1 !== 'tree' || !source) return null;
        return applySessionFolderTreeToSessionListIndex({
            source,
            folders: sessionFoldersV1,
            assignmentsBySessionKey: sessionFolderAssignmentsBySessionKey,
            collapsedGroupKeys: {},
            focusedFolder: folderFocusInput,
        }).folderFocus;
    }, [
        folderFocusInput,
        sessionFolderAssignmentsBySessionKey,
        sessionFoldersFeatureEnabled,
        sessionFolderViewModeV1,
        sessionFoldersV1,
        source,
        storageFilter,
    ]);

    return React.useMemo(() => ({
        visibleSessionListIndex,
        hasHiddenInactiveSessions,
        folderFocus,
    }), [folderFocus, hasHiddenInactiveSessions, visibleSessionListIndex]);
}

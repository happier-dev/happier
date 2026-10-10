import * as React from 'react';
import { usePathname } from 'expo-router';
import { normalizeSessionListFilterV1, type SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { useWorkflowRunWindow, type WorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveWorkflowRunUnavailableHomes } from '@/sync/domains/session/listing/sessionListWorkFilter';

import {
    useLocalSetting,
    useSessionListRowsByServerId,
    useSessionOrganizationProjections,
    useSetting,
    useActiveServerAccountScope,
} from '@/sync/domains/state/storage';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { normalizeSessionListWorkingPlacementMode } from '@/sync/domains/session/listing/sessionListAttentionPlacement';
import {
    isSessionListWorkingPlacementReason,
    type SessionListRetainedAttentionPlacement,
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
    resolveFolderAwareSessionListSourceForLayout,
    resolveSessionFolderFocusScope,
    selectAvailableSessionFolders,
    compareSessionFolderWorkspaceRefs,
    type SessionFolderFocusScope,
    type FolderAwareSessionListIndexResult,
    type SessionFolderList,
    type SessionListFocusedFolderV1,
} from '@/sync/domains/session/folders';
import {
    resolveNextSessionAttentionReminderWakeAtMs,
    type SessionAttentionStandingPolicy,
} from '@/sync/domains/session/organization/attentionStanding';
import { buildSessionOrganizationListViewStateForServers } from '@/sync/domains/session/organization/viewState';
import { resolveSessionListOrganizationServerIds } from '@/sync/domains/session/organization/sessionListOrganizationServerIds';
import { useSessionAttentionStandingInputs } from './useSessionAttentionStandingInputs';
import {
    useFocusedSessionAddress,
    useFocusedSessionId,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import {
    useVisibleSessionListSourceState,
    type VisibleSessionListSourceStateOptions,
} from './useVisibleSessionListSourceState';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionRuntimePresentationFreshnessExpirations } from '@/sync/domains/session/attention/runtimePresentation';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from './sessionListRuntimeClock';
import {
    readExternalAgentObservationPresentationInput,
    resolveExternalAgentPresentationState,
} from '@/components/sessions/presentation/externalSessionRuntimePresentation';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import {
    normalizeSessionListSectionModeV1,
    type SessionListLayoutChoice,
} from '@/sync/domains/session/listing/sessionListLayout';
import { useSessionListLayoutChoice } from './sessionListLayoutIntent';
import { useSessionListFeatureHomeSupportByServerId } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { areSessionListGroupOrderMapsEqual } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { areSessionWorkspaceOrderMapsEqual } from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { resolveSessionListQueryPresentation } from '@/sync/domains/session/listing/sessionListIndexPresentation';

type SessionListGroupOrderV1 = Readonly<Record<string, ReadonlyArray<string> | undefined>>;
type PinnedSessionKeysV1 = ReadonlyArray<string>;

export type VisibleSessionListViewState = Readonly<{
    visibleSessionListIndex: ReadonlyArray<SessionListIndexItem> | null;
    hasHiddenInactiveSessions: boolean;
    folderFocus: SessionFolderFocusScope | null;
    folderFeatureEnabledServerIds: ReadonlyArray<string>;
    query?: ReturnType<typeof useVisibleSessionListSourceState>['query'];
    workflowRunWindow?: WorkflowRunWindow;
    workflowRunUnavailableHomes?: Parameters<typeof resolveSessionListQueryPresentation>[0]['workflowRunUnavailableHomes'];
}>;

export type VisibleSessionListViewStateOptions = Readonly<{
    pathname?: string;
    retainedPathname?: string | null;
    retainedVisibleSessionListIndex?: ReadonlyArray<SessionListIndexItem> | null;
    sessionListSurfaceDataActive?: boolean;
    queryHomes?: VisibleSessionListSourceStateOptions['queryHomes'];
    emptyQuerySelectionComplete?: boolean;
    corpusStorage?: 'active' | 'archived';
    workFilter?: SessionListFilterV1;
    botsRoster?: true;
}>;

function buildFolderAwareSessionListIndex(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    collapsedGroupKeysV1: Readonly<Record<string, boolean>>;
    sessionFoldersFeatureEnabled: boolean;
    sessionListLayoutChoice: SessionListLayoutChoice;
    folderFocusInput: SessionListFocusedFolderV1;
    sessionFoldersV1: SessionFolderList;
    sessionFolderViewModeV1: unknown;
    sessionFolderAssignmentsBySessionKey: Readonly<Record<string, string | null>>;
}>): FolderAwareSessionListIndexResult {
    return resolveFolderAwareSessionListSourceForLayout({
        source: params.source,
        layoutChoice: params.sessionListLayoutChoice,
        foldersFeatureEnabled: params.sessionFoldersFeatureEnabled,
        folderViewModeV1: params.sessionFolderViewModeV1,
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
    sessionRowStateByServerId: ReturnType<typeof useSessionListRowsByServerId>,
    serverId: string | null | undefined,
    sessionId: string,
) {
    const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedServerId || !normalizedSessionId) {
        return null;
    }
    return readSessionListRowForServerId(sessionRowStateByServerId, normalizedServerId, normalizedSessionId);
}

/** Hold only the opened row; ordering survives while its status remains live. */
function resolveRetainedAttentionPlacements(params: Readonly<{
    previousVisibleIndex: ReadonlyArray<SessionListIndexItem> | null | undefined;
    activeSessionId: string | null;
    activeSessionServerId: string | null;
}>): ReadonlyArray<SessionListRetainedAttentionPlacement> {
    const activeSessionId = String(params.activeSessionId ?? '').trim();
    if (!activeSessionId) return [];
    if (!params.previousVisibleIndex) return [];
    const matchingItems = params.previousVisibleIndex.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
        item.type === 'session'
        && item.sessionId === activeSessionId
        && (!params.activeSessionServerId || item.serverId === params.activeSessionServerId)
    ));
    if (!params.activeSessionServerId && matchingItems.length !== 1) return [];
    for (const item of matchingItems) {
        if (item.groupKind !== 'attention' && !item.attentionPlacementReason) continue;
        // Standing is the user's own instruction, so removing it must take effect
        // immediately. Retention exists to stop a row the user is READING from
        // sliding away under them; retaining a standing row would instead pin it
        // in the band until they navigate elsewhere.
        if (item.attentionPlacementReason === 'standing') continue;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        const ordering = item.attentionPlacementOrdering ?? (item.attentionPlacementReason
            ? { reason: item.attentionPlacementReason, timestamp: 0 } : null);
        return key && ordering ? [{ key, ...ordering }] : [];
    }
    return [];
}

type VisibleSessionListProjectionInputs = Omit<Parameters<typeof buildVisibleSessionListIndex>[0], 'nowMs'>;

type RetainedVisibleSessionListProjection = Readonly<{
    inputs: VisibleSessionListProjectionInputs;
    validUntilMs: number | null;
}>;

// The retained pane already owns the last rendered projection while the phone list is hidden.
// Keep its exact projection inputs attached to that array identity so a remount can validate and
// reuse it without keeping the list's store subscriptions alive behind a detail route.
const retainedVisibleSessionListProjections = new WeakMap<
    ReadonlyArray<SessionListIndexItem>,
    RetainedVisibleSessionListProjection
>();

function areStringListsEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function areSetsEqual(left: ReadonlySet<string> | null, right: ReadonlySet<string> | null): boolean {
    if (left === right) return true;
    if (!left || !right || left.size !== right.size) return false;
    for (const value of left) if (!right.has(value)) return false;
    return true;
}

function areScalarRecordsEqual(
    left: Readonly<Record<string, unknown>>,
    right: Readonly<Record<string, unknown>>,
): boolean {
    if (left === right) return true;
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => Object.is(left[key], right[key]));
}

function areSessionListIndexesEqual(
    left: ReadonlyArray<SessionListIndexItem>,
    right: ReadonlyArray<SessionListIndexItem>,
): boolean {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    return left.every((item, index) => areSessionListIndexItemsEqual(item, right[index]));
}

function areSessionListRowSourcesEqual(
    left: ReturnType<typeof useSessionListRowsByServerId>,
    right: ReturnType<typeof useSessionListRowsByServerId>,
    source: ReadonlyArray<SessionListIndexItem>,
): boolean {
    if (left === right) return true;
    for (const item of source) {
        if (item.type !== 'session') continue;
        if (
            resolveSessionRowFromState(left, item.serverId, item.sessionId)
            !== resolveSessionRowFromState(right, item.serverId, item.sessionId)
        ) {
            return false;
        }
    }
    return true;
}

function areAttentionStandingPoliciesEqual(
    left: SessionAttentionStandingPolicy,
    right: SessionAttentionStandingPolicy,
): boolean {
    if (left === right) return true;
    if (left.defaultStanding !== right.defaultStanding) return false;
    const leftKeys = Object.keys(left.overridesBySessionKey);
    if (leftKeys.length !== Object.keys(right.overridesBySessionKey).length) return false;
    for (const key of leftKeys) {
        const leftValue = left.overridesBySessionKey[key];
        const rightValue = right.overridesBySessionKey[key];
        if (leftValue === rightValue) continue;
        if (
            typeof leftValue !== 'object'
            || typeof rightValue !== 'object'
            || leftValue.standing !== rightValue.standing
            || leftValue.remindAt !== rightValue.remindAt
            || leftValue.updatedAt !== rightValue.updatedAt
        ) {
            return false;
        }
    }
    return true;
}

function areFolderFocusInputsEqual(
    left: SessionListFocusedFolderV1,
    right: SessionListFocusedFolderV1,
): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.serverId === right.serverId
        && left.folderId === right.folderId
        && left.renderWorkspaceKey === right.renderWorkspaceKey
        && compareSessionFolderWorkspaceRefs(left.workspace, right.workspace);
}

function areSessionFolderListsEqual(left: SessionFolderList, right: SessionFolderList): boolean {
    if (left === right) return true;
    if (left.folders.length !== right.folders.length) return false;
    return left.folders.every((folder, index) => {
        const candidate = right.folders[index];
        if (!candidate) return false;
        const sameWorkspace = folder.workspace === candidate.workspace
            || (!!folder.workspace && !!candidate.workspace
                && compareSessionFolderWorkspaceRefs(folder.workspace, candidate.workspace));
        const sameDisplayState = folder.displayState === candidate.displayState
            || (
                folder.displayState?.status === candidate.displayState?.status
                && (folder.displayState?.status !== 'locked'
                    || (candidate.displayState?.status === 'locked'
                        && folder.displayState.reason === candidate.displayState.reason))
                && (folder.displayState?.status !== 'available'
                    || (candidate.displayState?.status === 'available'
                        && folder.displayState.value === candidate.displayState.value))
            );
        return folder.id === candidate.id
            && folder.serverId === candidate.serverId
            && folder.name === candidate.name
            && folder.parentId === candidate.parentId
            && (folder.sortKey ?? null) === (candidate.sortKey ?? null)
            && sameWorkspace
            && sameDisplayState;
    });
}

function areVisibleSessionListProjectionInputsEqual(
    left: VisibleSessionListProjectionInputs,
    right: VisibleSessionListProjectionInputs,
): boolean {
    const leftGroupOrder = left.sessionListOrderingModeV1 === 'custom'
        ? left.normalizedGroupOrder
        : left.sessionListGroupOrderV1;
    const rightGroupOrder = right.sessionListOrderingModeV1 === 'custom'
        ? right.normalizedGroupOrder
        : right.sessionListGroupOrderV1;
    const leftWorkspaceOrder = left.sessionListOrderingModeV1 === 'custom'
        ? left.normalizedWorkspaceOrder
        : left.sessionWorkspaceOrderV1;
    const rightWorkspaceOrder = right.sessionListOrderingModeV1 === 'custom'
        ? right.normalizedWorkspaceOrder
        : right.sessionWorkspaceOrderV1;
    return areSessionListIndexesEqual(left.source, right.source)
        && sameStrictJsonValue(left.workFilter, right.workFilter)
        && left.workflowRuns.length === right.workflowRuns.length
        && left.workflowRuns.every((run, index) => run.serverId === right.workflowRuns[index]?.serverId
            && run.summary === right.workflowRuns[index]?.summary)
        && areSessionListRowSourcesEqual(left.sessionRowStateByServerId, right.sessionRowStateByServerId, right.source)
        && left.hideInactiveSessions === right.hideInactiveSessions
        && areSetsEqual(left.serverFilteredInactiveServerIds, right.serverFilteredInactiveServerIds)
        && left.corpusStorage === right.corpusStorage
        && areStringListsEqual(left.pinnedSessionKeysV1, right.pinnedSessionKeysV1)
        && left.sessionListOrderingModeV1 === right.sessionListOrderingModeV1
        && left.sessionListSectionModeV1 === right.sessionListSectionModeV1
        && left.sessionListLayoutChoice === right.sessionListLayoutChoice
        && left.sessionListAttentionPromotionModeV1 === right.sessionListAttentionPromotionModeV1
        && areAttentionStandingPoliciesEqual(left.sessionAttentionStandingPolicy, right.sessionAttentionStandingPolicy)
        && left.sessionListWorkingPlacementModeV1 === right.sessionListWorkingPlacementModeV1
        && left.sessionListFolderSortModeV1 === right.sessionListFolderSortModeV1
        && areSessionListGroupOrderMapsEqual(leftGroupOrder, rightGroupOrder)
        && areSessionWorkspaceOrderMapsEqual(leftWorkspaceOrder, rightWorkspaceOrder)
        && areScalarRecordsEqual(left.collapsedGroupKeysV1, right.collapsedGroupKeysV1)
        && left.sessionFoldersFeatureEnabled === right.sessionFoldersFeatureEnabled
        && left.selection.enabled === right.selection.enabled
        && left.selection.presentation === right.selection.presentation
        && areStringListsEqual(left.selection.allowedServerIds, right.selection.allowedServerIds)
        && left.storageFilter === right.storageFilter
        && areFolderFocusInputsEqual(left.folderFocusInput, right.folderFocusInput)
        && areSessionFolderListsEqual(left.sessionFoldersV1, right.sessionFoldersV1)
        && left.sessionFolderViewModeV1 === right.sessionFolderViewModeV1
        && areScalarRecordsEqual(left.sessionFolderAssignmentsBySessionKey, right.sessionFolderAssignmentsBySessionKey)
        && left.retainAttentionPlacements.length === right.retainAttentionPlacements.length
        && left.retainAttentionPlacements.every((placement, index) => {
            const other = right.retainAttentionPlacements[index];
            return placement.key === other?.key && placement.reason === other.reason && placement.timestamp === other.timestamp;
        })
        && areStringListsEqual(left.retainWorkingSessionKeys, right.retainWorkingSessionKeys);
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
    workFilter: SessionListFilterV1;
    workflowRuns: NonNullable<Parameters<typeof computeVisibleSessionListIndex>[0]['workflowRuns']>;
    sessionRowStateByServerId: ReturnType<typeof useSessionListRowsByServerId>;
    hideInactiveSessions: boolean;
    serverFilteredInactiveServerIds: ReadonlySet<string> | null;
    corpusStorage: 'active' | 'archived';
    pinnedSessionKeysV1: PinnedSessionKeysV1;
    sessionListOrderingModeV1: 'custom' | 'created' | 'updated';
    sessionListSectionModeV1: 'activity' | 'single';
    sessionListLayoutChoice: SessionListLayoutChoice;
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
    retainAttentionPlacements: ReadonlyArray<SessionListRetainedAttentionPlacement>;
    retainWorkingSessionKeys: ReadonlyArray<string>;
    nowMs: number;
}>): ReadonlyArray<SessionListIndexItem> | null {
    const folderAwareSource = buildFolderAwareSessionListIndex(params);
    const resolveSessionRow = (
        serverId: string | null | undefined,
        sessionId: string,
    ) => resolveSessionRowFromState(
        params.sessionRowStateByServerId,
        serverId,
        sessionId,
    );
    const visible = computeVisibleSessionListIndex({
        source: folderAwareSource.items,
        folderFocus: folderAwareSource.folderFocus,
        workFilter: params.workFilter,
        workflowRuns: params.workflowRuns,
        resolveSessionRow,
        hideInactiveSessions: params.hideInactiveSessions,
        serverFilteredInactiveServerIds: params.serverFilteredInactiveServerIds,
        corpusStorage: params.corpusStorage,
        pinnedSessionKeysV1: params.pinnedSessionKeysV1,
        sessionListGroupOrderV1: params.sessionListOrderingModeV1 === 'custom'
            ? params.normalizedGroupOrder
            : params.sessionListGroupOrderV1,
        sessionWorkspaceOrderV1: params.sessionListOrderingModeV1 === 'custom'
            ? params.normalizedWorkspaceOrder
            : params.sessionWorkspaceOrderV1,
        sessionListOrderingModeV1: params.sessionListOrderingModeV1,
        sessionListSectionModeV1: params.sessionListSectionModeV1,
        sessionListLayoutChoice: params.sessionListLayoutChoice,
        sessionListFolderSortModeV1: params.sessionListFolderSortModeV1,
        attentionPlacement: {
            mode: params.sessionListAttentionPromotionModeV1,
            retainPlacements: params.retainAttentionPlacements,
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
    const focusedSessionAddress = useFocusedSessionAddress();
    const previousVisibleSessionListIndexRef = React.useRef<ReadonlyArray<SessionListIndexItem> | null>(null);
    const queryHomes = React.useMemo(() => options.botsRoster === true
        ? options.queryHomes?.map(home => ({ ...home, query: { ...home.query, bot: 'bot' as const, includeInactive: true }, queryMembership: 'rowOnly' as const }))
        : options.queryHomes, [options.botsRoster, options.queryHomes]);
    const { selection, source, query } = useVisibleSessionListSourceState({
        queryHomes,
        emptyQuerySelectionComplete: options.emptyQuerySelectionComplete,
    });
    const surfaceDataActive = options.sessionListSurfaceDataActive !== false;
    const activeAccountScope = useActiveServerAccountScope();
    const workflowsAvailability = useWorkflowsAvailability();
    const workFilter = React.useMemo(() => normalizeSessionListFilterV1({
        homeServerIds: selection.allowedServerIds.length > 0
            ? selection.allowedServerIds
            : selection.activeServerId ? [selection.activeServerId] : [],
        ...options.workFilter,
        ...(options.botsRoster === true ? { show: 'sessions', bot: 'bot' } : {}),
    }), [options.botsRoster, options.workFilter, selection.activeServerId, selection.allowedServerIds]);
    const runServerId = activeAccountScope
        ? resolveServerProfileScopeIdForIdentifier(activeAccountScope.serverId)
        : null;
    const workflowRunsEnabled = surfaceDataActive
        && options.corpusStorage !== 'archived'
        && workFilter.show !== 'sessions'
        && workflowsAvailability.available
        && runServerId !== null
        && areServerProfileIdentifiersEquivalent(runServerId, selection.activeServerId)
        && workFilter.homeServerIds.some((serverId) => areServerProfileIdentifiersEquivalent(serverId, runServerId));
    const workflowWindow = useWorkflowRunWindow('all', { enabled: workflowRunsEnabled });
    const workflowRunWindow = workflowRunsEnabled ? workflowWindow : undefined;
    const workflowRunUnavailableHomes = React.useMemo(() => {
        if (!surfaceDataActive || options.corpusStorage === 'archived' || workFilter.show === 'sessions') return undefined;
        const mountedHomes = selection.allowedServerIds.length > 0 ? selection.allowedServerIds
            : selection.activeServerId ? [selection.activeServerId] : [];
        return resolveWorkflowRunUnavailableHomes({
            selectedHomeServerIds: workFilter.homeServerIds,
            mountedHomeServerIds: mountedHomes,
            servedHomeServerId: workflowRunsEnabled ? runServerId : null,
        });
    }, [options.corpusStorage, runServerId, selection.activeServerId, selection.allowedServerIds,
        surfaceDataActive, workFilter.homeServerIds, workFilter.show, workflowRunsEnabled]);
    const workflowRuns = React.useMemo<VisibleSessionListProjectionInputs['workflowRuns']>(() => {
        if (!workflowRunsEnabled || !runServerId) return [];
        return workflowWindow.rows.flatMap((row) => row.summary ? [{ serverId: runServerId, summary: row.summary }] : []);
    }, [runServerId, workflowRunsEnabled, workflowWindow.rows]);
    const sessionRowStateByServerId = useSessionListRowsByServerId();
    const accountHideInactiveSessions = useSetting('hideInactiveSessions');
    const hideInactiveSessions = options.botsRoster === true ? false : accountHideInactiveSessions === true;
    // Every Home whose membership was applied by the strict query already answered
    // `includeInactive` server-side, so an inactive row it returned is one the
    // server's attention predicate deliberately admitted. Homes still served by the
    // released GET adapter are absent here and keep the incumbent client rule.
    const queryStatesByServerId = query.statesByServerId;
    const serverFilteredInactiveServerIds = React.useMemo(() => {
        if (!query.active) return null;
        const serverIds = new Set<string>();
        for (const [serverId, state] of Object.entries(queryStatesByServerId)) {
            if (state?.appliedSourceKind === 'query'
                && queryHomes?.some((home) => areServerProfileIdentifiersEquivalent(home.serverId, serverId)
                    && home.query.includeInactive === false)) serverIds.add(serverId);
        }
        return serverIds.size > 0 ? serverIds : null;
    }, [queryHomes, query.active, queryStatesByServerId]);
    const sessionListOrderingModeV1 = useSetting('sessionListOrderingModeV1') as
        | 'custom'
        | 'created'
        | 'updated';
    const sessionListSectionModeV1 = normalizeSessionListSectionModeV1(useSetting('sessionListSectionModeV1'));
    const sessionListLayoutChoice = useSessionListLayoutChoice();
    const sessionListFolderSortModeV1 = useSetting('sessionListFolderSortModeV1') === 'mixed'
        ? 'mixed'
        : 'foldersFirst';
    const sessionListWorkingPlacementModeV1 = normalizeSessionListWorkingPlacementMode(
        useSetting('sessionListWorkingPlacementModeV1'),
    );
    const sessionFolderViewModeV1 = useSetting('sessionFolderViewModeV1');
    const collapsedGroupKeysV1 = (useLocalSetting('collapsedGroupKeysV1') ?? {}) as Readonly<Record<string, boolean>>;
    const folderFocusInput = useLocalSetting('sessionListFocusedFolderV1') as SessionListFocusedFolderV1;
    const organizationServerIds = React.useMemo(() => resolveSessionListOrganizationServerIds({
        queryHomeServerIds: options.queryHomes?.map((home) => home.serverId),
        allowedServerIds: selection.allowedServerIds,
        activeServerId: selection.activeServerId,
    }), [options.queryHomes, selection.activeServerId, selection.allowedServerIds]);
    const organizationProjectionsByServerId = useSessionOrganizationProjections(organizationServerIds);
    const folderFeatureSupportByServerId = useSessionListFeatureHomeSupportByServerId(
        'sessions.folders',
        organizationServerIds,
        true,
    );
    const folderFeatureEnabledServerIds = React.useMemo(
        () => organizationServerIds.filter((serverId) => folderFeatureSupportByServerId[serverId] === true),
        [folderFeatureSupportByServerId, organizationServerIds],
    );
    const sessionFoldersFeatureEnabled = folderFeatureEnabledServerIds.length > 0;
    const organizationListViewState = React.useMemo(() => buildSessionOrganizationListViewStateForServers({
        serverIds: organizationServerIds,
        projectionsByServerId: organizationProjectionsByServerId,
    }), [organizationProjectionsByServerId, organizationServerIds]);
    const folderOrganizationListViewState = React.useMemo(() => buildSessionOrganizationListViewStateForServers({
        serverIds: folderFeatureEnabledServerIds,
        projectionsByServerId: organizationProjectionsByServerId,
    }), [folderFeatureEnabledServerIds, organizationProjectionsByServerId]);
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
    const sessionFoldersV1 = folderOrganizationListViewState.sessionFoldersV1;
    const sessionFolderAssignmentsBySessionKey = folderOrganizationListViewState.sessionFolderAssignmentsBySessionKey;
    const previousVisibleSessionListIndexForRetention = resolvePreviousVisibleSessionListIndexForRetention(
        previousVisibleSessionListIndexRef.current,
        options.retainedVisibleSessionListIndex,
    );
    // A retained root pane still represents its foreground route on subsequent projections.
    // Its owner updates retainedPathname when navigation leaves that Session.
    const selectedSessionPathname = effectivePathname === '/'
        ? options.retainedPathname ?? effectivePathname
        : effectivePathname;
    const activeSessionId = React.useMemo(() => resolveSelectedSessionIdForList({
        selectable: true,
        pathname: selectedSessionPathname,
        focusedSessionId,
    }), [selectedSessionPathname, focusedSessionId]);
    const activeSessionServerId = focusedSessionAddress?.sessionId === activeSessionId
        ? focusedSessionAddress.serverId
        : null;

    const normalizedGroupOrder = React.useMemo(() => {
        if (!source) return sessionListGroupOrderV1;
        if (sessionListOrderingModeV1 !== 'custom') return sessionListGroupOrderV1;
        const folderAwareSource = buildFolderAwareSessionListIndex({
            source,
            collapsedGroupKeysV1,
            sessionFoldersFeatureEnabled,
            sessionListLayoutChoice,
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
        sessionListLayoutChoice,
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
    const runtimeNowMs = useSessionListRuntimeNowMs(surfaceDataActive);

    const projectionInputs = React.useMemo<VisibleSessionListProjectionInputs>(() => ({
        source: source ?? [],
        workFilter,
        workflowRuns,
        activeSessionId,
        sessionRowStateByServerId,
        hideInactiveSessions: hideInactiveSessions === true,
        serverFilteredInactiveServerIds,
        corpusStorage: options.corpusStorage ?? 'active',
        pinnedSessionKeysV1,
        sessionListOrderingModeV1,
        sessionListSectionModeV1,
        sessionListLayoutChoice,
        sessionListFolderSortModeV1,
        sessionListAttentionPromotionModeV1,
        sessionAttentionStandingPolicy,
        sessionListWorkingPlacementModeV1,
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
        retainAttentionPlacements: resolveRetainedAttentionPlacements({
            previousVisibleIndex: previousVisibleSessionListIndexForRetention,
            activeSessionId,
            activeSessionServerId,
        }),
        retainWorkingSessionKeys: resolveRetainedWorkingSessionKeys(previousVisibleSessionListIndexForRetention),
    }), [
        activeSessionId,
        activeSessionServerId,
        collapsedGroupKeysV1,
        folderFocusInput,
        hideInactiveSessions,
        normalizedGroupOrder,
        normalizedWorkspaceOrder,
        options.corpusStorage,
        pinnedSessionKeysV1,
        previousVisibleSessionListIndexForRetention,
        selection,
        serverFilteredInactiveServerIds,
        sessionAttentionStandingPolicy,
        sessionFolderAssignmentsBySessionKey,
        sessionFolderViewModeV1,
        sessionFoldersFeatureEnabled,
        sessionFoldersV1,
        sessionListAttentionPromotionModeV1,
        sessionListFolderSortModeV1,
        sessionListGroupOrderV1,
        sessionListLayoutChoice,
        sessionListOrderingModeV1,
        sessionListSectionModeV1,
        sessionListWorkingPlacementModeV1,
        sessionRowStateByServerId,
        sessionWorkspaceOrderV1,
        source,
        storageFilter,
        workFilter,
        workflowRuns,
    ]);

    const visibleSessionListIndex = React.useMemo(() => {
        if (!source && (!workflowRunWindow || workflowRunWindow.status === 'loading')) return source;
        const cachedProjection = previousVisibleSessionListIndexForRetention
            ? retainedVisibleSessionListProjections.get(previousVisibleSessionListIndexForRetention)
            : undefined;
        if (
            previousVisibleSessionListIndexForRetention
            && cachedProjection
            && (cachedProjection.validUntilMs === null || runtimeNowMs < cachedProjection.validUntilMs)
            && areVisibleSessionListProjectionInputsEqual(cachedProjection.inputs, projectionInputs)
        ) {
            syncPerformanceTelemetry.count('sync.sessions.list.visible.retainedProjectionReused', {
                items: previousVisibleSessionListIndexForRetention.length,
            });
            return previousVisibleSessionListIndexForRetention;
        }
        return reuseStableVisibleSessionListIndex(
            previousVisibleSessionListIndexForRetention,
            buildVisibleSessionListIndex({ ...projectionInputs, nowMs: runtimeNowMs }),
        );
    }, [previousVisibleSessionListIndexForRetention, projectionInputs, runtimeNowMs, source, workflowRunWindow?.status]);

    React.useEffect(() => {
        previousVisibleSessionListIndexRef.current = visibleSessionListIndex;
    }, [visibleSessionListIndex]);

    const nextRuntimeFreshnessAtMs = React.useMemo(() => {
        if (!surfaceDataActive || !visibleSessionListIndex) return null;
        let nextAtMs = resolveNextSessionAttentionReminderWakeAtMs(sessionAttentionStandingPolicy, runtimeNowMs);
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
    }, [runtimeNowMs, sessionAttentionStandingPolicy, sessionRowStateByServerId, surfaceDataActive, visibleSessionListIndex]);
    useSessionListRuntimeWake(nextRuntimeFreshnessAtMs, surfaceDataActive);

    React.useEffect(() => {
        if (!visibleSessionListIndex) return;
        retainedVisibleSessionListProjections.set(visibleSessionListIndex, {
            inputs: projectionInputs,
            validUntilMs: nextRuntimeFreshnessAtMs,
        });
    }, [nextRuntimeFreshnessAtMs, projectionInputs, visibleSessionListIndex]);

    const hasHiddenInactiveSessions = React.useMemo(() => {
        if (!source || !hideInactiveSessions) {
            return false;
        }

        if (countSessionItems(visibleSessionListIndex) > 0) {
            return false;
        }

        const visibleWithoutInactiveFilter = buildVisibleSessionListIndex({
            ...projectionInputs,
            hideInactiveSessions: false,
            nowMs: runtimeNowMs,
        });

        return countSessionItems(visibleWithoutInactiveFilter) > 0;
    }, [
        runtimeNowMs,
        hideInactiveSessions,
        projectionInputs,
        visibleSessionListIndex,
    ]);

    // The focus scope stays visible in every layout so the reader can always see and
    // clear the narrowing that is hiding rows, including in Recent activity where the
    // folder tree itself is suppressed.
    const folderFocus = React.useMemo(() => {
        if (!sessionFoldersFeatureEnabled || sessionFolderViewModeV1 !== 'tree') return null;
        return resolveSessionFolderFocusScope(
            selectAvailableSessionFolders(sessionFoldersV1),
            folderFocusInput,
        );
    }, [
        folderFocusInput,
        sessionFoldersFeatureEnabled,
        sessionFolderViewModeV1,
        sessionFoldersV1,
    ]);

    return React.useMemo(() => ({
        visibleSessionListIndex,
        hasHiddenInactiveSessions,
        folderFocus,
        folderFeatureEnabledServerIds,
        query,
        workflowRunWindow,
        workflowRunUnavailableHomes,
    }), [folderFeatureEnabledServerIds, folderFocus, hasHiddenInactiveSessions, query, visibleSessionListIndex, workflowRunWindow, workflowRunUnavailableHomes]);
}

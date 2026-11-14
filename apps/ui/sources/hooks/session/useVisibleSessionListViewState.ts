import * as React from 'react';
import { useCollapsedGroupKeys } from '@/sync/domains/state/disclosureUiState';
import { buildSessionListCollapseKey, readSessionListCollapsedGroups } from '@/sync/domains/session/listing/sessionListCollapseState';
import { normalizeSessionListBackgroundWorkAttentionMode, type SessionListBackgroundWorkAttentionMode } from '@/sync/domains/session/listing/sessionListBackgroundWorkAttention';
import { canSessionListFilterIncludeRunsV1, normalizeSessionListFilterV1, type SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { useWorkflowRunWindow, type WorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { areServerProfileIdentifiersEquivalent, captureServerProfileScopeResolver, resolveServerProfileScopeIdForIdentifier, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { resolveWorkflowRunUnavailableHomes } from '@/sync/domains/session/listing/sessionListWorkFilter';

import {
    type SessionListRowChanges,
    useSessionListRowsByServerId,
    useSessionOrganizationProjections,
    useSetting,
    useSettingsSelector,
    useActiveServerAccountScope,
} from '@/sync/domains/state/storage';
import { computeVisibleSessionListIndex, computeVisibleSessionListProjection, keepVisibleSessionListProjectionForRowChanges, type SessionListWorkMembershipProjection, type VisibleSessionListProjection } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import type { EntityListFilterResultV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import { buildSessionListQueryKey } from '@/sync/domains/session/listing/sessionListQueryKey';
import {
    isSessionListWorkingPlacementReason,
} from '@/sync/domains/session/listing/sessionListAttentionPlacementTypes';
import { normalizeSessionListKeyParts } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { normalizeSessionListGroupOrderV1ForIndexSource } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import {
    normalizeSessionWorkspaceOrderV1ForSource,
    type SessionWorkspaceOrderV1,
} from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';
import { filterSessionListIndexByStorageKind } from '@/sync/domains/session/listing/filterSessionListIndexByStorageKind';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { areSessionListIndexItemsEqual, buildSessionListIndexNodeId, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { projectSessionSectionListIndex, type SessionSection } from '@/sync/domains/session/organization/sections';
import {
    resolveNextSessionAttentionReminderWakeAtMs,
    type SessionAttentionStandingPolicy,
} from '@/sync/domains/session/organization/attentionStanding';
import { buildSessionOrganizationListViewStateForServers } from '@/sync/domains/session/organization/viewState';
import { resolveSessionListOrganizationServerIds } from '@/sync/domains/session/organization/sessionListOrganizationServerIds';
import { useSessionAttentionStandingInputs } from './useSessionAttentionStandingInputs';
import {
    useVisibleSessionListSourceState,
    type VisibleSessionListSourceStateOptions,
} from './useVisibleSessionListSourceState';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionRuntimePresentationFreshnessExpirations } from '@/sync/domains/session/attention/runtimePresentation';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from './sessionListRuntimeClock';
import {
    readExternalAgentObservationPresentationInput,
    resolveExternalAgentPresentationState,
} from '@/components/sessions/presentation/externalSessionRuntimePresentation';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import {
    type SessionListLayoutChoice,
} from '@/sync/domains/session/listing/sessionListLayout';
import { useSessionListLayoutChoice } from './sessionListLayoutIntent';
import { useSessionListFeatureHomeSupportByServerId } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { areSessionListGroupOrderMapsEqual } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { areSessionWorkspaceOrderMapsEqual } from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { useProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { projectSessionListAcceptedProjects } from '@/sync/domains/session/listing/sessionListProjectProjection';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { resolveSessionListQueryPresentation } from '@/sync/domains/session/listing/sessionListIndexPresentation';
import { useSessionListRecordingPrivacy } from './useSessionListRecordingPrivacy';

type SessionListGroupOrderV1 = Readonly<Record<string, ReadonlyArray<string> | undefined>>;
type PinnedSessionKeysV1 = ReadonlyArray<string>;
const UNAVAILABLE_FILTER_RESULT: EntityListFilterResultV1 = Object.freeze({ matchedCount: 0, coverage: 'unavailable' });
const EMPTY_FILTER_ENTITY_IDS: ReadonlySet<string> = new Set();
const EMPTY_COLLAPSE_KEYS: readonly string[] = [];

export type VisibleSessionListViewState = Readonly<{
    visibleSessionListIndex: ReadonlyArray<SessionListIndexItem> | null;
    filterResult: EntityListFilterResultV1;
    conditionValueCounts?: VisibleSessionListProjection['conditionValueCounts'];
    filterMatchedEntityIds: ReadonlySet<string>;
    filterAttentionSupplementEntityIds: ReadonlySet<string>;
    hasHiddenInactiveSessions: boolean;
    folderFeatureEnabledServerIds: ReadonlyArray<string>;
    query?: ReturnType<typeof useVisibleSessionListSourceState>['query'];
    workflowRunWindow?: WorkflowRunWindow;
    workflowRunUnavailableHomes?: Parameters<typeof resolveSessionListQueryPresentation>[0]['workflowRunUnavailableHomes'];
}>;

export type VisibleSessionListViewStateOptions = Readonly<{
    collapseContextKey?: string;
    pathname?: string;
    retainedPathname?: string | null;
    retainedVisibleSessionListIndex?: ReadonlyArray<SessionListIndexItem> | null;
    sessionListSurfaceDataActive?: boolean;
    queryHomes?: VisibleSessionListSourceStateOptions['queryHomes'];
    emptyQuerySelectionComplete?: boolean;
    corpusStorage?: 'active' | 'archived';
    workFilter?: SessionListFilterV1;
    spaceMembership?: Parameters<typeof computeVisibleSessionListProjection>[0]['spaceMembership'];
    conditionValueCountRequest?: Parameters<typeof computeVisibleSessionListProjection>[0]['conditionValueCountRequest'];
    botsRoster?: true;
    attentionInteractionHeld?: boolean;
    supplementalNeedsYouSessionKeys?: ReadonlySet<string>;
    includeNeedsYouEverywhere?: boolean;
    fixedTeam?: Parameters<typeof computeVisibleSessionListProjection>[0]['fixedTeam'];
}>;

function buildSectionSessionListIndex(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    sessionSections: readonly SessionSection[];
    sessionFolderAssignmentsBySessionKey: Readonly<Record<string, string | null>>;
}>) {
    return projectSessionSectionListIndex({
        source: params.source,
        sections: params.sessionSections,
        assignmentsBySessionKey: params.sessionFolderAssignmentsBySessionKey,
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
    if (!previous || !next || previous === next) {
        return next;
    }

    const previousById = new Map(previous.map(item => [buildSessionListIndexNodeId(item), item]));
    let reusedAllItems = previous.length === next.length;
    let reusedAnyItem = false;
    const out = next.map((nextItem, index) => {
        const previousItem = previousById.get(buildSessionListIndexNodeId(nextItem));
        if (areSessionListIndexItemsEqual(previousItem, nextItem)) {
            reusedAnyItem = true;
            if (previousItem !== previous[index]) reusedAllItems = false;
            return previousItem!;
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
    resolveScopeId?: ProfileScopeResolver,
) {
    const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedServerId || !normalizedSessionId) {
        return null;
    }
    return readSessionListRowForServerId(sessionRowStateByServerId, normalizedServerId, normalizedSessionId, resolveScopeId);
}

type VisibleSessionListProjectionInputs = Omit<Parameters<typeof buildVisibleSessionListIndex>[0], 'nowMs' | 'previousPresentedIndex' | 'previousMembership'>;

type RetainedVisibleSessionListProjection = Readonly<{
    inputs: VisibleSessionListProjectionInputs;
    collapseContextKey: string | undefined;
    validUntilMs: number | null;
    hasHiddenInactiveSessions: boolean;
    filterResult: EntityListFilterResultV1;
    conditionValueCounts?: VisibleSessionListProjection['conditionValueCounts'];
    filterMatchedEntityIds: ReadonlySet<string>;
    filterAttentionSupplementEntityIds: ReadonlySet<string>;
    membership: SessionListWorkMembershipProjection;
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

function areSectionQueryProofsEqual(left: ReadonlyMap<string, readonly string[]> | undefined,
    right: ReadonlyMap<string, readonly string[]> | undefined): boolean {
    if (left === right) return true;
    if (!left || !right || left.size !== right.size) return false;
    for (const [home, ids] of left) {
        const other = right.get(home);
        if (!other || !areStringListsEqual(ids, other)) return false;
    }
    return true;
}

function areSetsEqual(left: ReadonlySet<string> | null | undefined, right: ReadonlySet<string> | null | undefined): boolean {
    if (left === right) return true;
    if (!left || !right || left.size !== right.size) return false;
    for (const value of left) if (!right.has(value)) return false;
    return true;
}

function areViewerAccountScopesEqual(
    left: ReadonlyMap<string, string> | undefined,
    right: ReadonlyMap<string, string> | undefined,
): boolean {
    if (left === right) return true;
    if (!left || !right || left.size !== right.size) return false;
    for (const [serverId, accountId] of left) {
        if (right.get(serverId) !== accountId) return false;
    }
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

type SessionListItemsBySessionId = ReadonlyMap<string, readonly Extract<SessionListIndexItem, { type: 'session' }>[]>;
// Listed Session items per id, kept with the source array (stable across row writes).
const sessionItemsBySessionIdBySource = new WeakMap<ReadonlyArray<SessionListIndexItem>, SessionListItemsBySessionId>();

function readSessionItemsBySessionId(source: ReadonlyArray<SessionListIndexItem>): SessionListItemsBySessionId {
    let bySessionId = sessionItemsBySessionIdBySource.get(source);
    if (!bySessionId) {
        const next = new Map<string, Extract<SessionListIndexItem, { type: 'session' }>[]>();
        for (const item of source) {
            if (item.type !== 'session') continue;
            const items = next.get(item.sessionId);
            if (items) items.push(item);
            else next.set(item.sessionId, [item]);
        }
        bySessionId = next;
        sessionItemsBySessionIdBySource.set(source, bySessionId);
    }
    return bySessionId;
}

function areSessionListRowSourcesEqual(
    left: ReturnType<typeof useSessionListRowsByServerId>,
    right: ReturnType<typeof useSessionListRowsByServerId>,
    source: ReadonlyArray<SessionListIndexItem>,
    rowChanges: SessionListRowChanges | null,
): boolean {
    if (left === right) return true;
    const resolveScopeId = captureServerProfileScopeResolver();
    const differs = (item: Extract<SessionListIndexItem, { type: 'session' }>) =>
        resolveSessionRowFromState(left, item.serverId, item.sessionId, resolveScopeId)
            !== resolveSessionRowFromState(right, item.serverId, item.sessionId, resolveScopeId);
    // The store's delta names every row that changed since `left`: only listed ones among them can differ.
    if (rowChanges?.previousRows === left) {
        const bySessionId = readSessionItemsBySessionId(source);
        for (const sessionId of rowChanges.sessionIds) {
            for (const item of bySessionId.get(sessionId) ?? []) if (differs(item)) return false;
        }
        return true;
    }
    for (const item of source) {
        if (item.type === 'session' && differs(item)) return false;
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

function areVisibleSessionListProjectionInputsEqual(
    left: VisibleSessionListProjectionInputs,
    right: VisibleSessionListProjectionInputs,
    rowChanges: SessionListRowChanges | null,
): boolean {
    const leftGroupOrder = left.sessionListLayoutChoice === 'projects'
        ? left.normalizedGroupOrder
        : left.sessionListGroupOrderV1;
    const rightGroupOrder = right.sessionListLayoutChoice === 'projects'
        ? right.normalizedGroupOrder
        : right.sessionListGroupOrderV1;
    const leftWorkspaceOrder = left.sessionListLayoutChoice === 'projects'
        ? left.normalizedWorkspaceOrder
        : left.sessionWorkspaceOrderV1;
    const rightWorkspaceOrder = right.sessionListLayoutChoice === 'projects'
        ? right.normalizedWorkspaceOrder
        : right.sessionWorkspaceOrderV1;
    return areSessionListIndexesEqual(left.source, right.source)
        && areSessionListIndexesEqual(left.attentionSource ?? [], right.attentionSource ?? [])
        && left.includeNeedsYouEverywhere === right.includeNeedsYouEverywhere
        && left.fixedTeam?.serverId === right.fixedTeam?.serverId && left.fixedTeam?.teamId === right.fixedTeam?.teamId
        && areSetsEqual(left.fixedTeamQueryServerIds, right.fixedTeamQueryServerIds)
        && left.groupCoverage === right.groupCoverage
        && sameStrictJsonValue(left.workFilter, right.workFilter)
        && sameStrictJsonValue(left.spaceMembership, right.spaceMembership)
        && sameStrictJsonValue(left.sessionTagIdsBySessionKey, right.sessionTagIdsBySessionKey)
        && areSetsEqual(left.recordingHiddenSessionKeys, right.recordingHiddenSessionKeys)
        && sameStrictJsonValue(left.conditionValueCountRequest, right.conditionValueCountRequest)
        && areSectionQueryProofsEqual(left.querySectionIdsByServerId, right.querySectionIdsByServerId)
        && left.workspaceRefs === right.workspaceRefs
        && areViewerAccountScopesEqual(left.viewerAccountIdByServerId, right.viewerAccountIdByServerId)
        && left.workflowRuns.length === right.workflowRuns.length
        && left.workflowRuns.every((run, index) => run.serverId === right.workflowRuns[index]?.serverId
            && run.summary === right.workflowRuns[index]?.summary)
        && left.workflowRunUnderSessionId === right.workflowRunUnderSessionId
        && areSessionListRowSourcesEqual(left.sessionRowStateByServerId, right.sessionRowStateByServerId, right.source, rowChanges)
        && areSessionListRowSourcesEqual(left.sessionRowStateByServerId, right.sessionRowStateByServerId, right.attentionSource ?? [], rowChanges)
        && left.hideInactiveSessions === right.hideInactiveSessions
        && areSetsEqual(left.serverFilteredInactiveServerIds, right.serverFilteredInactiveServerIds)
        && left.corpusStorage === right.corpusStorage
        && areStringListsEqual(left.pinnedSessionKeysV1, right.pinnedSessionKeysV1)
        && left.sessionListLayoutChoice === right.sessionListLayoutChoice
        && left.attentionInteractionHeld === right.attentionInteractionHeld
        && areSetsEqual(left.supplementalNeedsYouSessionKeys, right.supplementalNeedsYouSessionKeys)
        && left.sessionListAttentionPlacementV1 === right.sessionListAttentionPlacementV1
        && areAttentionStandingPoliciesEqual(left.sessionAttentionStandingPolicy, right.sessionAttentionStandingPolicy)
        && left.backgroundWorkAttentionMode === right.backgroundWorkAttentionMode
        && areSessionListGroupOrderMapsEqual(leftGroupOrder, rightGroupOrder)
        && areSessionWorkspaceOrderMapsEqual(leftWorkspaceOrder, rightWorkspaceOrder)
        && left.collapsedGroupKeysV1 === right.collapsedGroupKeysV1
        && left.sessionFoldersFeatureEnabled === right.sessionFoldersFeatureEnabled
        && left.selection.enabled === right.selection.enabled
        && left.selection.presentation === right.selection.presentation
        && areStringListsEqual(left.selection.allowedServerIds, right.selection.allowedServerIds)
        && left.storageFilter === right.storageFilter
        && sameStrictJsonValue(left.sessionSections, right.sessionSections)
        && areScalarRecordsEqual(left.sessionFolderAssignmentsBySessionKey, right.sessionFolderAssignmentsBySessionKey)
        && areStringListsEqual(left.retainWorkingSessionKeys, right.retainWorkingSessionKeys);
}

// The store keeps an unchanged row's identity: after one row write only that row's expiry is derived again.
const rowNextFreshnessAtMs = new WeakMap<SessionListRenderableSession, Readonly<{ nowMs: number; atMs: number | null }>>();

/** When this row's runtime presentation (or its external agent observation) next changes at the list clock. */
function readSessionListRowNextFreshnessAtMs(row: SessionListRenderableSession, nowMs: number): number | null {
    const retained = rowNextFreshnessAtMs.get(row);
    if (retained?.nowMs === nowMs) return retained.atMs;
    let atMs: number | null = null;
    for (const expiresAtMs of readSessionRuntimePresentationFreshnessExpirations(row, nowMs)) {
        atMs = atMs === null ? expiresAtMs : Math.min(atMs, expiresAtMs);
    }
    if (readExternalSessionLink(row.metadata)) {
        const externalAgentExpiryAtMs = resolveExternalAgentPresentationState(
            readExternalAgentObservationPresentationInput(row.metadata),
            nowMs,
        ).nextExpiryAtMs;
        if (externalAgentExpiryAtMs !== null) atMs = atMs === null ? externalAgentExpiryAtMs : Math.min(atMs, externalAgentExpiryAtMs);
    }
    rowNextFreshnessAtMs.set(row, { nowMs, atMs });
    return atMs;
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
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        retainedKeys.push(key);
    }
    return retainedKeys;
}

function buildVisibleSessionListIndex(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    attentionSource?: readonly SessionListIndexItem[] | null;
    includeNeedsYouEverywhere?: boolean;
    fixedTeam?: Parameters<typeof computeVisibleSessionListProjection>[0]['fixedTeam'];
    fixedTeamQueryServerIds?: ReadonlySet<string>;
    previousPresentedIndex?: ReadonlyArray<SessionListIndexItem> | null;
    attentionInteractionHeld?: boolean;
    supplementalNeedsYouSessionKeys?: ReadonlySet<string>;
    workFilter: SessionListFilterV1;
    spaceMembership?: Parameters<typeof computeVisibleSessionListProjection>[0]['spaceMembership'];
    sessionTagIdsBySessionKey?: Readonly<Record<string, readonly string[]>>;
    recordingHiddenSessionKeys?: ReadonlySet<string>;
    conditionValueCountRequest?: Parameters<typeof computeVisibleSessionListProjection>[0]['conditionValueCountRequest'];
    previousMembership?: SessionListWorkMembershipProjection;
    groupCoverage?: Parameters<typeof computeVisibleSessionListProjection>[0]['groupCoverage'];
    querySectionIdsByServerId?: ReadonlyMap<string, readonly string[]>;
    workspaceRefs?: Parameters<typeof computeVisibleSessionListIndex>[0]['workspaceRefs'];
    viewerAccountIdByServerId?: ReadonlyMap<string, string>;
    workflowRuns: NonNullable<Parameters<typeof computeVisibleSessionListIndex>[0]['workflowRuns']>;
    workflowRunUnderSessionId?: string;
    sessionRowStateByServerId: ReturnType<typeof useSessionListRowsByServerId>;
    hideInactiveSessions: boolean;
    serverFilteredInactiveServerIds: ReadonlySet<string> | null;
    corpusStorage: 'active' | 'archived';
    pinnedSessionKeysV1: PinnedSessionKeysV1;
    sessionListLayoutChoice: SessionListLayoutChoice;
    sessionListAttentionPlacementV1: 'both' | 'top' | 'inPlace';
    sessionAttentionStandingPolicy: SessionAttentionStandingPolicy;
    backgroundWorkAttentionMode: SessionListBackgroundWorkAttentionMode;
    normalizedGroupOrder: SessionListGroupOrderV1;
    sessionListGroupOrderV1: SessionListGroupOrderV1;
    normalizedWorkspaceOrder: SessionWorkspaceOrderV1;
    sessionWorkspaceOrderV1: SessionWorkspaceOrderV1;
    collapsedGroupKeysV1: Readonly<Record<string, boolean>>;
    sessionFoldersFeatureEnabled: boolean;
    selection: ReturnType<typeof useVisibleSessionListSourceState>['selection'];
    storageFilter: SessionListStorageFilter;
    sessionSections: readonly SessionSection[];
    sessionFolderAssignmentsBySessionKey: Readonly<Record<string, string | null>>;
    retainWorkingSessionKeys: ReadonlyArray<string>;
    nowMs: number;
    /** Only these Sessions' rows changed since `previous` was projected; every other input is the same. */
    rowChange?: Readonly<{
        sessionIds: ReadonlySet<string>;
        previousRows: ReturnType<typeof useSessionListRowsByServerId>;
        previous: Parameters<typeof keepVisibleSessionListProjectionForRowChanges>[0]['previous'];
    }>;
}>): VisibleSessionListProjection {
    const resolveScopeId = captureServerProfileScopeResolver();
    const resolveSessionRow = (
        serverId: string | null | undefined,
        sessionId: string,
    ) => resolveSessionRowFromState(
        params.sessionRowStateByServerId,
        serverId,
        sessionId,
        resolveScopeId,
    );
    const projectSource = () => projectSessionListAcceptedProjects({
        source: params.source, workspaceRefs: params.workspaceRefs,
        censusServerId: params.selection.activeServerId ?? '', resolveSessionRow,
        viewerAccountId: params.viewerAccountIdByServerId?.get(resolveScopeId(params.selection.activeServerId ?? '') || params.selection.activeServerId || ''),
        layoutV1: params.sessionListLayoutChoice, previousIndex: params.previousPresentedIndex,
        // The membership owner retains one resolver per `workspaceRefs`; reuse it rather than build another.
        sessionProjectKeyResolver: params.previousMembership && params.previousMembership.workspaceRefs === params.workspaceRefs
            && params.previousMembership.workspaceRefsServerId === (params.selection.activeServerId ?? undefined)
            ? params.previousMembership.projectKeyResolver : undefined,
    });
    const computeParams = (source: ReadonlyArray<SessionListIndexItem>): Parameters<typeof computeVisibleSessionListProjection>[0] => ({
        source,
        attentionSource: params.attentionSource,
        includeNeedsYouEverywhere: params.includeNeedsYouEverywhere,
        fixedTeam: params.fixedTeam,
        fixedTeamQueryServerIds: params.fixedTeamQueryServerIds,
        previousPresentedIndex: params.previousPresentedIndex,
        attentionInteractionHeld: params.attentionInteractionHeld === true && params.previousPresentedIndex != null,
        supplementalNeedsYouSessionKeys: params.supplementalNeedsYouSessionKeys,
        workFilter: params.workFilter,
        spaceMembership: params.spaceMembership,
        sessionTagIdsBySessionKey: params.sessionTagIdsBySessionKey,
        recordingHiddenSessionKeys: params.recordingHiddenSessionKeys,
        conditionValueCountRequest: params.conditionValueCountRequest,
        previousMembership: params.previousMembership,
        groupCoverage: params.groupCoverage,
        sessionFolderAssignmentsBySessionKey: params.sessionFolderAssignmentsBySessionKey,
        querySectionIdsByServerId: params.querySectionIdsByServerId,
        workspaceRefs: params.workspaceRefs,
        workspaceRefsServerId: params.selection.activeServerId ?? undefined,
        viewerAccountIdByServerId: params.viewerAccountIdByServerId,
        workflowRuns: params.workflowRuns,
        workflowRunUnderSessionId: params.workflowRunUnderSessionId,
        resolveSessionRow,
        hideInactiveSessions: params.hideInactiveSessions,
        serverFilteredInactiveServerIds: params.serverFilteredInactiveServerIds,
        corpusStorage: params.corpusStorage,
        pinnedSessionKeysV1: params.pinnedSessionKeysV1,
        sessionListGroupOrderV1: params.sessionListLayoutChoice === 'projects'
            ? params.normalizedGroupOrder
            : params.sessionListGroupOrderV1,
        sessionWorkspaceOrderV1: params.sessionListLayoutChoice === 'projects'
            ? params.normalizedWorkspaceOrder
            : params.sessionWorkspaceOrderV1,
        sessionListLayoutChoice: params.sessionListLayoutChoice,
        sessionListAttentionPlacementV1: params.sessionListAttentionPlacementV1,
        attentionPlacement: {
            mode: 'global',
            standingPolicy: params.sessionAttentionStandingPolicy,
        },
        backgroundWorkAttentionMode: params.backgroundWorkAttentionMode,
        workingPlacement: {
            mode: 'global',
            retainSessionKeys: params.retainWorkingSessionKeys,
        },
        presentation: {
            enabled: params.selection.enabled,
            presentation: params.selection.presentation,
            selectedServerIds: params.selection.allowedServerIds,
        },
        storageFilterApplied: params.storageFilter !== 'all',
        nowMs: params.nowMs,
        rowOnlyChangeSinceMembership: params.rowChange?.sessionIds,
    });
    if (params.rowChange) {
        // The projection owner decides whether a known row-level change can keep the arranged list.
        const kept = keepVisibleSessionListProjectionForRowChanges({
            params: computeParams(params.source),
            previous: params.rowChange.previous,
            changedSessionIds: params.rowChange.sessionIds,
            resolvePreviousSessionRow: (serverId, sessionId) => resolveSessionRowFromState(
                params.rowChange!.previousRows, serverId, sessionId, resolveScopeId),
        });
        if (kept) return kept;
    }
    const sectionSource = buildSectionSessionListIndex({ ...params, source: projectSource() });
    const projection = computeVisibleSessionListProjection(computeParams(sectionSource.items));
    if (!projection.items || params.storageFilter === 'all') return projection;
    return { ...projection, items: filterSessionListIndexByStorageKind(projection.items, params.storageFilter, resolveSessionRow) };
}

export function useVisibleSessionListViewState(
    storageFilter: SessionListStorageFilter = 'all',
    options: VisibleSessionListViewStateOptions = {},
): VisibleSessionListViewState {
    const previousVisibleSessionListIndexRef = React.useRef<ReadonlyArray<SessionListIndexItem> | null>(null);
    const surfaceDataActive = options.sessionListSurfaceDataActive !== false;
    const queryHomes = React.useMemo(() => options.botsRoster === true
        ? options.queryHomes?.map(home => ({ ...home, query: { ...home.query, bot: 'bot' as const, includeInactive: true }, queryMembership: 'rowOnly' as const }))
        : options.queryHomes, [options.botsRoster, options.queryHomes]);
    const { selection, source, ordinarySourceIndex, query } = useVisibleSessionListSourceState({
        enabled: surfaceDataActive,
        queryHomes,
        emptyQuerySelectionComplete: options.emptyQuerySelectionComplete,
        agentTargetDemand: surfaceDataActive && [options.workFilter, options.spaceMembership?.filter]
            .some(filter => Boolean(filter?.agents && filter.agents.include.length + filter.agents.exclude.length > 0)),
    });
    const activeAccountScope = useActiveServerAccountScope();
    const workflowsAvailability = useWorkflowsAvailability();
    const workFilter = React.useMemo(() => normalizeSessionListFilterV1({
        homeServerIds: selection.allowedServerIds.length > 0
            ? selection.allowedServerIds
            : selection.activeServerId ? [selection.activeServerId] : [],
        ...options.workFilter,
        ...(options.botsRoster === true ? { show: 'sessions', bot: 'bot' } : {}),
    }), [options.botsRoster, options.workFilter, selection.activeServerId, selection.allowedServerIds]);
    const hasVisibleKeylessRows = surfaceDataActive && Boolean(activeAccountScope && source?.some(item => item.type === 'session'
        && !item.projectKey && areServerProfileIdentifiersEquivalent(item.serverId, activeAccountScope.serverId)));
    const workspaceRefs = useProjectAccountWorkspaceRefs(surfaceDataActive && (hasVisibleKeylessRows
        || [workFilter, options.spaceMembership?.filter].some(filter => Boolean(filter?.projects
            && filter.projects.include.length + filter.projects.exclude.length > 0))));
    const viewerBindings = useServerCredentialAccountScopeBindings(surfaceDataActive ? workFilter.homeServerIds : []);
    const viewerAccountIdByServerId = React.useMemo(() => new Map([...viewerBindings]
        .filter(([, binding]) => binding.isCurrent()).map(([serverId, binding]) => [serverId, binding.accountId] as const)), [viewerBindings]);
    const attentionSource = React.useMemo(() => options.includeNeedsYouEverywhere === true && surfaceDataActive
        ? ordinarySourceIndex?.filter(item => item.type === 'session' && (() => {
            const home = resolveServerProfileScopeIdForIdentifier(item.serverId) || item.serverId || '';
            // Captured Home → Account authority fences this already-held corpus before
            // the membership owner can classify it; query proof is never borrowed.
            return viewerBindings.get(home)?.isCurrent() === true;
        })()) ?? [] : [], [options.includeNeedsYouEverywhere, ordinarySourceIndex, surfaceDataActive, viewerBindings]);
    const runServerId = activeAccountScope
        ? resolveServerProfileScopeIdForIdentifier(activeAccountScope.serverId)
        : null;
    const includesWorkflowRuns = canSessionListFilterIncludeRunsV1(workFilter)
        && options.spaceMembership?.membership.mode !== 'manual_only'
        && (!options.spaceMembership || canSessionListFilterIncludeRunsV1(options.spaceMembership.filter));
    const workflowRunsEnabled = surfaceDataActive
        && options.corpusStorage !== 'archived'
        && includesWorkflowRuns
        && workflowsAvailability.available
        && runServerId !== null
        && areServerProfileIdentifiersEquivalent(runServerId, selection.activeServerId)
        && workFilter.homeServerIds.some((serverId) => areServerProfileIdentifiersEquivalent(serverId, runServerId));
    const workflowRunUnderSessionId = workFilter.underSessionId ?? options.spaceMembership?.filter.underSessionId;
    const workflowWindow = useWorkflowRunWindow(workflowRunUnderSessionId ? `under:${workflowRunUnderSessionId}` : 'all', { enabled: workflowRunsEnabled });
    const workflowRunWindow = workflowRunsEnabled ? workflowWindow : undefined;
    const resolveRunUnavailableHomes = (runFactsUnavailable: boolean) => {
        if (!surfaceDataActive || options.corpusStorage === 'archived' || !includesWorkflowRuns) return undefined;
        const mountedHomes = selection.allowedServerIds.length > 0 ? selection.allowedServerIds
            : selection.activeServerId ? [selection.activeServerId] : [];
        return resolveWorkflowRunUnavailableHomes({
            selectedHomeServerIds: workFilter.homeServerIds,
            mountedHomeServerIds: mountedHomes,
            servedHomeServerId: workflowRunsEnabled ? runServerId : null,
            filter: options.spaceMembership?.filter ?? workFilter,
            runFactsUnavailable: runFactsUnavailable || workflowWindow.rows.some(row => row.summary === null),
            runUnderSessionId: workflowRunsEnabled ? workflowRunUnderSessionId : undefined,
            viewerAccountId: runServerId ? viewerAccountIdByServerId.get(runServerId) : undefined,
        });
    };
    const workflowRuns = React.useMemo<VisibleSessionListProjectionInputs['workflowRuns']>(() => {
        if (!workflowRunsEnabled || !runServerId) return [];
        return workflowWindow.rows.flatMap((row) => row.summary ? [{ serverId: runServerId, summary: row.summary }] : []);
    }, [runServerId, workflowRunsEnabled, workflowWindow.rows]);
    const hideInactiveSessions = useSettingsSelector(React.useCallback(settings => (
        options.botsRoster === true || options.corpusStorage === 'archived' ? false
            : workFilter.includeInactive === undefined ? settings.hideInactiveSessions === true : !workFilter.includeInactive
    ), [options.botsRoster, options.corpusStorage, workFilter.includeInactive]), ['hideInactiveSessions']);
    // Every Home whose membership was applied by the strict query already answered
    // `includeInactive` server-side, so an inactive row it returned is one the
    // server's attention predicate deliberately admitted. Homes still served by the
    // released GET adapter are absent here and keep the incumbent client rule.
    const queryStatesByServerId = query.statesByServerId;
    const { querySectionIdsByServerId, fixedTeamQueryServerIds } = React.useMemo(() => {
        const proof = new Map<string, readonly string[]>();
        const teamProof = new Set<string>();
        if (!query.active) return { querySectionIdsByServerId: proof, fixedTeamQueryServerIds: teamProof };
        for (const home of queryHomes ?? []) {
            const homeId = resolveServerProfileScopeIdForIdentifier(home.serverId) || home.serverId;
            const state = queryStatesByServerId[homeId] ?? queryStatesByServerId[home.serverId];
            if (state?.appliedSourceKind === 'query'
                && state.appliedQueryKey === buildSessionListQueryKey(home.serverId, home.query)) {
                if (home.query.folderIds !== undefined) proof.set(homeId, home.query.folderIds);
                const team = options.fixedTeam;
                if (team && viewerBindings.get(homeId)?.isCurrent() === true
                    && areServerProfileIdentifiersEquivalent(team.serverId, home.serverId)
                    && home.query.audiences.length > 0 && home.query.audiences.every(audience => audience.kind !== 'outside_teams'
                        && audience.teamId === team.teamId)) teamProof.add(homeId);
            }
        }
        return { querySectionIdsByServerId: proof, fixedTeamQueryServerIds: teamProof };
    }, [query.active, queryHomes, queryStatesByServerId, options.fixedTeam, viewerBindings]);
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
    const sessionListLayoutChoice = useSessionListLayoutChoice();
    const backgroundWorkAttentionMode = normalizeSessionListBackgroundWorkAttentionMode(useSetting('sessionListBackgroundWorkAttentionModeV1'));
    const storedCollapsedGroupKeysV1 = useCollapsedGroupKeys(options.collapseContextKey === undefined
        ? EMPTY_COLLAPSE_KEYS : buildSessionListCollapseKey(options.collapseContextKey, ''));
    const collapsedGroupKeysV1 = React.useMemo(() => options.collapseContextKey === undefined
        ? {} : readSessionListCollapsedGroups(storedCollapsedGroupKeysV1, options.collapseContextKey),
    [options.collapseContextKey, storedCollapsedGroupKeysV1]);
    const organizationServerIds = React.useMemo(() => resolveSessionListOrganizationServerIds({
        queryHomeServerIds: options.queryHomes?.map((home) => home.serverId),
        allowedServerIds: selection.allowedServerIds,
        activeServerId: selection.activeServerId,
    }), [options.queryHomes, selection.activeServerId, selection.allowedServerIds]);
    const organizationProjectionsByServerId = useSessionOrganizationProjections(organizationServerIds);
    const folderFeatureSupportByServerId = useSessionListFeatureHomeSupportByServerId(
        'sessions',
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
    // The Bot roster supplies its own activity ordering and counts qualified entities, not column mirrors.
    const sessionListAttentionPlacementV1 = options.botsRoster === true ? 'inPlace' : attentionStanding.placementMode;
    const sessionAttentionStandingPolicy = attentionStanding.policy;
    const pinnedSessionKeysV1 = organizationListViewState.pinnedSessionKeysV1 as PinnedSessionKeysV1;
    const sessionListGroupOrderV1 = organizationListViewState.sessionListGroupOrderV1;
    const sessionWorkspaceOrderV1 = organizationListViewState.sessionWorkspaceOrderV1;
    const sessionSections = folderOrganizationListViewState.sections;
    const sessionFolderAssignmentsBySessionKey = folderOrganizationListViewState.sessionFolderAssignmentsBySessionKey;
    const previousVisibleSessionListIndexForRetention = resolvePreviousVisibleSessionListIndexForRetention(
        previousVisibleSessionListIndexRef.current,
        options.retainedVisibleSessionListIndex,
    );
    const normalizedGroupOrder = React.useMemo(() => {
        if (!source) return sessionListGroupOrderV1;
        if (sessionListLayoutChoice !== 'projects') return sessionListGroupOrderV1;
        const sectionSource = buildSectionSessionListIndex({
            source,
            sessionSections,
            sessionFolderAssignmentsBySessionKey,
        }).items;
        return normalizeSessionListGroupOrderV1ForIndexSource({
            source: sectionSource,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1,
        });
    }, [
        collapsedGroupKeysV1,
        pinnedSessionKeysV1,
        sessionFolderAssignmentsBySessionKey,
        sessionFoldersFeatureEnabled,
        sessionSections,
        sessionListGroupOrderV1,
        sessionListLayoutChoice,
        source,
        storageFilter,
    ]);

    const normalizedWorkspaceOrder = React.useMemo(() => {
        if (!source) return sessionWorkspaceOrderV1;
        if (sessionListLayoutChoice !== 'projects') return sessionWorkspaceOrderV1;
        return normalizeSessionWorkspaceOrderV1ForSource({
            source,
            sessionWorkspaceOrderV1,
            workspaceRefs,
            workspaceRefsServerId: selection.activeServerId ?? undefined,
        });
    }, [sessionListLayoutChoice, sessionWorkspaceOrderV1, source, workspaceRefs, selection.activeServerId]);

    // Shared session-list runtime clock: placement and per-row working
    // indicators must derive freshness from the same timestamp in the same
    // render cycle. This hook subscribes to the canonical clock and (below)
    // contributes the earliest freshness expiry of the visible rows as its
    // wake horizon so the index recomputes exactly when placement can change
    // without a store update.
    const runtimeWakeToken = React.useMemo<object>(() => ({}), []);
    const runtimeNowMs = useSessionListRuntimeNowMs(surfaceDataActive, undefined, runtimeWakeToken);

    // Source availability is known before membership. Fact unavailability joins
    // the same owner after projection, rather than creating a cyclic input.
    const sourceUnavailableRunHomes = resolveRunUnavailableHomes(false);
    const groupCoverage = (workFilter.show === 'runs' || query.coverageComplete)
        && (!includesWorkflowRuns || options.corpusStorage === 'archived'
            || (workflowRunWindow?.status === 'loaded' && !workflowRunWindow.hasMore
                && !workflowRunWindow.loadingMore && (sourceUnavailableRunHomes?.length ?? 0) === 0))
        ? 'complete' as const : 'partial' as const;

    const recordingHiddenSessionKeys = useSessionListRecordingPrivacy(organizationListViewState, surfaceDataActive);

    const projectionInputs = React.useMemo<Omit<VisibleSessionListProjectionInputs, 'sessionRowStateByServerId'>>(() => ({
        source: source ?? [],
        attentionSource,
        includeNeedsYouEverywhere: options.includeNeedsYouEverywhere === true,
        fixedTeam: options.fixedTeam,
        fixedTeamQueryServerIds,
        attentionInteractionHeld: options.attentionInteractionHeld === true,
        supplementalNeedsYouSessionKeys: options.supplementalNeedsYouSessionKeys,
        workFilter,
        spaceMembership: options.spaceMembership,
        sessionTagIdsBySessionKey: organizationListViewState.sessionTagIdsBySessionKey,
        recordingHiddenSessionKeys,
        conditionValueCountRequest: surfaceDataActive ? options.conditionValueCountRequest : undefined,
        groupCoverage,
        querySectionIdsByServerId,
        workspaceRefs,
        viewerAccountIdByServerId,
        workflowRuns,
        workflowRunUnderSessionId: workflowRunsEnabled ? workflowRunUnderSessionId : undefined,
        hideInactiveSessions: hideInactiveSessions === true,
        serverFilteredInactiveServerIds,
        corpusStorage: options.corpusStorage ?? 'active',
        pinnedSessionKeysV1,
        sessionListLayoutChoice,
        sessionListAttentionPlacementV1,
        sessionAttentionStandingPolicy,
        backgroundWorkAttentionMode,
        normalizedGroupOrder,
        sessionListGroupOrderV1,
        normalizedWorkspaceOrder,
        sessionWorkspaceOrderV1,
        collapsedGroupKeysV1,
        sessionFoldersFeatureEnabled,
        selection,
        storageFilter,
        sessionSections,
        sessionFolderAssignmentsBySessionKey,
        retainWorkingSessionKeys: resolveRetainedWorkingSessionKeys(previousVisibleSessionListIndexForRetention),
    }), [
        collapsedGroupKeysV1,
        hideInactiveSessions,
        normalizedGroupOrder,
        normalizedWorkspaceOrder,
        options.corpusStorage,
        options.spaceMembership,
        organizationListViewState.sessionTagIdsBySessionKey,
        recordingHiddenSessionKeys,
        workflowRunUnderSessionId,
        options.attentionInteractionHeld,
        options.supplementalNeedsYouSessionKeys,
        options.includeNeedsYouEverywhere,
        options.fixedTeam,
        fixedTeamQueryServerIds,
        attentionSource,
        pinnedSessionKeysV1,
        previousVisibleSessionListIndexForRetention,
        selection,
        serverFilteredInactiveServerIds,
        sessionAttentionStandingPolicy,
        sessionFolderAssignmentsBySessionKey,
        sessionFoldersFeatureEnabled,
        sessionSections,
        sessionListGroupOrderV1,
        sessionListLayoutChoice,
        sessionListAttentionPlacementV1,
        backgroundWorkAttentionMode,
        sessionWorkspaceOrderV1,
        source,
        storageFilter,
        workFilter,
        options.conditionValueCountRequest,
        surfaceDataActive,
        groupCoverage,
        querySectionIdsByServerId,
        workspaceRefs,
        viewerAccountIdByServerId,
        workflowRuns,
    ]);

    // Select the ordered structure and its wake horizon before notifying React.
    // Row content belongs to the keyed row boundaries; an unchanged list must
    // not execute the list/sidebar subtree merely to discover it is unchanged.
    const selectProjection = React.useMemo(() => {
        let previousIndex = previousVisibleSessionListIndexForRetention;
        return (sessionRowStateByServerId: ReturnType<typeof useSessionListRowsByServerId>, rowChanges: SessionListRowChanges | null) => {
            const inputs = { ...projectionInputs, sessionRowStateByServerId };
            const cachedProjection = previousIndex
                ? retainedVisibleSessionListProjections.get(previousIndex)
                : undefined;
            // An inactive consumer keeps its last presentation without deriving
            // rows. The last active inputs stay in the cache so reactivation sees
            // every change made while this surface was inactive.
            if (!surfaceDataActive) {
                return {
                    visibleSessionListIndex: previousIndex,
                    nextRuntimeFreshnessAtMs: null,
                    hasHiddenInactiveSessions: cachedProjection?.hasHiddenInactiveSessions ?? false,
                    filterResult: cachedProjection?.filterResult ?? UNAVAILABLE_FILTER_RESULT,
                    conditionValueCounts: cachedProjection?.conditionValueCounts,
                    filterMatchedEntityIds: cachedProjection?.filterMatchedEntityIds ?? EMPTY_FILTER_ENTITY_IDS,
                    filterAttentionSupplementEntityIds: cachedProjection?.filterAttentionSupplementEntityIds ?? EMPTY_FILTER_ENTITY_IDS,
                    runFactsUnavailable: cachedProjection?.membership.runFactsUnavailable ?? false,
                };
            }
            if (
                previousIndex
                && cachedProjection
                && cachedProjection.collapseContextKey === options.collapseContextKey
                && (cachedProjection.validUntilMs === null || runtimeNowMs < cachedProjection.validUntilMs)
                && areVisibleSessionListProjectionInputsEqual(cachedProjection.inputs, inputs, rowChanges)
            ) {
                syncPerformanceTelemetry.count('sync.sessions.list.visible.retainedProjectionReused', {
                    items: previousIndex.length,
                });
                // Equal inputs: keep this projection current at these rows, so the next delta applies to them.
                if (cachedProjection.inputs.sessionRowStateByServerId !== sessionRowStateByServerId) {
                    retainedVisibleSessionListProjections.set(previousIndex, { ...cachedProjection, inputs });
                }
                return {
                    visibleSessionListIndex: previousIndex,
                    nextRuntimeFreshnessAtMs: cachedProjection.validUntilMs,
                    hasHiddenInactiveSessions: cachedProjection.hasHiddenInactiveSessions,
                    filterResult: cachedProjection.filterResult,
                    conditionValueCounts: cachedProjection.conditionValueCounts,
                    filterMatchedEntityIds: cachedProjection.filterMatchedEntityIds,
                    filterAttentionSupplementEntityIds: cachedProjection.filterAttentionSupplementEntityIds,
                    runFactsUnavailable: cachedProjection.membership.runFactsUnavailable,
                };
            }
            // A known row-level change: the store's delta names the rows changed since this projection's
            // rows, and every other input is unchanged. The projection owner then updates per row.
            const rowChange = previousIndex && cachedProjection && rowChanges
                && rowChanges.previousRows === cachedProjection.inputs.sessionRowStateByServerId
                && cachedProjection.collapseContextKey === options.collapseContextKey
                && (cachedProjection.validUntilMs === null || runtimeNowMs < cachedProjection.validUntilMs)
                && areVisibleSessionListProjectionInputsEqual(cachedProjection.inputs,
                    { ...inputs, sessionRowStateByServerId: cachedProjection.inputs.sessionRowStateByServerId }, null)
                ? { sessionIds: rowChanges.sessionIds, previousRows: rowChanges.previousRows, previous: {
                    // Read-only here: the owner returns it as the kept list, never mutates it.
                    items: previousIndex as SessionListIndexItem[], membership: cachedProjection.membership, filterResult: cachedProjection.filterResult,
                    matchedEntityIds: cachedProjection.filterMatchedEntityIds,
                    attentionSupplementEntityIds: cachedProjection.filterAttentionSupplementEntityIds,
                    conditionValueCounts: cachedProjection.conditionValueCounts,
                } } : undefined;
            const projection = !source && (!workflowRunWindow || workflowRunWindow.status === 'loading')
                ? null : buildVisibleSessionListIndex({
                        ...inputs,
                        rowChange,
                        previousMembership: cachedProjection?.membership,
                        // Explicit scope/view changes seed a new presentation. Row
                        // updates and interaction changes retain the mounted order.
                        previousPresentedIndex: cachedProjection
                            && cachedProjection.collapseContextKey === options.collapseContextKey
                            && cachedProjection.inputs.sessionListLayoutChoice === inputs.sessionListLayoutChoice
                            && cachedProjection.inputs.sessionListAttentionPlacementV1 === inputs.sessionListAttentionPlacementV1
                            && cachedProjection.inputs.corpusStorage === inputs.corpusStorage
                            && cachedProjection.inputs.storageFilter === inputs.storageFilter
                            && areViewerAccountScopesEqual(cachedProjection.inputs.viewerAccountIdByServerId, inputs.viewerAccountIdByServerId)
                            && sameStrictJsonValue(cachedProjection.inputs.workFilter, inputs.workFilter)
                            && sameStrictJsonValue(cachedProjection.inputs.spaceMembership, inputs.spaceMembership)
                            ? previousIndex : undefined,
                        nowMs: runtimeNowMs,
                    });
            const visibleSessionListIndex = projection
                ? reuseStableVisibleSessionListIndex(previousIndex, projection.items) : source;
            const nextFilterResult = projection?.filterResult ?? UNAVAILABLE_FILTER_RESULT;
            const filterResult = cachedProjection?.filterResult.matchedCount === nextFilterResult.matchedCount
                && cachedProjection.filterResult.coverage === nextFilterResult.coverage
                && cachedProjection.filterResult.attentionSupplementCount === nextFilterResult.attentionSupplementCount
                ? cachedProjection.filterResult : nextFilterResult;
            const retainEntityIds = (next: ReadonlySet<string>, previous?: ReadonlySet<string>) => previous
                && previous.size === next.size && [...next].every(id => previous.has(id)) ? previous : next;
            const filterMatchedEntityIds = retainEntityIds(projection?.matchedEntityIds ?? EMPTY_FILTER_ENTITY_IDS,
                cachedProjection?.filterMatchedEntityIds);
            const filterAttentionSupplementEntityIds = retainEntityIds(projection?.attentionSupplementEntityIds ?? EMPTY_FILTER_ENTITY_IDS,
                cachedProjection?.filterAttentionSupplementEntityIds);
            const resolveScopeId = captureServerProfileScopeResolver();
            let nextAtMs = visibleSessionListIndex
                ? resolveNextSessionAttentionReminderWakeAtMs(sessionAttentionStandingPolicy, runtimeNowMs) : null;
            for (const item of visibleSessionListIndex ?? []) {
                if (item.type !== 'session') continue;
                const row = readSessionListRowForServerId(sessionRowStateByServerId, item.serverId, item.sessionId, resolveScopeId);
                if (!row) continue;
                const expiresAtMs = readSessionListRowNextFreshnessAtMs(row, runtimeNowMs);
                if (expiresAtMs !== null) nextAtMs = nextAtMs === null ? expiresAtMs : Math.min(nextAtMs, expiresAtMs);
            }
            const hasHiddenInactiveSessions = Boolean(source && hideInactiveSessions
                && countSessionItems(visibleSessionListIndex) === 0
                && countSessionItems(buildVisibleSessionListIndex({ ...inputs, hideInactiveSessions: false,
                    previousMembership: projection?.membership, nowMs: runtimeNowMs }).items) > 0);
            if (visibleSessionListIndex && projection) {
                retainedVisibleSessionListProjections.set(visibleSessionListIndex, {
                    inputs,
                    collapseContextKey: options.collapseContextKey,
                    validUntilMs: nextAtMs,
                    hasHiddenInactiveSessions,
                    filterResult,
                    conditionValueCounts: projection.conditionValueCounts,
                    filterMatchedEntityIds,
                    filterAttentionSupplementEntityIds,
                    membership: projection.membership,
                });
            }
            previousIndex = visibleSessionListIndex;
            return { visibleSessionListIndex, nextRuntimeFreshnessAtMs: nextAtMs, hasHiddenInactiveSessions, filterResult,
                conditionValueCounts: projection?.conditionValueCounts,
                filterMatchedEntityIds, filterAttentionSupplementEntityIds,
                runFactsUnavailable: projection?.membership.runFactsUnavailable ?? false };
        };
    }, [previousVisibleSessionListIndexForRetention, projectionInputs, runtimeNowMs, source, workflowRunWindow?.status,
        surfaceDataActive, sessionAttentionStandingPolicy, hideInactiveSessions, options.collapseContextKey]);
    const { visibleSessionListIndex, nextRuntimeFreshnessAtMs, hasHiddenInactiveSessions, filterResult, conditionValueCounts, filterMatchedEntityIds, filterAttentionSupplementEntityIds, runFactsUnavailable } = useSessionListRowsByServerId(surfaceDataActive ? undefined : [], selectProjection);
    const workflowRunUnavailableHomes = React.useMemo(() => resolveRunUnavailableHomes(runFactsUnavailable),
        [options.corpusStorage, runServerId, selection.activeServerId, selection.allowedServerIds,
            surfaceDataActive, viewerAccountIdByServerId, workFilter, workflowWindow.rows, includesWorkflowRuns,
            workflowRunsEnabled, runFactsUnavailable]);
    React.useEffect(() => {
        previousVisibleSessionListIndexRef.current = visibleSessionListIndex;
    }, [visibleSessionListIndex]);
    useSessionListRuntimeWake(nextRuntimeFreshnessAtMs, surfaceDataActive, undefined, runtimeWakeToken);

    return React.useMemo(() => ({
        visibleSessionListIndex,
        filterResult,
        conditionValueCounts,
        filterMatchedEntityIds,
        filterAttentionSupplementEntityIds,
        hasHiddenInactiveSessions,
        folderFeatureEnabledServerIds,
        query,
        workflowRunWindow,
        workflowRunUnavailableHomes,
    }), [conditionValueCounts, filterResult, filterMatchedEntityIds, filterAttentionSupplementEntityIds, folderFeatureEnabledServerIds, hasHiddenInactiveSessions, query, visibleSessionListIndex, workflowRunWindow, workflowRunUnavailableHomes]);
}

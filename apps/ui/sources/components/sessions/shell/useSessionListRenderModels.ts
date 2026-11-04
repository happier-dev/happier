import { useSessionAudienceContext } from '@/hooks/teams/useSessionAudienceContext';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import * as React from 'react';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { ProjectOrganizationRow } from '@/sync/domains/workspaces/projectAccountRows';
import type { SessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import type { WorkspaceDisplayEllipsizeMode } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspacePathDisplayModeV1 } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    buildSessionListReachabilityRenderableKey,
    type SessionListReachabilityRenderable,
    useSessionListReachabilityRenderablesForItems,
    useSessionListRowRenderablesForItems,
    useMachineDisplayById,
} from '@/sync/domains/state/storage';

import { filterCollapsedSessionListItems } from './filterCollapsedSessionListItems';
import { buildSessionListProjectHeaderViewModels, type SessionListProjectHeaderViewModel } from './sessionListProjectHeaderViewModels';
import {
    buildSessionListReachabilitySummary,
    createSessionListReachabilitySummaryCache,
    retireSessionListReachabilitySummaryCacheServerScope,
} from './buildSessionListReachabilitySummary';
import { buildSessionListRowViewModels, type SessionListRowViewModel } from './sessionListRowViewModels';
import type { SessionAttentionStandingPolicy } from '@/sync/domains/session/organization/attentionStanding';
import {
    useSessionListRelativeNowMs,
    useSessionListRuntimeNowMs,
    useSessionListRuntimeWake,
} from '@/hooks/session/sessionListRuntimeClock';
import { normalizeSessionListShellState } from './normalizeSessionListShellState';
import {
    filterSessionListItemsForHeaderControls,
    projectSessionListItemsForHeaderControls,
    hasActiveSessionListHeaderFilters,
    type SessionListHeaderFilterInput,
} from './sessionListFilters';
import {
    appendSessionListSearchOtherMatches,
    resolveSessionListSearchOutsideMatches,
    type SessionListSearchOutsideMatch,
} from './search/sessionListSearchGroups';
import type { SessionListProjectHeaderViewModelState } from './sessionListProjectHeaderViewModels';
import type { VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    resolveSessionListRowStoreScopeKey,
    resolveSessionListRowStoreSubscriptionItemsWithUncachedRows,
} from './row/sessionListVisibleRowStoreScopes';
import { sessionTagKey } from './sessionTagUtils';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { nestSessionListReports } from '@/sync/domains/session/listing/nestSessionListReports';

type SessionReachableDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
}>;

const EMPTY_PINNED_KEY_SET: ReadonlySet<string> = new Set();
const EMPTY_SESSION_LIST_ROW_RENDERABLES_BY_KEY = new Map<string, SessionListRenderableSession>() as ReadonlyMap<string, SessionListRenderableSession>;

const EMPTY_SESSION_LIST_RENDER_MODELS = {
    listItems: [] as Array<SessionListIndexItem>,
    selectionScopeListItems: [] as Array<SessionListIndexItem>,
    reachableSessionDisplayById: new Map<string, SessionReachableDisplay>(),
    reachableSessionDisplayByKey: new Map<string, SessionReachableDisplay>(),
    hasMultipleMachines: false,
    projectHeaderViewModelState: {
        projectHeaderViewModelByGroupKey: new Map<string, SessionListProjectHeaderViewModel>(),
        scopeHintByLegacyWorkspaceKey: new Map<string, WorkspaceScopeBase>(),
        projectDisplayByKey: new Map(),
        groupProjectByGroupKey: new Map(),
    },
    rowViewModels: [] as ReadonlyArray<SessionListRowViewModel | null>,
    rowRenderableByKey: EMPTY_SESSION_LIST_ROW_RENDERABLES_BY_KEY,
    selectionScopeRowViewModels: [] as ReadonlyArray<SessionListRowViewModel | null>,
} satisfies Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    selectionScopeListItems: ReadonlyArray<SessionListIndexItem>;
    reachableSessionDisplayById: ReadonlyMap<string, SessionReachableDisplay>;
    reachableSessionDisplayByKey: ReadonlyMap<string, SessionReachableDisplay>;
    hasMultipleMachines: boolean;
    projectHeaderViewModelState: SessionListProjectHeaderViewModelState;
    rowViewModels: ReadonlyArray<SessionListRowViewModel | null>;
    rowRenderableByKey: ReadonlyMap<string, SessionListRenderableSession>;
    selectionScopeRowViewModels: ReadonlyArray<SessionListRowViewModel | null>;
}>;

function countSessionListItems(items: ReadonlyArray<SessionListIndexItem> | null | undefined): number {
    if (!items) return 0;
    let sessions = 0;
    for (const item of items) {
        if (item?.type === 'session') {
            sessions += 1;
        }
    }
    return sessions;
}

function countCollapsedSessionListGroups(collapsedGroupKeys: Readonly<Record<string, boolean>>): number {
    let groups = 0;
    for (const value of Object.values(collapsedGroupKeys)) {
        if (value === true) {
            groups += 1;
        }
    }
    return groups;
}

function buildSessionListItemKeySet(items: ReadonlyArray<SessionListIndexItem>): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const item of items) {
        if (item.type !== 'session' || !item.serverId) continue;
        keys.add(sessionTagKey(item.serverId, item.sessionId, item.keyParts));
    }
    return keys;
}

function measureSessionListRenderDerivation<T>(
    name: string,
    fields: () => Record<string, number>,
    fn: () => T,
): T {
    if (!syncPerformanceTelemetry.isEnabled()) return fn();
    return syncPerformanceTelemetry.measure(name, fields(), fn);
}

function resolveCachedSessionListRowRenderablesForItems(input: Readonly<{
    items: ReadonlyArray<SessionListIndexItem>;
    subscribedRowRenderableByKey: ReadonlyMap<string, SessionListRenderableSession>;
    cacheByKey: SessionListRetainedRenderableCache<SessionListRenderableSession>;
    credentialBindingsByServerId: ReadonlyMap<string, ServerCredentialAccountScopeBinding>;
}>): ReadonlyMap<string, SessionListRenderableSession> {
    const retentionByKey = buildSessionListRetentionByRowKey(input.items, input.credentialBindingsByServerId);
    for (const [key, renderable] of input.subscribedRowRenderableByKey) {
        const retention = retentionByKey.get(key);
        if (retention) input.cacheByKey.set(key, { ...retention, renderable });
    }

    if (input.items.length === 0) return EMPTY_SESSION_LIST_ROW_RENDERABLES_BY_KEY;

    const next = new Map<string, SessionListRenderableSession>();
    for (const item of input.items) {
        if (item.type !== 'session') continue;
        const key = resolveSessionListRowStoreScopeKey(item);
        if (!key) continue;
        const retention = retentionByKey.get(key);
        const cached = input.cacheByKey.get(key);
        if (cached && retention?.binding !== cached.binding) input.cacheByKey.delete(key);
        const renderable = input.subscribedRowRenderableByKey.get(key)
            ?? (cached && retention?.binding === cached.binding ? cached.renderable : null);
        if (!renderable) continue;
        next.set(key, renderable);
    }

    return next.size === 0 ? EMPTY_SESSION_LIST_ROW_RENDERABLES_BY_KEY : next;
}

const EMPTY_SESSION_LIST_REACHABILITY_RENDERABLES_BY_KEY =
    new Map<string, SessionListReachabilityRenderable>() as ReadonlyMap<string, SessionListReachabilityRenderable>;

function resolveCachedSessionListReachabilityRenderablesForItems(input: Readonly<{
    items: ReadonlyArray<SessionListIndexItem>;
    subscribedReachabilityRenderableByKey: ReadonlyMap<string, SessionListReachabilityRenderable>;
    cacheByKey: SessionListRetainedRenderableCache<SessionListReachabilityRenderable>;
    credentialBindingsByServerId: ReadonlyMap<string, ServerCredentialAccountScopeBinding>;
}>): ReadonlyMap<string, SessionListReachabilityRenderable> {
    const retentionByKey = buildSessionListRetentionByReachabilityKey(input.items, input.credentialBindingsByServerId);
    for (const [key, renderable] of input.subscribedReachabilityRenderableByKey) {
        const retention = retentionByKey.get(key);
        if (retention) input.cacheByKey.set(key, { ...retention, renderable });
    }

    if (input.items.length === 0) return EMPTY_SESSION_LIST_REACHABILITY_RENDERABLES_BY_KEY;

    const next = new Map<string, SessionListReachabilityRenderable>();
    for (const item of input.items) {
        if (item.type !== 'session') continue;
        const key = buildSessionListReachabilityRenderableKey(item.serverId, item.sessionId, item.keyParts);
        if (!key) continue;
        const retention = retentionByKey.get(key);
        const cached = input.cacheByKey.get(key);
        if (cached && retention?.binding !== cached.binding) input.cacheByKey.delete(key);
        const renderable = input.subscribedReachabilityRenderableByKey.get(key)
            ?? (cached && retention?.binding === cached.binding ? cached.renderable : null);
        if (!renderable) continue;
        next.set(key, renderable);
    }

    return next.size === 0 ? EMPTY_SESSION_LIST_REACHABILITY_RENDERABLES_BY_KEY : next;
}

type SessionListRenderableRetention = Readonly<{
    binding: ServerCredentialAccountScopeBinding | null;
    serverId: string | null;
}>;

type SessionListRetainedRenderableCache<T> = Map<string, SessionListRenderableRetention & Readonly<{
    renderable: T;
}>>;

function resolveCurrentCredentialBinding(
    bindings: ReadonlyMap<string, ServerCredentialAccountScopeBinding>,
    serverId: string | null | undefined,
): ServerCredentialAccountScopeBinding | null {
    if (!serverId) return null;
    const direct = bindings.get(serverId);
    if (direct?.isCurrent()) return direct;
    for (const [candidateServerId, binding] of bindings) {
        if (binding.isCurrent() && areServerProfileIdentifiersEquivalent(candidateServerId, serverId)) return binding;
    }
    return null;
}

function buildSessionListRetentionByRowKey(
    items: ReadonlyArray<SessionListIndexItem>,
    bindings: ReadonlyMap<string, ServerCredentialAccountScopeBinding>,
): ReadonlyMap<string, SessionListRenderableRetention> {
    const result = new Map<string, SessionListRenderableRetention>();
    for (const item of items) {
        if (item.type !== 'session') continue;
        const key = resolveSessionListRowStoreScopeKey(item);
        if (!key) continue;
        result.set(key, {
            binding: resolveCurrentCredentialBinding(bindings, item.serverId),
            serverId: item.serverId ?? null,
        });
    }
    return result;
}

function buildSessionListRetentionByReachabilityKey(
    items: ReadonlyArray<SessionListIndexItem>,
    bindings: ReadonlyMap<string, ServerCredentialAccountScopeBinding>,
): ReadonlyMap<string, SessionListRenderableRetention> {
    const result = new Map<string, SessionListRenderableRetention>();
    for (const item of items) {
        if (item.type !== 'session') continue;
        const key = buildSessionListReachabilityRenderableKey(item.serverId, item.sessionId, item.keyParts);
        if (!key) continue;
        result.set(key, {
            binding: resolveCurrentCredentialBinding(bindings, item.serverId),
            serverId: item.serverId ?? null,
        });
    }
    return result;
}

function retireSessionListRenderableCacheServerScope<T>(
    cache: SessionListRetainedRenderableCache<T>,
    serverId: string,
): void {
    for (const [key, entry] of cache) {
        if (entry.serverId && areServerProfileIdentifiersEquivalent(entry.serverId, serverId)) {
            cache.delete(key);
        }
    }
}

function hasSessionListRenderableForCurrentRetention<T>(
    cache: SessionListRetainedRenderableCache<T>,
    retentionByKey: ReadonlyMap<string, SessionListRenderableRetention>,
    key: string,
): boolean {
    const cached = cache.get(key);
    if (!cached) return false;
    if (cached.binding === retentionByKey.get(key)?.binding) return true;
    cache.delete(key);
    return false;
}

export type SessionListSearchOtherMatches = Readonly<{
    matches: ReadonlyArray<SessionListSearchOutsideMatch>;
    inThisViewTitle: string;
    otherMatchesTitle: string;
    resolveSessionRow?: Parameters<typeof nestSessionListReports>[1];
    resolveRunOriginSession?: Parameters<typeof nestSessionListReports>[2];
}>;

export function useSessionListRenderModels(input: Readonly<{
    paneState: VisibleSessionListPaneState;
    collapsedGroupKeys: Readonly<Record<string, boolean>>;
    machineDisplayById?: Readonly<Record<string, MachineDisplayRenderable>>;
    workspaceLabels: Readonly<Record<string, string>>;
    workspaceRefsServerId?: string;
    legacyWorkspaceLabelDisplayStatesByKey?: SessionOrganizationListViewState['labelDisplayStatesByKey'];
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    projectOrganizations?: readonly ProjectOrganizationRow[];
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    pinnedKeySet: ReadonlySet<string>;
    sessionTags: Readonly<Record<string, string[]>>;
    headerFilters?: SessionListHeaderFilterInput;
    /**
     * Transcript matches outside this list's own sessions, grouped after the in-view
     * results. Supplying them groups results; it never mutates the active filters.
     */
    searchOtherMatches?: SessionListSearchOtherMatches | null;
    selectedSessionId: string | null;
    selectedSessionServerId?: string | null;
    showServerBadge: boolean;
    showPinnedServerBadge: boolean;
    identityDisplay?: 'avatar' | 'agentLogo' | 'none' | null;
    activeColorMode?: 'activityAndAttention' | 'attentionOnly' | 'allActive' | null;
    hideInactiveSessions?: boolean | null;
    rowSubscriptionKeys?: ReadonlySet<string> | null;
    clocksActive?: boolean | null;
    rowViewModelMode?: 'list' | 'deferred' | null;
    attentionStandingEnabled?: boolean | null;
    attentionStandingPolicy?: SessionAttentionStandingPolicy | null;
}>) {
    const deriveRowViewModels = input.rowViewModelMode !== 'deferred';
    const pinnedKeySet = React.useMemo(() => (
        input.pinnedKeySet.size === 0 ? EMPTY_PINNED_KEY_SET : input.pinnedKeySet
    ), [input.pinnedKeySet]);
    const normalizedShellState = React.useMemo(() => {
        return normalizeSessionListShellState({
            collapsedGroupKeys: input.collapsedGroupKeys,
            sessionTags: input.sessionTags,
            workspaceLabels: input.workspaceLabels,
            workspaceRefs: input.workspaceRefs,
        });
    }, [input.collapsedGroupKeys, input.sessionTags, input.workspaceLabels, input.workspaceRefs]);

    const headerFiltersActive = hasActiveSessionListHeaderFilters(input.headerFilters);

    const visibleListItems = React.useMemo(() => {
        const items = input.paneState.visibleSessionListIndex;
        return measureSessionListRenderDerivation(
            'ui.sessionsList.render.collapsedFiltering',
            () => ({
                items: items?.length ?? 0,
                collapsedGroups: countCollapsedSessionListGroups(input.collapsedGroupKeys),
            }),
            () => {
                if (!items || items.length === 0) return items;
                if (headerFiltersActive) return items;
                return filterCollapsedSessionListItems(items, input.collapsedGroupKeys);
            },
        );
    }, [headerFiltersActive, input.collapsedGroupKeys, input.paneState.visibleSessionListIndex]);
    const selectionScopeProjection = React.useMemo(() => {
        const items = input.paneState.visibleSessionListIndex ?? [];
        return input.headerFilters ? projectSessionListItemsForHeaderControls(items, input.headerFilters)
            : { items: items as Array<SessionListIndexItem>, matchedEntityIds: EMPTY_PINNED_KEY_SET };
    }, [input.headerFilters, input.paneState.visibleSessionListIndex]);
    const selectionScopeListItems = selectionScopeProjection.items;
    const filterResult = React.useMemo(() => {
        const result = input.paneState.filterResult;
        const ordinary = input.paneState.filterMatchedEntityIds;
        if (!result || !ordinary || !headerFiltersActive) return result;
        const supplement = input.paneState.filterAttentionSupplementEntityIds;
        let matchedCount = 0;
        let attentionSupplementCount = 0;
        for (const id of selectionScopeProjection.matchedEntityIds) {
            if (ordinary.has(id)) matchedCount += 1;
            if (supplement?.has(id)) attentionSupplementCount += 1;
        }
        const nextSupplementCount = supplement ? attentionSupplementCount : result.attentionSupplementCount;
        return result.matchedCount === matchedCount && result.attentionSupplementCount === nextSupplementCount
            ? result : { ...result, matchedCount, attentionSupplementCount: nextSupplementCount };
    }, [headerFiltersActive, input.paneState.filterResult, input.paneState.filterMatchedEntityIds,
        input.paneState.filterAttentionSupplementEntityIds, selectionScopeProjection.matchedEntityIds]);
    const filteredListItems = React.useMemo(() => {
        if (!visibleListItems || !input.headerFilters) return visibleListItems;
        const filtered = visibleListItems === input.paneState.visibleSessionListIndex
            ? selectionScopeListItems : filterSessionListItemsForHeaderControls(visibleListItems, input.headerFilters);
        const otherMatches = input.searchOtherMatches;
        if (!otherMatches || otherMatches.matches.length === 0) return filtered;
        const outsideMatches = resolveSessionListSearchOutsideMatches({
            candidateSessionKeys: buildSessionListItemKeySet(visibleListItems),
            currentViewSessionKeys: buildSessionListItemKeySet(filtered),
            matchedSessionTargets: otherMatches.matches,
        });
        if (outsideMatches.length === 0) return filtered;
        return appendSessionListSearchOtherMatches({
            filteredItems: filtered,
            outsideMatches,
            inThisViewTitle: otherMatches.inThisViewTitle,
            otherMatchesTitle: otherMatches.otherMatchesTitle,
            resolveSessionRow: otherMatches.resolveSessionRow,
            resolveRunOriginSession: otherMatches.resolveRunOriginSession,
        });
    }, [input.headerFilters, input.searchOtherMatches, input.paneState.visibleSessionListIndex, selectionScopeListItems, visibleListItems]);
    const listItems = (filteredListItems ?? []) as Array<SessionListIndexItem>;
    const audienceAddresses = React.useMemo(() => selectionScopeListItems.flatMap((item) => {
        if (item.type !== 'session') return [];
        const address = normalizeSessionAddress(item.serverId, item.sessionId);
        return address ? [address] : [];
    }), [selectionScopeListItems]);
    const audience = useSessionAudienceContext(audienceAddresses);
    const rowRenderableCacheByKeyRef = React.useRef<SessionListRetainedRenderableCache<SessionListRenderableSession>>(new Map());
    const rowRetentionByKey = React.useMemo(() => (
        buildSessionListRetentionByRowKey(listItems, audience.credentialBindingsByServerId)
    ), [audience.credentialBindingsByServerId, listItems]);
    const rowSubscriptionItems = React.useMemo(() => (
        resolveSessionListRowStoreSubscriptionItemsWithUncachedRows(
            listItems,
            input.rowSubscriptionKeys ?? null,
            (key) => hasSessionListRenderableForCurrentRetention(
                rowRenderableCacheByKeyRef.current,
                rowRetentionByKey,
                key,
            ),
        )
    ), [input.rowSubscriptionKeys, listItems, rowRetentionByKey]);
    const reachabilityRenderableCacheByKeyRef = React.useRef<SessionListRetainedRenderableCache<SessionListReachabilityRenderable>>(new Map());
    const sessionReachabilitySummaryCacheRef = React.useRef(createSessionListReachabilitySummaryCache());
    const credentialRetirementsByServerIdRef = React.useRef(new Map<string, Readonly<{
        binding: ServerCredentialAccountScopeBinding;
        dispose(): void;
    }>>());
    React.useLayoutEffect(() => {
        for (const [serverId, retirement] of credentialRetirementsByServerIdRef.current) {
            const binding = audience.credentialBindingsByServerId.get(serverId);
            // Keep observing a lifetime after its last row leaves this render.
            // The retained viewport fallback still belongs to that binding and
            // must be evicted if the credential changes while the row is absent.
            if (!binding || binding === retirement.binding) continue;
            retirement.dispose();
            credentialRetirementsByServerIdRef.current.delete(serverId);
        }
        for (const [serverId, binding] of audience.credentialBindingsByServerId) {
            const current = credentialRetirementsByServerIdRef.current.get(serverId);
            if (current?.binding === binding) continue;
            const retirement = binding.onRetire(() => {
                retireSessionListRenderableCacheServerScope(rowRenderableCacheByKeyRef.current, serverId);
                retireSessionListRenderableCacheServerScope(reachabilityRenderableCacheByKeyRef.current, serverId);
                retireSessionListReachabilitySummaryCacheServerScope(
                    sessionReachabilitySummaryCacheRef.current,
                    serverId,
                );
                if (credentialRetirementsByServerIdRef.current.get(serverId)?.binding === binding) {
                    credentialRetirementsByServerIdRef.current.delete(serverId);
                }
            });
            if (!binding.isCurrent()) {
                retirement.dispose();
                continue;
            }
            credentialRetirementsByServerIdRef.current.set(serverId, {
                binding,
                dispose: retirement.dispose,
            });
        }
    }, [audience.credentialBindingsByServerId]);
    React.useLayoutEffect(() => () => {
        for (const retirement of credentialRetirementsByServerIdRef.current.values()) retirement.dispose();
        credentialRetirementsByServerIdRef.current.clear();
    }, []);
    const subscribedReachabilityRenderablesByKey = useSessionListReachabilityRenderablesForItems(rowSubscriptionItems);
    const reachabilityRenderablesByKey = React.useMemo(() => resolveCachedSessionListReachabilityRenderablesForItems({
        items: listItems,
        subscribedReachabilityRenderableByKey: subscribedReachabilityRenderablesByKey,
        cacheByKey: reachabilityRenderableCacheByKeyRef.current,
        credentialBindingsByServerId: audience.credentialBindingsByServerId,
    }), [audience.credentialBindingsByServerId, listItems, subscribedReachabilityRenderablesByKey]);
    const subscribedRowRenderableByKey = useSessionListRowRenderablesForItems(
        deriveRowViewModels ? rowSubscriptionItems : null,
    );
    const rowRenderableByKey = React.useMemo(() => resolveCachedSessionListRowRenderablesForItems({
        items: listItems,
        subscribedRowRenderableByKey,
        cacheByKey: rowRenderableCacheByKeyRef.current,
        credentialBindingsByServerId: audience.credentialBindingsByServerId,
    }), [audience.credentialBindingsByServerId, listItems, subscribedRowRenderableByKey]);
    const selectionScopeRowRenderableByKey = React.useMemo(() => resolveCachedSessionListRowRenderablesForItems({
        items: selectionScopeListItems,
        subscribedRowRenderableByKey,
        cacheByKey: rowRenderableCacheByKeyRef.current,
        credentialBindingsByServerId: audience.credentialBindingsByServerId,
    }), [audience.credentialBindingsByServerId, selectionScopeListItems, subscribedRowRenderableByKey]);
    // Deferred rows own their time-dependent presentation at the row boundary.
    const clocksActive = input.clocksActive !== false && deriveRowViewModels;
    const relativeNowMs = useSessionListRelativeNowMs(clocksActive);
    // Shared session-list runtime clock: rows must derive working freshness
    // from the SAME timestamp as group placement (useVisibleSessionListViewState)
    // so the indicator and the group can never cross a freshness boundary in
    // different render cycles. The wake horizon is contributed below from the
    // freshly built row view models.
    const runtimeNowMs = useSessionListRuntimeNowMs(clocksActive);

    const selectMachinePresentation = React.useMemo(() => {
        let previousMachines: Readonly<Record<string, MachineDisplayRenderable>> | undefined;
        let previousPresentation: Readonly<{
            sessionReachabilitySummary: ReturnType<typeof buildSessionListReachabilitySummary>;
            projectHeaderViewModelState: SessionListProjectHeaderViewModelState;
        }> | undefined;
        return (storeMachines: Record<string, MachineDisplayRenderable>) => {
            const machines = input.machineDisplayById ?? storeMachines;
            if (machines === previousMachines && previousPresentation) return previousPresentation;
            const sessionReachabilitySummary = measureSessionListRenderDerivation(
                'ui.sessionsList.render.reachabilityDisplayMap',
                () => ({
                    items: listItems.length,
                    machines: Object.keys(machines).length,
                    displayRows: countSessionListItems(listItems),
                }),
                () => buildSessionListReachabilitySummary({
                    cache: sessionReachabilitySummaryCacheRef.current,
                    listItems,
                    machinesById: machines,
                    renderablesByKey: reachabilityRenderablesByKey,
                    workspaceRefs: normalizedShellState.workspaceRefs,
                    workspacePathDisplayModeV1: input.workspacePathDisplayModeV1,
                    resolveSessionRenderable: (item) => {
                        const key = buildSessionListReachabilityRenderableKey(item.serverId, item.sessionId, item.keyParts);
                        return key ? reachabilityRenderablesByKey.get(key) ?? null : null;
                    },
                }),
            );
            const projectHeaderViewModelState = buildSessionListProjectHeaderViewModels({
                listItems,
                machinesById: machines,
                projectOrganizations: input.projectOrganizations,
                workspaceLabels: normalizedShellState.workspaceLabels,
                workspaceRefsServerId: input.workspaceRefsServerId,
                legacyWorkspaceLabelDisplayStatesByKey: input.legacyWorkspaceLabelDisplayStatesByKey,
                workspaceRefs: normalizedShellState.workspaceRefs,
                workspacePathDisplayModeV1: input.workspacePathDisplayModeV1,
            });
            previousMachines = machines;
            previousPresentation = { sessionReachabilitySummary, projectHeaderViewModelState };
            return previousPresentation;
        };
    }, [input.machineDisplayById, input.workspacePathDisplayModeV1, input.projectOrganizations,
        input.workspaceRefsServerId, input.legacyWorkspaceLabelDisplayStatesByKey, normalizedShellState.workspaceLabels, listItems,
        normalizedShellState.workspaceRefs, reachabilityRenderablesByKey]);
    const { sessionReachabilitySummary, projectHeaderViewModelState } = useMachineDisplayById(selectMachinePresentation);

    const rowViewModels = React.useMemo(() => {
        if (!deriveRowViewModels) {
            return listItems.length === 0
                ? [] as ReadonlyArray<SessionListRowViewModel | null>
                : listItems.map(() => null);
        }
        return measureSessionListRenderDerivation(
            'ui.sessionsList.render.selectedMapping',
            () => ({
                items: listItems.length,
                selectable: input.selectedSessionId ? 1 : 0,
            }),
            () => buildSessionListRowViewModels({
                audienceScopes: audience.scopes,
                listItems,
                reachableSessionDisplayById: sessionReachabilitySummary.displayById,
                reachableSessionDisplayByKey: sessionReachabilitySummary.displayByKey,
                rowRenderableByKey,
                relativeNowMs,
                runtimeNowMs,
                identityDisplay: input.identityDisplay === 'agentLogo' || input.identityDisplay === 'none' ? input.identityDisplay : 'avatar',
                activeColorMode: input.activeColorMode === 'attentionOnly' || input.activeColorMode === 'allActive'
                    ? input.activeColorMode
                    : 'activityAndAttention',
                hideInactiveSessions: input.hideInactiveSessions === true,
                pinnedSessionKeys: pinnedKeySet,
                sessionTags: normalizedShellState.sessionTags,
                selectedSessionId: input.selectedSessionId,
                selectedSessionServerId: input.selectedSessionServerId,
                showServerBadge: input.showServerBadge,
                showPinnedServerBadge: input.showPinnedServerBadge,
                attentionStandingEnabled: input.attentionStandingEnabled === true,
                attentionStandingPolicy: input.attentionStandingPolicy ?? undefined,
            }),
        );
    }, [
        pinnedKeySet,
        input.attentionStandingEnabled,
        input.attentionStandingPolicy,
        input.selectedSessionId,
        input.selectedSessionServerId,
        input.showPinnedServerBadge,
        input.showServerBadge,
        input.activeColorMode,
        input.hideInactiveSessions,
        input.identityDisplay,
        deriveRowViewModels,
        audience,
        listItems,
        normalizedShellState.sessionTags,
        relativeNowMs,
        rowRenderableByKey,
        runtimeNowMs,
        sessionReachabilitySummary.displayByKey,
        sessionReachabilitySummary.displayById,
    ]);
    const selectionScopeRowViewModels = React.useMemo(() => {
        if (!deriveRowViewModels) {
            return selectionScopeListItems.length === 0
                ? [] as ReadonlyArray<SessionListRowViewModel | null>
                : selectionScopeListItems.map(() => null);
        }
        if (selectionScopeListItems.length === 0) return [] as ReadonlyArray<SessionListRowViewModel | null>;
        return buildSessionListRowViewModels({
            audienceScopes: audience.scopes,
            listItems: selectionScopeListItems,
            reachableSessionDisplayById: sessionReachabilitySummary.displayById,
            reachableSessionDisplayByKey: sessionReachabilitySummary.displayByKey,
            rowRenderableByKey: selectionScopeRowRenderableByKey,
            relativeNowMs,
            runtimeNowMs,
            identityDisplay: input.identityDisplay === 'agentLogo' || input.identityDisplay === 'none' ? input.identityDisplay : 'avatar',
            activeColorMode: input.activeColorMode === 'attentionOnly' || input.activeColorMode === 'allActive'
                ? input.activeColorMode
                : 'activityAndAttention',
            hideInactiveSessions: input.hideInactiveSessions === true,
            pinnedSessionKeys: pinnedKeySet,
            sessionTags: normalizedShellState.sessionTags,
            selectedSessionId: input.selectedSessionId,
            selectedSessionServerId: input.selectedSessionServerId,
            showServerBadge: input.showServerBadge,
            showPinnedServerBadge: input.showPinnedServerBadge,
            attentionStandingEnabled: input.attentionStandingEnabled === true,
            attentionStandingPolicy: input.attentionStandingPolicy ?? undefined,
        });
    }, [
        input.activeColorMode,
        input.attentionStandingEnabled,
        input.attentionStandingPolicy,
        input.hideInactiveSessions,
        input.identityDisplay,
        input.selectedSessionId,
        input.selectedSessionServerId,
        input.showPinnedServerBadge,
        input.showServerBadge,
        deriveRowViewModels,
        audience,
        normalizedShellState.sessionTags,
        pinnedKeySet,
        relativeNowMs,
        runtimeNowMs,
        selectionScopeListItems,
        selectionScopeRowRenderableByKey,
        sessionReachabilitySummary.displayById,
        sessionReachabilitySummary.displayByKey,
    ]);

    const nextRuntimeFreshnessAtMs = React.useMemo(() => {
        if (!deriveRowViewModels) return null;
        let nextFreshnessAt: number | null = null;
        for (const rowViewModel of rowViewModels) {
            const candidate = rowViewModel?.nextRuntimeFreshnessAtMs ?? null;
            if (candidate === null) continue;
            nextFreshnessAt = nextFreshnessAt === null ? candidate : Math.min(nextFreshnessAt, candidate);
        }
        return nextFreshnessAt;
    }, [deriveRowViewModels, rowViewModels]);
    useSessionListRuntimeWake(nextRuntimeFreshnessAtMs, clocksActive);

    return React.useMemo(() => {
        if (listItems.length === 0 && selectionScopeListItems.length === 0) {
            return { ...EMPTY_SESSION_LIST_RENDER_MODELS, audience, filterResult };
        }

        return {
            audience,
            filterResult,
            listItems,
            selectionScopeListItems,
            reachableSessionDisplayById: sessionReachabilitySummary.displayById,
            reachableSessionDisplayByKey: sessionReachabilitySummary.displayByKey,
            hasMultipleMachines: sessionReachabilitySummary.hasMultipleMachines,
            projectHeaderViewModelState,
            rowViewModels,
            rowRenderableByKey,
            selectionScopeRowViewModels,
        };
    }, [
        audience,
        filterResult,
        listItems,
        projectHeaderViewModelState,
        rowViewModels,
        rowRenderableByKey,
        selectionScopeListItems,
        selectionScopeRowViewModels,
        sessionReachabilitySummary.displayById,
        sessionReachabilitySummary.displayByKey,
        sessionReachabilitySummary.hasMultipleMachines,
    ]);
}

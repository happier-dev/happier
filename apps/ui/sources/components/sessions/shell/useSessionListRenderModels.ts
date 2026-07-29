import * as React from 'react';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { WorkspaceDisplayEllipsizeMode } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspacePathDisplayModeV1 } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    buildSessionListReachabilityRenderableKey,
    type SessionListReachabilityRenderable,
    useSessionListReachabilityRenderablesForItems,
    useSessionListRowRenderablesForItems,
} from '@/sync/domains/state/storage';

import { filterCollapsedSessionListItems } from './filterCollapsedSessionListItems';
import { buildSessionListProjectHeaderViewModels, type SessionListProjectHeaderViewModel } from './sessionListProjectHeaderViewModels';
import {
    buildSessionListReachabilitySummary,
    createSessionListReachabilitySummaryCache,
} from './buildSessionListReachabilitySummary';
import { buildSessionListRowViewModels, type SessionListRowViewModel } from './sessionListRowViewModels';
import { useSessionListRelativeNowMs } from './sessionListRowClocks';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';
import type { SessionWorkingTextMode } from '@/utils/sessions/sessionUtils';
import { normalizeSessionListShellState } from './normalizeSessionListShellState';
import {
    filterSessionListItemsForHeaderControls,
    hasActiveSessionListHeaderFilters,
    type SessionListHeaderFilterInput,
} from './sessionListFilters';
import type { SessionListProjectHeaderViewModelState } from './sessionListProjectHeaderViewModels';
import type { VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    resolveSessionListRowStoreScopeKey,
    resolveSessionListRowStoreSubscriptionItemsWithUncachedRows,
} from './row/sessionListVisibleRowStoreScopes';

type SessionReachableDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
}>;

const EMPTY_PINNED_KEY_SET: ReadonlySet<string> = new Set();
const EMPTY_MACHINE_DISPLAY_BY_ID_MAP = new Map<string, MachineDisplayRenderable>();
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
    cacheByKey: Map<string, SessionListRenderableSession>;
}>): ReadonlyMap<string, SessionListRenderableSession> {
    for (const [key, renderable] of input.subscribedRowRenderableByKey) {
        input.cacheByKey.set(key, renderable);
    }

    if (input.items.length === 0) return EMPTY_SESSION_LIST_ROW_RENDERABLES_BY_KEY;

    const next = new Map<string, SessionListRenderableSession>();
    for (const item of input.items) {
        if (item.type !== 'session') continue;
        const key = resolveSessionListRowStoreScopeKey({
            sessionId: item.sessionId,
            serverId: item.serverId ?? null,
        });
        if (!key) continue;
        const renderable = input.subscribedRowRenderableByKey.get(key) ?? input.cacheByKey.get(key) ?? null;
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
    cacheByKey: Map<string, SessionListReachabilityRenderable>;
}>): ReadonlyMap<string, SessionListReachabilityRenderable> {
    for (const [key, renderable] of input.subscribedReachabilityRenderableByKey) {
        input.cacheByKey.set(key, renderable);
    }

    if (input.items.length === 0) return EMPTY_SESSION_LIST_REACHABILITY_RENDERABLES_BY_KEY;

    const next = new Map<string, SessionListReachabilityRenderable>();
    for (const item of input.items) {
        if (item.type !== 'session') continue;
        const key = buildSessionListReachabilityRenderableKey(item.serverId, item.sessionId);
        if (!key) continue;
        const renderable = input.subscribedReachabilityRenderableByKey.get(key) ?? input.cacheByKey.get(key) ?? null;
        if (!renderable) continue;
        next.set(key, renderable);
    }

    return next.size === 0 ? EMPTY_SESSION_LIST_REACHABILITY_RENDERABLES_BY_KEY : next;
}

export function useSessionListRenderModels(input: Readonly<{
    paneState: VisibleSessionListPaneState;
    collapsedGroupKeys: Readonly<Record<string, boolean>>;
    machineDisplayById: Readonly<Record<string, MachineDisplayRenderable>>;
    workspaceLabels: Readonly<Record<string, string>>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    pinnedKeySet: ReadonlySet<string>;
    sessionTags: Readonly<Record<string, string[]>>;
    headerFilters?: SessionListHeaderFilterInput;
    selectedSessionId: string | null;
    showServerBadge: boolean;
    showPinnedServerBadge: boolean;
    workingIndicatorMode?: 'spinner' | 'pulse' | null;
    workingTextMode?: SessionWorkingTextMode | null;
    identityDisplay?: 'avatar' | 'agentLogo' | 'none' | null;
    activeColorMode?: 'activityAndAttention' | 'attentionOnly' | 'allActive' | null;
    hideInactiveSessions?: boolean | null;
    rowSubscriptionKeys?: ReadonlySet<string> | null;
    clocksActive?: boolean | null;
    rowViewModelMode?: 'list' | 'deferred' | null;
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

    const machinesById = React.useMemo(() => {
        const entries = Object.entries(input.machineDisplayById);
        return entries.length === 0
            ? EMPTY_MACHINE_DISPLAY_BY_ID_MAP
            : new Map(entries);
    }, [input.machineDisplayById]);

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
    const filteredListItems = React.useMemo(() => {
        if (!visibleListItems || !input.headerFilters) return visibleListItems;
        return filterSessionListItemsForHeaderControls(visibleListItems, {
            ...input.headerFilters,
            sessionTags: normalizedShellState.sessionTags,
        });
    }, [input.headerFilters, normalizedShellState.sessionTags, visibleListItems]);
    const listItems = (filteredListItems ?? []) as Array<SessionListIndexItem>;
    const selectionScopeListItems = React.useMemo(() => {
        const items = input.paneState.visibleSessionListIndex;
        if (!items || items.length === 0) return [] as Array<SessionListIndexItem>;
        if (!input.headerFilters) return items as Array<SessionListIndexItem>;
        return filterSessionListItemsForHeaderControls(items, {
            ...input.headerFilters,
            sessionTags: normalizedShellState.sessionTags,
        });
    }, [input.headerFilters, input.paneState.visibleSessionListIndex, normalizedShellState.sessionTags]);
    const rowRenderableCacheByKeyRef = React.useRef(new Map<string, SessionListRenderableSession>());
    const rowSubscriptionItems = React.useMemo(() => (
        resolveSessionListRowStoreSubscriptionItemsWithUncachedRows(
            listItems,
            input.rowSubscriptionKeys ?? null,
            (key) => rowRenderableCacheByKeyRef.current.has(key),
        )
    ), [input.rowSubscriptionKeys, listItems]);
    const reachabilityRenderableCacheByKeyRef = React.useRef(new Map<string, SessionListReachabilityRenderable>());
    const subscribedReachabilityRenderablesByKey = useSessionListReachabilityRenderablesForItems(rowSubscriptionItems);
    const reachabilityRenderablesByKey = React.useMemo(() => resolveCachedSessionListReachabilityRenderablesForItems({
        items: listItems,
        subscribedReachabilityRenderableByKey: subscribedReachabilityRenderablesByKey,
        cacheByKey: reachabilityRenderableCacheByKeyRef.current,
    }), [listItems, subscribedReachabilityRenderablesByKey]);
    const subscribedRowRenderableByKey = useSessionListRowRenderablesForItems(
        deriveRowViewModels ? rowSubscriptionItems : null,
    );
    const rowRenderableByKey = React.useMemo(() => resolveCachedSessionListRowRenderablesForItems({
        items: listItems,
        subscribedRowRenderableByKey,
        cacheByKey: rowRenderableCacheByKeyRef.current,
    }), [listItems, subscribedRowRenderableByKey]);
    const selectionScopeRowRenderableByKey = React.useMemo(() => resolveCachedSessionListRowRenderablesForItems({
        items: selectionScopeListItems,
        subscribedRowRenderableByKey,
        cacheByKey: rowRenderableCacheByKeyRef.current,
    }), [selectionScopeListItems, subscribedRowRenderableByKey]);
    const clocksActive = input.clocksActive !== false;
    const relativeNowMs = useSessionListRelativeNowMs(clocksActive);
    // Shared session-list runtime clock: rows must derive working freshness
    // from the SAME timestamp as group placement (useVisibleSessionListViewState)
    // so the indicator and the group can never cross a freshness boundary in
    // different render cycles. The wake horizon is contributed below from the
    // freshly built row view models.
    const runtimeNowMs = useSessionListRuntimeNowMs(clocksActive);

    const sessionReachabilitySummaryCacheRef = React.useRef(createSessionListReachabilitySummaryCache());
    const sessionReachabilitySummary = React.useMemo(() => {
        return measureSessionListRenderDerivation(
            'ui.sessionsList.render.reachabilityDisplayMap',
            () => ({
                items: listItems.length,
                machines: machinesById.size,
                displayRows: countSessionListItems(listItems),
            }),
            () => buildSessionListReachabilitySummary({
                cache: sessionReachabilitySummaryCacheRef.current,
                listItems,
                machinesById,
                workspaceRefs: normalizedShellState.workspaceRefs,
                workspacePathDisplayModeV1: input.workspacePathDisplayModeV1,
                resolveSessionRenderable: (item) => {
                    const key = buildSessionListReachabilityRenderableKey(item.serverId, item.sessionId);
                    return key ? reachabilityRenderablesByKey.get(key) ?? null : null;
                },
            }),
        );
    }, [input.workspacePathDisplayModeV1, listItems, machinesById, normalizedShellState.workspaceRefs, reachabilityRenderablesByKey]);

    const projectHeaderViewModelState = React.useMemo(() => {
        return buildSessionListProjectHeaderViewModels({
            listItems,
            workspaceLabels: normalizedShellState.workspaceLabels,
            workspaceRefs: normalizedShellState.workspaceRefs,
            workspacePathDisplayModeV1: input.workspacePathDisplayModeV1,
        });
    }, [input.workspacePathDisplayModeV1, listItems, normalizedShellState.workspaceLabels, normalizedShellState.workspaceRefs]);

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
                listItems,
                reachableSessionDisplayById: sessionReachabilitySummary.displayById,
                reachableSessionDisplayByKey: sessionReachabilitySummary.displayByKey,
                rowRenderableByKey,
                relativeNowMs,
                runtimeNowMs,
                workingIndicatorMode: input.workingIndicatorMode === 'pulse' ? 'pulse' : 'spinner',
                workingTextMode: input.workingTextMode === 'static' ? 'static' : 'animated',
                identityDisplay: input.identityDisplay === 'agentLogo' || input.identityDisplay === 'none' ? input.identityDisplay : 'avatar',
                activeColorMode: input.activeColorMode === 'attentionOnly' || input.activeColorMode === 'allActive'
                    ? input.activeColorMode
                    : 'activityAndAttention',
                hideInactiveSessions: input.hideInactiveSessions === true,
                hasMultipleMachines: sessionReachabilitySummary.hasMultipleMachines,
                pinnedSessionKeys: pinnedKeySet,
                sessionTags: normalizedShellState.sessionTags,
                selectedSessionId: input.selectedSessionId,
                showServerBadge: input.showServerBadge,
                showPinnedServerBadge: input.showPinnedServerBadge,
            }),
        );
    }, [
        pinnedKeySet,
        input.selectedSessionId,
        input.showPinnedServerBadge,
        input.showServerBadge,
        input.activeColorMode,
        input.hideInactiveSessions,
        input.identityDisplay,
        input.workingTextMode,
        input.workingIndicatorMode,
        deriveRowViewModels,
        listItems,
        normalizedShellState.sessionTags,
        relativeNowMs,
        rowRenderableByKey,
        runtimeNowMs,
        sessionReachabilitySummary.displayByKey,
        sessionReachabilitySummary.displayById,
        sessionReachabilitySummary.hasMultipleMachines,
    ]);
    const selectionScopeRowViewModels = React.useMemo(() => {
        if (!deriveRowViewModels) {
            return selectionScopeListItems.length === 0
                ? [] as ReadonlyArray<SessionListRowViewModel | null>
                : selectionScopeListItems.map(() => null);
        }
        if (selectionScopeListItems.length === 0) return [] as ReadonlyArray<SessionListRowViewModel | null>;
        return buildSessionListRowViewModels({
            listItems: selectionScopeListItems,
            reachableSessionDisplayById: sessionReachabilitySummary.displayById,
            reachableSessionDisplayByKey: sessionReachabilitySummary.displayByKey,
            rowRenderableByKey: selectionScopeRowRenderableByKey,
            relativeNowMs,
            runtimeNowMs,
            workingIndicatorMode: input.workingIndicatorMode === 'pulse' ? 'pulse' : 'spinner',
            workingTextMode: input.workingTextMode === 'static' ? 'static' : 'animated',
            identityDisplay: input.identityDisplay === 'agentLogo' || input.identityDisplay === 'none' ? input.identityDisplay : 'avatar',
            activeColorMode: input.activeColorMode === 'attentionOnly' || input.activeColorMode === 'allActive'
                ? input.activeColorMode
                : 'activityAndAttention',
            hideInactiveSessions: input.hideInactiveSessions === true,
            hasMultipleMachines: sessionReachabilitySummary.hasMultipleMachines,
            pinnedSessionKeys: pinnedKeySet,
            sessionTags: normalizedShellState.sessionTags,
            selectedSessionId: input.selectedSessionId,
            showServerBadge: input.showServerBadge,
            showPinnedServerBadge: input.showPinnedServerBadge,
        });
    }, [
        input.activeColorMode,
        input.hideInactiveSessions,
        input.identityDisplay,
        input.selectedSessionId,
        input.showPinnedServerBadge,
        input.showServerBadge,
        input.workingTextMode,
        input.workingIndicatorMode,
        deriveRowViewModels,
        normalizedShellState.sessionTags,
        pinnedKeySet,
        relativeNowMs,
        runtimeNowMs,
        selectionScopeListItems,
        selectionScopeRowRenderableByKey,
        sessionReachabilitySummary.displayById,
        sessionReachabilitySummary.displayByKey,
        sessionReachabilitySummary.hasMultipleMachines,
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
            return EMPTY_SESSION_LIST_RENDER_MODELS;
        }

        return {
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

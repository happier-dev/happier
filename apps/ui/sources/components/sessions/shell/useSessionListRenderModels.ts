import * as React from 'react';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { WorkspaceDisplayEllipsizeMode } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { useSessionListRowStateByServerId } from '@/sync/domains/state/storage';

import { filterCollapsedSessionListItems } from './filterCollapsedSessionListItems';
import { buildSessionListProjectHeaderViewModels, type SessionListProjectHeaderViewModel } from './sessionListProjectHeaderViewModels';
import { buildSessionListReachabilitySummary } from './buildSessionListReachabilitySummary';
import { buildSessionListRowViewModels, type SessionListRowViewModel } from './sessionListRowViewModels';
import { normalizeSessionListShellState } from './normalizeSessionListShellState';
import type { SessionListProjectHeaderViewModelState } from './sessionListProjectHeaderViewModels';
import type { VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

type SessionReachableDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
}>;

const EMPTY_PINNED_KEY_SET: ReadonlySet<string> = new Set();

const EMPTY_SESSION_LIST_RENDER_MODELS = {
    listItems: [] as Array<SessionListIndexItem>,
    reachableSessionDisplayById: new Map<string, SessionReachableDisplay>(),
    hasMultipleMachines: false,
    projectHeaderViewModelState: {
        projectHeaderViewModelByGroupKey: new Map<string, SessionListProjectHeaderViewModel>(),
        scopeHintByLegacyWorkspaceKey: new Map<string, WorkspaceScopeBase>(),
    },
    rowViewModels: [] as ReadonlyArray<SessionListRowViewModel | null>,
} satisfies Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    reachableSessionDisplayById: ReadonlyMap<string, SessionReachableDisplay>;
    hasMultipleMachines: boolean;
    projectHeaderViewModelState: SessionListProjectHeaderViewModelState;
    rowViewModels: ReadonlyArray<SessionListRowViewModel | null>;
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

export function useSessionListRenderModels(input: Readonly<{
    paneState: VisibleSessionListPaneState;
    collapsedGroupKeys: Readonly<Record<string, boolean>>;
    allMachines: ReadonlyArray<Machine>;
    workspaceLabels: Readonly<Record<string, string>>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    pinnedKeySet: ReadonlySet<string>;
    sessionTags: Readonly<Record<string, string[]>>;
    selectedSessionId: string | null;
    showServerBadge: boolean;
    showPinnedServerBadge: boolean;
}>) {
    const sessionRowStateByServerId = useSessionListRowStateByServerId();
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
        return new Map(input.allMachines.map((machine) => [machine.id, machine] as const));
    }, [input.allMachines]);

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
                return filterCollapsedSessionListItems(items, input.collapsedGroupKeys);
            },
        );
    }, [input.collapsedGroupKeys, input.paneState.visibleSessionListIndex]);
    const listItems = (visibleListItems ?? []) as Array<SessionListIndexItem>;

    const sessionReachabilitySummary = React.useMemo(() => {
        return measureSessionListRenderDerivation(
            'ui.sessionsList.render.reachabilityDisplayMap',
            () => ({
                items: listItems.length,
                machines: machinesById.size,
                displayRows: countSessionListItems(listItems),
            }),
            () => buildSessionListReachabilitySummary({
                listItems,
                machinesById,
                workspaceRefs: normalizedShellState.workspaceRefs,
                resolveSessionRenderable: (item) => {
                    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
                    const sessionId = String(item.sessionId ?? '').trim();
                    if (!serverId || !sessionId) return null;
                    const scoped = sessionRowStateByServerId?.[serverId];
                    if (!scoped || typeof scoped !== 'object') return null;
                    return scoped[sessionId] ?? null;
                },
            }),
        );
    }, [listItems, machinesById, normalizedShellState.workspaceRefs, sessionRowStateByServerId]);

    const projectHeaderViewModelState = React.useMemo(() => {
        return buildSessionListProjectHeaderViewModels({
            listItems,
            workspaceLabels: normalizedShellState.workspaceLabels,
            workspaceRefs: normalizedShellState.workspaceRefs,
        });
    }, [listItems, normalizedShellState.workspaceLabels, normalizedShellState.workspaceRefs]);

    const rowViewModels = React.useMemo(() => {
        return measureSessionListRenderDerivation(
            'ui.sessionsList.render.selectedMapping',
            () => ({
                items: listItems.length,
                selectable: input.selectedSessionId ? 1 : 0,
            }),
            () => buildSessionListRowViewModels({
                listItems,
                reachableSessionDisplayById: sessionReachabilitySummary.displayById,
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
        listItems,
        normalizedShellState.sessionTags,
        sessionReachabilitySummary.displayById,
        sessionReachabilitySummary.hasMultipleMachines,
    ]);

    return React.useMemo(() => {
        if (listItems.length === 0) {
            return EMPTY_SESSION_LIST_RENDER_MODELS;
        }

        return {
            listItems,
            reachableSessionDisplayById: sessionReachabilitySummary.displayById,
            hasMultipleMachines: sessionReachabilitySummary.hasMultipleMachines,
            projectHeaderViewModelState,
            rowViewModels,
        };
    }, [
        listItems,
        projectHeaderViewModelState,
        rowViewModels,
        sessionReachabilitySummary.displayById,
        sessionReachabilitySummary.hasMultipleMachines,
    ]);
}

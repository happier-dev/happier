import * as React from 'react';

import type { SessionListViewItem } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

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
    pathSubtitle: string;
}>;

const EMPTY_SESSION_LIST_RENDER_MODELS = {
    listItems: [] as Array<SessionListViewItem>,
    reachableSessionDisplayById: new Map<string, SessionReachableDisplay>(),
    hasMultipleMachines: false,
    projectHeaderViewModelState: {
        projectHeaderViewModelByGroupKey: new Map<string, SessionListProjectHeaderViewModel>(),
        scopeHintByLegacyWorkspaceKey: new Map<string, WorkspaceScopeBase>(),
    },
    rowViewModels: [] as ReadonlyArray<SessionListRowViewModel | null>,
} satisfies Readonly<{
    listItems: ReadonlyArray<SessionListViewItem>;
    reachableSessionDisplayById: ReadonlyMap<string, SessionReachableDisplay>;
    hasMultipleMachines: boolean;
    projectHeaderViewModelState: SessionListProjectHeaderViewModelState;
    rowViewModels: ReadonlyArray<SessionListRowViewModel | null>;
}>;

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
    const normalizedShellState = normalizeSessionListShellState({
        collapsedGroupKeys: input.collapsedGroupKeys,
        sessionTags: input.sessionTags,
        workspaceLabels: input.workspaceLabels,
        workspaceRefs: input.workspaceRefs,
    });

    const machinesById = React.useMemo(() => {
        return new Map(input.allMachines.map((machine) => [machine.id, machine] as const));
    }, [input.allMachines]);

    const visibleListItems = React.useMemo(() => {
        const items = input.paneState.visibleSessionListViewData;
        if (!items || items.length === 0) return items;
        return filterCollapsedSessionListItems(items, input.collapsedGroupKeys);
    }, [input.collapsedGroupKeys, input.paneState.visibleSessionListViewData]);
    const listItems = (visibleListItems ?? []) as Array<SessionListViewItem>;

    const sessionReachabilitySummary = buildSessionListReachabilitySummary({
        listItems,
        machinesById,
    });

    const projectHeaderViewModelState = buildSessionListProjectHeaderViewModels({
        listItems,
        workspaceLabels: normalizedShellState.workspaceLabels,
        workspaceRefs: normalizedShellState.workspaceRefs,
    });

    const rowViewModels = buildSessionListRowViewModels({
        listItems,
        reachableSessionDisplayById: sessionReachabilitySummary.displayById,
        hasMultipleMachines: sessionReachabilitySummary.hasMultipleMachines,
        pinnedSessionKeys: input.pinnedKeySet,
        sessionTags: normalizedShellState.sessionTags,
        selectedSessionId: input.selectedSessionId,
        showServerBadge: input.showServerBadge,
        showPinnedServerBadge: input.showPinnedServerBadge,
    });

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

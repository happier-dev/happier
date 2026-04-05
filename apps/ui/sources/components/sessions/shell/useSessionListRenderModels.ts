import * as React from 'react';

import type { SessionListViewItem } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { filterCollapsedSessionListItems } from './filterCollapsedSessionListItems';
import { buildSessionListProjectHeaderViewModels } from './sessionListProjectHeaderViewModels';
import { buildSessionListReachabilitySummary } from './buildSessionListReachabilitySummary';
import { buildSessionListRowViewModels } from './sessionListRowViewModels';
import type { VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';

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
    const machinesById = React.useMemo(() => {
        return new Map(input.allMachines.map((machine) => [machine.id, machine] as const));
    }, [input.allMachines]);

    const visibleListItems = React.useMemo(() => {
        const items = input.paneState.visibleSessionListViewData;
        if (!items || items.length === 0) return items;
        return filterCollapsedSessionListItems(items, input.collapsedGroupKeys);
    }, [input.collapsedGroupKeys, input.paneState.visibleSessionListViewData]);
    const listItems = (visibleListItems ?? []) as Array<SessionListViewItem>;

    const sessionReachabilitySummary = React.useMemo(() => buildSessionListReachabilitySummary({
        listItems,
        machinesById,
    }), [listItems, machinesById]);

    const projectHeaderViewModelState = React.useMemo(() => buildSessionListProjectHeaderViewModels({
        listItems,
        workspaceLabels: input.workspaceLabels,
        workspaceRefs: input.workspaceRefs,
    }), [
        input.workspaceLabels,
        input.workspaceRefs,
        listItems,
    ]);

    const rowViewModels = React.useMemo(() => buildSessionListRowViewModels({
        listItems,
        reachableSessionDisplayById: sessionReachabilitySummary.displayById,
        hasMultipleMachines: sessionReachabilitySummary.hasMultipleMachines,
        pinnedSessionKeys: input.pinnedKeySet,
        sessionTags: input.sessionTags,
        selectedSessionId: input.selectedSessionId,
        showServerBadge: input.showServerBadge,
        showPinnedServerBadge: input.showPinnedServerBadge,
    }), [
        input.pinnedKeySet,
        input.selectedSessionId,
        input.sessionTags,
        input.showPinnedServerBadge,
        input.showServerBadge,
        listItems,
        sessionReachabilitySummary.displayById,
        sessionReachabilitySummary.hasMultipleMachines,
    ]);

    return {
        listItems,
        reachableSessionDisplayById: sessionReachabilitySummary.displayById,
        hasMultipleMachines: sessionReachabilitySummary.hasMultipleMachines,
        projectHeaderViewModelState,
        rowViewModels,
    };
}

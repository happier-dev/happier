import * as React from 'react';

import { SelectionList, resolvePopoverSelectionListHeightBehavior } from '@/components/ui/selectionList';
import type { Machine } from '@/sync/domains/state/storageTypes';

import type { ServerScopedMachine, ServerScopedMachineGroup } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { useMachineSelectionListModel } from './machineSelection/useMachineSelectionListModel';

export type NewSessionMachineSelectionContentProps = Readonly<{
    groups: ReadonlyArray<ServerScopedMachineGroup>;
    selectedMachine: Machine | null;
    selectedServerId: string | null;
    recentMachines: ReadonlyArray<Machine>;
    favoriteMachines: ReadonlyArray<Machine>;
    onSelectMachine: (machine: Machine) => void;
    onSelectScopedMachine: (machine: ServerScopedMachine) => void;
    serverId?: string | null;
    onToggleFavorite?: (machine: Machine) => void;
    showFavorites?: boolean;
    showRecent?: boolean;
    showSearch?: boolean;
    searchPlacement?: 'header' | 'favorites' | 'all';
    testIdPrefix?: string;
    showCliGlyphs?: boolean;
    autoDetectCliGlyphs?: boolean;
    maxHeight?: number;
}>;

export function NewSessionMachineSelectionContent(props: NewSessionMachineSelectionContentProps) {
    const listModel = useMachineSelectionListModel({
        groups: props.groups,
        selectedMachine: props.selectedMachine,
        selectedServerId: props.selectedServerId,
        recentMachines: props.recentMachines,
        favoriteMachines: props.favoriteMachines,
        onSelectMachine: props.onSelectMachine,
        onSelectScopedMachine: props.onSelectScopedMachine,
        serverId: props.serverId,
        onToggleFavorite: props.onToggleFavorite,
        showFavorites: props.showFavorites ?? true,
        showRecent: props.showRecent ?? true,
        showSearch: props.showSearch ?? true,
        showCliGlyphs: props.showCliGlyphs ?? true,
        autoDetectCliGlyphs: props.autoDetectCliGlyphs ?? true,
        favoriteGroupPlacement: 'afterRecent',
        testIdPrefix: props.testIdPrefix,
    });

    return (
        <SelectionList
            testID="new-session-machine-list"
            rootStep={listModel.rootStep}
            selectedOptionId={listModel.selectedOptionId}
            onSelect={() => {}}
            onRequestClose={() => {}}
            autoFocusInputOnWeb
            maxHeight={props.maxHeight}
            heightBehavior={
                props.maxHeight === undefined
                    ? undefined
                    : resolvePopoverSelectionListHeightBehavior()
            }
        />
    );
}

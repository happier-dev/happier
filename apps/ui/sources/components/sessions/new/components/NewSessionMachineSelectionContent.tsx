import * as React from 'react';

import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { MachineSelector } from './MachineSelector';
import { ServerScopedMachineSelector } from './ServerScopedMachineSelector';
import type { ServerScopedMachine, ServerScopedMachineGroup } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';

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
}>;

export function NewSessionMachineSelectionContent(props: NewSessionMachineSelectionContentProps) {
    const hasMultipleServers = props.groups.length > 1;
    const hasAnyMachines = props.groups.some((group) => group.machines.length > 0);
    const hasAnyLoadingGroups = props.groups.some((group) => group.loading);
    const showEmptyState = props.groups.length === 0 || (!hasAnyMachines && !hasAnyLoadingGroups);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {showEmptyState ? (
                <Text style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                    {t('newSession.noMachinesFound')}
                </Text>
            ) : hasMultipleServers ? (
                <ServerScopedMachineSelector
                    groups={props.groups}
                    selectedMachineId={props.selectedMachine?.id ?? null}
                    selectedServerId={props.selectedServerId}
                    onSelect={props.onSelectScopedMachine}
                    testIdPrefix={props.testIdPrefix}
                />
            ) : (
                <MachineSelector
                    machines={props.groups[0]?.machines ?? []}
                    selectedMachine={props.selectedMachine}
                    recentMachines={props.recentMachines}
                    favoriteMachines={props.favoriteMachines}
                    onSelect={props.onSelectMachine}
                    onToggleFavorite={props.onToggleFavorite}
                    serverId={props.serverId}
                    showFavorites={props.showFavorites ?? true}
                    showRecent={props.showRecent ?? true}
                    showSearch={props.showSearch ?? true}
                    searchPlacement={props.searchPlacement ?? 'header'}
                    testIdPrefix={props.testIdPrefix}
                    showCliGlyphs={props.showCliGlyphs ?? true}
                    autoDetectCliGlyphs={props.autoDetectCliGlyphs ?? true}
                />
            )}
        </ItemList>
    );
}

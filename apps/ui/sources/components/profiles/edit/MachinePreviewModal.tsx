import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';


export interface MachinePreviewModalProps {
    machines: Machine[];
    favoriteMachineIds: string[];
    selectedMachineId: string | null;
    onSelect: (machineId: string) => void;
    onToggleFavorite: (machineId: string) => void;
    onClose: () => void;
}

export function MachinePreviewModal(props: MachinePreviewModalProps) {
    const styles = stylesheet;
    const activeServerId = getActiveServerId();

    const selectedMachine = React.useMemo(() => {
        if (!props.selectedMachineId) return null;
        return props.machines.find((m) => m.id === props.selectedMachineId) ?? null;
    }, [props.machines, props.selectedMachineId]);

    const favoriteMachines = React.useMemo(() => {
        const byId = new Map(props.machines.map((m) => [m.id, m] as const));
        return props.favoriteMachineIds.map((id) => byId.get(id)).filter(Boolean) as Machine[];
    }, [props.favoriteMachineIds, props.machines]);

    return (
        <View style={styles.body}>
            <MachineSelector
                machines={props.machines}
                serverId={activeServerId}
                selectedMachine={selectedMachine}
                favoriteMachines={favoriteMachines}
                showRecent={false}
                showFavorites={favoriteMachines.length > 0}
                showSearch
                searchPlacement={favoriteMachines.length > 0 ? 'favorites' : 'all'}
                onSelect={(machine) => {
                    props.onSelect(machine.id);
                    props.onClose();
                }}
                onToggleFavorite={(machine) => props.onToggleFavorite(machine.id)}
            />
        </View>
    );
}

const stylesheet = StyleSheet.create(() => ({
    body: {
        flex: 1,
        minHeight: 0,
    },
}));

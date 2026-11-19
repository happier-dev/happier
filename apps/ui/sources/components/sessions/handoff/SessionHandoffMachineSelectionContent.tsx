import * as React from 'react';

import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import { useMachinePoolGroups } from '@/components/sessions/new/hooks/machines/useMachinePoolGroups';
import { useMachinePoolSelection } from '@/components/sessions/new/hooks/machines/useMachinePoolSelection';
import { buildServerScopedMachine } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { randomUUID } from '@/platform/randomUUID';
import type { Machine } from '@/sync/domains/state/storageTypes';

type Props = Readonly<{
    serverId: string;
    machines: readonly Machine[];
    selectedMachine: Machine | null;
    favoriteMachines: readonly Machine[];
    recentMachines: readonly Machine[];
    selectedManagedMachine: React.ComponentProps<typeof NewSessionMachineSelectionContent>['selectedManagedMachine'];
    onSelectMachine: (machineId: string) => void;
    onSelectManagedMachine: NonNullable<React.ComponentProps<typeof NewSessionMachineSelectionContent>['onSelectManagedMachine']>;
    onToggleFavorite: (machine: Machine) => void;
    requestClose: () => void;
    maxHeight: number;
}>;

/** Supplies the handoff Home and destination callbacks to New Session's list. */
export function SessionHandoffMachineSelectionContent(props: Props) {
    const { machines, serverId, requestClose, onSelectMachine } = props;
    const groups = React.useMemo(() => {
        const home = { serverId, serverName: '' };
        return [{ ...home, machines: machines.map(machine => buildServerScopedMachine(machine, home)), loading: false, signedOut: false }];
    }, [machines, serverId]);
    const poolGroups = useMachinePoolGroups(groups);
    const [requestKey] = React.useState(randomUUID);
    const poolSelection = useMachinePoolSelection({
        requestKey,
        scopeKey: serverId,
        onResolved: ({ machineId }) => onSelectMachine(machineId),
    });
    const select = (machine: Machine) => {
        poolSelection.cancelPendingSelection();
        onSelectMachine(machine.id);
        requestClose();
    };

    return <NewSessionMachineSelectionContent
        groups={groups}
        poolGroups={poolGroups}
        selectedMachine={props.selectedMachine}
        selectedServerId={serverId}
        serverId={serverId}
        recentMachines={props.recentMachines}
        favoriteMachines={props.favoriteMachines}
        selectedManagedMachine={props.selectedManagedMachine}
        onSelectMachine={select}
        onSelectScopedMachine={select}
        onSelectPool={async selection => { if (await poolSelection.selectPool(selection)) requestClose(); }}
        poolSelectionStatus={poolSelection.status}
        onConfigureManagedMachine={() => {
            poolSelection.cancelPendingSelection();
            requestClose();
        }}
        onSelectManagedMachine={props.onSelectManagedMachine}
        onToggleFavorite={props.onToggleFavorite}
        disableOfflineMachines
        showCliGlyphs={false}
        autoDetectCliGlyphs={false}
        testIdPrefix="session-handoff-machine"
        maxHeight={props.maxHeight}
    />;
}

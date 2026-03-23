import * as React from 'react';
import { useRouter } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';

import { MachineSetupActionsSection } from './MachineSetupActionsSection';
import { MachinesListSection } from './MachinesListSection';
import { useMachinesSettingsViewModel } from './machinesSettingsViewModel';

export const MachinesSettingsView = React.memo(function MachinesSettingsView() {
    const router = useRouter();
    const viewModel = useMachinesSettingsViewModel();

    return (
        <ItemList>
            <MachinesListSection
                viewModel={viewModel}
                onOpenMachine={(machineId, serverId) => {
                    const query = serverId ? `?serverId=${encodeURIComponent(serverId)}` : '';
                    router.push(`/(app)/machine/${machineId}${query}`);
                }}
            />
            <MachineSetupActionsSection />
        </ItemList>
    );
});

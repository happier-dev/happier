import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ActiveSelectionMachinesSection } from '@/components/settings/server/sections/ActiveSelectionMachinesSection';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type { useMachinesSettingsViewModel } from './machinesSettingsViewModel';

type MachinesSettingsViewModel = ReturnType<typeof useMachinesSettingsViewModel>;

type MachinesListSectionProps = Readonly<{
    viewModel: MachinesSettingsViewModel;
    onOpenMachine: (machineId: string, serverId?: string) => void;
}>;

export const MachinesListSection = React.memo(function MachinesListSection(props: MachinesListSectionProps) {
    const { theme } = useUnistyles();

    if (!props.viewModel.hasMachines) {
        const title = props.viewModel.isLoadingMachines ? t('common.loading') : t('newSession.noMachinesFound');
        return (
            <ItemGroup title={t('settings.machines')}>
                <Item
                    title={title}
                    icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.textSecondary} />}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    return (
        <ActiveSelectionMachinesSection
            hasAnyVisibleMachines={props.viewModel.hasMachines}
            showMachinesGroupedByServer={props.viewModel.showMachinesGroupedByServer}
            visibleMachineGroups={props.viewModel.visibleMachineGroups}
            allMachines={props.viewModel.allMachines}
            activeServerId={props.viewModel.activeServerId}
            machinesTitle={t('settings.machines')}
            themeColors={{
                textSecondary: theme.colors.textSecondary,
                status: {
                    connected: theme.colors.status.connected,
                    disconnected: theme.colors.status.disconnected,
                },
            }}
            onOpenMachine={props.onOpenMachine}
        />
    );
});

import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { ActiveSelectionMachinesSection } from '@/components/settings/machines/sections/ActiveSelectionMachinesSection';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type { useMachinesSettingsViewModel } from '../machinesSettingsViewModel';
import { buildMachineSetupWizardHref } from '@/utils/routes/setupWizardHref';
import { Icon } from '@/components/ui/icons/Icon';

type MachinesSettingsViewModel = ReturnType<typeof useMachinesSettingsViewModel>;

type MachinesListSectionProps = Readonly<{
    viewModel: MachinesSettingsViewModel;
    onOpenMachine: (machineId: string, serverId?: string) => void;
}>;

export const MachinesListSection = React.memo(function MachinesListSection(props: MachinesListSectionProps) {
    const { theme } = useUnistyles();
    const router = useRouter();

    if (!props.viewModel.hasMachines) {
        const title = props.viewModel.isLoadingMachines ? t('common.loading') : t('newSession.noMachinesFound');
        const openSetupWizard = () => router.push(buildMachineSetupWizardHref({ action: 'remote', step: 'remote_ssh_setup' }));
        const emptyStateTitle = props.viewModel.isLoadingMachines ? title : t('setupOnboarding.setupNewMachineAction');
        return (
            <ItemGroup title={t('settings.machines')}>
                <Item
                    testID={props.viewModel.isLoadingMachines ? undefined : 'settings.machines.openSetupWizard'}
                    title={emptyStateTitle}
                    icon={<Icon name="desktop" size={29} color={theme.colors.text.secondary} />}
                    showChevron={props.viewModel.isLoadingMachines ? false : true}
                    onPress={props.viewModel.isLoadingMachines ? undefined : openSetupWizard}
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
                textSecondary: theme.colors.text.secondary,
                status: {
                    connected: theme.colors.status.connected,
                    disconnected: theme.colors.status.disconnected,
                },
            }}
            onOpenMachine={props.onOpenMachine}
        />
    );
});

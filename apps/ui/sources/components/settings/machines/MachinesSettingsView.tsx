import * as React from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RelayDriftActionCard } from '@/components/settings/server/RelayDriftActionCard';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { t } from '@/text';

import { MachineSetupActionsSection } from './MachineSetupActionsSection';
import { MachinesListSection } from './MachinesListSection';
import { useMachinesSettingsViewModel } from './machinesSettingsViewModel';

export const MachinesSettingsView = React.memo(function MachinesSettingsView() {
    const router = useRouter();
    const viewModel = useMachinesSettingsViewModel();
    const isDesktop = isTauriDesktop();
    const isBrowserWeb = Platform.OS === 'web' && !isDesktop;
    const openSetupWizard = React.useCallback((params?: Readonly<{ step?: string; action?: string }>) => {
        const step = params?.step ? `step=${encodeURIComponent(params.step)}` : '';
        const action = params?.action ? `action=${encodeURIComponent(params.action)}` : '';
        const query = [step, action].filter(Boolean).join('&');
        router.push(`/setup/wizard${query ? `?${query}` : ''}`);
    }, [router]);

    return (
        <ItemList>
            {viewModel.relayDriftBanner ? (
                isDesktop ? (
                    <RelayDriftActionCard banner={viewModel.relayDriftBanner} />
                ) : (
                    <ItemGroup title={viewModel.relayDriftBanner.title}>
                        <Item
                            testID="settings.machines.relayDrift.webNotice"
                            title={viewModel.relayDriftBanner.title}
                            subtitle={viewModel.relayDriftBanner.description}
                            showChevron={false}
                            mode="info"
                        />
                    </ItemGroup>
                )
            ) : null}
            <MachinesListSection
                viewModel={viewModel}
                onOpenMachine={(machineId, serverId) => {
                    const query = serverId ? `?serverId=${encodeURIComponent(serverId)}` : '';
                    router.push(`/(app)/machine/${machineId}${query}`);
                }}
            />
            {isDesktop ? (
                <MachineSetupActionsSection />
            ) : isBrowserWeb ? (
                <ItemGroup title={t('common.actions')}>
                    <Item
                        testID="settings.machines.openWizard.setupThisComputer"
                        title={t('setupOnboarding.setupThisComputerTitle')}
                        subtitle={t('settings.machineSetupCurrentMachineSubtitle')}
                        onPress={() => openSetupWizard({ step: 'setup_this_computer', action: 'local' })}
                    />
                    <Item
                        testID="settings.machines.openWizard.addMachine"
                        title={t('settings.addMachine')}
                        subtitle={t('settings.machineSetupSshMachineSubtitle')}
                        onPress={() => openSetupWizard({ step: 'remote_ssh_setup', action: 'remote' })}
                    />
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

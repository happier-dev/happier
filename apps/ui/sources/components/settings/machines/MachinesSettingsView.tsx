import * as React from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RelayDriftActionCard } from '@/components/settings/server/RelayDriftActionCard';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { t } from '@/text';

import { MachineSetupActionsSection } from './sections/MachineSetupActionsSection';
import { MachinesListSection } from './sections/MachinesListSection';
import { useMachinesSettingsViewModel } from './machinesSettingsViewModel';
import { buildMachineSetupWizardHref, buildSetupWizardHref } from '@/utils/routes/setupWizardHref';

type MachineSetupWizardAction = 'local' | 'remote';
type MachineSetupWizardStep = 'setup_this_computer' | 'remote_ssh_setup';

export const MachinesSettingsView = React.memo(function MachinesSettingsView() {
    const router = useRouter();
    const viewModel = useMachinesSettingsViewModel();
    const isDesktop = isDesktopHost();
    const isBrowserWeb = Platform.OS === 'web' && !isDesktop;
    const setupPolicy = React.useMemo(() => resolveSetupSurfacePolicy(), []);
    const openSetupWizard = React.useCallback((params?: Readonly<{
        step: MachineSetupWizardStep;
        action: MachineSetupWizardAction;
    }>) => {
        if (!params?.step || !params?.action) {
            router.push(buildSetupWizardHref());
            return;
        }
        router.push(buildMachineSetupWizardHref({
            action: params.action,
            step: params.step,
        }));
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
                    {setupPolicy.machine.allowLocalMachineSetup ? (
                        <Item
                            testID="settings.machines.openWizard.setupThisComputer"
                            title={t('setupOnboarding.setupThisComputerTitle')}
                            subtitle={t('settings.machineSetupCurrentMachineSubtitle')}
                            onPress={() => openSetupWizard({ step: 'setup_this_computer', action: 'local' })}
                        />
                    ) : null}
                    {setupPolicy.machine.allowRemoteSshMachineSetup ? (
                        <Item
                            testID="settings.machines.openWizard.addMachine"
                            title={t('setupOnboarding.setupNewMachineAction')}
                            subtitle={t('settings.machineSetupSshMachineSubtitle')}
                            onPress={() => openSetupWizard({ step: 'remote_ssh_setup', action: 'remote' })}
                        />
                    ) : null}
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

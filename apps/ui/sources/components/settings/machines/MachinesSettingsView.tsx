import * as React from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RelayDriftActionCard } from '@/components/settings/server/RelayDriftActionCard';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { t } from '@/text';

import { DesktopOnlySetupNotice } from './DesktopOnlySetupNotice';
import { MachineSetupActionsSection } from './MachineSetupActionsSection';
import { MachinesListSection } from './MachinesListSection';
import { useMachinesSettingsViewModel } from './machinesSettingsViewModel';

export const MachinesSettingsView = React.memo(function MachinesSettingsView() {
    const router = useRouter();
    const viewModel = useMachinesSettingsViewModel();
    const isDesktop = isTauriDesktop();
    const isBrowserWeb = Platform.OS === 'web' && !isDesktop;

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
                <DesktopOnlySetupNotice
                    testID="settings.machines.desktopOnlySetupNotice"
                    groupTitle={t('settings.addMachine')}
                    title={t('setupOnboarding.webDesktopOnlyTitle')}
                    subtitle={t('setupOnboarding.webDesktopOnlyBody')}
                />
            ) : null}
        </ItemList>
    );
});

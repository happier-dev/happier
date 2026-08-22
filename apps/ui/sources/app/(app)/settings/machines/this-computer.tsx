import * as React from 'react';

import { useRouter } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { LocalDaemonControlSection } from '@/components/settings/machines/localControl/LocalDaemonControlSection';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { buildMachineSetupWizardHref } from '@/utils/routes/setupWizardHref';

export default function ThisComputerSetupRoute() {
    const router = useRouter();
    const isDesktop = isDesktopHost();
    return (
        <ItemList>
            <ItemGroup title={t('common.actions')}>
                <Item
                    testID="settings.machineSetup.openSetupWizard"
                    title={t('setupOnboarding.openSetupAction')}
                    subtitle={t('settings.machineSetupCurrentMachineSubtitle')}
                    onPress={() => router.push(buildMachineSetupWizardHref({ action: 'local', step: 'setup_this_computer' }))}
                />
            </ItemGroup>
            {isDesktop ? <LocalDaemonControlSection /> : null}
        </ItemList>
    );
}

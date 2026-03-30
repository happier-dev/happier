import * as React from 'react';

import { ItemList } from '@/components/ui/lists/ItemList';
import { DesktopOnlySetupNotice } from '@/components/settings/machines/DesktopOnlySetupNotice';
import { MachineSetupFlowScreen } from '@/components/settings/machines/MachineSetupFlowScreen';
import { t } from '@/text';
import { isTauriDesktop } from '@/utils/platform/tauri';

export default function AddMachineRoute() {
    if (!isTauriDesktop()) {
        return (
            <ItemList>
                <DesktopOnlySetupNotice
                    testID="settings.machineSetup.desktopOnlyRouteNotice"
                    groupTitle={t('settings.addMachine')}
                    title={t('setupOnboarding.webDesktopOnlyTitle')}
                    subtitle={t('setupOnboarding.webDesktopOnlyBody')}
                />
            </ItemList>
        );
    }
    return <MachineSetupFlowScreen mode="remoteOnly" />;
}

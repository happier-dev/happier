import * as React from 'react';

import { useRouter } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

export default function AddMachineRoute() {
    const router = useRouter();
    return (
        <ItemList>
            <ItemGroup title={t('common.actions')}>
                <Item
                    testID="settings.machineSetup.openSetupWizard"
                    title={t('setupOnboarding.setupNewMachineAction')}
                    subtitle={t('settings.machineSetupSshMachineSubtitle')}
                    onPress={() => router.push('/setup/wizard?action=remote&step=remote_ssh_setup&scope=machine')}
                />
            </ItemGroup>
        </ItemList>
    );
}

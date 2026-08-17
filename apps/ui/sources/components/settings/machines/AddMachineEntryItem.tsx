import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

import { buildMachineSetupWizardHref } from '@/utils/routes/setupWizardHref';
import { Icon } from '@/components/ui/icons/Icon';

export const AddMachineEntryItem = React.memo(function AddMachineEntryItem() {
    const router = useRouter();
    const { theme } = useUnistyles();

    return (
        <Item
            title={t('setupOnboarding.setupNewMachineAction')}
            subtitle={t('settings.machineSetupSshMachineSubtitle')}
            icon={<Icon name="hard-drives" size={29} color={theme.colors.accent.orange} />}
            onPress={() => router.push(buildMachineSetupWizardHref({ action: 'remote', step: 'remote_ssh_setup' }))}
        />
    );
});

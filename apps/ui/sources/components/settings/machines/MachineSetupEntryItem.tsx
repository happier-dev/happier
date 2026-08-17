import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

export const MachineSetupEntryItem = React.memo(function MachineSetupEntryItem() {
    const router = useRouter();
    const { theme } = useUnistyles();

    return (
        <Item
            title={t('settings.machineSetupCurrentMachineTitle')}
            subtitle={t('settings.machineSetupCurrentMachineSubtitle')}
            icon={<Icon name="laptop" size={29} color={theme.colors.accent.blue} />}
            onPress={() => router.push(SETTINGS_ROUTES.machinesThisComputer)}
        />
    );
});

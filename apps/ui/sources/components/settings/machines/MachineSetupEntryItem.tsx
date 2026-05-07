import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

export const MachineSetupEntryItem = React.memo(function MachineSetupEntryItem() {
    const router = useRouter();
    const { theme } = useUnistyles();

    return (
        <Item
            title={t('settings.machineSetupCurrentMachineTitle')}
            subtitle={t('settings.machineSetupCurrentMachineSubtitle')}
            icon={<Ionicons name="laptop-outline" size={29} color={theme.colors.accent.blue} />}
            onPress={() => router.push('/settings/machines/this-computer')}
        />
    );
});

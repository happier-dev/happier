import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

export const AddMachineEntryItem = React.memo(function AddMachineEntryItem() {
    const router = useRouter();
    const { theme } = useUnistyles();

    return (
        <Item
            title={t('settings.addMachine')}
            subtitle={t('settings.machineSetupSshMachineSubtitle')}
            icon={<Ionicons name="server-outline" size={29} color={theme.colors.accent.orange} />}
            onPress={() => router.push('/settings/machines/add')}
        />
    );
});

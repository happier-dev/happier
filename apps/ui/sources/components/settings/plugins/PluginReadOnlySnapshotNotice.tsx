import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

export const PluginReadOnlySnapshotNotice = React.memo(function PluginReadOnlySnapshotNotice(props: Readonly<{
    testID: string;
}>) {
    const { theme } = useUnistyles();

    return (
        <View
            testID={props.testID}
            accessible
            accessibilityLiveRegion="polite"
            accessibilityLabel={t('settingsPlugins.readOnlySnapshot')}
        >
            <Item
                title={t('common.unavailable')}
                subtitle={t('settingsPlugins.readOnlySnapshot')}
                icon={<Ionicons name="cloud-offline-outline" size={29} color={theme.colors.text.secondary} />}
                showChevron={false}
                mode="info"
            />
        </View>
    );
});

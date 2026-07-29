import * as React from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

const stylesheet = StyleSheet.create(() => ({
    actionContainer: {
        marginTop: -4,
    },
    actionGroupSurface: {
        backgroundColor: 'transparent',
        borderColor: 'transparent',
        borderWidth: 0,
        borderTopColor: 'transparent',
        borderTopWidth: 0,
        boxShadow: 'none',
        shadowOpacity: 0,
        shadowRadius: 0,
        elevation: 0,
    },
    actionPressable: {
        minHeight: Platform.select({ ios: 44, default: 48 }),
    },
}));

export const SessionsListActionRows = React.memo(function SessionsListActionRows(props: Readonly<{
    externalSessionsEnabled: boolean;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    if (!props.externalSessionsEnabled) return null;

    return (
        <ItemGroup
            style={styles.actionContainer}
            containerStyle={styles.actionGroupSurface}
            constrainToContentWidth={false}
        >
            <Item
                testID="external-sessions-browse-button"
                title={t('externalSessions.browseOpenExisting')}
                leftElement={<Ionicons name="folder-open-outline" size={20} color={theme.colors.text.secondary} />}
                iconBoxSize={20}
                density="cozy"
                showChevron={false}
                showDivider={false}
                pressableStyle={styles.actionPressable}
                onPress={() => router.push('/external/browse')}
            />
        </ItemGroup>
    );
});

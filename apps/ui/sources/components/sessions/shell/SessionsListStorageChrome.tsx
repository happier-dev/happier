import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import type { SessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import { t } from '@/text';
import { SessionListStorageTabsBar } from './SessionListStorageTabsBar';

const stylesheet = StyleSheet.create((theme) => ({
    browseActionContainer: {
        paddingHorizontal: 12,
        paddingTop: 12,
        paddingBottom: 4,
    },
    browseActionButton: {
        alignSelf: 'stretch',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
    },
    browseActionButtonPressed: {
        opacity: 0.82,
        transform: [{ scale: 0.99 }],
    },
    browseActionLabel: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text,
    },
}));

export type SessionsListStorageChromeProps = Readonly<{
    directSessionsEnabled: boolean;
    storageKind: SessionStorageKind;
    onSelectStorageKind: (storageKind: SessionStorageKind) => void;
}>;

export const SessionsListStorageChrome = React.memo((props: SessionsListStorageChromeProps) => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const showDirectBrowseAction = props.directSessionsEnabled && props.storageKind === 'direct';

    return (
        <>
            {props.directSessionsEnabled ? (
                <SessionListStorageTabsBar
                    activeTabId={props.storageKind}
                    onSelectTab={props.onSelectStorageKind}
                />
            ) : null}
            {showDirectBrowseAction ? (
                <View style={styles.browseActionContainer}>
                    <Pressable
                        testID="direct-sessions-browse-button"
                        accessibilityRole="button"
                        accessibilityLabel={t('directSessions.browseOpenExisting')}
                        onPress={() => router.push('/direct/browse')}
                        style={({ pressed }) => [
                            styles.browseActionButton,
                            pressed ? styles.browseActionButtonPressed : null,
                        ]}
                    >
                        <Ionicons name="folder-open-outline" size={18} color={theme.colors.text} />
                        <Text style={styles.browseActionLabel}>{t('directSessions.browseOpenExisting')}</Text>
                    </Pressable>
                </View>
            ) : null}
        </>
    );
});

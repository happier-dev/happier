import * as React from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { SessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import { t } from '@/text';
import { SessionListStorageTabsBar } from './SessionListStorageTabsBar';

const stylesheet = StyleSheet.create(() => ({
    browseActionContainer: {
        marginTop: -4,
    },
}));

export type SessionsListStorageChromeProps = Readonly<{
    externalSessionsEnabled: boolean;
    storageKind: SessionStorageKind;
    onSelectStorageKind: (storageKind: SessionStorageKind) => void;
}>;

export const SessionsListStorageChrome = React.memo((props: SessionsListStorageChromeProps) => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const showExternalSessionBrowseAction = props.externalSessionsEnabled && props.storageKind === 'direct';

    return (
        <>
            {props.externalSessionsEnabled ? (
                <SessionListStorageTabsBar
                    activeTabId={props.storageKind}
                    onSelectTab={props.onSelectStorageKind}
                />
            ) : null}
            {showExternalSessionBrowseAction ? (
                <ItemGroup style={styles.browseActionContainer}>
                    <Item
                        testID="direct-sessions-browse-button"
                        title={t('externalSessions.browseOpenExisting')}
                        subtitle={t('externalSessions.browseActionSubtitle')}
                        icon={<Ionicons name="folder-open-outline" size={22} color={theme.colors.textSecondary} />}
                        onPress={() => {
                            router.push('/direct/browse');
                        }}
                    />
                </ItemGroup>
            ) : null}
        </>
    );
});

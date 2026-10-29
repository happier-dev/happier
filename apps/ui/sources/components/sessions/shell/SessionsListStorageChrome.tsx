import * as React from 'react';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MachineResourcesStrip } from '@/components/machines/resources/MachineResourcesStrip';
import type { SessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import { t } from '@/text';
import { SessionListStorageTabsBar } from './SessionListStorageTabsBar';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create(() => ({
    browseActionContainer: {
        marginTop: -4,
    },
    browseActionGroupSurface: {
        backgroundColor: 'transparent',
        boxShadow: 'none',
        shadowOpacity: 0,
        shadowRadius: 0,
        elevation: 0,
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
            <MachineResourcesStrip />
            {showDirectBrowseAction ? (
                <ItemGroup
                    style={styles.browseActionContainer}
                    containerStyle={styles.browseActionGroupSurface}
                    constrainToContentWidth={false}
                >
                    <Item
                        testID="direct-sessions-browse-button"
                        title={t('directSessions.browseOpenExisting')}
                        subtitle={t('directSessions.browseActionSubtitle')}
                        icon={<Icon name="folder-open" size={20} color={theme.colors.text.secondary} />}
                        onPress={() => {
                            router.push('/direct/browse');
                        }}
                    />
                </ItemGroup>
            ) : null}
        </>
    );
});

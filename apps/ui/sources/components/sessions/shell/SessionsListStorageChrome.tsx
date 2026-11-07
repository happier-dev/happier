import * as React from 'react';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
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
}>;

export const SessionsListStorageChrome = React.memo((props: SessionsListStorageChromeProps) => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const showDirectBrowseAction = props.directSessionsEnabled;

    return (
        <>
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

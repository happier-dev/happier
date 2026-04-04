import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSessionListStorageKind } from '@/components/sessions/model/useSessionListStorageKind';
import { SessionsListStorageChrome } from '@/components/sessions/shell/SessionsListStorageChrome';
import { SessionsListPaneContent } from '@/components/sessions/shell/SessionsListPaneContent';

const stylesheet = StyleSheet.create(() => ({
    container: {
        flex: 1,
    },
}));

export const SessionsListWrapper = React.memo(() => {
    const { directSessionsEnabled, storageKind, setStorageKind } = useSessionListStorageKind();
    const styles = stylesheet;
    const storageChrome = (
        <SessionsListStorageChrome
            directSessionsEnabled={directSessionsEnabled}
            storageKind={storageKind}
            onSelectStorageKind={setStorageKind}
        />
    );

    return (
        <View style={styles.container}>
            {storageChrome}
            <SessionsListPaneContent storageKind={storageKind} fallbackGuidanceVariant="phone" />
        </View>
    );
});

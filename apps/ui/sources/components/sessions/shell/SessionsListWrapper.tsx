import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SessionsList } from '@/components/sessions/shell/SessionsList';
import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { useSessionListStorageKind } from '@/components/sessions/model/useSessionListStorageKind';
import { SessionsListStorageChrome } from '@/components/sessions/shell/SessionsListStorageChrome';
import { useVisibleSessionListViewData } from '@/hooks/session/useVisibleSessionListViewData';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    loadingContainerWrapper: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: 32,
    },
    emptyStateContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        flexDirection: 'column',
        backgroundColor: theme.colors.groupped.background,
    },
    emptyStateContentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
}));

export const SessionsListWrapper = React.memo(() => {
    const { theme } = useUnistyles();
    const { directSessionsEnabled, storageKind, setStorageKind } = useSessionListStorageKind();
    const sessionListViewData = useVisibleSessionListViewData(storageKind);
    const styles = stylesheet;
    const storageChrome = (
        <SessionsListStorageChrome
            directSessionsEnabled={directSessionsEnabled}
            storageKind={storageKind}
            onSelectStorageKind={setStorageKind}
        />
    );

    if (sessionListViewData === null) {
        return (
            <View style={styles.container}>
                {storageChrome}
                <View style={styles.loadingContainerWrapper}>
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                </View>
            </View>
        );
    }

    if (sessionListViewData.length === 0) {
        return (
            <View style={styles.container}>
                {storageChrome}
                <View style={styles.emptyStateContainer}>
                    <View style={styles.emptyStateContentContainer}>
                        <SessionGettingStartedGuidance variant="phone" />
                    </View>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {storageChrome}
            <SessionsList storageKind={storageKind} />
        </View>
    );
});

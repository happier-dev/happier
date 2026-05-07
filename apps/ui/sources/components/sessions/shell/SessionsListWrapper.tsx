import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { useSessionListStorageKind } from '@/components/sessions/model/useSessionListStorageKind';
import { SessionsListStorageChrome } from '@/components/sessions/shell/SessionsListStorageChrome';
import { useVisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListViewData';
import { HiddenInactiveSessionsEmptyState } from '@/components/sessions/guidance/HiddenInactiveSessionsEmptyState';
import { SessionsListContent } from '@/components/sessions/shell/SessionsList';

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
    const { sessionListViewData, visibleSessionCount, hasHiddenInactiveSessions } = useVisibleSessionListPaneState(storageKind);
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

    if (visibleSessionCount === 0) {
        return (
            <View style={styles.container}>
                {storageChrome}
                <View style={styles.emptyStateContainer}>
                    <View style={styles.emptyStateContentContainer}>
                        {hasHiddenInactiveSessions ? (
                            <HiddenInactiveSessionsEmptyState />
                        ) : (
                            <SessionGettingStartedGuidance variant="phone" />
                        )}
                    </View>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {storageChrome}
            <SessionsListContent storageKind={storageKind} data={sessionListViewData} />
        </View>
    );
});

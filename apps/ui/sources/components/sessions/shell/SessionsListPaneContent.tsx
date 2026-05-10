import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    SessionGettingStartedGuidance,
    type SessionGettingStartedGuidanceVariant,
} from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { ExternalSessionsEmptyState } from '@/components/sessions/shell/ExternalSessionsEmptyState';
import { HiddenInactiveSessionsEmptyState } from '@/components/sessions/shell/HiddenInactiveSessionsEmptyState';
import { SessionsListView } from '@/components/sessions/shell/SessionsList';
import { SessionsListEmptyState } from '@/components/sessions/shell/SessionsListEmptyState';
import { useSessionGettingStartedGuidanceBaseModel } from '@/components/sessions/guidance/useSessionGettingStartedGuidanceBaseModel';
import { useVisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import { resolveSessionsListEmptyStateKind } from './resolveSessionsListEmptyStateKind';

type SessionsListPaneContentProps = Readonly<{
    storageKind: 'persisted' | 'direct';
    fallbackGuidanceVariant: SessionGettingStartedGuidanceVariant;
}>;

const stylesheet = StyleSheet.create((theme) => ({
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

export const SessionsListPaneContent = React.memo((props: SessionsListPaneContentProps) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const sessionListPaneState = useVisibleSessionListPaneState(props.storageKind);
    const gettingStarted = useSessionGettingStartedGuidanceBaseModel();

    if (sessionListPaneState.showLoading) {
        return (
            <View style={styles.loadingContainerWrapper}>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            </View>
        );
    }

    if (sessionListPaneState.showEmptyState) {
        if (props.storageKind === 'persisted' && sessionListPaneState.hasHiddenInactiveSessions) {
            return (
                <View style={styles.emptyStateContainer}>
                    <View style={styles.emptyStateContentContainer}>
                        <HiddenInactiveSessionsEmptyState />
                    </View>
                </View>
            );
        }

        if (props.storageKind === 'direct') {
            return (
                <View style={styles.emptyStateContainer}>
                    <View style={styles.emptyStateContentContainer}>
                        <ExternalSessionsEmptyState surface={props.fallbackGuidanceVariant === 'sidebar' ? 'sidebar' : 'default'} />
                    </View>
                </View>
            );
        }

        const emptyStateKind = resolveSessionsListEmptyStateKind(gettingStarted.kind);

        return (
            <View style={styles.emptyStateContainer}>
                <View style={styles.emptyStateContentContainer}>
                    {emptyStateKind
                        ? (
                            <SessionsListEmptyState
                                kind={emptyStateKind}
                                targetLabel={gettingStarted.targetLabel}
                                surface={props.fallbackGuidanceVariant === 'sidebar' ? 'sidebar' : 'default'}
                            />
                        )
                        : <SessionGettingStartedGuidance variant={props.fallbackGuidanceVariant} />}
                </View>
            </View>
        );
    }

    return <SessionsListView storageKind={props.storageKind} />;
});

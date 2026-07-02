import * as React from 'react';
import { View } from 'react-native';
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
import { useVisibleSessionListPaneState, type VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import { resolveSessionsListEmptyStateKind } from './resolveSessionsListEmptyStateKind';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    normalizeSessionListSurfaceOwnership,
    type SessionListSurfaceOwnership,
} from '@/components/sessions/shell/surface/sessionListSurfaceOwnership';

type SessionsListPaneContentProps = Readonly<{
    storageKind: 'persisted' | 'direct';
    fallbackGuidanceVariant: SessionGettingStartedGuidanceVariant;
    pathname?: string;
    sessionListSurfaceDataActive?: boolean;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    loadingContainerWrapper: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        backgroundColor: theme.colors.background.canvas,
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
        backgroundColor: theme.colors.background.canvas,
    },
    emptyStateContentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
}));

const EMPTY_SESSIONS_LIST_PANE_STATE: VisibleSessionListPaneState = {
    summary: {
        sessionsReady: false,
        sessionCount: 0,
    },
    visibleSessionListIndex: null,
    hasHiddenInactiveSessions: false,
    folderFocus: null,
    showLoading: true,
    showEmptyState: false,
};

type FrozenPaneState = Readonly<{
    storageKind: 'persisted' | 'direct';
    pathname?: string;
    paneState: VisibleSessionListPaneState;
}>;

type SessionsListPaneContentViewProps = SessionsListPaneContentProps & Readonly<{
    sessionListPaneState: VisibleSessionListPaneState;
    surfaceOwnership: SessionListSurfaceOwnership;
}>;

function getRetainablePaneState(
    frozenPaneState: FrozenPaneState | null,
    props: Pick<SessionsListPaneContentProps, 'storageKind' | 'pathname'>,
): VisibleSessionListPaneState {
    if (!frozenPaneState) return EMPTY_SESSIONS_LIST_PANE_STATE;
    if (frozenPaneState.storageKind !== props.storageKind) return EMPTY_SESSIONS_LIST_PANE_STATE;
    if ((frozenPaneState.pathname ?? '') !== (props.pathname ?? '')) return EMPTY_SESSIONS_LIST_PANE_STATE;
    return frozenPaneState.paneState;
}

function ActiveSessionsListPaneStateSubscriber(props: SessionsListPaneContentProps & Readonly<{
    surfaceOwnership: SessionListSurfaceOwnership;
    onPaneState: (paneState: VisibleSessionListPaneState) => void;
}>) {
    const sessionListPaneState = useVisibleSessionListPaneState(props.storageKind, {
        pathname: props.pathname,
        sessionListSurfaceDataActive: true,
    });

    const onPaneState = props.onPaneState;
    React.useEffect(() => {
        onPaneState(sessionListPaneState);
    }, [onPaneState, sessionListPaneState]);

    return (
        <SessionsListPaneContentView
            {...props}
            sessionListPaneState={sessionListPaneState}
        />
    );
}

function SessionsListPaneEmptyState(props: Pick<SessionsListPaneContentViewProps, 'fallbackGuidanceVariant' | 'sessionListPaneState' | 'storageKind'>) {
    const gettingStarted = useSessionGettingStartedGuidanceBaseModel();
    const styles = stylesheet;

    if (props.storageKind === 'persisted' && props.sessionListPaneState.hasHiddenInactiveSessions) {
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

function SessionsListPaneContentView(props: SessionsListPaneContentViewProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    if (props.sessionListPaneState.showLoading) {
        return (
            <View style={styles.loadingContainerWrapper}>
                <View style={styles.loadingContainer}>
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                </View>
            </View>
        );
    }

    if (props.sessionListPaneState.showEmptyState) {
        return (
            <SessionsListPaneEmptyState
                fallbackGuidanceVariant={props.fallbackGuidanceVariant}
                sessionListPaneState={props.sessionListPaneState}
                storageKind={props.storageKind}
            />
        );
    }

    return (
        <SessionsListView
            storageKind={props.storageKind}
            paneState={props.sessionListPaneState}
            pathname={props.pathname}
            surfaceOwnership={props.surfaceOwnership}
        />
    );
}

export const SessionsListPaneContent = React.memo((props: SessionsListPaneContentProps) => {
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(props.surfaceOwnership);
    const sessionListSurfaceDataActive = props.sessionListSurfaceDataActive ?? surfaceOwnership.dataActive;
    const frozenPaneStateRef = React.useRef<FrozenPaneState | null>(null);
    const handlePaneState = React.useCallback((paneState: VisibleSessionListPaneState) => {
        frozenPaneStateRef.current = {
            storageKind: props.storageKind,
            pathname: props.pathname,
            paneState,
        };
    }, [props.pathname, props.storageKind]);

    if (sessionListSurfaceDataActive) {
        return (
            <ActiveSessionsListPaneStateSubscriber
                {...props}
                surfaceOwnership={surfaceOwnership}
                onPaneState={handlePaneState}
            />
        );
    }

    return (
        <SessionsListPaneContentView
            {...props}
            sessionListPaneState={getRetainablePaneState(frozenPaneStateRef.current, props)}
            surfaceOwnership={surfaceOwnership}
        />
    );
});

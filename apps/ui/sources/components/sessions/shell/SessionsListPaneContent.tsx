import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    SessionGettingStartedGuidance,
    type SessionGettingStartedGuidanceVariant,
} from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { ExternalSessionsEmptyState } from '@/components/sessions/shell/ExternalSessionsEmptyState';
import { HiddenInactiveSessionsEmptyState } from '@/components/sessions/shell/HiddenInactiveSessionsEmptyState';
import { SessionsListViewWithFilterController } from '@/components/sessions/shell/SessionsList';
import {
    SessionListAttentionInteractionContext,
    useSessionListAttentionInteractionHeld,
    useSessionListAttentionInteractionOwner,
} from './useSessionListAttentionInteraction';
import { SessionsListEmptyState } from '@/components/sessions/shell/SessionsListEmptyState';
import { useSessionGettingStartedGuidanceBaseModel } from '@/components/sessions/guidance/useSessionGettingStartedGuidanceBaseModel';
import { useVisibleSessionListPaneState, type VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import { useSessionListLayoutChoice } from '@/hooks/session/sessionListLayoutIntent';
import { buildSessionListCollapseContextKey } from '@/sync/domains/session/listing/sessionListCollapseState';
import { resolveSessionsListEmptyStateKind } from './resolveSessionsListEmptyStateKind';
import { SessionListSkeletonRows } from './SessionListSkeletonRows';
import { HomeReachabilityGate } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import {
    normalizeSessionListSurfaceOwnership,
    type SessionListSurfaceOwnership,
} from '@/components/sessions/shell/surface/sessionListSurfaceOwnership';
import {
    readRetainedSessionListPaneState,
    retainSessionListPaneState,
    setRetainedSessionListPaneQueryMembershipActive,
    setRetainedSessionListPaneReferenceCorpusActive,
    type RetainedSessionListPaneState,
    updateRetainedSessionListPaneSurfaceRoutePathname,
} from './sessionListPaneRetention';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import {
    useSessionListViewFilterController,
    type SessionListViewFilterController,
} from './search/useSessionListViewFilterController';

type SessionsListPaneContentProps = Readonly<{
    storageKind: SessionListStorageFilter;
    fallbackGuidanceVariant: SessionGettingStartedGuidanceVariant;
    pathname?: string;
    surfaceRoutePathname?: string;
    sessionListSurfaceDataActive?: boolean;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
}>;

const stylesheet = StyleSheet.create(() => ({
    loadingContainerWrapper: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
    emptyStateContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        flexDirection: 'column',
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
    folderFeatureEnabledServerIds: [],
    showLoading: true,
    showEmptyState: false,
};

type SessionsListPaneContentViewProps = SessionsListPaneContentProps & Readonly<{
    sessionListPaneState: VisibleSessionListPaneState;
    surfaceOwnership: SessionListSurfaceOwnership;
    filterController: SessionListViewFilterController;
}>;

function getRetainablePaneStateSnapshot(
    retainedPaneState: RetainedSessionListPaneState | null,
    props: Pick<RetainedSessionListPaneState, 'storageKind' | 'pathname' | 'sourceScopeKey'>,
): RetainedSessionListPaneState | null {
    if (!retainedPaneState) return null;
    if (retainedPaneState.storageKind !== props.storageKind) return null;
    if ((retainedPaneState.pathname ?? '') !== (props.pathname ?? '')) return null;
    if (retainedPaneState.sourceScopeKey !== props.sourceScopeKey) return null;
    return retainedPaneState;
}

function getRetainablePaneState(
    retainedPaneState: RetainedSessionListPaneState | null,
    props: Pick<RetainedSessionListPaneState, 'storageKind' | 'pathname' | 'sourceScopeKey'>,
): VisibleSessionListPaneState {
    return getRetainablePaneStateSnapshot(retainedPaneState, props)?.paneState ?? EMPTY_SESSIONS_LIST_PANE_STATE;
}

function ActiveSessionsListPaneStateSubscriber(props: SessionsListPaneContentProps & Readonly<{
    retainedPathname?: string | null;
    retainedVisibleSessionListIndex?: VisibleSessionListPaneState['visibleSessionListIndex'];
    surfaceOwnership: SessionListSurfaceOwnership;
    filterController: SessionListViewFilterController;
    onPaneState: (paneState: VisibleSessionListPaneState) => void;
}>) {
    const attentionInteraction = React.useContext(SessionListAttentionInteractionContext);
    const attentionInteractionHeld = useSessionListAttentionInteractionHeld(attentionInteraction);
    const layout = useSessionListLayoutChoice();
    const sessionListPaneState = useVisibleSessionListPaneState(props.storageKind, {
        collapseContextKey: buildSessionListCollapseContextKey(props.filterController, layout),
        pathname: props.pathname,
        retainedPathname: props.retainedPathname,
        retainedVisibleSessionListIndex: props.retainedVisibleSessionListIndex,
        sessionListSurfaceDataActive: true,
        attentionInteractionHeld: props.surfaceOwnership.interactive && attentionInteractionHeld,
        queryHomes: props.filterController.pagingHomes,
        emptyQuerySelectionComplete: props.filterController.emptyQuerySelectionComplete,
        workFilter: props.filterController.displayFilters,
        spaceMembership: props.filterController.spaceMembership,
        filterControlsRequired: props.filterController.filterControlsRequired,
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

    const emptyStateKind = resolveSessionsListEmptyStateKind(gettingStarted.kind, props.storageKind);
    const content = emptyStateKind === 'external'
        ? <ExternalSessionsEmptyState surface={props.fallbackGuidanceVariant === 'sidebar' ? 'sidebar' : 'default'} />
        : emptyStateKind
            ? (
                <SessionsListEmptyState
                    kind={emptyStateKind}
                    targetLabel={gettingStarted.targetLabel}
                    surface={props.fallbackGuidanceVariant === 'sidebar' ? 'sidebar' : 'default'}
                />
            )
            : <SessionGettingStartedGuidance variant={props.fallbackGuidanceVariant} />;

    return (
        <View style={styles.emptyStateContainer}>
            <View style={styles.emptyStateContentContainer}>
                {content}
            </View>
        </View>
    );
}

/**
 * The rendered list, below the subscriber that follows session rows for placement. That subscriber
 * re-renders on every row write (it must, to re-place rows); when placement did not change its pane
 * state keeps its identity, so this boundary skips re-rendering the whole list. Each row renders its
 * content from its own subscription.
 */
const SessionsListPaneContentView = React.memo(function SessionsListPaneContentView(props: SessionsListPaneContentViewProps) {
    const styles = stylesheet;

    if (props.sessionListPaneState.showLoading) {
        return (
            <View style={styles.loadingContainerWrapper}>
                <HomeReachabilityGate variant="line">
                    <SessionListSkeletonRows />
                </HomeReachabilityGate>
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
        <SessionsListViewWithFilterController
            storageKind={props.storageKind}
            corpusStorage="active"
            filterController={props.filterController}
            paneState={props.sessionListPaneState}
            pathname={props.pathname}
            surfaceOwnership={props.surfaceOwnership}
        />
    );
});

export const SessionsListPaneContent = React.memo((props: SessionsListPaneContentProps) => {
    const attentionInteraction = useSessionListAttentionInteractionOwner();
    const filterController = useSessionListViewFilterController('active');
    const storageKind = filterController.sourceAvailable ? filterController.displayFilters.source : 'persisted';
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(props.surfaceOwnership);
    const sessionListSurfaceDataActive = props.sessionListSurfaceDataActive ?? surfaceOwnership.dataActive;
    const sourceScopeKey = filterController.retentionScopeKey;
    const retentionIdentity = React.useMemo(() => ({
        storageKind,
        pathname: props.pathname,
        sourceScopeKey,
    }), [props.pathname, sourceScopeKey, storageKind]);
    const retainedPaneStateRef = React.useRef<RetainedSessionListPaneState | null>(
        readRetainedSessionListPaneState(retentionIdentity),
    );
    const handlePaneState = React.useCallback((paneState: VisibleSessionListPaneState) => {
        retainedPaneStateRef.current = retainSessionListPaneState({
            storageKind,
            pathname: props.pathname,
            sourceScopeKey,
            surfaceRoutePathname: props.surfaceRoutePathname,
            paneState,
            queryMembershipActive: true,
            referenceCorpusActive: surfaceOwnership.interactive && sessionListSurfaceDataActive,
            selectedServerIds: filterController.queryHomes.map((home) => home.serverId),
        }) ?? retainedPaneStateRef.current;
    }, [filterController.queryHomes, props.pathname, props.surfaceRoutePathname, sessionListSurfaceDataActive, sourceScopeKey, storageKind, surfaceOwnership.interactive]);

    React.useEffect(() => {
        setRetainedSessionListPaneQueryMembershipActive(retentionIdentity, sessionListSurfaceDataActive);
        return () => setRetainedSessionListPaneQueryMembershipActive(retentionIdentity, false);
    }, [retentionIdentity, sessionListSurfaceDataActive]);

    React.useEffect(() => {
        const active = surfaceOwnership.interactive && sessionListSurfaceDataActive;
        setRetainedSessionListPaneReferenceCorpusActive(retentionIdentity, active);
        return () => setRetainedSessionListPaneReferenceCorpusActive(retentionIdentity, false);
    }, [retentionIdentity, sessionListSurfaceDataActive, surfaceOwnership.interactive]);

    React.useEffect(() => {
        if (sessionListSurfaceDataActive) return;
        const retained = getRetainablePaneStateSnapshot(
            readRetainedSessionListPaneState(retentionIdentity) ?? retainedPaneStateRef.current,
            retentionIdentity,
        );
        if (!retained) return;
        if ((retained.surfaceRoutePathname ?? '') === (props.surfaceRoutePathname ?? '')) return;
        retainedPaneStateRef.current = updateRetainedSessionListPaneSurfaceRoutePathname(
            retentionIdentity,
            props.surfaceRoutePathname,
        ) ?? retained;
    }, [props.surfaceRoutePathname, retentionIdentity, sessionListSurfaceDataActive]);

    const retainedPaneState = sessionListSurfaceDataActive
        ? getRetainablePaneStateSnapshot(
            readRetainedSessionListPaneState(retentionIdentity) ?? retainedPaneStateRef.current,
            retentionIdentity,
        )
        : null;

    if (sessionListSurfaceDataActive) {
        return (
            <SessionListAttentionInteractionContext.Provider value={attentionInteraction}>
                <ActiveSessionsListPaneStateSubscriber
                    {...props}
                    storageKind={storageKind}
                    retainedPathname={retainedPaneState?.surfaceRoutePathname ?? null}
                    retainedVisibleSessionListIndex={retainedPaneState?.paneState.visibleSessionListIndex ?? null}
                    surfaceOwnership={surfaceOwnership}
                    filterController={filterController}
                    onPaneState={handlePaneState}
                />
            </SessionListAttentionInteractionContext.Provider>
        );
    }

    return (
        <SessionListAttentionInteractionContext.Provider value={attentionInteraction}>
            <SessionsListPaneContentView
                {...props}
                storageKind={storageKind}
                sessionListPaneState={getRetainablePaneState(
                    readRetainedSessionListPaneState(retentionIdentity) ?? retainedPaneStateRef.current,
                    retentionIdentity,
                )}
                surfaceOwnership={surfaceOwnership}
                filterController={filterController}
            />
        </SessionListAttentionInteractionContext.Provider>
    );
});

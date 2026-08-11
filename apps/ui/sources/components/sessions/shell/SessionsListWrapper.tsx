import * as React from 'react';
import { View } from 'react-native';
import { usePathname } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { useSessionListStorageKind } from '@/components/sessions/model/useSessionListStorageKind';
import { SessionsListStorageChrome } from '@/components/sessions/shell/SessionsListStorageChrome';
import {
    useVisibleSessionListPaneState,
    type VisibleSessionListViewDataOptions,
} from '@/hooks/session/useVisibleSessionListViewData';
import { HiddenInactiveSessionsEmptyState } from '@/components/sessions/guidance/HiddenInactiveSessionsEmptyState';
import { SessionsListContent } from '@/components/sessions/shell/SessionsList';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { readSessionIdFromPathname } from '@/components/sessions/shell/readSessionIdFromPathname';
import {
    resolvePhoneRootSessionListSurfaceDataActive,
    resolveSessionListSurfaceOwnership,
    SESSION_LIST_SURFACE_OWNER_PHONE_ROOT,
} from '@/components/sessions/shell/surface/sessionListSurfaceOwnership';
import { useSurfaceAnchorPathname } from '@/components/sessions/shell/surface/sessionSurfaceAnchorPathname';
import {
    areRetainedSessionListPaneStatesEqual,
    readRetainedSessionListPaneSnapshot,
    retainSessionListPaneSnapshot,
    updateRetainedSessionListPaneActiveSessionId,
    useSessionListPaneSourceScopeKey,
} from '@/components/sessions/shell/surface/sessionListPaneRetention';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
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

type SessionsListWrapperProps = Readonly<{
    pathname?: string;
    surfaceRoutePathname?: string;
}>;

type SessionsListPaneState = ReturnType<typeof useVisibleSessionListPaneState>;

const EMPTY_SESSIONS_LIST_PANE_STATE: SessionsListPaneState = Object.freeze({
    sessionListViewData: null,
    visibleSessionCount: 0,
    hasHiddenInactiveSessions: false,
});

export const SessionsListWrapper = React.memo((props: SessionsListWrapperProps) => {
    if (props.pathname !== undefined) {
        return (
            <RouteBoundSessionsListWrapperContent
                pathname={props.pathname}
                surfaceRoutePathname={props.surfaceRoutePathname}
            />
        );
    }
    return <RouteBoundSessionsListWrapperContent />;
});

const RouteBoundSessionsListWrapperContent = React.memo((props: SessionsListWrapperProps) => {
    const routePathname = usePathname();
    // The foreground surface route is the anchor, not the raw pathname: an overlay route such as
    // /new is shown *over* the current screen, so the list must keep the route it was showing.
    const anchorPathname = useSurfaceAnchorPathname(routePathname);
    return (
        <SessionsListWrapperContent
            pathname={props.pathname ?? routePathname}
            surfaceRoutePathname={props.surfaceRoutePathname ?? anchorPathname}
        />
    );
});

const ActiveSessionsListPaneStateSubscriber = React.memo((props: Readonly<{
    storageKind: Parameters<typeof useVisibleSessionListPaneState>[0];
    options: VisibleSessionListViewDataOptions;
    onPaneState: (paneState: SessionsListPaneState) => void;
}>) => {
    const paneState = useVisibleSessionListPaneState(props.storageKind, props.options);

    React.useLayoutEffect(() => {
        props.onPaneState(paneState);
    }, [paneState, props.onPaneState]);

    return null;
});

const SessionsListWrapperContent = React.memo((props: { pathname: string; surfaceRoutePathname: string }) => {
    const { theme } = useUnistyles();
    const isFocused = useIsFocused();
    const { directSessionsEnabled, storageKind, setStorageKind } = useSessionListStorageKind();
    const pathname = props.pathname;
    const surfaceRoutePathname = props.surfaceRoutePathname;
    const sourceScopeKey = useSessionListPaneSourceScopeKey();
    const surfaceOwnership = React.useMemo(
        () => resolveSessionListSurfaceOwnership({
            ownerKey: SESSION_LIST_SURFACE_OWNER_PHONE_ROOT,
            interactiveOwnerKey: SESSION_LIST_SURFACE_OWNER_PHONE_ROOT,
            visible: true,
            dataActive: isFocused && resolvePhoneRootSessionListSurfaceDataActive(surfaceRoutePathname),
        }),
        [isFocused, surfaceRoutePathname],
    );
    const routeActiveSessionId = React.useMemo(() => readSessionIdFromPathname(pathname), [pathname]);
    const foregroundRouteSessionId = React.useMemo(
        () => readSessionIdFromPathname(surfaceRoutePathname),
        [surfaceRoutePathname],
    );
    const paneStateStorageKindRef = React.useRef<typeof storageKind | null>(null);
    const paneStateSourceScopeKeyRef = React.useRef<string | null>(null);
    const [paneState, setPaneState] = React.useState<SessionsListPaneState>(EMPTY_SESSIONS_LIST_PANE_STATE);
    const handlePaneState = React.useCallback((nextPaneState: SessionsListPaneState) => {
        paneStateStorageKindRef.current = storageKind;
        paneStateSourceScopeKeyRef.current = sourceScopeKey;
        retainSessionListPaneSnapshot({
            activeSessionId: routeActiveSessionId,
            paneState: nextPaneState,
            pathname,
            sourceScopeKey,
            storageKind,
        });
        setPaneState((currentPaneState) => (
            areRetainedSessionListPaneStatesEqual(currentPaneState, nextPaneState)
                ? currentPaneState
                : nextPaneState
        ));
    }, [pathname, routeActiveSessionId, sourceScopeKey, storageKind]);
    React.useEffect(() => {
        if (surfaceOwnership.dataActive) return;
        if (
            paneStateStorageKindRef.current === storageKind
            && paneStateSourceScopeKeyRef.current === sourceScopeKey
        ) {
            retainSessionListPaneSnapshot({
                activeSessionId: foregroundRouteSessionId,
                paneState,
                pathname,
                sourceScopeKey,
                storageKind,
            });
        }
        updateRetainedSessionListPaneActiveSessionId({ pathname, sourceScopeKey, storageKind }, foregroundRouteSessionId);
    }, [foregroundRouteSessionId, paneState, pathname, sourceScopeKey, storageKind, surfaceOwnership.dataActive]);
    const retainedPaneStateForActivationCandidate = surfaceOwnership.dataActive
        ? readRetainedSessionListPaneSnapshot({ pathname, sourceScopeKey, storageKind })
        : null;
    const retainedPaneStateForActivation = retainedPaneStateForActivationCandidate;
    const paneStateMatchesSource = paneStateSourceScopeKeyRef.current === null
        || paneStateSourceScopeKeyRef.current === sourceScopeKey;
    const paneStateMatchesStorageKind = paneStateStorageKindRef.current === null
        || paneStateStorageKindRef.current === storageKind;
    const shouldSeedRetainedSessionListViewData = retainedPaneStateForActivation !== null
        && (
            !paneStateMatchesStorageKind
            || !paneStateMatchesSource
            || paneState.sessionListViewData === null
        );
    const paneStateOptions = React.useMemo<VisibleSessionListViewDataOptions>(() => {
        const retainedSessionListViewData = shouldSeedRetainedSessionListViewData
            ? retainedPaneStateForActivation?.paneState.sessionListViewData ?? null
            : null;
        return {
            activeSessionId: routeActiveSessionId ?? retainedPaneStateForActivation?.activeSessionId ?? null,
            ...(retainedSessionListViewData
                ? { retainedSessionListViewData }
                : {}),
            sessionListSurfaceDataActive: true,
        };
    }, [retainedPaneStateForActivation, routeActiveSessionId, shouldSeedRetainedSessionListViewData]);
    const retainedDisplayPaneState = !surfaceOwnership.dataActive
        ? readRetainedSessionListPaneSnapshot({ pathname, sourceScopeKey, storageKind })?.paneState ?? null
        : null;
    const displayPaneState = retainedDisplayPaneState
        ?? (paneStateMatchesStorageKind && paneStateMatchesSource ? paneState : EMPTY_SESSIONS_LIST_PANE_STATE);
    const { sessionListViewData, visibleSessionCount, hasHiddenInactiveSessions } = displayPaneState;
    const styles = stylesheet;
    const storageChrome = (
        <SessionsListStorageChrome
            directSessionsEnabled={directSessionsEnabled}
            storageKind={storageKind}
            onSelectStorageKind={setStorageKind}
        />
    );
    const sessionListContent = React.useMemo(
        () => (
            <SessionsListContent
                storageKind={storageKind}
                data={sessionListViewData}
                pathname={pathname}
                surfaceOwnership={surfaceOwnership}
            />
        ),
        [pathname, sessionListViewData, storageKind, surfaceOwnership],
    );

    if (!surfaceOwnership.visible) {
        return <View style={styles.container} />;
    }

    let content: React.ReactNode;
    if (sessionListViewData === null) {
        content = (
            <View style={styles.container}>
                {storageChrome}
                <View style={styles.loadingContainerWrapper}>
                    <View style={styles.loadingContainer}>
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    </View>
                </View>
            </View>
        );
    } else if (visibleSessionCount === 0) {
        content = (
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
    } else {
        content = (
            <View style={styles.container}>
                {storageChrome}
                {sessionListContent}
            </View>
        );
    }

    return (
        <>
            {surfaceOwnership.dataActive ? (
                <ActiveSessionsListPaneStateSubscriber
                    storageKind={storageKind}
                    options={paneStateOptions}
                    onPaneState={handlePaneState}
                />
            ) : null}
            {content}
        </>
    );
});

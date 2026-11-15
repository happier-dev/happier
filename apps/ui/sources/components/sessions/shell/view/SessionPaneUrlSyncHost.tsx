import { Platform } from 'react-native';
import * as React from 'react';

import { useDestinationInstanceKey, useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useSessionPaneUrlState } from '@/components/sessions/panes/url/useSessionPaneUrlState';
import { useSessionPaneUrlSync } from '@/components/sessions/panes/url/useSessionPaneUrlSync';

/**
 * The Session pane's URL mirror and its default-open rule. It is the one reader of the whole pane
 * scope and the destination's pane params, and renders nothing: a side-tab change re-renders this
 * leaf, not the Session view around it (P03-TAB-CONTENT-2 W4).
 */
export const SessionPaneUrlSyncHost = React.memo(function SessionPaneUrlSyncHost(props: Readonly<{
    paneScopeId: string;
    multiPaneEnabled: boolean;
    sessionsRightPaneDefaultOpen: boolean;
    deviceType: string;
    surfaceVisible: boolean;
    paneUrlSyncRouteActive: boolean;
    /** `false` for a Session presented inside another surface: no URL mirror and no default open. */
    paneEffectsEnabled: boolean;
}>) {
    const router = useDestinationRouter();
    const hosted = useDestinationInstanceKey() !== null;
    const pane = useAppPaneScope(props.paneScopeId);
    const urlState = useSessionPaneUrlState();
    const paneEffectsEnabled = props.paneEffectsEnabled;

    useSessionPaneUrlSync({
        enabled: paneEffectsEnabled
            && (hosted ? props.surfaceVisible : props.paneUrlSyncRouteActive)
            && props.multiPaneEnabled
            && Platform.OS === 'web',
        browserMirrorsEnabled: paneEffectsEnabled && !hosted,
        routeParamSyncEnabled: paneEffectsEnabled && (hosted || props.paneUrlSyncRouteActive),
        scopeKey: props.paneScopeId,
        scopeState: pane.scopeState,
        urlState,
        pane,
        setParams: paneEffectsEnabled
            && (hosted || props.paneUrlSyncRouteActive)
            && typeof router.setParams === 'function'
            ? router.setParams.bind(router)
            : null,
    });

    const urlRightTabId = urlState?.rightTabId;
    React.useEffect(() => {
        if (!paneEffectsEnabled) return;
        if (!props.sessionsRightPaneDefaultOpen) return;
        if (!props.multiPaneEnabled) return;
        if (!(Platform.OS === 'web' || props.deviceType === 'tablet')) return;
        if (urlRightTabId) return;
        const right = pane.scopeState?.right;
        if (right?.isOpen === true) return;
        if (right?.activeTabId != null) return;
        pane.openRight({ tabId: 'files' });
        pane.setRightTab('files');
    }, [
        props.deviceType,
        props.multiPaneEnabled,
        urlRightTabId,
        props.sessionsRightPaneDefaultOpen,
        pane,
        paneEffectsEnabled,
    ]);

    return null;
});

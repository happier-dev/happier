import { useDestinationRouter, useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Platform } from 'react-native';
import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSessionPaneUrlSync } from '@/components/sessions/panes/url/useSessionPaneUrlSync';
import { useWarmRepositoryDirectoryCacheOnSessionOpen } from '@/hooks/session/files/useWarmRepositoryDirectoryCacheOnSessionOpen';
import { sync } from '@/sync/sync';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionSurfaceActivation } from './useSessionSurfaceActivation';

export type UseSessionViewBootstrapInput = Readonly<{
    sessionId: string;
    serverId?: string | null;
    paneScopeId: string;
    paneUrlState: SessionPaneUrlState | null;
    multiPaneEnabled: boolean;
    sessionsRightPaneDefaultOpen: boolean;
    deviceType: string;
    sessionPath: string | null;
    sessionAccepted: boolean;
    surfaceFocused: boolean;
    surfaceRetained?: boolean;
    surfaceVisible: boolean;
    routeAnchor: boolean;
    paneUrlSyncRouteActive: boolean;
    /**
     * `false` for a Session presented inside another surface: it never mirrors pane state into
     * the URL or route params and never opens a pane on its own. Default `true`.
     */
    paneEffectsEnabled?: boolean;
}>;

export type UseSessionViewBootstrapResult = Readonly<{
    pane: ReturnType<typeof useAppPaneScope>;
    machineReachable: boolean;
    machineReachability: 'reachable' | 'unreachable' | 'unknown';
    isSurfaceFocused: boolean;
}>;

export function useSessionViewBootstrap(input: UseSessionViewBootstrapInput): UseSessionViewBootstrapResult {
    const router = useDestinationRouter();
    const hosted = useDestinationInstanceKey() !== null;
    const pane = useAppPaneScope(input.paneScopeId);
    const paneEffectsEnabled = input.paneEffectsEnabled !== false;
    const {
        machineReachable,
        machineOnline,
        machineReachability: observedMachineReachability,
    } = useSessionMachineReachability(input.sessionId, input.serverId);
    const machineReachability = observedMachineReachability
        ?? (machineReachable ? 'reachable' : 'unreachable');

    useSessionPaneUrlSync({
        enabled: paneEffectsEnabled
            && (hosted ? input.surfaceVisible : input.paneUrlSyncRouteActive)
            && input.multiPaneEnabled
            && Platform.OS === 'web',
        browserMirrorsEnabled: paneEffectsEnabled && !hosted,
        routeParamSyncEnabled: paneEffectsEnabled && (hosted || input.paneUrlSyncRouteActive),
        scopeKey: input.paneScopeId,
        scopeState: pane.scopeState,
        urlState: input.paneUrlState,
        pane,
        setParams: paneEffectsEnabled
            && (hosted || input.paneUrlSyncRouteActive)
            && typeof router.setParams === 'function'
            ? router.setParams.bind(router)
            : null,
    });

    React.useEffect(() => {
        if (!paneEffectsEnabled) return;
        if (!input.sessionsRightPaneDefaultOpen) return;
        if (!input.multiPaneEnabled) return;
        if (!(Platform.OS === 'web' || input.deviceType === 'tablet')) return;
        if (input.paneUrlState?.rightTabId) return;
        const right = pane.scopeState?.right;
        if (right?.isOpen === true) return;
        if (right?.activeTabId != null) return;
        pane.openRight({ tabId: 'files' });
        pane.setRightTab('files');
    }, [
        input.deviceType,
        input.multiPaneEnabled,
        input.paneUrlState?.rightTabId,
        input.sessionsRightPaneDefaultOpen,
        pane,
        paneEffectsEnabled,
    ]);

    const visibleSurfaceCanSync = input.surfaceFocused || input.routeAnchor;
    const activation = useSessionSurfaceActivation({
        sessionId: input.sessionId,
        serverId: input.serverId,
        onSessionVisible: input.sessionAccepted && visibleSurfaceCanSync
            ? sync.onSessionVisible
            : undefined,
        surfaceFocused: input.surfaceFocused,
        surfaceRetained: input.surfaceRetained,
        surfaceVisible: input.surfaceVisible,
        routeAnchor: input.routeAnchor,
    });

    useWarmRepositoryDirectoryCacheOnSessionOpen({
        sessionId: input.sessionId,
        sessionPath: input.sessionAccepted ? input.sessionPath : null,
        machineOnline: input.sessionAccepted ? machineOnline : false,
    });

    return {
        pane,
        machineReachable,
        machineReachability,
        isSurfaceFocused: activation.isSurfaceFocused,
    };
}

import { useRouter } from 'expo-router';
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
}>;

export type UseSessionViewBootstrapResult = Readonly<{
    pane: ReturnType<typeof useAppPaneScope>;
    machineReachable: boolean;
    isSurfaceFocused: boolean;
}>;

export function useSessionViewBootstrap(input: UseSessionViewBootstrapInput): UseSessionViewBootstrapResult {
    const router = useRouter();
    const pane = useAppPaneScope(input.paneScopeId);
    const { machineReachable, machineOnline } = useSessionMachineReachability(input.sessionId);

    useSessionPaneUrlSync({
        enabled: input.paneUrlSyncRouteActive && input.multiPaneEnabled && Platform.OS === 'web',
        routeParamSyncEnabled: input.paneUrlSyncRouteActive,
        scopeKey: input.paneScopeId,
        scopeState: pane.scopeState,
        urlState: input.paneUrlState,
        pane,
        setParams: input.paneUrlSyncRouteActive && typeof (router as any)?.setParams === 'function'
            ? (router as any).setParams.bind(router)
            : null,
    });

    React.useEffect(() => {
        if (!input.sessionsRightPaneDefaultOpen) return;
        if (!input.multiPaneEnabled) return;
        if (!(Platform.OS === 'web' || input.deviceType === 'tablet')) return;
        if (input.paneUrlState?.rightTabId) return;
        const right = (pane.scopeState as any)?.right ?? null;
        if (!right) return;
        if (right.isOpen === true) return;
        if (right.activeTabId !== null && right.activeTabId !== undefined) return;
        pane.openRight({ tabId: 'files' });
        pane.setRightTab('files');
    }, [
        input.deviceType,
        input.multiPaneEnabled,
        input.paneUrlState?.rightTabId,
        input.sessionsRightPaneDefaultOpen,
        pane,
    ]);

    const activation = useSessionSurfaceActivation({
        sessionId: input.sessionId,
        serverId: input.serverId,
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

    const visibleSurfaceCanSync = input.surfaceFocused || input.routeAnchor;
    React.useLayoutEffect(() => {
        if (!input.sessionAccepted || !input.surfaceVisible || !visibleSurfaceCanSync) {
            return;
        }
        sync.onSessionVisible(input.sessionId);
    }, [input.sessionAccepted, input.sessionId, input.surfaceVisible, visibleSurfaceCanSync]);

    return {
        pane,
        machineReachable,
        isSurfaceFocused: activation.isSurfaceFocused,
    };
}

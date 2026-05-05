import { useRouter } from 'expo-router';
import { Platform } from 'react-native';
import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSessionPaneUrlSync } from '@/components/sessions/panes/url/useSessionPaneUrlSync';
import { useWarmRepositoryDirectoryCacheOnSessionOpen } from '@/hooks/session/files/useWarmRepositoryDirectoryCacheOnSessionOpen';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionSurfaceActivation } from './useSessionSurfaceActivation';
import { useSessionViewedLifecycle } from './useSessionViewedLifecycle';

export type UseSessionViewBootstrapInput = Readonly<{
    sessionId: string;
    paneScopeId: string;
    paneUrlState: SessionPaneUrlState | null;
    multiPaneEnabled: boolean;
    sessionsRightPaneDefaultOpen: boolean;
    deviceType: string;
    sessionPath: string | null;
    sessionSeq: number | null;
    sessionPendingVersion: number | null;
    surfaceFocused: boolean;
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
        surfaceFocused: input.surfaceFocused,
        surfaceVisible: input.surfaceVisible,
        routeAnchor: input.routeAnchor,
    });

    useSessionViewedLifecycle({
        sessionId: input.sessionId,
        sessionSeq: input.sessionSeq,
        surfaceFocused: input.surfaceVisible && input.surfaceFocused,
    });

    React.useEffect(() => {
        return runAfterInteractionsWithFallback(() => {
            fireAndForget(sync.fetchPendingMessages(input.sessionId), { tag: 'SessionView.fetchPendingMessages' });
        });
    }, [input.sessionId, input.sessionPendingVersion]);

    useWarmRepositoryDirectoryCacheOnSessionOpen({
        sessionId: input.sessionId,
        sessionPath: input.sessionPath,
        machineOnline,
    });

    React.useLayoutEffect(() => {
        if (!input.surfaceVisible) {
            return;
        }
        sync.onSessionVisible(input.sessionId);
    }, [input.sessionId, input.surfaceVisible]);

    return {
        pane,
        machineReachable,
        isSurfaceFocused: activation.isSurfaceFocused,
    };
}

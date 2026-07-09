import * as React from 'react';

import { BrowserSurfaceHost } from '@/components/browser/surfaces';
import {
    useBrowserSurfaceHostProps,
    type BrowserSurfaceHostPropsInput,
} from '@/components/browser/surfaces/useBrowserSurfaceHostProps';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { useBrowserDaemonControlTransport } from '@/sync/domains/browser/control';
import { useSessionBrowserContextRuntimeContext } from '@/components/sessions/browser/sessionBrowserContextRuntime';
import { useSessionBrowserRecordingRuntime } from '@/components/sessions/browser/sessionBrowserRecordingRuntime';
import { createManagedChromiumBrowserAnnotationCaptureProvider } from '@/sync/domains/browser/context';

export function SessionRightPanelBrowserView(props: Readonly<{
    sessionId: string;
    overrides?: Partial<BrowserSurfaceHostPropsInput>;
}>): React.ReactElement {
    const machineTarget = useSessionMachineTarget(props.sessionId);
    const preferredServerId = usePreferredServerIdForSession(props.sessionId);
    const sessionBrowserContextRuntime = useSessionBrowserContextRuntimeContext();
    const machineId = props.overrides?.machineId ?? machineTarget?.machineId ?? null;
    const serverId = props.overrides?.serverId ?? preferredServerId;
    const hostProps = useBrowserSurfaceHostProps({
        scope: 'sessionSidebar',
        sessionId: props.sessionId,
        machineId,
        serverId,
        ...props.overrides,
    });
    // W2-A-1 / A3: supply the real UI→daemon control transport so a daemon-authoritative
    // (chromiumSidecar/streamedBrowserSurface) view dispatches reload/stop/navigate through the
    // daemon control broker instead of returning `browser_control_route_unavailable`.
    const sendDaemonCommand = useBrowserDaemonControlTransport({
        machineId,
        serverId,
    });
    const managedAnnotationCaptureProvider = React.useMemo(() => {
        if (!machineId) return null;
        return createManagedChromiumBrowserAnnotationCaptureProvider({
            machineId,
            serverId,
        });
    }, [machineId, serverId]);
    const browserRecordingRuntime = useSessionBrowserRecordingRuntime({
        enabled: true,
        scopeKey: props.sessionId,
        sessionId: props.sessionId,
        machineId,
        serverId,
    });
    const browserContext = React.useMemo(() => {
        const shellContext = sessionBrowserContextRuntime?.browserShellContext;
        if (!shellContext) return undefined;
        if (!managedAnnotationCaptureProvider) return shellContext;
        return {
            ...shellContext,
            annotationCaptureProvider: managedAnnotationCaptureProvider,
            managedAnnotationCaptureProvider: true,
        };
    }, [managedAnnotationCaptureProvider, sessionBrowserContextRuntime?.browserShellContext]);

    return (
        <BrowserSurfaceHost
            browserSessionId={hostProps.browserSessionId}
            platform={hostProps.platform}
            initialBrowserState={hostProps.initialBrowserState}
            surfaceKey={hostProps.surfaceKey}
            presentationSlotId={hostProps.presentationSlotId}
            keepAliveAboveRouter
            visible
            active
            launchpadRows={hostProps.launchpadRows}
            launchpadRefreshStatus={hostProps.launchpadRefreshStatus}
            launchpadRefreshError={hostProps.launchpadRefreshError}
            localServicePreviewState={hostProps.localServicePreviewState}
            localServicePreviewServerId={hostProps.localServicePreviewServerId}
            onLifecycleChange={hostProps.onLifecycleChange}
            sendDaemonCommand={sendDaemonCommand}
            browserContext={browserContext}
            browserRecording={browserRecordingRuntime?.browserShellRecording ?? null}
            testID="session-rightpanel-browser"
        />
    );
}

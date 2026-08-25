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
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

export function SessionRightPanelBrowserView(props: Readonly<{
    sessionId: string;
    overrides?: Partial<BrowserSurfaceHostPropsInput>;
    /**
     * The Session shell's already-admitted plugin projection. Browser target
     * identity remains public presentation context; host effects use only these
     * explicit current execution facts.
     */
    pluginProjection?: PluginUiProjectionCurrentness;
}>): React.ReactElement {
    const machineTarget = useSessionMachineTarget(props.sessionId);
    const preferredServerId = usePreferredServerIdForSession(props.sessionId);
    const sessionBrowserContextRuntime = useSessionBrowserContextRuntimeContext();
    const hasOverrideMachineId = props.overrides !== undefined
        && Object.prototype.hasOwnProperty.call(props.overrides, 'machineId');
    const hasOverrideServerId = props.overrides !== undefined
        && Object.prototype.hasOwnProperty.call(props.overrides, 'serverId');
    const hasAdmittedPluginProjection = props.pluginProjection !== undefined;
    // A driver-rendered Session pane already carries the AppPane-admitted
    // target. Direct Browser routes omit it and retain their incumbent lookup;
    // an explicit null from a stale pane scope stays unavailable.
    const machineId = hasOverrideMachineId
        ? props.overrides?.machineId ?? null
        : hasAdmittedPluginProjection
            ? props.pluginProjection?.machineId ?? null
            : machineTarget?.machineId ?? null;
    const serverId = hasOverrideServerId
        ? props.overrides?.serverId ?? null
        : hasAdmittedPluginProjection
            ? props.pluginProjection?.serverId ?? null
            : preferredServerId;
    const hostProps = useBrowserSurfaceHostProps({
        scope: 'sessionSidebar',
        sessionId: props.sessionId,
        ...props.overrides,
        machineId,
        serverId,
        pluginUiProjection: props.pluginProjection?.pluginUiProjection,
        pluginBrowserProjection: props.pluginProjection?.pluginBrowserProjection,
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
    const pluginBrowserActionContext = React.useMemo(() => {
        if (!props.pluginProjection) {
            return undefined;
        }
        return {
            machineId: props.pluginProjection.machineId,
            serverId: props.pluginProjection.serverId,
            sessionId: props.sessionId,
        };
    }, [
        props.pluginProjection?.machineId,
        props.pluginProjection?.serverId,
        props.sessionId,
    ]);

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
            pluginUiProjection={props.pluginProjection?.pluginUiProjection}
            pluginUiInteractionEnabled={props.pluginProjection?.phase === 'current'
                && props.pluginProjection?.interactionEnabled === true}
            pluginBrowserProjection={props.pluginProjection?.pluginBrowserProjection}
            pluginBrowserActionContext={pluginBrowserActionContext}
            testID="session-rightpanel-browser"
        />
    );
}

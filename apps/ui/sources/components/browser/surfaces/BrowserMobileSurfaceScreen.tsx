import * as React from 'react';

import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionBrowserContextRuntimeContext } from '@/components/sessions/browser/sessionBrowserContextRuntime';
import { useSessionBrowserRecordingRuntime } from '@/components/sessions/browser/sessionBrowserRecordingRuntime';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { resolveBrowserSurfacePlatform, useBrowserSurfaceHostProps } from './useBrowserSurfaceHostProps';

import { BrowserScopedWorkspace } from './BrowserScopedWorkspace';

/**
 * Session-cockpit mobile browser surface. Mounts a scoped instance of the SAME details-workspace
 * tab engine as desktop (D2-revised) — `browser-view` tabs only, single-group, splits off. The
 * `scopeId` is threaded from the cockpit so the workspace has a stable per-surface pane scope.
 */
export function BrowserMobileSurfaceScreen(props: Readonly<{
    sessionId: string;
    scopeId?: string;
    /**
     * An enclosing cockpit supplies its one admitted projection. Standalone
     * Browser routes retain the incumbent scoped lookup below.
     */
    pluginProjection?: PluginUiProjectionCurrentness;
}>): React.ReactElement {
    const machineTarget = useSessionMachineTarget(props.sessionId);
    const serverId = usePreferredServerIdForSession(props.sessionId);
    const machineId = machineTarget?.machineId ?? null;
    const scopeId = props.scopeId ?? `session:${props.sessionId}:mobile-browser`;
    const scopedPluginProjection = useScopedPluginUiProjection({
        machineId,
        serverId,
        enabled: props.pluginProjection === undefined,
    });
    const pluginProjection = props.pluginProjection ?? scopedPluginProjection;
    // Assemble the live workspace-ranked launchpad feed so the mobile new-tab page shows running
    // services + recents (not only URL entry). The shared bootstrap also resolves the preview
    // state used to seed access URLs when a launchpad row is opened.
    const hostProps = useBrowserSurfaceHostProps({
        scope: 'sessionMobile',
        sessionId: props.sessionId,
        machineId,
        serverId,
        pluginUiProjection: pluginProjection.pluginUiProjection,
        pluginBrowserProjection: pluginProjection.pluginBrowserProjection,
    });
    const recordingRuntime = useSessionBrowserRecordingRuntime({
        enabled: true,
        scopeKey: props.sessionId,
        sessionId: props.sessionId,
        machineId,
        serverId,
    });
    const browserContextRuntime = useSessionBrowserContextRuntimeContext();
    const productModels = React.useMemo(() => ({
        browserContext: browserContextRuntime?.browserShellContext ?? null,
        browserRecording: recordingRuntime?.browserShellRecording ?? null,
    }), [browserContextRuntime?.browserShellContext, recordingRuntime?.browserShellRecording]);

    return (
        <BrowserScopedWorkspace
            scopeId={scopeId}
            scope={{
                kind: 'session',
                sessionId: props.sessionId,
                serverId,
                machineId,
            }}
            openScope="sessionMobile"
            platform={resolveBrowserSurfacePlatform()}
            localServicePreviewState={hostProps.localServicePreviewState}
            localServicePreviewServerId={hostProps.localServicePreviewServerId}
            launchpadRows={hostProps.launchpadRows}
            launchpadRefreshStatus={hostProps.launchpadRefreshStatus}
            launchpadRefreshError={hostProps.launchpadRefreshError}
            productModels={productModels}
            pluginProjection={pluginProjection}
            pluginBrowserActionSessionId={props.sessionId}
            testID="session-mobile-browser"
        />
    );
}

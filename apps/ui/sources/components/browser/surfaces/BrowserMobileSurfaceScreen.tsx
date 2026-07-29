import * as React from 'react';

import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionBrowserContextRuntimeContext } from '@/components/sessions/browser/sessionBrowserContextRuntime';
import { useSessionBrowserRecordingRuntime } from '@/components/sessions/browser/sessionBrowserRecordingRuntime';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
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
}>): React.ReactElement {
    const machineTarget = useSessionMachineTarget(props.sessionId);
    const serverId = usePreferredServerIdForSession(props.sessionId);
    const machineId = machineTarget?.machineId ?? null;
    const scopeId = props.scopeId ?? `session:${props.sessionId}:mobile-browser`;
    // Assemble the live workspace-ranked launchpad feed so the mobile new-tab page shows running
    // services + recents (not only URL entry). The shared bootstrap also resolves the preview
    // state used to seed access URLs when a launchpad row is opened.
    const hostProps = useBrowserSurfaceHostProps({
        scope: 'sessionMobile',
        sessionId: props.sessionId,
        machineId,
        serverId,
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
            testID="session-mobile-browser"
        />
    );
}

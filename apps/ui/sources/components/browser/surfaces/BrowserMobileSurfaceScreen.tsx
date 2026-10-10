import * as React from 'react';

import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionBrowserContextProductModel } from '@/components/sessions/browser/useSessionBrowserContextProductModel';
import { useSessionBrowserRecordingRuntime } from '@/components/sessions/browser/sessionBrowserRecordingRuntime';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { resolveBrowserSurfacePlatform, useBrowserSurfaceHostProps } from './useBrowserSurfaceHostProps';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';

import { BrowserScopedWorkspace } from './BrowserScopedWorkspace';
import { BrowserSurfacePaneHeader } from './browserSurfacePaneHeader';

/**
 * The session's browser host outside the desktop Details workspace: the phone cockpit's Browser tab
 * and the session right panel's Browser tab both mount this one composition.
 *
 * Session-cockpit mobile browser surface. Mounts a scoped instance of the SAME details-workspace
 * tab engine as desktop (D2-revised) — `browser-view` tabs only, single-group, splits off. The
 * `scopeId` is threaded from the cockpit so the workspace has a stable per-surface pane scope.
 */
export function BrowserMobileSurfaceScreen(props: Readonly<{
    sessionId: string;
    /** Exact Home borrowed from a Session source owner; never an ambient selection override. */
    serverId?: string | null;
    scopeId?: string;
    testID?: string;
    /** The shared Session viewer consumes the focused body without a second workspace shell. */
    presentation?: 'workspace' | 'viewer';
    visible?: boolean;
    presentationSlotId?: string;
    keepAliveAboveRouter?: boolean;
    /**
     * An enclosing cockpit supplies its one admitted projection. Standalone
     * Browser routes retain the incumbent scoped lookup below.
     */
    pluginProjection?: PluginUiProjectionCurrentness;
}>): React.ReactElement {
    // An enclosing pane supplies its admitted target (its plugin projection's machine and Home);
    // that wins over ambient Session lookup, and an explicit unavailable target stays unavailable.
    // Standalone routes have no admitted target and resolve the Session's own.
    const admitted = props.pluginProjection !== undefined;
    const preferredServerId = usePreferredServerIdForSession({
        serverId: props.pluginProjection?.serverId ?? props.serverId,
        sessionId: props.sessionId,
    });
    const serverId = admitted
        ? props.pluginProjection?.serverId ?? props.serverId ?? null
        : props.serverId === undefined ? preferredServerId : props.serverId;
    const machineTarget = useSessionMachineTarget(props.sessionId, serverId);
    const machineId = admitted ? props.pluginProjection?.machineId ?? null : machineTarget?.machineId ?? null;
    const destinationScopeId = useDestinationPaneScopeId(createSessionPaneScopeId(props.sessionId, serverId));
    const scopeId = props.scopeId ?? destinationScopeId;
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
        scopeKey: scopeId,
        sessionId: props.sessionId,
        machineId,
        serverId,
    });
    const browserContext = useSessionBrowserContextProductModel({ machineId, serverId });
    const productModels = React.useMemo(() => ({
        browserContext: browserContext ?? null,
        browserRecording: recordingRuntime?.browserShellRecording ?? null,
    }), [browserContext, recordingRuntime?.browserShellRecording]);

    return (
        <>
            <BrowserSurfacePaneHeader presentation={props.presentation} serverId={serverId} machineId={machineId} />
            <BrowserScopedWorkspace
                scopeId={scopeId}
                presentation={props.presentation}
                visible={props.visible}
                presentationSlotId={props.presentationSlotId}
                keepAliveAboveRouter={props.keepAliveAboveRouter}
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
                testID={props.testID ?? 'session-mobile-browser'}
            />
        </>
    );
}

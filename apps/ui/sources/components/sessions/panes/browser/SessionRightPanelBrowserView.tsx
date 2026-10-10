import * as React from 'react';

import { BrowserMobileSurfaceScreen } from '@/components/browser/surfaces/BrowserMobileSurfaceScreen';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { RetainedSessionViewerSource } from '@/components/sessions/viewer/RetainedSessionViewerSource';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { SessionBrowserContextRuntimeProvider, useSessionBrowserContextRuntimeContext } from '@/components/sessions/browser/sessionBrowserContextRuntime';
import { isSessionViewerPresenting, SessionViewerBodyPresentation, useOptionalSessionViewerController } from '@/components/sessions/viewer/SessionViewerController';
import { SessionViewerPicture } from '@/components/sessions/viewer/SessionViewerPicture';
import { SessionViewerPresentedElsewhere } from '@/components/sessions/viewer/SessionViewerPresentedElsewhere';
import type { RetainedPresentationGeometryTransition, RetainedPresentationRect } from '@/components/ui/presentation/retainedPresentationSlots';

/**
 * The session right panel's Browser tab. It is the same host as the phone Browser tab (H-UX F-21:
 * one session browser composition). The focused source body retains its control, navigation and
 * recording lifetime while pane, floating and phone presentations bind its one retained slot.
 * Default standalone/project Browser workspaces remain owned by BrowserMobileSurfaceScreen.
 */
export function SessionRightPanelBrowserView(props: Readonly<{
    sessionId: string;
    visible?: boolean;
    /** Alternate presentations bind the same source slot, not a second Browser host. */
    presentationSlotId?: string;
    /** The Session shell's already-admitted plugin projection (and so its machine target). */
    pluginProjection?: PluginUiProjectionCurrentness;
    /** `viewer`: the floating/sticky viewer frame presents this body; `pane` (default): the right pane. */
    presentation?: 'pane' | 'viewer';
    windowGeometry?: RetainedPresentationRect | null;
    transition?: RetainedPresentationGeometryTransition | null;
    /** The watched page lets the pointer through to its presentation's frame. */
    inputPassthrough?: boolean;
}>): React.ReactElement {
    const accountLifetime = useSessionViewerSourceAccountLifetime();
    const viewer = useOptionalSessionViewerController();
    const browserContextRuntime = useSessionBrowserContextRuntimeContext();
    const preferredServerId = usePreferredServerIdForSession({
        sessionId: props.sessionId,
        serverId: props.pluginProjection === undefined
            ? accountLifetime?.scope.serverId
            : props.pluginProjection.serverId,
    });
    const serverId = props.pluginProjection === undefined
        ? preferredServerId
        : props.pluginProjection.serverId;
    const sourceServerId = serverId ?? accountLifetime?.scope.serverId ?? null;
    const scopeId = useDestinationPaneScopeId(createSessionPaneScopeId(
        props.sessionId,
        sourceServerId,
    ));
    const slotId = props.presentationSlotId
        ?? `${scopeId}:viewer:browser`;
    // Identity-stable across frame geometry: a moving viewer re-renders the slot binder only.
    const pluginProjection = props.pluginProjection;
    const visible = props.visible;
    const presentation = props.presentation ?? 'pane';
    // Pane and viewer bind the same element tree; only who frames the page (and draws its chrome and
    // presence) changes, so the page is never remounted by a presentation switch.
    const body = React.useMemo(() => (
        <SessionViewerBodyPresentation presentation={presentation}>
            <SessionViewerPicture framed={presentation === 'viewer'} source="browser">
                <SessionBrowserContextRuntimeProvider runtime={browserContextRuntime}>
                    <BrowserMobileSurfaceScreen
                        sessionId={props.sessionId}
                        serverId={sourceServerId}
                        scopeId={scopeId}
                        pluginProjection={pluginProjection}
                        presentation="viewer"
                        visible={visible}
                        keepAliveAboveRouter={false}
                        testID="session-rightpanel-browser"
                    />
                </SessionBrowserContextRuntimeProvider>
            </SessionViewerPicture>
        </SessionViewerBodyPresentation>
    ), [browserContextRuntime, pluginProjection, presentation, props.sessionId, scopeId, sourceServerId, visible]);
    // One body, one place: while the viewer presents the Browser, the pane does not bind it.
    if (presentation === 'pane' && isSessionViewerPresenting(viewer, 'browser')) {
        return <SessionViewerPresentedElsewhere source="browser" testID="session-rightpanel-browser" />;
    }
    return (
        <RetainedSessionViewerSource slotId={slotId} serverId={serverId} visible={props.visible}
            windowGeometry={props.windowGeometry} transition={props.transition}
            inputPassthrough={props.inputPassthrough}>
            {body}
        </RetainedSessionViewerSource>
    );
}

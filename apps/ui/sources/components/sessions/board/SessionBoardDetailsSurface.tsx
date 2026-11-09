import * as React from 'react';

import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import type { SessionBoardMountHost } from '@/sync/domains/session/board';

import { SessionBoardPane } from './SessionBoardPane';

/** The Details placement retains its chrome while only its active tab consumes a body. */
export const SessionBoardDetailsSurface = React.memo(function SessionBoardDetailsSurface(props: Readonly<{
    sessionId: string;
    session?: Session;
    serverId?: string | null;
    paneScopeId: string;
    host: Extract<SessionBoardMountHost, 'details' | 'focusedDetails'>;
    /** This Details tab is the active one; a background tab renders nothing live. */
    active: boolean;
    pluginRuntime: SessionPluginRuntimeState;
    callerHostedHtmlRuntime?: CallerHostedHtmlRuntime;
    focusedItemId?: string;
    onLeaveFocusedItem?: () => void;
    onReadFullItem?: (itemId: string) => void;
}>) {
    return (
        <SessionBoardPane
            sessionId={props.sessionId}
            {...(props.session ? { session: props.session } : {})}
            serverId={props.serverId}
            host={props.host}
            // The Details workspace keeps every
            // tab mounted for content, scroll and view continuity, so a retained
            // pane must keep drawing its Board while owning no interaction. Left
            // eligible, each hidden pane mounted its own editor over the one
            // shared draft and re-registered the one continuity draft guard, so
            // the last tab to mount answered Save with text nobody was looking at.
            retained={!props.active}
            density="full"
            layout="grid"
            {...(props.focusedItemId ? { focusedItemId: props.focusedItemId } : {})}
            {...(props.onLeaveFocusedItem ? { onLeaveFocusedItem: props.onLeaveFocusedItem } : {})}
            {...(props.onReadFullItem ? { onReadFullItem: props.onReadFullItem } : {})}
            pluginRuntime={props.pluginRuntime}
            {...(props.callerHostedHtmlRuntime ? { callerHostedHtmlRuntime: props.callerHostedHtmlRuntime } : {})}
        />
    );
});

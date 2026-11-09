import * as React from 'react';

import { SessionRightPanelTerminalView } from '@/components/sessions/panes/terminal/SessionRightPanelTerminalView';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { selectSessionTerminalWorkspaceHost } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { SessionEmbeddedTerminalPane } from '@/components/sessions/terminal/SessionEmbeddedTerminalPane';

export const SessionTerminalSurface = React.memo((props: Readonly<{
    sessionId: string;
    scopeId: string;
    presentation?: 'page' | 'details';
    terminalInstanceId?: string;
    testIdPrefix?: string | null;
}>) => {
    const presented = useLayoutPresentationActive();
    const detailsVisible = useAppPaneContext(value => props.presentation !== 'details'
        || selectSessionTerminalWorkspaceHost(value.state, props.scopeId, props.terminalInstanceId) === 'details');
    // Retain the scene/workspace, but release a hidden renderer's live PTY
    // attachment. The terminal owner recovers it by census on warm return.
    if (!presented || !detailsVisible) return null;
    if (props.presentation === 'details') return <SessionEmbeddedTerminalPane
        sessionId={props.sessionId} scopeId={props.scopeId} currentDockLocation="details"
        terminalInstanceId={props.terminalInstanceId} testIdPrefix={props.testIdPrefix} />;
    return (
        <SessionRightPanelTerminalView
            sessionId={props.sessionId}
            scopeId={props.scopeId}
            presentation={props.presentation}
        />
    );
});

import * as React from 'react';
import { SessionEmbeddedTerminalPane } from '@/components/sessions/terminal/SessionEmbeddedTerminalPane';
import { useSessionScreenTestIdsEnabled } from '../../shell/sessionScreenTestIds';

export const SessionRightPanelTerminalView = React.memo(function SessionRightPanelTerminalViewWeb(props: Readonly<{ sessionId: string; scopeId: string }>) {
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    return (
        <SessionEmbeddedTerminalPane
            sessionId={props.sessionId}
            scopeId={props.scopeId}
            currentDockLocation="sidebar"
            testIdPrefix={sessionScreenTestIdsEnabled ? 'session-rightpanel-terminal' : null}
        />
    );
});

export default SessionRightPanelTerminalView;

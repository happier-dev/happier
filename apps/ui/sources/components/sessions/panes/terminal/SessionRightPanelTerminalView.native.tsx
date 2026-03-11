import * as React from 'react';
import { SessionEmbeddedTerminalPane } from '@/components/sessions/terminal/SessionEmbeddedTerminalPane';
import { useSessionScreenTestIdsEnabled } from '../../shell/sessionScreenTestIds';

export type SessionRightPanelTerminalViewProps = Readonly<{
    sessionId: string;
    scopeId: string;
}>;

export const SessionRightPanelTerminalView = React.memo(function SessionRightPanelTerminalView(
    props: SessionRightPanelTerminalViewProps,
) {
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

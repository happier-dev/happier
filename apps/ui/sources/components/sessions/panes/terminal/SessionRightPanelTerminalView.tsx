import * as React from 'react';

import { useSessionScreenTestIdsEnabled } from '../../shell/sessionScreenTestIds';
import { SessionTerminalPage } from './SessionTerminalPage';

/**
 * The session's Terminal surface wherever it is a page of its own (the phone's Terminal page and the
 * cockpit terminal surface): the terminal workspace's chips over the active terminal (lab P1).
 */
export const SessionRightPanelTerminalView = React.memo(function SessionRightPanelTerminalView(props: Readonly<{
    sessionId: string;
    scopeId: string;
    presentation?: 'page';
}>) {
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    return (
        <SessionTerminalPage
            sessionId={props.sessionId}
            scopeId={props.scopeId}
            presentation={props.presentation}
            testIdPrefix={sessionScreenTestIdsEnabled ? 'session-rightpanel-terminal' : null}
        />
    );
});

export default SessionRightPanelTerminalView;

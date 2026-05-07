import * as React from 'react';

import { SessionRightPanelTerminalView } from '@/components/sessions/panes/terminal/SessionRightPanelTerminalView';

export const SessionTerminalSurface = React.memo((props: Readonly<{
    sessionId: string;
    scopeId: string;
}>) => (
    <SessionRightPanelTerminalView sessionId={props.sessionId} scopeId={props.scopeId} />
));

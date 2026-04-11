import * as React from 'react';

import { SessionRightPanelTerminalView } from '@/components/sessions/panes/terminal/SessionRightPanelTerminalView';

export const SessionTerminalSurface = React.memo((props: Readonly<{
    sessionId: string;
    scopeId: string;
    onOpenNewTerminalTab?: () => void;
}>) => {
    return (
        <SessionRightPanelTerminalView
            sessionId={props.sessionId}
            scopeId={props.scopeId}
            onOpenNewTerminalTab={props.onOpenNewTerminalTab}
        />
    );
});

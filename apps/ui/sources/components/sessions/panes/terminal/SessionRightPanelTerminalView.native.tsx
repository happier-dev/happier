import * as React from 'react';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionEmbeddedTerminalPane } from '@/components/sessions/terminal/SessionEmbeddedTerminalPane';
import { openNewSessionDetailsTerminalTab } from '@/components/sessions/terminal/embeddedTerminalDocking';
import { useSessionScreenTestIdsEnabled } from '../../shell/sessionScreenTestIds';

export type SessionRightPanelTerminalViewProps = Readonly<{
    sessionId: string;
    scopeId: string;
    onOpenNewTerminalTab?: (() => void) | null;
}>;

export const SessionRightPanelTerminalView = React.memo(function SessionRightPanelTerminalView(
    props: SessionRightPanelTerminalViewProps,
) {
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    const pane = useAppPaneScope(props.scopeId);
    return (
        <SessionEmbeddedTerminalPane
            sessionId={props.sessionId}
            scopeId={props.scopeId}
            currentDockLocation="sidebar"
            onOpenNewTerminalTab={props.onOpenNewTerminalTab ?? (() => openNewSessionDetailsTerminalTab(pane))}
            testIdPrefix={sessionScreenTestIdsEnabled ? 'session-rightpanel-terminal' : null}
        />
    );
});

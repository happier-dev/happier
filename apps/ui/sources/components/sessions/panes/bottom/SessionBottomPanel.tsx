import * as React from 'react';
import { View } from 'react-native';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionEmbeddedTerminalPane } from '@/components/sessions/terminal/SessionEmbeddedTerminalPane';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../../shell/sessionScreenTestIds';

export const SessionBottomPanel = React.memo((props: Readonly<{ sessionId: string; scopeId: string; onRequestClose?: () => void }>) => {
    const pane = useAppPaneScope(props.scopeId);
    const activeTabId = pane.scopeState?.bottom?.activeTabId ?? null;
    const requestClose = props.onRequestClose ?? pane.closeBottom;
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();

    return (
        <View
            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-bottom-panel-root')}
            style={{ flex: 1, minHeight: 0, minWidth: 0 }}
        >
            {activeTabId === 'terminal' ? (
                <View
                    testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-bottompanel-surface-terminal')}
                    style={{ flex: 1, minHeight: 0, minWidth: 0 }}
                >
                    <SessionEmbeddedTerminalPane
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        currentDockLocation="bottom"
                        onRequestClose={requestClose}
                        testIdPrefix={sessionScreenTestIdsEnabled ? 'session-bottompanel-terminal' : null}
                    />
                </View>
            ) : null}
        </View>
    );
});

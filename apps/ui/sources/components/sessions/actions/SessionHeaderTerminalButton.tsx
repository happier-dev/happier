import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
    closeEmbeddedTerminalOutsideDockLocation,
    openEmbeddedTerminalInDockLocation,
    SESSION_DETAILS_TERMINAL_TAB_KEY,
    type EmbeddedTerminalDockLocation,
} from '@/components/sessions/terminal/embeddedTerminalDocking';
import { t } from '@/text';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { isTerminalDetailsTab } from '@/components/terminal/terminalDetailsTabModel';

export const SessionHeaderTerminalButton = React.memo((_props: Readonly<{ sessionId: string; scopeId: string }>) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(_props.scopeId);
    const { dockLocation, terminalEnabled } = useSessionTerminalAvailability();
    const testId = useOptionalSessionScreenTestId('session-header-terminal-button');

    const scopeState = pane.scopeState;
    const rightTerminalActive = Boolean(scopeState?.right.isOpen) && scopeState?.right.activeTabId === 'terminal';
    const bottomTerminalActive = Boolean(scopeState?.bottom?.isOpen) && scopeState?.bottom?.activeTabId === 'terminal';
    const activeDetailsTab = scopeState?.details.activeTabKey
        ? scopeState.details.tabs.find((tab) => tab.key === scopeState.details.activeTabKey) ?? null
        : null;
    const detailsTerminalActive = Boolean(scopeState?.details.isOpen)
        && activeDetailsTab != null
        && isTerminalDetailsTab({
            resource: activeDetailsTab.resource,
            tabKey: activeDetailsTab.key,
        });

    const onPress = React.useCallback(() => {
        if (!terminalEnabled) return;

        if (dockLocation === 'bottom') {
            if (bottomTerminalActive) {
                pane.closeBottom();
                return;
            }
            closeEmbeddedTerminalOutsideDockLocation({ pane, dockLocation: 'bottom' });
            openEmbeddedTerminalInDockLocation({ pane, dockLocation: 'bottom' });
            return;
        }

        if (dockLocation === 'details') {
            if (detailsTerminalActive) {
                pane.closeDetailsTab(activeDetailsTab.key);
                return;
            }
            closeEmbeddedTerminalOutsideDockLocation({ pane, dockLocation: 'details' });
            openEmbeddedTerminalInDockLocation({ pane, dockLocation: 'details' });
            return;
        }

        // sidebar
        if (rightTerminalActive) {
            pane.closeRight();
            return;
        }
        closeEmbeddedTerminalOutsideDockLocation({ pane, dockLocation: 'sidebar' });
        openEmbeddedTerminalInDockLocation({ pane, dockLocation: 'sidebar' });
    }, [
        bottomTerminalActive,
        detailsTerminalActive,
        dockLocation,
        pane,
        rightTerminalActive,
        terminalEnabled,
        activeDetailsTab,
    ]);

    if (!terminalEnabled) return null;

    return (
        <Pressable
            testID={testId}
            onPress={onPress}
            hitSlop={15}
            style={({ pressed }) => ({
                width: 44,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
            })}
            accessibilityRole="button"
            accessibilityLabel={t('settings.terminal')}
        >
            <Ionicons name="terminal-outline" size={22} color={theme.colors.chrome.header.foreground} />
        </Pressable>
    );
});

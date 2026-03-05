import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { closeEmbeddedTerminalOutsideDockLocation, openEmbeddedTerminalInDockLocation, SESSION_DETAILS_TERMINAL_TAB_KEY, type EmbeddedTerminalDockLocation } from '@/components/sessions/terminal/embeddedTerminalDocking';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

export const SessionHeaderTerminalButton = React.memo((_props: Readonly<{ sessionId: string; scopeId: string }>) => {
    const { theme } = useUnistyles();
    const deviceType = useDeviceType();
    const pane = useAppPaneScope(_props.scopeId);
    const terminalEnabled = useFeatureEnabled('terminal.embeddedPty');
    const dockLocationRaw = useLocalSetting('embeddedTerminalDockLocation');
    const dockLocation = (deviceType === 'phone' ? 'sidebar' : dockLocationRaw) as EmbeddedTerminalDockLocation;

    const scopeState = pane.scopeState;
    const rightTerminalActive = Boolean(scopeState?.right.isOpen) && scopeState?.right.activeTabId === 'terminal';
    const bottomTerminalActive = Boolean(scopeState?.bottom?.isOpen) && scopeState?.bottom?.activeTabId === 'terminal';
    const detailsTerminalActive =
        Boolean(scopeState?.details.isOpen)
        && scopeState?.details.activeTabKey === SESSION_DETAILS_TERMINAL_TAB_KEY;

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
                pane.closeDetailsTab(SESSION_DETAILS_TERMINAL_TAB_KEY);
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
    ]);

    if (!terminalEnabled) return null;

    return (
        <Pressable
            testID="session-header-terminal-button"
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
            <Ionicons name="terminal-outline" size={22} color={theme.colors.header.tint} />
        </Pressable>
    );
});

import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { closeEmbeddedTerminalOutsideDockLocation, openEmbeddedTerminalInDockLocation, SESSION_DETAILS_TERMINAL_TAB_KEY } from '@/components/sessions/terminal/embeddedTerminalDocking';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { useOpenSessionTarget } from '@/components/sessions/panes/open/useOpenSessionTarget';
import { t } from '@/text';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';
import { readSessionTerminalMode, setSessionTerminalMode } from '@/components/sessions/terminal/sessionTerminalMode';
import { SESSION_HEADER_ICON_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * The workspace shell terminal, from the header.
 *
 * Two things used to be decided here that are not this button's to decide. It re-derived the dock
 * location (`deviceType === 'phone' ? 'sidebar' : setting`) beside `useSessionTerminalAvailability`,
 * which spells the same rule — and the terminal ROUTE reads the availability owner, so a button
 * disagreeing with it could push a screen that bounced straight back. And the `sidebar` location
 * called `pane.openRight` unconditionally, exactly like the agents glyph did: the sidebar IS the
 * right pane, `resolvePaneLayout` hides the right pane on every phone, and this button is rendered
 * outside the fold guard — so on a phone it was always visible and always dead.
 *
 * Both decisions now come from their owners: availability for WHERE it docks, and the shared open
 * decision for whether that dock exists on this layout or the terminal takes its own screen.
 */
export const SessionHeaderTerminalButton = React.memo((_props: Readonly<{ sessionId: string; scopeId: string; serverId?: string | null }>) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(_props.scopeId);
    const { terminalEnabled, dockLocation } = useSessionTerminalAvailability({
        sessionId: _props.sessionId,
        serverId: _props.serverId ?? null,
    });
    const openTarget = useOpenSessionTarget({
        sessionId: _props.sessionId,
        scopeId: _props.scopeId,
        ...(_props.serverId ? { serverId: _props.serverId } : null),
    });
    const testId = useOptionalSessionScreenTestId('session-header-terminal-button');

    const scopeState = pane.scopeState;
    const rightTerminalActive = Boolean(scopeState?.right.isOpen) && scopeState?.right.activeTabId === 'terminal';
    const bottomTerminalActive = Boolean(scopeState?.bottom?.isOpen) && scopeState?.bottom?.activeTabId === 'terminal';
    const detailsTerminalActive =
        Boolean(scopeState?.details.isOpen)
        && scopeState?.details.activeTabKey === SESSION_DETAILS_TERMINAL_TAB_KEY;

    const onPress = React.useCallback(() => {
        if (!terminalEnabled) return;
        const wasAttachedTerminal = readSessionTerminalMode(_props.sessionId) === 'session_attach';
        setSessionTerminalMode(_props.sessionId, 'workspace_shell');

        if (dockLocation === 'bottom') {
            if (bottomTerminalActive && !wasAttachedTerminal) {
                pane.closeBottom();
                return;
            }
            closeEmbeddedTerminalOutsideDockLocation({ pane, dockLocation: 'bottom' });
            openEmbeddedTerminalInDockLocation({ pane, dockLocation: 'bottom' });
            return;
        }

        if (dockLocation === 'details') {
            if (detailsTerminalActive && !wasAttachedTerminal) {
                pane.closeDetailsTab(SESSION_DETAILS_TERMINAL_TAB_KEY);
                return;
            }
            closeEmbeddedTerminalOutsideDockLocation({ pane, dockLocation: 'details' });
            openEmbeddedTerminalInDockLocation({ pane, dockLocation: 'details' });
            return;
        }

        // sidebar
        if (rightTerminalActive && !wasAttachedTerminal) {
            pane.closeRight();
            return;
        }
        closeEmbeddedTerminalOutsideDockLocation({ pane, dockLocation: 'sidebar' });
        // The right pane where this layout has one, `/session/<id>/terminal` where it does not.
        openTarget({ kind: 'terminal' });
    }, [
        bottomTerminalActive,
        detailsTerminalActive,
        dockLocation,
        openTarget,
        pane,
        rightTerminalActive,
        terminalEnabled,
        _props.sessionId,
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
            <Icon name="terminal" size={SESSION_HEADER_ICON_SIZE_PX} color={theme.colors.chrome.header.foreground} />
        </Pressable>
    );
});

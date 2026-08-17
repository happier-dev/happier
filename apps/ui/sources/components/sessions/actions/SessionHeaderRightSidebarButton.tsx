import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SidebarCollapseIcon, SidebarExpandIcon } from '@/components/navigation/shell/SidebarIcons';
import { t } from '@/text';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';
import { SESSION_HEADER_ICON_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';

/**
 * Opens and closes the right sidebar itself.
 *
 * Every other header icon opens the sidebar onto one specific tab, so there was no way to simply
 * show or hide the panel, and no way to close it from the header at all — reaching the collapse
 * control meant the panel already being open.
 *
 * The glyphs come from the canonical `SidebarIcons` pair and the strings from the details panel's
 * own toggle. A second icon or a second string for the same concept would be the split-brain.
 *
 * `edge="right"` picks the right-edge glyph: the pair defaults to the left sidebar, so without it
 * this control drew a panel on the opposite side of the screen from the one it opens.
 */
export const SessionHeaderRightSidebarButton = React.memo((props: Readonly<{
    scopeId: string;
}>) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const testId = useOptionalSessionScreenTestId('session-header-right-sidebar-button');
    const isOpen = pane.scopeState?.right?.isOpen === true;

    const onPress = React.useCallback(() => {
        if (isOpen) {
            pane.closeRight();
            return;
        }
        // No tabId: the pane restores whatever was last open, so toggling is lossless.
        pane.openRight();
    }, [isOpen, pane]);

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
            accessibilityState={{ expanded: isOpen }}
            accessibilityLabel={
                isOpen
                    ? t('session.detailsPanel.closeRightSidebarA11y')
                    : t('session.detailsPanel.openRightSidebarA11y')
            }
        >
            {isOpen ? (
                <SidebarCollapseIcon edge="right" size={SESSION_HEADER_ICON_SIZE_PX} color={theme.colors.chrome.header.foreground} />
            ) : (
                <SidebarExpandIcon edge="right" size={SESSION_HEADER_ICON_SIZE_PX} color={theme.colors.chrome.header.foreground} />
            )}
        </Pressable>
    );
});

SessionHeaderRightSidebarButton.displayName = 'SessionHeaderRightSidebarButton';

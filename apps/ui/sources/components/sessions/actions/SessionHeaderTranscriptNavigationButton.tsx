import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { canLayoutHostSessionPane } from '@/components/sessions/panes/open/sessionOpenTarget';
import { useSessionOpenLayout } from '@/components/sessions/panes/open/useSessionOpenLayout';
import { useSessionCockpitChromeRegistration } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { t } from '@/text';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';
import { SESSION_HEADER_ICON_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * Transcript navigation lives in the right pane, and — unlike the agent roster, the file browser and
 * the terminal — it has no screen of its own to fall back to. So the honest answer on a layout with
 * no right pane is not a different destination, it is no offer: `available` is false and the control
 * is not drawn. A visible button that cannot reach anything is the defect this corridor keeps
 * finding, and inventing a route here would be inventing a surface.
 *
 * The cockpit is the exception, and it is a real one: when cockpit chrome owns this session it draws
 * navigation as a surface rather than a pane, so the destination exists regardless of the layout.
 */
export function useTranscriptNavigationSurface(params: Readonly<{
    scopeId: string;
    sessionId?: string | null;
}>): Readonly<{ available: boolean; open: () => void }> {
    const pane = useAppPaneScope(params.scopeId);
    const cockpitChrome = useSessionCockpitChromeRegistration();
    const layout = useSessionOpenLayout();
    const cockpitOwnsSession = Boolean(params.sessionId) && cockpitChrome?.sessionId === params.sessionId;
    const available = cockpitOwnsSession || canLayoutHostSessionPane(layout, 'right');

    const open = React.useCallback(() => {
        if (params.sessionId && cockpitChrome?.sessionId === params.sessionId) {
            cockpitChrome.switchSurface('navigation');
            return;
        }
        if (!canLayoutHostSessionPane(layout, 'right')) return;
        pane.openRight({ tabId: 'navigation' });
        pane.setRightTab('navigation');
    }, [cockpitChrome, layout, pane, params.sessionId]);

    return React.useMemo(() => ({ available, open }), [available, open]);
}

export const SessionHeaderTranscriptNavigationButton = React.memo((props: Readonly<{
    scopeId: string;
    sessionId?: string | null;
}>) => {
    const { theme } = useUnistyles();
    const testId = useOptionalSessionScreenTestId('session-header-transcript-navigation-button');
    const { available, open: onPress } = useTranscriptNavigationSurface(props);

    if (!available) return null;

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
            accessibilityLabel={t('session.openTranscriptNavigation')}
        >
            <Icon name="list" size={SESSION_HEADER_ICON_SIZE_PX} color={theme.colors.chrome.header.foreground} />
        </Pressable>
    );
});

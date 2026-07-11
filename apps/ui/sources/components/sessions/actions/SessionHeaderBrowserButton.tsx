import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
    BrowserSurfaceOpenButton,
    createBrowserLaunchpadDetailsTab,
} from '@/components/browser/surfaces';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useDeviceType } from '@/utils/platform/responsive';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';

function decisionEnabled(decision: ReturnType<typeof useFeatureDecision>): boolean {
    return decision?.state === 'enabled';
}

/**
 * Desktop/web session-header affordance for opening the browser. On mobile the right-sidebar
 * Browser surface already hosts the browser (D1: the sidebar browser tab is mobile-only), so this
 * button is intentionally desktop/web-only — it gives desktop/web users the otherwise-missing entry
 * point.
 *
 * Pressing it opens the browser launcher empty-state (a workspace-ranked launchpad) INTO THE
 * DETAILS PANES via the canonical pane action: `openDetailsTab` opens the details pane when it is
 * closed (so the new tab is visible) and, when it is already open, keeps it open and just adds +
 * focuses the launchpad tab. It never toggles or closes an already-open pane, and never touches the
 * right sidebar — the canonical details open-state owner (`useAppPaneScope`) is the only mechanism.
 *
 * Gating mirrors {@link BrowserSurfaceOpenButton}: the `browser` and `browser.viewTargets`
 * client-represented feature decisions must both be enabled.
 */
export const SessionHeaderBrowserButton = React.memo((props: Readonly<{
    sessionId: string;
    scopeId: string;
}>) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const deviceType = useDeviceType();
    const browserDecision = useFeatureDecision('browser', { scopeKind: 'runtime' });
    const viewTargetsDecision = useFeatureDecision('browser.viewTargets', { scopeKind: 'runtime' });
    const testId = useOptionalSessionScreenTestId('session-header-browser-button');

    const onPress = React.useCallback(() => {
        // The canonical opener for the launcher empty-state: `openDetailsTab` opens-if-closed,
        // keeps-open + focuses if already open. The launchpad is a `browser-view` tab, so it lands
        // in the one details-workspace tab engine just like any opened target.
        pane.openDetailsTab(createBrowserLaunchpadDetailsTab(), { intent: 'pinned' });
    }, [pane]);

    // Mobile already exposes the browser via the right-sidebar surface; only desktop/web needs this
    // header entry point. `phone` is the canonical "mobile presentation" device type.
    if (deviceType === 'phone') {
        return null;
    }
    if (!decisionEnabled(browserDecision) || !decisionEnabled(viewTargetsDecision)) {
        return null;
    }

    return (
        <BrowserSurfaceOpenButton
            onPress={onPress}
            testID={testId ?? 'session-header-browser-button'}
            style={{
                width: 44,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
            }}
            iconColor={theme.colors.chrome.header.foreground}
        />
    );
});

SessionHeaderBrowserButton.displayName = 'SessionHeaderBrowserButton';

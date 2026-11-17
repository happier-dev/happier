import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useSessionCockpitSurfaceNavigation } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { resolveSessionPaneScreenRoutePath } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useWorkspaceFilePaneNavigation } from '@/components/workspaces/files/useWorkspaceFilePaneNavigation';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { resolveMultiPaneDeviceType } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { resolvePaneLayout } from '@/components/ui/panels/paneBreakpoints';
import { PANE_SIZING_DEFAULTS } from '@/components/appShell/panes/layout/paneSizing';
import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';

/** Session placement wraps the shared workspace command with the current cockpit/route owner. */
export function useSessionFilePaneNavigation(params: Readonly<{ scopeId: string; sessionId: string; serverId?: string | null }>) {
    const router = useRouter();
    const cockpit = useSessionCockpitSurfaceNavigation();
    const switchSurface = cockpit?.switchSurface;
    const { width } = useWindowDimensions();
    const deviceType = useDeviceType();
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const paneLayout = useOptionalAppPaneScopeLayout();
    const paneSupportsMultiPane = paneLayout ? paneLayout.multiPaneEnabled && paneLayout.deviceType !== 'phone' : null;
    const onNavigate = React.useCallback((tabId: 'files' | 'git') => {
        const surface = tabId === 'files' ? 'browse' : 'git';
        if (switchSurface) {
            switchSurface(surface);
            return;
        }
        const single = paneSupportsMultiPane !== null ? !paneSupportsMultiPane : resolvePaneLayout({
            containerWidthPx: width,
            deviceType: resolveMultiPaneDeviceType({ platform: Platform.OS, deviceType }),
            multiPaneEnabled,
            rightOpen: true,
            detailsOpen: false,
            mainMinPx: PANE_SIZING_DEFAULTS.mainMinPx,
            rightMinPx: PANE_SIZING_DEFAULTS.right.minPx,
            detailsMinPx: PANE_SIZING_DEFAULTS.details.minPx,
        }).kind === 'single';
        if (single) {
            router.push(resolveSessionPaneScreenRoutePath(params.sessionId, surface, { serverId: params.serverId }));
        }
    }, [switchSurface, deviceType, multiPaneEnabled, paneSupportsMultiPane, params.serverId, params.sessionId, router, width]);
    return useWorkspaceFilePaneNavigation(params.scopeId, onNavigate);
}

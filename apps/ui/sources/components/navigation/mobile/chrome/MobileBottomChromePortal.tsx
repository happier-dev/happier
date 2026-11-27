import * as React from 'react';
import { Platform } from 'react-native';
import { useLaunchCurtainState } from '@/boot/launchCurtain';
import { useWorkspaceNavigationActive } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { tryRenderWebPortal } from '@/components/ui/popover/portal';
import { MobileBottomChromeHost } from './MobileBottomChromeHost';
import { VoicePresenceAppShellMount } from '@/components/voice/presence/VoicePresenceAppShellMount';
import { useCurrentRoutePathname } from '@/components/appShell/workspace/currentRouteLocation';
import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { isTerminalConnectWebPathname } from '@/utils/path/terminalConnectUrl';

/**
 * Where the one bottom-chrome host mounts: `shell` beside the workspace shell, `route` in the app's route layout.
 * On web, while the workspace leads, the shell paints the page from the main bundle, but the route layout commits
 * only once the router's lazily loaded route chunks resolve (the production export loads routes asynchronously):
 * seconds after the page shows, so a composer painted without its bar's room rose 56 px when the bar arrived (K01,
 * 3 of 3 cold 390 loads on cut 53). There the host mounts with the shell. Natively, and on web without a workspace,
 * it stays in the route layout.
 */
export type MobileBottomChromeSite = 'shell' | 'route';

/** Keep Voice's existing primary-window and terminal-route exclusions at its selected mount site. */
function FloatingVoicePresence(): React.ReactElement | null {
    const pathname = useCurrentRoutePathname();
    if (resolveDesktopWindowContext().role !== 'primary' || isTerminalConnectWebPathname(pathname)) return null;
    return <VoicePresenceAppShellMount />;
}

export function MobileBottomChromePortal(props: Readonly<{ site: MobileBottomChromeSite }>): React.ReactElement | null {
    // This web portal sits outside the curtain's stacking context. Release it with the curtain's fade.
    const contentHidden = useLaunchCurtainState() === 'up';
    const shellHolds = useWorkspaceNavigationActive() && Platform.OS === 'web';
    if ((props.site === 'shell') !== shellHolds) return null;
    // The retained navigator is hidden while the workspace owns the visible session.
    // Keep its single bottom-chrome host visible and in the same React registry.
    const chrome = <><MobileBottomChromeHost contentHidden={contentHidden} /><FloatingVoicePresence /></>;
    return <>{tryRenderWebPortal({
        shouldPortalWeb: Platform.OS === 'web',
        portalTargetOnWeb: 'body',
        modalPortalTarget: null,
        getBoundaryDomElement: () => null,
        content: chrome,
    }) ?? chrome}</>;
}

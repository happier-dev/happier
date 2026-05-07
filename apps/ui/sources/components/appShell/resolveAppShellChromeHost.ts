export type AppShellChromeHost =
    | 'none'
    | 'web-top-right'
    | 'unauth-shell'
    | 'narrow-desktop-fallback';

export type ResolveAppShellChromeHostParams = Readonly<{
    isAuthenticated: boolean;
    isDesktopPetOverlayWindow: boolean;
    isTauriDesktop: boolean;
    isTablet: boolean;
    isTerminalConnectRoute: boolean;
}>;

export function resolveAppShellChromeHost(
    params: ResolveAppShellChromeHostParams,
): AppShellChromeHost {
    if (params.isTerminalConnectRoute || params.isDesktopPetOverlayWindow) {
        return 'none';
    }

    if (!params.isTauriDesktop) {
        return 'web-top-right';
    }

    if (!params.isAuthenticated) {
        return 'unauth-shell';
    }

    if (!params.isTablet) {
        return 'narrow-desktop-fallback';
    }

    return 'none';
}

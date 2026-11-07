export type AppShellChromeHost =
    | 'none'
    | 'unauth-shell'
    | 'narrow-desktop-fallback';

export type ResolveAppShellChromeHostParams = Readonly<{
    isAuthenticated: boolean;
    isDesktopPetOverlayWindow: boolean;
    isSessionFileWindow?: boolean;
    isTauriDesktop: boolean;
    isTablet: boolean;
    isTerminalConnectRoute: boolean;
}>;

export function resolveAppShellChromeHost(
    params: ResolveAppShellChromeHostParams,
): AppShellChromeHost {
    if (params.isTerminalConnectRoute || params.isDesktopPetOverlayWindow || params.isSessionFileWindow) {
        return 'none';
    }

    if (!params.isTauriDesktop) {
        return 'none';
    }

    if (!params.isAuthenticated) {
        return 'unauth-shell';
    }

    if (!params.isTablet) {
        return 'narrow-desktop-fallback';
    }

    return 'none';
}

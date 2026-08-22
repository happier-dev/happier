export type AppShellChromeHost =
    | 'none'
    | 'web-top-right'
    | 'unauth-shell'
    | 'narrow-desktop-fallback';

export type ResolveAppShellChromeHostParams = Readonly<{
    isAuthenticated: boolean;
    isWeb: boolean;
    isDesktopHost: boolean;
    isTablet: boolean;
    isTerminalConnectRoute: boolean;
}>;

export function resolveAppShellChromeHost(
    params: ResolveAppShellChromeHostParams,
): AppShellChromeHost {
    if (params.isTerminalConnectRoute) {
        return 'none';
    }

    if (!params.isDesktopHost && params.isWeb) {
        return 'web-top-right';
    }

    if (!params.isDesktopHost) {
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

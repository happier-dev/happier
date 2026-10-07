export function shouldKeepDesktopPersonalHomeShell(input: Readonly<{
    isAuthenticated: boolean;
    isPersonalHomeBootstrapHost: boolean;
}>): boolean {
    return !input.isAuthenticated
        && input.isPersonalHomeBootstrapHost;
}

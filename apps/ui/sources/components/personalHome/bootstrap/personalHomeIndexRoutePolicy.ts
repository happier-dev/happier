export function shouldKeepDesktopPersonalHomeShell(input: Readonly<{
    isAuthenticated: boolean;
    isPersonalHomeBootstrapActive: boolean;
}>): boolean {
    return !input.isAuthenticated
        && input.isPersonalHomeBootstrapActive;
}

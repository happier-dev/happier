export type FirstLaunchSetupRedirectPolicyInput = Readonly<{
    platformOs: string;
    isDesktopHost: boolean;
}>;

export function shouldAutoRedirectToSetupOnFirstLaunch(input: FirstLaunchSetupRedirectPolicyInput): boolean {
    const platformOs = String(input.platformOs ?? '').trim().toLowerCase();
    if (platformOs === 'ios' || platformOs === 'android') {
        return false;
    }
    return input.isDesktopHost === true;
}

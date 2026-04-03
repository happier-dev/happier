export type FirstLaunchSetupRedirectPolicyInput = Readonly<{
    platformOs: string;
    isDesktopTauri: boolean;
}>;

export function shouldAutoRedirectToSetupOnFirstLaunch(input: FirstLaunchSetupRedirectPolicyInput): boolean {
    const platformOs = String(input.platformOs ?? '').trim().toLowerCase();
    if (platformOs === 'ios' || platformOs === 'android') {
        return false;
    }
    return input.isDesktopTauri === true;
}


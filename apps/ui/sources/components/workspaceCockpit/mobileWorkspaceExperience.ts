export type MobileWorkspaceExperience = 'classic' | 'cockpit';
export type MobileWorkspaceExperienceToggleActionId =
    | 'header.openMobileWorkspaceCockpit'
    | 'header.openMobileWorkspaceClassic';

export function normalizeMobileWorkspaceExperience(
    value: string | null | undefined,
): MobileWorkspaceExperience {
    return value === 'classic' ? 'classic' : 'cockpit';
}

export function resolveNextMobileWorkspaceExperience(
    currentValue: string | null | undefined,
): MobileWorkspaceExperience {
    return normalizeMobileWorkspaceExperience(currentValue) === 'cockpit' ? 'classic' : 'cockpit';
}

export function resolveMobileWorkspaceExperienceTitleKey(
    value: string | null | undefined,
): 'settingsSession.mobileWorkspaceExperience.options.classicTitle' | 'settingsSession.mobileWorkspaceExperience.options.cockpitTitle' {
    return normalizeMobileWorkspaceExperience(value) === 'cockpit'
        ? 'settingsSession.mobileWorkspaceExperience.options.cockpitTitle'
        : 'settingsSession.mobileWorkspaceExperience.options.classicTitle';
}

export function resolveMobileWorkspaceExperienceToggleActionId(
    value: string | null | undefined,
): MobileWorkspaceExperienceToggleActionId {
    return normalizeMobileWorkspaceExperience(value) === 'cockpit'
        ? 'header.openMobileWorkspaceClassic'
        : 'header.openMobileWorkspaceCockpit';
}

export function resolveMobileWorkspaceExperienceToggleLabelKey(
    value: string | null | undefined,
): 'workspaceCockpit.openClassicView' | 'workspaceCockpit.openCockpit' {
    return normalizeMobileWorkspaceExperience(value) === 'cockpit'
        ? 'workspaceCockpit.openClassicView'
        : 'workspaceCockpit.openCockpit';
}

export function shouldShowMobileWorkspaceExperienceToggle(input: Readonly<{
    deviceType: string | null | undefined;
}>): boolean {
    return input.deviceType === 'phone';
}

export function isMobileWorkspaceCockpitEnabled(input: Readonly<{
    deviceType: string | null | undefined;
    mobileWorkspaceExperience: string | null | undefined;
}>): boolean {
    return shouldShowMobileWorkspaceExperienceToggle(input)
        && normalizeMobileWorkspaceExperience(input.mobileWorkspaceExperience) === 'cockpit';
}

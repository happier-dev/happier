export type MobileWorkspaceExperience = 'classic' | 'cockpit';
export type MobileWorkspaceExperienceToggleActionId =
    | 'header.openMobileWorkspaceCockpit'
    | 'header.openMobileWorkspaceClassic';

export function normalizeMobileWorkspaceExperience(
    value: string | null | undefined,
): MobileWorkspaceExperience {
    return value === 'cockpit' ? 'cockpit' : 'classic';
}

export function resolveNextMobileWorkspaceExperience(
    currentValue: string | null | undefined,
): MobileWorkspaceExperience {
    return normalizeMobileWorkspaceExperience(currentValue) === 'cockpit' ? 'classic' : 'cockpit';
}

export function resolveMobileWorkspaceExperienceTitleKey(
    value: string | null | undefined,
): 'settingsAppearance.mobileWorkspaceExperienceOptions.classic' | 'settingsAppearance.mobileWorkspaceExperienceOptions.cockpit' {
    return normalizeMobileWorkspaceExperience(value) === 'cockpit'
        ? 'settingsAppearance.mobileWorkspaceExperienceOptions.cockpit'
        : 'settingsAppearance.mobileWorkspaceExperienceOptions.classic';
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

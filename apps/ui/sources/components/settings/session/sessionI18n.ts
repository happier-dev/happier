export function getPermissionApplyTimingSubtitleKey(applyTiming: string): 'settingsSession.defaultPermissions.applyPermissionChangesImmediateSubtitle' | 'settingsSession.defaultPermissions.applyPermissionChangesNextPromptSubtitle' {
    return applyTiming === 'immediate'
        ? 'settingsSession.defaultPermissions.applyPermissionChangesImmediateSubtitle'
        : 'settingsSession.defaultPermissions.applyPermissionChangesNextPromptSubtitle';
}

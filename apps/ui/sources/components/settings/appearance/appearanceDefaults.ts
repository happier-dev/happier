import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type SettingsWriteDelta, type WritableSettingsKey } from '@/sync/domains/settings/settings';
import type { SettingOperationContext, SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { clearActiveThemeProfiles } from '@/theme/profiles/themeProfilePersistence';
import { readReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * The preferences the Appearance page shows, split by where each is stored. Theme mode and theme
 * slots are not listed: they change through the theme transition, which also applies them to the
 * running app. Language has its own page.
 */
const APPEARANCE_LOCAL_KEYS = [
    'uiFontScale',
    'uiContentWidthMode',
    'uiItemDensity',
    'uiMachineSummaryStyle',
    'uiMachineSummaryMetrics',
    'uiSurfaceFinish',
    'uiSurfaceFinishOverrides',
    'uiMultiPanePanelsEnabled',
    'detailsPaneTabsBehavior',
    'settingsNavSidebarEnabled',
    'titleStripThemeToggleVisible',
    'hapticsEnabled',
    'loadingIndicatorStyle',
    'loadingIndicatorSpeed',
    'loadingIndicatorPause',
] as const satisfies readonly (keyof LocalSettings)[];

const APPEARANCE_ACCOUNT_KEYS = [
    'avatarStyle',
    'homeBotFacesEnabled',
    'showFlavorIcons',
    'tabBarGitBadgeMode',
    'tabBarFriendsBadgeEnabled',
    'tabBarSessionsBadgeEnabled',
    'tabBarInboxBadgeEnabled',
    'tabBarOpenTabsBadgeEnabled',
    'tabBarShowLabels',
    'tabBarSize',
    'glassBlurEnabled',
    'glassBlurIntensity',
    'glassTintIntensity',
    'glassSurfaceMaterials',
    'visualEffectsLevel',
    'contextGaugeStyle',
    'animatedNumbers',
    'alwaysShowContextSize',
] as const satisfies readonly WritableSettingsKey[];

/** The defaults the page's Reset restores, taken from the canonical settings defaults. */
export function resolveAppearanceDefaults(): Readonly<{
    themePreference: LocalSettings['themePreference'];
    local: Partial<LocalSettings>;
    account: SettingsWriteDelta;
}> {
    const local: Partial<LocalSettings> = {};
    for (const key of APPEARANCE_LOCAL_KEYS) {
        Object.assign(local, { [key]: localSettingsDefaults[key] });
    }
    const account: SettingsWriteDelta = {};
    for (const key of APPEARANCE_ACCOUNT_KEYS) {
        Object.assign(account, { [key]: settingsDefaults[key] });
    }
    return { themePreference: localSettingsDefaults.themePreference, local, account };
}

/** One reversible page operation; Account and device effects share the same admitted invocation. */
export async function resetAppearanceSettings(context: SettingOperationContext): Promise<SettingOperationResult> {
    if (context.input !== undefined) return { status: 'unavailable', reason: 'invalid_operation_input' };
    if (!context.isCurrent() || !context.readLocalSettings || !context.writeLocalSettings) {
        return { status: 'unavailable', reason: 'setting_not_bound' };
    }
    const defaults = resolveAppearanceDefaults();
    const local = context.readLocalSettings();
    const { commitThemeSelection } = await import('@/theme/profiles/themeProfileRuntime');
    await commitThemeSelection({
        currentPreference: local.themePreference,
        nextPreference: defaults.themePreference,
        nextThemeProfiles: clearActiveThemeProfiles(local.themeProfiles),
        reduceMotion: readReducedMotionPreference(),
        writeLocal: context.writeLocalSettings,
    });
    context.writeLocalSettings(defaults.local);
    await context.mutateSettings(() => defaults.account);
    return { status: 'completed' };
}

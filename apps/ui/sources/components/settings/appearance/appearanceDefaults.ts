import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type SettingsWriteDelta, type WritableSettingsKey } from '@/sync/domains/settings/settings';
import type { SettingOperationContext, SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { DEFAULT_THEME_PROFILE_SELECTION_BY_MODE } from '@/theme/profiles/themeProfilePersistence';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

/**
 * The preferences the Appearance page shows, split by where each is stored. Theme mode and theme
 * slots are published with these defaults so the theme runtime observes one selection change.
 * Language has its own page.
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
    'systemTabBarEnabled',
    'loadingIndicatorStyle',
    'loadingIndicatorSpeed',
    'loadingIndicatorPause',
] as const satisfies readonly (keyof LocalSettings)[];

const APPEARANCE_ACCOUNT_KEYS = [
    'avatarStyle',
    'homeBotFacesEnabled',
    'botFaceStyle',
    'botMotion',
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
    'newSessionBackdropStrengthV1',
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
    if (!context.isCurrent() || !context.writeLocalSettings) {
        return { status: 'unavailable', reason: 'setting_not_bound' };
    }
    const defaults = resolveAppearanceDefaults();
    throwIfAborted(context.signal);
    context.writeLocalSettings({ ...defaults.local, themePreference: defaults.themePreference,
        themeProfileSelection: DEFAULT_THEME_PROFILE_SELECTION_BY_MODE });
    await context.mutateSettings(() => defaults.account);
    return { status: 'completed' };
}

import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type SettingsWriteDelta, type WritableSettingsKey } from '@/sync/domains/settings/settings';

/**
 * The preferences the Appearance page shows, split by where each is stored. Theme mode and theme
 * slots are not listed: they change through the theme transition, which also applies them to the
 * running app. Language has its own page.
 */
const APPEARANCE_LOCAL_KEYS = [
    'uiFontScale',
    'uiContentWidthMode',
    'uiItemDensity',
    'uiSurfaceFinish',
    'uiSurfaceFinishOverrides',
    'uiMultiPanePanelsEnabled',
    'detailsPaneTabsBehavior',
    'settingsNavSidebarEnabled',
    'titleStripThemeToggleVisible',
    'loadingIndicatorStyle',
    'loadingIndicatorSpeed',
    'loadingIndicatorPause',
] as const satisfies readonly (keyof LocalSettings)[];

const APPEARANCE_ACCOUNT_KEYS = [
    'avatarStyle',
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

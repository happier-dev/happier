import { DEFAULT_THEME_PROFILES_LOCAL_STATE, resolveThemeProfilesStateSnapshot } from '@/theme/profiles/themeProfilePersistence';
import type { ThemeProfileMigrationIntent, ThemeProfileDeviceSelectionByMode, ThemeProfilesLocalStateV1, ThemeProfilesStateSnapshot, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from './scope/accountSettingsScope';

export function canUseLegacyThemeProfiles(legacyScope: AccountSettingsScope | null, scope: AccountSettingsScope | null): boolean {
    return !legacyScope || areAccountSettingsScopesEqual(legacyScope, scope);
}

type AccountThemeProfilesInput = Readonly<{
    profiles: readonly ThemeProfileV1[];
    legacy: ThemeProfilesLocalStateV1;
    selection: ThemeProfileDeviceSelectionByMode | null;
    legacyScope: AccountSettingsScope | null;
    scope: AccountSettingsScope | null;
    pendingIntent?: ThemeProfileMigrationIntent | null;
    pendingProfiles?: readonly ThemeProfileV1[];
}>;

export function resolveAccountThemeProfilesSnapshot(input: AccountThemeProfilesInput): ThemeProfilesStateSnapshot {
    const legacy = canUseLegacyThemeProfiles(input.legacyScope, input.scope)
        ? input.legacy : DEFAULT_THEME_PROFILES_LOCAL_STATE;
    return resolveThemeProfilesStateSnapshot(input.profiles, legacy, input.selection, input.pendingIntent, input.pendingProfiles);
}

export function resolveAccountThemeProfiles(input: AccountThemeProfilesInput): ThemeProfilesLocalStateV1 {
    return resolveAccountThemeProfilesSnapshot(input).themeProfiles;
}

export { encodeThemeProfileSelection } from '@/theme/profiles/themeProfilePersistence';

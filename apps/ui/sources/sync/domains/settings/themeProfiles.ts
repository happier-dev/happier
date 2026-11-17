import { areAccountSettingsScopesEqual, type AccountSettingsScope } from './scope/accountSettingsScope';

export function canUseLegacyThemeProfiles(legacyScope: AccountSettingsScope | null, scope: AccountSettingsScope | null): boolean {
    return !legacyScope || areAccountSettingsScopesEqual(legacyScope, scope);
}

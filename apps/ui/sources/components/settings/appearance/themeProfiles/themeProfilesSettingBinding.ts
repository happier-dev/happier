import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { SETTING_VALUE_UNAVAILABLE } from '@/components/settings/catalog/settingDeclarations';
import { readThemeProfileReferenceSelection } from '@/theme/profiles/themeProfilePersistence';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { HappyError } from '@/utils/errors/errors';

type LocalOwnerBinding = Extract<SettingStorageBinding, { kind: 'localOwner' }>;
type ThemeSettingReadContext = Parameters<LocalOwnerBinding['read']>[1];
async function readThemeLibraryForSetting(_local: LocalSettings, context: ThemeSettingReadContext) {
    if (!context?.accountScope) return SETTING_VALUE_UNAVAILABLE;
    const { sync } = await import('@/sync/sync');
    try {
        return await sync.withThemeProfileLibrary(async library => ({ entries: await library.list(),
            selection: readThemeProfileReferenceSelection(loadLocalSettings().themeProfileSelection) }),
        { signal: context.signal, expectedScope: context.accountScope });
    } catch (error) {
        if (error instanceof HappyError && error.code === 'artifact_content_unavailable') return SETTING_VALUE_UNAVAILABLE;
        throw error;
    }
}
export const themeProfilesStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_only', requiresAccountScope: true,
    read: readThemeLibraryForSetting,
    parse: () => ({ success: false }),
    commit: () => SETTING_VALUE_UNAVAILABLE,
} satisfies SettingStorageBinding;

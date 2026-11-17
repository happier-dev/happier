import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { z } from 'zod/mini';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

export const THEME_MODE_CHOICES = ['adaptive', 'light', 'dark'] as const;
type ThemeModeChoice = typeof THEME_MODE_CHOICES[number];
const isThemeMode = (value: unknown): value is ThemeModeChoice => value === 'adaptive' || value === 'light' || value === 'dark';
const preferenceSchema = z.strictObject({ themePreference: z.enum(THEME_MODE_CHOICES) });
function readThemePreference(value: unknown) {
    if (isThemeMode(value)) return value;
    const preference = preferenceSchema.safeParse(value);
    if (preference.success) return preference.data.themePreference;
    return null;
}

/** The declared mode setting changes preference; theme Actions own reference selection. */
export const themeModeStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write', allowedValues: THEME_MODE_CHOICES,
    read: local => isThemeMode(local.themePreference) ? local.themePreference : 'adaptive',
    parse: value => {
        const preference = readThemePreference(value);
        // Preserve the scalar or structured value supplied to the settings Action.
        const parsed = SettingsDeclarationValueV1Schema.safeParse(value);
        return preference !== null && parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    commit: (_local, value, writeLocal, context) => {
        const preference = readThemePreference(value);
        if (preference === null) return;
        throwIfAborted(context?.signal);
        if (context?.isCurrent() === false) throw Object.assign(new Error('setting_not_bound'), { code: 'setting_not_bound' });
        // The mounted runtime observer owns palette application and its transition for every writer.
        writeLocal({ themePreference: preference });
    },
} satisfies SettingStorageBinding;

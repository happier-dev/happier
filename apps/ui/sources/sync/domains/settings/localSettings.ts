import { z } from 'zod';
import { LOCAL_SETTING_ARTIFACTS } from './registry/local/localSettingDefinitions';

//
// Schema
//

export const LocalSettingsSchema = z.object(LOCAL_SETTING_ARTIFACTS.shape);

//
// NOTE: Local settings are device-specific and should NOT be synced.
// These are preferences that make sense to be different on each device.
//

const LocalSettingsSchemaPartial = LocalSettingsSchema.passthrough().partial();
type LocalSettingsParseInput = z.infer<typeof LocalSettingsSchemaPartial>;

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

//
// Defaults
//

export const localSettingsDefaults: LocalSettings = LOCAL_SETTING_ARTIFACTS.defaults;
Object.freeze(localSettingsDefaults);

//
// Parsing
//

export function localSettingsParse(settings: unknown): LocalSettings {
    const parsed = LocalSettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) {
        return { ...localSettingsDefaults };
    }

    const legacyScaleBySize: Record<string, number> = {
        xxsmall: 0.8,
        xsmall: 0.85,
        small: 0.93,
        default: 1,
        large: 1.1,
        xlarge: 1.2,
        xxlarge: 1.3,
    };

    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

    const UI_FONT_SCALE_MIN = 0.5;
    const UI_FONT_SCALE_MAX = 2.5;

    const data: LocalSettingsParseInput = parsed.data;
    const nextUiFontScaleRaw =
        typeof data.uiFontScale === 'number'
            ? data.uiFontScale
            : (typeof data.uiFontSize === 'string' ? legacyScaleBySize[data.uiFontSize] : undefined);

    const nextUiFontScale =
        typeof nextUiFontScaleRaw === 'number' && Number.isFinite(nextUiFontScaleRaw)
            ? clamp(nextUiFontScaleRaw, UI_FONT_SCALE_MIN, UI_FONT_SCALE_MAX)
            : localSettingsDefaults.uiFontScale;

    return { ...localSettingsDefaults, ...parsed.data, uiFontScale: nextUiFontScale };
}

//
// Applying changes
//

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings>): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}

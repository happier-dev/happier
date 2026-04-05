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

const localSettingsDefaultsRecord: LocalSettingsRecord = {
    ...LOCAL_SETTING_ARTIFACTS.defaults,
};
normalizeActivitySurfaceLocalSettings(localSettingsDefaultsRecord);
normalizeDesktopOverlayLocalSettings(localSettingsDefaultsRecord);

export const localSettingsDefaults: LocalSettings = localSettingsDefaultsRecord;
Object.freeze(localSettingsDefaults);

//
// Parsing
//

type LocalSettingsRecord = LocalSettings & Record<string, unknown>;

function resolveBooleanAlias(
    primary: unknown,
    legacy: unknown,
    fallback: boolean,
): boolean {
    if (typeof primary === 'boolean') return primary;
    if (typeof legacy === 'boolean') return legacy;
    return fallback;
}

function resolveStringAlias<T extends string>(
    primary: unknown,
    legacy: unknown,
    fallback: T,
): T {
    if (typeof primary === 'string') return primary as T;
    if (typeof legacy === 'string') return legacy as T;
    return fallback;
}

function normalizeDesktopOverlayLocalSettings(settings: LocalSettingsRecord): LocalSettingsRecord {
    if (settings.desktopOverlayExpandedBehavior === 'shortcut_only') {
        settings.desktopOverlayExpandedBehavior = 'click';
    }

    return settings;
}

function normalizeLocalSettingsParseInput(settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return settings;
    }

    return normalizeDesktopOverlayLocalSettings({
        ...(settings as Record<string, unknown>),
    } as LocalSettingsRecord);
}

function normalizeActivitySurfaceLocalSettings(settings: LocalSettingsRecord): LocalSettingsRecord {
    const liveActivitiesEnabled = resolveBooleanAlias(
        settings.liveActivitiesEnabled,
        settings.iosLiveActivitiesEnabled,
        true,
    );
    settings.liveActivitiesEnabled = liveActivitiesEnabled;
    settings.iosLiveActivitiesEnabled = liveActivitiesEnabled;

    const widgetsEnabled = resolveBooleanAlias(
        settings.widgetsEnabled,
        settings.iosWidgetsEnabled,
        true,
    );
    settings.widgetsEnabled = widgetsEnabled;
    settings.iosWidgetsEnabled = widgetsEnabled;

    const widgetsPresetMode = resolveStringAlias(
        settings.widgetsPresetMode,
        settings.homeScreenWidgetsMode,
        'summary',
    );
    settings.widgetsPresetMode = widgetsPresetMode;
    settings.homeScreenWidgetsMode = widgetsPresetMode;

    const widgetsShowPreviewText = resolveBooleanAlias(
        settings.widgetsShowPreviewText,
        settings.homeScreenWidgetsShowPreviewText,
        true,
    );
    settings.widgetsShowPreviewText = widgetsShowPreviewText;
    settings.homeScreenWidgetsShowPreviewText = widgetsShowPreviewText;

    const widgetsShowMachinePath = resolveBooleanAlias(
        settings.widgetsShowMachinePath,
        settings.homeScreenWidgetsShowMachinePath,
        true,
    );
    settings.widgetsShowMachinePath = widgetsShowMachinePath;
    settings.homeScreenWidgetsShowMachinePath = widgetsShowMachinePath;

    return settings;
}

export function localSettingsParse(settings: unknown): LocalSettings {
    const parsed = LocalSettingsSchemaPartial.safeParse(normalizeLocalSettingsParseInput(settings));
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

    const normalizedParsedData = normalizeActivitySurfaceLocalSettings({ ...parsed.data } as LocalSettingsRecord);
    normalizeDesktopOverlayLocalSettings(normalizedParsedData);
    const next: LocalSettingsRecord = { ...localSettingsDefaults, ...normalizedParsedData, uiFontScale: nextUiFontScale };
    normalizeActivitySurfaceLocalSettings(next);
    normalizeDesktopOverlayLocalSettings(next);

    // Migration: older builds persisted the then-default settings sidebar width into storage.
    // When a user never resized the sidebar, their storage can still contain that legacy default
    // value. Treat it as "unset" so the newer default applies.
    const LEGACY_SETTINGS_NAV_SIDEBAR_DEFAULT_WIDTH_PX = 280;
    if (
        next.settingsNavSidebarWidthPx === LEGACY_SETTINGS_NAV_SIDEBAR_DEFAULT_WIDTH_PX
        && next.settingsNavSidebarWidthBasisPx === 1200
    ) {
        next.settingsNavSidebarWidthPx = localSettingsDefaults.settingsNavSidebarWidthPx;
    }

    return next;
}

//
// Applying changes
//

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings>): LocalSettings {
    const normalizedDelta = normalizeActivitySurfaceLocalSettings({ ...delta } as LocalSettingsRecord);
    normalizeDesktopOverlayLocalSettings(normalizedDelta);
    const next: LocalSettingsRecord = { ...localSettingsDefaults, ...settings, ...normalizedDelta };
    normalizeActivitySurfaceLocalSettings(next);
    normalizeDesktopOverlayLocalSettings(next);
    return next;
}

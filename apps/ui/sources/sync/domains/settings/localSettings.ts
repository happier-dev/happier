import { z } from 'zod';
import {
    AttentionDeviceOverridesV1Schema,
    deriveAttentionDeviceOverridesV1FromLegacyLocalSettings,
    hasLegacyAttentionDeviceOverrideFields,
} from './attentionDeviceOverridesV1';
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

export const localSettingsDefaults: LocalSettings = localSettingsDefaultsRecord;
Object.freeze(localSettingsDefaults);

const deprecatedLocalSettingKeys = [
    'editorFocusModeEnabled',
    'commandPaletteEnabled',
    'keyboardShortcutsV2Enabled',
    'keyboardSingleKeyShortcutsEnabled',
    'keyboardShortcutDisabledCommandIdsV1',
    'keyboardShortcutOverridesV1',
    'sessionsListStorageTab',
] as const;

function stripDeprecatedLocalSettingsKeys(settings: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const next: Record<string, unknown> = { ...settings };
    for (const key of deprecatedLocalSettingKeys) {
        delete next[key];
    }
    return next;
}

//
// Parsing
//

type LocalSettingsRecord = LocalSettings & Record<string, unknown>;
type LocalSettingsParseRecord = Record<string, unknown>;

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

function hasOwnKey(settings: Readonly<Record<string, unknown>>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(settings, key);
}

function syncBooleanAliasDelta(
    settings: LocalSettingsRecord,
    primaryKey: keyof LocalSettings,
    legacyKey: keyof LocalSettings,
    fallback: boolean,
): void {
    if (!hasOwnKey(settings, primaryKey) && !hasOwnKey(settings, legacyKey)) return;
    const value = resolveBooleanAlias(settings[primaryKey], settings[legacyKey], fallback);
    const mutableSettings = settings as Record<string, unknown>;
    mutableSettings[primaryKey] = value;
    mutableSettings[legacyKey] = value;
}

function syncStringAliasDelta<T extends string>(
    settings: LocalSettingsRecord,
    primaryKey: keyof LocalSettings,
    legacyKey: keyof LocalSettings,
    fallback: T,
): void {
    if (!hasOwnKey(settings, primaryKey) && !hasOwnKey(settings, legacyKey)) return;
    const value = resolveStringAlias(settings[primaryKey], settings[legacyKey], fallback);
    const mutableSettings = settings as Record<string, unknown>;
    mutableSettings[primaryKey] = value;
    mutableSettings[legacyKey] = value;
}

function migrateLegacyDesktopOverlayParseInput(
    settings: LocalSettingsParseRecord,
): LocalSettingsParseRecord {
    if (settings.desktopOverlayExpandedBehavior === 'shortcut_only') {
        settings.desktopOverlayExpandedBehavior = 'click';
    }

    return settings;
}

function normalizeActivitySurfaceLocalSettingsDelta(settings: LocalSettingsRecord): LocalSettingsRecord {
    syncBooleanAliasDelta(settings, 'liveActivitiesEnabled', 'iosLiveActivitiesEnabled', true);
    syncBooleanAliasDelta(settings, 'widgetsEnabled', 'iosWidgetsEnabled', true);
    syncStringAliasDelta(settings, 'widgetsPresetMode', 'homeScreenWidgetsMode', 'summary');
    syncBooleanAliasDelta(settings, 'widgetsShowPreviewText', 'homeScreenWidgetsShowPreviewText', true);
    syncBooleanAliasDelta(settings, 'widgetsShowMachinePath', 'homeScreenWidgetsShowMachinePath', true);
    if (settings.attentionDeviceOverridesV1 !== undefined) {
        settings.attentionDeviceOverridesV1 = AttentionDeviceOverridesV1Schema.parse(settings.attentionDeviceOverridesV1);
    }

    return settings;
}

function normalizeLocalSettingsParseInput(settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return settings;
    }

    const migrated = migrateLegacyDesktopOverlayParseInput({
        ...(settings as Record<string, unknown>),
    });
    if (migrated.sessionsListStorageFilter === undefined && migrated.sessionsListStorageTab === 'direct') {
        migrated.sessionsListStorageFilter = 'direct';
    }
    const next = stripDeprecatedLocalSettingsKeys(migrated);
    if (next.attentionDeviceOverridesV1 === undefined && hasLegacyAttentionDeviceOverrideFields(next)) {
        next.attentionDeviceOverridesV1 = deriveAttentionDeviceOverridesV1FromLegacyLocalSettings({
            legacy: next,
        });
    }
    return next;
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

    settings.attentionDeviceOverridesV1 = AttentionDeviceOverridesV1Schema.parse(settings.attentionDeviceOverridesV1);

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
    const next: LocalSettingsRecord = { ...localSettingsDefaults, ...normalizedParsedData, uiFontScale: nextUiFontScale };
    normalizeActivitySurfaceLocalSettings(next);

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

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings> | Readonly<Record<string, unknown>>): LocalSettings {
    const strippedDelta = stripDeprecatedLocalSettingsKeys({ ...delta });
    const updatesAttentionDeviceOverrides =
        strippedDelta.attentionDeviceOverridesV1 !== undefined
        || hasLegacyAttentionDeviceOverrideFields(strippedDelta);
    if (strippedDelta.attentionDeviceOverridesV1 === undefined && hasLegacyAttentionDeviceOverrideFields(strippedDelta)) {
        strippedDelta.attentionDeviceOverridesV1 = deriveAttentionDeviceOverridesV1FromLegacyLocalSettings({
            legacy: strippedDelta,
            base: settings.attentionDeviceOverridesV1,
        });
    }
    const normalizedDelta = normalizeActivitySurfaceLocalSettingsDelta(strippedDelta as LocalSettingsRecord);
    if (!updatesAttentionDeviceOverrides) {
        delete (normalizedDelta as Record<string, unknown>).attentionDeviceOverridesV1;
    }
    const next: LocalSettingsRecord = { ...localSettingsDefaults, ...settings, ...normalizedDelta };
    normalizeActivitySurfaceLocalSettings(next);
    if (!updatesAttentionDeviceOverrides) {
        next.attentionDeviceOverridesV1 = settings.attentionDeviceOverridesV1;
    }
    return stripDeprecatedLocalSettingsKeys(next) as LocalSettings;
}

import { isSettingsSyncDebugEnabled } from './debugSettings';
import { pruneSecretBindings } from './secretBindings';
import { PROVIDER_SETTINGS_PLUGINS } from '@/agents/providers/registry/providerSettingsRegistry';
import {
    PROVIDER_SETTINGS_DEFAULTS,
    PROVIDER_SETTINGS_SHAPE,
} from '@/agents/providers/registry/providerSettingArtifacts';
import { z } from 'zod';
import { ACCOUNT_SETTING_ARTIFACTS } from './registry/account/accountSettingArtifacts';
import { assertProviderSettingKeysCompatible } from './registry/provider/assertProviderSettingKeysCompatible';
import { stripDeprecatedSessionOnlyKeys } from './parse/accountSettingsLegacyCleanup';
import { parseAccountSettings } from './parse/accountSettingsParse';

// NOTE: We intentionally do NOT support legacy provider config objects (e.g. `openaiConfig`).
// Profiles must use `environmentVariables` + `envVarRequirements` only.

//
// Settings Schema
//

// Current schema version for backward compatibility
// NOTE: This schemaVersion is for the Happy app's settings blob (synced via the server).
// happy-cli maintains its own local settings schemaVersion separately.
export const SUPPORTED_SCHEMA_VERSION = 6;

assertProviderSettingKeysCompatible({
    coreSettingKeys: Object.keys(ACCOUNT_SETTING_ARTIFACTS.shape),
    plugins: PROVIDER_SETTINGS_PLUGINS,
});

const SettingsSchemaMetadata = z.object({
    // Schema version for compatibility detection
    schemaVersion: z.number().default(SUPPORTED_SCHEMA_VERSION).describe('Settings schema version for compatibility checks'),
});

const SettingsSchemaBase = SettingsSchemaMetadata.extend(ACCOUNT_SETTING_ARTIFACTS.shape);

export const SettingsSchema = SettingsSchemaBase.extend(PROVIDER_SETTINGS_SHAPE);

//
// NOTE: Settings must be a flat object with no to minimal nesting, one field == one setting,
// you can name them with a prefix if you want to group them, but don't nest them.
// You can nest if value is a single value (like image with url and width and height)
// Settings are always merged with defaults and field by field.
// 
// This structure must be forward and backward compatible. Meaning that some versions of the app
// could be missing some fields or have a new fields. Everything must be preserved and client must 
// only touch the fields it knows about.
//

type SettingsMetadata = Readonly<{
    schemaVersion: number;
}>;

export type KnownSettings = SettingsMetadata & typeof ACCOUNT_SETTING_ARTIFACTS.defaults;
export type Settings = KnownSettings & typeof PROVIDER_SETTINGS_DEFAULTS;
export { ACCOUNT_SETTING_ARTIFACTS };

//
// Defaults
//

export const settingsDefaults: Settings = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    ...ACCOUNT_SETTING_ARTIFACTS.defaults,
    ...PROVIDER_SETTINGS_DEFAULTS,
};
Object.freeze(settingsDefaults);

//
// Resolving
//

export function settingsParse(settings: unknown): Settings {
    return parseAccountSettings({
        settings,
        schema: SettingsSchema,
        defaults: settingsDefaults as Record<string, unknown>,
        supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
        pruneResult: (nextSettings) => pruneSecretBindings(nextSettings as Settings) as Record<string, unknown>,
        debugEnabled: isSettingsSyncDebugEnabled(),
        isDev: typeof __DEV__ !== 'undefined' && __DEV__,
    }) as Settings;
}

//
// Applying changes
// NOTE: May be something more sophisticated here around defaults and merging, but for now this is fine.
//

export function applySettings(settings: Settings, delta: Partial<Settings>): Settings {
    // Original behavior: start with settings, apply delta, fill in missing with defaults
    const result = { ...settings, ...delta };

    // Hard cutover: remove deprecated session-only settings keys even if they exist in the input.
    const cleanedResult = stripDeprecatedSessionOnlyKeys(result as Record<string, unknown>);

    // Fill in any missing fields with defaults
    const defaultsRecord = settingsDefaults as Record<string, unknown>;
    for (const [key, value] of Object.entries(defaultsRecord)) {
        if (!Object.prototype.hasOwnProperty.call(cleanedResult, key)) {
            cleanedResult[key] = value;
        }
    }

    return pruneSecretBindings(cleanedResult as Settings);
}

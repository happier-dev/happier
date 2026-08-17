import {
    ACCOUNT_SETTING_ARTIFACTS,
    ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
    accountSettingsParse as parseProtocolAccountSettings,
    type AccountSettings,
    type AccountSettingsDefaults,
} from '@happier-dev/protocol';
import { z } from 'zod';

import {
    stripDeprecatedSessionOnlyKeys,
} from './parse/accountSettingsLegacyCleanup';
import { applyAccountSettingsCompatibilityMigrations } from './parse/accountSettingsCompatibilityMigrations';
import {
    LOCAL_ACCOUNT_SETTING_ARTIFACTS,
    parseLocalAccountSettings,
    type LocalAccountSettings,
} from './registry/local/localAccountSettingDefinitions';
import { pruneSecretBindings } from './secretBindings';
import {
    isCurrentWriterPredecessorVoiceProjection,
    projectVoiceSettingsIntoRuntimeSettings,
    type ProtocolAccountSettingsRuntimeProjection,
} from './voiceSettingsPersistence';
import {
    attachCurrentSessionAuthoringSelectionsRuntimeProjection,
    type CurrentSessionAuthoringSelectionsRuntimeProjection,
} from './sessionAuthoringSelectionPersistence';
import { migrateLegacyVoiceOpenAiChatProvider } from '@/voice/adapters/localConversation/migrateLegacyOpenAiChatProvider';

// NOTE: We intentionally do NOT support legacy provider config objects (e.g. `openaiConfig`).
// Profiles must use `environmentVariables` + `envVarRequirements` only.

/** Current schema version for the server-synced Account Settings document. */
export const SUPPORTED_SCHEMA_VERSION = ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION;

/**
 * UI facade metadata only. Its Account fields are direct references to the Protocol catalog;
 * device-local fields are owned by the separate local catalog below.
 */
export const SettingsSchema = z.object({
    ...ACCOUNT_SETTING_ARTIFACTS.shape,
    ...LOCAL_ACCOUNT_SETTING_ARTIFACTS.shape,
});

/**
 * Protocol owns the persisted shape, including bounded compatibility roots.
 * UI consumers receive the typed Voice projection materialized by the owner
 * above rather than interpreting those retained roots themselves.
 */
type RuntimeAccountSettings = Omit<
    ProtocolAccountSettingsRuntimeProjection,
    'favoriteModelSelectionsV1' | 'lastEngineSelectionsByScopeV1'
> & CurrentSessionAuthoringSelectionsRuntimeProjection;

export type KnownSettings = RuntimeAccountSettings & LocalAccountSettings;
export type Settings = KnownSettings;

/**
 * Runtime projections may be readable through Settings without being valid
 * Account Settings mutations. The current binding map is derived from the
 * retained Protocol carrier, so only its dedicated writer may update it.
 */
export type WritableSettingsKey = Exclude<
    keyof Settings,
    | 'currentSecretBindingsByProfileId'
    | 'currentFavoriteModelSelectionsV1'
    | 'currentRememberedEngineSelectionsByScopeV1'
>;

/** Public generic Account Settings write shape. */
export type SettingsWriteDelta = Partial<Pick<Settings, WritableSettingsKey>>;

/**
 * Internal Account Settings write shape. The retained secret-binding carrier
 * is intentionally absent from the public Settings facade, but its dedicated
 * adapter must pass the canonical Protocol root through the common writer.
 */
export type AccountSettingsWriteDelta = SettingsWriteDelta & Partial<Pick<
    AccountSettingsDefaults,
    | 'secretBindingsByProfileId'
    | 'favoriteModelSelectionsV1'
    | 'lastEngineSelectionsByScopeV1'
>>;

export { ACCOUNT_SETTING_ARTIFACTS };

const protocolAndLocalSettingsDefaults: AccountSettings & LocalAccountSettings = {
    ...parseProtocolAccountSettings({}),
    ...LOCAL_ACCOUNT_SETTING_ARTIFACTS.defaults,
};

export const settingsDefaults: Settings = projectRuntimeAccountSettings(
    projectVoiceSettingsIntoRuntimeSettings({
        parsed: protocolAndLocalSettingsDefaults,
        raw: {},
    }),
) as Settings;
Object.freeze(settingsDefaults);

/**
 * Apply the remaining Settings-owned runtime projections after Protocol and
 * Voice have preserved their persisted raw carriers for writeback.
 */
export function projectRuntimeAccountSettings<T extends object>(settings: T): T & CurrentSessionAuthoringSelectionsRuntimeProjection {
    return attachCurrentSessionAuthoringSelectionsRuntimeProjection(settings);
}

function asSettingsRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

/**
 * Protocol parses every server-synced key and preserves forward-compatible unknown keys. UI
 * migrations only translate predecessor shapes before a final Protocol parse; device-local
 * fields are projected separately and are never part of the Protocol persistence contract.
 */
export function settingsParse(settings: unknown): Settings {
    const raw = asSettingsRecord(settings);
    const inputSchemaVersion = typeof raw.schemaVersion === 'number'
        ? raw.schemaVersion
        : SUPPORTED_SCHEMA_VERSION;
    const initial = parseProtocolAccountSettings(raw);
    const migrated = applyAccountSettingsCompatibilityMigrations({
        input: raw,
        settings: { ...initial },
        inputSchemaVersion,
        supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    });
    const canonical = parseProtocolAccountSettings(migrated);
    const merged = {
        ...canonical,
        ...parseLocalAccountSettings(raw),
    };
    const pruned = pruneSecretBindings(merged);
    const projected = projectVoiceSettingsIntoRuntimeSettings({
        parsed: pruned,
        raw,
    });

    // The Provider-owned legacy Chat migration needs the canonical Local
    // Conversation envelope created by the sole Voice projection owner. It
    // therefore runs after that projection, then re-enters the ordinary
    // Protocol/Voice parse path so its provider connection and typed state
    // are persisted through the same canonical reader as every other value.
    const migrationInput = { ...projected } as Record<string, unknown>;
    if (!isCurrentWriterPredecessorVoiceProjection(raw.voice)) {
        migrateLegacyVoiceOpenAiChatProvider(raw, migrationInput);
    }
    const migratedCanonical = parseProtocolAccountSettings(migrationInput);
    const migratedMerged = {
        ...migratedCanonical,
        ...parseLocalAccountSettings(raw),
    };
    const migratedPruned = pruneSecretBindings(migratedMerged);
    return projectRuntimeAccountSettings(projectVoiceSettingsIntoRuntimeSettings({
        parsed: migratedPruned,
        raw,
    })) as Settings;
}

/** Apply a delta through the same Protocol-owned parse/migration path as loaded settings. */
export function applySettings(settings: Settings, delta: AccountSettingsWriteDelta): Settings {
    return settingsParse(stripDeprecatedSessionOnlyKeys({ ...settings, ...delta }));
}

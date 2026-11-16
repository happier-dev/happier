import type { Settings } from '@/sync/domains/settings/settings';
import { stripReadOnlyAccountSettingsDelta } from '@/sync/domains/settings/localOnlyAccountSettings';
import { stripMigratedSessionOrganizationSettings } from '@/sync/domains/settings/parse/accountSettingsLegacyCleanup';
import { hydrateAccountSettingsFromLocalPersistence } from '@/sync/domains/settings/accountSettingsNormalization';
import { accountSettingsScopeKeySuffix, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { assertNoUnsealedSettingsSecretValues } from '@/sync/encryption/secretSettings';
import { parseThemeProfileMigrationIntent } from '@/theme/profiles/themeProfileMigrationEdits';
import type { ThemeProfileMigrationIntent } from '@/theme/profiles/themeProfileTypes';
import { parseStoredPendingSettings } from './persistence';
import { getPersistenceStorage } from './persistenceStorage';
import { migrateNewSessionUiState } from './newSessionTargetUiState';
import { publishPendingAccountSettingsPersistenceMutation } from './accountSettingsPersistenceSubscriptions';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export const THEME_PROFILE_MIGRATION_PENDING_KEY = '__themeProfileMigrationEditsV1';
export type PendingAccountSettingsKey = keyof Settings | 'themeProfiles' | typeof THEME_PROFILE_MIGRATION_PENDING_KEY;
export type PendingAccountSettingsState = Readonly<{
    settings: Partial<Settings>;
    themeProfileMigration: ThemeProfileMigrationIntent | null;
}>;

export function pendingAccountSettingsKey(scope: AccountSettingsScope): string {
    return `pending-account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`;
}

function readPendingRecordAtKey(key: string): Record<string, unknown> {
    const raw = getPersistenceStorage().getString(key);
    if (!raw) return {};
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return {}; }
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readPendingRecord(scope: AccountSettingsScope): Record<string, unknown> {
    return readPendingRecordAtKey(pendingAccountSettingsKey(scope));
}

function readIntent(record: Readonly<Record<string, unknown>>): ThemeProfileMigrationIntent | null {
    if (!(THEME_PROFILE_MIGRATION_PENDING_KEY in record)) return null;
    const intent = parseThemeProfileMigrationIntent(record[THEME_PROFILE_MIGRATION_PENDING_KEY]);
    if (!intent) throw new Error('Invalid pending theme profile migration');
    return intent;
}

export type PendingThemeProfileMigrationInput = Readonly<{ profiles: unknown; intent: ThemeProfileMigrationIntent | null }>;

/** Released predecessor bytes are import-only, outside effective writable Settings. */
export function loadPendingThemeProfileMigrationInput(scope: AccountSettingsScope): PendingThemeProfileMigrationInput {
    const source = readPendingRecord(scope);
    return { profiles: source.themeProfiles, intent: readIntent(source) };
}

/** Retire only the captured input after Artifact and Account-source acknowledgements. */
export function retirePendingThemeProfileMigrationInput(scope: AccountSettingsScope, expected: PendingThemeProfileMigrationInput): void {
    const previous = readPendingRecord(scope);
    if (!sameStrictJsonValue(previous.themeProfiles, expected.profiles) || !sameStrictJsonValue(readIntent(previous), expected.intent)) return;
    if (!Object.hasOwn(previous, 'themeProfiles') && !Object.hasOwn(previous, THEME_PROFILE_MIGRATION_PENDING_KEY)) return;
    const next = { ...previous };
    delete next.themeProfiles;
    delete next[THEME_PROFILE_MIGRATION_PENDING_KEY];
    const storage = getPersistenceStorage();
    if (Object.keys(next).length) storage.set(pendingAccountSettingsKey(scope), JSON.stringify(next));
    else storage.delete(pendingAccountSettingsKey(scope));
    publishPendingAccountSettingsPersistenceMutation(scope, previous, next);
}

/** Existing scope activation relocates a released input before deleting its old envelope. */
export function migratePendingThemeProfileInputToScope(sourceScope: AccountSettingsScope | null, targetScope: AccountSettingsScope): void {
    const sourceKey = sourceScope ? pendingAccountSettingsKey(sourceScope) : 'pending-settings';
    const targetKey = pendingAccountSettingsKey(targetScope);
    if (sourceKey === targetKey) return;
    const source = readPendingRecordAtKey(sourceKey);
    if (!Object.hasOwn(source, 'themeProfiles') && !Object.hasOwn(source, THEME_PROFILE_MIGRATION_PENDING_KEY)) return;
    const previous = readPendingRecord(targetScope);
    const currentHasInput = Object.hasOwn(previous, 'themeProfiles') || Object.hasOwn(previous, THEME_PROFILE_MIGRATION_PENDING_KEY);
    if (!currentHasInput) readIntent(source);
    // The snapshot and checkpoint belong together. A current destination is
    // authoritative; mixing an alias checkpoint into it can resurrect deletions.
    const next = currentHasInput ? previous : { ...previous,
        ...(Object.hasOwn(source, 'themeProfiles') ? { themeProfiles: source.themeProfiles } : {}),
        ...(Object.hasOwn(source, THEME_PROFILE_MIGRATION_PENDING_KEY)
            ? { [THEME_PROFILE_MIGRATION_PENDING_KEY]: source[THEME_PROFILE_MIGRATION_PENDING_KEY] } : {}),
    };
    const storage = getPersistenceStorage();
    if (!currentHasInput) storage.set(targetKey, JSON.stringify(next));
    const remaining = { ...source };
    delete remaining.themeProfiles;
    delete remaining[THEME_PROFILE_MIGRATION_PENDING_KEY];
    if (Object.keys(remaining).length) storage.set(sourceKey, JSON.stringify(remaining));
    else storage.delete(sourceKey);
    if (!currentHasInput) publishPendingAccountSettingsPersistenceMutation(targetScope, previous, next);
    if (sourceScope) publishPendingAccountSettingsPersistenceMutation(sourceScope, source, remaining);
}

/** Metadata stays in the existing pending envelope and never enters a Settings mutation. */
export function loadPendingAccountSettingsState(scope: AccountSettingsScope): PendingAccountSettingsState {
    let parsed: unknown = readPendingRecord(scope);
    const themeProfileMigration = readIntent(parsed as Record<string, unknown>);
    try {
        const migrated = migrateNewSessionUiState(scope, parsed);
        if (migrated !== parsed) {
            getPersistenceStorage().set(pendingAccountSettingsKey(scope), JSON.stringify(migrated));
            parsed = migrated;
        }
    } catch {
        console.warn('[machines] Retained pending target history could not be migrated; keeping its source.');
    }
    const hydrated = hydrateAccountSettingsFromLocalPersistence(parsed);
    return { settings: stripMigratedSessionOrganizationSettings(
        parseStoredPendingSettings(hydrated) as Record<string, unknown>,
    ) as Partial<Settings>, themeProfileMigration };
}

export function loadPendingAccountSettings(scope: AccountSettingsScope): Partial<Settings> {
    return loadPendingAccountSettingsState(scope).settings;
}

/** Preference writes preserve released migration input without authoring it. */
export function savePendingAccountSettings(scope: AccountSettingsScope, settings: Partial<Settings>): void {
    assertNoUnsealedSettingsSecretValues(settings);
    const previous = readPendingRecord(scope);
    const intent = readIntent(previous);
    const sanitized = stripReadOnlyAccountSettingsDelta(stripMigratedSessionOrganizationSettings(settings as Record<string, unknown>));
    const next: Record<string, unknown> = { ...sanitized };
    if ('themeProfiles' in previous) next.themeProfiles = previous.themeProfiles;
    if (intent) {
        next[THEME_PROFILE_MIGRATION_PENDING_KEY] = intent;
    }
    const storage = getPersistenceStorage();
    if (Object.keys(next).length) storage.set(pendingAccountSettingsKey(scope), JSON.stringify(next));
    else storage.delete(pendingAccountSettingsKey(scope));
    publishPendingAccountSettingsPersistenceMutation(scope, previous, next);
}

export function readPendingAccountSettingsPersistenceMutationToken(scope: AccountSettingsScope,
    keys?: readonly PendingAccountSettingsKey[]): string | null {
    const record = readPendingRecord(scope);
    const selected = keys ? Object.fromEntries(keys.filter(key => key in record).map(key => [key, record[key]])) : record;
    return Object.keys(selected).length ? JSON.stringify(selected) : null;
}

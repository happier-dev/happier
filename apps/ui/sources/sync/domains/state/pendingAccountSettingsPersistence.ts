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

export const THEME_PROFILE_MIGRATION_PENDING_KEY = '__themeProfileMigrationEditsV1';
export type PendingAccountSettingsKey = keyof Settings | typeof THEME_PROFILE_MIGRATION_PENDING_KEY;
export type PendingAccountSettingsState = Readonly<{
    settings: Partial<Settings>;
    themeProfileMigration: ThemeProfileMigrationIntent | null;
}>;

export function pendingAccountSettingsKey(scope: AccountSettingsScope): string {
    return `pending-account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`;
}

function readPendingRecord(scope: AccountSettingsScope): Record<string, unknown> {
    const raw = getPersistenceStorage().getString(pendingAccountSettingsKey(scope));
    if (!raw) return {};
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return {}; }
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readIntent(record: Readonly<Record<string, unknown>>): ThemeProfileMigrationIntent | null {
    if (!(THEME_PROFILE_MIGRATION_PENDING_KEY in record)) return null;
    const intent = parseThemeProfileMigrationIntent(record[THEME_PROFILE_MIGRATION_PENDING_KEY]);
    if (!intent) throw new Error('Invalid pending theme profile migration');
    return intent;
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

/** Omitted metadata preserves an in-flight migration; explicit null retires it after source cleanup. */
export function savePendingAccountSettings(scope: AccountSettingsScope, settings: Partial<Settings>,
    themeProfileMigration?: ThemeProfileMigrationIntent | null): void {
    assertNoUnsealedSettingsSecretValues(settings);
    const previous = readPendingRecord(scope);
    const intent = themeProfileMigration === undefined ? readIntent(previous) : themeProfileMigration;
    const sanitized = stripReadOnlyAccountSettingsDelta(stripMigratedSessionOrganizationSettings(settings as Record<string, unknown>));
    const next: Record<string, unknown> = { ...sanitized };
    if (intent) {
        // A delayed ordinary Settings flush cannot erase a durable theme handoff.
        if (!('themeProfiles' in next) && 'themeProfiles' in previous) next.themeProfiles = previous.themeProfiles;
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

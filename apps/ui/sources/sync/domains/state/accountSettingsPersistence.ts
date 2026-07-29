import { applySettings, settingsDefaults, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { stripMigratedSessionOrganizationSettings } from '@/sync/domains/settings/parse/accountSettingsLegacyCleanup';
import {
    pickLocalOnlyAccountSettings,
    stripLocalOnlyAccountSettings,
} from '@/sync/domains/settings/localOnlyAccountSettings';
import {
    isServerIssuedIdentityId,
    migrateAccountSettingsServerIdentityKeys,
    pickChangedServerIdentitySessionPresentationSettings,
} from '@/sync/domains/settings/serverIdentityKeyMigration';
import {
    accountSettingsScopeKeySuffix,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';

import { loadPendingSettings, parsePendingSettings } from './persistence';
import { getPersistenceStorage } from './persistenceStorage';
import { loadSettings } from './settingsPersistence';

function accountSettingsKey(scope: AccountSettingsScope): string {
    return `account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`;
}

function pendingAccountSettingsKey(scope: AccountSettingsScope): string {
    return `pending-account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`;
}

function legacyCachedAccountSettingsMigrationKey(
    scope: AccountSettingsScope,
    legacyScope: AccountSettingsScope,
): string {
    return `account-settings:legacy-cache-consumed:v1:${accountSettingsScopeKeySuffix(scope)}:${accountSettingsScopeKeySuffix(legacyScope)}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableValueKey(value: unknown): string {
    if (!isPlainRecord(value)) return JSON.stringify(value);
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
        sorted[key] = value[key];
    }
    return JSON.stringify(sorted);
}

function mergeArrayValuesForScopeMigration(legacy: readonly unknown[], current: readonly unknown[]): unknown[] {
    const next: unknown[] = [];
    const seen = new Set<string>();
    for (const value of [...legacy, ...current]) {
        const key = stableValueKey(value);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(value);
    }
    return next;
}

function mergeValuesForScopeMigration(legacy: unknown, current: unknown, depth = 0): unknown {
    if (typeof current === 'undefined') return legacy;
    if (typeof legacy === 'undefined') return current;
    if (Array.isArray(legacy) && Array.isArray(current)) {
        return mergeArrayValuesForScopeMigration(legacy, current);
    }
    if (isPlainRecord(legacy) && isPlainRecord(current)) {
        const next: Record<string, unknown> = { ...legacy };
        for (const [key, value] of Object.entries(current)) {
            next[key] = mergeValuesForScopeMigration(legacy[key], value, depth + 1);
        }
        return next;
    }
    if (depth > 0 && typeof legacy === 'boolean' && typeof current === 'boolean') {
        return legacy || current;
    }
    return current;
}

function mergeSettingsForScopeMigration(
    legacy: Partial<Settings>,
    current: Partial<Settings>,
): Partial<Settings> {
    const legacyRecord = stripMigratedSessionOrganizationSettings(legacy as Record<string, unknown>);
    const currentRecord = stripMigratedSessionOrganizationSettings(current as Record<string, unknown>);
    const next: Record<string, unknown> = { ...legacyRecord };
    for (const [key, value] of Object.entries(currentRecord)) {
        if (
            (key === 'serverSelectionActiveTargetKind' || key === 'serverSelectionActiveTargetId')
            && (value === null || typeof value === 'undefined' || value === '')
        ) {
            continue;
        }
        next[key] = mergeValuesForScopeMigration(legacyRecord[key], value);
    }
    return next as Partial<Settings>;
}

const LEGACY_ACCOUNT_SCOPE_SESSION_PRESENTATION_SETTING_KEYS = [
    'serverSelectionGroups',
    'serverSelectionActiveTargetKind',
    'serverSelectionActiveTargetId',
] as const satisfies readonly (keyof Settings)[];

function pickSettingsKeys(settings: Settings, keys: readonly (keyof Settings)[]): Partial<Settings> {
    const picked: Partial<Settings> = {};
    const pickedRecord = picked as Record<string, unknown>;
    for (const key of keys) {
        pickedRecord[key] = settings[key];
    }
    return picked;
}

function pickNonDefaultLegacySessionPresentationSettings(settings: Settings): Partial<Settings> {
    const picked: Partial<Settings> = {};
    const pickedRecord = picked as Record<string, unknown>;
    for (const key of LEGACY_ACCOUNT_SCOPE_SESSION_PRESENTATION_SETTING_KEYS) {
        const value = settings[key];
        if (areAccountSettingsJsonValuesEqual(value, settingsDefaults[key])) continue;
        pickedRecord[key] = value;
    }
    return picked;
}

function pickLegacySettingsToPreserveDuringAccountScopeActivation(settings: Settings): Partial<Settings> {
    return {
        mobileWorkspaceExperienceV1: settings.mobileWorkspaceExperienceV1,
    };
}

function uniqueServerIds(ids: readonly string[]): string[] {
    const next: string[] = [];
    const seen = new Set<string>();
    for (const idRaw of ids) {
        const id = String(idRaw ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        next.push(id);
    }
    return next;
}

function uniqueAccountSettingsScopes(scopes: readonly AccountSettingsScope[]): AccountSettingsScope[] {
    const next: AccountSettingsScope[] = [];
    const seen = new Set<string>();
    for (const scope of scopes) {
        const key = accountSettingsScopeKeySuffix(scope);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(scope);
    }
    return next;
}

function splitLocalOnlySettings(settings: Partial<Settings>): {
    localOnlySettings: Partial<Settings>;
    serverBackedSettings: Partial<Settings>;
} {
    const serverBackedSettings = stripMigratedSessionOrganizationSettings(
        stripLocalOnlyAccountSettings(settings) as Record<string, unknown>,
    ) as Partial<Settings>;
    const serverBackedRecord = serverBackedSettings as Record<string, unknown>;
    const localOnlySettings: Partial<Settings> = {};
    const localOnlyRecord = localOnlySettings as Record<string, unknown>;
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
        if (Object.prototype.hasOwnProperty.call(serverBackedRecord, key)) continue;
        localOnlyRecord[key] = value;
    }
    return { localOnlySettings, serverBackedSettings };
}

function saveAccountSettingsEnvelope(
    scope: AccountSettingsScope,
    settings: Settings,
    version: number | null,
): void {
    const sanitizedSettings = stripMigratedSessionOrganizationSettings(settings as Record<string, unknown>) as Settings;
    getPersistenceStorage().set(accountSettingsKey(scope), JSON.stringify({ settings: sanitizedSettings, version }));
}

export function loadAccountSettings(scope: AccountSettingsScope): { settings: unknown; version: number | null } {
    const raw = getPersistenceStorage().getString(accountSettingsKey(scope));
    if (!raw) return { settings: {}, version: null };
    try {
        const parsed = JSON.parse(raw) as { settings?: unknown; version?: unknown };
        const parsedSettings = isPlainRecord(parsed.settings)
            ? stripMigratedSessionOrganizationSettings(parsed.settings)
            : parsed.settings;
        return {
            settings: parsedSettings,
            version: typeof parsed.version === 'number' ? parsed.version : null,
        };
    } catch {
        return { settings: {}, version: null };
    }
}

export function saveAccountSettings(scope: AccountSettingsScope, settings: Settings, version: number): void {
    saveAccountSettingsEnvelope(scope, settings, version);
}

export function prepareAccountSettingsScopeForActivation(
    scope: AccountSettingsScope,
    legacyScopes: readonly AccountSettingsScope[] = [],
): void {
    const storage = getPersistenceStorage();
    const scopedSettingsExists = typeof storage.getString(accountSettingsKey(scope)) === 'string';
    const legacySettingsExists = typeof storage.getString('settings') === 'string';
    const scopedPendingSettingsExists = typeof storage.getString(pendingAccountSettingsKey(scope)) === 'string';
    const legacyPendingSettingsExists = typeof storage.getString('pending-settings') === 'string';

    if (!scopedSettingsExists && legacySettingsExists) {
        const legacySettings = settingsParse(loadSettings().settings);
        const migratedSettings = applySettings(
            settingsDefaults,
            {
                ...pickLocalOnlyAccountSettings(legacySettings),
                ...pickLegacySettingsToPreserveDuringAccountScopeActivation(legacySettings),
            },
        );
        saveAccountSettingsEnvelope(scope, migratedSettings, null);
    }

    if (legacySettingsExists) {
        storage.delete('settings');
    }

    if (!scopedPendingSettingsExists && legacyPendingSettingsExists) {
        const legacyPendingSettings = loadPendingSettings();
        if (Object.keys(legacyPendingSettings).length > 0) {
            savePendingAccountSettings(scope, legacyPendingSettings);
        }
    }

    if (legacyPendingSettingsExists) {
        storage.delete('pending-settings');
    }

    const legacyScopesForActivation = uniqueAccountSettingsScopes(legacyScopes);
    const legacyServerIdsForKeyMigration = uniqueServerIds(
        legacyScopesForActivation
            .map((legacyScope) => legacyScope.serverId)
            .filter((serverId) => serverId !== scope.serverId),
    );

    function migrateNestedServerIds<T extends Record<string, unknown>>(settings: T) {
        return migrateAccountSettingsServerIdentityKeys({
            settings,
            currentServerId: scope.serverId,
            legacyServerIds: legacyServerIdsForKeyMigration,
            rewriteUnknownServerIds: isServerIssuedIdentityId(scope.serverId),
        });
    }

    for (const legacyScope of legacyScopesForActivation) {
        if (legacyScope.serverId === scope.serverId && legacyScope.accountId === scope.accountId) continue;

        const legacyPendingMigration = migrateNestedServerIds(loadPendingAccountSettings(legacyScope) as Record<string, unknown>);
        const {
            localOnlySettings: legacyPendingLocalOnlySettings,
            serverBackedSettings: legacyPending,
        } = splitLocalOnlySettings(legacyPendingMigration.settings as Partial<Settings>);
        if (Object.keys(legacyPending).length > 0) {
            const currentPending = loadPendingAccountSettings(scope);
            savePendingAccountSettings(scope, mergeSettingsForScopeMigration(legacyPending, currentPending));
            savePendingAccountSettings(legacyScope, {});
        }
        if (Object.keys(legacyPendingLocalOnlySettings).length > 0) {
            const current = loadAccountSettings(scope);
            const currentSettings = settingsParse(current.settings);
            const currentEnvelopeExists = typeof storage.getString(accountSettingsKey(scope)) === 'string';
            const currentLocalOnlySettings = currentEnvelopeExists
                ? pickLocalOnlyAccountSettings(currentSettings)
                : {};
            const mergedLocalOnlySettings = mergeSettingsForScopeMigration(
                legacyPendingLocalOnlySettings,
                currentLocalOnlySettings,
            );
            saveAccountSettingsEnvelope(scope, applySettings(currentSettings, mergedLocalOnlySettings), current.version);
            savePendingAccountSettings(legacyScope, {});
        }

        const legacyEnvelopeRaw = storage.getString(accountSettingsKey(legacyScope));
        const legacyCachedMigrationKey = legacyCachedAccountSettingsMigrationKey(scope, legacyScope);
        if (typeof legacyEnvelopeRaw !== 'string') continue;
        const legacyCachedSettingsAlreadyConsumed = storage.getString(legacyCachedMigrationKey) === '1';
        if (legacyCachedSettingsAlreadyConsumed) continue;

        const legacySettings = settingsParse(loadAccountSettings(legacyScope).settings);
        const localOnlyMigration = migrateNestedServerIds(
            pickLocalOnlyAccountSettings(legacySettings) as Record<string, unknown>,
        );
        const localOnlySettings = localOnlyMigration.settings as Partial<Settings>;
        const legacySessionPresentationMigration = migrateNestedServerIds(
            pickNonDefaultLegacySessionPresentationSettings(legacySettings) as Record<string, unknown>,
        );
        const {
            serverBackedSettings: legacySessionPresentationSettings,
        } = splitLocalOnlySettings(legacySessionPresentationMigration.settings as Partial<Settings>);
        if (Object.keys(localOnlySettings).length === 0 && Object.keys(legacySessionPresentationSettings).length === 0) {
            storage.set(legacyCachedMigrationKey, '1');
            continue;
        }

        const current = loadAccountSettings(scope);
        const currentSettings = settingsParse(current.settings);
        const currentEnvelopeExists = typeof storage.getString(accountSettingsKey(scope)) === 'string';
        const currentLocalOnlySettings = currentEnvelopeExists
            ? pickLocalOnlyAccountSettings(currentSettings)
            : {};
        const mergedLocalOnlySettings = mergeSettingsForScopeMigration(localOnlySettings, currentLocalOnlySettings);
        const currentSessionPresentationSettings = pickSettingsKeys(
            currentSettings,
            Object.keys(legacySessionPresentationSettings) as (keyof Settings)[],
        );
        const mergedSessionPresentationSettings = mergeSettingsForScopeMigration(
            legacySessionPresentationSettings,
            currentSessionPresentationSettings,
        );
        const currentPending = loadPendingAccountSettings(scope);
        const mergedPendingSettings = mergeSettingsForScopeMigration(
            mergedSessionPresentationSettings,
            currentPending,
        );
        if (Object.keys(mergedSessionPresentationSettings).length > 0) {
            savePendingAccountSettings(scope, mergedPendingSettings);
        }

        const mergedSettings = applySettings(currentSettings, {
            ...mergedLocalOnlySettings,
            ...mergedPendingSettings,
        });
        saveAccountSettingsEnvelope(scope, mergedSettings, current.version);
        storage.set(legacyCachedMigrationKey, '1');
    }

    if (legacyServerIdsForKeyMigration.length > 0 || isServerIssuedIdentityId(scope.serverId)) {
        const currentPendingMigration = migrateNestedServerIds(loadPendingAccountSettings(scope) as Record<string, unknown>);
        if (currentPendingMigration.changed) {
            savePendingAccountSettings(scope, currentPendingMigration.settings as Partial<Settings>);
        }

        const currentEnvelopeExists = typeof storage.getString(accountSettingsKey(scope)) === 'string';
        if (currentEnvelopeExists) {
            const current = loadAccountSettings(scope);
            const currentSettings = settingsParse(current.settings);
            const currentSettingsMigration = migrateNestedServerIds(currentSettings as Record<string, unknown>);
            if (currentSettingsMigration.changed) {
                const migratedSettings = currentSettingsMigration.settings as Settings;
                saveAccountSettingsEnvelope(scope, migratedSettings, current.version);
                const changedSettings = pickChangedServerIdentitySessionPresentationSettings(
                    currentSettingsMigration.settings,
                    currentSettingsMigration.changedKeys,
                );
                const serverBackedChangedSettings = stripMigratedSessionOrganizationSettings(
                    stripLocalOnlyAccountSettings(changedSettings) as Record<string, unknown>,
                );
                const currentPending = loadPendingAccountSettings(scope);
                const changedSettingsNotAlreadyPending: Record<string, unknown> = {};
                const currentPendingRecord = currentPending as Record<string, unknown>;
                for (const [key, value] of Object.entries(serverBackedChangedSettings as Record<string, unknown>)) {
                    if (Object.prototype.hasOwnProperty.call(currentPendingRecord, key)) continue;
                    changedSettingsNotAlreadyPending[key] = value;
                }
                if (Object.keys(changedSettingsNotAlreadyPending).length > 0) {
                    savePendingAccountSettings(
                        scope,
                        mergeSettingsForScopeMigration(changedSettingsNotAlreadyPending as Partial<Settings>, currentPending),
                    );
                }
            }
        }
    }
}

export function loadPendingAccountSettings(scope: AccountSettingsScope): Partial<Settings> {
    const raw = getPersistenceStorage().getString(pendingAccountSettingsKey(scope));
    if (!raw) return {};
    try {
        return stripMigratedSessionOrganizationSettings(parsePendingSettings(JSON.parse(raw)) as Record<string, unknown>) as Partial<Settings>;
    } catch {
        return {};
    }
}

export function savePendingAccountSettings(scope: AccountSettingsScope, settings: Partial<Settings>): void {
    const key = pendingAccountSettingsKey(scope);
    const sanitizedSettings = stripMigratedSessionOrganizationSettings(settings as Record<string, unknown>) as Partial<Settings>;
    if (Object.keys(sanitizedSettings).length === 0) {
        getPersistenceStorage().delete(key);
        return;
    }
    getPersistenceStorage().set(key, JSON.stringify(sanitizedSettings));
}

import { applySettings, settingsDefaults, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { pickLocalOnlyAccountSettings } from '@/sync/domains/settings/localOnlyAccountSettings';
import {
    accountSettingsScopeKeySuffix,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';

import { parsePendingSettings } from './persistence';
import { getPersistenceStorage } from './persistenceStorage';
import { loadSettings } from './settingsPersistence';

function accountSettingsKey(scope: AccountSettingsScope): string {
    return `account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`;
}

function pendingAccountSettingsKey(scope: AccountSettingsScope): string {
    return `pending-account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`;
}

function saveAccountSettingsEnvelope(
    scope: AccountSettingsScope,
    settings: Settings,
    version: number | null,
): void {
    getPersistenceStorage().set(accountSettingsKey(scope), JSON.stringify({ settings, version }));
}

export function loadAccountSettings(scope: AccountSettingsScope): { settings: unknown; version: number | null } {
    const raw = getPersistenceStorage().getString(accountSettingsKey(scope));
    if (!raw) return { settings: {}, version: null };
    try {
        const parsed = JSON.parse(raw) as { settings?: unknown; version?: unknown };
        return {
            settings: parsed.settings,
            version: typeof parsed.version === 'number' ? parsed.version : null,
        };
    } catch {
        return { settings: {}, version: null };
    }
}

export function saveAccountSettings(scope: AccountSettingsScope, settings: Settings, version: number): void {
    saveAccountSettingsEnvelope(scope, settings, version);
}

export function prepareAccountSettingsScopeForActivation(scope: AccountSettingsScope): void {
    const storage = getPersistenceStorage();
    const scopedSettingsExists = typeof storage.getString(accountSettingsKey(scope)) === 'string';
    const legacySettingsExists = typeof storage.getString('settings') === 'string';

    if (!scopedSettingsExists && legacySettingsExists) {
        const legacySettings = settingsParse(loadSettings().settings);
        const migratedSettings = applySettings(
            settingsDefaults,
            pickLocalOnlyAccountSettings(legacySettings),
        );
        saveAccountSettingsEnvelope(scope, migratedSettings, null);
    }

    if (legacySettingsExists) {
        storage.delete('settings');
    }
    storage.delete('pending-settings');
}

export function loadPendingAccountSettings(scope: AccountSettingsScope): Partial<Settings> {
    const raw = getPersistenceStorage().getString(pendingAccountSettingsKey(scope));
    if (!raw) return {};
    try {
        return parsePendingSettings(JSON.parse(raw));
    } catch {
        return {};
    }
}

export function savePendingAccountSettings(scope: AccountSettingsScope, settings: Partial<Settings>): void {
    const key = pendingAccountSettingsKey(scope);
    if (Object.keys(settings).length === 0) {
        getPersistenceStorage().delete(key);
        return;
    }
    getPersistenceStorage().set(key, JSON.stringify(settings));
}

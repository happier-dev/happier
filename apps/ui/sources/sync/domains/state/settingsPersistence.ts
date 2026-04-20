import { localSettingsDefaults, localSettingsParse, type LocalSettings } from '../settings/localSettings';
import { purchasesDefaults, purchasesParse, type Purchases } from '../purchases/purchases';
import type { Settings } from '../settings/settings';
import { getPersistenceStorage } from './persistenceStorage';

function settingsKey(): string {
    return 'settings';
}

function localSettingsKey(): string {
    return 'local-settings';
}

function purchasesKey(): string {
    return 'purchases';
}

export function loadSettings(): { settings: unknown; version: number | null } {
    const mmkv = getPersistenceStorage();
    const settings = mmkv.getString(settingsKey());
    if (settings) {
        try {
            const parsed = JSON.parse(settings);
            const version = typeof parsed.version === 'number' ? parsed.version : null;
            return { settings: parsed.settings, version };
        } catch (e) {
            console.error('Failed to parse settings', e);
            return { settings: {}, version: null };
        }
    }
    return { settings: {}, version: null };
}

export function saveSettings(settings: Settings, version: number) {
    const mmkv = getPersistenceStorage();
    mmkv.set(settingsKey(), JSON.stringify({ settings, version }));
}

export function loadLocalSettings(): LocalSettings {
    const mmkv = getPersistenceStorage();
    const localSettings = mmkv.getString(localSettingsKey());
    if (localSettings) {
        try {
            const parsed = JSON.parse(localSettings);
            return localSettingsParse(parsed);
        } catch (e) {
            console.error('Failed to parse local settings', e);
            return { ...localSettingsDefaults };
        }
    }
    return { ...localSettingsDefaults };
}

export function saveLocalSettings(settings: LocalSettings) {
    const mmkv = getPersistenceStorage();
    mmkv.set(localSettingsKey(), JSON.stringify(settings));
}

export function loadPurchases(): Purchases {
    const mmkv = getPersistenceStorage();
    const purchases = mmkv.getString(purchasesKey());
    if (purchases) {
        try {
            const parsed = JSON.parse(purchases);
            return purchasesParse(parsed);
        } catch (e) {
            console.error('Failed to parse purchases', e);
            return { ...purchasesDefaults };
        }
    }
    return { ...purchasesDefaults };
}

export function savePurchases(purchases: Purchases) {
    const mmkv = getPersistenceStorage();
    mmkv.set(purchasesKey(), JSON.stringify(purchases));
}

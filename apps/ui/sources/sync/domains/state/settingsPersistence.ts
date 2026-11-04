import { localSettingsDefaults, localSettingsParse, type LocalSettings } from '../settings/localSettings';
import { purchasesDefaults, purchasesParse, type Purchases } from '../purchases/purchases';
import type { Settings } from '../settings/settings';
import { loadHomeViewState } from '../server/serverProfiles';
import { stripServerSelectionSettingsProjection } from '../server/selection/serverSelectionSettingsAdapter';
import { getPersistenceStorage, subscribePersistenceStorageCleared } from './persistenceStorage';
import { seedProjectPhoneNavigationPlacements } from '../settings/mobileSurfacePinning';
import { migrateDisclosureUiStateFromSettings, migrateRetainedSessionListCollapseKeys } from './disclosureUiState';
import { UiStatePersistenceError } from './persistentUiState';
import { migrateSessionMruFromSettings } from '../session/navigation/recentSessions';
import { migrateCollectionSpaceUiStateFromSettings } from '../session/listing/sessionListSpaces';

type LocalAttentionSettingsMutationListener = () => void;
const localAttentionSettingsMutationListeners = new Set<LocalAttentionSettingsMutationListener>();
let localAttentionSettingsMutationToken = 0;
let legacyDisclosureImportComplete = false;
subscribePersistenceStorageCleared(() => {
    legacyDisclosureImportComplete = false;
});

export function subscribeLocalAttentionSettingsMutations(listener: LocalAttentionSettingsMutationListener): () => void {
    localAttentionSettingsMutationListeners.add(listener);
    return () => localAttentionSettingsMutationListeners.delete(listener);
}

/**
 * In-process generation of this device's attention/preview/quiet-hours policy.
 *
 * A reconciliation that captured the policy also captures this value, so a
 * later step can tell synchronously that the policy moved under it instead of
 * re-reading a Home over the network. It is deliberately not persisted and
 * carries no meaning across restarts: a restart re-reads the current policy
 * anyway, so no second persisted generation exists to drift.
 */
export function readLocalAttentionSettingsMutationToken(): number {
    return localAttentionSettingsMutationToken;
}

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
    const persistedSettings = loadHomeViewState()
        ? stripServerSelectionSettingsProjection(settings)
        : settings;
    mmkv.set(settingsKey(), JSON.stringify({ settings: persistedSettings, version }));
}

/** Retain the stored value only for owner-level startup healing of theme profiles. */
function migrateDeviceUiStateFromSettings(input: unknown): unknown {
    let storedValue = input;
    let retainedFailedSource = false;
    for (const migrate of [migrateDisclosureUiStateFromSettings, migrateSessionMruFromSettings,
        migrateCollectionSpaceUiStateFromSettings]) {
        try { storedValue = migrate(storedValue); }
        catch {
            // Independent device domains must still import when one retained
            // seed or destination cannot be admitted. That domain keeps its source.
            retainedFailedSource = true;
        }
    }
    if (retainedFailedSource) console.warn('[ui-state] Retained device state could not be migrated; keeping its source.');
    return storedValue;
}

function readMigratedLocalSettingsStoredValue(requireReadableSource = false): unknown {
    const localSettings = getPersistenceStorage().getString(localSettingsKey());
    let storedValue: unknown = localSettings ? undefined : {};
    if (localSettings) {
        try { storedValue = JSON.parse(localSettings); }
        catch (error) {
            if (requireReadableSource) throw error;
            console.error('Failed to parse local settings', error);
        }
    }
    try {
        migrateRetainedSessionListCollapseKeys();
        const migrated = seedProjectPhoneNavigationPlacements(migrateDeviceUiStateFromSettings(storedValue));
        if (migrated !== storedValue) {
            getPersistenceStorage().set(localSettingsKey(), JSON.stringify(migrated));
            storedValue = migrated;
        }
    } catch {
        // Preserve every source scope until all copies and source cleanup succeed.
        console.warn('[ui-state] Retained navigation state could not be migrated; keeping its source.');
    }
    return storedValue;
}

export function loadLocalSettingsSnapshot(): Readonly<{ settings: LocalSettings; storedValue: unknown }> {
    try {
        const storedValue = readMigratedLocalSettingsStoredValue();
        if (storedValue !== undefined) return { settings: localSettingsParse(storedValue), storedValue };
    } catch (e) {
        console.error('Failed to parse local settings', e);
    }
    return { settings: { ...localSettingsDefaults }, storedValue: undefined };
}

export function completeLegacyDisclosureImportBeforeRemoval(): void {
    if (legacyDisclosureImportComplete) return;
    let storedValue: unknown;
    try {
        migrateRetainedSessionListCollapseKeys();
        storedValue = readMigratedLocalSettingsStoredValue(true);
    }
    catch (error) { throw new UiStatePersistenceError(error); }
    if (storedValue && typeof storedValue === 'object'
        && (Object.hasOwn(storedValue, 'collapsedGroupKeysV1') || Object.hasOwn(storedValue, 'sessionInfoExpandedSectionsV1'))) {
        throw new UiStatePersistenceError(new Error('Retained disclosure state could not be imported before clearing it'));
    }
    legacyDisclosureImportComplete = true;
}

export function loadLocalSettings(): LocalSettings {
    return loadLocalSettingsSnapshot().settings;
}

/** Only the storage adapter rejected a fully serialized local-settings write. */
export class LocalSettingsPersistenceError extends Error {
    readonly cause: unknown;

    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : 'Failed to write local settings');
        this.name = 'LocalSettingsPersistenceError';
        this.cause = cause;
    }
}

export function saveLocalSettings(settings: LocalSettings) {
    // A refused source read is unknown, not empty: never overwrite retained UI seeds.
    const storedValue = readMigratedLocalSettingsStoredValue();
    const previous = localSettingsParse(storedValue);
    persistLocalSettings(settings, storedValue, previous);
}

function persistLocalSettings(settings: LocalSettings, storedValue: unknown, previous: LocalSettings): void {
    const mmkv = getPersistenceStorage();
    let retained: unknown = settings;
    for (const legacyKey of ['sessionMruOrderV1', 'collectionSpaceV1', 'collapsedGroupKeysV1', 'sessionInfoExpandedSectionsV1']) {
        if (storedValue && typeof storedValue === 'object' && Object.hasOwn(storedValue, legacyKey)) {
            retained = { ...(retained as LocalSettings), [legacyKey]: Reflect.get(storedValue, legacyKey) };
        }
    }
    try { retained = migrateDeviceUiStateFromSettings(retained); } catch {
        // A preference save retains un-copied navigation state on storage refusal.
    }
    const serialized = JSON.stringify(retained);
    try {
        mmkv.set(localSettingsKey(), serialized);
    } catch (error) {
        throw new LocalSettingsPersistenceError(error);
    }
    publishLocalAttentionSettingsChange(previous, settings);
}

function publishLocalAttentionSettingsChange(previous: LocalSettings, settings: LocalSettings): void {
    if (
        previous.deviceRemoteAlertsEnabled !== settings.deviceRemoteAlertsEnabled
        || JSON.stringify(previous.attentionDeviceOverridesV1) !== JSON.stringify(settings.attentionDeviceOverridesV1)
    ) {
        localAttentionSettingsMutationToken += 1;
        for (const listener of [...localAttentionSettingsMutationListeners]) {
            try { listener(); } catch { /* local settings persistence remains authoritative */ }
        }
    }
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

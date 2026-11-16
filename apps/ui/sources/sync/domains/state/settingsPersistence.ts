import { migrateThemeProfileLegacyScopeFromSettings } from '@/sync/domains/state/themeProfileMigrationUiState';
import { applyLocalSettings, localSettingsDefaults, localSettingsParse, type LocalSettings } from '../settings/localSettings';
import { areAccountSettingsJsonValuesEqual } from '../settings/accountSettingsStructuralEquality';
import { purchasesDefaults, purchasesParse, type Purchases } from '../purchases/purchases';
import type { Settings } from '../settings/settings';
import { loadHomeViewState } from '../server/serverProfiles';
import { stripServerSelectionSettingsProjection } from '../server/selection/serverSelectionSettingsAdapter';
import { getPersistenceStorage, getPersistenceStorageWebKey, subscribePersistenceStorageCleared } from './persistenceStorage';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { migrateDisclosureUiStateFromSettings } from './disclosureUiState';
import { UiStatePersistenceError } from './persistentUiState';
import { migrateMainAppTabFromSettings, migrateSessionMobileSurfacesFromSettings } from './navigationUiState';
import { migrateNewSessionUiState } from './newSessionTargetUiState';
import { migrateProgressHealthUiState } from './onboardingUiState';
import { migratePetCompanionPositionFromSettings } from '../pets/companionPosition/companionPosition';
import { migrateSessionMruFromSettings } from '../session/navigation/recentSessions';
import { migrateComposerBannerUiStateFromSettings } from './composerBannerUiState';

type LocalAttentionSettingsMutationListener = () => void;
const localAttentionSettingsMutationListeners = new Set<LocalAttentionSettingsMutationListener>();
const localSettingsChangeListeners = new Set<(delta: Partial<LocalSettings>) => void>();
let stopLocalSettingsWebObserver: (() => void) | null = null;
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

/** Other webviews publish one sparse, normalized preference delta without echoing a write. */
export function subscribeLocalSettingsChanges(listener: (delta: Partial<LocalSettings>) => void): () => void {
    if (isEmbedWindowContext() || typeof window === 'undefined' || typeof document === 'undefined') return () => {};
    localSettingsChangeListeners.add(listener);
    if (!stopLocalSettingsWebObserver) {
        const eventTarget = window;
        const onStorage = (event: StorageEvent) => {
            if (event.key !== getPersistenceStorageWebKey(localSettingsKey()) || event.storageArea !== eventTarget.localStorage) return;
            const parse = (value: string | null): LocalSettings => {
                try { return localSettingsParse(value === null ? undefined : JSON.parse(value)); }
                catch (error) {
                    console.error('Failed to parse external local settings', error);
                    return { ...localSettingsDefaults };
                }
            };
            const previous = parse(event.oldValue);
            const next = parse(event.newValue);
            const delta: Partial<LocalSettings> = {};
            for (const key of Object.keys(next) as Array<keyof LocalSettings>) {
                if (!areAccountSettingsJsonValuesEqual(previous[key], next[key])) {
                    Object.assign(delta, { [key]: next[key] });
                }
            }
            if (Object.keys(delta).length === 0) return;
            publishLocalAttentionSettingsChange(previous, next);
            for (const onChange of localSettingsChangeListeners) onChange(delta);
        };
        eventTarget.addEventListener('storage', onStorage);
        stopLocalSettingsWebObserver = () => eventTarget.removeEventListener('storage', onStorage);
    }
    return () => {
        localSettingsChangeListeners.delete(listener);
        if (localSettingsChangeListeners.size === 0) {
            stopLocalSettingsWebObserver?.();
            stopLocalSettingsWebObserver = null;
        }
    };
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
    // Retained bootstrap memory must be durably admitted before a parsed
    // preference snapshot can replace its legacy Settings envelope.
    const previous = loadSettings();
    migrateNewSessionUiState(null, previous.settings);
    const sanitized = migrateNewSessionUiState(null, settings) as Settings;
    const persistedSettings = loadHomeViewState()
        ? stripServerSelectionSettingsProjection(sanitized)
        : sanitized;
    mmkv.set(settingsKey(), JSON.stringify({ settings: persistedSettings, version }));
}

function migrateDeviceUiStateFromSettings(input: unknown): unknown {
    let storedValue = input;
    let retainedFailedSource = false;
    for (const migrate of [migrateMainAppTabFromSettings, migrateSessionMobileSurfacesFromSettings, migrateDisclosureUiStateFromSettings,
        migrateProgressHealthUiState, migrateSessionMruFromSettings, migrateComposerBannerUiStateFromSettings,
        migratePetCompanionPositionFromSettings]) {
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

/** Strict source access distinguishes absent state from an unavailable legacy import. */
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
    const originalStoredValue = storedValue;
    // The predecessor binding must be admitted before its library becomes readable.
    storedValue = migrateThemeProfileLegacyScopeFromSettings(storedValue);
    try {
        const migrated = migrateDeviceUiStateFromSettings(storedValue);
        if (migrated !== originalStoredValue) {
            getPersistenceStorage().set(localSettingsKey(), JSON.stringify(migrated));
            storedValue = migrated;
        }
    } catch {
        // Preserve every source scope until all copies and source cleanup succeed.
        console.warn('[ui-state] Retained navigation state could not be migrated; keeping its source.');
    }
    return storedValue;
}

/** Retain released raw theme input until its Artifact transfer is acknowledged. */
export function loadLocalSettingsSnapshot(): Readonly<{ settings: LocalSettings; storedValue: unknown }> {
    try {
        const storedValue = readMigratedLocalSettingsStoredValue();
        if (storedValue !== undefined) return { settings: localSettingsParse(storedValue), storedValue };
    } catch (e) {
        console.error('Failed to parse local settings', e);
    }
    return { settings: { ...localSettingsDefaults }, storedValue: undefined };
}

export function loadLocalSettings(): LocalSettings {
    return loadLocalSettingsSnapshot().settings;
}

/** A clear cannot retire a copied choice while its source can still replay it. */
export function completeLegacyDisclosureImportBeforeRemoval(): void {
    if (legacyDisclosureImportComplete) return;
    let storedValue: unknown;
    try {
        storedValue = readMigratedLocalSettingsStoredValue(true);
    }
    catch (error) { throw new UiStatePersistenceError(error); }
    if (storedValue && typeof storedValue === 'object'
        && (Object.hasOwn(storedValue, 'collapsedGroupKeysV1'))) {
        throw new UiStatePersistenceError(new Error('Retained disclosure state could not be imported before clearing it'));
    }
    legacyDisclosureImportComplete = true;
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

/** Deliberate preference edits merge with storage, which can be newer than this renderer's snapshot. */
export function saveLocalSettingsDelta(delta: Partial<LocalSettings>): Readonly<{
    previousSettings: LocalSettings;
    nextSettings: LocalSettings;
}> {
    const storedValue = readMigratedLocalSettingsStoredValue();
    const previousSettings = localSettingsParse(storedValue);
    const nextSettings = applyLocalSettings(previousSettings, delta);
    if (areAccountSettingsJsonValuesEqual(previousSettings, nextSettings)) {
        return { previousSettings, nextSettings: previousSettings };
    }
    persistLocalSettings(nextSettings, storedValue, previousSettings);
    return { previousSettings, nextSettings };
}

function persistLocalSettings(settings: LocalSettings, storedValue: unknown, previous: LocalSettings): void {
    const mmkv = getPersistenceStorage();
    let retained: unknown = settings;
    if (storedValue && typeof storedValue === 'object' && Object.hasOwn(storedValue, 'themeProfiles')
        && areAccountSettingsJsonValuesEqual(settings.themeProfiles, previous.themeProfiles)) {
        retained = { ...settings, themeProfiles: Reflect.get(storedValue, 'themeProfiles') };
    }
    for (const legacyKey of ['mainAppTab', 'sessionMruOrderV1', 'sessionComposerCollapsedBannerKinds',
        'sessionLastMobileSurfaceBySessionId', 'collapsedGroupKeysV1', 'brandHeroSeenAt', 'hasCompletedAuthOnce',
        'acknowledgedCliVersions', 'petsDismissedCompanionTrayItemKeys', 'petsCompanionPosition']) {
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

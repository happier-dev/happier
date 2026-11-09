import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import {
    loadLocalSettings,
    readLocalAttentionSettingsMutationToken,
    subscribeLocalAttentionSettingsMutations,
    subscribeLocalSettingsChanges,
} from '@/sync/domains/state/settingsPersistence';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { clearPersistence } from '@/sync/domains/state/persistence';

const store = vi.hoisted(() => new Map<string, string>());
const boundary = vi.hoisted(() => ({
    writes: [] as string[], capture: vi.fn(), flush: vi.fn(async () => {}),
    onRead: null as ((key: string) => void) | null,
}));

vi.mock('@/track', () => ({
    tracking: { capture: boundary.capture, flush: boundary.flush },
    getTrackingAnonymousUserId: () => 'local-settings-test',
}));

// MMKV is the persistence boundary; everything above it (store, apply, persistence module) is real.
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            boundary.onRead?.(key);
            return store.get(key);
        }

        set(key: string, value: string) {
            boundary.writes.push(key);
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        getAllKeys() {
            return [...store.keys()];
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
        translateLoose: (key: string) => key,
        getPreferredLanguage: () => 'en',
    });
});

import { createSettingsDomain } from './settings';

type SettingsDomainApi = ReturnType<typeof createSettingsDomain>;

// The same neighbouring-slice shape the other settings-domain tests use, so projection helpers
// that read sibling slices see realistic empty state.
type TestState = SettingsDomainApi & Readonly<{
    sessions: {};
    machines: {};
    machineDisplayById: {};
    sessionListRowsByServerId: {};
    ordinarySessionListMembershipByServerId: {};
    archivedSessionListMembershipByServerId: {};
    sessionListIndexByServerId: {};
    concurrentSessionListCacheByServerId: {};
    machineListByServerId: {};
    getProjectForSession: undefined;
}>;

function createTestStore(): { getState: () => TestState } {
    let state = {
        sessions: {},
        machines: {},
        machineDisplayById: {},
        sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {},
        archivedSessionListMembershipByServerId: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        machineListByServerId: {},
        getProjectForSession: undefined,
    } as TestState;

    const set = (updater: ((current: TestState) => Partial<TestState> | TestState) | Partial<TestState>) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };
    const domain = createSettingsDomain<TestState>({ set, get: () => state });
    state = { ...state, ...(domain as SettingsDomainApi) };

    return { getState: () => state };
}

describe('local settings applied without persisting', () => {
    beforeEach(() => {
        clearPersistence();
        store.clear();
        boundary.writes.length = 0;
        boundary.capture.mockClear();
        boundary.onRead = null;
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('updates the runtime text scale while the persisted value stays unchanged', () => {
        const { getState } = createTestStore();

        getState().applyLocalSettings({ uiFontScale: 1.1 }, { persist: false });

        expect(getState().localSettings.uiFontScale).toBe(1.1);
        expect(loadLocalSettings().uiFontScale).toBe(localSettingsDefaults.uiFontScale);
    });

    it('still persists ordinary local setting changes', () => {
        const { getState } = createTestStore();

        getState().applyLocalSettings({ uiFontScale: 1.2 });

        expect(loadLocalSettings().uiFontScale).toBe(1.2);
    });

    it('applies a deliberate delta to current stored preferences instead of another realm’s stale snapshot', () => {
        const firstRealm = createTestStore();
        const staleRealm = createTestStore();

        firstRealm.getState().applyLocalSettings({
            themePreference: 'dark',
            uiSurfaceFinishOverrides: { composer: 'flat' },
            desktopWindowBotRailEnabled: false,
        });
        staleRealm.getState().applyLocalSettings({ uiFontScale: 1.2, desktopBotConversationPresentation: 'window' });

        expect(loadLocalSettings()).toMatchObject({
            themePreference: 'dark',
            uiSurfaceFinishOverrides: { composer: 'flat' },
            uiFontScale: 1.2,
            desktopWindowBotRailEnabled: false,
            desktopBotConversationPresentation: 'window',
        });
        expect(staleRealm.getState().localSettings).toEqual(loadLocalSettings());
    });

    it('persists a deliberate choice even when it matches the stale realm’s value', () => {
        const firstRealm = createTestStore();
        const staleRealm = createTestStore();
        firstRealm.getState().applyLocalSettings({ themePreference: 'dark' });

        staleRealm.getState().applyLocalSettings({ themePreference: localSettingsDefaults.themePreference });

        expect(loadLocalSettings().themePreference).toBe(localSettingsDefaults.themePreference);
    });

    it('applies an external changed key without storage or analytics echoes and keeps unrelated references', () => {
        const realm = createTestStore();
        realm.getState().applyLocalSettings({ themePreference: 'light', uiSurfaceFinishOverrides: { composer: 'flat' } });
        expect(boundary.capture).toHaveBeenCalledWith('setting_changed', expect.objectContaining({ setting_key: 'themePreference' }));
        const composerPreferences = realm.getState().localSettings.uiSurfaceFinishOverrides;
        boundary.writes.length = 0;
        boundary.capture.mockClear();

        realm.getState().applyLocalSettings({ themePreference: 'dark' }, { persist: false });

        expect(realm.getState().localSettings.themePreference).toBe('dark');
        expect(realm.getState().localSettings.uiSurfaceFinishOverrides).toBe(composerPreferences);
        expect(boundary.writes).toEqual([]);
        expect(boundary.capture).not.toHaveBeenCalled();
        const previous = realm.getState().localSettings;
        realm.getState().applyLocalSettings({ themePreference: 'dark' }, { persist: false });
        expect(realm.getState().localSettings).toBe(previous);
    });

    it('subscribes before loading and follows sibling-window preference changes without echoes or unrelated reference churn', () => {
        const target = new EventTarget();
        const browserValues = new Map<string, string>();
        const localStorage: Storage = {
            get length() { return browserValues.size; },
            key: index => [...browserValues.keys()][index] ?? null,
            getItem: key => browserValues.get(key) ?? null,
            setItem: (key, value) => { browserValues.set(key, value); },
            removeItem: key => { browserValues.delete(key); },
            clear: () => { browserValues.clear(); },
        };
        let storageListeners = 0;
        vi.stubGlobal('window', {
            location: { origin: 'http://127.0.0.1:8081' },
            localStorage,
            addEventListener: (type: string, listener: EventListener) => {
                if (type === 'storage') storageListeners += 1;
                target.addEventListener(type, listener);
            },
            removeEventListener: (type: string, listener: EventListener) => {
                if (type === 'storage') storageListeners -= 1;
                target.removeEventListener(type, listener);
            },
        });
        vi.stubGlobal('document', {});
        const observedInitialLoads: boolean[] = [];
        boundary.onRead = key => {
            if (key === 'local-settings') observedInitialLoads.push(storageListeners > 0);
        };
        const realm = createTestStore();
        expect(observedInitialLoads.length).toBeGreaterThan(0);
        expect(observedInitialLoads.every(Boolean)).toBe(true);
        boundary.onRead = null;
        const changes: Partial<LocalSettings>[] = [];
        const unsubscribe = subscribeLocalSettingsChanges(delta => changes.push(delta));
        const attentionChanged = vi.fn();
        const unsubscribeAttention = subscribeLocalAttentionSettingsMutations(attentionChanged);
        const attentionToken = readLocalAttentionSettingsMutationToken();

        realm.getState().applyLocalSettings({
            themePreference: 'light', uiSurfaceFinishOverrides: { composer: 'flat' },
        });
        const composerPreferences = realm.getState().localSettings.uiSurfaceFinishOverrides;
        const attentionPreferences = realm.getState().localSettings.attentionDeviceOverridesV1;
        const oldValue = store.get('local-settings') ?? null;
        const externalSettings = {
            ...loadLocalSettings(), themePreference: 'dark', desktopWindowBotRailEnabled: false,
        };
        const newValue = JSON.stringify(externalSettings);
        store.set('local-settings', newValue); // A sibling webview wrote through the OS storage boundary.
        boundary.writes.length = 0;
        boundary.capture.mockClear();
        const emit = (key: string, storageArea: Storage, previousValue = oldValue, value = newValue) => {
            target.dispatchEvent(Object.assign(new Event('storage'), {
                key, storageArea, oldValue: previousValue, newValue: value,
            }));
        };
        emit('mmkv.default:local-settings', localStorage);
        emit('mmkv.default\\local-settings', { ...localStorage });
        expect(realm.getState().localSettings.themePreference).toBe('light');

        emit('mmkv.default\\local-settings', localStorage);

        expect(realm.getState().localSettings.themePreference).toBe('dark');
        expect(realm.getState().localSettings.desktopWindowBotRailEnabled).toBe(false);
        expect(realm.getState().localSettings.uiSurfaceFinishOverrides).toBe(composerPreferences);
        expect(realm.getState().localSettings.attentionDeviceOverridesV1).toBe(attentionPreferences);
        const beforeComposerChange = realm.getState().localSettings;
        const composerUpdate = JSON.stringify({
            ...externalSettings, uiSurfaceFinishOverrides: { composer: 'soft' }, desktopBotConversationPresentation: 'window',
        });
        store.set('local-settings', composerUpdate);
        emit('mmkv.default\\local-settings', localStorage, newValue, composerUpdate);
        expect(realm.getState().localSettings.uiSurfaceFinishOverrides.composer).toBe('soft');
        expect(realm.getState().localSettings.desktopBotConversationPresentation).toBe('window');
        expect(realm.getState().localSettings.attentionDeviceOverridesV1).toBe(attentionPreferences);
        expect(realm.getState().localSettings.themePreference).toBe(beforeComposerChange.themePreference);
        const previous = realm.getState().localSettings;
        emit('mmkv.default\\local-settings', localStorage, composerUpdate, composerUpdate);
        expect(realm.getState().localSettings).toBe(previous);
        expect(attentionChanged).not.toHaveBeenCalled();
        expect(readLocalAttentionSettingsMutationToken()).toBe(attentionToken);
        const deviceRemoteAlertsEnabled = !previous.deviceRemoteAlertsEnabled;
        const attentionUpdate = JSON.stringify({ ...previous, deviceRemoteAlertsEnabled });
        store.set('local-settings', attentionUpdate);
        emit('mmkv.default\\local-settings', localStorage, composerUpdate, attentionUpdate);
        expect(realm.getState().localSettings.deviceRemoteAlertsEnabled).toBe(deviceRemoteAlertsEnabled);
        expect(attentionChanged).toHaveBeenCalledTimes(1);
        expect(readLocalAttentionSettingsMutationToken()).toBe(attentionToken + 1);
        expect(boundary.writes).toEqual([]);
        expect(boundary.capture).not.toHaveBeenCalled();
        expect(changes).toEqual([
            { themePreference: 'dark', desktopWindowBotRailEnabled: false },
            { uiSurfaceFinishOverrides: { composer: 'soft' }, desktopBotConversationPresentation: 'window' },
            { deviceRemoteAlertsEnabled },
        ]);
        unsubscribe();
        unsubscribeAttention();
    });
});

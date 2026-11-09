import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPersistenceStorage, getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { loadLocalSettings, saveLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { resetSessionSurfaceVisibilityForTests, setFocusedSessionId } from './sessionSurfaceVisibility';
import { buildServerScopedSessionKey } from './navigation/sessionNavigationOrder';
import { resolveSessionSwitcherRecentPool } from './navigation/sessionSwitcherOrder';
import { readSessionMruOrder } from './navigation/recentSessions';

const destination = 'ui-state:session-navigation-mru-v1:order';

beforeEach(() => {
    clearPersistenceStorage();
    resetSessionSurfaceVisibilityForTests();
    storage.setState({ localSettings: { ...localSettingsDefaults } });
});
afterEach(() => vi.restoreAllMocks());

describe('device-owned Session recents', () => {
    it('retains an admitted legacy source when cached destination bytes fail migration admission', () => {
        const device = getPersistenceStorage();
        const opaqueDestination = JSON.stringify({ future: true });
        device.set(destination, opaqueDestination);
        expect(readSessionMruOrder()).toEqual([]);
        const source = JSON.stringify({ sessionMruOrderV1: ['retained-home:session'], themePreference: 'dark' });
        device.set('local-settings', source);
        const loaded = loadLocalSettings();
        expect(device.getString('local-settings')).toBe(source);
        saveLocalSettings({ ...loaded, themePreference: 'light' });
        expect(JSON.parse(device.getString('local-settings')!)).toMatchObject({ sessionMruOrderV1: ['retained-home:session'] });
        expect(device.getString(destination)).toBe(opaqueDestination);
    });

    it('persists real focus changes for navigation with zero settings writes', () => {
        const device = getPersistenceStorage();
        const local = JSON.stringify({ themePreference: 'dark' });
        const account = JSON.stringify({ settings: {}, version: 3 });
        device.set('local-settings', local);
        device.set('settings', account);
        const writes = vi.spyOn(device, 'set');
        for (let visit = 0; visit < 12; visit++) setFocusedSessionId(`session-${visit % 3}`, 'mru-home');
        expect(writes.mock.calls.filter(([key]) => key === 'local-settings' || key === 'settings')).toHaveLength(0);
        expect(device.getString('local-settings')).toBe(local);
        expect(device.getString('settings')).toBe(account);
        const order: unknown = JSON.parse(device.getString(destination) ?? 'null');
        expect(order).toEqual([2, 1, 0].map(id => buildServerScopedSessionKey(`session-${id}`, 'mru-home')));
        const keys = order as string[];
        expect(resolveSessionSwitcherRecentPool({ currentKey: keys[0], mruSessionKeys: keys, openTabs: [] })
            .map(entry => entry.sessionKey)).toEqual(keys);
        writes.mockClear();
        setFocusedSessionId('session-2', 'mru-home');
        expect(writes).not.toHaveBeenCalled();
    });

    it('copies the predecessor recents source, preserves a newer destination and retires the source', () => {
        const device = getPersistenceStorage();
        device.set('local-settings', JSON.stringify({ sessionMruOrderV1: ['legacy-home:old'], themePreference: 'dark' }));
        loadLocalSettings();
        expect(JSON.parse(device.getString(destination) ?? 'null')).toEqual(['legacy-home:old']);
        expect(JSON.parse(device.getString('local-settings')!)).toEqual({ themePreference: 'dark' });
        device.set('local-settings', JSON.stringify({ sessionMruOrderV1: ['older'] }));
        loadLocalSettings();
        expect(JSON.parse(device.getString(destination) ?? 'null')).toEqual(['legacy-home:old']);
        expect(JSON.parse(device.getString('local-settings')!)).not.toHaveProperty('sessionMruOrderV1');
    });

    it('keeps source bytes on failed copying and across an unrelated preference save', () => {
        const device = getPersistenceStorage();
        const source = JSON.stringify({ sessionMruOrderV1: ['retained'] });
        device.set('local-settings', source);
        const write = device.set.bind(device);
        const refusal = vi.spyOn(device, 'set').mockImplementation((key, value) => {
            if (key === destination) throw new Error('device full');
            write(key, value);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const settings = loadLocalSettings();
        expect(device.getString('local-settings')).toBe(source);
        saveLocalSettings({ ...settings, themePreference: 'dark' });
        expect(JSON.parse(device.getString('local-settings')!)).toMatchObject({ sessionMruOrderV1: ['retained'] });
        refusal.mockRestore();
        loadLocalSettings();
        expect(JSON.parse(device.getString(destination) ?? 'null')).toEqual(['retained']);
        expect(JSON.parse(device.getString('local-settings')!)).not.toHaveProperty('sessionMruOrderV1');
    });

    it('retains unadmitted legacy values instead of deleting their source', () => {
        const device = getPersistenceStorage();
        const source = JSON.stringify({ sessionMruOrderV1: { future: true }, themePreference: 'dark' });
        device.set('local-settings', source);
        loadLocalSettings();
        expect(device.getString('local-settings')).toBe(source);
        expect(device.getString(destination)).toBeUndefined();
        saveLocalSettings({ ...localSettingsDefaults, themePreference: 'light' });
        expect(JSON.parse(device.getString('local-settings')!)).toHaveProperty('sessionMruOrderV1', { future: true });
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPersistenceStorage, getPersistenceStorage } from './persistenceStorage';
import { loadLocalSettings, saveLocalSettings } from './settingsPersistence';

afterEach(() => { vi.restoreAllMocks(); clearPersistenceStorage(); });

const history = [
    ['brandHeroSeenAt', 'ui-state:onboarding-history-v1:brandHeroSeenAt', 1_700_000_000_001],
    ['hasCompletedAuthOnce', 'ui-state:onboarding-auth-history-v1:completed', true],
    ['acknowledgedCliVersions', 'ui-state:cli-version-acknowledgements-v1:machines', { 'machine-a': '0.2.17' }],
    ['petsDismissedCompanionTrayItemKeys', 'ui-state:pet-activity-dismissals-v1:tray', ['waiting:home-a:session-a:1000']],
] as const;

describe('device progress and presentation history import', () => {
    it('keeps an unadmitted released history key without blocking another released import', () => {
        const device = getPersistenceStorage();
        const opaque = { future: { opaque: true } };
        device.set('local-settings', JSON.stringify({ brandHeroSeenAt: opaque, hasCompletedAuthOnce: true }));
        loadLocalSettings();
        expect(device.getString('ui-state:onboarding-auth-history-v1:completed')).toBe('true');
        expect(device.getString('ui-state:onboarding-history-v1:brandHeroSeenAt')).toBeUndefined();
        expect(JSON.parse(device.getString('local-settings')!)).toEqual({ brandHeroSeenAt: opaque });
    });

    it.each(history)('imports %s once and retires only its old Settings carrier', (key, destination, value) => {
        const device = getPersistenceStorage();
        device.set('local-settings', JSON.stringify({ themePreference: 'dark', [key]: value }));
        expect(loadLocalSettings()).not.toHaveProperty(key);
        expect(JSON.parse(device.getString(destination)!)).toEqual(value);
        expect(JSON.parse(device.getString('local-settings')!)).toEqual({ themePreference: 'dark' });
        const writes = vi.spyOn(device, 'set');
        loadLocalSettings();
        expect(writes).not.toHaveBeenCalled();
    });

    it.each(history)('preserves %s on failed copy through an unrelated preference write', (key, destination, value) => {
        const device = getPersistenceStorage();
        device.set('local-settings', JSON.stringify({ themePreference: 'dark', [key]: value }));
        const write = device.set.bind(device);
        const refusal = vi.spyOn(device, 'set').mockImplementation((storageKey, bytes) => {
            if (storageKey === destination) throw new Error('device full');
            write(storageKey, bytes);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        saveLocalSettings({ ...loadLocalSettings(), themePreference: 'light' });
        expect(JSON.parse(device.getString('local-settings')!)).toMatchObject({ themePreference: 'light', [key]: value });
        refusal.mockRestore();
        loadLocalSettings();
        expect(JSON.parse(device.getString(destination)!)).toEqual(value);
        const preferences = JSON.parse(device.getString('local-settings')!);
        expect(preferences).toMatchObject({ themePreference: 'light' });
        expect(preferences).not.toHaveProperty(key);
    });

    it.each(history)('preserves newer destination bytes for %s', (key, destination, value) => {
        const device = getPersistenceStorage();
        device.set(destination, JSON.stringify(value));
        const source = key === 'hasCompletedAuthOnce' ? false : key.endsWith('SeenAt') ? null
            : key === 'acknowledgedCliVersions' ? {} : [];
        device.set('local-settings', JSON.stringify({ [key]: source }));
        loadLocalSettings();
        expect(JSON.parse(device.getString(destination)!)).toEqual(value);
        expect(JSON.parse(device.getString('local-settings')!)).toEqual({});
    });

    it.each(history)('keeps an unadmitted %s source instead of silently defaulting it', (key) => {
        const device = getPersistenceStorage();
        const source = { themePreference: 'dark', [key]: key === 'acknowledgedCliVersions'
            ? { future: { opaque: true } } : { future: 'opaque' } };
        device.set('local-settings', JSON.stringify(source));
        saveLocalSettings({ ...loadLocalSettings(), themePreference: 'light' });
        expect(JSON.parse(device.getString('local-settings')!)).toMatchObject({ ...source, themePreference: 'light' });
    });

    it.each(history)('keeps %s source bytes when an existing destination is unadmitted', (key, destination, value) => {
        const device = getPersistenceStorage();
        const opaque = JSON.stringify({ future: { opaque: true } });
        const source = JSON.stringify({ themePreference: 'dark', [key]: value });
        device.set(destination, opaque);
        device.set('local-settings', source);
        loadLocalSettings();
        expect(device.getString(destination)).toBe(opaque);
        expect(device.getString('local-settings')).toBe(source);
    });

    it.each(history)('keeps unadmitted %s source bytes even when the destination already exists', (key, destination, value) => {
        const device = getPersistenceStorage();
        const source = JSON.stringify({ [key]: { future: { opaque: true } } });
        device.set(destination, JSON.stringify(value));
        device.set('local-settings', source);
        loadLocalSettings();
        expect(device.getString(destination)).toBe(JSON.stringify(value));
        expect(device.getString('local-settings')).toBe(source);
    });
});

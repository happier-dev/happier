import { beforeEach, describe, expect, it, vi } from 'vitest';

import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';

// The device key-value store is the persistence boundary; the local settings schema and owner stay real.
const values = vi.hoisted(() => new Map<string, string>());
vi.mock('@/sync/domains/state/persistenceStorage', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/domains/state/persistenceStorage')>(),
    getPersistenceStorage: () => ({
        getString: (key: string) => values.get(key),
        set: (key: string, value: string) => values.set(key, value),
    }),
}));

describe('All machines view (machines.indexView)', () => {
    beforeEach(() => values.clear());

    it('defaults to List and remembers Grid on this device across a reload', async () => {
        const persistence = await import('@/sync/domains/state/settingsPersistence');
        expect(persistence.loadLocalSettings().machinesIndexViewV1).toBe('list');
        persistence.saveLocalSettings({ ...localSettingsDefaults, machinesIndexViewV1: 'grid' });
        expect(persistence.loadLocalSettings().machinesIndexViewV1).toBe('grid');
    });

    it('reads an unreadable stored view as List rather than failing the device settings', async () => {
        const persistence = await import('@/sync/domains/state/settingsPersistence');
        persistence.saveLocalSettings({ ...localSettingsDefaults, machinesIndexViewV1: 'board' as never });
        const loaded = persistence.loadLocalSettings();
        expect(loaded.machinesIndexViewV1).toBe('list');
        expect(loaded.themePreference).toBe(localSettingsDefaults.themePreference);
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { localSettingsDefaults } from '../settings/localSettings';

const values = vi.hoisted(() => new Map<string, string>());

vi.mock('./persistenceStorage', async importOriginal => ({
    ...await importOriginal<typeof import('./persistenceStorage')>(),
    getPersistenceStorage: () => ({
        getString: (key: string) => values.get(key),
        set: (key: string, value: string) => values.set(key, value),
    }),
}));

describe('local attention settings persistence mutations', () => {
    beforeEach(() => values.clear());

    it('notifies native consumers only when the device attention ceiling changes', async () => {
        const persistence = await import('./settingsPersistence');
        const listener = vi.fn();
        const unsubscribe = persistence.subscribeLocalAttentionSettingsMutations(listener);

        persistence.saveLocalSettings({ ...localSettingsDefaults, themePreference: 'dark' });
        expect(listener).not.toHaveBeenCalled();
        persistence.saveLocalSettings({
            ...localSettingsDefaults,
            attentionDeviceOverridesV1: {
                ...localSettingsDefaults.attentionDeviceOverridesV1,
                privacy: { previewBehavior: 'status_only' },
            },
        });
        expect(listener).toHaveBeenCalledTimes(1);

        persistence.saveLocalSettings({
            ...localSettingsDefaults,
            deviceRemoteAlertsEnabled: !localSettingsDefaults.deviceRemoteAlertsEnabled,
        });
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });
});

import { afterEach, describe, expect, it } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { resolveAccountThemeProfileView } from '@/sync/domains/settings/themeProfiles';
import { applyThemeProfilesFromUi } from './settingsWriters';
import { getPersistenceStorage } from '@/sync/domains/state/persistence';
import type { ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';

const profile = (id: string): ThemeProfileV1 => ({
    schemaVersion: 1, id, name: id, createdAt: '2026-10-01', updatedAt: '2026-10-01',
    base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} },
});

describe('theme profile UI edit basis', () => {
    const initial = storage.getState();
    afterEach(() => { getPersistenceStorage().clearAll(); storage.setState(initial, true); });

    it('preserves profiles arriving while a captured delete confirmation is open', () => {
        const legacy = { profiles: [profile('delete-me')], activeProfileIds: { light: null, dark: null } };
        storage.setState({ settingsScope: null, settings: { ...settingsDefaults },
            localSettings: { ...localSettingsDefaults, themeProfiles: legacy } });
        const before = resolveAccountThemeProfileView({ profiles: [], legacy, selection: null, legacyScope: null, scope: null });
        storage.getState().applyLocalSettings({ themeProfiles: { ...legacy, profiles: [...legacy.profiles, profile('arrived')] } });

        applyThemeProfilesFromUi({ ...before.state, profiles: [] }, before);

        expect(storage.getState().localSettings.themeProfiles.profiles.map(entry => entry.id)).toEqual(['arrived']);
    });

    it('refuses a captured selection after the active account changes', () => {
        const scope = { serverId: 'server', accountId: 'first' };
        const before = resolveAccountThemeProfileView({ profiles: [], legacy: localSettingsDefaults.themeProfiles,
            selection: null, legacyScope: null, scope });
        storage.setState({ settingsScope: { ...scope, accountId: 'second' }, settings: { ...settingsDefaults },
            localSettings: { ...localSettingsDefaults } });

        expect(() => applyThemeProfilesFromUi({ ...before.state, activeProfileIds: { light: 'premiumLight', dark: null } }, before))
            .toThrow();
        expect(storage.getState().localSettings.themeProfileSelection).toBeNull();
    });
});

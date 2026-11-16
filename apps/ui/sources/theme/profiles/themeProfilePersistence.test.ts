import { describe, expect, it } from 'vitest';

import { parseThemeProfilesLocalState, resolveThemeProfilesState, ThemeProfileDeviceSelectionSchema } from './themeProfilePersistence';
import type { ThemeProfileV1 } from './themeProfileTypes';

const profile = (id: string): ThemeProfileV1 => ({
    schemaVersion: 1,
    id,
    name: `Profile ${id}`,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    base: { light: 'light', dark: 'dark' },
    overrides: { light: {}, dark: {} },
});

describe('theme profile persistence', () => {
    it('retains a tagged plugin choice while its contribution is unavailable', () => {
        const selection = { light: null, dark: { kind: 'plugin', pluginId: 'custom.palette', contributionId: 'night' } };
        expect(ThemeProfileDeviceSelectionSchema.parse(selection)).toEqual(selection);
        expect(resolveThemeProfilesState([], { profiles: [], activeProfileIds: { light: null, dark: null } },
            ThemeProfileDeviceSelectionSchema.parse(selection)).activeProfileIds).toEqual({ light: null, dark: null });
    });
    it('migrates a legacy active profile id into both visual mode selections', () => {
        const result = parseThemeProfilesLocalState({
            activeProfileId: 'ocean',
            profiles: [profile('ocean')],
        });

        expect(result.state).toEqual({
            activeProfileIds: { light: 'ocean', dark: 'ocean' },
            profiles: [expect.objectContaining({ id: 'ocean' })],
        });
        expect(result.changed).toBe(true);
    });

    it('sanitizes invalid per-mode active profile ids independently', () => {
        const result = parseThemeProfilesLocalState({
            activeProfileIds: {
                light: 'ocean',
                dark: 'missing',
            },
            profiles: [profile('ocean')],
        });

        expect(result.state.activeProfileIds).toEqual({
            light: 'ocean',
            dark: null,
        });
        expect(result.changed).toBe(true);
    });

    it('drops persisted custom profiles that use ids reserved for base themes', () => {
        const result = parseThemeProfilesLocalState({
            activeProfileId: 'light',
            profiles: [profile('light')],
        });

        expect(result.state).toEqual({ activeProfileIds: { light: null, dark: null }, profiles: [] });
        expect(result.changed).toBe(true);
    });

    it('drops persisted custom profiles that use the editor route id', () => {
        const result = parseThemeProfilesLocalState({
            activeProfileId: 'new',
            profiles: [profile('new')],
        });

        expect(result.state).toEqual({ activeProfileIds: { light: null, dark: null }, profiles: [] });
        expect(result.changed).toBe(true);
    });
});


describe('theme profile library reads', () => {
    it('retains all valid profiles beyond the per-device creation limit', () => {
        const profiles = Array.from({ length: 51 }, (_, index) => profile(`theme_${index}`));
        const result = parseThemeProfilesLocalState({ profiles, activeProfileIds: { light: 'theme_50', dark: null } });
        expect(result.state.profiles).toHaveLength(51);
        expect(result.state.activeProfileIds.light).toBe('theme_50');
    });
});


describe('persisted token compatibility', () => {
    it('retains valid newer tokens for lossless account edits', () => {
        const source = { ...profile('theme_newer'), overrides: { light: { 'future.token': '#abcdef' }, dark: {} } };
        expect(parseThemeProfilesLocalState({ profiles: [source] }).state.profiles[0]?.overrides).toEqual(source.overrides);
    });
});


describe('theme library composition', () => {
    it('retains colliding legacy profiles and deterministically remaps activation', () => {
        const account = { ...profile('ocean'), name: 'Account' };
        const legacy = { ...profile('ocean'), name: 'Device' };
        const state = { profiles: [legacy], activeProfileIds: { light: 'ocean', dark: null } };
        const composed = resolveThemeProfilesState([account], state, null);
        expect(composed.profiles.map(({ id, name }) => ({ id, name }))).toEqual([
            { id: 'ocean', name: 'Account' }, { id: 'ocean_2', name: 'Device' },
        ]);
        expect(composed.activeProfileIds.light).toBe('ocean_2');
        expect(resolveThemeProfilesState(composed.profiles, state, null)).toEqual(composed);
    });
});

import { describe, expect, it } from 'vitest';

import { parseThemeProfilesLocalState, resolveThemeProfilesState, ThemeProfileLibrarySchema, ThemeProfileSelectionSchema } from './themeProfilePersistence';
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
    it('retains the device built-in selection while importing its custom library', () => {
        const legacy = parseThemeProfilesLocalState({ profiles: [profile('ocean')],
            activeProfileIds: { light: 'paperLight', dark: 'ocean' } }).state;
        expect(resolveThemeProfilesState([], legacy, null).activeProfileIds).toEqual({ light: 'paperLight', dark: 'ocean' });
    });
    it('preserves valid colors from the 0.3 catalog while migrating older token names', () => {
        const source = { ...profile('shared'), overrides: {
            light: { 'surface.skeleton': '#123456', 'constructor': '#234567', 'gitAddedText': '#345678' }, dark: {},
        } };
        const stored = ThemeProfileLibrarySchema.parse([source]);
        expect(stored[0].overrides.light).toMatchObject({
            'surface.skeleton': '#123456', 'constructor': '#234567', 'versionControl.added.foreground': '#345678',
        });
    });
    it('keeps an explicit account selection when a legacy profile has the same original ID', () => {
        const cloud = ThemeProfileLibrarySchema.parse([profile('ocean')]);
        const legacy = parseThemeProfilesLocalState({ profiles: [{ ...profile('ocean'), name: 'Local ocean' }] }).state;
        expect(resolveThemeProfilesState(cloud, legacy, { light: 'ocean', dark: null }).activeProfileIds.light).toBe('ocean');
        const selectedBeforeFetch = ThemeProfileSelectionSchema.parse({ light: { legacyProfileId: 'ocean' }, dark: null });
        expect(resolveThemeProfilesState(cloud, legacy, selectedBeforeFetch).activeProfileIds.light).toBe('ocean_2');
    });
    it('preserves a conflicting legacy profile with a stable ID and remaps its local activation', () => {
        const cloud = ThemeProfileLibrarySchema.parse([profile('ocean')]);
        const legacy = parseThemeProfilesLocalState({
            profiles: [{ ...profile('ocean'), name: 'Local ocean' }],
            activeProfileIds: { light: null, dark: 'ocean' },
        }).state;
        const merged = resolveThemeProfilesState(cloud, legacy, null);
        expect(merged.profiles.map((entry) => [entry.id, entry.name])).toEqual([
            ['ocean', 'Profile ocean'], ['ocean_2', 'Local ocean'],
        ]);
        expect(merged.activeProfileIds).toEqual({ light: null, dark: 'ocean_2' });
        expect(resolveThemeProfilesState(merged.profiles, legacy, null)).toEqual(merged);
    });
    it('preserves valid profiles beyond the creation limit when reading a merged device library', () => {
        const profiles = Array.from({ length: 60 }, (_, index) => profile(`theme_${index}`));
        const result = parseThemeProfilesLocalState({ profiles, activeProfileIds: { light: null, dark: null } });
        expect(result.state.profiles.map((entry) => entry.id)).toEqual(profiles.map((entry) => entry.id));
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

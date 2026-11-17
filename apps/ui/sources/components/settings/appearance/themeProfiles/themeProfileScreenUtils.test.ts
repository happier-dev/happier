import { describe, expect, it } from 'vitest';

import type { ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { upsertThemeProfile } from './themeProfileScreenUtils';

const baseProfile = (id: string, overrides: ThemeProfileV1['overrides'] = { light: {}, dark: {} }): ThemeProfileV1 => ({
    schemaVersion: 1,
    id,
    name: `Profile ${id}`,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    base: { light: 'light', dark: 'dark' },
    overrides,
});

const largeProfileState = (): ThemeProfilesLocalStateV1 => ({
    activeProfileIds: { light: null, dark: null },
    profiles: Array.from({ length: 50 }, (_, index) => baseProfile(`theme_${index}`)),
});

const emptyThemeProfiles = (): ThemeProfilesLocalStateV1 => ({
    activeProfileIds: { light: null, dark: null },
    profiles: [],
});

describe('theme profile screen utilities', () => {
    it('appends a new profile beyond the former 50-profile limit', () => {
        const state = largeProfileState();

        const result = upsertThemeProfile(state, baseProfile('theme_over_limit'));

        expect(result.profiles).toHaveLength(51);
        expect(result.profiles.some((entry) => entry.id === 'theme_over_limit')).toBe(true);
    });

    it('updates an existing profile in a large library', () => {
        const state = largeProfileState();

        const result = upsertThemeProfile(state, { ...baseProfile('theme_0'), name: 'Updated profile' });

        expect(result.profiles).toHaveLength(50);
        expect(result.profiles[0]?.name).toBe('Updated profile');
    });

    it('preserves valid opaque override tokens when updating a profile', () => {
        const state = emptyThemeProfiles();
        const profile = baseProfile('theme_future', { light: { 'future.custom.color': '#123456' }, dark: {} });
        expect(upsertThemeProfile(state, profile).profiles[0]?.overrides).toEqual(profile.overrides);
    });

    it('does not persist invalid editable profile state', () => {
        const state = emptyThemeProfiles();

        const result = upsertThemeProfile(state, {
            ...baseProfile('theme_invalid'),
            name: 'x'.repeat(65),
            overrides: { light: { 'background.canvas': 'hotpink' }, dark: {} },
        });

        expect(result.profiles).toEqual([]);
    });

    it('does not persist route-unsafe profile ids from editable state', () => {
        const state = emptyThemeProfiles();

        const result = upsertThemeProfile(state, baseProfile('../bad/profile?x=1'));

        expect(result.profiles).toEqual([]);
    });

    it('does not persist profile ids reserved for base themes from editable state', () => {
        const state = emptyThemeProfiles();

        const result = upsertThemeProfile(state, baseProfile('light'));

        expect(result.profiles).toEqual([]);
    });

    it('does not persist the editor route id from editable state', () => {
        const state = emptyThemeProfiles();

        const result = upsertThemeProfile(state, baseProfile('new'));

        expect(result.profiles).toEqual([]);
    });
});

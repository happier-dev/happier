import { describe, expect, it } from 'vitest';

import { THEME_PROFILE_MAX_PROFILES } from '@/theme/profiles/themeProfileConstants';
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

const maxProfileState = (): ThemeProfilesLocalStateV1 => ({
    activeProfileIds: { light: null, dark: null },
    profiles: Array.from({ length: THEME_PROFILE_MAX_PROFILES }, (_, index) => baseProfile(`theme_${index}`)),
});

const emptyThemeProfiles = (): ThemeProfilesLocalStateV1 => ({
    activeProfileIds: { light: null, dark: null },
    profiles: [],
});

describe('theme profile screen utilities', () => {
    it('does not append a new profile after the local profile limit is reached', () => {
        const state = maxProfileState();

        const result = upsertThemeProfile(state, baseProfile('theme_over_limit'));

        expect(result.profiles).toHaveLength(THEME_PROFILE_MAX_PROFILES);
        expect(result.profiles.some((entry) => entry.id === 'theme_over_limit')).toBe(false);
    });

    it('still updates an existing profile after the local profile limit is reached', () => {
        const state = maxProfileState();

        const result = upsertThemeProfile(state, { ...baseProfile('theme_0'), name: 'Updated profile' });

        expect(result.profiles).toHaveLength(THEME_PROFILE_MAX_PROFILES);
        expect(result.profiles[0]?.name).toBe('Updated profile');
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

import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '@/theme';
import type { ThemeProfileV1 } from './themeProfileTypes';
import { clearEffectiveThemeCache, resolveThemeProfile } from './resolveThemeProfile';

const profile = (overrides: ThemeProfileV1['overrides'], updatedAt = '2026-05-11T00:00:00.000Z'): ThemeProfileV1 => ({
    schemaVersion: 1,
    id: 'profile_test',
    name: 'Test profile',
    createdAt: '2026-05-11T00:00:00.000Z',
    updatedAt,
    base: { light: 'light', dark: 'dark' },
    overrides,
});

describe('resolveThemeProfile', () => {
    it('preserves canonical visual values when no profile is active', () => {
        expect(resolveThemeProfile({ mode: 'light', profile: null })).toBe(lightTheme);
        expect(resolveThemeProfile({ mode: 'dark', profile: null })).toBe(darkTheme);
    });

    it('applies valid overrides to light and dark separately and falls back for missing tokens', () => {
        const effectiveLight = resolveThemeProfile({
            mode: 'light',
            profile: profile({
                light: { 'background.canvas': '#fafafa', 'surface.base': '#eeeeee' },
                dark: { 'background.canvas': '#0A0A0B' },
            }),
        });
        const effectiveDark = resolveThemeProfile({
            mode: 'dark',
            profile: profile({
                light: { 'background.canvas': '#fafafa' },
                dark: { 'background.canvas': '#0A0A0B' },
            }),
        });

        expect(effectiveLight.colors.background.canvas).toBe('#fafafa');
        expect(effectiveLight.colors.surface.base).toBe('#eeeeee');
        expect(effectiveLight.colors.text.primary).toBe(lightTheme.colors.text.primary);
        expect(effectiveDark.colors.background.canvas).toBe('#0A0A0B');
        expect(effectiveDark.colors.surface.base).toBe(darkTheme.colors.surface.base);
    });

    it('ignores unknown token ids and invalid color values without mutating base themes', () => {
        const beforeCanvas = lightTheme.colors.background.canvas;
        const effective = resolveThemeProfile({
            mode: 'light',
            profile: profile({
                light: {
                    'background.canvas': '#fefefe',
                    'unknown.token': '#111111',
                    'surface.base': 'red',
                },
                dark: {},
            }),
        });

        expect(effective.colors.background.canvas).toBe('#fefefe');
        expect(effective.colors.surface.base).toBe(lightTheme.colors.surface.base);
        expect(lightTheme.colors.background.canvas).toBe(beforeCanvas);
    });

    it('derives linked color recipes after overrides are applied', () => {
        const effective = resolveThemeProfile({
            mode: 'light',
            profile: profile({
                light: {
                    'control.button.primary.background': '#123456',
                    'control.button.primary.foreground': '#FEDCBA',
                    'control.fab.background': '#654321',
                    'control.fab.backgroundPressed': '#765432',
                    'control.segmentedControl.activeBackground': '#ABCDEF',
                },
                dark: {},
            }),
        });

        expect(effective.colors.button.primary.gradient.colors).toEqual(['#123456', '#123456']);
        expect(effective.colors.fab.gradient.colors).toEqual(['#654321', '#765432']);
        expect(effective.colors.segmentedControl.activeGradient.colors).toEqual(['#ABCDEF', '#ABCDEF']);
    });

    it('derives internal feed card surfaces from the active elevated surface', () => {
        const effective = resolveThemeProfile({
            mode: 'dark',
            profile: profile({
                light: {},
                dark: {
                    'surface.elevated': '#10131A',
                },
            }),
        });

        expect(effective.colors.feed.card.background).toBe(effective.colors.surface.elevated);
        expect(effective.colors.feed.card.background).not.toBe(darkTheme.colors.feed.card.background);
    });

    it('derives connection status colors from public state overrides', () => {
        const effective = resolveThemeProfile({
            mode: 'light',
            profile: profile({
                light: {
                    'state.success.foreground': '#101010',
                    'state.warning.foreground': '#202020',
                    'state.info.foreground': '#303030',
                    'state.neutral.foreground': '#404040',
                    'state.danger.foreground': '#505050',
                },
                dark: {},
            }),
        });

        expect(effective.colors.status.connected).toBe('#101010');
        expect(effective.colors.status.actionRequired).toBe('#202020');
        expect(effective.colors.status.connecting).toBe('#303030');
        expect(effective.colors.status.default).toBe('#404040');
        expect(effective.colors.status.disconnected).toBe('#404040');
        expect(effective.colors.status.error).toBe('#505050');
    });

    it('preserves canonical color recipes when an active profile has no overrides', () => {
        const effectiveLight = resolveThemeProfile({
            mode: 'light',
            profile: profile({ light: {}, dark: {} }),
        });
        const effectiveDark = resolveThemeProfile({
            mode: 'dark',
            profile: profile({ light: {}, dark: {} }),
        });

        expect(effectiveLight.colors.button.primary.gradient.colors).toEqual(lightTheme.colors.button.primary.gradient.colors);
        expect(effectiveLight.colors.fab.gradient.colors).toEqual(lightTheme.colors.fab.gradient.colors);
        expect(effectiveLight.colors.status).toEqual(lightTheme.colors.status);
        expect(effectiveDark.colors.button.primary.gradient.colors).toEqual(darkTheme.colors.button.primary.gradient.colors);
        expect(effectiveDark.colors.fab.gradient.colors).toEqual(darkTheme.colors.fab.gradient.colors);
        expect(effectiveDark.colors.status).toEqual(darkTheme.colors.status);
    });

    it('caches effective themes by mode, profile id, updated timestamp, and override hash', () => {
        clearEffectiveThemeCache();
        const firstProfile = profile({ light: { 'background.canvas': '#fafafa' }, dark: {} });
        const sameProfile = profile({ light: { 'background.canvas': '#fafafa' }, dark: {} });
        const changedProfile = profile({ light: { 'background.canvas': '#eeeeee' }, dark: {} });

        const first = resolveThemeProfile({ mode: 'light', profile: firstProfile });
        const second = resolveThemeProfile({ mode: 'light', profile: sameProfile });
        const third = resolveThemeProfile({ mode: 'light', profile: changedProfile });

        expect(second).toBe(first);
        expect(third).not.toBe(first);
        expect(third.colors.background.canvas).toBe('#eeeeee');
    });
});

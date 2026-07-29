import { describe, expect, it } from 'vitest';

import type { ThemePresetSourceOption } from './themeProfilePresetOptions';
import { buildThemePresetSourceOptions, resolveThemePresetSourcePreferredMode, themeProfileDraftMatchesPresetSource } from './themeProfilePresetOptions';
import type { ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';

const profile = (overrides: ThemeProfileV1['overrides']): ThemeProfileV1 => ({
    schemaVersion: 1,
    id: 'theme_order',
    name: 'Order',
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    base: { light: 'light', dark: 'dark' },
    overrides,
});

const withAssetAppearance = (
    sourceProfile: ThemeProfileV1,
    assetAppearance: 'light' | 'dark',
): ThemeProfileV1 & { assetAppearance: 'light' | 'dark' } => ({
    ...sourceProfile,
    assetAppearance,
});

const source = (sourceProfile: ThemeProfileV1): ThemePresetSourceOption => ({
    id: sourceProfile.id,
    kind: 'custom',
    title: sourceProfile.name,
    subtitle: 'Custom theme',
    profile: sourceProfile,
    preferredMode: 'light',
});

describe('themeProfilePresetOptions', () => {
    it('matches preset values independent of override key insertion order', () => {
        const draft = profile({
            light: { 'text.primary': '#111111', 'background.canvas': '#FFFFFF' },
            dark: { 'surface.base': '#222222', 'text.primary': '#EEEEEE' },
        });
        const preset = source(profile({
            light: { 'background.canvas': '#FFFFFF', 'text.primary': '#111111' },
            dark: { 'text.primary': '#EEEEEE', 'surface.base': '#222222' },
        }));

        expect(themeProfileDraftMatchesPresetSource(draft, preset)).toBe(true);
    });

    it('infers custom theme mode from the side that actually contains profile colors', () => {
        expect(resolveThemePresetSourcePreferredMode(profile({
            light: {},
            dark: { 'background.canvas': '#08080A' },
        }))).toBe('dark');
        expect(resolveThemePresetSourcePreferredMode(profile({
            light: { 'background.canvas': '#FFFFFF' },
            dark: {},
        }))).toBe('light');
    });

    it('uses the inferred custom mode in preset source options', () => {
        const options = buildThemePresetSourceOptions({
            activeProfileIds: { light: null, dark: null },
            profiles: [profile({ light: {}, dark: { 'background.canvas': '#08080A' } })],
        });
        const custom = options.find((option) => option.id === 'theme_order');

        expect(custom?.preferredMode).toBe('dark');
    });

    it('uses explicit custom asset appearance instead of inferring from color override counts', () => {
        const options = buildThemePresetSourceOptions({
            activeProfileIds: { light: null, dark: null },
            profiles: [withAssetAppearance(profile({
                light: { 'background.canvas': '#FFFFFF' },
                dark: {},
            }), 'dark')],
        });
        const custom = options.find((option) => option.id === 'theme_order');

        expect(custom?.preferredMode).toBe('dark');
    });

    it('uses built-in preset metadata for curated theme modes', () => {
        const options = buildThemePresetSourceOptions({ activeProfileIds: { light: null, dark: null }, profiles: [] });

        expect(options.find((option) => option.id === 'premiumDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'pitchDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'sunsetDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'tokyoNight')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'nightDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'classicDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'graphiteDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'catppuccinMocha')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'catppuccinMacchiato')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'catppuccinFrappe')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'oneDarkPro')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'monokaiPro')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'githubDark')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'darkModern')?.preferredMode).toBe('dark');
        expect(options.find((option) => option.id === 'premiumLight')?.preferredMode).toBe('light');
        expect(options.find((option) => option.id === 'paperLight')?.preferredMode).toBe('light');
        expect(options.find((option) => option.id === 'catppuccinLatte')?.preferredMode).toBe('light');
        expect(options.find((option) => option.id === 'githubLight')?.preferredMode).toBe('light');
    });
});

// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { darkTheme, lightTheme, type Theme } from '@/theme';
import { FontFamilies } from '@/constants/Typography';
import { BUNDLED_FONTS } from '@/constants/bundledFonts';
import * as stylesheet from '../css/themeStylesheet';
import * as cssParser from '../css/cssTreeBoundary';
import { Appearance } from 'react-native';

import { applyThemeRuntimeSelection, initializeThemeRuntimeAppearance, resolveThemeRuntimeStartupThemes } from './themeProfileRuntime';
import { themeStyleSelectionFromSurfaceFinish } from '../themeStyleScales';
import type { ThemeProfilesLocalStateV1 } from './themeProfileTypes';
import { getBuiltInThemeLibraryEntries } from './builtInThemeProfiles';

const noProfiles: ThemeProfilesLocalStateV1 = { activeProfileIds: { light: null, dark: null }, profiles: [] };
beforeAll(cssParser.acquireThemeCssParser);

function createRegisteredThemes() {
    const registered: Record<'light' | 'dark', Theme> = { light: lightTheme, dark: darkTheme };
    const updateTheme = vi.fn((name: 'light' | 'dark', updater: (theme: Theme) => Theme) => {
        registered[name] = updater(registered[name]);
    });
    return {
        registered,
        updateTheme,
        adapter: {
            getTheme: (name: 'light' | 'dark') => registered[name],
            updateTheme,
            setAdaptiveThemes: vi.fn(),
            setTheme: vi.fn(),
            setRootViewBackgroundColor: vi.fn(),
        },
    };
}

function rootFontVariable(name: string): string {
    return document.documentElement.style.getPropertyValue(name).trim();
}

describe('theme runtime style selection', () => {
    it('keeps the startup palette synchronous and reconciles first-use native CSS without reviving an old selection', async () => {
        vi.resetModules();
        const cold = await import('./themeProfileRuntime');
        const runtime = createRegisteredThemes();
        const profile = { schemaVersion: 1 as const, id: 'cold-css', name: 'Cold CSS', createdAt: '2026-11-16', updatedAt: '2026-11-16',
            base: { light: 'light' as const, dark: 'dark' as const }, overrides: { light: {}, dark: {} },
            css: '[data-surface=composer]{border-radius:27px}' };
        const input = { themePreference: 'light' as const,
            themeProfiles: { activeProfileIds: { light: profile.id, dark: null }, profiles: [profile] },
            platform: 'ios', unistylesRuntime: runtime.adapter, style: null,
            setSystemBackgroundColor: () => {}, recordBreadcrumb: () => {} };
        const startup = cold.resolveThemeRuntimeStartupThemes(input);
        expect(startup.themes.light.surfaces).toBeUndefined();
        runtime.registered.light = startup.themes.light;
        runtime.registered.dark = startup.themes.dark;
        cold.initializeThemeRuntimeAppearance(input, startup.themes);
        cold.applyThemeRuntimeSelection({ ...input, themeProfiles: { ...input.themeProfiles,
            profiles: [{ ...profile, css: profile.css.replace('27px', '31px') }] } });
        await vi.waitFor(() => expect(runtime.registered.light.surfaces?.composer?.root?.base.borderTopLeftRadius).toBe(31));
        expect(runtime.updateTheme).toHaveBeenCalledTimes(1);
        cold.applyThemeRuntimeSelection({ ...input, themeProfiles: noProfiles });
        expect(runtime.registered.light.surfaces).toBeUndefined();
    });
    it('replaces web CSS at the sheet boundary without updating Unistyles themes', () => {
        const sheet = vi.spyOn(stylesheet, 'applyThemeStylesheet');
        const runtime = createRegisteredThemes();
        const profile = {
            schemaVersion: 1 as const, id: 'css', name: 'CSS', createdAt: '2026-11-16', updatedAt: '2026-11-16',
            base: { light: 'light' as const, dark: 'dark' as const }, overrides: { light: {}, dark: {} },
            css: '[data-surface="composer"] { border-radius: 12px; }',
        };
        const themeProfiles = { activeProfileIds: { light: 'css', dark: null }, profiles: [profile] };
        const input = { themePreference: 'light' as const, themeProfiles, platform: 'web',
            unistylesRuntime: runtime.adapter, style: null, recordBreadcrumb: () => {} };
        applyThemeRuntimeSelection(input);
        runtime.updateTheme.mockClear();
        sheet.mockClear();
        const css = profile.css.replace('12px', '14px');
        applyThemeRuntimeSelection({ ...input, themeProfiles: { ...themeProfiles, profiles: [{ ...profile, css }] } });
        expect(sheet).toHaveBeenLastCalledWith({ source: css }, 'light');
        expect(runtime.updateTheme).not.toHaveBeenCalled();
        applyThemeRuntimeSelection({ ...input, themeProfiles: noProfiles });
        expect(sheet).toHaveBeenLastCalledWith(null, 'light');
        sheet.mockRestore();
    });
    it('applies native CSS through one theme update and does no work on an unchanged selection', () => {
        const runtime = createRegisteredThemes();
        const parse = vi.spyOn(cssParser, 'parseThemeCss');
        const profile = {
            schemaVersion: 1 as const, id: 'native-css', name: 'CSS', createdAt: '2026-11-16', updatedAt: '2026-11-16',
            base: { light: 'light' as const, dark: 'dark' as const }, overrides: { light: {}, dark: {} },
            css: '[data-surface="composer"] { border-radius: 12px; }',
        };
        const input = { themePreference: 'light' as const,
            themeProfiles: { activeProfileIds: { light: profile.id, dark: null }, profiles: [profile] },
            platform: 'ios', unistylesRuntime: runtime.adapter, style: null,
            setSystemBackgroundColor: () => {}, recordBreadcrumb: () => {} };
        applyThemeRuntimeSelection(input);
        expect(runtime.registered.light.surfaces?.composer?.root?.base.borderTopLeftRadius).toBe(12);
        expect(runtime.updateTheme).toHaveBeenCalledTimes(1);
        expect(parse).toHaveBeenCalledTimes(1);
        runtime.updateTheme.mockClear();
        parse.mockClear();
        applyThemeRuntimeSelection(input);
        expect(runtime.updateTheme).not.toHaveBeenCalled();
        expect(parse).not.toHaveBeenCalled();
        // The selected-profile producer supplies a fresh DTO; metadata is not a paint input.
        applyThemeRuntimeSelection({ ...input, themeProfiles: { ...input.themeProfiles,
            profiles: [{ ...profile, name: 'Renamed', updatedAt: '2026-11-17' }] } });
        expect(runtime.updateTheme).not.toHaveBeenCalled();
        expect(parse).not.toHaveBeenCalled();
        const changed = { ...profile, css: profile.css.replace('12px', '14px') };
        applyThemeRuntimeSelection({ ...input, themeProfiles: { ...input.themeProfiles, profiles: [changed] } });
        expect(runtime.registered.light.surfaces?.composer?.root?.base.borderTopLeftRadius).toBe(14);
        expect(runtime.updateTheme).toHaveBeenCalledTimes(1);
        expect(parse).toHaveBeenCalledTimes(1);
        parse.mockRestore();
    });
    it('composes the newly visible native CSS table when the OS changes adaptive mode', () => {
        let changed: Parameters<typeof Appearance.addChangeListener>[0] | undefined;
        const listener = vi.spyOn(Appearance, 'addChangeListener').mockImplementation(callback => {
            changed = callback;
            return { remove() {} };
        });
        const runtime = createRegisteredThemes();
        const profile = { schemaVersion: 1 as const, id: 'adaptive-css', name: 'CSS', createdAt: '2026-11-16', updatedAt: '2026-11-16',
            base: { light: 'light' as const, dark: 'dark' as const }, overrides: { light: {}, dark: {} },
            css: '.dark [data-surface="composer"] { border-radius: 14px; }' };
        initializeThemeRuntimeAppearance({ themePreference: 'adaptive',
            themeProfiles: { activeProfileIds: { light: profile.id, dark: profile.id }, profiles: [profile] },
            platform: 'ios', unistylesRuntime: runtime.adapter, style: null,
            setSystemBackgroundColor: () => {}, recordBreadcrumb: () => {} }, runtime.registered);
        changed?.({ colorScheme: 'dark' });
        expect(runtime.registered.dark.surfaces?.composer?.root?.base.borderTopLeftRadius).toBe(14);
        expect(runtime.updateTheme).toHaveBeenCalledTimes(1);
        listener.mockRestore();
    });
    it('keeps profile corners and typeface alongside device finish and publishes once on native', () => {
        const runtime = createRegisteredThemes();
        const themeProfiles: ThemeProfilesLocalStateV1 = { activeProfileIds: { light: 'styled', dark: 'styled' }, profiles: [{
            schemaVersion: 1, id: 'styled', name: 'Styled', createdAt: '2026-11-16', updatedAt: '2026-11-16',
            base: { light: 'light', dark: 'dark' },
            overrides: { light: { 'background.canvas': '#fcfaf8' }, dark: { 'background.canvas': '#171513' } },
            style: { radius: 'round', fontFamily: FontFamilies.default.regular },
        }] };
        const input = { themePreference: 'adaptive' as const, themeProfiles, systemTheme: 'light' as const,
            platform: 'ios', unistylesRuntime: runtime.adapter, setSystemBackgroundColor: () => {}, recordBreadcrumb: () => {},
            style: themeStyleSelectionFromSurfaceFinish({ uiSurfaceFinish: 'flat' }),
        };
        applyThemeRuntimeSelection(input);
        expect(runtime.registered.light.borderRadius.xl).toBeGreaterThan(lightTheme.borderRadius.xl);
        expect(runtime.registered.light.typography.fontFamily).toBe(FontFamilies.default.regular);
        expect(runtime.registered.light.parts.card.finish).toBe('flat');
        expect(runtime.updateTheme).toHaveBeenCalledTimes(1);
        runtime.updateTheme.mockClear();
        // Opening the library resolves its miniatures through the same canonical palette owner.
        getBuiltInThemeLibraryEntries();
        applyThemeRuntimeSelection(input);
        expect(runtime.updateTheme).not.toHaveBeenCalled();
        applyThemeRuntimeSelection({ ...input, systemTheme: 'dark' });
        expect(runtime.registered.dark.borderRadius.xl).toBeGreaterThan(darkTheme.borderRadius.xl);
        expect(runtime.updateTheme).toHaveBeenCalledTimes(1);
    });
    it('restores device finish at startup and preserves role overrides through both theme modes', () => {
        const startup = resolveThemeRuntimeStartupThemes({
            themePreference: 'adaptive', themeProfiles: noProfiles,
            style: themeStyleSelectionFromSurfaceFinish({ uiSurfaceFinish: 'flat', uiSurfaceFinishOverrides: { composer: 'soft' } }),
        });
        expect(startup.themes.light.finish).toBe('flat');
        expect(startup.themes.dark.parts.composer.finish).toBe('soft');
        expect(startup.themes.dark.parts.card.finish).toBe('flat');
    });
    beforeEach(() => {
        document.documentElement.removeAttribute('style');
    });

    it('applies the style scales and font family through updateTheme and the web font variables', () => {
        const runtime = createRegisteredThemes();

        applyThemeRuntimeSelection({
            themePreference: 'light',
            themeProfiles: noProfiles,
            systemTheme: 'light',
            platform: 'web',
            unistylesRuntime: runtime.adapter,
            setSystemBackgroundColor: vi.fn(),
            recordBreadcrumb: vi.fn(),
            style: { radius: 'round', fontFamily: 'Acme Sans', monoFontFamily: 'Acme Mono' },
        });

        expect(runtime.registered.light.typography.fontFamily).toBe('Acme Sans');
        expect(runtime.registered.light.borderRadius.xl).toBeGreaterThan(lightTheme.borderRadius.xl);
        expect(runtime.registered.dark.typography.fontFamily).toBe('Acme Sans');
        expect(runtime.registered.light.colors).toEqual(lightTheme.colors);
        expect(rootFontVariable('--happier-font-default-regular')).toContain('"Acme Sans"');
        expect(rootFontVariable('--happier-font-default-semiBold')).toContain('"Acme Sans"');
        expect(rootFontVariable('--happier-font-mono-regular')).toContain('"Acme Mono"');
    });

    it('returns to the Happier family and default scales when the style is cleared', () => {
        const runtime = createRegisteredThemes();
        const base = {
            themePreference: 'light' as const,
            themeProfiles: noProfiles,
            systemTheme: 'light' as const,
            platform: 'web',
            unistylesRuntime: runtime.adapter,
            setSystemBackgroundColor: vi.fn(),
            recordBreadcrumb: vi.fn(),
        };

        applyThemeRuntimeSelection({ ...base, style: { radius: 'sharp', fontFamily: 'Acme Sans' } });
        applyThemeRuntimeSelection({ ...base, style: null });

        expect(runtime.registered.light.borderRadius).toEqual(lightTheme.borderRadius);
        expect(runtime.registered.light.typography.fontFamily).toBeNull();
        expect(rootFontVariable('--happier-font-default-regular')).toBe('');
    });

    it('publishes each loaded face of a bundled typeface to its web weight variable', () => {
        const runtime = createRegisteredThemes();
        applyThemeRuntimeSelection({ themePreference: 'light', themeProfiles: noProfiles, systemTheme: 'light',
            platform: 'web', unistylesRuntime: runtime.adapter, recordBreadcrumb: () => {},
            style: { fontFamily: BUNDLED_FONTS.plexMono.faces.regular.family },
        });
        expect(rootFontVariable('--happier-font-default-semiBold')).toContain(BUNDLED_FONTS.plexMono.faces.semiBold.family);
    });

    it('leaves the full app untouched when no style is passed', () => {
        const runtime = createRegisteredThemes();

        applyThemeRuntimeSelection({
            themePreference: 'light',
            themeProfiles: noProfiles,
            systemTheme: 'light',
            platform: 'web',
            unistylesRuntime: runtime.adapter,
            setSystemBackgroundColor: vi.fn(),
            recordBreadcrumb: vi.fn(),
        });

        expect(runtime.updateTheme).not.toHaveBeenCalled();
        expect(rootFontVariable('--happier-font-default-regular')).toBe('');
    });
});

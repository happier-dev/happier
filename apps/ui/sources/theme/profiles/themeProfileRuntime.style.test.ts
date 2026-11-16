// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { darkTheme, lightTheme, type Theme } from '@/theme';

import { applyThemeRuntimeSelection, resolveThemeRuntimeStartupThemes } from './themeProfileRuntime';
import { themeStyleSelectionFromSurfaceFinish } from '../themeStyleScales';
import type { ThemeProfilesLocalStateV1 } from './themeProfileTypes';

const noProfiles: ThemeProfilesLocalStateV1 = { activeProfileIds: { light: null, dark: null }, profiles: [] };

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

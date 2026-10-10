// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { EmbedStyleV1 } from '@happier-dev/protocol/embed';

import { darkTheme, lightTheme, type Theme } from '@/theme';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';

import { applyEmbedStyle, mergeEmbedStyles, resolveEmbedThemeApplication } from './embedStyleTheme';

function createThemeRuntime() {
    const registered: Record<'light' | 'dark', Theme> = { light: lightTheme, dark: darkTheme };
    const adapter = {
        getTheme: (name: 'light' | 'dark') => registered[name],
        updateTheme: vi.fn((name: 'light' | 'dark', updater: (theme: Theme) => Theme) => { registered[name] = updater(registered[name]); }),
        setAdaptiveThemes: vi.fn(),
        setTheme: vi.fn(),
        setRootViewBackgroundColor: vi.fn(),
    };
    const applySelection = (input: Parameters<typeof applyThemeRuntimeSelection>[0]) => applyThemeRuntimeSelection({
        ...input,
        platform: 'web',
        systemTheme: 'light',
        unistylesRuntime: adapter,
        setSystemBackgroundColor: vi.fn(),
        recordBreadcrumb: vi.fn(),
    });
    return { registered, adapter, applySelection };
}

const style = (value: Omit<EmbedStyleV1, 'v'>): EmbedStyleV1 => ({ v: 1, ...value });

describe('embed style → theme', () => {
    it('maps the shared surface finish and merges a part finish without discarding its radius', () => {
        const merged = mergeEmbedStyles(style({ finish: 'flat', parts: { composer: { radius: 'xxl' }, card: { finish: 'flat' } } }), style({ parts: { composer: { finish: 'soft' } } }));
        expect(resolveEmbedThemeApplication(merged).style).toEqual({ finish: 'flat', parts: { composer: { radius: 'xxl', finish: 'soft' }, card: { finish: 'flat' } } });
    });
    it('applies valid colours through the theme runtime and drops invalid ones', async () => {
        const runtime = createThemeRuntime();

        await applyEmbedStyle(style({
            mode: 'light',
            colors: { light: { 'surface.base': '#f4f7f5', 'text.primary': 'not-a-colour', 'nope.token': '#000000' } },
        }), {
            applySelection: runtime.applySelection,
            installFontFace: async () => ({ status: 'cleared' }),
            applyLocalSettings: vi.fn(),
        });

        expect(runtime.registered.light.colors.surface.base.toLowerCase()).toBe('#f4f7f5');
        expect(runtime.registered.light.colors.text.primary).toBe(lightTheme.colors.text.primary);
        expect(runtime.adapter.setTheme).toHaveBeenCalledWith('light');
    });

    it('maps mode, radius, density, parts and families onto the theme style selection', () => {
        const application = resolveEmbedThemeApplication(style({
            mode: 'system',
            radius: 'round',
            density: 'compact',
            parts: { codeBlock: { radius: 'xxl' } },
            typography: { fontFamily: 'Acme Sans', monoFontFamily: 'Acme Mono', scale: 'large' },
        }));

        expect(application.themePreference).toBe('adaptive');
        expect(application.style).toEqual({
            radius: 'round',
            density: 'compact',
            parts: { codeBlock: { radius: 'xxl' } },
            fontFamily: 'Acme Sans',
            monoFontFamily: 'Acme Mono',
        });
        expect(application.uiFontScale).toBeGreaterThan(1);
    });

    it('uses a built-in preset under the custom colours and ignores an unknown preset', () => {
        const withPreset = resolveEmbedThemeApplication(style({ preset: 'tokyoNight', colors: { dark: { 'surface.base': '#101010' } } }));
        const profile = withPreset.themeProfiles.profiles[0];
        expect(profile?.overrides.dark['surface.base']).toBe('#101010');
        expect(Object.keys(profile?.overrides.dark ?? {}).length).toBeGreaterThan(1);

        const unknown = resolveEmbedThemeApplication(style({ preset: 'no-such-preset' }));
        expect(unknown.themeProfiles.profiles[0]?.overrides).toEqual({ light: {}, dark: {} });
    });

    it('applies the text size as a runtime-only scale and loads the font file', async () => {
        const runtime = createThemeRuntime();
        const applyLocalSettings = vi.fn();
        const installFontFace = vi.fn(async () => ({ status: 'loaded' as const }));

        await applyEmbedStyle(style({ typography: { fontUrl: 'https://fonts.acme.dev/acme.woff2', scale: 'compact' } }), {
            applySelection: runtime.applySelection,
            installFontFace,
            applyLocalSettings,
        });

        expect(installFontFace).toHaveBeenCalledWith({ url: 'https://fonts.acme.dev/acme.woff2' });
        expect(applyLocalSettings).toHaveBeenCalledWith({ uiFontScale: expect.any(Number) }, { persist: false });
        expect(applyLocalSettings.mock.calls[0]?.[0].uiFontScale).toBeLessThan(1);
        // A font file without a family name still reaches text through the runtime face.
        expect(runtime.registered.light.typography.fontFamily).not.toBeNull();
    });

    it('layers runtime style over the saved style, token by token', () => {
        const merged = mergeEmbedStyles(
            style({ radius: 'soft', colors: { light: { 'surface.base': '#ffffff', 'text.primary': '#111111' } } }),
            style({ radius: 'sharp', colors: { light: { 'surface.base': '#fafafa' } } }),
        );

        expect(merged).toEqual(style({ radius: 'sharp', colors: { light: { 'surface.base': '#fafafa', 'text.primary': '#111111' } } }));
        expect(mergeEmbedStyles(null, undefined)).toBeNull();
    });
});

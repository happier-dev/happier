/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import Color from 'color';
import { installFormsCommonModuleMocks } from '@/components/ui/forms/formsTestHelpers';

const appearance = vi.hoisted(() => ({
    mode: 'light' as 'light' | 'dark',
    listeners: new Set<(preferences: { colorScheme: 'light' | 'dark' }) => void>(),
}));

installFormsCommonModuleMocks({
    reactNative: async () => ({
        ...await vi.importActual<typeof import('react-native')>('react-native-web'),
        // RNW captures matchMedia during setup-module evaluation, before this test's
        // browser exists. Model the OS Appearance boundary; keep the theme runtime real.
        Appearance: {
            getColorScheme: () => appearance.mode,
            addChangeListener: (listener: (preferences: { colorScheme: 'light' | 'dark' }) => void) => {
                appearance.listeners.add(listener);
                return { remove: () => { appearance.listeners.delete(listener); } };
            },
        },
    }),
    unistyles: async () => vi.importActual('react-native-unistyles'),
});

it('keeps shell paint and a retained pane on the resolved system or explicit theme without remounting', async () => {
    let mode: 'light' | 'dark' = 'light';
    appearance.mode = mode;
    const queries = new Map<string, MediaQueryList>();
    const previousMatchMedia = window.matchMedia;
    const previousOrientation = Object.getOwnPropertyDescriptor(screen, 'orientation');
    // Media events and CSS custom-property resolution are browser boundaries. JSDOM does not
    // evaluate media-query CSS; publish the matching variable as the browser CSS engine does.
    window.matchMedia = media => {
        const existing = queries.get(media);
        if (existing) return existing;
        const target = Object.assign(new EventTarget(), { media, onchange: null,
            addListener(this: EventTarget, listener: EventListener) { this.addEventListener('change', listener); },
            removeListener(this: EventTarget, listener: EventListener) { this.removeEventListener('change', listener); } });
        Object.defineProperty(target, 'matches', { get: () => media === `(prefers-color-scheme: ${mode})` });
        const query = target as MediaQueryList;
        queries.set(media, query);
        return query;
    };
    Object.defineProperty(screen, 'orientation', { configurable: true, value: { type: 'portrait-primary' } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const variable = '--qa-card';
    const previousVariable = document.documentElement.style.getPropertyValue(variable);
    try {
        const { StyleSheet, UnistylesRuntime, useUnistyles } = await import('react-native-unistyles');
        const { lightTheme, darkTheme } = await import('@/theme');
        StyleSheet.configure({ themes: { light: lightTheme, dark: darkTheme }, settings: { initialTheme: 'light', CSSVars: true } });
        const { applyThemeRuntimeSelection, initializeThemeRuntimeAppearance } = await import('@/theme/profiles/themeProfileRuntime');
        const { DEFAULT_THEME_PROFILES_LOCAL_STATE } = await import('@/theme/profiles/themeProfilePersistence');
        const selection = { themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE, style: null };
        initializeThemeRuntimeAppearance({ ...selection, themePreference: 'adaptive' }, { light: lightTheme, dark: darkTheme });
        const { useGlassSurfaceColor } = await import('./useGlassSurfaceColor');
        const { RetainedPanelSurface } = await import('@/components/ui/panels/RetainedPanelSurface');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { useWebRootCanvasPresentation } = await import('@/theme/useWebRootCanvasPresentation');
        const settings = { glassSurfaceMaterials: { ...glassPresetMaterials('everywhere'), content: { blur: 'strong' as const, opacity: 0.5 } } };
        function Card({ id }: Readonly<{ id: string }>) {
            const { theme } = useUnistyles();
            const card = useGlassSurfaceColor(`var(${variable})`, 'content', false, true, false);
            return <div data-testid={id} style={{ backgroundColor: card }}>
                <span style={{ color: theme.colors.text.primary }}>1.4M</span>
            </div>;
        }
        function Shell({ active }: Readonly<{ active: boolean }>) {
            useWebRootCanvasPresentation(false);
            return <><Card id="shell" /><RetainedPanelSurface isActive={active} hiddenMode="activity">
                <Card id="pane" />
            </RetainedPanelSurface></>;
        }
        const scene = (active: boolean) => <GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true }}>
            <GlassMaterialSettingsProvider value={settings}><Shell active={active} /></GlassMaterialSettingsProvider>
        </GlassRuntimeEnvironmentProvider>;
        document.documentElement.style.setProperty(variable, lightTheme.colors.surface.base);
        await act(async () => root.render(scene(true)));
        const shell = host.querySelector<HTMLElement>('[data-testid="shell"]')!;
        const pane = host.querySelector<HTMLElement>('[data-testid="pane"]')!;
        const cases = [
            { preference: 'adaptive', os: 'dark', expected: 'dark' },
            { preference: 'adaptive', os: 'light', expected: 'light' },
            { preference: 'dark', os: 'light', expected: 'dark' },
            { preference: 'light', os: 'dark', expected: 'light' },
            { preference: 'adaptive', os: 'dark', expected: 'dark' },
        ] as const;
        for (const { preference, os, expected } of cases) {
            // A retained Activity withdraws effects; revealing it must catch theme changes.
            await act(async () => root.render(scene(false)));
            const theme = expected === 'dark' ? darkTheme : lightTheme;
            await act(async () => {
                applyThemeRuntimeSelection({ ...selection, themePreference: preference });
                mode = os;
                appearance.mode = os;
                document.documentElement.style.setProperty(variable, theme.colors.surface.base);
                for (const query of queries.values()) {
                    if (!query.media.startsWith('(prefers-color-scheme:')) continue;
                    const event = new Event('change');
                    Object.defineProperties(event, { matches: { value: query.matches }, media: { value: query.media } });
                    query.dispatchEvent(event);
                }
                for (const listener of appearance.listeners) listener({ colorScheme: os });
            });
            await act(async () => root.render(scene(true)));
            expect(UnistylesRuntime.themeName, `${preference}/${os}: runtime`).toBe(expected);
            expect(getComputedStyle(document.body).backgroundColor, `${preference}/${os}: canvas`).toBe(Color(theme.colors.background.canvas).rgb().string());
            const paint = Color(theme.colors.surface.base).alpha(0.5).rgb().string();
            for (const surface of [shell, pane]) {
                expect(getComputedStyle(surface).backgroundColor).toBe(paint);
                expect(getComputedStyle(surface.querySelector('span')!).color).toBe(Color(theme.colors.text.primary).rgb().string());
            }
            expect(host.querySelector('[data-testid="shell"]')).toBe(shell);
            expect(host.querySelector('[data-testid="pane"]')).toBe(pane);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
        document.documentElement.style.setProperty(variable, previousVariable);
        window.matchMedia = previousMatchMedia;
        if (previousOrientation) Object.defineProperty(screen, 'orientation', previousOrientation);
        else Reflect.deleteProperty(screen, 'orientation');
    }
});

it('keeps the material root as the live anchor and preserves its pointer boundary across tier changes', async () => {
    const previousMatchMedia = window.matchMedia;
    const previousOrientation = Object.getOwnPropertyDescriptor(screen, 'orientation');
    // JSDOM does not expose the native browser media/orientation boundary.
    window.matchMedia = media => Object.assign(new EventTarget(), {
        media, matches: media === '(prefers-color-scheme: light)', onchange: null, addListener() {}, removeListener() {},
    }) as MediaQueryList;
    Object.defineProperty(screen, 'orientation', { configurable: true, value: { type: 'portrait-primary' } });
    const { View } = await import('react-native');
    const { StyleSheet } = await import('react-native-unistyles');
    const { lightTheme, darkTheme } = await import('@/theme');
    StyleSheet.configure({ themes: { light: lightTheme, dark: darkTheme }, settings: { adaptiveThemes: false, initialTheme: 'light', CSSVars: true } });
    const { GlassSurface } = await import('./GlassSurface');
    const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
    const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
    const { glassPresetMaterials } = await import('./glassMaterial');
    const anchor = React.createRef<React.ComponentRef<typeof View>>();
    const enter = vi.fn();
    const leave = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const scene = (preset: 'auto' | 'solid') => <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials(preset) }}>
        <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'wallpaper' }}>
            <GlassSurface ref={anchor} collapsable={false} testID="material-anchor" surfaceGroup="card" onPointerEnter={enter} onPointerLeave={leave}>
                <View testID="anchor-child" />
            </GlassSurface>
        </GlassRuntimeEnvironmentProvider>
    </GlassMaterialSettingsProvider>;
    try {
        await act(async () => root.render(scene('auto')));
        const node = host.querySelector<HTMLElement>('[data-testid="material-anchor"]')!;
        expect(anchor.current).toBe(node);
        await act(async () => node.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
        expect(enter).toHaveBeenCalledOnce();
        await act(async () => node.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })));
        expect(leave).toHaveBeenCalledOnce();
        await act(async () => root.render(scene('solid')));
        expect(anchor.current).toBe(node);
        expect(host.querySelector('[data-testid="material-anchor"]')).toBe(node);
        expect(node.querySelector('[data-testid="anchor-child"]')).not.toBeNull();
    } finally {
        await act(async () => root.unmount());
        host.remove();
        window.matchMedia = previousMatchMedia;
        if (previousOrientation) Object.defineProperty(screen, 'orientation', previousOrientation);
        else Reflect.deleteProperty(screen, 'orientation');
    }
    expect(anchor.current).toBeNull();
});

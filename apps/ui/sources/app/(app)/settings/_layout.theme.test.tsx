// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import Color from 'color';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

const navigator = vi.hoisted(() => ({
    render: null as null | ((options: import('@react-navigation/native-stack').NativeStackNavigationOptions) => React.ReactNode),
    options: null as import('@react-navigation/native-stack').NativeStackNavigationOptions | null,
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => vi.importActual('react-native-web'),
    unistyles: async () => vi.importActual('react-native-unistyles'),
    storage: 'real',
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const Stack = Object.assign((props: { screenOptions: import('@react-navigation/native-stack').NativeStackNavigationOptions }) => navigator.render?.(props.screenOptions), { Screen: () => null });
        return { ...createExpoRouterMock({ pathname: '/settings/connected-services' }).module, Stack };
    },
});

let mode: 'dark' | 'light' = 'dark';
const queries = new Map<string, MediaQueryList>();
const previousMatchMedia = window.matchMedia;
const orientation = Object.getOwnPropertyDescriptor(screen, 'orientation');
window.matchMedia = media => {
    const previous = queries.get(media);
    if (previous) return previous;
    const query = Object.assign(new EventTarget(), {
        media, matches: false,
        onchange: null, addListener() {}, removeListener() {},
    }) satisfies MediaQueryList;
    Object.defineProperty(query, 'matches', { get: () => media === `(prefers-color-scheme: ${mode})` });
    queries.set(media, query);
    return query;
};
Object.defineProperty(screen, 'orientation', { configurable: true, value: { type: 'portrait-primary' } });
const { StyleSheet, UnistylesRuntime } = await import('react-native-unistyles');
const { darkTheme, lightTheme } = await import('@/theme');
StyleSheet.configure({ themes: { light: lightTheme, dark: darkTheme }, settings: { adaptiveThemes: true, CSSVars: true } });
const { default: SettingsLayout } = await import('./_layout');
const { createHeader } = await import('@/components/navigation/Header');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { SettingsFloatingControlsHost } = await import('@/components/settings/shell/SettingsModalFloatingControls');
const { SettingsPageHeader } = await import('@/components/settings/shell/SettingsPageHeader');

it('keeps title and Back in the current theme through cold dark desktop → light tablet → light phone', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        navigator.render = options => {
            navigator.options = options;
            return createHeader({
                options: { ...options, title: 'Connected services' },
                route: { key: 'connected-services', name: 'connected-services' },
                back: { title: 'Settings', href: undefined },
                navigation: { goBack: () => {} } as Parameters<typeof createHeader>[0]['navigation'],
            });
        };
        const resize = async (width: number) => act(async () => {
            Object.defineProperties(window, { innerWidth: { configurable: true, value: width }, innerHeight: { configurable: true, value: 844 } });
            window.dispatchEvent(new Event('resize'));
        });
        const changeSystemTheme = async (nextMode: 'dark' | 'light') => act(async () => {
            mode = nextMode;
            for (const query of queries.values()) {
                if (!query.media.startsWith('(prefers-color-scheme:')) continue;
                const event = new Event('change');
                Object.defineProperties(event, { matches: { value: query.matches }, media: { value: query.media } });
                query.dispatchEvent(event);
            }
        });
        await resize(1440);
        await act(async () => root.render(<SettingsLayout />));
        expect(UnistylesRuntime.themeName).toBe('dark');
        await changeSystemTheme('light');
        await resize(1100);
        await resize(390);
        expect(UnistylesRuntime.themeName).toBe('light');
        const title = host.querySelector<HTMLElement>('[data-testid="desktop-route-header-center"] > div');
        expect(title, 'the real Settings header title is mounted').not.toBeNull();
        expect(getComputedStyle(title!).color).toBe(Color(lightTheme.colors.chrome.header.foreground).rgb().string());
        expect(navigator.options?.headerTintColor).toBe(lightTheme.colors.chrome.header.foreground);

        // Retained destinations bypass the Expo options. Exercise the actual title/back
        // publishers too, preserving the same mounted destination across the cold sequence.
        const navigation = { push: () => {}, replace: () => {}, back: () => {}, canGoBack: () => true };
        const destination = { kind: 'settings', params: { pageId: 'connected-services' } } as const;
        const renderRetained = (phone: boolean) => root.render(
            <DestinationInstanceHost tabId="connected-services" ref={destination}
                pathname="/settings/connected-services" focused visible phone={phone} navigation={navigation}>
                <SettingsFloatingControlsHost enabled>
                    <SettingsPageHeader title="Connected services" />
                </SettingsFloatingControlsHost>
            </DestinationInstanceHost>,
        );
        await changeSystemTheme('dark');
        await act(async () => renderRetained(false));
        await resize(1440);
        await changeSystemTheme('light');
        await resize(1100);
        await resize(390);
        await act(async () => renderRetained(true));
        const retained = host.querySelector('[data-testid="workspace-destination-header"]');
        expect(retained).not.toBeNull();
        const retainedTitle = retained!.querySelector<HTMLElement>('[data-testid="desktop-route-header-center"] > div');
        expect(getComputedStyle(retainedTitle!).color).toBe(Color(lightTheme.colors.chrome.header.foreground).rgb().string());
        const back = retained!.querySelector('[data-testid="settings-modal-back"] icon');
        expect(back?.getAttribute('color')).toBe(lightTheme.colors.chrome.header.foreground);
    } finally {
        await act(async () => root.unmount());
        host.remove();
        window.matchMedia = previousMatchMedia;
        if (orientation) Object.defineProperty(screen, 'orientation', orientation);
        else Reflect.deleteProperty(screen, 'orientation');
    }
});

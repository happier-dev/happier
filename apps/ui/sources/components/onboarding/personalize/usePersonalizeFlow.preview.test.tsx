import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, onTestFinished, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { darkTheme, lightTheme, type Theme } from '@/theme';

const boundary = vi.hoisted(() => ({ setTheme: vi.fn(), themes: null as Record<'light' | 'dark', Theme> | null }));
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
        Appearance: { getColorScheme: () => 'light' },
    }));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({ runtime: {
        setTheme: boundary.setTheme,
        getTheme: (name: 'light' | 'dark') => boundary.themes?.[name],
        updateTheme: (name: 'light' | 'dark', update: (theme: Theme) => Theme) => {
            if (boundary.themes) boundary.themes[name] = update(boundary.themes[name]);
        },
    } }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));

const { usePersonalizeFlow } = await import('./usePersonalizeFlow');
const { ThemeProfileRuntimeSync } = await import('@/theme/ThemeProfileRuntimeSync');
const { getThemeTryOnOwner } = await import('@/theme/profiles/themeTryOnRuntime');

it('previews the base through the shared owner and releases only its own receipt on Skip or exit', async () => {
    const fixture = await createPlainArtifactHomeFixture('https://personalize-preview.test', { currentAccount: true });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    storage.getState().applyLocalSettings({ ...localSettingsDefaults, themePreference: 'light' });
    boundary.themes = { light: lightTheme, dark: darkTheme };
    const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }), {
        wrapper: ({ children }) => <><ThemeProfileRuntimeSync />{children}</>,
    });
    await act(async () => { hook.getCurrent().selectTheme('dark'); });
    expect(getThemeTryOnOwner().read()).toMatchObject({ document: null, selection: null, mode: 'dark' });
    expect(boundary.setTheme).toHaveBeenLastCalledWith('dark');
    expect(storage.getState().localSettings.themePreference).toBe('light');
    await act(async () => { hook.getCurrent().skip(); });
    expect(getThemeTryOnOwner().read()).toBeNull();
    expect(boundary.setTheme).toHaveBeenLastCalledWith('light');
    await act(async () => { hook.getCurrent().open('look'); hook.getCurrent().selectTheme('dark'); });
    let other!: ReturnType<ReturnType<typeof getThemeTryOnOwner>['begin']>;
    await act(async () => { other = getThemeTryOnOwner().begin({ document: null, selection: null, mode: 'dark', origin: { kind: 'agent' } }); });
    await hook.unmount();
    expect(getThemeTryOnOwner().read()).toBe(other);
    expect(boundary.setTheme).toHaveBeenLastCalledWith('dark');
    getThemeTryOnOwner().revert(other.previewRef);
    expect(fixture.requests.filter(request => request.method === 'POST')).toEqual([]);
});

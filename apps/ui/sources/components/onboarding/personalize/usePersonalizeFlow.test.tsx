import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { registerNativeThemePreferenceTransitionController } from '@/components/settings/appearance/themePreferenceTransition';

const boundary = vi.hoisted(() => ({ setTheme: vi.fn(), setStatusBarStyle: vi.fn() }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
        Appearance: { getColorScheme: () => 'light' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ runtime: { setTheme: boundary.setTheme } });
});
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: boundary.setStatusBarStyle }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));

const { usePersonalizeFlow } = await import('./usePersonalizeFlow');
const ACCOUNT_A = { serverId: 'home-a', accountId: 'alice' };
const ACCOUNT_B = { serverId: 'home-a', accountId: 'bob' };

beforeEach(() => {
    storage.setState({ settings: settingsDefaults, settingsScope: ACCOUNT_A,
        localSettings: { ...localSettingsDefaults, themePreference: 'light' } });
    boundary.setTheme.mockClear();
    boundary.setStatusBarStyle.mockClear();
});
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });

describe('Personalize mounted visit', () => {
    it('keeps the live visit usable after Strict Mode replays mount effects', async () => {
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }), {
            wrapper: ({ children }) => React.createElement(React.StrictMode, null, children),
        });
        await act(async () => { hook.getCurrent().selectTheme('dark'); });
        expect(hook.getCurrent().draft.theme).toBe('dark');
        expect(storage.getState().localSettings.themePreference).toBe('light');
        await act(async () => { expect(await hook.getCurrent().next()).toBe(true); });
        expect(hook.getCurrent().page).toBe('style');
    });

    it.each(['conversation', 'summary'] as const)('retires %s on Account switch before any Next or completion write', async initialPage => {
        const onExit = vi.fn();
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage, onExit }));
        await act(async () => { hook.getCurrent().update({ thinking: 'hidden' }); });
        const held = hook.getCurrent();
        await act(async () => { storage.setState({ settingsScope: ACCOUNT_B, settings: { ...settingsDefaults, sessionListDensity: 'cozy' } }); });
        expect(onExit).toHaveBeenCalledTimes(1);
        const accountB = storage.getState().settings;
        const localB = storage.getState().localSettings;
        await act(async () => { expect(await held.next()).toBe(false); expect(await hook.getCurrent().next()).toBe(false); });
        expect(storage.getState().settings).toBe(accountB);
        expect(storage.getState().localSettings).toBe(localB);
    });

    it('previews a tile without persistence, and Skip restores the saved theme', async () => {
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
        await act(async () => { hook.getCurrent().selectTheme('dark'); });
        expect(boundary.setTheme).toHaveBeenLastCalledWith('dark');
        expect(storage.getState().localSettings.themePreference).toBe('light');
        await act(async () => { hook.getCurrent().skip(); });
        expect(hook.getCurrent().draft.theme).toBe('light');
        expect(storage.getState().localSettings.themePreference).toBe('light');
        expect(boundary.setTheme).toHaveBeenLastCalledWith('light');
        expect(hook.getCurrent().page).toBe('style');
    });

    it('leaving an unconfirmed Look restores the saved runtime theme', async () => {
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
        await act(async () => { hook.getCurrent().selectTheme('dark'); });
        await hook.unmount();
        expect(storage.getState().localSettings.themePreference).toBe('light');
        expect(boundary.setTheme).toHaveBeenLastCalledWith('light');
    });

    it('awaits the theme commit before advancing or recording progress', async () => {
        let commit!: () => void;
        const unregister = registerNativeThemePreferenceTransitionController({ run: mutation => new Promise<void>(resolve => {
            commit = () => { mutation(); resolve(); };
        }) });
        try {
            const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
            await act(async () => { hook.getCurrent().selectTheme('dark'); });
            let pending: Promise<boolean> | boolean;
            await act(async () => { pending = hook.getCurrent().next(); });
            expect(hook.getCurrent().page).toBe('look');
            expect(storage.getState().localSettings.personalizeProgressV1.savedSteps).toEqual([]);
            await act(async () => { commit(); expect(await pending).toBe(true); });
            expect(hook.getCurrent().page).toBe('style');
            expect(storage.getState().localSettings.themePreference).toBe('dark');
            expect(storage.getState().localSettings.personalizeProgressV1.savedSteps).toEqual(['look']);
        } finally { unregister(); }
    });

    it('keeps the draft and step on a storage rejection, then retries through the theme owner', async () => {
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
        await act(async () => { hook.getCurrent().selectTheme('dark'); });
        // The native device persistence adapter is a genuine system boundary; all store/flow/theme logic stays real.
        const persist = vi.spyOn(getPersistenceStorage(), 'set').mockImplementationOnce(() => { throw new Error('device storage refused'); });
        await act(async () => { expect(await hook.getCurrent().next()).toBe(false); });
        expect(hook.getCurrent()).toMatchObject({ page: 'look', status: 'failed', draft: { theme: 'dark' } });
        expect(storage.getState().localSettings.personalizeProgressV1.savedSteps).toEqual([]);
        persist.mockRestore();
        await act(async () => { expect(await hook.getCurrent().next()).toBe(true); });
        expect(hook.getCurrent().page).toBe('style');
    });

    it('rejects a theme mutation delayed until after its launching Account retires', async () => {
        let commit!: () => void;
        const unregister = registerNativeThemePreferenceTransitionController({ run: mutation => new Promise<void>((resolve, reject) => {
            commit = () => { try { mutation(); resolve(); } catch (error) { reject(error); } };
        }) });
        try {
            const onExit = vi.fn();
            const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit }));
            await act(async () => { hook.getCurrent().selectTheme('dark'); });
            let pending: Promise<boolean> | boolean;
            await act(async () => { pending = hook.getCurrent().next(); });
            await act(async () => { storage.setState({ settingsScope: ACCOUNT_B }); });
            const localB = storage.getState().localSettings;
            await act(async () => { commit(); expect(await pending).toBe(false); });
            expect(onExit).toHaveBeenCalledTimes(1);
            expect(storage.getState().localSettings).toBe(localB);
        } finally { unregister(); }
    });
});

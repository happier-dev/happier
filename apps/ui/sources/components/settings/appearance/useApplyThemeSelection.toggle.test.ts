import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const shared = vi.hoisted(() => ({
    /** The theme on screen, as the running Unistyles theme reports it. */
    screenDark: false,
    systemScheme: 'light' as 'light' | 'dark',
    setTheme: vi.fn(),
    setAdaptiveThemes: vi.fn(),
    setStatusBarStyle: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Appearance: { getColorScheme: () => shared.systemScheme } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const base = await createUnistylesMock({
        runtime: { setTheme: shared.setTheme, setAdaptiveThemes: shared.setAdaptiveThemes },
    });
    return {
        ...base,
        useUnistyles: () => {
            const value = base.useUnistyles();
            return { ...value, theme: { ...value.theme, dark: shared.screenDark } };
        },
    };
});
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: shared.setStatusBarStyle }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();

const { useToggleThemeMode, useApplyThemeSelection, previewThemeSelection } = await import('./useApplyThemeSelection');

const CUSTOM_PROFILES = { activeProfileIds: { light: null, dark: 'nightDark' }, profiles: [] };

async function toggleFrom(params: Readonly<{ preference: 'adaptive' | 'light' | 'dark'; screenDark: boolean; systemScheme: 'light' | 'dark' }>) {
    storage.getState().applyLocalSettings({ themePreference: params.preference, themeProfiles: CUSTOM_PROFILES });
    shared.screenDark = params.screenDark;
    shared.systemScheme = params.systemScheme;
    const hook = await renderHook(() => useToggleThemeMode());
    await hook.getCurrent()();
    await hook.unmount();
    return storage.getState().localSettings;
}

let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>>;
beforeEach(async () => { account = await createSecretSettingsTestHarness({ settings: settingsParse({}) }); });
afterEach(async () => {
    standardCleanup();
    await account.dispose();
    storage.setState({ localSettings: localSettingsDefaults });
    shared.setTheme.mockClear();
    shared.setAdaptiveThemes.mockClear();
    shared.setStatusBarStyle.mockClear();
});

describe('useToggleThemeMode', () => {
    it('previews the runtime mode and status bar without storing the selection', () => {
        storage.getState().applyLocalSettings({ themePreference: 'light', themeProfiles: CUSTOM_PROFILES });
        previewThemeSelection('dark', CUSTOM_PROFILES);
        expect(shared.setTheme).toHaveBeenLastCalledWith('dark');
        expect(shared.setStatusBarStyle).toHaveBeenLastCalledWith('light', true);
        expect(storage.getState().localSettings).toMatchObject({ themePreference: 'light', themeProfiles: CUSTOM_PROFILES });
    });
    it('returns the commit Promise and propagates a refused settings write', async () => {
        storage.getState().applyLocalSettings({ themePreference: 'light', themeProfiles: CUSTOM_PROFILES });
        const failure = new Error('settings scope changed');
        const hook = await renderHook(() => useApplyThemeSelection(() => { throw failure; }));
        await expect(hook.getCurrent()('dark', CUSTOM_PROFILES)).rejects.toBe(failure);
        expect(storage.getState().localSettings.themePreference).toBe('light');
        expect(shared.setTheme).not.toHaveBeenCalled();
    });
    it('turns Adaptive into the explicit opposite of the theme on screen', async () => {
        expect((await toggleFrom({ preference: 'adaptive', screenDark: false, systemScheme: 'light' })).themePreference).toBe('dark');
        expect(shared.setAdaptiveThemes).toHaveBeenLastCalledWith(false);
        expect(shared.setTheme).toHaveBeenLastCalledWith('dark');

        expect((await toggleFrom({ preference: 'adaptive', screenDark: true, systemScheme: 'dark' })).themePreference).toBe('light');
        expect(shared.setTheme).toHaveBeenLastCalledWith('light');
    });

    it('flips an explicit mode and keeps the theme each mode uses', async () => {
        const fromDark = await toggleFrom({ preference: 'dark', screenDark: true, systemScheme: 'light' });
        expect(fromDark.themePreference).toBe('light');
        expect(fromDark.themeProfiles).toEqual(CUSTOM_PROFILES);
        expect(fromDark.themeProfileSelection).toEqual(CUSTOM_PROFILES.activeProfileIds);

        expect((await toggleFrom({ preference: 'light', screenDark: false, systemScheme: 'dark' })).themePreference).toBe('dark');
    });
});

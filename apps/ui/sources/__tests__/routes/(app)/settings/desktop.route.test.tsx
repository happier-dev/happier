import * as React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import type { DesktopActivityOverlayWindowStatePayload } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { resolveDesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
import {
    createUseLocalSettingMock,
    createUseLocalSettingMutableMock,
} from '@/dev/testkit/mocks/storage';
import {
    localSettingsDefaults,
    type LocalSettings,
} from '@/sync/domains/settings/localSettings';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({
    outlet: null as React.ReactNode | null,
}));
const isRunningOnMacMock = vi.hoisted(() => vi.fn(() => false));
const getDesktopActivityOverlayWindowStateMock = vi.hoisted(
    () => vi.fn<() => Promise<DesktopActivityOverlayWindowStatePayload | null>>(async () => null),
);
const listenDesktopActivityOverlayWindowStateMock = vi.hoisted(
    () => vi.fn<(handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) => Promise<() => void>>(async () => () => {}),
);
const localSettingsState = vi.hoisted(() => ({
    value: {} as LocalSettings,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
});


vi.mock('@expo/vector-icons', () => ({
    Ionicons: undefined,
}));

// Keeps the shell's icon glyphs missing (the case this route must survive) while the rest of the
// test harness's SVG primitives stay available to the real settings row owners it now renders.
vi.mock('react-native-svg', async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    default: undefined,
    Path: undefined,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock({
        pathname: () => '/settings/desktop',
        router: {
            push: vi.fn(),
            back: vi.fn(),
            replace: vi.fn(),
            setParams: vi.fn(),
        },
    });

    const Stack = Object.assign(
        function Stack(props: { children?: React.ReactNode }) {
            return React.createElement(React.Fragment, null, props.children, routeState.outlet);
        },
        {
            Screen: mock.module.Stack.Screen,
        },
    );

    return {
        ...mock.module,
        Stack,
    };
});

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => true,
    desktopHostKind: () => 'tauri',
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => isRunningOnMacMock(),
}));

vi.mock('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge', () => ({
    getDesktopActivityOverlayWindowState: () => getDesktopActivityOverlayWindowStateMock(),
    listenDesktopActivityOverlayWindowState: (handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) =>
        listenDesktopActivityOverlayWindowStateMock(handler),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    const useLocalSetting = createUseLocalSettingMock({
        values: {
            settingsNavSidebarEnabled: true,
            settingsNavSidebarWidthPx: 240,
            devModeEnabled: false,
            uiFontScale: 1,
        },
        fallback: (key) => localSettingsState.value[key],
    });
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: createUseSettingMock({ fallback: (key) => {
                if (key === 'useProfiles') return false;
                if (key === 'sessionUseTmux') return false;
                return null;
            } }),
            useLocalSettings: () => localSettingsState.value,
            useLocalSetting,
            useLocalSettingMutable: createUseLocalSettingMutableMock(useLocalSetting),
        },
    });
});

describe('/settings/desktop route', () => {
    // The settings shell's cold module graph is large; load it once here so that one-time cost is
    // not charged to the first test's own timeout (it timed out under load). The tests' own
    // `await import` calls then reuse these modules.
    beforeAll(async () => {
        await import('@/app/(app)/settings/desktop');
        await import('@/app/(app)/settings/_layout');
    }, 300_000);

    beforeEach(() => {
        routeState.outlet = null;
        isRunningOnMacMock.mockReset();
        isRunningOnMacMock.mockReturnValue(false);
        getDesktopActivityOverlayWindowStateMock.mockReset();
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(null);
        listenDesktopActivityOverlayWindowStateMock.mockReset();
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});
        localSettingsState.value = {
            ...localSettingsDefaults,
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'attention_only',
            desktopOverlayAlwaysOnTop: true,
        };
    });

    it('renders the desktop settings route inside the real settings shell without crashing', async () => {
        const { default: DesktopSettingsRoute } = await import('@/app/(app)/settings/desktop');
        routeState.outlet = React.createElement(DesktopSettingsRoute);

        const { default: SettingsLayoutRoute } = await import('@/app/(app)/settings/_layout');
        const screen = await renderScreen(React.createElement(SettingsLayoutRoute));

        expect(screen.findByTestId('settings-shell.sidebarPane')).toBeTruthy();
        expect(screen.findByTestId('settings-desktop-autostart-enabled')).toBeTruthy();
        expect(screen.findByTestId('settings-desktop-overlay-enabled')).toBeTruthy();
    });

    it('does not crash after the overlay bridge resolves desktop runtime state on mac desktop', async () => {
        isRunningOnMacMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({
            visible: true,
            model: {
                visible: true,
                generatedAt: Date.now(),
                faces: { faces: [], overflowCount: 0 },
                conversation: null,
                collapsed: {
                    title: 'Session One', statusText: 'Needs attention', defaultTarget: 'open-primary-session',
                    sessionCount: 1, activity: 'needsYou',
                },
                expanded: { title: 'Active sessions', rows: [] },
            },
            policy: resolveDesktopOverlayPolicy({ desktopOverlayEnabled: true }),
        });

        const { default: DesktopSettingsRoute } = await import('@/app/(app)/settings/desktop');
        routeState.outlet = React.createElement(DesktopSettingsRoute);

        const { default: SettingsLayoutRoute } = await import('@/app/(app)/settings/_layout');
        const screen = await renderScreen(React.createElement(SettingsLayoutRoute));
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
        expect(screen.findByTestId('settings-desktop-bot-conversation-presentation')).toBeTruthy();
        expect(screen.findByTestId('settings-desktop-overlay-visibility-mode')).toBeTruthy();
    });
});

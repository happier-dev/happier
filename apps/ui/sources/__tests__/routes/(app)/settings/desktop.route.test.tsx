/** @vitest-environment jsdom */
import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { DesktopActivityOverlayWindowStatePayload } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createSecretSettingsTestHarness, type SecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { resolveDesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';

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

vi.mock('@/utils/platform/platform', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/platform')>(),
    isRunningOnMac: () => isRunningOnMacMock(),
}));

vi.mock('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge', () => ({
    getDesktopActivityOverlayWindowState: () => getDesktopActivityOverlayWindowStateMock(),
    listenDesktopActivityOverlayWindowState: (handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) =>
        listenDesktopActivityOverlayWindowStateMock(handler),
}));

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const originalState = storage.getState();
const originalAuth = getCurrentAuth();

describe('/settings/desktop route', () => {
    let account: SecretSettingsTestHarness;
    // The settings shell's cold module graph is large; load it once here so that one-time cost is
    // not charged to the first test's own timeout (it timed out under load). The tests' own
    // `await import` calls then reuse these modules.
    beforeAll(async () => {
        await import('@/app/(app)/settings/desktop');
        await import('@/app/(app)/settings/_layout');
    }, 300_000);

    beforeEach(async () => {
        const secureStorage = createDesktopSecureStorageBoundary();
        let callbackId = 0;
        vi.stubGlobal('__TAURI_INTERNALS__', {
            invoke: async (command: string, args?: Readonly<Record<string, unknown>>) => {
                if (command === 'desktop_host_get_availability') return {
                    activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' },
                };
                if (command === 'plugin:event|listen') return ++callbackId;
                return secureStorage.invoke(command, args);
            },
            transformCallback: () => ++callbackId,
        });
        vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
        account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        routeState.outlet = null;
        isRunningOnMacMock.mockReset();
        isRunningOnMacMock.mockReturnValue(false);
        getDesktopActivityOverlayWindowStateMock.mockReset();
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(null);
        listenDesktopActivityOverlayWindowStateMock.mockReset();
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});
        storage.setState({ localSettings: {
            ...localSettingsDefaults,
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'attention_only',
            desktopOverlayAlwaysOnTop: true,
            settingsNavSidebarEnabled: true,
            settingsNavSidebarWidthPx: 240,
            devModeEnabled: false,
            uiFontScale: 1,
        } });
    });
    afterEach(async () => {
        standardCleanup();
        await account?.dispose();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        setCurrentAuth(originalAuth);
        storage.setState(originalState, true);
    });
    const renderLayout = (Layout: React.ComponentType) => renderScreen(<InjectedAuthProvider credentials={account.credentials}>
        <Layout />
    </InjectedAuthProvider>);

    it('renders the desktop settings route inside the real settings shell without crashing', async () => {
        const { default: DesktopSettingsRoute } = await import('@/app/(app)/settings/desktop');
        routeState.outlet = React.createElement(DesktopSettingsRoute);

        const { default: SettingsLayoutRoute } = await import('@/app/(app)/settings/_layout');
        const screen = await renderLayout(SettingsLayoutRoute);

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
        const screen = await renderLayout(SettingsLayoutRoute);
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
        expect(screen.findByTestId('settings-desktop-bot-conversation-presentation')).toBeTruthy();
        expect(screen.findByTestId('settings-desktop-overlay-visibility-mode')).toBeTruthy();
    });
});

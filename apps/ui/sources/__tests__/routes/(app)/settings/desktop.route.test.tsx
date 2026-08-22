import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import type { DesktopActivityOverlayWindowStatePayload } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
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
const resetDesktopActivityOverlayPositionMock = vi.hoisted(() => vi.fn(async () => {}));
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

vi.mock('react-native-svg', () => ({
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
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => isRunningOnMacMock(),
}));

vi.mock('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge', () => ({
    getDesktopActivityOverlayWindowState: () => getDesktopActivityOverlayWindowStateMock(),
    listenDesktopActivityOverlayWindowState: (handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) =>
        listenDesktopActivityOverlayWindowStateMock(handler),
    resetDesktopActivityOverlayPosition: () => resetDesktopActivityOverlayPositionMock(),
}));

vi.mock('@/components/settings/desktop/useDesktopAutostart', () => ({
    useDesktopAutostart: () => ({
        supported: true,
        enabled: false,
        loading: false,
        error: null,
        setEnabled: vi.fn(async () => {}),
    }),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    const useLocalSetting = createUseLocalSettingMock({
        values: {
            settingsNavSidebarEnabled: true,
            settingsNavSidebarWidthPx: 240,
            settingsNavSidebarWidthBasisPx: 1440,
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
    beforeEach(() => {
        routeState.outlet = null;
        isRunningOnMacMock.mockReset();
        isRunningOnMacMock.mockReturnValue(false);
        getDesktopActivityOverlayWindowStateMock.mockReset();
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(null);
        listenDesktopActivityOverlayWindowStateMock.mockReset();
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});
        resetDesktopActivityOverlayPositionMock.mockReset();
        localSettingsState.value = {
            ...localSettingsDefaults,
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'attention_only',
            desktopOverlayShowWhenRunning: true,
            desktopOverlayShowWhenAttentionRequired: true,
            desktopOverlayShowWhenReady: true,
            desktopOverlayAlwaysOnTop: true,
            desktopOverlayAutoHideEnabled: true,
            desktopOverlayAutoHideDelayMs: 6000,
            desktopOverlayExpandedBehavior: 'click',
            desktopOverlayInteractiveCollapsed: true,
            desktopOverlayPresentationMode: 'automatic',
            desktopOverlayPlacementMode: 'anchored',
            desktopOverlayAnchor: 'top_center',
            desktopOverlayOffsetX: 0,
            desktopOverlayOffsetY: 0,
            desktopOverlayClickAction: 'expand_overlay',
            desktopOverlayDensity: 'compact',
            desktopOverlayShowSessionCount: true,
            desktopOverlayShowPreviewText: false,
            desktopOverlayCompactStyle: 'pill',
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
            expanded: false,
            model: {
                visible: true,
                isExpanded: false,
                generatedAt: Date.now(),
                collapsed: {
                    title: 'Session One',
                    statusText: 'Needs attention',
                    defaultTarget: 'open-primary-session',
                    sessionCount: 1,
                },
                expanded: {
                    title: 'Active sessions',
                    rows: [],
                },
                window: {
                    collapsed: { width: 340, height: 72 },
                    expanded: { width: 420, height: 220 },
                },
            },
            policy: {
                enabled: true,
                visibilityMode: 'attention_only',
                showWhenRunning: true,
                showWhenAttentionRequired: true,
                showWhenReady: true,
                alwaysOnTop: true,
                autoHideEnabled: true,
                autoHideDelayMs: 6000,
                expandedBehavior: 'click',
                interactiveCollapsed: true,
                presentationMode: 'automatic',
                clickAction: 'expand_overlay',
                density: 'compact',
                compactStyle: 'pill',
                showSessionCount: true,
                showPreviewText: false,
                quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
                placementMode: 'anchored',
                anchor: 'top_center',
                offsetX: 0,
                offsetY: 0,
                enableDragReposition: false,
                lockPosition: true,
            },
            window: {
                collapsed: { width: 340, height: 72 },
                expanded: { width: 420, height: 220 },
            },
            placementDiagnostics: {
                monitorSource: 'primary',
                effectiveMonitor: { x: 0, y: 0, width: 1512, height: 982 },
                anchor: 'top_center',
                placementMode: 'anchored',
                requestedHostMode: 'floating',
                hostMode: 'floating',
                displayContext: null,
                effectiveOffsetX: 0,
                effectiveOffsetY: 0,
                computedPosition: { x: 756, y: 24 },
            },
        });

        const { default: DesktopSettingsRoute } = await import('@/app/(app)/settings/desktop');
        routeState.outlet = React.createElement(DesktopSettingsRoute);

        const { default: SettingsLayoutRoute } = await import('@/app/(app)/settings/_layout');
        const screen = await renderScreen(React.createElement(SettingsLayoutRoute));
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
        expect(screen.findByTestId('settings-desktop-overlay-presentation-mode')).toBeTruthy();
        expect(screen.findByTestId('settings-desktop-overlay-visibility-mode')).toBeTruthy();
    });
});

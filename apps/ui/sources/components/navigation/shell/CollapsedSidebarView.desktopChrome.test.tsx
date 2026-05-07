import React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const collapsedSidebarState = vi.hoisted(() => ({
    setSidebarCollapsed: vi.fn(),
}));

const desktopWindowBridgeState = vi.hoisted(() => ({
    getDesktopWindowChromePolicy: vi.fn(),
    getDesktopWindowState: vi.fn(),
    listenDesktopWindowState: vi.fn(),
    minimizeDesktopWindow: vi.fn(),
    toggleDesktopWindowMaximize: vi.fn(),
    closeDesktopWindow: vi.fn(),
    startDesktopWindowDragging: vi.fn(),
}));

installNavigationShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useLocalSettingMutable: (key: string) => {
                if (key === 'sidebarCollapsed') {
                    return [true, collapsedSidebarState.setSidebarCollapsed] as const;
                }
                return [null, vi.fn()] as const;
            },
        });
    },
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('./SidebarIcons', () => ({
    SidebarCollapseIcon: () => React.createElement('SidebarCollapseIcon'),
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 56,
}));

vi.mock('@/utils/platform/desktopWindowBridge', () => ({
    getDesktopWindowChromePolicy: () => desktopWindowBridgeState.getDesktopWindowChromePolicy(),
    getDesktopWindowState: () => desktopWindowBridgeState.getDesktopWindowState(),
    listenDesktopWindowState: (handler: (state: { isMaximized: boolean }) => void) =>
        desktopWindowBridgeState.listenDesktopWindowState(handler),
    minimizeDesktopWindow: () => desktopWindowBridgeState.minimizeDesktopWindow(),
    toggleDesktopWindowMaximize: () => desktopWindowBridgeState.toggleDesktopWindowMaximize(),
    closeDesktopWindow: () => desktopWindowBridgeState.closeDesktopWindow(),
    startDesktopWindowDragging: () => desktopWindowBridgeState.startDesktopWindowDragging(),
}));

describe('CollapsedSidebarView desktop chrome', () => {
    beforeEach(() => {
        collapsedSidebarState.setSidebarCollapsed.mockReset();
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockReset();
        desktopWindowBridgeState.getDesktopWindowState.mockReset();
        desktopWindowBridgeState.listenDesktopWindowState.mockReset();
        desktopWindowBridgeState.minimizeDesktopWindow.mockReset();
        desktopWindowBridgeState.toggleDesktopWindowMaximize.mockReset();
        desktopWindowBridgeState.closeDesktopWindow.mockReset();
        desktopWindowBridgeState.startDesktopWindowDragging.mockReset();
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'custom-controls' });
        desktopWindowBridgeState.getDesktopWindowState.mockResolvedValue({ isMaximized: false });
        desktopWindowBridgeState.listenDesktopWindowState.mockResolvedValue(async () => {});
    });

    it('renders collapsed desktop chrome hosts and expands the sidebar', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(
            <CollapsedSidebarView
                desktopWindowControls={<View testID="injected-collapsed-window-controls" />}
                desktopUpdateIndicator={<View testID="injected-collapsed-update-indicator" />}
            />,
        );

        expect(screen.findByTestId('desktop-collapsed-shell-chrome')).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-host')).toBeTruthy();
        expect(screen.findByTestId('desktop-update-indicator-host')).toBeTruthy();
        expect(screen.findByTestId('injected-collapsed-window-controls')).toBeTruthy();
        expect(screen.findByTestId('injected-collapsed-update-indicator')).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(screen.findByTestId('sidebar-expand-button'));
        });

        expect(collapsedSidebarState.setSidebarCollapsed).toHaveBeenCalledWith(false);
    });

    it('exits focus mode through the expand affordance without changing persisted collapse state directly', async () => {
        const onRequestExpand = vi.fn();
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(
            <CollapsedSidebarView
                focusModeActive={true}
                onRequestExpand={onRequestExpand}
            />,
        );

        await act(async () => {
            await pressTestInstanceAsync(screen.findByTestId('sidebar-expand-button'));
        });

        expect(onRequestExpand).toHaveBeenCalledTimes(1);
        expect(collapsedSidebarState.setSidebarCollapsed).not.toHaveBeenCalled();
    });

    it('gives the collapsed expand affordance a translated accessible name', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(<CollapsedSidebarView />);

        expect(screen.findByTestId('sidebar-expand-button')?.props.accessibilityLabel).toBe('common.expand');
    });
});

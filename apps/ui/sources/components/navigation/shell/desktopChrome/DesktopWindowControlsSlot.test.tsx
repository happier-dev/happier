import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const desktopWindowBridgeState = vi.hoisted(() => ({
    invoke: vi.fn(async (_command: string) => true),
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
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                groupped: { background: '#fff' },
                divider: '#ddd',
                surface: '#fff',
                text: '#111',
                textSecondary: '#777',
                header: { tint: '#111' },
                button: { primary: { tint: '#fff' } },
                status: { error: '#f00' },
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => true,
    invokeDesktopHost: (command: string) => command === 'desktop_get_window_chrome_policy'
        ? Promise.resolve({ strategy: 'native-macos-traffic-lights' })
        : desktopWindowBridgeState.invoke(command),
}));

describe('DesktopWindowControlsSlot', () => {
    it('starts dragging when the drag region receives the primary mouse down', async () => {
        const { DesktopWindowControlsSlot } = await import('./DesktopWindowControlsSlot');
        desktopWindowBridgeState.invoke.mockClear();
        const screen = await renderScreen(
            <DesktopWindowControlsSlot enableDragging />,
        );
        const dragRegion = screen.findByTestId('desktop-window-drag-region');
        if (!dragRegion) {
            throw new Error('drag region should be present');
        }

        await act(async () => {
            dragRegion.props.onMouseDown?.({ buttons: 1, detail: 1, target: { closest: () => null } });
        });

        expect(desktopWindowBridgeState.invoke).toHaveBeenCalledWith('desktop_start_window_dragging');
    });

    it('does not attach drag handlers when dragging is disabled', async () => {
        const { DesktopWindowControlsSlot } = await import('./DesktopWindowControlsSlot');
        const screen = await renderScreen(<DesktopWindowControlsSlot />);
        const dragRegion = screen.findByTestId('desktop-window-drag-region');
        if (!dragRegion) {
            throw new Error('drag region should be present');
        }

        expect(dragRegion.props.onPressIn).toBeUndefined();
        expect(dragRegion.props.onMouseDown).toBeUndefined();
    });

    it('double-clicks the reserved traffic-light gap through the same maximize owner as the title strip', async () => {
        const { DesktopWindowControlsSlot } = await import('./DesktopWindowControlsSlot');
        desktopWindowBridgeState.invoke.mockClear();
        const screen = await renderScreen(<DesktopWindowControlsSlot enableDragging />);
        const dragRegion = screen.findByTestId('desktop-window-drag-region');
        if (!dragRegion) throw new Error('drag region should be present');
        await act(async () => {
            dragRegion.props.onMouseDown?.({
                button: 0, buttons: 1, detail: 2,
                target: { closest: () => null },
            });
        });
        expect(desktopWindowBridgeState.invoke).toHaveBeenCalledWith('desktop_toggle_window_maximize');
        expect(desktopWindowBridgeState.invoke).not.toHaveBeenCalledWith('desktop_start_window_dragging');
    });
});

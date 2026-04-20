import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const desktopWindowBridgeState = vi.hoisted(() => ({
    startDragging: vi.fn(),
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

vi.mock('@/utils/platform/desktopWindowBridge', () => ({
    startDesktopWindowDragging: () => desktopWindowBridgeState.startDragging(),
}));

describe('DesktopWindowControlsSlot', () => {
    it('starts dragging when the drag region is pressed in', async () => {
        const { DesktopWindowControlsSlot } = await import('./DesktopWindowControlsSlot');
        const onStartDragging = vi.fn();
        const screen = await renderScreen(
            <DesktopWindowControlsSlot enableDragging onStartDragging={onStartDragging} />,
        );
        const dragRegion = screen.findByTestId('desktop-window-drag-region');
        if (!dragRegion) {
            throw new Error('drag region should be present');
        }

        await act(async () => {
            dragRegion.props.onPressIn?.();
        });

        expect(onStartDragging).toHaveBeenCalledTimes(1);
    });

    it('does not attach drag handlers when dragging is disabled', async () => {
        const { DesktopWindowControlsSlot } = await import('./DesktopWindowControlsSlot');
        const screen = await renderScreen(<DesktopWindowControlsSlot />);
        const dragRegion = screen.findByTestId('desktop-window-drag-region');
        if (!dragRegion) {
            throw new Error('drag region should be present');
        }

        expect(dragRegion.props.onPressIn).toBeUndefined();
    });
});

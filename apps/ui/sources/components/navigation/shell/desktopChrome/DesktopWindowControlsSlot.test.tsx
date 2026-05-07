import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('DesktopWindowControlsSlot', () => {
    it('starts dragging when the drag region is pressed in', async () => {
        const { DesktopWindowControlsSlot } = await import('./DesktopWindowControlsSlot');
        const onStartDragging = vi.fn();
        const screen = await renderScreen(
            <DesktopWindowControlsSlot enableDragging onStartDragging={onStartDragging} />,
        );
        const dragRegion = screen.findByTestId('desktop-window-drag-region');
        expect(dragRegion).toBeTruthy();

        await act(async () => {
            dragRegion?.props.onPressIn?.();
        });

        expect(onStartDragging).toHaveBeenCalledTimes(1);
    });

    it('does not attach drag handlers when dragging is disabled', async () => {
        const { DesktopWindowControlsSlot } = await import('./DesktopWindowControlsSlot');
        const screen = await renderScreen(<DesktopWindowControlsSlot />);
        const dragRegion = screen.findByTestId('desktop-window-drag-region');

        expect(dragRegion?.props.onPressIn).toBeUndefined();
    });
});

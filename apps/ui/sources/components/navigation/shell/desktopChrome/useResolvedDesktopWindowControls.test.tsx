import React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';
import { useResolvedDesktopWindowControls } from './useResolvedDesktopWindowControls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
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

function ResolvedDesktopWindowControlsHarness(props: Readonly<{
    variant: 'expanded' | 'collapsed';
    desktopWindowControls?: React.ReactNode;
}>) {
    const controls = useResolvedDesktopWindowControls({
        variant: props.variant,
        desktopWindowControls: props.desktopWindowControls,
        hasDesktopWindowControlsOverride: Object.prototype.hasOwnProperty.call(props, 'desktopWindowControls'),
    });

    return <>{controls}</>;
}

describe('useResolvedDesktopWindowControls', () => {
    beforeEach(() => {
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockReset();
        desktopWindowBridgeState.getDesktopWindowState.mockReset();
        desktopWindowBridgeState.listenDesktopWindowState.mockReset();
        desktopWindowBridgeState.minimizeDesktopWindow.mockReset();
        desktopWindowBridgeState.toggleDesktopWindowMaximize.mockReset();
        desktopWindowBridgeState.closeDesktopWindow.mockReset();
        desktopWindowBridgeState.startDesktopWindowDragging.mockReset();
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'none' });
        desktopWindowBridgeState.getDesktopWindowState.mockResolvedValue({ isMaximized: false });
        desktopWindowBridgeState.listenDesktopWindowState.mockResolvedValue(async () => {});
    });

    it('returns no controls when the desktop strategy is none', async () => {
        const screen = await renderScreen(<ResolvedDesktopWindowControlsHarness variant="expanded" />);

        await act(async () => {
            await Promise.resolve();
        });

        expect(screen.findAllByTestId('desktop-window-controls-slot')).toHaveLength(0);
        expect(desktopWindowBridgeState.listenDesktopWindowState).not.toHaveBeenCalled();
    });

    it('uses injected controls without consulting the bridge', async () => {
        const screen = await renderScreen(
            <ResolvedDesktopWindowControlsHarness
                variant="expanded"
                desktopWindowControls={<View testID="injected-window-controls" />}
            />,
        );

        expect(screen.findByTestId('injected-window-controls')).toBeTruthy();
        expect(desktopWindowBridgeState.getDesktopWindowChromePolicy).not.toHaveBeenCalled();
    });

    it('renders stacked custom-controls for the collapsed host', async () => {
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'custom-controls' });

        const screen = await renderScreen(<ResolvedDesktopWindowControlsHarness variant="collapsed" />);

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        const minimizeButton = screen.findByTestId('desktop-window-controls-minimize');
        const controlsGroup = minimizeButton?.parent;

        expect(minimizeButton).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-toggle-maximize')).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-close')).toBeTruthy();
        expect(controlsGroup?.props.style).toEqual(
            expect.objectContaining({ flexDirection: 'column' }),
        );
    });
});

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { useResolvedDesktopWindowControls } from './useResolvedDesktopWindowControls';

import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

    return React.createElement(React.Fragment, null, controls);
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
                desktopWindowControls={React.createElement('View', { testID: 'injected-window-controls' })}
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
        if (!minimizeButton) {
            throw new Error('minimize button should be present');
        }
        const controlsGroup = minimizeButton.parent;
        if (!controlsGroup) {
            throw new Error('controls group should be present');
        }

        expect(minimizeButton).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-toggle-maximize')).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-close')).toBeTruthy();
        expect(controlsGroup.props.style).toEqual(
            expect.objectContaining({ flexDirection: 'column' }),
        );
    });
});

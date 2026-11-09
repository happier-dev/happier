import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';
import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { setDesktopNativeTitleBar } from '@/utils/platform/desktopWindowBridge';
import { useDesktopWindowChromePolicy } from '@/hooks/ui/useDesktopWindowChromePolicy';
import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { View } from 'react-native';
import { useResolvedDesktopWindowControls } from './useResolvedDesktopWindowControls';


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let observedDrag: ReturnType<typeof useDesktopWindowDragMouseProps> = {};
let observedPolicy: ReturnType<typeof useDesktopWindowChromePolicy> = { strategy: 'none' };

const desktopHostState = vi.hoisted(() => ({
    invoke: vi.fn(),
    listen: vi.fn(),
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

// Tauri invocation/events are the platform boundary; the real chrome bridge stays under test.
vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => true,
    invokeDesktopHost: (command: string, args?: Record<string, unknown>) => desktopHostState.invoke(command, args),
    desktopHostKind: () => 'tauri',
    listenDesktopHostEvent: (event: string, handler: (payload: unknown) => void) => desktopHostState.listen(event, handler),
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

function WindowsChromeHarness() {
    const controls = useResolvedDesktopWindowControls({ variant: 'expanded' });
    const drag = useDesktopWindowDragMouseProps();
    const policy = useDesktopWindowChromePolicy();
    observedDrag = drag;
    observedPolicy = policy;
    return <>{controls}<View testID="policy-probe" accessibilityState={{ checked: policy.useNativeTitleBar }} /><View testID="drag-probe" {...drag} /></>;
}

describe('useResolvedDesktopWindowControls', () => {
    beforeEach(() => {
        desktopHostState.invoke.mockReset();
        desktopHostState.listen.mockReset();
        desktopHostState.invoke.mockResolvedValue({ strategy: 'none' });
        desktopHostState.listen.mockResolvedValue(async () => {});
    });

    it('returns no controls when the desktop strategy is none', async () => {
        const screen = await renderScreen(<ResolvedDesktopWindowControlsHarness variant="expanded" />);

        await act(async () => {
            await Promise.resolve();
        });

        expect(screen.findAllByTestId('desktop-window-controls-slot')).toHaveLength(0);
        expect(desktopHostState.listen).not.toHaveBeenCalled();
    });

    it('uses injected controls without consulting the bridge', async () => {
        const screen = await renderScreen(
            <ResolvedDesktopWindowControlsHarness
                variant="expanded"
                desktopWindowControls={React.createElement('View', { testID: 'injected-window-controls' })}
            />,
        );

        expect(screen.findByTestId('injected-window-controls')).toBeTruthy();
        expect(desktopHostState.invoke).not.toHaveBeenCalled();
    });

    it('renders stacked custom-controls for the collapsed host', async () => {
        desktopHostState.invoke.mockImplementation(async (command: string) => command === 'desktop_get_window_chrome_policy'
            ? { strategy: 'custom-controls' }
            : { isMaximized: false, isFullscreen: false });

        const screen = await renderScreen(<ResolvedDesktopWindowControlsHarness variant="collapsed" />);

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        const minimizeButton = screen.findHostByTestId('desktop-window-controls-minimize');
        if (!minimizeButton) {
            throw new Error('minimize button should be present');
        }
        expect(minimizeButton).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-toggle-maximize')).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-close')).toBeTruthy();
    });

    it('releases the traffic-light inset in fullscreen and restores it on exit', async () => {
        desktopHostState.invoke.mockImplementation(async (command: string) => command === 'desktop_get_window_chrome_policy'
            ? { strategy: 'native-macos-traffic-lights' }
            : { isMaximized: false, isFullscreen: false });
        let updateState: ((state: unknown) => void) | undefined;
        const unlisten = vi.fn();
        desktopHostState.listen.mockImplementation(async (_event: string, handler: (state: unknown) => void) => {
            updateState = handler;
            return unlisten;
        });
        const screen = await renderScreen(<ResolvedDesktopWindowControlsHarness variant="expanded" />);
        await act(async () => { await Promise.resolve(); });
        expect(screen.findAllByTestId('desktop-window-controls-slot')).toHaveLength(1);
        await act(async () => { updateState?.({ isMaximized: false, isFullscreen: true }); });
        expect(screen.findAllByTestId('desktop-window-controls-slot')).toHaveLength(0);
        await act(async () => { updateState?.({ isMaximized: false, isFullscreen: false }); });
        expect(screen.findAllByTestId('desktop-window-controls-slot')).toHaveLength(1);
        await screen.unmount();
        expect(unlisten).toHaveBeenCalledOnce();
    });
    it.each([false, true])('projects the native owner after a change (restart required: %s)', async (restartRequired) => {
        let strategy = 'custom-controls';
        let useNativeTitleBar = false;
        desktopHostState.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_set_native_title_bar') {
                useNativeTitleBar = args?.useNativeTitleBar === true;
                if (!restartRequired) strategy = useNativeTitleBar ? 'native-windows-frame' : 'custom-controls';
            }
            if (command === 'desktop_get_window_chrome_policy' || command === 'desktop_set_native_title_bar') {
                return { strategy, useNativeTitleBar, canSetNativeTitleBar: true,
                    nativeTitleBarRestartRequired: restartRequired && useNativeTitleBar };
            }
            return { isMaximized: false, isFullscreen: false };
        });
        const screen = await renderScreen(<WindowsChromeHarness />);
        expect(screen.findByTestId('desktop-window-controls-minimize')).toBeTruthy();
        expect(observedDrag.onMouseDown).toBeTypeOf('function');
        await act(async () => { await setDesktopNativeTitleBar(true); });
        expect(observedPolicy.useNativeTitleBar).toBe(true);
        expect(Boolean(screen.findByTestId('desktop-window-controls-minimize'))).toBe(restartRequired);
        expect(typeof observedDrag.onMouseDown).toBe(restartRequired ? 'function' : 'undefined');
        await act(async () => { await setDesktopNativeTitleBar(false); });
        expect(observedPolicy.useNativeTitleBar).toBe(false);
        expect(screen.findByTestId('desktop-window-controls-minimize')).toBeTruthy();
    });

});

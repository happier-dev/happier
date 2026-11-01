import React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';
import { useResolvedDesktopWindowControls } from './useResolvedDesktopWindowControls';
import { Switch } from '@/components/ui/forms/Switch';
import { DesktopWindowChromeSetting } from '@/components/settings/desktop/DesktopWindowChromeSetting';
import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';

const native = vi.hoisted(() => ({
    strategy: 'none', supported: false, persistenceError: false, failWrite: false,
    invoke: vi.fn(),
}));
installNavigationShellCommonModuleMocks();
// Native IPC is the system boundary; policy normalization, observers and consumers stay real.
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => true,
    invokeTauri: (command: string, args?: Record<string, unknown>) => native.invoke(command, args),
    listenTauriEvent: async () => () => {},
}));

function Harness(props: Readonly<{
    variant: 'expanded' | 'collapsed'; desktopWindowControls?: React.ReactNode;
}>) {
    const controls = useResolvedDesktopWindowControls({
        ...props,
        hasDesktopWindowControlsOverride: Object.prototype.hasOwnProperty.call(props, 'desktopWindowControls'),
    });
    const drag = useDesktopWindowDragMouseProps();
    return <>{controls}<DesktopWindowChromeSetting /><View testID="drag-probe" {...drag} /></>;
}

function policy() {
    return {
        strategy: native.strategy,
        ...(native.supported ? { canSetNativeTitleBar: true } : {}),
        ...(native.persistenceError ? { nativeTitleBarPersistenceError: true } : {}),
    };
}

describe('desktop window chrome consumers', () => {
    beforeEach(() => {
        native.strategy = 'none'; native.supported = false;
        native.persistenceError = false; native.failWrite = false;
        native.invoke.mockReset();
        native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_get_window_chrome_policy') return policy();
            if (command === 'desktop_get_window_state') return { isMaximized: false };
            if (command === 'desktop_set_native_title_bar') {
                if (native.failWrite) throw new Error('OS rejected the change');
                native.strategy = args?.useNativeTitleBar ? 'native-windows-frame' : 'custom-controls';
                return policy();
            }
            return true;
        });
    });

    it('keeps controls and the Windows-only preference absent on unsupported hosts', async () => {
        const screen = await renderScreen(<Harness variant="expanded" />);
        expect(screen.findByTestId('desktop-window-controls-slot')).toBeNull();
        expect(screen.findByTestId('settings-desktop-native-title-bar')).toBeNull();
    });

    it('preserves injected controls', async () => {
        const screen = await renderScreen(<Harness variant="expanded" desktopWindowControls={<View testID="injected" />} />);
        expect(screen.findByTestId('injected')).toBeTruthy();
    });

    it.each(['expanded', 'collapsed'] as const)('switches %s controls and drag regions together without remounting', async (variant) => {
        native.strategy = 'custom-controls'; native.supported = true;
        const screen = await renderScreen(<Harness variant={variant} />);
        expect(screen.findByTestId('desktop-window-controls-minimize')).toBeTruthy();
        expect(screen.findByTestId('drag-probe')?.props.onMouseDown).toBeTypeOf('function');
        const toggle = () => screen.findByType(Switch).props;
        await act(async () => { await toggle().onValueChange(true); });
        expect(toggle().value).toBe(true);
        expect(screen.findByTestId('desktop-window-controls-slot')).toBeNull();
        expect(screen.findByTestId('drag-probe')?.props.onMouseDown).toBeUndefined();
        await act(async () => { await toggle().onValueChange(false); });
        expect(toggle().value).toBe(false);
        expect(screen.findByTestId('desktop-window-controls-minimize')).toBeTruthy();
        expect(screen.findByTestId('drag-probe')?.props.onMouseDown).toBeTypeOf('function');
    });

    it('preserves the effective mode on a native failure and allows retry', async () => {
        native.strategy = 'custom-controls'; native.supported = true; native.failWrite = true;
        const screen = await renderScreen(<Harness variant="expanded" />);
        const toggle = () => screen.findByType(Switch).props;
        await act(async () => { await toggle().onValueChange(true); });
        expect(toggle().value).toBe(false);
        expect(screen.findByTestId('desktop-window-controls-minimize')).toBeTruthy();
        native.failWrite = false;
        await act(async () => { await toggle().onValueChange(true); });
        expect(toggle().value).toBe(true);
    });

    it('keeps native macOS traffic lights without custom buttons or a Windows switch', async () => {
        native.strategy = 'native-macos-traffic-lights';
        const screen = await renderScreen(<Harness variant="expanded" />);
        expect(screen.findByTestId('desktop-window-controls-slot')).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-minimize')).toBeNull();
        expect(screen.findByTestId('settings-desktop-native-title-bar')).toBeNull();
    });
});

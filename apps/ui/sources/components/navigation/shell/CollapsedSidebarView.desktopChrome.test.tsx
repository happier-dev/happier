import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
                status: { error: '#f00' },
            },
        },
    });
});

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

function styleListHasExplicitFallbackDimensions(style: unknown, dimensions: Readonly<{ width: number; height: number }>): boolean {
    if (!Array.isArray(style)) return false;
    return style.some((item) => {
        if (!item || typeof item !== 'object') return false;
        const record = item as Record<string, unknown>;
        return record.width === dimensions.width && record.height === dimensions.height;
    });
}

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

    it('renders the collapsed desktop chrome hosts and expands the sidebar', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const collapsedSidebarProps = {
            desktopWindowControls: React.createElement('View', { testID: 'injected-collapsed-window-controls' }),
            desktopUpdateIndicator: React.createElement('View', { testID: 'injected-collapsed-update-indicator' }),
        } as React.ComponentProps<typeof CollapsedSidebarView> & {
            desktopWindowControls: React.ReactNode;
            desktopUpdateIndicator: React.ReactNode;
        };
        const screen = await renderScreen(<CollapsedSidebarView {...collapsedSidebarProps} />);

        expect(screen.findByTestId('desktop-collapsed-shell-chrome')).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-host')).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-slot')).toBeTruthy();
        expect(screen.findByTestId('desktop-window-drag-region')).toBeTruthy();
        expect(screen.findByTestId('injected-collapsed-window-controls')).toBeTruthy();
        expect(screen.findByTestId('injected-collapsed-update-indicator')).toBeTruthy();
        expect(screen.findAllByTestId('collapsed-sidebar-home-button')).toHaveLength(0);

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
    }, 120_000);

    it('renders bridge-backed collapsed custom controls without horizontal overflow assumptions', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(<CollapsedSidebarView />);

        await act(async () => {
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

    // The rail is the sidebar's CLOSED state, so its button opens rather than closes. It used to
    // render the collapse glyph anyway — the same drawing the expanded chrome shows — so the control
    // looked identical whichever state you were in.
    it('shows the expand glyph on the rail, not the collapse one', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(<CollapsedSidebarView />);

        const expandButton = screen.findByTestId('sidebar-expand-button');
        expect(expandButton?.findByType('Icon' as never).props.name).toBe('sidebar-left-open');
    });
});

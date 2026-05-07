import React from 'react';
import { View } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const desktopWindowBridgeState = vi.hoisted(() => ({
    startDesktopWindowDragging: vi.fn(),
}));

const itemRowActionsState = vi.hoisted(() => ({
    lastActionIds: [] as string[],
}));

installNavigationShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            View: 'View',
            Text: 'Text',
        });
    },
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/navigation/ConnectionStatusControl', () => ({
    ConnectionStatusControl: 'ConnectionStatusControl',
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: {
        actions: Array<{ id: string }>;
        renderOverflowTrigger?: (params: {
            open: boolean;
            toggle: () => void;
            testID: string;
            accessibilityLabel: string;
            accessibilityHint: string;
        }) => React.ReactNode;
    }) => {
        itemRowActionsState.lastActionIds = props.actions.map((action) => action.id);
        return React.createElement(
            View,
            { testID: 'desktop-sidebar-item-actions' },
            props.renderOverflowTrigger?.({
                open: false,
                toggle: vi.fn(),
                testID: 'sidebar-header-actions-overflow',
                accessibilityLabel: 'More actions',
                accessibilityHint: 'Open more actions',
            }),
        );
    },
}));

vi.mock('@/utils/platform/desktopWindowBridge', () => ({
    startDesktopWindowDragging: () => desktopWindowBridgeState.startDesktopWindowDragging(),
}));

function requireTestInstance(node: ReactTestInstance | null, label: string): ReactTestInstance {
    expect(node, `${label} should be present`).toBeTruthy();
    return node!;
}

function directChildTestIDs(instance: ReactTestInstance): string[] {
    return instance.children
        .filter((child): child is ReactTestInstance => typeof child === 'object' && child != null && 'props' in child)
        .map((child) => child.props.testID)
        .filter((testID): testID is string => typeof testID === 'string');
}

describe('DesktopSidebarChrome', () => {
    beforeEach(() => {
        desktopWindowBridgeState.startDesktopWindowDragging.mockReset();
        itemRowActionsState.lastActionIds = [];
    });

    it('places utility controls above the branded sidebar row', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                onPressBack={vi.fn()}
                onPressForward={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                topUtilityActions={[{
                    id: 'settings',
                    title: 'settings.title',
                    inlineTestID: 'nav-settings',
                    icon: 'cog-outline',
                    onPress: vi.fn(),
                }]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
                desktopUpdateIndicator={<View testID="injected-desktop-update-indicator" />}
            />,
        );

        const chrome = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome'), 'desktop chrome');
        const controlsRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-controls-row'), 'controls row');
        const contentRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-content-row'), 'content row');
        const brandGroup = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-brand-group'), 'brand group');
        const actionsRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-actions-row'), 'actions row');

        expect(chrome.children[0]).toBe(controlsRow);
        expect(chrome.children[1]).toBe(contentRow);
        expect(directChildTestIDs(screen.findByTestId('desktop-sidebar-chrome-utility-row')!)).toEqual([
            'sidebar-back-button',
            'sidebar-forward-button',
            'nav-settings',
            'sidebar-collapse-button',
        ]);
        expect(contentRow.children).toEqual([brandGroup, actionsRow]);
        expect(brandGroup.findByProps({ accessibilityLabel: 'common.home' })).toBeTruthy();
        expect(actionsRow.findAll((child) => child.props?.testID === 'desktop-update-indicator-host')).toHaveLength(1);
    });

    it('starts window dragging from non-interactive sidebar top strip clicks', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                onPressBack={vi.fn()}
                onPressForward={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const controlsRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-controls-row'), 'controls row');
        const preventDefault = vi.fn();
        controlsRow.props.onMouseDown?.({
            buttons: 1,
            preventDefault,
            target: { closest: vi.fn(() => null) },
        });

        expect(controlsRow.props['data-tauri-drag-region']).toBe(true);
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(desktopWindowBridgeState.startDesktopWindowDragging).toHaveBeenCalledTimes(1);
    });

    it('marks unavailable browser history controls disabled without removing them', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                onPressBack={vi.fn()}
                onPressForward={vi.fn()}
                canNavigateBack={false}
                canNavigateForward={true}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const backButton = requireTestInstance(screen.findByTestId('sidebar-back-button'), 'back button');
        const forwardButton = requireTestInstance(screen.findByTestId('sidebar-forward-button'), 'forward button');

        expect(backButton.props.disabled).toBe(true);
        expect(backButton.props.accessibilityState).toEqual({ disabled: true });
        expect(forwardButton.props.disabled).toBe(false);
        expect(forwardButton.props.accessibilityState).toEqual({ disabled: false });
    });

    it('keeps top utility actions out of the content action row when window controls are active', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                environmentBadge={null}
                headerActions={[
                    { id: 'inbox', title: 'Inbox', inlineTestID: 'sidebar-inbox-button', icon: 'mail-outline', onPress: vi.fn() },
                    { id: 'settings', title: 'Settings', inlineTestID: 'nav-settings', icon: 'cog-outline', onPress: vi.fn() },
                    { id: 'newSession', title: 'New', inlineTestID: 'nav-new-session', icon: 'add-outline', onPress: vi.fn() },
                ]}
                topUtilityActions={[
                    { id: 'inbox', title: 'Inbox', inlineTestID: 'sidebar-inbox-button', icon: 'mail-outline', onPress: vi.fn() },
                    { id: 'settings', title: 'Settings', inlineTestID: 'nav-settings', icon: 'cog-outline', onPress: vi.fn() },
                ]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        expect(itemRowActionsState.lastActionIds).toEqual(['newSession']);
    });
});

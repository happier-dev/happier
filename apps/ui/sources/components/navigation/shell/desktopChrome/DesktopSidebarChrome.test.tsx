import React from 'react';
import { View } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            dark: false,
            colors: {
                header: { tint: '#111' },
                groupped: { background: '#fff' },
                divider: '#ddd',
                surface: '#fff',
                text: '#111',
                textSecondary: '#777',
                button: { primary: { tint: '#fff' } },
                status: { error: '#f00' },
            },
        },
    });
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/navigation/ConnectionStatusControl', () => ({
    ConnectionStatusControl: 'ConnectionStatusControl',
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: () => React.createElement(View, { testID: 'desktop-sidebar-item-actions' }),
}));

function requireTestInstance(node: ReactTestInstance | null, label: string): ReactTestInstance {
    expect(node, `${label} should be present`).toBeTruthy();
    return node!;
}

describe('DesktopSidebarChrome', () => {
    it('places the branded sidebar row below the desktop window controls row', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' })}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
                desktopUpdateIndicator={<View testID="injected-desktop-update-indicator" />}
            />,
        );

        const chrome = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome'), 'desktop chrome');
        const controlsRow = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-controls-row'),
            'desktop controls row',
        );
        const contentRow = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-content-row'),
            'desktop content row',
        );
        const brandGroup = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-brand-group'),
            'desktop brand group',
        );
        const actionsRow = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-actions-row'),
            'desktop actions row',
        );

        expect(chrome.children[0]).toBe(controlsRow);
        expect(chrome.children[1]).toBe(contentRow);
        expect(contentRow.children[0]).toBe(brandGroup);
        expect(contentRow.children[1]).toBe(actionsRow);
        expect(brandGroup.findByProps({ accessibilityLabel: 'common.home' })).toBeTruthy();
        expect(brandGroup.findByType('ConnectionStatusControl' as any)).toBeTruthy();
        expect(actionsRow.findAll((child) => child.props?.testID === 'desktop-update-indicator-host')).toHaveLength(1);
    });

    it('does not keep an empty top row when no desktop window controls are active', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' })}
                popoverBoundaryRef={{ current: null }}
                desktopUpdateIndicator={<View testID="injected-desktop-update-indicator" />}
            />,
        );

        expect(screen.findAllByTestId('desktop-sidebar-chrome-controls-row')).toHaveLength(0);
        expect(screen.findByTestId('desktop-sidebar-chrome-content-row')).toBeTruthy();
    });
});

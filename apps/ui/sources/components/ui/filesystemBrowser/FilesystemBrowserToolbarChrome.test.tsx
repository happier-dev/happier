import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const popoverCapture = vi.hoisted(() => ({
    lastProps: null as Record<string, any> | null,
}));

vi.mock('@/components/ui/popover', () => {
    const React = require('react');
    return {
        usePopoverBoundaryRef: () => null,
        PopoverScope: (props: any) => React.createElement(React.Fragment, null, props.children),
        Popover: (props: any) => {
            popoverCapture.lastProps = props;
            if (!props.open) return null;
            return React.createElement(
                'Popover',
                props,
                props.children({
                    maxHeight: 400,
                    maxWidth: 400,
                    placement: props.placement === 'auto' ? 'bottom' : (props.placement ?? 'bottom'),
                }),
            );
        },
    };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: (value: any) => value?.ios ?? value?.default,
        },
        AppState: {
            addEventListener: () => ({ remove: () => {} }),
        },
        InteractionManager: {
            runAfterInteractions: () => {},
        },
        useWindowDimensions: () => ({ width: 320, height: 800 }),
        StyleSheet: {
            absoluteFill: {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
            },
        },
        View: (props: any) => React.createElement('View', props, props.children),
        Text: (props: any) => React.createElement('Text', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                divider: '#ddd',
                surface: '#fff',
                surfacePressedOverlay: '#eee',
                text: '#111',
                textSecondary: '#777',
                textLink: '#00f',
                input: { placeholder: '#999' },
                button: { secondary: { tint: '#333' } },
                deleteAction: '#f00',
            },
            dark: false,
        },
    });
});

vi.mock('@/components/ui/overlays/FloatingOverlay', () => {
    const React = require('react');
    return {
        FloatingOverlay: (props: any) => React.createElement('FloatingOverlay', props, props.children),
    };
});

vi.mock('@/components/ui/text/Text', async () => {
    const React = require('react');
    return {
        Text: (props: any) => React.createElement('Text', props, props.children),
        TextInput: React.forwardRef((props: any, ref: any) => React.createElement('TextInput', { ...props, ref }, props.children)),
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('FilesystemBrowserToolbarChrome', () => {
    beforeEach(() => {
        popoverCapture.lastProps = null;
    });

    it('uses a matching toolbar-button anchor overlay for the overflow trigger', async () => {
        const { FilesystemBrowserToolbarChrome } = await import('./FilesystemBrowserToolbarChrome');
        const { FileBrowserToolbarIconButton } = await import('./FileBrowserToolbar');

        const screen = await renderScreen(
            <FilesystemBrowserToolbarChrome
                testID="toolbar"
                searchTestID="toolbar-search"
                searchValue=""
                onSearchValueChange={vi.fn()}
                overflowTriggerTestID="toolbar-overflow"
                actions={[
                    {
                        id: 'refresh',
                        priority: 3,
                        order: 0,
                        icon: React.createElement('RefreshIcon'),
                        menuIcon: 'arrow-clockwise',
                        accessibilityLabel: 'Refresh',
                        onPress: vi.fn(),
                    },
                    {
                        id: 'create-file',
                        priority: 2,
                        order: 1,
                        icon: React.createElement('CreateFileIcon'),
                        menuIcon: 'file',
                        accessibilityLabel: 'Create file',
                        onPress: vi.fn(),
                    },
                    {
                        id: 'create-folder',
                        priority: 1,
                        order: 2,
                        icon: React.createElement('CreateFolderIcon'),
                        menuIcon: 'folder',
                        accessibilityLabel: 'Create folder',
                        onPress: vi.fn(),
                    },
                ]}
                buildOverflowItems={(hiddenActions) => hiddenActions.map((action) => ({
                    id: action.id,
                    title: action.accessibilityLabel,
                    icon: action.menuIcon,
                    onPress: action.onPress,
                }))}
            />,
        );

        const toolbar = screen.findByTestId('toolbar');
        expect(toolbar).toBeTruthy();

        await act(async () => {
            toolbar?.props.onLayout?.({ nativeEvent: { layout: { width: 320, height: 42, x: 0, y: 0 } } });
        });

        await screen.pressByTestIdAsync('toolbar-overflow');

        expect(popoverCapture.lastProps?.backdrop?.anchorOverlay?.type).toBe(FileBrowserToolbarIconButton);
        expect(popoverCapture.lastProps?.backdrop?.anchorOverlay?.props?.testID).toBeUndefined();
    });
});

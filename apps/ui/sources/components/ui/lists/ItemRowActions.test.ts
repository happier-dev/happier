import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const mockEnv = vi.hoisted(() => ({
    iconsRenderAsText: false,
}));

const popoverCapture = vi.hoisted(() => ({
    lastProps: null as Record<string, any> | null,
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => {
    const React = require('react');
    return {
        FloatingOverlay: (props: any) => React.createElement('FloatingOverlay', props, props.children),
    };
});

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

vi.mock('@expo/vector-icons', () => {
    const React = require('react');
    return {
        Ionicons: (props: any) => (
            mockEnv.iconsRenderAsText ? React.createElement(React.Fragment, null, '.') : React.createElement('Ionicons', props, props.children)
        ),
    };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                                select: (m: any) => m?.web ?? m?.default,
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
                                        }
    );
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('ItemRowActions', () => {
    beforeEach(() => {
        popoverCapture.lastProps = null;
    });

    it('invokes overflow actions even when InteractionManager does not run callbacks', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');

        const onEdit = vi.fn();

        const screen = await renderScreen(React.createElement(ItemRowActions, {
            title: 'Profile',
            overflowTriggerTestID: 'row-actions-trigger',
            actions: [
                { id: 'edit', title: 'Edit profile', icon: 'create-outline', onPress: onEdit },
            ],
        }));

        expect(screen.findByTestId('row-actions-trigger')?.props.accessibilityState).toEqual({
            expanded: false,
        });
        expect(screen.findAllByTestId('edit')).toHaveLength(0);

        act(() => {
            screen.pressByTestId('row-actions-trigger');
        });

        expect(screen.findByTestId('row-actions-trigger')?.props.accessibilityState).toEqual({
            expanded: true,
        });
        expect(screen.findByTestId('edit')).toBeTruthy();
        expect(screen.findAllByTestId('edit').length).toBeGreaterThan(0);

        await screen.pressByTestIdAsync('edit');
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(onEdit).toHaveBeenCalledTimes(1);
        expect(screen.findAllByTestId('edit')).toHaveLength(0);
    });

    it('does not render overflow trigger when there are no actions', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');

        const screen = await renderScreen(React.createElement(ItemRowActions, {
            title: 'Profile',
            actions: [],
        }));

        expect(screen.findByTestId('row-actions-trigger')).toBeNull();
        expect(screen.findAllByTestId('row-actions-trigger')).toHaveLength(0);
    });

    it('uses a custom overflow trigger renderer when provided', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');
        const onEdit = vi.fn();

        const screen = await renderScreen(React.createElement(ItemRowActions, {
            title: 'Profile',
            overflowTriggerTestID: 'custom-trigger',
            actions: [
                { id: 'edit', title: 'Edit profile', icon: 'create-outline', onPress: onEdit },
            ],
            renderOverflowTrigger: ({ open, toggle, testID, accessibilityLabel, accessibilityHint }) => React.createElement(
                'Pressable',
                {
                    testID,
                    accessibilityLabel,
                    accessibilityHint,
                    accessibilityState: { expanded: open },
                    onPress: toggle,
                },
                React.createElement('CustomTrigger', {
                    open,
                    testID: open ? 'custom-trigger-open' : 'custom-trigger-closed',
                }),
            ),
        }));

        const trigger = screen.findByTestId('custom-trigger');
        expect(trigger).toBeTruthy();
        expect(trigger?.props?.accessibilityState).toEqual({ expanded: false });
        expect(screen.findByTestId('custom-trigger-closed')).toBeTruthy();

        await screen.pressByTestIdAsync('custom-trigger');

        const customTrigger = screen.findByTestId('custom-trigger-open');
        expect(customTrigger?.props?.open).toBe(true);
        expect(screen.findAllByTestId('edit').length).toBeGreaterThan(0);
    });

    it('passes custom overflow placement, portal alignment, and anchor overlay through to the popover', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');

        const screen = await renderScreen(React.createElement(ItemRowActions as any, {
            title: 'Profile',
            layoutWidthPx: 320,
            compactThreshold: 400,
            overflowTriggerTestID: 'custom-trigger',
            actions: [
                { id: 'edit', title: 'Edit profile', icon: 'create-outline', onPress: vi.fn() },
            ],
            renderOverflowTrigger: ({ open, toggle, testID }: any) => React.createElement(
                'Pressable',
                {
                    testID,
                    accessibilityState: { expanded: open },
                    onPress: toggle,
                },
                React.createElement('CustomTrigger'),
            ),
            overflowPlacement: 'bottom',
            overflowPortal: {
                anchorAlign: 'center',
            },
            renderOverflowAnchorOverlay: () => React.createElement('AnchorOverlay', { testID: 'custom-anchor-overlay' }),
        }));

        await screen.pressByTestIdAsync('custom-trigger');

        expect(popoverCapture.lastProps?.placement).toBe('bottom');
        expect(popoverCapture.lastProps?.portal).toEqual(expect.objectContaining({
            anchorAlign: 'center',
        }));
        expect((popoverCapture.lastProps?.backdrop as Record<string, any> | undefined)?.anchorOverlay).toMatchObject({
            props: expect.objectContaining({
                testID: 'custom-anchor-overlay',
            }),
        });
    });

    it('does not emit raw text nodes under Pressable when row action icons render as text on web', async () => {
        mockEnv.iconsRenderAsText = true;
        const { ItemRowActions } = await import('./ItemRowActions');

        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(React.createElement(ItemRowActions, {
                title: 'Profile',
                overflowTriggerTestID: 'row-actions-trigger',
                actions: [
                    { id: 'edit', title: 'Edit profile', icon: 'create-outline', onPress: vi.fn() },
                ],
            }));

            expect(screen.findByTestId('row-actions-trigger')).toBeTruthy();

            expect(collectUnexpectedRawTextNodes(screen?.tree.toJSON())).toEqual([]);
        } finally {
            mockEnv.iconsRenderAsText = false;
            act(() => {
                screen?.tree.unmount();
            });
        }
    });

    it('does not emit raw text nodes for inline action icons when icons render as text on web', async () => {
        mockEnv.iconsRenderAsText = true;
        const { ItemRowActions } = await import('./ItemRowActions');

        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(React.createElement(ItemRowActions, {
                title: 'Profile',
                compactThreshold: 200,
                actions: [
                    { id: 'favorite', title: 'Favorite', icon: 'star-outline', onPress: vi.fn() },
                ],
            }));

            expect(screen.findByProps({ accessibilityLabel: 'Favorite' })).toBeTruthy();

            expect(collectUnexpectedRawTextNodes(screen?.tree.toJSON())).toEqual([]);
        } finally {
            mockEnv.iconsRenderAsText = false;
            act(() => {
                screen?.tree.unmount();
            });
        }
    });

    it('gives inline icon actions a 44px target and visible web focus ring', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');

        const screen = await renderScreen(React.createElement(ItemRowActions, {
            title: 'Plugin',
            compactThreshold: 200,
            actions: [
                {
                    id: 'disable',
                    title: 'Disable plugin',
                    icon: 'close-circle-outline',
                    inlineTestID: 'disable-plugin',
                    onPress: vi.fn(),
                },
            ],
        }));

        const action = screen.findByTestId('disable-plugin');
        expect(action).toBeTruthy();
        expect(typeof action?.props.style).toBe('function');
        const flatten = (style: unknown) => (Array.isArray(style)
            ? Object.assign({}, ...style.filter(Boolean))
            : (style ?? {})) as Record<string, unknown>;
        const base = flatten(action!.props.style({ pressed: false, focused: false }));
        const focused = flatten(action!.props.style({ pressed: false, focused: true }));
        const hitSlop = typeof action!.props.hitSlop === 'number'
            ? {
                top: action!.props.hitSlop,
                bottom: action!.props.hitSlop,
                left: action!.props.hitSlop,
                right: action!.props.hitSlop,
            }
            : action!.props.hitSlop as { top?: number; bottom?: number; left?: number; right?: number };

        expect(Number(base.width)).toBeGreaterThanOrEqual(44);
        expect(Number(base.height)).toBeGreaterThanOrEqual(44);
        expect(Number(base.width) + Number(hitSlop.left ?? 0) + Number(hitSlop.right ?? 0)).toBeGreaterThanOrEqual(44);
        expect(Number(base.height) + Number(hitSlop.top ?? 0) + Number(hitSlop.bottom ?? 0)).toBeGreaterThanOrEqual(44);
        expect(focused.outlineStyle).toBe('solid');
        expect(focused.outlineWidth).toBeGreaterThanOrEqual(2);
        expect(focused.outlineColor).toBeTruthy();
    });

    it('gives inline icon actions a 48dp Android target', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'android';
        try {
            const { ItemRowActions } = await import('./ItemRowActions');
            const screen = await renderScreen(React.createElement(ItemRowActions, {
                title: 'Plugin',
                compactThreshold: 200,
                actions: [
                    {
                        id: 'disable',
                        title: 'Disable plugin',
                        icon: 'close-circle-outline',
                        inlineTestID: 'disable-plugin-android',
                        onPress: vi.fn(),
                    },
                ],
            }));

            const action = screen.findByTestId('disable-plugin-android');
            expect(action).toBeTruthy();
            const flatten = (style: unknown) => (Array.isArray(style)
                ? Object.assign({}, ...style.filter(Boolean))
                : (style ?? {})) as Record<string, unknown>;
            const base = flatten(action!.props.style({ pressed: false, focused: false }));
            const hitSlop = Number(action!.props.hitSlop ?? 0);
            expect(Number(base.width)).toBeGreaterThanOrEqual(48);
            expect(Number(base.height)).toBeGreaterThanOrEqual(48);
            expect(hitSlop).toBe(0);
            expect(Number(base.width) + (hitSlop * 2)).toBeGreaterThanOrEqual(48);
            expect(Number(base.height) + (hitSlop * 2)).toBeGreaterThanOrEqual(48);
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });
});

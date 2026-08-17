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
                { id: 'edit', title: 'Edit profile', icon: 'pencil-simple', onPress: onEdit },
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
                { id: 'edit', title: 'Edit profile', icon: 'pencil-simple', onPress: onEdit },
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
                { id: 'edit', title: 'Edit profile', icon: 'pencil-simple', onPress: vi.fn() },
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
                    { id: 'edit', title: 'Edit profile', icon: 'pencil-simple', onPress: vi.fn() },
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
                    { id: 'favorite', title: 'Favorite', icon: 'star', onPress: vi.fn() },
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
                    icon: 'x-circle',
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

        // The target is the rendered frame and nothing else. `hitSlop` cannot contribute
        // to it: react-native-web 0.21 implements it only in the legacy `Touchable`
        // export, so on web — which is what the desktop app ships — a slop-declared
        // target is a target that does not exist.
        expect(action!.props.hitSlop).toBeUndefined();
        expect(Number(base.width)).toBeGreaterThanOrEqual(44);
        expect(Number(base.height)).toBeGreaterThanOrEqual(44);
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
                        icon: 'x-circle',
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
            expect(action!.props.hitSlop).toBeUndefined();
            expect(Number(base.width)).toBeGreaterThanOrEqual(48);
            expect(Number(base.height)).toBeGreaterThanOrEqual(48);
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    // A row that owns its own density can opt out of the 44px *drawn* box, but it may not opt out
    // of the touch target. `hitSlop` cannot carry that target — react-native-web ignores it on
    // Pressable — so the press box is a real, larger frame paired with an equal negative margin:
    // the pointer gets the frame, the row still measures the drawn 32.
    it('expands the dense control’s press box without moving the row or overlapping its neighbour', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        const flatten = (style: unknown) => (Array.isArray(style)
            ? Object.assign({}, ...style.filter(Boolean))
            : (style ?? {})) as Record<string, unknown>;
        const DRAWN_SIZE = 32;
        const ROW_GAP = 4;

        try {
            for (const platform of [
                { os: 'web', minimumTargetSize: 44 },
                { os: 'android', minimumTargetSize: 48 },
            ] as const) {
                (Platform as { OS: string }).OS = platform.os;
                const { ItemRowActions } = await import('./ItemRowActions');
                const testIDs = [`dense-a-${platform.os}`, `dense-b-${platform.os}`] as const;
                const screen = await renderScreen(React.createElement(ItemRowActions, {
                    title: 'Sidebar',
                    compactThreshold: 200,
                    actionControlSizePx: DRAWN_SIZE,
                    gap: ROW_GAP,
                    actions: [
                        { id: 'newSession', title: 'New session', icon: 'plus', inlineTestID: testIDs[0], onPress: vi.fn() },
                        { id: 'favorite', title: 'Favorite', icon: 'star', inlineTestID: testIDs[1], onPress: vi.fn() },
                    ],
                }));

                for (const inlineTestID of testIDs) {
                    const action = screen.findByTestId(inlineTestID);
                    expect(action, inlineTestID).toBeTruthy();
                    expect(action!.props.hitSlop, inlineTestID).toBeUndefined();

                    const box = flatten(action!.props.style({ pressed: false, focused: false }));
                    const width = Number(box.width);
                    const height = Number(box.height);
                    // The frame gives back exactly what it took, per side.
                    const expandX = -Number(box.marginHorizontal ?? 0);
                    const expandY = -Number(box.marginVertical ?? 0);

                    // 1. The press box carries the platform floor on the axis that has room.
                    //    Vertical is free: an icon row has no vertical neighbour.
                    expect(height, `${inlineTestID} press height`).toBe(platform.minimumTargetSize);
                    expect(width, `${inlineTestID} press width`).toBeGreaterThan(DRAWN_SIZE);
                    // Dense pointer layout floor, WCAG 2.2 AA SC 2.5.8.
                    expect(width, `${inlineTestID} SC 2.5.8`).toBeGreaterThanOrEqual(24);

                    // 2. The row's layout footprint is unchanged — still the drawn 32.
                    expect(width - (expandX * 2), `${inlineTestID} layout width`).toBe(DRAWN_SIZE);
                    expect(height - (expandY * 2), `${inlineTestID} layout height`).toBe(DRAWN_SIZE);

                    // 3. Adjacent targets tile, never overlap: each reaches `expandX` into the
                    //    shared gap, so two of them may not consume more than the gap itself.
                    //    This is the assertion the previous hitSlop arithmetic could not make.
                    expect(expandX * 2, `${inlineTestID} overlap`).toBeLessThanOrEqual(ROW_GAP);
                }
            }
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });
});

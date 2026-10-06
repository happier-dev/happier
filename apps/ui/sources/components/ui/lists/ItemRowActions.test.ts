import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            // Exercise fallback scheduling when this native boundary never invokes its callback.
            InteractionManager: { runAfterInteractions: () => ({ cancel: () => {} }) },
            useWindowDimensions: () => ({ width: 320, height: 800, scale: 1, fontScale: 1 }),
        });
    },
});

vi.unmock('@/components/ui/icons/Icon');

const vendorIconState = vi.hoisted(() => ({ renderText: false }));

// Keep Icon and its normalization real; only the third-party glyph leaves emit fallback text.
vi.mock('phosphor-react-native/src/icons/DotsThree', () => ({
    DotsThreeIcon: () => vendorIconState.renderText ? '.' : React.createElement('Svg'),
}));
vi.mock('phosphor-react-native/src/icons/Star', () => ({
    StarIcon: () => vendorIconState.renderText ? '.' : React.createElement('Svg'),
}));

describe('ItemRowActions', () => {
    let restoreWebGlobals: (() => void) | undefined;
    beforeEach(() => {
        restoreWebGlobals = withPopoverWebGlobals();
    });
    afterEach(() => restoreWebGlobals?.());

    it('forwards the press event to inline actions so modifier-aware navigation stays centralized', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');
        const onPress = vi.fn();
        const stopPropagation = vi.fn();
        const event = { nativeEvent: { metaKey: true }, stopPropagation };
        const screen = await renderScreen(React.createElement(ItemRowActions, {
            title: 'Navigation',
            compactThreshold: 200,
            actions: [{
                id: 'new-session',
                inlineTestID: 'new-session',
                title: 'New session',
                icon: 'plus',
                onPress,
            }],
        }));

        act(() => screen.findByTestId('new-session')?.props.onPress(event));

        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(onPress).toHaveBeenCalledWith(event);
    });

    it('uses a target-qualified accessible name for a concise inline action title', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');
        const screen = await renderScreen(React.createElement(ItemRowActions, {
            title: 'Home B',
            compactThreshold: 200,
            actions: [{
                id: 'switch-home',
                inlineTestID: 'switch-home',
                title: 'Switch',
                accessibilityLabel: 'Switch: Home B',
                icon: 'arrows-left-right',
                onPress: vi.fn(),
            }],
        }));

        expect(screen.findByTestId('switch-home')?.props.accessibilityLabel).toBe('Switch: Home B');
    });

    it('announces the expanded state owned by an inline popover action', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');
        const screen = await renderScreen(React.createElement(ItemRowActions, {
            title: 'Navigation',
            compactThreshold: 200,
            actions: [{
                id: 'inbox',
                inlineTestID: 'inbox',
                title: 'Inbox',
                icon: 'mailbox',
                expanded: true,
                onPress: vi.fn(),
            }],
        }));

        expect(screen.findByTestId('inbox')?.props.accessibilityState).toEqual({
            expanded: true,
        });
    });

    it('exposes an applied inline choice as a pressed button on web', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');
        const screen = await renderScreen(React.createElement(ItemRowActions, {
            title: 'Width',
            compactThreshold: 200,
            actions: [{
                id: 'width-compact',
                inlineTestID: 'width-compact',
                title: 'Compact',
                icon: 'arrows-left-right',
                selected: true,
                onPress: vi.fn(),
            }],
        }));

        expect(screen.findByTestId('width-compact')?.props['aria-pressed']).toBe(true);
        expect(screen.findByTestId('width-compact')?.props.accessibilityState).toMatchObject({
            selected: true,
        });
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

    it('renders optional action groups as ordered labelled sections without changing ungrouped menus', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');

        const screen = await renderScreen(React.createElement(ItemRowActions, {
            title: 'Release plan',
            overflowTriggerTestID: 'row-actions-trigger',
            actions: [
                {
                    id: 'read',
                    title: 'Read full',
                    icon: 'article',
                    group: { id: 'content', title: 'Read and edit' },
                    onPress: vi.fn(),
                },
                {
                    id: 'move',
                    title: 'Move down',
                    icon: 'arrow-down',
                    group: { id: 'movement', title: 'Movement' },
                    onPress: vi.fn(),
                },
                {
                    id: 'remove',
                    title: 'Remove',
                    icon: 'trash',
                    group: { id: 'destructive', title: 'Remove' },
                    onPress: vi.fn(),
                },
            ],
        }));

        await screen.pressByTestIdAsync('row-actions-trigger');

        const sections = screen.tree.root.findAll(
            (node) => node.type instanceof Function
                && node.type.name === 'ActionListSection',
            { deep: true },
        );
        expect(sections.map((section) => ({
            title: section.props.title,
            ids: section.props.actions.map((action: { id: string }) => action.id),
        }))).toEqual([
            { title: 'Read and edit', ids: ['read'] },
            { title: 'Movement', ids: ['move'] },
            { title: 'Remove', ids: ['remove'] },
        ]);
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

        const { Popover } = await import('@/components/ui/popover');
        const popover = screen.tree.root.findByType(Popover);
        expect(popover.props.placement).toBe('bottom');
        expect(popover.props.portal).toEqual(expect.objectContaining({
            anchorAlign: 'center',
        }));
        expect(popover.props.backdrop?.anchorOverlay).toMatchObject({
            props: expect.objectContaining({
                testID: 'custom-anchor-overlay',
            }),
        });
    });

    it('does not emit raw text nodes under Pressable when the vendor overflow glyph renders text on web', async () => {
        const { getIconFamily, setIconFamily } = await import('@/components/ui/icons/iconFamily');
        const previousFamily = getIconFamily();
        setIconFamily('phosphor');
        vendorIconState.renderText = true;
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

            expect(screen.tree.root.findAllByType('Text' as never).some(node => node.children.includes('.'))).toBe(true);

            expect(collectUnexpectedRawTextNodes(screen?.tree.toJSON())).toEqual([]);
        } finally {
            vendorIconState.renderText = false;
            setIconFamily(previousFamily);
            act(() => {
                screen?.tree.unmount();
            });
        }
    });

    it('does not emit raw text nodes when the vendor inline glyph renders text on web', async () => {
        const { getIconFamily, setIconFamily } = await import('@/components/ui/icons/iconFamily');
        const previousFamily = getIconFamily();
        setIconFamily('phosphor');
        vendorIconState.renderText = true;
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

            expect(screen.tree.root.findAllByType('Text' as never).some(node => node.children.includes('.'))).toBe(true);

            expect(collectUnexpectedRawTextNodes(screen?.tree.toJSON())).toEqual([]);
        } finally {
            vendorIconState.renderText = false;
            setIconFamily(previousFamily);
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

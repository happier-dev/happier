import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const viewport = vi.hoisted(() => ({ width: 320, height: 800 }));
installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            // Exercise fallback scheduling when this native boundary never invokes its callback.
            InteractionManager: { runAfterInteractions: () => ({ cancel: () => {} }) },
            useWindowDimensions: () => ({ ...viewport, scale: 1, fontScale: 1 }),
        });
    },
});

vi.unmock('@/components/ui/icons/Icon');

// Renderer tests have no DOM: only the external Radix hosts are replaced.
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsModuleMock } = await import('@/dev/testkit/mocks/radixCjs');
    return createRadixCjsModuleMock();
});

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
        viewport.width = 320;
        viewport.height = 800;
        restoreWebGlobals = withPopoverWebGlobals();
    });
    afterEach(() => restoreWebGlobals?.());

    it('uses the widget phone sheet with Done and persistent inline choices, then the desktop popover on resize', async () => {
        viewport.width = 390;
        viewport.height = 844;
        const { WidgetGroupMenuButton } = await import('@/components/widgets/group/WidgetGroupMenuButton');
        const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');
        const { Popover } = await import('@/components/ui/popover');
        const setFrame = vi.fn();
        const input: import('@/components/widgets/group/widgetGroupMenu').WidgetGroupMenuInput = {
            group: { kind: 'group', id: 'group', title: 'happier', width: 'full', frameStyle: 'card', dividers: 'hairline', children: [] },
            childTitle: id => id,
            operations: { setWidth: vi.fn(), setFrame, setDividers: vi.fn(), ungroup: vi.fn(), remove: vi.fn(), move: vi.fn(), create: vi.fn() },
            showWidth: false,
            editInputs: undefined, onRename: undefined, onSave: undefined, onAddTo: undefined,
        };
        const screen = await renderScreen(React.createElement(WidgetGroupMenuButton, { input, visible: true, testID: 'group-menu' }));
        expect(screen.tree.root.findAllByType(ModalCardFrame)).toHaveLength(0);
        await screen.pressByTestIdAsync('group-menu.trigger');
        expect(screen.tree.root.findByType(ModalCardFrame).props.presentation).toBe('sheet');
        expect(screen.tree.root.findAllByType(Popover)).toHaveLength(0);
        await screen.pressByTestIdAsync('group-menu.options.frame:plain');
        expect(setFrame).toHaveBeenCalledWith('group', 'plain');
        expect(screen.tree.root.findAllByType(ModalCardFrame)).toHaveLength(1);
        await screen.pressByTestIdAsync('group-menu.done');
        expect(screen.tree.root.findAllByType(ModalCardFrame)).toHaveLength(0);
        await screen.pressByTestIdAsync('group-menu.trigger');
        expect(screen.tree.root.findAllByType(ModalCardFrame)).toHaveLength(1);
        viewport.width = 900;
        await screen.update(React.createElement(WidgetGroupMenuButton, { input, visible: true, testID: 'group-menu' }));
        expect(screen.tree.root.findAllByType(ModalCardFrame)).toHaveLength(0);
        expect(screen.tree.root.findAllByType(Popover)).toHaveLength(1);
        await screen.pressByTestIdAsync('ungroup');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(input.operations.ungroup).toHaveBeenCalledWith('group');
        expect(screen.tree.root.findAllByType(Popover)).toHaveLength(0);
    });

    it('names a group once in its phone sheet, never as a desktop menu title, and words its removal as destructive', async () => {
        viewport.width = 390;
        viewport.height = 844;
        const { WidgetGroupMenuButton } = await import('@/components/widgets/group/WidgetGroupMenuButton');
        const child = (id: string) => ({ kind: 'widget' as const, instance: { v: 1 as const, id, definition: { kind: 'builtin' as const, id: 'changes' }, bindings: {} } });
        const input: import('@/components/widgets/group/widgetGroupMenu').WidgetGroupMenuInput = {
            group: { kind: 'group', id: 'group', title: 'Morning glance', width: 'full', frameStyle: 'card', dividers: 'hairline', children: [child('a'), child('b')] },
            childTitle: id => id,
            operations: { setWidth: vi.fn(), setFrame: vi.fn(), setDividers: vi.fn(), ungroup: vi.fn(), remove: vi.fn(), move: vi.fn(), create: vi.fn() },
            showWidth: false,
            editInputs: undefined, onRename: () => {}, onSave: undefined, onAddTo: undefined,
        };
        const named = (text: string) => text.split('Morning glance').length - 1;
        const screen = await renderScreen(React.createElement(WidgetGroupMenuButton, { input, visible: true, testID: 'group-menu' }));
        await screen.pressByTestIdAsync('group-menu.trigger');
        expect(named(screen.getTextContent())).toBe(1);
        expect(screen.tree.root.findAll(node => node.props.testID === 'removeGroup' && node.props.destructive === true).length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('group-menu.done');
        viewport.width = 900;
        await screen.update(React.createElement(WidgetGroupMenuButton, { input, visible: true, testID: 'group-menu' }));
        await screen.pressByTestIdAsync('group-menu.trigger');
        expect(screen.findByTestId('removeGroup')).not.toBeNull();
        expect(named(screen.getTextContent())).toBe(0);
    });

    it('routes shortcuts only from the mounted overflow control and renders custom content only while open', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');
        const shortcut = vi.fn((key: string) => key === ']');
        const content = vi.fn(() => React.createElement('View', { testID: 'size-picker' }));
        const screen = await renderScreen(React.createElement(ItemRowActions, {
            title: 'Widget', overflowTriggerTestID: 'widget-menu',
            onOverflowTriggerKeyDown: shortcut,
            renderOverflowSection: ({ id }: { id: string }) => id === 'size' ? content() : undefined,
            actions: [{ id: 'size-medium', title: 'Medium', icon: 'square', group: { id: 'size', title: 'Size' } }],
        }));
        expect(content).not.toHaveBeenCalled();
        const target = {};
        const stopPropagation = vi.fn();
        const preventDefault = vi.fn();
        screen.findByTestId('widget-menu')!.props.onKeyDown?.({ key: ']', target, currentTarget: target, stopPropagation, preventDefault });
        expect(shortcut).toHaveBeenCalledWith(']');
        expect(preventDefault).toHaveBeenCalledOnce();
        shortcut.mockClear();
        screen.findByTestId('widget-menu')!.props.onKeyDown?.({ key: '[', target: {}, currentTarget: target, stopPropagation, preventDefault });
        expect(shortcut).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('widget-menu');
        expect(screen.findByTestId('size-picker')).not.toBeNull();
    });

    it('uses the declared size choices for both the mounted picker and bracket shortcuts', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');
        const { resolveWidgetSizeChoicesV1 } = await import('@happier-dev/protocol/widgets');
        const { renderWidgetSizeMenuSection, stepWidgetSizeControl } = await import('@/components/widgets/frame/WidgetSizeControl');
        const { buildWidgetSizeActions } = await import('@/components/widgets/frame/widgetFrameMenu');
        const choices = resolveWidgetSizeChoicesV1('home', { sizes: ['large', 'small', 'medium'], defaultSize: 'medium' });
        const selected: string[] = [];
        function WidgetMenu() {
            const [size, setSize] = React.useState(choices.defaultSize!);
            const control = { surface: 'home' as const, sizes: choices.sizes, size,
                onSet: (next: typeof size) => { selected.push(next); setSize(next); } };
            return React.createElement(ItemRowActions, { title: 'Widget', overflowTriggerTestID: 'size-menu',
                actions: buildWidgetSizeActions(control), onOverflowTriggerKeyDown: key => stepWidgetSizeControl(control, key),
                renderOverflowSection: ({ id }) => renderWidgetSizeMenuSection(control, id, 'declared-size') });
        }
        const screen = await renderScreen(React.createElement(WidgetMenu));
        const target = {};
        await act(async () => screen.findByTestId('size-menu')!.props.onKeyDown({ key: ']', target, currentTarget: target,
            preventDefault() {}, stopPropagation() {} }));
        await screen.pressByTestIdAsync('size-menu');
        expect(screen.findByTestId('declared-size.wide')).toBeNull();
        expect(screen.findByTestId('declared-size.large')!.props.accessibilityState.checked).toBe(true);
        await screen.pressByTestIdAsync('declared-size.small');
        expect(selected).toEqual(['large', 'small']);
    });

    it('steps an unnamed current rectangle to the first canonical declared size without selecting a default beforehand', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');
        const { resolveWidgetSizeChoicesV1 } = await import('@happier-dev/protocol/widgets');
        const { renderWidgetSizeMenuSection, stepWidgetSizeControl } = await import('@/components/widgets/frame/WidgetSizeControl');
        const { buildWidgetSizeActions } = await import('@/components/widgets/frame/widgetFrameMenu');
        const choices = resolveWidgetSizeChoicesV1('sessionBoard', { sizes: ['large', 'medium'], defaultSize: 'large' });
        const selected: string[] = [];
        const control = { surface: 'sessionBoard' as const, sizes: choices.sizes, size: undefined,
            onSet: (size: NonNullable<typeof choices.defaultSize>) => { selected.push(size); } };
        const screen = await renderScreen(React.createElement(ItemRowActions, { title: 'Widget', overflowTriggerTestID: 'unnamed-menu',
            actions: buildWidgetSizeActions(control), onOverflowTriggerKeyDown: key => stepWidgetSizeControl(control, key),
            renderOverflowSection: ({ id }) => renderWidgetSizeMenuSection(control, id, 'unnamed-size') }));
        await screen.pressByTestIdAsync('unnamed-menu');
        expect(screen.findByTestId('unnamed-size.medium')!.props.accessibilityState.checked).toBe(false);
        expect(screen.findByTestId('unnamed-size.large')!.props.accessibilityState.checked).toBe(false);
        const target = {};
        await act(async () => screen.findByTestId('unnamed-menu')!.props.onKeyDown({ key: ']', target, currentTarget: target,
            preventDefault() {}, stopPropagation() {} }));
        expect(selected).toEqual(['medium']);
    });

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
        const backdrop = popover.props.backdrop;
        if (!backdrop || typeof backdrop !== 'object') throw new Error('Expected an overlay backdrop');
        expect(backdrop.anchorOverlay).toMatchObject({
            props: expect.objectContaining({
                testID: 'custom-anchor-overlay',
            }),
        });
    });

    it('does not emit raw text nodes under Pressable when the vendor overflow glyph renders text on web', async () => {
        const { getIconFamily, setIconFamily } = await import('@/components/ui/icons/iconFamily');
        const previousFamily = getIconFamily();
        act(() => setIconFamily('phosphor'));
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

            // The vendor component sits inside native Text; test the rendered subtree,
            // not whether React collapses that component into its parent's direct children.
            expect(screen.tree.root.findAllByType('Text' as never).some(node =>
                node.findAll(child => child.children.includes('.')).length > 0)).toBe(true);

            expect(collectUnexpectedRawTextNodes(screen?.tree.toJSON())).toEqual([]);
        } finally {
            vendorIconState.renderText = false;
            act(() => {
                screen?.tree.unmount();
                setIconFamily(previousFamily);
            });
        }
    });

    it('does not emit raw text nodes when the vendor inline glyph renders text on web', async () => {
        const { getIconFamily, setIconFamily } = await import('@/components/ui/icons/iconFamily');
        const previousFamily = getIconFamily();
        act(() => setIconFamily('phosphor'));
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

            expect(screen.tree.root.findAllByType('Text' as never).some(node =>
                node.findAll(child => child.children.includes('.')).length > 0)).toBe(true);

            expect(collectUnexpectedRawTextNodes(screen?.tree.toJSON())).toEqual([]);
        } finally {
            vendorIconState.renderText = false;
            act(() => {
                screen?.tree.unmount();
                setIconFamily(previousFamily);
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

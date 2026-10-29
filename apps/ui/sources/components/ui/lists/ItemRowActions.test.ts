import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const viewport = vi.hoisted(() => ({ width: 320, height: 800 }));
// The focus ring is keyboard-only: its owner records the last input at the document when it loads, so the
// document boundary exists before any import and the case below presses a key through its listener.
const documentInput = vi.hoisted(() => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const listeners = new Map<string, (event: unknown) => void>();
    const document = {
        addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener); },
        getElementById: (_id: string) => null,
    };
    (globalThis as { document?: unknown }).document = document;
    // The pointer owner reads hardware identity once, including during imports of shared chrome.
    (globalThis as { window?: unknown }).window = {
        matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' || query === '(hover: none)', media: query }),
    };
    return { listeners, document, previousWindow };
});
afterAll(() => {
    if (documentInput.previousWindow) Object.defineProperty(globalThis, 'window', documentInput.previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
});
installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            // Exercise fallback scheduling when this native boundary never invokes its callback.
            InteractionManager: { runAfterInteractions: () => ({ cancel: () => {} }) },
            Dimensions: { get: () => ({ ...viewport, scale: 1, fontScale: 1 }) },
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

// Prepare the real owner outside a case's deadline; its cold source import also loads the host UI graph.
const { ItemRowActions: CurrentItemRowActions } = await import('./ItemRowActions');

describe('ItemRowActions', () => {
    let restoreWebGlobals: (() => void) | undefined;
    beforeEach(() => {
        viewport.width = 320;
        viewport.height = 800;
        // The touch floors below are the finger contract: a phone browser's primary pointer cannot hover.
        // A precise pointer keeps the dense desktop sizes (see `HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE`).
        restoreWebGlobals = withPopoverWebGlobals({
            window: {
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                setTimeout: globalThis.setTimeout.bind(globalThis),
                clearTimeout: globalThis.clearTimeout.bind(globalThis),
                matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' || query === '(hover: none)', media: query }),
            },
        });
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
        // Count the visible sheet, not BaseModal's separate hidden accessibility label.
        const sheetText = screen.findByTestId('group-menu.sheet')!.findAll(node => typeof node.type === 'string')
            .flatMap(node => node.children.filter((child): child is string => typeof child === 'string')).join(' ');
        expect(named(sheetText)).toBe(1);
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

    it('closes a controlled overflow through its current owner after that owner changes', async () => {
        const originalOwner = vi.fn();
        const currentOwner = vi.fn();
        const edit = vi.fn();
        const props = { title: 'Profile', overflowOnly: true,
            overflowTriggerTestID: 'controlled-overflow',
            actions: [{ id: 'edit', title: 'Edit profile', icon: 'pencil-simple', onPress: edit }] } satisfies import('./ItemRowActions').ItemRowActionsProps;
        const screen = await renderScreen(React.createElement(CurrentItemRowActions, {
            ...props, overflowOpen: false, onOverflowOpenChange: originalOwner,
        }));
        await screen.update(React.createElement(CurrentItemRowActions, {
            ...props, overflowOpen: true, onOverflowOpenChange: currentOwner,
        }));
        await screen.pressByTestIdAsync('edit');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(edit).toHaveBeenCalledOnce();
        expect(currentOwner).toHaveBeenCalledWith(false);
        expect(originalOwner).not.toHaveBeenCalled();
    });

    it('opens its ⋯ menu below the trigger as a non-blocking menu: the page is neither blurred nor dimmed and no caret points back', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');
        const { Popover } = await import('@/components/ui/popover');
        const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');
        const screen = await renderScreen(React.createElement(ItemRowActions, {
            title: 'Group',
            overflowTriggerTestID: 'row-actions-trigger',
            actions: [{ id: 'rename', title: 'Rename', icon: 'pencil-simple', onPress: vi.fn() }],
        }));
        await screen.pressByTestIdAsync('row-actions-trigger');
        const popover = screen.tree.root.findByType(Popover);
        // DESIGN.md: do not dim the world for parallel, non-blocking work (lab wgmenu M: the page stays sharp).
        const backdrop = popover.props.backdrop;
        expect(['blur', 'dim']).not.toContain(backdrop && typeof backdrop === 'object' ? backdrop.effect : undefined);
        expect(['bottom', 'auto-vertical']).toContain(popover.props.placement);
        expect(popover.props.portal).toEqual(expect.objectContaining({ anchorAlign: 'end' }));
        const surface = popover.props.children({ maxHeight: 280, maxWidth: 260, placement: 'bottom', requestClose: () => {} });
        if (!React.isValidElement<React.ComponentProps<typeof FloatingOverlay>>(surface)) throw new Error('Expected the menu surface');
        expect(surface.type).toBe(FloatingOverlay);
        expect(surface.props.arrow).toBeFalsy();
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

    it('passes custom overflow placement and portal alignment through to the popover', async () => {
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
        }));

        await screen.pressByTestIdAsync('custom-trigger');

        const { Popover } = await import('@/components/ui/popover');
        const popover = screen.tree.root.findByType(Popover);
        expect(popover.props.placement).toBe('bottom');
        expect(popover.props.portal).toEqual(expect.objectContaining({
            anchorAlign: 'center',
        }));
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

    it('draws inline icon actions at their own size with a visible web focus ring', async () => {
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
        (globalThis as { document?: unknown }).document = documentInput.document;
        documentInput.listeners.get('keydown')?.({ key: 'Tab' });
        const base = flatten(action!.props.style({ pressed: false, focused: false }));
        const focused = flatten(action!.props.style({ pressed: false, focused: true }));

        // The drawn control is the whole box; its hit area belongs to the shared owner.
        expect(Number(base.width)).toBe(28);
        expect(Number(base.height)).toBe(28);
        expect(focused.outlineStyle).toBe('solid');
        expect(focused.outlineWidth).toBeGreaterThanOrEqual(2);
        expect(focused.outlineColor).toBeTruthy();
    });

    // A touch target is a hit area, never a drawn size: the row measures the drawn control, and the
    // shared hit-area owner reaches the target past it (native hitSlop, an invisible web frame),
    // sideways only half the row gap so neighbouring targets never overlap.
    it('reaches the touch target past a dense control without moving the row or overlapping its neighbour', async () => {
        const { Platform } = await import('react-native');
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const previousPlatform = Platform.OS;
        const flatten = (style: unknown) => (Array.isArray(style)
            ? Object.assign({}, ...style.filter(Boolean))
            : (style ?? {})) as Record<string, unknown>;
        const DRAWN_SIZE = 32;
        const ROW_GAP = 4;

        try {
            for (const platform of [
                { os: 'android', target: 48 },
                { os: 'ios', target: 44 },
            ] as const) {
                (Platform as { OS: string }).OS = platform.os;
                const { ItemRowActions } = await import('./ItemRowActions');
                const testIDs = [`dense-a-${platform.os}`, `dense-b-${platform.os}`] as const;
                const screen = await renderScreen(React.createElement(
                    HappierUiPlatformProvider,
                    { platform: { platform: platform.os, colorScheme: 'light' } },
                    React.createElement(ItemRowActions, {
                        title: 'Sidebar',
                        compactThreshold: 200,
                        actionControlSizePx: DRAWN_SIZE,
                        gap: ROW_GAP,
                        actions: [
                            { id: 'newSession', title: 'New session', icon: 'plus', inlineTestID: testIDs[0], onPress: vi.fn() },
                            { id: 'favorite', title: 'Favorite', icon: 'star', inlineTestID: testIDs[1], onPress: vi.fn() },
                        ],
                    }),
                ));

                for (const inlineTestID of testIDs) {
                    const action = screen.findByTestId(inlineTestID);
                    expect(action, inlineTestID).toBeTruthy();
                    const box = flatten(action!.props.style({ pressed: false, focused: false }));
                    // 1. The row's layout footprint is the drawn control.
                    expect(Number(box.width), `${inlineTestID} layout width`).toBe(DRAWN_SIZE);
                    expect(Number(box.height), `${inlineTestID} layout height`).toBe(DRAWN_SIZE);
                    expect(box.marginHorizontal ?? 0, `${inlineTestID} no compensating margin`).toBe(0);

                    // 2. Vertically the hit area takes the whole platform target.
                    const slop = action!.props.hitSlop as Record<string, number>;
                    expect(DRAWN_SIZE + slop.top + slop.bottom, `${inlineTestID} hit height`).toBe(platform.target);
                    // 3. Sideways it reaches half the gap, so adjacent targets tile and never overlap.
                    expect(slop.left + slop.right, `${inlineTestID} overlap`).toBeLessThanOrEqual(ROW_GAP);
                    expect(DRAWN_SIZE + slop.left + slop.right, `${inlineTestID} SC 2.5.8`).toBeGreaterThanOrEqual(24);
                }
                await screen.unmount();
            }
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });
});

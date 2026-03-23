import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { findTestInstanceByTypeWithProps, pressTestInstance, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useSelectableMenuSpy = vi.fn();
let uiItemDensitySetting: 'comfortable' | 'cozy' | 'compact' = 'comfortable';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                Text: (props: any) => React.createElement('Text', props, props.children),
                TextInput: (props: any) => React.createElement('TextInput', props, props.children),
                View: (props: any) => React.createElement('View', props, props.children),
                Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => {
        const React = require('react');
        return React.createElement('Ionicons', props);
    },
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => {
        const React = require('react');
        return React.createElement(
            'Popover',
            props,
            typeof props.children === 'function'
                ? props.children({ maxHeight: 200, maxWidth: 400, placement: props.placement ?? 'bottom' })
                : props.children,
        );
    },
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: any) => {
        const React = require('react');
        return React.createElement('FloatingOverlay', props, props.children);
    },
}));

vi.mock('@/components/ui/forms/dropdown/useSelectableMenu', () => ({
    useSelectableMenu: (args: any) => {
        useSelectableMenuSpy(args);
        return {
            searchQuery: '',
            selectedIndex: 0,
            filteredCategories: [],
            inputRef: { current: null },
            setSelectedIndex: () => {},
            handleSearchChange: () => {},
            handleKeyPress: () => {},
        };
    },
    CREATE_ITEM_ID: '__create__',
}));

vi.mock('@/components/ui/forms/dropdown/SelectableMenuResults', () => ({
    SelectableMenuResults: (props: any) => {
        const React = require('react');
        return React.createElement('SelectableMenuResults', props);
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiItemDensity') return uiItemDensitySetting;
        if (key === 'uiFontScale') return 1;
        return null;
    },
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => {
        const React = require('react');
        return React.createElement('Item', props);
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => {
        const React = require('react');
        const { Text } = require('react-native');
        return React.createElement(Text, props, props.children);
    },
    TextInput: (props: any) => {
        const React = require('react');
        const { TextInput } = require('react-native');
        return React.createElement(TextInput, props, props.children);
    },
}));

describe('DropdownMenu', () => {
    beforeEach(() => {
        vi.resetModules();
        useSelectableMenuSpy.mockReset();
        uiItemDensitySetting = 'comfortable';
        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
            cb();
            return 0 as any;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('provides a toggle handler to the trigger and uses it to open/close', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Pressable, Text } = await import('react-native');

        const onOpenChange = vi.fn();

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(DropdownMenu, {
                    open: false,
                    onOpenChange,
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: ({ toggle }: any) =>
                        React.createElement(
                            Pressable,
                            { onPress: toggle },
                            React.createElement(Text, null, 'Trigger'),
                        ),
                }))).tree;

        const pressable = tree?.findByType(Pressable);
        expect(pressable).toBeTruthy();

        act(() => {
            pressTestInstance(pressable);
        });
        expect(onOpenChange).toHaveBeenCalledWith(true);

        act(() => {
            tree?.update(
                React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange,
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: ({ toggle }: any) =>
                        React.createElement(
                            Pressable,
                            { onPress: toggle },
                            React.createElement(Text, null, 'Trigger'),
                        ),
                }),
            );
        });

        const pressable2 = tree?.findByType(Pressable);
        act(() => {
            pressTestInstance(pressable2);
        });
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('closes the menu when an item is selected by default', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const onOpenChange = vi.fn();
        const onSelect = vi.fn();

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange,
                    items: [{ id: 'a', title: 'A' }],
                    onSelect,
                    trigger: React.createElement('View'),
                }))).tree;

        const selectableResults = tree?.findByType('SelectableMenuResults' as any);
        act(() => {
            selectableResults?.props?.onPressItem?.({ id: 'a' });
        });

        expect(onSelect).toHaveBeenCalledWith('a');
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('keeps the menu open when closeOnSelect is false', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const onOpenChange = vi.fn();
        const onSelect = vi.fn();

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(DropdownMenu as any, {
                    open: true,
                    onOpenChange,
                    closeOnSelect: false,
                    items: [{ id: 'a', title: 'A' }],
                    onSelect,
                    trigger: React.createElement('View'),
                }))).tree;

        const selectableResults = tree?.findByType('SelectableMenuResults' as any);
        act(() => {
            selectableResults?.props?.onPressItem?.({ id: 'a' });
        });

        expect(onSelect).toHaveBeenCalledWith('a');
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('supports a static trigger node and keeps popover unmounted when closed', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Text } = await import('react-native');

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(DropdownMenu, {
                    open: false,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: React.createElement(Text, null, 'Static Trigger'),
                }))).tree;

        const labels = tree?.findAllByType(Text).map((node: any) => node.props?.children) ?? [];
        expect(labels).toContain('Static Trigger');
        expect(tree?.findAllByType('Popover' as any).length).toBe(0);
    });

    it('does not auto-focus the search field by default', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Text } = await import('react-native');

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: React.createElement(Text, null, 'Trigger'),
                    search: true,
                }))).tree;

        const inputs = tree?.findAllByType('TextInput' as any) ?? [];
        expect(inputs.length).toBeGreaterThan(0);
        for (const input of inputs) {
            expect(input.props?.autoFocus).not.toBe(true);
        }
    });

    it('passes default and explicit row rendering options to SelectableMenuResults', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: React.createElement('View'),
                    showCategoryTitles: false,
                    rowKind: 'item',
                }))).tree;

        const popover = tree?.findByType('Popover' as any);
        expect(popover?.props?.placement).toBe('bottom');

        const selectableResults = tree?.findByType('SelectableMenuResults' as any);
        expect(selectableResults?.props?.showCategoryTitles).toBe(false);
        expect(selectableResults?.props?.rowKind).toBe('item');
    });

    it('does not add a default chevron right element to selectable items', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        await renderScreen(React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: React.createElement('View'),
                }));

        expect(useSelectableMenuSpy).toHaveBeenCalled();
        const args = useSelectableMenuSpy.mock.calls[0]?.[0];
        expect(args).toBeTruthy();
        expect(Array.isArray(args.items)).toBe(true);
        expect(args.items[0]?.id).toBe('a');
        expect(args.items[0]?.right).toBe(null);
    });

    it('can render an Item-style trigger that shows the selected label and subtitle by default', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        uiItemDensitySetting = 'cozy';

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(DropdownMenu as any, {
                    open: false,
                    onOpenChange: vi.fn(),
                    items: [
                        { id: 'a', title: 'Alpha', subtitle: 'First' },
                        { id: 'b', title: 'Beta', subtitle: 'Second' },
                    ],
                    selectedId: 'b',
                    onSelect: () => {},
                    itemTrigger: {
                        title: 'Pick one',
                    },
                }))).tree;

        const item = tree?.findByType('Item' as any);
        expect(item?.props?.title).toBe('Pick one');
        expect(item?.props?.density).toBe('cozy');
        expect(item?.props?.detail).toBeUndefined();
        expect(item?.props?.subtitle).toBe('Second');
        expect(item?.props?.rightElement).toBeTruthy();

        let rightElementTree: ReturnType<typeof renderer.create> | undefined;
        rightElementTree = (await renderScreen(item?.props?.rightElement)).tree;

        const rightTextNodes = rightElementTree?.findAllByType('Text' as any) ?? [];
        const rightTexts = rightTextNodes.map((node: any) => node.props?.children).flat();
        expect(rightTexts).toContain('Beta');
        const chevronIcon = rightElementTree
            ? findTestInstanceByTypeWithProps(rightElementTree, 'Ionicons' as any, { name: 'chevron-down' })
            : undefined;
        expect(chevronIcon?.props?.size).toBe(17);
    });

    it('renders the right-side selected detail text for comfortable density', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        uiItemDensitySetting = 'comfortable';

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(DropdownMenu as any, {
                    open: false,
                    onOpenChange: vi.fn(),
                    items: [
                        { id: 'a', title: 'Alpha', subtitle: 'First' },
                        { id: 'b', title: 'Beta', subtitle: 'Second' },
                    ],
                    selectedId: 'b',
                    onSelect: () => {},
                    itemTrigger: {
                        title: 'Pick one',
                    },
                }))).tree;

        const item = tree?.findByType('Item' as any);

        let rightElementTree: ReturnType<typeof renderer.create> | undefined;
        rightElementTree = (await renderScreen(item?.props?.rightElement)).tree;

        const rightTextNodes = rightElementTree?.findAllByType('Text' as any) ?? [];
        const rightTexts = rightTextNodes.map((node: any) => node.props?.children).flat();
        expect(rightTexts).toContain('Beta');
    });

    it('passes compact item props through to item-style dropdown rows', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(DropdownMenu as any, {
                    open: true,
                    onOpenChange: vi.fn(),
                    items: [
                        { id: 'a', title: 'Alpha', subtitle: 'First' },
                        { id: 'b', title: 'Beta', subtitle: 'Second' },
                    ],
                    selectedId: 'b',
                    onSelect: () => {},
                    rowKind: 'item',
                    itemRowProps: { density: 'compact' },
                    itemTrigger: {
                        title: 'Pick one',
                    },
                }))).tree;

        const selectableResults = tree?.findByType('SelectableMenuResults' as any);
        expect(selectableResults?.props?.itemProps).toMatchObject({ density: 'compact' });
    });

    it('allows disabling selected detail/subtitle in the Item-style trigger', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(DropdownMenu as any, {
                    open: false,
                    onOpenChange: vi.fn(),
                    items: [
                        { id: 'a', title: 'Alpha', subtitle: 'First' },
                        { id: 'b', title: 'Beta', subtitle: 'Second' },
                    ],
                    selectedId: 'b',
                    onSelect: () => {},
                    itemTrigger: {
                        title: 'Pick one',
                        showSelectedDetail: false,
                        showSelectedSubtitle: false,
                        subtitle: 'Static subtitle',
                    },
                }))).tree;

        const item = tree?.findByType('Item' as any);
        expect(item?.props?.title).toBe('Pick one');
        expect(item?.props?.detail).toBeUndefined();
        expect(item?.props?.subtitle).toBe('Static subtitle');
    });

    it('passes through an explicit null emptyLabel (does not fall back to the default label)', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: React.createElement('View'),
                    emptyLabel: null,
                }))).tree;

        const selectableResults = tree?.findByType('SelectableMenuResults' as any);
        expect(selectableResults?.props?.emptyLabel).toBe(null);
    });

    it('renders the search input and results list together when search is enabled', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Text } = await import('react-native');
        const { TextInput } = await import('@/components/ui/text/Text');

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: React.createElement(Text, null, 'Trigger'),
                    search: true,
                }))).tree;

        const input = tree?.findByType(TextInput as any);
        const selectableResults = tree?.findByType('SelectableMenuResults' as any);
        expect(input).toBeTruthy();
        expect(selectableResults).toBeTruthy();
    });
});

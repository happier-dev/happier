import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useSelectableMenuSpy = vi.fn();

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'web' },
        Text: (props: any) => React.createElement('Text', props, props.children),
        TextInput: (props: any) => React.createElement('TextInput', props, props.children),
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => {
        const React = require('react');
        return React.createElement('Ionicons', props);
    },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (factory: any) => factory({
        colors: {
            textSecondary: '#666',
            divider: '#ddd',
            text: '#111',
            input: { placeholder: '#999' },
        },
    }, {}) },
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#666',
                divider: '#ddd',
                text: '#111',
                input: {
                    placeholder: '#999',
                },
            },
        },
    }),
}));

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
}));

vi.mock('@/components/ui/forms/dropdown/SelectableMenuResults', () => ({
    SelectableMenuResults: (props: any) => {
        const React = require('react');
        return React.createElement('SelectableMenuResults', props);
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
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
        useSelectableMenuSpy.mockReset();
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
        act(() => {
            tree = renderer.create(
                React.createElement(DropdownMenu, {
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
                }),
            );
        });

        const pressable = tree?.root.findByType(Pressable);
        expect(pressable).toBeTruthy();

        act(() => {
            pressable?.props?.onPress?.();
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

        const pressable2 = tree?.root.findByType(Pressable);
        act(() => {
            pressable2?.props?.onPress?.();
        });
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('supports a static trigger node and keeps popover unmounted when closed', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Text } = await import('react-native');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(DropdownMenu, {
                    open: false,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: React.createElement(Text, null, 'Static Trigger'),
                }),
            );
        });

        const labels = tree?.root.findAllByType(Text).map((node: any) => node.props?.children) ?? [];
        expect(labels).toContain('Static Trigger');
        expect(tree?.root.findAllByType('Popover' as any).length).toBe(0);
    });

    it('does not auto-focus the search field by default', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Text } = await import('react-native');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: React.createElement(Text, null, 'Trigger'),
                    search: true,
                }),
            );
        });

        const inputs = tree?.root.findAllByType('TextInput' as any) ?? [];
        expect(inputs.length).toBeGreaterThan(0);
        for (const input of inputs) {
            expect(input.props?.autoFocus).not.toBe(true);
        }
    });

    it('passes default and explicit row rendering options to SelectableMenuResults', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: React.createElement('View'),
                    showCategoryTitles: false,
                    rowKind: 'item',
                }),
            );
        });

        const popover = tree?.root.findByType('Popover' as any);
        expect(popover?.props?.placement).toBe('bottom');

        const selectableResults = tree?.root.findByType('SelectableMenuResults' as any);
        expect(selectableResults?.props?.showCategoryTitles).toBe(false);
        expect(selectableResults?.props?.rowKind).toBe('item');
    });

    it('does not add a default chevron right element to selectable items', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        act(() => {
            renderer.create(
                React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: React.createElement('View'),
                }),
            );
        });

        expect(useSelectableMenuSpy).toHaveBeenCalled();
        const args = useSelectableMenuSpy.mock.calls[0]?.[0];
        expect(args).toBeTruthy();
        expect(Array.isArray(args.items)).toBe(true);
        expect(args.items[0]?.id).toBe('a');
        expect(args.items[0]?.right).toBe(null);
    });

    it('can render an Item-style trigger that shows the selected label and subtitle by default', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(DropdownMenu as any, {
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
                }),
            );
        });

        const item = tree?.root.findByType('Item' as any);
        expect(item?.props?.title).toBe('Pick one');
        expect(item?.props?.detail).toBe('Beta');
        expect(item?.props?.subtitle).toBe('Second');
    });

    it('allows disabling selected detail/subtitle in the Item-style trigger', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(DropdownMenu as any, {
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
                }),
            );
        });

        const item = tree?.root.findByType('Item' as any);
        expect(item?.props?.title).toBe('Pick one');
        expect(item?.props?.detail).toBeUndefined();
        expect(item?.props?.subtitle).toBe('Static subtitle');
    });

    it('passes through an explicit null emptyLabel (does not fall back to the default label)', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: React.createElement('View'),
                    emptyLabel: null,
                }),
            );
        });

        const selectableResults = tree?.root.findByType('SelectableMenuResults' as any);
        expect(selectableResults?.props?.emptyLabel).toBe(null);
    });

    it('uses symmetric content padding and adds bottom padding under results', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Text, View } = await import('react-native');
        const { TextInput } = await import('@/components/ui/text/Text');

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: React.createElement(Text, null, 'Trigger'),
                    search: true,
                }),
            );
        });

        const input = tree?.root.findByType(TextInput as any);
        const inputWrapper = input?.parent;
        expect(inputWrapper?.type === ('View' as any) || inputWrapper?.type === (View as any)).toBe(true);
        expect(inputWrapper?.props?.style).toMatchObject({ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 });

        const paddingNodes = tree?.root.findAll((node: any) => {
            const style = node?.props?.style;
            const list = Array.isArray(style) ? style : style ? [style] : [];
            return list.some((entry: any) => entry && typeof entry === 'object' && entry.paddingBottom === 12);
        }) ?? [];
        expect(paddingNodes.length).toBeGreaterThan(0);
    });
});

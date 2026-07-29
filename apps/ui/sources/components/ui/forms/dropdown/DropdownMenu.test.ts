import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { findTestInstanceByTypeWithProps, pressTestInstance, renderScreen } from '@/dev/testkit';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installDropdownCommonModuleMocks();

const useSelectableMenuSpy = vi.fn();
const scrollRegistrySpy = vi.fn();
let uiItemDensitySetting: 'comfortable' | 'cozy' | 'compact' = 'comfortable';
let reducedMotion = false;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    if (!style || typeof style !== 'object') return {};
    return style as Record<string, unknown>;
}

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => {
        const React = require('react');
        return React.createElement('Ionicons', props);
    },
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
    PopoverScope: (props: any) => {
        const React = require('react');
        return React.createElement(React.Fragment, null, props.children);
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

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotion,
}));

vi.mock('@/components/ui/scroll/useScrollRectIntoView', () => ({
    useScrollRectIntoViewRegistry: (args: any) => {
        scrollRegistrySpy(args);
        return {
            scrollRef: { current: null },
            registerItemLayout: () => () => {},
            onViewportLayout: () => {},
            onContentSizeChange: () => {},
            onScroll: () => {},
        };
    },
}));

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
        scrollRegistrySpy.mockReset();
        uiItemDensitySetting = 'comfortable';
        reducedMotion = false;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('provides a toggle handler to the trigger and uses it to open/close', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Pressable, Text } = await import('react-native');

        const onOpenChange = vi.fn();

        const screen = await renderScreen(React.createElement(DropdownMenu, {
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
        }));

        const pressable = screen.findByType(Pressable);

        await act(async () => {
            pressTestInstance(pressable);
        });
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
        expect(onOpenChange).toHaveBeenCalledWith(true);

        act(() => {
            screen.tree.update(
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

        const pressable2 = screen.findByType(Pressable);
        act(() => {
            pressTestInstance(pressable2);
        });
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('still opens when requestAnimationFrame is present but does not run', async () => {
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));

        const { DropdownMenu } = await import('./DropdownMenu');
        const { Pressable, Text } = await import('react-native');

        const onOpenChange = vi.fn();

        const screen = await renderScreen(React.createElement(DropdownMenu, {
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
        }));

        const pressable = screen.findByType(Pressable);

        await act(async () => {
            pressTestInstance(pressable);
        });
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(onOpenChange).toHaveBeenCalledWith(true);
    });

    it('closes the menu when an item is selected by default', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const onOpenChange = vi.fn();
        const onSelect = vi.fn();

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange,
            items: [{ id: 'a', title: 'A' }],
            onSelect,
            trigger: React.createElement('View'),
        }));

        const selectableResults = screen.findByType('SelectableMenuResults' as any);
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

        const screen = await renderScreen(React.createElement(DropdownMenu as any, {
            open: true,
            onOpenChange,
            closeOnSelect: false,
            items: [{ id: 'a', title: 'A' }],
            onSelect,
            trigger: React.createElement('View'),
        }));

        const selectableResults = screen.findByType('SelectableMenuResults' as any);
        act(() => {
            selectableResults?.props?.onPressItem?.({ id: 'a' });
        });

        expect(onSelect).toHaveBeenCalledWith('a');
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('opens submenu items without selecting the parent row', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const onOpenChange = vi.fn();
        const onSelect = vi.fn();
        const submenuAnchorRef = {
            current: {
                getBoundingClientRect: () => ({ width: 4, height: 48 }),
            },
        };

        const screen = await renderScreen(React.createElement(DropdownMenu as any, {
            open: true,
            onOpenChange,
            items: [{
                id: 'move-to-folder',
                title: 'Move to folder',
                submenu: {
                    items: [
                        { id: 'folder-root', title: 'Workspace root' },
                        { id: 'folder-planning', title: 'Planning' },
                    ],
                },
            }],
            onSelect,
            trigger: React.createElement('View'),
        }));

        const rootResults = screen.findByType('SelectableMenuResults' as any);
        expect(typeof rootResults?.props?.onOpenSubmenu).toBe('function');

        act(() => {
            rootResults?.props?.onOpenSubmenu?.('move-to-folder', submenuAnchorRef);
        });

        expect(onSelect).not.toHaveBeenCalled();

        const popovers = screen.findAllByType('Popover' as any);
        expect(popovers).toHaveLength(2);
        expect(popovers[1]?.props?.anchorRef).toBe(submenuAnchorRef);
        expect(popovers[1]?.props?.placement).toBe('auto-horizontal');
        expect(popovers[1]?.props?.boundaryRef).toBe(null);
        expect(popovers[1]?.props?.portal?.web).toMatchObject({ target: 'body' });

        const results = screen.findAllByType('SelectableMenuResults' as any);
        expect(results).toHaveLength(2);

        act(() => {
            results[1]?.props?.onPressItem?.({ id: 'folder-planning' });
        });

        expect(onSelect).toHaveBeenCalledWith('folder-planning');
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('supports a static trigger node and keeps popover unmounted when closed', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Text } = await import('react-native');

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: false,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: React.createElement(Text, null, 'Static Trigger'),
        }));

        expect(screen.getTextContent()).toContain('Static Trigger');
        expect(screen.findAllByType('Popover' as any).length).toBe(0);
    });

    it('forwards testID to the production dropdown anchor', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Text, View } = await import('react-native');

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            testID: 'settings-ssh-configured-host-menu',
            open: false,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: React.createElement(Text, null, 'Trigger'),
        }));

        expect(screen.findAllByType(View).some((view) => (
            view.props.testID === 'settings-ssh-configured-host-menu'
        ))).toBe(true);
    });

    it('does not auto-focus the search field by default', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Text } = await import('react-native');

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: React.createElement(Text, null, 'Trigger'),
            search: true,
        }));

        const inputs = screen.findAllByType('TextInput' as any) ?? [];
        expect(inputs.length).toBeGreaterThan(0);
        for (const input of inputs) {
            expect(input.props?.autoFocus).not.toBe(true);
        }
    });

    it('passes default and explicit row rendering options to SelectableMenuResults', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: React.createElement('View'),
            showCategoryTitles: false,
            rowKind: 'item',
        }));

        const popover = screen.findByType('Popover' as any);
        expect(popover?.props?.placement).toBe('auto-vertical');

        const selectableResults = screen.findByType('SelectableMenuResults' as any);
        expect(selectableResults?.props?.showCategoryTitles).toBe(false);
        expect(selectableResults?.props?.rowKind).toBe('item');
    });

    it('connects top-placed popovers to the trigger at the bottom edge', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: React.createElement('View'),
            placement: 'top',
            connectToTrigger: true,
        }));

        const floatingOverlay = screen.findByType('FloatingOverlay' as any);
        expect(flattenStyle(floatingOverlay?.props?.containerStyle)).toMatchObject({
            borderBottomLeftRadius: 0,
            borderBottomRightRadius: 0,
            marginBottom: -1,
            borderBottomWidth: 0,
        });
        expect(flattenStyle(floatingOverlay?.props?.containerStyle)).not.toMatchObject({
            borderTopLeftRadius: 0,
            borderTopRightRadius: 0,
            marginTop: -1,
            borderTopWidth: 0,
        });
    });

    it('opts dropdown overlays into themed surface chrome', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: React.createElement('View'),
        }));

        const floatingOverlay = screen.findByType('FloatingOverlay' as any);
        expect(floatingOverlay?.props?.surfaceChrome).toBe('theme');
    });

    it('wires menu result rows to the overlay scroll container for keyboard auto-scroll', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
            onSelect: () => {},
            trigger: React.createElement('View'),
        }));

        const floatingOverlay = screen.findByType('FloatingOverlay' as any);
        expect(floatingOverlay?.props?.scrollViewRef).toBeTruthy();
        expect(typeof floatingOverlay?.props?.onScrollViewLayout).toBe('function');
        expect(typeof floatingOverlay?.props?.onScrollViewContentSizeChange).toBe('function');
        expect(typeof floatingOverlay?.props?.onScrollViewScroll).toBe('function');

        const selectableResults = screen.findByType('SelectableMenuResults' as any);
        expect(typeof selectableResults?.props?.registerItemLayout).toBe('function');
    });

    it('disables keyboard auto-scroll animation when reduced motion is enabled', async () => {
        reducedMotion = true;
        const { DropdownMenu } = await import('./DropdownMenu');

        await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
            onSelect: () => {},
            trigger: React.createElement('View'),
            search: true,
        }));

        expect(scrollRegistrySpy).toHaveBeenCalledWith(expect.objectContaining({ animated: false }));
    });

    it('uses popoverAnchorRef when provided', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const externalAnchorRef = { current: 'external-anchor' } as any;

        const screen = await renderScreen(React.createElement(DropdownMenu as any, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: React.createElement('View'),
            popoverAnchorRef: externalAnchorRef,
        }));

        const popover = screen.findByType('Popover' as any);
        expect(popover?.props?.anchorRef).toBe(externalAnchorRef);
    });

    it('defaults showCategoryTitles to false', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: React.createElement('View'),
        }));

        const selectableResults = screen.findByType('SelectableMenuResults' as any);
        expect(selectableResults?.props?.showCategoryTitles).toBe(false);
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

        const screen = await renderScreen(React.createElement(DropdownMenu as any, {
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
        }));

        const item = screen.findByType('Item' as any);
        expect(item?.props?.title).toBe('Pick one');
        expect(item?.props?.density).toBe('cozy');
        expect(item?.props?.detail).toBeUndefined();
        expect(item?.props?.subtitle).toBe('Second');
        expect(item?.props?.rightElement).toBeTruthy();
        expect(item?.props?.webRole).toBe('button');

        const rightElementScreen = await renderScreen(item?.props?.rightElement);

        expect(rightElementScreen.getTextContent()).toContain('Beta');
        const chevronIcon = findTestInstanceByTypeWithProps(rightElementScreen.tree, 'Ionicons' as any, { name: 'chevron-down' });
        expect(chevronIcon?.props?.size).toBe(17);
    });

    it('renders the right-side selected detail text for comfortable density', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        uiItemDensitySetting = 'comfortable';

        const screen = await renderScreen(React.createElement(DropdownMenu as any, {
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
        }));

        const item = screen.findByType('Item' as any);

        const rightElementScreen = await renderScreen(item?.props?.rightElement);

        expect(rightElementScreen.getTextContent()).toContain('Beta');
    });

    it('passes compact item props through to item-style dropdown rows', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const screen = await renderScreen(React.createElement(DropdownMenu as any, {
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
        }));

        const selectableResults = screen.findByType('SelectableMenuResults' as any);
        expect(selectableResults?.props?.itemProps).toMatchObject({ density: 'compact' });
    });

    it('allows disabling selected detail/subtitle in the Item-style trigger', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const screen = await renderScreen(React.createElement(DropdownMenu as any, {
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
        }));

        const item = screen.findByType('Item' as any);
        expect(item?.props?.title).toBe('Pick one');
        expect(item?.props?.detail).toBeUndefined();
        expect(item?.props?.subtitle).toBe('Static subtitle');
    });

    it('passes through an explicit null emptyLabel (does not fall back to the default label)', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: React.createElement('View'),
            emptyLabel: null,
        }));

        const selectableResults = screen.findByType('SelectableMenuResults' as any);
        expect(selectableResults?.props?.emptyLabel).toBe(null);
    });

    it('renders the search input and results list together when search is enabled', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Text } = await import('react-native');
        const { TextInput } = await import('@/components/ui/text/Text');

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: React.createElement(Text, null, 'Trigger'),
            search: true,
        }));

        const input = screen.findByType(TextInput as any);
        const selectableResults = screen.findByType('SelectableMenuResults' as any);
        expect(input).toBeTruthy();
        expect(selectableResults).toBeTruthy();
    });
});

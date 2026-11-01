import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { findTestInstanceByTypeWithProps, pressTestInstance, renderScreen } from '@/dev/testkit';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installDropdownCommonModuleMocks();

const useSelectableMenuSpy = vi.fn();
const handleSelectableKeyPressSpy = vi.fn();
let uiItemDensitySetting: 'comfortable' | 'cozy' | 'compact' = 'comfortable';

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
            handleKeyPress: handleSelectableKeyPressSpy,
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
        handleSelectableKeyPressSpy.mockReset();
        uiItemDensitySetting = 'comfortable';
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

    it('closes the menu when an item is selected by default', async () => {
        const scheduled: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            scheduled.push(callback);
            return scheduled.length;
        });
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

        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(onSelect).not.toHaveBeenCalled();
        act(() => scheduled.shift()?.(0));
        expect(onSelect).toHaveBeenCalledWith('a');
    });

    it('commits a closing menu selection after the selection press has completed', async () => {
        const scheduled: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            scheduled.push(callback);
            return scheduled.length;
        });
        const { DropdownMenu } = await import('./DropdownMenu');
        const events: string[] = [];

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: (open) => events.push(open ? 'open' : 'close'),
            items: [{ id: 'open-modal', title: 'Open modal' }],
            onSelect: () => events.push('select'),
            trigger: React.createElement('View'),
        }));

        const selectableResults = screen.findByType('SelectableMenuResults' as any);
        act(() => {
            selectableResults?.props?.onPressItem?.({ id: 'open-modal' });
        });

        expect(events).toEqual(['close']);

        act(() => scheduled.shift()?.(0));

        expect(events).toEqual(['close', 'select']);
    });

    it('uses the same close-before-commit sequence for keyboard selection', async () => {
        const scheduled: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            scheduled.push(callback);
            return scheduled.length;
        });
        handleSelectableKeyPressSpy.mockImplementationOnce((_key, onSelect) => {
            onSelect({ id: 'open-modal' });
        });
        const { DropdownMenu } = await import('./DropdownMenu');
        const events: string[] = [];

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: (open) => events.push(open ? 'open' : 'close'),
            items: [{ id: 'open-modal', title: 'Open modal' }],
            onSelect: () => events.push('select'),
            trigger: React.createElement('View'),
            search: true,
        }));
        const event = {
            nativeEvent: { key: 'Enter' },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        act(() => screen.findByType('TextInput' as any)?.props?.onKeyPress?.(event));

        expect(events).toEqual(['close']);
        act(() => scheduled.shift()?.(0));
        expect(events).toEqual(['close', 'select']);
    });

    it('still commits a closing selection when requestAnimationFrame does not run', async () => {
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        const { DropdownMenu } = await import('./DropdownMenu');
        const onSelect = vi.fn();

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'open-modal', title: 'Open modal' }],
            onSelect,
            trigger: React.createElement('View'),
        }));

        const selectableResults = screen.findByType('SelectableMenuResults' as any);
        act(() => selectableResults?.props?.onPressItem?.({ id: 'open-modal' }));
        expect(onSelect).not.toHaveBeenCalled();

        await act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 120));
        });
        expect(onSelect).toHaveBeenCalledWith('open-modal');
    });

    it('does not let the timeout fallback overtake an available animation frame', async () => {
        const scheduled: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            scheduled.push(callback);
            return scheduled.length;
        });
        const { DropdownMenu } = await import('./DropdownMenu');
        const onSelect = vi.fn();

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'open-modal', title: 'Open modal' }],
            onSelect,
            trigger: React.createElement('View'),
        }));

        vi.useFakeTimers();
        try {
            const selectableResults = screen.findByType('SelectableMenuResults' as any);
            act(() => selectableResults?.props?.onPressItem?.({ id: 'open-modal' }));

            await act(async () => {
                await vi.advanceTimersByTimeAsync(0);
            });
            expect(onSelect).not.toHaveBeenCalled();

            act(() => scheduled.shift()?.(0));
            expect(onSelect).toHaveBeenCalledWith('open-modal');
        } finally {
            vi.useRealTimers();
        }
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
        const scheduled: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            scheduled.push(callback);
            return scheduled.length;
        });
        const { DropdownMenu } = await import('./DropdownMenu');
        const onOpenChange = vi.fn();
        const onSelect = vi.fn();
        const submenuAnchorRef = { current: 'submenu-anchor' } as any;
        const boundaryRef = { current: 'scroll-boundary' } as any;

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange,
            items: [{
                id: 'move',
                title: 'Move to folder',
                submenu: {
                    items: [{ id: 'move-to-folder:root', title: 'Workspace root' }],
                },
            }],
            onSelect,
            trigger: React.createElement('View'),
            popoverBoundaryRef: boundaryRef,
            popoverPortalWebTarget: 'body',
        }));

        const rootResults = screen.findByType('SelectableMenuResults' as any);
        act(() => {
            rootResults?.props?.onOpenSubmenu?.('move', submenuAnchorRef);
        });

        expect(onSelect).not.toHaveBeenCalled();
        expect(onOpenChange).not.toHaveBeenCalledWith(false);

        const popovers = screen.findAllByType('Popover' as any);
        expect(popovers).toHaveLength(2);
        expect(popovers[1]?.props?.anchorRef).toBe(submenuAnchorRef);
        expect(popovers[1]?.props?.placement).toBe('auto-horizontal');
        expect(popovers[1]?.props?.boundaryRef).toBeNull();
        expect(popovers[1]?.props?.portal?.web).toBe(true);

        const results = screen.findAllByType('SelectableMenuResults' as any);
        expect(results).toHaveLength(2);
        act(() => {
            results[1]?.props?.onPressItem?.({ id: 'move-to-folder:root' });
        });

        expect(onOpenChange).not.toHaveBeenCalledWith(false);
        expect(onSelect).not.toHaveBeenCalled();
        act(() => scheduled.shift()?.(0));
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(onSelect).not.toHaveBeenCalled();
        act(() => scheduled.shift()?.(1));
        expect(onSelect).toHaveBeenCalledWith('move-to-folder:root');
    });

    describe('submenu hover intent', () => {
        const items = [
            { id: 'color', title: 'Set color', submenu: { items: [{ id: 'color:blue', title: 'Blue' }] } },
            { id: 'rename', title: 'Rename' },
        ];
        async function renderMenu() {
            const { DropdownMenu } = await import('./DropdownMenu');
            const screen = await renderScreen(React.createElement(DropdownMenu, {
                open: true, onOpenChange: vi.fn(), items, onSelect: vi.fn(), trigger: React.createElement('View'),
            }));
            const results = () => screen.findAllByType('SelectableMenuResults' as any)[0];
            const popovers = () => screen.findAllByType('Popover' as any);
            const submenuSurface = () => screen.findByTestId('dropdown-submenu-surface') as any;
            return { screen, results, popovers, submenuSurface };
        }
        const mouse = { nativeEvent: { pointerType: 'mouse' } };
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it('does not open a submenu when the pointer only passes over its row', async () => {
            const menu = await renderMenu();
            act(() => {
                menu.results()?.props?.onHoverItem?.({ id: 'color', hasSubmenu: true }, { current: 'row' });
            });
            act(() => {
                vi.advanceTimersByTime(40);
                menu.results()?.props?.onHoverItem?.({ id: 'rename' }, { current: 'other-row' });
            });
            act(() => {
                vi.advanceTimersByTime(1000);
            });
            expect(menu.popovers()).toHaveLength(1);
        });

        it('opens after a short dwell beside the whole parent row, so a flip to the left clears the parent menu', async () => {
            const menu = await renderMenu();
            const rowAnchor = { current: 'color-row' };
            act(() => {
                menu.results()?.props?.onHoverItem?.({ id: 'color', hasSubmenu: true }, rowAnchor);
            });
            act(() => {
                vi.advanceTimersByTime(400);
            });
            expect(menu.popovers()).toHaveLength(2);
            expect(menu.popovers()[1]?.props?.anchorRef).toBe(rowAnchor);
            expect(menu.popovers()[1]?.props?.placement).toBe('auto-horizontal');
        });

        it('closes the open submenu when another parent row is hovered, but keeps it while the pointer moves into it', async () => {
            const menu = await renderMenu();
            act(() => {
                menu.results()?.props?.onHoverItem?.({ id: 'color', hasSubmenu: true }, { current: 'row' });
            });
            act(() => {
                vi.advanceTimersByTime(400);
            });
            // Diagonal travel crosses Rename on its way into the submenu: entering the submenu keeps it.
            act(() => {
                menu.results()?.props?.onHoverItem?.({ id: 'rename' }, { current: 'other-row' });
                vi.advanceTimersByTime(60);
                menu.submenuSurface().props.onPointerEnter(mouse);
                vi.advanceTimersByTime(1000);
            });
            expect(menu.popovers()).toHaveLength(2);

            // Leaving the submenu for a sibling closes it after the grace period.
            act(() => {
                menu.submenuSurface().props.onPointerLeave(mouse);
                menu.results()?.props?.onHoverItem?.({ id: 'rename' }, { current: 'other-row' });
                vi.advanceTimersByTime(1000);
            });
            expect(menu.popovers()).toHaveLength(1);
        });

        it('ignores touch pointer leave so a tapped submenu stays open', async () => {
            const menu = await renderMenu();
            act(() => {
                menu.results()?.props?.onOpenSubmenu?.('color', { current: 'row' });
            });
            act(() => {
                menu.submenuSurface().props.onPointerLeave({ nativeEvent: { pointerType: 'touch' } });
                vi.advanceTimersByTime(1000);
            });
            expect(menu.popovers()).toHaveLength(2);
        });
    });

    it('reveals the swatch highlight only once the person hovers or uses the keyboard', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'blue', title: 'Blue', swatch: { color: '#0000FF' } }, { id: 'red', title: 'Red', swatch: { color: '#FF0000' } }],
            onSelect: vi.fn(),
            trigger: React.createElement('View'),
        }));
        const results = () => screen.findByType('SelectableMenuResults' as any);
        expect(results()?.props?.swatchHighlightVisible).toBe(false);
        act(() => {
            results()?.props?.onSelectionChange?.(1);
        });
        expect(results()?.props?.swatchHighlightVisible).toBe(true);
    });

    it('keeps the menus open for an item that finishes its own work, and announces a submenu opening', async () => {
        vi.stubGlobal('requestAnimationFrame', () => 1);
        const { DropdownMenu } = await import('./DropdownMenu');
        const onOpenChange = vi.fn();
        const onSelect = vi.fn();
        const onSubmenuOpen = vi.fn();
        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange,
            items: [{
                id: 'color',
                title: 'Set color',
                submenu: {
                    onOpen: onSubmenuOpen,
                    items: [{ id: 'color:custom-picker', title: 'Custom color…', keepMenuOpen: true }],
                },
            }],
            onSelect,
            trigger: React.createElement('View'),
        }));

        act(() => {
            screen.findByType('SelectableMenuResults' as any)?.props?.onOpenSubmenu?.('color', { current: 'anchor' });
        });
        expect(onSubmenuOpen).toHaveBeenCalledOnce();

        const results = screen.findAllByType('SelectableMenuResults' as any);
        act(() => {
            results[1]?.props?.onPressItem?.({ id: 'color:custom-picker' });
        });
        expect(onSelect).toHaveBeenCalledWith('color:custom-picker');
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
        expect(screen.findAllByType('SelectableMenuResults' as any)).toHaveLength(2);
    });

    it('waits for a submenu anchor before opening the submenu popover', async () => {
        const rafCallbacks: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            rafCallbacks.push(cb);
            return rafCallbacks.length;
        });
        const { DropdownMenu } = await import('./DropdownMenu');
        const onOpenChange = vi.fn();
        const onSelect = vi.fn();
        let anchorReady = false;
        const submenuAnchorRef = {
            current: {
                getBoundingClientRect: () => ({
                    x: 0,
                    y: 0,
                    width: anchorReady ? 1 : 0,
                    height: anchorReady ? 36 : 0,
                }),
            },
        } as any;

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange,
            items: [{
                id: 'move',
                title: 'Move to folder',
                submenu: {
                    items: [{ id: 'move-to-folder:root', title: 'Workspace root' }],
                },
            }],
            onSelect,
            trigger: React.createElement('View'),
        }));

        const rootResults = screen.findByType('SelectableMenuResults' as any);
        act(() => {
            rootResults?.props?.onOpenSubmenu?.('move', submenuAnchorRef);
        });

        expect(screen.findAllByType('Popover' as any)).toHaveLength(1);

        anchorReady = true;
        act(() => {
            rafCallbacks.shift()?.(0);
        });

        const popovers = screen.findAllByType('Popover' as any);
        expect(popovers).toHaveLength(2);
        expect(popovers[1]?.props?.anchorRef).toBe(submenuAnchorRef);
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

    it('lets IME composition own search field Enter without consuming menu navigation', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: React.createElement('View'),
            search: true,
        }));

        const input = screen.findByType('TextInput' as any);
        const event = {
            nativeEvent: { key: 'Enter', isComposing: true },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        act(() => {
            input?.props?.onKeyPress?.(event);
        });

        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopPropagation).not.toHaveBeenCalled();
        expect(handleSelectableKeyPressSpy).not.toHaveBeenCalled();
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

    it('connects top-placed menus to the trigger on the bottom edge', async () => {
        const { StyleSheet } = await import('react-native');
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

        const overlay = screen.findByType('FloatingOverlay' as any);
        const style = StyleSheet.flatten(overlay?.props?.containerStyle);

        expect(style?.borderBottomLeftRadius).toBe(0);
        expect(style?.borderBottomRightRadius).toBe(0);
        expect(style?.marginBottom).toBe(-1);
        expect(style?.borderBottomWidth).toBe(0);
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

        const overlay = screen.findByType('FloatingOverlay' as any);
        expect(overlay?.props?.surfaceChrome).toBe('theme');
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

        const overlay = screen.findByType('FloatingOverlay' as any);
        expect(overlay?.props?.scrollViewRef).toBeTruthy();
        expect(typeof overlay?.props?.onScrollViewLayout).toBe('function');
        expect(typeof overlay?.props?.onScrollViewContentSizeChange).toBe('function');
        expect(typeof overlay?.props?.onScrollViewScroll).toBe('function');

        const selectableResults = screen.findByType('SelectableMenuResults' as any);
        expect(typeof selectableResults?.props?.registerItemLayout).toBe('function');
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

    it('passes item row presentation options to selectable items without adding a default right element', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const rowContainerStyle = { paddingLeft: 28 };

        await renderScreen(React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A', rowContainerStyle }],
                    onSelect: () => {},
                    trigger: React.createElement('View'),
                }));

        expect(useSelectableMenuSpy).toHaveBeenCalled();
        const args = useSelectableMenuSpy.mock.calls[0]?.[0];
        expect(args).toBeTruthy();
        expect(Array.isArray(args.items)).toBe(true);
        expect(args.items[0]?.id).toBe('a');
        expect(args.items[0]?.right).toBe(null);
        expect(args.items[0]?.rowContainerStyle).toBe(rowContainerStyle);
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

        const rightElementScreen = await renderScreen(item?.props?.rightElement);

        expect(rightElementScreen.getTextContent()).toContain('Beta');
        const chevronIcon = findTestInstanceByTypeWithProps(rightElementScreen.tree, 'Icon' as any, { name: 'caret-down' });
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

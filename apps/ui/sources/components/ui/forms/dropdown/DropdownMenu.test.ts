import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { findTestInstanceByTypeWithProps, pressTestInstance, renderScreen } from '@/dev/testkit';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';
import type { PopoverRenderProps } from '@/components/ui/popover';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installDropdownCommonModuleMocks();

describe('DropdownMenu inline chooser content', () => {
    it('uses the resolved popover size and close lifecycle for an inline chooser', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const close = vi.fn();
        const renderContent = vi.fn(({ maxHeight, requestClose }: PopoverRenderProps) =>
            React.createElement('InlineChooser', { maxHeight, onChoose: () => requestClose('selection') }));
        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true, onOpenChange: close, items: [], onSelect: () => {}, renderContent,
        }));
        const chooser = screen.findByType('InlineChooser' as never);
        expect(chooser.props.maxHeight).toBe(200);
        expect(screen.tree.root.findAllByType('SelectableMenuResults' as never)).toHaveLength(0);
        await act(async () => { chooser.props.onChoose(); });
        expect(close).toHaveBeenCalledWith(false);
    });
});

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

/** The device the real Popover reads: it presents `phonePresentation: 'sheet'` as a sheet only on a phone. */
const popoverDevice = vi.hoisted(() => ({ phone: false }));
vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => {
        const React = require('react');
        return React.createElement(
            'Popover',
            props,
            typeof props.children === 'function'
                // A phone sheet's render props say so, as the real Popover's sheet branch does on a phone.
                ? props.children({ maxHeight: 200, maxWidth: 400, placement: props.placement ?? 'bottom', presentation: props.phonePresentation === 'sheet' && popoverDevice.phone ? 'sheet' : 'anchored', requestClose: props.onRequestClose })
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
        return React.createElement('FloatingOverlay', props, props.header, props.children);
    },
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
        scrollRegistrySpy.mockReset();
        uiItemDensitySetting = 'comfortable';
        reducedMotion = false;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('draws a shortcut hint only where a hardware keyboard can press it', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { KeyHint } = await import('@/components/ui/keyboard/KeyHint');
        const readHintRow = () => screenRef.current?.findByType('SelectableMenuResults' as never)?.props.categories[0]?.items[0]?.right ?? null;
        const screenRef: { current: Awaited<ReturnType<typeof renderScreen>> | null } = { current: null };
        const render = () => renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: () => {},
            items: [{ id: 'queue', title: 'Queue', shortcut: 'Cmd+Enter' }],
            onSelect: () => {},
            trigger: () => null,
        }));

        const listeners = { addEventListener: () => {}, removeEventListener: () => {} };
        vi.stubGlobal('window', { ...listeners, matchMedia: () => ({ matches: false }) });
        const touch = await render();
        screenRef.current = touch;
        expect(readHintRow()).toBeNull();
        await touch.unmount();

        vi.stubGlobal('window', { ...listeners, matchMedia: () => ({ matches: true }) });
        vi.stubGlobal('navigator', { maxTouchPoints: 0 });
        const desktop = await render();
        screenRef.current = desktop;
        expect(readHintRow()?.type).toBe(KeyHint);
        await desktop.unmount();
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

    it('keeps the generic trigger expanded state truthful when opened, dismissed, or closed with Escape', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Pressable } = await import('react-native');

        function ControlledDropdownMenu() {
            const [open, setOpen] = React.useState(false);
            return React.createElement(DropdownMenu, {
                open,
                onOpenChange: setOpen,
                items: [{ id: 'a', title: 'A' }],
                onSelect: () => {},
                trigger: ({ toggle }: any) => React.createElement(Pressable, {
                    testID: 'generic-dropdown-trigger',
                    onPress: toggle,
                }),
            });
        }

        const screen = await renderScreen(React.createElement(ControlledDropdownMenu));
        const getTrigger = () => screen.findByTestId('generic-dropdown-trigger');

        expect(getTrigger()?.props.accessibilityState).toEqual({ expanded: false });
        expect(getTrigger()?.props['aria-expanded']).toBe(false);

        await act(async () => {
            pressTestInstance(getTrigger()!);
        });
        await act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });

        expect(getTrigger()?.props.accessibilityState).toEqual({ expanded: true });
        expect(getTrigger()?.props['aria-expanded']).toBe(true);

        act(() => {
            screen.findByType('Popover' as any)?.props.onRequestClose();
        });
        expect(getTrigger()?.props.accessibilityState).toEqual({ expanded: false });
        expect(getTrigger()?.props['aria-expanded']).toBe(false);

        await act(async () => {
            pressTestInstance(getTrigger()!);
        });
        await act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });

        act(() => {
            screen.findByType('SelectableMenuResults' as any)?.props.onKeyDown({ nativeEvent: { key: 'Escape' } });
        });
        expect(getTrigger()?.props.accessibilityState).toEqual({ expanded: false });
        expect(getTrigger()?.props['aria-expanded']).toBe(false);
    });

    it('leaves a role-less layout wrapper trigger unannounced: aria-expanded belongs on the control inside it', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { View } = await import('react-native');
        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: () => React.createElement(View, { testID: 'wrapper-trigger' }),
        }));
        const wrapper = screen.findByTestId('wrapper-trigger');
        expect(wrapper?.props).not.toHaveProperty('aria-expanded');
        expect(wrapper?.props).not.toHaveProperty('accessibilityState');
    });

    it('uses the DOM aria contract without leaking React Native accessibility state to host triggers', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: () => React.createElement('button', {
                'data-testid': 'web-dropdown-trigger',
                type: 'button',
            }),
        }));

        const trigger = screen.findByTestId('web-dropdown-trigger');
        expect(trigger?.props['aria-expanded']).toBe(true);
        expect(trigger?.props).not.toHaveProperty('accessibilityState');
    });

    it('provides the controlled expanded state to Item-style triggers', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const renderDropdown = (open: boolean) => React.createElement(DropdownMenu, {
            open,
            onOpenChange: vi.fn(),
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            itemTrigger: { title: 'Pick one' },
        });
        const screen = await renderScreen(renderDropdown(false));

        expect(screen.findByType('Item' as any)?.props.accessibilityExpanded).toBe(false);

        act(() => {
            screen.tree.update(renderDropdown(true));
        });

        expect(screen.findByType('Item' as any)?.props.accessibilityExpanded).toBe(true);
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

    it('does not call every empty menu a command list', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true, onOpenChange: vi.fn(), items: [], onSelect: vi.fn(), trigger: React.createElement('View'),
        }));

        expect(screen.findByType('SelectableMenuResults' as any)?.props?.emptyLabel).toBe('common.noMatches');
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
        expect(onSelect).toHaveBeenCalledWith('a', { anchor: expect.objectContaining({ kind: 'view' }) });
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
        const { DropdownMenu } = await import('./DropdownMenu');
        const events: string[] = [];

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: (open) => events.push(open ? 'open' : 'close'),
            items: [{ id: 'open-modal', title: 'Open modal' }],
            onSelect: () => events.push('select'),
            trigger: React.createElement('View'),
        }));
        const event = {
            nativeEvent: { key: 'Enter' },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        act(() => screen.findByType('SelectableMenuResults' as any)?.props?.onKeyDown?.(event));

        expect(events).toEqual(['close']);
        act(() => scheduled.shift()?.(0));
        expect(events).toEqual(['close', 'select']);
    });

    it('uses the same close-before-commit sequence for keyboard create-item selection', async () => {
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
            items: [],
            onSelect: vi.fn(),
            onCreateItem: (query) => events.push(`create:${query}`),
            trigger: React.createElement('View'),
            search: true,
        }));
        const { CompactSearchField } = await import('@/components/ui/forms/CompactSearchField');
        act(() => screen.findByType(CompactSearchField).props.onChangeText('  New tag  '));
        const event = {
            nativeEvent: { key: 'Enter' },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        act(() => screen.findByType('SelectableMenuResults' as any)?.props?.onKeyDown?.(event));

        expect(events).toEqual(['close']);
        act(() => scheduled.shift()?.(0));
        expect(events).toEqual(['close', 'create:New tag']);
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
        expect(onSelect).toHaveBeenCalledWith('open-modal', { anchor: expect.objectContaining({ kind: 'view' }) });
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

        // Keep the explicitly queued frame boundary; default fake timers replace rAF too.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const selectableResults = screen.findByType('SelectableMenuResults' as any);
            act(() => selectableResults?.props?.onPressItem?.({ id: 'open-modal' }));

            await act(async () => {
                await vi.advanceTimersByTimeAsync(0);
            });
            expect(onSelect).not.toHaveBeenCalled();

            expect(scheduled).toHaveLength(1);
            act(() => scheduled.shift()?.(0));
            expect(onSelect).toHaveBeenCalledWith('open-modal', { anchor: expect.objectContaining({ kind: 'view' }) });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(100);
            });
            expect(onSelect).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('moves web focus into the open menu through the shared popover owner', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const screen = await renderScreen(React.createElement(DropdownMenu, {
            open: true,
            onOpenChange: vi.fn(),
            items: [
                { id: 'global', title: 'Global' },
                { id: 'session', title: 'Session' },
            ],
            selectedId: 'session',
            onSelect: vi.fn(),
            trigger: React.createElement('View'),
        }));

        const popover = screen.findByType('Popover' as any);
        expect(popover.props.autoFocusOnOpen).toBe(true);
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

        expect(onSelect).toHaveBeenCalledWith('a', { anchor: expect.objectContaining({ kind: 'view' }) });
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('bounds a menu by the window it opens in, not a fixed height, while still preferring to open below', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const screen = await renderScreen(React.createElement(DropdownMenu as any, {
            open: true,
            onOpenChange: () => {},
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            trigger: React.createElement('View'),
        }));
        const popover = screen.findByType('Popover' as any);
        // The test window is 600 tall: the menu may use all of it, and opens below when 320 fits.
        expect(popover?.props?.maxHeightCap).toBe(600);
        expect(popover?.props?.placementMinSpace).toBe(320);

        const capped = await renderScreen(React.createElement(DropdownMenu as any, {
            open: true,
            onOpenChange: () => {},
            items: [{ id: 'a', title: 'A' }],
            onSelect: () => {},
            maxHeightCap: 240,
            trigger: React.createElement('View'),
        }));
        expect(capped.findByType('Popover' as any)?.props?.maxHeightCap).toBe(240);
        expect(capped.findByType('Popover' as any)?.props?.placementMinSpace).toBe(240);
    });

    it('titles a submenu by its own name once, never again as the first heading of its phone sheet', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const chooserTitle = 'Move “Client work” to';
        const render = async (phone: boolean) => {
            popoverDevice.phone = phone;
            const screen = await renderScreen(React.createElement(DropdownMenu as any, {
                open: true,
                onOpenChange: vi.fn(),
                ...(phone ? { popoverPhonePresentation: 'sheet' } : {}),
                items: [{
                    id: 'move',
                    title: 'Move to folder…',
                    submenu: {
                        title: chooserTitle,
                        showCategoryTitles: true,
                        items: [
                            { id: 'top', title: 'Top level', category: chooserTitle },
                            { id: 'reviews', title: 'Reviews', category: chooserTitle },
                        ],
                    },
                }],
                onSelect: vi.fn(),
                trigger: React.createElement('View'),
            }));
            act(() => {
                screen.findByType('SelectableMenuResults' as any)?.props?.onOpenSubmenu?.('move', {
                    current: { getBoundingClientRect: () => ({ width: 4, height: 48 }) },
                });
            });
            const popover = screen.findAllByType('Popover' as any)[1];
            const results = screen.findAllByType('SelectableMenuResults' as any)[1];
            const seen = { label: popover?.props?.accessibilityLabel, headings: results?.props?.categories?.map((category: { title: string }) => category.title) };
            act(() => { screen.tree.unmount(); });
            return seen;
        };
        expect(await render(true)).toEqual({ label: chooserTitle, headings: [''] });
        // A desktop menu has no title of its own, so its chooser keeps the heading.
        expect(await render(false)).toEqual({ label: chooserTitle, headings: [chooserTitle] });
        popoverDevice.phone = false;
    });

    it('presents a menu whose rows open submenus as a phone panel, so its submenus push inside it rather than squeeze beside it', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const render = (items: readonly unknown[]) => renderScreen(React.createElement(DropdownMenu as any, {
            open: true, onOpenChange: vi.fn(), items, onSelect: vi.fn(), trigger: React.createElement('View'),
        }));
        const withSubmenu = await render([
            { id: 'mark', title: 'Leading mark', submenu: { placement: 'right', items: [{ id: 'auto', title: 'Auto' }] } },
            { id: 'status', title: 'Status words' },
        ]);
        expect(withSubmenu.findAllByType('Popover' as any)[0]?.props?.phonePresentation).toBe('panel');
        act(() => {
            withSubmenu.findByType('SelectableMenuResults' as any)?.props?.onOpenSubmenu?.('mark', {
                current: { getBoundingClientRect: () => ({ width: 300, height: 44 }) },
            });
        });
        // Popover decides from the device: on a phone the submenu pushes inside the menu in place.
        expect(withSubmenu.findAllByType('Popover' as any)[1]?.props?.phonePresentation).toBe('panel');
        act(() => { withSubmenu.tree.unmount(); });

        const plain = await render([{ id: 'status', title: 'Status words' }]);
        expect(plain.findAllByType('Popover' as any)[0]?.props?.phonePresentation).toBeUndefined();
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
        expect(onSelect).toHaveBeenCalledWith('color:custom-picker', { anchor: expect.objectContaining({ kind: 'view' }) });
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
        expect(screen.findAllByType('SelectableMenuResults' as any)).toHaveLength(2);
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
        expect(popovers[1]?.props?.portal?.web).toBe(true);

        const results = screen.findAllByType('SelectableMenuResults' as any);
        expect(results).toHaveLength(2);

        act(() => {
            results[1]?.props?.onPressItem?.({ id: 'folder-planning' });
        });

        expect(onOpenChange).not.toHaveBeenCalledWith(false);
        expect(onSelect).not.toHaveBeenCalled();
        act(() => scheduled.shift()?.(0));
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(onSelect).not.toHaveBeenCalled();
        act(() => scheduled.shift()?.(1));
        expect(onSelect).toHaveBeenCalledWith('folder-planning', { anchor: expect.objectContaining({ kind: 'view' }) });
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

        const screen = await renderScreen(React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange: vi.fn(),
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: React.createElement('View'),
                }));

        const results = screen.findByType('SelectableMenuResults' as any);
        expect(results?.props.categories[0]?.items[0]).toMatchObject({ id: 'a', right: null });
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

    it('pins the search field in the overlay header, never inside the scrolling results', async () => {
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

        // A long list scrolled to its current choice must never carry the field out of view.
        const results = screen.findByType('SelectableMenuResults' as any)!;
        expect(results.findAllByType(TextInput as any)).toEqual([]);
        expect(screen.findAllByType(TextInput as any)).toHaveLength(1);
    });
});

describe('untitleSheetCategories', () => {
    it('drops a leading heading that repeats the sheet title', async () => {
        const { untitleSheetCategories } = await import('./DropdownMenu');
        const out = untitleSheetCategories([{ title: 'More', items: [1] }, { title: 'Other', items: [2] }], 'More');
        expect(out.map((category) => category.title)).toEqual(['', 'Other']);
    });

    it('keeps the repeated heading when an earlier titled group precedes it, so its rows do not join that group', async () => {
        const { untitleSheetCategories } = await import('./DropdownMenu');
        const out = untitleSheetCategories([{ title: 'On the bar', items: [1] }, { title: 'More', items: [2] }], 'More');
        expect(out.map((category) => category.title)).toEqual(['On the bar', 'More']);
    });
});

import React from 'react';
import { StyleSheet } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installDropdownCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    },
});

vi.mock('@/components/ui/lists/SelectableRow', () => ({
    SelectableRow: (props: any) => {
        const React = require('react');
        return React.createElement('SelectableRow', props);
    },
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => {
        const React = require('react');
        return React.createElement('Item', props);
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: {
        Provider: ({ children }: any) => children,
    },
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    ItemGroupRowPositionBoundary: ({ children }: any) => children,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    const parts = (Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean);
    return Object.assign({}, ...(parts as Array<Record<string, unknown>>));
}

describe('SelectableMenuResults', () => {
    it('marks the current choice of a choice row, and only that row', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');
        const screen = await renderScreen(<SelectableMenuResults
                    categories={[{ id: 'view', title: 'View', items: [
                        { id: 'files', title: 'Files', checked: true },
                        { id: 'walkthrough', title: 'Walkthrough', checked: false },
                        { id: 'find', title: 'Find in changes' },
                    ] }]}
                    selectedIndex={-1}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    emptyLabel="Empty"
                />);
        const rows = screen.findAllByType('SelectableRow' as never);
        const rightOf = (title: string) => rows.find((row) => row.props.title === title)?.props.right ?? null;
        expect(rightOf('Files')).not.toBeNull();
        expect(rightOf('Walkthrough')).toBeNull();
        expect(rightOf('Find in changes')).toBeNull();
    });

    it('keeps one text edge when only some rows of a menu carry an icon, and adds no slot to a menu with none', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');
        const render = (items: Array<{ id: string; title: string; left?: React.ReactNode }>) => renderScreen(<SelectableMenuResults
            categories={[{ id: 'tabs', title: '', items }]}
            selectedIndex={-1}
            onSelectionChange={() => {}}
            onPressItem={() => {}}
            rowVariant="slim"
            emptyLabel="Empty"
        />);
        const mixed = await render([
            { id: 'pin', title: 'Pin tab', left: <React.Fragment>{'icon'}</React.Fragment> },
            { id: 'others', title: 'Close other tabs' },
        ]);
        const leftOf = (screen: typeof mixed, title: string) => screen.findAllByType('SelectableRow' as never)
            .find((row) => row.props.title === title)?.props.left ?? null;
        expect(leftOf(mixed, 'Close other tabs')).not.toBeNull();
        const plain = await render([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
        expect(leftOf(plain, 'A')).toBeNull();
        expect(leftOf(plain, 'B')).toBeNull();
    });

    // Owner 17:48 (My work View popover): icon-less sections sat indented to the Organize section's icon column.
    // The leading column is reserved per section, so a section with no icon starts at the menu's text edge.
    it('reserves the leading icon column per section, not per menu', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');
        const screen = await renderScreen(<SelectableMenuResults
            categories={[
                { id: 'view', title: 'View', items: [{ id: 'projects', title: 'Projects' }, { id: 'recent', title: 'Recent activity' }] },
                { id: 'organize', title: 'Organize', items: [
                    { id: 'new', title: 'New section', left: <React.Fragment>{'icon'}</React.Fragment> },
                    { id: 'plain', title: 'Plain row' },
                ] },
            ]}
            selectedIndex={-1}
            onSelectionChange={() => {}}
            onPressItem={() => {}}
            rowVariant="slim"
            emptyLabel="Empty"
        />);
        const leftOf = (title: string) => screen.findAllByType('SelectableRow' as never)
            .find((row) => row.props.title === title)?.props.left ?? null;
        expect(leftOf('Projects')).toBeNull();
        expect(leftOf('Recent activity')).toBeNull();
        expect(leftOf('Plain row')).not.toBeNull();
    });

    it('omits the category title row when the category title is empty', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
                    categories={[
                        { id: 'c1', title: '', items: [{ id: 'a', title: 'A' }] },
                    ]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    emptyLabel="Empty"
                />);

        expect(screen.tree).not.toBeNull();
        expect(screen.findAllByType('Text')).toHaveLength(0);
    });

    it('renders nothing for empty results when emptyLabel is null', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
                    categories={[]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    emptyLabel={null as any}
                />);

        expect(screen.tree).not.toBeNull();
        expect(screen.tree.toJSON()).toBe(null);
    });

    it('keeps hook order stable when empty results become populated', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
                    categories={[]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    emptyLabel={null as any}
                />);

        expect(screen.tree.toJSON()).toBe(null);

        expect(() => {
            act(() => {
                screen.tree.update(<SelectableMenuResults
                            categories={[
                                { id: 'c1', title: '', items: [{ id: 'a', title: 'A' }] },
                            ]}
                            selectedIndex={0}
                            onSelectionChange={() => {}}
                            onPressItem={() => {}}
                            rowVariant="slim"
                            emptyLabel={null as any}
                        />);
            });
        }).not.toThrow();

        expect(screen.findByType('SelectableRow')).toBeTruthy();
    });

    it('prefers an explicit item testID over the generated dropdown id', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
                    categories={[
                        { id: 'c1', title: '', items: [{ id: 'a', title: 'Alpha', testID: 'agent-input-chip-picker.option:a' } as any] },
                    ]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    rowKind="item"
                    itemProps={{ density: 'compact' }}
                />);

        const item = screen.findByType('Item');
        expect(item.props.testID).toBe('agent-input-chip-picker.option:a');
    });

    it('forwards compact item props to item rows', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
                    categories={[
                        { id: 'c1', title: '', items: [{ id: 'a', title: 'Alpha', subtitle: 'Selected subtitle' }] },
                    ]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    rowKind="item"
                    itemProps={{ density: 'compact' }}
                />);

        const item = screen.findByType('Item');
        expect(item.props.density).toBe('compact');
        expect(item.props.subtitle).toBe('Selected subtitle');
    });

    it('stretches every item row frame to the popover content width', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
                    categories={[
                        { id: 'c1', title: '', items: [{ id: 'short', title: 'Short' }, { id: 'long', title: 'A much longer option label' }] },
                    ]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    rowKind="item"
                />);

        const frames = [
            screen.findByTestId('dropdown-option-short:scroll-frame'),
            screen.findByTestId('dropdown-option-long:scroll-frame'),
        ];
        // The web frame is a plain element: it must stretch its row as a View would, or a <button>
        // row shrinks to its label and its highlight covers part of the menu.
        expect(frames.every((frame) => (
            frame?.props.style?.width === '100%'
            && frame?.props.style?.display === 'flex'
            && frame?.props.style?.flexDirection === 'column'
            && frame?.props.style?.alignItems === 'stretch'
        ))).toBe(true);
        // Each row then spans the menu edge to edge (owner 2026-11-08): no side inset, no rounded pill.
        expect(screen.findAllByType('Item').every((item) => {
            const style = Object.assign({}, ...[item.props.pressableStyle].flat(Infinity).filter(Boolean));
            return style.alignSelf === 'stretch'
                && (style.marginHorizontal ?? 0) === 0
                && (style.borderRadius ?? 0) === 0;
        })).toBe(true);
    });

    it('registers row layouts for the dropdown scroll owner', async () => {
        const registerItemLayout = vi.fn((key: string) => (event: unknown) => {
            void key;
            void event;
        });
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
            categories={[
                { id: 'c1', title: '', items: [{ id: 'a', title: 'Alpha' }] },
            ]}
            selectedIndex={0}
            onSelectionChange={() => {}}
            onPressItem={() => {}}
            rowVariant="slim"
            registerItemLayout={registerItemLayout}
        />);

        const rowFrame = screen.findByTestId('dropdown-option-a:scroll-frame');
        expect(rowFrame).not.toBeNull();
        expect(typeof rowFrame?.props?.onLayout).toBe('function');

        rowFrame?.props?.onLayout?.({ nativeEvent: { layout: { y: 64, height: 40 } } });

        expect(registerItemLayout).toHaveBeenCalledWith('a');
    });

    it('opens submenu rows through a row-edge anchor without selecting the parent item', async () => {
        const onSelectionChange = vi.fn();
        const onPressItem = vi.fn();
        const onOpenSubmenu = vi.fn();
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
            categories={[
                { id: 'c1', title: '', items: [{ id: 'move', title: 'Move', hasSubmenu: true } as any] },
            ]}
            selectedIndex={0}
            onSelectionChange={onSelectionChange}
            onPressItem={onPressItem}
            onOpenSubmenu={onOpenSubmenu as any}
            rowVariant="slim"
        />);

        const row = screen.findByType('SelectableRow');
        act(() => {
            row.props.onHover?.();
        });

        expect(onSelectionChange).toHaveBeenCalledWith(0);
        expect(onOpenSubmenu).toHaveBeenCalledWith('move', expect.objectContaining({ current: null }));
        expect(onPressItem).not.toHaveBeenCalled();

        const submenuAnchor = screen.findByTestId('dropdown-option-move:submenu-anchor');
        expect(submenuAnchor).toBeTruthy();

        act(() => {
            row.props.onPress?.();
        });

        expect(onOpenSubmenu).toHaveBeenCalledTimes(2);
        expect(onPressItem).not.toHaveBeenCalled();
    });

    it('left aligns category titles with slim dropdown rows', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
                    categories={[
                        { id: 'c1', title: 'Sort by', items: [{ id: 'a', title: 'Alpha' }] },
                    ]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                />);

        const categoryTitle = screen.findByType('Text');
        expect(StyleSheet.flatten(categoryTitle.props.style)).toMatchObject({ paddingHorizontal: 16 });
    });

    it('renders swatch items as one row of colour radios that report the chosen one', async () => {
        const onPressItem = vi.fn();
        const onSelectionChange = vi.fn();
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
            categories={[{
                id: 'c1',
                title: '',
                items: [
                    { id: 'color:blue', title: 'Blue', checked: true, swatch: { color: '#0000FF', group: 'presets' } },
                    { id: 'color:red', title: 'Red', checked: false, swatch: { color: '#FF0000', group: 'presets' } },
                    { id: 'color:orange', title: 'Orange', checked: false, subtitle: 'From the project', swatch: { color: '#FFAA00', group: 'presets', inherited: true } },
                    { id: 'color:custom', title: 'Custom' },
                ],
            }]}
            selectedIndex={-1}
            onSelectionChange={onSelectionChange}
            onPressItem={onPressItem}
            rowVariant="slim"
        />);

        expect(screen.findAllByType('SelectableRow').map((row) => row.props.title)).toEqual(['Custom']);
        const blue = screen.findByTestId('dropdown-option-color_blue') as any;
        const red = screen.findByTestId('dropdown-option-color_red') as any;
        const orange = screen.findByTestId('dropdown-option-color_orange') as any;
        expect(blue.props.accessibilityRole).toBe('radio');
        expect(blue.props.accessibilityLabel).toBe('Blue');
        expect(blue.props.accessibilityState).toMatchObject({ checked: true });
        expect(red.props.accessibilityState).toMatchObject({ checked: false });
        expect(orange.props.accessibilityState).toMatchObject({ checked: false });
        expect(orange.props.accessibilityHint).toBe('From the project');

        await act(async () => {
            red.props.onHoverIn?.();
            red.props.onPress?.();
        });
        expect(onSelectionChange).toHaveBeenCalledWith(1);
        expect(onPressItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'color:red' }));
    });

    it('draws an empty swatch as the Remove choice in the same radio row', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');
        const screen = await renderScreen(<SelectableMenuResults
            categories={[{ id: 'c1', title: '', items: [
                { id: 'color:remove', title: 'Remove color', checked: false, swatch: { color: '', empty: true, group: 'custom' } },
                { id: 'color:#123456', title: 'Custom color #123456', checked: false, swatch: { color: '#123456', group: 'custom' } },
            ] }]}
            selectedIndex={-1}
            onSelectionChange={() => {}}
            onPressItem={() => {}}
            rowVariant="slim"
        />);
        const remove = screen.findByTestId('dropdown-option-color_remove') as any;
        expect(remove.props.accessibilityRole).toBe('radio');
        expect(remove.props.accessibilityLabel).toBe('Remove color');
        expect(remove.props.accessibilityState).toMatchObject({ checked: false });
        expect(screen.findByTestId('dropdown-option-color_remove:strike')).not.toBeNull();
    });

    it('draws the swatch highlight only when the menu says it is visible', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');
        const render = (visible: boolean) => renderScreen(<SelectableMenuResults
            categories={[{ id: 'c1', title: '', items: [{ id: 'color:blue', title: 'Blue', swatch: { color: '#0000FF' } }] }]}
            selectedIndex={0}
            swatchHighlightVisible={visible}
            onSelectionChange={() => {}}
            onPressItem={() => {}}
            rowVariant="slim"
        />);
        expect((await render(false)).findByTestId('dropdown-option-color_blue:highlight')).toBeNull();
        expect((await render(true)).findByTestId('dropdown-option-color_blue:highlight')).not.toBeNull();
    });
});

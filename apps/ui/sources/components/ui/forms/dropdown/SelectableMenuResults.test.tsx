import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
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

describe('SelectableMenuResults', () => {
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

    it('can render items after previously rendering empty results', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
                    categories={[]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    emptyLabel={null}
                />);

        act(() => {
            screen.tree.update(
                <SelectableMenuResults
                    categories={[
                        { id: 'c1', title: '', items: [{ id: 'a', title: 'A' }] },
                    ]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    emptyLabel={null}
                />,
            );
        });

        expect(screen.findByType('SelectableRow')).not.toBeNull();
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

        expect(registerItemLayout).toHaveBeenCalledWith('0');
    });

    it('reports every hovered row to the menu with the whole row as the submenu anchor', async () => {
        const onHoverItem = vi.fn();
        const onOpenSubmenu = vi.fn();
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
            categories={[
                { id: 'c1', title: '', items: [{ id: 'move', title: 'Move', hasSubmenu: true }, { id: 'rename', title: 'Rename' }] },
            ]}
            selectedIndex={0}
            onSelectionChange={() => {}}
            onPressItem={() => {}}
            onHoverItem={onHoverItem}
            onOpenSubmenu={onOpenSubmenu}
            rowVariant="slim"
        />);

        // No narrow edge strip: a submenu anchored to the row flips left without covering its parent.
        expect(screen.findByTestId('dropdown-option-move:submenu-anchor')).toBeNull();
        const rows = screen.findAllByType('SelectableRow');
        await act(async () => {
            rows[0]!.props.onHover();
            rows[1]!.props.onHover();
            rows[0]!.props.onPress();
        });
        expect(onHoverItem.mock.calls.map(([item]) => item.id)).toEqual(['move', 'rename']);
        expect(onOpenSubmenu).toHaveBeenCalledWith('move', onHoverItem.mock.calls[0]![1]);
    });

    it('renders swatch items as pressable colour choices that report the chosen one', async () => {
        const onPressItem = vi.fn();
        const onSelectionChange = vi.fn();
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
            categories={[
                {
                    id: 'c1',
                    title: '',
                    items: [
                        { id: 'color:blue', title: 'Blue', swatch: { color: '#0000FF', checked: true } },
                        { id: 'color:red', title: 'Red', swatch: { color: '#FF0000' } },
                        { id: 'color:custom', title: 'Custom' },
                    ],
                },
            ]}
            selectedIndex={-1}
            onSelectionChange={onSelectionChange}
            onPressItem={onPressItem}
            rowVariant="slim"
        />);

        expect(screen.findAllByType('SelectableRow').map((row) => row.props.title)).toEqual(['Custom']);
        const blue = screen.findByTestId('dropdown-option-color_blue') as any;
        const red = screen.findByTestId('dropdown-option-color_red') as any;
        expect(blue.props.accessibilityLabel).toBe('Blue');
        expect(blue.props.accessibilityRole).toBe('radio');
        expect(blue.props.accessibilityState).toMatchObject({ checked: true });
        expect(red.props.accessibilityState).toMatchObject({ checked: false });

        await act(async () => {
            red.props.onHoverIn?.();
            red.props.onPress?.();
        });

        expect(onSelectionChange).toHaveBeenCalledWith(1);
        expect(onPressItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'color:red' }));
    });

    it('presents an inherited swatch as unselected with an explanatory hint', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
            categories={[{
                id: 'c1',
                title: '',
                items: [{ id: 'color:orange', title: 'Orange', subtitle: 'From the project', swatch: { color: '#FFAA00', inherited: true } }],
            }]}
            selectedIndex={-1}
            onSelectionChange={() => {}}
            onPressItem={() => {}}
            rowVariant="slim"
        />);

        const orange = screen.findByTestId('dropdown-option-color_orange') as any;
        expect(orange.props.accessibilityState).toMatchObject({ checked: false });
        expect(orange.props.accessibilityHint).toBe('From the project');
    });

    it('draws an empty swatch as the Remove choice in the same radio row', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');
        const screen = await renderScreen(<SelectableMenuResults
            categories={[{ id: 'c1', title: '', items: [
                { id: 'color:remove', title: 'Remove color', swatch: { color: '', empty: true, group: 'custom' } },
                { id: 'color:#123456', title: 'Custom color #123456', swatch: { color: '#123456', group: 'custom' } },
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

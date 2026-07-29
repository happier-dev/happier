import React from 'react';
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
        expect(frames.every((frame) => frame?.props.style?.width === '100%')).toBe(true);
        expect(screen.findAllByType('Item').every((item) => (
            Array.isArray(item.props.pressableStyle)
            && item.props.pressableStyle.some((style: unknown) => (
                style !== null
                && typeof style === 'object'
                && 'width' in style
                && style.width === '100%'
            ))
        ))).toBe(true);
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
        expect(categoryTitle.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({
                paddingHorizontal: 16,
            }),
        ]));
    });
});

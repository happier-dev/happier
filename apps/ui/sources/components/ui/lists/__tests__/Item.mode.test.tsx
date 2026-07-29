import React from 'react';
import { act } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, flattenTestStyle, renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '../uiListsTestHelpers';
import { lightTheme } from '@/theme';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let uiItemDensitySetting: 'comfortable' | 'cozy' | 'compact' = 'comfortable';

function findTextNode(screen: Pick<ReactTestRenderer | ReactTestInstance, 'findAllByType'>, text: string) {
    return findTestInstanceByTypeWithProps(screen, 'Text' as any, { children: text });
}

function findHostNodeByTestID(
    screen: { findAllByTestId: (testID: string) => ReactTestInstance[] },
    testID: string,
) {
    return screen.findAllByTestId(testID).find((node) => typeof node.type === 'string');
}

function hasAncestor(node: ReactTestInstance, ancestor: ReactTestInstance) {
    let parent = node.parent;
    while (parent) {
        if (parent === ancestor) return true;
        parent = parent.parent;
    }
    return false;
}

installUiListsCommonModuleMocks();

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => 'middle',
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => ({}),
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: any) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiItemDensity') return uiItemDensitySetting;
        if (key === 'uiFontScale') return 1;
        return null;
    },
}));

describe('Item mode prop', () => {
    beforeEach(() => {
        vi.resetModules();
        uiItemDensitySetting = 'comfortable';
    });

    it('renders a Pressable when mode is undefined and onPress is set', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Test" testID="item-default" onPress={() => {}} />);
        expect(findHostNodeByTestID(screen, 'item-default')?.type).toBe('Pressable');
    });

    it('renders a View (not Pressable) when mode="info" even with onPress', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Info Item" testID="item-info" mode="info" onPress={() => {}} />);
        expect(findHostNodeByTestID(screen, 'item-info')?.type).toBe('View');
    });

    it('never shows chevron when mode="info" regardless of showChevron prop', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Info" mode="info" showChevron={true} onPress={() => {}} />);
        expect(screen.findAllByProps({ name: 'chevron-forward' })).toHaveLength(0);
    });

    it('does NOT reduce opacity when mode="info" (unlike disabled)', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Info" testID="item-info-opacity" mode="info" />);
        const root = findHostNodeByTestID(screen, 'item-info-opacity');
        if (!root) {
            throw new Error('Expected info item host node to render');
        }
        const flattened = flattenTestStyle(root.props.style);
        expect(flattened.opacity).not.toBe(0.5);
    });

    it('reduces opacity when disabled (not mode="info")', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Disabled" testID="item-disabled-opacity" disabled={true} onPress={() => {}} />);
        const root = findHostNodeByTestID(screen, 'item-disabled-opacity');
        if (!root) {
            throw new Error('Expected disabled item host node to render');
        }
        const styleFn = root.props.style;
        expect(typeof styleFn).toBe('function');
        const resolved = styleFn({ pressed: false });
        const flattened = flattenTestStyle(resolved);
        expect(flattened.opacity).toBe(0.5);
        expect(root.props['data-disabled']).toBe('true');
    });

    it('renders a Pressable when mode="interactive" with onPress', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Interactive" testID="item-interactive" mode="interactive" onPress={() => {}} />);
        expect(findHostNodeByTestID(screen, 'item-interactive')?.type).toBe('Pressable');
    });

    it('uses the middle global item density when density prop is omitted', async () => {
        uiItemDensitySetting = 'cozy';
        const { Item } = await import('../Item');

        const screen = await renderScreen(<Item title="Compact by setting" subtitle="Subtitle" />);

        const titleNode = findTextNode(screen, 'Compact by setting');
        expect(flattenTestStyle(titleNode?.props?.style)).toMatchObject({ fontSize: 14, lineHeight: 20 });
        uiItemDensitySetting = 'comfortable';
    });

    it('preserves an explicit density prop over the global item density', async () => {
        uiItemDensitySetting = 'compact';
        const { Item } = await import('../Item');

        const screen = await renderScreen(<Item title="Explicit density" subtitle="Subtitle" density="comfortable" />);

        const titleNode = findTextNode(screen, 'Explicit density');
        expect(flattenTestStyle(titleNode?.props?.style)).not.toMatchObject({ fontSize: 13, lineHeight: 18 });
        uiItemDensitySetting = 'comfortable';
    });

    it('applies the resolved density to right-side detail text', async () => {
        uiItemDensitySetting = 'compact';
        const { Item } = await import('../Item');

        const screen = await renderScreen(<Item title="Detail row" detail="Compact detail" />);

        const detailNode = findTextNode(screen, 'Compact detail');
        expect(detailNode?.props?.style).toEqual(expect.arrayContaining([expect.objectContaining({ fontSize: 13, lineHeight: 18 })]));
        uiItemDensitySetting = 'comfortable';
    });

    it('forces icon prop size to the resolved density size', async () => {
        uiItemDensitySetting = 'cozy';
        const { Item } = await import('../Item');

        const screen = await renderScreen(
            <Item
                title="Density icon"
                icon={React.createElement('Ionicons', { name: 'albums-outline', size: 29, color: '#09f' })}
            />,
        );

        const leftIcon = screen.findAllByProps({ name: 'albums-outline' })[0];
        expect(leftIcon?.props?.size).toBe(24);
        uiItemDensitySetting = 'comfortable';
    });

    it('forces chevron size to the resolved density size', async () => {
        uiItemDensitySetting = 'compact';
        const { Item } = await import('../Item');

        const screen = await renderScreen(<Item title="Chevron row" onPress={() => {}} />);

        const chevronIcon = screen.findAllByProps({ name: 'chevron-forward' })[0];
        expect(chevronIcon?.props?.size).toBe(15);
        uiItemDensitySetting = 'comfortable';
    });

    it('suppresses the chevron when a rightElement is present (default)', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(
            <Item title="Badged" onPress={() => {}} rightElement={React.createElement('Text', null, 'badge')} />,
        );
        expect(screen.findAllByProps({ name: 'chevron-forward' })).toHaveLength(0);
    });

    it('keeps the chevron alongside a rightElement when keepChevronWithRightElement is set', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(
            <Item
                title="Badged + navigates"
                onPress={() => {}}
                rightElement={React.createElement('Text', null, 'badge')}
                keepChevronWithRightElement
            />,
        );
        expect(screen.findAllByProps({ name: 'chevron-forward' }).length).toBeGreaterThan(0);
    });

    it('renders interactive rightElement controls outside the row Pressable when requested', async () => {
        const rowPressSpy = vi.fn();
        const rightPressSpy = vi.fn();
        const { Item } = await import('../Item');
        const { Pressable, Text } = await import('react-native');

        const screen = await renderScreen(
            <Item
                title="Plugin row"
                testID="plugin-row"
                onPress={rowPressSpy}
                rightElement={
                    <Pressable testID="plugin-row-action" onPress={rightPressSpy}>
                        <Text>Reload</Text>
                    </Pressable>
                }
                rightElementOutsidePressable
            />,
        );

        const row = findHostNodeByTestID(screen, 'plugin-row');
        const action = findHostNodeByTestID(screen, 'plugin-row-action');
        if (!row || !action) {
            throw new Error('Expected row and action host nodes to render');
        }

        expect(row.type).toBe('Pressable');
        expect(action.type).toBe('Pressable');
        expect(hasAncestor(action, row)).toBe(false);

        await act(async () => {
            row.props.onPress();
            action.props.onPress();
        });

        expect(rowPressSpy).toHaveBeenCalledTimes(1);
        expect(rightPressSpy).toHaveBeenCalledTimes(1);
    });

    it('renders requested interactive rightElement controls as row siblings on native', async () => {
        const reactNative = await import('react-native');
        const previousPlatform = reactNative.Platform.OS;
        reactNative.Platform.OS = 'ios';

        try {
            const { Item } = await import('../Item');
            const screen = await renderScreen(
                <Item
                    title="Model"
                    testID="native-model-row"
                    onPress={() => {}}
                    rightElement={(
                        <reactNative.Pressable testID="native-model-action" onPress={() => {}} />
                    )}
                    rightElementOutsidePressable
                />,
            );

            const row = findHostNodeByTestID(screen, 'native-model-row');
            const action = findHostNodeByTestID(screen, 'native-model-action');
            if (!row || !action) {
                throw new Error('Expected native row and action host nodes to render');
            }

            expect(row.type).toBe('Pressable');
            expect(action.type).toBe('Pressable');
            expect(hasAncestor(action, row)).toBe(false);
        } finally {
            reactNative.Platform.OS = previousPlatform;
        }
    });

    it('applies a hover background on web for interactive items', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Hover Row" testID="item-hover" onPress={() => {}} />);

        const beforeHover = findHostNodeByTestID(screen, 'item-hover');
        if (!beforeHover) {
            throw new Error('Expected hover item host node to render');
        }

        expect(typeof beforeHover.props.onHoverIn).toBe('function');
        expect(typeof beforeHover.props.onHoverOut).toBe('function');

        const beforeStyleFn = beforeHover.props.style as (state: { pressed: boolean }) => unknown;
        const beforeFlattened = flattenTestStyle(beforeStyleFn({ pressed: false }));
        expect(beforeFlattened.backgroundColor).toBe('transparent');

        await act(async () => {
            beforeHover.props.onHoverIn();
        });

        const afterHover = findHostNodeByTestID(screen, 'item-hover');
        if (!afterHover) {
            throw new Error('Expected hover item host node to render after hover');
        }

        const afterStyleFn = afterHover.props.style as (state: { pressed: boolean }) => unknown;
        const afterFlattened = flattenTestStyle(afterStyleFn({ pressed: false }));
        expect(afterFlattened.backgroundColor).toBe(lightTheme.colors.surface.pressed);
    });

    it('forwards web hover events to optional callbacks', async () => {
        const hoverInSpy = vi.fn();
        const hoverOutSpy = vi.fn();
        const { Item } = await import('../Item');

        // `Item` does not currently declare hover callback props in the public type.
        // Cast narrowly so we can TDD the API addition without weakening production types.
        const ItemAny = Item as unknown as React.ComponentType<any>;

        const screen = await renderScreen(
            <ItemAny
                title="Hover callbacks"
                testID="item-hover-callbacks"
                onPress={() => {}}
                onHoverIn={hoverInSpy}
                onHoverOut={hoverOutSpy}
            />
        );

        const host = findHostNodeByTestID(screen, 'item-hover-callbacks');
        if (!host) {
            throw new Error('Expected hover item host node to render');
        }

        await act(async () => {
            host.props.onHoverIn();
            host.props.onHoverOut();
        });

        expect(hoverInSpy).toHaveBeenCalledTimes(1);
        expect(hoverOutSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps option semantics and activates the row once from Space or Enter without stopping propagation', async () => {
        const onPress = vi.fn();
        const { Item } = await import('../Item');
        const screen = await renderScreen(
            <Item
                title="Shared model"
                testID="model-option"
                onPress={onPress}
                accessibilityRole="button"
                webRole="option"
                accessibilityLabel="Gateway, Work, Shared model"
                selected
            />,
        );

        const row = findHostNodeByTestID(screen, 'model-option');
        if (!row) throw new Error('Expected model option host node');
        expect(row.props.role).toBe('option');
        expect(row.props.accessibilityLabel).toBe('Gateway, Work, Shared model');
        expect(row.props['aria-selected']).toBe(true);
        expect(row.props.tabIndex).toBe(0);

        for (const key of [' ', 'Enter']) {
            const event = {
                key,
                nativeEvent: { key },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            };
            await act(async () => row.props.onKeyDown(event));
            expect(event.preventDefault).toHaveBeenCalledOnce();
            expect(event.stopPropagation).not.toHaveBeenCalled();
        }
        expect(onPress).toHaveBeenCalledTimes(2);
    });
});

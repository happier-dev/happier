import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '../uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => 'middle',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@/sync/store/hooks', async () => {
    const { createUseLocalSettingMock, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
    return {
        useLocalSetting: createUseLocalSettingMock({ values: { uiItemDensity: 'cozy', uiFontScale: 1 } }),
        useSetting: createUseSettingMock({ values: { visualEffectsLevel: 'minimal' } }),
    };
});

afterEach(() => {
    standardCleanup();
});

type Style = Record<string, unknown>;

function nearestHostView(node: ReactTestInstance): ReactTestInstance {
    let parent = node.parent;
    while (parent && (parent.type as unknown) !== 'View') parent = parent.parent;
    if (!parent) throw new Error('Expected a host View around the node');
    return parent;
}

function hostByTestID(screen: { findAllByTestId: (id: string) => ReactTestInstance[] }, testID: string) {
    const node = screen.findAllByTestId(testID).find((candidate) => typeof candidate.type === 'string');
    if (!node) throw new Error(`Missing host node ${testID}`);
    return node;
}

function accessorySection(node: ReactTestInstance): ReactTestInstance {
    let parent = node.parent;
    while (parent) {
        const style = flattenTestStyle(parent.props.style ?? {});
        if ((parent.type as unknown) === 'View' && style.maxWidth && typeof style.marginLeft === 'number') return parent;
        parent = parent.parent;
    }
    throw new Error('Expected the Item accessory section');
}

function bottomPadding(style: Style): unknown {
    return style.paddingBottom ?? style.paddingVertical ?? style.padding ?? 0;
}

const LAYOUT_KEYS = ['maxWidth', 'marginLeft', 'alignSelf', 'flexDirection', 'alignItems'] as const;

function layoutOf(style: Style): Style {
    return Object.fromEntries(LAYOUT_KEYS.map((key) => [key, style[key]]));
}

async function renderPageRow(props: Readonly<{ split: boolean; accessoryLayout: 'stacked' | 'inline' }>) {
    const { Item } = await import('../Item');
    const { ListPresentationProvider } = await import('../listPresentation');
    const { View } = await import('react-native');
    return renderScreen(
        <ListPresentationProvider value="page">
            <Item
                testID="row"
                title="Source"
                onPress={() => {}}
                accessoryLayout={props.accessoryLayout}
                rightElementOutsidePressable={props.split}
                rightElement={<View testID="control" />}
            />
        </ListPresentationProvider>,
    );
}

describe('Item page accessory layout', () => {
    it('stacks a split row control under the label exactly like an ordinary stacked row', async () => {
        const ordinary = await renderPageRow({ split: false, accessoryLayout: 'stacked' });
        const ordinarySection = accessorySection(hostByTestID(ordinary, 'control'));
        const ordinaryAccessory = flattenTestStyle(ordinarySection.props.style);
        const ordinaryRow = flattenTestStyle(nearestHostView(ordinarySection).props.style);

        vi.resetModules();
        const split = await renderPageRow({ split: true, accessoryLayout: 'stacked' });
        const splitAccessory = flattenTestStyle(accessorySection(hostByTestID(split, 'control')).props.style);

        // The control spans the row (no half-width cap, no inset) ...
        expect(layoutOf(splitAccessory)).toEqual(layoutOf(ordinaryAccessory));
        // ... and keeps the row's bottom padding instead of sitting on the divider.
        expect(bottomPadding(splitAccessory)).toBe(bottomPadding(ordinaryRow));
        expect(bottomPadding(splitAccessory)).not.toBe(0);
    });

    it('keeps an inline split row control beside the label', async () => {
        const split = await renderPageRow({ split: true, accessoryLayout: 'inline' });
        const splitAccessory = flattenTestStyle(accessorySection(hostByTestID(split, 'control')).props.style);
        expect(splitAccessory.flexDirection).toBe('row');
        expect(splitAccessory.maxWidth).toBe('50%');
    });
});

describe('Item adaptive accessory', () => {
    function layoutEvent(width: number) {
        return { nativeEvent: { layout: { x: 0, y: 0, width, height: 48 } } };
    }

    it.each(['page', 'grouped'] as const)('moves a control beneath the label when it is wider than its half of a wide %s row', async (presentation) => {
        const { Item } = await import('../Item');
        const { ListPresentationProvider } = await import('../listPresentation');
        const { View } = await import('react-native');
        const { act } = await import('react-test-renderer');
        const screen = await renderScreen(
            <ListPresentationProvider value={presentation}>
                <Item testID="row" title="Restore memory by" accessoryLayout="adaptive" rightElement={<View testID="control" />} />
            </ListPresentationProvider>,
        );
        const accessoryHost = () => {
            let node: ReactTestInstance | null = hostByTestID(screen, 'control');
            while (node && !(flattenTestStyle(node.props.style ?? {}).maxWidth)) node = node.parent;
            if (!node) throw new Error('Expected the accessory section');
            return node;
        };
        const withLayout = (from: ReactTestInstance) => {
            const found: ReactTestInstance[] = [];
            let node: ReactTestInstance | null = from;
            while (node) {
                if (typeof node.type === 'string' && typeof node.props.onLayout === 'function') found.push(node);
                node = node.parent;
            }
            return found;
        };
        const [controlMeasure, rowMeasure] = (() => {
            const chain = withLayout(hostByTestID(screen, 'control'));
            return [chain[0]!, chain[chain.length - 1]!];
        })();

        expect(rowMeasure, 'adaptive rows measure their containing surface').toBeDefined();
        await act(async () => { rowMeasure.props.onLayout(layoutEvent(700)); });
        await act(async () => { controlMeasure.props.onLayout(layoutEvent(200)); });
        expect(flattenTestStyle(accessoryHost().props.style).maxWidth).toBe('50%');

        // A bar of long labels does not fit its half: it moves beneath the label instead of overflowing.
        await act(async () => { controlMeasure.props.onLayout(layoutEvent(420)); });
        expect(flattenTestStyle(accessoryHost().props.style).maxWidth).toBe('100%');
    });

    it.each([
        { title: 'Theme', labels: ['Light', 'Dark', 'Match system'], last: 'Match system' },
        { title: 'Thinking', labels: ['Summary', 'Full', 'Tool calls', 'Hidden'], last: 'Hidden' },
        { title: 'Notifications show', labels: ['The message', 'Only the status'], last: 'Only the status' },
    ])('keeps every $title choice reachable in a narrow grouped surface', async ({ title, labels, last }) => {
        const { SegmentedChoiceItem } = await import('../SegmentedChoiceItem');
        const { ListPresentationProvider } = await import('../listPresentation');
        const { act } = await import('react-test-renderer');
        const onChange = vi.fn();
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ListPresentationProvider value="grouped">
                    <SegmentedChoiceItem title={title} options={labels.map(label => ({ id: label, label }))}
                        value={labels[0]!} onChange={onChange} testIDPrefix="choice" />
                </ListPresentationProvider>
            </ListPresentationProvider>,
        );
        const lastOption = screen.findByTestId(`choice:${last}`)!;
        const measurementNodes: ReactTestInstance[] = [];
        let ancestor: ReactTestInstance | null = lastOption;
        while (ancestor) {
            if (typeof ancestor.type === 'string' && typeof ancestor.props.onLayout === 'function') measurementNodes.push(ancestor);
            ancestor = ancestor.parent;
        }
        // The outermost measured ancestor is the row, not the segmented bar's own layout host.
        const rowMeasure = measurementNodes.at(-1);
        expect(rowMeasure, 'adaptive rows measure their containing surface').toBeDefined();
        await act(async () => { rowMeasure!.props.onLayout(layoutEvent(330)); });
        const section = accessorySection(screen.findByTestId(`choice:${last}`)!);
        expect(flattenTestStyle(section.props.style).maxWidth).toBe('100%');
        screen.pressByTestId(`choice:${last}`);
        expect(onChange).toHaveBeenCalledWith(last);
    });
});

describe('Item leading mark on a page', () => {
    async function leadingBox(presentation: 'page' | 'grouped') {
        const { Item } = await import('../Item');
        const { ListPresentationProvider } = await import('../listPresentation');
        const { View } = await import('react-native');
        const screen = await renderScreen(
            <ListPresentationProvider value={presentation}>
                <Item title="Ada Lovelace" leftElement={<View testID="avatar" style={{ width: 36, height: 36 }} />} />
            </ListPresentationProvider>,
        );
        return flattenTestStyle(nearestHostView(hostByTestID(screen, 'avatar')).props.style);
    }

    it('grows the leading box to a mark larger than the density glyph box, so it does not overhang the sheet edge', async () => {
        const box = await leadingBox('page');
        // The box sizes to the 36px mark; the density box is only its minimum.
        expect(box.width).toBe('auto');
        expect(typeof box.minWidth).toBe('number');
        expect(box.minWidth as number).toBeLessThan(36);
    });

    it('keeps the fixed glyph box outside page presentation (menus, pickers)', async () => {
        vi.resetModules();
        const box = await leadingBox('grouped');
        expect(typeof box.width).toBe('number');
    });
});

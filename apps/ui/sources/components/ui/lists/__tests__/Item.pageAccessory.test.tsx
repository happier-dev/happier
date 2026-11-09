import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '../uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

// Collect the real component graph once; presentation is supplied through its provider.
await import('../Item');
await import('../ItemGroup');
await import('../SegmentedChoiceItem');
await import('@/components/ui/buttons/RoundButton');

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
        // A page operation is measured like an adaptive accessory: beside the label it takes what it
        // needs; only the stacked composition stretches under the label.
        expect(splitAccessory.alignSelf).not.toBe('stretch');
    });
});

describe('Item adaptive accessory', () => {
    function layoutEvent(width: number) {
        return { nativeEvent: { layout: { x: 0, y: 0, width, height: 48 } } };
    }

    it('recomposes a page operation below its label on phones while keeping the action reachable', async () => {
        const { Item } = await import('../Item');
        const { ListPresentationProvider } = await import('../listPresentation');
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const { act } = await import('react-test-renderer');
        const onPress = vi.fn();
        const screen = await renderScreen(<ListPresentationProvider value="page">
            <Item title="Add your phone" rightElementOutsidePressable accessoryLayout="inline"
                rightElement={<RoundButton title="Show QR code" testID="phone-action" onPress={onPress} />} />
        </ListPresentationProvider>);
        let ancestor: ReactTestInstance | null = hostByTestID(screen, 'phone-action');
        const measurements: ReactTestInstance[] = [];
        while (ancestor) {
            if (typeof ancestor.type === 'string' && typeof ancestor.props.onLayout === 'function') measurements.push(ancestor);
            ancestor = ancestor.parent;
        }
        expect(measurements.at(-1), 'page operation rows measure their available width').toBeDefined();
        await act(async () => { measurements.at(-1)!.props.onLayout(layoutEvent(358)); });
        expect(flattenTestStyle(accessorySection(hostByTestID(screen, 'phone-action')).props.style).maxWidth).toBe('100%');
        screen.pressByTestId('phone-action');
        expect(onPress).toHaveBeenCalledOnce();
    });

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
        const accessoryHost = () => accessorySection(hostByTestID(screen, 'control'));
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
        // Fitting its half, the control stays beside the label and takes what it needs.
        expect(flattenTestStyle(accessoryHost().props.style)).toMatchObject({ flexDirection: 'row' });
        expect(flattenTestStyle(accessoryHost().props.style).alignSelf).not.toBe('stretch');

        // A bar of long labels does not fit its half: it moves beneath the label instead of overflowing.
        await act(async () => { controlMeasure.props.onLayout(layoutEvent(420)); });
        expect(flattenTestStyle(accessoryHost().props.style)).toMatchObject({ flexDirection: 'column', alignSelf: 'stretch' });
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

describe('Item page detail on a phone', () => {
    it('measures the label with its qualifier, so a detail beside a Machine name moves beneath instead of cutting it', async () => {
        const { Item } = await import('../Item');
        const { ListPresentationProvider } = await import('../listPresentation');
        const { View } = await import('react-native');
        const { act } = await import('react-test-renderer');
        const screen = await renderScreen(<ListPresentationProvider value="page">
            <Item testID="machine" title="NLDW3-5-36-33" titleQualifier="3ca2" detail="Not shared with you"
                icon={<View />} onPress={() => {}} />
        </ListPresentationProvider>);
        const text = (node: ReactTestInstance): string => node.children
            .map(child => typeof child === 'string' ? child : text(child)).join(' ');
        const hidden = (node: ReactTestInstance) => {
            for (let current: ReactTestInstance | null = node; current; current = current.parent) {
                if (current.props['aria-hidden']) return true;
            }
            return false;
        };
        const measured = () => screen.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
        const event = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 52 } } });
        // The outermost measured host is the row, at a phone's width.
        await act(async () => { measured()[0]!.props.onLayout(event(358)); });
        // Natural widths: the name alone is 105, the name with its qualifier 150, the detail 125.
        for (const node of measured().filter(hidden)) {
            const content = text(node);
            const width = content.includes('Not shared') ? 125 : content.includes('3ca2') ? 150 : content.includes('NLDW3') ? 105 : null;
            if (width !== null) await act(async () => { node.props.onLayout(event(width)); });
        }
        const visibleDetail = screen.findAll(node => typeof node.type === 'string' && !hidden(node)
            && node.children.includes('Not shared with you'))[0]!;
        // Inline, the detail is the right-aligned meta column beside the name; beneath, it reads as the subtitle.
        expect(flattenTestStyle(visibleDetail.props.style).textAlign, 'detail moved beneath the whole name').not.toBe('right');
    });
});

describe('Item leading mark on a page', () => {
    it('keeps a stacked field label beside its reserved leading slot, without inserting a blank row', async () => {
        const { Item } = await import('../Item');
        const { ItemGroup } = await import('../ItemGroup');
        const { ListPresentationProvider } = await import('../listPresentation');
        const { View } = await import('react-native');
        const screen = await renderScreen(<ListPresentationProvider value="page"><ItemGroup>
            <Item title="Logo" leftElement={<View testID="logo" />} />
            <Item title={<View testID="description-label" />} accessoryLayout="stacked" rightElement={<View testID="description-input" />} />
        </ItemGroup></ListPresentationProvider>);
        const center = nearestHostView(hostByTestID(screen, 'description-label'));
        const labelBand = nearestHostView(center);
        expect(flattenTestStyle(labelBand.props.style).flexDirection).toBe('row');
        const reserved = labelBand.children.find(node => typeof node !== 'string'
            && node.props.accessibilityElementsHidden === true);
        expect(reserved, 'the leading reservation remains beside the label').toBeDefined();
    });
    async function leadingBox(presentation: 'page' | 'grouped', iconBoxSize?: number) {
        const { Item } = await import('../Item');
        const { ListPresentationProvider } = await import('../listPresentation');
        const { View } = await import('react-native');
        const screen = await renderScreen(
            <ListPresentationProvider value={presentation}>
                <Item title="Ada Lovelace" iconBoxSize={iconBoxSize}
                    leftElement={<View testID="avatar" style={{ width: 36, height: 36 }} />} />
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

    it('fits an oversized identity mark outside page presentation when its caller declares the leading slot size', async () => {
        const box = await leadingBox('grouped', 36);
        expect(box.width).toBe(36);
        expect(box.height).toBe(36);
    });

    it('keeps the fixed glyph box outside page presentation when no slot size is declared', async () => {
        const box = await leadingBox('grouped');
        const { ITEM_ICON_BOX_SIZE } = await import('../itemDensityMetrics');
        // The density box is the leading slot's minimum; a wider mark takes its own width (a tree row's
        // disclosure + glyph) instead of overhanging the title.
        expect(box.width).toBe('auto');
        expect(box.minWidth).toBe(ITEM_ICON_BOX_SIZE.cozy);
        expect(box.height).toBe(ITEM_ICON_BOX_SIZE.cozy);
    });
});

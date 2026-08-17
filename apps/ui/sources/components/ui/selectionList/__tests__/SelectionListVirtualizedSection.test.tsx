import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';
import { Pressable } from 'react-native';

import type { SelectionListOption, SelectionListSection } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { module: capturedLegendList, state: legendListState } = createCapturingLegendListMock({
    renderItems: true,
    renderItemLimit: 20,
});

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: capturedLegendList.LegendList,
}));

function makeOptions(count: number, prefix = 'opt'): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        label: `Option ${i}`,
    }));
}

function makeSection(count: number): SelectionListSection {
    return {
        id: 'big-section',
        title: 'BIG',
        options: makeOptions(count),
    };
}

function hasAncestor(node: any, possibleAncestor: any): boolean {
    let current = node?.parent;
    while (current) {
        if (current === possibleAncestor) return true;
        current = current.parent;
    }
    return false;
}

describe('SelectionListVirtualizedSection', () => {
    it('constructs lazy visuals only for the rendered window in the single-section path', async () => {
        legendListState.reset();
        const constructVisual = vi.fn((id: string) => <React.Fragment>{id}</React.Fragment>);
        const options: readonly SelectionListOption[] = Array.from({ length: 1_000 }, (_, index) => ({
            id: `lazy-${index}`,
            label: `Lazy ${index}`,
            subtitleContent: () => constructVisual(`subtitle-${index}`),
            icon: () => constructVisual(`icon-${index}`),
            rightAccessory: () => constructVisual(`accessory-${index}`),
        }));
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        await renderScreen(
            <SelectionListVirtualizedSection
                section={{ id: 'lazy', options }}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                onSelect={() => {}}
                onPushStep={() => {}}
                virtualization="force"
            />,
        );

        expect(legendListState.props?.data).toHaveLength(1_000);
        expect(constructVisual).toHaveBeenCalledTimes(60);
    });

    it('renders FlashList path when row count exceeds the threshold (auto mode)', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const section = makeSection(60);
        await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        expect(legendListState.props).not.toBeNull();
        expect(legendListState.props?.recycleItems).toBe(false);
        expect(Array.isArray(legendListState.props.data)).toBe(true);
        expect(legendListState.props.data.length).toBe(60);
        expect(typeof legendListState.props.renderItem).toBe('function');
        expect(typeof legendListState.props.keyExtractor).toBe('function');
    });

    it('renders plain mapped rows when row count is at or below the threshold (auto mode)', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const section = makeSection(50);
        await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        // FlashList must NOT be mounted in auto mode at exactly threshold.
        expect(legendListState.props).toBeNull();
    });

    it('renders FlashList when virtualization is forced regardless of count', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const section = { ...makeSection(3), id: 'force' };
        await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                onSelect={() => {}}
                onPushStep={() => {}}
                virtualization="force"
            />,
        );
        expect(legendListState.props).not.toBeNull();
        expect(legendListState.props.data.length).toBe(3);
    });

    it('keeps an interactive accessory outside the virtualized row pressable', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const section: SelectionListSection = {
            ...makeSection(60),
            options: [
                {
                    id: 'interactive',
                    label: 'Interactive option',
                    rightAccessory: <Pressable testID="virtualized-row-action" onPress={() => {}} />,
                    rightAccessoryOutsidePressable: true,
                },
                ...makeOptions(59, 'remaining'),
            ],
        };
        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        expect(legendListState.props?.data).toHaveLength(60);
        const row = screen.findByTestId('sl:root:option:interactive');
        const action = screen.findByTestId('virtualized-row-action');
        expect(row).toBeTruthy();
        expect(action).toBeTruthy();
        expect(hasAncestor(action, row)).toBe(false);
    });

    it('renders the canonical row surface for virtualized rows (custom content, ellipsize modes, chevron retention, expanded body)', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const section: SelectionListSection = {
            ...makeSection(60),
            options: [
                {
                    id: 'custom',
                    label: 'Custom body',
                    content: <Pressable testID="virtualized-custom-body" onPress={() => {}} />,
                },
                {
                    id: 'clamped',
                    label: 'A very long label',
                    subtitle: 'A very long subtitle',
                    labelEllipsizeMode: 'middle',
                    subtitleEllipsizeMode: 'head',
                    rightAccessory: <React.Fragment />,
                    keepChevronWithAccessory: true,
                    openStep: { id: 'child', sections: [] },
                },
                {
                    id: 'expanded',
                    label: 'Selected row',
                    expandedContent: <Pressable testID="virtualized-expanded" onPress={() => {}} />,
                },
                ...makeOptions(57, 'remaining'),
            ],
        };
        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId="expanded"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        // `option.content` is honored (the divergent renderer dropped it).
        expect(screen.findByTestId('virtualized-custom-body')).not.toBeNull();

        const clamped = screen.findAllByTestId('sl:root:option:clamped')
            .find((node) => typeof node.type === 'function');
        expect(clamped).toBeTruthy();
        expect(clamped!.props.titleEllipsizeMode).toBe('middle');
        expect(clamped!.props.subtitleEllipsizeMode).toBe('head');
        expect(clamped!.props.keepChevronWithRightElement).toBe(true);

        // The selected row's expanded body renders, outside its pressable.
        const expanded = screen.findByTestId('virtualized-expanded');
        expect(expanded).not.toBeNull();
        for (const rowNode of screen.findAllByTestId('sl:root:option:expanded')) {
            expect(hasAncestor(expanded, rowNode)).toBe(false);
        }
    });

    it('never renders FlashList when virtualization is never, even with large counts', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const section = { ...makeSection(500), id: 'never' };
        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                onSelect={() => {}}
                onPushStep={() => {}}
                virtualization="never"
            />,
        );
        expect(legendListState.props).toBeNull();
        // The first row should still render via plain mapping.
        expect(screen.findByTestId('sl:root:option:opt-0')).not.toBeNull();
    });

    it('passes a stable keyExtractor that produces option ids', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const section = makeSection(60);
        await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        expect(legendListState.props).not.toBeNull();
        const ke = legendListState.props.keyExtractor as (option: SelectionListOption, i: number) => string;
        expect(ke(section.options[0], 0)).toBe(section.options[0].id);
        expect(ke(section.options[5], 5)).toBe(section.options[5].id);
    });

    it('passes a sensible estimatedItemSize to FlashList', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const section = makeSection(60);
        await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        expect(legendListState.props).not.toBeNull();
        expect(typeof legendListState.props.estimatedItemSize).toBe('number');
        expect(legendListState.props.estimatedItemSize).toBeGreaterThan(0);
    });

    it('handles 500-row synthetic dataset without errors and exposes all option ids via data prop', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const options = makeOptions(500);
        const section: SelectionListSection = {
            id: 'huge',
            title: 'HUGE',
            options,
        };
        await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        expect(legendListState.props).not.toBeNull();
        expect(legendListState.props.data.length).toBe(500);
    });
});

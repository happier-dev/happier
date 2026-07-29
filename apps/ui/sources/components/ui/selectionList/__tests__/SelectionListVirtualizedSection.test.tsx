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
                onSelectOption={() => {}}
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
                onSelectOption={() => {}}
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
                onSelectOption={() => {}}
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
                onSelectOption={() => {}}
            />,
        );

        expect(legendListState.props?.data).toHaveLength(60);
        const row = screen.findByTestId('sl:root:option:interactive');
        const action = screen.findByTestId('virtualized-row-action');
        expect(row).toBeTruthy();
        expect(action).toBeTruthy();
        expect(hasAncestor(action, row)).toBe(false);
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
                onSelectOption={() => {}}
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
                onSelectOption={() => {}}
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
                onSelectOption={() => {}}
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
                onSelectOption={() => {}}
            />,
        );
        expect(legendListState.props).not.toBeNull();
        expect(legendListState.props.data.length).toBe(500);
    });
});

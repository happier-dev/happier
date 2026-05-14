import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingFlashListMock } from '@/dev/testkit/mocks/flashList';

import type { SelectionListOption, SelectionListSection } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { module: capturedFlashList, state: flashListState } = createCapturingFlashListMock({
    componentName: 'FlashListMock',
    itemWrapperName: 'FlashListItemMock',
    renderItems: true,
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: capturedFlashList.FlashList,
    flashListRuntime: { usingFallback: true },
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

describe('SelectionListVirtualizedSection', () => {
    it('renders FlashList path when row count exceeds the threshold (auto mode)', async () => {
        flashListState.props = null;
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
        expect(flashListState.props).not.toBeNull();
        expect(Array.isArray(flashListState.props.data)).toBe(true);
        expect(flashListState.props.data.length).toBe(60);
        expect(typeof flashListState.props.renderItem).toBe('function');
        expect(typeof flashListState.props.keyExtractor).toBe('function');
    });

    it('renders plain mapped rows when row count is at or below the threshold (auto mode)', async () => {
        flashListState.props = null;
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
        expect(flashListState.props).toBeNull();
    });

    it('renders FlashList when virtualization is forced regardless of count', async () => {
        flashListState.props = null;
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
        expect(flashListState.props).not.toBeNull();
        expect(flashListState.props.data.length).toBe(3);
    });

    it('never renders FlashList when virtualization is never, even with large counts', async () => {
        flashListState.props = null;
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
        expect(flashListState.props).toBeNull();
        // The first row should still render via plain mapping.
        expect(screen.findByTestId('sl:root:option:opt-0')).not.toBeNull();
    });

    it('passes a stable keyExtractor that produces option ids', async () => {
        flashListState.props = null;
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
        expect(flashListState.props).not.toBeNull();
        const ke = flashListState.props.keyExtractor as (option: SelectionListOption, i: number) => string;
        expect(ke(section.options[0], 0)).toBe(section.options[0].id);
        expect(ke(section.options[5], 5)).toBe(section.options[5].id);
    });

    it('passes a sensible estimatedItemSize to FlashList', async () => {
        flashListState.props = null;
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
        expect(flashListState.props).not.toBeNull();
        expect(typeof flashListState.props.estimatedItemSize).toBe('number');
        expect(flashListState.props.estimatedItemSize).toBeGreaterThan(0);
    });

    it('handles 500-row synthetic dataset without errors and exposes all option ids via data prop', async () => {
        flashListState.props = null;
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
        expect(flashListState.props).not.toBeNull();
        expect(flashListState.props.data.length).toBe(500);
    });
});

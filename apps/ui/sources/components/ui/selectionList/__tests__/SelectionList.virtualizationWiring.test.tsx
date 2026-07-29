import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';

import type { SelectionListOption, SelectionListProps, SelectionListStep } from '../_types';

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

function defaultProps(rootStep: SelectionListStep, overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep,
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

describe('SelectionList virtualization wiring (Phase 1.12)', () => {
    it('uses FlashList for sections that exceed the threshold (>50 rows, auto mode)', async () => {
        legendListState.reset();
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'big',
                    title: 'BIG',
                    options: makeOptions(80),
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        await renderScreen(<SelectionList {...defaultProps(root)} />);
        expect(legendListState.props).not.toBeNull();
        expect(legendListState.props?.data?.length).toBe(80);
    });

    it('does not virtualize small sections (<=50 rows)', async () => {
        legendListState.reset();
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'small',
                    title: 'SMALL',
                    options: makeOptions(10),
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        await renderScreen(<SelectionList {...defaultProps(root)} />);
        expect(legendListState.props).toBeNull();
    });

    it('honors per-section virtualization=force on a small section', async () => {
        legendListState.reset();
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'forced',
                    title: 'FORCED',
                    options: makeOptions(3),
                    virtualization: 'force',
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        await renderScreen(<SelectionList {...defaultProps(root)} />);
        expect(legendListState.props).not.toBeNull();
        expect(legendListState.props?.data?.length).toBe(3);
    });

    it('preserves virtualization on a synthesized dynamic section descriptor', async () => {
        legendListState.reset();
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    title: 'DYN',
                    debounceMs: 0,
                    virtualization: 'force',
                    resolve: async () => ({ options: makeOptions(2, 'd') }),
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const { act } = await import('react-test-renderer');
        await renderScreen(<SelectionList {...defaultProps(root)} />);
        // Allow microtasks for the resolver to complete.
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(legendListState.props).not.toBeNull();
        expect(legendListState.props?.data?.length).toBe(2);
    });
});

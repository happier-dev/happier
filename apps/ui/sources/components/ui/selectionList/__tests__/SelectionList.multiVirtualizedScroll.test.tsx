import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type {
    SelectionListOption,
    SelectionListProps,
    SelectionListStep,
} from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function makeOptions(count: number, prefix: string): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        label: `Label ${prefix}-${i}`,
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

/**
 * RV-9 / FRESH-3 — Multi-virtualized scroll restructure.
 *
 * Previous (broken) behavior: when a step had multiple virtualization-
 * eligible sections, the body wrapped EVERYTHING in a ScrollView AND
 * kept the first section in a FlashList — a nested FlashList-inside-
 * ScrollView. Trailing rows visible but unreachable; recycler/scroll
 * gestures fought each other.
 *
 * Current behavior (Option A): a multi-eligible step collapses ALL
 * sections into a SINGLE flat FlashList covering the entire body. No
 * outer ScrollView, no nested scroll, no broken trailing scroll. The
 * single-virtualized contract (R9) is preserved unchanged.
 */
describe('SelectionList multi-virtualized step scroll handling (RV-9)', () => {
    it('keeps the existing single-virtualized contract: no outer ScrollView when only one section virtualizes', async () => {
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'big',
                    title: 'BIG',
                    options: makeOptions(60, 'b'),
                    virtualization: 'force',
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} />);
        // Single-virtualized case: FlashList owns the scroll, no wrapping
        // ScrollView mounts.
        expect(screen.findByTestId('sl:bodyScroll')).toBeNull();
    });

    it('does NOT mount the outer ScrollView when a step has TWO virtualized-eligible sections (single FlashList owns the entire body scroll)', async () => {
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'first',
                    title: 'FIRST',
                    options: makeOptions(60, 'first'),
                    virtualization: 'force',
                },
                {
                    kind: 'static',
                    id: 'second',
                    title: 'SECOND',
                    options: makeOptions(60, 'second'),
                    virtualization: 'force',
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root, { maxHeight: 300 })} />,
        );
        // The body MUST NOT mount an outer ScrollView — a single flat
        // FlashList covers the entire body and owns the scroll for ALL
        // sections (avoiding the nested FlashList-in-ScrollView anti-pattern).
        expect(screen.findByTestId('sl:bodyScroll')).toBeNull();
    });
});

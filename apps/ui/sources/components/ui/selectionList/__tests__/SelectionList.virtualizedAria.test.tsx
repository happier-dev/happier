import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';

import type {
    SelectionListOption,
    SelectionListProps,
    SelectionListStep,
} from '../_types';

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

/**
 * R9 — Blocker 4: virtualized rows MUST carry the same actionable ARIA semantics
 * as the plain (non-virtualized) path, otherwise screen readers cannot
 * navigate the listbox via `aria-activedescendant` (the focused row's `id`
 * resolves to nothing on the web DOM).
 *
 * Specifically, every row in the virtualized FlashList must expose:
 *  - role="option"
 *  - aria-selected reflecting the selection state
 *  - id = `<rootTestID>:<stepId>:option:<optionId>` matching the plain path's
 *    option testID/id (the same id used by the input's aria-activedescendant)
 * The layout-only wrapper keeps its canonical wrapper testID but must not own
 * a second role or activation target.
 */
describe('SelectionList virtualized row ARIA parity (R9 blocker 4)', () => {
    it.each([
        {
            name: 'fallback identity',
            option: { id: 'focused-fallback', label: 'Focused fallback' },
            expectedId: 'sl:root:option:focused-fallback',
        },
        {
            name: 'explicit identity',
            option: {
                id: 'focused-explicit',
                testID: 'custom-focused-option',
                label: 'Focused explicit',
            },
            expectedId: 'custom-focused-option',
        },
    ])('keeps section-virtualized aria-activedescendant identical and unique for $name', async ({
        option,
        expectedId,
    }) => {
        legendListState.reset();
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [{
                kind: 'static',
                id: 'forced',
                options: [option],
                virtualization: 'force',
            }],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps(root, { selectedOptionId: option.id })}
            />,
        );

        const input = screen.findByTestId('sl:header:input');
        const row = screen.findByTestId(expectedId);
        const matchingIds = screen.tree.root.findAll((node) => node.props?.id === expectedId);

        expect(input?.props['aria-activedescendant']).toBe(expectedId);
        expect(row?.props.id).toBe(expectedId);
        expect(matchingIds).toHaveLength(1);
    });

    it('virtualized rows expose role="option" + aria-selected + id matching the plain path', async () => {
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
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root, { selectedOptionId: 'opt-1' })} />,
        );
        // The virtualized FlashList is mounted; each rendered row from the
        // mock should carry the wrapper testID matching the plain path:
        // sl:root:option-wrapper:<id>.
        for (let i = 0; i < 3; i += 1) {
            const wrapper = screen.findByTestId(`sl:root:option-wrapper:opt-${i}`);
            const option = screen.findByTestId(`sl:root:option:opt-${i}`);
            expect(wrapper).not.toBeNull();
            expect(wrapper?.props.role).toBeUndefined();
            expect(option?.props.role).toBe('option');
            expect(option?.props.id).toBe(`sl:root:option:opt-${i}`);
            expect(option?.props['aria-posinset']).toBe(i + 1);
            expect(option?.props['aria-setsize']).toBe(3);
            const ariaSelected = option?.props['aria-selected'];
            // The selected row (opt-1) should carry aria-selected=true; others false.
            expect(ariaSelected).toBe(i === 1);
        }
    });

    it('exposes the same option testID structure for virtualized rows as the plain path', async () => {
        legendListState.reset();
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'big',
                    title: 'BIG',
                    options: makeOptions(60),
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} />);
        // FlashList must be mounted for >50 rows.
        expect(legendListState.props).not.toBeNull();
        // Each rendered row carries the canonical option testID.
        const probe = screen.findByTestId('sl:root:option:opt-0');
        expect(probe).not.toBeNull();
        const probeWrapper = screen.findByTestId('sl:root:option-wrapper:opt-0');
        expect(probeWrapper).not.toBeNull();
    });

    it('applies option accessibility labels to virtualized actionable option rows', async () => {
        legendListState.reset();
        const optionWithA11yName = {
            id: 'native',
            label: 'Backend native auth',
            accessibilityLabel: 'Anthropic · Backend native auth',
        } as unknown as SelectionListOption;
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'forced',
                    options: [optionWithA11yName],
                    virtualization: 'force',
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} />);

        const option = screen.findByTestId('sl:root:option:native');

        expect(option?.props.accessibilityLabel).toBe('Anthropic · Backend native auth');
        expect(option?.props['aria-label']).toBe('Anthropic · Backend native auth');
    });
});

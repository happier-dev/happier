import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingFlashListMock } from '@/dev/testkit/mocks/flashList';

import type {
    SelectionListOption,
    SelectionListProps,
    SelectionListStep,
} from '../_types';

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
 * R9 — Blocker 4: virtualized rows MUST carry the same ARIA wrapper semantics
 * as the plain (non-virtualized) path, otherwise screen readers cannot
 * navigate the listbox via `aria-activedescendant` (the focused row's `id`
 * resolves to nothing on the web DOM).
 *
 * Specifically, every row in the virtualized FlashList must expose:
 *  - role="option"
 *  - aria-selected reflecting the selection state
 *  - id = `<rootTestID>:<stepId>:option:<optionId>` matching the plain path's
 *    option testID/id (the same id used by the input's aria-activedescendant)
 *  - testID = `<rootTestID>:<stepId>:option-wrapper:<optionId>` matching the
 *    plain path's wrapper testID format
 */
describe('SelectionList virtualized row ARIA parity (R9 blocker 4)', () => {
    it('virtualized rows expose role="option" + aria-selected + id matching the plain path', async () => {
        flashListState.props = null;
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
            expect(wrapper).not.toBeNull();
            // role="option" + aria-selected on the wrapper element.
            expect(wrapper?.props.role).toBe('option');
            expect(wrapper?.props.id).toBe(`sl:root:option:opt-${i}`);
            const ariaSelected = wrapper?.props['aria-selected'];
            // The selected row (opt-1) should carry aria-selected=true; others false.
            expect(ariaSelected).toBe(i === 1);
        }
    });

    it('exposes the same option testID structure for virtualized rows as the plain path', async () => {
        flashListState.props = null;
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
        expect(flashListState.props).not.toBeNull();
        // Each rendered row carries the canonical option testID.
        const probe = screen.findByTestId('sl:root:option:opt-0');
        expect(probe).not.toBeNull();
        const probeWrapper = screen.findByTestId('sl:root:option-wrapper:opt-0');
        expect(probeWrapper).not.toBeNull();
    });

    it('applies option accessibility labels to virtualized option wrappers', async () => {
        flashListState.props = null;
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

        const wrapper = screen.findByTestId('sl:root:option-wrapper:native');

        expect(wrapper?.props.accessibilityLabel).toBe('Anthropic · Backend native auth');
        expect(wrapper?.props['aria-label']).toBe('Anthropic · Backend native auth');
    });
});

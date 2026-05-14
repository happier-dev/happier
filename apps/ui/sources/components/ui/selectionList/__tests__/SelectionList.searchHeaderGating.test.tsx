import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function makeStep(overrides: Partial<SelectionListStep> = {}): SelectionListStep {
    return {
        id: 'root',
        title: 'Storage',
        sections: [
            {
                kind: 'static',
                id: 'options',
                options: [
                    { id: 'persisted', label: 'Synced' },
                    { id: 'direct', label: 'Direct' },
                ],
            },
        ],
        ...overrides,
    };
}

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: makeStep(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

/**
 * RV-1 (routing-2): per `_types.ts` `SelectionListStep.inputPlaceholder` is
 * optional and "omit to disable input". The orchestrator previously always
 * rendered the search header (with `placeholder=''`), turning every
 * simple-mode picker into an unlabeled searchable input despite the documented
 * type contract.
 *
 * Gating is at the *rootStep* level (consumer intent), not per-step — once the
 * consumer wires the input row, sub-steps that omit the placeholder must NOT
 * cause the header to vanish mid-flow. The header is rendered when:
 *  - the rootStep declares `inputPlaceholder`, OR
 *  - the consumer wires `inputBehavior` (path/value-mode adapters own
 *    backspace/walk-up semantics on the input), OR
 *  - `inputMode === 'value'` (the input IS the candidate value).
 * Otherwise the header is omitted entirely (no search row, just the section
 * list).
 */
describe('SelectionList SearchHeader gating on inputPlaceholder (RV-1 routing-2)', () => {
    it('renders the search header when the step declares inputPlaceholder', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({ rootStep: makeStep({ inputPlaceholder: 'Search' }) })}
            />,
        );
        expect(screen.findByTestId('sl:header')).not.toBeNull();
    });

    it('does NOT render the search header when neither inputPlaceholder nor inputBehavior nor inputMode=value is set', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps()} />,
        );
        // inputPlaceholder is undefined; this is a list-mode chip with no
        // search bar (e.g. session-mode picker, transcript-storage picker).
        expect(screen.findByTestId('sl:header')).toBeNull();
    });

    it('renders the search header when inputBehavior is wired (path/value-mode adapters need the input row)', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    inputBehavior: {
                        getFilterQueryFromInput: (input) => input,
                    },
                })}
            />,
        );
        expect(screen.findByTestId('sl:header')).not.toBeNull();
    });

    it('renders the search header when inputMode === "value" (the input IS the candidate value)', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ inputMode: 'value' })} />,
        );
        expect(screen.findByTestId('sl:header')).not.toBeNull();
    });
});

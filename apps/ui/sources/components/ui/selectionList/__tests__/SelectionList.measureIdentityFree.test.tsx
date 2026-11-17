import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SelectionList } from '../SelectionList';
import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * FR3-1 / FR3-8 — the SelectionListAnimatedHeight measure host previously
 * stripped identity props at the React.cloneElement boundary, which only
 * worked for props on the immediate child element. The actual `body` element
 * is a `<SelectionListBody …/>` COMPOSITE — its host descendants (the listbox
 * View, option wrappers, FlashList host, etc.) generate their own `id` /
 * `testID` / `role="listbox"` / `aria-*` props AFTER the stripping pass runs.
 *
 * The fix introduces a `mode?: 'measure' | 'normal'` prop on
 * `SelectionListBodyProps` that, when set to 'measure', suppresses ALL
 * identity-bearing output the body owns. The orchestrator renders
 * `<SelectionListBody mode='measure' …/>` inside its single measure host so
 * the boundary is explicit at the API level instead of post-hoc cloning.
 *
 * This integration test mounts the real SelectionList and asserts that the
 * live DOM contains exactly ONE element with each identity (listbox testID,
 * any single option testID, body testID).
 */
function makeStep(): SelectionListStep {
    return {
        id: 'root',
        title: 'Root',
        inputPlaceholder: 'Search',
        sections: [
            {
                kind: 'static',
                id: 'opts',
                options: [
                    { id: 'a', label: 'Alpha' },
                    { id: 'b', label: 'Bravo' },
                    { id: 'c', label: 'Charlie' },
                ],
            },
        ],
    };
}

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: makeStep(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        // Do NOT disable transitions — the measure host is only mounted when
        // the SelectionListAnimatedHeight wrapper is active (transitions on).
        testID: 'sl',
        ...overrides,
    };
}

describe('SelectionList identity-free measure path (FR3-1 / FR3-8)', () => {
    it('renders the listbox, body and option identities exactly once across the visible body and hidden measure host', async () => {
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
        // Precondition: the orchestrator's one measure host is mounted, so every
        // "exactly once" below is a real claim about its mirror.
        expect(screen.findByTestId('sl:measure')).not.toBeNull();

        // The visible body renders the listbox `id` + `role="listbox"`. The
        // measure host's mirror is in measure-mode and must NOT also render
        // those identity props.
        const root = screen.findByTestId('sl');
        expect(root).not.toBeNull();
        const listboxNodes = (root as unknown as {
            findAll: (predicate: (n: { props: Record<string, unknown> }) => boolean) => Array<{ props: Record<string, unknown> }>;
        }).findAll((node) => node.props?.role === 'listbox');
        expect(listboxNodes.length).toBe(1);
        expect((listboxNodes[0].props as { id?: string }).id).toBe('sl:listbox');

        expect(screen.findAllByTestId('sl:body').length).toBe(1);
        // Per-option wrappers: testID format is `sl:root:option-wrapper:<id>`.
        for (const id of ['a', 'b', 'c']) {
            expect(screen.findAllByTestId(`sl:root:option-wrapper:${id}`).length).toBe(1);
        }
    });
});

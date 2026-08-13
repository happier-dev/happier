import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

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
 * `<SelectionListBody mode='measure' …/>` as the sole child of the single
 * measure host, so the boundary is explicit at the API level instead of
 * post-hoc cloning.
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
                title: 'Options',
                headerRightAccessory: (
                    <View
                        testID="header-action"
                        accessibilityLabel="Refresh options"
                    />
                ),
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
    it('renders the listbox id+role exactly once across the visible body and hidden measure host', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
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
    });

    it('renders the body testID exactly once across the visible body and hidden measure host', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
        expect(screen.findAllByTestId('sl:body').length).toBe(1);
    });

    it('renders each option wrapper testID exactly once', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
        // Per-option wrappers: testID format is `sl:root:option-wrapper:<id>`.
        expect(screen.findAllByTestId('sl:root:option-wrapper:a').length).toBe(1);
        expect(screen.findAllByTestId('sl:root:option-wrapper:b').length).toBe(1);
        expect(screen.findAllByTestId('sl:root:option-wrapper:c').length).toBe(1);
    });

    it('keeps the measure host mounted (RUX-14 contract) but with no listbox role descendant', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
        // The measure host's container testID is `sl:measure`.
        const measure = screen.findByTestId('sl:measure');
        expect(measure).not.toBeNull();
        // No descendant of the measure host should advertise role="listbox"
        // — the measure body must be identity-free at the API boundary.
        const matches = (measure as unknown as {
            findAll: (predicate: (n: { props: Record<string, unknown> }) => boolean) => Array<{ props: Record<string, unknown> }>;
        }).findAll((node) => node.props?.role === 'listbox');
        expect(matches.length).toBe(0);
    });

    it('renders caller-supplied section header accessory identity only in the visible tree', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
        expect(screen.findAllByTestId('header-action').length).toBe(1);

        const measure = screen.findByTestId('sl:measure');
        expect(measure).not.toBeNull();
        const matches = (measure as unknown as {
            findAll: (predicate: (n: { props: Record<string, unknown> }) => boolean) => Array<{ props: Record<string, unknown> }>;
        }).findAll((node) =>
            node.props?.testID === 'header-action'
            || node.props?.accessibilityLabel === 'Refresh options',
        );
        expect(matches.length).toBe(0);
    });
});

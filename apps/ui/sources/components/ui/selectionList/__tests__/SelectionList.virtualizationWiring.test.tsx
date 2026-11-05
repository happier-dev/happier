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

vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
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

/** Every virtualized viewport host: the bounded box the virtualized list scrolls inside. */
function virtualizedViewportHeights(screen: Awaited<ReturnType<typeof renderScreen>>): ReadonlyArray<unknown> {
    const flatten = (style: unknown): Record<string, unknown> => Object.assign(
        {},
        ...((Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean) as Array<Record<string, unknown>>),
    );
    return screen.tree.root
        .findAll((node) => typeof node.type === 'string' && flatten(node.props.style).maxHeight === '100%'
            && typeof flatten(node.props.style).height === 'number')
        .map((node) => flatten(node.props.style).height);
}

describe('SelectionList virtualized viewport height', () => {
    // A long list (the composer's machine picker with dozens of machines) must use the room its
    // caller gives it. A virtualized list has no natural height of its own, so a declared
    // `maxHeight` is its viewport; the four-row fallback is only for an unbounded caller.
    const longSection = { kind: 'static' as const, id: 'all', title: 'All', options: makeOptions(80) };

    it('sizes a lone virtualized section to the caller maxHeight', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(
            { id: 'root', inputPlaceholder: 'Search', sections: [longSection] },
            { maxHeight: 480 },
        )} />);
        expect(virtualizedViewportHeights(screen)).toEqual([480]);
    });

    it('sizes the flattened multi-section virtualized body to the caller maxHeight', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(
            {
                id: 'root',
                inputPlaceholder: 'Search',
                sections: [{ kind: 'static', id: 'recent', title: 'Recent', options: makeOptions(2, 'r') }, longSection],
            },
            { maxHeight: 480 },
        )} />);
        expect(virtualizedViewportHeights(screen).every((height) => height === 480)).toBe(true);
        expect(virtualizedViewportHeights(screen).length).toBeGreaterThan(0);
    });

    it('keeps the four-row viewport when the caller gives no bound', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(
            { id: 'root', inputPlaceholder: 'Search', sections: [longSection] },
        )} />);
        expect(virtualizedViewportHeights(screen)).toEqual([224]);
    });
});

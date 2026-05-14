import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type {
    SelectionListDynamicSection,
    SelectionListProps,
    SelectionListStep,
} from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: <T,>(options: { ios?: T; native?: T; default?: T; web?: T; android?: T }) =>
                options.ios ?? options.native ?? options.default ?? options.web ?? options.android,
        },
    });
});

function makeStep(section: SelectionListDynamicSection): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [{ kind: 'dynamic', ...section }],
    };
}

function defaultProps(
    rootStep: SelectionListStep,
    overrides: Partial<SelectionListProps> = {},
): SelectionListProps {
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

beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const mod = await import('../useSelectionListDynamicSections');
    mod.__resetDynamicSectionCacheForTests();
});

afterEach(async () => {
    vi.useRealTimers();
    const mod = await import('../useSelectionListDynamicSections');
    mod.__resetDynamicSectionCacheForTests();
});

/**
 * FR4-2 — Stale dynamic rows must be keyboard / a11y focusable.
 *
 * Background: `SelectionListRenderPlan` intentionally surfaces last-success
 * options under `dynamicState: 'loading' | 'error'` so users can still see
 * and click the prior results during refetch / transient error. Before this
 * fix, `SelectionList.flatVisibleOptionIds` excluded EVERY section with
 * `dynamicState !== undefined`, so arrow/enter navigation and the
 * `aria-activedescendant` mirror skipped those rows even though they were
 * mounted and pointer-clickable.
 *
 * Fix: include option-bearing stale `loading` / `error` sections in the
 * focusable id set. Still exclude pure skeletons (loading without stale),
 * pure errors (error without stale), `empty`, and `notFound`.
 */
describe('SelectionList stale dynamic row keyboard focus + a11y (FR4-2)', () => {
    it('arrow keys + Enter activate stale options in a loading-with-stale dynamic section', async () => {
        const { act } = await import('react-test-renderer');

        // Pre-populate the cross-mount cache by mounting once with a
        // resolving resolver, then unmount. The cross-mount cache stores the
        // last successful options keyed by `${id}::${resolverKey}::${seed}`.

        const root1 = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            resolverKey: 'k1',
            resolve: async () => ({
                options: [
                    { id: 'stale-a', label: 'Stale A' },
                    { id: 'stale-b', label: 'Stale B' },
                    { id: 'stale-c', label: 'Stale C' },
                ],
            }),
        });

        const { SelectionList } = await import('../SelectionList');
        const screen1 = await renderScreen(<SelectionList {...defaultProps(root1)} />);
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        // Confirm cache was populated by the success render: the rows are
        // rendered as real option wrappers.
        expect(screen1.findByTestId('sl:root:option-wrapper:stale-a')).not.toBeNull();
        await act(async () => {
            screen1.tree.unmount();
        });

        // Remount with the SAME id+resolverKey+seed (empty inputValue both
        // times → seed="") and a never-resolving resolver. The hook seeds
        // `lastSuccessOptions` from the cache, and the render plan emits
        // `dynamicState: 'loading', isStale: true` with those options.
        const root2 = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            resolverKey: 'k1',
            resolve: () => new Promise(() => {}),
        });

        const onSelect = vi.fn();
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root2, { onSelect })} />,
        );
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
        });

        // The stale rows are mounted as real option wrappers.
        expect(screen.findByTestId('sl:root:option-wrapper:stale-a')).not.toBeNull();
        expect(screen.findByTestId('sl:root:option-wrapper:stale-b')).not.toBeNull();
        expect(screen.findByTestId('sl:root:option-wrapper:stale-c')).not.toBeNull();

        // The header input is the keyboard event surface. Re-read the prop on
        // every dispatch — the orchestrator memoizes a new handler whenever
        // focusedOptionId changes, so a stale captured reference would invoke
        // the previous focused row instead.
        const dispatchKey = async (key: string) => {
            const input = screen.findByTestId('sl:header:input');
            const handler = (input as unknown as {
                props: { onKeyPress?: (evt: unknown) => void };
            }).props.onKeyPress;
            expect(typeof handler).toBe('function');
            await act(async () => {
                handler!({
                    key,
                    preventDefault: () => {},
                    stopPropagation: () => {},
                });
            });
        };
        // ArrowDown moves focus to the next stale option.
        await dispatchKey('ArrowDown');

        // Enter activates the focused stale option.
        await dispatchKey('Enter');
        expect(onSelect).toHaveBeenCalledWith(
            'stale-b',
            expect.objectContaining({ id: 'stale-b' }),
        );
    });

    it('still excludes pure skeleton loading sections (no stale options) from focusable ids', async () => {
        const { act } = await import('react-test-renderer');

        // No cached entry; resolver never resolves; descriptor opts into
        // first-load skeletons.
        const root = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            showSkeletonsOnFirstLoad: true,
            loadingSkeletonRows: 2,
            resolve: () => new Promise(() => {}),
        });

        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} />);
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
        });

        // No real option wrappers should exist (skeleton-only).
        expect(screen.findAllByTestId('sl:root:option-wrapper:stale-a')).toHaveLength(0);

        // aria-activedescendant must NOT be set because there is no focusable
        // option (skeleton rows are not focusable).
        const headerInput = screen.findByTestId('sl:header:input');
        const inputProps = (headerInput as unknown as { props: Record<string, unknown> }).props;
        expect(inputProps['aria-activedescendant']).toBeUndefined();
    });
});

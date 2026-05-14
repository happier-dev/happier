import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
 * Previously, when a step had MULTIPLE virtualization-eligible sections
 * (`virtualization='force'` or `auto > threshold`), `SelectionListBody`:
 *   1) wrapped the body in an outer `<ScrollView>`, AND
 *   2) still rendered the FIRST section through `SelectionListVirtualizedSection`
 *      (which mounts a `<FlashList>`), producing a **nested FlashList inside
 *      ScrollView** anti-pattern. The recycler stops cooperating with the
 *      parent scroll → trailing rows visible but unreachable, gestures
 *      stolen, perf regressions on web.
 *   3) emitted a `console.warn` per render with no dedupe and no dev-gate.
 *
 * The fix (Option A from the brief): when ANY section is virtualization-
 * eligible, `SelectionListBody` collapses ALL sections (headers + rows +
 * dynamic-state rows) into a SINGLE flat `<FlashList>` covering the entire
 * body. No outer ScrollView, no nested FlashList. Dynamic warnings are
 * deduped per descriptor signature and only fire in dev (NODE_ENV !== 'production').
 */
describe('SelectionListBody single-FlashList multi-section restructure (RV-9 / FRESH-3)', () => {
    beforeEach(() => {
        flashListState.props = null;
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('mounts exactly ONE FlashList covering both sections (no nested FlashList-in-ScrollView) when two sections are force-virtualized', async () => {
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
        // No outer ScrollView wrapping the body — FlashList owns the scroll.
        expect(screen.findByTestId('sl:bodyScroll')).toBeNull();
        // Exactly ONE FlashList captured. (createCapturingFlashListMock
        // overwrites `state.props` per render; the data array must include
        // entries from BOTH sections.)
        expect(flashListState.props).not.toBeNull();
        const data = flashListState.props?.data as ReadonlyArray<{ kind: string; option?: { id: string } }>;
        expect(Array.isArray(data)).toBe(true);
        // Two section-headers + 60 + 60 option rows = 122 entries.
        expect(data.length).toBe(122);
        // Trailing section's rows are present in the FlashList data.
        const optionIds = data
            .filter((row) => row.kind === 'option')
            .map((row) => row.option?.id);
        for (let i = 0; i < 60; i += 1) {
            expect(optionIds).toContain(`second-${i}`);
        }
    });

    it('emits getItemType so the recycler can discriminate section-headers from option rows', async () => {
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
        await renderScreen(<SelectionList {...defaultProps(root, { maxHeight: 300 })} />);
        const getItemType = flashListState.props?.getItemType;
        expect(typeof getItemType).toBe('function');
        const data = flashListState.props?.data as ReadonlyArray<{ kind: string }>;
        // Section-header type differs from option type so the recycler can
        // pool them separately.
        const headerType = getItemType(data.find((row) => row.kind === 'section-header'), 0);
        const optionType = getItemType(data.find((row) => row.kind === 'option'), 0);
        expect(headerType).toBeDefined();
        expect(optionType).toBeDefined();
        expect(headerType).not.toBe(optionType);
    });

    it('preserves the single-virtualized contract: still uses SelectionListVirtualizedSection (one FlashList) when only ONE section is virtualized', async () => {
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
        expect(screen.findByTestId('sl:bodyScroll')).toBeNull();
        // The single-virtualized path renders SelectionListVirtualizedSection's
        // FlashList directly with the section's option array (60 rows, NOT a
        // flattened multi-section array).
        expect(flashListState.props).not.toBeNull();
        expect(flashListState.props?.data?.length).toBe(60);
    });

    it('preserves the zero-virtualized path: still mounts the bodyScroll ScrollView when no section is eligible for virtualization', async () => {
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'small',
                    title: 'SMALL',
                    options: makeOptions(10, 'a'),
                },
                {
                    kind: 'static',
                    id: 'tiny',
                    title: 'TINY',
                    options: makeOptions(5, 'b'),
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root, { maxHeight: 200 })} />);
        // No section eligible for virtualization → the existing ScrollView
        // path remains in place so trailing rows are reachable.
        expect(screen.findByTestId('sl:bodyScroll')).not.toBeNull();
        expect(flashListState.props).toBeNull();
    });

    it('keeps trailing rows reachable in the rendered tree (data array contains every row id from every section)', async () => {
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
        await renderScreen(<SelectionList {...defaultProps(root, { maxHeight: 300 })} />);
        const data = flashListState.props?.data as ReadonlyArray<{
            kind: string;
            option?: { id: string };
        }>;
        const ids = new Set(
            data
                .filter((row) => row.kind === 'option')
                .map((row) => row.option?.id),
        );
        for (let i = 0; i < 60; i += 1) {
            expect(ids.has(`first-${i}`)).toBe(true);
            expect(ids.has(`second-${i}`)).toBe(true);
        }
    });

    it('dev warning is deduplicated: rendering the same multi-virtualized descriptor twice fires console.warn at most once', async () => {
        // Force "dev" semantics so the gate allows the warning.
        vi.stubEnv('NODE_ENV', 'development');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { resetSelectionListMultiVirtualizationWarningCache } = await import(
            '../SelectionListBody'
        );
        resetSelectionListMultiVirtualizationWarningCache();
        try {
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
            // Trigger a re-render by forcing a state update via update().
            await screen.update(<SelectionList {...defaultProps(root, { maxHeight: 300 })} />);
            const matchingCalls = warnSpy.mock.calls.filter((args) =>
                /multiple\s+virtualized/i.test(String(args[0] ?? '')),
            );
            // Only one warning per descriptor signature, even across multiple renders.
            expect(matchingCalls.length).toBe(1);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('dev warning is gated to dev: NODE_ENV=production suppresses console.warn entirely', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { resetSelectionListMultiVirtualizationWarningCache } = await import(
            '../SelectionListBody'
        );
        resetSelectionListMultiVirtualizationWarningCache();
        try {
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
            await renderScreen(<SelectionList {...defaultProps(root, { maxHeight: 300 })} />);
            const matchingCalls = warnSpy.mock.calls.filter((args) =>
                /multiple\s+virtualized/i.test(String(args[0] ?? '')),
            );
            expect(matchingCalls.length).toBe(0);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('focused option in the SECOND virtualized section: flat data places it at the FLATTENED index (header offsets included)', async () => {
        // The body's flat-FlashList path locates the focused row via
        // `flatItems.findIndex(row => row.kind === 'option' && row.option.id === focusedOptionId)`
        // and asks FlashList to scrollToIndex({ index, viewPosition: 0.5 }).
        // Verifying the data flattening confirms the index is computed with
        // header offsets included.
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
        await renderScreen(<SelectionList {...defaultProps(root, { maxHeight: 300 })} />);
        const data = flashListState.props?.data as ReadonlyArray<{
            kind: string;
            option?: { id: string };
        }>;
        const idx = data.findIndex(
            (row) => row.kind === 'option' && row.option?.id === 'second-4',
        );
        // Expected layout: [first-header, first-0..first-59, second-header, second-0..second-4, ...]
        expect(idx).toBe(1 + 60 + 1 + 4);
    });
});

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { CapturingLegendListMockState } from '@/dev/testkit/mocks/legendList';

import type {
    SelectionListOption,
    SelectionListProps,
    SelectionListStep,
    SelectionListVirtualizedOptionSource,
} from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

let legendListState: CapturingLegendListMockState;

vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return await createLegendListModuleMock({ renderItems: true, memoizeItems: true }, state => {
        legendListState = state;
    });
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
 * The fix (Option A from the brief): when a virtualization-eligible section
 * has neighboring sections, `SelectionListBody` collapses ALL sections
 * (headers + rows + dynamic-state rows) into a SINGLE flat `<FlashList>`
 * covering the entire body. No outer ScrollView, no nested FlashList.
 * A virtualized section keeps its section-scoped owner only when it is truly
 * the body's sole section.
 */
describe('SelectionListBody single virtualized-list multi-section restructure (RV-9 / FRESH-3)', () => {
    beforeEach(() => {
        legendListState?.reset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('keeps a mounted direct-source row fresh when the same path changes without structural churn', async () => {
        const { SelectionList } = await import('../SelectionList');
        const items: SelectionListVirtualizedOptionSource['items'] = [
            { kind: 'option', key: 'same-path', optionIndex: 0, positionInSet: 1 },
        ];
        const makeSource = (label: string): SelectionListVirtualizedOptionSource => ({
            items, optionCount: 1, stateKey: '',
            getOption: () => ({ id: 'same-path', label }),
            getOptionId: () => 'same-path',
            findItemIndexByOptionIndex: index => index === 0 ? 0 : -1,
            findOptionIndexById: id => id === 'same-path' ? 0 : -1,
            getFirstFocusableOptionIndex: () => 0,
            getNextFocusableOptionIndex: () => 0,
            isFocusableOptionIndex: index => index === 0,
            getHeader: () => ({ id: 'files' }),
        });
        const props = (source: SelectionListVirtualizedOptionSource) => defaultProps({
            id: 'root', inputPlaceholder: 'Search', sections: [], virtualizedOptionSource: source,
        }, { maxHeight: 300 });
        const screen = await renderScreen(<SelectionList {...props(makeSource('Before entry change'))} />);
        expect(screen.getTextContent()).toContain('Before entry change');
        await screen.update(<SelectionList {...props(makeSource('After entry change'))} />);
        expect(screen.getTextContent()).toContain('After entry change');
        expect(screen.getTextContent()).not.toContain('Before entry change');
    });

    it('keeps row taps handled for a direct virtualized option source while the keyboard is open', async () => {
        const options = makeOptions(3, 'direct');
        const source: SelectionListVirtualizedOptionSource = {
            items: options.map((option, optionIndex) => ({
                kind: 'option',
                key: option.id,
                optionIndex,
                positionInSet: optionIndex + 1,
            })),
            optionCount: options.length,
            stateKey: 'direct-v1',
            getOption: (index) => options[index]!,
            getOptionId: (index) => options[index]?.id ?? '',
            findItemIndexByOptionIndex: index => index >= 0 && index < options.length ? index : -1,
            findOptionIndexById: (id) => options.findIndex((option) => option.id === id),
            getFirstFocusableOptionIndex: () => 0,
            getNextFocusableOptionIndex: (current, direction) => (
                (current + direction + options.length) % options.length
            ),
            isFocusableOptionIndex: (index) => index >= 0 && index < options.length,
            getHeader: () => ({ id: 'unused' }),
        };
        const { VirtualizedList } = await import('@/components/ui/lists/virtualized/VirtualizedList');
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    id: 'root',
                    inputPlaceholder: 'Search',
                    sections: [],
                    virtualizedOptionSource: source,
                }, { maxHeight: 300 })}
            />,
        );

        expect(screen.tree.root.findByType(VirtualizedList as React.ComponentType<any>).props.keyboardShouldPersistTaps)
            .toBe('handled');
    });

    it('draws a direct source section\'s coverage hint with the shared hint line', async () => {
        const options = makeOptions(2, 'hinted');
        const source: SelectionListVirtualizedOptionSource = {
            items: [
                { kind: 'result-hint', key: 'files::resultHint', sectionIndex: 0 },
                ...options.map((option, optionIndex) => ({
                    kind: 'option' as const,
                    key: option.id,
                    optionIndex,
                    positionInSet: optionIndex + 1,
                })),
            ],
            optionCount: options.length,
            stateKey: 'hinted-v1',
            getOption: (index) => options[index]!,
            getOptionId: (index) => options[index]?.id ?? '',
            findItemIndexByOptionIndex: index => index >= 0 && index < options.length ? index + 1 : -1,
            findOptionIndexById: (id) => options.findIndex((option) => option.id === id),
            getFirstFocusableOptionIndex: () => 0,
            getNextFocusableOptionIndex: (current, direction) => (
                (current + direction + options.length) % options.length
            ),
            isFocusableOptionIndex: (index) => index >= 0 && index < options.length,
            getHeader: () => ({ id: 'files', resultHint: 'Files are offline' }),
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    id: 'root',
                    inputPlaceholder: 'Search',
                    sections: [],
                    virtualizedOptionSource: source,
                }, { maxHeight: 300 })}
            />,
        );

        expect(screen.findByTestId('sl:section:files:resultHint')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Files are offline');
    });

    it('keys a direct source row from the row itself, so the list can compare a replaced listing against the previous one', async () => {
        // LegendList detects a data change by calling the CURRENT keyExtractor on the PREVIOUS data
        // (`checkStructuralDataChange`). A listing that shrinks (Browse after indexing settles) must
        // therefore still key its old rows instead of reading them through the new source.
        const makeSource = (ids: readonly string[], stateKey: string): SelectionListVirtualizedOptionSource => {
            const options = ids.map((id) => ({ id, label: id }));
            const getOption = (index: number) => {
                const option = options[index];
                if (!option) throw new Error('source index is out of bounds');
                return option;
            };
            return {
                items: options.map((option, optionIndex) => ({
                    kind: 'option',
                    key: option.id,
                    optionIndex,
                    positionInSet: optionIndex + 1,
                })),
                optionCount: options.length,
                stateKey,
                getOption,
                getOptionId: (index) => getOption(index).id,
                findItemIndexByOptionIndex: index => index >= 0 && index < options.length ? index : -1,
                findOptionIndexById: (id) => options.findIndex((option) => option.id === id),
                getFirstFocusableOptionIndex: () => 0,
                getNextFocusableOptionIndex: (current) => current,
                isFocusableOptionIndex: (index) => index >= 0 && index < options.length,
                getHeader: () => ({ id: 'unused' }),
            };
        };
        const before = makeSource(['a', 'b', 'c'], 'v1');
        const after = makeSource(['a'], 'v2');
        const { VirtualizedList } = await import('@/components/ui/lists/virtualized/VirtualizedList');
        const { SelectionList } = await import('../SelectionList');
        const element = (source: SelectionListVirtualizedOptionSource) => (
            <SelectionList
                {...defaultProps({
                    id: 'root',
                    inputPlaceholder: 'Search',
                    sections: [],
                    virtualizedOptionSource: source,
                }, { maxHeight: 300 })}
            />
        );
        const screen = await renderScreen(element(before));
        await screen.update(element(after));

        const keyExtractor = screen.tree.root.findByType(VirtualizedList as React.ComponentType<any>).props.keyExtractor as
            (item: unknown, index: number) => string;
        expect(keyExtractor(before.items[2], 2)).toBe('c');
        expect(keyExtractor(after.items[0], 0)).toBe('a');
    });

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
    ])('keeps flat-body aria-activedescendant identical and unique for $name', async ({
        option,
        expectedId,
    }) => {
        const providerOptions = [
            option,
            ...makeOptions(59, 'provider'),
        ];
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'native',
                    options: makeOptions(2, 'native'),
                },
                {
                    kind: 'static',
                    id: 'provider',
                    options: providerOptions,
                    virtualization: 'force',
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps(root, { selectedOptionId: option.id, maxHeight: 300 })}
            />,
        );

        const input = screen.findByTestId('sl:header:input');
        const row = screen.findByTestId(expectedId);
        // Composite owners forward `id` to one host row. Count the host tree
        // that maps to DOM nodes; counting both levels reports a duplicate
        // that browsers never receive.
        const matchingHostIds = screen.tree.root.findAll((node) => (
            typeof node.type === 'string' && node.props?.id === expectedId
        ));

        expect(input?.props['aria-activedescendant']).toBe(expectedId);
        expect(row?.props.id).toBe(expectedId);
        expect(matchingHostIds).toHaveLength(1);
    });

    it('mounts exactly ONE FlashList covering both sections (no nested FlashList-in-ScrollView) when two sections are force-virtualized', async () => {
        const { VirtualizedList } = await import('@/components/ui/lists/virtualized/VirtualizedList');
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
        // Exactly one LegendList is captured.
        // overwrites `state.props` per render; the data array must include
        // entries from BOTH sections.)
        expect(legendListState.props).not.toBeNull();
        expect(screen.tree.root.findByType(VirtualizedList as React.ComponentType<any>).props.keyboardShouldPersistTaps)
            .toBe('handled');
        expect(legendListState.props?.recycleItems).toBe(false);
        for (const sectionId of ['first', 'second']) {
            const section = screen.findByTestId(`sl:section:${sectionId}`);
            expect(section?.props.role).toBe('group');
            expect(section?.props['aria-label']).toBe(sectionId.toUpperCase());
        }
        const data = legendListState.props?.data as ReadonlyArray<{ kind: string; option?: { id: string } }>;
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

    it('mounts one body FlashList when one eligible section has plain neighbors', async () => {
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'native',
                    title: 'NATIVE',
                    options: makeOptions(7, 'native'),
                },
                {
                    kind: 'static',
                    id: 'provider',
                    title: 'PROVIDER',
                    options: makeOptions(60, 'provider'),
                    virtualization: 'force',
                },
                {
                    kind: 'static',
                    id: 'other',
                    title: 'OTHER',
                    options: makeOptions(1, 'other'),
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root, { maxHeight: 300 })} />,
        );

        expect(screen.findByTestId('sl:bodyScroll')).toBeNull();
        expect(screen.findByTestId('sl:bodyVirtualizedList')).not.toBeNull();
        expect(screen.findByTestId('sl:section:provider:virtualized')).toBeNull();

        const data = legendListState.props?.data as ReadonlyArray<{
            kind: string;
            sectionId?: string;
            option?: { id: string };
        }>;
        expect(data).toHaveLength(71);
        expect(data.filter((row) => row.kind === 'section-header').map((row) => row.sectionId))
            .toEqual(['native', 'provider', 'other']);
        expect(data.filter((row) => row.kind === 'option').map((row) => row.option?.id))
            .toContain('provider-59');
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
        const getItemType = legendListState.props?.getItemType;
        expect(typeof getItemType).toBe('function');
        const data = legendListState.props?.data as ReadonlyArray<{ kind: string }>;
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
        expect(legendListState.props).not.toBeNull();
        expect(legendListState.props?.data?.length).toBe(60);
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
        expect(legendListState.props).toBeNull();
    });

    it('dev warning is deduplicated: rendering the same multi-virtualized descriptor twice fires console.warn at most once', async () => {
        // Force "dev" semantics so the gate allows the warning.
        vi.stubEnv('NODE_ENV', 'development');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { resetSelectionListMultiVirtualizationWarningCache } = await import(
            '../selectionListVirtualizationPolicy'
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
            '../selectionListVirtualizationPolicy'
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
});

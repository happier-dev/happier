/**
 * A FILTER MAY NOT PICK THE RENDERER.
 *
 * The body chooses between three renderers, and the inputs to that choice used
 * to be read straight off the CURRENT (filtered) render plan: the option count
 * of each section against `SELECTION_LIST_VIRTUALIZATION_THRESHOLD`, the number
 * of surviving sections, and whether a dynamic section was mid-refetch. Every
 * one of those moves while the user types.
 *
 * So a 60-option list filtered down to 49 swapped `SelectionListVirtualizedSection`
 * for `SelectionListBodyScrollFrame` MID-KEYSTROKE — the whole body unmounted
 * and a different component mounted in its place, once per keystroke around the
 * boundary, taking scroll position, focus and every row's identity with it.
 *
 * Same defect class as `SelectionList.a11yPatternStability.test.tsx` (the ARIA
 * pattern, derived from the filtered plan) and
 * `SelectionList.columnRendererStability.test.tsx` (the renderer, derived from
 * a measured column count): layout and content may change WITHIN a renderer;
 * they may not change WHICH renderer runs.
 *
 * The counted mounts are the discriminating half. Both renderers render "the
 * rows", so an assertion that rows are still on screen passes either way; only
 * a row that never unmounted proves the subtree was not torn down.
 */

import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';

import { SELECTION_LIST_VIRTUALIZATION_THRESHOLD } from '../_constants';
import type {
    SelectionListOption,
    SelectionListProps,
    SelectionListSectionDescriptor,
    SelectionListStep,
} from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { module: capturedLegendList } = createCapturingLegendListMock({ renderItems: true });

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: capturedLegendList.LegendList,
}));

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** Ten past the `auto` threshold, so one keystroke can drop the list under it. */
const OVER_THRESHOLD = SELECTION_LIST_VIRTUALIZATION_THRESHOLD + 10;

/**
 * A row body that reports every MOUNT. `content` is a public option field, so
 * the probe rides the real row renderer rather than a stand-in for it.
 */
function makeMountProbe(onMount: () => void): React.ReactElement {
    function MountProbe(): React.ReactElement | null {
        React.useEffect(() => {
            onMount();
        }, []);
        return null;
    }
    return <MountProbe />;
}

function makeOptions(
    count: number,
    probe?: Readonly<{ optionId: string; onMount: () => void }>,
): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, index) => {
        const id = `m-${index}`;
        const option: SelectionListOption = {
            id,
            label: `Model ${index}`,
            ...(probe !== undefined && probe.optionId === id
                ? { content: makeMountProbe(probe.onMount) }
                : {}),
        };
        return option;
    });
}

function makeStep(sections: ReadonlyArray<SelectionListSectionDescriptor>): SelectionListStep {
    return {
        id: 'root',
        title: 'Models',
        inputPlaceholder: 'Search models',
        sections,
    };
}

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: makeStep([{
            kind: 'static',
            id: 'models',
            title: 'MODELS',
            options: makeOptions(OVER_THRESHOLD),
        }]),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

/**
 * WHICH renderer is mounted, as a value — each body renderer owns a distinct
 * host testID, so a partial swap cannot slip through a single `toBeNull()`.
 */
function mountedBodyRenderer(screen: Screen): Record<string, boolean> {
    return {
        flatVirtualized: screen.findByTestId('sl:bodyVirtualizedList') !== null,
        perSectionVirtualized: screen.findByTestId('sl:section:models:virtualized') !== null,
        scrollFrame: screen.findByTestId('sl:bodyScroll') !== null,
    };
}

async function type(screen: Screen, value: string): Promise<void> {
    const input = screen.findByTestId('sl:header:input');
    if (input === null) throw new Error('expected the search header input');
    await act(async () => {
        (input.props.onChangeText as ((next: string) => void) | undefined)?.(value);
    });
}

function visibleOptionIds(screen: Screen): ReadonlyArray<string> {
    return screen
        .findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('sl:root:option:'))
        .map((node) => String(node.props.testID).replace('sl:root:option:', ''));
}

describe('SelectionList — a filter may not pick the body renderer', () => {
    it('keeps one renderer mounted while a filter crosses the virtualization threshold', async () => {
        const { SelectionList } = await import('../SelectionList');
        let probeMounts = 0;
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep: makeStep([{
                        kind: 'static',
                        id: 'models',
                        title: 'MODELS',
                        options: makeOptions(OVER_THRESHOLD, {
                            optionId: 'm-5',
                            onMount: () => { probeMounts += 1; },
                        }),
                    }]),
                })}
            />,
        );

        const opened = mountedBodyRenderer(screen);
        expect(opened.scrollFrame).toBe(false);
        const mountsWhenOpened = probeMounts;
        expect(mountsWhenOpened).toBeGreaterThan(0);

        // "Model 5" keeps Model 5 and Model 50..59 — eleven rows, far under the
        // threshold the list opened above.
        await type(screen, 'Model 5');
        expect(visibleOptionIds(screen)).toContain('m-5');
        expect(visibleOptionIds(screen).length).toBeLessThan(
            SELECTION_LIST_VIRTUALIZATION_THRESHOLD,
        );
        expect(mountedBodyRenderer(screen)).toEqual(opened);
        expect(probeMounts).toBe(mountsWhenOpened);

        // ...and back across the boundary, which is the other half of a single
        // backspace.
        await type(screen, '');
        expect(mountedBodyRenderer(screen)).toEqual(opened);
        expect(probeMounts).toBe(mountsWhenOpened);
    });

    it('keeps one renderer mounted when a filter empties one of two sections', async () => {
        // The section COUNT is transient too: a section whose filter narrows to
        // zero rows is dropped from the plan entirely, so `plan.length > 1`
        // flipped the flat path off mid-keystroke.
        const { SelectionList } = await import('../SelectionList');
        let probeMounts = 0;
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep: makeStep([
                        {
                            kind: 'static',
                            id: 'models',
                            title: 'MODELS',
                            options: makeOptions(OVER_THRESHOLD),
                        },
                        {
                            kind: 'static',
                            id: 'pinned',
                            title: 'PINNED',
                            options: [{
                                id: 'zebra',
                                label: 'Zebra',
                                content: makeMountProbe(() => { probeMounts += 1; }),
                            }],
                        },
                    ]),
                })}
            />,
        );

        const opened = mountedBodyRenderer(screen);
        expect(opened.flatVirtualized).toBe(true);
        const mountsWhenOpened = probeMounts;

        await type(screen, 'Zebra');
        expect(visibleOptionIds(screen)).toEqual(['zebra']);
        expect(mountedBodyRenderer(screen)).toEqual(opened);
        expect(probeMounts).toBe(mountsWhenOpened);
    });

    it('still virtualizes a list that grows past the threshold after it opened', async () => {
        // The other direction: a step that opens small and later resolves more
        // rows than the threshold must END UP virtualized. Latching the choice
        // must not mean freezing a short list's renderer onto a long one.
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep: makeStep([{
                        kind: 'static',
                        id: 'models',
                        title: 'MODELS',
                        options: makeOptions(6),
                    }]),
                })}
            />,
        );
        expect(mountedBodyRenderer(screen)).toEqual({
            flatVirtualized: false,
            perSectionVirtualized: false,
            scrollFrame: true,
        });

        await act(async () => {
            screen.tree.update(
                <SelectionList
                    {...defaultProps({
                        rootStep: makeStep([{
                            kind: 'static',
                            id: 'models',
                            title: 'MODELS',
                            options: makeOptions(OVER_THRESHOLD),
                        }]),
                    })}
                />,
            );
        });

        expect(mountedBodyRenderer(screen).scrollFrame).toBe(false);
        expect(visibleOptionIds(screen).length).toBeGreaterThan(
            SELECTION_LIST_VIRTUALIZATION_THRESHOLD,
        );
    });
});

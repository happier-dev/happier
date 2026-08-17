/**
 * A MEASUREMENT MAY NOT PICK THE RENDERER.
 *
 * The body chooses between three renderers, and one of the inputs to that
 * choice used to be the RESOLVED column count — a number derived from the
 * container's measured width. Crossing the column breakpoint therefore swapped
 * `SelectionListVirtualizedSection` for `SelectionListBodyVirtualized`,
 * unmounting and remounting the entire body: the visible "the whole list gets
 * rebuilt" jiggle, plus the loss of scroll position, focus and every row's
 * identity.
 *
 * This is the same defect class already fixed for the ARIA pattern in
 * `SelectionList.a11yPatternStability.test.tsx`: layout may change WITHIN a
 * renderer; it may not change WHICH renderer runs. The path is now decided from
 * the caller's DECLARED `columns` config, which cannot move while the popup is
 * open.
 *
 * The second block is the measurement itself. The container used to store the
 * raw measured width, so a browser reporting `546` then `546.4` — the same
 * layout, one sub-pixel apart — re-rendered the whole list on every
 * ResizeObserver notification. Storing the resolved COUNT means a width change
 * that does not cross a breakpoint changes no state at all.
 */

import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';

import type { SelectionListOption, SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { module: capturedLegendList } = createCapturingLegendListMock({ renderItems: true });

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: capturedLegendList.LegendList,
}));

/** Wide enough for two 250px columns plus the shared 12px gutter (512). */
const TWO_COLUMN_WIDTH_PX = 546;
/** Too narrow for a second 250px column — the resolver falls back to one. */
const ONE_COLUMN_WIDTH_PX = 420;

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function makeOptions(count: number): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, index) => ({
        id: `m-${index}`,
        label: `Model ${index}`,
    }));
}

/**
 * ONE virtualization-eligible section, which is the shape that used to flip:
 * a lone eligible section does not require the flat path on its own, so the
 * column count was the only thing deciding between the two renderers.
 */
function makeStep(options: ReadonlyArray<SelectionListOption>): SelectionListStep {
    return {
        id: 'root',
        title: 'Models',
        inputPlaceholder: 'Search models',
        sections: [{
            kind: 'static',
            id: 'models',
            title: 'MODELS',
            options,
            virtualization: 'force',
        }],
    };
}

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: makeStep(makeOptions(6)),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        columns: { max: 2, minColumnWidthPx: 250 },
        ...overrides,
    };
}

async function measureContainer(screen: Screen, widthPx: number): Promise<void> {
    const onLayout = screen.findByTestId('sl')?.props.onLayout as
        | ((event: unknown) => void)
        | undefined;
    if (typeof onLayout !== 'function') {
        throw new Error('expected the columned SelectionList to measure itself');
    }
    await act(async () => {
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: widthPx, height: 400 } } });
    });
}

/**
 * WHICH renderer is mounted, as a value. Each body renderer owns a distinct
 * host testID, so the pair identifies the mounted component without reaching
 * into React internals — and a partial swap cannot slip through a single
 * `toBeNull()`.
 */
function mountedBodyRenderer(screen: Screen): Record<string, boolean> {
    return {
        flatVirtualized: screen.findByTestId('sl:bodyVirtualizedList') !== null,
        perSectionVirtualized: screen.findByTestId('sl:section:models:virtualized') !== null,
        scrollFrame: screen.findByTestId('sl:bodyScroll') !== null,
    };
}

function columnRows(screen: Screen): ReadonlyArray<ReactTestInstance> {
    return screen.tree.root.findAll((node) => {
        if (typeof node.type !== 'string') return false;
        const style = node.props.style;
        const flat = Array.isArray(style)
            ? Object.assign({}, ...style.filter(Boolean))
            : (style as Record<string, unknown> | undefined) ?? {};
        return flat.flexDirection === 'row' && flat.alignItems === 'flex-start';
    });
}

describe('SelectionList — the measured column count may not pick the body renderer', () => {
    it('keeps the same body renderer mounted across the column breakpoint, and back', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);

        // Before any measurement the count is 1. Whatever renderer that mounts
        // is the one the user is looking at, and resizing must not replace it.
        const opened = mountedBodyRenderer(screen);
        expect(opened.flatVirtualized).toBe(true);

        await measureContainer(screen, ONE_COLUMN_WIDTH_PX);
        expect(mountedBodyRenderer(screen)).toEqual(opened);

        // The pane genuinely reflows into two columns here — the LAYOUT follows
        // the measurement, which is correct. The component identity may not.
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX);
        expect(mountedBodyRenderer(screen)).toEqual(opened);
        expect(columnRows(screen)).toHaveLength(3);

        await measureContainer(screen, ONE_COLUMN_WIDTH_PX);
        expect(mountedBodyRenderer(screen)).toEqual(opened);
        expect(columnRows(screen)).toHaveLength(0);
    });

    it('renders every row of a columned pane that resolves to a single column', async () => {
        // The fix routes a DECLARED columns pane down the flat path whether or
        // not the width currently resolves two, so the single-column case has to
        // be a real rendering claim rather than an assumption about the other
        // renderer picking it up.
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
        await measureContainer(screen, ONE_COLUMN_WIDTH_PX);

        expect(columnRows(screen)).toHaveLength(0);
        for (const id of ['m-0', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5']) {
            expect(screen.findByTestId(`sl:root:option:${id}`)).not.toBeNull();
        }
        expect(screen.findByTestId('sl:section:models:header')).not.toBeNull();
    });

    it('leaves a list that declares no columns on its untouched renderer', async () => {
        // Identity guard: every other consumer in the app is here, and a lone
        // virtualized section must still own its own scroll container.
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ columns: undefined })} />,
        );
        expect(mountedBodyRenderer(screen)).toEqual({
            flatVirtualized: false,
            perSectionVirtualized: true,
            scrollFrame: false,
        });
    });
});

describe('SelectionList — a width change that crosses no breakpoint changes nothing', () => {
    /**
     * Commits, counted. A `useState` write of an equal value does not commit, so
     * the profiler is silent exactly when the list did no work — which is the
     * claim. Counting renders inside the implementation would instead assert
     * that a particular hook exists.
     */
    async function renderProfiled(): Promise<{ screen: Screen; commits: () => number }> {
        const { SelectionList } = await import('../SelectionList');
        let count = 0;
        const screen = await renderScreen(
            <React.Profiler id="selection-list" onRender={() => { count += 1; }}>
                <SelectionList {...defaultProps()} />
            </React.Profiler>,
        );
        return { screen, commits: () => count };
    }

    it('does not re-render for a sub-pixel width change inside one column count', async () => {
        const { screen, commits } = await renderProfiled();
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX);
        expect(columnRows(screen)).toHaveLength(3);
        // One notification to drain the pending update the real resize left on
        // the hook — React can only take its eager same-value bailout with an
        // empty queue, so the FIRST equal write after a real change still costs
        // a render. Everything after it is the steady state a ResizeObserver
        // actually sits in.
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX + 0.4);

        const settled = commits();
        // The shape a browser reports: the same layout, a fraction of a pixel
        // apart, once per notification. Storing the raw width made each of these
        // re-render the whole list.
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX - 0.25);
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX + 1);
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX + 0.75);
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX + 2);
        expect(commits()).toBe(settled);
        expect(columnRows(screen)).toHaveLength(3);
    });

    it('still re-renders when a width change does cross the breakpoint', async () => {
        const { screen, commits } = await renderProfiled();
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX);
        const settled = commits();

        await measureContainer(screen, ONE_COLUMN_WIDTH_PX);
        expect(commits()).toBeGreaterThan(settled);
        expect(columnRows(screen)).toHaveLength(0);
    });
});

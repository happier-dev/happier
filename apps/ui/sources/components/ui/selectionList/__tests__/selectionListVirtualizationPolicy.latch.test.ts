/**
 * The renderer ladder, as a pure decision.
 *
 * `resolveSelectionListBodyRenderer` reads the CURRENT plan, and every input it
 * reads is transient — so the latch, not the resolver, is what the body may
 * consume. These cases pin the two properties that make the latch safe:
 * it never de-escalates (no keystroke can tear the body down), and it does
 * escalate (a list that grows past the threshold still gets virtualized).
 *
 * The rendered-tree half of this contract lives in
 * `SelectionListBody.filterRendererStability.test.tsx`.
 */

import { describe, expect, it } from 'vitest';

import { SELECTION_LIST_VIRTUALIZATION_THRESHOLD } from '../_constants';
import {
    advanceSelectionListBodyRendererLatch,
    applyLatchedVirtualizationToPlan,
    resolveSelectionListBodyRenderer,
} from '../selectionListVirtualizationPolicy';
import type { SectionRenderPlan } from '../SelectionListRenderPlan';
import type { SelectionListOption } from '../_types';

const OVER_THRESHOLD = SELECTION_LIST_VIRTUALIZATION_THRESHOLD + 10;

function makeOptions(count: number): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, index) => ({
        id: `opt-${index}`,
        label: `Option ${index}`,
    }));
}

function section(id: string, count: number): SectionRenderPlan {
    return { id, options: makeOptions(count) };
}

const DECLARES_NOTHING = { declaresPagination: false, declaresColumns: false } as const;

function advance(
    previous: Parameters<typeof advanceSelectionListBodyRendererLatch>[0],
    plan: ReadonlyArray<SectionRenderPlan>,
    stepId = 'root',
) {
    return advanceSelectionListBodyRendererLatch(previous, {
        stepId,
        plan,
        ...DECLARES_NOTHING,
    });
}

describe('selectionListVirtualizationPolicy — the latched body renderer', () => {
    it('keeps the virtualized renderer when a filter drops the list under the threshold', () => {
        const opened = advance(null, [section('models', OVER_THRESHOLD)]);
        expect(opened.renderer).toBe('sectionVirtualized');

        const filtered = advance(opened, [section('models', 11)]);
        expect(filtered.renderer).toBe('sectionVirtualized');
        // The raw signal is what the body used to consume, and it is exactly
        // the thing that would have swapped the renderer.
        expect(resolveSelectionListBodyRenderer({
            plan: [section('models', 11)],
            ...DECLARES_NOTHING,
        })).toBe('scrollFrame');
    });

    it('keeps the flat renderer when a filter empties a neighboring section', () => {
        const opened = advance(null, [section('models', OVER_THRESHOLD), section('pinned', 1)]);
        expect(opened.renderer).toBe('flatVirtualized');

        expect(advance(opened, [section('pinned', 1)]).renderer).toBe('flatVirtualized');
    });

    it('keeps the flat renderer when a dynamic section leaves its stale state', () => {
        const stale: SectionRenderPlan = {
            id: 'paths',
            options: makeOptions(OVER_THRESHOLD),
            dynamicState: 'loading',
            isStale: true,
        };
        const opened = advance(null, [stale]);
        expect(opened.renderer).toBe('flatVirtualized');

        expect(advance(opened, [section('paths', OVER_THRESHOLD)]).renderer)
            .toBe('flatVirtualized');
    });

    it('escalates when a list that opened short grows past the threshold', () => {
        const opened = advance(null, [section('models', 6)]);
        expect(opened.renderer).toBe('scrollFrame');

        const grown = advance(opened, [section('models', OVER_THRESHOLD)]);
        expect(grown.renderer).toBe('sectionVirtualized');
        expect(grown.virtualizedSectionIds.has('models')).toBe(true);

        expect(advance(grown, [section('models', OVER_THRESHOLD), section('pinned', 1)]).renderer)
            .toBe('flatVirtualized');
    });

    it('resolves from scratch for a different step', () => {
        const opened = advance(null, [section('models', OVER_THRESHOLD)]);
        const nextStep = advance(opened, [section('detail', 3)], 'detail');
        expect(nextStep.renderer).toBe('scrollFrame');
        expect(nextStep.virtualizedSectionIds.size).toBe(0);
    });

    it('returns the previous latch unchanged when nothing escalated', () => {
        const plan = [section('models', OVER_THRESHOLD)];
        const opened = advance(null, plan);
        expect(advance(opened, plan)).toBe(opened);
        expect(advance(opened, [section('models', 3)])).toBe(opened);
    });
});

describe('selectionListVirtualizationPolicy — publishing the latch into the plan', () => {
    it('forces the sections the latch holds so the per-section renderers cannot re-decide', () => {
        const filtered = [section('models', 11)];
        const latched = applyLatchedVirtualizationToPlan(filtered, new Set(['models']));
        expect(latched[0]?.virtualization).toBe('force');
        // Same options, same order — only the decision travels.
        expect(latched[0]?.options).toBe(filtered[0]?.options);
    });

    it('leaves the plan untouched when no latched section needs forcing', () => {
        const plan = [section('models', OVER_THRESHOLD), section('pinned', 2)];
        expect(applyLatchedVirtualizationToPlan(plan, new Set(['models']))).toBe(plan);
        expect(applyLatchedVirtualizationToPlan(plan, new Set())).toBe(plan);
    });

    it('does not force a latched section that currently has no rows to virtualize', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [
            { id: 'paths', options: [], dynamicState: 'notFound', hint: 'No such directory' },
        ];
        expect(applyLatchedVirtualizationToPlan(plan, new Set(['paths']))).toBe(plan);
    });
});

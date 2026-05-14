import { describe, expect, it } from 'vitest';

import {
    flattenRenderPlanForFlashList,
    planHasMultipleVirtualizedSections,
    planHasVirtualizedSection,
} from '../SelectionListBody';
import type { SectionRenderPlan } from '../SelectionListRenderPlan';
import type { SelectionListOption } from '../_types';

/**
 * R14 — pure unit coverage for the body-level virtualization decision the
 * orchestrator uses to pick between "wrap in ScrollView" (no FlashList) and
 * "render flat" (FlashList owns the scroll container).
 *
 * RV-9 (FRESH-3) — semantic change: `planHasVirtualizedSection` now returns
 * `true` whenever ANY section is virtualization-eligible (not only the
 * single-section case). This is consistent with the new single-FlashList
 * multi-section path that covers ALL sections in one FlashList.
 */
describe('SelectionListBody.planHasVirtualizedSection (R14 extracted)', () => {
    function makeOptions(count: number): ReadonlyArray<SelectionListOption> {
        const options: SelectionListOption[] = [];
        for (let i = 0; i < count; i += 1) {
            options.push({ id: `opt-${i}`, label: `Option ${i}` });
        }
        return options;
    }

    function staticPlan(opts: ReadonlyArray<SelectionListOption>, virtualization?: SectionRenderPlan['virtualization']): SectionRenderPlan {
        return { id: 's', options: opts, virtualization };
    }

    it('returns false for a single non-virtualized success section under threshold', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [staticPlan(makeOptions(20))];
        expect(planHasVirtualizedSection(plan)).toBe(false);
    });

    it('returns true when a section auto-virtualizes by row count (> threshold)', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [staticPlan(makeOptions(60))];
        expect(planHasVirtualizedSection(plan)).toBe(true);
    });

    it('returns true when virtualization is forced even with one row', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [staticPlan(makeOptions(1), 'force')];
        expect(planHasVirtualizedSection(plan)).toBe(true);
    });

    it('returns false when virtualization is "never" regardless of row count', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [staticPlan(makeOptions(120), 'never')];
        expect(planHasVirtualizedSection(plan)).toBe(false);
    });

    it('skips loading/error/empty sections (only success sections render rows that may virtualize)', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [
            { id: 'l', options: [], dynamicState: 'loading', skeletonRowCount: 5 },
            { id: 'e', options: [], dynamicState: 'error', hint: 'oops' },
            { id: 'h', options: [], dynamicState: 'empty', hint: 'no matches' },
        ];
        expect(planHasVirtualizedSection(plan)).toBe(false);
    });

    it('returns true if ANY success section virtualizes (not all)', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [
            staticPlan(makeOptions(2)),
            staticPlan(makeOptions(80)),
        ];
        expect(planHasVirtualizedSection(plan)).toBe(true);
    });

    it('RV-9: returns true when MULTIPLE sections are virtualization-eligible (the single-FlashList path still owns the body scroll)', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [
            { id: 'a', options: makeOptions(60), virtualization: 'force' },
            { id: 'b', options: makeOptions(60), virtualization: 'force' },
        ];
        expect(planHasVirtualizedSection(plan)).toBe(true);
    });
});

describe('SelectionListBody.planHasMultipleVirtualizedSections (RV-9)', () => {
    function makeOptions(count: number): ReadonlyArray<SelectionListOption> {
        return Array.from({ length: count }, (_, i) => ({ id: `opt-${i}`, label: `Option ${i}` }));
    }

    it('returns false when zero sections are eligible', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [{ id: 's', options: makeOptions(5) }];
        expect(planHasMultipleVirtualizedSections(plan)).toBe(false);
    });

    it('returns false when exactly one section is eligible', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [
            { id: 'a', options: makeOptions(60), virtualization: 'force' },
            { id: 'b', options: makeOptions(5) },
        ];
        expect(planHasMultipleVirtualizedSections(plan)).toBe(false);
    });

    it('returns true when two or more sections are eligible', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [
            { id: 'a', options: makeOptions(60), virtualization: 'force' },
            { id: 'b', options: makeOptions(60), virtualization: 'force' },
        ];
        expect(planHasMultipleVirtualizedSections(plan)).toBe(true);
    });
});

describe('SelectionListBody.flattenRenderPlanForFlashList (RV-9)', () => {
    function makeOptions(count: number, prefix: string): ReadonlyArray<SelectionListOption> {
        return Array.from({ length: count }, (_, i) => ({
            id: `${prefix}-${i}`,
            label: `Label ${prefix}-${i}`,
        }));
    }

    it('emits a section-header followed by option rows for every success section', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [
            { id: 'first', title: 'FIRST', options: makeOptions(2, 'a'), virtualization: 'force' },
            { id: 'second', title: 'SECOND', options: makeOptions(3, 'b'), virtualization: 'force' },
        ];
        const flat = flattenRenderPlanForFlashList(plan);
        // [header(first), a-0, a-1, header(second), b-0, b-1, b-2]
        expect(flat.length).toBe(2 + 2 + 3);
        expect(flat[0].kind).toBe('section-header');
        expect(flat[0].sectionId).toBe('first');
        expect(flat[1].kind).toBe('option');
        expect(flat[3].kind).toBe('section-header');
        expect(flat[3].sectionId).toBe('second');
    });

    it('emits skeleton rows for loading sections (one row per skeletonRowCount)', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [
            { id: 'l', options: [], dynamicState: 'loading', skeletonRowCount: 4, title: 'L' },
        ];
        const flat = flattenRenderPlanForFlashList(plan);
        expect(flat[0].kind).toBe('section-header');
        const skeletons = flat.filter((row) => row.kind === 'loading-skeleton');
        expect(skeletons.length).toBe(4);
    });

    it('emits an error row when dynamicState=error and an empty-hint row for non-empty empty hints', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [
            { id: 'e', options: [], dynamicState: 'error', hint: 'oops', title: 'E' },
            { id: 'h', options: [], dynamicState: 'empty', hint: 'no matches', title: 'H' },
        ];
        const flat = flattenRenderPlanForFlashList(plan);
        const kinds = flat.map((row) => row.kind);
        expect(kinds).toContain('error');
        expect(kinds).toContain('empty-hint');
    });

    it('omits empty-hint sections whose hint is undefined or empty (parity with the non-virtualized renderer)', () => {
        const plan: ReadonlyArray<SectionRenderPlan> = [
            { id: 'h1', options: [], dynamicState: 'empty', hint: undefined },
            { id: 'h2', options: [], dynamicState: 'empty', hint: '' },
        ];
        const flat = flattenRenderPlanForFlashList(plan);
        expect(flat.length).toBe(0);
    });
});

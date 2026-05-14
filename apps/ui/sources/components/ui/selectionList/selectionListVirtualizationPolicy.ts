/**
 * FR4-W2-BODY — pure policy module extracted from `SelectionListBody.tsx`.
 *
 * Owns the decision logic that picks between three rendering paths:
 *  - 0 eligible sections → plain ScrollView path
 *  - 1 eligible section → `SelectionListVirtualizedSection` per-section path
 *  - ≥2 eligible OR ≥1 stale-eligible → single flat FlashList path
 *
 * No JSX, no React state. The body component imports these predicates and
 * dispatches to the appropriate renderer.
 */

import { SELECTION_LIST_VIRTUALIZATION_THRESHOLD } from './_constants';
import type { SectionRenderPlan } from './SelectionListRenderPlan';
import type { SelectionListVirtualizationMode } from './_types';

/**
 * Collect the section ids that are eligible for virtualization under the
 * descriptor's hint + the body's threshold. Centralized so multiple call
 * sites (count, resolve, dev warning) share one definition of "eligible".
 *
 * FR4-3: option-bearing stale dynamic sections (`loading`/`error` with
 * `options.length > 0`) participate in this check too. A section that
 * virtualized during success state would otherwise fall back to a plain
 * mapped ScrollView when the resolver re-enters loading or transient error,
 * silently regressing performance on refetch. We treat stale rows the same
 * as success rows for eligibility; `notFound`/`empty`/skeleton-only loading
 * are still excluded (no real options to virtualize).
 */
export function collectVirtualizationEligibleSectionIds(
    plan: ReadonlyArray<SectionRenderPlan>,
): ReadonlyArray<string> {
    const eligible: string[] = [];
    for (const sectionPlan of plan) {
        if (
            sectionPlan.dynamicState !== undefined
            && sectionPlan.dynamicState !== 'loading'
            && sectionPlan.dynamicState !== 'error'
        ) {
            continue;
        }
        if (
            (sectionPlan.dynamicState === 'loading' || sectionPlan.dynamicState === 'error')
            && sectionPlan.options.length === 0
        ) {
            // Skeleton-only loading or error without stale rows — no real
            // option rows exist to virtualize.
            continue;
        }
        const mode: SelectionListVirtualizationMode = sectionPlan.virtualization ?? 'auto';
        if (mode === 'force') {
            eligible.push(sectionPlan.id);
            continue;
        }
        if (
            mode === 'auto'
            && sectionPlan.options.length > SELECTION_LIST_VIRTUALIZATION_THRESHOLD
        ) {
            eligible.push(sectionPlan.id);
        }
    }
    return eligible;
}

function countVirtualizationEligibleSections(plan: ReadonlyArray<SectionRenderPlan>): number {
    return collectVirtualizationEligibleSectionIds(plan).length;
}

/**
 * Decide whether the rendered plan contains AT LEAST ONE section that will
 * own its own scroll container (FlashList). When true, the body MUST NOT
 * wrap in an outer ScrollView — FlashList owns the scroll.
 *
 * RV-9 / FRESH-3 — Previously this predicate returned `false` for
 * MULTI-eligible plans (the body then wrapped the body in ScrollView AND
 * still rendered the first section through `SelectionListVirtualizedSection`,
 * producing a nested FlashList-in-ScrollView anti-pattern). The new
 * single-FlashList multi-section path covers ALL sections in one FlashList,
 * so the predicate now signals "FlashList owns scroll" for any
 * virtualization-eligible plan (single OR multi).
 */
export function planHasVirtualizedSection(plan: ReadonlyArray<SectionRenderPlan>): boolean {
    return countVirtualizationEligibleSections(plan) >= 1;
}

export function planHasEligibleStaleDynamicSection(
    plan: ReadonlyArray<SectionRenderPlan>,
): boolean {
    const eligibleIds = new Set(collectVirtualizationEligibleSectionIds(plan));
    for (const sectionPlan of plan) {
        if (!eligibleIds.has(sectionPlan.id)) continue;
        if (
            sectionPlan.dynamicState === 'loading'
            || sectionPlan.dynamicState === 'error'
        ) {
            return true;
        }
    }
    return false;
}

/**
 * RV-9 / FRESH-3: predicate that decides whether the body collapses ALL
 * sections into a single flat FlashList (true) or keeps the section-scoped
 * `SelectionListVirtualizedSection` path (false). Returns true when 2+
 * sections are virtualization-eligible.
 *
 * FR4-3: also returns true when an eligible section is in a stale
 * `dynamicState` (`loading` / `error` with prior options preserved). The
 * single-section `SelectionListVirtualizedSection` path's loading/error
 * branches render through `PlanSuccessRows` (mapped, non-virtualized), so a
 * stale section must go through the flat-FlashList renderer instead — its
 * `flattenRenderPlanForFlashList` already knows how to emit
 * loading-with-stale and error-with-stale rows through the FlashList
 * recycler.
 */
export function planHasMultipleVirtualizedSections(
    plan: ReadonlyArray<SectionRenderPlan>,
): boolean {
    if (countVirtualizationEligibleSections(plan) >= 2) return true;
    return planHasEligibleStaleDynamicSection(plan);
}

/**
 * Single-virtualized-section helper retained for the single-eligible path.
 * Returns the (at-most-one) section id that should render through
 * `SelectionListVirtualizedSection`. Multi-eligible plans go through the
 * single-FlashList flat path instead and do not consult this helper.
 */
export function resolveVirtualizedSectionIds(
    plan: ReadonlyArray<SectionRenderPlan>,
): ReadonlySet<string> {
    return new Set(collectVirtualizationEligibleSectionIds(plan));
}

/**
 * RV-9 / FRESH-3: dev-only deduplicated warning. The warning is gated to
 * non-production `NODE_ENV` (we use `process.env.NODE_ENV` rather than the
 * vite-inlined `__DEV__` constant so tests can stub via `vi.stubEnv`).
 * Each multi-virtualized descriptor signature is warned at most once per
 * module lifetime.
 */
const seenMultiVirtualizationWarnings = new Set<string>();

/**
 * RV-9 / FRESH-3: test hook to reset the warning-dedupe cache between test
 * cases. The cache is module-level (single per JS realm) so tests that
 * exercise the warning path need a clean slate.
 */
export function resetSelectionListMultiVirtualizationWarningCache(): void {
    seenMultiVirtualizationWarnings.clear();
}

export function maybeWarnAboutMultipleVirtualizedSections(
    eligibleSectionIds: ReadonlyArray<string>,
): void {
    if (eligibleSectionIds.length < 2) return;
    // Dev gate: NODE_ENV !== 'production'. We avoid `__DEV__` because it is
    // a bundler-inlined constant that cannot be stubbed per-test, while
    // `process.env.NODE_ENV` can be stubbed via `vi.stubEnv`.
    const nodeEnv = typeof process !== 'undefined' && process.env
        ? process.env.NODE_ENV
        : undefined;
    if (nodeEnv === 'production') return;
    const signature = eligibleSectionIds.join('|');
    if (seenMultiVirtualizationWarnings.has(signature)) return;
    seenMultiVirtualizationWarnings.add(signature);
    // eslint-disable-next-line no-console
    console.warn(
        `[SelectionList] Step has multiple virtualized-eligible sections (${signature}); ` +
            'collapsing them into a single FlashList for the entire body. Consider whether ' +
            'these sections can be combined into one or set virtualization: "never" on ' +
            'all-but-one section at the descriptor level.',
    );
}

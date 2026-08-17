/**
 * FR4-W2-BODY — pure policy module extracted from `SelectionListBody.tsx`.
 *
 * Owns the decision logic that picks between three rendering paths:
 *  - 0 eligible sections → plain ScrollView path
 *  - 1 eligible section with no neighboring sections →
 *    `SelectionListVirtualizedSection` per-section path
 *  - any eligible section with neighboring sections, or ≥1 stale-eligible →
 *    single flat virtualized list path
 *
 * ...and, on top of them, the LATCH that makes that choice survive a filter
 * (`resolveSelectionListBodyRenderer` → `advanceSelectionListBodyRendererLatch`
 * → `applyLatchedVirtualizationToPlan`). The predicates above all read the
 * current plan, which moves under the user; the latch is what the body is
 * allowed to consume.
 *
 * No JSX, no React state — the latch is a value the caller carries between
 * renders, not a hook. The body component imports these and dispatches to the
 * appropriate renderer.
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
 * own its own scroll container (virtualized list). When true, the body MUST NOT
 * wrap in an outer ScrollView — virtualized list owns the scroll.
 *
 * RV-9 / FRESH-3 — Previously this predicate returned `false` for
 * MULTI-eligible plans (the body then wrapped the body in ScrollView AND
 * still rendered the first section through `SelectionListVirtualizedSection`,
 * producing a nested virtualized list-in-ScrollView anti-pattern). The new
 * single virtualized list multi-section path covers ALL sections in one virtualized list,
 * so the predicate now signals "virtualized list owns scroll" for any
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
 * sections into a single flat virtualized list (true) or keeps the section-scoped
 * `SelectionListVirtualizedSection` path (false).
 *
 * A section-scoped virtualized list can own the body scroll only when it is the
 * body's sole section. If neighboring sections exist, they otherwise sit
 * outside that scroll owner: keyboard focus can be revealed inside the
 * virtualized section while the section itself remains clipped below the
 * body viewport. In that topology the flat virtualized list must own every section,
 * including non-virtualized neighbors.
 *
 * FR4-3: also returns true when an eligible section is in a stale
 * `dynamicState` (`loading` / `error` with prior options preserved). The
 * single-section `SelectionListVirtualizedSection` path's loading/error
 * branches render through `PlanSuccessRows` (mapped, non-virtualized), so a
 * stale section must go through the flat-virtualized list renderer instead — its
 * `flattenRenderPlanForVirtualizedList` already knows how to emit
 * loading-with-stale and error-with-stale rows through the virtualized list
 * recycler.
 */
export function planRequiresFlatVirtualizedList(
    plan: ReadonlyArray<SectionRenderPlan>,
): boolean {
    if (countVirtualizationEligibleSections(plan) === 0) return false;
    if (plan.length > 1) return true;
    return planHasEligibleStaleDynamicSection(plan);
}

/**
 * WHICH component renders the body. Ordered by capability, and that order is
 * the point: `flatVirtualized` renders everything `sectionVirtualized` can
 * render and everything `scrollFrame` can render, and `sectionVirtualized`
 * subsumes `scrollFrame`. A surface may therefore ESCALATE along this ladder
 * without losing anything, and must never walk back down it under the user.
 */
export type SelectionListBodyRenderer =
    | 'scrollFrame'
    | 'sectionVirtualized'
    | 'flatVirtualized';

const BODY_RENDERER_RANK: Readonly<Record<SelectionListBodyRenderer, number>> = {
    scrollFrame: 0,
    sectionVirtualized: 1,
    flatVirtualized: 2,
};

export type ResolveSelectionListBodyRendererArgs = Readonly<{
    plan: ReadonlyArray<SectionRenderPlan>;
    /** The caller DECLARED pagination — a declaration, not a plan-derived count. */
    declaresPagination: boolean;
    /** The caller DECLARED `columns` — see `SelectionListBodyProps.declaresColumns`. */
    declaresColumns: boolean;
}>;

/**
 * The renderer the CURRENT plan alone would ask for. Every plan-derived input
 * here is transient — an option count that moves with the filter, a section
 * count that moves when a filter empties a section, a `dynamicState` that moves
 * on every refetch — which is exactly why no caller may consume this directly.
 * It is the raw signal that `advanceSelectionListBodyRendererLatch` turns into
 * a stable choice.
 */
export function resolveSelectionListBodyRenderer(
    args: ResolveSelectionListBodyRendererArgs,
): SelectionListBodyRenderer {
    if (args.declaresPagination) return 'flatVirtualized';
    if (planRequiresFlatVirtualizedList(args.plan)) return 'flatVirtualized';
    if (!planHasVirtualizedSection(args.plan)) return 'scrollFrame';
    return args.declaresColumns ? 'flatVirtualized' : 'sectionVirtualized';
}

/**
 * The body's renderer choice, latched for the lifetime of one step.
 *
 * `virtualizedSectionIds` is the set of sections that have been
 * virtualization-eligible at any point in that lifetime, not the set that is
 * eligible right now.
 */
export type SelectionListBodyRendererLatch = Readonly<{
    stepId: string;
    renderer: SelectionListBodyRenderer;
    virtualizedSectionIds: ReadonlySet<string>;
}>;

export type AdvanceSelectionListBodyRendererLatchArgs =
    ResolveSelectionListBodyRendererArgs & Readonly<{ stepId: string }>;

/**
 * A FILTER MAY NOT PICK THE RENDERER.
 *
 * `resolveSelectionListBodyRenderer` reads the CURRENT plan, and every input it
 * reads moves while the user types: filtering a 60-option list to 49 crosses
 * `SELECTION_LIST_VIRTUALIZATION_THRESHOLD`, filtering a section to zero rows
 * drops it out of the plan and takes `plan.length > 1` with it, and a dynamic
 * section entering `loading` on the next keystroke flips the stale predicate.
 * Consuming that raw signal meant the body unmounted one renderer and mounted
 * another MID-KEYSTROKE, taking scroll position, focus and every row's identity
 * with it — the same defect class as deriving the ARIA pattern from the
 * filtered plan, or the renderer from a measured column count.
 *
 * So the choice is latched per step and only ever ESCALATES: the ladder in
 * `SelectionListBodyRenderer` is ordered by capability, so a surface that
 * reaches `flatVirtualized` keeps a renderer that can draw every later plan,
 * and no keystroke can walk it back down. The other direction still works —
 * a list that opens under the threshold and GROWS past it (a dynamic section
 * resolving, a step handed more options) escalates on the render that grows it
 * and stays there, because escalation adds capability while de-escalation is
 * the thing that tears the subtree down.
 *
 * The latch is scoped by `stepId` rather than by mount: the live body remounts
 * per step inside the cross-slide switch while the hidden measure mirror does
 * not, and the two must resolve the same renderer or the mirror reports a
 * height for a body the user is not looking at.
 *
 * Returns `previous` unchanged when nothing escalated, so a caller holding it
 * in a ref does no work on the overwhelming majority of renders.
 */
export function advanceSelectionListBodyRendererLatch(
    previous: SelectionListBodyRendererLatch | null,
    args: AdvanceSelectionListBodyRendererLatchArgs,
): SelectionListBodyRendererLatch {
    const resolved = resolveSelectionListBodyRenderer(args);
    const eligibleNow = collectVirtualizationEligibleSectionIds(args.plan);
    if (previous === null || previous.stepId !== args.stepId) {
        return {
            stepId: args.stepId,
            renderer: resolved,
            virtualizedSectionIds: new Set(eligibleNow),
        };
    }
    const escalated = BODY_RENDERER_RANK[resolved] > BODY_RENDERER_RANK[previous.renderer]
        ? resolved
        : previous.renderer;
    const added = eligibleNow.filter((id) => !previous.virtualizedSectionIds.has(id));
    if (escalated === previous.renderer && added.length === 0) return previous;
    return {
        stepId: previous.stepId,
        renderer: escalated,
        virtualizedSectionIds: added.length === 0
            ? previous.virtualizedSectionIds
            : new Set([...previous.virtualizedSectionIds, ...added]),
    };
}

/**
 * Publish the latched decision INTO the plan the per-section renderer reads.
 *
 * `SelectionListDynamicSectionRows` and `SelectionListVirtualizedSection` each
 * re-derive "is this section over the threshold?" from the section's CURRENT
 * option count, so a latched section whose filter dropped it under the
 * threshold would still swap `SelectionListVirtualizedSection` for mapped rows
 * one level below the body — the same tear-down, one layer down. Marking those
 * sections `'force'` is how this module states its decision in the vocabulary
 * those renderers already obey, so the count they re-derive cannot contradict
 * the latch.
 *
 * Only sections that currently carry rows are forced: a section sitting in
 * `empty` / `notFound` / first-load `loading` has nothing to virtualize, and
 * those branches never reach the count check anyway.
 *
 * Returns the plan unchanged when no section needs it.
 */
export function applyLatchedVirtualizationToPlan(
    plan: ReadonlyArray<SectionRenderPlan>,
    latchedSectionIds: ReadonlySet<string>,
): ReadonlyArray<SectionRenderPlan> {
    if (latchedSectionIds.size === 0) return plan;
    let changed = false;
    const next = plan.map((sectionPlan) => {
        if (!latchedSectionIds.has(sectionPlan.id)) return sectionPlan;
        if (sectionPlan.options.length === 0) return sectionPlan;
        const mode: SelectionListVirtualizationMode = sectionPlan.virtualization ?? 'auto';
        // `'never'` is the caller's declaration, and a declaration outranks a
        // latch: a section can only enter the latch while it is `'auto'` or
        // `'force'`, so this guards the caller flipping the hint mid-life.
        if (mode !== 'auto') return sectionPlan;
        if (sectionPlan.options.length > SELECTION_LIST_VIRTUALIZATION_THRESHOLD) {
            return sectionPlan;
        }
        changed = true;
        return { ...sectionPlan, virtualization: 'force' as const };
    });
    return changed ? next : plan;
}

/**
 * Single-virtualized-section helper retained for the single-eligible path.
 * Returns the (at-most-one) section id that should render through
 * `SelectionListVirtualizedSection`. Multi-eligible plans go through the
 * single virtualized list flat path instead and do not consult this helper.
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
            'collapsing them into a single virtualized list for the entire body. Consider whether ' +
            'these sections can be combined into one or set virtualization: "never" on ' +
            'all-but-one section at the descriptor level.',
    );
}

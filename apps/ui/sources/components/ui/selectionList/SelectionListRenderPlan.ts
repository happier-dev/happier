/**
 * Pure render-plan synthesizer for the SelectionList orchestrator.
 *
 * R14 extracted this from `SelectionList.tsx` to keep the orchestrator under
 * 400 lines and make the per-section state branching independently testable.
 * The synthesizer takes the current step's section descriptors, the dynamic
 * sections' resolver state map, and the input + filter strings, and produces
 * an ordered `SectionRenderPlan[]` consumed by the body renderer.
 *
 * The plan carries the FULL state needed to render each section variant
 * (loading skeletons, error rows with a fallback hint, empty-hint rows,
 * success rows). Variants are flagged via `dynamicState`; success entries
 * have `dynamicState: undefined`.
 */

import { SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS } from './_constants';
import { filterSelectionListSections } from './filterSelectionListSections';
import type {
    SelectionListOption,
    SelectionListSectionDescriptor,
    SelectionListVirtualizationMode,
} from './_types';
import type { DynamicSectionState } from './useSelectionListDynamicSections';

export type SectionRenderPlan = Readonly<{
    id: string;
    title?: string;
    count?: number;
    options: ReadonlyArray<SelectionListOption>;
    virtualization?: SelectionListVirtualizationMode;
    /** When set, the section is in a non-success dynamic state. */
    dynamicState?: 'loading' | 'error' | 'empty' | 'notFound';
    /** True when rendering stale (last-success) options during a refetch/error. */
    isStale?: boolean;
    /** Loading/error/empty/notFound hint copy, when applicable. */
    hint?: string;
    /** Loading skeleton row count when dynamicState === 'loading'. */
    skeletonRowCount?: number;
    /**
     * RUX-1 Issue 8: optional transition key for dynamic-section content
     * swaps. When the resolver seed changes such that the rendered options
     * represent a logically-different "place" (e.g. drilling from
     * `~/Documents/` into `~/Documents/work/`), the body wraps the success
     * rows in a `SlideTransitionSwitch` keyed by this string so the swap
     * animates instead of snapping. Currently sourced from the dynamic
     * section state's `seed`. Static sections never set this.
     */
    transitionKey?: string;
}>;

/**
 * Apply the same case-insensitive substring filter to dynamic-section options
 * that `filterSelectionListSections` applies to static-section options. Used
 * by the orchestrator to narrow dynamic success rows against the current
 * input filter query (R9 blocker 3).
 *
 * RUX-1 Issue 1: this is now an alias for `rankOptionsByQuery` so dynamic
 * sections share the same prefix-priority ranking as static sections.
 * Returns the original array reference unchanged when the query is empty so
 * the orchestrator can cheaply skip re-rendering.
 *
 * RUX-9.2: pass `disableSubtitleTier=true` to skip tier-3 (subtitle.includes)
 * for domains where the subtitle would create false-positive matches (e.g.
 * paths whose subtitle always contains the parent directory).
 */
export function filterDynamicOptionsByQuery(
    options: ReadonlyArray<SelectionListOption>,
    query: string,
    disableSubtitleTier?: boolean,
): ReadonlyArray<SelectionListOption> {
    return rankOptionsByQuery(options, query, disableSubtitleTier);
}

/**
 * RUX-1 Issue 1: rank options into 3 tiers given a query, preserving each
 * option's original index within its tier (which itself preserves the
 * descriptor's original alphabetical/curated order):
 *   tier 1 — label starts with the query (case-insensitive)
 *   tier 2 — label contains the query (not at start)
 *   tier 3 — subtitle contains the query
 * Options with no match are dropped. Returns the original array reference
 * unchanged when the query is empty so consumers can cheaply skip
 * re-rendering.
 *
 * Background: the user typed "de" in the path picker and got
 * ".codex-pr-fixups" first because it was alphabetically earlier than "dev".
 * Substring-only filtering with alphabetical ordering buries the obviously-
 * relevant prefix match. Tiered ranking matches what users intuit from
 * IDE-style fuzzy pickers (VSCode, JetBrains, Sublime).
 */
export function rankOptionsByQuery(
    options: ReadonlyArray<SelectionListOption>,
    query: string,
    disableSubtitleTier?: boolean,
): ReadonlyArray<SelectionListOption> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) return options;
    const tier1: { idx: number; option: SelectionListOption }[] = [];
    const tier2: { idx: number; option: SelectionListOption }[] = [];
    const tier3: { idx: number; option: SelectionListOption }[] = [];
    for (let i = 0; i < options.length; i += 1) {
        const option = options[i]!;
        const label = option.label.toLowerCase();
        if (label.startsWith(normalized)) {
            tier1.push({ idx: i, option });
            continue;
        }
        if (label.includes(normalized)) {
            tier2.push({ idx: i, option });
            continue;
        }
        // RUX-9.2: tier-3 (subtitle.includes) is opt-out per call. The path
        // domain disables it because every row's subtitle is the absolute
        // path which always contains the parent directory, so tier-3 would
        // match EVERY child when typing inside a folder, polluting the
        // ranking with false positives.
        if (disableSubtitleTier === true) continue;
        if (option.subtitle && option.subtitle.toLowerCase().includes(normalized)) {
            tier3.push({ idx: i, option });
            continue;
        }
    }
    // Stable order within each tier is the original input order. The caller
    // is responsible for sorting the input alphabetically beforehand if
    // alphabetical-within-tier is the desired behavior.
    const out: SelectionListOption[] = [];
    for (const { option } of tier1) out.push(option);
    for (const { option } of tier2) out.push(option);
    for (const { option } of tier3) out.push(option);
    return out;
}

export type SynthesizeSelectionListRenderPlanArgs = Readonly<{
    sections: ReadonlyArray<SelectionListSectionDescriptor>;
    /** Raw input value (used to evaluate `visibleWhen` predicates). */
    inputValue: string;
    /**
     * Filter query (already adapted via `inputBehavior.getFilterQueryFromInput`
     * when one is registered). Used to narrow both static and dynamic rows.
     */
    filterQuery: string;
    /** Dynamic-section state map, keyed by section id. */
    dynamicSectionStates: ReadonlyMap<string, DynamicSectionState>;
}>;

/**
 * Build the ordered render plan for a step's sections.
 *
 *   - Static sections flow through `filterSelectionListSections` for substring
 *     matching; sections whose filter narrows to zero rows are dropped.
 *   - Dynamic sections are gated by `visibleWhen(inputValue)` first; when
 *     visible, the per-section state in `dynamicSectionStates` decides the
 *     branch:
 *       - `idle`     → render nothing
 *       - `loading`  → loading entry (preserves `lastSuccessOptions` as stale)
 *       - `error`    → error entry (preserves stale options under the error)
 *       - `success`  → filtered options or an empty-hint entry, or nothing
 *
 * Returns a fresh array on every call; safe to use as a memo result.
 */
export function synthesizeSelectionListRenderPlan(
    args: SynthesizeSelectionListRenderPlanArgs,
): ReadonlyArray<SectionRenderPlan> {
    const { sections, inputValue, filterQuery, dynamicSectionStates } = args;

    // RUX-1 Issue 6: detect whether ANY dynamic section is currently visible
    // and reports notFound. When true, static sections in this step skip the
    // filter pass so favorites/recents remain visible (otherwise the typed
    // path filters them to empty, leaving only the error row).
    let anyVisibleNotFound = false;
    for (const descriptor of sections) {
        if (descriptor.kind !== 'dynamic') continue;
        if (descriptor.visibleWhen && !descriptor.visibleWhen(inputValue)) continue;
        const state = dynamicSectionStates.get(descriptor.id);
        if (state?.status === 'success' && state.notFound === true) {
            anyVisibleNotFound = true;
            break;
        }
    }

    // First filter the static sections through the existing filter (preserves
    // virtualization hint via the discriminated union). Bypass filtering
    // entirely when a sibling dynamic section reported notFound.
    const staticDescriptors = sections.filter(
        (s): s is SelectionListSectionDescriptor & { kind: 'static' } => s.kind === 'static',
    );
    const filteredStatic = anyVisibleNotFound
        ? staticDescriptors
        : filterSelectionListSections(staticDescriptors, filterQuery);
    const staticByOriginalId = new Map<string, SelectionListSectionDescriptor & { kind: 'static' }>();
    for (const s of filteredStatic) {
        if (s.kind === 'static') staticByOriginalId.set(s.id, s);
    }

    const plan: SectionRenderPlan[] = [];
    for (const descriptor of sections) {
        if (descriptor.kind === 'static') {
            const filtered = staticByOriginalId.get(descriptor.id);
            if (!filtered) continue;
            // RUX-9.1: drop static sections with zero options entirely —
            // including the empty-query path where `filterSelectionListSections`
            // is a no-op and the descriptor's own options array is empty
            // (e.g. an empty Favorites section before any favorites are
            // saved). Otherwise the header renders alone above no rows.
            if (filtered.options.length === 0) continue;
            plan.push({
                id: filtered.id,
                title: filtered.title,
                count: filtered.count,
                options: filtered.options,
                virtualization: filtered.virtualization,
            });
            continue;
        }
        // Dynamic descriptor.
        if (descriptor.visibleWhen && !descriptor.visibleWhen(inputValue)) {
            continue;
        }
        const state = dynamicSectionStates.get(descriptor.id);
        if (!state) continue;
        const baseEntry = {
            id: descriptor.id,
            title: descriptor.title,
            virtualization: descriptor.virtualization,
        } as const;
        switch (state.status) {
            case 'idle': {
                // RUX-11.1: a freshly-mounted hook can be in `idle` state
                // for a single render before the dispatch effect transitions
                // to `loading`. When the cross-mount cache seeded
                // `lastSuccessOptions`, surface those rows as stale so the
                // user sees the cached results immediately on popover
                // reopen instead of a one-frame empty flash.
                const cachedStale = state.lastSuccessOptions ?? [];
                if (cachedStale.length === 0) continue;
                plan.push({
                    ...baseEntry,
                    options: cachedStale,
                    dynamicState: 'loading',
                    isStale: true,
                    skeletonRowCount: 0,
                });
                continue;
            }
            case 'loading': {
                // RUX-1 Issue 2: stale-while-revalidate. When prior options
                // are cached, render them as the loading entry's option list
                // (with the body decorating them at reduced opacity to signal
                // staleness) and SUPPRESS skeleton rows entirely. Skeletons
                // only surface on first load (no prior data) — otherwise
                // they cause a visible flicker between consecutive fetches
                // (e.g. typing "d" then "de" briefly empties the list).
                const stale = state.lastSuccessOptions ?? [];
                const hasStale = stale.length > 0;
                // RUX-11.2: on a TRUE first load (no stale cache), hide the
                // section entirely UNLESS the descriptor opts into eager
                // skeletons. The open-flicker symptom was: open path popover →
                // "In this folder" header + empty body flashes briefly before
                // the first resolve lands. Dropping the section keeps
                // Favorites + Recent visible until results arrive.
                if (!hasStale && descriptor.showSkeletonsOnFirstLoad !== true) {
                    continue;
                }
                plan.push({
                    ...baseEntry,
                    options: stale,
                    dynamicState: 'loading',
                    isStale: hasStale,
                    skeletonRowCount: hasStale
                        ? 0
                        : (descriptor.loadingSkeletonRows ?? SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS),
                });
                continue;
            }
            case 'error': {
                const message = state.error?.message;
                plan.push({
                    ...baseEntry,
                    options: state.options,
                    dynamicState: 'error',
                    // Only forward the resolver's message when it's non-empty;
                    // otherwise the body falls back to the i18n-keyed label.
                    hint: message && message.length > 0 ? message : undefined,
                    isStale: state.options.length > 0,
                });
                continue;
            }
            case 'success': {
                // RUX-1 Issue 6: notFound is a successful resolve that
                // signals the target doesn't exist. Render a dedicated hint
                // row and DO NOT filter the resolver's (empty) options.
                if (state.notFound === true) {
                    plan.push({
                        ...baseEntry,
                        options: [],
                        dynamicState: 'notFound',
                        hint: state.notFoundHint,
                    });
                    continue;
                }
                const filteredOptions = filterDynamicOptionsByQuery(
                    state.options,
                    filterQuery,
                    descriptor.disableSubtitleRanking === true,
                );
                if (filteredOptions.length === 0) {
                    if (state.emptyHint !== undefined && state.emptyHint.length > 0) {
                        plan.push({
                            ...baseEntry,
                            options: [],
                            dynamicState: 'empty',
                            hint: state.emptyHint,
                        });
                    }
                    continue;
                }
                plan.push({
                    ...baseEntry,
                    options: filteredOptions,
                    // RUX-1 Issue 8: surface the resolver seed so the body
                    // can animate content swaps when the seed changes
                    // (e.g. drilling into a child directory in the path
                    // picker) instead of snapping the new rows in place.
                    transitionKey: state.seed,
                });
                continue;
            }
        }
    }
    return plan;
}

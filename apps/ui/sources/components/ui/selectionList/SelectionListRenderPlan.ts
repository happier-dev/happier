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

import { rankHappierQueryMatches, type HappierQueryText } from '@happier-dev/plugin-ui/presentation';
import { buildSelectionListSectionDisclosureOption, type SelectionListSectionDisclosures } from './selectionListSectionDisclosure';

import { SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS } from './_constants';
import { filterSelectionListSections } from './filterSelectionListSections';
import type {
    SelectionListOption,
    SelectionListLazyVisual,
    SelectionListSectionAction,
    SelectionListSectionDescriptor,
    SelectionListVirtualizationMode,
} from './_types';
import { SelectionListSectionFailure } from './selectionListSectionFailure';
import type { DynamicSectionState } from './useSelectionListDynamicSections';

const EMPTY_OPTIONS: readonly SelectionListOption[] = Object.freeze([]);

export type SectionRenderPlan = Readonly<{
    id: string;
    title?: string;
    rightAccessory?: SelectionListLazyVisual;
    count?: number;
    action?: SelectionListSectionAction;
    options: ReadonlyArray<SelectionListOption>;
    virtualization?: SelectionListVirtualizationMode;
    /** When set, the section is in a non-success dynamic state. */
    dynamicState?: 'loading' | 'error' | 'empty' | 'notFound';
    /** True when rendering stale (last-success) options during a refetch/error. */
    isStale?: boolean;
    /** Loading/error/empty/notFound hint copy, when applicable. */
    hint?: string;
    /** Non-activatable status rendered after successful result rows. */
    resultHint?: string;
    /** `error` only: the failure line's Retry link (label already translated). */
    retry?: Readonly<{ label: string; onPress: () => void }>;
    /** `error` only: failures sharing this key are said once, under the first section in plan order. */
    failureCauseKey?: string;
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
 * Picker options ranked by the one shared query ranking (`rankHappierQueryMatches`, plugin-ui): label
 * prefix or exact identity, then label, then subtitle, then hidden `searchText`, each band in the
 * descriptor's order. An empty query returns `options` itself.
 *
 * RUX-9.2: `disableSubtitleTier` leaves the subtitle out for domains whose subtitle repeats the query's
 * context on every row (paths, whose subtitle contains the parent directory).
 */
export function rankOptionsByQuery(
    options: ReadonlyArray<SelectionListOption>,
    query: string,
    disableSubtitleTier?: boolean,
): ReadonlyArray<SelectionListOption> {
    return rankHappierQueryMatches(options, query, selectionListOptionQueryText, {
        matchSubtitle: disableSubtitleTier !== true,
    });
}

function selectionListOptionQueryText(option: SelectionListOption): HappierQueryText {
    return option;
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
    searchAcrossSections?: boolean;
    /** Which collapsible sections are open (the list's `useSelectionListSectionDisclosures`). */
    sectionDisclosures?: SelectionListSectionDisclosures;
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
            // RUX-9.1: drop static sections with neither rows nor a truthful
            // status hint. A hint is itself visible section content (for
            // example, incomplete Session discovery), while an empty Favorites
            // section remains absent instead of rendering a bare header.
            if (filtered.options.length === 0 && !filtered.resultHint) continue;
            // A collapsible section reads as one disclosure row until it is opened; a search shows its matches.
            if (filtered.collapsible === true && filterQuery.trim().length === 0 && args.sectionDisclosures) {
                const disclosure = args.sectionDisclosures(filtered.id);
                plan.push({
                    id: filtered.id,
                    options: [
                        buildSelectionListSectionDisclosureOption({ sectionId: filtered.id,
                            label: filtered.title ?? filtered.id, open: disclosure.open, onToggle: disclosure.onToggle }),
                        ...(disclosure.open ? filtered.options : []),
                    ],
                    virtualization: filtered.virtualization,
                });
                continue;
            }
            plan.push({
                id: filtered.id,
                title: filtered.title,
                rightAccessory: filtered.rightAccessory,
                count: filtered.count,
                action: filtered.action,
                options: filtered.options,
                virtualization: filtered.virtualization,
                resultHint: filtered.resultHint,
            });
            continue;
        }
        // Dynamic descriptor.
        if (descriptor.visibleWhen && !descriptor.visibleWhen(inputValue)) {
            continue;
        }
        const state = dynamicSectionStates.get(descriptor.id);
        if (!state) continue;
        const retainedOptions = state.status === 'idle' || state.status === 'loading'
            ? state.lastSuccessOptions ?? EMPTY_OPTIONS
            : state.options;
        const options = descriptor.projectOptions?.(retainedOptions) ?? retainedOptions;
        const baseEntry = {
            id: descriptor.id,
            title: descriptor.title,
            rightAccessory: descriptor.rightAccessory,
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
                const cachedStale = options;
                if (cachedStale.length === 0) {
                    if (descriptor.showSkeletonsOnFirstLoad !== true) continue;
                    plan.push({
                        ...baseEntry,
                        options: [],
                        dynamicState: 'loading',
                        isStale: false,
                        ...(descriptor.loadingHint ? { hint: descriptor.loadingHint } : {}),
                        skeletonRowCount: descriptor.loadingHint ? 0 : descriptor.loadingSkeletonRows
                            ?? SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS,
                    });
                    continue;
                }
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
                // when refreshing the same seed. The dynamic owner suppresses
                // prior-seed rows before they reach this plan.
                const stale = options;
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
                    ...(!hasStale && descriptor.loadingHint ? { hint: descriptor.loadingHint } : {}),
                    skeletonRowCount: hasStale || descriptor.loadingHint
                        ? 0
                        : (descriptor.loadingSkeletonRows ?? SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS),
                });
                continue;
            }
            case 'error': {
                const failure = state.error instanceof SelectionListSectionFailure ? state.error : undefined;
                plan.push({
                    ...baseEntry,
                    options,
                    dynamicState: 'error',
                    // Resolver errors can contain transport details, paths, or
                    // credentials. Keep the Error available to diagnostics in
                    // the dynamic-state owner, but present only the canonical
                    // localized fallback (or the section owner's own host copy) at this user-visible boundary.
                    hint: failure?.hint ?? descriptor.errorHint,
                    isStale: options.length > 0,
                    ...(failure?.causeKey !== undefined ? { failureCauseKey: failure.causeKey } : {}),
                    ...(descriptor.retryLabel !== undefined && failure?.retryable !== false && state.retry !== undefined
                        ? { retry: { label: descriptor.retryLabel, onPress: state.retry } }
                        : {}),
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
                // `resultFiltering: 'provider'` sections were already filtered
                // and ranked by their canonical executor; host matching would
                // drop relevant rows (a transcript excerpt need not repeat the
                // query in its title) and reorder provider relevance.
                const filteredOptions = descriptor.resultFiltering === 'provider'
                    ? options
                    : rankOptionsByQuery(
                        options,
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
                    resultHint: state.resultHint,
                    // RUX-1 Issue 8: surface the resolver seed so the body
                    // can animate content swaps when the seed changes
                    // (e.g. drilling into a child directory in the path
                    // picker) instead of snapping the new rows in place.
                    transitionKey: descriptor.resultTransition === 'none'
                        ? undefined
                        : state.seed,
                });
                continue;
            }
        }
    }
    const sayEachCauseOnce = sayEachFailureCauseOnce(plan);
    if (args.searchAcrossSections === true && filterQuery.trim().length > 0) {
        // Authored groups remain useful when browsing, but cannot put a
        // description-only match ahead of a title match while searching.
        // Keep pending/error/stale rows in their original status sections.
        const resultSections = sayEachCauseOnce.filter(section => section.dynamicState === undefined && !section.isStale);
        const options = rankOptionsByQuery(resultSections.flatMap(section => section.options), filterQuery);
        const firstResultSection = resultSections.find(section => section.options.length > 0);
        return sayEachCauseOnce.flatMap(section => {
            if (section.dynamicState !== undefined || section.isStale) return [section];
            if (section === firstResultSection) return [{ ...section, title: undefined, count: undefined, options }];
            return section.resultHint ? [{ ...section, options: [] }] : [];
        });
    }
    return sayEachCauseOnce;
}

/**
 * Sections that fail for one named cause (a failure's `causeKey`) say it once: the first section in plan
 * order keeps its line, later row-less ones step aside, and the kept line's Retry re-runs every section it
 * stands for.
 */
function sayEachFailureCauseOnce(plan: ReadonlyArray<SectionRenderPlan>): ReadonlyArray<SectionRenderPlan> {
    const keptByCause = new Map<string, SectionRenderPlan>();
    const retriesByCause = new Map<string, Array<() => void>>();
    const collapsed = new Set<SectionRenderPlan>();
    for (const entry of plan) {
        const cause = entry.dynamicState === 'error' ? entry.failureCauseKey : undefined;
        if (cause === undefined) continue;
        if (!keptByCause.has(cause)) {
            keptByCause.set(cause, entry);
            continue;
        }
        if (entry.options.length > 0) continue;
        collapsed.add(entry);
        if (entry.retry) retriesByCause.set(cause, [...(retriesByCause.get(cause) ?? []), entry.retry.onPress]);
    }
    if (collapsed.size === 0) return plan;
    return plan.flatMap((entry) => {
        if (collapsed.has(entry)) return [];
        const behind = entry.failureCauseKey !== undefined && keptByCause.get(entry.failureCauseKey) === entry
            ? retriesByCause.get(entry.failureCauseKey)
            : undefined;
        if (!behind || !entry.retry) return [entry];
        const own = entry.retry.onPress;
        return [{ ...entry, retry: { label: entry.retry.label, onPress: () => { own(); behind.forEach((retry) => retry()); } } }];
    });
}

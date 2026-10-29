import * as React from 'react';

import {
    SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS,
    SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS,
} from './_constants';
import {
    buildDynamicSectionCacheKey,
    getDefaultDynamicSectionCache,
    type SelectionListDynamicSectionCache,
} from './selectionListDynamicSectionCache';
import type {
    SelectionListDynamicSection,
    SelectionListDynamicSectionResolveResult,
    SelectionListInputBehavior,
    SelectionListOption,
} from './_types';

export type DynamicSectionStatus = 'idle' | 'loading' | 'success' | 'error';

export type DynamicSectionState = Readonly<{
    status: DynamicSectionStatus;
    options: ReadonlyArray<SelectionListOption>;
    emptyHint?: string;
    resultHint?: string;
    error?: Error;
    /** The seed used for the most recently dispatched (or last successful) request. */
    seed?: string;
    /** Last-known-good options for this seed, preserved across loading / error transitions. */
    lastSuccessOptions?: ReadonlyArray<SelectionListOption>;
    /**
     * RUX-1 Issue 6: the most recent successful resolve reported the target
     * does not exist (e.g. ENOENT). Used by the render plan to surface a
     * dedicated "not found" UI and to relax filtering on sibling static
     * sections so favorites/recents remain visible.
     */
    notFound?: boolean;
    /** Optional override copy for the notFound hint. */
    notFoundHint?: string;
    /** `status: 'error'` only: re-runs the section's resolver for the seed that failed. */
    retry?: () => void;
}>;

/**
 * RUX-11.1 — cross-mount cache of last-successful options keyed by
 * an unambiguous JSON tuple of `[id, resolverKey, seed]`. The cache solves the open-flicker
 * symptom: opening the path popover used to render an empty body before
 * the dynamic resolver completed, even when reopening immediately after
 * close. The hook's per-mount state is lost on unmount; the cross-mount
 * cache lets a new mount seed `lastSuccessOptions` from the last known
 * good response so the orchestrator renders cached rows immediately.
 *
 * FR4-12 moved the cache behind an explicit
 * `SelectionListDynamicSectionCache` adapter (see
 * `selectionListDynamicSectionCache.ts`). Production callers continue to
 * share a module-level singleton (zero behavior change). Tests are
 * encouraged to pass an isolated instance via the hook's optional
 * `cache` prop using `createDefaultDynamicSectionCache()` so cache state
 * is fully sandboxed.
 *
 * Invariants:
 *  - Only successful resolves write to the cache. Aborted in-flight
 *    resolves (e.g. popover closed before response landed) MUST NOT
 *    poison the cache (the in-progress write is gated by mount + sequence
 *    + abort guards in the success handler below).
 *  - LRU eviction is implemented by the adapter (default cap 64); access
 *    promotes the entry to MRU.
 */

/**
 * Build a stable empty-state map keyed by section id with status='idle'.
 *
 * RUX-11.1: when a cross-mount cache entry exists for the section's
 * derived seed, seed `lastSuccessOptions` so the new mount shows the
 * cached rows immediately (no open-flicker).
 */
function makeInitialState(
    sections: ReadonlyArray<SelectionListDynamicSection>,
    inputBehavior: SelectionListInputBehavior | undefined,
    inputValue: string,
    cache: SelectionListDynamicSectionCache,
): ReadonlyMap<string, DynamicSectionState> {
    const next = new Map<string, DynamicSectionState>();
    for (const section of sections) {
        const seed = deriveSeed(section, inputBehavior, inputValue);
        const cacheKey = buildDynamicSectionCacheKey(section.id, section.resolverKey, seed);
        const cached = cache.get(cacheKey);
        if (cached !== undefined) {
            next.set(section.id, {
                status: 'idle',
                options: [],
                seed,
                lastSuccessOptions: cached,
            });
            continue;
        }
        next.set(section.id, { status: 'idle', options: [] });
    }
    return next;
}

function makeSkeletonOptions(count: number): ReadonlyArray<SelectionListOption> {
    if (count <= 0) return [];
    const skeleton: SelectionListOption[] = [];
    for (let i = 0; i < count; i += 1) {
        skeleton.push({
            id: `skeleton:${i}`,
            label: '',
            disabled: true,
        });
    }
    return skeleton;
}

function deriveSeed(
    section: SelectionListDynamicSection,
    inputBehavior: SelectionListInputBehavior | undefined,
    inputValue: string,
): string {
    if (section.seedFromInput) return section.seedFromInput(inputValue);
    if (inputBehavior?.getDynamicSectionSeed) return inputBehavior.getDynamicSectionSeed(inputValue);
    return inputValue;
}

/** A query that extends or truncates the one a section last settled on is that query being refined. */
function isQueryRefinement(settledSeed: string, seed: string): boolean {
    const settled = settledSeed.trim().toLocaleLowerCase();
    const next = seed.trim().toLocaleLowerCase();
    return settled.length > 0 && next.length > 0 && (next.startsWith(settled) || settled.startsWith(next));
}

/**
 * A high-frequency query section (`resultTransition: 'none'`) keeps presenting what it last settled while a
 * refinement of that query resolves: those rows or that status line stay valid choices, and replacing them
 * once the new result settles is a local update, not a blank group between two answers. Any other seed
 * (an unrelated query, a drill into another place) never shows the prior seed's state.
 */
function retainsSettledState(
    section: SelectionListDynamicSection,
    state: DynamicSectionState | undefined,
    seed: string,
): boolean {
    return section.resultTransition === 'none'
        && state?.status === 'success'
        && state.notFound !== true
        && state.seed !== undefined
        && isQueryRefinement(state.seed, seed);
}

/**
 * Orchestrates async resolvers for dynamic sections (Phase 2.2).
 *
 * Contract:
 *  - debounce on input change (per-section `debounceMs`, default 120ms)
 *  - one `AbortController` per section; aborted on input change OR unmount
 *  - per-section sequence number — late responses are dropped even when the
 *    underlying RPC does not honour `AbortSignal`. The sequence guard is the
 *    correctness guarantee; abort is best-effort.
 *  - `visibleWhen(input)` gates fetching entirely; gated sections stay 'idle'
 *  - skeleton rows produced via `loadingSkeletonRows` (default 3)
 *  - resolver throw / reject → status='error' with stale options preserved
 *  - on a successful response, status='success' with resolver's options + emptyHint
 *  - a `resultTransition: 'none'` section keeps its last settled state while a refinement of that
 *    query resolves (see `retainsSettledState`); every other seed change presents loading, never prior rows
 *
 * Returns a Map keyed by section id so consumers can look up state in O(1).
 */
export function useSelectionListDynamicSections(params: {
    dynamicSections: ReadonlyArray<SelectionListDynamicSection>;
    inputValue: string;
    inputBehavior?: SelectionListInputBehavior;
    /**
     * FR4-12 — optional explicit cache adapter. When omitted, the hook uses
     * the production singleton from `getDefaultDynamicSectionCache()` for
     * back-compat (the original module-level LRU behavior). Tests should pass
     * `createDefaultDynamicSectionCache()` to fully isolate cache state and
     * avoid touching the singleton. Identity-stable across re-renders is the
     * caller's responsibility — if `cache` swaps mid-lifetime it changes the
     * underlying storage.
     */
    cache?: SelectionListDynamicSectionCache;
}): ReadonlyMap<string, DynamicSectionState> {
    const { dynamicSections, inputValue, inputBehavior } = params;
    // Resolve the cache adapter once per render: an explicit injection wins;
    // otherwise fall back to the production singleton.
    const cache = params.cache ?? getDefaultDynamicSectionCache();
    const cacheRef = React.useRef(cache);
    cacheRef.current = cache;

    const [stateMap, setStateMap] = React.useState<ReadonlyMap<string, DynamicSectionState>>(
        () => makeInitialState(dynamicSections, inputBehavior, inputValue, cache),
    );

    // Per-section refs for debounce timer, abort controller, and latest sequence.
    const debounceTimers = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const abortControllers = React.useRef<Map<string, AbortController>>(new Map());
    const sequenceCounters = React.useRef<Map<string, number>>(new Map());
    const currentRequestIdentityByIdRef = React.useRef<Map<string, string>>(new Map());
    const isMountedRef = React.useRef(true);
    // R16a (was R9 blocker 2): track per-section identity inputs that, when
    // they change, MUST invalidate the cached state and trigger a fresh fetch:
    //   - the descriptor's explicit `resolverKey` (a same-id descriptor with a
    //     new resolverKey → the cached options are no longer valid; e.g.
    //     machine swap rebinds the underlying RPC behind the same section id)
    //   - the descriptor's visibility (hidden → visible transition must NOT
    //     replay the last-success cache; the section is treated as "needs
    //     refetch" so a stale late response can't surface)
    //
    // R9 originally tagged resolver closures via a long-lived WeakMap so EVERY
    // new closure flipped identity. That over-invalidated on plain parent
    // re-renders (any consumer that didn't memoize `onCommit`/recents/etc.
    // saw constant loading-skeleton flicker). R16a replaces the WeakMap with
    // an explicit `resolverKey` opt-in — the default identity is `descriptor.id`
    // alone, so plain re-renders never invalidate.
    const lastInputsByIdRef = React.useRef<Map<string, Readonly<{
        resolverKey: string;
        seed: string;
        visible: boolean;
        inputValue: string;
        inputBehavior: SelectionListInputBehavior | undefined;
    }>>>(new Map());

    // Reset state when the section set changes (new ids → new map). Sections
    // that survived re-mount under the same id are forwarded through; sections
    // that lost their entry get pruned.
    const sectionIdsKey = React.useMemo(
        () => dynamicSections.map((s) => s.id).join('|'),
        [dynamicSections],
    );

    React.useEffect(() => {
        const activeIds = new Set(dynamicSections.map((section) => section.id));
        for (const [id, timer] of debounceTimers.current) {
            if (activeIds.has(id)) continue;
            clearTimeout(timer);
            debounceTimers.current.delete(id);
            sequenceCounters.current.set(id, (sequenceCounters.current.get(id) ?? 0) + 1);
        }
        for (const [id, controller] of abortControllers.current) {
            if (activeIds.has(id)) continue;
            controller.abort();
            abortControllers.current.delete(id);
            sequenceCounters.current.set(id, (sequenceCounters.current.get(id) ?? 0) + 1);
        }
        for (const id of lastInputsByIdRef.current.keys()) {
            if (!activeIds.has(id)) lastInputsByIdRef.current.delete(id);
        }
        setStateMap((prev) => {
            const next = new Map<string, DynamicSectionState>();
            for (const section of dynamicSections) {
                const existing = prev.get(section.id);
                if (existing !== undefined) {
                    next.set(section.id, existing);
                    continue;
                }
                // RUX-11.1: a new id appeared (rare in practice — usually
                // the whole hook unmounts/remounts together with the
                // popover). Seed from cache when available so the new
                // section doesn't flicker through an empty state.
                const seed = deriveSeed(section, inputBehavior, inputValue);
                const cacheKey = buildDynamicSectionCacheKey(section.id, section.resolverKey, seed);
                const cached = cacheRef.current.get(cacheKey);
                if (cached !== undefined) {
                    next.set(section.id, {
                        status: 'idle',
                        options: [],
                        seed,
                        lastSuccessOptions: cached,
                    });
                    continue;
                }
                next.set(section.id, { status: 'idle', options: [] });
            }
            return next;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: keyed re-run
    }, [sectionIdsKey]);

    // R16a (was R9 blocker 2): build a key that changes whenever a section's
    // EXPLICIT `resolverKey` changes for any section. The dispatch effect
    // depends on this key so a same-id descriptor with a different
    // `resolverKey` re-triggers the fetch path with a cleared cache.
    //
    // Default identity = `descriptor.id` alone. We intentionally DO NOT key on
    // the resolver closure identity — in React it's normal for parent
    // re-renders to pass new closures to the same section id, and treating
    // every closure swap as a meaningful invalidation produced spurious
    // loading-skeleton flicker on every parent re-render of any consumer that
    // didn't memoize `onCommit`/inline closures. Callers that legitimately
    // need invalidation (e.g. machine swap rebinds the underlying RPC) MUST
    // bump `resolverKey` explicitly.
    const descriptorIdentityKey = React.useMemo(() => {
        const tokens: string[] = [];
        for (const section of dynamicSections) {
            tokens.push(`${section.id}::${section.resolverKey ?? section.id}`);
        }
        return tokens.join('|');
    }, [dynamicSections]);

    // R9 (blocker 2): compute visibility per section at render time so the
    // effect re-runs when visibility flips even if `inputValue` hasn't
    // changed. Production callers usually drive `visibleWhen` from the input
    // (so changes flow through `inputValue`), but the gate is allowed to
    // depend on external state (e.g. a parent re-render) — that case must
    // still trigger the hidden-vs-visible transition handling.
    const visibilityKey = React.useMemo(() => {
        const tokens: string[] = [];
        for (const section of dynamicSections) {
            const visible = !section.visibleWhen || section.visibleWhen(inputValue);
            tokens.push(`${section.id}:${visible ? '1' : '0'}`);
        }
        return tokens.join('|');
    }, [dynamicSections, inputValue]);

    // Publish the current request identity during render. Promise settlements
    // can run before React flushes the replacement effect, so an effect-only
    // sequence bump leaves a small window where an aborted request can publish
    // an error for the query already visible in the input. This ref is only a
    // latest-props fence: timers/controllers are still retired by the effect.
    const currentSectionIds = new Set<string>();
    for (const section of dynamicSections) {
        currentSectionIds.add(section.id);
        const seed = deriveSeed(section, inputBehavior, inputValue);
        const visible = !section.visibleWhen || section.visibleWhen(inputValue);
        currentRequestIdentityByIdRef.current.set(
            section.id,
            `${section.resolverKey ?? section.id}\u0000${visible ? '1' : '0'}\u0000${seed}`,
        );
    }
    for (const id of currentRequestIdentityByIdRef.current.keys()) {
        if (!currentSectionIds.has(id)) currentRequestIdentityByIdRef.current.delete(id);
    }

    React.useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            // Abort and clear all pending work on unmount.
            debounceTimers.current.forEach((timer) => clearTimeout(timer));
            debounceTimers.current.clear();
            abortControllers.current.forEach((ctrl) => ctrl.abort());
            abortControllers.current.clear();
            lastInputsByIdRef.current.clear();
        };
    }, []);

    // Dispatch / cancel work whenever the input or section set changes.
    React.useEffect(() => {
        for (const section of dynamicSections) {
            const { id } = section;
            const currentResolverKey = section.resolverKey ?? id;
            const seed = deriveSeed(section, inputBehavior, inputValue);
            const isVisible = !section.visibleWhen || section.visibleWhen(inputValue);
            const previousInputs = lastInputsByIdRef.current.get(id);
            // A sibling's identity/visibility change reruns this effect, but is not a
            // new request for this section. Keep its pending or settled work intact.
            if (previousInputs?.resolverKey === currentResolverKey
                && previousInputs.seed === seed && previousInputs.visible === isVisible
                && previousInputs.inputValue === inputValue && previousInputs.inputBehavior === inputBehavior) continue;
            lastInputsByIdRef.current.set(id, { resolverKey: currentResolverKey, seed, visible: isVisible, inputValue, inputBehavior });

            // R16a (was R9 blocker 2): if the section's EXPLICIT `resolverKey`
            // changed for this id, invalidate the cached lastSuccessOptions so
            // the new resolver's first response is the only thing that can
            // render. Bumping the sequence counter here also drops any
            // in-flight response from the OLD resolver via the existing
            // sequence guard.
            //
            // Default key = `id` (so plain re-renders never invalidate). Only
            // descriptors that opt into `resolverKey` get the invalidation
            // behavior — see `_types.ts` for the contract.
            const previousResolverKey = previousInputs?.resolverKey;
            const resolverChanged = previousResolverKey !== undefined
                && previousResolverKey !== currentResolverKey;
            if (resolverChanged) {
                sequenceCounters.current.set(id, (sequenceCounters.current.get(id) ?? 0) + 1);
                setStateMap((prev) => {
                    const next = new Map(prev);
                    next.set(id, { status: 'idle', options: [] });
                    return next;
                });
            }

            // Clear any pending debounce timer for this section.
            const existingTimer = debounceTimers.current.get(id);
            if (existingTimer !== undefined) {
                clearTimeout(existingTimer);
                debounceTimers.current.delete(id);
            }
            // Abort the previous in-flight request (if any) for this section.
            const existingController = abortControllers.current.get(id);
            if (existingController) {
                existingController.abort();
                abortControllers.current.delete(id);
            }

            // `visibleWhen` gate: hidden sections stay idle (no fetch, options cleared).
            const wasVisible = previousInputs?.visible;
            if (!isVisible) {
                // Bump the sequence so any in-flight response from the
                // visible-side fetch is dropped on arrival; clear cached
                // options so a later visible-toggle can't surface them.
                sequenceCounters.current.set(id, (sequenceCounters.current.get(id) ?? 0) + 1);
                setStateMap((prev) => {
                    const next = new Map(prev);
                    const current = next.get(id);
                    if (current && current.status === 'idle' && current.options.length === 0
                        && current.lastSuccessOptions === undefined) {
                        return prev;
                    }
                    next.set(id, { status: 'idle', options: [] });
                    return next;
                });
                continue;
            }
            // R9 (blocker 2): hidden→visible transition must NOT replay a
            // stale late response. Clear the cache so the upcoming dispatch
            // starts fresh (status='loading' with no stale rows to flash).
            if (wasVisible === false) {
                sequenceCounters.current.set(id, (sequenceCounters.current.get(id) ?? 0) + 1);
                setStateMap((prev) => {
                    const next = new Map(prev);
                    next.set(id, { status: 'idle', options: [] });
                    return next;
                });
            }

            const debounceMs = section.debounceMs ?? SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS;
            // A section that names its first load (`loadingHint`) shows that line, never placeholder rows.
            const skeletonCount = section.loadingHint
                ? 0
                : section.loadingSkeletonRows ?? SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS;

            const dispatch = () => {
                debounceTimers.current.delete(id);
                if (!isMountedRef.current) return;
                const requestIdentity = currentRequestIdentityByIdRef.current.get(id);
                if (requestIdentity === undefined) return;

                const controller = new AbortController();
                abortControllers.current.set(id, controller);
                const sequence = (sequenceCounters.current.get(id) ?? 0) + 1;
                sequenceCounters.current.set(id, sequence);

                // Enter loading state with skeleton rows. Preserve last-success
                // options so the error path can show stale-cache rows.
                setStateMap((prev) => {
                    const previous = prev.get(id);
                    if (retainsSettledState(section, previous, seed)) return prev;
                    const next = new Map(prev);
                    const sameSeed = previous?.seed === seed;
                    const lastSuccess = !sameSeed ? undefined :
                        previous?.status === 'success'
                            ? previous.options
                            : previous?.lastSuccessOptions;
                    next.set(id, {
                        status: 'loading',
                        options: makeSkeletonOptions(skeletonCount),
                        seed,
                        lastSuccessOptions: lastSuccess,
                        resultHint: sameSeed ? previous?.resultHint : undefined,
                    });
                    return next;
                });

                let settled = false;
                const publishResult = (result: SelectionListDynamicSectionResolveResult, complete: boolean) => {
                    // RUX-11.1: hard-abort first — `isMountedRef.current ===
                    // false` means the hook has unmounted (popover closed),
                    // and writing to the module-level cache after unmount
                    // could "poison" it with a response the user no longer
                    // sees as authoritative. The mount + sequence guards
                    // together preserve the abort-safe contract.
                    if (!isMountedRef.current) return;
                    if (sequenceCounters.current.get(id) !== sequence) return;
                    if (currentRequestIdentityByIdRef.current.get(id) !== requestIdentity) return;
                    if (controller.signal.aborted) return;
                    // Write the cross-mount cache only on a true success
                    // (not on notFound, which intentionally preserves the
                    // prior cached options for typo recovery).
                    if (complete && result.notFound !== true) {
                        const cacheKey = buildDynamicSectionCacheKey(id, section.resolverKey, seed);
                        cacheRef.current.set(cacheKey, result.options);
                    }
                    setStateMap((prev) => {
                        const next = new Map(prev);
                        const previous = prev.get(id);
                        // RUX-1 Issue 6: when the resolver reports notFound,
                        // do NOT overwrite lastSuccessOptions so a prior
                        // successful listing is preserved (the user can fix
                        // the typo and the stale list shows under the hint).
                        const lastSuccessOptions = result.notFound === true
                            ? previous?.lastSuccessOptions
                            : result.options;
                        next.set(id, {
                            status: complete ? 'success' : 'loading',
                            options: result.options,
                            emptyHint: result.emptyHint,
                            resultHint: result.resultHint,
                            seed,
                            lastSuccessOptions,
                            notFound: result.notFound === true ? true : undefined,
                            notFoundHint: result.notFoundHint,
                        });
                        return next;
                    });
                };

                const handleError = (err: unknown) => {
                    settled = true;
                    if (!isMountedRef.current) return;
                    if (sequenceCounters.current.get(id) !== sequence) return;
                    if (currentRequestIdentityByIdRef.current.get(id) !== requestIdentity) return;
                    if (controller.signal.aborted) return;
                    const error = err instanceof Error ? err : new Error(String(err));
                    setStateMap((prev) => {
                        const next = new Map(prev);
                        const previous = prev.get(id);
                        // Preserve this seed's previously-loaded options so a transient failure
                        // doesn't blank the section (stale-cache behavior). A retained refinement
                        // state belongs to the prior seed and is not carried under the failure.
                        const sameSeed = previous?.seed === seed;
                        const stale = !sameSeed ? [] :
                            previous?.lastSuccessOptions ??
                            (previous?.status === 'success' ? previous.options : []);
                        next.set(id, {
                            status: 'error',
                            options: stale,
                            error,
                            emptyHint: sameSeed ? previous?.emptyHint : undefined,
                            resultHint: sameSeed ? previous?.resultHint : undefined,
                            seed,
                            lastSuccessOptions: stale,
                            retry: dispatch,
                        });
                        return next;
                    });
                };

                try {
                    section.resolve(seed, controller.signal, result => {
                        if (!settled) publishResult(result, false);
                    }).then(result => { settled = true; publishResult(result, true); }, handleError);
                } catch (err) {
                    handleError(err);
                }
            };

            if (debounceMs <= 0) {
                dispatch();
            } else {
                const timer = setTimeout(dispatch, debounceMs);
                debounceTimers.current.set(id, timer);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute when inputs change
    }, [inputValue, sectionIdsKey, inputBehavior, descriptorIdentityKey, visibilityKey]);

    // Input paints before the dispatch effect (and before its debounce). Never
    // expose selectable rows from a different seed or resolver during that interval,
    // except what a high-frequency query section keeps while its query is refined.
    let visibleState: Map<string, DynamicSectionState> | null = null;
    for (const section of dynamicSections) {
        const state = stateMap.get(section.id);
        if (!state || state.seed === undefined) continue;
        const seed = deriveSeed(section, inputBehavior, inputValue);
        const dispatchedResolverKey = lastInputsByIdRef.current.get(section.id)?.resolverKey;
        const resolverMoved = dispatchedResolverKey !== undefined
            && dispatchedResolverKey !== (section.resolverKey ?? section.id);
        if (!resolverMoved && (state.seed === seed || retainsSettledState(section, state, seed))) continue;
        visibleState ??= new Map(stateMap);
        visibleState.set(section.id, {
            status: 'loading', options: [], seed,
        });
    }
    return visibleState ?? stateMap;
}

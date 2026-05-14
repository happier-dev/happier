import { describe, expect, it } from 'vitest';

import type { DynamicSectionState } from '../useSelectionListDynamicSections';

/**
 * R14 — unit coverage for the render-plan synthesizer extracted from the
 * orchestrator. The plan synthesizer is a pure function: given the current
 * step's section descriptors, the dynamic-section state map, the raw input
 * value, and the (already adapted) filter query, it produces an ordered
 * `SectionRenderPlan[]`. Loading/error/success/empty branches all flow through
 * the same shape so the body renderer can switch on `dynamicState` without
 * branching on descriptor kind.
 *
 * These tests pin the contract independent of the React orchestrator.
 */
describe('SelectionListRenderPlan (R14 extracted)', () => {
    it('filters static sections by the current query and preserves order', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'static',
                    id: 'favorites',
                    title: 'FAVORITES',
                    options: [
                        { id: 'fav-a', label: 'Apples' },
                        { id: 'fav-b', label: 'Bananas' },
                    ],
                },
                {
                    kind: 'static',
                    id: 'recent',
                    title: 'RECENT',
                    options: [
                        { id: 'rec-a', label: 'Apricots' },
                    ],
                },
            ],
            inputValue: 'ap',
            filterQuery: 'ap',
            dynamicSectionStates: new Map(),
        });
        expect(plan).toHaveLength(2);
        expect(plan[0].id).toBe('favorites');
        expect(plan[0].options.map((o) => o.id)).toEqual(['fav-a']);
        expect(plan[1].id).toBe('recent');
        expect(plan[1].options.map((o) => o.id)).toEqual(['rec-a']);
    });

    it('drops static sections whose filter narrows to zero rows', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'static',
                    id: 'recent',
                    title: 'RECENT',
                    options: [{ id: 'r-a', label: 'Apples' }],
                },
            ],
            inputValue: 'zzzz',
            filterQuery: 'zzzz',
            dynamicSectionStates: new Map(),
        });
        expect(plan).toHaveLength(0);
    });

    it('skips dynamic sections whose visibleWhen predicate returns false', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'success',
            options: [{ id: 'x', label: 'X' }],
            emptyHint: undefined,
            lastSuccessOptions: undefined,
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    title: 'DYN',
                    resolve: async () => ({ options: [] }),
                    visibleWhen: () => false,
                },
            ],
            inputValue: 'anything',
            filterQuery: 'anything',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(0);
    });

    it('emits a loading entry for a dynamic section in loading state with stale options preserved (RUX-1 Issue 2 suppresses skeletons when stale data exists)', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'loading',
            options: [],
            lastSuccessOptions: [{ id: 'stale', label: 'Stale' }],
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    title: 'DYN',
                    resolve: async () => ({ options: [] }),
                    loadingSkeletonRows: 5,
                },
            ],
            inputValue: '',
            filterQuery: '',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].dynamicState).toBe('loading');
        expect(plan[0].isStale).toBe(true);
        // Stale-while-revalidate: skeletons suppressed; only stale rows render.
        expect(plan[0].skeletonRowCount).toBe(0);
        expect(plan[0].options.map((o) => o.id)).toEqual(['stale']);
    });

    it('emits an error entry with the resolver message when present', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'error',
            options: [{ id: 'last', label: 'Last' }],
            emptyHint: undefined,
            error: new Error('Network down'),
            lastSuccessOptions: undefined,
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    title: 'DYN',
                    resolve: async () => ({ options: [] }),
                },
            ],
            inputValue: '',
            filterQuery: '',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].dynamicState).toBe('error');
        expect(plan[0].hint).toBe('Network down');
        expect(plan[0].isStale).toBe(true);
    });

    it('emits an empty entry for a successful dynamic section that filtered to zero rows when an emptyHint is set', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'success',
            options: [{ id: 'zebra', label: 'Zebra' }],
            emptyHint: 'No matches',
            lastSuccessOptions: undefined,
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    title: 'DYN',
                    resolve: async () => ({ options: [] }),
                },
            ],
            inputValue: 'aa',
            filterQuery: 'aa',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].dynamicState).toBe('empty');
        expect(plan[0].hint).toBe('No matches');
    });

    it('collapses a successful dynamic section that filtered to zero rows when no emptyHint is set', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'success',
            options: [{ id: 'zebra', label: 'Zebra' }],
            emptyHint: undefined,
            lastSuccessOptions: undefined,
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    title: 'DYN',
                    resolve: async () => ({ options: [] }),
                },
            ],
            inputValue: 'aa',
            filterQuery: 'aa',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(0);
    });

    it('exposes filterDynamicOptionsByQuery as a referentially-stable identity for empty queries', async () => {
        const { filterDynamicOptionsByQuery } = await import('../SelectionListRenderPlan');
        const options = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
        const filtered = filterDynamicOptionsByQuery(options, '');
        expect(filtered).toBe(options);
    });

    it('filterDynamicOptionsByQuery matches label and subtitle case-insensitively', async () => {
        const { filterDynamicOptionsByQuery } = await import('../SelectionListRenderPlan');
        const options = [
            { id: 'a', label: 'Apples' },
            { id: 'b', label: 'Bananas', subtitle: 'with apples' },
            { id: 'c', label: 'Cherries' },
        ];
        const filtered = filterDynamicOptionsByQuery(options, 'app');
        expect(filtered.map((o) => o.id)).toEqual(['a', 'b']);
    });

    /**
     * RUX-1 Issue 1: ranked matching. The user typed "de" and expected
     * "dev" first; instead alphabetical order surfaced ".codex-pr-fixups"
     * because both contained "de" as substring and "." sorts before "d".
     * The expected behavior:
     *   tier 1 → label starts with query (alphabetical within tier)
     *   tier 2 → label contains query (alphabetical within tier)
     *   tier 3 → subtitle contains query (alphabetical within tier)
     */
    it('rankOptionsByQuery surfaces label-prefix matches before substring matches', async () => {
        const { rankOptionsByQuery } = await import('../SelectionListRenderPlan');
        const options = [
            { id: '1', label: '.codex' },
            { id: '2', label: 'dev' },
            { id: '3', label: 'dev-bkp' },
            { id: '4', label: 'happier' },
        ];
        const ranked = rankOptionsByQuery(options, 'de');
        expect(ranked.map((o) => o.label)).toEqual(['dev', 'dev-bkp', '.codex']);
    });

    it('rankOptionsByQuery places subtitle-only matches last', async () => {
        const { rankOptionsByQuery } = await import('../SelectionListRenderPlan');
        const options = [
            { id: '1', label: 'Bananas', subtitle: 'with apples' },
            { id: '2', label: 'Cranberry' },
            { id: '3', label: 'Apples' },
            { id: '4', label: 'Pineapple' },
        ];
        const ranked = rankOptionsByQuery(options, 'app');
        // Tier 1: Apples (starts-with)
        // Tier 2: Pineapple (contains)
        // Tier 3: Bananas (subtitle contains)
        // Cranberry has no match → dropped
        expect(ranked.map((o) => o.label)).toEqual(['Apples', 'Pineapple', 'Bananas']);
    });

    it('rankOptionsByQuery returns the original array reference unchanged for empty queries', async () => {
        const { rankOptionsByQuery } = await import('../SelectionListRenderPlan');
        const options = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
        expect(rankOptionsByQuery(options, '')).toBe(options);
    });

    /**
     * RUX-1 Issue 2: stale-while-revalidate. While a dynamic section is
     * refetching with prior options cached, the loading entry MUST keep the
     * stale options as the FULL options array rendered (no skeletons), so
     * users never see a flicker between the previous data and the new data.
     * Skeletons only appear on first load.
     */
    it('loading entry sets skeletonRowCount to 0 when stale options are present (no flicker)', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'loading',
            options: [],
            lastSuccessOptions: [{ id: 'prior', label: 'Prior' }],
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    resolve: async () => ({ options: [] }),
                    loadingSkeletonRows: 5,
                },
            ],
            inputValue: '',
            filterQuery: '',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].dynamicState).toBe('loading');
        expect(plan[0].isStale).toBe(true);
        // RUX-1 Issue 2 invariant: skeleton row count is suppressed (0)
        // when stale options are available so the body renders only the
        // stale rows. Skeletons surface only when there is no prior data.
        expect(plan[0].skeletonRowCount).toBe(0);
        expect(plan[0].options.map((o) => o.id)).toEqual(['prior']);
    });

    it('loading entry preserves skeletonRowCount when no stale options are available AND showSkeletonsOnFirstLoad is true (opt-in first load)', async () => {
        // RUX-11.2: the default first-load behavior hides the section
        // entirely; descriptors must opt in via `showSkeletonsOnFirstLoad`
        // to surface skeletons during the very first fetch. This test pins
        // the opt-in path so consumers like worktree pickers (which want
        // visual placeholder rows on initial open) keep working.
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'loading',
            options: [],
            lastSuccessOptions: undefined,
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    resolve: async () => ({ options: [] }),
                    loadingSkeletonRows: 4,
                    showSkeletonsOnFirstLoad: true,
                },
            ],
            inputValue: '',
            filterQuery: '',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].dynamicState).toBe('loading');
        expect(plan[0].isStale).toBe(false);
        expect(plan[0].skeletonRowCount).toBe(4);
    });

    /**
     * RUX-1 Issue 6: notFound state. When the resolver successfully runs but
     * the target doesn't exist (e.g. ENOENT on a typo'd path), the dynamic
     * section reports `notFound: true` instead of throwing. The render plan
     * surfaces this as `dynamicState: 'notFound'` with a hint, and OTHER
     * static sections in the same step are passed through UNFILTERED so
     * favorites/recents remain visible (they'd otherwise be filtered to
     * empty by the path the user typed).
     */
    it('emits a notFound entry when the dynamic section resolved with notFound', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'success',
            options: [],
            notFound: true,
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    title: 'DYN',
                    resolve: async () => ({ options: [] }),
                },
            ],
            inputValue: '~/typo',
            filterQuery: '~/typo',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].dynamicState).toBe('notFound');
    });

    it('when a dynamic section is notFound, static sections in the same step bypass filtering (favorites/recents stay visible)', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'success',
            options: [],
            notFound: true,
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    title: 'DYN',
                    resolve: async () => ({ options: [] }),
                },
                {
                    kind: 'static',
                    id: 'favorites',
                    title: 'FAVORITES',
                    options: [
                        { id: 'fav-a', label: '~/Projects' },
                        { id: 'fav-b', label: '~/Work' },
                    ],
                },
            ],
            inputValue: '~/typo',
            filterQuery: '~/typo',
            dynamicSectionStates: states,
        });
        // Static section is unfiltered (would otherwise be 0 since neither
        // label contains "~/typo").
        const favoritesPlan = plan.find((p) => p.id === 'favorites');
        expect(favoritesPlan).toBeDefined();
        expect(favoritesPlan!.options.map((o) => o.id)).toEqual(['fav-a', 'fav-b']);
    });

    /**
     * RUX-1 Issue 8: dynamic-section content swap animation. Drilling into a
     * folder via the chevron updates the resolver seed; the body uses this
     * key to wrap the rendered rows in a `SlideTransitionSwitch` so the
     * change cross-slides instead of snapping (matching the worktree
     * picker's branch drill animation).
     */
    it('emits transitionKey on success entries equal to the resolver seed', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'success',
            options: [{ id: 'a', label: 'work' }],
            seed: '~/Documents/',
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    resolve: async () => ({ options: [] }),
                },
            ],
            // Empty query so no filter rejects the row.
            inputValue: '',
            filterQuery: '',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].transitionKey).toBe('~/Documents/');
    });

    it('synthesizeSelectionListRenderPlan ranks static-section options by prefix-match tier', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'static',
                    id: 's',
                    options: [
                        { id: '1', label: '.codex' },
                        { id: '2', label: 'dev' },
                        { id: '3', label: 'dev-bkp' },
                        { id: '4', label: 'happier' },
                    ],
                },
            ],
            inputValue: 'de',
            filterQuery: 'de',
            dynamicSectionStates: new Map(),
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].options.map((o) => o.label)).toEqual(['dev', 'dev-bkp', '.codex']);
    });

    /**
     * RUX-9.1: static sections with zero options must be dropped from the
     * plan entirely. The user complaint: an empty "Favorites" section header
     * rendered even when zero favorites were configured. The fix is to skip
     * the descriptor at synthesis time so neither the header nor the empty
     * body slot reach the body renderer.
     */
    it('RUX-9.1: drops static sections with zero options entirely (no empty header rendered)', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'static',
                    id: 'favorites',
                    title: 'FAVORITES',
                    options: [],
                },
                {
                    kind: 'static',
                    id: 'recent',
                    title: 'RECENT',
                    options: [{ id: 'r-1', label: 'Apples' }],
                },
            ],
            inputValue: '',
            filterQuery: '',
            dynamicSectionStates: new Map(),
        });
        // Favorites is dropped (empty); only Recent survives.
        expect(plan.map((p) => p.id)).toEqual(['recent']);
    });

    it('RUX-9.1: drops static sections with zero options even when query is empty (no filter applied)', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'static',
                    id: 'favorites',
                    title: 'FAVORITES',
                    options: [],
                },
            ],
            inputValue: '',
            filterQuery: '',
            dynamicSectionStates: new Map(),
        });
        expect(plan).toHaveLength(0);
    });

    /**
     * RUX-9.2: subtitle-tier ranking opt-out. The path domain's option
     * subtitles are the full absolute path (e.g. `/Users/leeroy/Documents/...`).
     * Tier-3 (subtitle.includes) creates false positives because typing "de"
     * inside `~/Documents/` matches EVERY child via subtitle. Callers must
     * be able to opt out of the subtitle tier.
     */
    it('RUX-9.2: rankOptionsByQuery skips the subtitle tier when disableSubtitleTier is true', async () => {
        const { rankOptionsByQuery } = await import('../SelectionListRenderPlan');
        const options = [
            { id: '1', label: 'Apples' },
            { id: '2', label: 'Bananas', subtitle: '/Users/leeroy/with apples' },
            { id: '3', label: 'Pineapple' },
        ];
        // With the subtitle tier ENABLED, "Bananas" would appear because of
        // its subtitle. With disableSubtitleTier=true, it is dropped.
        const ranked = rankOptionsByQuery(options, 'app', true);
        expect(ranked.map((o) => o.id)).toEqual(['1', '3']);
    });

    it('RUX-9.2: rankOptionsByQuery keeps subtitle matches by default (back-compat)', async () => {
        const { rankOptionsByQuery } = await import('../SelectionListRenderPlan');
        const options = [
            { id: '1', label: 'Apples' },
            { id: '2', label: 'Bananas', subtitle: '/Users/leeroy/with apples' },
            { id: '3', label: 'Pineapple' },
        ];
        const ranked = rankOptionsByQuery(options, 'app');
        expect(ranked.map((o) => o.id)).toEqual(['1', '3', '2']);
    });

    it('RUX-9.2: synthesizeSelectionListRenderPlan honors disableSubtitleRanking on static section (no subtitle-tier matches)', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'static',
                    id: 's',
                    options: [
                        { id: '1', label: 'foo', subtitle: '/Users/leeroy/Documents/' },
                        { id: '2', label: 'Documents', subtitle: '/Users/leeroy/' },
                    ],
                    disableSubtitleRanking: true,
                },
            ],
            inputValue: 'docu',
            filterQuery: 'docu',
            dynamicSectionStates: new Map(),
        });
        expect(plan).toHaveLength(1);
        // "foo" subtitle contains "docu" but subtitle ranking is disabled,
        // so only "Documents" (label prefix match) survives.
        expect(plan[0].options.map((o) => o.id)).toEqual(['2']);
    });

    it('RUX-9.2: synthesizeSelectionListRenderPlan honors disableSubtitleRanking on dynamic section (no subtitle-tier matches)', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'success',
            options: [
                { id: '1', label: 'foo', subtitle: '/Users/leeroy/Documents/de' },
                { id: '2', label: 'desktop', subtitle: '/Users/leeroy/' },
            ],
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    resolve: async () => ({ options: [] }),
                    disableSubtitleRanking: true,
                },
            ],
            inputValue: 'de',
            filterQuery: 'de',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].options.map((o) => o.id)).toEqual(['2']);
    });

    /**
     * RUX-11.2: when a dynamic section is in loading state on first fetch
     * (no lastSuccessOptions), drop the section entirely from the plan so
     * the user doesn't see a header + empty body. The user can see Favorites
     * and Recent fill the popover until first results arrive.
     *
     * Opt-in: descriptors that DO want eager skeletons set
     * `showSkeletonsOnFirstLoad: true`. Path picker keeps the default (false).
     */
    it('RUX-11.2: drops a first-load loading dynamic section by default (no header flash)', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'loading',
            options: [],
            lastSuccessOptions: undefined,
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    title: 'IN THIS FOLDER',
                    resolve: async () => ({ options: [] }),
                    loadingSkeletonRows: 5,
                },
            ],
            inputValue: '',
            filterQuery: '',
            dynamicSectionStates: states,
        });
        // By default, dynamic-section first-load is hidden entirely.
        expect(plan).toHaveLength(0);
    });

    it('RUX-11.2: emits skeletons on first load when showSkeletonsOnFirstLoad is true (opt-in)', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'loading',
            options: [],
            lastSuccessOptions: undefined,
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    title: 'IN THIS FOLDER',
                    resolve: async () => ({ options: [] }),
                    loadingSkeletonRows: 5,
                    showSkeletonsOnFirstLoad: true,
                },
            ],
            inputValue: '',
            filterQuery: '',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].dynamicState).toBe('loading');
        expect(plan[0].skeletonRowCount).toBe(5);
    });

    /**
     * RUX-11.1 followup: when the cross-mount cache seeds `lastSuccessOptions`
     * on a freshly-mounted hook, the brief `idle` render that happens before
     * the dispatch effect runs must surface the cached options as stale so
     * the user sees the cached rows immediately (no one-frame empty flash).
     */
    it('RUX-11.1: surfaces cached options as stale loading entry when initial state is idle with lastSuccessOptions (no-flicker open)', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'idle',
            options: [],
            lastSuccessOptions: [{ id: 'cached', label: 'Cached' }],
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    title: 'IN THIS FOLDER',
                    resolve: async () => ({ options: [] }),
                },
            ],
            inputValue: '',
            filterQuery: '',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].dynamicState).toBe('loading');
        expect(plan[0].isStale).toBe(true);
        expect(plan[0].options.map((o) => o.id)).toEqual(['cached']);
        expect(plan[0].skeletonRowCount).toBe(0);
    });

    it('RUX-11.1: idle state without lastSuccessOptions still drops the section (back-compat)', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'idle',
            options: [],
            lastSuccessOptions: undefined,
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    resolve: async () => ({ options: [] }),
                },
            ],
            inputValue: '',
            filterQuery: '',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(0);
    });

    it('RUX-11.2: keeps loading section with stale options regardless of showSkeletonsOnFirstLoad', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'loading',
            options: [],
            lastSuccessOptions: [{ id: 'stale', label: 'Stale' }],
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [
                {
                    kind: 'dynamic',
                    id: 'dyn',
                    title: 'IN THIS FOLDER',
                    resolve: async () => ({ options: [] }),
                    loadingSkeletonRows: 5,
                    // showSkeletonsOnFirstLoad omitted (default false) — but stale
                    // options exist so the section still renders.
                },
            ],
            inputValue: '',
            filterQuery: '',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].dynamicState).toBe('loading');
        expect(plan[0].isStale).toBe(true);
        expect(plan[0].options.map((o) => o.id)).toEqual(['stale']);
    });
});

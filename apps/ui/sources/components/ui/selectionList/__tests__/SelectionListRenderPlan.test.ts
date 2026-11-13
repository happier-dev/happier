import { describe, expect, it } from 'vitest';

import type { DynamicSectionState } from '../useSelectionListDynamicSections';
import type { SelectionListOption } from '../_types';

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
    it('keeps query-projected folded matches beside cold and settled asynchronous sections', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const selected = { id: 'chosen', label: 'Shared model' } satisfies SelectionListOption;
        const closed = [{ id: 'disclosure', label: 'Unavailable (1)' }];
        const sections = [
            { kind: 'static' as const, id: 'own', options: [{ id: 'own', label: 'Shared local' }] },
            { kind: 'static' as const, id: 'fold', options: closed, filterOptions: () => [closed[0]!, selected] },
            { kind: 'dynamic' as const, id: 'remote', showSkeletonsOnFirstLoad: true, resolve: async () => ({ options: [selected] }) },
        ];
        const args = { sections, inputValue: 'shared', filterQuery: 'shared' };
        const cold = synthesizeSelectionListRenderPlan({ ...args, dynamicSectionStates: new Map([
            ['remote', { status: 'idle' as const, options: [], lastSuccessOptions: undefined }],
        ]) });
        expect(cold.map(section => section.id)).toEqual(['own', 'fold', 'remote']);
        expect(cold[1]?.options).toEqual([closed[0], selected]);
        expect(cold[2]).toMatchObject({ dynamicState: 'loading', options: [] });
        const settled = synthesizeSelectionListRenderPlan({ ...args, dynamicSectionStates: new Map([
            ['remote', { status: 'success' as const, options: [selected], lastSuccessOptions: undefined }],
        ]) });
        expect(settled[2]?.options[0]).toBe(selected);
        expect(settled[2]?.dynamicState).toBeUndefined();
        const cleared = synthesizeSelectionListRenderPlan({ ...args, inputValue: '', filterQuery: '', dynamicSectionStates: new Map() });
        expect(cleared[1]?.options).toEqual(closed);
    });
    it.each(['idle', 'loading', 'error', 'success'] as const)(
        'activates current descriptor bindings for retained options in the %s state',
        async (status) => {
            const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
            const { activateSelectionListRow } = await import('../SelectionListRowActivation');
            const selections: string[] = [];
            const retainedOptions = [{
                id: 'directory', label: 'Documents', onSelect: () => { selections.push('retired'); },
            }] satisfies readonly SelectionListOption[];
            const currentOptions: readonly SelectionListOption[] = [{
                ...retainedOptions[0], id: 'directory', label: 'Documents',
                onSelect: () => { selections.push('current'); },
            }];
            const section = {
                kind: 'dynamic' as const, id: 'directories',
                resolve: async () => ({ options: retainedOptions }),
                projectOptions: (_options: readonly SelectionListOption[]) => currentOptions,
            };
            const state: DynamicSectionState = {
                status,
                options: status === 'idle' || status === 'loading' ? [] : retainedOptions,
                lastSuccessOptions: retainedOptions,
                ...(status === 'error' ? { error: new Error('offline') } : {}),
            };
            const plan = synthesizeSelectionListRenderPlan({
                sections: [section], inputValue: '', filterQuery: '',
                dynamicSectionStates: new Map([['directories', state]]),
            });
            const option = plan[0]?.options[0];
            if (!option) throw new Error('Expected the retained directory to remain available');
            activateSelectionListRow({ option, onSelect: () => {}, onPushStep: () => {} });

            expect(selections).toEqual(['current']);
            expect(plan[0]?.options).toBe(currentOptions);
            expect(retainedOptions[0]?.onSelect).not.toBe(option.onSelect);
        },
    );

    it('ranks opted-in search results across groups without promoting stale rows or dropping their status', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const args = {
            sections: [
                { kind: 'static' as const, id: 'kinds', title: 'Kinds', options: [{ id: 'action', label: 'Action', subtitle: 'Notify someone' }] },
                { kind: 'dynamic' as const, id: 'actions', resolve: async () => ({ options: [] }) },
                { kind: 'dynamic' as const, id: 'remote', resolve: async () => ({ options: [] }) },
            ],
            inputValue: 'Notify', filterQuery: 'Notify',
            dynamicSectionStates: new Map<string, DynamicSectionState>([
                ['actions', { status: 'success', options: [{ id: 'notify', label: 'Notify me' }], lastSuccessOptions: undefined }],
                ['remote', { status: 'error', options: [{ id: 'stale', label: 'Notify remotely' }], error: new Error('offline'), lastSuccessOptions: [{ id: 'stale', label: 'Notify remotely' }] }],
            ]),
        };
        const grouped = synthesizeSelectionListRenderPlan(args);
        expect(grouped[0]?.options[0]?.id).toBe('action');
        const searched = synthesizeSelectionListRenderPlan({ ...args, searchAcrossSections: true });
        expect(searched[0]?.options.map(option => option.id)).toEqual(['notify', 'action']);
        expect(searched[0]?.title).toBeUndefined();
        expect(searched[1]).toMatchObject({ id: 'remote', dynamicState: 'error', isStale: true, options: [{ id: 'stale' }] });
        expect(synthesizeSelectionListRenderPlan({ ...args, inputValue: '', filterQuery: '', searchAcrossSections: true })[0]?.title).toBe('Kinds');
    });
    it('retains a static section status hint even when matching produced no rows', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const plan = synthesizeSelectionListRenderPlan({
            sections: [{
                kind: 'static',
                id: 'sessions',
                title: 'Sessions',
                options: [],
                resultHint: 'Some Sessions could not be loaded.',
            }],
            inputValue: 'query',
            filterQuery: 'query',
            dynamicSectionStates: new Map(),
        });

        expect(plan).toEqual([expect.objectContaining({
            id: 'sessions',
            options: [],
            resultHint: 'Some Sessions could not be loaded.',
        })]);
    });

    it('renders an opted-in first-load skeleton during the initial idle state instead of the global empty state', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('remote', {
            status: 'idle',
            options: [],
            lastSuccessOptions: undefined,
        });

        const plan = synthesizeSelectionListRenderPlan({
            sections: [{
                kind: 'dynamic',
                id: 'remote',
                showSkeletonsOnFirstLoad: true,
                loadingSkeletonRows: 2,
                resolve: async () => ({ options: [] }),
            }],
            inputValue: 'query',
            filterQuery: 'query',
            dynamicSectionStates: states,
        });

        expect(plan).toEqual([expect.objectContaining({
            id: 'remote',
            dynamicState: 'loading',
            skeletonRowCount: 2,
        })]);
    });

    it('names a failed group with the host copy its owner declared, never the resolver message', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>([['remote', {
            status: 'error', options: [], error: new Error('plugin internal: 500 at /api'), lastSuccessOptions: undefined,
        }]]);
        const plan = synthesizeSelectionListRenderPlan({
            sections: [{ kind: 'dynamic', id: 'remote', errorHint: 'Couldn\'t search PRs & Issues', resolve: async () => ({ options: [] }) }],
            inputValue: 'query', filterQuery: 'query', dynamicSectionStates: states,
        });
        expect(plan[0]).toEqual(expect.objectContaining({ dynamicState: 'error', hint: 'Couldn\'t search PRs & Issues' }));
    });

    it('lets high-frequency query sections opt out of seed-driven drill transitions', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('remote', {
            status: 'success',
            seed: 'second query',
            options: [{ id: 'result', label: 'Result' }],
            lastSuccessOptions: undefined,
        });

        const plan = synthesizeSelectionListRenderPlan({
            sections: [{
                kind: 'dynamic',
                id: 'remote',
                resultFiltering: 'provider',
                resultTransition: 'none',
                resolve: async () => ({ options: [] }),
            }],
            inputValue: 'second query',
            filterQuery: 'second query',
            dynamicSectionStates: states,
        });

        expect(plan[0]?.transitionKey).toBeUndefined();
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

    it('emits an error entry without forwarding the resolver message', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'error',
            options: [{ id: 'last', label: 'Last' }],
            emptyHint: undefined,
            error: new Error('token abc123 failed at /private/internal/path'),
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
        expect(plan[0].hint).toBeUndefined();
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

    it('retains a success-only result hint beside nonempty provider-filtered options', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'success',
            options: [{ id: 'semantic', label: 'Provider result' }],
            resultHint: 'More results are available',
            lastSuccessOptions: undefined,
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [{
                kind: 'dynamic',
                id: 'dyn',
                resolve: async () => ({ options: [] }),
                resultFiltering: 'provider',
            }],
            inputValue: 'query',
            filterQuery: 'query',
            dynamicSectionStates: states,
        });

        expect(plan).toHaveLength(1);
        expect(plan[0].options.map((option) => option.id)).toEqual(['semantic']);
        expect(plan[0].resultHint).toBe('More results are available');
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

    it('rankOptionsByQuery keeps hidden canonical metadata after title and subtitle bands', async () => {
        const { rankOptionsByQuery } = await import('../SelectionListRenderPlan');
        const options = [
            { id: 'metadata', label: 'Build lane', searchText: 'release Payments workspace' },
            { id: 'title', label: 'Payments workspace review' },
            { id: 'subtitle', label: 'Other lane', subtitle: 'Payments workspace' },
        ];

        expect(rankOptionsByQuery(options, 'Payments workspace').map((option) => option.id))
            .toEqual(['title', 'subtitle', 'metadata']);
    });

    it('rankOptionsByQuery promotes exact canonical identity metadata into the first band', async () => {
        const { rankOptionsByQuery } = await import('../SelectionListRenderPlan');
        const options = [
            { id: 'title-prefix', label: 'session-123 follow-up' },
            { id: 'identity', label: 'Build lane', exactSearchText: 'session-123\nPayments workspace' },
            { id: 'metadata', label: 'Other lane', searchText: 'session-123 release' },
        ];

        expect(rankOptionsByQuery(options, 'session-123').map((option) => option.id))
            .toEqual(['title-prefix', 'identity', 'metadata']);
    });

    it('rankOptionsByQuery returns the original array reference unchanged for empty queries', async () => {
        const { rankOptionsByQuery } = await import('../SelectionListRenderPlan');
        const options = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
        expect(rankOptionsByQuery(options, '')).toBe(options);
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

    /**
     * RUX-9.2: subtitle-tier ranking opt-out. The path domain's option
     * subtitles are the full absolute path (e.g. `/Users/leeroy/Documents/...`).
     * Tier-3 (subtitle.includes) creates false positives because typing "de"
     * inside `~/Documents/` matches EVERY child via subtitle. Callers must
     * be able to opt out of the subtitle tier.
     */
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

    it('matches dynamic-section rows by subtitle by default, after label matches', async () => {
        const { synthesizeSelectionListRenderPlan } = await import('../SelectionListRenderPlan');
        const states = new Map<string, DynamicSectionState>();
        states.set('dyn', {
            status: 'success',
            options: [
                { id: '1', label: 'foo', subtitle: '/Users/leeroy/Documents/de' },
                { id: '2', label: 'desktop', subtitle: '/Users/leeroy/' },
                { id: '3', label: 'bar', subtitle: '/tmp' },
            ],
        });
        const plan = synthesizeSelectionListRenderPlan({
            sections: [{ kind: 'dynamic', id: 'dyn', resolve: async () => ({ options: [] }) }],
            inputValue: 'de',
            filterQuery: 'de',
            dynamicSectionStates: states,
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].options.map((o) => o.id)).toEqual(['2', '1']);
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
});

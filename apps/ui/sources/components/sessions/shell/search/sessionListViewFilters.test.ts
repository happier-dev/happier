import { describe, expect, it } from 'vitest';

import {
    buildQualifiedAudienceSelectionKey,
    buildSessionListFilterQueryHomes,
    shouldUseSessionListFilterQuerySource,
    isSessionListEmptyQuerySelectionComplete,
    buildSessionListSelectionScopeSignature,
    createSessionListViewFilterDefaults,
    removeHomeFromSessionListViewFilters,
    removeUnavailableSessionListFilterSelections,
    resolveSessionListFilterOrdinaryPageAdapter,
    resolveTeamSessionsSurfaceState,
} from './sessionListViewFilters';
import * as sessionListViewFiltersModule from './sessionListViewFilters';

type ViewContextDefaultsResolver = (
    viewContext: Readonly<{ kind: 'global' } | { kind: 'team'; team: { serverId: string; teamId: string } }>,
    mountedHomeServerIds: readonly string[],
    source: 'all' | 'persisted' | 'direct',
) => Readonly<{
    contextKey: string;
    defaults: ReturnType<typeof createSessionListViewFilterDefaults>;
}>;

type TeamHomeSelectionResolver = (input: Readonly<{
    team: { serverId: string; teamId: string };
    mountedHomeServerIds: readonly string[];
    focusedHomeServerId: string | null;
}>) => Readonly<
    | { kind: 'mounted' }
    | { kind: 'not_mounted'; initialGroupServerIds: readonly string[] }
>;

describe('sessionListViewFilters', () => {
    it('keeps manual candidates on a Home excluded by the smart lens while fixed Team stays outside the union', () => {
        const outer = createSessionListViewFilterDefaults({ scope: 'all_accessible', homeServerIds: ['home-a'],
            audiences: { include: [{ serverId: 'home-a', kind: 'team', teamId: 'fixed' }], exclude: [] } });
        const smart = createSessionListViewFilterDefaults({ homeServerIds: ['home-b'], tagIds: { include: [{ serverId: 'home-b', tagId: 'smart' }], exclude: [] } });
        const [home] = buildSessionListFilterQueryHomes(outer, { storage: 'active', includeInactive: true, mountedHomeServerIds: ['home-a'],
            viewerAccountIdByServerId: new Map([['home-a', 'me']]), spaceMembership: { filter: smart,
                membership: { mode: 'filter_or_manual', tags: [{ serverId: 'home-a', accountId: 'me', tagId: 'manual' }] } } });
        expect(home?.query).toMatchObject({ audiences: { include: [{ kind: 'team', teamId: 'fixed' }], exclude: [] }, membership: { mode: 'filter_or_manual', tagIds: ['manual'] } });
        expect(home?.query.membership?.filter).toBeUndefined();
        expect(resolveSessionListFilterOrdinaryPageAdapter(outer, home!.query)).toBeNull();
    });
    it('routes Only coordinators to its own producer-filtered corpus and refuses ordinary-page coverage', () => {
        const filters = createSessionListViewFilterDefaults({ homeServerIds: ['home-a'], coordinator: 'coordinator' });
        const options = { mountedHomeServerIds: ['home-a'], storage: 'active' as const, includeInactive: true };
        const [home] = buildSessionListFilterQueryHomes(filters, options);
        const [ordinary] = buildSessionListFilterQueryHomes({ ...filters, coordinator: undefined }, options);
        expect(home?.query.coordinator).toBe('coordinator');
        expect(home?.queryKey).not.toBe(ordinary?.queryKey);
        expect(resolveSessionListFilterOrdinaryPageAdapter(filters, home!.query)).toBeNull();
        const eligibility = { eligibleHomeServerIds: ['home-a'], eligibleAudiences: [], eligibleTagIds: [] };
        expect(buildSessionListSelectionScopeSignature(filters, eligibility))
            .not.toBe(buildSessionListSelectionScopeSignature({ ...filters, coordinator: undefined }, eligibility));
    });
    it('keeps Under at the listing producer and separates subtree corpora and selection identities', () => {
        const filters = createSessionListViewFilterDefaults({ homeServerIds: ['home-a'], underSessionId: 'manager-a', statuses: { include: ['failed'], exclude: [] }, projects: { include: [{ serverId: 'home-a', projectKey: 'payments' }], exclude: [] } });
        const options = { mountedHomeServerIds: ['home-a'], storage: 'active' as const, includeInactive: true };
        const [home] = buildSessionListFilterQueryHomes(filters, options);
        const [other] = buildSessionListFilterQueryHomes({ ...filters, underSessionId: 'manager-b' }, options);
        expect(home?.query.underSessionId).toBe('manager-a');
        expect(home?.queryKey).not.toBe(other?.queryKey);
        expect(resolveSessionListFilterOrdinaryPageAdapter(filters, home!.query)).toBeNull();
        const eligibility = { eligibleHomeServerIds: ['home-a'], eligibleAudiences: [], eligibleTagIds: [] };
        const signature = buildSessionListSelectionScopeSignature(filters, eligibility);
        for (const changed of [{ ...filters, underSessionId: 'manager-b' }, { ...filters, statuses: { include: ['thinking'] as const, exclude: [] } }, { ...filters, projects: { include: [], exclude: filters.projects!.include } }]) {
            expect(buildSessionListSelectionScopeSignature(changed, eligibility)).not.toBe(signature);
        }
    });
    it('carries the Bot projection through the existing Home corpus and ordinary paging adapter', () => {
        const filters = createSessionListViewFilterDefaults({ homeServerIds: ['home-a'], bot: 'bot' });
        const [home] = buildSessionListFilterQueryHomes(filters, {
            mountedHomeServerIds: ['home-a'], storage: 'active', includeInactive: true,
        });
        expect(home?.query.bot).toBe('bot');
        expect(resolveSessionListFilterOrdinaryPageAdapter(filters, home!.query)).toEqual({
            path: '/v2/sessions', allowV1Fallback: true, membership: 'ordinary',
        });
        expect(shouldUseSessionListFilterQuerySource(filters, {
            mountedHomeServerIds: ['home-a'], queryEnabled: false, hasOrdinaryAdapter: false,
        })).toBe(true);
        const eligibility = { eligibleHomeServerIds: ['home-a'], eligibleAudiences: [], eligibleTagIds: [] };
        expect(buildSessionListSelectionScopeSignature(filters, eligibility))
            .not.toBe(buildSessionListSelectionScopeSignature({ ...filters, bot: 'ordinary' }, eligibility));
    });
    it('keeps control-character-bearing Home and Team identities distinct', () => {
        expect(buildQualifiedAudienceSelectionKey({ serverId: 'home\u0000one', kind: 'team', teamId: 'team' }))
            .not.toBe(buildQualifiedAudienceSelectionKey({ serverId: 'home', kind: 'team', teamId: 'one\u0000team' }));
    });
    it('seeds a qualified Team context independently from the global mounted-Home view', () => {
        const resolveSessionListViewContextDefaults = (
            sessionListViewFiltersModule as unknown as Readonly<{
                resolveSessionListViewContextDefaults?: ViewContextDefaultsResolver;
            }>
        ).resolveSessionListViewContextDefaults;

        expect(typeof resolveSessionListViewContextDefaults).toBe('function');
        if (!resolveSessionListViewContextDefaults) return;

        const resolved = resolveSessionListViewContextDefaults({
            kind: 'team',
            team: { serverId: ' home-b ', teamId: ' team-a ' },
        }, ['home-a', 'home-b'], 'persisted');

        expect(resolved.contextKey).not.toBe('global');
        expect(resolved.defaults).toEqual({
            show: 'both',
            startedBy: ['you'],
            scope: 'all_accessible',
            attention: 'any',
            homeServerIds: ['home-b'],
            audiences: { include: [{ serverId: 'home-b', kind: 'team', teamId: 'team-a' }], exclude: [] },
            tagIds: { include: [], exclude: [] },
            source: 'persisted',
            searchQuery: '',
        });
    });

    it('keeps an unmounted Team Home out of runtime state and seeds the visible group editor', () => {
        const resolveTeamSessionsHomeSelection = (
            sessionListViewFiltersModule as unknown as Readonly<{
                resolveTeamSessionsHomeSelection?: TeamHomeSelectionResolver;
            }>
        ).resolveTeamSessionsHomeSelection;

        expect(typeof resolveTeamSessionsHomeSelection).toBe('function');
        if (!resolveTeamSessionsHomeSelection) return;

        expect(resolveTeamSessionsHomeSelection({
            team: { serverId: 'home-b', teamId: 'team-a' },
            mountedHomeServerIds: ['home-a'],
            focusedHomeServerId: 'home-a',
        })).toEqual({
            kind: 'not_mounted',
            initialGroupServerIds: ['home-a', 'home-b'],
        });

        expect(resolveTeamSessionsHomeSelection({
            team: { serverId: 'home-b', teamId: 'team-a' },
            mountedHomeServerIds: ['home-a', 'home-b'],
            focusedHomeServerId: 'home-a',
        })).toEqual({ kind: 'mounted' });

    });

    it('keeps a cold probe, a failed probe, a decided-off Home and an unmounted Home distinct', () => {
        const mounted = { kind: 'mounted' } as const;
        const notMounted = {
            kind: 'not_mounted',
            initialGroupServerIds: ['home-a', 'home-b'],
        } as const;

        expect(resolveTeamSessionsSurfaceState({ decision: null, homeSelection: mounted }))
            .toEqual({ kind: 'loading' });
        expect(resolveTeamSessionsSurfaceState({
            decision: { state: 'unknown', blockerCode: 'probe_failed' },
            homeSelection: mounted,
        })).toEqual({ kind: 'probe_failed' });
        expect(resolveTeamSessionsSurfaceState({
            decision: { state: 'unknown', blockerCode: 'dependency_unknown' },
            homeSelection: mounted,
        })).toEqual({ kind: 'loading' });
        expect(resolveTeamSessionsSurfaceState({
            decision: { state: 'disabled', blockerCode: 'feature_disabled' },
            homeSelection: mounted,
        })).toEqual({ kind: 'unavailable' });
        expect(resolveTeamSessionsSurfaceState({
            decision: { state: 'unsupported', blockerCode: 'endpoint_missing' },
            homeSelection: mounted,
        })).toEqual({ kind: 'unavailable' });
        // An enabled Home this device has not mounted is a mount problem, not an
        // unavailable Team.
        expect(resolveTeamSessionsSurfaceState({
            decision: { state: 'enabled', blockerCode: 'none' },
            homeSelection: notMounted,
        })).toEqual({ kind: 'home_not_mounted', initialGroupServerIds: ['home-a', 'home-b'] });
        expect(resolveTeamSessionsSurfaceState({
            decision: { state: 'enabled', blockerCode: 'none' },
            homeSelection: mounted,
        })).toEqual({ kind: 'ready' });
    });

    it('keeps the qualified tag facet out of the request the legacy adapter can answer', () => {
        const filters = createSessionListViewFilterDefaults({
            homeServerIds: ['home-a'],
            tagIds: { include: [{ serverId: 'home-a', tagId: 'tag_01HX' }], exclude: [] },
        });

        // Query mode: the Home applies the tag predicate before pagination, so the
        // request carries the exact id and no released GET can answer it.
        const [structural] = buildSessionListFilterQueryHomes(filters, {
            storage: 'active',
            includeInactive: true,
            mountedHomeServerIds: ['home-a'],
        });
        expect(structural?.query.tagIds).toEqual({ include: ['tag_01HX'], exclude: [] });
        expect(resolveSessionListFilterOrdinaryPageAdapter(filters, structural!.query)).toBeNull();

        // Legacy mode: no selected Home can express tags, so the request omits them
        // and the released GET keeps serving pages the client then narrows locally.
        // Sending an unanswerable tag predicate would leave the corpus with no source.
        const [legacy] = buildSessionListFilterQueryHomes(filters, {
            storage: 'active',
            includeInactive: true,
            mountedHomeServerIds: ['home-a'],
            tagFacet: 'local',
        });
        expect(legacy?.query.tagIds).toEqual({ include: [], exclude: [] });
        expect(resolveSessionListFilterOrdinaryPageAdapter(filters, legacy!.query)).toEqual({
            path: '/v2/sessions',
            allowV1Fallback: true,
            membership: 'ordinary',
        });
    });

    it('keeps a Home out of a structural tag query when it owns none of the selected tags', () => {
        const filters = createSessionListViewFilterDefaults({
            homeServerIds: ['home-a', 'home-b'],
            tagIds: { include: [{ serverId: 'home-a', tagId: 'tag_01HX' }], exclude: [] },
        });

        expect(buildSessionListFilterQueryHomes(filters, {
            storage: 'active',
            includeInactive: true,
            mountedHomeServerIds: ['home-a', 'home-b'],
        }).map((home) => home.serverId)).toEqual(['home-a']);
        // A local tag projection narrows loaded rows instead of excluding the Home's
        // corpus, so both Homes keep paginating.
        expect(buildSessionListFilterQueryHomes(filters, {
            storage: 'active',
            includeInactive: true,
            mountedHomeServerIds: ['home-a', 'home-b'],
            tagFacet: 'local',
        }).map((home) => home.serverId)).toEqual(['home-a', 'home-b']);
    });

    it('normalizes qualified IDs while preserving the requested context defaults', () => {
        expect(createSessionListViewFilterDefaults({
            scope: 'all_accessible',
            homeServerIds: [' home-b ', 'home-a', 'home-b'],
            audiences: { include: [
                { serverId: ' home-a ', kind: 'team', teamId: ' team-a ' },
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
            ], exclude: [] },
            tagIds: { include: [
                { serverId: 'home-b', tagId: ' urgent ' },
                { serverId: 'home-b', tagId: 'urgent' },
            ], exclude: [] },
        })).toEqual({
            show: 'both',
            startedBy: ['you'],
            scope: 'all_accessible',
            attention: 'any',
            homeServerIds: ['home-b', 'home-a'],
            audiences: { include: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a' }], exclude: [] },
            tagIds: { include: [{ serverId: 'home-b', tagId: 'urgent' }], exclude: [] },
            source: 'all',
            searchQuery: '',
        });
    });

    it('removes dependent audience and tag selections in the same Home transition', () => {
        const filters = createSessionListViewFilterDefaults({
            homeServerIds: ['home-a', 'home-b'],
            audiences: { include: [
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-b', kind: 'outside_teams' },
            ], exclude: [] },
            tagIds: { include: [
                { serverId: 'home-a', tagId: 'urgent' },
                { serverId: 'home-b', tagId: 'later' },
            ], exclude: [] },
        });

        expect(removeHomeFromSessionListViewFilters(filters, 'home-a')).toMatchObject({
            homeServerIds: ['home-b'],
            audiences: { include: [{ serverId: 'home-b', kind: 'outside_teams' }], exclude: [] },
            tagIds: { include: [{ serverId: 'home-b', tagId: 'later' }], exclude: [] },
        });
    });

    it('prunes only selections the caller identifies as deleted', () => {
        const filters = createSessionListViewFilterDefaults({
            homeServerIds: ['offline-home', 'deleted-home'],
            audiences: { include: [
                { serverId: 'offline-home', kind: 'team', teamId: 'stale-team' },
                { serverId: 'offline-home', kind: 'group', teamId: 'team-a', groupId: 'deleted-group' },
            ], exclude: [] },
            tagIds: { include: [
                { serverId: 'offline-home', tagId: 'stale-tag' },
                { serverId: 'offline-home', tagId: 'deleted-tag' },
            ], exclude: [
                { serverId: 'offline-home', tagId: 'retained-exclusion' },
                { serverId: 'offline-home', tagId: 'deleted-tag' },
            ] },
        });

        expect(removeUnavailableSessionListFilterSelections(filters, {
            deletedHomeServerIds: ['deleted-home'],
            deletedAudiences: [
                { serverId: 'offline-home', kind: 'group', teamId: 'team-a', groupId: 'deleted-group' },
            ],
            deletedTagIds: [{ serverId: 'offline-home', tagId: 'deleted-tag' }],
        })).toMatchObject({
            homeServerIds: ['offline-home'],
            audiences: { include: [{ serverId: 'offline-home', kind: 'team', teamId: 'stale-team' }], exclude: [] },
            tagIds: { include: [{ serverId: 'offline-home', tagId: 'stale-tag' }], exclude: [{ serverId: 'offline-home', tagId: 'retained-exclusion' }] },
        });
    });

    it('projects one closed structural query per selected Home', () => {
        const filters = createSessionListViewFilterDefaults({
            scope: 'involving_me',
            attention: 'needs_my_attention',
            homeServerIds: ['home-a', 'home-b'],
            audiences: { include: [
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-b', kind: 'outside_teams' },
            ], exclude: [] },
            tagIds: { include: [
                { serverId: 'home-a', tagId: 'urgent' },
                { serverId: 'home-b', tagId: 'later' },
            ], exclude: [] },
            source: 'direct',
            searchQuery: ' local only ',
        });

        const homes = buildSessionListFilterQueryHomes(filters, {
            storage: 'active',
            includeInactive: false,
            mountedHomeServerIds: ['home-a', 'home-b'],
        });

        expect(homes).toEqual([
            {
                serverId: 'home-a',
                queryKey: expect.any(String),
                query: {
                    v: 1,
                    storage: 'active',
                    includeInactive: false,
                    scope: 'involving_me',
                    attention: 'needs_my_attention',
                    audiences: { include: [{ kind: 'team', teamId: 'team-a' }], exclude: [] },
                    tagIds: { include: ['urgent'], exclude: [] },
                    includeAttention: true,
                },
            },
            {
                serverId: 'home-b',
                queryKey: expect.any(String),
                query: {
                    v: 1,
                    storage: 'active',
                    includeInactive: false,
                    scope: 'involving_me',
                    attention: 'needs_my_attention',
                    audiences: { include: [{ kind: 'outside_teams' }], exclude: [] },
                    tagIds: { include: ['later'], exclude: [] },
                    includeAttention: true,
                },
            },
        ]);
        expect(homes[0]?.queryKey).not.toBe(homes[1]?.queryKey);
        expect(JSON.stringify(homes)).not.toContain('local only');
        expect(JSON.stringify(homes)).not.toContain('direct');
    });

    it('queries only currently mounted Homes without discarding retained qualified selections', () => {
        const filters = createSessionListViewFilterDefaults({
            homeServerIds: ['home-a', 'home-b'],
            audiences: { include: [
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-b', kind: 'team', teamId: 'team-b' },
            ], exclude: [] },
            tagIds: { include: [
                { serverId: 'home-a', tagId: 'urgent' },
                { serverId: 'home-b', tagId: 'later' },
            ], exclude: [] },
        });

        const mountedOnly = buildSessionListFilterQueryHomes(filters, {
            storage: 'active',
            includeInactive: false,
            mountedHomeServerIds: ['home-a'],
        });

        expect(mountedOnly.map((home) => home.serverId)).toEqual(['home-a']);
        expect(filters).toMatchObject({
            homeServerIds: ['home-a', 'home-b'],
            audiences: { include: [
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-b', kind: 'team', teamId: 'team-b' },
            ], exclude: [] },
            tagIds: { include: [
                { serverId: 'home-a', tagId: 'urgent' },
                { serverId: 'home-b', tagId: 'later' },
            ], exclude: [] },
        });

        const remounted = buildSessionListFilterQueryHomes(filters, {
            storage: 'active',
            includeInactive: false,
            mountedHomeServerIds: ['home-a', 'home-b'],
        });
        expect(remounted.map((home) => home.serverId)).toEqual(['home-a', 'home-b']);
    });

    it('excludes a Home when an active qualified facet has no value for that Home', () => {
        const filters = createSessionListViewFilterDefaults({
            homeServerIds: ['home-a', 'home-b'],
            audiences: { include: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a' }], exclude: [] },
            tagIds: { include: [{ serverId: 'home-a', tagId: 'urgent' }], exclude: [] },
        });

        expect(buildSessionListFilterQueryHomes(filters, {
            storage: 'active',
            includeInactive: false,
            mountedHomeServerIds: ['home-a', 'home-b'],
        }).map((home) => home.serverId)).toEqual(['home-a']);
    });

    it('keeps a semantically empty filtered selection on the query source instead of ordinary rows', () => {
        const zeroEligibleHomes = createSessionListViewFilterDefaults({
            homeServerIds: ['home-a', 'home-b'],
            audiences: { include: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a' }], exclude: [] },
            tagIds: { include: [{ serverId: 'home-b', tagId: 'urgent' }], exclude: [] },
        });
        expect(buildSessionListFilterQueryHomes(zeroEligibleHomes, {
            storage: 'active',
            includeInactive: false,
            mountedHomeServerIds: ['home-a', 'home-b'],
        })).toEqual([]);
        expect(shouldUseSessionListFilterQuerySource(zeroEligibleHomes, {
            mountedHomeServerIds: ['home-a', 'home-b'],
            queryEnabled: false,
            hasOrdinaryAdapter: false,
        })).toBe(true);

        expect(shouldUseSessionListFilterQuerySource(createSessionListViewFilterDefaults({
            homeServerIds: [],
        }), {
            mountedHomeServerIds: ['home-a', 'home-b'],
            queryEnabled: false,
            hasOrdinaryAdapter: false,
        })).toBe(true);

        expect(shouldUseSessionListFilterQuerySource(createSessionListViewFilterDefaults({
            homeServerIds: ['home-a', 'home-b'],
        }), {
            mountedHomeServerIds: ['home-a', 'home-b'],
            queryEnabled: false,
            hasOrdinaryAdapter: false,
        })).toBe(false);
    });

    it('pages the ordinary corpus on every selected Home only for local Source/search facets', () => {
        const sourceOnly = createSessionListViewFilterDefaults({
            homeServerIds: ['home-a', 'home-b'],
            source: 'direct',
        });
        const homes = buildSessionListFilterQueryHomes(sourceOnly, {
            storage: 'active',
            includeInactive: false,
            mountedHomeServerIds: ['home-a', 'home-b'],
        });

        expect(homes.map((home) => ({
            serverId: home.serverId,
            adapter: resolveSessionListFilterOrdinaryPageAdapter(sourceOnly, home.query),
        }))).toEqual([
            {
                serverId: 'home-a',
                adapter: { path: '/v2/sessions', allowV1Fallback: true, membership: 'ordinary' },
            },
            {
                serverId: 'home-b',
                adapter: { path: '/v2/sessions', allowV1Fallback: true, membership: 'ordinary' },
            },
        ]);

        const textSearch = createSessionListViewFilterDefaults({
            homeServerIds: ['home-a', 'home-b'],
            searchQuery: 'needle',
        });
        expect(buildSessionListFilterQueryHomes(textSearch, {
            storage: 'active',
            includeInactive: false,
            mountedHomeServerIds: ['home-a', 'home-b'],
        }).map((home) => resolveSessionListFilterOrdinaryPageAdapter(textSearch, home.query)))
            .toEqual([
                { path: '/v2/sessions', allowV1Fallback: true, membership: 'ordinary' },
                { path: '/v2/sessions', allowV1Fallback: true, membership: 'ordinary' },
            ]);

        const structurallyFiltered = createSessionListViewFilterDefaults({
            homeServerIds: ['home-a', 'home-b'],
            source: 'direct',
            audiences: { include: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a' }], exclude: [] },
        });
        const structuralHomes = buildSessionListFilterQueryHomes(structurallyFiltered, {
            storage: 'active',
            includeInactive: false,
            mountedHomeServerIds: ['home-a', 'home-b'],
        });
        expect(structuralHomes.map((home) => (
            resolveSessionListFilterOrdinaryPageAdapter(structurallyFiltered, home.query)
        ))).toEqual([null]);

        const collectiveScope = createSessionListViewFilterDefaults({
            homeServerIds: ['home-a'],
            scope: 'all_accessible',
            source: 'direct',
        });
        const [collectiveHome] = buildSessionListFilterQueryHomes(collectiveScope, {
            storage: 'active',
            includeInactive: false,
            mountedHomeServerIds: ['home-a'],
        });
        expect(collectiveHome).toBeDefined();
        expect(collectiveHome
            ? resolveSessionListFilterOrdinaryPageAdapter(collectiveScope, collectiveHome.query)
            : null).toBeNull();
    });

    it('certifies zero eligible Homes only after mounted options are known', () => {
        expect(isSessionListEmptyQuerySelectionComplete({
            useQuerySource: true,
            mountedHomeCount: 2,
            queryHomeCount: 0,
        })).toBe(true);
        expect(isSessionListEmptyQuerySelectionComplete({
            useQuerySource: true,
            mountedHomeCount: 0,
            queryHomeCount: 0,
        })).toBe(false);
        expect(isSessionListEmptyQuerySelectionComplete({
            useQuerySource: false,
            mountedHomeCount: 2,
            queryHomeCount: 0,
        })).toBe(false);
    });

    it('omits the active attention supplement from an archived corpus and forwards a requested page limit', () => {
        const filters = createSessionListViewFilterDefaults({
            homeServerIds: ['home-a'],
            attention: 'needs_my_attention',
        });

        const archived = buildSessionListFilterQueryHomes(filters, {
            storage: 'archived',
            includeInactive: true,
            mountedHomeServerIds: ['home-a'],
            limit: 25,
        });

        expect(archived[0]?.query).toMatchObject({
            storage: 'archived',
            attention: 'needs_my_attention',
            limit: 25,
        });
        expect(archived[0]?.query.includeAttention).toBeUndefined();
    });

    it('keeps one corpus identity when the same selectors are picked in another order', () => {
        const first = buildSessionListFilterQueryHomes(createSessionListViewFilterDefaults({
            homeServerIds: ['home-a'],
            audiences: { include: [
                { serverId: 'home-a', kind: 'team', teamId: 'team-b' },
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
            ], exclude: [] },
            tagIds: { include: [
                { serverId: 'home-a', tagId: 'later' },
                { serverId: 'home-a', tagId: 'urgent' },
            ], exclude: [] },
        }), { storage: 'active', includeInactive: false, mountedHomeServerIds: ['home-a'] });
        const second = buildSessionListFilterQueryHomes(createSessionListViewFilterDefaults({
            homeServerIds: ['home-a'],
            audiences: { include: [
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-a', kind: 'team', teamId: 'team-b' },
            ], exclude: [] },
            tagIds: { include: [
                { serverId: 'home-a', tagId: 'urgent' },
                { serverId: 'home-a', tagId: 'later' },
            ], exclude: [] },
        }), { storage: 'active', includeInactive: false, mountedHomeServerIds: ['home-a'] });

        expect(first[0]?.queryKey).toBe(second[0]?.queryKey);
    });

    it('builds selection identity from normalized query and currently eligible qualified addresses', () => {
        const filters = createSessionListViewFilterDefaults({
            homeServerIds: ['home-a', 'home-b'],
            audiences: { include: [
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-b', kind: 'team', teamId: 'team-b' },
            ], exclude: [] },
            tagIds: { include: [
                { serverId: 'home-a', tagId: 'urgent' },
                { serverId: 'home-b', tagId: 'later' },
            ], exclude: [] },
            searchQuery: '  Fix   Race  ',
        });

        const signature = buildSessionListSelectionScopeSignature(filters, {
            eligibleHomeServerIds: ['home-a'],
            eligibleAudiences: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a' }],
            eligibleTagIds: [{ serverId: 'home-a', tagId: 'urgent' }],
        });

        expect(signature).toContain('fix race');
        expect(signature).toContain('home-a');
        expect(signature).toContain('team-a');
        expect(signature).toContain('urgent');
        expect(signature).not.toContain('home-b');
        expect(signature).not.toContain('team-b');
        expect(signature).not.toContain('later');
        const eligibility = {
            eligibleHomeServerIds: ['home-a'],
            eligibleAudiences: [{ serverId: 'home-a', kind: 'team' as const, teamId: 'team-a' }],
            eligibleTagIds: [{ serverId: 'home-a', tagId: 'urgent' }],
        };
        expect(buildSessionListSelectionScopeSignature({ ...filters, show: 'runs' }, eligibility)).not.toBe(signature);
        expect(buildSessionListSelectionScopeSignature({ ...filters, startedBy: [] }, eligibility)).not.toBe(signature);
        expect(buildSessionListSelectionScopeSignature({ ...filters, startedBy: ['agents', 'triggers'] }, eligibility))
            .toBe(buildSessionListSelectionScopeSignature({ ...filters, startedBy: ['triggers', 'agents'] }, eligibility));
    });
});

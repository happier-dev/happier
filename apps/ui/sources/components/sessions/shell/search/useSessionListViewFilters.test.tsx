import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import {
    buildQualifiedAudienceSelectionKey,
    buildSessionListFilterQueryHomes,
    resolveSessionListViewContextDefaults,
    type SessionListViewContext,
} from './sessionListViewFilters';
import { reduceSessionListFilterEditorSelection } from './sessionListFilterEditorModel';

import {
    clearSessionListViewFilterRetentionForTests,
    type UseSessionListViewFiltersInput,
    removeAuthoritativelyDeletedSessionListTagsForAccount,
    showOnlyCoordinatorsInSessionList,
    retireSessionListViewFilterCredentialContributions,
    useSessionListViewFilters,
} from './useSessionListViewFilters';

function boundAccountScopes(
    ...scopes: readonly Readonly<{ serverId: string; accountId: string }>[]
) {
    return new Map(scopes.map((scope) => [scope.serverId, { kind: 'bound' as const, scope }]));
}

afterEach(() => {
    clearSessionListViewFilterRetentionForTests();
    standardCleanup();
});

describe('useSessionListViewFilters', () => {
    it('keeps the saved lens separate from temporary narrowing and resets that narrowing', async () => {
        const defaults = resolveSessionListViewContextDefaults({ kind: 'global' }, ['home-a'], 'all').defaults;
        const savedSpace = { accountScopeKey: 'account-a', id: 'smart', filter: { ...defaults, source: 'persisted' as const } };
        const hook = await renderHook(() => useSessionListViewFilters({ contextKey: 'global', defaults, savedSpace,
            accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-a' }) }));
        expect(hook.getCurrent().refinements.source).toBe('all');
        await act(async () => hook.getCurrent().updateFilters(current => ({ ...current, source: 'direct' })));
        expect(hook.getCurrent().refinements.source).toBe('direct');
        expect(hook.getCurrent().savedLens?.source).toBe('persisted');
        await act(async () => hook.getCurrent().resetFilters());
        expect(hook.getCurrent().filters.source).toBe('persisted');
        expect(hook.getCurrent().refinements.source).toBe('all');
    });
    it.each([false, true])('defers Show coordinators until a cold catalog can accept selection (requested before mount: %s)', async beforeMount => {
        if (beforeMount) showOnlyCoordinatorsInSessionList();
        const hook = await renderHook(() => useSessionListViewFilters({ contextKey: 'global',
            defaults: { homeServerIds: ['home-a'] }, spaceSettingsAccountScopeKey: 'account-a',
            accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-a' }),
        }));
        await act(async () => hook.getCurrent().setSearchQuery('pending catalog draft'));
        if (!beforeMount) await act(async () => showOnlyCoordinatorsInSessionList());
        expect(hook.getCurrent().showCoordinatorsRequest).toBe(1);
        expect(hook.getCurrent().filters).toMatchObject({ searchQuery: 'pending catalog draft' });
        expect(hook.getCurrent().filters.coordinator).toBeUndefined();
    });

    it('carries Show coordinators as one pending default-space/editor intent without modifying a saved definition', async () => {
        const defaults = resolveSessionListViewContextDefaults({ kind: 'global' }, ['home-a'], 'all').defaults;
        const saved = { accountScopeKey: 'account-a', id: 'saved', filter: { ...defaults, source: 'direct' as const } };
        const hook = await renderHook(() => useSessionListViewFilters({ contextKey: 'global', defaults,
            savedSpace: saved, accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-a' }) }));
        expect(hook.getCurrent().showCoordinatorsRequest).toBe(0);
        await act(async () => showOnlyCoordinatorsInSessionList());
        expect(hook.getCurrent().showCoordinatorsRequest).toBeGreaterThan(0);
        expect(saved.filter.source).toBe('direct');
        expect(hook.getCurrent().filters).toMatchObject({ source: 'direct' });
        expect(hook.getCurrent().filters.coordinator).toBeUndefined();
        await act(async () => hook.getCurrent().acknowledgeShowCoordinatorsRequest());
        expect(hook.getCurrent().showCoordinatorsRequest).toBe(0);
    });
    it('retains one draft per authority/context and resets to the selected saved definition', async () => {
        const defaults = resolveSessionListViewContextDefaults({ kind: 'global' }, ['home-a'], 'all').defaults;
        const first = { accountScopeKey: 'account-a', id: 'first', filter: { ...defaults, source: 'persisted' as const } };
        const second = { accountScopeKey: 'account-a', id: 'second', filter: { ...defaults, source: 'direct' as const } };
        const input: UseSessionListViewFiltersInput = {
            contextKey: 'global', defaults,
            accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-a' }),
            savedSpace: first,
        };
        const hook = await renderHook((value: UseSessionListViewFiltersInput) => useSessionListViewFilters(value), { initialProps: input });
        expect(hook.getCurrent().filters.source).toBe('persisted');
        await act(async () => hook.getCurrent().updateFilters(current => ({ ...current, source: 'all', searchQuery: 'local find' })));
        expect((await hook.rerender(input)).filters).toMatchObject({ source: 'all', searchQuery: 'local find' });
        await act(async () => hook.getCurrent().resetFilters());
        expect(hook.getCurrent().filters).toMatchObject({ source: 'persisted', searchQuery: '' });
        await act(async () => hook.getCurrent().setSearchQuery('discard on explicit space switch'));
        expect((await hook.rerender({ ...input, savedSpace: second })).filters).toMatchObject({ source: 'direct', searchQuery: '' });
        expect((await hook.rerender({ ...input, savedSpace: first })).filters).toMatchObject({ source: 'persisted', searchQuery: '' });
        await act(async () => hook.getCurrent().setSearchQuery('private a'));
        expect((await hook.rerender({ ...input, savedSpace: { ...first, accountScopeKey: 'account-b' } })).filters.searchQuery).toBe('');
    });

    it('preserves the selected draft while its settings definition is temporarily unavailable', async () => {
        const defaults = resolveSessionListViewContextDefaults({ kind: 'global' }, ['home-a'], 'all').defaults;
        const savedSpace = { accountScopeKey: 'account-a', id: 'saved', filter: { ...defaults, source: 'direct' as const } };
        const input: UseSessionListViewFiltersInput = { contextKey: 'global', defaults, savedSpace,
            accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-a' }) };
        const hook = await renderHook((value: UseSessionListViewFiltersInput) => useSessionListViewFilters(value), { initialProps: input });
        await act(async () => hook.getCurrent().setSearchQuery('keep local Find'));
        expect((await hook.rerender({ ...input, savedSpace: undefined })).filters).toMatchObject({
            source: 'direct', searchQuery: 'keep local Find',
        });
        expect((await hook.rerender(input)).filters.searchQuery).toBe('keep local Find');
        expect((await hook.rerender({ ...input, savedSpace: undefined, spaceSettingsAccountScopeKey: 'account-b' })).filters)
            .toMatchObject({ source: 'all', searchQuery: '' });
    });

    it('restores each authority selection without leaking a discarded draft on A to B to A navigation', async () => {
        const defaults = resolveSessionListViewContextDefaults({ kind: 'global' }, ['home-a', 'home-b'], 'all').defaults;
        const first = { accountScopeKey: 'account-a', id: 'selected-a', filter: { ...defaults, source: 'direct' as const } };
        const second = { accountScopeKey: 'account-b', id: 'selected-b', filter: { ...defaults, source: 'persisted' as const } };
        const input: UseSessionListViewFiltersInput = { contextKey: 'global', defaults, savedSpace: first,
            spaceSettingsAccountScopeKey: first.accountScopeKey, accountScopeResolutions: boundAccountScopes(
                { serverId: 'home-a', accountId: 'account-a' }, { serverId: 'home-b', accountId: 'account-b' }) };
        const hook = await renderHook((value: UseSessionListViewFiltersInput) => useSessionListViewFilters(value), { initialProps: input });
        await act(async () => hook.getCurrent().updateFilters(current => ({ ...current, source: 'all', searchQuery: 'private A Find' })));
        expect((await hook.rerender({ ...input, savedSpace: second, spaceSettingsAccountScopeKey: second.accountScopeKey })).filters)
            .toMatchObject({ source: 'persisted', searchQuery: '' });
        expect((await hook.rerender(input)).filters).toMatchObject({ source: 'direct', searchQuery: '' });
    });

    it('intersects selected spaces with fixed Team and Runs constraints', async () => {
        const viewContext = { kind: 'team' as const, team: { serverId: 'home-a', teamId: 'team-a' } };
        const context = resolveSessionListViewContextDefaults(viewContext, ['home-a'], 'all');
        const hook = await renderHook(() => useSessionListViewFilters({
            ...context, viewContext, fixedShow: 'runs',
            accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-a' }),
            savedSpace: { accountScopeKey: 'account-a', id: 'saved', filter: {
                ...context.defaults, show: 'sessions', audiences: [{ serverId: 'home-a', kind: 'team', teamId: 'other-team' }],
            } },
        }));
        expect(hook.getCurrent().filters).toMatchObject({
            show: 'runs', audiences: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a' }],
        });
    });

    it('enforces the fixed Show on writes and reset while retaining starter choices across remount', async () => {
        const input = {
            contextKey: 'global:show:runs',
            fixedShow: 'runs' as const,
            defaults: { homeServerIds: ['home-a'], show: 'runs' as const },
            accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-a' }),
        };
        const hook = await renderHook(() => useSessionListViewFilters(input));
        await act(async () => hook.getCurrent().updateFilters((current) => ({
            ...current, show: 'sessions', startedBy: ['triggers', 'agents'],
        })));
        expect(hook.getCurrent().filters).toMatchObject({ show: 'runs', startedBy: ['triggers', 'agents'] });
        await hook.unmount();
        const remounted = await renderHook(() => useSessionListViewFilters(input));
        expect(remounted.getCurrent().filters).toMatchObject({ show: 'runs', startedBy: ['triggers', 'agents'] });
        await act(async () => remounted.getCurrent().resetFilters());
        expect(remounted.getCurrent().filters).toMatchObject({ show: 'runs', startedBy: ['you'] });
    });

    it.each(['team', 'global'] as const)('preserves the %s audience boundary through authoritative Group pruning', async (kind) => {
        const team = { serverId: 'home-a', teamId: 'team-a' };
        const viewContext: SessionListViewContext = kind === 'team' ? { kind, team } : { kind };
        const context = resolveSessionListViewContextDefaults(viewContext, [team.serverId], 'all');
        const fixedAudienceKeys = kind === 'team'
            ? new Set([buildQualifiedAudienceSelectionKey({ ...team, kind: 'team' })])
            : undefined;
        const hook = await renderHook(() => useSessionListViewFilters({
            ...context,
            viewContext,
            accountScopeResolutions: boundAccountScopes({ serverId: team.serverId, accountId: 'account-a' }),
        }));
        const group = (groupId: string) => ({ ...team, kind: 'group' as const, groupId });
        const queryAudiences = () => buildSessionListFilterQueryHomes(hook.getCurrent().filters, {
            storage: 'active', includeInactive: true, mountedHomeServerIds: [team.serverId],
        })[0].query.audiences;
        await act(async () => {
            for (const id of ['group-a', 'group-b']) {
                hook.getCurrent().updateFilters((filters) => reduceSessionListFilterEditorSelection(
                    filters, `audience:${buildQualifiedAudienceSelectionKey(group(id))}`, { fixedAudienceKeys },
                ));
            }
            hook.getCurrent().setSearchQuery('retain this search');
        });
        expect(queryAudiences()).toEqual([
            { kind: 'group', teamId: team.teamId, groupId: 'group-a' },
            { kind: 'group', teamId: team.teamId, groupId: 'group-b' },
        ]);
        await act(async () => hook.getCurrent().removeAuthoritativelyDeletedSelections({ deletedAudiences: [group('group-a')] }));
        expect(queryAudiences()).toEqual([{ kind: 'group', teamId: team.teamId, groupId: 'group-b' }]);
        await act(async () => hook.getCurrent().removeAuthoritativelyDeletedSelections({ deletedAudiences: [group('group-b')] }));
        expect(queryAudiences()).toEqual(kind === 'team' ? [{ kind: 'team', teamId: team.teamId }] : []);
        expect(hook.getCurrent().filters.searchQuery).toBe('retain this search');
        expect(hook.getCurrent().filters.homeServerIds).toEqual([team.serverId]);
        await hook.unmount();
        const remounted = await renderHook(() => useSessionListViewFilters({
            ...context, viewContext,
            accountScopeResolutions: boundAccountScopes({ serverId: team.serverId, accountId: 'account-a' }),
        }));
        expect(remounted.getCurrent().filters.audiences).toEqual(kind === 'team' ? [{ ...team, kind: 'team' }] : []);
        if (kind === 'team') {
            const before = remounted.getCurrent().filters;
            await act(async () => remounted.getCurrent().removeAuthoritativelyDeletedSelections({
                deletedAudiences: [{ ...team, kind: 'team' }],
            }));
            // The destination's fixed identity survives catalog removal without
            // producing an endless prune/restore render loop.
            expect(remounted.getCurrent().filters).toBe(before);
        }
        await act(async () => remounted.getCurrent().removeAuthoritativelyDeletedSelections({
            deletedHomeServerIds: [team.serverId],
        }));
        expect(remounted.getCurrent().filters.homeServerIds).toEqual([]);
        expect(remounted.getCurrent().filters.audiences).toEqual([]);
        expect(buildSessionListFilterQueryHomes(remounted.getCurrent().filters, {
            storage: 'active', includeInactive: true, mountedHomeServerIds: [team.serverId],
        })).toEqual([]);
    });

    it('retains the whole canonical filter model for one credential corpus/context lifetime', async () => {
        const hook = await renderHook(
            (contextKey: string) => useSessionListViewFilters({
                contextKey,
                accountScopeResolutions: boundAccountScopes(
                    { serverId: 'home-a', accountId: 'account-a' },
                    { serverId: 'home-b', accountId: 'account-b' },
                ),
                defaults: {
                    scope: contextKey === 'team-a' ? 'all_accessible' : 'my_work',
                    homeServerIds: contextKey === 'team-a' ? ['home-a'] : ['home-a', 'home-b'],
                    audiences: contextKey === 'team-a'
                        ? [{ serverId: 'home-a', kind: 'team', teamId: 'team-a' }]
                        : [],
                },
            }),
            { initialProps: 'global' },
        );

        await act(async () => {
            hook.getCurrent().updateFilters((current) => ({
                ...current,
                attention: 'needs_my_attention',
                show: 'runs',
                startedBy: ['triggers', 'agents'],
                source: 'direct',
                searchQuery: 'private search',
                tagIds: [{ serverId: 'home-a', tagId: 'urgent' }],
            }));
        });
        expect(hook.getCurrent().filters).toMatchObject({
            scope: 'my_work',
            attention: 'needs_my_attention',
            show: 'runs',
            startedBy: ['triggers', 'agents'],
            source: 'direct',
            searchQuery: 'private search',
        });

        const team = await hook.rerender('team-a');
        expect(team.filters).toMatchObject({
            scope: 'all_accessible',
            homeServerIds: ['home-a'],
            audiences: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a' }],
            searchQuery: '',
        });

        await act(async () => team.setSearchQuery('team search'));
        const globalAgain = await hook.rerender('global');
        expect(globalAgain.filters.searchQuery).toBe('private search');
        expect(globalAgain.filters.tagIds).toEqual([{ serverId: 'home-a', tagId: 'urgent' }]);
        expect(globalAgain.filters.show).toBe('runs');
        expect(globalAgain.filters.startedBy).toEqual(['triggers', 'agents']);
    });

    it('lets an untouched global default follow a Home that finishes mounting later', async () => {
        const hook = await renderHook(
            (homeServerIds: readonly string[]) => useSessionListViewFilters({
                contextKey: 'global',
                accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-a' }),
                followDefaultHomeSelection: true,
                defaults: { homeServerIds },
            }),
            { initialProps: ['home-a'] },
        );

        await act(async () => hook.getCurrent().setSearchQuery('kept'));
        await act(async () => hook.getCurrent().updateFilters((current) => ({
            ...current,
            scope: 'assigned_to_me',
            tagIds: [{ serverId: 'home-a', tagId: 'urgent' }],
        })));

        const refreshed = await hook.rerender(['home-a', 'home-b']);
        expect(refreshed.filters.homeServerIds).toEqual(['home-a', 'home-b']);
        // Mounting a Home changes the Home set only; nothing else about the view resets.
        expect(refreshed.filters.searchQuery).toBe('kept');
        expect(refreshed.filters.scope).toBe('assigned_to_me');
        expect(refreshed.filters.tagIds).toEqual([{ serverId: 'home-a', tagId: 'urgent' }]);
    });

    it('never undoes an explicit Home choice when Homes mount, remount or probe again', async () => {
        const hook = await renderHook(
            (homeServerIds: readonly string[]) => useSessionListViewFilters({
                contextKey: 'global',
                accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-a' }),
                followDefaultHomeSelection: true,
                defaults: { homeServerIds },
            }),
            { initialProps: ['home-a', 'home-b'] },
        );

        await act(async () => hook.getCurrent().updateFilters((current) => ({
            ...current,
            homeServerIds: ['home-a'],
        })));

        expect((await hook.rerender(['home-a', 'home-b', 'home-c'])).filters.homeServerIds).toEqual(['home-a']);
        expect((await hook.rerender(['home-a', 'home-b'])).filters.homeServerIds).toEqual(['home-a']);

        // Clear filters restores the then-current mounted default and re-enters
        // default-following behaviour.
        await act(async () => hook.getCurrent().resetFilters());
        expect(hook.getCurrent().filters.homeServerIds).toEqual(['home-a', 'home-b']);
        expect((await hook.rerender(['home-a', 'home-b', 'home-d'])).filters.homeServerIds)
            .toEqual(['home-a', 'home-b', 'home-d']);
    });

    it('does not re-enter default following when an explicitly excluded Home is later deleted', async () => {
        const hook = await renderHook(
            (input: Readonly<{
                mounted: readonly string[];
                authoritative: readonly string[];
                accountScopes: readonly Readonly<{ serverId: string; accountId: string }>[];
            }>) => useSessionListViewFilters({
                contextKey: 'global',
                accountScopeResolutions: boundAccountScopes(...input.accountScopes),
                followDefaultHomeSelection: true,
                defaults: { homeServerIds: input.mounted },
                authoritativeHomeServerIds: input.authoritative,
            }),
            {
                initialProps: {
                    mounted: ['home-a', 'home-b'],
                    authoritative: ['home-a', 'home-b'],
                    accountScopes: [
                        { serverId: 'home-a', accountId: 'account-a' },
                        { serverId: 'home-b', accountId: 'account-b' },
                    ],
                },
            },
        );

        await act(async () => hook.getCurrent().updateFilters((current) => ({
            ...current,
            homeServerIds: ['home-a'],
        })));

        await hook.rerender({
            mounted: ['home-a'],
            authoritative: ['home-a'],
            accountScopes: [{ serverId: 'home-a', accountId: 'account-a' }],
        });
        const afterLaterMount = await hook.rerender({
            mounted: ['home-a', 'home-c'],
            authoritative: ['home-a', 'home-c'],
            accountScopes: [
                { serverId: 'home-a', accountId: 'account-a' },
                { serverId: 'home-c', accountId: 'account-c' },
            ],
        });

        expect(afterLaterMount.filters.homeServerIds).toEqual(['home-a']);
    });

    it('prunes a removed authoritative Home and its dependent selections without treating mount exclusion as deletion', async () => {
        const hook = await renderHook(
            (input: Readonly<{ mounted: readonly string[]; authoritative: readonly string[] }>) => useSessionListViewFilters({
                contextKey: 'global',
                accountScopeResolutions: boundAccountScopes(
                    { serverId: 'home-a', accountId: 'account-a' },
                    { serverId: 'home-b', accountId: 'account-b' },
                ),
                followDefaultHomeSelection: true,
                defaults: { homeServerIds: input.mounted },
                authoritativeHomeServerIds: input.authoritative,
            }),
            { initialProps: { mounted: ['home-a'], authoritative: ['home-a', 'home-b'] } },
        );

        await act(async () => hook.getCurrent().updateFilters((current) => ({
            ...current,
            homeServerIds: ['home-a', 'home-b'],
            audiences: [{ serverId: 'home-b', kind: 'team', teamId: 'team-b' }],
            tagIds: [{ serverId: 'home-b', tagId: 'important' }],
        })));

        const excluded = await hook.rerender({
            mounted: ['home-a'],
            authoritative: ['home-a', 'home-b'],
        });
        expect(excluded.filters).toMatchObject({
            homeServerIds: ['home-a', 'home-b'],
            audiences: [{ serverId: 'home-b', kind: 'team', teamId: 'team-b' }],
            tagIds: [{ serverId: 'home-b', tagId: 'important' }],
        });

        const deleted = await hook.rerender({
            mounted: ['home-a'],
            authoritative: ['home-a'],
        });
        expect(deleted.filters).toMatchObject({
            homeServerIds: ['home-a'],
            audiences: [],
            tagIds: [],
        });
    });

    it('retains transiently missing selections and durably prunes only explicit Team, Group and tag deletions', async () => {
        const render = () => renderHook(() => useSessionListViewFilters({
            contextKey: 'global',
            accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-a' }),
            defaults: { homeServerIds: ['home-a'] },
        }));
        const hook = await render();

        await act(async () => hook.getCurrent().updateFilters((current) => ({
            ...current,
            audiences: [
                { serverId: 'home-a', kind: 'team', teamId: 'deleted-team' },
                { serverId: 'home-a', kind: 'group', teamId: 'team-a', groupId: 'deleted-group' },
                { serverId: 'home-a', kind: 'group', teamId: 'team-a', groupId: 'retained-group' },
            ],
            tagIds: [
                { serverId: 'home-a', tagId: 'deleted-tag' },
                { serverId: 'home-a', tagId: 'retained-tag' },
            ],
        })));

        // A loading/offline/partial producer supplies no deletion evidence, so
        // merely rerendering the retained owner preserves every opaque id.
        expect((await hook.rerender()).filters.audiences).toHaveLength(3);
        expect(hook.getCurrent().filters.tagIds).toHaveLength(2);

        await act(async () => hook.getCurrent().removeAuthoritativelyDeletedSelections({
            deletedAudiences: [
                { serverId: 'home-a', kind: 'team', teamId: 'deleted-team' },
                { serverId: 'home-a', kind: 'group', teamId: 'team-a', groupId: 'deleted-group' },
            ],
        }));
        removeAuthoritativelyDeletedSessionListTagsForAccount(
            { serverId: 'home-a', accountId: 'account-a' },
            ['deleted-tag'],
        );
        await hook.rerender();
        expect(hook.getCurrent().filters).toMatchObject({
            audiences: [{ serverId: 'home-a', kind: 'group', teamId: 'team-a', groupId: 'retained-group' }],
            tagIds: [{ serverId: 'home-a', tagId: 'retained-tag' }],
        });

        await hook.unmount();
        const remounted = await render();
        expect(remounted.getCurrent().filters).toMatchObject({
            audiences: [{ serverId: 'home-a', kind: 'group', teamId: 'team-a', groupId: 'retained-group' }],
            tagIds: [{ serverId: 'home-a', tagId: 'retained-tag' }],
        });
    });

    it('applies a committed tag deletion only to retained filters for its exact Account and Home', async () => {
        const homeA = await renderHook(() => useSessionListViewFilters({
            contextKey: 'home-a-view',
            accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-a' }),
            defaults: { homeServerIds: ['home-a'], tagIds: [{ serverId: 'home-a', tagId: 'tag-1' }] },
        }));
        const homeB = await renderHook(() => useSessionListViewFilters({
            contextKey: 'home-b-view',
            accountScopeResolutions: boundAccountScopes({ serverId: 'home-b', accountId: 'account-a' }),
            defaults: { homeServerIds: ['home-b'], tagIds: [{ serverId: 'home-b', tagId: 'tag-1' }] },
        }));
        const otherAccount = await renderHook(() => useSessionListViewFilters({
            contextKey: 'other-account-home-a-view',
            accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-b' }),
            defaults: { homeServerIds: ['home-a'], tagIds: [{ serverId: 'home-a', tagId: 'tag-1' }] },
        }));

        removeAuthoritativelyDeletedSessionListTagsForAccount(
            { serverId: 'home-a', accountId: 'account-a' },
            ['tag-1'],
        );
        await homeA.rerender();
        await homeB.rerender();
        await otherAccount.rerender();

        expect(homeA.getCurrent().filters.tagIds).toEqual([]);
        expect(homeB.getCurrent().filters.tagIds).toEqual([{ serverId: 'home-b', tagId: 'tag-1' }]);
        expect(otherAccount.getCurrent().filters.tagIds).toEqual([{ serverId: 'home-a', tagId: 'tag-1' }]);
    });

    it('preserves one global filter context across rerenders while both Home credentials contribute', async () => {
        const hook = await renderHook(() => useSessionListViewFilters({
            contextKey: 'global',
            accountScopeResolutions: boundAccountScopes(
                { serverId: 'home-a', accountId: 'account-home-a' },
                { serverId: 'home-b', accountId: 'account-home-b' },
            ),
            defaults: { homeServerIds: ['home-a', 'home-b'] },
        }));

        await act(async () => hook.getCurrent().updateFilters((current) => ({
            ...current,
            scope: 'assigned_to_me',
            searchQuery: 'retained search',
            tagIds: [
                { serverId: 'home-a', tagId: 'tag-a' },
                { serverId: 'home-b', tagId: 'tag-b' },
            ],
        })));

        const afterFocusSwitch = await hook.rerender();
        expect(afterFocusSwitch.filters).toMatchObject({
            scope: 'assigned_to_me',
            searchQuery: 'retained search',
            tagIds: [
                { serverId: 'home-a', tagId: 'tag-a' },
                { serverId: 'home-b', tagId: 'tag-b' },
            ],
        });
    });

    it('applies off-focus authoritative tag deletion to its contribution in a retained global context', async () => {
        const hook = await renderHook(() => useSessionListViewFilters({
            contextKey: 'global',
            accountScopeResolutions: boundAccountScopes(
                { serverId: 'home-a', accountId: 'account-home-a' },
                { serverId: 'home-b', accountId: 'account-home-b' },
            ),
            defaults: {
                homeServerIds: ['home-a', 'home-b'],
                tagIds: [
                    { serverId: 'home-a', tagId: 'same-id' },
                    { serverId: 'home-b', tagId: 'same-id' },
                ],
            },
        }));

        removeAuthoritativelyDeletedSessionListTagsForAccount(
            { serverId: 'home-b', accountId: 'account-home-b' },
            ['same-id'],
        );
        await hook.rerender();

        expect(hook.getCurrent().filters.tagIds).toEqual([
            { serverId: 'home-a', tagId: 'same-id' },
        ]);
    });

    it('prunes one retired credential contribution without clearing unrelated global filters', async () => {
        const hook = await renderHook(
            (homeASignedIn: boolean) => useSessionListViewFilters({
                contextKey: 'global',
                accountScopeResolutions: new Map([
                    ['home-a', homeASignedIn
                        ? { kind: 'bound' as const, scope: { serverId: 'home-a', accountId: 'account-a' } }
                        : { kind: 'signed_out' as const }],
                    ['home-b', { kind: 'bound' as const, scope: { serverId: 'home-b', accountId: 'account-b' } }],
                ]),
                authoritativeHomeServerIds: ['home-a', 'home-b'],
                defaults: { homeServerIds: ['home-a', 'home-b'] },
            }),
            { initialProps: true },
        );

        await act(async () => hook.getCurrent().updateFilters((current) => ({
            ...current,
            scope: 'assigned_to_me',
            searchQuery: 'keep for home b',
            audiences: [
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-b', kind: 'team', teamId: 'team-b' },
            ],
            tagIds: [
                { serverId: 'home-a', tagId: 'tag-a' },
                { serverId: 'home-b', tagId: 'tag-b' },
            ],
        })));

        const afterRetirement = await hook.rerender(false);
        expect(afterRetirement.filters).toMatchObject({
            scope: 'assigned_to_me',
            searchQuery: 'keep for home b',
            homeServerIds: ['home-b'],
            audiences: [{ serverId: 'home-b', kind: 'team', teamId: 'team-b' }],
            tagIds: [{ serverId: 'home-b', tagId: 'tag-b' }],
        });
    });

    it('keeps a Team context fixed to its exact Home while other Homes mount', async () => {
        const hook = await renderHook(
            (homeServerIds: readonly string[]) => useSessionListViewFilters({
                contextKey: 'team:home-a/team-1',
                accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-a' }),
                defaults: { homeServerIds: ['home-a'] },
                // Team context deliberately does not opt into default following.
                ...(homeServerIds.length > 99 ? { followDefaultHomeSelection: true } : {}),
            }),
            { initialProps: ['home-a'] },
        );

        expect((await hook.rerender(['home-a', 'home-b'])).filters.homeServerIds).toEqual(['home-a']);
    });

    it('retires a Home-scoped context when its exact credential Account changes', async () => {
        const hook = await renderHook(
            (accountId: string) => useSessionListViewFilters({
                contextKey: 'team:home-a/team-1',
                accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId }),
                defaults: { homeServerIds: ['home-a'] },
            }),
            { initialProps: 'account-a' },
        );
        await act(async () => hook.getCurrent().setSearchQuery('private'));

        expect((await hook.rerender('account-b')).filters.searchQuery).toBe('');
        expect((await hook.rerender('account-a')).filters.searchQuery).toBe('');
    });

    it('clears the final Home-scoped contribution as soon as credential replacement starts resolving', async () => {
        const hook = await renderHook(() => useSessionListViewFilters({
            contextKey: 'team:home-a/team-1',
            accountScopeResolutions: boundAccountScopes({ serverId: 'home-a', accountId: 'account-a' }),
            defaults: {
                scope: 'all_accessible',
                homeServerIds: ['home-a'],
                audiences: [{ serverId: 'home-a', kind: 'team', teamId: 'team-1' }],
            },
        }));
        await act(async () => hook.getCurrent().setSearchQuery('old account private search'));

        retireSessionListViewFilterCredentialContributions('home-a');
        await hook.rerender();

        expect(hook.getCurrent().filters).toMatchObject({
            scope: 'all_accessible',
            homeServerIds: ['home-a'],
            audiences: [{ serverId: 'home-a', kind: 'team', teamId: 'team-1' }],
            searchQuery: '',
        });
    });

    it.each(['authority-b', null])('retires pre-catalog drafts when settings authority becomes %s', async (nextAuthority) => {
        const hook = await renderHook((authority: string | null) => useSessionListViewFilters({
            contextKey: 'global',
            accountScopeResolutions: boundAccountScopes(
                { serverId: 'home-a', accountId: 'account-a' },
                { serverId: 'home-b', accountId: 'account-b' },
            ),
            defaults: { homeServerIds: ['home-a', 'home-b'] },
            spaceSettingsAccountScopeKey: authority,
        }), { initialProps: 'authority-a' as string | null });
        await act(async () => hook.getCurrent().setSearchQuery('private pending catalog'));

        expect((await hook.rerender('authority-a')).filters.searchQuery).toBe('private pending catalog');
        expect((await hook.rerender(nextAuthority)).filters.searchQuery).toBe('');
        expect((await hook.rerender('authority-a')).filters.searchQuery).toBe('');
    });


});

import { describe, expect, it } from 'vitest';

import { resolveSessionListViewEmptyState } from './sessionListViewEmptyStateModel';
import { createSessionListViewFilterDefaults } from './search/sessionListViewFilters';

const globalDefaults = {
    ...createSessionListViewFilterDefaults(),
    scope: 'my_work',
    attention: 'any',
    homeServerIds: ['home-a'],
    audiences: [],
    tagIds: [],
    source: 'all',
    searchQuery: '',
} as const;

describe('resolveSessionListViewEmptyState', () => {
    it.each([
        { coordinator: 'coordinator' as const },
        { statuses: ['failed' as const] },
        { coordinator: 'coordinator' as const, statuses: ['failed' as const] },
    ])('uses the existing filtered-empty recovery for work facets %j', (selection) => {
        const input = {
            visibleSessionCount: 0,
            filters: { ...globalDefaults, ...selection },
            defaults: globalDefaults,
            viewContext: { kind: 'global' as const },
            includeInactive: true,
            hasHiddenInactiveSessions: false,
        };
        expect(resolveSessionListViewEmptyState({ ...input, presentation: { kind: 'ready', complete: true } }))
            .toMatchObject({ mode: 'empty', titleKey: 'sessionsList.queryNoMatchesTitle', action: 'clear_filters' });
        expect(resolveSessionListViewEmptyState({ ...input, presentation: { kind: 'ready', complete: false } }))
            .toMatchObject({ mode: 'empty', titleKey: 'sessionsList.queryNoMatchesLoadedTitle', action: 'load_more' });
    });

    it('keeps an incomplete text-search zero explicitly limited to loaded Sessions', () => {
        expect(resolveSessionListViewEmptyState({
            presentation: { kind: 'ready', complete: false },
            visibleSessionCount: 0,
            filters: { ...globalDefaults, searchQuery: 'auth' },
            defaults: globalDefaults,
            viewContext: { kind: 'global' },
            includeInactive: true,
            hasHiddenInactiveSessions: false,
        })).toEqual({
            mode: 'empty',
            titleKey: 'sessionsList.queryNoMatchesLoadedTitle',
            descriptionKey: 'sessionsList.queryNoMatchesLoadedDescription',
            action: 'load_more',
        });
    });

    it('keeps an incomplete Source zero explicitly limited to loaded Sessions', () => {
        expect(resolveSessionListViewEmptyState({
            presentation: { kind: 'ready', complete: false },
            visibleSessionCount: 0,
            filters: { ...globalDefaults, source: 'direct' },
            defaults: globalDefaults,
            viewContext: { kind: 'global' },
            includeInactive: true,
            hasHiddenInactiveSessions: false,
        })).toEqual({
            mode: 'empty',
            titleKey: 'sessionsList.queryNoMatchesLoadedTitle',
            descriptionKey: 'sessionsList.queryNoMatchesLoadedDescription',
            action: 'load_more',
        });
    });

    it('treats a complete filtered zero as authoritative and clearable', () => {
        expect(resolveSessionListViewEmptyState({
            presentation: { kind: 'ready', complete: true },
            visibleSessionCount: 0,
            filters: { ...globalDefaults, tagIds: [{ serverId: 'home-a', tagId: 'urgent' }] },
            defaults: globalDefaults,
            viewContext: { kind: 'global' },
            includeInactive: true,
            hasHiddenInactiveSessions: false,
        })).toEqual({
            mode: 'empty',
            titleKey: 'sessionsList.queryNoMatchesTitle',
            descriptionKey: 'sessionsList.queryNoMatchesDescription',
            action: 'clear_filters',
        });
    });

    it('keeps the personal-scope recovery inside Team Sessions', () => {
        const teamDefaults = {
            ...createSessionListViewFilterDefaults(),
            scope: 'all_accessible',
            attention: 'any',
            homeServerIds: ['home-a'],
            audiences: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a' }],
            tagIds: [],
            source: 'all',
            searchQuery: '',
        } as const;

        // A personal scope inside a Team is not evidence that the Team is empty,
        // so the scope answer and its Browse-all recovery must survive.
        expect(resolveSessionListViewEmptyState({
            presentation: { kind: 'ready', complete: true },
            visibleSessionCount: 0,
            filters: { ...teamDefaults, scope: 'assigned_to_me' },
            defaults: teamDefaults,
            viewContext: { kind: 'team', team: { serverId: 'home-a', teamId: 'team-a' } },
            includeInactive: true,
            hasHiddenInactiveSessions: false,
        })).toMatchObject({
            mode: 'empty',
            titleKey: 'sessionsList.queryAssignedEmptyTitle',
            action: 'browse_all_accessible',
        });
    });

    it('distinguishes Team and personal-scope authoritative zeros', () => {
        const teamDefaults = {
            ...createSessionListViewFilterDefaults(),
            scope: 'all_accessible',
            attention: 'any',
            homeServerIds: ['home-a'],
            audiences: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a' }],
            tagIds: [],
            source: 'all',
            searchQuery: '',
        } as const;

        expect(resolveSessionListViewEmptyState({
            presentation: { kind: 'ready', complete: true },
            visibleSessionCount: 0,
            filters: teamDefaults,
            defaults: teamDefaults,
            viewContext: { kind: 'team', team: { serverId: 'home-a', teamId: 'team-a' } },
            includeInactive: true,
            hasHiddenInactiveSessions: false,
        })).toMatchObject({
            mode: 'empty',
            titleKey: 'sessionsList.queryTeamEmptyTitle',
            action: null,
        });

        expect(resolveSessionListViewEmptyState({
            presentation: { kind: 'ready', complete: true },
            visibleSessionCount: 0,
            filters: globalDefaults,
            defaults: globalDefaults,
            viewContext: { kind: 'global' },
            includeInactive: true,
            hasHiddenInactiveSessions: false,
        })).toMatchObject({
            mode: 'empty',
            titleKey: 'sessionsList.queryMyWorkEmptyTitle',
            action: 'browse_all_accessible',
        });
    });

    it('retains rows through refresh/error and offers retry only for recoverable coverage', () => {
        expect(resolveSessionListViewEmptyState({
            presentation: { kind: 'refreshing', retainedRows: true },
            visibleSessionCount: 2,
            filters: globalDefaults,
            defaults: globalDefaults,
            viewContext: { kind: 'global' },
            includeInactive: true,
            hasHiddenInactiveSessions: false,
        })).toEqual({
            mode: 'status',
            titleKey: 'sessionsList.queryUpdatingTitle',
            descriptionKey: null,
            action: null,
        });

        expect(resolveSessionListViewEmptyState({
            presentation: { kind: 'error', retainedRows: true },
            visibleSessionCount: 2,
            filters: globalDefaults,
            defaults: globalDefaults,
            viewContext: { kind: 'global' },
            includeInactive: true,
            hasHiddenInactiveSessions: false,
        })).toEqual({
            mode: 'status',
            titleKey: 'sessionsList.queryRefreshFailedTitle',
            descriptionKey: 'sessionsList.queryRefreshFailedRetainedDescription',
            action: 'retry',
        });

        expect(resolveSessionListViewEmptyState({
            presentation: {
                kind: 'partial',
                unavailableHomes: [{ serverId: 'home-b', reason: 'unsupported' }],
            },
            visibleSessionCount: 0,
            filters: globalDefaults,
            defaults: globalDefaults,
            viewContext: { kind: 'global' },
            includeInactive: true,
            hasHiddenInactiveSessions: false,
        })).toMatchObject({
            mode: 'empty',
            titleKey: 'sessionsList.querySomeHomesUnavailableTitle',
            descriptionKey: 'sessionsList.querySomeHomesUnavailableDescription',
            // Not retryable, so the only honest way out of an unservable query is to clear it.
            action: 'clear_filters',
        });

        expect(resolveSessionListViewEmptyState({
            presentation: {
                kind: 'partial',
                unavailableHomes: [{ serverId: 'home-b', reason: 'unsupported' }],
            },
            visibleSessionCount: 3,
            filters: globalDefaults,
            defaults: globalDefaults,
            viewContext: { kind: 'global' },
            includeInactive: true,
            hasHiddenInactiveSessions: false,
        })).toMatchObject({
            mode: 'status',
            titleKey: 'sessionsList.querySomeHomesUnavailableTitle',
            action: null,
        });
    });

    it('offers Show inactive only when inactive Sessions are actually hidden', () => {
        const input = {
            presentation: { kind: 'ready', complete: true } as const,
            visibleSessionCount: 0,
            filters: globalDefaults,
            defaults: globalDefaults,
            viewContext: { kind: 'global' } as const,
            includeInactive: false,
        };

        expect(resolveSessionListViewEmptyState({
            ...input,
            hasHiddenInactiveSessions: false,
        })).toMatchObject({
            titleKey: 'sessionsList.queryMyWorkEmptyTitle',
            action: 'browse_all_accessible',
        });

        expect(resolveSessionListViewEmptyState({
            ...input,
            hasHiddenInactiveSessions: true,
        })).toMatchObject({
            titleKey: 'sessionsList.queryNoMatchesTitle',
            action: 'show_inactive',
        });
    });
});

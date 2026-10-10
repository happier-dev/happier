import { describe, expect, it } from 'vitest';
import type { TeamDirectorySourceSummaryV1 } from '@happier-dev/protocol/teams';

import { t } from '@/text';

import { directorySourcePresentationState, directorySourceRemovalBody } from './directoryAdministrationPresentation';

function source(overrides: Partial<TeamDirectorySourceSummaryV1>): TeamDirectorySourceSummaryV1 {
    return {
        v: 1,
        id: 'directory-1',
        teamId: 'team-1',
        kind: 'workos_directory',
        displayName: 'Acme directory',
        state: 'active',
        allowedActions: ['teams.directory.sources.sync', 'teams.directory.sources.pause', 'teams.directory.sources.remove'],
        sync: {
            mode: 'events_and_full',
            attempt: 'succeeded',
            freshness: 'fresh',
            lastAttemptAt: '2026-09-01T10:00:00Z',
            lastSuccessAt: '2026-09-01T10:00:00Z',
            lastFullReconcileAt: '2026-09-01T10:00:00Z',
            nextScheduledAt: null,
        },
        error: null,
        ...overrides,
    };
}

describe('directorySourcePresentationState', () => {
    it('presents the initializing lifecycle as setup, animating only while an attempt runs', () => {
        expect(directorySourcePresentationState(source({
            state: 'initializing',
            sync: { ...source({}).sync, attempt: 'never', freshness: 'never_synced' },
        }))).toBe('initializing');
        expect(directorySourcePresentationState(source({
            state: 'initializing',
            sync: { ...source({}).sync, attempt: 'syncing', freshness: 'never_synced' },
        }))).toBe('syncing');
    });

    it('never reads Active for a failed attempt, a stale source, or one that has not synced', () => {
        // The server projects three facets on purpose. A stalled import that
        // timed out is a failed attempt, not a permanent spinner; a source whose
        // worker has not succeeded in twice its target window is stale, not
        // active; and a source with no success yet has nothing to be active on.
        expect(directorySourcePresentationState(source({
            sync: { ...source({}).sync, attempt: 'failed', freshness: 'stale' },
        }))).toBe('failed');
        expect(directorySourcePresentationState(source({
            error: { code: 'directory_snapshot_incomplete', retryable: true },
        }))).toBe('failed');
        expect(directorySourcePresentationState(source({
            sync: { ...source({}).sync, attempt: 'succeeded', freshness: 'stale' },
        }))).toBe('stale');
        expect(directorySourcePresentationState(source({
            sync: { ...source({}).sync, attempt: 'never', freshness: 'never_synced', lastSuccessAt: null },
        }))).toBe('never_synced');
        expect(directorySourcePresentationState(source({}))).toBe('active');
        expect(directorySourcePresentationState(source({
            sync: { ...source({}).sync, attempt: 'syncing', freshness: 'stale' },
        }))).toBe('syncing');
    });

    it('keeps paused and needs-attention lifecycle states ahead of an old attempt value', () => {
        expect(directorySourcePresentationState(source({
            state: 'paused',
            sync: { ...source({}).sync, attempt: 'succeeded' },
        }))).toBe('paused');
        expect(directorySourcePresentationState(source({
            state: 'needs_attention',
            sync: { ...source({}).sync, attempt: 'failed' },
        }))).toBe('needs_attention');
    });
});

describe('directorySourceRemovalBody', () => {
    const impact = (overrides: Partial<Parameters<typeof directorySourceRemovalBody>[0]>) => ({
        teamMembershipsRemoved: 0,
        groupMembershipsRemoved: 0,
        groupContributionsRemoved: 0,
        directoryCreatedGroupsRetained: 0,
        nativeMembershipsPreserved: 0,
        nativeGroupContributionsPreserved: 0,
        ...overrides,
    });

    it('states each consequence only when it happens, and always what is kept', () => {
        const body = directorySourceRemovalBody(impact({ teamMembershipsRemoved: 3, groupContributionsRemoved: 9 }));
        expect(body.split('\n')).toEqual([
            t('teams.authentication.directory.actions.removeMembers', { count: 3 }),
            t('teams.authentication.directory.actions.removeKept'),
        ]);
        expect(directorySourceRemovalBody(impact({})).split('\n')).toEqual([
            t('teams.authentication.directory.actions.removeNothing'),
            t('teams.authentication.directory.actions.removeKept'),
        ]);
    });
});

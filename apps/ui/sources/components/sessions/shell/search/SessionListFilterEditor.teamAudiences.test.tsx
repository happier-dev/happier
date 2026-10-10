import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    NO_TEAM_CAPABILITIES_V1,
    NO_TEAM_GROUP_CAPABILITIES_V1,
    teamGroupsQueryKeyV1,
    type TeamGroupV1,
    type TeamSummaryV1,
} from '@happier-dev/protocol/teams';

const serverFetchMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', () => ({ serverFetch: serverFetchMock }));
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchMock,
}));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal: importOriginal as <T = typeof import('@/auth/storage/tokenStorage')>() => Promise<T>,
        tokenStorage: { getCredentialsForServerUrl: getCredentialsForServerUrlMock },
    });
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ renderItems: true }).module;
});

import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';

import { createDeferred, createRootLayoutFeaturesResponse, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    primeServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { resetTeamsDirectoryEngineForTests } from '@/sync/engine/teams/teamsDirectoryEngine';
import { resetTeamActionClientForTests } from '@/sync/ops/teams/teamActionClient';
import { applyTeamGroupsPage, invalidateTeamGroupsForTeam, resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';

import { SessionListFilterEditor } from './SessionListFilterEditor';
import {
    buildSessionListFilterQueryHomes,
    createSessionListViewFilterDefaults,
    resolveSessionListViewContextDefaults,
    type SessionListViewFilters,
} from './sessionListViewFilters';
import { clearSessionListViewFilterRetentionForTests, useSessionListViewFilters } from './useSessionListViewFilters';

const labels = {
    search: 'Search filters', show: 'Show', myWork: 'My work', assignedToMe: 'Assigned to me',
    scope: 'Scope', sessions: 'Sessions', runs: 'Runs', both: 'Both', startedBy: 'Started by',
    startedByYou: 'You', startedByTriggers: 'Triggers', startedByAgents: 'Agents',
    runsNeedingYouAlwaysShow: 'Runs that need you always show',
    following: 'Following', involvingMe: 'Involving me', allAccessible: 'All accessible',
    attention: 'Attention', anyAttention: 'Any', needsMyAttention: 'Only sessions that need me',
    inactiveSessions: 'Inactive sessions', showInactive: 'Show', hideInactive: 'Hide', homes: 'Homes',
    sharedWith: 'Shared with', outsideTeams: 'Personal & direct', tags: 'Tags', source: 'Source',
    allSources: 'All', persistedSource: 'Saved in Happier', directSource: 'External', noOptions: 'No options',
    clear: 'Reset', done: 'Done', title: 'Session filters',
    needsMeOnly: 'Needs me only', needsMeOnlyDescription: 'Sessions waiting on you',
    moreTags: (count: number) => `+ ${count} more`,
    resultCount: (count: number) => `${count} sessions`,
} as const;

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

function team(): TeamSummaryV1 {
    return {
        id: 'team-1',
        name: 'Acme',
        description: null,
        logo: null,
        archivedAt: null,
        recovery: null,
        policy: {
            v: 1,
            sessionCreationPolicy: 'team_default',
            externalSharingPolicy: 'allowed',
            defaultSessionHistoryAccess: 'from_membership',
            admissionMode: 'invite_only',
            authenticationPolicy: null,
            authenticationPolicyStatus: 'available',
        },
        viewerRole: 'member',
        capabilities: NO_TEAM_CAPABILITIES_V1,
        admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
        counts: null,
    };
}

function teamWithId(id: string, name: string): TeamSummaryV1 {
    return { ...team(), id, name };
}

function group(): TeamGroupV1 {
    return {
        v: 1,
        id: 'group-1',
        teamId: 'team-1',
        name: 'Developers',
        description: null,
        archivedAt: null,
        memberCount: 2,
        management: { kind: 'native' },
        capabilities: NO_TEAM_GROUP_CAPABILITIES_V1,
    };
}

async function addTeamsHome(): Promise<string> {
    const serverId = (await upsertServerProfile({ serverUrl: 'https://home-a.example', name: 'Home A' })).id;
    await setActiveServerId(serverId, { scope: 'device' });
    const features = createRootLayoutFeaturesResponse();
    (features.features as Record<string, unknown>).teams = { enabled: false };
    expect(tryWriteServerEnabledBitInPlace(features, 'teams', true)).toBe(true);
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    return serverId;
}

beforeEach(() => {
    serverFetchMock.mockReset();
    runtimeFetchMock.mockReset();
    getCredentialsForServerUrlMock.mockReset();
    getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account') });
    resetServerFeaturesClientForTests();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
});

afterEach(async () => {
    await standardCleanup();
    clearSessionListViewFilterRetentionForTests();
    resetTeamActionClientForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    resetServerFeaturesClientForTests();
    vi.clearAllMocks();
});

describe('SessionListFilterEditor Team audiences', () => {
    it('reports a selected Team deletion only after the complete directory omits it', async () => {
        const serverId = await addTeamsHome();
        runtimeFetchMock.mockImplementation(async (request: Readonly<{ url?: string }>) => {
            if (request.url?.endsWith('/v1/teams/list')) {
                return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
            }
            throw new Error(`Unexpected request: ${request.url ?? 'unknown'}`);
        });
        const removeAuthoritativelyDeletedSelections = vi.fn();
        const filters = createSessionListViewFilterDefaults({
            homeServerIds: [serverId],
            audiences: [{ serverId, kind: 'team', teamId: 'deleted-team' }],
        });

        await renderScreen(
            <SessionListFilterEditor
                filters={filters}
                includeInactive
                queryEnabled
                followingAvailable
                sourceAvailable={false}
                homes={[{ serverId, label: 'Home A' }]}
                audiences={[]}
                tags={[]}
                teamAudienceContext={{ kind: 'global' }}
                labels={labels}
                updateFilters={vi.fn()}
                removeAuthoritativelyDeletedSelections={removeAuthoritativelyDeletedSelections}
                setIncludeInactive={vi.fn()}
                setSource={vi.fn()}
                resetFilters={vi.fn()}
                disableTransitions
            />,
        );

        await vi.waitFor(() => {
            expect(removeAuthoritativelyDeletedSelections).toHaveBeenCalledWith({
                deletedAudiences: [{ serverId, kind: 'team', teamId: 'deleted-team' }],
            });
        });
    });

    it('retains a selected Group until its stale roster refresh answers', async () => {
        const serverId = await addTeamsHome();
        const scope = { serverId, accountId: 'account' };
        const address = { serverId, teamId: 'team-1' };
        applyTeamGroupsPage({
            scope,
            address,
            queryKey: teamGroupsQueryKeyV1({ v: 1, teamId: 'team-1', archived: 'active' }),
            items: [],
            nextCursor: null,
            observedAt: 1,
        });
        invalidateTeamGroupsForTeam(scope, address);
        const pendingGroups = createDeferred<Response>();
        runtimeFetchMock.mockImplementation(async (request: Readonly<{ url?: string }>) => {
            if (request.url?.endsWith('/v1/teams/list')) {
                return new Response(JSON.stringify({ items: [team()], nextCursor: null }), { status: 200 });
            }
            if (request.url?.endsWith('/v1/teams/groups/list')) return pendingGroups.promise;
            throw new Error(`Unexpected request: ${request.url ?? 'unknown'}`);
        });
        const viewContext = { kind: 'team' as const, team: address };
        const context = resolveSessionListViewContextDefaults(viewContext, [serverId], 'all');
        const selectedGroup = { serverId, kind: 'group' as const, teamId: 'team-1', groupId: 'group-1' };
        let currentFilters: SessionListViewFilters = { ...context.defaults, audiences: [selectedGroup] };
        const defaults = currentFilters;
        function Harness() {
            const retained = useSessionListViewFilters({
                contextKey: context.contextKey,
                defaults,
                viewContext,
                accountScopeResolutions: new Map([[serverId, { kind: 'bound', scope }]]),
            });
            currentFilters = retained.filters;
            return <SessionListFilterEditor
                filters={retained.filters}
                includeInactive
                queryEnabled
                followingAvailable
                sourceAvailable={false}
                homes={[{ serverId, label: 'Home A' }]}
                audiences={[]}
                tags={[]}
                teamAudienceContext={{ kind: 'team', team: address }}
                labels={labels}
                updateFilters={retained.updateFilters}
                removeAuthoritativelyDeletedSelections={retained.removeAuthoritativelyDeletedSelections}
                setIncludeInactive={vi.fn()}
                setSource={vi.fn()}
                resetFilters={retained.resetFilters}
                disableTransitions
            />;
        }
        const screen = await renderScreen(<Harness />);
        // The audiences facet opens in place of the panel, as its own list.
        await screen.pressByTestIdAsync('session-list-filter-audiences');
        await vi.waitFor(() => {
            expect(runtimeFetchMock.mock.calls.some((call) => call[0]?.url?.endsWith('/groups/list'))).toBe(true);
        });
        const groupOptionId = `audience:${JSON.stringify([serverId, 'group', 'team-1', 'group-1'])}`;
        expect(screen.findByTestId(`session-list-filter-editor:session-list-filters:option:${groupOptionId}`)).not.toBeNull();
        expect(currentFilters.audiences).toEqual([selectedGroup]);

        await act(async () => {
            pendingGroups.resolve(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
        });
        await vi.waitFor(() => {
            expect(buildSessionListFilterQueryHomes(currentFilters, {
                storage: 'active', includeInactive: true, mountedHomeServerIds: [serverId],
            })[0].query.audiences).toEqual([{ kind: 'team', teamId: 'team-1' }]);
        });
    });

    it('reads canonical Teams, then lazily reads and selects a qualified Group through its Team step', async () => {
        const serverId = await addTeamsHome();
        runtimeFetchMock.mockImplementation(async (request: Readonly<{ url?: string }>) => {
            if (request.url?.endsWith('/v1/teams/list')) {
                return new Response(JSON.stringify({ items: [team()], nextCursor: null }), { status: 200 });
            }
            if (request.url?.endsWith('/v1/teams/groups/list')) {
                return new Response(JSON.stringify({ items: [group()], nextCursor: null }), { status: 200 });
            }
            throw new Error(`Unexpected request: ${request.url ?? 'unknown'}`);
        });
        const updateFilters = vi.fn();
        const filters = createSessionListViewFilterDefaults({ homeServerIds: [serverId] });
        const screen = await renderScreen(
            <SessionListFilterEditor
                filters={filters}
                includeInactive
                queryEnabled
                followingAvailable
                sourceAvailable={false}
                homes={[{ serverId, label: 'Home A' }]}
                audiences={[{ serverId, kind: 'outside_teams', label: 'Personal & direct' }]}
                tags={[]}
                teamAudienceContext={{ kind: 'global' }}
                labels={labels}
                updateFilters={updateFilters}
                removeAuthoritativelyDeletedSelections={vi.fn()}
                setIncludeInactive={vi.fn()}
                setSource={vi.fn()}
                resetFilters={vi.fn()}
                disableTransitions
            />,
        );
        // The audiences facet opens in place of the panel, as its own list.
        await screen.pressByTestIdAsync('session-list-filter-audiences');

        const teamStepId = `session-list-audience-team:${JSON.stringify([serverId, 'team', 'team-1'])}`;
        await vi.waitFor(() => {
            expect(screen.findByTestId(`session-list-filter-editor:session-list-filters:option:${teamStepId}`))
                .not.toBeNull();
        });
        expect(runtimeFetchMock.mock.calls.some((call) => call[0]?.url?.endsWith('/groups/list'))).toBe(false);

        await screen.pressByTestIdAsync(
            `session-list-filter-editor:session-list-filters:option:${teamStepId}`,
        );
        const groupOptionId = `audience:${JSON.stringify([serverId, 'group', 'team-1', 'group-1'])}`;
        await vi.waitFor(() => {
            expect(screen.findByTestId(`session-list-filter-editor:${teamStepId}:option:${groupOptionId}`))
                .not.toBeNull();
        });

        screen.pressByTestId(`session-list-filter-editor:${teamStepId}:option:${groupOptionId}`);
        expect(updateFilters).toHaveBeenCalledWith(expect.objectContaining({
            audiences: [{ serverId, kind: 'group', teamId: 'team-1', groupId: 'group-1' }],
        }));
    });

    it('does not activate either producer when filtered listing is unsupported', async () => {
        const serverId = await addTeamsHome();
        await renderScreen(
            <SessionListFilterEditor
                filters={createSessionListViewFilterDefaults({ homeServerIds: [serverId] })}
                includeInactive
                queryEnabled={false}
                followingAvailable={false}
                sourceAvailable={false}
                homes={[{ serverId, label: 'Home A' }]}
                audiences={[]}
                tags={[]}
                teamAudienceContext={{ kind: 'global' }}
                labels={labels}
                updateFilters={vi.fn()}
                removeAuthoritativelyDeletedSelections={vi.fn()}
                setIncludeInactive={vi.fn()}
                setSource={vi.fn()}
                resetFilters={vi.fn()}
                disableTransitions
            />,
        );

        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('keeps a selected Group and its parent Team visible when the Home cannot answer', async () => {
        const serverId = await addTeamsHome();
        runtimeFetchMock.mockRejectedValue(new Error('offline'));
        const updateFilters = vi.fn();
        const removeAuthoritativelyDeletedSelections = vi.fn();
        const filters = createSessionListViewFilterDefaults({
            homeServerIds: [serverId],
            audiences: [{ serverId, kind: 'group', teamId: 'team-1', groupId: 'group-1' }],
        });
        const screen = await renderScreen(
            <SessionListFilterEditor
                filters={filters}
                includeInactive
                queryEnabled
                followingAvailable
                sourceAvailable={false}
                homes={[{ serverId, label: 'Home A' }]}
                audiences={[{ serverId, kind: 'outside_teams', label: 'Personal & direct' }]}
                tags={[]}
                teamAudienceContext={{ kind: 'global' }}
                labels={labels}
                updateFilters={updateFilters}
                removeAuthoritativelyDeletedSelections={removeAuthoritativelyDeletedSelections}
                setIncludeInactive={vi.fn()}
                setSource={vi.fn()}
                resetFilters={vi.fn()}
                disableTransitions
            />,
        );
        // The audiences facet opens in place of the panel, as its own list.
        await screen.pressByTestIdAsync('session-list-filter-audiences');

        const teamStepId = `session-list-audience-team:${JSON.stringify([serverId, 'team', 'team-1'])}`;
        await vi.waitFor(() => {
            expect(screen.findByTestId(`session-list-filter-editor:session-list-filters:option:${teamStepId}`))
                .not.toBeNull();
        });
        await screen.pressByTestIdAsync(
            `session-list-filter-editor:session-list-filters:option:${teamStepId}`,
        );
        const groupOptionId = `audience:${JSON.stringify([serverId, 'group', 'team-1', 'group-1'])}`;
        await vi.waitFor(() => {
            expect(screen.findByTestId(`session-list-filter-editor:${teamStepId}:option:${groupOptionId}`))
                .not.toBeNull();
        });
        expect(removeAuthoritativelyDeletedSelections).not.toHaveBeenCalled();
    });

    it('prunes an invisibly retained Group only after its Team roster answers completely without it', async () => {
        const serverId = await addTeamsHome();
        runtimeFetchMock.mockImplementation(async (request: Readonly<{ url?: string }>) => {
            if (request.url?.endsWith('/v1/teams/list')) {
                return new Response(JSON.stringify({ items: [team()], nextCursor: null }), { status: 200 });
            }
            if (request.url?.endsWith('/v1/teams/groups/list')) {
                return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
            }
            throw new Error(`Unexpected request: ${request.url ?? 'unknown'}`);
        });
        const updateFilters = vi.fn();
        const removeAuthoritativelyDeletedSelections = vi.fn();
        const filters = createSessionListViewFilterDefaults({
            homeServerIds: [serverId],
            audiences: [{ serverId, kind: 'group', teamId: 'team-1', groupId: 'deleted-group' }],
        });
        await renderScreen(
            <SessionListFilterEditor
                filters={filters}
                includeInactive
                queryEnabled
                followingAvailable
                sourceAvailable={false}
                homes={[{ serverId, label: 'Home A' }]}
                audiences={[{ serverId, kind: 'outside_teams', label: 'Personal & direct' }]}
                tags={[]}
                teamAudienceContext={{ kind: 'global' }}
                labels={labels}
                updateFilters={updateFilters}
                removeAuthoritativelyDeletedSelections={removeAuthoritativelyDeletedSelections}
                setIncludeInactive={vi.fn()}
                setSource={vi.fn()}
                resetFilters={vi.fn()}
                disableTransitions
            />,
        );

        await vi.waitFor(() => {
            expect(removeAuthoritativelyDeletedSelections).toHaveBeenCalledWith({
                deletedAudiences: [{ serverId, kind: 'group', teamId: 'team-1', groupId: 'deleted-group' }],
            });
        });
    });

    it('uses already-complete Group snapshots for every selected Team without mounting another observer', async () => {
        const serverId = await addTeamsHome();
        const scope = { serverId, accountId: 'account' };
        for (const teamId of ['team-1', 'team-2']) {
            applyTeamGroupsPage({
                scope,
                address: { serverId, teamId },
                queryKey: teamGroupsQueryKeyV1({ v: 1, teamId, archived: 'active' }),
                items: [],
                nextCursor: null,
                observedAt: 1,
            });
        }
        runtimeFetchMock.mockImplementation(async (request: Readonly<{ url?: string }>) => {
            if (request.url?.endsWith('/v1/teams/list')) {
                return new Response(JSON.stringify({
                    items: [teamWithId('team-1', 'Acme'), teamWithId('team-2', 'Beta')],
                    nextCursor: null,
                }), { status: 200 });
            }
            if (request.url?.endsWith('/v1/teams/groups/list')) {
                return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
            }
            throw new Error(`Unexpected request: ${request.url ?? 'unknown'}`);
        });
        const removeAuthoritativelyDeletedSelections = vi.fn();
        const filters = createSessionListViewFilterDefaults({
            homeServerIds: [serverId],
            audiences: [
                { serverId, kind: 'group', teamId: 'team-1', groupId: 'removed-a' },
                { serverId, kind: 'group', teamId: 'team-2', groupId: 'removed-b' },
            ],
        });

        await renderScreen(
            <SessionListFilterEditor
                filters={filters}
                includeInactive
                queryEnabled
                followingAvailable
                sourceAvailable={false}
                homes={[{ serverId, label: 'Home A' }]}
                audiences={[]}
                tags={[]}
                teamAudienceContext={{ kind: 'global' }}
                labels={labels}
                updateFilters={vi.fn()}
                removeAuthoritativelyDeletedSelections={removeAuthoritativelyDeletedSelections}
                setIncludeInactive={vi.fn()}
                setSource={vi.fn()}
                resetFilters={vi.fn()}
                disableTransitions
            />,
        );

        await vi.waitFor(() => {
            expect(removeAuthoritativelyDeletedSelections).toHaveBeenCalledWith({
                deletedAudiences: [
                    { serverId, kind: 'group', teamId: 'team-1', groupId: 'removed-a' },
                    { serverId, kind: 'group', teamId: 'team-2', groupId: 'removed-b' },
                ],
            });
        });
        expect(runtimeFetchMock.mock.calls.filter((call) => call[0]?.url?.endsWith('/groups/list'))).toHaveLength(0);
    });

    it('presents Team directory loading and explicit continuation through SelectionList pagination', async () => {
        const serverId = await addTeamsHome();
        const firstPage = createDeferred<Response>();
        let teamRequests = 0;
        runtimeFetchMock.mockImplementation(async (request: Readonly<{ url?: string }>) => {
            if (!request.url?.includes('/v1/teams/list')) {
                throw new Error(`Unexpected request: ${request.url ?? 'unknown'}`);
            }
            teamRequests += 1;
            if (teamRequests === 1) return firstPage.promise;
            return new Response(JSON.stringify({
                items: [teamWithId('team-2', 'Beta')],
                nextCursor: null,
            }), { status: 200 });
        });
        const screen = await renderScreen(
            <SessionListFilterEditor
                filters={createSessionListViewFilterDefaults({ homeServerIds: [serverId] })}
                includeInactive
                queryEnabled
                followingAvailable
                sourceAvailable={false}
                homes={[{ serverId, label: 'Home A' }]}
                audiences={[]}
                tags={[]}
                teamAudienceContext={{ kind: 'global' }}
                labels={labels}
                updateFilters={vi.fn()}
                removeAuthoritativelyDeletedSelections={vi.fn()}
                setIncludeInactive={vi.fn()}
                setSource={vi.fn()}
                resetFilters={vi.fn()}
                disableTransitions
            />,
        );
        // The audiences facet opens in place of the panel, as its own list.
        await screen.pressByTestIdAsync('session-list-filter-audiences');

        await vi.waitFor(() => {
            expect(screen.findByTestId('session-list-filter-editor:pagination:loading')).not.toBeNull();
        });
        await act(async () => {
            firstPage.resolve(new Response(JSON.stringify({
                items: [teamWithId('team-1', 'Acme')],
                nextCursor: 'next-team-page',
            }), { status: 200 }));
        });
        await vi.waitFor(() => {
            expect(screen.findByTestId('session-list-filter-editor:pagination:more')).not.toBeNull();
        });
        await screen.pressByTestIdAsync('session-list-filter-editor:pagination:more');
        await vi.waitFor(() => {
            const teamStepId = `session-list-audience-team:${JSON.stringify([serverId, 'team', 'team-2'])}`;
            expect(screen.findByTestId(`session-list-filter-editor:session-list-filters:option:${teamStepId}`)).not.toBeNull();
            expect(screen.findByTestId('session-list-filter-editor:pagination:end')).not.toBeNull();
        });
    });

    it('presents a retryable Group roster failure without discarding the Team filter surface', async () => {
        const serverId = await addTeamsHome();
        let groupRequests = 0;
        runtimeFetchMock.mockImplementation(async (request: Readonly<{ url?: string }>) => {
            if (request.url?.includes('/v1/teams/list')) {
                return new Response(JSON.stringify({ items: [team()], nextCursor: null }), { status: 200 });
            }
            if (request.url?.includes('/v1/teams/groups/list')) {
                groupRequests += 1;
                if (groupRequests === 1) throw new Error('offline');
                return new Response(JSON.stringify({ items: [group()], nextCursor: null }), { status: 200 });
            }
            throw new Error(`Unexpected request: ${request.url ?? 'unknown'}`);
        });
        const screen = await renderScreen(
            <SessionListFilterEditor
                filters={createSessionListViewFilterDefaults({ homeServerIds: [serverId] })}
                includeInactive
                queryEnabled
                followingAvailable
                sourceAvailable={false}
                homes={[{ serverId, label: 'Home A' }]}
                audiences={[]}
                tags={[]}
                teamAudienceContext={{ kind: 'team', team: { serverId, teamId: 'team-1' } }}
                labels={labels}
                updateFilters={vi.fn()}
                removeAuthoritativelyDeletedSelections={vi.fn()}
                setIncludeInactive={vi.fn()}
                setSource={vi.fn()}
                resetFilters={vi.fn()}
                disableTransitions
            />,
        );
        // The audiences facet opens in place of the panel, as its own list.
        await screen.pressByTestIdAsync('session-list-filter-audiences');

        await vi.waitFor(() => {
            expect(screen.findByTestId('session-list-filter-editor:pagination:error')).not.toBeNull();
            expect(screen.findByTestId('session-list-filter-editor:pagination:retry')).not.toBeNull();
        });
        await screen.pressByTestIdAsync('session-list-filter-editor:pagination:retry');
        const groupOptionId = `audience:${JSON.stringify([serverId, 'group', 'team-1', 'group-1'])}`;
        await vi.waitFor(() => {
            expect(screen.findByTestId(`session-list-filter-editor:session-list-filters:option:${groupOptionId}`)).not.toBeNull();
            expect(screen.findByTestId('session-list-filter-editor:pagination:end')).not.toBeNull();
        });
    });
});

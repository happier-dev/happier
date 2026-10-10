import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    NO_TEAM_GROUP_CAPABILITIES_V1,
    teamGroupsQueryKeyV1,
    type TeamGroupV1,
} from '@happier-dev/protocol/teams';

const serverFetchMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchMock,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchMock,
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit');
    return createTokenStorageModuleMock({
        importOriginal: importOriginal as <T = typeof import('@/auth/storage/tokenStorage')>() => Promise<T>,
        tokenStorage: { getCredentialsForServerUrl: getCredentialsForServerUrlMock },
    });
});

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createDeferred } from '@/dev/testkit';
import { createTeamAddress } from '@/sync/domains/teams/teamAddress';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    clearTeamsSnapshotsForServer,
    getTeamGroupSnapshot,
    getTeamGroupsSnapshot,
    resetTeamsSnapshotsForTests,
} from '@/sync/store/teams/teamsSnapshots';

import {
    loadMoreTeamGroups,
    observeTeamGroup,
    observeTeamGroups,
    refreshTeamGroups,
    resetTeamsDirectoryEngineForTests,
} from './teamsDirectoryEngine';

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

function group(id: string, name = `Group ${id}`): TeamGroupV1 {
    return {
        v: 1,
        id,
        teamId: 'team-1',
        name,
        description: null,
        archivedAt: null,
        memberCount: 0,
        management: { kind: 'native' },
        capabilities: NO_TEAM_GROUP_CAPABILITIES_V1,
    };
}

function page(items: TeamGroupV1[], nextCursor: string | null): Response {
    return new Response(JSON.stringify({ items, nextCursor }), { status: 200 });
}

async function addHome(name: string, serverUrl: string): Promise<string> {
    return (await upsertServerProfile({ serverUrl, name })).id;
}

const ACTIVE = 'active' as const;

function groupsQueryKey(teamId: string): string {
    return teamGroupsQueryKeyV1({ v: 1, teamId, archived: ACTIVE });
}

beforeEach(() => {
    serverFetchMock.mockReset();
    runtimeFetchMock.mockReset();
    getCredentialsForServerUrlMock.mockReset();
    getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account') });
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
});

afterEach(() => {
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    vi.clearAllMocks();
});

describe('Team Group projections', () => {
    it('keeps identically identified Groups apart across two Homes and two Accounts', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        const homeB = await addHome('Home B', 'https://home-b.example');
        await setActiveServerId(homeA, { scope: 'device' });

        runtimeFetchMock.mockImplementation(async (input: { url: string }) => (
            String(input.url).startsWith('https://home-a.example')
                ? page([group('g1', 'A group')], null)
                : page([group('g1', 'B group')], null)
        ));

        const scopeA = createServerAccountScope(homeA, 'account')!;
        const scopeB = createServerAccountScope(homeB, 'account')!;
        const addressA = createTeamAddress(homeA, 'team-1')!;
        const addressB = createTeamAddress(homeB, 'team-1')!;

        const releaseA = observeTeamGroups(scopeA, addressA, ACTIVE);
        const releaseB = observeTeamGroups(scopeB, addressB, ACTIVE);
        await vi.waitFor(() => {
            expect(getTeamGroupsSnapshot(scopeA, addressA, groupsQueryKey('team-1'))?.data).toBeTruthy();
            expect(getTeamGroupsSnapshot(scopeB, addressB, groupsQueryKey('team-1'))?.data).toBeTruthy();
        });

        expect(getTeamGroupsSnapshot(scopeA, addressA, groupsQueryKey('team-1'))?.data?.[0]?.name)
            .toBe('A group');
        expect(getTeamGroupsSnapshot(scopeB, addressB, groupsQueryKey('team-1'))?.data?.[0]?.name)
            .toBe('B group');

        // A second Account on the same Home reads its own rows, never the first's.
        const otherAccount = createServerAccountScope(homeA, 'other-account')!;
        expect(getTeamGroupsSnapshot(otherAccount, addressA, groupsQueryKey('team-1'))).toBeNull();

        releaseA();
        releaseB();
    });

    it('refreshes after a rename and reuses the objects of Groups that did not change', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const scope = createServerAccountScope(homeA, 'account')!;
        const address = createTeamAddress(homeA, 'team-1')!;
        const key = groupsQueryKey('team-1');

        runtimeFetchMock.mockImplementation(async () => page([group('g1'), group('g2')], null));
        const release = observeTeamGroups(scope, address, ACTIVE);
        await vi.waitFor(() => expect(getTeamGroupsSnapshot(scope, address, key)?.data).toHaveLength(2));
        const before = getTeamGroupsSnapshot(scope, address, key)!.data!;

        runtimeFetchMock.mockImplementation(async () => page([group('g1', 'Renamed'), group('g2')], null));
        await refreshTeamGroups(scope, address, ACTIVE);

        const after = getTeamGroupsSnapshot(scope, address, key)!.data!;
        expect(after[0]?.name).toBe('Renamed');
        // The untouched Group keeps its identity so an unrelated row cannot
        // re-render a long Groups list.
        expect(after[1]).toBe(before[1]);
        expect(after[0]).not.toBe(before[0]);
        release();
    });

    it('marks Group rows stale on the Account-change wake without refetching per Group', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const scope = createServerAccountScope(homeA, 'account')!;
        const address = createTeamAddress(homeA, 'team-1')!;
        const key = groupsQueryKey('team-1');

        runtimeFetchMock.mockImplementation(async () => page([group('g1')], null));
        const release = observeTeamGroups(scope, address, ACTIVE);
        await vi.waitFor(() => expect(getTeamGroupsSnapshot(scope, address, key)?.status).toBe('ready'));

        const requestsBefore = runtimeFetchMock.mock.calls.length;
        publishHomeAccountChange(homeA);
        await vi.waitFor(() => expect(runtimeFetchMock.mock.calls.length).toBeGreaterThan(requestsBefore));
        // The wake re-reads the one Groups sequence, not one request per Group.
        expect(runtimeFetchMock.mock.calls.length).toBe(requestsBefore + 1);
        release();
    });

    it('retires Group rows with the credential scope that owns them', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const scope = createServerAccountScope(homeA, 'account')!;
        const address = createTeamAddress(homeA, 'team-1')!;
        const key = groupsQueryKey('team-1');

        runtimeFetchMock.mockImplementation(async () => page([group('g1')], null));
        const release = observeTeamGroups(scope, address, ACTIVE);
        await vi.waitFor(() => expect(getTeamGroupsSnapshot(scope, address, key)?.data).toBeTruthy());

        clearTeamsSnapshotsForServer(homeA);
        expect(getTeamGroupsSnapshot(scope, address, key)).toBeNull();
        expect(getTeamGroupSnapshot(scope, address, 'g1')).toBeNull();
        release();
    });

    it('atomically revalidates the loaded Groups range through fresh cursors and withdraws removed rows', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const scope = createServerAccountScope(homeA, 'account')!;
        const address = createTeamAddress(homeA, 'team-1')!;
        const key = groupsQueryKey('team-1');

        runtimeFetchMock.mockResolvedValueOnce(page([group('g1'), group('removed')], 'cursor-1'));
        const release = observeTeamGroups(scope, address, ACTIVE);
        await vi.waitFor(() => expect(getTeamGroupsSnapshot(scope, address, key)?.nextCursor).toBe('cursor-1'));

        runtimeFetchMock.mockResolvedValueOnce(page([group('g2')], 'cursor-2'));
        await loadMoreTeamGroups(scope, address, ACTIVE);
        expect(getTeamGroupsSnapshot(scope, address, key)?.data?.map((row) => row.id))
            .toEqual(['g1', 'removed', 'g2']);

        const lastGood = getTeamGroupsSnapshot(scope, address, key)!.data!;
        const continuation = createDeferred<Response>();
        runtimeFetchMock
            .mockResolvedValueOnce(page([group('g1', 'Renamed')], 'fresh-1'))
            .mockReturnValueOnce(continuation.promise);
        const refresh = refreshTeamGroups(scope, address, ACTIVE);
        await vi.waitFor(() => expect(runtimeFetchMock).toHaveBeenCalledTimes(4));
        expect(getTeamGroupsSnapshot(scope, address, key)?.data).toBe(lastGood);
        expect(getTeamGroupsSnapshot(scope, address, key)?.status).toBe('refreshing');
        continuation.resolve(page([group('g2'), group('g3')], 'fresh-2'));
        await refresh;
        const moved = getTeamGroupsSnapshot(scope, address, key)!;
        expect(moved.nextCursor).toBe('fresh-2');
        expect(moved.data?.map((row) => row.id)).toEqual(['g1', 'g2', 'g3']);
        expect(moved.data?.[0]?.name).toBe('Renamed');
        expect(moved.data?.[1]).toBe(lastGood[2]);
        expect(runtimeFetchMock.mock.calls.map(([input]) => JSON.parse(input.init.body).cursor ?? null))
            .toEqual([null, 'cursor-1', null, 'fresh-1']);
        release();
    });

    it.each([
        { status: 503, retained: true },
        { status: 403, retained: false },
    ])('handles a $status continuation refusal without publishing a partial Groups refresh', async ({ status, retained }) => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const scope = createServerAccountScope(homeA, 'account')!;
        const address = createTeamAddress(homeA, 'team-1')!;
        const key = groupsQueryKey('team-1');

        runtimeFetchMock.mockResolvedValueOnce(page([group('g1')], 'cursor-1'));
        const release = observeTeamGroups(scope, address, ACTIVE);
        await vi.waitFor(() => expect(getTeamGroupsSnapshot(scope, address, key)?.status).toBe('ready'));
        runtimeFetchMock.mockResolvedValueOnce(page([group('g2')], 'cursor-2'));
        await loadMoreTeamGroups(scope, address, ACTIVE);
        const lastGood = getTeamGroupsSnapshot(scope, address, key)!;

        runtimeFetchMock
            .mockResolvedValueOnce(page([group('g1', 'Renamed')], 'fresh-1'))
            .mockResolvedValueOnce(new Response('{}', { status }));
        await refreshTeamGroups(scope, address, ACTIVE);
        const failed = getTeamGroupsSnapshot(scope, address, key)!;
        expect(failed.status).toBe('error');
        expect(failed.data).toBe(retained ? lastGood.data : null);
        expect(failed.nextCursor).toBe(retained ? 'cursor-2' : null);
        expect(failed.stale).toBe(retained);
        expect(failed.error?.kind).toBe(retained ? 'unknown' : 'forbidden');
        release();
    });

    it('keeps the last known Groups visible and stale when a refresh fails', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const scope = createServerAccountScope(homeA, 'account')!;
        const address = createTeamAddress(homeA, 'team-1')!;
        const key = groupsQueryKey('team-1');

        runtimeFetchMock.mockImplementation(async () => page([group('g1')], null));
        const release = observeTeamGroups(scope, address, ACTIVE);
        await vi.waitFor(() => expect(getTeamGroupsSnapshot(scope, address, key)?.status).toBe('ready'));

        runtimeFetchMock.mockRejectedValue(new Error('network down'));
        await refreshTeamGroups(scope, address, ACTIVE);
        const failed = getTeamGroupsSnapshot(scope, address, key)!;
        expect(failed.status).toBe('error');
        expect(failed.data?.map((row) => row.id)).toEqual(['g1']);
        expect(failed.stale).toBe(true);
        release();
    });

    it('reads one Group detail under its exact Home, Account and Team address', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const scope = createServerAccountScope(homeA, 'account')!;
        const address = createTeamAddress(homeA, 'team-1')!;

        runtimeFetchMock.mockImplementation(async () => new Response(
            JSON.stringify(group('g1', 'Detail')),
            { status: 200 },
        ));
        const release = observeTeamGroup(scope, address, 'g1');
        await vi.waitFor(() => expect(getTeamGroupSnapshot(scope, address, 'g1')?.data?.name).toBe('Detail'));

        const otherHome = await addHome('Home B', 'https://home-b.example');
        const otherAddress = createTeamAddress(otherHome, 'team-1')!;
        const otherScope = createServerAccountScope(otherHome, 'account')!;
        expect(getTeamGroupSnapshot(otherScope, otherAddress, 'g1')).toBeNull();
        release();
    });
});

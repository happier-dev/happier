import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    NO_TEAM_CAPABILITIES_V1,
    teamDirectoryQueryKeyV1,
    type TeamSummaryV1,
    type TeamsListInputV1,
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
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal: importOriginal as <T = typeof import('@/auth/storage/tokenStorage')>() => Promise<T>,
        tokenStorage: { getCredentialsForServerUrl: getCredentialsForServerUrlMock },
    });
});

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    getTeamSnapshot,
    getTeamsDirectorySnapshot,
    resetTeamsSnapshotsForTests,
} from '@/sync/store/teams/teamsSnapshots';
import { createTeamAddress } from '@/sync/domains/teams/teamAddress';

import {
    loadMoreTeamsDirectory,
    observeTeam,
    observeTeamsDirectory,
    resetTeamsDirectoryEngineForTests,
} from './teamsDirectoryEngine';

const listInput: TeamsListInputV1 = { v: 1, scope: 'member', archived: 'active' };
const queryKey = teamDirectoryQueryKeyV1(listInput);

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

function team(id: string, name = `Team ${id}`): TeamSummaryV1 {
    return {
        id,
        name,
        description: null,
        logo: null,
        archivedAt: null,
        recovery: null,
        policy: {
            v: 1,
            sessionCreationPolicy: 'team_default',
            externalSharingPolicy: 'team_admins_only',
            defaultSessionHistoryAccess: 'from_membership',
            admissionMode: 'invite_only',
            authenticationPolicy: null,
        },
        viewerRole: 'member',
        capabilities: NO_TEAM_CAPABILITIES_V1,
        admission: {
            historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' },
        },
        counts: null,
    };
}

function page(items: TeamSummaryV1[], nextCursor: string | null): Response {
    return new Response(JSON.stringify({ items, nextCursor }), { status: 200 });
}

function requestedBodies(): TeamsListInputV1[] {
    return runtimeFetchMock.mock.calls.map(([input]) => JSON.parse(String(input?.init?.body ?? '{}')));
}

async function addHome(name: string, serverUrl: string): Promise<string> {
    return (await upsertServerProfile({ serverUrl, name })).id;
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

describe('teamsDirectoryEngine', () => {
    it('loads one Team through teams.get under its exact Home and Account address', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify(team('t1')), { status: 200 }));
        const scope = createServerAccountScope(homeA, 'account')!;
        const address = createTeamAddress(homeA, 't1')!;

        const release = observeTeam(scope, address);
        await vi.waitFor(() => {
            expect(getTeamSnapshot(scope, address)?.status).toBe('ready');
        });

        expect(getTeamSnapshot(scope, address)?.data?.id).toBe('t1');
        expect(runtimeFetchMock.mock.calls[0]?.[0]?.url).toBe('https://home-a.example/v1/teams/get');
        expect(JSON.parse(String(runtimeFetchMock.mock.calls[0]?.[0]?.init?.body))).toEqual({ v: 1, teamId: 't1' });
        release();
    });

    it('retains the last Team projection when an exact-Team refresh becomes unreachable', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(team('t1')), { status: 200 }));
        const scope = createServerAccountScope(homeA, 'account')!;
        const address = createTeamAddress(homeA, 't1')!;

        const release = observeTeam(scope, address);
        await vi.waitFor(() => expect(getTeamSnapshot(scope, address)?.status).toBe('ready'));

        runtimeFetchMock.mockRejectedValue(new Error('network down'));
        publishHomeAccountChange(homeA);

        await vi.waitFor(() => expect(getTeamSnapshot(scope, address)?.status).toBe('error'));
        expect(getTeamSnapshot(scope, address)).toMatchObject({
            stale: true,
            data: { id: 't1' },
            error: { kind: 'unreachable', retryable: true },
        });
        release();
    });

    it('loads the first page for a newly observed Home and Account', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => page([team('t1')], null));
        const scope = createServerAccountScope(homeA, 'account')!;

        const release = observeTeamsDirectory(scope, listInput);
        await vi.waitFor(() => {
            expect(getTeamsDirectorySnapshot(scope, queryKey)?.status).toBe('ready');
        });

        expect(getTeamsDirectorySnapshot(scope, queryKey)?.data?.map((entry) => entry.id)).toEqual(['t1']);
        expect(runtimeFetchMock.mock.calls[0]?.[0]?.url).toBe('https://home-a.example/v1/teams/list');
        // A first read never replays a cursor.
        expect(requestedBodies()[0]?.cursor).toBeNull();
        release();
    });

    it('appends a continuation page without refetching the first one', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementationOnce(async () => page([team('t1')], 'cursor-1'));
        runtimeFetchMock.mockImplementation(async () => page([team('t2')], null));
        const scope = createServerAccountScope(homeA, 'account')!;

        const release = observeTeamsDirectory(scope, listInput);
        await vi.waitFor(() => {
            expect(getTeamsDirectorySnapshot(scope, queryKey)?.nextCursor).toBe('cursor-1');
        });

        await loadMoreTeamsDirectory(scope, listInput);

        const snapshot = getTeamsDirectorySnapshot(scope, queryKey);
        expect(snapshot?.data?.map((entry) => entry.id)).toEqual(['t1', 't2']);
        expect(snapshot?.nextCursor).toBeNull();
        expect(requestedBodies()[1]?.cursor).toBe('cursor-1');
        release();
    });

    it('ignores a continuation request when the Home reported no further page', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => page([team('t1')], null));
        const scope = createServerAccountScope(homeA, 'account')!;

        const release = observeTeamsDirectory(scope, listInput);
        await vi.waitFor(() => {
            expect(getTeamsDirectorySnapshot(scope, queryKey)?.status).toBe('ready');
        });
        const callsBefore = runtimeFetchMock.mock.calls.length;

        await loadMoreTeamsDirectory(scope, listInput);

        expect(runtimeFetchMock.mock.calls.length).toBe(callsBefore);
        release();
    });

    it('does not lose a wake that arrives while its own load is still in flight', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const scope = createServerAccountScope(homeA, 'account')!;

        let releaseFirstResponse: (() => void) | null = null;
        runtimeFetchMock.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
                releaseFirstResponse = resolve;
            });
            return page([team('t1', 'Before rename')], null);
        });
        let releaseTrailingResponse: (() => void) | null = null;
        runtimeFetchMock.mockImplementation(async () => {
            await new Promise<void>((resolve) => {
                releaseTrailingResponse = resolve;
            });
            return page([team('t1', 'After rename')], null);
        });

        const release = observeTeamsDirectory(scope, listInput);
        await vi.waitFor(() => expect(releaseFirstResponse).not.toBeNull());

        publishHomeAccountChange(homeA);
        releaseFirstResponse!();

        await vi.waitFor(() => expect(releaseTrailingResponse).not.toBeNull());
        expect(getTeamsDirectorySnapshot(scope, queryKey)).toMatchObject({
            stale: true,
            data: [{ name: 'Before rename' }],
        });

        releaseTrailingResponse!();

        await vi.waitFor(() => {
            expect(getTeamsDirectorySnapshot(scope, queryKey)?.data?.[0]?.name).toBe('After rename');
        });
        expect(getTeamsDirectorySnapshot(scope, queryKey)?.stale).toBe(false);
        release();
    });

    it('refreshes the Teams directory for a Teams change page and not for an unrelated one', async () => {
        const home = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => page([team('t1')], null));
        const scope = createServerAccountScope(home, 'account')!;

        const release = observeTeamsDirectory(scope, listInput);
        await vi.waitFor(() => expect(getTeamsDirectorySnapshot(scope, queryKey)?.status).toBe('ready'));
        const reads = runtimeFetchMock.mock.calls.length;

        publishHomeAccountChange(home, ['session-1', 'self']);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(runtimeFetchMock.mock.calls.length).toBe(reads);

        publishHomeAccountChange(home, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        await vi.waitFor(() => expect(runtimeFetchMock.mock.calls.length).toBe(reads + 1));
        release();
    });

    it('refetches only the woken Home and keeps another Home visible', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        const homeB = await addHome('Home B', 'https://home-b.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => page([team('t1')], null));
        const scopeA = createServerAccountScope(homeA, 'account')!;
        const scopeB = createServerAccountScope(homeB, 'account')!;

        const releaseA = observeTeamsDirectory(scopeA, listInput);
        const releaseB = observeTeamsDirectory(scopeB, listInput);
        await vi.waitFor(() => {
            expect(getTeamsDirectorySnapshot(scopeA, queryKey)?.status).toBe('ready');
            expect(getTeamsDirectorySnapshot(scopeB, queryKey)?.status).toBe('ready');
        });
        const snapshotB = getTeamsDirectorySnapshot(scopeB, queryKey);

        publishHomeAccountChange(homeA);
        await vi.waitFor(() => {
            expect(getTeamsDirectorySnapshot(scopeA, queryKey)?.stale).toBe(false);
        });

        // Home B was never woken, so its rows are untouched and not refetched.
        expect(getTeamsDirectorySnapshot(scopeB, queryKey)).toBe(snapshotB);
        releaseA();
        releaseB();
    });

    it('retains an unobserved wake as staleness and refreshes the exact Home on remount', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        const homeB = await addHome('Home B', 'https://home-b.example');
        await setActiveServerId(homeB, { scope: 'device' });
        const scopeA = createServerAccountScope(homeA, 'account')!;
        const scopeB = createServerAccountScope(homeB, 'account')!;

        runtimeFetchMock.mockImplementation(async ({ url }: { url: string }) => page(
            [team('t1', url.includes('home-a') ? 'Before rename' : 'Home B team')],
            null,
        ));
        const releaseA = observeTeamsDirectory(scopeA, listInput);
        const releaseB = observeTeamsDirectory(scopeB, listInput);
        await vi.waitFor(() => {
            expect(getTeamsDirectorySnapshot(scopeA, queryKey)?.status).toBe('ready');
            expect(getTeamsDirectorySnapshot(scopeB, queryKey)?.status).toBe('ready');
        });
        releaseA();
        const callsBeforeWake = runtimeFetchMock.mock.calls.length;
        const untouchedB = getTeamsDirectorySnapshot(scopeB, queryKey);

        publishHomeAccountChange(homeA);
        await Promise.resolve();

        expect(runtimeFetchMock.mock.calls).toHaveLength(callsBeforeWake);
        expect(getTeamsDirectorySnapshot(scopeA, queryKey)?.stale).toBe(true);
        expect(getTeamsDirectorySnapshot(scopeB, queryKey)).toBe(untouchedB);

        let releaseRemountResponse: (() => void) | null = null;
        runtimeFetchMock.mockImplementation(async ({ url }: { url: string }) => {
            if (url.includes('home-a')) {
                await new Promise<void>((resolve) => {
                    releaseRemountResponse = resolve;
                });
            }
            return page(
                [team('t1', url.includes('home-a') ? 'After rename' : 'Home B team')],
                null,
            );
        });
        const releaseAgain = observeTeamsDirectory(scopeA, listInput);
        await vi.waitFor(() => expect(releaseRemountResponse).not.toBeNull());
        expect(getTeamsDirectorySnapshot(scopeA, queryKey)).toMatchObject({
            stale: true,
            data: [{ name: 'Before rename' }],
        });
        expect(getTeamsDirectorySnapshot(scopeB, queryKey)).toBe(untouchedB);

        releaseRemountResponse!();
        await vi.waitFor(() => {
            expect(getTeamsDirectorySnapshot(scopeA, queryKey)?.data?.[0]?.name).toBe('After rename');
            expect(getTeamsDirectorySnapshot(scopeA, queryKey)?.stale).toBe(false);
        });

        expect(getTeamsDirectorySnapshot(scopeB, queryKey)).toBe(untouchedB);
        releaseAgain();
        releaseB();
    });

    it('keeps the last directory visible and stale when the Home becomes unreachable', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementationOnce(async () => page([team('t1')], null));
        const scope = createServerAccountScope(homeA, 'account')!;

        const release = observeTeamsDirectory(scope, listInput);
        await vi.waitFor(() => {
            expect(getTeamsDirectorySnapshot(scope, queryKey)?.status).toBe('ready');
        });

        runtimeFetchMock.mockImplementation(async () => {
            throw new Error('network down');
        });
        publishHomeAccountChange(homeA);

        await vi.waitFor(() => {
            expect(getTeamsDirectorySnapshot(scope, queryKey)?.status).toBe('error');
        });
        const snapshot = getTeamsDirectorySnapshot(scope, queryKey);
        expect(snapshot?.data?.map((entry) => entry.id)).toEqual(['t1']);
        expect(snapshot?.stale).toBe(true);
        expect(snapshot?.error).toEqual({ kind: 'unreachable', retryable: true, code: null });
        release();
    });

    it('drops a continuation whose sequence was replaced by a refresh while it was in flight', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const scope = createServerAccountScope(homeA, 'account')!;

        // Page one of the original sequence.
        runtimeFetchMock.mockImplementationOnce(async () => page([team('t1'), team('t2')], 'cursor-1'));
        const release = observeTeamsDirectory(scope, listInput);
        await vi.waitFor(() => {
            expect(getTeamsDirectorySnapshot(scope, queryKey)?.nextCursor).toBe('cursor-1');
        });

        // The continuation is held open at the network boundary.
        let releaseContinuation: () => void = () => {};
        const continuationHeld = new Promise<void>((resolve) => {
            releaseContinuation = resolve;
        });
        runtimeFetchMock.mockImplementationOnce(async () => {
            await continuationHeld;
            return page([team('t2'), team('t3')], 'cursor-2');
        });
        const continuation = loadMoreTeamsDirectory(scope, listInput);

        // A wake refresh re-reads page one of a sequence that has moved, and
        // resolves first.
        runtimeFetchMock.mockImplementationOnce(async () => page([team('t9'), team('t1')], 'cursor-1b'));
        publishHomeAccountChange(homeA);
        await vi.waitFor(() => {
            expect(getTeamsDirectorySnapshot(scope, queryKey)?.nextCursor).toBe('cursor-1b');
        });

        releaseContinuation();
        await continuation;

        // The stale page named a position in a sequence that no longer exists.
        // Appending it would duplicate `t2` and hand the reader a cursor from
        // the replaced sequence.
        const snapshot = getTeamsDirectorySnapshot(scope, queryKey);
        expect(snapshot?.data?.map((entry) => entry.id)).toEqual(['t9', 't1']);
        expect(snapshot?.nextCursor).toBe('cursor-1b');
        release();
    });
});

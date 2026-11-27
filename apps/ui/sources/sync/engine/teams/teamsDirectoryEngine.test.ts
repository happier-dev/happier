import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    teamDirectoryQueryKeyV1,
    type TeamSummaryV1,
    type TeamsListInputV1,
} from '@happier-dev/protocol/teams';

import { renderHook, standardCleanup, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// Only the Team HTTP response varies by case; Action/account/settings admission stays real.
const runtimeFetchMock = vi.fn<(request: { url: string; init: RequestInit | undefined }) => Promise<Response>>();
const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const {
    getTeamSnapshot,
    getTeamsDirectorySnapshot,
    resetTeamsSnapshotsForTests,
} = await import('@/sync/store/teams/teamsSnapshots');
const { createTeamAddress } = await import('@/sync/domains/teams/teamAddress');

const {
    loadMoreTeamsDirectory,
    observeTeam,
    observeTeamsDirectory,
    resetTeamsDirectoryEngineForTests,
} = await import('./teamsDirectoryEngine');

const { useManagedSessionDefaults } = await import('@/hooks/teams/useManagedSessionDefaults');

const listInput: TeamsListInputV1 = { v: 1, scope: 'member', archived: 'active' };
const queryKey = teamDirectoryQueryKeyV1(listInput);

function team(id: string, name = `Team ${id}`): TeamSummaryV1 {
    return teamSummaryFixture({ id, name, viewerRole: 'member' });
}

function page(items: TeamSummaryV1[], nextCursor: string | null): Response {
    return new Response(JSON.stringify({ items, nextCursor }), { status: 200 });
}

function requestedBodies(): TeamsListInputV1[] {
    return runtimeFetchMock.mock.calls.map(([input]) => JSON.parse(String(input?.init?.body ?? '{}')));
}

async function addHome(name: string, serverUrl: string, accountId = 'account'): Promise<string> {
    const serverId = await home.addHome({ serverUrl, name, accountId, teamsEnabled: true });
    for (const path of ['/v1/teams/list', '/v1/teams/get']) home.answer(serverId, path, {
        select: async (_input, request) => {
            const response = await runtimeFetchMock(request);
            return { status: response.status, body: await response.json() };
        },
    });
    return serverId;
}

beforeEach(async () => {
    await home.reset();
    runtimeFetchMock.mockReset();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
});

afterEach(async () => {
    standardCleanup();
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    vi.clearAllMocks();
    await home.reset();
});

describe('teamsDirectoryEngine', () => {
    it('keeps Team Overview current across a tab gap and reads once after its Teams wake', async () => {
        const serverId = await addHome('Home', 'https://team-tab-gap.example');
        await setActiveServerId(serverId, { scope: 'device' });
        const scope = createServerAccountScope(serverId, 'account')!;
        const address = createTeamAddress(serverId, 't1')!;
        let name = 'Before';
        runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify(team('t1', name)), { status: 200 }));
        const release = observeTeam(scope, address);
        await waitForHomeGovernance(() => expect(getTeamSnapshot(scope, address)?.data?.name).toBe(name));
        release();
        const revisit = observeTeam(scope, address);
        expect(getTeamSnapshot(scope, address)?.stale).toBe(false);
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        revisit();
        name = 'After';
        publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        expect(getTeamSnapshot(scope, address)?.stale).toBe(true);
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        const reopen = observeTeam(scope, address);
        await waitForHomeGovernance(() => expect(getTeamSnapshot(scope, address)?.data?.name).toBe(name));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
        reopen();
    });

    it('pushes Source-derived hasSetup changes to both observed Team summaries without manual refresh', async () => {
        const homeA = await addHome('Home A', 'https://home-source-setup.example');
        await setActiveServerId(homeA, { scope: 'device' });
        let hasSetup = false;
        runtimeFetchMock.mockImplementation(async request => {
            const projection = { ...team('t1'), hasSetup };
            return request.url.endsWith('/list') ? page([projection], null)
                : new Response(JSON.stringify(projection), { status: 200 });
        });
        const scope = createServerAccountScope(homeA, 'account')!;
        const address = createTeamAddress(homeA, 't1')!;
        const releaseDirectory = observeTeamsDirectory(scope, listInput);
        const releaseTeam = observeTeam(scope, address);
        try {
            await waitForHomeGovernance(() => {
                expect(getTeamsDirectorySnapshot(scope, queryKey)?.data?.[0]?.hasSetup).toBe(false);
                expect(getTeamSnapshot(scope, address)?.data?.hasSetup).toBe(false);
            });
            hasSetup = true;
            publishHomeAccountChange(homeA, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await waitForHomeGovernance(() => {
                expect(getTeamsDirectorySnapshot(scope, queryKey)?.data?.[0]?.hasSetup).toBe(true);
                expect(getTeamSnapshot(scope, address)?.data?.hasSetup).toBe(true);
            });
            hasSetup = false;
            publishHomeAccountChange(homeA, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await waitForHomeGovernance(() => {
                expect(getTeamsDirectorySnapshot(scope, queryKey)?.data?.[0]?.hasSetup).toBe(false);
                expect(getTeamSnapshot(scope, address)?.data?.hasSetup).toBe(false);
            });
        } finally { releaseDirectory(); releaseTeam(); }
    });

    it.each(['admin', 'member'])('pushes Home defaults clearing to the mounted composer defaults for %s', async (accountId) => {
        const serverId = await addHome('Home', 'https://home-defaults.example', accountId);
        await setActiveServerId(serverId, { scope: 'device' });
        const key = 'agent:claude/claude';
        let projection = team('t1');
        projection = { ...projection, policy: { ...projection.policy, homeDefaults: {
            permissionModeByAgentTargetKey: { [key]: 'safe-yolo' },
            modelByAgentTargetKey: { [key]: { v: 1, ref: {
                agentTargetKey: key, providerConnectionId: null, modelId: 'sonnet-4.6',
            }, updatedAt: 1 } },
        } } };
        runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify(projection), { status: 200 }));
        const hook = await renderHook(() => useManagedSessionDefaults({ serverId, teamId: 't1', agentTargetKey: key }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().read).toMatchObject({
            status: 'ready', defaults: { permissionMode: { value: 'safe-yolo' }, model: { value: { ref: { modelId: 'sonnet-4.6' } } } },
        }));
        const initialReads = runtimeFetchMock.mock.calls.length;
        projection = { ...projection, policy: { ...projection.policy, homeDefaults: null } };
        publishHomeAccountChange(serverId, [HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        await waitForHomeGovernance(() => expect(hook.getCurrent().read).toMatchObject({
            status: 'ready', defaults: { permissionMode: { value: undefined }, model: { value: undefined } },
        }));
        // One read for the demanded Team, shared by its mounted consumers.
        expect(runtimeFetchMock.mock.calls.length - initialReads).toBe(1);
    });

    it('loads one Team through teams.get under its exact Home and Account address', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify(team('t1')), { status: 200 }));
        const scope = createServerAccountScope(homeA, 'account')!;
        const address = createTeamAddress(homeA, 't1')!;

        const release = observeTeam(scope, address);
        await waitForHomeGovernance(() => {
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
        await waitForHomeGovernance(() => expect(getTeamSnapshot(scope, address)?.status).toBe('ready'));

        runtimeFetchMock.mockRejectedValue(new Error('network down'));
        publishHomeAccountChange(homeA);

        await waitForHomeGovernance(() => expect(getTeamSnapshot(scope, address)?.status).toBe('error'));
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
        await waitForHomeGovernance(() => {
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
        await waitForHomeGovernance(() => {
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
        await waitForHomeGovernance(() => {
            expect(getTeamsDirectorySnapshot(scope, queryKey)?.status).toBe('ready');
        });
        const callsBefore = runtimeFetchMock.mock.calls.length;

        await loadMoreTeamsDirectory(scope, listInput);

        expect(runtimeFetchMock.mock.calls.length).toBe(callsBefore);
        release();
    });

    it('revalidates the loaded administered Teams range through fresh cursors on an Account change', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const scope = createServerAccountScope(homeA, 'account')!;
        const input: TeamsListInputV1 = { ...listInput, scope: 'administered' };
        const key = teamDirectoryQueryKeyV1(input);

        runtimeFetchMock.mockResolvedValueOnce(page([team('t1'), team('removed')], 'old-1'));
        const release = observeTeamsDirectory(scope, input);
        try {
            await waitForHomeGovernance(() => expect(getTeamsDirectorySnapshot(scope, key)?.nextCursor).toBe('old-1'));
            runtimeFetchMock.mockResolvedValueOnce(page([team('selected-page-two')], 'old-2'));
            await loadMoreTeamsDirectory(scope, input);
            const previousRows = getTeamsDirectorySnapshot(scope, key)!.data!;
            expect(previousRows.map(row => row.id)).toEqual(['t1', 'removed', 'selected-page-two']);

            runtimeFetchMock
                .mockResolvedValueOnce(page([team('t1', 'Renamed')], 'fresh-1'))
                .mockResolvedValueOnce(page([team('selected-page-two'), team('t3')], 'fresh-2'));
            publishHomeAccountChange(homeA, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await waitForHomeGovernance(() => {
                expect(getTeamsDirectorySnapshot(scope, key)).toMatchObject({ status: 'ready', stale: false });
                expect(getTeamsDirectorySnapshot(scope, key)?.data?.[0]?.name).toBe('Renamed');
            });
            const refreshed = getTeamsDirectorySnapshot(scope, key)!;
            expect(refreshed.data?.map(row => row.id)).toEqual(['t1', 'selected-page-two', 't3']);
            expect(refreshed.data?.[1]).toBe(previousRows[2]);
            expect(refreshed.nextCursor).toBe('fresh-2');
            expect(requestedBodies().map(body => body.cursor)).toEqual([null, 'old-1', null, 'fresh-1']);

            // The authoritative end may shorten the range; continuity must not retain removed Teams.
            runtimeFetchMock.mockResolvedValueOnce(page([team('selected-page-two')], null));
            publishHomeAccountChange(homeA, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await waitForHomeGovernance(() => expect(getTeamsDirectorySnapshot(scope, key)?.nextCursor).toBeNull());
            expect(getTeamsDirectorySnapshot(scope, key)?.data?.map(row => row.id)).toEqual(['selected-page-two']);
        } finally {
            release();
        }
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
        await waitForHomeGovernance(() => expect(releaseFirstResponse).not.toBeNull());

        publishHomeAccountChange(homeA);
        releaseFirstResponse!();

        await waitForHomeGovernance(() => expect(releaseTrailingResponse).not.toBeNull());
        expect(getTeamsDirectorySnapshot(scope, queryKey)).toMatchObject({
            stale: true,
            data: [{ name: 'Before rename' }],
        });

        releaseTrailingResponse!();

        await waitForHomeGovernance(() => {
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
        await waitForHomeGovernance(() => expect(getTeamsDirectorySnapshot(scope, queryKey)?.status).toBe('ready'));
        const reads = runtimeFetchMock.mock.calls.length;

        publishHomeAccountChange(home, ['session-1', 'self']);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(runtimeFetchMock.mock.calls.length).toBe(reads);

        publishHomeAccountChange(home, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        await waitForHomeGovernance(() => expect(runtimeFetchMock.mock.calls.length).toBe(reads + 1));
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
        await waitForHomeGovernance(() => {
            expect(getTeamsDirectorySnapshot(scopeA, queryKey)?.status).toBe('ready');
            expect(getTeamsDirectorySnapshot(scopeB, queryKey)?.status).toBe('ready');
        });
        const snapshotB = getTeamsDirectorySnapshot(scopeB, queryKey);

        publishHomeAccountChange(homeA);
        await waitForHomeGovernance(() => {
            expect(getTeamsDirectorySnapshot(scopeA, queryKey)?.stale).toBe(false);
        });

        // Home B was never woken, so its rows are untouched and not refetched.
        expect(getTeamsDirectorySnapshot(scopeB, queryKey)).toBe(snapshotB);
        releaseA();
        releaseB();
    });

    it('serves a remount without a wake from the retained directory with no read, and reads once after a Teams change', async () => {
        const homeA = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const scope = createServerAccountScope(homeA, 'account')!;
        runtimeFetchMock.mockImplementation(async () => page([team('t1')], null));
        const first = observeTeamsDirectory(scope, listInput);
        await waitForHomeGovernance(() => expect(getTeamsDirectorySnapshot(scope, queryKey)?.status).toBe('ready'));
        const retained = getTeamsDirectorySnapshot(scope, queryKey);
        // A Session switch: the only consumer leaves and the next one arrives, with no Teams change between.
        first();
        const second = observeTeamsDirectory(scope, listInput);
        await Promise.resolve(); await Promise.resolve();
        expect(runtimeFetchMock, 'a remount with no Teams change re-read the directory').toHaveBeenCalledTimes(1);
        expect(getTeamsDirectorySnapshot(scope, queryKey), 'the retained directory keeps its identity').toBe(retained);
        second();
        // A real change while nobody observes is read once, by the next consumer.
        publishHomeAccountChange(homeA, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        await Promise.resolve();
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
        runtimeFetchMock.mockImplementation(async () => page([team('t1', 'Renamed')], null));
        const third = observeTeamsDirectory(scope, listInput);
        await waitForHomeGovernance(() => expect(getTeamsDirectorySnapshot(scope, queryKey)?.data?.[0]?.name).toBe('Renamed'));
        expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
        third();
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
        await waitForHomeGovernance(() => {
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
        await waitForHomeGovernance(() => expect(releaseRemountResponse).not.toBeNull());
        expect(getTeamsDirectorySnapshot(scopeA, queryKey)).toMatchObject({
            stale: true,
            data: [{ name: 'Before rename' }],
        });
        expect(getTeamsDirectorySnapshot(scopeB, queryKey)).toBe(untouchedB);

        releaseRemountResponse!();
        await waitForHomeGovernance(() => {
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
        await waitForHomeGovernance(() => {
            expect(getTeamsDirectorySnapshot(scope, queryKey)?.status).toBe('ready');
        });

        runtimeFetchMock.mockImplementation(async () => {
            throw new Error('network down');
        });
        publishHomeAccountChange(homeA);

        await waitForHomeGovernance(() => {
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
        await waitForHomeGovernance(() => {
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
        await waitForHomeGovernance(() => expect(runtimeFetchMock.mock.calls.length).toBe(2));

        // A wake refresh re-reads page one of a sequence that has moved, and
        // resolves first.
        runtimeFetchMock.mockImplementationOnce(async () => page([team('t9'), team('t1')], 'cursor-1b'));
        publishHomeAccountChange(homeA);
        await waitForHomeGovernance(() => {
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

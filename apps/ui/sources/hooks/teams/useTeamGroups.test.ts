import { act } from 'react-test-renderer';
import { projectLegacySessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createSessionFixture, standardCleanup } from '@/dev/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_TEAM_GROUP_CAPABILITIES_V1, type TeamGroupV1 } from '@happier-dev/protocol/teams';

import { renderHook } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const runtimeFetchMock = vi.fn<(request: { url: string; init: RequestInit | undefined }) => Promise<Response>>();
const { storage } = await import('@/sync/domains/state/storage');
const { sessionAddressKey } = await import('@/sync/domains/session/sessionAddress');
const { useSessionAudienceContext } = await import('./useSessionAudienceContext');
const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
const { createTeamAddress } = await import('@/sync/domains/teams/teamAddress');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const {
    applyTeamGroupProjection,
    clearTeamsSnapshotsForServer,
    readTeamGroup,
    readTeamGroups,
    resetTeamsSnapshotsForTests,
} = await import('@/sync/store/teams/teamsSnapshots');

const { useTeamGroups } = await import('./useTeamGroups');

async function addHome(serverUrl: string, name: string, accountId = 'account'): Promise<string> {
    const serverId = await home.addHome({ serverUrl, name, accountId, teamsEnabled: true });
    home.answer(serverId, '/v1/teams/groups/list', { select: async (_input, request) => {
        const response = await runtimeFetchMock(request);
        return { status: response.status, body: await response.json() };
    } });
    return serverId;
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

describe('useTeamGroups', () => {
    it('reads its rows from the shared Teams snapshot owner rather than its own pages', async () => {
        const serverId = await addHome('https://home-a.example', 'A');
        await setActiveServerId(serverId, { scope: 'device' });
        const scope = createServerAccountScope(serverId, 'account')!;
        const address = createTeamAddress(serverId, 'team-1')!;
        runtimeFetchMock.mockImplementation(async () => page([group('g1', 'Platform')], null));

        const harness = await renderHook(() => useTeamGroups({
            scope,
            address,
            archived: 'active',
            enabled: true,
        }));

        await waitForHomeGovernance(() => expect(harness.getCurrent().status).toBe('ready'));
        expect(harness.getCurrent().rows.map((row) => row.name)).toEqual(['Platform']);

        // The same rows are readable synchronously, without this hook, by a
        // surface that only needs the Group's label.
        expect(readTeamGroups(scope, address, 'active')?.map((row) => row.name)).toEqual(['Platform']);
        expect(readTeamGroup(scope, address, 'g1')?.name).toBe('Platform');
        // And the object the hook rendered is the object the reader returns, so
        // a label consumer and the list never diverge.
        expect(readTeamGroup(scope, address, 'g1')).toBe(harness.getCurrent().rows[0]);

        await harness.unmount();
    });

    it('keeps rows visible after its own surface unmounts and loses them with the credential', async () => {
        const serverId = await addHome('https://home-b.example', 'B');
        await setActiveServerId(serverId, { scope: 'device' });
        const scope = createServerAccountScope(serverId, 'account')!;
        const address = createTeamAddress(serverId, 'team-1')!;
        runtimeFetchMock.mockImplementation(async () => page([group('g1')], null));

        const harness = await renderHook(() => useTeamGroups({
            scope,
            address,
            archived: 'active',
            enabled: true,
        }));
        await waitForHomeGovernance(() => expect(harness.getCurrent().rows).toHaveLength(1));
        await harness.unmount();

        // The projection outlives the surface, which is the point: another
        // surface asking for the same Group's label must not refetch it.
        expect(readTeamGroups(scope, address, 'active')).toHaveLength(1);

        clearTeamsSnapshotsForServer(serverId);
        expect(readTeamGroups(scope, address, 'active')).toBeNull();
    });

    it('reports no rows and performs no read while disabled', async () => {
        const serverId = await addHome('https://home-c.example', 'C');
        await setActiveServerId(serverId, { scope: 'device' });
        const scope = createServerAccountScope(serverId, 'account')!;
        const address = createTeamAddress(serverId, 'team-1')!;

        const harness = await renderHook(() => useTeamGroups({
            scope,
            address,
            archived: 'active',
            enabled: false,
        }));

        expect(harness.getCurrent().rows).toEqual([]);
        expect(harness.getCurrent().status).toBe('loading');
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        await harness.unmount();
    });
});


describe('Session audience surface binding', () => {
    it('encodes a large audience membership once per address, rather than inside sort comparisons', async () => {
        const serverId = await addHome('https://audience-key-cost.example', 'Key cost');
        runtimeFetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
        const addresses = Array.from({ length: 2_000 }, (_, index) => ({ serverId, sessionId: `sort-session-${(index * 997) % 2_000}` }));
        let membership = addresses;
        storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
        // Call-through allocation instrumentation: all address/domain logic stays real.
        const stringify = vi.spyOn(JSON, 'stringify');
        const allocations = () => stringify.mock.calls.filter(([value]) => Array.isArray(value)
            && value[0] === serverId && typeof value[1] === 'string' && value[1].startsWith('sort-session-')).length;
        const start = performance.now();
        const hook = await renderHook(() => useSessionAudienceContext(membership));
        try {
            const mountMs = performance.now() - start;
            const mountAllocations = allocations();
            stringify.mockClear();
            const tickStart = performance.now();
            for (let index = 0; index < 10; index++) await hook.rerender();
            console.info('[PERF-3 audience keys]', JSON.stringify({ addresses: addresses.length,
                mountAllocations, mountMs, rerenderAllocations: allocations(), rerenderMs: performance.now() - tickStart }));
            expect(mountAllocations).toBe(addresses.length);
            expect(allocations()).toBe(0);
            // Replacing the membership must still rebuild its qualified key set.
            // An unconditional memo would pass the unchanged-render checks above.
            membership = [...addresses.slice(1), { serverId, sessionId: 'sort-session-added' }];
            await hook.rerender();
            expect(allocations()).toBe(membership.length);
        } finally {
            stringify.mockRestore();
            await hook.unmount();
            storage.setState(storage.getInitialState(), true);
        }
    });
    it('does not join list labels or rescan audiences for unrelated store updates', async () => {
        const serverId = await addHome('https://audience-perf.example', 'Performance');
        runtimeFetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
        const addresses = Array.from({ length: 200 }, (_, index) => ({ serverId, sessionId: `session-${index}` }));
        let rowReads = 0;
        let indexScans = 0;
        const rows = new Proxy(Object.fromEntries(addresses.map(address => [address.sessionId, createSessionFixture({ id: address.sessionId })])), {
            get(target, key, receiver) { rowReads += 1; return Reflect.get(target, key, receiver); },
        });
        const index = addresses.map(address => ({ type: 'session' as const, sessionId: address.sessionId }));
        const measuredIndex = new Proxy(index, { get(target, key, receiver) {
            if (key === 'find') indexScans += 1;
            return Reflect.get(target, key, receiver);
        } });
        storage.setState({ sessionListRowsByServerId: { [serverId]: rows }, sessionListIndexByServerId: { [serverId]: measuredIndex } });
        const hook = await renderHook(() => useSessionAudienceContext(addresses));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().credentialBindingsByServerId.size).toBe(1));
            const before = hook.getCurrent();
            rowReads = 0;
            indexScans = 0;
            const start = performance.now();
            for (let update = 0; update < 20; update += 1) act(() => storage.setState({ isDataReady: update % 2 === 0 }));
            console.info('[PERF-RENDER audience]', JSON.stringify({ sessions: addresses.length, updates: 20, rowReads, indexScans, ms: performance.now() - start }));
            expect(hook.getCurrent()).toBe(before);
            expect(indexScans).toBe(0);
            expect(rowReads).toBe(0);
            const session = createSessionFixture({ id: addresses[0]!.sessionId, access: {
                role: 'recipient', level: 'view', capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
                audienceContext: { kind: 'group', teamId: 'team-1', groupId: 'g1' },
            } });
            applyTeamGroupProjection({ scope: { serverId, accountId: 'account' }, address: { serverId, teamId: 'team-1' },
                group: group('g1', 'New audience'), observedAt: Date.now() });
            act(() => storage.setState({ sessionListRowsByServerId: { [serverId]: { ...rows, [session.id]: { ...session, presence: 'online' } } } }));
            expect(hook.getCurrent().labelsBySessionKey.get(sessionAddressKey(addresses[0]!))).toBe('New audience');
        } finally {
            await hook.unmount();
            storage.setState(storage.getInitialState(), true);
        }
    });
    it('keeps same-ID Home labels separate and observes shared-cache renames without a card subscription', async () => {
        const homeA = await addHome('https://audience-a.example', 'A', 'viewer-a');
        const homeB = await addHome('https://audience-b.example', 'B', 'viewer-b');
        runtimeFetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
        const addresses = [homeA, homeB].map((serverId) => ({ serverId, sessionId: 'same-session' }));
        const scopes = [
            { serverId: homeA, accountId: 'viewer-a' },
            { serverId: homeB, accountId: 'viewer-b' },
        ];
        const session = createSessionFixture({ id: 'same-session', access: {
            role: 'recipient', level: 'view', capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
            audienceContext: { kind: 'group', teamId: 'team-1', groupId: 'g1' },
        } });
        storage.setState({ sessionListRowsByServerId: {
            [homeA]: { [session.id]: { ...session, presence: 'online' } },
            [homeB]: { [session.id]: { ...session, presence: 'online' } },
        } });
        for (const [index, scope] of scopes.entries()) {
            applyTeamGroupProjection({ scope, address: { serverId: scope.serverId, teamId: 'team-1' },
                group: group('g1', index === 0 ? 'A group' : 'B group'), observedAt: Date.now() });
        }
        const hook = await renderHook(() => useSessionAudienceContext(addresses));
        try {
            await waitForHomeGovernance(() => {
                expect(hook.getCurrent().labelsBySessionKey.get(sessionAddressKey(addresses[0]))).toBe('A group');
                expect(hook.getCurrent().labelsBySessionKey.get(sessionAddressKey(addresses[1]))).toBe('B group');
            });
            act(() => applyTeamGroupProjection({ scope: scopes[1], address: { serverId: homeB, teamId: 'team-1' },
                group: group('g1', 'Renamed group'), observedAt: Date.now() }));
            expect(hook.getCurrent().labelsBySessionKey.get(sessionAddressKey(addresses[1]))).toBe('Renamed group');
            expect(hook.getCurrent().labelsBySessionKey.get(sessionAddressKey(addresses[0]))).toBe('A group');
            act(() => clearTeamsSnapshotsForServer(homeB));
            expect(hook.getCurrent().labelsBySessionKey.get(sessionAddressKey(addresses[1]))).toBeNull();
        } finally {
            await hook.unmount();
            storage.setState(storage.getInitialState(), true);
        }
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeGovernanceEligibilityV1Schema } from '@happier-dev/protocol/home/governance/projection';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const runtimeFetchMock = vi.fn<(input: { serverUrl: string; url: string; init?: RequestInit }) => Promise<Response>>();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await import('@/sync/ops/actions/defaultActionExecutor');

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    getHomeGovernanceEligibilitySnapshot,
    resetHomeGovernanceEligibilitySnapshotsForTests,
} from '@/sync/store/home/governance/homeGovernanceEligibilitySnapshots';

import {
    observeHomeGovernanceEligibility,
    refreshHomeGovernanceEligibility,
    resetHomeGovernanceEligibilityEngineForTests,
} from './homeGovernanceEligibilityEngine';

async function addHome(name: string, serverUrl: string): Promise<string> {
    const serverId = await homes.addHome({ serverUrl, name, accountId: 'member-a' });
    homes.answer(serverId, '/v1/home/governance/eligibility/get', { select: async (_input, request) => {
        const response = await runtimeFetchMock({ serverUrl, url: request.url, init: request.init });
        return { status: response.status, body: await response.json() };
    } });
    return serverId;
}

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

beforeEach(async () => {
    runtimeFetchMock.mockReset();
    resetHomeGovernanceEligibilitySnapshotsForTests();
    resetHomeGovernanceEligibilityEngineForTests();
    await homes.reset();
});

afterEach(() => {
    resetHomeGovernanceEligibilityEngineForTests();
    resetHomeGovernanceEligibilitySnapshotsForTests();
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

describe('homeGovernanceEligibilityEngine', () => {
    it('reads only the minimum eligibility Action for one exact Home and Account', async () => {
        const parse = vi.spyOn(HomeGovernanceEligibilityV1Schema, 'safeParse');
        const home = await addHome('Home A', 'https://home-a.example');
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockResolvedValue(response({ teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false }));
        const scope = createServerAccountScope(home, 'member-a')!;

        const release = observeHomeGovernanceEligibility(scope);
        await vi.waitFor(() => expect(getHomeGovernanceEligibilitySnapshot(scope)?.status).toBe('ready'));

        expect(getHomeGovernanceEligibilitySnapshot(scope)?.data).toEqual({
            teamsEnabled: true,
            createTeam: true,
            createTeamForChosenAccount: false,
        });
        expect(runtimeFetchMock).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://home-a.example',
            url: 'https://home-a.example/v1/home/governance/eligibility/get',
        }));
        expect(parse).toHaveBeenCalled();
        release();
    });

    it('rejects an administrative projection instead of retaining leaked fields', async () => {
        const home = await addHome('Home B', 'https://home-b.example');
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockResolvedValue(response({
            teamsEnabled: true,
            createTeam: true,
            createTeamForChosenAccount: false,
            policy: { revision: 4 },
        }));
        const scope = createServerAccountScope(home, 'member-a')!;

        const release = observeHomeGovernanceEligibility(scope);
        await vi.waitFor(() => expect(getHomeGovernanceEligibilitySnapshot(scope)?.status).toBe('error'));

        expect(getHomeGovernanceEligibilitySnapshot(scope)).toMatchObject({
            data: null,
            error: { kind: 'invalid', retryable: false },
        });
        release();
    });

    it('keeps the last minimum answer stale and read-only when refresh is unreachable', async () => {
        const home = await addHome('Home C', 'https://home-c.example');
        await setActiveServerId(home, { scope: 'device' });
        const scope = createServerAccountScope(home, 'member-a')!;
        runtimeFetchMock.mockResolvedValue(response({ teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false }));

        const release = observeHomeGovernanceEligibility(scope);
        await vi.waitFor(() => expect(getHomeGovernanceEligibilitySnapshot(scope)?.status).toBe('ready'));
        runtimeFetchMock.mockRejectedValue(new Error('offline'));
        await refreshHomeGovernanceEligibility(scope);

        expect(getHomeGovernanceEligibilitySnapshot(scope)).toMatchObject({
            data: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false },
            stale: true,
            reachability: 'unreachable',
            error: { kind: 'unreachable', retryable: true },
        });
        release();
    });

    it('refetches minimum eligibility when the focused viewer role or status changes', async () => {
        const home = await addHome('Home D', 'https://home-d.example');
        await setActiveServerId(home, { scope: 'device' });
        const scope = createServerAccountScope(home, 'member-a')!;
        runtimeFetchMock.mockResolvedValue(response({ teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false }));

        const release = observeHomeGovernanceEligibility(scope);
        await vi.waitFor(() => expect(getHomeGovernanceEligibilitySnapshot(scope)?.status).toBe('ready'));
        runtimeFetchMock.mockResolvedValue(response({ teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false }));
        publishHomeAccountChange(home, ['self']);

        await vi.waitFor(() => {
            expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
            expect(getHomeGovernanceEligibilitySnapshot(scope)?.data?.createTeam).toBe(false);
        });
        release();
    });
});

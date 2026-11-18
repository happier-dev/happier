import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamPolicyFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getTeamSnapshot, resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const confirmNative = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: confirmNative } }).module;
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Resolve the lazy Action graph during collection, outside interaction deadlines.
await import('@/sync/ops/actions/defaultActionExecutor');
const { archiveTeam, removeTeamLogo, restoreTeam, setTeamLogo, setTeamPolicy } = await import('./teamOperations');

beforeEach(async () => {
    await harness.reset();
    resetTeamsSnapshotsForTests();
    confirmNative.mockClear();
});
afterEach(() => {
    resetTeamsSnapshotsForTests();
    standardCleanup();
});

async function target() {
    const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'account' });
    return { scope: createServerAccountScope(serverId, 'account')!, address: { serverId, teamId: 'team-1' } };
}

type Confirmation = Parameters<typeof archiveTeam>[0];

describe('Team lifecycle and logo mutations', () => {
    it.each([
        ['archive', '/v1/teams/archive', async (confirmation: Confirmation) => archiveTeam(confirmation)],
        ['restore', '/v1/teams/restore', async (confirmation: Confirmation) => restoreTeam(confirmation)],
        ['set logo', '/v1/teams/logo/set', async (confirmation: Confirmation) =>
            setTeamLogo({ ...confirmation, image: { mimeType: 'image/png', dataBase64: 'aGVsbG8=' } })],
        ['remove logo', '/v1/teams/logo/remove', async (confirmation: Confirmation) => removeTeamLogo(confirmation)],
    ] as const)('publishes the %s result through the shared Action front door', async (_name, path, invoke) => {
        const confirmation = await target();
        const team = teamSummaryFixture({ name: 'Updated Team' });
        harness.answer(confirmation.scope.serverId, path, { body: team });

        await expect(invoke(confirmation)).resolves.toEqual({ kind: 'succeeded', team });

        expect(harness.requestsFor(path)).toHaveLength(1);
        expect(getTeamSnapshot(confirmation.scope, confirmation.address)?.data).toEqual(team);
    });
});

describe('setTeamPolicy', () => {
    it('changes the audience for new Team Reviews independently of Session defaults', async () => {
        const targetTeam = await target();
        const team = teamSummaryFixture({ policy: teamPolicyFixture({
            sessionCreationPolicy: 'team_default', reviewCreationPolicy: 'team_required',
        }) });
        const path = '/v1/teams/policy/set';
        harness.answer(targetTeam.scope.serverId, path, { body: team });

        await expect(setTeamPolicy({ ...targetTeam, reviewCreationPolicy: 'team_required' }))
            .resolves.toEqual({ kind: 'succeeded', team });

        expect(harness.requestsFor(path).map(request => request.input)).toEqual([
            { v: 1, teamId: 'team-1', reviewCreationPolicy: 'team_required' },
        ]);
        expect(getTeamSnapshot(targetTeam.scope, targetTeam.address)?.data?.policy).toMatchObject({
            sessionCreationPolicy: 'team_default', reviewCreationPolicy: 'team_required',
        });
    });

    it('submits the prior authentication value and replacement as one policy patch', async () => {
        const confirmation = await target();
        const authenticationPolicy = {
            v: 1 as const,
            mode: 'restricted' as const,
            accepted: [{ kind: 'home_method' as const, methodId: 'email_password' }],
        };
        const team = teamSummaryFixture({ policy: teamPolicyFixture({ authenticationPolicy }) });
        const path = '/v1/teams/policy/set';
        harness.answer(confirmation.scope.serverId, path, { body: team });

        await expect(setTeamPolicy({ ...confirmation, previousAuthenticationPolicy: null, authenticationPolicy }))
            .resolves.toEqual({ kind: 'succeeded', team });

        expect(harness.requestsFor(path)[0]?.input).toEqual({
            v: 1, teamId: 'team-1', previousAuthenticationPolicy: null, authenticationPolicy,
        });
        expect(getTeamSnapshot(confirmation.scope, confirmation.address)?.data?.policy.authenticationPolicy).toEqual(authenticationPolicy);
    });

    it('replaces a malformed stored authentication policy using its repair basis', async () => {
        const confirmation = await target();
        const team = teamSummaryFixture({ policy: teamPolicyFixture({ authenticationPolicy: null }) });
        const path = '/v1/teams/policy/set';
        harness.answer(confirmation.scope.serverId, path, { body: team });

        await expect(setTeamPolicy({
            ...confirmation,
            previousAuthenticationPolicy: { v: 1, status: 'repair_required' },
            authenticationPolicy: null,
        })).resolves.toEqual({ kind: 'succeeded', team });

        expect(harness.requestsFor(path)[0]?.input).toEqual({
            v: 1, teamId: 'team-1', previousAuthenticationPolicy: { v: 1, status: 'repair_required' },
            authenticationPolicy: null,
        });
    });
});

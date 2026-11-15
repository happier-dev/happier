import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// Cold source loading is collection work, outside a policy invocation's deadline.
await import('@/sync/ops/actions/defaultActionExecutor');
const { Modal } = await import('@/modal');
const governance = await import('./homeGovernanceEngine');
const eligibility = await import('./homeGovernanceEligibilityEngine');
const governanceSnapshots = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
const eligibilitySnapshots = await import('@/sync/store/home/governance/homeGovernanceEligibilitySnapshots');

beforeEach(async () => {
    governance.resetHomeGovernanceEngineForTests();
    eligibility.resetHomeGovernanceEligibilityEngineForTests();
    governanceSnapshots.resetHomeGovernanceSnapshotsForTests();
    eligibilitySnapshots.resetHomeGovernanceEligibilitySnapshotsForTests();
    await homes.reset();
});

afterEach(() => {
    governance.resetHomeGovernanceEngineForTests();
    eligibility.resetHomeGovernanceEligibilityEngineForTests();
    vi.restoreAllMocks();
});

const readers = [
    { actionId: 'home.governance.get', path: '/v1/home/governance/get',
        observe: governance.observeHomeGovernance, refresh: governance.refreshHomeGovernanceSnapshot,
        snapshot: governanceSnapshots.getHomeGovernanceSnapshot,
        value: homeGovernanceProjectionFixture() },
    { actionId: 'home.governance.eligibility.get', path: '/v1/home/governance/eligibility/get',
        observe: eligibility.observeHomeGovernanceEligibility, refresh: eligibility.refreshHomeGovernanceEligibility,
        snapshot: eligibilitySnapshots.getHomeGovernanceEligibilitySnapshot,
        value: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } },
] as const;

describe.each(readers)('$actionId snapshot Action admission', reader => {
    async function setup(mode: 'off' | 'ask' | 'allowed') {
        const serverId = await homes.addHome({ name: 'Governance', serverUrl: 'https://governance.example', accountId: 'account-ada' });
        homes.answer(serverId, reader.path, { body: reader.value });
        await homes.setActionPolicy(serverId, reader.actionId, 'ui', mode);
        return { serverId, accountId: 'account-ada' };
    }

    it('does not read when the Account disabled the Action', async () => {
        const scope = await setup('off');
        const release = reader.observe(scope);
        try {
            await reader.refresh(scope);
            expect(homes.requestsFor(reader.path)).toHaveLength(0);
            expect(reader.snapshot(scope)?.status).toBe('error');
            expect(reader.snapshot(scope)?.data).toBeNull();
        } finally { release(); }
    });

    it('waits for Ask and publishes the approved read', async () => {
        const scope = await setup('ask');
        const decision = createDeferred<boolean>();
        const confirm = vi.spyOn(Modal, 'confirm').mockImplementation(() => decision.promise);
        const release = reader.observe(scope);
        try {
            await waitForHomeGovernance(() => expect(confirm).toHaveBeenCalled());
            expect(homes.requestsFor(reader.path)).toHaveLength(0);
            decision.resolve(true);
            await waitForHomeGovernance(() => expect(reader.snapshot(scope)?.status).toBe('ready'));
            expect(reader.snapshot(scope)?.data).toEqual(reader.value);
            expect(homes.requestsFor(reader.path)).toHaveLength(1);
        } finally { decision.resolve(false); release(); }
    });

    it('does not dispatch an Ask read after its last observer leaves', async () => {
        const scope = await setup('ask');
        const decision = createDeferred<boolean>();
        const confirm = vi.spyOn(Modal, 'confirm').mockImplementation(() => decision.promise);
        const release = reader.observe(scope);
        try {
            await waitForHomeGovernance(() => expect(confirm).toHaveBeenCalled());
            release();
            decision.resolve(true);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(homes.requestsFor(reader.path)).toHaveLength(0);
            expect(reader.snapshot(scope)?.data).toBeNull();
        } finally { decision.resolve(false); release(); }
    });
});

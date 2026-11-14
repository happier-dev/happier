import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup, createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const eligibilityStore = await import('@/sync/store/home/governance/homeGovernanceEligibilitySnapshots');
const governanceStore = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
const { resetHomeGovernanceEligibilityEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEligibilityEngine');
const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
const { useHomeGovernanceEligibilitySnapshots } = await import('./useHomeGovernanceEligibilitySnapshots');
const { useHomeAdministrationSettingsAdmission } = await import('./useHomeAdministrationSettingsAdmission');

const eligibility = { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false };

beforeEach(async () => {
    standardCleanup();
    resetHomeGovernanceEligibilityEngineForTests();
    resetHomeGovernanceEngineForTests();
    eligibilityStore.resetHomeGovernanceEligibilitySnapshotsForTests();
    governanceStore.resetHomeGovernanceSnapshotsForTests();
    await harness.reset();
});
afterEach(() => standardCleanup());

describe('Home snapshot selection locality', () => {
    it('keeps eligibility consumers silent for unrelated Homes and Accounts, including a parent render', async () => {
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://selection-a.example', accountId: 'account-a' });
        const scope = { serverId, accountId: 'account-a' };
        const secondServerId = await harness.addHome({ name: 'Home B', serverUrl: 'https://selection-b.example', accountId: 'account-a' });
        const secondScope = { serverId: secondServerId, accountId: 'account-a' };
        harness.answer(serverId, '/v1/home/governance/eligibility/get', { body: eligibility });
        harness.answer(secondServerId, '/v1/home/governance/eligibility/get', { body: eligibility });
        const counter = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(counter);
            return useHomeGovernanceEligibilitySnapshots([scope, secondScope]);
        });
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().snapshotsByServerId.get(serverId)?.status).toBe('ready');
            expect(hook.getCurrent().snapshotsByServerId.get(secondServerId)?.status).toBe('ready');
        });
        const before = hook.getCurrent();
        counter.reset();

        await act(async () => {
            for (let index = 0; index < 100; index += 1) {
                eligibilityStore.applyHomeGovernanceEligibility({
                    scope: { serverId: `other-${index}`, accountId: 'account-a' }, eligibility, observedAt: index,
                });
            }
            eligibilityStore.applyHomeGovernanceEligibility({ scope: { serverId, accountId: 'account-b' }, eligibility, observedAt: 101 });
        });
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        await hook.rerender();
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
        expect(hook.getCurrent()).toBe(before);

        await act(async () => {
            eligibilityStore.applyHomeGovernanceEligibility({ scope: secondScope, eligibility: { ...eligibility, createTeam: false }, observedAt: 102 });
        });
        expect(hook.getCurrent().snapshotsByServerId.get(secondServerId)?.data?.createTeam).toBe(false);
        expect(hook.getCurrent().snapshotsByServerId.get(serverId)?.data?.createTeam).toBe(true);
        await act(async () => { eligibilityStore.invalidateHomeGovernanceEligibilitySnapshot(scope); });
        expect(hook.getCurrent().snapshotsByServerId.get(serverId)?.stale).toBe(true);
        await act(async () => { eligibilityStore.clearHomeGovernanceEligibilitySnapshotsForServer(serverId); });
        expect(hook.getCurrent().snapshotsByServerId.has(serverId)).toBe(false);
        expect(hook.getCurrent().snapshotsByServerId.get(secondServerId)?.data?.createTeam).toBe(false);
    });

    it('keeps administration admission silent for unrelated scopes while reflecting authority withdrawal and deletion', async () => {
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://admission-a.example', accountId: 'account-a' });
        const scope = { serverId, accountId: 'account-a' };
        const projection = homeGovernanceProjectionFixture({ viewer: { accountId: 'account-a', homeRole: 'owner', status: 'active' } });
        harness.answer(serverId, '/v1/home/governance/get', { body: projection });
        const counter = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(counter);
            return useHomeAdministrationSettingsAdmission({ serverIds: [serverId] });
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().admitted).toBe(true));
        const before = hook.getCurrent();
        counter.reset();

        await act(async () => {
            for (let index = 0; index < 100; index += 1) {
                governanceStore.applyHomeGovernanceProjection({
                    scope: { serverId: `other-${index}`, accountId: 'account-a' }, projection, observedAt: index,
                });
            }
            governanceStore.applyHomeGovernanceProjection({ scope: { serverId, accountId: 'account-b' }, projection, observedAt: 101 });
        });
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        await hook.rerender();
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
        expect(hook.getCurrent()).toBe(before);

        await act(async () => {
            governanceStore.applyHomeGovernanceFailure({ scope, error: { kind: 'forbidden', retryable: false } });
        });
        expect(hook.getCurrent().admitted).toBe(false);
        expect(hook.getCurrent().homes).toEqual([{ serverId, state: 'denied' }]);
        await act(async () => { governanceStore.clearHomeGovernanceSnapshotsForServer(serverId); });
        expect(hook.getCurrent().homes).toEqual([{ serverId, state: 'unresolved', reason: 'loading' }]);
    });
    // P03-HOME-NATIVE round 3: Settings sections re-rendered on every governance revalidation (refreshing, then ready
    // with an equal projection and a new observation time). Admission reads projection, error and staleness only.
    it('keeps administration admission silent through an equal revalidation and reflects a real change', async () => {
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://admission-reval.example', accountId: 'account-a' });
        const scope = { serverId, accountId: 'account-a' };
        const projection = homeGovernanceProjectionFixture({ viewer: { accountId: 'account-a', homeRole: 'owner', status: 'active' } });
        harness.answer(serverId, '/v1/home/governance/get', { body: projection });
        const counter = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(counter);
            return useHomeAdministrationSettingsAdmission({ serverIds: [serverId] });
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().admitted).toBe(true));
        const before = hook.getCurrent();
        counter.reset();

        await act(async () => {
            governanceStore.beginHomeGovernanceLoad(scope);
            governanceStore.applyHomeGovernanceProjection({ scope, projection: structuredClone(projection), observedAt: 500 });
        });
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        expect(hook.getCurrent()).toBe(before);

        const member = homeGovernanceProjectionFixture({ viewer: { accountId: 'account-a', homeRole: 'member', status: 'active' } });
        await act(async () => { governanceStore.applyHomeGovernanceProjection({ scope, projection: member, observedAt: 600 }); });
        expect(hook.getCurrent()).not.toBe(before);
    });
});

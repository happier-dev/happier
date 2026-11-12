import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { adoptHomeProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } = await import('./reachability/machineReachability');
const { useAllProfileMachineInventorySnapshots } = await import('./useMachineInventorySnapshots');
const before = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(before, true); clearMachineRequestReachabilityForTest(); network.resetRequests(); });
afterAll(() => network.dispose());

it('projects each Home under its credential Account instead of the focused Account', async () => {
    const homes = [];
    for (const suffix of ['a', 'b']) {
        const serverUrl = `https://inventory-scope-${suffix}.test`;
        await network.addHome(serverUrl, `account-${suffix}`);
        homes.push(await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
            homeServerIdentityId: `srv_inventory_scope_${suffix}`, canonicalServerUrl: serverUrl,
            revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } }));
    }
    const [homeA, homeB] = homes;
    if (!homeA?.serverIdentityId || !homeB?.serverIdentityId) throw new Error('Expected exact Home identities');
    await setActiveServerId(homeA.id);
    const machine = createMachineFixture({ id: 'studio', activeAt: Date.now() });
    const scopeA = { serverId: homeA.serverIdentityId, accountId: 'account-a' };
    storage.setState({ profileScope: scopeA });
    await publishMachineInventoryForTest(scopeA, [machine]);
    await publishMachineInventoryForTest({ serverId: homeB.serverIdentityId, accountId: 'account-b' }, [machine]);
    recordMachineRequestFailed({ serverId: homeB.serverIdentityId, accountId: scopeA.accountId, machineId: machine.id });
    const hook = await renderHook(() => useAllProfileMachineInventorySnapshots());
    const snapshot = (serverIdentityId: string) => hook.getCurrent().find(row => row.kind === 'resolved' && row.serverIdentityId === serverIdentityId);
    await act(async () => { await vi.waitFor(() => {
        expect(snapshot(homeA.serverIdentityId!)).toMatchObject({ accountId: 'account-a', executionEligibleMachineIds: [machine.id] });
        expect(snapshot(homeB.serverIdentityId!)).toMatchObject({ accountId: 'account-b', executionEligibleMachineIds: [machine.id] });
    }); });
    await act(async () => recordMachineRequestFailed({ ...scopeA, machineId: machine.id }));
    expect(snapshot(homeA.serverIdentityId)).toMatchObject({ executionEligibleMachineIds: [] });
    expect(snapshot(homeB.serverIdentityId)).toMatchObject({ executionEligibleMachineIds: [machine.id] });
    expect(network.requests).toEqual([]);
    await hook.unmount();
});

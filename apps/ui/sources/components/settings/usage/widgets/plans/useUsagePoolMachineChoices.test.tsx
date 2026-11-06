import { afterEach, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { storage } from '@/sync/domains/state/storageStore';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { publishAppliedActiveServerSnapshot, getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useUsagePoolMachineChoices } from './useUsagePlans';

const previousState = storage.getState();
const previousServer = getAppliedActiveServerSnapshot();
const previousAvailable = isAppliedActiveServerRuntimeAvailable();
afterEach(() => {
  standardCleanup();
  clearMachineRequestReachabilityForTest();
  retireActiveServerAccountScopeLifetime();
  storage.setState(previousState, true);
  publishAppliedActiveServerSnapshot(previousServer, previousAvailable);
});

it('renders a pool Machine chooser only for a change to its chosen names or eligibility', async () => {
  const server = await selectActiveTestHomeForTests('https://usage-chooser-counts.test');
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  const scope = { serverId: server.id, accountId: 'usage-chooser' };
  const rows = ['selected', 'other'].map(id => createMachineFixture({ id, activeAt: Date.now(), presenceProtocolVersion: 1,
    metadata: { ...createMachineFixture().metadata!, displayName: id, host: `${id}.local` } }));
  storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }) });
  storage.getState().applyMachines(rows, true, { sourceServerId: server.id });
  storage.getState().markMachineListSettled(server.id);
  const machineIds = ['selected'];
  let renders = 0;
  const chooser = await renderHook(() => { renders += 1; return useUsagePoolMachineChoices(machineIds); });
  expect(chooser.getCurrent()).toEqual([{ id: 'selected', name: 'selected' }]);
  const publish = async (id: string, change: Partial<typeof rows[number]>) => act(async () => {
    const current = storage.getState().machines[id]!;
    storage.getState().applyMachines([{ ...current, ...change }], false, { sourceServerId: server.id });
  });
  const expectQuiet = async (update: () => Promise<unknown>) => {
    renders = 0;
    await update();
    expect(renders).toBe(0);
    expect(chooser.getCurrent()).toEqual([{ id: 'selected', name: 'selected' }]);
  };
  await expectQuiet(() => publish('other', { metadataVersion: 2,
    metadata: { ...rows[1]!.metadata!, displayName: 'Other renamed' } }));
  await expectQuiet(() => publish('selected', { metadataVersion: 2,
    metadata: { ...rows[0]!.metadata!, homeDir: '/changed/home' } }));
  await expectQuiet(() => publish('selected', { activeAt: Date.now() + 1 }));
  await expectQuiet(() => publish('other', { activeAt: Date.now() + 2 }));
  await expectQuiet(() => act(async () => recordMachineRequestFailed({ ...scope, machineId: 'other' })));
  renders = 0;
  await publish('selected', { metadataVersion: 3, metadata: { ...rows[0]!.metadata!, displayName: 'Renamed' } });
  expect(renders).toBe(1);
  expect(chooser.getCurrent()).toEqual([{ id: 'selected', name: 'Renamed' }]);
  renders = 0;
  await act(async () => recordMachineRequestFailed({ ...scope, machineId: 'selected' }));
  expect(renders).toBe(1);
  expect(chooser.getCurrent()).toEqual([]);
  renders = 0;
  await act(async () => recordMachineRequestSucceeded({ ...scope, machineId: 'selected' }));
  expect(renders).toBe(1);
  expect(chooser.getCurrent()).toEqual([{ id: 'selected', name: 'Renamed' }]);
  renders = 0;
  await publish('other', { metadataVersion: 3,
    metadata: { ...rows[1]!.metadata!, displayName: 'Renamed' } });
  expect(renders).toBe(1);
  expect(chooser.getCurrent()).toEqual([{ id: 'selected', name: 'Renamed · selected.local' }]);
  renders = 0;
  await publish('other', { metadataVersion: 4,
    metadata: { ...rows[1]!.metadata!, displayName: 'Other again' } });
  expect(renders).toBe(1);
  expect(chooser.getCurrent()).toEqual([{ id: 'selected', name: 'Renamed' }]);
  renders = 0;
  const offlineAt = Date.now() + 10;
  await act(async () => storage.getState().applyMachineActivityUpdates([
    { id: 'selected', active: false, activeAt: offlineAt },
  ], { sourceServerId: server.id }));
  expect(renders).toBe(1);
  expect(chooser.getCurrent()).toEqual([]);
  renders = 0;
  await act(async () => storage.getState().applyMachineActivityUpdates([
    { id: 'selected', active: true, activeAt: offlineAt + 1 },
  ], { sourceServerId: server.id }));
  expect(renders).toBe(1);
  expect(chooser.getCurrent()).toEqual([{ id: 'selected', name: 'Renamed' }]);
  renders = 0;
  await publish('selected', { replacedByMachineId: 'other' });
  expect(renders).toBe(1);
  expect(chooser.getCurrent()).toEqual([]);
});

import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineSetupObservationV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createNativeSoftwareInstallFixture } from '@/testkit/machines/nativeSoftwareInstall';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createMachineSetupUpdatesAction } from './machineSetupUpdatesAction';

describe('reviewed Machine OS update Action', () => {
  it('applies exact reviewed packages in the existing elevated setup task with one admission and one settlement refresh', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const input = MachineSetupPlanInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
      mode: 'effects', updates: { scope: 'security' } });
    const reviewed = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input, context: fixture.context('machines.setup.plan'),
    }));
    if (!reviewed.updates?.plan) throw new Error('Missing reviewed update plan');
    const desired = fixture.machine.metadata?.setup;
    const nativeAdmissions = vi.spyOn(machineNativeEffectAdmission, 'run');
    let desiredReads = 0, currentnessReads = 0;
    const capture = fixture.client.captureMachineSetupDesired.bind(fixture.client);
    const desiredObservation = vi.spyOn(fixture.client, 'captureMachineSetupDesired').mockImplementation(() => {
      const captured = capture();
      return { ...captured, read: async () => { desiredReads++; return captured.read(); } };
    });
    const resolveRuntime = fixture.client.resolveMachineSetupRuntime.bind(fixture.client);
    const currentnessObservation = vi.spyOn(fixture.client, 'resolveMachineSetupRuntime').mockImplementation(async ingress => {
      const runtime = await resolveRuntime(ingress);
      return runtime && { ...runtime, isCurrent: async () => { currentnessReads++; return runtime.isCurrent?.() ?? false; } };
    });
    onTestFinished(() => { desiredObservation.mockRestore(); currentnessObservation.mockRestore(); nativeAdmissions.mockRestore(); });
    const apply = createMachineSetupUpdatesAction({ apiMachine: fixture.client, homeId: 'srv_home',
      machineId: fixture.machine.id, installation: fixture.installation });
    expect(await apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id, scope: 'security',
      plan: reviewed.updates.plan }, context: fixture.context('machines.setup.updates.apply') }))
      .toMatchObject({ operationId: expect.any(String) });
    expect(await fixture.readInstalled()).toMatchObject({ installed: true, version: '1.0', effects: ['apt-get'] });
    expect(fixture.rootLaunches).toHaveLength(1);
    expect(nativeAdmissions).toHaveBeenCalledTimes(1);
    expect(fixture.rootPlans).toEqual([[{ plan: reviewed.updates.plan }]]);
    expect({ desiredReads, currentnessReads }).toEqual({ desiredReads: 0, currentnessReads: 1 });
    expect(fixture.machine.metadata?.setup).toEqual(desired);
    expect(fixture.metadataWrites).toEqual([]);
    expect(fixture.machine.daemonState?.setup?.updates).toEqual({ status: 'satisfied', backend: 'apt',
      pendingAll: 0, pendingSecurity: 0, rebootNeeded: false });
    // Review, admission and post-settlement refresh each inspect the OS once;
    // the root interpreter never enumerates a broader update set.
    expect(JSON.parse(await readFile(fixture.statePath, 'utf8'))).toMatchObject({ updatesChecks: 3 });
  });

  it('refuses changed candidate sets before native work without a settlement refresh', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const reviewed = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: MachineSetupPlanInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
        mode: 'effects', updates: { scope: 'all' } }), context: fixture.context('machines.setup.plan'),
    }));
    if (!reviewed.updates?.plan) throw new Error('Missing reviewed update plan');
    const state = JSON.parse(await readFile(fixture.statePath, 'utf8'));
    await writeFile(fixture.statePath, JSON.stringify({ ...state, installed: true, version: '1.0' }));
    const apply = createMachineSetupUpdatesAction({ apiMachine: fixture.client, homeId: 'srv_home',
      machineId: fixture.machine.id, installation: fixture.installation });
    expect(await apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id, scope: 'all',
      plan: reviewed.updates.plan }, context: fixture.context('machines.setup.updates.apply') }))
      .toMatchObject({ ok: false, errorCode: 'plan_changed' });
    expect(fixture.rootLaunches).toEqual([]);
    expect((await fixture.readInstalled()).effects).toEqual([]);
    expect(fixture.metadataWrites).toEqual([]);
    expect(fixture.machine.daemonState?.setup?.updates).toEqual(reviewed.updates.observation);
    expect(JSON.parse(await readFile(fixture.statePath, 'utf8'))).toMatchObject({ updatesChecks: 2 });
  });

  it('preserves a completed native effect when the settlement fact publication loses its socket', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const reviewed = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: MachineSetupPlanInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
        mode: 'effects', updates: { scope: 'all' } }), context: fixture.context('machines.setup.plan'),
    }));
    if (!reviewed.updates?.plan) throw new Error('Missing reviewed update plan');
    // Only the Machine publication socket is replaced; native execution and
    // observation still use the physical executable fixture and real owners.
    const socket = Reflect.get(fixture.client, 'socket');
    const emitWithAck = Reflect.get(socket, 'emitWithAck');
    if (typeof emitWithAck !== 'function') throw new Error('Missing fixture socket transport');
    const codec = createMachineContentCodec(fixture.machine);
    let publicationAttempted = false;
    Reflect.set(fixture.client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (event, ...args) => {
      const payload = args[0];
      const stored = event === 'machine-update-state' && payload && typeof payload === 'object'
        ? Reflect.get(payload, 'daemonState') : undefined;
      const published = typeof stored === 'string' ? codec.decodeStored(stored) : null;
      const setup = MachineSetupObservationV1Schema.safeParse(published && typeof published === 'object'
        ? Reflect.get(published, 'setup') : undefined);
      if (!setup.success || setup.data.updates?.status !== 'satisfied' || setup.data.updates.pendingAll !== 0)
        return Reflect.apply(emitWithAck, socket, [event, ...args]);
      expect(await fixture.readInstalled()).toMatchObject({ installed: true, effects: ['apt-get'] });
      publicationAttempted = true;
      throw new Error('Fixture publication transport lost');
    } }));
    onTestFinished(() => { Reflect.set(fixture.client, 'socket', socket); });
    const apply = createMachineSetupUpdatesAction({ apiMachine: fixture.client, homeId: 'srv_home',
      machineId: fixture.machine.id, installation: fixture.installation });
    expect(await apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id, scope: 'all',
      plan: reviewed.updates.plan }, context: fixture.context('machines.setup.updates.apply') }))
      .toMatchObject({ operationId: expect.any(String) });
    expect(await fixture.readInstalled()).toMatchObject({ installed: true, effects: ['apt-get'] });
    expect(fixture.rootLaunches).toHaveLength(1);
    expect(publicationAttempted).toBe(true);
    expect(fixture.metadataWrites).toEqual([]);
  });
});

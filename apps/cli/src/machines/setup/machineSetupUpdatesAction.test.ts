import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineSetupObservationV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createNativeSoftwareInstallFixture } from '@/testkit/machines/nativeSoftwareInstall';
import { packageOs } from '@/testkit/machines/nativeSoftwareOs';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createMachineSetupUpdatesAction } from './machineSetupUpdatesAction';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';

describe('reviewed Machine OS update Action', () => {
  it('cancels an admitted update through the operation owner and settles its native installation', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const reviewed = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: MachineSetupPlanInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
        mode: 'effects', updates: { scope: 'security' } }), context: fixture.context('machines.setup.plan'),
    }));
    if (!reviewed.updates?.plan) throw new Error('Missing reviewed update plan');
    let entered!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let observeAbort!: () => void;
    const nativeAborted = new Promise<void>(resolve => { observeAbort = resolve; });
    onTestFinished(() => { release(); });
    // Hold only the OS package install; Action admission, operation cancellation
    // and update execution remain real. Release even when the RED assertion fails.
    packageOs.runNative = async command => {
      if (command.executable !== 'apt-get' || command.args[0] !== 'install') return null;
      if (!command.signal) throw new Error('Native install has no cancellation signal');
      command.signal.addEventListener('abort', observeAbort, { once: true });
      if (command.signal.aborted) observeAbort();
      entered();
      await released;
      command.signal.throwIfAborted();
      return { code: 1, stdout: '', stderr: '' };
    };
    const apply = createMachineSetupUpdatesAction({ apiMachine: fixture.client, homeId: 'srv_home',
      machineId: fixture.machine.id, installation: fixture.installation });
    const context = fixture.context('machines.setup.updates.apply');
    const executor = createActionExecutor({ machineSetupUpdatesApply: request => apply({ ...request,
      context: { ...context, ...request.context } }) });
    const input = { homeId: 'srv_home', machineId: fixture.machine.id, scope: 'security' as const, plan: reviewed.updates.plan };
    let operationId = '';
    const accepted = await fixture.operations.observeExecution({ actionId: 'machines.setup.updates.apply', input,
      actionRequestId: 'cancel-updates', rpcContext: context, response: 'admission',
      onOperation: operation => { operationId = operation.operationId; },
      execute: operation => executor.execute('machines.setup.updates.apply', input, { ...operation,
        surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'machines.setup.updates.apply' } }) });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('Missing operation');
    expect(operationId).not.toBe('');
    try {
      await Promise.race([checking, fixture.operations.handlers.getV2({ operationId,
        waitForTerminal: true }).then(terminal => { throw new Error(`Update settled before package install: ${JSON.stringify(terminal)}`); })]);
      expect(await fixture.operations.handlers.cancel({ operationId }))
        .toEqual({ kind: 'requested' });
      await nativeAborted;
    } finally { release(); }
    const terminal = await fixture.operations.handlers.getV2({ operationId, waitForTerminal: true });
    // Stopping a privileged installer after mutation begins cannot prove which
    // package effects committed. Preserve the existing typed uncertain outcome,
    // rather than claiming cancellation rolled those effects back.
    expect(terminal, JSON.stringify(terminal))
      .toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'outcome_unknown' } } });
    expect(fixture.rootLaunches).toHaveLength(1);
    expect((await fixture.readInstalled()).effects).toEqual([]);
  });
  it('reports the receiving None prerequisite for the separate system-update Plan without starting native work', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', adminAccessMode: 'none' });
    const reviewed = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: MachineSetupPlanInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
        mode: 'effects', updates: { scope: 'security' } }), context: fixture.context('machines.setup.plan'),
    }));
    expect(reviewed.review).toMatchObject({ administratorRequired: true, administratorUnavailable: { reasonCode: 'mode_none' } });
    expect(reviewed.updates?.plan?.steps.length).toBeGreaterThan(0);
    expect(fixture.rootLaunches).toEqual([]);
    expect((await fixture.readInstalled()).effects).toEqual([]);
    expect(fixture.metadataWrites).toEqual([]);
  });

  it('applies exact reviewed packages in the existing elevated setup task with one admission and one settlement refresh', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const input = MachineSetupPlanInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
      mode: 'effects', updates: { scope: 'security' } });
    const reviewed = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input, context: fixture.context('machines.setup.plan'),
    }));
    if (!reviewed.updates?.plan) throw new Error('Missing reviewed update plan');
    expect(reviewed.review?.administratorUnavailable).toBeUndefined();
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
      pendingAll: 0, pendingSecurity: 0, rebootNeeded: false, checkedAt: expect.any(Number) });
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

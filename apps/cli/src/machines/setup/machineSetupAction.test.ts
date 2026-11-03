import { beforeEach, describe, expect, it } from 'vitest';
import { MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { machineSetupItemKeyV1 } from '@happier-dev/protocol';
import { createNativeSoftwareInstallFixture } from '@/testkit/machines/nativeSoftwareInstall';
import { nativeTerminal } from '@/testkit/machines/nativeSoftwareOs';
import { createMachineSetupPlanAction } from './machineSetupAction';
import { readFile } from 'node:fs/promises';

describe('admitted Machine setup snapshot lifetime', () => {
  beforeEach(() => {
    nativeTerminal.launches.length = 0;
    nativeTerminal.exit = undefined;
    nativeTerminal.onLaunch = undefined;
    nativeTerminal.autoExit = false;
  });
  it.each([
    { unavailable: 'locks', present: false, mode: 'plain' },
    { unavailable: 'presence', present: false, mode: 'plain' },
    { unavailable: 'presence', present: false, mode: 'e2ee' },
    { unavailable: 'locks', present: true, mode: 'plain' },
    { unavailable: 'presence', present: true, mode: 'plain' },
  ] as const)('retains executing pre-install presence for Remove when $unavailable is unavailable ($present, $mode)', async ({ unavailable, present, mode }) => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: present ? 'first-present' : 'first-absent',
      accountEncryptionMode: mode, unprivilegedPackageFactUnavailable: unavailable });
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources: fixture.sources, mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
    expect(plan.recipePlans?.[0]?.plan.nativeFacts[0]?.status).toBe('unavailable');
    expect(await fixture.apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions,
      recipePlans: plan.recipePlans ?? [] }, context: fixture.context('machines.setup.apply') }))
      .toMatchObject({ operationId: expect.any(String) });
    const item = fixture.sources[0]!.setup.items![0]!;
    if (item.kind === 'app') throw new Error('Expected the native package recipe');
    const itemKey = machineSetupItemKeyV1(item);
    expect(fixture.machine.metadata?.setup?.sourceFacts?.direct?.firstPresence?.[itemKey]).toBe(present ? 'present' : 'absent');
    expect((await fixture.readInstalled()).installed).toBe(true);
    const removal = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources: [{ kind: 'direct', setup: {} }], mode: 'effects',
        removeItemKeys: present ? [] : [itemKey] }, context: fixture.context('machines.setup.plan'),
    }));
    if (present) {
      expect(removal.removalOffers).toContainEqual(expect.objectContaining({ itemKey, status: 'notEligible', reason: 'preExisting' }));
      expect(removal.removalPlans).toEqual([]);
    } else {
      expect(removal.removalPlans).toHaveLength(1);
      expect(await fixture.machineSetupRemove({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
        desiredRevision: removal.desiredRevision, sources: removal.sources, exclusions: removal.exclusions,
        removeItemKeys: [itemKey], removalPlans: removal.removalPlans ?? [] }, context: fixture.context('machines.setup.remove') }))
        .toMatchObject({ operationId: expect.any(String) });
      expect((await fixture.readInstalled()).installed).toBe(false);
    }
  });
  it('checks and publishes OS updates through Plan without changing desired Software or loading recipes', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const commands: string[] = [];
    const planAction = createMachineSetupPlanAction({ apiMachine: fixture.client,
      machineId: fixture.machine.id, homeId: 'srv_home', runNative: async command => {
        commands.push(command.executable);
        if (command.executable === 'apt-get') return { code: 0, stdout: 'apt 2.6', stderr: '' };
        if (command.executable === 'python3') return { code: 0, stdout: JSON.stringify({ architecture: 'amd64', packages: [
          { name: 'jq', version: '1.0', architecture: 'amd64', security: true },
        ] }), stderr: '' };
        if (command.executable === 'test') return { code: 0, stdout: '', stderr: '' };
        throw new Error(`Unexpected native read: ${command.executable}`);
      } });
    const before = fixture.machine.metadata?.setup;
    const input = MachineSetupPlanInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
      mode: 'check', updates: { scope: 'all' } });
    const result = MachineSetupPlanResultV1Schema.parse(await planAction({ input, context: fixture.context('machines.setup.plan') }));
    expect(result).toMatchObject({ updates: { observation: {
      status: 'drifted', backend: 'apt', pendingAll: 1, pendingSecurity: 1, rebootNeeded: true,
    } } });
    expect(fixture.machine.daemonState?.setup?.updates).toEqual(result.updates?.observation);
    expect(fixture.machine.metadata?.setup).toEqual(before);
    expect(fixture.metadataWrites).toHaveLength(0);
    expect(commands).toEqual(['apt-get', 'python3', 'test']);
  });
  it('observes pending updates once after native Software settlement and publishes the reboot fact', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources: fixture.sources, mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
    expect(await fixture.apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions,
      recipePlans: plan.recipePlans ?? [] }, context: fixture.context('machines.setup.apply') }))
      .toMatchObject({ operationId: expect.any(String) });
    expect(fixture.machine.daemonState?.setup?.updates).toEqual({ status: 'satisfied', backend: 'apt',
      pendingAll: 0, pendingSecurity: 0, rebootNeeded: false });
    expect(JSON.parse(await readFile(fixture.statePath, 'utf8'))).toMatchObject({ installed: true, updatesChecks: 1 });
  });
});

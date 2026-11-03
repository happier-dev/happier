import { describe, expect, it } from 'vitest';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createNativeSoftwareInstallFixture, osStore } from '@/testkit/machines/nativeSoftwareInstall';
import { ApiMachineClient } from '@/api/apiMachine';
import { createMachineSetupAction } from './machineSetupAction';
import { createMachineSetupUpdatesAction } from './machineSetupUpdatesAction';

describe('Machine admin Setup runtime', () => {
  it('applies as the installed daemon when Agent isolation is enabled but Agent provisioning is unavailable', async () => {
    let agentIdentityReads = 0;
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', agentIsolation: {
      read: () => ({ enabled: true, workspaceRoots: [],
        status: { kind: 'unavailable', code: 'provisioning_unavailable' } }),
      resolveRequesterIdentity: async () => { agentIdentityReads++; throw new Error('No Agent identity for admin work'); },
    } });
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources: fixture.sources, mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
    expect(await fixture.apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions,
      recipePlans: plan.recipePlans ?? [] }, context: fixture.context('machines.setup.apply') }))
      .toMatchObject({ operationId: expect.any(String) });
    expect((await fixture.readInstalled()).installed).toBe(true);
    expect(fixture.rootLaunches).toHaveLength(1);
    expect(agentIdentityReads).toBe(0);
  });

  it.each(['installed_runtime', 'finite_terminal'] as const)('preserves the %s refusal branch before native work', async branch => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const client = branch === 'finite_terminal'
      ? new ApiMachineClient(fixture.credentials.token, fixture.machine) : fixture.client;
    if (branch === 'installed_runtime') osStore.credentials = null;
    const apply = createMachineSetupAction({ apiMachine: client, machineId: fixture.machine.id,
      homeId: 'srv_home', installation: fixture.installation });
    expect(await apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: 0, sources: fixture.sources, exclusions: [], recipePlans: [] },
    context: fixture.context('machines.setup.apply') })).toEqual({ ok: false,
      errorCode: 'target_unavailable', error: 'target_unavailable',
      details: { kind: 'machineSetup', failure: { kind: 'target_unavailable', phase: 'machine_setup_target', branch,
        ...(branch === 'installed_runtime' ? { reason: 'credentials' } : {}) } } });
    expect(fixture.rootLaunches).toEqual([]);
    expect((await fixture.readInstalled()).installed).toBe(false);
  });

  it('preserves the same installed-runtime refusal for OS updates', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const reviewed = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, mode: 'effects', updates: { scope: 'security' } },
      context: fixture.context('machines.setup.plan'),
    }));
    if (!reviewed.updates?.plan) throw new Error('Expected a reviewed OS update plan');
    osStore.credentials = null;
    const update = createMachineSetupUpdatesAction({ apiMachine: fixture.client, machineId: fixture.machine.id,
      homeId: 'srv_home', installation: fixture.installation });
    expect(await update({ input: { homeId: 'srv_home', machineId: fixture.machine.id, scope: 'security',
      plan: reviewed.updates.plan }, context: fixture.context('machines.setup.updates.apply') })).toEqual({
      ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
      details: { kind: 'machineSetup', failure: { kind: 'target_unavailable', phase: 'machine_setup_target',
        branch: 'installed_runtime', reason: 'credentials' } },
    });
    expect(fixture.rootLaunches).toEqual([]);
  });
});

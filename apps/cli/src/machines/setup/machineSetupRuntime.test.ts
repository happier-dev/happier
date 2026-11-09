import { describe, expect, it } from 'vitest';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createNativeSoftwareInstallFixture, osStore } from '@/testkit/machines/nativeSoftwareInstall';
import { ApiMachineClient } from '@/api/apiMachine';
import { createMachineSetupAction } from './machineSetupAction';
import { createMachineSetupUpdatesAction } from './machineSetupUpdatesAction';
import { MachineSetupSourceV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';

describe('Machine admin Setup runtime', () => {
  it('plans and applies bundled recipe inputs while retaining the exact preset identity and authored structure', async () => {
    const ref = { pluginId: 'com.example.reviewed-bundle', recipeId: 'package', revision: '1' };
    const authoredSetup = { items: [{ kind: 'setupRecipe', selection: { ref, inputs: {} } }] };
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', additionalPlugins: [{ files: {}, manifest: {
      schemaVersion: 2, id: ref.pluginId, version: '1.0.0', displayName: 'Reviewed bundle', runtime: { apiVersion: 1 },
      contributes: {
        machineRecipes: [{ id: ref.recipeId, revision: ref.revision, title: 'Package',
          inputSchema: { type: 'object', properties: { package: { type: 'string', enum: ['jq'] } },
            required: ['package'], additionalProperties: false },
          steps: [{ id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'jq', version: '1.0' }] }],
        }],
        machineSetupPresets: [{ id: 'reviewed', revision: '1', title: 'Reviewed bundle',
          description: 'Review the package before applying.', setup: authoredSetup }],
      },
    } }] });
    const sources = MachineSetupSourceV1Schema.parse([
      { kind: 'bundledPreset', ref: { pluginId: ref.pluginId, localId: 'reviewed', revision: '1' },
        setup: { items: [{ kind: 'setupRecipe', selection: { ref, inputs: { package: 'jq' } } }] } },
      { kind: 'direct', setup: {} },
    ]);
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, sources, mode: 'effects' },
      context: fixture.context('machines.setup.plan'),
    }));
    expect(plan.sources).toEqual(sources);
    expect((await fixture.readInstalled()).installed).toBe(false);
    const input = { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions,
      recipePlans: plan.recipePlans ?? [] };
    for (const [index, changed] of [
      { ...sources[0], ref: { pluginId: ref.pluginId, localId: 'reviewed', revision: '2' } },
      { ...sources[0], setup: { ...sources[0]!.setup, scripts: [{ body: 'echo substituted' }] } },
      { ...sources[0], setup: { items: [{ kind: 'setupRecipe', selection: { ref: { ...ref, revision: '2' }, inputs: { package: 'jq' } } }] } },
      { ...sources[0], setup: { items: [{ kind: 'softwareRecipe', selection: { ref, inputs: { package: 'jq' } } }] } },
    ].entries()) {
      expect(await fixture.apply({ input: { ...input,
        sources: MachineSetupSourceV1Schema.parse([changed, sources[1]]) }, context: fixture.context('machines.setup.apply', `bundle-refusal-${index}`) }))
        .toMatchObject({ ok: false, errorCode: 'machine_setup_preset_unavailable' });
    }
    const invalidInputs = MachineSetupSourceV1Schema.parse([
      { ...sources[0], setup: { items: [{ kind: 'setupRecipe', selection: { ref, inputs: { package: 42 } } }] } }, sources[1],
    ]);
    expect(await fixture.machineSetupPlan({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
      sources: invalidInputs, mode: 'effects' }, context: fixture.context('machines.setup.plan') }))
      .toMatchObject({ ok: false, errorCode: 'invalid_machine_recipe_inputs' });
    expect(await fixture.apply({ input: { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions,
      recipePlans: plan.recipePlans ?? [] }, context: fixture.context('machines.setup.apply', 'bundle-reviewed') }))
      .toMatchObject({ operationId: expect.any(String) });
    expect((await fixture.readInstalled()).installed).toBe(true);
    const saved = await fixture.client.getMachineSetupDesiredSnapshot();
    expect(saved.status).toBe('ready');
    if (saved.status === 'ready') expect(saved.policy.sources).toEqual(sources);
  });

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

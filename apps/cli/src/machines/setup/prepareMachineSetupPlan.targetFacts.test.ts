import { describe, expect, it } from 'vitest';
import { getMachineSetupDesiredV1, MachineSetupPlanInputV1Schema } from '@happier-dev/protocol';
import { MachineRecipeV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { MachineAdminAccessObservationV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { createMachineSetupNativeBackend } from '@happier-dev/cli-common/machineSetup';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildPluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { machineRecipesProjectionFamily } from '@/plugins/projection/registry/machineRecipes';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createMachineAdminAccessObserver } from '../adminAccess/observeMachineAdminAccess';
import { prepareMachineSetupPlanV1 } from './prepareMachineSetupPlan';
import { prepareMachineRecipeProgramV1 } from './prepareMachineRecipeProgram';

describe('Machine setup target facts through P10 observation', () => {
  it('prepares a descriptor program from exact role inputs without manufacturing a recipe selection or applying effects', async () => {
    const recipe = MachineRecipeV1Schema.parse({ id: 'native-membership', revision: '1', title: 'Native membership',
      inputSchema: { type: 'object', properties: { profile: { type: 'string' }, enabled: { type: 'boolean' } },
        required: ['profile', 'enabled'], additionalProperties: false },
      steps: [{ id: 'join', kind: 'command', executable: 'native-network',
        args: ['join', { kind: 'input', path: 'profile' }],
        check: { executable: 'native-network', args: ['status'], unsatisfiedExitCodes: [1],
          stdoutJson: { op: 'eq', path: 'profile', value: { kind: 'input', path: 'profile' } } },
        when: [{ input: { op: 'truthy', path: 'enabled' } }],
      }] });
    const nativeCommands: Readonly<{ executable: string; args: readonly string[] }>[] = [];
    const backend = createMachineSetupNativeBackend({ run: async command => {
      nativeCommands.push({ executable: command.executable, args: command.args });
      return { code: 0, stdout: JSON.stringify({ profile: 'reviewed-network' }), stderr: '' };
    } });
    // Exercise the real owner before its raw-input overload exists, without
    // making the shared test module depend on that future TypeScript shape.
    const prepare = async (inputs: unknown): Promise<unknown> => Reflect.apply(prepareMachineRecipeProgramV1, undefined, [{
      machineId: 'guest', desiredRevision: 2, recipe, program: 'steps', inputs, backend,
    }]);
    const result = await prepare({ profile: 'reviewed-network', enabled: true });
    expect(result).toMatchObject({ basis: { kind: 'setup', machineId: 'guest', desiredRevision: 2 },
      steps: [{ args: ['join', 'reviewed-network'], check: {
        stdoutJson: { op: 'eq', path: 'profile', value: 'reviewed-network' },
      } }], nativeFacts: [{ stepId: 'join', status: 'satisfied' }],
    });
    expect(result).not.toHaveProperty('basis.selection');
    expect(nativeCommands).toEqual([{ executable: 'native-network', args: ['status'] }]);
    nativeCommands.length = 0;
    expect(await prepare({ profile: 'reviewed-network', enabled: false })).toMatchObject({ steps: [], nativeFacts: [] });
    expect(nativeCommands).toEqual([]);
  });

  it('binds daemon username and group from one captured P10 observation without another identity read', async () => {
    let username = 'daemon-user';
    let identityReads = 0;
    const observer = createMachineAdminAccessObserver({ platform: 'linux',
      execFile: async (file, args) => {
        if (file === 'id') { identityReads++; return { stdout: args[0] === '-u' ? '1001' : args[0] === '-un' ? username
          : args[0] === '-gn' ? 'machine-operators' : 'machine-operators' }; }
        return { stdout: '' };
      },
      fileSystem: { lstat: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
        readFile: async () => { throw new Error('Absent file'); } }, onChanged: async () => {},
    });
    let observation = (await observer.inspect()).observation;
    const definition = MachineRecipeV1Schema.safeParse({ id: 'daemon-config', revision: '1', title: 'Daemon config',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [
        { id: 'config', kind: 'file', path: '/run/happier-target-fact-test/daemon.conf', owner: 'root', group: 'root', mode: 0o600,
          content: { kind: 'template', value: 'User={user}\nGroup={group}\n', variables: {
            user: { kind: 'targetFact', fact: 'daemon.username' }, group: { kind: 'targetFact', fact: 'daemon.primaryGroup' },
          } } },
      ] });
    expect(definition.success, 'Both daemon identity facts are admitted at the shared declaration owner').toBe(true);
    if (!definition.success) throw new Error('Expected the admitted daemon identity declaration');
    const pluginId = 'com.example.machine-tools';
    const current = await getMachineSetupDesiredV1({ read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
      compareAndSwap: async () => { throw new Error('Planning cannot mutate'); } });
    const input = MachineSetupPlanInputV1Schema.parse({ homeId: 'home', machineId: 'guest', mode: 'effects', sources: [
      { kind: 'direct', setup: { items: [{ kind: 'setupRecipe', selection: {
        ref: { pluginId, recipeId: definition.data.id, revision: definition.data.revision }, inputs: {},
      } }] } },
    ] });
    let observationReads = 0;
    let nativeReads = 0;
    const params = { input, current, readRecipes: async () => [{ id: `${pluginId}/daemon-config`, pluginId,
      pluginVersion: '1.0.0', definition: definition.data }],
      readAdminAccessObservation: async () => { observationReads++; return observation; },
      runNative: async () => { nativeReads++; return { code: 0, stdout: '0', stderr: '' }; } };
    const baselineReads = identityReads;
    const first = await prepareMachineSetupPlanV1(params);
    expect(first).toMatchObject({ recipePlans: [{ plan: { steps: [{ content: {
      kind: 'literal', value: 'User=daemon-user\nGroup=machine-operators\n',
    } }] } }] });
    expect(observationReads).toBe(1);
    expect(identityReads).toBe(baselineReads);
    username = 'replacement-daemon';
    observation = (await observer.inspect()).observation;
    const changed = await prepareMachineSetupPlanV1(params);
    if ('ok' in first || 'ok' in changed) throw new Error('Expected complete plans');
    expect(changed.recipePlans![0]!.plan.planDigest).not.toBe(first.recipePlans![0]!.plan.planDigest);
    observation = MachineAdminAccessObservationV1Schema.parse({ ...observation, daemonUsername: null });
    nativeReads = 0;
    expect(await prepareMachineSetupPlanV1(params)).toMatchObject({ ok: false, errorCode: 'machine_recipe_target_fact_unavailable' });
    expect(nativeReads).toBe(0);
  });

  it('binds the observed primary group into exact ownership, rendered content and the plan digest', async () => {
    let group = 'machine-operators';
    let identityReads = 0;
    const observer = createMachineAdminAccessObserver({ platform: 'linux',
      execFile: async (file, args) => {
        if (file === 'id') { identityReads++; return { stdout: args[0] === '-u' ? '1001' : args[0] === '-un' ? 'daemon-user'
          : args[0] === '-gn' ? group : 'machine-operators' }; }
        return { stdout: '' };
      },
      fileSystem: { lstat: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
        readFile: async () => { throw new Error('Absent file'); } },
      onChanged: async () => {},
    });
    let observation = (await observer.inspect()).observation;
    const baselineReads = identityReads;
    const fact = { kind: 'targetFact', fact: 'daemon.primaryGroup' };
    const definition = MachineRecipeV1Schema.parse({ id: 'private-service', revision: '1', title: 'Private service',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [
        { id: 'socket', kind: 'directory', path: '/run/happier-target-fact-test', owner: 'root', group: fact, mode: 0o750 },
        { id: 'config', kind: 'file', path: '/run/happier-target-fact-test/service.conf', owner: 'root', group: 'root', mode: 0o600,
          content: { kind: 'template', value: 'Group={daemonGroup}\n', variables: { daemonGroup: fact } } },
      ] });
    const pluginId = 'com.example.machine-tools';
    const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Tools',
      runtime: { apiVersion: 1 }, contributes: { machineRecipes: [definition] } });
    const registry = createResolvedContributionRegistry({ ...projectLoadedPluginContributes({ provenance: 'external', loadResult: {
      loadedPlugins: [{ pluginId, pluginRootPath: '/plugins/tools', manifestPath: '/plugins/tools/plugin.json', daemonEntryPath: null,
        devDaemonEntryPath: null, sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest }],
      diagnosticsByPluginId: {},
    } }), occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
    const recipes = Object.values(buildPluginProjectionFamilyV2({ registry, generation: 1 }, machineRecipesProjectionFamily).entriesById);
    const current = await getMachineSetupDesiredV1({ read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
      compareAndSwap: async () => { throw new Error('Planning cannot mutate'); } });
    const input = MachineSetupPlanInputV1Schema.parse({ homeId: 'home', machineId: 'guest', mode: 'effects', sources: [
      { kind: 'direct', setup: { items: [{ kind: 'setupRecipe',
        selection: { ref: { pluginId, recipeId: definition.id, revision: definition.revision }, inputs: {} } }] } },
    ] });
    let observationReads = 0;
    let nativeReads = 0;
    const params = { input, current, readRecipes: async () => recipes,
      readAdminAccessObservation: async () => { observationReads++; return observation; },
      runNative: async () => { nativeReads++; return { code: 0, stdout: '0', stderr: '' }; } };
    const first = await prepareMachineSetupPlanV1(params);
    expect(first).toMatchObject({ recipePlans: [{ plan: { steps: [
      { group: 'machine-operators' }, { content: { kind: 'literal', value: 'Group=machine-operators\n' } },
    ] } }] });
    expect(observationReads).toBe(1);
    expect(identityReads).toBe(baselineReads);
    group = 'replacement-operators';
    observation = (await observer.inspect()).observation;
    const changed = await prepareMachineSetupPlanV1(params);
    if ('ok' in first || 'ok' in changed) throw new Error('Expected complete plans');
    expect(changed.recipePlans![0]!.plan.planDigest).not.toBe(first.recipePlans![0]!.plan.planDigest);
    for (const daemonPrimaryGroup of [undefined, null]) {
      observation = MachineAdminAccessObservationV1Schema.parse({ ...observation, daemonPrimaryGroup });
      nativeReads = 0;
      expect(await prepareMachineSetupPlanV1(params)).toMatchObject({ ok: false, errorCode: 'machine_recipe_target_fact_unavailable' });
      expect(nativeReads).toBe(0);
    }
    const literal = MachineRecipeV1Schema.parse({ ...definition, steps: [{ id: 'socket', kind: 'directory',
      path: '/run/happier-target-fact-test', owner: 'root', group: 'root', mode: 0o750 }] });
    observationReads = 0;
    expect(await prepareMachineSetupPlanV1({ ...params, readRecipes: async () => recipes.map(entry => ({ ...entry, definition: literal })) }))
      .toMatchObject({ recipePlans: [{ plan: { steps: [{ group: 'root' }] } }] });
    expect(observationReads).toBe(0);
    const skipped = MachineRecipeV1Schema.parse({ ...definition,
      steps: definition.steps.map(step => ({ ...step, when: [{ input: { op: 'truthy', path: 'unselected' } }] })) });
    nativeReads = 0;
    expect(await prepareMachineSetupPlanV1({ ...params, readRecipes: async () => recipes.map(entry => ({ ...entry, definition: skipped })) }))
      .toMatchObject({ recipePlans: [{ plan: { steps: [] } }] });
    expect(observationReads).toBe(0);
    expect(nativeReads).toBe(0);
  });
});

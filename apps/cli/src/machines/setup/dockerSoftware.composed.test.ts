import { expect, it } from 'vitest';
import { createActionExecutor, getMachineSetupDesiredV1 } from '@happier-dev/protocol';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { applyMachineSetupEffectPlan, createMachineSetupNativeBackend,
  type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/machine-recipes/src/manifest';
import { createMachineRecipeReadAction } from './machineRecipeActionDeps';
import { createMachineSetupPlanAction } from './machineSetupAction';

const ref = { pluginId: 'happier.machine.recipes', recipeId: 'docker-engine', revision: '1' };
const ok = (stdout = ''): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });

// Only native command execution is substituted. Admission, cold projection,
// Action discovery/Plan, package selection and Apply's interpreter remain real.
async function fixture(family: 'ubuntu' | 'debian' | 'other', engine: 'absent' | 'ready' | 'denied' = 'absent') {
  const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ files: {}, manifest: PLUGIN_MANIFEST }] });
  const acquire = () => acquireAuthoritativePluginRuntimeRegistryLease({ controller: runtime.controller, happyHomeDir: runtime.happyHomeDir });
  const calls: MachineSetupNativeCommand[] = [];
  const installed = new Set<string>();
  const effects: string[][] = [];
  const run = async (command: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> => {
    calls.push(command);
    if (command.executable === 'which') return engine === 'absent' ? { code: 1, stdout: '', stderr: '' } : ok('/usr/bin/docker\n');
    if (command.executable === 'grep') return { code: family === 'other' ? 1
      : command.args[1]?.includes('ubuntu|debian') || family === 'ubuntu' ? 0 : 1, stdout: '', stderr: '' };
    if (command.executable === 'sh' || command.executable === '/bin/sh') {
      const body = command.inputBytes ? Buffer.from(command.inputBytes).toString() : command.args.join(' ');
      if (body.includes('docker info')) return { code: engine === 'ready' ? 0 : engine === 'denied' ? 2 : 1, stdout: '', stderr: '' };
    }
    if (command.executable === 'dpkg') return ok('amd64\n');
    if (command.executable === 'apt-get') {
      if (command.args[0] === '--version') return ok('apt 3.0\n');
      effects.push([...command.args]);
      if (command.args[0] === 'install') {
        for (const name of command.args.filter(arg => arg.startsWith('docker'))) installed.add(name.split(/[=:]/)[0]!);
        engine = 'ready';
      }
      return ok();
    }
    if (command.executable === 'dpkg-query') {
      const names = command.args.slice(command.args.indexOf('--') + 1);
      return { code: names.every(name => installed.has(name)) ? 0 : 1, stderr: '',
        stdout: names.filter(name => installed.has(name)).map(name => `${name}\tinstall ok installed\t1\tamd64\n`).join('') };
    }
    if (command.executable === 'lslocks') return ok('{"locks":[]}');
    if (command.executable === 'apt-cache') {
      const name = command.args.at(-1)!.split('=')[0]!;
      return ok(command.args[0] === 'policy' ? `${name}:\n  Candidate: 1\n  Version table:\n     1 500\n`
        : `Package: ${name}\nVersion: 1\nArchitecture: amd64\n\n`);
    }
    throw new Error(`Unexpected OS command: ${command.executable} ${command.args.join(' ')}`);
  };
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    machineRecipesRead: createMachineRecipeReadAction({ homeId: 'home', machineId: 'machine',
      acquirePluginRuntimeRegistryLease: acquire, isCurrent: async () => true }),
    machineSetupPlan: createMachineSetupPlanAction({ homeId: 'home', machineId: 'machine',
      apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
        read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
        compareAndSwap: async () => { throw new Error('Plan cannot write desired state'); },
      }) }, acquirePluginRuntimeRegistryLease: acquire, runNative: run }),
  });
  const context = { surface: 'agent' as const, authority: 'present_user' as const };
  const plan = () => executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'machine', sources: [{
    kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: { ref, inputs: {} } }] },
  }] }, context);
  return { runtime, executor, context, plan, calls, effects, run, installed };
}

it.each(['agent', 'ui'] as const)('offers Docker through the shared Software Action owner for %s', async surface => {
  const f = await fixture('ubuntu');
  try {
    expect(await f.executor.execute('action.options.resolve', {
      actionId: 'machines.setup.plan', fieldPath: 'sources.0.setup.items.0.selection.ref',
      draftInput: { homeId: 'home', machineId: 'machine' },
    }, { ...f.context, surface })).toMatchObject({ ok: true, result: {
      optionsSourceId: 'machines.setup.software.available', options: expect.arrayContaining([expect.objectContaining({ value: ref,
        label: 'Docker Engine', version: '0.0.0', icon: 'desktop' })]),
    } });
    expect(f.calls).toEqual([]);
  } finally { await f.runtime.dispose(); }
});

it.each(['ubuntu', 'debian'] as const)('plans read-only and applies %s distro packages, retaining shared state on removal', async family => {
  const f = await fixture(family);
  try {
    const result = await f.plan();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { support: [{ status: 'drifted' }] } });
    if (!result.ok) throw new Error('Docker Plan unavailable');
    const plan = MachineSetupPlanResultV1Schema.parse(result.result).recipePlans?.[0]?.plan;
    if (!plan) throw new Error('Docker Plan missing');
    expect(f.effects).toEqual([]);
    const packages = ['docker.io', 'docker-buildx', family === 'ubuntu' ? 'docker-compose-v2' : 'docker-compose'];
    expect(plan.steps.filter(step => step.kind === 'package')).toMatchObject([{ manager: 'apt', packages: packages.map(name => ({ name })) }]);
    expect(PLUGIN_MANIFEST.contributes.machineRecipes?.find(recipe => recipe.id === ref.recipeId)?.removeSteps ?? []).toEqual([]);
    expect(plan.steps).toEqual(expect.arrayContaining([expect.objectContaining({ affects: 'dockerEngine' })]));
    const applied = await applyMachineSetupEffectPlan({ plan, backend: createMachineSetupNativeBackend({ run: f.run }) });
    expect(applied, JSON.stringify(applied)).toMatchObject({ status: 'applied' });
    expect([...f.installed]).toEqual(packages);
    expect(f.effects.filter(args => args[0] === 'install')).toHaveLength(1);
  } finally { await f.runtime.dispose(); }
});

it('treats an existing reachable engine as satisfied without package probes or changes', async () => {
  const f = await fixture('other', 'ready');
  try {
    expect(await f.plan()).toMatchObject({ ok: true, result: { support: [{ status: 'satisfied' }],
      recipePlans: [{ plan: { nativeFacts: [{ status: 'satisfied' }] } }] } });
    expect(f.calls.map(command => command.executable)).toEqual(['which', 'sh']);
    expect(f.effects).toEqual([]);
  } finally { await f.runtime.dispose(); }
});

it.each([['other', 'absent'], ['ubuntu', 'denied']] as const)('refuses unsupported or inaccessible native facts (%s, %s)', async (family, engine) => {
  const f = await fixture(family, engine);
  try {
    expect(await f.plan()).toMatchObject({ ok: true, result: { support: [{ status: 'unavailable' }] } });
    expect(f.effects).toEqual([]);
    expect(f.calls.some(command => command.executable === 'apt-get')).toBe(false);
  } finally { await f.runtime.dispose(); }
});

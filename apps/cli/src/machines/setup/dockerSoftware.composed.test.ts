import { expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createActionExecutor, getMachineSetupDesiredV1 } from '@happier-dev/protocol';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { applyMachineSetupEffectPlan, createMachineSetupEffectPlan, createMachineSetupNativeBackend,
  type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/machine-recipes/src/manifest';
import { createMachineRecipeReadAction } from './machineRecipeActionDeps';
import { createMachineSetupPlanAction } from './machineSetupAction';
import { applyMachineSetup } from './applyMachineSetup';
import { runMachineSetupEffectInternal } from './effectInternal';
import type { MachineElevationDependencies, MachineElevationSpawn } from '../adminAccess/runElevatedEffect';
import { prepareMachineSetupPlanV1 } from './prepareMachineSetupPlan';
import { groupMachineSetupChanges } from '../../../../../apps/ui/sources/components/settings/machines/managed/machineSetupReviewChanges';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { readNativeComposeEngine } from '@/daemon/local/services/launch/nativeComposeEngine';
import { prepareDedicatedDaemonBootstrap, MachineEffectInternalRequestSchema } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';

const ref = { pluginId: 'happier.machine.recipes', recipeId: 'docker-engine', revision: '1' };
const ok = (stdout = ''): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });

// Only native command execution is substituted. Admission, cold projection,
// Action discovery/Plan, package selection and Apply's interpreter remain real.
async function fixture(family: 'ubuntu' | 'debian' | 'other', engine: 'absent' | 'ready' | 'denied' = 'absent', refreshFails = false) {
  const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ files: {}, manifest: PLUGIN_MANIFEST }] });
  const acquire = () => acquireAuthoritativePluginRuntimeRegistryLease({ controller: runtime.controller, happyHomeDir: runtime.happyHomeDir });
  const calls: MachineSetupNativeCommand[] = [];
  const installed = new Set<string>();
  const effects: string[][] = [];
  let member = false;
  const groups = [1000];
  const run = async (command: MachineSetupNativeCommand, administrator = false): Promise<MachineSetupNativeCommandResult> => {
    calls.push(command);
    if (command.executable === 'getent') return ok(command.args.includes('group')
      ? `docker:x:109:${member ? 'happier' : ''}\n` : 'happier:x:1000:1000::/home/happier:/bin/bash\n');
    if (command.executable === 'id') return ok(member ? '1000 109\n' : '1000\n');
    if (command.executable === 'usermod') { member = true; effects.push(['usermod']); return ok(); }
    if (command.executable === 'systemctl') {
      if (command.args.includes('docker.service')) return ok('LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n');
      if (command.args[0] === 'show') return ok('MainPID=27\nActiveState=active\n');
      effects.push([...command.args]);
      if (refreshFails) return { code: 1, stdout: '', stderr: 'User manager restart failed' };
      if (member) groups.splice(0, groups.length, 1000, 109);
      return ok();
    }
    if (command.executable === 'cat') return ok(`Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t${groups.join(' ')}\n`);
    if (command.executable === 'docker') return groups.includes(109) && engine !== 'absent'
      ? ok('Docker Engine\n') : { code: 1, stdout: '', stderr: 'permission denied' };
    if (command.executable === 'which') return engine === 'absent' ? { code: 1, stdout: '', stderr: '' } : ok('/usr/bin/docker\n');
    if (command.executable === 'grep') return { code: family === 'other' ? 1
      : command.args[1]?.includes('ubuntu|debian') || family === 'ubuntu' ? 0 : 1, stdout: '', stderr: '' };
    if (command.executable === 'sh' || command.executable === '/bin/sh') {
      const body = command.inputBytes ? Buffer.from(command.inputBytes).toString() : command.args.join(' ');
      if (body.includes('docker info')) return { code: engine === 'absent' ? 1 : administrator || groups.includes(109)
        ? 0 : body.includes('|| exit 1') ? 1 : 2, stdout: '', stderr: '' };
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
      }), captureMachineAdminAccess: () => ({ observe: async () => observation,
        readPolicy: async () => ({ version: 1, mode: 'preauthorized' }) }) }, acquirePluginRuntimeRegistryLease: acquire, runNative: run }),
  });
  const context = { surface: 'agent' as const, authority: 'present_user' as const };
  const plan = () => executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'machine', sources: [{
    kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: { ref, inputs: {} } }] },
  }] }, context);
  const observation = { version: 1 as const, observedAt: 0, daemonUid: 1000, daemonUsername: 'happier', daemonIdentity: 'nonRoot' as const,
    rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed' as const, managedDropIn: 'valid' as const,
    tailscaledOperator: { authorization: 'unknown' as const } };
  return { runtime, executor, context, plan, calls, effects, run, installed, groups, observation,
    grant: () => { member = true; } };
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
    const applied = await applyMachineSetupEffectPlan({ plan, backend: createMachineSetupNativeBackend({ run: command => f.run(command, true) }) });
    expect(applied, JSON.stringify(applied)).toMatchObject({ status: 'applied' });
    expect([...f.installed]).toEqual(packages);
    expect(f.effects.filter(args => args[0] === 'install')).toHaveLength(1);
  } finally { await f.runtime.dispose(); }
});

it('repairs daemon membership without replacing an existing Docker engine with distro packages', async () => {
  const f = await fixture('ubuntu', 'ready');
  try {
    expect(await f.plan()).toMatchObject({ ok: true, result: { support: [{ status: 'drifted' }] } });
    const result = await f.plan();
    if (!result.ok) throw new Error('Docker Plan unavailable');
    const plan = MachineSetupPlanResultV1Schema.parse(result.result).recipePlans?.[0]?.plan;
    if (!plan) throw new Error('Docker Plan missing');
    expect(plan.steps.some(step => step.kind === 'package')).toBe(false);
    expect(plan.steps.some(step => step.kind === 'serviceUnit')).toBe(false);
    expect(await applyMachineSetupEffectPlan({ plan, backend: createMachineSetupNativeBackend({ run: command => f.run(command, true) }) }))
      .toMatchObject({ status: 'applied' });
    expect(f.effects).toEqual([['usermod']]);
    f.grant();
    f.groups.push(109);
    expect(await f.plan()).toMatchObject({ ok: true, result: { support: [{ status: 'satisfied' }] } });
    expect([...f.installed]).toEqual([]);
  } finally { await f.runtime.dispose(); }
});

it.each(['ubuntu', 'debian'] as const)('bootstrap and Software use identical %s Docker steps for fresh and existing engines', async family => {
  for (const engine of ['absent', 'ready'] as const) {
    const f = await fixture(family, engine);
    try {
      const result = await f.plan();
      if (!result.ok) throw new Error('Docker Plan unavailable');
      const plan = MachineSetupPlanResultV1Schema.parse(result.result).recipePlans?.[0]?.plan;
      if (!plan) throw new Error('Docker Plan missing');
      let bootstrapSteps: typeof plan.steps | undefined;
      await prepareDedicatedDaemonBootstrap({ task: { taskId: 'docker-owner-parity',
        enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'deployTarget', adminAccessAtCreation: 'none' },
        sshTarget: 'root@machine', relayUrl: 'https://home.example' },
        binaryPath: '/opt/happier/cli/current/happier', channel: 'stable', createPromptId: () => 'unused', emit: () => {},
        prompt: async () => { throw new Error('No administrator establishment expected'); },
        exec: async request => {
          if (request.command.includes('/etc/os-release')) return { status: 0, stdout: `${family}\n`, stderr: '' };
          if (request.command === 'id -u happier') return { status: 0, stdout: '1000\n', stderr: '' };
          if (request.command === 'which docker') return { status: engine === 'ready' ? 0 : 1, stdout: engine === 'ready' ? '/usr/bin/docker\n' : '', stderr: '' };
          const frame = MachineEffectInternalRequestSchema.parse(JSON.parse(request.input!.trim()));
          if (frame.mode === 'check' && 'steps' in frame) {
            bootstrapSteps = frame.steps.filter(step => step.id.startsWith('docker-'));
            const checked = createMachineSetupEffectPlan({ basis: frame.basis, steps: frame.steps,
              nativeFacts: frame.steps.map(step => ({ stepId: step.id, status: 'satisfied', facts: {} })) });
            return { status: 0, stdout: JSON.stringify({ type: 'result', result: { status: 'checked', plan: checked } }) + '\n', stderr: '' };
          }
          return { status: 0, stdout: JSON.stringify({ type: 'result', result: { status: 'applied', completedStepIds: [], daemonRestartRequired: false } }) + '\n', stderr: '' };
        },
      });
      expect(bootstrapSteps).toEqual(plan.steps);
    } finally { await f.runtime.dispose(); }
  }
});

it.each([['other', 'absent']] as const)('refuses unsupported native facts (%s, %s)', async (family, engine) => {
  const f = await fixture(family, engine);
  try {
    expect(await f.plan()).toMatchObject({ ok: true, result: { support: [{ status: 'unavailable' }] } });
    expect(f.effects).toEqual([]);
    expect(f.calls.some(command => command.executable === 'apt-get')).toBe(false);
  } finally { await f.runtime.dispose(); }
});

it.each([{ configured: false, installed: false, refreshFails: false }, { configured: false, installed: true, refreshFails: false },
  { configured: true, installed: true, refreshFails: false }, { configured: true, installed: true, refreshFails: true }])(
  'Apply preserves terminal success across the post-acknowledgement refresh (%j)', async ({ configured, installed, refreshFails }) => {
  const f = await fixture('ubuntu', installed ? 'ready' : 'absent', refreshFails);
  const uid = vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
  try {
    if (installed) for (const name of ['docker.io', 'docker-buildx', 'docker-compose-v2']) f.installed.add(name);
    if (configured) f.grant();
    expect(await f.run({ executable: 'docker', args: ['info'] })).toMatchObject({ code: 1 });
    const current = await getMachineSetupDesiredV1({ read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
      compareAndSwap: async () => { throw new Error('Plan cannot mutate'); } });
    const groupRefreshNative = { platform: 'linux' as const, user: { username: 'happier', uid: 1000 }, groups: f.groups,
      readCgroup: async () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/happier-daemon.service\n' };
    const reviewed = await prepareMachineSetupPlanV1({ current,
      input: { homeId: 'home', machineId: 'machine', mode: 'effects', sources: [{ kind: 'direct', setup: {
        items: [{ kind: 'softwareRecipe', selection: { ref, inputs: {} } }] } }] },
      readRecipes: async () => [{ id: `${ref.pluginId}/${ref.recipeId}`, pluginId: ref.pluginId, pluginVersion: PLUGIN_MANIFEST.version,
        definition: PLUGIN_MANIFEST.contributes.machineRecipes!.find(recipe => recipe.id === ref.recipeId)! }],
      readAdminAccessObservation: async () => f.observation, runNative: f.run, groupRefreshNative });
    if ('errorCode' in reviewed) throw new Error(reviewed.errorCode);
    expect(reviewed).toMatchObject({ support: [{ status: configured ? 'satisfied' : 'drifted' }], review: { administratorRequired: true,
      requiresSessionRefresh: { scope: 'userServices' } } });
    if (!configured) expect(groupMachineSetupChanges([{ homeId: 'home', machineId: 'machine',
      desiredRevision: reviewed.desiredRevision, sources: reviewed.sources, recipePlans: reviewed.recipePlans ?? [] }])
      .find(group => group.kind === 'users')?.lines.map(line => line.operand).join('\n'))
      .toMatch(/root.equivalent.*administrator/i);
    const spawn: MachineElevationSpawn = launch => {
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const settled = runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1), { stdin, stdout, runNative: command => f.run(command, true) })
        .then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
      return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
    };
    const elevation: MachineElevationDependencies = { installationId: 'installation', installedCli: '/managed/happier', spawn,
      readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true, observe: async () => f.observation };
    let acknowledge!: (value: boolean) => void;
    const homeAcknowledgement = new Promise<boolean>(resolve => { acknowledge = resolve; });
    let refreshFinished!: () => void;
    const refreshed = new Promise<void>(resolve => { refreshFinished = resolve; });
    const operationId = `docker-access-${configured}-${installed}`;
    const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'owner',
      generateOperationId: () => operationId, publishSnapshotAcknowledged: async snapshot => {
        expect(snapshot).toMatchObject({ operationId, state: 'succeeded' });
        return homeAcknowledgement;
      } });
    const execution = operations.observeExecution({ actionId: 'machines.setup.apply', input: {}, execute: async operation => {
      operation.operationAcceptance?.accept({ operationId });
      return await applyMachineSetup({ homeId: 'home', machineId: 'machine', requesterAccountId: 'owner',
      userHomeDirectory: '/home/happier', setup: reviewed.sources.map(source => source.setup), recipePlans: reviewed.recipePlans,
      elevation: { ...elevation, spawn: launch => {
        const child = spawn(launch);
        void child.settled.then(() => {
          if (f.effects.some(args => args[0] === 'restart')) refreshFinished();
        });
        return child;
      } }, groupRefreshNative, isCurrent: async () => true,
      terminalSessions: { ensure() { throw new Error('No terminal expected'); }, waitForExit() { throw new Error('No terminal expected'); },
        requestStop() { throw new Error('No terminal expected'); }, observeOutput() { throw new Error('No terminal expected'); } },
      environmentIo: { resolveTool: async () => null, run: async request => {
        if (request.command !== 'docker') throw new Error('Unexpected engine inspector');
        if (!installed) throw Object.assign(new Error('Docker absent'), { code: 'ENOENT' });
        return { exitCode: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker socket' };
      } },
      operation });
    } });
    expect(await execution).toMatchObject({ ok: true, result: { operationId } });
    const terminal = await operations.handlers.getV2({ operationId, waitForTerminal: true });
    expect(terminal, JSON.stringify(terminal)).toMatchObject({
      kind: 'found', operation: { operationId, state: 'succeeded' } });
    expect(f.effects).not.toContainEqual(['restart', '--', 'user@1000.service']);
    expect(await f.run({ executable: 'docker', args: ['info'] })).toMatchObject({ code: 1 });
    acknowledge(true);
    await refreshed;
    expect(await operations.handlers.getV2({ operationId })).toMatchObject({
      kind: 'found', operation: { operationId, state: 'succeeded' } });
    expect(await f.run({ executable: 'docker', args: ['info'] })).toMatchObject({ code: refreshFails ? 1 : 0 });
    if (refreshFails) await expect(readNativeComposeEngine({ command: 'docker', prefix: [], cwd: '/home/happier', env: {},
      io: { run: async request => {
        const result = await f.run({ executable: request.command, args: [...request.args] });
        if (result.code === null) throw new Error('Docker probe process did not settle');
        return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
      } } })).rejects.toMatchObject({ code: 'native_tool_unavailable', details: { prerequisite: { cause: 'permission_denied' } } });
    expect(await f.plan()).toMatchObject({ ok: true, result: { support: [{ status: 'satisfied' }] } });
    expect(reviewed.recipePlans?.[0]?.plan.steps.find(step => step.kind === 'group')).toMatchObject({
      name: 'docker', members: ['happier'], review: { description: expect.stringMatching(/root.equivalent.*administrator/i) } });
    expect(f.effects).toContainEqual(['restart', '--', 'user@1000.service']);
  } finally { uid.mockRestore(); await f.runtime.dispose(); }
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createDevcontainerProvider } from './provider.js';
import { readDevcontainerEffectReview } from './effectReview.js';
import { DevcontainerLaunchSchema, DevcontainerReviewQuerySchema, DevcontainerResourceSchema, type DevcontainerLaunch, type DevcontainerResource } from './schemas.js';
import { DEVCONTAINER_PLUGIN, DEVCONTAINER_RECONCILIATION_SCHEMAS } from '../manifest.js';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { prepareManagedMachinePresetAuthoringV1, readManagedOpaquePresetAcquireEffectDigestV1, reconcileManagedMachine,
  type ManagedMachineReconciliation } from '../../../../cli-common/src/machines/managed/index.js';
import { ManagedMachineFullV1Schema } from '../../../../protocol/src/machines/managed/managedMachineV1.js';
import { projectManagedEnrollmentCorrelationV1 } from '../../../../protocol/src/machines/managed/actionsV1.js';
import { projectNativeJsonValueForTransport } from '../../../../protocol/src/json/strictJsonValue.js';
import { isRecord } from '../../../../protocol/src/common/records.js';
import { MachinePresetActionInputSchemasV1 } from '../../../../protocol/src/machines/managed/machinePresetActionsV1.js';
import { openManagedMachinePresetRecipientProjectionV1, openManagedMachinePresetContentV1, sealManagedMachinePresetContentV1, replaceManagedMachinePresetLaunchNameV1 } from '../../../../protocol/src/machines/managed/managedMachinePresetContentV1.js';

// The Lima boot marker is an OS boundary; configuration files stay real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, access: vi.fn(actual.access) };
});
async function onLima() {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(access).mockImplementation(async (path, mode) => {
    if (path === '/run/lima-boot-done') return;
    return actual.access(path, mode);
  });
}

const containerId = 'a'.repeat(64);
let launch: DevcontainerLaunch;
let resource: DevcontainerResource;
let configurationRoot: string;
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(access).mockImplementation(async (path, mode) => {
    if (path === '/run/lima-boot-done') throw Object.assign(new Error('No Lima marker in this fixture'), { code: 'ENOENT' });
    return actual.access(path, mode);
  });
  configurationRoot = await mkdtemp(join(tmpdir(), 'happier-devcontainer-native-'));
  await mkdir(join(configurationRoot, '.devcontainer'));
  const query = { workspaceFolder: configurationRoot, configPath: join(configurationRoot, '.devcontainer', 'devcontainer.json') };
  await writeFile(query.configPath, JSON.stringify({ image: 'example:latest' }));
  launch = { ...query, reviewedEffectDigest: '0'.repeat(64) };
  launch = (await readDevcontainerEffectReview(native().tools, query)).launch;
  resource = { ...launch, managedMachineId: 'managed-a', containerId, user: 'coder', workspaceRoot: '/work/custom',
  storage: { kind: 'child' as const, childPath: '/work/custom' },
  volumes: [{ name: 'retained-data', childPath: '/data' }] };
});
afterEach(async () => { vi.unstubAllEnvs(); vi.mocked(access).mockReset(); await rm(configurationRoot, { recursive: true, force: true }); });
function result(value: unknown, exitCode = 0): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
    stdout: new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)), stderr: new Uint8Array(),
    stdoutTruncated: false, stderrTruncated: false };
}
function native(overrides: Readonly<{ runtime?: 'docker' | 'podman'; networkMode?: string; dns?: readonly string[]; dnsExit?: number; hostDnsExit?: number; up?: PluginProcessResult; update?: PluginProcessResult; running?: boolean; paused?: boolean; absent?: boolean; deleteAbsent?: boolean; inventory?: PluginProcessResult; mounts?: unknown; id?: string; namespace?: string; canceledWrite?: boolean; replacementId?: string; rowScoped?: boolean }> = {}) {
  const requests: Parameters<ExecService['run']>[0][] = [];
  let running = overrides.running ?? true;
  let observedId = overrides.id ?? containerId;
  let removed = false;
  let managedMachineId = 'managed-a';
  let cpuCores = 2;
  let memoryBytes = 2 * 1024 ** 3;
  const exec: Pick<ExecService, 'run' | 'spawn'> = { spawn: async () => { throw new Error('No channel in this fixture'); }, run: async request => {
    requests.push(request);
    if (request.args?.includes('getent hosts github.com')) return result('140.82.121.3 github.com\n',
      request.args.includes('--rm') ? overrides.hostDnsExit ?? 0 : overrides.dnsExit ?? 0);
    if (request.args?.[0] === 'network' && request.args[1] === 'inspect') return result([{ Driver: 'bridge' }]);
    // Native 0.90.0 validates the filename in resolve(), used by `up`.
    if (request.args?.[0] === 'up') {
      const config = request.args?.[request.args.indexOf('--config') + 1];
      if (!config || !['devcontainer.json', '.devcontainer.json'].includes(basename(config))) return result('', 1);
    }
    if (request.args?.[0] === 'read-configuration') return result({ configuration: JSON.parse(await readFile(
      request.args[request.args.indexOf(request.args.includes('--override-config') ? '--override-config' : '--config') + 1]!, 'utf8')),
      workspace: { workspaceFolder: '/work/custom', workspaceMount: 'type=volume,source=owned,target=/work/custom' }, mergedConfiguration: { remoteUser: 'coder', workspaceFolder: '/work/custom' },
      featuresConfiguration: { featureSets: [] } });
    if (request.args?.[0] === 'image') return result([{ Id: 'sha256:image', Config: { Labels: {} } }]);
    if (request.args?.[0] === 'up') {
      const managedLabel = request.args.find(arg => arg.startsWith('happier.managed-machine='));
      if (managedLabel) managedMachineId = managedLabel.slice('happier.managed-machine='.length);
      if (overrides.rowScoped) observedId = managedMachineId === 'managed-b' ? 'b'.repeat(64) : containerId;
      if (request.args.includes('--expect-existing-container')) running = true;
      if (removed) observedId = overrides.replacementId ?? 'b'.repeat(64);
      return overrides.up ?? result({ outcome: 'success', containerId: observedId, remoteUser: 'coder', remoteWorkspaceFolder: '/work/custom' });
    }
    if (request.args?.[0] === 'exec') return request.stdin !== undefined && overrides.canceledWrite
      ? { ...result(''), termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'abort' } } }
      : result(overrides.namespace ?? 'coder\n/work/custom\n');
    if (request.args?.[0] === 'stop') running = false;
    if (request.args?.[0] === 'update') {
      if (overrides.update) return overrides.update;
      const cpu = request.args.indexOf('--cpus');
      const memory = request.args.indexOf('--memory');
      if (cpu >= 0) cpuCores = Number(request.args[cpu + 1]);
      if (memory >= 0) memoryBytes = Number(request.args[memory + 1]);
      return result('');
    }
    if (request.args?.[0] === 'rm') removed = true;
    if (request.args?.[0] === 'ps') return overrides.inventory ?? result(request.args.some(arg => arg.startsWith('label=')) ? `${observedId}\n` : '');
    if (request.args?.[0] === 'inspect' && (overrides.absent || removed && overrides.deleteAbsent)) return result('', 1);
    if (request.args?.[0] === 'inspect') return result([{ Id: observedId, Image: 'sha256:authored-image', HostConfig: { Dns: overrides.dns ?? [], ...(overrides.runtime === 'podman'
      ? { CpuQuota: cpuCores * 100000, CpuPeriod: 100000 } : { NanoCpus: cpuCores * 1e9 }), Memory: memoryBytes, NetworkMode: overrides.networkMode ?? 'bridge' }, State: { Running: running, Paused: overrides.paused ?? false },
      Config: { Labels: { 'devcontainer.local_folder': launch.workspaceFolder, 'devcontainer.config_file': launch.configPath,
        'happier.managed-machine': managedMachineId } },
      Mounts: overrides.mounts ?? [{ Type: 'volume', Name: 'retained-data', Destination: '/data' }] }]);
    return result('');
  } };
  const tools = { exec,
    docker: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: overrides.runtime ?? 'docker' } },
    devcontainer: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: 'devcontainer' } },
    signal: new AbortController().signal, observedAt: 42 } satisfies Parameters<typeof createDevcontainerProvider>[0];
  return { requests, tools, provider: createDevcontainerProvider(tools) };
}
function imageNative(runtime: 'docker' | 'podman' = 'docker', options: { imageId?: string; bridgeDnsExit?: number; hostDnsExit?: number; setup?: PluginProcessResult; hostPath?: string; cleanupFailure?: boolean; runResult?: PluginProcessResult; managedId?: string } = {}) {
  const requests: Parameters<ExecService['run']>[0][] = [];
  let running = true;
  let currentId = containerId;
  let labels: Record<string, string> = {};
  let removed = false;
  let setupFailed = false;
  let ready = false;
  const containerImageId = options.imageId ?? 'sha256:image';
  const volume = `happier${Buffer.from(options.managedId ?? 'managed-a').toString('hex')}-workspace`;
  const spawns: Readonly<{ args: readonly string[] | undefined; outputDelivery: string | undefined }>[] = [];
  const exec: Pick<ExecService, 'run' | 'spawn'> = { spawn: async (request, spawnOptions) => {
    spawns.push({ args: request.args, outputDelivery: spawnOptions?.outputDelivery });
    const termination = { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'none' as const } };
    return { waitForExit: async () => termination, dispose: async () => undefined } as unknown as Awaited<ReturnType<ExecService['spawn']>>;
  }, run: async request => {
    requests.push(request);
    expect(request.executable).toMatchObject({ id: { localId: runtime } });
    const args = request.args ?? [];
    if (args.includes('--rm') && args.includes('getent hosts github.com')) return result('140.82.121.3 github.com\n',
      args.includes('host') ? options.hostDnsExit ?? 0 : options.bridgeDnsExit ?? 0);
    if (args[0] === 'image') return result([{ Id: options.imageId ?? 'sha256:image', Config: { User: 'coder', Env: ['TOKEN=private-image-env'] } }]);
    if (args[0] === 'run') {
      labels = Object.fromEntries(args.flatMap((arg, index) => arg === '--label' ? [args[index + 1]!.split(/=(.*)/su).slice(0, 2)] : []));
      if (requests.filter(entry => entry.args?.[0] === 'run').length > 1) currentId = 'b'.repeat(64);
      removed = false;
      ready = false;
      return options.runResult ?? result(`${currentId}\n`);
    }
    if (args[0] === 'inspect') return removed ? result('', 1) : result([{ Id: currentId, Image: containerImageId, Config: { Labels: labels }, State: { Running: running, Paused: false },
      Mounts: [options.hostPath && requests.some(request => request.args?.[0] === 'run' && request.args.some(arg => arg.startsWith('type=bind'))) ? { Type: 'bind', Source: options.hostPath, Destination: '/workspace' }
        : { Type: 'volume', Name: volume, Destination: '/workspace' }] }]);
    if (args[0] === 'exec') {
      // Minimal images provide these operations through the required shell,
      // without promising standalone test/touch executables.
      if (args.includes('test') || args.includes('touch')) return result('', 127);
      if (args.at(-3) === 'test -f "$1"' && args.at(-1)?.endsWith('-ready')) return result('', ready ? 0 : 1);
      if (args.at(-3) === ': > "$1"' && args.at(-1)?.endsWith('-ready')) ready = true;
      if (args.at(-1) === 'touch /workspace/prepared' && options.setup) { setupFailed = true; return options.setup; }
      return result(args.at(-1) === 'id -un; pwd -P' ? 'coder\n/workspace\n'
        : args.at(-1) === 'id -u; id -g' ? '1000\n1000\n' : 'guest-command-complete\n');
    }
    if (args[0] === 'stop') running = false;
    if (args[0] === 'start') running = true;
    if (args[0] === 'ps') return result(removed ? '' : `${currentId}\n`);
    if (args[0] === 'rm') { if (options.cleanupFailure && setupFailed) return result('', 1); removed = true; return result(''); }
    if (args[0] === 'stop' || args[0] === 'start') return result('');
    throw new Error(`Unexpected image command ${args[0]}`);
  } };
  const tools = { exec, docker: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: runtime } },
    signal: new AbortController().signal, observedAt: 42 } satisfies Parameters<typeof createDevcontainerProvider>[0];
  return { requests, spawns, tools, volume, provider: createDevcontainerProvider(tools) };
}

describe('Devcontainer native roles', () => {
  it.each([['cold', false], ['cold', true], ['prepared', true]] as const)('creates a delegated Team devcontainer.json from the author Save receipt (%s, Prepare=%s)', async (mode, enabled) => {
    const authorNative = native();
    const { reviewedEffectDigest: _digest, ...choices } = launch;
    const contribution = { pluginId: DEVCONTAINER_PLUGIN.manifest.id, localId: 'devcontainer' };
    const descriptor = DEVCONTAINER_PLUGIN.manifest.contributes.machineProvisioners.find(entry => entry.id === contribution.localId);
    if (!descriptor) throw new Error('Expected Devcontainer declaration');
    const sealed = sealManagedMachinePresetContentV1({ presetId: 'team-preset', mode: 'plain', content: {
      v: 1, name: 'Team source', preparation: { enabled },
      launch: { provider: contribution, schemaVersion: 1, name: 'Author name', choices },
    } });
    let authorOptions = 0;
    const saved = await prepareManagedMachinePresetAuthoringV1({ actionId: 'machines.presets.create',
      input: { id: 'team-preset', homeId: 'home', owner: { kind: 'team', teamId: 'team' }, teamAcquireDelegated: true,
        contentEncryptionMode: 'plain', content: sealed.content, recipients: [],
        controller: { machineId: 'author-controller', installationId: 'author-installation' } },
      context: { runtimeAccountId: 'author' },
      invokeChild: async () => {
        authorOptions += 1;
        const review = await readDevcontainerEffectReview(authorNative.tools, choices);
        return { ok: true, result: { base: { launch: choices, effectReview: review.effectReview },
          dimensions: { size: [], image: [], location: [], network: [], duration: [] } } };
      },
    }, {
      custody: { accountId: 'author', readWriterMode: async () => 'plain' as const,
        readRecipientCensus: async () => ({ kind: 'ready' as const, contentEncryptionMode: 'plain' as const, recipients: [] }),
        open: params => openManagedMachinePresetRecipientProjectionV1({ ...params, mode: 'plain' }),
        withE2eeAccountKey: () => null },
      readSelectedProvisioners: async () => [{ contribution, occurrenceId: 'installed', acquireExecutionTarget: 'daemon', descriptor }],
      randomBytes: length => new Uint8Array(length),
    });
    if (!saved || 'ok' in saved) throw new Error(`Author Save failed: ${JSON.stringify(saved)}`);
    const reviewed = MachinePresetActionInputSchemasV1['machines.presets.create'].parse(saved.input);
    const memberContent = replaceManagedMachinePresetLaunchNameV1({ presetId: 'team-preset', mode: 'plain',
      content: reviewed.content, launchName: 'Member name' });
    if (!memberContent) throw new Error('Expected member name override');
    let member = openManagedMachinePresetContentV1({ presetId: 'team-preset', mode: 'plain', content: memberContent });
    if (!member?.launch) throw new Error('Expected saved Team launch');
    if (mode === 'prepared') {
      const physicalLaunch = { ...member.launch, choices: { runtime: 'docker', configuration: { kind: 'image', image: 'prepared:owned' } } };
      const physical = replaceManagedMachinePresetLaunchNameV1({ presetId: 'team-preset', mode: 'plain', content: memberContent,
        launchName: member.launch.name, preparationExecution: { launch: physicalLaunch, binaryPath: '/prepared/happier' },
        reviewedFacts: { launch: physicalLaunch, optionStatus: 'unavailable', prerequisites: [], billing: descriptor.billing,
          retentionCapabilities: descriptor.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
      member = openManagedMachinePresetContentV1({ presetId: 'team-preset', mode: 'plain', content: physical });
      if (!member?.launch) throw new Error('Expected retained prepared execution');
    }
    const memberNative = mode === 'prepared' ? imageNative() : native();
    let row = ManagedMachineFullV1Schema.parse({ id: 'managed-a', homeId: 'home', custodianAccountId: 'member',
      controller: { machineId: 'member-controller', installationId: 'member-installation' },
      preset: { id: 'team-preset', revision: 1, contentEncryptionMode: 'plain' },
      launch: member.preparationExecution?.launch ?? member.launch,
      ...(member.reviewedFacts ? { reviewedFacts: member.reviewedFacts } : {}),
      allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    let memberOptions = 0;
    const retain: ManagedMachineReconciliation['home']['reportIssuedAcquireFact'] = async (current, result) => {
      if (result.kind !== 'bound') throw new Error('Expected native allocation');
      return row = ManagedMachineFullV1Schema.parse({ ...current, allocation: 'bound', resource: result.resource });
    };
    const acquired = await reconcileManagedMachine({ machine: row, requestId: 'member-acquire', action: 'machines.managed.acquire',
      acquisitionMode: 'resource-bound', provisioner: descriptor,
      home: { correlation: current => ({ homeId: current.homeId, managedId: current.id, expectedIntentRevision: current.intentRevision,
          requestId: 'member-acquire', controller: current.controller }), projectEnrollmentCorrelation: projectManagedEnrollmentCorrelationV1,
        submit: async current => ({ submitted: true, machine: row = { ...current, allocation: 'may-exist' } }),
        reportIssuedAcquireFact: retain, preparePendingAcquireBoundReport: async () => result => retain(row, result),
        row: async () => { throw new Error('Unexpected Home report'); } },
      createNative: () => ({ optionsInputSchema: descriptor.launchSchema,
        readReviewedEffectDigest: () => readManagedOpaquePresetAcquireEffectDigestV1(member!), prepareRoles: async () => {},
        invoke: async (role, input) => {
          if (role === 'check') return { available: true };
          if (role === 'options') {
            memberOptions += 1;
            const review = await readDevcontainerEffectReview(memberNative.tools, DevcontainerReviewQuerySchema.parse(input));
            return projectNativeJsonValueForTransport({ base: { launch: input, effectReview: review.effectReview },
              dimensions: { size: [], image: [], location: [], network: [], duration: [] } });
          }
          if (!isRecord(input)) throw new Error('Expected native input');
          if (role === 'acquire') return projectNativeJsonValueForTransport(await memberNative.provider.acquire({
            ...DevcontainerReviewQuerySchema.parse(input.launch),
            ...(typeof input.reviewedEffectDigest === 'string' ? { reviewedEffectDigest: input.reviewedEffectDigest } : {}) }, 'managed-a'));
          if (role === 'bootstrap') return projectNativeJsonValueForTransport(await memberNative.provider.bootstrap(DevcontainerResourceSchema.parse(input.resource)));
          throw new Error(`Unexpected native role ${role}`);
        } }),
      bootstrap: { preflight: async () => {}, prepareCredential: async machine => ({ machine }), readCredential: async () => ({}),
        enroll: async ({ machine }) => machine }, waitForObservation: async () => { throw new Error('Unexpected observation wait'); },
    });
    expect(acquired.allocation).toBe('bound');
    expect(authorOptions).toBe(1);
    expect(memberOptions).toBe(0);
    const sourceChecks = memberNative.requests.filter(request => request.args?.[0] === 'read-configuration');
    if (mode === 'prepared') expect(sourceChecks).toHaveLength(0);
    else expect(sourceChecks.length).toBeGreaterThan(0); // Native acquire and namespace IO retain effect-time drift validation.
    expect(member.authorEffectReview?.reviewedEffectDigest).toBe(launch.reviewedEffectDigest);
  });
  it.each(['docker', 'podman'] as const)('uses the host branch only for confirmed Lima bridge DNS failure (%s)', async runtime => {
    await onLima();
    for (const [bridgeDnsExit, hostDnsExit, expectedHost] of [[2, 0, true], [0, 0, false], [2, 2, false], [127, 0, false]] as const) {
      const { provider, requests } = imageNative(runtime, { bridgeDnsExit, hostDnsExit });
      const acquired = await provider.acquire({ runtime, configuration: { kind: 'image', image: 'example:latest' } }, 'managed-a');
      expect(acquired.kind).toBe('bound');
      const creation = requests.find(request => request.args?.includes('--detach'));
      expect(creation?.args?.includes('--network')).toBe(expectedHost);
      expect(creation?.args?.includes('--dns')).toBe(false);
      if (expectedHost) expect(creation?.args).toEqual(expect.arrayContaining(['--network', 'host']));
      expect(requests.filter(request => request.args?.includes('--rm')).length).toBe(bridgeDnsExit === 2 ? 2 : 1);
    }
  });

  it('does no DNS probing when same-host identity already selects host networking', async () => {
    await onLima();
    const { provider, requests } = imageNative();
    expect((await provider.acquire({ configuration: { kind: 'image', image: 'example:latest' } }, 'managed-a', {
      origin: 'https://home.example.test:9443', addresses: [], hostIdentity: { homeMachineHost: 'controller', controllerMachineHost: 'controller' },
    })).kind).toBe('bound');
    expect(requests.filter(request => request.args?.includes('--rm'))).toHaveLength(0);
  });

  it.each(['bridge', 'compose_default', 'host'])('keeps authored %s networking and exposes confirmed DNS failure at bootstrap', async networkMode => {
    await onLima();
    const { provider, requests } = native({ networkMode, dns: ['192.0.2.53'], dnsExit: 2 });
    if (networkMode !== 'host') await expect(provider.bootstrap(resource)).rejects.toMatchObject({ code: 'dns_host_network_required',
      message: expect.stringContaining('host networking') });
    else expect(await provider.bootstrap(resource)).toMatchObject({ kind: 'native' });
    expect(requests.filter(request => request.args?.[0] === 'up')).toHaveLength(0);
    expect(requests.some(request => request.args?.includes('--dns'))).toBe(false);
  });

  it.each(['docker', 'podman'] as const)('uses host networking only for same-Home-host image guests (%s)', async runtime => {
    for (const homeMachineHost of ['controller.local', 'remote', undefined]) {
      const { provider, requests } = imageNative(runtime);
      const guestHome = { origin: 'https://home.example.test:9443', addresses: ['100.64.0.5'],
        ...(homeMachineHost ? { hostIdentity: { homeMachineHost, controllerMachineHost: 'CONTROLLER' } } : {}) };
      const acquired = await provider.acquire({ runtime, configuration: { kind: 'image', image: 'example:latest' } }, 'managed-a', guestHome);
      expect(acquired.kind).toBe('bound');
      if (acquired.kind !== 'bound') throw new Error('Expected image container');
      expect((await provider.rebuild(acquired.resource.value, acquired.resource.value.reviewedEffectDigest, guestHome)).kind).toBe('bound');
      for (const { args } of requests.filter(request => request.args?.[0] === 'run')) {
        expect(args!.includes('--network')).toBe(homeMachineHost === 'controller.local');
        if (homeMachineHost === 'controller.local') expect(args!.slice(args!.indexOf('--network'), args!.indexOf('--network') + 2)).toEqual(['--network', 'host']);
        expect(args).toContain('home.example.test:100.64.0.5');
      }
    }
  });

  it('retains same-host authored-network context after an uncertain native acknowledgement', async () => {
    const { provider } = native({ up: { ...result({ outcome: 'success', containerId }), stdoutTruncated: true } });
    const guestHome = { origin: 'https://home.example.test:9443', addresses: ['100.64.0.5'],
      hostIdentity: { homeMachineHost: 'controller', controllerMachineHost: 'controller' } };
    const acquired = await provider.acquire(launch, 'managed-a', guestHome);
    expect(acquired.kind).toBe('pending');
    if (acquired.kind !== 'pending') throw new Error('Expected pending acknowledgement');
    const reconciled = await provider.reconcile(acquired.nativeOperationRef.value);
    expect(reconciled.kind).toBe('bound');
    if (reconciled.kind !== 'bound') throw new Error('Expected observed container');
    expect(await provider.bootstrap(reconciled.resource.value)).toMatchObject({ homeNetworkHint: 'authored_network' });
  });

  it.each([
    { networkMode: 'bridge', homeMachineHost: 'controller', expectedHint: true },
    { networkMode: 'host', homeMachineHost: 'controller', expectedHint: false },
    { networkMode: 'bridge', homeMachineHost: 'remote', expectedHint: false },
  ])('preserves authored $networkMode networking on $homeMachineHost', async ({ networkMode, homeMachineHost, expectedHint }) => {
    await writeFile(launch.configPath!, JSON.stringify({ image: 'example:latest', runArgs: [`--network=${networkMode}`] }));
    const { reviewedEffectDigest: _reviewed, ...query } = launch;
    launch = (await readDevcontainerEffectReview(native().tools, query)).launch;
    const { provider, requests } = native({ networkMode });
    const guestHome = { origin: 'https://home.example.test:9443', addresses: ['100.64.0.5'],
      hostIdentity: { homeMachineHost, controllerMachineHost: 'controller' } };
    const acquired = await provider.acquire(launch, 'managed-a', guestHome);
    expect(acquired.kind).toBe('bound');
    if (acquired.kind !== 'bound') throw new Error('Expected authored container');
    expect(requests.find(request => request.args?.[0] === 'up')!.args).not.toContain('--network');
    const carrier = await provider.bootstrap(acquired.resource.value);
    if (expectedHint) expect(carrier).toMatchObject({ homeNetworkHint: 'authored_network' });
    else expect(carrier).not.toHaveProperty('homeNetworkHint');
  });

  it.each([
    { inventory: result(''), expected: { kind: 'confirmed' } },
    { inventory: result(`${containerId}\n${'b'.repeat(64)}\n`), expected: { kind: 'refused', code: 'resource_mismatch' } },
    { inventory: result('', 1), expected: { kind: 'unknown', code: 'native_observation_unavailable' } },
  ])('settles retained acquisition cleanup from its complete native inventory ($expected.kind)', async ({ inventory, expected }) => {
    const { provider, requests } = native({ inventory });
    expect(await provider.destroy({ managedMachineId: 'managed-a', launch })).toEqual(expected);
    expect(requests.some(request => request.args?.[0] === 'rm')).toBe(false);
  });

  it('refuses retained acquisition cleanup when the exact container belongs to a different managed row', async () => {
    const { provider, requests } = native();
    expect(await provider.destroy({ managedMachineId: 'managed-b', launch, nativeResourceId: containerId }))
      .toEqual({ kind: 'refused', code: 'resource_mismatch' });
    expect(requests.some(request => request.args?.[0] === 'rm')).toBe(false);
  });

  it.each(['resource', 'acquisition'] as const)('deletes a retained %s native operation without running configuration hooks', async kind => {
    const { requests, tools } = native();
    let removed = false;
    const nativeRun = tools.exec.run;
    const services = { exec: { ...tools.exec, run: async (...args: Parameters<ExecService['run']>) => {
      if (args[0].args?.[0] === 'rm') removed = true;
      if (removed && args[0].args?.[0] === 'inspect') return result('', 1);
      if (removed && args[0].args?.[0] === 'ps') return result('');
      return nativeRun(...args);
    } }, managedServices: { dependencies: { status: async (id: string) => id === 'docker'
      ? { state: 'ready', executable: tools.docker } : { state: 'missing', supported: true } } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      expect(await kit.invokeAction('destroy', { nativeOperation: kind === 'resource' ? resource
        : { managedMachineId: 'managed-a', launch, nativeResourceId: containerId } }, { surface: 'plugin' }))
        .toEqual({ kind: 'confirmed' });
      expect(requests.filter(request => request.args?.[0] === 'rm').map(request => request.args))
        .toEqual([['rm', '--force', containerId]]);
      expect(requests.some(request => ['exec', 'up', 'read-configuration'].includes(request.args?.[0] ?? ''))).toBe(false);
    } finally { await kit.dispose(); }
  });

  it.each([
    { runtime: 'docker', selected: 'docker' }, { runtime: 'podman', selected: 'podman' }, { runtime: undefined, selected: 'docker' },
  ] as const)('settles an unacknowledged acquisition as absent through $selected (runtime=$runtime) without evaluating launch effects', async ({ runtime, selected }) => {
    const { requests, tools } = native({ runtime, inventory: result('') });
    const dependencies: string[] = [];
    const services = { exec: tools.exec, managedServices: { dependencies: { status: async (id: string) => {
      dependencies.push(id);
      return id === selected ? { state: 'ready', executable: tools.docker } : { state: 'missing', supported: true };
    } } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      expect(await kit.invokeAction('reconcile', { correlation: { managedId: 'managed-a', requestId: 'request-a',
        launch: { ...(runtime ? { runtime } : {}), workspaceFolder: configurationRoot, configuration: { kind: 'inline', config: '{}' } } } }, { surface: 'plugin' }))
        .toEqual({ kind: 'rejected', code: 'managed_not_found' });
      expect(dependencies).toEqual([selected]);
      expect(requests.map(request => request.args)).toEqual([['ps', '--all', '--no-trunc', '--filter',
        'label=happier.managed-machine=managed-a', '--format', '{{.ID}}']]);
    } finally { await kit.dispose(); }
  });

  it('keeps an unacknowledged acquisition unknown when its default Docker runtime is unavailable', async () => {
    const dependencies: string[] = [];
    const services = { exec: { run: async () => { throw new Error('An unavailable runtime must not execute'); } },
      managedServices: { dependencies: { status: async (id: string) => {
        dependencies.push(id);
        return id === 'podman' ? { state: 'ready', executable: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: id } } }
          : { state: 'missing', supported: true };
      } } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      expect(await kit.invokeAction('reconcile', { correlation: { managedId: 'managed-a', requestId: 'request-a',
        launch: { configuration: { kind: 'image', image: 'example:latest' } } } }, { surface: 'plugin' }))
        .toEqual({ kind: 'unknown', recovery: { reference: 'managed-a', reason: 'provider_unavailable' } });
      expect(dependencies).toEqual(['docker']);
    } finally { await kit.dispose(); }
  });

  it.each([
    { label: 'one retained container', inventory: result(`${containerId}\n`), reason: 'native_realization_unknown' },
    { label: 'ambiguous containers', inventory: result(`${containerId}\n${'b'.repeat(64)}\n`), reason: 'native_realization_unknown' },
    { label: 'malformed native output', inventory: result('unrecognized-container\n'), reason: 'native_realization_unknown' },
    { label: 'failed inventory', inventory: result('', 1), reason: 'native_observation_unavailable' },
    { label: 'truncated inventory', inventory: { ...result(''), stdoutTruncated: true }, reason: 'native_observation_unavailable' },
  ])('does not claim absence or issue effects for $label after an unacknowledged acquisition', async ({ inventory, reason }) => {
    const { requests, tools } = native({ inventory });
    const services = { exec: tools.exec, managedServices: { dependencies: { status: async () => ({ state: 'ready', executable: tools.docker }) } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      expect(await kit.invokeAction('reconcile', { correlation: { managedId: 'managed-a', requestId: 'request-a',
        launch: { configuration: { kind: 'image', image: 'example:latest' } } } }, { surface: 'plugin' }))
        .toEqual({ kind: 'unknown', recovery: { reference: 'managed-a', reason } });
      expect(requests.every(request => request.args?.[0] === 'ps')).toBe(true);
    } finally { await kit.dispose(); }
  });

  it.each(['docker', 'podman'] as const)('updates CPU and memory live through %s and observes native limits', async runtime => {
    const { provider, requests, tools } = native({ runtime });
    const size = { cpuCores: 4, memoryBytes: 4 * 1024 ** 3 };
    const services = { exec: tools.exec, managedServices: { dependencies: { status: async (id: string) =>
      id === runtime ? { state: 'ready', executable: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: id } } }
        : { state: 'missing', supported: true } } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      expect(await kit.invokeAction('resize', { resource: { ...resource, runtime }, size }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
    } finally { await kit.dispose(); }
    expect(requests.filter(request => request.args?.[0] === 'update').map(request => request.args))
      .toEqual([['update', '--cpus', '4', '--memory', String(size.memoryBytes), containerId]]);
    expect(requests.some(request => request.args?.[0] === 'stop' || request.args?.[0] === 'start')).toBe(false);
    expect(await provider.inspect(resource)).toMatchObject({ power: 'running', size });
  });

  it('reports disk as unsupported without updating the container', async () => {
    const { provider, requests } = native();
    expect(await provider.resize(resource, { diskBytes: 30 * 1024 ** 3 }))
      .toEqual({ kind: 'unsupported', dimension: 'diskBytes', code: 'container_disk_resize_unsupported' });
    expect(requests.some(request => request.args?.[0] === 'update')).toBe(false);
  });

  it('retains a failed native update cause without confirming the requested size', async () => {
    const reason = 'Memory limit should be smaller than already set memoryswap limit, update the memoryswap at the same time';
    const { provider } = native({ update: { ...result('', 1), stderr: new TextEncoder().encode(reason) } });
    expect(await provider.resize(resource, { memoryBytes: 8 * 1024 ** 3 })).toMatchObject({ kind: 'unknown', code: 'container_resize_failed',
      nativeCause: { localCause: 'native_command_failed', command: 'update', exitCode: 1, stderr: reason } });
    expect(await provider.inspect(resource)).toMatchObject({ size: { cpuCores: 2 } });
  });

  it.each([
    { kind: 'inline', config: '{ // Saved JSONC configuration\n "image": "example:latest", "mounts": [{"type":"volume","source":"data","target":"/data"}], }' },
  ])('materializes a preset $kind configuration and creates a separate container per Machine', async configuration => {
    const query = DevcontainerReviewQuerySchema.parse({ workspaceFolder: configurationRoot, configPath: '',
      configuration: { ...configuration, image: '' } });
    const h = native({ rowScoped: true });
    const reviewed = await readDevcontainerEffectReview(h.tools, query);
    launch = reviewed.launch;
    expect(JSON.parse(await readFile(launch.configPath, 'utf8'))).toMatchObject({ image: 'example:latest' });
    expect(launch).toMatchObject({ configuration });
    expect(reviewed.effectReview.effects).toContainEqual(expect.objectContaining({ kind: 'mount', details: expect.arrayContaining([
      'type=volume,source=owned,target=/work/custom',
    ]) }));
    if (configuration.kind === 'inline') expect(reviewed.effectReview.effects).toContainEqual(expect.objectContaining({ kind: 'mount',
      details: expect.arrayContaining(['volume: data → /data']) }));
    const other = await readDevcontainerEffectReview(h.tools, { workspaceFolder: configurationRoot,
      configuration: { kind: 'inline', config: '{"image":"example:other"}' } });
    expect(other.launch.configPath).not.toBe(launch.configPath);
    expect(JSON.parse(await readFile(launch.configPath, 'utf8'))).toMatchObject({ image: 'example:latest' });
    await rm(launch.configPath);
    expect(await h.provider.acquire(launch, 'managed-a')).toMatchObject({ kind: 'bound', resource: { origin: 'created', value: { containerId } } });
    expect(await h.provider.acquire(launch, 'managed-b')).toMatchObject({ kind: 'bound', resource: { value: { containerId: 'b'.repeat(64) } } });
    expect(await native().provider.rebuild({ ...resource, ...launch }, launch.reviewedEffectDigest)).toMatchObject({ kind: 'bound',
      resource: { value: { configuration, containerId: 'b'.repeat(64) } } });
  });
  it.each(['docker', 'podman'] as const)('keeps the %s holder carrier bound to invocation cancellation', async runtime => {
    const h = imageNative(runtime);
    const controller = new AbortController();
    const spawn = vi.fn(h.tools.exec.spawn);
    const provider = createDevcontainerProvider({ ...h.tools, signal: controller.signal,
      exec: { ...h.tools.exec, spawn } });
    const query = { runtime, configuration: { kind: 'image' as const, image: 'example:latest' } };
    const reviewed = await readDevcontainerEffectReview(h.tools, query);
    const acquired = await provider.acquire(reviewed.launch, 'managed-a');
    if (acquired.kind !== 'bound') throw new Error('Expected a retained image resource');
    const channel = await provider.stream(acquired.resource.value, ['hshim', 'attach', '--socket', '/s']);
    try {
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining([
        'exec', '--interactive', containerId, 'hshim', 'attach', '--socket', '/s',
      ]) }), { signal: controller.signal, outputDelivery: 'invocation' });
      controller.abort();
      expect(spawn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      // The existing Exec host owns process termination. Carrier cancellation
      // must not delete or stop a shared-kept sandbox behind its lifecycle owner.
      expect(h.requests.some(request => ['stop', 'rm'].includes(request.args?.[0] ?? ''))).toBe(false);
    } finally { await channel.dispose(); }
  });

  it.each(['docker', 'podman'] as const)('creates an image with retained volume through %s and enrolls guest commands without the Dev Containers CLI', async runtime => {
    const { requests, spawns, tools, volume } = imageNative(runtime);
    const dependencies: string[] = [];
    const services = { exec: tools.exec, managedServices: { dependencies: { status: async (id: string) => {
      dependencies.push(id);
      return { state: 'ready', executable: { kind: 'managedDependency', id: { pluginId: DEVCONTAINER_PLUGIN.manifest.id, localId: id } } };
    } } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', { runtime, configuration: {
        kind: 'image', image: 'example:latest', setupScript: 'touch /workspace/prepared' } }, { surface: 'plugin' }));
      if (!options.base?.available) throw new Error('Expected selected runtime availability');
      // The image is the container's one native choice: the receipt and review name it.
      expect(options.base.nativeFacts?.image).toEqual({ id: 'example:latest', title: 'example:latest' });
      expect(options.base.launch).not.toHaveProperty('reviewedEffectDigest');
      const selectedLaunch = DevcontainerReviewQuerySchema.parse(options.base.launch);
      const reviewedEffectDigest = options.base.effectReview?.reviewedEffectDigest;
      if (!reviewedEffectDigest) throw new Error('Expected computed native effect review');
      const guestHome = { origin: 'https://home.example.test:9443', addresses: ['100.64.0.5'],
        hostIdentity: { homeMachineHost: 'controller', controllerMachineHost: 'controller' } };
      expect(await kit.invokeAction('acquire', { launch: selectedLaunch, reviewedEffectDigest: '0'.repeat(64), managedId: 'managed-a', guestHome }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'rejected', code: 'request_conflict' });
      expect(requests.some(request => request.args?.[0] === 'run')).toBe(false);
      const acquired = DEVCONTAINER_RECONCILIATION_SCHEMAS.result.parse(await kit.invokeAction('acquire', { launch: selectedLaunch, reviewedEffectDigest, managedId: 'managed-a', guestHome }, { surface: 'plugin' }));
      if (acquired.kind !== 'bound') throw new Error('Expected actual retained image');
      const retained = acquired.resource.value;
      expect(retained).toMatchObject({ containerId, runtime, storage: { kind: 'child', childPath: '/workspace' }, volumes: [{ name: volume, childPath: '/workspace' }] });
      expect(await kit.invokeAction('bootstrap', { resource: retained }, { surface: 'plugin' })).toMatchObject({ kind: 'native' });
      const executed = await kit.invokeAction('exec', { resource: retained, argv: ['printf', 'guest-command-complete'] }, { surface: 'plugin' });
      expect(executed).toMatchObject({ stdoutBase64: Buffer.from('guest-command-complete\n').toString('base64') });
      // The optional stream role: one interactive non-PTY child carrying the invocation channel.
      expect(await kit.invokeAction('stream', { resource: retained, argv: ['hshim', 'attach', '--socket', '/s'] }, { surface: 'plugin' }))
        .toEqual({ termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } } });
      expect(spawns).toEqual([{ args: ['exec', '--interactive', '--workdir', '/workspace', containerId, 'hshim', 'attach', '--socket', '/s'],
        outputDelivery: 'invocation' }]);
      expect(await kit.invokeAction('power', { resource: retained, intent: 'stop' }, { surface: 'plugin' })).toMatchObject({ kind: 'confirmed' });
      expect(await kit.invokeAction('power', { resource: retained, intent: 'start' }, { surface: 'plugin' })).toMatchObject({ kind: 'confirmed' });
      expect(requests.filter(request => request.args?.at(-1) === 'touch /workspace/prepared')).toHaveLength(1);
      const rebuilt = await kit.invokeAction('rebuild', { resource: retained, reviewedEffectDigest, guestHome }, { surface: 'plugin' });
      expect(rebuilt).toMatchObject({ kind: 'bound', resource: { value: { containerId: 'b'.repeat(64), volumes: retained.volumes } } });
      expect(requests.filter(request => request.args?.at(-1) === 'touch /workspace/prepared')).toHaveLength(2);
      expect(requests.filter(request => request.args?.[0] === 'run').map(request => request.args)).toEqual([
        expect.arrayContaining(['--network', 'host', '--mount', `type=volume,source=${volume},target=/workspace`, '--add-host', 'home.example.test:100.64.0.5']),
        expect.arrayContaining(['--network', 'host', '--mount', `type=volume,source=${volume},target=/workspace`, '--add-host', 'home.example.test:100.64.0.5']),
      ]);
      expect(requests.some(request => request.args?.some(arg => arg.startsWith('type=bind')))).toBe(false);
      expect(requests.filter(request => request.args?.includes('chown')).map(request => request.args)).toEqual([
        ['exec', '--user', '0', containerId, 'chown', '1000:1000', '/workspace'],
        ['exec', '--user', '0', 'b'.repeat(64), 'chown', '1000:1000', '/workspace'],
      ]);
      expect(JSON.stringify(options)).not.toContain('private-image-env');
      expect(new Set(dependencies)).toEqual(new Set([runtime]));
    } finally { await kit.dispose(); }
  });
  it.each([
    { scenario: 'POOL-P6 delegated Team', managedId: 'cmwcdzz6x06rdmc4oehvg1g48', runtime: 'docker' as const },
    { scenario: 'journey B delegated Team', managedId: 'cmwcf67f807bqmc4o6er9o9fa', runtime: 'docker' as const },
    { scenario: 'own saved preset', managedId: 'managed-a', runtime: 'docker' as const },
    { scenario: 'Podman saved preset', managedId: 'managed-a', runtime: 'podman' as const },
  ])('acquires $scenario image operands without a retained native review digest', async ({ managedId, runtime }) => {
    const h = imageNative(runtime, { managedId });
    const services = { exec: h.tools.exec, managedServices: { dependencies: { status: async (id: string) =>
      id === runtime ? { state: 'ready', executable: h.tools.docker } : { state: 'missing', supported: true } } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      const acquired = DEVCONTAINER_RECONCILIATION_SCHEMAS.result.parse(await kit.invokeAction('acquire', {
        launch: { runtime, configuration: { kind: 'image', image: 'node:22-bookworm' } }, managedId,
      }, { surface: 'plugin' }));
      expect(acquired).toMatchObject({ kind: 'bound', resource: { value: { managedMachineId: managedId, containerId,
        configuration: { kind: 'image', image: 'node:22-bookworm' }, volumes: [{ name: h.volume, childPath: '/workspace' }] } } });
      if (acquired.kind !== 'bound') throw new Error('Expected retained image container');
      expect(acquired.resource.value.reviewedEffectDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(await kit.invokeAction('inspect', { resource: acquired.resource.value }, { surface: 'plugin' }))
        .toMatchObject({ availability: 'present', power: 'running' });
    } finally { await kit.dispose(); }
  });
  it.each(['file', 'inline'] as const)('refuses unreviewed %s sources before executing native configuration', async kind => {
    const h = native();
    const services = { exec: h.tools.exec, managedServices: { dependencies: { status: async (id: string) =>
      ({ state: 'ready', executable: { kind: 'managedDependency', id: { pluginId: DEVCONTAINER_PLUGIN.manifest.id, localId: id } } }) } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      const configuration = kind === 'inline' ? { kind, config: '{"image":"node:22-bookworm","initializeCommand":"host-hook"}' } : { kind };
      expect(await kit.invokeAction('acquire', { managedId: 'managed-a',
        launch: { workspaceFolder: configurationRoot, configPath: launch.configPath, configuration } }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'rejected', code: 'invalid_request' });
      expect(h.requests).toEqual([]);
    } finally { await kit.dispose(); }
  });
  it('starts the retained image container after its source image tag changes while stopped', async () => {
    const behavior = { imageId: 'sha256:original' };
    const h = imageNative('docker', behavior);
    const reviewed = await readDevcontainerEffectReview(h.tools, { configuration: { kind: 'image', image: 'example:latest' } });
    const acquired = await h.provider.acquire(reviewed.launch, 'managed-a');
    if (acquired.kind !== 'bound') throw new Error('Expected prepared image container');
    const retained = acquired.resource.value;
    expect(await h.provider.power(retained, 'stop')).toEqual({ kind: 'confirmed' });
    behavior.imageId = 'sha256:replacement';
    expect(await h.provider.power(retained, 'start')).toEqual({ kind: 'confirmed' });
    expect(h.requests.find(request => request.args?.[0] === 'start')?.args).toEqual(['start', containerId]);
    expect(await h.provider.inspect(retained)).toMatchObject({ availability: 'present', power: 'running' });
  });
  it.skipIf(process.platform === 'win32')('keeps an agent-planted Git hook out of the selected host project', async () => {
    const hostPath = await mkdtemp(join(configurationRoot, 'host-workspace-'));
    const guestPath = await mkdtemp(join(configurationRoot, 'guest-workspace-'));
    const marker = join(configurationRoot, 'host-hook-ran');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    for (const cwd of [hostPath, guestPath]) {
      git(cwd, 'init', '-q', '-b', 'main');
      git(cwd, 'config', 'user.name', 'Test');
      git(cwd, 'config', 'user.email', 'test@example.com');
      await writeFile(join(cwd, 'notes.txt'), 'initial\n');
      git(cwd, 'add', 'notes.txt');
      git(cwd, 'commit', '-qm', 'initial');
    }
    const h = imageNative('docker', { hostPath });
    const nativeRun = h.tools.exec.run;
    const agentCommand = `printf '#!/bin/sh\\ntouch "${marker}"\\n' > .git/hooks/pre-commit; chmod +x .git/hooks/pre-commit; printf 'agent edit\\n' > notes.txt`;
    // Docker Exec is the system boundary. Its real shell writes into the root
    // selected by the actual provider run request, so a bind exposes the host.
    h.tools.exec.run = async (request, options) => {
      if (request.args?.at(-1) === agentCommand) {
        const mount = h.requests.find(entry => entry.args?.[0] === 'run')?.args?.find(arg => arg.startsWith('type='));
        execFileSync('/bin/sh', ['-c', agentCommand], { cwd: mount?.startsWith('type=bind') ? hostPath : guestPath });
        return result('');
      }
      return nativeRun(request, options);
    };
    const provider = createDevcontainerProvider(h.tools);
    const reviewed = await readDevcontainerEffectReview(h.tools, { workspaceFolder: hostPath,
      configuration: { kind: 'image', image: 'example:latest' } });
    const acquired = await provider.acquire(reviewed.launch, 'managed-a');
    expect(acquired.kind).toBe('bound');
    if (acquired.kind !== 'bound') throw new Error('Expected prepared image container');
    await provider.exec(acquired.resource.value, ['sh', '-c', agentCommand]);
    await writeFile(join(hostPath, 'notes.txt'), 'host edit\n');
    git(hostPath, 'add', 'notes.txt');
    git(hostPath, 'commit', '-qm', 'host change');
    expect.soft(await access(marker).then(() => true, () => false)).toBe(false);
    expect.soft(acquired.resource.value).toMatchObject({ storage: { kind: 'child', childPath: '/workspace' } });
    expect(h.requests.find(request => request.args?.[0] === 'run')?.args).toContain(`type=volume,source=${h.volume},target=/workspace`);
  });
  it.each([false, true])('never offers a reconcileable installation after failed image setup, cleanup failure %s', async cleanupFailure => {
    const h = imageNative('docker', { setup: { ...result('', 2), stderr: new TextEncoder().encode('unlabeled-image-setup-witness') }, cleanupFailure });
    const reviewed = await readDevcontainerEffectReview(h.tools, { configuration: { kind: 'image', image: 'example:latest', setupScript: 'touch /workspace/prepared' } });
    const acquired = DEVCONTAINER_RECONCILIATION_SCHEMAS.result.parse(await h.provider.acquire(reviewed.launch, 'managed-a'));
    expect(acquired).toMatchObject({ kind: cleanupFailure ? 'pending' : 'rejected',
      ...(cleanupFailure ? { nativeOperationRef: { value: { nativeResourceId: containerId } } } : { code: 'native_setup_failed' }),
      nativeCause: { command: 'run', exitCode: 2 } });
    if (acquired.kind === 'pending') expect(await h.provider.reconcile(acquired.nativeOperationRef.value)).toMatchObject({ kind: 'pending' });
    expect(h.requests.find(request => request.args?.[0] === 'rm')?.args).toEqual(['rm', '--force', containerId]);
    expect(h.requests.some(request => request.args?.at(-1) === 'id -un; pwd -P')).toBe(false);
    expect(acquired).not.toHaveProperty('nativeCause.stderr');
  });
  it('never reconciles a failed image rebuild into enrollment when exact container cleanup is unavailable', async () => {
    const behavior: { setup?: PluginProcessResult; cleanupFailure: boolean } = { cleanupFailure: true };
    const h = imageNative('docker', behavior);
    const reviewed = await readDevcontainerEffectReview(h.tools, { configuration: { kind: 'image', image: 'example:latest', setupScript: 'touch /workspace/prepared' } });
    const acquired = await h.provider.acquire(reviewed.launch, 'managed-a');
    if (acquired.kind !== 'bound') throw new Error('Expected initial prepared image');
    behavior.setup = result('', 2);
    expect(await h.provider.rebuild(acquired.resource.value, reviewed.launch.reviewedEffectDigest)).toMatchObject({ kind: 'unknown', recovery: { reason: 'native_setup_failed' } });
    expect(await h.provider.reconcile(acquired.resource.value)).toMatchObject({ kind: 'unknown' });
  });
  it('retains an interrupted image creation for observation without enrolling an unprepared child or replaying setup', async () => {
    const h = imageNative('docker', { runResult: { ...result(`${containerId}\n`), stdoutTruncated: true } });
    const reviewed = await readDevcontainerEffectReview(h.tools, { configuration: { kind: 'image', image: 'example:latest', setupScript: 'touch /workspace/prepared' } });
    const acquired = await h.provider.acquire(reviewed.launch, 'managed-a');
    expect(acquired).toMatchObject({ kind: 'pending' });
    if (acquired.kind !== 'pending') throw new Error('Expected interrupted allocation handle');
    expect(await h.provider.reconcile(acquired.nativeOperationRef.value)).toMatchObject({ kind: 'pending' });
    expect(h.requests.filter(request => request.args?.[0] === 'run')).toHaveLength(1);
    expect(h.requests.some(request => request.args?.at(-1) === 'touch /workspace/prepared')).toBe(false);
  });
  it('retains projected native up failure beside the exact pending acquisition handle', async () => {
    const h = native({ up: { ...result('', 1), stderr: new TextEncoder().encode('unlabeled-up-witness') } });
    const acquired = await h.provider.acquire(launch, 'managed-a');
    expect(acquired).toMatchObject({ kind: 'pending', nativeCause: { localCause: 'native_command_failed', command: 'up', exitCode: 1 } });
    expect(acquired).not.toHaveProperty('nativeCause.stderr');
  });
  it('keeps arbitrary setup output out of the native Action failure cause', async () => {
    const h = native({ deleteAbsent: true, up: { ...result({ outcome: 'error', description: 'postCreateCommand from devcontainer.json failed.' }, 1),
      stderr: new TextEncoder().encode('unlabeled-setup-witness\npostCreateCommand from devcontainer.json failed with exit code 23.\n') } });
    const services = { exec: h.tools.exec, managedServices: { dependencies: { status: async (id: string) => ({
      state: 'ready', executable: id === 'docker' ? h.tools.docker : h.tools.devcontainer,
    }) } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      const { reviewedEffectDigest, ...selected } = launch;
      const acquired = await kit.invokeAction('acquire', { launch: selected, reviewedEffectDigest, managedId: 'managed-a' }, { surface: 'plugin' });
      expect(acquired).toEqual({ kind: 'rejected', code: 'native_setup_failed',
        nativeCause: { localCause: 'native_command_failed', command: 'up', exitCode: 23 } });
    } finally { await kit.dispose(); }
  });
  it('keeps a failed advanced setup available to Delete after Docker recovers', async () => {
    const h = native({ deleteAbsent: true, up: { ...result({ outcome: 'error', description: 'postCreateCommand from devcontainer.json failed.', containerId }, 1),
      stderr: new TextEncoder().encode('postCreateCommand from devcontainer.json failed with exit code 23.\n') } });
    const nativeRun = h.tools.exec.run;
    let canRemove = false;
    h.tools.exec.run = (request, options) => request.args?.[0] === 'rm' && !canRemove
      ? Promise.resolve(result('', 1)) : nativeRun(request, options);
    const acquired = DEVCONTAINER_RECONCILIATION_SCHEMAS.result.parse(await h.provider.acquire(launch, 'managed-a'));
    expect(acquired).toMatchObject({ kind: 'pending', nativeCause: { exitCode: 23 }, nativeOperationRef: { value: { nativeResourceId: containerId } } });
    if (acquired.kind !== 'pending') throw new Error('Expected retained native operation');
    expect(await h.provider.reconcile(acquired.nativeOperationRef.value)).toMatchObject({ kind: 'pending' });
    canRemove = true;
    expect(await h.provider.destroy(acquired.nativeOperationRef.value)).toMatchObject({ kind: 'confirmed' });
    expect(h.requests.filter(request => request.args?.[0] === 'rm').map(request => request.args)).toEqual([['rm', '--force', containerId]]);
  });
  it.each(['still present', 'confirmed', 'lost reply'] as const)('keeps the failed setup exit code and verifies exact cleanup (%s)', async cleanup => {
    const deleteAbsent = cleanup !== 'still present';
    const h = native({ deleteAbsent, up: { ...result({ outcome: 'error', description: 'postCreateCommand from devcontainer.json failed.' }, 1),
      stderr: new TextEncoder().encode('[2026-11-18T22:36:01.000Z] postCreateCommand from devcontainer.json failed with exit code 23. Skipping any further user-provided commands.\n') } });
    const nativeRun = h.tools.exec.run;
    if (cleanup === 'lost reply') h.tools.exec.run = async (request, options) => {
      const observed = await nativeRun(request, options);
      if (request.args?.[0] === 'rm') throw new PluginError({ code: 'plugin_exec_termination_incomplete' });
      return observed;
    };
    const acquired = DEVCONTAINER_RECONCILIATION_SCHEMAS.result.parse(await h.provider.acquire(launch, 'managed-a'));
    expect(acquired).toMatchObject({ kind: deleteAbsent ? 'rejected' : 'pending',
      ...(deleteAbsent ? { code: 'native_setup_failed' } : { nativeOperationRef: { value: { nativeResourceId: containerId } } }),
      nativeCause: { localCause: 'native_command_failed', command: 'up', exitCode: 23 } });
    expect(h.requests.filter(request => request.args?.[0] === 'rm').map(request => request.args))
      .toEqual([['rm', '--force', containerId]]);
  });
  it('retains thrown Exec cleanup uncertainty beside the pending handle and recovers the created container without replay', async () => {
    const h = native();
    const nativeRun = h.tools.exec.run;
    h.tools.exec.run = async (request, options) => {
      if (request.args?.[0] === 'up') {
        await nativeRun(request, options);
        throw new PluginError({ code: 'plugin_exec_termination_incomplete',
          message: 'private-cleanup-output', retryable: true });
      }
      return nativeRun(request, options);
    };
    const acquired = DEVCONTAINER_RECONCILIATION_SCHEMAS.result.parse(await h.provider.acquire(launch, 'managed-a'));
    expect(acquired).toMatchObject({ kind: 'pending', nativeCause: { localCause: 'native_command_failed', command: 'up', exitCode: null,
      failureCause: { phase: 'exec.run', errorClass: 'Error', errorCode: 'plugin_exec_termination_incomplete', httpStatus: null } } });
    expect(JSON.stringify(acquired)).not.toContain('private-cleanup-output');
    if (acquired.kind !== 'pending') throw new Error('Expected uncertain native acquisition');
    expect(await h.provider.reconcile(acquired.nativeOperationRef.value)).toMatchObject({ kind: 'bound', resource: { value: { containerId } } });
    expect(h.requests.filter(request => request.args?.[0] === 'up')).toHaveLength(1);
    expect(h.requests.some(request => ['rm', 'stop'].includes(request.args?.[0] ?? ''))).toBe(false);
  });
  it('uses the selected Podman runtime in advanced CLI review, launch and bootstrap commands', async () => {
    const h = native();
    const tools = { ...h.tools, docker: { ...h.tools.docker, id: { ...h.tools.docker.id, localId: 'podman' } } };
    const reviewed = await readDevcontainerEffectReview(tools, { runtime: 'podman', workspaceFolder: launch.workspaceFolder!, configPath: launch.configPath! });
    const provider = createDevcontainerProvider(tools);
    expect(await provider.acquire(reviewed.launch, 'managed-a')).toMatchObject({ kind: 'bound' });
    const commands = h.requests.filter(request => ['read-configuration', 'up', 'exec'].includes(request.args?.[0] ?? ''));
    expect(commands.length).toBeGreaterThan(0);
    for (const request of commands) expect(request.args).toEqual(expect.arrayContaining(['--docker-path', 'podman']));
  });
  it('writes shared-admitted padding bits exactly through the activated file Action', async () => {
    const h = native();
    const services = {
      exec: h.tools.exec, managedServices: { dependencies: { status: async (id: string) => ({ state: 'ready',
        executable: { kind: 'managedDependency', id: { pluginId: DEVCONTAINER_PLUGIN.manifest.id, localId: id } } }) } },
    } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      expect(await kit.invokeAction('put-file', { resource, guestPath: '/tmp/private-payload', bytesBase64: 'AB==', mode: 0o600 }, { surface: 'plugin' }))
        .toEqual({ kind: 'confirmed' });
      expect(h.requests.filter(request => request.stdin !== undefined).map(request => request.stdin)).toEqual([Buffer.from([0])]);
      await expect(kit.invokeAction('put-file', { resource, guestPath: '/tmp/private-payload', bytesBase64: 'AA==\n' }, { surface: 'plugin' })).rejects.toThrow();
      expect(h.requests.filter(request => request.stdin !== undefined)).toHaveLength(1);
    } finally { await kit.dispose(); }
  });
  it('uses the same inherited native environment for review, realization and retained control', async () => {
    vi.stubEnv('PATH', 'controlled-native-path');
    vi.stubEnv('HAPPIER_DEVCONTAINER_TEST_LOCAL_ENV', 'reviewed-local-value');
    vi.stubEnv('DOCKER_CONTEXT', 'reviewed-docker-context');
    const { provider, tools, requests } = native();
    const reviewed = await readDevcontainerEffectReview(tools, { workspaceFolder: launch.workspaceFolder, configPath: launch.configPath });
    const acquired = await provider.acquire(reviewed.launch, 'managed-a');
    if (acquired.kind !== 'bound') throw new Error('Expected actual retained native fixture');
    expect(await provider.power(acquired.resource.value, 'stop')).toMatchObject({ kind: 'confirmed' });
    expect(await provider.power(acquired.resource.value, 'start')).toMatchObject({ kind: 'confirmed' });
    const rebuilt = await provider.rebuild(acquired.resource.value, reviewed.launch.reviewedEffectDigest);
    if (rebuilt.kind !== 'bound') throw new Error('Expected replacement native fixture');
    expect(await provider.inspect(rebuilt.resource.value)).toMatchObject({ availability: 'present', power: 'running' });
    for (const request of requests) expect({ PATH: request.env?.PATH,
      HAPPIER_DEVCONTAINER_TEST_LOCAL_ENV: request.env?.HAPPIER_DEVCONTAINER_TEST_LOCAL_ENV, DOCKER_CONTEXT: request.env?.DOCKER_CONTEXT })
      .toEqual({ PATH: 'controlled-native-path', HAPPIER_DEVCONTAINER_TEST_LOCAL_ENV: 'reviewed-local-value', DOCKER_CONTEXT: 'reviewed-docker-context' });
    expect(requests.filter(request => request.args?.[0] === 'up').map(request => request.env?.COMPOSE_PROJECT_NAME))
      .toEqual(['happier6d616e616765642d61', 'happier6d616e616765642d61', 'happier6d616e616765642d61']);
    expect(requests.map(request => request.cwd)).toEqual(requests.map(() => launch.workspaceFolder));
  });

  it.each(['rebuild', 'start'] as const)('refuses changed reviewed configuration before the %s lifecycle effect', async intent => {
    const { provider, requests } = native();
    await writeFile(launch.configPath, JSON.stringify({ image: 'example:latest', initializeCommand: 'changed-host-effect' }));
    expect(intent === 'rebuild' ? await provider.rebuild(resource, launch.reviewedEffectDigest)
      : await provider.power(resource, 'start')).toMatchObject({ kind: 'refused', code: 'request_conflict' });
    expect(requests.some(request => ['up', 'rm'].includes(request.args?.[0] ?? ''))).toBe(false);
  });

  it('uses the newly reviewed rebuild effects rather than the previous installation review', async () => {
    const { provider, tools } = native();
    await writeFile(launch.configPath, JSON.stringify({ image: 'example:latest', initializeCommand: 'new-approved-host-effect' }));
    const reviewed = await readDevcontainerEffectReview(tools, { workspaceFolder: launch.workspaceFolder, configPath: launch.configPath });
    expect(reviewed.launch.reviewedEffectDigest).not.toBe(resource.reviewedEffectDigest);
    expect(await provider.rebuild(resource, reviewed.launch.reviewedEffectDigest)).toMatchObject({ kind: 'bound',
      resource: { value: { reviewedEffectDigest: reviewed.launch.reviewedEffectDigest, containerId: 'b'.repeat(64) } } });
  });

  it('retains an uncertain acquisition in the existing native operation handle and recovers its row-scoped identity without creating again', async () => {
    const uncertain = native({ up: result({ outcome: 'error' }, 1) });
    const acquisition = await uncertain.provider.acquire(launch, 'managed-a');
    expect(acquisition).toMatchObject({ kind: 'pending', nativeOperationRef: {
      contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
      value: { managedMachineId: 'managed-a', launch },
    } });
    const observed = native();
    expect(await observed.provider.reconcile({ managedMachineId: 'managed-a', launch })).toMatchObject({
      kind: 'bound', resource: { value: { containerId, managedMachineId: 'managed-a' } },
    });
    expect(observed.requests.some(request => ['up', 'rm', 'stop'].includes(request.args?.[0] ?? ''))).toBe(false);
  });

  it('realizes separate native identities for two admitted managed rows selecting the same configuration', async () => {
    const { provider, requests } = native({ rowScoped: true });
    const first = await provider.acquire(launch, 'managed-a');
    const second = await provider.acquire(launch, 'managed-b');
    expect(first).toMatchObject({ kind: 'bound', resource: { value: { containerId, managedMachineId: 'managed-a' } } });
    expect(second).toMatchObject({ kind: 'bound', resource: { value: { containerId: 'b'.repeat(64), managedMachineId: 'managed-b' } } });
    const creates = requests.filter(request => request.args?.[0] === 'up');
    expect(creates.map(request => request.args?.find(arg => arg.startsWith('happier.managed-machine=')))).toEqual([
      'happier.managed-machine=managed-a', 'happier.managed-machine=managed-b',
    ]);
    expect(creates.map(request => request.env?.COMPOSE_PROJECT_NAME)).toEqual([
      'happier6d616e616765642d61', 'happier6d616e616765642d62',
    ]);
  });

  it('recovers a uniquely observed replacement without replaying native creation or accepting the previous installation', async () => {
    await writeFile(launch.configPath, JSON.stringify({ image: 'example:latest', userEnvProbe: 'none' }));
    const recovered = native({ id: 'b'.repeat(64) });
    const reviewed = await readDevcontainerEffectReview(recovered.tools, { workspaceFolder: launch.workspaceFolder, configPath: launch.configPath });
    expect(reviewed.launch.reviewedEffectDigest).not.toBe(resource.reviewedEffectDigest);
    // The canonical host overlays the actually submitted rebuild review onto
    // the old resource when reconciling an uncertain replacement.
    const submitted = { ...resource, reviewedEffectDigest: reviewed.launch.reviewedEffectDigest };
    expect(await recovered.provider.reconcile(submitted)).toMatchObject({ kind: 'bound', resource: {
      value: { ...submitted, containerId: 'b'.repeat(64) },
      devcontainerObservation: { nativeResourceId: 'b'.repeat(64), user: resource.user, workspaceFolder: resource.workspaceRoot },
    } });
    expect(recovered.requests.some(request => ['up', 'rm', 'stop'].includes(request.args?.[0] ?? ''))).toBe(false);
    const previous = native();
    expect(await previous.provider.reconcile(resource)).toMatchObject({ kind: 'unknown' });
    const ambiguous = native({ inventory: result(`${'b'.repeat(64)}\n${'c'.repeat(64)}\n`) });
    expect(await ambiguous.provider.reconcile(resource)).toMatchObject({ kind: 'unknown' });
    expect(ambiguous.requests.some(request => request.args?.[0] === 'exec')).toBe(false);
  });

  it('rebuilds the exact retained installation and returns replacement identity with its retained child workspace and volume facts', async () => {
    const { provider, requests } = native();
    expect(await provider.rebuild(resource, launch.reviewedEffectDigest)).toEqual({ kind: 'bound', resource: { origin: 'created',
      contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
      value: { ...resource, containerId: 'b'.repeat(64) },
      devcontainerObservation: { nativeResourceId: 'b'.repeat(64), user: resource.user,
        workspaceFolder: resource.workspaceRoot, storage: resource.storage },
    } });
    expect(requests.find(request => request.args?.[0] === 'rm')?.args).toEqual(['rm', '--force', containerId]);
    expect(requests.find(request => request.args?.[0] === 'up')?.args).toEqual([
      'up', '--workspace-folder', launch.workspaceFolder, '--config', launch.configPath,
      '--override-config', `${launch.configPath}.happier-workspace.json`,
      '--id-label', `devcontainer.local_folder=${launch.workspaceFolder}`, '--id-label', `devcontainer.config_file=${launch.configPath}`,
      '--id-label', 'happier.managed-machine=managed-a',
    ]);
    expect(requests.some(request => request.args?.some(arg => ['down', '--volumes', '--remove-orphans'].includes(arg)))).toBe(false);
  });

  it('refuses stale rebuild identity before effect and retains unknown replacement after interrupted native realization', async () => {
    const stale = native({ id: 'c'.repeat(64) });
    expect(await stale.provider.rebuild(resource, launch.reviewedEffectDigest)).toEqual({ kind: 'refused', code: 'resource_mismatch' });
    expect(stale.requests.some(request => request.args?.[0] === 'up')).toBe(false);
    const interrupted = native({ up: result({ outcome: 'error' }, 1) });
    expect(await interrupted.provider.rebuild(resource, launch.reviewedEffectDigest)).toMatchObject({ kind: 'unknown' });
    expect(interrupted.requests.filter(request => request.args?.[0] === 'up')).toHaveLength(1);
  });

  it('uses native custom user/root and inspected bind/volume facts for the retained resource', async () => {
    const { provider, requests } = native();
    expect(await provider.acquire(launch, 'managed-a')).toEqual({ kind: 'bound', resource: { origin: 'created',
      contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: resource,
      devcontainerObservation: { nativeResourceId: containerId, user: resource.user,
        workspaceFolder: resource.workspaceRoot, storage: resource.storage },
    } });
    expect(requests.find(request => request.args?.[0] === 'up')?.args).not.toContain('--remove-existing-container');
    expect(requests.find(request => request.args?.[0] === 'exec')?.args).toContain(containerId);
  });

  it('keeps failed or canceled allocation unknown rather than replaying or claiming absence', async () => {
    const { provider, requests } = native({ up: { ...result({ outcome: 'error' }, 1),
      termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'abort' } } } });
    expect(await provider.acquire(launch, 'managed-a')).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { managedMachineId: 'managed-a', launch } } });
    expect(requests.filter(request => request.args?.[0] === 'up')).toHaveLength(1);
  });

  it('retains an already-reported native identity when subsequent child observation is unavailable', async () => {
    const { provider } = native({ namespace: 'child observation unavailable' });
    const acquired = await provider.acquire(launch, 'managed-a');
    expect(acquired).toMatchObject({ kind: 'pending', nativeOperationRef: {
      value: { managedMachineId: 'managed-a', launch, nativeResourceId: containerId },
    } });
    if (acquired.kind !== 'pending') throw new Error('Expected retained native acquisition handle');
    const other = native({ id: 'b'.repeat(64) });
    expect(await other.provider.reconcile(acquired.nativeOperationRef.value)).toMatchObject({ kind: 'pending',
      nativeOperationRef: acquired.nativeOperationRef });
    expect(other.requests.some(request => request.args?.[0] === 'exec')).toBe(false);
  });

  it('refuses retained bind drift and never interprets unavailable native IO as absence', async () => {
    const { provider } = native({ mounts: [{ Type: 'bind', Source: '/different/project', Destination: '/work/custom' }] });
    expect(await provider.inspect(resource)).toMatchObject({ availability: 'unavailable', reason: 'resource_mismatch' });
  });

  it('keeps running inspection passive while bootstrap still refuses child namespace drift', async () => {
    // An absolute symlink replacing the retained workspace changes guest pwd -P
    // without changing the container identity, labels or Docker mount facts.
    const { provider, requests } = native({ namespace: 'coder\n/etc/x\n' });
    expect(await provider.inspect(resource)).toMatchObject({ availability: 'present', power: 'running' });
    expect(requests.map(request => request.args?.[0])).toEqual(['inspect']);
    await expect(provider.bootstrap(resource)).rejects.toMatchObject({ code: 'resource_mismatch' });
    expect(requests.some(request => request.args?.some(arg => ['up', 'rm', 'down', '--volumes'].includes(arg)))).toBe(false);
  });

  it('observes running after userEnvProbe changes without exec or effect review', async () => {
    await writeFile(launch.configPath, JSON.stringify({ image: 'example:latest', userEnvProbe: 'none' }));
    const { provider, tools, requests } = native();
    const reviewed = await readDevcontainerEffectReview(tools, { workspaceFolder: launch.workspaceFolder, configPath: launch.configPath });
    const retained = { ...resource, reviewedEffectDigest: reviewed.launch.reviewedEffectDigest };
    expect(await provider.inspect(retained)).toMatchObject({ availability: 'present', power: 'running' });
    requests.length = 0;

    // Native exec reads the current config before its command: a configured
    // login-shell probe can evaluate startup scripts even for id/pwd discovery.
    await writeFile(launch.configPath, JSON.stringify({ image: 'example:latest', userEnvProbe: 'loginInteractiveShell' }));
    expect(await provider.inspect(retained)).toMatchObject({ availability: 'present', power: 'running' });
    expect(requests.map(request => request.args?.[0])).toEqual(['inspect']);
    await expect(provider.bootstrap(retained)).rejects.toMatchObject({ code: 'request_conflict' });
    expect(await provider.power(retained, 'start')).toMatchObject({ kind: 'refused', code: 'request_conflict' });
    expect(requests.some(request => ['exec', 'up', 'rm', 'stop'].includes(request.args?.[0] ?? ''))).toBe(false);
  });

  it('keeps a child-local workspace independent of host Sync', async () => {
    const { provider } = native({ mounts: [{ Type: 'volume', Name: 'child-root', Destination: '/work/custom' }] });
    expect(await provider.acquire(launch, 'managed-a')).toMatchObject({ kind: 'bound', resource: { value: {
      storage: { kind: 'child', childPath: '/work/custom' }, volumes: [{ name: 'child-root', childPath: '/work/custom' }] } } });
  });

  it('stops the exact retained child while retaining bind sources and named volumes', async () => {
    const { provider, requests } = native();
    expect(await provider.power(resource, 'stop')).toEqual({ kind: 'confirmed' });
    expect(requests.find(request => request.args?.[0] === 'stop')?.args).toEqual(['stop', containerId]);
    expect(await provider.inspect(resource)).toMatchObject({ availability: 'present', power: 'stopped' });
    expect(requests.some(request => request.args?.some(arg => ['rm', 'down', '--volumes'].includes(arg)))).toBe(false);
    expect(await provider.power(resource, 'start')).toEqual({ kind: 'confirmed' });
    expect(requests.find(request => request.args?.[0] === 'up')?.args).toContain('--expect-existing-container');
    expect(await provider.inspect(resource)).toMatchObject({ availability: 'present', power: 'running' });
  });

  it('keeps an issued Start with unexpected native identity unknown, not a pre-effect refusal', async () => {
    const { provider } = native({ running: false, up: result({ outcome: 'success', containerId: 'b'.repeat(64) }) });
    expect(await provider.power(resource, 'start')).toEqual({ kind: 'unknown', code: 'resource_mismatch' });
  });

  it('rejects a replaced installation and changed actual child user before private payload delivery', async () => {
    const replaced = native({ id: 'b'.repeat(64) });
    await expect(replaced.provider.exec(resource, ['cat'], new Uint8Array([1]))).rejects.toMatchObject({ code: 'resource_mismatch' });
    expect(replaced.requests.some(request => request.stdin !== undefined)).toBe(false);
    const changed = native({ namespace: 'other\n/work/custom\n' });
    await expect(changed.provider.putFile(resource, '/private/payload', new Uint8Array([2]))).rejects.toMatchObject({ code: 'resource_mismatch' });
    expect(changed.requests.some(request => request.stdin !== undefined)).toBe(false);
  });

  it('preserves private binary input and refuses to confirm a canceled file write', async () => {
    const { provider, requests } = native({ canceledWrite: true });
    const privateBytes = new Uint8Array([0, 255, 10]);
    expect(await provider.putFile(resource, "/private/child's\npayload", privateBytes, 0o4755)).toEqual({ kind: 'unknown' });
    const write = requests.find(request => request.stdin !== undefined);
    expect(write?.stdin).toEqual(privateBytes);
    expect(write?.args?.join(' ')).not.toContain('AP8K');
    expect(write?.args).toContain(containerId);
    expect(write?.args?.at(-1)).toContain('chmod 4755');
  });

  it('refuses an extra host bind even when it does not contain the workspace', async () => {
    const { provider } = native({ mounts: [
      { Type: 'bind', Source: '/host/other', Destination: '/other' },
      { Type: 'volume', Name: 'retained-data', Destination: '/data' },
    ] });
    expect(await provider.acquire(launch, 'managed-a')).toMatchObject({ kind: 'pending' });
  });

  it.each([
    { running: false, paused: false, power: 'stopped' },
    { running: true, paused: true, power: 'suspended' },
  ])('reports $power without executing in an unavailable child namespace', async ({ running, paused, power }) => {
    const { provider, requests } = native({ running, paused, namespace: 'coder\n/etc/x\n' });
    expect(await provider.inspect(resource)).toMatchObject({ availability: 'present', power });
    await expect(provider.bootstrap(resource)).rejects.toMatchObject({ code: 'child_unavailable' });
    expect(requests.some(request => request.args?.some(arg => ['exec', 'up', 'rm', 'down', '--volumes'].includes(arg)))).toBe(false);
  });

  it.each(['/work/custom ', '/work/custom\nfolder', '/work/custom\r\n'])('retains significant path bytes in the actual child root %j', async workspaceRoot => {
    const { provider } = native({ namespace: `coder\n${workspaceRoot}\n`, mounts: [
      { Type: 'volume', Name: 'workspace', Destination: workspaceRoot },
    ] });
    expect(await provider.acquire(launch, 'managed-a')).toMatchObject({ kind: 'bound', resource: { value: {
      workspaceRoot, storage: { kind: 'child', childPath: workspaceRoot },
    } } });
  });

  it('does not turn an incomplete native bind observation into an independent child root', async () => {
    const { provider } = native({ mounts: [{ Type: 'bind', Destination: '/work/custom' }] });
    expect(await provider.acquire(launch, 'managed-a')).toMatchObject({ kind: 'pending' });
  });

  it('retains exact legacy Windows bind cleanup while refusing Agent access and restart', async () => {
    const { provider, requests } = native({ deleteAbsent: true, mounts: [{ Type: 'bind', Source: 'C:\\work', Destination: '/work' }] });
    const legacy = { ...resource, storage: { kind: 'bind' as const, hostPath: 'C:\\work\\custom', childPath: '/work/custom' }, volumes: [] };
    expect(await provider.acquire(launch, 'managed-a')).toMatchObject({ kind: 'pending' });
    await expect(provider.exec(legacy, ['sh'])).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await provider.power(legacy, 'start')).toMatchObject({ kind: 'refused', code: 'invalid_request' });
    expect(requests.some(request => request.args?.[0] === 'start')).toBe(false);
    expect(await provider.inspect(legacy)).toMatchObject({ availability: 'present' });
    expect(await provider.destroy(legacy)).toEqual({ kind: 'confirmed' });
  });

  it('settles already-absent deletion only from a complete successful native inventory', async () => {
    const absent = native({ absent: true });
    expect(await absent.provider.destroy(resource)).toEqual({ kind: 'confirmed' });
    expect(absent.requests.some(request => request.args?.[0] === 'rm')).toBe(false);
    const unavailable = native({ absent: true, inventory: result('', 1) });
    expect(await unavailable.provider.inspect(resource)).toMatchObject({ availability: 'unavailable' });
    expect(await unavailable.provider.destroy(resource)).toMatchObject({ kind: 'unknown' });
  });
});

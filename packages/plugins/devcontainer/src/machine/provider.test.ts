import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createDevcontainerProvider } from './provider.js';
import { readDevcontainerEffectReview } from './effectReview.js';
import { DevcontainerLaunchSchema, DevcontainerReviewQuerySchema, type DevcontainerLaunch, type DevcontainerResource } from './schemas.js';
import { DEVCONTAINER_PLUGIN, DEVCONTAINER_RECONCILIATION_SCHEMAS } from '../manifest.js';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';

const containerId = 'a'.repeat(64);
let launch: DevcontainerLaunch;
let resource: DevcontainerResource;
let configurationRoot: string;
beforeEach(async () => {
  configurationRoot = await mkdtemp(join(tmpdir(), 'happier-devcontainer-native-'));
  await mkdir(join(configurationRoot, '.devcontainer'));
  const query = { workspaceFolder: configurationRoot, configPath: join(configurationRoot, '.devcontainer', 'devcontainer.json') };
  await writeFile(query.configPath, JSON.stringify({ image: 'example:latest' }));
  launch = { ...query, reviewedEffectDigest: '0'.repeat(64) };
  launch = (await readDevcontainerEffectReview(native().tools, query)).launch;
  resource = { ...launch, managedMachineId: 'managed-a', containerId, user: 'coder', workspaceRoot: '/work/custom',
  storage: { kind: 'bind' as const, hostPath: '/host/project', childPath: '/work/custom' },
  volumes: [{ name: 'retained-data', childPath: '/data' }] };
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(configurationRoot, { recursive: true, force: true }); });
function result(value: unknown, exitCode = 0): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
    stdout: new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)), stderr: new Uint8Array(),
    stdoutTruncated: false, stderrTruncated: false };
}
function native(overrides: Readonly<{ up?: PluginProcessResult; running?: boolean; paused?: boolean; absent?: boolean; inventory?: PluginProcessResult; mounts?: unknown; id?: string; namespace?: string; canceledWrite?: boolean; replacementId?: string; rowScoped?: boolean }> = {}) {
  const requests: Parameters<ExecService['run']>[0][] = [];
  let running = overrides.running ?? true;
  let observedId = overrides.id ?? containerId;
  let removed = false;
  let managedMachineId = 'managed-a';
  const exec: Pick<ExecService, 'run'> = { run: async request => {
    requests.push(request);
    if (request.args?.[0] === 'read-configuration') return result({ configuration: JSON.parse(await readFile(request.args[request.args.indexOf('--config') + 1]!, 'utf8')),
      workspace: { workspaceFolder: '/work/custom', workspaceMount: `type=bind,source=${configurationRoot},target=/work/custom` }, mergedConfiguration: { remoteUser: 'coder', workspaceFolder: '/work/custom' },
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
    if (request.args?.[0] === 'rm') removed = true;
    if (request.args?.[0] === 'ps') return overrides.inventory ?? result(request.args.some(arg => arg.startsWith('label=')) ? `${observedId}\n` : '');
    if (request.args?.[0] === 'inspect' && overrides.absent) return result('', 1);
    if (request.args?.[0] === 'inspect') return result([{ Id: observedId, State: { Running: running, Paused: overrides.paused ?? false },
      Config: { Labels: { 'devcontainer.local_folder': launch.workspaceFolder, 'devcontainer.config_file': launch.configPath,
        'happier.managed-machine': managedMachineId } },
      Mounts: overrides.mounts ?? [{ Type: 'bind', Source: '/host/project', Destination: '/work/custom' },
        { Type: 'volume', Name: 'retained-data', Destination: '/data' }] }]);
    return result('');
  } };
  const tools = { exec,
    docker: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: 'docker' } },
    devcontainer: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: 'devcontainer' } },
    signal: new AbortController().signal, observedAt: 42 } satisfies Parameters<typeof createDevcontainerProvider>[0];
  return { requests, tools, provider: createDevcontainerProvider(tools) };
}
function imageNative(runtime: 'docker' | 'podman' = 'docker', options: { imageId?: string; setup?: PluginProcessResult; hostPath?: string; cleanupFailure?: boolean; runResult?: PluginProcessResult } = {}) {
  const requests: Parameters<ExecService['run']>[0][] = [];
  let running = true;
  let currentId = containerId;
  let labels: Record<string, string> = {};
  let removed = false;
  let setupFailed = false;
  let ready = false;
  const containerImageId = options.imageId ?? 'sha256:image';
  const volume = 'happier6d616e616765642d61-workspace';
  const exec: Pick<ExecService, 'run'> = { run: async request => {
    requests.push(request);
    expect(request.executable).toMatchObject({ id: { localId: runtime } });
    const args = request.args ?? [];
    if (args[0] === 'image') return result([{ Id: options.imageId ?? 'sha256:image', Config: { User: 'coder', Env: ['TOKEN=private-image-env'] } }]);
    if (args[0] === 'run') {
      labels = Object.fromEntries(args.flatMap((arg, index) => arg === '--label' ? [args[index + 1]!.split(/=(.*)/su).slice(0, 2)] : []));
      if (requests.filter(entry => entry.args?.[0] === 'run').length > 1) currentId = 'b'.repeat(64);
      removed = false;
      ready = false;
      return options.runResult ?? result(`${currentId}\n`);
    }
    if (args[0] === 'inspect') return removed ? result('', 1) : result([{ Id: currentId, Image: containerImageId, Config: { Labels: labels }, State: { Running: running, Paused: false },
      Mounts: [options.hostPath ? { Type: 'bind', Source: options.hostPath, Destination: '/workspace' }
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
  return { requests, tools, volume, provider: createDevcontainerProvider(tools) };
}

describe('Devcontainer native roles', () => {
  it.each([
    { kind: 'inline', config: '{ // Saved JSONC configuration\n "image": "example:latest", "mounts": ["type=bind,source=/host/data,target=/data"], }' },
  ])('materializes a preset $kind configuration and creates a separate container per Machine', async configuration => {
    const query = DevcontainerReviewQuerySchema.parse({ workspaceFolder: configurationRoot, configPath: '',
      configuration: { ...configuration, image: '' } });
    const h = native({ rowScoped: true });
    const reviewed = await readDevcontainerEffectReview(h.tools, query);
    launch = reviewed.launch;
    expect(JSON.parse(await readFile(launch.configPath, 'utf8'))).toMatchObject({ image: 'example:latest' });
    expect(launch).toMatchObject({ configuration });
    expect(reviewed.effectReview.effects).toContainEqual(expect.objectContaining({ kind: 'mount', details: expect.arrayContaining([
      `type=bind,source=${configurationRoot},target=/work/custom`,
    ]) }));
    if (configuration.kind === 'inline') expect(reviewed.effectReview.effects).toContainEqual(expect.objectContaining({ kind: 'mount',
      details: expect.arrayContaining(['type=bind,source=/host/data,target=/data']) }));
    const other = await readDevcontainerEffectReview(h.tools, { workspaceFolder: configurationRoot,
      configuration: { kind: 'inline', config: '{"image":"example:other"}' } });
    expect(other.launch.configPath).not.toBe(launch.configPath);
    expect(JSON.parse(await readFile(launch.configPath, 'utf8'))).toMatchObject({ image: 'example:latest' });
    await rm(launch.configPath);
    expect(await h.provider.acquire(launch, 'managed-a')).toMatchObject({ kind: 'bound', resource: { value: { containerId } } });
    expect(await h.provider.acquire(launch, 'managed-b')).toMatchObject({ kind: 'bound', resource: { value: { containerId: 'b'.repeat(64) } } });
    expect(await native().provider.rebuild({ ...resource, ...launch }, launch.reviewedEffectDigest)).toMatchObject({ kind: 'bound',
      resource: { value: { configuration, containerId: 'b'.repeat(64) } } });
  });
  it.each(['docker', 'podman'] as const)('creates an image with retained volume through %s and enrolls guest commands without the Dev Containers CLI', async runtime => {
    const { requests, tools, volume } = imageNative(runtime);
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
      const selectedLaunch = DevcontainerLaunchSchema.parse(options.base.launch);
      const guestHome = { origin: 'https://home.example.test:9443', addresses: ['100.64.0.5'] };
      const acquired = DEVCONTAINER_RECONCILIATION_SCHEMAS.result.parse(await kit.invokeAction('acquire', { launch: selectedLaunch, managedId: 'managed-a', guestHome }, { surface: 'plugin' }));
      if (acquired.kind !== 'bound') throw new Error('Expected actual retained image');
      const retained = acquired.resource.value;
      expect(retained).toMatchObject({ containerId, runtime, storage: { kind: 'child', childPath: '/workspace' }, volumes: [{ name: volume, childPath: '/workspace' }] });
      expect(await kit.invokeAction('bootstrap', { resource: retained }, { surface: 'plugin' })).toMatchObject({ kind: 'native' });
      const executed = await kit.invokeAction('exec', { resource: retained, argv: ['printf', 'guest-command-complete'] }, { surface: 'plugin' });
      expect(executed).toMatchObject({ stdoutBase64: Buffer.from('guest-command-complete\n').toString('base64') });
      expect(await kit.invokeAction('power', { resource: retained, intent: 'stop' }, { surface: 'plugin' })).toMatchObject({ kind: 'confirmed' });
      expect(await kit.invokeAction('power', { resource: retained, intent: 'start' }, { surface: 'plugin' })).toMatchObject({ kind: 'confirmed' });
      expect(requests.filter(request => request.args?.at(-1) === 'touch /workspace/prepared')).toHaveLength(1);
      const rebuilt = await kit.invokeAction('rebuild', { resource: retained, reviewedEffectDigest: selectedLaunch.reviewedEffectDigest, guestHome }, { surface: 'plugin' });
      expect(rebuilt).toMatchObject({ kind: 'bound', resource: { value: { containerId: 'b'.repeat(64), volumes: retained.volumes } } });
      expect(requests.filter(request => request.args?.at(-1) === 'touch /workspace/prepared')).toHaveLength(2);
      expect(requests.filter(request => request.args?.[0] === 'run').map(request => request.args)).toEqual([
        expect.arrayContaining(['--mount', `type=volume,source=${volume},target=/workspace`, '--add-host', 'home.example.test:100.64.0.5']),
        expect.arrayContaining(['--mount', `type=volume,source=${volume},target=/workspace`, '--add-host', 'home.example.test:100.64.0.5']),
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
  it('uses an explicitly selected host bind without rewriting its ownership or requiring a setup script', async () => {
    const hostPath = await mkdtemp(join(configurationRoot, 'host,workspace-'));
    const h = imageNative('docker', { hostPath });
    const reviewed = await readDevcontainerEffectReview(h.tools, { workspaceFolder: hostPath, configuration: { kind: 'image', image: 'example:latest' } });
    expect(await h.provider.acquire(reviewed.launch, 'managed-a')).toMatchObject({ kind: 'bound', resource: { value: {
      storage: { kind: 'bind', hostPath, childPath: '/workspace' }, volumes: [],
    } } });
    expect(h.requests.find(request => request.args?.[0] === 'run')?.args).toContain(`type=bind,"source=${hostPath}",target=/workspace`);
    expect(h.requests.some(request => request.args?.includes('chown'))).toBe(false);
  });
  it.each([false, true])('never offers a reconcileable installation after failed image setup, cleanup failure %s', async cleanupFailure => {
    const h = imageNative('docker', { setup: { ...result('', 2), stderr: new TextEncoder().encode('setup failed token=private-setup-token') }, cleanupFailure });
    const reviewed = await readDevcontainerEffectReview(h.tools, { configuration: { kind: 'image', image: 'example:latest', setupScript: 'touch /workspace/prepared' } });
    const acquired = DEVCONTAINER_RECONCILIATION_SCHEMAS.result.parse(await h.provider.acquire(reviewed.launch, 'managed-a'));
    expect(acquired).toMatchObject({ kind: 'unknown', recovery: { reference: containerId, reason: 'native_setup_failed' },
      nativeCause: { command: 'run', exitCode: 2 } });
    expect(acquired).not.toHaveProperty('nativeOperationRef');
    expect(h.requests.find(request => request.args?.[0] === 'rm')?.args).toEqual(['rm', '--force', containerId]);
    expect(h.requests.some(request => request.args?.at(-1) === 'id -un; pwd -P')).toBe(false);
    expect(JSON.stringify(acquired)).not.toContain('private-setup-token');
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
    const h = native({ up: { ...result('', 1), stderr: new TextEncoder().encode('boot failed token=private-acquisition-token') } });
    const acquired = await h.provider.acquire(launch, 'managed-a');
    expect(acquired).toMatchObject({ kind: 'pending', nativeCause: { localCause: 'native_command_failed', command: 'up', exitCode: 1 } });
    expect(JSON.stringify(acquired)).not.toContain('private-acquisition-token');
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

  it('rebuilds the exact retained installation and returns replacement identity with retained bind and external volume facts', async () => {
    const { provider, requests } = native();
    expect(await provider.rebuild(resource, launch.reviewedEffectDigest)).toEqual({ kind: 'bound', resource: {
      contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
      value: { ...resource, containerId: 'b'.repeat(64) },
      devcontainerObservation: { nativeResourceId: 'b'.repeat(64), user: resource.user,
        workspaceFolder: resource.workspaceRoot, storage: resource.storage },
    } });
    expect(requests.find(request => request.args?.[0] === 'rm')?.args).toEqual(['rm', '--force', containerId]);
    expect(requests.find(request => request.args?.[0] === 'up')?.args).toEqual([
      'up', '--workspace-folder', launch.workspaceFolder, '--config', launch.configPath,
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
    expect(await provider.acquire(launch, 'managed-a')).toEqual({ kind: 'bound', resource: {
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

  it('detects the deepest native mount without confusing sibling-prefix paths', async () => {
    const { provider } = native({ mounts: [
      { Type: 'bind', Source: '/wrong', Destination: '/work/custom2' },
      { Type: 'bind', Source: '/host/work', Destination: '/work' },
      { Type: 'volume', Name: 'retained-data', Destination: '/data' },
    ] });
    expect(await provider.acquire(launch, 'managed-a')).toMatchObject({ kind: 'bound', resource: { value: {
      storage: { kind: 'bind', hostPath: '/host/work/custom', childPath: '/work/custom' },
    } } });
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
      { Type: 'bind', Source: '/host/project', Destination: workspaceRoot },
    ] });
    expect(await provider.acquire(launch, 'managed-a')).toMatchObject({ kind: 'bound', resource: { value: {
      workspaceRoot, storage: { kind: 'bind', hostPath: '/host/project', childPath: workspaceRoot },
    } } });
  });

  it('does not turn an incomplete native bind observation into an independent child root', async () => {
    const { provider } = native({ mounts: [{ Type: 'bind', Destination: '/work/custom' }] });
    expect(await provider.acquire(launch, 'managed-a')).toMatchObject({ kind: 'pending' });
  });

  it('preserves Windows native bind identity when the workspace is below the mount', async () => {
    const { provider } = native({ mounts: [{ Type: 'bind', Source: 'C:\\work', Destination: '/work' }] });
    expect(await provider.acquire(launch, 'managed-a')).toMatchObject({ kind: 'bound', resource: { value: {
      storage: { kind: 'bind', hostPath: 'C:\\work\\custom', childPath: '/work/custom' },
    } } });
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

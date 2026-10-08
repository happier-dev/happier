import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createDevcontainerProvider } from './provider.js';
import { readDevcontainerEffectReview } from './effectReview.js';
import type { DevcontainerLaunch, DevcontainerResource } from './schemas.js';

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
    if (request.args?.[0] === 'read-configuration') return result({ configuration: JSON.parse(await readFile(launch.configPath, 'utf8')),
      workspace: { workspaceFolder: '/work/custom' }, mergedConfiguration: { remoteUser: 'coder', workspaceFolder: '/work/custom' },
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

describe('Devcontainer native roles', () => {
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
    const recovered = native({ id: 'b'.repeat(64) });
    expect(await recovered.provider.reconcile(resource)).toMatchObject({ kind: 'bound', resource: {
      value: { ...resource, containerId: 'b'.repeat(64) },
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

  it('reports native pause honestly and refuses bootstrap before executing in a paused child', async () => {
    const { provider, requests } = native({ paused: true });
    expect(await provider.inspect(resource)).toMatchObject({ availability: 'present', power: 'suspended' });
    await expect(provider.bootstrap(resource)).rejects.toMatchObject({ code: 'child_unavailable' });
    expect(requests.some(request => request.args?.[0] === 'exec')).toBe(false);
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

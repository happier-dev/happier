import { describe, expect, it } from 'vitest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createDevcontainerProvider } from './provider.js';

const containerId = 'a'.repeat(64);
const launch = { workspaceFolder: '/host/project', configPath: '/host/project/.devcontainer/devcontainer.json' };
const resource = { ...launch, containerId, user: 'coder', workspaceRoot: '/work/custom',
  storage: { kind: 'bind' as const, hostPath: '/host/project', childPath: '/work/custom' },
  volumes: [{ name: 'retained-data', childPath: '/data' }] };
function result(value: unknown, exitCode = 0): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
    stdout: new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)), stderr: new Uint8Array(),
    stdoutTruncated: false, stderrTruncated: false };
}
function native(overrides: Readonly<{ up?: PluginProcessResult; running?: boolean; paused?: boolean; absent?: boolean; inventory?: PluginProcessResult; mounts?: unknown; id?: string; namespace?: string; canceledWrite?: boolean }> = {}) {
  const requests: Parameters<ExecService['run']>[0][] = [];
  let running = overrides.running ?? true;
  const exec: Pick<ExecService, 'run'> = { run: async request => {
    requests.push(request);
    if (request.args?.[0] === 'up') {
      if (request.args.includes('--expect-existing-container')) running = true;
      return overrides.up ?? result({ outcome: 'success', containerId, remoteUser: 'coder', remoteWorkspaceFolder: '/work/custom' });
    }
    if (request.args?.[0] === 'exec') return request.stdin !== undefined && overrides.canceledWrite
      ? { ...result(''), termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'abort' } } }
      : result(overrides.namespace ?? 'coder\n/work/custom\n');
    if (request.args?.[0] === 'stop') running = false;
    if (request.args?.[0] === 'ps') return overrides.inventory ?? result('');
    if (request.args?.[0] === 'inspect' && overrides.absent) return result('', 1);
    if (request.args?.[0] === 'inspect') return result([{ Id: overrides.id ?? containerId, State: { Running: running, Paused: overrides.paused ?? false },
      Config: { Labels: { 'devcontainer.local_folder': launch.workspaceFolder, 'devcontainer.config_file': launch.configPath } },
      Mounts: overrides.mounts ?? [{ Type: 'bind', Source: '/host/project', Destination: '/work/custom' },
        { Type: 'volume', Name: 'retained-data', Destination: '/data' }] }]);
    return result('');
  } };
  return { requests, provider: createDevcontainerProvider({ exec,
    docker: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: 'docker' } },
    devcontainer: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: 'devcontainer' } },
    signal: new AbortController().signal, observedAt: 42 }) };
}

describe('Devcontainer native roles', () => {
  it('uses native custom user/root and inspected bind/volume facts for the retained resource', async () => {
    const { provider, requests } = native();
    expect(await provider.acquire(launch)).toEqual({ kind: 'bound', resource: {
      contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: resource } });
    expect(requests.find(request => request.args?.[0] === 'up')?.args).not.toContain('--remove-existing-container');
    expect(requests.find(request => request.args?.[0] === 'exec')?.args).toContain(containerId);
  });

  it('keeps failed or canceled allocation unknown rather than replaying or claiming absence', async () => {
    const { provider, requests } = native({ up: { ...result({ outcome: 'error' }, 1),
      termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'abort' } } } });
    expect(await provider.acquire(launch)).toMatchObject({ kind: 'unknown', recovery: { reference: launch.configPath } });
    expect(requests.filter(request => request.args?.[0] === 'up')).toHaveLength(1);
  });

  it('retains an already-reported native identity when subsequent child observation is unavailable', async () => {
    const { provider } = native({ namespace: 'child observation unavailable' });
    expect(await provider.acquire(launch)).toMatchObject({ kind: 'unknown', recovery: { reference: containerId } });
  });

  it('refuses retained bind drift and never interprets unavailable native IO as absence', async () => {
    const { provider } = native({ mounts: [{ Type: 'bind', Source: '/different/project', Destination: '/work/custom' }] });
    expect(await provider.inspect(resource)).toMatchObject({ availability: 'unavailable', reason: 'resource_mismatch' });
  });

  it('keeps a child-local workspace independent of host Sync', async () => {
    const { provider } = native({ mounts: [{ Type: 'volume', Name: 'child-root', Destination: '/work/custom' }] });
    expect(await provider.acquire(launch)).toMatchObject({ kind: 'bound', resource: { value: {
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
    expect(await provider.acquire(launch)).toMatchObject({ kind: 'bound', resource: { value: {
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
    expect(await provider.acquire(launch)).toMatchObject({ kind: 'bound', resource: { value: {
      workspaceRoot, storage: { kind: 'bind', hostPath: '/host/project', childPath: workspaceRoot },
    } } });
  });

  it('does not turn an incomplete native bind observation into an independent child root', async () => {
    const { provider } = native({ mounts: [{ Type: 'bind', Destination: '/work/custom' }] });
    expect(await provider.acquire(launch)).toMatchObject({ kind: 'unknown' });
  });

  it('preserves Windows native bind identity when the workspace is below the mount', async () => {
    const { provider } = native({ mounts: [{ Type: 'bind', Source: 'C:\\work', Destination: '/work' }] });
    expect(await provider.acquire(launch)).toMatchObject({ kind: 'bound', resource: { value: {
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

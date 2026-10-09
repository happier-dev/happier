import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlyNativeAdapter } from './provider.js';
import { createFlyNativeClient } from './nativeClient.js';

const launch = {
  app: { name: 'existing-app', ownership: 'existing' as const }, region: 'ord', imageReference: 'registry.example/guest:1',
  guest: { cpuKind: 'shared' as const, cpus: 1, memoryMb: 512 }, volume: { kind: 'attach' as const, volumeId: 'vol_9vw681egy1jj5xm4' },
};
const boot = { homeDir: '/persistent', happyHomeDir: '/persistent/.happier', command: ['/bin/sleep', 'inf'] };
const platform = { data: { platform: { regions: [{ code: 'ord', name: 'Chicago', deprecated: false, requiresPaidPlan: false }],
  vmSizes: [{ name: 'shared-cpu-1x', cpuCores: 1, memoryMb: 256, maxMemoryMb: 2048, memoryIncrementsMb: [256], priceMonth: 2, priceSecond: 0.001 }] } } };
const scopedApps = { total_apps: 1, apps: [{ id: 'native-app-id', name: 'existing-app', machine_count: 0, volume_count: 1 }] };
const emptyAppInventory = { data: { app: { name: 'existing-app', certificates: { totalCount: 0 }, ipAddresses: { totalCount: 0 }, egressIpAddresses: { totalCount: 0 }, addOns: { totalCount: 0 }, secrets: [], services: [], allocations: [], hasDeploymentSource: false } } };

const resource = {
  app: { name: 'existing-app', ownership: 'existing' }, machineId: 'a5c5de9ce64ca12',
  volume: { id: 'vol_9vw681egy1jj5xm4', ownership: 'attached' },
} as const;

function machine(state = 'suspended', instanceId = 'version-one') {
  return {
    id: resource.machineId, instance_id: instanceId, state, region: 'ord',
    config: { mounts: [{ volume: resource.volume.id, path: '/persistent' }], services: [] },
  };
}

function http(replies: readonly Readonly<{ status?: number; body?: unknown }>[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const request = vi.fn<typeof fetch>(async (url, init) => {
    calls.push({ url: String(url), init });
    const reply = replies[calls.length - 1];
    if (!reply) throw new Error('Unexpected HTTP request');
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return { adapter: createFlyNativeAdapter('vendor-token', request, { organizationSlug: 'exact-org' }), calls };
}

describe('Fly exact native resource adapter', () => {
  it('cleans proven-owned partial app and volume without inventing a Machine id or allocating again', async () => {
    const replies = [
      { body: { id: resource.volume.id, state: 'created', attached_machine_id: null } },
      { status: 202 }, { status: 404 }, { body: [] }, { body: [] },
      { body: { id: 'native-app-id', name: 'existing-app' } }, { body: emptyAppInventory }, { status: 202 }, { status: 404 },
    ];
    const { adapter, calls } = http(replies);
    expect(await adapter.destroyPending({ app: { name: 'existing-app', ownership: 'created', id: 'native-app-id' },
      volume: { id: resource.volume.id, ownership: 'created' }, requestId: 'managed-request', phase: 'volume' })).toMatchObject({
      machine: 'absent', volume: 'absent', app: 'absent', complete: true,
    });
    expect(calls.filter(call => call.init?.method === 'DELETE').map(call => call.url)).toEqual([
      `https://api.machines.dev/v1/apps/existing-app/volumes/${resource.volume.id}`, 'https://api.machines.dev/v1/apps/existing-app',
    ]);
    expect(calls.some(call => call.url.includes('/machines/') || call.init?.method === 'POST' && new URL(call.url).hostname === 'api.machines.dev')).toBe(false);
  });
  it('retains unknown app ownership and attached volume during pending cleanup', async () => {
    const { adapter, calls } = http([]);
    expect(await adapter.destroyPending({ app: { name: 'existing-app', ownership: 'unknown' },
      volume: resource.volume, requestId: 'managed-request', phase: 'app' })).toMatchObject({ complete: false, app: 'unknown', volume: 'retained' });
    expect(calls).toEqual([]);
  });
  it('keeps partial cleanup incomplete after a refused owned-volume delete', async () => {
    const { adapter, calls } = http([{ body: { id: resource.volume.id, state: 'created', attached_machine_id: null } }, { status: 403 }]);
    expect(await adapter.destroyPending({ app: launch.app, volume: { id: resource.volume.id, ownership: 'created' },
      requestId: 'managed-request', phase: 'volume' })).toMatchObject({ complete: false, volume: 'unknown', app: 'retained' });
    expect(calls.filter(call => call.init?.method === 'DELETE')).toHaveLength(1);
  });
  it('does not treat a missing native attachment observation as an unattached partial volume', async () => {
    const { adapter, calls } = http([{ body: { id: resource.volume.id, state: 'created' } }]);
    const result = await adapter.destroyPending({ app: launch.app, volume: { id: resource.volume.id, ownership: 'created' },
      requestId: 'managed-request', phase: 'volume' });
    expect(calls.some(call => call.init?.method === 'DELETE')).toBe(false);
    expect(result.complete).toBe(false);
  });
  it('cleans an exact correlated Machine after a lost create reply without buying or deriving neighboring ownership', async () => {
    const correlated = { ...machine('created'), config: { ...machine().config, metadata: { 'happier.request': 'managed-request' } } };
    const { adapter, calls } = http([{ body: [correlated] }, { status: 202 }, { status: 404 },
      { body: { id: resource.volume.id, state: 'created', attached_machine_id: null } }, { status: 202 }, { status: 404 }]);
    expect(await adapter.destroyPending({ app: launch.app, volume: { id: resource.volume.id, ownership: 'created' },
      requestId: 'managed-request', phase: 'machine' })).toMatchObject({ complete: true, machine: 'absent', volume: 'absent', app: 'retained' });
    expect(calls.filter(call => call.init?.method === 'DELETE').map(call => call.url)).toEqual([
      `https://api.machines.dev/v1/apps/existing-app/machines/${resource.machineId}`,
      `https://api.machines.dev/v1/apps/existing-app/volumes/${resource.volume.id}`,
    ]);
    expect(calls.some(call => call.init?.method === 'POST')).toBe(false);
  });
  it('keeps pending cleanup unknown when tagged native Machine recovery is ambiguous', async () => {
    const correlated = { ...machine('created'), config: { ...machine().config, metadata: { 'happier.request': 'managed-request' } } };
    const { adapter, calls } = http([{ body: [correlated, { ...correlated, id: 'neighbor' }] }]);
    expect(await adapter.destroyPending({ app: launch.app, volume: { id: resource.volume.id, ownership: 'created' },
      requestId: 'managed-request', phase: 'machine' })).toMatchObject({ complete: false, machine: 'unknown', reason: 'unqualified-recovery' });
    expect(calls.every(call => call.init?.method === 'GET')).toBe(true);
  });
  it.each([
    { region: 'removed-region' },
    { guest: { cpuKind: 'shared' as const, cpus: 9, memoryMb: 512 } },
    { guest: { cpuKind: 'shared' as const, cpus: 1, memoryMb: 4096 } },
  ])('refuses a stale native region or guest before any paid mutation: %j', async stale => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(String(url).includes('/graphql') ? {
        data: { platform: { regions: [{ code: 'ord', name: 'Chicago', deprecated: false, requiresPaidPlan: false }],
          vmSizes: [{ name: 'shared-cpu-1x', cpuCores: 1, memoryMb: 256, maxMemoryMb: 2048, memoryIncrementsMb: [256], priceMonth: 2, priceSecond: 0.001 }] } },
      } : { total_apps: 0, apps: [] }));
    });
    const client = createFlyNativeClient('vendor-token', request, { organizationSlug: 'exact-org' });
    expect(await client.acquire({ launch: { ...launch, ...stale, app: { name: 'new-app', ownership: 'created', organizationSlug: 'exact-org' },
      volume: { kind: 'create', sizeGb: 1 } }, requestId: 'managed-request', boot })).toMatchObject({ kind: 'rejected', reason: 'launch-unavailable' });
    expect(calls.some(call => call.init?.method === 'POST' && new URL(call.url).hostname === 'api.machines.dev')).toBe(false);
  });
  it('inspects a suspended Machine through direct API reads without waking or promising RAM continuity', async () => {
    const { adapter, calls } = http([{ body: machine() }, { body: { id: resource.volume.id, state: 'created', attached_machine_id: resource.machineId } }]);
    expect(await adapter.inspect(resource)).toMatchObject({ kind: 'present', machineId: resource.machineId, instanceId: 'version-one', state: 'suspended', storage: 'retained', memory: 'not-guaranteed', rootfsAfterStop: 'reset', stoppedComputeBilling: 'not-billed' });
    expect(calls.map((call) => [new URL(call.url).hostname, call.init?.method])).toEqual([['api.machines.dev', 'GET'], ['api.machines.dev', 'GET']]);
  });

  it('starts the stable Machine after a discarded snapshot without interpreting an instance version as a new resource', async () => {
    const { adapter, calls } = http([{ body: {} }, { body: machine('started', 'version-two') }, { body: { id: resource.volume.id, state: 'created', attached_machine_id: resource.machineId } }]);
    expect(await adapter.power(resource, 'start')).toMatchObject({ kind: 'present', machineId: resource.machineId, instanceId: 'version-two', memory: 'not-guaranteed', storage: 'retained' });
    expect(calls[0].url).toBe(`https://api.machines.dev/v1/apps/existing-app/machines/${resource.machineId}/start`);
    expect(calls[0].init?.method).toBe('POST');
  });

  it('keeps accepted stop pending until native observation confirms stopped', async () => {
    const { adapter } = http([{ status: 202 }, { body: machine('stopping') }, { body: { id: resource.volume.id, state: 'created', attached_machine_id: resource.machineId } }]);
    expect(await adapter.power(resource, 'stop')).toMatchObject({ kind: 'present', state: 'stopping', storage: 'retained' });
  });

  it('does not decode authorization or native refusal as absence and redacts reflected vendor error bodies', async () => {
    const denied = http([{ status: 401, body: { error: 'vendor-token' } }]);
    expect(await denied.adapter.inspect(resource)).toEqual({ kind: 'unavailable', reason: 'authorization', status: 401 });
    const suspend = http([{ status: 422, body: { error: 'vendor-token' } }]);
    expect(await suspend.adapter.power(resource, 'suspend')).toEqual({ kind: 'refused', reason: 'native-refusal', status: 422 });
  });

  it('retains native uncertainty after a dropped power reply without replaying the effect', async () => {
    const request = vi.fn<typeof fetch>(async () => { throw new TypeError('vendor-token'); });
    const adapter = createFlyNativeAdapter('vendor-token', request);
    expect(await adapter.power(resource, 'start')).toEqual({ kind: 'unknown', reason: 'transport' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched native identity instead of attaching an unrelated Machine', async () => {
    const { adapter } = http([{ body: { ...machine(), id: 'other-machine' } }]);
    expect(await adapter.inspect(resource)).toEqual({ kind: 'unavailable', reason: 'invalid-response' });
  });

  it('reports native proxy autonomous power as a separate fact', async () => {
    const { adapter } = http([{ body: { ...machine(), config: { ...machine().config, services: [{ autostart: true, autostop: 'suspend' }] } } }, { body: { id: resource.volume.id, state: 'created', attached_machine_id: resource.machineId } }]);
    expect(await adapter.inspect(resource)).toMatchObject({ autonomousPower: true });
  });

  it.each(['always', 'restart'] as const)('preserves selected rootfs persistence %s without assuming the default stop-reset consequence', async (persist) => {
    const { adapter } = http([{ body: { ...machine('stopped'), config: { ...machine().config, rootfs: { persist } } } }, { body: { id: resource.volume.id, state: 'created', attached_machine_id: resource.machineId } }]);
    // The pinned native schema proves these distinct modes. Their current stop
    // semantics require qualification before publishing a continuity guarantee.
    expect(await adapter.inspect(resource)).toMatchObject({ rootfsPersistence: persist, rootfsAfterStop: 'unknown' });
  });

  it('reports an explicitly ephemeral rootfs separately from the retained volume', async () => {
    const { adapter } = http([{ body: { ...machine('stopped'), config: { ...machine().config, rootfs: { persist: 'never' } } } }, { body: { id: resource.volume.id, state: 'created', attached_machine_id: resource.machineId } }]);
    expect(await adapter.inspect(resource)).toMatchObject({ rootfsPersistence: 'never', rootfsAfterStop: 'reset', storage: 'retained' });
  });

  it('executes on the exact private API target with a protected stdin body and the containing operation timeout', async () => {
    const payload = 'private-enrollment-payload';
    const { adapter, calls } = http([{ body: { exit_code: 0, stdout: 'installed', stderr: '' } }]);
    expect(await adapter.exec(resource, { command: ['happier', 'auth', 'enroll'], stdin: payload, timeout: 15 })).toEqual({ kind: 'completed', exitCode: 0, stdout: 'installed', stderr: '' });
    expect(calls[0].url).toBe(`https://api.machines.dev/v1/apps/existing-app/machines/${resource.machineId}/exec`);
    expect(calls[0].init?.method).toBe('POST');
    const body: unknown = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({ command: ['happier', 'auth', 'enroll'], stdin: payload, timeout: 15 });
    expect(calls[0].url).not.toContain(payload);
    expect(String(calls[0].init?.body)).not.toContain('raw_value');
  });

  it('configures the installed foreground daemon on the same volume-backed Machine and preserves native configuration', async () => {
    const argv = ['/persistent/.happier/cli/current/happier', 'daemon', 'start-sync'];
    const environment = { HOME: boot.homeDir, HAPPIER_HOME_DIR: boot.happyHomeDir };
    const original = { ...machine('started'), config: { ...machine().config, image: launch.imageReference,
      env: { NATIVE_SETTING: 'keep' }, init: { exec: boot.command }, dns: { skip_registration: true } } };
    const configured = { ...original, instance_id: 'new-instance', config: { ...original.config,
      env: { ...original.config.env, ...environment }, init: { exec: argv } } };
    const { adapter, calls } = http([{ body: original }, { body: configured }]);
    expect(await adapter.configureProcess(resource, { command: argv, environment })).toEqual({ kind: 'configured' });
    expect(calls.map(call => [call.url, call.init?.method])).toEqual([
      [`https://api.machines.dev/v1/apps/existing-app/machines/${resource.machineId}`, 'GET'],
      [`https://api.machines.dev/v1/apps/existing-app/machines/${resource.machineId}`, 'POST'],
    ]);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ config: configured.config });
  });

  it('does not report boot configured from an accepted update whose process differs, and never replays a lost update', async () => {
    const original = { ...machine('started'), config: { ...machine().config, env: { HOME: '/persistent', HAPPIER_HOME_DIR: boot.happyHomeDir } } };
    const request = { command: ['/persistent/installed-happier', 'daemon', 'start-sync'], environment: { HOME: '/persistent', HAPPIER_HOME_DIR: boot.happyHomeDir } };
    const unconfirmed = http([{ body: original }, { body: original }]);
    expect(await unconfirmed.adapter.configureProcess(resource, request)).toMatchObject({ kind: 'unknown', reason: 'invalid-response' });
    const dropped = http([{ body: original }]);
    expect(await dropped.adapter.configureProcess(resource, request)).toMatchObject({ kind: 'unknown', reason: 'transport' });
    expect(dropped.calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
  });

  it('keeps native execution ambiguous after a dropped reply and never replays enrollment', async () => {
    const request = vi.fn<typeof fetch>(async () => { throw new TypeError('private-enrollment-payload'); });
    const adapter = createFlyNativeAdapter('vendor-token', request);
    expect(await adapter.exec(resource, { command: ['happier', 'auth', 'enroll'], stdin: 'private-enrollment-payload', timeout: 15 })).toEqual({ kind: 'unknown', reason: 'transport' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('preserves native signal termination and never confirms an interrupted private file write', async () => {
    const signalled = { exit_code: 0, exit_signal: 9, stdout: '', stderr: 'interrupted' };
    const execution = http([{ body: signalled }]);
    expect(await execution.adapter.exec(resource, { command: ['cat'] })).toMatchObject({ kind: 'completed', exitSignal: 9 });
    const file = http([{ body: signalled }]);
    expect(await file.adapter.putFile(resource, { guestPath: '/persistent/payload', bytesBase64: 'AA==' })).toMatchObject({ kind: 'refused', reason: 'native-exit', exitSignal: 9 });
    const unavailable = http([{ body: { ...signalled, exit_signal: null } }]);
    expect(await unavailable.adapter.putFile(resource, { guestPath: '/persistent/payload', bytesBase64: 'AA==' })).toEqual({ kind: 'unknown', reason: 'invalid-response' });
  });

  it('distinguishes exact Machine absence and a lost volume from unavailable observation', async () => {
    const absent = http([{ status: 404 }]);
    expect(await absent.adapter.inspect(resource)).toEqual({ kind: 'absent' });
    const lost = http([{ body: machine('stopped') }, { status: 404 }]);
    expect(await lost.adapter.inspect(resource)).toMatchObject({ kind: 'present', storage: 'lost' });
  });

  it('destroys only the exact Machine and retains an existing app and attached volume', async () => {
    const { adapter, calls } = http([{ status: 200 }, { status: 404 }]);
    expect(await adapter.destroy(resource)).toMatchObject({ machine: 'absent', volume: 'retained', app: 'retained', complete: true });
    expect(calls.map((call) => call.url)).toEqual([`https://api.machines.dev/v1/apps/existing-app/machines/${resource.machineId}`, `https://api.machines.dev/v1/apps/existing-app/machines/${resource.machineId}`]);
  });

  it('does not delete an owned volume now attached to an unrelated Machine', async () => {
    const owned = { ...resource, volume: { ...resource.volume, ownership: 'created' as const } };
    const { adapter, calls } = http([{ status: 200 }, { status: 404 }, { body: { id: resource.volume.id, state: 'created', attached_machine_id: 'other-machine' } }]);
    expect(await adapter.destroy(owned)).toMatchObject({ machine: 'absent', volume: 'retained', app: 'retained', complete: false });
    expect(calls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(1);
  });

  it('retains incomplete created-app cleanup when native app inventory finds unrelated resources', async () => {
    const owned = { ...resource, app: { ...resource.app, ownership: 'created' as const }, volume: { ...resource.volume, ownership: 'created' as const } };
    const { adapter, calls } = http([{ status: 200 }, { status: 404 }, { body: { id: resource.volume.id, state: 'created', attached_machine_id: null } }, { body: { id: resource.volume.id, state: 'destroyed', attached_machine_id: null } }, { status: 404 }, { body: [machine('started')] }, { body: [] }]);
    expect(await adapter.destroy(owned)).toMatchObject({ machine: 'absent', volume: 'absent', app: 'retained', complete: false, reason: 'app-not-empty' });
    expect(calls.some((call) => call.init?.method === 'DELETE' && call.url.endsWith('/existing-app'))).toBe(false);
  });

  it('does not claim retained storage when the exact volume identity or mount disagrees', async () => {
    const { adapter } = http([{ body: machine('stopped') }, { body: { id: 'another-volume', state: 'created', attached_machine_id: resource.machineId } }]);
    expect(await adapter.inspect(resource)).toMatchObject({ kind: 'present', storage: 'unknown' });
  });

  it('writes private file contents only in stdin and preserves exact quoted guest paths', async () => {
    const { adapter, calls } = http([{ body: { exit_code: 0, stdout: '', stderr: '' } }]);
    expect(await adapter.putFile(resource, { guestPath: "/persistent/it's-private", bytesBase64: Buffer.from('private-enrollment-payload').toString('base64'), mode: 0o600 })).toEqual({ kind: 'written' });
    const body = JSON.parse(String(calls[0].init?.body)) as { command: string[]; stdin: string };
    expect(body.stdin).toBe(Buffer.from('private-enrollment-payload').toString('base64'));
    expect(body.command.join(' ')).not.toContain('private-enrollment-payload');
    expect(body.command[2]).toContain("'/persistent/it'\\''s-private'");
  });

  it.skipIf(process.platform === 'win32')('writes arbitrary binary installer bytes with executable permissions through protected stdin', async () => {
    const { adapter, calls } = http([{ body: { exit_code: 0, stdout: '', stderr: '' } }]);
    const bytesBase64 = Buffer.from([0, 255, 128, 10, 13]).toString('base64');
    const directory = mkdtempSync(join(tmpdir(), 'happier-fly-'));
    const guestPath = join(directory, "it's-executable");
    try {
      expect(await adapter.putFile(resource, { guestPath, bytesBase64, mode: 0o755 })).toEqual({ kind: 'written' });
      const body = JSON.parse(String(calls[0].init?.body)) as { command: string[]; stdin: string };
      expect(body.stdin).toBe(bytesBase64);
      expect(body.command.join(' ')).not.toContain(bytesBase64);
      // HTTP is the fake boundary; run the emitted Linux guest command against
      // a disposable OS filesystem to prove byte preservation, not just argv.
      execFileSync(body.command[0], body.command.slice(1), { input: body.stdin });
      expect(readFileSync(guestPath)).toEqual(Buffer.from([0, 255, 128, 10, 13]));
      expect(statSync(guestPath).mode & 0o7777).toBe(0o755);
    } finally { rmSync(directory, { recursive: true }); }
  });

  it('propagates caller cancellation and rejects redirects before disclosing private stdin or credentials', async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      controller.abort();
      throw new DOMException('aborted private payload', 'AbortError');
    });
    const client = createFlyNativeClient('vendor-token', request, { signal: controller.signal });
    expect(await client.exec(resource, { command: ['cat'], stdin: 'private-enrollment-payload' })).toEqual({ kind: 'unknown', reason: 'transport' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]?.redirect).toBe('error');
    expect(request.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('retains an accepted Machine id even if native readiness and config are malformed', async () => {
    const { adapter } = http([
      { body: platform }, { body: scopedApps },
      { body: [{ id: resource.volume.id, state: 'created', region: 'ord', attached_machine_id: null }] },
      { body: { id: resource.machineId, state: null, config: null } },
      { body: { id: resource.machineId, state: null, config: null } },
    ]);
    const acquired = await adapter.acquire({ launch, requestId: 'managed-request', boot });
    expect(acquired).toEqual({ kind: 'bound', resource });
    if (acquired.kind === 'bound') expect(await adapter.inspect(acquired.resource)).toEqual({ kind: 'unavailable', reason: 'invalid-response' });
  });

  it('retains uncertainty when a deletion response is accepted but absence is unavailable', async () => {
    const { adapter, calls } = http([{ status: 200 }, { status: 403 }]);
    expect(await adapter.destroy({ ...resource, app: { ...resource.app, ownership: 'created' }, volume: { ...resource.volume, ownership: 'created' } })).toMatchObject({ complete: false, machine: 'unknown', volume: 'unknown', app: 'unknown' });
    expect(calls.filter(call => call.init?.method === 'DELETE')).toHaveLength(1);
  });

  it('acquires an exact Machine with an attached volume at the host-selected Happier home and no proxy power owner', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const request = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(String(url).endsWith('/graphql') ? platform : String(url).includes('/apps?') ? scopedApps
        : String(url).endsWith('/volumes') ? [{ id: resource.volume.id, state: 'created', region: 'ord', attached_machine_id: null }] : machine('created')));
    });
    const client = createFlyNativeClient('vendor-token', request, { organizationSlug: 'exact-org' });
    expect(await client.acquire({ launch, requestId: 'managed-request', boot })).toMatchObject({ kind: 'bound', resource });
    const body = JSON.parse(String(calls.find(call => call.url.endsWith('/machines'))?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ region: 'ord', config: { image: launch.imageReference,
      env: { HOME: boot.homeDir, HAPPIER_HOME_DIR: boot.happyHomeDir }, mounts: [{ volume: resource.volume.id, path: boot.homeDir }], init: { exec: boot.command }, services: [], restart: { policy: 'no' }, auto_destroy: false } });
    expect(JSON.stringify(body)).not.toContain('vendor-token');
    expect(JSON.stringify(body)).not.toContain('private-enrollment');
  });

  it('retains exact created app/volume identities after a dropped Machine-create response without replaying purchase', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const request = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/machines')) throw new TypeError('vendor-token');
      return new Response(JSON.stringify(String(url).endsWith('/graphql') ? platform : String(url).includes('/apps?') ? { total_apps: 0, apps: [] }
        : String(url).endsWith('/apps') ? { id: 'native-app-id', created_at: 1708631799000 } : { id: resource.volume.id, state: 'created', region: 'ord', attached_machine_id: null }));
    });
    const client = createFlyNativeClient('vendor-token', request, { organizationSlug: 'exact-org' });
    expect(await client.acquire({ launch: { ...launch, app: { name: 'new-app', ownership: 'created', organizationSlug: 'exact-org' }, volume: { kind: 'create', sizeGb: 1 } }, requestId: 'managed-request', boot })).toMatchObject({ kind: 'unknown', reason: 'transport', operation: { app: { name: 'new-app', ownership: 'created' }, volume: { id: resource.volume.id, ownership: 'created' }, requestId: 'managed-request', phase: 'machine' } });
    expect(calls.filter(call => call.url.endsWith('/machines') && call.init?.method === 'POST')).toHaveLength(1);
  });

  it('refuses an attached volume already in use before any paid mutation', async () => {
    const request = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/graphql') ? platform : String(url).includes('/apps?') ? scopedApps
      : [{ id: resource.volume.id, state: 'created', region: 'ord', attached_machine_id: 'other-machine' }])));
    const client = createFlyNativeClient('vendor-token', request, { organizationSlug: 'exact-org' });
    expect(await client.acquire({ launch, requestId: 'managed-request', boot })).toMatchObject({ kind: 'rejected', reason: 'launch-unavailable' });
    expect(request.mock.calls.some(([, init]) => init?.method === 'POST' && String(init?.body).includes('config'))).toBe(false);
  });

  it('recovers only a unique native Machine with the retained request, volume, region, image and size', async () => {
    const native = { ...machine('created'), config: { ...machine().config, image: launch.imageReference, guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 }, metadata: { 'happier.request': 'managed-request' } } };
    const { adapter, calls } = http([{ body: [native] }]);
    expect(await adapter.recover({ app: launch.app, volume: resource.volume, requestId: 'managed-request', phase: 'machine' }, launch, boot)).toMatchObject({ kind: 'bound', resource });
    expect(calls.every(call => call.init?.method === 'GET')).toBe(true);
    const ambiguous = http([{ body: [native, { ...native, id: 'second-machine' }] }]);
    expect(await ambiguous.adapter.recover({ app: launch.app, volume: resource.volume, requestId: 'managed-request', phase: 'machine' }, launch, boot)).toMatchObject({ kind: 'unknown', reason: 'ambiguous-recovery' });
  });

  it('retains unknown created-app ownership after a dropped app response without adopting or deleting a name collision', async () => {
    const request = vi.fn<typeof fetch>(async url => {
      if (String(url).endsWith('/graphql')) return new Response(JSON.stringify(platform));
      if (String(url).includes('/apps?')) return new Response(JSON.stringify({ total_apps: 0, apps: [] }));
      throw new TypeError('vendor-token');
    });
    const client = createFlyNativeClient('vendor-token', request, { organizationSlug: 'exact-org' });
    expect(await client.acquire({ launch: { ...launch, app: { name: 'new-app', ownership: 'created', organizationSlug: 'exact-org' }, volume: { kind: 'create', sizeGb: 1 } }, requestId: 'managed-request', boot })).toMatchObject({ kind: 'unknown', operation: { app: { name: 'new-app', ownership: 'unknown' }, phase: 'app' } });
    expect(request.mock.calls.filter(([url, init]) => String(url).endsWith('/apps') && init?.method === 'POST')).toHaveLength(1);
  });

  it('requires complete additional app-resource inventory before deleting an apparently empty created app', async () => {
    const owned = { ...resource, app: { ...resource.app, ownership: 'created' as const } };
    const { adapter, calls } = http([{ status: 200 }, { status: 404 }, { body: [] }, { body: [] }]);
    expect(await adapter.destroy(owned)).toMatchObject({ machine: 'absent', app: 'retained', complete: false, reason: 'app-inventory-unavailable' });
    expect(calls.filter(call => call.init?.method === 'DELETE')).toHaveLength(1);
  });

  it('deletes a created app only after exact immutable identity and complete empty inventory, and reports failed app deletion', async () => {
    const owned = { ...resource, app: { ...resource.app, ownership: 'created' as const, id: 'native-app-id' } };
    const replies = [{ status: 200 }, { status: 404 }, { body: [] }, { body: [] }, { body: { id: 'native-app-id', name: 'existing-app' } }, { body: emptyAppInventory }, { status: 202 }, { status: 404 }];
    const success = http(replies);
    expect(await success.adapter.destroy(owned)).toMatchObject({ machine: 'absent', volume: 'retained', app: 'absent', complete: true });
    expect(success.calls[5].url).toBe('https://api.fly.io/graphql');
    const failed = http([...replies.slice(0, 6), { status: 403, body: { error: 'vendor-token' } }]);
    expect(await failed.adapter.destroy(owned)).toMatchObject({ machine: 'absent', app: 'retained', complete: false, reason: 'app-deletion-unconfirmed' });
  });

  it('retains an app with an unrelated IP and refuses a recycled app name', async () => {
    const owned = { ...resource, app: { ...resource.app, ownership: 'created' as const, id: 'native-app-id' } };
    const withIp = http([{ status: 200 }, { status: 404 }, { body: [] }, { body: [] }, { body: { id: 'native-app-id', name: 'existing-app' } }, { body: { data: { app: { ...emptyAppInventory.data.app, ipAddresses: { totalCount: 1 } } } } }]);
    expect(await withIp.adapter.destroy(owned)).toMatchObject({ app: 'retained', complete: false, reason: 'app-not-empty' });
    expect(withIp.calls.filter(call => call.init?.method === 'DELETE')).toHaveLength(1);
    const recycled = http([{ status: 200 }, { status: 404 }, { body: [] }, { body: [] }, { body: { id: 'other-app-id', name: 'existing-app' } }]);
    expect(await recycled.adapter.destroy(owned)).toMatchObject({ app: 'retained', complete: false, reason: 'app-identity-unavailable' });
  });

  it('discovers native regions/sizes and exact scoped apps/volumes without inventing prices or allocating', async () => {
    const { adapter, calls } = http([
      { body: { data: { platform: { regions: [{ code: 'ord', name: 'Chicago', deprecated: false, requiresPaidPlan: false }], vmSizes: [{ name: 'shared-cpu-1x', cpuCores: 1, memoryMb: 256, maxMemoryMb: 2048, memoryIncrementsMb: [256], priceMonth: 2.04, priceSecond: 0.000000786 }] } } } },
      { body: { total_apps: 1, apps: [{ id: 'native-app-id', name: 'existing-app', machine_count: 1, volume_count: 1 }] } },
      { body: [{ id: resource.volume.id, state: 'created', region: 'ord', size_gb: 1, attached_machine_id: null }] },
    ]);
    expect(await adapter.options({ organizationSlug: 'exact-org', appName: 'existing-app' })).toMatchObject({ kind: 'available', regions: [{ code: 'ord' }], sizes: [{ name: 'shared-cpu-1x', priceMonth: 2.04, priceSecond: 0.000000786 }], apps: [{ name: 'existing-app' }], volumes: [{ id: resource.volume.id }], prices: [] });
    expect(calls.map(call => call.init?.method)).toEqual(['POST', 'GET', 'GET']);
    expect(calls[0].url).toBe('https://api.fly.io/graphql');
    expect(calls[1].url).toBe('https://api.machines.dev/v1/apps?org_slug=exact-org');
  });

  it('checks actual scoped authorization and refuses incomplete discovery rather than publishing an empty catalog', async () => {
    const denied = http([{ status: 403 }]);
    expect(await denied.adapter.check({ organizationSlug: 'exact-org' })).toEqual({ available: false, code: 'authorization' });
    const incomplete = http([{ body: { total_apps: 2, apps: [] } }]);
    expect(await incomplete.adapter.check({ organizationSlug: 'exact-org' })).toEqual({ available: false, code: 'invalid-response' });
    const available = http([{ body: { total_apps: 0, apps: [] } }]);
    expect(await available.adapter.check({ organizationSlug: 'exact-org' })).toEqual({ available: true });
  });

  it('retains a paid created volume identity independently of malformed native readiness', async () => {
    const { adapter } = http([{ body: platform }, { body: scopedApps }, { body: [] }, { body: { id: 'paid-volume', state: null, region: 'ord' } }]);
    expect(await adapter.acquire({ launch: { ...launch, volume: { kind: 'create', sizeGb: 1 } }, requestId: 'managed-request', boot })).toMatchObject({ kind: 'unknown', operation: { volume: { id: 'paid-volume', ownership: 'created' } } });
  });
});

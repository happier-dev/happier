import { createHash } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import * as entry from './index.js';

const launch = { regionSlug: 'nyc3', sizeSlug: 's-1vcpu-1gb', imageId: 1, publicNetworking: { ipv6: false } };
const operationId = 'build-one';
const operationTag = 'happier-prepared-' + createHash('sha256').update(operationId).digest('hex');
const input = { operationId, input: {
  launch: { provider: { pluginId: 'happier.machine.digitalocean', localId: 'digitalocean' }, schemaVersion: 1, choices: launch },
  cli: { identity: 'public-release:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier',
    installScript: 'set -eu\nprintf prepared\n', files: [{ path: 'payload.tar.gz', contentsBase64: 'AAECAw==' }] },
  setupScript: 'printf setup\n',
} };
type Request = { url: string; method: string; body?: Uint8Array };
const response = (status: number, value?: unknown) => ({ status, body: value === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(value)) });
function services(request: (request: Request) => Promise<ReturnType<typeof response>>, wait = async () => {}): PluginTestServicesFixture {
  // Only the credential store, native HTTP transport and owner wait are replaced.
  return {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-private' } }) },
    http: { request: async (input: Request) => ({ finalUrl: input.url, headers: {}, ...await request(input) }) },
    machineProvisioners: { waitForNativeObservation: wait },
  } as unknown as PluginTestServicesFixture;
}
function fixture(options: { lostCreate?: boolean; lostSnapshot?: boolean; mismatch?: boolean; delayedDelete?: boolean;
  sourceStatus?: string; snapshotInProgress?: boolean } = {}) {
  let present = false, snapshotPresent = false, tagged = false, deletionAccepted = false;
  const calls: Request[] = [];
  const droplet = () => ({ id: 42, name: 'builder', status: options.sourceStatus ?? 'off', tags: [operationTag], volume_ids: [],
    region: { slug: launch.regionSlug }, size_slug: launch.sizeSlug, image: { id: launch.imageId }, snapshot_ids: snapshotPresent ? [91] : [] });
  const snapshot = () => ({ id: '91', name: operationTag, resource_id: options.mismatch ? '666' : '42',
    resource_type: 'droplet', regions: [launch.regionSlug], tags: tagged ? [operationTag] : [] });
  return { calls, setPresent: (value: boolean) => { present = value; }, setSnapshot: (value: boolean) => { snapshotPresent = value; tagged = value; },
    isPresent: () => present, isSnapshotPresent: () => snapshotPresent,
    async request(request: Request) {
      calls.push(request);
      const url = new URL(request.url), path = url.pathname;
      if (request.method === 'POST' && path === '/v2/droplets') {
        present = true;
        if (options.lostCreate) throw new TypeError('lost connection');
        return response(202, { droplet: { id: 42 } });
      }
      if (path === '/v2/droplets') return response(200, { droplets: present && url.searchParams.get('type') !== 'gpus' ? [droplet()] : [], links: {} });
      if (path === '/v2/images') return response(200, { images: snapshotPresent && tagged ? [{ id: 91 }] : [], links: {} });
      if (path === '/v2/droplets/42/actions' && request.method === 'POST') {
        snapshotPresent = true;
        if (options.lostSnapshot) throw new TypeError('lost connection');
        return response(201, { action: { id: 9, status: 'completed', type: 'snapshot', resource_id: 42, resource_type: 'droplet' } });
      }
      if (path === '/v2/droplets/42/actions') return response(200, { actions: options.snapshotInProgress
        ? [{ id: 9, status: 'in-progress', type: 'snapshot', resource_id: 42, resource_type: 'droplet' }] : [], links: {} });
      if (path === '/v2/droplets/42') {
        if (request.method === 'DELETE') { deletionAccepted = true; if (!options.delayedDelete) present = false; return response(204); }
        if (deletionAccepted && options.delayedDelete) return response(200, { droplet: droplet() });
        return present ? response(200, { droplet: droplet() }) : response(404, { id: 'not_found' });
      }
      if (path === '/v2/snapshots/91') {
        if (request.method === 'DELETE') { snapshotPresent = false; return response(204); }
        return snapshotPresent ? response(200, { snapshot: snapshot() }) : response(404, { id: 'not_found' });
      }
      if (path.endsWith('/resources') && request.method === 'POST') { tagged = true; return response(204); }
      throw new Error('Unexpected request ' + request.method + ' ' + path);
    },
  };
}
async function kitFor(native: ReturnType<typeof fixture>) {
  return createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(native.request) });
}

describe('DigitalOcean preparation through public Actions', () => {
  it('advertises the native Droplet preparation target through the existing option facts', async () => {
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN,
      services: services(async () => response(200, {
        sizes: [{ slug: launch.sizeSlug, memory: 1024, vcpus: 1, disk: 25, transfer: 1, regions: ['nyc3'], available: true }],
        regions: [{ slug: 'nyc3', name: 'New York', available: true, sizes: [launch.sizeSlug] }],
        images: [{ id: 1, slug: 'ubuntu-24-04-x64', name: 'Ubuntu', distribution: 'Ubuntu', regions: ['nyc3'], status: 'available', type: 'base' }], links: {},
      })) });
    try {
      expect(await kit.invokeAction('options', {}, { surface: 'plugin' })).toMatchObject({ base: { nativeFacts: {
        preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: '/opt/happier' },
      } } });
    } finally { await kit.dispose(); }
  });

  it('cold-builds an uncredentialed guest, returns a bootable snapshot and confirms temporary compute is gone', async () => {
    const native = fixture(), kit = await kitFor(native);
    try {
      const ready = await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(ready).toMatchObject({ kind: 'ready', artifact: { value: { operationTag, dropletId: 42, snapshotId: '91', launch: { ...launch, imageId: 91 } } } });
      expect(native.isPresent()).toBe(false);
      const create = native.calls.find(call => call.method === 'POST' && new URL(call.url).pathname === '/v2/droplets');
      const body = JSON.parse(new TextDecoder().decode(create?.body));
      expect(body).toMatchObject({ region: launch.regionSlug, size: launch.sizeSlug, image: 1, tags: [operationTag] });
      expect(body.user_data).toContain('AAECAw==');
      expect(body.user_data).toContain(input.input.cli.installScript);
      expect(body.user_data).toContain(input.input.setupScript);
      expect(body.user_data).not.toMatch(/fixture-private|happier-bootstrap|auth login|daemon start/);
      expect(body.ssh_keys).toBeUndefined();
      expect(await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' })).toEqual(ready);
      if (ready.kind !== 'ready') throw new Error('Expected prepared image');
      expect(await kit.invokeAction('prepare-destroy', { artifact: ready.artifact }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(native.isSnapshotPresent()).toBe(false);
      expect(native.calls.slice(-1)[0]?.method).toBe('GET');
    } finally { await kit.dispose(); }
  });

  it.each(['lostCreate', 'lostSnapshot'] as const)('recovers %s in a fresh invocation without purchasing again and deletes all owned resources', async option => {
    const native = fixture({ [option]: true }), kit = await kitFor(native);
    try {
      const unknown = await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(unknown).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { operationTag } } });
      const beforeInspect = native.calls.length;
      const recovered = await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' });
      expect(native.calls.slice(beforeInspect).every(call => call.method === 'GET')).toBe(true);
      if (option === 'lostCreate') {
        expect(recovered).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { operationTag, dropletId: 42 } } });
        if (recovered.kind !== 'pending') throw new Error('Expected retained build');
        expect(await kit.invokeAction('prepare-destroy', { nativeOperation: recovered.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      } else {
        expect(recovered).toMatchObject({ kind: 'failed', code: 'digitalocean_preparation_cleanup_required',
          nativeOperationRef: { value: { operationTag, dropletId: 42, snapshotId: '91' } } });
        expect(native.isPresent()).toBe(true);
        if (recovered.kind !== 'failed') throw new Error('Expected explicit leftover cleanup');
        expect(await kit.invokeAction('prepare-destroy', { nativeOperation: recovered.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      }
      expect(native.isPresent()).toBe(false);
      expect(native.isSnapshotPresent()).toBe(false);
      expect(native.calls.filter(call => call.method === 'POST' && new URL(call.url).pathname === '/v2/droplets')).toHaveLength(1);
    } finally { await kit.dispose(); }
  });

  it('never adopts or deletes an image whose native source disagrees with the owned build', async () => {
    const native = fixture({ mismatch: true }), kit = await kitFor(native);
    native.setPresent(true); native.setSnapshot(true);
    try {
      const read = await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' });
      expect(read).toMatchObject({ kind: 'unknown', code: 'digitalocean_preparation_identity_mismatch' });
      if (!('nativeOperationRef' in read)) throw new Error('Expected recovery handle');
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: read.nativeOperationRef }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'refused', code: 'digitalocean_preparation_identity_mismatch' });
      expect(native.calls.some(call => call.method === 'DELETE')).toBe(false);
    } finally { await kit.dispose(); }
  });

  it('keeps deletion pending until native absence rather than trusting a 204', async () => {
    const native = fixture({ delayedDelete: true }), kit = await kitFor(native);
    native.setPresent(true);
    try {
      const pending = await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' });
      if (pending.kind !== 'pending') throw new Error('Expected retained build');
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: pending.nativeOperationRef }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'pending', nativeOperationRef: { value: { dropletId: 42 } } });
    } finally { await kit.dispose(); }
  });

  it('retains a cancelled cold build for owned cleanup without allocating or snapshotting again', async () => {
    const native = fixture({ sourceStatus: 'active' });
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN,
      services: services(native.request, async () => { throw new DOMException('Cancelled', 'AbortError'); }) });
    try {
      const result = await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(result).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { operationTag, dropletId: 42 } } });
      if (result.kind !== 'unknown') throw new Error('Expected retained cancelled build');
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: result.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(native.isPresent()).toBe(false);
      expect(native.calls.filter(call => call.method === 'POST').map(call => new URL(call.url).pathname)).toEqual(['/v2/droplets']);
    } finally { await kit.dispose(); }
  });

  it('holds cleanup while a native snapshot is still being produced', async () => {
    const native = fixture({ snapshotInProgress: true }), kit = await kitFor(native);
    native.setPresent(true);
    try {
      const pending = await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' });
      if (pending.kind !== 'pending') throw new Error('Expected retained build');
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: pending.nativeOperationRef }, { surface: 'plugin' })).toMatchObject({ kind: 'pending' });
      expect(native.calls.some(call => call.method === 'DELETE')).toBe(false);
    } finally { await kit.dispose(); }
  });

  it('preserves provider refusal without exposing vendor details or claiming allocation', async () => {
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN,
      services: services(async () => response(403, { id: 'forbidden', message: 'private native detail' })) });
    try {
      const result = await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(result).toEqual({ kind: 'refused', code: 'digitalocean_preparation_forbidden' });
      expect(JSON.stringify(result)).not.toContain('private native detail');
    } finally { await kit.dispose(); }
  });

  it('refuses payloads beyond the native 64 KiB cloud-init boundary before creating a billable guest', async () => {
    const native = fixture(), kit = await kitFor(native);
    try {
      expect(await kit.invokeAction('prepare-build', { ...input, input: { ...input.input, cli: { ...input.input.cli,
        files: [{ path: 'payload.tar.gz', contentsBase64: 'A'.repeat(65536) }] } } }, { surface: 'plugin' }))
        .toEqual({ kind: 'refused', code: 'digitalocean_preparation_user_data_too_large' });
      expect(native.calls).toEqual([]);
    } finally { await kit.dispose(); }
  });

  it('preserves a valid payload exactly at the native cloud-init byte boundary', async () => {
    const first = fixture(), firstKit = await kitFor(first);
    let baseBytes: number;
    try {
      await firstKit.invokeAction('prepare-build', input, { surface: 'plugin' });
      const create = first.calls.find(call => call.method === 'POST' && new URL(call.url).pathname === '/v2/droplets');
      baseBytes = new TextEncoder().encode(JSON.parse(new TextDecoder().decode(create?.body)).user_data).byteLength;
    } finally { await firstKit.dispose(); }
    const native = fixture(), kit = await kitFor(native);
    try {
      const setupScript = '#' + 'x'.repeat(65536 - baseBytes! + input.input.setupScript.length - 1);
      expect(await kit.invokeAction('prepare-build', { ...input, input: { ...input.input, setupScript } }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'ready' });
      const create = native.calls.find(call => call.method === 'POST' && new URL(call.url).pathname === '/v2/droplets');
      expect(new TextEncoder().encode(JSON.parse(new TextDecoder().decode(create?.body)).user_data).byteLength).toBe(65536);
    } finally { await kit.dispose(); }
  });

  it('preserves typed host transport errors', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Reconnect' });
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(async () => { throw refusal; }) });
    try { await expect(kit.invokeAction('prepare-build', input, { surface: 'plugin' })).rejects.toMatchObject({ data: refusal.data }); }
    finally { await kit.dispose(); }
  });
});

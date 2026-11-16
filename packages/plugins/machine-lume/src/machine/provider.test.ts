import { describe, expect, it, vi } from 'vitest';
import { createLumeNativeClient } from './nativeClient';
import { createLumeProvider } from './provider';
import { tmpdir } from 'node:os';
import { MachineProvisionerCheckResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';

const resource = { storage: 'external_disk', vmName: 'managed-vm' };
const launch = { ...resource, image: 'linux-ubuntu:latest', registry: 'ghcr.io', organization: 'trycua' };
const details = {
  name: resource.vmName, locationName: resource.storage, status: 'running', os: 'linux',
  cpuCount: 2, memorySize: 4294967296, diskSize: { allocated: 1073741824, total: 21474836480 }, display: '1024x768',
};

describe('Lume prepared launch', () => {
  it.each(['personal-vm', 'happier-prepared-a/b', 'happier-prepared-a:b'])('rejects a non-owned or aliased prepared source (%s) before native effects', async vmName => {
    let effects = 0;
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => { effects++; throw new Error('unexpected native effect'); } });
    expect(await createLumeProvider({ native, observedAt: 1 }).acquire({ storage: 'home',
      image: { kind: 'prepared', storage: 'home', vmName }, cpu: 2, memoryBytes: 4 * 1024 ** 3,
      diskBytes: 150 * 1024 ** 3 }, 'managed-1')).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(effects).toBe(0);
  });
  it('clones the owned stopped prepared base and keeps the ordinary hardware/start owner', async () => {
    const source = { storage: 'prepared_disk', vmName: 'happier-prepared-operation-1' };
    const destination = { storage: 'home', vmName: 'happier-managed-1' };
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    let cloned = false;
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, method, body });
      if (url.pathname === '/lume/host/status') return Response.json({ version: '0.6.1' });
      if (url.pathname === '/lume/config/locations') return Response.json([{ name: 'home' }]);
      if (url.pathname === '/lume/vms/clone') {
        cloned = true;
        return Response.json({ source: source.vmName, destination: destination.vmName });
      }
      if (url.pathname === '/lume/vms') return Response.json([{ ...details, ...source, name: source.vmName, locationName: source.storage, status: 'stopped' }]);
      if (url.pathname.endsWith('/run')) return new Response(null, { status: 202 });
      const identity = url.pathname.endsWith(source.vmName) ? source : destination;
      if (identity === destination && !cloned) return Response.json({ message: `Virtual machine not found: ${identity.vmName}` }, { status: 400 });
      return Response.json({ ...details, name: identity.vmName, locationName: identity.storage, status: 'stopped' });
    } });
    const result = await createLumeProvider({ native, observedAt: 1 }).acquire({ storage: destination.storage,
      image: { kind: 'prepared', ...source, privateCarrier: { kind: 'lume-default-password', guestOs: 'linux', user: 'lume' } },
      cpu: details.cpuCount, memoryBytes: details.memorySize, diskBytes: details.diskSize.total }, 'managed-1');
    expect(result).toMatchObject({ kind: 'bound', startPending: true, resource: { value: { ...destination,
      privateCarrier: { guestOs: 'linux', user: 'lume' } } } });
    expect(requests.filter(request => request.method !== 'GET')).toEqual([
      { path: '/lume/vms/clone', method: 'POST', body: { name: source.vmName, newName: destination.vmName,
        sourceLocation: source.storage, destLocation: destination.storage } },
      { path: `/lume/vms/${destination.vmName}/run`, method: 'POST', body: { storage: destination.storage, noDisplay: true, vnc: 'disabled' } },
    ]);
  });
});

// Only the native HTTP boundary is replaced. Recovery and response interpretation stay real.
function setup(responses: Array<Response | Error>) {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const nativeFetch: typeof fetch = async (input, init) => {
    requests.push({ url: new URL(String(input)), init });
    if (new URL(String(input)).pathname === '/lume/vms') return Response.json([details]);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error('Unexpected native request');
    return response;
  };
  return { requests, client: createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: nativeFetch }) };
}

describe('Lume 0.6.1 native HTTP boundary', () => {
  // Settings.swift LumeSettings at 3350f504014c85416009a90fcb339fe556ce02fc.
  // Substitute the real temporary volume for the recorded private Mac path.
  it('reports observed host memory and native storage headroom with one config read per check', async () => {
    const config = { vmLocations: [{ name: 'home', path: tmpdir() }], defaultLocationName: 'home',
      cacheDirectory: '/private/cache', cachingEnabled: true, telemetryEnabled: false };
    const { client, requests } = setup([Response.json({ version: '0.6.1' }), Response.json(config),
      Response.json({ version: '0.6.1' }), Response.json(config)]);
    const provider = createLumeProvider({ native: client, observedAt: 123 });
    for (let call = 1; call <= 2; call++) {
      const result = MachineProvisionerCheckResultV1Schema.parse(await provider.check());
      expect(result).toMatchObject({ available: true, code: 'lume_cache_enabled', localResources: {
        observedAt: 123, availableMemoryBytes: expect.any(Number), availableDiskBytes: expect.any(Number),
      } });
      expect(result.localResources?.availableMemoryBytes).toBeGreaterThan(0);
      expect(result.localResources?.availableDiskBytes).toBeGreaterThanOrEqual(0);
      // CPU count is capacity, not observed idle CPU headroom.
      expect(result.localResources).not.toHaveProperty('availableCpuCores');
      expect(JSON.stringify(result)).not.toContain('/private');
      expect(requests.filter(({ url }) => url.pathname === '/lume/config')).toHaveLength(call);
    }
  });

  it.each([
    { cachingEnabled: true },
    { cachingEnabled: true, defaultLocationName: 'home', vmLocations: [{ name: 'home', path: '~/unobserved' }] },
    { cachingEnabled: true, defaultLocationName: 'home', vmLocations: [{ name: 'home', path: '/nonexistent-lume-facts-volume' }] },
    { cachingEnabled: true, defaultLocationName: 'home', vmLocations: [{ name: 'home', path: tmpdir() }, { name: 'external', path: tmpdir() }] },
  ])('omits unobservable or ambiguous storage headroom without losing memory or readiness', async config => {
    const { client } = setup([Response.json({ version: '0.6.1' }), Response.json(config)]);
    const result = MachineProvisionerCheckResultV1Schema.parse(await createLumeProvider({ native: client, observedAt: 123 }).check());
    expect(result).toMatchObject({ available: true, localResources: { observedAt: 123, availableMemoryBytes: expect.any(Number) } });
    expect(result.localResources).not.toHaveProperty('availableDiskBytes');
  });

  it.each(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'ECONNRESET'])(
    'preserves delivery certainty for a power request failing with %s', async code => {
      const { client } = setup([new TypeError('private fetch URL', { cause: Object.assign(new Error('private address'), { code }) })]);
      const result = await createLumeProvider({ native: client, observedAt: 1 }).power(resource, 'start');
      expect(result).toEqual(code === 'ECONNRESET' ? { kind: 'unknown', code: 'transport',
        nativeCause: { localCause: 'native_route_unavailable' } } : { kind: 'refused', code: 'native_route_unavailable',
        nativeCause: { localCause: 'native_route_unavailable' } });
      expect(JSON.stringify(result)).not.toContain('private');
    });
  it('preserves the exact identity after a dropped pull response and inspects it without another pull', async () => {
    const { client, requests } = setup([
      new Error('Dropped response with secret'),
      Response.json(details),
    ]);
    expect(await client.pull(launch)).toEqual({ kind: 'unknown', resource, reason: 'transport' });
    expect(await client.inspect(resource)).toMatchObject({ kind: 'present', resource, vendorStatus: 'running' });
    expect(requests.map(({ url, init }) => [url.pathname, url.searchParams.get('storage'), init?.method])).toEqual([
      ['/lume/pull', null, 'POST'], ['/lume/vms/managed-vm', resource.storage, 'GET'],
    ]);
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      image: launch.image, name: resource.vmName, registry: launch.registry, organization: launch.organization, storage: resource.storage,
    });
  });

  it.each([400, 404, 500])('never treats inspect HTTP %s as native absence', async (status) => {
    const { client } = setup([Response.json({ message: 'VM not found or native error secret' }, { status })]);
    expect(await client.inspect(resource)).toEqual({ kind: 'unknown', resource, reason: 'http', httpStatus: status,
      nativeCause: status === 404 ? { localCause: 'native_route_not_found', route: 'inspect', httpStatus: 404 }
        : { httpStatusClass: status >= 500 ? '5xx' : '4xx' } });
  });

  it('recognizes only the vendor exact-name not-found response as confirmed absence', async () => {
    const { client } = setup([
      Response.json({ message: `Virtual machine not found: ${resource.vmName}` }, { status: 400 }),
      Response.json({ message: 'Virtual machine not found: neighbor' }, { status: 400 }),
      Response.json({ message: `Virtual machine not found: ${resource.vmName}` }, { status: 503 }),
      Response.json({ message: `Pull failed for '${resource.vmName}': Virtual machine not found: ${resource.vmName}` }, { status: 400 }),
      new Error('network unavailable'),
    ]);
    expect(await client.inspect(resource)).toEqual({ kind: 'absent', resource });
    for (const reason of ['http', 'http', 'http', 'transport']) {
      expect(await client.inspect(resource)).toMatchObject({ kind: 'unknown', resource, reason });
    }
  });

  it('does not accept a neighboring VM returned for the exact resource', async () => {
    const { client } = setup([Response.json({ ...details, name: 'neighbor' })]);
    expect(await client.inspect(resource)).toEqual({ kind: 'unknown', resource, reason: 'response' });
  });

  it('refuses storage mismatches and name-only asynchronous progress as exact-resource proof', async () => {
    const { client } = setup([
      Response.json({ ...details, locationName: 'neighbor-storage' }),
      Response.json({ name: resource.vmName, status: 'pulling', downloadProgress: 50 }),
    ]);
    expect(await client.inspect(resource)).toEqual({ kind: 'unknown', resource, reason: 'response' });
    expect(await client.inspect(resource)).toEqual({ kind: 'unknown', resource, reason: 'response' });
  });

  it('reports native command acceptance without certifying managed lifecycle completion', async () => {
    const { client, requests } = setup([
      Response.json({ message: 'Image pulled successfully', name: resource.vmName, image: launch.image }),
      Response.json({ message: 'VM start initiated' }, { status: 202 }),
    ]);
    expect(await client.pull(launch)).toEqual({ kind: 'pull-accepted', resource });
    expect(await client.run(resource)).toEqual({ kind: 'start-accepted', resource });
    expect(requests.slice(1).map(({ url, init }) => [url.pathname, init?.method, init?.body && JSON.parse(String(init.body))])).toEqual([
      ['/lume/vms', 'GET', undefined],
      ['/lume/vms/managed-vm/run', 'POST', { storage: resource.storage, noDisplay: true, vnc: 'disabled' }],
    ]);
  });

  it.each(['stop', 'destroy'] as const)('inspects recorded storage before exact %s and preserves native acceptance', async (operation) => {
    const { client, requests } = setup([Response.json({ ...details, status: operation === 'destroy' ? 'stopped' : 'running' }), new Response(null, { status: 200 })]);
    expect(await client[operation](resource)).toEqual({ kind: operation === 'stop' ? 'stop-accepted' : 'delete-accepted', resource });
    expect(requests.map(({ url, init }) => [url.pathname, url.searchParams.get('storage'), init?.method])).toEqual([
      ['/lume/vms/managed-vm', resource.storage, 'GET'],
      [operation === 'stop' ? '/lume/vms/managed-vm/stop' : '/lume/vms/managed-vm', operation === 'stop' ? null : resource.storage, operation === 'stop' ? 'POST' : 'DELETE'],
    ]);
  });

  it.each(['stop', 'destroy'] as const)('never dispatches %s after uncertain or neighboring storage inspection', async (operation) => {
    const { client, requests } = setup([Response.json({ ...details, locationName: 'neighbor' })]);
    expect(await client[operation](resource)).toEqual({ kind: 'unknown', resource, reason: 'response' });
    expect(requests).toHaveLength(1);
  });

  it('refuses malformed input and a canceled request before any effect', async () => {
    const nativeFetch = vi.fn<typeof fetch>();
    const client = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: nativeFetch });
    await expect(client.pull({ ...launch, vmName: '../neighbor' })).rejects.toThrow();
    await expect(client.pull({ ...launch, secret: 'not a native input' })).rejects.toThrow();
    await expect(client.pull(launch, AbortSignal.abort())).rejects.toThrow();
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('reads anonymous public OCI catalog tags across same-repository pages, not cached short IDs', async () => {
    const { client, requests } = setup([Response.json({ token: 'anonymous-public-token' }),
      Response.json({ name: 'trycua/macos', tags: ['26'] }, { headers: { link: '</v2/trycua/macos/tags/list?last=26>; rel="next"' } }),
      Response.json({ name: 'trycua/macos', tags: ['26-slim'] })]);
    expect(await client.catalog('macos')).toEqual({ kind: 'catalog', references: ['ghcr.io/trycua/macos:26', 'ghcr.io/trycua/macos:26-slim'] });
    expect(requests.map(({ url }) => url.origin)).toEqual(['https://ghcr.io', 'https://ghcr.io', 'https://ghcr.io']);
    expect(new Headers(requests[1].init?.headers).get('authorization')).toBe('Bearer anonymous-public-token');
  });

  it('keeps anonymous auth failure, wrong repository and invalid pagination unavailable without leaking token', async () => {
    for (const responses of [
      [Response.json({ errors: [{ code: 'UNAUTHORIZED' }] }, { status: 401 })],
      [Response.json({ token: 'anonymous-public-token' }), Response.json({ name: 'neighbor/macos', tags: ['26'] })],
      [Response.json({ token: 'anonymous-public-token' }), Response.json({ name: 'trycua/macos', tags: ['26'] },
        { headers: { link: '<https://foreign.example/next>; rel="next"' } })],
      [Response.json({ token: 'anonymous-public-token' }), Response.json({ name: 'trycua/macos', tags: ['26'] },
        { headers: { link: '</v2/trycua/macos/tags/list>; rel="next"' } })],
    ]) {
      const { client, requests } = setup(responses);
      const result = await client.catalog('macos');
      expect(result.kind).toBe('unknown');
      expect(JSON.stringify(result)).not.toContain('anonymous-public-token');
      expect(requests.every(({ url }) => url.origin === 'https://ghcr.io')).toBe(true);
      expect(requests.length).toBeLessThanOrEqual(2);
    }
  });

  it('configures only the bound storage/name using native size strings', async () => {
    const { client, requests } = setup([Response.json({ message: 'VM settings updated successfully' })]);
    expect(await client.configure(resource, { cpu: 2, memory: '4GB', diskSize: '20GB' })).toEqual({ kind: 'configure-accepted', resource });
    expect(requests[0].init?.method).toBe('PATCH');
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ storage: resource.storage, cpu: 2, memory: '4GB', diskSize: '20GB' });
  });

  it('reads the published disk minimum from OCI metadata without fetching image layers', async () => {
    const { client, requests } = setup([Response.json({ token: 'anonymous-public-token' }),
      Response.json({ annotations: { 'org.trycua.lume.disk-size': '161061273600' } }),
      Response.json({ annotations: { 'org.trycua.lume.disk-size': '171798691840' } })]);
    // This is an external registry read, not a native image pull or blob download.
    expect(await client.imageDiskBytes('ghcr.io/trycua/macos:26-slim'))
      .toEqual({ kind: 'image', diskBytes: 161061273600 });
    expect(await client.imageDiskBytes('ghcr.io/trycua/macos:26'))
      .toEqual({ kind: 'image', diskBytes: 171798691840 });
    expect(requests.map(({ url }) => url.pathname)).toEqual(['/token', '/v2/trycua/macos/manifests/26-slim', '/v2/trycua/macos/manifests/26']);
  });

  it.each([undefined, '0', '-1', 'not-a-size', '9007199254740992'])('keeps malformed published disk minimum %s unknown', async diskBytes => {
    const { client } = setup([Response.json({ token: 'anonymous-public-token' }),
      Response.json({ annotations: diskBytes === undefined ? {} : { 'org.trycua.lume.disk-size': diskBytes } })]);
    expect(await client.imageDiskBytes('ghcr.io/trycua/macos:26-slim')).toEqual({ kind: 'unknown', reason: 'response' });
  });

  it('strips noncontract private detail fields from exact inspection', async () => {
    const { client } = setup([Response.json({ ...details, vncUrl: 'vnc://private', ipAddress: '10.0.0.1', secret: 'private' })]);
    const result = await client.inspect(resource);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('10.0.0.1');
    expect(result).toMatchObject({ kind: 'present', resource, os: 'linux', cpu: 2, memoryBytes: 4294967296, diskBytes: 21474836480 });
    expect(result).toHaveProperty('vendorStatus', 'running');
    expect(result).not.toHaveProperty('status');
  });

  it('reports the installed version without turning the vendor host-status cap into a universal guest limit', async () => {
    const { client, requests } = setup([Response.json({ status: 'healthy', version: '0.6.1', vm_count: 1, max_vms: 2, available_slots: 1 })]);
    expect(await client.check()).toEqual({ kind: 'runtime', version: '0.6.1' });
    expect(requests[0].url.pathname).toBe('/lume/host/status');
    expect(requests[0].init?.method).toBe('GET');
  });

  it('keeps a dispatched cancellation and unreadable pull result uncertain', async () => {
    const { client } = setup([new DOMException('Canceled private request', 'AbortError'), new Response('incomplete', { status: 200 })]);
    expect(await client.pull(launch)).toEqual({ kind: 'unknown', resource, reason: 'transport' });
    expect(await client.pull(launch)).toEqual({ kind: 'unknown', resource, reason: 'response' });
  });

  it('returns native storage names without leaking their host paths', async () => {
    const { client, requests } = setup([Response.json([{ name: 'home', path: '/Users/private/.lume', extra: 'private' }])]);
    expect(await client.locations()).toEqual({ kind: 'locations', locations: [{ name: 'home' }] });
    expect(requests[0].url.pathname).toBe('/lume/config/locations');
  });

  it('rejects colon VM aliases that the vendor maps to a different native name', async () => {
    const nativeFetch = vi.fn<typeof fetch>();
    const client = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: nativeFetch });
    await expect(client.pull({ ...launch, vmName: 'neighbor:latest' })).rejects.toThrow();
    await expect(client.destroy({ ...resource, vmName: 'neighbor:latest' })).rejects.toThrow();
    expect(nativeFetch).not.toHaveBeenCalled();
  });
});

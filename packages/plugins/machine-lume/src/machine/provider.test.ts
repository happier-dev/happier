import { describe, expect, it, vi } from 'vitest';
import { createLumeNativeClient } from './nativeClient';

const resource = { storage: 'external_disk', vmName: 'managed-vm' };
const launch = { ...resource, image: 'linux-ubuntu:latest', registry: 'ghcr.io', organization: 'trycua' };
const details = {
  name: resource.vmName, locationName: resource.storage, status: 'running', os: 'linux',
  cpuCount: 2, memorySize: 4294967296, diskSize: { allocated: 1073741824, total: 21474836480 }, display: '1024x768',
};

// Only the native HTTP boundary is replaced. Recovery and response interpretation stay real.
function setup(responses: Array<Response | Error>) {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const nativeFetch: typeof fetch = async (input, init) => {
    requests.push({ url: new URL(String(input)), init });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error('Unexpected native request');
    return response;
  };
  return { requests, client: createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: nativeFetch }) };
}

describe('Lume 0.6.1 native HTTP boundary', () => {
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
    expect(await client.inspect(resource)).toEqual({ kind: 'unknown', resource, reason: 'http', httpStatus: status });
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
      ['/lume/vms/managed-vm/run', 'POST', { storage: resource.storage, noDisplay: true, vnc: 'disabled' }],
    ]);
  });

  it.each(['stop', 'destroy'] as const)('inspects recorded storage before exact %s and preserves native acceptance', async (operation) => {
    const { client, requests } = setup([Response.json(details), new Response(null, { status: 200 })]);
    expect(await client[operation](resource)).toEqual({ kind: operation === 'stop' ? 'stop-accepted' : 'delete-accepted', resource });
    expect(requests.map(({ url, init }) => [url.pathname, url.searchParams.get('storage'), init?.method])).toEqual([
      ['/lume/vms/managed-vm', resource.storage, 'GET'],
      [operation === 'stop' ? '/lume/vms/managed-vm/stop' : '/lume/vms/managed-vm', resource.storage, operation === 'stop' ? 'POST' : 'DELETE'],
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

  it('reads only native cached image identities and never invents catalog hardware facts', async () => {
    // Pinned getImages projects metadata.image (name without its tag) and
    // manifestId.prefix(12); neither is a fully qualified pull reference.
    const images = [{ repository: 'linux-ubuntu', imageId: 'sha256_f49b0' }];
    const { client, requests } = setup([Response.json(images), Response.json({ unavailable: true })]);
    expect(await client.images('trycua')).toEqual({ kind: 'images', images });
    expect(requests[0].url.pathname).toBe('/lume/images');
    expect(requests[0].url.searchParams.get('organization')).toBe('trycua');
    expect(await client.images('trycua')).toEqual({ kind: 'unknown', reason: 'response' });
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

  it('strips noncontract private detail fields from exact inspection', async () => {
    const { client } = setup([Response.json({ ...details, vncUrl: 'vnc://private', ipAddress: '10.0.0.1', secret: 'private' })]);
    const result = await client.inspect(resource);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('10.0.0.1');
    expect(result).toMatchObject({ kind: 'present', resource, os: 'linux', cpu: 2, memoryBytes: 4294967296, diskBytes: 21474836480 });
    expect(result).toHaveProperty('vendorStatus', 'running');
    expect(result).not.toHaveProperty('status');
  });

  it('lists storage-qualified native facts without inferring absence from an empty list', async () => {
    const { client, requests } = setup([Response.json([details]), Response.json([]), Response.json([{ ...details, locationName: 'neighbor' }])]);
    expect(await client.list(resource.storage)).toMatchObject({ kind: 'vms', vms: [{ kind: 'present', resource, vendorStatus: 'running' }] });
    expect(requests[0].url.pathname).toBe('/lume/vms');
    expect(requests[0].url.searchParams.get('storage')).toBe(resource.storage);
    expect(await client.list(resource.storage)).toEqual({ kind: 'vms', vms: [] });
    expect(await client.list(resource.storage)).toEqual({ kind: 'unknown', reason: 'response' });
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

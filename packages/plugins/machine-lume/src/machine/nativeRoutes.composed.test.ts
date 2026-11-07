import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerDestroyResultV1Schema, MachineProvisionerPowerResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createLumeNativeClient } from './nativeClient.js';
import { createLumeProvider } from './provider.js';

const resource = { storage: 'external_disk', vmName: 'happier-route-contract' };
const routes = [
  ['GET', '/lume/vms'], ['GET', '/lume/vms/:name'], ['DELETE', '/lume/vms/:name'],
  ['PATCH', '/lume/vms/:name'], ['POST', '/lume/vms/:name/run'], ['POST', '/lume/vms/:name/stop'],
  ['POST', '/lume/pull'], ['GET', '/lume/host/status'], ['GET', '/lume/config/locations'],
  ['GET', '/lume/config'], ['POST', '/lume/config'],
] as const;

// External boundary only. Reproduce Server.swift Route.matches literally:
// method + raw URI segments (including query), then strip query for parameters.
// Basis: trycua/cua 3350f504014c85416009a90fcb339fe556ce02fc, Lume 0.6.1.
async function withLumeServer(run: (client: ReturnType<typeof createLumeNativeClient>, requests: string[]) => Promise<void>, missingRoute?: string, port = 0) {
  let status = 'running';
  let present = true;
  let cpuCount = 2;
  let cachingEnabled = false;
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const uri = req.url ?? '/';
    requests.push(`${req.method} ${uri}`);
    const parts = uri.split('/').filter(Boolean);
    const route = routes.find(([method, pattern]) => {
      const expected = pattern.split('/').filter(Boolean);
      return method === req.method && expected.length === parts.length
        && expected.every((part, index) => part.startsWith(':') || part === parts[index]);
    });
    const reply = (code: number, value: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (!route || `${route[0]} ${route[1]}` === missingRoute) return reply(404, { message: 'Not found: private native diagnostics' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    const url = new URL(uri, 'http://localhost');
    const pattern = route[1];
    if (pattern === '/lume/host/status') return reply(200, { version: '0.6.1' });
    if (pattern === '/lume/config/locations') return reply(200, [{ name: resource.storage }]);
    if (pattern === '/lume/vms') return reply(200, [{ name: resource.vmName, locationName: resource.storage, status, os: 'linux',
      cpuCount, memorySize: 4 * 1024 ** 3, diskSize: { allocated: 1024 ** 3, total: 20 * 1024 ** 3 } }]);
    if (pattern === '/lume/config') {
      if (req.method === 'POST') {
        if (JSON.stringify(body) !== JSON.stringify({ cachingEnabled: true })) return reply(400, {});
        cachingEnabled = true;
        return reply(200, { message: 'Configuration updated successfully' });
      }
      return reply(200, { cachingEnabled, cacheDirectory: '/user-selected/cache', homeDirectory: '/private/home' });
    }
    const storage = req.method === 'GET' || req.method === 'DELETE' ? url.searchParams.get('storage') : body.storage;
    // Native Stop defaults to home when the body omits storage. An external
    // location makes an omitted/misplaced body observably wrong after routing.
    if (storage !== resource.storage) return reply(400, { message: 'Wrong storage' });
    if (pattern === '/lume/pull') {
      if (body.name !== resource.vmName || body.image !== 'linux:prepared' || body.registry !== 'registry.example' || body.organization !== 'team') return reply(400, {});
      present = true;
      status = 'stopped';
      return reply(200, { name: body.name, image: body.image });
    }
    if (url.pathname.split('/')[3] !== resource.vmName) return reply(400, {});
    if (!present) return reply(400, { message: `Virtual machine not found: ${resource.vmName}` });
    if (pattern.endsWith('/stop')) { status = 'stopped'; return reply(200, {}); }
    if (pattern.endsWith('/run')) {
      if (body.noDisplay !== true || body.vnc !== 'disabled') return reply(400, {});
      status = 'running'; return reply(202, {});
    }
    if (req.method === 'DELETE') {
      if (status !== 'stopped') return reply(400, {});
      present = false; return reply(200, {});
    }
    if (req.method === 'PATCH') {
      if (status !== 'stopped' || body.cpu !== 4) return reply(400, {});
      cpuCount = 4; return reply(200, {});
    }
    return reply(200, { name: resource.vmName, locationName: resource.storage, status, os: 'linux', cpuCount,
      memorySize: 4 * 1024 ** 3, diskSize: { allocated: 1024 ** 3, total: 20 * 1024 ** 3 },
      ipAddress: '192.0.2.2', sshAvailable: true });
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback address');
  try {
    await run(createLumeNativeClient({ baseUrl: `http://127.0.0.1:${address.port}` }), requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('pinned Lume HTTP route composition', () => {
  it.each(['start', 'stop'] as const)('reports refused %s as non-delivery when the native endpoint refuses connections, and allows a later retry', async intent => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback address');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const provider = createLumeProvider({ native: createLumeNativeClient({ baseUrl: `http://127.0.0.1:${address.port}` }), observedAt: 123 });
    expect(MachineProvisionerPowerResultV1Schema.parse(await provider.power(resource, intent))).toEqual({
      kind: 'refused', code: 'native_route_unavailable', nativeCause: { localCause: 'native_route_unavailable' },
    });
    await withLumeServer(async () => {
      expect(await provider.power(resource, intent)).toEqual({ kind: 'confirmed' });
    }, undefined, address.port);
  });
  it('prepares caching through real HTTP before acquire and exposes the resulting state through the strict check reader', async () => {
    await withLumeServer(async (native, requests) => {
      const provider = createLumeProvider({ native, observedAt: 123 });
      expect(MachineProvisionerCheckResultV1Schema.parse(await provider.check()))
        .toMatchObject({ available: true, code: 'lume_cache_disabled' });
      const result = await provider.acquire({ storage: resource.storage, cpu: 4, memoryBytes: 4 * 1024 ** 3, diskBytes: 20 * 1024 ** 3,
        image: { kind: 'native-image', reference: 'registry.example/team/linux:prepared',
          privateCarrier: { kind: 'lume-default-password', guestOs: 'linux', user: 'owner' } } }, 'route-contract');
      expect(result).toMatchObject({ kind: 'bound', resource: { value: resource } });
      expect(MachineProvisionerCheckResultV1Schema.parse(await provider.check()))
        .toMatchObject({ available: true, code: 'lume_cache_enabled' });
      expect(requests.filter(request => request === 'POST /lume/config')).toHaveLength(1);
      expect(requests.indexOf('POST /lume/config')).toBeLessThan(requests.indexOf('POST /lume/pull'));
    });
  });

  it('stops, wakes and destroys a running VM through the real provider and strict result readers', async () => {
    await withLumeServer(async (native, requests) => {
      const provider = createLumeProvider({ native, observedAt: 123 });
      expect(await provider.inspect(resource)).toMatchObject({ availability: 'present', power: 'running' });
      expect(MachineProvisionerPowerResultV1Schema.parse(await provider.power(resource, 'stop'))).toEqual({ kind: 'confirmed' });
      expect(await provider.inspect(resource)).toMatchObject({ power: 'stopped', storage: 'retained' });
      expect(MachineProvisionerPowerResultV1Schema.parse(await provider.power(resource, 'start'))).toEqual({ kind: 'confirmed' });
      expect(await provider.inspect(resource)).toMatchObject({ power: 'running' });
      expect(MachineProvisionerDestroyResultV1Schema.parse(await provider.destroy(resource))).toEqual({ kind: 'confirmed' });
      expect(await provider.inspect(resource)).toMatchObject({ availability: 'absent', storage: 'lost' });
      expect(requests.filter(request => !request.startsWith('GET '))).toEqual([
        `POST /lume/vms/${resource.vmName}/stop`, `POST /lume/vms/${resource.vmName}/run`,
        `POST /lume/vms/${resource.vmName}/stop`, `DELETE /lume/vms/${resource.vmName}?storage=${resource.storage}`,
      ]);
    });
  });

  it('uses the pinned pull/configure/get/run contracts and exact private connection read', async () => {
    await withLumeServer(async native => {
      expect(await native.check()).toEqual({ kind: 'runtime', version: '0.6.1' });
      expect(await native.locations()).toEqual({ kind: 'locations', locations: [{ name: resource.storage }] });
      expect(await native.pull({ ...resource, image: 'linux:prepared', registry: 'registry.example', organization: 'team' })).toMatchObject({ kind: 'pull-accepted' });
      expect(await native.configure(resource, { cpu: 4 })).toMatchObject({ kind: 'configure-accepted' });
      expect(await native.inspect(resource)).toMatchObject({ kind: 'present', cpu: 4, vendorStatus: 'stopped' });
      expect(await native.run(resource)).toMatchObject({ kind: 'start-accepted' });
      expect(await native.connection(resource)).toMatchObject({ kind: 'connection', resource, address: '192.0.2.2' });
    });
  });

  it.each(['stop', 'run', 'delete'] as const)('settles native %s route404 as a typed refusal with no repeated mutation', async route => {
    await withLumeServer(async (native, requests) => {
      const provider = createLumeProvider({ native, observedAt: 123 });
      if (route === 'delete') expect(await provider.power(resource, 'stop')).toEqual({ kind: 'confirmed' });
      const result = route === 'delete' ? await provider.destroy(resource) : await provider.power(resource, route === 'run' ? 'start' : 'stop');
      expect(MachineProvisionerPowerResultV1Schema.parse(result)).toEqual({ kind: 'refused', code: 'native_route_not_found',
        nativeCause: { localCause: 'native_route_not_found', route, httpStatus: 404 } });
      expect(await provider.inspect(resource)).toMatchObject({ availability: 'present', storage: 'retained' });
      expect(requests.filter(request => request.startsWith(route === 'delete' ? 'DELETE ' : `POST /lume/vms/${resource.vmName}/${route}`))).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('private');
    }, route === 'delete' ? 'DELETE /lume/vms/:name' : `POST /lume/vms/:name/${route}`);
  });

  it('retains a running VM and withholds Delete when the prerequisite Stop route is missing', async () => {
    await withLumeServer(async (native, requests) => {
      const provider = createLumeProvider({ native, observedAt: 123 });
      expect(MachineProvisionerDestroyResultV1Schema.parse(await provider.destroy(resource))).toEqual({
        kind: 'refused', code: 'native_route_not_found', nativeCause: { localCause: 'native_route_not_found', route: 'stop', httpStatus: 404 },
      });
      expect(await provider.inspect(resource)).toMatchObject({ availability: 'present', power: 'running', storage: 'retained' });
      expect(requests.filter(request => !request.startsWith('GET '))).toEqual([`POST /lume/vms/${resource.vmName}/stop`]);
    }, 'POST /lume/vms/:name/stop');
  });

  it.each(['inspect', 'pull', 'configure'] as const)('preserves the typed %s route404 without claiming native absence', async route => {
    await withLumeServer(async native => {
      const result = route === 'inspect' ? await native.inspect(resource) : route === 'configure'
        ? await native.configure(resource, { cpu: 4 })
        : await native.pull({ ...resource, image: 'linux:prepared', registry: 'registry.example', organization: 'team' });
      expect(result).toEqual({ kind: 'unknown', resource, reason: 'http', httpStatus: 404,
        nativeCause: { localCause: 'native_route_not_found', route, httpStatus: 404 } });
    }, route === 'inspect' ? 'GET /lume/vms/:name' : route === 'configure' ? 'PATCH /lume/vms/:name' : 'POST /lume/pull');
  });
});

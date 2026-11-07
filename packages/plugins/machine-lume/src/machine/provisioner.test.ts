import { describe, expect, it } from 'vitest';
import { createLumeProvider } from './provider.js';
import { createLumeNativeClient } from './nativeClient.js';
import { LumeLaunchV1Schema, LumeResourceV1Schema } from './schemas.js';
import { MachineProvisionerOptionsResultV1Schema, MachineProvisionerPowerResultV1Schema, prepareMachineProvisionerStoredSchemas, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

// Captured ManagedMachine.id from LUME1 attempt 3; Prisma produces cuid(), not UUID.
const managedId = 'cmvnxb7gn009mmcagisyszwlh';
const resource = { storage: 'home', vmName: `happier-${managedId}` };
const launch = { image: { kind: 'native-image', reference: 'ghcr.io/trycua/macos:26' },
  storage: 'home', cpu: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 150 * 1024 ** 3 };
const details = { name: resource.vmName, locationName: 'home', status: 'stopped', os: 'macos',
  cpuCount: 2, memorySize: launch.memoryBytes, diskSize: { total: launch.diskBytes, allocated: 1024 ** 3 } };

function projectOptions(raw: unknown, image?: string) {
  const options = MachineProvisionerOptionsResultV1Schema.parse(raw);
  return projectMachineProvisionerSelectionV1({ options, launchSchema: LumeLaunchV1Schema.jsonSchema,
    selection: { ...Object.fromEntries(Object.entries(options.dimensions).flatMap(([dimension, entries]) => entries[0] ? [[dimension, entries[0].id]] : [])),
      ...(image ? { image } : {}) } });
}

function setup(responses: Array<Response | Error>, imageDiskBytes = launch.diskBytes) {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async (url, init) => {
    requests.push({ url: new URL(String(url)), init });
    const requested = new URL(String(url));
    if (requested.pathname === '/lume/vms') return Response.json([details]);
    if (requested.pathname === '/lume/config' && init?.method === 'GET') return Response.json({ cachingEnabled: true });
    if (requested.origin === 'https://ghcr.io' && requested.pathname === '/token') return Response.json({ token: 'anonymous-token' });
    if (requested.origin === 'https://ghcr.io' && requested.pathname.includes('/manifests/')) {
      return Response.json({ annotations: { 'org.trycua.lume.disk-size': String(imageDiskBytes) } });
    }
    const response = responses.shift();
    if (!response) throw new Error('native response lost');
    if (response instanceof Error) throw response;
    return response;
  } });
  return { requests, provider: createLumeProvider({ native, observedAt: 123 }) };
}

describe('Lume managed provisioner', () => {
  it('refuses a changed password choice on acquisition recovery before native effects', async () => {
    const current = { ...launch, keepPasswordLogin: true };
    const { provider, requests } = setup([]);
    const mismatch = await provider.acquire(current, managedId, { ...resource, keepPasswordLogin: false });
    expect(mismatch).toEqual({ kind: 'rejected', code: 'resource_mismatch' });
    expect(requests).toHaveLength(0);
  });
  it('binds the exact existing guest even while native provisioning is incomplete', async () => {
    const { provider } = setup([Response.json({ ...details, status: 'provisioning' })]);
    expect(await provider.reconcile(resource)).toMatchObject({ kind: 'bound', resource: { value: resource } });
  });

  it('retains typed route unavailability when the native start HTTP reply is lost', async () => {
    const { provider } = setup([Response.json({ version: '0.6.1' }), Response.json([{ name: 'home' }]),
      Response.json({ name: resource.vmName, image: 'macos:26' }), Response.json(details), Response.json(details),
      new Error('private transport detail')]);
    const acquired = await provider.acquire(launch, managedId);
    expect(acquired).toMatchObject({ kind: 'pending', nativeCause: { localCause: 'native_route_unavailable' } });
    expect(JSON.stringify(acquired)).not.toContain('private transport detail');
  });
  it('admits a reviewed custom Linux Lume image only with its explicit native private carrier account', async () => {
    const selected = { ...launch, image: { kind: 'native-image', reference: 'registry.example/team/linux:prepared',
      privateCarrier: { kind: 'lume-default-password', guestOs: 'linux', user: 'linux-owner' } } };
    const { provider, requests } = setup([Response.json({ version: '0.6.1' }), Response.json([{ name: 'home' }]),
      Response.json({ name: resource.vmName, image: 'linux:prepared' }), Response.json(details),
      Response.json(details), Response.json({}, { status: 202 })]);
    expect(await provider.acquire(selected, managedId)).toMatchObject({ kind: 'bound', resource: { value: {
      ...resource, privateCarrier: selected.image.privateCarrier } } });
    expect(JSON.parse(String(requests.find(request => request.url.pathname === '/lume/pull')?.init?.body)))
      .toMatchObject({ registry: 'registry.example', organization: 'team', image: 'linux:prepared', storage: 'home', name: resource.vmName });
    expect(JSON.stringify(requests)).not.toContain('linux-owner');
  });

  it.each([['linux', 'linux'], ['macos', 'darwin']] as const)('projects explicit custom guest OS %s without classifying its image name', async (guestOs, guestPlatform) => {
    const selected = { ...launch, image: { kind: 'native-image', reference: 'registry.example/team/linux:prepared',
      privateCarrier: { kind: 'lume-default-password', guestOs, user: 'linux-owner' } } };
    const { provider, requests } = setup([Response.json([{ name: 'home' }])]);
    const options = await provider.options(selected);
    const projected = projectOptions(options);
    expect(options.dimensions.image[0]).toMatchObject({ guestPlatform });
    expect(projected).toMatchObject({ kind: 'ready', guestPlatform, launch: selected });
    expect(projected.nativeFacts).toMatchObject({ image: { id: selected.image.reference }, location: { id: 'home' },
      size: { cpuCores: launch.cpu, memoryBytes: launch.memoryBytes, diskBytes: launch.diskBytes } });
    expect(requests.map(request => request.url.pathname)).toEqual(['/lume/config/locations', '/lume/vms']);
  });

  it('does not infer a Linux login or accept malformed explicit private carrier facts before effect', async () => {
    const { provider, requests } = setup([]);
    for (const image of [
      { kind: 'native-image', reference: 'registry.example/team/linux:prepared' },
      { kind: 'native-image', reference: 'registry.example/team/linux:prepared', privateCarrier: { kind: 'lume-default-password', guestOs: 'linux', user: '' } },
      { kind: 'native-image', reference: 'registry.example/team/linux:prepared', privateCarrier: { kind: 'lume-default-password', guestOs: 'linux', user: 'owner', password: 'secret' } },
    ]) expect(await provider.acquire({ ...launch, image }, managedId)).toMatchObject({ kind: 'rejected' });
    expect(requests).toHaveLength(0);
  });

  it('refuses an account or guest OS that contradicts the qualified published macOS image before native discovery or creation', async () => {
    const { provider, requests } = setup([]);
    for (const privateCarrier of [
      { kind: 'lume-default-password', guestOs: 'macos', user: 'another-owner' },
      { kind: 'lume-default-password', guestOs: 'linux', user: 'lume' },
    ]) expect(await provider.acquire({ ...launch, image: { ...launch.image, privateCarrier } }, managedId))
      .toEqual({ kind: 'rejected', code: 'provider_unavailable', nativeCause: { localCause: 'native_route_unavailable' } });
    expect(requests).toHaveLength(0);
  });

  it('withholds every native effect for an image without qualified private SSH support', async () => {
    const { provider, requests } = setup([]);
    expect(await provider.acquire({ ...launch, image: { kind: 'native-image', reference: 'ghcr.io/custom/guest:latest' } }, managedId))
      .toEqual({ kind: 'rejected', code: 'provider_unavailable', nativeCause: { localCause: 'native_route_unavailable' } });
    expect(requests).toHaveLength(0);
  });

  it('projects qualified complete launches from reviewed native sizing and storage inputs without guessed presets', async () => {
    const { provider, requests } = setup([Response.json([{ name: 'home' }]), Response.json({ name: 'trycua/macos', tags: ['26', '15', '26-slim'] }),
      Response.json({ name: 'trycua/macos-tahoe-cua', tags: ['latest', '26.5.2'] })]);
    const options = await provider.options({ storage: launch.storage, cpu: launch.cpu,
      memoryBytes: launch.memoryBytes, diskBytes: launch.diskBytes });
    expect(options.dimensions.image).toHaveLength(3);
    expect(options.dimensions.size).toHaveLength(1);
    expect(options.dimensions.location).toHaveLength(1);
    for (const choice of options.dimensions.image) {
      const projected = projectOptions(options, choice.id);
      expect(choice).toMatchObject({ guestPlatform: 'darwin' });
      expect(projected).toMatchObject({ kind: 'ready', guestPlatform: 'darwin', launch: { ...launch, image: { kind: 'catalog', id: choice.id } } });
      expect(projected.nativeFacts).toMatchObject({ image: { id: choice.id }, location: { id: 'home' },
        size: { cpuCores: launch.cpu, memoryBytes: launch.memoryBytes, diskBytes: launch.diskBytes } });
    }
    expect(options.dimensions.location[0]).toMatchObject({ id: 'home', assignments: [{ path: 'storage', value: 'home' }] });
    expect(requests.some(({ url }) => url.pathname === '/lume/images')).toBe(false);
  });

  it('revalidates a selected catalog tag against native registry authority before creating', async () => {
    const { provider, requests } = setup([Response.json({ version: '0.6.1' }), Response.json([{ name: 'home' }]),
      Response.json({ name: 'trycua/macos', tags: ['26-slim'] })]);
    expect(await provider.acquire({ ...launch, image: { kind: 'catalog', id: 'ghcr.io/trycua/macos:26' } }, managedId))
      .toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(requests.some(({ url }) => url.pathname === '/lume/pull')).toBe(false);
  });
  it('keeps catalog facts available while incomplete sizing cannot project an executable launch', async () => {
    const { provider, requests } = setup([Response.json([{ name: 'home' }, { name: 'external' }]),
      Response.json({ name: 'trycua/macos', tags: ['26', '26-slim'] }),
      Response.json({ name: 'trycua/macos-tahoe-cua', tags: [] })]);
    const options = await provider.options({ cpu: launch.cpu });
    expect(options.dimensions.image.map(image => image.id)).toEqual(['ghcr.io/trycua/macos:26', 'ghcr.io/trycua/macos:26-slim']);
    expect(options.dimensions.location.map(location => location.id)).toEqual(['home', 'external']);
    expect(projectOptions(options)).toMatchObject({ kind: 'incomplete' });
    expect(requests.every(request => (request.init?.method ?? 'GET') === 'GET')).toBe(true);
  });
  it('requires the host row ID before creating and preserves its exact name after a dropped response', async () => {
    const { provider, requests } = setup([Response.json({ version: '0.6.1' }), Response.json([{ name: 'home' }])]);
    expect(await provider.acquire(launch, undefined)).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(requests).toHaveLength(0);
    expect(await provider.acquire(launch, managedId)).toEqual({ kind: 'pending', nativeOperationRef: {
      contributionRef: { pluginId: 'happier.machine.lume', localId: 'lume' }, schemaVersion: 1,
      value: resource } });
    expect(requests.filter(({ url }) => url.pathname === '/lume/pull')).toHaveLength(1);
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toMatchObject({ name: resource.vmName, storage: 'home' });
  });

  it('rejects missing ids and native path or colon aliases before any native IO', async () => {
    const { provider, requests } = setup([]);
    for (const id of [undefined, '', '../neighbor', 'neighbor/vm', 'neighbor\\vm', 'neighbor:latest', 'vm\0name']) {
      expect(await provider.acquire(launch, id)).toEqual({ kind: 'rejected', code: 'invalid_request' });
    }
    expect(requests).toHaveLength(0);
  });

  it('reconciles and deletes the exact CUID-derived VM and refuses retained identity drift', async () => {
    const { provider, requests } = setup([Response.json(details), Response.json(details), new Response(null, { status: 200 })]);
    expect(await provider.reconcile(resource)).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(await provider.acquire(launch, managedId, { ...resource, vmName: `${resource.vmName}-neighbor` }))
      .toEqual({ kind: 'rejected', code: 'resource_mismatch' });
    expect(await provider.destroy(resource)).toEqual({ kind: 'confirmed' });
    expect(requests.map(({ url, init }) => [url.pathname, url.searchParams.get('storage'), init?.method ?? 'GET']))
      .toEqual([[`/lume/vms/${resource.vmName}`, 'home', 'GET'],
        [`/lume/vms/${resource.vmName}`, 'home', 'GET'], [`/lume/vms/${resource.vmName}`, 'home', 'DELETE']]);
  });

  it('binds completed creation without claiming daemon online or native running from run acceptance', async () => {
    const { provider } = setup([Response.json({ version: '0.6.1' }), Response.json([{ name: 'home' }]),
      Response.json({ name: resource.vmName, image: 'macos:26' }), Response.json(details),
      Response.json(details), Response.json({}, { status: 202 })]);
    expect(await provider.acquire(launch, managedId)).toEqual({ kind: 'bound', startPending: true, resource: {
      contributionRef: { pluginId: 'happier.machine.lume', localId: 'lume' }, schemaVersion: 1, value: resource } });
  });

  it('withholds a reviewed disk smaller than the published image and refuses it before native pull', async () => {
    const selected = { ...launch, diskBytes: 64 * 1024 ** 3 };
    const { provider, requests } = setup([Response.json([{ name: 'home' }]),
      Response.json({ name: 'trycua/macos', tags: ['26'] }),
      Response.json({ name: 'trycua/macos-tahoe-cua', tags: [] }),
      Response.json({ version: '0.6.1' }), Response.json([{ name: 'home' }])]);
    const options = await provider.options({ storage: selected.storage, cpu: selected.cpu,
      memoryBytes: selected.memoryBytes, diskBytes: selected.diskBytes });
    expect(options.dimensions.image.find(choice => choice.id === 'ghcr.io/trycua/macos:26'))
      .toMatchObject({ available: false });
    expect(projectOptions(options)).toMatchObject({ kind: 'unavailable' });
    expect(await provider.acquire(selected, managedId)).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(requests.some(({ url }) => url.pathname === '/lume/pull')).toBe(false);
  });

  it.each(['disk-growth', 'unchanged'])('keeps the exact acquired resource recoverable and does not boot when readback differs after %s configuration', async mode => {
    const { provider, requests } = setup([Response.json({ version: '0.6.1' }), Response.json([{ name: 'home' }]),
      Response.json({ name: resource.vmName, image: 'macos:26' }),
      ...(mode === 'disk-growth' ? [Response.json({ ...details, diskSize: { ...details.diskSize, total: 64 * 1024 ** 3 } }), Response.json({})]
        : [Response.json(details)]),
      Response.json({ ...details, cpuCount: launch.cpu + 1 })]);
    expect(await provider.acquire(launch, managedId)).toMatchObject({ kind: 'pending', nativeOperationRef: { value: resource } });
    expect(requests.some(({ url }) => url.pathname.endsWith('/run'))).toBe(false);
  });

  it('settles Stop only after the same exact resource reports stopped', async () => {
    const { provider } = setup([Response.json({ ...details, status: 'running' }), new Response(null, { status: 200 }),
      Response.json(details)]);
    expect(await provider.power(resource, 'stop')).toEqual({ kind: 'confirmed' });
  });

  it('keeps partial native provisioning storage unknown rather than promising retained disk', async () => {
    const { provider } = setup([Response.json({ ...details, status: 'provisioning', diskSize: { total: launch.diskBytes, allocated: 0 } })]);
    expect(await provider.inspect(resource)).toMatchObject({ availability: 'present', power: 'unknown', storage: 'unknown' });
  });

  it('stops a running exact resource and confirms stopped before deleting its disk', async () => {
    const { provider, requests } = setup([Response.json({ ...details, status: 'running' }),
      new Response(null, { status: 200 }), Response.json(details), new Response(null, { status: 200 })]);
    expect(await provider.destroy(resource)).toEqual({ kind: 'confirmed' });
    expect(requests.map(({ url, init }) => [url.pathname, url.searchParams.get('storage'), init?.method]))
      .toEqual([[`/lume/vms/${resource.vmName}`, 'home', 'GET'],
        [`/lume/vms/${resource.vmName}/stop`, null, 'POST'],
        [`/lume/vms/${resource.vmName}`, 'home', 'GET'],
        [`/lume/vms/${resource.vmName}`, 'home', 'DELETE']]);
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({ storage: 'home' });
  });

  it.each(['running', 'provisioning'])('does not delete when accepted Stop readback remains %s', async status => {
    const { provider, requests } = setup([Response.json({ ...details, status: 'running' }),
      new Response(null, { status: 200 }), Response.json({ ...details, status })]);
    expect(await provider.destroy(resource)).toMatchObject({ kind: 'unknown' });
    expect(requests.filter(({ init }) => init?.method === 'DELETE')).toHaveLength(0);
    expect(requests).toHaveLength(3);
  });

  it('retains native Stop failure and withholds Delete without polling or forwarding native content', async () => {
    const { provider, requests } = setup([Response.json({ ...details, status: 'running' }),
      Response.json({ message: 'private stop failure' }, { status: 400 })]);
    expect(await provider.destroy(resource)).toEqual({ kind: 'unknown', code: 'http', nativeCause: { httpStatusClass: '4xx' } });
    expect(requests.map(({ init }) => init?.method)).toEqual(['GET', 'POST']);
  });

  it('withholds Delete for an unsettled initial VM and an unavailable Stop readback', async () => {
    const initial = setup([Response.json({ ...details, status: 'provisioning' })]);
    expect(await initial.provider.destroy(resource)).toMatchObject({ kind: 'unknown' });
    expect(initial.requests.map(({ init }) => init?.method)).toEqual(['GET']);
    const readback = setup([Response.json({ ...details, status: 'running' }), new Response(null, { status: 200 }),
      Response.json({ message: 'private failure' }, { status: 503 })]);
    expect(await readback.provider.destroy(resource)).toEqual({ kind: 'unknown', code: 'http', nativeCause: { httpStatusClass: '5xx' } });
    expect(readback.requests.map(({ init }) => init?.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('preserves typed native Delete refusal without claiming absence or forwarding the response body', async () => {
    const { provider } = setup([Response.json(details),
      Response.json({ message: 'not found or native failure' }, { status: 400 })]);
    const result = await provider.destroy(resource);
    expect(MachineProvisionerPowerResultV1Schema.parse(result)).toEqual({ kind: 'refused', code: 'native_delete_refused',
      nativeCause: { localCause: 'native_delete_refused', httpStatus: 400 } });
  });

  it('confirms successful awaited native directory deletion', async () => {
    const { provider } = setup([Response.json(details), new Response(null, { status: 200 })]);
    expect(await provider.destroy(resource)).toEqual({ kind: 'confirmed' });
  });

  it('projects exact native absence after Delete and confirms an already absent resource without another mutation', async () => {
    const absent = () => Response.json({ message: `Virtual machine not found: ${resource.vmName}` }, { status: 400 });
    const { provider, requests } = setup([Response.json(details), new Response(null, { status: 200 }), absent(), absent()]);
    expect(await provider.destroy(resource)).toEqual({ kind: 'confirmed' });
    expect(await provider.inspect(resource)).toMatchObject({ availability: 'absent', storage: 'lost' });
    expect(await provider.destroy(resource)).toEqual({ kind: 'confirmed' });
    expect(requests.filter(({ init }) => init?.method === 'DELETE')).toHaveLength(1);
  });

  it('uses real stored readers to discard nested future fields while effect ingress stays strict', async () => {
    const stored = await prepareMachineProvisionerStoredSchemas({ launch: LumeLaunchV1Schema, resource: LumeResourceV1Schema });
    const futureLaunch = { ...launch, future: true, image: { ...launch.image, future: true } };
    expect(stored.launchStored.parse(futureLaunch)).toEqual(launch);
    expect(stored.resourceStored.parse({ ...resource, future: true })).toEqual(resource);
    expect(LumeLaunchV1Schema.safeParse(futureLaunch).success).toBe(false);
    expect(LumeResourceV1Schema.safeParse({ ...resource, future: true }).success).toBe(false);
    const privateCarrier = { kind: 'lume-default-password', guestOs: 'linux', user: 'linux-owner' };
    const customLaunch = { ...launch, image: { kind: 'native-image', reference: 'registry.example/team/linux:prepared', privateCarrier } };
    const customResource = { ...resource, privateCarrier };
    expect(stored.launchStored.parse({ ...customLaunch, image: { ...customLaunch.image,
      privateCarrier: { ...privateCarrier, future: true } } })).toEqual(customLaunch);
    expect(stored.resourceStored.parse({ ...customResource, privateCarrier: { ...privateCarrier, future: true } })).toEqual(customResource);
  });
});

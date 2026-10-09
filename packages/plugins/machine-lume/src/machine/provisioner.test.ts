import { describe, expect, it } from 'vitest';
import { createLumeProvider } from './provider.js';
import { createLumeNativeClient } from './nativeClient.js';
import { LumeLaunchV1Schema, LumeResourceV1Schema } from './schemas.js';
import { prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const managedId = 'ac2c7f10-2a41-4af1-88ac-d64eeb18bdc7';
const resource = { storage: 'home', vmName: `happier-${managedId}` };
const launch = { image: { kind: 'native-image', reference: 'ghcr.io/trycua/macos:26' },
  storage: 'home', cpu: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 150 * 1024 ** 3 };
const details = { name: resource.vmName, locationName: 'home', status: 'stopped', os: 'macos',
  cpuCount: 2, memorySize: launch.memoryBytes, diskSize: { total: launch.diskBytes, allocated: 1024 ** 3 } };

function setup(responses: Response[]) {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async (url, init) => {
    requests.push({ url: new URL(String(url)), init });
    const response = responses.shift();
    if (!response) throw new Error('native response lost');
    return response;
  } });
  return { requests, provider: createLumeProvider({ native, observedAt: 123 }) };
}

describe('Lume managed provisioner', () => {
  it('admits a reviewed custom Linux Lume image only with its explicit native private carrier account', async () => {
    const selected = { ...launch, image: { kind: 'native-image', reference: 'registry.example/team/linux:prepared',
      privateCarrier: { kind: 'lume-default-password', guestOs: 'linux', user: 'linux-owner' } } };
    const { provider, requests } = setup([Response.json({ version: '0.6.1' }), Response.json([{ name: 'home' }]),
      Response.json({ name: resource.vmName, image: 'linux:prepared' }), Response.json({}), Response.json({}, { status: 202 })]);
    expect(await provider.acquire(selected, managedId)).toMatchObject({ kind: 'bound', resource: { value: {
      ...resource, privateCarrier: selected.image.privateCarrier } } });
    expect(JSON.parse(String(requests.find(request => request.url.pathname === '/lume/pull')?.init?.body)))
      .toMatchObject({ registry: 'registry.example', organization: 'team', image: 'linux:prepared', storage: 'home', name: resource.vmName });
    expect(JSON.stringify(requests)).not.toContain('linux-owner');
  });

  it('returns a complete reviewed custom Linux launch through the declared options query with no invented catalog entry', async () => {
    const selected = { ...launch, image: { kind: 'native-image', reference: 'registry.example/team/linux:prepared',
      privateCarrier: { kind: 'lume-default-password', guestOs: 'linux', user: 'linux-owner' } } };
    const { provider, requests } = setup([Response.json([{ name: 'home' }])]);
    const options = await provider.options(selected);
    const image = options.choices.find(choice => choice.launch);
    expect(LumeLaunchV1Schema.parse(image?.launch)).toEqual(selected);
    expect(image?.nativeFacts).toMatchObject({ image: { id: selected.image.reference }, location: { id: 'home' },
      size: { cpuCores: launch.cpu, memoryBytes: launch.memoryBytes, diskBytes: launch.diskBytes } });
    expect(requests.map(request => request.url.pathname)).toEqual(['/lume/config/locations']);
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
      .toEqual({ kind: 'rejected', code: 'provider_unavailable' });
    expect(requests).toHaveLength(0);
  });

  it('withholds every native effect for an image without qualified private SSH support', async () => {
    const { provider, requests } = setup([]);
    expect(await provider.acquire({ ...launch, image: { kind: 'native-image', reference: 'ghcr.io/custom/guest:latest' } }, managedId))
      .toEqual({ kind: 'rejected', code: 'provider_unavailable' });
    expect(requests).toHaveLength(0);
  });

  it('projects qualified complete launches from reviewed native sizing and storage inputs without guessed presets', async () => {
    const { provider, requests } = setup([Response.json({ token: 'anonymous-macos' }), Response.json({ token: 'anonymous-tahoe' }),
      Response.json([{ name: 'home' }]), Response.json({ name: 'trycua/macos', tags: ['26', '15', '26-slim'] }),
      Response.json({ name: 'trycua/macos-tahoe-cua', tags: ['latest', '26.5.2'] })]);
    const options = await provider.options({ storage: launch.storage, cpu: launch.cpu,
      memoryBytes: launch.memoryBytes, diskBytes: launch.diskBytes });
    const choices = options.choices.filter(choice => choice.launch);
    expect(choices).toHaveLength(3);
    for (const choice of choices) {
      const selected = LumeLaunchV1Schema.parse(choice.launch);
      expect(selected).toEqual({ ...launch, image: { kind: 'catalog', id: choice.id } });
      expect(choice.nativeFacts).toMatchObject({ image: { id: choice.id }, location: { id: 'home' },
        size: { cpuCores: launch.cpu, memoryBytes: launch.memoryBytes, diskBytes: launch.diskBytes } });
    }
    expect(options.choices.find(choice => choice.id === 'storage:home')).not.toHaveProperty('launch');
    expect(requests.some(({ url }) => url.pathname === '/lume/images')).toBe(false);
  });

  it('revalidates a selected catalog tag against native registry authority before creating', async () => {
    const { provider, requests } = setup([Response.json({ version: '0.6.1' }), Response.json([{ name: 'home' }]),
      Response.json({ token: 'anonymous-macos' }), Response.json({ name: 'trycua/macos', tags: ['26-slim'] })]);
    expect(await provider.acquire({ ...launch, image: { kind: 'catalog', id: 'ghcr.io/trycua/macos:26' } }, managedId))
      .toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(requests.some(({ url }) => url.pathname === '/lume/pull')).toBe(false);
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

  it('binds completed creation without claiming daemon online or native running from run acceptance', async () => {
    const { provider } = setup([Response.json({ version: '0.6.1' }), Response.json([{ name: 'home' }]),
      Response.json({ name: resource.vmName, image: 'macos:26' }), Response.json({}),
      Response.json({}, { status: 202 })]);
    expect(await provider.acquire(launch, managedId)).toEqual({ kind: 'bound', resource: {
      contributionRef: { pluginId: 'happier.machine.lume', localId: 'lume' }, schemaVersion: 1, value: resource } });
  });

  it('settles Stop only after the same exact resource reports stopped', async () => {
    const { provider } = setup([Response.json({ ...details, status: 'running' }), new Response(null, { status: 200 }),
      Response.json(details)]);
    expect(await provider.power(resource, 'stop')).toEqual({ kind: 'confirmed' });
  });

  it('keeps partial native provisioning storage unknown rather than promising retained disk', async () => {
    const { provider } = setup([Response.json({ ...details, status: 'provisioning', diskSize: { total: launch.diskBytes, allocated: 0 } })]);
    expect(await provider.inspect(resource)).toMatchObject({ availability: 'present', power: 'unknown', storage: 'unknown', daemon: 'unknown' });
  });

  it('does not infer delete completion from ambiguous native HTTP 400', async () => {
    const { provider } = setup([Response.json(details),
      Response.json({ message: 'not found or native failure' }, { status: 400 })]);
    expect(await provider.destroy(resource)).toEqual({ kind: 'unknown', code: 'http' });
  });

  it('confirms successful awaited native directory deletion', async () => {
    const { provider } = setup([Response.json(details), new Response(null, { status: 200 })]);
    expect(await provider.destroy(resource)).toEqual({ kind: 'confirmed' });
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

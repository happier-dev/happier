import { MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import * as exports from './index.js';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';

const resource = { serverId: 41, owned: { volumeIds: [], primaryIpIds: [] } };
const launch = { serverTypeId: 'cx23', imageId: 'ubuntu-24.04', locationId: 'fsn1', publicNetworking: { ipv4: true, ipv6: false } };
// Partial fixtures replace only host registration, credential materialization
// and HTTP boundaries; public authoring/schema/native decoding remain real.
async function activated(response: unknown, status = 200) {
  const publicExports = exports as unknown as Record<string, unknown>;
  expect(typeof publicExports.activate).toBe('function');
  const handlers = new Map<string, ActionHandler>();
  const activate = publicExports.activate as (api: PluginApi) => Promise<unknown>;
  await activate({ actions: { register(id: string, handler: ActionHandler) {
    handlers.set(id, handler); return { dispose() {} };
  } }, connectedAccounts: { register() {} } } as unknown as PluginApi);
  const requests: Array<{ url: string; method?: string; headers?: Readonly<Record<string, string>> }> = [];
  const materializations: Array<{ kind: string; origin: string }> = [];
  const context = { invokedAtMs: 1234, signal: new AbortController().signal, services: {
    connectedAccounts: { materialize: async (_purpose: string, request: { kind: string; origin: string }) => {
      materializations.push(request);
      return { kind: 'httpHeaders', headers: { Authorization: 'Bearer captured-private' } };
    } },
    http: { request: async (request: { url: string; headers?: Readonly<Record<string, string>> }) => {
      requests.push(request);
      return { status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(response)) };
    } },
  } } as unknown as PluginInvocationContext;
  return { handlers, context, requests, materializations };
}
describe('public hetzner machine provisioner', () => {
  it('projects complete native dimensions and selected networking charges for reviewed variants', async () => {
    const pair = (gross: string) => ({ net: gross, gross });
    const runtime = await activated({
      server_types: [
        { id: 1, name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86',
          locations: [{ id: 1, name: 'fsn1', available: true, deprecation: null }, { id: 2, name: 'hel1', available: true, deprecation: null }], prices: [
          { location: 'fsn1', price_hourly: pair('0.01'), price_monthly: pair('6') },
          { location: 'hel1', price_hourly: pair('0.02'), price_monthly: pair('12') },
        ] },
        { id: 2, name: 'cax11', cores: 2, memory: 4, disk: 40, architecture: 'arm',
          locations: [{ id: 1, name: 'fsn1', available: true, deprecation: null }],
          prices: [{ location: 'fsn1', price_hourly: pair('0.03'), price_monthly: pair('18') }] },
      ],
      images: [
        { id: 10, name: 'ubuntu-24.04', description: 'Ubuntu 24.04 LTS', architecture: 'x86', type: 'system', status: 'available', deprecated: null },
        { id: 11, name: 'ubuntu-arm', architecture: 'arm', type: 'system', status: 'available', deprecated: null },
      ],
      locations: [{ id: 1, name: 'fsn1', description: 'Falkenstein', country: 'DE' }, { id: 2, name: 'hel1', description: 'Helsinki', country: 'FI' }],
      pricing: { currency: 'EUR', primary_ips: [{ type: 'ipv4', prices: [
        { location: 'fsn1', price_hourly: pair('0.001'), price_monthly: pair('0.60') },
      ] }] }, meta: { pagination: { next_page: null } },
    });
    const result = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    const selected = result.dimensions.network.map(network => projectMachineProvisionerSelectionV1({ options: result,
      selection: { size: '1', image: '10', location: 'fsn1', network: network.id }, launchSchema: exports.MACHINE_PROVISIONER.launchSchema }));
    expect(selected).toMatchObject([
      { kind: 'ready', launch: { publicNetworking: { ipv4: true, ipv6: false } },
        nativeFacts: { size: { id: '1', cpuCores: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 40 * 1000 ** 3 },
          image: { id: '10', title: 'ubuntu-24.04', description: 'Ubuntu 24.04 LTS' }, location: { id: 'fsn1', title: 'Falkenstein', countryCode: 'DE' } },
        prices: [{ amount: '0.01', label: { key: 'machineHetzner.prices.compute' } }, { amount: '6', label: { key: 'machineHetzner.prices.compute' } },
          { amount: '0.001', label: { key: 'machineHetzner.prices.primaryIpv4' }, source: 'https://api.hetzner.cloud/v1/pricing#primary_ips' },
          { amount: '0.60', label: { key: 'machineHetzner.prices.primaryIpv4' } }] },
      { launch: { publicNetworking: { ipv4: false, ipv6: true } }, prices: [{ amount: '0.01' }, { amount: '6' }] },
      { launch: { publicNetworking: { ipv4: true, ipv6: true } }, prices: [{ amount: '0.01' }, { amount: '6' }, { amount: '0.001' }, { amount: '0.60' }] },
    ]);
    // Each public-networking variant is a labelled native choice, so the person can pick the cheaper one.
    expect(result.dimensions.network.map(choice => choice.nativeFacts?.network)).toEqual([
      { id: '10', title: { key: 'machineHetzner.network.ipv4', fallback: 'IPv4 only' } },
      { id: '01', title: { key: 'machineHetzner.network.ipv6', fallback: 'IPv6 only' } },
      { id: '11', title: { key: 'machineHetzner.network.dual', fallback: 'IPv4 and IPv6' } },
    ]);
    const project = (size: string, image: string, location: string) => projectMachineProvisionerSelectionV1({ options: result,
      selection: { size, image, location, network: '01' }, launchSchema: exports.MACHINE_PROVISIONER.launchSchema });
    expect(project('1', '11', 'fsn1').kind).toBe('unavailable');
    expect(project('2', '11', 'hel1').kind).toBe('unavailable');
    expect(project('2', '11', 'fsn1')).toMatchObject({ kind: 'ready', prices: [{ amount: '0.03' }, { amount: '18' }] });
    expect(project('1', '10', 'hel1')).toMatchObject({ kind: 'ready', prices: [{ amount: '0.02' }, { amount: '12' }] });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('preview');
  });
  it('admits the full cold manifest with host confirmation for native effects', () => {
    const result = parsePluginManifest(exports.PLUGIN_MANIFEST);
    expect(result, result.ok ? undefined : JSON.stringify(result.diagnostics)).toMatchObject({ ok: true });
  });
  it.each([
    { nativeOperation: { correlation: 'pending-1' } },
    { correlation: { managedId: 'pending-1', requestId: 'original-request', launch } },
  ])('reconciles a retained pending native correlation without purchasing again: %j', async input => {
    const runtime = await activated({ servers: [{ id: 41, status: 'off', labels: { 'happier-managed': 'pending-1' }, public_net: { ipv4: null, ipv6: null }, volumes: [] }], meta: { pagination: { next_page: null } } });
    const reconcile = runtime.handlers.get('reconcile');
    expect(typeof reconcile).toBe('function');
    expect(await reconcile!(input, runtime.context)).toMatchObject({
      kind: 'bound', resource: { contributionRef: { pluginId: 'happier.machine.hetzner', localId: 'hetzner' },
        value: { serverId: 41, owned: { volumeIds: [], primaryIpIds: [] } } },
    });
    expect(runtime.requests.every(request => !('method' in request) || request.method === 'GET')).toBe(true);
    const readers = await exports.prepareStoredSchemas();
    expect('nativeOperationStored' in readers && readers.nativeOperationStored.parse({ correlation: 'pending-1', future: true })).toEqual({ correlation: 'pending-1' });
  });
  it.each([
    { servers: [{ id: 41, labels: { 'happier-managed': 'pending-1' } }, { id: 42, labels: { 'happier-managed': 'pending-1' } }] },
    { servers: [{ id: 41, labels: { 'happier-managed': 'another-row' } }] },
  ])('retains row-only uncertainty for ambiguous or mismatched native labels: %j', async ({ servers }) => {
    const runtime = await activated({ servers: servers.map(server => ({ status: 'off', public_net: { ipv4: null, ipv6: null }, volumes: [], ...server })),
      meta: { pagination: { next_page: null } } });
    expect(await runtime.handlers.get('reconcile')!({ correlation: { managedId: 'pending-1', requestId: 'original-request', launch } }, runtime.context))
      .toMatchObject({ kind: 'pending', nativeOperationRef: { value: { correlation: 'pending-1' } } });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('keeps the exact pending handle on unavailable recovery reads', async () => {
    const runtime = await activated({}, 403);
    const reconcile = runtime.handlers.get('reconcile');
    expect(typeof reconcile).toBe('function');
    expect(await reconcile!({ nativeOperation: { correlation: 'pending-1' } }, runtime.context)).toMatchObject({
      kind: 'pending', nativeOperationRef: { value: { correlation: 'pending-1' } },
    });
  });
  it('activates real roles and projects off-resource billing through the canonical result', async () => {
    const runtime = await activated({ server: { id: 41, status: 'off', labels: {}, public_net: { ipv4: null, ipv6: null }, volumes: [] } });
    const result = await runtime.handlers.get('inspect')!({ resource }, runtime.context);
    expect(result).toMatchObject({ availability: 'present', power: 'stopped',
      billing: { location: 'cloud', stoppedBilling: 'billed' } });
    expect(new Headers(runtime.requests[0]?.headers).get('authorization')).toBe('Bearer captured-private');
    expect(runtime.materializations[0]?.kind).toBe('httpHeaders');
    expect(JSON.stringify(result)).not.toContain('captured-private');
  });
  it('does not translate native authorization failure into confirmed absence', async () => {
    const runtime = await activated({}, 403);
    expect(await runtime.handlers.get('inspect')!({ resource }, runtime.context)).toMatchObject({ availability: 'unavailable' });
  });
  it('reads nested future stored fields while strict role admission rejects them', async () => {
    const publicExports = exports as unknown as Record<string, unknown>;
    expect(typeof publicExports.prepareStoredSchemas).toBe('function');
    const prepare = publicExports.prepareStoredSchemas as () => Promise<{
      launchStored: { parse(value: unknown): unknown }; resourceStored: { parse(value: unknown): unknown };
    }>;
    const readers = await prepare();
    expect(readers.launchStored.parse({ ...launch, publicNetworking: { ...launch.publicNetworking, future: true }, future: true })).toEqual(launch);
    expect(readers.resourceStored.parse({ ...resource, owned: { ...resource.owned, future: true }, future: true })).toEqual(resource);
    const runtime = await activated({ server: { id: 41, status: 'off', labels: {}, public_net: { ipv4: null, ipv6: null }, volumes: [] } });
    expect(() => exports.ROLE_SCHEMAS.resourceInput.parse({ resource: { ...resource, future: true } })).toThrow();
  });
});

describe('brand mark', () => {
  it('declares its packaged brand mark through the generic brand Resource', () => {
    expect(exports.PLUGIN_MANIFEST.brand).toEqual({ iconResourceId: 'brand-icon' });
    expect(exports.PLUGIN_MANIFEST.contributes.resources).toEqual([{ id: 'brand-icon', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }]);
    const asset = readFileSync(new URL('../assets/brand.png', import.meta.url));
    expect([...asset.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(asset.readUInt32BE(16)).toBe(asset.readUInt32BE(20));
  });
  it('emits each native size fact once at the observed catalog scale', async () => {
    // Synthetic REST-v1 catalogs reproduce CLOUD2's 8,496-combination scale;
    // no private catalog or live provider request is used.
    const pair = (gross: string) => ({ net: gross, gross });
    const locations = Array.from({ length: 3 }, (_, index) => ({ id: index + 1, name: `location-${index}`, description: `Location ${index}` }));
    const serverTypes = Array.from({ length: 59 }, (_, index) => ({ id: index + 1, name: `type-${index}`, cores: 2, memory: 4, disk: 40,
      architecture: 'x86', locations: locations.map(location => ({ id: location.id, name: location.name, available: true, deprecation: null })),
      prices: locations.map(location => ({ location: location.name, price_hourly: pair('0.01'), price_monthly: pair('6') })) }));
    const images = Array.from({ length: 16 }, (_, index) => ({ id: index + 1, name: `ubuntu-${index}`, architecture: 'x86',
      type: 'system', status: 'available', deprecated: null }));
    const runtime = await activated({ server_types: serverTypes, images, locations, pricing: { currency: 'EUR' },
      meta: { pagination: { next_page: null } } });
    const startedAt = performance.now();
    const result = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    const wire = JSON.stringify(result);
    const elapsedMs = performance.now() - startedAt;
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
    const dimensionCount = Object.values(result.dimensions).reduce((total, entries) => total + entries.length, 0);
    console.info(`Hetzner native sizes=${serverTypes.length}; dimensions=${dimensionCount}; bytes=${new TextEncoder().encode(wire).byteLength}; elapsedMs=${elapsedMs.toFixed(1)}`);
    expect(dimensionCount).toBe(81);
    expect(wire.match(/"cpuCores":/g)?.length ?? 0)
      .toBe(serverTypes.length);
  });

});

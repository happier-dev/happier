import { MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import * as exports from './index.js';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';

const resource = { dropletId: 42, ownedVolumeIds: [] };
const launch = { regionSlug: 'nyc3', sizeSlug: 's-1vcpu-1gb', imageId: 1, publicNetworking: { ipv6: false } };
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
describe('public digitalocean machine provisioner', () => {
  it('admits the full cold manifest with host confirmation for native effects', () => {
    const result = parsePluginManifest(exports.PLUGIN_MANIFEST);
    expect(result, result.ok ? undefined : JSON.stringify(result.diagnostics)).toMatchObject({ ok: true });
    expect(exports.PLUGIN_MANIFEST.contributes.connectedAccountDescriptors).toMatchObject([
      { id: 'digitalocean-account', ui: { category: 'cloud-machines' } },
    ]);
  });
  it('publishes labelled native choices without treating a monthly rate as a cap', async () => {
    const sizes = ['s5-1vcpu-1gb', 's-1vcpu-1gb'].map(slug => ({
      slug, memory: 1024, vcpus: 1, disk: 25, transfer: 1,
      price_hourly: 0.02, price_monthly: 12, regions: ['nyc3'], available: true,
    }));
    const runtime = await activated({ sizes,
      regions: [{ slug: 'nyc3', name: 'New York 3', available: true, sizes: sizes.map(size => size.slug) }],
      images: [{ id: 1, name: 'Ubuntu 24.04', description: 'Ubuntu base image', distribution: 'Ubuntu', regions: ['nyc3'], status: 'available', type: 'base' }], links: {},
    });
    const result = await runtime.handlers.get('options')!({}, runtime.context);
    expect(result).toMatchObject({ dimensions: {
      size: [
        { nativeFacts: { size: { id: sizes[0]!.slug, title: sizes[0]!.slug, cpuCores: 1,
          memoryBytes: 1024 * 1024 ** 2, diskBytes: 25 * 1000 ** 3 }, monthlyCapStatus: 'none' },
          prices: [{ unit: 'hour', amount: '0.02' }, { unit: 'month', amount: '12' }] },
        { nativeFacts: { monthlyCapStatus: 'unknown' } },
      ],
      image: [{ nativeFacts: { image: { id: '1', title: 'Ubuntu 24.04', description: 'Ubuntu base image' } } }],
      location: [{ nativeFacts: { location: { id: 'nyc3', title: 'New York 3' } } }],
      network: [
        { nativeFacts: { network: { id: '0', title: { key: 'machineDigitalOcean.network.ipv4', fallback: 'IPv4 only' } } } },
        { nativeFacts: { network: { id: '1', title: { key: 'machineDigitalOcean.network.dual', fallback: 'IPv4 and IPv6' } } } },
      ],
    } });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('captured-private');
    expect(JSON.stringify(result)).not.toContain('countryCode');
    expect(JSON.stringify(result)).not.toContain('preview');
  });
  it.each([
    { nativeOperation: { recoveryTag: 'happier-pending-1' } },
    { correlation: { managedId: 'pending-1', requestId: 'original-request', launch } },
  ])('reconciles a retained pending native correlation without purchasing again: %j', async input => {
    const runtime = await activated({ droplets: [{ id: 42, name: 'managed', status: 'off', tags: ['happier-pending-1'], volume_ids: [] }], links: {} });
    const reconcile = runtime.handlers.get('reconcile');
    expect(typeof reconcile).toBe('function');
    expect(await reconcile!(input, runtime.context)).toMatchObject({
      kind: 'bound', resource: { contributionRef: { pluginId: 'happier.machine.digitalocean', localId: 'digitalocean' },
        value: { dropletId: 42, ownedVolumeIds: [] } },
    });
    expect(runtime.requests.every(request => !('method' in request) || request.method === 'GET')).toBe(true);
    const readers = await exports.prepareStoredSchemas();
    expect('nativeOperationStored' in readers && readers.nativeOperationStored.parse({ recoveryTag: 'happier-pending-1', future: true })).toEqual({ recoveryTag: 'happier-pending-1' });
  });
  it.each([
    { droplets: [{ id: 42, tags: ['happier-pending-1'] }, { id: 43, tags: ['happier-pending-1'] }] },
    { droplets: [{ id: 42, tags: ['happier-another-row'] }] },
  ])('retains row-only uncertainty for ambiguous or mismatched native tags: %j', async ({ droplets }) => {
    const runtime = await activated({ droplets: droplets.map(droplet => ({ name: 'managed', status: 'off', volume_ids: [], ...droplet })), links: {} });
    expect(await runtime.handlers.get('reconcile')!({ correlation: { managedId: 'pending-1', requestId: 'original-request', launch } }, runtime.context))
      .toMatchObject({ kind: 'pending', nativeOperationRef: { value: { recoveryTag: 'happier-pending-1' } } });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('keeps the exact pending handle on unavailable recovery reads', async () => {
    const runtime = await activated({}, 403);
    const reconcile = runtime.handlers.get('reconcile');
    expect(typeof reconcile).toBe('function');
    expect(await reconcile!({ nativeOperation: { recoveryTag: 'happier-pending-1' } }, runtime.context)).toMatchObject({
      kind: 'pending', nativeOperationRef: { value: { recoveryTag: 'happier-pending-1' } },
    });
  });
  it('activates real roles and projects off-resource billing through the canonical result', async () => {
    const runtime = await activated({ droplet: { id: 42, name: 'managed', status: 'off', tags: [], volume_ids: [] } });
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
    expect(readers.resourceStored.parse({ ...resource, future: true })).toEqual(resource);
    const runtime = await activated({ droplet: { id: 42, name: 'managed', status: 'off', tags: [], volume_ids: [] } });
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
  it('keeps native size and image region restrictions independent during selection', async () => {
    const runtime = await activated({
      sizes: [
        { slug: 'nyc-only', memory: 1024, vcpus: 1, disk: 25, transfer: 1, price_hourly: 0.02, regions: ['nyc3'], available: true },
        { slug: 'both', memory: 1024, vcpus: 1, disk: 25, transfer: 1, price_hourly: 0.02, regions: ['nyc3', 'sfo3'], available: true },
      ], regions: [
        { slug: 'nyc3', name: 'New York', available: true, sizes: ['nyc-only', 'both'] },
        { slug: 'sfo3', name: 'San Francisco', available: true, sizes: ['both'] },
      ], images: [
        { id: 1, name: 'Ubuntu NYC', distribution: 'Ubuntu', regions: ['nyc3', 'retired-region'], status: 'available', type: 'base' },
        { id: 2, name: 'Ubuntu SFO', distribution: 'Ubuntu', regions: ['sfo3'], status: 'available', type: 'base' },
      ], links: {},
    });
    const options = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    const project = (size: string, image: string) => projectMachineProvisionerSelectionV1({ options,
      selection: { size, image, location: 'sfo3', network: '0' }, launchSchema: exports.MACHINE_PROVISIONER.launchSchema });
    expect(project('nyc-only', '2').kind).toBe('unavailable');
    expect(project('both', '1').kind).toBe('unavailable');
    expect(project('both', '2')).toMatchObject({ kind: 'ready', launch: {
      regionSlug: 'sfo3', sizeSlug: 'both', imageId: 2, publicNetworking: { ipv6: false },
    } });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('emits each native fact once at the CLOUD4 catalog scale', async () => {
    // Synthetic REST-v2 catalogs reproduce CLOUD4's dimension counts, not
    // that account's private catalog. REST v2 defaults to 20 rows, maximum 200.
    const regions = Array.from({ length: 18 }, (_, index) => ({ slug: `region-${index}`, name: `Region ${index}`, available: true }));
    const sizes = Array.from({ length: 311 }, (_, index) => ({ slug: `size-${index}`, memory: 1024, vcpus: 1, disk: 25,
      transfer: 1, price_hourly: 0.02, price_monthly: 12, regions: regions.map(region => region.slug), available: true }));
    const images = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, name: `Ubuntu ${index}`, distribution: 'Ubuntu',
      regions: regions.map(region => region.slug), status: 'available', type: 'base' }));
    const runtime = await activated({ sizes, images, regions: regions.map(region => ({ ...region, sizes: sizes.map(size => size.slug) })), links: {} });
    const startedAt = performance.now();
    const output = await runtime.handlers.get('options')!({}, runtime.context);
    const producedAt = performance.now();
    const result = MachineProvisionerOptionsResultV1Schema.parse(output);
    const parsedAt = performance.now();
    const wire = JSON.stringify(result);
    const serializedAt = performance.now();
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
    // Count the actual emitted fact, independent of container naming. A linear
    // dimension projection must not copy CPU/memory/disk facts into every launch.
    const dimensionCount = Object.values(result.dimensions).reduce((total, entries) => total + entries.length, 0);
    console.info(`DigitalOcean native sizes=${sizes.length}; dimensions=${dimensionCount}; bytes=${new TextEncoder().encode(wire).byteLength}; producerMs=${(producedAt - startedAt).toFixed(1)}; strictParseMs=${(parsedAt - producedAt).toFixed(1)}; stringifyMs=${(serializedAt - parsedAt).toFixed(1)}`);
    expect(dimensionCount).toBe(339);
    expect(wire.match(/"cpuCores":/g)?.length ?? 0)
      .toBe(sizes.length);
    expect(result.dimensions.size.map(size => size.id)).toEqual(sizes.map(size => size.slug));
    expect(result.dimensions.image.map(image => image.id)).toEqual(images.map(image => String(image.id)));
    expect(result.dimensions.location.map(region => region.id)).toEqual(regions.map(region => region.slug));
  });

});

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
    expect(result).toMatchObject({ choices: [
      { nativeFacts: { size: { id: sizes[0]!.slug, title: 's5-1vcpu-1gb · 1 CPU · 1024 MB · 25 GB', cpuCores: 1,
        memoryBytes: 1024 * 1024 ** 2, diskBytes: 25 * 1000 ** 3 },
        image: { id: '1', title: 'Ubuntu 24.04', description: 'Ubuntu base image' }, location: { id: 'nyc3', title: 'New York 3' }, monthlyCapStatus: 'none' },
        prices: [{ unit: 'hour', amount: '0.02' }, { unit: 'month', amount: '12' }] },
      { nativeFacts: { monthlyCapStatus: 'none' } },
      { nativeFacts: { monthlyCapStatus: 'unknown' } },
      { nativeFacts: { monthlyCapStatus: 'unknown' } },
    ] });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('captured-private');
    expect(JSON.stringify(result)).not.toContain('countryCode');
    expect(JSON.stringify(result)).not.toContain('preview');
  });
  it('reconciles a retained pending native correlation without purchasing again', async () => {
    const runtime = await activated({ droplets: [{ id: 42, name: 'managed', status: 'off', tags: ['happier-pending-1'], volume_ids: [] }], links: {} });
    const reconcile = runtime.handlers.get('reconcile');
    expect(typeof reconcile).toBe('function');
    expect(await reconcile!({ nativeOperation: { recoveryTag: 'happier-pending-1' } }, runtime.context)).toMatchObject({
      kind: 'bound', resource: { contributionRef: { pluginId: 'happier.machine.digitalocean', localId: 'digitalocean' },
        value: { dropletId: 42, ownedVolumeIds: [] } },
    });
    expect(runtime.requests.every(request => !('method' in request) || request.method === 'GET')).toBe(true);
    const readers = await exports.prepareStoredSchemas();
    expect('nativeOperationStored' in readers && readers.nativeOperationStored.parse({ recoveryTag: 'happier-pending-1', future: true })).toEqual({ recoveryTag: 'happier-pending-1' });
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

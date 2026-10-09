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
      server_types: [{ id: 1, name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86',
        prices: [{ location: 'fsn1', price_hourly: pair('0.01'), price_monthly: pair('6') }] }],
      images: [{ id: 10, name: 'ubuntu-24.04', description: 'Ubuntu 24.04 LTS', architecture: 'x86', type: 'system', status: 'available', deprecated: null }],
      locations: [{ id: 1, name: 'fsn1', description: 'Falkenstein', country: 'DE' }],
      pricing: { currency: 'EUR', primary_ips: [{ type: 'ipv4', prices: [
        { location: 'fsn1', price_hourly: pair('0.001'), price_monthly: pair('0.60') },
      ] }] }, meta: { pagination: { next_page: null } },
    });
    const result = await runtime.handlers.get('options')!({}, runtime.context);
    expect(result).toMatchObject({ choices: [
      { launch: { publicNetworking: { ipv4: true, ipv6: false } },
        nativeFacts: { size: { id: '1', cpuCores: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 40 * 1000 ** 3 },
          image: { id: '10', title: 'ubuntu-24.04', description: 'Ubuntu 24.04 LTS' }, location: { id: 'fsn1', title: 'Falkenstein', countryCode: 'DE' } },
        prices: [{ amount: '0.01', label: { key: 'machineHetzner.prices.compute' } }, { amount: '6', label: { key: 'machineHetzner.prices.compute' } },
          { amount: '0.001', label: { key: 'machineHetzner.prices.primaryIpv4' }, source: 'https://api.hetzner.cloud/v1/pricing#primary_ips' },
          { amount: '0.60', label: { key: 'machineHetzner.prices.primaryIpv4' } }] },
      { launch: { publicNetworking: { ipv4: false, ipv6: true } }, prices: [{ amount: '0.01' }, { amount: '6' }] },
      { launch: { publicNetworking: { ipv4: true, ipv6: true } }, prices: [{ amount: '0.01' }, { amount: '6' }, { amount: '0.001' }, { amount: '0.60' }] },
    ] });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('preview');
  });
  it('admits the full cold manifest with host confirmation for native effects', () => {
    const result = parsePluginManifest(exports.PLUGIN_MANIFEST);
    expect(result, result.ok ? undefined : JSON.stringify(result.diagnostics)).toMatchObject({ ok: true });
  });
  it('reconciles a retained pending native correlation without purchasing again', async () => {
    const runtime = await activated({ servers: [{ id: 41, status: 'off', labels: { 'happier-managed': 'pending-1' }, public_net: { ipv4: null, ipv6: null }, volumes: [] }], meta: { pagination: { next_page: null } } });
    const reconcile = runtime.handlers.get('reconcile');
    expect(typeof reconcile).toBe('function');
    expect(await reconcile!({ nativeOperation: { correlation: 'pending-1' } }, runtime.context)).toMatchObject({
      kind: 'bound', resource: { contributionRef: { pluginId: 'happier.machine.hetzner', localId: 'hetzner' },
        value: { serverId: 41, owned: { volumeIds: [], primaryIpIds: [] } } },
    });
    expect(runtime.requests.every(request => !('method' in request) || request.method === 'GET')).toBe(true);
    const readers = await exports.prepareStoredSchemas();
    expect('nativeOperationStored' in readers && readers.nativeOperationStored.parse({ correlation: 'pending-1', future: true })).toEqual({ correlation: 'pending-1' });
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

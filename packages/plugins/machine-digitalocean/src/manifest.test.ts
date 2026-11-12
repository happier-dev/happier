import { PluginError } from '@happier-dev/plugin-sdk';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler, PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { PluginAccountActionContext, PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountReadContext, ConnectedAccountMaterializationRequest } from '@happier-dev/plugin-sdk/connected-accounts';
import { connectedAccountRuntime } from './account.js';
import * as exports from './index.js';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema, MachineProvisionerDestroyResultV1Schema, projectMachineProvisionerSelectionV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';

const resource = { dropletId: 42, ownedVolumeIds: [] };
const launch = { regionSlug: 'nyc3', sizeSlug: 's-1vcpu-1gb', imageId: 1, publicNetworking: { ipv6: false } };
// Partial fixtures replace only host registration and HTTP boundaries;
// public authoring/schema/native decoding remain real.
async function activated(response: unknown, status = 200, replyForUrl?: (url: string, method?: string) => Readonly<{ body: unknown; status: number }>) {
  const publicExports = exports as unknown as Record<string, unknown>;
  expect(typeof publicExports.activate).toBe('function');
  const handlers = new Map<string, ActionHandler>();
  const activate = publicExports.activate as (api: PluginApi) => Promise<unknown>;
  await activate({ actions: { register(id: string, handler: ActionHandler) {
    handlers.set(id, handler); return { dispose() {} };
  } }, connectedAccounts: { register() {} } } as unknown as PluginApi);
  // Provider roles run on the Account host through the same native HTTP implementation.
  await exports.activateAccount({ actions: { register(id: string, handler: PluginAccountActionHandler) {
    handlers.set(id, handler as ActionHandler); return { dispose() {} };
  } } } as unknown as PluginAccountApi);
  const requests: HttpRequest[] = [];
  const credentialContext = { signal: new AbortController().signal, credentials: { get: async () => 'selected-private' } } as unknown as ConnectedAccountReadContext;
  const context = { invokedAtMs: 1234, signal: new AbortController().signal, services: {
    machineProvisioners: { waitForNativeObservation: async () => {} },
    connectedAccounts: { materialize: async (_purpose: string, request: ConnectedAccountMaterializationRequest) =>
      connectedAccountRuntime.materialize(request, credentialContext) },
    http: { request: async (request: HttpRequest) => {
      requests.push(request);
      const url = new URL(request.url);
      // Mirror the native REST v2 prohibition rather than admitting an impossible success.
      const reply = url.pathname === '/v2/droplets' && url.searchParams.has('tag_name') && url.searchParams.has('type')
        ? { body: { id: 'bad_request' }, status: 400 }
        : replyForUrl?.(request.url, request.method) ?? { body: response, status };
      return { status: reply.status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(reply.body)) };
    } },
  } } as unknown as PluginInvocationContext;
  return { handlers, context, requests };
}
describe('public digitalocean machine provisioner', () => {
  it('preserves a typed HTTP refusal through activated options', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const runtime = await activated(undefined, 200, () => { throw refusal; });
    await expect(runtime.handlers.get('options')!({}, runtime.context)).rejects.toBe(refusal);
    expect(runtime.requests.map(request => request.method)).toEqual(['GET']);
  });
  it.each(['completed', 'errored', 'unavailable', 'ambiguous'] as const)('settles one exact native snapshot Action with truthful coverage after %s', async outcome => {
    let submitted = false;
    let observations = 0;
    const host = await activated(undefined, 200, (url, method) => {
      const path = new URL(url).pathname;
      if (method === 'POST') { submitted = true; return { status: 201, body: { action: {
        id: 91, status: 'in-progress', type: 'snapshot', resource_id: 42, resource_type: 'droplet' } } }; }
      if (path.endsWith('/actions/91')) {
        observations++;
        return outcome === 'unavailable' ? { status: 503, body: { id: 'service_unavailable' } }
          : { status: 200, body: { action: { id: 91, status: observations === 1 ? 'in-progress' : outcome === 'ambiguous' ? 'completed' : outcome,
            type: 'snapshot', resource_id: 42, resource_type: 'droplet' } } };
      }
      return { status: 200, body: { droplet: { id: 42, name: 'managed', status: 'off', tags: [], volume_ids: ['attached'],
        snapshot_ids: submitted ? outcome === 'ambiguous' ? [70, 71, 72] : [70, 71] : [70] } } };
    });
    const snapshot = host.handlers.get('snapshot');
    expect(snapshot).toBeTypeOf('function');
    const result = await snapshot!({ resource, expectedMachineRevision: 3, label: 'Before restore', reason: 'Replace database' }, host.context);
    expect(result).toMatchObject(outcome === 'completed'
      ? { kind: 'confirmed', snapshotId: '71', coverage: { rootDisk: true, attachedVolumes: false }, consistency: 'stopped', cost: { kind: 'billed' } }
      : { kind: outcome === 'errored' ? 'failed' : 'unknown', code: expect.any(String) });
    const writes = host.requests.filter(request => request.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(new URL(writes[0]!.url).pathname).toBe('/v2/droplets/42/actions');
    expect(JSON.parse(new TextDecoder().decode(writes[0]!.body))).toEqual({ type: 'snapshot', name: 'Before restore' });
    expect(exports.PLUGIN_MANIFEST.contributes.actions.find(action => action.id === 'snapshot')?.execution.target).toBe('daemon');
  });
  it('executes portable Account cleanup with one selected credential capture for all native fragments', async () => {
    const accountExports = exports as unknown as { activateAccount?: (api: PluginAccountApi) => unknown };
    expect(accountExports.activateAccount).toBeTypeOf('function');
    const handlers = new Map<string, PluginAccountActionHandler>();
    await accountExports.activateAccount!({ actions: { register(id: string, handler: PluginAccountActionHandler) {
      handlers.set(id, handler); return { dispose() {} };
    } } } as unknown as PluginAccountApi);
    let credentialReads = 0;
    const credentialContext = { signal: new AbortController().signal, credentials: {
      get: async () => { credentialReads++; return 'selected-private'; },
    } } as unknown as ConnectedAccountReadContext;
    const requests: HttpRequest[] = [];
    const context = { invokedAtMs: 1234, signal: credentialContext.signal, services: {
      connectedAccounts: { materialize: async (purpose: string, request: ConnectedAccountMaterializationRequest) => {
        expect(purpose).toBe('cloud-api');
        return connectedAccountRuntime.materialize(request, credentialContext);
      } },
      http: { request: async (request: HttpRequest) => {
        requests.push(request);
        return { status: request.method === 'DELETE' ? 204 : 404, finalUrl: request.url, headers: {},
          body: request.method === 'DELETE' ? new Uint8Array() : new TextEncoder().encode('{"id":"not_found"}') };
      } },
    } } as unknown as PluginAccountActionContext;
    for (let invocation = 1; invocation <= 2; invocation++) {
      expect(await handlers.get('destroy')!({ resource: { dropletId: 42, ownedVolumeIds: ['owned'] } }, context))
        .toEqual({ kind: 'confirmed' });
      expect(credentialReads).toBe(invocation);
    }
    expect(requests.length).toBeGreaterThan(2);
    expect(requests.every(request => new Headers(request.headers).get('authorization') === 'Bearer selected-private'
      && request.credentialBinding === undefined)).toBe(true);
    expect(exports.PLUGIN_MANIFEST.contributes.actions.find(action => action.id === 'destroy')?.execution)
      .toMatchObject({ target: 'account' });
  });
  it('uses the retained generated guest pin on the same Droplet retry without a scanner or another allocation', async () => {
    const guestHostPublicKey = 'ssh-ed25519 AQIDBA== generated-host';
    const runtime = await activated(undefined, 200, url => ({ status: 200,
      body: url.includes('/actions') ? { actions: [] } : { droplet: { id: 42, name: 'managed', status: 'active',
        networks: { v4: [{ type: 'public', ip_address: '203.0.113.42' }] } } } }));
    const input = { resource, credentialRef: { kind: 'shared_resource', resourceId: 'retained-key' }, guestHostPublicKey };
    const first = await runtime.handlers.get('bootstrap')!(input, runtime.context);
    expect(first).toMatchObject({ kind: 'ssh', address: '203.0.113.42', user: 'happier-bootstrap', credentialRef: input.credentialRef,
      hostKeyEvidence: { hostKey: '203.0.113.42 ssh-ed25519 AQIDBA==', fingerprint: expect.stringMatching(/^SHA256:/) } });
    expect(await runtime.handlers.get('bootstrap')!(input, runtime.context)).toEqual(first);
    expect(runtime.requests.every(request => request.method === 'GET' && new URL(request.url).pathname.startsWith('/v2/droplets/42'))).toBe(true);
  });
  it('refuses pinned SSH bootstrap without a saved credential reference', async () => {
    const runtime = await activated(undefined, 200, url => ({ status: 200,
      body: url.includes('/actions') ? { actions: [] } : { droplet: { id: 42, name: 'managed', status: 'active',
        networks: { v4: [{ type: 'public', ip_address: '203.0.113.42' }] } } } }));
    await expect(runtime.handlers.get('bootstrap')!({ resource, guestHostPublicKey: 'ssh-ed25519 AQIDBA== generated-host' }, runtime.context))
      .rejects.toMatchObject({ code: 'credential_unavailable' });
  });
  it('continues delayed paid attachment cleanup without replaying the droplet DELETE', async () => {
    let dropletPresent = true;
    let volumePresent = true;
    const runtime = await activated(undefined, 200, (url, method) => {
      const volume = url.endsWith('/volumes/owned');
      if (method === 'DELETE') {
        if (volume) { expect(dropletPresent).toBe(false); volumePresent = false; }
        return { status: 204, body: undefined };
      }
      const present = volume ? volumePresent : dropletPresent;
      return { status: present ? 200 : 404, body: !present ? { id: 'not_found' }
        : volume ? { volume: { id: 'owned' } } : { droplet: { id: 42, name: 'managed', status: 'off' } } };
    });
    const destroy = async (input: unknown) => MachineProvisionerDestroyResultV1Schema.parse(await runtime.handlers.get('destroy')!(input, runtime.context));
    const first = await destroy({ resource: { dropletId: 42, ownedVolumeIds: ['owned'] } });
    expect(first).toMatchObject({ kind: 'accepted' });
    if (first.kind !== 'accepted') throw new Error('Expected retained attachment cleanup');
    expect(runtime.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
    expect(await destroy({ nativeOperation: first.nativeOperationRef.value })).toMatchObject({ kind: 'accepted' });
    expect(runtime.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
    dropletPresent = false;
    expect(await destroy({ nativeOperation: first.nativeOperationRef.value })).toEqual({ kind: 'confirmed' });
    expect(volumePresent).toBe(false);
    expect(runtime.requests.filter(request => request.method === 'DELETE').map(request => new URL(request.url).pathname))
      .toEqual(['/v2/droplets/42', '/v2/volumes/owned']);
  });
  it('keeps owned-volume cleanup pending for the shared Delete observer and preserves native read failures', async () => {
    let volumeStatus = 200;
    const runtime = await activated(undefined, 200, url => url.endsWith('/droplets/42')
      ? { status: 404, body: { id: 'not_found' } }
      : { status: volumeStatus, body: volumeStatus === 403 ? { id: 'forbidden' } : { volume: { id: 'owned' } } });
    const input = { resource: { ...resource, ownedVolumeIds: ['owned'] } };
    const inspect = async () => MachineProvisionerObservationV1Schema.parse(await runtime.handlers.get('inspect')!(input, runtime.context));
    expect(await inspect()).toMatchObject({ availability: 'unavailable', reason: 'native_cleanup_incomplete' });
    volumeStatus = 403;
    expect(await inspect()).toMatchObject({ availability: 'unavailable', reason: 'authorization', nativeCause: { httpStatusClass: '4xx' } });
    volumeStatus = 404;
    expect(await inspect()).toMatchObject({ availability: 'absent' });
    expect(runtime.requests).toHaveLength(6);
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('distinguishes pending native creation and address discovery from terminal bootstrap failures', async () => {
    const droplet = { id: 42, name: 'managed-42', status: 'new', networks: { v4: [], v6: [] } };
    let completed = false;
    let active = false;
    const runtime = await activated(undefined, 200, url => ({ status: 200,
      body: url.includes('/actions') ? { actions: [{ id: 9, resource_id: 42, resource_type: 'droplet', type: 'create',
        status: completed ? 'completed' : 'in-progress' }] } : { droplet: { ...droplet, status: active ? 'active' : 'new' } } }));
    const input = { resource, credentialRef: { kind: 'shared_resource', resourceId: 'key' } };
    await expect(runtime.handlers.get('bootstrap')!(input, runtime.context)).rejects.toMatchObject({ code: 'native_not_ready' });
    completed = true;
    await expect(runtime.handlers.get('bootstrap')!(input, runtime.context)).rejects.toMatchObject({ code: 'native_not_ready' });
    active = true;
    await expect(runtime.handlers.get('bootstrap')!(input, runtime.context)).rejects.toMatchObject({ code: 'native_not_ready' });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it.each([
    { status: 'off', pendingType: 'snapshot', code: 'native_resource_unavailable' },
    { status: 'off', pendingType: 'shutdown', code: 'native_resource_unavailable' },
    { status: 'unrecognized-state', pendingType: 'power_on', code: 'provider_unavailable' },
    { status: 'archive', pendingType: 'create', code: 'provider_unavailable' },
  ])('settles $status bootstrap instead of waiting on $pendingType', async ({ status, pendingType, code }) => {
    const runtime = await activated(undefined, 200, url => ({ status: 200, body: url.includes('/actions')
      ? { actions: [{ id: 9, resource_id: 42, resource_type: 'droplet', type: 'create', status: 'completed' },
        { id: 10, resource_id: 42, resource_type: 'droplet', type: pendingType, status: 'in-progress' }] }
      : { droplet: { id: 42, name: 'managed-42', status } } }));
    await expect(runtime.handlers.get('bootstrap')!({ resource,
      credentialRef: { kind: 'shared_resource', resourceId: 'key' } }, runtime.context)).rejects.toMatchObject({ code });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('waits for an explicit in-progress power-on while the retained Droplet is still off', async () => {
    const runtime = await activated(undefined, 200, url => ({ status: 200, body: url.includes('/actions')
      ? { actions: [{ id: 10, resource_id: 42, resource_type: 'droplet', type: 'power_on', status: 'in-progress' }] }
      : { droplet: { id: 42, name: 'managed-42', status: 'off' } } }));
    await expect(runtime.handlers.get('bootstrap')!({ resource,
      credentialRef: { kind: 'shared_resource', resourceId: 'key' } }, runtime.context))
      .rejects.toMatchObject({ code: 'native_not_ready' });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('emits each native fact once and minimizes pages at the CLOUD4 catalog scale', async () => {
    // Synthetic REST-v2 catalogs reproduce CLOUD4's dimension counts, not
    // that account's private catalog. REST v2 defaults to 20 rows, maximum 200.
    const regions = Array.from({ length: 18 }, (_, index) => ({ slug: `region-${index}`, name: `Region ${index}`, available: true }));
    const sizes = Array.from({ length: 311 }, (_, index) => ({ slug: `size-${index}`, memory: 1024, vcpus: 1, disk: 25,
      transfer: 1, price_hourly: 0.02, price_monthly: 12, regions: regions.map(region => region.slug), available: true }));
    const images = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, name: `Ubuntu ${index}`, distribution: 'Ubuntu',
      regions: regions.map(region => region.slug), status: 'available', type: 'base' }));
    const catalogs: Record<string, readonly unknown[]> = { sizes, images,
      regions: regions.map(region => ({ ...region, sizes: sizes.map(size => size.slug) })) };
    const runtime = await activated(undefined, 200, request => {
      const url = new URL(request);
      const key = url.pathname.slice('/v2/'.length);
      const catalog = catalogs[key];
      if (!catalog) throw new Error(`Unexpected native collection ${key}`);
      const perPage = Number(url.searchParams.get('per_page') ?? 20);
      const page = Number(url.searchParams.get('page') ?? 1);
      const end = page * perPage;
      url.searchParams.set('page', String(page + 1));
      return { status: 200, body: { [key]: catalog.slice(end - perPage, end),
        links: end < catalog.length ? { pages: { next: url.href } } : {} } };
    });
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
    const pages = Object.fromEntries(Object.keys(catalogs).map(key => [key,
      runtime.requests.filter(request => new URL(request.url).pathname === `/v2/${key}`).length]));
    console.info(`DigitalOcean native sizes=${sizes.length}; dimensions=${dimensionCount}; pages=${JSON.stringify(pages)}; bytes=${new TextEncoder().encode(wire).byteLength}; producerMs=${(producedAt - startedAt).toFixed(1)}; strictParseMs=${(parsedAt - producedAt).toFixed(1)}; stringifyMs=${(serializedAt - parsedAt).toFixed(1)}`);
    expect(dimensionCount).toBe(339);
    expect(wire.match(/"cpuCores":/g)?.length ?? 0)
      .toBe(sizes.length);
    expect(result.dimensions.size.map(size => size.id)).toEqual(sizes.map(size => size.slug));
    expect(result.dimensions.image.map(image => image.id)).toEqual(images.map(image => String(image.id)));
    expect(result.dimensions.location.map(region => region.id)).toEqual(regions.map(region => region.slug));
    expect(pages).toEqual({ sizes: 2, images: 1, regions: 1 });
  });

  it('carries native cause through activated check, options and acquire role schemas without throwing', async () => {
    const runtime = await activated({ id: 'forbidden', message: 'captured-private request content', request_id: 'private-request' }, 403);
    const nativeCause = { httpStatusClass: '4xx', code: 'forbidden' };
    const check = await runtime.handlers.get('check')!({}, runtime.context);
    expect(MachineProvisionerCheckResultV1Schema.parse(check)).toMatchObject({ available: false, nativeCause });
    const options = await runtime.handlers.get('options')!({}, runtime.context);
    expect(MachineProvisionerOptionsResultV1Schema.parse(options)).toEqual({ dimensions: { size: [], image: [], location: [], network: [], duration: [] }, code: 'provider_unavailable', nativeCause });
    const acquire = await runtime.handlers.get('acquire')!({ launch, managedId: 'cmvnxb7gn009mmcagisyszwlh', bootstrapPublicKey: 'ssh-ed25519 public' }, runtime.context);
    expect(exports.ROLE_SCHEMAS.acquireResult.parse(acquire)).toEqual({ kind: 'rejected', code: 'provider_unavailable', nativeCause });
    expect(JSON.stringify([check, options, acquire])).not.toMatch(/captured-private|request content|private-request/);
  });

  it.each(['inspect', 'power', 'destroy'] as const)('admits the retained native failure role %s through its declared result schema', async role => {
    const runtime = await activated({ id: 'forbidden', message: 'captured-private request content', request_id: 'private-request' }, 403);
    const input = role === 'power' ? { resource, intent: 'start' } : { resource };
    const result = await runtime.handlers.get(role)!(input, runtime.context);
    const schema = role === 'inspect' ? MachineProvisionerObservationV1Schema : MachineProvisionerPowerResultV1Schema;
    expect(schema.parse(result)).toMatchObject({ nativeCause: { httpStatusClass: '4xx', code: 'forbidden' } });
    expect(JSON.stringify(result)).not.toMatch(/captured-private|request content|private-request/);
  });

  it.each([[403, 'forbidden', 'rejected'], [500, 'server_error', 'pending']] as const)(
    'retains a documented POST refusal after real discovery and preserves create uncertainty (%s)', async (status, code, kind) => {
      const catalog = {
        sizes: [{ slug: launch.sizeSlug, memory: 1024, vcpus: 1, disk: 25, transfer: 1, price_hourly: 0.02, regions: ['nyc3'], available: true }],
        regions: [{ slug: 'nyc3', name: 'New York 3', available: true, sizes: [launch.sizeSlug] }],
        images: [{ id: 1, name: 'Ubuntu', distribution: 'Ubuntu', regions: ['nyc3'], status: 'available', type: 'base' }], links: {},
      };
      const runtime = await activated(catalog, 200, url => new URL(url).pathname === '/v2/droplets'
        ? { body: { id: code, message: 'captured-private content' }, status } : { body: catalog, status: 200 });
      const managedId = 'cmvnxb7gn009mmcagisyszwlh';
      const result = exports.ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('acquire')!(
        { launch, managedId, bootstrapPublicKey: 'ssh-ed25519 public' }, runtime.context));
      expect(result).toMatchObject({ kind, nativeCause: { httpStatusClass: status === 500 ? '5xx' : '4xx', code } });
      const submitted = runtime.requests.filter(request => request.method === 'POST');
      expect(submitted).toHaveLength(1);
      expect(JSON.parse(new TextDecoder().decode(submitted[0]!.body))).toMatchObject({ name: `happier-${managedId}`, tags: [`happier-${managedId}`] });
      expect(JSON.stringify(result)).not.toContain('captured-private');
    });

  it('binds an offered launch unchanged from an identity-only create reply through activated role schemas', async () => {
    const catalog = {
      sizes: [{ slug: launch.sizeSlug, memory: 1024, vcpus: 1, disk: 25, transfer: 1, price_hourly: 0.02, regions: ['nyc3'], available: true }],
      regions: [{ slug: 'nyc3', name: 'New York 3', available: true, sizes: [launch.sizeSlug] }],
      images: [{ id: 1, name: 'Ubuntu', distribution: 'Ubuntu', regions: ['nyc3'], status: 'available', type: 'base' }], links: {},
    };
    const runtime = await activated(catalog, 200, url => new URL(url).pathname === '/v2/droplets'
      ? { body: { droplet: { id: 42 } }, status: 202 } : { body: catalog, status: 200 });
    const offered = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    expect(offered.dimensions.network).toHaveLength(2);
    for (const network of offered.dimensions.network) {
      const selected = projectMachineProvisionerSelectionV1({ options: offered,
        selection: { size: launch.sizeSlug, location: launch.regionSlug, image: String(launch.imageId), network: network.id },
        launchSchema: exports.MACHINE_PROVISIONER.launchSchema });
      expect(selected.kind).toBe('ready');
      if (selected.kind !== 'ready') throw new Error('Expected an executable native selection');
      const result = exports.ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('acquire')!(
        { launch: selected.launch, managedId: 'cmvnxb7gn009mmcagisyszwlh', bootstrapPublicKey: 'ssh-ed25519 public' }, runtime.context));
      expect(result).toEqual({ kind: 'bound', resource: {
        contributionRef: { pluginId: 'happier.machine.digitalocean', localId: 'digitalocean' }, schemaVersion: 1, value: resource,
      } });
    }
    const submitted = runtime.requests.filter(request => request.method === 'POST');
    expect(submitted).toHaveLength(2);
    expect(submitted.map(request => JSON.parse(new TextDecoder().decode(request.body)).ipv6)).toEqual([false, true]);
  });

  it('submits a reviewed selection without refetching catalogs and preserves native rejection', async () => {
    const catalog = {
      sizes: [{ slug: launch.sizeSlug, memory: 1024, vcpus: 1, disk: 25, transfer: 1,
        price_hourly: 0.02, regions: ['nyc3'], available: true }],
      regions: [{ slug: 'nyc3', name: 'New York', available: true, sizes: [launch.sizeSlug] }],
      images: [{ id: 1, name: 'Ubuntu', distribution: 'Ubuntu', regions: ['nyc3'], status: 'available', type: 'base' }],
      links: {},
    };
    const runtime = await activated(undefined, 200, (_url, method) => method === 'POST'
      ? { status: 422, body: { id: 'unprocessable_entity', message: 'private native refusal' } }
      : { status: 200, body: catalog });
    const options = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    const selected = projectMachineProvisionerSelectionV1({ options, launchSchema: exports.MACHINE_PROVISIONER.launchSchema,
      selection: { size: launch.sizeSlug, image: '1', location: launch.regionSlug, network: '1' } });
    expect(selected).toMatchObject({ kind: 'ready', launch: { ...launch, publicNetworking: { ipv6: true } } });
    if (selected.kind !== 'ready') throw new Error('Expected an executable reviewed selection');
    // The native region withdraws this pair while retaining both selectors.
    catalog.regions[0]!.sizes = [];
    const result = exports.ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('acquire')!(
      { launch: selected.launch, managedId: 'cmvnxb7gn009mmcagisyszwlh', bootstrapPublicKey: 'ssh-ed25519 public' }, runtime.context));
    expect(result).toEqual({ kind: 'rejected', code: 'provider_unavailable',
      nativeCause: { httpStatusClass: '4xx', code: 'unprocessable_entity' } });
    expect(runtime.requests.filter(request => request.method === 'GET')).toHaveLength(3);
    const creates = runtime.requests.filter(request => request.method === 'POST');
    expect(creates).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(creates[0]?.body))).toMatchObject({
      region: launch.regionSlug, size: launch.sizeSlug, image: 1, ipv6: true,
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('retains native bootstrap refusal evidence through the public PluginError boundary', async () => {
    const runtime = await activated({ id: 'forbidden', message: 'captured-private content' }, 403);
    await expect(runtime.handlers.get('bootstrap')!({ resource, credentialRef: { kind: 'shared_resource', resourceId: 'bootstrap-secret' } }, runtime.context))
      .rejects.toMatchObject({ code: 'provider_unavailable', details: { nativeCause: { httpStatusClass: '4xx', code: 'forbidden' } } });
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

  it('admits the full cold manifest with host confirmation for native effects', () => {
    const result = parsePluginManifest(exports.PLUGIN_MANIFEST);
    expect(result, result.ok ? undefined : JSON.stringify(result.diagnostics)).toMatchObject({ ok: true });
    expect(exports.PLUGIN_MANIFEST.contributes.connectedAccountDescriptors).toMatchObject([
      { id: 'digitalocean-account', ui: { category: 'cloud-machines' } },
    ]);
    // REST accessibility alone cannot qualify the required SSH bootstrap in a browser.
    expect(exports.PLUGIN_MANIFEST.contributes.machineProvisioners).toMatchObject([
      { id: 'digitalocean', browserReachable: false, retention: { guestLocalStop: 'poweroff' } },
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
    expect(exports.ROLE_SCHEMAS.acquireResult.parse(await reconcile!(input, runtime.context))).toMatchObject({
      kind: 'bound', resource: { contributionRef: { pluginId: 'happier.machine.digitalocean', localId: 'digitalocean' },
        value: { dropletId: 42, ownedVolumeIds: [] } },
    });
    expect(runtime.requests.every(request => !('method' in request) || request.method === 'GET')).toBe(true);
    const readers = await exports.prepareStoredSchemas();
    expect('nativeOperationStored' in readers && readers.nativeOperationStored.parse({ recoveryTag: 'happier-pending-1', future: true })).toEqual({ recoveryTag: 'happier-pending-1' });
  });
  it.each([false, true])('qualifies paged GPU recovery through the strict role result, with a CPU match: %s', async cpuMatch => {
    const nativeDroplet = { id: 42, name: 'managed', status: 'off', tags: ['happier-pending-1'], volume_ids: [] };
    const runtime = await activated(undefined, 200, request => {
      const url = new URL(request);
      if (url.searchParams.get('type') !== 'gpus') return { status: 200, body: { droplets: cpuMatch ? [nativeDroplet] : [], links: {} } };
      if (url.searchParams.get('page') === '2') return { status: 200, body: { droplets: [{ ...nativeDroplet, id: 43 }], links: {} } };
      return { status: 200, body: { droplets: [{ ...nativeDroplet, id: 99, tags: ['happier-pending-10'] }],
        links: { pages: { next: 'https://api.digitalocean.com/v2/droplets?type=gpus&page=2' } } } };
    });
    const result = exports.ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('reconcile')!(
      { nativeOperation: { recoveryTag: 'happier-pending-1' } }, runtime.context));
    expect(result).toEqual(cpuMatch
      ? { kind: 'pending', nativeOperationRef: { contributionRef: { pluginId: 'happier.machine.digitalocean', localId: 'digitalocean' }, schemaVersion: 1, value: { recoveryTag: 'happier-pending-1' } } }
      : { kind: 'bound', resource: { contributionRef: { pluginId: 'happier.machine.digitalocean', localId: 'digitalocean' }, schemaVersion: 1, value: { dropletId: 43, ownedVolumeIds: [] } } });
    expect(runtime.requests).toHaveLength(3);
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
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
    const runtime = await activated({ id: 'forbidden', message: 'captured-private' }, 403);
    const reconcile = runtime.handlers.get('reconcile');
    expect(typeof reconcile).toBe('function');
    expect(exports.ROLE_SCHEMAS.acquireResult.parse(await reconcile!({ nativeOperation: { recoveryTag: 'happier-pending-1' } }, runtime.context))).toMatchObject({
      kind: 'pending', nativeOperationRef: { value: { recoveryTag: 'happier-pending-1' } },
      nativeCause: { httpStatusClass: '4xx', code: 'forbidden' },
    });
  });
  it('activates real roles and projects off-resource billing through the canonical result', async () => {
    const runtime = await activated({ droplet: { id: 42, name: 'managed', status: 'off', tags: [], volume_ids: [] } });
    const result = await runtime.handlers.get('inspect')!({ resource }, runtime.context);
    expect(result).toMatchObject({ availability: 'present', power: 'stopped',
      billing: { location: 'cloud', stoppedBilling: 'billed' } });
    expect(new Headers(runtime.requests[0]?.headers).get('authorization')).toBe('Bearer selected-private');
    expect(runtime.requests[0]?.credentialBinding).toBeUndefined();
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
    expect(exports.PLUGIN_MANIFEST.contributes.resources?.filter(({ id }) => id === 'brand-icon')).toEqual([{ id: 'brand-icon', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }]);
    const asset = readFileSync(new URL('../assets/brand.png', import.meta.url));
    expect([...asset.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(asset.readUInt32BE(16)).toBe(asset.readUInt32BE(20));
  });
});

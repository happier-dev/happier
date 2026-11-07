import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PluginError, type PluginApi, type PluginInvocationContext, type PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { ConnectedAccountReadContext, ConnectedAccountMaterializationRequest } from '@happier-dev/plugin-sdk/connected-accounts';
import { connectedAccountRuntime } from './account.js';
import type { ActionHandler, PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema, MachineProvisionerObservationV1Schema,
  MachineProvisionerPowerResultV1Schema, MachineProvisionerDestroyResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as exports from './index.js';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { HetznerNativeOperationV1Schema } from './machine/schemas.js';

const resource = { serverId: 41, owned: { volumeIds: [], primaryIpIds: [] } };
const launch = { serverTypeId: 'cx23', imageId: 'ubuntu-24.04', locationId: 'fsn1', publicNetworking: { ipv4: true, ipv6: false } };
// Partial fixtures replace only host registration
// and HTTP boundaries; public authoring/schema/native decoding remain real.
async function activated(response: unknown, status = 200, errorOnCreate?: { status: number; body: unknown },
  replyForUrl?: (url: string, method?: string) => Readonly<{ body: unknown; status: number }>) {
  const publicExports = exports as unknown as Record<string, unknown>;
  expect(typeof publicExports.activate).toBe('function');
  const handlers = new Map<string, ActionHandler>();
  const activate = publicExports.activate as (api: PluginApi) => Promise<unknown>;
  await activate({ actions: { register(id: string, handler: ActionHandler) {
    handlers.set(id, handler); return { dispose() {} };
  } }, connectedAccounts: { register() {} } } as unknown as PluginApi);
  await exports.activateAccount({ actions: { register(id: string, handler: PluginAccountActionHandler) {
    handlers.set(id, handler as ActionHandler); return { dispose() {} };
  } }, connectedAccounts: { register() {} } } as unknown as PluginAccountApi);
  const requests: HttpRequest[] = [];
  const credentialContext = { signal: new AbortController().signal,
    credentials: { get: async () => 'captured-private' } } as unknown as ConnectedAccountReadContext;
  const context = { invokedAtMs: 1234, signal: new AbortController().signal, services: {
    connectedAccounts: { materialize: async (_purpose: string, request: ConnectedAccountMaterializationRequest) =>
      connectedAccountRuntime.materialize(request, credentialContext) },
    http: { request: async (request: HttpRequest) => {
      requests.push(request);
      if (errorOnCreate && request.method === 'POST') return { status: errorOnCreate.status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(errorOnCreate.body)) };
      const reply = replyForUrl?.(request.url, request.method) ?? { body: response, status };
      return { status: reply.status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(reply.body)) };
    } },
  } } as unknown as PluginInvocationContext;
  return { handlers, context, requests };
}
describe('public hetzner machine provisioner', () => {
  it.each(['live', 'CLOUD33'] as const)('resolves the %s per-location catalog with architecture-matched Ubuntu and either IP family', async observation => {
    // Read-only REST v1 GETs, 2026-11-05 18:52Z; public catalog ids remapped.
    // CLOUD33 (18:14Z) observed the opposite cx23 availability in fsn1/hel1.
    const catalog = JSON.parse(readFileSync(new URL('./machine/fixtures/catalog-2026-11-05.json', import.meta.url), 'utf8'));
    const cx23 = catalog.server_types.find((size: { name: string }) => size.name === 'cx23');
    if (observation === 'CLOUD33') {
      for (const location of cx23.locations) location.available = location.name === 'fsn1';
    }
    const runtime = await activated(catalog);
    const options = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    const project = (size: string, image: string, location: string, network: string) => projectMachineProvisionerSelectionV1({
      options, selection: { size, image, location, network }, launchSchema: exports.MACHINE_PROVISIONER.launchSchema,
    });
    for (const size of catalog.server_types) {
      for (const image of catalog.images) {
        for (const location of size.locations) {
          for (const network of ['10', '01', '11']) {
            const selected = project(String(size.id), String(image.id), location.name, network);
            const available = location.available && size.architecture === image.architecture;
            expect.soft(selected.kind, `${observation}: ${size.name}/${location.name}/${image.name}/${image.architecture}/${network}`)
              .toBe(available ? 'ready' : 'unavailable');
          }
        }
      }
    }
    const ubuntu = catalog.images.find((image: { name: string; architecture: string }) => image.name === 'ubuntu-24.04' && image.architecture === 'x86');
    const location = observation === 'CLOUD33' ? 'fsn1' : 'hel1';
    expect(options.dimensions.size.find(size => size.id === String(cx23.id))?.nativeFacts?.size)
      .toMatchObject({ cpuCores: cx23.cores, memoryBytes: cx23.memory * 1024 ** 3 });
    // An unavailable compute choice must not present its IP add-on as the size's rate.
    const unavailableLocation = observation === 'CLOUD33' ? 'hel1' : 'fsn1';
    expect(project(String(cx23.id), String(ubuntu.id), unavailableLocation, '10'))
      .toMatchObject({ kind: 'unavailable', prices: [] });
    for (const image of catalog.images) {
      expect(options.dimensions.image.find(option => option.id === String(image.id))?.title)
        .toContain(image.architecture === 'arm' ? 'ARM64' : 'x86-64');
    }
    expect(project(String(cx23.id), String(ubuntu.id), location, '10')).toMatchObject({ kind: 'ready', prices: [
      { amount: '0.0112424000000000', currency: 'USD', unit: 'hour', label: { key: 'machineHetzner.prices.compute' } },
      { amount: '7.0156900000000000', currency: 'USD', unit: 'month' },
      { amount: '0.0010810000000000', currency: 'USD', unit: 'hour', label: { key: 'machineHetzner.prices.primaryIpv4' } },
      { currency: 'USD', unit: 'month' },
    ] });
    expect(runtime.requests).toHaveLength(4); // Three catalogs plus pricing, no retired /datacenters read.
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it.each([201, 503])('installs the admitted private guest-host lease before sshd and disposes it after native status %s', async status => {
    const server = { id: 41, status: 'running', labels: { 'happier-managed': 'row-1' },
      public_net: { ipv4: { id: 9, ip: '192.0.2.1' }, ipv6: null } };
    const guestHostPublicKey = 'ssh-ed25519 AQIDBA== generated-host';
    const privateKey = 'fixture-private-guest-host-key';
    const bytes = new TextEncoder().encode(privateKey);
    let disposed = false;
    const host = await activated(status === 201 ? { server } : { error: { code: 'service_unavailable' } }, status);
    // The plugin-to-host private credential service is the boundary; native role/HTTP/cloud-init logic stays real.
    const context = { ...host.context, services: { ...host.context.services, machineProvisioners: {
      materializeGuestHostCredential: async () => ({ kind: 'bytes' as const, bytes,
        dispose: async () => { disposed = true; bytes.fill(0); } }),
    } } } as unknown as PluginInvocationContext;
    const result = exports.ROLE_SCHEMAS.acquireResult.parse(await host.handlers.get('acquire')!({
      managedId: 'row-1', launch, bootstrapPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest', guestHostPublicKey,
    }, context));
    expect(host.requests).toHaveLength(1);
    const create = JSON.parse(new TextDecoder().decode(host.requests[0]?.body));
    const cloudInit = JSON.parse(create.user_data.replace(/^#cloud-config\n/, ''));
    expect(cloudInit.ssh_keys).toEqual({ ed25519_private: privateKey, ed25519_public: guestHostPublicKey });
    expect(cloudInit.runcmd).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(privateKey);
    expect(disposed).toBe(true);
    expect(bytes.every(byte => byte === 0)).toBe(true);
    if (status !== 201) { expect(result.kind).toBe('pending'); return; }
    expect(result).toMatchObject({ kind: 'bound', resource: { value: { serverId: 41, owned: { volumeIds: [], primaryIpIds: [9] } } } });
    if (result.kind !== 'bound') throw new Error('Expected the retained paid resource');
    const retryingHost = await activated({ server });
    const bootstrapInput = { resource: result.resource.value,
      credentialRef: { kind: 'shared_resource', resourceId: 'retained-bootstrap-key' }, guestHostPublicKey };
    const first = await host.handlers.get('bootstrap')!(bootstrapInput, host.context);
    expect(await retryingHost.handlers.get('bootstrap')!(bootstrapInput, retryingHost.context)).toEqual(first);
    expect(first).toMatchObject({ hostKeyEvidence: { hostKey: '192.0.2.1 ssh-ed25519 AQIDBA==' } });
    expect(retryingHost.requests.map(request => ({ path: new URL(request.url).pathname, method: request.method })))
      .toEqual([{ path: '/v1/servers/41', method: 'GET' }]);
  });
  it('never purchases an unpinned guest when the admitted private lease is unavailable', async () => {
    const host = await activated({ server: { id: 41 } }, 201);
    const context = { ...host.context, services: { ...host.context.services, machineProvisioners: {
      materializeGuestHostCredential: async () => { throw new PluginError({ code: 'plugin_service_unavailable' }); },
    } } } as unknown as PluginInvocationContext;
    await expect(host.handlers.get('acquire')!({ managedId: 'row-1', launch,
      bootstrapPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest', guestHostPublicKey: 'ssh-ed25519 AQIDBA==' }, context))
      .rejects.toMatchObject({ code: 'plugin_service_unavailable' });
    expect(host.requests).toHaveLength(0);
  });
  it('keeps the generated host pin and owned resources on a different host retry without scanning or allocating', async () => {
    const server = { id: 41, status: 'running', labels: { 'happier-managed': 'row-1' },
      public_net: { ipv4: { id: 9, ip: '192.0.2.1' }, ipv6: null } };
    const guestHostPublicKey = 'ssh-ed25519 AQIDBA== generated-host';
    const input = { resource: { serverId: 41, owned: { volumeIds: [7], primaryIpIds: [9] } },
      credentialRef: { kind: 'shared_resource', resourceId: 'retained-bootstrap-key' }, guestHostPublicKey };
    // Each HTTP-only host has no process/scanner service; all role and native logic is real.
    const firstHost = await activated({ server });
    const retryingHost = await activated({ server });
    const first = await firstHost.handlers.get('bootstrap')!(input, firstHost.context);
    expect(first).toMatchObject({ kind: 'ssh', address: '192.0.2.1', user: 'happier-bootstrap', credentialRef: input.credentialRef,
      hostKeyEvidence: { hostKey: '192.0.2.1 ssh-ed25519 AQIDBA==', fingerprint: expect.stringMatching(/^SHA256:/) } });
    expect(await retryingHost.handlers.get('bootstrap')!(input, retryingHost.context)).toEqual(first);
    expect([...firstHost.requests, ...retryingHost.requests].map(request => ({ path: new URL(request.url).pathname, method: request.method })))
      .toEqual([{ path: '/v1/servers/41', method: 'GET' }, { path: '/v1/servers/41', method: 'GET' }]);
  });
  it('retains the same paid server and owned IP after failed SSH evidence on another host without allocating', async () => {
    const server = { id: 41, status: 'running', labels: { 'happier-managed': 'row-1' },
      public_net: { ipv4: { id: 9, ip: '192.0.2.1' }, ipv6: null } };
    const creatingHost = await activated({ server }, 201);
    const bootstrapPublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest';
    const acquired = exports.ROLE_SCHEMAS.acquireResult.parse(await creatingHost.handlers.get('acquire')!({
      managedId: 'row-1', launch, bootstrapPublicKey,
    }, creatingHost.context));
    expect(acquired).toMatchObject({ kind: 'bound', resource: { value: { serverId: 41,
      owned: { volumeIds: [], primaryIpIds: [9] } } } });
    if (acquired.kind !== 'bound') throw new Error('Expected the retained paid resource');
    const retryingHost = await activated({ server });
    // Only the OS/process boundary fails; the public role and exact native inspect stay real.
    const exec = { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'ssh-keyscan' } }) },
      run: async () => { throw new Error('fixture SSH transport unavailable'); },
    } as unknown as ExecService;
    const context = { ...retryingHost.context, services: { ...retryingHost.context.services, exec } };
    const input = { resource: acquired.resource.value, credentialRef: { kind: 'shared_resource', resourceId: 'retained-bootstrap-key' }, bootstrapPublicKey };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(retryingHost.handlers.get('bootstrap')!(input, context))
        .rejects.toMatchObject({ code: 'native_ssh_host_key_unavailable' });
    }
    expect(retryingHost.requests.map(request => ({ path: new URL(request.url).pathname, method: request.method })))
      .toEqual([{ path: '/v1/servers/41', method: 'GET' }, { path: '/v1/servers/41', method: 'GET' }]);
    expect(creatingHost.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    const create = JSON.parse(new TextDecoder().decode(creatingHost.requests[0]?.body));
    expect(create.user_data).toContain(bootstrapPublicKey);
  });
  it('waits for the delete action even after server absence before cleaning paid attachments', async () => {
    let serverPresent = true;
    let actionComplete = false;
    const attachments = new Set(['/v1/volumes/7', '/v1/primary_ips/9']);
    const runtime = await activated(undefined, 200, undefined, (url, method) => {
      const path = new URL(url).pathname;
      if (path === '/v1/servers/actions/10') return { status: 200, body: { action: { id: 10, status: actionComplete ? 'success' : 'running' } } };
      if (method === 'DELETE') {
        if (path === '/v1/servers/41') return { status: 200, body: { action: { id: 10, status: 'running' } } };
        if (!actionComplete) return { status: 422, body: { error: { code: 'must_be_unassigned' } } };
        expect(serverPresent).toBe(false);
        attachments.delete(path);
        return { status: 204, body: undefined };
      }
      if (path === '/v1/servers/41' && serverPresent) return { status: 200, body: { server: {
        id: 41, status: 'deleting', labels: {}, volumes: [], public_net: { ipv4: null, ipv6: null },
      } } };
      return { status: attachments.has(path) ? 200 : 404,
        body: attachments.has(path) ? { id: 1 } : { error: { code: 'not_found' } } };
    });
    const owned = { serverId: 41, owned: { volumeIds: [7], primaryIpIds: [9] } };
    const destroy = async (input: unknown) => MachineProvisionerDestroyResultV1Schema.parse(await runtime.handlers.get('destroy')!(input, runtime.context));
    const first = await destroy({ resource: owned });
    expect(first).toMatchObject({ kind: 'accepted' });
    if (first.kind !== 'accepted') throw new Error('Expected retained attachment cleanup');
    const readers = await exports.prepareStoredSchemas();
    if (!('nativeOperationStored' in readers)) throw new Error('Expected declared reconciliation reader');
    const retained = HetznerNativeOperationV1Schema.parse(readers.nativeOperationStored.parse(first.nativeOperationRef.value));
    expect(retained).toEqual({ ...owned, deleteActionId: 10 });
    expect(exports.ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('reconcile')!({ nativeOperation: retained }, runtime.context)))
      .toMatchObject({ kind: 'bound', resource: { value: owned } });
    expect(runtime.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
    // REST v1 removes account visibility immediately, before detachment finishes.
    serverPresent = false;
    const pendingStart = runtime.requests.length;
    expect(await destroy({ nativeOperation: retained })).toMatchObject({ kind: 'accepted' });
    expect(runtime.requests.slice(pendingStart).map(request => ({ method: request.method, path: new URL(request.url).pathname })))
      .toEqual([{ method: 'GET', path: '/v1/servers/actions/10' }]);
    expect(runtime.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
    const beforeInspect = runtime.requests.length;
    expect(await runtime.handlers.get('inspect')!({ resource: owned }, runtime.context)).toMatchObject({ reason: 'native_cleanup_incomplete' });
    expect(runtime.requests.slice(beforeInspect).every(request => request.method === 'GET')).toBe(true);
    actionComplete = true;
    expect(await destroy({ nativeOperation: first.nativeOperationRef.value })).toEqual({ kind: 'confirmed' });
    expect(attachments.size).toBe(0);
    expect(runtime.requests.filter(request => request.method === 'DELETE').map(request => new URL(request.url).pathname))
      .toEqual(['/v1/servers/41', '/v1/volumes/7', '/v1/primary_ips/9']);
  });
  it('settles a failed native delete action visibly without deleting attachments', async () => {
    const runtime = await activated(undefined, 200, undefined, (url, method) => {
      if (url.endsWith('/servers/41') && method === 'DELETE') return { status: 200, body: { action: { id: 10, status: 'running' } } };
      if (url.endsWith('/servers/actions/10')) return { status: 200, body: { action: { id: 10, status: 'error' } } };
      return { status: 404, body: { error: { code: 'not_found' } } };
    });
    const destroy = async (input: unknown) => MachineProvisionerDestroyResultV1Schema.parse(await runtime.handlers.get('destroy')!(input, runtime.context));
    const first = await destroy({ resource: { ...resource, owned: { volumeIds: [], primaryIpIds: [9] } } });
    expect(first.kind).toBe('accepted');
    if (first.kind !== 'accepted') throw new Error('Expected retained native action');
    expect(await destroy({ nativeOperation: first.nativeOperationRef.value })).toEqual({ kind: 'unknown', code: 'native_action_failed' });
    expect(runtime.requests.filter(request => request.method === 'DELETE').map(request => new URL(request.url).pathname)).toEqual(['/v1/servers/41']);
  });
  it('retains a typed paid-IP cleanup failure and lets an explicit Delete retry finish', async () => {
    let ipPresent = true;
    let refuseIp = true;
    const runtime = await activated(undefined, 200, undefined, (url, method) => {
      if (url.endsWith('/servers/41')) return { status: 404, body: { error: { code: 'not_found' } } };
      if (method === 'DELETE' && refuseIp) return { status: 422, body: { error: { code: 'must_be_unassigned', message: 'private vendor text' } } };
      if (method === 'DELETE') ipPresent = false;
      return { status: ipPresent ? 200 : 404, body: ipPresent ? { primary_ip: { id: 9 } } : { error: { code: 'not_found' } } };
    });
    const input = { resource: { ...resource, owned: { volumeIds: [], primaryIpIds: [9] } } };
    const destroy = async () => MachineProvisionerDestroyResultV1Schema.parse(await runtime.handlers.get('destroy')!(input, runtime.context));
    const failed = await destroy();
    expect(failed).toEqual({ kind: 'unknown', code: 'native_request_failed', nativeCause: { httpStatusClass: '4xx' } });
    expect(JSON.stringify(failed)).not.toContain('private vendor text');
    expect(await runtime.handlers.get('inspect')!(input, runtime.context)).toMatchObject({ availability: 'unavailable', reason: 'native_cleanup_incomplete' });
    refuseIp = false;
    expect(await destroy()).toEqual({ kind: 'confirmed' });
    expect(await runtime.handlers.get('inspect')!(input, runtime.context)).toMatchObject({ availability: 'absent' });
  });
  it.each(['volume', 'primary-ip'] as const)('keeps pending owned %s cleanup observable without masking native failures', async kind => {
    let attachmentStatus = 200;
    const runtime = await activated(undefined, 200, undefined, url => url.endsWith('/servers/41')
      ? { status: 404, body: { error: { code: 'not_found' } } }
      : { status: attachmentStatus, body: attachmentStatus === 200 ? { id: 9 }
        : { error: { code: attachmentStatus === 403 ? 'forbidden' : 'not_found' } } });
    const input = { resource: { serverId: 41, owned: { volumeIds: kind === 'volume' ? [9] : [], primaryIpIds: kind === 'primary-ip' ? [9] : [] } } };
    const inspect = async () => MachineProvisionerObservationV1Schema.parse(await runtime.handlers.get('inspect')!(input, runtime.context));
    expect(await inspect()).toMatchObject({ availability: 'unavailable', reason: 'native_cleanup_incomplete' });
    attachmentStatus = 403;
    expect(await inspect()).toMatchObject({ availability: 'unavailable', reason: 'provider_unavailable', nativeCause: { httpStatusClass: '4xx', code: 'forbidden' } });
    attachmentStatus = 404;
    expect(await inspect()).toMatchObject({ availability: 'absent' });
    expect(runtime.requests).toHaveLength(6);
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('acquires the unchanged CLOUD12 cx23/fsn1 numeric selection offered by options', async () => {
    // Constructed REST v1 responses: CLOUD12 recorded these IDs and price;
    // QB232 catalog-cont3.json records the native per-location shape.
    const pair = { net: '0.009448', gross: '0.0112424' };
    const catalog = {
      server_types: [{ id: 114, name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86',
        locations: [{ id: 1, name: 'fsn1', available: true, recommended: true, deprecation: null }],
        prices: [{ location: 'fsn1', price_hourly: pair, price_monthly: pair }] }],
      images: [{ id: 67794396, name: 'ubuntu-22.04', architecture: 'x86', type: 'system', status: 'available', deprecated: null, os_flavor: 'ubuntu' }],
      locations: [{ id: 1, name: 'fsn1', description: 'Falkenstein DC Park 1', country: 'DE' }],
      pricing: { currency: 'USD' }, meta: { pagination: { next_page: null } },
    };
    const runtime = await activated(catalog, 200, { status: 201, body: { server: { id: 41 } } });
    const options = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    const selected = projectMachineProvisionerSelectionV1({ options,
      selection: { size: '114', image: '67794396', location: 'fsn1', network: '10' }, launchSchema: exports.MACHINE_PROVISIONER.launchSchema });
    expect(selected.kind).toBe('ready');
    if (selected.kind !== 'ready') throw new Error('Expected the recorded CLOUD12 selection');
    expect(selected.launch).toEqual({ serverTypeId: '114', imageId: '67794396', locationId: 'fsn1', publicNetworking: { ipv4: true, ipv6: false } });
    expect(await runtime.handlers.get('acquire')!({ managedId: 'cmvqzozlc0055mcb7yz1wvm1k', launch: selected.launch,
      bootstrapPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest' }, runtime.context)).toMatchObject({ kind: 'bound' });
    expect(runtime.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(runtime.requests.filter(request => request.method === 'GET')).toHaveLength(4);
  });

  it('uses current and legacy image deprecation facts while preserving native guest OS facts', async () => {
    const runtime = await activated({
      server_types: [], locations: [], pricing: { currency: 'USD' },
      images: [
        // REST v1 removed deprecated on 2026-11-02; deprecation is authoritative.
        { id: 1, name: 'not-a-linux-name', architecture: 'x86', type: 'system', status: 'available', deprecation: null, os_flavor: 'ubuntu' },
        { id: 2, name: null, description: 'Ubuntu snapshot', architecture: 'x86', type: 'snapshot', status: 'available', deprecated: null, os_flavor: 'unknown' },
        { id: 3, name: null, architecture: 'x86', type: 'backup', status: 'available', deprecated: null },
        { id: 4, name: null, architecture: 'x86', type: 'snapshot', status: 'available', deprecated: null, os_flavor: 'debian' },
        { id: 5, name: 'old-current-image', architecture: 'x86', type: 'system', status: 'available', deprecated: null,
          deprecation: { announced: '2026-08-31T00:00:00Z', unavailable_after: '2026-11-30T00:00:00Z' } },
        { id: 6, name: 'old-legacy-image', architecture: 'x86', type: 'system', status: 'available', deprecated: '2026-08-31T00:00:00Z' },
      ], meta: { pagination: { next_page: null } },
    });
    const options = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    expect(options.dimensions.image.map(image => image.id)).toEqual(['1', '2', '3', '4']);
    expect(options.base).not.toHaveProperty('guestPlatform');
    expect(options.dimensions.image[0]).toMatchObject({ guestPlatform: 'linux' });
    expect(options.dimensions.image[1]).not.toHaveProperty('guestPlatform');
    expect(options.dimensions.image[2]).not.toHaveProperty('guestPlatform');
    expect(options.dimensions.image[3]).toMatchObject({ guestPlatform: 'linux' });
    expect(runtime.requests).toHaveLength(4);
  });

  it('keeps image deprecation unknown when neither native field is present', async () => {
    const runtime = await activated({ server_types: [], locations: [], pricing: { currency: 'EUR' },
      images: [{ id: 1, name: 'ubuntu', architecture: 'x86', type: 'system', status: 'available' }],
      meta: { pagination: { next_page: null } },
    });
    expect(await runtime.handlers.get('options')!({}, runtime.context))
      .toMatchObject({ code: 'provider_unavailable', dimensions: { image: [] } });
  });

  it.each([
    { reason: 'temporarily unavailable', available: false, deprecation: null, supported: true },
    { reason: 'retired at this location', available: true, deprecation: { unavailable_after: '2000-01-01T00:00:00Z' }, supported: true },
    { reason: 'unsupported despite retained pricing', available: true, deprecation: null, supported: false },
  ])('withdraws a $reason size/location from a fresh review', async state => {
    const pair = { net: '1', gross: '1' };
    const locations: Array<{ id: number; name: string; available: boolean; deprecation: { unavailable_after: string } | null }> = [
      { id: 1, name: 'fsn1', available: true, deprecation: null },
      { id: 4, name: 'ash', available: true, deprecation: null },
    ];
    const catalog = {
      server_types: [{ id: 22, name: 'cpx11', cores: 2, memory: 2, disk: 40, architecture: 'x86', deprecation: null,
        locations, prices: ['fsn1', 'ash'].map(location => ({ location, price_hourly: pair, price_monthly: pair })) }],
      images: [{ id: 67794396, name: 'ubuntu-22.04', architecture: 'x86', type: 'system', status: 'available', deprecated: null }],
      locations: [{ id: 1, name: 'fsn1', description: 'Falkenstein' }, { id: 4, name: 'ash', description: 'Ashburn' }], pricing: { currency: 'USD' },
      meta: { pagination: { next_page: null } },
    };
    const runtime = await activated(catalog, 200, { status: 201, body: { server: { id: 41 } } });
    const selection = { size: '22', image: '67794396', location: 'fsn1', network: '10' };
    const project = (options: unknown, location = 'fsn1') => projectMachineProvisionerSelectionV1({
      options: MachineProvisionerOptionsResultV1Schema.parse(options), selection: { ...selection, location }, launchSchema: exports.MACHINE_PROVISIONER.launchSchema,
    });
    const reviewed = project(await runtime.handlers.get('options')!({}, runtime.context));
    expect(reviewed.kind).toBe('ready');
    if (reviewed.kind !== 'ready') throw new Error('Expected an initially supported selection');
    locations.splice(0, 1, ...(state.supported ? [{ id: 1, name: 'fsn1', available: state.available, deprecation: state.deprecation }] : []));
    const withdrawn = await runtime.handlers.get('options')!({}, runtime.context);
    expect(project(withdrawn).kind).toBe('unavailable');
    expect(project(withdrawn, 'ash').kind).toBe('ready');
    expect(runtime.requests).toHaveLength(8);
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('uses per-location deprecation instead of the retired global server-type field', async () => {
    const pair = { net: '1', gross: '1' };
    const runtime = await activated({
      server_types: [{ id: 22, name: 'cpx11', cores: 2, memory: 2, disk: 40, architecture: 'x86',
        deprecation: { unavailable_after: '2000-01-01T00:00:00Z' },
        locations: [{ id: 1, name: 'fsn1', available: true, deprecation: { unavailable_after: '2100-01-01T00:00:00Z' } }],
        prices: [{ location: 'fsn1', price_hourly: pair, price_monthly: pair }] }],
      images: [{ id: 67794396, name: 'ubuntu-22.04', architecture: 'x86', type: 'system', status: 'available', deprecated: null }],
      locations: [{ id: 1, name: 'fsn1', description: 'Falkenstein' }], pricing: { currency: 'USD' },
      meta: { pagination: { next_page: null } },
    }, 200, { status: 201, body: { server: { id: 41 } } });
    const options = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    const selected = projectMachineProvisionerSelectionV1({ options,
      selection: { size: '22', image: '67794396', location: 'fsn1', network: '10' }, launchSchema: exports.MACHINE_PROVISIONER.launchSchema });
    expect(selected.kind).toBe('ready');
    if (selected.kind !== 'ready') throw new Error('Expected a supported location until its own removal date');
    expect(await runtime.handlers.get('acquire')!({ managedId: 'row-1', launch: selected.launch,
      bootstrapPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest' }, runtime.context)).toMatchObject({ kind: 'bound' });
    expect(runtime.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });

  it.each(['accepted', 'vendor-refused', 'catalog-changed'] as const)(
    'submits the reviewed CLOUD4 selection without refetching catalogs: %s', async outcome => {
      // CLOUD4's recorded selection/row (2026-10-26); the HTTP catalog is
      // synthetic because the original native responses were not retained.
      const managedId = 'cmvol9l440095mcr0ke1j8yxl';
      const pair = { net: '1', gross: '1' };
      const catalog = {
        server_types: [{ id: 22, name: 'cpx11', cores: 2, memory: 2, disk: 40, architecture: 'x86',
          locations: [{ id: 1, name: 'fsn1', available: true, deprecation: null }],
          prices: [{ location: 'fsn1', price_hourly: pair, price_monthly: pair }] }],
        images: [
          { id: 67794396, name: 'ubuntu-22.04', architecture: 'x86', type: 'system', status: 'available', deprecated: null },
          { id: 67794397, name: 'ubuntu-22.04', architecture: 'x86', type: 'system', status: 'available', deprecated: null },
        ],
        locations: [{ id: 1, name: 'fsn1', description: 'Falkenstein' }], pricing: { currency: 'USD' },
        meta: { pagination: { next_page: null } },
      };
      const runtime = await activated(catalog, 200, outcome === 'vendor-refused'
        ? { status: 422, body: { error: { code: 'invalid_input', message: 'private native message' } } }
        : { status: 201, body: { server: { id: 41 } } });
      const options = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
      // Same-name, same-architecture images remain distinct reviewed identities.
      expect(options.dimensions.image.map(image => image.id)).toEqual(['67794396', '67794397']);
      const selected = projectMachineProvisionerSelectionV1({ options,
        selection: { size: '22', image: '67794396', location: 'fsn1', network: '10' },
        launchSchema: exports.MACHINE_PROVISIONER.launchSchema });
      expect(selected.kind).toBe('ready');
      if (selected.kind !== 'ready') throw new Error('Expected the recorded CLOUD4 selection');
      expect(selected.launch).toEqual({ serverTypeId: '22', imageId: '67794396', locationId: 'fsn1',
        publicNetworking: { ipv4: true, ipv6: false } });
      if (outcome === 'catalog-changed') catalog.images.length = 0;
      const result = exports.ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('acquire')!({
        managedId, launch: selected.launch, bootstrapPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQTest',
      }, runtime.context));
      expect(result).toMatchObject(outcome !== 'vendor-refused'
        ? { kind: 'bound', resource: { value: { serverId: 41 } } }
        : { kind: 'rejected', nativeCause: { httpStatusClass: '4xx', code: 'invalid_input' } });
      const creates = runtime.requests.filter(request => request.method === 'POST');
      expect(creates).toHaveLength(1);
      expect(runtime.requests.filter(request => request.method === 'GET')).toHaveLength(4);
      if (creates[0]) {
        // Official REST v1 CreateServerRequest + Labels, fetched 2026-10-26.
        // IDs/names are strings; this recorded selection already meets that contract.
        const body = JSON.parse(new TextDecoder().decode(creates[0].body));
        expect(body).toEqual({
          name: `happier-${managedId}`, server_type: '22', image: '67794396', location: 'fsn1',
          public_net: { enable_ipv4: true, enable_ipv6: false }, labels: { 'happier-managed': managedId },
          start_after_create: true,
          user_data: '#cloud-config\n{"users":[{"name":"happier-bootstrap","shell":"/bin/bash","lock_passwd":true,"sudo":"ALL=(ALL) NOPASSWD:ALL","ssh_authorized_keys":["ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQTest"]}],"ssh_pwauth":false}\n',
        });
        expect(body.name).toHaveLength(33);
        expect(body.name.length).toBeLessThanOrEqual(253);
        for (const label of body.name.split('.')) {
          expect(label).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/);
          expect(label.length).toBeLessThanOrEqual(63);
        }
        for (const [key, value] of Object.entries(body.labels)) {
          for (const part of [key, String(value)]) {
            expect(part).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/);
            expect(part.length).toBeLessThanOrEqual(63);
          }
          expect(key.startsWith('hetzner.cloud/')).toBe(false);
        }
        expect(new TextEncoder().encode(body.user_data).byteLength).toBeLessThanOrEqual(32 * 1024);
      }
      expect(JSON.stringify(result)).not.toContain('private');
    });

  it('carries native bootstrap failure through the public PluginError without vendor content', async () => {
    const runtime = await activated({ error: { code: 'forbidden', message: 'private vendor content' } }, 403);
    await expect(runtime.handlers.get('bootstrap')!({ resource }, runtime.context)).rejects.toMatchObject({
      name: 'PluginError', code: 'native_authorization_failed', details: { nativeCause: { httpStatusClass: '4xx', code: 'forbidden' } },
    });
  });

  it('qualifies every offered CLOUD2 networking choice against the same current native catalog', async () => {
    const pair = { net: '1', gross: '1' };
    const runtime = await activated({
      server_types: [{ id: 22, name: 'cpx11', cores: 2, memory: 2, disk: 40, architecture: 'x86',
        locations: [{ id: 1, name: 'fsn1', available: true, deprecation: null }], prices: [
        { location: 'fsn1', price_hourly: pair, price_monthly: pair },
        { location: 'retired-location', price_hourly: pair, price_monthly: pair },
      ] }],
      images: [{ id: 67794396, name: 'ubuntu-22.04', architecture: 'x86', type: 'system', status: 'available', deprecated: null }],
      locations: [{ id: 1, name: 'fsn1', description: 'Falkenstein' }], pricing: { currency: 'USD' },
      meta: { pagination: { next_page: null } },
    }, 200, { status: 403, body: { error: { code: 'forbidden' } } });
    const options = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    expect(options.dimensions.location.map(location => location.id)).toEqual(['fsn1']);
    expect(options.dimensions.network).toHaveLength(3);
    for (const network of options.dimensions.network) {
      const selected = projectMachineProvisionerSelectionV1({ options,
        selection: { size: '22', image: '67794396', location: 'fsn1', network: network.id },
        launchSchema: exports.MACHINE_PROVISIONER.launchSchema });
      expect(selected.kind).toBe('ready');
      if (selected.kind !== 'ready') throw new Error('Expected an executable native selection');
      const result = exports.ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('acquire')!({
        launch: selected.launch, managedId: 'cmvo5ms9x018amc7yydxvdvte',
        bootstrapPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest',
      }, runtime.context));
      // Every reviewed choice reaches the native boundary, including the
      // recorded IPv4-only CLOUD2 launch; its refusal remains typed.
      expect(result).toMatchObject({ kind: 'rejected', nativeCause: { httpStatusClass: '4xx', code: 'forbidden' } });
    }
    const creates = runtime.requests.filter(request => request.method === 'POST');
    expect(creates).toHaveLength(3);
    expect(JSON.parse(new TextDecoder().decode(creates[0]?.body))).toMatchObject({
      server_type: '22', image: '67794396', location: 'fsn1', public_net: { enable_ipv4: true, enable_ipv6: false },
    });
  });

  it('retains the typed no-SSH-network refusal through the public role before purchase', async () => {
    const runtime = await activated({ server_types: [], images: [], locations: [], pricing: { currency: 'EUR' }, meta: { pagination: { next_page: null } } });
    const result = exports.ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('acquire')!({
      launch: { ...launch, publicNetworking: { ipv4: false, ipv6: false } }, managedId: 'row-1', bootstrapPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest',
    }, runtime.context));
    expect(result).toMatchObject({ kind: 'rejected', nativeCause: { localCause: 'native_ssh_network_unavailable' } });
    expect(runtime.requests).toHaveLength(0);
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

  it.each(['check', 'options', 'inspect', 'power', 'destroy', 'reconcile'] as const)('retains the native refusal through %s and its strict consumer', async role => {
    const runtime = await activated({ error: { code: 'forbidden', message: 'private-content' } }, 403);
    const input = role === 'power' ? { resource, intent: 'stop' } : role === 'inspect' || role === 'destroy' ? { resource }
      : role === 'reconcile' ? { nativeOperation: { correlation: 'row-1' } } : {};
    const result = await runtime.handlers.get(role)!(input, runtime.context);
    expect(result).toMatchObject({ nativeCause: { httpStatusClass: '4xx', code: 'forbidden' } });
    const schema = role === 'check' ? MachineProvisionerCheckResultV1Schema : role === 'options' ? MachineProvisionerOptionsResultV1Schema
      : role === 'inspect' ? MachineProvisionerObservationV1Schema : role === 'reconcile' ? exports.ROLE_SCHEMAS.acquireResult : MachineProvisionerPowerResultV1Schema;
    expect(schema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([403, 503])('carries native HTTP %s cause through the real acquire role and CUID-derived name', async status => {
    const pair = { net: '1', gross: '1' };
    const runtime = await activated({
      server_types: [{ id: 1, name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86',
        locations: [{ id: 1, name: 'fsn1', available: true, deprecation: null }], prices: [{ location: 'fsn1', price_hourly: pair, price_monthly: pair }] }],
      images: [{ id: 10, name: 'ubuntu-24.04', architecture: 'x86', type: 'system', status: 'available', deprecated: null }],
      locations: [{ id: 1, name: 'fsn1', description: 'Falkenstein' }], pricing: { currency: 'EUR' }, meta: { pagination: { next_page: null } },
    }, 200, { status, body: { error: { code: status === 403 ? 'resource_limit_exceeded' : 'unavailable', message: 'private-vendor-content' } } });
    const managedId = 'cmvnxy10a009smcagvbuikgo1';
    const result = await runtime.handlers.get('acquire')!({ launch, managedId, bootstrapPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest' }, runtime.context);
    expect(result).toMatchObject({ kind: status === 403 ? 'rejected' : 'pending',
      nativeCause: { httpStatusClass: status === 403 ? '4xx' : '5xx', code: status === 403 ? 'resource_limit_exceeded' : 'unavailable' } });
    expect(exports.ROLE_SCHEMAS.acquireResult.safeParse(result).success).toBe(true);
    expect(runtime.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    const create = runtime.requests.find(request => request.method === 'POST');
    expect(JSON.parse(new TextDecoder().decode(create?.body)).name).toBe(`happier-${managedId}`);
    expect(JSON.stringify(result)).not.toContain('private');
  });

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
          image: { id: '10', title: 'ubuntu-24.04 (x86-64)', description: 'Ubuntu 24.04 LTS' }, location: { id: 'fsn1', title: 'Falkenstein', countryCode: 'DE' } },
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
  it.each([
    { nativeOperation: { correlation: 'pending-1' } },
    { correlation: { managedId: 'pending-1', requestId: 'original-request', launch } },
  ])('settles an empty native acquisition without purchasing again: %j', async input => {
    const runtime = await activated({}, 200, undefined, url => ({ status: 200, body: {
      [new URL(url).pathname.endsWith('/primary_ips') ? 'primary_ips' : 'servers']: [],
      meta: { pagination: { next_page: null } },
    } }));
    expect(exports.ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('reconcile')!(input, runtime.context)))
      .toEqual({ kind: 'rejected', code: 'managed_not_found' });
    expect(runtime.requests.map(request => new URL(request.url).pathname)).toEqual(['/v1/servers', '/v1/primary_ips']);
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
    expect(readers.resourceStored.parse({ ...resource, owned: { ...resource.owned, future: true }, future: true })).toEqual(resource);
    const runtime = await activated({ server: { id: 41, status: 'off', labels: {}, public_net: { ipv4: null, ipv6: null }, volumes: [] } });
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

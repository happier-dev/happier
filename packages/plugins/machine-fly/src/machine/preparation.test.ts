import { describe, expect, it } from 'vitest';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext, PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { ConnectedAccountMaterializationRequest, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { connectedAccountRuntime } from '../account.js';
import { activateAccount, MACHINE_PROVISIONER } from '../manifest.js';

const operationId = 'operation-one';
const appName = 'happier-prepared-' + operationId;
const digest = 'sha256:' + 'a'.repeat(64);
const launch = { app: { name: 'session-app', ownership: 'created', organizationSlug: 'selected-org' },
  region: 'ams', guest: { cpuKind: 'shared', cpus: 1, memoryMb: 512 }, volume: { kind: 'create', sizeGb: 1 } } as const;
const buildInput = { operationId, input: { launch: { provider: { pluginId: 'happier.machine.fly', localId: 'fly' }, schemaVersion: 1, choices: launch },
  cli: { identity: 'public-release:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier',
    installScript: 'install -m 755 cli /opt/happier/cli/happier', files: [{ path: 'cli', contentsBase64: 'Y2xp' }] },
  setupScript: 'apt-get update && apt-get install -y git' } };

// The vendor HTTP, host credential store and registration API are boundaries.
// Real public registration, credential materialization and role schemas remain.
async function fixture() {
  const handlers = new Map<string, PluginAccountActionHandler>();
  await activateAccount({ actions: { register(id: string, handler: PluginAccountActionHandler) {
    handlers.set(id, handler); return { dispose() {} };
  } } } as unknown as PluginAccountApi);
  const calls: { request: HttpRequest; body?: Record<string, unknown> }[] = [];
  const uploads = new Map<string, string[]>();
  let app = false, machine = false, image = false, state = 'not_started', loseCreate = false, loseLaunch = false, deferDelete = false, retainImage = false;
  let organizationSlug = 'selected-org', registryStatus: number | undefined, splitUploads = false;
  const accountContext = { signal: new AbortController().signal, configuration: { values: { organizationSlug: 'selected-org' } },
    credentials: { get: async () => 'private-registry-token' } } as unknown as ConnectedAccountReadContext;
  const context = { signal: new AbortController().signal, services: {
    connectedAccounts: { materialize: (_purpose: string, request: ConnectedAccountMaterializationRequest) => connectedAccountRuntime.materialize(request, accountContext) },
    http: { request: async (request: HttpRequest) => {
      const url = new URL(request.url), method = request.method;
      const body = request.body ? JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown> : undefined;
      calls.push({ request, body });
      let status = 200, value: unknown = {}, headers: Record<string, string> = {};
      if (url.origin === 'https://registry.fly.io') {
        status = registryStatus ?? (image ? 200 : 404);
        value = image ? { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: {}, layers: [] } : {};
        headers = image ? { 'docker-content-digest': digest } : {};
      } else if (url.pathname === '/v1/apps' && method === 'POST') {
        app = true; value = { id: 'owned-app', name: appName };
      } else if (url.pathname === '/v1/apps/' + appName) {
        if (method === 'DELETE') { if (!deferDelete) { app = false; if (!retainImage) image = false; } status = 202; }
        else { status = app ? 200 : 404; value = { id: 'owned-app', name: appName, organization: { slug: organizationSlug }, machine_count: machine ? 1 : 0, volume_count: 0 }; }
      } else if (url.pathname.endsWith('/machines') && method === 'POST') {
        machine = true;
        if (loseCreate) throw new Error('private-vendor-detail');
        value = { id: 'builder-one', state: 'started', config: { metadata: { 'happier.preparation': operationId } } };
      } else if (url.pathname.endsWith('/machines')) {
        value = machine ? [{ id: 'builder-one', state: 'started', config: { metadata: { 'happier.preparation': operationId } } }] : [];
      } else if (url.pathname.endsWith('/machines/builder-one')) {
        if (method === 'DELETE') { machine = false; status = 202; }
        else { status = machine ? 200 : 404; value = { id: 'builder-one', state: 'started', config: { metadata: { 'happier.preparation': operationId } } }; }
      } else if (url.pathname.endsWith('/exec')) {
        const command = body?.command as string[];
        const destination = command?.join(' ').match(/base64 -d >> '([^']+)'/)?.[1];
        if (destination && typeof body?.stdin === 'string') {
          if (splitUploads && body.stdin.length > 1024) { status = 413; value = { status: 'exec_request_too_large' }; }
          else { uploads.set(destination, [...uploads.get(destination) ?? [], body.stdin]); }
        }
        if (command?.join(' ').includes('nohup')) {
          state = 'running';
          if (loseLaunch) throw new Error('private-vendor-detail');
        }
        if (status === 200) value = { exit_code: 0, stdout: command?.join(' ').includes('status') ? state : '', stderr: 'private-vendor-detail' };
      } else if (!url.pathname.endsWith('/wait')) throw new Error('Unexpected native path: ' + url.pathname);
      return { status, finalUrl: request.url, headers, body: new TextEncoder().encode(JSON.stringify(value)) };
    } },
  } } as unknown as PluginAccountActionContext;
  async function run(id: string, input: unknown) {
    const handler = handlers.get(id);
    expect(handler, 'preparation must be reachable through the real public Action').toBeTypeOf('function');
    return await handler!(input, context) as { kind: string; nativeOperationRef?: { value: unknown }; artifact?: { value: unknown } };
  }
  return { run, calls, uploads, finish() { image = true; state = '0'; machine = false; }, fail() { state = '1'; },
    loseCreate() { loseCreate = true; }, loseLaunch() { loseLaunch = true; }, deferDelete() { deferDelete = true; }, wrongOrganization() { organizationSlug = 'other-org'; },
    denyRegistry() { registryStatus = 401; },
    retainImage() { retainImage = true; },
    splitUploads() { splitUploads = true; },
    get machinePresent() { return machine; }, get appPresent() { return app; } };
}

describe('Fly prepared image public native boundary', () => {
  it('builds a clean native image, maps its digest into launch, and removes only its owned builder and registry app', async () => {
    const f = await fixture();
    expect(MACHINE_PROVISIONER).toHaveProperty('preparation');
    const built = await f.run('prepare-build', buildInput);
    expect(built.kind).toBe('pending');
    f.finish();
    const beforeInspect = f.calls.length;
    const ready = await f.run('prepare-inspect', { nativeOperation: built.nativeOperationRef });
    expect(ready).toMatchObject({ kind: 'ready', artifact: { value: { launch: { ...launch, imageReference: `registry.fly.io/${appName}@${digest}` } } } });
    expect(f.machinePresent).toBe(false);
    expect(f.appPresent).toBe(true);
    expect(f.calls.slice(beforeInspect).every(call => call.request.method === 'GET')).toBe(true);
    const uploadedText = f.calls.filter(call => call.body?.stdin).map(call => Buffer.from(String(call.body?.stdin), 'base64').toString()).join('\n');
    expect(uploadedText).toContain('FROM --platform=linux/amd64 ubuntu:24.04');
    expect(uploadedText).toContain('apt-get update');
    const dockerfile = (f.uploads.get('/tmp/happier-preparation/context/Dockerfile') ?? []).map(chunk => Buffer.from(chunk, 'base64').toString()).join('');
    const registryAuth = Buffer.from('x:private-registry-token').toString('base64');
    expect(dockerfile).not.toContain(registryAuth);
    expect(dockerfile).not.toContain('/auth/');
    expect(f.calls.find(call => call.request.method === 'POST' && call.request.url.endsWith('/machines'))?.body)
      .toMatchObject({ config: { auto_destroy: true, mounts: [] } });
    expect(f.calls.filter(call => call.body?.config).every(call => !JSON.stringify(call.body?.config).includes('private-registry-token'))).toBe(true);
    expect(f.calls.every(call => !JSON.stringify(call.body?.command ?? []).includes('private-registry-token'))).toBe(true);
    expect(f.calls.every(call => !JSON.stringify(call.body?.command ?? []).includes(registryAuth))).toBe(true);
    expect(JSON.stringify(ready)).not.toMatch(/private-/);
    expect(await f.run('prepare-destroy', { artifact: ready.artifact })).toEqual({ kind: 'confirmed' });
    expect(f.appPresent).toBe(false);
    expect(f.calls.filter(call => call.request.method === 'DELETE').map(call => new URL(call.request.url).pathname))
      .toEqual([`/v1/apps/${appName}`]);
    expect(f.calls.some(call => new URL(call.request.url).origin === 'https://registry.fly.io' && call.request.credentialBinding)).toBe(true);
  });

  it('recovers a lost native build response by operation identity without issuing another create', async () => {
    const f = await fixture(); f.loseLaunch();
    const built = await f.run('prepare-build', buildInput);
    expect(built.kind).toBe('unknown');
    f.finish();
    expect(await f.run('prepare-inspect', { operationId, launch })).toMatchObject({ kind: 'ready' });
    expect(f.calls.filter(call => call.request.method === 'POST' && call.request.url.endsWith('/machines'))).toHaveLength(1);
  });

  it('cleans a lost Machine-create response whose build was never dispatched', async () => {
    const f = await fixture(); f.loseCreate();
    const built = await f.run('prepare-build', buildInput);
    expect(built.kind).toBe('unknown');
    expect(await f.run('prepare-inspect', { operationId, launch })).toMatchObject({ kind: 'failed', code: 'fly_preparation_build_not_started' });
    expect(await f.run('prepare-destroy', { nativeOperation: built.nativeOperationRef })).toEqual({ kind: 'confirmed' });
    expect(f.machinePresent).toBe(false);
    expect(f.calls.filter(call => call.request.method === 'POST' && call.request.url.endsWith('/machines'))).toHaveLength(1);
  });

  it('keeps failed builds unusable and retains asynchronous deletion until app and image absence', async () => {
    const f = await fixture();
    const built = await f.run('prepare-build', buildInput); f.fail();
    expect(await f.run('prepare-inspect', { nativeOperation: built.nativeOperationRef })).toMatchObject({ kind: 'failed' });
    f.deferDelete();
    expect(await f.run('prepare-destroy', { nativeOperation: built.nativeOperationRef })).toMatchObject({ kind: 'pending' });
  });

  it('refuses cleanup of a native app outside the captured organization', async () => {
    const f = await fixture();
    const built = await f.run('prepare-build', buildInput); f.wrongOrganization();
    expect(await f.run('prepare-destroy', { nativeOperation: built.nativeOperationRef })).toMatchObject({ kind: 'refused' });
    expect(f.calls.some(call => call.request.method === 'DELETE')).toBe(false);
  });

  it('retains cleanup as unknown when a deleted app loses registry authorization', async () => {
    const f = await fixture();
    const built = await f.run('prepare-build', buildInput); f.finish(); f.denyRegistry();
    expect(await f.run('prepare-destroy', { nativeOperation: built.nativeOperationRef }))
      .toMatchObject({ kind: 'unknown', code: 'fly_preparation_http_401', nativeOperationRef: built.nativeOperationRef });
    expect(f.appPresent).toBe(false);
  });

  it('does not confirm app deletion while its exact prepared manifest remains', async () => {
    const f = await fixture();
    const built = await f.run('prepare-build', buildInput); f.finish();
    const ready = await f.run('prepare-inspect', { nativeOperation: built.nativeOperationRef });
    f.retainImage();
    expect(await f.run('prepare-destroy', { artifact: ready.artifact })).toMatchObject({ kind: 'pending' });
    expect(f.appPresent).toBe(false);
    expect(f.calls.at(-1)?.request.url).toContain(encodeURIComponent(digest));
  });

  it('uses the existing credential owner for private registry stdin and Basic manifest reads', async () => {
    const context = { signal: new AbortController().signal, configuration: { values: { organizationSlug: 'selected-org' } },
      credentials: { get: async () => 'FlyV1 private-registry-token' } } as unknown as ConnectedAccountReadContext;
    const headers = await connectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://registry.fly.io', headerNames: ['authorization'] }, context);
    expect(headers.kind).toBe('httpHeaders');
    if (headers.kind !== 'httpHeaders') throw new Error('Registry credential unavailable');
    expect(new Headers(headers.headers).get('authorization')).toBe('Basic ' + Buffer.from('x:private-registry-token').toString('base64'));
    expect(await connectedAccountRuntime.materialize({ kind: 'environment', keys: ['FLY_REGISTRY_TOKEN'] }, context))
      .toEqual({ kind: 'environment', env: { FLY_REGISTRY_TOKEN: 'FlyV1 private-registry-token' } });
  });

  it('preserves all CLI bytes after the vendor explicitly rejects an oversized exec before execution', async () => {
    const f = await fixture(); f.splitUploads();
    const bytes = Buffer.from('portable-cli-bytes'.repeat(1000));
    expect(await f.run('prepare-build', { ...buildInput, input: { ...buildInput.input, cli: { ...buildInput.input.cli,
      files: [{ path: 'cli', contentsBase64: bytes.toString('base64') }] } } })).toMatchObject({ kind: 'pending' });
    const accepted = f.uploads.get('/tmp/happier-preparation/context/cli') ?? [];
    expect(accepted.length).toBeGreaterThan(1);
    expect(Buffer.concat(accepted.map(chunk => Buffer.from(chunk, 'base64')))).toEqual(bytes);
  });
});

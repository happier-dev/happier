import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest, HttpResponse } from '@happier-dev/plugin-sdk/http';
import { DOCKER_SANDBOXES_PLUGIN } from '../manifest.js';
import { DOCKER_ACCOUNT_SERVICE } from '../machine/dockerAccount.js';
import { sandboxFixture, endpointCredentialFixture, conflictFixture } from './fixtures.js';
import { createCloudClient, type CloudContext } from './nativeClient.js';
import { createCloudPreparation } from './preparation.js';

const resource = { sandboxName: sandboxFixture.name };
const launch = { imageRef: 'ubuntu:24.04', cpus: 2, memoryMib: 4096, timeoutSeconds: 3600 };
const json = (value: unknown, status = 200) => ({ status, body: new TextEncoder().encode(JSON.stringify(value)), headers: { 'content-type': 'application/json' } });
function vendor(options: { loseCreate?: boolean; createStatus?: number; pending?: boolean; deleteStatus?: number; refusal?: number; mismatch?: boolean;
  snapshotPending?: boolean; loseSnapshot?: boolean; setupFailed?: boolean; emptyList?: boolean } = {}) {
  const requests: HttpRequest[] = [];
  const run = vi.fn(); const dependency = vi.fn(); let status = options.pending ? 'creating' : 'running';
  let snapshotName: string | undefined; let snapshotDisplayName: string | undefined;
  const snapshot = () => ({ name: snapshotName, uid: 'prepared-fixture', status: options.snapshotPending ? 'creating' : 'ready',
    etag: '"snapshot-etag"', displayName: snapshotDisplayName, sandbox: sandboxFixture.name, createdAt: '2026-11-15T17:00:00Z' });
  const http = vi.fn(async (request: HttpRequest): Promise<HttpResponse> => {
    requests.push(request); const url = new URL(request.url);
    if (url.hostname === 'hub.docker.com') return { ...json({ access_token: 'fixture-management-token' }), finalUrl: request.url };
    const response = (() => {
      if (options.refusal) return json({ code: 'permissionDenied', message: 'private fixture-scoped-token' }, options.refusal);
      if (url.pathname.endsWith('/snapshots') && request.method === 'POST') {
        snapshotDisplayName = JSON.parse(new TextDecoder().decode(request.body)).displayName;
        snapshotName = 'snapshots/prepared-fixture';
        if (options.loseSnapshot) throw new Error('private snapshot response lost');
        return json(snapshot(), options.snapshotPending ? 202 : 201);
      }
      if (url.pathname.endsWith('/snapshots')) return json({ snapshots: snapshotName ? [snapshot()] : [] });
      if (url.pathname.includes('/snapshots/')) {
        if (url.pathname.endsWith('/restore')) return json(sandboxFixture, 201);
        if (request.method === 'DELETE') { snapshotName = undefined; return { status: 204, headers: {}, body: new Uint8Array() }; }
        return snapshotName ? json(snapshot()) : json({ code: 'notFound' }, 404);
      }
      if (url.pathname.endsWith('/endpoint-credentials')) return json({ ...endpointCredentialFixture,
        ...(options.mismatch ? { audience: 'other-sandbox' } : {}) });
      if (url.hostname === 'sandbox.invalid') {
        if (url.pathname.endsWith('/files/content')) return { status: 204, headers: {}, body: new Uint8Array() };
        const body = JSON.parse(new TextDecoder().decode(request.body));
        if (body.cmd.includes('credential-free-install')) return json({ exitCode: options.setupFailed ? 1 : 0, stdout: '', stderr: '', incomplete: false });
        const output = body.cmd[0] === 'mktemp' ? '/tmp/private-fixture\n'
          : body.cmd.join(' ').includes('uname') ? 'Linux\nx86_64\n/root\n' : undefined;
        return json({ exitCode: 0, stdout: output === undefined ? '/wA=' : Buffer.from(output).toString('base64'), stderr: 'gA==', incomplete: output === undefined });
      }
      if (request.method === 'DELETE') return { status: options.deleteStatus ?? 204, body: new Uint8Array(), headers: {} };
      if (url.pathname.endsWith('/stop')) { status = 'stopping'; return json({ ...sandboxFixture, core: { ...sandboxFixture.core, status } }, 202); }
      if (url.pathname.endsWith('/sandboxes') && request.method === 'POST') {
        if (options.loseCreate) throw new Error('private fixture-management-token');
        if (options.createStatus === 409) return json(conflictFixture, 409);
        return json({ ...sandboxFixture, core: { ...sandboxFixture.core, status } }, options.pending ? 202 : 201);
      }
      if (url.pathname.endsWith('/sandboxes')) return json(options.emptyList ? {} : { sandboxes: [sandboxFixture], nextPageToken: '' });
      return json({ ...sandboxFixture, core: { ...sandboxFixture.core, status } });
    })();
    return { ...response, finalUrl: request.url };
  });
  // Only real system boundaries (credential store, vendor HTTP, processes and
  // dependency inventory) are substituted; Action admission/schemas stay real.
  const services = { http: { request: http }, exec: { run }, managedServices: { dependencies: { status: dependency } },
    connectedAccounts: { getBinding: async () => ({ account: { service: DOCKER_ACCOUNT_SERVICE, accountId: 'fixture-account' } }),
      materialize: async () => ({ kind: 'environment', env: { DOCKER_ID: 'fixture-user', DOCKER_PAT: 'fixture-pat' } }) },
  } as unknown as PluginTestServicesFixture;
  return { requests, run, dependency, services };
}
async function withVendor(options: Parameters<typeof vendor>[0], test: (h: ReturnType<typeof vendor>, invoke: (id: string, input: unknown) => Promise<unknown>) => Promise<void>) {
  const h = vendor(options);
  const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services: h.services });
  try { await test(h, (id, input) => kit.invokeAction(id, input, { surface: 'plugin' })); }
  finally { await kit.dispose(); }
}
function preparation(h: ReturnType<typeof vendor>) {
  // Same external credential/HTTP fixtures; all native logic remains real.
  return createCloudPreparation(createCloudClient({ signal: new AbortController().signal, invokedAtMs: Date.parse('2026-11-15T17:00:00Z'),
    services: h.services as unknown as CloudContext['services'] }));
}

describe('Docker cloud through registered Actions and vendor HTTP', () => {
  it('accepts an empty account inventory with the optional page array omitted', async () => {
    await withVendor({ emptyList: true }, async (_h, invoke) => {
      expect(await invoke('cloud-check', {})).toMatchObject({ available: true });
    });
  });
  it('does no work on activation; acquires, installs via native bootstrap and reports TTL without sbx', async () => {
    await withVendor({}, async (h, invoke) => {
      expect(h.requests).toHaveLength(0);
      const acquired = await invoke('cloud-acquire', { launch, managedId: 'managed-fixture' });
      expect(acquired).toMatchObject({ kind: 'bound', resource: { origin: 'created', value: resource } });
      expect(await invoke('cloud-bootstrap', { resource })).toMatchObject({ kind: 'native', guestHome: { homeDir: '/root', daemonStartup: 'native-process' } });
      expect(await invoke('cloud-inspect', { resource })).toMatchObject({ availability: 'present', power: 'running', nativeExpiry: Date.parse('2026-11-15T18:00:00Z') });
      const create = h.requests.find(r => r.url.endsWith('/v1/sandboxes') && r.method === 'POST')!;
      expect(new Headers(create.headers).get('authorization')).toBe('Bearer fixture-management-token');
      expect(new Headers(create.headers).get('Idempotency-Key')).toBe('managed-fixture');
      expect(JSON.parse(new TextDecoder().decode(create.body))).toMatchObject({ imageRef: launch.imageRef,
        features: { timeouts: { timeout: '3600s' } }, labels: { 'happier-managed-id': 'managed-fixture' } });
      expect(h.run).not.toHaveBeenCalled(); expect(h.dependency).not.toHaveBeenCalled();
      expect(JSON.stringify(acquired)).not.toContain('token');
    });
  });
  it('uses scoped endpoint credentials for binary IO and never sends the management token or PAT to a guest', async () => {
    await withVendor({}, async (h, invoke) => {
      const result = await invoke('cloud-exec', { resource, argv: ['cat'], inputBase64: '/wA=' });
      expect(result).toMatchObject({ stdoutBase64: '/wA=', stderrBase64: 'gA==', stdoutTruncated: true, stderrTruncated: true,
        termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } } });
      expect(await invoke('cloud-put-file', { resource, guestPath: '/tmp/file', bytesBase64: '/wA=', mode: 384 })).toEqual({ kind: 'confirmed' });
      for (const request of h.requests.filter(r => r.url.startsWith('https://sandbox.invalid/'))) {
        expect(new Headers(request.headers).get('authorization')).toBe('Bearer fixture-scoped-token');
        expect(JSON.stringify(request)).not.toContain('fixture-pat');
        expect(JSON.stringify(request)).not.toContain('fixture-management-token');
      }
      expect(h.requests.filter(r => r.url.includes('/files/content')).every(r => [...r.body ?? []].join() === '255,0')).toBe(true);
    });
  });
  it('keeps a pending create identity and reconciles lost replies without a second POST', async () => {
    await withVendor({ loseCreate: true }, async (h, invoke) => {
      const acquired = await invoke('cloud-acquire', { launch, managedId: 'managed-fixture' });
      expect(acquired).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { managedId: 'managed-fixture', launch } } });
      expect(await invoke('cloud-reconcile', { correlation: { managedId: 'managed-fixture', requestId: 'fixture-request', launch } }))
        .toMatchObject({ kind: 'bound', resource: { value: resource } });
      expect(h.requests.filter(r => r.url.endsWith('/v1/sandboxes') && r.method === 'POST')).toHaveLength(1);
    });
    await withVendor({ pending: true }, async (_h, invoke) => {
      expect(await invoke('cloud-acquire', { launch, managedId: 'managed-fixture' })).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { sandboxName: sandboxFixture.name } } });
    });
  });
  it('preserves vendor refusal codes while redacting vendor messages and treats accepted deletion as unsettled', async () => {
    await withVendor({ createStatus: 409 }, async (_h, invoke) => {
      expect(await invoke('cloud-acquire', { launch, managedId: 'managed-fixture' })).toMatchObject({ kind: 'rejected', code: 'docker_cloud_failedPrecondition' });
    });
    await withVendor({ refusal: 403 }, async (_h, invoke) => {
      const result = await invoke('cloud-check', {});
      expect(result).toMatchObject({ available: false, code: 'docker_cloud_permissionDenied' });
      expect(JSON.stringify(result)).not.toContain('fixture-scoped-token');
    });
    await withVendor({ deleteStatus: 202 }, async (h, invoke) => {
      expect(await invoke('cloud-destroy', { resource })).toMatchObject({ kind: 'unknown' });
      expect(new Headers(h.requests.find(r => r.method === 'DELETE')!.headers).get('If-Match')).toBe('"fixture-etag"');
      expect(await invoke('cloud-power', { resource, intent: 'stop' })).toMatchObject({ kind: 'unknown' });
    });
  });
  it('refuses a credential issued for another endpoint before disclosing it', async () => {
    await withVendor({ mismatch: true }, async (h, invoke) => {
      await expect(invoke('cloud-exec', { resource, argv: ['true'] })).rejects.toMatchObject({ code: 'docker_cloud_invalid_response' });
      expect(h.requests.some(r => r.url.startsWith('https://sandbox.invalid/'))).toBe(false);
    });
  });
  it('does not dispatch an allocation when cancellation already won admission', async () => {
    const h = vendor(), cancellation = new AbortController(); cancellation.abort();
    const native = createCloudClient({ signal: cancellation.signal, invokedAtMs: 0,
      services: h.services as unknown as CloudContext['services'] });
    await expect(native.acquire(launch, 'cancelled-fixture')).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.requests).toHaveLength(0);
  });
  it('Prepare builds only a clean owned guest, captures disk, deletes the builder, restores and deletes its artifact', async () => {
    await withVendor({}, async (h, invoke) => {
      const native = preparation(h);
      const ready = await native.build('prepare-fixture', { launch, setupScript: 'credential-free-install' });
      expect(ready).toMatchObject({ kind: 'ready', artifact: { value: { snapshotName: 'snapshots/prepared-fixture' } } });
      const capture = h.requests.find(r => r.method === 'POST' && r.url.endsWith('/snapshots'))!;
      expect(JSON.parse(new TextDecoder().decode(capture.body))).toMatchObject({ captureMode: 'disk' });
      expect(h.requests.some(r => r.method === 'DELETE' && r.url.endsWith('/sandboxes/fixture'))).toBe(true);
      expect(JSON.stringify(ready)).not.toContain('token');
      expect(await invoke('cloud-acquire', { managedId: 'restored-fixture', launch: { snapshotName: 'snapshots/prepared-fixture' } }))
        .toMatchObject({ kind: 'bound', resource: { value: resource } });
      expect(h.requests.some(r => r.url.endsWith('/snapshots/prepared-fixture/restore'))).toBe(true);
      expect(await native.destroy({ operationId: 'prepare-fixture', snapshotName: 'snapshots/prepared-fixture', phase: 'destroying' })).toEqual({ kind: 'confirmed' });
    });
  });
  it('Prepare retains unknown capture identity for inspection without another build; failed setup never becomes usable', async () => {
    await withVendor({ loseSnapshot: true }, async (h, invoke) => {
      const native = preparation(h);
      const result = await native.build('prepare-fixture', { launch, setupScript: 'credential-free-install' });
      expect(result).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { operationId: 'prepare-fixture' } } });
      if (!('nativeOperationRef' in result)) throw new Error('Expected retained build operation');
      expect(await native.inspect(result.nativeOperationRef.value))
        .toMatchObject({ kind: 'ready' });
      expect(h.requests.filter(r => r.method === 'POST' && r.url.endsWith('/snapshots'))).toHaveLength(1);
    });
    await withVendor({ setupFailed: true }, async (h, invoke) => {
      expect(await preparation(h).build('prepare-fixture', { launch, setupScript: 'credential-free-install' }))
        .toMatchObject({ kind: 'unknown', code: 'docker_cloud_setup_failed' });
      expect(h.requests.some(r => r.method === 'POST' && r.url.endsWith('/snapshots'))).toBe(false);
    });
  });
  it('Prepare keeps a creating snapshot unusable and cancellation deletes the owned snapshot and builder', async () => {
    await withVendor({ snapshotPending: true }, async (h) => {
      const native = preparation(h);
      const result = await native.build('prepare-fixture', { launch, setupScript: 'credential-free-install' });
      expect(result.kind).toBe('pending');
      if (!('nativeOperationRef' in result)) throw new Error('Expected retained pending snapshot');
      expect(await native.inspect(result.nativeOperationRef.value)).toMatchObject({ kind: 'pending' });
      expect(h.requests.some(r => r.method === 'DELETE')).toBe(false);
      expect(await native.destroy(result.nativeOperationRef.value)).toEqual({ kind: 'confirmed' });
      expect(h.requests.filter(r => r.method === 'DELETE').map(r => new URL(r.url).pathname)).toEqual([
        '/sandboxes/v1/snapshots/prepared-fixture', '/sandboxes/v1/sandboxes/fixture',
      ]);
      expect(h.requests.filter(r => r.method === 'POST' && r.url.endsWith('/snapshots'))).toHaveLength(1);
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest, HttpResponse } from '@happier-dev/plugin-sdk/http';
import { DOCKER_SANDBOXES_PLUGIN } from '../manifest.js';
import { DOCKER_ACCOUNT_SERVICE } from '../machine/dockerAccount.js';
import { sandboxFixture, endpointCredentialFixture, conflictFixture } from './fixtures.js';
import { createCloudClient, type CloudContext } from './nativeClient.js';

const resource = { sandboxName: sandboxFixture.name };
const launch = { imageRef: 'ubuntu:24.04', cpus: 2, memoryMib: 4096, timeoutSeconds: 3600 };
const json = (value: unknown, status = 200) => ({ status, body: new TextEncoder().encode(JSON.stringify(value)), headers: { 'content-type': 'application/json' } });
function vendor(options: { loseCreate?: boolean; createStatus?: number; pending?: boolean; deleteStatus?: number; refusal?: number; mismatch?: boolean;
  emptyList?: boolean; largeInventory?: boolean } = {}) {
  const requests: HttpRequest[] = [];
  const run = vi.fn(); const dependency = vi.fn(); let status = options.pending ? 'creating' : 'running';
  const http = vi.fn(async (request: HttpRequest): Promise<HttpResponse> => {
    requests.push(request); const url = new URL(request.url);
    if (url.hostname === 'hub.docker.com') return { ...json({ access_token: 'fixture-management-token' }), finalUrl: request.url };
    const response = (() => {
      if (options.refusal) return json({ code: 'permissionDenied', message: 'private fixture-scoped-token' }, options.refusal);
      if (url.pathname.endsWith('/restore')) return json(sandboxFixture, 201);
      if (url.pathname.endsWith('/endpoint-credentials')) return json({ ...endpointCredentialFixture,
        ...(options.mismatch ? { audience: 'other-sandbox' } : {}) });
      if (url.hostname === 'sandbox.invalid') {
        if (url.pathname.endsWith('/files/content')) return { status: 204, headers: {}, body: new Uint8Array() };
        const body = JSON.parse(new TextDecoder().decode(request.body));
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
      if (url.pathname.endsWith('/sandboxes')) {
        if (options.emptyList) return json({});
        if (!options.largeInventory) return json({ sandboxes: [sandboxFixture] });
        const sandboxes = Array.from({ length: 125 }, (_, index) => ({
          ...sandboxFixture, name: 'sandboxes/other-' + index, uid: 'other-' + index, displayName: 'other-' + index,
        })).concat({ ...sandboxFixture, displayName: 'happier-9faf6c23ca198bab1dd6389f65d065747773421c0fb0b150a0136c9e' });
        const filter = url.searchParams.get('filter');
        const matches = filter ? sandboxes.filter(item => 'display_name=' + item.displayName === filter) : sandboxes;
        const offset = Number(url.searchParams.get('pageToken') ?? 0);
        const pageSize = Number(url.searchParams.get('pageSize') ?? 25);
        return json({ sandboxes: matches.slice(offset, offset + pageSize),
          ...(offset + pageSize < matches.length ? { nextPageToken: String(offset + pageSize) } : {}) });
      }
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

describe('Docker cloud through registered Actions and vendor HTTP', () => {
  it('accepts an empty account inventory with the optional page array omitted', async () => {
    await withVendor({ emptyList: true }, async (_h, invoke) => {
      expect(await invoke('cloud-check', {})).toMatchObject({ available: true });
    });
  });
  it('checks sandbox API access without walking a 126-sandbox inventory', async () => {
    await withVendor({ largeInventory: true }, async (h, invoke) => {
      expect(await invoke('cloud-check', {})).toMatchObject({ available: true });
      const reads = h.requests.filter(r => r.method === 'GET');
      expect(reads).toHaveLength(1);
      expect(new URL(reads[0]!.url).searchParams.get('pageSize')).toBe('1');
    });
  });
  it('recovers a restore by its deterministic name without reading unrelated sandbox pages', async () => {
    await withVendor({ largeInventory: true }, async (h, invoke) => {
      const launch = { snapshotName: 'snapshots/prepared-fixture' };
      expect(await invoke('cloud-reconcile', { correlation: { managedId: 'warm-fixture', requestId: 'fixture-request', launch } }))
        .toMatchObject({ kind: 'bound', resource: { value: resource } });
      expect(h.requests.filter(r => r.method === 'GET')).toHaveLength(1);
    });
  });
  it('does no work on activation; acquires, installs via native bootstrap and reports TTL without sbx', async () => {
    await withVendor({}, async (h, invoke) => {
      expect(h.requests).toHaveLength(0);
      const acquired = await invoke('cloud-acquire', { launch, managedId: 'managed-fixture' });
      expect(acquired).toMatchObject({ kind: 'bound', resource: { origin: 'created', value: resource } });
      expect(await invoke('cloud-bootstrap', { resource })).toMatchObject({ kind: 'native', daemonStartup: 'native-process' });
      expect(await invoke('cloud-inspect', { resource })).toMatchObject({ availability: 'present', power: 'running', nativeExpiry: Date.parse('2026-11-15T18:00:00Z') });
      const create = h.requests.find(r => r.url.endsWith('/v1/sandboxes') && r.method === 'POST')!;
      expect(new Headers(create.headers).get('authorization')).toBe('Bearer fixture-management-token');
      expect(new Headers(create.headers).get('Idempotency-Key')).toBe('managed-fixture');
      expect(JSON.parse(new TextDecoder().decode(create.body))).toMatchObject({ imageRef: launch.imageRef,
        platform: { os: 'linux', architecture: 'amd64' },
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
  it('launches the prepared snapshot through native restore without cold image overrides', async () => {
    await withVendor({}, async (h, invoke) => {
      expect(await invoke('cloud-acquire', { launch: { snapshotName: 'snapshots/prepared-fixture' }, managedId: 'warm-fixture' }))
        .toMatchObject({ kind: 'bound', resource: { value: resource } });
      const restore = h.requests.find(r => r.url.endsWith('/snapshots/prepared-fixture/restore'))!;
      expect(JSON.parse(new TextDecoder().decode(restore.body))).toEqual({ displayName: expect.stringMatching(/^happier-[a-f0-9]{56}$/) });
      expect(h.requests.some(r => r.method === 'POST' && r.url.endsWith('/sandboxes'))).toBe(false);
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
      expect(result).toMatchObject({ available: false, code: 'credential_unavailable' });
      expect(JSON.stringify(result)).not.toContain('fixture-scoped-token');
    });
    for (const deleteStatus of [202, 204, 404]) {
      await withVendor({ deleteStatus }, async (h, invoke) => {
        expect(await invoke('cloud-destroy', { resource })).toMatchObject({ kind: 'unknown' });
        expect(new Headers(h.requests.find(r => r.method === 'DELETE')!.headers).get('If-Match')).toBe('"fixture-etag"');
        expect(await invoke('cloud-power', { resource, intent: 'stop' })).toMatchObject({ kind: 'unknown' });
      });
    }
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
});

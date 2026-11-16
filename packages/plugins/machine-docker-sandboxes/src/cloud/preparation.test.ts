import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest, HttpResponse } from '@happier-dev/plugin-sdk/http';
import { DOCKER_SANDBOXES_PLUGIN } from '../manifest.js';
import { DOCKER_ACCOUNT_SERVICE } from '../machine/dockerAccount.js';
import { sandboxFixture, endpointCredentialFixture } from './fixtures.js';

const provider = { pluginId: DOCKER_ACCOUNT_SERVICE.pluginId, localId: 'docker-cloud' };
const launch = { imageRef: 'ubuntu:24.04' };
const build = { operationId: 'prepare-fixture', input: { launch: { provider, schemaVersion: 1, choices: launch },
  cli: { identity: 'fixture-cli', versionId: '0.3-fixture', binaryPath: '/opt/happier/bin/happier',
    installScript: 'install-fixture-cli', files: [{ path: 'cli.tar', contentsBase64: 'AP8=' }] },
  setupScript: 'run-fixture-setup' } };
const ref = <T>(value: T) => ({ contributionRef: provider, schemaVersion: 1, value });
const json = (value: unknown, status = 200) => ({ status, body: new TextEncoder().encode(JSON.stringify(value)), headers: {} });

// Vendor HTTP, the host observation clock and credential store are the only
// replaced boundaries; registered Action schemas and native preparation stay real.
async function fixture(options: { async?: boolean; lostCapture?: boolean; failedSetup?: boolean } = {}) {
  const requests: HttpRequest[] = [];
  let builder = false, builderReady = false, deleting = false;
  let snapshot: { name: string; uid: string; etag: string; status: string; displayName: string; sandbox: string } | undefined;
  const sandbox = () => ({ ...sandboxFixture, core: { ...sandboxFixture.core,
    labels: { 'happier-managed-id': 'prepare-prepare-fixture' }, status: deleting ? 'deleting' : builderReady ? 'running' : 'creating' } });
  const wait = vi.fn(async () => {
    if (deleting) builder = false;
    else if (snapshot) snapshot.status = 'ready';
    else builderReady = true;
  });
  const respond = async (request: HttpRequest): Promise<Omit<HttpResponse, 'finalUrl'>> => {
    requests.push(request);
    const url = new URL(request.url);
    if (url.hostname === 'hub.docker.com') return json({ access_token: 'fixture-management-token' });
    if (url.hostname === 'sandbox.invalid') {
      if (request.method === 'PUT') return json({}, 204);
      const input = JSON.parse(new TextDecoder().decode(request.body));
      return json({ exitCode: options.failedSetup && input.cmd.join(' ').includes('run-fixture-setup') ? 1 : 0,
        stdout: '', stderr: '', incomplete: false });
    }
    if (url.pathname.endsWith('/endpoint-credentials')) return json(endpointCredentialFixture);
    if (url.pathname.endsWith('/sandboxes') && request.method === 'POST') {
      builder = true; builderReady = !options.async; return json(sandbox(), options.async ? 202 : 201);
    }
    if (url.pathname.endsWith('/sandboxes')) return json({ sandboxes: builder ? [sandbox()] : [] });
    if (url.pathname.endsWith('/sandboxes/fixture/snapshots') && request.method === 'POST') {
      const input = JSON.parse(new TextDecoder().decode(request.body));
      snapshot = { name: 'snapshots/prepared-fixture', uid: 'prepared-fixture', etag: '"snapshot-etag"',
        status: options.async ? 'creating' : 'ready', displayName: input.displayName, sandbox: sandboxFixture.name };
      if (options.lostCapture) throw new Error('private transport error');
      return json(snapshot, options.async ? 202 : 201);
    }
    if (url.pathname.endsWith('/snapshots')) return json({ snapshots: snapshot ? [snapshot] : [] });
    if (url.pathname.endsWith('/snapshots/prepared-fixture')) {
      if (request.method === 'DELETE') { snapshot = undefined; return json({}, 204); }
      return snapshot ? json(snapshot) : json({ code: 'notFound' }, 404);
    }
    if (url.pathname.endsWith('/sandboxes/fixture')) {
      if (request.method === 'DELETE') { if (options.async) deleting = true; else builder = false; return json({}, options.async ? 202 : 204); }
      return builder ? json(sandbox()) : json({ code: 'notFound' }, 404);
    }
    throw new Error('Uncharacterized fixture route');
  };
  const http = vi.fn(async (request: HttpRequest): Promise<HttpResponse> => ({ ...await respond(request), finalUrl: request.url }));
  const services = { http: { request: http }, machineProvisioners: { waitForNativeObservation: wait },
    connectedAccounts: { getBinding: async () => ({ account: { service: DOCKER_ACCOUNT_SERVICE, accountId: 'fixture-account' } }),
      materialize: async () => ({ kind: 'environment', env: { DOCKER_ID: 'fixture-user', DOCKER_PAT: 'fixture-pat' } }) },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services });
  return { requests, wait, dispose: () => kit.dispose(),
    invoke: (id: string, input: unknown, signal?: AbortSignal) => kit.invokeAction(id, input, { surface: 'plugin', ...(signal ? { signal } : {}) }) };
}

describe('Docker cloud registered preparation', () => {
  it('finishes asynchronous create, CLI upload/setup, capture and builder cleanup within the admitted build', async () => {
    const h = await fixture({ async: true });
    try {
      const result = await h.invoke('cloud-prepare-build', build);
      expect(result).toMatchObject({ kind: 'ready', artifact: ref({ snapshotName: 'snapshots/prepared-fixture', launch: { snapshotName: 'snapshots/prepared-fixture' } }) });
      expect(h.wait).toHaveBeenCalledTimes(3);
      expect(h.requests.filter(r => r.method === 'POST' && r.url.endsWith('/sandboxes'))).toHaveLength(1);
      expect(h.requests.filter(r => r.method === 'POST' && r.url.endsWith('/snapshots'))).toHaveLength(1);
      const file = h.requests.find(r => r.method === 'PUT')!;
      expect(Buffer.from(file.body!)).toEqual(Buffer.from([0, 255]));
      const commands = h.requests.filter(r => r.url.endsWith('/processes/exec')).map(r => new TextDecoder().decode(r.body)).join('\n');
      expect(commands).toContain('install-fixture-cli');
      expect(commands).toContain('run-fixture-setup');
      expect(JSON.stringify(result)).not.toContain('installScript');
      expect(await h.invoke('cloud-options', launch)).toMatchObject({ base: {
        nativeFacts: { preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: '/opt/happier' } },
      } });
      expect(await h.invoke('cloud-prepare-inspect', { operationId: build.operationId, launch })).toMatchObject({ kind: 'ready' });
      if (!result || typeof result !== 'object' || !('artifact' in result)) throw new Error('Missing prepared artifact');
      expect(await h.invoke('cloud-prepare-destroy', { artifact: result.artifact })).toEqual({ kind: 'confirmed' });
      expect(await h.invoke('cloud-prepare-inspect', { operationId: build.operationId, launch })).toEqual({ kind: 'absent' });
    } finally { await h.dispose(); }
  });
  it('recovery inspection never advances setup, capture or cleanup; retained identities can be deleted', async () => {
    const h = await fixture({ lostCapture: true });
    try {
      expect(await h.invoke('cloud-prepare-build', build)).toMatchObject({ kind: 'unknown' });
      const start = h.requests.length;
      const inspected = await h.invoke('cloud-prepare-inspect', { operationId: build.operationId, launch });
      expect(inspected).toMatchObject({ kind: 'failed', code: 'docker_cloud_cleanup_required', nativeOperationRef: { value: { snapshotName: 'snapshots/prepared-fixture' } } });
      expect(h.requests.slice(start).filter(r => new URL(r.url).hostname !== 'hub.docker.com').every(r => r.method === 'GET')).toBe(true);
      expect(h.wait).not.toHaveBeenCalled();
      if (!inspected || typeof inspected !== 'object' || !('nativeOperationRef' in inspected)) throw new Error('Missing retained cleanup identity');
      expect(await h.invoke('cloud-prepare-destroy', { nativeOperation: inspected.nativeOperationRef })).toEqual({ kind: 'confirmed' });
      expect(await h.invoke('cloud-prepare-inspect', { operationId: build.operationId, launch })).toEqual({ kind: 'absent' });
    } finally { await h.dispose(); }
  });
  it('failed setup never snapshots and still permits recovery of the owned builder', async () => {
    const h = await fixture({ failedSetup: true });
    try {
      expect(await h.invoke('cloud-prepare-build', build)).toMatchObject({ kind: 'unknown', code: 'docker_cloud_setup_failed' });
      expect(h.requests.some(r => r.method === 'POST' && r.url.endsWith('/snapshots'))).toBe(false);
      const inspected = await h.invoke('cloud-prepare-inspect', { operationId: build.operationId, launch });
      expect(inspected).toMatchObject({ kind: 'failed', code: 'docker_cloud_cleanup_required' });
    } finally { await h.dispose(); }
  });
});

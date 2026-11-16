import { PluginError } from '@happier-dev/plugin-sdk';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDaytonaPreparationClient } from './preparation.js';

const operation = { name: 'happier-prepared-operation-one', organizationId: 'org-one', snapshotId: 'snapshot-one' };
const artifact = { ...operation, launch: { snapshot: operation.snapshotId } };
const buildInput = { operationId: 'operation-one', input: {
  launch: { provider: { pluginId: 'happier.machine.daytona', localId: 'daytona' }, schemaVersion: 1, choices: { snapshot: 'selected-base' } },
  cli: { identity: 'public-release:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier',
    installScript: 'set -eu\nprintf "%s\\n" "credential-free CLI"\n', files: [] },
} };
const base = { id: 'base-id', name: 'selected-base', state: 'active', sandboxClass: 'container', ref: 'registry.daytona.io/base@sha256:abc', imageName: 'debian:bookworm-slim' };

// Only the external Daytona HTTP boundary is substituted; state follows the
// v0.231 SnapshotDto/CreateSnapshot contracts captured in the lane's OpenAPI.
function vendor() {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let state = 'building', present = false, loseBuild = false, deferDelete = false;
  let identity = { id: operation.snapshotId, name: operation.name, organizationId: operation.organizationId };
  let selectedBase = base;
  const request: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method, body });
    if (url.pathname === '/api/api-keys/current') return Response.json({ organizationId: 'org-one' });
    if (url.pathname === '/api/object-storage/push-access') return Response.json({ accessKey: 'temporary-key', secret: 'temporary-secret', sessionToken: 'temporary-session',
      storageUrl: 'https://storage.example', organizationId: 'org-one', bucket: 'builds', region: 'us-east-1' });
    if (url.pathname === '/api/snapshots/selected-base') return Response.json(selectedBase);
    if (url.pathname === '/api/snapshots' && method === 'POST') {
      present = true;
      if (loseBuild) throw new Error('private-vendor-detail');
      return Response.json({ ...identity, state, errorReason: 'private-vendor-detail' });
    }
    if (method === 'DELETE') {
      if (deferDelete) state = 'removing'; else present = false;
      // Daytona delete is successful with an empty 200 body.
      return new Response(null, { status: 200 });
    }
    return present ? Response.json({ ...identity, state, errorReason: 'private-vendor-detail' })
      : Response.json({ message: 'not found' }, { status: 404 });
  };
  return { request, calls, setState(value: string) { present = true; state = value; },
    setBase(value: typeof base) { selectedBase = value; },
    setIdentity(value: typeof identity) { identity = value; }, loseBuild() { loseBuild = true; },
    deferDelete() { deferDelete = true; }, disappear() { present = false; } };
}

describe('Daytona credential-free snapshot preparation HTTP boundary', () => {
  it('renders the Linux/x64 CLI on an explicitly targeted native base and projects an active launch artifact', async () => {
    const v = vendor(); v.setState('active');
    const result = await createDaytonaPreparationClient(v.request).build(buildInput);
    expect(result).toEqual({ kind: 'ready', artifact: { contributionRef: { pluginId: 'happier.machine.daytona', localId: 'daytona' }, schemaVersion: 1, value: artifact } });
    expect(v.calls).toMatchObject([
      { path: '/api/api-keys/current', method: 'GET', body: undefined },
      { path: '/api/snapshots/selected-base', method: 'GET', body: undefined },
      { path: '/api/snapshots', method: 'POST', body: { name: operation.name,
        buildInfo: { dockerfileContent: expect.stringContaining('FROM --platform=linux/amd64 ' + base.ref + '\n') } } },
    ]);
    // Recorded outbound HTTP DTO, rather than a duplicated Dockerfile renderer.
    const body = v.calls.at(-1)?.body as { buildInfo: { dockerfileContent: string } };
    expect(body.buildInfo.dockerfileContent).toContain(JSON.stringify(buildInput.input.cli.installScript));
    expect(JSON.stringify(result)).not.toContain('private-vendor-detail');
  });

  it('recovers a lost Action response from the admitted operation identity without a second POST', async () => {
    const v = vendor(); v.loseBuild();
    const client = createDaytonaPreparationClient(v.request);
    await client.build(buildInput);
    v.setState('active');
    expect(await client.inspect({ operationId: buildInput.operationId, launch: buildInput.input.launch.choices }))
      .toMatchObject({ kind: 'ready', artifact: { value: artifact } });
    expect(v.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(v.calls.at(-1)?.path).toBe('/api/snapshots/' + operation.name);
  });

  it.each(['linux-vm', 'windows'])('refuses the unsupported %s base without allocating a replacement', async sandboxClass => {
    const v = vendor(); v.setBase({ ...base, sandboxClass });
    expect(await createDaytonaPreparationClient(v.request).build(buildInput)).toEqual({ kind: 'refused', code: 'daytona_snapshot_base_unsupported' });
    expect(v.calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('leaves a non-active base cold without attempting activation or replacement', async () => {
    const v = vendor(); v.setBase({ ...base, state: 'inactive' });
    expect(await createDaytonaPreparationClient(v.request).build(buildInput)).toEqual({ kind: 'refused', code: 'daytona_snapshot_base_unavailable' });
    expect(v.calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('uploads canonical Home files with temporary storage credentials before the snapshot POST', async () => {
    const v = vendor(); v.setState('active');
    const uploads: { url: string; headers: Headers; body: unknown }[] = [];
    const storageFetch: typeof fetch = async (url, init) => {
      expect(v.calls.some(call => call.method === 'POST')).toBe(false);
      uploads.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body });
      return new Response(null, { status: 200 });
    };
    const result = await createDaytonaPreparationClient(v.request, undefined, { storageFetch }).build({ ...buildInput, input: { ...buildInput.input,
      cli: { ...buildInput.input.cli, files: [{ path: 'happier-cli-payload.tar.gz', contentsBase64: 'AAECAw==' }] } } });
    expect(result).toMatchObject({ kind: 'ready', artifact: { value: artifact } });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.url).toBe('https://storage.example/builds/org-one/e5541bfcfd067564414474f830c03b92/context.tar');
    expect(uploads[0]?.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=temporary-key\//);
    expect(uploads[0]?.headers.get('x-amz-security-token')).toBe('temporary-session');
    const post = v.calls.find(call => call.method === 'POST');
    expect(post?.body).toMatchObject({ buildInfo: { contextHashes: ['e5541bfcfd067564414474f830c03b92'] } });
    expect(JSON.stringify(post)).toContain('COPY');
    expect(JSON.stringify(post)).not.toMatch(/AAECAw==|temporary-secret|temporary-session|temporary-key/);
  });

  it('does not allocate a snapshot after a refused context upload or disclose its response', async () => {
    const v = vendor();
    const storageFetch: typeof fetch = async () => new Response('private-storage-detail', { status: 403 });
    const result = await createDaytonaPreparationClient(v.request, undefined, { storageFetch }).build({ ...buildInput, input: { ...buildInput.input,
      cli: { ...buildInput.input.cli, files: [{ path: 'happier-cli-payload.tar.gz', contentsBase64: 'AAECAw==' }] } } });
    expect(result).toEqual({ kind: 'refused', code: 'daytona_snapshot_context_upload_unavailable' });
    expect(v.calls.some(call => call.method === 'POST')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-storage-detail');
  });

  it.each(['0', '1000'])('runs setup after an exiting CLI install and propagates failure without changing image USER (uid %s)', async uid => {
    const v = vendor();
    await createDaytonaPreparationClient(v.request).build({ ...buildInput, input: { ...buildInput.input,
      cli: { ...buildInput.input.cli, installScript: 'printf CLI; exit 0' }, setupScript: 'printf SETUP; exit 7' } });
    // This is the recorded outbound CreateSnapshot HTTP DTO, consumed as Docker's exec-form RUN.
    const body = v.calls.find(call => call.method === 'POST')?.body as { buildInfo: { dockerfileContent: string } };
    expect(body.buildInfo.dockerfileContent).not.toMatch(/^USER\s/im);
    const run = body.buildInfo.dockerfileContent.split('\n').find(line => line.startsWith('RUN '));
    if (!run) throw new Error('Missing native build effect');
    const argv = JSON.parse(run.slice(4)) as string[];
    const directory = mkdtempSync(join(tmpdir(), 'daytona-root-effect-'));
    try {
      // Substitute only OS identity/privilege adapters. The generated shell and
      // both canonical scripts execute unchanged, without privileged host writes.
      writeFileSync(join(directory, 'id'), '#!/bin/sh\nprintf ' + uid + '\n', { mode: 0o755 });
      writeFileSync(join(directory, 'chmod'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(directory, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] && [ "$2" = -- ] || exit 99\nshift 2\nexec "$@"\n', { mode: 0o755 });
      const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', env: { ...process.env, PATH: directory + ':' + process.env.PATH } });
      expect(result.error).toBeUndefined();
      expect(result.stdout).toBe('CLISETUP');
      expect(result.status).toBe(7);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('retains a lost POST identity and recovers by exact name without purchasing another snapshot', async () => {
    const v = vendor(); v.loseBuild();
    const client = createDaytonaPreparationClient(v.request);
    const result = await client.build(buildInput);
    expect(result).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { name: operation.name, organizationId: 'org-one' } } });
    if (result.kind !== 'unknown') throw new Error('Missing retained uncertain build');
    expect(await client.inspect({ nativeOperation: result.nativeOperationRef.value })).toMatchObject({ kind: 'pending' });
    v.setState('active');
    expect(await client.inspect({ nativeOperation: { name: operation.name } })).toMatchObject({ kind: 'ready', artifact: { value: operation } });
    expect(v.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(v.calls.filter(call => call.path === '/api/snapshots/' + operation.name)).toHaveLength(2);
  });

  it.each(['building', 'pending', 'pulling', 'snapshotting', 'removing'])('never admits %s as a ready snapshot', async state => {
    const v = vendor(); v.setState(state);
    expect(await createDaytonaPreparationClient(v.request).inspect({ nativeOperation: operation })).toMatchObject({ kind: 'pending', nativeOperationRef: { value: operation } });
  });

  // The native adapter does not implement activation. An inactive snapshot has
  // no advancing build event and must settle for the owner's cold fallback.
  it('settles an inactive snapshot as failed while retaining its cleanup identity', async () => {
    const v = vendor(); v.setState('inactive');
    expect(await createDaytonaPreparationClient(v.request).inspect({ nativeOperation: operation })).toMatchObject({
      kind: 'failed', code: 'daytona_snapshot_inactive', nativeOperationRef: { value: operation },
    });
  });

  it('reports an unsupported future native state as unknown with a retained cleanup identity', async () => {
    const v = vendor(); v.setState('future-state');
    expect(await createDaytonaPreparationClient(v.request).inspect({ nativeOperation: operation })).toMatchObject({
      kind: 'unknown', code: 'daytona_snapshot_state_unsupported', nativeOperationRef: { value: operation },
    });
  });

  it.each(['error', 'build_failed'])('retains failed %s builds for cleanup without vendor log disclosure', async state => {
    const v = vendor(); v.setState(state);
    const result = await createDaytonaPreparationClient(v.request).inspect({ nativeOperation: operation });
    expect(result).toMatchObject({ kind: 'failed', code: 'daytona_snapshot_' + state, nativeOperationRef: { value: operation } });
    expect(JSON.stringify(result)).not.toContain('private-vendor-detail');
  });

  it('retains a paid build identity when POST reports an unexpected snapshot identity', async () => {
    const v = vendor(); v.setState('active');
    v.setIdentity({ id: operation.snapshotId, name: 'unexpected-name', organizationId: operation.organizationId });
    expect(await createDaytonaPreparationClient(v.request).build(buildInput)).toMatchObject({
      kind: 'unknown', code: 'daytona_snapshot_identity_mismatch',
      nativeOperationRef: { value: { name: operation.name, organizationId: operation.organizationId } },
    });
    expect(v.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it.each(['error', 'build_failed'])('retains a native operation when POST immediately reports %s', async state => {
    const v = vendor(); v.setState(state);
    const result = await createDaytonaPreparationClient(v.request).build(buildInput);
    expect(result).toMatchObject({ kind: 'unknown', code: 'daytona_snapshot_' + state, nativeOperationRef: { value: operation } });
    expect(await createDaytonaPreparationClient(v.request).destroy({ nativeOperation: operation })).toEqual({ kind: 'confirmed' });
  });

  it.each(['id', 'name', 'organizationId'] as const)('refuses deletion when native %s differs from the owned reference', async field => {
    const v = vendor(); v.setState('active');
    v.setIdentity({ id: operation.snapshotId, name: operation.name, organizationId: operation.organizationId, [field]: 'somebody-else' });
    expect(await createDaytonaPreparationClient(v.request).destroy({ artifact })).toMatchObject({ kind: 'refused', code: 'daytona_snapshot_identity_mismatch' });
    expect(v.calls.some(call => call.method === 'DELETE')).toBe(false);
  });

  it('refuses a retained organization from another account without touching its snapshot', async () => {
    const v = vendor(); v.setState('active');
    expect(await createDaytonaPreparationClient(v.request).destroy({ nativeOperation: { ...operation, organizationId: 'org-other' } })).toMatchObject({ kind: 'refused', code: 'daytona_snapshot_identity_mismatch' });
    expect(v.calls.map(call => call.path)).toEqual(['/api/api-keys/current']);
  });

  it('confirms cancellation cleanup only after absence and follows removing state without repeating DELETE', async () => {
    const v = vendor(); v.setState('building'); v.deferDelete();
    const client = createDaytonaPreparationClient(v.request);
    expect(await client.destroy({ nativeOperation: { name: operation.name } })).toMatchObject({ kind: 'pending', nativeOperationRef: { value: operation } });
    expect(await client.destroy({ nativeOperation: operation })).toMatchObject({ kind: 'pending' });
    expect(v.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    v.disappear();
    expect(await client.destroy({ nativeOperation: operation })).toEqual({ kind: 'confirmed' });
  });

  it('accepts an empty successful DELETE response and verifies absence with the retained id', async () => {
    const v = vendor(); v.setState('build_failed');
    expect(await createDaytonaPreparationClient(v.request).destroy({ artifact })).toEqual({ kind: 'confirmed' });
    expect(v.calls.map(call => [call.method, call.path])).toEqual([
      ['GET', '/api/api-keys/current'], ['GET', '/api/snapshots/snapshot-one'],
      ['DELETE', '/api/snapshots/snapshot-one'], ['GET', '/api/snapshots/snapshot-one'],
    ]);
  });

  it('retains an interrupted build for cleanup with a new cancellation signal', async () => {
    const v = vendor(), controller = new AbortController();
    const request: typeof fetch = async (input, init) => {
      expect(init?.signal).toBe(controller.signal);
      const result = await v.request(input, init);
      if (init?.method === 'POST') { controller.abort(); throw controller.signal.reason; }
      return result;
    };
    const result = await createDaytonaPreparationClient(request, controller.signal).build(buildInput);
    expect(result).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { name: operation.name } } });
    if (result.kind !== 'unknown') throw new Error('Missing retained interrupted build');
    expect(await createDaytonaPreparationClient(v.request).destroy({ nativeOperation: result.nativeOperationRef.value })).toEqual({ kind: 'confirmed' });
  });

  it('preserves typed plugin boundary failures rather than relabeling them unknown', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Reconnect the account' });
    const request: typeof fetch = async () => { throw refusal; };
    const client = createDaytonaPreparationClient(request);
    await expect(client.build(buildInput)).rejects.toBe(refusal);
    await expect(client.inspect({ nativeOperation: operation })).rejects.toBe(refusal);
    await expect(client.destroy({ artifact })).rejects.toBe(refusal);
  });

  it.each([401, 403, 429])('retains a typed HTTP %s refusal without exposing its response body', async status => {
    const request: typeof fetch = async () => Response.json({ message: 'private-token' }, { status });
    const result = await createDaytonaPreparationClient(request).build(buildInput);
    expect(result).toEqual({ kind: 'refused', code: status === 429 ? 'daytona_http_429' : 'credential_unavailable' });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
});

import { PluginError } from '@happier-dev/plugin-sdk';
import { MachineProvisionerPreparationBuildResultV1Schema, MachineProvisionerPreparationInspectResultV1Schema,
  MachineProvisionerPreparationDestroyResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as entry from './index.js';

// The external HTTP boundary follows the primary v5 OpenAPI saved in
// .project/tmp/MACH-PREP-CLOUD-C-1115/freestyle/api-openapi.json (2026-11-15).
// Responses below are constructed DTOs from that contract, not live captures.
function vendor() {
  const home = mkdtempSync(join(tmpdir(), 'freestyle-preparation-'));
  const operationId = home.split('/').at(-1)!;
  const name = 'happier-prepared-' + createHash('sha256').update(operationId).digest('hex').slice(0, 46);
  const managedId = name.slice('happier-'.length);
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const uploads: Uint8Array[] = [];
  let builder = false, snapshot = false, loseCreate = false, loseCapture = false, keepBuilder = false, keepSnapshot = false;
  let hideBuilder = false, hideSnapshot = false;
  let snapshotOwner = name;
  let sourceVmId: string | null = 'vm-builder';
  const vm = () => ({ id: 'vm-builder', slug: name, state: 'running', createdAt: '2026-11-16T00:00:00Z',
    updatedAt: '2026-11-16T00:00:00Z', metadata: { 'happier-managed-id': managedId } });
  const image = () => ({ id: 'sh-prepared', slug: snapshotOwner, sourceVmId, public: false,
    createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z', autoDeleteSeconds: 86400, autoDeleteFromPlan: true });
  const missing = () => Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  const request: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const body: Record<string, unknown> | undefined = new Headers(init?.headers).get('content-type') === 'application/json' && init?.body
      ? JSON.parse(await new Response(init.body).text()) : undefined;
    calls.push({ path: url.pathname, method, body });
    if (url.pathname === '/v5/vms' && method === 'POST') {
      if (body?.snapshotId === 'sh-prepared') return Response.json({ ...vm(), id: 'vm-clone', slug: body.slug,
        metadata: body.metadata }, { status: 201 });
      builder = true;
      if (loseCreate) throw new Error('private-lost-create');
      return Response.json(vm(), { status: 201 });
    }
    if (url.pathname === '/v5/vms' && method === 'GET') return Response.json({ vms: [], totalCount: 0 });
    if (url.pathname.endsWith('/exec-await')) {
      const output = spawnSync('sh', ['-c', String(body?.command)], { env: { ...process.env, HOME: home },
        input: typeof body?.stdin === 'string' ? Buffer.from(body.stdin, 'base64') : undefined });
      return Response.json({ statusCode: output.status, stdout: output.stdout.toString(), stderr: output.stderr.toString() });
    }
    if (url.pathname.endsWith('/fs/write')) {
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      uploads.push(bytes);
      writeFileSync(url.searchParams.get('path')!, bytes);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith('/snapshot') && method === 'POST') {
      snapshot = true;
      if (loseCapture) throw new Error('private-lost-capture');
      return Response.json({ snapshotId: 'sh-prepared', snapshot: image(), sourceVmId: 'vm-builder' });
    }
    if (url.pathname.startsWith('/v5/snapshots/')) {
      if (method === 'DELETE') { if (!keepSnapshot) snapshot = false; return new Response(null, { status: 204 }); }
      return snapshot && !hideSnapshot ? Response.json(image()) : missing();
    }
    if (method === 'DELETE') { if (!keepBuilder) builder = false; return new Response(null, { status: 204 }); }
    return builder && !hideBuilder ? Response.json(vm()) : missing();
  };
  const services = { http: { request: async (input: { url: string; method: string; headers?: Record<string, string>; body?: Uint8Array }) => {
    const response = await request(input.url, { method: input.method, headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }) });
    return { finalUrl: input.url, status: response.status, headers: {}, body: new Uint8Array(await response.arrayBuffer()) };
  } } } as unknown as PluginTestServicesFixture;
  const input = { operationId, input: { launch: { provider: { pluginId: 'happier.machine.freestyle', localId: 'freestyle' },
    schemaVersion: 1, choices: { snapshotId: 'freestyle/ubuntu' } }, cli: { identity: 'home:0.3-test', versionId: '0.3.0',
      binaryPath: join(home, 'installed'), installScript: 'printf CLI > ' + JSON.stringify(join(home, 'installed'))
        + '; chmod +x ' + JSON.stringify(join(home, 'installed')) + '; exit 0',
      files: [{ path: 'payload.bin', contentsBase64: 'AP+A' }] },
    setupScript: 'test "$(cat ' + JSON.stringify(join(home, 'installed')) + ')" = CLI; printf SETUP >> ' + JSON.stringify(join(home, 'installed')) } };
  return { home, name, managedId, input, calls, uploads, services, readFile: (path: string) => readFileSync(path),
    loseCreate() { loseCreate = true; }, loseCapture() { loseCapture = true; },
    hideReads() { hideBuilder = true; hideSnapshot = true; }, revealReads() { hideBuilder = false; hideSnapshot = false; },
    deferBuilderDelete() { keepBuilder = true; }, deferSnapshotDelete() { keepSnapshot = true; },
    changeSnapshotOwner() { snapshotOwner = 'another-image'; }, changeSource() { sourceVmId = 'another-vm'; },
    forgetSource() { sourceVmId = null; },
    cleanup() { rmSync(home, { recursive: true, force: true }); rmSync('/tmp/.' + name, { recursive: true, force: true }); } };
}

describe('Freestyle preparation through public Actions', () => {
  it('builds a fresh credential-free VM, uploads bytes, runs setup after install, cleans its builder and launches from its snapshot', async () => {
    const v = vendor();
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const result = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', v.input, { surface: 'plugin' }));
      expect(result).toMatchObject({ kind: 'ready', artifact: { value: { snapshotId: 'sh-prepared', launch: { snapshotId: 'sh-prepared' } } } });
      expect(v.readFile(join(v.home, 'installed')).toString()).toBe('CLISETUP');
      expect(v.uploads).toEqual([new Uint8Array([0, 255, 128])]);
      expect(v.calls.filter(call => call.method === 'POST' && call.path === '/v5/vms')).toHaveLength(1);
      expect(v.calls.find(call => call.path.endsWith('/snapshot'))?.body).toMatchObject({ slug: v.name });
      expect(v.calls.filter(call => call.method === 'DELETE')).toEqual([{ path: '/v5/vms/vm-builder', method: 'DELETE', body: undefined }]);
      expect(v.calls.at(-1)).toMatchObject({ method: 'GET', path: '/v5/vms/vm-builder' });
      if (result.kind !== 'ready') throw new Error('Missing prepared artifact');
      v.forgetSource();
      const inspected = MachineProvisionerPreparationInspectResultV1Schema.parse(await kit.invokeAction('prepare-inspect', { operationId: v.input.operationId,
        launch: v.input.input.launch.choices }, { surface: 'plugin' }));
      expect(inspected).toMatchObject({ kind: 'ready' });
      const launch = result.artifact.value as { launch: { snapshotId: string } };
      expect(await kit.invokeAction('acquire', { launch: launch.launch, managedId: 'clone' }, { surface: 'plugin' })).toMatchObject({ kind: 'bound' });
      expect(v.calls.filter(call => call.path === '/v5/vms').at(-1)?.body).toMatchObject({ snapshotId: 'sh-prepared' });
      expect(MachineProvisionerPreparationDestroyResultV1Schema.parse(await kit.invokeAction('prepare-destroy', { artifact: result.artifact }, { surface: 'plugin' }))).toEqual({ kind: 'confirmed' });
      expect(v.calls.at(-1)).toMatchObject({ method: 'GET', path: '/v5/snapshots/sh-prepared' });
    } finally { await kit.dispose(); v.cleanup(); }
  });

  it.each(['create', 'capture'])('recovers a lost %s response in a new invocation without purchasing again', async phase => {
    const v = vendor(); if (phase === 'create') v.loseCreate(); else v.loseCapture();
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const result = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', v.input, { surface: 'plugin' }));
      expect(result).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { name: v.name } } });
      const recovered = MachineProvisionerPreparationInspectResultV1Schema.parse(await kit.invokeAction('prepare-inspect',
        phase === 'create' && result.kind === 'unknown' ? { nativeOperation: result.nativeOperationRef }
          : { operationId: v.input.operationId, launch: v.input.input.launch.choices }, { surface: 'plugin' }));
      expect(recovered).toMatchObject({ kind: phase === 'create' ? 'failed' : 'ready' });
      expect(v.calls.filter(call => call.method === 'POST' && call.path === '/v5/vms')).toHaveLength(1);
      const reference = recovered.kind === 'ready' ? { artifact: recovered.artifact }
        : recovered.kind === 'failed' ? { nativeOperation: recovered.nativeOperationRef } : null;
      if (!reference) throw new Error('Missing retained cleanup identity');
      expect(await kit.invokeAction('prepare-destroy', reference, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(JSON.stringify(result)).not.toContain('private-');
    } finally { await kit.dispose(); v.cleanup(); }
  });

  it('retains a failed setup for cleanup and never captures it', async () => {
    const v = vendor();
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const result = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build',
        { ...v.input, input: { ...v.input.input, setupScript: 'printf "package install failed\\nAuthorization: Bearer secret-test-token\\n" >&2; exit 9' } }, { surface: 'plugin' }));
      expect(result).toMatchObject({ kind: 'unknown', code: 'freestyle_preparation_setup_failed',
        nativeCause: { localCause: 'native_command_failed', command: 'run', exitCode: 9 } });
      expect(JSON.stringify(result)).not.toContain('package install failed');
      expect(JSON.stringify(result)).not.toContain('secret-test-token');
      expect(v.calls.some(call => call.path.endsWith('/snapshot'))).toBe(false);
      if (result.kind !== 'unknown') throw new Error('Missing cleanup identity');
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: result.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
    } finally { await kit.dispose(); v.cleanup(); }
  });

  it.each(['create', 'capture'])('retains an unresolved %s effect when immediate recovery reads return 404', async phase => {
    const v = vendor(); if (phase === 'create') v.loseCreate(); else v.loseCapture();
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const built = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', v.input, { surface: 'plugin' }));
      if (built.kind !== 'unknown') throw new Error('Missing unresolved operation');
      v.hideReads();
      expect(await kit.invokeAction('prepare-inspect', { nativeOperation: built.nativeOperationRef }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { name: v.name } } });
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: built.nativeOperationRef }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { name: v.name } } });
      expect(await kit.invokeAction('prepare-inspect', { operationId: v.input.operationId, launch: v.input.input.launch.choices }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { name: v.name } } });
      v.revealReads();
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: built.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
    } finally { await kit.dispose(); v.cleanup(); }
  });

  it.each(['builder', 'snapshot'])('waits for verified %s absence before confirming cleanup', async phase => {
    const v = vendor(); if (phase === 'builder') v.deferBuilderDelete();
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const result = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', v.input, { surface: 'plugin' }));
      if (phase === 'builder') expect(result).toMatchObject({ kind: 'pending' });
      else {
        v.deferSnapshotDelete();
        if (result.kind !== 'ready') throw new Error('Missing prepared artifact');
        expect(await kit.invokeAction('prepare-destroy', { artifact: result.artifact }, { surface: 'plugin' })).toMatchObject({ kind: 'pending' });
      }
    } finally { await kit.dispose(); v.cleanup(); }
  });

  it.each(['snapshot', 'source'])('refuses deletion of a mismatching %s identity', async field => {
    const v = vendor();
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const result = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', v.input, { surface: 'plugin' }));
      if (result.kind !== 'ready') throw new Error('Missing prepared artifact');
      if (field === 'snapshot') v.changeSnapshotOwner(); else v.changeSource();
      const before = v.calls.length;
      expect(await kit.invokeAction('prepare-destroy', { artifact: result.artifact }, { surface: 'plugin' })).toMatchObject({ kind: 'refused', code: 'freestyle_snapshot_identity_mismatch' });
      expect(v.calls.slice(before).some(call => call.method === 'DELETE')).toBe(false);
    } finally { await kit.dispose(); v.cleanup(); }
  });

  it('preserves typed credential boundary errors and redacts native response bodies', async () => {
    const v = vendor(), refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Reconnect account' });
    const services = { http: { request: async () => { throw refusal; } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
    try { await expect(kit.invokeAction('prepare-build', v.input, { surface: 'plugin' })).rejects.toMatchObject({ data: refusal.data }); }
    finally { await kit.dispose(); v.cleanup(); }
    const refused = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: {
      http: { request: async (input: { url: string }) => ({ status: 403, finalUrl: input.url, headers: {}, body: new TextEncoder().encode('private-token') }) },
    } as unknown as PluginTestServicesFixture });
    try {
      const result = await refused.invokeAction('prepare-build', v.input, { surface: 'plugin' });
      expect(result).toEqual({ kind: 'refused', code: 'credential_unavailable' });
      expect(JSON.stringify(result)).not.toContain('private-token');
    } finally { await refused.dispose(); }
  });
});

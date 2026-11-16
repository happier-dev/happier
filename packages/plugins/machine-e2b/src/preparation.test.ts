import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { PluginError } from '@happier-dev/plugin-sdk';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN, MACHINE_PROVISIONER } from './manifest.js';

const provider = { pluginId: 'happier.machine.e2b', localId: 'e2b' };
const launch = { templateId: 'base', timeoutSeconds: 300 };
const name = 'happier-prepared-operation-one';
const operation = { name, launch, templateId: 'template-one', buildId: 'build-one' };
const reference = <T>(value: T) => ({ contributionRef: provider, schemaVersion: 1, value });
const input = { operationId: 'operation-one', input: {
  launch: { provider, schemaVersion: 1, choices: launch },
  cli: { identity: 'public-release:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier',
    installScript: 'set -eu\ncp payload/cli /opt/happier/cli/happier\n',
    files: [{ path: 'payload/cli', contentsBase64: 'AAEC/w==' }] },
  setupScript: 'printf setup > /tmp/setup-marker',
} };

// Only the E2B HTTP/credential and signed object-storage boundaries are replaced.
// DTOs follow E2B OpenAPI 0.1.0 and the vendor template build SDK (2026-11-16).
function vendor() {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let exists = false, state = 'building', loseReservation = false, loseStart = false, deferredDelete = false;
  let templateId = operation.templateId, names = ['qa-team/' + name], publicTemplate = false;
  let refusal: PluginError | undefined;
  let status = 200, startStatus = 202;
  const template = () => ({ templateID: templateId, buildID: state === 'ready' ? operation.buildId : '00000000-0000-0000-0000-000000000000',
    names, public: publicTemplate, buildStatus: state, builds: [{ buildID: operation.buildId, status: state }] });
  const request: typeof fetch = async (value, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(value)), method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname + url.search, method, body });
    if (refusal) throw refusal;
    if (status !== 200) return Response.json({ message: 'private-vendor-detail' }, { status });
    if (url.pathname === '/v2/sandboxes') return Response.json([]);
    if (url.pathname === '/v3/templates') {
      exists = true; state = 'waiting';
      if (loseReservation) throw new Error('private-vendor-detail');
      return Response.json({ templateID: templateId, buildID: operation.buildId, names, public: false, aliases: [], tags: ['default'] }, { status: 202 });
    }
    if (url.pathname === '/templates/aliases/' + name) return exists
      ? Response.json({ templateID: templateId, public: publicTemplate }) : new Response(null, { status: 404 });
    if (url.pathname.includes('/files/')) return Response.json({ present: false, url: 'https://storage.example/context?signed=private', headers: { 'x-upload': 'signed-upload-header' } }, { status: 201 });
    if (method === 'POST') {
      if (startStatus !== 202) return Response.json({ message: 'private-vendor-detail' }, { status: startStatus });
      state = 'building';
      if (loseStart) throw new Error('private-vendor-detail');
      return new Response(null, { status: 202 });
    }
    if (method === 'DELETE') {
      if (!deferredDelete) exists = false;
      return new Response(null, { status: 204 });
    }
    if (!exists) return Response.json({ message: 'not found' }, { status: 404 });
    if (url.pathname.endsWith('/status')) return Response.json({ templateID: templateId, buildID: operation.buildId, status: state,
      logs: [], logEntries: [{ message: 'private-vendor-detail' }], reason: { message: 'private-vendor-detail' } });
    return Response.json(template());
  };
  const uploads: { bytes: Uint8Array; headers: Headers }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_value, init) => {
    uploads.push({ bytes: new Uint8Array(await new Response(init?.body).arrayBuffer()), headers: new Headers(init?.headers) });
    return new Response(null, { status: 200 });
  });
  const services = {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { 'x-api-key': 'private-api-key' } }) },
    http: { request: async (req: { url: string; method: string; headers: Record<string, string>; body?: Uint8Array; signal?: AbortSignal }) => {
      const response = await request(req.url, { method: req.method, headers: req.headers, signal: req.signal,
        ...(req.body ? { body: new TextDecoder().decode(req.body) } : {}) });
      return { finalUrl: req.url, status: response.status, headers: Object.fromEntries(response.headers), body: new Uint8Array(await response.arrayBuffer()) };
    } },
  } as unknown as PluginTestServicesFixture;
  return { calls, uploads, services, setState(value: string) { exists = true; state = value; },
    loseReservation() { loseReservation = true; }, loseStart() { loseStart = true; }, deferDelete() { deferredDelete = true; },
    identity(value: string, valueNames = names) { templateId = value; names = valueNames; },
    makePublic() { publicTemplate = true; }, disappear() { exists = false; },
    refuse(error?: PluginError) { refusal = error; }, httpStatus(value: number) { status = value; }, failStart(value: number) { startStatus = value; } };
}

afterEach(() => vi.restoreAllMocks());
describe('E2B native preparation through admitted public Actions', () => {
  it('builds from the selected clean template, uploads binary CLI files, installs once, and preserves setup', async () => {
    const v = vendor();
    const kit = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN, services: v.services });
    try {
      expect(await kit.invokeAction('options', {}, { surface: 'plugin' })).toMatchObject({ dimensions: { image: [{ nativeFacts: {
        preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: '/opt/happier' },
      } }] } });
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toEqual({ kind: 'pending', nativeOperationRef: reference(operation) });
      expect(v.calls.filter(call => call.method === 'POST')).toEqual([
        { path: '/v3/templates', method: 'POST', body: { name } },
        { path: '/v2/templates/template-one/builds/build-one', method: 'POST', body: {
          fromTemplate: 'base', steps: [
            { type: 'COPY', args: ['.', expect.any(String), 'root', ''], filesHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
            { type: 'RUN', args: [expect.stringContaining(input.input.cli.installScript.replaceAll("'", "'\\''")), 'root'] },
          ],
        } },
      ]);
      expect(v.uploads).toHaveLength(1);
      expect(v.uploads[0]!.headers.get('x-upload')).toBe('signed-upload-header');
      expect(v.uploads[0]!.headers.has('x-api-key')).toBe(false);
      expect(v.uploads[0]!.headers.has('authorization')).toBe(false);
      const dir = mkdtempSync(join(tmpdir(), 'e2b-preparation-'));
      try {
        const archive = join(dir, 'context.tar'); writeFileSync(archive, v.uploads[0]!.bytes);
        expect(spawnSync('tar', ['-xf', archive, '-C', dir]).status).toBe(0);
        expect(readFileSync(join(dir, 'payload/cli'))).toEqual(Buffer.from([0, 1, 2, 255]));
      } finally { rmSync(dir, { recursive: true, force: true }); }
      const started = JSON.stringify(v.calls.at(-1)?.body);
      expect(started).toContain(input.input.setupScript);
      expect(started).not.toContain('private-api-key');
      v.setState('ready');
      expect(await kit.invokeAction('prepare-inspect', { nativeOperation: reference(operation) }, { surface: 'plugin' }))
        .toEqual({ kind: 'ready', artifact: reference({ name, templateId: operation.templateId, buildId: operation.buildId,
          launch: { ...launch, templateId: operation.templateId } }) });
      expect(MACHINE_PROVISIONER.preparation?.artifactLaunchPath).toBe('launch');
    } finally { await kit.dispose(); }
  });

  it.each(['reservation', 'start'] as const)('recovers lost %s and Action responses without another paid POST', async lost => {
    const v = vendor(); lost === 'reservation' ? v.loseReservation() : v.loseStart();
    const kit = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN, services: v.services });
    try {
      const result = await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(result).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { name, launch } } });
      const posts = v.calls.filter(call => call.method === 'POST').length;
      if (lost === 'start') v.setState('ready');
      const recovered = await kit.invokeAction('prepare-inspect', { operationId: input.operationId, launch }, { surface: 'plugin' });
      expect(recovered).toMatchObject(lost === 'start' ? { kind: 'ready', artifact: { value: { templateId: operation.templateId } } }
        : { kind: 'failed', code: 'e2b_template_build_not_started', nativeOperationRef: reference(operation) });
      expect(v.calls.filter(call => call.method === 'POST')).toHaveLength(posts);
      expect(v.calls.some(call => call.path === '/templates/aliases/' + name)).toBe(true);
      expect(v.calls.some(call => call.path.startsWith('/v2/templates?') || call.path === '/v2/templates')).toBe(false);
      expect(JSON.stringify([result, recovered])).not.toContain('private-vendor-detail');
    } finally { await kit.dispose(); }
  });

  it('uses the canonical signed installer without a context upload when the supplier has no files', async () => {
    const v = vendor();
    const kit = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN, services: v.services });
    try {
      expect(await kit.invokeAction('prepare-build', { ...input, input: { ...input.input, cli: { ...input.input.cli, files: [] } } }, { surface: 'plugin' }))
        .toEqual({ kind: 'pending', nativeOperationRef: reference(operation) });
      expect(v.calls.some(call => call.path.includes('/files/'))).toBe(false);
      expect(v.uploads).toHaveLength(0);
      expect(v.calls.filter(call => call.method === 'POST')).toHaveLength(2);
    } finally { await kit.dispose(); }
  });

  it('retains a reserved template after a definite build-start refusal so it can be cleaned up', async () => {
    const v = vendor(); v.failStart(400);
    const kit = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN, services: v.services });
    try {
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }))
        .toEqual({ kind: 'unknown', code: 'e2b_http_400', nativeOperationRef: reference(operation) });
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: reference(operation) }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
    } finally { await kit.dispose(); }
  });

  it('returns a definite authorization refusal before reserving any template', async () => {
    const v = vendor(); v.httpStatus(401);
    const kit = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN, services: v.services });
    try {
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toEqual({ kind: 'refused', code: 'e2b_http_401' });
      expect(v.calls).toEqual([{ path: '/v3/templates', method: 'POST', body: { name } }]);
    } finally { await kit.dispose(); }
  });

  it.each(['building', 'waiting', 'error', 'inactive', 'unexpected'])('never launches a %s native build', async state => {
    const v = vendor(); v.setState(state);
    const kit = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN, services: v.services });
    try {
      expect(await kit.invokeAction('prepare-inspect', { nativeOperation: reference(operation) }, { surface: 'plugin' }))
        .toMatchObject({ kind: state === 'building' ? 'pending' : state === 'waiting' || state === 'error' ? 'failed' : 'unknown' });
    } finally { await kit.dispose(); }
  });

  it('deletes only the retained owned template, confirms native absence, and recovers deletion without allocating', async () => {
    const v = vendor(); v.setState('ready'); v.deferDelete();
    const kit = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN, services: v.services });
    try {
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: reference(operation) }, { surface: 'plugin' }))
        .toEqual({ kind: 'pending', nativeOperationRef: reference(operation) });
      v.disappear();
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: reference(operation) }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(v.calls.filter(call => call.method === 'DELETE')).toEqual([{ path: '/templates/template-one', method: 'DELETE', body: undefined }]);
      expect(v.calls.some(call => call.method === 'POST')).toBe(false);
    } finally { await kit.dispose(); }
  });

  it.each(['id', 'name', 'public'] as const)('does not delete a template with mismatching %s ownership', async mismatch => {
    const v = vendor(); v.setState('ready');
    if (mismatch === 'id') v.identity('foreign');
    if (mismatch === 'name') v.identity(operation.templateId, ['qa-team/base']);
    if (mismatch === 'public') v.makePublic();
    const kit = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN, services: v.services });
    try {
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: reference(operation) }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'refused', code: 'e2b_template_identity_mismatch' });
      expect(v.calls.some(call => call.method === 'DELETE')).toBe(false);
    } finally { await kit.dispose(); }
  });

  it('preserves typed host refusal and observed HTTP codes without leaking provider bodies', async () => {
    const v = vendor(); const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Reconnect account' }); v.refuse(refusal);
    const kit = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN, services: v.services });
    try {
      await expect(kit.invokeAction('prepare-build', input, { surface: 'plugin' })).rejects.toMatchObject({ data: refusal.data });
      v.refuse(); v.httpStatus(503);
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }))
        .toMatchObject({ kind: 'unknown', code: 'e2b_http_503', nativeOperationRef: { value: { name } } });
    } finally { await kit.dispose(); }
  });
});

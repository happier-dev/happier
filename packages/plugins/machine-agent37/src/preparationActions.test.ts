import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import * as entry from './index.js';
import { options } from './machine/options.js';
import { Agent37LaunchSchema } from './machine/schemas.js';
import { projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

const operationId = 'build-one';
const name = 'happier-prepared-' + createHash('sha256').update(operationId).digest('hex').slice(0, 46);
const launch = { kind: 'default', size: '2-4', region: 'us' };
const contributionRef = { pluginId: 'happier.machine.agent37', localId: 'agent37' };
const value = { name, launch, buildId: 'tb_7d3a90b81f264bc2a113' };
const nativeOperation = { contributionRef, schemaVersion: 1, value };
const digest = 'sha256:' + 'a'.repeat(64);
const artifact = { contributionRef, schemaVersion: 1, value: { name, revision: 1, imageDigest: digest, launch: { ...launch, template: name + '@1' } } };
const input = { operationId, input: { launch: { provider: contributionRef, schemaVersion: 1, choices: launch },
  cli: { identity: 'public-release:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier',
    installScript: 'set -eu\nprintf prepared\n', files: [{ path: 'payload.tar.gz', contentsBase64: 'AAECAw==' }] }, setupScript: 'printf setup\n' } };
const response = (status: number, value: unknown) => ({ status, body: new TextEncoder().encode(JSON.stringify(value)) });
function services(request: (input: { url: string; method: string; body?: Uint8Array }) => Promise<ReturnType<typeof response>>): PluginTestServicesFixture {
  // Only the host credential store and vendor HTTP transport are substituted.
  return { connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-key' } }) },
    http: { request: async (input: { url: string; method: string; body?: Uint8Array }) => ({ finalUrl: input.url, headers: {}, ...await request(input) }) },
  } as unknown as PluginTestServicesFixture;
}
function untar(bytes: Uint8Array) {
  const archive = gunzipSync(bytes), files = new Map<string, Buffer>();
  for (let offset = 0; archive[offset];) {
    const text = (start: number, width: number) => archive.subarray(offset + start, offset + start + width).toString().replace(/\0.*$/s, '');
    const prefix = text(345, 155), name = text(0, 100), size = parseInt(text(124, 12), 8);
    files.set((prefix ? prefix + '/' : '') + name, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

describe('Agent37 prepared templates through public Actions', () => {
  it.each(['vm', 'default', 'performance'])('supplies the selected %s image guest target through the existing options owner', image => {
    expect(projectMachineProvisionerSelectionV1({ options: options(), launchSchema: Agent37LaunchSchema.jsonSchema,
      selection: { image, size: '2-4', location: 'us' } })).toMatchObject({ kind: 'ready', enrollmentRole: 'sandbox',
      nativeFacts: { preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: '/opt/happier' } } });
  });
  it('builds a clean uploaded context, pins its ready revision into acquire and verifies logical deletion', async () => {
    let state = 'building', present = true;
    const calls: string[] = [];
    let uploaded: Uint8Array | undefined, declaredBytes = 0;
    const storage = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://uploads.example/context?signed=temporary');
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      expect(init?.method).toBe('PUT');
      uploaded = init?.body as Uint8Array;
      return new Response(null, { status: 200 });
    });
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(async request => {
      const path = new URL(request.url).pathname;
      calls.push(request.method + ' ' + path);
      if (path === '/v1/templates/agent37-base') return response(200, { name: 'agent37-base', scope: 'system', image_ref: 'ghcr.io/agent37-platform/base:2026.11.01' });
      if (path === '/v1/template-builds') {
        const body = JSON.parse(new TextDecoder().decode(request.body));
        declaredBytes = body.size_bytes;
        expect(body).toEqual({ name, size_bytes: expect.any(Number) });
        return response(201, { id: value.buildId, name, status: 'created', upload_url: 'https://uploads.example/context?signed=temporary' });
      }
      if (path.endsWith('/start')) { expect(request.body).toBeUndefined(); return response(200, { id: value.buildId, status: 'building' }); }
      if (path.startsWith('/v1/template-builds/')) return response(200, { id: value.buildId, name, status: state, template: { name, revision: 1, image_digest: digest } });
      if (path === '/v1/instances') {
        expect(JSON.parse(new TextDecoder().decode(request.body))).toMatchObject({ template: name + '@1', type: 'default' });
        return response(201, { id: 'abc123def4', status: 'running' });
      }
      if (request.method === 'DELETE') { present = false; return response(200, { name, deleted: true }); }
      return present ? response(200, { name, scope: 'workspace', revision: 1, image_digest: digest }) : response(404, {});
    }) });
    try {
      expect(entry.MACHINE_PROVISIONER.enrollmentRole).toBe('sandbox');
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toEqual({ kind: 'pending', nativeOperationRef: nativeOperation });
      expect(uploaded?.byteLength).toBe(declaredBytes);
      const files = untar(uploaded!);
      expect([...files.keys()].sort()).toEqual(['Dockerfile', 'payload.tar.gz']);
      expect([...files.get('payload.tar.gz')!]).toEqual([0, 1, 2, 3]);
      const dockerfile = files.get('Dockerfile')!.toString();
      expect(dockerfile).toContain('FROM --platform=linux/amd64 ghcr.io/agent37-platform/base:2026.11.01');
      expect(dockerfile).toMatch(/^USER root\n[\s\S]*^RUN .+\nUSER node$/m);
      expect(dockerfile).toContain(input.input.cli.installScript);
      expect(dockerfile).toContain(JSON.stringify(input.input.setupScript));
      expect(dockerfile).not.toMatch(/fixture-key|signed=temporary|daemon start|session start/);
      state = 'succeeded';
      const ready = await kit.invokeAction('prepare-inspect', { nativeOperation }, { surface: 'plugin' });
      expect(ready).toEqual({ kind: 'ready', artifact });
      expect(await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' })).toEqual(ready);
      expect(await kit.invokeAction('acquire', { launch: artifact.value.launch, managedId: 'managed-one' }, { surface: 'plugin' })).toMatchObject({ kind: 'bound' });
      expect(await kit.invokeAction('prepare-destroy', { artifact }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(calls.filter(call => call.startsWith('POST '))).toEqual(['POST /v1/template-builds', 'POST /v1/template-builds/' + value.buildId + '/start', 'POST /v1/instances']);
      expect(calls.slice(-2)).toEqual(['DELETE /v1/templates/' + name, 'GET /v1/templates/' + name]);
    } finally { storage.mockRestore(); await kit.dispose(); }
  });

  it('keeps unknown build identity recoverable when no published template exists', async () => {
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(async () => response(404, {})) });
    try {
      const recovered = await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' });
      expect(recovered).toEqual({ kind: 'unknown', code: 'agent37_build_identity_unconfirmed', nativeOperationRef: { ...nativeOperation, value: { name, launch } } });
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: { ...nativeOperation, value: { name, launch } } }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'unknown', code: 'agent37_build_identity_unconfirmed' });
    } finally { await kit.dispose(); }
  });

  it.each(['building', 'ingesting'])('retains %s builds until native completion because Agent37 has no build cancellation', async status => {
    const calls: string[] = [];
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(async request => {
      calls.push(request.method); return response(200, { id: value.buildId, name, status });
    }) });
    try {
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation }, { surface: 'plugin' })).toEqual({ kind: 'pending', nativeOperationRef: nativeOperation });
      expect(calls).toEqual(['GET']);
    } finally { await kit.dispose(); }
  });

  it.each(['created', 'failed'])('makes a %s build unusable and confirms cleanup only after template absence', async status => {
    const calls: string[] = [];
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(async request => {
      calls.push(request.method + ' ' + new URL(request.url).pathname);
      return request.url.includes('/template-builds/') ? response(200, { id: value.buildId, name, status,
        error: { code: 'build_timeout', message: 'private-native-log' } }) : response(404, {});
    }) });
    try {
      const result = await kit.invokeAction('prepare-inspect', { nativeOperation }, { surface: 'plugin' });
      expect(result).toMatchObject({ kind: 'failed', code: status === 'failed' ? 'agent37_build_timeout' : 'agent37_build_created', nativeOperationRef: nativeOperation });
      expect(JSON.stringify(result)).not.toContain('private-native-log');
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(calls.at(-1)).toBe('GET /v1/templates/' + name);
      expect(calls.every(call => call.startsWith('GET '))).toBe(true);
    } finally { await kit.dispose(); }
  });

  it.each([
    { name, scope: 'system', revision: 1, image_digest: digest },
    { name, scope: 'workspace', revision: 2, image_digest: digest },
    { name, scope: 'workspace', revision: 1, image_digest: 'sha256:' + 'b'.repeat(64) },
    { name: 'somebody-else', scope: 'workspace', revision: 1, image_digest: digest },
  ])('never deletes a template whose native ownership or published revision differs: %j', async native => {
    const calls: string[] = [];
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(async request => {
      calls.push(request.method); return response(200, native);
    }) });
    try {
      expect(await kit.invokeAction('prepare-destroy', { artifact }, { surface: 'plugin' })).toMatchObject({ kind: 'refused', code: 'agent37_template_identity_mismatch' });
      expect(calls).toEqual(['GET']);
    } finally { await kit.dispose(); }
  });

  it('retains cleanup identity after a build start loses its response without redispatching allocation', async () => {
    let creates = 0;
    const storage = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(async request => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/templates/agent37-base') return response(200, { name: 'agent37-base', scope: 'system', image_ref: 'debian:bookworm-slim' });
      if (path === '/v1/template-builds') { creates++; return response(201, { id: value.buildId, name, status: 'created', upload_url: 'https://uploads.example/context' }); }
      if (path.endsWith('/start')) throw new Error('private-transport-detail');
      return response(200, { id: value.buildId, name, status: 'building' });
    }) });
    try {
      const result = await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      expect(result).toEqual({ kind: 'unknown', code: 'agent37_build_unconfirmed', nativeOperationRef: nativeOperation });
      expect(await kit.invokeAction('prepare-inspect', { nativeOperation }, { surface: 'plugin' })).toEqual({ kind: 'pending', nativeOperationRef: nativeOperation });
      expect(creates).toBe(1);
      expect(JSON.stringify(result)).not.toContain('private-transport-detail');
    } finally { storage.mockRestore(); await kit.dispose(); }
  });

  it('retains the expected template when allocation loses its native build id and never repeats POST during recovery', async () => {
    const calls: string[] = [];
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(async request => {
      const path = new URL(request.url).pathname;
      calls.push(request.method + ' ' + path);
      if (path === '/v1/templates/agent37-base') return response(200, { name: 'agent37-base', scope: 'system', image_ref: 'debian:bookworm-slim' });
      if (request.method === 'POST') throw new Error('response lost');
      return response(404, {});
    }) });
    try {
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toEqual({ kind: 'unknown', code: 'agent37_build_unconfirmed',
        nativeOperationRef: { ...nativeOperation, value: { name, launch } } });
      expect(await kit.invokeAction('prepare-inspect', { operationId, launch }, { surface: 'plugin' })).toMatchObject({ kind: 'unknown', code: 'agent37_build_identity_unconfirmed' });
      expect(calls.filter(call => call.startsWith('POST '))).toEqual(['POST /v1/template-builds']);
    } finally { await kit.dispose(); }
  });

  it('does not treat a delete acknowledgement as native absence', async () => {
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(async request => request.method === 'DELETE'
      ? response(200, { name, deleted: true }) : response(200, { name, scope: 'workspace', revision: 1, image_digest: digest })) });
    try {
      expect(await kit.invokeAction('prepare-destroy', { artifact }, { surface: 'plugin' })).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { name } } });
    } finally { await kit.dispose(); }
  });

  it.each(['prepare-build', 'prepare-inspect', 'prepare-destroy'])('preserves a typed plugin boundary refusal through %s', async action => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Reconnect the account', failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: null, httpStatus: null } });
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: services(async () => { throw refusal; }) });
    try { await expect(kit.invokeAction(action, action === 'prepare-build' ? input : action === 'prepare-inspect' ? { nativeOperation } : { artifact }, { surface: 'plugin' })).rejects.toMatchObject({ data: refusal.data }); }
    finally { await kit.dispose(); }
  });
});

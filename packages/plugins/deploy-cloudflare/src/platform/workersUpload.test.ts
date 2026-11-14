import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { ExecService, PluginExecSpawnRequest, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import * as entry from '../index.js';
import { CLOUDFLARE_BUILD_IMAGE } from './pagesBuild.js';

const credentialRef = { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'selected-profile' };
const preparation = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1, credentialRef,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
    localId: 'workers-upload' }, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } },
  providerIdentity: { providerAccountId: 'account', providerResourceId: 'worker-tag', providerEnvironment: 'script:app' },
  providerEnvironment: { kind: 'script', scriptName: 'app' }, preparedNative: { projectName: 'app' } };
const input = { ...preparation, targetLinkId: 'link', expectedTargetLinkRevision: 1, deploymentId: 'receipt',
  expectedDeploymentRevision: 1, actionOperationId: 'operation', sourceMethod: 'upload',
  sourceIntent: { kind: 'repository', projectSourceId: 'source', sourceRevision: 1, sha: 'f'.repeat(40),
    compose: { path: 'compose.yaml', profiles: [], services: [] } } };
const versionId = '023e105f-2a42-4f8b-a1c1-73f6a2a30c0f';
const providerReference = `version:${versionId}`;
const previewId = 'a'.repeat(32);
const binary = Uint8Array.from([0, 255, 128, 10]);
function result(exitCode = 0): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
    stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
async function fixture(mode: 'success' | 'buildFailure' | 'cancel' | 'lost' | 'denied' | 'malformed' | 'uncompiled' | 'otherVersion'
  | 'assets' | 'assetsCached' | 'unknownAsset' | 'preview' | 'compactVersion' = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'workers-upload-'));
  await writeFile(join(root, 'worker.ts'), 'export default { fetch: () => new Response("compiled") };');
  await writeFile(join(root, '.env'), 'PRIVATE=not-for-build');
  const form = new FormData();
  form.set('metadata', JSON.stringify({ main_module: 'worker.js', compatibility_date: '2026-11-01', keep_bindings: ['plain_text', 'json', 'secret_text'] }));
  form.set('worker.js', new Blob(['export default { fetch: () => new Response("compiled") };'], { type: 'application/javascript+module' }), 'worker.js');
  form.set('module.wasm', new Blob([binary.buffer], { type: 'application/wasm' }), 'module.wasm');
  const encoded = new Response(form);
  const body = new Uint8Array(await encoded.arrayBuffer());
  const contentType = encoded.headers.get('content-type')!;
  const controller = new AbortController();
  const requests: HttpRequest[] = [];
  const disposeProcess = vi.fn(async () => {});
  // Exec/Docker and HTTP are genuine boundaries; source staging, manifest admission,
  // multipart bytes and the complete plugin producer/consumer path remain real.
  const spawn = vi.fn(async (request: PluginExecSpawnRequest) => {
    const mount = request.args?.find(arg => arg.startsWith('type=bind,source='));
    const scratch = mount?.slice('type=bind,source='.length).split(',target=')[0];
    if (!scratch) throw new Error('Missing staged source mount');
    expect(await readFile(join(scratch, 'project', 'worker.ts'), 'utf8')).toContain('compiled');
    await expect(readFile(join(scratch, 'project', '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    return { async waitForExit() { return (await this.wait()).termination; }, async wait() {
      if (mode === 'cancel') { controller.abort(); throw controller.signal.reason; }
      if (mode === 'buildFailure') return result(1);
      await writeFile(join(scratch, 'worker.bundle'), mode === 'uncompiled' ? 'export default { fetch() {} };' : body);
      const hasAssets = ['assets', 'assetsCached', 'unknownAsset', 'preview'].includes(mode);
      await mkdir(join(scratch, 'project', 'public'), { recursive: true });
      await writeFile(join(scratch, 'project', 'public', 'binary.bin'), binary);
      await writeFile(join(scratch, 'worker.prepared.json'), JSON.stringify({
        ...(hasAssets ? { assets: [{ path: 'project/public/binary.bin', url: '/binary.bin', hash: 'asset-hash', size: binary.length,
          contentType: 'application/octet-stream' }], assetConfig: { html_handling: 'auto-trailing-slash', run_worker_first: false,
          ...(mode === 'preview' ? { compatibility_date: '2026-11-01', _headers: '/binary.bin\n  X-Preview: yes', _redirects: '/old /new 302' } : {}) } } : {}),
        ...(mode === 'preview' ? { preview: { compatibility_date: '2026-11-01', env: { PREVIEW_VALUE: { type: 'plain_text', text: 'preview-only' } } } } : {}),
      }));
      return result();
    }, dispose: disposeProcess, write: async () => {}, closeStdin: async () => {}, onOutput: () => ({ dispose() {} }) };
  });
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected process boundary'); };
  const exec: ExecService = { spawn, run: unsupported, agentCli: { checkReadiness: unsupported },
    systemTools: { async resolve() { return { executable: { kind: 'systemTool', id: 'docker' }, executablePath: '/native/docker' }; } },
    clients: { spawn: unsupported, connectJsonRpc: unsupported } };
  const materialize = vi.fn(async () => ({ environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'receipt',
    machineId: 'controller', installationId: 'installation', rootPath: root, manifestFingerprint: 'approved-source',
    assertCurrent: async () => {}, commit: unsupported, abort: async () => {} }));
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (mode === 'lost') throw new Error('private-provider-detail');
    let value: unknown = { id: 'app', deployment_id: mode === 'compactVersion' ? versionId.replaceAll('-', '') : versionId };
    if (request.url.endsWith('/assets-upload-session')) value = { jwt: 'asset-upload-token',
      buckets: mode === 'assetsCached' ? [] : [[mode === 'unknownAsset' ? 'unknown-hash' : 'asset-hash']] };
    else if (request.url.includes('/workers/assets/upload')) value = { jwt: 'asset-completion-token' };
    else if (request.url.endsWith('/previews/pr-1')) value = { id: previewId, name: 'pr-1' };
    else if (request.url.includes('/previews/')) value = { id: 'preview-deployment', urls: ['https://exact-app.example.workers.dev'],
      env: { EXISTING_SECRET: { type: 'secret_text' }, SYNCED_VALUE: { type: 'plain_text', text: 'synced' } } };
    else if (request.method === 'GET') value = { deployments: [{ id: 'native-deployment', versions: [{ version_id: mode === 'otherVersion' ? 'other-version' : versionId, percentage: 100 }] }] };
    if (mode === 'malformed') value = { id: 'app' };
    return { status: mode === 'denied' ? 403 : 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result: value })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http, exec, deploymentSource: { materialize } } });
  return { kit, requests, spawn, materialize, disposeProcess, body, contentType,
    invoke: (extra = {}) => kit.invokeAction('workers-upload', { ...input, ...extra }, { signal: controller.signal }),
    async dispose() { await kit.dispose(); await rm(root, { recursive: true, force: true }); } };
}

it('inspects and links explicit Workers upload without native Git access or a build trigger', async () => {
  const h = await fixture();
  try {
    const inspected = await h.kit.invokeAction('workers-inspect', { ...preparation, product: 'workers', sourceMethod: 'upload',
      providerIdentity: { ...preparation.providerIdentity, providerEnvironment: 'stale-selection' },
      repository: { kind: 'gitlab', deployment: 'https://gitlab.com', repository: 'example/app' } });
    expect(inspected).toMatchObject({ sourceMethod: 'upload', providerIdentity: preparation.providerIdentity, preparedNative: { projectName: 'app' } });
    expect(inspected).not.toHaveProperty('repositoryAccess');
    if (!inspected || typeof inspected !== 'object' || Array.isArray(inspected)) throw new Error('Expected prepared Worker');
    expect(await h.kit.invokeAction('workers-link', { ...preparation, ...inspected })).toEqual(inspected);
    expect(h.requests).toEqual([]);
  } finally { await h.dispose(); }
});

it('builds exact source in the pinned container and uploads executable multipart modules without provider credentials in Exec', async () => {
  const h = await fixture();
  try {
    expect(await h.invoke()).toMatchObject({ state: 'running', providerDeploymentId: providerReference });
    expect(h.materialize).toHaveBeenCalledExactlyOnceWith({ environmentId: 'environment', deploymentId: 'receipt' }, { signal: expect.any(AbortSignal) });
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0];
    expect([request.method, new URL(request.url).pathname]).toEqual(['PUT', '/client/v4/accounts/account/workers/scripts/app']);
    expect(request.credentialBinding).toMatchObject({ purpose: 'deploy.manage', method: 'PUT' });
    const form = await new Response(request.body ? Uint8Array.from(request.body).buffer : undefined, { headers: request.headers }).formData();
    expect(JSON.parse(String(form.get('metadata')))).toMatchObject({ main_module: 'worker.js', keep_bindings: ['plain_text', 'json', 'secret_text'] });
    expect(new Uint8Array(await (form.get('module.wasm') as File).arrayBuffer())).toEqual(binary);
    const spawn = h.spawn.mock.calls[0][0];
    expect(spawn.executable).toEqual({ kind: 'systemTool', id: 'docker' });
    expect(spawn.args).toContain(CLOUDFLARE_BUILD_IMAGE);
    expect(CLOUDFLARE_BUILD_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(spawn.args).toContain('--rm');
    expect(spawn.env).toBeUndefined();
    expect(spawn.deploymentEnv).toBeUndefined();
    expect(h.disposeProcess).toHaveBeenCalledOnce();
    expect(await h.invoke({ providerDeploymentId: providerReference })).toMatchObject({ state: 'succeeded', providerDeploymentId: providerReference });
    expect(h.requests.map(request => request.method)).toEqual(['PUT', 'GET']);
    expect(h.spawn).toHaveBeenCalledOnce();
  } finally { await h.dispose(); }
});

it('observes the canonical version UUID after the legacy script upload returns a compact deployment id', async () => {
  const h = await fixture('compactVersion');
  try {
    const accepted = await h.invoke();
    expect(accepted).toMatchObject({ state: 'running', providerDeploymentId: providerReference });
    if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted)) throw new Error('Expected upload observation');
    expect(await h.invoke({ providerDeploymentId: accepted.providerDeploymentId }))
      .toMatchObject({ state: 'succeeded', providerDeploymentId: providerReference });
    expect(h.requests.map(request => request.method)).toEqual(['PUT', 'GET']);
    expect(h.spawn).toHaveBeenCalledOnce();
  } finally { await h.dispose(); }
});

it.each(['buildFailure', 'cancel', 'uncompiled'] as const)('settles %s before any provider write and disposes the foreground process', async mode => {
  const h = await fixture(mode);
  try {
    await expect(h.invoke()).rejects.toMatchObject({ code: mode === 'cancel' ? 'plugin_action_aborted' : 'deployment_content_unavailable' });
    expect(h.requests).toEqual([]);
    expect(h.disposeProcess).toHaveBeenCalledOnce();
  } finally { await h.dispose(); }
});

it('refuses native Preview upload without its captured identity before any provider effect', async () => {
  const h = await fixture();
  try {
    await expect(h.invoke({ providerEnvironment: { kind: 'preview', scriptName: 'app', previewName: 'pr-1' } }))
      .rejects.toMatchObject({ code: 'deployment_content_unavailable', details: { phase: 'source' } });
    expect(h.materialize).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
  } finally { await h.dispose(); }
});

it.each(['lost', 'malformed', 'denied'] as const)('preserves %s outcome without retrying the upload', async mode => {
  const h = await fixture(mode);
  try {
    const outcome: unknown = await h.invoke().catch((error: unknown) => error);
    expect(outcome).toMatchObject({ code: mode === 'denied' ? 'deployment_access_denied' : 'outcome_unknown' });
    expect(h.requests).toHaveLength(1);
    expect(JSON.stringify(outcome)).not.toContain('private-provider-detail');
  } finally { await h.dispose(); }
});

it('checks retained upload version serving evidence without rebuilding or repeating the provider write', async () => {
  const h = await fixture();
  try {
    expect(await h.invoke({ providerDeploymentId: providerReference })).toMatchObject({ state: 'succeeded', providerDeploymentId: providerReference });
    expect(h.materialize).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.requests.map(request => request.method)).toEqual(['GET']);
    expect(await h.kit.invokeAction('workers-observe', { ...preparation, targetLinkId: 'link', expectedTargetLinkRevision: 1,
      deploymentId: 'receipt', expectedDeploymentRevision: 1, actionOperationId: 'operation', providerDeploymentId: providerReference,
      preparedNative: { projectName: 'app', triggerUuid: 'git-link-trigger' } }))
      .toMatchObject({ state: 'succeeded', providerDeploymentId: providerReference });
    expect(h.requests.map(request => request.method)).toEqual(['GET', 'GET']);
    await expect(h.kit.invokeAction('workers-cancel', { ...preparation, targetLinkId: 'link', expectedTargetLinkRevision: 1,
      deploymentId: 'receipt', expectedDeploymentRevision: 1, actionOperationId: 'operation', providerDeploymentId: providerReference }))
      .rejects.toMatchObject({ code: 'unsupported_action', details: { phase: 'cancel' } });
    expect(h.requests.map(request => request.method)).toEqual(['GET', 'GET']);
  } finally { await h.dispose(); }
});

it('recovers a retained compact version reference through the public observer without another upload', async () => {
  const h = await fixture();
  const compactReference = `version:${versionId.replaceAll('-', '')}`;
  try {
    expect(await h.kit.invokeAction('workers-observe', { ...preparation, targetLinkId: 'link', expectedTargetLinkRevision: 1,
      deploymentId: 'receipt', expectedDeploymentRevision: 1, actionOperationId: 'operation', providerDeploymentId: compactReference }))
      .toMatchObject({ state: 'succeeded', providerDeploymentId: compactReference });
    expect(h.materialize).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.requests.map(request => request.method)).toEqual(['GET']);
  } finally { await h.dispose(); }
});

it('does not declare upload success from another serving version', async () => {
  const h = await fixture('otherVersion');
  try {
    expect(await h.invoke({ providerDeploymentId: providerReference })).toMatchObject({ state: 'outcome_unknown', providerDeploymentId: providerReference });
    expect(h.materialize).not.toHaveBeenCalled();
    expect(h.requests.map(request => request.method)).toEqual(['GET']);
  } finally { await h.dispose(); }
});

it('retains reviewed source and compiled output provenance in the upload observation', async () => {
  const h = await fixture();
  try {
    expect(await h.invoke()).toMatchObject({ uploadProvenance: { sourceManifestFingerprint: 'approved-source',
      build: { location: 'controller', image: CLOUDFLARE_BUILD_IMAGE, toolchain: { name: 'wrangler', version: '4.156.0' },
        outputManifestFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) } } });
  } finally { await h.dispose(); }
});

it.each(['assets', 'assetsCached'] as const)('uploads the exact Worker Static Assets output using the provider %s session before publishing modules', async mode => {
  const h = await fixture(mode);
  try {
    expect(await h.invoke()).toMatchObject({ state: 'running', providerDeploymentId: providerReference });
    expect(h.requests[0].url).toContain('/workers/scripts/app/assets-upload-session');
    expect(JSON.parse(new TextDecoder().decode(h.requests[0].body))).toEqual({ manifest: { '/binary.bin': { hash: 'asset-hash', size: binary.length } } });
    if (mode === 'assets') {
      const assetRequest = h.requests[1];
      expect(assetRequest.credentialBinding).toBeUndefined();
      expect(assetRequest.headers?.authorization).toBe('Bearer asset-upload-token');
      const files = await new Response(assetRequest.body ? Uint8Array.from(assetRequest.body).buffer : undefined, { headers: assetRequest.headers }).formData();
      expect(await (files.get('asset-hash') as File).text()).toBe(Buffer.from(binary).toString('base64'));
    }
    const publish = h.requests.at(-1)!;
    const form = await new Response(publish.body ? Uint8Array.from(publish.body).buffer : undefined, { headers: publish.headers }).formData();
    expect(JSON.parse(String(form.get('metadata')))).toMatchObject({ main_module: 'worker.js', assets: {
      jwt: mode === 'assets' ? 'asset-completion-token' : 'asset-upload-token', config: { run_worker_first: false } } });
    expect(h.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
  } finally { await h.dispose(); }
});

it('refuses a provider asset bucket outside the prepared manifest before publishing any script', async () => {
  const h = await fixture('unknownAsset');
  try {
    await expect(h.invoke()).rejects.toMatchObject({ code: 'provider_response_invalid' });
    expect(h.requests).toHaveLength(1);
  } finally { await h.dispose(); }
});

it('uploads executable modules and Static Assets only to the captured native Preview and observes its exact deployment', async () => {
  const h = await fixture('preview');
  const preview = { providerEnvironment: { kind: 'preview', scriptName: 'app', previewName: 'pr-1' },
    preparedNative: { projectName: 'app', previewId, scriptName: 'app' } };
  try {
    const prepared = await h.kit.invokeAction('workers-inspect', { ...preparation, product: 'workers', sourceMethod: 'upload',
      providerEnvironment: preview.providerEnvironment, repository: { kind: 'gitlab', deployment: 'https://gitlab.com', repository: 'example/app' } });
    expect(prepared).toMatchObject({ providerIdentity: { providerEnvironment: `preview:${JSON.stringify(['app', 'pr-1'])}` }, preparedNative: { previewId } });
    expect(prepared).not.toHaveProperty('repositoryAccess');
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) throw new Error('Expected prepared Worker');
    expect(await h.kit.invokeAction('workers-link', { ...preparation, ...prepared })).toMatchObject({ preparedNative: { previewId } });
    expect(h.requests).toHaveLength(1);
    const observed = await h.invoke(preview);
    expect(observed).toMatchObject({ state: 'running', providerDeploymentId: 'preview-deployment:preview-deployment' });
    const publishes = h.requests.filter(request => request.url.endsWith('/deployments') && request.method === 'POST');
    expect(publishes).toHaveLength(1);
    expect(publishes[0].url).toContain(`/workers/workers/app/previews/${previewId}/deployments`);
    const form = await new Response(publishes[0].body ? Uint8Array.from(publishes[0].body).buffer : undefined, { headers: publishes[0].headers }).formData();
    expect(JSON.parse(String(form.get('metadata')))).toMatchObject({ main_module: 'worker.js', assets: { jwt: 'asset-completion-token' },
      env: { EXISTING_SECRET: { type: 'inherit' }, SYNCED_VALUE: { type: 'inherit' }, PREVIEW_VALUE: { type: 'plain_text', text: 'preview-only' } } });
    const metadata = JSON.parse(String(form.get('metadata')));
    expect(metadata.assets.config).toEqual({ html_handling: 'auto-trailing-slash', run_worker_first: false });
    const files = form.getAll('files');
    expect(files.filter(file => file instanceof File).map(file => file.name)).toEqual(expect.arrayContaining(['_headers', '_redirects']));
    expect(files.some(file => file instanceof File && file.name === 'module.wasm')).toBe(true);
    expect(h.requests.some(request => request.method === 'PUT')).toBe(false);
    expect(await h.invoke({ ...preview, providerDeploymentId: 'preview-deployment:preview-deployment' }))
      .toMatchObject({ state: 'succeeded', providerDeploymentId: 'preview-deployment:preview-deployment', urls: ['https://exact-app.example.workers.dev'] });
    expect(await h.kit.invokeAction('workers-observe', { ...preparation, ...preview, targetLinkId: 'link', expectedTargetLinkRevision: 1,
      deploymentId: 'receipt', expectedDeploymentRevision: 1, actionOperationId: 'operation', providerDeploymentId: 'preview-deployment:preview-deployment' }))
      .toMatchObject({ state: 'succeeded', providerDeploymentId: 'preview-deployment:preview-deployment' });
    expect(h.spawn).toHaveBeenCalledOnce();
  } finally { await h.dispose(); }
});

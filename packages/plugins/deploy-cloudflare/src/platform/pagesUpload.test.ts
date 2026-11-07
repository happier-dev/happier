import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { ExecService, PluginExecSpawnRequest, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import * as entry from '../index.js';

const credentialRef = { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'recorded-profile' };
const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1, credentialRef,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
    localId: 'pages-upload' }, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } },
  providerIdentity: { providerAccountId: 'account', providerResourceId: 'project-id', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'production' }, repositoryAccess: { status: 'needsGitAccess',
    repository: { kind: 'gitlab', deployment: 'https://gitlab.com', repository: 'example/app' } },
  preparedNative: { projectName: 'existing-pages', pages: { projectMode: 'directUpload', productionBranch: 'main',
    buildCommand: 'npm run build', buildOutputDirectory: 'public' } },
  targetLinkId: 'link', expectedTargetLinkRevision: 1, deploymentId: 'receipt', expectedDeploymentRevision: 1,
  actionOperationId: 'operation', sourceMethod: 'upload', sourceIntent: { kind: 'repository', projectSourceId: 'source',
    sourceRevision: 1, sha: 'f'.repeat(40), compose: { path: 'compose.yaml', profiles: [], services: [] } } };
const binary = Uint8Array.from([0, 255, 128, 10]);
const workerBundle = '--vendor-bundle\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{"main_module":"worker.js"}\r\n';
function result(exitCode = 0): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } }, stdout: new Uint8Array(),
    stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
async function fixture(mode: 'success' | 'buildFailure' | 'cancel' | 'lostCreate' | 'malformedCreate' | 'denied' | 'cached' | 'observeLost' | 'observeDenied' | 'monorepo' | 'acceptedQueued' | 'assetRejected' = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'pages-upload-'));
  const sourceRoot = join(root, 'approved');
  await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, 'package.json'), '{"scripts":{"build":"framework build"}}');
  await writeFile(join(sourceRoot, '.env'), 'PRIVATE=not-for-container');
  if (mode === 'monorepo') {
    await mkdir(join(sourceRoot, 'apps', 'web'), { recursive: true });
    await mkdir(join(sourceRoot, 'packages'));
    await writeFile(join(sourceRoot, 'apps', 'web', 'package.json'), '{"scripts":{"build":"framework build"}}');
    await writeFile(join(sourceRoot, 'packages', 'shared.txt'), 'approved-sibling-package');
  }
  const controller = new AbortController();
  const requests: HttpRequest[] = [];
  const disposeProcess = vi.fn(async () => {});
  const spawn = vi.fn(async (request: PluginExecSpawnRequest) => {
    const mount = request.args?.find(arg => arg.startsWith('type=bind,source='));
    const scratch = mount?.slice('type=bind,source='.length).split(',target=')[0];
    if (!scratch) throw new Error('Missing Docker source mount');
    return { async waitForExit() { return (await this.wait()).termination; },
    async wait() {
      if (mode === 'cancel') { controller.abort(); throw controller.signal.reason; }
      if (mode === 'buildFailure') return result(1);
      if (mode === 'monorepo' && await readFile(join(scratch, 'project', 'packages', 'shared.txt'), 'utf8') !== 'approved-sibling-package') {
        throw new Error('The configured application build cannot reach its approved sibling package');
      }
      const outputDirectory = mode === 'monorepo' ? 'apps/web/public' : 'public';
      await mkdir(join(scratch, 'project', outputDirectory), { recursive: true });
      await writeFile(join(scratch, 'project', outputDirectory, 'binary.bin'), binary);
      await writeFile(join(scratch, '_worker.bundle'), workerBundle);
      await writeFile(join(scratch, 'metadata.json'), JSON.stringify({ outputDirectory,
        assets: [{ path: 'binary.bin', hash: 'pinned-vendor-hash', contentType: 'application/octet-stream' }],
        multipartFiles: [{ name: '_worker.bundle', path: '_worker.bundle', contentType: 'multipart/form-data; boundary=vendor-bundle' }],
        multipartFields: { wrangler_config_hash: 'native-config-hash', pages_build_output_dir: 'public' } }));
      return result();
    }, dispose: disposeProcess, write: async () => {}, closeStdin: async () => {}, onOutput: () => ({ dispose() {} }) };
  });
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected process boundary'); };
  const exec: ExecService = { spawn, run: unsupported, agentCli: { checkReadiness: unsupported },
    systemTools: { async resolve() { return { executable: { kind: 'systemTool', id: 'docker' }, executablePath: '/native/docker' }; } },
    clients: { spawn: unsupported, connectJsonRpc: unsupported } };
  const materialize = vi.fn(async () => ({ environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'receipt',
    machineId: 'controller', installationId: 'installation', rootPath: sourceRoot, manifestFingerprint: 'approved-source',
    assertCurrent: async () => {}, commit: unsupported, abort: async () => {} }));
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (mode === 'assetRejected' && path.endsWith('/check-missing')) {
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: false,
        errors: [{ code: 10000, message: 'private-provider-detail private-upload-jwt' }], result: null })) };
    }
    // Cloudflare's upload/upsert-hashes ACK has no result property.
    if (path.endsWith('/assets/upload') || path.endsWith('/assets/upsert-hashes')) {
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, errors: [], messages: [] })) };
    }
    let value: unknown = null;
    if (path.endsWith('/upload-token')) value = { jwt: 'private-upload-jwt' };
    else if (path.endsWith('/check-missing')) value = mode === 'cached' ? [] : ['pinned-vendor-hash'];
    else if (path.endsWith('/deployments') || path.endsWith('/deployment-exact')) {
      if (mode === 'lostCreate' && request.method === 'POST') throw new Error('private-provider-detail');
      if (mode === 'observeLost' && request.method === 'GET') throw new Error('private-provider-detail');
      value = { id: 'deployment-exact', environment: 'production', latest_stage: { name: mode === 'acceptedQueued' ? 'queued' : 'deploy',
        status: mode === 'acceptedQueued' && request.method === 'POST' ? 'active' : 'success' },
        url: 'https://exact.pages.dev' };
      if (mode === 'malformedCreate' && request.method === 'POST') value = { id: 'deployment-exact' };
    }
    return { status: mode === 'denied' || (mode === 'observeDenied' && path.endsWith('/deployment-exact')) ? 403 : 200, headers: {},
      body: new TextEncoder().encode(JSON.stringify({ success: true, result: value })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http, exec, deploymentSource: { materialize } } });
  return { root, sourceRoot, kit, requests, spawn, disposeProcess, materialize, controller,
    invoke: (extra = {}) => kit.invokeAction('pages-upload', { ...input, ...extra }, { signal: controller.signal }),
    async dispose() { await kit.dispose(); await rm(root, { recursive: true, force: true }); } };
}

it('uploads only pinned-container output with project JWT missing-assets/hash manifest/functions and returns the original provider identity', async () => {
  const h = await fixture();
  try {
    expect(await h.invoke()).toMatchObject({ state: 'succeeded', providerDeploymentId: 'deployment-exact' });
    expect(h.materialize).toHaveBeenCalledExactlyOnceWith({ environmentId: 'environment', deploymentId: 'receipt' }, { signal: expect.any(AbortSignal) });
    expect(h.spawn).toHaveBeenCalledOnce();
    expect(h.requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/client/v4/accounts/account/pages/projects/existing-pages/upload-token'],
      ['POST', '/client/v4/pages/assets/check-missing'], ['POST', '/client/v4/pages/assets/upload'],
      ['POST', '/client/v4/pages/assets/upsert-hashes'], ['POST', '/client/v4/accounts/account/pages/projects/existing-pages/deployments'],
    ]);
    for (const request of h.requests.slice(1, 4)) {
      expect(request.headers?.authorization).toBe('Bearer private-upload-jwt');
      expect(request.credentialBinding).toBeUndefined();
    }
    expect(JSON.parse(new TextDecoder().decode(h.requests[2].body))).toEqual([
      { key: 'pinned-vendor-hash', value: Buffer.from(binary).toString('base64'), base64: true, metadata: { contentType: 'application/octet-stream' } },
    ]);
    const create = h.requests[4];
    expect(create.credentialBinding).toMatchObject({ purpose: 'deploy.manage', method: 'POST' });
    const form = await new Response(create.body ? Uint8Array.from(create.body).buffer : undefined, { headers: create.headers }).formData();
    expect(form.get('manifest')).toBe('{"/binary.bin":"pinned-vendor-hash"}');
    expect(form.get('commit_hash')).toBe(input.sourceIntent.sha);
    expect(form.get('branch')).toBe('main');
    expect(await (form.get('_worker.bundle') as File).text()).toBe(workerBundle);
    expect((form.get('_worker.bundle') as File).type).toBe('multipart/form-data; boundary=vendor-bundle');
    expect(form.get('wrangler_config_hash')).toBe('native-config-hash');
    expect(form.get('pages_build_output_dir')).toBe('public');
    expect([...form.keys()]).not.toContain('env_vars');
    expect(new TextDecoder().decode(create.body)).not.toContain('PRIVATE');
    expect(h.disposeProcess).toHaveBeenCalledOnce();
  } finally { await h.dispose(); }
});

it('builds the configured monorepo application while keeping approved sibling packages and resolving its exact nested output', async () => {
  const h = await fixture('monorepo');
  try {
    expect(await h.invoke({ preparedNative: { ...input.preparedNative, pages: { ...input.preparedNative.pages,
      rootDirectory: 'apps/web' } } })).toMatchObject({ state: 'succeeded', providerDeploymentId: 'deployment-exact' });
    const args = h.spawn.mock.calls[0]?.[0].args ?? [];
    expect(args[args.indexOf('--workdir') + 1]).toBe('/workspace/project/apps/web');
    expect(JSON.parse(new TextDecoder().decode(h.requests.find(request => request.url.endsWith('/assets/upload'))?.body))).toMatchObject([
      { value: Buffer.from(binary).toString('base64') },
    ]);
  } finally { await h.dispose(); }
});

it.each(['buildFailure', 'cancel'] as const)('sends zero provider requests after %s and disposes the foreground build', async mode => {
  const h = await fixture(mode);
  try {
    await expect(h.invoke()).rejects.toMatchObject({ code: mode === 'cancel' ? 'plugin_action_aborted' : 'deployment_content_unavailable' });
    expect(h.requests).toEqual([]);
    expect(h.disposeProcess).toHaveBeenCalledOnce();
  } finally { await h.dispose(); }
});

it('observes a retained deployment without materializing, building or replaying upload', async () => {
  const h = await fixture();
  try {
    expect(await h.invoke({ providerDeploymentId: 'deployment-exact' })).toMatchObject({ state: 'succeeded', providerDeploymentId: 'deployment-exact' });
    expect(h.materialize).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.requests.map(request => request.method)).toEqual(['GET']);
  } finally { await h.dispose(); }
});

it('settles a lost deployment response as unknown without replaying the write or exposing the JWT', async () => {
  const h = await fixture('lostCreate');
  try {
    const outcome = await h.invoke().catch((error: unknown) => error);
    expect(outcome).toMatchObject({ code: 'outcome_unknown', retryable: false });
    expect(JSON.stringify(outcome)).not.toContain('private-upload-jwt');
    expect(JSON.stringify(outcome)).not.toContain('private-provider-detail');
    expect(h.requests.filter(request => request.url.endsWith('/deployments'))).toHaveLength(1);
  } finally { await h.dispose(); }
});

it('settles a definitive asset rejection as failed before creating a deployment, retaining no provider content', async () => {
  const h = await fixture('assetRejected');
  try {
    const outcome = await h.invoke().catch((error: unknown) => error);
    expect(outcome).toMatchObject({ code: 'provider_request_failed', retryable: false, details: { phase: 'send' } });
    expect(JSON.stringify(outcome)).not.toContain('private-provider-detail');
    expect(JSON.stringify(outcome)).not.toContain('private-upload-jwt');
    expect(h.requests.map(request => request.method)).toEqual(['GET', 'POST']);
  } finally { await h.dispose(); }
});

it('retains an accepted provider identity with unknown status so Check status can recover without another write', async () => {
  const h = await fixture('malformedCreate');
  try { expect(await h.invoke()).toMatchObject({ state: 'outcome_unknown', providerDeploymentId: 'deployment-exact' }); }
  finally { await h.dispose(); }
});

it('does not resend assets already present at the provider and keeps the complete final manifest', async () => {
  const h = await fixture('cached');
  try {
    await h.invoke();
    expect(h.requests.filter(request => request.url.endsWith('/assets/upload'))).toHaveLength(0);
    expect(h.requests).toHaveLength(4);
    const request = h.requests.at(-1)!;
    const form = await new Response(request.body ? Uint8Array.from(request.body).buffer : undefined, { headers: request.headers }).formData();
    expect(form.get('manifest')).toBe('{"/binary.bin":"pinned-vendor-hash"}');
  } finally { await h.dispose(); }
});

it('preserves provider denial as a closed nonretryable failure before any asset/deployment upload', async () => {
  const h = await fixture('denied');
  try {
    await expect(h.invoke()).rejects.toMatchObject({ code: 'deployment_access_denied', retryable: false });
    expect(h.requests.map(request => request.method)).toEqual(['GET']);
  } finally { await h.dispose(); }
});

it('refuses branch-HEAD Git deployment before any provider request', async () => {
  const h = await fixture();
  try {
    await expect(h.kit.invokeAction('pages-deploy', { ...input, sourceMethod: 'gitIntegration' })).rejects.toMatchObject({ code: 'unsupported_action' });
    expect(h.requests).toEqual([]);
  } finally { await h.dispose(); }
});

it('returns queued Pages acceptance and its retained identity without a local status timer or read', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const h = await fixture('acceptedQueued');
  const pending = h.invoke();
  void pending.catch(() => {});
  try {
    await vi.waitFor(() => expect(h.requests.some(request => request.url.endsWith('/deployments'))).toBe(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await pending).toMatchObject({ state: 'queued', providerDeploymentId: 'deployment-exact' });
    expect(h.requests.filter(request => request.url.endsWith('/deployments'))).toHaveLength(1);
    expect(h.requests.some(request => request.url.endsWith('/deployment-exact'))).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.requests).toHaveLength(5);
  } finally {
    h.controller.abort();
    await pending.catch(() => {});
    await h.dispose();
    vi.useRealTimers();
  }
});

it.each(['observeLost', 'observeDenied'] as const)('keeps a finite retained-ID %s failure typed without another upload or leaking transport details', async mode => {
  const h = await fixture(mode);
  try {
    const outcome = await h.invoke({ providerDeploymentId: 'deployment-exact' }).catch((error: unknown) => error);
    expect(outcome).toMatchObject({ code: mode === 'observeLost' ? 'provider_request_failed' : 'deployment_access_denied',
      details: { phase: 'observe' } });
    expect(JSON.stringify(outcome)).not.toContain('private-provider-detail');
    expect(JSON.stringify(outcome)).not.toContain('private-upload-jwt');
    expect(h.materialize).not.toHaveBeenCalled();
    expect(h.requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/client/v4/accounts/account/pages/projects/existing-pages/deployments/deployment-exact'],
    ]);
  } finally { await h.dispose(); }
});

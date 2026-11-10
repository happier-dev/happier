import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { DeploymentTargetRoleResultV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import * as entry from '../index.js';

const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'connected-project-pat' };
const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1, credentialRef: account,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: 'happier.deploy.vercel',
    localId: 'deploy-upload-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
  providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_exact', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'production' }, repositoryAccess: { status: 'needsGitAccess',
    repository: { kind: 'gitlab', deployment: 'https://gitlab.com', repository: 'example/app' } },
  preparedNative: { projectName: 'example' }, targetLinkId: 'link', expectedTargetLinkRevision: 1,
  deploymentId: 'receipt', expectedDeploymentRevision: 1, actionOperationId: 'operation', sourceMethod: 'upload',
  sourceIntent: { kind: 'repository', projectSourceId: 'source', sourceRevision: 1, sha: 'a'.repeat(40),
    compose: { path: 'compose.yaml', profiles: [], services: [] } } };

async function fixture(effect?: (request: HttpRequest, controller: AbortController) => void | Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'vercel-upload-'));
  const sourceRoot = join(root, 'approved');
  await mkdir(join(sourceRoot, 'public'), { recursive: true });
  await writeFile(join(sourceRoot, 'package.json'), '{"scripts":{"build":"remote-only"}}');
  await writeFile(join(sourceRoot, 'public', 'binary.bin'), Uint8Array.from([0, 255, 128, 13, 10]));
  await writeFile(join(sourceRoot, 'build.sh'), '#!/bin/sh\necho approved\n');
  await chmod(join(sourceRoot, 'build.sh'), 0o755);
  await mkdir(join(root, 'caller-worktree'));
  await writeFile(join(root, 'caller-worktree', 'package.json'), 'dirty caller bytes');
  const controller = new AbortController();
  const requests: HttpRequest[] = [];
  const commit = vi.fn(async () => undefined);
  const abort = vi.fn(async () => undefined);
  const materialize = vi.fn(async () => ({ environmentId: input.environmentId, environmentInstanceId: 'instance',
    deploymentId: input.deploymentId, machineId: 'controller', installationId: 'installation',
    rootPath: sourceRoot, manifestFingerprint: 'reviewed-manifest', assertCurrent: async () => undefined, commit, abort }));
  const http = createPluginHttpFixture({ async request(request, options) {
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    requests.push(request);
    await effect?.(request, controller);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(
      request.method === 'GET' ? { id: 'dpl_exact', readyState: 'READY' }
        : new URL(request.url).pathname === '/v2/files' ? {}
          : { id: 'dpl_exact', projectId: 'prj_exact', readyState: 'BUILDING' })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry,
    services: { http, deploymentSource: { materialize } } });
  return { root, sourceRoot, requests, materialize, commit, abort, controller, kit,
    invoke: (extra = {}) => kit.invokeAction('deploy-upload-v1', { ...input, ...extra }, { signal: controller.signal }),
    async dispose() { await kit.dispose(); await rm(root, { recursive: true, force: true }); } };
}

describe('Vercel activated controller upload', () => {
  it('inspects a non-GitHub upload source without provider Git access and links its exact project', async () => {
    const requests: HttpRequest[] = [];
    const http = createPluginHttpFixture({ async request(request) {
      requests.push(request);
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
        id: 'prj_exact', accountId: 'team_exact', name: 'example',
        link: { type: 'github', org: 'other', repo: 'repository', repoId: 123 },
      })) };
    } });
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
    try {
      const { sourceIntent, deploymentId, expectedDeploymentRevision, actionOperationId, targetLinkId,
        expectedTargetLinkRevision, ...selection } = input;
      const prepared = await kit.invokeAction('targets-inspect-v1', {
        ...selection, repository: input.repositoryAccess.repository,
      });
      expect(prepared).toMatchObject({ providerIdentity: input.providerIdentity, preparedNative: { projectName: 'example', reviewNotice: expect.stringContaining('Vercel builds uploaded source remotely') } });
      expect(prepared).not.toHaveProperty('repositoryAccess');
      if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) throw new Error('Expected prepared project');
      const { sourceMethod, ...linkInput } = selection;
      const { repositoryAccess, ...withoutGitObservation } = linkInput;
      expect(await kit.invokeAction('project-link', { ...withoutGitObservation, ...prepared })).toEqual(prepared);
      expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([['GET', '/v9/projects/prj_exact']]);
    } finally { await kit.dispose(); }
  });

  it('uploads the admitted exact source bytes without a Git grant or controller build and returns remote build progress', async () => {
    const h = await fixture();
    try {
      expect(entry.manifest.contributes.deploymentTargets[0].actions.uploadDeploy).toBe('deploy-upload-v1');
      const declaration = entry.manifest.contributes.actions.find(action => action.id === 'deploy-upload-v1');
      expect(declaration?.execution.target).toBe('daemon');
      const outcome = await h.invoke();
      expect(DeploymentTargetRoleResultV1ProtocolSchema.parse(outcome)).toMatchObject({ state: 'running', providerDeploymentId: 'dpl_exact',
        uploadProvenance: { sourceManifestFingerprint: 'reviewed-manifest', build: { location: 'provider' } } });
      expect(h.materialize).toHaveBeenCalledExactlyOnceWith({ environmentId: 'environment', deploymentId: 'receipt' }, { signal: expect.any(AbortSignal) });
      const creation = h.requests.find(request => new URL(request.url).pathname === '/v13/deployments');
      expect(creation).toBeDefined();
      const payload = JSON.parse(new TextDecoder().decode(creation?.body));
      expect(payload).toMatchObject({ name: 'example', project: 'prj_exact', target: 'production',
        gitMetadata: { commitSha: input.sourceIntent.sha } });
      expect(payload).not.toHaveProperty('gitSource');
      expect(payload.files.map((file: { file: string }) => file.file).sort()).toEqual(['build.sh', 'package.json', 'public/binary.bin']);
      for (const file of payload.files) {
        const bytes = await readFile(join(h.sourceRoot, file.file));
        expect(file.sha).toBe(createHash('sha1').update(bytes).digest('hex'));
        const uploaded = h.requests.find(request => request.headers?.['x-vercel-digest'] === file.sha);
        expect(uploaded?.body).toEqual(new Uint8Array(bytes));
        expect(uploaded?.headers?.['content-length']).toBe(String(bytes.length));
      }
      expect(payload.files.find((file: { file: string }) => file.file === 'build.sh').mode & 0o111).toBe(0o111);
      expect(h.requests).toHaveLength(4); // One raw-file request per real file and one deployment create.
      expect(h.requests.every(request => request.credentialBinding?.kind === 'connectedAccountPurpose'
        && request.credentialBinding.purpose === 'deploy.manage' && request.credentialBinding.origin === 'https://api.vercel.com'
        && request.credentialBinding.method === request.method && new URL(request.url).searchParams.get('teamId') === 'team_exact')).toBe(true);
      expect(h.commit).not.toHaveBeenCalled();
    } finally { await h.dispose(); }
  });

  it('recovers an existing provider deployment without materializing source or replaying upload', async () => {
    const h = await fixture();
    try {
      expect(await h.invoke({ providerDeploymentId: 'dpl_exact' })).toMatchObject({ state: 'succeeded', providerDeploymentId: 'dpl_exact' });
      expect(h.requests.map(request => request.method)).toEqual(['GET']);
      expect(h.materialize).not.toHaveBeenCalled();
      expect(h.commit).not.toHaveBeenCalled();
    } finally { await h.dispose(); }
  });

  it('uploads symlink text and mode rather than dereferencing source links', async () => {
    const h = await fixture();
    try {
      await symlink('../build.sh', join(h.sourceRoot, 'public', 'build-link'));
      await h.invoke();
      const creation = h.requests.find(request => new URL(request.url).pathname === '/v13/deployments');
      const payload = JSON.parse(new TextDecoder().decode(creation?.body));
      const file = payload.files.find((file: { file: string }) => file.file === 'public/build-link');
      expect(file.mode & 0o170000).toBe(0o120000);
      expect(h.requests.find(request => request.headers?.['x-vercel-digest'] === file.sha)?.body)
        .toEqual(new TextEncoder().encode('../build.sh'));
    } finally { await h.dispose(); }
  });

  it('preserves the admitted branch when uploading a branch-specific preview', async () => {
    const h = await fixture();
    try {
      await h.invoke({ providerIdentity: { ...input.providerIdentity, providerEnvironment: 'preview:feature/exact' },
        providerEnvironment: { kind: 'preview', gitBranch: 'feature/exact' } });
      const creation = h.requests.find(request => new URL(request.url).pathname === '/v13/deployments');
      const payload = JSON.parse(new TextDecoder().decode(creation?.body));
      expect(payload.gitMetadata).toEqual({ commitSha: input.sourceIntent.sha, commitRef: 'feature/exact' });
      expect(payload).not.toHaveProperty('gitSource');
      expect(payload).not.toHaveProperty('target');
    } finally { await h.dispose(); }
  });

  it.each(['file', 'create', 'cancel'] as const)('never commits scratch or replays an uncertain %s request', async phase => {
    const h = await fixture((request, controller) => {
      const creating = new URL(request.url).pathname === '/v13/deployments';
      if (phase === 'cancel' && !creating) { controller.abort(); throw controller.signal.reason; }
      if (phase === 'file' && !creating || phase === 'create' && creating) throw new Error('private transport detail');
    });
    try {
      await expect(h.invoke()).rejects.toMatchObject({ code: phase === 'create' ? 'outcome_unknown'
        : phase === 'cancel' ? 'plugin_action_aborted' : 'provider_request_failed' });
      expect(h.requests.filter(request => new URL(request.url).pathname === '/v13/deployments')).toHaveLength(phase === 'create' ? 1 : 0);
      expect(h.commit).not.toHaveBeenCalled();
    } finally { await h.dispose(); }
  });

  it('excludes committed local credential files while retaining application build configuration', async () => {
    const h = await fixture();
    try {
      await writeFile(join(h.sourceRoot, '.env'), 'DATABASE_PASSWORD=private-source-secret');
      await writeFile(join(h.sourceRoot, '.npmrc'), '//registry.npmjs.org/:_authToken=private-registry-token');
      await mkdir(join(h.sourceRoot, '.vercel'));
      await writeFile(join(h.sourceRoot, '.vercel', 'auth.json'), '{"token":"private-vercel-token"}');
      await writeFile(join(h.sourceRoot, 'vercel.json'), '{"buildCommand":"npm run build"}');
      await writeFile(join(h.sourceRoot, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
      await h.invoke();
      const bodies = h.requests.map(request => new TextDecoder().decode(request.body)).join('\n');
      expect(bodies).not.toContain('private-source-secret');
      expect(bodies).not.toContain('private-registry-token');
      expect(bodies).not.toContain('private-vercel-token');
      const creation = h.requests.find(request => new URL(request.url).pathname === '/v13/deployments');
      const payload = JSON.parse(new TextDecoder().decode(creation?.body));
      expect(payload.files.map((file: { file: string }) => file.file)).toEqual(expect.arrayContaining(['vercel.json', 'tsconfig.json', 'package.json']));
      expect(payload.files.map((file: { file: string }) => file.file)).not.toEqual(expect.arrayContaining(['.env', '.npmrc', '.vercel/auth.json']));
      expect(h.commit).not.toHaveBeenCalled();
    } finally { await h.dispose(); }
  });
});

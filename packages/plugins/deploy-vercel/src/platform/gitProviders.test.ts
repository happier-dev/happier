import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { resolvePublishTargetRecommendation } from '@happier-dev/protocol/deployments/resolvePublishTargetRecommendation';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';

// Constructed responses from https://openapi.vercel.sh POST /v11/projects link union,
// captured 2026-11-16. Not live tenant captures. CLI 155eacfa1684 parseRepoUrl +
// connectGitProvider preserve subgroup paths as namespace/repository.
const samples = [
  { kind: 'github', deployment: 'https://github.com', repository: 'example/app',
    link: { type: 'github', org: 'example', repo: 'app', repoId: 123 },
    gitSource: { type: 'github', repoId: '123' }, id: '123' },
  { kind: 'gitlab', deployment: 'https://gitlab.com', repository: 'example/subgroup/app',
    link: { type: 'gitlab', projectNamespace: 'example/subgroup', projectName: 'App Display Name',
      projectId: '456', projectNameWithNamespace: 'Example / Subgroup / App Display Name',
      projectUrl: 'https://gitlab.com/example/subgroup/app' },
    gitSource: { type: 'gitlab', projectId: '456' }, id: '456' },
  { kind: 'bitbucket', deployment: 'https://bitbucket.org', repository: 'example/app',
    link: { type: 'bitbucket', owner: 'example', slug: 'app', name: 'App Display Name',
      uuid: '{repo-uuid}', workspaceUuid: '{workspace-uuid}' },
    gitSource: { type: 'bitbucket', repoUuid: '{repo-uuid}', workspaceUuid: '{workspace-uuid}' }, id: '{repo-uuid}' },
] as const;
const credentialRef = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'profile' };
const base = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1, credentialRef,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
    localId: 'project-create' }, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } },
  providerAccountId: 'team_exact', providerEnvironment: { kind: 'native', selection: { kind: 'production' } }, sourceMethod: 'gitIntegration' };

it.each(samples)('creates, inspects and deploys the documented $kind repository', async sample => {
  const requests: HttpRequest[] = [];
  const repository = { kind: sample.kind, deployment: sample.deployment, repository: sample.repository };
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request(request) {
      requests.push(request);
      const url = new URL(request.url);
      const body = url.pathname === '/v13/deployments' ? { id: 'dpl_first', projectId: 'prj_created', readyState: 'QUEUED' }
        : url.pathname === '/v1/integrations/search-repo' ? { repos: [{ id: sample.id, provider: sample.kind,
          namespace: sample.repository.slice(0, sample.repository.lastIndexOf('/')), slug: 'app' }] }
        : { id: 'prj_created', accountId: 'team_exact', name: 'app', link: { ...sample.link, productionBranch: 'main' } };
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    } }),
  } });
  try {
    const created = await kit.invokeAction('project-create', { ...base, repository, requestKey: 'request', resourceName: 'app' });
    expect(created).toMatchObject({ repositoryAccess: { status: 'ready' }, preparedNative: { gitSource: sample.gitSource } });
    expect(JSON.parse(new TextDecoder().decode(requests[0].body))).toMatchObject({ gitRepository: {
      type: sample.kind, repo: sample.repository } });
    const inspected = await kit.invokeAction('targets-inspect-v1', { ...base, repository,
      providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_created', providerEnvironment: 'production' } });
    expect(inspected).toMatchObject({ repositoryAccess: { status: 'ready' }, preparedNative: { gitSource: sample.gitSource } });
    expect(new URL(requests.find(r => new URL(r.url).pathname === '/v1/integrations/search-repo')!.url).searchParams.get('provider')).toBe(sample.kind);
    const sha = 'a'.repeat(40);
    const { providerAccountId: _accountId, ...deploymentBase } = base;
    expect(await kit.invokeAction('deploy', { ...deploymentBase, ...created as Record<string, unknown>, expectedRevision: 2,
      targetLinkId: 'link', expectedTargetLinkRevision: 1, deploymentId: 'deployment', expectedDeploymentRevision: 1,
      actionOperationId: 'operation', sourceIntent: { kind: 'repository', sha, projectSourceId: 'source', sourceRevision: 1,
        compose: { path: 'compose.yaml', profiles: [], services: [] } } })).toMatchObject({ state: 'queued' });
    expect(JSON.parse(new TextDecoder().decode(requests.at(-1)!.body))).toMatchObject({ gitSource: { ...sample.gitSource, ref: sha, sha } });
  } finally { await kit.dispose(); }
});

it.each(samples)('offers a grant for $kind when the project has no accessible repository', async sample => {
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request() { return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
      id: 'prj_created', accountId: 'team_exact', name: 'app' })) }; } }),
  } });
  try {
    const result = await kit.invokeAction('targets-inspect-v1', { ...base,
      repository: { kind: sample.kind, deployment: sample.deployment, repository: sample.repository },
      providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_created', providerEnvironment: 'production' } });
    expect(result).toMatchObject({ repositoryAccess: { status: 'needsGitAccess', grantUrl: sample.kind === 'github'
      ? 'https://github.com/apps/vercel/installations/new' : 'https://vercel.com/account/settings/authentication' } });
  } finally { await kit.dispose(); }
});

it.each(samples)('offers Vercel with $kind using Git without an upload machine', sample => {
  const target = entry.manifest.contributes!.deploymentTargets!.find(target => target.id === 'runtime')!;
  expect(resolvePublishTargetRecommendation({ definition: null, deploy: { output: 'static', framework: 'html' },
    repositoryProviderKind: sample.kind, publishProviderKinds: [sample.kind], uploadAvailable: false,
    targets: [{ ...target, sources: target.sources ? { ...target.sources, gitIntegration: [...target.sources.gitIntegration] } : undefined,
      id: 'vercel', targetClass: 'platform', availability: 'available' }] }).offeredTargetIds).toEqual(['vercel']);
});

it.each(samples.filter(sample => sample.kind !== 'github'))('retains $kind grant refusals during create', async sample => {
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request() { return { status: 400, headers: {}, body: new TextEncoder().encode(JSON.stringify({
      error: { code: 'git_integration_required', action: 'Add a Login Connection',
        link: 'https://vercel.com/account/settings/authentication' } })) }; } }),
  } });
  try {
    await expect(kit.invokeAction('project-create', { ...base, requestKey: 'request', resourceName: 'app',
      repository: { kind: sample.kind, deployment: sample.deployment, repository: sample.repository } }))
      .rejects.toMatchObject({ code: 'needsGitAccess', data: { details: { grantUrl: 'https://vercel.com/account/settings/authentication' } } });
  } finally { await kit.dispose(); }
});

import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { DeploymentTargetRoleResultV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import * as entry from '../index.js';
import { activateAccount } from '../account.js';

it.each([
  { target: 'daemon-root', gitBranch: undefined, hasProduction: false },
  { target: 'portable-account', gitBranch: 'feature/qa', hasProduction: false },
  { target: 'portable-account', gitBranch: 'feature/qa', hasProduction: true },
] as const)('reviews the first Production honestly through $target (branch=$gitBranch, existing=$hasProduction)', async sample => {
  const requests: HttpRequest[] = [];
  // HTTP is the only substitute: project preparation, result validation and both
  // activation paths are real. Vercel's filtered list needs one result for existence.
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    const url = new URL(request.url);
    const body = url.pathname === '/v9/projects/prj_exact'
      ? { id: 'prj_exact', accountId: 'team_exact', name: 'example-app',
        link: { type: 'github', org: 'example', repo: 'app', repoId: 123, productionBranch: 'main' } }
      : url.pathname === '/v1/integrations/search-repo'
        ? { repos: [{ id: 123, provider: 'github', namespace: 'example', slug: 'app' }] }
        : { deployments: sample.hasProduction ? [{ uid: 'dpl_existing', target: 'production' }] : [],
        pagination: { count: sample.hasProduction ? 1 : 0, next: null, prev: null } };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest,
    module: sample.target === 'daemon-root' ? entry : { ...entry, activateAccount }, services: { http } });
  try {
    const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'personal-pat' };
    const providerEnvironment = { kind: 'preview', ...(sample.gitBranch ? { gitBranch: sample.gitBranch } : {}) };
    const inspection = await kit.invokeAction('targets-inspect-v1', { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      credentialRef: account, credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
        consumer: { pluginId: entry.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
      providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_exact', providerEnvironment: 'preview' },
      providerEnvironment, ...(sample.target === 'portable-account' ? { sourceMethod: 'gitIntegration' } : {}),
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/app' } });
    expect(inspection).toMatchObject({ repositoryAccess: { status: 'ready' },
      providerEnvironment: sample.hasProduction ? providerEnvironment : { kind: 'production' },
      providerIdentity: { providerEnvironment: sample.hasProduction ? 'preview:"feature/qa"' : 'production' } });
    if (sample.target === 'portable-account') expect(inspection).toHaveProperty('sourceMethod', 'gitIntegration');
    else expect(inspection).not.toHaveProperty('sourceMethod');
    if (!sample.hasProduction) expect(inspection).toMatchObject({ preparedNative: {
      reviewNotice: "Vercel will make this the project's first Production deployment.",
    } });
    else expect(inspection).not.toHaveProperty('preparedNative.reviewNotice');
    const productionReads = requests.filter(request => new URL(request.url).pathname === '/v7/deployments');
    expect(productionReads).toHaveLength(1);
    expect(Object.fromEntries(new URL(productionReads[0]!.url).searchParams)).toEqual({
      teamId: 'team_exact', projectId: 'prj_exact', target: 'production', limit: '1',
    });
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  } finally { await kit.dispose(); }
});

it.each([
  { target: 'daemon-root', productionBranch: 'main', gitBranch: 'main', refused: true },
  { target: 'portable-account', productionBranch: 'release', gitBranch: 'release', refused: true },
  { target: 'portable-account', productionBranch: 'release', gitBranch: 'main', refused: false },
] as const)('prepares Preview $gitBranch against production $productionBranch through $target honestly', async sample => {
  const project = { id: 'prj_exact', accountId: 'team_exact', name: 'example-app',
    link: { type: 'github', org: 'example', repo: 'app', repoId: 123, productionBranch: sample.productionBranch } };
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    const path = new URL(request.url).pathname;
    const body = path === `/v9/projects/${project.id}` ? project
      : path === '/v7/deployments' ? { deployments: [{ uid: 'dpl_existing', target: 'production' }] }
      : { repos: [{ id: 123, provider: 'github', namespace: 'example', slug: 'app' }] };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest,
    module: sample.target === 'daemon-root' ? entry : { ...entry, activateAccount }, services: { http } });
  try {
    const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'personal-pat' };
    const providerEnvironment = { kind: 'preview', gitBranch: sample.gitBranch };
    const inspection = kit.invokeAction('targets-inspect-v1', { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      credentialRef: account, credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
        consumer: { pluginId: entry.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
      providerIdentity: { providerAccountId: project.accountId, providerResourceId: project.id, providerEnvironment: 'preview' },
      providerEnvironment, repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/app' } });
    if (sample.refused) {
      await expect(inspection).rejects.toMatchObject({ code: 'unsupported_action', retryable: false,
        details: { phase: 'link', reason: 'preview_branch_is_production', gitBranch: sample.gitBranch,
          productionBranch: sample.productionBranch } });
      expect(requests.map(request => [request.method, new URL(request.url).pathname]))
        .toEqual([['GET', `/v9/projects/${project.id}`]]);
    } else {
      await expect(inspection).resolves.toMatchObject({ providerEnvironment,
        repositoryAccess: { status: 'ready' }, preparedNative: { projectName: project.name } });
    }
  } finally { await kit.dispose(); }
});

it.each(['daemon-root', 'portable-account'] as const)('explains a missing Source repository through %s Inspect', async target => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new Uint8Array() };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest,
    module: target === 'daemon-root' ? entry : { ...entry, activateAccount }, services: { http } });
  try {
    const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'personal-pat' };
    await expect(kit.invokeAction('targets-inspect-v1', { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      credentialRef: account, credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
        consumer: { pluginId: entry.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
      providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_exact', providerEnvironment: 'production' },
      providerEnvironment: { kind: 'production' } }))
      .rejects.toMatchObject({ code: 'repository_required', retryable: false, details: { phase: 'link' } });
    // A local prerequisite settles before provider access, with no Git grant to acquire.
    expect(requests).toEqual([]);
  } finally { await kit.dispose(); }
});

it.each(['user_personal', 'team_IfWoDydKwqFwMDLSXA80FDAW'])(
  'returns a GitHub App grant for an unlinked sandbox project in scope %s', async accountId => {
  // QA-VERCEL-1102 cli44/inspect-sandbox.json captures the Action projection,
  // not raw provider HTTP. This constructed project vector models its no-Git-source path.
  const projectId = 'prj_Uyy9CT3gK5T1FkB9QCZZu5ZXoxUj';
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ id: projectId, accountId, name: 'happier-qa-deploy' })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'personal-pat' };
    expect(await kit.invokeAction('targets-inspect-v1', { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      credentialRef: account, credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
        consumer: { pluginId: entry.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
      providerIdentity: { providerAccountId: accountId, providerResourceId: projectId, providerEnvironment: 'production' },
      providerEnvironment: { kind: 'production' }, repository: { kind: 'github', deployment: 'https://github.com', repository: 'happier-dev/triage-qa-sandbox' } }))
      .toMatchObject({ providerIdentity: { providerAccountId: accountId, providerResourceId: projectId },
        repositoryAccess: { status: 'needsGitAccess', grantUrl: 'https://github.com/apps/vercel/installations/new' },
        preparedNative: { projectName: 'happier-qa-deploy' } });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(new URL(requests[0].url).searchParams.get('teamId')).toBe(accountId.startsWith('team_') ? accountId : null);
  } finally { await kit.dispose(); }
});

it('finds the exact linked sandbox repository when Vercel search accepts its slug but not owner/repo', async () => {
  // Redacted HTTP projections: QA-VERCEL-1102 cli47-live/provider-diagnostic.json
  // and provider-search-comparison.json (2026-11-03). Keep query-sensitive results.
  const project = { id: 'prj_Uyy9CT3gK5T1FkB9QCZZu5ZXoxUj',
    accountId: 'team_IfWoDydKwqFwMDLSXA80FDAW', name: 'happier-qa-deploy',
    link: { type: 'github', org: 'happier-dev', repo: 'triage-qa-sandbox', repoId: 1424792902,
      productionBranch: 'main' } };
  const repository = { kind: 'github', deployment: 'https://github.com', repository: 'happier-dev/triage-qa-sandbox' };
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    const url = new URL(request.url);
    const body = url.pathname === `/v9/projects/${project.id}` ? project
      : { gitAccount: { provider: 'github', namespaceId: 177958941 },
        repos: url.searchParams.get('query') === project.link.repo
          ? [{ id: 1424792902, provider: 'github', namespace: 'happier-dev', slug: 'triage-qa-sandbox' }]
          : [] };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'connected-project-pat' };
    const result = await kit.invokeAction('targets-inspect-v1', { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 24,
      credentialRef: account, credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
        consumer: { pluginId: entry.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
      providerIdentity: { providerAccountId: project.accountId, providerResourceId: project.id, providerEnvironment: 'production' },
      providerEnvironment: { kind: 'production' }, repository });
    expect(result).toMatchObject({ repositoryAccess: { status: 'ready', repository },
      preparedNative: { projectName: project.name, gitSource: { type: 'github', repoId: '1424792902' } } });
    expect(requests.map(request => [request.method, new URL(request.url).searchParams.get('teamId')]))
      .toEqual([['GET', project.accountId], ['GET', project.accountId]]);
  } finally { await kit.dispose(); }
});

it.each(['daemon-root', 'portable-account'] as const)('activates %s exact-project preparation using the canonical machine-owned Vercel account and HTTP grant', async target => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(
      request.url.includes('/projects/') ? { id: 'prj_exact', accountId: 'team_exact', name: 'example',
        link: { type: 'github', org: 'example', repo: 'app', repoId: 123 } }
        : { repos: [{ id: 123, provider: 'github', namespace: 'example', slug: 'app' }] })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest,
    module: target === 'daemon-root' ? entry : { ...entry, activateAccount }, services: { http } });
  try {
    const registered = kit.registration('actions', 'targets-inspect-v1');
    expect(registered, 'activated exact-project preparation').toBeDefined();
    expect(entry.manifest.contributes.actions.find(action => action.id === 'targets-inspect-v1'))
      .toMatchObject({ readOnly: true, dangerLevel: 'safe', surfaces: expect.arrayContaining(['ui', 'agent']) });
    expect(entry.manifest.contributes.actions.some(action => action.id === 'project-prepare')).toBe(false);
    if (!registered) return;
    const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'connected-project-pat' };
    const principal = { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
      localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } };
    const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      credentialRef: account, credentialPrincipal: principal,
      providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_exact', providerEnvironment: 'production' },
      providerEnvironment: { kind: 'production' },
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/app' } };
    const result = await kit.invokeAction('targets-inspect-v1', input);
    expect(result).toMatchObject({ credentialPrincipal: principal, providerIdentity: { providerResourceId: 'prj_exact' },
      repositoryAccess: { status: 'ready' }, preparedNative: { projectName: 'example', gitSource: { type: 'github', repoId: '123' } } });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected prepared object');
    const { repository: _repository, ...sharedInput } = input;
    expect(await kit.invokeAction('project-link', { ...sharedInput, ...result }))
      .toMatchObject({ credentialPrincipal: principal, preparedNative: { projectName: 'example' } });
    expect(requests.map(request => request.method)).toEqual(['GET', 'GET']);
    expect(requests.every(request => request.credentialBinding?.kind === 'connectedAccountPurpose'
      && request.credentialBinding.purpose === 'deploy.manage')).toBe(true);
    expect(entry.manifest.hostAccess.required).toContainEqual(expect.objectContaining({ id: 'vercel-api', capability: 'network' }));
  } finally { await kit.dispose(); }
});

it('contributes executable runtime roles consuming captured preparation without a deploy-time reprobe', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ id: 'dpl_exact',
      readyState: request.method === 'POST' ? 'QUEUED' : request.method === 'PATCH' ? 'CANCELED' : 'READY' })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    expect(entry.manifest.contributes.deploymentTargets).toContainEqual(expect.objectContaining({ role: 'runtime',
      targetKind: 'vercel', actions: expect.objectContaining({ inspect: 'targets-inspect-v1', link: 'project-link',
        deploy: 'deploy', uploadDeploy: 'deploy-upload-v1', observe: 'observe', cancel: 'cancel', logs: expect.objectContaining({ build: 'build-logs-read' }) }) }));
    const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'connected-project-pat' };
    const common = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1, credentialRef: account,
      credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
        localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
      providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_exact', providerEnvironment: 'production' },
      providerEnvironment: { kind: 'production' }, repositoryAccess: { status: 'ready',
        repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/app' } },
      preparedNative: { projectName: 'example', gitSource: { type: 'github', repoId: '123' } },
      targetLinkId: 'link', expectedTargetLinkRevision: 1, deploymentId: 'receipt', expectedDeploymentRevision: 1, actionOperationId: 'operation' };
    for (const id of ['deploy', 'observe', 'cancel']) {
      const registered = kit.registration('actions', id);
      expect(registered, `activated ${id} role`).toBeDefined();
      if (!registered) throw new Error('Missing role');
      const input = id === 'deploy' ? { ...common, sourceMethod: 'gitIntegration', sourceIntent: { kind: 'repository',
        projectSourceId: 'source', sourceRevision: 1, sha: 'a'.repeat(40), compose: { path: 'compose.yaml', profiles: [], services: [] } } }
        : { ...common, providerDeploymentId: 'dpl_exact' };
      const result = await kit.invokeAction(id, input);
      expect(DeploymentTargetRoleResultV1ProtocolSchema.parse(result)).toMatchObject({ providerDeploymentId: 'dpl_exact',
        state: id === 'deploy' ? 'queued' : id === 'cancel' ? 'cancelled' : 'succeeded' });
    }
    expect(requests.map(request => request.method)).toEqual(['POST', 'GET', 'PATCH']);
    expect(JSON.parse(new TextDecoder().decode(requests[0].body))).toMatchObject({ name: 'example', project: 'prj_exact',
      gitSource: { repoId: '123', ref: 'a'.repeat(40), sha: 'a'.repeat(40) } });
  } finally { await kit.dispose(); }
});

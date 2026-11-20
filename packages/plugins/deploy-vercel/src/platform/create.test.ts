import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { resolveEffectiveInputFields } from '@happier-dev/plugin-sdk/actions';
import { projectCreateAction } from './create.js';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';
import { liveCreatedProjectGitLink, liveMissingProjectSettingsRefusal } from './fixtures/liveProjectCaptures.js';

const credentialRef = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'profile' };
const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1, credentialRef,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
    localId: 'project-create' }, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } },
  providerAccountId: 'team_exact', providerEnvironment: { kind: 'production' },
  requestKey: 'persisted-request', resourceName: 'reviewed-app', sourceMethod: 'upload' };

it('returns the native identity after one create without a follow-up read or deployment', async () => {
  const requests: HttpRequest[] = [];
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request(request) {
      requests.push(request);
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
        id: 'prj_created', accountId: 'team_exact', name: 'reviewed-app', secret: 'never-return' })) };
    } }),
  } });
  try {
    expect(await kit.invokeAction('project-create', input)).toEqual({ credentialPrincipal: input.credentialPrincipal,
      providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_created', providerEnvironment: 'production' },
      sourceMethod: 'upload', providerEnvironment: { kind: 'production' }, preparedNative: { projectName: 'reviewed-app' } });
    expect(requests.map(request => [request.method, request.url])).toEqual([
      ['POST', 'https://api.vercel.com/v11/projects?teamId=team_exact'],
    ]);
    expect(JSON.parse(new TextDecoder().decode(requests[0].body))).toEqual({ name: 'reviewed-app' });
  } finally { await kit.dispose(); }
});

it.each(['transport', 'body', 'identity', 'server'])('does not search or retry after ambiguous create %s', async mode => {
  const requests: HttpRequest[] = [];
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request(request) {
      requests.push(request);
      if (mode === 'transport') throw new Error('connection lost');
      return { status: mode === 'server' ? 503 : 200, headers: {}, body: new TextEncoder().encode(mode === 'body' || mode === 'server' ? 'invalid-json' : '{}') };
    } }),
  } });
  try {
    await expect(kit.invokeAction('project-create', input)).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(requests).toHaveLength(1);
  } finally { await kit.dispose(); }
});

it('retains a known provider refusal cause', async () => {
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request() {
      return { status: 409, headers: {}, body: new TextEncoder().encode(JSON.stringify({ error: { code: 'project_already_exists' } })) };
    } }),
  } });
  try {
    await expect(kit.invokeAction('project-create', input)).rejects.toMatchObject({ code: 'provider_request_failed',
      data: { failureCause: { httpStatus: 409, errorCode: 'project_already_exists' } } });
  } finally { await kit.dispose(); }
});

it('settles abort after dispatch as unknown without a follow-up request', async () => {
  let requests = 0;
  const controller = new AbortController();
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request() {
      requests++;
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    } }),
  } });
  try {
    await expect(kit.invokeAction('project-create', input, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(requests).toBe(1);
  } finally { await kit.dispose(); }
});

it('keeps acknowledged identity when cancellation races with the response', async () => {
  const controller = new AbortController();
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request() {
      controller.abort();
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
        id: 'prj_created', accountId: 'team_exact', name: 'reviewed-app' })) };
    } }),
  } });
  try {
    expect(await kit.invokeAction('project-create', input, { signal: controller.signal }))
      .toMatchObject({ providerIdentity: { providerResourceId: 'prj_created' } });
  } finally { await kit.dispose(); }
});


const repository = { kind: 'github', deployment: 'https://github.com', repository: 'example/app' };

it('creates a Git-linked project through Vercel without a second mutation', async () => {
  const requests: HttpRequest[] = [];
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request(request) {
      requests.push(request);
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
        id: 'prj_created', accountId: 'team_exact', name: 'reviewed-app' })) };
    } }),
  } });
  try {
    expect(await kit.invokeAction('project-create', { ...input, sourceMethod: 'gitIntegration', repository }))
      .toMatchObject({ providerIdentity: { providerResourceId: 'prj_created' }, sourceMethod: 'gitIntegration' });
    expect(requests.map(request => request.method)).toEqual(['POST']);
    expect(JSON.parse(new TextDecoder().decode(requests[0].body))).toEqual({ name: 'reviewed-app',
      gitRepository: { type: 'github', repo: 'example/app' } });
  } finally { await kit.dispose(); }
});

it.each([{ code: 'repo_not_found' }, { code: 'git_integration_required', action: 'Install GitHub App' }])(
  'retains the provider Git setup refusal and offers its one-time GitHub app grant ($code)', async error => {
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
      http: createPluginHttpFixture({ async request() {
        return { status: 400, headers: {}, body: new TextEncoder().encode(JSON.stringify({ error })) };
      } }),
    } });
    try {
      await expect(kit.invokeAction('project-create', { ...input, sourceMethod: 'gitIntegration', repository }))
        .rejects.toMatchObject({ code: 'needsGitAccess', data: { details: { phase: 'link',
          reason: 'vercel_github_app_required', grantUrl: 'https://github.com/apps/vercel/installations/new' },
          failureCause: { errorCode: error.code, httpStatus: 400 } } });
    } finally { await kit.dispose(); }
  });

it.each([
  { sourceMethod: 'gitIntegration', code: 'repository_required' },
  { sourceMethod: 'gitIntegration', repository: { ...repository, kind: 'gitlab', deployment: 'https://gitlab.example.com' }, code: 'unsupported_action' },
])('refuses unsupported Git inputs before provider mutation ($code)', async sample => {
  let requests = 0;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request() { requests++; throw new Error('unexpected provider mutation'); } }),
  } });
  try {
    const { code, ...selection } = sample;
    await expect(kit.invokeAction('project-create', { ...input, ...selection })).rejects.toMatchObject({ code });
    expect(requests).toBe(0);
  } finally { await kit.dispose(); }
});

it.each(['default', 'set', 'refused', 'server', 'transport', 'missing-default', 'cancelled'] as const)(
  'retains the created project and reports the production branch outcome (%s)', async mode => {
    const requests: HttpRequest[] = [];
    const controller = new AbortController();
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
      http: createPluginHttpFixture({ async request(request) {
        requests.push(request);
        if (request.method === 'POST' && mode === 'cancelled') controller.abort();
        if (request.method === 'POST') return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
          id: 'prj_created', accountId: 'team_exact', name: 'reviewed-app',
          ...(mode === 'missing-default' ? {} : { link: { productionBranch: 'main' } }) })) };
        if (mode === 'transport') throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
        return { status: mode === 'refused' ? 400 : mode === 'server' ? 503 : 200, headers: {},
          body: new TextEncoder().encode(JSON.stringify({ error: { code: 'branch_missing' } })) };
      } }),
    } });
    try {
      const requestedBranch = mode === 'default' ? 'main' : 'release';
      const result = await kit.invokeAction('project-create', { ...input, sourceMethod: 'gitIntegration', repository,
        productionBranch: requestedBranch }, { signal: controller.signal });
      expect(result).toMatchObject({ providerIdentity: { providerResourceId: 'prj_created' }, sourceMethod: 'gitIntegration',
        preparedNative: { projectName: 'reviewed-app', productionBranchOutcome: mode === 'default' || mode === 'set' || mode === 'missing-default'
          ? { status: 'set', branch: requestedBranch }
          : mode === 'refused' ? { status: 'defaultKept', branch: 'main', requestedBranch,
            failureCause: { errorCode: 'branch_missing', httpStatus: 400 } }
          : { status: 'unconfirmed', requestedBranch, failureCause: {
            errorCode: mode === 'transport' ? 'ECONNRESET' : mode === 'server' ? 'branch_missing' : null,
            httpStatus: mode === 'server' ? 503 : null } } } });
      expect(requests.map(request => [request.method, request.url])).toEqual([
        ['POST', 'https://api.vercel.com/v11/projects?teamId=team_exact'],
        ...(mode === 'default' || mode === 'cancelled' ? [] : [['PATCH', 'https://api.vercel.com/v9/projects/prj_created/branch?teamId=team_exact']]),
      ]);
      if (requests[1]) expect(JSON.parse(new TextDecoder().decode(requests[1].body))).toEqual({ branch: 'release' });
    } finally { await kit.dispose(); }
  });

it('offers an optional production branch only in the Git Create form', () => {
  const git = resolveEffectiveInputFields(projectCreateAction, { sourceMethod: 'gitIntegration' });
  expect(git.find(field => field.path === 'productionBranch')).toMatchObject({ visible: true, required: false });
  const upload = resolveEffectiveInputFields(projectCreateAction, { sourceMethod: 'upload' });
  expect(upload.some(field => field.path === 'productionBranch')).toBe(false);
});

it.each(['acknowledged', 'oversized'] as const)('settles the reviewed first Git deploy with a %s reply', async reply => {
  const { PluginError } = await import('@happier-dev/plugin-sdk');
  // Live shapes: COR4B-VERCEL-1115 create-git-input.json (Create) → deploy-agent-1.json refused
  // deployment_content_unavailable; the first native deploy then needs Vercel's documented auto-detection opt-in.
  const liveRepository = { kind: 'github', deployment: 'https://github.com', repository: 'happier-dev/triage-qa-sandbox' };
  const requests: HttpRequest[] = [];
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request(request) {
      requests.push(request);
      const url = new URL(request.url);
      const json = (status: number, body: unknown) => ({ status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });
      if (request.method === 'POST' && url.pathname === '/v11/projects') return json(200, { id: 'prj_created',
        accountId: 'team_exact', name: 'cor4b-git-1115', link: liveCreatedProjectGitLink });
      if (request.method === 'PATCH') return json(200, { id: 'prj_created' });
      if (request.method === 'POST' && url.pathname === '/v13/deployments') {
        if (reply === 'oversized') throw new PluginError({ code: 'plugin_fetch_response_too_large', message: 'private response contents' });
        return url.searchParams.get('skipAutoDetectionConfirmation') === '1'
          ? json(200, { id: 'dpl_first', projectId: 'prj_created', readyState: 'QUEUED' })
          : json(400, liveMissingProjectSettingsRefusal);
      }
      throw new Error(`Unexpected Vercel request ${request.method} ${url.pathname}`);
    } }),
  } });
  try {
    const created = await kit.invokeAction('project-create', { ...input, sourceMethod: 'gitIntegration',
      repository: liveRepository, resourceName: 'cor4b-git-1115', productionBranch: 'qa-live53' });
    expect(created).toMatchObject({ repositoryAccess: { status: 'ready', repository: liveRepository },
      preparedNative: { gitSource: { type: 'github', repoId: '1424792902' } } });
    const { sourceMethod: _method, ...content } = created as Record<string, unknown>;
    const sha = 'a'.repeat(40);
    const deploymentResult = kit.invokeAction('deploy', { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 2,
      credentialRef, ...content, targetLinkId: 'link', expectedTargetLinkRevision: 1, deploymentId: 'deployment',
      expectedDeploymentRevision: 1, actionOperationId: 'operation', sourceMethod: 'gitIntegration',
      sourceIntent: { kind: 'repository', sha, projectSourceId: 'source', sourceRevision: 1,
        compose: { path: 'compose.yaml', profiles: [], services: [] } } });
    if (reply === 'oversized') await expect(deploymentResult).rejects.toMatchObject({ code: 'outcome_unknown', retryable: false,
      data: { failureCause: { errorCode: 'plugin_fetch_response_too_large' } } });
    else await expect(deploymentResult).resolves.toMatchObject({ state: 'queued', providerDeploymentId: 'dpl_first' });
    const deployments = requests.filter(request => new URL(request.url).pathname === '/v13/deployments');
    expect(deployments).toHaveLength(1);
    const deployment = deployments[0]!;
    expect(JSON.parse(new TextDecoder().decode(deployment.body))).toMatchObject({ project: 'prj_created',
      gitSource: { type: 'github', repoId: '1424792902', ref: sha, sha } });
  } finally { await kit.dispose(); }
});

it('keeps a project create uncertain when the provider response exceeds the host body limit', async () => {
  const { PluginError } = await import('@happier-dev/plugin-sdk');
  let requests = 0;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request() {
      requests++;
      throw new PluginError({ code: 'plugin_fetch_response_too_large', message: 'private response contents' });
    } }),
  } });
  try {
    await expect(kit.invokeAction('project-create', input)).rejects.toMatchObject({ code: 'outcome_unknown',
      retryable: false, data: { failureCause: { errorCode: 'plugin_fetch_response_too_large' } } });
    expect(requests).toBe(1);
  } finally { await kit.dispose(); }
});

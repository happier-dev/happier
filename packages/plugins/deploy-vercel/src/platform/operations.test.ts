import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { DeploymentTargetRoleResultV1ProtocolSchema as DeploymentTargetRoleResultV1Schema } from '@happier-dev/plugin-sdk';
import * as provider from './operations.js';

// Constructed boundary vectors from the official REST schemas (2026-10-30),
// not tenant captures: /v9/projects, /v13/deployments, /v12/deployments/id/cancel.
const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'example/app' };
const project = { id: 'prj_exact', accountId: 'team_exact', name: 'example-app',
  link: { type: 'github', org: 'example', repo: 'app', repoId: 123 }, additiveVendorField: true };
const gitAccess = { gitAccount: { provider: 'github', namespaceId: 456 },
  repos: [{ id: 123, provider: 'github', namespace: 'example', slug: 'app', defaultBranch: 'main' }] };
const environment = { kind: 'production' as const };
const identity = { providerAccountId: project.accountId, providerResourceId: project.id, providerEnvironment: 'production' };
const selection = { providerIdentity: identity, providerEnvironment: environment, repository };
const preparation = { providerIdentity: identity, providerEnvironment: environment,
  repositoryAccess: { status: 'ready' as const, repository }, projectName: project.name,
  gitSource: { type: 'github' as const, repoId: '123' } };
const source = { kind: 'repository' as const, sha: 'a'.repeat(40), projectSourceId: 'source', sourceRevision: 1,
  compose: { path: 'compose.yaml', profiles: [], services: [] } };

function boundary(responses: readonly { status?: number; body?: unknown; failure?: boolean }[]) {
  const requests: HttpRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const controller = new AbortController();
  const http = createPluginHttpFixture({ async request(request, options) {
    requests.push(request); signals.push(options?.signal);
    const response = responses[requests.length - 1];
    if (!response || response.failure) throw new Error('vendor transport secret must not escape');
    return { status: response.status ?? 200, finalUrl: request.url, headers: {},
      body: new TextEncoder().encode(JSON.stringify(response.body)) };
  } });
  return { context: { http, signal: controller.signal, now: () => 1000 }, controller, requests, signals };
}

describe('Vercel internal platform producer', () => {
  it.each(['production', undefined])('publishes the assigned production alias when Vercel reports target %s', async target => {
    const h = boundary([{ body: { id: 'dpl_exact', readyState: 'READY', target, url: 'app-exact.vercel.app',
      aliasAssigned: true, aliasError: null, alias: ['app.vercel.app', 'app-exact.vercel.app', 'custom.example.test',
        'app.vercel.app.evil.test', 'person@app.vercel.app', 'app.vercel.app/path'] } }]);
    const result = await provider.observeVercelDeployment({ ...selection, providerDeploymentId: 'dpl_exact' }, h.context);
    expect(DeploymentTargetRoleResultV1Schema.parse(result)).toMatchObject({
      urls: ['https://app.vercel.app'], builtInUrls: ['https://app.vercel.app'] });
    expect(h.requests).toHaveLength(1);
  });

  it.each([
    { aliasAssigned: true, aliasError: { code: 'assignment_failed' } },
    {},
  ])('does not claim unconfirmed aliases as built-in domains (%j)', async aliasState => {
    const h = boundary([{ body: { id: 'dpl_exact', readyState: 'READY', target: 'production', url: 'app-exact.vercel.app',
      alias: ['app.vercel.app'], ...aliasState } }]);
    const result = await provider.observeVercelDeployment({ ...selection, providerDeploymentId: 'dpl_exact' }, h.context);
    expect(result).not.toHaveProperty('builtInUrls');
    expect(result).not.toHaveProperty('urls');
  });

  it('keeps a ready Production deployment observable until Vercel finishes assigning its aliases', async () => {
    const deployment = { id: 'dpl_exact', readyState: 'READY', target: 'production', url: 'app-exact.vercel.app' };
    const h = boundary([
      { body: { ...deployment, aliasAssigned: false, aliasError: null, alias: [] } },
      { body: { ...deployment, aliasAssigned: 1001, aliasError: null, alias: ['app.vercel.app'] } },
    ]);
    const input = { ...selection, providerDeploymentId: deployment.id };
    const pending = await provider.observeVercelDeployment(input, h.context);
    expect(pending).toMatchObject({ state: 'running', providerDeploymentId: deployment.id });
    expect(pending).not.toHaveProperty('urls');
    expect(await provider.observeVercelDeployment(input, h.context)).toMatchObject({
      state: 'succeeded', providerDeploymentId: deployment.id, urls: ['https://app.vercel.app'],
    });
  });

  it('keeps the unique address on Preview', async () => {
    const h = boundary([{ body: { id: 'dpl_exact', readyState: 'READY', target: null, url: 'app-exact.vercel.app',
      aliasAssigned: true, alias: ['app-branch.vercel.app'] } }]);
    const result = await provider.observeVercelDeployment({ providerDeploymentId: 'dpl_exact',
      providerIdentity: { ...identity, providerEnvironment: 'preview' }, providerEnvironment: { kind: 'preview', gitBranch: 'feature/qa' } }, h.context);
    expect(result).toMatchObject({ urls: ['https://app-exact.vercel.app'] });
  });

  it.each([
    { status: 401, body: {}, code: 'deployment_access_denied' },
    { status: 200, body: {}, code: 'provider_response_invalid' },
  ])('does not infer first Production from an unreadable production list ($code)', async sample => {
    const h = boundary([{ body: project }, sample]);
    expect(await provider.prepareVercelProject({ ...selection,
      providerEnvironment: { kind: 'preview', gitBranch: 'feature/qa' } }, h.context))
      .toMatchObject({ code: sample.code, phase: 'link' });
    expect(h.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('prepares only the exact existing project and publishes canonical scope and repository facts', async () => {
    const h = boundary([{ body: project }, { body: gitAccess }]);
    const prepared = await provider.prepareVercelProject(selection, h.context);
    expect(prepared).toMatchObject({ providerIdentity: identity, providerEnvironment: environment,
      repositoryAccess: { status: 'ready', repository } });
    expect(h.requests.map(r => [r.method, r.url])).toEqual([
      ['GET', 'https://api.vercel.com/v9/projects/prj_exact?teamId=team_exact'],
      ['GET', 'https://api.vercel.com/v1/integrations/search-repo?teamId=team_exact&provider=github&query=app'],
    ]);
    expect(h.requests[0].credentialBinding).toMatchObject({ kind: 'connectedAccountPurpose', purpose: 'deploy.manage', method: 'GET' });
  });

  it('does not deploy a different or disconnected repository found during preparation', async () => {
    const h = boundary([{ body: { ...project, link: { ...project.link, repo: 'different' } } }]);
    const prepared = await provider.prepareVercelProject(selection, h.context);
    if ('code' in prepared) throw new Error('Expected project observation');
    expect(await provider.deployVercelCommit({ ...prepared, sourceIntent: source }, h.context))
      .toMatchObject({ v: 1, code: 'needsGitAccess', retryable: false });
    expect(h.requests.map(r => r.method)).toEqual(['GET']);
  });

  it('sends the reviewed immutable SHA once and keeps accepted deployment pending', async () => {
    const h = boundary([{ body: project }, { body: gitAccess }, { body: { id: 'dpl_exact', readyState: 'QUEUED', url: 'example.vercel.app' } }]);
    const prepared = await provider.prepareVercelProject(selection, h.context);
    if ('code' in prepared) throw new Error('Expected project preparation');
    const result = await provider.deployVercelCommit({ ...prepared, sourceIntent: source }, h.context);
    expect(DeploymentTargetRoleResultV1Schema.parse(result)).toEqual({ v: 1, state: 'queued',
      providerDeploymentId: 'dpl_exact', observedAtMs: 1000 });
    expect(JSON.parse(new TextDecoder().decode(h.requests[2].body))).toEqual({ name: project.name,
      project: project.id, target: 'production', gitSource: { type: 'github', repoId: '123', ref: source.sha, sha: source.sha } });
    expect(h.requests.map(r => r.method)).toEqual(['GET', 'GET', 'POST']);
  });

  it.each([['INITIALIZING', 'running'], ['BUILDING', 'running'], ['READY', 'succeeded'], ['ERROR', 'failed'], ['BLOCKED', 'failed'], ['CANCELED', 'cancelled']])(
    'observes exact retained deployment %s as %s without a write or retry', async (readyState, state) => {
      const h = boundary([{ body: { id: 'dpl_exact', projectId: project.id, readyState } }]);
      const result = await provider.observeVercelDeployment({ ...selection, providerDeploymentId: 'dpl_exact' }, h.context);
      expect(DeploymentTargetRoleResultV1Schema.parse(result)).toMatchObject({ state, providerDeploymentId: 'dpl_exact' });
      expect(h.requests.map(r => r.url)).toEqual(['https://api.vercel.com/v13/deployments/dpl_exact?teamId=team_exact']);
    });

  it('does not replay an ambiguous create and cannot invent an id for recovery', async () => {
    const h = boundary([{ failure: true }]);
    expect(await provider.deployVercelCommit({ ...preparation, sourceIntent: source }, h.context))
      .toMatchObject({ v: 1, code: 'outcome_unknown', phase: 'send', retryable: false });
    expect(h.requests.map(r => r.method)).toEqual(['POST']);
    expect(await provider.observeVercelDeployment(selection, h.context))
      .toMatchObject({ code: 'outcome_unknown', retryable: false });
    expect(h.requests).toHaveLength(1);
  });

  it('recovers an already retained deployment by observation instead of another deploy', async () => {
    const h = boundary([{ body: { id: 'dpl_exact', readyState: 'READY' } }]);
    expect(await provider.deployVercelCommit({ ...preparation, sourceIntent: source, providerDeploymentId: 'dpl_exact' }, h.context))
      .toMatchObject({ state: 'succeeded', providerDeploymentId: 'dpl_exact' });
    expect(h.requests.map(r => r.method)).toEqual(['GET']);
  });

  it('cancels exact in-progress work and reconciles a terminal-400 with one exact read', async () => {
    const h = boundary([{ status: 400, body: { error: { message: 'private vendor error' } } },
      { body: { id: 'dpl_exact', readyState: 'READY' } }]);
    expect(await provider.cancelVercelDeployment({ ...selection, providerDeploymentId: 'dpl_exact' }, h.context))
      .toMatchObject({ state: 'succeeded' });
    expect(h.requests.map(r => [r.method, new URL(r.url).pathname])).toEqual([
      ['PATCH', '/v12/deployments/dpl_exact/cancel'], ['GET', '/v13/deployments/dpl_exact'],
    ]);
  });

  it('keeps malformed successful writes unknown and read failures typed without echoing payloads', async () => {
    const h = boundary([{ body: { id: 'dpl_exact', readyState: 'NEW_VENDOR_STATE', secret: 'private' } }]);
    expect(await provider.deployVercelCommit({ ...preparation, sourceIntent: source }, h.context))
      .toEqual({ v: 1, state: 'outcome_unknown', providerDeploymentId: 'dpl_exact', observedAtMs: 1000 });
    const denied = boundary([{ status: 403, body: { error: { message: 'private' } } }]);
    await expect(provider.observeVercelDeployment({ ...selection, providerDeploymentId: 'dpl_exact' }, denied.context))
      .rejects.toMatchObject({ code: 'deployment_access_denied',
        data: { failureCause: { errorCode: null, httpStatus: 403 } } });
  });

  it('keeps a missing-id write unknown without replaying it', async () => {
    for (const response of [{ body: { readyState: 'QUEUED' } }]) {
      const h = boundary([response]);
      expect(await provider.deployVercelCommit({ ...preparation, sourceIntent: source }, h.context))
        .toEqual({ v: 1, code: 'outcome_unknown', phase: 'send', retryable: false });
      expect(h.requests.map(r => r.method)).toEqual(['POST']);
    }
  });

  it('keeps production, branch preview and custom payloads isolated', async () => {
    const cases = [
      { providerEnvironment: { kind: 'preview' as const, gitBranch: 'feature/exact' }, fields: {} },
      { providerEnvironment: { kind: 'custom' as const, id: 'env_exact' }, fields: { customEnvironmentSlugOrId: 'env_exact' } },
    ];
    for (const sample of cases) {
      const h = boundary([{ body: { id: 'dpl_exact', readyState: 'BUILDING' } }]);
      await provider.deployVercelCommit({ ...preparation, providerEnvironment: sample.providerEnvironment, sourceIntent: source }, h.context);
      const sent = JSON.parse(new TextDecoder().decode(h.requests[0].body));
      expect(sent).toEqual({ name: project.name, project: project.id, ...sample.fields,
        gitSource: { type: 'github', repoId: '123', ref: sample.providerEnvironment.kind === 'preview' ? 'feature/exact' : source.sha, sha: source.sha } });
      expect(sent).not.toHaveProperty('target');
    }
  });

  it('normalizes confirmed cancellation and observes response loss without repeating cancel', async () => {
    const confirmed = boundary([{ body: { id: 'dpl_exact', readyState: 'CANCELED' } }]);
    expect(await provider.cancelVercelDeployment({ ...selection, providerDeploymentId: 'dpl_exact' }, confirmed.context))
      .toMatchObject({ state: 'cancelled' });
    const lost = boundary([{ failure: true }, { body: { id: 'dpl_exact', readyState: 'BUILDING' } }]);
    expect(await provider.cancelVercelDeployment({ ...selection, providerDeploymentId: 'dpl_exact' }, lost.context))
      .toMatchObject({ state: 'running', providerDeploymentId: 'dpl_exact' });
    expect(lost.requests.map(r => r.method)).toEqual(['PATCH', 'GET']);
  });

  it('stops a cancelled local operation before HTTP and forwards cancellation to body completion', async () => {
    const h = boundary([{ body: project }]);
    h.controller.abort();
    await expect(provider.prepareVercelProject(selection, h.context)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.requests).toHaveLength(0);
    const live = boundary([{ body: project }, { body: gitAccess }]);
    await provider.prepareVercelProject(selection, live.context);
    expect(live.signals).toEqual([live.context.signal, live.context.signal]);
  });

  it.each([
    { error: { code: 'installation_not_found', message: 'private' } }, { repos: [] },
    { repos: [{ id: 123, provider: 'github', namespace: 'another-owner', slug: 'app' }] },
    { repos: [{ id: 456, provider: 'github', namespace: 'example', slug: 'app' }] },
  ])(
    'offers the documented GitHub grant when the retained link has no repository access: %j', async searchResult => {
    const h = boundary([{ body: project }, { body: searchResult }]);
    expect(await provider.prepareVercelProject(selection, h.context))
      .toMatchObject({ repositoryAccess: { status: 'needsGitAccess', repository,
        grantUrl: 'https://github.com/apps/vercel/installations/new' } });
    expect(h.requests.map(r => r.method)).toEqual(['GET', 'GET']);
  });

  it.each([
    { ...repository, deployment: 'https://github.example.test' },
    { kind: 'gitlab' as const, deployment: 'https://gitlab.example.test', repository: 'example/app' },
    { kind: 'bitbucket' as const, deployment: 'https://bitbucket.example.test', repository: 'example/app' },
  ])('returns a typed refusal instead of an empty Git grant for unsupported repository %j', async repository => {
    const h = boundary([{ body: project }]);
    expect(await provider.prepareVercelProject({ ...selection, repository }, h.context))
      .toMatchObject({ code: 'unsupported_action', phase: 'link', retryable: false });
  });
});


it('retains an acknowledged native response when cancellation arrives with it', async () => {
  const controller = new AbortController();
  const response = { status: 200, headers: {}, body: new TextEncoder().encode('{"id":"prj_ack"}') };
  const http = createPluginHttpFixture({ async request() { controller.abort(); return response; } });
  expect(await provider.vercelRequest({ http, signal: controller.signal, now: Date.now },
    'https://api.vercel.com/v11/projects', 'POST')).toMatchObject(response);
});


it.each(['service_unavailable', undefined])('keeps a readable native server refusal as known rather than unknown (%s)', async code => {
  const http = createPluginHttpFixture({ async request() {
    return { status: 503, headers: {}, body: new TextEncoder().encode(JSON.stringify({ error: code ? { code } : { message: 'private' } })) };
  } });
  await expect(provider.vercelRequest({ http, signal: new AbortController().signal, now: Date.now },
    'https://api.vercel.com/v11/projects', 'POST')).rejects.toMatchObject({ code: 'provider_request_failed',
      data: { failureCause: { httpStatus: 503, errorCode: code ?? null } } });
});

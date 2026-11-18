import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';
import { activateAccount } from '../account.js';

const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'fixture' };
const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  targetLinkId: 'link', expectedTargetLinkRevision: 1, deploymentId: 'receipt', expectedDeploymentRevision: 1,
  actionOperationId: 'operation', credentialRef: account,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
    consumer: { pluginId: entry.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
  providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_exact', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'production' },
  priorDeployment: { environmentId: 'environment', deploymentId: 'prior-receipt', expectedRevision: 1, providerDeploymentId: 'dpl_prior' } };

const nativeDeployment = (target: 'production' | null, readyState = 'READY') => ({
  id: 'dpl_prior', projectId: 'prj_exact', name: 'fixture', target, readyState,
});
const jsonResponse = (status: number, value: unknown) => ({
  status, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)),
});

it('rebuilds the selected preview for production and observes the new id until it serves traffic', async () => {
  let stage: 'building' | 'ready' | 'current' | 'error' | 'alias-error' = 'building';
  const requests: HttpRequest[] = [];
  const production = { id: 'dpl_current', target: 'production', aliasAssigned: 1, aliasError: null };
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    const { pathname, searchParams } = new URL(request.url);
    expect(searchParams.get('teamId')).toBe('team_exact');
    if (request.method === 'POST' && pathname === '/v13/deployments') {
      expect(JSON.parse(new TextDecoder().decode(request.body))).toMatchObject({
        deploymentId: 'dpl_prior', name: 'fixture', project: 'prj_exact', target: 'production', meta: { action: 'promote' },
      });
      return jsonResponse(200, { ...nativeDeployment('production', 'QUEUED'), id: 'dpl_promoted' });
    }
    if (request.method === 'GET' && pathname === '/v13/deployments/dpl_prior') return jsonResponse(200, nativeDeployment(null));
    if (request.method === 'GET' && pathname === '/v9/projects/prj_exact') {
      return jsonResponse(200, { id: 'prj_exact', accountId: 'team_exact', lastAliasRequest: null,
        targets: { production: stage === 'current' ? { ...production, id: 'dpl_promoted', alias: ['fixture.vercel.app'] } : production } });
    }
    if (request.method === 'GET' && pathname === '/v13/deployments/dpl_promoted') {
      return jsonResponse(200, { ...nativeDeployment('production', stage === 'error' ? 'ERROR' : stage === 'building' ? 'BUILDING' : 'READY'),
        id: 'dpl_promoted', aliasAssigned: false, meta: { action: 'promote' },
        aliasError: stage === 'alias-error' ? { code: 'alias_failed', message: 'Could not assign production alias' } : null });
    }
    return jsonResponse(422, { error: { code: 'unprocessable_entity', message: 'Preview deployments require a production rebuild.' } });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction('promote', input)).resolves.toMatchObject({ state: 'queued', providerDeploymentId: 'dpl_promoted' });
    const { priorDeployment: _prior, ...retained } = input;
    const observe = () => kit.invokeAction('observe', { ...retained, operation: 'promote', providerDeploymentId: 'dpl_promoted' });
    await expect(observe()).resolves.toMatchObject({ state: 'running', providerDeploymentId: 'dpl_promoted' });
    await expect(kit.invokeAction('promote', { ...input, providerDeploymentId: 'dpl_promoted' }))
      .resolves.toMatchObject({ state: 'running', providerDeploymentId: 'dpl_promoted' });
    stage = 'ready';
    await expect(observe()).resolves.toMatchObject({ state: 'running', providerDeploymentId: 'dpl_promoted' });
    stage = 'error';
    await expect(observe()).resolves.toMatchObject({ state: 'failed', providerDeploymentId: 'dpl_promoted' });
    stage = 'alias-error';
    await expect(observe()).resolves.toMatchObject({ state: 'failed', providerDeploymentId: 'dpl_promoted' });
    stage = 'current';
    await expect(observe()).resolves.toMatchObject({ state: 'succeeded', providerDeploymentId: 'dpl_promoted',
      builtInUrls: ['https://fixture.vercel.app'] });
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(requests.filter(request => new URL(request.url).pathname === '/v13/deployments/dpl_prior')).toHaveLength(1);
  } finally { await kit.dispose(); }
});

it('retains the native 422 and a sanitized provider message on a refused promotion', async () => {
  const http = createPluginHttpFixture({ async request(request) {
    return request.method === 'GET' ? jsonResponse(200, nativeDeployment('production'))
      : jsonResponse(422, { error: { code: 'unprocessable_entity', message: 'Deployment cannot be promoted. token=fixture-secret' } });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction('promote', input)).rejects.toMatchObject({ code: 'provider_request_failed',
      message: 'Deployment cannot be promoted. token: [REDACTED]',
      data: { failureCause: { phase: 'deployment.provider.send', errorCode: 'unprocessable_entity', httpStatus: 422 } } });
  } finally { await kit.dispose(); }
});

// Constructed boundary vectors from openapi.vercel.sh, requestPromote/requestRollback
// and getProject.lastAliasRequest, inspected 2026-11-10. No tenant mutation.
it.each(['promote', 'rollback'] as const)('requests %s once and reports the provider alias job instead of old build readiness', async operation => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (new URL(request.url).pathname === '/v13/deployments/dpl_prior') return jsonResponse(200, nativeDeployment('production'));
    return { status: request.method === 'POST' ? 201 : 200, headers: {}, body: new TextEncoder().encode(request.method === 'POST' ? '' : JSON.stringify({
      id: 'prj_exact', accountId: 'team_exact', lastAliasRequest: { type: operation, toDeploymentId: 'dpl_prior',
        fromDeploymentId: 'dpl_current', requestedAt: 1, jobStatus: 'in-progress' } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction(operation, input)).resolves.toMatchObject({ v: 1, state: 'running', providerDeploymentId: 'dpl_prior' });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ...(operation === 'promote' ? [['GET', '/v13/deployments/dpl_prior']] : []),
      ['POST', `/v${operation === 'promote' ? '10' : '1'}/projects/prj_exact/${operation}/dpl_prior`], ['GET', '/v9/projects/prj_exact'],
    ]);
    expect(requests.find(request => request.method === 'POST')?.body).toBeUndefined();
    expect(requests.every(request => new URL(request.url).searchParams.get('teamId') === 'team_exact')).toBe(true);
    expect(entry.manifest.contributes.deploymentTargets[0]).toMatchObject({ actions: { promote: 'promote', rollback: 'rollback' } });
  } finally { await kit.dispose(); }
});

it.each([
  { operation: 'promote', target: 'production', status: null },
  { operation: 'rollback', target: 'production', status: null },
  { operation: 'promote', target: null, status: null },
  { operation: 'promote', target: 'production', status: 503 },
  { operation: 'promote', target: null, status: 503 },
] as const)('retains an uncertain $operation cause for target $target and status $status without repeating the write', async ({ operation, target, status }) => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (request.method === 'GET') return jsonResponse(200, nativeDeployment(target));
    if (status !== null) return { status, headers: {}, body: new Uint8Array() };
    throw Object.assign(new Error('provider transport lost'), { code: 'ECONNRESET' });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction(operation, input)).rejects.toMatchObject({ code: 'outcome_unknown', data: {
      failureCause: { phase: 'deployment.provider.send', errorCode: status === null ? 'ECONNRESET' : null, httpStatus: status },
    } });
    expect(requests.map(request => request.method)).toEqual(operation === 'promote' ? ['GET', 'POST'] : ['POST']);
    if (target === null) expect(new URL(requests[1]!.url).pathname).toBe('/v13/deployments');
  } finally { await kit.dispose(); }
});

it.each([
  { status: 403, code: 'deployment_access_denied' }, { status: 404, code: 'deployment_unavailable' },
  { status: 409, code: 'deployment_conflict' }, { status: 503, code: 'outcome_unknown' },
])('retains the traffic mutation refusal $status', async ({ status, code }) => {
  const http = createPluginHttpFixture({ async request(request) {
    return request.method === 'GET' ? jsonResponse(200, nativeDeployment('production')) : { status, headers: {}, body: new Uint8Array() };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try { await expect(kit.invokeAction('promote', input)).rejects.toMatchObject({ code }); }
  finally { await kit.dispose(); }
});

it.each([
  { jobStatus: 'pending', state: 'queued' }, { jobStatus: 'in-progress', state: 'running' },
  { jobStatus: 'succeeded', state: 'succeeded' }, { jobStatus: 'failed', state: 'failed' },
])('observes traffic job $jobStatus through the retained receipt', async ({ jobStatus, state }) => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ id: 'prj_exact', accountId: 'team_exact',
      lastAliasRequest: { type: 'promote', toDeploymentId: 'dpl_prior', fromDeploymentId: 'dpl_current', requestedAt: 1, jobStatus } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const { priorDeployment: _prior, ...retained } = input;
    await expect(kit.invokeAction('observe', { ...retained, operation: 'promote', providerDeploymentId: 'dpl_prior' }))
      .resolves.toMatchObject({ state, providerDeploymentId: 'dpl_prior' });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([['GET', '/v9/projects/prj_exact']]);
  } finally { await kit.dispose(); }
});

it.each(['promote', 'rollback'] as const)('settles %s from the production target when Vercel reports no alias job', async operation => {
  // Live: COR4B-VERCEL-1115 p-upload-project3.json after a rollback — lastAliasRequest null, production
  // target already the restored deployment with its aliases assigned; Happier settled outcome_unknown.
  const production = (id: string) => ({ id, readyState: 'READY', readySubstate: 'PROMOTED', target: 'production',
    alias: ['cor4b-upload-1115.vercel.app'], aliasAssigned: 1794771640971, aliasError: null });
  for (const [current, state] of [['dpl_prior', 'succeeded'], ['dpl_current', 'outcome_unknown']] as const) {
    const http = createPluginHttpFixture({ async request(request) {
      if (new URL(request.url).pathname === '/v13/deployments/dpl_prior') return jsonResponse(200, nativeDeployment('production'));
      return { status: request.method === 'POST' ? 201 : 200, headers: {}, body: new TextEncoder().encode(request.method === 'POST' ? '' : JSON.stringify({
        id: 'prj_exact', accountId: 'team_exact', lastAliasRequest: null, lastRollbackTarget: null,
        targets: { production: production(current) } })) };
    } });
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
    try {
      const result = await kit.invokeAction(operation, input);
      expect(result).toMatchObject({ v: 1, state, providerDeploymentId: 'dpl_prior' });
      if (state === 'succeeded') expect(result).toHaveProperty('builtInUrls', ['https://cor4b-upload-1115.vercel.app']);
      else expect(result).not.toHaveProperty('builtInUrls');
    } finally { await kit.dispose(); }
  }
});

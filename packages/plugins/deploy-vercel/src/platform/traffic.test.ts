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

// Constructed boundary vectors from openapi.vercel.sh, requestPromote/requestRollback
// and getProject.lastAliasRequest, inspected 2026-11-10. No tenant mutation.
it.each(['promote', 'rollback'] as const)('requests %s once and reports the provider alias job instead of old build readiness', async operation => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: request.method === 'POST' ? 201 : 200, headers: {}, body: new TextEncoder().encode(request.method === 'POST' ? '' : JSON.stringify({
      id: 'prj_exact', accountId: 'team_exact', lastAliasRequest: { type: operation, toDeploymentId: 'dpl_prior',
        fromDeploymentId: 'dpl_current', requestedAt: 1, jobStatus: 'in-progress' } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction(operation, input)).resolves.toMatchObject({ v: 1, state: 'running', providerDeploymentId: 'dpl_prior' });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['POST', `/v${operation === 'promote' ? '10' : '1'}/projects/prj_exact/${operation}/dpl_prior`], ['GET', '/v9/projects/prj_exact'],
    ]);
    expect(requests.every(request => new URL(request.url).searchParams.get('teamId') === 'team_exact')).toBe(true);
    expect(entry.manifest.contributes.deploymentTargets[0]).toMatchObject({ actions: { promote: 'promote', rollback: 'rollback' } });
  } finally { await kit.dispose(); }
});

it.each(['promote', 'rollback'] as const)('does not repeat an ambiguous %s write', async operation => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) { requests.push(request); throw new Error('provider transport lost'); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction(operation, input)).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(requests.map(request => request.method)).toEqual(['POST']);
  } finally { await kit.dispose(); }
});

it.each([
  { status: 403, code: 'deployment_access_denied' }, { status: 404, code: 'deployment_unavailable' },
  { status: 409, code: 'deployment_conflict' }, { status: 503, code: 'outcome_unknown' },
])('retains the traffic mutation refusal $status', async ({ status, code }) => {
  const http = createPluginHttpFixture({ async request() { return { status, headers: {}, body: new Uint8Array() }; } });
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

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
  providerEnvironment: { kind: 'native', selection: { kind: 'production' } }, operation: 'teardown', providerDeploymentId: 'dpl_retained' };
const response = (status: number, body?: unknown) => ({ status, headers: {},
  body: body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body)) });

// Constructed boundary vectors from Vercel's delete-a-project (DELETE v9, 204)
// and find-a-project-by-id-or-name (GET v9, 404), inspected 2026-11-15.
it('deletes only the recorded project with the bound account and proves its absence before success', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return request.method === 'DELETE' ? response(204) : response(404, { error: { code: 'not_found' } });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction('teardown', input)).resolves.toMatchObject({ v: 1, state: 'succeeded',
      providerResourceAbsent: true, providerDeploymentId: 'dpl_retained' });
    expect(requests.map(request => [request.method, request.url])).toEqual([
      ['DELETE', 'https://api.vercel.com/v9/projects/prj_exact?teamId=team_exact'],
      ['GET', 'https://api.vercel.com/v9/projects/prj_exact?teamId=team_exact'],
    ]);
    expect(requests.every(request => request.credentialBinding?.kind === 'connectedAccountPurpose'
      && request.credentialBinding.purpose === 'deploy.manage' && request.credentialBinding.method === request.method)).toBe(true);
    expect(entry.manifest.contributes.deploymentTargets?.[0]).toMatchObject({ actions: { teardown: 'teardown' } });
  } finally { await kit.dispose(); }
});

it('settles an already absent project without requiring a deployment or repeating the delete', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return response(404, { error: { code: 'not_found' } });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const { providerDeploymentId: _deployment, ...withoutDeployment } = input;
    await expect(kit.invokeAction('teardown', withoutDeployment)).resolves.toMatchObject({ state: 'succeeded', providerResourceAbsent: true });
    expect(requests.map(request => request.method)).toEqual(['DELETE']);
  } finally { await kit.dispose(); }
});

it('recovers teardown by reading the exact project rather than the retained deployment', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) { requests.push(request); return response(404); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('observe', input)).resolves.toMatchObject({ state: 'succeeded', providerResourceAbsent: true });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([['GET', '/v9/projects/prj_exact']]);
  } finally { await kit.dispose(); }
});

it.each(['delete', 'observe'] as const)('retains the native timeout as unknown during %s without replaying the mutation', async phase => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (phase === 'observe' && request.method === 'DELETE') return response(204);
    throw Object.assign(new Error('provider timed out'), { code: 'ETIMEDOUT' });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('teardown', input)).rejects.toMatchObject({ code: 'outcome_unknown',
      data: { failureCause: { errorCode: 'ETIMEDOUT' } } });
    expect(requests.map(request => request.method)).toEqual(phase === 'delete' ? ['DELETE'] : ['DELETE', 'GET']);
  } finally { await kit.dispose(); }
});

it.each(['delete', 'observe'] as const)('retains HTTP 503 and native code as unknown during %s', async phase => {
  const http = createPluginHttpFixture({ async request(request) {
    return phase === 'observe' && request.method === 'DELETE' ? response(204)
      : response(503, { error: { code: 'service_unavailable' } });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('teardown', input)).rejects.toMatchObject({ code: 'outcome_unknown',
      data: { failureCause: { httpStatus: 503, errorCode: 'service_unavailable' } } });
  } finally { await kit.dispose(); }
});

it('keeps a project that still exists unconfirmed after DELETE acknowledgement', async () => {
  const http = createPluginHttpFixture({ async request(request) {
    return request.method === 'DELETE' ? response(204) : response(200, { id: 'prj_exact', accountId: 'team_exact' });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try { await expect(kit.invokeAction('teardown', input)).rejects.toMatchObject({ code: 'outcome_unknown' }); }
  finally { await kit.dispose(); }
});

it('preserves a denied deletion and never claims absence or reads another resource', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return response(403, { error: { code: 'forbidden' } });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('teardown', input)).rejects.toMatchObject({ code: 'deployment_access_denied',
      data: { failureCause: { httpStatus: 403, errorCode: 'forbidden' } } });
    expect(requests.map(request => request.method)).toEqual(['DELETE']);
  } finally { await kit.dispose(); }
});

import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';

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
      providerEnvironment: { kind: 'production' }, preparedNative: { projectName: 'reviewed-app' } });
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


it('refuses a Git create before any provider mutation without a proven repository grant', async () => {
  let requests = 0;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request() { requests++; throw new Error('unexpected provider mutation'); } }),
  } });
  try {
    await expect(kit.invokeAction('project-create', { ...input, sourceMethod: 'gitIntegration' }))
      .rejects.toMatchObject({ code: 'unsupported_action' });
    expect(requests).toBe(0);
  } finally { await kit.dispose(); }
});

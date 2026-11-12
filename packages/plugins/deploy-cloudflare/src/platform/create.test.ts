import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';

const credentialRef = { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'profile' };
function input(actionId: string) {
  return { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1, credentialRef,
    credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
      localId: actionId }, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } },
    providerAccountId: 'account', providerEnvironment: actionId === 'workers-create' ? { kind: 'script', scriptName: 'reviewed-app' } : { kind: 'production' },
    requestKey: 'persisted-request', resourceName: 'reviewed-app', sourceMethod: 'upload', productionBranch: 'trunk' };
}

it.each(['pages-create', 'workers-create'])('retains %s exact native identity before any follow-up', async actionId => {
  const requests: HttpRequest[] = [];
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request(request) {
      requests.push(request);
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
        result: { id: 'native-id', name: 'reviewed-app', production_branch: 'trunk', secret: 'never-return' } })) };
    } }),
  } });
  try {
    const result = await kit.invokeAction(actionId, input(actionId));
    expect(result).toMatchObject({ credentialPrincipal: input(actionId).credentialPrincipal,
      providerIdentity: { providerAccountId: 'account', providerResourceId: 'native-id',
        providerEnvironment: actionId === 'workers-create' ? 'script:reviewed-app' : 'production' },
      preparedNative: { projectName: 'reviewed-app' } });
    expect(JSON.stringify(result)).not.toContain('never-return');
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['POST', `/client/v4/accounts/account/${actionId === 'workers-create' ? 'workers/workers' : 'pages/projects'}`],
    ]);
    expect(JSON.parse(new TextDecoder().decode(requests[0].body))).toEqual(actionId === 'workers-create'
      ? { name: 'reviewed-app' } : { name: 'reviewed-app', production_branch: 'trunk' });
  } finally { await kit.dispose(); }
});

it.each(['transport', 'body', 'identity', 'server'])('does not repeat or search after an ambiguous Pages create %s', async mode => {
  const requests: HttpRequest[] = [];
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request(request) {
      requests.push(request);
      if (mode === 'transport') throw new Error('connection lost');
      return { status: mode === 'server' ? 503 : 200, headers: {}, body: new TextEncoder().encode(mode === 'body' || mode === 'server' ? 'invalid-json' : '{"success":true,"result":{}}') };
    } }),
  } });
  try {
    await expect(kit.invokeAction('pages-create', input('pages-create'))).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(requests).toHaveLength(1);
  } finally { await kit.dispose(); }
});

it('retains Cloudflare refusal status and native code', async () => {
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request() {
      return { status: 403, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: false,
        errors: [{ code: 10000, message: 'authentication failure' }] })) };
    } }),
  } });
  try {
    await expect(kit.invokeAction('workers-create', input('workers-create'))).rejects.toMatchObject({ code: 'deployment_access_denied',
      data: { failureCause: { httpStatus: 403, errorCode: null, nativeErrorCode: '10000' } } });
  } finally { await kit.dispose(); }
});

it('offers the reviewed new Worker environment without reading an existing resource', async () => {
  let requests = 0;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request() { requests++; throw new Error('unexpected provider read'); } }),
  } });
  try {
    const draft = input('workers-create');
    expect(await kit.invokeAction('target-options-read', { credentialRef, credentialPrincipal: draft.credentialPrincipal,
      fieldPath: 'providerEnvironment', providerAccountId: 'account', product: 'workers', resourceName: 'reviewed-app' }))
      .toEqual({ options: [{ value: { kind: 'script', scriptName: 'reviewed-app' }, label: 'reviewed-app' }] });
    expect(requests).toBe(0);
  } finally { await kit.dispose(); }
});


it.each(['pages-create', 'workers-create'])('refuses %s for Git without a proven native grant before mutation', async actionId => {
  let requests = 0;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request() { requests++; throw new Error('unexpected provider mutation'); } }),
  } });
  try {
    await expect(kit.invokeAction(actionId, { ...input(actionId), sourceMethod: 'gitIntegration' }))
      .rejects.toMatchObject({ code: 'unsupported_action' });
    expect(requests).toBe(0);
  } finally { await kit.dispose(); }
});

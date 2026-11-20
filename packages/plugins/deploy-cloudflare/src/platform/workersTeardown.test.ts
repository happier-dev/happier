import { expect, it } from 'vitest';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetLinkProviderContentV1ProtocolSchema as linkContent } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { isObject } from '../connectedAccounts/probe.js';
import * as entry from '../index.js';

const accountId = 'a'.repeat(32), workerId = 'b'.repeat(32), previewId = 'c'.repeat(32);
const root = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/workers/${workerId}`;
function input(preview = false) {
  const credentialRef = { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'selected-profile' };
  return inputs.teardown.parse({ v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1, credentialRef,
    credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
      localId: 'workers-inspect' }, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } },
    providerIdentity: { providerAccountId: accountId, providerResourceId: workerId, providerEnvironment: 'selected' },
    providerEnvironment: preview ? { kind: 'preview', scriptName: 'production-worker', previewName: 'feature/name' }
      : { kind: 'script', scriptName: 'production-worker' },
    preparedNative: { projectName: 'production-worker', ...(preview ? { previewId, scriptName: 'production-worker' } : {}) },
    targetLinkId: 'link', expectedTargetLinkRevision: 1, deploymentId: 'receipt', expectedDeploymentRevision: 1,
    actionOperationId: 'operation', operation: 'teardown' });
}
function response(status: number, value?: unknown) {
  return { status, headers: {}, body: value === undefined ? new Uint8Array()
    : new TextEncoder().encode(JSON.stringify(value)) };
}
async function fixture(handler: (request: HttpRequest) => Promise<ReturnType<typeof response>>) {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) { requests.push(request); return handler(request); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  return { kit, requests };
}

it('deletes the legacy discovery/link producer’s Worker ID without force, then settles only after GET proves absence', async () => {
  const { kit, requests } = await fixture(async request => request.url.endsWith('/workers/scripts')
    ? response(200, { success: true, result: [{ id: 'production-worker', tag: workerId }] })
    : request.method === 'DELETE' ? response(200, { success: true, errors: [], messages: [] }) : response(404));
  try {
    const request = input();
    const choices = await kit.invokeAction('target-options-read', { credentialRef: request.credentialRef,
      credentialPrincipal: request.credentialPrincipal, product: 'workers', providerAccountId: accountId,
      fieldPath: 'providerIdentity.providerResourceId' });
    if (!isObject(choices) || !Array.isArray(choices.options) || !isObject(choices.options[0])
      || typeof choices.options[0].value !== 'string') throw new Error('Expected native Worker choice');
    const preparation = { v: 1, serverId: request.serverId, environmentId: request.environmentId, expectedRevision: 1,
      credentialRef: request.credentialRef, credentialPrincipal: request.credentialPrincipal, sourceMethod: 'upload',
      providerEnvironment: request.providerEnvironment, providerIdentity: { ...request.providerIdentity, providerResourceId: choices.options[0].value } };
    const prepared = linkContent.parse(await kit.invokeAction('workers-inspect', { ...preparation,
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/app' } }));
    const linked = linkContent.parse(await kit.invokeAction('workers-link', { ...preparation, ...prepared }));
    expect(await kit.invokeAction('workers-teardown', inputs.teardown.parse({ ...request,
      credentialPrincipal: linked.credentialPrincipal, providerIdentity: linked.providerIdentity,
      providerEnvironment: linked.providerEnvironment, preparedNative: linked.preparedNative })))
      .toMatchObject({ state: 'succeeded', providerResourceAbsent: true });
    expect(requests.map(request => [request.method, request.url])).toEqual([
      ['GET', `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`],
      ['GET', `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`],
      ['DELETE', root], ['GET', root],
    ]);
    expect(requests.every(request => request.credentialBinding?.kind === 'connectedAccountPurpose'
      && request.credentialBinding.purpose === 'deploy.manage')).toBe(true);
    expect(entry.manifest.contributes.deploymentTargets).toContainEqual(expect.objectContaining({ targetKind: 'cloudflare-workers',
      actions: expect.objectContaining({ teardown: 'workers-teardown' }) }));
  } finally { await kit.dispose(); }
});

it('deletes only the captured native Preview and preserves the production Worker and its shared domains', async () => {
  const { kit, requests } = await fixture(async request => request.method === 'DELETE'
    ? response(200, { success: true }) : response(404));
  try {
    expect(await kit.invokeAction('workers-teardown', input(true))).toMatchObject({ state: 'succeeded', providerResourceAbsent: true });
    expect(requests.map(request => [request.method, request.url])).toEqual([
      ['DELETE', `${root}/previews/${previewId}`], ['GET', `${root}/previews/${previewId}`],
    ]);
  } finally { await kit.dispose(); }
});

it('settles an already absent resource from the exact DELETE 404', async () => {
  const { kit, requests } = await fixture(async () => response(404, { success: false, errors: [{ code: 10007 }] }));
  try {
    expect(await kit.invokeAction('workers-teardown', input())).toMatchObject({ state: 'succeeded', providerResourceAbsent: true });
    expect(requests.map(request => [request.method, request.url])).toEqual([['DELETE', root]]);
  } finally { await kit.dispose(); }
});

it.each([false, true])('observes teardown absence without replaying DELETE (Preview=%s)', async preview => {
  const { kit, requests } = await fixture(async () => response(404));
  try {
    expect(await kit.invokeAction('workers-observe', input(preview))).toMatchObject({ state: 'succeeded', providerResourceAbsent: true });
    expect(requests.map(request => [request.method, request.url])).toEqual([['GET', preview ? `${root}/previews/${previewId}` : root]]);
  } finally { await kit.dispose(); }
});

it('keeps acknowledged deletion unconfirmed while the exact resource remains present', async () => {
  const { kit } = await fixture(async request => response(200, request.method === 'DELETE'
    ? { success: true } : { success: true, result: { id: workerId, name: 'production-worker' } }));
  try {
    await expect(kit.invokeAction('workers-teardown', input())).rejects.toMatchObject({ code: 'outcome_unknown' });
  } finally { await kit.dispose(); }
});

it.each(['bare', 'envelope', 'timeout', 'verification'] as const)('preserves the first cause for uncertain teardown: %s', async failure => {
  const { kit, requests } = await fixture(async request => {
    if (failure === 'timeout') throw Object.assign(new Error('private provider error'), { code: 'ETIMEDOUT' });
    if (failure === 'verification' && request.method === 'DELETE') return response(200, { success: true });
    return response(503, failure === 'envelope' ? { success: false, errors: [{ code: 1000, message: 'private' }] } : undefined);
  });
  try {
    await expect(kit.invokeAction('workers-teardown', input())).rejects.toMatchObject({ code: 'outcome_unknown',
      data: { failureCause: failure === 'timeout' ? { errorCode: 'ETIMEDOUT' }
        : { httpStatus: 503, ...(failure === 'envelope' ? { nativeErrorCode: '1000' } : {}) } } });
    expect(requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
  } finally { await kit.dispose(); }
});

it('retains authorization refusal instead of treating it as resource absence', async () => {
  const { kit } = await fixture(async () => response(403, { success: false, errors: [{ code: 10000 }] }));
  try {
    await expect(kit.invokeAction('workers-teardown', input())).rejects.toMatchObject({ code: 'deployment_access_denied',
      data: { failureCause: { httpStatus: 403, nativeErrorCode: '10000' } } });
  } finally { await kit.dispose(); }
});

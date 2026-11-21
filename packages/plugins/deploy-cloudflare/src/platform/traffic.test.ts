import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';
import { activateAccount } from '../accountRuntime.js';

const credentialRef = { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'selected-profile' };
const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1, credentialRef,
  targetLinkId: 'link', expectedTargetLinkRevision: 1, deploymentId: 'receipt', expectedDeploymentRevision: 1, actionOperationId: 'operation',
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
    localId: 'pages-inspect' }, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } },
  providerIdentity: { providerAccountId: 'account', providerResourceId: 'project-id', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'production' }, preparedNative: { projectName: 'existing-pages' },
  priorDeployment: { environmentId: 'environment', deploymentId: 'prior-receipt', expectedRevision: 1, providerDeploymentId: 'prior-native' } };

// Constructed vectors from Cloudflare's Pages deployment rollback REST schema,
// inspected 2026-11-10. A production deployment is the only valid rollback target.
it('rolls Pages back to the exact retained production deployment through portable Account activation', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: { id: 'prior-native', environment: 'production', latest_stage: { name: 'deploy', status: 'success' }, url: 'https://app.pages.dev' } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction('pages-rollback', input)).resolves.toMatchObject({ state: 'succeeded', providerDeploymentId: 'prior-native' });
    expect(requests.map(request => [request.method, request.url])).toEqual([
      ['POST', 'https://api.cloudflare.com/client/v4/accounts/account/pages/projects/existing-pages/deployments/prior-native/rollback'],
    ]);
    expect(entry.manifest.contributes.deploymentTargets.find(target => target.targetKind === 'cloudflare-pages'))
      .toMatchObject({ actions: { rollback: 'pages-rollback' } });
  } finally { await kit.dispose(); }
});

it('does not send a Pages rollback for a Preview link', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) { requests.push(request); throw new Error('No Preview rollback'); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('pages-rollback', { ...input, providerEnvironment: { kind: 'preview', gitBranch: 'feature' } }))
      .rejects.toMatchObject({ code: 'unsupported_action' });
    expect(requests).toHaveLength(0);
  } finally { await kit.dispose(); }
});

it('keeps a transport-lost Pages rollback unknown and never repeats the mutation', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) { requests.push(request); throw new Error('provider lost'); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('pages-rollback', input)).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(requests.map(request => request.method)).toEqual(['POST']);
  } finally { await kit.dispose(); }
});

it.each(['promote', 'rollback'] as const)('changes Worker traffic for %s to the native version associated with the selected build', async operation => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (request.url === 'https://selected-worker.account-name.workers.dev') {
      expect(request).not.toHaveProperty('credentialBinding');
      return { status: 200, headers: {}, body: new Uint8Array() };
    }
    const path = new URL(request.url).pathname;
    const result = path.endsWith('/scripts/selected-worker/subdomain') ? { enabled: true }
      : path.endsWith('/workers/subdomain') ? { subdomain: 'account-name' }
      : path.endsWith('/versions') ? { items: [{ id: 'native-version' }] }
      : path.endsWith('/builds/builds') ? { builds: { association: { build_uuid: 'prior-native' } } }
        : { id: 'traffic-deployment', strategy: 'percentage', versions: [{ version_id: 'native-version', percentage: 100 }] };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction(`workers-${operation}`, { ...input, providerEnvironment: { kind: 'script', scriptName: 'selected-worker' } }))
      .resolves.toMatchObject({ state: 'succeeded', providerDeploymentId: 'version:native-version',
        builtInUrls: ['https://selected-worker.account-name.workers.dev'] });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/client/v4/accounts/account/workers/scripts/selected-worker/versions'],
      ['GET', '/client/v4/accounts/account/builds/builds'],
      ['POST', '/client/v4/accounts/account/workers/scripts/selected-worker/deployments'],
      ['GET', '/client/v4/accounts/account/workers/scripts/selected-worker/subdomain'],
      ['GET', '/client/v4/accounts/account/workers/subdomain'],
      ['GET', '/'],
    ]);
    expect(new URL(requests[0]!.url).searchParams.get('deployable')).toBe('true');
    expect(JSON.parse(new TextDecoder().decode(requests[2]!.body))).toEqual({ strategy: 'percentage', versions: [{ version_id: 'native-version', percentage: 100 }] });
  } finally { await kit.dispose(); }
});

it('refuses a Worker build associated with several versions instead of guessing a version', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    const result = new URL(request.url).pathname.endsWith('/versions') ? { items: [{ id: 'one' }, { id: 'two' }] }
      : { builds: { association: { build_uuid: 'prior-native' } } };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('workers-rollback', { ...input, providerEnvironment: { kind: 'script', scriptName: 'selected-worker' } }))
      .rejects.toMatchObject({ code: 'deployment_conflict' });
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  } finally { await kit.dispose(); }
});

it('uses an uploaded Worker version reference directly and retains an unconfirmed traffic result as unknown', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: { id: 'traffic-deployment', strategy: 'percentage', versions: [{ version_id: 'different-version', percentage: 100 }] } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('workers-promote', { ...input, providerEnvironment: { kind: 'script', scriptName: 'selected-worker' },
      priorDeployment: { ...input.priorDeployment, providerDeploymentId: 'version:native-version' } }))
      .resolves.toMatchObject({ state: 'outcome_unknown', providerDeploymentId: 'version:native-version' });
    expect(requests.map(request => request.method)).toEqual(['POST']);
  } finally { await kit.dispose(); }
});

it('refuses a native Preview deployment as a production traffic version before sending provider requests', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result: { items: [] } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('workers-promote', { ...input, providerEnvironment: { kind: 'script', scriptName: 'selected-worker' },
      priorDeployment: { ...input.priorDeployment, providerDeploymentId: 'preview-deployment:native-preview' } }))
      .rejects.toMatchObject({ code: 'unsupported_action' });
    expect(requests).toHaveLength(0);
  } finally { await kit.dispose(); }
});

it.each([
  { operation: 'promote', percentage: 10, state: 'outcome_unknown' },
  { operation: 'rollback', percentage: 100, state: 'succeeded' },
  { operation: 'deploy', percentage: 10, state: 'succeeded' },
])('observes retained Worker $operation at $percentage% as $state', async ({ operation, percentage, state }) => {
  const http = createPluginHttpFixture({ async request() {
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: { deployments: [{ versions: [{ version_id: 'native-version', percentage },
        ...(percentage < 100 ? [{ version_id: 'other-version', percentage: 100 - percentage }] : [])] }] } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    const { priorDeployment: _prior, ...retained } = input;
    await expect(kit.invokeAction('workers-observe', { ...retained, operation,
      providerEnvironment: { kind: 'script', scriptName: 'selected-worker' }, providerDeploymentId: 'version:native-version' }))
      .resolves.toMatchObject({ state, providerDeploymentId: 'version:native-version' });
  } finally { await kit.dispose(); }
});

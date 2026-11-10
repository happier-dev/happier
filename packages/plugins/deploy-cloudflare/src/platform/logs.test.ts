import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';
import { activateAccount } from '../accountRuntime.js';

const account = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'fixture' };
const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  targetLinkId: 'link', expectedTargetLinkRevision: 1, deploymentId: 'receipt', expectedDeploymentRevision: 1,
  actionOperationId: 'operation', providerDeploymentId: 'deployment-exact', credentialRef: account,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
    consumer: { pluginId: entry.manifest.id, localId: 'pages-inspect' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
  providerIdentity: { providerAccountId: 'a'.repeat(32), providerResourceId: 'project-exact', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'production' }, preparedNative: { projectName: 'my-project', pages: { projectMode: 'gitIntegration', productionBranch: 'main' } } };

it.each(['daemon-root', 'portable-account'] as const)('reads retained Pages build logs through %s', async target => {
  const requests: HttpRequest[] = [];
  // Constructed from Cloudflare Pages deployment history/logs schema, 2026-11-10.
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: { data: [{ line: 'Build started', ts: '2026-11-10T10:00:00Z' },
        { line: 'Build complete\n', ts: '2026-11-10T10:00:01Z' }], total: 2, includes_container_logs: true,
      privateEcho: 'provider-private-field' } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest,
    module: target === 'daemon-root' ? entry : { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction('pages-build-logs-read', input)).resolves.toEqual({ kind: 'page', page: {
      sourceRevision: 'deployment-exact', text: 'Build started\nBuild complete\n', nextCursor: null, truncated: false } });
    expect(requests).toHaveLength(1); // One demanded read, no observation/deploy/retry.
    expect(new URL(requests[0]!.url).pathname).toBe(`/client/v4/accounts/${input.providerIdentity.providerAccountId}/pages/projects/my-project/deployments/deployment-exact/history/logs`);
    expect(requests[0]).toMatchObject({ method: 'GET', credentialBinding: { kind: 'connectedAccountPurpose',
      purpose: 'deploy.manage', origin: 'https://api.cloudflare.com', method: 'GET', headerNames: ['authorization'] } });
  } finally { await kit.dispose(); }
});

it.each([
  { result: { data: [], total: 0, includes_container_logs: false }, text: '', truncated: false },
  { result: { data: [{ line: 'available', ts: '2026-11-10T10:00:00Z' }], total: 2, includes_container_logs: true }, text: 'available\n', truncated: true },
  { result: { data: [{ line: 42, ts: '2026-11-10T10:00:00Z' }], total: 1, includes_container_logs: true }, code: 'provider_response_invalid' },
  { result: { data: [], total: 'unknown', includes_container_logs: true }, code: 'provider_response_invalid' },
  { status: 403, code: 'deployment_access_denied' },
  { status: 404, code: 'deployment_unavailable' },
])('preserves empty, partial and failed Pages log outcomes ($code)', async sample => {
  const http = createPluginHttpFixture({ async request() { return { status: sample.status ?? 200, headers: {},
    body: new TextEncoder().encode(JSON.stringify({ success: true, result: sample.result })) }; } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const result = kit.invokeAction('pages-build-logs-read', input);
    if (sample.code) await expect(result).rejects.toMatchObject({ code: sample.code, details: { phase: 'build' } });
    else await expect(result).resolves.toMatchObject({ kind: 'page', page: { text: sample.text, truncated: sample.truncated, nextCursor: null } });
  } finally { await kit.dispose(); }
});

it('does not request provider logs for another deployment cursor', async () => {
  const http = createPluginHttpFixture({ async request() { throw new Error('Foreign source cursor'); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('pages-build-logs-read', { ...input, cursor: { sourceRevision: 'other', token: '' } }))
      .resolves.toEqual({ kind: 'source-changed', sourceRevision: 'deployment-exact' });
  } finally { await kit.dispose(); }
});

it('uses retained project coordinates without requiring unrelated deployment configuration', async () => {
  const http = createPluginHttpFixture({ async request() { return { status: 200, headers: {},
    body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: { data: [], total: 0, includes_container_logs: false } })) }; } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('pages-build-logs-read', { ...input, preparedNative: { projectName: 'my-project' } }))
      .resolves.toMatchObject({ kind: 'page', page: { text: '', truncated: false } });
  } finally { await kit.dispose(); }
});

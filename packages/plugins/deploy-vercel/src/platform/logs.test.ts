import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';
import { activateAccount } from '../account.js';

const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'fixture' };
const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  targetLinkId: 'link', expectedTargetLinkRevision: 1, deploymentId: 'receipt', expectedDeploymentRevision: 1,
  actionOperationId: 'operation', providerDeploymentId: 'dpl_exact', credentialRef: account,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
    consumer: { pluginId: entry.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
  providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_exact', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'production' } };

it.each([
  { target: 'daemon-root', environment: 'production' }, { target: 'daemon-root', environment: 'preview' },
  { target: 'portable-account', environment: 'production' }, { target: 'portable-account', environment: 'preview' },
] as const)('reads complete $environment build text through the target Action on $target', async ({ target, environment }) => {
  const requests: HttpRequest[] = [];
  // Constructed vectors from Vercel's v3 deployment-events REST schema, 2026-11-07.
  const events = [{ type: 'command', text: 'pnpm build', created: 1 },
    { type: 'stdout', payload: { text: 'Build complete\n' }, created: 2 }, { type: 'deployment-state', created: 3 }];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(events)) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest,
    module: target === 'daemon-root' ? entry : { ...entry, activateAccount }, services: { http } });
  try {
    expect(await kit.invokeAction('build-logs-read', { ...input,
      providerIdentity: { ...input.providerIdentity, providerEnvironment: environment },
      providerEnvironment: environment === 'preview' ? { kind: 'preview', gitBranch: 'feature/logs' } : { kind: 'production' },
    })).toEqual({ kind: 'page', page: {
      sourceRevision: 'dpl_exact', text: 'pnpm build\nBuild complete\n', nextCursor: null, truncated: false } });
    expect(requests).toHaveLength(1); // One demanded finite read; no inspect, polling or retry.
    const request = requests[0]!;
    expect(new URL(request.url).pathname).toBe('/v3/deployments/dpl_exact/events');
    expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({ teamId: 'team_exact', direction: 'forward', follow: '0', limit: '-1' });
    expect(request).toMatchObject({ method: 'GET', credentialBinding: {
      kind: 'connectedAccountPurpose', purpose: 'deploy.manage', origin: 'https://api.vercel.com', method: 'GET', headerNames: ['authorization'] } });
    expect(entry.manifest.contributes.deploymentTargets[0]).toMatchObject({ actions: { logs: { build: 'build-logs-read' } } });
  } finally { await kit.dispose(); }
});

it('reports a cursor from another deployment without requesting provider logs', async () => {
  const http = createPluginHttpFixture({ async request() { throw new Error('A foreign source cursor must not read provider logs'); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('build-logs-read', { ...input, cursor: { sourceRevision: 'dpl_other', token: '' } }))
      .resolves.toEqual({ kind: 'source-changed', sourceRevision: 'dpl_exact' });
  } finally { await kit.dispose(); }
});

it.each([
  { status: 200, body: [], expected: { kind: 'page', page: { text: '', truncated: false } } },
  { status: 403, body: { secret: 'vendor-private-body' }, code: 'deployment_access_denied' },
  { status: 404, body: {}, code: 'deployment_unavailable' },
  { status: 500, body: {}, code: 'provider_request_failed' },
  { status: 200, body: {}, code: 'provider_response_invalid' },
  { status: 200, body: [{ type: 'stdout', text: 123 }], code: 'provider_response_invalid' },
])('settles empty or failed build reads honestly ($status, $code)', async sample => {
  const http = createPluginHttpFixture({ async request() {
    return { status: sample.status, headers: {}, body: new TextEncoder().encode(JSON.stringify(sample.body)) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const result = kit.invokeAction('build-logs-read', input);
    if (sample.code) await expect(result).rejects.toMatchObject({ code: sample.code, retryable: false, details: { phase: 'build' } });
    else await expect(result).resolves.toMatchObject(sample.expected!);
  } finally { await kit.dispose(); }
});

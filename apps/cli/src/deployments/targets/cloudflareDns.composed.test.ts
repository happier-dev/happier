import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { createDomainDnsActionsForHost } from './domainDnsActionsForHost.js';
import * as entry from '../../../../../packages/plugins/deploy-cloudflare/src/index.js';
import { activateAccount } from '../../../../../packages/plugins/deploy-cloudflare/src/accountRuntime.js';

const credentialRef = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'fixture' };
const input = { serverId: 'home', environmentId: 'environment', domainId: 'domain', expectedDomainRevision: 4,
  expectedRevision: 2, requestKey: 'dns-create', dns: { action: { pluginId: credentialRef.service.pluginId, localId: 'records-create' },
    credentialRef, zoneId: 'zone', ttl: 300 } };
const dns = [{ name: 'app.example.test', type: 'CNAME', value: 'target.vercel-dns.com' },
  { name: '_proof.app.example.test', type: 'TXT', value: 'verification' }];
const content = { hostname: 'app.example.test', target: { kind: 'provider' }, providerObservation: {
  v: 1, hostname: 'app.example.test', state: 'pending', dns } };
const domain = { v: 1, id: 'domain', environmentId: 'environment', targetLinkId: 'link', revision: 4, state: 'pending',
  contentArtifactId: 'artifact', contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1 };

it.each(['daemon-root', 'portable-account'] as const)('writes the retained reviewed Domain records through the %s plugin HTTP leaf', async target => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    const body = request.method === 'GET' ? [] : { id: 'record', ...JSON.parse(new TextDecoder().decode(request.body)) };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result: body,
      ...(request.method === 'GET' ? { result_info: { page: 1, total_pages: 1 } } : {}) })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest,
    module: target === 'daemon-root' ? entry : { ...entry, activateAccount }, services: { http } });
  // The storage/artifact ports are network boundaries; preparation, child admission, plugin activation and schemas stay real.
  const owner = createDomainDnsActionsForHost({
    readEnvironment: async () => ({ environment: { revision: 2 } }),
    storage: async () => ({ ok: true, environmentId: 'environment', revision: 2, domain }),
    open: async () => ({ artifactId: 'artifact', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { kind: 'deployment-domain.v1', title: 'App' }, body: JSON.stringify(content) }),
  } as Parameters<typeof createDomainDnsActionsForHost>[0]);
  const actionId = 'deployments.domains.dns.create';
  const surface = target === 'daemon-root' ? 'cli' as const : 'ui' as const;
  const context = { surface, authority: 'present_user' as const, serverId: 'home', signal: new AbortController().signal };
  try {
    const plan = await owner({ actionId, input, context });
    if (!plan || !('children' in plan)) throw new Error('Missing reviewed DNS children');
    const port = createHostReviewedChildPortV1({ actionId, input, context, plan, reviewAdmitted: true,
      policies: plan.children.map(child => ({ action: child.action, role: child.role!, surface })),
      execute: async envelope => ({ ok: true, result: await kit.invokeAction(envelope.action.localId, envelope.input, { surface }) }),
    });
    await expect(owner.execute(actionId, input, { ...context, hostReviewedChild: port })).resolves.toMatchObject({
      ok: true, result: { records: [{ result: { kind: 'configured' } }, { result: { kind: 'configured' } }] },
    });
    expect(requests.filter(request => request.method === 'POST').map(request => ({
      path: new URL(request.url).pathname, body: JSON.parse(new TextDecoder().decode(request.body)), binding: request.credentialBinding,
    }))).toEqual(dns.map(record => ({ path: '/client/v4/zones/zone/dns_records',
      body: { name: record.name, type: record.type, content: record.value, ttl: 300, proxied: false },
      binding: { kind: 'connectedAccountPurpose', purpose: 'deploy.manage', origin: 'https://api.cloudflare.com', method: 'POST', headerNames: ['authorization'] },
    })));
  } finally { await kit.dispose(); }
});

it('verifies existing values read-only and does not replay an already configured record', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: [{ id: 'existing', name: 'app.example.test', type: 'CNAME', content: 'target.vercel-dns.com', ttl: 300, proxied: false }],
      result_info: { page: 1, total_pages: 1 } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  const record = { credentialRef, zoneId: 'zone', name: 'app.example.test.', type: 'CNAME', values: ['target.vercel-dns.com'], ttl: 300 };
  try {
    await expect(kit.invokeAction('records-create', record)).resolves.toEqual({ kind: 'configured' });
    await expect(kit.invokeAction('records-verify', record)).resolves.toEqual({ kind: 'configured' });
    await expect(kit.invokeAction('records-verify', { ...record, values: ['another.vercel-dns.com'] })).resolves.toEqual({ kind: 'pending' });
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  } finally { await kit.dispose(); }
});

it.each(['denied', 'lost-acknowledgement'] as const)('retains %s at the Cloudflare boundary without retrying the write', async failure => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (request.method === 'POST' && failure === 'lost-acknowledgement') throw new Error('Connection lost after send');
    return { status: request.method === 'POST' ? 403 : 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(
      request.method === 'POST' ? { success: false, errors: [{ code: 9109, message: 'Denied' }] }
        : { success: true, result: [], result_info: { page: 1, total_pages: 1 } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  const record = { credentialRef, zoneId: 'zone', name: 'app.example.test.', type: 'CNAME', values: ['target.vercel-dns.com'], ttl: 300 };
  try {
    const result = kit.invokeAction('records-create', record);
    if (failure === 'denied') await expect(result).rejects.toMatchObject({ code: 'deployment_access_denied',
      data: { failureCause: { httpStatus: 403, nativeErrorCode: '9109' } } });
    else await expect(result).resolves.toEqual({ kind: 'unknown', code: 'outcome_unknown' });
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  } finally { await kit.dispose(); }
});

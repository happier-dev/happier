import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';
import { activateAccount } from '../account.js';

const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'fixture' };
const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  targetLinkId: 'link', expectedTargetLinkRevision: 1, credentialRef: account,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
    consumer: { pluginId: entry.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
  providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_exact', providerEnvironment: 'preview:main' },
  providerEnvironment: { kind: 'preview', gitBranch: 'main' }, domainId: 'domain', domain: { hostname: 'app.example.test' } };

it('adds, checks and removes only the exact preview Domain without changing DNS configuration', async () => {
  const requests: HttpRequest[] = [];
  let removed = false;
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (removed) return { status: 404, headers: {}, body: new TextEncoder().encode(JSON.stringify({ error: { code: 'not_found' } })) };
    if (new URL(request.url).pathname.endsWith('/config')) {
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ misconfigured: false })) };
    }
    if (request.method === 'DELETE') {
      removed = true;
      return { status: 200, headers: {}, body: new TextEncoder().encode('"removed"') };
    }
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
      name: 'app.example.test', projectId: 'prj_exact', gitBranch: 'main', verified: false,
      verification: [{ type: 'TXT', domain: '_vercel.app.example.test', value: 'verification-token' }] })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    expect(entry.manifest.contributes.deploymentTargets?.[0]).toMatchObject({ actions: { domains: {
      add: 'domains-add', read: 'domains-read', verify: 'domains-verify', remove: 'domains-remove' } } });
    for (const action of ['domains-add', 'domains-verify']) {
      await expect(kit.invokeAction(action, input)).resolves.toMatchObject({ v: 1, hostname: 'app.example.test', state: 'pending',
        dns: [{ type: 'TXT', name: '_vercel.app.example.test', value: 'verification-token' }] });
    }
    await expect(kit.invokeAction('domains-remove', input)).resolves.toMatchObject({ state: 'removed' });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['POST', '/v10/projects/prj_exact/domains'], ['GET', '/v6/domains/app.example.test/config'],
      ['POST', '/v9/projects/prj_exact/domains/app.example.test/verify'], ['GET', '/v6/domains/app.example.test/config'],
      ['GET', '/v9/projects/prj_exact/domains/app.example.test'],
      ['DELETE', '/v9/projects/prj_exact/domains/app.example.test'],
      ['GET', '/v9/projects/prj_exact/domains/app.example.test'],
    ]);
    expect(requests.every(request => new URL(request.url).searchParams.get('teamId') === 'team_exact')).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(requests[0]!.body))).toEqual({ name: 'app.example.test', gitBranch: 'main' });
  } finally { await kit.dispose(); }
});

it.each(['already absent', 'DELETE returns 404'] as const)('settles Domain removal from the Vercel 404 fact (%s)', async shape => {
  let absent = shape === 'already absent';
  const http = createPluginHttpFixture({ async request(request) {
    if (request.method === 'DELETE') absent = true;
    return { status: absent ? 404 : 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(absent
      ? { error: { code: 'not_found' } }
      : { name: input.domain.hostname, projectId: 'prj_exact', gitBranch: 'main', verified: true })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try { await expect(kit.invokeAction('domains-remove', input)).resolves.toMatchObject({ state: 'removed' }); }
  finally { await kit.dispose(); }
});

it('keeps Domain removal uncertain when Vercel acknowledges DELETE but still returns the Domain', async () => {
  const http = createPluginHttpFixture({ async request(request) {
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(request.method === 'DELETE' ? 'removed'
      : { name: input.domain.hostname, projectId: 'prj_exact', gitBranch: 'main', verified: true })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try { await expect(kit.invokeAction('domains-remove', input)).rejects.toMatchObject({ code: 'outcome_unknown' }); }
  finally { await kit.dispose(); }
});

it('retains an ambiguous remote mutation without retrying or reporting absence', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) { requests.push(request); throw new Error('transport lost'); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction('domains-add', input)).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(requests.map(request => request.method)).toEqual(['POST']);
  } finally { await kit.dispose(); }
});


it('returns routing records with ownership challenges and stays pending until both are satisfied', async () => {
  let verified = false;
  let misconfigured = true;
  const http = createPluginHttpFixture({ async request(request) {
    const config = new URL(request.url).pathname.endsWith('/config');
    const body = config ? { misconfigured, recommendedCNAME: [{ rank: 1, value: 'project.vercel-dns.example' }] }
      : { name: 'app.example.test', projectId: 'prj_exact', gitBranch: 'main', verified,
        verification: verified ? [] : [{ type: 'TXT', domain: '_vercel.app.example.test', value: 'ownership' }] };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction('domains-read', input)).resolves.toMatchObject({ state: 'pending', dns: [
      { type: 'TXT', name: '_vercel.app.example.test', value: 'ownership' },
      { type: 'CNAME', name: 'app.example.test', value: 'project.vercel-dns.example' },
    ] });
    misconfigured = false;
    await expect(kit.invokeAction('domains-read', input)).resolves.toMatchObject({ state: 'pending', dns: [
      { type: 'TXT', name: '_vercel.app.example.test', value: 'ownership' },
    ] });
    verified = true;
    await expect(kit.invokeAction('domains-read', input)).resolves.toEqual({ v: 1, hostname: 'app.example.test', state: 'active', dns: [] });
    misconfigured = true;
    await expect(kit.invokeAction('domains-read', input)).resolves.toMatchObject({ state: 'pending', dns: [
      { type: 'CNAME', name: 'app.example.test', value: 'project.vercel-dns.example' },
    ] });
  } finally { await kit.dispose(); }
});


it.each([
  ['example.test', [{ type: 'A', name: 'example.test', value: '192.0.2.1' }]],
  ['app.example.test', [{ type: 'CNAME', name: 'app.example.test', value: 'preferred.vercel-dns.example' }]],
])('offers only the preferred, non-conflicting routing records for %s', async (hostname, dns) => {
  const http = createPluginHttpFixture({ async request(request) {
    const config = new URL(request.url).pathname.endsWith('/config');
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(config ? {
      misconfigured: true,
      recommendedCNAME: [{ rank: 2, value: 'secondary.vercel-dns.example' }, { rank: 1, value: 'preferred.vercel-dns.example' }],
      recommendedIPv4: [{ rank: 2, value: ['192.0.2.2'] }, { rank: 1, value: ['192.0.2.1'] }],
    } : { name: hostname, apexName: 'example.test', projectId: 'prj_exact', gitBranch: 'main', verified: true })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction('domains-read', { ...input, domain: { hostname } })).resolves.toEqual({ v: 1, hostname, state: 'pending', dns });
  } finally { await kit.dispose(); }
});

it('requests ownership verification when the person checks the Vercel Domain again', async () => {
  let verified = false;
  const methods: string[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    const path = new URL(request.url).pathname;
    methods.push(`${request.method} ${path}`);
    if (request.method === 'POST' && path.endsWith('/verify')) verified = true;
    const body = path.endsWith('/config') ? { misconfigured: false }
      : { name: 'app.example.test', projectId: 'prj_exact', gitBranch: 'main', verified,
        verification: verified ? [] : [{ type: 'TXT', domain: '_vercel.app.example.test', value: 'ownership' }] };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    const result = await kit.invokeAction('domains-verify', input);
    expect(methods).toContain('POST /v9/projects/prj_exact/domains/app.example.test/verify');
    expect(result).toMatchObject({ state: 'active' });
  } finally { await kit.dispose(); }
});

it.each([400, 403])('retains pending ownership instructions and the native verification cause after HTTP %s', async status => {
  const http = createPluginHttpFixture({ async request(request) {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path.endsWith('/verify')) return { status, headers: {},
      body: new TextEncoder().encode(JSON.stringify({ error: { code: 'verification_failed' } })) };
    const body = path.endsWith('/config') ? { misconfigured: false }
      : { name: 'app.example.test', projectId: 'prj_exact', gitBranch: 'main', verified: false,
        verification: [{ type: 'TXT', domain: '_vercel.app.example.test', value: 'ownership' }] };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction('domains-verify', input)).resolves.toMatchObject({ state: 'pending', dns: [
      { type: 'TXT', name: '_vercel.app.example.test', value: 'ownership' },
    ], failureCause: { httpStatus: status, errorCode: 'verification_failed' } });
  } finally { await kit.dispose(); }
});

it('keeps a token denied domain access as a typed refusal rather than pending ownership', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 403, headers: {}, body: new TextEncoder().encode(JSON.stringify({ error: { code: 'forbidden' } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction('domains-verify', input)).rejects.toMatchObject({ code: 'deployment_access_denied',
      data: { failureCause: { httpStatus: 403, errorCode: 'forbidden' } } });
    expect(requests.map(request => request.method)).toEqual(['POST', 'GET']);
  } finally { await kit.dispose(); }
});

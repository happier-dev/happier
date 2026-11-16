import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';
import { activateAccount } from '../accountRuntime.js';

const account = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'fixture' };
const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  targetLinkId: 'link', expectedTargetLinkRevision: 1, credentialRef: account,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
    consumer: { pluginId: entry.manifest.id, localId: 'pages-inspect' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
  providerIdentity: { providerAccountId: 'a'.repeat(32), providerResourceId: 'project-exact', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'production' }, preparedNative: { projectName: 'my-project' },
  domainId: 'domain', domain: { hostname: 'app.example.test' } };

it.each(['daemon-root', 'portable-account'] as const)('keeps Pages pending DNS and verifies without a provider mutation through %s', async target => {
  const requests: HttpRequest[] = [];
  let removed = false;
  let canReadDomain = false;
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/my-project')) return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: { id: 'project-exact', name: 'my-project', subdomain: 'my-project.pages.dev' } })) };
    if (request.method === 'DELETE') {
      removed = true;
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result: {} })) };
    }
    if (request.method === 'GET' && !canReadDomain) throw new Error('Add acknowledgement needs no subsequent read');
    return { status: removed && request.method === 'GET' ? 404 : 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: { name: 'app.example.test', status: 'pending', validation_data: { method: 'txt', status: 'pending',
        txt_name: '_validation.app.example.test', txt_value: 'validation-token' } } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: target === 'daemon-root' ? entry : { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction('pages-domains-add', input)).resolves.toMatchObject({
      hostname: input.domain.hostname, state: 'pending', dns: expect.arrayContaining([{ type: 'TXT', name: '_validation.app.example.test', value: 'validation-token' }]) });
    canReadDomain = true;
    await expect(kit.invokeAction('pages-domains-verify', input)).resolves.toMatchObject({ state: 'pending' });
    await expect(kit.invokeAction('pages-domains-remove', input)).resolves.toMatchObject({ state: 'removed' });
    expect(requests.filter(request => request.method !== 'GET').map(request => request.method)).toEqual(['POST', 'DELETE']);
  } finally { await kit.dispose(); }
});

it('attaches and removes only the Worker and explicit selected zone', async () => {
  const requests: HttpRequest[] = [];
  const row = { id: 'native-domain', hostname: input.domain.hostname, service: 'worker-exact', environment: 'production',
    enabled: true, zone_id: 'zone-exact', zone_name: 'example.test' };
  let exists = false;
  let acknowledgedMutation = false;
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (request.method === 'GET' && acknowledgedMutation && exists) throw new Error('Add acknowledgement needs no subsequent read');
    if (request.method === 'PUT') { exists = true; acknowledgedMutation = true; }
    if (request.method === 'DELETE') {
      exists = false; acknowledgedMutation = true;
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true })) };
    }
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: request.method === 'GET' ? exists ? [row] : [] : row })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  const selected = { ...input, providerEnvironment: { kind: 'script', scriptName: 'worker-exact' },
    domain: { ...input.domain, zone: { zoneId: 'zone-exact', name: 'example.test' } } };
  try {
    await expect(kit.invokeAction('workers-domains-add', selected)).resolves.toMatchObject({ state: 'active' });
    acknowledgedMutation = false;
    await expect(kit.invokeAction('workers-domains-verify', selected)).resolves.toMatchObject({ state: 'active' });
    await expect(kit.invokeAction('workers-domains-remove', selected)).resolves.toMatchObject({ state: 'removed' });
    const write = requests.find(request => request.method === 'PUT')!;
    expect(JSON.parse(new TextDecoder().decode(write.body))).toEqual({ hostname: input.domain.hostname,
      service: 'worker-exact', enabled: true, zone_id: 'zone-exact', zone_name: 'example.test' });
    expect(requests.filter(request => request.method === 'DELETE').map(request => new URL(request.url).pathname))
      .toEqual([`/client/v4/accounts/${input.providerIdentity.providerAccountId}/workers/domains/native-domain`]);
  } finally { await kit.dispose(); }
});

it.each(['workers', 'pages'] as const)('settles Domain removal from observed absence after a lost %s DELETE response', async product => {
  let exists = true;
  const http = createPluginHttpFixture({ async request(request) {
    if (request.method === 'DELETE') { exists = false; throw new Error('response lost after provider removal'); }
    const project = new URL(request.url).pathname.endsWith('/my-project');
    const value = project ? { id: 'project-exact', name: 'my-project', subdomain: 'my-project.pages.dev' }
      : product === 'workers' ? exists ? [{ id: 'native-domain', hostname: input.domain.hostname,
        service: 'worker-exact', enabled: true, zone_id: 'zone-exact', zone_name: 'example.test' }] : []
      : { name: input.domain.hostname, status: 'active' };
    return { status: !project && product === 'pages' && !exists ? 404 : 200, headers: {},
      body: new TextEncoder().encode(JSON.stringify({ success: true, result: value })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction(`${product}-domains-remove`, { ...input,
      ...(product === 'workers' ? { providerEnvironment: { kind: 'script', scriptName: 'worker-exact' },
        domain: { ...input.domain, zone: { zoneId: 'zone-exact', name: 'example.test' } } } : {}) }))
      .resolves.toMatchObject({ state: 'removed' });
  } finally { await kit.dispose(); }
});

it.each(['workers', 'pages'] as const)('keeps Domain removal uncertain when %s acknowledges DELETE but still lists the Domain', async product => {
  const http = createPluginHttpFixture({ async request(request) {
    const project = new URL(request.url).pathname.endsWith('/my-project');
    const value = project ? { id: 'project-exact', name: 'my-project', subdomain: 'my-project.pages.dev' }
      : product === 'workers' ? [{ id: 'native-domain', hostname: input.domain.hostname,
        service: 'worker-exact', enabled: true, zone_id: 'zone-exact', zone_name: 'example.test' }]
      : { name: input.domain.hostname, status: 'active' };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(request.method === 'DELETE'
      ? { success: true } : { success: true, result: value })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction(`${product}-domains-remove`, { ...input,
      ...(product === 'workers' ? { providerEnvironment: { kind: 'script', scriptName: 'worker-exact' },
        domain: { ...input.domain, zone: { zoneId: 'zone-exact', name: 'example.test' } } } : {}) }))
      .rejects.toMatchObject({ code: 'outcome_unknown' });
  } finally { await kit.dispose(); }
});

it.each([undefined, { zoneId: '', name: 'example.test' }])('requires an explicit valid Workers zone before provider writes (%j)', async zone => {
  const http = createPluginHttpFixture({ async request() { throw new Error('Invalid zone must not reach Cloudflare'); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('workers-domains-add', { ...input,
      providerEnvironment: { kind: 'script', scriptName: 'worker-exact' },
      domain: { ...input.domain, ...(zone === undefined ? {} : { zone }) } })).rejects.toMatchObject({
        code: expect.stringMatching(/^(deployment_invalid|plugin_action_input_schema_invalid)$/),
      });
  } finally { await kit.dispose(); }
});

it.each([
  { action: 'pages-domains-add', providerEnvironment: { kind: 'preview', gitBranch: 'main' } },
  { action: 'workers-domains-add', providerEnvironment: { kind: 'preview', scriptName: 'worker-exact', previewName: 'candidate' } },
])('refuses Preview Domains before touching production ($action)', async ({ action, providerEnvironment }) => {
  const http = createPluginHttpFixture({ async request() { throw new Error('Preview must not mutate project-wide Domains'); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try { await expect(kit.invokeAction(action, { ...input, providerEnvironment }))
    .rejects.toMatchObject({ code: 'unsupported_action' }); } finally { await kit.dispose(); }
});

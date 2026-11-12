import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';
import { recordedVercelEnvironment } from './fixtures/environmentResponse.js';

const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'fixture' };
const common = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  targetLinkId: 'link', expectedTargetLinkRevision: 1, credentialRef: account,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
    consumer: { pluginId: entry.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
  providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_exact', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'production' } };

// Constructed vectors follow Vercel's project-env GET/POST/DELETE schemas,
// inspected 2026-11-10. Provider values deliberately appear in list/write echoes.
it('preserves foreign keys and removes owned keys when secret custody is unavailable', async () => {
  const requests: HttpRequest[] = [];
  const privateValue = 'fixture-private-provider-variable';
  const savedRef = 'happier:shared-secret:v1:token';
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    const body = request.method === 'GET' ? { envs: [
      { id: 'foreign-id', key: 'FOREIGN', type: 'sensitive', target: ['production'], updatedAt: 10, value: privateValue },
      { id: 'old-id', key: 'OLD', type: 'sensitive', target: ['production'], updatedAt: 20, value: privateValue },
      { id: 'preview-id', key: 'PREVIEW', type: 'plain', target: ['preview'], value: 'preview-only' },
    ] } : request.method === 'POST' ? { created: { id: 'new-id', key: 'TOKEN', type: 'sensitive', target: ['production'], updatedAt: 30, value: privateValue }, failed: [] } : {};
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const result = await kit.invokeAction('variables-sync', { ...common, desiredRevision: 2,
      owned: [{ key: 'OLD', providerId: 'old-id', desiredRevision: 1, providerRevision: '20' }],
      set: [{ purpose: 'variable', phase: 'runtime', name: 'TOKEN', source: { kind: 'secret', ref: savedRef, resourceRevision: 3 } }],
      remove: ['OLD'], useOurs: [], keepTheirs: [] });
    expect(result).toMatchObject({ v: 1, owned: [], failures: [{ key: 'TOKEN', code: 'outcome_unknown' }] });
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/v10/projects/prj_exact/env'], ['DELETE', '/v9/projects/prj_exact/env/old-id'],
    ]);
    expect(entry.manifest.contributes.deploymentTargets[0]).toMatchObject({ actions: { variables: { read: 'variables-read', sync: 'variables-sync' } } });
  } finally { await kit.dispose(); }
});

it('requires the reviewed Use ours choice for drift and relinquishes Keep theirs without an external write', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ envs: [
      { id: 'changed', key: 'TOKEN', type: 'plain', target: ['production'], updatedAt: 30, value: 'vendor-change' },
      { id: 'keep', key: 'KEEP', type: 'plain', target: ['production'], updatedAt: 40, value: 'vendor-choice' },
      { id: 'foreign', key: 'FOREIGN', type: 'plain', target: ['production'], value: 'unowned' },
    ] })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const result = await kit.invokeAction('variables-sync', { ...common, desiredRevision: 2,
      owned: [{ key: 'TOKEN', providerId: 'changed', desiredRevision: 1, providerRevision: '20' },
        { key: 'KEEP', providerId: 'keep', desiredRevision: 1, providerRevision: '20' }],
      set: [{ purpose: 'variable', phase: 'runtime', name: 'TOKEN', source: { kind: 'value', value: 'desired' } }],
      remove: ['KEEP', 'FOREIGN'], useOurs: [], keepTheirs: ['KEEP'] });
    expect(result).toMatchObject({ owned: [{ key: 'TOKEN', providerId: 'changed', desiredRevision: 1, providerRevision: '20' }],
      failures: [{ key: 'TOKEN', code: 'deployment_conflict' }] });
    expect(requests.map(request => request.method)).toEqual(['GET']);
  } finally { await kit.dispose(); }
});

it.each([
  { environment: { kind: 'production' }, target: ['production', 'preview'], customEnvironmentIds: [],
    remainingTarget: ['preview'], remainingCustom: [] },
  { environment: { kind: 'custom', id: 'custom-here' }, target: ['preview'], customEnvironmentIds: ['custom-here', 'custom-other'],
    remainingTarget: ['preview'], remainingCustom: ['custom-other'] },
])('removes owned scope $environment.kind while preserving other environments on the provider row', async sample => {
  // HTTP owns the provider state. A whole-row DELETE destroys the other scope.
  let row: Record<string, unknown> | null = { id: 'shared-row', key: 'TOKEN', type: 'sensitive',
    target: sample.target, customEnvironmentIds: sample.customEnvironmentIds, updatedAt: 20, value: 'private-echo' };
  const http = createPluginHttpFixture({ async request(request) {
    if (request.method === 'DELETE') row = null;
    if (request.method === 'PATCH') row = { ...row, ...JSON.parse(new TextDecoder().decode(request.body)) };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(
      request.method === 'GET' ? { envs: row ? [row] : [] } : row ?? {})) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const result = await kit.invokeAction('variables-sync', { ...common, providerEnvironment: sample.environment,
      desiredRevision: 2, owned: [{ key: 'TOKEN', providerId: 'shared-row', desiredRevision: 1, providerRevision: '20' }],
      set: [], remove: ['TOKEN'], useOurs: [], keepTheirs: [] });
    expect(result).toMatchObject({ owned: [], variables: [], failures: [] });
    expect(row).toMatchObject({ id: 'shared-row', target: sample.remainingTarget,
      customEnvironmentIds: sample.remainingCustom, value: 'private-echo' });
    expect(JSON.stringify(result)).not.toContain('private-echo');
  } finally { await kit.dispose(); }
});

it('retains only successful per-key provenance when the provider refuses another key', async () => {
  const http = createPluginHttpFixture({ async request(request) {
    const key = request.body ? JSON.parse(new TextDecoder().decode(request.body)).key : undefined;
    return { status: key === 'FAIL' ? 403 : 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(
      request.method === 'GET' ? { envs: [] } : key === 'FAIL' ? { error: { code: 'forbidden', message: 'private-echo' } }
        : { created: { ...recordedVercelEnvironment, id: 'good', key, type: 'plain', target: ['production'], updatedAt: 1, value: 'plain' }, failed: [] })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const result = await kit.invokeAction('variables-sync', { ...common, desiredRevision: 2, owned: [],
      set: ['GOOD', 'FAIL'].map(name => ({ purpose: 'variable', phase: 'runtime', name, source: { kind: 'value', value: 'plain' } })),
      remove: [], useOurs: [], keepTheirs: [] });
    expect(result).toMatchObject({ owned: [{ key: 'GOOD', providerId: 'good', desiredRevision: 2, providerRevision: '1' }],
      failures: [{ key: 'FAIL', code: 'provider_request_failed' }] });
    expect(JSON.stringify(result)).not.toContain('private-echo');
  } finally { await kit.dispose(); }
});

it.each(['set', 'remove'] as const)('retains acknowledged ownership when a received %s refusal races with cancellation', async operation => {
  const controller = new AbortController();
  const requests: HttpRequest[] = [];
  const existing = { key: 'BAD', providerId: 'bad-id', desiredRevision: 1, providerRevision: '20' };
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (request.method === 'GET') return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ envs:
      operation === 'remove' ? [{ ...recordedVercelEnvironment, id: 'bad-id', key: 'BAD', type: 'plain',
        target: ['production'], updatedAt: 20 }] : [] })) };
    const key = request.body ? JSON.parse(new TextDecoder().decode(request.body)).key : 'BAD';
    if (key === 'BAD') {
      controller.abort();
      return { status: 403, headers: {}, body: new TextEncoder().encode(JSON.stringify({ error: { code: 'forbidden' } })) };
    }
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ created: {
      ...recordedVercelEnvironment, id: 'good-id', key, type: 'plain', target: ['production'], updatedAt: 30,
    }, failed: [] })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const acknowledged = { key: 'GOOD', providerId: 'good-id', desiredRevision: 2, providerRevision: '30' };
    await expect(kit.invokeAction('variables-sync', { ...common, desiredRevision: 2,
      owned: operation === 'remove' ? [existing] : [],
      set: (operation === 'set' ? ['GOOD', 'BAD'] : ['GOOD']).map(name => ({ purpose: 'variable', phase: 'runtime', name,
        source: { kind: 'value', value: 'plain' } })), remove: operation === 'remove' ? ['BAD'] : [],
      useOurs: [], keepTheirs: [] }, { signal: controller.signal })).resolves.toMatchObject({
      owned: operation === 'remove' ? [existing, acknowledged] : [acknowledged],
      failures: [{ key: 'BAD', code: 'provider_request_failed' }],
    });
    expect(requests.map(request => request.method)).toEqual(['GET', 'POST', operation === 'remove' ? 'DELETE' : 'POST']);
  } finally { await kit.dispose(); }
});

it('retains only successful per-key provenance when the provider explicitly refuses deletion', async () => {
  const owned = { key: 'TOKEN', providerId: 'owned', desiredRevision: 1, providerRevision: '20' };
  const http = createPluginHttpFixture({ async request(request) {
    return { status: request.method === 'GET' ? 200 : 401, headers: {},
      body: new TextEncoder().encode(JSON.stringify(request.method === 'GET' ? { envs: [
        { id: 'owned', key: 'TOKEN', type: 'sensitive', target: ['production'], updatedAt: 20, value: 'private-echo' },
      ] } : { error: { code: 'not_authorized', message: 'private-echo' } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const result = await kit.invokeAction('variables-sync', { ...common, desiredRevision: 2, owned: [owned],
      set: [], remove: ['TOKEN'], useOurs: [], keepTheirs: [] });
    expect(result).toMatchObject({ owned: [owned], failures: [{ key: 'TOKEN', code: 'provider_request_failed' }] });
    expect(JSON.stringify(result)).not.toContain('private-echo');
  } finally { await kit.dispose(); }
});

it.each(['set', 'remove'] as const)('preserves a foreign replacement during %s when an owned key has a different provider identity', async operation => {
  let vendorValue = 'vendor-choice';
  const http = createPluginHttpFixture({ async request(request) {
    if (request.method === 'POST') vendorValue = JSON.parse(new TextDecoder().decode(request.body)).value;
    const row = { id: 'replacement', key: 'TOKEN', type: 'plain', target: ['production'], updatedAt: 30, value: vendorValue };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(
      request.method === 'GET' ? { envs: [row] } : { created: row, failed: [] })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const result = await kit.invokeAction('variables-sync', { ...common, desiredRevision: 2,
      owned: [{ key: 'TOKEN', providerId: 'deleted-old-row', desiredRevision: 1, providerRevision: '20' }],
      set: operation === 'set' ? [{ purpose: 'variable', phase: 'runtime', name: 'TOKEN', source: { kind: 'value', value: 'desired' } }] : [],
      remove: operation === 'remove' ? ['TOKEN'] : [], useOurs: [], keepTheirs: [] });
    expect(vendorValue).toBe('vendor-choice');
    expect(result).toMatchObject({ failures: operation === 'set' ? [{ key: 'TOKEN', code: 'deployment_conflict' }] : [],
      variables: expect.arrayContaining([{ key: 'TOKEN', providerId: 'replacement', present: true, secret: false, owned: false,
        drift: 'unknown', providerRevision: '30' }]) });
    if (operation === 'remove') expect(result).toMatchObject({ owned: [] });
  } finally { await kit.dispose(); }
});

it('does not send a secret write when invocation custody is unavailable', async () => {
    let writes = 0;
    const http = createPluginHttpFixture({ async request(request) {
      if (request.method !== 'GET') writes++;
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ envs: [] })) };
    } });
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
    try {
      const result = await kit.invokeAction('variables-sync', { ...common, desiredRevision: 2, owned: [],
        set: [{ purpose: 'variable', phase: 'runtime', name: 'TOKEN', source: { kind: 'secret',
          ref: 'happier:shared-secret:v1:token', resourceRevision: 3 } }], remove: [], useOurs: [], keepTheirs: [] });
      expect(result).toMatchObject({ owned: [], failures: [{ key: 'TOKEN', code: 'outcome_unknown' }] });
      expect(writes).toBe(0);
    } finally { await kit.dispose(); }
});

it('returns only masked metadata in the selected scope, and does not invent drift without provider metadata', async () => {
  const http = createPluginHttpFixture({ async request() { return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ envs: [
    { id: 'owned', key: 'TOKEN', type: 'sensitive', target: ['production'], value: 'never-public' },
    { id: 'foreign', key: 'OTHER', type: 'plain', target: ['production'], value: 'also-private-at-this-boundary' },
    { id: 'preview', key: 'PREVIEW', type: 'sensitive', target: ['preview'], value: 'never-public' },
  ] })) }; } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const result = await kit.invokeAction('variables-read', { ...common, owned: [{ key: 'TOKEN', providerId: 'owned', desiredRevision: 1 }] });
    expect(result).toMatchObject({ v: 1, variables: [
      { key: 'TOKEN', providerId: 'owned', present: true, secret: true, owned: true, drift: 'unknown' },
      { key: 'OTHER', providerId: 'foreign', present: true, secret: false, owned: false, drift: 'unknown' },
    ] });
    expect(JSON.stringify(result)).not.toContain('never-public');
    expect(JSON.stringify(result)).not.toContain('also-private-at-this-boundary');
  } finally { await kit.dispose(); }
});

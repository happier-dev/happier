import { expect, it } from 'vitest';
import { createDeploymentVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';
import { activateAccount } from '../accountRuntime.js';
import { pagesDeploymentConfigExample, workerSettingsExample, workerPreviewEnvExample } from './variables.fixtures.js';

const account = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'fixture' };
const common = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  targetLinkId: 'link', expectedTargetLinkRevision: 1, credentialRef: account,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
    consumer: { pluginId: entry.manifest.id, localId: 'pages-inspect' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
  providerIdentity: { providerAccountId: 'a'.repeat(32), providerResourceId: 'project-exact', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'production' }, preparedNative: { projectName: 'my-project' } };
const owned = (key: string) => ({ key, providerId: key, desiredRevision: 1 });
const binding = (name: string, value: string) => createDeploymentVariableBindingV1({ phase: 'runtime', name, source: { kind: 'value', value } });
const sync = { ...common, desiredRevision: 2, owned: [], set: [], remove: [], useOurs: [], keepTheirs: [] };
const response = (result: unknown, status = 200) => ({ status, headers: {},
  body: new TextEncoder().encode(JSON.stringify({ success: status === 200, result, errors: [], messages: [] })) });

it('encodes a telemetry Saved Secret only in the sensitive provider write', async () => {
  const rawToken = 'telemetry-fixture-token';
  let written: Record<string, unknown> | undefined;
  const http = createPluginHttpFixture({ async request(request) {
    if (request.method === 'PATCH') written = JSON.parse(new TextDecoder().decode(request.body));
    return response({ id: 'project-exact', name: 'my-project', deployment_configs: {
      production: { env_vars: request.method === 'GET' ? {} : { OTEL_EXPORTER_OTLP_HEADERS: {
        type: 'secret_text', value: rawToken } } } } });
  } });
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected secret mutation'); };
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http,
    secrets: { readSavedSecret: async () => rawToken, saveShared: unsupported, status: unsupported,
      get: unsupported, set: unsupported, delete: unsupported } } });
  try {
    const result = await kit.invokeAction('pages-variables-sync', { ...sync,
      set: [{ ...createDeploymentVariableBindingV1({ name: 'OTEL_EXPORTER_OTLP_HEADERS', phase: 'runtime',
        source: { kind: 'secret', ref: 'happier:shared-secret:v1:telemetry', resourceRevision: 1 } }),
        managedBy: 'telemetry', valueFormat: 'otelAuthorizationHeader' }] });
    expect(written).toMatchObject({ deployment_configs: { production: { env_vars: {
      OTEL_EXPORTER_OTLP_HEADERS: { type: 'secret_text', value: `Authorization=Bearer%20${rawToken}` } } } } });
    expect(result).toMatchObject({ failures: [], owned: [{ key: 'OTEL_EXPORTER_OTLP_HEADERS' }] });
    expect(JSON.stringify(result)).not.toContain(rawToken);
  } finally { await kit.dispose(); }
});

it.each(['daemon-root', 'portable-account'] as const)('reads only exact native Preview variable metadata through %s', async target => {
  const requests: HttpRequest[] = [];
  const previewId = '63bafce9179948688866bb22268eb1c6';
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    expect(request.method).toBe('GET');
    expect(new URL(request.url).pathname).toBe(`/client/v4/accounts/${common.providerIdentity.providerAccountId}/workers/workers/worker-exact/previews/${previewId}/deployments/latest`);
    // Official env example plus derived secret and opaque-resource cases. Both
    // representations are supplied, as documented by PreviewDeploymentConfig.
    return response({ id: 'deployment-exact', env: { ...workerPreviewEnvExample, TOKEN: { type: 'secret_text', text: 'private-echo' } },
      bindings: [...workerSettingsExample.bindings, { name: 'TOKEN', type: 'secret_text', text: 'private-echo' },
        { name: 'DB', type: 'd1', id: 'database-exact' }] });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest,
    module: target === 'daemon-root' ? entry : { ...entry, activateAccount }, services: { http } });
  try {
    await expect(kit.invokeAction('workers-variables-read', { ...common,
      providerEnvironment: { kind: 'preview', scriptName: 'worker-exact', previewName: 'branch/name' },
      preparedNative: { projectName: 'worker-exact', previewId }, owned: [owned('TOKEN')] })).resolves.toEqual({ v: 1, variables: [
      { key: 'MY_ENV_VAR', providerId: 'MY_ENV_VAR', present: true, secret: false, owned: false, drift: 'unknown' },
      { key: 'TOKEN', providerId: 'TOKEN', present: true, secret: true, owned: true, drift: 'unknown' },
    ] });
    expect(requests).toHaveLength(1);
  } finally { await kit.dispose(); }
});

it('returns a missing native Preview without reading production settings', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) { requests.push(request); return response(null, 404); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('workers-variables-read', { ...common,
      providerEnvironment: { kind: 'preview', scriptName: 'worker-exact', previewName: 'branch/name' },
      preparedNative: { projectName: 'worker-exact', previewId: '63bafce9179948688866bb22268eb1c6' }, owned: [] }))
      .rejects.toMatchObject({ code: 'deployment_unavailable' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('/previews/');
  } finally { await kit.dispose(); }
});

it.each([
  { action: 'pages-variables-read', providerEnvironment: { kind: 'production' }, key: 'foo',
    result: { id: 'project-exact', name: 'my-project', deployment_configs: { production: pagesDeploymentConfigExample } } },
  { action: 'workers-variables-read', providerEnvironment: { kind: 'script', scriptName: 'worker-exact' },
    key: 'MY_ENV_VAR', result: workerSettingsExample },
])('projects recorded official response excerpts to metadata ($action)', async ({ action, providerEnvironment, key, result }) => {
  const http = createPluginHttpFixture({ async request() { return response(result); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction(action, { ...common, providerEnvironment, owned: [] })).resolves.toEqual({ v: 1,
      variables: [{ key, providerId: key, present: true, secret: false, owned: false, drift: 'unknown' }] });
  } finally { await kit.dispose(); }
});

// Constructed documentation-schema fixtures, not captured tenant traffic. Checked 2026-11-12:
// https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/edit/
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/delete/
// Pages merge/hash preservation also follows Cloudflare's own client:
// https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/wrangler/src/pages/secret/index.ts
it.each(['daemon-root', 'portable-account'] as const)('lists only masked Pages metadata through %s', async target => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return response({ id: 'project-exact', name: 'my-project', deployment_configs: {
      production: { env_vars: { TOKEN: { type: 'secret_text', value: 'never-disclose' }, PLAIN: { type: 'plain_text', value: 'also-private' } } },
      preview: { env_vars: { PREVIEW: { type: 'plain_text', value: 'preview-private' } } },
    } });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: target === 'daemon-root' ? entry : { ...entry, activateAccount }, services: { http } });
  try {
    const result = await kit.invokeAction('pages-variables-read', { ...common, owned: [owned('TOKEN'), owned('MISSING')] });
    expect(result).toEqual({ v: 1, variables: [
      { key: 'TOKEN', providerId: 'TOKEN', secret: true, present: true, owned: true, drift: 'unknown' },
      { key: 'PLAIN', providerId: 'PLAIN', secret: false, present: true, owned: false, drift: 'unknown' },
      { key: 'MISSING', providerId: 'MISSING', secret: true, present: false, owned: true, drift: 'changed' },
    ] });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', `/client/v4/accounts/${common.providerIdentity.providerAccountId}/pages/projects/my-project`],
    ]);
    expect(entry.manifest.contributes.deploymentTargets.find(target => target.id === 'pages'))
      .toMatchObject({ actions: { variables: { read: 'pages-variables-read', sync: 'pages-variables-sync' } } });
  } finally { await kit.dispose(); }
});

it.each(['production', 'preview'] as const)('patches only owned keys in the selected Pages %s arm', async arm => {
  const requests: HttpRequest[] = [];
  const configs = {
    production: { compatibility_date: '2026-01-01', wrangler_config_hash: 'production-config', env_vars: { FOREIGN: { type: 'secret_text', value: 'foreign-private' }, OLD: { type: 'plain_text', value: 'old' } } },
    preview: { compatibility_date: '2025-01-01', wrangler_config_hash: 'preview-config', env_vars: { FOREIGN: { type: 'secret_text', value: 'preview-private' }, OLD: { type: 'plain_text', value: 'old-preview' } } },
  };
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (request.method === 'PATCH') {
      const patch = JSON.parse(new TextDecoder().decode(request.body));
      expect(Object.keys(patch.deployment_configs)).toEqual([arm]);
      expect(patch.deployment_configs[arm].wrangler_config_hash).toBe(configs[arm].wrangler_config_hash);
      const values = patch.deployment_configs[arm].env_vars;
      expect(Object.keys(values)).toHaveLength(1);
      for (const [key, value] of Object.entries(values)) {
        if (value === null) Reflect.deleteProperty(configs[arm].env_vars, key);
        else Object.assign(configs[arm].env_vars, { [key]: value });
      }
    }
    return response({ id: 'project-exact', name: 'my-project', deployment_configs: configs });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const result = await kit.invokeAction('pages-variables-sync', { ...sync, providerEnvironment: { kind: arm }, owned: [owned('OLD')],
      set: [binding('NEW', 'new-value')], remove: ['OLD', 'FOREIGN'] });
    expect(result).toMatchObject({ owned: [{ key: 'NEW', providerId: 'NEW', desiredRevision: 2 }], failures: [] });
    expect(configs[arm]).toMatchObject({ env_vars: { FOREIGN: { type: 'secret_text' }, NEW: { type: 'plain_text', value: 'new-value' } } });
    expect(configs[arm].env_vars).not.toHaveProperty('OLD');
    const other = arm === 'production' ? 'preview' : 'production';
    expect(configs[other].env_vars).toHaveProperty('OLD');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(requests.map(request => request.method)).toEqual(['GET', 'PATCH', 'PATCH']);
  } finally { await kit.dispose(); }
});

it('requires Use ours for foreign keys and relinquishes Keep theirs', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return response({ id: 'project-exact', name: 'my-project', deployment_configs: { production: { env_vars: {
      FOREIGN: { type: 'plain_text', value: 'remote' }, KEEP: { type: 'secret_text', value: 'private' },
    } } } });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const result = await kit.invokeAction('pages-variables-sync', { ...sync, owned: [owned('KEEP')], keepTheirs: ['KEEP'], remove: ['KEEP'],
      set: [binding('FOREIGN', 'replacement')] });
    expect(result).toMatchObject({ owned: [], failures: [
      { key: 'FOREIGN', code: 'deployment_conflict' },
    ], variables: expect.arrayContaining([{ key: 'KEEP', providerId: 'KEEP', present: true, secret: true, owned: false, drift: 'unknown' }]) });
    expect(requests.map(request => request.method)).toEqual(['GET']);
    await expect(kit.invokeAction('pages-variables-sync', { ...sync, set: [binding('FOREIGN', 'replacement')], useOurs: ['FOREIGN'] }))
      .resolves.toMatchObject({ failures: [], owned: [{ key: 'FOREIGN', providerId: 'FOREIGN', desiredRevision: 2 }] });
  } finally { await kit.dispose(); }
});

it('does not send a secret write when Saved Secret custody is unavailable', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return response({ id: 'project-exact', name: 'my-project', deployment_configs: { production: { env_vars: {} } } });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    // This is the public testkit's absent-service boundary, not a simulated Account/keyless
    // custody refusal. Real plain/full-key/keyless behavior belongs to P42 conformance.
    await expect(kit.invokeAction('pages-variables-sync', { ...sync,
      set: [binding('GOOD', 'plain'), createDeploymentVariableBindingV1({ phase: 'runtime', name: 'SECRET', source: {
        kind: 'secret', ref: 'happier:shared-secret:v1:fixture', resourceRevision: 3,
      } })] })).resolves.toMatchObject({
        owned: [{ key: 'GOOD', providerId: 'GOOD', desiredRevision: 2 }],
        failures: [{ key: 'SECRET', code: 'outcome_unknown' }],
      });
    expect(requests.map(request => request.method)).toEqual(['GET', 'PATCH']);
  } finally { await kit.dispose(); }
});

it.each([401, 403, 404])('retains successful key ownership after a later provider %s refusal', async status => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (request.method === 'PATCH') {
      const patch = JSON.parse(new TextDecoder().decode(request.body));
      if ('BAD' in patch.deployment_configs.production.env_vars) return response({}, status);
    }
    return response({ id: 'project-exact', name: 'my-project', deployment_configs: { production: { env_vars: {} } } });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('pages-variables-sync', { ...sync, set: [binding('GOOD', 'plain'), binding('BAD', 'plain')] }))
      .resolves.toMatchObject({ owned: [{ key: 'GOOD', providerId: 'GOOD', desiredRevision: 2 }],
        failures: [{ key: 'BAD', code: 'provider_request_failed' }] });
    expect(requests.map(request => request.method)).toEqual(['GET', 'PATCH', 'PATCH']);
  } finally { await kit.dispose(); }
});

it('retains prior ownership when a received provider refusal races with cancellation', async () => {
  const controller = new AbortController();
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (request.method === 'PATCH') {
      const patch = JSON.parse(new TextDecoder().decode(request.body));
      if ('BAD' in patch.deployment_configs.production.env_vars) {
        controller.abort();
        return response({}, 404);
      }
    }
    return response({ id: 'project-exact', name: 'my-project', deployment_configs: { production: { env_vars: {} } } });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('pages-variables-sync', { ...sync, set: [binding('GOOD', 'plain'), binding('BAD', 'plain')] },
      { signal: controller.signal })).resolves.toMatchObject({ owned: [{ key: 'GOOD', providerId: 'GOOD', desiredRevision: 2 }],
      failures: [{ key: 'BAD', code: 'provider_request_failed' }] });
    expect(requests.map(request => request.method)).toEqual(['GET', 'PATCH', 'PATCH']);
  } finally { await kit.dispose(); }
});

it('preserves every unrelated Worker binding by inheritance while changing plain variables', async () => {
  const requests: HttpRequest[] = [];
  let bindings: { name: string; type: string; text?: string; id?: string }[] = [ { name: 'FOREIGN', type: 'secret_text', text: 'private-echo' },
    { name: 'OLD', type: 'plain_text', text: 'old' }, { name: 'DB', type: 'd1', id: 'database-exact' } ];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (request.method === 'PATCH') {
      const bytes = request.body!;
      const form = await new Response(Uint8Array.from(bytes).buffer, { headers: { 'content-type': request.headers!['content-type']! } }).formData();
      const patch = JSON.parse(String(form.get('settings')));
      expect(patch.annotations).toEqual({ 'workers/message': 'Retain this annotation' });
      expect(patch.bindings).toContainEqual({ name: 'FOREIGN', type: 'inherit' });
      expect(patch.bindings).toContainEqual({ name: 'DB', type: 'inherit' });
      bindings = patch.bindings.map((binding: { name: string; type: string; text?: string }) => binding.type === 'inherit'
        ? bindings.find(previous => previous.name === binding.name)! : binding);
    }
    return response({ bindings, annotations: { 'workers/message': 'Retain this annotation', 'workers/triggered_by': 'upload' } });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const metadata = await kit.invokeAction('workers-variables-read', { ...common, owned: [owned('OLD')],
      providerEnvironment: { kind: 'script', scriptName: 'worker-exact' } });
    expect(metadata).toEqual({ v: 1, variables: [
      { key: 'FOREIGN', providerId: 'FOREIGN', secret: true, present: true, owned: false, drift: 'unknown' },
      { key: 'OLD', providerId: 'OLD', secret: false, present: true, owned: true, drift: 'unknown' },
    ] });
    const result = await kit.invokeAction('workers-variables-sync', { ...sync, providerEnvironment: { kind: 'script', scriptName: 'worker-exact' },
      owned: [owned('OLD')], set: [binding('NEW', 'new')], remove: ['OLD', 'FOREIGN'] });
    expect(result).toMatchObject({ failures: [], owned: [{ key: 'NEW', providerId: 'NEW', desiredRevision: 2 }] });
    expect(bindings.map(binding => binding.name)).toEqual(['FOREIGN', 'DB', 'NEW']);
    expect(JSON.stringify(result)).not.toContain('private-echo');
    expect(requests.every(request => new URL(request.url).pathname.endsWith('/workers/scripts/worker-exact/settings'))).toBe(true);
    expect(entry.manifest.contributes.deploymentTargets.find(target => target.id === 'workers'))
      .toMatchObject({ actions: { variables: { read: 'workers-variables-read', sync: 'workers-variables-sync' } } });
  } finally { await kit.dispose(); }
});

it.each([
  { action: 'workers-variables-sync', providerEnvironment: { kind: 'preview', scriptName: 'worker-exact', previewName: 'candidate' } },
  { action: 'pages-variables-read', providerEnvironment: { kind: 'preview', gitBranch: 'candidate' } },
])('refuses unsupported scope before touching production ($action)', async ({ action, providerEnvironment }) => {
  const http = createPluginHttpFixture({ async request() { throw new Error('Unsupported scope must never reach Cloudflare'); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try { await expect(kit.invokeAction(action, { ...(action === 'pages-variables-read' ? { ...common, owned: [] } : sync), providerEnvironment }))
    .rejects.toMatchObject({ code: 'unsupported_action' }); }
  finally { await kit.dispose(); }
});

it('keeps successful per-key provenance and does not retry an unknown provider write', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (request.method === 'PATCH') {
      const body = JSON.parse(new TextDecoder().decode(request.body));
      const key = Object.keys(body.deployment_configs.production.env_vars)[0];
      if (key === 'LOST') throw new Error('Lost provider response with private body');
      if (key === 'DENIED') return response({}, 400);
    }
    return response({ id: 'project-exact', name: 'my-project', deployment_configs: { production: { env_vars: {} } } });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('pages-variables-sync', { ...sync, set: [binding('OK', 'value'), binding('LOST', 'value'), binding('DENIED', 'value')] }))
      .resolves.toMatchObject({ owned: [{ key: 'OK', providerId: 'OK', desiredRevision: 2 }], failures: [
        { key: 'LOST', code: 'outcome_unknown' }, { key: 'DENIED', code: 'provider_request_failed' },
      ] });
    expect(requests.map(request => request.method)).toEqual(['GET', 'PATCH', 'PATCH', 'PATCH']);
  } finally { await kit.dispose(); }
});

it('stops Worker replacement writes after an unknown outcome instead of dropping an unacknowledged key', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (request.method === 'PATCH') throw new Error('Provider accepted FIRST, but its response was lost');
    return response({ bindings: [] });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('workers-variables-sync', { ...sync, providerEnvironment: { kind: 'script', scriptName: 'worker-exact' },
      set: [binding('FIRST', 'value'), binding('SECOND', 'value')] })).resolves.toMatchObject({ owned: [], failures: [
        { key: 'FIRST', code: 'outcome_unknown' }, { key: 'SECOND', code: 'deployment_content_unavailable' },
      ] });
    expect(requests.map(request => request.method)).toEqual(['GET', 'PATCH']);
  } finally { await kit.dispose(); }
});

it.each([
  { phases: ['build'], conflict: false },
  { phases: ['build', 'runtime'], conflict: false },
  { phases: ['runtime', 'build'], conflict: false },
  { phases: ['runtime', 'build'], conflict: true },
])('does not hide unsupported Worker build rows ($phases, conflict=$conflict)', async ({ phases, conflict }) => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return response({ bindings: [] });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('workers-variables-sync', { ...sync, providerEnvironment: { kind: 'script', scriptName: 'worker-exact' },
      set: [...phases.map(phase => ({ ...binding('BUILD_ONLY', conflict && phase === 'build' ? 'different' : 'value'), phase })),
        binding('RUNTIME_ONLY', 'runtime-value')] })).resolves.toMatchObject({
        owned: [{ key: 'RUNTIME_ONLY', providerId: 'RUNTIME_ONLY', desiredRevision: 2 }], failures: [
        { key: 'BUILD_ONLY', code: conflict ? 'deployment_conflict' : 'deployment_content_unavailable' },
      ] });
    expect(requests.map(request => request.method)).toEqual(['GET', 'PATCH']);
  } finally { await kit.dispose(); }
});

it('deletes an owned Worker secret through the explicit secret endpoint and preserves foreign secrets', async () => {
  const requests: HttpRequest[] = [];
  let bindings = [{ name: 'OWNED', type: 'secret_text' }, { name: 'FOREIGN', type: 'secret_text' }];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (request.method === 'DELETE') {
      expect(new URL(request.url).pathname).toBe(`/client/v4/accounts/${common.providerIdentity.providerAccountId}/workers/scripts/worker-exact/secrets/OWNED`);
      bindings = bindings.filter(binding => binding.name !== 'OWNED');
      return response(undefined);
    }
    if (request.method === 'PATCH') throw new Error('Omitting a secret in settings is not an established deletion contract');
    return response({ bindings });
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('workers-variables-sync', { ...sync, providerEnvironment: { kind: 'script', scriptName: 'worker-exact' },
      owned: [owned('OWNED')], remove: ['OWNED', 'FOREIGN'] })).resolves.toMatchObject({ owned: [], failures: [] });
    expect(bindings).toEqual([{ name: 'FOREIGN', type: 'secret_text' }]);
    expect(requests.map(request => request.method)).toEqual(['GET', 'DELETE']);
  } finally { await kit.dispose(); }
});

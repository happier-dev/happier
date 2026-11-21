import { createDeploymentVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { expect, it } from 'vitest';
import { railwayHostAccess, railwayIdentity } from './account.js';
import { variableActions } from './variables.js';

const plugin = definePlugin({
  ...railwayIdentity,
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  activation: { events: [] },
  hostAccess: railwayHostAccess,
  actions: variableActions,
});

const projectId = 'project-exact';
const environmentId = 'environment-exact';
const serviceId = 'service-exact';
const account = { service: { pluginId: 'happier.machine.railway', localId: 'railway-account' }, accountId: 'fixture' };
const readInput = { v: 1, serverId: 'home', environmentId: 'happier-environment', expectedRevision: 1,
  targetLinkId: 'link', expectedTargetLinkRevision: 1, credentialRef: account,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
    consumer: { pluginId: plugin.manifest.id, localId: 'inspect' }, purpose: 'cloud-api' }, target: { kind: 'account', account } },
  providerIdentity: { providerAccountId: projectId, providerResourceId: serviceId, providerEnvironment: environmentId },
  providerEnvironment: { kind: 'native', selection: { projectId, environmentId, serviceId } } };
const syncInput = { ...readInput, desiredRevision: 2, owned: [], set: [], remove: [], useOurs: [], keepTheirs: [] };
const oldRevision = '2026-11-19T10:00:00.000Z';
const newRevision = '2026-11-20T10:00:00.000Z';
const ownership = (key: string, providerId: string, providerRevision = oldRevision) => ({ key, providerId, providerRevision, desiredRevision: 1 });
const binding = (name: string) => createDeploymentVariableBindingV1({ phase: 'runtime', name, source: { kind: 'value', value: 'plain-value' } });
const variable = (name: string, id: string, props = {}) => ({ name, id, serviceId, isSealed: false, updatedAt: oldRevision, ...props });

// Constructed vectors from Railway's public Environment.variables and Variable
// schemas. The value field is an unexpected response echo and must be dropped.
const page = (nodes: ReturnType<typeof variable>[], endCursor: string | null = null) => ({
  environment: { id: environmentId, projectId, variables: { edges: nodes.map(node => ({ node })),
    pageInfo: { hasNextPage: endCursor !== null, endCursor } } },
});

const response = (data: unknown, status = 200) => ({ status, headers: {},
  body: new TextEncoder().encode(JSON.stringify({ data })) });

function boundary(replies: ReadonlyArray<ReturnType<typeof response> | Error>) {
  const requests: { query: string; variables: unknown }[] = [];
  const credentials: Parameters<HttpService['request']>[0]['credentialBinding'][] = [];
  const http = createPluginHttpFixture({ async request(request) {
    const reply = replies[requests.length];
    requests.push(JSON.parse(new TextDecoder().decode(request.body)));
    credentials.push(request.credentialBinding);
    if (!reply || reply instanceof Error) throw reply ?? new Error('Unexpected Railway request');
    return reply;
  } });
  return { http, requests, credentials };
}

it('reads only metadata in the exact service, distinguishing sealed, replaced, and absent variables', async () => {
  const fakePrivateValue = 'private-provider-value';
  const h = boundary([
    response(page([variable('SEALED', 'sealed-id', { isSealed: true, value: fakePrivateValue }),
      variable('SHARED', 'shared-id', { serviceId: null })], 'next')),
    response(page([variable('OTHER', 'other-id', { serviceId: 'other-service' }),
      variable('REPLACED', 'replacement-id', { updatedAt: newRevision })])),
  ]);
  const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { http: h.http } });
  try {
    const result = await kit.invokeAction('variables-read', { ...readInput, owned: [
      ownership('SEALED', 'sealed-id'), ownership('REPLACED', 'retired-id'), ownership('MISSING', 'absent-id'),
    ] });
    expect(result).toEqual({ v: 1, variables: [
      { key: 'SEALED', providerId: 'sealed-id', providerRevision: oldRevision, present: true, secret: true, owned: true, drift: 'current' },
      { key: 'REPLACED', providerId: 'replacement-id', providerRevision: newRevision, present: true, secret: false, owned: false, drift: 'unknown' },
      { key: 'MISSING', providerId: 'absent-id', present: false, secret: true, owned: true, drift: 'changed' },
    ] });
    expect(h.requests.map(request => request.variables)).toEqual([
      { projectId, environmentId, after: null }, { projectId, environmentId, after: 'next' },
    ]);
    expect(h.requests.every(({ query }) => query.includes('isSealed') && !/\bvalue\b/.test(query))).toBe(true);
    expect(h.credentials[0]).toMatchObject({ kind: 'connectedAccountPurpose', purpose: 'cloud-api', method: 'POST' });
    expect(JSON.stringify(result)).not.toContain(fakePrivateValue);
  } finally { await kit.dispose(); }
});

it('merges reviewed values in one request, reconciles ownership, and deletes only exact owned keys', async () => {
  const rawToken = 'test-saved-telemetry-token';
  const ref = 'happier:shared-secret:v1:telemetry';
  const sealed = variable('SEALED', 'sealed-id', { isSealed: true });
  const changed = variable('CHANGED', 'changed-id', { updatedAt: newRevision });
  const replacement = variable('REPLACED', 'replacement-id');
  const reviewedOverwrite = variable('REVIEWED', 'reviewed-id');
  const h = boundary([
    response(page([sealed, changed, replacement, reviewedOverwrite, variable('DELETE', 'delete-id'), variable('FOREIGN', 'foreign-id')])),
    response({ variableCollectionUpsert: true }),
    response({ environmentPatchCommit: 'patch-acknowledgement' }),
    response(page([sealed, changed, replacement, { ...reviewedOverwrite, updatedAt: newRevision }, variable('FOREIGN', 'foreign-id'),
      variable('OTEL_EXPORTER_OTLP_HEADERS', 'headers-id', { updatedAt: newRevision }), variable('REGION', 'region-id')])),
  ]);
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected secret mutation'); };
  const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { http: h.http,
    secrets: { async readSavedSecret(requestedRef, requested) {
      expect(requestedRef).toBe(ref);
      expect(requested?.resourceRevision).toBe(3);
      return rawToken;
    }, get: unsupported, set: unsupported, delete: unsupported, status: unsupported, saveShared: unsupported },
  } });
  try {
    const result = await kit.invokeAction('variables-sync', { ...syncInput,
      owned: [ownership('SEALED', 'sealed-id'), ownership('CHANGED', 'changed-id'),
        ownership('DELETE', 'delete-id'), ownership('REPLACED', 'retired-id')],
      keepTheirs: ['SEALED'], useOurs: ['REVIEWED'], set: [binding('CHANGED'), binding('FOREIGN'), binding('REVIEWED'), binding('REGION'),
        { ...createDeploymentVariableBindingV1({ phase: 'runtime', name: 'OTEL_EXPORTER_OTLP_HEADERS',
          source: { kind: 'secret', ref, resourceRevision: 3 } }), valueFormat: 'otelAuthorizationHeader' }],
      remove: ['SEALED', 'DELETE', 'REPLACED', 'UNKNOWN'],
    });
    expect(result).toMatchObject({ v: 1, owned: [ownership('CHANGED', 'changed-id'),
      { ...ownership('REVIEWED', 'reviewed-id', newRevision), desiredRevision: 2 },
      { ...ownership('REGION', 'region-id'), desiredRevision: 2 },
      { ...ownership('OTEL_EXPORTER_OTLP_HEADERS', 'headers-id', newRevision), desiredRevision: 2 }],
      failures: [{ key: 'CHANGED', code: 'deployment_conflict' }, { key: 'FOREIGN', code: 'deployment_conflict' }],
      variables: expect.arrayContaining([
        expect.objectContaining({ key: 'SEALED', owned: false, secret: true }),
        expect.objectContaining({ key: 'REPLACED', owned: false, present: true }),
        expect.objectContaining({ key: 'OTEL_EXPORTER_OTLP_HEADERS', owned: true, secret: false, drift: 'current' }),
      ]),
    });
    expect(h.requests.slice(1).map(request => request.variables)).toEqual([
      { input: { projectId, environmentId, serviceId, replace: false, skipDeploys: true,
        variables: { REVIEWED: 'plain-value', REGION: 'plain-value', OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${rawToken}` } } },
      { environmentId, patch: { services: { [serviceId]: { variables: { DELETE: null } } } } },
      { projectId, environmentId, after: null },
    ]);
    expect(h.requests[2].query).toMatch(/environmentPatchCommit\(.*skipDeploys: true/);
    expect(JSON.stringify(result)).not.toContain(rawToken);
    expect(JSON.stringify(result)).not.toContain('plain-value');
  } finally { await kit.dispose(); }
});

it.each(['unacknowledged write', 'acknowledged write without metadata'] as const)(
  'preserves observed ownership and reports an unknown outcome on %s', async failure => {
    const fakePrivateValue = 'private-transport-diagnostic';
    const before = response(page([]));
    const lost = new Error(fakePrivateValue);
    const h = boundary(failure === 'unacknowledged write' ? [before, lost] :
      [before, response({ variableCollectionUpsert: true }), lost]);
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { http: h.http } });
    try {
      const result = await kit.invokeAction('variables-sync', { ...syncInput, set: [binding('REGION')] });
      expect(result).toEqual({ v: 1, variables: [], owned: [], failures: [{ key: 'REGION', code: 'outcome_unknown' }] });
      expect(h.requests.filter(request => request.query.includes('mutation'))).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(fakePrivateValue);
    } finally { await kit.dispose(); }
  },
);

it('refuses to mutate when Railway does not confirm the exact environment and project', async () => {
  const before = page([variable('KEEP', 'keep-id')]);
  const h = boundary([response({ environment: { ...before.environment, projectId: 'another-project' } })]);
  const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { http: h.http } });
  try {
    await expect(kit.invokeAction('variables-sync', { ...syncInput, set: [binding('REGION')],
      owned: [ownership('KEEP', 'keep-id')], remove: ['KEEP'],
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
    expect(h.requests).toHaveLength(1);
  } finally { await kit.dispose(); }
});

it('settles only the grouped writes confirmed by new service metadata', async () => {
  const existing = variable('UNCHANGED', 'existing-id');
  const retained = ownership('UNCHANGED', 'existing-id');
  const h = boundary([
    response(page([existing])),
    response({ variableCollectionUpsert: true }),
    response(page([existing, variable('NEW', 'new-id', { updatedAt: newRevision }),
      variable('UNCHANGED', 'foreign-id', { serviceId: 'other-service', updatedAt: newRevision })])),
  ]);
  const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { http: h.http } });
  try {
    const result = await kit.invokeAction('variables-sync', { ...syncInput, owned: [retained],
      set: [binding('UNCHANGED'), binding('NEW')] });
    expect(result).toMatchObject({ owned: [retained, { ...ownership('NEW', 'new-id', newRevision), desiredRevision: 2 }],
      failures: [{ key: 'UNCHANGED', code: 'outcome_unknown' }] });
    expect(h.requests.map(request => request.variables)).toEqual([
      { projectId, environmentId, after: null },
      { input: { projectId, environmentId, serviceId, replace: false, skipDeploys: true,
        variables: { UNCHANGED: 'plain-value', NEW: 'plain-value' } } },
      { projectId, environmentId, after: null },
    ]);
  } finally { await kit.dispose(); }
});

it('keeps ownership when an acknowledged deletion is still visible on Railway', async () => {
  const before = response(page([variable('PENDING', 'pending-id')]));
  const owned = [ownership('PENDING', 'pending-id')];
  const h = boundary([before, response({ environmentPatchCommit: 'pending-patch' }), before]);
  const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { http: h.http } });
  try {
    const result = await kit.invokeAction('variables-sync', { ...syncInput, owned, remove: ['PENDING'] });
    expect(result).toMatchObject({ owned, failures: [{ key: 'PENDING', code: 'outcome_unknown' }],
      variables: [{ key: 'PENDING', present: true, owned: true }],
    });
    expect(h.requests.filter(request => request.query.includes('mutation'))).toHaveLength(1);
  } finally { await kit.dispose(); }
});

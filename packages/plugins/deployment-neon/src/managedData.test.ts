import { describe, expect, it } from 'vitest';
import { DeploymentTargetPreparationBaseV1ProtocolSchema, PluginError, type DeploymentTargetPreparationBaseV1, type JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit, createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import * as entry from './index.js';

const service = { pluginId: 'happier.deploy.neon', localId: 'neon' };
const credentialRef = { service, accountId: 'connected-neon' };
function preparation(localId: string) {
  return DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
    credentialRef, credentialPrincipal: { kind: 'account', accountId: 'owner',
      purpose: { consumer: { pluginId: service.pluginId, localId }, purpose: 'deploy-manage' }, target: { kind: 'account', account: credentialRef } },
    providerAccountId: 'org-example', providerEnvironment: { kind: 'custom', id: 'br-main' } } satisfies DeploymentTargetPreparationBaseV1);
}
const base = preparation('projects-provision');
const linked = DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ ...preparation('projects-link'), targetLinkId: 'data-link', expectedTargetLinkRevision: 1,
  providerIdentity: { providerAccountId: 'org-example', providerResourceId: 'project-example', providerEnvironment: 'br-main' } });
const previewLink = DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ ...linked,
  providerIdentity: { providerAccountId: 'org-example', providerResourceId: 'project-example', providerEnvironment: 'br-preview' },
  providerEnvironment: { kind: 'custom', id: 'br-preview' } });
const pair = { id: 'database', purpose: 'data.connection', database: 'neondb', role: 'owner', endpointId: 'ep-main',
  labels: { DATABASE_URL: 'Application database', DIRECT_URL: 'Migration database' }, audience: { accountGrants: ['owner'] } };
const { endpointId: _endpointId, ...createdSaveIntent } = pair;
const createPair = { ...createdSaveIntent, rolePasswordLabel: 'Generated Neon role password' };
const correlation = { repository: { kind: 'gitlab', deployment: 'https://gitlab.example', repository: 'group/repo' }, pullRequestId: '17' };
const annotation = { 'happier.environment': 'environment', 'happier.scm.kind': 'gitlab',
  'happier.scm.deployment': 'https://gitlab.example', 'happier.scm.repository': 'group/repo', 'happier.pullRequest': '17' };

// Constructed boundary vectors from official Neon v2 OpenAPI, read 2026-10-30:
// https://neon.com/api_spec/release/v2.json — Project/Branch/AnnotationData,
// RegionResponse and endpoint operation responses. No real tenant credentials.
const timestamp = '2026-10-30T00:00:00Z';
const organization = { id: 'org-example', name: 'Example', handle: 'example', plan: 'launch', created_at: timestamp, updated_at: timestamp, managed_by: 'console' };
const region = { region_id: 'aws-eu-central-1', name: 'Frankfurt', default: false, geo_lat: '50.11', geo_long: '8.68' };
const project = { id: 'project-example', org_id: 'org-example', name: 'Example', region_id: 'aws-eu-central-1', pg_version: 17,
  consumption_period_start: '2026-10-01T00:00:00Z', consumption_period_end: '2026-11-01T00:00:00Z', active_time_seconds: 0,
  compute_time_seconds: 0, written_data_bytes: 0, data_transfer_bytes: 0, data_storage_bytes_hour: 0, platform_id: 'aws',
  proxy_host: 'eu-central-1.aws.neon.tech', branch_logical_size_limit: 10000, branch_logical_size_limit_bytes: 10485760000,
  store_passwords: true, cpu_used_sec: 0, provisioner: 'k8s-neonvm', creation_source: 'api', history_retention_seconds: 21600,
  created_at: timestamp, updated_at: timestamp, owner_id: 'user-example' };
const branch = { id: 'br-preview', project_id: project.id, parent_id: 'br-main', name: 'Preview 17', current_state: 'ready', default: false, protected: false,
  state_changed_at: timestamp, creation_source: 'api', created_at: timestamp, updated_at: timestamp, cpu_used_sec: 0,
  active_time_seconds: 0, compute_time_seconds: 0, written_data_bytes: 0, data_transfer_bytes: 0 };
const mainBranch = { ...branch, id: 'br-main', default: true, parent_id: undefined };
const branchOperationId = '00000000-0000-4000-8000-000000000001';
const projectOperationId = '00000000-0000-4000-8000-000000000002';
const deleteOperationId = '00000000-0000-4000-8000-000000000003';
function nativeOperation(id: string, branchId = branch.id, action = 'create_branch') {
  return { id, project_id: project.id, branch_id: branchId, action, status: 'running', failures_count: 0,
    created_at: timestamp, updated_at: timestamp, total_duration_ms: 0 };
}
function endpoint(id: string, branchId: string) {
  return { id, branch_id: branchId, project_id: project.id, type: 'read_write', host: 'example', region_id: project.region_id,
    autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25, current_state: 'active', pooler_enabled: true,
    pooler_mode: 'transaction', disabled: false, passwordless_access: false, creation_source: 'api', created_at: timestamp,
    updated_at: timestamp, settings: {}, proxy_host: project.proxy_host, suspend_timeout_seconds: 300, provisioner: 'k8s-neonvm' };
}

async function host(respond: (request: HttpRequest) => unknown | Promise<unknown>, failSave?: number,
  responseStatus?: (request: HttpRequest) => number) {
  const requests: HttpRequest[] = [];
  const saved: { id: string; value: string; audience: unknown }[] = [];
  const secrets: SecretsService = {
    async saveShared(id, input) {
      if (saved.length + 1 === failSave) throw new Error('constructed storage failure');
      saved.push({ id, value: new TextDecoder().decode(input.bytes), audience: input.audience });
      return { ref: `saved:${saved.length}`, resourceRevision: 1 };
    },
    async readSavedSecret() { throw new Error('Unexpected secret read'); },
    async get() { throw new Error('Unexpected secret read'); },
    async set() { throw new Error('Unexpected secret write'); },
    async delete() { throw new Error('Unexpected secret deletion'); },
    async status() { return { state: 'missing', revision: '0' }; },
  };
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    const value = await respond(request);
    return { status: responseStatus?.(request) ?? (request.method === 'POST' ? 201 : 200), body: new TextEncoder().encode(JSON.stringify(value)), headers: {} };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http, secrets } });
  const invoke = kit.invokeAction;
  return { kit, invoke, requests, saved };
}

describe('activated Neon managed data target', () => {
  it('contributes real data roles without inventing runtime deployment or query authority', async () => {
    const h = await host(() => ({}));
    try {
      expect(entry.manifest.contributes.deploymentTargets).toEqual([expect.objectContaining({ role: 'data', targetKind: 'neon',
        dataV1: expect.objectContaining({ projects: expect.objectContaining({ provision: 'projects-provision' }),
          branches: expect.objectContaining({ create: 'branches-create', delete: 'branches-delete' }), connectionSecret: { save: 'connections-save' } }) })]);
      expect(h.kit.registration('actions', 'connections-save')).toBeDefined();
      expect(h.kit.registration('connectedAccountDescriptors', 'neon')).toBeDefined();
      expect(entry.manifest.contributes.deploymentTargets?.[0]).not.toHaveProperty('dataV1.query');
      expect(h.requests).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it('prepares only the selected provider project and branch for the canonical host link writer', async () => {
    const h = await host(request => request.url.endsWith('/branches/br-main') ? { branch: mainBranch } : { project });
    try {
      expect(await h.kit.invokeAction('projects-link', { ...preparation('projects-link'), projectId: project.id, branchId: 'br-main' }))
        .toMatchObject({ status: 'configured', providerIdentity: { providerAccountId: project.org_id,
          providerResourceId: project.id, providerEnvironment: 'br-main' }, engine: 'postgres' });
      expect(h.requests.every(request => request.method === 'GET')).toBe(true);
      expect(h.saved).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it('reads catalog Resources through the same qualified Action and makes zero idle provider requests', async () => {
    const h = await host(() => ({ projects: [project], unavailable_project_ids: [], pagination: {} }));
    try {
      const resource = h.kit.registration('resources', 'projects-list-resource');
      expect(resource).toBeDefined();
      if (!resource) throw new Error('Missing Neon project Resource');
      expect(h.requests).toHaveLength(0);
      const options = createTestResourceInvocationContext({ context: { kind: 'surface', mountInstanceKey: 'data-options', launchInput: preparation('projects-list-read') },
        async readAction(ref, input, options) {
          expect(ref).toEqual({ pluginId: entry.manifest.id, localId: 'projects-list-read' });
          return { ok: true, result: await h.invoke(ref.localId, input, { signal: options?.signal, surface: 'plugin' }) };
        } });
      expect(JSON.parse(String(await resource.read(options)))).toMatchObject({ projects: [{ providerProjectId: project.id }] });
      expect(h.requests).toHaveLength(1);
      const observation = await resource.observe?.(() => { throw new Error('Snapshot Resources have no provider push'); }, options);
      await observation?.dispose();
      expect(h.requests).toHaveLength(1);
      await expect(resource.read(createTestResourceInvocationContext())).rejects.toMatchObject({ code: 'deployment_unavailable' });
      expect(h.requests).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('saves the provider pooled and direct pair through exact reviewed secret ids and returns refs only', async () => {
    const h = await host(request => ({ uri: new URL(request.url).searchParams.get('pooled') === 'true'
      ? 'postgresql://owner:private-pool@example-pooler/neondb' : 'postgresql://owner:private-direct@example/neondb' }));
    try {
      const result = await h.kit.invokeAction('connections-save', { ...linked, ...pair });
      expect(result).toMatchObject({ status: 'complete', connections: {
        DATABASE_URL: { ref: 'saved:1', resourceRevision: 1 }, DIRECT_URL: { ref: 'saved:2', resourceRevision: 1 } } });
      expect(h.saved.map(item => item.id)).toEqual(['database', 'database']);
      expect(h.saved.every(item => JSON.stringify(item.audience) === JSON.stringify(pair.audience))).toBe(true);
      expect(h.requests.map(request => new URL(request.url).searchParams.get('pooled'))).toEqual(['true', 'false']);
      expect(h.requests.every(request => request.credentialBinding?.kind === 'connectedAccountPurpose'
        && request.credentialBinding.purpose === 'deploy-manage' && !request.headers?.authorization)).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/postgresql|private-pool|private-direct/u);
    } finally { await h.kit.dispose(); }
  });

  it('retains a partial pair and reuses only refs for the same selected native resource', async () => {
    const first = await host(() => ({ uri: 'postgresql://owner:private@example/neondb' }), 2);
    let retained: JsonValue | null = null;
    try {
      retained = await first.kit.invokeAction('connections-save', { ...linked, ...pair });
      expect(retained).toMatchObject({ status: 'partial', connections: { DATABASE_URL: { ref: 'saved:1' } }, incomplete: ['DIRECT_URL'] });
    } finally { await first.kit.dispose(); }
    const h = await host(() => ({ uri: 'postgresql://owner:private@example/neondb' }));
    try {
      if (retained === null) throw new Error('Missing partial-save result');
      const previous = retained;
      const result = await h.kit.invokeAction('connections-save', { ...linked, ...pair, previous });
      expect(result).toMatchObject({ status: 'complete' });
      expect(h.saved.map(item => item.id)).toEqual(['database']);
      expect(h.requests).toHaveLength(1);
      await expect(h.kit.invokeAction('connections-save', { ...linked, ...pair, endpointId: 'ep-foreign', previous })).rejects.toMatchObject({ code: 'deployment_conflict' });
    } finally { await h.kit.dispose(); }
  });

  it('creates a schema-only preview with atomic neutral SCM correlation and observes operations before ready', async () => {
    const h = await host(request => request.method === 'POST'
      ? { branch, operations: [nativeOperation(branchOperationId)], endpoints: [endpoint('ep-preview', branch.id)],
        connection_uris: [{ connection_uri: 'postgresql://owner:branch-private@example/neondb',
          connection_parameters: { database: 'neondb', role: 'owner', password: 'branch-private', host: 'example', pooler_host: 'example-pooler' } }],
        roles: [{ branch_id: branch.id, name: 'owner', password: 'branch-private', created_at: timestamp, updated_at: timestamp }],
        databases: [{ name: 'neondb', owner_name: 'owner', branch_id: branch.id, created_at: timestamp, updated_at: timestamp }] }
      : { branch, annotation: { object: { type: 'branch', id: branch.id }, value: annotation } });
    try {
      const result = await h.kit.invokeAction('branches-create', { ...linked, ...createPair, name: 'Preview 17', correlation, initialization: 'parent-schema' });
      expect(result).toMatchObject({ status: 'provisioned', ready: false, branchId: 'br-preview', operationIds: [branchOperationId] });
      const request = h.requests.find(item => item.method === 'POST');
      expect(JSON.parse(new TextDecoder().decode(request?.body))).toEqual({ branch: { name: 'Preview 17', parent_id: 'br-main', init_source: 'parent-schema' }, endpoints: [{ type: 'read_write' }], annotation_value: annotation });
      expect(h.requests.filter(item => item.method === 'POST')).toHaveLength(1);
      expect(h.saved).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(/branch-private|postgresql/u);
    } finally { await h.kit.dispose(); }
  });

  it('re-observes a lost branch create without replaying POST and adopts only exact annotation', async () => {
    const h = await host(request => {
      if (request.method === 'POST') throw new Error('response lost');
      return { branches: [branch], annotations: { [branch.id]: { object: { type: 'branch', id: branch.id }, value: annotation } }, pagination: {} };
    });
    try {
      expect(await h.kit.invokeAction('branches-create', { ...linked, ...createPair, name: branch.name, correlation, initialization: 'parent-schema' }))
        .toMatchObject({ status: 'provisioned', branchId: branch.id, recovered: true });
      expect(h.requests.filter(item => item.method === 'POST')).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('creates a schema-only preview without requesting connection custody', async () => {
    const h = await host(() => ({ branch, operations: [], roles: [{ name: 'owner', password: 'one-time-private' }],
      connection_uris: [{ connection_uri: 'postgresql://owner:one-time-private@example/neondb' }] }));
    try {
      const result = await h.kit.invokeAction('branches-create', { ...linked, name: branch.name, correlation, initialization: 'parent-schema' });
      expect(result).toMatchObject({ status: 'provisioned', branchId: branch.id, correlation });
      expect(h.saved).toEqual([]);
      expect(h.requests.map(request => request.method)).toEqual(['POST']);
      expect(JSON.stringify(result)).not.toMatch(/one-time-private|postgresql|connectionSave|rolePassword/u);
    } finally { await h.kit.dispose(); }
  });

  it('creates from the saved native parent instead of the current linked branch', async () => {
    const parentBranchRef = { providerProjectId: 'saved-project', branchId: 'saved-parent' };
    const h = await host(() => ({ branch: { ...branch, project_id: parentBranchRef.providerProjectId, parent_id: parentBranchRef.branchId }, operations: [] }));
    try {
      const result = await h.kit.invokeAction('branches-create', { ...linked, name: branch.name, correlation, initialization: 'parent-schema', parentBranchRef });
      expect(result).toMatchObject({ status: 'provisioned', providerIdentity: { providerResourceId: 'saved-project', providerEnvironment: branch.id } });
      const request = h.requests.find(value => value.method === 'POST')!;
      expect(request.url).toBe('https://console.neon.tech/api/v2/projects/saved-project/branches');
      expect(JSON.parse(new TextDecoder().decode(request.body))).toMatchObject({ branch: { parent_id: 'saved-parent' } });
    } finally { await h.kit.dispose(); }
  });

  it('recovers only the branch correlated to the saved native parent', async () => {
    const parentBranchRef = { providerProjectId: 'saved-project', branchId: 'saved-parent' };
    const savedBranch = { ...branch, project_id: parentBranchRef.providerProjectId, parent_id: parentBranchRef.branchId };
    const h = await host(() => ({ branches: [savedBranch, { ...savedBranch, id: 'wrong-parent-child', parent_id: 'br-main' }],
      annotations: Object.fromEntries([branch.id, 'wrong-parent-child'].map(id => [id, { object: { type: 'branch', id }, value: annotation }])), pagination: {} }));
    try {
      expect(await h.kit.invokeAction('branches-create', { ...linked, name: branch.name, correlation, initialization: 'parent-schema', parentBranchRef, recover: true }))
        .toMatchObject({ status: 'provisioned', branchId: branch.id, recovered: true });
      expect(h.requests[0]?.url).toContain('/projects/saved-project/branches?');
    } finally { await h.kit.dispose(); }
  });

  it.each([{ database: 'neondb' }, { id: 'database', purpose: 'data.connection' }, { ...createdSaveIntent }])(
    'refuses incomplete creation custody before contacting Neon (%j)', async partial => {
      const h = await host(() => ({ branch }));
      try {
        await expect(h.kit.invokeAction('branches-create', { ...linked, ...partial, name: branch.name, correlation, initialization: 'parent-schema' }))
          .rejects.toBeDefined();
        expect(h.requests).toEqual([]);
        expect(h.saved).toEqual([]);
      } finally { await h.kit.dispose(); }
    });

  it.each(['default', 'protected', 'foreign branch', 'foreign correlation'] as const)('refuses teardown of %s before DELETE', async kind => {
    const h = await host(() => ({ branch: { ...branch, ...(kind === 'foreign branch' ? { id: 'branch-foreign' }
      : kind === 'default' || kind === 'protected' ? { [kind]: true } : {}) },
      annotation: { object: { type: 'branch', id: branch.id }, value: { ...annotation,
        ...(kind === 'foreign correlation' ? { 'happier.pullRequest': '18' } : {}) } } }));
    try {
      await expect(h.kit.invokeAction('branches-delete', { ...previewLink, branchId: branch.id, correlation })).rejects.toMatchObject({ code: 'deployment_conflict' });
      expect(h.requests.every(item => item.method === 'GET')).toBe(true);
    } finally { await h.kit.dispose(); }
  });

  it('deletes only the exact owned preview and preserves the provider operation until settled', async () => {
    const h = await host(request => request.method === 'DELETE' ? { branch, operations: [nativeOperation(deleteOperationId, branch.id, 'delete_timeline')] }
      : { branch, annotation: { object: { type: 'console/branch', id: branch.id }, value: annotation } });
    try {
      expect(await h.kit.invokeAction('branches-delete', { ...previewLink, branchId: branch.id, correlation }))
        .toMatchObject({ status: 'provisioned', branchId: branch.id, ready: false, operationIds: [deleteOperationId] });
      expect(h.requests.filter(request => request.method === 'DELETE').map(request => request.url))
        .toEqual(['https://console.neon.tech/api/v2/projects/project-example/branches/br-preview']);
    } finally { await h.kit.dispose(); }
  });

  it('re-observes the exact branch after a lost DELETE without replaying the mutation', async () => {
    let deleted = false;
    const h = await host(request => {
      if (request.method === 'DELETE') { deleted = true; throw new Error('Delete response lost'); }
      return deleted ? {} : { branch, annotation: { object: { type: 'console/branch', id: branch.id }, value: annotation } };
    }, undefined, () => deleted ? 404 : 200);
    try {
      expect(await h.kit.invokeAction('branches-delete', { ...previewLink, branchId: branch.id, correlation }))
        .toMatchObject({ status: 'deleted', providerProjectId: project.id, branchId: branch.id, ready: true });
      expect(h.requests.map(request => request.method)).toEqual(['GET', 'DELETE', 'GET']);
    } finally { await h.kit.dispose(); }
  });

  it('re-observes successful DELETE with malformed operation metadata instead of reporting definite failure', async () => {
    let deleted = false;
    const h = await host(request => {
      if (request.method === 'DELETE') {
        deleted = true;
        return { branch, operations: [{ ...nativeOperation(deleteOperationId, branch.id, 'delete_timeline'), status: 42 }] };
      }
      return deleted ? {} : { branch, annotation: { object: { type: 'branch', id: branch.id }, value: annotation } };
    }, undefined, request => request.method === 'GET' && deleted ? 404 : 200);
    try {
      expect(await h.kit.invokeAction('branches-delete', { ...previewLink, branchId: branch.id, correlation }))
        .toMatchObject({ status: 'deleted', providerProjectId: project.id, branchId: branch.id });
      expect(h.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
      expect(h.requests.filter(request => request.method === 'GET')).toHaveLength(2);
      expect(h.saved).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it('retains created resource identity and completed secret refs when custody fails mid-create', async () => {
    const h = await host(request => request.method === 'POST' ? { branch, endpoints: [endpoint('ep-preview', branch.id)],
      operations: [nativeOperation(branchOperationId)], roles: [], databases: [], connection_uris: [
        { connection_uri: 'postgresql://owner:private@example-pooler/neondb', connection_parameters: {
          database: 'neondb', role: 'owner', password: 'private', host: 'example', pooler_host: 'example-pooler' } },
        { connection_uri: 'postgresql://owner:private@example/neondb', connection_parameters: {
          database: 'neondb', role: 'owner', password: 'private', host: 'example', pooler_host: 'example-pooler' } },
      ] } : {}, 2);
    try {
      expect(await h.kit.invokeAction('branches-create', { ...linked, ...createPair, name: branch.name, correlation, initialization: 'parent-schema' }))
        .toMatchObject({ status: 'provisioned', providerProjectId: project.id, branchId: branch.id,
          connectionSave: { status: 'partial', connections: { DATABASE_URL: { ref: 'saved:1' } }, incomplete: ['DIRECT_URL'] } });
      expect(h.requests).toHaveLength(1);
      expect(h.saved).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it.each(['wrong-role', 'duplicate-mode'])('keeps native recovery without transferring ambiguous created credentials (%s)', async kind => {
    const connection = { connection_uri: `postgresql://${kind === 'wrong-role' ? 'foreign-owner' : 'owner'}:private@example/neondb`, connection_parameters: {
      database: 'neondb', role: kind === 'wrong-role' ? 'foreign-owner' : 'owner', password: 'private', host: 'example', pooler_host: 'example-pooler' } };
    const h = await host(() => ({ branch, endpoints: [endpoint('ep-preview', branch.id)], roles: [], databases: [],
      operations: [nativeOperation(branchOperationId)], connection_uris: kind === 'duplicate-mode' ? [connection, connection] : [connection] }));
    try {
      expect(await h.kit.invokeAction('branches-create', { ...linked, ...createPair, name: branch.name, correlation, initialization: 'parent-schema' }))
        .toMatchObject({ status: 'provisioned', providerProjectId: project.id, branchId: branch.id,
          connectionSave: { status: 'partial', connections: {}, code: 'provider_response_invalid' } });
      expect(h.saved).toHaveLength(0);
      expect(h.requests).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it.each([false, true])('preserves a selected roles-only credential through existing custody before projection (refused=%s)', async refused => {
    const h = await host(() => ({ branch, endpoints: [endpoint('ep-preview', branch.id)],
      operations: [nativeOperation(branchOperationId)], roles: [
        { branch_id: branch.id, name: 'unrelated-role', password: 'unrelated-private', created_at: '2026-10-30T00:00:00Z', updated_at: '2026-10-30T00:00:00Z' },
        { branch_id: branch.id, name: 'owner', password: 'selected-private', created_at: '2026-10-30T00:00:00Z', updated_at: '2026-10-30T00:00:00Z' },
      ], databases: [{ name: 'neondb', owner_name: 'owner', branch_id: branch.id, created_at: timestamp, updated_at: timestamp }] }), refused ? 1 : undefined);
    try {
      const result = await h.kit.invokeAction('branches-create', { ...linked, ...createPair, rolePasswordLabel: 'Generated Neon role password',
        name: branch.name, correlation, initialization: 'parent-schema' });
      expect(result).toMatchObject({ status: 'provisioned', providerProjectId: project.id, branchId: branch.id,
        connectionSave: { status: 'partial', connections: {}, incomplete: ['DATABASE_URL', 'DIRECT_URL'] } });
      if (refused) {
        expect(result).toMatchObject({ code: 'plugin_secret_custody_unavailable' });
        expect(result).not.toHaveProperty('rolePassword');
        expect(h.saved).toHaveLength(0);
      } else {
        expect(result).toMatchObject({ rolePassword: { role: 'owner', ref: 'saved:1', resourceRevision: 1 } });
        expect(h.saved).toEqual([{ id: 'database', value: 'selected-private', audience: pair.audience }]);
      }
      expect(JSON.stringify(result)).not.toMatch(/selected-private|unrelated-private/u);
      expect(h.requests).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('preserves the selected role password when returned connection URIs belong only to another role', async () => {
    const h = await host(() => ({ branch, endpoints: [endpoint('ep-preview', branch.id)], operations: [nativeOperation(branchOperationId)],
      connection_uris: [{ connection_uri: 'postgresql://other-role:unrelated-private@example/neondb', connection_parameters: {
        database: 'neondb', role: 'other-role', password: 'unrelated-private', host: 'example', pooler_host: 'example-pooler' } }],
      roles: [{ branch_id: branch.id, name: 'owner', password: 'selected-private', created_at: timestamp, updated_at: timestamp }],
      databases: [{ name: 'neondb', owner_name: 'owner', branch_id: branch.id, created_at: timestamp, updated_at: timestamp }] }));
    try {
      const result = await h.kit.invokeAction('branches-create', { ...linked, ...createPair,
        name: branch.name, correlation, initialization: 'parent-schema' });
      expect(result).toMatchObject({ status: 'provisioned', providerProjectId: project.id, branchId: branch.id,
        rolePassword: { role: 'owner', ref: 'saved:1', resourceRevision: 1 },
        connectionSave: { status: 'partial', connections: {}, incomplete: ['DATABASE_URL', 'DIRECT_URL'] } });
      expect(result).not.toHaveProperty('code');
      expect(h.saved).toEqual([{ id: 'database', value: 'selected-private', audience: pair.audience }]);
      expect(h.requests).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(/selected-private|unrelated-private|postgresql/u);
    } finally { await h.kit.dispose(); }
  });

  it('projects only one selected organization page and provider-derived plan and region facts', async () => {
    const h = await host(request => request.url.includes('/regions') ? { regions: [region] }
      : request.url.includes('/organizations/') ? organization
      : { projects: [project], unavailable_project_ids: ['inaccessible'], pagination: { cursor: 'next-page' } });
    try {
      expect(await h.kit.invokeAction('projects-list-read', { ...preparation('projects-list-read'), cursor: 'page' })).toMatchObject({ projects: [{ providerProjectId: project.id }], nextCursor: 'next-page', unavailableProjectIds: ['inaccessible'] });
      expect(h.requests).toHaveLength(1);
      expect(new URL(h.requests[0]!.url).searchParams.get('org_id')).toBe('org-example');
      expect(await h.kit.invokeAction('provision-options-read', preparation('provision-options-read'))).toMatchObject({ regions: [{ id: 'aws-eu-central-1', title: 'Frankfurt' }], plan: 'launch', price: 'unknown' });
    } finally { await h.kit.dispose(); }
  });

  it('provisions once and captures returned credentials before projecting a pending resource', async () => {
    const h = await host(request => request.method === 'POST' ? { project, branch: mainBranch,
      roles: [{ branch_id: 'br-main', name: 'owner', password: 'created-private', created_at: timestamp, updated_at: timestamp }],
      databases: [{ name: 'neondb', owner_name: 'owner', branch_id: 'br-main', created_at: timestamp, updated_at: timestamp }],
      endpoints: [endpoint('ep-main', 'br-main')], operations: [nativeOperation(projectOperationId, 'br-main')],
      connection_uris: [{ connection_uri: 'postgresql://owner:created-private@example/neondb',
        connection_parameters: { database: 'neondb', role: 'owner', password: 'created-private', host: 'example', pooler_host: 'example-pooler' } }] }
      : request.url.includes('/regions') ? { regions: [region] }
      : organization);
    try {
      const result = await h.kit.invokeAction('projects-provision', { ...base, ...createPair,
        name: 'Example', regionId: project.region_id, requestKey: 'existing-reviewed-request' });
      expect(result).toMatchObject({ status: 'provisioned', providerProjectId: project.id, branchId: 'br-main', ready: false,
        operationIds: [projectOperationId], connectionSave: { status: 'partial', connections: { DIRECT_URL: { ref: 'saved:1' } } } });
      expect(h.saved).toHaveLength(1);
      expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(/created-private|postgresql/u);
    } finally { await h.kit.dispose(); }
  });

  it('retains an unknown project create when no exact annotated identity is visible, with zero POST replay', async () => {
    const h = await host(request => {
      if (request.method === 'POST') throw new Error('response lost');
      if (request.url.includes('/regions')) return { regions: [region] };
      if (request.url.includes('/organizations/')) return organization;
      return { projects: [], unavailable_project_ids: [], pagination: { cursor: 'next-page' } };
    });
    try {
      expect(await h.kit.invokeAction('projects-provision', { ...base, ...createPair,
        name: 'Example', regionId: project.region_id, requestKey: 'existing-reviewed-request' }))
        .toMatchObject({ status: 'outcome_unknown', nextCursor: 'next-page' });
      expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      expect(h.saved).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it.each(['branch', 'project'])('does not mistake a last-page %s recovery cursor for complete uniqueness', async kind => {
    const h = await host(request => request.url.includes('/projects?')
      ? { projects: [project], unavailable_project_ids: [], pagination: {} }
      : { branches: [branch], pagination: {}, annotations: { [branch.id]: { object: { type: 'branch', id: branch.id },
        value: kind === 'branch' ? annotation : { 'happier.environment': 'environment', 'happier.operation': 'reviewed-request' } } } });
    try {
      const result = kind === 'branch'
        ? await h.kit.invokeAction('branches-create', { ...linked, ...createPair, name: branch.name, correlation,
          initialization: 'parent-schema', recover: true, cursor: 'later-page' })
        : await h.kit.invokeAction('projects-provision', { ...base, ...createPair, name: project.name, regionId: project.region_id,
          requestKey: 'reviewed-request', recover: true, cursor: 'later-page' });
      expect(result).toMatchObject({ status: 'outcome_unknown' });
      expect(h.requests.every(request => request.method === 'GET')).toBe(true);
      expect(h.saved).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it('retains a post-send HTTP failure code as unknown but preserves proven pre-send credential refusals', async () => {
    let refusedBeforeSend = false;
    const h = await host(request => {
      if (request.method === 'POST') throw new PluginError({ code: refusedBeforeSend
        ? 'plugin_connected_account_binding_out_of_scope' : 'plugin_fetch_response_too_large' });
      return { branches: [], annotations: {}, pagination: {} };
    });
    try {
      const input = { ...linked, ...createPair, name: branch.name, correlation, initialization: 'parent-schema' };
      expect(await h.kit.invokeAction('branches-create', input))
        .toMatchObject({ status: 'outcome_unknown', code: 'plugin_fetch_response_too_large' });
      expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      refusedBeforeSend = true;
      await expect(h.kit.invokeAction('branches-create', input)).rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
      expect(h.requests.filter(request => request.method === 'GET')).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('treats received 500 as an unknown write while received 503 and 403 remain definite refusals', async () => {
    let status = 500;
    const h = await host(request => request.method === 'POST' ? { code: 'provider-error', message: 'Constructed provider failure' }
      : { branches: [], annotations: {}, pagination: {} }, undefined, request => request.method === 'POST' ? status : 200);
    const input = { ...linked, ...createPair, name: branch.name, correlation, initialization: 'parent-schema' };
    try {
      expect(await h.kit.invokeAction('branches-create', input)).toMatchObject({ status: 'outcome_unknown' });
      expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      expect(h.requests.filter(request => request.method === 'GET')).toHaveLength(1);
      status = 503;
      await expect(h.kit.invokeAction('branches-create', input)).rejects.toMatchObject({ code: 'provider_request_failed', details: { httpStatus: 503 } });
      status = 403;
      await expect(h.kit.invokeAction('branches-create', input)).rejects.toMatchObject({ code: 'deployment_access_denied', details: { httpStatus: 403 } });
      expect(h.requests.filter(request => request.method === 'GET')).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it.each([false, true])('keeps malformed successful create metadata unknown with retained custody while malformed reads remain definite failures (different recovery=%s)', async differentRecovery => {
    const malformed = { ...nativeOperation(branchOperationId), status: 42 };
    const h = await host(request => request.method === 'POST' ? { branch, operations: [malformed],
      endpoints: [endpoint('ep-preview', branch.id)], roles: [], databases: [],
      connection_uris: [{ connection_uri: 'postgresql://owner:created-private@example/neondb', connection_parameters: {
        database: 'neondb', role: 'owner', password: 'created-private', host: 'example', pooler_host: 'example-pooler' } }] }
      : request.url.includes('/operations/') ? { operation: { ...malformed, branch_id: 'br-main' } }
      : { branches: differentRecovery ? [{ ...branch, id: 'br-unrelated' }] : [],
        annotations: differentRecovery ? { 'br-unrelated': { object: { type: 'branch', id: 'br-unrelated' }, value: annotation } } : {}, pagination: {} });
    try {
      expect(await h.kit.invokeAction('branches-create', { ...linked, ...createPair,
        name: branch.name, correlation, initialization: 'parent-schema' }))
        .toMatchObject({ status: 'outcome_unknown', providerProjectId: project.id, branchId: branch.id, code: 'provider_response_invalid',
          connectionSave: { status: 'partial', connections: { DIRECT_URL: { ref: 'saved:1', resourceRevision: 1 } } } });
      expect(h.saved).toHaveLength(1);
      expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      expect(h.requests.filter(request => request.method === 'GET')).toHaveLength(1);
      await expect(h.kit.invokeAction('branches-list-read', { ...linked, operationIds: [branchOperationId] }))
        .rejects.toMatchObject({ code: 'provider_response_invalid' });
      expect(h.saved).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('observes the exact returned operation rather than treating branch readiness as provision completion', async () => {
    const h = await host(request => request.url.includes('/operations/')
      ? { operation: nativeOperation(projectOperationId, 'br-main') }
      : { branch: mainBranch, annotation: { object: { type: 'console/branch', id: 'br-main' }, value: {} } });
    try {
      expect(await h.kit.invokeAction('branches-list-read', { ...linked, branchId: 'br-main', operationIds: [projectOperationId] }))
        .toMatchObject({ branches: [{ branchId: 'br-main', ready: false }], operations: [{ id: projectOperationId, status: 'running' }] });
      expect(h.requests).toHaveLength(2);
    } finally { await h.kit.dispose(); }
  });
});

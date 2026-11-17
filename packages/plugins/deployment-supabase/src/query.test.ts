import { describe, expect, it } from 'vitest';
import { definePlugin, DeploymentTargetPreparationBaseV1ProtocolSchema, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { DatabaseOperationResultV1ProtocolSchema, type DatabaseOperationInputV1, type DatabaseTargetsListResultV1 } from '@happier-dev/database-protocol';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import * as entry from './index.js';
import { accountExecution } from './data/actions.js';

const credentialRef = { service: { pluginId: 'happier.deploy.supabase', localId: 'supabase' }, accountId: 'connected' };
const preparation = DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  targetLinkId: 'data-link', expectedTargetLinkRevision: 1, credentialRef,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: credentialRef.service.pluginId, localId: 'database' }, purpose: 'deploy-manage' }, target: { kind: 'account', account: credentialRef } },
  providerIdentity: { providerAccountId: 'org', providerResourceId: 'parent-ref', providerEnvironment: 'preview-ref' },
  providerEnvironment: { kind: 'custom', id: 'preview-ref' } });

async function host(body: unknown = [{ value: 'hello', nullable: null }], status = 201, error?: Error, onRequest?: () => void, errorAtRequest = 1, database = 'postgres') {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    onRequest?.();
    if (error && requests.length === errorAtRequest) throw error;
    const query = JSON.parse(new TextDecoder().decode(request.body)).query;
    const response = query === 'SELECT current_database() AS database' ? [{ database }] : body;
    return { status, body: new TextEncoder().encode(JSON.stringify(response)), headers: {} };
  } });
  const secrets: SecretsService = {
    async readDataRole() { throw new PluginError({ code: 'write_connection_setup_required' }); },
    async readSavedSecret() { throw new Error('No account-custody bypass'); },
    async saveShared() { throw new Error('No query-time secret writer'); },
    async get() { throw new Error('No account-secret fallback'); },
    async set() { throw new Error('No query-time secret writer'); },
    async delete() { throw new Error('No query-time secret writer'); },
    async status() { return { state: 'missing', revision: '0' }; },
  };
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http, secrets } });
  return { kit, requests, services: { http, secrets } };
}

const placement = { serverId: 'home', accountId: 'owner', machineId: 'daemon', installationId: 'installation' };
const managedTarget = { kind: 'managed_deployment' as const,
  environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' },
  targetLinkId: 'data-link', contribution: { pluginId: credentialRef.service.pluginId, contributionId: 'database' },
  platformProjectId: 'parent-ref', branchId: 'preview-ref', database: 'selected_db' };

async function managed(h: Awaited<ReturnType<typeof host>>, operation: DatabaseOperationInputV1, discover = false, signal?: AbortSignal,
  access: 'read' | 'write' = 'read') {
  const runtime = h.kit.registration('deploymentTargets', 'database');
  expect(runtime, 'The existing Supabase data target must register its private database runtime').toBeDefined();
  if (!runtime) throw new Error('Managed database runtime is missing');
  let listing: DatabaseTargetsListResultV1 | undefined;
  // The real SDK host provides the portable context; only third-party HTTPS is substituted.
  const probe = definePlugin({ id: 'test.supabase-database', version: '0.0.0', actions: { probe: {
    title: 'Probe', execution: accountExecution, scopes: ['global'], surfaces: ['cli'], dangerLevel: 'safe', readOnly: true,
    resultSchema: DatabaseOperationResultV1ProtocolSchema,
    async run(_input: JsonValue, context: PluginAccountActionContext) {
      if (discover) {
        const { database: _database, ...target } = managedTarget;
        listing = await runtime.listTargets({ preparation, target, placement }, context);
      }
      const resolved = await runtime.open({ preparation, target: managedTarget, access, placement }, context);
      try { return await resolved.connection.execute(operation, context.signal); }
      finally { await resolved.connection.close(); }
    },
  } } });
  const runner = await createPluginTestkit({ manifest: probe.manifest, module: probe, services: h.services });
  try { return { result: await runner.invokeAction('probe', {}, { signal }), listing }; }
  finally { await runner.dispose(); }
}

describe('Supabase managed database runtime', () => {
  const read = { operation: 'statement.run' as const, mode: 'read' as const, target: managedTarget,
    statement: { sql: 'SELECT $1::bigint AS value, $2::text AS empty, NULL AS absent', parameters: [
      { type: 'integer' as const, value: '9007199254740993' }, { type: 'text' as const, value: '' }] } };

  it('discovers the actual selected database and exposes restricted object frames honestly', async () => {
    const h = await host([{ value: '9007199254740993', empty: '', absent: null, payload: { nested: true } }], 201, undefined, undefined, 1, 'selected_db');
    try {
      const { result, listing } = await managed(h, read, true);
      expect(listing).toMatchObject({ targets: [{ target: managedTarget, placement, capabilities: expect.arrayContaining([
        { operation: 'describe', available: true }, { operation: 'statement.run', available: true },
      ]) }], completeness: { complete: true } });
      expect(result).toMatchObject({ ok: true, operation: 'statement.run', results: [{
        columns: ['value', 'empty', 'absent', 'payload'].map(name => ({ name, nativeType: 'unknown', semanticType: 'unknown' })),
        rows: [{ cells: [{ type: 'text', value: '9007199254740993' }, { type: 'text', value: '' }, { type: 'null' }, { type: 'json', value: '{"nested":true}' }] }],
        completeness: { complete: false, reason: 'transport_unproven' },
      }] });
      expect(h.requests.every(request => request.url === 'https://api.supabase.com/v1/projects/preview-ref/database/query/read-only')).toBe(true);
      expect(h.requests.every(request => request.credentialBinding?.kind === 'connectedAccountPurpose' && request.credentialBinding.purpose === 'deploy-manage')).toBe(true);
      expect(JSON.parse(new TextDecoder().decode(h.requests.at(-1)?.body))).toEqual({ query: read.statement.sql, parameters: ['9007199254740993', ''] });
    } finally { await h.kit.dispose(); }
  });

  it('proves a semantic read before refusing writes without a provider POST', async () => {
    const h = await host([{ value: 'selected-preview' }], 201, undefined, undefined, 1, 'selected_db');
    try {
      expect((await managed(h, read)).result).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'selected-preview' }] }] }] });
      const before = h.requests.length;
      await expect(managed(h, { operation: 'statement.run', mode: 'write', target: managedTarget, executionMode: 'transaction',
        statements: [{ sql: 'UPDATE items SET value = 1', parameters: [] }] }, false, undefined, 'write'))
        .rejects.toMatchObject({ code: 'write_connection_setup_required' });
      expect(h.requests).toHaveLength(before);
    } finally { await h.kit.dispose(); }
  });

  it('keeps zero-row metadata explicitly unproven and preserves the original provider failure code', async () => {
    const h = await host([], 201, undefined, undefined, 1, 'selected_db');
    try {
      expect((await managed(h, read)).result).toMatchObject({ ok: true, results: [{ columns: [], rows: [], completeness: { complete: false, reason: 'transport_unproven' } }] });
    } finally { await h.kit.dispose(); }
    const failed = await host([], 201, new PluginError({ code: 'provider_http_429' }), undefined, 2, 'selected_db');
    try {
      expect((await managed(failed, read)).result).toMatchObject({ ok: false, status: 'failed', cause: { code: 'provider_http_429' } });
      expect(failed.requests).toHaveLength(2);
    } finally { await failed.kit.dispose(); }
  });
});

describe('Supabase selected read transport failures', () => {
  const read = { operation: 'statement.run' as const, mode: 'read' as const, target: managedTarget,
    statement: { sql: 'SELECT $1::text AS value', parameters: [{ type: 'text' as const, value: 'hello' }] } };

  it('refuses a database the dedicated provider endpoint cannot select', async () => {
    const h = await host();
    try {
      await expect(managed(h, read)).rejects.toMatchObject({ code: 'database_unsupported' });
      expect(h.requests).toHaveLength(1);
      expect(JSON.parse(new TextDecoder().decode(h.requests[0]?.body)).query).toBe('SELECT current_database() AS database');
    } finally { await h.kit.dispose(); }
  });

  it.each([401, 403, 429, 500])('settles HTTP %s without replaying or exposing provider echoes', async status => {
    const h = await host({ message: 'private-password SQL text' }, status);
    try {
      await expect(managed(h, read)).rejects.toMatchObject({ code: `provider_http_${status}` });
      expect(h.requests).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('reports unavailable when database selection cannot fit the response boundary', async () => {
    const h = await host(undefined, 201, new PluginError({ code: 'plugin_fetch_response_too_large' }));
    try {
      await expect(managed(h, read)).rejects.toMatchObject({ code: 'action_result_size_limit' });
      expect(h.requests).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('preserves the size failure when query transport exceeds the response boundary', async () => {
    const h = await host(undefined, 201, new PluginError({ code: 'plugin_fetch_response_too_large' }), undefined, 2, 'selected_db');
    try {
      expect((await managed(h, read)).result).toMatchObject({ ok: false, status: 'failed',
        cause: { code: 'plugin_fetch_response_too_large' } });
      expect(h.requests).toHaveLength(2);
    } finally { await h.kit.dispose(); }
  });

  it('rejects malformed results rather than reporting empty success', async () => {
    const h = await host({ error: 'private echo' }, 201, undefined, undefined, 1, 'selected_db');
    try {
      expect((await managed(h, read)).result).toMatchObject({ ok: false, status: 'failed', cause: { code: 'provider_response_invalid' } });
    } finally { await h.kit.dispose(); }
  });

  it('settles cancellation without mutation uncertainty or retry', async () => {
    const controller = new AbortController();
    const h = await host([], 201, undefined, () => controller.abort());
    try {
      await expect(managed(h, read, false, controller.signal)).rejects.toMatchObject({ code: 'plugin_action_aborted' });
      expect(h.requests).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });
});

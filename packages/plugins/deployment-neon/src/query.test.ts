import { describe, expect, it } from 'vitest';
import { definePlugin, DeploymentTargetPreparationBaseV1ProtocolSchema, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import {
    DatabaseReadStatementInputV1Schema,
    DatabaseOperationResultV1Schema as DatabaseOperationResultV1ProtocolSchema,
    type DatabaseOperationInputV1,
} from '@happier-dev/plugin-sdk/database';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import * as entry from './index.js';
import { accountExecution } from './data/actions.js';

const credentialRef = { service: { pluginId: 'happier.deploy.neon', localId: 'neon' }, accountId: 'connected' };
const input = { ...DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
    targetLinkId: 'data-link', expectedTargetLinkRevision: 1, credentialRef,
    credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: credentialRef.service.pluginId, localId: 'database' }, purpose: 'deploy-manage' }, target: { kind: 'account', account: credentialRef } },
    providerIdentity: { providerAccountId: 'org', providerResourceId: 'project', providerEnvironment: 'br-main' }, providerEnvironment: { kind: 'native', selection: { branchId: 'br-main' } } }),
    database: 'neondb', sql: 'select $1::text as value', params: { '1': 'hello' } };

// Public driver response example and Neon v2 schema vectors, recorded 2026-11-12.
// https://github.com/neondatabase/serverless/blob/main/src/http/index.ts
// https://neon.com/api_spec/release/v2.json — no tenant captures or credentials.
const endpoint = { id: 'ep-main', project_id: 'project', branch_id: 'br-main', type: 'read_write',
  host: 'ep-main.eu-central-1.aws.neon.tech', disabled: false };
const result = { command: 'SELECT', fields: [{ name: 'value', dataTypeID: 25 }], rowCount: 1, rows: [['hello']], rowAsArray: true };

async function host(options: { status?: number; body?: unknown; endpoint?: typeof endpoint; missingRole?: boolean;
  mayAcquireRole?: () => boolean } = {}) {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    const path = new URL(request.url).pathname;
    const body = path.endsWith('/endpoints') ? { endpoints: [options.endpoint ?? endpoint] }
      : path.endsWith('/databases') ? { databases: [{ name: 'neondb', branch_id: 'br-main' }] }
        : options.body ?? { results: [{ command: 'DO', fields: [], rows: [], rowCount: null, rowAsArray: true }, result] };
    return { status: path === '/sql' ? options.status ?? 200 : 200,
      body: new TextEncoder().encode(JSON.stringify(body)), headers: {} };
  } });
  const secrets = {
    async readDataRole(roleOptions?: Parameters<NonNullable<SecretsService['readDataRole']>>[0]) {
      if (roleOptions?.role === 'write') throw new PluginError({ code: 'write_connection_setup_required' });
      if (options.missingRole || options.mayAcquireRole?.() === false) throw new PluginError({ code: 'secret_missing' });
      return 'fixture-role-password';
    },
    async readSavedSecret() { throw new Error('No account-custody bypass'); },
    async saveShared() { throw new Error('No query-time secret writer'); },
    async get() { throw new Error('No account-secret fallback'); },
    async set() { throw new Error('No query-time secret writer'); },
    async delete() { throw new Error('No query-time secret writer'); },
    async status() { return { state: 'missing' as const, revision: '0' }; },
  };
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http, secrets } });
  return { kit, requests, services: { http, secrets } };
}


// Real SDK activation/context underneath the HTTP and custody boundary fixtures.
async function invokeManaged(h: Awaited<ReturnType<typeof host>>, operand: DatabaseOperationInputV1,
  options: Readonly<{ access?: 'read' | 'write'; afterOpen?: () => void }> = {}) {
  const runtime = h.kit.registration('deploymentTargets', 'database');
  if (!runtime) throw new Error('Managed database runtime is missing');
  if (operand.target.kind !== 'managed_deployment') throw new Error('Expected managed target fixture');
  const target = operand.target;
  const probe = definePlugin({ id: 'test.neon-dialect', version: '0.0.0', actions: { probe: {
        title: 'Probe', execution: accountExecution, scopes: ['global'], surfaces: ['cli'], dangerLevel: 'safe', readOnly: true,
        resultSchema: DatabaseOperationResultV1ProtocolSchema,
        async run(_input: JsonValue, context: PluginAccountActionContext) {
          const resolved = await runtime.open({ preparation: input, target, access: options.access ?? 'read',
            placement: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' } }, context);
          options.afterOpen?.();
          try { return await resolved.connection.execute(operand, context.signal); }
          finally { await resolved.connection.close(); }
        },
      } } });
  const runner = await createPluginTestkit({ manifest: probe.manifest, module: probe, services: h.services });
  try { return await runner.invokeAction('probe', {}); }
  finally { await runner.dispose(); }
}

const target = { kind: 'managed_deployment' as const, environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' },
  targetLinkId: 'data-link', contribution: { pluginId: credentialRef.service.pluginId, contributionId: 'database' },
  platformProjectId: 'project', branchId: 'br-main', database: 'neondb' };
const read = DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', mode: 'read', target,
  statement: { sql: input.sql, parameters: [{ type: 'text', value: 'hello' }] } });

describe('Neon qualified read-only SQL', () => {
  it('advertises reviewed Enable and returns typed recovery for a missing statistics extension', async () => {
    const fields = ['database', 'database_oid', 'current_user', 'server_address', 'server_port',
      'server_version', 'engine_started_at', 'extension_schema', 'extension_version'];
    const h = await host({ body: { results: [{ command: 'DO' }, { command: 'SELECT', rowCount: 1,
      fields: fields.map(name => ({ name, dataTypeID: 25 })),
      rows: [['neondb', '16384', 'happier_ro', '192.0.2.1', '5432', '160000', '2026-01-01', null, null]] }] } });
    try {
      const described = await invokeManaged(h, { operation: 'describe', target });
      expect(described).toMatchObject({ ok: true, descriptor: { capabilities: expect.arrayContaining([
        { operation: 'stats.read', available: true }, { operation: 'stats.enable', available: true },
      ]) } });
      expect(await invokeManaged(h, { operation: 'stats.read', target,
        request: { kind: 'stats.read', group: 'statements', selection: { page: { rows: 10 }, order: 'calls' } } }))
        .toMatchObject({ ok: true, operation: 'stats.read', observation: { status: 'unavailable', reason: 'extension_missing' } });
    } finally { await h.kit.dispose(); }
  });

  it('runs the registered selected transport through the shared dialect without losing native field types', async () => {
    const h = await host({ body: { results: [{ command: 'DO' }, { command: 'SELECT', rowCount: 1,
      fields: [{ name: 'duplicate', dataTypeID: 20 }, { name: 'duplicate', dataTypeID: 25 }, { name: 'absent', dataTypeID: 25 }],
      rows: [['9007199254740993', '', null]] }] } });
    try {
      const runtime = h.kit.registration('deploymentTargets', 'database');
      expect(runtime, 'The existing data target must bind its private database runtime').toBeDefined();
      if (!runtime) throw new Error('Managed database runtime is missing');
      const target = { kind: 'managed_deployment' as const, environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' },
        targetLinkId: 'data-link', contribution: { pluginId: credentialRef.service.pluginId, contributionId: 'database' },
        platformProjectId: 'project', branchId: 'br-main', database: 'neondb' };
      const operand = DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', mode: 'read', target,
        statement: { sql: 'SELECT $1::bigint AS duplicate, $2::text AS duplicate, NULL::text AS absent', parameters: [
          { type: 'integer', value: '9007199254740993' }, { type: 'text', value: '' }] } });
      expect(await invokeManaged(h, operand)).toMatchObject({ ok: true, operation: 'statement.run', results: [{
        columns: [{ name: 'duplicate', semanticType: 'integer' }, { name: 'duplicate', semanticType: 'text' }, { name: 'absent' }],
        rows: [{ cells: [{ type: 'integer', value: '9007199254740993' }, { type: 'text', value: '' }, { type: 'null' }] }],
        completeness: { complete: true },
      }] });
      const body = JSON.parse(new TextDecoder().decode(h.requests.find(request => new URL(request.url).pathname === '/sql')!.body));
      expect(body.queries[1].params).toEqual(['9007199254740993', '']);
      const requestsBeforeWrite = h.requests.length;
      await expect(invokeManaged(h, { operation: 'statement.run', mode: 'write', target,
        executionMode: 'transaction', statements: [{ sql: 'UPDATE items SET value = 1', parameters: [] }] }, { access: 'write' }))
        .rejects.toMatchObject({ code: 'write_connection_setup_required' });
      expect(h.requests.length).toBe(requestsBeforeWrite);
    } finally { await h.kit.dispose(); }
  });
  it('captures the selected read login before the finite open admission ends', async () => {
    let mayAcquireRole = true;
    const h = await host({ mayAcquireRole: () => mayAcquireRole });
    try {
      const target = { kind: 'managed_deployment' as const, environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' },
        targetLinkId: 'data-link', contribution: { pluginId: credentialRef.service.pluginId, contributionId: 'database' },
        platformProjectId: 'project', branchId: 'br-main', database: 'neondb' };
      expect(await invokeManaged(h, DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', mode: 'read', target,
        statement: { sql: 'SELECT $1::text AS value', parameters: [{ type: 'text', value: 'hello' }] } }),
      { afterOpen: () => { mayAcquireRole = false; } })).toMatchObject({ ok: true,
        results: [{ rows: [{ cells: [{ type: 'text', value: 'hello' }] }] }] });
    } finally { await h.kit.dispose(); }
  });
  it('preserves a native SQLSTATE at the semantic Action boundary without exposing provider text', async () => {
    const h = await host({ status: 400, body: { code: '42601', message: 'private SQL and fixture-role-password' } });
    try {
      const target = { kind: 'managed_deployment' as const, environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' },
        targetLinkId: 'data-link', contribution: { pluginId: credentialRef.service.pluginId, contributionId: 'database' },
        platformProjectId: 'project', branchId: 'br-main', database: 'neondb' };
      const result = await invokeManaged(h, DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', mode: 'read', target,
        statement: { sql: 'SELECT invalid syntax', parameters: [] } }));
      expect(result).toMatchObject({ ok: false, code: 'database_engine_error', cause: { source: 'engine', code: '42601', statementIndex: 0 } });
      expect(JSON.stringify(result)).not.toContain('fixture-role-password');
      expect(JSON.stringify(result)).not.toContain('private SQL');
    } finally { await h.kit.dispose(); }
  });

  it('keeps a missing read-role binding unavailable at the semantic Action boundary', async () => {
    const h = await host({ missingRole: true });
    try {
      const target = { kind: 'managed_deployment' as const, environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' },
        targetLinkId: 'data-link', contribution: { pluginId: credentialRef.service.pluginId, contributionId: 'database' },
        platformProjectId: 'project', branchId: 'br-main', database: 'neondb' };
      const result = await invokeManaged(h, DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', mode: 'read', target,
        statement: { sql: 'SELECT 1', parameters: [] } }));
      expect(result).toMatchObject({ ok: false, status: 'unavailable', code: 'database_transport_unavailable', reason: 'secret_missing' });
      expect(h.requests).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it('executes for the exact branch/database using only the bound read-role login', async () => {
    const h = await host();
    try {
      expect(await invokeManaged(h, read))
        .toMatchObject({ ok: true, results: [{ columns: [{ name: 'value', semanticType: 'text' }], rows: [{ cells: [{ type: 'text', value: 'hello' }] }], completeness: { complete: true } }] });
      const sql = h.requests.filter(request => new URL(request.url).pathname === '/sql');
      expect(sql).toHaveLength(1);
      for (const request of sql) {
        expect(request).toMatchObject({ method: 'POST', redirect: 'error', url: 'https://api.eu-central-1.aws.neon.tech/sql' });
        expect(request.credentialBinding).toBeUndefined();
        const connection = new URL(request.headers!['Neon-Connection-String']!);
        expect(connection.username).toBe('happier_ro');
        expect(connection.hostname).toBe(endpoint.host);
        expect(connection.pathname).toBe('/neondb');
        expect(connection.password).toBe('fixture-role-password');
        expect(request.headers!['Neon-Batch-Read-Only']).toBe('true');
      }
      const payload = JSON.parse(new TextDecoder().decode(sql[0]!.body));
      expect(payload.queries).toHaveLength(2);
      expect(payload.queries[0].query).toContain('happier_read_role_unavailable');
      expect(payload.queries[0].query).toContain("pg_catalog.set_config('application_name', E'happier-database-workbench', true)");
      expect(payload.queries[1]).toEqual({ query: input.sql, params: ['hello'] });
      expect(h.requests.filter(request => request.credentialBinding)).toHaveLength(2);
    } finally { await h.kit.dispose(); }
  });

  it('refuses foreign branch endpoints before sending a role password', async () => {
    const h = await host({ endpoint: { ...endpoint, branch_id: 'br-other' } });
    try {
      await expect(invokeManaged(h, read)).rejects.toMatchObject({ code: 'provider_response_invalid' });
      expect(h.requests.some(request => new URL(request.url).pathname === '/sql')).toBe(false);
    } finally { await h.kit.dispose(); }
  });

  it.each([400, 401, 403, 429, 500])('settles HTTP %s without replay or provider error echoes', async status => {
    const h = await host({ status, body: { message: 'fixture-role-password and private SQL' } });
    try {
      const outcome = await invokeManaged(h, read);
      expect(outcome).toMatchObject({ ok: false, status: 'failed', code: 'database_transport_error', cause: { code: 'query_failed' } });
      expect(JSON.stringify(outcome)).not.toContain('fixture-role-password');
      expect(JSON.stringify(outcome)).not.toContain('private SQL');
      expect(h.requests.filter(request => new URL(request.url).pathname === '/sql')).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it.each([
    { code: '42501', message: 'happier_read_role_unavailable' },
    { code: '28P01', message: 'password authentication failed for user happier_ro' },
  ])('returns role setup unavailable when the database refuses the query login ($code)', async body => {
    const h = await host({ status: 400, body });
    try {
      expect(await invokeManaged(h, read)).toMatchObject({ ok: false, status: 'unavailable', code: 'database_transport_unavailable', reason: 'read_role_unavailable' });
      expect(h.requests.filter(request => new URL(request.url).pathname === '/sql')).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('preserves duplicate names, NULL, empty text and empty-result columns', async () => {
    for (const rows of [[['', null]], []]) {
      const h = await host({ body: { results: [{ command: 'DO' }, { command: 'SELECT',
        fields: [{ name: 'duplicate', dataTypeID: 25 }, { name: 'duplicate', dataTypeID: 25 }], rows, rowCount: rows.length }] } });
      try {
        expect(await invokeManaged(h, read)).toMatchObject({ ok: true, results: [{
          columns: [{ name: 'duplicate' }, { name: 'duplicate' }], rows: rows.map(cells => ({ cells: cells.map(value => value === null ? { type: 'null' } : { type: 'text', value }) })), completeness: { complete: true } }] });
      } finally { await h.kit.dispose(); }
    }
  });

  it('rejects an inconsistent provider row count rather than inventing completeness', async () => {
    const h = await host({ body: { results: [{ command: 'DO' }, { ...result, rowCount: 2 }] } });
    try {
      expect(await invokeManaged(h, read)).toMatchObject({ ok: false, status: 'failed', code: 'database_transport_error', cause: { code: 'provider_response_invalid' } });
    } finally { await h.kit.dispose(); }
  });
});

import { describe, expect, it } from 'vitest';
import { DeploymentTargetPreparationBaseV1ProtocolSchema, PluginError } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/plugin-sdk/actions';
import * as entry from './index.js';

const credentialRef = { service: { pluginId: 'happier.deploy.neon', localId: 'neon' }, accountId: 'connected' };
const input = { ...DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
    targetLinkId: 'data-link', expectedTargetLinkRevision: 1, credentialRef,
    credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: credentialRef.service.pluginId, localId: 'query-read' }, purpose: 'deploy-manage' }, target: { kind: 'account', account: credentialRef } },
    providerIdentity: { providerAccountId: 'org', providerResourceId: 'project', providerEnvironment: 'br-main' }, providerEnvironment: { kind: 'custom', id: 'br-main' } }),
    database: 'neondb', sql: 'select $1::text as value', params: { '1': 'hello' } };

// Public driver response example and Neon v2 schema vectors, recorded 2026-11-12.
// https://github.com/neondatabase/serverless/blob/main/src/http/index.ts
// https://neon.com/api_spec/release/v2.json — no tenant captures or credentials.
const endpoint = { id: 'ep-main', project_id: 'project', branch_id: 'br-main', type: 'read_write',
  host: 'ep-main.eu-central-1.aws.neon.tech', disabled: false };
const result = { command: 'SELECT', fields: [{ name: 'value', dataTypeID: 25 }], rowCount: 1, rows: [['hello']], rowAsArray: true };

async function host(options: { status?: number; body?: unknown; endpoint?: typeof endpoint; missingRole?: boolean } = {}) {
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
    async readDataRole() { if (options.missingRole) throw new PluginError({ code: 'secret_missing' }); return 'fixture-role-password'; },
    async readSavedSecret() { throw new Error('No account-custody bypass'); },
    async saveShared() { throw new Error('No query-time secret writer'); },
    async get() { throw new Error('No account-secret fallback'); },
    async set() { throw new Error('No query-time secret writer'); },
    async delete() { throw new Error('No query-time secret writer'); },
    async status() { return { state: 'missing' as const, revision: '0' }; },
  };
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http, secrets } });
  return { kit, requests };
}

describe('Neon qualified read-only SQL', () => {
  it('executes for the exact branch/database using only the bound read-role login', async () => {
    const h = await host();
    try {
      expect(await h.kit.invokeAction('query-read', input, { surface: 'ui' }))
        .toEqual({ ok: true, columns: [{ name: 'value' }], rows: [['hello']], complete: true });
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
      expect(payload.queries[1]).toEqual({ query: input.sql, params: ['hello'] });
      expect(h.requests.filter(request => request.credentialBinding)).toHaveLength(2);
    } finally { await h.kit.dispose(); }
  });

  it('requires a role binding without acquiring a writable connection', async () => {
    const h = await host({ missingRole: true });
    try {
      expect(await h.kit.invokeAction('query-read', input)).toMatchObject({ ok: false, error: 'deployment_unavailable', diagnostic: { code: 'secret_missing' } });
      expect(h.requests).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it('refuses foreign branch endpoints before sending a role password', async () => {
    const h = await host({ endpoint: { ...endpoint, branch_id: 'br-other' } });
    try {
      await expect(h.kit.invokeAction('query-read', input)).rejects.toMatchObject({ code: 'provider_response_invalid' });
      expect(h.requests.some(request => new URL(request.url).pathname === '/sql')).toBe(false);
    } finally { await h.kit.dispose(); }
  });

  it.each([400, 401, 403, 429, 500])('settles HTTP %s without replay or provider error echoes', async status => {
    const h = await host({ status, body: { message: 'fixture-role-password and private SQL' } });
    try {
      await expect(h.kit.invokeAction('query-read', input)).rejects.toMatchObject({ code: 'query_failed' });
      expect(h.requests.filter(request => new URL(request.url).pathname === '/sql')).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it.each([
    { code: '42501', message: 'happier_read_role_unavailable' },
    { code: '28P01', message: 'password authentication failed for user happier_ro' },
  ])('returns role setup unavailable when the database refuses the query login ($code)', async body => {
    const h = await host({ status: 400, body });
    try {
      expect(await h.kit.invokeAction('query-read', input)).toEqual({ ok: false, error: 'deployment_unavailable',
        diagnostic: { code: 'read_role_unavailable' } });
      expect(h.requests.filter(request => new URL(request.url).pathname === '/sql')).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('refuses invalid positional parameters before custody or HTTP work', async () => {
    const h = await host();
    try {
      await expect(h.kit.invokeAction('query-read', { ...input, params: { '2': 'gap' } })).rejects.toMatchObject({ code: 'query_parameters_invalid' });
      expect(h.requests).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it('preserves duplicate names, NULL, empty text and empty-result columns', async () => {
    for (const rows of [[['', null]], []]) {
      const h = await host({ body: { results: [{ command: 'DO' }, { command: 'SELECT',
        fields: [{ name: 'duplicate' }, { name: 'duplicate' }], rows, rowCount: rows.length }] } });
      try {
        expect(await h.kit.invokeAction('query-read', input)).toEqual({ ok: true,
          columns: [{ name: 'duplicate' }, { name: 'duplicate' }], rows, complete: true });
      } finally { await h.kit.dispose(); }
    }
  });

  it('reports a response that cannot fit the incumbent Action boundary explicitly', async () => {
    const h = await host({ body: { results: [{ command: 'DO' },
      { ...result, rows: [['x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES)]] }] } });
    try {
      expect(await h.kit.invokeAction('query-read', input)).toEqual({ ok: true, columns: [], rows: [], complete: false,
        diagnostic: { code: 'action_result_size_limit' } });
    } finally { await h.kit.dispose(); }
  });

  it('rejects an inconsistent provider row count rather than inventing completeness', async () => {
    const h = await host({ body: { results: [{ command: 'DO' }, { ...result, rowCount: 2 }] } });
    try {
      await expect(h.kit.invokeAction('query-read', input)).rejects.toMatchObject({ code: 'provider_response_invalid' });
    } finally { await h.kit.dispose(); }
  });
});

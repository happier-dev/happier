import { describe, expect, it } from 'vitest';
import { DeploymentTargetPreparationBaseV1ProtocolSchema, PluginError } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from './index.js';

const credentialRef = { service: { pluginId: 'happier.deploy.supabase', localId: 'supabase' }, accountId: 'connected' };
const input = { ...DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  targetLinkId: 'data-link', expectedTargetLinkRevision: 1, credentialRef,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: credentialRef.service.pluginId, localId: 'query-read' }, purpose: 'deploy-manage' }, target: { kind: 'account', account: credentialRef } },
  providerIdentity: { providerAccountId: 'org', providerResourceId: 'parent-ref', providerEnvironment: 'preview-ref' },
  providerEnvironment: { kind: 'custom', id: 'preview-ref' } }), database: 'postgres', sql: 'select $1::text as value', params: { '1': 'hello' } };

async function host(body: unknown = [{ value: 'hello', nullable: null }], status = 201, error?: Error, onRequest?: () => void, errorAtRequest = 1) {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    onRequest?.();
    if (error && requests.length === errorAtRequest) throw error;
    const query = JSON.parse(new TextDecoder().decode(request.body)).query;
    const response = query === 'SELECT current_database() AS database' ? [{ database: 'postgres' }] : body;
    return { status, body: new TextEncoder().encode(JSON.stringify(response)), headers: {} };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  return { kit, requests };
}

describe('Supabase qualified read-only SQL', () => {
  it('refuses a database the dedicated provider endpoint cannot select', async () => {
    const h = await host();
    try {
      expect(await h.kit.invokeAction('query-read', { ...input, database: 'other' }))
        .toMatchObject({ ok: false, error: 'unsupported_action', diagnostic: { code: 'database_unsupported' } });
      expect(h.requests).toHaveLength(1);
      expect(JSON.parse(new TextDecoder().decode(h.requests[0]?.body)).query).toBe('SELECT current_database() AS database');
    } finally { await h.kit.dispose(); }
  });
  it('rejects a query declaration that adds a second input beyond the canonical contract', async () => {
    const actions = entry.manifest.contributes.actions?.map(action => action.id === 'query-read'
      ? { ...action, inputSchema: { ...action.inputSchema, properties: { ...action.inputSchema?.properties, credentialOverride: { type: 'string' as const } } } }
      : action);
    const manifest = { ...entry.manifest, contributes: { ...entry.manifest.contributes, actions } };
    await expect(createPluginTestkit({ manifest, module: entry })).rejects.toBeInstanceOf(TypeError);
  });

  it('executes only at the provider read-only endpoint for the exact branch using the bound account', async () => {
    const h = await host();
    try {
      expect(h.requests).toHaveLength(0);
      expect(entry.manifest.contributes.actions?.find(action => action.id === 'query-read')?.surfaces).toContain('ui');
      const result = await h.kit.invokeAction('query-read', input, { surface: 'ui' });
      expect(result).toEqual({ ok: true, columns: [{ name: 'value' }, { name: 'nullable' }], rows: [['hello', null]], complete: false,
        diagnostic: { code: 'provider_completeness_unknown' } });
      expect(h.requests).toHaveLength(2);
      expect(h.requests[1]).toMatchObject({ url: 'https://api.supabase.com/v1/projects/preview-ref/database/query/read-only', method: 'POST',
        credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy-manage' } });
      expect(JSON.parse(new TextDecoder().decode(h.requests[1]?.body))).toEqual({ query: input.sql, parameters: ['hello'] });
      const target = entry.manifest.contributes.deploymentTargets?.[0];
      if (target?.role !== 'data') throw new Error('Missing Supabase data target');
      expect(target.dataV1?.query?.readOnly).toBe('query-read');
    } finally { await h.kit.dispose(); }
  });

  it('keeps empty results and JSON cells without inventing completeness', async () => {
    const h = await host([{ payload: { nested: true } }]);
    try {
      expect(await h.kit.invokeAction('query-read', input)).toMatchObject({ rows: [['{"nested":true}']], complete: false });
    } finally { await h.kit.dispose(); }
    const empty = await host([]);
    try {
      expect(await empty.kit.invokeAction('query-read', input)).toMatchObject({ columns: [], rows: [], complete: false });
    } finally { await empty.kit.dispose(); }
  });

  it('refuses invalid positional parameters before provider execution', async () => {
    const h = await host();
    try {
      await expect(h.kit.invokeAction('query-read', { ...input, params: { '2': 'gap' } }))
        .rejects.toMatchObject({ code: 'query_parameters_invalid' });
      expect(h.requests).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it.each([401, 403, 429, 500])('settles HTTP %s without replaying or exposing provider echoes', async status => {
    const h = await host({ message: 'private-password SQL text' }, status);
    try {
      await expect(h.kit.invokeAction('query-read', input)).rejects.toMatchObject({ code: `provider_http_${status}` });
      expect(h.requests).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('reports unavailable when database selection cannot fit the incumbent response boundary', async () => {
    const h = await host(undefined, 201, new PluginError({ code: 'plugin_fetch_response_too_large' }));
    try {
      expect(await h.kit.invokeAction('query-read', input)).toMatchObject({ ok: false,
        error: 'deployment_unavailable', diagnostic: { code: 'action_result_size_limit' } });
      expect(h.requests).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('reports incomplete when query results cannot fit the incumbent response boundary', async () => {
    const h = await host(undefined, 201, new PluginError({ code: 'plugin_fetch_response_too_large' }), undefined, 2);
    try {
      expect(await h.kit.invokeAction('query-read', input)).toEqual({ ok: true, columns: [], rows: [], complete: false,
        diagnostic: { code: 'action_result_size_limit' } });
      expect(h.requests).toHaveLength(2);
    } finally { await h.kit.dispose(); }
  });

  it('rejects malformed results rather than reporting empty success', async () => {
    const h = await host({ error: 'private echo' });
    try {
      await expect(h.kit.invokeAction('query-read', input)).rejects.toMatchObject({ code: 'provider_response_invalid' });
    } finally { await h.kit.dispose(); }
  });

  it('settles cancellation without mutation uncertainty or retry', async () => {
    const controller = new AbortController();
    const h = await host([], 201, undefined, () => controller.abort());
    try {
      await expect(h.kit.invokeAction('query-read', input, { signal: controller.signal })).rejects.toMatchObject({ code: 'plugin_action_aborted' });
      expect(h.requests).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });
});

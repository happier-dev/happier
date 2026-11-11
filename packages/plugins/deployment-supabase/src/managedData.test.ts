import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit, createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import { DeploymentTargetPreparationBaseV1ProtocolSchema, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountPortableRuntime, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginTestkitInvokeActionOptions } from '@happier-dev/plugin-sdk/testing';
import * as entry from './index.js';
import { dataActions } from './data/actions.js';

const credentialRef = { service: { pluginId: 'happier.deploy.supabase', localId: 'supabase' }, accountId: 'connected' };
function preparation(actionId: string) { return DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  credentialRef, credentialPrincipal: { kind: 'account', accountId: 'owner',
    purpose: { consumer: { pluginId: credentialRef.service.pluginId, localId: actionId }, purpose: 'deploy-manage' }, target: { kind: 'account', account: credentialRef } },
  providerAccountId: 'org-example', providerEnvironment: { kind: 'custom', id: 'parent-ref' } }); }
const base = preparation('projects-link');
const linked = DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ ...base, targetLinkId: 'data-link', expectedTargetLinkRevision: 1,
  providerIdentity: { providerAccountId: 'org-example', providerResourceId: 'parent-ref', providerEnvironment: 'parent-ref' } });
const project = { ref: 'parent-ref', id: 'deprecated-id', organization_slug: 'org-example', name: 'Example', region: 'eu-central-1', status: 'ACTIVE_HEALTHY', database: { host: 'db.parent-ref.supabase.co', version: '17.4' } };
const pair = { password: { ref: 'saved:password', resourceRevision: 1 },
  id: 'database', purpose: 'data.connection',
  secrets: { DATABASE_URL: { label: 'Application database' }, DIRECT_URL: { label: 'Migration database' } },
  audience: { accountGrants: ['owner'] } };
// Official Management API OpenAPI v1/1.0.0 vectors characterized 2026-10-30:
// https://api.supabase.com/api/v1-json. Responses deliberately include secret
// echoes to prove that provider payloads never become ordinary Action output.
async function host(respond: (request: HttpRequest) => unknown | Promise<unknown>, failSave?: string,
  responseStatus?: number | ((request: HttpRequest) => number), readError?: unknown) {
  const requests: HttpRequest[] = [];
  const saved: { id: string; value: string; audience: unknown }[] = [];
  const secrets: SecretsService = {
    async saveShared(id, input) {
      if (input.label === failSave) throw new PluginError({ code: 'secret_save_client_required', message: 'constructed storage failure private-password' });
      saved.push({ id, value: new TextDecoder().decode(input.bytes), audience: input.audience });
      return { ref: `saved:${input.label}`, resourceRevision: 1 };
    },
    async readSavedSecret() { if (readError) throw readError; return 'private:p@ss/word'; },
    async get() { throw new Error('Unexpected direct secret read'); },
    async set() { throw new Error('Unexpected direct secret write'); },
    async delete() { throw new Error('Unexpected secret deletion'); },
    async status() { return { state: 'missing', revision: '0' }; },
  };
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: (typeof responseStatus === 'function' ? responseStatus(request) : responseStatus) ?? (request.method === 'POST' ? 201 : 200), body: new TextEncoder().encode(JSON.stringify(await respond(request))), headers: {} };
  } });
  let accountRuntime: ConnectedAccountPortableRuntime | undefined;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry,
    activateAccount(api, account) {
      return entry.activateAccount({ ...api, connectedAccounts: { register(localId, runtime) {
        if (localId === 'supabase') accountRuntime = runtime;
        return api.connectedAccounts.register(localId, runtime);
      } } }, account);
    },
  }, services: { http, secrets } });
  return { kit, requests, saved, http, accountRuntime };
}

describe('activated Supabase managed data target', () => {
  it('admits selected preparation fields while refusing unknown fields and incomplete link custody', async () => {
    const h = await host(() => []);
    try {
      expect(await h.kit.invokeAction('branches-list', linked)).toMatchObject({ branches: [] });
      const requests = h.requests.length;
      await expect(h.kit.invokeAction('branches-list', { ...linked, unexpected: true }))
        .rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
      const { providerIdentity: _identity, ...incomplete } = linked;
      await expect(h.kit.invokeAction('branches-list', incomplete))
        .rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
      expect(h.requests).toHaveLength(requests);
    } finally { await h.kit.dispose(); }
  });

  it('offers only observed region objects as creation choices through the options Action', async () => {
    const h = await host(request => request.url.includes('available-regions')
      ? { recommendations: [], all: [{ name: 'Europe', code: 'eu-central-1', type: 'specific', provider: 'AWS' }] }
      : { entitlements: [] });
    try {
      const resource = h.kit.registration('resources', 'input-options');
      expect(resource).toBeDefined();
      if (!resource) throw new Error('Missing input options');
      const context = createTestResourceInvocationContext({ context: { kind: 'global' },
        async readAction(ref, input, cancellation) { expect(input).toMatchObject({ credentialPrincipal: {
          purpose: { consumer: ref } } }); return { ok: true, result: await h.kit.invokeAction(ref.localId, input,
          { signal: cancellation?.signal, surface: 'plugin' }) }; } });
      expect(h.requests).toHaveLength(0);
      const bytes = await resource.read({ ...context, query: { draftInput: preparation('projects-provision'), fieldPath: 'regionSelection' } });
      expect(JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)))
        .toEqual({ options: [{ value: { type: 'specific', code: 'eu-central-1' }, label: 'Europe' }] });
      expect(h.requests.every(request => request.method === 'GET')).toBe(true);
    } finally { await h.kit.dispose(); }
  });
  it('contributes data-only roles with no activation-time provider work or guessed query API', async () => {
    const h = await host(() => ({}));
    try {
      for (const id of Object.keys(dataActions)) expect(entry.manifest.contributes.actions?.find(action => action.id === id)?.surfaces).toContain('ui');
      expect(entry.manifest.contributes.deploymentTargets).toEqual([expect.objectContaining({ role: 'data', targetKind: 'supabase',
        dataV1: expect.objectContaining({ projects: expect.objectContaining({ provision: 'projects-provision', link: 'projects-link' }),
          branches: expect.objectContaining({ create: 'branches-create', delete: 'branches-delete' }), connectionSecret: { save: 'connections-save' } }) })]);
      const target = entry.manifest.contributes.deploymentTargets?.[0];
      if (target?.role !== 'data') throw new Error('Missing Supabase data target');
      expect(target.dataV1?.query).toEqual({ readOnly: 'query-read' });
      expect(h.requests).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it('observes the exact native project ref and exposes safe data facts', async () => {
    const h = await host(() => ({ ...project, db_pass: 'private-password' }));
    try {
      const result = await h.kit.invokeAction('projects-link', { ...base, projectRef: 'parent-ref' }, { surface: 'ui' });
      expect(result).toMatchObject({ state: 'provisioned', providerIdentity: { providerAccountId: 'org-example', providerResourceId: 'parent-ref', providerEnvironment: 'parent-ref' }, engine: 'postgres', providerConsole: { url: 'https://supabase.com/dashboard/project/parent-ref' } });
      expect(JSON.stringify(result)).not.toMatch(/private-password|deprecated-id/u);
      expect(h.requests[0]?.credentialBinding).toMatchObject({ kind: 'connectedAccountPurpose', purpose: 'deploy-manage' });
    } finally { await h.kit.dispose(); }
  });

  it('uses both provider-proven pooler endpoints and saves only opaque refs', async () => {
    const poolers = [{ db_host: 'aws-1-eu.pooler.supabase.com', db_port: 6543, db_user: 'postgres.parent-ref', db_name: 'postgres', pool_mode: 'transaction' },
      { db_host: 'aws-2-eu.pooler.supabase.com', db_port: 5432, db_user: 'postgres.parent-ref', db_name: 'postgres', pool_mode: 'session' }];
    const h = await host(() => poolers);
    try {
      const result = await h.kit.invokeAction('connections-save', { ...linked, ...pair });
      expect(result).toMatchObject({ status: 'complete', connections: { DATABASE_URL: { ref: 'saved:Application database', resourceRevision: 1 }, DIRECT_URL: { ref: 'saved:Migration database', resourceRevision: 1 } } });
      expect(h.saved.map(item => new URL(item.value).hostname)).toEqual(['aws-1-eu.pooler.supabase.com', 'aws-2-eu.pooler.supabase.com']);
      expect(h.saved.map(item => decodeURIComponent(new URL(item.value).password))).toEqual(['private:p@ss/word', 'private:p@ss/word']);
      expect(h.saved.every(item => JSON.stringify(item.audience) === JSON.stringify(pair.audience))).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/postgresql:|private|pooler\.supabase/u);
    } finally { await h.kit.dispose(); }
  });

  it('creates projects with current region_selection and password custody', async () => {
    const h = await host(request => request.method === 'POST' ? { ...project, status: 'COMING_UP' }
      : request.url.includes('available-regions') ? { recommendations: [], all: [{ name: 'Europe', code: 'eu-central-1', type: 'specific', provider: 'AWS' }] }
        : request.url.includes('entitlements') ? { entitlements: [] } : [{ id: 'org-id', slug: 'org-example', name: 'Example' }]);
    try {
      const result = await h.kit.invokeAction('projects-provision', { ...preparation('projects-provision'), providerEnvironment: { kind: 'production' }, name: 'Example', password: pair.password, regionSelection: { type: 'specific', code: 'eu-central-1' } });
      expect(result).toMatchObject({ state: 'provisioned', ready: false, providerIdentity: { providerResourceId: 'parent-ref' } });
      const request = h.requests.find(item => item.method === 'POST');
      expect(JSON.parse(new TextDecoder().decode(request?.body))).toEqual({ organization_slug: 'org-example', name: 'Example', db_pass: 'private:p@ss/word', region_selection: { type: 'specific', code: 'eu-central-1' } });
      expect(JSON.stringify(result)).not.toMatch(/private|db_pass/u);
    } finally { await h.kit.dispose(); }
  });

  it('retains a partial pair and retries only the missing name for the same exact resource', async () => {
    const poolers = [{ db_host: 'pool.example', db_port: 6543, db_user: 'postgres.parent-ref', db_name: 'postgres', pool_mode: 'transaction' },
      { db_host: 'session.example', db_port: 5432, db_user: 'postgres.parent-ref', db_name: 'postgres', pool_mode: 'session' }];
    const first = await host(() => poolers, 'Migration database');
    let previous: JsonValue = null;
    try {
      previous = await first.kit.invokeAction('connections-save', { ...linked, ...pair });
      expect(previous).toMatchObject({ status: 'partial', code: 'secret_save_client_required', connections: { DATABASE_URL: { ref: 'saved:Application database' } }, incomplete: ['DIRECT_URL'] });
      expect(JSON.stringify(previous)).not.toContain('private');
    } finally { await first.kit.dispose(); }
    const h = await host(() => poolers);
    try {
      const result = await h.kit.invokeAction('connections-save', { ...linked, ...pair, previous });
      expect(result).toMatchObject({ status: 'complete' });
      expect(h.saved.map(item => item.value.includes('session.example'))).toEqual([true]);
      await expect(h.kit.invokeAction('connections-save', { ...linked, providerEnvironment: { kind: 'custom', id: 'foreign' }, ...pair, previous })).rejects.toMatchObject({ code: 'deployment_conflict' });
    } finally { await h.kit.dispose(); }
  });

  it('does not fabricate missing connection modes or reset an unavailable branch password', async () => {
    const h = await host(() => []);
    try {
      expect(await h.kit.invokeAction('connections-save', { ...linked, ...pair }))
        .toMatchObject({ status: 'unavailable', code: 'connection_modes_unavailable' });
      expect(h.saved).toHaveLength(0);
      expect(h.requests.every(request => request.method === 'GET')).toBe(true);
    } finally { await h.kit.dispose(); }
  });

  it.each([{ db_host: 'bad host', db_port: 6543 }, { db_host: 'pool.example', db_port: -1 }])('refuses malformed provider endpoint $db_host:$db_port before storing a fabricated connection', async endpoint => {
    const h = await host(() => [{ ...endpoint, db_user: 'postgres.parent-ref', db_name: 'postgres', pool_mode: 'transaction' },
      { db_host: 'session.example', db_port: 5432, db_user: 'postgres.parent-ref', db_name: 'postgres', pool_mode: 'session' }]);
    try {
      await expect(h.kit.invokeAction('connections-save', { ...linked, ...pair })).rejects.toMatchObject({ code: 'provider_response_invalid' });
      expect(h.saved).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it('does not replay a lost branch create or adopt a same-named foreign branch', async () => {
    const h = await host(request => {
      if (request.method === 'POST') throw new Error('lost response private-password');
      return [{ id: 'foreign-id', project_ref: 'foreign-ref', parent_project_ref: 'parent-ref', name: 'Preview', persistent: false }];
    });
    try {
      const result = await h.kit.invokeAction('branches-create', { ...linked, name: 'Preview', gitBranch: 'feature', withData: false });
      expect(result).toMatchObject({ status: 'outcome_unknown', parentProjectRef: 'parent-ref' });
      expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('private-password');
    } finally { await h.kit.dispose(); }
  });

  it('keeps a typed post-send HTTP body failure unknown and retains its canonical code', async () => {
    const h = await host(() => { throw new PluginError({ code: 'plugin_fetch_response_too_large', message: 'private-password' }); });
    try {
      const result = await h.kit.invokeAction('branches-create', { ...linked, name: 'Preview', withData: false });
      expect(result).toMatchObject({ status: 'outcome_unknown', parentProjectRef: 'parent-ref', code: 'plugin_fetch_response_too_large' });
      expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('private-password');
    } finally { await h.kit.dispose(); }
  });

  it('preserves a typed read failure envelope from the provider HTTP owner', async () => {
    const h = await host(() => { throw new PluginError({ code: 'provider_account_paused', message: 'private-message',
      details: { requestId: 'req-1' }, remediation: { kind: 'retry' } }); });
    try {
      await expect(h.kit.invokeAction('projects-list', preparation('projects-list'))).rejects.toMatchObject({
        code: 'provider_account_paused', message: 'private-message', details: { requestId: 'req-1' }, remediation: { kind: 'retry' },
      });
    } finally { await h.kit.dispose(); }
  });

  it('preserves a typed pre-send refusal envelope for a write', async () => {
    const error = new PluginError({ code: 'credential_unavailable', message: 'Reconnect the provider',
      retryable: true, details: { requestId: 'req-write' }, remediation: { kind: 'retry' } });
    const h = await host(() => { throw error; });
    try {
      await expect(h.kit.invokeAction('branches-create', { ...linked, name: 'Preview', withData: false }))
        .rejects.toMatchObject({ code: error.code, message: error.message, retryable: true,
          details: error.details, remediation: error.remediation });
    } finally { await h.kit.dispose(); }
  });

  it('preserves a typed saved-secret read failure envelope', async () => {
    const h = await host(request => request.url.includes('available-regions')
      ? { recommendations: [], all: [{ name: 'Europe', code: 'eu-central-1', type: 'specific', provider: 'AWS' }] }
      : { entitlements: [] }, undefined, undefined,
    new PluginError({ code: 'secret_scope_revoked', message: 'private-message', details: { requestId: 'req-2' }, remediation: { kind: 'retry' } }));
    try {
      await expect(h.kit.invokeAction('projects-provision', { ...preparation('projects-provision'), name: 'Example',
        password: pair.password, regionSelection: { type: 'specific', code: 'eu-central-1' } })).rejects.toMatchObject({
        code: 'secret_scope_revoked', message: 'private-message', details: { requestId: 'req-2' }, remediation: { kind: 'retry' },
      });
    } finally { await h.kit.dispose(); }
  });

  it.each(['projects-provision', 'branches-create'] as const)('retains an exact native ref after malformed successful %s metadata without replay', async operation => {
    const h = await host(request => request.method === 'POST'
      ? operation === 'projects-provision'
        ? { ...project, ref: 'created-ref', name: null, db_pass: 'private-password' }
        : { id: 'branch-id', project_ref: 'created-ref', parent_project_ref: 'parent-ref', name: null, persistent: false, db_pass: 'private-password' }
      : request.url.includes('available-regions')
        ? { recommendations: [], all: [{ name: 'Europe', code: 'eu-central-1', type: 'specific', provider: 'AWS' }] }
        : { entitlements: [] });
    try {
      const result = await h.kit.invokeAction(operation, operation === 'projects-provision'
        ? { ...preparation(operation), name: 'Example', password: pair.password, regionSelection: { type: 'specific', code: 'eu-central-1' } }
        : { ...linked, name: 'Preview', withData: false });
      expect(result).toMatchObject({ status: 'outcome_unknown', projectRef: 'created-ref', code: 'provider_response_invalid' });
      expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('private-password');
    } finally { await h.kit.dispose(); }
  });

  it('creates an empty nonpersistent branch and deletes only its exact native project ref', async () => {
    const metadata = { id: 'branch-uuid', name: 'Preview', project_ref: 'preview-ref', parent_project_ref: 'parent-ref', persistent: false, with_data: false, preview_project_status: 'ACTIVE_HEALTHY' };
    const h = await host(request => request.method === 'POST' ? metadata : request.method === 'DELETE' ? { message: 'ok' } : [metadata]);
    try {
      expect(await h.kit.invokeAction('branches-create', { ...linked, name: 'Preview', gitBranch: 'feature', withData: false }))
        .toMatchObject({ status: 'provisioned', projectRef: 'preview-ref', branchId: 'branch-uuid', providerEnvironment: { kind: 'custom', id: 'preview-ref' } });
      const input = { ...linked, providerEnvironment: { kind: 'custom', id: 'preview-ref' }, providerIdentity: { ...linked.providerIdentity, providerEnvironment: 'preview-ref' } };
      expect(await h.kit.invokeAction('branches-delete', input)).toMatchObject({ status: 'deleted', branchProjectRef: 'preview-ref' });
      expect(h.requests.find(request => request.method === 'DELETE')?.url).toBe('https://api.supabase.com/v1/branches/preview-ref');
      expect(JSON.parse(new TextDecoder().decode(h.requests.find(request => request.method === 'POST')?.body))).toMatchObject({ persistent: false, with_data: false });
    } finally { await h.kit.dispose(); }
  });

  it('creates from the saved parent project ref independently of root link and branch UUID', async () => {
    const parentBranchRef = { providerProjectId: 'saved-parent-project', branchId: 'saved-parent-uuid' };
    const h = await host(() => ({ id: 'created-uuid', name: 'Preview', project_ref: 'created-ref',
      parent_project_ref: parentBranchRef.providerProjectId, persistent: false, preview_project_status: 'ACTIVE_HEALTHY' }));
    try {
      const result = await h.kit.invokeAction('branches-create', { ...linked,
        providerEnvironment: { kind: 'custom', id: 'current-parent-project' },
        providerIdentity: { ...linked.providerIdentity, providerResourceId: 'root-project', providerEnvironment: 'current-parent-project' },
        name: 'Preview', withData: false, parentBranchRef });
      expect(result).toMatchObject({ status: 'provisioned', projectRef: 'created-ref', parentProjectRef: 'saved-parent-project',
        providerIdentity: { providerResourceId: 'saved-parent-project', providerEnvironment: 'created-ref' } });
      expect(h.requests[0]?.url).toBe('https://api.supabase.com/v1/projects/saved-parent-project/branches');
      expect(JSON.parse(new TextDecoder().decode(h.requests[0]?.body))).toEqual({ branch_name: 'Preview', persistent: false, with_data: false });
    } finally { await h.kit.dispose(); }
  });

  it('refuses a persistent/default resource and never substitutes project deletion', async () => {
    const h = await host(() => [{ id: 'branch-id', name: 'Production', project_ref: 'persistent-ref', parent_project_ref: 'parent-ref', persistent: true }]);
    try {
      await expect(h.kit.invokeAction('branches-delete', { ...linked, providerEnvironment: { kind: 'custom', id: 'persistent-ref' } })).rejects.toMatchObject({ code: 'deployment_conflict' });
      await expect(h.kit.invokeAction('branches-delete', linked)).rejects.toMatchObject({ code: 'deployment_conflict' });
      expect(h.requests.every(request => request.method === 'GET')).toBe(true);
    } finally { await h.kit.dispose(); }
  });

  it('re-observes the same exact branch after a lost delete without replaying the effect', async () => {
    let removed = false;
    const h = await host(request => {
      if (request.method === 'DELETE') { removed = true; throw new Error('response lost'); }
      return removed ? [] : [{ id: 'branch-id', name: 'Preview', project_ref: 'preview-ref', parent_project_ref: 'parent-ref', persistent: false }];
    });
    try {
      expect(await h.kit.invokeAction('branches-delete', { ...linked, providerEnvironment: { kind: 'custom', id: 'preview-ref' } }))
        .toMatchObject({ status: 'deleted', branchProjectRef: 'preview-ref' });
      expect(h.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
      expect(h.requests.filter(request => request.method === 'GET').map(request => request.url)).toEqual([
        'https://api.supabase.com/v1/projects/parent-ref/branches', 'https://api.supabase.com/v1/projects/parent-ref/branches' ]);
    } finally { await h.kit.dispose(); }
  });

  it('keeps a lost delete unknown when re-observation is denied', async () => {
    let deleteSent = false;
    const h = await host(request => {
      if (request.method === 'DELETE') { deleteSent = true; throw new Error('response lost'); }
      return deleteSent ? { message: 'private-password' } : [{ id: 'branch-id', name: 'Preview', project_ref: 'preview-ref', parent_project_ref: 'parent-ref', persistent: false }];
    }, undefined, () => deleteSent ? 403 : 200);
    try {
      expect(await h.kit.invokeAction('branches-delete', { ...linked, providerEnvironment: { kind: 'custom', id: 'preview-ref' } }))
        .toMatchObject({ status: 'outcome_unknown', branchProjectRef: 'preview-ref', code: 'deployment_access_denied' });
      expect(h.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('reports the missing branch password prerequisite without resetting credentials', async () => {
    const h = await host(request => request.url.includes('/config/database/pooler')
      ? [{ db_host: 'pool.example', db_port: 6543, db_user: 'postgres.preview-ref', db_name: 'postgres', pool_mode: 'transaction' },
        { db_host: 'session.example', db_port: 5432, db_user: 'postgres.preview-ref', db_name: 'postgres', pool_mode: 'session' }]
      : { ref: 'preview-ref', status: 'ACTIVE_HEALTHY', db_host: 'db.preview-ref.supabase.co', db_port: 5432 });
    try {
      const { password: _password, ...saveOperands } = pair;
      expect(await h.kit.invokeAction('connections-save', { ...linked, providerEnvironment: { kind: 'custom', id: 'preview-ref' }, ...saveOperands }))
        .toMatchObject({ status: 'unavailable', code: 'database_password_required', resource: { projectRef: 'parent-ref', branchRef: 'preview-ref' } });
      expect(h.requests.every(request => request.method === 'GET')).toBe(true);
      expect(h.saved).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it('settles read permission denial without retrying or leaking vendor error bodies', async () => {
    const h = await host(() => ({ message: 'private-password' }), undefined, 403);
    try {
      await expect(h.kit.invokeAction('projects-list', preparation('projects-list'))).rejects.toMatchObject({ code: 'deployment_access_denied', message: 'deployment_access_denied' });
      expect(h.requests).toHaveLength(1);
    } finally { await h.kit.dispose(); }
  });

  it('refuses an already cancelled Action before any provider request', async () => {
    const h = await host(() => []);
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(h.kit.invokeAction('projects-list', preparation('projects-list'), { signal: controller.signal })).rejects.toMatchObject({ code: 'plugin_action_aborted' });
      expect(h.requests).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it.each(['daemon', 'account'] as const)('connects and materializes only the configured organization through %s activation', async target => {
    let response: unknown = [{ id: 'org-id', slug: 'org-example', name: 'Example' }];
    const h = await host(() => response);
    const staged = new Map<string, string>();
    const runtime = target === 'account' ? h.accountRuntime : h.kit.registration('connectedAccountDescriptors', 'supabase');
    const mode = runtime?.authentication.modes.token;
    try {
      expect(mode?.kind).toBe('manual');
      if (mode?.kind !== 'manual') throw new Error('Missing manual Connected Account mode');
      const signal = new AbortController().signal;
      const service = credentialRef.service;
      // Only the external HTTP and credential-persistence boundaries are
      // substituted; unexpected host services are unavailable in this fixture.
      const services = new Proxy({ http: h.http } as ConnectedAccountReadContext['services'], {
        get(target, key) { if (key === 'http') return target.http; throw new Error('Unadmitted service'); },
      });
      const context = {
        plugin: { id: entry.manifest.id, version: entry.manifest.version },
        contribution: { id: service.localId, qualifiedId: `${entry.manifest.id}/${service.localId}` },
        surface: 'ui', invokedAtMs: 1, service, signal, services,
        attempt: { kind: 'connect', attemptId: 'supabase-connect' },
        configuration: { target: { kind: 'attempt', service, modeId: 'token', attemptId: 'supabase-connect' },
          revision: 'config-1', values: { organizationSlug: 'org-example' }, async getSecret() { return null; } },
        attemptCredentials: {
          async get(key) { return staged.get(key) ?? null; },
          async set(key, value) { staged.set(key, value); },
          async delete(key) { staged.delete(key); },
        },
      } satisfies ConnectedAccountAuthenticationContext;
      expect(await mode.complete({ fields: { token: 'private-token' } }, context)).toMatchObject({ status: 'connected', providerIdentity: { organizationId: 'org-example' }, scopes: [] });
      expect(staged.get('token')).toBe('private-token');
      expect(h.requests.map(request => request.url)).toEqual(['https://api.supabase.com/v1/organizations']);
      const account = { service, accountId: 'connected-supabase' };
      const read = { plugin: context.plugin, contribution: context.contribution, surface: context.surface,
        invokedAtMs: context.invokedAtMs, signal, services, account, credentials: context.attemptCredentials,
        configuration: { ...context.configuration, target: { kind: 'account', account, modeId: 'token' } },
      } satisfies ConnectedAccountReadContext;
      if (!runtime?.materialize) throw new Error('Missing Supabase materialization runtime');
      expect(await runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.supabase.com', headerNames: ['authorization'] }, read))
        .toEqual({ kind: 'httpHeaders', headers: { authorization: 'Bearer private-token' } });
      await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://foreign.example', headerNames: ['authorization'] }, read))
        .rejects.toMatchObject({ code: 'credential_unavailable' });
      staged.clear();
      expect(await mode.complete({ fields: { token: 'private-token' } }, { ...context, configuration: { ...context.configuration, values: { organizationSlug: 'foreign' } } }))
        .toMatchObject({ status: 'rejected', diagnostic: { code: 'supabase_scope_mismatch' } });
      expect(staged.size).toBe(0);
      response = project;
      const projectContext = { ...context, configuration: { ...context.configuration, values: { organizationSlug: 'org-example', projectRef: 'parent-ref' } } };
      expect(await mode.complete({ fields: { token: 'private-token' } }, projectContext)).toMatchObject({ status: 'connected', providerIdentity: { organizationId: 'org-example' }, scopes: [] });
      staged.clear();
      response = { ...project, ref: 'foreign' };
      expect(await mode.complete({ fields: { token: 'private-token' } }, projectContext)).toMatchObject({ status: 'rejected', diagnostic: { code: 'supabase_scope_mismatch' } });
      response = { ...project, organization_slug: 'foreign' };
      expect(await mode.complete({ fields: { token: 'private-token' } }, projectContext)).toMatchObject({ status: 'rejected', diagnostic: { code: 'supabase_scope_mismatch' } });
      expect(staged.size).toBe(0);
      expect(h.requests.slice(-3).every(request => request.url === 'https://api.supabase.com/v1/projects/parent-ref')).toBe(true);
    } finally { await h.kit.dispose(); }
  });
});

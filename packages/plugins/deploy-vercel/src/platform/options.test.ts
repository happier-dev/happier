import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit, createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { validateInputFieldValue } from '@happier-dev/protocol/inputs/runtime';
import * as entry from '../index.js';
import { activateAccount } from '../account.js';
import { targetInputHints } from './options.js';

const credentialRef = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'selected-pat' };
const credentialPrincipal = { kind: 'account', accountId: 'owner', purpose: {
  consumer: { pluginId: 'happier.deploy.vercel', localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
target: { kind: 'account', account: credentialRef } };
const draftInput = { credentialRef, credentialPrincipal };

async function host(response: (request: HttpRequest) => unknown, portable = false, status = 200) {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(response(request))) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest,
    module: portable ? { ...entry, activateAccount } : entry, services: { http,
      connectedAccounts: { async getBinding(purpose) {
        expect(purpose).toBe('deploy.manage');
        return { purpose, service: credentialRef.service, account: credentialRef,
          target: { kind: 'account', displayName: 'Selected connection' } };
      }, async materialize(purpose, request) {
        expect(purpose).toBe('deploy.manage');
        expect(request).toEqual({ kind: 'environment', keys: ['VERCEL_TEAM_ID'] });
        return { kind: 'environment', env: { VERCEL_TEAM_ID: 'team_exact' } };
      } },
    } });
  const resource = kit.registration('resources', 'target-options');
  const invoke = kit.invokeAction.bind(kit);
  async function read(fieldPath: string, draft: JsonValue = draftInput, query?: string, cursor?: string, signal = new AbortController().signal) {
    expect(resource, 'registered headless target-options Resource').toBeDefined();
    if (!resource) throw new Error('Missing target-options Resource');
    const options = createTestResourceInvocationContext({ signal, context: { kind: 'global' },
      async readAction(ref, input, cancellation) {
        expect(ref).toEqual({ pluginId: entry.manifest.id, localId: 'target-options-read' });
        return { ok: true, result: await invoke(ref.localId, input, { signal: cancellation?.signal, surface: 'plugin' }) };
      } });
    const bytes = await resource.read({ ...options, query: { draftInput: draft, fieldPath, query, cursor } });
    return JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes));
  }
  return { kit, requests, resource, read };
}

it.each(['complete-identity', 'native'] as const)('admits cli58 %s Inspect through dynamic environment options', async form => {
  // Exact non-secret CLI input from QA-VERCEL-1102/cli58, including its complete comparison identity.
  const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' },
    accountId: 'e200efeb-bcd4-417b-bad1-9c600b4fb89f' };
  const providerIdentity = { providerAccountId: 'team_IfWoDydKwqFwMDLSXA80FDAW',
    providerResourceId: 'prj_Uyy9CT3gK5T1FkB9QCZZu5ZXoxUj', providerEnvironment: 'production' };
  const input = { v: 1, serverId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN',
    environmentId: 'cmw1qghf3006emckxskkl6688', expectedRevision: 1,
    credentialRef: account, credentialPrincipal: { kind: 'account', accountId: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e',
      purpose: { consumer: { pluginId: 'happier.deploy.vercel', localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
      target: { kind: 'account', account } },
    ...(form === 'complete-identity' ? { providerIdentity }
      : { providerAccountId: providerIdentity.providerAccountId, projectId: providerIdentity.providerResourceId }),
    providerEnvironment: { kind: 'production' },
    repository: { kind: 'github', deployment: 'https://github.com', repository: 'happier-dev/triage-qa-sandbox' } };
  const h = await host(request => {
    const url = new URL(request.url);
    expect(url.searchParams.get('teamId')).toBe(providerIdentity.providerAccountId);
    if (url.pathname.endsWith('/custom-environments')) return { environments: [] };
    if (url.pathname === `/v9/projects/${providerIdentity.providerResourceId}`) return {
      id: providerIdentity.providerResourceId, accountId: providerIdentity.providerAccountId, name: 'happier-qa-deploy',
      link: { type: 'github', org: 'happier-dev', repo: 'triage-qa-sandbox', repoId: 1424792902 } };
    return { repos: [{ id: 1424792902, provider: 'github', namespace: 'happier-dev', slug: 'triage-qa-sandbox' }] };
  }, true);
  try {
    const definition = entry.manifest.contributes?.inputTypes?.find(type => type.id === 'provider-environment');
    const field = targetInputHints.fields.find(field => field.path === 'providerEnvironment');
    if (!definition || !field) throw new Error('Missing declared environment InputType');
    const page = await h.read(field.path, input);
    // CLI admission validates choices before invoking the Action; a handler-only test misses this refusal.
    expect(validateInputFieldValue({ field, value: input.providerEnvironment, options: page.options,
      type: { identity: { pluginId: entry.manifest.id, localId: definition.id }, occurrenceId: 'cli58', definition } }))
      .toEqual({ status: 'valid', value: input.providerEnvironment });
    expect(await h.kit.invokeAction('targets-inspect-v1', input)).toMatchObject({ providerIdentity,
      repositoryAccess: { status: 'ready', repository: input.repository },
      preparedNative: { projectName: 'happier-qa-deploy', gitSource: { type: 'github', repoId: '1424792902' } } });
  } finally { await h.kit.dispose(); }
});

it.each([{ portable: false, status: 200 }, { portable: true, status: 403 }])
('offers only the selected Connected Account scope without user/team metadata access ($portable, $status)', async ({ portable, status }) => {
  // A team-scoped PAT can read /user, but unscoped /projects returns its team's projects.
  // Offering that unrelated personal identity makes the next project page fail ownership validation.
  const h = await host(request => {
    const path = new URL(request.url).pathname;
    if (path === '/v2/user') return { user: { id: 'user_personal', username: 'alice', email: 'secret@example.com' } };
    const team = { id: 'team_exact', name: 'Example', slug: 'example', secret: 'provider-secret' };
    return { teams: [team, { id: 'team_unselected', name: 'Unselected' }], pagination: { next: 123, count: 2 } };
  }, portable, status);
  try {
    expect(h.requests).toHaveLength(0);
    const page = await h.read('providerAccountId');
    expect(page).toEqual({ options: [{ value: 'team_exact', label: 'Selected connection' }] });
    expect(h.requests).toHaveLength(0);
    expect(JSON.stringify(page)).not.toMatch(/secret|selected-pat/);
    expect(await h.read('providerAccountId', draftInput, 'selected'))
      .toEqual({ options: [{ value: 'team_exact', label: 'Selected connection' }] });
    expect(await h.read('providerAccountId', draftInput, 'unselected')).toEqual({ options: [] });
    expect(h.requests).toHaveLength(0);
    const observation = await h.resource?.observe(() => { throw new Error('No provider push for snapshot options'); }, createTestResourceInvocationContext());
    await observation?.dispose();
    expect(h.requests).toHaveLength(0);
  } finally { await h.kit.dispose(); }
});

it('reads only the selected account project page with provider search and continuation', async () => {
  const h = await host(() => ({ projects: [{ id: 'prj_exact', name: 'app', accountId: 'team_exact', env: [{ value: 'provider-secret' }] }],
    pagination: { next: 456, count: 1 } }));
  try {
    expect(await h.read('projectId', { ...draftInput, providerAccountId: 'team_exact' }, 'app', 'until:123'))
      .toEqual({ options: [{ value: 'prj_exact', label: 'app' }], nextCursor: 'until:456' });
    expect(h.requests).toHaveLength(1);
    const url = new URL(h.requests[0].url);
    expect(url.pathname).toBe('/v10/projects');
    expect(Object.fromEntries(url.searchParams)).toEqual({ teamId: 'team_exact', search: 'app', until: '123' });
    expect(await h.read('projectId')).toEqual({ options: [] });
    expect(h.requests).toHaveLength(1);
  } finally { await h.kit.dispose(); }
});

it('uses the provider continuation-token arm and omits teamId for a personal account', async () => {
  const h = await host(() => ({ projects: [{ id: 'prj_personal', name: 'personal', accountId: 'user_personal' }],
    pagination: { next: 'JBSWY3DPEHPK3PXP', count: 1 } }));
  try {
    expect(await h.read('projectId', { ...draftInput, providerAccountId: 'user_personal' }, undefined, 'from:PREVIOUS'))
      .toEqual({ options: [{ value: 'prj_personal', label: 'personal' }], nextCursor: 'from:JBSWY3DPEHPK3PXP' });
    expect(Object.fromEntries(new URL(h.requests[0].url).searchParams)).toEqual({ from: 'PREVIOUS' });
  } finally { await h.kit.dispose(); }
});

it('returns builtin and custom environment values for the exact selected project, with finite search', async () => {
  const h = await host(() => ({ environments: [{ id: 'env_staging', slug: 'staging', type: 'preview', createdAt: 1, updatedAt: 1 }], accountLimit: { total: 1 } }));
  try {
    const draft = { ...draftInput, providerAccountId: 'team_exact', projectId: 'prj_exact' };
    expect(await h.read('providerEnvironment', draft)).toEqual({ options: [
      { value: { kind: 'production' }, label: 'Production' }, { value: { kind: 'preview' }, label: 'Preview' },
      { value: { kind: 'custom', id: 'env_staging' }, label: 'staging' },
    ] });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].url).toBe('https://api.vercel.com/v9/projects/prj_exact/custom-environments?teamId=team_exact');
    expect(await h.read('providerEnvironment', draft, 'stag')).toEqual({ options: [{ value: { kind: 'custom', id: 'env_staging' }, label: 'staging' }] });
    expect(h.requests).toHaveLength(2);
  } finally { await h.kit.dispose(); }
});

it('retains an explicitly selected branch Preview without a repository or branch inventory scan', async () => {
  const h = await host(() => ({ environments: [], accountLimit: { total: 0 } }));
  try {
    expect(await h.read('providerEnvironment', { ...draftInput,
      providerAccountId: 'team_exact', projectId: 'prj_exact',
      providerEnvironment: { kind: 'preview', gitBranch: 'feature/preview' } }))
      .toEqual({ options: [{ value: { kind: 'production' }, label: 'Production' }, { value: { kind: 'preview' }, label: 'Preview' },
        { value: { kind: 'preview', gitBranch: 'feature/preview' }, label: 'Preview: feature/preview' }] });
    expect(h.requests).toHaveLength(1);
  } finally { await h.kit.dispose(); }
});

it('cancels an in-flight page before any returned provider data or next-page read', async () => {
  const abort = new AbortController();
  const h = await host(() => { abort.abort(); return { projects: [], pagination: { next: 123 } }; });
  try {
    await expect(h.read('projectId', { ...draftInput,
      providerAccountId: 'team_exact' }, undefined, undefined, abort.signal)).rejects.toBeDefined();
    expect(h.requests).toHaveLength(1);
  } finally { await h.kit.dispose(); }
});

it.each([
  { name: 'missing project name', project: { id: 'prj_missing_name' } },
  { name: 'different project owner', project: { id: 'prj_other', name: 'Other project', accountId: 'team_other' } },
])('rejects $name and preserves cancellation without a follow-up read', async ({ project }) => {
  const h = await host(() => ({ projects: [project], pagination: { next: null } }));
  try {
    const draft = { ...draftInput, providerAccountId: 'team_exact' };
    await expect(h.read('projectId', draft)).rejects.toMatchObject({ code: 'provider_response_invalid' });
    expect(h.requests).toHaveLength(1);
    const abort = new AbortController();
    abort.abort();
    await expect(h.read('projectId', draft, undefined, undefined, abort.signal)).rejects.toBeDefined();
    expect(h.requests).toHaveLength(1);
  } finally { await h.kit.dispose(); }
});

it.each([[403, 'deployment_access_denied'], [429, 'provider_request_failed']] as const)
('settles provider status %s without retries or provider-error content disclosure', async (status, code) => {
  const h = await host(() => ({ error: { message: 'provider-secret' } }), false, status);
  try {
    await expect(h.read('projectId', { ...draftInput,
      providerAccountId: 'team_exact' })).rejects.toMatchObject({ code });
    expect(h.requests).toHaveLength(1);
  } finally { await h.kit.dispose(); }
});

it('requires the named credential principal and preserves host custody refusal with zero provider reads', async () => {
  const h = await host(() => { throw new Error('No provider request may reach this fixture'); });
  try {
    await expect(h.read('providerAccountId', { credentialRef })).rejects.toMatchObject({ code: 'invalid_parameters' });
    if (!h.resource) throw new Error('Missing Resource');
    await expect(h.resource.read({ ...createTestResourceInvocationContext({
      async readAction() { return { ok: false, errorCode: 'plugin_connected_account_unavailable', error: 'unavailable' }; },
    }), query: { fieldPath: 'providerAccountId', draftInput } }))
      .rejects.toMatchObject({ code: 'plugin_connected_account_unavailable' });
    expect(h.requests).toHaveLength(0);
  } finally { await h.kit.dispose(); }
});

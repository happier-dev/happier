import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountCredentialStore, ConnectedAccountMutationContext, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest, HttpResponse } from '@happier-dev/plugin-sdk/http';
import { PluginConnectedAccountConfigurationV2Schema } from '@happier-dev/protocol';
import * as entry from './index.js';

// The host admits discovered fields with the same declaration schema.
function admitsDiscoveredFields(result: unknown) {
  const fields = (result as { fields?: unknown }).fields;
  expect(PluginConnectedAccountConfigurationV2Schema.safeParse({ scope: 'account', changeBehavior: 'reconnect', fields }).success).toBe(true);
}

const service = { pluginId: 'happier.machine.vercel', localId: 'vercel-account' };
const secret = 'constructed-private-personal-token';
const teamId = 'team_example';
const projectId = 'prj_example';
// Constructed vectors from the documented REST schemas, not tenant captures:
// https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name
// https://vercel.com/docs/rest-api/teams/get-a-team (read 2026-10-27).
const project = { id: projectId, accountId: teamId, name: 'Example project', unrelatedField: true };
const team = { id: teamId, name: 'Example team', slug: 'example-team' };

async function host(options: {
  values?: Record<string, string>; response?: unknown; status?: number; finalUrl?: string;
  failure?: Error; storageFailure?: Error; afterRequest?: (controller: AbortController) => void;
  route?: (request: HttpRequest) => { status: number; body: unknown };
  stageAccountConfiguration?: ConnectedAccountAuthenticationContext['stageAccountConfiguration'];
} = {}) {
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry });
  const runtime = kit.registration('connectedAccountDescriptors', service.localId);
  if (!runtime) await kit.dispose();
  expect(runtime, 'activated vendor Connected Account runtime').toBeDefined();
  if (!runtime) throw new Error('Missing deployment Connected Account runtime');
  const controller = new AbortController();
  const requests: HttpRequest[] = [];
  const requestSignals: (AbortSignal | undefined)[] = [];
  const values = options.values ?? { teamId, projectId };
  const staged = new Map<string, string>();
  const retained = new Map<string, string>([['token', secret]]);
  const store = (map: Map<string, string>): ConnectedAccountCredentialStore => ({
    async get(key) { return map.get(key) ?? null; },
    async set(key, value) { if (options.storageFailure) throw options.storageFailure; map.set(key, value); },
    async delete(key) { map.delete(key); },
  });
  let response: unknown = options.response ?? (values.projectId ? project : team);
  let status = options.status ?? 200;
  const http = createPluginHttpFixture({
    async request(request: HttpRequest, cancellation?: { signal?: AbortSignal }): Promise<HttpResponse> {
      requests.push(request); requestSignals.push(cancellation?.signal);
      if (options.failure) throw options.failure;
      options.afterRequest?.(controller);
      const routed = options.route?.(request);
      if (routed) return { status: routed.status, finalUrl: request.url, headers: {},
        body: new TextEncoder().encode(JSON.stringify(routed.body)) };
      return { status, finalUrl: options.finalUrl ?? request.url, headers: {},
        body: new TextEncoder().encode(JSON.stringify(response)) };
    },
  });
  // Only vendor HTTP and credential persistence are substituted. Unexpected
  // services fail closed, as in the SDK's public Connected Account fixture.
  const services = new Proxy({} as ConnectedAccountReadContext['services'], {
    get(_target, key) { if (key === 'http') return http; throw new Error('Unadmitted service ' + String(key)); },
  });
  const common = { plugin: { id: service.pluginId, version: entry.manifest.version },
    contribution: { id: service.localId, qualifiedId: service.pluginId + '/' + service.localId },
    surface: 'background' as const, invokedAtMs: 1000, services, signal: controller.signal };
  const account = { service, accountId: teamId };
  const configuration = { target: { kind: 'account' as const, account, modeId: 'token' },
    revision: 'configuration-1', values, async getSecret() { return null; } };
  const read = { ...common, configuration, account, credentials: store(retained) } satisfies ConnectedAccountReadContext;
  const authentication = { ...common, service, attempt: { kind: 'connect' as const, attemptId: 'attempt-1' },
    configuration: { ...configuration, target: { kind: 'attempt' as const, attemptId: 'attempt-1', service, modeId: 'token' } },
    attemptCredentials: store(staged),
    ...(options.stageAccountConfiguration ? { stageAccountConfiguration: options.stageAccountConfiguration } : {}),
  } satisfies ConnectedAccountAuthenticationContext;
  const mutation = { ...read, operation: { operationId: 'operation-1', configurationRevision: configuration.revision },
    stagedCredentials: store(staged) } satisfies ConnectedAccountMutationContext;
  const mode = runtime.authentication.modes.token;
  if (mode?.kind !== 'manual') { await kit.dispose(); throw new Error('Missing manual mode'); }
  return { kit, runtime, mode, authentication, read, mutation, staged, retained, controller, requests, requestSignals,
    respond(next: unknown, nextStatus = 200) { response = next; status = nextStatus; } };
}

describe('activated Vercel vendor Connected Account', () => {
  it('probes an exact project with a project token before staging in the host attempt', async () => {
    const h = await host();
    try {
      const result = await h.mode.complete({ fields: { token: secret } }, h.authentication);
      expect(result).toMatchObject({ status: 'connected', providerIdentity: { organizationId: teamId }, scopes: [] });
      expect(result).not.toHaveProperty('accountId');
      expect(h.staged).toEqual(new Map([['token', secret]]));
      expect(h.requests).toEqual([expect.objectContaining({ method: 'GET', redirect: 'error',
        url: 'https://api.vercel.com/v9/projects/prj_example?teamId=team_example', headers: { authorization: 'Bearer ' + secret } })]);
      expect(h.retained.get('token')).toBe(secret);
    } finally { await h.kit.dispose(); }
  });

  it('probes team-scoped personal tokens without requiring an existing project or user-level metadata', async () => {
    const h = await host({ values: { teamId } });
    try {
      expect(await h.mode.complete({ fields: { token: secret } }, h.authentication))
        .toMatchObject({ status: 'connected', displayName: 'Example team', scopes: [] });
      expect(h.requests.map(r => r.url)).toEqual(['https://api.vercel.com/v2/teams/team_example']);
      expect(h.staged.get('token')).toBe(secret);
    } finally { await h.kit.dispose(); }
  });

  it('offers project selection without requiring it for the vendor connection', () => {
    const descriptor = entry.manifest.contributes?.connectedAccountDescriptors?.find(d => d.id === service.localId);
    const mode = descriptor?.authentication?.modes.find(mode => mode.id === 'token');
    expect(mode?.configuration?.fields.find(field => field.id === 'projectId')).toMatchObject({ required: false });
    // A token alone can be submitted; its teams are offered afterwards.
    expect(mode?.configuration?.fields.find(field => field.id === 'teamId')).toMatchObject({ required: false });
  });

  it('materializes team-only configuration without inventing a sandbox project', async () => {
    const h = await host({ values: { teamId } });
    try {
      expect(await h.runtime.materialize({ kind: 'environment', keys: ['VERCEL_TEAM_ID'] }, h.read))
        .toEqual({ kind: 'environment', env: { VERCEL_TEAM_ID: teamId } });
      await expect(h.runtime.materialize({ kind: 'environment', keys: ['VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'] }, h.read))
        .rejects.toMatchObject({ code: 'credential_unavailable' });
      expect(h.requests).toEqual([]);
    } finally { await h.kit.dispose(); }
  });

  it.each([
    { status: 401, expected: 'rejected', code: 'vercel_invalid_token' },
    { status: 403, expected: 'rejected', code: 'vercel_missing_permission' },
    // Observed with a deliberately fake token at the public team endpoint, 2026-11-04.
    { status: 403, response: { error: { code: 'forbidden', message: 'Not authorized', invalidToken: true } }, expected: 'rejected', code: 'vercel_invalid_token' },
    { status: 400, response: { error: { code: 'bad_request', message: 'Bad request' } }, expected: 'unavailable', code: 'vercel_invalid_response' },
    { status: 302, expected: 'unavailable', code: 'vercel_invalid_response' },
    { status: 404, expected: 'rejected', code: 'vercel_scope_unavailable' },
    { status: 429, expected: 'unavailable', code: 'vercel_unavailable' },
    { status: 503, expected: 'unavailable', code: 'vercel_unavailable' },
    { status: 200, response: { ...project, id: 'other' }, expected: 'rejected', code: 'vercel_scope_mismatch' },
    { status: 200, response: { ...project, accountId: 'other' }, expected: 'rejected', code: 'vercel_scope_mismatch' },
    { status: 200, response: {}, expected: 'unavailable', code: 'vercel_invalid_response' },
  ])('does not stage on denied, missing or unverified scope ($status, $code)', async vector => {
    const h = await host(vector);
    try {
      const result = await h.mode.complete({ fields: { token: secret } }, h.authentication);
      expect(result).toMatchObject({ status: vector.expected, diagnostic: { code: vector.code } });
      expect(h.staged.size).toBe(0);
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally { await h.kit.dispose(); }
  });

  it('does not infer deployment-write permissions from identity reads or expose unproven OAuth', async () => {
    // AM-1: a successful identity/scope read may connect a read-only member.
    // A role label is not an effective permission probe or write-authority claim.
    const h = await host({ response: { ...project, role: 'VIEWER', permissions: [] } });
    try {
      const descriptor = entry.manifest.contributes?.connectedAccountDescriptors?.find(d => d.id === service.localId);
      expect(descriptor?.authentication).toMatchObject({ defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual' }] });
      expect(Object.keys(h.runtime.authentication.modes)).toEqual(['token']);
      const result = await h.mode.complete({ fields: { token: secret } }, h.authentication);
      expect(result).toMatchObject({ status: 'connected', scopes: [] });
      expect(result).not.toHaveProperty('deploymentPermissions');
      expect(h.requests).toHaveLength(1);
      expect(new URL(h.requests[0]!.url).searchParams.toString()).toBe('teamId=team_example');
      h.respond({ error: { code: 'forbidden', message: secret } }, 403);
      expect(await h.runtime.status(h.read)).toMatchObject({ status: 'reconnectRequired', diagnostic: { code: 'vercel_missing_permission' } });
    } finally { await h.kit.dispose(); }
  });

  it.each(['before', 'during'] as const)('cancellation %s the probe stages nothing', async phase => {
    const h = await host({ ...(phase === 'during' ? { afterRequest: (c: AbortController) => c.abort() } : {}) });
    try {
      if (phase === 'before') h.controller.abort();
      await expect(h.mode.complete({ fields: { token: secret } }, h.authentication)).rejects.toMatchObject({ name: 'AbortError' });
      expect(h.staged.size).toBe(0);
      expect(h.requests).toHaveLength(phase === 'before' ? 0 : 1);
      if (phase === 'during') expect(h.requestSignals[0]?.aborted).toBe(true);
    } finally { await h.kit.dispose(); }
  });

  it('also respects the operation cancellation signal', async () => {
    const h = await host();
    const cancellation = new AbortController(); cancellation.abort();
    try {
      await expect(h.mode.complete({ fields: { token: secret } }, h.authentication, { signal: cancellation.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(h.requests).toHaveLength(0); expect(h.staged.size).toBe(0);
    } finally { await h.kit.dispose(); }
  });

  it.each([
    { failure: new Error('provider echoed ' + secret) },
    { storageFailure: new Error('storage echoed ' + secret) },
    { finalUrl: 'https://untrusted.example/redirect' },
  ])('keeps transport/storage/redirect failure details private', async vector => {
    const h = await host(vector);
    try {
      const result = await h.mode.complete({ fields: { token: secret } }, h.authentication);
      expect(result.status).toBe('unavailable'); expect(JSON.stringify(result)).not.toContain(secret);
      expect(h.staged.size).toBe(0);
    } finally { await h.kit.dispose(); }
  });

  it('does not send malformed tokens or a malformed team', async () => {
    const h = await host({ values: { teamId: 'team with spaces' } });
    try {
      expect(await h.mode.complete({ fields: { token: secret } }, h.authentication)).toMatchObject({ status: 'rejected' });
      expect(await h.mode.complete({ fields: { token: 'bad\r\nheader' } }, h.authentication)).toMatchObject({ status: 'rejected' });
      expect(h.requests).toHaveLength(0); expect(h.staged.size).toBe(0);
    } finally { await h.kit.dispose(); }
  });

  it('rechecks manual-token health on refresh and requires reconnect after expiration or revocation', async () => {
    const h = await host();
    try {
      expect(await h.runtime.status(h.read)).toMatchObject({ status: 'connected' });
      h.respond({ error: { code: 'invalid_token', message: secret } }, 401);
      expect(await h.runtime.refresh(h.mutation)).toMatchObject({ status: 'reconnectRequired', diagnostic: { code: 'vercel_invalid_token' } });
      expect(h.staged.size).toBe(0);
      expect(h.requests.every(r => r.method === 'GET')).toBe(true);
      h.respond(project);
      expect(await h.runtime.refresh(h.mutation)).toMatchObject({ status: 'connected' });
    } finally { await h.kit.dispose(); }
  });

  it('materializes only exact API authorization through the existing credential owner', async () => {
    const h = await host();
    try {
      expect(await h.runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.vercel.com', headerNames: ['authorization'] }, h.read))
        .toEqual({ kind: 'httpHeaders', headers: { authorization: 'Bearer ' + secret } });
      for (const request of [
        { kind: 'httpHeaders' as const, origin: 'https://foreign.example', headerNames: ['authorization'] },
        { kind: 'httpHeaders' as const, origin: 'https://api.vercel.com', headerNames: ['cookie'] },
        { kind: 'environment' as const, keys: ['VERCEL_TOKEN'] },
      ]) await expect(h.runtime.materialize(request, h.read)).rejects.toMatchObject({ code: 'credential_unavailable' });
      expect(h.requests).toHaveLength(0);
      h.retained.clear();
      expect(await h.runtime.status(h.read)).toMatchObject({ status: 'reconnectRequired' });
      await expect(h.runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.vercel.com', headerNames: ['authorization'] }, h.read))
        .rejects.toMatchObject({ code: 'credential_unavailable' });
      expect(h.requests).toHaveLength(0);
    } finally { await h.kit.dispose(); }
  });

  it('revokes only the current token and does not replay an ambiguous revocation', async () => {
    const h = await host({ response: { tokenId: 'token_example' } });
    try {
      expect(await h.runtime.revoke(h.read)).toEqual({ status: 'remoteRevoked' });
      expect(h.requests).toMatchObject([{ method: 'DELETE', url: 'https://api.vercel.com/v3/user/tokens/current' }]);
      expect(h.requests).toHaveLength(1);
      h.respond({ error: { message: secret } }, 503);
      const uncertain = await h.runtime.revoke(h.read);
      expect(uncertain.status).toBe('outcomeUnknown'); expect(JSON.stringify(uncertain)).not.toContain(secret);
      expect(h.requests).toHaveLength(2);
      h.respond({ error: { code: 'forbidden' } }, 403);
      expect(await h.runtime.revoke(h.read)).toMatchObject({ status: 'remoteUnsupported', diagnostic: { code: 'vercel_missing_permission' } });
    } finally { await h.kit.dispose(); }
  });

  it('cancels refresh and revocation before any provider request', async () => {
    const h = await host();
    try {
      h.controller.abort();
      await expect(h.runtime.refresh(h.mutation)).rejects.toMatchObject({ name: 'AbortError' });
      await expect(h.runtime.revoke(h.read)).rejects.toMatchObject({ name: 'AbortError' });
      expect(h.requests).toHaveLength(0); expect(h.staged.size).toBe(0);
    } finally { await h.kit.dispose(); }
  });
});

describe('Vercel team picker from a pasted token', () => {
  const teamsUrl = 'https://api.vercel.com/v2/teams';
  function pages(request: HttpRequest) {
    const url = new URL(request.url);
    if (url.pathname === '/v2/teams') return { status: 200, body: {
      teams: url.searchParams.has('until') ? [{ id: 'team_second', name: 'Second team' }] : [{ id: 'team_first', name: 'First team' }],
      pagination: { count: 1, next: url.searchParams.has('until') ? null : 1234, prev: null },
    } };
    return { status: 200, body: { id: 'team_second', name: 'Second team' } };
  }

  it('offers every team from paginated discovery and connects the chosen one with the staged token', async () => {
    const h = await host({ values: {}, route: pages });
    try {
      const offered = await h.mode.complete({ fields: { token: secret } }, h.authentication);
      expect(offered).toMatchObject({ status: 'configurationRequired', fields: [expect.objectContaining({
        id: 'teamId', required: true, schema: { type: 'string', enum: ['team_first', 'team_second'] },
        presentation: expect.objectContaining({ options: [
          { value: 'team_first', title: 'First team' }, { value: 'team_second', title: 'Second team' },
        ] }),
      })] });
      expect(h.requests.map(request => request.url)).toEqual([teamsUrl, teamsUrl + '?until=1234']);
      expect(h.staged).toEqual(new Map([['token', secret]]));
      expect(JSON.stringify(offered)).not.toContain(secret);
      admitsDiscoveredFields(offered);
      const chosen = { ...h.authentication, configuration: { ...h.authentication.configuration, values: { teamId: 'team_second' } } };
      expect(await h.mode.reconcile?.(chosen))
        .toMatchObject({ status: 'connected', displayName: 'Second team', providerIdentity: { organizationId: 'team_second' } });
      expect(h.requests.at(-1)?.url).toBe('https://api.vercel.com/v2/teams/team_second');
    } finally { await h.kit.dispose(); }
  });

  it('chooses the only team in place, for a team token or a personal account', async () => {
    const stagedConfiguration: unknown[] = [];
    const h = await host({ values: {}, stageAccountConfiguration: async replacement => { stagedConfiguration.push(replacement); },
      route: request => new URL(request.url).pathname === '/v2/teams'
        ? { status: 200, body: { teams: [{ id: teamId, name: 'Example team' }], pagination: { count: 1, next: null, prev: null } } }
        : { status: 200, body: team } });
    try {
      expect(await h.mode.complete({ fields: { token: secret } }, h.authentication))
        .toMatchObject({ status: 'connected', displayName: 'Example team', providerIdentity: { organizationId: teamId } });
      expect(stagedConfiguration).toEqual([expect.objectContaining({ values: { teamId } })]);
      expect(h.requests.map(request => request.url)).toEqual([teamsUrl, 'https://api.vercel.com/v2/teams/team_example']);
      expect(h.staged.get('token')).toBe(secret);
    } finally { await h.kit.dispose(); }
  });

  it('keeps project tokens usable when team listing is forbidden', async () => {
    const h = await host({ values: {}, route: request => new URL(request.url).pathname === '/v2/teams'
      ? { status: 403, body: { error: { code: 'forbidden' } } }
      : { status: 200, body: { id: 'prj_one', accountId: 'team_one', name: 'Existing project' } } });
    try {
      const offered = await h.mode.complete({ fields: { token: secret } }, h.authentication);
      expect(offered).toMatchObject({ status: 'configurationRequired', fields: [
        expect.objectContaining({ id: 'teamId', required: true }), expect.objectContaining({ id: 'projectId' }),
      ] });
      admitsDiscoveredFields(offered);
      const chosen = { ...h.authentication, configuration: { ...h.authentication.configuration, values: { teamId: 'team_one', projectId: 'prj_one' } } };
      expect(await h.mode.reconcile?.(chosen)).toMatchObject({ status: 'connected', providerIdentity: { organizationId: 'team_one' } });
      expect(h.requests.map(request => request.url)).toEqual([teamsUrl, 'https://api.vercel.com/v9/projects/prj_one?teamId=team_one']);
    } finally { await h.kit.dispose(); }
  });

  it.each([
    { status: 401, body: {}, code: 'vercel_invalid_token' },
    { status: 403, body: { error: { code: 'forbidden', invalidToken: true } }, code: 'vercel_invalid_token' },
    { status: 429, body: {}, code: 'vercel_unavailable' },
    { status: 200, body: { teams: [{ id: 'team_one' }], pagination: { next: null } }, code: 'vercel_invalid_response' },
    { status: 200, body: { teams: [], pagination: { next: 5 } }, code: 'vercel_invalid_response', repeat: true },
  ])('stages nothing when team discovery fails ($status, $code)', async vector => {
    const h = await host({ values: {}, route: request => vector.repeat && new URL(request.url).searchParams.get('until') === '5'
      ? { status: 200, body: { teams: [], pagination: { next: 5 } } } : vector });
    try {
      const result = await h.mode.complete({ fields: { token: secret } }, h.authentication);
      expect(result).toMatchObject({ diagnostic: { code: vector.code } });
      expect(h.staged.size).toBe(0);
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally { await h.kit.dispose(); }
  });

  it('asks for the token again when the staged token is missing at reconcile', async () => {
    const h = await host({ values: { teamId } });
    try {
      expect(await h.mode.reconcile?.(h.authentication)).toMatchObject({ status: 'rejected', diagnostic: { code: 'vercel_invalid_token' } });
      expect(h.requests).toEqual([]);
    } finally { await h.kit.dispose(); }
  });
});

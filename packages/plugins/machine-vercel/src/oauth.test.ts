import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPluginHttpFixture,
  createPluginTestkit,
  type PluginTestkit,
} from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { PluginConnectedAccountAuthenticationModeV2Schema } from '@happier-dev/protocol';
import * as entry from './index.js';
import { PLUGIN, PLUGIN_MANIFEST } from './manifest.js';

import { callbackUrl, clientId, completion, credentials, createVercelOAuthFixture, pkce, projectId, projects, service, teamId } from './oauth.testkit.js';

const kits: PluginTestkit[] = [];
afterEach(async () => {
  await Promise.all(kits.splice(0).map((kit) => kit.dispose()));
});

async function harness(options?: Parameters<typeof createVercelOAuthFixture>[0]) {
  const fixture = await createVercelOAuthFixture(options);
  kits.push(fixture.kit);
  return fixture;
}

function form(request: HttpRequest | undefined) {
  expect(request?.method).toBe('POST');
  expect(request?.headers).not.toHaveProperty('authorization');
  return new URLSearchParams(
    new TextDecoder().decode(request?.body as Uint8Array),
  );
}
const signedIn = {
  token: 'access-private',
  refreshToken: 'refresh-private',
  expiresAtMs: String(Date.now() + 3_600_000),
  oauthClientId: clientId,
  subject: 'user_subject',
  email: 'person@example.com',
};

describe('Sign in with Vercel (public PKCE client on the daemon)', () => {
  it('declares sign-in as the default mode beside the token mode, through the Home relay', () => {
    const descriptor =
      entry.manifest.contributes?.connectedAccountDescriptors?.find(
        (d) => d.id === service.localId,
      );
    expect(descriptor?.authentication?.defaultModeId).toBe('oauth');
    expect(descriptor?.authentication?.modes.map(({ id, credentialKind }) => ({ id, credentialKind }))).toEqual([
      { id: 'oauth', credentialKind: 'oauth' },
      { id: 'token', credentialKind: 'token' },
    ]);
    const mode = descriptor?.authentication?.modes.find(
      (item) => item.id === 'oauth',
    );
    expect(
      PluginConnectedAccountAuthenticationModeV2Schema.safeParse(mode).success,
    ).toBe(true);
    expect(mode).toMatchObject({
      kind: 'oauthAuthorizationCode',
      pkce: 'required',
      scopes: ['openid', 'email', 'profile', 'offline_access'],
      postAuthenticationFieldIds: ['teamId', 'projectId'],
    });
    expect(mode).not.toHaveProperty('callbackUrl');
    expect(mode).not.toHaveProperty('clientConfiguration');
  });

  it.each([
    ['connect', false],
    ['reconnect', true],
  ] as const)(
    'begins a %s with the Home public client and PKCE (prompt=consent: %s)',
    async (attempt, consent) => {
      const h = await harness({ attempt, publicClientScopes: ['openid', 'offline_access'] });
      const result = await h.mode.begin(
        { callbackUrl, state: 'attempt-1.nonce', pkce },
        h.authentication,
      );
      expect(result).toMatchObject({
        status: 'awaitingOAuthRedirect',
        issuer: 'https://vercel.com',
      });
      if (result.status !== 'awaitingOAuthRedirect')
        throw new Error('expected a redirect');
      const url = new URL(result.authorizationUrl);
      expect(url.origin + url.pathname).toBe(
        'https://vercel.com/oauth/authorize',
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: clientId,
        redirect_uri: callbackUrl,
        response_type: 'code',
        scope: 'openid offline_access',
        state: 'attempt-1.nonce',
        code_challenge: 'challenge-value',
        code_challenge_method: 'S256',
        ...(consent ? { prompt: 'consent' } : {}),
      });
      // Refresh and revoke keep the client that issued the grant.
      expect(h.staged.values.get('oauthClientId')).toBe(clientId);
      expect(h.requests).toHaveLength(0);
    },
  );

  it('says sign-in is unavailable when the Home offers no Vercel client', async () => {
    const h = await harness({ publicClient: false });
    const result = await h.mode.begin(
      { callbackUrl, state: 'attempt-1.nonce', pkce },
      h.authentication,
    );
    expect(result).toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'vercel_oauth_public_client_unavailable' },
    });
  });

  it('exchanges the code with client_id only, reads userinfo, chooses the only team and stages the grant', async () => {
    const h = await harness();
    await h.mode.begin(
      { callbackUrl, state: 'attempt-1.nonce', pkce },
      h.authentication,
    );
    const result = await h.mode.complete(completion, h.authentication);
    expect(result).toMatchObject({
      status: 'connected',
      credentialKind: 'oauth',
      displayName: 'Example team',
      providerIdentity: {
        accountId: 'user_subject',
        email: 'person@example.com',
        organizationId: teamId,
      },
    });
    const exchange = form(h.requests[0]);
    expect(h.requests[0]?.url).toBe('https://api.vercel.com/login/oauth/token');
    expect(Object.fromEntries(exchange)).toEqual({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: 'code-private',
      redirect_uri: callbackUrl,
      code_verifier: 'verifier-private',
    });
    expect(h.requests.map((item) => new URL(item.url).pathname)).toEqual([
      '/login/oauth/token',
      '/login/oauth/userinfo',
      '/v2/teams',
      `/v2/teams/${teamId}`,
      '/v10/projects',
    ]);
    expect(h.requests[1]?.headers).toMatchObject({
      authorization: 'Bearer access-private',
    });
    expect(h.values.teamId).toBe(teamId);
    expect(Object.fromEntries(h.staged.values)).toMatchObject({
      token: 'access-private',
      refreshToken: 'refresh-private',
      oauthClientId: clientId,
      subject: 'user_subject',
    });
    expect(Number(h.staged.values.get('expiresAtMs'))).toBeGreaterThan(
      Date.now(),
    );
    expect(JSON.stringify(result)).not.toMatch(/private/u);
  });

  it('offers the granted teams and connects the chosen one with the staged grant at reconcile', async () => {
    const h = await harness({
      teams: [
        { id: teamId, name: 'Example team' },
        { id: 'team_other', name: 'Other team' },
      ],
    });
    await h.mode.begin(
      { callbackUrl, state: 'attempt-1.nonce', pkce },
      h.authentication,
    );
    const pending = await h.mode.complete(completion, h.authentication);
    expect(pending).toMatchObject({
      status: 'configurationRequired',
      fields: [{ id: 'teamId', schema: { enum: [teamId, 'team_other'] } }],
    });
    // Both granted teams were read by the grant; no default team was assumed.
    expect(h.values).not.toHaveProperty('teamId');
    expect(h.staged.values.get('token')).toBe('access-private');
    h.values.teamId = 'team_other';
    if (!h.mode.reconcile)
      throw new Error('OAuth mode must reconcile a team choice');
    const result = await h.mode.reconcile(h.authentication);
    expect(result).toMatchObject({
      status: 'connected',
      credentialKind: 'oauth',
      displayName: 'Other team',
      providerIdentity: {
        accountId: 'user_subject',
        email: 'person@example.com',
        organizationId: 'team_other',
      },
    });
    // One token call and one userinfo read per connect; T team probes, then the chosen team's probe and project list.
    expect(h.requests.map((item) => new URL(item.url).pathname)).toEqual([
      '/login/oauth/token',
      '/login/oauth/userinfo',
      '/v2/teams',
      `/v2/teams/${teamId}`,
      '/v2/teams/team_other',
      '/v2/teams/team_other',
      '/v10/projects',
    ]);
  });

  it('rejects a refused code without staging anything', async () => {
    const h = await harness();
    h.routes.set('/login/oauth/token', {
      status: 400,
      body: { error: 'invalid_grant' },
    });
    const result = await h.mode.complete(completion, h.authentication);
    expect(result).toMatchObject({
      status: 'rejected',
      diagnostic: { code: 'vercel_oauth_reconnect_required' },
    });
    expect(h.staged.values.size).toBe(0);
  });

  it('refreshes with the retained client_id, stages the rotated pair and makes no other vendor call', async () => {
    const h = await harness({ values: { teamId }, retained: signedIn });
    h.routes.set('/login/oauth/token', {
      status: 200,
      body: {
        token_type: 'bearer',
        access_token: 'access-rotated-private',
        refresh_token: 'refresh-rotated-private',
        expires_in: 3600,
      },
    });
    const legacy = credentials({ ...signedIn, projectChoiceTeamId: teamId });
    const result = await h.runtime.refresh({ ...h.mutation, stagedCredentials: legacy.store });
    expect(result).toMatchObject({
      status: 'connected',
      credentialKind: 'oauth',
      providerIdentity: { accountId: 'user_subject', organizationId: teamId },
    });
    expect(result).toHaveProperty(
      'expiresAt',
      Number(legacy.values.get('expiresAtMs')),
    );
    expect(h.requests).toHaveLength(1);
    expect(Object.fromEntries(form(h.requests[0]))).toEqual({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: 'refresh-private',
    });
    expect(Object.fromEntries(legacy.values)).toMatchObject({
      token: 'access-rotated-private',
      refreshToken: 'refresh-rotated-private',
      oauthClientId: clientId,
    });
    expect(legacy.values.has('projectChoiceTeamId')).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/private/u);
  });

  it('asks to reconnect when Vercel refuses the refresh grant (invalid_grant)', async () => {
    const h = await harness({ values: { teamId }, retained: signedIn });
    h.routes.set('/login/oauth/token', {
      status: 400,
      body: { error: 'invalid_grant', error_description: 'refresh-private' },
    });
    const result = await h.runtime.refresh(h.mutation);
    expect(result).toMatchObject({
      status: 'reconnectRequired',
      diagnostic: { code: 'vercel_oauth_reconnect_required' },
    });
    expect(h.staged.values.size).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/private/u);
  });

  it('reports a lost refresh reply as an unknown outcome, never a retry of the rotated grant', async () => {
    const h = await harness({ values: { teamId }, retained: signedIn });
    h.routes.set(
      '/login/oauth/token',
      Object.assign(new Error('refresh-private'), { code: 'ECONNRESET' }),
    );
    const result = await h.runtime.refresh(h.mutation);
    expect(result).toMatchObject({ status: 'outcomeUnknown' });
    expect(h.staged.values.size).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/private/u);
  });

  it('reports expiry from status so the refresh coordinator renews the grant', async () => {
    const live = await harness({ values: { teamId }, retained: signedIn });
    expect(await live.runtime.status(live.read)).toMatchObject({
      status: 'connected',
      credentialKind: 'oauth',
      expiresAt: Number(signedIn.expiresAtMs),
      providerIdentity: { accountId: 'user_subject', organizationId: teamId },
    });
    const expired = await harness({
      values: { teamId },
      retained: { ...signedIn, expiresAtMs: String(Date.now() - 1) },
    });
    expect(await expired.runtime.status(expired.read)).toEqual({
      status: 'expired',
    });
    expect(expired.requests).toHaveLength(0);
  });

  it('revokes the refresh token with client_id only and falls back to manual revoke on refusal', async () => {
    const h = await harness({ values: { teamId }, retained: signedIn });
    expect(await h.runtime.revoke(h.read)).toEqual({ status: 'remoteRevoked' });
    expect(h.requests[0]?.url).toBe(
      'https://api.vercel.com/login/oauth/token/revoke',
    );
    expect(Object.fromEntries(form(h.requests[0]))).toEqual({
      token: 'refresh-private',
      token_type_hint: 'refresh_token',
      client_id: clientId,
    });
    h.routes.set('/login/oauth/token/revoke', {
      status: 401,
      body: { error: 'invalid_client' },
    });
    expect(await h.runtime.revoke(h.read)).toMatchObject({
      status: 'remoteUnsupported',
      diagnostic: { code: 'vercel_oauth_manual_revoke_required' },
    });
  });
});

const scopeRefusal = {
  status: 403,
  body: { error: { code: 'forbidden', message: 'Not authorized: Trying to access resource under scope "team_other". You must re-authenticate to this scope or use a token with access to this scope.' } },
};
const paths = (h: Awaited<ReturnType<typeof harness>>) => h.requests.map((item) => new URL(item.url).pathname);

describe('Sign in with Vercel: granted team, project and re-consent', () => {
  it('auto-chooses the only granted team when another listed membership refuses the grant', async () => {
    const h = await harness({ teams: [{ id: teamId, name: 'Example team' }, { id: 'team_other', name: 'Other team' }] });
    h.routes.set('/v2/teams/team_other', scopeRefusal);
    await h.mode.begin({ callbackUrl, state: 'attempt-1.nonce', pkce }, h.authentication);
    const result = await h.mode.complete(completion, h.authentication);
    expect(result).toMatchObject({ status: 'connected', providerIdentity: { organizationId: teamId } });
    expect(h.values.teamId).toBe(teamId);
    expect(h.stagedConfigurations).toMatchObject([{ values: { teamId }, fields: [{ id: 'teamId', schema: { enum: [teamId] } }] }]);
  });

  it('refuses a sign-in whose grant reads none of the listed teams, and never uses a default team', async () => {
    const h = await harness({ teams: [{ id: 'team_other', name: 'Other team' }] });
    h.routes.set('/v2/teams/team_other', scopeRefusal);
    await h.mode.begin({ callbackUrl, state: 'attempt-1.nonce', pkce }, h.authentication);
    const result = await h.mode.complete(completion, h.authentication);
    expect(result).toMatchObject({ status: 'rejected', diagnostic: { code: 'vercel_oauth_team_not_granted' } });
    expect(h.values).not.toHaveProperty('teamId');
    expect(paths(h)).not.toContain('/v2/user');
    expect(h.staged.values.size).toBe(1); // only the attempt's retained client id
  });

  it('refuses a chosen team the grant cannot read at reconcile', async () => {
    const h = await harness({ teams: [{ id: teamId, name: 'Example team' }, { id: 'team_other', name: 'Other team' }] });
    h.routes.set('/v2/teams/team_other', { status: 503 });
    await h.mode.begin({ callbackUrl, state: 'attempt-1.nonce', pkce }, h.authentication);
    // An unanswered probe keeps the team offered; its choice is probed again.
    expect(await h.mode.complete(completion, h.authentication)).toMatchObject({
      status: 'configurationRequired', fields: [{ id: 'teamId', schema: { enum: [teamId, 'team_other'] } }],
    });
    h.routes.set('/v2/teams/team_other', { status: 403, body: { error: { code: 'forbidden', message: 'Not authorized' } } });
    h.values.teamId = 'team_other';
    expect(await h.mode.reconcile!(h.authentication)).toMatchObject({ status: 'rejected', diagnostic: { code: 'vercel_missing_permission' } });
  });

  it('offers the team\'s projects after sign-in and connects the probed project choice', async () => {
    const h = await harness();
    h.routes.set('/v10/projects', projects);
    h.routes.set(`/v9/projects/${projectId}`, { status: 200, body: { id: projectId, name: 'Example site', accountId: teamId } });
    await h.mode.begin({ callbackUrl, state: 'attempt-1.nonce', pkce }, h.authentication);
    const offered = await h.mode.complete(completion, h.authentication);
    expect(offered).toMatchObject({ status: 'configurationRequired', fields: [
      { id: 'teamId', schema: { enum: [teamId] } },
      { id: 'projectId', required: false, schema: { enum: [projectId, 'prj_docs'] } },
    ] });
    const listing = h.requests.find((item) => new URL(item.url).pathname === '/v10/projects');
    expect(new URL(listing!.url).searchParams.get('teamId')).toBe(teamId);
    h.values.projectId = projectId;
    expect(await h.mode.reconcile!(h.authentication)).toMatchObject({ status: 'connected', displayName: 'Example site',
      providerIdentity: { accountId: 'user_subject', organizationId: teamId } });
    expect(paths(h).at(-1)).toBe(`/v9/projects/${projectId}`);
    expect(h.staged.values.has('projectChoiceTeamId')).toBe(false);
  });

  it('offers project names from the documented unpaginated response', async () => {
    const h = await harness();
    h.routes.set('/v10/projects', {
      status: 200, body: [{ id: projectId, name: 'Example site', accountId: teamId }],
    });
    await h.mode.begin({ callbackUrl, state: 'attempt-1.nonce', pkce }, h.authentication);
    expect(await h.mode.complete(completion, h.authentication)).toMatchObject({
      status: 'configurationRequired',
      fields: [{ id: 'teamId' }, { id: 'projectId', schema: { enum: [projectId] } }],
    });
    expect(paths(h).filter(path => path === '/v10/projects')).toHaveLength(1);
  });

  it('connects without a project when the person skips the optional choice, offering it once', async () => {
    const h = await harness();
    h.routes.set('/v10/projects', projects);
    await h.mode.begin({ callbackUrl, state: 'attempt-1.nonce', pkce }, h.authentication);
    expect(await h.mode.complete(completion, h.authentication)).toMatchObject({ status: 'configurationRequired' });
    const before = h.requests.length;
    expect(await h.mode.reconcile!(h.authentication)).toMatchObject({ status: 'connected', providerIdentity: { organizationId: teamId } });
    expect(paths(h).slice(before)).toEqual([`/v2/teams/${teamId}`]);
    expect(h.staged.values.has('projectChoiceTeamId')).toBe(false);
  });

  it('reports Vercel\'s scope refusal on a signed-in account as updated permissions to reconnect for', async () => {
    const h = await harness({ values: { teamId }, retained: signedIn });
    h.routes.set(`/v2/teams/${teamId}`, scopeRefusal);
    expect(await h.runtime.status(h.read)).toMatchObject({
      status: 'reconnectRequired', diagnostic: { code: 'vercel_permissions_update_required' },
    });
    // Other 403s keep their existing classification.
    h.routes.set(`/v2/teams/${teamId}`, { status: 403, body: { error: { code: 'forbidden', message: 'Not authorized' } } });
    expect(await h.runtime.status(h.read)).toMatchObject({
      status: 'reconnectRequired', diagnostic: { code: 'vercel_missing_permission' },
    });
  });
});

describe('Sign in with Vercel, then start a Sandbox (composed)', () => {
  async function signInThenProvisioner(options: { chooseProject: boolean }) {
    const h = await harness();
    h.routes.set('/v10/projects', projects);
    h.routes.set(`/v9/projects/${projectId}`, { status: 200, body: { id: projectId, name: 'Example site', accountId: teamId } });
    h.routes.set(`/v2/teams/${teamId}`, { status: 200, body: { id: teamId, name: 'Example team', billing: { plan: 'pro' } } });
    await h.mode.begin({ callbackUrl, state: 'attempt-1.nonce', pkce }, h.authentication);
    await h.mode.complete(completion, h.authentication);
    if (options.chooseProject) h.values.projectId = projectId;
    expect(await h.mode.reconcile!(h.authentication)).toMatchObject({ status: 'connected' });
    // The settled account: its configuration and the credentials this sign-in staged.
    const account = { ...h.read, credentials: h.staged.store };
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: PLUGIN, services: {
      connectedAccounts: { async materialize(_purpose: string, request: Parameters<typeof h.runtime.materialize>[0]) {
        return await h.runtime.materialize(request, account);
      } },
      http: createPluginHttpFixture({ request: h.request }),
    } as never });
    kits.push(kit);
    return { h, kit };
  }

  it('boots a Sandbox in the signed-in team and project with the sign-in token', async () => {
    const { h, kit } = await signInThenProvisioner({ chooseProject: true });
    const managedId = 'machine-one';
    const name = `happier-${managedId}`;
    h.routes.set('/v4/sandboxes', { status: 200, body: {
      sandbox: { name, tags: { 'happier-managed-id': managedId }, createdAt: 1000, currentSessionId: 'sbx_one', status: 'running', persistent: true },
      session: { id: 'sbx_one', sourceSandboxName: name, projectId, createdAt: 1000 }, routes: [],
    } });
    const before = h.requests.length;
    expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ available: true });
    expect(await kit.invokeAction('acquire', { managedId,
      launch: { image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 1, timeoutMs: 300000, snapshotExpirationMs: 0 } },
    { surface: 'plugin' })).toMatchObject({ kind: 'bound' });
    const sandbox = h.requests.slice(before).filter((item) => new URL(item.url).pathname.startsWith('/v4/sandboxes'));
    expect(sandbox).toHaveLength(1);
    expect(new URL(sandbox[0]!.url).searchParams.get('teamId')).toBe(teamId);
    expect(JSON.parse(new TextDecoder().decode(sandbox[0]!.body as Uint8Array))).toMatchObject({ projectId });
    expect(sandbox[0]!.headers).toMatchObject({ authorization: 'Bearer access-private' });
  });

  it('without a project, says to choose one with a fix-it that opens the Vercel account', async () => {
    const { h, kit } = await signInThenProvisioner({ chooseProject: false });
    const before = h.requests.length;
    expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({
      available: false, code: 'vercel_project_required', status: { key: 'machineVercel.projectRequired' },
    });
    await expect(kit.invokeAction('acquire', { managedId: 'machine-one',
      launch: { image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 1, timeoutMs: 300000, snapshotExpirationMs: 0 } },
    { surface: 'plugin' })).rejects.toMatchObject({ code: 'vercel_project_required',
      remediation: { kind: 'selectAccount', service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' } } });
    // The reason comes from the account's configuration, without any vendor call.
    expect(h.requests.length).toBe(before);
  });
});

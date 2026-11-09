import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';

const boundary = vi.hoisted(() => ({
  execute: vi.fn(),
  open: vi.fn(async () => true),
}));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
// The mounted Action front door and the system browser are the boundaries; the sign-in state runs for real.
vi.mock('@/components/approvals/useMountedActionExecution', () => ({
  useMountedActionExecution: () => ({
    execute: boundary.execute,
    ready: true,
    isCurrent: () => true,
    approval: {},
  }),
}));
vi.mock('@/utils/url/openExternalUrl', () => ({
  openExternalUrl: boundary.open,
}));

const { useMcpServerSignIn } = await import('./useMcpServerSignIn');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');

const server = {
  id: 'linear',
  name: 'Linear',
  transport: 'http',
  env: {},
  createdAt: 1,
  updatedAt: 1,
  remote: {
    url: 'https://mcp.linear.app/mcp',
    headers: {},
    auth: { kind: 'oauth' },
  },
} as unknown as McpServerCatalogEntryV1;
const online = [{ machineId: 'm1', name: 'nl2', online: true }];
const offline = [{ machineId: 'm1', name: 'nl2', online: false }];
const started = {
  attemptId: 'attempt-1',
  authorizationUrl: 'https://linear.app/oauth/authorize?state=attempt-1.n',
  expiresAtMs: Date.now() + 600_000,
  machineId: 'm1',
};

function grant(
  status: 'connected' | 'needs_reauth',
  credentialRevision: number,
) {
  return QualifiedConnectedAccountProfileV4Schema.parse({
    ref: { service: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1, accountId: 'linear' },
    status,
    authenticationModeId: 'oauth',
    configurationReady: true,
    configurationRevision: 'configuration-1',
    kind: 'oauth',
    revisionSemantics: 'revisioned',
    credentialRevision: `csr_${String(credentialRevision).padStart(22, '0')}`,
    providerIdentity: { email: 'leeroy@acme.dev' },
    scopes: ['read', 'write'],
  });
}

// Safe configuration Action output: the account-target read of the host MCP OAuth runtime's values.
function configuration(resource = server.remote!.url, stepUpScopes: string[] = []) {
  return CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.get'].parse({
    target: { kind: 'account', account: grant('connected', 1).ref, modeId: 'oauth' },
    mode: { id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback', pkce: 'required', outcomeReconciliation: 'none' },
    configuration: { status: 'ready', revision: 'configuration-1', values: { serverId: server.id, resource, grantedScopes: ['read', 'write'], stepUpScopes }, configuredSecretFieldIds: [], missingFieldIds: [] },
  });
}
function setGrants(grants: readonly unknown[]) {
  const state = getStorage().getState();
  getStorage().setState({
    profile: { ...state.profile, connectedAccountsV4: grants },
  } as never);
}

async function activateSignInHome(serverUrl: string, serverIdentityId: string) {
  const { adoptHomeProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
  const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
    homeServerIdentityId: serverIdentityId, canonicalServerUrl: serverUrl, revision: 1,
    endpoints: [{ kind: 'https', url: serverUrl }] } });
  await setActiveServerId(home.id);
  return home;
}

beforeEach(async () => {
  boundary.execute.mockReset();
  boundary.execute.mockImplementation(async (id: string) => id === 'connectedServices.configuration.get'
    ? { ok: true, result: configuration() } : undefined);
  boundary.open.mockClear();
  const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
  const home = await activateSignInHome('https://mcp-signin-hook.test', 'srv_mcp_signin_hook');
  const machine = createMachineFixture({ id: 'm1', active: true, activeAt: Date.now() });
  getStorage().setState({
    settingsScope: { serverId: home.id, accountId: 'account' },
    profileScope: { serverId: home.id, accountId: 'account' },
    machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] },
    machineListStatusByServerId: { [home.id]: 'idle' },
    settings: { ...getStorage().getState().settings, machineAdministrationTargetsLocalV1: {
      'mcpServers.settings': { serverIdentityId: home.serverIdentityId!, machineId: machine.id },
    } },
  });
  setGrants([]);
});
afterEach(async () => {
  await standardCleanup();
});

describe('useMcpServerSignIn', () => {
  it('signs out through the saved second Administration Machine rather than presentation order', async () => {
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const home = await activateSignInHome('https://mcp-signout-target.test', 'srv_mcp_signout_target');
    const scope = { serverId: home.id, accountId: 'account' };
    const machines = ['m1', 'saved-second'].map(id => createMachineFixture({ id, active: true, activeAt: Date.now() }));
    getStorage().setState({ settingsScope: scope, profileScope: scope,
      machines: Object.fromEntries(machines.map(m => [m.id, m])), machineListByServerId: { [home.id]: machines },
      machineListStatusByServerId: { [home.id]: 'idle' }, settings: { ...getStorage().getState().settings,
        machineAdministrationTargetsLocalV1: { 'mcpServers.settings': { serverIdentityId: home.serverIdentityId!, machineId: 'saved-second' } } } });
    setGrants([grant('connected', 1)]);
    boundary.execute.mockImplementation(async (id: string) => id === 'connectedServices.configuration.get'
      ? { ok: true, result: configuration() }
      : { ok: true, result: CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.revoke'].parse({
        status: 'revoked', account: grant('connected', 1).ref, remoteStatus: 'remoteUnsupported', metadataCleanup: { status: 'complete' },
      }) });
    const hook = await renderHook(() => useMcpServerSignIn(server,
      machines.map(m => ({ machineId: m.id, name: m.id, online: true })), { scope }));
    await act(async () => { expect(await hook.getCurrent().signOut()).toBe(true); });
    expect(boundary.execute.mock.calls.filter(([id]) => id === 'connectedServices.accounts.revoke').map(([, input]) => input.machineId)).toEqual(['saved-second']);
    expect(hook.getCurrent().view?.state).toBe('revoked');
  });

  it('passes the supplied app through the same Action and retains a typed editable client failure', async () => {
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const client = { clientId: 'person-app', clientSecret: crypto.randomUUID() };
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    await act(async () => { await hook.getCurrent().start({ client }); });
    expect(boundary.execute.mock.calls[0]?.[0]).toBe('mcp.servers.signIn.start');
    expect(JSON.stringify(boundary.execute.mock.calls[0]?.[1]) === JSON.stringify({ serverId: server.id, client })).toBe(true);
    boundary.execute.mockResolvedValueOnce({ ok: true, result: { status: 'rejected', attemptId: started.attemptId,
      code: 'invalid_client', diagnostic: { code: 'invalid_client', severity: 'error' } } });
    await act(async () => { await hook.getCurrent().complete({ code: 'code', state: 'attempt-1.n' }); });
    expect(hook.getCurrent().view).toEqual({ state: 'invalid_client' });
  });
  it('retains the originating Session through the existing external-connect return owner', async () => {
    const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
    const home = await upsertServerProfile({ name: 'Sign-in Home', serverUrl: 'https://mcp-signin-return.test' });
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const hook = await renderHook(() => useMcpServerSignIn(server, online, { returnTo: '/session/session-1?capabilities=open', scope: { serverId: home.id, accountId: 'account' } }));
    await act(async () => { await hook.getCurrent().start(); });
    expect(await TokenStorage.getPendingExternalConnect()).toMatchObject({
      provider: 'mcp:attempt-1', serverId: home.id, returnTo: '/session/session-1?capabilities=open',
    });
    expect(hook.getCurrent().fact).toEqual({ state: 'signing' });
    await TokenStorage.clearPendingExternalConnect();
  });
  it('loads safe grant configuration and drives the real scope recovery Action', async () => {
    setGrants([grant('connected', 1)]);
    boundary.execute.mockImplementation(async (id: string) => id === 'connectedServices.configuration.get'
      ? { ok: true, result: configuration(undefined, ['admin']) }
      : { ok: true, result: started });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    expect(hook.getCurrent().view).toEqual({ state: 'needs_more_access', scope: 'admin' });
    await act(async () => { await hook.getCurrent().start({ stepUp: true }); });
    expect(boundary.execute).toHaveBeenCalledWith('mcp.servers.signIn.start', { serverId: server.id, stepUp: true });
    expect(hook.getCurrent().view?.state).toBe('signing');
  });

  it('a live address edit cannot retain Connected for the old resource', async () => {
    setGrants([grant('connected', 1)]);
    const hook = await renderHook((current: McpServerCatalogEntryV1) => useMcpServerSignIn(current, online), { initialProps: server });
    expect(hook.getCurrent().view?.state).toBe('connected');
    await hook.rerender({ ...server, remote: { ...server.remote!, url: 'https://new.example/mcp' } });
    expect(hook.getCurrent().view).toEqual({ state: 'expired', reason: 'address_changed' });
    expect(hook.getCurrent().fact).toEqual({ state: 'expired', reason: 'address_changed' });
  });

  it('shows typed sign-out as Revoked, then a new grant clears it', async () => {
    setGrants([grant('connected', 1)]);
    boundary.execute.mockImplementation(async (id: string) => id === 'connectedServices.configuration.get'
      ? { ok: true, result: configuration() }
      : { ok: true, result: CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.revoke'].parse({
        status: 'revoked', account: grant('connected', 1).ref, remoteStatus: 'remoteUnsupported',
        metadataCleanup: { status: 'cleanup-pending', reason: 'connected_metadata_cleanup_pending' },
      }) });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    await act(async () => { expect(await hook.getCurrent().signOut()).toBe(true); });
    expect(hook.getCurrent().view).toEqual({ state: 'revoked' });
    await act(async () => { setGrants([]); });
    expect(hook.getCurrent().view).toEqual({ state: 'revoked' });
    await act(async () => { setGrants([grant('connected', 2)]); });
    expect(hook.getCurrent().view?.state).toBe('connected');
  });
  it('does not carry a revoke receipt to a different Account with the same server id', async () => {
    setGrants([grant('connected', 1)]);
    boundary.execute.mockImplementation(async (id: string) => id === 'connectedServices.configuration.get'
      ? { ok: true, result: configuration() }
      : { ok: true, result: CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.revoke'].parse({
        status: 'revoked', account: grant('connected', 1).ref, remoteStatus: 'remoteUnsupported',
        metadataCleanup: { status: 'complete' },
      }) });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    await act(async () => { expect(await hook.getCurrent().signOut()).toBe(true); });
    expect(hook.getCurrent().view?.state).toBe('revoked');
    await act(async () => {
      const other = await activateSignInHome('https://mcp-signin-other.test', 'srv_mcp_signin_other');
      getStorage().setState({
        settingsScope: { serverId: other.id, accountId: 'other-account' },
        profileScope: { serverId: other.id, accountId: 'other-account' },
        machineListByServerId: { [other.id]: Object.values(getStorage().getState().machines) },
        machineListStatusByServerId: { [other.id]: 'idle' },
        settings: { ...getStorage().getState().settings, machineAdministrationTargetsLocalV1: {
          'mcpServers.settings': { serverIdentityId: other.serverIdentityId!, machineId: 'm1' },
        } },
      });
    });
    expect(hook.getCurrent().view?.state).toBe('connected');
  });
  it('signs in: opens the browser, waits, and becomes Connected when the grant lands', async () => {
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    expect(hook.getCurrent().view).toEqual({ state: 'not_connected' });
    await act(async () => {
      await hook.getCurrent().start();
    });
    expect(boundary.execute).toHaveBeenCalledWith('mcp.servers.signIn.start', {
      serverId: 'linear',
    });
    expect(boundary.open).toHaveBeenCalledWith(started.authorizationUrl);
    expect(hook.getCurrent().view).toMatchObject({
      state: 'signing',
      authorizationUrl: started.authorizationUrl,
    });
    expect(hook.getCurrent().fact).toEqual({ state: 'signing' });
    await act(async () => {
      setGrants([grant('connected', 1)]);
    });
    expect(hook.getCurrent().view).toEqual({
      state: 'connected',
      identity: 'leeroy@acme.dev',
      scopes: ['read', 'write'],
      lastUsedAt: null,
    });
  });

  it('a pasted answer addresses the existing attempt; a refusal says it did not finish', async () => {
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    await act(async () => {
      await hook.getCurrent().start();
    });
    boundary.execute.mockResolvedValueOnce({
      ok: true,
      result: {
        status: 'rejected',
        attemptId: 'attempt-1',
        code: 'invalid_grant',
      },
    });
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await hook
        .getCurrent()
        .complete({
          code: 'c',
          state: 'attempt-1.n',
          iss: 'https://linear.app',
        });
    });
    expect(boundary.execute).toHaveBeenLastCalledWith(
      'connectedServices.authentication.completeOAuth',
      {
        attemptId: 'attempt-1',
        completion: expect.objectContaining({
          code: 'c',
          iss: 'https://linear.app',
        }),
      },
      expect.anything(),
    );
    expect(accepted).toBe(false);
    expect(hook.getCurrent().view).toEqual({ state: 'did_not_finish', diagnosticCode: 'invalid_grant' });
  });

  it('accepts a connected grant after the completion response failed to arrive', async () => {
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    await act(async () => { await hook.getCurrent().start(); });
    boundary.execute.mockRejectedValueOnce(new Error('response lost'));
    await act(async () => {
      expect(await hook.getCurrent().complete({ code: 'c', state: 'attempt-1.n' })).toBe(false);
    });
    expect(hook.getCurrent().view?.state).toBe('did_not_finish');
    await act(async () => { setGrants([grant('connected', 1)]); });
    expect(hook.getCurrent().view?.state).toBe('connected');
  });

  it('submits an OAuth answer once when callback and paste arrive before the next render', async () => {
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    await act(async () => { await hook.getCurrent().start(); });
    const response = createDeferred<unknown>();
    const completions: unknown[] = [];
    boundary.execute.mockImplementation(async (id: string, input: unknown) => {
      if (id === 'connectedServices.authentication.completeOAuth') {
        completions.push(input);
        return response.promise;
      }
      return { ok: true, result: configuration() };
    });
    let first: Promise<boolean>;
    let duplicate: Promise<boolean>;
    await act(async () => {
      const complete = hook.getCurrent().complete;
      first = complete({ code: 'c', state: 'attempt-1.n' });
      duplicate = complete({ code: 'c', state: 'attempt-1.n' });
    });
    expect(completions).toHaveLength(1);
    await act(async () => {
      setGrants([grant('connected', 1)]);
      response.resolve({ ok: true, result: { status: 'connected', attemptId: started.attemptId, account: grant('connected', 1).ref } });
      expect(await Promise.all([first!, duplicate!])).toEqual([true, false]);
    });
    expect(hook.getCurrent().view?.state).toBe('connected');
  });

  it('keeps Connected when a late completion refusal follows the synced grant', async () => {
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    await act(async () => { await hook.getCurrent().start(); });
    const response = createDeferred<unknown>();
    boundary.execute.mockImplementation(async (id: string) => id === 'connectedServices.authentication.completeOAuth'
      ? response.promise : { ok: true, result: configuration() });
    let completing: Promise<boolean>;
    await act(async () => { completing = hook.getCurrent().complete({ code: 'c', state: 'attempt-1.n' }); });
    await act(async () => { setGrants([grant('connected', 1)]); });
    expect(hook.getCurrent().view?.state).toBe('connected');
    await act(async () => {
      response.resolve({ ok: true, result: { status: 'rejected', attemptId: started.attemptId, code: 'invalid_grant' } });
      await completing!;
    });
    expect(hook.getCurrent().view?.state).toBe('connected');
  });

  it('does not let an old completion overwrite a replacement attempt on the same server', async () => {
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    await act(async () => { await hook.getCurrent().start(); });
    const response = createDeferred<unknown>();
    const replacement = { ...started, attemptId: 'attempt-2', authorizationUrl: 'https://linear.app/oauth/authorize?state=attempt-2.n' };
    boundary.execute.mockImplementation(async (id: string) => id === 'connectedServices.authentication.completeOAuth'
      ? response.promise : { ok: true, result: replacement });
    let completing: Promise<boolean>;
    await act(async () => { completing = hook.getCurrent().complete({ code: 'c', state: 'attempt-1.n' }); });
    await act(async () => { await hook.getCurrent().start(); });
    expect(hook.getCurrent().view).toMatchObject({ state: 'signing', authorizationUrl: replacement.authorizationUrl });
    await act(async () => {
      response.resolve({ ok: true, result: { status: 'rejected', attemptId: started.attemptId, code: 'invalid_grant' } });
      await completing!;
    });
    expect(hook.getCurrent().view).toMatchObject({ state: 'signing', authorizationUrl: replacement.authorizationUrl });
  });

  it('ignores an old callback answer while a replacement attempt is waiting', async () => {
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    await act(async () => { await hook.getCurrent().start(); });
    const replacement = { ...started, attemptId: 'attempt-2', authorizationUrl: 'https://linear.app/oauth/authorize?state=attempt-2.n' };
    boundary.execute.mockResolvedValueOnce({ ok: true, result: replacement });
    await act(async () => { await hook.getCurrent().start(); });
    boundary.execute.mockResolvedValueOnce({ ok: true, result: { status: 'rejected', attemptId: replacement.attemptId, code: 'invalid_grant' } });
    await act(async () => {
      expect(await hook.getCurrent().complete({ code: 'old', state: 'attempt-1.n' })).toBe(false);
    });
    expect(hook.getCurrent().view).toMatchObject({ state: 'signing', authorizationUrl: replacement.authorizationUrl });
  });

  it.each(['account', 'server'] as const)('retires completion callbacks when the %s changes, even after returning', async (target) => {
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const scope = { serverId: 'home', accountId: 'account' };
    const hook = await renderHook((props: { server: McpServerCatalogEntryV1; scope: typeof scope }) =>
      useMcpServerSignIn(props.server, online, { scope: props.scope }), { initialProps: { server, scope } });
    await act(async () => { await hook.getCurrent().start(); });
    const response = createDeferred<unknown>();
    boundary.execute.mockImplementation(async (id: string) => id === 'connectedServices.authentication.completeOAuth'
      ? response.promise : { ok: true, result: configuration() });
    let completing: Promise<boolean>;
    await act(async () => { completing = hook.getCurrent().complete({ code: 'c', state: 'attempt-1.n' }); });
    await hook.rerender({ server: target === 'server' ? { ...server, id: 'other-server' } : server,
      scope: target === 'account' ? { ...scope, accountId: 'other-account' } : scope });
    expect(hook.getCurrent().view?.state).toBe('not_connected');
    await hook.rerender({ server, scope });
    expect(hook.getCurrent().view?.state).toBe('not_connected');
    await act(async () => {
      response.resolve({ ok: true, result: { status: 'rejected', attemptId: started.attemptId, code: 'invalid_grant' } });
      await completing!;
    });
    expect(hook.getCurrent().view?.state).toBe('not_connected');
  });

  it('does not reopen a superseded authorization link when an earlier start settles last', async () => {
    const response = createDeferred<unknown>();
    boundary.execute.mockReturnValueOnce(response.promise);
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    let first: Promise<void>;
    await act(async () => { first = hook.getCurrent().start(); });
    const replacement = { ...started, attemptId: 'attempt-2', authorizationUrl: 'https://linear.app/oauth/authorize?state=attempt-2.n' };
    boundary.execute.mockResolvedValueOnce({ ok: true, result: replacement });
    await act(async () => { await hook.getCurrent().start(); });
    await act(async () => {
      response.resolve({ ok: true, result: started });
      await first!;
    });
    expect(hook.getCurrent().view).toMatchObject({ state: 'signing', authorizationUrl: replacement.authorizationUrl });
    expect(boundary.open).toHaveBeenCalledTimes(1);
    expect(boundary.open).toHaveBeenCalledWith(replacement.authorizationUrl);
  });

  it('cancel addresses the existing attempt and returns to Not connected', async () => {
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    await act(async () => {
      await hook.getCurrent().start();
    });
    boundary.execute.mockResolvedValueOnce({
      ok: true,
      result: { status: 'cancelled', attemptId: 'attempt-1' },
    });
    await act(async () => {
      await hook.getCurrent().cancel();
    });
    expect(boundary.execute).toHaveBeenLastCalledWith(
      'connectedServices.authentication.cancel',
      { attemptId: 'attempt-1' },
      expect.anything(),
    );
    expect(hook.getCurrent().view).toEqual({ state: 'not_connected' });
  });

  it('no machine online is said (and disables Sign in); an explicit retry still asks', async () => {
    const hook = await renderHook(() => useMcpServerSignIn(server, offline));
    expect(hook.getCurrent().view).toEqual({ state: 'no_machine_online' });
    boundary.execute.mockResolvedValueOnce({
      ok: false,
      errorCode: 'no_machine_online',
      error: 'no_machine_online',
    });
    await act(async () => {
      await hook.getCurrent().start();
    });
    expect(boundary.execute).toHaveBeenCalledWith('mcp.servers.signIn.start', {
      serverId: 'linear',
    });
    expect(hook.getCurrent().view).toEqual({ state: 'no_machine_online' });
  });

  it('reads expired and refused sign-ins, and a server without OAuth never speaks', async () => {
    setGrants([grant('needs_reauth', 1)]);
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    expect(hook.getCurrent().view).toEqual({
      state: 'expired',
      reason: 'expired',
    });
    boundary.execute.mockResolvedValueOnce({
      ok: false,
      errorCode: 'client_refused',
      error: 'client_refused',
    });
    await act(async () => {
      await hook.getCurrent().start();
    });
    expect(hook.getCurrent().view).toEqual({ state: 'client_refused' });
    const local = await renderHook(() =>
      useMcpServerSignIn(
        { ...server, transport: 'stdio', remote: undefined } as never,
        online,
      ),
    );
    expect(local.getCurrent().view).toBeNull();
    expect(local.getCurrent().fact).toBeNull();
  });
});

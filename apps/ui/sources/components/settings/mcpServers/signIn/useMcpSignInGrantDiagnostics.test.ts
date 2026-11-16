import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, ConnectedAccountControlCommandRequestSchema, ConnectedAccountDaemonControlResponseSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createMachineFixture, createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);

const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
const { useMcpServerSignIn } = await import('./useMcpServerSignIn');
const { useMcpSignInGrantDiagnostics } = await import('./useMcpSignInGrantDiagnostics');
const server = McpServerCatalogEntryV1Schema.parse({ id: 'linear', name: 'linear', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
  remote: { url: 'https://mcp.linear.app/mcp', headers: {}, auth: { kind: 'oauth' } } });
const machines = [{ machineId: 'm1', name: 'Machine', online: true }];
const savedGrant = (accountId: string, configurationRevision = 'configuration-1', credential = 'a') => QualifiedConnectedAccountProfileV4Schema.parse({
  ref: { service: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1, accountId }, status: 'connected', authenticationModeId: 'oauth',
  configurationReady: true, configurationRevision, revisionSemantics: 'revisioned', credentialRevision: `csr_${credential.repeat(22)}`, scopes: ['read'],
});
const profile = () => AccountProfileSchema.parse({ id: 'diagnostics-account', connectedAccountsV4: [savedGrant('linear'), savedGrant('other'), savedGrant('third')] });
type Reply = ReturnType<typeof ConnectedAccountDaemonControlResponseSchema.parse>;

describe('MCP grant diagnostics demand through the real Action owner', () => {
  let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
  let disposeActionLoader: (() => void) | undefined;
  let reads: string[];
  let reply: (id: string) => Promise<Reply>;
  let remoteGrants: ReturnType<typeof savedGrant>[];
  const configuration = (id: string): Reply => {
    const grant = remoteGrants.find(grant => grant.ref.accountId === id);
    if (!grant) throw new Error('Missing grant fixture');
    return ConnectedAccountDaemonControlResponseSchema.parse({ status: 'configuration', occurrenceId: 'host-1', sourceCustody: { kind: 'host' },
      target: { kind: 'account', account: grant.ref, modeId: 'oauth' },
      mode: { id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'https://cloud.happier.dev/oauth/mcp/callback', pkce: 'required', outcomeReconciliation: 'none' },
      configuration: { status: 'ready', revision: grant.configurationRevision,
        values: { serverId: id, resource: id === 'linear' ? server.remote!.url : `https://${id}.example/mcp` }, configuredSecretFieldIds: [], missingFieldIds: [] },
    });
  };
  const setGrants = (grants: ReturnType<typeof savedGrant>[]) => {
    remoteGrants = grants;
    storage.setState({ profile: { ...storage.getState().profile, connectedAccountsV4: grants } });
  };

  beforeEach(async () => {
    disposeActionLoader = await installRealActionExecutorModuleLoader();
    reads = [];
    remoteGrants = [savedGrant('linear'), savedGrant('other'), savedGrant('third')];
    reply = async id => configuration(id);
    const http = createHomeHubArtifactHttpBoundary('diagnostics-account', () =>
      AccountProfileSchema.parse({ id: 'diagnostics-account', connectedAccountsV4: remoteGrants }));
    account = await restoreServerAccountForTest({ accountId: 'diagnostics-account', serverUrl: 'https://mcp-diagnostics.test',
      request: async (input, init) => createPlainMachineReadHttpResponseFixture(new URL(String(input)).pathname, init, 'diagnostics-account') ?? http.request(input, init),
      configureSocket: socket => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
          if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
          expect(payload.method).toBe(`m1:${CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD}`);
          const content = { mode: 'plain' } as const;
          const request = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
          const { command } = ConnectedAccountControlCommandRequestSchema.parse(request.params);
          if (command.operation !== 'readConfiguration' || command.target.kind !== 'account') throw new Error('Unexpected daemon command');
          const id = command.target.account.accountId;
          reads.push(id);
          return { ok: true, result: await socketRpcCodec.encodeResponse(content, await reply(id), request.callId) };
        });
      },
    });
    const { sync } = await import('@/sync/sync');
    await sync.refreshProfile();
    const scope = { serverId: account.home.id, accountId: 'diagnostics-account' };
    const machine = createMachineFixture({ id: 'm1', active: true, activeAt: Date.now(),
      access: { custodian: { accountId: scope.accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
    storage.setState({ profileScope: scope, settingsScope: scope, profile: profile(),
      machines: { m1: machine }, machineListByServerId: { [account.home.id]: [machine] },
      machineListStatusByServerId: { [account.home.id]: 'idle' },
      settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: {} },
    });
    observeMachinePresenceForTest(scope, [machine.id]);
  });
  afterEach(async () => {
    await standardCleanup();
    const [{ serverScopedRpcSocketPool }, { resetScopedMachineTransportCacheForTests }] = await Promise.all([
      import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool'),
      import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool'),
    ]);
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    await account?.dispose();
    disposeActionLoader?.();
    disposeActionLoader = undefined;
    vi.restoreAllMocks();
  });

  it.each(['none', 'stdio', 'oauth'] as const)('reads only the selected OAuth grant for %s demand', async target => {
    const selected = target === 'none' ? null : target === 'stdio'
      ? McpServerCatalogEntryV1Schema.parse({ ...server, transport: 'stdio', remote: undefined, stdio: { command: 'mcp', args: [] } }) : server;
    const hook = await renderHook(() => useMcpServerSignIn(selected, machines));
    if (target === 'oauth') await vi.waitFor(() => expect(hook.getCurrent().view?.state).toBe('connected'));
    expect(reads).toEqual(target === 'oauth' ? ['linear'] : []);
  });

  // The grants' diagnostics read through one administration Machine. On a busy Account every other Machine publishes
  // daemon state all day; none of it changes which Machine answers, so none of it redraws the consumer.
  it('does not redraw while other Machines publish', async () => {
    const scope = { serverId: account.home.id, accountId: 'diagnostics-account' };
    let renders = 0;
    const hook = await renderHook(() => { renders += 1; return useMcpSignInGrantDiagnostics(profile().connectedAccountsV4, scope); });
    await vi.waitFor(() => expect(Object.keys(hook.getCurrent())).toHaveLength(3));
    const settled = renders;
    const answered = hook.getCurrent();
    const others = Array.from({ length: 3 }, (_, index) => createMachineFixture({ id: `other-${index}`, active: true, activeAt: Date.now() }));
    for (const [index, other] of others.entries()) {
      await act(async () => storage.getState().applyMachines([{ ...other, metadataVersion: other.metadataVersion + index }], false,
        { sourceServerId: account.home.id, sourceAccountId: scope.accountId }));
    }
    expect(renders - settled).toBe(0);
    expect(hook.getCurrent()).toBe(answered);
  });

  it('does not reread the target on an unrelated grant revision; invalidates both selected revisions', async () => {
    const hook = await renderHook(() => useMcpServerSignIn(server, machines));
    await vi.waitFor(() => expect(hook.getCurrent().view?.state).toBe('connected'));
    await act(async () => setGrants([savedGrant('linear'), savedGrant('other', 'configuration-2'), savedGrant('third')]));
    expect(reads).toEqual(['linear']);
    for (const grant of [savedGrant('linear', 'configuration-2'), savedGrant('linear', 'configuration-2', 'b')]) {
      await act(async () => setGrants([grant, savedGrant('other'), savedGrant('third')]));
      await vi.waitFor(() => expect(hook.getCurrent().view?.state).toBe('connected'));
    }
    expect(reads).toEqual(['linear', 'linear', 'linear']);
  });

  it('shares an in-flight grant with aggregate demand after its first borrower unmounts', async () => {
    const pending = createDeferred<Reply>();
    reply = async id => id === 'linear' ? pending.promise : configuration(id);
    const scope = storage.getState().profileScope!;
    const selected = await renderHook(() => useMcpSignInGrantDiagnostics([remoteGrants[0]!], scope));
    await vi.waitFor(() => expect(reads).toEqual(['linear']));
    const aggregate = await renderHook(() => useMcpSignInGrantDiagnostics(storage.getState().profile.connectedAccountsV4, scope));
    await vi.waitFor(() => expect(reads.filter(id => id !== 'linear').sort()).toEqual(['other', 'third']));
    expect(reads.filter(id => id === 'linear')).toHaveLength(1);
    await selected.unmount();
    await act(async () => pending.resolve(configuration('linear')));
    await vi.waitFor(() => expect(aggregate.getCurrent().linear?.configuration?.configuration.status).toBe('ready'));
  });

  it('does not join an older pending configuration after either grant revision changes', async () => {
    const pending = createDeferred<Reply>();
    const stale = configuration('linear');
    reply = async () => pending.promise;
    const scope = storage.getState().profileScope!;
    const incumbent = await renderHook(() => useMcpSignInGrantDiagnostics([savedGrant('linear')], scope));
    await vi.waitFor(() => expect(reads).toEqual(['linear']));
    for (const grant of [savedGrant('linear', 'configuration-2'), savedGrant('linear', 'configuration-2', 'b')]) {
      await act(async () => setGrants([grant, savedGrant('other'), savedGrant('third')]));
      reply = async id => configuration(id);
      const next = await renderHook(() => useMcpSignInGrantDiagnostics([grant], scope));
      await vi.waitFor(() => expect(next.getCurrent().linear?.configuration?.configuration.revision).toBe('configuration-2'));
    }
    expect(reads).toEqual(['linear', 'linear', 'linear']);
    await act(async () => pending.resolve(stale));
    await vi.waitFor(() => expect(incumbent.getCurrent().linear?.configuration?.configuration.revision).toBe('configuration-1'));
  });

  it('does not share when the scoped profile cannot witness grant revisions', async () => {
    const pending = createDeferred<Reply>();
    reply = async () => pending.promise;
    const scope = storage.getState().profileScope!;
    const completed = configuration('linear');
    // A real profile refresh must keep the missing-revision fixture missing too.
    setGrants([]);
    const grants = [savedGrant('linear')];
    const first = await renderHook(() => useMcpSignInGrantDiagnostics(grants, scope));
    const second = await renderHook(() => useMcpSignInGrantDiagnostics(grants, scope));
    await vi.waitFor(() => expect(reads).toEqual(['linear', 'linear']));
    await act(async () => pending.resolve(completed));
    await vi.waitFor(() => expect(first.getCurrent().linear?.configuration).toBeDefined());
    expect(second.getCurrent().linear?.configuration).toBeDefined();
  });

  it('retries a failed read on the next demand without retaining the failure', async () => {
    reply = async () => { throw new Error('Daemon unavailable'); };
    const first = await renderHook(() => useMcpServerSignIn(server, machines));
    await vi.waitFor(() => expect(first.getCurrent().view?.state).toBe('did_not_finish'));
    expect(reads).toEqual(['linear']);
    await first.unmount();
    reply = async id => configuration(id);
    const next = await renderHook(() => useMcpServerSignIn(server, machines));
    await vi.waitFor(() => expect(next.getCurrent().view?.state).toBe('connected'));
    expect(reads).toEqual(['linear', 'linear']);
  });
});

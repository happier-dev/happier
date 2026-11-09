import { expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { ConnectedServiceAuthGroupPolicyV2Schema, ConnectedServiceCredentialRevisionV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { createUiConnectedServiceAction } from './connectedServiceActionDeps';
import type { LazyActionAccountContext } from './actionAccountContext';
import * as machineRpc from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ConnectedAccountCatalogRowMutationV1Schema, ConnectedPurposeCatalogV1Schema, type ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, ConnectedAccountAuthenticationCommandRequestSchema, CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, ConnectedAccountControlCommandRequestSchema, ConnectedAccountRevokeResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { storage } from '@/sync/domains/state/storage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getConnectedAccountCatalogValue } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetScopedMachineTransportCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';

// This suite imports scoped transport eagerly. The external SDK boundary must
// be installed before that owner captures the factory, not after Account setup.
vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

/**
 * A captured Action Account retires on a credential replacement for its Home (af4706f44d), not on a
 * focused display-scope change. Sign the same Home in as its successor the way sign-in does.
 */
async function signInSuccessor(home: Readonly<{ id: string; serverUrl: string }>): Promise<void> {
    storage.setState({ profileScope: { serverId: home.id, accountId: 'successor' }, profile: AccountProfileSchema.parse({ id: 'successor' }) });
    expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id },
        { token: `e30.${Buffer.from(JSON.stringify({ sub: 'successor' })).toString('base64url')}.signature` })).toBe(true);
}

it.each(['retired-before-issue', 'cancelled-before-issue', 'retired-after-ack', 'cancelled-after-ack'] as const)(
    'keeps reset-credit custody at actual issuance while preserving an acknowledged receipt (%s)', async disposition => {
        const bridge = await loadSyncSingletonForTests();
        const previous = storage.getState();
        let setupReady!: () => void;
        const ready = new Promise<void>(resolve => { setupReady = resolve; });
        let releaseSetup!: () => void;
        const setup = new Promise<void>(resolve => { releaseSetup = resolve; });
        const http = createHomeHubArtifactHttpBoundary('reset-custody');
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://reset-custody.test', accountId: 'reset-custody', request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/machines/controller' || (path === '/v1/machines/read-batch' && init?.method === 'POST')) {
                setupReady();
                await setup;
                const machine = createPlainMachineRowFixture({ id: 'controller', accountId: 'reset-custody' });
                return path === '/v1/machines/read-batch'
                    ? createMachineReadBatchResponseFixture(init?.body, id => id === machine.id ? machine : null)
                    : Response.json({ machine });
            }
            return http.request(input, init);
        } });
        const scope = { serverId: connection.home.id, accountId: 'reset-custody' };
        storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }), isDataReady: true });
        storage.getState().applyMachines([createMachineFixture({ id: 'controller', activeAt: Date.now() })], true, { sourceServerId: scope.serverId });
        const controller = new AbortController();
        const account = await captureLazyActionAccountContext(scope.serverId, controller.signal);
        let retirement: Promise<void> | undefined;
        const retire = () => {
            if (disposition.startsWith('cancelled')) controller.abort();
            else retirement = signInSuccessor(connection.home);
            return retirement;
        };
        let issued = false;
        const receipt = { ok: true, receipt: { idempotencyKey: 'acknowledged-reset', status: 'consumed' }, snapshot: null };
        // Exact Account custody uses a scoped socket. Hold its HTTP machine admission;
        // transport acquisition, issuance guards, the ACK codec and settlement stay real.
        installDisconnectedServerSocketBoundary(socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
                if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
                if (!payload || typeof payload !== 'object' || !('method' in payload)
                    || payload.method !== `controller:${RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME}`) {
                    throw new Error('Unexpected scoped reset RPC');
                }
                issued = true;
                return { ok: true, get result() {
                    // callSocketRpc has accepted this ACK before decoding its result.
                    if (disposition.endsWith('after-ack')) retire();
                    return receipt;
                } };
            });
        });
        // The incumbent active-socket edge remains available to expose the pre-fix bypass.
        const rpc = vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async (_machineId, method, _payload, options) => {
            if (method !== RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME) throw new Error(`Unexpected machine RPC ${method}`);
            setupReady();
            await setup;
            options?.signal?.throwIfAborted();
            options?.onIssued?.();
            issued = true;
            if (disposition.endsWith('after-ack')) retire();
            return receipt;
        });
        let operation: Promise<unknown> | undefined;
        try {
            operation = createUiConnectedServiceAction(account)({ actionId: 'connectedServices.quota.reset',
                input: { machineId: 'controller', serviceId: 'openai-codex', profileId: 'work', providerCreditId: 'credit-1', sourceSnapshotFetchedAtMs: 123 },
                context: { surface: 'ui', authority: 'present_user' }, signal: controller.signal,
            });
            await Promise.race([ready, operation.then(result => {
                throw new Error(`Reset settled before socket setup: ${JSON.stringify(result)}`);
            })]);
            if (disposition.endsWith('before-issue')) await retire();
            releaseSetup();
            const result = await operation;
            await retirement;
            if (disposition.endsWith('before-issue')) {
                expect(issued).toBe(false);
                expect(result).toMatchObject({ ok: false, errorCode: 'machine_rpc_failed' });
            } else {
                expect(issued, JSON.stringify(result)).toBe(true);
                expect(result).toEqual(receipt);
            }
        } finally {
            releaseSetup();
            await operation?.catch(() => {});
            await serverScopedRpcSocketPool.stopAll(); resetScopedMachineTransportCacheForTests();
            installDisconnectedServerSocketBoundary();
            rpc.mockRestore(); account.dispose(); storage.setState(previous, true); await connection.dispose(); bridge.dispose();
        }
    },
);

it('routes admitted authentication to the captured Home and refuses retired Account custody at actual issuance', async () => {
    const bridge = await loadSyncSingletonForTests();
    const previous = storage.getState();
    const http = createHomeHubArtifactHttpBoundary('authentication');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://authentication.test', accountId: 'authentication', request: http.request });
    storage.setState({ profileScope: { serverId: connection.home.id, accountId: 'authentication' }, profile: AccountProfileSchema.parse({ id: 'authentication' }) });
    const account = await captureLazyActionAccountContext(connection.home.id);
    const command = { operation: 'submitManual', attemptId: 'attempt-1', fields: { token: 'live-private-token' } };
    let issued = false;
    let retireBeforeIssuance = false;
    const rpc = vi.spyOn(machineRpc, 'machineRpcWithServerScope').mockImplementation(async request => {
        expect(request.serverId).toBe(connection.home.id);
        expect(request.accountId).toBe('authentication');
        expect(request.method).toBe(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD);
        expect(ConnectedAccountAuthenticationCommandRequestSchema.parse(request.payload)).toEqual({ v: 1, machineId: 'controller', command });
        if (retireBeforeIssuance) await signInSuccessor(connection.home);
        request.onIssued?.();
        issued = true;
        return { status: 'awaitingManual', attemptId: 'attempt-1' };
    });
    try {
        const execute = () => createUiConnectedServiceAction(account)({ actionId: 'connectedServices.authentication.submitManual',
            input: { machineId: 'controller', attemptId: 'attempt-1', fields: command.fields }, context: { surface: 'ui', authority: 'present_user' } });
        expect(await execute()).toEqual({ status: 'awaitingManual', attemptId: 'attempt-1' });
        expect(issued).toBe(true);
        issued = false; retireBeforeIssuance = true;
        await expect(execute()).rejects.toThrow();
        expect(issued).toBe(false);
    } finally { rpc.mockRestore(); account.dispose(); storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});

it('retains the native revoke receipt with pending cleanup when the issued purpose-row write acknowledgement is unreadable', async () => {
    const bridge = await loadSyncSingletonForTests();
    const previous = storage.getState();
    const http = createHomeHubArtifactHttpBoundary('native-revoke');
    const selected = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
    // The existing protocol revoke fixture's opaque credential revision, not a Settings/row version.
    const expectedCredentialRevision = ConnectedServiceCredentialRevisionV1Schema.parse('csr_abcdefghijklmnopqrstuv');
    let value = ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [{
        purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'model' },
        target: { kind: 'account', account: selected },
    }] });
    let revision = 1;
    let nativeRevoked = false;
    let issuedCleanup: unknown = null;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://native-revoke.test', accountId: 'native-revoke', request: async (input, init) => {
        if (new URL(String(input)).pathname !== '/v1/account/entity-rows/connected-accounts/purposes') return http.request(input, init);
        if (init?.method !== 'POST') return Response.json({ status: 'present', revision, content: { t: 'plain', v: { key: 'purposes', value } } });
        const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
        if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'purposes') throw new Error('Expected purpose cleanup write');
        expect(nativeRevoked).toBe(true);
        issuedCleanup = mutation;
        value = mutation.content.v.value;
        const response = Response.json({ status: 'updated', revision: ++revision, cursor: revision });
        response.json = async () => { throw new SyntaxError('Unreadable cleanup transport acknowledgement'); };
        return response;
    } });
    storage.setState({ profileScope: { serverId: connection.home.id, accountId: 'native-revoke' }, profile: AccountProfileSchema.parse({ id: 'native-revoke' }) });
    const account = await captureLazyActionAccountContext(connection.home.id);
    // Native RPC and HTTP are genuine boundaries; revoke, custody, reference pruning and codecs remain real.
    const rpc = vi.spyOn(machineRpc, 'machineRpcWithServerScope').mockImplementation(async request => {
        expect(request.method).toBe(CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD);
        expect(request.serverId).toBe(connection.home.id);
        expect(ConnectedAccountControlCommandRequestSchema.parse(request.payload)).toEqual({
            v: 1, machineId: 'controller', command: { operation: 'revokeAccount', account: selected,
                expectedCredentialRevision, cleanupGroupReferences: true },
        });
        nativeRevoked = true;
        return ConnectedAccountRevokeResponseV1Schema.parse({ status: 'revoked', account: selected, remoteStatus: 'remoteRevoked' });
    });
    try {
        const outcome = await createUiConnectedServiceAction(account)({ actionId: 'connectedServices.accounts.revoke',
            input: { machineId: 'controller', account: selected, expectedCredentialRevision, cleanupGroupReferences: true },
            context: { surface: 'ui', authority: 'present_user' },
        }).then(value => ({ status: 'returned', value }), error => ({ status: 'threw', error }));
        expect(nativeRevoked).toBe(true);
        expect(issuedCleanup).toMatchObject({ expectedRevision: 1, content: { t: 'plain', v: { key: 'purposes', value: { bindings: [] } } } });
        expect(value.bindings).toEqual([]);
        expect(outcome).toEqual({ status: 'returned', value: {
            status: 'revoked', account: selected, remoteStatus: 'remoteRevoked',
            metadataCleanup: { status: 'cleanup-pending', reason: 'connected_metadata_cleanup_pending' },
        } });
    } finally { rpc.mockRestore(); account.dispose(); storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});

it.each(['cancelled', 'retired', 'unreadable'] as const)('preserves the default mutation disposition when its captured receipt is %s', async disposition => {
    const bridge = await loadSyncSingletonForTests();
    const previous = storage.getState();
    const accountId = `default-receipt-${disposition}`;
    const http = createHomeHubArtifactHttpBoundary(accountId);
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const controller = new AbortController();
    let value: ConnectedPurposeCatalogV1 = { v: 1, bindings: [] };
    let revision = 1;
    let scope: Readonly<{ serverId: string; accountId: string }>;
    const connection = await restoreServerAccountForTest({ serverUrl: `https://${accountId}.test`, accountId, request: async (input, init) => {
        if (new URL(String(input)).pathname !== '/v1/account/entity-rows/connected-accounts/purposes') return http.request(input, init);
        if (init?.method !== 'POST') return Response.json({ status: 'present', revision, content: { t: 'plain', v: { key: 'purposes', value } } });
        const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
        if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'purposes') throw new Error('Expected purpose catalog write');
        value = mutation.content.v.value; revision += 1;
        const response = Response.json({ status: 'updated', revision, cursor: revision });
        const consume = response.json.bind(response);
        response.json = async () => {
            const receipt: unknown = await consume();
            if (disposition === 'unreadable') throw new SyntaxError('Unreadable transport acknowledgement');
            if (disposition === 'cancelled') controller.abort();
            else await signInSuccessor(connection.home);
            return receipt;
        };
        return response;
    } });
    scope = { serverId: connection.home.id, accountId };
    storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }) });
    const account = await captureLazyActionAccountContext(connection.home.id, controller.signal);
    // Machine RPC and HTTP are the only substituted boundaries. Agent resolution,
    // captured Account loading, row codecs, Action intent and settlement are real.
    const rpc = vi.spyOn(machineRpc, 'machineRpcWithServerScope').mockResolvedValue({ protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        agentsById: { codex: { id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, isBuiltIn: true,
            connectedAccounts: [{ purpose: 'model', service }], providerOwnedEnvironmentKeys: [] } },
    }) });
    try {
        const result = await createUiConnectedServiceAction(account)({ actionId: 'connectedServices.accounts.default.set',
            input: { account: { service, accountId: 'work' }, agentId: 'codex', machineId: 'machine', makeDefault: true },
            context: { surface: 'ui', authority: 'present_user' }, signal: controller.signal,
        });
        expect(result).toEqual(disposition === 'unreadable'
            ? { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }
            : { applied: true });
        expect(value.bindings[0]?.target).toEqual({ kind: 'account', account: { service, accountId: 'work' } });
        if (disposition === 'retired') {
            expect(account.accountOnlyLifetime.isCurrent()).toBe(false);
            expect(getConnectedAccountCatalogValue(scope, 'purposes').value?.bindings ?? []).toEqual([]);
            expect(getConnectedAccountCatalogValue({ ...scope, accountId: 'successor' }, 'purposes').value).toBeNull();
        }
    } finally { rpc.mockRestore(); account.dispose(); storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});

it.each([
    ['acknowledged conflict', 'connect_group_generation_conflict'],
    ['pre-dispatch loss', 'action_failed'],
    ['post-dispatch loss', 'outcome_unknown'],
    ['unreadable acknowledgement', 'outcome_unknown'],
    ['post-commit internal error', 'outcome_unknown'],
    ['pre-dispatch read internal error', 'Internal Server Error'],
    ['pre-dispatch read loss', 'connect_group_read_failed'],
] as const)('preserves the %s disposition of a semantic pool move', async (disposition, errorCode) => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'work' }, incarnation: 'life', displayName: null,
        policy: ConnectedServiceAuthGroupPolicyV2Schema.parse({}), activeConnectedAccountId: null, generation: 2, runtimeStateRevision: 1,
        state: {}, createdAt: 0, updatedAt: 0, members: [
            { v: 1, connectedAccountId: 'personal', priority: 100, enabled: true, state: {}, createdAt: 0, updatedAt: 0 },
            { v: 1, connectedAccountId: 'work', priority: 200, enabled: true, state: {}, createdAt: 0, updatedAt: 0 },
        ],
    });
    // The authenticated HTTP adapter is the only substituted boundary; parsing,
    // anchored order, CAS request production and Action settlement stay real.
    const account = {
        credentials: { token: 'transport-boundary' }, assertCurrent() {},
        async request(_path: string, init: RequestInit, options?: Readonly<{ onIssued?: () => void }>) {
            if (init.method === 'GET' && disposition === 'pre-dispatch read loss') throw new TypeError('Failed to fetch');
            if (init.method === 'GET') return disposition === 'pre-dispatch read internal error'
                ? Response.json({ error: 'Internal Server Error', message: 'An unexpected error occurred', statusCode: 500 }, { status: 500 })
                : Response.json({ group });
            if (disposition !== 'pre-dispatch loss') options?.onIssued?.();
            if (disposition === 'acknowledged conflict') return Response.json({ error: 'connect_group_generation_conflict', generation: 3 }, { status: 409 });
            // The server can commit the member transaction, then fail its
            // awaited Home-settings response projection and emit this 500 envelope.
            if (disposition === 'post-commit internal error') return Response.json({ error: 'Internal Server Error', message: 'An unexpected error occurred', statusCode: 500 }, { status: 500 });
            if (disposition === 'unreadable acknowledgement') return new Response('unreadable', { status: 200 });
            throw new TypeError('Network request failed');
        },
    } as unknown as LazyActionAccountContext;
    const executor = createActionExecutor({ connectedServiceAction: createUiConnectedServiceAction(account) } as unknown as ActionExecutorDeps);
    expect(await executor.execute('connectedServices.pools.reorder', {
        group: group.ref, move: { accountId: 'work', position: { anchorId: 'personal', placement: 'before' } },
    }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } })).toMatchObject({ ok: false, errorCode });
});

it('admits quota refresh through the exact Home machine before requesting the selected account refresh', async () => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const accountRef = { service, accountId: 'work-account' };
    const requests: unknown[] = [];
    const rpc = vi.spyOn(machineRpc, 'machineRpcWithServerScope').mockResolvedValue({
        status: 'described', service,
        descriptor: { id: 'openai-codex', title: 'Codex', authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'none' }] } },
        occurrenceId: 'occurrence-1', sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-1' } },
        accounts: [], operationTransport: { kind: 'v4' },
    });
    // Only HTTP and machine RPC transports are substituted; service admission remains real.
    const account = { serverId: 'work-home', credentials: { token: 'boundary-token' }, assertCurrent() {},
        async request(path: string, init: RequestInit) { requests.push({ path, method: init.method, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ success: true }), { status: 200 }); },
    } as unknown as LazyActionAccountContext;
    try {
        const action = createUiConnectedServiceAction(account);
        const args = { actionId: 'connectedServices.quota.refresh' as const, input: { account: accountRef, machineId: 'work-machine' }, context: { surface: 'ui' as const, authority: 'present_user' as const } };
        expect(await action(args)).toEqual({ applied: true });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'work-home', machineId: 'work-machine',
            payload: { v: 1, machineId: 'work-machine', command: { operation: 'describeService', service, requiredOperation: 'quota_refresh' } } }));
        expect(requests).toEqual([{ path: '/v4/connect/qualified/quotas/refresh', method: 'POST', body: { ref: accountRef } }]);
        rpc.mockResolvedValue({ status: 'unavailable', code: 'quota_refresh_unavailable' });
        expect(await action(args)).toMatchObject({ ok: false, errorCode: 'quota_refresh_unavailable' });
        expect(requests).toHaveLength(1);
    } finally { rpc.mockRestore(); }
});

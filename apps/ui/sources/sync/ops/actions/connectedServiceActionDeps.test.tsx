import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { ConnectedServiceAuthGroupPolicyV1Schema, ConnectedServiceCredentialRevisionV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { useConnectedServiceGroupsRefreshSignal } from '@/sync/domains/connectedServices/connectedServiceGroupsRefreshSignal';
import { createUiConnectedServiceAction } from './connectedServiceActionDeps';
import type { LazyActionAccountContext } from './actionAccountContext';
import * as machineRpc from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { AccountProfileSchema, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { ConnectedAccountCatalogRowMutationV1Schema, ConnectedPurposeCatalogV1Schema, type ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, ConnectedAccountControlCommandRequestSchema, ConnectedAccountRevokeResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { storage } from '@/sync/domains/state/storage';
import { getConnectedAccountCatalogValue } from '@/sync/store/settings/connectedAccountCatalogSnapshot';

installDisconnectedServerSocketBoundary();

it('reports native revoke cleanup uncertainty when the issued purpose-row write acknowledgement is unreadable', async () => {
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
        expect(outcome).toEqual({ status: 'returned', value: { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' } });
    } finally { rpc.mockRestore(); account.dispose(); storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});

it.each(['cancelled', 'retired', 'unreadable'] as const)('preserves the default mutation disposition when its captured receipt is %s', async disposition => {
    const bridge = await loadSyncSingletonForTests();
    const previous = storage.getState();
    const http = createHomeHubArtifactHttpBoundary('default-receipt');
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const controller = new AbortController();
    let value: ConnectedPurposeCatalogV1 = { v: 1, bindings: [] };
    let revision = 1;
    let scope: Readonly<{ serverId: string; accountId: string }>;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://default-receipt.test', accountId: 'default-receipt', request: async (input, init) => {
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
            else storage.setState({ profileScope: { ...scope, accountId: 'successor' }, profile: AccountProfileSchema.parse({ id: 'successor' }) });
            return receipt;
        };
        return response;
    } });
    scope = { serverId: connection.home.id, accountId: 'default-receipt' };
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
] as const)('preserves the %s disposition of a semantic pool move', async (disposition, errorCode) => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'work' }, incarnation: 'life', displayName: null,
        policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}), activeConnectedAccountId: null, generation: 2, runtimeStateRevision: 1,
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
    let groupRevision = 0;
    function GroupProbe() { groupRevision = useConnectedServiceGroupsRefreshSignal(); return null; }
    const screen = await renderScreen(React.createElement(GroupProbe));
    const beforeRefresh = groupRevision;
    const rpc = vi.spyOn(machineRpc, 'machineRpcWithServerScope').mockResolvedValue({
        status: 'described', service,
        descriptor: { id: 'openai-codex', title: 'Codex', authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'none' }] } },
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
        await act(async () => { expect(await action(args)).toEqual({ applied: true }); });
        expect(groupRevision).toBe(beforeRefresh);
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'work-home', machineId: 'work-machine',
            payload: { v: 1, machineId: 'work-machine', command: { operation: 'describeService', service, requiredOperation: 'quota_refresh' } } }));
        expect(requests).toEqual([{ path: '/v4/connect/qualified/quotas/refresh', method: 'POST', body: { ref: accountRef } }]);
        rpc.mockResolvedValue({ status: 'unavailable', code: 'quota_refresh_unavailable' });
        expect(await action(args)).toMatchObject({ ok: false, errorCode: 'quota_refresh_unavailable' });
        expect(requests).toHaveLength(1);
    } finally { rpc.mockRestore(); await screen.unmount(); }
});

it('publishes a successful Action pool mutation to the real mounted group refresh subscription', async () => {
    let observed = 0;
    function Probe() { observed = useConnectedServiceGroupsRefreshSignal(); return null; }
    const screen = await renderScreen(React.createElement(Probe));
    const before = observed;
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'work' }, incarnation: 'life', displayName: null,
        policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}), activeConnectedAccountId: 'personal', generation: 2, runtimeStateRevision: 1,
        state: {}, createdAt: 0, updatedAt: 0, members: [],
    });
    // Only the authenticated HTTP transport and credential lifetime are substituted.
    const account = {
        credentials: { token: 'transport-boundary' }, assertCurrent() {},
        async request() { return new Response(JSON.stringify({ group }), { status: 200 }); },
    } as unknown as LazyActionAccountContext;
    await act(async () => {
        expect(await createUiConnectedServiceAction(account)({ actionId: 'connectedServices.pools.switchNow',
            input: { group: group.ref, connectedAccountId: 'personal', expectedGeneration: 1 },
            context: { surface: 'ui', authority: 'present_user' },
        })).toEqual({ applied: true });
    });
    expect(observed).toBeGreaterThan(before);
    await screen.unmount();
});

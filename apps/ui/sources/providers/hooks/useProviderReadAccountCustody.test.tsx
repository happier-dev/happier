import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary,
    installProviderConnectionsCatalogHttpBoundary,
    createProviderConnectionsDescribeFixture, createProviderConnectionViewFixture, createProviderModelsFixture,
    createProviderModelProjectionFixture, createProviderModelProjectionGroupFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { parseToken } from '@/utils/auth/parseToken';

const account = createProviderSettingsAccountHarness();
const provider = createProviderSettingsHarness({ machines: [createMachineFixture({ id: 'machine-a', activeAt: Date.now() })] });
installProviderSettingsRpcBoundary(provider);
await loadSyncSingletonForTests();
const { useProviderConnections } = await import('./useProviderConnections');
const { useProviderConnectionModels } = await import('./useProviderConnectionModels');
const { useProviderModelProjection } = await import('./useProviderModelProjection');
const { useProviderBindingStatus } = await import('./useProviderBindingStatus');
const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');

let peerId = '';
const peerUrl = 'https://provider-read-peer.test';
const target = () => ({ enabled: true, machineId: 'machine-a', serverId: peerId });
const agentTargetKey = 'agent:happier.agent.codex/codex';
const launchBinding = {
    v: 1 as const, connectionId: ProviderConnectionIdSchema.parse('pc_a'), contributionKey: null, connectionRevision: 1,
    protocol: 'openai-responses' as const, materialization: 'engineConfig' as const,
    compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:a',
    displaySnapshot: { providerName: 'Gateway', connectionName: 'Launch', connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const },
};
const readers = [
    { name: 'connections', method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        response: () => createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })] }),
        useRead: () => { const result = useProviderConnections(target()); return { data: result.data, error: result.error, loading: result.loading, refresh: result.refresh }; } },
    { name: 'connection models', method: RPC_METHODS.DAEMON_PROVIDERS_MODELS,
        response: () => createProviderModelsFixture(),
        useRead: () => { const result = useProviderConnectionModels({ ...target(), connectionId: 'pc_a' }); return {
            data: result.models.length || result.connectionRevision !== null || result.manualModelPolicy !== null || result.modelLoadAction !== null
                ? { models: result.models, revision: result.connectionRevision, policy: result.manualModelPolicy, load: result.modelLoadAction } : null,
            error: result.error, loading: result.loading, refresh: result.refresh,
        }; } },
    { name: 'model projection', method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
        response: () => createProviderModelProjectionFixture({ agentTargetKey,
            groups: [createProviderModelProjectionGroupFixture({ connectionId: 'pc_a' })] }),
        useRead: () => { const result = useProviderModelProjection({ ...target(), agentTargetKey }); return { data: result.data, error: result.error, loading: result.loading, refresh: result.refresh }; } },
    { name: 'binding status', method: RPC_METHODS.DAEMON_PROVIDERS_BINDING_STATUS,
        response: () => ({ status: 'current' as const }),
        useRead: () => { const result = useProviderBindingStatus({ ...target(), launchBinding,
            selection: { v: 1, updatedAt: 2, ref: { agentTargetKey, providerConnectionId: launchBinding.connectionId, modelId: 'next' } },
        }); return { data: result.status, error: result.error, loading: result.loading, refresh: result.refresh }; } },
] as const;

beforeEach(async () => {
    await account.restore({ serverIdentityId: 'srv_provider_active', currentAccount: true });
    peerId = await account.addHome({ name: 'Read peer', serverUrl: peerUrl,
        serverIdentityId: 'srv_provider_peer', accountId: 'peer-a', currentAccount: true, active: false });
    // addHome deliberately starts with an empty census. These readers exercise
    // Machine RPCs, so publish the addressed peer's real Machine boundary too.
    await account.publishMachines(peerId, provider.state.machines);
    installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId: peerId,
        catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 });
});
afterEach(async () => {
    await standardCleanup();
    await account.reset();
    provider.reset();
});

function bearerAccountId(request: Readonly<{ init?: RequestInit }>): string | null {
    const authorization = new Headers(request.init?.headers).get('Authorization');
    return authorization?.startsWith('Bearer ') ? parseToken(authorization.slice(7)) : null;
}

describe('Provider read custody at an addressed peer Account', () => {
    it.each(readers)('withdraws settled $name during peer replacement and sign-out while the active Home remains current', async reader => {
        const activeLifetime = captureActiveServerAccountScopeLifetime();
        let release!: () => void;
        const replacementResponse = new Promise<void>(resolve => { release = resolve; });
        account.home.answer(peerId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: (_input, request) => ({ body: { status: 'present', revision: 1,
                content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } },
                ...(bearerAccountId(request) === 'peer-b' ? { respondAfter: replacementResponse } : {}) }),
        });
        // Personal model discovery first reads its target Machine row over HTTP. A Home
        // answers that read for the requesting Account; the replacement's own row is
        // held with the replacement response, like the other readers' daemon RPCs.
        account.home.answer(peerId, 'POST /v1/machines/read-batch', {
            select: async (input, request) => {
                const accountId = bearerAccountId(request);
                if (accountId === 'peer-b') await replacementResponse;
                return { body: await createMachineReadBatchResponseFixture(input, id => {
                    const machine = provider.state.machines.find(row => row.id === id);
                    return machine && accountId ? createPlainMachineRowFixture({ id, accountId, machine }) : null;
                }).json() };
            },
        });
        provider.intercept(reader.method, async request => {
            if (request.accountId === 'peer-b') await replacementResponse;
            return reader.response();
        });
        let retired = false;
        let metadataRefresh = false;
        const retainedObservations: unknown[] = [];
        const observations: unknown[] = [];
        const rendered = await renderHook(() => {
            const result = reader.useRead();
            const { accountScope } = useProviderActionClient(peerId);
            if (retired) observations.push(result.data);
            if (metadataRefresh) retainedObservations.push(result.data);
            return { ...result, resolution: accountScope.resolution.kind };
        });
        await waitForHomeGovernance(() => {
            expect(rendered.getCurrent().data).not.toBeNull();
            expect(rendered.getCurrent().loading).toBe(false);
        });
        metadataRefresh = true;
        await act(async () => { await upsertServerProfile({ serverUrl: peerUrl, name: 'Renamed read peer' }); });
        expect(retainedObservations.length).toBeGreaterThan(0);
        expect(retainedObservations.every(data => data !== null)).toBe(true);
        metadataRefresh = false;
        const oldRefresh = rendered.getCurrent().refresh;
        const unsubscribe = subscribeHomeCredentialChange(event => { if (event.serverId === peerId) retired = true; });
        try {
            await act(async () => { await account.home.switchAccount(peerId, 'peer-b', { currentAccount: true }); });
            expect(captureActiveServerAccountScopeLifetime()).toBe(activeLifetime);
            expect(activeLifetime?.isCurrent()).toBe(true);
            expect(rendered.getCurrent().data).toBeNull();
            expect(rendered.getCurrent().loading).toBe(true);
            expect(observations.every(data => data === null)).toBe(true);
            await act(async () => { await account.publishMachines(peerId, provider.state.machines); });
            await act(async () => { release(); });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().data).not.toBeNull());
            retired = false;
            observations.length = 0;
            const reads = provider.state.requests.length;
            await act(async () => { await oldRefresh(); });
            expect(provider.state.requests).toHaveLength(reads);
            await act(async () => {
                expect(await TokenStorage.removeCredentialsForServerUrl(peerUrl, { serverId: peerId })).toBe(true);
            });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().resolution).toBe('signed_out'));
            expect(rendered.getCurrent()).toMatchObject({ data: null, error: null, loading: false });
            expect(observations.every(data => data === null)).toBe(true);
            expect(captureActiveServerAccountScopeLifetime()).toBe(activeLifetime);
        } finally { unsubscribe(); release(); }
    });
});

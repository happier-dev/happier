import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsCatalogV1Schema, ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness,
    renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { usePoolGatewayChoices } from './usePoolGatewayChoices';

const machineRpc = vi.hoisted(() => vi.fn());
// Machine transport is the boundary; catalog admission, Action policy and mutation lifecycle stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
const account = createProviderSettingsAccountHarness();
const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const target = { kind: 'group' as const, service, groupId: 'pool-a' };

afterEach(async () => { standardCleanup(); await account.reset(); machineRpc.mockReset(); });

describe('pool gateway Action wiring', () => {
    it.each(['none', 'offline'] as const)('writes the Account slot with %s machine availability despite an unrelated unavailable declaration', async availability => {
        const gateway = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
            purposeBindingDefaults: { 'openai-upstream': { ...target, groupId: 'pool-b' } }, revision: 3, createdAt: 1, updatedAt: 1 });
        const unavailable = ProviderConnectionV1Schema.parse({ ...gateway, id: 'pc_unavailable',
            source: { kind: 'contribution', contributionKey: 'example.unavailable/managed' }, purposeBindingDefaults: {} });
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [gateway, unavailable] });
        let revision = 1;
        await account.restore({ catalog, machines: availability === 'offline'
            ? [createMachineFixture({ id: 'machine-a', active: false, activeAt: 1 })] : [],
            waivedActions: ['providers.connections.update'] });
        if (availability === 'offline') await account.selectMachine(account.serverId, 'machine-a');
        account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(account.serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(revision);
                if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account slot write');
                catalog = mutation.content.v;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const hook = await renderHook(() => usePoolGatewayChoices({ target, enabled: true, resolveTarget: () => null }));
        await vi.waitFor(() => expect(hook.getCurrent().choices).toHaveLength(1));
        expect(hook.getCurrent().ready).toBe(true);
        await act(async () => { expect(await hook.getCurrent().setEnabled(gateway.id, true)).toBe(true); });
        expect(catalog.connections[0]?.purposeBindingDefaults?.['openai-upstream']).toEqual(target);
        expect(catalog.connections[0]?.revision).toBe(4);
        expect(catalog.connections[1]).toEqual(unavailable);
        await act(async () => { expect(await hook.getCurrent().setEnabled(gateway.id, false)).toBe(true); });
        expect(catalog.connections[0]?.purposeBindingDefaults).toEqual({});
        expect(machineRpc).not.toHaveBeenCalled();
    });
    it('does not offer slots from an unavailable Gateway declaration', async () => {
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'example.unavailable/managed' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
            purposeBindingDefaults: { 'openai-upstream': { ...target, groupId: 'pool-b' } }, revision: 3, createdAt: 1, updatedAt: 1 });
        await account.restore({ catalog: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [saved] },
            waivedActions: ['providers.connections.update'] });
        const resolveTarget = () => null;
        const hook = await renderHook(() => usePoolGatewayChoices({ target, enabled: true, resolveTarget }));
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().choices).toEqual([]);
        await expect(hook.getCurrent().setEnabled(saved.id, true)).rejects.toMatchObject({ code: 'provider_authorization_changed' });
        expect(machineRpc).not.toHaveBeenCalled();
    });
});

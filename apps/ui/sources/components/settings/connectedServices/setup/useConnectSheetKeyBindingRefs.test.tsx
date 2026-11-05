import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema,
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { ConnectSheetKeyBindingTarget } from './connectSheetKeyBindings';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { useConnectSheetKeyBindingRefs } = await import('./useConnectSheetKeyBindingRefs');
afterEach(async () => { await standardCleanup(); await account.reset(); });

describe('Connect sheet binding metadata demand', () => {
    it('parks absent targets and loads only the selected Provider catalog before choosing an opening', async () => {
        const ref = formatSharedSavedSecretRefV1('key_provider');
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'other-connection', source: { kind: 'contribution', contributionKey: 'provider/deepseek' },
                role: 'named', displayName: 'Other', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
            secretBindingsByConnectionId: { 'other-connection': { byMachineId: { another: { apiKey: ref } } } },
        });
        const scope = await account.restore({ catalog, machines: [] });
        let resolveRead: ((value: HomeDomainAnswer) => void) | undefined;
        account.home.answer(scope.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { select: () =>
            new Promise<HomeDomainAnswer>(resolve => { resolveRead = resolve; }) });
        let target: ConnectSheetKeyBindingTarget | null = null;
        const hook = await renderHook(() => useConnectSheetKeyBindingRefs(target, scope));
        expect(hook.getCurrent()).toEqual({ refs: [], loading: false });
        expect(account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)).toHaveLength(0);
        target = { kind: 'provider', contributionKey: 'provider/deepseek', slot: 'apiKey' };
        await hook.rerender();
        await vi.waitFor(() => expect(resolveRead).toBeTypeOf('function'));
        expect(hook.getCurrent()).toEqual({ refs: [], loading: true });
        await act(async () => {
            resolveRead!({ body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } } });
        });
        await vi.waitFor(() => expect(hook.getCurrent()).toEqual({ refs: [ref], loading: false }));
        expect(account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)).toHaveLength(1);
        expect(account.home.requestsFor(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`)).toHaveLength(0);
        expect(account.home.requestsFor(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`)).toHaveLength(0);
        target = null;
        await hook.rerender();
        expect(hook.getCurrent()).toEqual({ refs: [], loading: false });
        expect(account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)).toHaveLength(1);
        await hook.unmount();
    });
});

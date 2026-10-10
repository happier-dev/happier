import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema,
    ProviderConnectionsRowMutationV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const account = createProviderSettingsAccountHarness();
beforeAll(loadSyncSingletonForTests);
afterEach(async () => { standardCleanup(); await account.reset(); });

function catalogFixture() {
    return ProviderConnectionsCatalogV1Schema.parse({
        ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: [{
            v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'acme.plugin/acme' },
            role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
        }],
    });
}

describe('Account Provider source visibility hook', () => {
    it('writes the stored source choice without a machine through the captured public Action client', async () => {
        let catalog = catalogFixture();
        const { serverId } = await account.restore({ catalog, machines: [] });
        let revision = 1;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(revision);
                if (mutation.content?.t !== 'plain') throw new Error('Expected a Plain Account catalog');
                catalog = mutation.content.v;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const { useProviderModelPickerVisibility } = await import('./useProviderModelPickerVisibility');
        const hook = await renderHook(() => useProviderModelPickerVisibility('pc_a', { kind: 'aggregator', serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.shown).toBe(false));
        expect(typeof hook.getCurrent()?.setShown).toBe('function');
        await act(async () => { hook.getCurrent()?.setShown(true); });
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.shown).toBe(true));
        expect(catalog.modelPickerVisibilityByConnectionId).toEqual({ pc_a: true });
    });

    it('keeps an uncertain HTTP receipt visible and reviews current Account data without replaying', async () => {
        let catalog = catalogFixture();
        const { serverId } = await account.restore({ catalog, machines: [] });
        let rowWrites = 0;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision: rowWrites + 1, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                if (mutation.content?.t !== 'plain') throw new Error('Expected a Plain Account catalog');
                catalog = mutation.content.v;
                rowWrites += 1;
                return { dispatchThenFail: true };
            },
        });
        const { useProviderModelPickerVisibility } = await import('./useProviderModelPickerVisibility');
        const hook = await renderHook(() => useProviderModelPickerVisibility('pc_a', { kind: 'aggregator', serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.shown).toBe(false));
        expect(typeof hook.getCurrent()?.setShown).toBe('function');
        await act(async () => { hook.getCurrent()?.setShown(true); });
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.error).toMatchObject({ code: 'provider_catalog_outcome_unknown' }));
        expect(hook.getCurrent()?.busy).toBe(false);
        await act(async () => { await hook.getCurrent()?.reviewCurrentState(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.shown).toBe(true));
        expect(rowWrites).toBe(1);
    });

    it('refuses a retained Account A callback after Account B mounts the same connection id', async () => {
        const catalog = catalogFixture();
        const { serverId } = await account.restore({ catalog, machines: [] });
        const { useProviderModelPickerVisibility } = await import('./useProviderModelPickerVisibility');
        const hook = await renderHook(() => useProviderModelPickerVisibility('pc_a', { kind: 'aggregator', serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.shown).toBe(false));
        const oldSetShown = hook.getCurrent()?.setShown;
        expect(typeof oldSetShown).toBe('function');
        await act(async () => { await account.restore({ accountId: 'account-b', catalog, machines: [] }); });
        const before = account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1).filter(request => request.method === 'POST').length;
        await act(async () => { oldSetShown?.(true); });
        expect(account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1).filter(request => request.method === 'POST')).toHaveLength(before);
    });

    it('does not attach Account A late settlement to Account B while its own source write is pending', async () => {
        const catalog = catalogFixture();
        const { serverId } = await account.restore({ catalog, machines: [] });
        const firstReceipt = createDeferred<void>();
        let firstDispatched = false;
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => { firstDispatched = true; return { respondAfter: firstReceipt.promise, dispatchThenFail: true }; },
        });
        const { useProviderModelPickerVisibility } = await import('./useProviderModelPickerVisibility');
        const hook = await renderHook(() => useProviderModelPickerVisibility('pc_a', { kind: 'aggregator', serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.shown).toBe(false));
        await act(async () => { hook.getCurrent()?.setShown(true); });
        await waitForHomeGovernance(() => expect(firstDispatched).toBe(true));
        await act(async () => { await account.restore({ accountId: 'account-b', catalog, machines: [] }); });
        const secondReceipt = createDeferred<void>();
        let secondDispatched = false;
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => { secondDispatched = true; return { respondAfter: secondReceipt.promise, body: { status: 'updated', revision: 2, cursor: 2 } }; },
        });
        await hook.rerender();
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.shown).toBe(false));
        await act(async () => { hook.getCurrent()?.setShown(true); });
        await waitForHomeGovernance(() => expect(secondDispatched).toBe(true));
        await act(async () => { firstReceipt.resolve(); });
        expect(hook.getCurrent()?.busy).toBe(true);
        expect(hook.getCurrent()?.error).toBeNull();
        await act(async () => { secondReceipt.resolve(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.busy).toBe(false));
        expect(hook.getCurrent()?.error).toBeNull();
    });
});

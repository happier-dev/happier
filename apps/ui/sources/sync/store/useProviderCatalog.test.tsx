import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import {
    createProviderSettingsAccountHarness,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { useProviderCatalog } = await import('./useProviderCatalog');
const { useProviderSettings } = await import('@/providers/hooks/useProviderSettings');
const { refreshProviderCatalog } = await import('@/sync/engine/settings/providerCatalogEngine');
const { beginProviderCatalogLoad, getProviderCatalogSnapshot } = await import('./settings/providerCatalogSnapshot');

afterEach(async () => { standardCleanup(); await account.reset(); });

describe('Provider catalog observation', () => {
    it('parks hidden catalog demand and renders, then rejoins the current canonical snapshot on reopen', async () => {
        const scope = await account.restore({ catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, machines: [] });
        let reads = 0;
        account.home.answer(scope.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { select: () => {
            reads += 1;
            return { body: { status: 'present', revision: 1,
                content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
        } });
        let enabled = true;
        let requested = scope;
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useProviderCatalog(requested, { enabled });
        });
        await vi.waitFor(() => expect(hook.getCurrent()?.status).toBe('ready'));
        enabled = false;
        await hook.rerender();
        const held = hook.getCurrent();
        renders = 0;
        await act(async () => { beginProviderCatalogLoad(scope, true); });
        expect(getProviderCatalogSnapshot(scope)?.stale).toBe(true);
        expect(hook.getCurrent()).toBe(held);
        expect(renders).toBe(0);
        expect(reads).toBe(1);
        // Parking must not retain the previous Account's data under a new scope.
        requested = { ...scope, accountId: 'replacement-account' };
        await hook.rerender();
        expect(hook.getCurrent()).toBeNull();
        expect(reads).toBe(1);
        requested = scope;
        enabled = true;
        await hook.rerender();
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false }));
        expect(renders).toBeGreaterThan(0);
        expect(reads).toBe(2);
        await hook.unmount();
    });

    it('settles real catalog listeners without restarting demand on equivalent scopes or refresh publications', async () => {
        const scope = await account.restore({ catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, machines: [] });
        let reads = 0;
        let revision = 1;
        account.home.answer(scope.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => {
                reads += 1;
                // Stop a repeated demand at the genuine HTTP boundary, preserving a finite RED.
                if (reads > 12) throw new Error('Unrequested Provider catalog reread');
                return { body: { status: 'present', revision,
                    content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
            },
        });
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            const requested = { serverId: scope.serverId, accountId: scope.accountId };
            return { catalog: useProviderCatalog(requested), settings: useProviderSettings(requested) };
        });
        await vi.waitFor(() => expect(hook.getCurrent().catalog).toMatchObject({ status: 'ready', revision: 1, stale: false }));
        const first = hook.getCurrent();
        await hook.rerender();
        expect(hook.getCurrent().catalog).toBe(first.catalog);
        expect(hook.getCurrent().settings).toBe(first.settings);
        expect(reads).toBe(1);
        const settled = hook.getCurrent();
        renders = 0;
        for (let index = 0; index < 10; index += 1) {
            await act(async () => { await refreshProviderCatalog(scope); });
        }
        expect(renders).toBe(0);
        expect(hook.getCurrent()).toBe(settled);
        expect(hook.getCurrent().catalog).toMatchObject({ status: 'ready', revision: 1, stale: false });
        expect(hook.getCurrent().catalog?.data).toBe(first.catalog?.data);
        expect(hook.getCurrent().settings).toBe(first.settings);
        expect(reads).toBe(11);
        revision += 1;
        await act(async () => { await refreshProviderCatalog(scope); });
        expect(renders).toBe(1);
        expect(hook.getCurrent().catalog?.revision).toBe(revision);
        expect(reads).toBe(12);
    });
});

import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { storage } from '@/sync/domains/state/storageStore';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useRoleCatalog } from './useRoleCatalog';

installDisconnectedServerSocketBoundary();

afterEach(() => {
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    resetServerFeaturesClientForTests();
});

describe('role catalog Account lifetime', () => {
    it.each(['credential_retirement', 'account_switch', 'runtime_retirement'] as const)('drops retained roles on %s and reads again on reopening', async (transition) => {
        await loadSyncSingletonForTests();
        const bridge = await loadVitestModuleForNodeRequire(
            new URL('../../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
            () => import('@/sync/ops/actions/defaultActionExecutor'),
        );
        onTestFinished(bridge.dispose);
        const initial = storage.getState();
        onTestFinished(() => storage.setState(initial, true));
        let lists = 0;
        const reopenedList = createDeferred<Response>();
        let holdList = false;
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://role-lifetime.example.test', accountId: 'alice',
            request: async (url) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (path === '/v1/artifacts') {
                    lists += 1;
                    return holdList ? reopenedList.promise : Response.json([]);
                }
                return new Response(null, { status: 404 });
            },
        });
        onTestFinished(connection.dispose);
        storage.getState().activateProfileScope({ serverId: connection.home.id, accountId: 'alice' });
        const catalog = await renderHook(() => useRoleCatalog());
        await vi.waitFor(() => expect(catalog.getCurrent().entries.length).toBeGreaterThan(0));
        const previousLists = lists;
        const otherHome = await renderHook(() => useRoleCatalog('another-home'));
        expect(otherHome.getCurrent()).toMatchObject({ entries: [], status: 'failed' });
        expect(lists).toBe(previousLists);
        await otherHome.unmount();
        await act(async () => {
            if (transition === 'credential_retirement') retireActiveServerAccountScopeLifetime();
            else if (transition === 'runtime_retirement') publishAppliedActiveServerRuntimeAvailability(false);
            else storage.getState().activateProfileScope({ serverId: connection.home.id, accountId: 'bob' });
        });
        expect(catalog.getCurrent().entries).toEqual([]);
        if (transition === 'runtime_retirement') {
            expect(catalog.getCurrent().status).toBe('failed');
            holdList = true;
            await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });
            expect(catalog.getCurrent().entries).toEqual([]);
            await act(async () => { reopenedList.resolve(Response.json([])); });
            await vi.waitFor(() => expect(catalog.getCurrent().entries.length).toBeGreaterThan(0));
            expect(lists).toBeGreaterThan(previousLists);
            return;
        }
        await catalog.unmount();
        holdList = true;
        storage.getState().activateProfileScope({ serverId: connection.home.id, accountId: 'alice' });
        const reopened = await renderHook(() => useRoleCatalog());
        expect(reopened.getCurrent().entries).toEqual([]);
        await act(async () => { reopenedList.resolve(Response.json([])); });
        await vi.waitFor(() => expect(reopened.getCurrent().entries.length).toBeGreaterThan(0));
        expect(lists).toBeGreaterThan(previousLists);
    });
});

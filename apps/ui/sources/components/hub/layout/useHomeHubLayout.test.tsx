import * as React from 'react';
// IndexedDB is the browser persistence boundary; keep Sync and the real Home writer intact.
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHomeHubDefaultLayoutV1 } from '@happier-dev/protocol/home';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { useHomeHubLayout } = await import('./useHomeHubLayout');
const { useHomeHubArtifactLayout } = await import('./useHomeHubArtifactLayout');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreActionLoader: (() => void) | undefined;
afterEach(async () => {
    standardCleanup();
    retirePresentationNotice();
    await connection?.dispose();
    connection = undefined;
    restoreActionLoader?.();
    restoreActionLoader = undefined;
});

function AccountShell({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={connection!.credentials}>
        <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: connection!.home.id, platform: 'web',
            accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
            {children}
        </AppShellPluginUiProjectionValueProvider>
    </InjectedAuthProvider>;
}

describe('Home layout write feedback without Sections', () => {
    it('withholds default placement until the first Account layout read settles', async () => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        artifact.seed({ v: 1, items: [], order: ['attention', 'automations', 'start'], hidden: ['setup'] });
        const read = createDeferred<void>();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-layout-hydration.test', accountId: 'account-a', request: async (url, init) => {
            if (new URL(String(url)).pathname === `/v1/artifacts/${artifact.artifactId}`) await read.promise;
            return artifact.request(url, init);
        } });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        try {
            const hook = await renderHook(useHomeHubLayout, { wrapper: AccountShell });
            expect(hook.getCurrent().sections).toEqual([]);
            expect(hook.getCurrent().order).toEqual([]);
            expect(hook.getCurrent()).toMatchObject({ status: 'loading', hasSnapshot: false });
            await act(async () => { read.resolve(); });
            await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
            expect(hook.getCurrent()).toMatchObject({ hasSnapshot: true });
            expect(hook.getCurrent().sections.filter(section => !section.hidden).map(section => section.id))
                .toEqual(['attention', 'automations', 'start']);
        } finally { read.resolve(); }
    });

    it.each([false, true])('loads a fresh mount after Account activation without changing Profile scope (Session index ready: %s)', async isDataReady => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        artifact.seed({ v: 1, items: [], order: ['setup'], hidden: ['setup'] });
        const bootstrap = createDeferred<void>();
        // Keep core Sync pending at its HTTP boundary: it otherwise publishes
        // Session readiness after its first failed Session-list attempt.
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-fresh-mount.test', accountId: 'account-a', request: async (url, init) => {
            if (!isDataReady && new URL(String(url)).pathname === '/v2/account/settings') await bootstrap.promise;
            return artifact.request(url, init);
        } });
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const snapshot = getActiveServerSnapshot();
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady, profileScope: scope, settingsScope: scope });
        publishAppliedActiveServerSnapshot(snapshot, false);
        try {
            const hook = await renderHook(useHomeHubArtifactLayout, { wrapper: AccountShell });
            expect(hook.getCurrent().hasSnapshot).toBe(false);
            await act(async () => { publishAppliedActiveServerSnapshot(snapshot); });
            await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
            expect(storage.getState().isDataReady).toBe(isDataReady);
            expect(hook.getCurrent().layout).toMatchObject({ order: ['setup'], hidden: ['setup'] });
        } finally {
            bootstrap.resolve();
        }
    });

    it('surfaces a refused edit and retries the queue-owned intent through its notice', async () => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        artifact.seed({ v: 1, items: [], order: ['setup'], hidden: ['setup'] });
        let failWrite = true;
        let refusedWrites = 0;
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-page-write.test', accountId: 'account-a', request: async (url, init) => {
            if (failWrite && init?.method === 'POST' && new URL(String(url)).pathname.startsWith('/v1/artifacts')) {
                refusedWrites++;
                return Response.json({ error: 'forbidden' }, { status: 403 });
            }
            return artifact.request(url, init);
        } });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        const hook = await renderHook(useHomeHubLayout, { wrapper: AccountShell });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        await act(async () => { await expect(hook.getCurrent().reset()).rejects.toBeInstanceOf(Error); });
        expect(refusedWrites).toBeGreaterThan(0);
        expect(hook.getCurrent().status).toBe('error');
        expect(artifact.layout()).toMatchObject({ order: ['setup'], hidden: ['setup'] });
        expect(readPresentationNotice()).toMatchObject({ severity: 'error', undo: { label: expect.any(String), run: expect.any(Function) } });
        // The real shared notice host retires its current notice immediately after activating Retry.
        const firstNotice = readPresentationNotice()!;
        await act(async () => { firstNotice.undo!.run(); retirePresentationNotice(firstNotice.key); });
        await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ severity: 'error', undo: { run: expect.any(Function) } }));
        await act(async () => { await expect(hook.getCurrent().setHidden('setup', false)).rejects.toBeInstanceOf(Error); });
        expect(artifact.layout().hidden).toEqual(['setup']);
        await act(async () => { await expect(hook.getCurrent().reset()).rejects.toBeInstanceOf(Error); });
        failWrite = false;
        await act(async () => { readPresentationNotice()!.undo!.run(); });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(artifact.layout()).toEqual(getHomeHubDefaultLayoutV1());
        expect(readPresentationNotice()).toBeNull();
    });
});

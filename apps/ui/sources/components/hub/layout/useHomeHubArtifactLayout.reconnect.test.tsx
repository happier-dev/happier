import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
const { useHomeHubArtifactLayout } = await import('./useHomeHubArtifactLayout');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    standardCleanup();
    vi.restoreAllMocks();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
});

it('re-reads the Home layout Artifact on a socket reconnect only while its last read did not succeed', async () => {
    const serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://home-layout-reconnect.test', accountId: 'account-a' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://home-layout-reconnect.test', accountId: 'account-a', request: homes.request });
    installHomeGovernanceBoundaries(homes);
    const scope = { serverId, accountId: 'account-a' };
    storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
    // The socket transport is the boundary: capture the reconnect signal it delivers to subscribers.
    const reconnected: (() => unknown)[] = [];
    const onReconnected = apiSocket.onReconnected.bind(apiSocket);
    vi.spyOn(apiSocket, 'onReconnected').mockImplementation(listener => { reconnected.push(listener); return onReconnected(listener); });
    const hook = await renderHook(useHomeHubArtifactLayout, { wrapper: ({ children }: React.PropsWithChildren) =>
        <InjectedAuthProvider credentials={connection!.credentials}>{children}</InjectedAuthProvider> });
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    expect(reconnected.length).toBeGreaterThan(0);
    const layoutReads = () => homes.requests.filter(request => request.serverId === serverId && request.path.startsWith('/v1/artifacts')).length;
    const before = layoutReads();
    for (const listener of reconnected) await listener();
    await new Promise(resolve => setTimeout(resolve, 50));
    // A ready layout receives its Artifact's changes through the changes catch-up after a reconnect.
    expect(layoutReads()).toBe(before);
});

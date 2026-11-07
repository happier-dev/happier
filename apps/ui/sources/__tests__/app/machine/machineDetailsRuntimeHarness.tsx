import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterAll, beforeEach, vi } from 'vitest';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { FetchedMachineRow } from '@/sync/engine/machines/syncMachines';
import type { RenderScreenResult } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary, type SessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

type MachineDetailsHome = {
    home: Awaited<ReturnType<SessionOpsNetworkBoundary['addHome']>>;
    state: {
        machines: readonly Machine[];
        machineListRequests: number;
        readMachines: (() => Promise<readonly Machine[]>) | null;
        beforeSessionRead: (() => Promise<void>) | null;
        beforeRequest: ((url: URL) => Promise<void>) | null;
    };
    storage: typeof import('@/sync/domains/state/storage').storage;
    sync: typeof import('@/sync/sync').sync;
    element: (Screen: React.ComponentType) => React.ReactElement;
    render: (Screen: React.ComponentType) => Promise<RenderScreenResult>;
    dispose: () => Promise<void>;
};

/** Cold app-entry registration, with only physical HTTP/Socket/credential boundaries replaced. */
export async function initializeMachineDetailsRuntimeForTests(): Promise<SessionOpsNetworkBoundary> {
    // Reset once at collection, before installing the transport and loading app-entry.
    // Per-case resets would discard that registration and split the real stores.
    vi.resetModules();
    const { installBrowserRuntimeForTests } = await import('@/dev/testkit/harness/browserRuntimeHarness');
    const browser = await installBrowserRuntimeForTests({ url: 'https://machine-route.test' });
    beforeEach(() => browser.activate());
    const network = await installSessionOpsNetworkBoundary();
    const { installWebLockManagerMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
    const locks = installWebLockManagerMock();
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');
    await network.addHome(getActiveServerSnapshot().serverUrl, 'machine-viewer');
    const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
    await loadSyncSingletonForTests();
    afterAll(async () => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        await network.dispose();
        locks.restore();
        browser.restore();
    });
    return network;
}

export async function arrangeMachineDetailsHomeForTests(
    network: SessionOpsNetworkBoundary,
    options: Readonly<{ serverUrl: string; machines?: readonly Machine[]; sessions?: readonly Session[]; settings?: Partial<Settings> }>,
): Promise<MachineDetailsHome> {
    const { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER} = await import('@happier-dev/protocol/machines/machineStoredContent');
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
    const { createEmptyAccountBootstrapHttpResponse } = await import('@/dev/testkit/fixtures/accountBootstrapHttpBoundary');
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
    const { storage } = await import('@/sync/domains/state/storage');
    const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
    const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
    const { resolveRoutineServerSelectionScope } = await import('@/sync/domains/server/selection/serverSelectionScope');
    const { Platform } = await import('react-native');
    const { isDesktopHost } = await import('@/utils/platform/desktopHost');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const home = await network.addHome(options.serverUrl, 'machine-viewer');
    const sessionHttp = createSessionMetadataHttpBoundary(() => Object.fromEntries(
        (options.sessions ?? []).map(session => [session.id, session]),
    ));
    const state = {
        machines: options.machines ?? [],
        machineListRequests: 0,
        readMachines: null as (() => Promise<readonly Machine[]>) | null,
        beforeSessionRead: null as (() => Promise<void>) | null,
        beforeRequest: null as ((url: URL) => Promise<void>) | null,
    };
    const toWire = (machine: Machine): FetchedMachineRow => ({
        id: machine.id, kind: machine.kind,
        seq: machine.seq, createdAt: machine.createdAt, updatedAt: machine.updatedAt,
        active: machine.active, activeAt: machine.activeAt,
        metadata: encodePlainMachineStoredContent(machine.metadata), metadataVersion: machine.metadataVersion,
        daemonState: machine.daemonState ? encodePlainMachineStoredContent(machine.daemonState) : null,
        daemonStateVersion: machine.daemonStateVersion,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    });
    network.setHttpResponder(async (input, init) => {
        const url = new URL(String(input));
        await state.beforeRequest?.(url);
        if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({}));
        if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: options.settings ?? {} }, version: 1 });
        const session = options.sessions?.find(candidate => url.pathname === `/v2/sessions/${encodeURIComponent(candidate.id)}`
            || url.pathname === `/v1/sessions/${encodeURIComponent(candidate.id)}/turns`);
        if (session) {
            await state.beforeSessionRead?.();
            // Exact Session reads include their turns in the snapshot batch.
            // Keep both reads and metadata PATCH on the canonical HTTP fixture.
            return sessionHttp.handle(input, init);
        }
        if (url.pathname === '/v1/machines') {
            state.machineListRequests += 1;
            return Response.json((state.readMachines ? await state.readMachines() : state.machines).map(toWire));
        }
        const bootstrap = createEmptyAccountBootstrapHttpResponse(url.pathname, init);
        if (bootstrap) return bootstrap;
        // The shared HTTP boundary owns readiness (health/auth ping) and plain machine keys.
        // Refusing those here would keep the real reachability owner waiting before any screen mounts.
        return null;
    });
    network.respond(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST, { runs: [] });
    await setActiveServerId(home.id, { scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()) });
    await restoreConnectionToActiveServer({ token: home.token });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await sync.refreshMachines();
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { renderScreen } = await import('@/dev/testkit');
    const element = (Screen: React.ComponentType) => React.createElement(InjectedAuthProvider, {
        credentials: { token: home.token },
        children: React.createElement(AppPaneProvider, { children: React.createElement(Screen) }),
    });
    return {
        home, state, storage, sync,
        element,
        render: async (Screen: React.ComponentType) => renderScreen(element(Screen)),
        async dispose() {
            // The cold runtime renderer owns this graph's cleanup registry; test files
            // may have imported the lightweight testkit before the collection reset.
            const { standardCleanup } = await import('@/dev/testkit');
            standardCleanup();
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await disconnectActiveServerConnection();
        },
    };
}

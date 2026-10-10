import * as React from 'react';
import { afterAll, vi } from 'vitest';
import { AccountProfileSchema, AccountSettingsV2GetResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER, ScmWorkingSnapshotSchema } from '@happier-dev/protocol';
import { createScmCapabilities } from '@happier-dev/protocol/scm/capabilities';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

export type FileViewRpcRequest = Readonly<{ targetId: string; method: string; payload: unknown }>;
type FileViewTransport = Readonly<{
    rpc: (request: FileViewRpcRequest) => unknown | Promise<unknown>;
    http: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['request']>;
}>;
// Fake network routing, not application state: two real Homes must not share a responder.
const transportsByOrigin = new Map<string, FileViewTransport>();
let disposeActionLoader: (() => void) | undefined;
afterAll(() => disposeActionLoader?.());

installDisconnectedServerSocketBoundary((socket, serverUrl) => {
    const origin = serverUrl ? new URL(serverUrl).origin : null;
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'disconnect').mockImplementation(() => {
        socket.connected = false;
        for (const listener of socket.listeners('disconnect')) listener('io client disconnect');
        return socket;
    });
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
        if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
        const request = payload as { method: string; params: unknown };
        const separator = request.method.indexOf(':');
        const transport = origin ? transportsByOrigin.get(origin) : undefined;
        if (!transport) throw new Error(`No file-view RPC boundary for ${origin ?? 'an unaddressed socket'}`);
        return { ok: true, result: await transport.rpc({ targetId: request.method.slice(0, separator), method: request.method.slice(separator + 1), payload: request.params }) };
    });
});

/** Only native/Expo presentation and the embedded editor cross this renderer boundary. */
export function installSessionFilesViewBoundaries(options: Readonly<{
    renderItemLimit?: number;
    onRecycler?: (state: import('@/dev/testkit/mocks/legendList').CapturingLegendListMockState) => void;
}> = {}) {
    vi.doMock('react-native', async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    });
    vi.doMock('react-native-unistyles', async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });
    // The host renderer has no native measured viewport. Replace only the external
    // recycler; the canonical backend, row projection, and browser stay real.
    vi.doMock('@legendapp/list/react-native', async importOriginal => {
        const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
        const recycler = createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(),
            renderItemLimit: options.renderItemLimit, emitViewability: true });
        options.onRecycler?.(recycler.state);
        return recycler.module;
    });
    vi.doMock('@/modal', async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });
    vi.doMock('@/components/ui/popover', async importOriginal => {
        const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
        return createInlinePopoverModuleMock(importOriginal);
    });
    vi.doMock('expo-router', async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });
    vi.doMock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));
}

export async function prepareSessionFilesViewTestkit() {
    await loadSyncSingletonForTests();
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    disposeActionLoader = await installRealActionExecutorModuleLoader();
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
}

export async function createSessionFilesViewFixture(input: Readonly<{
    serverUrl?: string;
    rootPath?: string;
    sessionId?: string;
    machineId?: string;
    rpc?: (request: FileViewRpcRequest) => unknown | Promise<unknown>;
    request?: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['request']>;
    machineCarrierOrigin?: string;
}> = {}) {
    const { createSessionFixture, renderScreen, flushHookEffects } = await import('@/dev/testkit');
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
    const { transferMachine, transferFeatures, installTransferProjection } = await import('../sessionFileTransferTestkit');
    const { storage } = await import('@/sync/domains/state/storage');
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const requests: FileViewRpcRequest[] = [];
    const dispatch = (request: FileViewRpcRequest) => {
        requests.push(request);
        return input.rpc?.(request) ?? { success: false, error: 'RPC method not available', errorCode: 'METHOD_NOT_AVAILABLE' };
    };
    const features = createRootLayoutFeaturesResponse({ features: { machines: transferFeatures().features.machines } });
    const authoringMemory = createAuthoringMemoryHttpBoundary();
    const machine = { ...transferMachine({ id: input.machineId ?? 'm1', storageMode: 'plain' }), active: true, activeAt: Date.now() };
    const machineRow = { ...machine, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: encodePlainMachineStoredContent(machine.metadata),
        daemonState: machine.daemonState ? encodePlainMachineStoredContent(machine.daemonState) : null };
    const homeRequest: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['request']> = async (url, init) => {
        const path = new URL(String(url)).pathname;
        const handled = await input.request?.(url, init);
        if (handled && handled.status !== 404) return handled;
        const memoryResponse = await authoringMemory.handle(url, init);
        if (memoryResponse) return memoryResponse;
        if (path === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture());
        if (path === '/health') return Response.json({ status: 'ok' });
        if (path === '/v1/features') return Response.json(features);
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'alice' }));
        if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
        if (path === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 0 }));
        if (path.endsWith('/messages')) return Response.json({ messages: [], hasMore: false });
        if (path === `/v1/machines/${machine.id}`) return Response.json({ machine: machineRow });
        if (path === '/v1/machines') return Response.json([machineRow]);
        return Response.json({}, { status: 404 });
    };
    const serverUrl = input.serverUrl ?? 'https://session-file-views.test';
    const origin = new URL(serverUrl).origin;
    const transport = { rpc: dispatch, http: homeRequest } satisfies FileViewTransport;
    transportsByOrigin.set(origin, transport);
    const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', request: homeRequest });
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (url, init) => {
        const requestUrl = new URL(String(url));
        if (requestUrl.origin === input.machineCarrierOrigin) {
            if (!input.request) throw new Error('No machine carrier HTTP responder');
            return input.request(url, init);
        }
        const addressed = transportsByOrigin.get(requestUrl.origin);
        if (!addressed) throw new Error(`Unexpected file view Home: ${requestUrl.origin}`);
        if (requestUrl.pathname === '/v1/auth/ping') return Response.json({});
        return addressed.http(url, init);
    });
    const scope = { serverId: connection.home.id, machineId: input.machineId ?? 'm1', rootPath: input.rootPath ?? '/workspace' };
    const session = createSessionFixture({ id: input.sessionId ?? 's1', serverId: scope.serverId, active: true, metadata: { path: scope.rootPath, machineId: scope.machineId, host: 'tester.local' } });
    installTransferProjection({ serverId: scope.serverId, session, machine, features });
    await vi.waitFor(() => {
        const accountScope = getActiveServerAccountScope();
        if (accountScope?.serverId !== connection.home.id || accountScope.accountId !== 'alice') {
            throw new Error('File-view fixture is waiting for its admitted Account/Home');
        }
    });
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true, 'files.reviewComments': false, 'files.diffSyntaxHighlighting': false, 'files.editor': false } });
    storage.getState().applySessions([session]);
    return {
        ...connection, scope, session, requests, storage,
        async dispose() {
            const { scmStatusSync } = await import('@/scm/scmStatusSync');
            scmStatusSync.clearForSession(session.id, scope.serverId);
            await connection.dispose();
            if (transportsByOrigin.get(origin) === transport) transportsByOrigin.delete(origin);
        },
        setSnapshot(snapshot: ScmWorkingSnapshot | null, error: { message: string; at: number; errorCode?: string } | null = null) {
            if (snapshot === null) {
                storage.getState().updateSessionProjectScmSnapshot(session.id, null, scope.serverId);
                storage.getState().updateSessionProjectScmStatus(session.id, null, scope.serverId);
            } else {
                storage.getState().publishSessionProjectScmSnapshots([{ sessionId: session.id, serverId: scope.serverId, snapshot, status: null }]);
            }
            storage.getState().updateSessionProjectScmSnapshotError(session.id, error, scope.serverId);
        },
        wrap(element: React.ReactElement) {
            return React.createElement(InjectedAuthProvider, { credentials: connection.credentials, children: React.createElement(AppPaneProvider, null, element) });
        },
        async render(element: React.ReactElement, options?: Parameters<typeof renderScreen>[1]) {
            const screen = await renderScreen(React.createElement(InjectedAuthProvider, { credentials: connection.credentials, children: React.createElement(AppPaneProvider, null, element) }), options);
            await flushHookEffects({ cycles: 20 });
            return screen;
        },
    };
}

export function fileViewSnapshot(input: Readonly<{
    rootPath?: string;
    isRepo?: boolean;
    entries?: ScmWorkingSnapshot['entries'];
    fetchedAt?: number;
    capabilities?: Partial<ScmWorkingSnapshot['capabilities']>;
}> = {}): ScmWorkingSnapshot {
    const rootPath = input.rootPath ?? '/workspace';
    return ScmWorkingSnapshotSchema.parse({
        projectKey: `m1:${rootPath}`, fetchedAt: input.fetchedAt ?? 1,
        repo: input.isRepo === false ? { isRepo: false, rootPath: null, backendId: null, mode: null } : { isRepo: true, rootPath, backendId: 'git', mode: '.git', worktrees: [] },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false, entries: input.entries ?? [],
        totals: { includedFiles: 0, pendingFiles: input.entries?.length ?? 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
        // The canonical builder fills every declared capability; this fixture turns on only what it reads.
        capabilities: createScmCapabilities({ readStatus: true, readLog: true, writeDiscard: true, ...input.capabilities }),
    });
}

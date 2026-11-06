import * as React from 'react';
import { V2SessionByIdNotFoundSchema } from '@happier-dev/protocol';
import { afterAll, vi } from 'vitest';
import { AccountProfileSchema, AccountSettingsV2GetResponseSchema, AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema, MACHINE_PLAIN_DATA_KEY_MARKER, ScmWorkingSnapshotSchema } from '@happier-dev/protocol';
import { createScmCapabilities } from '@happier-dev/protocol/scm/capabilities';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { isFilesystemActionId, type FilesystemActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';

export type FileViewRpcRequest = Readonly<{ targetId: string; method: string; payload: unknown }>;
type FileViewTransport = Readonly<{
    rpc: (request: FileViewRpcRequest) => unknown | Promise<unknown>;
    http: RuntimeFetch;
    emissions: { event: string; payload: unknown }[];
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
    vi.spyOn(socket, 'emit').mockImplementation((event, payload) => {
        if (origin) transportsByOrigin.get(origin)?.emissions.push({ event, payload });
        return socket;
    });
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
    platformOS?: 'ios' | 'android' | 'web';
    reactNativeOverrides?: import('@/dev/testkit/mocks/reactNative').TestReactNativeOverrides;
    confirmResult?: boolean;
    renderItemLimit?: number;
    emitViewability?: boolean;
    onRecyclerCommit?: (props: Readonly<Record<string, unknown>>) => void;
    onRecycler?: (state: import('@/dev/testkit/mocks/legendList').CapturingLegendListMockState) => void;
}> = {}) {
    vi.doMock('react-native', async () => {
        const { createReactNativeNativeMock, createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return options.platformOS === 'web' ? createReactNativeWebMock(options.reactNativeOverrides)
            : createReactNativeNativeMock({ platformOS: options.platformOS ?? 'ios' }, options.reactNativeOverrides);
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
            renderItemLimit: options.renderItemLimit, emitViewability: options.emitViewability ?? true,
            onCommit: options.onRecyclerCommit });
        options.onRecycler?.(recycler.state);
        return recycler.module;
    });
    vi.doMock('@/modal', async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: options.confirmResult }).module;
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
    machine?: import('@/sync/domains/state/storageTypes').Machine | null;
    credentials?: Parameters<typeof restoreServerAccountForTest>[0]['credentials'];
    serverIdentityId?: string;
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
    const { resolveServerProfileScopeId } = await import('@/sync/domains/server/serverProfiles');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const serverIdentityId = input.serverIdentityId;
    const machineId = input.machine?.id ?? input.machineId ?? 'm1';
    const serverUrl = input.serverUrl ?? 'https://session-file-views.test';
    const requests: FileViewRpcRequest[] = [];
    type ActionIssuer = Awaited<ReturnType<typeof import('@/dev/testkit/harness/externalActionAccountHttpBoundary').createExternalActionAccountHttpBoundary>>;
    const actionIssuers = new Map<FilesystemActionId, ActionIssuer>();
    const emissions: FileViewTransport['emissions'] = [];
    const dispatch = (request: FileViewRpcRequest) => {
        requests.push(request);
        return input.rpc?.(request) ?? { success: false, error: 'RPC method not available', errorCode: 'METHOD_NOT_AVAILABLE' };
    };
    const features = createRootLayoutFeaturesResponse({ features: { machines: transferFeatures().features.machines },
        capabilities: { serverIdentity: { serverIdentityId: serverIdentityId ?? null } } });
    const authoringMemory = createAuthoringMemoryHttpBoundary();
    // The Account-carrier Action transport admits only a Home Machine row that proves its custodian and ready access.
    const { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const issuerFor = async (actionId: FilesystemActionId) => {
        if (!serverIdentityId) return null;
        const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
        let issuer = actionIssuers.get(actionId);
        if (!issuer) {
            issuer = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId: 'alice',
                machineId: machineId, actionId, tokenEpoch: 0,
                execute: (actionInput, context) => {
                    const { machineId: targetId = context.target.machineId, ...payload } = actionInput as Record<string, unknown> & { machineId?: string };
                    return dispatch({ targetId, method: actionId, payload });
                } });
            actionIssuers.set(actionId, issuer);
        }
        return issuer;
    };
    // With an advertised Home identity (required by the Account-carrier Action transport), the Machine's installation key is shared by every Action issuer, so its rows publish the one the carrier seals to.
    const installationPublicKey = (await issuerFor('daemon.filesystem.listDirectory'))?.machine.installationPublicKey;
    const machine = input.machine === null ? null
        : { ...(input.machine ?? transferMachine({ id: input.machineId ?? 'm1', storageMode: 'plain' })), active: true, activeAt: Date.now() };
    // Own-Machine Action admission reads the Machine's ready custody from the full row.
    const ownedMachine = machine && serverIdentityId && !machine.access
        ? { ...machine, access: createPlainMachineRowFixture({ id: machine.id, accountId: 'alice' }).access, installationId: machine.installationId ?? 'test-installation', installationPublicKey }
        : machine;
    const machineRow = machine ? { ...(serverIdentityId ? createPlainMachineRowFixture({ id: machine.id, accountId: 'alice' }) : {}), ...machine, ...(installationPublicKey ? { installationPublicKey } : {}),
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: encodePlainMachineStoredContent(machine.metadata),
        daemonState: machine.daemonState ? encodePlainMachineStoredContent(machine.daemonState) : null } : null;
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'alice', encryptionMode: 'plain' });
    const homeRequest: RuntimeFetch = async (url, init) => {
        const requestUrl = new URL(String(url));
        const path = requestUrl.pathname;
        const handled = await input.request?.(url, init);
        if (handled && handled.status !== 404) return handled;
        const filesystemAction = /^\/v1\/actions\/([^/]+)(?:\/execution-authorization)?$/.exec(path)?.[1];
        if (filesystemAction && isFilesystemActionId(filesystemAction) && machine) {
            // The admitted Account carrier: the Home issues the authorization and the Machine executes the Action.
            const issuer = await issuerFor(filesystemAction);
            const issued = await issuer?.handle(requestUrl, init);
            if (issued) return issued;
        }
        const memoryResponse = await authoringMemory.handle(url, init);
        if (memoryResponse) return memoryResponse;
        if (path === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture());
        const artifactResponse = artifacts.handle(path + requestUrl.search, init);
        if (artifactResponse) return artifactResponse;
        if (path === '/health') return Response.json({ status: 'ok' });
        if (path === '/v1/features') return Response.json(features);
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'alice' }));
        if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
        if (path === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 0 }));
        if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
        if (path.endsWith('/messages')) return Response.json({ messages: [], hasMore: false });
        if (machine && path === `/v1/machines/${machine.id}`) return Response.json({ machine: machineRow });
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
            // The published row is the wire shape; `availability` is derived on the client from presence.
            const { availability: _clientDerived, ...publishedRow } = machineRow ?? {};
            return createMachineReadBatchResponseFixture(init.body, id => machine && machineRow && id === machine.id ? publishedRow : null);
        }
        if (path === '/v1/machines') return Response.json(machineRow ? [machineRow] : []);
        if ((init?.method ?? 'GET') === 'GET' && /^\/v2\/sessions\/[^/]+$/.test(path)) {
            return Response.json(V2SessionByIdNotFoundSchema.parse({ error: 'Session not found' }), { status: 404 });
        }
        return Response.json({}, { status: 404 });
    };
    const origin = new URL(serverUrl).origin;
    const transport = { rpc: dispatch, http: homeRequest, emissions } satisfies FileViewTransport;
    transportsByOrigin.set(origin, transport);
    // An Account Action is signed only by a present-user Account token with its epoch.
    const accountToken = serverIdentityId && !input.credentials
        ? { token: (await import('@/dev/testkit/harness/homeGovernanceHarness')).createAccountTokenForTests('alice', { currentAccount: true }) } : undefined;
    const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', request: homeRequest,
        credentials: input.credentials ?? accountToken,
        serverIdentityId });
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (url, init) => {
        const requestUrl = new URL(String(url));
        if (requestUrl.origin === input.machineCarrierOrigin) {
            if (!input.request) throw new Error('No machine carrier HTTP responder');
            const response = await input.request(url, init);
            if (!response) throw new Error(`Unhandled machine carrier request: ${requestUrl.pathname}`);
            return response;
        }
        const addressed = transportsByOrigin.get(requestUrl.origin);
        if (!addressed) throw new Error(`Unexpected file view Home: ${requestUrl.origin}`);
        if (requestUrl.pathname === '/v1/auth/ping') return Response.json({});
        return addressed.http(url, init);
    });
    const scope = { serverId: resolveServerProfileScopeId(connection.home), machineId: input.machineId ?? 'm1', rootPath: input.rootPath ?? '/workspace' };
    const session = createSessionFixture({ id: input.sessionId ?? 's1', serverId: scope.serverId, active: true, metadata: { path: scope.rootPath, machineId: scope.machineId, host: 'tester.local' } });
    installTransferProjection({ serverId: scope.serverId, session, machine: ownedMachine, features });
    await vi.waitFor(() => {
        const accountScope = getActiveServerAccountScope();
        if (accountScope?.serverId !== scope.serverId || accountScope.accountId !== 'alice') {
            throw new Error('File-view fixture is waiting for its admitted Account/Home');
        }
    });
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true, 'files.reviewComments': false, 'files.diffSyntaxHighlighting': false, 'files.editor': false } });
    storage.getState().applySessions([session]);
    return {
        ...connection, scope, session, requests, emissions, storage,
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

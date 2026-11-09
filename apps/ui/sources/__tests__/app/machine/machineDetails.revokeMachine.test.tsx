import React from 'react';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
// Keep browser persistence owners real above IndexedDB's environment boundary.
import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen as renderScreenWithProviders } from '@/dev/testkit';
import { installMachineDetailsCommonModuleMocks } from './machineDetailsTestHelpers';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { decodePlainMachineStoredContent, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER} from '@happier-dev/protocol/machines/machineStoredContent';
import {
    DEFAULT_PROVIDER_SETTINGS_V1, ProviderSettingsV1Schema } from '@happier-dev/protocol/providers/settings/v1';
import { splitProviderSettingsV1, ProviderConnectionsRowMutationV1Schema,
    type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { MachineUpdateMetadataRequest, MachineUpdateMetadataResponse } from '@happier-dev/protocol/machines/metadataUpdate';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineReplacementPickerModalProps } from '@/components/machines/MachineReplacementPickerModal';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { decideApprovalAsInbox, replayApprovedAsDaemon } from '@/dev/testkit/harness/approvalInbox';

const testGlobal = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    expo?: { EventEmitter: new () => unknown };
};

testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
testGlobal.expo = { EventEmitter: class {} } as unknown as NonNullable<typeof testGlobal.expo>;

const {
    confirmSpy,
    showSpy,
    machineState,
    alertSpy,
    promptSpy,
    metadataTransportSpy,
    routeParams,
    stackOptionsState,
    routerBackSpy,
    routerMock,
} = vi.hoisted(() => ({
    confirmSpy: vi.fn<typeof import('@/modal').Modal.confirm>(async () => true),
    showSpy: vi.fn<typeof import('@/modal').Modal.show>(() => 'replacement-picker-modal'),
    machineState: {
        currentMachine: null as unknown as Machine,
        machinesByServerId: {} as Record<string, Machine[] | null>,
        settings: { providerSettingsV1: undefined } as Record<string, unknown>,
        settingsVersion: 1,
        settingsWrites: [] as Record<string, unknown>[],
        settingsWriteFailure: false,
        providerCatalog: null as ProviderConnectionsCatalogV1 | null,
        providerCatalogRevision: 1,
        providerCatalogWrites: [] as ProviderConnectionsCatalogV1[],
        requests: [] as Array<{ path: string; method: string; body: unknown }>,
        daemonStops: [] as unknown[],
        revokeFailure: null as { status: number; error: string } | null,
        serverId: '',
    },
    alertSpy: vi.fn(),
    promptSpy: vi.fn<typeof import('@/modal').Modal.prompt>(async () => null),
    metadataTransportSpy: vi.fn<(_event: string, _request: MachineUpdateMetadataRequest) => Promise<MachineUpdateMetadataResponse>>(),
    routeParams: { id: 'machine-1', serverId: undefined as string | undefined, page: undefined as string | undefined },
    stackOptionsState: { current: null as Record<string, unknown> | null },
    routerBackSpy: vi.fn(),
    routerMock: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },
}));

installMachineDetailsCommonModuleMocks({
    // Parameterized copy keeps its params, so the machine a fact names is observable.
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { ...routerMock, back: routerBackSpy },
            params: routeParams,
            stackOptionsCapture: {
                record: (options) => {
                    stackOptionsState.current = typeof options === 'function' ? options() : options;
                },
                reset: () => {
                    stackOptionsState.current = null;
                },
                getRaw: () => stackOptionsState.current,
                getResolved: () => stackOptionsState.current,
            },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: alertSpy,
                confirm: confirmSpy,
                prompt: promptSpy,
                show: showSpy,
            },
        }).module;
    },
});

installDisconnectedServerSocketBoundary((socket) => {
    configureConnectedServerSocketBoundary(socket);
    socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, request: unknown) => {
        if (event === 'machine-update-metadata') {
            return metadataTransportSpy(event, request as MachineUpdateMetadataRequest);
        }
        // This fixture has no installed daemon contributions or execution runs.
        if (event === SOCKET_RPC_EVENTS.CALL && request && typeof request === 'object' && 'method' in request) {
            const method = String(request.method);
            if (method.endsWith(`:${RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST}`)) return { ok: true, result: { runs: [] } };
            if (method.endsWith(`:${RPC_METHODS.STOP_DAEMON}`)) {
                machineState.daemonStops.push(request);
                return { ok: true, result: { message: 'Daemon stopped' } };
            }
            return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        }
        throw new Error(`Unexpected machine fixture Socket event: ${String(event)}`);
    });
});

// Load after the SDK/framework boundaries are installed, as the managed-Machine
// harness does; per-test cache resets must not own the cold runtime import.
await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
const artifactStore = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });

/** The Home's HTTP/persistence boundary; client revocation, CAS and projections remain real. */
async function serveMachineHome(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    machineState.requests.push({ path, method, body });
    if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
    if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
    if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'account-a' }));
    if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
    if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
    if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
    const artifactResponse = artifactStore.handle(path, init);
    if (artifactResponse) return artifactResponse;
    if (path === '/v1/actions/approval.request.decide' && method === 'POST') {
        // This is the Home/daemon transport boundary; keep the real approval
        // claim, Artifact settlement and Machine effect beneath it.
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        if (envelope.target?.kind !== 'machine' || envelope.target.machineId !== 'machine-1') throw new Error('Wrong approval Machine');
        const decision = getActionSpec('approval.request.decide').inputSchema.parse(envelope.input);
        if (typeof decision !== 'object' || decision === null || !('artifactId' in decision)
            || typeof decision.artifactId !== 'string') throw new Error('Missing approval Artifact');
        const execution = await replayApprovedAsDaemon({ serverId: machineState.serverId, machineId: 'machine-1',
            artifactId: decision.artifactId, decision: 'approve' });
        return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1,
            actionId: 'approval.request.decide', requestId: envelope.requestId, execution }));
    }
    if (path === '/v2/account/settings') {
        if (method === 'GET') return Response.json({ content: { t: 'plain', v: machineState.settings }, version: machineState.settingsVersion });
        if (machineState.settingsWriteFailure) return Response.json({ error: 'unavailable' }, { status: 503 });
        if (!body || typeof body !== 'object' || !('expectedVersion' in body) || !('content' in body)) {
            throw new Error('Invalid Account Settings fixture write');
        }
        if (body.expectedVersion !== machineState.settingsVersion) {
            return Response.json({ success: false, error: 'version-mismatch', currentVersion: machineState.settingsVersion,
                currentContent: { t: 'plain', v: machineState.settings } });
        }
        const content = body.content;
        if (!content || typeof content !== 'object' || !('t' in content) || content.t !== 'plain'
            || !('v' in content) || !content.v || typeof content.v !== 'object' || Array.isArray(content.v)) {
            throw new Error('Expected plain Account Settings fixture envelope');
        }
        machineState.settings = content.v as Record<string, unknown>;
        machineState.settingsWrites.push(machineState.settings);
        machineState.settingsVersion += 1;
        return Response.json({ success: true, version: machineState.settingsVersion });
    }
    if (path === '/v1/account/entity-rows/provider-connections') {
        if (method === 'GET') return Response.json({ status: 'present', revision: machineState.providerCatalogRevision,
            content: { t: 'plain', v: machineState.providerCatalog } });
        if (machineState.settingsWriteFailure) return Response.json({ status: 'unavailable', reason: 'unreachable' }, { status: 503 });
        const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
        if (mutation.expectedRevision !== machineState.providerCatalogRevision || mutation.content?.t !== 'plain') {
            return Response.json({ status: 'conflict', revision: machineState.providerCatalogRevision });
        }
        machineState.providerCatalog = mutation.content.v;
        machineState.providerCatalogWrites.push(mutation.content.v);
        machineState.providerCatalogRevision += 1;
        return Response.json({ status: 'updated', revision: machineState.providerCatalogRevision,
            cursor: machineState.providerCatalogRevision });
    }
    const machines = (machineState.machinesByServerId['server-a'] ?? []).map(machine =>
        machine.id === machineState.currentMachine.id ? machineState.currentMachine : machine);
    const publishedMachines = machines.map(machine => MachinePublishedRowV1Schema.parse({
        ...createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a' }),
        ...machine, storageMode: 'plain',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        // These page fixtures vary presentation fields, but the Home emits complete published metadata.
        metadata: encodePlainMachineStoredContent(machine.metadata === null ? null : MachinePublishedMetadataV1Schema.parse({
            ...Object.assign({}, createMachineFixture().metadata, { host: '' }, machine.metadata),
        })), daemonState: null }));
    if (path === '/v1/machines') return Response.json(publishedMachines);
    if (path === '/v1/machines/read-batch' && method === 'POST') return createMachineReadBatchResponseFixture(body,
        id => publishedMachines.find(machine => machine.id === id) ?? null);
    if (path === '/v1/machines/machine-1/revoke' && method === 'POST') {
        if (machineState.revokeFailure) return Response.json({ error: machineState.revokeFailure.error }, { status: machineState.revokeFailure.status });
        if (machineState.currentMachine.revokedAt) return Response.json({ error: 'machine_revoked' }, { status: 410 });
        machineState.currentMachine = { ...machineState.currentMachine, revokedAt: Date.now() };
        machineState.machinesByServerId['server-a'] = machines.map(machine => machine.id === 'machine-1' ? machineState.currentMachine : machine);
        return Response.json({ ok: true });
    }
    if (path === '/v1/machines/machine-1/replacement') {
        const replacement = method === 'DELETE' ? null
            : body && typeof body === 'object' && 'replacementMachineId' in body && typeof body.replacementMachineId === 'string'
                ? body.replacementMachineId : undefined;
        if (replacement === undefined) throw new Error('Missing replacement machine fixture id');
        machineState.currentMachine = { ...machineState.currentMachine, replacedByMachineId: replacement };
        machineState.machinesByServerId['server-a'] = machines.map(machine => machine.id === 'machine-1' ? machineState.currentMachine : machine);
        return Response.json({ ok: true });
    }
    if (path.startsWith('/v1/machines/')) {
        const machine = publishedMachines.find(machine => machine.id === decodeURIComponent(path.slice('/v1/machines/'.length)));
        if (machine) return Response.json({ machine });
    }
    // Unused Home APIs are unsupported in this bounded machine fixture.
    return Response.json({ error: 'not_found' }, { status: 404 });
}

async function publishMachineFixture() {
    await act(async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { fetchAndApplyProfile } = await import('@/sync/engine/account/syncAccount');
        await fetchAndApplyProfile({ credentials: accountConnection!.credentials, applyProfile: storage.getState().applyProfile });
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        storage.getState().applySettingsForScope({ serverId: machineState.serverId, accountId: 'account-a' },
            settingsParse(machineState.settings), machineState.settingsVersion);
        const { fetchAndApplyMachines } = await import('@/sync/engine/machines/syncMachines');
        await fetchAndApplyMachines({ credentials: accountConnection!.credentials, expectedAccountMode: 'plain', encryption: null,
            machineDataKeys: new Map(), sourceServerId: machineState.serverId, throwOnError: true,
            applyMachines: (machines, replace) => storage.getState().applyMachines(machines, replace,
                { sourceServerId: machineState.serverId, sourceAccountId: 'account-a' }), replace: true });
    });
}

/** Save stays disabled while the page's Home target is still settling; press it once it is live. */
async function pressNameSave(screen: RenderedScreen) {
    await vi.waitFor(() => expect(screen.findByTestId('machine-detail-name-save')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('machine-detail-name-save');
}

async function readVisibleMachine() {
    const { storage } = await import('@/sync/domains/state/storage');
    return storage.getState().machines[routeParams.id];
}

function publishProviderCatalogFixture() {
    machineState.providerCatalog = splitProviderSettingsV1(
        ProviderSettingsV1Schema.parse(machineState.settings.providerSettingsV1),
    ).catalog;
}

async function renderScreen(element: React.ReactElement) {
    await publishMachineFixture();
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { AuthProvider } = await import('@/auth/context/AuthContext');
    return renderScreenWithProviders(React.createElement(AuthProvider, {
        initialCredentials: accountConnection!.credentials,
        children: React.createElement(AppPaneProvider, null, element),
    }));
}

/** Standalone sections wait for the real asynchronous credential binding, as the full page does. */
async function renderMachineSection(element: React.ReactElement) {
    const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
    let ready = false;
    function BoundSection() {
        ready = useMountedActionExecution(machineState.serverId).ready;
        return element;
    }
    const screen = await renderScreen(React.createElement(BoundSection));
    await vi.waitFor(async () => { await act(async () => {}); expect(ready).toBe(true); });
    await publishMachineFixture();
    return screen;
}

/** The page's closing destructive button (a quiet button row, not a row in a sheet). */
function findRemoveMachineButton(screen: RenderedScreen) {
    return screen.findAll((node) => node.props?.testID === 'machine-detail-remove' && typeof node.props?.onPress === 'function')[0]?.props;
}

/** A rare operation in the page header's `⋯` menu, by its test id. */
function findHeaderMenuAction(screen: RenderedScreen, testID: string) {
    const menus = screen.findAll((node) => node.props?.testID === 'machine-detail-menu' && Array.isArray(node.props?.actions));
    return menus.flatMap((menu) => menu.props.actions as Array<{ testID?: string; loading?: boolean; onSelect: () => void }>).find((action) => action.testID === testID);
}

function readReplacementPickerProps() {
    // Modal.show is a generic system boundary; this screen opens only the machine picker.
    return showSpy.mock.calls[0]?.[0]?.props as Omit<MachineReplacementPickerModalProps, 'onClose'> | undefined;
}

describe('MachineDetailScreen (revoke/forget machine)', () => {
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        showSpy.mockReset();
        confirmSpy.mockReset();
        alertSpy.mockReset();
        promptSpy.mockReset();
        promptSpy.mockResolvedValue(null);
        routeParams.id = 'machine-1';
        routeParams.serverId = undefined;
        routeParams.page = undefined;
        routerMock.replace.mockReset();
        metadataTransportSpy.mockReset();
        metadataTransportSpy.mockImplementation(async (_event, request) => ({
            result: 'success', version: request.expectedVersion + 1, metadata: request.metadata,
        }));
        stackOptionsState.current = null;
        routerBackSpy.mockReset();
        machineState.currentMachine = createMachineFixture({
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 0,
            metadata: MachinePublishedMetadataV1Schema.parse({ ...createMachineFixture().metadata,
                displayName: 'My Machine', host: 'host', platform: 'darwin' }),
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            revokedAt: null,
            storageMode: 'plain',
        });
        machineState.machinesByServerId = {
            'server-a': [
                machineState.currentMachine,
                {
                    id: 'machine-2',
                    active: true,
                    activeAt: Date.now(),
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    seq: 0,
                    metadata: MachinePublishedMetadataV1Schema.parse({ ...createMachineFixture().metadata,
                        displayName: 'Replacement Machine', host: 'replacement', platform: 'darwin' }),
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                    revokedAt: null,
                },
            ],
        };
        machineState.settings = { providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1 };
        machineState.settingsVersion = 1;
        machineState.settingsWrites = [];
        machineState.settingsWriteFailure = false;
        machineState.providerCatalog = splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog;
        machineState.providerCatalogRevision = 1;
        machineState.providerCatalogWrites = [];
        machineState.requests = [];
        artifactStore.clear();
        machineState.daemonStops = [];
        machineState.revokeFailure = null;
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        accountConnection = await restoreServerAccountForTest({ serverUrl: 'https://machine-home.example.test', serverIdentityId: 'srv_machine_home',
            credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
            accountId: 'account-a', request: serveMachineHome });
        machineState.serverId = accountConnection.home.id;
    });

    afterEach(async () => { await act(async () => { await accountConnection?.dispose(); }); accountConnection = undefined; });

    it('stops the daemon directly from the Doctor page through the front-door Action and the machine\'s own RPC', async () => {
        routeParams.page = 'doctor';
        const { MachineSubPageScreen } = await import('@/components/machines/page/MachineSubPageScreen');
        const screen = await renderScreen(React.createElement(MachineSubPageScreen));
        const stop = screen.findAll(node => node.props?.testID === 'machine-detail-stop-daemon-button' && typeof node.props?.onPress === 'function')[0];
        expect(stop).toBeTruthy();
        await act(async () => { await stop!.props.onPress(); });
        await vi.waitFor(() => expect(machineState.daemonStops).toEqual([expect.objectContaining({
            method: expect.stringMatching(new RegExp(`machine-1.*${RPC_METHODS.STOP_DAEMON}`)),
        })]));
        expect(alertSpy.mock.calls.some(call => Array.isArray(call[2]))).toBe(false);
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(alertSpy).toHaveBeenCalledWith('machine.daemonStoppedTitle', 'Daemon stopped');
    });

    it('opens the machine\'s one share sheet from the header ⋯ as "Share <machine>" (lab m-share S)', async () => {
        const { MachinePageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachinePageScreen');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        const share = findHeaderMenuAction(screen, 'machine-detail-menu-share');
        expect(share).toBeTruthy();
        showSpy.mockClear();
        await act(async () => share!.onSelect());
        const opened = showSpy.mock.calls.at(-1)?.[0] as { chrome?: { testID?: string }; props?: { machineId?: string } } | undefined;
        expect(opened?.chrome?.testID).toBe('machine-share-modal');
        expect(opened?.props?.machineId).toBe('machine-1');
    });

    it('updates the visible machine name only after saving the inline rename draft', async () => {
        const { MachinePageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachinePageScreen');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        // Rename is one of the header's `⋯` actions (entity-header anatomy: presence, then `⋯`).
        expect(screen.findAll((node) => node.props?.testID === 'machine-detail-rename' && typeof node.props?.onPress === 'function')).toHaveLength(0);
        const menu = screen.findAll((node) => node.props?.testID === 'machine-detail-menu' && typeof node.props?.onSelect === 'function')[0];
        expect(menu).toBeTruthy();

        await act(async () => {
            await menu.props.onSelect('rename');
        });
        expect(screen.findByTestId('machine-detail-name-input')?.props.value).toBe('My Machine');
        await act(async () => screen.changeTextByTestId('machine-detail-name-input', '  theo-devbox  '));
        expect(metadataTransportSpy).not.toHaveBeenCalled();
        expect(promptSpy).not.toHaveBeenCalled();
        await pressNameSave(screen);
        // The save runs through the real Action executor; wait for its one metadata write and store apply.
        await vi.waitFor(() => expect(metadataTransportSpy).toHaveBeenCalledTimes(1));
        const request = metadataTransportSpy.mock.calls[0]?.[1];
        expect(request).toMatchObject({ machineId: 'machine-1', expectedVersion: 1 });
        expect(decodePlainMachineStoredContent(request!.metadata)).toMatchObject({ displayName: 'theo-devbox', host: 'host' });
        await vi.waitFor(async () => expect((await readVisibleMachine())?.metadata?.displayName).toBe('theo-devbox'));
        expect((await readVisibleMachine())?.metadataVersion).toBe(2);
        expect(screen.findByTestId('machine-detail-name-input')).toBeNull();
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('cancels and retires the inline rename draft when the machine identity changes', async () => {
        const { MachinePageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachinePageScreen');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await act(async () => findHeaderMenuAction(screen, 'machine-detail-menu-rename')!.onSelect());
        expect(screen.findByTestId('machine-detail-name-input')).toBeTruthy();
        await act(async () => screen.changeTextByTestId('machine-detail-name-input', 'not saved'));
        await screen.pressByTestIdAsync('machine-detail-name-cancel');
        expect(screen.findByTestId('machine-detail-name-input')).toBeNull();
        await act(async () => findHeaderMenuAction(screen, 'machine-detail-menu-rename')!.onSelect());
        expect(screen.findByTestId('machine-detail-name-input')?.props.value).toBe('My Machine');
        routeParams.id = 'machine-2';
        machineState.currentMachine = machineState.machinesByServerId['server-a']![1];
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { AuthProvider } = await import('@/auth/context/AuthContext');
        await publishMachineFixture();
        const currentScreen = () => React.createElement(AuthProvider, { initialCredentials: accountConnection!.credentials,
            children: React.createElement(AppPaneProvider, null, React.createElement(MachineDetailScreen)) });
        await screen.update(currentScreen());
        expect(screen.findByTestId('machine-detail-name-input')).toBeNull();
        await act(async () => findHeaderMenuAction(screen, 'machine-detail-menu-rename')!.onSelect());
        expect(screen.findByTestId('machine-detail-name-input')?.props.value).toBe('Replacement Machine');
        // The same machine id on another Home is a different editing target.
        routeParams.serverId = 'server-b';
        await screen.update(currentScreen());
        expect(screen.findByTestId('machine-detail-name-input')).toBeNull();
        expect(metadataTransportSpy).not.toHaveBeenCalled();
    });

    it('keeps the inline rename draft available after a save error and refreshes machine metadata', async () => {
        metadataTransportSpy.mockRejectedValueOnce(new Error('rename transport failed'));
        const { MachinePageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachinePageScreen');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await act(async () => findHeaderMenuAction(screen, 'machine-detail-menu-rename')!.onSelect());
        expect(screen.findByTestId('machine-detail-name-input')).toBeTruthy();
        await act(async () => screen.changeTextByTestId('machine-detail-name-input', 'Retry name'));
        await pressNameSave(screen);
        expect(alertSpy).toHaveBeenCalledWith('common.error', 'rename transport failed');
        expect(machineState.requests.filter(request => request.path === '/v1/machines').length).toBeGreaterThan(1);
        expect(screen.findByTestId('machine-detail-name-input')?.props.value).toBe('Retry name');
        expect(screen.findByTestId('machine-detail-name-input')?.props.editable).toBe(true);
    });

    it('clears a custom machine name by saving an empty inline rename draft', async () => {
        const { MachinePageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachinePageScreen');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await act(async () => findHeaderMenuAction(screen, 'machine-detail-menu-rename')!.onSelect());
        expect(screen.findByTestId('machine-detail-name-input')).toBeTruthy();
        await act(async () => screen.changeTextByTestId('machine-detail-name-input', '  '));
        await pressNameSave(screen);
        await vi.waitFor(() => expect(metadataTransportSpy).toHaveBeenCalledTimes(1));
        await vi.waitFor(async () => expect((await readVisibleMachine())?.metadata?.displayName).toBeUndefined());
        const request = metadataTransportSpy.mock.calls[0]?.[1];
        expect(request).toMatchObject({ machineId: 'machine-1', expectedVersion: 1 });
        expect(decodePlainMachineStoredContent(request!.metadata)).not.toHaveProperty('displayName');
    });

    it('clears the Windows launch preference through metadata without retaining the legacy override', async () => {
        machineState.currentMachine = { ...machineState.currentMachine, metadata: MachinePublishedMetadataV1Schema.parse({
            ...createMachineFixture().metadata, ...machineState.currentMachine.metadata, platform: 'win32', windowsRemoteSessionLaunchMode: 'console',
            windowsRemoteSessionConsole: 'visible',
        }) };
        routeParams.page = 'terminal';
        const { MachineSubPageScreen } = await import('@/components/machines/page/MachineSubPageScreen');
        const screen = await renderScreen(React.createElement(MachineSubPageScreen));
        const override = () => screen.findAll(node => node.props?.title === 'machine.windows.remoteSessionModeOverrideTitle'
            && typeof node.props?.onPress === 'function')[0];
        await vi.waitFor(async () => {
            await act(async () => {});
            expect({
                platform: (await readVisibleMachine())?.metadata?.platform,
                terminalHeader: Boolean(screen.findByTestId('machine-sub-page-header-terminal')),
                titles: Array.from(new Set(screen.findAll(node => typeof node.props?.title === 'string')
                    .map(node => node.props.title))),
            }).toMatchObject({
                platform: 'win32', terminalHeader: true,
                titles: expect.arrayContaining(['machine.windows.remoteSessionModeOverrideTitle']),
            });
        });
        await act(async () => { await override().props.onPress(); });
        expect(alertSpy).not.toHaveBeenCalled();
        expect(metadataTransportSpy).toHaveBeenCalled();
        const metadata = (await readVisibleMachine())?.metadata;
        expect(metadata).toMatchObject({ displayName: 'My Machine', platform: 'win32' });
        expect(metadata).not.toHaveProperty('windowsRemoteSessionLaunchMode');
        expect(metadata).not.toHaveProperty('windowsRemoteSessionConsole');
    });

    it('persists per-Machine host and tmux choices through the declared setting and clears both maps', async () => {
        machineState.settings.sessionTerminalHost = 'tmux';
        const neighbor = { useTmux: false, sessionName: 'Neighbor session', isolated: true, tmpDir: '/tmp/neighbor-tmux' };
        machineState.settings.sessionTerminalHostByMachineId = { 'machine-2': 'zellij' };
        machineState.settings.sessionTmuxByMachineId = { 'machine-2': neighbor };
        const { MachineTerminalSettingsSection } = await import('@/components/machines/terminal/MachineTerminalSettingsSection');
        const screen = await renderMachineSection(React.createElement(MachineTerminalSettingsSection, {
            machineId: 'machine-1', serverId: machineState.serverId, tmuxAvailable: true,
        }));
        const override = () => screen.findAll(node => node.props?.title === 'machine.tmux.overrideTitle'
            && typeof node.props?.onPress === 'function')[0];
        await act(async () => {
            override().props.onPress();
            await vi.waitFor(() => expect(machineState.settings.sessionTmuxByMachineId, JSON.stringify({
                alerts: alertSpy.mock.calls,
                requests: machineState.requests.map(({ path, method }) => ({ path, method })),
            })).toMatchObject({ 'machine-1': { useTmux: true } }));
        });
        expect(machineState.settings.sessionTmuxByMachineId).toMatchObject({ 'machine-1': { useTmux: true } });
        expect(machineState.settings.sessionTmuxByMachineId).toMatchObject({ 'machine-2': neighbor });
        await act(async () => {
            const sessionName = screen.findAll(node => node.props?.accessibilityLabel === 'profiles.tmuxSession'
                && typeof node.props?.onChangeText === 'function')[0];
            sessionName.props.onChangeText('Selected session');
        });
        // SettingTextInput keeps keystrokes local and commits the gesture on blur.
        await act(async () => {
            const sessionName = screen.findAll(node => node.props?.accessibilityLabel === 'profiles.tmuxSession'
                && typeof node.props?.onBlur === 'function')[0];
            await sessionName.props.onBlur();
        });
        await vi.waitFor(() => expect(machineState.settings.sessionTmuxByMachineId).toMatchObject({
            'machine-1': { useTmux: true, sessionName: 'Selected session' }, 'machine-2': neighbor,
        }));
        await act(async () => {
            override().props.onPress();
            await vi.waitFor(() => expect(machineState.settings.sessionTmuxByMachineId).not.toHaveProperty('machine-1'));
        });
        expect(machineState.settings.sessionTmuxByMachineId).not.toHaveProperty('machine-1');
        expect(machineState.settings.sessionTerminalHostByMachineId).toEqual({ 'machine-2': 'zellij' });
        expect(machineState.settings.sessionTmuxByMachineId).toEqual({ 'machine-2': neighbor });
        expect(machineState.settingsWrites).toHaveLength(3);
    });

    it('revokes the machine through its UI policy waiver without a local confirmation', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        machineState.settings = { providerSettingsV1: ProviderSettingsV1Schema.parse({
            ...DEFAULT_PROVIDER_SETTINGS_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/gateway' },
                role: 'default', displayName: 'Gateway', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }],
            machineGrants: ['machine-1', 'machine-2'].map(machineId => ({ v: 1, machineId, connectionId: 'pc_a',
                endpointSetFingerprint: 'endpoint-set:v1:a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1 })),
        }) };
        publishProviderCatalogFixture();
        machineState.settings.actionsSettingsV1 = { v: 1, approvalWaivedSurfaces: { 'machines.remove': ['ui'] } };

        // Remove machine closes the Details sub-page.
        routeParams.page = 'details';
        const { MachineSubPageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachineSubPageScreen');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        const removeItem = findRemoveMachineButton(screen);
        expect(removeItem).toBeTruthy();
        expect(typeof removeItem.onPress).toBe('function');

        await act(async () => {
            await removeItem.onPress();
            await vi.waitFor(() => expect(machineState.requests.find(request => request.path.endsWith('/revoke'))).toBeTruthy());
            await vi.waitFor(() => expect(machineState.providerCatalogWrites).toHaveLength(1));
            expect(alertSpy).not.toHaveBeenCalled();
            await vi.waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/settings/machines'));
        });

        expect(confirmSpy).not.toHaveBeenCalled();
        expect((await readVisibleMachine())?.revokedAt).toBeGreaterThan(0);
        const saved = machineState.providerCatalog!;
        expect(saved.machineGrants.map(grant => grant.machineId)).toEqual(['machine-2']);
        expect(machineState.providerCatalogWrites).toHaveLength(1);
        expect(machineState.requests.find(request => request.path.endsWith('/revoke'))).toMatchObject({ method: 'POST' });
    });

    it('keeps the user on the screen and explains retry when Provider cleanup remains pending', async () => {
        machineState.settings = { providerSettingsV1: ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/gateway' },
                role: 'default', displayName: 'Gateway', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }],
            machineGrants: [{ v: 1, machineId: 'machine-1', connectionId: 'pc_a',
                endpointSetFingerprint: 'endpoint-set:v1:a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1 }],
        }) };
        machineState.settings.actionsSettingsV1 = { v: 1, approvalWaivedSurfaces: { 'machines.remove': ['ui'] } };
        publishProviderCatalogFixture();
        machineState.settingsWriteFailure = true;

        // Remove machine closes the Details sub-page.
        routeParams.page = 'details';
        const { MachineSubPageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachineSubPageScreen');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        const removeItem = findRemoveMachineButton(screen);

        await act(async () => {
            await removeItem.onPress();
            await vi.waitFor(() => expect(alertSpy).toHaveBeenCalled());
        });

        expect(alertSpy).toHaveBeenCalledWith(
            'common.error',
            'settingsProviders.errors.machineCleanupPendingDescription',
        );
        expect((await readVisibleMachine())?.revokedAt).toBeGreaterThan(0);
        expect(machineState.providerCatalog!.machineGrants).toHaveLength(1);
        expect(routerMock.replace).not.toHaveBeenCalled();

        const retryItem = findRemoveMachineButton(screen);
        expect(retryItem.disabled).toBe(false);
        machineState.settingsWriteFailure = false;
        await act(async () => {
            await retryItem.onPress();
            await vi.waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/settings/machines'));
        });

        expect(machineState.requests.filter(request => request.path.endsWith('/revoke'))).toHaveLength(2);
        expect(machineState.providerCatalog!.machineGrants).toEqual([]);
        expect(routerMock.replace).toHaveBeenCalledTimes(1);
    });

    it('restores cleanup retry actionability from durable Provider machine state after remount', async () => {
        machineState.currentMachine = { ...machineState.currentMachine, revokedAt: Date.now() };
        machineState.machinesByServerId = { 'server-a': [machineState.currentMachine] };
        machineState.settings = {
            providerSettingsV1: {
                v: 1,
                connections: [{
                    v: 1,
                    id: 'pc_a',
                    source: { kind: 'contribution', contributionKey: 'plugin/gateway' },
                    role: 'default',
                    displayName: 'Gateway',
                    displayNameMode: 'automatic',
                    revision: 0,
                    createdAt: 1,
                    updatedAt: 1,
                }],
                connectionTombstones: [],
                accountGrants: [],
                machineGrants: [{
                    v: 1,
                    machineId: 'machine-1',
                    connectionId: 'pc_a',
                    endpointSetFingerprint: 'endpoint-set:v1:a',
                    connectionSecurityFingerprint: 'connection-security:v1:a',
                    confirmedAt: 1,
                }],
                secretBindingsByConnectionId: {},
                manualModelsByConnectionId: {},
                modelVisibilityByRef: {},
                defaultsByAgentTargetKey: {},
                experimentalBindingConfirmations: [],
            },
        };
        machineState.settings.actionsSettingsV1 = { v: 1, approvalWaivedSurfaces: { 'machines.remove': ['ui'] } };
        publishProviderCatalogFixture();

        // Remove machine closes the Details sub-page.
        routeParams.page = 'details';
        const { MachineSubPageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachineSubPageScreen');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        const retryItem = findRemoveMachineButton(screen);

        // The consequence under the button explains that removal can be retried.
        expect(screen.getTextContent()).toContain('settingsProviders.errors.machineCleanupPendingDescription');
        expect(retryItem.disabled).toBe(false);
        await act(async () => {
            await retryItem.onPress();
            await vi.waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/settings/machines'));
        });
        expect(machineState.providerCatalog!.machineGrants).toEqual([]);
    });

    it('renders one replacement repair action that opens a candidate picker', async () => {
        machineState.machinesByServerId = {
            'server-a': [
                machineState.currentMachine,
                ...Array.from({ length: 5 }, (_, index) => ({
                    id: `machine-${index + 2}`,
                    active: index === 0,
                    activeAt: Date.now() - index,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    seq: 0,
                    metadata: MachinePublishedMetadataV1Schema.parse({ ...createMachineFixture().metadata,
                        displayName: index % 2 === 0 ? 'leeroy-mbp' : 'L-C-005', host: 'replacement', platform: 'darwin' }),
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                    revokedAt: null,
                })),
            ],
        };

        const { MachinePageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachinePageScreen');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        expect(findHeaderMenuAction(screen, 'machine-replacement-repair-undo')).toBeUndefined();
        const replacementItem = findHeaderMenuAction(screen, 'machine-replacement-repair-open');
        expect(replacementItem).toBeTruthy();

        await act(async () => {
            replacementItem!.onSelect();
        });

        expect(showSpy).toHaveBeenCalledTimes(1);
        const showOptions = showSpy.mock.calls[0]?.[0];
        expect(showOptions).toMatchObject({
            props: expect.objectContaining({
                onSelectCandidate: expect.any(Function),
            }),
            chrome: expect.objectContaining({
                testID: 'machine-replacement-picker-modal',
                scrollHost: 'bounded',
            }),
        });
        expect(showOptions?.chrome).not.toHaveProperty('layout');
        expect(readReplacementPickerProps()?.candidates).toHaveLength(5);
        // Same-named candidates are told apart by the machine naming owner.
        const labels = readReplacementPickerProps()!.candidates.map((candidate) => candidate.label);
        expect(new Set(labels).size).toBe(5);
        expect(machineState.requests.filter(request => request.path.endsWith('/replacement'))).toEqual([]);
    });

    it('opens the replacement picker with candidates regardless of spawn readiness', async () => {
        machineState.machinesByServerId['server-a'] = machineState.machinesByServerId['server-a']!.map((machine) =>
            machine.id === 'machine-2'
                ? { ...machine, active: false, activeAt: 0 }
                : machine,
        );
        machineState.machinesByServerId['server-loading'] = null;

        const { MachinePageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachinePageScreen');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        const replacementItem = findHeaderMenuAction(screen, 'machine-replacement-repair-open');
        expect(replacementItem).toBeTruthy();

        await act(async () => {
            replacementItem!.onSelect();
        });

        expect(readReplacementPickerProps()?.candidates).toEqual([
            expect.objectContaining({ id: 'machine-2' }),
        ]);
    });

    it.each(['machines.replacement.set', 'machines.replacement.clear'] as const)('honors disabled %s policy at the mounted header instead of submitting a parallel HTTP mutation', async actionId => {
        confirmSpy.mockResolvedValue(true);
        machineState.settings.actionsSettingsV1 = { v: 1, actions: { [actionId]: { enabled: false } } };
        if (actionId.endsWith('clear')) {
            machineState.currentMachine = { ...machineState.currentMachine, replacedByMachineId: 'machine-2' };
        }
        const { MachinePageScreen } = await import('@/components/machines/page/MachinePageScreen');
        const screen = await renderScreen(React.createElement(MachinePageScreen));
        await act(async () => {
            findHeaderMenuAction(screen, actionId.endsWith('set') ? 'machine-replacement-repair-open' : 'machine-replacement-repair-undo')!.onSelect();
            if (actionId.endsWith('set')) readReplacementPickerProps()?.onSelectCandidate('machine-2', 'Replacement Machine');
            await vi.waitFor(() => expect(alertSpy).toHaveBeenCalled());
        });
        expect(machineState.requests.filter(request => request.path.endsWith('/replacement'))).toEqual([]);
        expect((await readVisibleMachine())?.replacedByMachineId ?? null).toBe(actionId.endsWith('clear') ? 'machine-2' : null);
    });

    it.each(['machines.replacement.set', 'machines.replacement.clear', 'machines.remove', 'machines.daemon.stop'] as const)(
        'routes explicit Require Ask, rejection and approval for %s through the mounted continuation', async actionId => {
        machineState.settings.actionsSettingsV1 = { v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] },
            actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } };
        if (actionId === 'machines.replacement.clear') machineState.currentMachine = { ...machineState.currentMachine, replacedByMachineId: 'machine-2' };
        routeParams.page = actionId === 'machines.remove' ? 'details' : actionId === 'machines.daemon.stop' ? 'doctor' : undefined;
        const { MachinePageScreen } = await import('@/components/machines/page/MachinePageScreen');
        const { MachineSubPageScreen } = await import('@/components/machines/page/MachineSubPageScreen');
        const screen = await renderMachineSection(React.createElement(routeParams.page ? MachineSubPageScreen : MachinePageScreen));
        const invoke = () => {
            if (actionId === 'machines.remove') findRemoveMachineButton(screen).onPress();
            else if (actionId === 'machines.daemon.stop') screen.findAll(node => node.props?.testID === 'machine-detail-stop-daemon-button'
                && typeof node.props?.onPress === 'function')[0]!.props.onPress();
            else {
                findHeaderMenuAction(screen, actionId.endsWith('set') ? 'machine-replacement-repair-open' : 'machine-replacement-repair-undo')!.onSelect();
                if (actionId.endsWith('set')) readReplacementPickerProps()?.onSelectCandidate('machine-2', 'Replacement Machine');
            }
        };
        const effects = () => [...machineState.daemonStops, ...machineState.requests.filter(request => request.method !== 'GET'
            && (request.path.endsWith('/replacement') || request.path.endsWith('/revoke')))];
        await act(async () => invoke());
        await vi.waitFor(async () => {
            await act(async () => {});
            expect({ artifacts: artifactStore.list().length, effects: effects(), alerts: alertSpy.mock.calls,
                paths: machineState.requests.map(request => `${request.method} ${request.path}`) }).toMatchObject({ artifacts: 1 });
        });
        expect(effects()).toEqual([]);
        expect(confirmSpy).not.toHaveBeenCalled();
        const rejectedId = artifactStore.list()[0]!.id;
        await expect(decideApprovalAsInbox(machineState.serverId, rejectedId, 'reject')).resolves.toMatchObject({ ok: true });
        await vi.waitFor(() => {
            if (actionId === 'machines.remove') expect(findRemoveMachineButton(screen).disabled).toBe(false);
            else if (actionId === 'machines.daemon.stop') expect(screen.findAll(node => node.props?.testID === 'machine-detail-stop-daemon-button'
                && typeof node.props?.onPress === 'function')[0]!.props.loading).toBe(false);
            else expect(findHeaderMenuAction(screen, actionId.endsWith('set') ? 'machine-replacement-repair-open' : 'machine-replacement-repair-undo')!.loading).toBe(false);
        });
        expect(alertSpy).not.toHaveBeenCalled();
        expect(effects()).toEqual([]);
        await act(async () => invoke());
        await vi.waitFor(() => expect(artifactStore.list()).toHaveLength(2));
        expect(effects()).toEqual([]);
        const approvedId = artifactStore.list()[1]!.id;
        const approved = await decideApprovalAsInbox(machineState.serverId, approvedId, 'approve');
        expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(effects()).toHaveLength(1));
        if (actionId === 'machines.remove') expect(effects()).toEqual([expect.objectContaining({ method: 'POST', path: '/v1/machines/machine-1/revoke' })]);
        else if (actionId === 'machines.daemon.stop') expect(machineState.daemonStops).toEqual([expect.objectContaining({ method: `machine-1:${RPC_METHODS.STOP_DAEMON}` })]);
        else expect(effects()).toEqual([expect.objectContaining({ method: actionId.endsWith('set') ? 'POST' : 'DELETE', path: '/v1/machines/machine-1/replacement' })]);
        if (actionId === 'machines.remove') await vi.waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/settings/machines'));
        else if (actionId !== 'machines.daemon.stop') await vi.waitFor(async () => expect((await readVisibleMachine())?.replacedByMachineId).toBe(actionId.endsWith('set') ? 'machine-2' : null));
    });

    it.each(['machines.replacement.set', 'machines.replacement.clear'] as const)(
        'applies default and reset %s directly for the present user', async actionId => {
        if (actionId === 'machines.replacement.clear') machineState.currentMachine = { ...machineState.currentMachine, replacedByMachineId: 'machine-2' };
        const { MachinePageScreen } = await import('@/components/machines/page/MachinePageScreen');
        const screen = await renderMachineSection(React.createElement(MachinePageScreen));
        const invoke = () => {
            findHeaderMenuAction(screen, actionId.endsWith('set') ? 'machine-replacement-repair-open' : 'machine-replacement-repair-undo')!.onSelect();
            if (actionId.endsWith('set')) readReplacementPickerProps()?.onSelectCandidate('machine-2', 'Replacement Machine');
        };
        const effects = () => machineState.requests.filter(request => request.method !== 'GET' && request.path.endsWith('/replacement'));
        confirmSpy.mockResolvedValue(false);
        await act(async () => invoke());
        await vi.waitFor(() => expect(effects()).toHaveLength(1));
        expect(effects()[0]).toMatchObject(actionId.endsWith('set')
            ? { method: 'POST', body: { replacementMachineId: 'machine-2', confirmActiveOldMachine: true } }
            : { method: 'DELETE' });
        expect((await readVisibleMachine())?.replacedByMachineId).toBe(actionId.endsWith('set') ? 'machine-2' : null);
        machineState.currentMachine = { ...machineState.currentMachine, replacedByMachineId: actionId.endsWith('set') ? null : 'machine-2' };
        machineState.settings.actionsSettingsV1 = { v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } };
        await publishMachineFixture();
        machineState.settings.actionsSettingsV1 = { v: 1 };
        await publishMachineFixture();
        await act(async () => invoke());
        await vi.waitFor(() => expect(effects()).toHaveLength(2));
        expect((await readVisibleMachine())?.replacedByMachineId).toBe(actionId.endsWith('set') ? 'machine-2' : null);
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(artifactStore.list()).toEqual([]);
    });

    it('honors default Ask and reset for machines.remove at the canonical confirmation owner', async () => {
        const actionId = 'machines.remove';
        routeParams.page = 'details';
        const { MachineSubPageScreen } = await import('@/components/machines/page/MachineSubPageScreen');
        const screen = await renderMachineSection(React.createElement(MachineSubPageScreen));
        const invoke = () => findRemoveMachineButton(screen).onPress();
        const effects = () => machineState.requests.filter(request => request.method === 'POST' && request.path.endsWith('/revoke'));
        confirmSpy.mockResolvedValueOnce(false);
        await act(async () => invoke());
        await vi.waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(findRemoveMachineButton(screen).disabled).toBe(false));
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(effects()).toEqual([]);
        expect(alertSpy).not.toHaveBeenCalled();
        machineState.settings.actionsSettingsV1 = { v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } };
        await publishMachineFixture();
        machineState.settings.actionsSettingsV1 = { v: 1 };
        await publishMachineFixture();
        confirmSpy.mockResolvedValueOnce(true);
        await act(async () => invoke());
        await vi.waitFor(() => expect(effects()).toHaveLength(1));
        expect(confirmSpy).toHaveBeenCalledTimes(2);
        expect(artifactStore.list()).toEqual([]);
    });

    it('shows a typed Remove refusal through the existing Action outcome presenter', async () => {
        routeParams.page = 'details';
        confirmSpy.mockResolvedValueOnce(true);
        machineState.revokeFailure = { status: 403, error: 'permission_denied' };
        const { MachineSubPageScreen } = await import('@/components/machines/page/MachineSubPageScreen');
        const screen = await renderMachineSection(React.createElement(MachineSubPageScreen));
        await act(async () => findRemoveMachineButton(screen).onPress());
        await vi.waitFor(() => expect(alertSpy.mock.calls.some(call => call[1] === 'permission_denied')).toBe(true));
        expect((await readVisibleMachine())?.revokedAt).toBeNull();
        expect(machineState.providerCatalogWrites).toEqual([]);
    });

    it('names an unnamed replacement as unnamed, never by its id', async () => {
        machineState.machinesByServerId['server-a'] = machineState.machinesByServerId['server-a']!.map((machine) =>
            machine.id === 'machine-2' ? { ...machine, metadata: MachinePublishedMetadataV1Schema.parse({
                ...createMachineFixture().metadata, host: '', platform: 'darwin' }) } : machine,
        );
        machineState.currentMachine = { ...machineState.currentMachine, replacedByMachineId: 'machine-2' };
        machineState.machinesByServerId['server-a'] = machineState.machinesByServerId['server-a']!.map((machine) =>
            machine.id === 'machine-1' ? machineState.currentMachine : machine,
        );

        const { MachinePageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachinePageScreen');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        const text = screen.getTextContent();
        expect(text).toContain('machineDetailPage.replacedByFact(machine=machine.unnamedMachine)');
        expect(text).not.toContain('machine=machine-2');
    });
});

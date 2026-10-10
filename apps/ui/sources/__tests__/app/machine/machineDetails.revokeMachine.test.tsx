import React from 'react';
// Keep browser persistence owners real above IndexedDB's environment boundary.
import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen as renderScreenWithProviders } from '@/dev/testkit';
import { installMachineDetailsCommonModuleMocks } from './machineDetailsTestHelpers';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { decodePlainMachineStoredContent, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    DEFAULT_PROVIDER_SETTINGS_V1, ProviderSettingsV1Schema } from '@happier-dev/protocol';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { MachineUpdateMetadataRequest, MachineUpdateMetadataResponse } from '@happier-dev/protocol';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineReplacementPickerModalProps } from '@/components/machines/MachineReplacementPickerModal';

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
        requests: [] as Array<{ path: string; method: string; body: unknown }>,
        serverId: '',
    },
    alertSpy: vi.fn(),
    promptSpy: vi.fn<typeof import('@/modal').Modal.prompt>(async () => null),
    metadataTransportSpy: vi.fn<(_event: string, _request: MachineUpdateMetadataRequest) => Promise<MachineUpdateMetadataResponse>>(),
    routeParams: { id: 'machine-1', serverId: undefined as string | undefined },
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
    storage: async (importOriginal) => importOriginal(),
});

vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/constants/Typography');
installDisconnectedServerSocketBoundary((socket) => {
    socket.connected = true;
    socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, request: unknown) => {
        if (event === 'machine-update-metadata') {
            return metadataTransportSpy(event, request as MachineUpdateMetadataRequest);
        }
        // This fixture has no installed daemon contributions or execution runs.
        if (event === SOCKET_RPC_EVENTS.CALL && request && typeof request === 'object' && 'method' in request) {
            const method = String(request.method);
            if (method.endsWith(`:${RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST}`)) return { ok: true, result: { runs: [] } };
            return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        }
        throw new Error(`Unexpected machine fixture Socket event: ${String(event)}`);
    });
});

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

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
    if (path === '/v1/artifacts') return Response.json([]);
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
    const machines = (machineState.machinesByServerId['server-a'] ?? []).map(machine =>
        machine.id === machineState.currentMachine.id ? machineState.currentMachine : machine);
    const publishedMachines = machines.map(machine => ({
        ...createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a' }),
        ...machine, storageMode: 'plain',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        // These page fixtures vary presentation fields, but the Home emits complete published metadata.
        metadata: encodePlainMachineStoredContent(machine.metadata === null ? null : {
            ...createMachineFixture().metadata, host: '', ...machine.metadata,
        }), daemonState: null }));
    if (path === '/v1/machines') return Response.json(publishedMachines);
    if (path === '/v1/machines/machine-1/revoke' && method === 'POST') {
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
            applyMachines: storage.getState().applyMachines, replace: true });
    });
}

async function readVisibleMachine() {
    const { storage } = await import('@/sync/domains/state/storage');
    return storage.getState().machines[routeParams.id];
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

/** The page's closing destructive button (a quiet button row, not a row in a sheet). */
function findRemoveMachineButton(screen: RenderedScreen) {
    return screen.findAll((node) => node.props?.testID === 'machine-detail-remove' && typeof node.props?.onPress === 'function')[0]?.props;
}

/** A rare operation in the page header's `⋯` menu, by its test id. */
function findHeaderMenuAction(screen: RenderedScreen, testID: string) {
    const menus = screen.findAll((node) => node.props?.testID === 'machine-detail-menu' && Array.isArray(node.props?.actions));
    return menus.flatMap((menu) => menu.props.actions as Array<{ testID?: string; onSelect: () => void }>).find((action) => action.testID === testID);
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
            metadata: { displayName: 'My Machine', host: 'host', platform: 'darwin' },
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
                    metadata: { displayName: 'Replacement Machine', host: 'replacement', platform: 'darwin' },
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
        machineState.requests = [];
        accountConnection = await restoreServerAccountForTest({ serverUrl: 'https://machine-home.example.test',
            accountId: 'account-a', request: serveMachineHome });
        machineState.serverId = accountConnection.home.id;
    });

    afterEach(async () => { await act(async () => { await accountConnection?.dispose(); }); accountConnection = undefined; });

    it('updates the visible machine name only after saving the inline rename draft', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

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
        await screen.pressByTestIdAsync('machine-detail-name-save');
        const request = metadataTransportSpy.mock.calls[0]?.[1];
        expect(request).toMatchObject({ machineId: 'machine-1', expectedVersion: 1 });
        expect(decodePlainMachineStoredContent(request!.metadata)).toMatchObject({ displayName: 'theo-devbox', host: 'host' });
        expect((await readVisibleMachine())?.metadata?.displayName).toBe('theo-devbox');
        expect((await readVisibleMachine())?.metadataVersion).toBe(2);
        expect(screen.findByTestId('machine-detail-name-input')).toBeNull();
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('cancels and retires the inline rename draft when the machine identity changes', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
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
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await act(async () => findHeaderMenuAction(screen, 'machine-detail-menu-rename')!.onSelect());
        expect(screen.findByTestId('machine-detail-name-input')).toBeTruthy();
        await act(async () => screen.changeTextByTestId('machine-detail-name-input', 'Retry name'));
        await screen.pressByTestIdAsync('machine-detail-name-save');
        expect(alertSpy).toHaveBeenCalledWith('common.error', 'rename transport failed');
        expect(machineState.requests.filter(request => request.path === '/v1/machines').length).toBeGreaterThan(1);
        expect(screen.findByTestId('machine-detail-name-input')?.props.value).toBe('Retry name');
        expect(screen.findByTestId('machine-detail-name-input')?.props.editable).toBe(true);
    });

    it('clears a custom machine name by saving an empty inline rename draft', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await act(async () => findHeaderMenuAction(screen, 'machine-detail-menu-rename')!.onSelect());
        expect(screen.findByTestId('machine-detail-name-input')).toBeTruthy();
        await act(async () => screen.changeTextByTestId('machine-detail-name-input', '  '));
        await screen.pressByTestIdAsync('machine-detail-name-save');
        expect((await readVisibleMachine())?.metadata?.displayName).toBeUndefined();
        const request = metadataTransportSpy.mock.calls[0]?.[1];
        expect(request).toMatchObject({ machineId: 'machine-1', expectedVersion: 1 });
        expect(decodePlainMachineStoredContent(request!.metadata)).not.toHaveProperty('displayName');
    });

    it('confirms and revokes the machine', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        machineState.settings = { providerSettingsV1: ProviderSettingsV1Schema.parse({
            ...DEFAULT_PROVIDER_SETTINGS_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/gateway' },
                role: 'default', displayName: 'Gateway', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }],
            machineGrants: ['machine-1', 'machine-2'].map(machineId => ({ v: 1, machineId, connectionId: 'pc_a',
                endpointSetFingerprint: 'endpoint-set:v1:a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1 })),
        }) };

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        const removeItem = findRemoveMachineButton(screen);
        expect(removeItem).toBeTruthy();
        expect(typeof removeItem.onPress).toBe('function');

        await act(async () => {
            await removeItem.onPress();
            await vi.waitFor(() => expect(routerBackSpy).toHaveBeenCalled());
        });

        expect(confirmSpy).toHaveBeenCalled();
        expect((await readVisibleMachine())?.revokedAt).toBeGreaterThan(0);
        const saved = ProviderSettingsV1Schema.parse(machineState.settings.providerSettingsV1);
        expect(saved.machineGrants.map(grant => grant.machineId)).toEqual(['machine-2']);
        const { storage } = await import('@/sync/domains/state/storage');
        expect(storage.getState().settings.providerSettingsV1).toEqual(saved);
        expect(machineState.settingsWrites).toHaveLength(1);
        expect(machineState.requests.find(request => request.path.endsWith('/revoke'))).toMatchObject({ method: 'POST' });
    });

    it('keeps the user on the screen and explains retry when Provider cleanup remains pending', async () => {
        machineState.settings = { providerSettingsV1: ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/gateway' },
                role: 'default', displayName: 'Gateway', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }],
            machineGrants: [{ v: 1, machineId: 'machine-1', connectionId: 'pc_a',
                endpointSetFingerprint: 'endpoint-set:v1:a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1 }],
        }) };
        machineState.settingsWriteFailure = true;

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
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
        expect(ProviderSettingsV1Schema.parse(machineState.settings.providerSettingsV1).machineGrants).toHaveLength(1);
        expect(routerBackSpy).not.toHaveBeenCalled();

        const retryItem = findRemoveMachineButton(screen);
        expect(retryItem.disabled).toBe(false);
        machineState.settingsWriteFailure = false;
        await act(async () => {
            await retryItem.onPress();
            await vi.waitFor(() => expect(routerBackSpy).toHaveBeenCalled());
        });

        expect(machineState.requests.filter(request => request.path.endsWith('/revoke'))).toHaveLength(2);
        expect(ProviderSettingsV1Schema.parse(machineState.settings.providerSettingsV1).machineGrants).toEqual([]);
        expect(routerBackSpy).toHaveBeenCalledTimes(1);
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

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        const retryItem = findRemoveMachineButton(screen);

        // The consequence under the button explains that removal can be retried.
        expect(screen.getTextContent()).toContain('settingsProviders.errors.machineCleanupPendingDescription');
        expect(retryItem.disabled).toBe(false);
        await act(async () => {
            await retryItem.onPress();
            await vi.waitFor(() => expect(routerBackSpy).toHaveBeenCalled());
        });
        expect(ProviderSettingsV1Schema.parse(machineState.settings.providerSettingsV1).machineGrants).toEqual([]);
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
                    metadata: { displayName: index % 2 === 0 ? 'leeroy-mbp' : 'L-C-005', host: 'replacement', platform: 'darwin' },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                    revokedAt: null,
                })),
            ],
        };

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

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
                scrollHost: 'body',
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

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

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

    it('selects a replacement candidate from the picker', async () => {
        confirmSpy.mockResolvedValueOnce(true);

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        const replacementItem = findHeaderMenuAction(screen, 'machine-replacement-repair-open');
        expect(replacementItem).toBeTruthy();

        await act(async () => {
            replacementItem!.onSelect();
            readReplacementPickerProps()?.onSelectCandidate('machine-2', 'Replacement Machine');
            await vi.waitFor(() => expect(machineState.currentMachine.replacedByMachineId).toBe('machine-2'));
        });

        expect(confirmSpy).toHaveBeenCalled();
        expect(machineState.requests.find(request => request.path.endsWith('/replacement'))).toMatchObject({
            method: 'POST', body: { replacementMachineId: 'machine-2', confirmActiveOldMachine: true },
        });
        expect((await readVisibleMachine())?.replacedByMachineId).toBe('machine-2');
    });

    it('names an unnamed replacement as unnamed, never by its id', async () => {
        machineState.machinesByServerId['server-a'] = machineState.machinesByServerId['server-a']!.map((machine) =>
            machine.id === 'machine-2' ? { ...machine, metadata: { platform: 'darwin' } } : machine,
        );
        machineState.currentMachine = { ...machineState.currentMachine, replacedByMachineId: 'machine-2' };
        machineState.machinesByServerId['server-a'] = machineState.machinesByServerId['server-a']!.map((machine) =>
            machine.id === 'machine-1' ? machineState.currentMachine : machine,
        );

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        const text = screen.getTextContent();
        expect(text).toContain('machineDetailPage.replacedByFact(machine=machine.unnamedMachine)');
        expect(text).not.toContain('machine=machine-2');
    });

    it('clears an existing explicit replacement relation', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        machineState.currentMachine = {
            ...machineState.currentMachine,
            replacedByMachineId: 'machine-2',
        };

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        // The replaced state is a header fact, and undoing it is a rare operation in `⋯`.
        expect(screen.getTextContent()).toContain('machineDetailPage.replacedByFact');
        const undoItem = findHeaderMenuAction(screen, 'machine-replacement-repair-undo');
        expect(undoItem).toBeTruthy();

        await act(async () => {
            undoItem!.onSelect();
            await vi.waitFor(() => expect(machineState.currentMachine.replacedByMachineId).toBeNull());
        });

        expect(confirmSpy).toHaveBeenCalled();
        expect(machineState.requests.find(request => request.path.endsWith('/replacement'))).toMatchObject({ method: 'DELETE' });
        expect((await readVisibleMachine())?.replacedByMachineId).toBeNull();
    });
});

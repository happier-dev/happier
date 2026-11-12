import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpBackendDefinitionV1, AcpCatalogSettingsV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { buildConfiguredAcpAgentSelectionV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { renderSettingsView, type SettingsViewHarness } from '@/dev/testkit/harness/settingsViewHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { getStorage } from '@/sync/domains/state/storage';
import { applyAcpCatalogSnapshot, getAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { refreshAcpCatalog, resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { AcpCatalogRowMutationV1Schema, ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createDeferred } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createHydratedPlainMachineFixture, createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const shared = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    routerReplaceSpy: vi.fn(),
    routerBackSpy: vi.fn(),
    modalAlertSpy: vi.fn(),
    settingsState: { value: { v: 2, backends: [] } as AcpCatalogSettingsV1 },
    writes: [] as AcpCatalogSettingsV1[],
    mutations: [] as ReturnType<typeof AcpCatalogRowMutationV1Schema.parse>[],
    settingsVersion: 1 as number | null,
    refuse: false,
    holdReceipt: false,
    holdRowRead: false,
    failAcknowledgedRefresh: false,
    accountSettings: {} as Record<string, unknown>,
}));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
let scope: { serverId: string; accountId: string };
let disposeConnection: (() => Promise<void>) | undefined;
let receipt: ReturnType<typeof createDeferred<void>>;
let rowRead: ReturnType<typeof createDeferred<void>>;
let revision = 1;
let artifacts: ReturnType<typeof createArtifactStoreBoundary>;
let interleaveBeforeAcknowledgement: (() => Promise<void>) | null = null;
let commandChecks: string[] = [];
let unknownCommandAvailable = false;
let commandMachineInventory: ReturnType<typeof createMachineFixture>[] = [];

await vi.hoisted(async () => {
    const { installAcpCatalogSettingsCommonModuleMocks } = await import('./acpCatalogSettingsTestHelpers');
    installAcpCatalogSettingsCommonModuleMocks({
        modal: async () => {
            const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
            return createModalModuleMock({ confirmResult: true, renderCustomModals: true, spies: { alert: shared.modalAlertSpy } }).module;
        },
        text: async () => {
            const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
            return createTextModuleMock({ translate: (key) => key });
        },
        router: async () => {
            const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
            return createExpoRouterMock({
                pathname: '/settings/agents/custom',
                router: {
                    push: shared.routerPushSpy,
                    replace: shared.routerReplaceSpy,
                    back: shared.routerBackSpy,
                },
            }).module;
        },
        storage: async (importOriginal) => importOriginal(),
    });
});
await import('./AcpBackendEditorScreen');
const { Modal, ModalProvider } = await import('@/modal');
const pendingSaves: Promise<void>[] = [];

const EDITOR = 'settings.acpCatalog.backendEditor';

function input(screen: SettingsViewHarness, testID: string) {
    const node = screen.findAll((candidate) => candidate.props?.testID === testID
        && typeof candidate.props?.onChangeText === 'function')[0];
    if (!node) throw new Error(`No field ${testID}`);
    return node;
}

async function type(screen: SettingsViewHarness, testID: string, text: string) {
    await act(async () => {
        input(screen, testID).props.onChangeText(text);
    });
}

async function press(screen: SettingsViewHarness, testID: string) {
    if (testID === `${EDITOR}.save`) {
        await waitForHomeGovernance(async () => { await flushHookEffects(); expectSaveEnabled(screen); });
    }
    await act(async () => {
        await screen.pressByTestIdAsync(testID);
    });
}

// 02102e614e1 / docs/actions.md:9134: own-UI Ask uses native review, never a self-approval Artifact.
async function startNativeSaveReview(screen: SettingsViewHarness) {
    await waitForHomeGovernance(async () => { await flushHookEffects(); expectSaveEnabled(screen); });
    let saving!: Promise<void>;
    await act(async () => { saving = screen.pressByTestIdAsync(`${EDITOR}.save`); });
    pendingSaves.push(saving);
    await waitForHomeGovernance(async () => {
        await flushHookEffects();
        expect(screen.findHostByTestId('actions.confirmation-review.decision-approve')).not.toBeNull();
    });
    const approve = screen.findAll(node => node.props.testID === 'actions.confirmation-review.decision-approve'
        && typeof node.props.onPress === 'function')[0]?.props.onPress as (() => void) | undefined;
    const reject = screen.findAll(node => node.props.testID === 'actions.confirmation-review.decision-reject'
        && typeof node.props.onPress === 'function')[0]?.props.onPress as (() => void) | undefined;
    const modal = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
    if (!approve || !reject || !modal) throw new Error('Missing native review controls');
    expect(artifacts.list()).toEqual([]);
    expectSavePending(screen, true);
    return { saving, approve, reject, dismiss: () => modal.onRequestClose?.() };
}

async function finishNativeSaveReview(review: Awaited<ReturnType<typeof startNativeSaveReview>>, decision: 'approve' | 'reject' | 'cancel') {
    await act(async () => {
        if (decision === 'cancel') review.dismiss();
        else review[decision]();
        await review.saving;
    });
}

function expectSaveEnabled(screen: SettingsViewHarness) {
    const control = screen.findHostByTestId(`${EDITOR}.save`);
    expect(control).not.toBeNull();
    expect(control?.props.disabled).toBe(false);
    expect(control?.props.accessibilityState?.disabled).toBe(false);
}

function expectSavePending(screen: SettingsViewHarness, pending: boolean) {
    const control = screen.findHostByTestId(`${EDITOR}.save`);
    expect(control?.props.accessibilityState?.busy).toBe(pending);
    // 32238eec816d: busy web openers retain focus; the shared press guard and accessibility state refuse activation.
    if (pending) expect(control?.props.accessibilityState?.disabled).toBe(true);
}

async function waitForSaveSettled(screen: SettingsViewHarness) {
    await waitForHomeGovernance(async () => { await flushHookEffects(); expectSavePending(screen, false); });
}

function errorText(screen: SettingsViewHarness, testID: string): string | null {
    const node = screen.findAll((candidate) => candidate.props?.testID === `${testID}.error`)[0];
    if (!node) return null;
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children);
}

async function renderEditor(backendId: string | null) {
    applyAcpCatalogSnapshot(scope, shared.settingsVersion === null ? { status: 'loading' } : {
        status: 'ready', revision, record: { v: 1, definitions: shared.settingsState.value.backends },
    }, true);
    const { AcpBackendEditorScreen } = await import('./AcpBackendEditorScreen');
    return renderSettingsView(React.createElement(AcpBackendEditorScreen, { backendId }), { wrapper: ModalProvider });
}

const existingKiro = {
    id: 'kiro',
    name: 'kiro',
    title: 'Kiro',
    launch: { kind: 'command' as const, command: 'kiro-cli', args: ['acp'] },
    env: {},
    capabilities: {
        supportsLoadSession: false,
        supportsModes: 'unknown' as const,
        supportsModels: 'unknown' as const,
        supportsConfigOptions: 'unknown' as const,
        promptImageSupport: 'unknown' as const,
    },
    createdAt: 1,
    updatedAt: 1,
};

beforeEach(async () => {
    shared.settingsState.value = { v: 2, backends: [] };
    shared.writes = [];
    shared.mutations = [];
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
    shared.settingsVersion = 1;
    shared.refuse = false;
    shared.holdReceipt = false;
    shared.holdRowRead = false;
    shared.failAcknowledgedRefresh = false;
    const directActionPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: {
        'agents.acp.backends.upsert': ['ui'],
        'agents.acp.backends.delete': ['ui'],
    } });
    shared.accountSettings = { actionsSettingsV1: directActionPolicy };
    receipt = createDeferred<void>();
    rowRead = createDeferred<void>();
    revision = 1;
    interleaveBeforeAcknowledgement = null;
    commandChecks = [];
    unknownCommandAvailable = false;
    commandMachineInventory = [];
    artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://acp-editor.test', serverIdentityId: 'srv_acp_editor', configureSocket: socket => {
        if (typeof socket.auth === 'object' && socket.auth?.clientPurpose === 'scoped-rpc') configureConnectedServerSocketBoundary(socket);
        socket.emitWithAck = vi.fn(async (event: string, payload: unknown) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            // External Socket boundary: the real capability adapter below supplies this request shape.
            const request = payload as { method: string; params: { requests: { params: { definitions: { definitionId: string; title: string; launch: unknown }[] } }[] } };
            expect(request.method.endsWith(`:${RPC_METHODS.CAPABILITIES_DETECT}`)).toBe(true);
            const machineId = request.method.slice(0, request.method.indexOf(':'));
            commandChecks.push(machineId);
            if (machineId === 'unknown' && !unknownCommandAvailable) return { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            const definition = request.params.requests[0]!.params.definitions[0]!;
            return { ok: true, result: { protocolVersion: 1, results: { 'tool.acpAgentInventory': {
                ok: true, checkedAt: 1, data: { items: [MachineAgentInventoryItemSchema.parse({ agentId: buildConfiguredAcpAgentSelectionV1(definition.definitionId).agentId, definitionId: definition.definitionId,
                    title: definition.title, installed: machineId !== 'missing', managed: false,
                    fit: { kind: 'can_run', via: 'command' }, version: null, latestVersion: null,
                    update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'unsupported' },
                    platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [],
                })] },
            } } } };
        });
    }, request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health') return Response.json({});
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'account-a' }));
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v2/account/settings') {
            expect(init?.method).not.toBe('POST');
            return Response.json({ version: 1, content: { t: 'plain', v: shared.accountSettings } });
        }
        if (commandMachineInventory.length > 0) {
            const read = (id: string) => {
                const machine = commandMachineInventory.find(candidate => candidate.id === id);
                return machine ? createPlainMachineRowFixture({ id, accountId: 'account-a', machine }) : null;
            };
            if (path === '/v1/machines') return Response.json(commandMachineInventory.map(machine => read(machine.id)));
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body, read);
            const exact = /^\/v1\/machines\/([^/]+)$/.exec(path);
            if (exact) return Response.json({ machine: read(decodeURIComponent(exact[1]!)) });
        }
        const machineRead = createPlainMachineReadHttpResponseFixture(path, init, 'account-a');
        if (machineRead) return machineRead;
        const artifactResponse = artifacts.handle(path, init);
        if (artifactResponse) return artifactResponse;
        if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
            if (init?.method === 'POST') {
                const mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                shared.mutations.push(mutation);
                if (mutation.expectedRevision !== revision) return Response.json({ status: 'conflict', revision });
                if (shared.refuse) return Response.json({ status: 'conflict', revision });
                expect(mutation.content.t).toBe('plain');
                if (mutation.content.t !== 'plain') throw new Error('Unexpected encrypted editor fixture');
                shared.writes.push({ v: 2, backends: mutation.content.v.definitions });
                if (shared.holdReceipt) await receipt.promise;
                shared.settingsState.value = shared.writes.at(-1)!;
                revision += 1;
                const acknowledgedRevision = revision;
                if (interleaveBeforeAcknowledgement) {
                    const interleave = interleaveBeforeAcknowledgement;
                    interleaveBeforeAcknowledgement = null;
                    await interleave();
                }
                return Response.json({ status: 'updated', revision: acknowledgedRevision, cursor: acknowledgedRevision });
            }
            if (shared.failAcknowledgedRefresh && shared.writes.length > 0) return new Response(null, { status: 503 });
            if (shared.holdRowRead) await rowRead.promise;
            return Response.json({ status: 'present', revision, content: { t: 'plain', v: { v: 1, definitions: shared.settingsState.value.backends } } });
        }
        return createEmptyAccountBootstrapHttpResponse(`${path}${new URL(String(url)).search}`, init) ?? new Response(null, { status: 404 });
    } });
    disposeConnection = connection.dispose;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Editor fixture has no restored Account lifetime');
    scope = lifetime.scope;
    getStorage().setState({ settingsScope: scope, machines: {}, settings: {
        ...getStorage().getState().settings, actionsSettingsV1: directActionPolicy,
    } });
});

afterEach(async () => {
    receipt.resolve();
    rowRead.resolve();
    await act(async () => {
        for (const [modal] of vi.mocked(Modal.show).mock.calls) modal.onHostUnmount?.();
        Modal.hideAll();
        await Promise.allSettled(pendingSaves.splice(0));
    });
    vi.mocked(Modal.show).mockClear();
    shared.routerPushSpy.mockReset();
    shared.routerReplaceSpy.mockReset();
    shared.routerBackSpy.mockReset();
    shared.modalAlertSpy.mockReset();
    await standardCleanup();
    await disposeConnection?.();
    resetAcpCatalogEngineForTests(); resetAcpCatalogSnapshotsForTests(); retireActiveServerAccountScopeLifetime();
});

describe('AcpBackendEditorScreen', () => {
    it('checks the unsaved command on each machine through the Action, preserves unknown/offline, and retries without writing', async () => {
        const now = Date.now();
        // 3089ddfca4bb: hydrated Plain RPC rows carry admitted content mode and owner access.
        const machines = ['found', 'missing', 'unknown', 'offline'].map(id => createHydratedPlainMachineFixture({
            id, accountId: 'account-a', machine: { active: id !== 'offline', activeAt: id === 'offline' ? 1 : now,
                metadata: { ...createMachineFixture().metadata!, host: id, displayName: id, platform: 'linux', arch: 'x64' },
            },
        }));
        commandMachineInventory = machines;
        // Focused-Home presentation reads the admitted active roster, not its saved-Home fallback.
        getStorage().setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])) });
        await publishMachineInventoryForTest(scope, machines);
        const screen = await renderEditor(null);
        await type(screen, `${EDITOR}.title`, 'Checked agent');
        await type(screen, `${EDITOR}.command`, 'checked-agent');
        expect(commandChecks).toEqual([]);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.findByTestId(`${EDITOR}.machines:action`)).not.toBeNull();
        });
        expectSaveEnabled(screen);
        await press(screen, `${EDITOR}.machines:action`);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(commandChecks.sort()).toEqual(['found', 'missing', 'unknown']);
        });
        expect(screen.findRow(`${EDITOR}.machines:machine:found`)?.props.subtitle).toBe('settingsAgents.customAcp.commandFound');
        expect(screen.findRow(`${EDITOR}.machines:machine:missing`)?.props.subtitle).toBe('settingsAgents.customAcp.commandMissing');
        expect(screen.findRow(`${EDITOR}.machines:machine:unknown`)?.props.subtitle).toBe('common.unknown');
        expect(screen.findRow(`${EDITOR}.machines:machine:offline`)?.props.subtitle).toBe('capabilities.status.offline');
        expect(commandChecks.sort()).toEqual(['found', 'missing', 'unknown']);
        expect(shared.writes).toEqual([]);
        expect(artifacts.list().length).toBe(0);
        unknownCommandAvailable = true;
        await press(screen, `${EDITOR}.machines:action`);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.findRow(`${EDITOR}.machines:machine:unknown`)?.props.subtitle).toBe('settingsAgents.customAcp.commandFound');
        });
        expect(shared.writes).toEqual([]);
        expectSaveEnabled(screen);
        await type(screen, `${EDITOR}.command`, 'another-agent');
        expect(screen.findRow(`${EDITOR}.machines:machine:found`)?.props.subtitle).toBe('common.unknown');
    });
    it('executes configured backend authoring through the canonical public UI front door', async () => {
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const execute = createFrontDoorActionExecute();
        await expect(execute('agents.acp.backends.upsert', { backend: existingKiro, expectedRevision: revision }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: scope.serverId, expectedAccountId: scope.accountId,
        })).resolves.toMatchObject({ ok: true, result: { backend: { id: 'kiro' }, revision: 2 } });
        expect(shared.writes).toHaveLength(1);
    });
    it.each(['updated', 'conflict'] as const)('keeps the authored draft pending until its native review settles (%s)', async (outcome) => {
        const approvalPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'agents.acp.backends.upsert': { approvalRequiredSurfaces: ['ui'] },
        } });
        shared.accountSettings = { actionsSettingsV1: approvalPolicy };
        getStorage().setState({ settings: { ...getStorage().getState().settings, actionsSettingsV1: approvalPolicy } });
        const screen = await renderEditor(null);
        await type(screen, `${EDITOR}.title`, 'Approved agent');
        await type(screen, `${EDITOR}.command`, 'review');
        const review = await startNativeSaveReview(screen);
        expect(shared.writes).toHaveLength(0);
        expectSavePending(screen, true);
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Approved agent');
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        expect(shared.routerPushSpy).not.toHaveBeenCalled();
        if (outcome === 'conflict') {
            revision = 2;
            shared.settingsState.value = { v: 2, backends: [existingKiro] };
            await act(async () => { await refreshAcpCatalog(scope); });
        }
        await finishNativeSaveReview(review, 'approve');
        await waitForHomeGovernance(() => expectSavePending(screen, false));
        if (outcome === 'updated') {
            expect(shared.writes).toHaveLength(1);
            expect(shared.settingsState.value.backends[0]?.title).toBe('Approved agent');
            expect(shared.routerReplaceSpy).toHaveBeenCalledWith(expect.stringContaining('approved-agent'));
        } else {
            expect(shared.writes).toHaveLength(0);
            expect(shared.settingsState.value.backends[0]?.title).toBe('Kiro');
            expect(input(screen, `${EDITOR}.title`).props.value).toBe('Approved agent');
            expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        }
    });
    it.each([false, true])('persists a changed resume declaration through the catalog action (initially %s)', async (initialSupport) => {
        shared.settingsState.value = { v: 2, backends: [{ ...existingKiro,
            capabilities: { ...existingKiro.capabilities, supportsLoadSession: initialSupport },
        }] };
        const screen = await renderEditor('kiro');
        const toggleId = `${EDITOR}.supportsLoadSession`;
        const toggle = screen.findByTestId(toggleId);
        expect(toggle).not.toBeNull();
        expect(toggle?.props.value).toBe(initialSupport);
        await act(async () => { toggle?.props.onValueChange(!initialSupport); });
        await press(screen, `${EDITOR}.save`);
        await waitForSaveSettled(screen);
        expect(shared.writes).toHaveLength(1);
        expect(shared.settingsState.value.backends[0]?.capabilities).toEqual({
            ...existingKiro.capabilities,
            supportsLoadSession: !initialSupport,
        });
        await screen.unmount();
        const reopened = await renderEditor('kiro');
        expect(reopened.findByTestId(toggleId)?.props.value).toBe(!initialSupport);
    });

    it.each(['reject', 'cancel'] as const)('releases the pending editor without writing or losing its draft when native review is %s', async (decision) => {
        const approvalPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'agents.acp.backends.upsert': { approvalRequiredSurfaces: ['ui'] },
        } });
        shared.accountSettings = { actionsSettingsV1: approvalPolicy };
        getStorage().setState({ settings: { ...getStorage().getState().settings, actionsSettingsV1: approvalPolicy } });
        const screen = await renderEditor(null);
        await type(screen, `${EDITOR}.title`, 'Canceled approval draft');
        await type(screen, `${EDITOR}.command`, 'review');
        const review = await startNativeSaveReview(screen);
        expectSavePending(screen, true);
        await finishNativeSaveReview(review, decision);
        await waitForHomeGovernance(() => expectSavePending(screen, false));
        expect(shared.writes).toHaveLength(0);
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Canceled approval draft');
        expectSaveEnabled(screen);
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
    });
    it.each(['ordinary ACK', 'interleaved later writer'] as const)('preserves newer editable draft changes when the natively reviewed write is acknowledged (%s)', async (scenario) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        expect(lifetime?.scope).toEqual(scope);
        expect(lifetime?.isCurrent()).toBe(true);
        const approvalPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'agents.acp.backends.upsert': { approvalRequiredSurfaces: ['ui'] },
        } });
        shared.accountSettings = { actionsSettingsV1: approvalPolicy };
        getStorage().setState({ settings: { ...getStorage().getState().settings, actionsSettingsV1: approvalPolicy } });
        shared.settingsState.value = { v: 2, backends: [existingKiro] };
        const screen = await renderEditor('kiro');
        await type(screen, `${EDITOR}.title`, 'Originally submitted title');
        const review = await startNativeSaveReview(screen);
        expectSavePending(screen, true);
        expect(shared.writes).toHaveLength(0);
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        expect(input(screen, `${EDITOR}.title`).props.editable).not.toBe(false);
        await type(screen, `${EDITOR}.title`, 'Newer uncommitted title');
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Newer uncommitted title');
        if (scenario === 'interleaved later writer') {
            // A separate real writer publishes revision 3 while the original revision-2
            // HTTP acknowledgement is still in flight.
            interleaveBeforeAcknowledgement = async () => {
                expect(revision).toBe(2);
                const { writeAcpCatalogRecord } = await import('@/sync/api/account/apiAcpCatalog');
                const other = await writeAcpCatalogRecord(scope, { expectedRevision: 2,
                    record: { v: 1, definitions: [{ ...existingKiro, title: 'Other writer title' }] } });
                expect(other).toMatchObject({ status: 'updated', revision: 3 });
                // A durable receipt invalidates the projection; await its real refresh before delivering the older ACK.
                await refreshAcpCatalog(scope);
                expect(getAcpCatalogSnapshot(scope)?.catalog).toMatchObject({ status: 'ready', revision: 3 });
            };
        }
        await finishNativeSaveReview(review, 'approve');
        expect(lifetime?.isCurrent()).toBe(true);
        await waitForHomeGovernance(() => expectSavePending(screen, false));
        const interleaved = scenario === 'interleaved later writer';
        expect(shared.writes).toHaveLength(interleaved ? 2 : 1);
        expect(shared.writes[0]?.backends[0]?.title).toBe('Originally submitted title');
        expect(shared.settingsState.value.backends[0]?.title).toBe(interleaved ? 'Other writer title' : 'Originally submitted title');
        expect(revision).toBe(interleaved ? 3 : 2);
        expect(errorText(screen, EDITOR)).toBeNull();
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Newer uncommitted title');
        expectSaveEnabled(screen);
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();

        // A preserved draft is usable only if the first ACK also advanced its CAS authority.
        const newerReview = await startNativeSaveReview(screen);
        expect(shared.writes).toHaveLength(interleaved ? 2 : 1);
        await finishNativeSaveReview(newerReview, 'approve');
        if (!interleaved) expect(shared.mutations.at(-1)).toMatchObject({ expectedRevision: 2 });
        await waitForHomeGovernance(() => expectSavePending(screen, false));
        expect(shared.writes).toHaveLength(2);
        expect(revision).toBe(3);
        expect(shared.settingsState.value.backends[0]?.title).toBe(interleaved ? 'Other writer title' : 'Newer uncommitted title');
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Newer uncommitted title');
        if (interleaved) {
            expect(errorText(screen, EDITOR)).toBe('common.unavailable');
            expectSaveEnabled(screen);
        } else {
            expect(errorText(screen, EDITOR)).toBeNull();
            expect(screen.findByTestId(`${EDITOR}.save`)?.props.disabled).toBe(true);
        }
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
    });
    it('keeps a dirty draft bound to its original row revision when a catalog refresh observes another writer', async () => {
        shared.settingsState.value = { v: 2, backends: [existingKiro] };
        const screen = await renderEditor('kiro');
        await type(screen, `${EDITOR}.title`, 'My uncommitted title');
        shared.settingsState.value = { v: 2, backends: [{ ...existingKiro, title: 'Other writer title' }] };
        revision = 2;
        await act(async () => { await refreshAcpCatalog(scope); });
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('My uncommitted title');
        expectSaveEnabled(screen);
        await press(screen, `${EDITOR}.save`);
        await waitForSaveSettled(screen);
        expect(shared.writes).toHaveLength(0);
        expect(shared.settingsState.value.backends[0]?.title).toBe('Other writer title');
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('My uncommitted title');
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
    });
    it.each(['published', 'refresh unavailable'] as const)('settles a new definition baseline without losing later edits and updates its acknowledged identity on the next save (%s)', async (publication) => {
        const approvalPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'agents.acp.backends.upsert': { approvalRequiredSurfaces: ['ui'] },
        } });
        shared.accountSettings = { actionsSettingsV1: approvalPolicy };
        getStorage().setState({ settings: { ...getStorage().getState().settings, actionsSettingsV1: approvalPolicy } });
        const screen = await renderEditor(null);
        shared.failAcknowledgedRefresh = publication === 'refresh unavailable';
        await type(screen, `${EDITOR}.title`, 'Submitted agent');
        await type(screen, `${EDITOR}.command`, 'review');
        const review = await startNativeSaveReview(screen);
        await type(screen, `${EDITOR}.title`, 'Later agent title');
        await press(screen, `${EDITOR}.args.add`);
        await type(screen, `${EDITOR}.args.item.0`, ' later argument ');
        await press(screen, `${EDITOR}.args.add`);
        await finishNativeSaveReview(review, 'approve');
        await waitForHomeGovernance(() => {
            // A hidden editor is the defect under test, so let the next field assertion expose it.
            if (screen.findByTestId(`${EDITOR}.save`)) expectSavePending(screen, false);
        });
        expect(shared.settingsState.value.backends).toEqual([expect.objectContaining({ id: 'submitted-agent', title: 'Submitted agent' })]);
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Later agent title');
        expect(input(screen, `${EDITOR}.name`).props.value).toBe('submitted-agent');
        if (publication === 'refresh unavailable') expect(screen.findByTestId(`${EDITOR}.save`)?.props.disabled).toBe(true);
        shared.failAcknowledgedRefresh = false;
        await act(async () => { await refreshAcpCatalog(scope); });
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Later agent title');
        expectSaveEnabled(screen);
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();

        const newerReview = await startNativeSaveReview(screen);
        await finishNativeSaveReview(newerReview, 'approve');
        expect(shared.mutations.at(-1)).toMatchObject({ expectedRevision: 2,
            content: { t: 'plain', v: { definitions: [{ id: 'submitted-agent', title: 'Later agent title', launch: { args: [' later argument ', ''] } }] } },
        });
        await waitForHomeGovernance(() => expectSavePending(screen, false));
        expect(shared.settingsState.value.backends).toEqual([expect.objectContaining({ id: 'submitted-agent', title: 'Later agent title', launch: expect.objectContaining({ args: [' later argument ', ''] }) })]);
        expect(revision).toBe(3);
        expect(screen.findByTestId(`${EDITOR}.save`)?.props.disabled).toBe(true);
        expect(shared.routerReplaceSpy).toHaveBeenCalledWith('/(app)/settings/agents/custom/submitted-agent');
    });

    it('preserves exact launch and login argv through a title-only edit and the public Action', async () => {
        const launchArgs = ['  x  ', '', 'two  words', '\t'];
        const loginArgs = ['', ' login ', 'two\twords', '  '];
        shared.settingsState.value = { v: 2, backends: [{ ...existingKiro, launch: { ...existingKiro.launch, args: launchArgs },
            auth: { support: 'login_terminal', loginCommand: { command: 'kiro-cli', args: loginArgs } },
        }] };
        const screen = await renderEditor('kiro');
        await type(screen, `${EDITOR}.title`, 'Renamed agent');
        await press(screen, `${EDITOR}.save`);
        await waitForSaveSettled(screen);
        expect(shared.settingsState.value.backends).toEqual([expect.objectContaining({
            id: 'kiro', title: 'Renamed agent', launch: { kind: 'command', command: 'kiro-cli', args: launchArgs },
            auth: expect.objectContaining({ loginCommand: { command: 'kiro-cli', args: loginArgs } }),
        })]);
    });
    it('preserves a pinned non-command launch through a title edit', async () => {
        const launch = { kind: 'npm' as const, package: '@test/acp-agent', version: '1.2.3', args: ['--stdio'] };
        shared.settingsState.value = { v: 2, backends: [{ ...existingKiro, launch }] };
        const screen = await renderEditor('kiro');
        await type(screen, `${EDITOR}.title`, 'Renamed registry agent');
        await press(screen, `${EDITOR}.save`);
        await waitForSaveSettled(screen);
        expect(shared.settingsState.value.backends).toEqual([expect.objectContaining({
            id: 'kiro', title: 'Renamed registry agent', launch,
        })]);
    });
    it('asks for sign-in details only when the agent has a sign-in method', async () => {
        const fresh = await renderEditor(null);
        for (const field of ['loginCommand', 'loginArgs', 'docsUrl', 'machineLoginKey']) {
            expect(fresh.findByTestId(`${EDITOR}.${field}`)).toBeFalsy();
        }
        shared.settingsState.value = { v: 2, backends: [{ ...existingKiro,
            auth: { support: 'login_terminal', loginCommand: { command: 'kiro-cli', args: ['login'] } },
        }] };
        const withSignIn = await renderEditor('kiro');
        expect(input(withSignIn, `${EDITOR}.loginCommand`).props.value).toBe('kiro-cli');
        expect(withSignIn.findByTestId(`${EDITOR}.docsUrl`)).toBeTruthy();
    });
    it('retains the authored draft and does not write when public UI Action policy disables upsert', async () => {
        shared.accountSettings = { actionsSettingsV1: { v: 1, actions: {
            'agents.acp.backends.upsert': { disabledSurfaces: ['ui'] },
        } } };
        getStorage().setState({ settings: { ...getStorage().getState().settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse(shared.accountSettings.actionsSettingsV1) } });
        const screen = await renderEditor(null);
        await type(screen, `${EDITOR}.title`, 'Policy retained draft');
        await type(screen, `${EDITOR}.command`, 'review');
        expectSaveEnabled(screen);
        await press(screen, `${EDITOR}.save`);
        expect(shared.writes).toHaveLength(0);
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Policy retained draft');
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
    });
    it('releases original Home native review and retains its draft without enabling save after another Home becomes ready', async () => {
        const approvalPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'agents.acp.backends.upsert': { approvalRequiredSurfaces: ['ui'] },
        } });
        shared.accountSettings = { actionsSettingsV1: approvalPolicy };
        getStorage().setState({ settings: { ...getStorage().getState().settings, actionsSettingsV1: approvalPolicy } });
        const screen = await renderEditor(null);
        await type(screen, `${EDITOR}.title`, 'Old Account draft');
        await type(screen, `${EDITOR}.command`, 'review');
        const review = await startNativeSaveReview(screen);
        const replacementWrites: string[] = [];
        const other = await restoreServerAccountForTest({ serverUrl: 'https://other-acp-editor.test', accountId: 'account-b',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === ACP_CATALOG_ROWS_ROUTE_V1 && init?.method === 'POST') replacementWrites.push(path);
                if (path === '/health') return Response.json({});
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
                if (path === '/v1/artifacts') return Response.json([]);
                if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1,
                    content: { t: 'plain', v: { v: 1, definitions: [] } } });
                return new Response(null, { status: 404 });
            } });
        try {
            const nextScope = { serverId: other.home.id, accountId: 'account-b' };
            await act(async () => {
                getStorage().setState({ settingsScope: nextScope });
                applyAcpCatalogSnapshot(nextScope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
            });
            // Even an affirmative answer from the retired Home cannot write into either Account.
            await finishNativeSaveReview(review, 'approve');
            await waitForHomeGovernance(() => expectSavePending(screen, false));
            expect(input(screen, `${EDITOR}.title`).props.value).toBe('Old Account draft');
            expect(screen.findByTestId(`${EDITOR}.save`)?.props.disabled).toBe(true);
            expect(shared.writes).toHaveLength(0);
            expect(replacementWrites).toHaveLength(0);
            expect(artifacts.list()).toEqual([]);
            expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        } finally { await other.dispose(); }
    });
    it('saves a new agent with an ID made from its name and its arguments in order, then opens it in the collection', async () => {
        const screen = await renderEditor(null);

        await type(screen, `${EDITOR}.title`, 'My Kiro');
        await type(screen, `${EDITOR}.command`, 'kiro-cli');
        await press(screen, `${EDITOR}.args.add`);
        await type(screen, `${EDITOR}.args.item.0`, 'acp');
        await press(screen, `${EDITOR}.args.add`);
        await type(screen, `${EDITOR}.args.item.1`, '--stdio');
        await press(screen, `${EDITOR}.save`);
        await waitForSaveSettled(screen);

        expect(shared.writes).toHaveLength(1);
        expect(shared.writes[0]?.backends).toEqual([expect.objectContaining({
            id: 'my-kiro',
            name: 'my-kiro',
            title: 'My Kiro',
            launch: { kind: 'command' as const, command: 'kiro-cli', args: ['acp', '--stdio'] },
        })]);
        expect(shared.routerReplaceSpy).toHaveBeenCalledWith('/(app)/settings/agents/custom/my-kiro');
        expect(shared.modalAlertSpy).not.toHaveBeenCalled();
    });

    it('shows each refusal beside its field and writes nothing', async () => {
        const screen = await renderEditor(null);

        await press(screen, `${EDITOR}.save`);

        expect(shared.writes).toHaveLength(0);
        expect(errorText(screen, `${EDITOR}.title`)).toBe('settingsAgents.customAcp.errors.nameRequired');
        expect(errorText(screen, `${EDITOR}.command`)).toBe('settingsAgents.customAcp.errors.commandRequired');
        expect(shared.modalAlertSpy).not.toHaveBeenCalled();

        await type(screen, `${EDITOR}.command`, 'kiro-cli');
        expect(errorText(screen, `${EDITOR}.command`)).toBeNull();
    });

    it('refuses a new agent whose edited ID is already taken instead of replacing that agent', async () => {
        shared.settingsState.value = { v: 2, backends: [existingKiro] };
        const screen = await renderEditor(null);

        await type(screen, `${EDITOR}.title`, 'Kiro again');
        await type(screen, `${EDITOR}.command`, 'kiro-cli');
        await press(screen, `${EDITOR}.editId`);
        await type(screen, `${EDITOR}.id`, 'kiro');
        await press(screen, `${EDITOR}.save`);

        expect(shared.writes).toHaveLength(0);
        expect(errorText(screen, `${EDITOR}.id`)).toBe('settingsAgents.customAcp.errors.idTaken');
    });

    it('updates an existing agent in place and keeps its ID', async () => {
        shared.settingsState.value = { v: 2, backends: [existingKiro] };
        const screen = await renderEditor('kiro');

        await press(screen, `${EDITOR}.args.remove.0`);
        await type(screen, `${EDITOR}.title`, 'Kiro CLI');
        await press(screen, `${EDITOR}.save`);
        await waitForSaveSettled(screen);

        expect(shared.writes).toHaveLength(1);
        expect(shared.writes[0]?.backends).toEqual([expect.objectContaining({ id: 'kiro', title: 'Kiro CLI', launch: { kind: 'command', command: 'kiro-cli', args: [] } })]);
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('says a missing agent is gone only once the Account settings have loaded', async () => {
        shared.settingsVersion = null;
        shared.holdRowRead = true;
        const loading = await renderEditor('kiro');
        expect(loading.findAll((node) => node.props?.description === 'settingsAgents.customAcp.notFound')).toHaveLength(0);

        await act(async () => { rowRead.resolve(); });
        await vi.waitFor(() => expect(loading.findAll((node) => node.props?.description === 'settingsAgents.customAcp.notFound').length).toBeGreaterThan(0));
    });

    it('opens a saved agent with its fixed ID and short name when the catalog loads after the page', async () => {
        shared.settingsState.value = { v: 2, backends: [existingKiro] };
        shared.settingsVersion = null;
        shared.holdRowRead = true;
        const screen = await renderEditor('kiro');

        await act(async () => { rowRead.resolve(); });
        await vi.waitFor(() => expect(input(screen, `${EDITOR}.title`).props.value).toBe('Kiro'));
        expect(screen.findByTestId(`${EDITOR}.editId`)).toBeFalsy();
        expect(input(screen, `${EDITOR}.name`).props.value).toBe('kiro');
    });

    it('deletes an existing agent under its Allowed Action setting without a local confirmation and leaves the page', async () => {
        shared.settingsState.value = { v: 2, backends: [existingKiro] };
        const screen = await renderEditor('kiro');
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear().mockResolvedValue(false);

        const menu = screen.findAll((node) => node.props?.testID === `${EDITOR}.menu`
            && typeof node.props?.onSelect === 'function')[0];
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toEqual(['delete']);
        await act(async () => {
            await menu?.props.onSelect('delete');
        });

        expect(shared.writes.at(-1)?.backends).toEqual([]);
        expect(shared.routerReplaceSpy).toHaveBeenCalledWith('/(app)/settings/agents');
        expect(Modal.confirm).not.toHaveBeenCalled();
    });
    it.each(['editor', 'registry'] as const)('retains the delete refusal in the %s detail and permits an explicit retry', async (surface) => {
        const definition: AcpBackendDefinitionV1 = surface === 'editor' ? existingKiro : {
            ...existingKiro,
            launch: { kind: 'npm', package: '@test/acp-agent', version: '1.2.3', args: ['--stdio'] },
            origin: { kind: 'registry', provenance: {
                sourceId: 'builtin:acp-registry', format: 'acp-registry',
                sourceUrl: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
                itemId: 'kiro', ref: { kind: 'version', version: '1.2.3' }, importedAt: 1,
            } },
        };
        shared.settingsState.value = { v: 2, backends: [definition] };
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision,
            record: { v: 1, definitions: [definition] } }, true);
        const screen = surface === 'editor' ? await renderEditor('kiro')
            : await renderSettingsView(React.createElement(
                (await import('@/components/settings/agents/detail/RegistryAgentDetailScreen')).RegistryAgentDetailScreen,
                { definition }));
        const remove = async () => {
            if (surface === 'registry') {
                await screen.pressByTestIdAsync('settings.agents.registryDetail.remove');
                await flushHookEffects();
            } else {
                const menu = screen.findAll(node => node.props?.testID === `${EDITOR}.menu`
                    && typeof node.props?.onSelect === 'function')[0];
                await menu?.props.onSelect('delete');
            }
        };
        shared.refuse = true;
        await act(remove);
        await waitForHomeGovernance(() => expect(shared.modalAlertSpy).toHaveBeenCalledWith(
            'common.error', expect.stringMatching(/conflict/i)));
        expect(shared.writes).toHaveLength(0);
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        shared.refuse = false;
        await act(remove);
        await waitForHomeGovernance(() => expect(shared.routerReplaceSpy).toHaveBeenCalledWith('/(app)/settings/agents'));
        expect(shared.writes.at(-1)?.backends).toEqual([]);
    });

    it('keeps the agent and stays silent when the shared delete confirmation is declined', async () => {
        shared.settingsState.value = { v: 2, backends: [existingKiro] };
        shared.accountSettings = {};
        getStorage().setState({ settings: { ...getStorage().getState().settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) } });
        const screen = await renderEditor('kiro');
        await type(screen, `${EDITOR}.title`, 'Unsaved Kiro');
        await waitForHomeGovernance(async () => { await flushHookEffects(); expectSaveEnabled(screen); });
        const { Modal } = await import('@/modal');
        shared.modalAlertSpy.mockClear();
        const menu = screen.findAll((node) => node.props?.testID === `${EDITOR}.menu`
            && typeof node.props?.onSelect === 'function')[0];
        let deleting!: Promise<void>;
        await act(async () => { deleting = menu?.props.onSelect('delete'); });
        pendingSaves.push(deleting);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.findHostByTestId('actions.confirmation-review.decision-reject')).not.toBeNull();
        });
        await act(async () => {
            await screen.pressByTestIdAsync('actions.confirmation-review.decision-reject');
            await deleting;
        });
        expect(artifacts.list()).toEqual([]);
        expect(shared.writes).toEqual([]);
        expect(shared.modalAlertSpy).not.toHaveBeenCalled();
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Unsaved Kiro');
    });

    it('keeps the authored draft on row refusal and navigates only after the durable receipt', async () => {
        const screen = await renderEditor(null);
        await type(screen, `${EDITOR}.title`, 'Retained draft');
        await type(screen, `${EDITOR}.command`, 'review');
        shared.refuse = true;
        await press(screen, `${EDITOR}.save`);
        await waitForSaveSettled(screen);
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Retained draft');
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        expect(shared.writes).toHaveLength(0);
        shared.refuse = false;
        shared.holdReceipt = true;
        const saving = press(screen, `${EDITOR}.save`);
        await vi.waitFor(() => expect(shared.writes).toHaveLength(1));
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        receipt.resolve();
        await saving;
        await vi.waitFor(() => expect(shared.routerReplaceSpy).toHaveBeenCalledWith('/(app)/settings/agents/custom/retained-draft'));
    });
});

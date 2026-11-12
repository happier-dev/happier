/** @vitest-environment jsdom */
import * as React from 'react';
import 'fake-indexeddb/auto';
import type { Socket } from 'socket.io-client';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { type ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { CURRENT_UI_CONTEXT_ATTACHMENT_IDENTITY_V1 } from '@happier-dev/protocol/plugins/ui';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PLUGIN_MANIFEST as APP_CONTEXT_MANIFEST } from '../../../../../../packages/plugins/app-context/src/manifest';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createWorkflowActionHttpTransport } from '@/dev/testkit/fixtures/workflowActionHttpTransport';
import { createEmptyAccountMigrationCensusHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createMachineFixture, createPlainMachineRowFixture, createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createExistingSessionDirectoryPreflightResult, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { WorkflowDefinitionArtifactHeaderV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { WorkflowDefinitionListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

const route = vi.hoisted(() => ({ width: 1440, pathname: '/workflows', params: {} as Record<string, string> }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Dimensions: { get: () => ({ width: route.width, height: 900, scale: 1, fontScale: 1 }) },
}));
// Expo Crypto is the native randomness boundary.
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
// test-policy-boundary: ReactDOM's browser portal cannot target a TestRenderer host.
vi.mock('@/utils/web/reactDomCjs', () => ({ requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => route.pathname, params: () => route.params,
        segments: () => route.pathname === '/workflows' ? ['(app)', 'workflows'] : ['(app)', 'workflows', '[id]'] }).module;
});

const sockets: Socket[] = [];
const inventory = createReadyMachineAgentInventoryFixture([{ agentId: 'claude', title: 'Claude' }, { agentId: 'codex', title: 'Codex' }]);
// The external daemon declares the actual App context attachment seeded by Create with agent.
const currentScreenDefinition = PluginManifestV2Schema.parse(APP_CONTEXT_MANIFEST).contributes.composerAttachments
    ?.find(definition => definition.id === CURRENT_UI_CONTEXT_ATTACHMENT_IDENTITY_V1.localId);
if (!currentScreenDefinition) throw new Error('Expected declared current-screen attachment');
const currentScreenIdentity = CURRENT_UI_CONTEXT_ATTACHMENT_IDENTITY_V1;
inventory.projection = PluginProjectionV2Schema.parse({ ...inventory.projection, familiesById: {
    ...inventory.projection.familiesById,
    composerAttachments: { family: 'composerAttachments', entriesById: {
        [`${currentScreenIdentity.pluginId}/${currentScreenIdentity.localId}`]: {
            id: `${currentScreenIdentity.pluginId}/${currentScreenIdentity.localId}`, pluginId: currentScreenIdentity.pluginId,
            identity: currentScreenIdentity, occurrenceId: 'current-screen-loaded', definition: currentScreenDefinition,
        },
    } },
} });
const createdSessionId = 'workflow-authoring-created-session';
let spawnedSessionId: string | null = null;
let dictationFeatures: ReturnType<typeof createRootLayoutFeaturesResponse> | undefined;
let accountSettingsFixture: Settings;
installDisconnectedServerSocketBoundary(socket => {
    sockets.push(socket);
    configureConnectedServerSocketBoundary(socket);
    socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
    // Only the external daemon transport is substituted; app reverse listeners remain real.
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (_event, payload) => {
        if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string' && 'params' in payload) {
            if (payload.method.endsWith(`:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`))
                return { ok: true, result: createExistingSessionDirectoryPreflightResult(payload.params) };
            if (payload.method.includes('contributionRegistryProjection.describe'))
                return { ok: true, result: { protocolVersion: 1, projection: inventory.projection } };
            if (payload.method.endsWith(`:${RPC_METHODS.CAPABILITIES_DETECT}`)) return { ok: true, result: inventory.capabilities };
            if (payload.method.endsWith(`:${RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST}`)) return { ok: true, result: { jobs: [] } };
            if (payload.method.endsWith(`:${RPC_METHODS.CAPABILITIES_INVOKE}`)) {
                return { ok: true, result: { ok: false, error: { code: 'unsupported-method', message: 'Fixture daemon has no optional probe' } } };
            }
            if (payload.method.endsWith(`:${RPC_METHODS.SESSION_SPAWN_NEW}`)) {
                if (!connection) throw new Error('Expected restored Account during Session spawn');
                spawnedSessionId = createdSessionId;
                return { ok: true, result: SessionSpawnNewResultV1Schema.parse({ type: 'success', disposition: 'created',
                    sessionId: createdSessionId, executionTarget: { serverId: connection.serverId, machineId },
                    organizationPlacement: { folderId: null, tagIds: [] },
                    initialInput: { status: 'accepted', localId: 'workflow-authoring-initial-input' } }) };
            }
        }
        return { ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Fixture daemon does not serve this method' };
    });
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { renderScreen, standardCleanup } = await import('@/dev/testkit');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { AppPaneModalProvider } = await import('@/components/appShell/providers/AppPaneModalProvider');
const { NewSessionShellHostProvider } = await import('@/components/sessions/new/navigation/newSessionEntry');
const { NewSessionComposerCard } = await import('@/components/sessions/new/components/NewSessionComposerCard');
const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
const { useModal } = await import('@/modal/ModalProvider');
const { CurrentUiContextProvider } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { CurrentUiContextActionHost } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
const { WorkflowsColumnActions } = await import('../column/WorkflowsColumnActions');
const { WorkflowAgentAuthoringDraft } = await import('./useWorkflowAgentAuthoring');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { WorkflowEditorBody } = await import('../screens/WorkflowEditorBody');
const { default: WorkflowRouteEntry } = await import('@/app/(app)/workflows/[id]/index');
const { default: WorkflowsIndexRouteEntry } = await import('@/app/(app)/workflows/index');
const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
const { WorkspaceShell } = await import('@/components/appShell/workspace/WorkspaceShell');
const { registerWorkspaceRouteContext } = await import('@/components/appShell/workspace/workspaceRouteContext');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { HorizontalSafeAreaProvider } = await import('@/components/navigation/safeArea/HorizontalSafeArea');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { storage } = await import('@/sync/domains/state/storage');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { t } = await import('@/text');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { createClientActionReverseDispatcher } = await import('../../../../../cli/src/session/actions/clientActionReverseDispatch');
const { createActionToolExecutorBridge } = await import('../../../../../cli/src/agent/tools/happierTools/createActionToolExecutorBridge');
const { selectRpcTarget } = await import('../../../../../server/sources/app/api/socket/rpc/rpcTargetSelection');

const savedId = '00000000-0000-4000-8000-000000000042';
const machineId = 'workflow-authoring-machine';
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreActionLoader: (() => void) | undefined;
let modals: ReturnType<typeof useModal>['state']['modals'] = [];
let workspace: import('@/components/appShell/workspace/WorkspaceNavigationContext').WorkspaceNavigationContextValue | undefined;
const releases: Array<() => void> = [];
function ObserveModals() { modals = useModal().state.modals; return null; }
const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });

beforeEach(async () => {
    spawnedSessionId = null;
    dictationFeatures = undefined;
    accountSettingsFixture = settingsParse({ experiments: true, featureToggles: { workflows: true, automations: true } });
    route.pathname = '/workflows'; route.params = {};
    window.history.replaceState(null, '', route.pathname);
    await homes.reset();
    resetSessionDraftRepositoryForTests();
    await prepareSessionDraftPersistenceStorage();
    const machineRow = createPlainMachineRowFixture({ id: machineId, accountId: 'account-a',
        machine: createMachineFixture({ id: machineId, activeAt: Date.now() }) });
    const savedHeader = WorkflowDefinitionArtifactHeaderV1Schema.parse({ kind: 'workflow-definition.v1', definitionId: savedId,
        revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved Workflow' } });
    const savedDefinition = createWorkflowDefinitionFixture({ defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    } });
    const http = createWorkflowActionHttpTransport({ accountId: () => 'account-a', machineRows: () => [machineRow],
        fixtureResponse: async actionId => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: WorkflowDefinitionListResultV1Schema.parse({ definitions: [{
                ...savedHeader, ownerAccountId: 'account-a', access: 'owner', contentStatus: 'available', stepCount: 1,
                triggers: [], nextRunAt: null,
            }] }) };
            if (actionId === 'workflow.definition.get') return { ok: true, result: { definitionId: savedId,
                definition: savedDefinition, metadata: { title: 'Saved Workflow' },
                revision: { headerVersion: 1, bodyVersion: 1 }, access: 'owner' } };
            throw new Error(`Unexpected Workflow HTTP request: ${actionId}`);
        } });
    // Exact saved reads use the Home's Artifact batch API before any library list.
    // Seed the external stored row, so both HTTP paths describe the same saved Workflow.
    http.artifacts.replaceStoredRow(createPlainArtifactHttpFixture({ id: savedId, isDecrypted: true,
        title: savedHeader.metadata.title, rawHeader: savedHeader, header: { ...savedHeader, title: savedHeader.metadata.title },
        body: JSON.stringify({ kind: 'workflow-definition.v1', definition: savedDefinition }),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    }, 'account-a'));
    const metadata = { path: '/Users/tester', host: 'tester.local', machineId, flavor: 'claude' };
    const admitted = createSessionOwnerMetadataV1({ metadata });
    if (!admitted.ok) throw new Error('Expected valid created Session metadata');
    const session = SessionCurrentProjectionRecordV1Schema.parse({
        id: createdSessionId, createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1, metadataVersion: 1,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(admitted.ownerMetadata),
        agentStateVersion: 0, agentState: null, share: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
        responsibleAccountId: null, responsibleAccount: null,
    });
    const authoringMemoryHttp = createAuthoringMemoryHttpBoundary();
    connection = await restoreServerAccountForTest({ serverUrl: 'https://workflow-current-context.test',
        accountId: 'account-a', request: createSessionReadBatchFetchBoundary(async (input, init) => {
            if (spawnedSessionId && new URL(String(input)).pathname === `/v2/sessions/${createdSessionId}`)
                return Response.json({ session });
            const path = new URL(String(input)).pathname;
            if (dictationFeatures && (path === '/v1/features' || path === '/v1/features/authenticated'))
                return Response.json(dictationFeatures);
            // Account bootstrap must serve the preferences this Home fixture declares;
            // returning an empty Account would legitimately disable the route mid-flow.
            if (path === '/v2/account/settings' && init?.method !== 'POST')
                return Response.json({ content: { t: 'plain', v: accountSettingsFixture }, version: 1 });
            const authoringResponse = await authoringMemoryHttp.handle(input, init);
            if (authoringResponse) return authoringResponse;
            if (path === `/v1/machines/${machineId}/access`) {
                const custodian = { accountId: 'account-a', displayName: 'Test Account' };
                return Response.json(MachineAccessGrantsListResponseV1Schema.parse({ machineId, custodian,
                    access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                    canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
                }));
            }
            if (path === '/v1/account/entity-rows/connected-accounts/purposes') {
                const { ConnectedAccountCatalogRowReadResponseV1Schema, emptyConnectedAccountCatalogRecordV1 } = await import('@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1');
                return Response.json(ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
                    content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1('purposes') } }));
            }
            const catalog = createEmptyAccountMigrationCensusHttpResponse(path, init);
            if (catalog) return catalog;
            return http.fetch(input, init);
        }) });
    restoreActionLoader = await installRealActionExecutorModuleLoader();
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: { workflows: true, automations: true } });
    storage.setState(state => ({ profile: { ...state.profile!, id: 'account-a' }, isDataReady: true,
        machines: { [machineId]: createMachineFixture({ id: machineId, activeAt: Date.now(),
            storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }) } }));
    const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
    observeMachinePresenceForTest({ serverId: connection.serverId, accountId: 'account-a' }, [machineId]);
    modals = []; workspace = undefined;
    // Expo's module-loader boundary resolves the actual production route modules.
    registerWorkspaceRouteContext(Object.assign((key: string) => {
        if (key === './(app)/workflows/index.tsx') return import('@/app/(app)/workflows/index');
        if (key === './(app)/workflows/[id]/index.tsx') return import('@/app/(app)/workflows/[id]/index');
        throw new Error(`Unexpected Workspace module: ${key}`);
    }, { keys: () => ['./(app)/workflows/index.tsx', './(app)/workflows/[id]/index.tsx'] }));
});
afterEach(async () => {
    standardCleanup();
    for (const release of releases.splice(0)) release();
    restoreActionLoader?.(); restoreActionLoader = undefined;
    await connection?.dispose(); connection = undefined;
    resetServerFeaturesClientForTests();
    vi.restoreAllMocks();
});

function CurrentContextApp(props: Readonly<{ hosted: boolean; editor: boolean }>) {
    return <CurrentUiContextProvider><CurrentUiContextActionHost /><ClientActionReverseRuntime />
                <KeyboardShortcutProvider handlers={{}}>
                    {props.hosted ? <HorizontalSafeAreaProvider value={{ left: 0, right: 0, padded: false }}>
                            <WorkspaceShell catalog={catalog} />{props.editor ? <WorkflowRouteEntry /> : <WorkflowsIndexRouteEntry />}
                        </HorizontalSafeAreaProvider> : props.editor ? <WorkflowRouteEntry /> : <WorkflowsColumnActions canCreate />}
                </KeyboardShortcutProvider>
            </CurrentUiContextProvider>;
}
function App(props: Readonly<{ hosted: boolean; editor: boolean }>) {
    if (!connection) throw new Error('Expected restored Account');
    const content = <NewSessionShellHostProvider><MainAppTabStateProvider>
        <CurrentContextApp {...props} />
    </MainAppTabStateProvider></NewSessionShellHostProvider>;
    return <InjectedAuthProvider credentials={connection.credentials}>
        <AppPaneModalProvider><ObserveModals />
            {props.hosted ? <WorkspaceProvider enabled={route.width === 1440} phone={route.width === 390} catalog={catalog}>{owner => {
                workspace = owner;
                return content;
            }}</WorkspaceProvider> : content}
        </AppPaneModalProvider>
    </InjectedAuthProvider>;
}

function connectAgentToApp() {
    const socket = sockets.slice().reverse().find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
    if (!socket) throw new Error('Expected the actual Account reverse receiver');
    const registered = new Set<string>();
    const emit = vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
        const payload: unknown = args[0];
        if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string') {
            if (event === SOCKET_RPC_EVENTS.REGISTER) registered.add(payload.method);
            if (event === SOCKET_RPC_EVENTS.UNREGISTER) registered.delete(payload.method);
        }
        return socket;
    });
    releases.push(() => emit.mockRestore());
    const receiver = { id: 'workflow-editor-app', timeout: () => ({ emitWithAck: async (_event: string, payload: unknown) =>
        await new Promise<unknown>(resolve => {
            for (const receive of socket.listeners(SOCKET_RPC_EVENTS.REQUEST)) receive(payload, resolve);
        }) }) };
    const reverse = createClientActionReverseDispatcher(() => ({
        hasConnectedClientRpcHandler: method => registered.has(`${machineId}:${method}`),
        callConnectedClientRpc: async (method, payload, options) => {
            const selection = selectRpcTarget({ targets: registered.has(`${machineId}:${method}`) ? [receiver] : [],
                answeringClient: options.answeringClient });
            if (selection.type !== 'target') return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' };
            options.onIssued();
            return { ok: true, result: await selection.target.timeout(0).emitWithAck(SOCKET_RPC_EVENTS.REQUEST,
                { method: `${machineId}:${method}`, params: JSON.parse(JSON.stringify(payload)) }) };
        },
    }));
    // The external Machine RPC transport above is the only dependency substituted.
    const executor = createActionExecutor({ clientActionExecute: reverse } as unknown as ActionExecutorDeps);
    return createActionToolExecutorBridge({ surface: 'agent', defaultSessionMachineId: machineId, executor: { execute: async (actionId, input, context) => {
        const result = await executor.execute(actionId, input, context);
        return result.ok ? { ok: true, result: result.result ?? null } : result;
    } } });
}

it.each([
    { source: 'new', width: 1440, hosted: false, dictation: false },
    { source: 'new', width: 390, hosted: false, dictation: false },
    { source: 'saved', width: 1440, hosted: false, dictation: false },
    { source: 'saved', width: 390, hosted: false, dictation: false },
    { source: 'new', width: 1440, hosted: true, dictation: false },
    { source: 'new', width: 390, hosted: true, dictation: false },
    { source: 'saved', width: 1440, hosted: true, dictation: false },
    { source: 'saved', width: 390, hosted: true, dictation: false },
    { source: 'new', width: 1440, hosted: true, dictation: true },
] as const)('keeps the Create agent on the visible $source editor at $width (workspace=$hosted, dictation=$dictation)', async ({ source, width, hosted, dictation }) => {
    route.width = width;
    if (dictation) {
        // Real Home deployment and Account preference inputs enable the production
        // focus path. Recording is never started, so no microphone/STT fixture is needed.
        dictationFeatures = createRootLayoutFeaturesResponse({ features: {
            voice: { enabled: true, happierVoice: { enabled: false } },
        } });
        primeServerFeaturesSnapshot({ serverId: connection!.serverId, snapshot: { status: 'ready', features: dictationFeatures } });
        storage.getState().applySettingsLocal({ featureToggles: { ...storage.getState().settings.featureToggles, voice: true } });
        accountSettingsFixture = settingsParse({ ...accountSettingsFixture,
            featureToggles: { ...accountSettingsFixture.featureToggles, voice: true } });
    }
    const agent = connectAgentToApp();
    const screen = await renderScreen(<App hosted={hosted} editor={false} />, { createNodeMock: element => {
        // Native refs/geometry are supplied by the OS; all focus and edit owners remain real.
        if (element.type === 'TextInput' || element.type === 'HappierComposerInput'
            || element.type === 'View' || element.type === 'Pressable') {
            // DOM ownership and event APIs stay real; TestRenderer supplies only host geometry.
            const host = document.createElement(element.type === 'TextInput' || element.type === 'HappierComposerInput' ? 'textarea' : 'div');
            return Object.assign(host, { setSelection() {}, setTextAndSelection() {}, setNativeProps() {},
                offsetAtPoint: async () => null, setDropCaret() {},
                getBoundingClientRect: () => new DOMRect(0, 0, route.width, 40),
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, route.width, 40),
            });
        }
        return null;
    } });
    if (hosted) {
        await act(async () => {
            const event = { nativeEvent: { layout: { x: 0, y: 0, width, height: 900 } } };
            screen.findHostByTestId('split-canvas-host')?.props.onLayout?.(event);
            for (const node of screen.tree.root.findAll(node => typeof node.type === 'string'
                && typeof node.props.testID === 'string' && node.props.testID.startsWith('split-canvas-content-slot-')))
                node.props.onLayout?.(event);
        });
    }
    if (hosted && width === 1440) {
        await vi.waitFor(() => expect(screen.findHostByTestId('workflows-home:agent')).not.toBeNull());
        await screen.pressByTestIdAsync('workflows-home:agent');
    } else {
        const menu = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'workflows-column:add:menu');
        if (!menu) throw new Error('Expected Create menu');
        await act(async () => menu.props.onSelect('agent'));
    }
    await vi.waitFor(() => expect(screen.findAllByType(WorkflowAgentAuthoringDraft)).toHaveLength(1));
    expect(screen.findHostByTestId('workflow-agent-authoring-sheet')).not.toBeNull();
    const authoringSheet = modals.find(modal => modal.type === 'custom' && modal.chrome?.testID === 'workflow-agent-authoring-sheet');
    if (!authoringSheet) throw new Error('Expected real authoring modal');
    await vi.waitFor(() => expect(screen.findHostByTestId('new-session-composer-send')).not.toBeNull());
    // The mounted document owns Send readiness; the visual CTA can appear while inventory settles.
    await vi.waitFor(() => {
        const panel = screen.findByType(NewSessionComposerCard).props.panelProps;
        const document = panel.composerDocument;
        const snapshot = document.readCurrentDocumentSnapshot();
        expect(snapshot?.state.submittable).toBe(true);
    });
    await screen.pressByTestIdAsync('new-session-composer-send');
    await vi.waitFor(() => expect(spawnedSessionId).toBe(createdSessionId));
    await vi.waitFor(() => expect(modals.some(modal => modal.id === authoringSheet.id && 'visible' in modal && modal.visible)).toBe(false));
    const pathname = source === 'new' ? '/workflows/new' : `/workflows/${savedId}`;
    if (hosted) await act(async () => workspace!.openHref(pathname));
    route.pathname = pathname;
    route.params = { id: source === 'new' ? 'new' : savedId };
    if (!hosted) window.history.replaceState(null, '', pathname);
    await screen.update(<App hosted={hosted} editor />);
    await vi.waitFor(() => expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(1));
    const body = screen.findByType(WorkflowEditorBody);
    const mounted = body.props.mountedDraftActions.getSnapshot();
    expect(mounted).toMatchObject({ scope: { serverId: connection!.serverId, accountId: 'account-a' } });
    expect(await agent.executeActionByToolName('action_execute', { actionId: 'ui.current_context.read', input: {} }, createdSessionId))
        .toMatchObject({ ok: true, result: { entity: { kind: 'workflow', reference: {
            scope: mounted.scope, draftId: mounted.draftId, ...(source === 'saved' ? { workflowId: savedId } : {}),
        } } } });
    const draft = await agent.executeActionByToolName('action_execute', { actionId: 'workflow.authoring.draft.get',
        input: { scope: mounted.scope } }, createdSessionId);
    expect(draft).toMatchObject({ ok: true, result: { status: 'available', drafts: [{ draftId: mounted.draftId }] } });
    // Focus the actual editable step prompt, preserving its mounted editor address.
    const step = body.props.draftStore.get().blocks.find((block: { kind: string }) => block.kind === 'step');
    if (!step) throw new Error('Expected the real editor initial step');
    const promptId = `workflow-editor-step-${step.id}-prompt`;
    const summaryId = promptId.replace(/-prompt$/, '-summary-prompt');
    if (screen.findHostByTestId(summaryId)) await screen.pressByTestIdAsync(summaryId);
    let prompt = screen.findHostByTestId(promptId);
    const preview = prompt?.findAll(node => node.props.testID === 'agent-input-document-preview-field'
        && typeof node.props.onPress === 'function').at(0);
    if (preview) await act(async () => preview.props.onPress());
    prompt = screen.findHostByTestId(promptId);
    const input = prompt?.findAll(node => node.type === 'HappierComposerInput'
        && typeof node.props.onComposerFocus === 'function').at(-1);
    if (!input) throw new Error('Expected the real editable step prompt platform input');
    await act(async () => input.props.onComposerFocus());
    await act(async () => input.props.onComposerChange({ nativeEvent: {
        text: 'Edited in the visible prompt', selection: { start: 28, end: 28 }, eventCount: 1, references: [],
    } }));
    const context = await agent.executeActionByToolName('action_execute', { actionId: 'ui.current_context.read', input: {} }, createdSessionId);
    if (dictation) {
        if (!context.ok) throw new Error('Expected current UI context after real Dictation field focus');
        expect(CurrentUiContextSnapshotV1Schema.parse(context.result).commands).toEqual(expect.arrayContaining([
            expect.objectContaining({ title: t('voiceAssistant.startDictation') }),
            expect.objectContaining({ title: t('voiceAssistant.endDictation') }),
        ]));
    }
    expect(context).toMatchObject({ ok: true, result: { entity: { kind: 'workflow', reference: {
        scope: mounted.scope, draftId: mounted.draftId, ...(source === 'saved' ? { workflowId: savedId } : {}),
    } } } });
    await act(async () => input.props.onComposerBlur?.());
    expect(await agent.executeActionByToolName('action_execute', { actionId: 'ui.current_context.read', input: {} }, createdSessionId))
        .toMatchObject({ ok: true, result: { entity: { reference: { draftId: mounted.draftId } } } });
});

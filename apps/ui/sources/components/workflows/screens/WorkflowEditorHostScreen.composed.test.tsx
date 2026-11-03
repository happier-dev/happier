import * as React from 'react';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import 'fake-indexeddb/auto';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen as renderHostScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { WorkflowTriggerSection } from '../triggers/WorkflowTriggerSection';
import { editWorkflowTriggerDraft } from '../triggers/workflowTriggerDraft';
import { flattenTestStyle, reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { ModalProvider as RealModalProvider, useModal } from '@/modal/ModalProvider';
import type { AlertModalConfig, ConfirmModalConfig, CustomModalConfig } from '@/modal/types';
import { WorkflowDefinitionCreateRequestV1Schema, WorkflowDefinitionGetRequestV1Schema, WorkflowDefinitionUpdateRequestV1Schema, WorkflowDefinitionV1Schema, WorkflowRunStartRequestV1Schema, type ActionExecutorContext, type WorkflowDefinitionCreateRequestV1, type WorkflowDefinitionGetRequestV1, type WorkflowDefinitionGetResultV1, type WorkflowDefinitionUpdateRequestV1, type WorkflowRunStartRequestV1, type WorkflowRunStartResultV1 } from '@happier-dev/protocol';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { AuthProvider } from '@/auth/context/AuthContext';
import { AgentInput } from '@/components/sessions/agentInput';
import { invokeTestInstanceHandler } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { readNewSessionDraftProjectionFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { getActionSpec } from '@happier-dev/protocol';
import { buildWorkflowReviewedRunSeed, storeWorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';
import { readWorkflowAgentRevision, storeWorkflowAgentRevision } from '@/sync/domains/workflows/workflowAgentRevision';
import { storeWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import { createWeeklyStorageReviewWorkflowSeed } from '@/components/automations/storage/weeklyStorageReviewTemplate';
import type { Machine } from '@/sync/domains/state/storageTypes';
// Resolve the real screen/store graph during collection, outside a behavioral
// test's timeout; Vitest hoists the system-boundary fixture declarations below.
import { WorkflowEditorHostScreen } from './WorkflowEditorHostScreen';
import { WorkflowEditorBody } from './WorkflowEditorBody';
import { WorkflowRunComposer } from '../run/WorkflowRunComposer';
import { insertWorkflowStarterExample } from '@/sync/domains/workflows/workflowEditorDraft';
import { removeWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WORKFLOW_STARTER_EXAMPLES_V1 } from '@happier-dev/protocol';
import { t } from '@/text';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { getActiveUnsavedChangesGuard, runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { CommonActions, StackActions, StackRouter } from '@react-navigation/native';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import type { RouteNode } from 'expo-router/build/Route';
import { workspaceRouteFiles } from '@/components/appShell/workspace/workspaceRoutes';
import { WorkflowEditorRoute } from './WorkflowEditorRoute';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { AppShellTitleStrip } from '@/components/navigation/shell/appRail/AppShellTitleStrip';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { apiSocket } from '@/sync/api/session/apiSocket';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { SyncServerTarget } from '@/sync/sync';
import { clearDaemonMergedProjectionCacheForTests, readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjection';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createWorkflowActionHttpTransport } from '@/dev/testkit/fixtures/workflowActionHttpTransport';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createWorkflowAutomationDetailFixture, createWorkflowAutomationHttpBoundary } from '@/dev/testkit/harness/workflowAutomationHttpBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { WorkflowDefinitionArtifactHeaderV1Schema, WorkflowDefinitionArtifactBodyV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { z } from 'zod/mini';

type WorkflowEditorBodyProps = React.ComponentProps<
    typeof import('./WorkflowEditorBody').WorkflowEditorBody
>;

let modals: ReturnType<typeof useModal>['state']['modals'] = [];
function ObserveModals() { modals = useModal().state.modals; return null; }
function visibleModals() { return modals.filter(modal => 'visible' in modal && modal.visible === true); }
function readAlert() { return visibleModals().reverse().find((modal): modal is AlertModalConfig => modal.type === 'alert'); }
function readConfirmation() { return visibleModals().reverse().find((modal): modal is ConfirmModalConfig => modal.type === 'confirm'); }
function readCustomModal(testID: string) { return visibleModals().reverse().find((modal): modal is CustomModalConfig =>
    modal.type === 'custom' && modal.chrome?.testID === testID); }
async function pressAlertButton(style: 'cancel' | 'destructive') {
    if (!editorScreen) throw new Error('Expected the mounted editor');
    const buttons = readAlert()?.buttons;
    const index = buttons?.findIndex(button => button.style === style) ?? -1;
    if (index < 0 || !buttons) throw new Error(`Expected a ${style} dialog control`);
    const testID = buttons.length === 2 ? (index === 0 ? 'web-modal-cancel' : 'web-modal-confirm') : `web-modal-button-${index}`;
    await editorScreen.pressByTestIdAsync(testID);
}
async function pressConfirmation(confirmed: boolean) {
    if (!editorScreen || !readConfirmation()) throw new Error('Expected a real confirmation dialog');
    await editorScreen.pressByTestIdAsync(confirmed ? 'web-modal-confirm' : 'web-modal-cancel');
}
async function confirmWorkflowAction<T>(run: () => Promise<T>): Promise<T> {
    let pending!: Promise<T>;
    await act(async () => { pending = run(); void pending.catch(() => undefined); });
    await vi.waitFor(() => expect(readConfirmation()).toBeDefined());
    await pressConfirmation(true);
    let result!: T;
    await act(async () => { result = await pending; });
    return result;
}
async function saveWithTriggerConfirmation() {
    await act(async () => { readBodyProps()!.onSave!(); });
    await vi.waitFor(() => expect(readConfirmation()).toBeDefined());
    await pressConfirmation(true);
    await vi.waitFor(() => expect(readBodyProps()!.savePending).toBe(false));
}
async function addConfirmedTrigger(request: Parameters<typeof import('@/sync/domains/workflows/workflowTriggerActions').addWorkflowTrigger>[0]) {
    // Fixture setup follows the same real confirmation boundary as a user;
    // unlike the app, an isolated domain call has no already-mounted shell.
    const shell = await renderScreen(<></>);
    const { addWorkflowTrigger } = await import('@/sync/domains/workflows/workflowTriggerActions');
    const result = await confirmWorkflowAction(() => addWorkflowTrigger(request));
    await shell.unmount();
    editorScreen = null;
    return result;
}
let editorScreen: Awaited<ReturnType<typeof renderHostScreen>> | null = null;
const draftActionHomeDisposers: Array<() => Promise<void>> = [];
let restoreWebGlobals: (() => void) | undefined;
let restoreActionExecutorLoader: (() => void) | undefined;
let editorAccount: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let editorHomeRequest: Parameters<typeof restoreServerAccountForTest>[0]['request'];
let runActionBoundary: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>> | null = null;
const editorCredentials = { token: createAccountTokenForTests('account-a', { currentAccount: true }) };
const editorArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => getStorage().getState().profileScope?.accountId ?? 'account-a', encryptionMode: 'plain' });
const editorAutomations = createWorkflowAutomationHttpBoundary();
let corruptStoredHeader = false;
let refuseArtifactRead = false;
let missingStoredArtifact = false;
let refuseArtifactCreate = false;
let loseArtifactCreateAcknowledgement = false;
const artifactReads: string[] = [];
const artifactMutationSchema = z.looseObject({ id: z.optional(z.string()), header: z.string(), body: z.string(),
    expectedHeaderVersion: z.optional(z.number().check(z.int())), expectedBodyVersion: z.optional(z.number().check(z.int())) });
const artifactResponseSchema = z.looseObject({ id: z.string(), header: z.string(), body: z.string(), dataEncryptionKey: z.string(),
    headerVersion: z.number().check(z.int()), bodyVersion: z.number().check(z.int()), access: z.enum(['owner', 'view', 'edit', 'admin']) });

function readArtifactMutation(raw: unknown, definitionId?: string) {
    const mutation = artifactMutationSchema.parse(raw);
    const header = WorkflowDefinitionArtifactHeaderV1Schema.parse(decodePlainArtifactStoredContent(mutation.header));
    const body = z.object({ body: z.string() }).parse(decodePlainArtifactStoredContent(mutation.body));
    const definition = WorkflowDefinitionArtifactBodyV1Schema.parse(JSON.parse(body.body)).definition;
    return { mutation, request: { definitionId: definitionId ?? mutation.id ?? header.definitionId,
        definition, metadata: header.metadata } };
}
const focusPromptSpy = vi.fn<(inputProps: Record<string, unknown>) => void>();
let rejectProjectMemoryWrite = false;
let preparedMemorySettings = AccountSettingsV2GetResponseSchema.parse({ content: null, version: 0 });
// As in Sync's owner tests, configure incumbent connection facts without
// replacing any memory, encryption, persistence or currentness operation.
type WorkflowMemoryRuntimeTestAccess = { credentials: AuthCredentials | undefined;
    pendingSettingsScope: AccountSettingsScope | null; appliedServerTarget: SyncServerTarget | null;
    authoringMemoryRuntime: unknown };
let memoryRuntime: WorkflowMemoryRuntimeTestAccess;
let originalMemoryRuntime: WorkflowMemoryRuntimeTestAccess;
function initializeMemoryRuntime(credentials: AuthCredentials, target: SyncServerTarget, scope: AccountSettingsScope) {
    Object.assign(memoryRuntime, { credentials, appliedServerTarget: target, pendingSettingsScope: scope, authoringMemoryRuntime: null });
    getStorage().getState().resetAuthoringMemory();
}
function initializePersonalWhereWriter() {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
    initializeMemoryRuntime({ token }, { serverId: 'server-a', serverUrl: 'https://server-a', generation: 0 }, { serverId: 'server-a', accountId: 'account-a' });
    getStorage().setState({ settingsScope: { serverId: 'server-a', accountId: 'account-a' } });
}

function requireDefined<T>(value: T | undefined, message: string): T {
    if (value === undefined) throw new Error(message);
    return value;
}

function createdDefinitionId(): string {
    return requireDefined(definitionActions.create.mock.calls.at(-1)?.[0].definitionId, 'Expected the HTTP Artifact create identity');
}

function readBodyProps(): WorkflowEditorBodyProps | null {
    if (!editorScreen) return null;
    try {
        const body = editorScreen.findAllByType(WorkflowEditorBody)[0];
        // Component identity narrows the renderer SDK's otherwise untyped props.
        return body ? body.props as WorkflowEditorBodyProps : null;
    }
    catch { return null; } // The native renderer no longer exposes an unmounted root.
}

function runComposerInput(screen: Awaited<ReturnType<typeof renderHostScreen>>) {
    return screen.findByType(WorkflowRunComposer).findByType(AgentInput);
}

async function settlePopoverLayout(screen: Awaited<ReturnType<typeof renderHostScreen>>) {
    // The native renderer never emits layout. Report the portal's physical
    // content size so the real Popover can make its Start control visible.
    await act(async () => {
        reportPopoverContentLayout(screen, { width: 520, height: 320 });
    });
    await flushHookEffects({ frames: 1 });
}

async function pressRunStart(screen: Awaited<ReturnType<typeof renderHostScreen>>) {
    await settlePopoverLayout(screen);
    await screen.pressByTestIdAsync('workflow-run-inputs-run');
}

async function renderScreen(element: React.ReactElement, options: Parameters<typeof renderHostScreen>[1] = {}) {
    const PaneWrapper = options.wrapper ?? AppPaneProvider;
    editorScreen = await renderHostScreen(element, { ...options,
        wrapper: ({ children }) => <AuthProvider initialCredentials={editorCredentials}><RealModalProvider><ObserveModals /><PaneWrapper>{children}</PaneWrapper></RealModalProvider></AuthProvider>,
        createNodeMock: options.createNodeMock ?? ((node) => ({
            focus: () => focusPromptSpy(node.props), blur: () => {}, setNativeProps: () => {},
            getBoundingClientRect: () => ({ left: 600, top: 100, width: 160, height: 40 }),
            ownerDocument: new EventTarget(),
            addEventListener: () => {}, removeEventListener: () => {},
            measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40),
        })),
    });
    await flushHookEffects({ frames: 1 });
    return editorScreen;
}

function renderRunEditor(element: React.ReactElement) {
    return renderScreen(element, {
        wrapper: ({ children }) => <AppPaneProvider>{children}</AppPaneProvider>,
        // Physical anchor geometry is the platform boundary; the Popover and composer stay real.
        createNodeMock: () => ({
            focus: () => {}, blur: () => {},
            // Native selection restoration is an input-platform boundary too.
            setNativeProps: () => {},
            offsetTop: 0, offsetHeight: 40, offsetWidth: 160,
            getBoundingClientRect: () => ({ left: 600, top: 100, width: 160, height: 40 }),
            ownerDocument: new EventTarget(),
            addEventListener: () => {}, removeEventListener: () => {},
            measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40),
        }),
    });
}

async function prepareRunAdmissionFixture() {
    if (!editorAccount) throw new Error('Expected the restored editor Account');
    const serverIdentityId = 'srv_workflow-editor-home';
    const serverUrl = editorAccount.home.serverUrl;
    runActionBoundary = await createExternalActionAccountHttpBoundary({
        serverUrl, serverIdentityId, accountId: 'account-a', machineId: 'machine-1',
        actionId: 'workflow.run.start', tokenEpoch: 0,
        execute: async (raw, context) => runStartSpy(WorkflowRunStartRequestV1Schema.parse(raw), { externalActionTarget: context.target }),
    });
    await editorAccount.dispose();
    editorAccount = await restoreServerAccountForTest({ serverUrl, serverIdentityId, accountId: 'account-a',
        credentials: editorCredentials, request: editorHomeRequest });
}

function switchEditorAccountScope(next: { serverId: string; accountId: string } | null): void {
    publishAppliedActiveServerSnapshot({ serverId: next?.serverId ?? '', serverUrl: 'https://server-a', generation: 0 }, next !== null);
    getStorage().setState({ profileScope: next });
}

function setEditorMachines(machines: Machine[]): void {
    getStorage().setState({ machines: Object.fromEntries(machines.map((machine) => [machine.id, machine])), machineListByServerId: {} });
}

function storeReviewedCopyFixture(): string {
    return storeWorkflowReviewedRunSeed(buildWorkflowReviewedRunSeed({
        run: createWorkflowRunSummaryFixture(),
        definition: createWorkflowDefinitionFixture({
            inputs: [{ name: 'topic', valueType: 'string', required: true }],
            defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        }),
        acceptedContext: {
            startedBy: 'user',
            source: { kind: 'inline' }, machineId: 'machine-1', origin: { kind: 'direct' },
            metadata: { title: 'Accepted title', description: 'Accepted description' },
            inputs: { topic: 'Private accepted input' }, executionTarget: { kind: 'session' }, materializedLeaves: [], frozenChildren: {},
            workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo/project', checkoutRootPath: '/repo/project' } },
        },
    }));
}

const routerSpy = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false), setParams: vi.fn() }));
const nativeRouteBoundary = vi.hoisted(() => ({ platform: 'web', width: 1280, pathname: '/', params: {} as Record<string, string | string[] | undefined> }));

const definitionActions = vi.hoisted(() => ({
    get: vi.fn<(request: WorkflowDefinitionGetRequestV1) => Promise<WorkflowDefinitionGetResultV1>>(),
    create: vi.fn<(request: WorkflowDefinitionCreateRequestV1) => Promise<WorkflowDefinitionGetResultV1>>(),
    update: vi.fn<(request: WorkflowDefinitionUpdateRequestV1) => Promise<WorkflowDefinitionGetResultV1>>(),
    delete: vi.fn(async () => ({ deleted: true, definitionId: '00000000-0000-4000-8000-000000000005' })),
}));
const SAVED_TRIGGER_WORKFLOW_ID = '00000000-0000-4000-8000-000000000005';
const TRIGGER_SET_ID = '00000000-0000-4000-8000-000000000009';
const workflowDocumentPicker = vi.hoisted(() => ({ pick: vi.fn() }));

/** What the route guard was told about unsaved changes, in order. */
const guardedDirtyStates = vi.hoisted(() => [] as boolean[]);

const issuedIds = vi.hoisted(() => ({ next: 0 }));

/** Whether the selected Machine's daemon projection has resolved, and to what. */
const daemonProjection = vi.hoisted(() => ({
    resolves: false,
}));

/** Children returned to the daemon that admitted their client Action parent. */
const admittedParentChildren = vi.hoisted(() => ({
    calls: [] as Array<{ method: string; params: unknown }>,
    outcome: 'refused' as 'applied' | 'refused',
}));

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary((socket) => {
    configureConnectedServerSocketBoundary(socket);
    socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, raw: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string') {
            throw new Error('Malformed native Machine RPC');
        }
        const method = raw.method.slice(raw.method.indexOf(':') + 1);
        if (method === RPC_METHODS.UI_ACTION_CHILD_EXECUTE) {
            admittedParentChildren.calls.push({ method: raw.method, params: 'params' in raw ? raw.params : undefined });
            if (admittedParentChildren.outcome === 'applied') {
                const { UiActionChildExecuteRequestV1Schema } = await import('@happier-dev/protocol/actions/clientDispatchV1');
                const child = UiActionChildExecuteRequestV1Schema.parse('params' in raw ? raw.params : undefined);
                const input = WorkflowDefinitionUpdateRequestV1Schema.parse(child.input);
                return { ok: true, result: { v: 1, execution: { ok: true, result: {
                    definitionId: input.definitionId, definition: input.definition, metadata: input.metadata,
                    revision: { headerVersion: input.expectedRevision.headerVersion + 1, bodyVersion: input.expectedRevision.bodyVersion + 1 },
                    access: 'owner',
                } } } };
            }
            // The admitting daemon owns the child's caller policy; this fixture refuses it.
            return { ok: true, result: { v: 1, execution: { ok: false, errorCode: 'run_access_denied', error: 'run_access_denied' } } };
        }
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE && daemonProjection.resolves) {
            return { ok: true, result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
                    claude: { id: 'claude', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
                        title: 'Claude Code', channel: 'plugin', isBuiltIn: true, catalogAgentId: 'claude',
                        providerOwnedEnvironmentKeys: [] },
                } },
            }) };
        }
        return { ok: false, error: 'Fixture daemon does not serve this method', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
    });
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return nativeRouteBoundary.platform; },
        select: (values: Record<string, unknown>) => values[nativeRouteBoundary.platform] ?? values.default },
        useWindowDimensions: () => ({ width: nativeRouteBoundary.width, height: 844, scale: 1, fontScale: 1 }) });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Radix's DOM SDK cannot mount in react-test-renderer. Keep the real menu,
// dismissal state and ModalProvider beneath this canonical platform boundary.
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsModuleMock } = await import('@/dev/testkit/mocks/radixCjs');
    return createRadixCjsModuleMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: routerSpy, navigation: {}, pathname: () => nativeRouteBoundary.pathname,
        params: () => nativeRouteBoundary.params }).module;
});
// Ids must be genuinely distinct here: a constant would make a re-created draft
// compare equal to its baseline and hide exactly the initialization defect these
// cases exist to catch.
vi.mock('expo-crypto', () => ({
    randomUUID: () => {
        issuedIds.next += 1;
        return `00000000-0000-4000-8000-${String(100_000_000_000 + issuedIds.next)}`;
    },
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/sync/domains/workflows/workflowDocumentFile', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/workflows/workflowDocumentFile')>(),
    pickWorkflowDocumentText: workflowDocumentPicker.pick,
    saveWorkflowDocument: vi.fn(),
}));
const runStartSpy = vi.hoisted(() => vi.fn<(request: WorkflowRunStartRequestV1, context: ActionExecutorContext) => Promise<WorkflowRunStartResultV1>>());
// Native removal is the navigation boundary; keep the draft guard and global
// departure decision real so a Save cannot hide a stale dirty verdict.
vi.mock('@react-navigation/native', async (importOriginal) => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    const actual = await importOriginal<typeof import('@react-navigation/native')>();
    return { ...createReactNavigationNativeMock({ usePreventRemove: (enabled) => {
        guardedDirtyStates.push(enabled);
    } }), CommonActions: actual.CommonActions, StackActions: actual.StackActions, StackRouter: actual.StackRouter };
});

beforeEach(async () => {
    await loadSyncSingletonForTests();
    const { sync } = await import('@/sync/sync');
    memoryRuntime = sync as unknown as WorkflowMemoryRuntimeTestAccess;
    originalMemoryRuntime = { credentials: memoryRuntime.credentials, pendingSettingsScope: memoryRuntime.pendingSettingsScope,
        appliedServerTarget: memoryRuntime.appliedServerTarget, authoringMemoryRuntime: memoryRuntime.authoringMemoryRuntime };
    restoreWebGlobals = withPopoverWebGlobals();
    editorScreen = null;
    runActionBoundary = null;
    nativeRouteBoundary.width = 1280;
    focusPromptSpy.mockClear();
    setEditorMachines([]);
    resetAcpCatalogEngineForTests();
    resetAcpCatalogSnapshotsForTests();
    getStorage().setState({ settings: settingsDefaults, settingsScope: null, isSessionDraftsReady: true,
        localSettings: { ...getStorage().getState().localSettings, uiMultiPanePanelsEnabled: true } });
    getStorage().getState().resetAuthoringMemory();
    getStorage().setState({ workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {} });
    guardedDirtyStates.length = 0;
    issuedIds.next = 0;
    routerSpy.push.mockClear();
    routerSpy.replace.mockReset();
    routerSpy.back.mockClear();
    routerSpy.canGoBack.mockReset().mockReturnValue(false);
    routerSpy.setParams.mockReset();
    nativeRouteBoundary.platform = 'web';
    nativeRouteBoundary.pathname = '/';
    nativeRouteBoundary.params = {};
    runStartSpy.mockReset();
    runStartSpy.mockImplementation(async (request) => ({ admission: 'created', run: createWorkflowRunSummaryFixture({ id: request.runId, origin: { kind: 'direct' } }) }));
    modals = [];
    definitionActions.delete.mockReset();
    definitionActions.get.mockReset();
    definitionActions.get.mockImplementation(async ({ definitionId }) => ({ definitionId, access: 'owner',
        definition: createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } }), revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved workflow' } }));
    definitionActions.create.mockReset();
    definitionActions.update.mockReset();
    workflowDocumentPicker.pick.mockReset();
    daemonProjection.resolves = false;
    editorArtifacts.clear();
    editorAutomations.clear();
    corruptStoredHeader = false;
    refuseArtifactRead = false;
    missingStoredArtifact = false;
    refuseArtifactCreate = false;
    loseArtifactCreateAcknowledgement = false;
    artifactReads.length = 0;
    clearDaemonMergedProjectionCacheForTests();
    restoreActionExecutorLoader = await installRealActionExecutorModuleLoader();
    const features = createRootLayoutFeaturesResponse();
    editorHomeRequest = async (input, init) => {
        const runResponse = await runActionBoundary?.handle(new URL(String(input)), init);
        if (runResponse) return runResponse;
        const path = new URL(String(input)).pathname;
        const automationResponse = await editorAutomations.handle(new URL(String(input)), init);
        if (automationResponse) return automationResponse;
        if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
        if (path.startsWith('/v1/features')) return Response.json(features);
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
            id => createPlainMachineRowFixture({ id, accountId: 'account-a' }));
        if (path.startsWith('/v1/machines/')) return Response.json({ machine: createPlainMachineRowFixture({
            id: decodeURIComponent(path.slice('/v1/machines/'.length)), accountId: 'account-a',
        }) });
        if (path.startsWith('/v1/artifacts') || path.startsWith('/v3/automations')) {
            if (/^\/v1\/artifacts\/[^/]+\/access\/grants$/.test(path)) return (await editorArtifacts.handle(path, init))!;
            const artifactId = /^\/v1\/artifacts\/([^/]+)$/.exec(path)?.[1];
            const method = init?.method ?? 'GET';
            if (artifactId && method === 'GET') {
                artifactReads.push(artifactId);
                if (missingStoredArtifact) return Response.json({ error: 'not-found' }, { status: 404 });
                // A terminal HTTP failure exercises manual Retry. A single
                // thrown fetch error is retried by the real transport owner.
                if (refuseArtifactRead) return Response.json({ error: 'Failed to read Artifact' }, { status: 400 });
            }
            if (path === '/v1/artifacts' && method === 'POST') {
                const { request } = readArtifactMutation(JSON.parse(String(init?.body)));
                await definitionActions.create(WorkflowDefinitionCreateRequestV1Schema.parse(request));
                if (refuseArtifactCreate) return Response.json({ error: 'Artifact write denied' }, { status: 403 });
                const response = (await editorArtifacts.handle(path, init))!;
                if (loseArtifactCreateAcknowledgement) {
                    loseArtifactCreateAcknowledgement = false;
                    refuseArtifactRead = true;
                    return Response.json({ error: 'Committed create acknowledgement unavailable' }, { status: 400 });
                }
                return response;
            }
            if (artifactId && method === 'POST') {
                const { mutation, request } = readArtifactMutation(JSON.parse(String(init?.body)), artifactId);
                try {
                    await definitionActions.update(WorkflowDefinitionUpdateRequestV1Schema.parse({ ...request,
                        expectedRevision: { headerVersion: mutation.expectedHeaderVersion, bodyVersion: mutation.expectedBodyVersion } }));
                } catch (error) {
                    if (error instanceof WorkflowActionError && error.code === 'currentness_conflict') {
                        return Response.json({ success: false, error: 'version-mismatch' });
                    }
                    throw error;
                }
                return (await editorArtifacts.handle(path, init))!;
            }
            if (artifactId && method === 'DELETE') {
                await definitionActions.delete();
                return (await editorArtifacts.handle(path, init))!;
            }
            // Minted ids belong to the canonical store; create's initial read
            // is absent and its readback opens exactly the persisted bytes.
            // A minted row is this Account's persisted create. Another Account
            // must receive its declared HTTP read (including access/revision),
            // never the previous Account's local persistence fixture.
            if (artifactId?.startsWith('00000000-0000-4000-8000-100')
                && getStorage().getState().profileScope?.accountId === 'account-a') {
                return (await editorArtifacts.handle(path, init))!;
            }
            // The external Home serves the test's current stored revision on
            // every read. Its typed Artifact producer supplies the opaque
            // bytes; real Action policy, identity and content opening run above it.
            const transport = createWorkflowActionHttpTransport({ accountId: () => getStorage().getState().profileScope?.accountId ?? 'account-a',
                fixtureResponse: async (actionId, request) => {
                    if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [] } };
                    if (actionId === 'workflow.definition.get') return { ok: true,
                        result: await definitionActions.get(WorkflowDefinitionGetRequestV1Schema.parse(request)) };
                    if (actionId === 'workflow.definition.delete') return { ok: true, result: await definitionActions.delete() };
                    throw new Error(`Unexpected fixture HTTP action: ${actionId}`);
                } });
            const response = await transport.fetch(input, init);
            if (artifactId && method === 'GET' && response.ok) {
                const produced = artifactResponseSchema.parse(await response.clone().json());
                if (corruptStoredHeader) produced.header = encodePlainArtifactStoredContent({ kind: 'invalid-workflow-header' });
                await editorArtifacts.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify(produced) });
                const stored = editorArtifacts.read(produced.id);
                if (!stored) throw new Error('Expected the seeded Artifact row');
                editorArtifacts.replaceStoredRow({ ...stored, ...produced });
                return Response.json(produced);
            }
            return response;
        }
        return Response.json({}, { status: 404 });
    };
    editorAccount = await restoreServerAccountForTest({ serverUrl: 'https://server-a', accountId: 'account-a',
        credentials: editorCredentials, request: editorHomeRequest });
    if (editorAccount.home.id !== 'server-a') throw new Error('Editor fixture must use its real saved Home id');
    expect(getStorage().getState().profileScope).toEqual({ serverId: 'server-a', accountId: 'account-a' });
    // The new Save consumer uses the real Account-memory runtime. Supply only
    // its prepared HTTP persistence boundary, sharing the canonical testkit CAS.
    rejectProjectMemoryWrite = false;
    preparedMemorySettings = AccountSettingsV2GetResponseSchema.parse({ content: null, version: 0 });
    const memory = createAuthoringMemoryHttpBoundary();
    const prepareRequest = apiSocket.createRequestForPreparedTarget.bind(apiSocket);
    vi.spyOn(apiSocket, 'createRequestForPreparedTarget').mockImplementation((target) => {
        const request = prepareRequest(target);
        return async (path, init) => {
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json(preparedMemorySettings);
            if (path.startsWith('/v1/account/authoring-memory')) {
                if (rejectProjectMemoryWrite && init?.method === 'POST' && path.includes('workflowProject')) {
                    throw new Error('Personal Workflow target persistence unavailable');
                }
                return (await memory.handle(new URL(path, target.endpoint), init))!;
            }
            return request(path, init);
        };
    });
});

afterEach(async () => {
    await standardCleanup();
    await editorAccount?.dispose();
    editorAccount = undefined;
    Object.assign(memoryRuntime, originalMemoryRuntime);
    for (const dispose of draftActionHomeDisposers.splice(0)) await dispose();
    restoreActionExecutorLoader?.();
    restoreActionExecutorLoader = undefined;
    restoreWebGlobals?.();
    restoreWebGlobals = undefined;
    if (nativeRouteBoundary.platform === 'ios') resetServerFeaturesClientForTests();
});

describe('unresolved editor create identity (FIX194)', () => {
    const definition = () => createWorkflowDefinitionFixture({ defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    } });
    const newSource = (name = 'Unresolved first Save') => ({ kind: 'new' as const,
        definitionDraftSeedId: storeWorkflowDefinitionDraftSeed({ name, definition: definition() }) });
    const createdRows = () => editorArtifacts.list().filter(row => row.id.startsWith('00000000-0000-4000-8000-100'));
    async function save() {
        let result: unknown;
        await act(async () => { result = await readBodyProps()!.mountedDraftActions!.execute('workflow.authoring.draft.save', {}); });
        return result;
    }
    async function copy() {
        await act(async () => { readBodyProps()!.onSaveAsCopy!(); });
        await vi.waitFor(() => expect(readBodyProps()!.savePending).toBe(false));
    }
    async function expectStored(id: string, title: string) {
        const { getWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        const stored = await getWorkflowDefinition({ definitionId: id });
        expect(stored.metadata.title).toBe(title);
        return stored;
    }

    it.each(['Save', 'Copy'] as const)('%s retries a committed POST after failed recovery reads with exactly one new Artifact', async kind => {
        await renderScreen(<WorkflowEditorHostScreen source={kind === 'Copy'
            ? { kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID } : newSource()} />);
        loseArtifactCreateAcknowledgement = true;
        if (kind === 'Copy') await copy();
        else expect(await save()).toMatchObject({ status: 'refused', reason: 'save_failed' });
        expect(readBodyProps()!.saveStatus).toMatchObject({ kind: 'failed' });
        const id = createdDefinitionId();
        expect(createdRows().map(row => row.id)).toEqual([id]);
        expect(artifactReads.filter(value => value === id).length).toBeGreaterThan(1);
        refuseArtifactRead = false;
        if (kind === 'Copy') await copy();
        else expect(await save()).toMatchObject({ status: 'applied' });
        expect(createdRows().map(row => row.id)).toEqual([id]);
        expect(readBodyProps()!.currentWorkflowRef).toBe(id);
        expect(readBodyProps()!.saveStatus).toMatchObject({ kind: 'saved' });
        await expectStored(id, kind === 'Copy' ? 'Saved workflow' : 'Unresolved first Save');
    });

    it.each(['Save', 'Copy'] as const)('%s retains a pre-effect refusal identity and saves later edits to that same Artifact', async kind => {
        await renderScreen(<WorkflowEditorHostScreen source={kind === 'Copy'
            ? { kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID } : newSource()} />);
        refuseArtifactCreate = true;
        if (kind === 'Copy') await copy();
        else expect(await save()).toMatchObject({ status: 'refused', reason: 'save_failed' });
        expect(readBodyProps()!.saveStatus).toMatchObject({ kind: 'failed' });
        const id = createdDefinitionId();
        expect(createdRows()).toHaveLength(0);
        await act(async () => { readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'Edited after refusal' }); });
        refuseArtifactCreate = false;
        expect(await save()).toMatchObject({ status: 'applied' });
        expect(createdRows().map(row => row.id)).toEqual([id]);
        await expectStored(id, 'Edited after refusal');
        expect(readBodyProps()!.mountedDraftActions!.getSnapshot()!.dirty).toBe(false);
    });

    it.each(['Save', 'Copy'] as const)('%s reconciles its original content before updating edits made during uncertainty', async kind => {
        await renderScreen(<WorkflowEditorHostScreen source={kind === 'Copy'
            ? { kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID } : newSource()} />);
        loseArtifactCreateAcknowledgement = true;
        if (kind === 'Copy') await copy(); else await save();
        const id = createdDefinitionId();
        const original = readBodyProps()!.draft;
        await act(async () => {
            readBodyProps()!.onChange({ ...original, name: 'Edited while uncertain', blocks: original.blocks.map(block => block.kind === 'step'
                ? { ...block, document: { ...block.document, text: 'New prompt after uncertain save' } } : block) });
            readBodyProps()!.onChangeDescription!('New description after uncertain save');
        });
        refuseArtifactRead = false;
        expect(await save()).toMatchObject({ status: 'applied' });
        expect(createdRows().map(row => row.id)).toEqual([id]);
        const stored = await expectStored(id, 'Edited while uncertain');
        expect(stored.metadata.description).toBe('New description after uncertain save');
        expect(stored.definition.blocks[0]).toMatchObject({ document: { text: 'New prompt after uncertain save' } });
        expect(readBodyProps()!.mountedDraftActions!.getSnapshot()!.dirty).toBe(false);
    });

    it('a deliberate Copy has a separate retained create identity from an unresolved first Save', async () => {
        await renderScreen(<WorkflowEditorHostScreen source={newSource()} />);
        loseArtifactCreateAcknowledgement = true;
        await save();
        const firstId = createdDefinitionId();
        refuseArtifactRead = false;
        loseArtifactCreateAcknowledgement = true;
        await copy();
        const copyId = createdDefinitionId();
        expect(copyId).not.toBe(firstId);
        refuseArtifactRead = false;
        expect(await save()).toMatchObject({ status: 'applied' });
        expect(createdRows().map(row => row.id)).toEqual([firstId, copyId]);
        await expectStored(copyId, 'Unresolved first Save');
        // Once acknowledged, another deliberate Copy is a new user intent.
        await copy();
        expect(createdRows()).toHaveLength(3);
        expect(createdDefinitionId()).not.toBe(copyId);
    });

    it.each(['source', 'Account'] as const)('retires unresolved create custody on %s replacement', async replacement => {
        const source = newSource();
        const screen = await renderScreen(<WorkflowEditorHostScreen source={source} />);
        loseArtifactCreateAcknowledgement = true;
        await save();
        const firstId = createdDefinitionId();
        if (replacement === 'Account') {
            await act(async () => { switchEditorAccountScope({ serverId: 'server-a', accountId: 'account-b' }); });
            expect(readBodyProps()).toBeNull();
            await act(async () => { switchEditorAccountScope({ serverId: 'server-a', accountId: 'account-a' }); });
        }
        refuseArtifactRead = false;
        await screen.update(<WorkflowEditorHostScreen source={newSource('Replacement document')} />);
        expect(await save()).toMatchObject({ status: 'applied' });
        const replacementId = createdDefinitionId();
        expect(replacementId).not.toBe(firstId);
        expect(createdRows().map(row => row.id)).toEqual([firstId, replacementId]);
        await expectStored(firstId, 'Unresolved first Save');
        await expectStored(replacementId, 'Replacement document');
    });

    it('the real owner/storage seam distinguishes recovery with the wrong id', async () => {
        await renderScreen(<WorkflowEditorHostScreen source={newSource()} />);
        loseArtifactCreateAcknowledgement = true;
        await save();
        const original = definitionActions.create.mock.calls.at(-1)![0];
        refuseArtifactRead = false;
        const { createWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        const wrongId = '00000000-0000-4000-8000-100999999999';
        await act(async () => { await createWorkflowDefinition({ ...original, definitionId: wrongId }); });
        expect(createdRows().map(row => row.id)).toEqual([original.definitionId, wrongId]);
        expect(await save()).toMatchObject({ status: 'applied' });
        expect(createdRows().map(row => row.id)).toEqual([original.definitionId, wrongId]);
    });
});

it('opens an editor-local workflow seed without waiting for the Session draft collection', async () => {
    const seedId = storeWorkflowDefinitionDraftSeed({ name: 'Retained seed', definition: createWorkflowDefinitionFixture() });
    getStorage().setState({ isDataReady: true, isSessionDraftsReady: false });
    const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId: seedId }} />);
    expect(readBodyProps()?.draft.name).toBe('Retained seed');
    const draftId = readBodyProps()?.draft.draftId;
    await act(async () => { getStorage().setState({ isSessionDraftsReady: true }); });
    expect(readBodyProps()?.draft.name).toBe('Retained seed');
    expect(readBodyProps()?.draft.draftId).toBe(draftId);
    await screen.unmount();
});

it('opens a saved definition entered before Account readiness without a library visit', async () => {
    switchEditorAccountScope(null);
    getStorage().setState({ isDataReady: false, isSessionDraftsReady: false });
    const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
    expect(readBodyProps()).toBeNull();
    expect(definitionActions.get).not.toHaveBeenCalled();
    await act(async () => {
        switchEditorAccountScope({ serverId: 'server-a', accountId: 'account-a' });
        getStorage().setState({ isDataReady: true, isSessionDraftsReady: true });
    });
    expect(readBodyProps()?.draft.name).toBe('Saved workflow');
    expect(readBodyProps()?.saveStatus?.kind).toBe('saved');
    expect(definitionActions.get).toHaveBeenCalledWith({ definitionId: SAVED_TRIGGER_WORKFLOW_ID });
    expect(definitionActions.create).not.toHaveBeenCalled();
    expect(definitionActions.update).not.toHaveBeenCalled();
    await screen.unmount();
});

/** A Plain Account HTTP boundary; Workflow admission, codecs and Artifact CAS stay real. */
async function serveMountedDraftActionHome(definition = createWorkflowDefinitionFixture({ defaults: {
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
} }), includeSavedArtifact = true, serverIdentityId?: string, settings?: Readonly<Record<string, unknown>>) {
    // The memory writer has a prepared HTTP boundary as well as the Home's
    // ordinary transport. Both consume this fixture's same explicit policy.
    if (settings) preparedMemorySettings = AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: settings }, version: 1 });
    const [{ serveActionHomes }, { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent },
        { WorkflowDefinitionArtifactHeaderV1Schema }, { z }, { tryWriteServerEnabledBitInPlace }] = await Promise.all([
        import('@/dev/testkit/harness/actionHomesHttpHarness'), import('@happier-dev/protocol/storage/artifactStoredContent'),
        import('@happier-dev/protocol/workflows/workflowDefinitionV1'), import('zod/mini'), import('@happier-dev/protocol'),
    ]);
    const artifact = {
        id: SAVED_TRIGGER_WORKFLOW_ID, ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent(WorkflowDefinitionArtifactHeaderV1Schema.parse({ kind: 'workflow-definition.v1',
            definitionId: SAVED_TRIGGER_WORKFLOW_ID, revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title: 'Saved workflow' }, previewSteps: [] })),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: 1, updatedAt: 1,
    };
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'workflows', true)) throw new Error('Undeclared Workflow feature');
    // This mirrors the HTTP persistence boundary, not the Workflow edit or Save logic.
    const updateSchema = z.looseObject({ header: z.string(), body: z.string(), expectedHeaderVersion: z.number().check(z.int()),
        expectedBodyVersion: z.number().check(z.int()) });
    const updates: Array<ReturnType<typeof updateSchema.parse> & { definitionId: string }> = [];
    const creates: Array<{ id: string; header: string; body: string; headerVersion: number; bodyVersion: number }> = [];
    const automationBoundary = createWorkflowAutomationHttpBoundary();
    const automationCreates = automationBoundary.creates;
    // Session callers carry their approval profile in the real owner metadata.
    // Serve those external records through both supported snapshot transports.
    const callerSessions = new Set(['session-agent', 'authoring-session', 'unavailable-author']);
    const sessionBoundary = createSessionReadBatchHttpBoundary(request => {
        const id = /^\/v2\/sessions\/([^/]+)$/.exec(request.path)?.[1];
        return id && callerSessions.has(id) ? Response.json(createPlainSessionByIdResponseFixture(
            createSessionFixture({ id }),
        )) : undefined;
    });
    const artifactCreated = createDeferred<void>();
    let updateGate: ReturnType<typeof createDeferred<void>> | null = null;
    let updateIssued: ReturnType<typeof createDeferred<void>> | null = null;
    let readGate: ReturnType<typeof createDeferred<void>> | null = null;
    let readIssued: ReturnType<typeof createDeferred<void>> | null = null;
    const boundary = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workflow-mcp.test',
        accountId: 'account-a', currentAccount: true, settings, ...(serverIdentityId ? { serverIdentityId } : {}) }], route: async request => {
        const sessionResponse = await sessionBoundary.handle(request);
        if (sessionResponse) return sessionResponse;
        if (request.method === 'POST' && request.path === '/v1/machines/read-batch') {
            return createMachineReadBatchResponseFixture(request.body,
                id => id === 'machine-a' ? createPlainMachineRowFixture({ id, accountId: 'account-a' }) : null);
        }
        if (request.path === '/v1/machines/machine-a') return Response.json({
            machine: createPlainMachineRowFixture({ id: 'machine-a', accountId: 'account-a' }) });
        if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(features);
        if (request.path === '/v1/account/encryption/currentness') {
            const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
            return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        }
        const grantsArtifactId = /^\/v1\/artifacts\/([^/]+)\/access\/grants$/.exec(request.path)?.[1];
        if (grantsArtifactId && (grantsArtifactId === artifact.id || creates.some(row => row.id === grantsArtifactId))) {
            return Response.json({ artifactId: grantsArtifactId, ownerAccountId: artifact.ownerAccountId, access: artifact.access, grants: [] });
        }
        const automationResponse = await automationBoundary.handle(request.url, { method: request.method,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
        if (automationResponse) return automationResponse;
        if (request.path === '/v1/artifacts' && request.method === 'POST') {
            const created = z.looseObject({ id: z.string(), header: z.string(), body: z.string() }).parse(request.body);
            creates.push({ ...created, headerVersion: 1, bodyVersion: 1 });
            artifactCreated.resolve();
            return Response.json({ ...artifact, ...created, headerVersion: 1, bodyVersion: 1 });
        }
        if (request.path.startsWith('/v1/artifacts/') && (!includeSavedArtifact || request.path !== `/v1/artifacts/${artifact.id}`)) {
            const created = creates.find(row => request.path === `/v1/artifacts/${row.id}`);
            if (!created) return Response.json({ error: 'not-found' }, { status: 404 });
            if (request.method === 'GET') return Response.json({ ...artifact, ...created });
            if (request.method !== 'POST') return undefined;
            const update = updateSchema.parse(request.body);
            updates.push({ ...update, definitionId: created.id });
            if (update.expectedHeaderVersion !== created.headerVersion || update.expectedBodyVersion !== created.bodyVersion) {
                return Response.json({ success: false, error: 'version-mismatch' });
            }
            created.header = update.header;
            created.body = update.body;
            created.headerVersion += 1;
            created.bodyVersion += 1;
            return Response.json({ success: true, headerVersion: created.headerVersion, bodyVersion: created.bodyVersion });
        }
        if (request.path !== `/v1/artifacts/${artifact.id}`) return undefined;
        if (request.method === 'GET') {
            const gate = readGate;
            readGate = null;
            readIssued?.resolve();
            readIssued = null;
            await gate?.promise;
            return Response.json(artifact);
        }
        if (request.method !== 'POST') return undefined;
        const update = updateSchema.parse(request.body);
        updates.push({ ...update, definitionId: artifact.id });
        updateIssued?.resolve();
        updateIssued = null;
        const gate = updateGate;
        updateGate = null;
        await gate?.promise;
        if (update.expectedHeaderVersion !== artifact.headerVersion || update.expectedBodyVersion !== artifact.bodyVersion) {
            return Response.json({ success: false, error: 'version-mismatch' });
        }
        artifact.header = update.header;
        artifact.body = update.body;
        artifact.headerVersion += 1;
        artifact.bodyVersion += 1;
        return Response.json({ success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion });
    } });
    const scope = { serverId: boundary.homes.home!.id, accountId: 'account-a' };
    publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: boundary.homes.home!.serverUrl, generation: 1 }, true);
    getStorage().setState({ profileScope: scope });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(boundary.homes.home!.serverUrl);
    if (!credentials) throw new Error('Expected synthetic Home credentials');
    initializeMemoryRuntime(credentials, { serverId: scope.serverId, serverUrl: boundary.homes.home!.serverUrl, generation: 1 }, scope);
    getStorage().setState({ profileScope: scope, settingsScope: scope, isSessionDraftsReady: true });
    primeServerFeaturesSnapshot({ serverId: scope.serverId, snapshot: { status: 'ready', features } });
    draftActionHomeDisposers.push(boundary.dispose);
    return { ...boundary, scope, artifact, updates, creates, automationCreates, artifactCreated: artifactCreated.promise, holdNextRead: () => {
        readGate = createDeferred<void>();
        readIssued = createDeferred<void>();
        return { ...readGate, issued: readIssued.promise };
    }, holdNextUpdate: () => {
        updateGate = createDeferred<void>();
        updateIssued = createDeferred<void>();
        return { ...updateGate, issued: updateIssued.promise };
    } };
}

describe('WorkflowEditorHostScreen composition', () => {
    it('Copy retires a conflict Test Run read and lets B open its own Test Run after A completes', async () => {
        nativeRouteBoundary.width = 390;
        const boundary = await serveMountedDraftActionHome();
        const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const { getWorkflowDefinition, updateWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        const original = await getWorkflowDefinition({ definitionId: SAVED_TRIGGER_WORKFLOW_ID });
        await updateWorkflowDefinition({ definitionId: original.definitionId, expectedRevision: original.revision,
            definition: original.definition, metadata: { title: 'A changed elsewhere' } });
        await act(async () => { readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'B local changes' }); });
        await act(async () => { await readBodyProps()!.onSave!(); });
        expect(readBodyProps()!.saveConflict).toMatchObject({ currentRevision: { headerVersion: 2, bodyVersion: 2 } });
        const gate = boundary.holdNextRead();
        try {
            await act(async () => { readBodyProps()!.onTestRun!(); });
            await gate.issued;
            expect(readBodyProps()!.testRunPending).toBe(true);
            const copyControl = screen.findAllByType(WorkflowEditorBody)[0]!.findAll(node =>
                typeof node.props.testID === 'string' && node.props.testID.endsWith('-save-as-copy')
                && typeof node.props.onPress === 'function')[0];
            expect(copyControl).toBeDefined();
            await act(async () => { await invokeTestInstanceHandler(copyControl!, 'onPress'); });
            expect(boundary.creates).toHaveLength(1);
            await vi.waitFor(() => expect(readBodyProps()!.savePending).toBe(false));
            expect(readBodyProps()!.saveConflict).toBeNull();
            gate.resolve();
            await flushHookEffects();
            expect(readBodyProps()!.testRunPending).toBe(false);
            expect(readBodyProps()!.runPending).toBe(false);
            expect(readCustomModal('workflow-run-inputs-modal')).toBeUndefined();
            await act(async () => { readBodyProps()!.onTestRun!(); });
            await flushHookEffects();
            expect(readCustomModal('workflow-run-inputs-modal')?.props?.sourceArtifactId).toBe(boundary.creates[0]!.id);
            expect(readCustomModal('workflow-run-inputs-modal')?.props?.workflowName).toBe('B local changes');
            expect(readBodyProps()!.testRunPending).toBe(false);
            await act(async () => readCustomModal('workflow-run-inputs-modal')?.onRequestClose?.());
        } finally {
            gate.resolve();
        }
    });
    it.each([false, true])('Copy retires the original Agent revision and keeps copy memory retry (memory failure=%s)', async (memoryFailure) => {
        const boundary = await serveMountedDraftActionHome();
        const project = { machineId: 'saved-machine', directory: '/saved-project' };
        getStorage().getState().applyAuthoringMemory({ workflowProjectTargetsByDefinitionId: { [SAVED_TRIGGER_WORKFLOW_ID]: project } });
        getStorage().setState({ sessions: { 'author-session': createSessionFixture({ id: 'author-session', seq: 100 }) }, sessionMessages: {} });
        const { getWorkflowDefinition, updateWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        const original = await getWorkflowDefinition({ definitionId: SAVED_TRIGGER_WORKFLOW_ID });
        const seedId = storeWorkflowAgentRevision({ ...original, changedBlockIds: [] }, 'author-session');
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID, agentRevisionSeedId: seedId }} />);
        const acceptedDraft = readBodyProps()!.draft;
        rejectProjectMemoryWrite = memoryFailure;
        await act(async () => { readBodyProps()!.onSaveAsCopy!(); });
        const copy = boundary.creates[0]!;
        expect(copy).toBeDefined();
        expect(readBodyProps()!.authoringSessionId).toBeNull();
        const revised = await updateWorkflowDefinition({ definitionId: original.definitionId, expectedRevision: original.revision,
            definition: original.definition, metadata: { title: 'Original Agent revision after Copy' } });
        const completed = createToolCallMessageFixture({ seq: 101, tool: { ...createToolCallMessageFixture().tool,
            name: `mcp__happier__${getActionSpec('workflow.definition.update').bindings?.mcpToolName}`,
            state: 'completed', completedAt: 1, input: {}, result: revised } });
        await act(async () => getStorage().setState({ sessionMessages: { 'author-session': createSessionMessagesFixture({
            messagesById: { [completed.id]: completed }, messageIdsOldestFirst: [completed.id], isLoaded: true,
        }) } }));
        expect(readBodyProps()!.draft).toEqual(acceptedDraft);
        expect(readBodyProps()!.saveConflict).toBeNull();
        rejectProjectMemoryWrite = false;
        await act(async () => { expect(await readBodyProps()!.mountedDraftActions!.execute('workflow.authoring.draft.save', {}))
            .toMatchObject({ status: 'applied' }); });
        expect(getStorage().getState().authoringMemory.workflowProjectTargetsByDefinitionId[copy.id]).toEqual(project);
        expect(boundary.creates).toHaveLength(1);
        expect(boundary.updates).toHaveLength(1); // Only the real Agent update to A.
        expect(readBodyProps()!.mountedDraftActions!.getSnapshot()!.dirty).toBe(false);
        await act(async () => { readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'Copy changed after original Agent revision' });
            expect(await readBodyProps()!.mountedDraftActions!.execute('workflow.authoring.draft.save', {}))
                .toMatchObject({ status: 'applied' }); });
        expect(boundary.updates).toHaveLength(2);
        expect(boundary.updates[1]).toMatchObject({ definitionId: copy.id, expectedHeaderVersion: 1, expectedBodyVersion: 1 });
    });

    it('Copy retires a pending Agent composer callback and seeds new Agent editing with the copy', async () => {
        await prepareSessionDraftPersistenceStorage();
        const boundary = await serveMountedDraftActionHome();
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        await act(async () => { readBodyProps()!.onEditWithAgent!(); });
        const pending = readBodyProps()!.authoringDraft!;
        expect(pending).toBeDefined();
        await act(async () => { readBodyProps()!.onSaveAsCopy!(); });
        const copyId = boundary.creates[0]!.id;
        expect(readBodyProps()!.authoringDraft).toBeUndefined();
        await act(async () => { pending.onSessionCreated('/session/original-author', { sessionId: 'original-author', serverId: boundary.scope.serverId }); });
        expect(readBodyProps()!.authoringSessionId).toBeNull();
        await act(async () => { readBodyProps()!.onEditWithAgent!(); });
        const next = readBodyProps()!.authoringDraft!;
        expect(next).toBeDefined();
        expect(next.draftId).not.toBe(pending.draftId);
        const seed = readNewSessionDraftProjectionFromRepository({ draftId: next.draftId, scope: boundary.scope });
        expect(seed?.draft.input).toContain(`definitionId=${copyId}`);
        await act(async () => { next.onSessionCreated('/session/copy-author', { sessionId: 'copy-author', serverId: boundary.scope.serverId }); });
        expect(readBodyProps()!.authoringSessionId).toBe('copy-author');
    });

    it.each(['add', 'remove'] as const)('Copy retires original pending trigger %s and its Undo history before normal Save', async (kind) => {
        const boundary = await serveMountedDraftActionHome();
        const { AutomationTriggerIdSchema } = await import('@happier-dev/protocol');
        const project = { machineId: 'machine-a', directory: '/repo' };
        const trigger = { kind: 'schedule' as const, enabled: true,
            schedule: { kind: 'interval' as const, everyMs: 86400000, scheduleExpr: null, timezone: null } };
        const initial = await addConfirmedTrigger({ workflow: SAVED_TRIGGER_WORKFLOW_ID, project, trigger });
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const section = readBodyProps()!.triggersSection;
        if (!React.isValidElement<React.ComponentProps<typeof WorkflowTriggerSection>>(section)) throw new Error('Missing trigger editor');
        await act(async () => { section.props.onChangeDraft(editWorkflowTriggerDraft(section.props.draft,
            kind === 'add' ? { kind: 'add', clientId: 'pending-original-trigger', trigger }
                : { kind: 'remove', triggerId: AutomationTriggerIdSchema.parse(initial.triggerId) })); });
        expect(readBodyProps()!.history!.undoLabel).not.toBeNull();
        await act(async () => { readBodyProps()!.onSaveAsCopy!(); });
        const snapshot = readBodyProps()!.mountedDraftActions!.getSnapshot()!;
        expect(boundary.creates[0]!.id).not.toBe(SAVED_TRIGGER_WORKFLOW_ID);
        expect(snapshot.settings.triggers.rows).toEqual([]);
        expect(readBodyProps()!.history!.undoLabel).toBeNull();
        await act(async () => { readBodyProps()!.history!.undo();
            expect(await readBodyProps()!.mountedDraftActions!.execute('workflow.authoring.draft.save', {})).toMatchObject({ status: 'applied' }); });
        expect(boundary.requests.filter(request => request.path.startsWith('/v3/automations') && request.method !== 'GET')).toHaveLength(1);
        expect(getStorage().getState().workflowTriggerSetsById[initial.set.automationId]?.triggers).toHaveLength(1);
    });

    it('Copy retires the originating inline-trigger retarget while retaining personal-memory retry', async () => {
        const boundary = await serveMountedDraftActionHome();
        const { storeTriggerWorkflowSeed } = await import('../triggers/triggerWorkflowSeed');
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } });
        const project = { machineId: 'machine-a', directory: '/repo' };
        const initial = await addConfirmedTrigger({ target: { kind: 'inline', definition }, project,
            trigger: { kind: 'schedule', enabled: true, schedule: { kind: 'interval', everyMs: 86400000, scheduleExpr: null, timezone: null } } });
        const seedId = storeTriggerWorkflowSeed({ definition, retarget: { scope: 'account',
            automationId: initial.set.automationId, triggerId: initial.triggerId, expectedRevision: initial.set.revision } });
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', triggerWorkflowSeedId: seedId }} />);
        await act(async () => { readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'Copy of trigger' });
            readBodyProps()!.onChangeProjectTarget!(project); });
        rejectProjectMemoryWrite = true;
        await act(async () => { readBodyProps()!.onSaveAsCopy!(); });
        expect(boundary.creates, JSON.stringify(readBodyProps()!.saveStatus)).toHaveLength(1);
        const copyId = boundary.creates[0]!.id;
        rejectProjectMemoryWrite = false;
        await act(async () => { expect(await readBodyProps()!.mountedDraftActions!.execute('workflow.authoring.draft.save', {}))
            .toMatchObject({ status: 'applied' }); });
        expect(getStorage().getState().authoringMemory.workflowProjectTargetsByDefinitionId[copyId]).toEqual(project);
        expect(boundary.requests.filter(request => request.path.startsWith('/v3/automations') && request.method !== 'GET')).toHaveLength(1);
        expect(getStorage().getState().workflowTriggerSetsById[initial.set.automationId]?.target?.kind).toBe('inline');
    });

    it('retries personal Where after copying fails to persist it, without creating another copy', async () => {
        const boundary = await serveMountedDraftActionHome();
        const project = { machineId: 'saved-machine', directory: '/saved-project' };
        getStorage().getState().applyAuthoringMemory({ workflowProjectTargetsByDefinitionId: { [SAVED_TRIGGER_WORKFLOW_ID]: project } });
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        rejectProjectMemoryWrite = true;
        await act(async () => { readBodyProps()!.onSaveAsCopy!(); });
        expect(boundary.creates).toHaveLength(1);
        const copiedId = boundary.creates[0]!.id;
        expect(copiedId).not.toBe(SAVED_TRIGGER_WORKFLOW_ID);
        expect(readBodyProps()!.saveStatus).toMatchObject({ kind: 'failed' });
        expect(readBodyProps()!.mountedDraftActions!.getSnapshot()!.dirty).toBe(true);
        rejectProjectMemoryWrite = false;
        let result: unknown;
        await act(async () => { result = await readBodyProps()!.mountedDraftActions!.execute('workflow.authoring.draft.save', {}); });
        expect(result).toMatchObject({ status: 'applied' });
        expect(getStorage().getState().authoringMemory.workflowProjectTargetsByDefinitionId[copiedId]).toEqual(project);
        expect(boundary.creates).toHaveLength(1);
        expect(boundary.updates).toHaveLength(0);
        expect(readBodyProps()!.mountedDraftActions!.getSnapshot()!.dirty).toBe(false);
    });
    it('saves personal Where through the real Account memory writer and retains it on reopen', async () => {
        initializePersonalWhereWriter();
        const project = { machineId: 'saved-machine', directory: '/saved-project', workspaceRefId: 'saved-workspace' };
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        await act(async () => { readBodyProps()!.onChangeProjectTarget!(project); });
        expect(readBodyProps()!.mountedDraftActions!.getSnapshot()!.dirty).toBe(true);
        let result: unknown;
        await act(async () => { result = await readBodyProps()!.mountedDraftActions!.execute('workflow.authoring.draft.save', {}); });
        expect(result, JSON.stringify(readBodyProps()!.saveStatus)).toMatchObject({ status: 'applied' });
        expect(getStorage().getState().authoringMemory.workflowProjectTargetsByDefinitionId[SAVED_TRIGGER_WORKFLOW_ID]).toEqual(project);
        expect(definitionActions.update).not.toHaveBeenCalled();
        await screen.unmount();
        getStorage().getState().applyAuthoringMemory({ recentMachinePaths: [{ machineId: 'recent-machine', path: '/other' }] });
        setEditorMachines([createMachineFixture({ id: 'recent-machine' })]);
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        expect(readBodyProps()!.projectTarget).toEqual(project);
        expect(readBodyProps()!.mountedDraftActions!.getSnapshot()!.dirty).toBe(false);
    });
    it('keeps a failed personal Where save unsaved and retries without another definition write', async () => {
        initializePersonalWhereWriter();
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const project = { machineId: 'saved-machine', directory: '/saved-project' };
        await act(async () => { readBodyProps()!.onChangeProjectTarget!(project); });
        rejectProjectMemoryWrite = true;
        let result: unknown;
        await act(async () => { result = await readBodyProps()!.mountedDraftActions!.execute('workflow.authoring.draft.save', {}); });
        expect(result).toMatchObject({ status: 'refused', reason: 'save_failed' });
        expect(readBodyProps()!.saveStatus).toMatchObject({ kind: 'failed' });
        expect(readBodyProps()!.mountedDraftActions!.getSnapshot()!.dirty).toBe(true);
        expect(getStorage().getState().authoringMemory.workflowProjectTargetsByDefinitionId[SAVED_TRIGGER_WORKFLOW_ID]).toBeUndefined();
        rejectProjectMemoryWrite = false;
        await act(async () => { result = await readBodyProps()!.mountedDraftActions!.execute('workflow.authoring.draft.save', {}); });
        expect(result, JSON.stringify(readBodyProps()!.saveStatus)).toMatchObject({ status: 'applied' });
        expect(readBodyProps()!.saveStatus).toMatchObject({ kind: 'saved' });
        expect(definitionActions.update).not.toHaveBeenCalled();
    });
    it('retains the acknowledged target when clearing personal Where fails, and retries its tombstone', async () => {
        initializePersonalWhereWriter();
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const project = { machineId: 'saved-machine', directory: '/saved-project' };
        await act(async () => { readBodyProps()!.onChangeProjectTarget!(project); });
        await act(async () => { await readBodyProps()!.mountedDraftActions!.execute('workflow.authoring.draft.save', {}); });
        await act(async () => {
            const snapshot = readBodyProps()!.mountedDraftActions!.getSnapshot()!;
            expect(await readBodyProps()!.mountedDraftActions!.execute('workflow.authoring.draft.edit', {
                scope: snapshot.scope, draftId: snapshot.draftId,
                expectedDraftRevision: snapshot.draftRevision, settings: { projectTarget: null },
            })).toMatchObject({ status: 'applied' });
        });
        rejectProjectMemoryWrite = true;
        let result: unknown;
        await act(async () => { result = await readBodyProps()!.mountedDraftActions!.execute('workflow.authoring.draft.save', {}); });
        expect(result).toMatchObject({ status: 'refused', reason: 'save_failed' });
        expect(readBodyProps()!.saveStatus).toMatchObject({ kind: 'failed' });
        expect(readBodyProps()!.mountedDraftActions!.getSnapshot()!.dirty).toBe(true);
        expect(getStorage().getState().authoringMemory.workflowProjectTargetsByDefinitionId[SAVED_TRIGGER_WORKFLOW_ID]).toEqual(project);
        rejectProjectMemoryWrite = false;
        await act(async () => { result = await readBodyProps()!.mountedDraftActions!.execute('workflow.authoring.draft.save', {}); });
        expect(result).toMatchObject({ status: 'applied' });
        expect(getStorage().getState().authoringMemory.workflowProjectTargetsByDefinitionId[SAVED_TRIGGER_WORKFLOW_ID]).toBeUndefined();
        expect(readBodyProps()!.mountedDraftActions!.getSnapshot()!.dirty).toBe(false);
    });
    it('rehydrates a saved Workflow Where from personal memory instead of unrelated recent Session context', async () => {
        const project = { machineId: 'saved-machine', directory: '/saved-project', workspaceRefId: 'saved-workspace' };
        getStorage().setState({ authoringMemory: { ...getStorage().getState().authoringMemory,
            recentMachinePaths: [{ machineId: 'recent-machine', path: '/recent-session' }],
            workflowProjectTargetsByDefinitionId: { [SAVED_TRIGGER_WORKFLOW_ID]: project } } });
        setEditorMachines([createMachineFixture({ id: 'saved-machine' }), createMachineFixture({ id: 'recent-machine' })]);
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        await act(async () => {});
        expect(readBodyProps()?.projectTarget).toEqual(project);
        expect(readBodyProps()?.composerScope).toMatchObject({ kind: 'machine', machineId: 'saved-machine', directory: '/saved-project' });
    });
    it('a session Agent MCP Action reaches the real mounted draft through admitted client routing', async () => {
        const boundary = await serveMountedDraftActionHome();
        {
            const [{ createClientActionReverseDispatcher },
                { createActionExecutor }, { listActionSpecs }, { RPC_METHODS }, { apiSocket },
                { ClientActionReverseRuntime }, { selectRpcTarget }] = await Promise.all([
                import('../../../../../cli/src/session/actions/clientActionReverseDispatch'),
                import('@happier-dev/protocol/actions/actionExecutor'),
                import('@happier-dev/protocol/actions/actionSpecs'), import('@happier-dev/protocol/rpc/methods'),
                import('@/sync/api/session/apiSocket'), import('@/components/appShell/runtime/ClientActionReverseRuntime'),
                import('../../../../../server/sources/app/api/socket/rpc/rpcTargetSelection'),
            ]);
            const { scope } = boundary;
            getStorage().setState({ profile: { ...getStorage().getState().profile!, id: scope.accountId } });
            setEditorMachines([createMachineFixture({ id: 'machine-1', activeAt: Date.now() })]);
            type Handler = Parameters<typeof apiSocket.registerMachineScopedRpcHandler>[2];
            const editorMethods = new Map<string, Handler>();
            // Only the socket registration/delivery boundary is substituted. The real
            // mounted owner, runtime registration and server target selector run below.
            const register = vi.spyOn(apiSocket, 'registerMachineScopedRpcHandler').mockImplementation((_machine, method, handler) => {
                editorMethods.set(method, handler);
                return () => { if (editorMethods.get(method) === handler) editorMethods.delete(method); };
            });
            const screen = await renderRunEditor(<><ClientActionReverseRuntime />
                <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} /></>);
            const original = readBodyProps()!.draft;
            const caller = createActionExecutor({ clientActionExecute: createClientActionReverseDispatcher(() => ({
                hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE || editorMethods.has(method),
                callConnectedClientRpc: async (method, request, options) => {
                    const timeout = () => ({ emitWithAck: async () => { throw new Error('Delivery belongs to the socket boundary below'); } });
                    const driver = { id: 'a-driver-tab', data: {}, timeout };
                    const editor = { id: 'z-editor-tab', data: {}, timeout };
                    const selection = selectRpcTarget({ targets: [
                        ...(method === RPC_METHODS.UI_ACTION_EXECUTE ? [driver] : []),
                        ...(editorMethods.has(method) ? [editor] : []),
                    ] });
                    if (selection.type !== 'target') return { ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE' };
                    options.onIssued();
                    return { ok: true, result: selection.target.id === driver.id
                        ? { v: 1, execution: { ok: true, result: { status: 'unavailable' } } }
                        : await editorMethods.get(method)!(request, { signal: options.signal ?? new AbortController().signal }) };
                },
            })) } as unknown as import('@happier-dev/protocol').ActionExecutorDeps);
            const context = { surface: 'mcp' as const, authority: 'account_automation' as const,
                actionCaller: { kind: 'session' as const, sessionId: 'session-agent', starterDepth: 0, turnDepth: 0 },
                defaultSessionId: 'session-agent', serverId: scope.serverId };
            const tool = listActionSpecs().find(spec => spec.bindings?.mcpToolName === 'workflow_authoring_draft_get')!;
            const read = await caller.execute(tool.id, { scope, draftId: original.draftId }, context);
            if (!read.ok) throw new Error(read.error);
            const { WorkflowDraftGetResultV1Schema } = await import('@happier-dev/protocol/actions/workflowAuthoringAction');
            const result = WorkflowDraftGetResultV1Schema.parse(read.result);
            if (result.status !== 'available') throw new Error(`Mounted editor is unavailable; methods: ${[...editorMethods.keys()].join(', ')}`);
            const editTool = listActionSpecs().find(spec => spec.bindings?.mcpToolName === 'workflow_authoring_draft_edit')!;
            await act(async () => {
                expect(await caller.execute(editTool.id, { scope, draftId: original.draftId,
                    expectedDraftRevision: result.drafts[0]!.draftRevision,
                    ops: [{ kind: 'set_step_prompt', blockId: original.blocks[0]!.id, text: 'Prepared through the Session MCP route' }] }, context))
                    .toMatchObject({ ok: true, result: { status: 'applied', changedBlockIds: [original.blocks[0]!.id] } });
            });
            expect(readBodyProps()!.draft.blocks[0]).toMatchObject({ document: { text: 'Prepared through the Session MCP route' } });
            expect(readBodyProps()!.highlightedBlockIds).toEqual([original.blocks[0]!.id]);
            expect(definitionActions.update).not.toHaveBeenCalled();
            expect(runStartSpy).not.toHaveBeenCalled();
            expect(boundary.updates).toEqual([]);
            await act(async () => { readBodyProps()!.history!.undo(); });
            expect(readBodyProps()!.draft).toEqual(original);
            expect(await caller.execute(tool.id, { scope: { ...scope, accountId: 'other-account' }, draftId: original.draftId }, context))
                .toEqual({ ok: true, result: { status: 'unavailable' } });
            await act(async () => { screen.update(<><ClientActionReverseRuntime />
                <WorkflowEditorHostScreen source={{ kind: 'new' }} /></>); });
            const replacement = readBodyProps()!.draft;
            expect(replacement.draftId).not.toBe(original.draftId);
            expect(await caller.execute(tool.id, { scope, draftId: original.draftId }, context))
                .toEqual({ ok: true, result: { status: 'unavailable' } });
            expect(await caller.execute(tool.id, { scope, draftId: replacement.draftId }, context))
                .toMatchObject({ ok: true, result: { status: 'available', drafts: [{ draftId: replacement.draftId }] } });
            await act(async () => { screen.unmount(); });
            expect(await caller.execute(tool.id, { scope, draftId: replacement.draftId }, context))
                .toEqual({ ok: true, result: { status: 'unavailable' } });
            register.mockRestore();
        }
    });
    it('does not load or create an editor when mounted draft Actions have no answering host', async () => {
        const { invokeWorkflowAuthoringAction } = await import('@/sync/ops/actions/workflowAuthoringAction');
        expect(await invokeWorkflowAuthoringAction({ actionId: 'workflow.authoring.draft.get',
            input: { scope: { serverId: 'server-a', accountId: 'account-a' }, draftId: 'not-mounted' },
            context: { serverId: 'server-a', runtimeAccountId: 'account-a' } })).toEqual({ status: 'unavailable' });
        expect(definitionActions.get).not.toHaveBeenCalled();
        expect(definitionActions.create).not.toHaveBeenCalled();
    });
    it('mounted draft Actions edit atomically, tint, refuse stale revisions and share host undo/redo and Save', async () => {
        const boundary = await serveMountedDraftActionHome();
        const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
        const owners = await import('@/sync/ops/actions/workflowAuthoringAction');
        const executor = createActionExecutor({ workflowAuthoringAction: owners.invokeWorkflowAuthoringAction,
            isActionApprovalRequired: () => false } as unknown as import('@happier-dev/protocol').ActionExecutorDeps);
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: boundary.scope.serverId, runtimeAccountId: boundary.scope.accountId };
        await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const original = readBodyProps()!.draft;
        const address = { scope: boundary.scope, draftId: original.draftId };
        const get = async () => {
            const result = await executor.execute('workflow.authoring.draft.get', address, context);
            if (!result.ok) throw new Error(result.error);
            return result.result as { status: string; drafts: Array<{ draftRevision: number; dirty: boolean }> };
        };
        const initial = await get();
        expect(initial.status).toBe('available');
        expect(await executor.execute('workflow.authoring.draft.get', { scope: address.scope }, context))
            .toMatchObject({ ok: true, result: { status: 'available', drafts: [{ draftId: original.draftId }] } });
        const retireDuplicate = owners.registerMountedWorkflowDraftOwner({ kind: 'workflow',
            getContext: () => ({ scope: address.scope, draft: original, editable: true, whereMachineId: null, candidates: [] }),
            onChange: () => { throw new Error('Ambiguous owner must not receive an edit'); } });
        try {
            expect(await executor.execute('workflow.authoring.draft.get', { scope: address.scope }, context))
                .toEqual({ ok: true, result: { status: 'unavailable' } });
            expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
                expectedDraftRevision: initial.drafts[0]!.draftRevision,
                ops: [{ kind: 'rename', name: 'Must not reach either owner' }] }, context))
                .toEqual({ ok: true, result: { status: 'unavailable' } });
        } finally { retireDuplicate(); }
        await act(async () => {
            expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
                expectedDraftRevision: initial.drafts[0]!.draftRevision, ops: [
                    { kind: 'set_step_prompt', blockId: original.blocks[0]!.id, text: 'Must not be partially applied' },
                    { kind: 'remove_block', blockId: 'missing-block' },
                ] }, context)).toMatchObject({ ok: true, result: { status: 'refused', reason: 'unknown_block_id' } });
        });
        expect(readBodyProps()!.draft).toEqual(original);
        expect((await get()).drafts[0]!.draftRevision).toBe(initial.drafts[0]!.draftRevision);
        const edit = { ...address, expectedDraftRevision: initial.drafts[0]!.draftRevision,
            ops: [{ kind: 'set_step_prompt', blockId: original.blocks[0]!.id, text: 'Agent changed this prompt' },
                { kind: 'rename', name: 'Agent changed the title' }] };
        let applied: unknown;
        await act(async () => { applied = await executor.execute('workflow.authoring.draft.edit', edit, context); });
        expect(applied).toMatchObject({ ok: true, result: { status: 'applied', changedBlockIds: [original.blocks[0]!.id] } });
        expect(readBodyProps()!.draft.name).toBe('Agent changed the title');
        expect(readBodyProps()!.highlightedBlockIds).toEqual([original.blocks[0]!.id]);
        expect((await get()).drafts[0]!.dirty).toBe(true);
        expect(await executor.execute('workflow.authoring.draft.edit', edit, context))
            .toMatchObject({ ok: true, result: { status: 'refused', reason: 'stale_draft_revision' } });
        await act(async () => { await executor.execute('workflow.authoring.draft.undo', address, context); });
        expect(readBodyProps()!.draft).toEqual(original);
        await act(async () => { await executor.execute('workflow.authoring.draft.redo', address, context); });
        expect(readBodyProps()!.draft.name).toBe('Agent changed the title');
        const beforeHumanEdit = (await get()).drafts[0]!.draftRevision;
        await act(async () => { readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'Person changed the title' }); });
        expect(await executor.execute('workflow.authoring.draft.edit', { ...edit, expectedDraftRevision: beforeHumanEdit }, context))
            .toMatchObject({ ok: true, result: { status: 'refused', reason: 'stale_draft_revision' } });
        const saving = boundary.holdNextUpdate();
        let settled = false;
        let save: Promise<unknown>;
        // Agent edits do not grant child write authority; this Save is person-admitted.
        await act(async () => { save = executor.execute('workflow.authoring.draft.save', address,
            { ...context, surface: 'ui', authority: 'present_user' }).then(result => { settled = true; return result; });
            await saving.issued; });
        expect(settled ? await save! : undefined).toBeUndefined();
        const { decodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        const { ArtifactBodyEnvelopeV1Schema } = await import('@happier-dev/protocol/artifacts/artifactBinaryV1');
        const { WorkflowDefinitionArtifactBodyV1ReadSchema } = await import('@happier-dev/protocol/workflows/workflowDefinitionV1');
        const submitted = boundary.updates[0]!;
        expect(submitted).toMatchObject({ expectedHeaderVersion: 1, expectedBodyVersion: 1 });
        const envelope = ArtifactBodyEnvelopeV1Schema.parse(decodePlainArtifactStoredContent(submitted.body));
        if (typeof envelope.body !== 'string') throw new Error('Workflow Artifact is not a document');
        const stored = WorkflowDefinitionArtifactBodyV1ReadSchema.parse(JSON.parse(envelope.body));
        expect(stored.definition.blocks[0]).toMatchObject({ document: { text: 'Agent changed this prompt' } });
        await act(async () => { saving.resolve();
            expect(await save!).toMatchObject({ ok: true, result: { status: 'applied' } }); });
        expect(runStartSpy).not.toHaveBeenCalled();
        expect(await executor.execute('workflow.authoring.draft.get', { ...address, scope: { ...address.scope, accountId: 'other' } }, context))
            .toMatchObject({ ok: true, result: { status: 'refused', reason: 'workflow_binding_scope_mismatch' } });
        await act(async () => { readBodyProps()!.onChangeProjectTarget!({ machineId: 'machine-a', directory: '/repo' }); });
        expect(await executor.execute('workflow.authoring.draft.get', address, context))
            .toMatchObject({ ok: true, result: { status: 'available', drafts: [{ settings: {
                projectTarget: { machineId: 'machine-a', directory: '/repo' },
            } }] } });
    });

    it('mounted settings edit shares the new unsaved draft, atomic refusal, revision, history and Save', async () => {
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } });
        const boundary = await serveMountedDraftActionHome(definition, false);
        const seed = storeWorkflowDefinitionDraftSeed({ name: 'Review changes', definition });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const owners = await import('@/sync/ops/actions/workflowAuthoringAction');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: boundary.scope.serverId, runtimeAccountId: boundary.scope.accountId };
        await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId: seed }} />);
        const address = { scope: boundary.scope, draftId: readBodyProps()!.draft.draftId };
        const read = async () => {
            const result = await owners.invokeWorkflowAuthoringAction({ actionId: 'workflow.authoring.draft.get', input: address, context });
            if (result.status !== 'available') throw new Error('Mounted draft unavailable');
            return result.drafts[0]!;
        };
        const initial = await read();
        const settings = { description: 'Review the changes in this project',
            projectTarget: { machineId: 'machine-a', directory: '/repo' }, executionTarget: 'detached_run' as const,
            triggers: { rows: [{ identity: { clientId: 'daily-review' }, enabled: true,
                trigger: { kind: 'schedule' as const, enabled: true,
                    schedule: { kind: 'interval' as const, everyMs: 86400000, scheduleExpr: null, timezone: null } } }],
                project: null, inputs: {} },
        };
        await act(async () => {
            expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
                expectedDraftRevision: initial.draftRevision, settings,
                ops: [{ kind: 'remove_block', blockId: 'missing-block' }] }, context))
                .toMatchObject({ ok: true, result: { status: 'refused', reason: 'unknown_block_id' } });
        });
        expect(await read()).toEqual(initial);
        await act(async () => {
            expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
                expectedDraftRevision: initial.draftRevision, settings }, context))
                .toMatchObject({ ok: true, result: { status: 'applied' } });
        });
        const changed = await read();
        expect(changed.settings).toEqual(settings);
        expect(changed.dirty).toBe(true);
        expect(changed.draftRevision).toBeGreaterThan(initial.draftRevision);
        expect(boundary.creates).toHaveLength(0);
        expect(boundary.updates).toHaveLength(0);
        expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
            expectedDraftRevision: initial.draftRevision, settings: { description: 'Stale change' } }, context))
            .toMatchObject({ ok: true, result: { status: 'refused', reason: 'stale_draft_revision' } });
        expect(await read()).toEqual(changed);
        await act(async () => {
            expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
                expectedDraftRevision: changed.draftRevision,
                ops: [{ kind: 'rename', name: 'Must stay unchanged' }], settings: { description: 'Must stay unchanged',
                    triggers: { rows: [{ identity: { clientId: 'unavailable-event' }, trigger: null, enabled: true }], project: null, inputs: {} } } }, context))
                .toMatchObject({ ok: true, result: { status: 'refused', reason: 'workflow_trigger_restore_requires_setup' } });
        });
        expect(await read()).toEqual(changed);
        await act(async () => { await executor.execute('workflow.authoring.draft.undo', address, context); });
        expect((await read()).settings).toEqual(initial.settings);
        await act(async () => { await executor.execute('workflow.authoring.draft.redo', address, context); });
        expect((await read()).settings).toEqual(settings);
        const beforeNoop = await read();
        await act(async () => { expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
            expectedDraftRevision: beforeNoop.draftRevision, settings }, context))
            .toMatchObject({ ok: true, result: { status: 'unchanged', draftRevision: beforeNoop.draftRevision } }); });
        // Removing the unsaved trigger keeps Save at the real Artifact HTTP boundary.
        await act(async () => { await executor.execute('workflow.authoring.draft.edit', { ...address,
            expectedDraftRevision: beforeNoop.draftRevision, settings: { triggers: initial.settings.triggers } }, context); });
        await act(async () => { expect(await executor.execute('workflow.authoring.draft.save', address,
            { ...context, surface: 'ui', authority: 'present_user' }))
            .toEqual({ ok: true, result: { status: 'applied' } }); });
        expect(boundary.creates, JSON.stringify(boundary.requests.map(request => ({ path: request.path, method: request.method })))).toHaveLength(1);
        const { decodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        const { WorkflowDefinitionArtifactHeaderV1Schema } = await import('@happier-dev/protocol/workflows/workflowDefinitionV1');
        expect(WorkflowDefinitionArtifactHeaderV1Schema.parse(decodePlainArtifactStoredContent(boundary.creates[0]!.header)).metadata)
            .toMatchObject({ title: 'Review changes', description: settings.description });
        expect(readBodyProps()!.projectTarget).toEqual(settings.projectTarget);
        expect(getStorage().getState().authoringMemory.workflowProjectTargetsByDefinitionId[boundary.creates[0]!.id])
            .toEqual(settings.projectTarget);
        expect(readBodyProps()!.executionTarget).toBe(settings.executionTarget);
        expect(runStartSpy).not.toHaveBeenCalled();
        // Native controls enter the same revision/history owner, including staged description input.
        for (const change of [
            () => readBodyProps()!.onChangeDescription!('Person changed the description'),
            () => readBodyProps()!.onChangeProjectTarget!({ machineId: 'machine-b', directory: '/other' }),
            () => readBodyProps()!.onChangeExecutionTarget!('session'),
            () => {
                const section = readBodyProps()!.triggersSection;
                if (!React.isValidElement<React.ComponentProps<typeof import('../triggers/WorkflowTriggerSection').WorkflowTriggerSection>>(section)) {
                    throw new Error('Missing native trigger editor');
                }
                section.props.onChangeDraft({ adds: [{ clientId: 'daily-review', trigger: settings.triggers.rows[0]!.trigger }], updates: {}, removes: [] });
            },
        ]) {
            const before = await read();
            await act(async () => { change(); });
            expect((await read()).draftRevision).toBeGreaterThan(before.draftRevision);
            expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
                expectedDraftRevision: before.draftRevision, settings: { description: 'Stale native overwrite' } }, context))
                .toMatchObject({ ok: true, result: { status: 'refused', reason: 'stale_draft_revision' } });
            await act(async () => { await executor.execute('workflow.authoring.draft.undo', address, context); });
            expect((await read()).settings).toEqual(before.settings);
        }
    });

    it('decoded mounted trigger settings retain Save identity through Undo/Redo without another trigger write', async () => {
        const boundary = await serveMountedDraftActionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { WorkflowDraftGetResultV1Schema, WorkflowDraftTriggerSnapshotV1Schema } = await import('@happier-dev/protocol/actions/workflowAuthoringAction');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: boundary.scope.serverId, runtimeAccountId: boundary.scope.accountId };
        await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const address = { scope: boundary.scope, draftId: readBodyProps()!.draft.draftId };
        const read = async () => {
            const response = await executor.execute('workflow.authoring.draft.get', address, context);
            if (!response.ok) throw new Error(response.error);
            const result = WorkflowDraftGetResultV1Schema.parse(response.result);
            if (result.status !== 'available') throw new Error('Mounted draft unavailable');
            return result.drafts[0]!;
        };
        const initial = await read();
        const decoded = WorkflowDraftTriggerSnapshotV1Schema.parse({ rows: [{ identity: { clientId: 'daily-review' }, enabled: true,
            trigger: { kind: 'schedule', enabled: true,
                schedule: { kind: 'interval', everyMs: 86400000, scheduleExpr: null, timezone: null } } }],
            project: { machineId: 'machine-a', directory: '/repo' }, inputs: {} });
        await act(async () => {
            expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
                expectedDraftRevision: initial.draftRevision, settings: { triggers: decoded } }, context))
                .toMatchObject({ ok: true, result: { status: 'applied' } });
        });
        const saveFromNativeControl = async () => {
            if (boundary.automationCreates.length === 0) await saveWithTriggerConfirmation();
            else await act(async () => { readBodyProps()!.onSave!(); });
            await vi.waitFor(() => {
                expect(boundary.automationCreates).toHaveLength(1);
                expect(readBodyProps()!.savePending).toBe(false);
            });
        };
        await saveFromNativeControl();
        const acknowledged = await read();
        expect(acknowledged.settings.triggers.rows, JSON.stringify({
            saveStatus: readBodyProps()!.saveStatus,
            creates: boundary.automationCreates,
            requests: boundary.requests.map(request => ({ path: request.path, method: request.method })),
        })).toHaveLength(1);
        const triggerId = acknowledged.settings.triggers.rows[0]!.identity.triggerId;
        expect(triggerId).toBeTruthy();
        expect(acknowledged.dirty).toBe(false);
        await act(async () => {
            expect(await executor.execute('workflow.authoring.draft.undo', address, context))
                .toMatchObject({ ok: true, result: { status: 'applied' } });
        });
        expect((await read()).settings.triggers.rows).toEqual([]);
        await act(async () => {
            expect(await executor.execute('workflow.authoring.draft.redo', address, context))
                .toMatchObject({ ok: true, result: { status: 'applied' } });
        });
        const redone = await read();
        expect(redone.settings.triggers.rows).toMatchObject([{ identity: { clientId: 'daily-review', triggerId } }]);
        expect(redone.dirty).toBe(false);
        await saveFromNativeControl();
        expect((await read()).settings.triggers.rows).toHaveLength(1);
        expect(boundary.requests.filter(request => request.path.startsWith('/v3/automations') && request.method !== 'GET'))
            .toHaveLength(1);
    });

    it.each(['trigger', 'definition'] as const)('mounted Agent Save preserves %s child approval while native Save uses its UI admission', async (child) => {
        const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol');
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'workflow.definition.update': { approvalRequiredSurfaces: ['agent'] },
        } });
        // Serve the policy from its Account HTTP owner. A store-only override
        // races bootstrap, which correctly replaces it with the Home's settings.
        const boundary = await serveMountedDraftActionHome(undefined, true, 'srv_workflow-approval-home', { actionsSettingsV1 });
        await (await import('@/sync/sync')).sync.awaitBootstrapForegroundAcquisition();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } = await import('@happier-dev/protocol/account/settings/sessionAgentSpawnPolicyV1');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: boundary.scope.serverId, serverIdentityId: 'srv_workflow-approval-home',
            runtimeAccountId: boundary.scope.accountId, expectedAccountId: boundary.scope.accountId,
            callerPermissionMode: 'yolo', sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
            actionCaller: { kind: 'session', sessionId: 'authoring-session', starterDepth: 0, turnDepth: 0 },
            defaultSessionId: 'authoring-session',
            // Host-admitted start facts are required before durable child approval.
            agentStartContext: { caller: { kind: 'session', sessionId: 'authoring-session', starterDepth: 0, turnDepth: 0 },
                baseline: { machineId: 'machine-a', directory: '/repo' }, roles: {},
                callerPermissionCeiling: 'yolo', ledSubtreeSessionIds: [], workDepthLimit: 4 },
            actionRequestId: 'mounted-parent-save',
            bypassApprovals: true,
            presentUserConfirmation: { actionId: 'workflow.authoring.draft.save' as const } } satisfies ActionExecutorContext;
        await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const snapshot = readBodyProps()!.mountedDraftActions!.getSnapshot()!;
        const address = { scope: boundary.scope, draftId: snapshot.draftId };
        const triggers = { rows: [{ identity: { clientId: 'daily-review' }, enabled: true,
            trigger: { kind: 'schedule' as const, enabled: true,
                schedule: { kind: 'interval' as const, everyMs: 86400000, scheduleExpr: null, timezone: null } } }],
            project: { machineId: 'machine-a', directory: '/repo' }, inputs: {} };
        await act(async () => { expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
            expectedDraftRevision: snapshot.draftRevision,
            settings: child === 'trigger' ? { triggers } : { description: 'Review this project every day' } }, context))
            .toMatchObject({ ok: true, result: { status: 'applied' } }); });
        const controller = new AbortController();
        let settled = false;
        const saving = executor.execute('workflow.authoring.draft.save', address, { ...context, signal: controller.signal })
            .then(result => { settled = true; return result; });
        try {
            // This Action uses canonical deferred approval custody, not a blocking waiter.
            await act(async () => { await saving; });
            expect(boundary.automationCreates).toHaveLength(0);
            const { decodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
            const { ArtifactBodyEnvelopeV1Schema } = await import('@happier-dev/protocol/artifacts/artifactBinaryV1');
            const { ApprovalRequestSchema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
            expect(boundary.creates, JSON.stringify({ settled, result: settled ? await saving : undefined,
                saveStatus: readBodyProps()!.saveStatus,
                requests: boundary.requests.map(request => ({ path: request.path, method: request.method })),
            })).toHaveLength(1);
            const envelope = ArtifactBodyEnvelopeV1Schema.parse(decodePlainArtifactStoredContent(boundary.creates[0]!.body));
            if (typeof envelope.body !== 'string') throw new Error('Approval Artifact did not contain its request');
            const approval = ApprovalRequestSchema.parse(JSON.parse(envelope.body));
            expect(approval).toMatchObject({
                actionId: child === 'trigger' ? 'workflow.trigger.add' : 'workflow.definition.update', status: 'open',
                executionOriginV1: { surface: 'agent', authority: 'account_automation' } });
            if (approval.v !== 2) throw new Error('Child approval did not retain its execution origin');
            expect(approval.executionOriginV1.requestId).not.toBe(context.actionRequestId);
            expect(settled).toBe(true);
            expect(boundary.updates).toHaveLength(0);
        } finally {
            await act(async () => { controller.abort(); await saving; });
        }
        const result = await saving;
        if (result.ok) expect(result.result).toMatchObject({ status: 'refused' });
        else expect(result.errorCode).toBeTruthy();
        expect(readBodyProps()!.mountedDraftActions!.getSnapshot()!.settings.triggers.rows).toHaveLength(child === 'trigger' ? 1 : 0);
        // The person-owned Save executes the retained delta through native UI policy.
        if (child === 'trigger') await saveWithTriggerConfirmation();
        else await act(async () => { readBodyProps()!.onSave!(); });
        await vi.waitFor(() => {
            expect(boundary.automationCreates).toHaveLength(child === 'trigger' ? 1 : 0);
            expect(boundary.updates).toHaveLength(child === 'definition' ? 1 : 0);
            expect(readBodyProps()!.savePending).toBe(false);
        });
        expect(boundary.automationCreates).toHaveLength(child === 'trigger' ? 1 : 0);
        expect(boundary.updates).toHaveLength(child === 'definition' ? 1 : 0);
        expect(boundary.creates).toHaveLength(1);
        expect(readBodyProps()!.savePending).toBe(false);
    });

    it.each(['applied', 'refused'] as const)('mounted Agent Save returns a Session caller’s definition child after a typed outside-child refusal (%s)', async (outcome) => {
        const boundary = await serveMountedDraftActionHome(undefined, true, 'srv_workflow-approval-home');
        await (await import('@/sync/sync')).sync.awaitBootstrapForegroundAcquisition();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } = await import('@happier-dev/protocol/account/settings/sessionAgentSpawnPolicyV1');
        const { UiActionChildExecuteRequestV1Schema, buildUiActionDispatchRequestV1 } = await import('@happier-dev/protocol/actions/clientDispatchV1');
        const { createUiClientActionReverseHandler } = await import('@/sync/ops/actions/clientActionReverseDispatch');
        const { executeAdmittedClientActionChildAtMachine } = await import('@/sync/ops/actions/admittedClientActionChild');
        // The daemon's reverse dispatch: it admitted this Session caller and awaits this Save.
        const executor = createDefaultActionExecutor({ admittedClientActionId: 'workflow.authoring.draft.save',
            admittedClientActionParent: { machineId: 'machine-a', requestId: 'mounted-parent-save' } });
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: boundary.scope.serverId, serverIdentityId: 'srv_workflow-approval-home',
            runtimeAccountId: boundary.scope.accountId, expectedAccountId: boundary.scope.accountId,
            callerPermissionMode: 'yolo', sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
            actionCaller: { kind: 'session', sessionId: 'authoring-session', starterDepth: 0, turnDepth: 0 },
            defaultSessionId: 'authoring-session', actionRequestId: 'mounted-parent-save' } satisfies ActionExecutorContext;
        const receive = createUiClientActionReverseHandler({ ...boundary.scope, machineId: 'machine-a', isCurrent: () => true });
        await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const snapshot = readBodyProps()!.mountedDraftActions!.getSnapshot()!;
        const address = { scope: boundary.scope, draftId: snapshot.draftId };
        await act(async () => { expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
            expectedDraftRevision: snapshot.draftRevision, settings: { description: 'Review this project every day' } }, context))
            .toMatchObject({ ok: true, result: { status: 'applied' } }); });
        admittedParentChildren.calls.length = 0;
        // Replay JQ-R14's exact probe order: outside child first, then the valid
        // mounted Save. A throwing parse previously prevented that Save entirely.
        expect(await executeAdmittedClientActionChildAtMachine({
            parent: { machineId: 'machine-a', requestId: context.actionRequestId },
            serverId: boundary.scope.serverId, accountId: boundary.scope.accountId,
            sessionId: context.defaultSessionId, actionId: 'session.list', input: {},
        })).toEqual({ ok: false, errorCode: 'invalid_action_input', error: 'invalid_action_input' });
        expect(admittedParentChildren.calls).toHaveLength(0);
        admittedParentChildren.outcome = outcome;
        try {
            await act(async () => { expect(await receive(buildUiActionDispatchRequestV1({
                actionId: 'workflow.authoring.draft.save', input: address, context,
            }), { signal: new AbortController().signal })).toMatchObject({
                v: 1, execution: { ok: true, result: outcome === 'applied'
                    ? { status: 'applied' } : { status: 'refused', reason: 'run_access_denied' } },
            }); });
        } finally {
            admittedParentChildren.outcome = 'refused';
        }
        expect(admittedParentChildren.calls).toHaveLength(1);
        expect(admittedParentChildren.calls[0]!.method).toBe(`machine-a:${RPC_METHODS.UI_ACTION_CHILD_EXECUTE}`);
        expect(UiActionChildExecuteRequestV1Schema.parse(admittedParentChildren.calls[0]!.params)).toMatchObject({
            v: 1, parentRequestId: 'mounted-parent-save', sessionId: 'authoring-session', actionId: 'workflow.definition.update' });
        // The App neither writes the definition nor authors the child's approval.
        expect(boundary.updates).toHaveLength(0);
        expect(boundary.creates).toHaveLength(0);
        expect(readBodyProps()!.mountedDraftActions!.getSnapshot()).toMatchObject({ dirty: outcome !== 'applied' });
    });

    it('mounted settings preserve a view recipient’s personal target and trigger authority without definition writes', async () => {
        const boundary = await serveMountedDraftActionHome();
        boundary.artifact.access = 'view';
        boundary.artifact.ownerAccountId = 'other-account';
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: boundary.scope.serverId, runtimeAccountId: boundary.scope.accountId };
        await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        expect(readBodyProps()!.onChangeDescription).toBeUndefined();
        const snapshot = () => readBodyProps()!.mountedDraftActions!.getSnapshot()!;
        const initial = snapshot();
        const address = { scope: boundary.scope, draftId: initial.draftId };
        const settings = { projectTarget: { machineId: 'machine-a', directory: '/repo' }, executionTarget: 'detached_run' as const,
            triggers: { rows: [{ identity: { clientId: 'daily-review' }, enabled: true,
                trigger: { kind: 'schedule' as const, enabled: true,
                    schedule: { kind: 'interval' as const, everyMs: 86400000, scheduleExpr: null, timezone: null } } }],
                project: null, inputs: {} } };
        await act(async () => { expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
            expectedDraftRevision: initial.draftRevision, settings }, context))
            .toMatchObject({ ok: true, result: { status: 'applied' } }); });
        const changed = snapshot();
        expect(changed.settings).toMatchObject(settings);
        for (const mutation of [{ settings: { description: 'Cannot edit the definition metadata' } },
            { ops: [{ kind: 'rename', name: 'Cannot rename' }], settings: { executionTarget: 'session' } }]) {
            expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
                expectedDraftRevision: changed.draftRevision, ...mutation }, context))
                .toMatchObject({ ok: true, result: { status: 'refused', reason: 'workflow_draft_read_only' } });
            expect(snapshot()).toEqual(changed);
        }
        await act(async () => { readBodyProps()!.onChangeProjectTarget!({ machineId: 'machine-b', directory: '/other' }); });
        expect(snapshot().draftRevision).toBeGreaterThan(changed.draftRevision);
        expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
            expectedDraftRevision: changed.draftRevision, settings: { executionTarget: 'session' } }, context))
            .toMatchObject({ ok: true, result: { status: 'refused', reason: 'stale_draft_revision' } });
        expect(boundary.updates).toHaveLength(0);
        expect(boundary.creates).toHaveLength(0);
    });

    it.each(['action', 'native'] as const)('retains an order-only schema edit through %s, undo/redo and Save', async (entry) => {
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        }, blocks: [{ kind: 'step', id: 'gather',
            document: { text: 'Gather changes', references: [], attachments: [] }, input: [],
            result: { kind: 'json', schema: { type: 'object', properties: {
                issues: { type: 'string' }, commits: { type: 'string' },
            } } } }] });
        const boundary = await serveMountedDraftActionHome(definition);
        await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const original = readBodyProps()!.draft;
        const block = original.blocks[0]!;
        if (block.kind !== 'step') throw new Error('Expected the schema-bearing step');
        const reordered = { ...block, result: { kind: 'json' as const, schema: { type: 'object' as const,
            properties: { commits: { type: 'string' as const }, issues: { type: 'string' as const } } } } };
        const fieldOrder = () => {
            const current = readBodyProps()!.draft.blocks[0]!;
            if (current.kind !== 'step' || current.result?.kind !== 'json') throw new Error('Missing result schema');
            return Object.keys(current.result.schema.properties ?? {});
        };
        await act(async () => { await readBodyProps()!.onSave?.(); });
        expect(boundary.updates).toHaveLength(0);
        if (entry === 'action') {
            const owner = readBodyProps()!.mountedDraftActions!;
            const before = owner.getSnapshot()!;
            let result: unknown;
            await act(async () => { result = await owner.execute('workflow.authoring.draft.edit', {
                scope: before.scope, draftId: before.draftId, expectedDraftRevision: before.draftRevision,
                ops: [{ kind: 'replace_block', blockId: block.id, block: reordered }],
            }); });
            expect(result).toMatchObject({ status: 'applied' });
        } else {
            // Stage and commit as a native input does; pending history must retain order too.
            await act(async () => { readBodyProps()!.onChange({ ...original, blocks: [reordered] }, 'Reorder fields', false); });
            await act(async () => { readBodyProps()!.onCommitChange?.(); });
        }
        expect(fieldOrder()).toEqual(['commits', 'issues']);
        expect(readBodyProps()!.saveStatus?.kind).toBe('unsaved');
        expect(readBodyProps()!.mountedDraftActions!.getSnapshot()!.dirty).toBe(true);
        expect(readBodyProps()!.history?.undoLabel).not.toBeNull();
        const sameOrderOwner = readBodyProps()!.mountedDraftActions!;
        const beforeNoop = sameOrderOwner.getSnapshot()!;
        let noop: unknown;
        await act(async () => { noop = await sameOrderOwner.execute('workflow.authoring.draft.edit', {
            scope: beforeNoop.scope, draftId: beforeNoop.draftId, expectedDraftRevision: beforeNoop.draftRevision,
            // Reordering schema keywords is semantic-only; declared properties retain their order.
            ops: [{ kind: 'replace_block', blockId: block.id, block: { ...reordered,
                result: { schema: { properties: reordered.result.schema.properties, type: 'object' }, kind: 'json' } } }],
        }); });
        expect(noop).toMatchObject({ status: 'unchanged', draftRevision: beforeNoop.draftRevision });
        await act(async () => { readBodyProps()!.history!.undo(); });
        expect(fieldOrder()).toEqual(['issues', 'commits']);
        expect(readBodyProps()!.saveStatus?.kind).toBe('saved');
        await act(async () => { readBodyProps()!.history!.redo(); });
        expect(fieldOrder()).toEqual(['commits', 'issues']);
        expect(readBodyProps()!.saveStatus?.kind).toBe('unsaved');
        await act(async () => { await readBodyProps()!.onSave?.(); });
        expect(boundary.updates).toHaveLength(1);
        const { decodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        const { ArtifactBodyEnvelopeV1Schema } = await import('@happier-dev/protocol/artifacts/artifactBinaryV1');
        const { WorkflowDefinitionArtifactBodyV1ReadSchema } = await import('@happier-dev/protocol/workflows/workflowDefinitionV1');
        const envelope = ArtifactBodyEnvelopeV1Schema.parse(decodePlainArtifactStoredContent(boundary.updates[0]!.body));
        if (typeof envelope.body !== 'string') throw new Error('Workflow Artifact is not a document');
        const savedBlock = WorkflowDefinitionArtifactBodyV1ReadSchema.parse(JSON.parse(envelope.body)).definition.blocks[0]!;
        if (savedBlock.kind !== 'step' || savedBlock.result?.kind !== 'json') throw new Error('Missing saved result schema');
        expect(Object.keys(savedBlock.result.schema.properties ?? {})).toEqual(['commits', 'issues']);
        expect(readBodyProps()!.saveStatus?.kind).toBe('saved');
    });

    it('mounted draft discard respects the existing human confirmation and preserves undo', async () => {
        const boundary = await serveMountedDraftActionHome();
        const { invokeWorkflowAuthoringAction } = await import('@/sync/ops/actions/workflowAuthoringAction');
        await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const original = readBodyProps()!.draft;
        const address = { scope: boundary.scope, draftId: original.draftId };
        const context = { serverId: boundary.scope.serverId, runtimeAccountId: boundary.scope.accountId };
        await act(async () => { readBodyProps()!.onChange({ ...original, name: 'Keep my edits' }); });
        let discard: ReturnType<typeof invokeWorkflowAuthoringAction>;
        await act(async () => { discard = invokeWorkflowAuthoringAction({ actionId: 'workflow.authoring.draft.discard', input: address, context }); });
        await pressConfirmation(false);
        expect(await discard!).toMatchObject({ status: 'refused', reason: 'cancelled' });
        expect(readBodyProps()!.draft.name).toBe('Keep my edits');
        await act(async () => { discard = invokeWorkflowAuthoringAction({ actionId: 'workflow.authoring.draft.discard', input: address, context }); });
        await pressConfirmation(true);
        await act(async () => { expect(await discard!).toMatchObject({ status: 'applied' }); });
        expect(readBodyProps()!.draft).toEqual(original);
        await act(async () => { readBodyProps()!.history!.undo(); });
        expect(readBodyProps()!.draft.name).toBe('Keep my edits');
    });
    it.each([
        ['unsaved', 'route'], ['unsaved', 'import'], ['saved', 'route'], ['saved', 'import'],
    ] as const)('mounted draft discard cannot confirm against a replacement %s source (%s)', async (kind, replacement) => {
        const boundary = await serveMountedDraftActionHome();
        const { invokeWorkflowAuthoringAction } = await import('@/sync/ops/actions/workflowAuthoringAction');
        const screen = await renderRunEditor(<WorkflowEditorHostScreen source={kind === 'saved'
            ? { kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID } : { kind: 'new' }} />);
        await act(async () => { readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'Source A edits' }); });
        const address = { scope: boundary.scope, draftId: readBodyProps()!.draft.draftId };
        const picked = replacement === 'import' ? createDeferred<string | null>() : null;
        if (picked) {
            workflowDocumentPicker.pick.mockReturnValueOnce(picked.promise);
            await act(async () => { readBodyProps()!.onImportJson?.(); });
        }
        let discard: ReturnType<typeof invokeWorkflowAuthoringAction>;
        await act(async () => { discard = invokeWorkflowAuthoringAction({ actionId: 'workflow.authoring.draft.discard', input: address,
            context: { serverId: boundary.scope.serverId, runtimeAccountId: boundary.scope.accountId } }); });
        if (kind === 'saved') expect(readConfirmation()).toBeDefined();
        else expect(visibleModals().filter(modal => modal.type === 'alert')).toHaveLength(1);
        const confirmOldDraft = kind === 'saved' ? () => pressConfirmation(true) : () => pressAlertButton('destructive');
        if (picked) {
            await act(async () => { picked.resolve(JSON.stringify({ kind: 'happier.workflow', version: 1,
                definition: createWorkflowDefinitionFixture({ defaults: {
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                } }) })); });
            expect(readBodyProps()!.draft.draftId).not.toBe(address.draftId);
        } else {
            await screen.update(<WorkflowEditorHostScreen source={{ kind: 'new', builtinId: 'builtin:plan-with-a-panel' }} />);
            await act(async () => { readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'Source B edits must remain' }); });
        }
        const replacementDraft = readBodyProps()!.draft;
        const replacementAddress = { scope: boundary.scope, draftId: replacementDraft.draftId };
        const context = { serverId: boundary.scope.serverId, runtimeAccountId: boundary.scope.accountId };
        const replacementSnapshot = await invokeWorkflowAuthoringAction({ actionId: 'workflow.authoring.draft.get',
            input: replacementAddress, context });
        await act(async () => { await confirmOldDraft();
            expect(await discard!).toMatchObject({ status: 'refused', ...(kind === 'saved' ? { reason: 'draft_retired' } : {}) }); });
        expect(readBodyProps()!.draft).toEqual(replacementDraft);
        expect(await invokeWorkflowAuthoringAction({ actionId: 'workflow.authoring.draft.get',
            input: replacementAddress, context })).toEqual(replacementSnapshot);
        expect(routerSpy.replace).not.toHaveBeenCalled();
    });
    it('mounted draft Actions read an incomplete group as a draft with validation issues', async () => {
        const boundary = await serveMountedDraftActionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const owners = await import('@/sync/ops/actions/workflowAuthoringAction');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: boundary.scope.serverId, runtimeAccountId: boundary.scope.accountId };
        await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const address = { scope: boundary.scope, draftId: readBodyProps()!.draft.draftId };
        const initial = await owners.invokeWorkflowAuthoringAction({ actionId: 'workflow.authoring.draft.get', input: address, context });
        if (initial.status !== 'available') throw new Error('Mounted draft unavailable');
        await act(async () => { expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
            expectedDraftRevision: initial.drafts[0]!.draftRevision, settings: { description: 'Incomplete but undoable draft' }, ops: [
                { kind: 'insert_block', list: { kind: 'root' }, block: { kind: 'loop', id: 'group',
                    repetition: { kind: 'count', count: { kind: 'literal', value: 2 } }, body: [{ kind: 'step', id: 'group-child',
                        document: { text: 'Remove this child', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
                { kind: 'remove_block', blockId: 'group-child' },
            ] }, context)).toMatchObject({ ok: true, result: { status: 'applied' } }); });
        expect(await executor.execute('workflow.authoring.draft.get', address, context)).toMatchObject({ ok: true,
            result: { status: 'available', drafts: [{ dirty: true, definition: { blocks: expect.arrayContaining([
                expect.objectContaining({ kind: 'loop', id: 'group', body: [] }),
            ]) }, settings: { description: 'Incomplete but undoable draft' },
            validationIssues: expect.arrayContaining([expect.objectContaining({ severity: 'error' })]) }] } });
        await act(async () => { expect(await executor.execute('workflow.authoring.draft.save', address, context))
            .toMatchObject({ ok: true, result: { status: 'refused', reason: 'invalid_workflow' } }); });
        expect(boundary.updates).toHaveLength(0);
    });
    it.each([false, true])('delivers Delete from the real editor overflow after it closes (phone=%s, R17a)', async phone => {
        const deletion = createDeferred<{ definitionId: string; deleted: true }>();
        definitionActions.delete.mockImplementationOnce(() => deletion.promise);
        const screen = await renderRunEditor(<DestinationInstanceHost tabId="delete-editor"
            ref={{ kind: 'workflows', params: { workspacePathname: `/workflows/${SAVED_TRIGGER_WORKFLOW_ID}` } }}
            pathname={`/workflows/${SAVED_TRIGGER_WORKFLOW_ID}`} focused visible phone={phone}
            navigation={{ push: routerSpy.push, replace: routerSpy.replace, back: routerSpy.back, canGoBack: routerSpy.canGoBack }}>
            <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />
        </DestinationInstanceHost>);
        await screen.pressByTestIdAsync(phone ? 'page-header-actions.trigger' : 'workflow-editor-menu.trigger');
        await settlePopoverLayout(screen);
        await vi.waitFor(async () => {
            await settlePopoverLayout(screen);
            const portal = screen.root.findAll(node => typeof node.type === 'string'
                && typeof node.props.nativeID === 'string' && node.props.nativeID.startsWith('popover-'))[0];
            expect(portal).toBeDefined();
            expect(flattenTestStyle(portal!.props.style).opacity).toBe(1);
        });
        await screen.pressByTestIdAsync('workflow-editor-menu-delete');
        await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 150)); });
        expect(visibleModals().filter(modal => modal.type === 'confirm')).toHaveLength(1);
        expect(screen.findHostByTestId('workflow-editor-menu-delete')).toBeNull();
        expect(screen.findHostByTestId('web-modal-confirm')).not.toBeNull();
        expect(definitionActions.delete).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('web-modal-confirm');
        await vi.waitFor(() => expect(definitionActions.delete).toHaveBeenCalledOnce());
        expect(screen.findHostByTestId('workflow-editor-deleting')).not.toBeNull();
        expect(routerSpy.replace).not.toHaveBeenCalled();
        await act(async () => { deletion.resolve({ definitionId: SAVED_TRIGGER_WORKFLOW_ID, deleted: true }); await deletion.promise; });
        expect(routerSpy.replace).toHaveBeenCalledWith('/workflows');
        await screen.unmount();
    });
    it.each([false, true])('keeps the dirty draft when Delete is cancelled or fails (confirmed=%s)', async confirmed => {
        definitionActions.delete.mockRejectedValueOnce(new Error('Deletion failed'));
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        await act(async () => readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'Keep this rename' }));
        await act(async () => { void readBodyProps()!.menuActions?.find(action => action.id === 'delete')?.onSelect(); });
        await pressConfirmation(confirmed);
        expect(getActiveUnsavedChangesGuard()?.ignoreRef?.current).not.toBe(true);
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
        expect(readBodyProps()!.draft.name).toBe('Keep this rename');
        expect(routerSpy.replace).not.toHaveBeenCalled();
        if (confirmed) {
            expect(readAlert()).toMatchObject({ title: 'workflows.page.deleteFailedTitle', message: 'workflows.readState.storageBody' });
        }
        else expect(definitionActions.delete).not.toHaveBeenCalled();
        await screen.unmount();
    });
    it('retires dirty edits after confirmed Delete before the router asks its departure guard', async () => {
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        await act(async () => readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'Unsaved rename' }));
        const destinations: string[] = [];
        routerSpy.replace.mockImplementation(href => runGuardedNavigation(() => { destinations.push(String(href)); }));
        await act(async () => { void readBodyProps()!.menuActions?.find(action => action.id === 'delete')?.onSelect(); });
        expect(visibleModals().filter(modal => modal.type === 'confirm')).toHaveLength(1);
        await pressConfirmation(true);
        expect(definitionActions.delete).toHaveBeenCalledOnce();
        expect(readAlert()).toBeUndefined();
        expect(destinations).toEqual(['/workflows']);
        await screen.unmount();
    });
    it('does not persist an empty required Action value and saves once the same draft has real text', async () => {
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        }, blocks: [{ kind: 'action', id: 'notify', actionId: 'notifications.notify_me',
            input: { message: { kind: 'literal', value: '' } } }] });
        definitionActions.create.mockImplementation(async request => ({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
            definition: WorkflowDefinitionV1Schema.parse(request.definition), metadata: request.metadata, access: 'owner',
            revision: { headerVersion: 1, bodyVersion: 1 } }));
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        await act(async () => readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'Notify on completion', defaults: definition.defaults, blocks: definition.blocks }));
        await act(async () => readBodyProps()!.onSave?.());
        expect(definitionActions.create).not.toHaveBeenCalled();
        expect(readBodyProps()!.saveStatus?.kind).not.toBe('saved');
        await act(async () => readBodyProps()!.onChange({ ...readBodyProps()!.draft, blocks: [{ kind: 'action', id: 'notify', actionId: 'notifications.notify_me',
            input: { message: { kind: 'literal', value: 'Done' } } }] }));
        await act(async () => readBodyProps()!.onSave?.());
        expect(definitionActions.create).toHaveBeenCalledOnce();
        expect(readBodyProps()!.saveStatus?.kind).toBe('saved');
        await screen.unmount();
    });
    it.each(['blank', 'seed', 'saved'] as const)('clears discarded edits before a retained workspace tab is revisited (%s, DESIGN-11 N57)', async kind => {
        const source: React.ComponentProps<typeof WorkflowEditorHostScreen>['source'] = kind === 'saved'
            ? { kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }
            : { kind: 'new', ...(kind === 'seed' ? { definitionDraftSeedId: storeWorkflowDefinitionDraftSeed({
                name: 'Copied workflow', description: 'Original description', definition: createWorkflowDefinitionFixture(),
            }) } : {}) };
        const screen = await renderRunEditor(<WorkflowEditorHostScreen source={source} />);
        const baseline = readBodyProps()!.draft;
        const baselineDescription = readBodyProps()!.description;
        const readTriggers = () => {
            const section = readBodyProps()!.triggersSection;
            if (!React.isValidElement<React.ComponentProps<typeof WorkflowTriggerSection>>(section)) throw new Error('Expected trigger editor');
            return section.props;
        };
        const trigger = { kind: 'schedule', enabled: true,
            schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } } as const;
        await act(async () => readTriggers().onChangeDraft(editWorkflowTriggerDraft(readTriggers().draft,
            { kind: 'add', clientId: 'discarded-schedule', trigger })));
        await act(async () => readBodyProps()!.onChange({ ...baseline, name: 'Discard this retained draft' }));
        await act(async () => readBodyProps()!.onChangeDescription?.('Discard this description'));
        let left = false;
        await act(async () => { void runGuardedNavigation(() => { left = true; }); });
        expect(left).toBe(false);
        await pressAlertButton('destructive');
        expect(left).toBe(true);
        expect(readBodyProps()!.draft).toEqual(baseline);
        expect(readBodyProps()!.description).toBe(baselineDescription);
        expect(readBodyProps()!.saveStatus?.kind).toBe(kind === 'saved' ? 'saved' : 'notSaved');
        expect(readBodyProps()!.history?.undoLabel).toBeNull();
        expect(readBodyProps()!.history?.redoLabel).toBeNull();
        expect(readTriggers().draft.adds).toHaveLength(0);
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(false);
        expect(definitionActions.create).not.toHaveBeenCalled();
        expect(definitionActions.update).not.toHaveBeenCalled();
        expect(editorAutomations.creates).toHaveLength(0);
        await screen.unmount();
    });

    it.each([
        { kind: 'new' as const, definitionDraftSeedId: 'lost-on-reload' },
        { kind: 'new' as const, newSessionDraftSeedId: 'lost-on-reload' },
        { kind: 'new' as const, triggerWorkflowSeedId: 'lost-on-reload' },
        { kind: 'new' as const, reviewedRunSeedId: 'lost-on-reload' },
        { kind: 'saved' as const, definitionId: SAVED_TRIGGER_WORKFLOW_ID, agentRevisionSeedId: 'lost-on-reload' },
    ])('explains a $kind seed lost on reload without claiming an Account change (DESIGN-11 N56)', async source => {
        const screen = await renderRunEditor(<WorkflowEditorHostScreen source={source} />);
        expect(screen.findHostByTestId('workflow-editor-account-changed')).toBeNull();
        expect(screen.findHostByTestId('workflow-editor-draft-unavailable')).not.toBeNull();
        expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(0);
        await screen.unmount();
    });

    it.each(['Previous', 'browser Back', 'menu Discard'] as const)('keeps a dirty new draft on %s and pops its workflow origin after discard', async exit => {
        // Browser history and its event delivery are the system boundary. The
        // mounted Host, shell control, workspace router and draft decision are real.
        const entries: Array<{ state: unknown; href: string }> = [{ state: { id: 'initial' }, href: '/workflows/builtin:plan-with-a-panel' }];
        let position = 0;
        const browserEvents = new EventTarget();
        const location = { pathname: entries[0]!.href, search: '', hash: '' };
        const updateLocation = () => {
            const url = new URL(entries[position]!.href, 'https://happier.invalid');
            Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash });
        };
        const browser = {
            get state() { return entries[position]!.state; },
            pushState(state: unknown, _title: string, href?: string | URL | null) {
                const nextHref = href == null ? entries[position]!.href : String(href);
                entries.splice(position + 1); entries.push({ state, href: nextHref }); position++; updateLocation();
            },
            replaceState(state: unknown, _title: string, href?: string | URL | null) {
                entries[position] = { state, href: href == null ? entries[position]!.href : String(href) }; updateLocation();
            },
            go(delta: number) {
                if (!entries[position + delta]) return;
                position += delta; updateLocation();
                browserEvents.dispatchEvent(Object.assign(new Event('popstate'), { state: browser.state }));
            },
        };
        const previousWindow = globalThis.window;
        const restoreBrowserGlobals = withPopoverWebGlobals({ window: {
            ...previousWindow, location, history: browser, sessionStorage: { getItem: () => 'main' },
            addEventListener: browserEvents.addEventListener.bind(browserEvents),
            removeEventListener: browserEvents.removeEventListener.bind(browserEvents),
            dispatchEvent: browserEvents.dispatchEvent.bind(browserEvents),
        } });
        getStorage().setState({ isDataReady: true });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        let navigation: WorkspaceNavigationContextValue | undefined;
        try {
            const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{owner => {
                navigation = owner;
                const state = owner.state;
                const tab = state.tabs[state.groups[state.focusedGroupId].activeTabId]!;
                return <><AppShellTitleStrip columnVisible columnToggleAvailable onToggleColumn={() => {}} navigation={owner} />
                    <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={location.pathname} focused visible navigation={owner.navigationForTab(tab.id)}>
                        {location.pathname === '/workflows/new'
                            ? <WorkflowEditorHostScreen source={{ kind: 'new', builtinId: 'builtin:plan-with-a-panel' }} /> : null}
                    </DestinationInstanceHost></>;
            }}</WorkspaceProvider>);
            await act(async () => { navigation!.openHref('/workflows/new'); });
            const draft = readBodyProps()!.draft;
            await act(async () => readBodyProps()!.onChange({ ...draft, name: 'Do not lose this' }));
            const leave = async () => {
                if (exit === 'Previous') await screen.pressByTestIdAsync('app-shell-back');
                else if (exit === 'menu Discard') await act(async () => readBodyProps()!.menuActions?.find(action => action.id === 'discard')?.onSelect());
                else await act(async () => browser.go(-1));
            };
            await leave();
            expect(visibleModals().filter(modal => modal.type === 'alert')).toHaveLength(1);
            expect(location.pathname).toBe('/workflows/new');
            await pressAlertButton('cancel');
            expect(readBodyProps()!.draft.name).toBe('Do not lose this');
            await leave();
            await pressAlertButton('destructive');
            expect(decodeURIComponent(location.pathname)).toBe('/workflows/builtin:plan-with-a-panel');
            expect(entries.filter(entry => decodeURIComponent(entry.href) === '/workflows/builtin:plan-with-a-panel')).toHaveLength(1);
            expect(position).toBe(0);
            expect(definitionActions.create).not.toHaveBeenCalled();
            await screen.unmount();
        } finally { restoreBrowserGlobals(); }
    });
    it('promotes a native create URL to the saved URL without replacing its mounted draft or undo history', async () => {
        // Credentials and saved Homes use different device SDK storage on iOS.
        // Retire the web fixture before restoring the real native connection.
        await editorAccount?.dispose();
        nativeRouteBoundary.platform = 'ios';
        editorAccount = await restoreServerAccountForTest({ serverUrl: 'https://server-a', accountId: 'account-a',
            credentials: editorCredentials, request: editorHomeRequest });
        switchEditorAccountScope({ serverId: editorAccount.home.id, accountId: 'account-a' });
        // Published Expo CJS bypasses Vitest's native SDK aliases. Execute its
        // real URL projector with only the native SDK boundary supplied, as the
        // canonical destinationRoute suite does for Expo's declaration parser.
        const require = createRequire(import.meta.url);
        const loadSdk = (specifier: string, boundary: Readonly<Record<string, unknown>>) => {
            const path = require.resolve(specifier);
            const sdkRequire = createRequire(path);
            const exports: Record<string, unknown> = {};
            const compiled = transformSync(readFileSync(path, 'utf8'), { loader: 'jsx', jsxFactory: 'react_1.default.createElement' });
            new Function('require', 'exports', compiled.code)(
                (id: string) => id === 'react' ? React : id in boundary ? boundary[id] : sdkRequire(id), exports);
            return exports;
        };
        const forks = loadSdk('expo-router/build/fork/getPathFromState-forks', {
            '@react-navigation/native': await import('@react-navigation/native'),
        });
        const routeInfo = loadSdk('expo-router/build/global-state/routeInfo', { '../fork/getPathFromState-forks': forks });
        // Evaluating installed JavaScript is a genuinely untyped SDK boundary.
        const getRouteInfoFromState = routeInfo.getRouteInfoFromState as typeof import('expo-router/build/global-state/routeInfo').getRouteInfoFromState;
        const serverId = getActiveServerSnapshot().serverId;
        getStorage().setState({ settings: { ...settingsDefaults, experiments: true,
            featureToggles: { ...settingsDefaults.featureToggles, automations: true } } });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
        const routeName = (key: string) => workspaceRouteFiles[key]!.replace('./(app)/', '').replace(/\.tsx$/, '');
        const createName = routeName('workflows/new');
        const savedName = routeName('workflows/[id]');
        // React Navigation is an SDK boundary. Its real reducer, not an invented
        // key-preserving mock, decides whether the screen survives navigation.
        const native = StackRouter({ initialRouteName: createName });
        const options = { routeNames: [...new Set([createName, savedName])],
            routeParamList: { [createName]: { id: 'new' } }, routeGetIdList: {} };
        const initialState = native.getInitialState(options);
        let currentState = initialState;
        const nativeSdk = await import('@react-navigation/native');
        const qualified = loadSdk('expo-router/build/useScreens', {
            '@react-navigation/native': { ...nativeSdk, useStateForPath: () => currentState },
            './Route': loadSdk('expo-router/build/Route', {}),
            './global-state/storeContext': { useExpoRouterStore: () => ({ setFocusedState: () => {} }) },
            './global-state/utils': loadSdk('expo-router/build/global-state/utils', {
                'react-native': await import('react-native'), 'expo-constants': { expoConfig: { extra: { router: { adaptiveColors: false } } } },
            }),
            './import-mode': 'sync',
            './navigationEvents': { unstable_navigationEvents: { isEnabled: () => false } },
            './navigationEvents/utils': {},
            // Native navigator declarations and visual loading/error frames are
            // SDK boundaries; the real qualifier, Route context and editor render.
            './primitives': {}, './views/EmptyRoute': {}, './views/Try': {},
            './views/SuspenseFallback': { SuspenseFallback: () => null },
        });
        const getQualifiedRouteComponent = qualified.getQualifiedRouteComponent as typeof import('expo-router/build/useScreens').getQualifiedRouteComponent;
        const nodes = new Map(options.routeNames.map(name => [name, {
            type: 'route', children: [], route: name, contextKey: `./(app)/${name}.tsx`,
            dynamic: name.includes('[id]') ? [{ name: 'id', deep: false }] : null,
            loadRoute: () => ({ default: WorkflowEditorRoute }),
        } satisfies RouteNode]));
        let dispatch = (_action: ReturnType<typeof CommonActions.setParams> | ReturnType<typeof StackActions.replace>) => {};
        function NativeScreen() {
            const [state, setState] = React.useState(initialState);
            currentState = state;
            dispatch = (action) => setState(previous => {
                const next = native.getStateForAction(previous, action, options);
                return next ? native.getRehydratedState(next, options) : previous;
            });
            const route = state.routes[state.index]!;
            const info = getRouteInfoFromState({ routes: [{ name: '__root', state: {
                index: state.index,
                routes: state.routes.map(({ key, name, params }) => ({ key, name, params })),
            } }], index: 0 });
            nativeRouteBoundary.pathname = info.pathname;
            nativeRouteBoundary.params = info.params;
            const Qualified = getQualifiedRouteComponent(nodes.get(route.name)!);
            const navigation = createReactNavigationNativeMock({ navigation: {
                isFocused: () => true, getState: () => state,
            } }).useNavigation();
            // The canonical SDK boundary fixture supplies context reads; dispatch goes through the real reducer above.
            return <Qualified key={route.key} route={route}
                navigation={navigation as React.ComponentProps<typeof Qualified>['navigation']} />;
        }
        routerSpy.replace.mockImplementation((href: string) => dispatch(StackActions.replace(savedName, { id: href.split('/').at(-1)! })));
        routerSpy.setParams.mockImplementation((params) => dispatch(CommonActions.setParams(params)));
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } });
        definitionActions.create.mockResolvedValueOnce({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
            definition, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved here' } });
        const screen = await renderScreen(<NativeScreen />);
        expect(nativeRouteBoundary.pathname).toBe('/workflows/new');
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readBodyProps()).not.toBeNull();
        });
        const initial = readBodyProps()!.draft;
        await act(async () => readBodyProps()!.onChange({ ...initial, name: 'Saved here', inputs: definition.inputs,
            defaults: definition.defaults, blocks: definition.blocks, finalOutput: definition.finalOutput }, 'Build workflow'));
        const accepted = readBodyProps()!.draft;
        await act(async () => readBodyProps()!.onSave?.());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readBodyProps()!.saveStatus?.kind).toBe('saved');
        });
        expect(nativeRouteBoundary.pathname).toBe(`/workflows/${createdDefinitionId()}`);
        expect(currentState.routes[currentState.index]!.key).toBe(initialState.routes[initialState.index]!.key);
        expect(readBodyProps()!.draft).toBe(accepted);
        expect(definitionActions.get).not.toHaveBeenCalled();
        await act(async () => readBodyProps()!.history!.undo());
        expect(readBodyProps()!.draft).toBe(initial);
        await act(async () => readBodyProps()!.history!.redo());
        expect(readBodyProps()!.draft).toBe(accepted);
        await screen.unmount();
    });
    it('shows an unavailable header reason when the saved definition cannot open', async () => {
        corruptStoredHeader = true;
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const state = screen.tree.findHostByTestId('workflow-editor-error');
        expect(state).not.toBeNull();
        const text = state!.findAll(node => typeof node.props.children === 'string').map(node => node.props.children).join('\n');
        expect(text).toContain(t('common.unavailable'));
        expect(text).toContain(t('workflows.contentReasons.invalidHeader'));
        expect(text).not.toContain('private internal text');
        expect(readBodyProps()).toBeNull();
        await screen.unmount();
    });
    it('discards a pristine unsaved draft through the navigation owner without a write', async () => {
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const discard = readBodyProps()?.menuActions?.find((action) => action.id === 'discard');
        expect(discard).toBeDefined();
        await act(async () => discard?.onSelect());
        expect(routerSpy.replace).toHaveBeenCalledWith('/workflows');
        expect(definitionActions.create).not.toHaveBeenCalled();
        expect(definitionActions.update).not.toHaveBeenCalled();
        await screen.unmount();
    });
    it('lists a new draft\'s Discard last, after its safe operations (DESIGN-9 N46)', async () => {
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const actions = readBodyProps()?.menuActions ?? [];
        expect(actions.at(-1)?.id).toBe('discard');
        expect(actions[0]?.destructive).not.toBe(true);
        await screen.unmount();
    });
    it('returns a saved workflow with edits to its saved version through Discard changes, and Undo brings the edits back (DESIGN-9 N44)', async () => {
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        // A clean saved workflow has nothing to discard.
        expect(readBodyProps()!.menuActions?.some((action) => action.id === 'discardChanges')).toBe(false);
        const saved = readBodyProps()!.draft;
        await act(async () => readBodyProps()!.onChange({ ...saved, name: 'Unsaved rename' }, 'Rename'));
        await act(async () => readBodyProps()!.onChangeDescription?.('Unsaved purpose'));
        await act(async () => readBodyProps()!.onCommitChange?.());
        const ids = (readBodyProps()!.menuActions ?? []).map((action) => action.id);
        expect(ids).toContain('discardChanges');
        // Destructive operations close the menu: Discard changes, then Delete workflow.
        expect(ids.slice(-2)).toEqual(['discardChanges', 'delete']);

        await act(async () => { void readBodyProps()!.menuActions?.find((action) => action.id === 'discardChanges')?.onSelect(); });
        await pressConfirmation(false);
        expect(readBodyProps()!.draft.name).toBe('Unsaved rename');
        expect(readBodyProps()!.saveStatus?.kind).toBe('unsaved');

        await act(async () => { void readBodyProps()!.menuActions?.find((action) => action.id === 'discardChanges')?.onSelect(); });
        expect(readConfirmation()).toMatchObject({ title: t('common.discardChanges'), message: t('workflows.page.discardChangesBody'), destructive: true });
        await pressConfirmation(true);
        expect(readBodyProps()!.draft).toEqual(saved);
        expect(readBodyProps()!.description).toBe('');
        expect(readBodyProps()!.saveStatus?.kind).toBe('saved');
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).not.toBe(true);
        expect(routerSpy.replace).not.toHaveBeenCalled();
        expect(definitionActions.update).not.toHaveBeenCalled();
        expect(readBodyProps()!.menuActions?.some((action) => action.id === 'discardChanges')).toBe(false);

        expect(readBodyProps()!.history?.undoLabel).toBe(t('common.discardChanges'));
        await act(async () => readBodyProps()!.history!.undo());
        expect(readBodyProps()!.draft.name).toBe('Unsaved rename');
        expect(readBodyProps()!.description).toBe('Unsaved purpose');
        await screen.unmount();
    });
    it.each(['saved', 'failed'] as const)('protects a pristine seeded draft during its first Save and retains its terminal outcome (%s)', async outcome => {
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } });
        const pending = createDeferred<WorkflowDefinitionGetResultV1>();
        definitionActions.create.mockReturnValueOnce(pending.promise);
        const destinations: unknown[] = [];
        routerSpy.replace.mockImplementation(route => { void runGuardedNavigation(() => { destinations.push(route); }); });
        const seedId = storeWorkflowDefinitionDraftSeed({ name: 'Retained save', definition });
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId: seedId }} />);
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(false);
        await act(async () => readBodyProps()!.onSave?.());
        expect(readBodyProps()!.saveStatus?.kind).toBe('saving');
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
        let departure: true | Promise<boolean> = true;
        await act(async () => { departure = runGuardedNavigation(() => { destinations.push('/settings'); }); });
        expect(destinations).toEqual([]);
        expect(readAlert()).toBeDefined();
        await pressAlertButton('cancel');
        await act(async () => { expect(await departure).toBe(false); });
        expect(destinations).toEqual([]);
        expect(readBodyProps()!.draft.name).toBe('Retained save');
        await act(async () => {
            refuseArtifactCreate = outcome === 'failed';
            pending.resolve({ definitionId: SAVED_TRIGGER_WORKFLOW_ID, definition,
                access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Retained save' } });
        });
        if (outcome === 'saved') {
            expect(readBodyProps()!.saveStatus?.kind).toBe('saved');
            await act(async () => { expect(await runGuardedNavigation(() => { destinations.push('/settings'); })).toBe(true); });
            expect(destinations).toContain('/settings');
        } else {
            expect(readBodyProps()!.saveStatus?.kind).toBe('failed');
            expect(destinations).toEqual([]);
            expect(readBodyProps()!.draft.name).toBe('Retained save');
            expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
        }
        await screen.unmount();
    });
    it('replaces a first successful Save only after the real draft guard is clean', async () => {
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } });
        definitionActions.create.mockResolvedValueOnce({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
            definition, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved here' } });
        const destinations: unknown[] = [];
        routerSpy.replace.mockImplementation((route) => {
            void runGuardedNavigation(() => { destinations.push(route); });
        });
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const draft = readBodyProps()?.draft;
        if (!draft) throw new Error('Expected new draft');
        await act(async () => readBodyProps()?.onChange({ ...draft, name: 'Saved here', inputs: definition.inputs,
            defaults: definition.defaults, blocks: definition.blocks, finalOutput: definition.finalOutput }));
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
        await act(async () => readBodyProps()?.onSave?.());
        expect(definitionActions.create).toHaveBeenCalledOnce();
        expect(readBodyProps()?.saveStatus).toMatchObject({ kind: 'saved' });
        expect(destinations).toEqual([`/workflows/${createdDefinitionId()}`]);
        expect(readAlert()).toBeUndefined();
        expect(readBodyProps()?.saveStatus?.kind).toBe('saved');
        await screen.unmount();
    });
    it.each([false, true])('uses the existing stack for editor Back, with a list fallback only for a deep link (hasHistory=%s)', async hasHistory => {
        routerSpy.canGoBack.mockReturnValue(hasHistory);
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        await act(async () => readBodyProps()!.onBack!());
        if (hasHistory) {
            expect(routerSpy.back).toHaveBeenCalledOnce();
            expect(routerSpy.replace).not.toHaveBeenCalled();
        } else {
            expect(routerSpy.back).not.toHaveBeenCalled();
            expect(routerSpy.replace).toHaveBeenCalledWith('/workflows');
        }
        await screen.unmount();
    });
    it.each(['menu', 'back', 'column', 'route'] as const)('guards %s departure from a changed new draft through the shell navigation owner', async (exit) => {
        const destinations: unknown[] = [];
        routerSpy.replace.mockImplementation((route) => {
            void runGuardedNavigation(() => { destinations.push(route); });
        });
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', builtinId: 'builtin:plan-with-a-panel' }} />);
        const draft = readBodyProps()?.draft;
        if (!draft) throw new Error('Expected built-in draft');
        await act(async () => readBodyProps()?.onChange({ ...draft, name: 'Changed draft' }));
        const discard = readBodyProps()?.menuActions?.find((action) => action.id === 'discard');
        await act(async () => {
            if (exit === 'menu') discard?.onSelect();
            else if (exit === 'back') readBodyProps()?.onBack?.();
            else void runGuardedNavigation(() => { destinations.push(exit === 'column' ? '/workflows/builtin:keep-going' : '/settings'); });
        });
        const buttons = readAlert()?.buttons;
        expect(buttons?.some((button) => button.style === 'destructive')).toBe(true);
        await pressAlertButton('destructive');
        expect(destinations).toEqual([exit === 'column' ? '/workflows/builtin:keep-going' : exit === 'route' ? '/settings' : '/workflows']);
        expect(routerSpy.back).not.toHaveBeenCalled();
        expect(definitionActions.create).not.toHaveBeenCalled();
        await screen.unmount();
    });
    it('keeps the accepted draft and undo history when the first Save promotes its route, but resets on another definition or Account', async () => {
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } });
        definitionActions.create.mockResolvedValueOnce({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
            definition, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved here' } });
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const initial = readBodyProps()!.draft;
        await act(async () => readBodyProps()!.onChange({ ...initial, name: 'Saved here', inputs: definition.inputs,
            defaults: definition.defaults, blocks: definition.blocks, finalOutput: definition.finalOutput }, 'Build workflow'));
        await act(async () => readBodyProps()!.onSave?.());
        const accepted = readBodyProps()!.draft;
        const savedDefinitionId = createdDefinitionId();
        const hydration = createDeferred<WorkflowDefinitionGetResultV1>();
        definitionActions.get.mockReturnValueOnce(hydration.promise);
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: savedDefinitionId }} />);
        expect(screen.findAllHostsByTestId('workflow-editor-loading')).toHaveLength(0);
        expect(definitionActions.get).not.toHaveBeenCalled();
        expect(readBodyProps()!.draft).toBe(accepted);
        expect(readBodyProps()!.history?.undoLabel).toBe('Build workflow');
        await act(async () => readBodyProps()!.history!.undo());
        expect(readBodyProps()!.draft).toBe(initial);
        expect(readBodyProps()!.saveStatus?.kind).toBe('unsaved');
        await act(async () => readBodyProps()!.history!.redo());
        expect(readBodyProps()!.draft).toBe(accepted);
        expect(readBodyProps()!.saveStatus?.kind).toBe('saved');
        await act(async () => switchEditorAccountScope({ serverId: 'server-a', accountId: 'account-b' }));
        expect(screen.findAllHostsByTestId('workflow-editor-loading')).toHaveLength(1);
        await act(async () => hydration.resolve({ definitionId: savedDefinitionId, definition,
            access: 'view', revision: { headerVersion: 3, bodyVersion: 3 }, metadata: { title: 'Account B workflow' } }));
        expect(readBodyProps()!.draft.name).toBe('Account B workflow');
        expect(readBodyProps()!.history).toBeUndefined();
        definitionActions.get.mockResolvedValueOnce({ definitionId: '00000000-0000-4000-8000-000000000006', definition,
            access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Another definition' } });
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: '00000000-0000-4000-8000-000000000006' }} />);
        expect(readBodyProps()!.draft.name).toBe('Another definition');
        expect(readBodyProps()!.history?.undoLabel).toBeNull();
        await screen.unmount();
    });
    it.each(['save again', 'open saved row'] as const)('keeps edits made during a first Save dirty and does not replace their draft (%s)', async nextAction => {
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } });
        const pending = createDeferred<WorkflowDefinitionGetResultV1>();
        definitionActions.create.mockReturnValueOnce(pending.promise);
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const draft = readBodyProps()?.draft;
        if (!draft) throw new Error('Expected new draft');
        const submitted = { ...draft, name: 'Submitted', inputs: definition.inputs,
            defaults: definition.defaults, blocks: definition.blocks, finalOutput: definition.finalOutput };
        await act(async () => readBodyProps()?.onChange(submitted));
        await act(async () => readBodyProps()?.onSave?.());
        await act(async () => readBodyProps()?.onChange({ ...submitted, name: 'Still editing' }));
        await act(async () => pending.resolve({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
            definition, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Submitted' } }));
        const savedDefinitionId = createdDefinitionId();
        expect(routerSpy.replace).not.toHaveBeenCalled();
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
        expect(readBodyProps()?.draft.name).toBe('Still editing');
        expect(readBodyProps()?.saveStatus?.kind).toBe('unsaved');
        if (nextAction === 'save again') {
            const accepted = readBodyProps()!.draft;
            definitionActions.update.mockResolvedValueOnce({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
                definition, access: 'owner', revision: { headerVersion: 2, bodyVersion: 2 }, metadata: { title: 'Still editing' } });
            await act(async () => readBodyProps()!.onSave?.());
            expect(routerSpy.replace).toHaveBeenCalledWith(`/workflows/${savedDefinitionId}`);
            await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: savedDefinitionId }} />);
            expect(readBodyProps()!.draft).toBe(accepted);
            expect(definitionActions.get).not.toHaveBeenCalled();
        } else {
            definitionActions.get.mockResolvedValueOnce({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
                definition, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Submitted' } });
            // Opening the saved row separately after choosing to discard the later
            // edits is not the clean first-Save continuation.
            await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: savedDefinitionId }} />);
            expect(readBodyProps()?.draft.name).toBe('Submitted');
        }
        await screen.unmount();
    });
    it('opens a fresh new draft when leaving a promoted saved editor for the create route', async () => {
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } });
        definitionActions.create.mockResolvedValueOnce({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
            definition, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved here' } });
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const initial = readBodyProps()!.draft;
        await act(async () => readBodyProps()!.onChange({ ...initial, name: 'Saved here', inputs: definition.inputs,
            defaults: definition.defaults, blocks: definition.blocks, finalOutput: definition.finalOutput }, 'Build workflow'));
        await act(async () => readBodyProps()!.onSave?.());
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: createdDefinitionId() }} />);
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        expect(readBodyProps()!.draft.name).toBe('');
        expect(readBodyProps()!.draft.draftId).not.toBe(initial.draftId);
        expect(readBodyProps()!.history?.undoLabel).toBeNull();
        expect(readBodyProps()!.menuActions?.some((action) => action.id === 'discard')).toBe(true);
        await screen.unmount();
    });
    it('lets a Can-use recipient save personal triggers without editing the definition', async () => {
        initializePersonalWhereWriter();
        definitionActions.get.mockImplementationOnce(async ({ definitionId }) => ({ definitionId, access: 'view',
            definition: createWorkflowDefinitionFixture({ defaults: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            } }), revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Shared workflow' } }));
        editorAutomations.respondWith(method => method === 'POST' ? Response.json({ error: 'target_unavailable' }, { status: 503 }) : undefined);
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        expect(readBodyProps()?.documentPresentation?.editable).toBe(false);
        expect(readBodyProps()?.onSave).toBeTypeOf('function');
        const section = readBodyProps()?.triggersSection;
        if (!React.isValidElement<React.ComponentProps<typeof WorkflowTriggerSection>>(section)) throw new Error('Missing personal triggers');
        await act(async () => readBodyProps()?.onChangeProjectTarget?.({ machineId: 'machine-1', directory: '/repo' }));
        await act(async () => section.props.onChangeDraft(editWorkflowTriggerDraft(section.props.draft, {
            kind: 'add', clientId: 'personal', trigger: { kind: 'schedule', enabled: true,
                schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } },
        })));
        expect(guardedDirtyStates.at(-1)).toBe(true);
        await saveWithTriggerConfirmation();
        expect(editorAutomations.creates).toEqual([expect.objectContaining({ workflowDefinitionId: SAVED_TRIGGER_WORKFLOW_ID })]);
        expect(definitionActions.update).not.toHaveBeenCalled();
        expect(definitionActions.create).not.toHaveBeenCalled();
        expect(readBodyProps()?.saveStatus?.kind).toBe('failed');
        await screen.unmount();
    });

    it('duplicates a Can-use workflow into an unsaved portable draft, without a write', async () => {
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } });
        definitionActions.get.mockImplementationOnce(async ({ definitionId }) => ({ definitionId, access: 'view',
            definition, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Shared workflow', description: 'Portable purpose' } }));
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const duplicate = readBodyProps()?.menuActions?.find((action) => action.id === 'duplicate');
        expect(duplicate).toBeDefined();
        await act(async () => duplicate?.onSelect());
        const route = routerSpy.push.mock.calls.at(-1)?.[0] as { pathname: string; params: { definitionDraftSeedId: string } };
        expect(route.pathname).toBe('/workflows/new');
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId: route.params.definitionDraftSeedId }} />);
        expect(readBodyProps()?.draft).toMatchObject({ name: t('workflows.copyName', { name: 'Shared workflow' }), blocks: definition.blocks, inputs: definition.inputs });
        expect(readBodyProps()?.description).toBe('Portable purpose');
        expect(readBodyProps()?.currentWorkflowRef).toBeNull();
        expect(readBodyProps()?.saveStatus?.kind).toBe('notSaved');
        expect(readBodyProps()?.menuActions?.some((action) => action.id === 'discard')).toBe(true);
        expect(definitionActions.create).not.toHaveBeenCalled();
        expect(definitionActions.update).not.toHaveBeenCalled();
        expect(editorAutomations.creates).toHaveLength(0);
        definitionActions.create.mockImplementationOnce(async (request) => ({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
            access: 'owner', definition: WorkflowDefinitionV1Schema.parse(request.definition), metadata: request.metadata,
            revision: { headerVersion: 1, bodyVersion: 1 } }));
        await act(async () => readBodyProps()?.onSave?.());
        expect(definitionActions.create).toHaveBeenCalledWith(expect.objectContaining({ definition,
            metadata: { title: t('workflows.copyName', { name: 'Shared workflow' }), description: 'Portable purpose' } }));
        expect(definitionActions.update).not.toHaveBeenCalled();
        await screen.unmount();
    });
    it('shares labelled history across removal, example insertion and agent rename, preserving Save and clearing redo on edits', async () => {
        const base = { definitionId: SAVED_TRIGGER_WORKFLOW_ID, definition: createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } }),
            revision: { headerVersion: 4, bodyVersion: 8 }, metadata: { title: 'Saved', description: 'Original purpose' }, changedBlockIds: [] };
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: base.definitionId, agentRevision: base }} />);
        const original = readBodyProps()!.draft;
        const removed = removeWorkflowBlock(original, original.blocks[0]!.id);
        await act(async () => readBodyProps()!.onChange(removed.draft));
        const inserted = insertWorkflowStarterExample(readBodyProps()!.draft, WORKFLOW_STARTER_EXAMPLES_V1[0]!, 'Example');
        await act(async () => readBodyProps()!.onChange(inserted.draft, 'Insert example'));
        expect(readBodyProps()!.history?.undoLabel).toBe('Insert example');
        await act(async () => readBodyProps()!.history!.undo());
        expect(readBodyProps()!.draft).toEqual(removed.draft);
        expect(readBodyProps()!.history?.undoLabel).toBe(t('workflows.a11y.removed', { block: t('workflows.editor.addStep'), total: 0 }));
        await act(async () => readBodyProps()!.history!.undo());
        expect(readBodyProps()!.draft).toEqual(original);
        const renamed = { ...base, revision: { headerVersion: 5, bodyVersion: 9 }, metadata: { title: 'Agent rename', description: 'Agent purpose' }, changedBlockIds: ['step-1'] };
        // The agent revision is a committed Home fact, not only a route seed.
        definitionActions.get.mockResolvedValue({ definitionId: renamed.definitionId, definition: renamed.definition,
            metadata: renamed.metadata, revision: renamed.revision, access: 'owner' } satisfies WorkflowDefinitionGetResultV1);
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: base.definitionId, agentRevision: renamed }} />);
        expect(readBodyProps()!.draft.name).toBe('Agent rename');
        expect(readBodyProps()!.description).toBe('Agent purpose');
        expect(readBodyProps()!.history?.redoLabel).toBeNull();
        await act(async () => readBodyProps()!.history!.undo());
        expect(readBodyProps()!.draft).toEqual(original);
        expect(readBodyProps()!.description).toBe('Original purpose');
        expect(readBodyProps()!.saveStatus?.kind).toBe('unsaved');
        await act(async () => readBodyProps()!.history!.redo());
        expect(readBodyProps()!.draft.name).toBe('Agent rename');
        expect(readBodyProps()!.saveStatus?.kind).toBe('saved');
        await act(async () => readBodyProps()!.history!.undo());
        definitionActions.update.mockResolvedValue({ definitionId: base.definitionId, definition: base.definition, access: 'owner',
            metadata: base.metadata, revision: { headerVersion: 6, bodyVersion: 10 } });
        await act(async () => readBodyProps()!.onSave?.());
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readBodyProps()!.saveStatus?.kind).toBe('saved');
        });
        expect(definitionActions.update).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: renamed.revision,
            metadata: { title: 'Saved', description: 'Original purpose' } }));
        expect(readBodyProps()!.history?.redoLabel).not.toBeNull();
        expect(readBodyProps()!.saveStatus?.kind).toBe('saved');
        await act(async () => readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'My rename' }, 'Rename'));
        expect(readBodyProps()!.history?.redoLabel).toBeNull();
    });

    it('commits text at its input boundary and undoes metadata and targets in one source-local history', async () => {
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const original = readBodyProps()!.draft;
        await act(async () => readBodyProps()!.onChange({ ...original, name: 'Typing' }, 'Name', false));
        expect(readBodyProps()!.history?.undoLabel).toBeNull();
        await act(async () => readBodyProps()!.onCommitChange?.());
        expect(readBodyProps()!.history?.undoLabel).toBe('Name');
        await act(async () => readBodyProps()!.onChangeDescription?.('Purpose'));
        await act(async () => readBodyProps()!.onCommitChange?.());
        await act(async () => readBodyProps()!.onChangeProjectTarget?.({ machineId: 'machine-1', directory: '/project' }));
        await act(async () => readBodyProps()!.onChangeExecutionTarget?.('detached_run'));
        await act(async () => readBodyProps()!.history!.undo());
        expect(readBodyProps()!.executionTarget).toBe('session');
        await act(async () => readBodyProps()!.history!.undo());
        expect(readBodyProps()!.projectTarget).toBeNull();
        await act(async () => readBodyProps()!.history!.undo());
        expect(readBodyProps()!.description).toBe('');
        await act(async () => readBodyProps()!.history!.undo());
        expect(readBodyProps()!.draft.name).toBe(original.name);
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'new', exampleKey: WORKFLOW_STARTER_EXAMPLES_V1[0]!.key }} />);
        expect(readBodyProps()!.history?.undoLabel).toBeNull();
        expect(readBodyProps()!.history?.redoLabel).toBeNull();
    });

    it('orders trigger edits with document edits instead of owning a separate trigger history', async () => {
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const readSection = () => {
            const section = readBodyProps()!.triggersSection;
            if (!React.isValidElement<React.ComponentProps<typeof WorkflowTriggerSection>>(section)) throw new Error('Expected trigger editor');
            return section.props;
        };
        const trigger = { kind: 'schedule', enabled: true, schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } } as const;
        await act(async () => readSection().onChangeDraft(editWorkflowTriggerDraft(readSection().draft, { kind: 'add', clientId: 'schedule-1', trigger })));
        await act(async () => readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'After trigger' }, 'Rename'));
        await act(async () => readBodyProps()!.history!.undo());
        expect(readBodyProps()!.draft.name).toBe('');
        expect(readSection().draft.adds).toHaveLength(1);
        await act(async () => readBodyProps()!.history!.undo());
        expect(readSection().draft.adds).toHaveLength(0);
        await act(async () => readBodyProps()!.history!.redo());
        expect(readSection().draft.adds).toEqual([{ clientId: 'schedule-1', trigger }]);
    });

    it.each([false, true])('opens the exact agent-returned revision despite clock skew (delayed history=%s)', async (delayedHistory) => {
        getStorage().setState({ sessionMessages: {}, sessions: {
            'author-session': createSessionFixture({ id: 'author-session', seq: 100 }),
        } });
        const definitionId = SAVED_TRIGGER_WORKFLOW_ID;
        const result = {
            definition: createWorkflowDefinitionFixture(),
            revision: { headerVersion: 4, bodyVersion: 8 },
            metadata: { title: 'Agent snapshot', description: 'Exact saved description' }, changedBlockIds: ['step-1'],
        };
        const { resolveTranscriptWorkflowDefinitionReference } = await import('@/components/sessions/transcript/references/transcriptWorkflowDefinitionReference');
        const agentRevision = resolveTranscriptWorkflowDefinitionReference(createToolCallMessageFixture({ tool: {
            ...createToolCallMessageFixture().tool,
            name: `mcp__happier__${getActionSpec('workflow.definition.edit').bindings?.mcpToolName}`,
            state: 'completed', input: { definitionId, expectedRevision: { headerVersion: 3, bodyVersion: 7 }, ops: [{ kind: 'rename', name: 'Agent snapshot' }] },
            result: { ok: true, result },
        } }).tool);
        if (!agentRevision) throw new Error('Expected exact edit receipt');
        const seedId = storeWorkflowAgentRevision(agentRevision, 'author-session');
        const newer = createToolCallMessageFixture({ seq: 99, tool: {
            ...createToolCallMessageFixture().tool,
            name: `mcp__happier__${getActionSpec('workflow.definition.update').bindings?.mcpToolName}`,
            state: 'completed', input: {}, completedAt: Date.now() + 86_400_000,
            result: { definitionId, access: 'owner', definition: agentRevision.definition,
                revision: { headerVersion: 9, bodyVersion: 9 }, metadata: { title: 'Newer, not selected' } },
        } });
        const publishHistory = () => getStorage().setState({ sessionMessages: { 'author-session': createSessionMessagesFixture({
            messageIdsOldestFirst: [newer.id], messagesById: { [newer.id]: newer }, isLoaded: true,
        }) } });
        if (!delayedHistory) publishHistory();
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevisionSeedId: seedId }} />);
        if (delayedHistory) await act(async () => publishHistory());
        expect(readWorkflowAgentRevision(seedId)).toBeNull();
        expect(readBodyProps()?.draft.name).toBe('Agent snapshot');
        expect(readBodyProps()?.description).toBe('Exact saved description');
        expect(readBodyProps()?.highlightedBlockIds).toEqual(['step-1']);
        expect(definitionActions.get).toHaveBeenCalledWith({ definitionId });
        const next = { ...newer, seq: 101, id: 'post-open-update', tool: { ...newer.tool, id: 'post-open-update', completedAt: 1, result: { definitionId, access: 'owner', definition: agentRevision.definition,
            revision: { headerVersion: 10, bodyVersion: 10 }, metadata: { title: 'Saved after opening' } } } };
        await act(async () => getStorage().setState({ sessionMessages: { 'author-session': createSessionMessagesFixture({
            messageIdsOldestFirst: [next.id], messagesById: { [next.id]: next }, isLoaded: true,
        }) } }));
        expect(readBodyProps()?.draft.name).toBe('Saved after opening');
        expect(readBodyProps()?.highlightedBlockIds).toEqual([]);
        expect(readBodyProps()?.saveStatus).toMatchObject({ kind: 'saved', byAgent: true });
        expect(definitionActions.get).toHaveBeenCalledWith({ definitionId });
        const currentDraft = readBodyProps()?.draft;
        if (!currentDraft) throw new Error('Expected the clean agent reload');
        await act(async () => readBodyProps()?.onChange({ ...currentDraft, name: 'My unsaved edit' }));
        const changed = { ...next, seq: 102, id: 'second-post-open-update', tool: { ...next.tool, id: 'second-post-open-update', completedAt: 2, result: {
            ...next.tool.result, revision: { headerVersion: 11, bodyVersion: 11 }, metadata: { title: 'Another agent save' },
        } } };
        await act(async () => getStorage().setState({ sessionMessages: { 'author-session': createSessionMessagesFixture({
            messageIdsOldestFirst: [changed.id], messagesById: { [changed.id]: changed }, isLoaded: true,
        }) } }));
        expect(readBodyProps()?.draft.name).toBe('My unsaved edit');
        expect(readBodyProps()?.saveConflict?.currentDraft?.name).toBe('Another agent save');
        expect(readBodyProps()?.saveConflict?.currentRevision).toEqual({ headerVersion: 11, bodyVersion: 11 });
    });

    it.each([false, true])('observes an agent call completing after open below the sequence watermark (dirty=%s)', async (dirty) => {
        const definitionId = SAVED_TRIGGER_WORKFLOW_ID;
        const base = { definitionId, definition: createWorkflowDefinitionFixture(),
            revision: { headerVersion: 4, bodyVersion: 8 }, metadata: { title: 'Agent snapshot' }, changedBlockIds: [] };
        const input = { definitionId, expectedRevision: base.revision, definition: base.definition };
        const running = createToolCallMessageFixture({ id: 'running-at-open', seq: 98, tool: {
            ...createToolCallMessageFixture().tool,
            name: dirty ? 'mcp__happier__action_execute'
                : `mcp__happier__${getActionSpec('workflow.definition.update').bindings?.mcpToolName}`,
            state: 'running', input: dirty ? { actionId: 'workflow.definition.update', input } : input,
        } });
        const historical = createToolCallMessageFixture({ id: 'completed-before-open', seq: 99, tool: {
            ...running.tool, state: 'completed', completedAt: Date.now() + 86_400_000,
            result: { definitionId, access: 'owner', definition: base.definition, revision: { headerVersion: 9, bodyVersion: 9 }, metadata: { title: 'Historical save' } },
        } });
        const publish = (messages: readonly (typeof running)[]) => {
            const rows = dirty ? [createToolCallMessageFixture({ id: 'authoring-parent', seq: 96, children: [...messages] })] : messages;
            getStorage().setState({ sessionMessages: {
                'author-session': createSessionMessagesFixture({
                    messageIdsOldestFirst: rows.map((message) => message.id),
                    messagesById: Object.fromEntries(rows.map((message) => [message.id, message])), isLoaded: true,
                }),
            } });
        };
        getStorage().setState({ sessions: { 'author-session': createSessionFixture({ id: 'author-session', seq: 100 }) } });
        publish([running, historical]);
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevision: base, authoringSessionId: 'author-session' }} />);
        expect(readBodyProps()?.draft.name).toBe('Agent snapshot');
        if (dirty) await act(async () => readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'My unsaved edit' }));

        const lateRunning = { ...running, id: 'older-call-hydrated-after-open', seq: 97 };
        await act(async () => publish([running, historical, lateRunning]));
        const lateCompleted = { ...lateRunning, tool: { ...lateRunning.tool, state: 'completed' as const, completedAt: 1,
            result: { definitionId, access: 'owner', definition: base.definition, revision: { headerVersion: 6, bodyVersion: 10 }, metadata: { title: 'Hydrated older call' } },
        } };
        await act(async () => publish([running, historical, lateCompleted]));
        expect(readBodyProps()?.draft.name).toBe(dirty ? 'My unsaved edit' : 'Agent snapshot');
        expect(readBodyProps()?.saveConflict).toBeNull();

        const saved: WorkflowDefinitionGetResultV1 = { definitionId, access: 'owner', definition: base.definition,
            revision: { headerVersion: 5, bodyVersion: 9 }, metadata: { title: 'Saved after opening' } };
        const completed = { ...running, tool: { ...running.tool, state: 'completed' as const, completedAt: 1, result: saved } };
        await act(async () => publish([completed, historical, lateCompleted]));
        if (dirty) {
            expect(readBodyProps()?.draft.name).toBe('My unsaved edit');
            expect(readBodyProps()?.saveConflict?.currentDraft?.name).toBe('Saved after opening');
            expect(readBodyProps()?.saveConflict?.currentRevision).toEqual(saved.revision);
        } else {
            expect(readBodyProps()?.draft.name).toBe('Saved after opening');
            expect(readBodyProps()?.saveStatus).toMatchObject({ kind: 'saved', byAgent: true });
            expect(readBodyProps()?.saveConflict).toBeNull();
        }
        expect(definitionActions.get).toHaveBeenCalledWith({ definitionId });

        const seedId = storeWorkflowAgentRevision({ ...base, metadata: { title: 'Another selected snapshot' } }, 'author-session');
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevisionSeedId: seedId }} />);
        expect(readBodyProps()?.draft.name).toBe('Another selected snapshot');
        expect(readBodyProps()?.saveConflict).toBeNull();
    });

    it('keeps dirty local edits when a newer agent revision arrives and offers the canonical conflict', async () => {
        const definitionId = SAVED_TRIGGER_WORKFLOW_ID;
        const base = { definitionId, definition: createWorkflowDefinitionFixture(),
            revision: { headerVersion: 4, bodyVersion: 8 }, metadata: { title: 'Saved' }, changedBlockIds: [] };
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevision: base }} />);
        const original = readBodyProps()?.draft;
        if (!original) throw new Error('Expected exact saved snapshot');
        await act(async () => readBodyProps()?.onChange({ ...original, name: 'My local edit' }));
        const next = { ...base, metadata: { title: 'Agent rename' }, revision: { headerVersion: 5, bodyVersion: 9 }, changedBlockIds: ['step-1'] };
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevision: next }} />);
        expect(readBodyProps()?.draft.name).toBe('My local edit');
        expect(readBodyProps()?.saveConflict?.currentDraft?.name).toBe('Agent rename');
        expect(readBodyProps()?.saveConflict?.currentRevision).toEqual(next.revision);
        expect(readBodyProps()?.highlightedBlockIds ?? []).toEqual([]);
    });

    it('a clean agent reload uses returned IDs only and clears the tint on selection', async () => {
        const definitionId = SAVED_TRIGGER_WORKFLOW_ID;
        const base = { definitionId, definition: createWorkflowDefinitionFixture(),
            revision: { headerVersion: 4, bodyVersion: 8 }, metadata: { title: 'Saved' }, changedBlockIds: [] };
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevision: base }} />);
        const next = { ...base, metadata: { title: 'New saved title' }, revision: { headerVersion: 5, bodyVersion: 9 }, changedBlockIds: ['step-1'] };
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevision: next }} />);
        expect(readBodyProps()?.draft.name).toBe('New saved title');
        expect(readBodyProps()?.highlightedBlockIds).toEqual(['step-1']);
        expect(readBodyProps()?.saveStatus).toMatchObject({ kind: 'saved', byAgent: true });
        await act(async () => readBodyProps()?.onSelectBlock('step-1'));
        expect(readBodyProps()?.highlightedBlockIds).toEqual([]);
    });
    it('Edit with an agent seeds the saved identity and revision into the Agent tab, never the local draft', async () => {
        await prepareSessionDraftPersistenceStorage();
        const definitionId = SAVED_TRIGGER_WORKFLOW_ID;
        const base = { definitionId, definition: createWorkflowDefinitionFixture(),
            revision: { headerVersion: 4, bodyVersion: 8 }, metadata: { title: 'Saved' }, changedBlockIds: [] };
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevision: base }} />);
        const draft = readBodyProps()?.draft;
        if (!draft) throw new Error('Expected saved draft');
        await act(async () => readBodyProps()?.onChange({ ...draft, name: 'Unsaved local name' }));
        // Wide: the header's quiet action, not a ⋯ item, and no modal (04 §4.6, §4.7).
        expect(readBodyProps()?.menuActions?.find((action) => action.id === 'agent')).toBeUndefined();
        await act(async () => readBodyProps()?.onEditWithAgent?.());
        expect(readCustomModal('workflow-agent-authoring-sheet')).toBeUndefined();
        const authoringDraft = readBodyProps()?.authoringDraft;
        if (!authoringDraft) throw new Error('Expected the Agent tab draft');
        const seed = readNewSessionDraftProjectionFromRepository({ draftId: authoringDraft.draftId, scope: { serverId: 'server-a', accountId: 'account-a' } });
        expect(seed?.draft.input).toContain('name=Saved');
        expect(seed?.draft.input).toContain(`definitionId=${definitionId}`);
        expect(seed?.draft.input).toContain('headerVersion=4');
        expect(seed?.draft.input).toContain('bodyVersion=8');
        expect(seed?.draft.input).not.toContain('Unsaved local name');
    });
    it('on a phone, Edit with an agent stays in ⋯ and opens the seeded sheet', async () => {
        nativeRouteBoundary.width = 390;
        await prepareSessionDraftPersistenceStorage();
        const definitionId = SAVED_TRIGGER_WORKFLOW_ID;
        const base = { definitionId, definition: createWorkflowDefinitionFixture(),
            revision: { headerVersion: 4, bodyVersion: 8 }, metadata: { title: 'Saved' }, changedBlockIds: [] };
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevision: base }} />);
        expect(readBodyProps()?.onEditWithAgent).toBeUndefined();
        const edit = readBodyProps()?.menuActions?.find((action) => action.id === 'agent');
        expect(edit).toBeDefined();
        await act(async () => edit?.onSelect());
        expect(readCustomModal('workflow-agent-authoring-sheet')).toBeDefined();
    });
    it('keeps the authoring Session after Edit immediately following a new draft Save', async () => {
        await prepareSessionDraftPersistenceStorage();
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } });
        definitionActions.create.mockResolvedValueOnce({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
            definition, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved here' } });
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const draft = readBodyProps()?.draft;
        if (!draft) throw new Error('Expected new draft');
        await act(async () => readBodyProps()?.onChange({ ...draft, name: 'Saved here', inputs: definition.inputs,
            defaults: definition.defaults, blocks: definition.blocks, finalOutput: definition.finalOutput }));
        await act(async () => readBodyProps()?.onSave?.());
        expect(definitionActions.create).toHaveBeenCalledOnce();
        expect(routerSpy.replace).toHaveBeenCalledWith(`/workflows/${encodeURIComponent(createdDefinitionId())}`);
        await act(async () => readBodyProps()?.onEditWithAgent?.());
        const authoringDraft = readBodyProps()?.authoringDraft;
        if (!authoringDraft) throw new Error('Expected the Agent tab draft');
        await act(async () => authoringDraft.onSessionCreated('/session/author-session?serverId=server-a', { sessionId: 'author-session', serverId: 'server-a' }));
        expect(readBodyProps()?.authoringSessionId).toBe('author-session');
        expect(readBodyProps()?.authoringDraft).toBeUndefined();
    });
    it('does not attach a pending authoring Session to another editor source', async () => {
        await prepareSessionDraftPersistenceStorage();
        const boundary = await serveMountedDraftActionHome();
        const { getWorkflowDefinition, createWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        const original = await getWorkflowDefinition({ definitionId: SAVED_TRIGGER_WORKFLOW_ID });
        const base = { ...original, changedBlockIds: [] };
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: base.definitionId, agentRevision: base }} />);
        await act(async () => readBodyProps()?.onEditWithAgent?.());
        const pending = readBodyProps()?.authoringDraft;
        if (!pending) throw new Error('Expected the Agent tab draft');
        const second = { ...await createWorkflowDefinition({ definitionId: '00000000-0000-4000-8000-000000000006',
            definition: original.definition, metadata: { title: 'Second' } }), changedBlockIds: [] };
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: second.definitionId, agentRevision: second }} />);
        expect(readBodyProps()?.authoringDraft).toBeUndefined();
        await act(async () => pending.onSessionCreated(`/session/author-session?serverId=${boundary.scope.serverId}`,
            { sessionId: 'author-session', serverId: boundary.scope.serverId }));
        expect(readBodyProps()?.draft.name).toBe('Second');
        expect(readBodyProps()?.authoringSessionId).toBeNull();
    });
    it('keeps an unavailable saved trigger in its known query after removal instead of inventing inline membership', async () => {
        const set = { automationId: TRIGGER_SET_ID, revision: 3, enabled: true,
            health: 'source_unavailable' as const, triggers: [] };
        getStorage().getState().applyWorkflowTriggerSetPage({ queryKey: `workflow:${SAVED_TRIGGER_WORKFLOW_ID}`, sets: [set] });
        editorAutomations.rows.set(TRIGGER_SET_ID, createWorkflowAutomationDetailFixture({
            id: TRIGGER_SET_ID, revision: 3, workflowDefinitionId: SAVED_TRIGGER_WORKFLOW_ID,
        }));
        missingStoredArtifact = true;
        await renderScreen(<></>);
        const { removeWorkflowTrigger } = await import('@/sync/domains/workflows/workflowTriggerActions');
        await confirmWorkflowAction(() => removeWorkflowTrigger({ automationId: TRIGGER_SET_ID, triggerId: 'trigger-1' }));
        expect(getStorage().getState().workflowTriggerSetIdsByQuery[`workflow:${SAVED_TRIGGER_WORKFLOW_ID}`]).toEqual([TRIGGER_SET_ID]);
        expect(getStorage().getState().workflowTriggerSetIdsByQuery.account_inline).toBeUndefined();
    });

    /**
     * A brand-new Workflow must be able to choose its Agent before Save or Run,
     * because the strict Workflow schema requires an effective one. The neutral
     * host contributes the incumbent Agent catalog for the selected Machine, and
     * every step prompt is scoped to that same Machine and project folder.
     */
    it('contributes the incumbent Agent catalog and the Machine composer scope to the editor', async () => {
        const scope = { serverId: 'server-a', accountId: 'account-a' };
        getStorage().setState({ settingsScope: scope });
        applyAcpCatalogSnapshot(scope, { status: 'ready', record: { v: 1, definitions: [] }, revision: 1 }, true);
        setEditorMachines([createMachineFixture({ metadata: {
            host: 'tester.local', happyCliVersion: '0.0.0-test', happyHomeDir: '/Users/tester/.happy-dev',
            homeDir: '/Users/me', platform: 'darwin',
        } })]);
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);

        await act(async () => readBodyProps()?.onChangeProjectTarget?.({
            machineId: 'machine-1',
            directory: '/Users/me/project',
        }));

        const agentTargets = readBodyProps()?.authoringFacts?.agentTargets ?? [];
        expect(agentTargets.length).toBeGreaterThan(0);
        for (const option of agentTargets) {
            expect(option.target.kind).toBe('agent');
            expect(option.target.identity.pluginId).toBeTruthy();
        }
        expect(readBodyProps()?.composerScope).toEqual({
            kind: 'machine',
            machineId: 'machine-1',
            serverId: 'server-a',
            directory: '/Users/me/project',
            machineHomeDir: '/Users/me',
        });
    });

    /**
     * Route hosts rebuild `source` on every render. Keying initialization on
     * that object identity re-created the draft continuously, which threw away
     * the prompt text and made an untouched editor read as dirty.
     */
    it('initializes one logical source exactly once across rerenders', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        // Every route host builds `source` inline, so a parent rerender hands
        // the editor a structurally identical but referentially new object.
        const host = () => <WorkflowEditorHostScreen source={{ kind: 'new' }} />;
        const screen = await renderScreen(host());
        const initialDraft = readBodyProps()?.draft;
        if (initialDraft === undefined) throw new Error('Expected the new Workflow draft');

        await act(async () => readBodyProps()?.onChange({
            ...initialDraft,
            blocks: [{
                ...initialDraft.blocks[0],
                document: { text: 'Analyze the repository', references: [], attachments: [] },
            }],
        } as never));
        await screen.update(host());
        await screen.update(host());

        expect(readBodyProps()?.draft.draftId).toBe(initialDraft.draftId);
        const firstBlock = readBodyProps()?.draft.blocks[0];
        if (firstBlock?.kind !== 'step') throw new Error('Expected the first Workflow block to be a step');
        expect(firstBlock.document.text).toBe('Analyze the repository');
    });

    /**
     * UX §2.2 J1: a neutral new workflow opens with its first prompt focused.
     * The intent is source-scoped and consumed exactly once through the page's
     * focus owner, so a rerender or an ordinary edit does not replay it.
     */
    it('focuses the first prompt of a neutral new draft exactly once', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const host = () => <WorkflowEditorHostScreen source={{ kind: 'new' }} />;
        const screen = await renderScreen(host());
        await act(async () => {});
        const firstBlockId = readBodyProps()?.draft.blocks[0]?.id;
        await vi.waitFor(() => expect(focusPromptSpy).toHaveBeenCalledTimes(1));
        const firstPrompt = screen.findByTestId(`workflow-editor-step-${firstBlockId}-prompt`)!.findByType(AgentInput);
        expect(firstPrompt.props.inputAccessibilityLabel).toBeTypeOf('string');
        expect(focusPromptSpy).toHaveBeenCalledWith(expect.objectContaining({
            accessibilityLabel: firstPrompt.props.inputAccessibilityLabel,
        }));

        await screen.update(host());
        await act(async () => readBodyProps()?.onChange({ ...readBodyProps()!.draft, name: 'Named' } as never));
        await screen.update(host());
        expect(focusPromptSpy).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });

    /**
     * The pristine baseline must be the exact draft the editor started from. A
     * second construction has a different draft id, so an untouched editor
     * compares unequal and reports itself dirty.
     */
    it('treats an untouched new draft as pristine', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        await act(async () => {});

        expect(guardedDirtyStates.at(-1)).toBe(false);
        await screen.unmount();
    });

    /**
     * A brand-new workflow starts from the same Agent New Session would start
     * from (UX §2.3/J1) — and from nothing at all until that answer is real.
     *
     * The strict Workflow schema requires an effective Agent, so an empty
     * neutral draft is unrunnable; but the honest repair is the contextual
     * Agent for the exact selected Machine, not the bundled fallback, which is
     * what an unresolved projection can still produce.
     */
    describe('contextual Agent for a pristine neutral draft', () => {
        const selectMachine = async () => {
            await act(async () => readBodyProps()?.onChangeProjectTarget?.({
                machineId: 'machine-1',
                directory: '/Users/me/project',
            }));
            if (daemonProjection.resolves) await vi.waitFor(async () => {
                await act(async () => {});
                expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: 'server-a' })?.kind).toBe('ready');
            });
        };

        beforeEach(() => {
            setEditorMachines([createMachineFixture({ metadata: {
                host: 'tester.local', happyCliVersion: '0.0.0-test', happyHomeDir: '/Users/tester/.happy-dev',
                homeDir: '/Users/me', platform: 'darwin',
            } })]);
        });

        it('names the folder home-relative wherever it states where the workflow runs (07 S4, copy rules)', async () => {
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            await selectMachine();
            const section = readBodyProps()?.triggersSection as React.ReactElement<{ whereSummary: string | null }> | undefined;
            expect(section?.props.whereSummary).toMatch(/~\/project$/u);
            expect(section?.props.whereSummary).not.toContain('/Users/me');
            await screen.unmount();
        });

        it('adopts the contextual Agent once the exact Machine projection resolves, without becoming dirty', async () => {
            const scope = { serverId: 'server-a', accountId: 'account-a' };
            getStorage().setState({ settingsScope: scope });
            applyAcpCatalogSnapshot(scope, { status: 'ready', record: { v: 1, definitions: [] }, revision: 1 }, true);
            daemonProjection.resolves = true;
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            await selectMachine();
            // Projection readiness is an input to the real default owner;
            // its derived publication and the host's adoption settle afterwards.
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(readBodyProps()?.authoringFacts?.contextualDefaultAgentTarget).not.toBeNull();
                expect(readBodyProps()?.draft.defaults.agentTarget).toBeDefined();
            });

            const seeded = readBodyProps()?.draft.defaults.agentTarget;
            const offered = readBodyProps()?.authoringFacts?.agentTargets ?? [];
            expect(offered.length).toBeGreaterThan(0);
            expect(readBodyProps()?.authoringFacts?.contextualDefaultAgentTarget).not.toBeNull();
            expect(seeded).toBeDefined();
            // Only an Agent this Machine actually offers: seeding a target the
            // ingress normalizer would reject is the same defect with a nicer
            // chip label.
            expect(offered.some((option) => (
                option.target.identity.pluginId === seeded?.identity.pluginId
                && option.target.identity.localId === seeded?.identity.localId
            ))).toBe(true);
            expect(seeded).toEqual(readBodyProps()?.authoringFacts?.contextualDefaultAgentTarget);
            // Initialization, not an edit: the person has changed nothing.
            expect(guardedDirtyStates.at(-1)).toBe(false);

            await screen.unmount();
        });

        it.each(['trigger', 'definition'] as const)('keeps a copied %s engine valid when the contextual Agent resolves', async (kind) => {
            const scope = { serverId: 'server-a', accountId: 'account-a' };
            getStorage().setState({ settingsScope: scope });
            applyAcpCatalogSnapshot(scope, { status: 'ready', record: { v: 1, definitions: [] }, revision: 1 }, true);
            daemonProjection.resolves = true;
            const { buildTriggerTarget } = await import('../triggers/sessionTriggerForm');
            const target = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Review the changes', selection: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.claude/claude',
                    providerConnectionId: null, modelId: 'claude-haiku-4-5' } },
                connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.claude/claude-subscription': {
                    source: 'connected', selection: 'profile', profileId: 'connected-profile',
                } } },
            } }, 'account');
            if (target?.kind !== 'inline') throw new Error('Expected the prompt trigger producer');
            const { storeTriggerWorkflowSeed, buildTriggerWorkflowSeed } = await import('../triggers/triggerWorkflowSeed');
            const seed = buildTriggerWorkflowSeed(target, { scope: 'account', automationId: TRIGGER_SET_ID, expectedRevision: 1 });
            if (seed === null) throw new Error('Expected the trigger copy');
            const source = kind === 'trigger'
                ? { kind: 'new' as const, triggerWorkflowSeedId: storeTriggerWorkflowSeed(seed) }
                : { kind: 'new' as const, definitionDraftSeedId: storeWorkflowDefinitionDraftSeed({ name: 'Copied workflow', definition: seed.definition }) };
            const screen = await renderScreen(<WorkflowEditorHostScreen source={source} />);
            await selectMachine();
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(readBodyProps()?.authoringFacts?.contextualDefaultAgentTarget).toBeTruthy();
            });
            const draft = readBodyProps()?.draft;
            if (draft === undefined) throw new Error('Expected the copied draft');
            const { validateWorkflowEditorDraft } = await import('@/sync/domains/workflows/workflowAuthoring');
            expect(validateWorkflowEditorDraft(draft).issues).toEqual([]);
            expect(draft.defaults).toEqual(target.definition.defaults);
            expect(draft.defaults).not.toHaveProperty('agentTarget');
            await act(async () => readBodyProps()?.onChange({ ...draft, name: 'Copied prompt' }));
            await act(async () => readBodyProps()?.onSave?.());
            expect(definitionActions.create).toHaveBeenCalledWith(expect.objectContaining({
                definition: expect.objectContaining({ defaults: target.definition.defaults }),
            }));
            await screen.unmount();
        });

        it('hydrates the weekly storage review seed and keeps the selected Machine’s contextual Agent', async () => {
            const scope = { serverId: 'server-a', accountId: 'account-a' };
            getStorage().setState({ settingsScope: scope });
            applyAcpCatalogSnapshot(scope, { status: 'ready', record: { v: 1, definitions: [] }, revision: 1 }, true);
            daemonProjection.resolves = true;
            const definitionDraftSeedId = storeWorkflowDefinitionDraftSeed(createWeeklyStorageReviewWorkflowSeed({ name: 'Weekly storage review' }));
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId }} />);

            await selectMachine();
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(readBodyProps()?.authoringFacts?.contextualDefaultAgentTarget).toBeTruthy();
            });

            expect(readBodyProps()?.draft.name).toBe('Weekly storage review');
            expect(readBodyProps()?.draft.defaults.agentTarget).toEqual(readBodyProps()?.authoringFacts?.contextualDefaultAgentTarget);
            expect(readBodyProps()?.draft.blocks[0]).not.toHaveProperty('execution.engine');
            const { validateWorkflowEditorDraft } = await import('@/sync/domains/workflows/workflowAuthoring');
            expect(validateWorkflowEditorDraft(readBodyProps()!.draft).valid).toBe(true);
            await screen.unmount();
        });

        it('leaves the draft honestly unresolved when no projection can name an Agent', async () => {
            daemonProjection.resolves = false;
            const { validateWorkflowEditorDraft } = await import('@/sync/domains/workflows/workflowAuthoring');
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);

            await selectMachine();
            await act(async () => {});

            expect(readBodyProps()?.authoringFacts?.contextualDefaultAgentTarget ?? null).toBeNull();
            expect(readBodyProps()?.draft.defaults.agentTarget).toBeUndefined();

            // And the draft still says so: an unresolved Agent is refused by the
            // canonical validator rather than papered over at the chip.
            const draft = readBodyProps()?.draft;
            if (draft === undefined) throw new Error('Expected the new Workflow draft');
            const withPrompt = {
                ...draft,
                name: 'Review',
                blocks: [{
                    ...draft.blocks[0],
                    document: { text: 'Analyze the repository', references: [], attachments: [] },
                }],
            } as typeof draft;
            const validation = validateWorkflowEditorDraft(withPrompt);
            expect(validation.valid).toBe(false);
            expect(validation.issues.some((issue) => issue.code === 'target_unavailable')).toBe(true);

            await screen.unmount();
        });

        it('never re-seeds a hydrated saved definition', async () => {
            daemonProjection.resolves = true;
            definitionActions.get.mockResolvedValueOnce({
                definitionId: SAVED_TRIGGER_WORKFLOW_ID,
                access: 'owner',
                revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Saved workflow' },
                definition: {
                    version: 1,
                    inputs: [],
                    defaults: {},
                    blocks: [{
                        kind: 'step', id: 'review',
                        document: { text: 'Review', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                        execution: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                    }],
                },
            });
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(
                <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />,
            );
            await act(async () => {});
            await selectMachine();
            await act(async () => {});

            expect(readBodyProps()?.draft).toMatchObject({ name: 'Saved workflow' });
            expect(readBodyProps()?.draft.defaults.agentTarget).toBeUndefined();
            await screen.unmount();
        });

        it('never overwrites an Agent the person already chose', async () => {
            daemonProjection.resolves = false;
            const authored = {
                kind: 'agent' as const,
                identity: { pluginId: 'acme.review-bot', localId: 'reviewer' },
            };
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            const draft = readBodyProps()?.draft;
            if (draft === undefined) throw new Error('Expected the new Workflow draft');
            await act(async () => readBodyProps()?.onChange({
                ...draft,
                defaults: { ...draft.defaults, agentTarget: authored },
            } as never));

            daemonProjection.resolves = true;
            publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: 'server-a' });
            await selectMachine();
            await act(async () => {});

            expect(readBodyProps()?.draft.defaults.agentTarget).toEqual(authored);
            await screen.unmount();
        });
    });

    /**
     * A reviewed Run copy and a captured Session arrive as already-decrypted
     * Account-private bytes held in memory. Re-initialization is keyed on the
     * Account, so the Account-only change used to re-adopt those exact bytes and
     * stamp them with the new scope — presenting, and offering to save, one
     * Account's private workflow as another's.
     */
    describe('private seed custody across an Account change', () => {
        it('opens accepted metadata and run inputs for review without saving or starting', async () => {
            const seedId = storeReviewedCopyFixture();
            const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new', reviewedRunSeedId: seedId }} />);
            expect(readBodyProps()?.draft.name).toBe('Accepted title');
            expect(readBodyProps()?.description).toBe('Accepted description');
            await act(async () => {
                readBodyProps()?.onChangeDescription?.('Edited description');
            });
            expect(readBodyProps()?.description).toBe('Edited description');
            expect(runStartSpy).not.toHaveBeenCalled();
            expect(definitionActions.create).not.toHaveBeenCalled();
            await act(async () => readBodyProps()?.onRunNow?.());
            expect(runComposerInput(screen).props.value).toBe('Private accepted input');
            expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
            expect(runStartSpy).not.toHaveBeenCalled();
        });

        it('offers reviewed-copy disclosures and Back to its source Run without writing', async () => {
            await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', reviewedRunSeedId: storeReviewedCopyFixture() }} />);
            expect(readBodyProps()).toHaveProperty('reviewNotice');
            act(() => readBodyProps()?.onBackToRun?.());
            expect(routerSpy.push).toHaveBeenLastCalledWith(createWorkflowRunRoute('run-1', 'server-a'));
            expect(runStartSpy).not.toHaveBeenCalled();
            expect(definitionActions.create).not.toHaveBeenCalled();
        });

        it('withdraws a reviewed Run copy instead of re-presenting it to the next Account', async () => {
            const { storeWorkflowReviewedRunSeed } = await import(
                '@/sync/domains/workflows/workflowReviewedRunSeed'
            );
            const seedId = storeWorkflowReviewedRunSeed({
                name: 'Account A reviewed run',
                definition: {
                    version: 1,
                    inputs: [],
                    defaults: {},
                    blocks: [{
                        kind: 'step', id: 'review',
                        document: { text: 'Account A private prompt', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    }],
                },
                project: { machineId: 'machine-1', directory: '/repo/project' },
                executionTarget: { kind: 'session' },
                inputs: {}, sourceRunId: 'run-1',
            });
            const screen = await renderScreen(
                <WorkflowEditorHostScreen source={{ kind: 'new', reviewedRunSeedId: seedId }} />,
            );
            await act(async () => {});
            expect(readBodyProps()?.draft).toMatchObject({ name: 'Account A reviewed run' });

            await act(async () => {
                switchEditorAccountScope({ serverId: 'server-a', accountId: 'account-b' });
            });

            expect(screen.findByTestId('workflow-editor-account-changed')).toBeTruthy();
            expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(0);
            await act(async () => {
                switchEditorAccountScope({ serverId: 'server-a', accountId: 'account-a' });
            });
            // Returning to the same identity is a replacement Account lifetime,
            // not permission to resurrect a previously withdrawn private copy.
            expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(0);
            await screen.unmount();
        });

        it('withdraws an already opened private draft when the same Account lifetime retires', async () => {
            const { buildWorkflowReviewedRunSeed, storeWorkflowReviewedRunSeed } = await import('@/sync/domains/workflows/workflowReviewedRunSeed');
            const { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
            const seedId = storeWorkflowReviewedRunSeed(buildWorkflowReviewedRunSeed({
                run: createWorkflowRunSummaryFixture(), definition: createWorkflowDefinitionFixture(),
                acceptedContext: {
                    startedBy: 'user',
                    source: { kind: 'inline' }, machineId: 'machine-1', origin: { kind: 'direct' },
                    inputs: {}, executionTarget: { kind: 'session' }, materializedLeaves: [], frozenChildren: {},
                    workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo/project', checkoutRootPath: '/repo/project' } },
                },
            }));
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', reviewedRunSeedId: seedId }} />);
            expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(1);
            const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            await act(async () => retireActiveServerAccountScopeLifetime());
            expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(0);
            await screen.unmount();
        });

    });

    /**
     * A different logical source is a different editor. Anything the previous
     * source collected — Run inputs, an open input sheet, a pending Run id, the
     * page-level Run as choice — and anything it started that has not resolved
     * must not surface in the next one.
     */
    describe('source-local state and slower publications', () => {
        it.each([
            ['new-session', 'render'], ['trigger', 'render'],
            ['new-session', 'readiness'], ['trigger', 'readiness'],
            ['new-session', 'retirement'], ['trigger', 'retirement'],
        ] as const)('keeps second %s seed custody correct after commit consumption and delayed %s', async (kind, publication) => {
            const { buildWorkflowEditorDraftFromDefinition } = await import('@/sync/domains/workflows/workflowAuthoring');
            const { storeNewSessionAutomationHandoffSeed, readNewSessionAutomationHandoffSeed } = await import('@/sync/domains/workflows/newSessionAutomationHandoffSeed');
            const { storeTriggerWorkflowSeed, readTriggerWorkflowSeed } = await import('../triggers/triggerWorkflowSeed');
            const { authoringComposerSeedFromSnapshot } = await import('@/components/sessions/authoring/authoringComposerCustody');
            const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            const makeSource = (text: string) => {
                const definition = createWorkflowDefinitionFixture({ defaults: {
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                }, blocks: [{ kind: 'step', id: 'prompt', document: { text, references: [], attachments: [] },
                    input: [], result: { kind: 'text' } }] });
                if (kind === 'trigger') {
                    const id = storeTriggerWorkflowSeed({ definition, retarget: { scope: 'account', automationId: TRIGGER_SET_ID,
                        triggerId: text, expectedRevision: 8 } });
                    return { source: { kind: 'new' as const, triggerWorkflowSeedId: id }, consumed: () => readTriggerWorkflowSeed(id) === null };
                }
                const draft = buildWorkflowEditorDraftFromDefinition({ draftId: `handoff-${text}`, name: text, definition });
                const id = storeNewSessionAutomationHandoffSeed({ name: text, description: text, enabled: true,
                    draft, project: null, triggers: [], composer: authoringComposerSeedFromSnapshot('prompt', {
                        text, references: [], attachments: [], selection: { start: text.length, end: text.length },
                    }) });
                return { source: { kind: 'new' as const, newSessionDraftSeedId: id }, consumed: () => readNewSessionAutomationHandoffSeed(id) === null };
            };
            const first = makeSource('FIRST');
            const editor = (source: ReturnType<typeof makeSource>['source']) => <React.StrictMode>
                <WorkflowEditorHostScreen source={source} />
            </React.StrictMode>;
            const screen = await renderRunEditor(editor(first.source));
            expect(first.consumed()).toBe(true);
            const second = makeSource('SECOND');
            await screen.update(editor(second.source));
            expect(second.consumed()).toBe(true);
            const acceptedId = readBodyProps()!.draft.draftId;
            const assertSecond = () => {
                expect(readBodyProps()!.draft).toMatchObject({ draftId: acceptedId, blocks: [{ document: { text: 'SECOND' } }] });
                expect(screen.findByType(AgentInput).props.value).toBe('SECOND');
            };
            assertSecond();
            await act(async () => readBodyProps()!.onChange({ ...readBodyProps()!.draft, name: 'Keep my second seed edit' }));
            const retainedInput = screen.findByType(AgentInput);
            // The route's next publication occurs after intake's passive effect,
            // not in the same act/render that first displays the replacement.
            vi.useFakeTimers();
            try {
                await act(async () => {
                    setTimeout(() => {
                        if (publication === 'retirement') retireActiveServerAccountScopeLifetime();
                        getStorage().setState(publication !== 'render'
                            ? { isSessionDraftsReady: false } : { workflowTriggerSetsById: {} });
                    }, 60_000);
                    await vi.advanceTimersByTimeAsync(61_000);
                });
                if (publication !== 'render') {
                    if (publication === 'retirement') {
                        // Retirement withdraws private content immediately.
                        // Address admission may settle before or after this
                        // publication; observe its terminal state after readiness.
                        expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(0);
                        await act(async () => getStorage().setState({ isSessionDraftsReady: true }));
                        expect(screen.findByTestId('workflow-editor-draft-unavailable')).not.toBeNull();
                    }
                    else {
                        expect(screen.findByTestId('session-drafts-hydrating')).toBeNull();
                        expect(screen.findByType(AgentInput)).toBe(retainedInput);
                        assertSecond();
                    }
                    await act(async () => getStorage().setState({ isSessionDraftsReady: true }));
                }
                await screen.update(editor({ ...second.source }));
                if (publication === 'retirement') {
                    // After a remount the handle is missing: it cannot prove why
                    // custody ended, and must not invent an Account-change claim.
                    expect(screen.findByTestId('workflow-editor-draft-unavailable')).not.toBeNull();
                    expect(screen.findByTestId('workflow-editor-account-changed')).toBeNull();
                    expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(0);
                    return;
                }
                assertSecond();
                await screen.update(editor({ ...second.source }));
                assertSecond();
                expect(readBodyProps()!.draft.name).toBe('Keep my second seed edit');
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not consume a seed from an abandoned editor render', async () => {
            const { storeTriggerWorkflowSeed, readTriggerWorkflowSeed } = await import('../triggers/triggerWorkflowSeed');
            const definition = createWorkflowDefinitionFixture();
            const seedId = storeTriggerWorkflowSeed({ definition,
                retarget: { scope: 'account', automationId: TRIGGER_SET_ID, triggerId: 'replayed', expectedRevision: 1 } });
            const pending = createDeferred<void>();
            function PendingSibling(): React.ReactNode { throw pending.promise; }
            const screen = await renderRunEditor(<React.Suspense fallback={<React.Fragment />}>
                <WorkflowEditorHostScreen source={{ kind: 'new', triggerWorkflowSeedId: seedId }} />
                <PendingSibling />
            </React.Suspense>);
            expect(readTriggerWorkflowSeed(seedId)).not.toBeNull();
            await screen.update(<WorkflowEditorHostScreen source={{ kind: 'new', triggerWorkflowSeedId: seedId }} />);
            expect(readBodyProps()!.draft.blocks).toEqual(definition.blocks);
            expect(readTriggerWorkflowSeed(seedId)).toBeNull();
        });

        it('starts fresh history when import opens a different review document', async () => {
            await serveMountedDraftActionHome();
            const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            const original = readBodyProps()!.draft;
            await act(async () => readBodyProps()!.onChange({ ...original, name: 'Previous document' }, 'Rename'));
            expect(readBodyProps()!.history?.undoLabel).toBe('Rename');
            workflowDocumentPicker.pick.mockResolvedValueOnce(JSON.stringify({ kind: 'happier.workflow', version: 1,
                definition: createWorkflowDefinitionFixture({ defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } }) }));
            await act(async () => readBodyProps()!.onImportJson?.());
            expect(readBodyProps()!.draft.draftId).not.toBe(original.draftId);
            expect(readBodyProps()!.history?.undoLabel).toBeNull();
            expect(readBodyProps()!.history?.redoLabel).toBeNull();
            await screen.unmount();
        });

        it('adopts a different reviewed Run seed as a different logical source on the same mount', async () => {
            const { storeWorkflowReviewedRunSeed } = await import(
                '@/sync/domains/workflows/workflowReviewedRunSeed'
            );
            const reviewedSeed = (name: string, prompt: string, machineId: string) => ({
                name,
                definition: {
                    version: 1 as const,
                    inputs: [],
                    defaults: {},
                    blocks: [{
                        kind: 'step' as const,
                        id: 'review',
                        document: { text: prompt, references: [], attachments: [] },
                        input: [],
                        result: { kind: 'text' as const },
                    }],
                },
                project: { machineId, directory: `/repo/${machineId}` },
                executionTarget: { kind: 'session' as const },
                inputs: {},
                sourceRunId: `run-${machineId}`,
                supersededRunId: `run-${machineId}`,
                reasonCode: 'workspace_missing',
            });
            const seedA = storeWorkflowReviewedRunSeed(reviewedSeed('Run A', 'Prompt A', 'machine-a'));
            const seedB = storeWorkflowReviewedRunSeed(reviewedSeed('Run B', 'Prompt B', 'machine-b'));
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(
                <WorkflowEditorHostScreen source={{ kind: 'new', reviewedRunSeedId: seedA }} />,
            );
            expect(readBodyProps()?.draft).toMatchObject({ name: 'Run A' });

            await screen.update(
                <WorkflowEditorHostScreen source={{ kind: 'new', reviewedRunSeedId: seedB }} />,
            );
            await act(async () => {});

            expect(readBodyProps()?.draft).toMatchObject({
                name: 'Run B',
                blocks: [expect.objectContaining({
                    document: expect.objectContaining({ text: 'Prompt B' }),
                })],
            });
            expect(readBodyProps()?.projectTarget).toEqual({
                machineId: 'machine-b',
                directory: '/repo/machine-b',
            });
            await screen.unmount();
        });

        it('resets a plain new draft before opening a newly requested import', async () => {
            const importSelection = createDeferred<string | null>();
            workflowDocumentPicker.pick.mockImplementationOnce(() => importSelection.promise);
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            const firstDraft = readBodyProps()?.draft;
            if (!firstDraft) throw new Error('Expected the first new Workflow draft');
            await act(async () => readBodyProps()?.onChange({ ...firstDraft, name: 'Unsaved source A' }));

            await screen.update(
                <WorkflowEditorHostScreen source={{ kind: 'new', requestImport: true }} />,
            );
            await act(async () => {});

            expect(workflowDocumentPicker.pick).toHaveBeenCalledTimes(1);
            expect(readBodyProps()?.draft).toMatchObject({ name: '' });
            expect(readBodyProps()?.draft?.draftId).not.toBe(firstDraft.draftId);

            importSelection.resolve(null);
            await act(async () => {});
            await screen.unmount();
        });

        it('resets collected Run inputs, the open composer and Run as when the source changes', async () => {
            definitionActions.get.mockResolvedValue({
                definitionId: 'definition-b',
                access: 'owner',
                revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Definition B' },
                definition: {
                    version: 1,
                    inputs: [],
                    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                    blocks: [{
                        kind: 'step', id: 'review',
                        document: { text: 'Review', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    }],
                },
            });
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            const draft = readBodyProps()?.draft;
            if (draft === undefined) throw new Error('Expected the new Workflow draft');

            await act(async () => readBodyProps()?.onChange({
                ...draft,
                inputs: [{ name: 'topic', valueType: 'string', required: true }],
            } as never));
            await act(async () => requireDefined(
                readBodyProps()?.onChangeExecutionTarget,
                'Expected an execution-target change handler',
            )('detached_run'));
            await act(async () => requireDefined(readBodyProps()?.onRunNow, 'Expected a Run now handler')());
            expect(screen.findByTestId('workflow-run-inputs-main')).not.toBeNull();
            await act(async () => invokeTestInstanceHandler(runComposerInput(screen), 'onChangeText', 'Source A input'));
            expect(runComposerInput(screen).props.value).toBe('Source A input');

            await screen.update(
                <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: 'definition-b' }} />,
            );
            await act(async () => {});

            // The composer that was collecting the previous workflow's inputs is
            // closed, and the page-level Run as choice is the new source's own.
            expect(screen.findByTestId('workflow-run-inputs-main')).toBeNull();
            expect(readBodyProps()?.executionTarget).toBe('session');
            expect(readBodyProps()?.draft).toMatchObject({ name: 'Definition B' });
            await act(async () => readBodyProps()?.onRunNow?.());
            expect(screen.findByTestId('workflow-run-inputs-main')).toBeNull();
            expect(screen.findByTestId('workflow-run-inputs-preview')).not.toBeNull();
            expect(runComposerInput(screen).props.value).not.toBe('Source A input');
            expect(runStartSpy).not.toHaveBeenCalled();
            await screen.unmount();
        });

        it('does not let a source-A save publish its revision into source B', async () => {
            const slowCreate = createDeferred<WorkflowDefinitionGetResultV1>();
            const definitionB = '00000000-0000-4000-8000-000000000006';
            definitionActions.create.mockImplementationOnce(() => slowCreate.promise);
            definitionActions.get.mockResolvedValue({
                definitionId: definitionB,
                access: 'owner',
                revision: { headerVersion: 9, bodyVersion: 9 },
                metadata: { title: 'Definition B' },
                definition: {
                    version: 1,
                    inputs: [],
                    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                    blocks: [{
                        kind: 'step', id: 'review',
                        document: { text: 'Review', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    }],
                },
            });
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            const draft = readBodyProps()?.draft;
            if (draft === undefined) throw new Error('Expected the new Workflow draft');
            await act(async () => readBodyProps()?.onChange({
                ...draft,
                name: 'Source A',
                defaults: {
                    ...draft.defaults,
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                },
                blocks: [{
                    kind: 'step',
                    id: 'analyze',
                    document: { text: 'Analyze the repository', references: [], attachments: [] },
                    input: [],
                    result: { kind: 'text' },
                }],
            } as never));
            await act(async () => readBodyProps()?.onSave?.());

            await screen.update(
                <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: definitionB }} />,
            );
            await act(async () => {});
            expect(readBodyProps()?.draft).toMatchObject({ name: 'Definition B' });

            slowCreate.resolve({
                definitionId: createdDefinitionId(),
                access: 'owner',
                revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Source A' },
                definition: createWorkflowDefinitionFixture(),
            });
            await act(async () => {});

            // Source B is showing its own hydrated revision, not the one source
            // A's save just created.
            // (A leaked save would have stamped B as "saved just now".)
            expect(readBodyProps()?.saveStatus).toEqual({ kind: 'saved', savedAtMs: null });
            await screen.unmount();
        });

        it('saves the definition first, then the trigger delta, and keeps the edits when the trigger write fails', async () => {
            initializePersonalWhereWriter();
            const order: string[] = [];
            definitionActions.create.mockImplementationOnce(async (request) => {
                order.push('definition');
                return { definitionId: SAVED_TRIGGER_WORKFLOW_ID, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 },
                    definition: WorkflowDefinitionV1Schema.parse(request.definition), metadata: request.metadata };
            });
            editorAutomations.respondWith(method => {
                if (method !== 'POST') return undefined;
                order.push('trigger');
                return Response.json({ error: 'target_unavailable' }, { status: 503 });
            });
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            const draft = readBodyProps()?.draft;
            if (draft === undefined) throw new Error('Expected the new Workflow draft');
            await act(async () => readBodyProps()?.onChange({
                ...draft,
                name: 'Nightly release',
                defaults: { ...draft.defaults, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                blocks: [{ kind: 'step', id: 'analyze', document: { text: 'Prepare the release', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
            } as never));
            // The first trigger's set runs on the editor's Where.
            await act(async () => readBodyProps()?.onChangeProjectTarget?.({ machineId: 'machine-1', directory: '/repo' } as never));
            // Adding a trigger edits the draft only: nothing is written yet.
            const section = readBodyProps()?.triggersSection as React.ReactElement<{ draft: unknown; onChangeDraft: (next: unknown) => void }>;
            const trigger = { kind: 'schedule', enabled: true, schedule: { kind: 'cron', scheduleExpr: '0 2 * * *', everyMs: null, timezone: 'UTC' } };
            await act(async () => section.props.onChangeDraft({ adds: [{ clientId: 'c1', trigger }], updates: {}, removes: [] }));
            expect(editorAutomations.creates).toHaveLength(0);
            expect((readBodyProps()?.triggersSection as React.ReactElement<{ draft: { adds: unknown[] } }>).props.draft.adds)
                .toEqual([{ clientId: 'c1', trigger }]);

            await saveWithTriggerConfirmation();

            expect(order).toEqual(['definition', 'trigger']);
            expect(editorAutomations.creates).toEqual([expect.objectContaining({ workflowDefinitionId: createdDefinitionId(),
                assignments: [{ machineId: 'machine-1', enabled: true }],
                executionRecipe: expect.objectContaining({ workflow: { t: 'plain', v: expect.objectContaining({ workspace: { directory: '/repo' } }) } }),
                triggers: [{ triggerId: expect.any(String), trigger }],
            })]);
            // "Workflow saved · Triggers not updated", with the pending trigger still in the draft.
            expect(readBodyProps()?.saveStatus).toEqual({ kind: 'failed', reason: 'workflows.triggers.editor.partialSave' });
            expect((readBodyProps()?.triggersSection as React.ReactElement<{ draft: { adds: unknown[] } }>).props.draft.adds).toHaveLength(1);
            // A partial write did not authorize Save's route continuation. Opening
            // that saved definition separately must hydrate its persisted content.
            definitionActions.get.mockResolvedValueOnce({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
                access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 },
                definition: createWorkflowDefinitionFixture({ defaults: {
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                } }), metadata: { title: 'Reopened saved definition' } });
            await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
            expect(readBodyProps()?.draft.name).toBe('Reopened saved definition');
            expect((readBodyProps()?.triggersSection as React.ReactElement<{ draft: { adds: unknown[] } }>).props.draft.adds).toHaveLength(0);
            await screen.unmount();
        });

        it('Save as workflow: source replacement retargets the new trigger and retains its partial-save retry', async () => {
            const { storeTriggerWorkflowSeed } = await import('../triggers/triggerWorkflowSeed');
            definitionActions.create.mockImplementation(async (request) => ({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
                access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, definition: WorkflowDefinitionV1Schema.parse(request.definition), metadata: request.metadata }));
            let rejectRetarget = true;
            editorAutomations.respondWith(method => method === 'PUT' && rejectRetarget
                ? Response.json({ error: 'version-conflict' }, { status: 409 }) : undefined);
            const definition = {
                version: 1, inputs: [],
                defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                blocks: [{ kind: 'step', id: 'digest', document: { text: 'Morning digest', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
            };
            editorAutomations.rows.set(TRIGGER_SET_ID, createWorkflowAutomationDetailFixture({ id: TRIGGER_SET_ID,
                revision: 8, triggerId: 'trigger-2', definition: WorkflowDefinitionV1Schema.parse(definition) }));
            const seedId = storeTriggerWorkflowSeed({
                definition: definition as never,
                retarget: { scope: 'account', automationId: TRIGGER_SET_ID, triggerId: 'trigger-1', expectedRevision: 3 },
            });
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', triggerWorkflowSeedId: seedId }} />);
            const replacementSeedId = storeTriggerWorkflowSeed({
                definition: WorkflowDefinitionV1Schema.parse(definition),
                retarget: { scope: 'account', automationId: TRIGGER_SET_ID, triggerId: 'trigger-2', expectedRevision: 8 },
            });
            await screen.update(<WorkflowEditorHostScreen source={{ kind: 'new', triggerWorkflowSeedId: replacementSeedId }} />);
            // The trigger's own steps open as the draft; nothing is written yet.
            expect(readBodyProps()?.draft.blocks[0]).toMatchObject({ id: 'digest' });
            expect(editorAutomations.reconciles).toHaveLength(0);
            const draft = readBodyProps()?.draft;
            if (draft === undefined) throw new Error('Expected the seeded draft');
            await act(async () => readBodyProps()?.onChange({ ...draft, name: 'Morning digest' } as never));

            await saveWithTriggerConfirmation();
            expect(editorAutomations.reconciles).toEqual([{ automationId: TRIGGER_SET_ID, input: expect.objectContaining({
                expectedTemplateVersion: 8, workflowDefinitionId: createdDefinitionId(),
                triggers: [{ kind: 'existing', triggerId: 'trigger-2', expectedRevision: 1 }], removedTriggers: [],
            }) }]);
            // "Workflow saved · Trigger not updated": the trigger keeps its own steps until it lands.
            expect(readBodyProps()?.saveStatus).toEqual({ kind: 'failed', reason: 'workflows.triggers.editor.retargetFailed' });

            // Try again: Save retries the retarget, which now lands.
            definitionActions.update.mockImplementationOnce(async (request) => ({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
                access: 'owner', revision: { headerVersion: 1, bodyVersion: 2 }, definition: WorkflowDefinitionV1Schema.parse(request.definition), metadata: request.metadata }));
            rejectRetarget = false;
            await saveWithTriggerConfirmation();
            expect(editorAutomations.reconciles).toHaveLength(2);
            expect(editorAutomations.rows.get(TRIGGER_SET_ID)?.workflowDefinitionId).toBe(createdDefinitionId());
            expect(readBodyProps()?.saveStatus?.kind).not.toBe('failed');
            await screen.unmount();
        });

        /**
         * Leaving the editor is the same question as changing its source.
         *
         * The Run really is admitted — the person asked for it — but taking over
         * whatever page they are on now with this editor's navigation is not
         * this call's decision, exactly as it is not when the source changed
         * underneath it.
         */
        it('does not let a Run admitted before the editor closed navigate afterwards', async () => {
            await prepareRunAdmissionFixture();
            const admission = createDeferred<WorkflowRunStartResultV1>();
            runStartSpy.mockImplementationOnce(() => admission.promise);
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            const draft = readBodyProps()?.draft;
            if (draft === undefined) throw new Error('Expected the new Workflow draft');
            await act(async () => readBodyProps()?.onChange({
                ...draft,
                name: 'Review',
                defaults: {
                    ...draft.defaults,
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                },
                blocks: [{
                    kind: 'step',
                    id: 'analyze',
                    document: { text: 'Analyze the repository', references: [], attachments: [] },
                    input: [],
                    result: { kind: 'text' },
                }],
            }));
            await act(async () => requireDefined(
                readBodyProps()?.onChangeProjectTarget,
                'Expected a project-target change handler',
            )({
                machineId: 'machine-1',
                directory: '/Users/me/project',
            }));
            await act(async () => requireDefined(readBodyProps()?.onRunNow, 'Expected a Run now handler')());
            expect(runStartSpy).not.toHaveBeenCalled();
            expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled,
                screen.findByTestId('workflow-run-inputs-run')?.props.accessibilityHint).toBe(false);
            await pressRunStart(screen);
            expect(runStartSpy).toHaveBeenCalledTimes(1);

            await screen.unmount();

            admission.resolve({ admission: 'created', run: createWorkflowRunSummaryFixture({ id: 'admitted-after-close', origin: { kind: 'direct' } }) });
            await act(async () => {});

            expect(routerSpy.push).not.toHaveBeenCalled();
        });
    });

    /**
     * The editor body owns this page's one scroll, because the pinned command
     * surface has to stay on screen while the document scrolls beneath it. The
     * host must not wrap it in a second scroll owner.
     */
    it('adds no second scroll owner around the body that owns the page scroll', async () => {
        const { KeyboardAwareScrollView } = await import('@/components/ui/keyboardAvoidance/KeyboardAwareScrollView');
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);

        const body = screen.findByType(WorkflowEditorBody);
        const pageScrolls = screen.findAllByType(KeyboardAwareScrollView);
        expect(pageScrolls).toHaveLength(1);
        expect(body.findAllByType(KeyboardAwareScrollView)).toEqual(pageScrolls);
    });

    it('keeps the editor mounted while the composer collects Run inputs', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const initialDraft = readBodyProps()?.draft;
        expect(initialDraft).toBeDefined();
        if (initialDraft === undefined) throw new Error('Expected the new Workflow draft');

        await act(async () => readBodyProps()?.onChange({
            ...initialDraft,
            inputs: [{ name: 'topic', valueType: 'string', required: true }],
        }));
        await act(async () => requireDefined(readBodyProps()?.onRunNow, 'Expected a Run now handler')());

        expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(1);
        expect(screen.findByTestId('workflow-run-inputs-main')).not.toBeNull();
        expect(runStartSpy).not.toHaveBeenCalled();
        await act(async () => invokeTestInstanceHandler(runComposerInput(screen), 'onChangeText', 'Unsubmitted topic'));
        await dismissRunComposer(screen);
        expect(screen.findByTestId('workflow-run-inputs-main')).toBeNull();
        expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(1);
        expect(readBodyProps()?.draft.draftId).toBe(initialDraft.draftId);
        await act(async () => readBodyProps()?.onRunNow?.());
        expect(runComposerInput(screen).props.value).toBe('Unsubmitted topic');
        expect(runStartSpy).not.toHaveBeenCalled();
    });

    it('owns Run as at page scope and carries the selected target into admission', async () => {
        await prepareRunAdmissionFixture();
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        expect(readBodyProps()?.executionTarget).toBe('session');
        expect(readBodyProps()?.runAsTargets).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'session', available: true }),
            expect.objectContaining({ kind: 'detached_run', available: false }),
        ]));

        const draft = readBodyProps()?.draft;
        if (draft === undefined) throw new Error('Expected the new Workflow draft');
        await act(async () => readBodyProps()?.onChange({
            ...draft,
            name: 'Review',
            defaults: {
                ...draft.defaults,
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            },
            blocks: [{
                kind: 'step',
                id: 'analyze',
                document: { text: 'Analyze the repository', references: [], attachments: [] },
                input: [],
                result: { kind: 'text' },
            }],
        }));
        await act(async () => requireDefined(
            readBodyProps()?.onChangeProjectTarget,
            'Expected a project-target change handler',
        )({
            machineId: 'machine-1',
            directory: '/Users/me/project',
        }));
        await act(async () => requireDefined(
            readBodyProps()?.onChangeExecutionTarget,
            'Expected an execution-target change handler',
        )('session'));
        await act(async () => requireDefined(readBodyProps()?.onRunNow, 'Expected a Run now handler')());

        expect(runStartSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled,
            screen.findByTestId('workflow-run-inputs-run')?.props.accessibilityHint).toBe(false);
        await pressRunStart(screen);
        expect(runStartSpy).toHaveBeenCalledTimes(1);
        // Session is the canonical default; the controller omits it on the wire.
        expect(runStartSpy.mock.calls[0]?.[0].executionTarget).toBeUndefined();
        expect(runStartSpy.mock.calls[0]?.[1]).toMatchObject({ externalActionTarget: {
            kind: 'machine', machineId: 'machine-1', project: { directory: '/Users/me/project' },
        } });
    });

    /**
     * UX §2.2 J1: one prompt is a workflow and Run now needs no name. The
     * admission metadata title is `min(1)` at the Protocol owner, so an
     * unnamed draft admits with no metadata at all — an empty title would be
     * refused after the page had already said Run now could proceed.
     */
    it('admits an unnamed draft without a title, and a named draft with exactly its trimmed title', async () => {
        await prepareRunAdmissionFixture();
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const draft = readBodyProps()?.draft;
        if (draft === undefined) throw new Error('Expected the new Workflow draft');
        const authored = {
            ...draft,
            defaults: {
                ...draft.defaults,
                agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            },
            blocks: [{
                kind: 'step' as const,
                id: 'analyze',
                document: { text: 'Analyze the repository', references: [], attachments: [] },
                input: [],
                result: { kind: 'text' as const },
            }],
        };
        await act(async () => readBodyProps()?.onChange({ ...authored, name: '   ' }));
        await act(async () => requireDefined(
            readBodyProps()?.onChangeProjectTarget,
            'Expected a project-target change handler',
        )({
            machineId: 'machine-1',
            directory: '/Users/me/project',
        }));
        await act(async () => requireDefined(readBodyProps()?.onRunNow, 'Expected a Run now handler')());
        expect(runStartSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled,
            screen.findByTestId('workflow-run-inputs-run')?.props.accessibilityHint).toBe(false);
        await pressRunStart(screen);
        expect(runStartSpy).toHaveBeenCalledTimes(1);
        expect(runStartSpy.mock.calls[0]?.[0]).not.toHaveProperty('metadata');

        await act(async () => readBodyProps()?.onChange({ ...authored, name: '  Review  ' }));
        await act(async () => requireDefined(readBodyProps()?.onRunNow, 'Expected a Run now handler')());
        await pressRunStart(screen);
        expect(runStartSpy).toHaveBeenCalledTimes(2);
        expect(runStartSpy.mock.calls[1]?.[0]).toMatchObject({ metadata: { title: 'Review' } });
    });

    /**
     * A read that failed is not proof the workflow was deleted, and a blank page
     * is not an explanation. The neutral host states what happened and offers
     * the read again.
     */
    it('states a failed hydration with a retry rather than a blank page', async () => {
        refuseArtifactRead = true;
        definitionActions.get.mockResolvedValueOnce({
                definitionId: SAVED_TRIGGER_WORKFLOW_ID,
                access: 'owner',
                revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Recovered workflow' },
                definition: {
                    version: 1,
                    inputs: [],
                    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                    blocks: [{
                        kind: 'step', id: 'review',
                        document: { text: 'Review', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    }],
                },
            });
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(
            <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />,
        );
        await act(async () => {});

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.findByTestId('workflow-editor-error')).not.toBeNull();
        });
        expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(0);
        // This HTTP failure may throw at the transport boundary before the
        // Action returns an envelope. Assert the recoverable read outcome.
        expect(screen.findByTestId('workflow-editor-error-action')).not.toBeNull();
        expect(definitionActions.get).not.toHaveBeenCalled();
        expect(artifactReads).toEqual([SAVED_TRIGGER_WORKFLOW_ID]);

        refuseArtifactRead = false;
        await screen.pressByTestIdAsync('workflow-editor-error-action');
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readBodyProps()?.draft.name).toBe('Recovered workflow');
        });

        expect(artifactReads).toEqual([SAVED_TRIGGER_WORKFLOW_ID, SAVED_TRIGGER_WORKFLOW_ID]);
        expect(definitionActions.get).toHaveBeenCalledOnce();
        expect(readBodyProps()?.draft).toMatchObject({ name: 'Recovered workflow' });
    });

    it('offers Share for a saved workflow, opening the one document share sheet with its Artifact', async () => {
        definitionActions.get.mockResolvedValueOnce({
            definitionId: 'shared-definition-id',
            access: 'owner',
            revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title: 'Nightly review' },
            definition: {
                version: 1, inputs: [], defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                blocks: [{ kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
            },
        } satisfies WorkflowDefinitionGetResultV1);
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: 'shared-definition-id' }} />);
        await act(async () => {});

        const ids = (readBodyProps()?.menuActions ?? []).map((action) => action.id);
        expect(ids.indexOf('share')).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf('share')).toBeLessThan(ids.indexOf('export'));

        const modalCount = visibleModals().length;
        await act(async () => { readBodyProps()?.menuActions?.find((action) => action.id === 'share')?.onSelect(); });
        expect(visibleModals()).toHaveLength(modalCount + 1);
        expect(readCustomModal('document-share-modal')).toMatchObject({
            props: { kind: 'workflow-definition.v1', artifactId: 'shared-definition-id', linkPath: '/workflows/shared-definition-id' },
            chrome: { testID: 'document-share-modal' },
        });
        // "Send a copy instead" is the editor's existing JSON export.
        expect(typeof readCustomModal('document-share-modal')?.props?.onSendCopy).toBe('function');
    });

    it('offers no Share for a draft that has never been saved', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        await act(async () => {});
        expect((readBodyProps()?.menuActions ?? []).some((action) => action.id === 'share')).toBe(false);
    });

    it('retires a saved private draft immediately and refetches it on Account switch', async () => {
        const accountB = createDeferred<WorkflowDefinitionGetResultV1>();
        const definitionId = '00000000-0000-4000-8000-000000000006';
        const definition = (text: string): WorkflowDefinitionGetResultV1 => ({
            definitionId,
            access: 'owner',
            revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title: text },
            definition: {
                version: 1,
                inputs: [],
                defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                blocks: [{
                    kind: 'step', id: 'review',
                    document: { text, references: [], attachments: [] },
                    input: [], result: { kind: 'text' },
                }],
            },
        });
        definitionActions.get
            .mockResolvedValueOnce(definition('Account A private prompt'))
            .mockImplementationOnce(() => accountB.promise);
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId }} />);
        await act(async () => {});
        expect(readBodyProps()?.draft).toMatchObject({ name: 'Account A private prompt' });

        await act(async () => {
            switchEditorAccountScope({ serverId: 'server-a', accountId: 'account-b' });
        });
        expect(screen.findByTestId('workflow-editor-loading')).toBeTruthy();
        expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(0);
        expect(definitionActions.get).toHaveBeenCalledTimes(2);

        accountB.resolve(definition('Account B private prompt'));
        await act(async () => {});
        expect(readBodyProps()?.draft).toMatchObject({ name: 'Account B private prompt' });
    });
});

/** Dismisses the Run now composer the way a person does: through its presenter (outside press, Escape). */
async function dismissRunComposer(screen: Readonly<{ findAll: (predicate: (node: import('react-test-renderer').ReactTestInstance) => boolean) => import('react-test-renderer').ReactTestInstance[] }>) {
    const presenter = screen.findAll((node) => typeof node.props.onRequestClose === 'function'
        && node.findAll((child) => child.props.testID === 'workflow-run-inputs').length > 0).at(-1);
    await act(async () => { invokeTestInstanceHandler(presenter, 'onRequestClose', undefined, 'Run composer presenter'); });
}

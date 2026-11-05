import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { Alert, View } from 'react-native';
import { invokeTestInstanceHandler, renderScreen as renderTestScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture as createRunFixture, createWorkflowInvocationIndexFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { buildWorkflowReviewedRunSeed, storeWorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { teamSummaryFixture, teamCapabilitiesFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getActionSpec, ActionIdSchema, StrictJsonValueSchema, WorkflowRunStartRequestV1Schema, WorkflowRunRecipientCensusResponseV1Schema,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1, WorkflowProgressEnvelopeV1Schema,
    type WorkflowRunGetResultV1, type WorkflowInvocationDetailV1 } from '@happier-dev/protocol';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';

const runStart = vi.fn<(request: ReturnType<typeof WorkflowRunStartRequestV1Schema.parse>) => Promise<unknown>>();
let runFailure: Readonly<{ errorCode: string; error: string }> | null = null;
const runBoundaries = new Map<string, Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>>>();
const viewport = vi.hoisted(() => ({ width: 1280 }));
const appliedHome = vi.hoisted(() => ({ serverId: 'server-a', serverUrl: 'https://server-a.example', generation: 0 }));
const routeBoundary = vi.hoisted(() => ({ params: {} as Record<string, string>, platform: 'ios', credentials: null as { token: string } | null }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        Platform: { get OS() { return routeBoundary.platform; }, select: (values: Record<string, unknown>) => values[routeBoundary.platform] ?? values.default },
        useWindowDimensions: () => ({ width: viewport.width, height: 844, scale: 1, fontScale: 1 }),
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Expo navigation is a platform boundary; Account, auth, workspace state and guards stay real.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/workflows/new', params: () => routeBoundary.params }).module;
});
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
// Install genuine network leaves before these real owners bind their scoped transport.
const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
const { WorkflowBuiltinEditorHostScreen } = await import('./WorkflowCatalogEditorHostScreen');
const { AgentInputChipPickerPanel } = await import('@/components/sessions/agentInput/components/AgentInputChipPickerPanel');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { AgentInput } = await import('@/components/sessions/agentInput');
const { SessionAuthoringControls } = await import('@/components/sessions/authoring/controls/SessionAuthoringControls');
const { WorkflowTriggerSection } = await import('../triggers/WorkflowTriggerSection');
const { editWorkflowTriggerDraft } = await import('../triggers/workflowTriggerDraft');
const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { WorkspaceRouteEntry } = await import('@/components/appShell/workspace/createWorkspaceRouteEntry');
const { useDestinationParams } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { SplitCanvasLeafFrame } = await import('@/components/appShell/splitCanvas/components/SplitCanvasLeafFrame');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { clearActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { ModalProvider } = await import('@/modal');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { createWorkflowDefinition, updateWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
const storageRoute = '/v3/automations/runs/workflow-storage';
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

function createWorkflowRunSummaryFixture(overrides: Parameters<typeof createRunFixture>[0] = {}) {
    return createRunFixture({ ownerAccountId: 'account-a', ...overrides });
}

function runKeyCensus(runId: string) {
    return WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: 'account-a',
        access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null,
        recipients: [], visibleTeamId: null, ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
}

function renderScreen(element: React.ReactElement, options: Parameters<typeof renderTestScreen>[1] = {}) {
    const Wrapper = options.wrapper;
    return renderTestScreen(element, { ...options, wrapper: ({ children }) => (
        <AuthProvider initialCredentials={routeBoundary.credentials}><ModalProvider>
            {Wrapper ? <Wrapper>{children}</Wrapper> : children}
        </ModalProvider></AuthProvider>
    ) });
}

function startRequests() {
    return runStart.mock.calls.map(([request]) => request);
}

async function addComposerHome(name: string, serverUrl: string) {
    const serverIdentityId = `srv_composer-${new URL(serverUrl).hostname.replaceAll('.', '-')}`;
    const id = await home.addHome({ name, serverUrl, accountId: 'account-a', serverIdentityId,
        credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) } });
    runBoundaries.set(new URL(serverUrl).origin, await createExternalActionAccountHttpBoundary({
        serverUrl, serverIdentityId, accountId: 'account-a', machineId: 'machine-1', tokenEpoch: 0,
        actionId: 'workflow.run.start', execute: raw => runStart(WorkflowRunStartRequestV1Schema.parse(raw)),
        failure: () => runFailure,
    }));
    if (accountConnection) {
        await (await import('@/sync/runtime/orchestration/connectionManager')).switchConnectionToActiveServer();
        await (await import('@/sync/sync')).sync.awaitBootstrapForegroundAcquisition();
        await waitForHomeGovernance(() => expect(getStorage().getState().isDataReady).toBe(true));
    }
    return { id, serverIdentityId };
}

function definitionWrites() {
    return home.requests.filter(request => request.path.startsWith('/v1/artifacts') && request.input !== null);
}

function automationWrites() {
    return home.requests.filter(request => request.path.startsWith('/v3/automations') && request.path !== storageRoute && request.input !== null);
}

function expectNoWorkflowWrites() {
    expect(definitionWrites()).toEqual([]);
    expect(automationWrites()).toEqual([]);
    expect(startRequests()).toEqual([]);
}

function savedAgentDefinition() {
    return createWorkflowDefinitionFixture({ defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    } });
}

async function seedSavedDefinition(definitionId: string, definition = savedAgentDefinition(),
    title = 'Saved draft', access: 'owner' | 'view' | 'edit' | 'admin' = 'owner') {
    let value = await createWorkflowDefinition({ definitionId, definition, metadata: { title } });
    for (let revision = 1; revision < 3; revision++) {
        value = await updateWorkflowDefinition({ definitionId, definition, metadata: { title }, expectedRevision: value.revision });
    }
    const row = home.artifacts(appliedHome.serverId).read(definitionId);
    if (!row) throw new Error('Missing produced saved definition');
    if (access !== 'owner') home.answer(appliedHome.serverId, `/v1/artifacts/${definitionId}`, { body: { ...row, access } });
    home.requests.splice(0);
    return row;
}

async function acceptedStorage(detail: WorkflowRunGetResultV1) {
    if (!detail.definition || !detail.acceptedContext) throw new Error('Fixture requires accepted content');
    const run = detail.run;
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: detail.authoredDefinition ?? detail.definition,
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
            readActionContract: async actionId => {
                const spec = getActionSpec(ActionIdSchema.parse(actionId));
                if (!spec.outputSchema) throw new Error('Accepted Action requires its canonical result contract');
                return {
                    inputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' })),
                    outputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(spec.outputSchema, { target: 'draft-7' })),
                };
            } },
        ingressContext: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        roleSelection: { defaultEngine: { agentTargetKey: 'agent:happier.agent.claude/claude' } },
        context: { ...detail.acceptedContext, authorization: { principal: { kind: 'host' } } } });
    if (!accepted.ok) throw new Error(`Fixture materialization failed: ${JSON.stringify(accepted.error)}`);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: run.ownerAccountId, runId: run.id }, acceptedSnapshot: accepted.snapshot }));
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: run.ownerAccountId,
        access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null,
        recipients: [], visibleTeamId: run.visibleTeamId, ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    return { run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null, keyCensus };
}

function storedProgress(detail: WorkflowInvocationDetailV1, accountId: string) {
    const index = detail.index;
    return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId: index.runId, recordId: index.id,
            sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt },
        progress: WorkflowProgressEnvelopeV1Schema.parse(detail.progress) }));
}

describe('editor workflow composer', () => {
    it.each([
        { kind: 'new-session', admission: 'readiness' }, { kind: 'trigger', admission: 'readiness' },
        { kind: 'new-session', admission: 'shell' }, { kind: 'trigger', admission: 'shell' },
        { kind: 'new-session', admission: 'remote' }, { kind: 'trigger', admission: 'remote' },
        { kind: 'new-session', admission: 'route' }, { kind: 'trigger', admission: 'route' },
    ] as const)('retains the second pinned $kind handoff through $admission admission and readiness settlement', async ({ kind, admission }) => {
        const { storeNewSessionAutomationHandoffSeed, readNewSessionAutomationHandoffSeed } = await import('@/sync/domains/workflows/newSessionAutomationHandoffSeed');
        const { storeTriggerWorkflowSeed, readTriggerWorkflowSeed } = await import('../triggers/triggerWorkflowSeed');
        const { buildWorkflowEditorDraftFromDefinition } = await import('@/sync/domains/workflows/workflowAuthoring');
        const { authoringComposerSeedFromSnapshot } = await import('@/components/sessions/authoring/authoringComposerCustody');
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
        const { useWorkspacePresentation } = await import('@/components/appShell/workspace/useWorkspaceShellEnabled');
        const { beginOnboardingJourneySession, endOnboardingJourneySession } = await import('@/components/onboarding/tour/state/journeySession');
        const { workspaceLayoutScopeKey, serializeWorkspaceLayout } = await import('@/components/appShell/workspace/workspacePersistence');
        const param = kind === 'new-session' ? 'newSessionDraftSeedId' : 'triggerWorkflowSeedId';
        const seed = (text: string) => {
            const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'step', id: 'prompt',
                document: { text, references: [], attachments: [] }, input: [], result: { kind: 'text' } }] });
            return kind === 'new-session'
                ? storeNewSessionAutomationHandoffSeed({ name: text, description: null, enabled: true,
                    draft: buildWorkflowEditorDraftFromDefinition({ draftId: `workspace-${text}`, name: text, definition }), project: null, triggers: [],
                    composer: authoringComposerSeedFromSnapshot('prompt', { text, references: [], attachments: [] }) })
                : storeTriggerWorkflowSeed({ definition, retarget: { scope: 'account', automationId: '00000000-0000-4000-8000-000000000294',
                    triggerId: 'trigger', expectedRevision: 1 } });
        };
        if (admission === 'remote') {
            appliedHome.serverUrl = 'https://workspace-peer.test';
            appliedHome.serverId = (await addComposerHome('Workspace peer', appliedHome.serverUrl)).id;
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const token = home.findByServerUrl(appliedHome.serverUrl)?.token;
            if (!token) throw new Error('Missing synthetic Account credential');
            routeBoundary.credentials = { token };
            const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'account-a' };
            getStorage().setState({ profileScope: scope, settingsScope: scope });
        }
        const first = seed('FIRST');
        routeBoundary.params = { [param]: first };
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { workflows: true, inbox: false, friends: false, externalSessions: false } });
        const { resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
        const target = resolveDestinationRefFromHref(catalog, `/workflows/new?${param}=${first}`);
        if (!target) throw new Error('Workflow seed route was not admitted');
        const pinned = { id: 'pinned-editor', target, pinned: true, preview: false };
        let remoteRecord: import('@/components/appShell/workspace/workspaceSyncedTabs').SharedWorkspaceTabs = {
            v: 1, order: [pinned.id], tabsById: { [pinned.id]: pinned }, pairs: [],
        };
        let remoteVersion = 1;
        let kvWrites = 0;
        if (admission === 'remote') {
            const { encodeBase64StoredJsonContentEnvelope, decodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
            home.answer(appliedHome.serverId, '/v1/account/encryption/currentness', { body: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            } });
            home.answer(appliedHome.serverId, 'GET /v1/kv/workspace%3Atabs%3Av1', { select: () => ({ body: {
                key: 'workspace:tabs:v1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: remoteRecord }), version: remoteVersion,
            } }) });
            home.answer(appliedHome.serverId, 'POST /v1/kv', { select: input => {
                const parsed = (input as { mutations: { key: string; value: string }[] }).mutations[0];
                const opened = decodeBase64StoredJsonContentEnvelope(parsed.value);
                if (parsed.key !== 'workspace:tabs:v1' || opened?.t !== 'plain') throw new Error('Unexpected KV fixture write');
                remoteRecord = opened.v as typeof remoteRecord;
                kvWrites++;
                return { body: { success: true, results: [{ key: parsed.key, version: ++remoteVersion }] } };
            } });
        }
        if (admission === 'shell' || admission === 'route') {
            if (admission === 'shell') beginOnboardingJourneySession();
            routeBoundary.platform = 'web';
            const url = new URL(admission === 'route' ? '/new' : `/workflows/new?${param}=${first}`, 'https://happier.invalid');
            const location = { pathname: url.pathname, search: url.search, hash: '' };
            const history = { state: null as unknown,
                replaceState: (state: unknown, _unused: string, href?: string | URL | null) => {
                    history.state = state;
                    if (!href) return;
                    const next = new URL(href, 'https://happier.invalid');
                    location.pathname = next.pathname; location.search = next.search; location.hash = next.hash;
                },
                pushState: (state: unknown, unused: string, href: string) => history.replaceState(state, unused, href), go: () => {},
            };
            const events = new EventTarget();
            vi.stubGlobal('window', { location, history, sessionStorage: { getItem: () => 'main' },
                addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
                dispatchEvent: events.dispatchEvent.bind(events) });
        }
        const scopeKey = workspaceLayoutScopeKey({ serverId: getActiveServerSnapshot().serverId, accountId: 'account-a', windowId: 'main' });
        getStorage().setState({ isDataReady: admission === 'shell', localSettings: { ...getStorage().getState().localSettings,
            workspaceLayoutV1: { [scopeKey]: serializeWorkspaceLayout(createWorkspaceState(pinned)) } } });
        let workspace: WorkspaceNavigationContextValue | undefined;
        function Body() {
            const params = useDestinationParams<Record<string, string>>();
            return <WorkflowEditorHostScreen source={{ kind: 'new', [param]: params[param] }} />;
        }
        let openExpoEntry: (() => void) | undefined;
        function ExpoScene() {
            const [open, setOpen] = React.useState(admission !== 'route');
            openExpoEntry = () => setOpen(true);
            return open ? <WorkspaceRouteEntry Body={Body} /> : null;
        }
        function Host() {
            const presentation = useWorkspacePresentation();
            return <AppPaneProvider><WorkspaceProvider enabled={admission !== 'shell' || presentation === 'shell'}
                deferred={presentation === 'deferred'} catalog={catalog}>{navigation => {
            workspace = navigation;
            return <>
                <ExpoScene />
                {navigation.active ? Object.values(navigation.state.tabs).filter(tab => tab.target.params[param]).map(tab => <DestinationInstanceHost key={tab.id}
                    tabId={tab.id} ref={tab.target} pathname="/workflows/new" focused visible navigation={navigation.navigationForTab(tab.id)}>
                    <WorkspaceRouteEntry Body={Body} />
                </DestinationInstanceHost>) : null}
            </>;
            }}</WorkspaceProvider></AppPaneProvider>;
        }
        const screen = await renderScreen(<Host />);
        if (admission === 'route') {
            // Expo can commit its new scene before its browser-history mirror.
            // The parent still projects the preceding unhosted /new location.
            expect(workspace?.ownsRoute).toBe(false);
            await act(async () => openExpoEntry?.());
        }
        // Cold restoration must not lend seed custody to a temporary Expo body.
        expect(screen.root.findAllByType(WorkflowEditorBody)).toHaveLength(0);
        expect(kind === 'new-session' ? readNewSessionAutomationHandoffSeed(first) : readTriggerWorkflowSeed(first)).not.toBeNull();
        await act(async () => {
            if (admission === 'route') window.history.pushState({}, '', `/workflows/new?${param}=${first}`);
            endOnboardingJourneySession();
            getStorage().setState({ isDataReady: true });
        });
        expect(screen.root.findByType(AgentInput).props.value).toBe('FIRST');
        expect(workspace?.state.tabs['pinned-editor'].pinned).toBe(true);
        if (admission === 'remote') await vi.waitFor(() => expect(workspace?.tabSyncStatus).toBe('synced'));
        const second = seed('SECOND');
        await act(async () => {
            workspace?.navigationForTab('pinned-editor').setParams?.({ [param]: second });
            // The Expo boundary mirrors the URL committed by the real workspace
            // adapter; settlement must not feed it the superseded FIRST route.
            routeBoundary.params = { [param]: second };
        });
        const input = screen.root.findByType(AgentInput);
        expect(input.props.value).toBe('SECOND');
        expect(kind === 'new-session' ? readNewSessionAutomationHandoffSeed(second) : readTriggerWorkflowSeed(second)).toBeNull();
        await act(async () => {
            const body = screen.root.findByType(WorkflowEditorBody);
            body.props.onChange({ ...body.props.draft, name: 'Keep my workspace edit' });
        });
        const draftId = screen.root.findByType(WorkflowEditorBody).props.draft.draftId;
        if (admission === 'remote') {
            // Finish this client's accepted handoff write before delivering the
            // peer's later navigation; otherwise its pending intent masks F2.
            await vi.waitFor(() => expect(kvWrites).toBeGreaterThan(0));
            const writesBeforeImport = kvWrites;
            const { dispatchKvBatchUpdate } = await import('@/sync/engine/socket/kvUpdateDispatcher');
            const peerTarget = { kind: 'workflows', params: { workspacePathname: '/workflows/new', [param]: 'peer-only-consumed-seed' } };
            for (const peerId of ['pinned-editor', 'peer-singleton']) {
                remoteRecord = { v: 1, order: [peerId], pairs: [], tabsById: {
                    [peerId]: { id: peerId, target: peerTarget, pinned: true },
                } };
                remoteVersion++;
                await act(async () => dispatchKvBatchUpdate({ kvUpdate: { changes: [{ key: 'workspace:tabs:v1', value: null, version: remoteVersion }] },
                    credentials: routeBoundary.credentials!, shouldContinue: () => true, applyTodoSocketUpdates: async () => {},
                    invalidateTodosSync: () => {}, log: { log: () => {} } }));
                await vi.waitFor(() => expect(workspace?.sharedTabs?.order).toEqual([peerId]));
                expect(screen.root.findByType(AgentInput)).toBe(input);
                expect(workspace?.state.groups['group:1'].activeTabId).toBe('pinned-editor');
                expect(workspace?.state.tabs['pinned-editor'].target.params[param]).toBe(second);
                expect(input.props.value).toBe('SECOND');
                expect(screen.root.findByType(WorkflowEditorBody).props.draft).toMatchObject({ draftId, name: 'Keep my workspace edit' });
            }
            expect(kvWrites).toBe(writesBeforeImport);
        }
        // A late persisted-layout publication must not replace an admitted editor.
        await act(async () => getStorage().setState({ localSettings: { ...getStorage().getState().localSettings,
            workspaceLayoutV1: { [scopeKey]: serializeWorkspaceLayout(createWorkspaceState(pinned)) } } }));
        expect(screen.root.findByType(AgentInput)).toBe(input);
        expect(input.props.value).toBe('SECOND');
        const lifetime = captureActiveServerAccountScopeLifetime();
        await act(async () => getStorage().setState({ isDataReady: false }));
        expect(captureActiveServerAccountScopeLifetime()).toBe(lifetime);
        expect(lifetime?.isCurrent()).toBe(true);
        expect(screen.root.findByType(AgentInput)).toBe(input);
        await act(async () => getStorage().setState({ isDataReady: true }));
        expect(screen.root.findByType(AgentInput)).toBe(input);
        expect(input.props.value).toBe('SECOND');
        expect(screen.root.findByType(WorkflowEditorBody).props.draft).toMatchObject({ draftId, name: 'Keep my workspace edit' });
        await screen.unmount();
    });

    it.each([
        ['new-session', 'first hydration'], ['trigger', 'first hydration'],
        ['new-session', 'refresh'], ['trigger', 'refresh'],
    ] as const)('retains adopted %s bytes and edits when real repository %s completes', async (kind, phase) => {
        const { createDeferred } = await import('@/dev/testkit');
        const repository = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { canonicalSessionDraftAddressV2, createSessionDraftPrivatePayloadV2 } = await import('@happier-dev/protocol');
        const { storeNewSessionAutomationHandoffSeed, readNewSessionAutomationHandoffSeed } = await import('@/sync/domains/workflows/newSessionAutomationHandoffSeed');
        const { storeTriggerWorkflowSeed, readTriggerWorkflowSeed } = await import('../triggers/triggerWorkflowSeed');
        const { buildWorkflowEditorDraftFromDefinition } = await import('@/sync/domains/workflows/workflowAuthoring');
        const { authoringComposerSeedFromSnapshot } = await import('@/components/sessions/authoring/authoringComposerCustody');
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        const scope = { serverId: appliedHome.serverId, accountId: 'account-a' };
        const address = { kind: 'newSession' as const, draftId: '00000000-0000-4000-8000-000000000292' };
        const records = new Map<string, import('@happier-dev/protocol').SessionDraftRecordV2>();
        const listStarted = createDeferred<void>();
        const release = createDeferred<void>();
        let holdList = false;
        // Network and encryption are system boundaries. Repository reconciliation,
        // seed custody, lifetime, host and composer remain their real implementations.
        const transport: import('@/sync/ops/sessionDrafts/sessionDraftRepository').SessionDraftRepositoryTransport = {
            list: async () => {
                if (holdList) { listStarted.resolve(); await release.promise; }
                return { items: [], nextAfter: undefined };
            },
            read: async (requested) => {
                const record = records.get(canonicalSessionDraftAddressV2(requested));
                return !record ? { status: 'absent' } : record.content === null ? { status: 'deleted', record } : { status: 'present', record };
            },
            mutate: async (request) => {
                const key = canonicalSessionDraftAddressV2(request.address);
                const previous = records.get(key);
                if (request.expectedRevision !== (previous?.revision ?? 'absent')) {
                    return { status: 'conflict', current: previous ?? { status: 'absent' } };
                }
                const record = { address: request.address, revision: (previous?.revision ?? -1) + 1,
                    content: request.content, createdAt: 1, updatedAt: 2 };
                records.set(key, record);
                return { status: 'updated', record };
            },
        };
        repository.configureSessionDraftRepository({ scope, syncEnabled: true, transport, cipher: {
            seal: async (target, document) => ({ t: 'plain', v: createSessionDraftPrivatePayloadV2(target, document) }),
            open: async (_target, content) => content.t === 'plain' ? content.v.document : null,
        } });
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        let hydration: Promise<void> | null = null;
        try {
            if (phase === 'refresh') await repository.ensureSessionDraftRepositoryHydrated(scope);
            const lifetime = captureActiveServerAccountScopeLifetime();
            holdList = true;
            hydration = repository.ensureSessionDraftRepositoryHydrated(scope);
            await listStarted.promise;
            repository.writeNewSessionDraft({ scope, draftId: address.draftId, patch: { text: 'source prompt' }, materializationIntent: 'userEdit' });
            const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'step', id: 'prompt',
                document: { text: 'SECOND', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] });
            const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'hydrating-handoff', name: 'SECOND', definition });
            const id = kind === 'new-session'
                ? storeNewSessionAutomationHandoffSeed({ name: 'SECOND', description: null, enabled: true, draft, project: null, triggers: [],
                    composer: authoringComposerSeedFromSnapshot('prompt', { text: 'SECOND', references: [], attachments: [] }) })
                : storeTriggerWorkflowSeed({ definition, retarget: { scope: 'account', automationId: '00000000-0000-4000-8000-000000000293',
                    triggerId: 'trigger', expectedRevision: 1 } });
            const source = kind === 'new-session' ? { kind: 'new' as const, newSessionDraftSeedId: id }
                : { kind: 'new' as const, triggerWorkflowSeedId: id };
            screen = await renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={source} /></AppPaneProvider>);
            const input = screen.root.findByType(AgentInput);
            expect(input.props.value).toBe('SECOND');
            expect(kind === 'new-session' ? readNewSessionAutomationHandoffSeed(id) : readTriggerWorkflowSeed(id)).toBeNull();
            const adoptedId = screen.root.findByType(WorkflowEditorBody).props.draft.draftId;
            await act(async () => {
                const body = screen!.root.findByType(WorkflowEditorBody);
                body.props.onChange({ ...body.props.draft, name: 'Keep my edit' });
                repository.writeNewSessionDraft({ scope, draftId: address.draftId, patch: { text: 'source edit during hydration' }, materializationIntent: 'userEdit' });
            });
            await act(async () => {
                release.resolve();
                await hydration;
                getStorage().setState({ isSessionDraftsReady: true });
                // Completing a same-Account generation publication is not a
                // lifetime retirement or a change of the editor's address.
                publishAppliedActiveServerSnapshot({ ...appliedHome, generation: appliedHome.generation + 1 });
            });
            const document = repository.getSessionDraftSnapshot(scope, address)?.document;
            expect(document && 'composer' in document ? document.composer.text.value : undefined).toBe('source edit during hydration');
            expect(captureActiveServerAccountScopeLifetime()).toBe(lifetime);
            expect(lifetime?.isCurrent()).toBe(true);
            expect(screen.root.findByType(AgentInput)).toBe(input);
            expect(input.props.value).toBe('SECOND');
            expect(screen.root.findByType(WorkflowEditorBody).props.draft).toMatchObject({ draftId: adoptedId, name: 'Keep my edit' });
        } finally {
            release.resolve();
            await hydration;
            await screen?.unmount();
            repository.configureSessionDraftRepository({ syncEnabled: false });
        }
    });

    it('renews a pending saved-document hydration but preserves an already opened draft after same-Account retirement', async () => {
        const { createDeferred } = await import('@/dev/testkit');
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot({ ...appliedHome });
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            const pending = createDeferred<void>();
            let reads = 0;
            const definitionId = '00000000-0000-4000-8000-000000000001';
            // The old credential-bound HTTP reply remains pending while the
            // renewed lifetime reads the same producer-created saved revision.
            const value = await updateWorkflowDefinition({ definitionId, definition: savedAgentDefinition(),
                metadata: { title: 'Restored document' }, expectedRevision: { headerVersion: 3, bodyVersion: 3 } });
            const row = home.artifacts(appliedHome.serverId).read(value.definitionId);
            home.requests.splice(0);
            home.answer(appliedHome.serverId, `/v1/artifacts/${definitionId}`, { select: () => ({ body: row,
                ...(reads++ === 0 ? { respondAfter: pending.promise } : {}) }) });
            const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
            screen = await renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'saved', definitionId }} /></AppPaneProvider>);
            expect(screen.root.findAllByType(WorkflowEditorBody)).toHaveLength(0);
            expect(home.requestsFor(`/v1/artifacts/${definitionId}`)).not.toHaveLength(0);
            await act(async () => retireActiveServerAccountScopeLifetime());
            const draft = screen.root.findByType(WorkflowEditorBody).props.draft;
            expect(draft.name).toBe('Restored document');
            await act(async () => retireActiveServerAccountScopeLifetime());
            expect(screen.root.findByType(WorkflowEditorBody).props.draft).toBe(draft);
            pending.resolve();
        } finally {
            await screen?.unmount();
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });

    it('keeps the loop card status on its executable container rather than its latest iteration frame', async () => {
        const { selectWorkflowTestStep } = await import('../editor/useWorkflowTestRunPresentation');
        const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'loop', id: 'items',
            repetition: { kind: 'items', items: { kind: 'literal', value: [1] }, execution: 'sequential', failurePolicy: 'fail_stop' },
            body: [{ kind: 'wait', id: 'review', document: { text: 'Review', references: [], attachments: [] } }] }] });
        const root = createWorkflowInvocationIndexFixture({ id: 'root' });
        const loop = createWorkflowInvocationIndexFixture({ id: 'loop', parentRecordId: root.id, sequence: '1', lifecycle: 'running' });
        const frame = createWorkflowInvocationIndexFixture({ id: 'iteration', parentRecordId: loop.id, sequence: '2', lifecycle: 'completed' });
        const window = { invocationIds: [root.id, loop.id, frame.id], nextCursor: null, parentRevision: 1, loaded: true };
        expect(selectWorkflowTestStep({ factsById: { root, loop, iteration: frame }, history: window, attention: window,
            firstFailedId: null }, definition, 'items')).toBe(loop);
    });

    beforeEach(async () => {
        routeBoundary.params = {};
        routeBoundary.platform = 'ios';
        routeBoundary.credentials = null;
        previousAppliedSnapshot = getAppliedActiveServerSnapshot();
        previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
        installHomeGovernanceBoundaries(home);
        resetTeamsDirectoryEngineForTests(); resetTeamsSnapshotsForTests();
        await home.reset();
        runBoundaries.clear();
        runFailure = null;
        appliedHome.serverUrl = 'https://server-a.example';
        const restoredHome = await addComposerHome('Editor composer', appliedHome.serverUrl);
        appliedHome.serverId = restoredHome.id;
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const credentials = home.findByServerUrl(appliedHome.serverUrl)?.token;
        if (!credentials) throw new Error('Missing synthetic Account credential');
        routeBoundary.credentials = { token: credentials };
        const memory = createAuthoringMemoryHttpBoundary();
        const prepareRequest = apiSocket.createRequestForPreparedTarget.bind(apiSocket);
        vi.spyOn(apiSocket, 'createRequestForPreparedTarget').mockImplementation(target => {
            const request = prepareRequest(target);
            return async (path: string, init?: RequestInit) => await memory.handle(new URL(path, target.endpoint), init) ?? request(path, init);
        });
        // Restoration creates the real memory owner and captures its HTTP port.
        // Install that port before restoration, just as the application does.
        accountConnection = await restoreServerAccountForTest({ serverUrl: appliedHome.serverUrl,
            serverIdentityId: restoredHome.serverIdentityId,
            additionalRequestOrigins: ['https://workspace-peer.test', 'https://workflow.example'],
            accountId: 'account-a', credentials: routeBoundary.credentials, request: async (url, init) =>
                await runBoundaries.get(new URL(String(url)).origin)?.handle(new URL(String(url)), init) ?? home.request(url, init) });
        viewport.width = 1280;
        const machine = createMachineFixture();
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'account-a' };
        getStorage().setState({ profileScope: scope,
            settingsScope: scope, isDataReady: true, isSessionDraftsReady: true,
            localSettings: { ...getStorage().getState().localSettings, workspaceLayoutV1: {} },
            machines: { [machine.id]: machine }, machineListByServerId: {} });
        runStart.mockReset();
        runStart.mockImplementation(async () => { throw new Error('Fixture Machine is offline'); });
        home.answer(appliedHome.serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
        home.answer(appliedHome.serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } });
        const kvRows = new Map<string, { key: string; value: string | null; version: number }>();
        home.answer(appliedHome.serverId, 'GET /v1/kv/workspace%3Atabs%3Av1', { select: () => ({ body: kvRows.get('workspace:tabs:v1')
            ?? { key: 'workspace:tabs:v1', value: null, version: 0 } }) });
        home.answer(appliedHome.serverId, 'POST /v1/kv', { select: input => {
            if (!input || typeof input !== 'object' || !('mutations' in input) || !Array.isArray(input.mutations)) throw new Error('Expected a KV mutation');
            const results = input.mutations.map((row: unknown) => {
                if (!row || typeof row !== 'object' || !('key' in row) || typeof row.key !== 'string'
                    || !('value' in row) || (row.value !== null && typeof row.value !== 'string')) throw new Error('Expected a KV row');
                const version = (kvRows.get(row.key)?.version ?? 0) + 1;
                kvRows.set(row.key, { key: row.key, value: row.value, version });
                return { key: row.key, version };
            });
            return { body: { success: true, results } };
        } });
        await seedSavedDefinition('00000000-0000-4000-8000-000000000001');
    });
    afterEach(async () => {
        (await import('@/components/onboarding/tour/state/journeySession')).endOnboardingJourneySession();
        clearActiveUnsavedChangesGuard();
        await standardCleanup();
        await accountConnection?.dispose(); accountConnection = null;
        vi.unstubAllGlobals();
        publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable);
        vi.restoreAllMocks();
    });

    it('requires session context before opening a habit from a direct example route', async () => {
        const screen = await renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'new',
            exampleKey: 'notify-when-agent-waits' }} /></AppPaneProvider>);
        expect(screen.findByTestId('workflow-editor-starter-context')).not.toBeNull();
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        expect(screen.root.findAllByType(WorkflowEditorBody)).toHaveLength(0);
    });

    it('opens a concrete habit seed with its trigger and exact session placement without writing', async () => {
        const { WORKFLOW_STARTER_EXAMPLES_V1 } = await import('@happier-dev/protocol');
        const { storeWorkflowDefinitionDraftSeed } = await import('@/sync/domains/workflows/workflowDefinitionDraftSeed');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const session = createSessionFixture({ serverId: appliedHome.serverId });
        getStorage().setState({ sessions: { [session.id]: session },
            machineListByServerId: { ...getStorage().getState().machineListByServerId, [appliedHome.serverId]: Object.values(getStorage().getState().machines) } });
        const example = WORKFLOW_STARTER_EXAMPLES_V1.find(entry => entry.key === 'notify-when-agent-waits')!;
        const definitionDraftSeedId = storeWorkflowDefinitionDraftSeed({ name: 'Notify me', definition: example.definition,
            trigger: { kind: 'sessionLifecycle', enabled: true, sourceSessionId: session.id,
                events: ['userActionRequired'], policy: { kind: 'everyMatch' } },
            sessionTarget: { sessionId: session.id, machineId: 'machine-1' } });
        const source = { kind: 'new' as const, definitionDraftSeedId };
        const screen = await renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={source} /></AppPaneProvider>);
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        const body = screen.root.findByType(WorkflowEditorBody);
        expect(body.props.projectTarget).toEqual({ machineId: 'machine-1', directory: '/Users/tester/project' });
        await screen.pressByTestIdAsync('workflow-editor-settings-toggle');
        const section = screen.root.findByType(WorkflowTriggerSection);
        expect(section.props.draft.adds).toMatchObject([{ trigger: { sourceSessionId: session.id, events: ['userActionRequired'] } }]);
        await act(async () => screen.update(<AppPaneProvider><WorkflowEditorHostScreen source={{ ...source }} /></AppPaneProvider>));
        expect(section.props.draft.adds).toHaveLength(1);
        expectNoWorkflowWrites();
    });

    it('undoes and redoes an inline habit, its trigger and placement as one editor change', async () => {
        const { WORKFLOW_STARTER_EXAMPLES_V1 } = await import('@happier-dev/protocol');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const session = createSessionFixture({ serverId: appliedHome.serverId });
        getStorage().setState({ sessions: { [session.id]: session },
            machineListByServerId: { ...getStorage().getState().machineListByServerId, [appliedHome.serverId]: Object.values(getStorage().getState().machines) } });
        const screen = await renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'new' }} /></AppPaneProvider>);
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        const { WorkflowBlockListEditor } = await import('../editor/WorkflowBlockListEditor');
        const body = screen.root.findByType(WorkflowEditorBody);
        const before = { draft: body.props.draft, project: body.props.projectTarget };
        const example = WORKFLOW_STARTER_EXAMPLES_V1.find(entry => entry.key === 'test-after-every-turn')!;
        const onUseExample = screen.root.findByType(WorkflowBlockListEditor).props.onUseExample;
        if (onUseExample === undefined) throw new Error('Missing starter insertion handler');
        const readHistory = () => {
            const history = body.props.history;
            if (history === undefined) throw new Error('Missing workflow editor history');
            return history;
        };
        // The real picker consumer owns insertion; the real Host owns the history and trigger delta.
        await act(async () => onUseExample({ ...example,
            trigger: { kind: 'sessionLifecycle', enabled: true, sourceSessionId: session.id,
                events: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'], policy: { kind: 'everyMatch' } },
            sessionTarget: { sessionId: session.id, machineId: 'machine-1' } }));
        expect(body.props.projectTarget).toEqual({ machineId: 'machine-1', directory: '/Users/tester/project' });
        await screen.pressByTestIdAsync('workflow-editor-settings-toggle');
        const section = screen.root.findByType(WorkflowTriggerSection);
        expect(section.props.draft.adds).toHaveLength(1);
        await act(async () => readHistory().undo());
        expect(body.props.draft).toEqual(before.draft);
        expect(body.props.projectTarget).toEqual(before.project);
        expect(section.props.draft.adds).toHaveLength(0);
        await act(async () => readHistory().redo());
        expect(body.props.draft.blocks).toMatchObject([{ kind: 'action', actionId: 'machines.command.run' }]);
        expect(body.props.projectTarget).toEqual({ machineId: 'machine-1', directory: '/Users/tester/project' });
        expect(section.props.draft.adds).toHaveLength(1);
        expectNoWorkflowWrites();
    });

    it('tests the saved revision in place while preserving the unsaved editor document', async () => {
        const definitionId = '8fab3a81-5e64-4000-8000-000000000001';
        const definition = createWorkflowDefinitionFixture({ inputs: [], blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Saved contents', references: [], attachments: [] } }] });
        await seedSavedDefinition(definitionId, definition);
        runStart.mockImplementation(async (request) => {
            return { admission: 'created', run: createWorkflowRunSummaryFixture({ id: request.runId, sourceArtifactId: definitionId }) };
        });
        home.answer(appliedHome.serverId, storageRoute, { select: async input => {
            if (!input || typeof input !== 'object' || !('operation' in input)) throw new Error('Expected a storage request');
            const { operation, ...storageFields } = input;
            const { progressEnvelopes: _progress, pageByteLimit: _budget, ...fields } = storageFields as Record<string, unknown>;
            if (operation === 'invocations.list') {
                const request = (await import('@happier-dev/protocol')).WorkflowInvocationListRequestV1Schema.parse(fields);
                const root = createWorkflowInvocationIndexFixture({ id: 'root', runId: request.runId, lifecycle: 'completed', contentRevision: '1' });
                const leaf = createWorkflowInvocationIndexFixture({ id: 'review', runId: request.runId, parentRecordId: root.id,
                    sequence: '1', lifecycle: 'completed', contentRevision: '1', updatedAt: '2026-09-08T10:00:02.000Z' });
                const index = request.cursor === undefined ? root : leaf;
                const detail = (await import('@happier-dev/protocol')).WorkflowInvocationDetailV1Schema.parse({ index, parentRevision: 1,
                    progress: { kind: 'happier.workflow-progress.v1', blockKind: request.cursor === undefined ? 'root' : 'wait',
                        invocationPath: { blockId: request.cursor === undefined ? '$root' : 'review', scope: [] }, attempt: '0',
                        logicalInvocationRecordId: index.id, ...(request.cursor === undefined ? {} : { result: 'Saved result' }) } });
                return { body: { invocations: [index], parentRevision: 1, keyCensus: runKeyCensus(request.runId),
                    progressEnvelopesByInvocationId: { [index.id]: storedProgress(detail, 'account-a') },
                    ...(request.cursor === undefined ? { nextCursor: 'second-page' } : {}) } };
            }
            if (operation === 'run-key.census' && 'runId' in fields && typeof fields.runId === 'string') return { body: runKeyCensus(fields.runId) };
            throw new Error(`Unexpected test-run storage request: ${String(operation)}`);
        } });
        const screen = await renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'saved', definitionId }} /></AppPaneProvider>, {
            createNodeMock: () => ({ measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40) }),
        });
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        const body = screen.root.findByType(WorkflowEditorBody);
        const readWait = () => {
            const block = body.props.draft.blocks[0];
            if (block?.kind !== 'wait') throw new Error('Expected the saved Wait step');
            return block;
        };
        const changeWhere = body.props.onChangeProjectTarget;
        if (!changeWhere) throw new Error('Expected the editor target control');
        await act(async () => {
            body.props.onChange({ ...body.props.draft, blocks: [{ ...readWait(), document: {
                text: 'Unsaved changes', references: [], attachments: [],
            } }] });
            changeWhere({ machineId: 'machine-1', directory: '/repo' });
        });
        // Test run lives in the page's `⋯` (DESIGN-13 header, lab E1's action set); its item is the
        // menu's own action, chosen as the menu would.
        const pageMenu = screen.root.findAll((node) => node.props?.testID === 'workflow-editor-menu' && Array.isArray(node.props.actions))[0];
        const testRun = (pageMenu?.props.actions as ReadonlyArray<{ id: string; disabled?: boolean; onSelect: () => void }> | undefined)
            ?.find((action) => action.id === 'test-run');
        expect(testRun?.disabled).not.toBe(true);
        const { router } = await import('expo-router');
        vi.mocked(router.push).mockClear();
        await act(async () => { testRun!.onSelect(); });
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(startRequests()[0]).toMatchObject({
            source: { kind: 'saved', definitionId, revision: { headerVersion: 3, bodyVersion: 3 } },
        });
        expect(readWait().document.text).toBe('Unsaved changes');
        expect(router.push).not.toHaveBeenCalled();
        expect(definitionWrites()).toHaveLength(0);
        await vi.waitFor(() => expect(screen.findByTestId('workflow-editor-test-review-status')).not.toBeNull());
        expect(screen.findByTestId('workflow-editor-test-review-duration')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-test-review-output-body')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Saved result');
        expect(home.requestsFor(storageRoute).map(request => request.input).filter(input => input && typeof input === 'object'
            && 'operation' in input && input.operation === 'invocations.list')).toEqual([
            expect.objectContaining({ progressEnvelopes: true }), expect.objectContaining({ progressEnvelopes: true, cursor: 'second-page' }),
        ]);
        expect(home.requestsFor(storageRoute).filter(({ input }) => input && typeof input === 'object'
            && 'operation' in input && input.operation === 'invocations.get')).toHaveLength(0);
        await screen.pressByTestIdAsync('workflow-editor-test-review-open');
        expect(router.push).toHaveBeenLastCalledWith(`/workflows/runs/${startRequests()[0]!.runId}?invocationId=review&serverId=${encodeURIComponent(getStorage().getState().profileScope!.serverId)}`);
    });

    it('runs the reviewed saved draft with its granted Team without saving or substituting saved contents', async () => {
        appliedHome.serverUrl = 'https://workflow.example';
        appliedHome.serverId = (await addComposerHome('Workflow Home', appliedHome.serverUrl)).id;
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        getStorage().setState({ profileScope: { serverId: getActiveServerSnapshot().serverId, accountId: 'account-a' } });
        home.answer(appliedHome.serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
        home.answer(appliedHome.serverId, '/v1/teams/get', { body: teamSummaryFixture({ id: 'team-a', name: 'Builders',
            viewerRole: 'member', capabilities: teamCapabilitiesFixture({}) }) });
        const definitionId = '8fab3a81-5e64-4000-8000-000000000001';
        const definition = createWorkflowDefinitionFixture({ inputs: [], blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Saved contents', references: [], attachments: [] } }] });
        await seedSavedDefinition(definitionId, definition, 'Shared draft');
        home.answer(appliedHome.serverId, `/v1/artifacts/${definitionId}/access/grants`, { body: { artifactId: definitionId,
            ownerAccountId: 'account-a', access: 'owner', grants: [{ principal: { kind: 'team', teamId: 'team-a' },
                accessLevel: 'edit', createdByAccountId: 'account-a', createdAt: 1, display: { name: 'Builders' } }] } });
        runStart.mockImplementation(async (request) => {
            return { admission: 'created', run: createWorkflowRunSummaryFixture({ id: request.runId,
                sourceArtifactId: definitionId, visibleTeamId: 'team-a' }) };
        });
        const screen = await renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'saved', definitionId }} /></AppPaneProvider>, {
            createNodeMock: () => ({ measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40) }),
        });
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        const body = screen.root.findByType(WorkflowEditorBody);
        await act(async () => {
            const block = body.props.draft.blocks[0];
            if (block.kind !== 'wait') throw new Error('Expected the reviewed wait block');
            body.props.onChange({ ...body.props.draft, blocks: [{ ...block, document: {
                ...block.document, text: 'Reviewed unsaved contents',
            } }] });
            const onChangeProjectTarget = body.props.onChangeProjectTarget;
            if (!onChangeProjectTarget) throw new Error('Missing workflow Project target handler');
            onChangeProjectTarget({ machineId: 'machine-1', directory: '/repo' });
        });
        await screen.pressByTestIdAsync('workflow-editor-run-now');
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(startRequests()[0]).toMatchObject({
            source: { kind: 'inline', sourceArtifactId: definitionId, visibleTeamId: 'team-a',
                definition: { blocks: [{ document: { text: 'Reviewed unsaved contents' } }] } },
        });
        const { router } = await import('expo-router');
        expect(router.push).toHaveBeenLastCalledWith(`/workflows/runs/${startRequests()[0]!.runId}?serverId=${encodeURIComponent(getStorage().getState().profileScope!.serverId)}`);
        expect(definitionWrites()).toHaveLength(0);
    });

    it('reviews an unresolved Run now as the draft and Where it sent, not the draft as edited since', async () => {
        appliedHome.serverUrl = 'https://workflow.example';
        appliedHome.serverId = (await addComposerHome('Workflow Home', appliedHome.serverUrl)).id;
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        getStorage().setState({ profileScope: { serverId: getActiveServerSnapshot().serverId, accountId: 'account-a' } });
        home.answer(appliedHome.serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
        home.answer(appliedHome.serverId, storageRoute, { status: 404, body: { error: 'run_not_found' } });
        const definitionId = '8fab3a81-5e64-4000-8000-000000000002';
        const definition = createWorkflowDefinitionFixture({ inputs: [], blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Saved contents', references: [], attachments: [] } }] });
        await seedSavedDefinition(definitionId, definition, 'Lost reply draft');
        home.answer(appliedHome.serverId, `/v1/artifacts/${definitionId}/access/grants`, { body: { artifactId: definitionId,
            ownerAccountId: 'account-a', access: 'owner', grants: [] } });
        runFailure = { errorCode: 'workflow_outcome_unresolved', error: 'Lost reply' };
        runStart.mockImplementation(async () => null);
        const screen = await renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'saved', definitionId }} /></AppPaneProvider>, {
            createNodeMock: () => ({ measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40) }),
        });
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        const { WorkflowRunComposer } = await import('../run/WorkflowRunComposer');
        const edit = async (text: string, directory: string) => act(async () => {
            const body = screen.root.findByType(WorkflowEditorBody);
            const block = body.props.draft.blocks[0];
            if (block.kind !== 'wait') throw new Error('Expected the reviewed wait block');
            body.props.onChange({ ...body.props.draft, blocks: [{ ...block, document: { ...block.document, text } }] });
            body.props.onChangeProjectTarget?.({ machineId: 'machine-1', directory });
        });
        await edit('Reviewed contents', '/repo/reviewed');
        await screen.pressByTestIdAsync('workflow-editor-run-now');
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(screen.root.findByType(WorkflowRunComposer).props.retainedRequest?.unresolved).toBe(true));
        const original = startRequests()[0];
        await act(async () => { screen.root.findByType(WorkflowRunComposer).props.onCancel(); });
        await edit('Edited after the lost reply', '/repo/elsewhere');
        await screen.pressByTestIdAsync('workflow-editor-run-now');
        const review = screen.root.findByType(WorkflowRunComposer).props;
        expect(review.retainedRequest?.input).toEqual(original);
        expect(review.retainedRequest?.project).toEqual({ machineId: 'machine-1', directory: '/repo/reviewed' });
        expect(review.definition?.blocks[0]).toMatchObject({ document: { text: 'Reviewed contents' } });
        expect(review.directory).toBe('/repo/reviewed');
        expect(review.includesUnsavedEdits).toBe(false);
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.accessibilityLabel).toBe('workflows.start.retry.action');
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(startRequests().length).toBeGreaterThan(2));
        expect(startRequests().every((request) => JSON.stringify(request) === JSON.stringify(original))).toBe(true);

        // Page-level authoring choices belong to the next start. Even an unavailable
        // new runtime must not prevent recovery of the request already reviewed here.
        await act(async () => { screen.root.findByType(WorkflowRunComposer).props.onCancel(); });
        await act(async () => {
            const changeExecutionTarget = screen.root.findByType(WorkflowEditorBody).props.onChangeExecutionTarget;
            if (!changeExecutionTarget) throw new Error('Missing page-level runtime choice');
            changeExecutionTarget('detached_run');
        });
        expect(screen.root.findByType(WorkflowEditorBody).props.executionTarget).toBe('detached_run');
        await screen.pressByTestIdAsync('workflow-editor-run-now');
        // The review names the runtime the sent request runs in, not the page's choice for the next start.
        const runAs = screen.root.findByType(WorkflowRunComposer).props.extraActionChips?.find((chip) => chip.key === 'workflow-start-run-as');
        expect(runAs?.collapsedContentPopover?.label).toBe('workflows.start.targetsSessions');
        const beforeRuntimeChangeRetry = startRequests().length;
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(startRequests().length).toBeGreaterThan(beforeRuntimeChangeRetry));
        expect(startRequests().every((request) => JSON.stringify(request) === JSON.stringify(original))).toBe(true);
    });

    it('reviews an unresolved saved-revision Test as the revision it sent, after leaving and a newer save', async () => {
        home.answer(appliedHome.serverId, storageRoute, { status: 404, body: { error: 'run_not_found' } });
        const definitionId = '8fab3a81-5e64-4000-8000-000000000003';
        const waitDefinition = (text: string) => createWorkflowDefinitionFixture({ inputs: [], blocks: [{ kind: 'wait', id: 'review',
            document: { text, references: [], attachments: [] } }] });
        await seedSavedDefinition(definitionId, waitDefinition('Reviewed revision'), 'Tested draft');
        runFailure = { errorCode: 'workflow_outcome_unresolved', error: 'Lost reply' };
        runStart.mockImplementation(async () => null);
        const { WorkflowRunComposer } = await import('../run/WorkflowRunComposer');
        const { getWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        const mount = () => renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'saved', definitionId }} /></AppPaneProvider>, {
            createNodeMock: () => ({ measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40) }),
        });
        const pressTest = async (screen: Awaited<ReturnType<typeof mount>>) => {
            const pageMenu = screen.root.findAll((node) => node.props?.testID === 'workflow-editor-menu' && Array.isArray(node.props.actions))[0];
            const testRun = (pageMenu?.props.actions as ReadonlyArray<{ id: string; onSelect: () => void }> | undefined)?.find((action) => action.id === 'test-run');
            await act(async () => { testRun!.onSelect(); });
        };
        const screen = await mount();
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        await act(async () => { screen.root.findByType(WorkflowEditorBody).props.onChangeProjectTarget?.({ machineId: 'machine-1', directory: '/repo' }); });
        await pressTest(screen);
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(screen.root.findByType(WorkflowRunComposer).props.retainedRequest?.unresolved).toBe(true));
        const original = startRequests()[0]!;
        expect(original.source).toMatchObject({ kind: 'saved', definitionId });
        await screen.unmount();

        // The saved definition moves on (revision N+1) while the Test of revision N is unknown.
        const current = await getWorkflowDefinition({ definitionId });
        const { updateWorkflowDefinition: update } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        await update({ definitionId, definition: waitDefinition('Saved later'), metadata: { title: 'Tested draft' }, expectedRevision: current.revision });

        const returned = await mount();
        await vi.waitFor(() => expect(returned.root.findByType(WorkflowEditorBody).props.draft.blocks[0]).toMatchObject({ document: { text: 'Saved later' } }));
        await pressTest(returned);
        await vi.waitFor(() => expect(returned.root.findByType(WorkflowRunComposer).props.retainedRequest?.input).toEqual(original));
        const review = returned.root.findByType(WorkflowRunComposer).props;
        // The review is revision N as tested, never the newer save.
        expect(review.definition?.blocks[0]).toMatchObject({ document: { text: 'Reviewed revision' } });
        expect(review.notice).toBe('workflows.testRun.savedNotice');
        expect(returned.findByTestId('workflow-run-inputs-run')?.props.accessibilityLabel).toBe('workflows.start.retry.action');
        const sent = startRequests().length;
        await returned.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(startRequests().length).toBeGreaterThan(sent));
        expect(startRequests().every((request) => JSON.stringify(request) === JSON.stringify(original))).toBe(true);
        await returned.unmount();
    });

    it('reviews an unresolved Session composer start as the request it sent; a new selection is its own start', async () => {
        home.answer(appliedHome.serverId, storageRoute, { status: 404, body: { error: 'run_not_found' } });
        runFailure = { errorCode: 'workflow_outcome_unresolved', error: 'Lost reply' };
        runStart.mockImplementation(async () => null);
        const { useWorkflowComposerStart } = await import('../run/useWorkflowComposerStart');
        const { WorkflowRunComposer } = await import('../run/WorkflowRunComposer');
        let start: ReturnType<typeof useWorkflowComposerStart> | null = null;
        const Host = () => {
            start = useWorkflowComposerStart({ project: { machineId: 'machine-1', directory: '/repo/reviewed' },
                originSession: { sessionId: 'session-origin' }, onStarted: () => {} });
            return null;
        };
        const screen = await renderScreen(<Host />);
        await act(async () => { start!('builtin:plan-with-a-panel', { retainedDraft: 'Reviewed brief' }); });
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(screen.root.findByType(WorkflowRunComposer).props.retainedRequest?.unresolved).toBe(true));
        const original = startRequests()[0]!;
        expect(original.inputs).toMatchObject({ request: 'Reviewed brief' });
        act(() => screen.changeTextByTestId('new-session-composer-input', 'Edited after the lost reply'));
        expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Reviewed brief');
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.accessibilityLabel).toBe('workflows.start.retry.action');
        const sent = startRequests().length;
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(startRequests().length).toBeGreaterThan(sent));
        expect(startRequests().every((request) => JSON.stringify(request) === JSON.stringify(original))).toBe(true);

        // Choosing a workflow again is a new start with its own values, never the unresolved one's review.
        for (const workflow of ['builtin:review-and-converge', 'builtin:plan-with-a-panel'] as const) {
            await act(async () => { start!(workflow, { retainedDraft: 'Another question' }); });
            const fresh = screen.root.findByType(WorkflowRunComposer).props;
            expect(fresh.retainedRequest ?? null).toBeNull();
            expect(screen.findByTestId('workflow-run-inputs-run')?.props.accessibilityLabel).toBe('workflows.start.start');
        }
        await screen.unmount();
    });

    it('keeps a new Session workflow selection when an earlier start settles after dismissal', async () => {
        const { createDeferred } = await import('@/dev/testkit');
        const reply = createDeferred<unknown>();
        runStart.mockImplementation(() => reply.promise);
        const { useWorkflowComposerStart } = await import('../run/useWorkflowComposerStart');
        const { WorkflowRunComposer } = await import('../run/WorkflowRunComposer');
        const onStarted = vi.fn();
        let start: ReturnType<typeof useWorkflowComposerStart> | null = null;
        const Host = () => {
            start = useWorkflowComposerStart({ project: { machineId: 'machine-1', directory: '/repo/reviewed' },
                originSession: { sessionId: 'session-origin' }, onStarted });
            return null;
        };
        const screen = await renderScreen(<Host />);
        await act(async () => { start!('builtin:plan-with-a-panel', { retainedDraft: 'First question' }); });
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(startRequests()).toHaveLength(1));
        const first = startRequests()[0]!;
        await act(async () => { screen.root.findByType(WorkflowRunComposer).props.onCancel(); });
        await act(async () => { start!('builtin:plan-with-a-panel', { retainedDraft: 'Second question' }); });
        await act(async () => reply.resolve({ admission: 'created', run: createWorkflowRunSummaryFixture({ id: first.runId }) }));
        await vi.waitFor(() => expect(getStorage().getState().workflowRunsById[workflowRunStoreKey(first.runId)]).toBeDefined());
        // The admitted Run remains a canonical fact, but an obsolete intent cannot navigate
        // or clear the review the person deliberately selected in the meantime.
        expect(onStarted).not.toHaveBeenCalled();
        const nextReview = screen.root.findAllByType(WorkflowRunComposer).find((node) => node.props.values.request === 'Second question');
        expect(nextReview).toBeDefined();
        runStart.mockImplementation(async (request) => ({ admission: 'created', run: createWorkflowRunSummaryFixture({ id: request.runId }) }));
        await act(async () => { nextReview!.props.onRun({ request: 'Second question' }); });
        await vi.waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
        expect(startRequests()).toHaveLength(2);
        expect(startRequests()[1]!.runId).not.toBe(first.runId);
        expect(onStarted.mock.calls[0]![0].run.id).toBe(startRequests()[1]!.runId);
        await screen.unmount();
    });

    it('reviews an unresolved New workflow start with its sent Where instead of the page controls', async () => {
        home.answer(appliedHome.serverId, storageRoute, { status: 404, body: { error: 'run_not_found' } });
        runFailure = { errorCode: 'workflow_outcome_unresolved', error: 'Lost reply' };
        runStart.mockImplementation(async () => null);
        const { useNewSessionWorkflowStart } = await import('@/components/sessions/new/hooks/useNewSessionWorkflowStart');
        const { createNewSessionPromptStore } = await import('@/components/sessions/new/hooks/screenModel/newSessionPromptStore');
        const { WorkflowRunComposer } = await import('../run/WorkflowRunComposer');
        type Panel = Parameters<typeof useNewSessionWorkflowStart>[0]['panelProps'];
        const agentChip = { key: 'agent-chip', render: () => null } as unknown as NonNullable<Panel['agentInputExtraActionChips']>[number];
        let chip: ReturnType<typeof useNewSessionWorkflowStart>['chip'] | null = null;
        const Host = (props: Readonly<{ machineId: string; path: string }>) => {
            const [prompt, setPrompt] = React.useState('Reviewed brief');
            const panelProps = {
                popoverBoundaryRef: React.createRef(), headerHeight: 0, safeAreaTop: 0, safeAreaBottom: 0,
                newSessionTopPadding: 0, newSessionSidePadding: 0, newSessionBottomPadding: 0, containerStyle: {},
                promptStore: createNewSessionPromptStore(prompt), setSessionPrompt: setPrompt,
                handleCreateSession: () => {}, canCreate: true, isCreating: false,
                emptyAutocompleteKinds: [], emptyAutocompleteSuggestions: async () => [],
                agentType: 'codex', permissionMode: 'default', modelMode: 'default', modelOptions: [],
                machineName: 'Current machine', selectedMachineId: props.machineId, selectedPath: props.path,
                targetServerId: appliedHome.serverId, agentInputExtraActionChips: [agentChip],
                useProfiles: false, selectedProfileId: null, showResumePicker: false, resumeSessionId: null, isResumeSupportChecking: false,
            } as unknown as Panel;
            const result = useNewSessionWorkflowStart({ panelProps, prompt });
            chip = result.chip;
            return result.composer;
        };
        const select = async (choice: string) => {
            const content = chip!.collapsedContentPopover?.renderContent;
            if (typeof content !== 'function') throw new Error('Workflow picker content is missing');
            const picker = await renderScreen(content({ requestClose: () => {}, maxHeight: 420 }) as React.ReactElement);
            await picker.pressByTestIdAsync(`workflow-choice:${choice}`);
            await picker.unmount();
        };
        const screen = await renderScreen(<Host machineId="machine-1" path="/repo/reviewed" />);
        await select('builtin:plan-with-a-panel');
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(screen.root.findByType(WorkflowRunComposer).props.retainedRequest?.unresolved).toBe(true));
        const original = startRequests()[0]!;
        // The page moves to another machine and folder; those belong to the next start.
        await screen.update(<Host machineId="machine-2" path="/repo/elsewhere" />);
        const review = screen.root.findByType(WorkflowRunComposer).props;
        expect(review.retainedRequest?.input).toEqual(original);
        expect(review.directory).toBe('/repo/reviewed');
        expect(review.authoringControls).toBeUndefined();
        expect(review.extraActionChips?.map((entry) => entry.key)).toEqual(['workflow-start-where']);
        expect(review.extraActionChips?.[0]?.collapsedContentPopover?.label).toContain('/repo/reviewed');
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        const sent = startRequests().length;
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(startRequests().length).toBeGreaterThan(sent));
        expect(startRequests().every((request) => JSON.stringify(request) === JSON.stringify(original))).toBe(true);

        // A deliberate new selection is its own start with the page's current controls.
        await select('builtin:review-and-converge');
        const fresh = screen.root.findByType(WorkflowRunComposer).props;
        expect(fresh.retainedRequest ?? null).toBeNull();
        expect(fresh.directory).toBe('/repo/elsewhere');
        expect(fresh.extraActionChips).toEqual([agentChip]);
        await screen.unmount();
    });

    it('reads a builtin through the editor with settings, Run now and Duplicate instead of Save', async () => {
        const { getBuiltinWorkflowCatalogV1 } = await import('@happier-dev/protocol');
        const builtin = getBuiltinWorkflowCatalogV1().find(entry => entry.requiresOriginSession !== true)!;
        const screen = await renderScreen(<AppPaneProvider><WorkflowBuiltinEditorHostScreen workflow={builtin.id} intent="run" /></AppPaneProvider>, {
            createNodeMock: () => ({ measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40) }),
        });
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        const body = screen.root.findByType(WorkflowEditorBody);
        expect(body.props.documentPresentation).toMatchObject({ editable: false });
        expect(body.props.onSave).toBeUndefined();
        expect(body.props.onDuplicate).toBeTypeOf('function');
        expect(screen.findByTestId('workflow-builtin-settings-toggle')).not.toBeNull();
        expect(screen.findByTestId('workflow-builtin-duplicate')).not.toBeNull();
        expect(screen.findByTestId('workflow-builtin-run-now')).not.toBeNull();
        const { WorkflowRunComposer } = await import('../run/WorkflowRunComposer');
        expect(screen.root.findAllByType(WorkflowRunComposer)).toHaveLength(1);
        expect(body.findAllByType(AgentInput).every(input => input.props.disabled === true)).toBe(true);
        const { walkWorkflowBlocks } = await import('@happier-dev/protocol/workflows/workflowDefinitionEditV1');
        const step = walkWorkflowBlocks(builtin.definition.blocks).find(block => block.kind === 'step');
        if (!step || step.kind !== 'step') throw new Error('The shipped builtin must contain an Agent prompt');
        expect(body.findAll(node => String(node.type) === 'Text' && node.props.selectable === true && node.children.includes(step.document.text))).not.toHaveLength(0);
        expect(body.findAll(node => String(node.type) === 'MultiTextInput')).toHaveLength(0);
        expect(body.findAll(node => typeof node.props.testID === 'string' && /(?:composer-send|dictation|voice-composer)/u.test(node.props.testID))).toHaveLength(0);
        await screen.pressByTestIdAsync('workflow-builtin-settings-toggle');
        const { WorkflowInspector } = await import('../editor/WorkflowInspector');
        expect(screen.root.findAllByType(WorkflowInspector).some(inspector => inspector.props.documentEditable === false)).toBe(true);
        expect(screen.findByTestId('workflow-builtin-group-agent')).not.toBeNull();
    });

    it('reopens the catalog composer with recovery enabled and rejoins its exact unresolved admission', async () => {
        const { getBuiltinWorkflowCatalogV1, WorkflowRunStartRequestV1Schema, WorkflowRunGetResultV1Schema } = await import('@happier-dev/protocol');
        const { WorkflowRunComposer } = await import('../run/WorkflowRunComposer');
        const builtin = getBuiltinWorkflowCatalogV1().find(entry => entry.id === 'builtin:plan-with-a-panel')!;
        const inputs = { request: 'Plan the next release' };
        let startedId: string | null = null;
        let admitted = false;
        const detailFor = (runId: string) => WorkflowRunGetResultV1Schema.parse({
            run: createWorkflowRunSummaryFixture({ id: runId, origin: { kind: 'direct' } }),
            callerAccess: { canEdit: true },
            definition: builtin.definition, authoredDefinition: builtin.definition, checkpoint: null,
            acceptedContext: { startedBy: 'user', source: { kind: 'catalog', ref: builtin.id, version: builtin.version },
                inputs, machineId: 'machine-1', executionTarget: { kind: 'session' },
                materializedLeaves: [], frozenChildren: {},
                workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } }, origin: { kind: 'direct' } },
        });
        runFailure = { errorCode: 'workflow_outcome_unresolved', error: 'Lost reply' };
        runStart.mockImplementation(async request => {
            startedId = request.runId;
            return null;
        });
        home.answer(appliedHome.serverId, storageRoute, { select: async input => {
            if (!input || typeof input !== 'object' || !('operation' in input)) throw new Error('Expected a storage request');
            if (input.operation === 'get' && admitted && startedId) return { body: await acceptedStorage(detailFor(startedId)) };
            if (input.operation === 'invocations.list' && admitted) return { body: {
                invocations: [], nextCursor: null, parentRevision: 1, progressEnvelopesByInvocationId: {},
            } };
            return { status: 404, body: { error: 'run_not_found' } };
        } });
        const screen = await renderScreen(<AppPaneProvider><WorkflowBuiltinEditorHostScreen workflow={builtin.id} intent="run" /></AppPaneProvider>, {
            createNodeMock: () => ({ measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40) }),
        });
        await act(async () => { screen.root.findByType(WorkflowRunComposer).props.onRun(inputs); });
        expect(startedId).not.toBeNull();
        expect(screen.root.findByType(WorkflowRunComposer).props).toMatchObject({ pending: false, reconciling: false,
            startProblem: { message: 'workflows.problem.unresolvedOutcome' } });
        const original = startRequests()[0];
        await act(async () => { screen.root.findByType(WorkflowRunComposer).props.onCancel(); });
        expect(screen.root.findAllByType(WorkflowRunComposer)).toHaveLength(0);
        await screen.pressByTestIdAsync('workflow-builtin-run-now');
        expect(screen.root.findByType(WorkflowRunComposer).props).toMatchObject({ pending: false, reconciling: false });
        expect(startRequests()).toEqual([original, original]);
        // Validate the boundary fixture outside the recovery catch, so malformed
        // transport data fails here rather than masquerading as an unknown outcome.
        await acceptedStorage(detailFor(startedId!));
        admitted = true;
        runFailure = null;
        runStart.mockImplementation(async request => ({ admission: 'existing', run: detailFor(request.runId).run }));
        await act(async () => { screen.root.findByType(WorkflowRunComposer).props.onRun({ request: 'Changed draft' }); });
        await vi.waitFor(() => expect(screen.root.findAllByType(WorkflowRunComposer)).toHaveLength(0));
        expect(startRequests()).toEqual([original, original, original]);
        expect(getStorage().getState().workflowRunsById[workflowRunStoreKey(startedId!)]?.summary?.id).toBe(startedId);
        const { router } = await import('expo-router');
        const { createWorkflowRunRoute } = await import('@/sync/domains/workflows/workflowRunRoute');
        expect(router.push).toHaveBeenLastCalledWith(createWorkflowRunRoute(startedId!, getStorage().getState().profileScope!.serverId));
    });

    it('opens the real native engine panel from the step composer and only edits authoring values', async () => {
        const definitionId = '8fab3a81-5e64-4000-8000-000000000001';
        const definition = createWorkflowDefinitionFixture({ defaults: savedAgentDefinition().defaults,
            roles: [{ roleId: 'local-reviewer', name: 'Local reviewer',
            instructions: 'Review this workflow', runsAs: { kind: 'session' } }] });
        await seedSavedDefinition(definitionId, definition);
        const screen = await renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'saved', definitionId }} /></AppPaneProvider>, {
            createNodeMock: () => ({ getBoundingClientRect: () => ({ left: 600, top: 100, width: 160, height: 40 }),
                addEventListener: () => {}, removeEventListener: () => {},
                measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40) }),
        });
        const composer = screen.root.findAllByType(AgentInput)[0]!;
        expect(composer.props.onAgentClick).toBeTypeOf('function');
        const extraActionChips = composer.props.extraActionChips;
        if (!extraActionChips) throw new Error('Missing workflow composer action chips');
        expect(extraActionChips.some((chip: { key: string }) => chip.key === 'workflow-step-engine')).toBe(false);
        await screen.pressByTestIdAsync('agent-input-agent-chip');
        const panel = screen.root.findByType(AgentInputChipPickerPanel);
        const option = panel.props.options.find((candidate: { id: string; disabled?: boolean }) => candidate.id !== 'roles' && !candidate.disabled);
        expect(option).toBeDefined();
        if (!option) throw new Error('Missing selectable workflow Agent option');
        const onSelectImmediate = option.onSelectImmediate;
        if (!onSelectImmediate) throw new Error('Missing workflow Agent option handler');
        await act(async () => onSelectImmediate());
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        const body = screen.root.findByType(WorkflowEditorBody);
        const readStep = () => {
            const block = body.props.draft.blocks[0];
            if (block.kind !== 'step') throw new Error('Expected the workflow authoring step');
            return block;
        };
        const engine = readStep().execution?.engine;
        if (!engine || !('agentTarget' in engine)) throw new Error('Expected the workflow Agent engine');
        expect(engine.agentTarget).toBeDefined();
        expect(readStep().execution?.agentTarget).toBeUndefined();
        expect(readStep().execution?.modelSelection).toBeUndefined();
        await act(async () => body.props.onChange({ ...body.props.draft, blocks: [{ ...readStep(),
            execution: { ...readStep().execution, sessionConfigOptionOverrides: { v: 1, updatedAt: 1,
                overrides: { budget: { value: 42, updatedAt: 1 } } } } }] }));
        const { NewSessionEngineOptionDetail } = await import('@/components/sessions/new/components/NewSessionEngineOptionDetail');
        await screen.pressByTestIdAsync(`agent-input-chip-picker.option:${option.id}`);
        const detail = screen.root.findByType(NewSessionEngineOptionDetail);
        const onSelectionChange = detail.props.onSelectionChange;
        if (!onSelectionChange) throw new Error('Missing workflow engine detail selection handler');
        await act(async () => onSelectionChange({ modelId: 'selected-model', modelSelection: null, modelLabel: null,
            sessionModeId: 'default', configOverrides: { reasoning_effort: 'high' } }));
        expect(readStep().execution?.engine).toMatchObject({
            modelSelection: { ref: { modelId: 'selected-model' } }, effort: 'high',
        });
        expect(detail.props.selectedModelId).toBe('selected-model');
        expect(detail.props.selectedConfigOverrides?.reasoning_effort).toBe('high');
        expect(readStep().execution?.sessionConfigOptionOverrides?.overrides.budget?.value).toBe(42);
        const { validateWorkflowEditorDraft } = await import('@/sync/domains/workflows/workflowAuthoring');
        expect(validateWorkflowEditorDraft(body.props.draft).valid).toBe(true);
        await screen.pressByTestIdAsync('agent-input-chip-picker.option:roles');
        await screen.pressByTestIdAsync('roles-rail-option:local-reviewer');
        expect(readStep().execution?.engine).toEqual({ role: 'local-reviewer' });
        expect(readStep().execution?.agentTarget).toBeUndefined();
        expect(readStep().execution?.modelSelection).toBeUndefined();
        expect(validateWorkflowEditorDraft(body.props.draft).valid).toBe(true);
        expectNoWorkflowWrites();
        expect(home.requests.filter(request => request.path === '/v1/actions/session.spawn_new')).toHaveLength(0);
        await screen.pressByTestIdAsync(`workflow-editor-step-${readStep().id}-customize`);
        const { WorkflowStepInspector } = await import('../editor/WorkflowStepInspector');
        const inspector = screen.root.findByType(WorkflowStepInspector);
        await screen.pressByTestIdAsync(`${inspector.props.testIDPrefix}-agentTarget-reset`);
        expect(readStep().execution?.engine).toBeUndefined();
        expect(readStep().execution?.acpSessionModeId).toBeUndefined();
        expect(readStep().execution?.sessionConfigOptionOverrides).toBeUndefined();
    });

    it('makes a Can-use recipient’s personal triggers reachable and saves them through the real page without definition.update', async () => {
        const definitionId = '8fab3a81-5e64-4000-8000-000000000001';
        await seedSavedDefinition(definitionId, savedAgentDefinition(), 'Shared workflow', 'view');
        // Home refusal belongs to the real Automation writer; the page keeps
        // the person's trigger draft and surfaces a failed save.
        home.answer(appliedHome.serverId, 'POST /v3/automations', { status: 503, body: { error: 'target_unavailable' } });
        const screen = await renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'saved', definitionId }} /></AppPaneProvider>);
        expect(screen.findByTestId('workflow-editor-settings-toggle')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-settings-toggle');
        const section = screen.root.findByType(WorkflowTriggerSection);
        await act(async () => section.props.onChangeDraft(editWorkflowTriggerDraft(section.props.draft, {
            kind: 'add', clientId: 'personal', trigger: { kind: 'schedule', enabled: true,
                schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } },
        })));
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        const body = screen.root.findByType(WorkflowEditorBody);
        const onChangeProjectTarget = body.props.onChangeProjectTarget;
        if (!onChangeProjectTarget) throw new Error('Missing workflow Project target handler');
        await act(async () => onChangeProjectTarget({ machineId: 'machine-1', directory: '/repo' }));
        const confirmation = vi.spyOn(Alert, 'alert');
        await screen.pressByTestIdAsync('workflow-editor-save');
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findByTestId('web-modal-confirm') !== null || confirmation.mock.calls.length > 0).toBe(true);
        });
        if (screen.findByTestId('web-modal-confirm')) await screen.pressByTestIdAsync('web-modal-confirm');
        else await act(async () => { confirmation.mock.calls.at(-1)?.[2]?.find(button => button.style !== 'cancel')?.onPress?.(); });
        await vi.waitFor(() => expect(body.props.saveStatus?.kind).toBe('failed'));
        expect(automationWrites(), JSON.stringify(body.props.saveStatus)).toHaveLength(1);
        expect(definitionWrites()).toHaveLength(0);
        expect(body.props.saveStatus).toMatchObject({ kind: 'failed' });
    });

    it.each([
        { access: 'view', agentSnapshot: false, width: 1280 }, { access: 'owner', agentSnapshot: false, width: 1280 },
        { access: 'edit', agentSnapshot: false, width: 1280 }, { access: 'admin', agentSnapshot: false, width: 1280 },
        { access: 'view', agentSnapshot: true, width: 1280 }, { access: 'view', agentSnapshot: false, width: 390 },
    ] as const)('opens a saved document with effective $access access (agent snapshot: $agentSnapshot, width: $width) through the real editor', async ({ access, agentSnapshot, width }) => {
        viewport.width = width;
        const definitionId = '8fab3a81-5e64-4000-8000-000000000001';
        const definition = createWorkflowDefinitionFixture({ inputs: [], blocks: [{
            kind: 'wait', id: 'review', document: { text: 'Read the complete shared prompt', references: [], attachments: [] },
        }] });
        await seedSavedDefinition(definitionId, definition, 'Shared workflow', access);
        const screen = await renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'saved', definitionId,
            ...(agentSnapshot ? { agentRevision: { definitionId, definition, revision: { headerVersion: 2, bodyVersion: 2 },
                metadata: { title: 'Reviewed agent snapshot' }, changedBlockIds: [] } } : {}),
        }} /></AppPaneProvider>, {
            wrapper: ({ children }) => <ModalProvider>{children}</ModalProvider>,
            // The anchor's geometry is a native/DOM boundary, not editor logic.
            createNodeMock: () => ({ getBoundingClientRect: () => ({ left: 600, top: 100, width: 160, height: 40 }),
                addEventListener: () => {}, removeEventListener: () => {},
                measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40) }),
        });
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        const body = screen.root.findByType(WorkflowEditorBody);
        if (access === 'view') {
            expect(body.props.documentPresentation).toMatchObject({ editable: false });
            expect(body.props.onSave).toBeTypeOf('function');
            expect(body.props.onEditWithAgent).toBeUndefined();
            expect(body.props.triggersSection).toBeDefined();
            expect(screen.findByTestId('workflow-editor-name')).toBeNull();
            expect(screen.findByTestId('workflow-editor-save')).toBeNull();
            expect(screen.findByTestId('workflow-editor-edit-with-agent')).toBeNull();
            expect(screen.findByTestId('workflow-editor-prompt-review')).toBeNull();
            const prompts = screen.root.findAllByType(AgentInput);
            expect(prompts).toHaveLength(1);
            expect(prompts[0]?.props).toMatchObject({ value: 'Read the complete shared prompt', disabled: true });
            expect(prompts[0]?.props.onChangeText).toBeUndefined();
            expect(prompts[0]?.props.onStructuredInputMentionsChange).toBeUndefined();
            expect(screen.findByTestId(width === 390 ? 'workflow-editor-phone-settings' : 'workflow-editor-settings-toggle')).not.toBeNull();
            expect(screen.root.findAllByType(SessionAuthoringControls).every((controls) => controls.props.disabled === true)).toBe(true);
            const menuActions = body.props.menuActions;
            if (!menuActions) throw new Error('Missing read-only workflow menu actions');
            expect(menuActions.map((action: { id: string }) => action.id)).not.toContain('agent');
            expect(menuActions.map((action: { id: string }) => action.id)).not.toContain('delete');
        } else {
            expect(body.props.documentPresentation?.editable).not.toBe(false);
            expect(body.props.onSave).toBeTypeOf('function');
            expect(body.props.onEditWithAgent).toBeTypeOf('function');
            expect(screen.findByTestId('workflow-editor-name')).not.toBeNull();
        }
        expect(body.props.onRunNow).toBeTypeOf('function');
        if (access === 'view') {
            await screen.pressByTestIdAsync('workflow-editor-run-now');
            expect(screen.findByTestId('workflow-run-inputs-preview')).not.toBeNull();
            expect(screen.findByTestId('workflow-start-where-chip')).not.toBeNull();
            expect(startRequests()).toHaveLength(0);
        }
        expect(definitionWrites()).toHaveLength(0);
        expect(automationWrites()).toHaveLength(0);
    });

    it.each(['new', 'saved'] as const)('reviews an unsaved %s draft without a departure guard, then admits its inline source', async (kind) => {
        expect(captureActiveServerAccountScopeLifetime()?.isCurrent()).toBe(true);
        const seedId = storeWorkflowReviewedRunSeed(buildWorkflowReviewedRunSeed({
            run: createWorkflowRunSummaryFixture(), definition: createWorkflowDefinitionFixture({ inputs: [], blocks: [{
                kind: 'wait', id: 'review', document: { text: 'Check status', references: [], attachments: [] },
            }] }),
            acceptedContext: { startedBy: 'user', source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1',
                executionTarget: { kind: 'session' }, materializedLeaves: [], frozenChildren: {}, origin: { kind: 'direct' }, metadata: { title: 'Reviewed draft' },
                workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } },
        }));
        const definitionId = '8fab3a81-5e64-4000-8000-000000000001';
        const source = kind === 'new' ? { kind, reviewedRunSeedId: seedId } : { kind, definitionId, agentRevision: {
            definitionId, definition: createWorkflowDefinitionFixture({ inputs: [], blocks: [{
                kind: 'wait', id: 'review', document: { text: 'Check status', references: [], attachments: [] },
            }] }), revision: { headerVersion: 3, bodyVersion: 3 }, metadata: { title: 'Saved draft' }, changedBlockIds: [],
        } };
        if (source.kind === 'saved') await seedSavedDefinition(definitionId, source.agentRevision.definition, source.agentRevision.metadata.title);
        const alert = vi.spyOn(Alert, 'alert');
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { workflows: true, inbox: false, friends: false, externalSessions: false } });
        let workspace: WorkspaceNavigationContextValue | undefined;
        let editorTabId = '';
        const screen = await renderScreen(<AppPaneProvider><WorkspaceProvider enabled catalog={catalog}>{navigation => {
            workspace = navigation;
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            editorTabId ||= group.activeTabId;
            return <SplitCanvasLeafFrame leafId={group.id} isFocused isMaximized={false} showControls={false} showFocusRing={false}
                onFocus={() => {
                    navigation.activateTab(group.id, group.activeTabId);
                    navigation.dispatch({ type: 'activateTab', groupId: group.id, tabId: group.activeTabId });
                    navigation.dispatch({ type: 'focusGroup', groupId: group.id });
                }} onClose={() => {}} onToggleMaximize={() => {}}>
                {group.tabIds.map(tabId => {
                    const tab = navigation.state.tabs[tabId];
                    const visible = tabId === group.activeTabId;
                    return <DestinationInstanceHost key={tabId} tabId={tab.id} ref={tab.target} pathname={tabId === editorTabId ? '/workflows/new' : `/workflows/runs/${tab.target.params.runId}`}
                        focused={visible} visible={visible} navigation={navigation.navigationForTab(tab.id)}>
                        {tabId === editorTabId ? <WorkflowEditorHostScreen source={source} /> : <View testID="admitted-run" />}
                    </DestinationInstanceHost>;
                })}
            </SplitCanvasLeafFrame>;
        }}</WorkspaceProvider></AppPaneProvider>, {
            // Physical layout is the RN/DOM boundary; keep the real Popover and composer beneath it.
            createNodeMock: () => ({ getBoundingClientRect: () => ({ left: 600, top: 100, width: 160, height: 40 }),
                addEventListener: () => {}, removeEventListener: () => {},
                measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40) }),
        });
        await act(async () => { screen.changeTextByTestId('workflow-editor-name', 'Unsaved name'); });
        // The renderer has no native event bubbling. Exercise the real canvas capture before the button press.
        await act(async () => {
            invokeTestInstanceHandler(screen.root.findByProps({ testID: 'split-canvas-leaf-interaction-surface-group:1' }), 'onStartShouldSetResponderCapture');
        });
        await screen.pressByTestIdAsync('workflow-editor-run-now');
        expect(alert).not.toHaveBeenCalled();
        expect(startRequests()).toHaveLength(0);
        expect(screen.findByTestId('workflow-run-inputs-preview')).not.toBeNull();
        expect(screen.findByTestId('workflow-start-where-chip')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-inputs-unsaved')).not.toBeNull();
        runStart.mockImplementation(async (request) => {
            return { admission: 'created', run: createWorkflowRunSummaryFixture({ id: request.runId, origin: { kind: 'direct' } }) };
        });
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(startRequests()[0]).toMatchObject({
            metadata: { title: 'Unsaved name' }, source: { kind: 'inline', definition: { blocks: [{ kind: 'wait', id: 'review' }] } },
        });
        expect(definitionWrites()).toHaveLength(0);
        expect(alert).not.toHaveBeenCalled();
        expect(workspace?.state.tabs[workspace.state.groups[workspace.state.focusedGroupId].activeTabId].target.kind).toBe('workflowRun');
        expect(screen.findByTestId('admitted-run')).not.toBeNull();
        expect(workspace?.state.tabs[editorTabId].target.kind).not.toBe('workflowRun');
        expect(workspace?.state.tabs[editorTabId].preview).toBe(false);
        await act(async () => { workspace?.activateTab('group:1', editorTabId); });
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('Unsaved name');
        await screen.pressByTestIdAsync('workflow-editor-run-now');
        expect(screen.findByTestId('workflow-run-inputs-unsaved')).not.toBeNull();
        await act(async () => { workspace?.navigationForTab(editorTabId).push('/workflows'); });
        expect(alert).toHaveBeenCalledTimes(1);
        expect(workspace?.state.groups['group:1'].activeTabId).toBe(editorTabId);
    });
});

/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationDefinitionDetailSchema, AutomationDefinitionListItemSchema } from '@happier-dev/protocol';

import { createDeferred, createRootLayoutFeaturesResponse, invokeTestInstanceHandler, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import { createWorkflowAutomationDetailFixture } from '@/dev/testkit/harness/workflowAutomationHttpBoundary';
import { buildWorkflowProjectMemoryKeyV1 } from '@happier-dev/protocol/account/authoringMemory';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));
const push = vi.hoisted(() => vi.fn());
// Scripted replies belong to the external Home HTTP boundary; Sync and Action admission stay real.
const read = vi.hoisted(() => vi.fn());
// The phone sheet uses real DOM ref identity; viewport facts are the platform boundary.
vi.mock('react-native', async () => ({
    ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
    useWindowDimensions: () => ({ width: 800, height: 600, scale: 2, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-keyboard-controller', () => ({ useFocusedInputHandler: () => {} }));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
    .createExpoRouterMock({ params: () => route.params, router: { push } }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const rpcRequests = installSessionActionRpcBoundary(() => {
    throw Object.assign(new Error('Fixture daemon method is unavailable'), { code: 'RPC_METHOD_NOT_AVAILABLE' });
});
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { SessionTriggersRoute } = await import('@/app/(app)/session/[id]/triggers');
const { WorkflowsRoute } = await import('@/app/(app)/workflows');
const { SessionTriggersSection } = await import('@/components/workflows/triggers/SessionTriggersSection');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { ModalProvider } = await import('@/modal');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { sync } = await import('@/sync/sync');
const initialState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let portal: ReturnType<typeof installReactDomPortalBoundaryForTests> | undefined;
let serverA = '';
let serverB = '';
beforeEach(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'https://automation-route.test' });
    portal = installReactDomPortalBoundaryForTests();
    await homes.reset();
    storage.setState(initialState, true);
    route.params = {};
    read.mockReset();
    push.mockReset();
    rpcRequests.length = 0;
    serverA = await homes.addHome({ name: 'Automation Home', serverUrl: 'https://automation-route.test', accountId: 'account-a', currentAccount: true });
    serverB = await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-automation.test', accountId: 'account-b',
        active: false, currentAccount: true });
    homes.answer(serverA, '/v3/automations', { body: { automations: [], nextCursor: null } });
    homes.answer(serverA, '/v3/automations/automation-42', { select: async () => {
        const value: unknown = await read();
        return value instanceof Response ? { body: await value.json(), status: value.status } : { body: value };
    } });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://automation-route.test');
    if (!credentials) throw new Error('Automation Home credentials are missing');
    connection = await restoreServerAccountForTest({ serverUrl: 'https://automation-route.test', accountId: 'account-a', credentials,
        additionalRequestOrigins: ['https://other-automation.test'], request: homes.request });
    await sync.awaitBootstrapForegroundAcquisition();
});
afterEach(async () => {
    try {
        standardCleanup();
        await connection?.dispose(); connection = undefined;
        await homes.reset();
        storage.setState(initialState, true);
    } finally {
        portal?.restore(); portal = undefined;
        browser?.restore(); browser = undefined;
    }
});

function AccountBoundary({ children }: React.PropsWithChildren) {
    if (!connection) throw new Error('Automation Account is not restored');
    return <InjectedAuthProvider credentials={connection.credentials}><ModalProvider><AppPaneProvider>{children}</AppPaneProvider></ModalProvider></InjectedAuthProvider>;
}
function renderRoute(element: React.ReactElement) {
    return renderScreen(element, { wrapper: AccountBoundary });
}

function automation(workflowDefinitionId: string | null = null) {
    return AutomationDefinitionDetailSchema.parse({
        id: 'automation-42', name: 'Daily standup', enabled: true, description: null,
        triggers: [], targetType: 'newSession', existingSessionId: null, templateVersion: 1,
        workflowDefinitionId, assignments: [], lastRunAt: null, createdAt: 1, updatedAt: 1,
        templateCiphertext: 'retained-template-not-opened-by-redirect',
    });
}
async function seedWorkflow(serverId: string, definitionId: string, title: string) {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
    const account = await captureLazyActionAccountContext(serverId);
    try {
        await createWorkflowDefinition({ definitionId, definition: createWorkflowDefinitionFixture({ blocks: [{
            kind: 'wait', id: 'review', document: { text: 'Review the repository', references: [], attachments: [] },
        }] }),
            metadata: { title }, accountLifetime: account.accountLifetime });
    } finally { account.dispose(); }
}
async function mount(kind: 'edit' | 'detail' = 'edit') {
    const body = kind === 'edit' ? (await import('@/app/(app)/automations/edit')).AutomationEditRoute
        : (await import('@/app/(app)/automations/[id]')).AutomationDetailRoute;
    return renderRoute(React.createElement(body));
}
function href(screen: Awaited<ReturnType<typeof mount>>) {
    return screen.findAll((node) => String(node.type) === 'Redirect')[0]?.props.href;
}
async function resolvedHref(kind: 'edit' | 'detail' = 'edit') {
    const screen = await mount(kind);
    await waitForHomeGovernance(() => expect(href(screen)).toBeDefined());
    const destination = href(screen);
    await screen.unmount();
    return destination;
}

describe('retired Automation routes', () => {
    it.each([null, 'home-b', 'unknown-home'])('redirects an occurrence bookmark with its original Home qualifier (%s)', async (serverId) => {
        route.params = { id: 'automation-42', runId: 'run-1', ...(serverId ? { serverId } : {}) };
        const { AutomationRunDetailRoute } = await import('@/app/(app)/automations/[id]/runs/[runId]');
        const screen = await renderRoute(<AutomationRunDetailRoute />);
        expect(href(screen)).toBe(`/workflows/runs/run-1?target=occurrence&automationId=automation-42${serverId ? `&serverId=${serverId}` : ''}`);
    });
    it('redirects an empty edit link even when the old Automation feature is unavailable', async () => {
        expect(await resolvedHref()).toBe('/workflows');
        expect(read).not.toHaveBeenCalled();
    });
    it.each(['edit', 'detail'] as const)('resolves %s to its bound workflow and reveals the trigger section', async (kind) => {
        route.params = { id: ' automation-42 ' };
        const workflowId = '11111111-1111-4111-8111-111111111111';
        read.mockResolvedValue(automation(workflowId));
        expect(await resolvedHref(kind)).toEqual({ pathname: '/workflows/[id]', params: { id: workflowId, intent: 'schedule', serverId: serverA } });
    });
    it('opens a legacy trigger without a conversion or a second editor', async () => {
        route.params = { id: 'automation-42' };
        read.mockResolvedValue(automation());
        expect(await resolvedHref()).toEqual({ pathname: '/workflows', params: { trigger: 'automation-42', serverId: serverA } });
    });
    it('resolves a Home-qualified definition from B while A has the same id', async () => {
        const workflowB = '22222222-2222-4222-8222-222222222222';
        read.mockResolvedValue(automation('11111111-1111-4111-8111-111111111111'));
        homes.answer(serverB, '/v3/automations/automation-42', { body: automation(workflowB) });
        route.params = { id: 'automation-42', serverId: serverB };
        expect(await resolvedHref()).toEqual({ pathname: '/workflows/[id]', params: { id: workflowB, intent: 'schedule', serverId: serverB } });
        expect(read).not.toHaveBeenCalled();
    });
    it('never falls back to A for an unknown Home', async () => {
        read.mockResolvedValue(automation());
        route.params = { id: 'automation-42', serverId: 'unknown-home' };
        expect(await resolvedHref()).toEqual({ pathname: '/workflows', params: { automationUnavailable: '1' } });
        expect(read).not.toHaveBeenCalled();
    });
    it('keeps a B trigger draft through source unmount and refuses another Account intake', async () => {
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { useOpenTriggerAsWorkflow } = await import('@/components/workflows/triggers/useOpenTriggerAsWorkflow');
        const { readTriggerWorkflowSeed } = await import('@/components/workflows/triggers/triggerWorkflowSeed');
        const source = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(serverB);
            return { binding, open: useOpenTriggerAsWorkflow(binding) };
        });
        await waitForHomeGovernance(() => expect(source.getCurrent().binding?.isCurrent()).toBe(true));
        await act(async () => source.getCurrent().open({ kind: 'inline', definition: createWorkflowDefinitionFixture() },
            { scope: 'account', automationId: 'automation-42', expectedRevision: 1 }));
        const destination = push.mock.calls[0]?.[0];
        expect(destination.params.serverId).toBe(serverB);
        const id = destination.params.triggerWorkflowSeedId;
        await source.unmount();
        expect(readTriggerWorkflowSeed(id, { serverId: serverB, accountId: 'account-b' })).not.toBeNull();
        expect(readTriggerWorkflowSeed(id, { serverId: serverB, accountId: 'different-account' })).toBeNull();
        expect(readTriggerWorkflowSeed(id, { serverId: serverA, accountId: 'account-a' })).toBeNull();
    });
    it('duplicates an addressed catalog definition into B without borrowing A placement', async () => {
        const { getBuiltinWorkflowCatalogV1 } = await import('@happier-dev/protocol');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { WorkflowAccountLifetimeProvider } = await import('@/components/workflows/workflowAccountScope');
        const { WorkflowBuiltinEditorHostScreen } = await import('@/components/workflows/screens/WorkflowCatalogEditorHostScreen');
        const { WorkflowEditorBody } = await import('@/components/workflows/screens/WorkflowEditorBody');
        const { readWorkflowDefinitionDraftSeed } = await import('@/sync/domains/workflows/workflowDefinitionDraftSeed');
        const builtin = getBuiltinWorkflowCatalogV1().find(entry => !entry.requiresOriginSession)!;
        storage.setState({ authoringMemory: { ...storage.getState().authoringMemory,
            recentMachinePaths: [{ machineId: 'machine-a', path: '/account-a' }] },
            machines: { 'machine-a': createMachineFixture({ id: 'machine-a' }) } });
        function Catalog() {
            const { binding } = useServerCredentialAccountScopeBinding(serverB);
            return binding ? <WorkflowAccountLifetimeProvider value={binding}>
                <WorkflowBuiltinEditorHostScreen workflow={builtin.id} />
            </WorkflowAccountLifetimeProvider> : null;
        }
        const screen = await renderRoute(<Catalog />);
        await waitForHomeGovernance(() => expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(1));
        expect(screen.findAllByType(WorkflowEditorBody)[0]!.props.projectTarget).toBeNull();
        await act(async () => screen.findAllByType(WorkflowEditorBody)[0]!.props.onDuplicate());
        const destination = push.mock.calls[0]?.[0];
        expect(destination.params.serverId).toBe(serverB);
        expect(readWorkflowDefinitionDraftSeed(destination.params.definitionDraftSeedId, { serverId: serverB, accountId: 'account-b' })).not.toBeNull();
        expect(readWorkflowDefinitionDraftSeed(destination.params.definitionDraftSeedId, { serverId: serverA, accountId: 'account-a' })).toBeNull();
    });
    it('the saved trigger destination reads and saves B while A has the same workflow', async () => {
        const workflowId = '22222222-2222-4222-8222-222222222222';
        await seedWorkflow(serverA, workflowId, 'A workflow');
        await seedWorkflow(serverB, workflowId, 'B workflow');
        homes.requests.splice(0);
        homes.answer(serverB, '/v1/features', { body: createRootLayoutFeaturesResponse({ features: {
            workflows: { enabled: true }, automations: { enabled: true },
        } }) });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        await getServerFeaturesSnapshot({ serverId: serverB, force: true });
        const projectA = { machineId: 'machine-a', directory: '/account-a' };
        const projectB = { machineId: 'machine-b', directory: '/account-b' };
        const memoryKey = buildWorkflowProjectMemoryKeyV1(workflowId);
        homes.answer(serverA, `GET /v1/account/authoring-memory/${encodeURIComponent(memoryKey)}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: projectA } } });
        await sync.applyAuthoringMemoryDelta({ workflowProjectTargetsByDefinitionId: { [workflowId]: projectA } });
        storage.setState({
            machineListByServerId: { ...storage.getState().machineListByServerId,
                [serverB]: [createMachineFixture({ id: 'machine-b' })] } });
        const memory = { t: 'plain', v: projectB };
        homes.answer(serverB, 'GET /v1/account/authoring-memory', { body: { rows: [{ key: memoryKey, revision: 1, content: memory }] } });
        homes.answer(serverB, `GET /v1/account/authoring-memory/${encodeURIComponent(memoryKey)}`, {
            body: { status: 'present', revision: 1, content: memory } });
        homes.answer(serverB, '/v3/automations', { body: { automations: [], nextCursor: null } });
        homes.answer(serverB, '/v3/automations/automation-42', { body: automation(workflowId) });
        route.params = { id: 'automation-42', serverId: serverB };
        const destination = await resolvedHref();
        route.params = destination.params;
        const { WorkflowEditorRoute } = await import('@/components/workflows/screens/WorkflowEditorRoute');
        const { WorkflowEditorBody } = await import('@/components/workflows/screens/WorkflowEditorBody');
        const screen = await renderRoute(<WorkflowEditorRoute />);
        const body = () => screen.findAllByType(WorkflowEditorBody)[0]?.props;
        await waitForHomeGovernance(() => expect(body()?.draft.name).toBe('B workflow'));
        await waitForHomeGovernance(() => expect(body()?.projectTarget).toEqual(projectB));
        await act(async () => { body()!.onChange({ ...body()!.draft, name: 'B updated' }, 'rename', true); });
        const credentialsRead = TokenStorage.getCredentialsForServerUrl.bind(TokenStorage);
        const recheck = createDeferred<void>();
        let rechecking = false;
        const credentialBoundary = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (url, options) => {
            if (url === 'https://other-automation.test') { rechecking = true; await recheck.promise; }
            return credentialsRead(url, options);
        });
        try {
            const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
            await act(async () => { await upsertServerProfile({ serverUrl: 'https://other-automation.test', name: 'B renamed' }); });
            await waitForHomeGovernance(() => expect(rechecking).toBe(true));
            expect(body()?.draft.name).toBe('B updated');
            await act(async () => { body()!.onSave(); });
            expect(homes.requests.filter(request => request.path.includes(`/v1/artifacts/${workflowId}`)
                && request.input !== null)).toEqual([]);
        } finally {
            recheck.resolve();
            credentialBoundary.mockRestore();
        }
        const { WorkflowEditorHostScreen } = await import('@/components/workflows/screens/WorkflowEditorHostScreen');
        await waitForHomeGovernance(() => expect(screen.findAllByType(WorkflowEditorHostScreen)[0]?.props.accountLifetime?.isCurrent()).toBe(true));
        expect(body()?.draft.name).toBe('B updated');
        await act(async () => { body()!.onSave(); });
        await waitForHomeGovernance(() => expect(homes.requests.some(request => request.serverId === serverB
            && request.path.includes(`/v1/artifacts/${workflowId}`) && request.input !== null)).toBe(true));
        expect(homes.requests.filter(request => request.serverId === serverA && request.path.includes(`/v1/artifacts/${workflowId}`)
            && request.input !== null)).toEqual([]);
        expect(storage.getState().authoringMemory.workflowProjectTargetsByDefinitionId[workflowId]).toEqual(projectA);
    });
    it('a reviewed B Plan never offers report-back from A same-id owned Session', async () => {
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { WorkflowEditorHostScreen } = await import('@/components/workflows/screens/WorkflowEditorHostScreen');
        const { WorkflowRunComposer } = await import('@/components/workflows/run/WorkflowRunComposer');
        const { storeWorkflowReviewedRunSeed } = await import('@/sync/domains/workflows/workflowReviewedRunSeed');
        const originSessionId = 'shared-plan-origin';
        installSessionActionFixture({ homes, storage, serverId: serverB, session: { id: originSessionId, accessLevel: 'view' } });
        installSessionActionFixture({ homes, storage, serverId: serverA, session: { id: originSessionId, accessLevel: 'admin' } });
        function PlanEditor() {
            const { binding } = useServerCredentialAccountScopeBinding(serverB);
            return binding ? <BoundPlanEditor accountLifetime={binding} /> : null;
        }
        function BoundPlanEditor({ accountLifetime }: Readonly<{ accountLifetime: NonNullable<ReturnType<typeof useServerCredentialAccountScopeBinding>['binding']> }>) {
            const [seedId] = React.useState(() => storeWorkflowReviewedRunSeed({ name: 'B Plan',
                project: { machineId: 'machine-b', directory: '/account-b' },
                definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'review',
                    document: { text: 'Review the Plan', references: [], attachments: [] } }] }),
                inputs: {}, executionTarget: { kind: 'session' }, sourceRunId: 'plan-run',
                planReview: { invocationId: 'held', expectedContentRevision: '1', value: { document: 'B Plan' },
                    completeReview: false, originSessionId },
            }, accountLifetime));
            return <WorkflowEditorHostScreen source={{ kind: 'new', reviewedRunSeedId: seedId }} accountLifetime={accountLifetime} />;
        }
        const screen = await renderRoute(<PlanEditor />);
        await waitForHomeGovernance(() => expect(screen.findAllByType(WorkflowRunComposer)).toHaveLength(1));
        expect(screen.findByTestId('workflow-plan-report-chip') === null).toBe(true);
    });
    it('the inline trigger destination reads and updates B without publishing it into A', async () => {
        const detail = createWorkflowAutomationDetailFixture({ id: 'automation-42', revision: 1,
            triggerId: 'scheduled', definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'review',
                document: { text: 'Review the repository', references: [], attachments: [] } }] }) });
        const scheduled = detail.triggers[0];
        if (scheduled?.kind !== 'schedule') throw new Error('Expected a scheduled fixture');
        scheduled.schedule = { kind: 'cron', scheduleExpr: '0 19 * * *', everyMs: null, timezone: null };
        const { executionRecipe: _recipe, triggers, ...listed } = detail;
        const list = AutomationDefinitionListItemSchema.parse({ ...listed,
            triggers: triggers.map(({ triggerDefinitionEnvelope: _envelope, ...trigger }) => trigger) });
        homes.answer(serverB, '/v3/automations', { body: { automations: [list], nextCursor: null } });
        homes.answer(serverB, 'GET /v3/automations/automation-42', { body: detail });
        homes.answer(serverB, 'PUT /v3/automations/automation-42', { body: { ...detail, enabled: false, templateVersion: 2 } });
        route.params = { id: 'automation-42', serverId: serverB };
        const destination = await resolvedHref();
        route.params = destination.params;
        const { AccountTriggersSection } = await import('@/components/workflows/triggers/AccountTriggersSection');
        const { Switch } = await import('@/components/ui/forms/Switch');
        const { FieldValueItem } = await import('@/components/ui/forms/FieldValueItem');
        const { TriggerPopover } = await import('@/components/workflows/triggers/TriggerPopover');
        const screen = await renderRoute(<AccountTriggersSection first />);
        const toggleId = 'workflows-column:trigger:automation-42-switch';
        await waitForHomeGovernance(() => expect(screen.findByTestId(toggleId)).not.toBeNull());
        const timeField = () => screen.findAllByType(FieldValueItem).find(node => node.props.title === 'workflows.triggers.popover.at');
        await waitForHomeGovernance(() => expect(timeField()?.props.value).toBe('19:00'));
        await act(async () => { timeField()!.props.onCommit('21:37'); });
        const credentialsRead = TokenStorage.getCredentialsForServerUrl.bind(TokenStorage);
        const recheck = createDeferred<void>();
        let rechecking = false;
        const credentialBoundary = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (url, options) => {
            if (url === 'https://other-automation.test') { rechecking = true; await recheck.promise; }
            return credentialsRead(url, options);
        });
        try {
            const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
            await act(async () => { await upsertServerProfile({ serverUrl: 'https://other-automation.test', name: 'B renamed' }); });
            await waitForHomeGovernance(() => expect(rechecking).toBe(true));
            expect(timeField()?.props.value).toBe('21:37');
            await expect(screen.findAllByType(TriggerPopover)[0]!.props.onDelete()).rejects.toMatchObject({ rawCode: 'action_account_scope_changed' });
            expect(homes.requests.filter(request => request.path === '/v3/automations/automation-42' && request.input !== null)).toEqual([]);
        } finally { recheck.resolve(); credentialBoundary.mockRestore(); }
        await waitForHomeGovernance(() => expect(screen.findAllByType(TriggerPopover)[0]?.props.accountLifetime?.isCurrent()).toBe(true));
        expect(timeField()?.props.value).toBe('21:37');
        await waitForHomeGovernance(() => expect(screen.findByTestId(toggleId)).not.toBeNull());
        await act(async () => { invokeTestInstanceHandler(screen.findAllByType(Switch).find(node => node.props.testID === toggleId), 'onValueChange', false); });
        await waitForHomeGovernance(() => expect(screen.findByTestId('web-modal-confirm')).not.toBeNull());
        await act(async () => { invokeTestInstanceHandler(screen.findAll(node => node.props.testID === 'web-modal-confirm'
            && typeof node.props.onPress === 'function')[0], 'onPress'); });
        await waitForHomeGovernance(() => expect(homes.requests.some(request => request.serverId === serverB
            && request.path === '/v3/automations/automation-42' && request.input !== null)).toBe(true));
        expect(homes.requests.filter(request => request.serverId === serverA
            && request.path === '/v3/automations/automation-42' && request.input !== null)).toEqual([]);
        expect(storage.getState().workflowTriggerSetsById['automation-42']).toBeUndefined();
    });
    it('opens a session-scoped set in that session rather than the Account column', async () => {
        route.params = { id: 'automation-42' };
        read.mockResolvedValue({ ...automation(), scopeSessionId: 'session-1' });
        expect(await resolvedHref()).toEqual({ pathname: '/session/[id]/triggers', params: { id: 'session-1', serverId: serverA, trigger: 'automation-42' } });
    });
    it('resolves combined identifiers to the exact Session trigger popover', async () => {
        route.params = { id: 'automation-42' };
        const workflowId = '11111111-1111-4111-8111-111111111111';
        read.mockResolvedValue({ ...automation(workflowId), scopeSessionId: 'session-1' });
        expect(await resolvedHref()).toEqual({ pathname: '/session/[id]/triggers', params: {
            id: 'session-1', serverId: serverA, trigger: 'automation-42',
        } });
    });
    it('forwards the scoped trigger identity through the Session alias and opens its existing row without writing', async () => {
        route.params = { id: 'session-1', serverId: serverA, trigger: 'automation-42' };
        const alias = await renderRoute(<SessionTriggersRoute />);
        const destination = href(alias);
        await alias.unmount();
        expect(destination).toEqual({ pathname: '/session/[id]/info', params: {
            id: 'session-1', serverId: serverA, trigger: 'automation-42',
        } });
        route.params = destination.params;
        const workflowId = '11111111-1111-4111-8111-111111111111';
        await seedWorkflow(serverA, workflowId, 'Daily standup');
        installSessionActionFixture({ homes, storage, serverId: serverA, session: { id: 'session-1', active: false } });
        const detail = (automationId: string, hour: number) => {
            const { templateCiphertext: _retainedTemplate, ...base } = automation(workflowId);
            return AutomationDefinitionDetailSchema.parse({ ...base, id: automationId, templateVersion: 4, scopeSessionId: 'session-1', targetType: null,
                executionRecipe: { v: 2, templateVersion: 4, triggerEvidence: null, workflow: { t: 'plain', v: {
                    workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
                } } },
            triggers: [{ id: `${automationId}-schedule`, revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
                kind: 'schedule', triggerDefinitionEnvelope: null, nextRunAt: null,
                schedule: { kind: 'cron', scheduleExpr: `0 ${hour} * * *`, everyMs: null, timezone: null } }] });
        };
        const selected = detail('automation-42', 19);
        selected.triggers.push(AutomationDefinitionDetailSchema.parse({ ...selected,
            triggers: [{ ...detail('automation-42', 21).triggers[0]!, id: 'automation-42-later-schedule' }],
        }).triggers[0]!);
        const rows = [detail('other-automation', 9), selected];
        // A list never carries the private envelope exposed by the detail endpoint.
        // Parse before dispatch so fixture schema mistakes fail at their author, not as a UI wait.
        const listRows = rows.map(row => {
            const { executionRecipe: _recipe, triggers, ...listed } = row;
            return AutomationDefinitionListItemSchema.parse({ ...listed,
                triggers: triggers.map(({ triggerDefinitionEnvelope: _privateEnvelope, ...trigger }) => trigger) });
        });
        const methods: string[] = [];
        homes.answer(serverA, '/v3/automations', { select: (_input, request) => {
            methods.push(request.init?.method ?? 'GET');
            return { body: { automations: listRows, nextCursor: null } };
        } });
        for (const row of rows) homes.answer(serverA, `/v3/automations/${row.id}`, { select: (_input, request) => {
            methods.push(request.init?.method ?? 'GET');
            return { body: row };
        } });
        // Like the canonical Popover DOM tests, use the browser renderer for the
        // real sheet's composed refs rather than manufacturing host identities.
        portal?.restore(); portal = undefined;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await React.act(async () => root.render(<AccountBoundary><SessionTriggersSection sessionId="session-1" /></AccountBoundary>));
            await waitForHomeGovernance(async () => {
                await React.act(async () => {});
                expect(document.querySelector('[data-testid="session-work-trigger-popover"]')).not.toBeNull();
            });
            expect(document.querySelector('[data-testid="session-work-trigger-popover"]')).not.toBeNull();
            expect([...document.querySelectorAll<HTMLInputElement>('[aria-label="workflows.triggers.popover.at"]')]
                .filter(node => node.value === '19:00').length).toBeGreaterThan(0);
            expect(methods.filter(method => method !== 'GET')).toEqual([]);
            expect(rpcRequests.filter(request => /session\.trigger\.(add|update|remove)$/.test(request.method))).toEqual([]);
        } finally {
            await React.act(async () => root.unmount());
            container.remove();
        }
    });
    it('lands a deleted Automation in Workflows with the not-available line', async () => {
        route.params = { id: 'automation-42' };
        read.mockResolvedValue(Response.json({ error: 'automation_not_found' }, { status: 404 }));
        expect(await resolvedHref()).toEqual({ pathname: '/workflows', params: { automationUnavailable: '1' } });
    });
    it('keeps a stable loading shell and never redirects from a retired Account', async () => {
        route.params = { id: 'automation-42' };
        let finish: ((value: ReturnType<typeof automation>) => void) | undefined;
        read.mockImplementation(() => new Promise<ReturnType<typeof automation>>((resolve) => { finish = resolve; }));
        const screen = await mount();
        await waitForHomeGovernance(() => expect(finish).toEqual(expect.any(Function)));
        expect(screen.findByTestId('retired-automation-read')).not.toBeNull();
        expect(href(screen)).toBeUndefined();
        const first = finish;
        await act(async () => {
            await homes.switchAccount(serverA, 'account-b', { currentAccount: true });
            await sync.awaitBootstrapForegroundAcquisition();
        });
        const oldWorkflowId = '22222222-2222-4222-8222-222222222222';
        await act(async () => { first?.(automation(oldWorkflowId)); });
        expect(href(screen)).toBeUndefined();
        await waitForHomeGovernance(() => expect(finish).not.toBe(first));
        await act(async () => { finish?.(automation()); });
        await waitForHomeGovernance(() => expect(href(screen)).toBeDefined());
        expect(href(screen)).not.toEqual({ pathname: '/workflows/[id]', params: { id: oldWorkflowId, intent: 'schedule' } });
    });
    it('keeps a transport failure visible with Retry instead of claiming the Automation was deleted', async () => {
        route.params = { id: 'automation-42' };
        read.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
        const screen = await mount();
        await waitForHomeGovernance(() => expect(screen.findByTestId('retired-automation-read-retry')).not.toBeNull());
        expect(href(screen)).toBeUndefined();
        expect(screen.findByTestId('retired-automation-read-retry')).not.toBeNull();
        read.mockResolvedValue(automation());
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('retired-automation-read-retry'),
                'onClick',
                new browser!.window.MouseEvent('click', { bubbles: true }),
            );
        });
        await waitForHomeGovernance(() => expect(href(screen)).toBeDefined());
        expect(href(screen)).toEqual({ pathname: '/workflows', params: { trigger: 'automation-42', serverId: serverA } });
    });
    it('shows the prescribed not-available line at the Workflows destination', async () => {
        route.params = { automationUnavailable: '1' };
        const screen = await renderRoute(<WorkflowsRoute />);
        expect(screen.findByTestId('retired-automation-unavailable')).not.toBeNull();
    });
    it('keeps exact-turn identity on a retired create link for the session trigger owner to validate', async () => {
        route.params = { sourceSessionId: 'session-1', sourceTurnId: 'turn-9', sourceServerId: 'server-a', sessionLifecycleEvents: 'parentTurnCompleted' };
        const { RetiredAutomationCreateRoute } = await import('@/app/(app)/automations/new');
        const screen = await renderRoute(<RetiredAutomationCreateRoute />);
        expect(href(screen)).toEqual({ pathname: '/session/[id]/triggers', params: {
            id: 'session-1', serverId: 'server-a', sourceSessionId: 'session-1', sourceTurnId: 'turn-9',
            sourceServerId: 'server-a', sessionLifecycleEvents: 'parentTurnCompleted',
        } });
    });
});

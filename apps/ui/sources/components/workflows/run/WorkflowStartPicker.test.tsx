import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_WORKFLOW_CATALOG_V1, WORKFLOW_STARTER_EXAMPLES_V1, PluginProjectionV2Schema, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import { t } from '@/text';
import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storageStore';
import { Modal } from '@/modal';
import { WorkflowsLibraryHome } from '../library/WorkflowsLibraryHome';
import { SavedWorkflowRoute } from '@/app/(app)/workflows/[id]/index';
import { useSessionBuiltinWorkflowStart } from '@/components/sessions/agents/launch/useSessionBuiltinWorkflowStart';
import { SessionAgentsLaunchMenu } from '@/components/sessions/agents/launch/SessionAgentsLaunchMenu';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { WorkflowStartPicker } from './WorkflowStartPicker';
import { WorkflowRunComposer } from './WorkflowRunComposer';
import { resetWorkflowLibraryReadsForTests } from '../library/workflowLibraryReads';
import { WorkflowsColumnActions } from '../column/WorkflowsColumnActions';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { Artifact, ArtifactCreateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { createWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import { SelectionList } from '@/components/ui/selectionList';

const withPanes = ({ children }: React.PropsWithChildren) => <AppPaneProvider>{children}</AppPaneProvider>;

const machineRpc = vi.hoisted(() => vi.fn());
const routing = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const routeParams = vi.hoisted(() => ({ id: 'plugin:example.recipe/check', intent: undefined as string | undefined }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: routeParams, router: routing }).module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
installDisconnectedServerSocketBoundary();
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

let previousState = storage.getState();
let home: Awaited<ReturnType<typeof serveActionHomes>>;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
const artifacts = new Map<string, Artifact>();
let delayedRead: Promise<Response> | null = null;
const plugin = {
    workflow: 'plugin:example.recipe/check', pluginId: 'example.recipe', version: '1.2.3',
    title: 'Check changes', definition: BUILTIN_WORKFLOW_CATALOG_V1[0]!.definition,
};
function installPluginProjection() {
    machineRpc.mockImplementation(async (request: { method: string; payload: Record<string, unknown> }) => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            return { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                installedPackagesById: { [plugin.pluginId]: { id: plugin.pluginId, displayName: plugin.title,
                    version: plugin.version, enabled: true, source: { kind: 'path', locator: '/plugins/example.recipe' } } },
                familiesById: { workflows: { family: 'workflows', entriesById: {
                    'example.recipe/check': { id: 'example.recipe/check', pluginId: plugin.pluginId, pluginVersion: plugin.version,
                        definition: { id: 'check', title: plugin.title, definition: plugin.definition } },
                } } },
            }) };
        }
        if (request.method === 'workflow.run.start') {
            const input = request.payload.input as { runId: string };
            return { admission: 'created', run: createWorkflowRunSummaryFixture({ id: input.runId }) };
        }
        throw new Error(`Unexpected workflow machine RPC: ${request.method}`);
    });
}
function writes() {
    return home.requests.filter((request) => {
        if (request.method === 'GET') return false;
        const body = request.body as { operation?: string } | undefined;
        return request.path !== '/v3/automations/runs/workflow-storage' || !['list', 'summaries'].includes(body?.operation ?? '');
    });
}
function starts() { return machineRpc.mock.calls.map(([request]) => request).filter((request) => request.method === 'workflow.run.start'); }
async function seedUnavailableWorkflowDefinitions() {
    const ids = {
        missingTitle: '00000000-0000-4000-8000-000000000011',
        badBody: '00000000-0000-4000-8000-000000000012',
        readable: '00000000-0000-4000-8000-000000000013',
    };
    for (const [definitionId, title] of [
        [ids.missingTitle, 'Title to corrupt'], [ids.badBody, 'Unavailable recipe'], [ids.readable, 'Readable recipe'],
    ] as const) {
        await createWorkflowDefinition({ definitionId, definition: plugin.definition, metadata: { title } });
    }
    const missingTitle = artifacts.get(ids.missingTitle);
    const badBody = artifacts.get(ids.badBody);
    if (!missingTitle || !badBody) throw new Error('Actual workflow Artifact writes are unavailable');
    // Corrupt Home storage bytes, not the Action result: the real Artifact
    // codec and workflow document reader decide the per-row refusal.
    artifacts.set(ids.missingTitle, { ...missingTitle,
        header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' }) });
    artifacts.set(ids.badBody, { ...badBody,
        body: encodePlainArtifactStoredContent({ body: 'invalid-workflow-json' }) });
    home.requests.length = 0;
    return ids;
}
beforeEach(async () => {
    routeParams.id = 'plugin:example.recipe/check';
    routeParams.intent = undefined;
    previousState = storage.getState();
    artifacts.clear();
    delayedRead = null;
    machineRpc.mockReset();
    machineRpc.mockResolvedValue({ protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1 }) });
    connection = await restoreServerAccountForTest({ serverUrl: 'http://workflow-picker.test', accountId: 'workflow-picker-account' });
    home = await serveActionHomes({ homes: [{ key: 'picker', serverUrl: 'http://workflow-picker.test', accountId: 'workflow-picker-account' }],
        route: async (request) => {
            if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (request.path === '/v1/artifacts') {
                if (request.method !== 'POST') return delayedRead ?? Response.json([...artifacts.values()]);
                const input = request.body as ArtifactCreateRequest;
                const artifact: Artifact = { ...input, ownerAccountId: request.accountId!, access: 'owner', encryptionMode: 'plain',
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
                artifacts.set(artifact.id, artifact);
                return Response.json(artifact);
            }
            if (request.path.startsWith('/v1/artifacts/')) {
                const artifact = artifacts.get(request.path.slice('/v1/artifacts/'.length));
                return Response.json(artifact ?? { error: 'not_found' }, { status: artifact ? 200 : 404 });
            }
            if (request.path === '/v3/automations') return Response.json({ automations: [], nextCursor: null });
            if (request.path === '/v3/automations/runs/workflow-storage') {
                const input = request.body as { operation: string };
                return Response.json(input.operation === 'summaries'
                    ? { summaries: [], remainingSourceArtifactIds: [] }
                    : { runs: [] });
            }
            return undefined;
        } });
    const server = home.homes.picker!;
    const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now() });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [server.id]: [machine] } });
    storage.setState({ settings: { ...storage.getState().settings, experiments: true,
        featureToggles: { ...storage.getState().settings.featureToggles, automations: true } } });
    primeServerFeaturesSnapshot({ serverId: server.id, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
});
afterEach(async () => {
    standardCleanup();
    resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    home.dispose();
    await connection.dispose();
    machineRpc.mockReset();
    clearDaemonMergedProjectionCacheForTests();
    resetServerFeaturesClientForTests();
    routing.push.mockClear();
    routing.replace.mockClear();
    vi.mocked(Modal.show).mockClear();
    storage.setState(previousState);
});

describe('WorkflowStartPicker plugin workflows', () => {
    it('keeps readable start choices when neighboring definitions are unavailable', async () => {
        const ids = await seedUnavailableWorkflowDefinitions();
        const onSelect = vi.fn();
        const screen = await renderScreen(<WorkflowStartPicker onSelect={onSelect} onRequestClose={() => {}} maxHeight={600} />);
        await act(async () => { await Promise.resolve(); });
        const root: React.ComponentProps<typeof SelectionList>['rootStep'] = screen.findByType(SelectionList).props.rootStep;
        const section = root.sections.find(entry => entry.kind === 'dynamic' && entry.id === 'library');
        if (section?.kind !== 'dynamic') throw new Error('missing_library_options');
        const choices = await section.resolve('recipe', new AbortController().signal);
        expect(choices.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: ids.badBody, disabled: true, subtitle: t('workflows.contentReasons.invalidBody') }),
            expect.objectContaining({ id: ids.readable, label: 'Readable recipe' }),
        ]));
        await act(async () => { screen.findByType(SelectionList).props.onSelect(ids.badBody); });
        expect(onSelect).not.toHaveBeenCalled();
        const allChoices = await section.resolve('', new AbortController().signal);
        expect(allChoices.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: ids.missingTitle, disabled: true, subtitle: t('workflows.contentReasons.invalidHeader') }),
        ]));
    });
    it.each(['builtin:keep-going', 'builtin:review-and-converge'])('offers Choose a session, never Run now, for %s', async (id) => {
        routeParams.id = id;
        routeParams.intent = 'run';
        const screen = await renderScreen(<SavedWorkflowRoute />, { wrapper: withPanes });
        expect(screen.findByTestId('workflow-builtin:session')).not.toBeNull();
        expect(screen.findByTestId('workflow-builtin:run')).toBeNull();
        expect(Modal.show).not.toHaveBeenCalled();
        expect(starts()).toEqual([]);
        await screen.pressByTestIdAsync('workflow-builtin:duplicate');
        const route = routing.push.mock.calls.at(-1)?.[0] as { pathname: string; params: { definitionDraftSeedId: string } };
        expect(route.pathname).toBe('/workflows/new');
        expect(readWorkflowDefinitionDraftSeed(route.params.definitionDraftSeedId)).toMatchObject({
            definition: BUILTIN_WORKFLOW_CATALOG_V1.find((entry) => entry.id === id)!.definition,
        });
        expect(writes()).toEqual([]);
    });
    it('opens the shared example picker from the column + menu without saving', async () => {
        const screen = await renderScreen(<WorkflowsColumnActions canCreate />);
        const addMenu = screen.findAllByType(DropdownMenu).find((menu) => menu.props.testID === 'workflows-column:add:menu')!;
        expect(addMenu.props.items.map((item: { id: string }) => item.id)).toEqual(['new', 'agent', 'trigger', 'example', 'import']);
        await act(async () => { addMenu.props.onSelect('example'); });
        for (const example of WORKFLOW_STARTER_EXAMPLES_V1) expect(screen.findByTestId(`workflow-examples:${example.key}:use`)).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-examples:review-pull-request:use');
        expect(routing.push).toHaveBeenCalledWith({ pathname: '/workflows/new', params: { example: 'review-pull-request' } });
        expect(writes()).toEqual([]);
        expect(starts()).toEqual([]);
    });
    it('reviews a built-in in the canonical composer before admitting its catalog source', async () => {
        routeParams.id = 'builtin:open-a-pull-request';
        storage.setState({ machines: { 'machine-1': createMachineFixture({ id: 'machine-1' }) },
            authoringMemory: { ...storage.getState().authoringMemory, recentMachinePaths: [{ machineId: 'machine-1', path: '/project' }] } });
        installPluginProjection();
        const screen = await renderScreen(<SavedWorkflowRoute />, { wrapper: withPanes });
        await screen.pressByTestIdAsync('workflow-builtin:run');
        expect(starts()).toEqual([]);
        expect(Modal.show).not.toHaveBeenCalled();
        expect(screen.findAllByType(WorkflowRunComposer)).toHaveLength(1);
        await act(async () => { screen.findByType(WorkflowRunComposer).props.onRun(undefined); });
        expect(starts()[0]?.payload).toMatchObject({
            input: { source: { kind: 'catalog', workflow: 'builtin:open-a-pull-request' } },
            target: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/project' } },
        });
    });
    it.each([false, true])('renders the canonical examples and built-ins on the home (saved=%s) without seeding persistence', async (saved) => {
        if (saved) {
            await createWorkflowDefinition({ definitionId: '00000000-0000-4000-8000-000000000003',
                definition: plugin.definition, metadata: { title: 'Saved' } });
            home.requests.length = 0;
        }
        const screen = await renderScreen(<WorkflowsLibraryHome />);
        await act(async () => { await Promise.resolve(); });
        for (const example of WORKFLOW_STARTER_EXAMPLES_V1) {
            expect(screen.findHostByTestId(`workflow-examples:${example.key}`)).not.toBeNull();
            expect(screen.findByTestId(`workflow-examples:${example.key}:use`)).not.toBeNull();
        }
        for (const builtin of BUILTIN_WORKFLOW_CATALOG_V1) {
            expect(screen.findByTestId(`workflow-builtins:${builtin.id}:${builtin.requiresOriginSession ? 'session' : 'run'}`)).not.toBeNull();
        }
        await screen.pressByTestIdAsync('workflow-examples:morning-digest:use');
        expect(routing.push).toHaveBeenCalledWith({ pathname: '/workflows/new', params: { example: 'morning-digest' } });
        expect(writes()).toEqual([]);
        expect(starts()).toEqual([]);
    });
    it('shows the plugin library even when no saved definitions or runs exist', async () => {
        installPluginProjection();
        const screen = await renderScreen(<WorkflowsLibraryHome />);
        await act(async () => { await Promise.resolve(); });
        await screen.pressByTestIdAsync(`workflows-home:row:${plugin.workflow}`);
        expect(routing.push).toHaveBeenCalledWith(`/workflows/${encodeURIComponent(plugin.workflow)}`);
        expect(home.requests.filter((request) => request.path === '/v3/automations/runs/workflow-storage')).toEqual([]);
    });

    it('opens the contribution read-only and duplicates as an unsaved portable draft without a write', async () => {
        installPluginProjection();
        const screen = await renderScreen(<SavedWorkflowRoute />, { wrapper: withPanes });
        await act(async () => { await Promise.resolve(); });
        expect(screen.findAllByTestId('workflow-plugin:read-only').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('workflow-editor-name').length).toBe(0);
        await screen.pressByTestIdAsync('workflow-plugin:duplicate');
        expect(writes()).toEqual([]);
        const route = routing.push.mock.calls.at(-1)?.[0] as { pathname: string; params: { definitionDraftSeedId: string } };
        expect(route.pathname).toBe('/workflows/new');
        expect(readWorkflowDefinitionDraftSeed(route.params.definitionDraftSeedId)).toEqual({
            definition: plugin.definition, name: t('workflows.copyName', { name: plugin.title }),
        });
    });

    it('starts plugin workflows through the session composer with origin and observed version', async () => {
        const session = createSessionFixture({ serverId: storage.getState().profileScope!.serverId });
        const machine = createMachineFixture();
        storage.setState({ sessions: { [session.id]: session }, machines: { [machine.id]: machine } });
        installPluginProjection();
        const hook = await renderHook(() => useSessionBuiltinWorkflowStart({ sessionId: session.id }));
        await act(async () => {
            hook.getCurrent()(plugin);
        });
        expect(Modal.show).toHaveBeenCalled();
        const config = vi.mocked(Modal.show).mock.calls[0]![0];
        const props = config.props as { onRun(inputs: Record<string, never>): void };
        await act(async () => { props.onRun({}); await Promise.resolve(); });
        expect(starts()).toEqual([expect.objectContaining({ machineId: 'machine-1', payload: expect.objectContaining({
            input: expect.objectContaining({ source: { kind: 'catalog', workflow: plugin.workflow, pluginVersion: plugin.version } }),
            defaultSessionId: session.id,
            target: expect.objectContaining({ kind: 'machine', machineId: 'machine-1' }),
        }) })]);
    });
    it('offers the contribution in the Work launch submenu and selects that exact source', async () => {
        installPluginProjection();
        const startPluginWorkflow = vi.fn();
        const launcher = {
            unavailableReason: null, intents: [], agentIds: [], providerLaunch: null,
            openConversation: vi.fn(), openRun: vi.fn(), openDetails: vi.fn(), startBuiltinWorkflow: vi.fn(), startPluginWorkflow,
        };
        const screen = await renderScreen(<SessionAgentsLaunchMenu launcher={launcher} testID="plugin-launch" />);
        // Native/DOM portal painting is a live gate; the real menu's public presentation
        // contract can be selected here without replacing its catalog or library logic.
        await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(true); });
        await act(async () => { await Promise.resolve(); });
        const menu = screen.findByType(DropdownMenu);
        const items: React.ComponentProps<typeof DropdownMenu>['items'] = menu.props.items;
        const pluginItem = items.find((item) => item.id === 'run-workflow')?.submenu?.items.find((item) => item.testID === `session-agents-launch:plugin:${plugin.workflow}`);
        expect(pluginItem).toMatchObject({ title: plugin.title, category: 'workflows.plugins.fromPlugins' });
        await act(async () => { menu.props.onSelect(pluginItem!.id); });
        expect(startPluginWorkflow).toHaveBeenCalledWith(plugin);
    });
    it('keeps unavailable rows visible and refuses them in the Work launch submenu', async () => {
        const ids = await seedUnavailableWorkflowDefinitions();
        installPluginProjection();
        const launcher = { unavailableReason: null, intents: [], agentIds: [], providerLaunch: null,
            openConversation: vi.fn(), openRun: vi.fn(), openDetails: vi.fn(), startBuiltinWorkflow: vi.fn(), startPluginWorkflow: vi.fn() };
        const screen = await renderScreen(<SessionAgentsLaunchMenu launcher={launcher} />);
        await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(true); });
        await act(async () => { await Promise.resolve(); });
        const menu = screen.findByType(DropdownMenu);
        const items: React.ComponentProps<typeof DropdownMenu>['items'] = menu.props.items;
        const rows = items.find(item => item.id === 'run-workflow')!.submenu!.items;
        for (const id of [ids.missingTitle, ids.badBody]) {
            const row = rows.find(item => item.id === `workflow:${id}`);
            expect(row).toMatchObject({ disabled: true, subtitle: expect.any(String) });
            await act(async () => { menu.props.onSelect(`workflow:${id}`); });
        }
        expect(routing.push).not.toHaveBeenCalled();
        expect(rows.find(item => item.id === `workflow:${ids.readable}`)?.disabled).not.toBe(true);
        await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(true); });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { screen.findByType(DropdownMenu).props.onSelect(`workflow:${ids.readable}`); });
        expect(routing.push).toHaveBeenCalledWith({ pathname: '/workflows/[id]', params: { id: ids.readable, intent: 'run' } });
        expect(rows.find(item => item.id === `plugin-workflow:${plugin.workflow}`)?.title).toBe(plugin.title);
    });
    it('does not retain or select a previous Account catalog while the closed menu changes Account', async () => {
        installPluginProjection();
        await createWorkflowDefinition({ definitionId: '00000000-0000-4000-8000-000000000003',
            definition: plugin.definition, metadata: { title: 'Private saved recipe' } });
        home.requests.length = 0;
        machineRpc.mockClear();
        const startPluginWorkflow = vi.fn();
        const launcher = { unavailableReason: null, intents: [], agentIds: [], providerLaunch: null,
            openConversation: vi.fn(), openRun: vi.fn(), openDetails: vi.fn(), startBuiltinWorkflow: vi.fn(), startPluginWorkflow };
        const screen = await renderScreen(<SessionAgentsLaunchMenu launcher={launcher} />);
        expect(home.requests).toEqual([]);
        expect(machineRpc).not.toHaveBeenCalled();
        await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(true); });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(false); });
        const next = createDeferred<Response>();
        delayedRead = next.promise;
        await act(async () => {
            home.switchAccount('picker', 'next-account');
            (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
            storage.setState({ profileScope: { serverId: storage.getState().profileScope!.serverId, accountId: 'next-account' } });
        });
        const menu = screen.findByType(DropdownMenu);
        const items: React.ComponentProps<typeof DropdownMenu>['items'] = menu.props.items;
        const workflowItems = items.find((item) => item.id === 'run-workflow')!.submenu!.items;
        expect(workflowItems.some((item) => item.title === plugin.title || item.title === 'Private saved recipe')).toBe(false);
        await act(async () => { menu.props.onSelect(`plugin-workflow:${plugin.workflow}`); });
        expect(startPluginWorkflow).not.toHaveBeenCalled();
        await act(async () => { menu.props.onOpenChange(true); });
        const pendingItems: React.ComponentProps<typeof DropdownMenu>['items'] = screen.findByType(DropdownMenu).props.items;
        expect(pendingItems.find((item) => item.id === 'run-workflow')!.submenu!.items.some((item) => item.title === plugin.title)).toBe(false);
        await act(async () => { next.resolve(Response.json([])); await next.promise; });
    });
    it('selects the catalog definition with its qualified identity and observed plugin version', async () => {
        const plugin = {
            workflow: 'plugin:example.recipe/check', pluginId: 'example.recipe', version: '1.2.3',
            title: 'Check changes', definition: BUILTIN_WORKFLOW_CATALOG_V1[0]!.definition,
        };
        installPluginProjection();
        const selected = vi.fn();
        const closed = vi.fn();
        const screen = await renderScreen(<WorkflowStartPicker onSelect={selected} onRequestClose={closed} maxHeight={600} />);
        await act(async () => { await Promise.resolve(); });
        await screen.pressByTestIdAsync(`workflow-choice:${plugin.workflow}`);
        expect(selected).toHaveBeenCalledWith(expect.objectContaining({
            id: plugin.workflow, name: plugin.title, definition: plugin.definition,
            source: { kind: 'catalog', workflow: plugin.workflow, pluginVersion: plugin.version },
        }));
        expect(closed).toHaveBeenCalled();
    });
});

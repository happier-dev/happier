import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_WORKFLOW_CATALOG_V1, WORKFLOW_STARTER_EXAMPLES_V1 } from '@happier-dev/protocol';
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
import { WorkflowEditorBody } from '../screens/WorkflowEditorBody';
import { WorkflowBuiltinSessionButton } from '../library/WorkflowBuiltinsSection';
import { SelectionList } from '@/components/ui/selectionList';

const execute = vi.hoisted(() => vi.fn());
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
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
// Applied network identity is a system boundary; the Account lifetime stays real.
vi.mock('@/sync/runtime/orchestration/connectionManager', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/connectionManager')>(),
    getAppliedActiveServerSnapshot: () => snapshot(),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));
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

let snapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
let previousState = storage.getState();
beforeEach(async () => {
    routeParams.id = 'plugin:example.recipe/check';
    routeParams.intent = undefined;
    previousState = storage.getState();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    snapshot = runtime.getActiveServerSnapshot;
    const server = await runtime.upsertAndActivateServer({ serverUrl: 'http://workflow-picker.test', name: 'Workflow Home' });
    storage.setState({ profileScope: { serverId: server.id, accountId: 'workflow-picker-account' } });
    storage.setState({ settings: { ...storage.getState().settings, experiments: true,
        featureToggles: { ...storage.getState().settings.featureToggles, automations: true } } });
    primeServerFeaturesSnapshot({ serverId: server.id, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
});
afterEach(async () => {
    standardCleanup();
    resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    execute.mockReset();
    resetServerFeaturesClientForTests();
    routing.push.mockClear();
    routing.replace.mockClear();
    vi.mocked(Modal.show).mockClear();
    storage.setState(previousState);
});

describe('WorkflowStartPicker plugin workflows', () => {
    it('keeps readable start choices when neighboring definitions are unavailable', async () => {
        const revision = { headerVersion: 1, bodyVersion: 1 };
        execute.mockImplementation(async (id: string, input: { definitionId?: string }) => {
            if (id === 'workflow.definition.list') return { ok: true, result: { definitions: [
                { kind: 'workflow-definition.v1', definitionId: 'missing-title', revision: null, metadata: null,
                    contentStatus: 'unavailable', contentUnavailableReason: 'invalid_header', stepCount: null, triggers: [], nextRunAt: null },
                { kind: 'workflow-definition.v1', definitionId: 'bad-body', revision, metadata: { title: 'Unavailable recipe' },
                    contentStatus: 'unavailable', contentUnavailableReason: 'invalid_body', stepCount: null, triggers: [], nextRunAt: null },
                { kind: 'workflow-definition.v1', definitionId: 'readable', revision, metadata: { title: 'Readable recipe' },
                    contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null },
            ] } };
            if (id === 'workflow.definition.get' && input.definitionId === 'readable') return { ok: true, result: {
                definitionId: 'readable', revision, metadata: { title: 'Readable recipe' }, access: 'owner',
                definition: BUILTIN_WORKFLOW_CATALOG_V1[0]!.definition,
            } };
            return { ok: false, errorCode: 'content_unavailable', error: 'workflow_definition_content_unavailable',
                details: { reason: 'invalid_body' } };
        });
        const onSelect = vi.fn();
        const screen = await renderScreen(<WorkflowStartPicker onSelect={onSelect} onRequestClose={() => {}} maxHeight={600} />);
        await act(async () => { await Promise.resolve(); });
        const root: React.ComponentProps<typeof SelectionList>['rootStep'] = screen.findByType(SelectionList).props.rootStep;
        const section = root.sections.find(entry => entry.kind === 'dynamic' && entry.id === 'library');
        if (section?.kind !== 'dynamic') throw new Error('missing_library_options');
        const choices = await section.resolve('recipe', new AbortController().signal);
        expect(choices.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'bad-body', disabled: true, subtitle: t('workflows.contentReasons.invalidBody') }),
            expect.objectContaining({ id: 'readable', label: 'Readable recipe' }),
        ]));
        await act(async () => { screen.findByType(SelectionList).props.onSelect('bad-body'); });
        expect(onSelect).not.toHaveBeenCalled();
        const allChoices = await section.resolve('', new AbortController().signal);
        expect(allChoices.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'missing-title', disabled: true, subtitle: t('workflows.contentReasons.invalidHeader') }),
        ]));
    });
    it.each(['builtin:keep-going', 'builtin:review-and-converge'])('offers Choose a session, never Run now, for %s', async (id) => {
        routeParams.id = id;
        routeParams.intent = 'run';
        const screen = await renderScreen(<SavedWorkflowRoute />, {
            wrapper: ({ children }) => <AppPaneProvider>{children}</AppPaneProvider>,
        });
        expect(screen.findByType(WorkflowBuiltinSessionButton).props.entry.id).toBe(id);
        expect(screen.getTextContent()).toContain(t('workflows.examples.chooseSession'));
        expect(screen.findByType(WorkflowEditorBody).props.onRunNow).toBeUndefined();
        expect(screen.findAllByType(WorkflowRunComposer)).toHaveLength(0);
        expect(Modal.show).not.toHaveBeenCalled();
        expect(execute.mock.calls.some(([action]) => action === 'workflow.run.start')).toBe(false);
        await screen.pressByTestIdAsync('workflow-builtin-duplicate');
        const route = routing.push.mock.calls.at(-1)?.[0] as { pathname: string; params: { definitionDraftSeedId: string } };
        expect(route.pathname).toBe('/workflows/new');
        expect(readWorkflowDefinitionDraftSeed(route.params.definitionDraftSeedId)).toMatchObject({
            definition: BUILTIN_WORKFLOW_CATALOG_V1.find((entry) => entry.id === id)!.definition,
        });
        expect(execute.mock.calls.some(([action]) => action === 'workflow.definition.create')).toBe(false);
    });
    it('opens the shared example picker from the column + menu without saving', async () => {
        const screen = await renderScreen(<WorkflowsColumnActions canCreate />);
        const addMenu = screen.findAllByType(DropdownMenu).find((menu) => menu.props.testID === 'workflows-column:add:menu')!;
        expect(addMenu.props.items.map((item: { id: string }) => item.id)).toEqual(['new', 'agent', 'trigger', 'example', 'import']);
        await act(async () => { addMenu.props.onSelect('example'); });
        for (const example of WORKFLOW_STARTER_EXAMPLES_V1) expect(screen.findByTestId(`workflow-examples:${example.key}:use`)).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-examples:review-pull-request:use');
        expect(routing.push).toHaveBeenCalledWith({ pathname: '/workflows/new', params: { example: 'review-pull-request' } });
        expect(execute.mock.calls.some(([action]) => action === 'workflow.definition.create' || action === 'workflow.run.start')).toBe(false);
    });
    it('reviews a built-in in the canonical composer before admitting its catalog source', async () => {
        routeParams.id = 'builtin:open-a-pull-request';
        storage.setState({ machines: { 'machine-1': createMachineFixture({ id: 'machine-1' }) },
            authoringMemory: { ...storage.getState().authoringMemory, recentMachinePaths: [{ machineId: 'machine-1', path: '/project' }] } });
        execute.mockImplementation(async (id: string, input: { runId: string }) => ({ ok: true, result: id === 'workflow.run.start'
            ? { admission: 'created', run: createWorkflowRunSummaryFixture({ id: input.runId }) }
            : { definitions: [] } }));
        const screen = await renderScreen(<SavedWorkflowRoute />, {
            wrapper: ({ children }) => <AppPaneProvider>{children}</AppPaneProvider>,
        });
        await screen.pressByTestIdAsync('workflow-builtin-run-now');
        expect(execute.mock.calls.some(([id]) => id === 'workflow.run.start')).toBe(false);
        expect(Modal.show).not.toHaveBeenCalled();
        expect(screen.findAllByType(WorkflowRunComposer)).toHaveLength(1);
        await act(async () => { screen.findByType(WorkflowRunComposer).props.onRun(undefined); });
        expect(execute.mock.calls.find(([id]) => id === 'workflow.run.start')?.[1]).toMatchObject({
            source: { kind: 'catalog', workflow: 'builtin:open-a-pull-request' },
        });
        expect(execute.mock.calls.find(([id]) => id === 'workflow.run.start')?.[2]).toMatchObject({
            externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { directory: '/project' } },
        });
    });
    it.each([false, true])('renders the canonical examples and built-ins on the home (saved=%s) without seeding persistence', async (saved) => {
        execute.mockImplementation(async (actionId: string) => ({ ok: true, result: actionId === 'workflow.definition.list'
            ? { definitions: saved ? [{ kind: 'workflow-definition.v1', definitionId: 'saved-workflow',
                metadata: { title: 'Saved' }, revision: { headerVersion: 1, bodyVersion: 1 }, contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null }] : [] }
            : actionId === 'workflow.run.summaries' ? { summaries: [] } : { runs: [] } }));
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
        expect(execute.mock.calls.some(([id]) => id === 'workflow.definition.create' || id === 'workflow.run.start')).toBe(false);
    });
    const plugin = {
        workflow: 'plugin:example.recipe/check', pluginId: 'example.recipe', version: '1.2.3',
        title: 'Check changes', definition: BUILTIN_WORKFLOW_CATALOG_V1[0]!.definition,
    };
    it('shows the plugin library even when no saved definitions or runs exist', async () => {
        execute.mockImplementation(async (actionId: string) => ({ ok: true, result: actionId === 'workflow.definition.list'
            ? { definitions: [], pluginWorkflows: [plugin] } : { runs: [] } }));
        const screen = await renderScreen(<WorkflowsLibraryHome />);
        await act(async () => { await Promise.resolve(); });
        await screen.pressByTestIdAsync(`workflows-home:row:${plugin.workflow}`);
        expect(routing.push).toHaveBeenCalledWith(`/workflows/${encodeURIComponent(plugin.workflow)}`);
        expect(execute.mock.calls.filter(([id]) => id === 'workflow.run.summaries')).toHaveLength(0);
    });

    it('opens the contribution read-only and duplicates as an unsaved portable draft without a write', async () => {
        execute.mockResolvedValue({ ok: true, result: { definitions: [], pluginWorkflows: [plugin] } });
        const screen = await renderScreen(<SavedWorkflowRoute />, {
            wrapper: ({ children }) => <AppPaneProvider>{children}</AppPaneProvider>,
        });
        await act(async () => { await Promise.resolve(); });
        expect(screen.findByType(WorkflowEditorBody).props.documentPresentation.editable).toBe(false);
        expect(screen.findByType(WorkflowEditorBody).props.onSave).toBeUndefined();
        await screen.pressByTestIdAsync('workflow-plugin-duplicate');
        expect(execute.mock.calls.some(([id]) => id === 'workflow.definition.create' || id === 'workflow.definition.update')).toBe(false);
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
        execute.mockImplementation(async (_actionId: string, input: { runId: string }) => ({ ok: true, result: {
            admission: 'created', run: createWorkflowRunSummaryFixture({ id: input.runId }),
        } }));
        const hook = await renderHook(() => useSessionBuiltinWorkflowStart({ sessionId: session.id }));
        await act(async () => {
            hook.getCurrent()(plugin);
        });
        expect(Modal.show).toHaveBeenCalled();
        const config = vi.mocked(Modal.show).mock.calls[0]![0];
        const props = config.props as { onRun(inputs: Record<string, never>): void };
        await act(async () => { props.onRun({}); await Promise.resolve(); });
        expect(execute.mock.calls.find(([id]) => id === 'workflow.run.start')).toEqual([
            'workflow.run.start', expect.objectContaining({ source: { kind: 'catalog', workflow: plugin.workflow, pluginVersion: plugin.version } }),
            expect.objectContaining({ defaultSessionId: session.id, externalActionTarget: expect.objectContaining({ machineId: 'machine-1' }) }),
        ]);
    });
    it('offers the contribution in the Work launch submenu and selects that exact source', async () => {
        execute.mockResolvedValue({ ok: true, result: { definitions: [], pluginWorkflows: [plugin] } });
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
        const revision = { headerVersion: 1, bodyVersion: 1 };
        execute.mockResolvedValue({ ok: true, result: { definitions: [
            { kind: 'workflow-definition.v1', definitionId: 'missing-title', revision: null, metadata: null,
                contentStatus: 'unavailable', contentUnavailableReason: 'invalid_header', stepCount: null, triggers: [], nextRunAt: null },
            { kind: 'workflow-definition.v1', definitionId: 'bad-body', revision, metadata: { title: 'Unavailable recipe' },
                contentStatus: 'unavailable', contentUnavailableReason: 'invalid_body', stepCount: null, triggers: [], nextRunAt: null },
            { kind: 'workflow-definition.v1', definitionId: 'readable', revision, metadata: { title: 'Readable recipe' },
                contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null },
        ], pluginWorkflows: [plugin] } });
        const launcher = { unavailableReason: null, intents: [], agentIds: [], providerLaunch: null,
            openConversation: vi.fn(), openRun: vi.fn(), openDetails: vi.fn(), startBuiltinWorkflow: vi.fn(), startPluginWorkflow: vi.fn() };
        const screen = await renderScreen(<SessionAgentsLaunchMenu launcher={launcher} />);
        await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(true); });
        await act(async () => { await Promise.resolve(); });
        const menu = screen.findByType(DropdownMenu);
        const items: React.ComponentProps<typeof DropdownMenu>['items'] = menu.props.items;
        const rows = items.find(item => item.id === 'run-workflow')!.submenu!.items;
        for (const id of ['missing-title', 'bad-body']) {
            const row = rows.find(item => item.id === `workflow:${id}`);
            expect(row).toMatchObject({ disabled: true, subtitle: expect.any(String) });
            await act(async () => { menu.props.onSelect(`workflow:${id}`); });
        }
        expect(routing.push).not.toHaveBeenCalled();
        expect(rows.find(item => item.id === 'workflow:readable')?.disabled).not.toBe(true);
        await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(true); });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { screen.findByType(DropdownMenu).props.onSelect('workflow:readable'); });
        expect(routing.push).toHaveBeenCalledWith({ pathname: '/workflows/[id]', params: { id: 'readable', intent: 'run' } });
        expect(rows.find(item => item.id === `plugin-workflow:${plugin.workflow}`)?.title).toBe(plugin.title);
    });
    it('does not retain or select a previous Account catalog while the closed menu changes Account', async () => {
        execute.mockResolvedValueOnce({ ok: true, result: { definitions: [{ kind: 'workflow-definition.v1',
            definitionId: '00000000-0000-4000-8000-000000000003', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Private saved recipe' } }], pluginWorkflows: [plugin] } });
        const startPluginWorkflow = vi.fn();
        const launcher = { unavailableReason: null, intents: [], agentIds: [], providerLaunch: null,
            openConversation: vi.fn(), openRun: vi.fn(), openDetails: vi.fn(), startBuiltinWorkflow: vi.fn(), startPluginWorkflow };
        const screen = await renderScreen(<SessionAgentsLaunchMenu launcher={launcher} />);
        expect(execute).not.toHaveBeenCalled();
        await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(true); });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(false); });
        const next = createDeferred<unknown>();
        execute.mockReturnValueOnce(next.promise);
        await act(async () => {
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
        await act(async () => { next.resolve({ ok: true, result: { definitions: [] } }); await next.promise; });
    });
    it('selects the catalog definition with its qualified identity and observed plugin version', async () => {
        const plugin = {
            workflow: 'plugin:example.recipe/check', pluginId: 'example.recipe', version: '1.2.3',
            title: 'Check changes', definition: BUILTIN_WORKFLOW_CATALOG_V1[0]!.definition,
        };
        execute.mockResolvedValue({ ok: true, result: { definitions: [], pluginWorkflows: [plugin] } });
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

import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import { buildWorkflowEditorDraftFromDefinition } from '@/sync/domains/workflows/workflowAuthoring';
import { useWorkflowEditorHistory } from './useWorkflowEditorHistory';

// Action transport is the system boundary; catalogs, parsers, scope and editor history stay real.
const execute = vi.hoisted(() => vi.fn());
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => ({ serverId: 'server-a' }), isAppliedActiveServerRuntimeAvailable: () => true,
}));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
// Native/web portals are a platform boundary; retain the real menu and selection logic.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 280, placement: 'bottom' });
});

const child = createWorkflowDefinitionFixture({ inputs: [{ name: 'topic', valueType: 'string', required: true }] });
const definition = createWorkflowDefinitionFixture({ roles: [{ roleId: 'local_builder', name: 'Builder',
    instructions: 'Build carefully', runsAs: { kind: 'session' }, workspaceWrites: 'deny' }] });
let harness: Awaited<ReturnType<typeof loadHarness>>;
async function loadHarness() {
    return { ...(await import('./WorkflowInspector')), ...(await import('./WorkflowNestedWorkflowBlockEditor')),
        ...(await import('./WorkflowActionBlockEditor')) };
}
beforeAll(async () => { harness = await loadHarness(); }, 300_000);
beforeEach(() => {
    getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
    execute.mockReset();
    machineRpc.mockReset();
    execute.mockImplementation(async (actionId: string) => ({ ok: true, result: actionId === 'roles.list' ? { items: [] }
        : { definitions: [], pluginWorkflows: [{ workflow: 'plugin:example.tools/child', pluginId: 'example.tools',
            version: '1.0.0', title: 'Plugin child', definition: child }] } }));
});
afterEach(standardCleanup);

describe('workflow editor declared bindings', () => {
    it('edits workflow-local role pins through the same undo history without changing Settings', async () => {
        const initial = buildWorkflowEditorDraftFromDefinition({ draftId: 'draft', name: 'Workflow', definition });
        const changed = vi.fn();
        let undo = () => {};
        let currentDraft = initial;
        function Host() {
            const [draft, setDraft] = React.useState(initial);
            currentDraft = draft;
            const history = useWorkflowEditorHistory('draft', setDraft);
            undo = history.controls.undo;
            return <harness.WorkflowInspector subject={{ kind: 'workflow' }} presentation="pane" draft={draft}
                machineName={null} testIDPrefix="editor" onChange={(next) => {
                    history.record(draft, next, 'roles'); setDraft(next); changed(next);
                }} />;
        }
        const settings = getStorage().getState().settings.rolesV1;
        const screen = await renderScreen(<Host />);
        expect(screen.findByTestId('editor-group-roles')).not.toBeNull();
        await screen.pressByTestIdAsync('editor-role-local_builder-target:background_run');
        expect(changed.mock.lastCall?.[0].roles).toEqual([{ ...definition.roles?.[0],
            runsAs: { kind: 'background_run', intent: 'delegate' } }]);
        await act(async () => undo());
        expect(currentDraft.roles).toEqual(initial.roles);
        expect(screen.getTextContent()).toContain('Builder');
        expect(getStorage().getState().settings.rolesV1).toBe(settings);
    });

    it('offers a fresh plugin child’s declared inputs and preserves authored unavailable fields', async () => {
        const block = { kind: 'workflow' as const, id: 'child', workflowRef: 'plugin:example.tools/child',
            input: { oldField: { kind: 'literal' as const, value: 'Keep me' } } };
        const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'draft', name: 'Parent',
            definition: createWorkflowDefinitionFixture({ blocks: [block] }) });
        const changed = vi.fn();
        const screen = await renderScreen(<harness.WorkflowNestedWorkflowBlockEditor block={block} draft={draft}
            ordinal={1} total={1} actions={[]} onSelect={() => {}} onChangeBlock={changed} testIDPrefix="editor" />);
        expect(screen.findByTestId('editor-workflow-child-input-topic')).not.toBeNull();
        expect(screen.findByTestId('editor-workflow-child-input-oldField')).not.toBeNull();
        expect(changed).not.toHaveBeenCalled();
    });

    it('adds, edits and removes an inline workflow role without creating an Account preset', async ({ onTestFinished }) => {
        vi.useFakeTimers();
        onTestFinished(() => { vi.useRealTimers(); });
        const initial = buildWorkflowEditorDraftFromDefinition({ draftId: 'roles-add', name: 'Workflow', definition });
        let current = initial;
        function Host() {
            const [draft, setDraft] = React.useState(initial);
            current = draft;
            return <harness.WorkflowInspector subject={{ kind: 'workflow' }} presentation="pane" draft={draft}
                machineName={null} testIDPrefix="editor" onChange={setDraft} />;
        }
        const settings = getStorage().getState().settings.rolesV1;
        const screen = await renderScreen(<Host />);
        await screen.pressByTestIdAsync('editor-add-role-trigger');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        await screen.pressByTestIdAsync('editor-add-role-inline');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        expect(current.roles?.map((role) => role.roleId)).toEqual(['local_builder', 'workflow_role_1']);
        await act(async () => screen.changeTextByTestId('editor-role-workflow_role_1-name', 'Local reviewer'));
        await act(async () => screen.changeTextByTestId('editor-role-workflow_role_1-instructions', 'Review this workflow'));
        expect(current.roles?.[1]).toMatchObject({ name: 'Local reviewer', instructions: 'Review this workflow' });
        await screen.pressByTestIdAsync('editor-role-workflow_role_1-reset');
        expect(current.roles).toEqual(initial.roles);
        expect(getStorage().getState().settings.rolesV1).toBe(settings);
    });

    it('uses shared child Get disclosure, retries denial and retires old Account schema content', async () => {
        const ref = '24c7a5d2-1d30-4f7a-9abc-888888888888';
        let deny = false;
        const successor = createDeferred<{ ok: true; result: unknown }>();
        execute.mockImplementation(async (actionId: string) => {
            if (actionId !== 'workflow.definition.get') return { ok: true, result: { definitions: [] } };
            if (getStorage().getState().profileScope?.accountId === 'account-b') return successor.promise;
            return deny ? { ok: false, errorCode: 'run_access_denied', error: 'Denied' }
                : { ok: true, result: { definitionId: ref, revision: { headerVersion: 1, bodyVersion: 1 },
                    definition: child, metadata: { title: 'Shared child' }, access: 'view' } };
        });
        const block = { kind: 'workflow' as const, id: 'shared', workflowRef: ref,
            input: { oldField: { kind: 'literal' as const, value: 'Keep me' } } };
        const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'draft', name: 'Parent',
            definition: createWorkflowDefinitionFixture({ blocks: [block] }) });
        const changed = vi.fn();
        const screen = await renderScreen(<harness.WorkflowNestedWorkflowBlockEditor block={block} draft={draft}
            ordinal={1} total={1} actions={[]} onSelect={() => {}} onChangeBlock={changed} testIDPrefix="editor" />);
        expect(screen.findByTestId('editor-workflow-shared-input-topic')).not.toBeNull();
        await act(async () => { getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-b' } }); });
        expect(screen.findByTestId('editor-workflow-shared-input-topic')).toBeNull();
        expect(screen.findByTestId('editor-workflow-shared-input-oldField')).not.toBeNull();
        await act(async () => successor.resolve({ ok: true, result: { definitionId: ref, revision: { headerVersion: 1, bodyVersion: 1 },
            definition: child, metadata: { title: 'Shared child' }, access: 'view' } }));
        expect(screen.findByTestId('editor-workflow-shared-input-topic')).not.toBeNull();
        deny = true;
        await act(async () => { getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } }); });
        expect(screen.findByTestId('editor-workflow-shared-input-topic')).toBeNull();
        expect(screen.findByTestId('editor-workflow-shared-retry')).not.toBeNull();
        deny = false;
        await screen.pressByTestIdAsync('editor-workflow-shared-retry');
        expect(screen.findByTestId('editor-workflow-shared-input-topic')).not.toBeNull();
        expect(changed).not.toHaveBeenCalled();
    });

    it('edits a plugin Action field on the selected machine without discarding unknown bindings', async () => {
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {}, actionsById: {
            'example.tools/summarize': { id: 'example.tools/summarize', pluginId: 'example.tools', occurrenceId: 'occurrence-a',
                title: 'Summarize', scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true,
                inputHints: { fields: [{ path: 'topic', title: 'Topic', widget: 'text', required: true }] } },
        } });
        machineRpc.mockResolvedValue({ protocolVersion: 1, projection });
        const block = { kind: 'action' as const, id: 'plugin', actionId: 'example.tools/actions/summarize',
            input: { oldField: { kind: 'literal' as const, value: 'Keep me' } } };
        const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'draft', name: 'Workflow',
            definition: createWorkflowDefinitionFixture({ blocks: [block] }) });
        const changed = vi.fn();
        const screen = await renderScreen(<harness.WorkflowActionBlockEditor block={block} draft={draft}
            composerScope={{ kind: 'machine', machineId: 'machine-a' }} ordinal={1} total={1} actions={[]}
            onSelect={() => {}} onChangeBlock={changed} testIDPrefix="editor" />);
        expect(screen.findByTestId('editor-action-plugin-field-topic')).not.toBeNull();
        expect(screen.findByTestId('editor-action-plugin-field-oldField')).not.toBeNull();
        await screen.pressByTestIdAsync('editor-action-plugin-field-topic-set');
        expect(changed.mock.lastCall?.[0]).toEqual({ ...block, input: { ...block.input, topic: { kind: 'literal', value: '' } } });
        const authored = { ...block, input: { ...block.input, topic: { kind: 'literal' as const, value: 'Authored topic' } } };
        await act(async () => screen.tree.update(<harness.WorkflowActionBlockEditor block={authored} draft={draft}
            composerScope={{ kind: 'machine', machineId: null }} ordinal={1} total={1} actions={[]}
            onSelect={() => {}} onChangeBlock={changed} testIDPrefix="editor" />));
        expect(screen.getTextContent()).toContain(block.actionId);
        expect(screen.findByTestId('editor-action-plugin-field-topic')).not.toBeNull();
        expect(screen.findByTestId('editor-action-plugin-field-oldField')).not.toBeNull();
        expect(changed).toHaveBeenCalledTimes(1);
    });
});

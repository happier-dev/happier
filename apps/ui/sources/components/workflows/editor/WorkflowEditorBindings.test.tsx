import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, PluginProjectionV2Schema, RPC_METHODS, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import { buildWorkflowEditorDraftFromDefinition } from '@/sync/domains/workflows/workflowAuthoring';
import { getWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import { useWorkflowEditorHistory } from './useWorkflowEditorHistory';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { encodeArtifactListCursor } from '@/sync/api/artifacts/apiArtifacts';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';

// Only the Home HTTP and daemon Socket transports are scripted. Action admission,
// Account lifetime, Artifact codecs, catalogs and editor history remain real.
let projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {} });
let artifactResponse: (url: URL, init?: RequestInit) => Promise<Response> = async () => Response.json([]);
const request = async (...[url, init]: Parameters<RuntimeFetch>): Promise<Response | null> => {
    const target = new URL(String(url));
    if (target.pathname.startsWith('/v1/artifacts')) return artifactResponse(target, init);
    if (target.pathname === '/v3/automations') return Response.json({ automations: [], nextCursor: null });
    return null;
};
const features = () => createRootLayoutFeaturesResponse({ features: { workflows: { enabled: true } },
    capabilities: { serverIdentity: { serverIdentityId: 'srv_session_pane' } } });
const runtime = installSessionPaneRuntimeTestHarness({ features, request, rpc: async (method) => {
    if (method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) throw new Error(`Unexpected daemon RPC: ${method}`);
    return { protocolVersion: 1, projection };
} });
let disposeExecutorLoader: (() => void) | undefined;
async function switchAccount(accountId: string) {
    await runtime.restoreRealm({ accountId });
    publishMachine();
}
function publishMachine() {
    const machine = createMachineFixture({ id: 'machine-a', activeAt: Date.now() });
    getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [runtime.serverId]: [machine] } });
}
function pluginChild(id = 'child') {
    return PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { 'example.tools': { id: 'example.tools', displayName: 'Example tools', version: '1.0.0',
            enabled: true, source: { kind: 'path', locator: '/plugins/example.tools' } } },
        familiesById: { workflows: { family: 'workflows', entriesById: {
            [`example.tools/${id}`]: { id: `example.tools/${id}`, pluginId: 'example.tools', pluginVersion: '1.0.0',
                definition: { id, title: 'Plugin child', definition: child } },
        } } },
    });
}
function createArtifact(id: string, header: Record<string, unknown>, ownerAccountId = 'account-a'): Artifact {
    return { id, ownerAccountId, access: 'view', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent(header),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'workflow-definition.v1', definition: child }) }),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
}
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
// Native/web portals are a platform boundary; retain the real menu and selection logic.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 280, placement: 'bottom' });
});

const child = createWorkflowDefinitionFixture({
    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
    inputs: [{ name: 'topic', valueType: 'string', required: true }],
});
const definition = createWorkflowDefinitionFixture({ roles: [{ roleId: 'local_builder', name: 'Builder',
    instructions: 'Build carefully', runsAs: { kind: 'session' }, workspaceWrites: 'deny' }] });
let harness: Awaited<ReturnType<typeof loadHarness>>;
async function loadHarness() {
    return { ...(await import('./WorkflowInspector')), ...(await import('./WorkflowNestedWorkflowBlockEditor')),
        ...(await import('./WorkflowActionBlockEditor')) };
}
beforeAll(async () => { harness = await loadHarness(); }, 300_000);
beforeEach(async () => {
    disposeExecutorLoader = await installRealActionExecutorModuleLoader();
    projection = pluginChild();
    artifactResponse = async () => Response.json([]);
    publishMachine();
});
afterEach(() => { disposeExecutorLoader?.(); });

describe('workflow editor declared bindings', () => {
    it('edits command text literally while preserving its environment binding', async () => {
        const block = { kind: 'action' as const, id: 'command', actionId: 'machines.command.run', input: {
            command: { kind: 'literal' as const, value: 'printf "%s\\n" "$MESSAGE"' },
            env: { kind: 'input' as const, name: 'environment' },
        } };
        const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'command', name: 'Command',
            definition: createWorkflowDefinitionFixture({ blocks: [block], inputs: [
                { name: 'environment', valueType: 'json', required: true },
            ] }) });
        const changed = vi.fn();
        const screen = await renderScreen(<harness.WorkflowActionBlockEditor block={block} draft={draft}
            ordinal={1} total={1} actions={[]} onSelect={() => {}}
            onChangeBlock={changed} testIDPrefix="editor" />);
        expect(screen.findByTestId('editor-action-command-field-command-input-0-kind')).toBeNull();
        expect(screen.findByTestId('editor-action-command-field-env-input-0-kind')).not.toBeNull();
        await act(async () => screen.changeTextByTestId('editor-action-command-field-command-literal', 'echo "$MESSAGE"'));
        expect(changed.mock.lastCall?.[0]).toEqual({ ...block, input: { ...block.input,
            command: { kind: 'literal', value: 'echo "$MESSAGE"' },
        } });
    });

    it.each([
        ['webhooks.call', 'body'],
        ['machines.command.run', 'env'],
    ] as const)('binds %s %s through the existing workflow input grammar', async (actionId, field) => {
        const block = { kind: 'action' as const, id: 'bound', actionId, input: {
            ...(actionId === 'webhooks.call' ? { url: { kind: 'literal' as const, value: 'https://example.com/hook' } }
                : { command: { kind: 'literal' as const, value: 'echo "$MESSAGE"' } }),
            [field]: { kind: 'literal' as const, value: {} },
        } };
        const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'bound', name: 'Bound',
            definition: createWorkflowDefinitionFixture({ blocks: [block], inputs: [
                { name: 'payload', valueType: 'json', required: true },
            ] }) });
        const changed = vi.fn();
        const screen = await renderScreen(<harness.WorkflowActionBlockEditor block={block} draft={draft}
            ordinal={1} total={1} actions={[]} onSelect={() => {}}
            onChangeBlock={changed} testIDPrefix="editor" />);
        const source = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `editor-action-bound-field-${field}-input-0-kind`)!;
        await act(async () => source.props.onSelect('input'));
        expect(changed.mock.lastCall?.[0]).toEqual({ ...block, input: { ...block.input,
            [field]: { kind: 'input', name: 'payload' },
        } });
    });

    it('reads an unselected workflow engine honestly in the closed Inspector', async () => {
        const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'empty-engine', name: 'Workflow',
            definition: createWorkflowDefinitionFixture({ defaults: {} }) });
        const screen = await renderScreen(<harness.WorkflowInspector subject={{ kind: 'workflow' }} presentation="pane"
            draft={draft} machineName={null} testIDPrefix="empty" onChange={() => {}} />);
        const header = screen.findByTestId('empty-group-agent-header')!;
        expect(header.findAll((node) => String(node.type) === 'Text' && node.children.includes('agentInput.agent.unselected'))).not.toHaveLength(0);
    });
    it('reads declared input titles rather than wire keys in a read-only settings pane', async () => {
        const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'builtin', name: 'Built-in',
            definition: createWorkflowDefinitionFixture({ inputs: [
                { name: 'maxRounds', valueType: 'number', required: false },
                { name: 'secondOpinion', valueType: 'boolean', required: false },
                { name: 'customKey', valueType: 'string', required: false },
            ] }) });
        const screen = await renderScreen(<harness.WorkflowInspector subject={{ kind: 'workflow' }} presentation="pane"
            documentEditable={false} draft={draft} machineName={null} testIDPrefix="editor" onChange={() => {}} />);
        const text = screen.getTextContent();
        expect(text).toContain('workflows.page.fields.maxRounds');
        expect(text).toContain('workflows.page.fields.secondOpinion');
        expect(text).toContain('Custom Key');
        expect(text).not.toContain('customKey');
    });
    it('reads a builtin Action with human execution values, not its wire fields', async () => {
        const block = { kind: 'action' as const, id: 'panel', actionId: 'subagents.plan.start', input: {
            target: { kind: 'literal' as const, value: { kind: 'detached' } },
            permissionMode: { kind: 'literal' as const, value: 'read_only' },
        } };
        const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'panel', name: 'Panel',
            definition: createWorkflowDefinitionFixture({ blocks: [block] }) });
        const screen = await renderScreen(<harness.WorkflowActionBlockEditor block={block} draft={draft}
            editable={false} ordinal={1} total={1} actions={[]} onSelect={() => {}}
            onChangeBlock={() => {}} testIDPrefix="editor" />);
        expect(screen.getTextContent()).toContain('workflows.page.sections.aBackgroundRun');
        expect(screen.getTextContent()).toContain('executionRuns.newRun.permissionModes.readOnly');
        expect(screen.getTextContent()).not.toContain('detached');
        expect(screen.getTextContent()).not.toContain('read_only');
        expect(screen.getTextContent()).not.toContain('(json)');
        const card = screen.findByTestId('editor-action-panel-card')!;
        expect(card.findAll((node) => node.props.testID === 'editor-action-panel-card-title')).not.toHaveLength(0);
        expect(card.findAll((node) => String(node.type) === 'Text' && node.children.includes('Happier'))).not.toHaveLength(0);
        expect(screen.tree.findHostByTestId('editor-action-panel-label')?.props.accessibilityLabel).toContain('workflows.a11y.stepContext');
    });

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

    it.each([false, true])('reads a later-page plugin child, retaining bindings and retrying a failed page (%s)', async (failPage) => {
        let failing = failPage;
        const cursors: (string | null)[] = [];
        const successor = createDeferred<Response>();
        // The real Artifact owner asks for 500 rows and derives the next cursor
        // from the last row. Non-workflow documents keep this about the child's
        // late disclosure rather than about unrelated workflow list content.
        const firstPage = Array.from({ length: 500 }, (_, index) => createArtifact(`document-${index}`, { kind: 'note.v1' }));
        const lastRow = firstPage.at(-1)!;
        const laterCursor = encodeArtifactListCursor({ artifactId: lastRow.id, updatedAt: lastRow.updatedAt });
        projection = pluginChild('later-child');
        artifactResponse = async (url) => {
            if (getStorage().getState().profileScope?.accountId === 'account-b') return successor.promise;
            const cursor = url.searchParams.get('cursor');
            cursors.push(cursor);
            if (!cursor) return Response.json(firstPage);
            if (failing) return Response.json({ error: 'Page temporarily unavailable' }, { status: 403 });
            return Response.json([]);
        };
        const block = { kind: 'workflow' as const, id: 'later', workflowRef: 'plugin:example.tools/later-child',
            input: { oldField: { kind: 'literal' as const, value: 'Keep me' } } };
        const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'draft', name: 'Parent',
            definition: createWorkflowDefinitionFixture({ blocks: [block] }) });
        const changed = vi.fn();
        const screen = await renderScreen(<harness.WorkflowNestedWorkflowBlockEditor block={block} draft={draft}
            ordinal={1} total={1} actions={[]} onSelect={() => {}} onChangeBlock={changed} testIDPrefix="editor" />);
        if (failPage) {
            expect(cursors).toContain(laterCursor);
            expect(screen.findByTestId('editor-workflow-later-input-topic')).toBeNull();
            expect(screen.findByTestId('editor-workflow-later-input-oldField')).not.toBeNull();
            failing = false;
            await screen.pressByTestIdAsync('editor-workflow-later-retry');
        }
        expect(screen.findByTestId('editor-workflow-later-input-topic')).not.toBeNull();
        expect(screen.findByTestId('editor-workflow-later-input-oldField')).not.toBeNull();
        expect(cursors).toContain(laterCursor);
        expect(changed).not.toHaveBeenCalled();
        if (!failPage) {
            projection = PluginProjectionV2Schema.parse({ v: 2, generation: 2, familiesById: {} });
            await act(async () => { await switchAccount('account-b'); });
            expect(screen.findByTestId('editor-workflow-later-input-topic')).toBeNull();
            expect(screen.findByTestId('editor-workflow-later-input-oldField')).not.toBeNull();
            await act(async () => successor.resolve(Response.json([])));
            expect(screen.findByTestId('editor-workflow-later-input-topic')).toBeNull();
            expect(changed).not.toHaveBeenCalled();
        }
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
        const successor = createDeferred<Response>();
        const artifact = createArtifact(ref, { kind: 'workflow-definition.v1', definitionId: ref,
            revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Shared child' }, previewSteps: [] });
        artifactResponse = async (url) => {
            // Library inventory deliberately discloses no child schema. Only
            // the authorized Get response may open this shared definition.
            if (url.pathname === '/v1/artifacts') return Response.json([]);
            if (url.pathname !== `/v1/artifacts/${ref}`) throw new Error(`Unexpected shared Artifact route: ${url.pathname}`);
            if (getStorage().getState().profileScope?.accountId === 'account-b') return successor.promise;
            return deny ? Response.json({ error: 'Denied' }, { status: 403 }) : Response.json(artifact);
        };
        expect((await getWorkflowDefinition({ definitionId: ref })).definition.inputs).toEqual(child.inputs);
        const block = { kind: 'workflow' as const, id: 'shared', workflowRef: ref,
            input: { oldField: { kind: 'literal' as const, value: 'Keep me' } } };
        const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'draft', name: 'Parent',
            definition: createWorkflowDefinitionFixture({ blocks: [block] }) });
        const changed = vi.fn();
        const screen = await renderScreen(<harness.WorkflowNestedWorkflowBlockEditor block={block} draft={draft}
            ordinal={1} total={1} actions={[]} onSelect={() => {}} onChangeBlock={changed} testIDPrefix="editor" />);
        await vi.waitFor(() => expect(screen.findByTestId('editor-workflow-shared-input-topic')).not.toBeNull());
        await act(async () => { await switchAccount('account-b'); });
        expect(screen.findByTestId('editor-workflow-shared-input-topic')).toBeNull();
        expect(screen.findByTestId('editor-workflow-shared-input-oldField')).not.toBeNull();
        await act(async () => successor.resolve(Response.json(artifact)));
        await vi.waitFor(() => expect(screen.findByTestId('editor-workflow-shared-input-topic')).not.toBeNull());
        deny = true;
        await act(async () => { await switchAccount('account-a'); });
        expect(screen.findByTestId('editor-workflow-shared-input-topic')).toBeNull();
        await vi.waitFor(() => expect(screen.findByTestId('editor-workflow-shared-retry')).not.toBeNull());
        deny = false;
        await screen.pressByTestIdAsync('editor-workflow-shared-retry');
        await vi.waitFor(() => expect(screen.findByTestId('editor-workflow-shared-input-topic')).not.toBeNull());
        expect(changed).not.toHaveBeenCalled();
    });

    it('edits a plugin Action field on the selected machine without discarding unknown bindings', async () => {
        projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {}, actionsById: {
            'example.tools/summarize': { id: 'example.tools/summarize', pluginId: 'example.tools', occurrenceId: 'occurrence-a',
                title: 'Summarize', scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true,
                inputHints: { fields: [{ path: 'topic', title: 'Topic', widget: 'text', required: true }] } },
        } });
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
        expect(screen.getTextContent()).toContain('workflows.page.blocks.menuAction');
        expect(screen.getTextContent()).not.toContain(block.actionId);
        expect(screen.findByTestId('editor-action-plugin-field-topic')).not.toBeNull();
        expect(screen.findByTestId('editor-action-plugin-field-oldField')).not.toBeNull();
        expect(changed).toHaveBeenCalledTimes(1);
    });
});

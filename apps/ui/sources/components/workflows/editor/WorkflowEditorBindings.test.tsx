import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, DaemonContributionRegistryProjectionDescribeResponseSchema, PluginProjectionV2Schema, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { encodeArtifactListCursor } from '@/sync/api/artifacts/apiArtifacts';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { buildWorkflowEditorDraftFromDefinition } from '@/sync/domains/workflows/workflowAuthoring';
import { getWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import { useWorkflowEditorHistory } from './useWorkflowEditorHistory';

// Only native RPC, HTTP, credentials and platform rendering leave the process.
// Action admission, plugin discovery, codecs, scope and editor history stay real.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
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

const child = createWorkflowDefinitionFixture({ inputs: [{ name: 'topic', valueType: 'string', required: true }],
    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } });
const definition = createWorkflowDefinitionFixture({ roles: [{ roleId: 'local_builder', name: 'Builder',
    instructions: 'Build carefully', runsAs: { kind: 'session' }, workspaceWrites: 'deny' }] });
let harness: Awaited<ReturnType<typeof loadHarness>>;
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { resetWorkflowLibraryReadsForTests } = await import('../library/workflowLibraryReads');
const { createWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
let serverId: string;

function childProjection(localId = 'child') {
    return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
        projection: { v: 2, generation: 1,
            installedPackagesById: { 'example.tools': { id: 'example.tools', displayName: 'Example tools', version: '1.0.0',
                enabled: true, source: { kind: 'path', locator: '/plugins/example.tools' } } },
            familiesById: { workflows: { family: 'workflows', entriesById: {
            [`example.tools/${localId}`]: { id: `example.tools/${localId}`, pluginId: 'example.tools',
                pluginVersion: '1.0.0', definition: { id: localId, title: 'Plugin child', definition: child } },
        } } }, actionsById: {} } });
}

async function switchAccount(accountId: string) {
    await home.switchAccount(serverId, accountId);
    getStorage().setState({ profileScope: { serverId, accountId } });
}
async function loadHarness() {
    return { ...(await import('./WorkflowInspector')), ...(await import('./WorkflowNestedWorkflowBlockEditor')),
        ...(await import('./WorkflowActionBlockEditor')) };
}
beforeAll(async () => { await loadSyncSingletonForTests(); harness = await loadHarness(); }, 300_000);
beforeEach(async () => {
    await home.reset();
    serverId = await home.addHome({ name: 'Editor bindings', serverUrl: 'https://editor-bindings.test', accountId: 'account-a' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    getStorage().setState({ profileScope: { serverId, accountId: 'account-a' },
        machines: { 'machine-a': createMachineFixture({ id: 'machine-a', activeAt: Date.now() }) }, machineListByServerId: {} });
    clearDaemonMergedProjectionCacheForTests(); resetWorkflowLibraryReadsForTests();
    machineRpc.mockReset();
    machineRpc.mockResolvedValue(childProjection());
    home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
});
afterEach(async () => { await standardCleanup(); resetWorkflowLibraryReadsForTests(); await home.reset(); });

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
            ordinal={1} total={1} actions={[]} onSelect={() => {}} selected
            onChangeBlock={changed} testIDPrefix="editor" />);
        // A field that only takes a typed value offers nothing to pick; one that can bind offers the picker.
        expect(screen.findByTestId('editor-action-command-field-command-input-0-value')).toBeNull();
        expect(screen.findByTestId('editor-action-command-field-env-input-0-value')).not.toBeNull();
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
            ordinal={1} total={1} actions={[]} onSelect={() => {}} selected
            onChangeBlock={changed} testIDPrefix="editor" />);
        const source = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `editor-action-bound-field-${field}-input-0-value`)!;
        const payload = (source.props.items as ReadonlyArray<Readonly<{ id: string; title: string }>>).find((item) => item.title === 'Payload')!;
        await act(async () => source.props.onSelect(payload.id));
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
        expect(text).toContain('Custom key');
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
        // Unnamed, the heading carries the card's identity once (DESIGN-7): its title and "· Happier".
        const card = screen.findByTestId('editor-action-panel-card')!;
        expect(card.findAll((node) => node.props.testID === 'editor-action-panel-card-title')).toHaveLength(0);
        expect(JSON.stringify(screen.findByTestId('editor-action-panel-label-source')?.props.children)).toContain('Happier');
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
            const history = useWorkflowEditorHistory<typeof initial>('draft', setDraft);
            undo = history.controls.undo;
            return <harness.WorkflowInspector subject={{ kind: 'workflow' }} presentation="pane" draft={draft}
                machineName={null} testIDPrefix="editor" onChange={(next) => {
                    history.record(draft, next, 'roles'); setDraft(next); changed(next);
                }} />;
        }
        const settings = getStorage().getState().settings;
        const screen = await renderScreen(<Host />);
        expect(screen.findByTestId('editor-group-roles')).not.toBeNull();
        await screen.pressByTestIdAsync('editor-role-local_builder-target:background_run');
        expect(changed.mock.lastCall?.[0].roles).toEqual([{ ...definition.roles?.[0],
            runsAs: { kind: 'background_run', intent: 'task' } }]);
        await act(async () => undo());
        expect(currentDraft.roles).toEqual(initial.roles);
        expect(screen.getTextContent()).toContain('Builder');
        expect(getStorage().getState().settings).toBe(settings);
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
        const successor = createDeferred<void>();
        machineRpc.mockResolvedValue(childProjection('later-child'));
        // The real Artifact reader derives its next cursor from a full page.
        // Non-workflow documents keep this about late child-schema disclosure.
        const cursors: (string | null)[] = [];
        const firstPage = Array.from({ length: 500 }, (_, index) => ({
            id: `document-${index}`, ownerAccountId: 'account-a', access: 'view', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ kind: 'note.v1' }),
            body: encodePlainArtifactStoredContent({ body: '' }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        } satisfies Artifact));
        const lastRow = firstPage.at(-1)!;
        const laterCursor = encodeArtifactListCursor({ artifactId: lastRow.id, updatedAt: lastRow.updatedAt });
        home.answer(serverId, '/v1/artifacts', { select: () => {
            const request = home.requests.at(-1)!;
            const params = new URL(request.path, request.serverUrl).searchParams;
            const cursor = params.get('cursor');
            cursors.push(cursor);
            // A kind-selected list answers the filtered wire shape; an unfiltered list answers rows.
            const filtered = params.has('kinds') || params.has('kind') || params.has('unclassified');
            const page = (items: readonly Artifact[]) => filtered ? { items, hasUnclassified: false } : items;
            if (getStorage().getState().profileScope?.accountId === 'account-b') return { body: page([]), respondAfter: successor.promise };
            if (!cursor) return { body: page(firstPage) };
            return failing ? { status: 403, body: { error: 'run_access_denied' } } : { body: page([]) };
        } });
        const block = { kind: 'workflow' as const, id: 'later', workflowRef: 'plugin:example.tools/later-child',
            input: { oldField: { kind: 'literal' as const, value: 'Keep me' } } };
        const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'draft', name: 'Parent',
            definition: createWorkflowDefinitionFixture({ blocks: [block] }) });
        const changed = vi.fn();
        const screen = await renderScreen(<harness.WorkflowNestedWorkflowBlockEditor block={block} draft={draft}
            ordinal={1} total={1} actions={[]} onSelect={() => {}} onChangeBlock={changed} testIDPrefix="editor" />);
        if (failPage) {
            await vi.waitFor(() => expect(cursors).toContain(laterCursor));
            expect(screen.findByTestId('editor-workflow-later-input-topic')).toBeNull();
            expect(screen.findByTestId('editor-workflow-later-input-oldField')).not.toBeNull();
            failing = false;
            await screen.pressByTestIdAsync('editor-workflow-later-retry');
        }
        await vi.waitFor(() => expect(screen.findByTestId('editor-workflow-later-input-topic')).not.toBeNull());
        expect(screen.findByTestId('editor-workflow-later-input-oldField')).not.toBeNull();
        // Source discovery is produced only by the plugin-phase continuation.
        expect(cursors).toContain(laterCursor);
        expect(machineRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)).toBe(true);
        expect(changed).not.toHaveBeenCalled();
        if (!failPage) {
            machineRpc.mockImplementation(async () => { await successor.promise;
                return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
                    projection: { v: 2, generation: 1, familiesById: {}, actionsById: {} } }); });
            await act(async () => switchAccount('account-b'));
            expect(screen.findByTestId('editor-workflow-later-input-topic')).toBeNull();
            expect(screen.findByTestId('editor-workflow-later-input-oldField')).not.toBeNull();
            await act(async () => successor.resolve());
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
        const settings = getStorage().getState().settings;
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
        expect(getStorage().getState().settings).toBe(settings);
    });

    it('uses shared child Get disclosure, retries denial and retires old Account schema content', async () => {
        const ref = '24c7a5d2-1d30-4f7a-9abc-888888888888';
        let deny = false;
        const successor = createDeferred<void>();
        await createWorkflowDefinition({ definitionId: ref, definition: child, metadata: { title: 'Shared child' } });
        const row = home.artifacts(serverId).read(ref);
        if (!row) throw new Error('Missing produced child Artifact');
        home.answer(serverId, `/v1/artifacts/${ref}`, { select: () => deny
            ? { status: 403, body: { error: 'run_access_denied' } }
            : { body: { ...row, access: 'view' },
                ...(getStorage().getState().profileScope?.accountId === 'account-b' ? { respondAfter: successor.promise } : {}) } });
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
        await act(async () => successor.resolve());
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
        await screen.update(<harness.WorkflowActionBlockEditor block={authored} draft={draft}
            composerScope={{ kind: 'machine', machineId: null }} ordinal={1} total={1} actions={[]}
            onSelect={() => {}} onChangeBlock={changed} testIDPrefix="editor" />);
        expect(screen.getTextContent()).toContain('workflows.page.blocks.menuAction');
        expect(screen.getTextContent()).not.toContain(block.actionId);
        expect(screen.findByTestId('editor-action-plugin-field-topic')).not.toBeNull();
        expect(screen.findByTestId('editor-action-plugin-field-oldField')).not.toBeNull();
        expect(changed).toHaveBeenCalledTimes(1);
    });
});

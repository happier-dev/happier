import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Alert, View } from 'react-native';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { buildWorkflowReviewedRunSeed, storeWorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { teamSummaryFixture, teamCapabilitiesFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';

const transport = vi.hoisted(() => vi.fn());
const viewport = vi.hoisted(() => ({ width: 1280 }));
const appliedHome = vi.hoisted(() => ({ serverId: 'server-a', serverUrl: 'https://server-a.example' }));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => transport }));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => appliedHome,
    isAppliedActiveServerRuntimeAvailable: () => true,
}));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        useWindowDimensions: () => ({ width: viewport.width, height: 844, scale: 1, fontScale: 1 }),
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Expo navigation and authentication are the platform/network boundaries; workspace state and guards stay real.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/workflows/new' }).module;
});
vi.mock('@/auth/context/AuthContext', () => ({ useOptionalAuth: () => null }));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
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
const { SplitCanvasLeafFrame } = await import('@/components/appShell/splitCanvas/components/SplitCanvasLeafFrame');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { clearActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { getStorage } = await import('@/sync/domains/state/storageStore');

describe('editor workflow composer', () => {
    beforeEach(async () => {
        installHomeGovernanceBoundaries(home);
        resetTeamsDirectoryEngineForTests(); resetTeamsSnapshotsForTests();
        await home.reset();
        appliedHome.serverId = 'server-a';
        appliedHome.serverUrl = 'https://server-a.example';
        viewport.width = 1280;
        const machine = createMachineFixture();
        getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' }, isDataReady: true,
            machines: { [machine.id]: machine }, machineListByServerId: {} });
        transport.mockReset();
        transport.mockImplementation(async (action: string, input: unknown) => {
            if (action === 'artifact.access.grants.list') {
                const { artifactId } = (await import('@happier-dev/protocol/artifacts/artifactAccessV1')).ArtifactAccessGrantsListInputV1Schema.parse(input);
                return { ok: true, result: { artifactId, ownerAccountId: 'account-a', access: 'owner', grants: [] } };
            }
            if (action === 'workflow.definition.get') {
                const { definitionId } = (await import('@happier-dev/protocol')).WorkflowDefinitionGetRequestV1Schema.parse(input);
                return { ok: true, result: { definitionId, definition: createWorkflowDefinitionFixture(), access: 'owner',
                    revision: { headerVersion: 3, bodyVersion: 3 }, metadata: { title: 'Saved draft' } } };
            }
            return action === 'workflow.trigger.list' ? { ok: true, result: { sets: [] } }
                : { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        });
    });
    afterEach(() => { clearActiveUnsavedChangesGuard(); standardCleanup(); vi.restoreAllMocks(); });

    it('runs the reviewed saved draft with its granted Team without saving or substituting saved contents', async () => {
        appliedHome.serverUrl = 'https://workflow.example';
        appliedHome.serverId = await home.addHome({ name: 'Workflow Home', serverUrl: 'https://workflow.example', accountId: 'account-a' });
        getStorage().setState({ profileScope: { serverId: appliedHome.serverId, accountId: 'account-a' } });
        home.answer(appliedHome.serverId, '/v1/teams/get', { body: teamSummaryFixture({ id: 'team-a', name: 'Builders',
            viewerRole: 'member', capabilities: teamCapabilitiesFixture({}) }) });
        const definitionId = '8fab3a81-5e64-4000-8000-000000000001';
        const definition = createWorkflowDefinitionFixture({ inputs: [], blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Saved contents', references: [], attachments: [] } }] });
        transport.mockImplementation(async (action: string, input: unknown) => {
            if (action === 'workflow.definition.get') return { ok: true, result: { definitionId, definition, access: 'owner',
                revision: { headerVersion: 3, bodyVersion: 3 }, metadata: { title: 'Shared draft' } } };
            if (action === 'workflow.trigger.list') return { ok: true, result: { sets: [] } };
            if (action === 'artifact.access.grants.list') return { ok: true, result: { artifactId: definitionId,
                ownerAccountId: 'account-a', access: 'owner', grants: [{ principal: { kind: 'team', teamId: 'team-a' },
                    accessLevel: 'edit', createdByAccountId: 'account-a', createdAt: 1, display: { name: 'Builders' } }] } };
            if (action === 'workflow.run.start') {
                const request = (await import('@happier-dev/protocol')).WorkflowRunStartRequestV1Schema.parse(input);
                return { ok: true, result: { admission: 'created', run: createWorkflowRunSummaryFixture({ id: request.runId,
                    sourceArtifactId: definitionId, visibleTeamId: 'team-a' }) } };
            }
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
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
        expect(transport.mock.calls.filter(([action]) => action === 'workflow.run.start')[0]?.[1]).toMatchObject({
            source: { kind: 'inline', sourceArtifactId: definitionId, visibleTeamId: 'team-a',
                definition: { blocks: [{ document: { text: 'Reviewed unsaved contents' } }] } },
        });
        expect(transport.mock.calls.filter(([action]) => ['workflow.definition.update', 'workflow.definition.create'].includes(action))).toHaveLength(0);
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

    it('reopens the catalog composer with its unresolved admission and opens that exact Run after the feed settles it', async () => {
        const { getBuiltinWorkflowCatalogV1, WorkflowRunStartRequestV1Schema, WorkflowRunGetResultV1Schema } = await import('@happier-dev/protocol');
        const { WorkflowRunComposer } = await import('../run/WorkflowRunComposer');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const builtin = getBuiltinWorkflowCatalogV1().find(entry => entry.requiresOriginSession !== true)!;
        let startedId: string | null = null;
        let admitted = false;
        const detailFor = (runId: string) => WorkflowRunGetResultV1Schema.parse({
            run: createWorkflowRunSummaryFixture({ id: runId, origin: { kind: 'direct' } }),
            callerAccess: { canEdit: true },
            definition: builtin.definition, authoredDefinition: builtin.definition, checkpoint: null,
            acceptedContext: { startedBy: 'user', source: { kind: 'catalog', ref: builtin.id, version: builtin.version },
                inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
                materializedLeaves: [], frozenChildren: {},
                workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } }, origin: { kind: 'direct' } },
        });
        transport.mockImplementation(async (action: string, input: unknown) => {
            if (action === 'workflow.run.start') {
                startedId = WorkflowRunStartRequestV1Schema.parse(input).runId;
                return { ok: false, errorCode: 'workflow_outcome_unresolved', error: 'Lost reply' };
            }
            if (action === 'workflow.run.get' && admitted && startedId) return { ok: true, result: detailFor(startedId) };
            return { ok: false, errorCode: 'run_not_found', error: 'Not yet admitted' };
        });
        const screen = await renderScreen(<AppPaneProvider><WorkflowBuiltinEditorHostScreen workflow={builtin.id} intent="run" /></AppPaneProvider>, {
            createNodeMock: () => ({ measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40) }),
        });
        await act(async () => { screen.root.findByType(WorkflowRunComposer).props.onRun(undefined); });
        expect(startedId).not.toBeNull();
        expect(screen.root.findByType(WorkflowRunComposer).props.reconciling).toBe(true);
        await act(async () => { screen.root.findByType(WorkflowRunComposer).props.onCancel(); });
        expect(screen.root.findAllByType(WorkflowRunComposer)).toHaveLength(0);
        await screen.pressByTestIdAsync('workflow-builtin-run-now');
        expect(screen.root.findByType(WorkflowRunComposer).props).toMatchObject({ pending: true, reconciling: true });
        await act(async () => { screen.root.findByType(WorkflowRunComposer).props.onRun(undefined); });
        expect(transport.mock.calls.filter(([action]) => action === 'workflow.run.start')).toHaveLength(1);
        // Validate the boundary fixture outside the recovery catch, so malformed
        // transport data fails here rather than masquerading as an unknown outcome.
        detailFor(startedId!);
        await act(async () => { admitted = true; publishHomeAccountChange('server-a', [`workflow-run:${startedId}`]); });
        expect(screen.root.findAllByType(WorkflowRunComposer)).toHaveLength(0);
        expect(getStorage().getState().workflowRunsById[startedId!]?.summary?.id).toBe(startedId);
        const { router } = await import('expo-router');
        const { createWorkflowRunRoute } = await import('@/sync/domains/workflows/workflowRunRoute');
        expect(router.push).toHaveBeenLastCalledWith(createWorkflowRunRoute(startedId!));
    });

    it('opens the real native engine panel from the step composer and only edits authoring values', async () => {
        const definitionId = '8fab3a81-5e64-4000-8000-000000000001';
        const definition = createWorkflowDefinitionFixture({ roles: [{ roleId: 'local-reviewer', name: 'Local reviewer',
            instructions: 'Review this workflow', runsAs: { kind: 'session' } }] });
        transport.mockImplementation(async (action: string) => {
            if (action === 'workflow.definition.get') return { ok: true, result: { definitionId, definition, access: 'owner',
                revision: { headerVersion: 3, bodyVersion: 3 }, metadata: { title: 'Saved draft' } } };
            return action === 'workflow.trigger.list' ? { ok: true, result: { sets: [] } }
                : { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        });
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
        expect(readStep().execution?.engine?.agentTarget).toBeDefined();
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
        expect(transport.mock.calls.filter(([action]) => ['session.spawn', 'workflow.run.start', 'workflow.definition.update'].includes(action))).toHaveLength(0);
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
        transport.mockImplementation(async (action: string) => {
            if (action === 'workflow.definition.get') return { ok: true, result: { definitionId, access: 'view',
                definition: createWorkflowDefinitionFixture(), revision: { headerVersion: 3, bodyVersion: 3 }, metadata: { title: 'Shared workflow' } } };
            if (action === 'workflow.trigger.list') return { ok: true, result: { sets: [] } };
            return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        });
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
        await screen.pressByTestIdAsync('workflow-editor-save');
        expect(transport.mock.calls.filter(([action]) => action === 'workflow.trigger.add')).toHaveLength(1);
        expect(transport.mock.calls.filter(([action]) => action === 'workflow.definition.update' || action === 'workflow.definition.create')).toHaveLength(0);
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
        transport.mockImplementation(async (action: string) => {
            if (action === 'workflow.definition.get') return { ok: true, result: {
                definitionId, definition, access, revision: { headerVersion: 3, bodyVersion: 3 }, metadata: { title: 'Shared workflow' },
            } };
            if (action === 'workflow.trigger.list') return { ok: true, result: { sets: [] } };
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        });
        const screen = await renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'saved', definitionId,
            ...(agentSnapshot ? { agentRevision: { definitionId, definition, revision: { headerVersion: 2, bodyVersion: 2 },
                metadata: { title: 'Reviewed agent snapshot' }, changedBlockIds: [] } } : {}),
        }} /></AppPaneProvider>, {
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
            expect(body.props.documentPresentation).toBeUndefined();
            expect(body.props.onSave).toBeTypeOf('function');
            expect(body.props.onEditWithAgent).toBeTypeOf('function');
            expect(screen.findByTestId('workflow-editor-name')).not.toBeNull();
        }
        expect(body.props.onRunNow).toBeTypeOf('function');
        if (access === 'view') {
            await screen.pressByTestIdAsync('workflow-editor-run-now');
            expect(screen.findByTestId('workflow-run-inputs-preview')).not.toBeNull();
            expect(screen.findByTestId('workflow-start-where-chip')).not.toBeNull();
            expect(transport.mock.calls.filter(([action]) => action === 'workflow.run.start')).toHaveLength(0);
        }
        expect(transport.mock.calls.filter(([action]) => ['workflow.definition.update', 'workflow.definition.create', 'workflow.trigger.add', 'workflow.trigger.update', 'workflow.trigger.remove'].includes(action))).toHaveLength(0);
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
        expect(transport.mock.calls.filter(([action]) => action === 'workflow.run.start')).toHaveLength(0);
        expect(screen.findByTestId('workflow-run-inputs-preview')).not.toBeNull();
        expect(screen.findByTestId('workflow-start-where-chip')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-inputs-unsaved')).not.toBeNull();
        transport.mockImplementation(async (action: string, input: unknown) => {
            if (action !== 'workflow.run.start') return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
            const request = (await import('@happier-dev/protocol')).WorkflowRunStartRequestV1Schema.parse(input);
            return { ok: true, result: { admission: 'created', run: createWorkflowRunSummaryFixture({ id: request.runId, origin: { kind: 'direct' } }) } };
        });
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(transport.mock.calls.filter(([action]) => action === 'workflow.run.start')[0]?.[1]).toMatchObject({
            metadata: { title: 'Unsaved name' }, source: { kind: 'inline', definition: { blocks: [{ kind: 'wait', id: 'review' }] } },
        });
        expect(transport.mock.calls.filter(([action]) => action === 'workflow.definition.create' || action === 'workflow.definition.update')).toHaveLength(0);
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

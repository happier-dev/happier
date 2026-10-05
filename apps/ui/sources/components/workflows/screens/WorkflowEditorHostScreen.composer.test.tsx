import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Alert, View } from 'react-native';
import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { buildWorkflowReviewedRunSeed, storeWorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';
import { WorkflowEditorHostScreen } from './WorkflowEditorHostScreen';
import { WorkflowBuiltinEditorHostScreen } from './WorkflowCatalogEditorHostScreen';
import { AgentInputChipPickerPanel } from '@/components/sessions/agentInput/components/AgentInputChipPickerPanel';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { AgentInput } from '@/components/sessions/agentInput';
import { SessionAuthoringControls } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import { WorkflowTriggerSection } from '../triggers/WorkflowTriggerSection';
import { editWorkflowTriggerDraft } from '../triggers/workflowTriggerDraft';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { SplitCanvasLeafFrame } from '@/components/appShell/splitCanvas/components/SplitCanvasLeafFrame';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';

const transport = vi.hoisted(() => vi.fn());
const viewport = vi.hoisted(() => ({ width: 1280 }));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => transport }));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => ({ serverId: 'server-a' }),
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

describe('editor workflow composer', () => {
    beforeEach(() => {
        viewport.width = 1280;
        const machine = createMachineFixture();
        getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' }, isDataReady: true,
            machines: { [machine.id]: machine }, machineListByServerId: {} });
        transport.mockReset();
        transport.mockImplementation(async (action: string, input: unknown) => {
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
        expect(composer.props.extraActionChips.some((chip: { key: string }) => chip.key === 'workflow-step-engine')).toBe(false);
        await screen.pressByTestIdAsync('agent-input-agent-chip');
        const panel = screen.root.findByType(AgentInputChipPickerPanel);
        const option = panel.props.options.find((candidate: { id: string; disabled?: boolean }) => candidate.id !== 'roles' && !candidate.disabled);
        expect(option).toBeDefined();
        await act(async () => option.onSelectImmediate());
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        const body = screen.root.findByType(WorkflowEditorBody);
        expect(body.props.draft.blocks[0].execution?.engine?.agentTarget).toBeDefined();
        expect(body.props.draft.blocks[0].execution?.agentTarget).toBeUndefined();
        expect(body.props.draft.blocks[0].execution?.modelSelection).toBeUndefined();
        await act(async () => body.props.onChange({ ...body.props.draft, blocks: [{ ...body.props.draft.blocks[0],
            execution: { ...body.props.draft.blocks[0].execution, sessionConfigOptionOverrides: { v: 1, updatedAt: 1,
                overrides: { budget: { value: 42, updatedAt: 1 } } } } }] }));
        const { NewSessionEngineOptionDetail } = await import('@/components/sessions/new/components/NewSessionEngineOptionDetail');
        await screen.pressByTestIdAsync(`agent-input-chip-picker.option:${option.id}`);
        const detail = screen.root.findByType(NewSessionEngineOptionDetail);
        await act(async () => detail.props.onSelectionChange({ modelId: 'selected-model', sessionModeId: null,
            configOverrides: { reasoning_effort: 'high' } }));
        expect(body.props.draft.blocks[0].execution.engine).toMatchObject({
            modelSelection: { ref: { modelId: 'selected-model' } }, effort: 'high',
        });
        expect(detail.props.selectedModelId).toBe('selected-model');
        expect(detail.props.selectedConfigOverrides.reasoning_effort).toBe('high');
        expect(body.props.draft.blocks[0].execution.sessionConfigOptionOverrides.overrides.budget?.value).toBe(42);
        const { validateWorkflowEditorDraft } = await import('@/sync/domains/workflows/workflowAuthoring');
        expect(validateWorkflowEditorDraft(body.props.draft).valid).toBe(true);
        await screen.pressByTestIdAsync('agent-input-chip-picker.option:roles');
        await screen.pressByTestIdAsync('roles-rail-option:local-reviewer');
        expect(body.props.draft.blocks[0].execution.engine).toEqual({ role: 'local-reviewer' });
        expect(body.props.draft.blocks[0].execution.agentTarget).toBeUndefined();
        expect(body.props.draft.blocks[0].execution.modelSelection).toBeUndefined();
        expect(validateWorkflowEditorDraft(body.props.draft).valid).toBe(true);
        expect(transport.mock.calls.filter(([action]) => ['session.spawn', 'workflow.run.start', 'workflow.definition.update'].includes(action))).toHaveLength(0);
        await screen.pressByTestIdAsync(`workflow-editor-step-${body.props.draft.blocks[0].id}-customize`);
        const { WorkflowStepInspector } = await import('../editor/WorkflowStepInspector');
        const inspector = screen.root.findByType(WorkflowStepInspector);
        await screen.pressByTestIdAsync(`${inspector.props.testIDPrefix}-agentTarget-reset`);
        expect(body.props.draft.blocks[0].execution.engine).toBeUndefined();
        expect(body.props.draft.blocks[0].execution.acpSessionModeId).toBeUndefined();
        expect(body.props.draft.blocks[0].execution.sessionConfigOptionOverrides).toBeUndefined();
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
        await act(async () => body.props.onChangeProjectTarget({ machineId: 'machine-1', directory: '/repo' }));
        await screen.pressByTestIdAsync('workflow-editor-save');
        expect(transport.mock.calls.filter(([action]) => action === 'workflow.trigger.add')).toHaveLength(1);
        expect(transport.mock.calls.filter(([action]) => action === 'workflow.definition.update' || action === 'workflow.definition.create')).toHaveLength(0);
        expect(body.props.saveStatus.kind).toBe('failed');
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
            expect(body.props.menuActions.map((action: { id: string }) => action.id)).not.toContain('agent');
            expect(body.props.menuActions.map((action: { id: string }) => action.id)).not.toContain('delete');
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

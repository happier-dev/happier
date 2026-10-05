import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { WorkflowTriggerSection } from '../triggers/WorkflowTriggerSection';
import { editWorkflowTriggerDraft } from '../triggers/workflowTriggerDraft';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import type { IModal } from '@/modal';
import { WorkflowDefinitionCreateRequestV1Schema, WorkflowDefinitionGetRequestV1Schema, WorkflowDefinitionUpdateRequestV1Schema, WorkflowDefinitionV1Schema, WorkflowRunStartRequestV1Schema, type ActionExecutorContext, type WorkflowDefinitionCreateRequestV1, type WorkflowDefinitionGetRequestV1, type WorkflowDefinitionGetResultV1, type WorkflowDefinitionUpdateRequestV1, type WorkflowRunStartRequestV1, type WorkflowRunStartResultV1 } from '@happier-dev/protocol';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { AgentInput } from '@/components/sessions/agentInput';
import { invokeTestInstanceHandler } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { readNewSessionDraftProjectionFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getActionSpec } from '@happier-dev/protocol';
import { buildWorkflowReviewedRunSeed, storeWorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';
import { readWorkflowAgentRevision, storeWorkflowAgentRevision } from '@/sync/domains/workflows/workflowAgentRevision';
import type { Machine } from '@/sync/domains/state/storageTypes';
// Resolve the real screen/store graph during collection, outside a behavioral
// test's timeout; Vitest hoists the system-boundary fixture declarations below.
import { WorkflowEditorHostScreen } from './WorkflowEditorHostScreen';
import { insertWorkflowStarterExample } from '@/sync/domains/workflows/workflowEditorDraft';
import { removeWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WORKFLOW_STARTER_EXAMPLES_V1 } from '@happier-dev/protocol';
import { t } from '@/text';

type WorkflowEditorBodyProps = React.ComponentProps<
    typeof import('./WorkflowEditorBody').WorkflowEditorBody
>;

const modalShowSpy = vi.hoisted(() => vi.fn<IModal['show']>(() => 'workflow-run-input-modal'));
const modalHideSpy = vi.hoisted(() => vi.fn<IModal['hide']>());
const modalUpdateSpy = vi.hoisted(() => vi.fn<IModal['update']>());
let latestBodyProps: WorkflowEditorBodyProps | null = null;
let restoreWebGlobals: (() => void) | undefined;
const focusPromptSpy = vi.fn<(blockId: string) => void>();

function requireDefined<T>(value: T | undefined, message: string): T {
    if (value === undefined) throw new Error(message);
    return value;
}

function renderRunEditor(element: React.ReactElement) {
    return renderScreen(element, {
        wrapper: ({ children }) => <AppPaneProvider>{children}</AppPaneProvider>,
        // Physical anchor geometry is the platform boundary; the Popover and composer stay real.
        createNodeMock: () => ({
            getBoundingClientRect: () => ({ left: 600, top: 100, width: 160, height: 40 }),
            addEventListener: () => {}, removeEventListener: () => {},
            measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40),
        }),
    });
}

const editorAccountScope = vi.hoisted(() => ({
    state: {
        current: { serverId: 'server-a', accountId: 'account-a' } as { serverId: string; accountId: string } | null,
    },
}));

function switchEditorAccountScope(next: { serverId: string; accountId: string } | null): void {
    editorAccountScope.state.current = next;
    getStorage().setState({ profileScope: next });
}

function setEditorMachines(machines: Machine[]): void {
    getStorage().setState({ machines: Object.fromEntries(machines.map((machine) => [machine.id, machine])), machineListByServerId: {} });
}

function storeReviewedCopyFixture(): string {
    return storeWorkflowReviewedRunSeed(buildWorkflowReviewedRunSeed({
        run: createWorkflowRunSummaryFixture(),
        definition: createWorkflowDefinitionFixture({ inputs: [{ name: 'topic', valueType: 'string', required: true }] }),
        acceptedContext: {
            startedBy: 'user',
            source: { kind: 'inline' }, machineId: 'machine-1', origin: { kind: 'direct' },
            metadata: { title: 'Accepted title', description: 'Accepted description' },
            inputs: { topic: 'Private accepted input' }, executionTarget: { kind: 'session' }, materializedLeaves: [], frozenChildren: {},
            workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo/project', checkoutRootPath: '/repo/project' } },
        },
    }));
}

const routerSpy = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));

const definitionActions = vi.hoisted(() => ({
    get: vi.fn<(request: WorkflowDefinitionGetRequestV1) => Promise<WorkflowDefinitionGetResultV1>>(),
    create: vi.fn<(request: WorkflowDefinitionCreateRequestV1) => Promise<WorkflowDefinitionGetResultV1>>(),
    update: vi.fn<(request: WorkflowDefinitionUpdateRequestV1) => Promise<WorkflowDefinitionGetResultV1>>(),
}));
// Trigger transport responses; the client, schemas and shared-store publication stay real.
const triggerActions = vi.hoisted(() => ({ list: vi.fn(async (_input: unknown) => []), add: vi.fn(), update: vi.fn(), remove: vi.fn() }));
const SAVED_TRIGGER_WORKFLOW_ID = '00000000-0000-4000-8000-000000000005';
const TRIGGER_SET_ID = '00000000-0000-4000-8000-000000000009';
const workflowDocumentPicker = vi.hoisted(() => ({ pick: vi.fn() }));

/** What the route guard was told about unsaved changes, in order. */
const guardedDirtyStates = vi.hoisted(() => [] as boolean[]);

const issuedIds = vi.hoisted(() => ({ next: 0 }));

/** Whether the selected Machine's daemon projection has resolved, and to what. */
const daemonProjection = vi.hoisted(() => ({
    resolves: false,
    inputs: {
        mergedProviderProjectionById: {},
        mergedBackendProjectionById: {},
        discoveredBackendIds: [] as string[],
    } as Record<string, unknown>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/sync/domains/state/browserRecordStorage', async () => (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());
vi.mock('expo-router', () => ({
    useRouter: () => routerSpy,
    useNavigation: () => ({}),
}));
// Ids must be genuinely distinct here: a constant would make a re-created draft
// compare equal to its baseline and hide exactly the initialization defect these
// cases exist to catch.
vi.mock('expo-crypto', () => ({
    randomUUID: () => {
        issuedIds.next += 1;
        return `00000000-0000-4000-8000-${String(issuedIds.next).padStart(12, '0')}`;
    },
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { show: modalShowSpy, hide: modalHideSpy, update: modalUpdateSpy },
    }).module;
});
// The exact Machine's daemon projection is a transport boundary; the Agent
// catalog projection beneath the host adapter stays real. The stub keeps the
// real enablement contract — no selected Machine means no projection — because
// "after the exact Machine's projection resolved" is the condition under test.
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: (params: { enabled?: boolean }) => (
        params.enabled === true && daemonProjection.resolves
            ? { phase: 'ready', inputs: daemonProjection.inputs }
            : { phase: 'idle', inputs: null }
    ),
}));
// The applied Account host is a system boundary; its lifetime stays real so
// returning to an identity cannot bypass retirement.
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => ({ serverId: editorAccountScope.state.current?.serverId }),
    isAppliedActiveServerRuntimeAvailable: () => editorAccountScope.state.current !== null,
}));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => async (actionId: string, input: unknown, context: ActionExecutorContext) => {
        if (actionId === 'workflow.definition.get') return { ok: true, result: await definitionActions.get(WorkflowDefinitionGetRequestV1Schema.parse(input)) };
        if (actionId === 'workflow.definition.create') return { ok: true, result: await definitionActions.create(WorkflowDefinitionCreateRequestV1Schema.parse(input)) };
        if (actionId === 'workflow.definition.update') return { ok: true, result: await definitionActions.update(WorkflowDefinitionUpdateRequestV1Schema.parse(input)) };
        if (actionId === 'workflow.run.start') return { ok: true, result: await runStartSpy(WorkflowRunStartRequestV1Schema.parse(input), context) };
        if (actionId === 'workflow.trigger.list') return { ok: true, result: { sets: await triggerActions.list(input) } };
        const writer = actionId === 'workflow.trigger.add' ? triggerActions.add
            : actionId === 'workflow.trigger.update' ? triggerActions.update
                : actionId === 'workflow.trigger.remove' ? triggerActions.remove : null;
        if (writer === null) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        return { ok: true, result: await writer(input) };
    },
}));
vi.mock('@/sync/domains/workflows/workflowDocumentFile', () => ({
    pickWorkflowDocumentText: workflowDocumentPicker.pick,
    saveWorkflowDocument: vi.fn(),
    workflowDocumentFileName: () => 'workflow.json',
}));
const runStartSpy = vi.hoisted(() => vi.fn<(request: WorkflowRunStartRequestV1, context: ActionExecutorContext) => Promise<WorkflowRunStartResultV1>>());
// Navigation interception is a host boundary; this records the dirty verdict the
// editor reports so pristine/dirty can be asserted without a navigation event.
vi.mock('@/utils/navigation/useUnsavedChangesBeforeRemoveGuard', () => ({
    useUnsavedChangesBeforeRemoveGuard: (params: { isDirty: boolean }) => {
        guardedDirtyStates.push(params.isDirty);
    },
}));
vi.mock('@/utils/navigation/useActiveUnsavedChangesGuard', () => ({
    useActiveUnsavedChangesGuard: () => {},
}));
// The pane host decides whether a details pane exists; it is this screen's layout boundary.
const detailsPane = vi.hoisted(() => ({ available: true }));
vi.mock('@/components/appShell/panes/details/detailsPaneAvailability', () => ({
    useDetailsPaneAvailable: () => detailsPane.available,
}));
vi.mock('./WorkflowEditorBody', async () => {
    const ReactModule = await import('react');
    return {
        // The host reaches the page commands only through `commandsRef`; this
        // stand-in forwards them to the effect owners without the page gate.
        WorkflowEditorBody: (props: WorkflowEditorBodyProps) => {
            latestBodyProps = props;
            ReactModule.useImperativeHandle(props.commandsRef, () => ({
                runNow: () => props.onRunNow?.(),
                save: () => props.onSave?.(),
                schedule: () => undefined,
                exportJson: () => props.onExportJson?.(),
                focusPrompt: (blockId: string) => { focusPromptSpy(blockId); },
            }), [props]);
            return ReactModule.createElement('WorkflowEditorBody', { testID: 'workflow-editor-body', ref: props.runNowAnchorRef });
        },
        setWorkflowStepExecutionField: (value: unknown) => value,
    };
});

beforeEach(() => {
    restoreWebGlobals = withPopoverWebGlobals();
    latestBodyProps = null;
    detailsPane.available = true;
    focusPromptSpy.mockClear();
    setEditorMachines([]);
    getStorage().setState({ settings: settingsDefaults });
    getStorage().setState({ workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {} });
    guardedDirtyStates.length = 0;
    issuedIds.next = 0;
    routerSpy.push.mockClear();
    routerSpy.back.mockClear();
    runStartSpy.mockReset();
    runStartSpy.mockImplementation(async (request) => ({ admission: 'created', run: createWorkflowRunSummaryFixture({ id: request.runId, origin: { kind: 'direct' } }) }));
    modalShowSpy.mockClear();
    modalHideSpy.mockClear();
    modalUpdateSpy.mockClear();
    definitionActions.get.mockReset();
    definitionActions.get.mockImplementation(async ({ definitionId }) => ({ definitionId, access: 'owner',
        definition: createWorkflowDefinitionFixture(), revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved workflow' } }));
    definitionActions.create.mockReset();
    definitionActions.update.mockReset();
    triggerActions.add.mockReset();
    triggerActions.update.mockReset();
    triggerActions.remove.mockReset();
    workflowDocumentPicker.pick.mockReset();
    daemonProjection.resolves = false;
    switchEditorAccountScope({ serverId: 'server-a', accountId: 'account-a' });
});

afterEach(async () => {
    await standardCleanup();
    restoreWebGlobals?.();
    restoreWebGlobals = undefined;
});

describe('WorkflowEditorHostScreen composition', () => {
    it('discards a pristine unsaved draft through the navigation owner without a write', async () => {
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const discard = latestBodyProps?.menuActions?.find((action) => action.id === 'discard');
        expect(discard).toBeDefined();
        await act(async () => discard?.onSelect());
        expect(routerSpy.back).toHaveBeenCalledOnce();
        expect(definitionActions.create).not.toHaveBeenCalled();
        expect(definitionActions.update).not.toHaveBeenCalled();
        await screen.unmount();
    });
    it('lets a Can-use recipient save personal triggers without editing the definition', async () => {
        definitionActions.get.mockImplementationOnce(async ({ definitionId }) => ({ definitionId, access: 'view',
            definition: createWorkflowDefinitionFixture(), revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Shared workflow' } }));
        triggerActions.add.mockImplementationOnce(async () => { throw new Error('target_unavailable'); });
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        expect(latestBodyProps?.documentPresentation?.editable).toBe(false);
        expect(latestBodyProps?.onSave).toBeTypeOf('function');
        const section = latestBodyProps?.triggersSection;
        if (!React.isValidElement<React.ComponentProps<typeof WorkflowTriggerSection>>(section)) throw new Error('Missing personal triggers');
        await act(async () => latestBodyProps?.onChangeProjectTarget?.({ machineId: 'machine-1', directory: '/repo' }));
        await act(async () => section.props.onChangeDraft(editWorkflowTriggerDraft(section.props.draft, {
            kind: 'add', clientId: 'personal', trigger: { kind: 'schedule', enabled: true,
                schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } },
        })));
        expect(guardedDirtyStates.at(-1)).toBe(true);
        await act(async () => latestBodyProps?.onSave?.());
        expect(triggerActions.add).toHaveBeenCalledWith(expect.objectContaining({ workflow: SAVED_TRIGGER_WORKFLOW_ID }));
        expect(definitionActions.update).not.toHaveBeenCalled();
        expect(definitionActions.create).not.toHaveBeenCalled();
        expect(latestBodyProps?.saveStatus?.kind).toBe('failed');
        await screen.unmount();
    });

    it('duplicates a Can-use workflow into an unsaved portable draft, without a write', async () => {
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } });
        definitionActions.get.mockImplementationOnce(async ({ definitionId }) => ({ definitionId, access: 'view',
            definition, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Shared workflow', description: 'Portable purpose' } }));
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SAVED_TRIGGER_WORKFLOW_ID }} />);
        const duplicate = latestBodyProps?.menuActions?.find((action) => action.id === 'duplicate');
        expect(duplicate).toBeDefined();
        await act(async () => duplicate?.onSelect());
        const route = routerSpy.push.mock.calls.at(-1)?.[0] as { pathname: string; params: { definitionDraftSeedId: string } };
        expect(route.pathname).toBe('/workflows/new');
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId: route.params.definitionDraftSeedId }} />);
        expect(latestBodyProps?.draft).toMatchObject({ name: t('workflows.copyName', { name: 'Shared workflow' }), blocks: definition.blocks, inputs: definition.inputs });
        expect(latestBodyProps?.description).toBe('Portable purpose');
        expect(latestBodyProps?.currentWorkflowRef).toBeNull();
        expect(latestBodyProps?.saveStatus?.kind).toBe('notSaved');
        expect(latestBodyProps?.menuActions?.some((action) => action.id === 'discard')).toBe(true);
        expect(definitionActions.create).not.toHaveBeenCalled();
        expect(definitionActions.update).not.toHaveBeenCalled();
        expect(triggerActions.add).not.toHaveBeenCalled();
        definitionActions.create.mockImplementationOnce(async (request) => ({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
            access: 'owner', definition: WorkflowDefinitionV1Schema.parse(request.definition), metadata: request.metadata,
            revision: { headerVersion: 1, bodyVersion: 1 } }));
        await act(async () => latestBodyProps?.onSave?.());
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
        const original = latestBodyProps!.draft;
        const removed = removeWorkflowBlock(original, original.blocks[0]!.id);
        await act(async () => latestBodyProps!.onChange(removed.draft, 'Remove step'));
        const inserted = insertWorkflowStarterExample(latestBodyProps!.draft, WORKFLOW_STARTER_EXAMPLES_V1[0]!, 'Example');
        await act(async () => latestBodyProps!.onChange(inserted.draft, 'Insert example'));
        expect(latestBodyProps!.history?.undoLabel).toBe('Insert example');
        await act(async () => latestBodyProps!.history!.undo());
        expect(latestBodyProps!.draft).toEqual(removed.draft);
        expect(latestBodyProps!.history?.undoLabel).toBe('Remove step');
        await act(async () => latestBodyProps!.history!.undo());
        expect(latestBodyProps!.draft).toEqual(original);
        const renamed = { ...base, revision: { headerVersion: 5, bodyVersion: 9 }, metadata: { title: 'Agent rename', description: 'Agent purpose' }, changedBlockIds: ['step-1'] };
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: base.definitionId, agentRevision: renamed }} />);
        expect(latestBodyProps!.draft.name).toBe('Agent rename');
        expect(latestBodyProps!.description).toBe('Agent purpose');
        expect(latestBodyProps!.history?.redoLabel).toBeNull();
        await act(async () => latestBodyProps!.history!.undo());
        expect(latestBodyProps!.draft).toEqual(original);
        expect(latestBodyProps!.description).toBe('Original purpose');
        expect(latestBodyProps!.saveStatus?.kind).toBe('unsaved');
        await act(async () => latestBodyProps!.history!.redo());
        expect(latestBodyProps!.draft.name).toBe('Agent rename');
        expect(latestBodyProps!.saveStatus?.kind).toBe('saved');
        await act(async () => latestBodyProps!.history!.undo());
        definitionActions.update.mockResolvedValue({ definitionId: base.definitionId, definition: base.definition, access: 'owner',
            metadata: base.metadata, revision: { headerVersion: 6, bodyVersion: 10 } });
        await act(async () => latestBodyProps!.onSave?.());
        expect(definitionActions.update).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: renamed.revision,
            metadata: { title: 'Saved', description: 'Original purpose' } }));
        expect(latestBodyProps!.history?.redoLabel).not.toBeNull();
        expect(latestBodyProps!.saveStatus?.kind).toBe('saved');
        await act(async () => latestBodyProps!.onChange({ ...latestBodyProps!.draft, name: 'My rename' }, 'Rename'));
        expect(latestBodyProps!.history?.redoLabel).toBeNull();
    });

    it('commits text at its input boundary and undoes metadata and targets in one source-local history', async () => {
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const original = latestBodyProps!.draft;
        await act(async () => latestBodyProps!.onChange({ ...original, name: 'Typing' }, 'Name', false));
        expect(latestBodyProps!.history?.undoLabel).toBeNull();
        await act(async () => latestBodyProps!.onCommitChange?.());
        expect(latestBodyProps!.history?.undoLabel).toBe('Name');
        await act(async () => latestBodyProps!.onChangeDescription?.('Purpose'));
        await act(async () => latestBodyProps!.onCommitChange?.());
        await act(async () => latestBodyProps!.onChangeProjectTarget?.({ machineId: 'machine-1', directory: '/project' }));
        await act(async () => latestBodyProps!.onChangeExecutionTarget?.('detached_run'));
        await act(async () => latestBodyProps!.history!.undo());
        expect(latestBodyProps!.executionTarget).toBe('session');
        await act(async () => latestBodyProps!.history!.undo());
        expect(latestBodyProps!.projectTarget).toBeNull();
        await act(async () => latestBodyProps!.history!.undo());
        expect(latestBodyProps!.description).toBe('');
        await act(async () => latestBodyProps!.history!.undo());
        expect(latestBodyProps!.draft.name).toBe(original.name);
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'new', exampleKey: WORKFLOW_STARTER_EXAMPLES_V1[0]!.key }} />);
        expect(latestBodyProps!.history?.undoLabel).toBeNull();
        expect(latestBodyProps!.history?.redoLabel).toBeNull();
    });

    it('orders trigger edits with document edits instead of owning a separate trigger history', async () => {
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const readSection = () => {
            const section = latestBodyProps!.triggersSection;
            if (!React.isValidElement<React.ComponentProps<typeof WorkflowTriggerSection>>(section)) throw new Error('Expected trigger editor');
            return section.props;
        };
        const trigger = { kind: 'schedule', enabled: true, schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } } as const;
        await act(async () => readSection().onChangeDraft(editWorkflowTriggerDraft(readSection().draft, { kind: 'add', clientId: 'schedule-1', trigger })));
        await act(async () => latestBodyProps!.onChange({ ...latestBodyProps!.draft, name: 'After trigger' }, 'Rename'));
        await act(async () => latestBodyProps!.history!.undo());
        expect(latestBodyProps!.draft.name).toBe('');
        expect(readSection().draft.adds).toHaveLength(1);
        await act(async () => latestBodyProps!.history!.undo());
        expect(readSection().draft.adds).toHaveLength(0);
        await act(async () => latestBodyProps!.history!.redo());
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
        expect(latestBodyProps?.draft.name).toBe('Agent snapshot');
        expect(latestBodyProps?.description).toBe('Exact saved description');
        expect(latestBodyProps?.highlightedBlockIds).toEqual(['step-1']);
        expect(definitionActions.get).toHaveBeenCalledWith({ definitionId });
        const next = { ...newer, seq: 101, id: 'post-open-update', tool: { ...newer.tool, id: 'post-open-update', completedAt: 1, result: { definitionId, access: 'owner', definition: agentRevision.definition,
            revision: { headerVersion: 10, bodyVersion: 10 }, metadata: { title: 'Saved after opening' } } } };
        await act(async () => getStorage().setState({ sessionMessages: { 'author-session': createSessionMessagesFixture({
            messageIdsOldestFirst: [next.id], messagesById: { [next.id]: next }, isLoaded: true,
        }) } }));
        expect(latestBodyProps?.draft.name).toBe('Saved after opening');
        expect(latestBodyProps?.highlightedBlockIds).toEqual([]);
        expect(latestBodyProps?.saveStatus).toMatchObject({ kind: 'saved', byAgent: true });
        expect(definitionActions.get).toHaveBeenCalledWith({ definitionId });
        const currentDraft = latestBodyProps?.draft;
        if (!currentDraft) throw new Error('Expected the clean agent reload');
        await act(async () => latestBodyProps?.onChange({ ...currentDraft, name: 'My unsaved edit' }));
        const changed = { ...next, seq: 102, id: 'second-post-open-update', tool: { ...next.tool, id: 'second-post-open-update', completedAt: 2, result: {
            ...next.tool.result, revision: { headerVersion: 11, bodyVersion: 11 }, metadata: { title: 'Another agent save' },
        } } };
        await act(async () => getStorage().setState({ sessionMessages: { 'author-session': createSessionMessagesFixture({
            messageIdsOldestFirst: [changed.id], messagesById: { [changed.id]: changed }, isLoaded: true,
        }) } }));
        expect(latestBodyProps?.draft.name).toBe('My unsaved edit');
        expect(latestBodyProps?.saveConflict?.currentDraft?.name).toBe('Another agent save');
        expect(latestBodyProps?.saveConflict?.currentRevision).toEqual({ headerVersion: 11, bodyVersion: 11 });
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
        expect(latestBodyProps?.draft.name).toBe('Agent snapshot');
        if (dirty) await act(async () => latestBodyProps!.onChange({ ...latestBodyProps!.draft, name: 'My unsaved edit' }));

        const lateRunning = { ...running, id: 'older-call-hydrated-after-open', seq: 97 };
        await act(async () => publish([running, historical, lateRunning]));
        const lateCompleted = { ...lateRunning, tool: { ...lateRunning.tool, state: 'completed' as const, completedAt: 1,
            result: { definitionId, access: 'owner', definition: base.definition, revision: { headerVersion: 6, bodyVersion: 10 }, metadata: { title: 'Hydrated older call' } },
        } };
        await act(async () => publish([running, historical, lateCompleted]));
        expect(latestBodyProps?.draft.name).toBe(dirty ? 'My unsaved edit' : 'Agent snapshot');
        expect(latestBodyProps?.saveConflict).toBeNull();

        const saved: WorkflowDefinitionGetResultV1 = { definitionId, access: 'owner', definition: base.definition,
            revision: { headerVersion: 5, bodyVersion: 9 }, metadata: { title: 'Saved after opening' } };
        const completed = { ...running, tool: { ...running.tool, state: 'completed' as const, completedAt: 1, result: saved } };
        await act(async () => publish([completed, historical, lateCompleted]));
        if (dirty) {
            expect(latestBodyProps?.draft.name).toBe('My unsaved edit');
            expect(latestBodyProps?.saveConflict?.currentDraft?.name).toBe('Saved after opening');
            expect(latestBodyProps?.saveConflict?.currentRevision).toEqual(saved.revision);
        } else {
            expect(latestBodyProps?.draft.name).toBe('Saved after opening');
            expect(latestBodyProps?.saveStatus).toMatchObject({ kind: 'saved', byAgent: true });
            expect(latestBodyProps?.saveConflict).toBeNull();
        }
        expect(definitionActions.get).toHaveBeenCalledWith({ definitionId });

        const seedId = storeWorkflowAgentRevision({ ...base, metadata: { title: 'Another selected snapshot' } }, 'author-session');
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevisionSeedId: seedId }} />);
        expect(latestBodyProps?.draft.name).toBe('Another selected snapshot');
        expect(latestBodyProps?.saveConflict).toBeNull();
    });

    it('keeps dirty local edits when a newer agent revision arrives and offers the canonical conflict', async () => {
        const definitionId = SAVED_TRIGGER_WORKFLOW_ID;
        const base = { definitionId, definition: createWorkflowDefinitionFixture(),
            revision: { headerVersion: 4, bodyVersion: 8 }, metadata: { title: 'Saved' }, changedBlockIds: [] };
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevision: base }} />);
        const original = latestBodyProps?.draft;
        if (!original) throw new Error('Expected exact saved snapshot');
        await act(async () => latestBodyProps?.onChange({ ...original, name: 'My local edit' }));
        const next = { ...base, metadata: { title: 'Agent rename' }, revision: { headerVersion: 5, bodyVersion: 9 }, changedBlockIds: ['step-1'] };
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevision: next }} />);
        expect(latestBodyProps?.draft.name).toBe('My local edit');
        expect(latestBodyProps?.saveConflict?.currentDraft?.name).toBe('Agent rename');
        expect(latestBodyProps?.saveConflict?.currentRevision).toEqual(next.revision);
        expect(latestBodyProps?.highlightedBlockIds ?? []).toEqual([]);
    });

    it('a clean agent reload uses returned IDs only and clears the tint on selection', async () => {
        const definitionId = SAVED_TRIGGER_WORKFLOW_ID;
        const base = { definitionId, definition: createWorkflowDefinitionFixture(),
            revision: { headerVersion: 4, bodyVersion: 8 }, metadata: { title: 'Saved' }, changedBlockIds: [] };
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevision: base }} />);
        const next = { ...base, metadata: { title: 'New saved title' }, revision: { headerVersion: 5, bodyVersion: 9 }, changedBlockIds: ['step-1'] };
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevision: next }} />);
        expect(latestBodyProps?.draft.name).toBe('New saved title');
        expect(latestBodyProps?.highlightedBlockIds).toEqual(['step-1']);
        expect(latestBodyProps?.saveStatus).toMatchObject({ kind: 'saved', byAgent: true });
        await act(async () => latestBodyProps?.onSelectBlock('step-1'));
        expect(latestBodyProps?.highlightedBlockIds).toEqual([]);
    });
    it('Edit with an agent seeds the saved identity and revision into the Agent tab, never the local draft', async () => {
        await prepareSessionDraftPersistenceStorage();
        const definitionId = SAVED_TRIGGER_WORKFLOW_ID;
        const base = { definitionId, definition: createWorkflowDefinitionFixture(),
            revision: { headerVersion: 4, bodyVersion: 8 }, metadata: { title: 'Saved' }, changedBlockIds: [] };
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevision: base }} />);
        const draft = latestBodyProps?.draft;
        if (!draft) throw new Error('Expected saved draft');
        await act(async () => latestBodyProps?.onChange({ ...draft, name: 'Unsaved local name' }));
        // Wide: the header's quiet action, not a ⋯ item, and no modal (04 §4.6, §4.7).
        expect(latestBodyProps?.menuActions?.find((action) => action.id === 'agent')).toBeUndefined();
        await act(async () => latestBodyProps?.onEditWithAgent?.());
        expect(modalShowSpy.mock.calls.some((call) => call[0]?.chrome?.testID === 'workflow-agent-authoring-sheet')).toBe(false);
        const authoringDraft = latestBodyProps?.authoringDraft;
        if (!authoringDraft) throw new Error('Expected the Agent tab draft');
        const seed = readNewSessionDraftProjectionFromRepository({ draftId: authoringDraft.draftId, scope: { serverId: 'server-a', accountId: 'account-a' } });
        expect(seed?.draft.input).toContain('name=Saved');
        expect(seed?.draft.input).toContain(`definitionId=${definitionId}`);
        expect(seed?.draft.input).toContain('headerVersion=4');
        expect(seed?.draft.input).toContain('bodyVersion=8');
        expect(seed?.draft.input).not.toContain('Unsaved local name');
    });
    it('on a phone, Edit with an agent stays in ⋯ and opens the seeded sheet', async () => {
        detailsPane.available = false;
        await prepareSessionDraftPersistenceStorage();
        const definitionId = SAVED_TRIGGER_WORKFLOW_ID;
        const base = { definitionId, definition: createWorkflowDefinitionFixture(),
            revision: { headerVersion: 4, bodyVersion: 8 }, metadata: { title: 'Saved' }, changedBlockIds: [] };
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId, agentRevision: base }} />);
        expect(latestBodyProps?.onEditWithAgent).toBeUndefined();
        const edit = latestBodyProps?.menuActions?.find((action) => action.id === 'agent');
        expect(edit).toBeDefined();
        await act(async () => edit?.onSelect());
        expect(modalShowSpy.mock.calls.at(-1)?.[0]?.chrome?.testID).toBe('workflow-agent-authoring-sheet');
    });
    it('keeps the authoring Session after Edit immediately following a new draft Save', async () => {
        await prepareSessionDraftPersistenceStorage();
        const definition = createWorkflowDefinitionFixture({ defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } });
        definitionActions.create.mockResolvedValueOnce({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
            definition, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved here' } });
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const draft = latestBodyProps?.draft;
        if (!draft) throw new Error('Expected new draft');
        await act(async () => latestBodyProps?.onChange({ ...draft, name: 'Saved here', inputs: definition.inputs,
            defaults: definition.defaults, blocks: definition.blocks, finalOutput: definition.finalOutput }));
        await act(async () => latestBodyProps?.onSave?.());
        expect(definitionActions.create).toHaveBeenCalledOnce();
        await act(async () => latestBodyProps?.onEditWithAgent?.());
        const authoringDraft = latestBodyProps?.authoringDraft;
        if (!authoringDraft) throw new Error('Expected the Agent tab draft');
        await act(async () => authoringDraft.onSessionCreated('/session/author-session?serverId=server-a', { sessionId: 'author-session', serverId: 'server-a' }));
        expect(latestBodyProps?.authoringSessionId).toBe('author-session');
        expect(latestBodyProps?.authoringDraft).toBeUndefined();
    });
    it('does not attach a pending authoring Session to another editor source', async () => {
        await prepareSessionDraftPersistenceStorage();
        const base = { definitionId: SAVED_TRIGGER_WORKFLOW_ID, definition: createWorkflowDefinitionFixture(),
            revision: { headerVersion: 4, bodyVersion: 8 }, metadata: { title: 'First' }, changedBlockIds: [] };
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: base.definitionId, agentRevision: base }} />);
        await act(async () => latestBodyProps?.onEditWithAgent?.());
        const pending = latestBodyProps?.authoringDraft;
        if (!pending) throw new Error('Expected the Agent tab draft');
        const second = { ...base, definitionId: '00000000-0000-4000-8000-000000000006', metadata: { title: 'Second' } };
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: second.definitionId, agentRevision: second }} />);
        expect(latestBodyProps?.authoringDraft).toBeUndefined();
        await act(async () => pending.onSessionCreated('/session/author-session?serverId=server-a', { sessionId: 'author-session', serverId: 'server-a' }));
        expect(latestBodyProps?.draft.name).toBe('Second');
        expect(latestBodyProps?.authoringSessionId).toBeNull();
    });
    it('keeps an unavailable saved trigger in its known query after removal instead of inventing inline membership', async () => {
        const set = { automationId: TRIGGER_SET_ID, revision: 3, enabled: true,
            health: 'source_unavailable' as const, triggers: [] };
        getStorage().getState().applyWorkflowTriggerSetPage({ queryKey: `workflow:${SAVED_TRIGGER_WORKFLOW_ID}`, sets: [set] });
        triggerActions.remove.mockResolvedValueOnce({ set });
        const { removeWorkflowTrigger } = await import('@/sync/domains/workflows/workflowTriggerActions');
        await removeWorkflowTrigger({ automationId: TRIGGER_SET_ID, triggerId: 'trigger-1' });
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
        setEditorMachines([createMachineFixture({ metadata: {
            host: 'tester.local', happyCliVersion: '0.0.0-test', happyHomeDir: '/Users/tester/.happy-dev',
            homeDir: '/Users/me', platform: 'darwin',
        } })]);
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);

        await act(async () => latestBodyProps?.onChangeProjectTarget?.({
            machineId: 'machine-1',
            directory: '/Users/me/project',
        }));

        const agentTargets = latestBodyProps?.authoringFacts?.agentTargets ?? [];
        expect(agentTargets.length).toBeGreaterThan(0);
        for (const option of agentTargets) {
            expect(option.target.kind).toBe('agent');
            expect(option.target.identity.pluginId).toBeTruthy();
        }
        expect(latestBodyProps?.composerScope).toEqual({
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
        const initialDraft = latestBodyProps?.draft;
        if (initialDraft === undefined) throw new Error('Expected the new Workflow draft');

        await act(async () => latestBodyProps?.onChange({
            ...initialDraft,
            blocks: [{
                ...initialDraft.blocks[0],
                document: { text: 'Analyze the repository', references: [], attachments: [] },
            }],
        } as never));
        await screen.update(host());
        await screen.update(host());

        expect(latestBodyProps?.draft.draftId).toBe(initialDraft.draftId);
        const firstBlock = latestBodyProps?.draft.blocks[0];
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
        const firstBlockId = latestBodyProps?.draft.blocks[0]?.id;
        expect(focusPromptSpy).toHaveBeenCalledTimes(1);
        expect(focusPromptSpy).toHaveBeenCalledWith(firstBlockId);

        await screen.update(host());
        await act(async () => latestBodyProps?.onChange({ ...latestBodyProps.draft, name: 'Named' } as never));
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
            await act(async () => latestBodyProps?.onChangeProjectTarget?.({
                machineId: 'machine-1',
                directory: '/Users/me/project',
            }));
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
            const section = latestBodyProps?.triggersSection as React.ReactElement<{ whereSummary: string | null }> | undefined;
            expect(section?.props.whereSummary).toMatch(/ \/ ~\/project$/u);
            expect(section?.props.whereSummary).not.toContain('/Users/me');
            await screen.unmount();
        });

        it('adopts the contextual Agent once the exact Machine projection resolves, without becoming dirty', async () => {
            daemonProjection.resolves = true;
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            await selectMachine();
            await act(async () => {});

            const seeded = latestBodyProps?.draft.defaults.agentTarget;
            const offered = latestBodyProps?.authoringFacts?.agentTargets ?? [];
            expect(seeded).toBeDefined();
            // Only an Agent this Machine actually offers: seeding a target the
            // ingress normalizer would reject is the same defect with a nicer
            // chip label.
            expect(offered.some((option) => (
                option.target.identity.pluginId === seeded?.identity.pluginId
                && option.target.identity.localId === seeded?.identity.localId
            ))).toBe(true);
            expect(seeded).toEqual(latestBodyProps?.authoringFacts?.contextualDefaultAgentTarget);
            // Initialization, not an edit: the person has changed nothing.
            expect(guardedDirtyStates.at(-1)).toBe(false);

            await screen.unmount();
        });

        it('leaves the draft honestly unresolved when no projection can name an Agent', async () => {
            daemonProjection.resolves = false;
            const { validateWorkflowEditorDraft } = await import('@/sync/domains/workflows/workflowAuthoring');
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);

            await selectMachine();
            await act(async () => {});

            expect(latestBodyProps?.authoringFacts?.contextualDefaultAgentTarget ?? null).toBeNull();
            expect(latestBodyProps?.draft.defaults.agentTarget).toBeUndefined();

            // And the draft still says so: an unresolved Agent is refused by the
            // canonical validator rather than papered over at the chip.
            const draft = latestBodyProps?.draft;
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
                definitionId: 'saved-definition',
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
                    }],
                },
            });
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(
                <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: 'saved-definition' }} />,
            );
            await act(async () => {});
            await selectMachine();
            await act(async () => {});

            expect(latestBodyProps?.draft).toMatchObject({ name: 'Saved workflow' });
            expect(latestBodyProps?.draft.defaults.agentTarget).toBeUndefined();
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
            const draft = latestBodyProps?.draft;
            if (draft === undefined) throw new Error('Expected the new Workflow draft');
            await act(async () => latestBodyProps?.onChange({
                ...draft,
                defaults: { ...draft.defaults, agentTarget: authored },
            } as never));

            daemonProjection.resolves = true;
            await selectMachine();
            await act(async () => {});

            expect(latestBodyProps?.draft.defaults.agentTarget).toEqual(authored);
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
            expect(latestBodyProps?.draft.name).toBe('Accepted title');
            expect(latestBodyProps?.description).toBe('Accepted description');
            await act(async () => {
                latestBodyProps?.onChangeDescription?.('Edited description');
            });
            expect(latestBodyProps?.description).toBe('Edited description');
            expect(runStartSpy).not.toHaveBeenCalled();
            expect(definitionActions.create).not.toHaveBeenCalled();
            await act(async () => latestBodyProps?.onRunNow?.());
            expect(screen.findByType(AgentInput).props.value).toBe('Private accepted input');
            expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
            expect(runStartSpy).not.toHaveBeenCalled();
        });

        it('offers reviewed-copy disclosures and Back to its source Run without writing', async () => {
            await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', reviewedRunSeedId: storeReviewedCopyFixture() }} />);
            expect(latestBodyProps).toHaveProperty('reviewNotice');
            act(() => latestBodyProps?.onBackToRun?.());
            expect(routerSpy.push).toHaveBeenLastCalledWith({ pathname: '/workflows/runs/[runId]', params: { runId: 'run-1' } });
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
            expect(latestBodyProps?.draft).toMatchObject({ name: 'Account A reviewed run' });

            await act(async () => {
                switchEditorAccountScope({ serverId: 'server-a', accountId: 'account-b' });
            });

            expect(screen.findByTestId('workflow-editor-account-changed')).toBeTruthy();
            expect(screen.findByTestId('workflow-editor-body')).toBeNull();
            await act(async () => {
                switchEditorAccountScope({ serverId: 'server-a', accountId: 'account-a' });
            });
            // Returning to the same identity is a replacement Account lifetime,
            // not permission to resurrect a previously withdrawn private copy.
            expect(screen.findByTestId('workflow-editor-body')).toBeNull();
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
            expect(screen.findByTestId('workflow-editor-body')).toBeTruthy();
            const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            await act(async () => retireActiveServerAccountScopeLifetime());
            expect(screen.findByTestId('workflow-editor-body')).toBeNull();
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
        it('starts fresh history when import opens a different review document', async () => {
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            const original = latestBodyProps!.draft;
            await act(async () => latestBodyProps!.onChange({ ...original, name: 'Previous document' }, 'Rename'));
            expect(latestBodyProps!.history?.undoLabel).toBe('Rename');
            workflowDocumentPicker.pick.mockResolvedValueOnce(JSON.stringify({ kind: 'happier.workflow', version: 1,
                definition: createWorkflowDefinitionFixture({ defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } }) }));
            await act(async () => latestBodyProps!.onImportJson?.());
            expect(latestBodyProps!.draft.draftId).not.toBe(original.draftId);
            expect(latestBodyProps!.history?.undoLabel).toBeNull();
            expect(latestBodyProps!.history?.redoLabel).toBeNull();
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
            expect(latestBodyProps?.draft).toMatchObject({ name: 'Run A' });

            await screen.update(
                <WorkflowEditorHostScreen source={{ kind: 'new', reviewedRunSeedId: seedB }} />,
            );
            await act(async () => {});

            expect(latestBodyProps?.draft).toMatchObject({
                name: 'Run B',
                blocks: [expect.objectContaining({
                    document: expect.objectContaining({ text: 'Prompt B' }),
                })],
            });
            expect(latestBodyProps?.projectTarget).toEqual({
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
            const firstDraft = latestBodyProps?.draft;
            if (!firstDraft) throw new Error('Expected the first new Workflow draft');
            await act(async () => latestBodyProps?.onChange({ ...firstDraft, name: 'Unsaved source A' }));

            await screen.update(
                <WorkflowEditorHostScreen source={{ kind: 'new', requestImport: true }} />,
            );
            await act(async () => {});

            expect(workflowDocumentPicker.pick).toHaveBeenCalledTimes(1);
            expect(latestBodyProps?.draft).toMatchObject({ name: '' });
            expect(latestBodyProps?.draft?.draftId).not.toBe(firstDraft.draftId);

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
                    defaults: {},
                    blocks: [{
                        kind: 'step', id: 'review',
                        document: { text: 'Review', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    }],
                },
            });
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            const draft = latestBodyProps?.draft;
            if (draft === undefined) throw new Error('Expected the new Workflow draft');

            await act(async () => latestBodyProps?.onChange({
                ...draft,
                inputs: [{ name: 'topic', valueType: 'string', required: true }],
            } as never));
            await act(async () => requireDefined(
                latestBodyProps?.onChangeExecutionTarget,
                'Expected an execution-target change handler',
            )('detached_run'));
            await act(async () => requireDefined(latestBodyProps?.onRunNow, 'Expected a Run now handler')());
            expect(screen.findByTestId('workflow-run-inputs-main')).not.toBeNull();
            await act(async () => invokeTestInstanceHandler(screen.findByType(AgentInput), 'onChangeText', 'Source A input'));
            expect(screen.findByType(AgentInput).props.value).toBe('Source A input');

            await screen.update(
                <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: 'definition-b' }} />,
            );
            await act(async () => {});

            // The composer that was collecting the previous workflow's inputs is
            // closed, and the page-level Run as choice is the new source's own.
            expect(screen.findByTestId('workflow-run-inputs-main')).toBeNull();
            expect(latestBodyProps?.executionTarget).toBe('session');
            expect(latestBodyProps?.draft).toMatchObject({ name: 'Definition B' });
            await act(async () => latestBodyProps?.onRunNow?.());
            expect(screen.findByTestId('workflow-run-inputs-main')).toBeNull();
            expect(screen.findByTestId('workflow-run-inputs-preview')).not.toBeNull();
            expect(screen.findByType(AgentInput).props.value).not.toBe('Source A input');
            expect(runStartSpy).not.toHaveBeenCalled();
            await screen.unmount();
        });

        it('does not let a source-A save publish its revision into source B', async () => {
            const slowCreate = createDeferred<WorkflowDefinitionGetResultV1>();
            definitionActions.create.mockImplementationOnce(() => slowCreate.promise);
            definitionActions.get.mockResolvedValue({
                definitionId: 'definition-b',
                access: 'owner',
                revision: { headerVersion: 9, bodyVersion: 9 },
                metadata: { title: 'Definition B' },
                definition: {
                    version: 1,
                    inputs: [],
                    defaults: {},
                    blocks: [{
                        kind: 'step', id: 'review',
                        document: { text: 'Review', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    }],
                },
            });
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            const draft = latestBodyProps?.draft;
            if (draft === undefined) throw new Error('Expected the new Workflow draft');
            await act(async () => latestBodyProps?.onChange({
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
            await act(async () => latestBodyProps?.onSave?.());

            await screen.update(
                <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: 'definition-b' }} />,
            );
            await act(async () => {});
            expect(latestBodyProps?.draft).toMatchObject({ name: 'Definition B' });

            slowCreate.resolve({
                definitionId: 'source-a-definition',
                access: 'owner',
                revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Source A' },
                definition: createWorkflowDefinitionFixture(),
            });
            await act(async () => {});

            // Source B is showing its own hydrated revision, not the one source
            // A's save just created.
            // (A leaked save would have stamped B as "saved just now".)
            expect(latestBodyProps?.saveStatus).toEqual({ kind: 'saved', savedAtMs: null });
            await screen.unmount();
        });

        it('saves the definition first, then the trigger delta, and keeps the edits when the trigger write fails', async () => {
            const order: string[] = [];
            definitionActions.create.mockImplementationOnce(async (request) => {
                order.push('definition');
                return { definitionId: SAVED_TRIGGER_WORKFLOW_ID, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 },
                    definition: WorkflowDefinitionV1Schema.parse(request.definition), metadata: request.metadata };
            });
            triggerActions.add.mockImplementationOnce(async () => {
                order.push('trigger');
                throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
            });
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            const draft = latestBodyProps?.draft;
            if (draft === undefined) throw new Error('Expected the new Workflow draft');
            await act(async () => latestBodyProps?.onChange({
                ...draft,
                name: 'Nightly release',
                defaults: { ...draft.defaults, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                blocks: [{ kind: 'step', id: 'analyze', document: { text: 'Prepare the release', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
            } as never));
            // The first trigger's set runs on the editor's Where.
            await act(async () => latestBodyProps?.onChangeProjectTarget?.({ machineId: 'machine-1', directory: '/repo' } as never));
            // Adding a trigger edits the draft only: nothing is written yet.
            const section = latestBodyProps?.triggersSection as React.ReactElement<{ draft: unknown; onChangeDraft: (next: unknown) => void }>;
            const trigger = { kind: 'schedule', enabled: true, schedule: { kind: 'cron', scheduleExpr: '0 2 * * *', everyMs: null, timezone: 'UTC' } };
            await act(async () => section.props.onChangeDraft({ adds: [{ clientId: 'c1', trigger }], updates: {}, removes: [] }));
            expect(triggerActions.add).not.toHaveBeenCalled();
            expect(latestBodyProps?.triggersSummary).toBe('workflows.triggers.summary.everyDayAt(time=02:00)');

            await act(async () => latestBodyProps?.onSave?.());
            await act(async () => {});

            expect(order).toEqual(['definition', 'trigger']);
            expect(triggerActions.add).toHaveBeenCalledWith(expect.objectContaining({ workflow: SAVED_TRIGGER_WORKFLOW_ID, project: { machineId: 'machine-1', directory: '/repo' }, trigger }));
            // "Workflow saved · Triggers not updated", with the pending trigger still in the draft.
            expect(latestBodyProps?.saveStatus).toEqual({ kind: 'failed', reason: 'workflows.triggers.editor.partialSave' });
            expect((latestBodyProps?.triggersSection as React.ReactElement<{ draft: { adds: unknown[] } }>).props.draft.adds).toHaveLength(1);
            await screen.unmount();
        });

        it('Save as workflow: the first Save writes the definition, then points the trigger at it, with the partial state when that fails', async () => {
            const { storeTriggerWorkflowSeed } = await import('../triggers/triggerWorkflowSeed');
            definitionActions.create.mockImplementation(async (request) => ({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
                access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, definition: WorkflowDefinitionV1Schema.parse(request.definition), metadata: request.metadata }));
            triggerActions.update.mockRejectedValueOnce(Object.assign(new Error('currentness_conflict'), { code: 'currentness_conflict' }));
            const definition = {
                version: 1, inputs: [],
                defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                blocks: [{ kind: 'step', id: 'digest', document: { text: 'Morning digest', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
            };
            const seedId = storeTriggerWorkflowSeed({
                definition: definition as never,
                retarget: { scope: 'account', automationId: TRIGGER_SET_ID, triggerId: 'trigger-1', expectedRevision: 3 },
            });
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', triggerWorkflowSeedId: seedId }} />);
            // The trigger's own steps open as the draft; nothing is written yet.
            expect(latestBodyProps?.draft.blocks[0]).toMatchObject({ id: 'digest' });
            expect(triggerActions.update).not.toHaveBeenCalled();
            const draft = latestBodyProps?.draft;
            if (draft === undefined) throw new Error('Expected the seeded draft');
            await act(async () => latestBodyProps?.onChange({ ...draft, name: 'Morning digest' } as never));

            await act(async () => latestBodyProps?.onSave?.());
            await act(async () => {});
            const retarget = {
                automationId: TRIGGER_SET_ID, triggerId: 'trigger-1', expectedRevision: 3,
                patch: { target: { kind: 'workflow', ref: SAVED_TRIGGER_WORKFLOW_ID } },
            };
            expect(triggerActions.update).toHaveBeenCalledWith(retarget);
            // "Workflow saved · Trigger not updated": the trigger keeps its own steps until it lands.
            expect(latestBodyProps?.saveStatus).toEqual({ kind: 'failed', reason: 'workflows.triggers.editor.retargetFailed' });

            // Try again: Save retries the retarget, which now lands.
            definitionActions.update.mockImplementationOnce(async (request) => ({ definitionId: SAVED_TRIGGER_WORKFLOW_ID,
                access: 'owner', revision: { headerVersion: 1, bodyVersion: 2 }, definition: WorkflowDefinitionV1Schema.parse(request.definition), metadata: request.metadata }));
            triggerActions.update.mockResolvedValueOnce({ set: { automationId: TRIGGER_SET_ID,
                revision: 4, enabled: true, health: 'available', triggers: [],
                target: { kind: 'workflow', ref: SAVED_TRIGGER_WORKFLOW_ID } } });
            await act(async () => latestBodyProps?.onSave?.());
            await act(async () => {});
            expect(triggerActions.update).toHaveBeenCalledTimes(2);
            expect(latestBodyProps?.saveStatus?.kind).not.toBe('failed');
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
            const admission = createDeferred<WorkflowRunStartResultV1>();
            runStartSpy.mockImplementationOnce(() => admission.promise);
            const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
            const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
            const draft = latestBodyProps?.draft;
            if (draft === undefined) throw new Error('Expected the new Workflow draft');
            await act(async () => latestBodyProps?.onChange({
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
                latestBodyProps?.onChangeProjectTarget,
                'Expected a project-target change handler',
            )({
                machineId: 'machine-1',
                directory: '/Users/me/project',
            }));
            await act(async () => requireDefined(latestBodyProps?.onRunNow, 'Expected a Run now handler')());
            expect(runStartSpy).not.toHaveBeenCalled();
            await screen.pressByTestIdAsync('workflow-run-inputs-run');
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

        expect(screen.findAllByType(KeyboardAwareScrollView as never)).toHaveLength(0);
        expect(screen.findByTestId('workflow-editor-body')).not.toBeNull();
    });

    it('keeps the editor mounted while the composer collects Run inputs', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const initialDraft = latestBodyProps?.draft;
        expect(initialDraft).toBeDefined();
        if (initialDraft === undefined) throw new Error('Expected the new Workflow draft');

        await act(async () => latestBodyProps?.onChange({
            ...initialDraft,
            inputs: [{ name: 'topic', valueType: 'string', required: true }],
        }));
        await act(async () => requireDefined(latestBodyProps?.onRunNow, 'Expected a Run now handler')());

        expect(screen.findByTestId('workflow-editor-body')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-inputs-main')).not.toBeNull();
        expect(runStartSpy).not.toHaveBeenCalled();
        await act(async () => invokeTestInstanceHandler(screen.findByType(AgentInput), 'onChangeText', 'Unsubmitted topic'));
        await dismissRunComposer(screen);
        expect(screen.findByTestId('workflow-run-inputs-main')).toBeNull();
        expect(screen.findByTestId('workflow-editor-body')).not.toBeNull();
        expect(latestBodyProps?.draft.draftId).toBe(initialDraft.draftId);
        await act(async () => latestBodyProps?.onRunNow?.());
        expect(screen.findByType(AgentInput).props.value).toBe('Unsubmitted topic');
        expect(runStartSpy).not.toHaveBeenCalled();
    });

    it('owns Run as at page scope and carries the selected target into admission', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        expect(latestBodyProps?.executionTarget).toBe('session');
        expect(latestBodyProps?.runAsTargets).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'session', available: true }),
            expect.objectContaining({ kind: 'detached_run', available: false }),
        ]));

        const draft = latestBodyProps?.draft;
        if (draft === undefined) throw new Error('Expected the new Workflow draft');
        await act(async () => latestBodyProps?.onChange({
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
            latestBodyProps?.onChangeProjectTarget,
            'Expected a project-target change handler',
        )({
            machineId: 'machine-1',
            directory: '/Users/me/project',
        }));
        await act(async () => requireDefined(
            latestBodyProps?.onChangeExecutionTarget,
            'Expected an execution-target change handler',
        )('session'));
        await act(async () => requireDefined(latestBodyProps?.onRunNow, 'Expected a Run now handler')());

        expect(runStartSpy).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
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
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderRunEditor(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        const draft = latestBodyProps?.draft;
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
        await act(async () => latestBodyProps?.onChange({ ...authored, name: '   ' }));
        await act(async () => requireDefined(
            latestBodyProps?.onChangeProjectTarget,
            'Expected a project-target change handler',
        )({
            machineId: 'machine-1',
            directory: '/Users/me/project',
        }));
        await act(async () => requireDefined(latestBodyProps?.onRunNow, 'Expected a Run now handler')());
        expect(runStartSpy).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(runStartSpy).toHaveBeenCalledTimes(1);
        expect(runStartSpy.mock.calls[0]?.[0]).not.toHaveProperty('metadata');

        await act(async () => latestBodyProps?.onChange({ ...authored, name: '  Review  ' }));
        await act(async () => requireDefined(latestBodyProps?.onRunNow, 'Expected a Run now handler')());
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(runStartSpy).toHaveBeenCalledTimes(2);
        expect(runStartSpy.mock.calls[1]?.[0]).toMatchObject({ metadata: { title: 'Review' } });
    });

    /**
     * A read that failed is not proof the workflow was deleted, and a blank page
     * is not an explanation. The neutral host states what happened and offers
     * the read again.
     */
    it('states a failed hydration with a retry rather than a blank page', async () => {
        definitionActions.get
            .mockRejectedValueOnce(new Error('transport failed'))
            .mockResolvedValueOnce({
                definitionId: 'saved-definition',
                access: 'owner',
                revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Recovered workflow' },
                definition: {
                    version: 1,
                    inputs: [],
                    defaults: {},
                    blocks: [{
                        kind: 'step', id: 'review',
                        document: { text: 'Review', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    }],
                },
            });
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(
            <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: 'saved-definition' }} />,
        );
        await act(async () => {});

        expect(screen.findByTestId('workflow-editor-error')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-body')).toBeNull();

        await screen.pressByTestIdAsync('workflow-editor-error-action');
        await act(async () => {});

        expect(definitionActions.get).toHaveBeenCalledTimes(2);
        expect(latestBodyProps?.draft).toMatchObject({ name: 'Recovered workflow' });
    });

    it('offers Share for a saved workflow, opening the one document share sheet with its Artifact', async () => {
        definitionActions.get.mockResolvedValueOnce({
            definitionId: 'shared-definition-id',
            access: 'owner',
            revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title: 'Nightly review' },
            definition: {
                version: 1, inputs: [], defaults: {},
                blocks: [{ kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
            },
        } satisfies WorkflowDefinitionGetResultV1);
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: 'shared-definition-id' }} />);
        await act(async () => {});

        const ids = (latestBodyProps?.menuActions ?? []).map((action) => action.id);
        expect(ids.indexOf('share')).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf('share')).toBeLessThan(ids.indexOf('export'));

        modalShowSpy.mockClear();
        await act(async () => { latestBodyProps?.menuActions?.find((action) => action.id === 'share')?.onSelect(); });
        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        expect(modalShowSpy.mock.calls[0]?.[0]).toMatchObject({
            props: { kind: 'workflow-definition.v1', artifactId: 'shared-definition-id', linkPath: '/workflows/shared-definition-id' },
            chrome: { testID: 'document-share-modal' },
        });
        // "Send a copy instead" is the editor's existing JSON export.
        expect(typeof modalShowSpy.mock.calls[0]?.[0]?.props?.onSendCopy).toBe('function');
    });

    it('offers no Share for a draft that has never been saved', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />);
        await act(async () => {});
        expect((latestBodyProps?.menuActions ?? []).some((action) => action.id === 'share')).toBe(false);
    });

    it('retires a saved private draft immediately and refetches it on Account switch', async () => {
        const accountB = createDeferred<WorkflowDefinitionGetResultV1>();
        const definition = (text: string): WorkflowDefinitionGetResultV1 => ({
            definitionId: 'same-definition-id',
            access: 'owner',
            revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title: text },
            definition: {
                version: 1,
                inputs: [],
                defaults: {},
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
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: 'same-definition-id' }} />);
        await act(async () => {});
        expect(latestBodyProps?.draft).toMatchObject({ name: 'Account A private prompt' });

        await act(async () => {
            switchEditorAccountScope({ serverId: 'server-a', accountId: 'account-b' });
        });
        expect(screen.findByTestId('workflow-editor-loading')).toBeTruthy();
        expect(screen.findByTestId('workflow-editor-body')).toBeNull();
        expect(definitionActions.get).toHaveBeenCalledTimes(2);

        accountB.resolve(definition('Account B private prompt'));
        await act(async () => {});
        expect(latestBodyProps?.draft).toMatchObject({ name: 'Account B private prompt' });
    });
});

/** Dismisses the Run now composer the way a person does: through its presenter (outside press, Escape). */
async function dismissRunComposer(screen: Readonly<{ findAll: (predicate: (node: import('react-test-renderer').ReactTestInstance) => boolean) => import('react-test-renderer').ReactTestInstance[] }>) {
    const presenter = screen.findAll((node) => typeof node.props.onRequestClose === 'function'
        && node.findAll((child) => child.props.testID === 'workflow-run-inputs').length > 0).at(-1);
    await act(async () => { invokeTestInstanceHandler(presenter, 'onRequestClose', undefined, 'Run composer presenter'); });
}

import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { authoringMemoryDefaults } from '@/sync/store/domains/authoringMemory';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { WorkflowEditorHostScreen } from './WorkflowEditorHostScreen';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { WorkflowRunComposer } from '../run/WorkflowRunComposer';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import type { SelectionListStep } from '@/components/ui/selectionList';
import type { IModal } from '@/modal';
import type { WorkflowDefinitionGetResultV1 } from '@happier-dev/protocol';
import type { WorkflowRunNowRequest } from '../run/useWorkflowRunNowController';

/**
 * The saved-row entry intents, consumed at the one editor owner.
 *
 * Edit, Run now and Schedule arrive through the same route because only this
 * page has the reviewed Machine, the page-level Run as choice and the declared
 * inputs. Run opens the reviewed composer; Schedule opens this page's settings.
 * Both use the real page command gate on the hydrated revision; Edit opens neither.
 */

const modalShowSpy = vi.hoisted(() => vi.fn<IModal['show']>(() => 'workflow-run-input-modal'));
const modalHideSpy = vi.hoisted(() => vi.fn<IModal['hide']>());
const modalUpdateSpy = vi.hoisted(() => vi.fn<IModal['update']>());
let restoreWebGlobals: (() => void) | undefined;

const definitionActions = vi.hoisted(() => ({ get: vi.fn() }));
const routerMock = vi.hoisted(() => ({ value: null as { spies: { push: ReturnType<typeof vi.fn> } } | null }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }) });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock();
    routerMock.value = mock as never;
    return mock.module;
});
vi.mock('expo-crypto', () => ({ randomUUID: () => 'draft-or-run-id' }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { show: modalShowSpy, hide: modalHideSpy, update: modalUpdateSpy },
    }).module;
});
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    return {
        // Preserve the existing Account fixture while exercising real store reads.
        ...actual,
        useActiveServerAccountScope: () => ({ serverId: 'server-a', accountId: 'account-a' }),
    };
});
vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>()),
    captureActiveServerAccountScopeLifetime: () => ({
        scope: { serverId: 'server-a', accountId: 'account-a' },
        isCurrent: () => true,
        onRetire: () => ({ dispose() {} }),
    }),
}));
vi.mock('@/sync/domains/workflows/workflowDefinitionActions', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/workflows/workflowDefinitionActions')>(),
    createWorkflowDefinition: vi.fn(),
    getWorkflowDefinition: definitionActions.get,
    isWorkflowDefinitionConflictError: () => false,
    updateWorkflowDefinition: vi.fn(),
}));
vi.mock('@/sync/domains/workflows/workflowDocumentFile', () => ({
    pickWorkflowDocumentText: vi.fn(),
    saveWorkflowDocument: vi.fn(),
    workflowDocumentFileName: () => 'workflow.json',
}));
vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: vi.fn(),
}));
// The detached-runtime capability probe is a real network/daemon boundary.
vi.mock('@/sync/ops/actions/executionRunDetachedSupport', () => ({
    detectDetachedExecutionRunSupport: async () => 'machine_does_not_support_detached_runs',
}));
const runNowSpy = vi.hoisted(() => vi.fn<(request: WorkflowRunNowRequest) => Promise<null>>(async () => null));
vi.mock('../run/useWorkflowRunNowController', () => ({
    useWorkflowRunNowController: () => ({ runNow: runNowSpy, stateFor: () => 'idle' }),
}));
// Native rich input is a rendering boundary; the page's commands and settings
// remain real so a Schedule entry cannot be mistaken for Automation navigation.
vi.mock('@/components/sessions/agentInput', async () => {
    const { createAgentInputModuleMock } = await import('@/dev/testkit');
    return createAgentInputModuleMock({});
});
// React Test Renderer has no DOM anchor or portal; render the real popover's
// content inline rather than replacing its Workflow command/composer owners.
vi.mock('@/components/ui/popover/Popover', () => ({
    Popover: (props: { open: boolean; children: (size: { maxHeight: number; maxWidth: number }) => React.ReactNode }) =>
        props.open ? React.createElement(React.Fragment, null, props.children({ maxHeight: 800, maxWidth: 520 })) : null,
}));

/** A saved revision the canonical validator accepts, with one declared input. */
function savedDefinition(): WorkflowDefinitionGetResultV1 {
    return {
        definitionId: 'definition-exact',
        access: 'owner',
        revision: { headerVersion: 1, bodyVersion: 2 },
        metadata: { title: 'Release check' },
        definition: {
            version: 1,
            inputs: [{ name: 'topic', valueType: 'string', required: true }],
            defaults: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            },
            blocks: [{
                kind: 'step',
                id: 'review',
                document: { text: 'Review the release', references: [], attachments: [] },
                input: [],
                result: { kind: 'text' },
            }],
        },
    };
}

function pushSpy(): ReturnType<typeof vi.fn> {
    const spy = routerMock.value?.spies.push;
    if (!spy) throw new Error('Expected the router mock to expose its push spy');
    return spy;
}

function EditorPaneWrapper({ children }: React.PropsWithChildren) {
    return <AppPaneProvider>{children}</AppPaneProvider>;
}

beforeEach(() => {
    restoreWebGlobals = withPopoverWebGlobals();
    storage.setState({ settings: settingsDefaults,
        authoringMemory: { ...authoringMemoryDefaults, recentMachinePaths: [{ machineId: 'machine-1', path: '/repo/project' }] },
        machines: { 'machine-1': createMachineFixture({ id: 'machine-1' }) }, machineListByServerId: {} });
    runNowSpy.mockClear();
    modalShowSpy.mockClear();
    modalHideSpy.mockClear();
    modalUpdateSpy.mockClear();
    definitionActions.get.mockReset();
    definitionActions.get.mockResolvedValue(savedDefinition());
    routerMock.value?.spies.push.mockClear();
});

afterEach(async () => {
    await standardCleanup();
    restoreWebGlobals?.();
});

describe('WorkflowEditorHostScreen saved-entry intents', () => {
    it('inserts an example into the current draft as one undoable change without saving or running', async () => {
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />, { wrapper: EditorPaneWrapper });
        await screen.pressByTestIdAsync('workflow-editor-add-root');
        const menu = screen.findAllByType(AgentInputSelectionListPopover)
            .find((candidate) => candidate.props.testID === 'workflow-editor-add-root-menu')!;
        const step = menu.props.rootStep as SelectionListStep;
        const option = step.sections.flatMap((section) => section.kind === 'static' ? section.options : [])
            .find((entry) => entry.id === 'workflow-editor-add-root-example');
        expect(option).toBeDefined();
        await act(async () => { option?.onSelect?.(); });
        await screen.pressByTestIdAsync('workflow-examples:morning-digest:use');
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('workflows.examples.morningDigest.title');
        expect(screen.findByTestId('workflow-editor-step-digest')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-undo');
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('');
        expect(screen.findByTestId('workflow-editor-step-digest')).toBeNull();
        expect(runNowSpy).not.toHaveBeenCalled();
        const { createWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        expect(createWorkflowDefinition).not.toHaveBeenCalled();
    });
    it('opens a catalog example as an unsaved draft and keeps edits across rerenders', async () => {
        const { WORKFLOW_STARTER_EXAMPLES_V1 } = await import('@happier-dev/protocol');
        const { createWorkflowDefinition, updateWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        const example = WORKFLOW_STARTER_EXAMPLES_V1.find((entry) => entry.key === 'morning-digest')!;
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', exampleKey: example.key }} />,
            { wrapper: EditorPaneWrapper });
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe(example.titleKey);
        expect(createWorkflowDefinition).not.toHaveBeenCalled();
        expect(updateWorkflowDefinition).not.toHaveBeenCalled();
        expect(runNowSpy).not.toHaveBeenCalled();
        await act(async () => { screen.changeTextByTestId('workflow-editor-name', 'My morning digest'); });
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'new', exampleKey: example.key }} />);
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('My morning digest');
    });
    it('opens the definition and triggers nothing when the entry was Edit', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: 'definition-exact' }} />, { wrapper: EditorPaneWrapper });
        await act(async () => {});

        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('Release check');
        expect(modalShowSpy).not.toHaveBeenCalled();
        expect(pushSpy()).not.toHaveBeenCalled();
        expect(runNowSpy).not.toHaveBeenCalled();
    });

    it('collects declared inputs through the Run-now owner for a Run intent', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(
            <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: 'definition-exact', intent: 'run' }} />,
            { wrapper: EditorPaneWrapper },
        );
        await act(async () => {});

        // The reviewed revision is what the person sees and runs; the intent does
        // not replace the hydrated draft with a fresh one.
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('Release check');
        const composers = screen.findAllByType(WorkflowRunComposer);
        expect(composers).toHaveLength(1);
        expect(composers[0]?.props.inputs).toMatchObject([{ name: 'topic', required: true }]);
        // A required declared input is blocking, so nothing is admitted yet and
        // no Automation is written.
        expect(runNowSpy).not.toHaveBeenCalled();
        expect(pushSpy()).not.toHaveBeenCalled();
    });

    it('opens the page settings for a Schedule intent without creating an Automation', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const source = { kind: 'saved', definitionId: 'definition-exact', intent: 'schedule' } as const;
        const screen = await renderScreen(<WorkflowEditorHostScreen source={source} />, { wrapper: EditorPaneWrapper });
        await act(async () => {});

        expect(pushSpy()).not.toHaveBeenCalled();
        expect(modalShowSpy.mock.calls.some(([config]) => config.chrome?.testID === 'workflow-editor-settings-modal')).toBe(true);
        expect(runNowSpy).not.toHaveBeenCalled();

        // A rerender of the same logical source is not a second Schedule.
        await screen.update(<WorkflowEditorHostScreen source={{ ...source }} />);
        await act(async () => {});
        expect(pushSpy()).not.toHaveBeenCalled();
    });

    it('consumes a new saved-row intent when the same mounted route changes definition', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(
            <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: 'definition-a', intent: 'schedule' }} />,
            { wrapper: EditorPaneWrapper },
        );
        await act(async () => {});
        expect(modalShowSpy.mock.calls.some(([config]) => config.chrome?.testID === 'workflow-editor-settings-modal')).toBe(true);
        await act(async () => modalShowSpy.mock.calls.at(-1)?.[0].onRequestClose?.());
        modalShowSpy.mockClear();

        definitionActions.get.mockResolvedValueOnce({
            ...savedDefinition(),
            definitionId: 'definition-b',
            metadata: { title: 'Second release check' },
        });
        await screen.update(
            <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: 'definition-b', intent: 'schedule' }} />,
        );
        await act(async () => {});

        // A route rerender is not another press, but a different definition is
        // a distinct row action and must reach the Schedule owner once.
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('Second release check');
        expect(modalShowSpy.mock.calls.some(([config]) => config.chrome?.testID === 'workflow-editor-settings-modal')).toBe(true);
        expect(pushSpy()).not.toHaveBeenCalled();
    });
});

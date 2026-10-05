import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    applyComposerPresentationTransaction,
    readComposerPresentationSnapshot,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { sessionEnvelopeTransportMock } from '@/dev/testkit/mocks/sessionEnvelopeTransport';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import type { IModal } from '@/modal';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { useWorkflowEditorHistory } from '../editor/useWorkflowEditorHistory';

vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', async () => (await import('@/dev/testkit/mocks/sessionEnvelopeTransport')).sessionEnvelopeTransportMock);
vi.mock('@/sync/api/teams/membershipSessionDataKeyEnvelopesApi', async () => (await import('@/dev/testkit/mocks/sessionEnvelopeTransport')).sessionEnvelopeTransportMock);

// Hoisted: the accessibility mock factory below runs during static-import collection.
const announceSpy = vi.hoisted(() => vi.fn());
// Hoisted with the mock factories that capture them: the `@/modal` factory runs
// during static-import collection, before this module body initializes locals.
const modalShowSpy = vi.hoisted(() => vi.fn<IModal['show']>(() => 'workflow-inspector-modal'));
const modalUpdateSpy = vi.hoisted(() => vi.fn<IModal['update']>());
/**
 * Each mounted step composer takes one generated instance id. Counting the ids
 * issued is how a remount is detected: a preserved caret, selection or IME
 * composition is only possible while the same instance stays mounted.
 */
const composerInstanceIds = vi.hoisted(() => ({ issued: [] as string[], next: 0 }));
/** The latest props each step composer was rendered with, addressed by block. */
const composerProps = vi.hoisted(() => ({ byBlockId: new Map<string, Record<string, unknown>>() }));
const promptFocus = vi.fn();
const bindingBoundaries: Array<() => void> = [];
let registeredHandlers: Record<string, () => void> = {};
let windowDimensions = { width: 1200, height: 800 };
/**
 * The pane host is its own owner (placement is `resolvePaneLayout`'s, tested at
 * `paneBreakpoints`/`AppPaneScopeHost`). Here it is the boundary: what the
 * editor hands its slots is what these cases assert.
 */
const paneState = vi.hoisted(() => ({
    detailsAvailable: true,
    rightOpen: false,
    lastHostProps: null as null | Record<string, unknown>,
    openRight: vi.fn(),
    closeRight: vi.fn(),
}));

const MACHINE_COMPOSER_SCOPE = {
    kind: 'machine' as const,
    machineId: 'machine-1',
    serverId: 'server-a',
    directory: '/Users/me/project',
    machineHomeDir: '/Users/me',
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => windowDimensions,
    });
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));
vi.mock('@/components/ui/popover/Popover', () => ({
    Popover: (props: { open: boolean; children: (render: unknown) => React.ReactNode }) =>
        (props.open ? React.createElement(React.Fragment, null, props.children({})) : null),
}));
vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({
    SegmentedTabBar: (props: {
        tabs: ReadonlyArray<{ id: string; label: string }>;
        activeTabId: string;
        onSelectTab: (id: string) => void;
        testIDPrefix?: string;
    }) => React.createElement(
        'SegmentedTabBar',
        { testID: props.testIDPrefix },
        props.tabs.map((tab) => React.createElement('Pressable', {
            key: tab.id,
            testID: `${props.testIDPrefix}:${tab.id}`,
            accessibilityState: { selected: props.activeTabId === tab.id },
            onPress: () => props.onSelectTab(tab.id),
        })),
    ),
}));
// The canonical Session picker is a real list/virtualization boundary; the
// step it is handed and its selection callback are the behaviour under test.
vi.mock('@/components/ui/selectionList', async (importOriginal) => {
    const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
    return {
        ...(await importOriginal<Record<string, unknown>>()),
        ...createPassThroughModule(['SelectionList', 'SelectionListFilterChip']),
    };
});
// The New Session surface is its own owner; the Agent tab only hosts it.
vi.mock('@/components/sessions/new/NewSessionScreen', () => ({
    NewSessionScreen: () => React.createElement('NewSessionScreen'),
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: Record<string, unknown> & {
        main: React.ReactNode;
        scopeId: string;
        rightPaneBuiltinAdapter?: { render: (context: { scopeId: string; destinationId: string }) => React.ReactNode; defaultDestinationId?: string };
        destinationDetails?: { pane: React.ReactNode } | null;
    }) => {
        paneState.lastHostProps = props;
        return React.createElement(
            React.Fragment,
            null,
            props.main,
            paneState.rightOpen && props.rightPaneBuiltinAdapter
                ? props.rightPaneBuiltinAdapter.render({
                    scopeId: props.scopeId,
                    destinationId: props.rightPaneBuiltinAdapter.defaultDestinationId ?? '',
                })
                : null,
            props.destinationDetails?.pane ?? null,
        );
    },
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: { right: { isOpen: paneState.rightOpen } },
        openRight: paneState.openRight,
        closeRight: paneState.closeRight,
    }),
}));
vi.mock('@/components/appShell/panes/details/detailsPaneAvailability', () => ({
    useDetailsPaneAvailable: () => paneState.detailsAvailable,
}));
// The Session renderer is the composition boundary here: the real SessionInPane
// decides whether to mount it; its transcript/composer behavior has its own suites.
vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: Record<string, unknown>) => React.createElement('SessionView', props),
}));
vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: (props: Record<string, unknown>) => React.createElement('MachineSelector', props),
}));
// The project control's checkout picker reads the repository through the SCM
// RPC boundary and refreshes on screen focus; neither is under test here.
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
vi.mock('@/scm/scmRepositoryService', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    scmRepositoryService: {
        readCachedSnapshotForMachinePath: () => null,
        readCachedWorktreesEnrichment: () => null,
        fetchSnapshotForMachinePath: async () => null,
        fetchWorktreesEnrichment: async () => null,
    },
}));
// The composer host is the boundary; the scoped authoring composer, its document
// owner and its scope projection all stay real beneath it.
vi.mock('@/components/sessions/agentInput', async () => {
    const { createAgentInputModuleMock } = await import('@/dev/testkit/mocks/agentInput');
    return createAgentInputModuleMock({
        renderExtraActionChips: true,
        onFocusRequest: () => promptFocus(),
        onRender: (props) => {
            const ref = props.composerRef as Readonly<{ blockId?: string }> | undefined;
            if (ref?.blockId !== undefined) composerProps.byBlockId.set(ref.blockId, props);
        },
    });
});
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({ phase: 'idle', inputs: null }),
}));
vi.mock('@/components/plugins/surfaces/PluginContextualResourceStoreProvider', () => ({
    PluginContextualResourceStoreProvider: (props: Readonly<{ children?: React.ReactNode }>) =>
        React.createElement(React.Fragment, null, props.children),
}));
// The canonical keyboard catalog is a host boundary; this captures what the
// page registers so the shortcut contract can be asserted without a key event.
vi.mock('@/keyboard', () => ({
    useKeyboardShortcutHandlers: (handlers: Record<string, () => void>) => {
        registeredHandlers = handlers;
        return true;
    },
}));
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: announceSpy,
}));
vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => {
        composerInstanceIds.next += 1;
        const id = `composer-${composerInstanceIds.next}`;
        composerInstanceIds.issued.push(id);
        return id;
    },
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: modalShowSpy,
            update: modalUpdateSpy,
        },
    }).module;
});

beforeEach(() => {
    announceSpy.mockClear();
    modalShowSpy.mockClear();
    modalUpdateSpy.mockClear();
    promptFocus.mockClear();
    registeredHandlers = {};
    windowDimensions = { width: 1200, height: 800 };
    paneState.detailsAvailable = true;
    paneState.rightOpen = false;
    paneState.lastHostProps = null;
    paneState.openRight.mockClear();
    paneState.closeRight.mockClear();
    composerInstanceIds.issued = [];
    composerInstanceIds.next = 0;
    composerProps.byBlockId.clear();
});

// Module transform is paid once, outside any single case's time budget.
beforeAll(async () => {
    await loadHarness();
}, 300_000);

afterEach(async () => {
    for (const request of Object.values(sessionEnvelopeTransportMock)) expect(request).not.toHaveBeenCalled();
    await standardCleanup();
    for (const dispose of bindingBoundaries.splice(0)) dispose();
});

async function bindingHome() {
    const boundary = await serveActionHomes({ homes: [{ key: 'workflow', serverUrl: 'https://workflow-binding.test', accountId: 'account-a' }], route: () => undefined });
    bindingBoundaries.push(() => boundary.dispose());
    return { serverId: boundary.homes.workflow!.id, accountId: 'account-a' };
}

const AGENT_TARGET = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };

async function loadHarness() {
    const body = await import('./WorkflowEditorBody');
    const draftModule = await import('@/sync/domains/workflows/workflowEditorDraft');
    const edits = await import('@happier-dev/protocol/workflows/workflowDefinitionEditV1');
    const authoring = await import('@/sync/domains/workflows/workflowAuthoring');
    return { ...body, ...draftModule, ...edits, ...authoring };
}

type Harness = Awaited<ReturnType<typeof loadHarness>>;

function buildDraft(harness: Harness, overrides: Partial<{ name: string; text: string }> = {}) {
    const base = harness.setWorkflowDefaultField(
        harness.createWorkflowEditorDraft({
            draftId: 'draft-1',
            name: overrides.name ?? 'Review',
            blocks: [{
                kind: 'step',
                id: 'analyze',
                document: { text: overrides.text ?? 'Analyze the repository', references: [], attachments: [] },
                input: [],
                result: { kind: 'text' },
            }],
        }),
        'agentTarget',
        AGENT_TARGET,
    );
    return base;
}

/** The DropdownMenu element (not its host View) behind a field-select test id. */
function dropdownField(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    const match = screen.findAll((node) => node.props?.testID === testID && typeof node.props?.onSelect === 'function')[0];
    if (match === undefined) throw new Error(`No field select ${testID}`);
    return match as unknown as { props: { items: ReadonlyArray<Readonly<Record<string, unknown>>>; selectedId: string; onSelect: (id: string) => void } };
}

const OPEN_SETTINGS_GROUPS: ReadonlyMap<string, boolean> = new Map([
    ['where', true], ['agent', true], ['conversation', true], ['inputs', true],
]);

async function renderBody(
    harness: Harness,
    overrides: Record<string, unknown> = {},
    renderOptions?: Parameters<typeof renderScreen>[1],
) {
    const draft = (overrides.draft as ReturnType<typeof buildDraft>) ?? buildDraft(harness);
    const element = React.createElement(harness.WorkflowEditorBody, {
        draft,
        onChange: () => {},
        machineName: 'Mac Studio',
        composerScope: MACHINE_COMPOSER_SCOPE,
        selectedBlockId: null,
        onSelectBlock: () => {},
        onCustomizeBlock: () => {},
        view: 'steps',
        onChangeView: () => {},
        // Content cases read the settings rows; the quiet-by-default rule has its own case.
        inspectorGroupDisclosure: OPEN_SETTINGS_GROUPS,
        ...overrides,
    } as never);
    return renderScreen(element, renderOptions);
}

it('expands a called workflow in editor Flow while selection reveals the parent call, not the read-only child', async () => {
    const harness = await loadHarness();
    const { getBuiltinWorkflowCatalogV1 } = await import('@happier-dev/protocol/workflows');
    const child = getBuiltinWorkflowCatalogV1().find((entry) => entry.id === 'builtin:plan-with-a-panel')!;
    const childNodeId = JSON.stringify(['call', child.definition.blocks[0]!.id]);
    const onSelectBlock = vi.fn();
    const draft = harness.createWorkflowEditorDraft({ draftId: 'nested-flow', name: 'Nested', defaults: { agentTarget: AGENT_TARGET },
        blocks: [{ kind: 'workflow', id: 'call', workflowRef: child.id,
            input: { request: { kind: 'literal', value: 'Review the plan' } } }],
    });
    paneState.rightOpen = true;
    const screen = await renderBody(harness, { draft, view: 'flow', onSelectBlock, onRunNow: () => {} });
    expect(screen.findByTestId('workflow-editor-flow-node-call'), screen.getTextContent()).not.toBeNull();
    await vi.waitFor(() => expect(screen.findByTestId(`workflow-editor-flow-node-${childNodeId}`), screen.getTextContent()).not.toBeNull());
    await screen.pressByTestIdAsync(`workflow-editor-flow-node-${childNodeId}`);
    expect(onSelectBlock).toHaveBeenCalledWith('call');
});

it('keeps description metadata editable outside the portable draft and offers a return to its reviewed run', async () => {
    const harness = await loadHarness();
    const onChangeDescription = vi.fn();
    const onBackToRun = vi.fn();
    const screen = await renderBody(harness, {
        description: 'Accepted description', onChangeDescription,
        onBackToRun,
    });
    const description = screen.findByTestId('workflow-editor-description');
    expect(description?.props.value).toBe('Accepted description');
    await act(async () => description?.props.onChangeText('Edited description'));
    expect(onChangeDescription).toHaveBeenCalledWith('Edited description');
    await act(async () => screen.findByTestId('workflow-editor-back-to-run')?.props.onPress());
    expect(onBackToRun).toHaveBeenCalledOnce();
});

/**
 * The rendered document order of the named surfaces.
 *
 * Reading order is the contract these cases are about — a pinned command bar
 * before the document, and the first prompt before optional configuration — so
 * it is asserted from the painted tree rather than from props.
 */
function renderedOrder(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    testIDs: readonly string[],
): string[] {
    const seen: string[] = [];
    for (const node of screen.findAll((candidate) => (
        typeof candidate.type === 'string'
        && typeof candidate.props?.testID === 'string'
        && testIDs.includes(candidate.props.testID)
    ))) {
        const testID = node.props.testID as string;
        if (!seen.includes(testID)) seen.push(testID);
    }
    return seen;
}

function flattenTestStyle(style: unknown, state: Readonly<Record<string, boolean>> = { pressed: false }): Record<string, unknown> {
    // A Pressable style callback is resolved at rest unless a state is named.
    if (typeof style === 'function') return flattenTestStyle(style(state), state);
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenTestStyle(entry, state) }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function isInspectorModalConfig(value: unknown): value is Readonly<{
    chrome: Readonly<{ kind: string; bodyScroll: string }>;
    focusReturnRef: Readonly<{ current: Readonly<{ focus(): void }> }>;
    props: Readonly<{
        inspector: Readonly<{
            subject: Readonly<{ kind: string; blockId?: string }>;
            draft: WorkflowEditorDraft;
            onChange(next: WorkflowEditorDraft): void;
        }>;
    }>;
}> {
    if (typeof value !== 'object' || value === null) return false;
    if (!('chrome' in value) || !('focusReturnRef' in value) || !('props' in value)) return false;
    const chrome = value.chrome;
    const focusReturnRef = value.focusReturnRef;
    const props = value.props;
    return typeof chrome === 'object' && chrome !== null
        && typeof focusReturnRef === 'object' && focusReturnRef !== null
        && typeof props === 'object' && props !== null
        && 'inspector' in props && typeof props.inspector === 'object' && props.inspector !== null
        && 'subject' in props.inspector && 'draft' in props.inspector && 'onChange' in props.inspector
        && typeof props.inspector.onChange === 'function';
}

describe('workflow editor body', () => {
    it('keeps the authoring Session in the one Settings/Agent details pane and retires its hidden renderer', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, { authoringSessionId: 'author-session', authoringServerId: 'server-a', onSave: () => {} });
        expect(screen.findByTestId('workflow-editor-details-tabs:settings')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-details-tabs:settings');
        expect(screen.findByTestId('session-in-pane-inactive:author-session')).not.toBeNull();
    });
    it('offers Edit with an agent in the header and shows its seeded composer in the Agent tab (04 §4.7; DESIGN-1 B8)', async () => {
        const harness = await loadHarness();
        const onEditWithAgent = vi.fn();
        const header = await renderBody(harness, { onEditWithAgent, onSave: () => {} });
        // No agent conversation yet: the pane has no Agent tab and nothing opens as a modal.
        expect(header.findByTestId('workflow-editor-details-tabs:agent')).toBeNull();
        await header.pressByTestIdAsync('workflow-editor-edit-with-agent');
        expect(onEditWithAgent).toHaveBeenCalledTimes(1);
        expect(modalShowSpy).not.toHaveBeenCalled();
        await header.unmount();

        const seeded = await renderBody(harness, {
            onEditWithAgent,
            onSave: () => {},
            authoringDraft: { draftId: 'agent-draft-1', serverId: 'server-a', isCurrent: () => true, onSessionCreated: () => {} },
        });
        expect(seeded.findByTestId('workflow-editor-details-tabs:agent')).not.toBeNull();
        expect(seeded.findByTestId('workflow-editor-agent-draft')).not.toBeNull();
        // Pressing it again returns to that conversation instead of starting another.
        await seeded.pressByTestIdAsync('workflow-editor-details-tabs:settings');
        await seeded.pressByTestIdAsync('workflow-editor-edit-with-agent');
        expect(onEditWithAgent).toHaveBeenCalledTimes(1);
        expect(seeded.findByTestId('workflow-editor-agent-draft')).not.toBeNull();
    });
    it('can suppress only its title field when a wrapper owns the visible name', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, {
            showNameField: false,
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            projectMachines: [{ id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } }],
        });

        expect(screen.findByTestId('workflow-editor-name')).toBeNull();
        expect(screen.findByTestId('workflow-editor-machine-row')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-defaults')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-project-directory-readonly')).not.toBeNull();
        expect(screen.getTextContent()).toContain('~/project');
    });

    it('leads with identity and one primary Run now; Save is the status, rare operations are in ⋯', async () => {
        const harness = await loadHarness();
        const exported = vi.fn();
        const screen = await renderBody(harness, {
            onRunNow: () => {},
            onSave: () => {},
            onSchedule: () => {},
            onExportJson: () => {},
            saveStatus: { kind: 'unsaved' },
            menuActions: [{ id: 'export', title: 'workflows.exportJson', onSelect: exported }],
        });

        // The editable name is the page's identity, in the page.
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('Review');
        // One primary; Schedule is not a page action (triggers are the Triggers section).
        expect(screen.findByTestId('workflow-editor-run-now')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-schedule')).toBeNull();
        expect(screen.findByTestId('workflow-editor-export-json')).toBeNull();
        // Save lives inside the save status element, as its own receipt.
        const status = screen.findByTestId('workflow-editor-save-status');
        expect(status?.findAll((node) => node.props?.testID === 'workflow-editor-save').length).toBeGreaterThan(0);
        expect(screen.findByTestId('workflow-editor-menu')).not.toBeNull();
    });

    it('authors loop count and item sources as canonical value references', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const draft = harness.createWorkflowEditorDraft({
            draftId: 'loop-draft', name: 'Loop', defaults: { agentTarget: AGENT_TARGET },
            blocks: [{
                kind: 'loop', id: 'repeat', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
                body: [{ kind: 'step', id: 'inside', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
            }],
        });
        const screen = await renderBody(harness, { draft, onChange: changed });

        // The document reads the loop as a sentence; its options open beside it.
        expect(screen.getTextContent()).toContain('workflows.page.inspector.repeatTimes');
        await screen.pressByTestIdAsync('workflow-editor-loop-repeat-summary');
        const source = dropdownField(screen, 'workflow-editor-inspector-loop-repeat-count-input-0-kind');
        await act(async () => { source.props.onSelect('input'); });
        expect(changed.mock.calls[0]?.[0].blocks[0].repetition.count.kind).toBe('input');
    });

    it('authors named inputs in declaration order and keeps them separate from step prompts', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const screen = await renderBody(harness, { onChange: changed });

        await screen.pressByTestIdAsync('workflow-editor-inputs-add');
        const next = changed.mock.calls[0]?.[0];
        expect(next.inputs).toEqual([{
            name: 'input',
            valueType: 'string',
            required: false,
        }]);
        expect(next.blocks[0].document.text).toBe('Analyze the repository');
    });

    it('labels parallel branches by localized position without authoring a schema field', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const draft = harness.createWorkflowEditorDraft({
            draftId: 'parallel-draft', name: 'Review', defaults: { agentTarget: AGENT_TARGET },
            blocks: [{
                kind: 'parallel', id: 'parallel', failurePolicy: 'fail_stop',
                branches: [{
                    id: 'branch-a',
                    blocks: [{
                        kind: 'step', id: 'step-a',
                        document: { text: 'Review', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    }],
                }],
            }],
        });
        const screen = await renderBody(harness, { draft, onChange: changed });
        expect(screen.findByTestId('workflow-editor-parallel-parallel-branch-branch-a-label')).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.editor.branch 1');
        expect(changed).not.toHaveBeenCalled();
    });

    it('uses the shared Session authoring controls for workflow defaults and the step options', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, { selectedBlockId: 'analyze' });

        expect(screen.findByTestId('workflow-editor-defaults')).not.toBeNull();
        // Step options never render as a document column beside the steps.
        expect(screen.findByTestId('workflow-editor-inspector')).toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');
        // Wide: Step options is the anchored popover beside the step, not a modal.
        expect(modalShowSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('workflow-editor-inspector-options')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-inspector')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-inspector-done');
        expect(screen.findByTestId('workflow-editor-inspector-options')).toBeNull();
    });

    /**
     * The strict Workflow schema requires an effective Agent, so a host that
     * contributes its Agent catalog must produce a real picker here. Without
     * those facts the field stays explicitly unavailable rather than pretending
     * to offer a choice — both directions are the contract.
     */
    it('offers the host-contributed Agent targets and states unavailability without them', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const withoutFacts = await renderBody(harness);
        expect(withoutFacts.findByTestId('workflow-editor-defaults-agentTarget')?.props.accessibilityLabel).toContain('workflows.input.unavailable');
        await withoutFacts.unmount();

        const screen = await renderBody(harness, {
            onChange: changed,
            authoringFacts: {
                agentTargets: [
                    { id: 'agent:happier.agent.claude/claude', label: 'Claude Code', target: AGENT_TARGET, agentId: 'claude' },
                    {
                        id: 'agent:happier.agent.codex/codex',
                        label: 'Codex',
                        agentId: 'codex',
                        target: {
                            kind: 'agent' as const,
                            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                        },
                    },
                ],
            },
        });

        const chip = screen.findByTestId('workflow-editor-defaults-agentTarget');
        expect(chip).not.toBeNull();
        expect(chip?.props.accessibilityLabel).toContain('Claude Code');
    });

    it('opens the same controlled step options in the canonical modal on a phone', async () => {
        windowDimensions = { width: 390, height: 844 };
        paneState.detailsAvailable = false;
        const harness = await loadHarness();
        const changed = vi.fn();
        const screen = await renderBody(harness, { onChange: changed });

        expect(screen.findByTestId('workflow-editor-inspector')).toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');

        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        const config = modalShowSpy.mock.calls[0]?.[0];
        expect(isInspectorModalConfig(config)).toBe(true);
        if (!isInspectorModalConfig(config)) throw new Error('Expected the Workflow inspector modal configuration');
        expect(config.chrome).toMatchObject({ kind: 'card', bodyScroll: 'auto' });
        expect(config.focusReturnRef).toBeDefined();
        expect(config.props.inspector.subject).toEqual({ kind: 'block', blockId: 'analyze' });
        config.props.inspector.onChange({ ...config.props.inspector.draft, name: 'Changed through inspector' });
        expect(changed).toHaveBeenCalledTimes(1);
        config.focusReturnRef.current.focus();
        expect(promptFocus).toHaveBeenCalledTimes(1);
    });

    /**
     * Flow's Edit action must land on an editor that exists. A branch frame is
     * not a block, so selecting it and pressing Edit used to select an id no
     * editor owns and request focus on a prompt that was never registered — an
     * inert action. The owning group is the real editor for a branch.
     */
    it('reveals the owning group editor when Edit is pressed on a Flow branch frame', async () => {
        const harness = await loadHarness();
        const changeView = vi.fn();
        const draft = harness.setWorkflowDefaultField(harness.createWorkflowEditorDraft({
            draftId: 'parallel-draft', name: 'Review',
            blocks: [{
                kind: 'parallel', id: 'parallel', failurePolicy: 'fail_stop',
                branches: [{
                    id: 'branch-a',
                    blocks: [{
                        kind: 'step', id: 'step-a',
                        document: { text: 'Review', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    }],
                }],
            }],
        }), 'agentTarget', AGENT_TARGET);
        const selections: Array<string | null> = [];
        // Flow is the editor scope's right pane on a wide layout.
        paneState.rightOpen = true;
        function Host(): React.ReactElement {
            const [selectedBlockId, setSelectedBlockId] = React.useState<string | null>(null);
            return React.createElement(harness.WorkflowEditorBody, {
                draft,
                onChange: () => {},
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId,
                onSelectBlock: (blockId: string | null) => { selections.push(blockId); setSelectedBlockId(blockId); },
                onCustomizeBlock: () => {},
                view: 'flow',
                onChangeView: changeView,
                onRunNow: () => {},
            } as never);
        }
        const screen = await renderScreen(React.createElement(Host));

        await screen.pressByTestIdAsync('workflow-editor-flow-node-parallel#branch-a');
        // The selection is the real block the editor can show, never the frame id.
        expect(selections.at(-1)).toBe('parallel');
        expect(harness.findWorkflowBlock(draft, selections.at(-1) ?? '')?.kind).toBe('parallel');

        const edit = screen.findByTestId('workflow-editor-flow-edit-step');
        expect(edit?.props.accessibilityLabel).toBe('workflows.a11y.editBlock');
        await screen.pressByTestIdAsync('workflow-editor-flow-edit-step');
        expect(changeView).toHaveBeenCalledWith('steps');
        expect(selections.at(-1)).toBe('parallel');
        // A group has no prompt; nothing is asked to focus that cannot.
        expect(promptFocus).not.toHaveBeenCalled();
    });

    it('returns focus to the evaluator prompt when Edit is pressed on its Flow node', async () => {
        const harness = await loadHarness();
        const changeView = vi.fn();
        const draft = harness.setWorkflowDefaultField(harness.createWorkflowEditorDraft({
            draftId: 'loop-draft', name: 'Judge',
            blocks: [{
                kind: 'loop', id: 'judge',
                repetition: {
                    kind: 'evaluate', maxIterations: 3, history: 'latest',
                    evaluator: {
                        kind: 'step', id: 'judge-step',
                        document: { text: 'Decide', references: [], attachments: [] },
                        input: [], result: { kind: 'decision', decisions: ['continue', 'stop'] },
                    },
                },
                body: [{
                    kind: 'step', id: 'summarize',
                    document: { text: 'Summarize', references: [], attachments: [] },
                    input: [], result: { kind: 'text' },
                }],
            }],
        }), 'agentTarget', AGENT_TARGET);
        paneState.rightOpen = true;
        const screen = await renderBody(harness, {
            draft, view: 'flow', selectedBlockId: 'judge-step', onChangeView: changeView, onRunNow: () => {},
        });

        expect(screen.findByTestId('workflow-editor-flow-edit-step')?.props.accessibilityLabel)
            .toBe('workflows.a11y.editStep');
        await screen.pressByTestIdAsync('workflow-editor-flow-edit-step');
        expect(changeView).toHaveBeenCalledWith('steps');
        expect(promptFocus).toHaveBeenCalledTimes(1);
    });

    it('shows Machine and project as one field that opens the choices, which wrap without a phone-breaking minimum', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, {
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            projectMachines: [{ id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } }],
            onChangeProjectTarget: vi.fn(),
        });

        // One row and one value: the where-summary, home-relative, never a raw absolute path.
        expect(screen.getTextContent()).toContain('Mac Studio / ~/project');
        expect(screen.findByTestId('workflow-editor-project-directory')).toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-machine-row');
        expect(screen.findByTestId('workflow-editor-where-popover')).not.toBeNull();
        const folder = screen.findByTestId('workflow-editor-project-directory');
        expect(folder?.props.role ?? folder?.props.accessibilityRole).toBe('button');
        expect(flattenTestStyle(folder?.props.style)).toMatchObject({ minWidth: 0, flexShrink: 1 });
    });

    it('authors a typed step input reference without interpolating it into prompt text', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const screen = await renderBody(harness, { onChange: changed });

        await screen.pressByTestIdAsync('workflow-editor-step-analyze-add-input');
        const next = changed.mock.calls[0]?.[0];
        expect(next.blocks[0].input).toEqual([{ kind: 'literal', value: '' }]);
        expect(next.blocks[0].document.text).toBe('Analyze the repository');
    });

    it('authors a scoped producer workspace path for a downstream step', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const base = buildDraft(harness);
        const draft = {
            ...base,
            blocks: [...base.blocks, {
                kind: 'step' as const,
                id: 'implement',
                document: { text: 'Implement the analysis', references: [], attachments: [] },
                input: [{ kind: 'literal' as const, value: '' }],
                result: { kind: 'text' as const },
            }],
        };
        const screen = await renderBody(harness, { draft, onChange: changed });

        const source = dropdownField(screen, 'workflow-editor-step-implement-input-0-kind');
        await act(async () => { source.props.onSelect('workspace'); });
        expect(changed.mock.calls[0]?.[0].blocks[1].input).toEqual([{
            kind: 'workspace',
            producer: { blockId: 'analyze', scope: { kind: 'current' } },
            field: 'directory',
        }]);
    });

    it('offers Run now and Save as separate commands; Run now never saves', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const saved = vi.fn();
        const scheduled = vi.fn();
        const screen = await renderBody(harness, {
            onRunNow: ran,
            onSave: saved,
            onSchedule: scheduled,
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            saveStatus: { kind: 'unsaved' },
        });

        await screen.pressByTestIdAsync('workflow-editor-run-now');
        expect(ran).toHaveBeenCalledTimes(1);
        expect(saved).not.toHaveBeenCalled();
        expect(scheduled).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('workflow-editor-save');
        expect(saved).toHaveBeenCalledTimes(1);
        expect(ran).toHaveBeenCalledTimes(1);
    });

    it('composes one page scroll: identity, the header chips, then the document', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, {
            onRunNow: () => {},
            onSave: () => {},
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            projectMachines: [{ id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } }],
            onChangeProjectTarget: () => {},
        });

        const { KeyboardAwareScrollView } = await import('@/components/ui/keyboardAvoidance/KeyboardAwareScrollView');
        expect(screen.findAllByType(KeyboardAwareScrollView as never)).toHaveLength(1);
        expect(screen.findHostByTestId('workflow-editor-scroll')?.props.keyboardShouldPersistTaps).toBe('handled');
        expect(renderedOrder(screen, [
            'workflow-editor-header',
            'workflow-editor-chips',
            'workflow-editor-steps-presentation',
        ])).toEqual(['workflow-editor-header', 'workflow-editor-chips', 'workflow-editor-steps-presentation']);
        // Where and Agent & model are header chips over their one owners; the
        // Where chip says the one summary string.
        const where = screen.root.findAll((node) => node.props?.filter?.id === 'workflow-where')[0];
        expect(where?.props.filter.valueLabel).toBe('Mac Studio / ~/project');
        expect(screen.findByTestId('workflow-editor-header-engine')).not.toBeNull();
        // Settings are a pane, closed until asked for; the document carries no settings wall.
        expect(screen.findByTestId('workflow-editor-defaults')).toBeNull();
    });

    it('hands Flow to the editor scope right pane and Workflow settings to the details slot', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, {
            onRunNow: () => {},
            onSave: () => {},
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            projectMachines: [{ id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } }],
            onChangeProjectTarget: () => {},
        });
        const host = paneState.lastHostProps as Record<string, unknown> & {
            rightPaneBuiltinAdapter?: { destinationIds: readonly string[] };
        };
        expect(host.scopeId).toBe('workflow-editor');
        expect(host.rightPaneBuiltinAdapter?.destinationIds).toEqual(['workflow-flow']);
        // The document keeps the composer's floor in every pane arrangement — the
        // Session main column's minimum, not the narrower three-pane default.
        expect(host.mainMinWidthPx).toBe(420);
        // No plugin sidebar tab is faked and Settings never records a Details opener.
        expect(host.rightSidebarAdapter).toBeUndefined();
        expect(host.detailsPaneBuiltinAdapter).toBeUndefined();
        expect(host.destinationDetails).toBeNull();

        await screen.pressByTestIdAsync('workflow-editor-flow-toggle');
        expect(paneState.openRight).toHaveBeenCalledTimes(1);

        await screen.pressByTestIdAsync('workflow-editor-settings-toggle');
        expect((paneState.lastHostProps as { destinationDetails?: unknown }).destinationDetails).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-settings-pane')).not.toBeNull();
        const order = [
            'workflow-editor-machine-row',
            'workflow-editor-defaults',
            'workflow-editor-defaults-continuity-row',
            'workflow-editor-inputs-row',
            'workflow-editor-final-output-row',
        ];
        expect(renderedOrder(screen, order)).toEqual(order);
    });

    it('keeps an untouched draft silent and reveals one validity readout after a refused Run', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const onSelectBlock = vi.fn();
        const screen = await renderBody(harness, {
            draft: buildDraft(harness, { text: '' }),
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            onRunNow: ran,
            onSave: () => {},
            onSelectBlock,
        });
        expect(screen.findByTestId('workflow-editor-validity')).toBeNull();

        await screen.pressByTestIdAsync('workflow-editor-run-now');
        expect(ran).not.toHaveBeenCalled();
        expect(screen.findByTestId('workflow-editor-validity')).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.page.issuesToFix');
        expect(onSelectBlock).toHaveBeenCalledWith('analyze');
    });

    it('opens the Where picker instead of refusing when Run now has no machine', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const screen = await renderBody(harness, {
            projectTarget: null,
            machineName: null,
            projectMachines: [{ id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } }],
            onChangeProjectTarget: () => {},
            onRunNow: ran,
        });
        const chip = () => screen.root.findAll((node) => node.props?.filter?.id === 'workflow-where')[0];
        // Missing is stated once, by the Where chip.
        expect(chip()?.props.filter.muted).toBe(true);
        expect(chip()?.props.filter.valueLabel).toBe('workflows.page.where.choose');
        expect(chip()?.props.filter.open).toBe(false);

        await screen.pressByTestIdAsync('workflow-editor-run-now');
        expect(ran).not.toHaveBeenCalled();
        expect(chip()?.props.filter.open).toBe(true);
        expect(announceSpy).not.toHaveBeenCalled();
    });

    /**
     * UX §1/§4.2: the first prompt is the visual center, not something reached
     * after a schema wall. Inputs and shared defaults are optional refinements
     * and follow the authored steps.
     */
    it('composes the settings, then the blocks, for a host without page commands', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, {
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            projectMachines: [{ id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } }],
            onChangeProjectTarget: () => {},
        });

        const order = [
            'workflow-editor-machine-row',
            'workflow-editor-defaults',
            'workflow-editor-inputs-row',
            'workflow-editor-final-output-row',
            'workflow-editor-list-root',
        ];
        expect(renderedOrder(screen, order)).toEqual(order);
    });

    /**
     * 04 §5.2 (D10): Workflow settings are quiet by default. Each group is one
     * line of effective values until it holds a value set for this workflow,
     * needs attention, or the person opens it; the person's choice is view
     * state. A required-but-missing machine keeps Where it runs open even when
     * the person closed it, so a closed group never hides what is required.
     */
    it('keeps settings groups as summaries until a value, a missing requirement or the person opens them', async () => {
        const harness = await loadHarness();
        const toggled = vi.fn();
        const pristine = harness.createWorkflowEditorDraft({ draftId: 'draft-quiet', name: 'Quiet' });
        const screen = await renderBody(harness, {
            draft: pristine,
            inspectorGroupDisclosure: new Map([['where', false]]),
            onChangeInspectorGroup: toggled,
        });
        // Where it runs: the machine is required and missing, so it stays open.
        expect(screen.findByTestId('workflow-editor-where-field')).not.toBeNull();
        // Everything else is a one-line summary of its effective values.
        expect(screen.findByTestId('workflow-editor-defaults')).toBeNull();
        expect(screen.findByTestId('workflow-editor-defaults-continuity-row')).toBeNull();
        expect(screen.findByTestId('workflow-editor-inputs-row')).toBeNull();
        expect(screen.getTextContent()).toContain('workflows.conversation.sharedRun · workflows.workspace.inherit');
        expect(screen.getTextContent()).toContain('workflows.page.inspector.none · workflows.finalOutput.none');

        await screen.pressByTestIdAsync('workflow-editor-group-inputs-header');
        expect(toggled).toHaveBeenCalledWith('inputs', true);
        await screen.unmount();

        // The person's choice opens it; a value set for this workflow opens another.
        const opened = await renderBody(harness, {
            draft: harness.setWorkflowDefaultField(pristine, 'conversation', { kind: 'fresh' }),
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            inspectorGroupDisclosure: new Map([['inputs', true]]),
        });
        expect(opened.findByTestId('workflow-editor-inputs-row')).not.toBeNull();
        expect(opened.findByTestId('workflow-editor-defaults-continuity-row')).not.toBeNull();
        expect(opened.findByTestId('workflow-editor-defaults')).toBeNull();
        // With the machine chosen, Where it runs follows the ordinary rule.
        expect(opened.findByTestId('workflow-editor-where-field')).not.toBeNull();
    });

    /**
     * Continuing a workspace reuses its exact dirty state, and parallel branches
     * that resolve to one directory write to it together. Both are allowed and
     * both are stated where the choice is made — only when they apply.
     */
    it('discloses workspace reuse and shared parallel writes only where they apply', async () => {
        const harness = await loadHarness();
        const linear = await renderBody(harness);
        expect(linear.findByTestId('workflow-editor-defaults-continuity-workspace-shared-parallel-note')).toBeNull();
        expect(linear.findByTestId('workflow-editor-defaults-continuity-workspace-reuse-note')).toBeNull();
        await linear.unmount();

        const withParallel = harness.insertWorkflowBlock(buildDraft(harness), {
            list: { kind: 'root' },
            block: harness.createWorkflowBlock('parallel', new Set(['analyze'])),
        });
        const parallel = await renderBody(harness, { draft: withParallel });
        expect(parallel.findByTestId('workflow-editor-defaults-continuity-workspace-shared-parallel-note')).not.toBeNull();
        await parallel.unmount();

        const isolated = await renderBody(harness, {
            draft: harness.setWorkflowDefaultField(withParallel, 'workspace', {
                kind: 'new_worktree',
                source: { kind: 'original' },
            }),
        });
        expect(isolated.findByTestId('workflow-editor-defaults-continuity-workspace-shared-parallel-note')).toBeNull();
    });

    /**
     * The runtime continues an earlier conversation only with that
     * conversation's Agent and folder; a mismatch is refused, never silently
     * forked. That consequence is stated on the continuation choices, and
     * nowhere a new conversation is already what runs.
     */
    it('states that a continued conversation keeps its Agent and folder only on continuation choices', async () => {
        const harness = await loadHarness();
        const noteId = 'workflow-editor-defaults-continuity-conversation-continuation-note';
        const shared = await renderBody(harness);
        expect(shared.findByTestId(noteId)).toBeNull();
        await shared.unmount();

        const fresh = await renderBody(harness, {
            draft: harness.setWorkflowDefaultField(buildDraft(harness), 'conversation', { kind: 'fresh' }),
        });
        expect(fresh.findByTestId(noteId)).toBeNull();
        await fresh.unmount();

        const continued = await renderBody(harness, {
            draft: harness.setWorkflowDefaultField(
                buildDraft(harness),
                'conversation',
                { kind: 'existing_session', sessionId: 'session-9', machineId: 'machine-1' },
            ),
            existingSessions: [{ sessionId: 'session-9', machineId: 'machine-1', label: 'Ship release' }],
        });
        expect(continued.findByTestId(noteId)?.props.children).toBe('workflows.conversation.continuingKeepsAgentAndFolder');
        await continued.unmount();
    });

    /**
     * Parallel branches get separate conversations only when every step in
     * them actually runs fresh. Under the shared default they share the Run's
     * conversation, so the group must not claim otherwise.
     */
    it('says parallel branches use separate conversations only when every branch step runs fresh', async () => {
        const harness = await loadHarness();
        const noteId = 'workflow-editor-inspector-parallel-parallel-1-separate-conversations';
        const withParallel = harness.insertWorkflowBlock(buildDraft(harness), {
            list: { kind: 'root' },
            block: harness.createWorkflowBlock('parallel', new Set(['analyze'])),
        });
        const shared = await renderBody(harness, { draft: withParallel });
        expect(shared.findByTestId('workflow-editor-parallel-parallel-1')).not.toBeNull();
        await shared.pressByTestIdAsync('workflow-editor-parallel-parallel-1-summary');
        expect(shared.findByTestId(noteId)).toBeNull();
        await shared.unmount();

        const freshDraft = harness.setWorkflowDefaultField(withParallel, 'conversation', { kind: 'fresh' });
        const fresh = await renderBody(harness, { draft: freshDraft });
        await fresh.pressByTestIdAsync('workflow-editor-parallel-parallel-1-summary');
        expect(fresh.findByTestId(noteId)?.props.children).toBe('workflows.conversation.branchesUseSeparate');
        await fresh.unmount();

        const oneShared = await renderBody(harness, {
            draft: harness.setWorkflowStepExecutionField(freshDraft, 'step-1', 'conversation', { kind: 'shared_run' }),
        });
        await oneShared.pressByTestIdAsync('workflow-editor-parallel-parallel-1-summary');
        expect(oneShared.findByTestId(noteId)).toBeNull();
        await oneShared.unmount();
    });

    it('recomposes on a phone: the name stays in the page, value rows, Steps | Flow and a bottom bar', async () => {
        windowDimensions = { width: 390, height: 700 };
        paneState.detailsAvailable = false;
        const harness = await loadHarness();
        const { KeyboardAwareScrollView } = await import('@/components/ui/keyboardAvoidance/KeyboardAwareScrollView');
        const screen = await renderBody(harness, { onRunNow: () => {}, onSave: () => {}, saveStatus: { kind: 'unsaved' } });

        expect(screen.findAllByType(KeyboardAwareScrollView as never)).toHaveLength(1);
        // No side slots on a phone.
        expect(paneState.lastHostProps).toBeNull();
        expect(screen.findByTestId('workflow-editor-name')).not.toBeNull();
        const order = [
            'workflow-editor-header',
            'workflow-editor-where-row',
            'workflow-editor-save-status',
            'workflow-editor-view',
            'workflow-editor-steps-presentation',
        ];
        expect(renderedOrder(screen, order)).toEqual(order);
        const bar = screen.findHostByTestId('workflow-editor-phone-bar');
        expect(bar?.findAll((node) => node.props?.testID === 'workflow-editor-run-now').length).toBeGreaterThan(0);
        expect(bar?.findAll((node) => node.props?.testID === 'workflow-editor-phone-save').length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('workflow-editor-where-row');
        expect(modalShowSpy).toHaveBeenCalled();
    });

    it('lets a wrapper host keep one page scroll by composing the body without its own', async () => {
        const harness = await loadHarness();
        // The Automation wrappers own their scroll and offer no page commands.
        const screen = await renderBody(harness, { showNameField: false });

        expect(screen.findHostByTestId('workflow-editor-scroll')).toBeNull();
        expect(screen.findHostByTestId('workflow-editor-header')).toBeNull();
        expect(screen.findByTestId('workflow-editor-defaults')).not.toBeNull();
    });

    it('hides an effect the host cannot offer instead of rendering it inert', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, { onRunNow: vi.fn(), saveStatus: { kind: 'unsaved' } });
        expect(screen.findByTestId('workflow-editor-save')).toBeNull();
        expect(screen.findByTestId('workflow-editor-schedule')).toBeNull();
    });

    it('refuses Save without a name through the same gate and states the reason once', async () => {
        const harness = await loadHarness();
        const saved = vi.fn();
        const screen = await renderBody(harness, {
            draft: buildDraft(harness, { name: '  ' }),
            onSave: saved,
            saveStatus: { kind: 'unsaved' },
        });

        await screen.pressByTestIdAsync('workflow-editor-save');
        expect(saved).not.toHaveBeenCalled();
        expect(String(announceSpy.mock.calls[0]?.[0])).toContain('workflows.save.nameRequired');
    });

    it('registers Save and Run through the canonical catalog and calls the visible-action owners', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const saved = vi.fn();
        await renderBody(harness, { onRunNow: ran, onSave: saved });
        expect(Object.keys(registeredHandlers).sort()).toEqual(['workflow.run', 'workflow.save']);

        registeredHandlers['workflow.save']!();
        expect(saved).toHaveBeenCalledTimes(1);
        registeredHandlers['workflow.run']!();
        expect(ran).toHaveBeenCalledTimes(1);
        expect(announceSpy).not.toHaveBeenCalled();
    });

    it('ignores a shortcut repeat while its command is pending, without a second submission', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const saved = vi.fn();
        await renderBody(harness, { onRunNow: ran, onSave: saved, runPending: true, savePending: true });
        registeredHandlers['workflow.run']!();
        registeredHandlers['workflow.save']!();
        expect(ran).not.toHaveBeenCalled();
        expect(saved).not.toHaveBeenCalled();
        // A pending command is already acknowledged by its own label.
        expect(announceSpy).not.toHaveBeenCalled();
    });

    /**
     * A shortcut, press or host intent that cannot proceed is refused audibly
     * with the same reason the page shows beside the control, and focus lands
     * on the step that carries the cause. It never vanishes silently and never
     * reaches the effect owner.
     */
    it('refuses a blocked shortcut with the visible reason and focuses the offending step', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const onSelectBlock = vi.fn();
        await renderBody(harness, {
            draft: buildDraft(harness, { text: '' }),
            onRunNow: ran,
            onSelectBlock,
        });
        expect(registeredHandlers['workflow.run']).toBeDefined();
        registeredHandlers['workflow.run']!();

        expect(ran).not.toHaveBeenCalled();
        expect(announceSpy).toHaveBeenCalledTimes(1);
        expect(String(announceSpy.mock.calls[0]?.[0])).toContain('workflows.a11y.commandRefused');
        expect(String(announceSpy.mock.calls[0]?.[0])).toContain('workflows.issue.invalid_input');
        expect(onSelectBlock).toHaveBeenCalledWith('analyze');
        expect(promptFocus).toHaveBeenCalledTimes(1);
    });

    it('routes a host intent through the same gate as the visible action', async () => {
        const harness = await loadHarness();
        const ran = vi.fn();
        const scheduled = vi.fn();
        const commandsRef = React.createRef<import('./WorkflowEditorBody').WorkflowEditorCommands | null>();
        const blocked = await renderBody(harness, {
            draft: buildDraft(harness, { text: '' }),
            onRunNow: ran,
            onSchedule: scheduled,
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            commandsRef,
        });
        commandsRef.current!.runNow();
        commandsRef.current!.schedule();
        expect(ran).not.toHaveBeenCalled();
        expect(scheduled).not.toHaveBeenCalled();
        expect(String(announceSpy.mock.calls.at(-1)?.[0])).toContain('workflows.a11y.commandRefused');
        await blocked.unmount();

        const eligible = await renderBody(harness, {
            onRunNow: ran,
            onSchedule: scheduled,
            authoringFacts: { agentTargets: [{ id: 'agent:happier.agent.claude/claude',
                label: 'Claude Code', target: AGENT_TARGET, agentId: 'claude' }] },
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            commandsRef,
        });
        commandsRef.current!.runNow();
        commandsRef.current!.schedule();
        expect(ran).toHaveBeenCalledTimes(1);
        // Schedule opens this page's trigger settings; it is not a second host effect.
        expect(scheduled).not.toHaveBeenCalled();
        await eligible.unmount();
    });

    /**
     * Local invalid text is never a private editor fact: it enters the draft as
     * an unresolved value, so the one canonical validation blocks Run, Save,
     * Schedule and Export together and each states the same cause.
     */
    it('blocks every command on an unresolved input default and states the cause on each', async () => {
        const harness = await loadHarness();
        const handlers = { onRunNow: vi.fn(), onSave: vi.fn(), onSchedule: vi.fn(), onExportJson: vi.fn() };
        let draft: WorkflowEditorDraft = {
            ...buildDraft(harness),
            inputs: [{ name: 'count', valueType: 'number', required: false }],
        };
        function Controlled(): React.ReactElement {
            const [current, setCurrent] = React.useState(draft);
            draft = current;
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current,
                onChange: setCurrent,
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: null,
                onSelectBlock: () => {},
                onCustomizeBlock: () => {},
                view: 'steps',
                onChangeView: () => {},
                projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
                ...handlers,
            } as never);
        }
        const screen = await renderScreen(React.createElement(Controlled));
        // Inputs are Workflow settings: open the pane that holds them.
        await screen.pressByTestIdAsync('workflow-editor-settings-toggle');
        await act(async () => { screen.changeTextByTestId('workflow-editor-input-0-default', 'many'); });

        expect(Number.isNaN(draft.inputs[0]?.default)).toBe(true);
        expect(screen.findByTestId('workflow-editor-input-0-default')?.props.value).toBe('many');
        expect(screen.findByTestId('workflow-editor-input-0-default-error')?.props.accessibilityRole).toBe('alert');
        registeredHandlers['workflow.save']!();
        registeredHandlers['workflow.run']!();
        expect(handlers.onSave).not.toHaveBeenCalled();
        expect(handlers.onRunNow).not.toHaveBeenCalled();
        // Both refusals state the one canonical cause.
        for (const call of announceSpy.mock.calls) {
            expect(String(call[0])).toContain('workflows.issue.invalid_input');
        }

        await act(async () => { screen.changeTextByTestId('workflow-editor-input-0-default', '3'); });
        expect(draft.inputs[0]?.default).toBe(3);
        registeredHandlers['workflow.run']!();
        expect(handlers.onRunNow).toHaveBeenCalledTimes(1);
    });

    it('authors a step result-wait timeout through the inspector and omits it when cleared', async () => {
        const harness = await loadHarness();
        let draft: WorkflowEditorDraft = buildDraft(harness);
        function Controlled(): React.ReactElement {
            const [current, setCurrent] = React.useState(draft);
            draft = current;
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current,
                onChange: setCurrent,
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: 'analyze',
                onSelectBlock: () => {},
                onCustomizeBlock: () => {},
                view: 'steps',
                onChangeView: () => {},
                inspectorGroupDisclosure: new Map([['block:analyze:advanced', true]]),
            } as never);
        }
        const screen = await renderScreen(React.createElement(Controlled));
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');
        // The step options popover, over the same draft owner; the deadline is under Advanced.
        const options = screen;
        await act(async () => { options.changeTextByTestId('workflow-editor-inspector-timeout', '5000'); });
        expect((draft.blocks[0] as { timeoutMs?: number }).timeoutMs).toBe(5000);
        expect(harness.validateWorkflowEditorDraft(draft).normalizedDefinition?.blocks[0]).toMatchObject({ timeoutMs: 5000 });
        await act(async () => { options.changeTextByTestId('workflow-editor-inspector-timeout', ''); });
        expect(draft.blocks[0]).not.toHaveProperty('timeoutMs');
    });

    /**
     * 04 §5.2 (block subject): each Step options row writes the step's own
     * property and its "Workflow default" or off state deletes it, so the step
     * inherits again. Result and Only run when push their editors into the same
     * popover, and the document's Step options chip reads what differs.
     */
    it('authors Runs in, Review before continuing, Result and Only run when as own step properties', async () => {
        const harness = await loadHarness();
        let draft: WorkflowEditorDraft = buildDraft(harness);
        function Controlled(): React.ReactElement {
            const [current, setCurrent] = React.useState(draft);
            draft = current;
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current,
                onChange: setCurrent,
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: 'analyze',
                onSelectBlock: () => {},
                onCustomizeBlock: () => {},
                view: 'steps',
                onChangeView: () => {},
                executionTarget: 'session',
            } as never);
        }
        const screen = await renderScreen(React.createElement(Controlled));
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');

        await screen.pressByTestIdAsync('workflow-editor-inspector-runs-in:detached_run');
        expect(draft.blocks[0]).toMatchObject({ execution: { executionTarget: { kind: 'detached_run' } } });
        await screen.pressByTestIdAsync('workflow-editor-inspector-runs-in:default');
        expect(draft.blocks[0]).not.toHaveProperty('execution');

        await act(async () => { screen.findByTestId('workflow-editor-inspector-review-switch')?.props.onValueChange(true); });
        expect(draft.blocks[0]).toMatchObject({ pauseForReview: true });
        expect(screen.findByTestId('workflow-editor-step-analyze-inheritance')?.props.children)
            .toBe('workflows.page.inspector.reviewsBeforeContinuing');
        await act(async () => { screen.findByTestId('workflow-editor-inspector-review-switch')?.props.onValueChange(false); });
        expect(draft.blocks[0]).not.toHaveProperty('pauseForReview');

        await screen.pressByTestIdAsync('workflow-editor-inspector-result');
        await screen.pressByTestIdAsync('workflow-editor-inspector-result-kind:json');
        expect(draft.blocks[0]).toMatchObject({ result: { kind: 'json' } });
        await screen.pressByTestIdAsync('workflow-editor-inspector-back');

        await screen.pressByTestIdAsync('workflow-editor-inspector-only-when');
        await screen.pressByTestIdAsync('workflow-editor-inspector-condition-add-condition');
        expect(draft.blocks[0]).toHaveProperty('onlyWhen');
        // The document states the condition quietly; it is edited in Step options only.
        expect(screen.findByTestId('workflow-editor-step-analyze-only-when')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-inspector-condition-remove-condition');
        expect(draft.blocks[0]).not.toHaveProperty('onlyWhen');
    });

    it('offers Workflow default first in a step Conversation and deletes the step choice when it is picked', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const pinned = harness.setWorkflowStepExecutionField(buildDraft(harness), 'analyze', 'conversation', { kind: 'shared_run' });
        const screen = await renderBody(harness, { draft: pinned, onChange: changed });
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-customize');

        const field = dropdownField(screen, 'workflow-editor-inspector-continuity-conversation-field');
        expect(field.props.items[0]).toMatchObject({ id: 'default' });
        // The option equal to the default is still offered, and it is what is pinned now (F24).
        expect(field.props.selectedId).toBe('shared_run');
        await act(async () => { field.props.onSelect('default'); });
        expect(changed.mock.calls.at(-1)?.[0].blocks[0]).not.toHaveProperty('execution');
    });

    it('opens Step options for a Wait for you and a Side by side group with their own rows', async () => {
        const harness = await loadHarness();
        const parallel = harness.createWorkflowBlock('parallel', new Set(['analyze']));
        const wait = harness.createWorkflowLeafBlock({ kind: 'wait' }, new Set(['analyze', parallel.id]));
        const draft = { ...buildDraft(harness), blocks: [...buildDraft(harness).blocks, parallel, wait] };
        const screen = await renderBody(harness, { draft });

        await screen.pressByTestIdAsync(`workflow-editor-wait-${wait.id}-options`);
        expect(screen.findByTestId('workflow-editor-inspector-result')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-inspector-only-when')).not.toBeNull();
        // A Wait has no agent turn: no Runs in, no Agent and model.
        expect(screen.findByTestId('workflow-editor-inspector-runs-in')).toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-inspector-done');

        await screen.pressByTestIdAsync(`workflow-editor-parallel-${parallel.id}-summary`);
        expect(screen.findByTestId(`workflow-editor-inspector-parallel-${parallel.id}-failure-policy:fail_stop`)).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-inspector-only-when')).not.toBeNull();
    });

    /**
     * 07 J19 / 04 §5.2 E17: dropping a Session onto an Agent step writes the
     * same `existing_session` binding as Conversation › A session…; a Session on
     * another machine than the workflow's Where is refused and writes nothing.
     */
    it('binds a Session dropped onto a step and refuses one from another machine', async () => {
        const harness = await loadHarness();
        const { useEntityDragDropRuntime } = await import('@/components/ui/treeDragDrop');
        const scope = await bindingHome();
        const changed = vi.fn();
        const ran = vi.fn();
        const saved = vi.fn();
        const initial = buildDraft(harness);
        let runtime: ReturnType<typeof useEntityDragDropRuntime> | undefined;
        function Realm() { runtime = useEntityDragDropRuntime(); return null; }
        const screen = await renderBody(harness, {
            draft: initial, sessionBindingScope: scope,
            onRunNow: ran, onSave: saved,
            onChange: changed,
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            projectMachines: [
                { id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me' } },
                { id: 'machine-2', metadata: { displayName: 'Linux box', homeDir: '/home/me' } },
            ],
            sessionDropCandidates: [
                { sessionId: 'here', machineId: 'machine-1', label: 'Fix login' },
                { sessionId: 'there', machineId: 'machine-2', label: 'Elsewhere' },
            ],
        }, { wrapper: ({ children }) => <><Realm />{children}</>, createNodeMock: element =>
            React.isValidElement<{ testID?: string }>(element) && element.props.testID === 'workflow-editor-step-analyze-session-drop'
                ? { getBoundingClientRect: () => ({ x: 10, y: 10, left: 10, top: 10, width: 500, height: 200 }) } : null });
        let sessionId = 'there';
        const retireSource = runtime!.registerSource({ id: 'workflow-source', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: scope.serverId, sessionId } }) });
        const target = runtime!.getDestinations('workflow-source').find(destination => destination.label === 'Analyze the repository')!;
        expect(target.admission).toMatchObject({ status: 'refused', reason: { code: 'workflow_where_machine_mismatch' } });
        const drop = async () => {
            let result: Awaited<ReturnType<NonNullable<typeof runtime>['perform']>> = null;
            await act(async () => {
                runtime!.begin('workflow-source'); runtime!.move({ x: 20, y: 20 });
                result = await runtime!.release();
            });
            return result;
        };

        const refused = await drop();
        // Never inserted as text into the composer, and nothing is bound.
        expect(refused).toMatchObject({ status: 'refused' });
        expect(changed).not.toHaveBeenCalled();

        sessionId = 'here';
        await act(async () => { runtime!.begin('workflow-source')!.choose(target.targetId); runtime!.cancel(); });
        expect(changed).not.toHaveBeenCalled();
        expect(await drop()).toMatchObject({ status: 'applied' });
        expect(changed).toHaveBeenCalledTimes(1);
        expect(changed.mock.calls[0]?.[0].blocks[0].execution.conversation)
            .toEqual({ kind: 'existing_session', sessionId: 'here', machineId: 'machine-1' });
        expect(changed.mock.calls[0]?.[0]).toEqual({ ...initial, blocks: [{ ...initial.blocks[0], execution: {
            conversation: { kind: 'existing_session', sessionId: 'here', machineId: 'machine-1' },
        } }] });
        expect(ran).not.toHaveBeenCalled();
        expect(saved).not.toHaveBeenCalled();
        await act(async () => { retireSource(); });
        await screen.unmount();
    });

    /**
     * WF-05 / plan 04 §3.2: a step can continue an arbitrary existing Session,
     * chosen through the canonical Session picker from the host's candidates,
     * and the choice records the exact Session and Machine the coordinator
     * requires. Without candidates the choice is stated unavailable, and a
     * recorded Session this host cannot list stays visible by its identity.
     */
    it('authors an existing Session continuation from the host-supplied candidates', async () => {
        const harness = await loadHarness();
        const scope = await bindingHome();
        const changed = vi.fn();
        const screen = await renderBody(harness, {
            sessionBindingScope: scope,
            onChange: changed,
            existingSessions: [
                { sessionId: 'session-1', machineId: 'machine-1', label: 'Fix login' },
                { sessionId: 'session-2', machineId: 'machine-1', label: 'Refactor sync' },
            ],
        });
        const field = dropdownField(screen, 'workflow-editor-defaults-continuity-conversation-field');
        const existing = field.props.items.find((item) => item.id === 'existing_session');
        expect(existing).toMatchObject({ title: 'workflows.page.inspector.aSession' });
        expect(existing?.disabled).toBe(false);
        expect(screen.findByTestId('workflow-editor-defaults-continuity-conversation-session-picker')).toBeNull();

        // "A session…" opens the canonical picker; nothing is authored until a Session is chosen.
        await act(async () => { field.props.onSelect('existing_session'); });
        expect(changed).not.toHaveBeenCalled();
        const picker = screen.findByTestId('workflow-editor-defaults-continuity-conversation-session-picker');
        expect(picker).not.toBeNull();
        const options = picker!.props.rootStep.sections[0].options as Array<{ id: string; label: string }>;
        expect(options.map((option) => option.id)).toEqual(['session-1', 'session-2']);
        await act(async () => { await picker!.props.onSelect('session-2', options[1]); });

        expect(changed).toHaveBeenCalledTimes(1);
        const next = changed.mock.calls[0]?.[0];
        expect(next.defaults.conversation).toEqual({ kind: 'existing_session', sessionId: 'session-2', machineId: 'machine-1' });
        expect(harness.validateWorkflowEditorDraft(next).normalizedDefinition?.defaults.conversation)
            .toEqual({ kind: 'existing_session', sessionId: 'session-2', machineId: 'machine-1' });
    });

    it('retires mounted conversation binding before passive editor cleanup', async () => {
        const harness = await loadHarness();
        const scope = await bindingHome();
        const { invokeWorkflowConversationBinding } = await import('@/sync/ops/actions/workflowAuthoringAction');
        const draft = buildDraft(harness);
        const changed = vi.fn();
        let result: ReturnType<typeof invokeWorkflowConversationBinding> | undefined;
        function Host({ shown }: { shown: boolean }) {
            React.useLayoutEffect(() => {
                if (!shown) result = invokeWorkflowConversationBinding({
                    input: { scope, draftId: draft.draftId, stepId: 'analyze', address: { serverId: scope.serverId, sessionId: 'session' } },
                    context: { serverId: scope.serverId, runtimeAccountId: scope.accountId },
                });
            }, [shown]);
            return shown ? <harness.WorkflowEditorBody draft={draft} onChange={changed} machineName="Mac Studio"
                composerScope={MACHINE_COMPOSER_SCOPE} sessionBindingScope={scope} selectedBlockId={null}
                onSelectBlock={() => {}} onCustomizeBlock={() => {}} view="steps" onChangeView={() => {}}
                sessionDropCandidates={[{ sessionId: 'session', machineId: 'machine-1', label: 'Review' }]} /> : null;
        }
        const screen = await renderScreen(<Host shown />);
        await screen.update(<Host shown={false} />);
        expect(await result).toEqual({ status: 'unavailable' });
        expect(changed).not.toHaveBeenCalled();
    });

    it('shows a recorded existing Session and states when none can be offered', async () => {
        const harness = await loadHarness();
        const recorded = harness.setWorkflowDefaultField(
            buildDraft(harness),
            'conversation',
            { kind: 'existing_session', sessionId: 'session-9', machineId: 'machine-1' },
        );
        const listed = await renderBody(harness, {
            draft: recorded,
            existingSessions: [{ sessionId: 'session-9', machineId: 'machine-1', label: 'Ship release' }],
        });
        const field = dropdownField(listed, 'workflow-editor-defaults-continuity-conversation-field');
        expect(field.props.selectedId).toBe('existing_session');
        expect(field.props.items.find((item) => item.id === 'existing_session')?.title)
            .toContain('Ship release');
        await listed.unmount();

        const unlisted = await renderBody(harness, { draft: recorded });
        expect(unlisted.getTextContent()).toContain('session-9');
        await unlisted.unmount();

        const none = await renderBody(harness);
        const noneField = dropdownField(none, 'workflow-editor-defaults-continuity-conversation-field');
        const existing = noneField.props.items.find((item) => item.id === 'existing_session');
        expect(existing?.disabled).toBe(true);
        expect(existing?.subtitle).toBe('workflows.conversation.noExistingSessions');
        expect(none.findByTestId('workflow-editor-defaults-continuity-conversation-existing-unavailable')).not.toBeNull();
        await none.unmount();
    });

    it('keeps a pristine one-prompt draft free of invitations and validation text', async () => {
        const harness = await loadHarness();
        const empty = await renderBody(harness, {
            draft: buildDraft(harness, { text: '' }),
            onRunNow: () => {},
            onSave: () => {},
            saveStatus: { kind: 'notSaved' },
            projectTarget: null,
            machineName: null,
        });
        const text = empty.getTextContent();
        expect(text).not.toContain('workflows.editor.firstPromptTitle');
        expect(text).not.toContain('workflows.issue.');
        expect(text).not.toContain('workflows.page.issuesToFix');
        expect(text).toContain('workflows.page.saveStatus.notSaved');
    });

    it('keeps the machine control visibly unresolved rather than fabricating a default', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness, { machineName: null });
        // It names the missing Machine and folder, not an unrelated Agent issue.
        expect(screen.getTextContent()).toContain('workflows.editor.targetRequired');
        expect(screen.getTextContent()).not.toContain('workflows.issue.target_unavailable');
    });

    it('switches to Flow and restores the exact prompt focus through the existing focus owner', async () => {
        const harness = await loadHarness();
        function ControlledBody() {
            const [view, setView] = React.useState<'steps' | 'flow'>('flow');
            const [selectedBlockId, setSelectedBlockId] = React.useState<string | null>('analyze');
            return React.createElement(harness.WorkflowEditorBody, {
                draft: buildDraft(harness),
                onChange: () => {},
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId,
                onSelectBlock: setSelectedBlockId,
                onCustomizeBlock: setSelectedBlockId,
                view,
                onChangeView: setView,
                onRunNow: () => {},
            });
        }
        // The Steps | Flow switch is the phone's; wide layouts show Flow as a pane.
        paneState.detailsAvailable = false;
        const screen = await renderScreen(React.createElement(ControlledBody));

        expect(screen.findByTestId('workflow-editor-flow-node-analyze')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-flow-edit-step');
        expect(screen.findByTestId('workflow-editor-step-analyze-prompt')).not.toBeNull();
        expect(promptFocus).toHaveBeenCalledTimes(1);
    });

    it('offers Each step runs in as one value choice and states an unavailable class instead of downgrading it', async () => {
        const harness = await loadHarness();
        const { resolveWorkflowRunAsTargets } = await import('../run/workflowRunAsTargets');
        const onChangeExecutionTarget = vi.fn();
        const screen = await renderBody(harness, {
            selectedBlockId: 'analyze',
            executionTarget: 'session',
            runAsTargets: resolveWorkflowRunAsTargets({ detachedExecutionRun: 'unsupported' }),
            onChangeExecutionTarget,
        });

        expect(screen.findByTestId('workflow-editor-run-as:session')?.props.accessibilityState)
            .toMatchObject({ selected: true });
        expect(screen.findByTestId('workflow-editor-run-as:attached_run')).toBeNull();
        expect(screen.findByTestId('workflow-editor-run-as:detached_run')).not.toBeNull();
        // The unavailable class keeps its reason on the row (SegmentedChoiceItem's own contract).
        expect(screen.getTextContent())
            .toContain('workflows.page.unavailable.machine_does_not_support_detached_runs');
        // It is the run default, never a step override.
        expect(screen.findByTestId('workflow-editor-inspector-run-as')).toBeNull();
    });

    it('keeps the active step composer mounted across Steps and Flow instead of remounting it', async () => {
        const harness = await loadHarness();
        function ControlledBody() {
            const [view, setView] = React.useState<'steps' | 'flow'>('steps');
            return React.createElement(harness.WorkflowEditorBody, {
                draft: buildDraft(harness),
                onChange: () => {},
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: 'analyze',
                onSelectBlock: () => {},
                onCustomizeBlock: () => {},
                view,
                onChangeView: setView,
                onRunNow: () => {},
            });
        }
        paneState.detailsAvailable = false;
        const screen = await renderScreen(React.createElement(ControlledBody));
        expect(composerInstanceIds.issued).toHaveLength(1);
        const originalInstanceId = composerInstanceIds.issued[0];

        await screen.pressByTestIdAsync('workflow-editor-view:flow');
        // The document stays mounted so caret, selection and any active IME or
        // dictation binding survive the reading-mode switch, but it must not be
        // reachable by pointer or assistive technology while Flow is showing.
        const hiddenSteps = screen.findByTestId('workflow-editor-steps-presentation');
        expect(hiddenSteps).not.toBeNull();
        expect(hiddenSteps?.props.accessibilityElementsHidden).toBe(true);
        expect(hiddenSteps?.props.importantForAccessibility).toBe('no-hide-descendants');
        expect(hiddenSteps?.props.pointerEvents).toBe('none');

        await screen.pressByTestIdAsync('workflow-editor-view:steps');
        expect(composerInstanceIds.issued).toEqual([originalInstanceId]);
    });

    /**
     * Moving a step into a group re-parents it, which React commits as a remount.
     * Everything the portable document deliberately drops — which of two equal
     * tokens a mention is bound to, staged attachment bytes, the caret — exists
     * only in the live composer, so the move must not rebuild it. The authored
     * final output names the moved step, and relocation is not deletion.
     */
    it('keeps the live prompt document, exact duplicate-token mention, caret and staged bytes when a step moves into a loop', async () => {
        const harness = await loadHarness();
        const stagedContent = {
            kind: 'stagedMedia' as const,
            handle: {
                v: 1 as const,
                id: 'stage-42',
                executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
                owner: { pluginId: 'acme.issues', localId: 'issue' },
                mediaKind: 'image' as const,
                mimeType: 'image/png',
                name: 'issue-42.png',
                sizeBytes: 12,
                sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            },
        };
        // Staged bytes only ever exist in the live composer, so the fixture seeds
        // them where they live. The first published document strips them back out,
        // which is exactly why custody — not the draft — has to retain them.
        const stagedAttachment = {
            v: 1 as const,
            instanceId: 'attachment-staged',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: 'issue-42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            content: stagedContent,
        };
        const promptText = 'Compare @issue with @issue';
        const secondTokenStart = 'Compare @issue with '.length;
        let draft = harness.setWorkflowFinalOutput(
            harness.setWorkflowDefaultField(
                harness.createWorkflowEditorDraft({
                    draftId: 'draft-1',
                    name: 'Review',
                    blocks: [
                        {
                            kind: 'loop',
                            id: 'triage',
                            repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
                            body: [],
                        },
                        {
                            kind: 'step',
                            id: 'analyze',
                            document: {
                                text: promptText,
                                references: [],
                                attachments: [stagedAttachment],
                            },
                            input: [],
                            result: { kind: 'text' },
                        },
                    ] as never,
                }),
                'agentTarget',
                AGENT_TARGET,
            ),
            { kind: 'result', producer: { blockId: 'analyze', scope: { kind: 'current' } }, path: [] },
        );
        let renderDraft = (_next: WorkflowEditorDraft) => {};
        function ControlledBody() {
            const [current, setCurrent] = React.useState(draft);
            renderDraft = setCurrent as (next: WorkflowEditorDraft) => void;
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current,
                onChange: (next: WorkflowEditorDraft) => {
                    draft = next as typeof draft;
                    setCurrent(next as typeof current);
                },
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: 'analyze',
                onSelectBlock: () => {},
                onCustomizeBlock: () => {},
                view: 'steps',
                onChangeView: () => {},
            });
        }
        const screen = await renderScreen(React.createElement(ControlledBody));

        const composerRef = composerProps.byBlockId.get('analyze')?.composerRef as never;
        expect(composerRef).toBeDefined();
        const initial = readComposerPresentationSnapshot(composerRef);
        if (!initial) throw new Error('Expected a mounted step composer');

        // A mention bound to the SECOND of two identical tokens: re-deriving it
        // from the portable form would silently move it to the first.
        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref: composerRef,
                transaction: {
                    expectedRevision: initial.revision,
                    operations: [{
                        kind: 'reference.insert',
                        reference: {
                            kind: 'partner.reference',
                            ref: 'partner:issue-42',
                            token: '@issue',
                            label: 'Issue #42',
                            start: secondTokenStart,
                            end: secondTokenStart + '@issue'.length,
                        },
                    }],
                },
            })).toEqual({ status: 'applied', revision: initial.revision + 1 });
        });
        const caret = { start: 8, end: 14 };
        const persistence = composerProps.byBlockId.get('analyze')?.inputPersistence as Readonly<{
            onSelectionChangePersist: (selection: typeof caret, textLength: number) => void;
        }> | undefined;
        expect(persistence).toBeDefined();
        await act(async () => {
            persistence?.onSelectionChangePersist(caret, promptText.length);
        });

        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions');
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions-moveIn');
        await act(async () => {});

        const loop = draft.blocks[0];
        expect(loop?.kind === 'loop' ? loop.body.map((block) => block.id) : []).toEqual(['analyze']);
        // One composer identity: the document was re-placed, not rebuilt.
        expect(composerInstanceIds.issued).toHaveLength(1);
        expect(readComposerPresentationSnapshot(composerRef)).toMatchObject({
            text: promptText,
            references: [{
                ref: 'partner:issue-42',
                start: secondTokenStart,
                end: secondTokenStart + '@issue'.length,
            }],
            attachments: [{ instanceId: 'attachment-staged', content: stagedContent }],
        });
        expect(composerProps.byBlockId.get('analyze')?.inputPersistence).toMatchObject({
            initialSelection: caret,
        });
        // Relocation is not deletion: the authored final output still names it.
        expect(draft.finalOutput?.producer.blockId).toBe('analyze');
        expect(renderDraft).toBeTypeOf('function');
    });

    /**
     * A prompt composed in another composer — New Session, through the
     * Automation chip — arrives as a portable draft plus the exact live
     * document. The step composer must open on the exact one: the mention bound
     * to the second of two equal tokens, the staged bytes and the caret. Those
     * bytes cannot be saved, so the host hears the canonical refusal rather
     * than a Save that silently drops them.
     */
    it('opens a seeded step on the exact handed-over document and reports its staged bytes as blocking', async () => {
        const harness = await loadHarness();
        const text = 'Compare @issue with @issue';
        const secondTokenStart = 'Compare @issue with '.length;
        const portableAttachment = {
            v: 1 as const,
            instanceId: 'attachment-staged',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: 'issue-42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        };
        const stagedContent = {
            kind: 'stagedMedia' as const,
            handle: {
                v: 1 as const,
                id: 'stage-42',
                executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
                owner: { pluginId: 'acme.issues', localId: 'issue' },
                mediaKind: 'image' as const,
                mimeType: 'image/png',
                name: 'issue-42.png',
                sizeBytes: 12,
                sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            },
        };
        const draft = harness.setWorkflowDefaultField(
            harness.createWorkflowEditorDraft({
                draftId: 'draft-1',
                name: 'Review',
                blocks: [{
                    kind: 'step',
                    id: 'analyze',
                    // The portable projection a saved definition may hold.
                    document: {
                        text,
                        references: [{
                            kind: 'partner.reference',
                            ref: 'partner:issue-42',
                            token: '@issue',
                            label: 'Issue #42',
                        }],
                        attachments: [portableAttachment],
                    },
                    input: [],
                    result: { kind: 'text' },
                }] as never,
            }),
            'agentTarget',
            AGENT_TARGET,
        );
        const onChange = vi.fn();
        const onValidationChange = vi.fn();
        await renderScreen(React.createElement(harness.WorkflowEditorBody, {
            draft,
            onChange,
            machineName: 'Mac Studio',
            composerScope: MACHINE_COMPOSER_SCOPE,
            selectedBlockId: 'analyze',
            onSelectBlock: () => {},
            onCustomizeBlock: () => {},
            view: 'steps',
            onChangeView: () => {},
            composerSeeds: [{
                blockId: 'analyze',
                document: {
                    text,
                    structuredInputMentions: [{
                        kind: 'partner.reference',
                        ref: 'partner:issue-42',
                        label: 'Issue #42',
                        tokenText: '@issue',
                        start: secondTokenStart,
                        end: secondTokenStart + '@issue'.length,
                    }],
                    composerAttachments: [{ ...portableAttachment, content: stagedContent }],
                },
                selection: { start: 4, end: 9 },
            }] as never,
            onValidationChange,
        }));

        const composerRef = composerProps.byBlockId.get('analyze')?.composerRef as never;
        expect(readComposerPresentationSnapshot(composerRef)).toMatchObject({
            text,
            references: [{
                ref: 'partner:issue-42',
                start: secondTokenStart,
                end: secondTokenStart + '@issue'.length,
            }],
            attachments: [{ instanceId: 'attachment-staged', content: stagedContent }],
        });
        expect(composerProps.byBlockId.get('analyze')?.inputPersistence).toMatchObject({
            initialSelection: { start: 4, end: 9 },
        });
        // Opening on the exact document is not an authored edit.
        expect(onChange).not.toHaveBeenCalled();
        expect(onValidationChange.mock.lastCall?.[0]).toMatchObject({
            valid: false,
            issues: expect.arrayContaining([expect.objectContaining({
                code: 'unsupported_persisted_attachment',
                blockId: 'analyze',
            })]),
        });
    });

    /**
     * Deleting the block is the one thing that ends its composer's custody, so a
     * restored block starts a fresh document rather than resurrecting bytes the
     * author threw away.
     */
    it('releases a step composer when the step is truly deleted', async () => {
        const harness = await loadHarness();
        let draft = harness.setWorkflowDefaultField(
            harness.createWorkflowEditorDraft({
                draftId: 'draft-1',
                name: 'Review',
                blocks: [
                    {
                        kind: 'step', id: 'analyze',
                        document: { text: 'Analyze the repository', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    },
                    {
                        kind: 'step', id: 'implement',
                        document: { text: 'Implement the plan', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    },
                ],
            }),
            'agentTarget',
            AGENT_TARGET,
        );
        function ControlledBody() {
            const [current, setCurrent] = React.useState(draft);
            const history = useWorkflowEditorHistory<WorkflowEditorDraft>('composer-custody', (snapshot) => {
                draft = snapshot;
                setCurrent(snapshot);
            });
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current,
                history: history.controls,
                onCommitChange: history.commit,
                onChange: (next: WorkflowEditorDraft, label?: string, committed?: boolean) => {
                    history.record(current, next, label ?? 'Edit workflow', committed);
                    draft = next;
                    setCurrent(next);
                },
                machineName: 'Mac Studio',
                composerScope: MACHINE_COMPOSER_SCOPE,
                selectedBlockId: null,
                onSelectBlock: () => {},
                onCustomizeBlock: () => {},
                view: 'steps',
                onChangeView: () => {},
            });
        }
        const screen = await renderScreen(React.createElement(ControlledBody));
        const originalRef = composerProps.byBlockId.get('analyze')?.composerRef as
            Readonly<{ instanceId: string }>;
        expect(originalRef?.instanceId).toBeDefined();

        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions');
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions-remove');
        await act(async () => {});
        expect(draft.blocks.map((block) => block.id)).toEqual(['implement']);

        await screen.pressByTestIdAsync('workflow-editor-undo');
        await act(async () => {});
        expect(draft.blocks.map((block) => block.id)).toEqual(['analyze', 'implement']);
        const restoredRef = composerProps.byBlockId.get('analyze')?.composerRef as
            Readonly<{ instanceId: string }>;
        expect(restoredRef.instanceId).not.toBe(originalRef.instanceId);
    });

    it('says no final output is selected until one is authored', async () => {
        const harness = await loadHarness();
        // Selection is the contract, not the presence of the copy: both options
        // are always rendered, so only the exclusive selected state can tell an
        // unauthored final output from an authored one.
        const none = await renderBody(harness);
        expect(none.findByTestId('workflow-editor-final-output-clear')?.props.accessibilityState)
            .toEqual({ selected: true });
        expect(none.findByTestId('workflow-editor-final-output-option-analyze')?.props.accessibilityState)
            .toEqual({ selected: false });
        expect(none.findByTestId('workflow-editor-final-output-path')).toBeNull();
        await none.unmount();

        const bound = await renderBody(harness, {
            draft: harness.setWorkflowFinalOutput(buildDraft(harness), {
                kind: 'result',
                producer: { blockId: 'analyze', scope: { kind: 'current' } },
                path: [],
            }),
        });
        expect(bound.findByTestId('workflow-editor-final-output-clear')?.props.accessibilityState)
            .toEqual({ selected: false });
        expect(bound.findByTestId('workflow-editor-final-output-option-analyze')?.props.accessibilityState)
            .toEqual({ selected: true });
        // The producer is named by its authored label, never by its internal id.
        expect(bound.getTextContent()).toContain('Analyze the repository');
        expect(bound.findByTestId('workflow-editor-final-output-path')).not.toBeNull();
    });

    it('authors and clears the deterministic final output through the shared draft owner', async () => {
        const harness = await loadHarness();
        const changed = vi.fn();
        const screen = await renderBody(harness, { onChange: changed });

        await screen.pressByTestIdAsync('workflow-editor-final-output-option-analyze');
        expect(changed.mock.calls[0]?.[0].finalOutput).toEqual({
            kind: 'result',
            producer: { blockId: 'analyze', scope: { kind: 'current' } },
            path: [],
        });
    });

    it('refuses Export through its gate on a draft the canonical codec cannot serialize', async () => {
        const harness = await loadHarness();
        const exportJson = vi.fn();
        const commandsRef = React.createRef<import('./WorkflowEditorBody').WorkflowEditorCommands | null>();
        await renderBody(harness, {
            draft: buildDraft(harness, { text: '' }),
            onExportJson: exportJson,
            commandsRef,
        });
        commandsRef.current!.exportJson();
        expect(exportJson).not.toHaveBeenCalled();
        expect(announceSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps every command live once the draft and its target are valid', async () => {
        const harness = await loadHarness();
        const runNow = vi.fn();
        const exportJson = vi.fn();
        const commandsRef = React.createRef<import('./WorkflowEditorBody').WorkflowEditorCommands | null>();
        const screen = await renderBody(harness, {
            onRunNow: runNow,
            onExportJson: exportJson,
            projectTarget: { machineId: 'machine-1', directory: '/Users/me/project' },
            commandsRef,
        });

        await screen.pressByTestIdAsync('workflow-editor-run-now');
        commandsRef.current!.exportJson();
        expect(runNow).toHaveBeenCalledTimes(1);
        expect(exportJson).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('workflow-editor-validity')).toBeNull();
    });

    it('offers labelled Undo/Redo from the host history and clears Redo after a new edit', async () => {
        const harness = await loadHarness();
        let draft = harness.setWorkflowDefaultField(
            harness.createWorkflowEditorDraft({
                draftId: 'draft-1',
                name: 'Review',
                blocks: [
                    {
                        kind: 'step', id: 'analyze',
                        document: { text: 'Analyze the repository', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    },
                    {
                        kind: 'step', id: 'implement',
                        document: { text: 'Implement the plan', references: [], attachments: [] },
                        input: [], result: { kind: 'text' },
                    },
                ],
            }),
            'agentTarget',
            AGENT_TARGET,
        );
        let redoLabel: string | null = null;
        function ControlledBody() {
            const [current, setCurrent] = React.useState(draft);
            const history = useWorkflowEditorHistory<WorkflowEditorDraft>('removal-history', (snapshot) => {
                draft = snapshot;
                setCurrent(snapshot);
            });
            redoLabel = history.controls.redoLabel;
            return React.createElement(harness.WorkflowEditorBody, {
                draft: current,
                history: history.controls,
                onCommitChange: history.commit,
                onChange: (next: WorkflowEditorDraft, label?: string, committed?: boolean) => {
                    history.record(current, next, label ?? 'Edit workflow', committed);
                    draft = next;
                    setCurrent(next);
                },
                machineName: 'Mac Studio', composerScope: MACHINE_COMPOSER_SCOPE,
                inspectorGroupDisclosure: OPEN_SETTINGS_GROUPS,
                selectedBlockId: null, onSelectBlock: () => {}, onCustomizeBlock: () => {},
                view: 'steps', onChangeView: () => {},
            });
        }
        const screen = await renderScreen(React.createElement(ControlledBody));

        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions');
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions-remove');
        await act(async () => {});
        expect(draft.blocks.map((block) => block.id)).toEqual(['implement']);

        expect(screen.getTextContent()).toContain('workflows.editor.removedBlock');
        await screen.pressByTestIdAsync('workflow-editor-undo');
        // Restored at its original position, not appended to the end.
        expect(draft.blocks.map((block) => block.id)).toEqual(['analyze', 'implement']);
        expect(redoLabel).toContain('workflows.editor.removedBlock');
        await screen.pressByTestIdAsync('workflow-editor-redo');
        expect(draft.blocks.map((block) => block.id)).toEqual(['implement']);
        await screen.pressByTestIdAsync('workflow-editor-undo');
        await screen.pressByTestIdAsync('workflow-editor-final-output-option-implement');
        expect(redoLabel).toBeNull();
        expect(draft.finalOutput).toMatchObject({ producer: { blockId: 'implement' } });
    });

    it('announces the first blocking validation issue exactly once', async () => {
        const harness = await loadHarness();
        const screen = await renderBody(harness);
        announceSpy.mockClear();
        await screen.update(React.createElement(harness.WorkflowEditorBody, {
            draft: buildDraft(harness, { text: '' }),
            onChange: () => {},
            machineName: 'Mac Studio',
            composerScope: MACHINE_COMPOSER_SCOPE,
            selectedBlockId: null,
            onSelectBlock: () => {},
            onCustomizeBlock: () => {},
            view: 'steps',
            onChangeView: () => {},
        } as never));
        expect(announceSpy).toHaveBeenCalledTimes(1);
    });
});

import * as React from 'react';
import { Platform, StyleSheet as NativeStyleSheet } from 'react-native';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SelectionListStep } from '@/components/ui/selectionList';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
// Navigation is a platform boundary: Open › on a Run a workflow card pushes the child's route.
const routerMock = vi.hoisted(() => ({ spies: null as unknown as { push: ReturnType<typeof vi.fn> } }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock();
    routerMock.spies = mock.spies;
    return mock.module;
});
// Native Markdown SDK boundary, imported by the host but unused by these
// document/insertion cases (the composer itself is supplied by its harness).
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// The native recycler needs viewport geometry unavailable to this host renderer.
// Render its rows through the shared boundary harness; filtering, navigation,
// activation and the editor's inserted draft remain real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(), renderItems: true }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));
// The popover portal is a platform boundary; the menu content itself is the
// behaviour under test, so it renders inline here.
const MACHINE_COMPOSER_SCOPE = {
    kind: 'machine' as const,
    machineId: 'machine-1',
    serverId: 'server-a',
    directory: '/repo/project',
    machineHomeDir: '/Users/me',
};

// The composer host is the boundary; the scoped authoring composer and its
// document owner stay real beneath it.
vi.mock('@/components/sessions/agentInput', async () => {
    const { createAgentInputModuleMock } = await import('@/dev/testkit');
    return createAgentInputModuleMock({
        renderExtraActionChips: true,
        resolveTestID: (props) => {
            const composerRef = props.composerRef as { blockId?: string } | undefined;
            return composerRef?.blockId === undefined ? undefined : `composer:${composerRef.blockId}`;
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
// The saved-workflow list is a network read; the library owner above it stays real.
vi.mock('@/sync/domains/workflows/workflowDefinitionActions', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    listWorkflowDefinitions: async () => ({ definitions: [] }),
}));
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal, { maxHeight: 480, maxWidth: 420, placement: 'bottom' });
});

// Module transform is paid once, outside any single case's time budget.
beforeAll(async () => {
    await loadHarness();
}, 300_000);

afterEach(async () => {
    await standardCleanup();
});

const AGENT_TARGET = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };

async function loadHarness() {
    const editor = await import('./WorkflowBlockListEditor');
    const draftModule = await import('@/sync/domains/workflows/workflowEditorDraft');
    const edits = await import('@happier-dev/protocol/workflows/workflowDefinitionEditV1');
    const authoring = await import('@/sync/domains/workflows/workflowAuthoring');
    const custody = await import('@/components/sessions/authoring/authoringComposerCustody');
    const loop = await import('./WorkflowLoopEditor');
    const group = await import('./WorkflowGroupEditor');
    const heading = await import('./WorkflowBlockHeading');
    return { ...editor, ...draftModule, ...edits, ...authoring, ...custody, ...loop, ...group, ...heading };
}

type Harness = Awaited<ReturnType<typeof loadHarness>>;

function buildDraft(harness: Harness, blocks?: Parameters<Harness['createWorkflowEditorDraft']>[0]['blocks']) {
    return harness.setWorkflowDefaultField(
        harness.createWorkflowEditorDraft({
            draftId: 'draft-1',
            name: 'Review',
            ...(blocks === undefined ? {} : { blocks }),
        }),
        'agentTarget',
        AGENT_TARGET,
    );
}

type AddStep = SelectionListStep;

/** Opens a scope's Add menu and returns the step the canonical popover was handed. */
async function openAddMenu(screen: Awaited<ReturnType<typeof renderScreen>>, addTestID: string): Promise<AddStep> {
    await screen.pressByTestIdAsync(addTestID);
    const { AgentInputSelectionListPopover } = await import('@/components/sessions/agentInput/components/AgentInputSelectionListPopover');
    const popover = screen.findAllByType(AgentInputSelectionListPopover).at(-1);
    if (!popover) throw new Error('Add menu did not open');
    return popover.props.rootStep as AddStep;
}

/** Chooses an Add option by id, walking into a pushed step when `path` names one. */
async function chooseAdd(screen: Awaited<ReturnType<typeof renderScreen>>, addTestID: string, path: readonly string[]): Promise<void> {
    await openAddMenu(screen, addTestID);
    for (const optionId of path) {
        if (optionId.includes('-action:')) {
            await act(async () => screen.changeTextByTestId('selection-list:header:input', optionId.split(':')[1]!));
        }
        const row = await vi.waitFor(() => {
            const match = screen.findAll((node) => typeof node.props.testID === 'string'
                && node.props.testID.startsWith('selection-list:')
                && node.props.testID.endsWith(`:option:${optionId}`)
                && typeof node.props.onPress === 'function').at(-1);
            if (!match) throw new Error(`No Add option ${optionId}`);
            return match;
        });
        await screen.pressByTestIdAsync(row.props.testID);
        // A real web click finishes its deferred close before the next click.
        await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    }
}

async function renderList(harness: Harness, options: Readonly<{
    draft: ReturnType<typeof buildDraft>;
    onChange?: (next: unknown) => void;
    onSelect?: (id: string | null) => void;
    selectedBlockId?: string | null;
    highlightedBlockIds?: readonly string[];
    presentation?: Record<string, unknown>;
    resolveActionFieldOptions?: (field: { optionsSourceId?: string; options?: unknown }) => ReadonlyArray<{ value: string; label: string }>;
}>) {
    const element = React.createElement(harness.WorkflowBlockListEditor, {
        ...(options.presentation === undefined ? {} : { presentation: options.presentation as never }),
        ...(options.resolveActionFieldOptions === undefined ? {} : { resolveActionFieldOptions: options.resolveActionFieldOptions as never }),
        draft: options.draft,
        list: { kind: 'root' },
        blocks: options.draft.blocks,
        depth: 0,
        composerScope: MACHINE_COMPOSER_SCOPE,
        composerCustody: harness.createWorkflowAuthoringComposerCustody(options.draft.draftId),
        selectedBlockId: options.selectedBlockId ?? null,
        highlightedBlockIds: options.highlightedBlockIds,
        validation: harness.validateWorkflowEditorDraft(options.draft),
        onChange: options.onChange ?? (() => {}),
        onSelect: options.onSelect ?? (() => {}),
        onCustomize: () => {},
    });
    return renderScreen(element);
}

it('shows editable names on every kind and evaluator without replacing catalog Action identity', async () => {
    const harness = await loadHarness();
    const agent = { kind: 'step' as const, id: 'inspect', name: 'Inspect', document: { text: 'Read the diff', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } };
    const draft = buildDraft(harness, [agent,
        { kind: 'action', id: 'notify', name: 'Announce it', actionId: 'notifications.notify_me', input: {} },
        { kind: 'wait', id: 'approve', name: 'Approve release', document: { text: 'Confirm', references: [], attachments: [] } },
        { kind: 'workflow', id: 'child', name: 'Review release', workflowRef: 'builtin:plan-with-a-panel', input: {} },
        { kind: 'parallel', id: 'panel', name: 'Panel', failurePolicy: 'fail_stop', branches: [{ id: 'lane', blocks: [] }] },
        { kind: 'if', id: 'decision', name: 'Check readiness', when: { kind: 'exists', value: { kind: 'literal', value: true } }, then: [], otherwise: [] },
        { kind: 'loop', id: 'keep', name: 'Keep going', body: [], repetition: { kind: 'evaluate', maxIterations: 2, history: 'latest', evaluator: { ...agent, id: 'judge', name: 'Judge progress', result: { kind: 'decision', decisions: ['continue', 'done'] } } } },
    ]);
    const screen = await renderList(harness, { draft });
    for (const [kind, id, name] of [['step', 'inspect', 'Inspect'], ['action', 'notify', 'Announce it'], ['wait', 'approve', 'Approve release'], ['workflow', 'child', 'Review release'], ['parallel', 'panel', 'Panel'], ['if', 'decision', 'Check readiness'], ['loop', 'keep', 'Keep going'], ['step', 'judge', 'Judge progress']]) {
        expect(screen.findByTestId(`workflow-editor-${kind}-${id}-label`)?.props.value).toBe(name);
    }
});

it('edits run when on the connector and preserves an independent only-when condition', async () => {
    // Exercise the real Popover on native. This renderer has no browser DOM;
    // changing only the platform boundary keeps the connector and menu real.
    const platformOSDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
    Object.defineProperty(Platform, 'OS', { configurable: true, writable: true, value: 'ios' });
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        const harness = await loadHarness();
        const onlyWhen = { kind: 'exists' as const, value: { kind: 'literal' as const, value: true } };
        const agent = { kind: 'step' as const, id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } };
        const draft = buildDraft(harness, [agent, { ...agent, id: 'next', onlyWhen }]);
        let updated = draft;
        const rendered = await renderList(harness, { draft, onChange: next => { updated = next as typeof draft; } });
        screen = rendered;
        await rendered.pressByTestIdAsync('workflow-editor-next-run-when');
        await rendered.pressByTestIdAsync('workflow-editor-next-run-when-choice:failure');
        expect(updated.blocks[1]).toMatchObject({ runWhen: 'failure', onlyWhen });
        await act(async () => rendered.update(React.createElement(harness.WorkflowBlockListEditor, {
            draft: updated, list: { kind: 'root' }, blocks: updated.blocks, depth: 0,
            composerScope: MACHINE_COMPOSER_SCOPE, composerCustody: harness.createWorkflowAuthoringComposerCustody(updated.draftId),
            selectedBlockId: null, validation: harness.validateWorkflowEditorDraft(updated), onChange: () => {}, onSelect: () => {}, onCustomize: () => {},
            presentation: { editable: false },
        })));
        expect(rendered.getTextContent()).toContain('workflows.runWhen.ifFailure');
        expect(rendered.findByTestId('workflow-editor-next-run-when')?.props.onPress).toBeUndefined();
    } finally {
        // Unmount while the same platform is still selected so overlay cleanup
        // follows the lifecycle under which it was mounted.
        try {
            await screen?.unmount();
        } finally {
            if (platformOSDescriptor) Object.defineProperty(Platform, 'OS', platformOSDescriptor);
            else Reflect.deleteProperty(Platform, 'OS');
        }
    }
});

it('makes Notify me quiet using the Agent text result while preserving a custom condition', async () => {
    const harness = await loadHarness();
    const report = { kind: 'result' as const, producer: { blockId: 'inspect', scope: { kind: 'current' as const } }, path: [] };
    const custom = { kind: 'exists' as const, value: { kind: 'literal' as const, value: true } };
    const agent = { kind: 'step' as const, id: 'inspect', document: { text: 'Inspect', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } };
    const draft = buildDraft(harness, [agent, { kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: { message: report }, onlyWhen: custom }]);
    let updated = draft;
    const screen = await renderList(harness, { draft, onChange: next => { updated = next as typeof draft; } });
    const toggle = screen.findByTestId('workflow-editor-action-notify-only-reported');
    expect(toggle).not.toBeNull();
    expect(toggle?.props.value).toBe(false);
    await act(async () => { toggle?.props.onValueChange(true); });
    const quiet = { kind: 'compare', operator: 'neq', left: report, right: { kind: 'literal', value: '' } };
    expect(updated.blocks[1]).toMatchObject({ input: { message: report }, onlyWhen: { kind: 'all', conditions: [custom, quiet] } });
    expect(harness.validateWorkflowEditorDraft(updated).valid).toBe(true);
    await screen.unmount();

    const enabled = await renderList(harness, { draft: updated, onChange: next => { updated = next as typeof draft; } });
    expect(enabled.findByTestId('workflow-editor-action-notify-only-reported')?.props.value).toBe(true);
    await act(async () => { enabled.findByTestId('workflow-editor-action-notify-only-reported')?.props.onValueChange(false); });
    expect(updated.blocks[1]).toMatchObject({ onlyWhen: custom, input: { message: report } });
});

it('explains quiet Notify me prerequisites without inventing a report source', async () => {
    const harness = await loadHarness();
    const draft = buildDraft(harness, [
        { kind: 'step', id: 'inspect', document: { text: 'Inspect', references: [], attachments: [] }, input: [], result: { kind: 'json', schema: {} } },
        { kind: 'action', id: 'literal', actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Finished' } } },
        { kind: 'action', id: 'json', actionId: 'notifications.notify_me', input: { message: { kind: 'result', producer: { blockId: 'inspect', scope: { kind: 'current' } }, path: [] } } },
        { kind: 'action', id: 'forward', actionId: 'notifications.notify_me', input: { message: { kind: 'result', producer: { blockId: 'later', scope: { kind: 'current' } }, path: [] } } },
        { kind: 'step', id: 'later', document: { text: 'Later', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
    ]);
    const onChange = vi.fn();
    const screen = await renderList(harness, { draft, onChange });
    for (const id of ['literal', 'json', 'forward']) {
        const toggle = screen.findByTestId(`workflow-editor-action-${id}-only-reported`);
        expect(toggle, id).not.toBeNull();
        expect(toggle?.props.disabled).toBe(true);
        expect(toggle?.props.onValueChange).toBeUndefined();
    }
    expect(screen.getTextContent()).toContain('sessionWork.scheduled.notifyOnlyReportedNeedsResult');
    expect(onChange).not.toHaveBeenCalled();
});

it('removes a quiet-only Notify me condition and keeps the control read-only when the document is', async () => {
    const harness = await loadHarness();
    const report = { kind: 'result' as const, producer: { blockId: 'inspect', scope: { kind: 'current' as const } }, path: [] };
    const draft = buildDraft(harness, [
        { kind: 'step', id: 'inspect', document: { text: 'Inspect', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        { kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: { message: report }, onlyWhen: {
            kind: 'compare', operator: 'neq', left: report, right: { kind: 'literal', value: '' },
        } },
    ]);
    let updated = draft;
    const screen = await renderList(harness, { draft, onChange: next => { updated = next as typeof draft; } });
    await act(async () => { screen.findByTestId('workflow-editor-action-notify-only-reported')?.props.onValueChange(false); });
    expect(updated.blocks[1]).not.toHaveProperty('onlyWhen');
    expect(updated.blocks[1]).toMatchObject({ input: { message: report } });
    await screen.unmount();
    const readOnly = await renderList(harness, { draft, presentation: { editable: false } });
    const toggle = readOnly.findByTestId('workflow-editor-action-notify-only-reported');
    expect(toggle?.props.value).toBe(true);
    expect(toggle?.props.disabled).toBe(true);
    expect(toggle?.props.onValueChange).toBeUndefined();
});

it('keeps repair hints and source facts available while editing a heading', async () => {
    const harness = await loadHarness();
    const screen = await renderScreen(<harness.WorkflowBlockHeading ordinal={1} displayName="Inspect" sourceLabel="Plugin source"
        issue="Repair required" actions={[]} onSelect={() => {}} testID="heading" actionsTestID="heading-actions"
        nameEditor={{ value: 'Inspect', placeholder: 'Agent step', accessibilityLabel: 'Rename Inspect', onChangeText: () => {} }} />);
    expect(screen.findByTestId('heading')?.props.accessibilityHint).toBe('Repair required');
    expect(screen.getTextContent()).toContain('Plugin source');
});

it('edits authored step names through draft history and keeps readonly headings selectable', async () => {
    const harness = await loadHarness();
    const draft = buildDraft(harness, [{ kind: 'step', id: 'inspect', name: 'Inspect', document: { text: 'Read the diff', references: [], attachments: [] }, input: [], result: { kind: 'text' } }]);
    const onChange = vi.fn();
    const screen = await renderList(harness, { draft, onChange });
    const field = screen.findByTestId('workflow-editor-step-inspect-label')!;
    expect(field.props.value).toBe('Inspect');
    await act(async () => { field.props.onFocus(); field.props.onChangeText('  Inspect carefully  '); });
    expect(onChange.mock.calls.at(-1)?.[0].blocks[0].name).toBe('Inspect carefully');
    expect(onChange.mock.calls.at(-1)?.[1]).toBe('workflows.editor.history.renameStep');
    expect(onChange.mock.calls.at(-1)?.[2]).toBe(false);
    await act(async () => { field.props.onKeyPress({ nativeEvent: { key: 'Escape' }, preventDefault: () => {} }); });
    expect(onChange.mock.calls.at(-1)?.[0].blocks[0].name).toBe('Inspect');
    await screen.unmount();
    const onSelect = vi.fn();
    const reading = await renderList(harness, { draft, onChange, onSelect, presentation: { editable: false } });
    await reading.pressByTestIdAsync('workflow-editor-step-inspect-label');
    expect(onSelect).toHaveBeenCalledWith('inspect');
    expect(reading.getTextContent()).toContain('Inspect');
});

it('labels a lane rename separately from a step rename in document history', async () => {
    const harness = await loadHarness();
    const draft = buildDraft(harness, [{ kind: 'parallel', id: 'panel', failurePolicy: 'fail_stop',
        branches: [{ id: 'lane', name: 'Issues', blocks: [] }] }]);
    const onChange = vi.fn();
    const screen = await renderList(harness, { draft, onChange });
    const field = screen.findByTestId('workflow-editor-parallel-panel-branch-lane-label')!;
    await act(async () => { field.props.onChangeText('Changelog'); });
    expect(onChange.mock.calls.at(-1)?.[0].blocks[0].branches[0].name).toBe('Changelog');
    expect(onChange.mock.calls.at(-1)?.[1]).toBe('workflows.editor.history.renameLane');
});

it('renders a read-only document note through Text, never as a raw View child', async () => {
    const harness = await loadHarness();
    const note = 'Part of Happier';
    const screen = await renderList(harness, {
        draft: buildDraft(harness, []),
        presentation: { editable: false, note },
    });
    expect(screen.getTextContent()).toContain(note);
    const rawNotes = screen.root.findAll((node) => (node.type as unknown) === 'View'
        && node.children.some((child) => child === note));
    expect(rawNotes, 'React Native Views cannot render raw text').toHaveLength(0);
});

it('reads a step role by its display name and keeps a read-only step input on its footer line', async () => {
    const harness = await loadHarness();
    const screen = await renderList(harness, {
        draft: buildDraft(harness, [
            { kind: 'step', id: 'gather', document: { text: 'Gather', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
            { kind: 'step', id: 'check', document: { text: 'Check', references: [], attachments: [] },
                input: [{ kind: 'result', producer: { blockId: 'gather', scope: { kind: 'current' } }, path: [] }],
                execution: { engine: { role: 'second_opinion' } }, result: { kind: 'text' } },
        ]),
        presentation: { editable: false },
    });
    const composer = screen.root.findAll((node) => (node.type as unknown) === 'AgentInput')
        .find((node) => node.props.value === 'Check');
    // The built-in role's own name, never its id.
    expect(composer?.props.agentLabel).toBe('Second opinion');
    expect(composer?.props.engineLabel).toBe('Second opinion');
    // The input token sits on the step's one footer line, not a band of its own.
    const footer = screen.findHostByTestId('workflow-editor-step-check-footer');
    expect(footer?.findAll((node) => node.props?.testID === 'workflow-editor-step-check-input-0').length).toBeGreaterThan(0);
});

it('reads a compound condition as a lead and one line per arm, and leaves an empty Otherwise out of a reading document', async () => {
    const harness = await loadHarness();
    const screen = await renderList(harness, {
        draft: buildDraft(harness, [{ kind: 'if', id: 'gate',
            when: { kind: 'any', conditions: [
                { kind: 'exists', value: { kind: 'input', name: 'goal' } },
                { kind: 'exists', value: { kind: 'input', name: 'budget' } },
            ] },
            then: [{ kind: 'step', id: 'go', document: { text: 'Go', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
            otherwise: [] }]),
        presentation: { editable: false },
    });
    const summary = screen.findByTestId('workflow-editor-if-gate-sentence');
    // The heading line carries the compound's own words, not its arms run together.
    const textOf = (node: typeof summary): string => node === null || node === undefined ? ''
        : node.children.map((child) => typeof child === 'string' ? child : textOf(child)).join('');
    expect(textOf(summary)).toContain('workflows.page.inspector.conditionAny');
    expect(textOf(summary)).not.toContain('workflows.condition.exists');
    const arms = screen.findByTestId('workflow-editor-if-gate-summary-arms');
    expect(textOf(arms).split('workflows.condition.exists').length - 1).toBe(2);
    expect(screen.getTextContent()).not.toContain('workflows.editor.otherwise');
});

it('names a conditional container separately from its ordinal', async () => {
    const harness = await loadHarness();
    const screen = await renderList(harness, {
        draft: buildDraft(harness, [{ kind: 'if', id: 'condition',
            when: { kind: 'exists', value: { kind: 'literal', value: true } }, then: [], otherwise: [] }]),
        presentation: { editable: false },
    });
    expect(screen.findByTestId('workflow-editor-if-condition-label')?.props.accessibilityLabel)
        .toBe('workflows.editor.addIf');
});

it('duplicates a nested block with fresh identities and keeps its internal references inside the copy', async () => {
    const harness = await loadHarness();
    const draft = buildDraft(harness, [{ kind: 'parallel', id: 'group', failurePolicy: 'fail_stop', branches: [
        { id: 'branch', blocks: [
            { kind: 'step', id: 'producer', document: { text: 'Produce', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
            { kind: 'step', id: 'consumer', document: { text: 'Consume', references: [], attachments: [] },
                input: [{ kind: 'result', producer: { blockId: 'producer', scope: { kind: 'current' } }, path: [] }],
                execution: { conversation: { kind: 'from_step', producer: { blockId: 'producer', scope: { kind: 'current' } } },
                    workspace: { kind: 'from_step', producer: { blockId: 'producer', scope: { kind: 'current' } } } }, result: { kind: 'text' } },
        ] },
    ] }]);
    const changed = vi.fn();
    const selected = vi.fn();
    const screen = await renderList(harness, { draft, onChange: changed, onSelect: selected });
    await screen.pressByTestIdAsync('workflow-editor-parallel-group-actions');
    expect(screen.findByTestId('workflow-editor-parallel-group-actions-duplicate')).not.toBeNull();
    await screen.pressByTestIdAsync('workflow-editor-parallel-group-actions-duplicate');
    const next = changed.mock.calls.at(-1)?.[0] as typeof draft;
    expect(next.blocks).toHaveLength(2);
    expect(next.blocks[0]).toBe(draft.blocks[0]);
    const copy = next.blocks[1];
    if (copy?.kind !== 'parallel') throw new Error('Expected parallel copy');
    expect(copy.id).not.toBe('group');
    expect(copy.branches[0]?.id).not.toBe('branch');
    const [producer, consumer] = copy.branches[0]!.blocks;
    expect(producer?.id).not.toBe('producer');
    expect(consumer).toMatchObject({ input: [{ producer: { blockId: producer!.id } }],
        execution: { conversation: { kind: 'from_step', producer: { blockId: producer!.id } }, workspace: { kind: 'from_step', producer: { blockId: producer!.id } } } });
    expect(selected).toHaveBeenCalledWith(copy.id);
});

it('puts Step options in the step composer as one chip that names only what differs (07 S7; DESIGN-1 B1)', async () => {
    const harness = await loadHarness();
    const base = buildDraft(harness, [
        { kind: 'step', id: 'engine', document: { text: 'Engine', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        { kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' }, pauseForReview: true },
    ]);
    // An engine change is the engine chip's to show, never Step options' words.
    const draft = harness.setWorkflowStepExecutionField(base, 'engine', 'agentTarget', AGENT_TARGET);
    const opened = vi.fn();
    const element = React.createElement(harness.WorkflowBlockListEditor, {
        draft,
        list: { kind: 'root' },
        blocks: draft.blocks,
        depth: 0,
        composerScope: MACHINE_COMPOSER_SCOPE,
        composerCustody: harness.createWorkflowAuthoringComposerCustody(draft.draftId),
        selectedBlockId: null,
        validation: harness.validateWorkflowEditorDraft(draft),
        onChange: () => {},
        onSelect: () => {},
        onCustomize: opened,
    });
    const screen = await renderScreen(element);

    const composer = screen.findByTestId('composer:engine');
    const chip = composer?.findAll((node) => node.props?.testID === 'workflow-editor-step-engine-customize')[0];
    expect(chip, 'the Step options chip sits in the composer chip row').toBeDefined();
    // The native AgentInput engine chip owns that picker; there is no parallel extra chip.
    expect(composer?.findAll((node) => node.props?.testID === 'workflow-editor-step-engine-engine')).toHaveLength(0);
    expect(screen.findByTestId('workflow-editor-step-engine-inheritance')?.props.children).toBe('workflows.page.blocks.workflowDefaults');
    expect(screen.findByTestId('workflow-editor-step-review-inheritance')?.props.children).toBe('workflows.page.inspector.reviewsBeforeContinuing');
    expect(screen.getTextContent()).not.toContain('workflows.a11y.overridden');
    await screen.pressByTestIdAsync('workflow-editor-step-engine-customize');
    expect(opened).toHaveBeenCalledWith('engine', expect.anything());
    // At rest a text step's footer says nothing ("Returns text" is authoring machinery, DESIGN-5 M1).
    expect(screen.findHostByTestId('workflow-editor-step-engine-returns')).toBeNull();
    expect(screen.getTextContent()).not.toContain('workflows.input.label');
});

it('marks exactly the agent-returned block IDs, not the selected or neighbouring block', async () => {
    const harness = await loadHarness();
    const draft = buildDraft(harness, [
        { kind: 'step', id: 'first', document: { text: 'First', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        { kind: 'step', id: 'second', document: { text: 'Second', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        { kind: 'step', id: 'third', document: { text: 'Third', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
    ]);
    const screen = await renderList(harness, { draft, selectedBlockId: 'first', highlightedBlockIds: ['second'] });
    const highlights = screen.root.findAll((node) => typeof node.props.testID === 'string'
        && node.props.testID.startsWith('workflow-agent-change:'));
    expect(highlights.map((node) => node.props.testID)).toEqual(['workflow-agent-change:second']);
});

/**
 * A container's options are Step options content (04 §4.3, §5.2): the document
 * shows the container as a sentence, and its owner renders the option rows.
 */
async function renderContainerOptions(harness: Harness, options: Readonly<{
    draft: ReturnType<typeof buildDraft>;
    blockId: string;
    onChange?: (next: ReturnType<typeof buildDraft>) => void;
}>) {
    const block = harness.findWorkflowBlock(options.draft, options.blockId);
    if (block?.kind === 'loop') {
        return renderScreen(React.createElement(harness.WorkflowLoopOptions, {
            draft: options.draft, block, onChange: (next) => options.onChange?.(next as ReturnType<typeof buildDraft>), testIDPrefix: 'workflow-editor',
        }));
    }
    if (block?.kind === 'parallel') {
        return renderScreen(React.createElement(harness.WorkflowGroupOptions, {
            draft: options.draft, block, onChange: (next) => options.onChange?.(next as ReturnType<typeof buildDraft>), testIDPrefix: 'workflow-editor',
        }));
    }
    throw new Error(`No container options for ${options.blockId}`);
}

describe('workflow block list editor', () => {
    it('renders every authored step with a stable ordinal and its prompt', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'analyze', document: { text: 'Analyze', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
            { kind: 'step', id: 'implement', document: { text: 'Implement', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const screen = await renderList(harness, { draft });

        expect(screen.findByTestId('workflow-editor-step-analyze')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-step-implement')).not.toBeNull();
        expect(screen.findByProps({ testID: 'composer:implement' }).props.value).toBe('Implement');
    });

    /**
     * The block list is an ordered list a screen reader can count: every block
     * is a real item carrying its position in the set, its prompt field is named
     * for the step it belongs to on the input itself, and the heading that
     * selects the block through focus on its editable name.
     */
    it('exposes ordered list items, a step-named prompt input and an editable heading', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'analyze', document: { text: 'Analyze', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
            { kind: 'step', id: 'implement', document: { text: 'Implement', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const onSelect = vi.fn();
        const screen = await renderList(harness, { draft, onSelect });

        const items = screen.root.findAll((node) => (
            typeof node.type === 'string' && node.props.role === 'listitem'
        ));
        expect(items.map((item) => [item.props['aria-posinset'], item.props['aria-setsize']])).toEqual([
            [1, 2],
            [2, 2],
        ]);

        const implementContext = `workflows.a11y.stepContext:${JSON.stringify({ block: 'workflows.editor.addStep', position: 2, total: 2 })}`;
        expect(screen.findByProps({ testID: 'composer:implement' }).props.inputAccessibilityLabel)
            .toBe(implementContext);

        const heading = screen.findByTestId('workflow-editor-step-implement-label');
        expect(typeof heading?.props.onChangeText).toBe('function');
        expect(heading?.props.accessibilityLabel).toBe(implementContext);
        await act(async () => {
            heading?.props.onFocus();
        });
        expect(onSelect).toHaveBeenCalledWith('implement');
    });

    it('keeps portable references controlled by the workflow document and retires only deleted tokens', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [{
            kind: 'step',
            id: 'analyze',
            document: {
                text: 'Review @src/a.ts and @src/b.ts',
                references: [
                    { kind: 'happier.file', ref: 'file:src/a.ts', token: '@src/a.ts' },
                    { kind: 'happier.file', ref: 'file:src/b.ts', token: '@src/b.ts' },
                ],
                attachments: [],
            },
            input: [],
            result: { kind: 'text' },
        }]);
        const changes: ReturnType<typeof buildDraft>[] = [];
        const screen = await renderList(harness, { draft, onChange: (next) => changes.push(next as ReturnType<typeof buildDraft>) });

        await act(async () => {
            screen.findByProps({ testID: 'composer:analyze' }).props.onChangeText(
                'Review @src/b.ts',
            );
        });

        const step = changes.at(-1)?.blocks[0];
        expect(step?.kind).toBe('step');
        if (step?.kind === 'step') {
            expect(step.document.references).toEqual([
                { kind: 'happier.file', ref: 'file:src/b.ts', token: '@src/b.ts' },
            ]);
        }
    });

    it('renders the same document read-only with its note and per-step slots in fixed places', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'analyze', document: { text: 'Analyze', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
            { kind: 'step', id: 'implement', document: { text: 'Implement', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const changes: unknown[] = [];
        const screen = await renderList(harness, {
            draft,
            onChange: (next) => changes.push(next),
            presentation: {
                editable: false,
                note: React.createElement('Text', { testID: 'frozen-note' }, 'This run uses the version it started with.'),
                step: (blockId: string) => blockId === 'analyze' ? {
                    state: React.createElement('Text', { testID: 'slot-state' }, 'Completed'),
                    reviewedCard: React.createElement('View', { testID: 'slot-reviewed' }),
                    footer: React.createElement('Text', { testID: 'slot-footer' }, 'Open conversation'),
                } : null,
            },
        });

        // Nothing edits: no Add row or block menus. Step options stay readable.
        expect(screen.findHostByTestId('workflow-editor-add-root')).toBeNull();
        expect(screen.findHostByTestId('workflow-editor-step-analyze-actions')).toBeNull();
        expect(screen.findHostByTestId('workflow-editor-step-analyze-customize')).not.toBeNull();
        // The composer is the same one, rendered not editable.
        expect(screen.root.findAll((node) => (
            node.props?.editable === false && node.props?.custody !== undefined
        )).length).toBeGreaterThan(0);
        // The note sits above the first block; each slot sits in its block.
        const noteIndex = screen.getTextContent().indexOf('This run uses the version it started with.');
        expect(noteIndex).toBeGreaterThanOrEqual(0);
        expect(noteIndex).toBeLessThan(screen.getTextContent().indexOf('Completed'));
        const analyze = screen.findByTestId('workflow-editor-step-analyze');
        for (const slot of ['slot-state', 'slot-reviewed', 'slot-footer']) {
            expect(analyze?.findAll((node) => node.props?.testID === slot).length, slot).toBeGreaterThan(0);
        }
        // The footer fact ends the "Returns …" line (run-A_steps), not a row of its own.
        const returnsLine = screen.findHostByTestId('workflow-editor-step-analyze-footer');
        expect(returnsLine?.findAll((node) => node.props?.testID === 'slot-footer').length).toBeGreaterThan(0);
        const implement = screen.findByTestId('workflow-editor-step-implement');
        expect(implement?.findAll((node) => node.props?.testID === 'slot-state')).toHaveLength(0);
        expect(changes).toHaveLength(0);
    });

    it('offers the step kinds, then structure, and inserts an Action or a Wait for you as one change', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'analyze', document: { text: 'Analyze', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const changes: Array<ReturnType<typeof buildDraft>> = [];
        const screen = await renderList(harness, { draft, onChange: (next) => changes.push(next as ReturnType<typeof buildDraft>) });

        await chooseAdd(screen, 'workflow-editor-add-root', [
            'workflow-editor-add-root-action', 'workflow-editor-add-root-action:notifications.notify_me',
        ]);
        expect(changes.at(-1)?.blocks.at(-1)).toMatchObject({ kind: 'action', actionId: 'notifications.notify_me', input: {} });

        await chooseAdd(screen, 'workflow-editor-add-root', ['workflow-editor-add-root-wait']);
        expect(changes.at(-1)?.blocks.at(-1)).toMatchObject({ kind: 'wait', result: { kind: 'text' } });
    });

    it('renders every step kind the definition admits, with its fields, never as nothing', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Ship it' } } },
            { kind: 'workflow', id: 'review', workflowRef: 'builtin:review-and-converge', input: {} },
            { kind: 'wait', id: 'check', document: { text: 'Check the notes', references: [], attachments: [] }, result: { kind: 'text' } },
            { kind: 'action', id: 'unknown', actionId: 'acme.plugin.unknown_action', input: { target: { kind: 'literal', value: 'x' } } },
        ] as never);
        const changes: Array<ReturnType<typeof buildDraft>> = [];
        const screen = await renderList(harness, { draft, onChange: (next) => changes.push(next as ReturnType<typeof buildDraft>) });

        // Action: one row per declared field, bound or not.
        for (const id of ['action-notify', 'workflow-review', 'wait-check']) {
            const mark = screen.findHostByTestId(`workflow-editor-${id}-label-kind-mark`);
            expect(mark, id).not.toBeNull();
            expect(mark?.props.accessibilityElementsHidden).toBe(true);
        }
        for (const field of ['message', 'title', 'channels']) {
            expect(screen.findHostByTestId(`workflow-editor-action-notify-field-${field}`), field).not.toBeNull();
        }
        // An Action this client does not know keeps its block and its bound fields.
        expect(screen.findHostByTestId('workflow-editor-action-unknown')).not.toBeNull();
        expect(screen.findHostByTestId('workflow-editor-action-unknown-field-target')).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.page.blocks.actionUnavailable');
        // A nested workflow names the child and lists its declared inputs.
        expect(screen.findHostByTestId('workflow-editor-workflow-review')).not.toBeNull();
        expect(screen.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('workflow-editor-workflow-review-input-')).length).toBeGreaterThan(0);
        // A Wait for you is the same authoring composer, not a second editor.
        expect(screen.findByProps({ testID: 'composer:check' }).props.value).toBe('Check the notes');

        // Setting an unbound field binds it as a literal on that Action alone.
        await screen.pressByTestIdAsync('workflow-editor-action-notify-field-title-set');
        expect(changes.at(-1)?.blocks[0]).toMatchObject({
            kind: 'action',
            input: { message: { kind: 'literal', value: 'Ship it' }, title: { kind: 'literal', value: '' } },
        });
    });

    /**
     * 04 §5.3 E20: a review Action's engine field offers exactly what the
     * review-engine inventory returns for this Machine — never a static enum —
     * and a newly set multi-select starts as an empty selection, not text.
     */
    it('binds a review Action engine field through the inventory options source', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'action', id: 'review', actionId: 'review.start', input: {} },
        ] as never);
        const asked: Array<string | undefined> = [];
        const changes: Array<ReturnType<typeof buildDraft>> = [];
        const screen = await renderList(harness, {
            draft,
            onChange: (next) => changes.push(next as ReturnType<typeof buildDraft>),
            resolveActionFieldOptions: (field) => {
                asked.push(field.optionsSourceId);
                return field.optionsSourceId === 'review.engines.available'
                    ? [{ value: 'claude', label: 'Claude Code' }, { value: 'acme-reviewer', label: 'Acme reviewer' }]
                    : [];
            },
        });

        await screen.pressByTestIdAsync('workflow-editor-action-review-field-engineIds-set');
        expect(changes.at(-1)?.blocks[0]).toMatchObject({ input: { engineIds: { kind: 'literal', value: [] } } });
        await screen.unmount();

        // The bound field is edited on its selected step (DESIGN-6 N5: values read as values at rest).
        const bound = await renderList(harness, {
            draft: changes.at(-1)!,
            selectedBlockId: 'review',
            resolveActionFieldOptions: (field) => {
                asked.push(field.optionsSourceId);
                return field.optionsSourceId === 'review.engines.available' ? [{ value: 'acme-reviewer', label: 'Acme reviewer' }] : [];
            },
        });
        expect(asked).toContain('review.engines.available');
        expect(bound.getTextContent()).toContain('Acme reviewer');
    });

    /**
     * 04 §4.3: the between-block inserter opens the same Add menu bound to its
     * exact position, so the new block lands in that gap, not at the end; it
     * is visible on touch only while a block in its list is selected.
     */
    it('inserts a block into the gap it was opened from', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'a', document: { text: 'A', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
            { kind: 'step', id: 'b', document: { text: 'B', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const changes: Array<ReturnType<typeof buildDraft>> = [];
        const screen = await renderList(harness, { draft, onChange: (next) => changes.push(next as ReturnType<typeof buildDraft>) });
        // One inserter per gap, none after the last block (the end row adds there).
        expect(screen.findHostByTestId('workflow-editor-insert-after-a')).not.toBeNull();
        expect(screen.findHostByTestId('workflow-editor-insert-after-b')).toBeNull();
        const inserter = () => screen.findHostByTestId('workflow-editor-insert-after-a')!;
        const insetStyle = () => NativeStyleSheet.flatten(inserter().props.style({ pressed: false }));
        expect(insetStyle()?.opacity).toBe(0);
        await act(async () => { inserter().props.onHoverIn(); });
        expect(insetStyle()?.opacity ?? 1).toBeGreaterThan(0);
        await act(async () => { inserter().props.onHoverOut(); });
        expect(insetStyle()?.opacity).toBe(0);
        await act(async () => { inserter().props.onFocus({ target: { matches: () => true } }); });
        expect(insetStyle()?.opacity ?? 1).toBeGreaterThan(0);
        await act(async () => { inserter().props.onBlur(); });
        expect(insetStyle()?.opacity).toBe(0);

        await chooseAdd(screen, 'workflow-editor-insert-after-a', ['workflow-editor-insert-after-a-wait']);
        const ids = changes.at(-1)!.blocks.map((block) => block.kind);
        expect(ids).toEqual(['step', 'wait', 'step']);
        expect(changes.at(-1)!.blocks[2]?.id).toBe('b');
    });

    it('adds a block at the active scope and selects it without touching other scopes', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'analyze', document: { text: 'Analyze', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const changes: unknown[] = [];
        const selections: (string | null)[] = [];
        const screen = await renderList(harness, {
            draft,
            onChange: (next) => changes.push(next),
            onSelect: (id) => selections.push(id),
        });

        await chooseAdd(screen, 'workflow-editor-add-root', ['workflow-editor-add-root-step']);

        expect(changes).toHaveLength(1);
        const next = changes[0] as ReturnType<typeof buildDraft>;
        expect(next.blocks.map((block) => block.id)).toEqual(['analyze', expect.any(String)]);
        expect(next.blocks[1]!.id).not.toBe('analyze');
        expect(selections).toEqual([next.blocks[1]!.id]);
        // "Analyze → Implement" without an output schema: the step added after
        // another step reads that step's result until the author says otherwise.
        expect(next.blocks[1]!.kind === 'step' ? next.blocks[1]!.input : null).toEqual([
            { kind: 'result', producer: { blockId: 'analyze', scope: { kind: 'current' } }, path: [] },
        ]);
    });

    it('supplies no input default when the previous block is not one unambiguous producer', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            {
                kind: 'parallel',
                id: 'fan-out',
                failurePolicy: 'fail_stop',
                branches: [
                    { id: 'branch-1', blocks: [] },
                    { id: 'branch-2', blocks: [] },
                ],
            },
        ]);
        const changes: unknown[] = [];
        const screen = await renderList(harness, { draft, onChange: (next) => changes.push(next) });

        await chooseAdd(screen, 'workflow-editor-add-root', ['workflow-editor-add-root-step']);

        const next = changes[0] as ReturnType<typeof buildDraft>;
        const added = next.blocks[1]!;
        expect(added.kind === 'step' ? added.input : null).toEqual([]);
    });

    it('reorders through Move up without changing any block id', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'a', document: { text: 'A', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
            { kind: 'step', id: 'b', document: { text: 'B', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const changes: unknown[] = [];
        const screen = await renderList(harness, { draft, onChange: (next) => changes.push(next) });

        await screen.pressByTestIdAsync('workflow-editor-step-b-actions');
        await screen.pressByTestIdAsync('workflow-editor-step-b-actions-moveUp');

        const next = changes[0] as ReturnType<typeof buildDraft>;
        expect(next.blocks.map((block) => block.id)).toEqual(['b', 'a']);
    });

    it('offers Move up only where it can make progress', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'a', document: { text: 'A', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
            { kind: 'step', id: 'b', document: { text: 'B', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const screen = await renderList(harness, { draft });

        await screen.pressByTestIdAsync('workflow-editor-step-a-actions');
        expect(screen.findByTestId('workflow-editor-step-a-actions-moveUp')).toBeNull();
        expect(screen.findByTestId('workflow-editor-step-a-actions-moveDown')).not.toBeNull();
    });

    it('moves selection to a surviving control before removing a block', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'a', document: { text: 'A', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
            { kind: 'step', id: 'b', document: { text: 'B', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const changes: unknown[] = [];
        const selections: (string | null)[] = [];
        const screen = await renderList(harness, {
            draft,
            onChange: (next) => changes.push(next),
            onSelect: (id) => selections.push(id),
        });

        await screen.pressByTestIdAsync('workflow-editor-step-a-actions');
        await screen.pressByTestIdAsync('workflow-editor-step-a-actions-remove');

        expect(selections).toEqual(['b']);
        expect((changes[0] as ReturnType<typeof buildDraft>).blocks.map((block) => block.id)).toEqual(['b']);
    });

    it('edits a prompt through the controlled owner rather than local state', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'a', document: { text: 'A', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const changes: unknown[] = [];
        const screen = await renderList(harness, { draft, onChange: (next) => changes.push(next) });

        await screen.changeTextByTestId('composer:a', 'Analyze the repository');
        const next = changes[0] as ReturnType<typeof buildDraft>;
        expect((next.blocks[0] as { document: { text: string } }).document.text).toBe('Analyze the repository');
    });

    it('shows a parallel group with its authored policy and says No workflow limit when concurrency is omitted', async () => {
        const harness = await loadHarness();
        const parallel = harness.createWorkflowBlock('parallel', new Set<string>());
        const draft = buildDraft(harness, [parallel]);
        const screen = await renderList(harness, { draft });

        expect(screen.findByTestId(`workflow-editor-parallel-${parallel.id}`)).not.toBeNull();
        // The document reads the group as one sentence that opens its options.
        expect(screen.getTextContent()).toContain('workflows.failurePolicy.failStop');
        expect(screen.findByTestId(`workflow-editor-parallel-${parallel.id}-failure-policy:fail_stop`)).toBeNull();
        await screen.unmount();

        const options = await renderContainerOptions(harness, { draft, blockId: parallel.id });
        expect(options.findByTestId(`workflow-editor-parallel-${parallel.id}-failure-policy:fail_stop`)).not.toBeNull();
        expect(options.findByTestId(`workflow-editor-parallel-${parallel.id}-max-concurrent-omitted`)).not.toBeNull();
    });

    it('renders each parallel branch as its own nested block list', async () => {
        const harness = await loadHarness();
        const parallel = harness.createWorkflowBlock('parallel', new Set<string>());
        if (parallel.kind !== 'parallel') throw new Error('unreachable');
        const draft = buildDraft(harness, [parallel]);
        const screen = await renderList(harness, { draft });

        for (const branch of parallel.branches) {
            for (const block of branch.blocks) {
                expect(screen.findByTestId(`workflow-editor-step-${block.id}`)).not.toBeNull();
            }
        }
        expect(screen.findAllByTestId('workflow-editor-list-parallelBranch').length).toBe(parallel.branches.length);
    });

    it('adds an Otherwise from the If\'s own menu and draws no empty Otherwise lane (lab E1; DESIGN-5 N12)', async () => {
        const harness = await loadHarness();
        const conditional = harness.createWorkflowBlock('if', new Set<string>());
        if (conditional.kind !== 'if') throw new Error('unreachable');
        const draft = buildDraft(harness, [conditional]);
        const changes: ReturnType<typeof buildDraft>[] = [];
        const screen = await renderList(harness, {
            draft,
            onChange: (next) => changes.push(next as ReturnType<typeof buildDraft>),
        });

        // No always-visible "+" for an empty Otherwise, so it can never stack on the gap's own inserter.
        expect(screen.findHostByTestId('workflow-editor-add-ifOtherwise')).toBeNull();
        expect(screen.findHostByTestId(`workflow-editor-if-${conditional.id}-otherwise-label`)).toBeNull();
        await screen.pressByTestIdAsync(`workflow-editor-if-${conditional.id}-actions`);
        await screen.pressByTestIdAsync(`workflow-editor-if-${conditional.id}-actions-addOtherwise`);

        const next = changes[0]!;
        expect(next.blocks[0]).toMatchObject({
            kind: 'if',
            otherwise: [{ kind: 'step', id: expect.any(String) }],
        });
    });

    it('reveals the parallel-items concurrency field only in parallel mode', async () => {
        const harness = await loadHarness();
        const loop = harness.createWorkflowBlock('loop', new Set<string>());
        const withItems = harness.updateWorkflowBlock(
            buildDraft(harness, [loop]),
            loop.id,
            (block) => (block.kind === 'loop'
                ? {
                    ...block,
                    repetition: {
                        kind: 'items',
                        items: { kind: 'literal', value: [] },
                        execution: 'sequential',
                        failurePolicy: 'fail_stop',
                    },
                }
                : block),
        );

        const sequential = await renderContainerOptions(harness, { draft: withItems, blockId: loop.id });
        expect(sequential.findByTestId(`workflow-editor-loop-${loop.id}-max-concurrent`)).toBeNull();
        await sequential.unmount();

        const asParallel = harness.updateWorkflowBlock(withItems, loop.id, (block) => (
            block.kind === 'loop' && block.repetition.kind === 'items'
                ? { ...block, repetition: { ...block.repetition, execution: 'parallel' } }
                : block
        ));
        const parallel = await renderContainerOptions(harness, { draft: asParallel, blockId: loop.id });
        expect(parallel.findByTestId(`workflow-editor-loop-${loop.id}-max-concurrent`)).not.toBeNull();
    });

    it('drops an inert concurrency value when the author returns items to sequential', async () => {
        const harness = await loadHarness();
        const loop = harness.createWorkflowBlock('loop', new Set<string>());
        const draft = harness.updateWorkflowBlock(
            buildDraft(harness, [loop]),
            loop.id,
            (block) => (block.kind === 'loop'
                ? {
                    ...block,
                    repetition: {
                        kind: 'items',
                        items: { kind: 'literal', value: [] },
                        execution: 'parallel',
                        failurePolicy: 'collect_outcomes',
                        maxConcurrent: 4,
                    },
                }
                : block),
        );
        const changes: unknown[] = [];
        const screen = await renderContainerOptions(harness, { draft, blockId: loop.id, onChange: (next) => changes.push(next) });

        await screen.pressByTestIdAsync(`workflow-editor-loop-${loop.id}-items:sequential`);
        const next = changes[0] as ReturnType<typeof buildDraft>;
        const repetition = (next.blocks[0] as { repetition: Record<string, unknown> }).repetition;
        expect(repetition.execution).toBe('sequential');
        expect(repetition).not.toHaveProperty('maxConcurrent');
        expect(repetition.failurePolicy).toBe('collect_outcomes');
    });

    it('assigns a globally unique evaluator step id when multiple loops switch to agent evaluation', async () => {
        const harness = await loadHarness();
        const firstLoop = harness.createWorkflowBlock('loop', new Set<string>());
        const takenAfterFirst = new Set(harness.walkWorkflowBlocks([firstLoop]).map((block) => block.id));
        const secondLoop = harness.createWorkflowBlock('loop', takenAfterFirst);
        if (firstLoop.kind !== 'loop' || secondLoop.kind !== 'loop') throw new Error('unreachable');

        const firstChanges: ReturnType<typeof buildDraft>[] = [];
        const initial = buildDraft(harness, [firstLoop, secondLoop]);
        const firstScreen = await renderContainerOptions(harness, {
            draft: initial,
            blockId: firstLoop.id,
            onChange: (next) => firstChanges.push(next),
        });
        await firstScreen.pressByTestIdAsync(`workflow-editor-loop-${firstLoop.id}-mode:evaluate`);
        await firstScreen.unmount();

        const afterFirst = firstChanges[0]!;
        const secondChanges: ReturnType<typeof buildDraft>[] = [];
        const secondScreen = await renderContainerOptions(harness, {
            draft: afterFirst,
            blockId: secondLoop.id,
            onChange: (next) => secondChanges.push(next),
        });
        await secondScreen.pressByTestIdAsync(`workflow-editor-loop-${secondLoop.id}-mode:evaluate`);

        const ids = harness.walkWorkflowBlocks(secondChanges[0]!.blocks).map((block) => block.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('shows a blocking validation issue on the exact step it belongs to', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'a', document: { text: 'A', references: [], attachments: [] }, input: [{ kind: 'result', producer: { blockId: 'ghost', scope: { kind: 'current' } }, path: [] }], result: { kind: 'text' } },
            { kind: 'step', id: 'b', document: { text: 'B', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const screen = await renderList(harness, { draft });

        expect(screen.findByTestId('workflow-editor-step-a-issue')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-step-b-issue')).toBeNull();
    });

    it('labels the per-block overflow trigger as more actions, not as Add', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'analyze', document: { text: 'Analyze', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const screen = await renderList(harness, { draft });

        const trigger = screen.findByTestId('workflow-editor-step-analyze-actions');
        // Announcing "Add a block to this workflow" on the overflow menu told
        // every screen-reader user the wrong thing about what pressing it does.
        expect(trigger?.props.accessibilityLabel).toBe('common.moreActions');
        expect(trigger?.props.accessibilityHint).toBe('workflows.editor.addStep');
    });

    it('reports a removal so the editor can offer an in-place Undo', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'analyze', document: { text: 'Analyze', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
            { kind: 'step', id: 'implement', document: { text: 'Implement', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const removals: unknown[] = [];
        const element = React.createElement(harness.WorkflowBlockListEditor, {
            draft,
            list: { kind: 'root' },
            blocks: draft.blocks,
            depth: 0,
            composerScope: MACHINE_COMPOSER_SCOPE,
            composerCustody: harness.createWorkflowAuthoringComposerCustody(draft.draftId),
            selectedBlockId: null,
            validation: harness.validateWorkflowEditorDraft(draft),
            onChange: () => {},
            onSelect: () => {},
            onCustomize: () => {},
            onBlockRemoved: (removal: unknown) => removals.push(removal),
        } as never);
        const screen = await renderScreen(element);

        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions');
        await screen.pressByTestIdAsync('workflow-editor-step-analyze-actions-remove');
        await act(async () => {});

        expect(removals).toEqual([{
            list: { kind: 'root' },
            index: 0,
            block: draft.blocks[0],
        }]);
    });

    it('restores a removed block at its original position through the draft owner', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'analyze', document: { text: 'Analyze', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
            { kind: 'step', id: 'implement', document: { text: 'Implement', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ]);
        const removal = harness.removeWorkflowBlock(draft, 'analyze');
        expect(removal.removal).toEqual({ list: { kind: 'root' }, index: 0, block: draft.blocks[0] });

        const restored = harness.restoreWorkflowBlock(removal.draft, removal.removal!);
        expect(restored.blocks.map((block) => block.id)).toEqual(['analyze', 'implement']);
    });

    /**
     * An authored number is the exact text's meaning or nothing. "0", "1.5",
     * "1x" and "-2" are recorded as the unresolved values the canonical
     * validator rejects — never read as a limit of 1, as no limit, or dropped —
     * while the exact text stays on screen; clearing an optional field is the
     * precise "no workflow limit" omission.
     */
    it('records unresolved concurrency text for the validator instead of coercing or dropping it', async () => {
        const harness = await loadHarness();
        const parallel = harness.createWorkflowBlock('parallel', new Set<string>());
        if (parallel.kind !== 'parallel') throw new Error('unreachable');
        // Authored branch prompts, so the validator reaches the concurrency
        // field instead of stopping at the strict schema's empty-prompt parse.
        let draft = buildDraft(harness, [{
            ...parallel,
            maxConcurrent: 4,
            branches: parallel.branches.map((branch) => ({
                ...branch,
                blocks: branch.blocks.map((block) => (block.kind === 'step'
                    ? { ...block, document: { ...block.document, text: 'Review' } }
                    : block)),
            })),
        }]);
        // The group's options, over the same controlled draft owner.
        function Controlled(): React.ReactElement {
            const [current, setCurrent] = React.useState(draft);
            draft = current;
            const block = current.blocks[0];
            if (block?.kind !== 'parallel') throw new Error('unreachable');
            return React.createElement(harness.WorkflowGroupOptions, {
                draft: current,
                block,
                onChange: (next) => setCurrent(next as typeof current),
                testIDPrefix: 'workflow-editor',
            });
        }
        const screen = await renderScreen(React.createElement(Controlled));
        const fieldId = `workflow-editor-parallel-${parallel.id}-max-concurrent`;
        const readMax = () => (draft.blocks[0] as { maxConcurrent?: number }).maxConcurrent;

        for (const [text, expected] of [['0', 0], ['1.5', 1.5], ['-2', -2]] as const) {
            await act(async () => { screen.changeTextByTestId(fieldId, text); });
            expect(readMax(), text).toBe(expected);
            expect(screen.findByTestId(fieldId)?.props.value, text).toBe(text);
            expect(screen.findByTestId(`${fieldId}-error`), text).not.toBeNull();
            expect(harness.validateWorkflowEditorDraft(draft).valid, text).toBe(false);
        }
        await act(async () => { screen.changeTextByTestId(fieldId, '1x'); });
        expect(Number.isNaN(readMax())).toBe(true);
        expect(screen.findByTestId(fieldId)?.props.value).toBe('1x');
        expect(screen.findByTestId(`${fieldId}-error`)?.props.accessibilityRole).toBe('alert');

        await act(async () => { screen.changeTextByTestId(fieldId, '3'); });
        expect(readMax()).toBe(3);
        expect(screen.findByTestId(`${fieldId}-error`)).toBeNull();

        await act(async () => { screen.changeTextByTestId(fieldId, ''); });
        expect(draft.blocks[0]).not.toHaveProperty('maxConcurrent');
        expect(screen.findByTestId(`${fieldId}-omitted`)).not.toBeNull();
        expect(harness.validateWorkflowEditorDraft(draft).valid).toBe(true);
    });

    it('keeps a cleared required round guard unresolved rather than silently keeping the old value', async () => {
        const harness = await loadHarness();
        const loop = harness.createWorkflowBlock('loop', new Set<string>());
        const draft = harness.updateWorkflowBlock(buildDraft(harness, [loop]), loop.id, (block) => (
            block.kind === 'loop'
                ? { ...block, repetition: { kind: 'until', maxIterations: 3, stopWhen: { kind: 'exists', value: { kind: 'literal', value: true } } } }
                : block
        ));
        const changes: ReturnType<typeof buildDraft>[] = [];
        const screen = await renderContainerOptions(harness, { draft, blockId: loop.id, onChange: (next) => changes.push(next) });

        await act(async () => { screen.changeTextByTestId(`workflow-editor-loop-${loop.id}-max-iterations`, ''); });
        const cleared = changes.at(-1)!.blocks[0] as { repetition: { maxIterations: number } };
        expect(Number.isNaN(cleared.repetition.maxIterations)).toBe(true);
        expect(harness.validateWorkflowEditorDraft(changes.at(-1)!).issues.map((issue) => issue.code))
            .toContain('invalid_repetition');
    });

    /**
     * Item and iteration facts are authorable by their canonical field, and are
     * offered only where the validator accepts them: the current item inside a
     * for-each loop, round facts inside any loop, neither at the root.
     */
    it('offers item and iteration reference fields only inside the loops that provide them', async () => {
        const harness = await loadHarness();
        const loop = harness.createWorkflowBlock('loop', new Set<string>());
        if (loop.kind !== 'loop') throw new Error('unreachable');
        const inside = loop.body[0]!.id;
        const itemsLoop = harness.updateWorkflowBlock(
            buildDraft(harness, [
                { kind: 'step', id: 'root-step', document: { text: 'Root', references: [], attachments: [] }, input: [{ kind: 'literal', value: '' }], result: { kind: 'text' } },
                loop,
            ]),
            loop.id,
            (block) => (block.kind === 'loop'
                ? { ...block, repetition: { kind: 'items', items: { kind: 'literal', value: ['a'] }, execution: 'sequential', failurePolicy: 'fail_stop' } }
                : block),
        );
        // The body prompt is authored so the validator reaches the reference
        // scope instead of stopping at the strict schema's empty-prompt parse.
        const withInput = harness.updateWorkflowBlock(itemsLoop, inside, (block) => (
            block.kind === 'step'
                ? {
                    ...block,
                    document: { ...block.document, text: 'Inspect the current item' },
                    input: [{ kind: 'literal', value: '' }],
                }
                : block
        ));
        const changes: ReturnType<typeof buildDraft>[] = [];
        const screen = await renderList(harness, { draft: withInput, onChange: (next) => changes.push(next as ReturnType<typeof buildDraft>) });

        // The source select offers exactly the kinds valid where the step sits.
        const sourceKinds = (stepId: string) => {
            const select = screen.findAll((node) => node.props?.testID === `workflow-editor-step-${stepId}-input-0-kind`
                && typeof node.props?.onSelect === 'function')[0];
            if (select === undefined) throw new Error(`No source select for ${stepId}`);
            return select as unknown as { props: { items: ReadonlyArray<{ id: string }>; onSelect: (id: string) => void } };
        };
        // The root step is outside every loop: no item or round facts.
        expect(sourceKinds('root-step').props.items.map((item) => item.id)).not.toContain('item');
        expect(sourceKinds('root-step').props.items.map((item) => item.id)).not.toContain('iteration');
        // The body step of a for-each loop can author both.
        expect(sourceKinds(inside).props.items.map((item) => item.id)).toEqual(expect.arrayContaining(['item', 'iteration']));
        await act(async () => { sourceKinds(inside).props.onSelect('item'); });
        const readInput = () => harness.findWorkflowBlock(changes.at(-1)!, inside) as { input: unknown[] };
        expect(readInput().input[0]).toEqual({ kind: 'item', field: 'value' });

        // Rerender with the authored reference to reach its field choices.
        await screen.unmount();
        const authored = harness.updateWorkflowBlock(withInput, inside, (block) => (
            block.kind === 'step' ? { ...block, input: [{ kind: 'iteration', field: 'index' }] } : block
        ));
        const fields = await renderList(harness, { draft: authored, onChange: (next) => changes.push(next as ReturnType<typeof buildDraft>) });
        for (const field of ['index', 'position', 'count', 'stopReason']) {
            expect(fields.findByTestId(`workflow-editor-step-${inside}-input-0-iteration-field-${field}`), field).not.toBeNull();
        }
        await fields.pressByTestIdAsync(`workflow-editor-step-${inside}-input-0-iteration-field-stopReason`);
        expect(readInput().input[0]).toEqual({ kind: 'iteration', field: 'stopReason' });
        expect(harness.validateWorkflowEditorDraft(changes.at(-1)!).valid).toBe(true);
    });

    it('keeps an out-of-scope item reference visible for repair while the validator names it', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'step', id: 'root-step', document: { text: 'Root', references: [], attachments: [] }, input: [{ kind: 'item', field: 'count' }], result: { kind: 'text' } },
        ]);
        const screen = await renderList(harness, { draft });
        // A value choice announces checked (D14A radio semantics, owned by the data editor).
        expect(screen.findByTestId('workflow-editor-step-root-step-input-0-item-field-count')?.props.accessibilityState)
            .toMatchObject({ checked: true });
        const validation = harness.validateWorkflowEditorDraft(draft);
        expect(validation.issues.map((issue) => issue.code), JSON.stringify(validation.issues))
            .toContain('invalid_reference_scope');
    });
});

/**
 * DESIGN-4 (lab `editor-E1`, `editor-S6`): the document's anatomy — the nested workflow as the
 * Action card, containers with their kind mark, lanes on the rail and their actions in `⋯`, one
 * Add per document, literals as words, hidden inserters under a precise pointer, and issues named.
 */
describe('document anatomy (DESIGN-4)', () => {
    const step = (id: string, text: string) => ({ kind: 'step' as const, id, document: { text, references: [], attachments: [] }, input: [], result: { kind: 'text' as const } });

    it('draws Run a workflow as the Action card: its child, Open, label/value rows and no raw value forms (B1)', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [{ kind: 'workflow', id: 'review', name: 'Review the release', workflowRef: 'builtin:review-and-converge',
            input: { focus: { kind: 'literal', value: 'Read the changelog' } } }] as never);
        const changes: Array<ReturnType<typeof buildDraft>> = [];
        const screen = await renderList(harness, { draft, onChange: (next) => changes.push(next as ReturnType<typeof buildDraft>) });

        const card = screen.findByTestId('workflow-editor-workflow-review-card');
        expect(card).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-workflow-review-card-title')?.props.children).toBe('workflows.builtins.reviewAndConverge.title');
        await screen.pressByTestIdAsync('workflow-editor-workflow-review-open');
        expect(routerMock.spies.push).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent('builtin:review-and-converge')));
        // An unset input is "+ Set" (or its default), never an empty literal editor with a source select.
        expect(screen.findByTestId('workflow-editor-workflow-review-input-engines-set')).not.toBeNull();
        expect(screen.findHostByTestId('workflow-editor-workflow-review-input-engines-input-0-kind-trigger')).toBeNull();
        expect(screen.findHostByTestId('workflow-editor-workflow-review-input-maxRounds-input-0-kind-trigger')).toBeNull();
        // A declared default reads as the value the child will use, named by the built-in's own label.
        const rounds = screen.findByTestId('workflow-editor-workflow-review-input-maxRounds');
        expect(JSON.stringify(rounds?.findAll((node) => typeof node.props?.children === 'string').map((node) => node.props.children))).toContain('3');
        // Pressing the default binds it, ready to edit.
        await screen.pressByTestIdAsync('workflow-editor-workflow-review-input-maxRounds-set');
        expect(changes.at(-1)?.blocks[0]).toMatchObject({ input: { maxRounds: { kind: 'literal', value: 3 } } });
        await screen.unmount();

        // Reading, an optional input nobody set and without a default is left out.
        const reading = await renderList(harness, { draft, presentation: { editable: false } });
        expect(reading.findHostByTestId('workflow-editor-workflow-review-input-diffFingerprint')).toBeNull();
        // A field nobody set reads as nothing, required or not: a read-only built-in never says "Not set".
        expect(reading.findHostByTestId('workflow-editor-workflow-review-input-engines')).toBeNull();
        expect(reading.findHostByTestId('workflow-editor-workflow-review-input-maxRounds')).not.toBeNull();
        // A set literal reads as the value itself, without quotes (DESIGN-6 N5).
        expect(reading.getTextContent()).toContain('Read the changelog');
        expect(reading.getTextContent()).not.toContain('“Read the changelog”');
    });

    it('marks every container kind and keeps lane actions in the lane menu, never a destructive word at rest (M1)', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'parallel', id: 'panel', name: 'Review in parallel', failurePolicy: 'fail_stop', branches: [
                { id: 'one', blocks: [step('a', 'Review correctness')] },
                { id: 'two', blocks: [step('b', 'Review tests')] },
            ] },
            { kind: 'loop', id: 'repair', name: 'Repair until it passes', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } }, body: [step('c', 'Fix')] },
            { kind: 'if', id: 'bug', name: 'If this is a bug', when: { kind: 'exists', value: { kind: 'item', field: 'value' } }, then: [step('d', 'Fix the bug')], otherwise: [] },
        ] as never);
        const changes: Array<ReturnType<typeof buildDraft>> = [];
        const screen = await renderList(harness, { draft, onChange: (next) => changes.push(next as ReturnType<typeof buildDraft>) });

        for (const id of ['parallel-panel', 'loop-repair', 'if-bug']) {
            expect(screen.findHostByTestId(`workflow-editor-${id}-label-kind-mark`), id).not.toBeNull();
        }
        // Lanes are named on the rail; Remove is in each lane's menu, not a word at rest.
        expect(screen.findHostByTestId('workflow-editor-parallel-panel-branch-one-label')?.props.placeholder).toBe('workflows.page.inspector.lane:{"position":1}');
        expect(screen.findByTestId('workflow-editor-parallel-panel-branch-one-remove')).toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-parallel-panel-branch-one-actions');
        await screen.pressByTestIdAsync('workflow-editor-parallel-panel-branch-one-actions-remove');
        expect(changes.at(-1)?.blocks[0]).toMatchObject({ branches: [{ id: 'two' }] });
        // Add a lane lives in the group's own menu.
        expect(screen.findByTestId('workflow-editor-parallel-panel-add-branch')).toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-parallel-panel-actions');
        await screen.pressByTestIdAsync('workflow-editor-parallel-panel-actions-addBranch');
        const grown = changes.at(-1)?.blocks[0];
        expect(grown?.kind === 'parallel' ? grown.branches : []).toHaveLength(3);
        // A literal reads as the value itself: "Repeat 2 times", no reference token.
        const sentence = screen.findByTestId('workflow-editor-loop-repair-sentence');
        const tokens = sentence?.findAll((node) => typeof node.props?.children === 'string' && node.props.children.startsWith('↵')) ?? [];
        expect(tokens).toHaveLength(0);
        // The If reads its condition with its reference as a token.
        expect(screen.findByTestId('workflow-editor-if-bug-sentence')?.findAll((node) => typeof node.props?.children === 'string'
            && node.props.children.startsWith('↵')).length).toBeGreaterThan(0);
    });

    it('ends a nested list in its gap inserter, not a second bordered Add, and keeps an empty lane addable (M1)', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'loop', id: 'repair', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } }, body: [step('c', 'Fix')] },
            step('after', 'Report'),
        ] as never);
        const screen = await renderList(harness, { draft });
        const loopEnd = screen.findHostByTestId('workflow-editor-add-loopBody');
        expect(loopEnd).not.toBeNull();
        // The loop body's last gap is the hidden inserter; only the root keeps its "+ Add" row.
        expect(NativeStyleSheet.flatten(loopEnd!.props.style({ pressed: false }))?.opacity).toBe(0);
        // One "+ Add" in the whole document: the root's.
        expect(screen.root.findAll((node) => (node.type as unknown) === 'Text' && node.children.includes('workflows.editor.add'))).toHaveLength(1);
    });

    it('keeps inserters hidden while a block is selected under a precise pointer (P2)', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [step('a', 'A'), step('b', 'B')]);
        const screen = await renderList(harness, { draft, selectedBlockId: 'a' });
        const inserter = screen.findHostByTestId('workflow-editor-insert-after-a')!;
        expect(NativeStyleSheet.flatten(inserter.props.style({ pressed: false }))?.opacity).toBe(0);
        // The selected block says so on its ordinal instead.
        expect(NativeStyleSheet.flatten(screen.findHostByTestId('workflow-editor-step-a-label-ordinal')?.props.style)?.backgroundColor)
            .not.toBe(NativeStyleSheet.flatten(screen.findHostByTestId('workflow-editor-step-b-label-ordinal')?.props.style)?.backgroundColor);
    });

    it('gives a Wait for you the dictation composer and names what its empty prompt needs (P1, P3)', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [{ kind: 'wait', id: 'check', name: 'Check the notes', document: { text: '', references: [], attachments: [] }, result: { kind: 'text' } }] as never);
        const screen = await renderList(harness, { draft });
        expect(screen.findByProps({ testID: 'composer:check' }).props.voiceAffordance).toBe('dictation');
        // A Wait for you is a question to the person, so its empty prompt says so (DESIGN-5 P3).
        expect(screen.findByTestId('workflow-editor-wait-check-issue')?.props.children).toBe('workflows.issue.emptyWaitPrompt');
    });

    it('reads machine conditions as sentences: the first round and a run of the same verdict (M4)', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [{ kind: 'loop', id: 'turns', name: 'Keep going', body: [
            { ...step('continue', 'Keep going'), onlyWhen: { kind: 'compare', operator: 'gt', left: { kind: 'iteration', field: 'index' }, right: { kind: 'literal', value: 0 } } },
            step('check', 'Check'),
        ], repetition: { kind: 'until', maxIterations: 3, stopWhen: { kind: 'compare', operator: 'gte',
            left: { kind: 'loop_trailing_count', producer: { blockId: 'check', scope: { kind: 'current' } }, path: ['verdict'], equals: 'no_progress' },
            right: { kind: 'literal', value: 3 } } } }] as never);
        const screen = await renderList(harness, { draft, presentation: { editable: false } });
        const text = screen.getTextContent();
        expect(text).toContain('workflows.condition.notFirstRound');
        expect(text).not.toContain('workflows.input.iterationField.index');
        expect(text).toContain('workflows.condition.trailingCountAtLeast');
        // A verdict is a word in the sentence, not a quoted string (DESIGN-7 M4).
        expect(text).toContain('no progress');
        expect(text).not.toContain('“no progress”');
    });

    it('reads how a loop ended, and a result field as its step and field, never as wire paths (M4)', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'loop', id: 'rounds', name: 'Review until it converges', body: [step('check', 'Check')],
                repetition: { kind: 'until', maxIterations: 3, stopWhen: { kind: 'compare', operator: 'eq',
                    left: { kind: 'result', producer: { blockId: 'check', scope: { kind: 'current' } }, path: ['verdict'] }, right: { kind: 'literal', value: 'converged' } } } },
            { kind: 'if', id: 'exhausted', name: 'If the review did not converge', when: { kind: 'compare', operator: 'eq',
                left: { kind: 'result', producer: { blockId: 'rounds', scope: { kind: 'current' } }, path: ['outcome', 'kind'] }, right: { kind: 'literal', value: 'exhausted' } },
                then: [step('tell', 'Tell me')], otherwise: [] },
            { kind: 'if', id: 'met', name: 'If the goal is met', when: { kind: 'compare', operator: 'eq',
                left: { kind: 'result', producer: { blockId: 'rounds', scope: { kind: 'current' } }, path: ['outcome'] }, right: { kind: 'literal', value: { kind: 'stop_condition', arm: 0 } } },
                then: [step('done', 'Done')], otherwise: [] },
        ] as never);
        const screen = await renderList(harness, { draft, presentation: { editable: false } });
        const text = screen.getTextContent();
        expect(text).toContain('workflows.condition.loopRanOutOfRounds');
        // The loop's one stop condition reads as itself (DESIGN-5 M4).
        expect(text).toContain('workflows.condition.loopStoppedBecause');
        expect(text).not.toContain('Outcome · Kind');
        // "Check · Verdict is converged", not "Check result · Verdict is “converged”" (DESIGN-7 M4).
        expect(screen.findByTestId('workflow-editor-loop-rounds-sentence')?.findAll((node) => typeof node.props?.children === 'string'
            && node.props.children.includes('workflows.input.previousResult')).length).toBe(0);
        expect(text).toContain('converged');
        expect(text).not.toContain('“converged”');
    });

    it('keeps a container name whole on a narrow line: sized to its words, meta after it, the consequence wrapping beneath (DESIGN-5 N1)', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [{ kind: 'parallel', id: 'panel', name: 'Changelog and tests', failurePolicy: 'fail_stop',
            branches: [{ id: 'one', blocks: [step('a', 'A')] }, { id: 'two', blocks: [step('b', 'B')] }] }] as never);
        const screen = await renderList(harness, { draft });
        const input = () => screen.findHostByTestId('workflow-editor-parallel-panel-label')!;
        // The name is never a zero-basis flex child that the meta and policy can squeeze to a letter column.
        expect(NativeStyleSheet.flatten(input().props.style)?.flex).toBeUndefined();
        await act(async () => {
            screen.findHostByTestId('workflow-editor-parallel-panel-label-measure')!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 150, height: 20 } } });
        });
        expect(NativeStyleSheet.flatten(input().props.style)?.width).toBeGreaterThanOrEqual(150);
        // The meta follows the name ("· 2 lanes"); the failure policy is the trailing select on the same wrapping line.
        expect(screen.findByTestId('workflow-editor-parallel-panel-label-meta')).not.toBeNull();
        let line = screen.findHostByTestId('workflow-editor-parallel-panel-summary')?.parent ?? null;
        while (line !== null && line.findAll((node) => node.props?.testID === 'workflow-editor-parallel-panel-label-meta').length === 0) line = line.parent;
        expect(NativeStyleSheet.flatten(line?.props.style)?.flexWrap).toBe('wrap');
    });

    it('names a lane in place, captions it with its name, and opens its menu from a caret beside it (07 lanes; DESIGN-5 N10)', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [{ kind: 'parallel', id: 'panel', name: 'Release', failurePolicy: 'fail_stop',
            branches: [{ id: 'one', name: 'Changelog', blocks: [step('a', 'A')] }, { id: 'two', blocks: [step('b', 'B')] }] }] as never);
        const changes: Array<ReturnType<typeof buildDraft>> = [];
        const screen = await renderList(harness, { draft, onChange: (next) => changes.push(next as ReturnType<typeof buildDraft>) });
        const lane = screen.findHostByTestId('workflow-editor-parallel-panel-branch-one-label')!;
        expect(lane.props.value).toBe('Changelog');
        expect(screen.findHostByTestId('workflow-editor-parallel-panel-branch-two-label')?.props.placeholder).toBe('workflows.page.inspector.lane:{"position":2}');
        await act(async () => { lane.props.onFocus(); lane.props.onChangeText('Issues'); });
        expect(changes.at(-1)?.blocks[0]).toMatchObject({ branches: [{ id: 'one', name: 'Issues' }, { id: 'two' }] });
        expect(screen.findAll((node) => node.props?.testID === 'workflow-editor-parallel-panel-branch-one-actions' && node.props?.iconName !== undefined)[0]?.props.iconName).toBe('caret-down');
        await screen.unmount();
        const reading = await renderList(harness, { draft, presentation: { editable: false } });
        expect(reading.findByTestId('workflow-editor-parallel-panel-branch-one-label')?.props.children).toBe('Changelog');
    });

    it('keeps a step\'s footer to facts, the same selected or at rest (DESIGN-5 M1, DESIGN-7 N27)', async () => {
        const harness = await loadHarness();
        const named = { ...step('gather', 'Gather'), result: { kind: 'json', schema: { type: 'object', properties: { issues: { type: 'array' }, summary: { type: 'string' } } } } };
        const draft = buildDraft(harness, [step('plain', 'Plain'), named] as never);
        for (const selectedBlockId of [null, 'plain']) {
            const screen = await renderList(harness, { draft, selectedBlockId });
            // No "Returns text · Add named results · Add input": Step options owns adding them.
            expect(screen.findHostByTestId('workflow-editor-step-plain-returns')).toBeNull();
            expect(screen.findHostByTestId('workflow-editor-step-plain-add-input')).toBeNull();
            expect(screen.findHostByTestId('workflow-editor-step-plain-add-named-results')).toBeNull();
            // Named results say what they are.
            expect(screen.findHostByTestId('workflow-editor-step-gather-returns')?.props.children).toContain('workflows.page.blocks.returnsFields');
            await screen.unmount();
        }
    });

    it('marks an unset required field with a quiet marker on its label line (DESIGN-5 N5)', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [{ kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: {} }] as never);
        const screen = await renderList(harness, { draft });
        const marker = screen.findHostByTestId('workflow-editor-action-notify-field-message-required');
        expect(marker).not.toBeNull();
        // Same line as the label: the label column lays its words and the marker out as one row.
        let column = marker?.parent ?? null;
        while (column !== null && NativeStyleSheet.flatten(column.props.style)?.minWidth === undefined) column = column.parent;
        expect(NativeStyleSheet.flatten(column?.props.style)?.flexDirection).toBe('row');
    });

    it('reads a guarded comparison and a stop condition as sentences, not their guards (DESIGN-5 M4)', async () => {
        const harness = await loadHarness();
        const used = { kind: 'session_context_field', field: 'usage.tokensUsed' };
        const budget = { kind: 'session_context_field', field: 'goal.tokenBudget' };
        const draft = buildDraft(harness, [
            { kind: 'loop', id: 'turns', name: 'Keep going', body: [step('check', 'Check')], repetition: { kind: 'until', maxIterations: 3,
                stopWhen: { kind: 'any', conditions: [
                    { kind: 'compare', operator: 'eq', left: { kind: 'result', producer: { blockId: 'check', scope: { kind: 'current' } }, path: ['verdict'] }, right: { kind: 'literal', value: 'done' } },
                    { kind: 'all', conditions: [{ kind: 'exists', value: used }, { kind: 'exists', value: budget },
                        { kind: 'compare', operator: 'gte', left: used, right: budget }] },
                ] } } },
            { kind: 'if', id: 'met', name: 'If the goal is met', when: { kind: 'compare', operator: 'eq',
                left: { kind: 'result', producer: { blockId: 'turns', scope: { kind: 'current' } }, path: ['outcome'] }, right: { kind: 'literal', value: { kind: 'stop_condition', arm: 0 } } },
                then: [step('done', 'Done')], otherwise: [] },
        ] as never);
        const screen = await renderList(harness, { draft, presentation: { editable: false } });
        const text = screen.getTextContent();
        expect(text).not.toContain('workflows.condition.exists');
        expect(text).toContain('workflows.condition.loopStoppedBecause');
        expect(text).not.toContain('workflows.condition.loopEnded');
    });

    it('never says an unnamed block\'s kind twice: the kind in ink, a sentence as the title, a card naming itself (DESIGN-6 N19)', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'parallel', id: 'panel', failurePolicy: 'fail_stop', branches: [{ id: 'one', blocks: [step('a', 'A')] }] },
            { kind: 'loop', id: 'again', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } }, body: [step('b', 'B')] },
            step('c', 'C'),
        ] as never);
        const screen = await renderList(harness, { draft });
        // Side by side: the kind is the title, in ink, until it is named; an Agent step's is a quiet placeholder.
        const tone = (id: string) => screen.findHostByTestId(id)?.props.placeholderTextColor;
        expect(tone('workflow-editor-parallel-panel-label')).not.toBe(tone('workflow-editor-step-c-label'));
        // Repeat: the sentence is the title; the name field adds no second "Repeat".
        expect(screen.findHostByTestId('workflow-editor-loop-again-label')?.props.placeholder).toBe('');
        expect(screen.findHostByTestId('workflow-editor-loop-again-label-meta')?.children).not.toContain('· ');
    });

    it('lets an unnamed typed card\'s heading carry its identity once, never an empty row (DESIGN-7)', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            step('c', 'C'),
            { kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Ship it' } } },
            { kind: 'workflow', id: 'review', workflowRef: 'builtin:review-and-converge', input: {} },
            { kind: 'action', id: 'named', name: 'Announce it', actionId: 'notifications.notify_me', input: {} },
        ] as never);
        const screen = await renderList(harness, { draft });
        const placeholder = (id: string) => screen.findHostByTestId(`workflow-editor-${id}-label`)?.props.placeholder;
        const tone = (id: string) => screen.findHostByTestId(`workflow-editor-${id}-label`)?.props.placeholderTextColor;
        const sourceText = (id: string) => JSON.stringify(screen.findHostByTestId(`workflow-editor-${id}-label-source`)?.props.children ?? null);
        // Notify me: the heading reads the card's title in ink with its provenance; the card has no second header.
        const namedCardTitle = screen.findByTestId('workflow-editor-action-named-card-title')?.props.children;
        expect(typeof namedCardTitle).toBe('string');
        expect(placeholder('action-notify')).toBe(namedCardTitle);
        expect(tone('action-notify')).not.toBe(tone('step-c'));
        expect(sourceText('action-notify')).toContain('Happier');
        expect(screen.findByTestId('workflow-editor-action-notify-card-title')).toBeNull();
        // Run a workflow: the heading names the child, says "Built-in" and holds Open ›, once.
        expect(placeholder('workflow-review')).toBe('workflows.builtins.reviewAndConverge.title');
        expect(sourceText('workflow-review')).toContain('workflows.page.blocks.builtin');
        expect(screen.findByTestId('workflow-editor-workflow-review-card-title')).toBeNull();
        expect(screen.findHostByTestId('workflow-editor-workflow-review-open')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-workflow-review-card')?.findAll((node) => node.props?.testID === 'workflow-editor-workflow-review-open')).toHaveLength(0);
        // A default string reads as the value itself, never curly-quoted (DESIGN-7 M4).
        const focusText = JSON.stringify(screen.findByTestId('workflow-editor-workflow-review-input-focus')
            ?.findAll((node) => typeof node.props?.children === 'string').map((node) => node.props.children));
        expect(focusText).toContain('Review the changes made in this session.');
        expect(focusText).not.toContain('“');
        // Named, the heading is the name and the card's own header names what runs (lab S6).
        expect(screen.findHostByTestId('workflow-editor-action-named-label')?.props.value).toBe('Announce it');
        expect(screen.findByTestId('workflow-editor-action-named-card-title')).not.toBeNull();
        expect(screen.findHostByTestId('workflow-editor-action-named-label-source')).toBeNull();
    });

    it('reads a typed card\'s set values as values until its step is selected, then edits them (DESIGN-6 N5)', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness, [
            { kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Ship it' }, title: { kind: 'literal', value: 'release_ready' } } },
        ] as never);
        const selections: (string | null)[] = [];
        const screen = await renderList(harness, { draft, onSelect: (id) => selections.push(id) });
        expect(screen.findHostByTestId('workflow-editor-action-notify-field-message-literal')).toBeNull();
        const value = screen.findHostByTestId('workflow-editor-action-notify-field-message-value');
        expect(value?.findAll((node) => node.props?.children === 'Ship it').length).toBeGreaterThan(0);
        // A literal reads as the value itself: no quotes, an identifier's underscores as spaces.
        expect(screen.findHostByTestId('workflow-editor-action-notify-field-title-value')
            ?.findAll((node) => node.props?.children === 'release ready').length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('workflow-editor-action-notify-field-message-edit');
        expect(selections).toContain('notify');
        await screen.unmount();
        const selected = await renderList(harness, { draft, selectedBlockId: 'notify' });
        expect(selected.findHostByTestId('workflow-editor-action-notify-field-message-input-0-kind-trigger')).not.toBeNull();
        await selected.unmount();
        // An empty value well says what goes in it, never a blank grey box (DESIGN-7 N5).
        const nested = buildDraft(harness, [{ kind: 'workflow', id: 'review', name: 'Review', workflowRef: 'builtin:review-and-converge',
            input: { engines: { kind: 'literal', value: '' } } }] as never);
        const editing = await renderList(harness, { draft: nested, selectedBlockId: 'review' });
        expect(editing.findHostByTestId('workflow-editor-workflow-review-input-engines-input-0-literal')?.props.placeholder)
            .toBe('workflows.condition.literalPlaceholder');
        await editing.unmount();
        // At rest a blank required value reads as unset and keeps its "Required" marker (DESIGN-7 N24).
        const resting = await renderList(harness, { draft: nested });
        expect(resting.findHostByTestId('workflow-editor-workflow-review-input-engines-required')).not.toBeNull();
        expect(resting.findHostByTestId('workflow-editor-workflow-review-input-engines-value')
            ?.findAll((node) => node.props?.children === 'workflows.page.blocks.notSet').length).toBeGreaterThan(0);
    });

    it('marks an offending card row, says a root Wait pauses the workflow, and names result fields as words (DESIGN-6 P3, M4)', async () => {
        const harness = await loadHarness();
        const named = { ...step('judge', 'Judge'), result: { kind: 'json', schema: { type: 'object', properties: { missingEvidence: { type: 'string' } } } } };
        const draft = buildDraft(harness, [
            { kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: {} },
            { kind: 'wait', id: 'pause', document: { text: 'Check', references: [], attachments: [] }, result: { kind: 'text' } },
            named,
        ] as never);
        const screen = await renderList(harness, { draft });
        expect(screen.findHostByTestId('workflow-editor-action-notify-field-message-issue')).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.page.blocks.waitSubRoot');
        expect(screen.findHostByTestId('workflow-editor-step-judge-returns')?.props.children).toContain('missing evidence');
    });

    it('numbers leaves 1…n across lanes and bodies, gives containers their mark instead, and agrees with the map (M1 c ruling)', async () => {
        const harness = await loadHarness();
        const { projectWorkflowFlow } = await import('../flow/workflowFlowProjection');
        const draft = buildDraft(harness, [
            step('gather', 'Gather'),
            { kind: 'parallel', id: 'lanes', failurePolicy: 'fail_stop', branches: [
                { id: 'changelog', blocks: [step('write', 'Write')] },
                { id: 'issues', blocks: [{ kind: 'loop', id: 'each', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } }, body: [
                    step('check', 'Check'),
                    { kind: 'if', id: 'failed', when: { kind: 'exists', value: { kind: 'literal', value: true } }, then: [step('reopen', 'Reopen')], otherwise: [] },
                ] }] },
            ] },
            step('publish', 'Publish'),
        ] as never);
        const screen = await renderList(harness, { draft });
        const shown = (id: string) => screen.findHostByTestId(`workflow-editor-step-${id}-label-ordinal`)
            ?.findAll((node) => typeof node.props?.children === 'string')[0]?.props.children as string | undefined;
        expect(['gather', 'write', 'check', 'reopen', 'publish'].map(shown))
            .toEqual([1, 2, 3, 4, 5].map((position) => `workflows.editor.stepOrdinal:${JSON.stringify({ position })}`));
        // Containers are unnumbered: their kind mark takes the ordinal column.
        for (const id of ['parallel-lanes', 'loop-each', 'if-failed']) {
            expect(screen.findHostByTestId(`workflow-editor-${id}-label-ordinal`), id).toBeNull();
            expect(screen.findHostByTestId(`workflow-editor-${id}-label-ordinal-mark`), id).not.toBeNull();
        }
        // The map numbers the same nodes the same way, from the same owner.
        const map = projectWorkflowFlow(harness.validateWorkflowEditorDraft(draft).normalizedDefinition!);
        expect(Object.fromEntries(map.nodes.filter((node) => node.stepOrdinal !== undefined).map((node) => [node.blockId, node.stepOrdinal])))
            .toEqual({ gather: '1', write: '2', check: '3', reopen: '4', publish: '5' });
    });

    it('marks each kind in the Add menu with the glyph its block heading uses (DESIGN-4 follow-up a)', async () => {
        const harness = await loadHarness();
        const { WORKFLOW_BLOCK_KIND_GLYPH } = await import('@/components/workflows/presentation/workflowBlockKindGlyph');
        const screen = await renderList(harness, { draft: buildDraft(harness, [step('a', 'A')]) });
        const root = await openAddMenu(screen, 'workflow-editor-add-root');
        const options = root.sections.flatMap((section) => section.kind === 'static' ? section.options : []) as unknown as ReadonlyArray<{ id: string; icon?: () => React.ReactElement<{ name: string }> }>;
        for (const kind of ['step', 'workflow', 'action', 'wait', 'parallel', 'loop', 'if'] as const) {
            const option = options.find((candidate) => candidate.id === `workflow-editor-add-root-${kind}`);
            expect(option?.icon?.().props.name, kind).toBe(WORKFLOW_BLOCK_KIND_GLYPH[kind]);
        }
    });
});

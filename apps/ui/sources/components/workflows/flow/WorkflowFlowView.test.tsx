import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { renderScreen } from '@/dev/testkit';

import { WorkflowFlowView } from './WorkflowFlowView';
import { indexWorkflowFlowRunStates, projectWorkflowFlow } from './workflowFlowProjection';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { WorkflowLifecycleStatus } from '@/components/workflows/presentation/WorkflowLifecycleStatus';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

const AGENT_TARGET = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };

function step(id: string) {
    return {
        kind: 'step' as const,
        id,
        document: { text: `${id} prompt`, references: [], attachments: [] },
        input: [],
        result: { kind: 'text' as const },
    };
}

/**
 * One parallel container holding two steps. Visually this is a rail with two
 * indented rows; structurally it is a group a reader has to be able to perceive.
 */
function nestedDefinition(): WorkflowDefinitionV1 {
    return {
        version: 1,
        inputs: [],
        defaults: { agentTarget: AGENT_TARGET },
        blocks: [
            step('analyze'),
            {
                kind: 'parallel' as const,
                id: 'fan-out',
                failurePolicy: 'fail_stop' as const,
                branches: [
                    { id: 'checks', blocks: [step('review'), step('implement')] },
                ],
            },
        ],
    } as WorkflowDefinitionV1;
}

async function renderFlow() {
    const projection = projectWorkflowFlow(nestedDefinition());
    return renderScreen(React.createElement(WorkflowFlowView, {
        projection,
        selectedNodeId: null,
        testIDPrefix: 'flow',
    }));
}

describe('WorkflowFlowView accessibility structure', () => {
    it('lets a held Wait node open its exact occurrence, including repeated child Waits', async () => {
        const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
            { kind: 'wait', id: 'wait', document: { text: 'Continue?', references: [], attachments: [] } },
        ] };
        const onSelectOccurrence = vi.fn();
        const projection = projectWorkflowFlow(definition);
        const screen = await renderScreen(React.createElement(WorkflowFlowView, {
            projection, selectedNodeId: 'wait', selectedInvocationId: 'held-1', onSelectOccurrence,
            runStates: new Map([['wait', [{ nodeId: 'wait', invocationId: 'held-1', lifecycle: 'waiting_for_review' as const }]]]),
            testIDPrefix: 'flow',
        }));
        const node = screen.findByTestId('flow-node-wait');
        expect(node).not.toBeNull();
        expect(node!.props.disabled).not.toBe(true);
        await screen.pressByTestId('flow-node-wait');
        expect(onSelectOccurrence.mock.calls[0]?.[0]).toBe('held-1');
        await screen.update(React.createElement(WorkflowFlowView, {
            projection, selectedNodeId: 'wait', selectedInvocationId: 'held-1', onSelectOccurrence,
            runStates: new Map([['wait', [
                { nodeId: 'wait', invocationId: 'held-1', lifecycle: 'waiting_for_review' as const, occurrenceLabel: 'Item 1' },
                { nodeId: 'wait', invocationId: 'held-2', lifecycle: 'waiting_for_review' as const, occurrenceLabel: 'Item 2' },
            ]]]), testIDPrefix: 'flow',
        }));
        expect(screen.findByTestId('flow-node-wait')?.props.disabled).toBe(true);
        expect(screen.tree.findHostByTestId('flow-node-wait-occurrence-held-1')?.props['aria-current']).toBe('page');
        expect(screen.tree.findHostByTestId('flow-node-wait-occurrence-held-2')?.props['aria-current']).toBeUndefined();
        expect(screen.root.findAllByType(HappierPressable).some((node) => node.props.testID === 'flow-node-wait-occurrence-held-2')).toBe(true);
        const occurrences = screen.root.findAll((node) => typeof node.type === 'string'
            && (node.props.testID === 'flow-node-wait-occurrence-held-1'
                || node.props.testID === 'flow-node-wait-occurrence-held-2'));
        expect(occurrences.map((node) => node.props['aria-current'])).toEqual(['page', undefined]);
        await screen.pressByTestIdAsync('flow-node-wait-occurrence-held-2');
        expect(onSelectOccurrence.mock.calls.at(-1)?.[0]).toBe('held-2');
    });

    it('rings a node whose items wait for you, even when no single item is selected (07 §2.3 item 1)', async () => {
        const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
            { kind: 'wait', id: 'wait', document: { text: 'Continue?', references: [], attachments: [] } },
        ] };
        const projection = projectWorkflowFlow(definition);
        const nodeStyle = async (states: readonly { invocationId: string; lifecycle: 'waiting_for_review' | 'completed'; occurrenceLabel?: string }[]) => {
            const screen = await renderScreen(React.createElement(WorkflowFlowView, {
                projection, selectedNodeId: null, selectedInvocationId: null, onSelectOccurrence: vi.fn(),
                runStates: new Map([['wait', states.map((state) => ({ nodeId: 'wait', ...state }))]]),
                testIDPrefix: 'flow',
            }));
            const raw = screen.findByTestId('flow-node-wait')?.props.style;
            const style = JSON.stringify(typeof raw === 'function' ? raw({ pressed: false }) : raw);
            await screen.unmount();
            return style;
        };
        const held = await nodeStyle([{ invocationId: 'held-1', lifecycle: 'waiting_for_review' }]);
        const settled = await nodeStyle([{ invocationId: 'done-1', lifecycle: 'completed' }]);
        const items = await nodeStyle([
            { invocationId: 'done-1', lifecycle: 'completed', occurrenceLabel: 'a' },
            { invocationId: 'held-1', lifecycle: 'waiting_for_review', occurrenceLabel: 'b' },
        ]);
        expect(held).not.toBe(settled);
        expect(items).toBe(held);
    });

    it('exposes every node as a real list item rather than a bare button under a list', async () => {
        const screen = await renderFlow();

        for (const nodeId of ['analyze', 'fan-out', 'fan-out#checks', 'review', 'implement']) {
            const item = screen.findByTestId(`flow-item-${nodeId}`);
            expect(item?.props.role).toBe('listitem');
        }
    });

    it('projects container ownership as a labelled group instead of indentation alone', async () => {
        const screen = await renderFlow();

        const group = screen.findByTestId('flow-group-fan-out');
        expect(group?.props.accessibilityRole).toBe('list');
        // The rails are decorative and hidden, so the group is the only thing
        // that can tell a reader these two steps run inside the container.
        expect(group?.props.accessibilityLabel).toBeTruthy();
    });

    it('names each node position within its own container', async () => {
        const screen = await renderFlow();

        expect(screen.findByTestId('flow-node-review')?.props.accessibilityLabel)
            .toContain('workflows.a11y.stepContext');
    });

    it('keeps the linear reading order the visual outline shows', async () => {
        const screen = await renderFlow();

        const expected = [
            'flow-node-analyze', 'flow-node-fan-out', 'flow-node-fan-out#checks',
            'flow-node-review', 'flow-node-implement',
        ];
        const ordered = screen.root.findAll((node) => typeof node.type === 'string'
            && expected.includes(node.props.testID));
        expect(ordered.map((node) => node.props.testID)).toEqual(expected);
    });
});

describe('WorkflowFlowView run map anatomy (lab run-A)', () => {
    it('renders a projected If condition with its branches and includes it in the accessible name', async () => {
        const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{
            kind: 'if', id: 'approved', when: { kind: 'compare', operator: 'eq',
                left: { kind: 'input', name: 'approved' }, right: { kind: 'literal', value: true } },
            then: [step('publish')], otherwise: [step('revise')],
        }] };
        const projection = projectWorkflowFlow(definition);
        const screen = await renderScreen(<WorkflowFlowView projection={projection} selectedNodeId={null} testIDPrefix="flow" />);
        const sentence = projection.nodesById.get('approved')?.labelDetail ?? '';
        expect(sentence).toBeTruthy();
        expect(screen.findByTestId('flow-node-approved')?.findAll((node) => node.props.children === ` · ${sentence}`).length).toBeGreaterThan(0);
        // This suite's translation boundary records parameters as JSON, which
        // escapes the nested input label. Inspect the spoken block parameter.
        const announcement = String(screen.findByTestId('flow-node-approved')?.props.accessibilityLabel);
        const parameters: unknown = JSON.parse(announcement.slice(announcement.indexOf(':') + 1));
        expect(parameters).toMatchObject({ block: expect.stringContaining(sentence) });
        expect(screen.findByTestId('flow-node-approved#then')).not.toBeNull();
        expect(screen.findByTestId('flow-node-approved#otherwise')).not.toBeNull();
    });
    it('keeps each repeated occurrence duration with its own attempt without choosing a latest occurrence', async () => {
        const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [step('gather')] };
        const screen = await renderScreen(React.createElement(WorkflowFlowView, {
            projection: projectWorkflowFlow(definition), selectedNodeId: null,
            selectedInvocationId: null, onSelectOccurrence: vi.fn(), testIDPrefix: 'flow',
            runStates: new Map([['gather', [
                { nodeId: 'gather', invocationId: 'first', lifecycle: 'completed' as const, occurrenceLabel: 'Item 1',
                    timing: { startedAt: '2026-10-11T20:54:00.000Z', finishedAt: '2026-10-11T20:54:54.067Z' } },
                { nodeId: 'gather', invocationId: 'second', lifecycle: 'completed' as const, occurrenceLabel: 'Item 2',
                    timing: { startedAt: '2026-10-11T20:54:00.000Z', finishedAt: '2026-10-11T20:54:12.000Z' } },
            ]]]),
        }));
        for (const [id, seconds] of [['first', '54'], ['second', '12']]) {
            const row = screen.findByTestId(`flow-node-gather-occurrence-${id}`);
            expect(row?.findAll((node) => node.props.children === `tools.common.elapsedSeconds:{"seconds":"${seconds}"}`).length)
                .toBeGreaterThan(0);
        }
    });

    it('numbers each step, says what it returns, and keeps a finished step quiet', async () => {
        const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
            step('gather'),
            { kind: 'wait', id: 'approve', document: { text: 'Approve?', references: [], attachments: [] },
                result: { kind: 'json', schema: { type: 'object', properties: { approval: { type: 'string' } } } } },
        ] } as WorkflowDefinitionV1;
        const screen = await renderScreen(React.createElement(WorkflowFlowView, {
            projection: projectWorkflowFlow(definition), selectedNodeId: null, testIDPrefix: 'flow',
            runStates: new Map([['approve', [{ nodeId: 'approve', invocationId: 'approve-1', lifecycle: 'completed' as const }]]]),
        }));
        expect(screen.findByTestId('flow-node-gather-ordinal')?.findAll((node) => String(node.props.children) === '1').length).toBeGreaterThan(0);
        expect(screen.findByTestId('flow-node-approve-ordinal')?.findAll((node) => String(node.props.children) === '2').length).toBeGreaterThan(0);
        const approve = screen.findByTestId('flow-node-approve');
        expect(approve?.findAll((node) => node.props.children === 'workflows.page.blocks.returnsFields:{"fields":"approval"}').length).toBeGreaterThan(0);
        // The state is the marker's spoken name, not a visible word beside it.
        expect(approve?.findAll((node) => node.props.children === 'workflows.invocationState.completed')).toHaveLength(0);
        expect(screen.findByTestId('flow-node-approve-state')?.props.accessibilityLabel).toBe('workflows.invocationState.completed');
    });
});

describe('WorkflowFlowView map grammar (07 S14)', () => {
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
        { kind: 'parallel', id: 'lanes', failurePolicy: 'fail_stop', branches: [
            { id: 'docs', blocks: [step('docs')] }, { id: 'tests', blocks: [step('tests')] },
        ] },
        { kind: 'if', id: 'passed', when: { kind: 'compare', operator: 'eq',
            left: { kind: 'input', name: 'passed' }, right: { kind: 'literal', value: true } },
        then: [step('tag')], otherwise: [step('summarize')] },
    ] } as WorkflowDefinitionV1;

    it('joins side-by-side lanes, separates If alternatives with "or" and marks the path a Run did not take', async () => {
        const projection = projectWorkflowFlow(definition);
        const screen = await renderScreen(<WorkflowFlowView projection={projection} selectedNodeId={null} testIDPrefix="flow"
            runStates={new Map([
                ['passed', [{ nodeId: 'passed', invocationId: 'if-1', lifecycle: 'completed' as const }]],
                ['summarize', [{ nodeId: 'summarize', invocationId: 'sum-1', lifecycle: 'running' as const }]],
            ])} notStartedLabel="not started" />);
        expect(screen.findByTestId('flow-join-lanes')?.findAll((node) => node.props.children === 'workflows.map.allLanesFinish:{"count":2}').length).toBeGreaterThan(0);
        expect(screen.findByTestId('flow-or-passed#otherwise')).not.toBeNull();
        expect(screen.findByTestId('flow-join-passed')).toBeNull();
        // The Yes path did not run while Otherwise did: its caption says so and its step stays quiet.
        expect(screen.findByTestId('flow-node-passed#then-not-taken')).not.toBeNull();
        expect(screen.findByTestId('flow-node-tag-not-started')).toBeNull();
        expect(screen.findByTestId('flow-node-passed#otherwise-not-taken')).toBeNull();
    });

    it('drops a compact step\'s state word only when the card above it already states the Run\'s state (R14 MUST 2)', async () => {
        const projection = projectWorkflowFlow(definition);
        const runStates = new Map([['passed', [{ nodeId: 'passed', invocationId: 'if-1', lifecycle: 'needs_attention' as const }]]]);
        const word = 'workflows.runState.interrupted';
        // Every other compact map (a Work row's mini-map) keeps the word beside the mark.
        const plain = await renderScreen(<WorkflowFlowView projection={projection} selectedNodeId={null} testIDPrefix="flow"
            density="compact" runStates={runStates} />);
        expect(plain.getTextContent()).toContain(word);
        await plain.unmount();
        const stated = await renderScreen(<WorkflowFlowView projection={projection} selectedNodeId={null} testIDPrefix="flow"
            density="compact" runStates={runStates} runStateInHeader />);
        // The step keeps its mark and says the state as the mark's name, but not again as a visible word.
        expect(stated.getTextContent()).not.toContain(word);
        expect(stated.findByTestId('flow-node-passed-state-marker')).not.toBeNull();
        expect(stated.findByTestId('flow-node-passed-state')?.props.accessibilityLabel).toBe(word);
        await stated.unmount();
    });

    it('folds the steps of the path a Run did not take under its "Not taken" caption (DESIGN-REVIEW-DEPLOY-2 receipt)', async () => {
        const projection = projectWorkflowFlow(definition);
        const screen = await renderScreen(<WorkflowFlowView projection={projection} selectedNodeId={null} testIDPrefix="flow"
            runStates={new Map([
                ['passed', [{ nodeId: 'passed', invocationId: 'if-1', lifecycle: 'completed' as const }]],
                ['summarize', [{ nodeId: 'summarize', invocationId: 'sum-1', lifecycle: 'completed' as const }]],
            ])} notStartedLabel="skipped" />);
        expect(screen.findByTestId('flow-node-passed#then-not-taken')).not.toBeNull();
        expect(screen.findByTestId('flow-node-tag')).toBeNull();
        expect(screen.findByTestId('flow-node-summarize')).not.toBeNull();
    });

    it('draws no failure-only step on the map of a Run that succeeded, and keeps it while the Run can still fail', async () => {
        const withRecovery = { ...definition, blocks: [...definition.blocks,
            { ...step('recover'), runWhen: 'failure' as const }] } as WorkflowDefinitionV1;
        const projection = projectWorkflowFlow(withRecovery);
        const docs = { nodeId: 'docs', invocationId: 'd-1', lifecycle: 'completed' as const };
        const runStates = indexWorkflowFlowRunStates([
            docs,
            { nodeId: 'recover', invocationId: 'recovery-1', lifecycle: 'skipped' },
        ]);
        const succeeded = await renderScreen(<WorkflowFlowView projection={projection} selectedNodeId={null} testIDPrefix="flow"
            runStates={runStates} notStartedLabel="skipped" runSucceeded />);
        expect(succeeded.findByTestId('flow-node-recover')).toBeNull();
        expect(succeeded.findByTestId('flow-node-docs')).not.toBeNull();
        await succeeded.unmount();
        const running = await renderScreen(<WorkflowFlowView projection={projection} selectedNodeId={null} testIDPrefix="flow"
            runStates={indexWorkflowFlowRunStates([docs])} notStartedLabel="not started" />);
        expect(running.findByTestId('flow-node-recover')).not.toBeNull();
    });

    it('names a named condition on a Run map by its name, leaving its expression to the Steps view', async () => {
        const named = { ...definition, blocks: definition.blocks.map((block) => block.kind === 'if'
            ? { ...block, name: 'Tag when the checks pass' } : block) } as WorkflowDefinitionV1;
        const projection = projectWorkflowFlow(named, {}, {}, { presentation: 'run' });
        const screen = await renderScreen(<WorkflowFlowView projection={projection} selectedNodeId={null} testIDPrefix="flow" />);
        expect(screen.getTextContent()).toContain('Tag when the checks pass');
        expect(screen.getTextContent()).not.toContain('workflows.page.inspector.ifSentence');
        expect(screen.getTextContent()).not.toContain('workflows.input.workflowInput');
    });

    it('takes nothing away before the If is decided', async () => {
        const projection = projectWorkflowFlow(definition);
        const screen = await renderScreen(<WorkflowFlowView projection={projection} selectedNodeId={null} testIDPrefix="flow"
            runStates={new Map([['docs', [{ nodeId: 'docs', invocationId: 'd-1', lifecycle: 'running' as const }]]])} notStartedLabel="not started" />);
        expect(screen.findByTestId('flow-node-passed#then-not-taken')).toBeNull();
        expect(screen.findByTestId('flow-node-tag-not-started')).not.toBeNull();
    });
});

describe('WorkflowFlowView loop item selector (07 S14)', () => {
    const definition = {
        version: 1, inputs: [], defaults: {},
        blocks: [{ kind: 'loop', id: 'issues', repetition: { kind: 'items', items: { kind: 'literal', value: [] }, execution: 'parallel', failurePolicy: 'collect_outcomes' },
            body: [step('fix'), step('note')] }],
    } as unknown as WorkflowDefinitionV1;
    const lifecycles = ['completed', 'waiting_for_review', 'running'] as const;
    function statesFor(nodeIds: readonly string[]) {
        return new Map(nodeIds.map(nodeId => [nodeId, lifecycles.map((lifecycle, index) => ({
            nodeId, invocationId: `${nodeId}-${index}`, lifecycle, attempt: '0', occurrenceLabel: `Issue ${index + 1}`,
            repetitions: [{ loopNodeId: 'issues', index, label: `Issue ${index + 1}` }],
        }))]));
    }
    const baseProps = {
        projection: projectWorkflowFlow(definition),
        selectedNodeId: null,
        testIDPrefix: 'flow',
    } as const;

    it('draws the loop body once for the item that needs you, and swaps it with the selector', async () => {
        const screen = await renderScreen(React.createElement(WorkflowFlowView, {
            ...baseProps,
            selectedInvocationId: null,
            onSelectOccurrence: vi.fn(),
            runStates: statesFor(['fix', 'note']),
        }));
        expect(screen.findByTestId('flow-node-issues-item-selector-open')?.props.accessibilityLabel).toContain('Issue 2');
        // The body shows one item, never a row per item.
        expect(screen.findByTestId('flow-node-fix-occurrences')).toBeNull();
        expect(screen.findByTestId('flow-node-fix')?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('flow-node-issues-item-selector-next');
        expect(screen.findByTestId('flow-node-issues-item-selector-open')?.props.accessibilityLabel).toContain('Issue 3');
        expect(screen.findAllByType(WorkflowLifecycleStatus).find(node => node.props.testID === 'flow-node-fix-state')?.props.lifecycle).toBe('running');
    });

    it('follows the selected step into its item and carries an open step to the next item', async () => {
        const onSelectOccurrence = vi.fn();
        const screen = await renderScreen(React.createElement(WorkflowFlowView, {
            ...baseProps,
            selectedInvocationId: 'fix-0',
            onSelectOccurrence,
            runStates: statesFor(['fix', 'note']),
        }));
        expect(screen.findByTestId('flow-node-issues-item-selector-open')?.props.accessibilityLabel).toContain('Issue 1');
        await screen.pressByTestIdAsync('flow-node-issues-item-selector-next');
        expect(onSelectOccurrence.mock.calls[0]?.[0]).toBe('fix-1');
    });

    it('keeps every occurrence on a compact map and shows no selector', async () => {
        const screen = await renderScreen(React.createElement(WorkflowFlowView, {
            ...baseProps,
            density: 'compact',
            runStates: statesFor(['fix', 'note']),
        }));
        expect(screen.findByTestId('flow-node-issues-item-selector-open')).toBeNull();
    });
});

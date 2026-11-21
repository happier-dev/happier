import { describe, expect, it } from 'vitest';

import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowRunSnapshotV1';
import { t } from '@/text';
import { countWorkflowStepsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { formatWorkflowStepSessionTitle } from '@happier-dev/protocol/workflows/workflowStepLabel';

import {
  indexWorkflowFlowRunStates,
  projectObservedWorkflowFlow,
  projectWorkflowFlow,
  resolveWorkflowFlowEditTarget,
} from './workflowFlowProjection';

describe('run occurrence projection', () => {
  it('preserves every exact invocation for one authored node instead of overwriting repeated scopes and attempts', () => {
    const states = indexWorkflowFlowRunStates([
      { nodeId: 'inspect', invocationId: 'item-1-attempt-0', lifecycle: 'completed', occurrenceLabel: 'Item 1', attempt: '0' },
      { nodeId: 'inspect', invocationId: 'item-2-attempt-0', lifecycle: 'superseded', occurrenceLabel: 'Item 2', attempt: '0' },
      { nodeId: 'inspect', invocationId: 'item-2-attempt-1', lifecycle: 'running', occurrenceLabel: 'Item 2', attempt: '1' },
    ]);

    expect(states.get('inspect')?.map((state) => state.invocationId)).toEqual([
      'item-1-attempt-0',
      'item-2-attempt-0',
      'item-2-attempt-1',
    ]);
  });
});

const AGENT_TARGET = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };

function step(id: string, text = `${id} prompt`) {
  return { kind: 'step' as const, id, document: { text, references: [], attachments: [] }, input: [], result: { kind: 'text' as const } };
}

function definition(blocks: WorkflowDefinitionV1['blocks']): WorkflowDefinitionV1 {
  return { version: 1, inputs: [], defaults: { agentTarget: AGENT_TARGET }, blocks };
}

describe('definition flow projection', () => {
  it('names unnamed Run steps like their fresh conversations while keeping authoring placeholders', () => {
    const unnamed = step('inspect', 'Inspect the change\nThen explain the result');
    const source = definition([unnamed]);
    const node = projectWorkflowFlow(source, {}, {}, { presentation: 'run' }).nodesById.get(unnamed.id)!;
    expect(`${node.stepOrdinal} · ${node.label}`).toBe(formatWorkflowStepSessionTitle({ step: unnamed, stepOrdinal: '1' }));
    expect(projectWorkflowFlow(source).nodesById.get(unnamed.id)?.label).toBe(t('workflows.editor.addStep'));
    expect(projectWorkflowFlow(definition([{ ...unnamed, name: 'Inspect' }]), {}, {}, { presentation: 'run' })
      .nodesById.get(unnamed.id)?.label).toBe('Inspect');
  });
  it('keeps a Discussion outcomes read plain while retaining external Action final outputs', () => {
    const project = (actionId: string) => projectWorkflowFlow({ ...definition([
      { kind: 'action', id: 'outcomes', name: 'Answer outcomes', actionId, input: {} },
    ]), finalOutput: { kind: 'result', producer: { blockId: 'outcomes', scope: { kind: 'current' } }, path: [] } });
    expect(project('workflow.discussion.round.project').nodesById.get('outcomes')?.finalOutput === true).toBe(false);
    expect(project('plugin:external/read').nodesById.get('outcomes')?.finalOutput).toBe(true);
  });
  it('carries the condition sentence from each definition scope into its If node', () => {
    const condition = { kind: 'compare' as const, operator: 'eq' as const,
      left: { kind: 'result' as const, producer: { blockId: 'check', scope: { kind: 'current' as const } }, path: ['approved'] },
      right: { kind: 'literal' as const, value: false } };
    const child = definition([{ ...step('check'), name: 'Panel check' },
      { kind: 'if', id: 'decide', when: condition, then: [], otherwise: [] }]);
    const projection = projectWorkflowFlow(definition([{ ...step('check'), name: 'Parent check' },
      { kind: 'workflow', id: 'panel', workflowRef: 'external:panel', input: {} }]), { 'external:panel': child });
    const sentence = projection.nodesById.get(JSON.stringify(['panel', 'decide']))?.labelDetail;
    expect(sentence).toContain('Panel check');
    expect(sentence).not.toContain('Parent check');
    expect(sentence).toContain(t('workflows.condition.operatorEq'));
    expect(sentence).toContain(t('common.no'));
  });
  it('reads an unset condition as Always on a Run map and leaves the editor map unchanged (N6)', () => {
    const unset = { kind: 'exists' as const, value: { kind: 'literal' as const, value: true } };
    const blocks = definition([{ kind: 'if', id: 'gate', when: unset, then: [step('ship')], otherwise: [] }]);
    const authoring = projectWorkflowFlow(blocks).nodesById.get('gate')?.labelDetail;
    expect(projectWorkflowFlow(blocks, {}, {}, { presentation: 'run' }).nodesById.get('gate')?.labelDetail)
      .toBe(t('workflows.condition.always'));
    expect(authoring).not.toBe(t('workflows.condition.always'));
    expect(projectWorkflowFlow(blocks, {}, {}, { presentation: 'authoring' }).nodesById.get('gate')?.labelDetail).toBe(authoring);
  });
  it('prints nothing under a named Run map condition that always holds, never "If Always" (FIN-DESIGN-ACCEPT-2 F14)', () => {
    const unset = { kind: 'exists' as const, value: { kind: 'literal' as const, value: true } };
    const blocks = definition([{ kind: 'if', id: 'gate', name: 'Use the review path', when: unset, then: [step('ship')], otherwise: [] }]);
    const node = projectWorkflowFlow(blocks, {}, {}, { presentation: 'run' }).nodesById.get('gate');
    expect(node?.label).toBe('Use the review path');
    expect(node?.labelDetail ?? null).toBeNull();
  });
  it('keeps the If in a named condition so the map reads as a condition, like the editor (lab run-A)', () => {
    const condition = { kind: 'compare' as const, operator: 'eq' as const,
      left: { kind: 'result' as const, producer: { blockId: 'check', scope: { kind: 'current' as const } }, path: ['approved'] },
      right: { kind: 'literal' as const, value: false } };
    const projection = projectWorkflowFlow(definition([{ ...step('check'), name: 'Check the fix' },
      { kind: 'if', id: 'decide', name: 'Reopen when needed', when: condition, then: [], otherwise: [] }]));
    const node = projection.nodesById.get('decide');
    expect(node?.label).toBe('Reopen when needed');
    expect(node?.labelDetail?.startsWith(t('workflows.page.inspector.ifSentence', { condition: '' }).trim())).toBe(true);
    expect(node?.labelDetail).toContain('Check the fix');
  });
  it('uses five authored steps for a release with three lanes and a repeated issue check', () => {
    const wait = (id: string) => ({ kind: 'wait' as const, id, document: { text: id, references: [], attachments: [] } });
    const source = definition([wait('scope'), { kind: 'parallel', id: 'lanes', failurePolicy: 'collect_outcomes', branches: [
      { id: 'changelog', blocks: [wait('draft')] },
      { id: 'issues', blocks: [{ kind: 'loop', id: 'each-issue', repetition: { kind: 'items',
        items: { kind: 'literal', value: ['#1480', '#1482', '#1487'] }, execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [wait('check')] }] },
      { id: 'tests', blocks: [wait('test')] },
    ] }, wait('publish')]);
    const projection = projectWorkflowFlow(source);
    expect(countWorkflowStepsV1(source.blocks)).toBe(5);
    expect(['scope', 'draft', 'check', 'test', 'publish'].map(id => projection.nodesById.get(id)?.stepOrdinal)).toEqual(['1', '2', '3', '4', '5']);
  });
  it('keeps authored names authoritative over presentation labels for leaves and containers', () => {
    const projection = projectWorkflowFlow(definition([
      { ...step('inspect'), name: 'Inspect the change' },
      { kind: 'loop', id: 'repeat', name: 'Keep going', body: [], repetition: { kind: 'count', count: { kind: 'literal', value: 2 } } },
    ]), {}, { inspect: 'Catalog label' });
    expect(projection.nodesById.get('inspect')?.label).toBe('Inspect the change');
    expect(projection.nodesById.get('repeat')?.label).toBe('Keep going');
  });
  it('uses catalog-declared labels without inferring them from prompts or changing structure', () => {
    const source = definition([step('ask', 'An entire authored prompt'), step('other')]);
    const projection = projectWorkflowFlow(source, {}, { ask: 'Ask' });
    expect(projection.nodesById.get('ask')?.label).toBe('Ask');
    expect(projection.nodesById.get('other')?.label).toBe(t('workflows.editor.addStep'));
    expect(projection.rootNodeIds).toEqual(['ask', 'other']);
    expect(source.blocks[0]).toEqual(step('ask', 'An entire authored prompt'));
  });
  it('keeps Action, Workflow and Wait leaves in authored order and targets their owning editor', () => {
    const projection = projectWorkflowFlow(definition([
      { kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: {} },
      { kind: 'workflow', id: 'review', workflowRef: 'builtin:review', input: {} },
      { kind: 'wait', id: 'confirm', document: { text: 'Approve the release', references: [], attachments: [] } },
    ]));
    expect(projection.rootNodeIds).toEqual(['notify', 'review', 'confirm']);
    expect(projection.nodes.map((node) => node.kind)).toEqual(['action', 'workflow', 'wait']);
    for (const id of ['notify', 'review', 'confirm']) {
      expect(resolveWorkflowFlowEditTarget(projection, id)).toEqual({ kind: 'block', blockId: id });
    }
  });

  it('projects reused child definitions as separate containers without colliding with parent or deeper child ids', () => {
    const call = (id: string, workflowRef: string) => ({ kind: 'workflow' as const, id, workflowRef, input: {} });
    const projection = projectWorkflowFlow(definition([
      step('same'), call('left', 'builtin:review'), call('right', 'builtin:review'),
    ]), {
      'builtin:review': definition([step('same'), call('inner', 'builtin:plan')]),
      'builtin:plan': definition([step('same')]),
    });
    expect(projection.nodes).toHaveLength(9);
    const left = projection.nodesById.get('left')!;
    const right = projection.nodesById.get('right')!;
    expect(left.childNodeIds).toHaveLength(2);
    expect(right.childNodeIds).toHaveLength(2);
    expect(new Set(projection.nodes.map((node) => node.nodeId)).size).toBe(9);
    expect(left.childNodeIds).not.toEqual(right.childNodeIds);
    const inner = projection.nodesById.get(left.childNodeIds[1]!)!;
    expect(inner.childNodeIds).toHaveLength(1);
    // Called definitions are read-only here; editing reveals the containing call.
    expect(resolveWorkflowFlowEditTarget(projection, inner.childNodeIds[0]!)).toEqual({ kind: 'block', blockId: 'left' });
  });

  it('projects ordered root steps with 1-based rail ordinals and no parent', () => {
    const projection = projectWorkflowFlow(definition([step('analyze'), step('implement')]));
    expect(projection.source).toBe('definition');
    expect(projection.relationships).toBe('authored');
    expect(projection.rootNodeIds).toEqual(['analyze', 'implement']);
    expect(projection.nodesById.get('implement')).toMatchObject({ ordinal: 2, depth: 0, parentNodeId: null });
  });

  it('names agent nodes by their kind without clipping authored prompt content into titles', () => {
    const projection = projectWorkflowFlow(definition([
      step('a', '\n  Analyze the repository  \nthen report'),
      step('b', 'Implement the safe plan'),
    ]));
    expect(projection.nodesById.get('a')?.label).toBe(t('workflows.editor.addStep'));
    expect(projection.nodesById.get('b')?.label).toBe(t('workflows.editor.addStep'));
  });

  it('uses the document vocabulary for conditional and repeating containers', () => {
    const projection = projectWorkflowFlow(definition([
      { kind: 'loop', id: 'loop-opaque', body: [], repetition: { kind: 'count', count: { kind: 'literal', value: 2 } } },
      { kind: 'if', id: 'condition-opaque', when: { kind: 'exists', value: { kind: 'literal', value: true } }, then: [], otherwise: [] },
    ]));
    expect(projection.nodesById.get('loop-opaque')?.label).toBe(t('workflows.editor.addLoop'));
    expect(projection.nodesById.get('condition-opaque')?.label).toBe(t('workflows.editor.addIf'));
  });

  it('uses localized structural labels with position for unnamed containers and branches', () => {
    const projection = projectWorkflowFlow(definition([{
      kind: 'parallel',
      id: 'checks',
      failurePolicy: 'fail_stop',
      branches: [{ id: 'lint', blocks: [step('run-lint')] }],
    }]));
    // An unnamed fork reads as its kind, its lane count the quiet detail beside it (DESIGN-9 P5).
    expect(projection.nodesById.get('checks')?.label).toBe(t('workflows.editor.addParallel'));
    expect(projection.nodesById.get('checks')?.labelDetail).toContain('1');
    expect(projection.nodesById.get('checks#lint')?.label).toContain('1');
  });

  it('projects parallel branches as their own nodes carrying the authored policy', () => {
    const projection = projectWorkflowFlow(definition([{
      kind: 'parallel',
      id: 'checks',
      failurePolicy: 'collect_outcomes',
      maxConcurrent: 3,
      branches: [
        { id: 'lint', blocks: [step('run-lint')] },
        { id: 'test', blocks: [step('run-test')] },
      ],
    }]));

    const group = projection.nodesById.get('checks');
    expect(group).toMatchObject({ kind: 'parallel', failurePolicy: 'collect_outcomes', maxConcurrent: 3 });
    expect(group?.childNodeIds).toEqual(['checks#lint', 'checks#test']);
    expect(projection.nodesById.get('checks#lint')).toMatchObject({ kind: 'branch', blockId: 'lint', depth: 1 });
    expect(projection.nodesById.get('run-lint')).toMatchObject({ parentNodeId: 'checks#lint', depth: 2 });
  });

  it('omits maxConcurrent entirely when the author set none, rather than inventing a number', () => {
    const projection = projectWorkflowFlow(definition([{
      kind: 'parallel',
      id: 'checks',
      failurePolicy: 'fail_stop',
      branches: [{ id: 'only', blocks: [step('a')] }],
    }]));
    expect(projection.nodesById.get('checks')).not.toHaveProperty('maxConcurrent');
  });

  it('places the loop continuation after the body and summarizes the repetition', () => {
    const projection = projectWorkflowFlow(definition([{
      kind: 'loop',
      id: 'judge',
      repetition: {
        kind: 'evaluate',
        maxIterations: 3,
        history: 'latest',
        evaluator: { ...step('judge-step'), result: { kind: 'decision', decisions: ['continue', 'stop'] } },
      },
      body: [step('summarize')],
    }]));

    expect(projection.nodesById.get('judge')?.repetition).toEqual({ kind: 'evaluate', maxIterations: 3 });
    expect(projection.nodesById.get('judge')?.childNodeIds).toEqual(['summarize', 'judge-step']);
    expect(projection.nodesById.get('judge-step')).toMatchObject({ kind: 'evaluator', ordinal: 2 });
  });

  it('carries the item loop policy onto the loop node and keeps the body ordered', () => {
    const projection = projectWorkflowFlow(definition([{
      kind: 'loop',
      id: 'review-files',
      repetition: {
        kind: 'items',
        items: { kind: 'literal', value: ['a', 'b'] },
        execution: 'parallel',
        failurePolicy: 'collect_outcomes',
        maxConcurrent: 4,
      },
      body: [step('inspect'), step('repair'), step('review')],
    }]));

    expect(projection.nodesById.get('review-files')).toMatchObject({
      failurePolicy: 'collect_outcomes',
      maxConcurrent: 4,
      repetition: { kind: 'items', itemExecution: 'parallel', failurePolicy: 'collect_outcomes', maxConcurrent: 4 },
    });
    expect(projection.nodesById.get('review-files')?.childNodeIds).toEqual(['inspect', 'repair', 'review']);
  });

  it('renders an if with a then branch, and an otherwise branch only when authored', () => {
    const withoutOtherwise = projectWorkflowFlow(definition([{
      kind: 'if',
      id: 'gate',
      when: { kind: 'exists', value: { kind: 'literal', value: true } },
      then: [step('a')],
      otherwise: [],
    }]));
    expect(withoutOtherwise.nodesById.get('gate')?.childNodeIds).toEqual(['gate#then']);

    const withOtherwise = projectWorkflowFlow(definition([{
      kind: 'if',
      id: 'gate',
      when: { kind: 'exists', value: { kind: 'literal', value: true } },
      then: [step('a')],
      otherwise: [step('b')],
    }]));
    expect(withOtherwise.nodesById.get('gate')?.childNodeIds).toEqual(['gate#then', 'gate#otherwise']);
    expect(withOtherwise.nodesById.get('b')?.parentNodeId).toBe('gate#otherwise');
  });

  /**
   * Edit must land on something the editor can actually reveal. A branch frame
   * is not a block — `findWorkflowBlock` cannot find `lint` — so its Edit
   * target is the group that owns it; a step or evaluator targets its own
   * prompt; a container targets itself.
   */
  it('resolves Edit to a real authored block and says whether it is a prompt or a block', () => {
    const projection = projectWorkflowFlow(definition([
      {
        kind: 'parallel',
        id: 'checks',
        failurePolicy: 'fail_stop',
        branches: [{ id: 'lint', blocks: [step('run-lint')] }],
      },
      {
        kind: 'loop',
        id: 'judge',
        repetition: {
          kind: 'evaluate',
          maxIterations: 3,
          history: 'latest',
          evaluator: { ...step('judge-step'), result: { kind: 'decision', decisions: ['continue', 'stop'] } },
        },
        body: [step('summarize')],
      },
      {
        kind: 'if',
        id: 'gate',
        when: { kind: 'exists', value: { kind: 'literal', value: true } },
        then: [step('a')],
        otherwise: [step('b')],
      },
    ]));
    expect(resolveWorkflowFlowEditTarget(projection, 'run-lint')).toEqual({ kind: 'prompt', blockId: 'run-lint' });
    expect(resolveWorkflowFlowEditTarget(projection, 'judge-step')).toEqual({ kind: 'prompt', blockId: 'judge-step' });
    expect(resolveWorkflowFlowEditTarget(projection, 'checks')).toEqual({ kind: 'block', blockId: 'checks' });
    expect(resolveWorkflowFlowEditTarget(projection, 'checks#lint')).toEqual({ kind: 'block', blockId: 'checks' });
    expect(resolveWorkflowFlowEditTarget(projection, 'gate#then')).toEqual({ kind: 'block', blockId: 'gate' });
    expect(resolveWorkflowFlowEditTarget(projection, 'gate#otherwise')).toEqual({ kind: 'block', blockId: 'gate' });
    expect(resolveWorkflowFlowEditTarget(projection, 'nope')).toBeNull();
  });

  it('projects a 100-step definition without truncating the authored structure', () => {
    const projection = projectWorkflowFlow(definition(
      Array.from({ length: 100 }, (_unused, index) => step(`step-${index}`)),
    ));
    expect(projection.nodes).toHaveLength(100);
    expect(projection.rootNodeIds.at(-1)).toBe('step-99');
  });
});

describe('observed activity flow projection', () => {
  const snapshot: SessionWorkflowRunSnapshotV1 = {
    v: 1,
    projectionVersion: 1,
    runId: 'run-1',
    backendId: 'claude',
    title: 'Observed run',
    status: 'active',
    recordRevision: '1-1',
    updatedAt: 1,
    totalAgents: 3,
    completedAgents: 1,
    phases: [
      { id: 'phase-2', title: 'Implement', order: 2, agentIds: ['agent-b'] },
      { id: 'phase-1', title: 'Analyze', order: 1, agentIds: ['agent-a'] },
    ],
    agents: [
      { id: 'agent-a', title: 'Analyzer', status: 'complete', updatedAt: 1 },
      { id: 'agent-b', title: 'Implementer', status: 'active', updatedAt: 1 },
      { id: 'agent-c', title: 'Unassigned worker', status: 'pending', updatedAt: 1 },
    ],
  } as SessionWorkflowRunSnapshotV1;

  it('marks relationships unknown so no directional dependency is implied', () => {
    const projection = projectObservedWorkflowFlow(snapshot);
    expect(projection.source).toBe('observed');
    expect(projection.relationships).toBe('unknown');
    expect(projection.nodes.every((node) => node.observed)).toBe(true);
  });

  it('orders phases by their recorded order and nests only the agents they name', () => {
    const projection = projectObservedWorkflowFlow(snapshot);
    expect(projection.rootNodeIds).toEqual(['phase:phase-1', 'phase:phase-2', 'agent:agent-c']);
    expect(projection.nodesById.get('phase:phase-1')?.childNodeIds).toEqual(['agent:agent-a']);
    expect(projection.nodesById.get('agent:agent-a')?.observedStatus).toBe('complete');
  });

  it('keeps an unassigned agent visible at the root rather than guessing a phase', () => {
    const projection = projectObservedWorkflowFlow(snapshot);
    expect(projection.nodesById.get('agent:agent-c')).toMatchObject({ parentNodeId: null, depth: 0 });
  });

  it('offers no editable target for an observed node', () => {
    const projection = projectObservedWorkflowFlow(snapshot);
    expect(resolveWorkflowFlowEditTarget(projection, 'agent:agent-a')).toBeNull();
    expect(resolveWorkflowFlowEditTarget(projection, 'phase:phase-1')).toBeNull();
  });

  it('carries no failure policy, concurrency or repetition onto observed nodes', () => {
    const projection = projectObservedWorkflowFlow(snapshot);
    for (const node of projection.nodes) {
      expect(node).not.toHaveProperty('failurePolicy');
      expect(node).not.toHaveProperty('maxConcurrent');
      expect(node).not.toHaveProperty('repetition');
    }
  });
});

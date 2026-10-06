import { describe, expect, it } from 'vitest';

import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';
import { t } from '@/text';

import {
  indexWorkflowFlowRunStates,
  projectObservedWorkflowFlow,
  projectWorkflowFlow,
  resolveWorkflowFlowAncestry,
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
    expect(projection.nodesById.get('checks')?.label).toContain('1');
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

  it('reports ancestry so a nested node keeps its group and iteration context', () => {
    const projection = projectWorkflowFlow(definition([{
      kind: 'parallel',
      id: 'checks',
      failurePolicy: 'fail_stop',
      branches: [{ id: 'lint', blocks: [step('run-lint')] }],
    }]));
    expect(resolveWorkflowFlowAncestry(projection, 'run-lint').map((node) => node.nodeId))
      .toEqual(['checks', 'checks#lint']);
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

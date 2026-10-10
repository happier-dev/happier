import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema } from './workflowV1.js';
import { deriveWorkflowDestinationsV1 } from './workflowDestinationsV1.js';
import { listWorkflowBlockOrdinalsV1 } from './workflowStepLabel.js';
import type { WorkflowStep, WorkflowDefinitionV1 } from './workflowV1.js';

describe('workflow destination presentation', () => {
  it('carries canonical visible ordinals across containers without changing the Session relation', () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1,
      defaults: { conversation: { kind: 'existing_session', sessionId: 'destination', machineId: 'machine-one' } },
      blocks: [{ kind: 'step', id: 'first', name: 'Check', document: { text: 'Check', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        { kind: 'parallel', id: 'parallel', failurePolicy: 'fail_stop', branches: [{ id: 'branch', blocks: [
          { kind: 'step', id: 'second', name: 'Report', document: { text: 'Report', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        ] }] }] });
    expect(deriveWorkflowDestinationsV1({ definition })).toMatchObject({ targetSessionIds: ['destination'],
      leaves: [{ blockId: 'first', ordinal: 1, name: 'Check' }, { blockId: 'second', ordinal: 2, name: 'Report' }] });
  });
  it('uses the canonical prompt fallback for an unnamed destination step', () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, blocks: [
      { kind: 'step', id: 'step-id', document: { text: 'Write the report', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
    ] });
    expect(deriveWorkflowDestinationsV1({ definition }).leaves[0]).toMatchObject({ ordinal: 1, name: 'Write the report' });
  });
  it('uses the same numbering for authored and accepted parallel, conditional, loop and nested leaves', () => {
    const leaf = (id: string): WorkflowStep => ({ kind: 'step', id, name: id,
      document: { text: id, references: [], attachments: [] }, input: [], result: { kind: 'text' } });
    const defaults = { conversation: { kind: 'existing_session' as const, sessionId: 'destination', machineId: 'machine-one' } };
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults, blocks: [leaf('first'),
      { kind: 'parallel', id: 'parallel', failurePolicy: 'fail_stop', branches: [
        { id: 'left', blocks: [leaf('second')] }, { id: 'right', blocks: [leaf('third')] }] },
      { kind: 'if', id: 'choice', when: { kind: 'exists', value: { kind: 'literal', value: true } },
        then: [leaf('fourth')], otherwise: [leaf('fifth')] },
      { kind: 'loop', id: 'loop', body: [leaf('sixth')], repetition: { kind: 'evaluate', maxIterations: 2, history: 'none',
        evaluator: { ...leaf('seventh'), result: { kind: 'decision', decisions: ['continue', 'done'] } } } },
      { kind: 'workflow', id: 'child', workflowRef: 'builtin:child', input: {} }, leaf('ninth')] };
    const child: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults, blocks: [
      { kind: 'parallel', id: 'child-parallel', failurePolicy: 'fail_stop', branches: [
        { id: 'child-left', blocks: [leaf('child-first')] }, { id: 'child-right', blocks: [leaf('child-second')] }] }] };
    const children = { 'builtin:child': child };
    const authored = deriveWorkflowDestinationsV1({ definition, children });
    expect(authored.leaves.map(entry => entry.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2]);
    for (const entry of authored.leaves) {
      const owner = listWorkflowBlockOrdinalsV1((entry.sourceKey === '$root' ? definition : child).blocks);
      expect(String(entry.ordinal)).toBe(owner.get(entry.blockId));
    }
    const accepted = deriveWorkflowDestinationsV1({ definition, children, materializedLeaves: authored.leaves.map(entry => ({
      sourceKey: entry.sourceKey, blockId: entry.blockId, selection: defaults,
      kind: entry.blockId === 'child' ? 'workflow' as const : 'step' as const,
      authoredWorkspace: { kind: 'inherit' as const }, executionTarget: { kind: 'session' as const },
    })) });
    expect(accepted).toEqual(authored);
  });
});

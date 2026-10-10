import { describe, expect, it } from 'vitest';

import type { WorkflowStep } from './workflowV1.js';
import { formatWorkflowStepSessionTitle, listWorkflowBlockOrdinalsV1, workflowBlockOrdinalV1, workflowStepPromptLabel } from './workflowStepLabel.js';
import type { WorkflowBlock } from './workflowV1.js';
import { createDeepWorkflowDefinition } from './workflowDefinition.testkit.js';

const step: WorkflowStep = {
  kind: 'step', id: 'work', document: { text: '', references: [], attachments: [] },
  input: [], result: { kind: 'text' },
};

describe('workflow step label', () => {
  it('numbers deep valid bodies without consuming the JavaScript call stack', () => {
    const definition = createDeepWorkflowDefinition(12_000);
    expect([...listWorkflowBlockOrdinalsV1(definition.blocks)]).toEqual([['leaf', '1']]);
    expect(workflowBlockOrdinalV1(definition.blocks, 'leaf')).toBe('1');
  });

  it('numbers the loop body before its evaluator and then before otherwise', () => {
    const leaf = (id: string): WorkflowStep => ({ ...step, id });
    const blocks: WorkflowBlock[] = [{ kind: 'loop', id: 'loop', body: [
      { kind: 'if', id: 'choice', when: { kind: 'exists', value: { kind: 'literal', value: true } },
        then: [leaf('yes')], otherwise: [leaf('no')] },
    ], repetition: { kind: 'evaluate', maxIterations: 2, history: 'none',
      evaluator: { ...leaf('judge'), result: { kind: 'decision', decisions: ['continue', 'done'] } },
    } }, leaf('after')];
    expect([...listWorkflowBlockOrdinalsV1(blocks)]).toEqual([['yes', '1'], ['no', '2'], ['judge', '3'], ['after', '4']]);
  });
  it('keeps the prompt fallback separate from the full authored Session name', () => {
    const name = 'Implement '.repeat(12).trim();
    const named = { ...step, name, document: { ...step.document, text: `\n ${'A'.repeat(61)}\nDetails` } };
    const label = `${'A'.repeat(60)}…`;
    expect(workflowStepPromptLabel(named)).toBe(label);
    expect(formatWorkflowStepSessionTitle({ step: named, stepOrdinal: '3' })).toBe(`3 · ${name}`);
  });

  it('leaves an unnamed step untitled so Session defaults apply', () => {
    const unnamed = { ...step, document: { ...step.document, text: 'A prompt is not an authored name' } };
    expect(formatWorkflowStepSessionTitle({ step: unnamed, stepOrdinal: '1' })).toBeNull();
  });

  it('labels per-item Sessions from scalar values or the canonical occurrence position', () => {
    const named = { ...step, name: 'Inspect' };
    expect(formatWorkflowStepSessionTitle({ step: named, stepOrdinal: '1', item: { value: '  parser.ts  ', position: 4 } })).toBe('1 · Inspect · parser.ts');
    expect(formatWorkflowStepSessionTitle({ step: named, stepOrdinal: '1', item: { value: 42, position: 4 } })).toBe('1 · Inspect · 42');
    expect(formatWorkflowStepSessionTitle({ step: named, stepOrdinal: '1', item: { value: { name: 'Not an occurrence label' }, position: 4 } })).toBe('1 · Inspect · 4');
    expect(formatWorkflowStepSessionTitle({ step: named, stepOrdinal: '1', item: { value: ' ', position: 4 } })).toBe('1 · Inspect · 4');
    expect(formatWorkflowStepSessionTitle({ step, stepOrdinal: '1', item: { value: 'parser.ts', position: 4 } })).toBeNull();
  });

  it('numbers leaves continuously in authored execution order and leaves containers unnumbered (lab E1)', () => {
    const leaf = (id: string): WorkflowBlock => ({ kind: 'step', id, document: { text: id, references: [], attachments: [] }, input: [], result: { kind: 'text' } });
    const blocks: WorkflowBlock[] = [
      leaf('gather'),
      { kind: 'parallel', id: 'lanes', failurePolicy: 'collect_outcomes', branches: [
        { id: 'changelog', blocks: [leaf('write')] },
        { id: 'issues', blocks: [{ kind: 'loop', id: 'each', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } }, body: [
          leaf('check'),
          { kind: 'if', id: 'failed', when: { kind: 'exists', value: { kind: 'literal', value: true } }, then: [leaf('reopen')], otherwise: [] },
        ] }] },
        { id: 'tests', blocks: [leaf('test')] },
      ] },
      { kind: 'workflow', id: 'review', workflowRef: 'builtin:review-and-converge', input: {} },
      leaf('publish'),
      { kind: 'action', id: 'announce', actionId: 'notifications.notify_me', input: {} },
    ];
    expect(Object.fromEntries(listWorkflowBlockOrdinalsV1(blocks))).toEqual({
      gather: '1', write: '2', check: '3', reopen: '4', test: '5', review: '6', publish: '7', announce: '8',
    });
    for (const container of ['lanes', 'each', 'failed']) expect(workflowBlockOrdinalV1(blocks, container)).toBeNull();
    // A step Session's title carries exactly the number its heading and map node show.
    const named = { ...(leaf('reopen') as Extract<WorkflowBlock, { kind: 'step' }>), name: 'Reopen with notes' };
    expect(formatWorkflowStepSessionTitle({ step: named, stepOrdinal: workflowBlockOrdinalV1(blocks, 'reopen')! })).toBe('4 · Reopen with notes');
  });
});

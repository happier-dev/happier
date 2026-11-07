import { describe, expect, it } from 'vitest';

import type { WorkflowStep } from './workflowV1.js';
import { formatWorkflowStepSessionTitle, listWorkflowBlockOrdinalsV1, readWorkflowSetupInstallPackagesV1, workflowBlockOrdinalV1,
  workflowDefinitionDisplayTitleV1, workflowStepPromptLabel } from './workflowStepLabel.js';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '../machines/managed/actionIdsV1.js';
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

  it('names an unnamed step Session from its prompt and ordinal instead of the project folder (FIN M3)', () => {
    const unnamed = { ...step, document: { ...step.document, text: '\n Inspect the parser\nKeep the details' } };
    expect(formatWorkflowStepSessionTitle({ step: unnamed, stepOrdinal: '1' })).toBe('1 · Inspect the parser');
    expect(formatWorkflowStepSessionTitle({ step: unnamed, stepOrdinal: '1', item: { value: 'alpha', position: 1 } }))
      .toBe('1 · Inspect the parser · alpha');
    expect(formatWorkflowStepSessionTitle({ step, stepOrdinal: '1' })).toBeNull();
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

describe('Machine setup install naming', () => {
  // The frozen Setup leaf a Bot template software install starts, as its reviewed Plan carries it.
  function setupLeaf(steps: readonly unknown[], nativeFacts: readonly unknown[] = []): WorkflowBlock {
    const target = { homeId: 'home', machineId: 'machine', sources: [{ kind: 'direct', setup: { items: [] } }], desiredRevision: 1,
      recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: { v: 1, basis: { kind: 'setup', machineId: 'machine', desiredRevision: 1 },
        steps, nativeFacts, planDigest: 'digest' } }], exclusions: [] };
    return { kind: 'action', id: 'setup-0', actionId: MACHINE_SETUP_APPLY_ACTION_ID_V1, input: {
      homeId: { kind: 'literal', value: 'home' }, machineId: { kind: 'literal', value: 'machine' },
      targets: { kind: 'literal', value: [target] as never },
    } } as WorkflowBlock;
  }
  const pkg = (packages: readonly Readonly<{ name: string; version?: string }>[], state = 'present') =>
    ({ id: 'package-apt', kind: 'package', manager: 'apt', state, packages });

  it('names an unnamed Setup Run after the software it installs', () => {
    expect(workflowDefinitionDisplayTitleV1([setupLeaf([pkg([{ name: 'sl' }])])])).toBe('Install sl');
    expect(workflowDefinitionDisplayTitleV1([setupLeaf([pkg([{ name: 'ripgrep', version: '14.1' }, { name: 'jq' }])])]))
      .toBe('Install 2 packages');
    expect(readWorkflowSetupInstallPackagesV1(setupLeaf([pkg([{ name: 'sl' }])]))).toEqual({ requested: ['sl'], installs: ['sl'] });
  });

  it('skips what is already there and names nothing it cannot say plainly', () => {
    // A package already there is still what the Run is for, but not something it installs.
    expect(readWorkflowSetupInstallPackagesV1(setupLeaf([pkg([{ name: 'sl' }]), pkg([{ name: 'jq' }])],
      [{ stepId: 'a', status: 'satisfied' }, { stepId: 'b', status: 'drifted' }]))).toEqual({ requested: ['sl', 'jq'], installs: ['jq'] });
    expect(workflowDefinitionDisplayTitleV1([setupLeaf([pkg([{ name: 'hello' }])], [{ stepId: 'a', status: 'satisfied' }])]))
      .toBe('Install hello');
    // Removals and other kinds of change keep the ordinary wording.
    expect(readWorkflowSetupInstallPackagesV1(setupLeaf([pkg([{ name: 'sl' }], 'absent')]))).toBeNull();
    expect(readWorkflowSetupInstallPackagesV1(setupLeaf([pkg([{ name: 'sl' }]), { id: 'f', kind: 'file', path: '/etc/x' }]))).toBeNull();
    expect(workflowDefinitionDisplayTitleV1([setupLeaf([{ id: 'f', kind: 'file', path: '/etc/x' }])])).toBeNull();
  });
});

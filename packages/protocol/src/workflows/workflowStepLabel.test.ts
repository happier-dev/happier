import { describe, expect, it } from 'vitest';

import type { WorkflowStep } from './workflowV1.js';
import { formatWorkflowStepSessionTitle, workflowStepPromptLabel } from './workflowStepLabel.js';

const step: WorkflowStep = {
  kind: 'step', id: 'work', document: { text: '', references: [], attachments: [] },
  input: [], result: { kind: 'text' },
};

describe('workflow step label', () => {
  it('keeps the prompt fallback separate from the full authored Session name', () => {
    const name = 'Implement '.repeat(12).trim();
    const named = { ...step, name, document: { ...step.document, text: `\n ${'A'.repeat(61)}\nDetails` } };
    const label = `${'A'.repeat(60)}…`;
    expect(workflowStepPromptLabel(named)).toBe(label);
    expect(formatWorkflowStepSessionTitle({ step: named, memberOrdinal: '2' })).toBe(`3 · ${name}`);
  });

  it('leaves an unnamed step untitled so Session defaults apply', () => {
    const unnamed = { ...step, document: { ...step.document, text: 'A prompt is not an authored name' } };
    expect(formatWorkflowStepSessionTitle({ step: unnamed, memberOrdinal: '0' })).toBeNull();
  });

  it('labels per-item Sessions from scalar values or the canonical occurrence position', () => {
    const named = { ...step, name: 'Inspect' };
    expect(formatWorkflowStepSessionTitle({ step: named, memberOrdinal: '0', item: { value: '  parser.ts  ', position: 4 } })).toBe('1 · Inspect · parser.ts');
    expect(formatWorkflowStepSessionTitle({ step: named, memberOrdinal: '0', item: { value: 42, position: 4 } })).toBe('1 · Inspect · 42');
    expect(formatWorkflowStepSessionTitle({ step: named, memberOrdinal: '0', item: { value: { name: 'Not an occurrence label' }, position: 4 } })).toBe('1 · Inspect · 4');
    expect(formatWorkflowStepSessionTitle({ step: named, memberOrdinal: '0', item: { value: ' ', position: 4 } })).toBe('1 · Inspect · 4');
    expect(formatWorkflowStepSessionTitle({ step, memberOrdinal: '0', item: { value: 'parser.ts', position: 4 } })).toBeNull();
  });
});

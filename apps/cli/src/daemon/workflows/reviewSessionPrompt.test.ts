import { expect, it } from 'vitest';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { ReviewStartTerminalValueV1Schema } from '@happier-dev/protocol/actions/specs/executionRunCompletion';
import { renderWorkflowSessionStepInput } from './sessionStepExecutor';

it('asks a Session reviewer for the complete current findings again on a new round', () => {
  const prompt = renderWorkflowSessionStepInput({ input: { text: 'Review total.ts again; the reducer still subtracts.', values: [
    { kind: 'review_session.v1', reviewerId: 'step-1-reviewer-1' },
    { reviewRound: { reviewId: 'review', roundOrdinal: 2 } },
  ] }, result: { kind: 'json', schema: zodSchemaToJsonSchemaObject(ReviewStartTerminalValueV1Schema) } });

  expect(prompt).toContain('complete current findings set');
  expect(prompt).toContain('including unresolved findings reported in previous rounds that still apply');
  expect(prompt).toContain('Do not omit a current finding merely because it was reported before');
});

it('leaves ordinary Session inputs free of review finding instructions', () => {
  const prompt = renderWorkflowSessionStepInput({ input: { text: 'Explain the module.', values: [] },
    roleInstructions: 'Be concise.', result: { kind: 'json', schema: { type: 'object' } } });

  expect(prompt).toContain('Be concise.\n\nExplain the module.');
  expect(prompt).not.toContain('complete current findings set');
  expect(prompt).not.toContain('quality.score');
});

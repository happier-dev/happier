import { describe, expect, it } from 'vitest';
import { WorkflowProgressEnvelopeV1Schema } from '../../workflows/workflowProgressV1.js';
import { createRecoveredWorkflowInvocationProgress } from './workflowInvocationRecoveryProgress.js';

describe('Workflow invocation recovery progress', () => {
  it('restores original no-input Agent work without inventing authored input or losing the conversation choice', () => {
    // The coordinator deliberately persists no authored input for inputMode:none.
    const prior = WorkflowProgressEnvelopeV1Schema.parse({
      kind: 'happier.workflow-progress.v1', blockKind: 'step',
      invocationPath: { blockId: 'after-loss', scope: [] }, attempt: '0',
      logicalInvocationRecordId: '33333333-3333-4333-8333-333333333333',
      reason: { code: 'workspace_unavailable' },
    });
    const restored = createRecoveredWorkflowInvocationProgress({
      prior, priorRecordId: prior.logicalInvocationRecordId, attempt: '1',
      input: { kind: 'original' }, conversation: 'fresh_agent',
    });
    expect(restored).toMatchObject({
      attempt: '1', previousAttemptRecordId: prior.logicalInvocationRecordId,
      recovery: { conversation: 'fresh_agent', input: { kind: 'original' } },
    });
    expect(restored).not.toHaveProperty('input');
    expect(restored).not.toHaveProperty('reason');
  });
});

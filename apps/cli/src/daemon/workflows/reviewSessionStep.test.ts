import { expect, it } from 'vitest';
import { ReviewStartTerminalValueV1Schema } from '@happier-dev/protocol/actions/specs/executionRunCompletion';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';

import { createWorkflowSessionStepExecutor } from './sessionStepExecutor';
import { materializeWorkflowSessionReview } from './reviewSessionStep';

it.each(['complete', 'partial'] as const)('publishes a restored Session review as host receipts with %s coverage', async reviewOutcome => {
  const reviewRound = { reviewId: 'actual-review', roundOrdinal: 2 };
  const rawText = JSON.stringify({ reviewOutcome, summary: 'Inspected.', overviewMarkdown: 'Inspected.', findings: [],
    questions: [], assumptions: [], reviewRound: { reviewId: 'model-invented', roundOrdinal: 99 },
    commentIds: ['model-invented'], perEngineOutcome: [] });
  const execute = createWorkflowSessionStepExecutor({
    credentials: { token: 'token', encryption: null },
    prepareConversation: async () => { throw new Error('An admitted input is observed in place'); },
    materializeConversation: async () => { throw new Error('An admitted input is observed in place'); },
    sessionInput: {
      enqueue: async () => { throw new Error('An admitted input is observed in place'); },
      observe: async () => ({ ok: true, sessionId: 'actual-session', localId: 'actual-input',
        result: { kind: 'final_text', text: rawText } }),
    },
    materializeReview: input => materializeWorkflowSessionReview({ ...input, context: { surface: 'agent' },
      agentId: 'actual-agent', serverId: 'actual-home', workspace: { machineId: 'machine', path: '/repo' },
      comments: async () => { throw new Error('Empty findings do not publish a comment'); },
    }),
  });
  const result = await execute({ runId: 'actual-workflow',
    step: { kind: 'step', id: 'review', document: { text: 'Inspect', references: [], attachments: [] }, input: [],
      result: { kind: 'json', schema: zodSchemaToJsonSchemaObject(ReviewStartTerminalValueV1Schema) } },
    invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'review', scope: [] },
      attempt: '1', logicalInvocationRecordId: 'actual-invocation',
      execution: { kind: 'session', sessionId: 'actual-session', localInputId: 'actual-input' } },
    input: { text: 'Inspect', references: [], attachments: [], values: [{ reviewRound },
      { kind: 'review_session.v1', reviewerId: 'step-1-reviewer-1' }] },
    execution: {}, executionTarget: { kind: 'session' },
    authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
    workspace: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' },
    beforeInputAdmission: async () => { throw new Error('An admitted input is observed in place'); }, onInputAccepted: async () => {},
  });
  expect(result).toEqual({ kind: 'completed', resultEncoding: 'typed', result: {
    reviewRound, reviewedFingerprint: null, commentIds: [],
    perEngineOutcome: [{ key: 'step-1-reviewer-1', outcome: 'completed', reviewOutcome, materialization: { kind: 'complete' },
      finishedAt: expect.any(Number) }],
  } });
});

import { expect, it } from 'vitest';
import { ReviewStartTerminalValueV1Schema } from '@happier-dev/protocol/actions/specs/executionRunCompletion';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import type { SessionMessageReplyOutcomeV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';

import { createWorkflowSessionStepExecutor } from './sessionStepExecutor';
import { materializeWorkflowSessionReview } from './reviewSessionStep';
import { WORKFLOW_SESSION_REPLY_SECRET_MASKED_CODE } from '@happier-dev/protocol/workflows/workflowResultFieldsV1';
import { TRANSCRIPT_SECRET_REDACTED } from '@/api/session/client/transport/transcriptSecretRedaction';

const reviewRound = { reviewId: 'actual-review', roundOrdinal: 2 };

async function executeSessionReview(reply: string | SessionMessageReplyOutcomeV1) {
  const execute = createWorkflowSessionStepExecutor({
    credentials: { token: 'token', encryption: null },
    prepareConversation: async () => { throw new Error('An admitted input is observed in place'); },
    materializeConversation: async () => { throw new Error('An admitted input is observed in place'); },
    sessionInput: {
      enqueue: async () => { throw new Error('An admitted input is observed in place'); },
      observe: async () => ({ ok: true, sessionId: 'actual-session', localId: 'actual-input',
        result: typeof reply === 'string' ? { kind: 'final_text', text: reply } : { kind: 'fulfilled', outcome: reply } }),
    },
    materializeReview: input => materializeWorkflowSessionReview({ ...input, context: { surface: 'agent' },
      agentId: 'actual-agent', serverId: 'actual-home', workspace: { machineId: 'machine', path: '/repo' },
      comments: async () => { throw new Error('Empty findings do not publish a comment'); },
    }),
  });
  return await execute({ runId: 'actual-workflow',
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
}

it.each(['complete', 'partial'] as const)('publishes a restored Session review as host receipts with %s coverage', async reviewOutcome => {
  const rawText = JSON.stringify({ reviewOutcome, summary: 'Inspected.', overviewMarkdown: 'Inspected.', findings: [],
    questions: [], assumptions: [], reviewRound: { reviewId: 'model-invented', roundOrdinal: 99 },
    commentIds: ['model-invented'], perEngineOutcome: [] });
  const result = await executeSessionReview(rawText);
  expect(result).toEqual({ kind: 'completed', resultEncoding: 'typed', result: {
    reviewRound, reviewedFingerprint: null, commentIds: [],
    perEngineOutcome: [{ key: 'step-1-reviewer-1', outcome: 'completed', reviewOutcome, materialization: { kind: 'complete' },
      finishedAt: expect.any(Number) }],
  } });
});

it('names secret masking when the stored Session review reply no longer parses', async () => {
  // The reply as the transcript writer stored it: a registered secret replaced part of the JSON.
  expect(await executeSessionReview(`{"reviewOutcome":"complete","findings":[{"line":${TRANSCRIPT_SECRET_REDACTED}2}]}`))
    .toMatchObject({ kind: 'completed', result: { reviewRound, perEngineOutcome: [
      { key: 'step-1-reviewer-1', outcome: 'failed', errorCode: WORKFLOW_SESSION_REPLY_SECRET_MASKED_CODE },
    ] } });
  expect(await executeSessionReview('not a review')).toMatchObject({ kind: 'completed', result: { reviewRound,
    perEngineOutcome: [{ key: 'step-1-reviewer-1', outcome: 'failed', errorCode: 'invalid_output' }] } });
});

it('retains failed Session review receipts while leaving attention and cancellation with the Session owner', async () => {
  const issue = { v: 1 as const, scope: 'primary_session' as const, status: 'failed' as const,
    code: 'agent_cli_not_ready', source: 'agent_session_error' as const, occurredAt: 1 };
  const failed = await executeSessionReview({ kind: 'failed', runtimeIssueV1: issue });
  expect(failed).toMatchObject({ kind: 'completed', resultEncoding: 'typed', result: { reviewRound,
    perEngineOutcome: [{ key: 'step-1-reviewer-1', outcome: 'failed', errorCode: 'session_input_failed', runtimeIssueV1: issue }] } });
  if (failed.kind !== 'completed') throw new Error('Expected a retained Review receipt');
  expect(ReviewStartTerminalValueV1Schema.safeParse(failed.result).success).toBe(true);
  expect(await executeSessionReview({ kind: 'failed', runtimeIssueV1: { ...issue, source: 'usage_limit' } }))
    .toMatchObject({ kind: 'needs_attention', code: 'session_input_failed' });
  expect(await executeSessionReview({ kind: 'cancelled' })).toMatchObject({ kind: 'cancelled', code: 'session_input_cancelled' });
});

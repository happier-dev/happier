import { z } from '../zodRuntimePolicy.js';
import { DiscussionWorkflowProducerV1Schema, type DiscussionWorkflowProducerV1, type DiscussionMessageContentV1 } from '../discussions/content.js';
import { WorkflowDiscussionOriginV1Schema } from './workflowDestinationsV1.js';
import { SessionMessageDiscussionReplyReturnV1Schema } from '../sessions/messages/sessionMessageReplyV1.js';
import type { JsonValue } from '../json/strictJsonValue.js';

/** Host-only publication custody carried by the existing Action approval owner. */
export const DiscussionWorkflowReplyReturnV1Schema = z.strictObject({
  kind: z.literal('workflow_invocation'), serverId: z.string().check(z.minLength(1)),
  producer: DiscussionWorkflowProducerV1Schema, origin: WorkflowDiscussionOriginV1Schema,
  expectedParentRevision: z.optional(z.number().check(z.int(), z.minimum(0))),
});
export const DiscussionReplyReturnV1Schema = z.union([SessionMessageDiscussionReplyReturnV1Schema, DiscussionWorkflowReplyReturnV1Schema]);
export type DiscussionWorkflowReplyReturnV1 = z.infer<typeof DiscussionWorkflowReplyReturnV1Schema>;
export type DiscussionReplyReturnV1 = z.infer<typeof DiscussionReplyReturnV1Schema>;

/** Run rows present stopped/failed outcomes; only completed leaves publish answers (C4 §4.4–4.5). */
export function isWorkflowDiscussionResultPublishableV1(input: Readonly<{
  blockKind: string; lifecycle: string; execution?: Readonly<{ kind: string; actionId?: string }>;
}>): boolean {
  return ['step', 'action'].includes(input.blockKind)
    && input.lifecycle === 'completed'
    && !(input.execution?.kind === 'action' && input.execution.actionId === 'workflow.discussion.round.project');
}

/** A Workflow leaf uses its real execution identity, never a surrogate Session. */
export function projectWorkflowDiscussionProducerV1(input: Readonly<{
  runId: string; invocationRecordId: string; invocationAttempt: string; blockKind: string;
  lifecycle: string; result?: JsonValue;
  execution?: Readonly<{ kind: string; actionId?: string; runId?: string }>;
}>): DiscussionWorkflowProducerV1 | null {
  if (!isWorkflowDiscussionResultPublishableV1(input)) return null;
  const execution = input.execution;
  if (execution?.kind !== 'action' && execution?.kind !== 'detached_run') return null;
  const parsed = DiscussionWorkflowProducerV1Schema.safeParse({ v: 1, kind: 'workflow',
    runId: input.runId, invocationRecordId: input.invocationRecordId, invocationAttempt: input.invocationAttempt,
    execution: execution?.kind === 'action' ? { kind: 'action', actionId: execution.actionId }
      : { kind: 'detached_run', executionRunId: execution.runId },
    outcome: input.result === undefined ? 'terminal_no_result' : 'answer' });
  return parsed.success ? parsed.data : null;
}

/** The accepted result's public projection, shared by the producer and trusted publication verifier. */
export function projectWorkflowDiscussionResultContentV1(input: Readonly<{
  runId: string; invocationRecordId: string; invocationAttempt: string;
  lifecycle: string; result?: JsonValue;
}>): DiscussionMessageContentV1 | null {
  // Keep terminal outcomes and any partial values in Run history. The Run row
  // renders the localized state without a second stored-English message.
  if (input.lifecycle !== 'completed') return null;
  if (typeof input.result === 'string' && input.result.trim()) return { v: 1, parts: [{ t: 'text', text: input.result }] };
  const summary = input.result === undefined ? 'The requested work finished without an answer.' : 'The requested work finished.';
  // Typed values belong to invocation history. The stamped producer already
  // gives Discussion readers the exact Run link; publishing the value here
  // exposes Action plumbing as another answer after the synthesis.
  return { v: 1, parts: [{ t: 'text', text: summary }] };
}

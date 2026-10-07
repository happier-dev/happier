import { z } from 'zod';

import { EXECUTION_RUN_COMPLETION_SUMMARY_MAX_LENGTH, ExecutionRunCompletionV1Schema } from '../../execution/runs/completionInputV1.js';
import { ExecutionRunTerminalStatusSchema } from '../../execution/runs/waitForTerminal.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import {
  WorkflowInvocationRecordIdSchema,
  WorkflowRunIdV1Schema,
} from '../../workflows/workflowIdsV1.js';
import { WorkflowRunStateV1Schema } from '../../workflows/workflowProgressV1.js';
import { ExecutionRunIdSchema, SessionIdSchema } from '../idsV1.js';

const WorkerUpdateSessionIdV1Schema = asProtocolZod<string, string>(SessionIdSchema);

/** Paths are portable workspace-relative wire paths, not arbitrary machine paths. */
export const WorkerDeliverableReferenceV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workspace_file'),
    sessionId: WorkerUpdateSessionIdV1Schema,
    path: z.string().min(1).refine(path => !path.includes('\0') && !path.includes('\\')
      && !path.startsWith('~') && !/^[a-zA-Z]:/.test(path)
      && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')),
  }).strict(),
  // The containing report supplies the Home. A ref cannot select a foreign Account.
  z.object({ kind: z.literal('artifact'), artifactId: z.string().min(1) }).strict(),
]);
export type WorkerDeliverableReferenceV1 = z.infer<typeof WorkerDeliverableReferenceV1Schema>;
export function workerDeliverablesBelongToSessionV1(deliverables: readonly WorkerDeliverableReferenceV1[] | undefined, sessionId: string | null | undefined): boolean {
  return !deliverables?.some(ref => ref.kind === 'workspace_file' && ref.sessionId !== sessionId);
}
const WorkerDeliverablesV1Schema = z.array(WorkerDeliverableReferenceV1Schema)
  .refine(refs => JSON.stringify(refs).length <= EXECUTION_RUN_COMPLETION_SUMMARY_MAX_LENGTH);

/** References share the existing result budget; no second retained payload. */
export function workerDeliverableResultMaxLengthV1(deliverables?: readonly WorkerDeliverableReferenceV1[]): number {
  return EXECUTION_RUN_COMPLETION_SUMMARY_MAX_LENGTH - (deliverables?.length ? JSON.stringify(deliverables).length : 0);
}
export function refineWorkerDeliverableResultV1(result: string | undefined, deliverables: readonly WorkerDeliverableReferenceV1[] | undefined, context: z.RefinementCtx, path: string): void {
  if ((result?.length ?? 0) > workerDeliverableResultMaxLengthV1(deliverables)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: 'Worker result and references exceed the completion result bound' });
  }
}
export const SessionWorkerPublishInputV1Schema = z.object({
  summary: ExecutionRunCompletionV1Schema.shape.summary.unwrap(),
  deliverables: WorkerDeliverablesV1Schema.optional(),
}).strict().superRefine((report, context) => refineWorkerDeliverableResultV1(report.summary, report.deliverables, context, 'summary'));
export type SessionWorkerPublishInputV1 = z.infer<typeof SessionWorkerPublishInputV1Schema>;
export const SessionWorkerPublishOutputV1Schema = z.object({
  sessionId: WorkerUpdateSessionIdV1Schema,
  leadSessionId: WorkerUpdateSessionIdV1Schema,
  localId: z.string().min(1),
}).strict();

/** Epoch 1: the envelope and every nested identity/engine object are closed. */
export const WorkerUpdateTranscriptPointerV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session'),
    sessionId: WorkerUpdateSessionIdV1Schema,
    seq: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    kind: z.literal('execution_run'),
    sessionId: WorkerUpdateSessionIdV1Schema,
    runId: ExecutionRunIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('workflow_run'),
    runId: WorkflowRunIdV1Schema,
    invocationRecordId: WorkflowInvocationRecordIdSchema.optional(),
  }).strict(),
]);
export type WorkerUpdateTranscriptPointerV1 = z.infer<typeof WorkerUpdateTranscriptPointerV1Schema>;

const WorkerUpdateFieldsV1Schema = z.object({
  v: z.literal(1),
  wake: z.enum(['finished', 'needs_you', 'stalled', 'published']),
  engine: z.object({
    agentId: z.string().min(1),
    modelId: z.string().min(1).optional(),
  }).strict().optional(),
  headline: z.string().min(1),
  // Preserve the incumbent completion owner's 8,000-character result bound.
  // Omitted when a proved send already delivered final text; status/pointer still wake the lead.
  result: ExecutionRunCompletionV1Schema.shape.summary.unwrap().optional(),
  deliverables: WorkerDeliverablesV1Schema.optional(),
  truncated: z.boolean().optional(),
  transcriptPointer: WorkerUpdateTranscriptPointerV1Schema.optional(),
  canInspect: z.boolean(),
}).strict();

export const WorkerUpdateV1Schema = z.discriminatedUnion('workerKind', [
  WorkerUpdateFieldsV1Schema.extend({
    workerKind: z.literal('session'),
    workerId: WorkerUpdateSessionIdV1Schema,
    ownerState: z.enum(['settled', 'failed', 'cancelled', 'needs_input', 'stalled', 'published']),
  }),
  WorkerUpdateFieldsV1Schema.extend({
    workerKind: z.literal('execution_run'),
    workerId: ExecutionRunIdSchema,
    ownerState: ExecutionRunTerminalStatusSchema,
  }),
  WorkerUpdateFieldsV1Schema.extend({
    workerKind: z.literal('workflow_run'),
    workerId: WorkflowRunIdV1Schema,
    ownerState: WorkflowRunStateV1Schema,
  }),
]).superRefine((update, context) => {
  refineWorkerDeliverableResultV1(update.result, update.deliverables, context, 'result');
  const sourceSessionId = update.workerKind === 'session' ? update.workerId
    : update.transcriptPointer?.kind === 'execution_run' ? update.transcriptPointer.sessionId : null;
  if (!workerDeliverablesBelongToSessionV1(update.deliverables, sourceSessionId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['deliverables'], message: 'Workspace deliverables must belong to the worker source Session' });
  }
  if (update.truncated === true && update.transcriptPointer === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['transcriptPointer'],
      message: 'A truncated worker update requires a transcript pointer',
    });
  }
});
export type WorkerUpdateV1 = z.infer<typeof WorkerUpdateV1Schema>;

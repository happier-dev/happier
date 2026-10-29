import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { EXECUTION_RUN_COMPLETION_SUMMARY_MAX_LENGTH, ExecutionRunCompletionV1Schema } from '../../execution/runs/completionInputV1.js';
import { ExecutionRunTerminalStatusSchema } from '../../execution/runs/waitForTerminal.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import {
  WorkflowInvocationRecordIdSchema,
  WorkflowRunIdV1Schema,
} from '../../workflows/workflowIdsV1.js';
import { WorkflowRunStateV1Schema } from '../../workflows/workflowProgressV1.js';
import { ExecutionRunIdSchema, SessionIdSchema } from '../idsV1.js';
import { SessionRuntimeIssueV1Schema } from '../control/runtimeIssueV1.js';
import type { FollowEventKindV1 } from '../follow/sessionFollowPolicyV1.js';
import { isTerminalAutomationRunStateV3 } from '../../automations/automationRunStateV3.js';

const WorkerUpdateSessionIdV1Schema = asProtocolZod<string, string>(SessionIdSchema);

/** Paths are portable workspace-relative wire paths, not arbitrary machine paths. */
export const WorkerDeliverableReferenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('workspace_file'),
    sessionId: WorkerUpdateSessionIdV1Schema,
    path: z.string().check(z.minLength(1), z.refine(path => !path.includes('\0') && !path.includes('\\')
      && !path.startsWith('~') && !/^[a-zA-Z]:/.test(path)
      && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'))),
  }),
  // The containing report supplies the Home. A ref cannot select a foreign Account.
  z.strictObject({ kind: z.literal('artifact'), artifactId: z.string().check(z.minLength(1)) }),
]));
export type WorkerDeliverableReferenceV1 = z.infer<typeof WorkerDeliverableReferenceV1Schema>;
export function workerDeliverablesBelongToSessionV1(deliverables: readonly WorkerDeliverableReferenceV1[] | undefined, sessionId: string | null | undefined): boolean {
  return !deliverables?.some(ref => ref.kind === 'workspace_file' && ref.sessionId !== sessionId);
}
const WorkerDeliverablesV1Schema = lazyZodSchema(() => z.array(WorkerDeliverableReferenceV1Schema).check(z.refine(refs => JSON.stringify(refs).length <= EXECUTION_RUN_COMPLETION_SUMMARY_MAX_LENGTH)));

/** References share the existing result budget; no second retained payload. */
export function workerDeliverableResultMaxLengthV1(deliverables?: readonly WorkerDeliverableReferenceV1[]): number {
  return EXECUTION_RUN_COMPLETION_SUMMARY_MAX_LENGTH - (deliverables?.length ? JSON.stringify(deliverables).length : 0);
}
export function refineWorkerDeliverableResultV1(result: string | undefined, deliverables: readonly WorkerDeliverableReferenceV1[] | undefined, context: z.core.$RefinementCtx, path: string): void {
  if ((result?.length ?? 0) > workerDeliverableResultMaxLengthV1(deliverables)) {
    context.addIssue({ code: "custom", path: [path], message: 'Worker result and references exceed the completion result bound' });
  }
}
export const SessionUpdatePostInputV1Schema = lazyZodSchema(() => z.strictObject({
  summary: ExecutionRunCompletionV1Schema.shape.summary._zod.def.innerType,
  deliverables: z.optional(WorkerDeliverablesV1Schema),
}).check(z.superRefine((report, context) => refineWorkerDeliverableResultV1(report.summary, report.deliverables, context, 'summary'))));
export type SessionUpdatePostInputV1 = z.infer<typeof SessionUpdatePostInputV1Schema>;
export const SessionUpdatePostOutputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: WorkerUpdateSessionIdV1Schema,
  localId: z.string().check(z.minLength(1)),
  persisted: z.literal(true),
}));

/** Epoch 1: the envelope and every nested identity/engine object are closed. */
export const WorkerUpdateTranscriptPointerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session'),
    sessionId: WorkerUpdateSessionIdV1Schema,
    seq: z.optional(z.number().check(z.int(), z.nonnegative())),
  }),
  z.strictObject({
    kind: z.literal('execution_run'),
    sessionId: WorkerUpdateSessionIdV1Schema,
    runId: ExecutionRunIdSchema,
  }),
  z.strictObject({
    kind: z.literal('workflow_run'),
    runId: WorkflowRunIdV1Schema,
    invocationRecordId: z.optional(WorkflowInvocationRecordIdSchema),
  }),
]));
export type WorkerUpdateTranscriptPointerV1 = z.infer<typeof WorkerUpdateTranscriptPointerV1Schema>;

const WorkerUpdateFieldsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  wake: z.enum(['finished', 'needs_you', 'stalled', 'published']),
  engine: z.optional(z.strictObject({
    agentId: z.string().check(z.minLength(1)),
    modelId: z.optional(z.string().check(z.minLength(1))),
  })),
  headline: z.string().check(z.minLength(1)),
  // Preserve the incumbent completion owner's 8,000-character result bound.
  // Omitted when a proved send already delivered final text; status/pointer still wake the lead.
  result: z.optional(ExecutionRunCompletionV1Schema.shape.summary._zod.def.innerType),
  deliverables: z.optional(WorkerDeliverablesV1Schema),
  truncated: z.optional(z.boolean()),
  transcriptPointer: z.optional(WorkerUpdateTranscriptPointerV1Schema),
  canInspect: z.boolean(),
  runtimeIssueV1: z.optional(SessionRuntimeIssueV1Schema),
}));

export const WorkerUpdateV1Schema = lazyZodSchema(() => z.discriminatedUnion('workerKind', [
  z.extend(WorkerUpdateFieldsV1Schema, {
    workerKind: z.literal('session'),
    workerId: WorkerUpdateSessionIdV1Schema,
    ownerState: z.enum(['settled', 'failed', 'cancelled', 'needs_input', 'stalled', 'published']),
  }),
  z.extend(WorkerUpdateFieldsV1Schema, {
    workerKind: z.literal('execution_run'),
    workerId: ExecutionRunIdSchema,
    ownerState: ExecutionRunTerminalStatusSchema,
  }),
  z.extend(WorkerUpdateFieldsV1Schema, {
    workerKind: z.literal('workflow_run'),
    workerId: WorkflowRunIdV1Schema,
    ownerState: WorkflowRunStateV1Schema,
  }),
]).check(z.superRefine((update, context) => {
  refineWorkerDeliverableResultV1(update.result, update.deliverables, context, 'result');
  const sourceSessionId = update.workerKind === 'session' ? update.workerId
    : update.transcriptPointer?.kind === 'execution_run' ? update.transcriptPointer.sessionId : null;
  if (!workerDeliverablesBelongToSessionV1(update.deliverables, sourceSessionId)) {
    context.addIssue({ code: "custom", path: ['deliverables'], message: 'Workspace deliverables must belong to the worker source Session' });
  }
  if (update.truncated === true && update.transcriptPointer === undefined) {
    context.addIssue({
      code: "custom",
      path: ['transcriptPointer'],
      message: 'A truncated worker update requires a transcript pointer',
    });
  }
})));
export type WorkerUpdateV1 = z.infer<typeof WorkerUpdateV1Schema>;

/** One terminal Run projection for retained parent reports and content-free Follow outcomes. */
export function composeExecutionRunWorkerUpdateV1(input: Readonly<{
  runId: string;
  sessionId: string;
  status: Extract<WorkerUpdateV1, { workerKind: 'execution_run' }>['ownerState'];
  canInspect: boolean;
}> & Partial<Pick<Extract<WorkerUpdateV1, { workerKind: 'execution_run' }>,
  'result' | 'deliverables' | 'truncated' | 'engine' | 'runtimeIssueV1'>>): WorkerUpdateV1 {
  const { runId, sessionId, status, ...content } = input;
  return WorkerUpdateV1Schema.parse({ v: 1, workerKind: 'execution_run', workerId: runId,
    ownerState: status, wake: resolveWorkerUpdateWakeV1(classifyWorkerUpdateEventV1({ workerKind: 'execution_run', ownerState: status })!),
    headline: `Background run ${status}`,
    transcriptPointer: { kind: 'execution_run', sessionId, runId }, ...content,
  });
}

/** Compact presentation facts; result bodies and references stay with their transcript row. */
export type WorkerUpdateHeadlineFactsV1 = {
  [Kind in WorkerUpdateV1['workerKind']]: Pick<Extract<WorkerUpdateV1, { workerKind: Kind }>,
    'workerKind' | 'workerId' | 'ownerState' | 'wake' | 'headline'>;
}[WorkerUpdateV1['workerKind']];

/** Source outcome is authoritative; the legacy wake only carries live attention, never success. */
export function classifyWorkerUpdateEventV1(update: Readonly<
  Pick<WorkerUpdateV1, 'workerKind' | 'ownerState'> & Partial<Pick<WorkerUpdateV1, 'wake'>>
>): FollowEventKindV1 | null {
  if (update.workerKind === 'execution_run') {
    return update.ownerState === 'succeeded' ? 'finished' : 'failed_or_stopped';
  }
  if (update.workerKind === 'workflow_run') {
    if (isTerminalAutomationRunStateV3(update.ownerState) && update.ownerState !== 'succeeded') return 'failed_or_stopped';
    if (update.wake === 'needs_you') return 'needs_you';
    return update.ownerState === 'succeeded' ? 'finished' : null;
  }
  switch (update.ownerState) {
    case 'failed': case 'cancelled': return 'failed_or_stopped';
    case 'needs_input': return 'needs_you';
    case 'stalled': return 'stalled';
    case 'published': return 'update_posted';
    case 'settled': return update.wake === 'needs_you' ? 'needs_you' : 'finished';
    default: return null;
  }
}

/** Plain-language fallback for native Session reports; clients localize the same outcome facts. */
export function composeSessionWorkerUpdateHeadlineV1(update: Readonly<
  Pick<Extract<WorkerUpdateV1, { workerKind: 'session' }>, 'ownerState' | 'wake'>
>): string {
  const event = classifyWorkerUpdateEventV1({ ...update, workerKind: 'session' });
  if (event === 'needs_you') return 'Needs you';
  switch (update.ownerState) {
    case 'failed': return 'Failed';
    case 'cancelled': return 'Stopped';
    case 'stalled': return 'Stalled';
    case 'published': return 'Published an update';
    case 'needs_input': return 'Needs you';
    case 'settled': return 'Finished its turn';
  }
}

/** Transitional scheduling projection. Outcome and policy readers use the classifier above. */
export function resolveWorkerUpdateWakeV1(event: FollowEventKindV1): WorkerUpdateV1['wake'] {
  if (event === 'needs_you' || event === 'failed_or_stopped') return 'needs_you';
  if (event === 'stalled') return 'stalled';
  return event === 'update_posted' ? 'published' : 'finished';
}

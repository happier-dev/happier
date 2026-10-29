import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';
import { FollowEventV1Schema, isMessageBackedFollowEventV1 } from './sessionFollowPolicyV1.js';
import { SessionFollowSelectedDeliveryV1Schema } from './sessionFollowSelectedDeliveryV1.js';
import { SessionFollowSourceMessageV1Schema, SessionFollowSourceRequestsV1Schema, SessionFollowSourceTurnV1Schema,
  type SessionFollowSourceTurnV1 } from './sessionFollowSourceOccurrenceV1.js';
import { sha256 } from '@noble/hashes/sha2';
import { encodeBase64 } from '../../crypto/base64.js';
import { ExecutionRunPermissionRequestIdentitySchema } from '../../execution/runs/runPrimitives.js';
import { ExecutionRunFollowSourceV1Schema } from './sessionDeliveryMuteV1.js';
import { ExecutionRunOutputRefV1Schema } from '../../reviews/reviewNarration.js';
import { ScmDiffSummaryOutputStateSchema } from '../../scm/diffSummary.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import type { ExecutionRunOutputRefV1 } from '../../reviews/reviewNarration.js';
export { ExecutionRunFollowSourceV1Schema } from './sessionDeliveryMuteV1.js';

const publicFields = { v: z.literal(1), delivery: SessionFollowSelectedDeliveryV1Schema };
const SessionFollowMessageOriginalV1Schema = lazyZodSchema(() => z.strictObject({
  sourceSessionId: asProtocolZod(SessionIdSchema), sourceMessage: SessionFollowSourceMessageV1Schema,
}));
const ExecutionRunFollowTerminalOriginalV1Schema = lazyZodSchema(() => z.strictObject({
  source: ExecutionRunFollowSourceV1Schema, terminalEventId: z.string().check(z.minLength(1)),
}));
const ExecutionRunFollowPermissionOriginalV1Schema = lazyZodSchema(() => z.strictObject({
  source: ExecutionRunFollowSourceV1Schema,
  permissionRequests: z.array(ExecutionRunPermissionRequestIdentitySchema).check(z.minLength(1), z.refine(requests =>
    requests.every((request, index) => index === 0 || requests[index - 1]!.requestId < request.requestId),
    { message: 'Permission identities must be sorted and unique' })),
}));
export const ExecutionRunFollowOutputV1Schema = lazyZodSchema(() => z.strictObject({
  outputRef: ExecutionRunOutputRefV1Schema, revision: z.number().check(z.int(), z.nonnegative()),
  state: ScmDiffSummaryOutputStateSchema,
}));
const ExecutionRunFollowOutputOriginalV1Schema = lazyZodSchema(() => z.strictObject({
  source: ExecutionRunFollowSourceV1Schema,
  output: ExecutionRunFollowOutputV1Schema.check(z.refine(output => output.state !== 'pending' && output.state !== 'writing')),
}));
export const ExecutionRunFollowOriginalV1Schema = lazyZodSchema(() => z.union([
  ExecutionRunFollowTerminalOriginalV1Schema, ExecutionRunFollowPermissionOriginalV1Schema, ExecutionRunFollowOutputOriginalV1Schema,
]));
export const WorkflowRunFollowOriginalV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.strictObject({ kind: z.literal('workflow_run'), runId: z.string().check(z.minLength(1)) }),
  revision: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
}));
const ExecutionRunFollowTerminalEventV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.enum(['finished', 'failed_or_stopped']) }));
const ExecutionRunFollowPermissionEventV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('needs_you'), type: z.literal('approval') }));
export const ExecutionRunFollowEventV1Schema = lazyZodSchema(() => z.union([
  ExecutionRunFollowTerminalEventV1Schema, ExecutionRunFollowPermissionEventV1Schema, z.strictObject({ kind: z.literal('update_posted') }),
]));
export const ExecutionRunFollowOccurrenceV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ original: ExecutionRunFollowTerminalOriginalV1Schema, event: ExecutionRunFollowTerminalEventV1Schema }),
  z.strictObject({ original: ExecutionRunFollowPermissionOriginalV1Schema, event: ExecutionRunFollowPermissionEventV1Schema }),
  z.strictObject({ original: ExecutionRunFollowOutputOriginalV1Schema, event: z.strictObject({ kind: z.enum(['update_posted', 'failed_or_stopped']) }) })
    .check(z.refine(value => (value.original.output.state === 'complete' || value.original.output.state === 'partial')
      === (value.event.kind === 'update_posted'))),
]));
/** Workflow revisions retain live attention and committed progress as well as terminal outcomes. */
export const WorkflowRunFollowEventV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.enum(['finished', 'failed_or_stopped', 'update_posted']) }),
  z.strictObject({ kind: z.literal('needs_you'), type: z.enum(['decision', 'approval', 'blocked']) }),
]));
export type WorkflowRunFollowEventV1 = z.infer<typeof WorkflowRunFollowEventV1Schema>;
/** Shared source hint/notice shape. Neither transport can widen the original's source contract. */
export const RunFollowOccurrenceV1Schema = lazyZodSchema(() => z.union([
  ExecutionRunFollowOccurrenceV1Schema,
  z.strictObject({ original: WorkflowRunFollowOriginalV1Schema, event: WorkflowRunFollowEventV1Schema }),
]));
export type RunFollowOccurrenceV1 = z.infer<typeof RunFollowOccurrenceV1Schema>;
/** Public notice-only intent. Private rule identity and match proof stay in server admission custody. */
export const SessionFollowInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...publicFields,
    original: z.strictObject({ sourceSessionId: asProtocolZod(SessionIdSchema), sourceTurn: SessionFollowSourceTurnV1Schema }),
    event: z.strictObject({ kind: z.enum(['finished', 'failed_or_stopped']) }),
  }).check(z.refine(value => value.event.kind === resolveSessionFollowTurnEventV1(value.original.sourceTurn).kind,
    { path: ['event'], message: 'Terminal event must match its host Turn outcome' })),
  z.strictObject({ ...publicFields,
    original: SessionFollowMessageOriginalV1Schema,
    event: FollowEventV1Schema,
  }).check(z.refine(value => isMessageBackedFollowEventV1(value.event)
    && value.event.kind !== 'finished' && value.event.kind !== 'failed_or_stopped', {
    path: ['event'], message: 'Terminal events require an exact host Turn; questions require an exact source request',
  })),
  z.strictObject({ ...publicFields,
    original: z.strictObject({ sourceSessionId: asProtocolZod(SessionIdSchema), sourceRequests: SessionFollowSourceRequestsV1Schema }),
    requestEvents: z.array(z.strictObject({ requestId: z.string().check(z.minLength(1)),
      event: z.strictObject({ kind: z.literal('needs_you'), type: z.enum(['decision', 'approval', 'blocked']),
        mode: z.optional(z.enum(['wait', 'continue'])), handling: z.optional(z.enum(['person', 'manager'])) }),
    })).check(z.minLength(1)),
  }).check(z.superRefine((value, context) => {
    const originals = new Map(value.original.sourceRequests.requests.map(request => [request.requestId, request]));
    for (const [index, request] of value.requestEvents.entries()) {
      const original = originals.get(request.requestId);
      if (!originals.delete(request.requestId)) context.addIssue({ code: 'custom', path: ['requestEvents', index], message: 'Each selected original request has exactly one event' });
      if (original?.currentHandler && (original.currentHandler.kind !== 'session'
        || original.currentHandler.sessionId === value.original.sourceSessionId
        || request.event.type === 'approval' || request.event.handling !== 'manager')) {
        context.addIssue({ code: 'custom', path: ['requestEvents', index], message: 'A handler offer requires its original non-approval question' });
      }
    }
    if (originals.size) context.addIssue({ code: 'custom', path: ['requestEvents'], message: 'Every selected original request must be represented' });
  })),
  z.strictObject({ ...publicFields,
    original: ExecutionRunFollowTerminalOriginalV1Schema,
    event: ExecutionRunFollowTerminalEventV1Schema,
  }),
  z.strictObject({ ...publicFields,
    original: ExecutionRunFollowPermissionOriginalV1Schema,
    event: ExecutionRunFollowPermissionEventV1Schema,
  }),
  z.strictObject({ ...publicFields,
    original: WorkflowRunFollowOriginalV1Schema,
    event: WorkflowRunFollowEventV1Schema,
  }),
]));
export type SessionFollowInputV1 = z.infer<typeof SessionFollowInputV1Schema>;

/**
 * Receipts and stored authorities retain message-backed terminal notices before AM-SB1
 * (producer schema b72a081d7a; retained rows observed 2026-10-23/24).
 * New input admission still requires the exact host Turn via the schema above.
 */
export const SessionFollowReceiptDeliveryV1Schema = lazyZodSchema(() => z.union([
  SessionFollowInputV1Schema,
  z.strictObject({ ...publicFields, original: SessionFollowMessageOriginalV1Schema,
    event: z.strictObject({ kind: z.enum(['finished', 'failed_or_stopped']) }),
  }),
]));

/** Projects the admitted request owner's assignment; never decides who may answer it. */
export function isSessionFollowQuestionHandlerV1(delivery: SessionFollowInputV1, destinationSessionId: string): boolean {
  if (!('sourceRequests' in delivery.original)) return false;
  const handler = delivery.original.sourceRequests.requests[0]?.currentHandler;
  return handler?.kind === 'session' && handler.sessionId === destinationSessionId;
}
export function resolveSessionFollowTurnEventV1(turn: SessionFollowSourceTurnV1): Readonly<{ kind: 'finished' | 'failed_or_stopped' }> {
  return { kind: turn.status === 'completed' ? 'finished' : 'failed_or_stopped' };
}
export type RunFollowOriginalV1 = z.infer<typeof ExecutionRunFollowOriginalV1Schema> | z.infer<typeof WorkflowRunFollowOriginalV1Schema>;
export function isRunFollowOriginalV1(original: SessionFollowInputV1['original'] | RunFollowOriginalV1): original is RunFollowOriginalV1 {
  return 'source' in original;
}

/** Current permission-store identities are originals; clearing never fabricates a terminal occurrence. */
export function resolveExecutionRunFollowOccurrenceV1(frontier: Readonly<{
  sessionId?: string | null; machineId?: string; source?: z.infer<typeof ExecutionRunFollowSourceV1Schema>;
  runId: string; status: string; terminalEventId: string | null;
  outputs?: readonly z.infer<typeof ExecutionRunFollowOutputV1Schema>[];
  attention?: Readonly<{ kind: 'permission_required'; requestIds: readonly string[];
    requests?: readonly Readonly<{ requestId: string; createdAt: number }>[] }>;
}>, outputRef?: ExecutionRunOutputRefV1): z.infer<typeof ExecutionRunFollowOccurrenceV1Schema> | null {
  const source = ExecutionRunFollowSourceV1Schema.parse(frontier.source ?? { kind: 'execution_run', runId: frontier.runId,
    ...(typeof frontier.sessionId === 'string' ? { sessionId: frontier.sessionId } : {}),
    ...(frontier.machineId !== undefined ? { machineId: frontier.machineId } : {}) });
  const output = outputRef ? frontier.outputs?.find(output => sameStrictJsonValue(output.outputRef, outputRef)) : undefined;
  if (outputRef) {
    if (!output || output.state === 'pending' || output.state === 'writing') return null;
    return { original: { source, output }, event: { kind: output.state === 'complete' || output.state === 'partial'
      ? 'update_posted' : 'failed_or_stopped' } };
  }
  if (frontier.status === 'running') {
    const permissionRequests = [...frontier.attention?.requests ?? []].sort((left, right) =>
      left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0);
    return permissionRequests.length ? { original: { source, permissionRequests }, event: { kind: 'needs_you', type: 'approval' } } : null;
  }
  if (!frontier.terminalEventId) return null;
  const original = { source, terminalEventId: frontier.terminalEventId };
  return frontier.status === 'succeeded' ? { original, event: { kind: 'finished' } }
    : frontier.status === 'failed' || frontier.status === 'cancelled' || frontier.status === 'timeout'
      ? { original, event: { kind: 'failed_or_stopped' } } : null;
}

/** Indexed projection of an existing original identity, independent of routes, batches and publisher fences. */
export function deriveSessionFollowOriginalOccurrenceKeyV1(original: SessionFollowInputV1['original'] | RunFollowOriginalV1): string | null {
  const request = 'sourceRequests' in original && original.sourceRequests.requests.length === 1
    ? original.sourceRequests.requests[0] : null;
  const executionIdentity = isRunFollowOriginalV1(original) && original.source.kind === 'execution_run'
    ? 'sessionId' in original.source ? [original.source.sessionId] : ['machine', original.source.machineId] : [];
  const identity = isRunFollowOriginalV1(original)
    ? 'terminalEventId' in original
      ? ['execution_run', ...executionIdentity, original.source.runId, original.terminalEventId]
      : 'permissionRequests' in original
        ? ['execution_run_permission', ...executionIdentity, original.source.runId,
          original.permissionRequests.map(request => [request.requestId, request.createdAt])]
        : 'output' in original ? ['execution_run_output', ...executionIdentity, original.source.runId,
          original.output.outputRef.kind, original.output.outputRef.kind === 'scm_diff_summary' ? original.output.outputRef.output : null,
          original.output.outputRef.comparisonId, original.output.outputRef.resultId, original.output.revision, original.output.state]
          : ['workflow_run', original.source.runId, original.revision]
    : 'sourceMessage' in original
    ? ['message', original.sourceSessionId, original.sourceMessage.localId, original.sourceMessage.seq]
    : 'sourceTurn' in original ? ['turn', original.sourceSessionId, original.sourceTurn.id, original.sourceTurn.status]
    : request
      ? ['request', original.sourceSessionId, request.requestId, request.createdAt, request.turnId ?? null,
        ...(request.currentHandler?.kind === 'session' ? ['handler', request.currentHandler.sessionId] : [])]
      : null;
  // Older development batches may represent several originals; no scalar
  // projection or acceptance proof may be invented for those retained rows.
  return identity === null ? null : encodeBase64(sha256(new TextEncoder().encode(JSON.stringify(identity))), 'base64url');
}

/** Retry identity on the existing destination-scoped Pending input, not another occurrence identity. */
export function deriveSessionFollowInputLocalIdV1(input: Readonly<{
  destinationSessionId: string; original: SessionFollowInputV1['original'];
}>): string {
  const key = deriveSessionFollowOriginalOccurrenceKeyV1(input.original);
  if (key === null) throw new TypeError('A Follow input must represent one original occurrence');
  // Pending localId is already scoped by destination Session in its unique key.
  return `follow-original:${key}`;
}

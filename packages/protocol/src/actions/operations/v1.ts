import { z } from 'zod';

import { SessionForkStrategySchema } from '../../sessions/fork.js';

export const ACTION_OPERATION_RPC_METHODS_V1 = Object.freeze({
  list: 'actionOperation.list.v1',
  get: 'actionOperation.get.v1',
  cancel: 'actionOperation.cancel.v1',
} as const);

export const ACTION_OPERATION_SNAPSHOT_PUSH_EVENT_V1 = 'action-operation-snapshot.v1';
export const ACTION_OPERATION_SNAPSHOT_EPHEMERAL_TYPE_V1 = 'action-operation-snapshot';

export const ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1 = 200;
export const ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1 = 1_000;
const ACTION_OPERATION_IDENTIFIER_MAX_LENGTH_V1 = 2_000;
export const ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1 = ACTION_OPERATION_IDENTIFIER_MAX_LENGTH_V1;
const ACTION_OPERATION_TITLE_MAX_LENGTH_V1 = 10_000;
const ACTION_OPERATION_ERROR_CODE_MAX_LENGTH_V1 = 200;
const ACTION_OPERATION_ERROR_MAX_LENGTH_V1 = 10_000;

const ActionOperationIdentifierV1Schema = z.string().trim().min(1)
  .max(ACTION_OPERATION_IDENTIFIER_MAX_LENGTH_V1);

const ActionOperationProgressPhaseV1Schema = z.string().trim().min(1)
  .max(ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1);
const ActionOperationProgressLabelV1Schema = z.string().trim().min(1)
  .max(ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1);

export const ActionOperationDeclarationV1Schema = z.object({
  version: z.literal(1),
  visibility: z.literal('activity'),
  progress: z.enum(['indeterminate', 'reported']),
  presentation: z.object({
    onStart: z.enum(['current', 'detail', 'activity']),
  }).strict(),
}).strict();
export type ActionOperationDeclarationV1 = Readonly<z.infer<typeof ActionOperationDeclarationV1Schema>>;

export const ActionOperationStateV1Schema = z.enum([
  'accepted', 'running', 'succeeded', 'failed', 'cancelled',
]);
export type ActionOperationStateV1 = z.infer<typeof ActionOperationStateV1Schema>;

export const ActionOperationProgressV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('indeterminate'),
    label: ActionOperationProgressLabelV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('phase'),
    phase: ActionOperationProgressPhaseV1Schema,
    label: ActionOperationProgressLabelV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('determinate'),
    current: z.number().finite().nonnegative(),
    total: z.number().finite().positive(),
    label: ActionOperationProgressLabelV1Schema.optional(),
  }).strict().refine((value) => value.current <= value.total, {
    path: ['current'],
    message: 'Determinate operation progress cannot exceed its total.',
  }),
]);
export type ActionOperationProgressV1 = Readonly<z.infer<typeof ActionOperationProgressV1Schema>>;

/** Public, redacted projection of the canonical terminal Action failure. */
export const ActionOperationFailureV1Schema = z.object({
  errorCode: z.string().trim().min(1).max(ACTION_OPERATION_ERROR_CODE_MAX_LENGTH_V1),
  error: z.string().trim().min(1).max(ACTION_OPERATION_ERROR_MAX_LENGTH_V1),
}).strict();
export type ActionOperationFailureV1 = Readonly<z.infer<typeof ActionOperationFailureV1Schema>>;

export const ActionOperationDomainRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('forkRequest'),
    id: ActionOperationIdentifierV1Schema,
    strategy: SessionForkStrategySchema.optional(),
  }).strict(),
  z.object({ kind: z.literal('spawnAttempt'), id: ActionOperationIdentifierV1Schema }).strict(),
  z.object({
    kind: z.literal('handoff'),
    id: ActionOperationIdentifierV1Schema,
    targetMachineId: ActionOperationIdentifierV1Schema.optional(),
  }).strict(),
]);
export type ActionOperationDomainRefV1 = Readonly<z.infer<typeof ActionOperationDomainRefV1Schema>>;

const ActionOperationTimestampV1Schema = z.number().finite().int().nonnegative();

export const ActionOperationSnapshotV1Schema = z.object({
  version: z.literal(1),
  operationId: ActionOperationIdentifierV1Schema,
  revision: z.number().int().positive(),
  actionId: ActionOperationIdentifierV1Schema,
  state: ActionOperationStateV1Schema,
  scope: z.object({
    accountId: ActionOperationIdentifierV1Schema,
    machineId: ActionOperationIdentifierV1Schema,
    sessionId: ActionOperationIdentifierV1Schema.optional(),
  }).strict(),
  title: z.string().trim().min(1).max(ACTION_OPERATION_TITLE_MAX_LENGTH_V1),
  requestId: ActionOperationIdentifierV1Schema.optional(),
  createdAt: ActionOperationTimestampV1Schema,
  startedAt: ActionOperationTimestampV1Schema.optional(),
  settledAt: ActionOperationTimestampV1Schema.optional(),
  progress: ActionOperationProgressV1Schema.optional(),
  result: z.unknown().optional(),
  error: ActionOperationFailureV1Schema.optional(),
  domainRef: ActionOperationDomainRefV1Schema.optional(),
  cancellation: z.enum(['unsupported', 'supported']),
}).strict().superRefine((snapshot, context) => {
  const terminal = snapshot.state === 'succeeded'
    || snapshot.state === 'failed'
    || snapshot.state === 'cancelled';

  if (snapshot.state === 'accepted' && snapshot.startedAt !== undefined) {
    context.addIssue({ code: 'custom', path: ['startedAt'], message: 'Accepted operations have not started.' });
  }
  if (snapshot.state !== 'accepted' && snapshot.startedAt === undefined) {
    context.addIssue({ code: 'custom', path: ['startedAt'], message: 'Started and terminal operations require startedAt.' });
  }
  if (terminal !== (snapshot.settledAt !== undefined)) {
    context.addIssue({ code: 'custom', path: ['settledAt'], message: 'Only terminal operations require settledAt.' });
  }
  if ((snapshot.state === 'failed') !== (snapshot.error !== undefined)) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'Only failed operations require an error.' });
  }
  if (snapshot.result !== undefined && snapshot.state !== 'succeeded') {
    context.addIssue({ code: 'custom', path: ['result'], message: 'Only succeeded operations may carry a result.' });
  }
  if (snapshot.startedAt !== undefined && snapshot.startedAt < snapshot.createdAt) {
    context.addIssue({ code: 'custom', path: ['startedAt'], message: 'startedAt cannot precede createdAt.' });
  }
  if (snapshot.settledAt !== undefined && snapshot.startedAt !== undefined && snapshot.settledAt < snapshot.startedAt) {
    context.addIssue({ code: 'custom', path: ['settledAt'], message: 'settledAt cannot precede startedAt.' });
  }
});
export type ActionOperationSnapshotV1 = Readonly<z.infer<typeof ActionOperationSnapshotV1Schema>>;

export const ActionOperationSnapshotPushV1Schema = z.object({
  v: z.literal(1),
  machineId: ActionOperationIdentifierV1Schema,
  ciphertext: z.string().min(1),
}).strict();
export type ActionOperationSnapshotPushV1 = Readonly<z.infer<typeof ActionOperationSnapshotPushV1Schema>>;

export const ActionOperationSnapshotEphemeralV1Schema = z.object({
  type: z.literal(ACTION_OPERATION_SNAPSHOT_EPHEMERAL_TYPE_V1),
  machineId: ActionOperationIdentifierV1Schema,
  ciphertext: z.string().min(1),
}).strict();
export type ActionOperationSnapshotEphemeralV1 = Readonly<z.infer<typeof ActionOperationSnapshotEphemeralV1Schema>>;

export const ActionOperationListV1RequestSchema = z.object({
  states: z.array(ActionOperationStateV1Schema)
    .max(ActionOperationStateV1Schema.options.length)
    .optional(),
  sessionId: ActionOperationIdentifierV1Schema.optional(),
  cursor: ActionOperationIdentifierV1Schema.optional(),
}).strict().superRefine((request, context) => {
  if (request.states && new Set(request.states).size !== request.states.length) {
    context.addIssue({ code: 'custom', path: ['states'], message: 'states must not contain duplicates.' });
  }
});
export type ActionOperationListV1Request = z.infer<typeof ActionOperationListV1RequestSchema>;

export const ActionOperationListV1ResponseSchema = z.object({
  items: z.array(ActionOperationSnapshotV1Schema),
  nextCursor: ActionOperationIdentifierV1Schema.nullable(),
}).strict();
export type ActionOperationListV1Response = z.infer<typeof ActionOperationListV1ResponseSchema>;

export const ActionOperationGetV1RequestSchema = z.object({
  operationId: ActionOperationIdentifierV1Schema,
}).strict();
export type ActionOperationGetV1Request = z.infer<typeof ActionOperationGetV1RequestSchema>;

const ActionOperationNotFoundV1Schema = z.object({ kind: z.literal('not_found') }).strict();

export const ActionOperationGetV1ResponseSchema = z.union([
  z.object({ kind: z.literal('found'), operation: ActionOperationSnapshotV1Schema }).strict(),
  ActionOperationNotFoundV1Schema,
]);
export type ActionOperationGetV1Response = z.infer<typeof ActionOperationGetV1ResponseSchema>;

export const ActionOperationCancelV1RequestSchema = ActionOperationGetV1RequestSchema;
export type ActionOperationCancelV1Request = z.infer<typeof ActionOperationCancelV1RequestSchema>;

export const ActionOperationCancelV1ResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }).strict(),
  z.object({ kind: z.literal('requested') }).strict(),
  z.object({ kind: z.literal('already_settled') }).strict(),
  ActionOperationNotFoundV1Schema,
]);
export type ActionOperationCancelV1Response = z.infer<typeof ActionOperationCancelV1ResponseSchema>;

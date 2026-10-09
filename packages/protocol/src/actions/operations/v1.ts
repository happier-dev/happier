import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { SessionForkStrategySchema } from '../../sessions/fork.js';
import { ProjectSetupConsentFailureDetailsV1Schema } from '../projectSetupConsentFailure.js';
import { WorkspaceAddressV1Schema } from '../../workspaces/workspaceRefV1.js';
import { ProjectCommandSourceV1Schema } from '../../workspaces/projectSetup/projectManifestV1.js';
import { LocalServiceManagedServiceActionTargetV1Schema, ProjectServiceDeclarationRefV1Schema } from '../../local/services/actions/v1.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { ManagedControllerV1Schema } from '../../machines/managed/managedMachineV1.js';
import { ManagedResourceV1Schema } from '../../machines/managed/providerFactsV1.js';

export const ACTION_OPERATION_RPC_METHODS_V1 = Object.freeze({
  list: 'actionOperation.list.v1',
  get: 'actionOperation.get.v1',
  cancel: 'actionOperation.cancel.v1',
} as const);

/** Same observation owner, with current domain associations. V1 readers retain
 * their original framing without development-only managed/task references. */
export const ACTION_OPERATION_RPC_METHODS_V2 = Object.freeze({
  list: 'actionOperation.list.v2',
  get: 'actionOperation.get.v2',
} as const);

/** Dev-current reader retained only while already-running 0.3 processes drain. */
export const ACTION_OPERATION_SNAPSHOT_PUSH_EVENT_V1 = 'action-operation-snapshot.v1';
/** Dev-current reader retained only while already-running 0.3 processes drain. */
export const ACTION_OPERATION_SNAPSHOT_EPHEMERAL_TYPE_V1 = 'action-operation-snapshot';
/**
 * Producer and relay event used by the released 0.2.11 components at
 * 98ea8fb76733b1dd785d38c31360179cafa84824. Remove with that supported
 * predecessor frontier.
 */
export const ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1 = 'action-operation-updated';

export const ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1 = 200;
export const ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1 = 1_000;
const ACTION_OPERATION_IDENTIFIER_MAX_LENGTH_V1 = 2_000;
export const ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1 = ACTION_OPERATION_IDENTIFIER_MAX_LENGTH_V1;
const ACTION_OPERATION_TITLE_MAX_LENGTH_V1 = 10_000;
const ACTION_OPERATION_ERROR_CODE_MAX_LENGTH_V1 = 200;
const ACTION_OPERATION_ERROR_MAX_LENGTH_V1 = 10_000;

const ActionOperationIdentifierV1Schema = lazyZodSchema(() => z.string().trim().min(1)
  .max(ACTION_OPERATION_IDENTIFIER_MAX_LENGTH_V1));

const ActionOperationProgressPhaseV1Schema = lazyZodSchema(() => z.string().trim().min(1)
  .max(ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1));
const ActionOperationProgressLabelV1Schema = lazyZodSchema(() => z.string().trim().min(1)
  .max(ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1));

export const ActionOperationDeclarationV1Schema = lazyZodSchema(() => z.object({
  version: z.literal(1),
  visibility: z.literal('activity'),
  progress: z.enum(['indeterminate', 'reported']),
  presentation: z.object({
    onStart: z.enum(['current', 'detail', 'activity']),
  }).strict(),
}).strict());
export type ActionOperationDeclarationV1 = Readonly<z.infer<typeof ActionOperationDeclarationV1Schema>>;

export const ActionOperationStateV1Schema = lazyZodSchema(() => z.enum([
  'accepted', 'running', 'succeeded', 'failed', 'cancelled',
]));
export type ActionOperationStateV1 = z.infer<typeof ActionOperationStateV1Schema>;

export const ActionOperationProgressV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('indeterminate'),
    label: ActionOperationProgressLabelV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('phase'),
    phase: ActionOperationProgressPhaseV1Schema,
    label: ActionOperationProgressLabelV1Schema,
    /** Current target FIFO observation, not a percentage or admission token. */
    queueAhead: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict().refine(value => value.queueAhead === undefined || value.phase === 'queued', {
    path: ['queueAhead'], message: 'FIFO ahead is available only during the queued phase.',
  }),
  z.object({
    kind: z.literal('determinate'),
    current: z.number().finite().nonnegative(),
    total: z.number().finite().positive(),
    label: ActionOperationProgressLabelV1Schema.optional(),
  }).strict().refine((value) => value.current <= value.total, {
    path: ['current'],
    message: 'Determinate operation progress cannot exceed its total.',
  }),
]));
export type ActionOperationProgressV1 = Readonly<z.infer<typeof ActionOperationProgressV1Schema>>;

/** Public, redacted projection of the canonical terminal Action failure. */
const ActionOperationErrorCodeV1Schema = lazyZodSchema(() => z.string().trim().min(1).max(ACTION_OPERATION_ERROR_CODE_MAX_LENGTH_V1));
export const ActionOperationFailureV1Schema = lazyZodSchema(() => z.object({
  errorCode: ActionOperationErrorCodeV1Schema,
  error: z.string().trim().min(1).max(ACTION_OPERATION_ERROR_MAX_LENGTH_V1),
  details: ProjectSetupConsentFailureDetailsV1Schema.optional(),
}).strict().refine(failure => !failure.details || failure.details.code === failure.errorCode, {
  path: ['details', 'code'], message: 'Consent review facts must match their terminal failure code.',
}));
export type ActionOperationFailureV1 = Readonly<z.infer<typeof ActionOperationFailureV1Schema>>;

/** Actual command/output target, independent of the operation's observation custody. */
export const ProjectCommandAttachmentV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('projectCommand'),
  purpose: z.enum(['setup', 'teardown', 'script', 'exec']),
  serverId: ActionOperationIdentifierV1Schema,
  machineId: ActionOperationIdentifierV1Schema,
  workspaceRefId: ActionOperationIdentifierV1Schema,
  cwd: z.string().min(1),
  /** Final execution-target edge, observed only after its completed clean Sync barrier. */
  lastCleanSyncAtMs: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  terminalId: ActionOperationIdentifierV1Schema.optional(),
  sourceWorkspace: WorkspaceAddressV1Schema.optional(),
  script: z.object({
    name: z.string().min(1).optional(),
    source: ProjectCommandSourceV1Schema,
  }).strict().optional(),
  exitCode: z.number().int().optional(),
  originRun: z.object({
    kind: z.literal('workflow_run'),
    serverId: ActionOperationIdentifierV1Schema,
    runId: ActionOperationIdentifierV1Schema,
  }).strict().optional(),
}).strict().superRefine((attachment, context) => {
  if (attachment.script && !attachment.sourceWorkspace) {
    context.addIssue({ code: 'custom', path: ['sourceWorkspace'], message: 'Script identity requires its original qualified Source workspace.' });
  }
  if (attachment.exitCode !== undefined && !attachment.terminalId) {
    context.addIssue({ code: 'custom', path: ['exitCode'], message: 'Observed process exit requires its actual terminal association.' });
  }
}));
export type ProjectCommandAttachmentV1 = Readonly<z.infer<typeof ProjectCommandAttachmentV1Schema>>;

export const ActionOperationDomainRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('forkRequest'),
    id: ActionOperationIdentifierV1Schema,
    strategy: SessionForkStrategySchema.optional(),
  }).strict(),
  z.object({ kind: z.literal('spawnAttempt'), id: ActionOperationIdentifierV1Schema }).strict(),
  z.object({ kind: z.literal('managedMachine'), id: ActionOperationIdentifierV1Schema,
    bootstrapTask: z.object({ id: ActionOperationIdentifierV1Schema,
      taskKind: z.literal('remote.ssh.bootstrapMachine.v1'),
      /** Older development observations without a capture cannot identify today's install attempt. */
      controller: z.lazy(() => ManagedControllerV1Schema).optional(),
      resource: z.lazy(() => ManagedResourceV1Schema).optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal('systemTask'),
    id: ActionOperationIdentifierV1Schema,
    taskKind: z.literal('remote.ssh.bootstrapMachine.v1'),
  }).strict(),
  z.object({
    kind: z.literal('handoff'),
    id: ActionOperationIdentifierV1Schema,
    targetMachineId: ActionOperationIdentifierV1Schema.optional(),
  }).strict(),
  ProjectCommandAttachmentV1Schema,
  z.object({
    kind: z.literal('projectService'),
    purpose: z.literal('relocation'),
    workspace: WorkspaceAddressV1Schema,
    declaration: ProjectServiceDeclarationRefV1Schema,
    currentTarget: LocalServiceManagedServiceActionTargetV1Schema.optional(),
  }).strict(),
]).superRefine((reference, context) => {
  if (reference.kind === 'projectService' && reference.declaration.workspaceRefId !== reference.workspace.workspaceId) {
    context.addIssue({ code: 'custom', path: ['declaration', 'workspaceRefId'],
      message: 'Service relocation must retain the selected Workspace declaration.' });
  }
  if (reference.kind === 'projectService' && reference.currentTarget) {
    const target = reference.currentTarget;
    if (target.machineId !== reference.workspace.machineId || target.workspaceId !== reference.workspace.workspaceId
      || target.sessionId !== undefined || !target.cwd || !target.declaration
      || createCanonicalJsonSigningInput(target.declaration) !== createCanonicalJsonSigningInput(reference.declaration)) {
      context.addIssue({ code: 'custom', path: ['currentTarget'],
        message: 'Observed native identity must match its Project workspace and declaration.' });
    }
  }
}));
export type ActionOperationDomainRefV1 = Readonly<z.infer<typeof ActionOperationDomainRefV1Schema>>;

const ActionOperationTimestampV1Schema = lazyZodSchema(() => z.number().finite().int().nonnegative());

export const ActionOperationObservationV1Schema = lazyZodSchema(() => z.object({
  kind: z.enum(['outcome_uncertain', 'stop_unconfirmed']),
  code: ActionOperationErrorCodeV1Schema,
}).strict());
export type ActionOperationObservationV1 = Readonly<z.infer<typeof ActionOperationObservationV1Schema>>;

export const ActionOperationSnapshotV1Schema = lazyZodSchema(() => z.object({
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
  observation: ActionOperationObservationV1Schema.optional(),
  setupReview: ProjectSetupConsentFailureDetailsV1Schema.optional(),
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
  if (terminal && snapshot.observation !== undefined) {
    context.addIssue({ code: 'custom', path: ['observation'], message: 'Unconfirmed observations cannot accompany terminal process evidence.' });
  }
  if (snapshot.setupReview && (terminal || snapshot.domainRef?.kind !== 'projectCommand'
    || !['projects.prepare', 'projects.script.run', 'projects.compute.exec'].includes(snapshot.actionId))) {
    context.addIssue({ code: 'custom', path: ['setupReview'], message: 'Only live finite commands may retain a no-effect setup review.' });
  }
  if (snapshot.startedAt !== undefined && snapshot.startedAt < snapshot.createdAt) {
    context.addIssue({ code: 'custom', path: ['startedAt'], message: 'startedAt cannot precede createdAt.' });
  }
  if (snapshot.settledAt !== undefined && snapshot.startedAt !== undefined && snapshot.settledAt < snapshot.startedAt) {
    context.addIssue({ code: 'custom', path: ['settledAt'], message: 'settledAt cannot precede startedAt.' });
  }
}));
export type ActionOperationSnapshotV1 = Readonly<z.infer<typeof ActionOperationSnapshotV1Schema>>;

/** The closed ../0.2 reader at 37a6541578749067b49d4579be8c752c9591b8c8
 * predates current domain and review facts. Project only the V1 outward seam;
 * current readers use V2 and the store retains the complete owner observation.
 * Remove this projection when that supported predecessor reader is retired. */
export function projectActionOperationSnapshotForV1Reader(snapshot: ActionOperationSnapshotV1): ActionOperationSnapshotV1 {
  const { domainRef, setupReview: _review, observation: _observation, error, progress, ...projection } = snapshot;
  const legacyDomainRef = domainRef?.kind === 'forkRequest' || domainRef?.kind === 'spawnAttempt'
    || domainRef?.kind === 'handoff' ? domainRef : undefined;
  const legacyProgress = progress?.kind === 'phase'
    ? { kind: progress.kind, phase: progress.phase, label: progress.label }
    : progress;
  return {
    ...projection,
    ...(legacyProgress ? { progress: legacyProgress } : {}),
    ...(legacyDomainRef ? { domainRef: legacyDomainRef } : {}),
    ...(error ? { error: { errorCode: error.errorCode, error: error.error } } : {}),
  };
}

export const ActionOperationSnapshotPushV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  machineId: ActionOperationIdentifierV1Schema,
  ciphertext: z.string().min(1),
}).strict());
export type ActionOperationSnapshotPushV1 = Readonly<z.infer<typeof ActionOperationSnapshotPushV1Schema>>;

export const ActionOperationSnapshotEphemeralV1Schema = lazyZodSchema(() => z.object({
  type: z.literal(ACTION_OPERATION_SNAPSHOT_EPHEMERAL_TYPE_V1),
  machineId: ActionOperationIdentifierV1Schema,
  ciphertext: z.string().min(1),
}).strict());
export type ActionOperationSnapshotEphemeralV1 = Readonly<z.infer<typeof ActionOperationSnapshotEphemeralV1Schema>>;

export const ActionOperationRevisionEphemeralV1Schema = lazyZodSchema(() => z.object({
  type: z.literal(ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1),
  machineId: ActionOperationIdentifierV1Schema,
  content: z.discriminatedUnion('t', [
    z.object({ t: z.literal('encrypted'), c: z.string().trim().min(1) }).strict(),
    z.object({ t: z.literal('plain'), v: ActionOperationSnapshotV1Schema }).strict(),
  ]),
}).strict());
export type ActionOperationRevisionEphemeralV1 = Readonly<z.infer<typeof ActionOperationRevisionEphemeralV1Schema>>;

export const ActionOperationListV1RequestSchema = lazyZodSchema(() => z.object({
  states: z.array(ActionOperationStateV1Schema)
    .max(ActionOperationStateV1Schema.options.length)
    .optional(),
  sessionId: ActionOperationIdentifierV1Schema.optional(),
  cursor: ActionOperationIdentifierV1Schema.optional(),
}).strict().superRefine((request, context) => {
  if (request.states && new Set(request.states).size !== request.states.length) {
    context.addIssue({ code: 'custom', path: ['states'], message: 'states must not contain duplicates.' });
  }
}));
export type ActionOperationListV1Request = z.infer<typeof ActionOperationListV1RequestSchema>;

export const ActionOperationListV1ResponseSchema = lazyZodSchema(() => z.object({
  items: z.array(ActionOperationSnapshotV1Schema),
  nextCursor: ActionOperationIdentifierV1Schema.nullable(),
}).strict());
export type ActionOperationListV1Response = z.infer<typeof ActionOperationListV1ResponseSchema>;

export const ActionOperationGetV1RequestSchema = lazyZodSchema(() => z.object({
  operationId: ActionOperationIdentifierV1Schema,
  waitForTerminal: z.literal(true).optional(),
  /** FIN may observe an explicit no-effect review before process settlement. */
  includeSetupReview: z.literal(true).optional(),
}).strict().refine(request => !request.includeSetupReview || request.waitForTerminal === true, {
  path: ['includeSetupReview'], message: 'Setup review observation requires the existing wait owner.',
}));
export type ActionOperationGetV1Request = z.infer<typeof ActionOperationGetV1RequestSchema>;

const ActionOperationNotFoundV1Schema = lazyZodSchema(() => z.object({ kind: z.literal('not_found') }).strict());

export const ActionOperationGetV1ResponseSchema = lazyZodSchema(() => z.union([
  z.object({ kind: z.literal('found'), operation: ActionOperationSnapshotV1Schema }).strict(),
  ActionOperationNotFoundV1Schema,
]));
export type ActionOperationGetV1Response = z.infer<typeof ActionOperationGetV1ResponseSchema>;

export const ActionOperationCancelV1RequestSchema = lazyZodSchema(() => z.object({
  operationId: ActionOperationIdentifierV1Schema,
}).strict());
export type ActionOperationCancelV1Request = z.infer<typeof ActionOperationCancelV1RequestSchema>;

export const ActionOperationCancelV1ResponseSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }).strict(),
  z.object({ kind: z.literal('requested') }).strict(),
  z.object({ kind: z.literal('already_settled') }).strict(),
  ActionOperationNotFoundV1Schema,
]));
export type ActionOperationCancelV1Response = z.infer<typeof ActionOperationCancelV1ResponseSchema>;

/** Observation projections preserve a settled state while admitting newer owner receipt facts. */
export function canAdvanceActionOperationSnapshotV1(current: ActionOperationSnapshotV1, incoming: ActionOperationSnapshotV1): boolean {
  if (incoming.operationId !== current.operationId || incoming.actionId !== current.actionId
    || incoming.scope.accountId !== current.scope.accountId || incoming.scope.machineId !== current.scope.machineId
    || incoming.scope.sessionId !== current.scope.sessionId || incoming.revision <= current.revision) return false;
  if (['succeeded', 'failed', 'cancelled'].includes(current.state) && incoming.state !== current.state) return false;
  return !(current.state === 'running' && incoming.state === 'accepted');
}

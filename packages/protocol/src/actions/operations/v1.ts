import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SessionForkStrategySchema } from '../../sessions/fork.js';
import { ProjectSetupConsentFailureDetailsV1Schema, ProjectScriptEffectChangedFailureDetailsV1Schema } from '../projectSetupConsentFailure.js';
import { ProjectWorkerNoAcceptanceFailureDetailsV1Schema, readProjectWorkerNoAcceptanceFailureV1 } from '../projectWorkerRefusal.js';
import { ApprovalStaleFailureDetailsSchema } from '../../approvals/approvalStaleReason.js';
import { WorkspaceAddressV1Schema } from '../../workspaces/workspaceRefV1.js';
import { ProjectCommandSourceV1Schema } from '../../workspaces/projectSetup/projectManifestV1.js';
import { LocalServiceManagedServiceActionTargetV1Schema, ProjectServiceDeclarationRefV1Schema } from '../../local/services/actions/v1.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { ManagedControllerV1Schema } from '../../machines/managed/managedMachineV1.js';
import { ManagedResourceV1Schema } from '../../machines/managed/providerFactsV1.js';
import { ActionApprovalRequestCreatedResultSchema, ActionOperationCredentialUseV1Schema } from '../actionExecutionResult.js';
import { WorkspaceExecutionConfigAddressV1Schema } from '../../workspaces/projectWorkerPreferencesV1.js';

/** Existing operations that may hold their original Project setup invocation. */
export function canRetainProjectSetupReviewV1(actionId: string): boolean {
  return actionId === 'projects.prepare' || actionId === 'projects.script.run' || actionId === 'projects.compute.exec'
    || actionId === 'session.spawn_new' || actionId === 'session.fork' || actionId === 'session.handoff'
    || actionId === 'execution.run.start' || actionId === 'execution.run.ensure_or_start';
}

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

const ActionOperationIdentifierV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_IDENTIFIER_MAX_LENGTH_V1)));

const ActionOperationProgressPhaseV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1)));
const ActionOperationProgressLabelV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1)));

export const ActionOperationDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  visibility: z.literal('activity'),
  progress: z.enum(['indeterminate', 'reported']),
  presentation: z.strictObject({
    onStart: z.enum(['current', 'detail', 'activity']),
  }),
}));
export type ActionOperationDeclarationV1 = Readonly<z.infer<typeof ActionOperationDeclarationV1Schema>>;

/** Host-local Action declaration policy for an exact persisted request whose
 * original in-memory invocation is no longer available. This function is not
 * serialized into Action discovery or persisted operation snapshots. */
export const ActionOperationReentryDecisionV1Schema = lazyZodSchema(() => z.enum([
  'replay', 'reinvoke', 'resume', 'fresh', 'refuse',
]));
export type ActionOperationReentryDecisionV1 = z.infer<typeof ActionOperationReentryDecisionV1Schema>;
export type ActionOperationReentryPolicyV1 = (
  snapshot: ActionOperationSnapshotV1,
) => ActionOperationReentryDecisionV1;
export const ActionOperationReentryPolicyV1Schema = lazyZodSchema(() => z.custom<ActionOperationReentryPolicyV1>(
  (value) => typeof value === 'function',
  { message: 'Expected an Action operation re-entry policy' },
));

export const ActionOperationStateV1Schema = lazyZodSchema(() => z.enum([
  'accepted', 'running', 'succeeded', 'failed', 'cancelled',
]));
export type ActionOperationStateV1 = z.infer<typeof ActionOperationStateV1Schema>;

export const ActionOperationProgressV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('indeterminate'),
    label: z.optional(ActionOperationProgressLabelV1Schema),
  }),
  z.strictObject({
    kind: z.literal('phase'),
    phase: ActionOperationProgressPhaseV1Schema,
    label: ActionOperationProgressLabelV1Schema,
    /** Current target FIFO observation, not a percentage or admission token. */
    queueAhead: z.optional(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER))),
    /** The shared Action executor's blocking Ask; observation only, never decision authority. */
    approval: z.optional(ActionApprovalRequestCreatedResultSchema),
  }).check(z.refine(value => value.queueAhead === undefined || value.phase === 'queued', {
    path: ['queueAhead'], message: 'FIFO ahead is available only during the queued phase.',
  }), z.refine(value => value.approval === undefined || value.phase === 'waiting_for_approval', {
    path: ['approval'], message: 'An open Ask is available only during the approval wait.',
  })),
  z.strictObject({
    kind: z.literal('determinate'),
    current: z.number().check(z.nonnegative()),
    total: z.number().check(z.positive()),
    label: z.optional(ActionOperationProgressLabelV1Schema),
  }).check(z.refine((value) => value.current <= value.total, {
    path: ['current'],
    message: 'Determinate operation progress cannot exceed its total.',
  })),
]));
export type ActionOperationProgressV1 = Readonly<z.infer<typeof ActionOperationProgressV1Schema>>;

/** Public, redacted projection of the canonical terminal Action failure. */
const ActionOperationErrorCodeV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_ERROR_CODE_MAX_LENGTH_V1)));
/** Credential-free controller diagnostics on the current operation read epoch. */
export const ManagedControllerRequestFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('managedControllerRequest'),
  path: z.string().check(z.regex(/^\/v1\/machines\/managed\/(?:controller|actions)\/[a-z.-]+$/)),
  category: z.enum(['transport', 'status', 'schema', 'currentness']),
  status: z.optional(z.number().check(z.int(), z.minimum(100), z.maximum(599))),
  code: z.optional(z.string().check(z.regex(/^[a-z][a-z0-9_-]*$/i), z.maxLength(ACTION_OPERATION_ERROR_CODE_MAX_LENGTH_V1))),
}));
export type ManagedControllerRequestFailureDetailsV1 = Readonly<z.infer<typeof ManagedControllerRequestFailureDetailsV1Schema>>;
/** Interpreter process facts only; native output and submitted plans never cross this seam. */
export const ManagedBootstrapFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('managedBootstrap'),
  phase: z.enum(['check', 'apply']),
  response: z.enum(['missing_result', 'invalid_response', 'result']),
  exitStatus: z.number().check(z.int()),
  stdoutPresent: z.boolean(),
  stderrPresent: z.boolean(),
  resultStatus: z.optional(z.enum(['checked', 'applied', 'plan_changed', 'unsupported', 'unavailable', 'failed', 'cancelled', 'outcome_unknown'])),
  reason: z.optional(z.string().check(z.regex(/^[a-z][a-z0-9_]*$/i), z.maxLength(ACTION_OPERATION_ERROR_CODE_MAX_LENGTH_V1))),
}).check(z.refine(value => value.response === 'result'
  ? value.resultStatus !== undefined
  : value.resultStatus === undefined && value.reason === undefined)));
export type ManagedBootstrapFailureDetailsV1 = Readonly<z.infer<typeof ManagedBootstrapFailureDetailsV1Schema>>;
export const ActionOperationFailureV1Schema = lazyZodSchema(() => z.strictObject({
  errorCode: ActionOperationErrorCodeV1Schema,
  error: z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_ERROR_MAX_LENGTH_V1)),
  details: z.optional(z.union([ProjectSetupConsentFailureDetailsV1Schema, ProjectScriptEffectChangedFailureDetailsV1Schema,
    ProjectWorkerNoAcceptanceFailureDetailsV1Schema, ApprovalStaleFailureDetailsSchema, ManagedControllerRequestFailureDetailsV1Schema])),
}).check(z.refine(failure => !failure.details || (!('kind' in failure.details)
  ? failure.errorCode === 'approval_stale'
  : failure.details.kind === 'managedControllerRequest'
  ? !failure.details.code || failure.details.code === failure.errorCode
  : failure.details.kind === 'pendingApproval'
  ? failure.details.code === failure.errorCode
  : readProjectWorkerNoAcceptanceFailureV1({ ok: false, ...failure }) !== null), {
  path: ['details'], message: 'Public refusal facts must match their terminal failure code.',
})));
export type ActionOperationFailureV1 = Readonly<z.infer<typeof ActionOperationFailureV1Schema>>;

/** Actual command/output target, independent of the operation's observation custody. */
export const ProjectCommandAttachmentV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('projectCommand'),
  purpose: z.enum(['setup', 'teardown', 'script', 'exec']),
  serverId: ActionOperationIdentifierV1Schema,
  machineId: ActionOperationIdentifierV1Schema,
  workspaceRefId: ActionOperationIdentifierV1Schema,
  cwd: z.string().check(z.minLength(1)),
  /** Final execution-target edge, observed only after its completed clean Sync barrier. */
  lastCleanSyncAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)))),
  terminalId: z.optional(ActionOperationIdentifierV1Schema),
  sourceWorkspace: z.optional(WorkspaceAddressV1Schema),
  script: z.optional(z.strictObject({
    name: z.optional(z.string().check(z.minLength(1))),
    source: ProjectCommandSourceV1Schema,
  })),
  exitCode: z.optional(z.number().check(z.int())),
  originRun: z.optional(z.strictObject({
    kind: z.literal('workflow_run'),
    serverId: ActionOperationIdentifierV1Schema,
    runId: ActionOperationIdentifierV1Schema,
  })),
}).check(z.superRefine((attachment, context) => {
  if (attachment.script && !attachment.sourceWorkspace) {
    context.addIssue({ code: 'custom', path: ['sourceWorkspace'], message: 'Script identity requires its original qualified Source workspace.' });
  }
  if (attachment.exitCode !== undefined && !attachment.terminalId) {
    context.addIssue({ code: 'custom', path: ['exitCode'], message: 'Observed process exit requires its actual terminal association.' });
  }
})));
export type ProjectCommandAttachmentV1 = Readonly<z.infer<typeof ProjectCommandAttachmentV1Schema>>;

export const ActionOperationDomainRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('forkRequest'),
    id: ActionOperationIdentifierV1Schema,
    strategy: z.optional(SessionForkStrategySchema),
  }),
  z.strictObject({ kind: z.literal('spawnAttempt'), id: ActionOperationIdentifierV1Schema }),
  z.strictObject({ kind: z.literal('managedMachine'), id: ActionOperationIdentifierV1Schema,
    /** Enrollment and native boot recovery share this exact retained resource. */
    controller: z.optional(z.lazy(() => ManagedControllerV1Schema)),
    resource: z.optional(z.lazy(() => ManagedResourceV1Schema)),
    bootstrapTask: z.optional(z.strictObject({ id: ActionOperationIdentifierV1Schema,
      taskKind: z.literal('remote.ssh.bootstrapMachine.v1'),
      /** The task's current unanswered question, so the waiting surface can ask it; answered through `tool.systemTasks` `respond`. */
      prompt: z.optional(z.strictObject({ kind: ActionOperationProgressPhaseV1Schema, message: ActionOperationProgressLabelV1Schema })),
    })),
  }),
  z.strictObject({
    kind: z.literal('systemTask'),
    id: ActionOperationIdentifierV1Schema,
    taskKind: z.literal('remote.ssh.bootstrapMachine.v1'),
  }),
  z.strictObject({
    kind: z.literal('handoff'),
    id: ActionOperationIdentifierV1Schema,
    targetMachineId: z.optional(ActionOperationIdentifierV1Schema),
  }),
  ProjectCommandAttachmentV1Schema,
  z.strictObject({
    kind: z.literal('machineEnvironment'),
    serverId: ActionOperationIdentifierV1Schema,
    machineId: ActionOperationIdentifierV1Schema,
    preset: z.strictObject({ id: ActionOperationIdentifierV1Schema, revision: z.number().check(z.int(), z.nonnegative()) }),
    managedId: z.optional(ActionOperationIdentifierV1Schema),
    terminalId: z.optional(ActionOperationIdentifierV1Schema),
    terminals: z.optional(z.strictObject({
      install: z.optional(ActionOperationIdentifierV1Schema),
      setup: z.optional(ActionOperationIdentifierV1Schema),
    })),
    exitCode: z.optional(z.number().check(z.int())),
  }),
  z.strictObject({
    kind: z.literal('projectService'),
    purpose: z.enum(['start', 'relocation']),
    /** Original checkout remains stable while native custody changes Machines. */
    sourceWorkspace: z.optional(WorkspaceExecutionConfigAddressV1Schema),
    destinationWorkspace: z.optional(WorkspaceAddressV1Schema),
    workspace: WorkspaceAddressV1Schema,
    declaration: ProjectServiceDeclarationRefV1Schema,
    currentTarget: z.optional(LocalServiceManagedServiceActionTargetV1Schema),
  }),
]).check(z.superRefine((reference, context) => {
  if (reference.kind === 'machineEnvironment' && reference.exitCode !== undefined && !reference.terminalId) {
    context.addIssue({ code: 'custom', path: ['exitCode'],
      message: 'Observed process exit requires its actual terminal association.' });
  }
  if (reference.kind === 'machineEnvironment' && reference.terminals && reference.terminalId
    && !Object.values(reference.terminals).includes(reference.terminalId)) {
    context.addIssue({ code: 'custom', path: ['terminalId'],
      message: 'Current setup output must be one of its observed phase terminals.' });
  }
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
})));
export type ActionOperationDomainRefV1 = Readonly<z.infer<typeof ActionOperationDomainRefV1Schema>>;

const ActionOperationTimestampV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));

export const ActionOperationObservationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['outcome_uncertain', 'stop_unconfirmed']),
  code: ActionOperationErrorCodeV1Schema,
}));
export type ActionOperationObservationV1 = Readonly<z.infer<typeof ActionOperationObservationV1Schema>>;

export const ActionOperationSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  operationId: ActionOperationIdentifierV1Schema,
  revision: z.number().check(z.int(), z.positive()),
  actionId: ActionOperationIdentifierV1Schema,
  state: ActionOperationStateV1Schema,
  scope: z.strictObject({
    accountId: ActionOperationIdentifierV1Schema,
    machineId: ActionOperationIdentifierV1Schema,
    sessionId: z.optional(ActionOperationIdentifierV1Schema),
  }),
  title: z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_TITLE_MAX_LENGTH_V1)),
  requestId: z.optional(ActionOperationIdentifierV1Schema),
  createdAt: ActionOperationTimestampV1Schema,
  startedAt: z.optional(ActionOperationTimestampV1Schema),
  settledAt: z.optional(ActionOperationTimestampV1Schema),
  progress: z.optional(ActionOperationProgressV1Schema),
  result: z.optional(z.unknown()),
  /** Current V2 read only: historical host-observed actors, never credential authority. */
  operationCredentialUses: z.optional(z.array(ActionOperationCredentialUseV1Schema)),
  error: z.optional(ActionOperationFailureV1Schema),
  domainRef: z.optional(ActionOperationDomainRefV1Schema),
  observation: z.optional(ActionOperationObservationV1Schema),
  setupReview: z.optional(ProjectSetupConsentFailureDetailsV1Schema),
  cancellation: z.enum(['unsupported', 'supported']),
}).check(z.superRefine((snapshot, context) => {
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
    || !canRetainProjectSetupReviewV1(snapshot.actionId)
    || !['projects.prepare', 'projects.script.run', 'projects.compute.exec'].includes(snapshot.actionId)
      && snapshot.domainRef.purpose !== 'setup')) {
    context.addIssue({ code: 'custom', path: ['setupReview'], message: 'Only live Project preparation operations may retain a no-effect setup review.' });
  }
  if (snapshot.startedAt !== undefined && snapshot.startedAt < snapshot.createdAt) {
    context.addIssue({ code: 'custom', path: ['startedAt'], message: 'startedAt cannot precede createdAt.' });
  }
  if (snapshot.settledAt !== undefined && snapshot.startedAt !== undefined && snapshot.settledAt < snapshot.startedAt) {
    context.addIssue({ code: 'custom', path: ['settledAt'], message: 'settledAt cannot precede startedAt.' });
  }
})));
export type ActionOperationSnapshotV1 = Readonly<z.infer<typeof ActionOperationSnapshotV1Schema>>;

/** The closed ../0.2 reader at 37a6541578749067b49d4579be8c752c9591b8c8
 * predates current domain and review facts. Project only the V1 outward seam;
 * current readers use V2 and the store retains the complete owner observation.
 * Remove this projection when that supported predecessor reader is retired. */
export function projectActionOperationSnapshotForV1Reader(snapshot: ActionOperationSnapshotV1): ActionOperationSnapshotV1 {
  const { domainRef, setupReview: _review, observation: _observation, operationCredentialUses: _credentialUses,
    error, progress, ...projection } = snapshot;
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

export const ActionOperationSnapshotPushV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  machineId: ActionOperationIdentifierV1Schema,
  ciphertext: z.string().check(z.minLength(1)),
}));
export type ActionOperationSnapshotPushV1 = Readonly<z.infer<typeof ActionOperationSnapshotPushV1Schema>>;

export const ActionOperationSnapshotEphemeralV1Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal(ACTION_OPERATION_SNAPSHOT_EPHEMERAL_TYPE_V1),
  machineId: ActionOperationIdentifierV1Schema,
  ciphertext: z.string().check(z.minLength(1)),
}));
export type ActionOperationSnapshotEphemeralV1 = Readonly<z.infer<typeof ActionOperationSnapshotEphemeralV1Schema>>;

export const ActionOperationRevisionEphemeralV1Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal(ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1),
  machineId: ActionOperationIdentifierV1Schema,
  content: z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.trim(), z.minLength(1)) }),
    z.strictObject({ t: z.literal('plain'), v: ActionOperationSnapshotV1Schema }),
  ]),
}));
export type ActionOperationRevisionEphemeralV1 = Readonly<z.infer<typeof ActionOperationRevisionEphemeralV1Schema>>;

export const ActionOperationListV1RequestSchema = lazyZodSchema(() => z.strictObject({
  states: z.optional(z.array(ActionOperationStateV1Schema).check(z.maxLength(ActionOperationStateV1Schema.options.length))),
  sessionId: z.optional(ActionOperationIdentifierV1Schema),
  cursor: z.optional(ActionOperationIdentifierV1Schema),
}).check(z.superRefine((request, context) => {
  if (request.states && new Set(request.states).size !== request.states.length) {
    context.addIssue({ code: 'custom', path: ['states'], message: 'states must not contain duplicates.' });
  }
})));
export type ActionOperationListV1Request = z.infer<typeof ActionOperationListV1RequestSchema>;

export const ActionOperationListV1ResponseSchema = lazyZodSchema(() => z.strictObject({
  items: z.array(ActionOperationSnapshotV1Schema),
  nextCursor: z.nullable(ActionOperationIdentifierV1Schema),
}));
export type ActionOperationListV1Response = z.infer<typeof ActionOperationListV1ResponseSchema>;

export const ActionOperationGetV1RequestSchema = lazyZodSchema(() => z.strictObject({
  operationId: ActionOperationIdentifierV1Schema,
  waitForTerminal: z.optional(z.literal(true)),
  /** FIN may observe an explicit no-effect review before process settlement. */
  includeSetupReview: z.optional(z.literal(true)),
}).check(z.refine(request => !request.includeSetupReview || request.waitForTerminal === true, {
  path: ['includeSetupReview'], message: 'Setup review observation requires the existing wait owner.',
})));
export type ActionOperationGetV1Request = z.infer<typeof ActionOperationGetV1RequestSchema>;
export const ActionOperationGetV2RequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(ActionOperationGetV1RequestSchema, {
  /** Remeasure a held effect before a human decision without waiting for command exit. */
  refreshSetupReview: z.optional(z.literal(true)),
})));
export type ActionOperationGetV2Request = z.infer<typeof ActionOperationGetV2RequestSchema>;

const ActionOperationNotFoundV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('not_found') }));

export const ActionOperationGetV1ResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('found'), operation: ActionOperationSnapshotV1Schema }),
  ActionOperationNotFoundV1Schema,
]));
export type ActionOperationGetV1Response = z.infer<typeof ActionOperationGetV1ResponseSchema>;

export const ActionOperationCancelV1RequestSchema = lazyZodSchema(() => z.strictObject({
  operationId: ActionOperationIdentifierV1Schema,
}));
export type ActionOperationCancelV1Request = z.infer<typeof ActionOperationCancelV1RequestSchema>;

export const ActionOperationCancelV1ResponseSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unsupported') }),
  z.strictObject({ kind: z.literal('requested') }),
  z.strictObject({ kind: z.literal('already_settled') }),
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

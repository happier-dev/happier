import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { HomeApplicationOriginV1Schema } from '../../auth/accountDirectory.js';
import { DeploymentReceiptSettlementFailureDetailsV1Schema, readDeploymentReceiptFailureCodeV1 } from '../../deployments/deploymentReceiptResultV1.js';
import { DeploymentExecutionFailureDetailsV1Schema } from '../../deployments/deploymentReceiptEventsV1.js';
import { z } from '../../zodRuntimePolicy.js';
import { MachineSudoPasswordPromptV1Schema, MachineElevationFailureV1Schema } from '../../machines/adminAccessV1.js';
import { MachineVitalsHostFactsV1Schema } from '../../machines/vitals/machineVitalsSampleV1.js';
import { MachineAvailabilityDiagnosticV1Schema } from '../../machines/machineAccessV1.js';
import { MachineRebootResultV1Schema } from '../specs/machine/reboot.js';
import { MachineServiceAdoptResultV1Schema } from '../../local/services/adoptionV1.js';
import { OpenProjectResultV1Schema } from '../../projects/openProjectV1.js';
import { SessionAgentUpdateNoticeV1Schema, SessionSpawnNewActionResultV1Schema } from '../../sessions/creation/sessionSpawnNewResultV1.js';
import { MachineServiceHealthCheckSubjectV1Schema } from '../../deployments/healthCheckSubjectV1.js';
import { MachineDeploymentDomainReferenceV1Schema } from '../../machines/machineDeploymentDomainReferenceV1.js';
import { asProtocolZod, projectZodProtocolSchema } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginLocalizedStringV2Schema } from '../../plugins/contributions/publicTypes.js';
import { parseQualifiedPluginContributionKey } from '../../plugins/contributionIdentity.js';
import { PluginActionFailureResponseV1Schema } from '../../plugins/actions/failureResponse.js';

import { SessionForkStrategySchema } from '../../sessions/fork.js';
import { ProjectSetupConsentFailureDetailsV1Schema, ProjectScriptEffectChangedFailureDetailsV1Schema } from '../projectSetupConsentFailure.js';
import { ProjectWorkerNoAcceptanceFailureDetailsV1Schema, readProjectWorkerNoAcceptanceFailureV1 } from '../projectWorkerRefusal.js';
import { ApprovalStaleFailureDetailsSchema } from '../../approvals/approvalStaleReason.js';
import { WorkspaceAddressV1Schema } from '../../workspaces/workspaceRefV1.js';
import { ProjectCommandSourceV1Schema } from '../../workspaces/projectSetup/projectManifestV1.js';
import { LocalServiceManagedServiceActionTargetV1Schema, ProjectServiceDeclarationRefV1Schema } from '../../local/services/actions/v1.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { ManagedControllerV1Schema } from '../../machines/managed/managedMachineV1.js';
import { ManagedResourceV1Schema, MachineProvisionerNativeCauseV1Schema } from '../../machines/managed/providerFactsV1.js';
import { MachineAdministratorUsernameV1Schema } from '../../machines/adminAccessV1.js';
import { ActionApprovalRequestCreatedResultSchema, ActionOperationCredentialUseV1Schema, ActionFailureCauseV1Schema,
  readActionFailureCauseV1, UNKNOWN_ACTION_FAILURE_CAUSE_V1, type ActionExecuteResult } from '../actionExecutionResult.js';
import { WorkspaceExecutionConfigAddressV1Schema } from '../../workspaces/projectWorkerPreferencesV1.js';
import { ActionOperationIdentifierV1Schema, ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1 } from './identifierV1.js';
import { MachineAgentIsolationReadyPreviewV1Schema, MachineAgentIsolationUnavailableStatusV1Schema, MachineAgentIsolationPolicyV1Schema,
  MachineAgentIsolationSetResultV1Schema } from '../../machines/agentIsolationV1.js';
import { DeploymentTargetLinkProvisionedResultV1Schema } from '../../deployments/deploymentActionsV1.js';
import { DeploymentTemplateInstantiationPartialV1Schema } from '../../deployments/deploymentTemplateInstantiationV1.js';
import { HomeAuthorityMismatchFailureDetailsV1Schema } from '../../ssh/homeAuthorityMismatch.js';
import { GuestServiceFailureFactsV1Schema } from '../../ssh/commandFailure.js';
import { OpenProjectRefusalV1Schema } from '../../projects/openProjectV1.js';
import { DeploymentDomainFailureDetailsV1Schema } from '../../deployments/deploymentDomainFailureV1.js';
import { MachineReachabilityNativeFailureDetailsV1Schema } from '../../machines/reachability/nativeFailureV1.js';
import { MachineReachabilityConfigureResultV1Schema } from '../../machines/reachability/actionsV1.js';
import { MACHINE_REACHABILITY_CONFIGURE_ACTION_ID_V1 } from '../../machines/reachability/actionIdsV1.js';
import { DeploymentDomainCaddyFailureDetailsV1Schema } from '../../deployments/deploymentDomainCaddyFailureV1.js';
import { DeploymentFailureRecoveryV1Schema } from '../../deployments/deploymentFailureRecoveryV1.js';
import { DeploymentBackupFailureResultV1Schema, readDeploymentBackupMaintenanceFailureEvidenceV1,
  type DeploymentBackupFailureResultV1 } from '../../deployments/deploymentBackupActionsV1.js';
import { MachineProvisionerSnapshotResultV1Schema } from '../../plugins/contributions/machineProvisioners.js';
import { DeploymentRestoreFailureResultV1Schema, type DeploymentRestoreFailureResultV1 } from '../../deployments/deploymentBackupRestoreV1.js';
import { DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, DEPLOYMENT_TEARDOWN_ACTION_ID_V1, isDeploymentBackupActionIdV1, isDeploymentTargetLinkActionIdV1 } from '../../deployments/deploymentActionIdsV1.js';
export { ActionOperationIdentifierV1Schema, ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1 } from './identifierV1.js';
export { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } from './methodsV1.js';

/** Existing operations that may hold their original Project setup invocation. */
export function canRetainProjectSetupReviewV1(actionId: string): boolean {
  return actionId === 'projects.prepare' || actionId === 'projects.script.run' || actionId === 'projects.compute.exec'
    || actionId === 'session.spawn_new' || actionId === 'session.fork' || actionId === 'session.handoff'
    || actionId === 'execution.run.start' || actionId === 'execution.run.ensure_or_start';
}

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
const ACTION_OPERATION_TITLE_MAX_LENGTH_V1 = 10_000;
const ACTION_OPERATION_ERROR_CODE_MAX_LENGTH_V1 = 200;
const ACTION_OPERATION_ERROR_MAX_LENGTH_V1 = 10_000;


export const ActionOperationProgressPhaseV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1)));
const ActionOperationProgressLabelV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1)));

/** Finite process settlement facts only; command bodies, environment and output never enter this carrier. */
export const FiniteCommandFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('finiteCommand'),
  phase: ActionOperationProgressPhaseV1Schema,
  step: z.optional(z.number().check(z.int(), z.gte(0))),
  exitCode: z.nullable(z.number().check(z.int())),
  signal: z.nullable(z.number().check(z.int())),
}));
export type FiniteCommandFailureDetailsV1 = Readonly<z.infer<typeof FiniteCommandFailureDetailsV1Schema>>;

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
 * serialized into Action discovery or persisted operation snapshots. `fresh`
 * retains exact input identity; `freshEquivalentInput` lets the domain recognize
 * equivalent prepared input after a confirmed no-effect failure. */
export const ActionOperationReentryDecisionV1Schema = lazyZodSchema(() => z.enum([
  'replay', 'reinvoke', 'resume', 'fresh', 'freshEquivalentInput', 'refuse',
]));
export type ActionOperationReentryDecisionV1 = z.infer<typeof ActionOperationReentryDecisionV1Schema>;
export type ActionOperationReentryPolicyV1 = (
  snapshot: ActionOperationSnapshotV1,
  input?: unknown,
) => ActionOperationReentryDecisionV1;
export const ActionOperationReentryPolicyV1Schema = lazyZodSchema(() => z.custom<ActionOperationReentryPolicyV1>(
  (value) => typeof value === 'function',
  { message: 'Expected an Action operation re-entry policy' },
));

/** The original admitted teardown may continue its unproved cleanup in place.
 * Imported history without the admitted receipt correspondence cannot resume. */
export function canResumeDeploymentTeardownOperationV1(snapshot: ActionOperationSnapshotV1): boolean {
  return snapshot.actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1 && snapshot.state === 'failed'
    && snapshot.domainRef?.kind === 'deployment';
}
export const deploymentTeardownOperationReentryV1: ActionOperationReentryPolicyV1 = snapshot =>
  canResumeDeploymentTeardownOperationV1(snapshot) ? 'reinvoke'
    : snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled' ? 'replay' : 'refuse';

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
export const ManagedNativeFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('managedNative'), nativeCause: MachineProvisionerNativeCauseV1Schema,
}));
export type ManagedNativeFailureDetailsV1 = Readonly<z.infer<typeof ManagedNativeFailureDetailsV1Schema>>;
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
/** Service CLI failures carry closed JSON facts; retain stored/native-process tails. */
export const ManagedServiceFailureDetailsV1Schema = lazyZodSchema(() => z.union([z.strictObject({
  kind: z.literal('managedService'),
  step: z.enum(['install', 'restart']),
  exitStatus: z.number().check(z.int()),
  cause: z.nullable(GuestServiceFailureFactsV1Schema),
}), z.strictObject({
  kind: z.literal('managedService'),
  step: z.enum(['install', 'restart', 'start']),
  exitStatus: z.number().check(z.int()),
  stderrTail: z.string(),
})]));
export type ManagedServiceFailureDetailsV1 = Readonly<z.infer<typeof ManagedServiceFailureDetailsV1Schema>>;
/** Preserve the isolation owner's closed refusal without native output or recovery payloads. */
export const ManagedAgentIsolationFailureDetailsV1Schema = lazyZodSchema(() => z.union([z.strictObject({
  kind: z.literal('managedAgentIsolation'),
  phase: z.literal('machines.agentIsolation.preview'),
  status: MachineAgentIsolationUnavailableStatusV1Schema,
}), z.strictObject({
  kind: z.literal('managedAgentIsolation'),
  phase: z.literal('machines.agentIsolation.set'),
  code: z.enum(['conflict', 'plan_changed']),
  expectedMetadataVersion: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  metadataVersion: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  expectedPolicy: MachineAgentIsolationPolicyV1Schema,
  policy: MachineAgentIsolationPolicyV1Schema,
})]));
export type ManagedAgentIsolationFailureDetailsV1 = Readonly<z.infer<typeof ManagedAgentIsolationFailureDetailsV1Schema>>;
/** Exact enrolled target needed by the existing Agent setup recovery. */
export const ManagedAgentStartFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('managedAgentStart'),
  machineId: z.string().check(z.minLength(1)),
  agentId: z.string().check(z.minLength(1)),
}));
/** Selected, credential-free application carrier for guest reachability failures. */
export const ManagedGuestHomeFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('managedGuestHome'), homeOrigin: HomeApplicationOriginV1Schema,
}));
export const ManagedMachineFailureDetailsV1Schema = lazyZodSchema(() => z.union([
  ManagedControllerRequestFailureDetailsV1Schema, ManagedNativeFailureDetailsV1Schema,
  ManagedBootstrapFailureDetailsV1Schema, ManagedServiceFailureDetailsV1Schema, ManagedAgentIsolationFailureDetailsV1Schema,
  ManagedAgentStartFailureDetailsV1Schema, ManagedGuestHomeFailureDetailsV1Schema,
]));
export type ManagedMachineFailureDetailsV1 = Readonly<z.infer<typeof ManagedMachineFailureDetailsV1Schema>>;
/** Pre-native Setup availability facts only; no Account, installation or native content. */
export const MachineSetupTargetUnavailableFailureV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('target_unavailable'),
  phase: z.literal('machine_setup_target'),
  branch: z.enum(['installed_runtime', 'finite_terminal']),
  reason: z.optional(z.enum(['admission', 'lifetime', 'installation', 'account', 'credentials', 'runtime_closed', 'exception'])),
}));
export type MachineSetupTargetUnavailableFailureV1 = Readonly<z.infer<typeof MachineSetupTargetUnavailableFailureV1Schema>>;
/** Reuse the native owner's diagnostic alongside the pre-native Setup refusal. */
export const MachineSetupFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('machineSetup'),
  failure: z.union([MachineElevationFailureV1Schema, MachineSetupTargetUnavailableFailureV1Schema]),
}));
export const ActionOperationFailureV1Schema = lazyZodSchema(() => z.strictObject({
  errorCode: ActionOperationErrorCodeV1Schema,
  error: z.string().check(z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_ERROR_MAX_LENGTH_V1)),
  effectAttempted: z.optional(z.boolean()),
  failureCause: z.optional(ActionFailureCauseV1Schema),
  details: z.optional(z.union([ProjectSetupConsentFailureDetailsV1Schema, ProjectScriptEffectChangedFailureDetailsV1Schema,
    ProjectWorkerNoAcceptanceFailureDetailsV1Schema, ApprovalStaleFailureDetailsSchema, ManagedMachineFailureDetailsV1Schema,
    MachineSetupFailureDetailsV1Schema, FiniteCommandFailureDetailsV1Schema, HomeAuthorityMismatchFailureDetailsV1Schema,
    DeploymentTemplateInstantiationPartialV1Schema, OpenProjectRefusalV1Schema, DeploymentDomainFailureDetailsV1Schema, DeploymentFailureRecoveryV1Schema,
    DeploymentReceiptSettlementFailureDetailsV1Schema,
    MachineReachabilityNativeFailureDetailsV1Schema,
    DeploymentExecutionFailureDetailsV1Schema,
    MachineAvailabilityDiagnosticV1Schema])),
}).check(z.refine(failure => !failure.details || (!('kind' in failure.details)
  ? 'domainId' in failure.details || ('state' in failure.details ? readDeploymentReceiptFailureCodeV1(failure.details.state) === failure.errorCode
    : 'failure' in failure.details ? (!!failure.details.failure && ('kind' in failure.details.failure
      ? DeploymentDomainCaddyFailureDetailsV1Schema.safeParse(failure.details).success
        ? failure.errorCode === failure.details.failure.reason
        : MachineElevationFailureV1Schema.safeParse(failure.details.failure).success
          ? failure.errorCode === failure.details.failure.kind
          : failure.errorCode === failure.details.failure.reason
      : failure.errorCode === failure.details.failure.code))
      || ('cleanupFailure' in failure.details && failure.errorCode === failure.details.cleanupFailure?.code)
    : 'requiredFact' in failure.details
    ? DeploymentFailureRecoveryV1Schema.shape.requiredFact.safeParse(failure.details.requiredFact).success || failure.errorCode === 'target_unavailable'
    // A saved prior state is recovery material, independent of the failure's cause.
    : 'status' in failure.details && failure.details.status === 'recoveryRequired'
      && 'recovery' in failure.details && failure.details.recovery !== undefined
      && !('restoration' in failure.details)
      || failure.errorCode === 'approval_stale')
  : failure.details.kind === 'finiteCommand'
  ? true
  : failure.details.kind === 'machineSetup'
  ? failure.errorCode === 'outcome_unknown' || failure.errorCode === failure.details.failure.kind
    || failure.errorCode === 'platform_unsupported'
  : failure.details.kind === 'partial'
  ? failure.details.errorCode === failure.errorCode
  : failure.details.kind === 'refused'
  ? failure.details.code === failure.errorCode
  : failure.details.kind === 'managedControllerRequest'
  ? !failure.details.code || failure.details.code === failure.errorCode
  : failure.details.kind === 'managedNative'
  ? true
  : failure.details.kind === 'managedGuestHome'
  ? failure.errorCode === 'home_not_guest_reachable'
  : failure.details.kind === 'managedAgentStart'
  ? true
  : failure.details.kind === 'managedBootstrap'
  ? /^bootstrap_effect_[a-z_]+$/u.test(failure.errorCode)
  : failure.details.kind === 'managedService'
  ? failure.errorCode === 'background_service_failed'
  : failure.details.kind === 'managedAgentIsolation'
  ? (failure.details.phase === 'machines.agentIsolation.preview' ? failure.details.status.code : failure.details.code) === failure.errorCode
  : failure.details.kind === 'homeAuthorityMismatch'
  ? failure.errorCode === 'HOME_AUTHORITY_MISMATCH' || failure.errorCode === 'remote_command_failed'
  : failure.details.kind === 'pendingApproval'
  ? failure.details.code === failure.errorCode
  : readProjectWorkerNoAcceptanceFailureV1({ ok: false, ...failure }) !== null), {
  path: ['details'], message: 'Public refusal facts must match their terminal failure code.',
})));
export type ActionOperationFailureV1 = Readonly<z.infer<typeof ActionOperationFailureV1Schema>>;

/** Transient failure diagnostics are additive-open/drop; lifecycle and known details stay closed. */
export const ActionOperationFailureV1ReadSchema = lazyZodSchema(() => z.pipe(z.transform(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return {
    errorCode: record.errorCode,
    error: record.error,
    ...(record.effectAttempted === undefined ? {} : { effectAttempted: record.effectAttempted }),
    ...(record.details === undefined ? {} : { details: record.details }),
    ...(record.failureCause !== undefined ? { failureCause: readActionFailureCauseV1(record.failureCause) }
      : 'cause' in record ? { failureCause: UNKNOWN_ACTION_FAILURE_CAUSE_V1 } : {}),
  };
}), ActionOperationFailureV1Schema));

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

/** Existing managed installation decisions retain their exact displayed question. */
export const ManagedMachineBootstrapApprovalPromptV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('auth.approveRemoteProvisioning'), message: ActionOperationProgressLabelV1Schema }),
  z.strictObject({ kind: z.enum(['ssh.trustHost', 'ssh.replaceHostKey']), message: ActionOperationProgressLabelV1Schema,
    host: z.string().check(z.trim(), z.minLength(1)), keyType: z.nullable(z.string()),
    fingerprint: z.string().check(z.trim(), z.minLength(1)), existingFingerprint: z.nullable(z.string()),
  }),
  z.strictObject({ kind: z.literal('daemon.replaceRemoteBackgroundServices'), message: ActionOperationProgressLabelV1Schema }),
]));
/** Only nonsecret prompt identity is published; the password travels in the transient response. */
export const ManagedMachineBootstrapEstablishPromptV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('administrator.establish'), promptId: ActionOperationIdentifierV1Schema,
  administratorUsername: MachineAdministratorUsernameV1Schema, message: ActionOperationProgressLabelV1Schema,
}));
export type ManagedMachineBootstrapEstablishPromptV1 = Readonly<z.infer<typeof ManagedMachineBootstrapEstablishPromptV1Schema>>;
export const ManagedMachineBootstrapPromptV1Schema = lazyZodSchema(() => z.union([
  ManagedMachineBootstrapApprovalPromptV1Schema, ManagedMachineBootstrapEstablishPromptV1Schema,
]));
export type ManagedMachineBootstrapPromptV1 = Readonly<z.infer<typeof ManagedMachineBootstrapPromptV1Schema>>;

export const ActionOperationDomainRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('machineService'), serverId: ActionOperationIdentifierV1Schema,
    operation: z.enum(['start', 'stop', 'restart']), generation: ActionOperationIdentifierV1Schema,
    subject: MachineServiceHealthCheckSubjectV1Schema,
  }),
  z.strictObject({
    kind: z.literal('deploymentTargetLink'), serverId: ActionOperationIdentifierV1Schema,
    environmentId: ActionOperationIdentifierV1Schema, requestKey: ActionOperationIdentifierV1Schema, purpose: z.enum(['create', 'associate']),
  }),
  z.strictObject({
    kind: z.literal('deployment'), serverId: ActionOperationIdentifierV1Schema,
    environmentId: ActionOperationIdentifierV1Schema, deploymentId: ActionOperationIdentifierV1Schema,
    /** Exact subjects declared by the admitted native owner before interruption. */
    expectedDown: z.optional(z.strictObject({
      operation: z.enum(['deploy', 'backup']), targetLinkId: ActionOperationIdentifierV1Schema,
      machineId: ActionOperationIdentifierV1Schema, installationId: ActionOperationIdentifierV1Schema,
      serviceIds: z.readonly(z.array(ActionOperationIdentifierV1Schema)),
      domains: z.readonly(z.array(MachineDeploymentDomainReferenceV1Schema)),
    })),
  }),
  z.strictObject({
    kind: z.literal('forkRequest'),
    id: ActionOperationIdentifierV1Schema,
    strategy: z.optional(SessionForkStrategySchema),
  }),
  z.strictObject({ kind: z.literal('spawnAttempt'), id: ActionOperationIdentifierV1Schema }),
  z.strictObject({ kind: z.literal('managedMachine'), id: ActionOperationIdentifierV1Schema,
    /** The guest Session launched with its runnable CLI while an optional update remains visible. */
    agentUpdate: z.optional(SessionAgentUpdateNoticeV1Schema),
    /** Enrollment and native boot recovery share this exact retained resource. */
    controller: z.optional(z.lazy(() => ManagedControllerV1Schema)),
    resource: z.optional(z.lazy(() => ManagedResourceV1Schema)),
    bootstrapTask: z.optional(z.strictObject({ id: ActionOperationIdentifierV1Schema,
      taskKind: z.literal('remote.ssh.bootstrapMachine.v1'),
      /** The task's current unanswered question, so the waiting surface can ask it; answered through `tool.systemTasks` `respond`. */
      prompt: z.optional(ManagedMachineBootstrapPromptV1Schema),
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
    kind: z.literal('machineSetup'),
    serverId: ActionOperationIdentifierV1Schema,
    machineId: ActionOperationIdentifierV1Schema,
    preset: z.optional(z.strictObject({ id: ActionOperationIdentifierV1Schema, revision: z.number().check(z.int(), z.nonnegative()) })),
    managedId: z.optional(ActionOperationIdentifierV1Schema),
    /** Reviewed native steps in plan order; display facts, never effect operands. */
    steps: z.optional(z.array(z.strictObject({
      planIndex: z.number().check(z.int(), z.nonnegative()),
      stepId: z.string().check(z.minLength(1)),
      label: PluginLocalizedStringV2Schema,
      state: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']),
      /** Machine-readable native reason only; no process output or submitted content. */
      failureCause: z.optional(z.string().check(z.minLength(1))),
    }))),
    setupTask: z.optional(z.strictObject({
      id: ActionOperationIdentifierV1Schema,
      taskKind: z.enum(['machine.setup.plan.v1', 'machine.setup.apply.v1', 'machine.setup.remove.v1']),
      prompt: z.optional(MachineSudoPasswordPromptV1Schema),
    })),
    terminalId: z.optional(ActionOperationIdentifierV1Schema),
    terminals: z.optional(z.strictObject({
      install: z.optional(ActionOperationIdentifierV1Schema),
      setup: z.optional(ActionOperationIdentifierV1Schema),
    })),
    exitCode: z.optional(z.number().check(z.int())),
  }),
  z.strictObject({
    kind: z.literal('machineReboot'),
    serverId: ActionOperationIdentifierV1Schema,
    machineId: ActionOperationIdentifierV1Schema,
    installationId: ActionOperationIdentifierV1Schema,
    task: z.strictObject({ id: ActionOperationIdentifierV1Schema, taskKind: z.literal('machine.reboot.v1'),
      prompt: z.optional(MachineSudoPasswordPromptV1Schema) }),
    basis: z.optional(z.strictObject({
      bootedAt: MachineVitalsHostFactsV1Schema.def.shape.bootedAt,
      expectedRunningServiceIds: z.readonly(z.array(z.string().check(z.minLength(1)))),
      expectedRunningServicesKnown: z.boolean(),
      dispatchStarted: z.literal(true),
      domains: z.optional(z.readonly(z.array(MachineDeploymentDomainReferenceV1Schema))),
    })),
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
  if (reference.kind === 'machineSetup' && reference.exitCode !== undefined && !reference.terminalId) {
    context.addIssue({ code: 'custom', path: ['exitCode'],
      message: 'Observed process exit requires its actual terminal association.' });
  }
  if (reference.kind === 'machineSetup' && reference.terminals && reference.terminalId
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

export const ActionOperationObservationV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.enum(['outcome_uncertain', 'stop_unconfirmed']), code: ActionOperationErrorCodeV1Schema }),
  z.strictObject({ kind: z.literal('review_required'), code: z.literal('agent_isolation_effect_changed'),
    machineId: ActionOperationIdentifierV1Schema, enabled: z.boolean(), current: MachineAgentIsolationReadyPreviewV1Schema }),
  z.strictObject({ kind: z.literal('review_required'), code: z.literal('restore_snapshot_not_confirmed'),
    snapshot: asProtocolZod(MachineProvisionerSnapshotResultV1Schema).check(z.refine(value => value.kind !== 'confirmed')) }),
]));
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
  error: z.optional(ActionOperationFailureV1ReadSchema),
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
  const observationFailure = !terminal && (snapshot.observation?.kind === 'outcome_uncertain'
    || snapshot.observation?.kind === 'stop_unconfirmed');
  if (snapshot.state === 'failed' && snapshot.error === undefined
    || snapshot.error !== undefined && snapshot.state !== 'failed' && !observationFailure) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'Errors require failure settlement or an unconfirmed observation.' });
  }
  if (snapshot.result !== undefined && snapshot.state !== 'succeeded') {
    // This new Action returns closed domain refusals, not physical success.
    // Preserve the exact receipt without accepting arbitrary failed results
    // or treating a dispatch receipt as terminal process evidence.
    const rebootRefusal = snapshot.actionId === 'machines.reboot' && snapshot.state === 'failed'
      ? MachineRebootResultV1Schema.safeParse(snapshot.result) : null;
    const adoptionContinuation = snapshot.actionId === 'machines.services.adopt' && snapshot.state === 'running'
      && snapshot.observation?.kind === 'outcome_uncertain'
      ? MachineServiceAdoptResultV1Schema.safeParse(snapshot.result) : null;
    const projectOpen = snapshot.actionId === 'projects.open' ? OpenProjectResultV1Schema.safeParse(snapshot.result) : null;
    const projectOpenReceipt = projectOpen?.success && (snapshot.state === 'failed' && projectOpen.data.kind === 'refused'
      || snapshot.state === 'running' && snapshot.observation?.kind === 'outcome_uncertain' && projectOpen.data.kind === 'outcomeUnknown');
    const reachability = snapshot.actionId === MACHINE_REACHABILITY_CONFIGURE_ACTION_ID_V1
      ? MachineReachabilityConfigureResultV1Schema.safeParse(snapshot.result) : null;
    const reachabilityReceipt = reachability?.success && reachability.data.status === 'outcome_unknown'
      && (snapshot.state === 'failed' && snapshot.error?.errorCode === 'action_outcome_unknown'
        || snapshot.state === 'running' && snapshot.observation?.kind === 'outcome_uncertain'
          && snapshot.observation.code === (reachability.data.errorCode ?? 'action_outcome_unknown'));
    const spawn = snapshot.actionId === 'session.spawn_new' && snapshot.state === 'failed'
      ? SessionSpawnNewActionResultV1Schema.safeParse(snapshot.result) : null;
    const spawnRefusal = spawn?.success && spawn.data.type === 'error'
      && snapshot.error?.errorCode === spawn.data.code;
    const isolation = snapshot.actionId === 'machines.agentIsolation.set'
      && (snapshot.state === 'failed' || snapshot.state === 'cancelled')
      ? MachineAgentIsolationSetResultV1Schema.safeParse(snapshot.result) : null;
    const isolationRefusal = isolation?.success && isolation.data.kind === 'failed'
      && (snapshot.state === 'cancelled' ? isolation.data.code === 'cancelled'
        : snapshot.error?.errorCode === (isolation.data.setup?.failure?.kind ?? isolation.data.code));
    const backupSettlement = snapshot.state === 'failed' || snapshot.state === 'cancelled';
    const backup = backupSettlement && isDeploymentBackupActionIdV1(snapshot.actionId)
      ? DeploymentBackupFailureResultV1Schema.safeParse(snapshot.result) : null;
    const backupFailure = backup?.success
      && backup.data.code === (snapshot.state === 'cancelled' ? 'cancelled' : snapshot.error?.errorCode);
    const restore = backupSettlement && snapshot.actionId === DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1
      ? DeploymentRestoreFailureResultV1Schema.safeParse(snapshot.result) : null;
    const linkProvisioned = isDeploymentTargetLinkActionIdV1(snapshot.actionId) && snapshot.state !== 'accepted'
      ? DeploymentTargetLinkProvisionedResultV1Schema.safeParse(snapshot.result) : null;
    const contributed = snapshot.state === 'failed' && parseQualifiedPluginContributionKey(snapshot.actionId)
      ? PluginActionFailureResponseV1Schema.safeParse(snapshot.result) : null;
    const contributedRefusal = contributed?.success && contributed.data.code === snapshot.error?.errorCode;
    if ((!rebootRefusal?.success || rebootRefusal.data.kind === 'accepted')
      && (!adoptionContinuation?.success || adoptionContinuation.data.kind !== 'partial') && !projectOpenReceipt && !spawnRefusal
      && !backupFailure && !restore?.success && !linkProvisioned?.success && !contributedRefusal && !isolationRefusal && !reachabilityReceipt) {
      context.addIssue({ code: 'custom', path: ['result'], message: 'Results must match their operation settlement or typed continuation.' });
    }
  }
  if (terminal && snapshot.observation !== undefined) {
    context.addIssue({ code: 'custom', path: ['observation'], message: 'Unconfirmed observations cannot accompany terminal process evidence.' });
  }
  if (snapshot.observation?.kind === 'review_required' && snapshot.observation.code === 'agent_isolation_effect_changed'
    && (snapshot.actionId !== 'machines.agentIsolation.set'
    || snapshot.observation.machineId !== snapshot.scope.machineId)) {
    context.addIssue({ code: 'custom', path: ['observation'], message: 'Isolation review belongs to its exact Machine operation.' });
  }
  if (snapshot.observation?.kind === 'review_required' && snapshot.observation.code === 'restore_snapshot_not_confirmed'
    && (snapshot.actionId !== DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 || snapshot.domainRef?.kind !== 'deployment')) {
    context.addIssue({ code: 'custom', path: ['observation'], message: 'Snapshot review belongs to its exact restore operation.' });
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

/** Lists retain lifecycle facts while the full owner read carries terminal results. */
export function projectActionOperationListSnapshotV1(snapshot: ActionOperationSnapshotV1): ActionOperationSnapshotV1 {
  if (snapshot.result === undefined
    || snapshot.state !== 'succeeded' && snapshot.state !== 'failed' && snapshot.state !== 'cancelled') return snapshot;
  const { result: _result, ...summary } = snapshot;
  return summary;
}

/** Retain only named native backup facts; executor diagnostics never enter receipts. */
export function projectDeploymentBackupFailureResultV1(actionId: string, errorCode: string,
  details: unknown): DeploymentBackupFailureResultV1 | DeploymentRestoreFailureResultV1 | undefined {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  if (actionId === DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1) {
    const parsed = DeploymentRestoreFailureResultV1Schema.safeParse({ steps: 'steps' in details ? details.steps : undefined,
      ...readDeploymentBackupMaintenanceFailureEvidenceV1({ details }),
      ...('snapshot' in details ? { snapshot: details.snapshot } : {}) });
    return parsed.success ? parsed.data : undefined;
  }
  if (!isDeploymentBackupActionIdV1(actionId) || !('step' in details) || typeof details.step !== 'string') return undefined;
  const partial = readDeploymentBackupMaintenanceFailureEvidenceV1({ details });
  const parsed = DeploymentBackupFailureResultV1Schema.safeParse({ step: details.step, code: errorCode, ...partial });
  return parsed.success ? parsed.data : undefined;
}

/** Rejoin and transport recovery consume the same retained Action settlement. */
export function readActionOperationTerminalResultV1(snapshot: ActionOperationSnapshotV1): ActionExecuteResult | null {
  const metadata = snapshot.operationCredentialUses ? { operationCredentialUses: snapshot.operationCredentialUses } : {};
  if (snapshot.state === 'succeeded') return { ok: true, result: snapshot.result, ...metadata };
  if (snapshot.state === 'failed') {
    const spawn = snapshot.actionId === 'session.spawn_new'
      ? SessionSpawnNewActionResultV1Schema.safeParse(snapshot.result) : null;
    if (spawn?.success && spawn.data.type === 'error') return { ok: true, result: spawn.data, ...metadata };
    const isolation = snapshot.actionId === 'machines.agentIsolation.set'
      ? MachineAgentIsolationSetResultV1Schema.safeParse(snapshot.result) : null;
    if (isolation?.success && isolation.data.kind === 'failed') return { ok: true, result: isolation.data, ...metadata };
    const backupFailure = projectDeploymentBackupFailureResultV1(snapshot.actionId,
      snapshot.error?.errorCode ?? 'action_operation_failed', snapshot.result);
    return {
      ok: false,
      errorCode: snapshot.error?.errorCode ?? 'action_operation_failed',
      error: snapshot.error?.error ?? 'action_operation_failed',
      ...(snapshot.error?.effectAttempted !== undefined ? { effectAttempted: snapshot.error.effectAttempted } : {}),
      ...(snapshot.error?.failureCause ? { failureCause: snapshot.error.failureCause } : {}),
      ...(snapshot.error?.details ? { details: snapshot.error.details } : backupFailure ? { details: backupFailure } : {}),
      ...metadata,
    };
  }
  if (snapshot.state === 'cancelled') {
    const details = projectDeploymentBackupFailureResultV1(snapshot.actionId, 'cancelled', snapshot.result);
    return { ok: false, errorCode: 'cancelled', error: 'cancelled', ...(details ? { details } : {}), ...metadata };
  }
  return null;
}

/** The closed ../0.2 reader at 37a6541578749067b49d4579be8c752c9591b8c8
 * predates current domain and review facts. Project only the V1 outward seam;
 * current readers use V2 and the store retains the complete owner observation.
 * Remove this projection when that supported predecessor reader is retired. */
export function projectActionOperationSnapshotForV1Reader(snapshot: ActionOperationSnapshotV1): ActionOperationSnapshotV1 {
  const { domainRef, setupReview: _review, observation: _observation, operationCredentialUses: _credentialUses,
    error, progress, result, ...projection } = snapshot;
  const legacyDomainRef = domainRef?.kind === 'forkRequest' || domainRef?.kind === 'spawnAttempt'
    || domainRef?.kind === 'handoff' ? domainRef : undefined;
  const legacyProgress = progress?.kind === 'phase'
    ? { kind: progress.kind, phase: progress.phase, label: progress.label }
    : progress;
  return {
    ...projection,
    // Keep newer typed refusals on the full owner read, outside the released V1 shape.
    ...(result !== undefined && !(snapshot.state === 'failed' && (snapshot.actionId === 'session.spawn_new'
      || parseQualifiedPluginContributionKey(snapshot.actionId)))
      && !((snapshot.state === 'failed' || snapshot.state === 'cancelled') && snapshot.actionId === 'machines.agentIsolation.set')
      ? { result } : {}),
    ...(legacyProgress ? { progress: legacyProgress } : {}),
    ...(legacyDomainRef ? { domainRef: legacyDomainRef } : {}),
    ...(error && snapshot.state === 'failed' ? { error: { errorCode: error.errorCode, error: error.error } } : {}),
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

export const ActionOperationListV2RequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(ActionOperationListV1RequestSchema, {
  /** Narrow the authorized requester's retained operations. */
  actorAccountId: z.optional(ActionOperationIdentifierV1Schema),
  /** Inclusive lower bound on operation creation time. */
  createdAtFromMs: z.optional(ActionOperationTimestampV1Schema),
  /** Exclusive upper bound on operation creation time. */
  createdAtToMs: z.optional(ActionOperationTimestampV1Schema),
  /** Select the newest retained host receipt, without durable-domain discovery. */
  requestIdentity: z.optional(z.strictObject({
    actionId: ActionOperationIdentifierV1Schema,
    requestId: ActionOperationIdentifierV1Schema,
  })),
})));
export type ActionOperationListV2Request = z.infer<typeof ActionOperationListV2RequestSchema>;

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
  /** Join the existing installer owner until its nonsecret question or settlement. */
  includeManagedPrompt: z.optional(z.literal(true)),
})).check(z.refine(request => !request.includeManagedPrompt || request.waitForTerminal === true, {
  path: ['includeManagedPrompt'], message: 'Managed prompt observation requires the existing wait owner.',
})));
export type ActionOperationGetV2Request = z.infer<typeof ActionOperationGetV2RequestSchema>;

const ActionOperationNotFoundV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('not_found') }));

export const ActionOperationGetV1ResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('found'), operation: ActionOperationSnapshotV1Schema }),
  ActionOperationNotFoundV1Schema,
]));
export type ActionOperationGetV1Response = z.infer<typeof ActionOperationGetV1ResponseSchema>;
export const ActionOperationGetV1ResponseProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(ActionOperationGetV1ResponseSchema));

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
  if (['succeeded', 'failed', 'cancelled'].includes(current.state) && incoming.state !== current.state
    && !(canResumeDeploymentTeardownOperationV1(current) && incoming.state !== 'accepted')) return false;
  return !(current.state === 'running' && incoming.state === 'accepted');
}

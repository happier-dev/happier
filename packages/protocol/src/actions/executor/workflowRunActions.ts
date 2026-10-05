import { deriveWorkflowReplacementId } from '../../workflows/workflowInvocationIdentityV1.js';

import {
  WorkflowAcceptedSnapshotV1Schema,
  WorkflowAuthoredInputV1Schema,
  WorkflowActionOutputSchemasV1,
  WorkflowCheckpointEnvelopeV1Schema,
  WorkflowProgressEnvelopeV1Schema,
  WorkflowRunInvocationIndexV1Schema,
  WorkflowRunSummaryV1Schema,
  WorkflowRunWaitSnapshotV1Schema,
  WorkflowRunListResultV1Schema,
  WorkflowRunAcceptedContextV1Schema,
  materializeWorkflowAcceptedSnapshotV1,
  readWorkflowAcceptedAgentStartLeavesV1,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  openWorkflowCheckpointStoredEnvelopeV1,
  openWorkflowFinalResultStoredEnvelopeV1,
  openWorkflowProgressStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  validateWorkflowDefinition,
  matchesWorkflowAcceptedDefinitionV1,
  type WorkflowActionIdV1,
  type WorkflowAuthoredInputV1,
  type WorkflowDefinitionV1,
  type WorkflowDefinitionSavedByV1,
  type WorkflowRunPrivateMetadataV1,
  type WorkflowProgressEnvelopeV1,
  type WorkflowWorkspaceProgressV1,
  type WorkflowUsageV1,
  type WorkflowIngressContextV1,
  type WorkflowInvocationRecoveryAvailabilityV1,
  type WorkflowRunInvocationIndexV1,
  type WorkflowRunSummaryV1,
  type WorkflowRunAcceptedContextV1,
  formatWorkflowDefinitionRefV1,
  resolveWorkflowDefinitionRefV1,
  WorkflowRunRecipientCensusResponseV1Schema,
  WorkflowRunRecipientKeyEnvelopeCommitResponseV1Schema,
  prepareWorkflowRunDataKeyV1,
  resolveWorkflowRunDataKeyV1,
  runWorkflowRecipientKeyPreparationV1,
  type WorkflowRunEncryptionV1,
  type WorkflowRunRecipientCensusResponseV1,
  resolveWorkflowInvocationStructureV1,
  resolveWorkflowRetainedConversationAttemptV1,
  classifyWorkflowHoldV1,
  isWorkflowDraftPublicationLifecycleV1,
} from '../../workflows/index.js';
import { decodeExecutionRunResultObservation, type ExecutionRunProfileResultContract } from '../../execution/runs/resultContract.js';
import { PluginJsonSchemaV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { ActionCompletionContractV1Schema } from '../actionCompletion.js';
import { AgentPermissionIntentV1Schema } from '../../runtime/permissionIntentV1.js';
import { SessionInputCausalPermissionAuthorityV1Schema } from '../../sessions/messages/sessionInputAdmission.js';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '../externalActionLimits.js';
import { assertNonEscalatingPermissionMode, resolveEffectivePermissionMode } from '../permissionPrivilege.js';
import { StrictJsonValueSchema, sameStrictJsonValue } from '../../json/strictJsonValue.js';
import {
  type AvailableAutomationAccountEncryptionV1,
} from '../../automations/automationAccountCurrentnessV1.js';
import type { ActionExecutorDeps, WorkflowActionExecuteArgs } from './types.js';
import type { WorkflowRunActionOwner } from './workflowAccountActions.js';
import { admitActionAgentStartV1, resolveActionAgentStartContextV1 } from './agentStartAdmission.js';
import type { WorkflowPluginSourceReaderV1 } from '../../workflows/workflowPluginSourceV1.js';
import { resolveInputTypeOptions, validateInputTypeValue } from '../../inputs/inputTypeRuntime.js';
import type { InputOption } from '../../inputs/inputFields.js';
import { ActionExecuteFailureSchema } from '../actionExecutionResult.js';

export type WorkflowAccountRunEncryption = AvailableAutomationAccountEncryptionV1;

type RunActionId = Extract<WorkflowActionIdV1, `workflow.run.${string}`>;
type RunArgs = { [TActionId in RunActionId]: WorkflowActionExecuteArgs<TActionId> }[RunActionId];
type WorkflowMachineTarget = Extract<NonNullable<RunArgs['context']['externalActionTarget']>, { kind: 'machine' }>;
type WorkflowAcceptedAuthorizationCurrentness = (input: Readonly<{
  authorization: ReturnType<typeof WorkflowAcceptedSnapshotV1Schema.parse>['authorization'];
  signal?: AbortSignal;
}>) => boolean | Promise<boolean>;

const EXACT_RECOVERY_ACTIVE_LIFECYCLES = new Set([
  'admitting', 'running', 'waiting_for_approval', 'needs_attention', 'cancel_requested', 'outcome_uncertain',
]);
const EXACT_RECOVERY_RETRY_LIFECYCLES = new Set(['failed', 'cancelled']);
const EXACT_RECOVERY_WORKSPACE_FAILURES = new Set([
  'conversation_workspace_mismatch', 'source_workspace_unavailable', 'committed_revision_unavailable',
  'workspace_unavailable', 'workspace_conflict', 'scm_unavailable',
]);

/** Native observation only: a stopped acknowledgement is not proof of inactivity. */
export type WorkflowInvocationRecoveryEvidence = Readonly<{
  activity: 'active' | 'not_active' | 'unknown';
  canReattach: boolean;
  canContinueConversation: boolean;
}>;
export type WorkflowInvocationRecoveryObservationInput = Readonly<{
  run: WorkflowRunSummaryV1;
  index: WorkflowRunInvocationIndexV1;
  progress: WorkflowProgressEnvelopeV1;
  signal?: AbortSignal;
}>;

function isStructuralRecoveryFrame(kind: WorkflowProgressEnvelopeV1['blockKind']): boolean {
  switch (kind) {
    case 'root':
    case 'parallel':
    case 'loop':
    case 'if':
    case 'workflow': return true;
    case 'step':
    case 'action':
    case 'wait': return false;
  }
  // A new executable leaf must supply its own observation contract, not
  // inherit the absence of agent activity on the existing structural frames.
  const exhaustive: never = kind;
  return exhaustive;
}

function deriveExactInvocationRecoveryAvailability(params: Readonly<{
  run: WorkflowRunSummaryV1;
  index: WorkflowRunInvocationIndexV1;
  progress: WorkflowProgressEnvelopeV1;
  evidence: WorkflowInvocationRecoveryEvidence;
  current?: boolean;
  retryCausalSet?: WorkflowInvocationRecoveryAvailabilityV1['retry'];
  restoreWorkspaces?: readonly WorkflowWorkspaceProgressV1[];
}>): WorkflowInvocationRecoveryAvailabilityV1 {
  const unavailable = (reason: Exclude<WorkflowInvocationRecoveryAvailabilityV1['retry'], { kind: 'available' }>['reason']) =>
    ({ kind: 'unavailable' as const, reason });
  const available = { kind: 'available' as const };
  if (params.run.state !== 'interrupted') {
    const state = unavailable('run_not_interrupted');
    return { reattach: state, retry: state, continueSameConversation: state, continueFreshAgent: state, restoreWorkspace: state };
  }
  if (params.current === false) {
    const state = unavailable('invocation_not_recoverable');
    return { reattach: state, retry: state, continueSameConversation: state, continueFreshAgent: state, restoreWorkspace: state };
  }
  const workspaceUnavailable = EXACT_RECOVERY_WORKSPACE_FAILURES.has(params.progress.reason?.code ?? '');
  const stopPending = params.index.lifecycle === 'cancel_requested';
  const reattach = workspaceUnavailable
    ? unavailable('workspace_unavailable')
    : params.progress.execution === undefined
      ? unavailable('execution_not_admitted')
      : EXACT_RECOVERY_ACTIVE_LIFECYCLES.has(params.index.lifecycle) && params.evidence.canReattach
        ? available
        : unavailable(stopPending ? 'stop_pending' : 'invocation_not_recoverable');
  const retryable = (EXACT_RECOVERY_RETRY_LIFECYCLES.has(params.index.lifecycle)
    || (params.index.lifecycle === 'needs_attention'
      && (isStructuralRecoveryFrame(params.progress.blockKind) || params.progress.uncertainPriorEffects?.activity === 'stopped')))
    && params.evidence.activity === 'not_active';
  const retry = workspaceUnavailable
    ? unavailable('workspace_unavailable')
    : retryable
      ? params.retryCausalSet ?? { kind: 'available' as const, causalInvocationIds: [params.index.id] }
      : unavailable(stopPending ? 'stop_pending' : 'invocation_not_recoverable');
  const continuationUnavailable = workspaceUnavailable
    ? unavailable('workspace_unavailable')
    : stopPending
      ? unavailable('stop_pending')
      : unavailable('recovery_not_prepared');
  const recordedWorkspaces = params.restoreWorkspaces ?? [];
  const restorable = params.progress.reason?.code === 'workspace_unavailable'
    && recordedWorkspaces.length > 0
    && recordedWorkspaces.every(workspace => workspace.creationIntent !== undefined
      && workspace.descriptor?.machineId === params.run.machineId
      && workspace.descriptor.checkout?.kind === 'git_worktree');
  return {
    reattach,
    retry,
    continueSameConversation: params.progress.blockKind === 'step' && retry.kind === 'available' && params.evidence.canContinueConversation ? available : continuationUnavailable,
    continueFreshAgent: params.progress.blockKind === 'step' && retry.kind === 'available' ? available : continuationUnavailable,
    restoreWorkspace: restorable
      ? retryable && !stopPending ? available : unavailable(stopPending ? 'stop_pending' : 'invocation_not_recoverable')
      : unavailable('workspace_unavailable'),
  };
}

function workflowProjectTarget(context: RunArgs['context']): WorkflowMachineTarget['project'] {
  return context.externalActionTarget?.kind === 'machine'
    ? context.externalActionTarget.project
    : undefined;
}

function normalizeProjectTargetForComparison(target: NonNullable<WorkflowMachineTarget['project']>, normalizeAbsolutePath: WorkflowAccountRunActionDeps['normalizeAbsolutePath']) {
  const resolved = normalizeAbsolutePath(target.directory);
  if (!resolved) return null;
  return {
    machineId: target.machineId,
    directory: resolved,
    ...(target.workspaceRefId ? { workspaceRefId: target.workspaceRefId } : {}),
  };
}

type Storage = Readonly<{
  /** Existing Account feed, including a current-facts invalidation on reconnect. */
  observeChanges?: (runId: string, onChange: () => void, onError: (error: unknown) => void) => Readonly<{ dispose(): void | Promise<void> }>;
  execute: (operation: Readonly<Record<string, unknown>>, options?: Readonly<{
    signal?: AbortSignal;
    /** Exact daemon machine that is authorized to publish this operation. */
    publisherMachineId?: string;
  }>) => Promise<unknown>;
}>;

type WorkflowCheckpoint = ReturnType<typeof WorkflowCheckpointEnvelopeV1Schema.parse>;

type DefinitionReader = Readonly<{
  get: (input: Readonly<{ definitionId: string; signal?: AbortSignal }>) => Promise<Readonly<{
    definitionId: string;
    revision: Readonly<{ headerVersion: number; bodyVersion: number }>;
    definition: WorkflowDefinitionV1;
    metadata: ReturnType<typeof WorkflowRunAcceptedContextV1Schema.parse>['metadata'];
    savedBy?: WorkflowDefinitionSavedByV1;
  }>>;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw workflowError('content_unavailable');
  return value as Readonly<Record<string, unknown>>;
}

function workflowError(code: string, details?: unknown): Error & { code: string; details?: unknown } {
  return Object.assign(new Error(code), { code, ...(details === undefined ? {} : { details }) });
}

function resolvePreparedOriginalInput(progress: WorkflowProgressEnvelopeV1): WorkflowAuthoredInputV1 {
  const prepared = WorkflowAuthoredInputV1Schema.safeParse(progress.input);
  if (prepared.success) return prepared.data;
  throw workflowError('content_unavailable');
}

function normalizeRecoveryInput(
  progress: WorkflowProgressEnvelopeV1,
  input: { kind: 'original' } | { kind: 'replacement'; value: WorkflowAuthoredInputV1 },
): { kind: 'replacement'; value: WorkflowAuthoredInputV1 } {
  return {
    kind: 'replacement',
    value: input.kind === 'original'
      ? resolvePreparedOriginalInput(progress)
      : input.value,
  };
}

function resetRecoveredContainer(
  container: WorkflowProgressEnvelopeV1['container'],
): WorkflowProgressEnvelopeV1['container'] {
  if (!container) return undefined;
  if (container.kind === 'body') return { ...container, nextBlockOrdinal: '0' };
  if (container.kind === 'parallel') return { ...container, nextBranchOrdinal: '0' };
  if (container.kind === 'if') return { ...container, nextBlockOrdinal: '0' };
  const { closing: _closing, ...loop } = container;
  return { ...loop, nextMemberIndex: '0', nextBodyBlockOrdinal: '0' };
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && ((error as { response?: { status?: unknown } }).response?.status === 404
      || (error as { code?: unknown }).code === 'run_not_found'));
}

function isIndeterminateWrite(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && !(error as { response?: unknown }).response
    && (error as { code?: unknown }).code !== 'ERR_CANCELED');
}

function openMode(encryption: WorkflowRunEncryptionV1) {
  return encryption.runCrypto;
}

function sealMode(encryption: WorkflowRunEncryptionV1, randomBytes: (length: number) => Uint8Array) {
  return encryption.runCrypto.mode === 'e2ee'
    ? { ...encryption.runCrypto, randomBytes }
    : encryption.runCrypto;
}

function resolveInputs(definition: WorkflowDefinitionV1, supplied: Readonly<WorkflowRunAcceptedContextV1['inputs']> | undefined) {
  const inputs: WorkflowRunAcceptedContextV1['inputs'] = {};
  const known = new Set(definition.inputs.map((input) => input.name));
  for (const key of Object.keys(supplied ?? {})) {
    if (!known.has(key)) throw workflowError('invalid_input');
  }
  for (const input of definition.inputs) {
    const value = supplied && Object.prototype.hasOwnProperty.call(supplied, input.name)
      ? supplied[input.name]
      : input.default;
    if (value === undefined) {
      if (input.required) throw workflowError('missing_reference');
      continue;
    }
    if ((input.valueType === 'string' && typeof value !== 'string')
      || (input.valueType === 'number' && typeof value !== 'number')
      || (input.valueType === 'boolean' && typeof value !== 'boolean')) throw workflowError('invalid_input');
    inputs[input.name] = value;
  }
  return inputs;
}

function parseSnapshot(value: unknown) {
  const parsed = record(value);
  return {
    run: WorkflowRunSummaryV1Schema.parse(parsed.run),
    acceptedEnvelope: typeof parsed.acceptedEnvelope === 'string' ? parsed.acceptedEnvelope : (() => { throw workflowError('content_unavailable'); })(),
    checkpointEnvelope: parsed.checkpointEnvelope === null || typeof parsed.checkpointEnvelope === 'string' ? parsed.checkpointEnvelope : (() => { throw workflowError('content_unavailable'); })(),
    resultEnvelope: parsed.resultEnvelope === null || typeof parsed.resultEnvelope === 'string' ? parsed.resultEnvelope : (() => { throw workflowError('content_unavailable'); })(),
    keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse(parsed.keyCensus),
  };
}

function principal(args: RunArgs) {
  if (args.context.actionCaller?.kind === 'workflowRun') return args.context.actionCaller.authorization.principal;
  if (args.context.actionCaller?.kind === 'session') {
    return { kind: 'session' as const, sessionId: args.context.actionCaller.sessionId };
  }
  if (args.context.externalActionCredential) {
    // The live grant remains on the caller context; the accepted principal
    // stores identity only, as required by its canonical strict schema.
    const { accountId, principalId, credentialId } = args.context.externalActionCredential;
    return { kind: 'api' as const, accountId, principalId, credentialId };
  }
  if (args.context.actionCaller?.kind === 'plugin') {
    const sourceCustody = args.context.actionCaller.sourceCustody;
    if (!sourceCustody) throw workflowError('run_access_denied');
    return {
    kind: 'plugin' as const,
    pluginId: args.context.actionCaller.pluginId,
    ...(args.context.actionCaller.contributionLocalId ? { contributionLocalId: args.context.actionCaller.contributionLocalId } : {}),
    sourceCustody,
  };
  }
  return { kind: 'host' as const };
}

function currentControllerAuthorization(args: RunArgs) {
  const causalPresent = Object.prototype.hasOwnProperty.call(args.context, 'causalPermissionAuthority');
  const causal = causalPresent
    ? SessionInputCausalPermissionAuthorityV1Schema.safeParse(args.context.causalPermissionAuthority)
    : null;
  if (causal && !causal.success) throw workflowError('run_access_denied');
  const callerPermission = AgentPermissionIntentV1Schema.safeParse(args.context.callerPermissionMode);
  if (!callerPermission.success) throw workflowError('run_access_denied');
  const callerPermissionMode = callerPermission.data;
  const effective = causal?.success
    ? resolveEffectivePermissionMode({
        currentMode: callerPermissionMode,
        admittedPermissionCeiling: causal.data.admittedPermissionCeiling,
      })
    : { ok: true as const, effectiveMode: callerPermissionMode };
  if (!effective.ok) throw workflowError('run_access_denied');
  return {
    effectivePermissionMode: effective.effectiveMode,
    principal: principal(args),
    ...(args.context.actionCaller?.kind === 'workflowRun' && args.context.actionCaller.authorization.sourceAuthority
      ? { sourceAuthority: args.context.actionCaller.authorization.sourceAuthority } : {}),
    ...(causal?.success && causal.data.sourceAuthority ? {
      sourceAuthority: {
        mediatorPluginId: causal.data.sourceAuthority.mediatorPluginId,
        sourceRef: causal.data.sourceAuthority.sourceRef,
        sourceRevisionOrEpoch: causal.data.sourceAuthority.sourceRevisionOrEpoch,
        remoteApprovalMaxScope: causal.data.sourceAuthority.remoteApprovalMaxScope,
      },
    } : {}),
  };
}

function projectAcceptedContext(accepted: ReturnType<typeof WorkflowAcceptedSnapshotV1Schema.parse>) {
  const source = accepted.source;
  return WorkflowRunAcceptedContextV1Schema.parse('origin' in accepted
    ? {
        startedBy: accepted.startedBy,
        source,
        ...(accepted.metadata ? { metadata: accepted.metadata } : {}),
        inputs: accepted.inputs,
        machineId: accepted.machineId,
        executionTarget: accepted.executionTarget,
        workspaceTarget: accepted.workspaceTarget,
        ...(accepted.roleOverrides === undefined ? {} : { roleOverrides: accepted.roleOverrides }),
        materializedLeaves: accepted.materializedLeaves,
        frozenChildren: accepted.frozenChildren,
        origin: accepted.origin,
      }
    : {
        startedBy: accepted.startedBy,
        source,
        ...(accepted.metadata ? { metadata: accepted.metadata } : {}),
        inputs: accepted.inputs,
        machineId: accepted.machineId,
        executionTarget: accepted.executionTarget,
        workspaceTarget: accepted.workspaceTarget,
        ...(accepted.roleOverrides === undefined ? {} : { roleOverrides: accepted.roleOverrides }),
        materializedLeaves: accepted.materializedLeaves,
        frozenChildren: accepted.frozenChildren,
      });
}

function assertRunResourceRestriction(
  context: RunArgs['context'],
  resource: Readonly<{ machineId: string; project?: NonNullable<WorkflowMachineTarget['project']> }>,
  normalizeAbsolutePath: WorkflowAccountRunActionDeps['normalizeAbsolutePath'],
): void {
  const target = context.externalActionTarget;
  if (target === undefined) return;
  if (target.kind !== 'machine' || target.machineId !== resource.machineId) throw workflowError('target_unavailable');
  if (target.project) {
    const requestedProject = normalizeProjectTargetForComparison(target.project, normalizeAbsolutePath);
    const acceptedProject = resource.project && normalizeProjectTargetForComparison(resource.project, normalizeAbsolutePath);
    if (!requestedProject || !acceptedProject || !sameStrictJsonValue(requestedProject, acceptedProject)) {
      throw workflowError('target_unavailable');
    }
  }
}

export async function assertControllerDominates(
  args: RunArgs,
  accepted: ReturnType<typeof WorkflowAcceptedSnapshotV1Schema.parse>,
  ingressContext: WorkflowIngressContextV1 | undefined,
  isAcceptedAuthorizationCurrent: WorkflowAcceptedAuthorizationCurrentness | undefined,
  host: Pick<WorkflowAccountRunActionDeps, 'normalizeAbsolutePath' | 'resolveAgentStartContext'>,
): Promise<void> {
  // Recompute the complete live caller authority, including causal Session
  // admission. This is a control gate: a narrower caller is rejected rather
  // than silently clamping the Run's immutable admitted ceiling.
  const current = currentControllerAuthorization(args);
  if (!assertNonEscalatingPermissionMode({
    requestedMode: accepted.authorization.admittedPermissionCeiling,
    callerMode: current.effectivePermissionMode,
  }).ok) {
    throw workflowError('run_access_denied');
  }

  if (args.context.authority !== 'present_user') {
    if (JSON.stringify(current.principal) !== JSON.stringify(accepted.authorization.principal)) {
      throw workflowError('run_access_denied');
    }
    if (accepted.authorization.sourceAuthority
      && JSON.stringify('sourceAuthority' in current ? current.sourceAuthority : undefined)
        !== JSON.stringify(accepted.authorization.sourceAuthority)) {
      throw workflowError('run_access_denied');
    }
  }

  assertRunResourceRestriction(args.context, { machineId: accepted.machineId, project: accepted.workspaceTarget.project }, host.normalizeAbsolutePath);

  if (args.context.surface === 'agent') {
    const resolved = await resolveActionAgentStartContextV1(host, args.context);
    for (const leaf of await readWorkflowAcceptedAgentStartLeavesV1(accepted)) {
      const role = accepted.materializedLeaves.find((entry) => entry.sourceKey === leaf.sourceKey
        && entry.blockId === leaf.blockId && entry.role?.roleId === leaf.roleId)?.role;
      const authority = resolved && role ? { ...resolved, roles: { ...resolved.roles, [role.roleId]: role } } : resolved;
      const admitted = admitActionAgentStartV1(args.context, { kind: 'workflow_run_leaf', leaf }, authority);
      if (!admitted.ok) throw workflowError(admitted.error.errorCode ?? 'run_access_denied', admitted.error.details);
    }
  }

  await assertAcceptedAuthorizationCurrent(accepted.authorization, args.context.signal, isAcceptedAuthorizationCurrent);
}

async function assertAcceptedAuthorizationCurrent(
  authorization: ReturnType<typeof WorkflowAcceptedSnapshotV1Schema.parse>['authorization'],
  signal: AbortSignal | undefined,
  isAcceptedAuthorizationCurrent: WorkflowAcceptedAuthorizationCurrentness | undefined,
): Promise<void> {
  // Session attribution freezes the accepted principal and ceiling, not the
  // origin's lifetime. Independent Runs remain controllable after its deletion.
  const hasRevocableAuthority = (authorization.principal.kind !== 'host' && authorization.principal.kind !== 'session')
    || authorization.sourceAuthority !== undefined;
  if ((isAcceptedAuthorizationCurrent && !(await isAcceptedAuthorizationCurrent({ authorization, signal })))
    || (!isAcceptedAuthorizationCurrent && hasRevocableAuthority)) {
    throw workflowError('run_access_denied');
  }
}

function translateStorageError(error: unknown): never {
  const responseError = (error as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  if (typeof responseError === 'string' && responseError.length > 0) throw workflowError(responseError);
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && code.length > 0 && !code.startsWith('ERR_') && !code.startsWith('ECONN') && code !== 'AxiosError') {
    throw workflowError(code);
  }
  throw workflowError('content_unavailable');
}

export type WorkflowAccountRunActionDeps = Readonly<{
  resolveAccountId: (signal?: AbortSignal) => Promise<string>;
  storage: Storage;
  definitions: DefinitionReader;
  readPluginWorkflows?: WorkflowPluginSourceReaderV1;
  resolveEncryption: (signal?: AbortSignal) => Promise<AvailableAutomationAccountEncryptionV1>;
  normalizeAbsolutePath: (directory: string) => string | null;
  resolveAgentStartContext?: ActionExecutorDeps['resolveAgentStartContext'];
  inputTypeDeps?: Pick<ActionExecutorDeps, 'resolveInputType' | 'readInputTypeResource'>;
  resolveMaterializationContext?: (args: WorkflowActionExecuteArgs<'workflow.run.start'>, target: Readonly<{
    machineId: string;
    directory: string;
  }>) => Promise<Pick<Parameters<typeof materializeWorkflowAcceptedSnapshotV1>[0], 'roleSelection' | 'effects'>>;
  assertCurrent?: () => void;
  prepareWorkspace?: (input: Readonly<{ projectTarget: NonNullable<WorkflowMachineTarget['project']>; definition: WorkflowDefinitionV1 }>) => Promise<
    Readonly<{ ok: true; workspaceTarget: ReturnType<typeof WorkflowAcceptedSnapshotV1Schema.parse>['workspaceTarget'] }>
    | Readonly<{ ok: false; code: 'workspace_unavailable' | 'workspace_conflict' | 'committed_revision_unavailable' }>>;
  restoreWorkspace?: (workspace: NonNullable<WorkflowProgressEnvelopeV1['workspace']>) => Promise<
    Readonly<{ ok: true }> | Readonly<{ ok: false; code: 'workflow_workspace_restore_unavailable' | 'workflow_workspace_restore_failed' }>>;
  observeRecovery?: (input: WorkflowInvocationRecoveryObservationInput) => Promise<WorkflowInvocationRecoveryEvidence>;
  reattachInvocation?: (input: WorkflowInvocationRecoveryObservationInput) => Promise<void>;
  doesImmediateEligibleStepTargetSession?: (input: Readonly<{
    definition: WorkflowDefinitionV1;
    checkpoint: WorkflowCheckpoint | null;
    executionTarget: ReturnType<typeof WorkflowAcceptedSnapshotV1Schema.parse>['executionTarget'];
    materializedLeaves: ReturnType<typeof WorkflowAcceptedSnapshotV1Schema.parse>['materializedLeaves'];
    sessionId: string;
  }>) => boolean;
  isAcceptedAuthorizationCurrent?: WorkflowAcceptedAuthorizationCurrentness;
  randomBytes: (length: number) => Uint8Array;
}>;

/** One Account run owner; hosts supply concrete storage, authority and machine effects. */
export function createWorkflowAccountRunActionOwner(deps: WorkflowAccountRunActionDeps): WorkflowRunActionOwner {
  const storage = deps.storage;
  const prepareWorkspace = deps.prepareWorkspace;
  const restoreWorkspace = deps.restoreWorkspace;
  deps = {
    ...deps,
    storage: {
      ...storage,
      execute: async (operation, options) => {
        deps.assertCurrent?.();
        const result = await storage.execute(operation, options);
        deps.assertCurrent?.();
        return result;
      },
    },
    ...(prepareWorkspace ? { prepareWorkspace: async (input) => {
      deps.assertCurrent?.();
      const result = await prepareWorkspace(input);
      deps.assertCurrent?.();
      return result;
    } } : {}),
    ...(restoreWorkspace ? { restoreWorkspace: async (input) => {
      deps.assertCurrent?.();
      const result = await restoreWorkspace(input);
      deps.assertCurrent?.();
      return result;
    } } : {}),
  };
  const encryption = async (signal?: AbortSignal) => await deps.resolveEncryption(signal);
  const getSnapshot = async (runId: string, signal?: AbortSignal, publisherMachineId?: string) => {
    try {
      return parseSnapshot(await deps.storage.execute(
        { operation: 'get', runId },
        { ...(signal ? { signal } : {}), ...(publisherMachineId ? { publisherMachineId } : {}) },
      ));
    } catch (error) {
      if (isNotFound(error)) throw workflowError('run_not_found');
      translateStorageError(error);
    }
  };
  const prepareRunRecipients = async (runId: string, enc: WorkflowRunEncryptionV1, census: WorkflowRunRecipientCensusResponseV1, signal?: AbortSignal) =>
    await runWorkflowRecipientKeyPreparationV1({ runId, runCrypto: enc.runCrypto,
      openedDataEncryptionKey: census.callerDataEncryptionKey, randomBytes: deps.randomBytes,
      readCensus: async () => WorkflowRunRecipientCensusResponseV1Schema.parse(await deps.storage.execute({ operation: 'run-key.census', runId }, signal ? { signal } : {})),
      commit: async input => WorkflowRunRecipientKeyEnvelopeCommitResponseV1Schema.parse(await deps.storage.execute({ operation: 'run-key.commit', ...input }, signal ? { signal } : {})),
      ...(signal ? { signal } : {}),
    });
  const openAccepted = async (runId: string, signal?: AbortSignal, publisherMachineId?: string) => {
    const snapshot = await getSnapshot(runId, signal, publisherMachineId);
    const accountId = snapshot.keyCensus.ownerAccountId;
    const resolved = resolveWorkflowRunDataKeyV1({ encryption: await encryption(signal), census: snapshot.keyCensus });
    if (resolved.kind !== 'available') throw workflowError('content_unavailable');
    const enc = resolved.encryption;
    await prepareRunRecipients(runId, enc, snapshot.keyCensus, signal);
    const envelope = parseWorkflowStoredContentEnvelopeV1(snapshot.acceptedEnvelope);
    if (!envelope) throw workflowError('content_unavailable');
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
      ...openMode(enc), binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, envelope,
    });
    if (opened.kind !== 'available') throw workflowError('content_unavailable');
    return { accountId, enc, snapshot, accepted: WorkflowAcceptedSnapshotV1Schema.parse(opened.content) };
  };

  const assertWaitDoesNotOccupyTargetConversation = async (args: WorkflowActionExecuteArgs<'workflow.run.wait'>): Promise<number | undefined> => {
    const sessionId = args.context.defaultSessionId ?? undefined;
    if (!sessionId || (args.context.surface !== 'agent' && args.context.surface !== 'mcp')) return undefined;
    const { enc, accountId } = await openAccepted(args.input.runId, args.context.signal);
    let cursor: string | undefined;
    do {
      const page = record(await deps.storage.execute({
        operation: 'invocations.list', runId: args.input.runId,
        lifecycles: ['pending', 'waiting_for_capacity', 'admitting', 'running', 'waiting_for_approval', 'needs_attention', 'cancel_requested'],
        ...(cursor ? { cursor } : {}),
        pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
      }, args.context.signal ? { signal: args.context.signal } : {}));
      for (const raw of Array.isArray(page.invocations) ? page.invocations : []) {
        const index = WorkflowRunInvocationIndexV1Schema.parse(raw);
        const detail = record(await deps.storage.execute({
          operation: 'invocations.get', runId: args.input.runId, invocationId: index.id,
        }, args.context.signal ? { signal: args.context.signal } : {}));
        const invocation = record(detail.invocation);
        if (typeof invocation.contentEnvelope !== 'string') throw workflowError('content_unavailable');
        const envelope = parseWorkflowStoredContentEnvelopeV1(invocation.contentEnvelope);
        const opened = envelope && openWorkflowProgressStoredEnvelopeV1({
          ...openMode(enc), envelope,
          binding: {
            v: 1, purpose: 'invocation_progress', accountId, runId: args.input.runId,
            recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
            memberOrdinal: index.memberOrdinal, attempt: index.attempt,
          },
        });
        if (!opened || opened.kind !== 'available') throw workflowError('content_unavailable');
        const execution = WorkflowProgressEnvelopeV1Schema.parse(opened.content).execution;
        if (execution?.kind === 'session' && execution.sessionId === sessionId) {
          throw workflowError('workflow_wait_self_dependency', { runId: args.input.runId });
        }
      }
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
    } while (cursor);
    if (deps.doesImmediateEligibleStepTargetSession) {
      const opened = await openAccepted(args.input.runId, args.context.signal);
      const checkpoint = await openSnapshotCheckpoint({
        runId: args.input.runId,
        checkpointEnvelope: opened.snapshot.checkpointEnvelope,
        accountId: opened.accountId,
        enc: opened.enc,
        ...(args.context.signal ? { signal: args.context.signal } : {}),
      });
      if (deps.doesImmediateEligibleStepTargetSession({
        definition: opened.accepted.definition,
        checkpoint,
        executionTarget: opened.accepted.executionTarget,
        materializedLeaves: opened.accepted.materializedLeaves,
        sessionId,
      })) {
        throw workflowError('workflow_wait_self_dependency', { runId: args.input.runId });
      }
      return opened.snapshot.run.revision;
    }
    return undefined;
  };

  const start = async (args: WorkflowActionExecuteArgs<'workflow.run.start'>, ingressContext?: WorkflowIngressContextV1) => {
    const input = args.input;
    const replayRequest = input.source.kind === 'inline' ? input.source.replay : undefined;
    if (replayRequest?.runId === input.runId) throw workflowError('invalid_input');
    const replaySource = replayRequest ? await openAccepted(replayRequest.runId, args.context.signal) : undefined;
    if (replaySource) {
      assertRunResourceRestriction(args.context, { machineId: replaySource.accepted.machineId,
        project: replaySource.accepted.workspaceTarget.project }, deps.normalizeAbsolutePath);
      if ((input.roleOverrides !== undefined && !sameStrictJsonValue(input.roleOverrides, replaySource.accepted.roleOverrides ?? []))
        || (input.executionTarget !== undefined && !sameStrictJsonValue(input.executionTarget, replaySource.accepted.executionTarget))
        || (input.metadata !== undefined && !sameStrictJsonValue(input.metadata, replaySource.accepted.metadata))) throw workflowError('invalid_input');
    }
    const originSessionId = replaySource ? replaySource.accepted.origin?.originSessionId : args.context.defaultSessionId ?? undefined;
    if (replaySource && args.context.defaultSessionId && args.context.defaultSessionId !== originSessionId) throw workflowError('invalid_input');
    const resultDelivery = input.onComplete ?? (replaySource?.accepted.resultDelivery ? { kind: 'originating_session' as const } : undefined) ?? (args.context.surface === 'agent'
      && args.context.authority !== 'present_user' && originSessionId
      ? { kind: 'originating_session' as const }
      : undefined);
    if (resultDelivery && !originSessionId) throw workflowError('invalid_input');
    const inputSource = input.source;
    if (inputSource.kind === 'catalog' && !deps.resolveMaterializationContext) throw workflowError('source_unavailable');
    const executionTarget = replaySource?.accepted.executionTarget ?? input.executionTarget ?? { kind: 'session' as const };
    const checkedInline = input.source.kind === 'inline' && !replaySource
      ? validateWorkflowDefinition(
          input.source.definition,
          ingressContext ? { context: ingressContext } : {},
        )
      : undefined;
    const normalizedInline = checkedInline?.normalizedDefinition;
    if (input.source.kind === 'inline' && !replaySource && (!checkedInline?.valid || !normalizedInline)) {
      throw workflowError('invalid_input');
    }
    let replayAccepted: ReturnType<typeof WorkflowAcceptedSnapshotV1Schema.parse> | undefined;
    const projectExisting = async () => {
      const existing = await openAccepted(
        input.runId,
        args.context.signal,
        workflowProjectTarget(args.context)?.machineId,
      );
      const sameSource = replaySource
        ? replayAccepted !== undefined
          && sameStrictJsonValue(existing.accepted.source, replayAccepted.source)
          && sameStrictJsonValue(existing.accepted.authoredDefinition, replayAccepted.authoredDefinition)
          && sameStrictJsonValue(existing.accepted.definition, replayAccepted.definition)
          && sameStrictJsonValue(existing.accepted.frozenChildren, replayAccepted.frozenChildren)
          && sameStrictJsonValue(existing.accepted.materializedLeaves, replayAccepted.materializedLeaves)
          && sameStrictJsonValue(existing.accepted.workspaceTarget, replayAccepted.workspaceTarget)
        : inputSource.kind === 'inline'
        ? existing.accepted.source.kind === 'inline'
          && normalizedInline !== undefined
          && matchesWorkflowAcceptedDefinitionV1(existing.accepted.authoredDefinition, normalizedInline)
        : inputSource.kind === 'catalog'
          ? existing.accepted.source.kind === 'catalog' && existing.accepted.source.ref === inputSource.workflow
          : existing.accepted.source.kind === 'saved'
          && existing.accepted.source.definitionId === inputSource.definitionId
          && sameStrictJsonValue(existing.accepted.source.revision, inputSource.revision);
      const expectedMetadata = input.source.kind === 'inline' ? input.metadata : undefined;
      const expectedTarget = workflowProjectTarget(args.context);
      const normalizedExpectedTarget = expectedTarget
        ? normalizeProjectTargetForComparison(expectedTarget, deps.normalizeAbsolutePath)
        : null;
      const acceptedProjectTarget = {
        machineId: existing.accepted.machineId,
        directory: existing.accepted.workspaceTarget.project.directory,
        ...(existing.accepted.workspaceTarget.project.workspaceRefId
          ? { workspaceRefId: existing.accepted.workspaceTarget.project.workspaceRefId }
          : {}),
      };
      if (!sameSource
        || (inputSource.kind === 'saved' && inputSource.visibleTeamId !== undefined
          && inputSource.visibleTeamId !== existing.snapshot.keyCensus.visibleTeamId)
        || !sameStrictJsonValue(existing.accepted.roleOverrides ?? [], replaySource?.accepted.roleOverrides ?? input.roleOverrides ?? [])
        || (expectedMetadata !== undefined && !sameStrictJsonValue(existing.accepted.metadata, expectedMetadata))
        || !sameStrictJsonValue(existing.accepted.inputs, resolveInputs(existing.accepted.definition, input.inputs))
        || existing.accepted.executionTarget.kind !== executionTarget.kind
        || !('origin' in existing.accepted)
        || existing.accepted.origin === undefined
        || (args.context.defaultSessionId !== undefined && args.context.defaultSessionId !== null
          && existing.accepted.origin.originSessionId !== args.context.defaultSessionId)
        || Boolean('resultDelivery' in existing.accepted && existing.accepted.resultDelivery) !== Boolean(resultDelivery)
        || !normalizedExpectedTarget
        || !sameStrictJsonValue(acceptedProjectTarget, normalizedExpectedTarget)) {
        throw workflowError('currentness_conflict');
      }
      await assertAcceptedAuthorizationCurrent(existing.accepted.authorization, args.context.signal, deps.isAcceptedAuthorizationCurrent);
      return WorkflowActionOutputSchemasV1['workflow.run.start'].parse({ run: existing.snapshot.run, admission: 'existing' });
    };
    if (!replaySource) {
      try {
        return await projectExisting();
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    let definition: WorkflowDefinitionV1;
    let metadata = replaySource ? replaySource.accepted.metadata ?? undefined : input.metadata;
    let source: Parameters<typeof materializeWorkflowAcceptedSnapshotV1>[0]['context']['source'];
    const projectTarget = workflowProjectTarget(args.context);
    if (!projectTarget) throw workflowError('target_unavailable');
    let materialization: Awaited<ReturnType<NonNullable<WorkflowAccountRunActionDeps['resolveMaterializationContext']>>> | undefined;
    if (replaySource) {
      definition = replaySource.accepted.authoredDefinition;
      source = replaySource.accepted.source;
    } else if (inputSource.kind === 'inline') {
      definition = normalizedInline!;
      source = { kind: 'inline' };
    } else if (inputSource.kind === 'saved') {
      let saved: Awaited<ReturnType<DefinitionReader['get']>>;
      try {
        saved = await deps.definitions.get({ definitionId: inputSource.definitionId,
          ...(args.context.signal ? { signal: args.context.signal } : {}) });
        if (!sameStrictJsonValue(saved.revision, inputSource.revision)) throw workflowError('currentness_conflict');
      } catch (sourceError) {
        args.context.signal?.throwIfAborted();
        // An admission may commit between the initial missing read and mutable
        // Artifact resolution. Rejoin that immutable effect before surfacing a
        // source edit/deletion failure.
        try {
          return await projectExisting();
        } catch (rejoinError) {
          if (!isNotFound(rejoinError)) throw rejoinError;
          throw sourceError;
        }
      }
      const checkedSaved = validateWorkflowDefinition(
        saved.definition,
        ingressContext ? { context: ingressContext } : {},
      );
      if (!checkedSaved.valid || !checkedSaved.normalizedDefinition) throw workflowError('invalid_input');
      definition = checkedSaved.normalizedDefinition;
      metadata = saved.metadata;
      source = { kind: 'saved', definitionId: inputSource.definitionId, revision: inputSource.revision,
        savedBy: saved.savedBy ?? null };
    } else {
      if (!deps.resolveMaterializationContext) throw workflowError('source_unavailable');
      materialization = await deps.resolveMaterializationContext(args, projectTarget);
      const resolved = await resolveWorkflowDefinitionRefV1(inputSource.workflow, {
        readPluginWorkflows: deps.readPluginWorkflows,
        ...(args.context.signal ? { signal: args.context.signal } : {}),
      });
      if (!resolved || resolved.kind !== 'catalog') throw workflowError('source_unavailable');
      if (typeof resolved.version === 'string' && inputSource.pluginVersion !== undefined
        && inputSource.pluginVersion !== resolved.version) throw workflowError('currentness_conflict');
      const checked = validateWorkflowDefinition(resolved.definition, ingressContext ? { context: ingressContext } : {});
      if (!checked.valid || !checked.normalizedDefinition) throw workflowError('invalid_input', { issues: checked.issues });
      definition = checked.normalizedDefinition;
      metadata = resolved.metadata ?? metadata;
      source = { kind: 'catalog', ref: inputSource.workflow, version: resolved.version };
    }
    if (!materialization) {
      if (!deps.resolveMaterializationContext) throw workflowError('target_unavailable');
      materialization = await deps.resolveMaterializationContext(args, projectTarget);
    }
    const readArtifactDefinition = materialization.effects.readWorkflowDefinition;
    materialization = { ...materialization, effects: { ...materialization.effects,
      readWorkflowDefinition: (ref) => resolveWorkflowDefinitionRefV1(formatWorkflowDefinitionRefV1(ref), {
        readPluginWorkflows: deps.readPluginWorkflows,
        readArtifact: async (artifactId) => await readArtifactDefinition?.({ kind: 'artifact', artifactId }) ?? null,
        ...(args.context.signal ? { signal: args.context.signal } : {}),
      }),
    } };
    const resolvedInputs = resolveInputs(definition, input.inputs);
    for (const field of definition.inputs ?? []) {
      if (!field.inputType || resolvedInputs[field.name] === undefined) continue;
      const type = await deps.inputTypeDeps?.resolveInputType?.(field.inputType, args.context);
      if (!type || type.identity.pluginId !== field.inputType.pluginId || type.identity.localId !== field.inputType.localId) throw workflowError('input_type_unavailable');
      let options: readonly InputOption[] | undefined;
      if (type.definition.options) {
        const result = await resolveInputTypeOptions({ deps: deps.inputTypeDeps ?? {}, ctx: args.context, identity: field.inputType,
          ...(originSessionId ? { sessionId: originSessionId } : {}),
          readFailure: result => {
            const parsed = ActionExecuteFailureSchema.safeParse(result);
            return parsed.success ? parsed.data : null;
          },
        });
        if (!result.ok) throw workflowError(result.errorCode ?? 'input_type_options_unavailable');
        options = result.result;
      }
      const validation = validateInputTypeValue(type, resolvedInputs[field.name], options);
      if (validation.status !== 'valid') throw workflowError(validation.reasonCode);
      args.context.signal?.throwIfAborted();
      const current = await deps.inputTypeDeps?.resolveInputType?.(field.inputType, args.context);
      if (!current || current.occurrenceId !== type.occurrenceId) throw workflowError('input_type_retired');
    }
    if (!replaySource && !deps.prepareWorkspace) throw workflowError('target_unavailable');
    const preparedWorkspace = replaySource ? { ok: true as const, workspaceTarget: replaySource.accepted.workspaceTarget }
      : await deps.prepareWorkspace!({ projectTarget, definition });
    if (!preparedWorkspace.ok) throw workflowError('target_unavailable');
    const controller = currentControllerAuthorization(args);
    const resolvedAgentContext = args.context.surface === 'agent'
      ? await resolveActionAgentStartContextV1(deps, args.context) : null;
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
      definition, ...materialization,
      ...(ingressContext ? { ingressContext } : {}),
      roleOverrides: input.roleOverrides,
      ...(replaySource && replayRequest ? { replay: { snapshot: replaySource.accepted,
        ...(replayRequest.agentOverride ? { agentOverride: replayRequest.agentOverride } : {}) } } : {}),
      admission: args.context.surface === 'agent' ? { kind: 'agent',
      admitLeaf: async (leaf, facts) => {
        if (!assertNonEscalatingPermissionMode({ requestedMode: facts.permissionCeiling,
          callerMode: controller.effectivePermissionMode }).ok) throw workflowError('run_access_denied');
        const resolved = resolvedAgentContext && facts.role ? { ...resolvedAgentContext,
          roles: { ...resolvedAgentContext.roles, [facts.role.roleId]: facts.role } } : resolvedAgentContext;
        return admitActionAgentStartV1(args.context, { kind: 'workflow_run_leaf', leaf }, resolved);
      } } : { kind: 'user' },
      context: {
      actionCaller: args.context.actionCaller ?? { kind: 'host' },
      ...(metadata ? { metadata } : {}), source, inputs: resolvedInputs, machineId: projectTarget.machineId,
      executionTarget,
      workspaceTarget: preparedWorkspace.workspaceTarget,
      origin: { kind: 'direct', ...(originSessionId ? { originSessionId } : {}) },
      authorization: { principal: controller.principal,
        ...('sourceAuthority' in controller ? { sourceAuthority: controller.sourceAuthority } : {}) },
      ...(resultDelivery && originSessionId ? {
        resultDelivery: {
          kind: 'originating_session',
          originSessionId,
        },
      } : {}),
      },
    });
    if (!materialized.ok) throw workflowError(materialized.error.code, materialized.error);
    const accepted = materialized.snapshot;
    if (!('origin' in accepted)) throw workflowError('invalid_input');
    if (!assertNonEscalatingPermissionMode({ requestedMode: accepted.authorization.admittedPermissionCeiling,
      callerMode: controller.effectivePermissionMode }).ok) throw workflowError('run_access_denied');
    if (replaySource) {
      replayAccepted = accepted;
      try { return await projectExisting(); }
      catch (error) { if (!isNotFound(error)) throw error; }
    }
    const enc = await encryption(args.context.signal);
    const accountId = await deps.resolveAccountId(args.context.signal);
    const sourceArtifactId = accepted.source.kind === 'saved' || accepted.source.kind === 'automation'
      ? accepted.source.definitionId ?? null : null;
    const visibleTeamId = replaySource ? replaySource.snapshot.keyCensus.visibleTeamId ?? undefined
      : input.source.kind === 'saved' ? input.source.visibleTeamId : undefined;
    const census = enc.witness.mode === 'e2ee'
      ? WorkflowRunRecipientCensusResponseV1Schema.parse(await deps.storage.execute({ operation: 'run-key.census', runId: input.runId, sourceArtifactId, ...(visibleTeamId ? { visibleTeamId } : {}) }, args.context.signal ? { signal: args.context.signal } : {}))
      : undefined;
    const prepared = prepareWorkflowRunDataKeyV1({ accountId, encryption: enc, ...(census ? { census } : {}), randomBytes: deps.randomBytes });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      ...sealMode({ witness: enc.witness, runCrypto: prepared.runCrypto }, deps.randomBytes),
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: input.runId }, acceptedSnapshot: accepted,
    }));
    let result: Readonly<Record<string, unknown>>;
    try {
      result = record(await deps.storage.execute({
        operation: 'admit', runId: input.runId, origin: accepted.origin, machineId: projectTarget.machineId,
        accountCurrentness: enc.witness, acceptedEnvelope,
        sourceArtifactId,
        recipientKeyEnvelopes: prepared.recipientKeyEnvelopes,
        ...(census ? { visibleTeamId: census.visibleTeamId } : visibleTeamId ? { visibleTeamId } : {}),
        ...(resultDelivery ? { resultDelivery } : {}),
      }, {
        ...(args.context.signal ? { signal: args.context.signal } : {}),
        publisherMachineId: projectTarget.machineId,
      }));
    } catch (error) {
      const responseCode = (error as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
      const errorCode = (error as { code?: unknown })?.code;
      if (responseCode === 'currentness_conflict' || errorCode === 'currentness_conflict') {
        // Another admission may have won the caller-allocated Run id race. The
        // accepted E2EE envelope is randomized, so only the Action host can
        // reopen the committed snapshot and compare semantic correspondence.
        return await projectExisting();
      }
      translateStorageError(error);
    }
    return WorkflowActionOutputSchemasV1['workflow.run.start'].parse({ run: result.run, admission: result.kind });
  };

  /** Opens one row's private progress under its exact row binding. */
  const openProgress = (
    runId: string,
    index: WorkflowRunInvocationIndexV1,
    rawEnvelope: unknown,
    resolvedEncryption: Readonly<{ accountId: string; enc: WorkflowRunEncryptionV1 }>,
  ) => {
    const envelope = typeof rawEnvelope === 'string' ? parseWorkflowStoredContentEnvelopeV1(rawEnvelope) : null;
    const opened = envelope && openWorkflowProgressStoredEnvelopeV1({
      ...openMode(resolvedEncryption.enc),
      envelope,
      binding: {
        v: 1, purpose: 'invocation_progress', accountId: resolvedEncryption.accountId, runId,
        recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
        memberOrdinal: index.memberOrdinal, attempt: index.attempt,
      },
    });
    if (!opened || opened.kind !== 'available') throw workflowError('content_unavailable');
    return WorkflowProgressEnvelopeV1Schema.parse(opened.content);
  };

  const readPriorProgress = async (
    runId: string,
    invocationId: string,
    resolvedEncryption: Readonly<{
      accountId: string;
      enc: WorkflowRunEncryptionV1;
    }>,
    signal?: AbortSignal,
  ) => {
    const { accountId, enc } = resolvedEncryption;
    let detail: unknown;
    try {
      detail = await deps.storage.execute({ operation: 'invocations.get', runId, invocationId }, signal ? { signal } : {});
    } catch (error) {
      translateStorageError(error);
    }
    const body = record(detail);
    const invocation = record(body.invocation);
    const index = WorkflowRunInvocationIndexV1Schema.parse(invocation.index);
    const parentRevision = invocation.parentRevision;
    if (!Number.isSafeInteger(parentRevision) || Number(parentRevision) < 0) {
      throw workflowError('content_unavailable');
    }
    return {
      accountId,
      enc,
      index,
      parentRevision: Number(parentRevision),
      progress: openProgress(runId, index, invocation.contentEnvelope, resolvedEncryption),
    };
  };

  const readInvocationGraph = async (
    runId: string,
    resolvedEncryption: Readonly<{ accountId: string; enc: WorkflowRunEncryptionV1 }>,
    signal?: AbortSignal,
    seed?: Awaited<ReturnType<typeof readPriorProgress>>,
  ) => {
    const graph = new Map<string, Awaited<ReturnType<typeof readPriorProgress>>>();
    if (seed) graph.set(seed.index.id, seed);
    let cursor: string | undefined;
    do {
      const page = record(await deps.storage.execute({
        operation: 'invocations.list',
        runId,
        pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
        ...(cursor ? { cursor } : {}),
      }, signal ? { signal } : {}));
      if (!Array.isArray(page.invocations)) throw workflowError('content_unavailable');
      for (const raw of page.invocations) {
        const index = WorkflowRunInvocationIndexV1Schema.parse(raw);
        const exact = graph.get(index.id) ?? await readPriorProgress(runId, index.id, resolvedEncryption, signal);
        if (exact.index.lifecycle !== index.lifecycle) throw workflowError('currentness_conflict');
        graph.set(index.id, exact);
      }
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
    } while (cursor);
    return graph;
  };

  const isCurrentInvocation = (graph: ReadonlyMap<string, Awaited<ReturnType<typeof readPriorProgress>>>, target: Awaited<ReturnType<typeof readPriorProgress>>) => {
    let current: typeof target | undefined = target;
    const seen = new Set<string>();
    while (current) {
      if (current.index.lifecycle === 'superseded' || seen.has(current.index.id)) return false;
      seen.add(current.index.id);
      for (const row of graph.values()) {
        if (row.index.parentRecordId === current.index.parentRecordId && row.index.memberOrdinal === current.index.memberOrdinal
          && BigInt(row.index.attempt) > BigInt(current.index.attempt)) return false;
      }
      if (current.index.parentRecordId === null) return true;
      current = graph.get(current.index.parentRecordId);
    }
    return false;
  };

  const deriveRetryCausalSet = async (
    graph: ReadonlyMap<string, Awaited<ReturnType<typeof readPriorProgress>>>,
    targetId: string,
    run: WorkflowRunSummaryV1,
    signal?: AbortSignal,
  ): Promise<WorkflowInvocationRecoveryAvailabilityV1['retry']> => {
    const unavailable = (reason: Exclude<WorkflowInvocationRecoveryAvailabilityV1['retry'], { kind: 'available' }>['reason']) =>
      ({ kind: 'unavailable' as const, reason });
    const target = graph.get(targetId);
    if (!target || !isCurrentInvocation(graph, target)) return unavailable('invocation_not_recoverable');
    const ancestors = new Set<string>();
    for (let current: typeof target | undefined = target; current;) {
      if (ancestors.has(current.index.id)) return unavailable('causal_set_requires_batch_review');
      ancestors.add(current.index.id);
      if (current.index.parentRecordId === null) break;
      const parent = graph.get(current.index.parentRecordId);
      if (!parent) return unavailable('causal_set_requires_batch_review');
      current = parent;
    }
    const groupIds = new Set<string>();
    for (const row of graph.values()) {
      if (!isCurrentInvocation(graph, row)) continue;
      const code = row.progress.reason?.code;
      if (code === 'container_fail_stop') return unavailable('causal_set_requires_batch_review');
      if (!code?.startsWith('container_fail_stop:')) continue;
      const groupId = code.slice('container_fail_stop:'.length);
      const group = graph.get(groupId);
      if (!group || (group.progress.blockKind !== 'parallel' && group.progress.blockKind !== 'loop')) {
        return unavailable('causal_set_requires_batch_review');
      }
      if (ancestors.has(groupId)) groupIds.add(groupId);
    }
    const selected = new Set<string>([targetId]);
    for (const row of graph.values()) {
      if (!isCurrentInvocation(graph, row)) continue;
      // A stop request can race with successful completion. Its retained
      // causal reason is history, not permission to replay the successful leaf.
      if (row.index.lifecycle === 'completed' || row.index.lifecycle === 'skipped') continue;
      const code = row.progress.reason?.code;
      const groupId = code?.startsWith('container_fail_stop:')
        ? code.slice('container_fail_stop:'.length)
        : undefined;
      if (groupId && groupIds.has(groupId)) {
        selected.add(row.index.id);
        continue;
      }
      // The initiating failure may have its native failure reason rather than
      // the stop reason attached to cancelled siblings. Selecting a sibling
      // must recover that failure too, and must not overlook a still-active
      // member whose stop fact has not arrived yet.
      if (!EXACT_RECOVERY_RETRY_LIFECYCLES.has(row.index.lifecycle)
        && !EXACT_RECOVERY_ACTIVE_LIFECYCLES.has(row.index.lifecycle)
        && row.progress.execution === undefined) continue;
      let parentId = row.index.parentRecordId;
      while (parentId !== null) {
        if (groupIds.has(parentId)) {
          selected.add(row.index.id);
          break;
        }
        parentId = graph.get(parentId)?.index.parentRecordId ?? null;
      }
    }
    for (const seedId of [...selected]) {
      let current = graph.get(seedId);
      while (current) {
        selected.add(current.index.id);
        if (groupIds.has(current.index.id) || current.index.parentRecordId === null) break;
        current = graph.get(current.index.parentRecordId);
        if (!current) return unavailable('causal_set_requires_batch_review');
      }
    }
    const rows = [...selected].map((id) => graph.get(id));
    if (rows.some((row) => !row)) return unavailable('causal_set_requires_batch_review');
    if (rows.some((row) => row!.index.lifecycle === 'cancel_requested')) return unavailable('stop_pending');
    if (rows.some((row) => !EXACT_RECOVERY_RETRY_LIFECYCLES.has(row!.index.lifecycle)
      && !(row!.index.lifecycle === 'needs_attention'
        && (isStructuralRecoveryFrame(row!.progress.blockKind) || row!.progress.uncertainPriorEffects?.activity === 'stopped')))) {
      return unavailable('causal_set_requires_batch_review');
    }
    for (const row of rows) {
      if (!row || row.progress.blockKind !== 'step') continue;
      const availability = deriveExactInvocationRecoveryAvailability({ run, index: row.index, progress: row.progress,
        evidence: await recoveryEvidence(run, row, signal), current: isCurrentInvocation(graph, row) });
      if (availability.retry.kind !== 'available') return availability.retry;
    }
    const depth = (row: NonNullable<typeof rows[number]>): number => {
      let value = 0;
      let parentId = row.index.parentRecordId;
      const seen = new Set<string>();
      while (parentId !== null && selected.has(parentId)) {
        if (seen.has(parentId)) return Number.MAX_SAFE_INTEGER;
        seen.add(parentId);
        value += 1;
        parentId = graph.get(parentId)?.index.parentRecordId ?? null;
      }
      return value;
    };
    const ordered = rows.filter((row): row is NonNullable<typeof row> => row !== undefined)
      .sort((left, right) => {
        const depthOrder = depth(left) - depth(right);
        if (depthOrder !== 0) return depthOrder;
        const leftSequence = BigInt(left.index.sequence);
        const rightSequence = BigInt(right.index.sequence);
        return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
      });
    return { kind: 'available', causalInvocationIds: ordered.map((row) => row.index.id) };
  };

  const recoveryEvidence = async (run: WorkflowRunSummaryV1, prior: Awaited<ReturnType<typeof readPriorProgress>>, signal?: AbortSignal) => {
    // Structural frames do not own an executable input. Their replacement
    // eligibility is derived from the exact causal leaves below.
    if (isStructuralRecoveryFrame(prior.progress.blockKind)) return { activity: 'not_active' as const, canReattach: false, canContinueConversation: false };
    deps.assertCurrent?.();
    const evidence = await deps.observeRecovery?.({ run, index: prior.index, progress: prior.progress, ...(signal ? { signal } : {}) })
      ?? { activity: prior.progress.execution === undefined && EXACT_RECOVERY_RETRY_LIFECYCLES.has(prior.index.lifecycle)
          || prior.progress.uncertainPriorEffects?.activity === 'stopped' ? 'not_active' as const : 'unknown' as const,
        canReattach: false, canContinueConversation: false };
    deps.assertCurrent?.();
    return evidence;
  };

  const resolveRestoreWorkspaces = async (opened: Awaited<ReturnType<typeof openAccepted>>,
    prior: Awaited<ReturnType<typeof readPriorProgress>>, signal?: AbortSignal): Promise<readonly WorkflowWorkspaceProgressV1[]> => {
    // A leaf's own correspondence is exact, including an inherited pair copied
    // at admission. Only an unmaterialized leaf needs its qualified frame root.
    if (prior.progress.blockKind !== 'workflow' && prior.progress.workspace?.descriptor) return [prior.progress.workspace];
    const structure = await resolveWorkflowInvocationStructureV1({ definition: opened.accepted.definition,
      frozenChildren: opened.accepted.frozenChildren, invocation: prior,
      keyOfInvocation: row => row.index.id,
      readInvocation: id => readPriorProgress(prior.index.runId, id, opened, signal) });
    if (!structure) return [];
    if (structure.leaf.kind === 'workflow') {
      // A frame can propagate either slot's failure. Restore verifies every
      // recorded generated slot, not a guessed failing slot or a new checkout.
      const project = prior.progress.container?.kind === 'body' ? prior.progress.container.frameProjectWorkspace : undefined;
      return [project, prior.progress.workspace].filter((workspace): workspace is WorkflowWorkspaceProgressV1 =>
        workspace !== undefined && workspace.creationIntent !== undefined);
    }
    const frozen = opened.accepted.materializedLeaves.find(leaf => leaf.sourceKey === structure.sourceKey
      && leaf.blockId === structure.leaf.id && leaf.kind === structure.leaf.kind);
    if (!frozen) return [];
    const selection = frozen.authoredWorkspace;
    if (structure.definition.defaults.workspace?.kind !== 'new_worktree'
      || (selection.kind !== 'inherit'
        && !(selection.kind === 'new_worktree' && selection.source.kind === 'workflow'))) return [];
    const owner = await readPriorProgress(prior.index.runId, structure.rootConversationOwnerRecordId, opened, signal);
    return owner.progress.workspace ? [owner.progress.workspace] : [];
  };

  const recoveryAvailability = async (run: WorkflowRunSummaryV1, prior: Awaited<ReturnType<typeof readPriorProgress>>, signal?: AbortSignal,
    retryCausalSet?: WorkflowInvocationRecoveryAvailabilityV1['retry'], graph?: ReadonlyMap<string, Awaited<ReturnType<typeof readPriorProgress>>>,
    restoreWorkspaces?: readonly WorkflowWorkspaceProgressV1[]) => {
    const recordedWorkspaces = restoreWorkspaces ?? (prior.progress.reason?.code === 'workspace_unavailable'
      ? await resolveRestoreWorkspaces(await openAccepted(run.id, signal), prior, signal) : []);
    const currentGraph = graph ?? await readInvocationGraph(run.id, { accountId: prior.accountId, enc: prior.enc }, signal, prior);
    const evidence = await recoveryEvidence(run, prior, signal);
    const current = isCurrentInvocation(currentGraph, prior);
    const initial = deriveExactInvocationRecoveryAvailability({ run, index: prior.index, progress: prior.progress, evidence, current,
      restoreWorkspaces: recordedWorkspaces });
    const causalSet = retryCausalSet ?? (initial.retry.kind === 'available'
      ? await deriveRetryCausalSet(currentGraph, prior.index.id, run, signal) : initial.retry);
    let canContinueConversation = evidence.canContinueConversation;
    if (canContinueConversation && causalSet.kind === 'available') {
      for (const id of causalSet.causalInvocationIds) {
        const row = currentGraph.get(id);
        if (!row || row.progress.blockKind !== 'step' || row.index.id === prior.index.id) continue;
        const leaf = deriveExactInvocationRecoveryAvailability({ run, index: row.index, progress: row.progress,
          evidence: await recoveryEvidence(run, row, signal), current: isCurrentInvocation(currentGraph, row) });
        if (leaf.continueSameConversation.kind !== 'available') {
          canContinueConversation = false;
          break;
        }
      }
    }
    return deriveExactInvocationRecoveryAvailability({ run, index: prior.index, progress: prior.progress,
      evidence: { ...evidence, canContinueConversation }, current, retryCausalSet: causalSet, restoreWorkspaces: recordedWorkspaces });
  };

  const readRunUsage = async (
    runId: string,
    resolvedEncryption: Readonly<{
      accountId: string;
      enc: WorkflowRunEncryptionV1;
    }>,
    signal?: AbortSignal,
  ): Promise<WorkflowUsageV1 | undefined> => {
    let cursor: string | undefined;
    let applicableExecutions = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let inputTokensComplete = true;
    let outputTokensComplete = true;
    let costUsdComplete = true;

    do {
      // The storage-only `progressEnvelopes` flag returns each row's private
      // envelope in a byte-bounded same-page sidecar, so usage costs one
      // storage read per page instead of one detail read per invocation.
      const page = record(await deps.storage.execute({
        operation: 'invocations.list',
        runId,
        progressEnvelopes: true,
        ...(cursor ? { cursor } : {}),
        pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
      }, signal ? { signal } : {}));
      // A row whose envelope is absent from the sidecar fails closed below.
      const sidecar = page.progressEnvelopesByInvocationId;
      const envelopesById: Readonly<Record<string, unknown>> = sidecar && typeof sidecar === 'object' && !Array.isArray(sidecar)
        ? sidecar as Readonly<Record<string, unknown>>
        : {};
      for (const raw of Array.isArray(page.invocations) ? page.invocations : []) {
        const index = WorkflowRunInvocationIndexV1Schema.parse(raw);
        const progress = openProgress(runId, index, envelopesById[index.id], resolvedEncryption);
        // Execution correspondence is the private admission fact. Containers,
        // skipped leaves and attempts that never reached admission do not
        // contribute a synthetic zero to any usage dimension.
        if (!progress.execution) continue;
        applicableExecutions += 1;

        if (progress.usage?.inputTokens === undefined) {
          inputTokensComplete = false;
        } else if (Number.isSafeInteger(inputTokens + progress.usage.inputTokens)) {
          inputTokens += progress.usage.inputTokens;
        } else {
          inputTokensComplete = false;
        }
        if (progress.usage?.outputTokens === undefined) {
          outputTokensComplete = false;
        } else if (Number.isSafeInteger(outputTokens + progress.usage.outputTokens)) {
          outputTokens += progress.usage.outputTokens;
        } else {
          outputTokensComplete = false;
        }
        if (progress.usage?.costUsd === undefined) {
          costUsdComplete = false;
        } else if (Number.isFinite(costUsd + progress.usage.costUsd)) {
          costUsd += progress.usage.costUsd;
        } else {
          costUsdComplete = false;
        }
      }
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
    } while (cursor);

    if (applicableExecutions === 0) return undefined;
    const usage: WorkflowUsageV1 = {
      ...(inputTokensComplete ? { inputTokens } : {}),
      ...(outputTokensComplete ? { outputTokens } : {}),
      ...(costUsdComplete ? { costUsd } : {}),
    };
    return Object.keys(usage).length === 0 ? undefined : usage;
  };

  const sealProgress = async (params: Readonly<{
    accountId: string;
    runId: string;
    recordId: string;
    sequence: string;
    parentRecordId: string | null;
    memberOrdinal: string;
    attempt: string;
    progress: WorkflowProgressEnvelopeV1;
    enc: WorkflowRunEncryptionV1;
    signal?: AbortSignal;
  }>): Promise<string> => {
    return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      ...sealMode(params.enc, deps.randomBytes),
      binding: {
        v: 1, purpose: 'invocation_progress', accountId: params.accountId, runId: params.runId,
        recordId: params.recordId, sequence: params.sequence, parentRecordId: params.parentRecordId,
        memberOrdinal: params.memberOrdinal, attempt: params.attempt,
      },
      progress: params.progress,
    }));
  };

  const openSnapshotCheckpoint = async (params: Readonly<{
    runId: string;
    checkpointEnvelope: string | null;
    accountId: string;
    enc: WorkflowRunEncryptionV1;
    signal?: AbortSignal;
  }>): Promise<WorkflowCheckpoint | null> => {
    if (!params.checkpointEnvelope) return null;
    const envelope = parseWorkflowStoredContentEnvelopeV1(params.checkpointEnvelope);
    const opened = envelope && openWorkflowCheckpointStoredEnvelopeV1({
      ...openMode(params.enc),
      binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: params.runId },
      envelope,
    });
    if (!opened || opened.kind !== 'available') throw workflowError('content_unavailable');
    return WorkflowCheckpointEnvelopeV1Schema.parse(opened.content);
  };

  const sealCheckpoint = async (params: Readonly<{
    runId: string;
    checkpoint: WorkflowCheckpoint;
    accountId: string;
    enc: WorkflowRunEncryptionV1;
    signal?: AbortSignal;
  }>): Promise<string> => {
    return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
      ...sealMode(params.enc, deps.randomBytes),
      binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: params.runId },
      checkpoint: params.checkpoint,
    }));
  };

  const bumpCheckpointForNewSequences = (checkpoint: WorkflowCheckpoint, lastNewSequence: bigint): WorkflowCheckpoint => ({
    ...checkpoint,
    nextSequence: (lastNewSequence + 1n).toString(),
  });

  const retryInvocation = async (
    args: WorkflowActionExecuteArgs<'workflow.run.invocations.retry'>,
    openedAccepted: Awaited<ReturnType<typeof openAccepted>>,
    ingressContext: WorkflowIngressContextV1 | undefined,
  ) => {
    await assertControllerDominates(args, openedAccepted.accepted, ingressContext, deps.isAcceptedAuthorizationCurrent, deps);
    const signal = args.context.signal;
    const resolvedEncryption = { accountId: openedAccepted.accountId, enc: openedAccepted.enc };
    const prior = await readPriorProgress(
      args.input.runId, args.input.invocation.recordId, resolvedEncryption, signal,
    );
    const graph = await readInvocationGraph(args.input.runId, resolvedEncryption, signal, prior);
    const requestedRows = args.input.causalInvocationIds.map((id) => graph.get(id));
    if (requestedRows.length > 0 && requestedRows.every((row) => row?.index.lifecycle === 'superseded')) {
      const replacementIds = args.input.causalInvocationIds.map((id, index) => deriveWorkflowReplacementId([
        'workflow.run.invocations.retry', args.context.actionRequestId ?? args.input,
        args.input.runId, id, args.input.expectedRevision, index,
      ]));
      const replacements = replacementIds.map((id) => graph.get(id));
      const replacementByPriorId = new Map(args.input.causalInvocationIds.map((id, index) => [id, replacementIds[index]!]));
      const exact = replacements.every((replacement, index) => {
        const previous = requestedRows[index]!;
        const expectedParent = previous.index.parentRecordId === null
          ? null
          : replacementByPriorId.get(previous.index.parentRecordId) ?? previous.index.parentRecordId;
        return replacement?.index.lifecycle === 'pending'
          && replacement.index.parentRecordId === expectedParent
          && replacement.index.memberOrdinal === previous.index.memberOrdinal
          && replacement.index.attempt === (BigInt(previous.index.attempt) + 1n).toString()
          && replacement.progress.previousAttemptRecordId === previous.index.id;
      });
      const selectedIndex = args.input.causalInvocationIds.indexOf(prior.index.id);
      const selected = replacements[selectedIndex];
      const expectedSelectedInput = normalizeRecoveryInput(prior.progress, args.input.input);
      if (openedAccepted.snapshot.run.revision === args.input.expectedRevision + 1
        && exact && selected
        && selected.progress.recovery?.conversation === args.input.conversation
        && sameStrictJsonValue(selected.progress.recovery?.input, expectedSelectedInput)) {
        return WorkflowActionOutputSchemasV1['workflow.run.invocations.retry'].parse({
          run: openedAccepted.snapshot.run,
          invocation: selected.index,
          disposition: 'accepted',
        });
      }
      throw workflowError('currentness_conflict');
    }
    const selectedAvailability = await recoveryAvailability(openedAccepted.snapshot.run, prior, signal, undefined, graph);
    if (selectedAvailability.retry.kind !== 'available'
      || (args.input.conversation === 'same_conversation' && selectedAvailability.continueSameConversation.kind !== 'available')) {
      throw workflowError('ineligible_state');
    }
    const stoppedWithUncertainEffects = prior.progress.uncertainPriorEffects?.activity === 'stopped';
    if (prior.index.lifecycle === 'outcome_uncertain'
      || (stoppedWithUncertainEffects && args.input.acknowledgeUncertainPriorEffects !== true)) {
      throw workflowError('workflow_outcome_unresolved');
    }
    if (args.input.acknowledgeUncertainPriorEffects === true && !stoppedWithUncertainEffects) {
      throw workflowError('invalid_input');
    }
    const causalSet = await deriveRetryCausalSet(graph, prior.index.id, openedAccepted.snapshot.run, signal);
    if (causalSet.kind !== 'available'
      || !sameStrictJsonValue(causalSet.causalInvocationIds, args.input.causalInvocationIds)) {
      throw workflowError('invalid_input');
    }
    const priors = causalSet.causalInvocationIds.map((id) => graph.get(id));
    if (priors.some((row) => row === undefined)) throw workflowError('currentness_conflict');
    const exactPriors = priors.filter((row): row is NonNullable<typeof row> => row !== undefined);
    for (const row of exactPriors) {
      if (row.progress.blockKind !== 'step') continue;
      const availability = await recoveryAvailability(openedAccepted.snapshot.run, row, signal, undefined, graph);
      if (availability.retry.kind !== 'available'
        || (args.input.conversation === 'same_conversation' && availability.continueSameConversation.kind !== 'available')) {
        throw workflowError('ineligible_state');
      }
      if (row.progress.uncertainPriorEffects?.activity === 'stopped' && args.input.acknowledgeUncertainPriorEffects !== true) {
        throw workflowError('workflow_outcome_unresolved');
      }
    }
    const checkpoint = await openSnapshotCheckpoint({
      runId: args.input.runId,
      checkpointEnvelope: openedAccepted.snapshot.checkpointEnvelope,
      ...resolvedEncryption,
      ...(signal ? { signal } : {}),
    });
    if (!checkpoint) throw workflowError('content_unavailable');
    const replacements = exactPriors.map((row, index) => ({
      prior: row,
      newId: deriveWorkflowReplacementId([
        'workflow.run.invocations.retry', args.context.actionRequestId ?? args.input,
        args.input.runId, row.index.id, args.input.expectedRevision, index,
      ]),
      newSequence: (BigInt(checkpoint.nextSequence) + BigInt(index)).toString(),
      newAttempt: (BigInt(row.index.attempt) + 1n).toString(),
    }));
    const replacementIdByPriorId = new Map(replacements.map((item) => [item.prior.index.id, item.newId]));
    const prepared = await Promise.all(replacements.map(async (item) => {
      const {
        execution: _execution, result: _result, containerResult: _containerResult,
        reason: _reason, observationDeadline: _deadline, recovery: _recovery,
        uncertainPriorEffects: _uncertain, previousAttemptRecordId: _previous,
        ...reusable
      } = item.prior.progress;
      const isSelected = item.prior.index.id === prior.index.id;
      const recoveryInput = item.prior.progress.blockKind === 'step'
        ? normalizeRecoveryInput(item.prior.progress, isSelected ? args.input.input : { kind: 'original' })
        : undefined;
      const progress = WorkflowProgressEnvelopeV1Schema.parse({
        ...reusable,
        attempt: item.newAttempt,
        previousAttemptRecordId: item.prior.index.id,
        ...(item.prior.progress.container
          ? { container: resetRecoveredContainer(item.prior.progress.container) }
          : {}),
        ...(recoveryInput ? {
          input: StrictJsonValueSchema.parse(recoveryInput.value),
          recovery: {
            conversation: args.input.conversation,
            input: recoveryInput,
            ...(isSelected && args.input.acknowledgeUncertainPriorEffects !== undefined
              ? { acknowledgeUncertainPriorEffects: args.input.acknowledgeUncertainPriorEffects }
              : {}),
          },
        } : {}),
      });
      const parentRecordId = item.prior.index.parentRecordId === null
        ? null
        : replacementIdByPriorId.get(item.prior.index.parentRecordId) ?? item.prior.index.parentRecordId;
      const contentEnvelope = await sealProgress({
        accountId: item.prior.accountId, runId: args.input.runId,
        recordId: item.newId, sequence: item.newSequence, parentRecordId,
        memberOrdinal: item.prior.index.memberOrdinal, attempt: item.newAttempt,
        progress, enc: openedAccepted.enc, ...(signal ? { signal } : {}),
      });
      return { ...item, parentRecordId, progress, contentEnvelope };
    }));
    const checkpointEnvelope = await sealCheckpoint({
      runId: args.input.runId,
      checkpoint: bumpCheckpointForNewSequences(checkpoint, BigInt(checkpoint.nextSequence) + BigInt(prepared.length - 1)),
      ...resolvedEncryption,
      ...(signal ? { signal } : {}),
    });
    let stored: unknown;
    try {
      stored = await deps.storage.execute({
        operation: 'invocations.recover', runId: args.input.runId, expectedRevision: args.input.expectedRevision,
        accountCurrentness: openedAccepted.enc.witness,
        checkpointEnvelope,
        recoveries: prepared.map((item) => ({
          invocationId: item.prior.index.id,
          newInvocationId: item.newId,
          contentEnvelope: item.contentEnvelope,
        })),
      }, signal ? { signal } : {});
    } catch (error) {
      const code = (error as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
      if (code === 'ineligible_state') {
        try {
          const fresh = await getSnapshot(args.input.runId, signal);
          return WorkflowActionOutputSchemasV1['workflow.run.invocations.retry'].parse({ run: fresh.run, invocation: prior.index, disposition: 'ineligible' });
        } catch {
          translateStorageError(error);
        }
      }
      if (isIndeterminateWrite(error) || code === 'conflict' || code === 'currentness_conflict') {
        try {
          const fresh = await openAccepted(args.input.runId, signal);
          const freshEncryption = { accountId: fresh.accountId, enc: fresh.enc };
          const reopened = await Promise.all(prepared.flatMap((item) => [
            readPriorProgress(args.input.runId, item.prior.index.id, freshEncryption, signal),
            readPriorProgress(args.input.runId, item.newId, freshEncryption, signal),
          ]));
          const freshCheckpoint = await openSnapshotCheckpoint({
            runId: args.input.runId,
            checkpointEnvelope: fresh.snapshot.checkpointEnvelope,
            ...freshEncryption,
            ...(signal ? { signal } : {}),
          });
          const exact = prepared.every((item, index) => {
            const freshPrior = reopened[index * 2]!;
            const replacement = reopened[index * 2 + 1]!;
            return freshPrior.index.lifecycle === 'superseded'
              && replacement.parentRevision === fresh.snapshot.run.revision
              && replacement.index.parentRecordId === item.parentRecordId
              && replacement.index.memberOrdinal === item.prior.index.memberOrdinal
              && replacement.index.attempt === item.newAttempt
              && replacement.index.lifecycle === 'pending'
              && sameStrictJsonValue(replacement.progress, item.progress);
          });
          if (fresh.snapshot.run.revision === args.input.expectedRevision + 1
            && exact
            && freshCheckpoint?.nextSequence === (BigInt(checkpoint.nextSequence) + BigInt(prepared.length)).toString()) {
            const selected = reopened[prepared.findIndex((item) => item.prior.index.id === prior.index.id) * 2 + 1]!;
            return WorkflowActionOutputSchemasV1['workflow.run.invocations.retry'].parse({
              run: fresh.snapshot.run,
              invocation: selected.index,
              disposition: 'accepted',
            });
          }
          if (code === 'conflict' || code === 'currentness_conflict') {
            return WorkflowActionOutputSchemasV1['workflow.run.invocations.retry'].parse({ run: fresh.snapshot.run, invocation: prior.index, disposition: 'conflict' });
          }
          throw workflowError('currentness_conflict');
        } catch (rejoinError) {
          if ((rejoinError as { code?: unknown }).code === 'content_unavailable') throw rejoinError;
          throw workflowError('currentness_conflict');
        }
      }
      translateStorageError(error);
    }
    const body = record(stored);
    const disposition = body.disposition === 'existing' ? 'accepted' : body.disposition;
    const invocations = Array.isArray(body.invocations) ? body.invocations : [];
    const selectedIndex = prepared.findIndex((item) => item.prior.index.id === prior.index.id);
    return WorkflowActionOutputSchemasV1['workflow.run.invocations.retry'].parse({
      run: body.run,
      invocation: invocations[selectedIndex] ?? prior.index,
      disposition,
    });
  };

  const recoverContinuations = async (
    args: WorkflowActionExecuteArgs<'workflow.run.resume'>,
    openedAccepted: Awaited<ReturnType<typeof openAccepted>>,
    ingressContext: WorkflowIngressContextV1 | undefined,
  ) => {
    if (args.input.mode !== 'recover') throw workflowError('continuation_unavailable');
    if (args.input.invocations.some((choice) => choice.kind !== 'reattach')) {
      await assertControllerDominates(args, openedAccepted.accepted, ingressContext, deps.isAcceptedAuthorizationCurrent, deps);
    }
    const restoresWorkspace = args.input.invocations.some((choice) => choice.kind === 'restore_workspace');
    const restoreMachineTarget = args.context.externalActionTarget?.kind === 'machine'
      ? args.context.externalActionTarget
      : null;
    if (restoresWorkspace
      && (!restoreMachineTarget || restoreMachineTarget.machineId !== openedAccepted.accepted.machineId)) {
      throw workflowError('target_unavailable');
    }
    const signal = args.context.signal;
    const resolvedEncryption = { accountId: openedAccepted.accountId, enc: openedAccepted.enc };
    const makeRecoveryProgress = (
      prior: Awaited<ReturnType<typeof readPriorProgress>>,
      choice: (typeof args.input.invocations)[number],
    ): WorkflowProgressEnvelopeV1 => {
      if (choice.kind === 'reattach') throw workflowError('invalid_input');
      const {
        execution: _priorExecution,
        result: _priorResult,
        containerResult: _priorContainerResult,
        reason: _priorReason,
        observationDeadline: _priorObservationDeadline,
        recovery: _priorRecovery,
        uncertainPriorEffects: _priorUncertainPriorEffects,
        previousAttemptRecordId: _priorPreviousAttemptRecordId,
        ...priorReusableProgress
      } = prior.progress;
      const recoveryInput = choice.kind === 'restore_workspace'
        ? normalizeRecoveryInput(
            prior.progress,
            choice.input as { kind: 'original' } | { kind: 'replacement'; value: WorkflowAuthoredInputV1 },
          )
        : {
            kind: 'replacement' as const,
            value: choice.input as WorkflowAuthoredInputV1,
          };
      return {
        ...priorReusableProgress,
        attempt: (BigInt(prior.index.attempt) + 1n).toString(),
        logicalInvocationRecordId: prior.progress.logicalInvocationRecordId,
        previousAttemptRecordId: prior.index.id,
        input: StrictJsonValueSchema.parse(recoveryInput.value),
        recovery: {
          conversation: choice.conversation as 'same_conversation' | 'fresh_agent',
          input: recoveryInput,
          ...(choice.acknowledgeUncertainPriorEffects !== undefined ? { acknowledgeUncertainPriorEffects: true as const } : {}),
        },
      };
    };
    const checkpoint = await openSnapshotCheckpoint({
      runId: args.input.runId,
      checkpointEnvelope: openedAccepted.snapshot.checkpointEnvelope,
      ...resolvedEncryption,
      ...(signal ? { signal } : {}),
    });
    const priors: Array<Awaited<ReturnType<typeof readPriorProgress>>> = [];
    for (const choice of args.input.invocations) {
      const prior = await readPriorProgress(
        args.input.runId,
        choice.invocation.recordId,
        resolvedEncryption,
        signal,
      );
      if (choice.kind === 'reattach') {
        const availability = await recoveryAvailability(openedAccepted.snapshot.run, prior, signal);
        if (availability.reattach.kind !== 'available' || !deps.reattachInvocation) throw workflowError('ineligible_state');
        deps.assertCurrent?.();
        await deps.reattachInvocation({ run: openedAccepted.snapshot.run, index: prior.index, progress: prior.progress, ...(signal ? { signal } : {}) });
        deps.assertCurrent?.();
      } else {
        // A committed deterministic replacement is checked below without
        // repeating observation or filesystem effects after response loss.
        if (prior.index.lifecycle === 'superseded') {
          priors.push(prior);
          continue;
        }
        if (choice.kind === 'continue') {
          const availability = await recoveryAvailability(openedAccepted.snapshot.run, prior, signal);
          const offered = choice.conversation === 'same_conversation' ? availability.continueSameConversation : availability.continueFreshAgent;
          if (offered.kind !== 'available') throw workflowError('ineligible_state');
          // A continuation choice cannot silently omit failed/cancelled
          // siblings or structural recomputation. That review belongs to the
          // existing retry operation with its explicit exact causal ids.
          if (availability.retry.kind !== 'available'
            || availability.retry.causalInvocationIds.length !== 1
            || availability.retry.causalInvocationIds[0] !== prior.index.id) {
            throw workflowError('invalid_input');
          }
        }
        const stoppedWithUncertainEffects = prior.progress.uncertainPriorEffects?.activity === 'stopped';
        if (prior.index.lifecycle === 'outcome_uncertain'
          || (stoppedWithUncertainEffects && choice.acknowledgeUncertainPriorEffects !== true)) {
          throw workflowError('workflow_outcome_unresolved');
        }
        if (choice.acknowledgeUncertainPriorEffects === true && !stoppedWithUncertainEffects && choice.kind !== 'restore_workspace') {
          throw workflowError('invalid_input');
        }
        if (choice.kind === 'restore_workspace') {
          // Only the request that still owns the expected Run revision may
          // touch SCM. The +1 case is the deterministic response-loss rejoin
          // below and must observe, never repeat, that filesystem effect.
          if (openedAccepted.snapshot.run.revision !== args.input.expectedRevision) {
            throw workflowError('currentness_conflict');
          }
          const restoreWorkspaces = await resolveRestoreWorkspaces(openedAccepted, prior, signal);
          if (prior.progress.reason?.code !== 'workspace_unavailable'
            || restoreWorkspaces.length === 0
            || restoreWorkspaces.some(workspace => workspace.descriptor?.machineId !== openedAccepted.accepted.machineId)) {
            throw workflowError('workflow_workspace_restore_unavailable');
          }
          const availability = await recoveryAvailability(openedAccepted.snapshot.run, prior, signal, undefined, undefined, restoreWorkspaces);
          if (availability.restoreWorkspace.kind !== 'available') throw workflowError('ineligible_state');
          const evidence = await recoveryEvidence(openedAccepted.snapshot.run, prior, signal);
          if (prior.progress.execution && choice.acknowledgeUncertainPriorEffects !== true) throw workflowError('workflow_outcome_unresolved');
          if (choice.conversation === 'same_conversation' && !evidence.canContinueConversation) throw workflowError('ineligible_state');
          for (const workspace of restoreWorkspaces) {
            let restored;
            try {
              restored = await deps.restoreWorkspace?.(workspace)
                ?? { ok: false as const, code: 'workflow_workspace_restore_unavailable' as const };
            } catch {
              throw workflowError('workflow_workspace_restore_failed');
            }
            if (!restored.ok) throw workflowError(restored.code);
          }
        }
      }
      priors.push(prior);
    }
    if (args.input.invocations.every((choice) => choice.kind === 'reattach')) {
      return WorkflowActionOutputSchemasV1['workflow.run.resume'].parse({
        run: openedAccepted.snapshot.run,
        intent: 'recovery_required',
      });
    }
    const continuing = args.input.invocations.flatMap((choice, index) => choice.kind === 'reattach'
      ? []
      : [{ choice, choiceIndex: index, prior: priors[index]! }]);
    if (continuing.some(({ prior }) => prior.index.lifecycle === 'superseded')) {
      if (!checkpoint
        || continuing.some(({ prior }) => prior.index.lifecycle !== 'superseded')
        || openedAccepted.snapshot.run.revision !== args.input.expectedRevision + 1) {
        throw workflowError('currentness_conflict');
      }
      const replacements = await Promise.all(continuing.map(({ choiceIndex, prior }) => readPriorProgress(
        args.input.runId,
        deriveWorkflowReplacementId(['workflow.run.resume.recover', args.context.actionRequestId ?? args.input, args.input.runId, prior.index.id, choiceIndex, args.input.expectedRevision]),
        resolvedEncryption,
        signal,
      )));
      const exact = continuing.every(({ choice, prior }, index) => {
        const replacement = replacements[index]!;
        return replacement.parentRevision === openedAccepted.snapshot.run.revision
          && replacement.index.runId === args.input.runId
          && replacement.index.parentRecordId === prior.index.parentRecordId
          && replacement.index.memberOrdinal === prior.index.memberOrdinal
          && replacement.index.attempt === (BigInt(prior.index.attempt) + 1n).toString()
          && replacement.index.lifecycle === 'pending'
          && sameStrictJsonValue(replacement.progress, makeRecoveryProgress(prior, choice));
      });
      const lastSequence = replacements.reduce((maximum, replacement) => {
        const sequence = BigInt(replacement.index.sequence);
        return sequence > maximum ? sequence : maximum;
      }, -1n);
      if (!exact || checkpoint.nextSequence !== (lastSequence + 1n).toString()) throw workflowError('currentness_conflict');
      return WorkflowActionOutputSchemasV1['workflow.run.resume'].parse({ run: openedAccepted.snapshot.run, intent: 'resumed' });
    }
    if (!checkpoint) throw workflowError('content_unavailable');
    const start = BigInt(checkpoint.nextSequence);
    const recoveries: Array<{ invocationId: string; newInvocationId: string; contentEnvelope: string }> = [];
    const preparedRecoveries: Array<Readonly<{
      prior: Awaited<ReturnType<typeof readPriorProgress>>;
      newId: string;
      newSequence: string;
      newAttempt: string;
      progress: WorkflowProgressEnvelopeV1;
    }>> = [];
    let nextSequence = start;
    for (const [choiceIndex, choice] of args.input.invocations.entries()) {
      const prior = priors[choiceIndex]!;
      if (choice.kind === 'reattach') {
        continue;
      }
      const newAttempt = (BigInt(prior.index.attempt) + 1n).toString();
      const newId = deriveWorkflowReplacementId([
        'workflow.run.resume.recover',
        args.context.actionRequestId ?? args.input,
        args.input.runId,
        prior.index.id,
        choiceIndex,
        args.input.expectedRevision,
      ]);
      const newSequenceString = nextSequence.toString();
      nextSequence += 1n;
      const progress = makeRecoveryProgress(prior, choice);
      const contentEnvelope = await sealProgress({
        accountId: openedAccepted.accountId, enc: openedAccepted.enc,
        runId: args.input.runId, recordId: newId, sequence: newSequenceString,
        parentRecordId: prior.index.parentRecordId, memberOrdinal: prior.index.memberOrdinal, attempt: newAttempt,
        progress, ...(signal ? { signal } : {}),
      });
      recoveries.push({ invocationId: prior.index.id, newInvocationId: newId, contentEnvelope });
      preparedRecoveries.push({ prior, newId, newSequence: newSequenceString, newAttempt, progress });
    }
    const lastNewSequence = nextSequence - 1n;
    const nextCheckpoint = bumpCheckpointForNewSequences(checkpoint, lastNewSequence);
    const checkpointEnvelope = await sealCheckpoint({
      runId: args.input.runId,
      checkpoint: nextCheckpoint,
      ...resolvedEncryption,
      ...(signal ? { signal } : {}),
    });
    let stored: unknown;
    try {
      stored = await deps.storage.execute({
        operation: 'invocations.recover', runId: args.input.runId, expectedRevision: args.input.expectedRevision,
        accountCurrentness: openedAccepted.enc.witness, checkpointEnvelope, recoveries,
      }, signal ? { signal } : {});
    } catch (error) {
      const code = (error as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
      if (isIndeterminateWrite(error) || code === 'conflict' || code === 'currentness_conflict') {
        try {
          const fresh = await openAccepted(args.input.runId, signal);
          const freshEncryption = { accountId: fresh.accountId, enc: fresh.enc };
          const rows = await Promise.all(preparedRecoveries.flatMap((prepared) => [
            readPriorProgress(args.input.runId, prepared.prior.index.id, freshEncryption, signal),
            readPriorProgress(args.input.runId, prepared.newId, freshEncryption, signal),
          ]));
          const freshCheckpoint = await openSnapshotCheckpoint({
            runId: args.input.runId,
            checkpointEnvelope: fresh.snapshot.checkpointEnvelope,
            ...freshEncryption,
            ...(signal ? { signal } : {}),
          });
          const exact = fresh.snapshot.run.revision === args.input.expectedRevision + 1
            && preparedRecoveries.every((prepared, index) => {
              const freshPrior = rows[index * 2]!;
              const replacement = rows[index * 2 + 1]!;
              return freshPrior.index.lifecycle === 'superseded'
                && replacement.parentRevision === fresh.snapshot.run.revision
                && replacement.index.runId === args.input.runId
                && replacement.index.parentRecordId === prepared.prior.index.parentRecordId
                && replacement.index.memberOrdinal === prepared.prior.index.memberOrdinal
                && replacement.index.sequence === prepared.newSequence
                && replacement.index.attempt === prepared.newAttempt
                && replacement.index.lifecycle === 'pending'
                && replacement.progress.previousAttemptRecordId === prepared.prior.index.id
                && sameStrictJsonValue(replacement.progress, prepared.progress);
            })
            && freshCheckpoint?.nextSequence === nextSequence.toString();
          if (exact) return WorkflowActionOutputSchemasV1['workflow.run.resume'].parse({ run: fresh.snapshot.run, intent: 'resumed' });
          throw workflowError('currentness_conflict');
        } catch (rejoinError) {
          if ((rejoinError as { code?: unknown }).code === 'content_unavailable') throw rejoinError;
          throw workflowError('currentness_conflict');
        }
      }
      translateStorageError(error);
    }
    const body = record(stored);
    return WorkflowActionOutputSchemasV1['workflow.run.resume'].parse({ run: body.run, intent: 'resumed' });
  };

  type ReviewArgs = Extract<RunArgs, { actionId: 'workflow.run.invocations.publish_draft' | 'workflow.run.invocations.complete_review' }>;
  type OpenedRun = Awaited<ReturnType<typeof openAccepted>>;
  type OpenedRow = Awaited<ReturnType<typeof readPriorProgress>>;

  const reviewStructure = async (opened: OpenedRun, row: OpenedRow, signal?: AbortSignal) => {
    const structure = await resolveWorkflowInvocationStructureV1({ definition: opened.accepted.definition,
      frozenChildren: opened.accepted.frozenChildren, invocation: row,
      keyOfInvocation: invocation => invocation.index.id,
      readInvocation: id => readPriorProgress(row.index.runId, id, opened, signal) });
    if (!structure || structure.leaf.kind === 'workflow') throw workflowError('ineligible_state');
    return { ...structure, leaf: structure.leaf };
  };

  const reviewResultContract = (opened: OpenedRun, structure: Awaited<ReturnType<typeof reviewStructure>>): ExecutionRunProfileResultContract | undefined => {
    if (structure.leaf.kind !== 'action') return structure.leaf.result;
    const frozen = opened.accepted.materializedLeaves.find(entry => entry.sourceKey === structure.sourceKey
      && entry.blockId === structure.leaf.id && entry.kind === 'action');
    if (!frozen?.actionContract || frozen.actionId !== structure.leaf.actionId) throw workflowError('content_unavailable');
    if (frozen.actionContract.completion !== undefined) {
      const completion = ActionCompletionContractV1Schema.safeParse(frozen.actionContract.completion);
      if (!completion.success) throw workflowError('content_unavailable');
      return { kind: 'json', schema: completion.data.terminalOutputSchema };
    }
    const schema = PluginJsonSchemaV2Schema.safeParse(frozen.actionContract.outputSchema);
    if (!schema.success) throw workflowError('content_unavailable');
    return { kind: 'json', schema: schema.data };
  };

  const review = async (args: ReviewArgs, ingressContext?: WorkflowIngressContextV1) => {
    const { input } = args;
    const signal = args.context.signal;
    const opened = await openAccepted(input.runId, signal);
    const completing = args.actionId === 'workflow.run.invocations.complete_review';
    if (completing && args.input.mode === 'use_result') await assertControllerDominates(args, opened.accepted, ingressContext, deps.isAcceptedAuthorizationCurrent, deps);
    else assertRunResourceRestriction(args.context, { machineId: opened.accepted.machineId,
      project: opened.accepted.workspaceTarget.project }, deps.normalizeAbsolutePath);
    const callerAccountId = await deps.resolveAccountId(signal);
    const prior = await readPriorProgress(input.runId, input.invocation.recordId, opened, signal);
    if (prior.index.runId !== input.runId || prior.index.id !== input.invocation.recordId) throw workflowError('content_unavailable');
    const structure = await reviewStructure(opened, prior, signal);
    const contract = reviewResultContract(opened, structure);
    const fieldless = structure.leaf.kind === 'wait' && contract === undefined;
    const requireValidValue = (value: WorkflowProgressEnvelopeV1['result']) => {
      if (fieldless) {
        if (value !== undefined) throw workflowError('invalid_input');
        return;
      }
      if (value === undefined) throw workflowError('invalid_input');
      const decoded = decodeExecutionRunResultObservation({ encoding: 'typed', value }, contract);
      if (!decoded.ok) throw workflowError('invalid_input');
    };
    const completeOutput = (run: WorkflowRunSummaryV1, row: OpenedRow) => WorkflowActionOutputSchemasV1['workflow.run.invocations.complete_review'].parse({
      run, invocation: row.index, disposition: args.actionId === 'workflow.run.invocations.complete_review' && args.input.mode === 'generate' ? 'generation_requested' : 'completed',
    });
    const exactDecision = (row: OpenedRow) => {
      if (args.actionId !== 'workflow.run.invocations.complete_review') return false;
      const decision = row.progress.review?.decision;
      if (!decision || decision.kind !== args.input.mode || decision.requestedFromContentRevision !== input.expectedContentRevision) return false;
      if (args.input.mode === 'generate') return true;
      return decision.kind === 'use_result' && sameStrictJsonValue(decision.followUp ?? null, args.input.followUp ?? null)
        && (args.input.value === undefined || (sameStrictJsonValue(row.progress.result, args.input.value)
          && row.progress.review?.resultSource?.kind === 'human' && row.progress.review.resultSource.accountId === callerAccountId));
    };
    const rejoin = async (fresh: OpenedRun, row: OpenedRow) => {
      if (!exactDecision(row) || args.actionId !== 'workflow.run.invocations.complete_review') return undefined;
      if (args.input.mode === 'use_result') return row.index.lifecycle === 'completed' ? completeOutput(fresh.snapshot.run, row) : undefined;
      if (classifyWorkflowHoldV1({ lifecycle: row.index.lifecycle, progress: row.progress, isCurrent: true }) === 'generate') return completeOutput(fresh.snapshot.run, row);
      if (row.index.lifecycle !== 'superseded') return undefined;
      const replacementId = deriveWorkflowReplacementId(['workflow.review.generate', input.runId, row.index.id, input.expectedContentRevision]);
      const replacement = await readPriorProgress(input.runId, replacementId, fresh, signal);
      if (replacement.index.lifecycle === 'superseded' || replacement.index.lifecycle === 'cancelled'
        || replacement.index.runId !== row.index.runId || replacement.index.parentRecordId !== row.index.parentRecordId
        || replacement.index.memberOrdinal !== row.index.memberOrdinal || BigInt(replacement.index.attempt) !== BigInt(row.index.attempt) + 1n
        || replacement.progress.previousAttemptRecordId !== row.index.id
        || replacement.progress.logicalInvocationRecordId !== row.progress.logicalInvocationRecordId
        || replacement.progress.blockKind !== row.progress.blockKind
        || !sameStrictJsonValue(replacement.progress.invocationPath, row.progress.invocationPath)) return undefined;
      return completeOutput(fresh.snapshot.run, replacement);
    };
    if (args.actionId === 'workflow.run.invocations.complete_review' && args.input.mode === 'generate') {
      if (structure.leaf.kind !== 'step' || !await resolveWorkflowRetainedConversationAttemptV1({ invocation: prior,
        readInvocation: id => readPriorProgress(input.runId, id, opened, signal) })) throw workflowError('continuation_unavailable');
      if (prior.progress.uncertainPriorEffects && args.input.acknowledgeUncertainPriorEffects !== true) throw workflowError('workflow_outcome_unresolved');
      if (!prior.progress.uncertainPriorEffects && args.input.acknowledgeUncertainPriorEffects === true) throw workflowError('invalid_input');
    }
    const existing = await rejoin(opened, prior);
    if (existing) return existing;
    if (prior.index.contentRevision !== input.expectedContentRevision) throw workflowError('currentness_conflict');
    const current = record(await deps.storage.execute({ operation: 'invocations.current', runId: input.runId,
      parentRecordId: prior.index.parentRecordId, memberOrdinal: prior.index.memberOrdinal }, signal ? { signal } : {}));
    const currentIndex = WorkflowRunInvocationIndexV1Schema.parse(record(current.invocation).index);
    if (currentIndex.id !== prior.index.id || currentIndex.contentRevision !== prior.index.contentRevision) throw workflowError('currentness_conflict');
    const held = prior.index.lifecycle === 'waiting_for_review';
    if (completing && !held) throw workflowError('ineligible_state');
    if (!isWorkflowDraftPublicationLifecycleV1(prior.index.lifecycle)
      || (!held && structure.leaf.kind === 'wait')) throw workflowError('ineligible_state');
    if (structure.leaf.kind !== 'wait' && !structure.leaf.pauseForReview) throw workflowError('ineligible_state');
    if (!held && prior.progress.previousAttemptRecordId) {
      const previous = await readPriorProgress(input.runId, prior.progress.previousAttemptRecordId, opened, signal);
      if (previous.progress.review?.decision?.kind === 'generate') throw workflowError('ineligible_state');
    }
    let progress: WorkflowProgressEnvelopeV1;
    if (args.actionId === 'workflow.run.invocations.publish_draft') {
      requireValidValue(args.input.value);
      progress = WorkflowProgressEnvelopeV1Schema.parse({ ...prior.progress, result: args.input.value,
        review: { ...prior.progress.review, resultSource: { kind: 'published', by: args.context.surface === 'agent' || args.context.surface === 'mcp' ? 'agent' : 'user' } } });
    } else if (args.input.mode === 'use_result') {
      const value = args.input.value === undefined ? prior.progress.result : args.input.value;
      requireValidValue(value);
      if (args.input.followUp?.kind === 'run_started') {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw workflowError('invalid_input');
        const plan = record(value);
        if (typeof plan.document !== 'string' || plan.proposal === undefined) throw workflowError('invalid_input');
        const child = await openAccepted(args.input.followUp.runId, signal);
        if (!matchesWorkflowAcceptedDefinitionV1(child.accepted.authoredDefinition, plan.proposal,
            ingressContext ? { context: ingressContext } : {})) throw workflowError('invalid_input');
      }
      progress = WorkflowProgressEnvelopeV1Schema.parse({ ...prior.progress, ...(value === undefined ? {} : { result: value }),
        review: { ...prior.progress.review, ...(args.input.value === undefined ? {} : { resultSource: { kind: 'human', accountId: callerAccountId } }),
          decision: { kind: 'use_result', requestedFromContentRevision: input.expectedContentRevision, ...(args.input.followUp ? { followUp: args.input.followUp } : {}) } } });
    } else {
      progress = WorkflowProgressEnvelopeV1Schema.parse({ ...prior.progress, review: { ...prior.progress.review,
        decision: { kind: 'generate', requestedFromContentRevision: input.expectedContentRevision } } });
    }
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      ...sealMode(opened.enc, deps.randomBytes), binding: { v: 1, purpose: 'invocation_progress', accountId: opened.accountId,
        runId: input.runId, recordId: prior.index.id, sequence: prior.index.sequence, parentRecordId: prior.index.parentRecordId,
        memberOrdinal: prior.index.memberOrdinal, attempt: prior.index.attempt }, progress }));
    let stored: unknown;
    try {
      stored = await deps.storage.execute({ operation: completing ? 'invocations.complete_review' : 'invocations.publish_draft',
        runId: input.runId, invocationId: prior.index.id, invocationAttempt: prior.index.attempt,
        expectedContentRevision: input.expectedContentRevision, accountCurrentness: opened.enc.witness, contentEnvelope,
        ...(args.actionId === 'workflow.run.invocations.complete_review' ? { mode: args.input.mode } : {}) }, signal ? { signal } : {});
    } catch (error) {
      if (completing && isIndeterminateWrite(error)) {
        const fresh = await openAccepted(input.runId, signal);
        const row = await readPriorProgress(input.runId, prior.index.id, fresh, signal);
        const joined = await rejoin(fresh, row);
        if (joined) return joined;
        throw workflowError('currentness_conflict');
      }
      translateStorageError(error);
    }
    const body = record(stored);
    const invocation = record(body.invocation);
    const index = WorkflowRunInvocationIndexV1Schema.parse(invocation.index);
    if (index.id !== prior.index.id || index.runId !== input.runId || index.attempt !== prior.index.attempt) throw workflowError('content_unavailable');
    const published = openProgress(input.runId, index, invocation.contentEnvelope, opened);
    if (args.actionId === 'workflow.run.invocations.publish_draft') return WorkflowActionOutputSchemasV1[args.actionId].parse({
      invocation: { index, progress: published, parentRevision: body.parentRevision } });
    return WorkflowActionOutputSchemasV1[args.actionId].parse({ run: body.run, invocation: index, disposition: body.disposition });
  };

  const execute: WorkflowRunActionOwner['execute'] = async (args, ingressContext) => {
    if (args.actionId === 'workflow.run.invocations.complete_review' && args.context.authority !== 'present_user') throw workflowError('present_user_required');
    if (args.actionId === 'workflow.run.invocations.complete_review' || args.actionId === 'workflow.run.invocations.publish_draft') return await review(args, ingressContext);
    if (args.actionId === 'workflow.run.start') return await start(args, ingressContext);
    // The caller's resource restriction is not the transport relay. Check it
    // before scoped reads or durable intents; unqualified controls stay key-free.
    const target = args.context.externalActionTarget;
    const restrictedRunId = 'runId' in args.input ? args.input.runId : undefined;
    if (target !== undefined && typeof restrictedRunId === 'string'
      && args.actionId !== 'workflow.run.get'
      && args.actionId !== 'workflow.run.resume'
      && args.actionId !== 'workflow.run.invocations.retry') {
      if (target.kind !== 'machine') throw workflowError('target_unavailable');
      if (target.project) {
        const opened = await openAccepted(restrictedRunId, args.context.signal);
        assertRunResourceRestriction(args.context, { machineId: opened.accepted.machineId, project: opened.accepted.workspaceTarget.project }, deps.normalizeAbsolutePath);
      } else {
        const snapshot = await getSnapshot(restrictedRunId, args.context.signal);
        assertRunResourceRestriction(args.context, { machineId: snapshot.run.machineId }, deps.normalizeAbsolutePath);
      }
    }
    if (args.actionId === 'workflow.run.summaries') {
      if (target !== undefined) throw workflowError('target_unavailable');
      try {
        return WorkflowActionOutputSchemasV1[args.actionId].parse(await deps.storage.execute({
          operation: 'summaries', request: args.input, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
        }, args.context.signal ? { signal: args.context.signal } : {}));
      } catch (error) {
        translateStorageError(error);
      }
    }
    if (args.actionId === 'workflow.run.list') {
      if (target !== undefined && (target.kind !== 'machine' || target.project
        || (args.input.machineId !== undefined && args.input.machineId !== target.machineId))) {
        throw workflowError('target_unavailable');
      }
      try {
        const projectPage = async (raw: unknown) => {
          const storagePage = record(raw);
          const acceptedEnvelopesByRunId = record(storagePage.acceptedEnvelopesByRunId);
          const page = {
            runs: WorkflowRunListResultV1Schema.shape.runs.parse(storagePage.runs),
            nextCursor: WorkflowRunListResultV1Schema.shape.nextCursor.parse(storagePage.nextCursor),
          };
          const callerEncryption = await encryption(args.context.signal);
          const keyCensusByRunId = record(storagePage.keyCensusByRunId);
          const rootProgressByRunId = record(storagePage.rootProgressByRunId ?? {});
          const metadataByRunId: Record<string, WorkflowRunPrivateMetadataV1> = {};
          const runs: WorkflowRunSummaryV1[] = [];
          for (const run of page.runs) {
            let projected: WorkflowRunPrivateMetadataV1 | null;
            let where: WorkflowRunSummaryV1['where'] = null;
            let startedBy: WorkflowRunSummaryV1['startedBy'] = null;
            let stepProgress: WorkflowRunSummaryV1['stepProgress'] = null;
            let stepProgressCurrentness: WorkflowRunSummaryV1['stepProgressCurrentness'] = null;
            let rootIndex: WorkflowRunInvocationIndexV1 | undefined;
            const root = record(rootProgressByRunId[run.id] ?? {});
            try {
              const index = WorkflowRunInvocationIndexV1Schema.parse(root.index);
              if (index.runId === run.id && index.parentRecordId === null
                && index.sequence === '0' && index.memberOrdinal === '0' && index.attempt === '0') {
                rootIndex = index;
                stepProgressCurrentness = { recordId: index.id, attempt: index.attempt, contentRevision: index.contentRevision };
              }
            } catch {
              // An absent or malformed root index is not an observation token.
            }
            try {
              const census = WorkflowRunRecipientCensusResponseV1Schema.parse(keyCensusByRunId[run.id]);
              const resolved = resolveWorkflowRunDataKeyV1({ encryption: callerEncryption, census });
              if (resolved.kind !== 'available') throw workflowError('content_unavailable');
              await prepareRunRecipients(run.id, resolved.encryption, census, args.context.signal);
              if (rootIndex) {
                const index = rootIndex;
                const openedProgress = openWorkflowProgressStoredEnvelopeV1({
                  ...openMode(resolved.encryption),
                  binding: { v: 1, purpose: 'invocation_progress', accountId: census.ownerAccountId, runId: run.id,
                    recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
                    memberOrdinal: index.memberOrdinal, attempt: index.attempt },
                  envelope: parseWorkflowStoredContentEnvelopeV1(root.contentEnvelope),
                });
                if (openedProgress.kind === 'bindingMismatch' || openedProgress.kind === 'modeMismatch'
                  || (openedProgress.kind === 'available' && openedProgress.content.blockKind !== 'root')) {
                  stepProgressCurrentness = null;
                } else if (openedProgress.kind === 'available') {
                  stepProgress = openedProgress.content.stepProgress ?? null;
                }
              }
              const rawEnvelope = acceptedEnvelopesByRunId[run.id];
              if (typeof rawEnvelope !== 'string') throw workflowError('content_unavailable');
              const envelope = parseWorkflowStoredContentEnvelopeV1(rawEnvelope);
              if (!envelope) throw workflowError('content_unavailable');
              const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
                ...openMode(resolved.encryption),
                binding: { v: 1, purpose: 'accepted_snapshot', accountId: census.ownerAccountId, runId: run.id },
                envelope,
              });
              if (opened.kind !== 'available') throw workflowError('content_unavailable');
              const accepted = WorkflowAcceptedSnapshotV1Schema.parse(opened.content);
              startedBy = accepted.startedBy;
              const project = accepted.workspaceTarget.project;
              where = { machineId: project.machineId, directory: project.directory,
                ...(project.workspaceRefId ? { workspaceRefId: project.workspaceRefId } : {}) };
              // An opened snapshot with no authored metadata is an untitled
              // Run, not unreadable private content. The sidecar omits its
              // key so the consumer keeps its ordinary unknown-name state
              // instead of reporting a content-unavailable Run.
              projected = accepted.metadata
                ? { kind: 'available', value: accepted.metadata }
                : null;
            } catch {
              // The public row remains useful even when this Account cannot
              // open its private accepted content on the current host.
              projected = { kind: 'unavailable' };
            }
            runs.push({ ...run, where, startedBy, stepProgress, stepProgressCurrentness });
            if (projected) metadataByRunId[run.id] = projected;
          }
          return WorkflowActionOutputSchemasV1[args.actionId].parse({
            runs,
            metadataByRunId,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          });
        };
        return await projectPage(await deps.storage.execute({
          operation: 'list',
          request: target?.kind === 'machine' ? { ...args.input, machineId: target.machineId } : args.input,
          pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
        }, args.context.signal ? { signal: args.context.signal } : {}));
      } catch (error) {
        translateStorageError(error);
      }
    }
    if (args.actionId === 'workflow.run.pause' || args.actionId === 'workflow.run.cancel' || args.actionId === 'workflow.run.delete') {
      try {
        return WorkflowActionOutputSchemasV1[args.actionId].parse(await deps.storage.execute({ operation: args.actionId.slice('workflow.run.'.length), ...args.input }, args.context.signal ? { signal: args.context.signal } : {}));
      } catch (error) {
        translateStorageError(error);
      }
    }
    if (args.actionId === 'workflow.run.resume') {
      if (args.input.mode === 'boundary') {
        if (target !== undefined) {
          // Project identity is private: a key-free control cannot prove that
          // restriction. Machine restrictions use only the public Run row.
          if (target.kind !== 'machine' || target.project) throw workflowError('target_unavailable');
          const snapshot = await getSnapshot(args.input.runId, args.context.signal);
          assertRunResourceRestriction(args.context, { machineId: snapshot.run.machineId }, deps.normalizeAbsolutePath);
        }
        try {
          return WorkflowActionOutputSchemasV1[args.actionId].parse(await deps.storage.execute({ operation: 'resume', runId: args.input.runId, expectedRevision: args.input.expectedRevision }, args.context.signal ? { signal: args.context.signal } : {}));
        } catch (error) {
          translateStorageError(error);
        }
      }
      const restorePublisherMachineId = args.input.mode === 'recover'
        && args.input.invocations.some((choice) => choice.kind === 'restore_workspace')
        && args.context.externalActionTarget?.kind === 'machine'
        ? args.context.externalActionTarget.machineId
        : undefined;
      const opened = await openAccepted(args.input.runId, args.context.signal, restorePublisherMachineId);
      if (args.input.mode === 'recover') {
        return await recoverContinuations(args, opened, ingressContext);
      }
      throw workflowError('continuation_unavailable');
    }
    if (args.actionId === 'workflow.run.get') {
      const { accountId, enc, snapshot, accepted } = await openAccepted(args.input.runId, args.context.signal);
      assertRunResourceRestriction(args.context, { machineId: accepted.machineId, project: accepted.workspaceTarget.project }, deps.normalizeAbsolutePath);
      let checkpoint = null;
      if (snapshot.checkpointEnvelope) {
        const envelope = parseWorkflowStoredContentEnvelopeV1(snapshot.checkpointEnvelope);
        const opened = envelope && openWorkflowCheckpointStoredEnvelopeV1({ ...openMode(enc), binding: { v: 1, purpose: 'checkpoint', accountId, runId: args.input.runId }, envelope });
        if (!opened || opened.kind !== 'available') throw workflowError('content_unavailable');
        checkpoint = WorkflowCheckpointEnvelopeV1Schema.parse(opened.content);
      }
      let result: unknown;
      let finalOutputInvocationId: string | undefined;
      if (snapshot.resultEnvelope) {
        const envelope = parseWorkflowStoredContentEnvelopeV1(snapshot.resultEnvelope);
        const opened = envelope && openWorkflowFinalResultStoredEnvelopeV1({ ...openMode(enc), binding: { v: 1, purpose: 'final_result', accountId, runId: args.input.runId }, envelope });
        if (!opened || opened.kind !== 'available') throw workflowError('content_unavailable');
        result = opened.content.result.value;
        finalOutputInvocationId = opened.content.producerInvocation.recordId;
      }
      const usage = await readRunUsage(
        args.input.runId,
        { accountId, enc },
        args.context.signal,
      );
      return WorkflowActionOutputSchemasV1[args.actionId].parse({
        run: snapshot.run,
        callerAccess: { canEdit: snapshot.keyCensus.access !== 'view' },
        definition: accepted.definition,
        authoredDefinition: accepted.authoredDefinition,
        acceptedContext: projectAcceptedContext(accepted),
        checkpoint,
        ...(result === undefined ? {} : { result }),
        ...(finalOutputInvocationId === undefined ? {} : { finalOutputInvocationId }),
        ...(usage === undefined ? {} : { usage }),
      });
    }
    if (args.actionId === 'workflow.run.wait') {
      const waitArgs = args;
      const deadline = args.input.timeoutSeconds === undefined
        ? undefined
        : Date.now() + args.input.timeoutSeconds * 1_000;
      let stored: unknown;
      let revision = 0;
      let wake: (() => void) | undefined;
      let failure: unknown;
      let lastSnapshot: ReturnType<typeof WorkflowRunWaitSnapshotV1Schema.parse> | undefined;
      const armDeadline = (finish: () => void) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const schedule = () => {
          if (deadline === undefined) return;
          const remaining = deadline - Date.now();
          if (remaining <= 0) finish();
          // Re-arm at JavaScript's signed timer boundary against the same
          // authored budget, whether waiting for output or a feed change.
          else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
        };
        schedule();
        return () => { if (timer !== undefined) clearTimeout(timer); };
      };
      args.context.signal?.throwIfAborted();
      const observation = deps.storage.observeChanges?.(args.input.runId,
        () => { revision += 1; wake?.(); },
        (error) => { failure = error; wake?.(); });
      try { for (;;) {
        args.context.signal?.throwIfAborted();
        if (failure !== undefined) throw failure;
        const observedRevision = revision;
        const afterRevision = await assertWaitDoesNotOccupyTargetConversation(waitArgs);
        try {
          stored = await deps.storage.execute({
            operation: 'wait', runId: args.input.runId,
            ...(args.input.conditions === undefined ? {} : { conditions: args.input.conditions }),
            ...(deadline !== undefined && Date.now() >= deadline ? { timeoutSeconds: 0 } : {}),
            ...(afterRevision === undefined ? {} : { afterRevision }),
          }, args.context.signal ? { signal: args.context.signal } : {});
        } catch (error) {
          if (args.context.signal?.aborted) throw args.context.signal.reason;
          translateStorageError(error);
        }
        await assertWaitDoesNotOccupyTargetConversation(waitArgs);
        args.context.signal?.throwIfAborted();
        if (failure !== undefined) throw failure;
        const raw = record(stored);
        const onSnapshot = args.context.onWaitSnapshot;
        if (onSnapshot) {
          const snapshot = WorkflowRunWaitSnapshotV1Schema.parse({ run: raw.run });
          if (!lastSnapshot || !sameStrictJsonValue(lastSnapshot, snapshot)) {
            // Output backpressure preserves order, but must not retain an
            // observer after the caller cancels or its deadline expires.
            await new Promise<void>((resolve, reject) => {
              const signal = args.context.signal;
              let cancelDeadline = () => {};
              const cleanup = () => { cancelDeadline(); signal?.removeEventListener('abort', abort); wake = undefined; };
              const finish = () => { cleanup(); resolve(); };
              const fail = (error: unknown) => { cleanup(); reject(error); };
              const abort = () => fail(signal?.reason);
              wake = () => { if (failure !== undefined) fail(failure); };
              signal?.addEventListener('abort', abort, { once: true });
              if (signal?.aborted) { abort(); return; }
              cancelDeadline = armDeadline(finish);
              void Promise.resolve().then(() => {
                signal?.throwIfAborted();
                if (deadline === undefined || Date.now() < deadline) return onSnapshot(snapshot);
              }).then(finish, fail);
            });
            lastSnapshot = snapshot;
          }
          args.context.signal?.throwIfAborted();
          if (failure !== undefined) throw failure;
        }
        if (raw.observation === 'changed') continue;
        // A passive observer does not settle when a condition or terminal state
        // is seen. Keep the same feed until its cancellation/authored deadline.
        if (!args.context.onWaitSnapshot && raw.observation !== 'waiting') break;
        if (deadline !== undefined && Date.now() >= deadline) {
          stored = { observation: 'timeout', run: raw.run };
          break;
        }
        if (!observation) throw workflowError('target_unavailable');
        // Register after the read, but compare the feed revision captured before it:
        // a wake during an in-flight read cannot be lost between read and sleep.
        await new Promise<void>((resolve) => {
          let cancelDeadline = () => {};
          const finish = () => {
            cancelDeadline();
            args.context.signal?.removeEventListener('abort', finish);
            wake = undefined;
            resolve();
          };
          wake = finish;
          args.context.signal?.addEventListener('abort', finish, { once: true });
          cancelDeadline = armDeadline(finish);
          if (revision !== observedRevision || failure !== undefined || args.context.signal?.aborted) finish();
        });
      } } finally { await observation?.dispose(); }
      const raw = record(stored);
      const { resultEnvelope: _ignored, keyCensus: _keyCensus, ...base } = raw;
      if (typeof raw.resultEnvelope !== 'string') return WorkflowActionOutputSchemasV1[args.actionId].parse(base);
      const census = WorkflowRunRecipientCensusResponseV1Schema.parse(raw.keyCensus);
      const resolved = resolveWorkflowRunDataKeyV1({ encryption: await encryption(args.context.signal), census });
      if (resolved.kind !== 'available') throw workflowError('content_unavailable');
      await prepareRunRecipients(args.input.runId, resolved.encryption, census, args.context.signal);
      const envelope = parseWorkflowStoredContentEnvelopeV1(raw.resultEnvelope);
      const opened = envelope && openWorkflowFinalResultStoredEnvelopeV1({ ...openMode(resolved.encryption), binding: { v: 1, purpose: 'final_result', accountId: census.ownerAccountId, runId: args.input.runId }, envelope });
      if (!opened || opened.kind !== 'available') throw workflowError('content_unavailable');
      return WorkflowActionOutputSchemasV1[args.actionId].parse({ ...base, result: opened.content.result.value });
    }
    if (args.actionId === 'workflow.run.invocations.list') {
      try {
        const page = record(await deps.storage.execute({ operation: 'invocations.list', ...args.input, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES }, args.context.signal ? { signal: args.context.signal } : {}));
        return WorkflowActionOutputSchemasV1[args.actionId].parse({
          invocations: page.invocations,
          parentRevision: page.parentRevision,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        });
      } catch (error) {
        translateStorageError(error);
      }
    }
    if (args.actionId === 'workflow.run.invocations.get') {
      const acceptedRun = await openAccepted(args.input.runId, args.context.signal);
      const { accountId, enc, snapshot } = acceptedRun;
      const opened = await readPriorProgress(
        args.input.runId,
        args.input.invocationId,
        { accountId, enc },
        args.context.signal,
      );
      const run = snapshot.run;
      const evidence = await recoveryEvidence(run, opened, args.context.signal);
      const restoreWorkspaces = opened.progress.reason?.code === 'workspace_unavailable'
        ? await resolveRestoreWorkspaces(acceptedRun, opened, args.context.signal) : [];
      const initialAvailability = deriveExactInvocationRecoveryAvailability({ run, index: opened.index, progress: opened.progress, evidence, restoreWorkspaces });
      const graph = initialAvailability.retry.kind === 'available' || initialAvailability.reattach.kind === 'available' || initialAvailability.restoreWorkspace.kind === 'available'
        ? await readInvocationGraph(args.input.runId, { accountId, enc }, args.context.signal, opened) : undefined;
      const retryCausalSet = initialAvailability.retry.kind === 'available' && graph
        ? await deriveRetryCausalSet(graph, opened.index.id, run, args.context.signal)
        : initialAvailability.retry;
      return WorkflowActionOutputSchemasV1[args.actionId].parse({
        invocation: {
          index: opened.index,
          progress: opened.progress,
          parentRevision: opened.parentRevision,
          recoveryAvailability: graph
            ? await recoveryAvailability(run, opened, args.context.signal, retryCausalSet, graph, restoreWorkspaces)
            : deriveExactInvocationRecoveryAvailability({ run, index: opened.index, progress: opened.progress,
              evidence, current: opened.index.lifecycle !== 'superseded', retryCausalSet, restoreWorkspaces }),
        },
      });
    }
    if (args.actionId === 'workflow.run.invocations.retry') {
      const opened = await openAccepted(args.input.runId, args.context.signal);
      return await retryInvocation(
        args,
        opened,
        ingressContext,
      );
    }
    throw workflowError('continuation_unavailable');
  };
  return { execute: async (args, ingressContext) => {
    deps.assertCurrent?.();
    try {
      return await execute(args, ingressContext);
    } finally {
      deps.assertCurrent?.();
    }
  } };
}

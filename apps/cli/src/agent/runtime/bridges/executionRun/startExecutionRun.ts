import { createHash, randomUUID } from 'node:crypto';

import type { SessionId } from '@/agent/core/AgentMessage';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import {
  resolveExecutionRunIntentProfile,
  resolveExecutionRunIntentProfileFromCatalog,
  type ExecutionRunProfileContributionCatalog,
} from '@/agent/executionRuns/profiles/intentRegistry';
import {
  type ExecutionRunStructuredMeta,
} from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import {
  REVIEW_SCM_SCOPE_INPUT_KEY,
  ReviewScmScopeV1Schema,
  ExecutionRunVoiceAgentIntentInputV1Schema,
  resolveScmPullRequestReviewScope,
  type AcpConfigOptionOverridesV1,
  type BackendTargetRefV1,
  type ConnectedServiceBindingsV2,
  type ProviderBoundModelRef,
  type ExecutionRunResultContractV1,
  type SessionInputAdmissionResultV1,
  type SessionInputCausalPermissionAuthorityV1,
  withExecutionRunStartFailureDetails,
  projectExecutionRunRequestedConfiguration,
  resolveExecutionRunNotifyParentDefaultV1,
  SECOND_OPINION_RESULT_SCHEMA_V1,
  buildBackendTargetKeyV2,
  readSessionRolesV1,
} from '@happier-dev/protocol';
import { resolveExecutionRunRoleV1 } from '@/agent/executionRuns/profiles/review/reviewRole';
import { resolveEffectiveCodingPromptPlan } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import { readWorktreeChangeFingerprint } from '@/scm/readWorktreeChangeFingerprint';
import { runScmCommand } from '@/scm/runtime';
import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';
import type {
  ExecutionRunManagerStartParams,
  ExecutionRunStartResult,
  ExecutionRunState,
  AttachRetainedRunSessionInput,
} from './executionRunTypes';
import type {
  ExecutionRunBackendController,
  ExecutionRunController,
  ExecutionRunVoiceAgentController,
} from '@/agent/executionRuns/controllers/types';
import { readBackendResumableRuntimeId } from '@/agent/executionRuns/controllers/types';
import {
  appendExecutionRunControllerHostBarrier,
  failureSignal,
} from '@/agent/executionRuns/controllers/failureSignal';
import { VoiceAgentError, type VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { writeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { createStreamedTranscriptWriter, type StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import { createExecutionRunControllerMessageHandler } from './messages/sessionStateEmission';
import { publishExecutionRunTurn } from './publishExecutionRunTurn';
import { createExecutionRunSidechainStreamText } from './sidechainStreamText';
import {
  areExecutionRunBackendTargetsEqual,
  resolveExecutionRunRuntimeBackendId,
} from './backendTargets';
import { readBackendTargetRefV2, resolveExecutionRunImplicitRoleIdV1 } from '@happier-dev/protocol';
import type { ExecutionRunPermissionRequestStoreProvider } from './executionRunPermissionResponseTarget';
import { resolveExecutionRunRuntimeSettings } from './runtimeSettings';
import { permissionMode } from '@/agent/executionRuns/policy/permissionMode';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import { isExecutionRunControllerCurrent, settleExecutionRunController } from './settleExecutionRunController';
import { createExactTurnUsageAccumulator } from '@/usage/exactTurnUsage';
import { assertExecutionRunStructuredOutputModelAllowed } from './structuredOutputAdmission';

type SendAcp = ExecutionRunTranscriptPublisher;

type FinishRunNext = Omit<
  ExecutionRunState,
  | 'runId'
  | 'callId'
  | 'sidechainId'
    | 'sessionId'
    | 'depth'
    | 'intent'
    | 'profileId'
    | 'backendTarget'
  | 'backendId'
  | 'instructions'
  | 'permissionMode'
  | 'retentionPolicy'
  | 'runClass'
  | 'ioMode'
  | 'startedAtMs'
  | 'resumeHandle'
> & {
  status: ExecutionRunState['status'];
  finishedAtMs: number;
};

type FinishRun = (
  runId: string,
  next: FinishRunNext,
  toolResult: { output: any; isError?: boolean; meta?: Record<string, unknown> },
  structuredMeta?: ExecutionRunStructuredMeta,
) => Promise<void>;

function normalizeVoiceAgentModelId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed === 'default' ? '' : trimmed;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function markExecutionRunStartFailure<T>(
  error: T,
  runCreation: 'noRunCreated' | 'outcomeUnknown',
): T {
  if (error && typeof error === 'object') {
    const currentDetails = (error as { details?: unknown }).details;
    Object.assign(error, {
      details: withExecutionRunStartFailureDetails(currentDetails, runCreation),
    });
  }
  return error;
}

function executionRunNotAllowed(message: string): Error & { code: string; details: unknown } {
  return markExecutionRunStartFailure(Object.assign(new Error(message), {
    code: 'execution_run_not_allowed',
    details: undefined as unknown,
  }), 'noRunCreated');
}

export function deriveExecutionRunIdFromActionRequestId(actionRequestId: string): string {
  return `run_request_${createHash('sha256').update(actionRequestId, 'utf8').digest('hex')}`;
}

function projectExistingExecutionRunStartResult(run: ExecutionRunState): ExecutionRunStartResult {
  const requestedConfiguration = projectExecutionRunRequestedConfiguration({
    modelId: run.launch?.teamCredentialModel?.modelId
      ?? run.launch?.modelSelection?.modelId
      ?? run.launch?.modelId,
    sessionConfigOptionOverrides: run.launch?.sessionConfigOptionOverrides,
  });
  return {
    runId: run.runId,
    callId: run.callId,
    sidechainId: run.sidechainId,
    ...(requestedConfiguration ? { requestedConfiguration } : {}),
  };
}

function assertPreparedReviewRunStartAllowed(params: ExecutionRunManagerStartParams): void {
  if (params.intent !== 'review') return;
  const intentInput = readRecord(params.intentInput);

  // A run that names a selected pull request is scoped by that pull request or
  // by nothing. The profile has already re-derived `scmReviewScope` from this
  // run's own directory by the time we get here, so a scope that arrived
  // damaged — or was rebuilt without its observation — would otherwise start a
  // review of whatever happens to be checked out and report it as a review of
  // the pull request. Refuse instead: never read the worktree scope in its
  // place, and never complete it from a locally resolved head.
  if (resolveScmPullRequestReviewScope(intentInput).status === 'scope_malformed') {
    throw executionRunNotAllowed(
      'The selected pull request review scope is unreadable, so this review cannot be scoped to that pull request.',
    );
  }

  const parsedScope = ReviewScmScopeV1Schema.safeParse(intentInput?.[REVIEW_SCM_SCOPE_INPUT_KEY]);
  if (!parsedScope.success || parsedScope.data.status !== 'unsupported') return;
  if ((params.instructions ?? '').trim().length > 0) return;

  const diagnosticMessage = parsedScope.data.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message
    ?? parsedScope.data.diagnostics[0]?.message
    ?? 'Review scope is unsupported for this session.';
  throw executionRunNotAllowed(diagnosticMessage);
}

async function assertStructuredAnalysisModelAllowed(params: ExecutionRunManagerStartParams): Promise<void> {
  const outputs = readRecord(params.intentInput)?.outputs;
  if (params.intent !== 'scm_diff_summary'
    && !(params.intent === 'review' && Array.isArray(outputs) && outputs.includes('walkthrough'))) return;
  try {
    await assertExecutionRunStructuredOutputModelAllowed(params);
  } catch (error) {
    throw markExecutionRunStartFailure(error, 'noRunCreated');
  }
}

type ExecuteBoundedRun = (args: {
  runId: string;
  callId: string;
  sidechainId: string;
  startedAtMs: number;
  params: ExecutionRunManagerStartParams;
}) => Promise<void>;

/** Role resolution and prompt credentials belong to host composition only,
 * never a profile hook or backend start request. */
export function omitExecutionRunRoleCompositionContext(
  params: ExecutionRunManagerStartParams,
): Omit<ExecutionRunManagerStartParams, 'resolvedRole' | 'roleSessionMetadata' | 'promptCredentials'> {
  const {
    resolvedRole: _resolvedRole,
    roleSessionMetadata: _roleSessionMetadata,
    promptCredentials: _promptCredentials,
    reviewNarration: _reviewNarration,
    ...startParams
  } = params;
  return startParams;
}

async function retireProvisionedRuntimeWithoutDispatch(params: Readonly<{
  runId: string;
  runtimeId: string;
  controller: ExecutionRunBackendController;
  controllers: Map<string, ExecutionRunController>;
}>): Promise<boolean> {
  if (isExecutionRunControllerCurrent(params)) {
    return false;
  }
  try {
    await params.controller.backend.cancel(params.runtimeId);
  } catch {
    // best effort
  }
  await settleExecutionRunController({
    runId: params.runId,
    controller: params.controller,
    controllers: params.controllers,
  });
  return true;
}

export async function startExecutionRun(args: Readonly<{
  params: ExecutionRunManagerStartParams;
  profileCatalog?: ExecutionRunProfileContributionCatalog;
  contributions?: Pick<
    ResolvedContributionRegistry,
    'agentDefinitionsById'
  >;
  parentProvider: ACPProvider;
  sendAcp: SendAcp;
  streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  createRuntime: (opts: {
    runId?: string;
    controllerOccurrenceId?: string;
    callId?: string;
    sidechainId?: string;
    getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider;
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    workspaceWrites?: 'allow' | 'deny';
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    modelId?: string;
    modelSelection?: ProviderBoundModelRef;
    teamCredentialModel?: import('@happier-dev/protocol').TeamCredentialProviderModelSelectionV1;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    secretReferenceOverlay?: import('@happier-dev/protocol').SecretReferenceOverlayV1;
    secretReferenceEnvironment?: Readonly<Record<string, string>>;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    connectedServicesDefaultServiceIds?: readonly string[];
    start?: ExecutionRunBackendStartContext;
  }) => ExecutionRunHostRuntime;
  /** Resolve the value-free overlay before this owner publishes a Run. */
  admitSecretReferenceOverlay?: () => Promise<Readonly<Record<string, string>>>;
  getNowMs: () => number;
  budgetRegistry: ExecutionBudgetRegistry | null;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider | null;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  enqueueMarkerWrite: (runId: string, write: () => Promise<void>) => Promise<void>;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  finishRun: FinishRun;
  executeBoundedRun: ExecuteBoundedRun;
  send: (
    runId: string,
    params: Readonly<{
      message: string;
      resume?: boolean;
      delivery?: unknown;
      localInputId?: string;
      resultContract?: ExecutionRunResultContractV1;
      structuredInput?: import('@happier-dev/protocol').HappierStructuredInputV1;
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    }>,
  ) => Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  enqueueRetainedRunInitialInput?: (input: Readonly<{
    runId: string;
    text: string;
    localId: string;
    requestedAction: Readonly<{ v: 1; kind: 'enqueue' }>;
  }>) => Promise<SessionInputAdmissionResultV1>;
  voiceAgentManager: VoiceAgentManager;
  onPublicStateUpdated?: (runId: string) => void;
  /**
   * Attach this exact retained Run occurrence to canonical target-aware Session
   * input. The bridge owns the composition; start only knows when a retained
   * occurrence became current. It returns the occurrence's release operation.
   */
  attachRetainedRunSessionInput?: AttachRetainedRunSessionInput;
}>): Promise<ExecutionRunStartResult> {
  // Generated role guidance cannot supply an authored review scope.
  assertPreparedReviewRunStartAllowed(args.params);
  try {
    const role = resolveExecutionRunRoleV1({
      roleId: args.params.roleId ?? resolveExecutionRunImplicitRoleIdV1(args.params.intent),
      resolvedRole: args.params.resolvedRole,
      accountSettings: args.params.accountSettings,
      sessionMetadata: args.params.roleSessionMetadata,
      defaultEngine: { agentTargetKey: buildBackendTargetKeyV2(readBackendTargetRefV2(args.params.backendTarget)) },
    });
    if (args.params.roleId && !args.params.resolvedRole) {
      throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
    }
    if (role) {
      const plan = await resolveEffectiveCodingPromptPlan({
        credentials: args.params.promptCredentials,
        settings: args.params.accountSettings,
        profileId: args.params.launchProfileId ?? role.profileId,
        baseOverride: null,
        memoryRecallGuidanceEnabled: false,
        roleContext: { role, notes: readSessionRolesV1(args.params.roleSessionMetadata)?.notes },
      });
      let secondOpinionInput: Readonly<Record<string, unknown>> | undefined;
      if (role.roleId === 'second_opinion') {
        const intentInput = readRecord(args.params.intentInput) ?? {};
        const fingerprint = await readWorktreeChangeFingerprint(args.params.cwd ?? process.cwd());
        const supplied = readRecord(intentInput.input) ?? {};
        const diff = supplied.diff === undefined ? await runScmCommand({
          bin: 'git',
          cwd: args.params.cwd ?? process.cwd(),
          args: ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'],
        }) : null;
        secondOpinionInput = {
          ...intentInput,
          resultSchema: SECOND_OPINION_RESULT_SCHEMA_V1,
          input: {
            ...supplied,
            question: supplied.question ?? args.params.instructions ?? '',
            goal: supplied.goal ?? null,
            changeFingerprint: fingerprint.kind === 'available' ? fingerprint.fingerprint : null,
            diff: supplied.diff ?? (diff?.success ? diff.stdout : null),
            ...(diff && !diff.success ? { diffUnavailable: diff.outputLimitExceeded ? 'output_limit_exceeded' : 'scm_unavailable' } : {}),
            transcriptPointer: supplied.transcriptPointer ?? (args.params.sessionId ? { sessionId: args.params.sessionId } : null),
          },
        };
      }
      args = {
        ...args,
        params: {
          ...args.params,
          instructions: [plan.text, args.params.instructions ?? ''].filter(Boolean).join('\n\n'),
          workspaceWrites: args.params.workspaceWrites === 'deny' || role.workspaceWrites === 'deny' ? 'deny' : role.workspaceWrites,
          ...(secondOpinionInput ? { intentInput: secondOpinionInput } : {}),
        },
      };
    }
  } catch (error) {
    throw markExecutionRunStartFailure(error, 'noRunCreated');
  }
  const profile = args.profileCatalog
    ? resolveExecutionRunIntentProfileFromCatalog(
        args.profileCatalog,
        args.params.intent,
        args.params.profileId,
        args.params.profileSourceCustody,
      )
    : resolveExecutionRunIntentProfile(args.params.intent);
  if (args.params.sessionId === null && profile.supportsDetached !== true) {
    throw executionRunNotAllowed(`Execution-run intent '${args.params.intent}' requires a Session scope`);
  }
  const actionRequestId = typeof args.params.actionRequestId === 'string'
    ? args.params.actionRequestId.trim()
    : '';
  const requestBoundRunId = actionRequestId
    ? deriveExecutionRunIdFromActionRequestId(actionRequestId)
    : null;
  if (requestBoundRunId) {
    const existing = args.runs.get(requestBoundRunId);
    if (existing) return projectExistingExecutionRunStartResult(existing);
  }
  await assertStructuredAnalysisModelAllowed(args.params);
  let initialSecretReferenceEnvironment:
    Readonly<Record<string, string>> | undefined;
  if (args.params.secretReferenceOverlay) {
    if (!args.admitSecretReferenceOverlay) {
      throw markExecutionRunStartFailure(
        Object.assign(new Error('Execution-run Saved Secret admission is unavailable'), {
          code: 'provider_secret_unavailable',
        }),
        'noRunCreated',
      );
    }
    try {
      initialSecretReferenceEnvironment =
        await args.admitSecretReferenceOverlay();
    } catch (error) {
      throw markExecutionRunStartFailure(error, 'noRunCreated');
    }
  }
  if (requestBoundRunId) {
    const existing = args.runs.get(requestBoundRunId);
    if (existing) return projectExistingExecutionRunStartResult(existing);
  }
  const shouldMaterializeInTranscript = args.params.sessionId !== null
    && profile.transcriptMaterialization !== 'none';
  const sendAcp: ExecutionRunTranscriptPublisher = shouldMaterializeInTranscript
    ? args.sendAcp
    : async () => {};
  const computeSidechainStreamText = createExecutionRunSidechainStreamText(profile);

  const runId = requestBoundRunId ?? `run_${randomUUID()}`;
  const controllerOccurrenceId = randomUUID();
  const callId = `subagent_run_${randomUUID()}`;
  const sidechainId = callId;
  const requestedConfiguration = projectExecutionRunRequestedConfiguration({
    modelId: args.params.teamCredentialModel?.modelId ?? args.params.modelSelection?.modelId ?? args.params.modelId,
    sessionConfigOptionOverrides: args.params.sessionConfigOptionOverrides,
  });
  const startResult: ExecutionRunStartResult = {
    runId,
    callId,
    sidechainId,
    ...(requestedConfiguration ? { requestedConfiguration } : {}),
  };

  const depth = args.params.workDepth ?? 0;

  const startedAtMs = args.getNowMs();
  const backendId = resolveExecutionRunRuntimeBackendId(args.params.backendTarget);
  const {
    profileSourceCustody: startProfileSourceCustody,
    ...startParams
  } = omitExecutionRunRoleCompositionContext(args.params);
  const profileId =
    typeof args.params.profileId === 'string' && args.params.profileId.trim().length > 0
      ? args.params.profileId.trim()
      : null;
  const runtimeSettings = resolveExecutionRunRuntimeSettings({
    accountSettings: args.params.accountSettings,
  });
  // Immutable launch record (LC-F2): the re-resolvable launch intent captured once at start so every
  // backend recreation on resume rebuilds with the SAME model, config overrides, and connected-service
  // selection instead of a bare, defaulted backend. Only safe re-resolvable inputs — never env/secrets.
  const launchModelId =
    typeof args.params.modelId === 'string' && args.params.modelId.trim().length > 0
      ? args.params.modelId.trim()
      : undefined;
  const launch = {
    ...(args.params.cwd ? { cwd: args.params.cwd } : {}),
    ...(args.params.mcpSelection ? { mcpSelection: args.params.mcpSelection } : {}),
    ...(args.params.acpSessionModeId ? { acpSessionModeId: args.params.acpSessionModeId } : {}),
    ...(args.params.runtimeDescriptorV1
      ? { runtimeDescriptorV1: args.params.runtimeDescriptorV1 }
      : {}),
    ...(args.params.launchOrigin ? { launchOrigin: args.params.launchOrigin } : {}),
    ...(launchModelId ? { modelId: launchModelId } : {}),
    ...(args.params.modelSelection
      ? { modelSelection: args.params.modelSelection }
      : {}),
    ...(args.params.teamCredentialModel
      ? { teamCredentialModel: args.params.teamCredentialModel }
      : {}),
    ...(args.params.sessionConfigOptionOverrides
      ? { sessionConfigOptionOverrides: args.params.sessionConfigOptionOverrides }
      : {}),
    ...(args.params.connectedServices !== undefined
      ? { connectedServicesSelection: args.params.connectedServices }
      : {}),
    ...(args.params.secretReferenceOverlay
      ? { secretReferenceOverlay: args.params.secretReferenceOverlay }
      : {}),
  };
  const acquiredBudget = args.params.intent === 'scm_commit_message'
    ? args.budgetRegistry?.tryAcquireOneShotTask(runId, 'scm_commit_message') ?? true
    : args.budgetRegistry?.tryAcquireExecutionRun(runId, args.params.intent) ?? true;
  if (!acquiredBudget) {
    const err = markExecutionRunStartFailure(Object.assign(new Error('Execution run budget exceeded'), {
      code: 'execution_run_budget_exceeded',
    }), 'noRunCreated');
    throw err;
  }

  let backendBeforeControllerRegistration: ExecutionRunHostRuntime | null = null;
  let registeredController: ExecutionRunController | null = null;
  let retainedInitialPendingCustodyAttempted = false;
  let retainedInitialPendingCustodyOutcomeUnknown = false;
  const notifyParentOnCompletion = args.params.notifyParentOnCompletion
    ?? resolveExecutionRunNotifyParentDefaultV1({
      runClass: args.params.runClass,
      accountDefault: args.params.accountSettings?.executionRunsNotifyParentOnCompletionDefault === true,
    });

  try {
    args.runs.set(runId, {
      runId,
      callId,
      sidechainId,
      sessionId: args.params.sessionId,
      depth,
      intent: args.params.intent,
      ...(args.params.roleId ? { roleId: args.params.roleId } : {}),
      ...(args.params.launchProfileId ? { launchProfileId: args.params.launchProfileId } : {}),
      ...(profileId ? { profileId } : {}),
      ...(args.params.profileSourceCustody
        ? { profileSourceCustody: args.params.profileSourceCustody }
        : {}),
      backendTarget: args.params.backendTarget,
      backendId,
      instructions: args.params.instructions ?? '',
      ...(typeof args.params.intentInput !== 'undefined' ? { intentInput: args.params.intentInput } : {}),
      ...(args.params.display ? { display: args.params.display } : {}),
      permissionMode: args.params.permissionMode,
      workspaceWrites: args.params.workspaceWrites,
      retentionPolicy: args.params.retentionPolicy,
      runClass: args.params.runClass,
      ioMode: args.params.ioMode,
      notifyParentOnCompletion,
      ...(runtimeSettings ? { runtimeSettings } : {}),
      ...(Object.keys(launch).length > 0 ? { launch } : {}),
      status: 'running',
      startedAtMs,
      resumeHandle: null,
    });
    args.onPublicStateUpdated?.(runId);

    // Retain the admitted launch before any provider effect, independently of
    // best-effort machine visibility. The same owner handles later checkpoints.
    await args.writeActivityMarker(runId, args.getNowMs(), { force: true });

    // Persist a daemon-visible marker so machine-wide UIs can see the run immediately.
    const startMarkerPayload = {
      pid: process.pid,
      happySessionId: args.params.sessionId,
      runId,
      callId,
      sidechainId,
      intent: args.params.intent,
      backendTarget: readBackendTargetRefV2(args.params.backendTarget),
      ...(args.params.launchOrigin ? { launchOrigin: args.params.launchOrigin } : {}),
      ...(requestedConfiguration ? { requestedConfiguration } : {}),
      permissionMode: args.params.permissionMode,
      retentionPolicy: args.params.retentionPolicy,
      runClass: args.params.runClass,
      ioMode: args.params.ioMode,
      status: 'running',
      ...(notifyParentOnCompletion ? { notifyParentOnCompletion: true } : {}),
      startedAtMs,
      updatedAtMs: startedAtMs,
    } as const;
    await args.enqueueMarkerWrite(runId, () => writeExecutionRunMarker(startMarkerPayload)).catch(() => {});
    if (args.runs.get(runId)?.status !== 'running') {
      return startResult;
    }

    // Materialize the run in transcript (tool-call).
    if (shouldMaterializeInTranscript) {
      await sendAcp(args.parentProvider, {
        type: 'tool-call',
        callId,
        name: 'SubAgentRun',
        input: {
          runId,
          intent: args.params.intent,
          backendTarget: args.params.backendTarget,
          instructions: args.params.instructions ?? '',
          ...(typeof args.params.intentInput !== 'undefined' ? { intentInput: args.params.intentInput } : {}),
          ...(args.params.display ? { display: args.params.display } : {}),
          ...(args.params.launchOrigin ? { launchOrigin: args.params.launchOrigin } : {}),
          ...(requestedConfiguration ? { requestedConfiguration } : {}),
          permissionMode: args.params.permissionMode,
          retentionPolicy: args.params.retentionPolicy,
          runClass: args.params.runClass,
          ioMode: args.params.ioMode,
        },
        id: randomUUID(),
      });
      if (args.runs.get(runId)?.status !== 'running') {
        return startResult;
      }
    }

    const initialPublication = args.params.runClass === 'bounded'
      ? await profile.onStarted?.({ start: args.runs.get(runId)!, rawText: '', finishedAtMs: args.getNowMs() }) : null;
    if (args.runs.get(runId)?.status !== 'running') return startResult;
    if (initialPublication) {
      const finishedAtMs = args.getNowMs();
      const status = initialPublication.status;
      await args.finishRun(
        runId,
        {
          status,
          summary: initialPublication.summary,
          finishedAtMs,
          ...(status === 'failed'
            ? { error: { code: 'cached_diff_summary_failed', message: 'Cached diff summary failure restored.' } }
            : {}),
        },
        { output: initialPublication.toolResultOutput, meta: initialPublication.toolResultMeta },
        initialPublication.structuredMeta,
      );
      return startResult;
    }

    if (args.params.intent === 'voice_agent' && args.params.ioMode === 'streaming') {
      let resolveTerminal!: () => void;
      const terminalPromise = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });

      const epochRaw = Number(args.params.transcript?.epoch ?? 0);
      const epoch = Number.isFinite(epochRaw) && epochRaw >= 0 ? Math.floor(epochRaw) : 0;
      const persistenceMode = args.params.transcript?.persistenceMode === 'persistent' ? 'persistent' : 'ephemeral';

      const permissionIntent = permissionMode(args.params.permissionMode);
      const initialContext = [String(args.params.initialContext ?? '').trim(), String(args.params.instructions ?? '').trim()]
        .filter((t) => t.length > 0)
        .join('\n\n');

      const chatModelId = normalizeVoiceAgentModelId(args.params.chatModelId);
      const commitModelId = normalizeVoiceAgentModelId(args.params.commitModelId);
      const voiceIntentInput = ExecutionRunVoiceAgentIntentInputV1Schema.safeParse(args.params.intentInput ?? {});
      if (!voiceIntentInput.success) {
        throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Invalid Voice Agent intent input');
      }
      const chatModelSelection = args.params.modelSelection;
      const commitModelSelection = voiceIntentInput.data.commitModelSelection;
      const voicePolicy = voiceIntentInput.data.voicePolicy;
      const commitIsolation = args.params.commitIsolation === true;
      const idleTtlSeconds = typeof args.params.idleTtlSeconds === 'number' ? args.params.idleTtlSeconds : 600;
      const initialContextMode = args.params.initialContextMode === 'first_turn' ? 'first_turn' : 'bootstrap';
      const verbosity = args.params.verbosity === 'balanced' ? 'balanced' : 'short';
      const bootstrapMode = args.params.bootstrapMode === 'ready_handshake' ? 'ready_handshake' : 'none';
      const bootstrapTimeoutMs =
        typeof args.params.bootstrapTimeoutMs === 'number' && Number.isFinite(args.params.bootstrapTimeoutMs) && args.params.bootstrapTimeoutMs > 0
          ? Math.floor(args.params.bootstrapTimeoutMs)
          : undefined;
      const disabledActionIds = Array.isArray(args.params.disabledActionIds)
        ? args.params.disabledActionIds.map((value) => String(value ?? '').trim()).filter(Boolean)
        : [];

      // Register the accepted Voice run before entering provider provisioning.
      // VoiceAgentManager claims the same stable id synchronously, so stop can
      // reach that exact start occurrence while provision/READY awaits are live.
      const ctrl: ExecutionRunVoiceAgentController = {
        kind: 'voice_agent',
        controllerOccurrenceId,
        voiceAgentId: runId,
        cancelled: false,
        lastMarkerWriteAtMs: 0,
        terminalPromise,
        resolveTerminal,
        transcript: { persistenceMode, epoch },
        externalStreamIdByInternal: new Map(),
        internalStreamIdByExternal: new Map(),
        pendingTranscriptTurnByExternalStreamId: new Map(),
        terminalReadByExternalStreamId: new Map(),
        readInFlightByExternalStreamId: new Map(),
      };
      args.controllers.set(runId, ctrl);
      registeredController = ctrl;

      const startedVoice = await args.voiceAgentManager.start({
        voiceAgentId: runId,
        backendTarget: args.params.backendTarget,
        ...(profileId ? { profileId } : {}),
        ...(args.params.connectedServices !== undefined ? { connectedServices: args.params.connectedServices } : {}),
        contextSessionId: args.params.sessionId,
        chatModelId,
        commitModelId,
        ...(chatModelSelection ? { chatModelSelection } : {}),
        ...(commitModelSelection ? { commitModelSelection } : {}),
        ...(args.params.sessionConfigOptionOverrides
          ? { sessionConfigOptionOverrides: args.params.sessionConfigOptionOverrides }
          : {}),
        commitIsolation,
        permissionIntent,
        idleTtlSeconds,
        initialContext,
        initialContextMode,
        ...(voicePolicy ? { voicePolicy } : {}),
        verbosity,
        bootstrapMode,
        ...(typeof bootstrapTimeoutMs === 'number' ? { bootstrapTimeoutMs } : {}),
        disabledActionIds,
      }, {
        createRuntime: ({
          backendTarget,
          backendId: runtimeBackendId,
          modelId,
          modelSelection,
          sessionConfigOptionOverrides,
          permissionIntent,
          start,
          connectedServices,
        }) => {
          try {
            return args.createRuntime({
              runId,
              controllerOccurrenceId,
              backendId: runtimeBackendId,
              backendTarget,
              modelId,
              ...(modelSelection ? { modelSelection } : {}),
              ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
              ...(args.params.secretReferenceOverlay
                ? { secretReferenceOverlay: args.params.secretReferenceOverlay }
                : {}),
              ...(initialSecretReferenceEnvironment
                ? { secretReferenceEnvironment: initialSecretReferenceEnvironment }
                : {}),
              permissionMode: permissionIntent,
              workspaceWrites: args.params.workspaceWrites,
              ...(args.params.causalPermissionAuthority
                ? { causalPermissionAuthority: args.params.causalPermissionAuthority }
                : {}),
              start: {
                ...startParams,
                profileId: profileId ?? undefined,
                ...(startProfileSourceCustody
                  ? { profileSourceCustody: startProfileSourceCustody }
                  : {}),
                ...(start ?? {}),
              },
              ...(connectedServices !== undefined ? { connectedServices } : {}),
            });
          } catch (error) {
            if (error instanceof VoiceAgentError) {
              throw error;
            }
            throw new VoiceAgentError(
              'VOICE_AGENT_UNSUPPORTED',
              error instanceof Error ? error.message : 'voice agent backend unavailable',
            );
          }
        },
      });
      if (
        args.runs.get(runId)?.status !== 'running'
        || !isExecutionRunControllerCurrent({ runId, controller: ctrl, controllers: args.controllers })
      ) {
        try {
          await args.voiceAgentManager.stop({ voiceAgentId: startedVoice.voiceAgentId });
        } catch {
          // best effort
        }
        return startResult;
      }

      const resumeHandle = args.voiceAgentManager.getResumeHandle(startedVoice.voiceAgentId);
      const existing = args.runs.get(runId);
      if (existing) {
        args.runs.set(runId, {
          ...existing,
          resumeHandle: resumeHandle ?? existing.resumeHandle ?? null,
          voiceAgentConfig: {
            ...(profileId ? { profileId } : {}),
            chatModelId,
            commitModelId,
            ...(chatModelSelection ? { chatModelSelection } : {}),
            ...(commitModelSelection ? { commitModelSelection } : {}),
            commitIsolation,
            permissionIntent,
            idleTtlSeconds,
            initialContext,
            initialContextMode,
            ...(voicePolicy ? { voicePolicy } : {}),
            verbosity,
            ...(typeof bootstrapTimeoutMs === 'number' ? { bootstrapTimeoutMs } : {}),
            disabledActionIds,
            transcript: { persistenceMode, epoch },
          },
        });
        args.onPublicStateUpdated?.(runId);
      }

      await args.writeActivityMarker(runId, args.getNowMs(), { force: true }).catch(() => {});
      return startResult;
    }

    let ctrl: ExecutionRunBackendController | null = null;
    const backend = args.createRuntime({
      runId,
      controllerOccurrenceId,
      callId,
      sidechainId,
      backendId,
      backendTarget: args.params.backendTarget,
      permissionMode: args.params.permissionMode,
      workspaceWrites: args.params.workspaceWrites,
      ...(args.params.causalPermissionAuthority
        ? { causalPermissionAuthority: args.params.causalPermissionAuthority }
        : {}),
      ...(typeof args.params.modelId === 'string' && args.params.modelId.trim().length > 0
        ? { modelId: args.params.modelId }
        : {}),
      ...(args.params.modelSelection
        ? { modelSelection: args.params.modelSelection }
        : {}),
      ...(args.params.teamCredentialModel
        ? { teamCredentialModel: args.params.teamCredentialModel }
        : {}),
      ...(args.params.sessionConfigOptionOverrides
        ? { sessionConfigOptionOverrides: args.params.sessionConfigOptionOverrides }
        : {}),
      ...(args.params.secretReferenceOverlay
        ? { secretReferenceOverlay: args.params.secretReferenceOverlay }
        : {}),
      ...(initialSecretReferenceEnvironment
        ? { secretReferenceEnvironment: initialSecretReferenceEnvironment }
        : {}),
      accountSettings: args.params.accountSettings ?? null,
      ...(args.params.connectedServices !== undefined
        ? { connectedServices: args.params.connectedServices }
        : {}),
      ...(args.params.connectedServicesDefaultServiceIds && args.params.connectedServicesDefaultServiceIds.length > 0
        ? { connectedServicesDefaultServiceIds: args.params.connectedServicesDefaultServiceIds }
        : {}),
      start: {
        ...startParams,
        profileId: profileId ?? undefined,
        ...(startProfileSourceCustody
          ? { profileSourceCustody: startProfileSourceCustody }
          : {}),
        observeWorkflowUsage: ({ turnId, observation }) => {
          const current = ctrl;
          const binding = current?.workflowObservation;
          const inputTurn = current?.currentInputTurn;
          if (!current || !binding || !inputTurn) return;
          if (!inputTurn.inputIds.includes(binding.localInputId)) return;
          if (turnId !== null && turnId !== inputTurn.turnId) return;
          binding.usage.observe(observation);
          const usage = binding.usage.current();
          if (!usage) return;
          current.pendingHostBarrier = appendExecutionRunControllerHostBarrier(
            current.pendingHostBarrier,
            () => binding.sink.commit({
              kind: 'usage',
              runId,
              localInputId: binding.localInputId,
              usage,
            }),
          );
        },
      },
    });
    backendBeforeControllerRegistration = backend;
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    ctrl = {
      kind: 'backend',
      ...(args.params.workflowRunId ? { workflowRunId: args.params.workflowRunId } : {}),
      controllerOccurrenceId,
      backend,
      backendSupportsResume: false,
      runtimeId: null,
      buffer: '',
      sidechainStreamBuffer: '',
      sidechainStreamKey: '',
      streamWriter:
        shouldMaterializeInTranscript && args.streamedTranscriptSession && args.params.ioMode === 'streaming'
          ? createStreamedTranscriptWriter({
              provider: args.parentProvider,
              session: args.streamedTranscriptSession,
            })
          : null,
      cancelled: false,
      turnCount: 0,
      turnEpoch: 0,
      turnInFlight: false,
      turnCancelReason: null,
      turnCancelEpoch: null,
      admittedLiveInterventions: [],
      admittedLiveInterventionsSignal: null,
      lastMarkerWriteAtMs: 0,
      failureSignal: failureSignal(),
      pendingHostBarrier: Promise.resolve(),
      ...(args.params.workflowObservationSink && args.params.localInputId
        ? {
            workflowObservation: {
              workflowRunId: args.params.workflowObservationSink.workflowRunId,
              localInputId: args.params.localInputId,
              sink: args.params.workflowObservationSink,
              usage: createExactTurnUsageAccumulator(),
            },
          }
        : {}),
      terminalPromise,
      resolveTerminal,
    };
    args.controllers.set(runId, ctrl);
    registeredController = ctrl;
    backendBeforeControllerRegistration = null;
    // A lazy host runtime may have to spawn/connect to the native backend before it can
    // answer its resume capabilities. The run is already accepted and registered, so keep
    // that optional discovery inside controller-owned provisioning instead of withholding
    // the recovery handle from the caller.
    const backendReadinessPromise = (async (): Promise<Readonly<{
      backendSupportsResume: boolean;
      backendSupportsInitialResume: boolean;
    }> | null> => {
        const supportsInitialResume = await backend.readResumeSupport();
        const supportsResume = args.params.runClass === 'long_lived'
          ? await backend.readResumeSupport({ captureReplay: true })
          : supportsInitialResume;
        if (!isExecutionRunControllerCurrent({ runId, controller: ctrl, controllers: args.controllers })) {
          await settleExecutionRunController({ runId, controller: ctrl, controllers: args.controllers });
          return null;
        }
        ctrl.backendSupportsResume = supportsResume;

        const onMessage = createExecutionRunControllerMessageHandler({
          ctrl,
          runId,
          sidechainId,
          ioMode: args.params.ioMode,
          computeSidechainStreamText,
          sendAcp,
          parentProvider: args.parentProvider,
          runs: args.runs,
          backendSupportsResume: supportsResume,
          writeActivityMarker: args.writeActivityMarker,
          getNowMs: args.getNowMs,
          getPermissionRequestStore: args.getPermissionRequestStore,
          onPublicStateUpdated: args.onPublicStateUpdated,
        });

        backend.subscribeMessages(onMessage);
        return {
          backendSupportsResume: supportsResume,
          backendSupportsInitialResume: supportsInitialResume,
        };
      })();
    // Synchronous retained-input custody may still reject the start call before the
    // controller-owned provisioning branch consumes readiness. Observe that concurrent
    // rejection immediately; the owning branch still awaits and handles the same promise.
    void backendReadinessPromise.catch(() => undefined);

    if (args.params.runClass === 'bounded') {
      // Provision the backend session and run kickoff asynchronously so the caller can dismiss
      // the UI draft card immediately after the SubAgentRun tool-call is injected.
      void (async () => {
        try {
          const readiness = await backendReadinessPromise;
          if (!readiness) return;
          const { backendSupportsResume, backendSupportsInitialResume } = readiness;
          const runtimeId = await (async () => {
            const handle = args.params.retentionPolicy === 'resumable' ? (args.params.resumeHandle ?? null) : null;
            const wantsResume =
              handle?.kind === 'provider_session.v1' && areExecutionRunBackendTargetsEqual(handle.backendTarget, args.params.backendTarget)
                ? handle.providerSessionId
                : null;
            if (wantsResume) {
              if (!backendSupportsInitialResume) {
                const err: any = new Error('Backend does not support resume');
                err.code = 'execution_run_not_allowed';
                throw err;
              }
              const loaded = await backend.provisionRuntime({ resumeRuntimeId: wantsResume });
              return loaded.runtimeId;
            }
            const started = await backend.provisionRuntime();
            return started.runtimeId;
          })();

          // Stop may settle and remove this controller while backend provisioning is still in
          // flight. A runtime that appears afterwards must not receive the queued prompt or escape
          // the stopped run's lifecycle.
          if (await retireProvisionedRuntimeWithoutDispatch({
            runId,
            runtimeId,
            controller: ctrl,
            controllers: args.controllers,
          })) {
            return;
          }
          ctrl.runtimeId = runtimeId;

          const existing = args.runs.get(runId);
          const providerSessionId = readBackendResumableRuntimeId(ctrl, existing?.resumeHandle);
          if (existing && args.params.retentionPolicy === 'resumable' && backendSupportsResume && providerSessionId) {
              args.runs.set(runId, {
                ...existing,
                resumeHandle: { kind: 'provider_session.v1', backendTarget: readBackendTargetRefV2(args.params.backendTarget), providerSessionId },
              });
            void args.writeActivityMarker(runId, args.getNowMs(), { force: true }).catch(() => {});
            args.onPublicStateUpdated?.(runId);
          }

          void args
            .executeBoundedRun({ runId, callId, sidechainId, startedAtMs, params: startParams })
            .finally(async () => {
              // Converge with stop/disposal even if executeBoundedRun throws before its own settlement.
              await settleExecutionRunController({ runId, controller: ctrl, controllers: args.controllers });
            });
        } catch (e: any) {
          const message = e instanceof Error ? e.message : 'Execution failed';
          const finishedAtMs = args.getNowMs();
          const code = e instanceof VoiceAgentError ? e.code : 'execution_run_failed';
          try {
            await args.finishRun(
              runId,
              { status: 'failed', summary: message, finishedAtMs, error: { code, message } },
              {
                output: {
                  status: 'failed',
                  summary: message,
                  runId,
                  callId,
                  sidechainId,
                  backendId,
                  intent: args.params.intent,
                  startedAtMs,
                  finishedAtMs,
                  error: { code, message },
                },
                isError: true,
              },
            );
          } catch {
            // best effort
          }
          await settleExecutionRunController({ runId, controller: ctrl, controllers: args.controllers });
        }
      })();

      return startResult;
    }

    const initialInstructions = args.params.initialInput?.kind !== 'deferred_session_pending' && typeof args.params.instructions === 'string'
      ? args.params.instructions
      : '';
    const retainedInitialInputLocalId = args.params.localInputId ?? `execution-run-initial:${runId}`;
    const retainedSessionInputWasKnownAtStart = ctrl.backend.interaction != null && args.params.sessionId != null;
    let retainedInitialPendingCustodyError: unknown;
    let retainedInitialPendingCustodyFailed = false;
    const createRetainedInitialAdmissionError = (
      disposition: Extract<SessionInputAdmissionResultV1, Readonly<{ status: 'rejected' | 'outcomeUnknown' }>>,
    ): Error & { definitiveAdmissionRejection?: true } => Object.assign(
      new Error(`Initial Session input admission ${disposition.status}: ${disposition.code}`),
      disposition.status === 'rejected'
        ? { code: disposition.code, definitiveAdmissionRejection: true as const }
        : { code: disposition.code },
    );
    const recordRetainedInitialPendingOutcomeUnknown = (error: unknown): void => {
      const current = args.runs.get(runId);
      if (!current) return;
      const message = error instanceof Error ? error.message : 'Initial Session input admission outcome is unknown';
      args.runs.set(runId, {
        ...current,
        summary: message,
        error: { code: 'execution_run_initial_input_outcome_unknown', message },
      });
      args.onPublicStateUpdated?.(runId);
    };
    if (initialInstructions.trim().length > 0 && retainedSessionInputWasKnownAtStart) {
      retainedInitialPendingCustodyAttempted = true;
      if (!args.enqueueRetainedRunInitialInput) {
        throw new Error('Canonical target-aware Session input admission is unavailable');
      }
      try {
        const disposition = await args.enqueueRetainedRunInitialInput({
          runId,
          text: initialInstructions,
          localId: retainedInitialInputLocalId,
          requestedAction: { v: 1, kind: 'enqueue' },
        });
        if (disposition.status === 'rejected' || disposition.status === 'outcomeUnknown') {
          throw createRetainedInitialAdmissionError(disposition);
        }
      } catch (error: unknown) {
        if ((error as { definitiveAdmissionRejection?: unknown } | null)?.definitiveAdmissionRejection === true) {
          throw error;
        }
        retainedInitialPendingCustodyFailed = true;
        retainedInitialPendingCustodyOutcomeUnknown = true;
        retainedInitialPendingCustodyError = error;
        recordRetainedInitialPendingOutcomeUnknown(error);
      }
    }
    const provisioningPromise = (async (): Promise<void> => {
      try {
        const readiness = await backendReadinessPromise;
        if (!readiness) return;
        const { backendSupportsResume, backendSupportsInitialResume } = readiness;
        const usesRetainedSessionInput = ctrl.backend.interaction != null && args.params.sessionId != null;
        if (
          initialInstructions.trim().length > 0
          && usesRetainedSessionInput
          && !retainedSessionInputWasKnownAtStart
        ) {
          if (!args.enqueueRetainedRunInitialInput) {
            throw new Error('Canonical target-aware Session input admission is unavailable');
          }
          try {
            const disposition = await args.enqueueRetainedRunInitialInput({
              runId,
              text: initialInstructions,
              localId: retainedInitialInputLocalId,
              requestedAction: { v: 1, kind: 'enqueue' },
            });
            if (disposition.status === 'rejected' || disposition.status === 'outcomeUnknown') {
              throw createRetainedInitialAdmissionError(disposition);
            }
          } catch (error: unknown) {
            if ((error as { definitiveAdmissionRejection?: unknown } | null)?.definitiveAdmissionRejection === true) {
              throw error;
            }
            retainedInitialPendingCustodyOutcomeUnknown = true;
            // The caller already owns the exact run handle, while the Session admission
            // boundary cannot distinguish not-sent from acknowledged-with-lost-response.
            // Keep this occurrence recoverable and surface the ambiguity on its running
            // projection; never start a replacement or terminalize a possibly queued input.
            recordRetainedInitialPendingOutcomeUnknown(error);
          }
        }
        const runtimeId = await (async () => {
          const handle = args.params.retentionPolicy === 'resumable' ? (args.params.resumeHandle ?? null) : null;
          const wantsResume =
            handle?.kind === 'provider_session.v1' && areExecutionRunBackendTargetsEqual(handle.backendTarget, args.params.backendTarget)
              ? handle.providerSessionId
              : null;
          if (wantsResume) {
            if (!backendSupportsInitialResume) {
              const error: Error & { code?: string } = new Error('Backend does not support resume');
              error.code = 'execution_run_not_allowed';
              throw error;
            }
            const loaded = await backend.provisionRuntime({ resumeRuntimeId: wantsResume });
            return loaded.runtimeId;
          }
          const started = await backend.provisionRuntime();
          return started.runtimeId;
        })();
        if (await retireProvisionedRuntimeWithoutDispatch({
          runId,
          runtimeId,
          controller: ctrl,
          controllers: args.controllers,
        })) {
          return;
        }
        ctrl.runtimeId = runtimeId;

        // Seed validated saved output before exposing the retained input target.
        // Its first accepted continuation reads this same profile publication.
        if (profile.onStarted) {
          await publishExecutionRunTurn({ runId, turnId: '', rawText: '', started: true,
            finishedAtMs: args.getNowMs(), controller: ctrl, controllers: args.controllers, runs: args.runs,
            profileCatalog: args.profileCatalog, sendAcp, parentProvider: args.parentProvider,
            onPublicStateUpdated: args.onPublicStateUpdated });
        }
        // Saved publication may await disk and transcript transport. Stop can
        // retire this exact occurrence during either await; do not attach a new
        // input consumer or publish resume support after it was retired.
        if (ctrl.cancelled || args.runs.get(runId)?.status !== 'running'
          || !isExecutionRunControllerCurrent({ runId, controller: ctrl, controllers: args.controllers })) return;

        // Only the retained Session-owned occurrence consumes canonical Pending.
        // Detached runs retain the direct execution.run.send boundary below.
        if (usesRetainedSessionInput) {
          const attachment = args.attachRetainedRunSessionInput?.({
            runId,
            sidechainId,
            controller: ctrl,
          }) ?? null;
          ctrl.releaseSessionInputAttachment = attachment?.release;
          if (initialInstructions.trim().length > 0) {
            const admission = attachment
              ? attachment.awaitInputAdmission(retainedInitialInputLocalId)
              : Promise.resolve('unknown' as const);
            ctrl.initialPendingInputAdmission = admission.then((outcome) => {
              if (
                outcome !== 'unknown'
                && isExecutionRunControllerCurrent({
                  runId,
                  controller: ctrl,
                  controllers: args.controllers,
                })
              ) {
                const current = args.runs.get(runId);
                if (current?.error?.code === 'execution_run_initial_input_outcome_unknown') {
                  args.runs.set(runId, {
                    ...current,
                    ...(current.summary === current.error.message ? { summary: undefined } : {}),
                    error: undefined,
                  });
                  args.onPublicStateUpdated?.(runId);
                }
              }
              return outcome;
            });
          }
        }

        if (
          usesRetainedSessionInput
          && initialInstructions.trim().length > 0
          && retainedInitialPendingCustodyOutcomeUnknown
          && args.enqueueRetainedRunInitialInput
        ) {
          try {
            const disposition = await args.enqueueRetainedRunInitialInput({
              runId,
              text: initialInstructions,
              localId: retainedInitialInputLocalId,
              requestedAction: { v: 1, kind: 'enqueue' },
            });
            if (disposition.status === 'rejected') {
              throw createRetainedInitialAdmissionError(disposition);
            }
          } catch (error: unknown) {
            if ((error as { definitiveAdmissionRejection?: unknown } | null)?.definitiveAdmissionRejection === true) {
              throw error;
            }
            // The first ambiguous admission already published the diagnostic.
            // Do not rewrite it after attachment: the exact durable admission
            // barrier may have accepted and cleared it while this idempotent
            // rejoin was awaiting its response.
          }
        }

        const existing = args.runs.get(runId);
        const providerSessionId = readBackendResumableRuntimeId(ctrl, existing?.resumeHandle);
        if (existing && args.params.retentionPolicy === 'resumable' && backendSupportsResume && providerSessionId) {
          args.runs.set(runId, {
            ...existing,
            resumeHandle: {
              kind: 'provider_session.v1',
              backendTarget: readBackendTargetRefV2(args.params.backendTarget),
              providerSessionId,
            },
          });
          await args.writeActivityMarker(runId, args.getNowMs(), { force: true }).catch(() => {});
          args.onPublicStateUpdated?.(runId);
        }

        if (initialInstructions.trim().length > 0 && !usesRetainedSessionInput) {
          const start = {
            sessionId: args.params.sessionId,
            runId,
            callId,
            sidechainId,
            intent: args.params.intent,
            backendId,
            backendTarget: args.params.backendTarget,
            instructions: initialInstructions,
            ...(args.params.intentInput !== undefined ? { intentInput: args.params.intentInput } : {}),
            ...(args.params.resultContract ? { resultContract: args.params.resultContract } : {}),
            ...(args.params.structuredInput ? { structuredInput: args.params.structuredInput } : {}),
            permissionMode: args.params.permissionMode,
            retentionPolicy: args.params.retentionPolicy,
            runClass: args.params.runClass,
            ioMode: args.params.ioMode,
            startedAtMs,
          } as const;
          const result = await args.send(runId, {
            message: profile.buildPrompt({ ...start, resultContract: undefined }),
            ...(args.params.localInputId ? { localInputId: args.params.localInputId } : {}),
            ...(args.params.resultContract ? { resultContract: args.params.resultContract } : {}),
            ...(args.params.causalPermissionAuthority
              ? { causalPermissionAuthority: args.params.causalPermissionAuthority }
              : {}),
          });
          if (!result.ok) {
            if (result.errorCode === 'execution_run_send_outcome_unknown') {
              // The provider effect may already have happened. The long-lived
              // turn owner keeps exact custody until completion, liveness, or
              // explicit stop settles it; terminalizing here would invite a
              // duplicate replacement input.
              return;
            }
            throw Object.assign(new Error(result.error ?? 'Execution Run initial delivery failed'), {
              code: result.errorCode ?? 'execution_run_failed',
            });
          }
        }
      } catch (error: unknown) {
        if (ctrl.cancelled || !isExecutionRunControllerCurrent({ runId, controller: ctrl, controllers: args.controllers })) {
          await settleExecutionRunController({ runId, controller: ctrl, controllers: args.controllers });
          return;
        }
        const message = error instanceof Error ? error.message : 'Execution failed';
        const finishedAtMs = args.getNowMs();
        const code = error instanceof VoiceAgentError
          ? error.code
          : (error as { code?: unknown } | null)?.code === 'execution_run_not_allowed'
            ? 'execution_run_not_allowed'
            : 'execution_run_failed';
        try {
          await args.finishRun(
            runId,
            { status: 'failed', summary: message, finishedAtMs, error: { code, message } },
            {
              output: {
                status: 'failed',
                summary: message,
                runId,
                callId,
                sidechainId,
                backendId,
                intent: args.params.intent,
                startedAtMs,
                finishedAtMs,
                error: { code, message },
              },
              isError: true,
            },
          );
        } catch {
          // best effort
        }
        await settleExecutionRunController({ runId, controller: ctrl, controllers: args.controllers });
      }
    })();
    ctrl.provisioningPromise = provisioningPromise;
    void provisioningPromise;

    if (retainedInitialPendingCustodyFailed) {
      throw retainedInitialPendingCustodyError;
    }

    return startResult;
  } catch (e: any) {
    if (registeredController?.cancelled) {
      await settleExecutionRunController({
        runId,
        controller: registeredController,
        controllers: args.controllers,
      });
      return startResult;
    }
    // The retained Run already exists before its initial canonical Pending
    // admission. An outcome-unknown enqueue must leave that exact Run and
    // durable input identity available for normal observation/rejoin;
    // terminalizing here would turn a lost response into a blocked target and
    // encourage a duplicate Run start. A typed definitive rejection follows
    // normal failure settlement below.
    if (retainedInitialPendingCustodyAttempted && retainedInitialPendingCustodyOutcomeUnknown) {
      throw markExecutionRunStartFailure(e, 'outcomeUnknown');
    }
    args.budgetRegistry?.releaseExecutionRun(runId);
    const message = e instanceof Error ? e.message : 'Execution failed';
    const finishedAtMs = args.getNowMs();
    const code = e instanceof VoiceAgentError ? e.code : 'execution_run_failed';
    try {
      await args.finishRun(
        runId,
        { status: 'failed', summary: message, finishedAtMs, error: { code, message } },
        {
          output: {
            status: 'failed',
            summary: message,
            runId,
            callId,
            sidechainId,
            backendId,
            intent: args.params.intent,
            startedAtMs,
            finishedAtMs,
            error: { code, message },
          },
          isError: true,
        },
      );
    } catch {
      // best effort
    }
    const ctrl = registeredController;
    if (ctrl) {
      if (ctrl.kind === 'voice_agent') {
        try {
          await args.voiceAgentManager.stop({ voiceAgentId: ctrl.voiceAgentId });
        } catch {
          // best effort
        }
      }
      await settleExecutionRunController({ runId, controller: ctrl, controllers: args.controllers });
    } else if (backendBeforeControllerRegistration) {
      try {
        await backendBeforeControllerRegistration.dispose();
      } catch {
        // best effort
      }
    }
    throw markExecutionRunStartFailure(e, 'outcomeUnknown');
  }
}

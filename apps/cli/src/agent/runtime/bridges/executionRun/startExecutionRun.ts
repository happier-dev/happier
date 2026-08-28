import { randomUUID } from 'node:crypto';

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
  type ConnectedServiceBindingsV1,
  type ProviderBoundModelRef,
  type SessionInputCausalPermissionAuthorityV1,
  withExecutionRunStartFailureDetails,
} from '@happier-dev/protocol';
import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';
import type {
  ExecutionRunManagerStartParams,
  ExecutionRunStartResult,
  ExecutionRunState,
} from './executionRunTypes';
import type {
  ExecutionRunBackendController,
  ExecutionRunController,
  ExecutionRunVoiceAgentController,
} from '@/agent/executionRuns/controllers/types';
import { failureSignal } from '@/agent/executionRuns/controllers/failureSignal';
import { VoiceAgentError, type VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { writeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { createStreamedTranscriptWriter, type StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import { createExecutionRunControllerMessageHandler } from './messages/sessionStateEmission';
import { createExecutionRunSidechainStreamText } from './sidechainStreamText';
import {
  areExecutionRunBackendTargetsEqual,
  resolveExecutionRunRuntimeBackendId,
} from './backendTargets';
import { readBackendTargetRefV2 } from '@happier-dev/protocol';
import type { ExecutionRunPermissionRequestStoreProvider } from './executionRunPermissionResponseTarget';
import { resolveExecutionRunRuntimeSettings } from './runtimeSettings';
import { permissionMode } from '@/agent/executionRuns/policy/permissionMode';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import { settleExecutionRunController } from './settleExecutionRunController';

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

function readScmDiffSummaryCachedOutput(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.intent !== 'scm_diff_summary') return null;
  const intentInput = record.intentInput;
  if (!intentInput || typeof intentInput !== 'object' || Array.isArray(intentInput)) return null;
  const inputRecord = intentInput as Readonly<Record<string, unknown>>;
  const cachePolicy = inputRecord.cachePolicy;
  if (cachePolicy && typeof cachePolicy === 'object' && !Array.isArray(cachePolicy)) {
    const cachePolicyRecord = cachePolicy as Readonly<Record<string, unknown>>;
    if (cachePolicyRecord.mode === 'bypass') return null;
  }
  const cachedOutput = inputRecord.cachedOutput;
  if (!cachedOutput || typeof cachedOutput !== 'object' || Array.isArray(cachedOutput)) return null;
  const output = cachedOutput as Record<string, unknown>;
  return typeof output.success === 'boolean' ? output : null;
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

/**
 * QA2-F04: backend session PROVISIONING (process spawn + vendor handshake) must be bounded even
 * when the run itself is unbounded. A backend whose provisionSession never settles otherwise
 * leaves the run "running" forever with no process, no error, and no stop affordance. Generous
 * default: a cold backend CLI boot can take minutes.
 */
const BACKEND_PROVISION_TIMEOUT_ENV_KEY = 'HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS';
const DEFAULT_BACKEND_PROVISION_TIMEOUT_MS = 5 * 60_000;

function readBackendProvisionTimeoutMs(): number {
  const raw = process.env[BACKEND_PROVISION_TIMEOUT_ENV_KEY];
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_BACKEND_PROVISION_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BACKEND_PROVISION_TIMEOUT_MS;
  return Math.min(parsed, 30 * 60_000);
}

export class ExecutionRunBackendProvisionTimeoutError extends Error {
  readonly code = 'execution_run_backend_provision_timeout' as const;

  constructor(params: Readonly<{ backendId: string; timeoutMs: number }>) {
    super(`Execution run backend session provisioning timed out after ${params.timeoutMs}ms (${params.backendId})`);
    this.name = 'ExecutionRunBackendProvisionTimeoutError';
  }
}

async function awaitBackendProvisionBounded<T>(
  provision: Promise<T>,
  backendId: string,
): Promise<T> {
  const timeoutMs = readBackendProvisionTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  const backstop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExecutionRunBackendProvisionTimeoutError({ backendId, timeoutMs })), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([provision, backstop]);
  } finally {
    clearTimeout(timer);
  }
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

type ExecuteBoundedRun = (args: {
  runId: string;
  callId: string;
  sidechainId: string;
  startedAtMs: number;
  params: ExecutionRunManagerStartParams;
}) => Promise<void>;

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
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    modelId?: string;
    modelSelection?: ProviderBoundModelRef;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    connectedServices?: ConnectedServiceBindingsV1 | null;
    connectedServicesDefaultServiceIds?: readonly string[];
    start?: ExecutionRunBackendStartContext;
  }) => ExecutionRunHostRuntime;
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
    params: Readonly<{ message: string; resume?: boolean; delivery?: unknown }>,
  ) => Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  voiceAgentManager: VoiceAgentManager;
  getDepthByCallId: (callId: string) => number | null;
  onPublicStateUpdated?: (runId: string) => void;
}>): Promise<ExecutionRunStartResult> {
  assertPreparedReviewRunStartAllowed(args.params);

  const profile = args.profileCatalog
    ? resolveExecutionRunIntentProfileFromCatalog(args.profileCatalog, args.params.intent, args.params.profileId)
    : resolveExecutionRunIntentProfile(args.params.intent);
  if (args.params.sessionId === null && profile.supportsDetached !== true) {
    throw executionRunNotAllowed(`Execution-run intent '${args.params.intent}' requires a Session scope`);
  }
  const shouldMaterializeInTranscript = args.params.sessionId !== null
    && profile.transcriptMaterialization !== 'none';
  const sendAcp: ExecutionRunTranscriptPublisher = shouldMaterializeInTranscript
    ? args.sendAcp
    : async () => {};
  const computeSidechainStreamText = createExecutionRunSidechainStreamText(profile);

  const runId = `run_${randomUUID()}`;
  const callId = `subagent_run_${randomUUID()}`;
  const sidechainId = callId;

  const depth = (() => {
    const parentRunId = typeof args.params.parentRunId === 'string' ? args.params.parentRunId.trim() : '';
    if (parentRunId) {
      const parent = args.runs.get(parentRunId);
      return parent ? parent.depth + 1 : 0;
    }
    const parentCallId = typeof args.params.parentCallId === 'string' ? args.params.parentCallId.trim() : '';
    if (parentCallId) {
      const parentDepth = args.getDepthByCallId(parentCallId);
      return typeof parentDepth === 'number' ? parentDepth + 1 : 0;
    }
    return 0;
  })();

  const acquiredBudget = args.params.intent === 'scm_commit_message'
    ? args.budgetRegistry?.tryAcquireOneShotTask(runId, 'scm_commit_message') ?? true
    : args.budgetRegistry?.tryAcquireExecutionRun(runId, args.params.intent) ?? true;
  if (!acquiredBudget) {
    const err = markExecutionRunStartFailure(Object.assign(new Error('Execution run budget exceeded'), {
      code: 'execution_run_budget_exceeded',
    }), 'noRunCreated');
    throw err;
  }

  const startedAtMs = args.getNowMs();
  const backendId = resolveExecutionRunRuntimeBackendId(args.params.backendTarget);
  const startParams = args.params;
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
    ...(launchModelId ? { modelId: launchModelId } : {}),
    ...(args.params.modelSelection
      ? { modelSelection: args.params.modelSelection }
      : {}),
    ...(args.params.sessionConfigOptionOverrides
      ? { sessionConfigOptionOverrides: args.params.sessionConfigOptionOverrides }
      : {}),
    ...(args.params.connectedServices !== undefined
      ? { connectedServicesSelection: args.params.connectedServices }
      : {}),
  };
  args.runs.set(runId, {
    runId,
    callId,
    sidechainId,
    sessionId: args.params.sessionId,
    depth,
    intent: args.params.intent,
    ...(profileId ? { profileId } : {}),
    backendTarget: args.params.backendTarget,
    backendId,
    instructions: args.params.instructions ?? '',
    ...(typeof args.params.intentInput !== 'undefined' ? { intentInput: args.params.intentInput } : {}),
    ...(args.params.display ? { display: args.params.display } : {}),
    permissionMode: args.params.permissionMode,
    retentionPolicy: args.params.retentionPolicy,
    runClass: args.params.runClass,
    ioMode: args.params.ioMode,
    ...(runtimeSettings ? { runtimeSettings } : {}),
    ...(Object.keys(launch).length > 0 ? { launch } : {}),
    status: 'running',
    startedAtMs,
    resumeHandle: null,
  });
  args.onPublicStateUpdated?.(runId);

  // Persist a daemon-visible marker so machine-wide UIs can see the run immediately.
  const startMarkerPayload = {
    pid: process.pid,
    happySessionId: args.params.sessionId,
    runId,
    callId,
    sidechainId,
    intent: args.params.intent,
    backendTarget: readBackendTargetRefV2(args.params.backendTarget),
    permissionMode: args.params.permissionMode,
    retentionPolicy: args.params.retentionPolicy,
    runClass: args.params.runClass,
    ioMode: args.params.ioMode,
    status: 'running',
    startedAtMs,
    updatedAtMs: startedAtMs,
  } as const;
  await args.enqueueMarkerWrite(runId, () => writeExecutionRunMarker(startMarkerPayload)).catch(() => {});

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
        permissionMode: args.params.permissionMode,
        retentionPolicy: args.params.retentionPolicy,
        runClass: args.params.runClass,
        ioMode: args.params.ioMode,
      },
      id: randomUUID(),
    });
  }

  const cachedScmDiffSummaryOutput = readScmDiffSummaryCachedOutput(args.params);
  if (cachedScmDiffSummaryOutput) {
    const finishedAtMs = args.getNowMs();
    const status = cachedScmDiffSummaryOutput.success === true ? 'succeeded' : 'failed';
    await args.finishRun(
      runId,
      {
        status,
        summary: status === 'succeeded' ? 'Diff summary restored from cache.' : 'Cached diff summary failure restored.',
        finishedAtMs,
        ...(status === 'failed'
          ? { error: { code: 'cached_diff_summary_failed', message: 'Cached diff summary failure restored.' } }
          : {}),
      },
      { output: cachedScmDiffSummaryOutput, meta: { cache: 'hit' } },
      { kind: 'scm_diff_summary.v1', payload: cachedScmDiffSummaryOutput },
    );
    return { runId, callId, sidechainId };
  }

  let backendBeforeControllerRegistration: ExecutionRunHostRuntime | null = null;
  let registeredController: ExecutionRunController | null = null;

  try {
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
              backendId: runtimeBackendId,
              backendTarget,
              modelId,
              ...(modelSelection ? { modelSelection } : {}),
              ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
              permissionMode: permissionIntent,
              ...(args.params.causalPermissionAuthority
                ? { causalPermissionAuthority: args.params.causalPermissionAuthority }
                : {}),
              ...(start ? { start } : {}),
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
            verbosity,
            ...(typeof bootstrapTimeoutMs === 'number' ? { bootstrapTimeoutMs } : {}),
            disabledActionIds,
            transcript: { persistenceMode, epoch },
          },
        });
        args.onPublicStateUpdated?.(runId);
      }

      const ctrl: ExecutionRunVoiceAgentController = {
        kind: 'voice_agent',
        voiceAgentId: startedVoice.voiceAgentId,
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
      await args.writeActivityMarker(runId, args.getNowMs(), { force: true }).catch(() => {});
      return { runId, callId, sidechainId };
    }

    const backend = args.createRuntime({
      runId,
      backendId,
      backendTarget: args.params.backendTarget,
      permissionMode: args.params.permissionMode,
      ...(args.params.causalPermissionAuthority
        ? { causalPermissionAuthority: args.params.causalPermissionAuthority }
        : {}),
      ...(typeof args.params.modelId === 'string' && args.params.modelId.trim().length > 0
        ? { modelId: args.params.modelId }
        : {}),
      ...(args.params.modelSelection
        ? { modelSelection: args.params.modelSelection }
        : {}),
      ...(args.params.sessionConfigOptionOverrides
        ? { sessionConfigOptionOverrides: args.params.sessionConfigOptionOverrides }
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
      },
    });
    backendBeforeControllerRegistration = backend;
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    // A lazy host runtime may have to spawn/connect to the native backend before it can
    // answer its resume capabilities. Keep that readiness work inside the same bounded
    // provisioning owner; otherwise a backend that never resolves can hang here before
    // provisionSession's timeout is ever installed.
    const [backendSupportsResume, backendSupportsInitialResume] = await awaitBackendProvisionBounded(
      (async () => {
        const supportsResume = await backend.readResumeSupport({
          captureReplay: args.params.runClass === 'long_lived',
        });
        const supportsInitialResume = await backend.readResumeSupport();
        return [supportsResume, supportsInitialResume] as const;
      })(),
      backendId,
    );
    const ctrl: ExecutionRunBackendController = {
      kind: 'backend',
      backend,
      backendSupportsResume,
      childSessionId: null,
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
      pendingExternalMessages: [],
      pendingExternalMessagesSignal: null,
      lastMarkerWriteAtMs: 0,
      failureSignal: failureSignal(),
      pendingHostBarrier: Promise.resolve(),
      terminalPromise,
      resolveTerminal,
    };
    args.controllers.set(runId, ctrl);
    registeredController = ctrl;
    backendBeforeControllerRegistration = null;

    const onMessage = createExecutionRunControllerMessageHandler({
      ctrl,
      runId,
      sidechainId,
      ioMode: args.params.ioMode,
      computeSidechainStreamText,
      sendAcp,
      parentProvider: args.parentProvider,
      runs: args.runs,
      backendSupportsResume,
      writeActivityMarker: args.writeActivityMarker,
      getNowMs: args.getNowMs,
      getPermissionRequestStore: args.getPermissionRequestStore,
      onPublicStateUpdated: args.onPublicStateUpdated,
    });

    backend.subscribeMessages(onMessage);

    if (args.params.runClass === 'bounded') {
      // Provision the backend session and run kickoff asynchronously so the caller can dismiss
      // the UI draft card immediately after the SubAgentRun tool-call is injected.
      void (async () => {
        try {
          // QA2-F04: bound provisioning — a never-settling backend start must fail the run, not
          // leave it "running" forever with no process and no stop affordance.
          const childSessionId = await awaitBackendProvisionBounded((async () => {
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
              const loaded = await backend.provisionSession({ resumeSessionId: wantsResume });
              return loaded.sessionId;
            }
            const started = await backend.provisionSession();
            return started.sessionId;
          })(), backendId);
          ctrl.childSessionId = childSessionId;

          const existing = args.runs.get(runId);
          if (existing && args.params.retentionPolicy === 'resumable' && backendSupportsResume) {
              args.runs.set(runId, {
                ...existing,
                resumeHandle: { kind: 'provider_session.v1', backendTarget: readBackendTargetRefV2(args.params.backendTarget), providerSessionId: childSessionId },
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

      return { runId, callId, sidechainId };
    }

    // Long-lived runs are expected to be usable immediately after start(); await session provisioning
    // so follow-up execution.run.send calls don't race the vendor session startup. Bounded (QA2-F04):
    // a hung provisioning must fail the run instead of hanging start() and leaking a running entry.
    const childSessionId = await awaitBackendProvisionBounded((async () => {
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
        const loaded = await backend.provisionSession({
          resumeSessionId: wantsResume,
        });
        return loaded.sessionId;
      }
      const started = await backend.provisionSession();
      return started.sessionId;
    })(), backendId);
    ctrl.childSessionId = childSessionId;

    const existing = args.runs.get(runId);
    if (existing && args.params.retentionPolicy === 'resumable' && backendSupportsResume) {
      args.runs.set(runId, {
        ...existing,
        resumeHandle: { kind: 'provider_session.v1', backendTarget: readBackendTargetRefV2(args.params.backendTarget), providerSessionId: childSessionId },
      });
      await args.writeActivityMarker(runId, args.getNowMs(), { force: true }).catch(() => {});
      args.onPublicStateUpdated?.(runId);
    }

    if (typeof args.params.instructions === 'string' && args.params.instructions.trim().length > 0) {
      const start = {
        sessionId: args.params.sessionId,
        runId,
        callId,
        sidechainId,
        intent: args.params.intent,
        backendId,
        backendTarget: args.params.backendTarget,
        instructions: args.params.instructions ?? '',
        permissionMode: args.params.permissionMode,
        retentionPolicy: args.params.retentionPolicy,
        runClass: args.params.runClass,
        ioMode: args.params.ioMode,
        startedAtMs,
      } as const;
      const profile = args.profileCatalog
        ? resolveExecutionRunIntentProfileFromCatalog(args.profileCatalog, args.params.intent, args.params.profileId)
        : resolveExecutionRunIntentProfile(args.params.intent);
      await args.send(runId, { message: profile.buildPrompt(start) });
    }

    return { runId, callId, sidechainId };
  } catch (e: any) {
    if (!registeredController) {
      args.budgetRegistry?.releaseExecutionRun(runId);
    }
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

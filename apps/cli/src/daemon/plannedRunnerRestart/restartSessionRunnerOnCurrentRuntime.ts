import type { TrackedSession } from '@/daemon/types';
import { adoptTrackedSessionRunnerIdentity, resolveTrackedSessionRunnerIdentity } from '../sessions/sessionReportCorrelation';
import { hashProcessCommand, processIdentityMatches } from '@happier-dev/cli-common/processInstance';
import { parseProcessGenerationWitness, readProcessIdentityByPid } from '../processIdentity';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import type {
  SessionRunnerRestartDisabledReason,
} from '@happier-dev/protocol';

import type { SessionRunnerEntrypointIdentity } from '../sessionRunnerRuntime/types';
import type { SessionRunnerAgentRuntimeCurrentness } from '../sessionRunnerRuntime/resolveAgentRuntimeCurrentness';
import { resolveSessionRunnerRuntimeState, resolveTrackedSessionRunnerActivity, type SessionRunnerActivityRefusal } from '../sessionRunnerRuntime/resolveRuntimeState';
import { readTrackedSessionRunnerProcessCommand, resolveSessionRunnerEntrypointIdentityFromProcessCommand } from '../sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import {
  resolveSessionRunnerRestartEligibility,
  shouldRefreshSessionRunnerResumeIdentity,
} from '../sessionRunnerRuntime/resolveRestartEligibility';
import type {
  PlannedRunnerRestartMode,
  PlannedRunnerRestartRequestReason,
  PlannedRunnerRestartNotSignaledReason,
  PlannedRunnerRestartSignalGateResult,
  RestartAllSessionRunnersResult,
  RestartSessionRunnerRequest,
  RestartSessionRunnerResult,
  RestartSessionRunnerStatus,
} from './types';
import {
  isRequestAuthSourceCutoverRequirementCurrent,
  type RequestAuthSourceCutoverRequirement,
} from './requestAuthSourceCutover';

type RequestRestart = (input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  reason: 'version_runtime_refresh';
  requesterReason?: RestartSessionRunnerRequest['reason'] | 'request_auth_source_cutover';
  transientSpawnOptions?: SpawnSessionOptions;
  completionTimeoutMs?: number | null;
  canSignal?: () =>
    | PlannedRunnerRestartSignalGateResult
    | Promise<PlannedRunnerRestartSignalGateResult>;
}>) => Promise<Readonly<{
  signaled: boolean;
  notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
  completion?: RestartSessionRunnerCompletion;
}>>;

type RestartSessionRunnerEndpointSummary = NonNullable<RestartSessionRunnerResult['previous']>;
type ResolveActivityDisabledReason = (sessionId: string) => SessionRunnerRestartDisabledReason | SessionRunnerActivityRefusal | null;
type ResolveAgentRuntimeCurrentness = (
  tracked: TrackedSession,
) => Promise<SessionRunnerAgentRuntimeCurrentness>;
type ResolveCurrentIdentity = () => SessionRunnerEntrypointIdentity;
type RefreshTrackedSessionRuntimeSnapshot = (input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
}>) => Promise<void>;
export type RunnerRestartIdentityWitness = Readonly<{
  pid: number;
  processStartTimeMs: number | undefined;
  processCommandHash: string;
  runnerEntrypointIdentity: string | null;
}>;
type SourceCutoverContext = Readonly<{
  requirement: RequestAuthSourceCutoverRequirement;
  resolveCurrentCapabilityPath: () => string | null;
}>;
type RestartSessionRunnerOnCurrentRuntimeInput = Readonly<{
  request: RestartSessionRunnerRequest;
  expectedRunnerProcessIdentity?: RunnerRestartIdentityWitness;
  tracked: TrackedSession | null | undefined;
  currentIdentity: SessionRunnerEntrypointIdentity;
  resolveCurrentIdentity?: ResolveCurrentIdentity;
  agentRuntimeVersionState?: SessionRunnerAgentRuntimeCurrentness['versionState'];
  agentRuntimeRestartUnavailableReason?: SessionRunnerAgentRuntimeCurrentness['restartUnavailableReason'];
  requestRestart: RequestRestart;
  resolveActivityDisabledReason?: ResolveActivityDisabledReason;
  resolveAgentRuntimeCurrentness?: ResolveAgentRuntimeCurrentness;
  refreshTrackedSessionRuntimeSnapshot?: RefreshTrackedSessionRuntimeSnapshot;
  readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
  readNativeRuntimeActivity?: (sessionId: string) => Promise<'active' | 'settled' | 'unknown'>;
  /** Set only by the explicit confirmed-background restart operation. */
  allowNativeBackgroundInterruption?: true;
}>;

export type RestartSessionRunnerCompletion =
  | Readonly<{ ok: true; next?: RestartSessionRunnerEndpointSummary }>
  | Readonly<{
    ok: false;
    status: Extract<RestartSessionRunnerStatus, 'stop_failed' | 'spawn_failed' | 'partial_failure'>;
    reasonCode?: SessionRunnerRestartDisabledReason | null;
    diagnostics?: Record<string, unknown>;
  }>;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function captureRunnerRestartIdentityWitness(
  tracked: TrackedSession,
): RunnerRestartIdentityWitness {
  const processIdentity = resolveTrackedSessionRunnerIdentity(tracked);
  const runnerIdentity =
    resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      readTrackedSessionRunnerProcessCommand(tracked),
    );
  return Object.freeze({
    pid: tracked.sessionRunnerPid ?? tracked.pid,
    processStartTimeMs: processIdentity?.processStartTimeMs,
    processCommandHash: normalizeString(
      processIdentity?.processCommandHash,
    ),
    runnerEntrypointIdentity:
      runnerIdentity.status === 'known'
        ? runnerIdentity.comparableId
        : null,
  });
}

export function isUnattestedPublicV1RunnerRolloutMutation(
  request: Readonly<{
    dryRun?: boolean;
    reason: RestartSessionRunnerRequest['reason'];
  }>,
): boolean {
  return request.dryRun !== true
    && request.reason === 'daemon_dist_generation_rollout';
}

function isActivePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function summarizeSessionRunnerEndpoint(tracked: TrackedSession): RestartSessionRunnerEndpointSummary {
  const runnerIdentity = resolveSessionRunnerEntrypointIdentityFromProcessCommand(readTrackedSessionRunnerProcessCommand(tracked));
  const processIdentity = resolveTrackedSessionRunnerIdentity(tracked);
  return {
    pid: tracked.sessionRunnerPid ?? tracked.pid,
    cliVersion: runnerIdentity.status === 'known' ? runnerIdentity.entrypointVersion ?? null : null,
    processCommandHash: normalizeString(processIdentity?.processCommandHash) || null,
    entrypointVersion: runnerIdentity.status === 'known' ? runnerIdentity.entrypointVersion ?? null : null,
  };
}

function skipped(
  status: RestartSessionRunnerStatus,
  sessionId: string,
  reasonCode?: SessionRunnerRestartDisabledReason | null,
): RestartSessionRunnerResult {
  return {
    ok: false,
    status,
    sessionId,
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function mapRestartNotSignaledReasonToDisabledReason(
  reason: PlannedRunnerRestartNotSignaledReason | undefined,
): SessionRunnerRestartDisabledReason | null {
  if (
    !reason
    || reason === 'stale_owner'
    || reason === 'unsafe_process'
    || reason === 'superseded'
    || reason === 'shutting_down'
    || reason === 'runner_identity_changed'
    || reason === 'activity_observation_unavailable'
    || reason === 'remainder_capture_unavailable'
  ) {
    return null;
  }
  if (reason === 'activity_in_progress') return 'turn_in_progress';
  if (reason === 'source_cutover_requirement_missing') {
    return 'runner_generation_unattested';
  }
  return reason;
}

function validateRestartContext(input: Readonly<{
  request: RestartSessionRunnerRequest;
  expectedRunnerProcessIdentity?: RunnerRestartIdentityWitness;
  tracked: TrackedSession | null;
}>): RestartSessionRunnerResult | null {
  const sessionId = normalizeString(input.request.sessionId);
  const tracked = input.tracked;
  const eligibility = resolveSessionRunnerRestartEligibility(tracked);
  if (!eligibility.eligible) {
    if (eligibility.disabledReason === 'no_tracked_process') return skipped('not_found', sessionId);
    if (eligibility.disabledReason === 'not_daemon_started') return skipped('not_daemon_started', sessionId, eligibility.disabledReason);
    if (eligibility.disabledReason === 'not_active') return skipped('runner_not_active', sessionId, eligibility.disabledReason);
    if (eligibility.disabledReason === 'missing_spawn_options') return skipped('missing_spawn_options', sessionId, eligibility.disabledReason);
    if (eligibility.disabledReason === 'missing_resume_identity') return skipped('missing_resume_snapshot', sessionId, eligibility.disabledReason);
    if (eligibility.disabledReason === 'restart_admission_unsupported') return skipped('restart_admission_unsupported', sessionId, eligibility.disabledReason);
    return skipped('ineligible', sessionId, eligibility.disabledReason);
  }

  if (!tracked) return skipped('not_found', sessionId);

  if (
    input.expectedRunnerProcessIdentity
    && (() => {
      const currentIdentity =
        captureRunnerRestartIdentityWitness(tracked);
      return input.expectedRunnerProcessIdentity.pid
          !== currentIdentity.pid
        || input.expectedRunnerProcessIdentity.processStartTimeMs
          !== currentIdentity.processStartTimeMs
        || input.expectedRunnerProcessIdentity.processCommandHash
          !== currentIdentity.processCommandHash
        || input.expectedRunnerProcessIdentity.runnerEntrypointIdentity
          !== currentIdentity.runnerEntrypointIdentity;
    })()
  ) {
    return skipped('runner_identity_changed', sessionId);
  }

  if (isActivePid(input.request.expectedRunnerPid) && input.request.expectedRunnerPid !== (tracked.sessionRunnerPid ?? tracked.pid)) {
    return skipped('runner_identity_changed', sessionId);
  }

  const expectedHash = normalizeString(input.request.expectedProcessCommandHash);
  const actualHash = normalizeString(resolveTrackedSessionRunnerIdentity(tracked)?.processCommandHash);
  if (expectedHash && expectedHash !== actualHash) {
    return skipped('runner_identity_changed', sessionId);
  }

  const expectedEntrypoint = normalizeString(input.request.expectedRunnerEntrypointIdentity);
  if (expectedEntrypoint) {
    const runnerIdentity = resolveSessionRunnerEntrypointIdentityFromProcessCommand(readTrackedSessionRunnerProcessCommand(tracked));
    if (runnerIdentity.status !== 'known' || runnerIdentity.comparableId !== expectedEntrypoint) {
      return skipped('runner_identity_changed', sessionId);
    }
  }

  return null;
}

function resolveExpectedRunnerProcessIdentity(input: Readonly<{
  request: RestartSessionRunnerRequest;
  expectedRunnerProcessIdentity?: RunnerRestartIdentityWitness;
}>): RunnerRestartIdentityWitness | undefined {
  if ('v' in input.request && input.request.v === 2) {
    return {
      pid: input.request.expectedRunnerProcessIdentity.pid,
      processStartTimeMs:
        input.request.expectedRunnerProcessIdentity.processStartTimeMs,
      processCommandHash: input.request.expectedProcessCommandHash,
      runnerEntrypointIdentity:
        input.request.expectedRunnerEntrypointIdentity,
    };
  }
  return input.expectedRunnerProcessIdentity;
}

async function refreshProviderRecoveryProcessWitness(input: Readonly<{
  tracked: TrackedSession;
  expectedRunner: RunnerRestartIdentityWitness;
  readIdentity: typeof readProcessIdentityByPid;
}>): Promise<boolean> {
  const runner = resolveTrackedSessionRunnerIdentity(input.tracked);
  if (!runner) return false;
  const launcherFact = await input.readIdentity(input.tracked.pid).catch(() => null);
  const runnerFact = runner.pid === input.tracked.pid
    ? launcherFact
    : await input.readIdentity(runner.pid).catch(() => null);
  const observedWitness = (fact: Awaited<ReturnType<typeof readProcessIdentityByPid>>) => {
    const generation = parseProcessGenerationWitness(fact);
    if (!fact || !generation
      || typeof fact.command !== 'string' || !fact.command.trim()) return null;
    return { ...generation,
      processCommandHash: hashProcessCommand(fact.command), processCommand: fact.command };
  };
  const launcherObserved = observedWitness(launcherFact);
  const runnerObserved = observedWitness(runnerFact);
  if (!launcherObserved || !runnerObserved
    || !processIdentityMatches(input.tracked, launcherObserved)
    || !processIdentityMatches(runner, runnerObserved)
    || !processIdentityMatches(input.expectedRunner, runnerObserved)) return false;

  // An explicit recovery can complete a legacy command-hash witness with its
  // observed birth. Never replace a known generation or the person's runner.
  input.tracked.processStartTimeMs = launcherObserved.processStartTimeMs;
  input.tracked.processCommandHash = launcherObserved.processCommandHash;
  input.tracked.processCommand = launcherObserved.processCommand;
  adoptTrackedSessionRunnerIdentity(input.tracked, runnerObserved);
  return true;
}

function resolveActivityRefusal(
  tracked: TrackedSession,
  sessionId: string,
  resolve?: ResolveActivityDisabledReason,
): SessionRunnerActivityRefusal | null {
  const trackedActivity = resolveTrackedSessionRunnerActivity(tracked);
  if (trackedActivity) return trackedActivity;
  const activity = resolve?.(sessionId) ?? null;
  return typeof activity === 'string' ? { reasonCode: activity } : activity;
}

function busy(sessionId: string, activity: SessionRunnerActivityRefusal): RestartSessionRunnerResult {
  return { ...skipped('busy', sessionId, activity.reasonCode),
    ...(activity.diagnostics ? { diagnostics: activity.diagnostics } : {}) };
}

function resolveProviderRecoverySpawnOptions(input: Readonly<{
  request: RestartSessionRunnerRequest;
  tracked: TrackedSession;
}>): SpawnSessionOptions | RestartSessionRunnerResult | undefined {
  if (input.request.reason !== 'provider_binding_change_recovery') return undefined;
  const confirmation = input.request.providerBindingSecurityChangeConfirmationV1;
  if (!confirmation) return undefined;
  const spawnOptions = input.tracked.spawnOptions;
  const previousBinding = spawnOptions?.providerBindingMetadataV1;
  if (
    !spawnOptions
    || !previousBinding
    || previousBinding.connectionId !== confirmation.connectionId
    || previousBinding.bindingSecurityFingerprint
      !== confirmation.previousBindingSecurityFingerprint
  ) {
    return skipped('runner_identity_changed', input.request.sessionId);
  }
  return {
    ...spawnOptions,
    providerBindingSecurityChangeConfirmationV1: confirmation,
  };
}

function resolveVersionGate(input: Readonly<{
  request: RestartSessionRunnerRequest;
  tracked: TrackedSession;
  currentIdentity: SessionRunnerEntrypointIdentity;
  agentRuntimeVersionState?: SessionRunnerAgentRuntimeCurrentness['versionState'];
  agentRuntimeRestartUnavailableReason?: SessionRunnerAgentRuntimeCurrentness['restartUnavailableReason'];
}>): RestartSessionRunnerResult | null {
  const mode = input.request.mode ?? 'if_stale';
  const state = resolveSessionRunnerRuntimeState({
    sessionId: input.request.sessionId,
    tracked: input.tracked,
    currentIdentity: input.currentIdentity,
    agentRuntimeVersionState: input.agentRuntimeVersionState,
    agentRuntimeRestartUnavailableReason:
      input.agentRuntimeRestartUnavailableReason,
  });

  if (mode === 'force_current_cli') {
    const disabledReason = state.plannedRestart.disabledReason;
    if (disabledReason) {
      return skipped(disabledReason === 'current_entrypoint_unknown' ? 'version_unknown' : 'ineligible',
        input.request.sessionId, disabledReason);
    }
    return null;
  }

  if (input.agentRuntimeRestartUnavailableReason) {
    return skipped(
      'ineligible',
      input.request.sessionId,
      input.agentRuntimeRestartUnavailableReason,
    );
  }

  if (state.versionState === 'current') {
    return {
      ok: true,
      status: 'already_current',
      sessionId: input.request.sessionId,
      previous: summarizeSessionRunnerEndpoint(input.tracked),
    };
  }
  if (state.versionState === 'unknown') {
    const reasonCode = state.daemon.currentEntrypointSource === 'unknown'
      ? 'current_entrypoint_unknown'
      : state.runner.entrypointSource === 'unknown'
        ? 'runner_entrypoint_unknown' : 'runner_generation_unattested';
    return skipped('version_unknown', input.request.sessionId, reasonCode);
  }
  return null;
}

function isSourceCutoverCurrent(input: Readonly<{
  sourceCutover: SourceCutoverContext;
  tracked: TrackedSession;
}>): boolean {
  try {
    const currentCapabilityPath =
      input.sourceCutover.resolveCurrentCapabilityPath();
    if (!currentCapabilityPath) return false;
    return isRequestAuthSourceCutoverRequirementCurrent({
      requirement: input.sourceCutover.requirement,
      tracked: input.tracked,
      currentCapabilityPath,
    });
  } catch {
    return false;
  }
}

async function restartSessionRunnerOnCurrentRuntimeImpl(
  input: RestartSessionRunnerOnCurrentRuntimeInput & Readonly<{
    sourceCutover?: SourceCutoverContext;
  }>,
): Promise<RestartSessionRunnerResult> {
  const sessionId = normalizeString(input.request.sessionId);
  const tracked = input.tracked ?? null;
  const expectedRunnerProcessIdentity =
    resolveExpectedRunnerProcessIdentity(input);
  if (tracked?.reattachedInterruptedTurnId && !tracked.activeTurnId && input.refreshTrackedSessionRuntimeSnapshot) {
    await input.refreshTrackedSessionRuntimeSnapshot({ sessionId, tracked });
  }
  let contextFailure = validateRestartContext({
    request: input.request,
    expectedRunnerProcessIdentity,
    tracked,
  });
  if (contextFailure?.reasonCode === 'non_destructive_refresh_unsupported'
    && input.request.reason === 'provider_binding_change_recovery'
    && 'v' in input.request && input.request.v === 2
    && input.request.dryRun !== true && tracked && expectedRunnerProcessIdentity) {
    const refreshed = await refreshProviderRecoveryProcessWitness({
      tracked, expectedRunner: expectedRunnerProcessIdentity,
      readIdentity: input.readProcessIdentityByPidFn ?? readProcessIdentityByPid,
    });
    if (!refreshed) return skipped('runner_identity_changed', sessionId);
    contextFailure = validateRestartContext({ request: input.request, expectedRunnerProcessIdentity, tracked });
  }
  if (
    contextFailure?.reasonCode === 'missing_resume_identity'
    && shouldRefreshSessionRunnerResumeIdentity(tracked)
    && input.refreshTrackedSessionRuntimeSnapshot
  ) {
    await input.refreshTrackedSessionRuntimeSnapshot({ sessionId, tracked });
    contextFailure = validateRestartContext({
      request: input.request,
      expectedRunnerProcessIdentity,
      tracked,
    });
  }
  if (contextFailure) return contextFailure;
  if (!tracked) return skipped('not_found', sessionId);
  if (
    input.sourceCutover
    && !isSourceCutoverCurrent({
      sourceCutover: input.sourceCutover,
      tracked,
    })
  ) {
    return skipped(
      'ineligible',
      sessionId,
      'runner_generation_unattested',
    );
  }

  const versionGate = resolveVersionGate({
    request: input.request,
    tracked,
    currentIdentity: input.currentIdentity,
    agentRuntimeVersionState: input.agentRuntimeVersionState,
    agentRuntimeRestartUnavailableReason:
      input.agentRuntimeRestartUnavailableReason,
  });
  if (versionGate) return versionGate;

  const providerRecoverySpawnOptions = resolveProviderRecoverySpawnOptions({
    request: input.request,
    tracked,
  });
  if (providerRecoverySpawnOptions && 'ok' in providerRecoverySpawnOptions) {
    return providerRecoverySpawnOptions;
  }

  const resolveNativeActivityGate = async (): Promise<PlannedRunnerRestartSignalGateResult> => {
    if (input.allowNativeBackgroundInterruption === true || !input.readNativeRuntimeActivity) return true;
    try {
      const state = await input.readNativeRuntimeActivity(sessionId);
      return state === 'active' ? 'turn_in_progress' : true;
    } catch { return 'activity_observation_unavailable'; }
  };
  const activityRefusal = resolveActivityRefusal(tracked, sessionId, input.resolveActivityDisabledReason);
  if (activityRefusal) {
    return busy(sessionId, activityRefusal);
  }

  const nativeActivityGate = await resolveNativeActivityGate();
  if (nativeActivityGate !== true) {
    return nativeActivityGate === 'turn_in_progress'
      ? busy(sessionId, { reasonCode: 'turn_in_progress', diagnostics: { busySource: 'native_background_work' } })
      : { ok: false, status: 'partial_failure', sessionId, diagnostics: { activityObservation: 'unavailable' } };
  }

  if ('dryRun' in input.request && input.request.dryRun === true) {
    return {
      ok: true,
      status: 'dry_run_restartable',
      sessionId,
      previous: summarizeSessionRunnerEndpoint(tracked),
    };
  }

  const previous = summarizeSessionRunnerEndpoint(tracked);
  const sourceCutover = input.sourceCutover;
  let signalVersionGateResult: RestartSessionRunnerResult | null = null;
  const canSignal = !sourceCutover
    ? async (): Promise<PlannedRunnerRestartSignalGateResult> => {
      const signalContextFailure = validateRestartContext({
        request: input.request,
        expectedRunnerProcessIdentity,
        tracked,
      });
      if (signalContextFailure) {
        signalVersionGateResult = signalContextFailure;
        return signalContextFailure.status === 'runner_identity_changed'
          ? 'runner_identity_changed'
          : signalContextFailure.reasonCode ?? false;
      }
      let currentIdentity = input.currentIdentity;
      if (input.resolveCurrentIdentity) {
        try {
          currentIdentity = input.resolveCurrentIdentity();
        } catch {
          signalVersionGateResult = skipped(
            'version_unknown',
            sessionId,
            'current_entrypoint_unknown',
          );
          return false;
        }
      }
      let agentRuntimeVersionState = input.agentRuntimeVersionState;
      let agentRuntimeRestartUnavailableReason =
        input.agentRuntimeRestartUnavailableReason;
      if (input.resolveAgentRuntimeCurrentness) {
        let currentness: SessionRunnerAgentRuntimeCurrentness;
        try {
          currentness = await input.resolveAgentRuntimeCurrentness(tracked);
        } catch {
          currentness = {
            versionState: 'unknown',
            restartUnavailableReason: null,
          };
        }
        agentRuntimeVersionState = currentness.versionState;
        agentRuntimeRestartUnavailableReason =
          currentness.restartUnavailableReason;
      }
      signalVersionGateResult = resolveVersionGate({
        request: input.request,
        tracked,
        currentIdentity,
        agentRuntimeVersionState,
        agentRuntimeRestartUnavailableReason,
      });
      if (signalVersionGateResult) {
        return agentRuntimeRestartUnavailableReason ?? false;
      }
      const foreground = resolveActivityRefusal(tracked, sessionId, input.resolveActivityDisabledReason);
      if (foreground) return foreground.reasonCode;
      const nativeGate = await resolveNativeActivityGate();
      if (nativeGate === 'turn_in_progress') {
        signalVersionGateResult = busy(sessionId, { reasonCode: 'turn_in_progress', diagnostics: { busySource: 'native_background_work' } });
      }
      return nativeGate;
    }
    : undefined;
  const restart = await input.requestRestart({
    sessionId,
    tracked,
    reason: 'version_runtime_refresh',
    requesterReason: sourceCutover ? 'request_auth_source_cutover' : input.request.reason,
    ...(providerRecoverySpawnOptions
      ? { transientSpawnOptions: providerRecoverySpawnOptions }
      : {}),
    ...(sourceCutover
      ? {
        completionTimeoutMs: null,
        canSignal: () => {
          const activity = resolveActivityRefusal(tracked, sessionId, input.resolveActivityDisabledReason);
          if (activity) return activity.reasonCode;
          return isSourceCutoverCurrent({
            sourceCutover,
            tracked,
          })
            ? true
            : 'source_cutover_requirement_missing';
        },
      }
      : {}),
    ...(canSignal ? { canSignal } : {}),
  });
  if (!restart.signaled) {
    if (signalVersionGateResult) return signalVersionGateResult;
    if (restart.notSignaledReason === 'restart_admission_unsupported') {
      return skipped('restart_admission_unsupported', sessionId, 'restart_admission_unsupported');
    }
    if (restart.notSignaledReason === 'activity_observation_unavailable') {
      return { ok: false, status: 'partial_failure', sessionId,
        diagnostics: { activityObservation: 'unavailable' } };
    }
    if (restart.notSignaledReason === 'remainder_capture_unavailable') {
      return { ok: false, status: 'partial_failure', sessionId,
        diagnostics: { runnerRemainderCapture: 'unavailable', retryable: true } };
    }
    if (
      restart.notSignaledReason === 'unsafe_process'
      || restart.notSignaledReason === 'runner_identity_changed'
    ) {
      return skipped('runner_identity_changed', sessionId);
    }
    const activityDisabledReason = mapRestartNotSignaledReasonToDisabledReason(restart.notSignaledReason);
    if (activityDisabledReason) return busy(sessionId,
      resolveActivityRefusal(tracked, sessionId, input.resolveActivityDisabledReason) ?? { reasonCode: activityDisabledReason });
    return skipped('busy', sessionId);
  }
  if (sourceCutover && !restart.completion) {
    return {
      ok: false,
      status: 'partial_failure',
      sessionId,
      previous,
      diagnostics: {
        respawnTerminalReason:
          'canonical_respawn_completion_missing',
      },
    };
  }
  if (restart.completion?.ok === false) {
    return {
      ok: false,
      status: restart.completion.status,
      sessionId,
      previous,
      ...(restart.completion.reasonCode ? { reasonCode: restart.completion.reasonCode } : {}),
      ...(restart.completion.diagnostics ? { diagnostics: restart.completion.diagnostics } : {}),
    };
  }

  return {
    ok: true,
    status: 'restarted',
    sessionId,
    previous,
    ...(restart.completion?.next ? { next: restart.completion.next } : {}),
  };
}

export async function restartSessionRunnerOnCurrentRuntime(
  input: RestartSessionRunnerOnCurrentRuntimeInput,
): Promise<RestartSessionRunnerResult> {
  if (isUnattestedPublicV1RunnerRolloutMutation(input.request)) {
    return skipped(
      'ineligible',
      normalizeString(input.request.sessionId),
      'runner_generation_unattested',
    );
  }
  return await restartSessionRunnerOnCurrentRuntimeImpl(input);
}

export async function restartSessionRunnerForRequestAuthSourceCutover(
  input: Readonly<{
    tracked: TrackedSession;
    currentIdentity: SessionRunnerEntrypointIdentity;
    requestRestart: RequestRestart;
    requirement: RequestAuthSourceCutoverRequirement;
    resolveCurrentCapabilityPath: () => string | null;
    resolveActivityDisabledReason: ResolveActivityDisabledReason;
  }>,
): Promise<RestartSessionRunnerResult> {
  return await restartSessionRunnerOnCurrentRuntimeImpl({
    request: {
      sessionId: input.requirement.sessionId,
      mode: 'force_current_cli',
      reason: 'daemon_dist_generation_rollout',
      expectedRunnerPid: input.requirement.runnerPid,
      expectedProcessCommandHash:
        input.requirement.processCommandHash,
    },
    expectedRunnerProcessIdentity: {
      pid: input.requirement.runnerPid,
      processStartTimeMs:
        input.requirement.processStartTimeMs,
      processCommandHash:
        input.requirement.processCommandHash,
      runnerEntrypointIdentity:
        captureRunnerRestartIdentityWitness(input.tracked)
          .runnerEntrypointIdentity,
    },
    tracked: input.tracked,
    currentIdentity: input.currentIdentity,
    requestRestart: input.requestRestart,
    resolveActivityDisabledReason:
      input.resolveActivityDisabledReason,
    sourceCutover: {
      requirement: input.requirement,
      resolveCurrentCapabilityPath:
        input.resolveCurrentCapabilityPath,
    },
  });
}

export async function restartAllSessionRunnersOnCurrentRuntime(input: Readonly<{
  mode: PlannedRunnerRestartMode;
  reason: PlannedRunnerRestartRequestReason;
  dryRun?: boolean;
  currentIdentity: SessionRunnerEntrypointIdentity;
  resolveCurrentIdentity?: ResolveCurrentIdentity;
  trackedSessions: ReadonlyArray<TrackedSession>;
  requestRestart: RequestRestart;
  resolveActivityDisabledReason?: ResolveActivityDisabledReason;
  resolveAgentRuntimeCurrentness?: (
    tracked: TrackedSession,
  ) => Promise<SessionRunnerAgentRuntimeCurrentness>;
  refreshTrackedSessionRuntimeSnapshot?: RefreshTrackedSessionRuntimeSnapshot;
  shouldContinue?: () => boolean;
  readNativeRuntimeActivity?: RestartSessionRunnerOnCurrentRuntimeInput['readNativeRuntimeActivity'];
}>): Promise<RestartAllSessionRunnersResult> {
  const results: RestartSessionRunnerResult[] = [];
  const restartTargets = input.trackedSessions.map((tracked) => ({
    tracked,
    expectedRunnerProcessIdentity:
      captureRunnerRestartIdentityWitness(tracked),
  }));
  for (const target of restartTargets) {
    if (input.shouldContinue && !input.shouldContinue()) break;
    const { tracked, expectedRunnerProcessIdentity } = target;
    const sessionId = normalizeString(tracked.happySessionId);
    if (!sessionId) continue;
    const agentRuntimeCurrentness = input.resolveAgentRuntimeCurrentness
      ? await input.resolveAgentRuntimeCurrentness(tracked)
      : null;
    results.push(await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId,
        mode: input.mode,
        reason: input.reason,
        dryRun: input.dryRun === true,
      },
      expectedRunnerProcessIdentity,
      tracked,
      currentIdentity: input.currentIdentity,
      resolveCurrentIdentity: input.resolveCurrentIdentity,
      ...(agentRuntimeCurrentness
        ? {
          agentRuntimeVersionState:
            agentRuntimeCurrentness.versionState,
          agentRuntimeRestartUnavailableReason:
            agentRuntimeCurrentness.restartUnavailableReason,
        }
        : {}),
      requestRestart: input.requestRestart,
      readNativeRuntimeActivity: input.readNativeRuntimeActivity,
      ...(input.resolveAgentRuntimeCurrentness
        ? {
          resolveAgentRuntimeCurrentness:
            input.resolveAgentRuntimeCurrentness,
        }
        : {}),
      ...(input.resolveActivityDisabledReason ? { resolveActivityDisabledReason: input.resolveActivityDisabledReason } : {}),
      ...(input.refreshTrackedSessionRuntimeSnapshot
        ? { refreshTrackedSessionRuntimeSnapshot: input.refreshTrackedSessionRuntimeSnapshot }
        : {}),
    }));
  }

  const restartableStatuses = new Set<RestartSessionRunnerStatus>(['restarted', 'dry_run_restartable']);
  const failedStatuses = new Set<RestartSessionRunnerStatus>(['partial_failure', 'stop_failed', 'spawn_failed']);
  const restartedCount = results.filter((result) => restartableStatuses.has(result.status)).length;
  const failedCount = results.filter((result) => failedStatuses.has(result.status)).length;
  const skippedCount = results.length - restartedCount - failedCount;

  return {
    ok: failedCount === 0,
    mode: input.mode,
    requestedCount: results.length,
    restartedCount,
    skippedCount,
    failedCount,
    results,
  };
}

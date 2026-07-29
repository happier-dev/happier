import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import type { SessionRunnerRestartDisabledReason } from '@happier-dev/protocol';

import type { SessionRunnerEntrypointIdentity } from '../sessionRunnerRuntime/types';
import { resolveSessionRunnerRuntimeState } from '../sessionRunnerRuntime/resolveRuntimeState';
import { resolveSessionRunnerEntrypointIdentityFromProcessCommand } from '../sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import { resolveSessionRunnerRestartEligibility } from '../sessionRunnerRuntime/resolveRestartEligibility';
import type {
  PlannedRunnerRestartMode,
  PlannedRunnerRestartNotSignaledReason,
  RestartAllSessionRunnersResult,
  RestartSessionRunnerRequest,
  RestartSessionRunnerResult,
  RestartSessionRunnerStatus,
} from './types';

type RequestRestart = (input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  reason: 'version_runtime_refresh';
  transientSpawnOptions?: SpawnSessionOptions;
}>) => Promise<Readonly<{
  signaled: boolean;
  notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
  completion?: RestartSessionRunnerCompletion;
}>>;

type RestartSessionRunnerEndpointSummary = NonNullable<RestartSessionRunnerResult['previous']>;
type ResolveActivityDisabledReason = (sessionId: string) => SessionRunnerRestartDisabledReason | null;

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

function isActivePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function summarizeSessionRunnerEndpoint(tracked: TrackedSession): RestartSessionRunnerEndpointSummary {
  const runnerIdentity = resolveSessionRunnerEntrypointIdentityFromProcessCommand(tracked.processCommand);
  return {
    pid: tracked.pid,
    cliVersion: runnerIdentity.status === 'known' ? runnerIdentity.entrypointVersion ?? null : null,
    processCommandHash: normalizeString(tracked.processCommandHash) || null,
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
  if (!reason || reason === 'stale_owner' || reason === 'unsafe_process' || reason === 'superseded') {
    return null;
  }
  if (reason === 'activity_in_progress') return 'turn_in_progress';
  return reason;
}

function validateRestartContext(input: Readonly<{
  request: RestartSessionRunnerRequest;
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
    return skipped('ineligible', sessionId, eligibility.disabledReason);
  }

  if (!tracked) return skipped('not_found', sessionId);

  if (isActivePid(input.request.expectedRunnerPid) && input.request.expectedRunnerPid !== tracked.pid) {
    return skipped('runner_identity_changed', sessionId);
  }

  const expectedHash = normalizeString(input.request.expectedProcessCommandHash);
  const actualHash = normalizeString(tracked.processCommandHash);
  if (expectedHash && expectedHash !== actualHash) {
    return skipped('runner_identity_changed', sessionId);
  }

  const expectedEntrypoint = normalizeString(input.request.expectedRunnerEntrypointIdentity);
  if (expectedEntrypoint) {
    const runnerIdentity = resolveSessionRunnerEntrypointIdentityFromProcessCommand(tracked.processCommand);
    if (runnerIdentity.status !== 'known' || runnerIdentity.comparableId !== expectedEntrypoint) {
      return skipped('runner_identity_changed', sessionId);
    }
  }

  return null;
}

function resolveProviderRecoverySpawnOptions(input: Readonly<{
  request: RestartSessionRunnerRequest;
  tracked: TrackedSession;
}>): SpawnSessionOptions | RestartSessionRunnerResult | undefined {
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
}>): RestartSessionRunnerResult | null {
  const mode = input.request.mode ?? 'if_stale';
  const state = resolveSessionRunnerRuntimeState({
    sessionId: input.request.sessionId,
    tracked: input.tracked,
    currentIdentity: input.currentIdentity,
  });

  if (mode === 'force_current_cli') {
    if (input.currentIdentity.status !== 'known') {
      return skipped('version_unknown', input.request.sessionId, 'current_entrypoint_unknown');
    }
    return null;
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
    const reasonCode = state.plannedRestart.disabledReason === 'current_entrypoint_unknown'
      ? 'current_entrypoint_unknown'
      : 'runner_entrypoint_unknown';
    return skipped('version_unknown', input.request.sessionId, reasonCode);
  }
  return null;
}

export async function restartSessionRunnerOnCurrentRuntime(input: Readonly<{
  request: RestartSessionRunnerRequest;
  tracked: TrackedSession | null | undefined;
  currentIdentity: SessionRunnerEntrypointIdentity;
  requestRestart: RequestRestart;
  resolveActivityDisabledReason?: ResolveActivityDisabledReason;
}>): Promise<RestartSessionRunnerResult> {
  const sessionId = normalizeString(input.request.sessionId);
  const tracked = input.tracked ?? null;
  const contextFailure = validateRestartContext({ request: input.request, tracked });
  if (contextFailure) return contextFailure;
  if (!tracked) return skipped('not_found', sessionId);

  const versionGate = resolveVersionGate({
    request: input.request,
    tracked,
    currentIdentity: input.currentIdentity,
  });
  if (versionGate) return versionGate;

  const providerRecoverySpawnOptions = resolveProviderRecoverySpawnOptions({
    request: input.request,
    tracked,
  });
  if (providerRecoverySpawnOptions && 'ok' in providerRecoverySpawnOptions) {
    return providerRecoverySpawnOptions;
  }

  const activityDisabledReason = input.resolveActivityDisabledReason?.(sessionId) ?? null;
  if (activityDisabledReason) {
    return skipped('busy', sessionId, activityDisabledReason);
  }

  if (input.request.dryRun === true) {
    return {
      ok: true,
      status: 'dry_run_restartable',
      sessionId,
      previous: summarizeSessionRunnerEndpoint(tracked),
    };
  }

  const previous = summarizeSessionRunnerEndpoint(tracked);
  const restart = await input.requestRestart({
    sessionId,
    tracked,
    reason: 'version_runtime_refresh',
    ...(providerRecoverySpawnOptions
      ? { transientSpawnOptions: providerRecoverySpawnOptions }
      : {}),
  });
  if (!restart.signaled) {
    if (restart.notSignaledReason === 'unsafe_process') {
      return skipped('runner_identity_changed', sessionId);
    }
    const activityDisabledReason = mapRestartNotSignaledReasonToDisabledReason(restart.notSignaledReason);
    if (activityDisabledReason) return skipped('busy', sessionId, activityDisabledReason);
    return skipped('busy', sessionId);
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

export async function restartAllSessionRunnersOnCurrentRuntime(input: Readonly<{
  mode: PlannedRunnerRestartMode;
  reason: RestartSessionRunnerRequest['reason'];
  dryRun?: boolean;
  currentIdentity: SessionRunnerEntrypointIdentity;
  trackedSessions: ReadonlyArray<TrackedSession>;
  requestRestart: RequestRestart;
  resolveActivityDisabledReason?: ResolveActivityDisabledReason;
}>): Promise<RestartAllSessionRunnersResult> {
  const results: RestartSessionRunnerResult[] = [];
  for (const tracked of input.trackedSessions) {
    const sessionId = normalizeString(tracked.happySessionId);
    if (!sessionId) continue;
    results.push(await restartSessionRunnerOnCurrentRuntime({
      request: {
        sessionId,
        mode: input.mode,
        reason: input.reason,
        dryRun: input.dryRun === true,
      },
      tracked,
      currentIdentity: input.currentIdentity,
      requestRestart: input.requestRestart,
      ...(input.resolveActivityDisabledReason ? { resolveActivityDisabledReason: input.resolveActivityDisabledReason } : {}),
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

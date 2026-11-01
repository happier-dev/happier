import type { TrackedSession } from '@/daemon/types';
import { hasActiveSessionRuntimeActivity, type SessionRunnerRestartDisabledReason, type SessionRuntimeActivityState } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { readTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import type { SessionRunnerEntrypointIdentity } from '../sessionRunnerRuntime/types';
import { resolveSessionRunnerRuntimeState } from '../sessionRunnerRuntime/resolveRuntimeState';
import { resolveSessionRunnerEntrypointIdentityFromProcessCommand } from '../sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import {
  resolveSessionRunnerRestartEligibility,
  shouldRefreshSessionRunnerResumeIdentity,
} from '../sessionRunnerRuntime/resolveRestartEligibility';
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
}>) => Promise<Readonly<{
  signaled: boolean;
  notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
  activityDisabledReason?: SessionRunnerRestartDisabledReason;
  completion?: RestartSessionRunnerCompletion;
}>>;

type RestartSessionRunnerEndpointSummary = NonNullable<RestartSessionRunnerResult['previous']>;
type ResolveActivityDisabledReason = (sessionId: string) => SessionRunnerRestartDisabledReason | null;
type ServerRuntimeActivity = Readonly<{
  runtimeActivityState?: SessionRuntimeActivityState | null;
  runtimeActivityActiveCount?: number | null;
}>;
type ReadServerRuntimeActivity = (sessionId: string) => Promise<ServerRuntimeActivity | null>;
type RefreshTrackedSessionRuntimeSnapshot = (input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
}>) => Promise<void>;

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

// The UI asks the user before sending this reason while background agents run, so only
// unconfirmed restarts (daemon/CLI/doctor/self-update/startup passes) consult the server.
const USER_CONFIRMED_RESTART_REASON: RestartSessionRunnerRequest['reason'] = 'ui_stale_runner_banner';

/**
 * Background agents/shells are invisible to the daemon's turn tracking; the server Runtime
 * Activity projection is the only owner that sees them. An unreadable projection blocks the
 * restart: a skipped restart stays recoverable, killed background work does not.
 */
async function hasServerProjectedBackgroundActivity(
  sessionId: string,
  readServerRuntimeActivity: ReadServerRuntimeActivity,
): Promise<boolean> {
  try {
    const activity = await readServerRuntimeActivity(sessionId);
    return hasActiveSessionRuntimeActivity({
      state: activity?.runtimeActivityState,
      activeCount: activity?.runtimeActivityActiveCount,
    });
  } catch {
    return true;
  }
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

  if (
    isActivePid(input.request.expectedRunnerPid) &&
    input.request.expectedRunnerPid !== tracked.pid
  ) {
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
    const identityReasons: readonly SessionRunnerRestartDisabledReason[] = [
      'current_entrypoint_unknown',
      'runner_generation_unattested',
    ];
    const disabledReason = state.plannedRestart.disabledReason ?? null;
    const reasonCode = disabledReason && identityReasons.includes(disabledReason)
      ? disabledReason
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
  refreshTrackedSessionRuntimeSnapshot?: RefreshTrackedSessionRuntimeSnapshot;
  readTerminalAttachmentInfo?: typeof readTerminalAttachmentInfo;
  readServerRuntimeActivity?: ReadServerRuntimeActivity;
}>): Promise<RestartSessionRunnerResult> {
  const sessionId = normalizeString(input.request.sessionId);
  const tracked = input.tracked ?? null;
  let contextFailure = validateRestartContext({ request: input.request, tracked });
  if (
    contextFailure?.reasonCode === 'missing_resume_identity'
    && shouldRefreshSessionRunnerResumeIdentity(tracked)
    && input.refreshTrackedSessionRuntimeSnapshot
  ) {
    await input.refreshTrackedSessionRuntimeSnapshot({ sessionId, tracked });
    contextFailure = validateRestartContext({ request: input.request, tracked });
  }
  if (contextFailure) return contextFailure;
  if (!tracked) return skipped('not_found', sessionId);

  const terminalMode = tracked.spawnOptions?.terminal?.mode;
  const attachmentInfo = await (input.readTerminalAttachmentInfo ?? readTerminalAttachmentInfo)({
    happyHomeDir: configuration.happyHomeDir,
    sessionId,
  }).catch(() => null);
  if (terminalMode === 'tmux' || attachmentInfo) {
    if (
      attachmentInfo?.version !== 2
      || (terminalMode === 'tmux' && attachmentInfo.handle.kind !== 'tmux')
      || attachmentInfo.handle.attachmentId !== attachmentInfo.attachmentId
    ) {
      return skipped('ineligible', sessionId, 'non_destructive_refresh_unsupported');
    }
  }

  const versionGate = resolveVersionGate({
    request: input.request,
    tracked,
    currentIdentity: input.currentIdentity,
  });
  if (versionGate) return versionGate;

  const activityDisabledReason = input.resolveActivityDisabledReason?.(sessionId) ?? null;
  if (activityDisabledReason) {
    return skipped('busy', sessionId, activityDisabledReason);
  }
  if (
    input.readServerRuntimeActivity
    && input.request.reason !== USER_CONFIRMED_RESTART_REASON
    && await hasServerProjectedBackgroundActivity(sessionId, input.readServerRuntimeActivity)
  ) {
    return skipped('busy', sessionId, 'turn_in_progress');
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
  });
  if (!restart.signaled) {
    if (restart.notSignaledReason === 'unsafe_process') {
      return skipped('runner_identity_changed', sessionId);
    }
    if (restart.notSignaledReason === 'activity_in_progress') {
      return skipped('busy', sessionId, restart.activityDisabledReason ?? 'turn_in_progress');
    }
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
  refreshTrackedSessionRuntimeSnapshot?: RefreshTrackedSessionRuntimeSnapshot;
  readServerRuntimeActivity?: ReadServerRuntimeActivity;
  /** Checked before each runner; returning false ends the pass with the results so far. */
  shouldContinue?: () => boolean;
}>): Promise<RestartAllSessionRunnersResult> {
  const results: RestartSessionRunnerResult[] = [];
  for (const tracked of input.trackedSessions) {
    if (input.shouldContinue && !input.shouldContinue()) break;
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
      ...(input.refreshTrackedSessionRuntimeSnapshot
        ? { refreshTrackedSessionRuntimeSnapshot: input.refreshTrackedSessionRuntimeSnapshot }
        : {}),
      ...(input.readServerRuntimeActivity ? { readServerRuntimeActivity: input.readServerRuntimeActivity } : {}),
    }));
  }

  const restartableStatuses = new Set<RestartSessionRunnerStatus>(['restarted', 'dry_run_restartable']);
  const failedStatuses = new Set<RestartSessionRunnerStatus>([
    'stop_failed',
    'spawn_failed',
    'partial_failure',
  ]);
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

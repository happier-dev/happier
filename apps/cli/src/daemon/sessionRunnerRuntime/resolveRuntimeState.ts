import type { TrackedSession } from '@/daemon/types';
import type { RpcHandlerActiveExecution } from '@/api/rpc/types';
import { SESSION_RUNTIME_REFRESH_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { SessionRunnerDaemonEntrypointSourceV1 } from '@happier-dev/protocol';
import { resolveTrackedSessionRunnerIdentity } from '../sessions/sessionReportCorrelation';

import {
  isGenerationAttestedComparableId,
  resolveSessionRunnerEntrypointIdentityFromProcessCommand,
  readTrackedSessionRunnerProcessCommand,
} from './resolveRunnerEntrypointIdentity';
import { readTrackedSessionRunnerStartingMode } from './readSessionRunnerStartingMode';
import { resolveSessionRunnerRestartEligibility } from './resolveRestartEligibility';
import type {
  SessionRunnerEntrypointIdentity,
  SessionRunnerRestartDisabledReason,
  SessionRunnerRuntimeState,
  SessionRunnerVersionState,
} from './types';

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export type SessionRunnerActivityRefusal = Readonly<{
  reasonCode: SessionRunnerRestartDisabledReason;
  diagnostics?: Record<string, unknown>;
}>;

export function resolveTrackedSessionRunnerActivity(
  tracked: TrackedSession | null | undefined,
  activeRpcOperations: readonly RpcHandlerActiveExecution[] = [],
  observingActionId: string = SESSION_RUNTIME_REFRESH_ACTION_ID_V1,
): SessionRunnerActivityRefusal | null {
  const effect = activeRpcOperations.find(operation => operation.sessionEffect && operation.sessionEffect.sessionId === tracked?.happySessionId
    // Restart-owning Actions stay in flight until replacement completes. Counting
    // them as runtime work makes a deferred switch refuse itself at the boundary.
    && operation.sessionEffect.actionId !== observingActionId);
  if (effect?.sessionEffect) return { reasonCode: 'turn_in_progress', diagnostics: {
    busySource: 'session_action', actionId: effect.sessionEffect.actionId,
  } };
  const turnId = normalizeString(tracked?.activeTurnId)
    || normalizeString(tracked?.reattachedInterruptedTurnId);
  return turnId ? { reasonCode: 'turn_in_progress', diagnostics: {
    busySource: normalizeString(tracked?.activeTurnId) ? 'foreground_turn' : 'interrupted_foreground_turn', turnId,
  } } : null;
}

function readStartedBy(value: unknown): 'daemon' | 'local' | 'unknown' {
  if (value === 'daemon') return 'daemon';
  if (typeof value === 'string' && value.trim()) return 'local';
  return 'unknown';
}

function readDaemonEntrypointSource(
  identity: SessionRunnerEntrypointIdentity,
): SessionRunnerDaemonEntrypointSourceV1 {
  if (identity.status !== 'known') return 'unknown';
  if (identity.source === 'launch_spec') return 'launch_spec';
  return 'unknown';
}

function resolveDisabledReason(tracked: TrackedSession | null): SessionRunnerRestartDisabledReason | null {
  return resolveSessionRunnerRestartEligibility(tracked).disabledReason;
}

function resolveVersionState(input: Readonly<{
  runnerIdentity: SessionRunnerEntrypointIdentity;
  currentIdentity: SessionRunnerEntrypointIdentity;
}>): SessionRunnerVersionState {
  if (input.runnerIdentity.status !== 'known' || input.currentIdentity.status !== 'known') {
    return 'unknown';
  }
  if (
    input.runnerIdentity.comparableId === input.currentIdentity.comparableId
    && !isGenerationAttestedComparableId(input.runnerIdentity.comparableId)
  ) {
    return 'unknown';
  }
  return input.runnerIdentity.comparableId === input.currentIdentity.comparableId ? 'current' : 'stale';
}

/** The version state of a live process (runner or session host) by its command line. */
export function resolveProcessCommandVersionState(
  processCommand: string | undefined,
  currentIdentity: SessionRunnerEntrypointIdentity,
): SessionRunnerVersionState {
  return resolveVersionState({
    runnerIdentity: resolveSessionRunnerEntrypointIdentityFromProcessCommand(processCommand),
    currentIdentity,
  });
}

function foldVersionStates(
  states: readonly SessionRunnerVersionState[],
): SessionRunnerVersionState {
  if (states.includes('stale')) return 'stale';
  return states.every((state) => state === 'current') ? 'current' : 'unknown';
}

export function resolveSessionRunnerRuntimeState(params: Readonly<{
  sessionId: string;
  tracked: TrackedSession | null | undefined;
  currentIdentity: SessionRunnerEntrypointIdentity;
  agentRuntimeVersionState?: SessionRunnerVersionState;
  agentRuntimeRestartUnavailableReason?: SessionRunnerRestartDisabledReason | null;
  resolveActivityDisabledReason?: (sessionId: string) => SessionRunnerRestartDisabledReason | null;
  machineId?: string | null;
  daemonId?: string | null;
  observedAtMs?: number;
}>): SessionRunnerRuntimeState {
  const tracked = params.tracked ?? null;
  const processIdentity = tracked ? resolveTrackedSessionRunnerIdentity(tracked) : null;
  const sessionId = normalizeString(params.sessionId) || normalizeString(tracked?.happySessionId);
  const runnerCommand = tracked ? readTrackedSessionRunnerProcessCommand(tracked) : undefined;
  const runnerIdentity = tracked
    ? resolveSessionRunnerEntrypointIdentityFromProcessCommand(runnerCommand)
    : { status: 'unknown', source: 'unknown', reason: 'empty_command' } satisfies SessionRunnerEntrypointIdentity;
  const disabledReason =
    resolveDisabledReason(tracked) ??
    (params.currentIdentity.status !== 'known' ? 'current_entrypoint_unknown' : null) ??
    params.agentRuntimeRestartUnavailableReason ??
    (sessionId ? params.resolveActivityDisabledReason?.(sessionId) ?? null : null);
  const versionState = params.agentRuntimeVersionState === 'unknown'
    && params.agentRuntimeRestartUnavailableReason === 'unsupported_backend'
    ? 'unknown'
    : foldVersionStates([
        resolveVersionState({
          runnerIdentity,
          currentIdentity: params.currentIdentity,
        }),
        ...(params.agentRuntimeVersionState
          ? [params.agentRuntimeVersionState]
          : []),
      ]);
  return {
    v: 1,
    sessionId,
    machineId: normalizeString(params.machineId) || null,
    daemonId: normalizeString(params.daemonId) || null,
    observedAtMs: params.observedAtMs ?? Date.now(),
    runner: {
      pid: tracked?.sessionRunnerPid ?? tracked?.pid ?? null,
      runtimeId: runnerIdentity.status === 'known' ? runnerIdentity.comparableId : null,
      cliVersion: runnerIdentity.status === 'known' ? runnerIdentity.entrypointVersion ?? null : null,
      entrypointVersion: runnerIdentity.status === 'known' ? runnerIdentity.entrypointVersion ?? null : null,
      processCommandHash: normalizeString(processIdentity?.processCommandHash) || null,
      entrypointSource: runnerIdentity.status === 'known' ? runnerIdentity.source : 'unknown',
      startedBy: readStartedBy(tracked?.startedBy),
      startingMode: readTrackedSessionRunnerStartingMode(tracked),
    },
    daemon: {
      cliVersion: params.currentIdentity.status === 'known'
        ? params.currentIdentity.entrypointVersion ?? null
        : null,
      startedWithCliVersion: params.currentIdentity.status === 'known'
        ? params.currentIdentity.entrypointVersion ?? null
        : null,
      currentEntrypointVersion: params.currentIdentity.status === 'known'
        ? params.currentIdentity.comparableId
        : null,
      currentEntrypointSource: readDaemonEntrypointSource(params.currentIdentity),
    },
    versionState,
    statusSource: params.agentRuntimeVersionState
      ? 'daemon_tracking'
      : runnerIdentity.status === 'known'
        ? 'process_command_inferred'
        : 'unknown',
    plannedRestart: {
      supported: !!tracked,
      eligible: disabledReason === null,
      disabledReason,
    },
  };
}

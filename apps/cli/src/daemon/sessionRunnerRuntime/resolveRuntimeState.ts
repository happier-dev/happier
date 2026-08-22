import type { TrackedSession } from '@/daemon/types';
import type { SessionRunnerDaemonEntrypointSourceV1 } from '@happier-dev/protocol';

import {
  isGenerationAttestedComparableId,
  resolveSessionRunnerEntrypointIdentityFromProcessCommand,
} from './resolveRunnerEntrypointIdentity';
import { readSessionRunnerStartingModeFromProcessCommand } from './readSessionRunnerStartingMode';
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

function resolveIdentityDisabledReason(input: Readonly<{
  runnerIdentity: SessionRunnerEntrypointIdentity;
  currentIdentity: SessionRunnerEntrypointIdentity;
}>): SessionRunnerRestartDisabledReason | null {
  if (input.currentIdentity.status !== 'known') return 'current_entrypoint_unknown';
  if (input.runnerIdentity.status !== 'known') return 'runner_entrypoint_unknown';
  if (
    input.runnerIdentity.comparableId === input.currentIdentity.comparableId
    && !isGenerationAttestedComparableId(input.runnerIdentity.comparableId)
  ) {
    return 'runner_generation_unattested';
  }
  return null;
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
  const sessionId = normalizeString(params.sessionId) || normalizeString(tracked?.happySessionId);
  const runnerIdentity = tracked
    ? resolveSessionRunnerEntrypointIdentityFromProcessCommand(tracked.processCommand)
    : { status: 'unknown', source: 'unknown', reason: 'empty_command' } satisfies SessionRunnerEntrypointIdentity;
  const disabledReason =
    resolveDisabledReason(tracked) ??
    resolveIdentityDisabledReason({ runnerIdentity, currentIdentity: params.currentIdentity }) ??
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
      pid: tracked?.pid ?? null,
      runtimeId: runnerIdentity.status === 'known' ? runnerIdentity.comparableId : null,
      cliVersion: runnerIdentity.status === 'known' ? runnerIdentity.entrypointVersion ?? null : null,
      entrypointVersion: runnerIdentity.status === 'known' ? runnerIdentity.entrypointVersion ?? null : null,
      processCommandHash: normalizeString(tracked?.processCommandHash) || null,
      entrypointSource: runnerIdentity.status === 'known' ? runnerIdentity.source : 'unknown',
      startedBy: readStartedBy(tracked?.startedBy),
      startingMode: readSessionRunnerStartingModeFromProcessCommand(tracked?.processCommand),
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

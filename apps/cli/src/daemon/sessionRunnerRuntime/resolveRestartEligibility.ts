import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { isSessionRunnerWindowsHostedLaunchV1, readSessionRunnerDaemonLaunchRefusalV1 } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV1';

import type { TrackedSession } from '@/daemon/types';
import { resolveTrackedSessionRunnerIdentity } from '../sessions/sessionReportCorrelation';

import {
  isSessionRunnerColdResumeSupported,
} from '../processSupervision/sessionRunnerRespawn';
import { readTrackedSessionRunnerStartingMode } from './readSessionRunnerStartingMode';
import type { SessionRunnerRestartDisabledReason } from './types';

export type SessionRunnerRestartEligibility =
  | Readonly<{ eligible: true; disabledReason: null }>
  | Readonly<{ eligible: false; disabledReason: SessionRunnerRestartDisabledReason }>;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isActiveTrackedRunner(tracked: TrackedSession): boolean {
  return Number.isInteger(tracked.pid) && tracked.pid > 0;
}

function hasExactProcessWitness(tracked: TrackedSession): boolean {
  const runner = resolveTrackedSessionRunnerIdentity(tracked);
  return !!normalizeString(tracked.processCommandHash)
    && Number.isInteger(tracked.processStartTimeMs)
    && (tracked.processStartTimeMs ?? -1) >= 0
    && !!runner
    && Number.isInteger(runner.pid) && runner.pid > 0
    && !!normalizeString(runner.processCommandHash)
    && Number.isInteger(runner.processStartTimeMs)
    && (runner.processStartTimeMs ?? -1) >= 0;
}

function hasSpawnOptions(tracked: TrackedSession): boolean {
  return !!normalizeString(tracked.spawnOptions?.directory);
}

export function hasSessionRunnerResumeIdentity(tracked: TrackedSession): boolean {
  // The Agent's resume ids are opaque: only presence is decided here.
  return (
    readNonBlankOpaqueIdentifier(tracked.spawnOptions?.resume) !== null ||
    readNonBlankOpaqueIdentifier(tracked.vendorResumeId) !== null ||
    !!normalizeString(tracked.spawnOptions?.existingSessionId)
  );
}

export function shouldRefreshSessionRunnerResumeIdentity(
  tracked: TrackedSession | null | undefined,
): tracked is TrackedSession {
  if (!tracked || hasSessionRunnerResumeIdentity(tracked)) return false;
  if (!isSessionRunnerColdResumeSupported({ trackedSession: tracked })) return false;
  return resolveSessionRunnerRestartEligibility(tracked).disabledReason === 'missing_resume_identity';
}

function isWindowsHostedRunner(tracked: TrackedSession): boolean {
  const launchMode = tracked.spawnOptions?.windowsRemoteSessionLaunchMode
    ?? tracked.spawnOptions?.windowsRemoteSessionConsole;
  return isSessionRunnerWindowsHostedLaunchV1(launchMode);
}

export function resolveSessionRunnerRestartEligibility(
  tracked: TrackedSession | null | undefined,
): SessionRunnerRestartEligibility {
  if (!tracked) return { eligible: false, disabledReason: 'no_tracked_process' };
  const daemonLaunchRefusal = readSessionRunnerDaemonLaunchRefusalV1(tracked.startedBy);
  if (daemonLaunchRefusal) return { eligible: false, disabledReason: daemonLaunchRefusal };
  if (readTrackedSessionRunnerStartingMode(tracked) !== 'remote') {
    return { eligible: false, disabledReason: 'not_remote_started' };
  }
  if (!isActiveTrackedRunner(tracked)) return { eligible: false, disabledReason: 'not_active' };
  if (tracked.runnerRestartAdmissionUnsupportedPid === (tracked.sessionRunnerPid ?? tracked.pid)) {
    return { eligible: false, disabledReason: 'restart_admission_unsupported' };
  }
  if (!hasExactProcessWitness(tracked)) {
    return {
      eligible: false,
      disabledReason: 'non_destructive_refresh_unsupported',
    };
  }
  if (!hasSpawnOptions(tracked)) return { eligible: false, disabledReason: 'missing_spawn_options' };
  if (!hasSessionRunnerResumeIdentity(tracked)) {
    return { eligible: false, disabledReason: 'missing_resume_identity' };
  }
  if (!isSessionRunnerColdResumeSupported({
    trackedSession: tracked,
  })) {
    return {
      eligible: false,
      disabledReason: 'missing_resume_identity',
    };
  }
  if (isWindowsHostedRunner(tracked)) return { eligible: false, disabledReason: 'windows_hosted_runner' };
  return { eligible: true, disabledReason: null };
}

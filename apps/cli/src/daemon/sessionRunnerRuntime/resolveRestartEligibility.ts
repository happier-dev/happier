import type { TrackedSession } from '@/daemon/types';

import { readSessionRunnerStartingModeFromProcessCommand } from './readSessionRunnerStartingMode';
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

function hasSpawnOptions(tracked: TrackedSession): boolean {
  return !!normalizeString(tracked.spawnOptions?.directory);
}

function hasResumeContext(tracked: TrackedSession): boolean {
  return !!(
    normalizeString(tracked.spawnOptions?.resume) ||
    normalizeString(tracked.vendorResumeId) ||
    normalizeString(tracked.spawnOptions?.existingSessionId)
  );
}

function isWindowsHostedRunner(tracked: TrackedSession): boolean {
  const launchMode = tracked.spawnOptions?.windowsRemoteSessionLaunchMode
    ?? tracked.spawnOptions?.windowsRemoteSessionConsole;
  return launchMode === 'windows_terminal' || launchMode === 'console' || launchMode === 'visible';
}

export function resolveSessionRunnerRestartEligibility(
  tracked: TrackedSession | null | undefined,
): SessionRunnerRestartEligibility {
  if (!tracked) return { eligible: false, disabledReason: 'no_tracked_process' };
  if (tracked.startedBy !== 'daemon') return { eligible: false, disabledReason: 'not_daemon_started' };
    if (readSessionRunnerStartingModeFromProcessCommand(tracked.processCommand) !== 'remote') {
        return { eligible: false, disabledReason: 'not_remote_started' };
    }
  if (!isActiveTrackedRunner(tracked)) return { eligible: false, disabledReason: 'not_active' };
  if (!hasSpawnOptions(tracked)) return { eligible: false, disabledReason: 'missing_spawn_options' };
  if (!hasResumeContext(tracked)) return { eligible: false, disabledReason: 'missing_resume_identity' };
  if (isWindowsHostedRunner(tracked)) return { eligible: false, disabledReason: 'windows_hosted_runner' };
  return { eligible: true, disabledReason: null };
}

import type { SessionRunnerStartingModeV1 } from '@happier-dev/protocol';
import type { TrackedSession } from '../types';
import { readTrackedSessionRunnerProcessCommand } from './resolveRunnerEntrypointIdentity';

/** A hosted Session's argv is not the shared host's OS command. */
export function readTrackedSessionRunnerStartingMode(
  tracked: TrackedSession | null | undefined,
): SessionRunnerStartingModeV1 {
  if (!tracked) return 'unknown';
  return tracked.sessionRunnerStartingMode
    ?? readSessionRunnerStartingModeFromProcessCommand(readTrackedSessionRunnerProcessCommand(tracked));
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readSessionRunnerStartingModeFromProcessCommand(
  processCommand: string | null | undefined,
): SessionRunnerStartingModeV1 {
  const command = normalizeString(processCommand);
  if (!command) return 'unknown';
  const match = /(?:^|\s)--happy-starting-mode(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(command);
  const value = normalizeString(match?.[1] ?? match?.[2] ?? match?.[3]);
  if (value === 'remote' || value === 'local') return value;
  return 'unknown';
}

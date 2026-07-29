import type { SessionRunnerStartingModeV1 } from '@happier-dev/protocol';

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

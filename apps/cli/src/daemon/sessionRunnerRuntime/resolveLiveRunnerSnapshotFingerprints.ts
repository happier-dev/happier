import type { LiveRunnerSnapshotFingerprints } from '@/utils/pinnedRunnerSnapshotPrune';

import { resolveSessionRunnerEntrypointIdentityFromProcessCommand } from './resolveRunnerEntrypointIdentity';

export type LiveRunnerSnapshotSource = Readonly<{
  processCommand?: string;
  childProcess?: { spawnargs?: readonly (string | undefined)[] } | undefined;
}>;

function resolveTrackedSessionCommand(source: LiveRunnerSnapshotSource): string | null {
  const spawnargs = source.childProcess?.spawnargs;
  if (Array.isArray(spawnargs)) {
    const command = spawnargs
      .filter((arg): arg is string => typeof arg === 'string' && arg.trim().length > 0)
      .join(' ');
    if (command) return command;
  }
  const command = typeof source.processCommand === 'string' ? source.processCommand.trim() : '';
  return command || null;
}

export function resolveLiveRunnerSnapshotFingerprints(
  trackedSessions: Iterable<LiveRunnerSnapshotSource>,
): LiveRunnerSnapshotFingerprints {
  try {
    const fingerprints = new Set<string>();
    for (const tracked of trackedSessions) {
      const command = resolveTrackedSessionCommand(tracked);
      if (!command) return { reliable: false, fingerprints: new Set() };
      const identity = resolveSessionRunnerEntrypointIdentityFromProcessCommand(command);
      if (identity.status !== 'known') return { reliable: false, fingerprints: new Set() };
      if (!identity.comparableId.startsWith('snapshot:')) continue;
      const fingerprint = identity.comparableId.slice('snapshot:'.length).trim();
      if (fingerprint) fingerprints.add(fingerprint);
    }
    return { reliable: true, fingerprints };
  } catch {
    return { reliable: false, fingerprints: new Set() };
  }
}

import { describe, expect, it } from 'vitest';

import { resolveLiveRunnerSnapshotFingerprints } from './resolveLiveRunnerSnapshotFingerprints';

describe('resolveLiveRunnerSnapshotFingerprints', () => {
  it('enumerates immutable snapshot identities from the tracked live-runner registry', () => {
    const result = resolveLiveRunnerSnapshotFingerprints([
      { processCommand: 'node /repo/apps/cli/.runner-snapshots/old-live/index.mjs claude' },
      { childProcess: { spawnargs: ['node', '/repo/apps/cli/.runner-snapshots/new-live/index.mjs', 'codex'] } },
    ]);

    expect(result.reliable).toBe(true);
    expect([...result.fingerprints].sort()).toEqual(['new-live', 'old-live']);
  });

  it('marks enumeration unreliable when a tracked runner has no conclusive identity', () => {
    const result = resolveLiveRunnerSnapshotFingerprints([
      { processCommand: 'node /repo/apps/cli/.runner-snapshots/old-live/index.mjs claude' },
      { processCommand: 'node /repo/apps/cli/.runner-sna' },
    ]);

    expect(result.reliable).toBe(false);
    expect(result.fingerprints.size).toBe(0);
  });
});

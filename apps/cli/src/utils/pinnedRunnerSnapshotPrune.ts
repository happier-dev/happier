export type LiveRunnerSnapshotFingerprints = Readonly<{
  reliable: boolean;
  fingerprints: ReadonlySet<string>;
}>;

export type PinnedRunnerSnapshotPruneDecision = Readonly<{
  deletable: readonly string[];
  skipped: 'live_data_unavailable' | 'live_data_unreliable' | null;
}>;

export function decidePinnedRunnerSnapshotPrune(params: Readonly<{
  entries: readonly Readonly<{ name: string; mtimeMs: number }>[];
  keepFingerprint: string;
  live: LiveRunnerSnapshotFingerprints | null | undefined;
  keepCount: number;
}>): PinnedRunnerSnapshotPruneDecision {
  if (!params.live) return { deletable: [], skipped: 'live_data_unavailable' };
  if (!params.live.reliable) return { deletable: [], skipped: 'live_data_unreliable' };

  const protectedNames = new Set(params.live.fingerprints);
  protectedNames.add(params.keepFingerprint);
  const keepCount = Math.max(0, Math.trunc(params.keepCount));
  const deadNewestFirst = params.entries
    .filter((entry) => !protectedNames.has(entry.name))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  return {
    deletable: deadNewestFirst.slice(keepCount).map((entry) => entry.name),
    skipped: null,
  };
}

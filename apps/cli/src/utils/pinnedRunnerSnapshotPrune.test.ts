import { describe, expect, it } from 'vitest';

import { decidePinnedRunnerSnapshotPrune } from './pinnedRunnerSnapshotPrune';

const entries = (count: number) => Array.from({ length: count }, (_, index) => ({
  name: `snapshot-${index}`,
  mtimeMs: index + 1,
}));

describe('decidePinnedRunnerSnapshotPrune', () => {
  it('protects an old live fingerprint beyond the eight-generation retention window', () => {
    const decision = decidePinnedRunnerSnapshotPrune({
      entries: entries(10),
      keepFingerprint: 'snapshot-9',
      live: { reliable: true, fingerprints: new Set(['snapshot-0']) },
      keepCount: 8,
    });

    expect(decision.deletable).not.toContain('snapshot-0');
    expect(decision.deletable).toEqual([]);
  });

  it.each([
    ['unavailable', null],
    ['unreliable', { reliable: false, fingerprints: new Set<string>() }],
  ] as const)('deletes nothing when live-runner enumeration is %s', (_label, live) => {
    const decision = decidePinnedRunnerSnapshotPrune({
      entries: entries(10),
      keepFingerprint: 'snapshot-9',
      live,
      keepCount: 8,
    });

    expect(decision.deletable).toEqual([]);
  });

  it('prunes an old fingerprint that reliable enumeration proves is not live', () => {
    const decision = decidePinnedRunnerSnapshotPrune({
      entries: entries(10),
      keepFingerprint: 'snapshot-9',
      live: { reliable: true, fingerprints: new Set() },
      keepCount: 8,
    });

    expect(decision.deletable).toEqual(['snapshot-0']);
  });
});

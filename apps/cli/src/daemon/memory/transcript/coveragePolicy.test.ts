import { describe, expect, it } from 'vitest';

import { applyMemoryCoveragePolicy, memoryIndexPolicyKey, resolveMemoryIndexPolicy } from './coveragePolicy';

const rows = [
  { seq: 1, createdAtMs: 1_000, text: 'one' },
  { seq: 3, createdAtMs: 3_000, text: 'three' },
  { seq: 2, createdAtMs: 2_000, text: 'two' },
];

describe('applyMemoryCoveragePolicy', () => {
  it('changes policy identity for enable timestamps only when coverage consumes them', () => {
    const fullHistory = { coveragePolicy: { type: 'full' as const }, backfillPolicy: 'all_history' as const };
    const keyAt = (policy: Parameters<typeof resolveMemoryIndexPolicy>[0], enabledAtMs: number) =>
      memoryIndexPolicyKey(resolveMemoryIndexPolicy({ ...policy, enabledAtMs }));
    expect(keyAt(fullHistory, 1_000)).toBe(keyAt(fullHistory, 2_000));
    expect(keyAt({ ...fullHistory, backfillPolicy: 'new_only' }, 1_000))
      .not.toBe(keyAt({ ...fullHistory, backfillPolicy: 'new_only' }, 2_000));
    expect(keyAt({ ...fullHistory, coveragePolicy: { type: 'since_enabled' } }, 1_000))
      .not.toBe(keyAt({ ...fullHistory, coveragePolicy: { type: 'since_enabled' } }, 2_000));
  });

  it('keeps exactly the latest semantic-message count in sequence order', () => {
    expect(applyMemoryCoveragePolicy({
      items: rows,
      policy: { type: 'latest_messages', maxSemanticMessagesPerSession: 2 },
      nowMs: 10_000,
      enabledAtMs: 0,
    }).map((row) => row.seq)).toEqual([2, 3]);
  });

  it('uses an inclusive exact created-at cutoff for latest_days', () => {
    const dayMs = 24 * 60 * 60 * 1_000;
    const items = [
      { seq: 1, createdAtMs: dayMs - 1 },
      { seq: 2, createdAtMs: dayMs },
      { seq: 3, createdAtMs: dayMs + 1 },
    ];
    expect(applyMemoryCoveragePolicy({
      items,
      policy: { type: 'latest_days', days: 1 },
      nowMs: dayMs * 2,
      enabledAtMs: 0,
    }).map((row) => row.seq)).toEqual([2, 3]);
  });

  it('uses the persisted enablement instant for since_enabled', () => {
    expect(applyMemoryCoveragePolicy({
      items: rows,
      policy: { type: 'since_enabled' },
      nowMs: 10_000,
      enabledAtMs: 2_000,
    }).map((row) => row.seq)).toEqual([2, 3]);
  });

  it('does not impose a coverage cutoff for full', () => {
    expect(applyMemoryCoveragePolicy({
      items: rows,
      policy: { type: 'full' },
      nowMs: 10_000,
      enabledAtMs: 9_000,
    }).map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it('keeps new_only separate from coverage and reconstructs only post-enable semantic items', () => {
    expect(applyMemoryCoveragePolicy({
      items: rows,
      policy: { type: 'full' },
      backfillPolicy: 'new_only',
      nowMs: 10_000,
      enabledAtMs: 2_000,
    }).map((row) => row.seq)).toEqual([2, 3]);
  });

});

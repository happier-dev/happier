import { describe, expect, it } from 'vitest';

import type { CodeIntelligenceActivityEventV1, CodeIntelligenceSnapshotResponseV1 } from '@happier-dev/protocol';

import { mergeCodeIntelligenceSnapshot, type CodeIntelligenceViewState } from './mergeCodeIntelligenceSnapshot';

type OkSnapshot = Extract<CodeIntelligenceSnapshotResponseV1, { ok: true }>;

function event(seq: number): CodeIntelligenceActivityEventV1 {
  return { seq, kind: 'commit_observed', atMs: seq * 1000, repositoryId: 'r', worktreePath: '/w', sessionId: null, commitSha: `sha${seq}`, data: {} };
}

function snapshot(overrides: Partial<OkSnapshot> = {}): OkSnapshot {
  return {
    ok: true,
    worker: { state: 'idle', lastSweepAtMs: 1, lastError: null },
    repositories: [{ repositoryId: 'r', displayName: 'shop', commonDirPath: '/w/.git', registeredAtMs: 1, registrationSource: 'session', worktrees: [] }],
    sessions: [],
    commits: [],
    events: [],
    latestSeq: 0,
    eventsTruncated: false,
    ...overrides,
  };
}

describe('mergeCodeIntelligenceSnapshot', () => {
  it('appends incremental events newest-first and keeps unchanged collections by reference', () => {
    const initial = mergeCodeIntelligenceSnapshot(null, snapshot({ events: [event(1), event(2)], latestSeq: 2 }));
    const next = mergeCodeIntelligenceSnapshot(initial, snapshot({ events: [event(3)], latestSeq: 3 }));

    expect(next.events.map((item) => item.seq)).toEqual([3, 2, 1]);
    expect(next.latestSeq).toBe(3);
    expect(next.repositories).toBe(initial.repositories);
    expect(next.sessions).toBe(initial.sessions);
  });

  it('returns the previous state itself when nothing changed', () => {
    const initial = mergeCodeIntelligenceSnapshot(null, snapshot({ events: [event(1)], latestSeq: 1 }));
    expect(mergeCodeIntelligenceSnapshot(initial, snapshot({ latestSeq: 1 }))).toBe(initial);
  });

  it('replaces the feed when the daemon reports the cursor fell behind retention', () => {
    const initial: CodeIntelligenceViewState = mergeCodeIntelligenceSnapshot(null, snapshot({ events: [event(1), event(2)], latestSeq: 2 }));
    const next = mergeCodeIntelligenceSnapshot(initial, snapshot({ events: [event(9)], latestSeq: 9, eventsTruncated: true }));

    expect(next.events.map((item) => item.seq)).toEqual([9]);
  });
});

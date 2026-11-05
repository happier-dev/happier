import { describe, expect, it } from 'vitest';
import type { SessionStateReadV1 } from '@happier-dev/plugin-ui';
import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import type { TriageDetailPrimaryWriteV1 } from '@happier-dev/triage-sources/ui';

import {
  readTriageActivityNextV1,
  readTriageActivitySessionEventsV1,
} from './activityAgent.js';

function state(
  latestActivity: SessionStateV1['latestActivity'],
): SessionStateReadV1 {
  return {
    status: 'ready',
    state: {
      sessionId: 's1',
      title: 'Fix failing checks on #54',
      agent: { agentId: 'codex', displayName: 'Codex' },
      lifecycle: 'active',
      runtime: 'waiting',
      operational: 'ready',
      workStatus: {
        state: 'ready',
        bucket: 'idle',
        tone: 'neutral',
        attentionType: null,
        word: 'Ready',
      },
      pendingPermissions: [],
      ...(latestActivity === undefined ? {} : { latestActivity }),
    } as SessionStateV1,
  };
}

const merge = (
  readiness: TriageDetailPrimaryWriteV1['readiness'],
): TriageDetailPrimaryWriteV1 => ({
  id: 'merge',
  title: 'Merge',
  disabledReason: null,
  pending: false,
  readiness,
  execute: async () => {},
});

describe("the Activity's Happier half", () => {
  it("adds a linked Session's latest reported activity, by its agent, at its own time, and nothing it cannot say", () => {
    const sessions = [
      { sessionId: 's1' },
      { sessionId: 's2' },
      { sessionId: 's3' },
    ] as const;
    const reads = new Map<string, SessionStateReadV1>([
      [
        's1',
        state({
          kind: 'ready',
          text: 'A full agent reply\n<options><option>Continue</option></options>',
          createdAt: 1_000,
        }),
      ],
      ['s2', state({ kind: 'hidden' })],
      ['s3', { status: 'loading', state: null }],
    ]);
    expect(readTriageActivitySessionEventsV1(sessions, reads)).toEqual([
      {
        id: 'happier-session:s1:1000',
        atMs: 1_000,
        kind: 'session',
        actor: 'Codex',
        summary: 'Fix failing checks on #54',
      },
    ]);
  });

  it('does not fall back to raw transcript text when the host has no Session title', () => {
    const read = state({ kind: 'ready', text: '<options>Private raw reply</options>', createdAt: 1000 });
    expect(readTriageActivitySessionEventsV1([{ sessionId: 's1' }], new Map([
      ['s1', { ...read, state: { ...read.state!, title: undefined } }],
    ]))).toEqual([]);
  });

  it('says what still stands before merging, and stays quiet while the agent is waiting on the reader', () => {
    const blocked = merge({
      label: 'Blocked',
      enabled: false,
      reason: 'Checks re-run on the new head',
    });
    expect(readTriageActivityNextV1(blocked, false)).toBe(
      'Checks re-run on the new head',
    );
    expect(readTriageActivityNextV1(blocked, true)).toBeNull();
    expect(readTriageActivityNextV1(merge(undefined), false)).toBeNull();
    expect(readTriageActivityNextV1(null, false)).toBeNull();
  });
});

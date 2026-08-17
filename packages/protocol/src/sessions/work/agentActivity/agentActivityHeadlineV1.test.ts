import { describe, expect, it } from 'vitest';

import {
  SESSION_AGENT_ACTIVITY_RECENT_ENTRIES_LIMIT,
  buildSessionAgentActivityHeadline,
  resolvePrimaryAgentActivityEntryId,
  sortActiveAgentActivityEntries,
} from './agentActivityHeadlineBuild.js';
import type { SessionAgentActivityEntryV1 } from './agentActivityEntryV1.js';
import {
  SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY,
  parseSessionAgentActivityHeadlineV1,
  readSessionAgentActivityHeadlineFromMetadata,
} from './agentActivityHeadlineV1.js';

function entry(overrides: Partial<SessionAgentActivityEntryV1> = {}): SessionAgentActivityEntryV1 {
  return {
    entryId: 'workflow_agent:wf_1:a1',
    kind: 'workflow_agent',
    title: 'Audit the corridor',
    status: 'running',
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('agent-activity headline bounding', () => {
  it('never caps active entries', () => {
    // A roster that is quietly incomplete is worse than one that says it is partial. How much work
    // runs concurrently is provider behaviour; the transport does not get to decide it.
    const entries = Array.from({ length: SESSION_AGENT_ACTIVITY_RECENT_ENTRIES_LIMIT * 4 }, (_, index) => entry({
      entryId: `workflow_agent:wf_1:a${String(index).padStart(3, '0')}`,
      updatedAt: 1_000 + index,
    }));

    const headline = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 2_000,
      entries,
      recentEntriesLimit: 2,
    });

    expect(headline.activeEntries).toHaveLength(entries.length);
    expect(headline.truncated).toBeUndefined();
  });

  it('bounds only terminal history, newest first, and reports what it dropped', () => {
    const entries = [
      entry({ entryId: 'workflow_agent:wf_1:t1', status: 'succeeded', updatedAt: 1_000 }),
      entry({ entryId: 'workflow_agent:wf_1:t2', status: 'failed', updatedAt: 3_000 }),
      entry({ entryId: 'workflow_agent:wf_1:t3', status: 'cancelled', updatedAt: 2_000 }),
      entry({ entryId: 'workflow_agent:wf_1:live', status: 'running', updatedAt: 500 }),
    ];

    const headline = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 4_000,
      entries,
      recentEntriesLimit: 2,
    });

    expect(headline.activeEntries.map((item) => item.entryId)).toEqual(['workflow_agent:wf_1:live']);
    expect(headline.recentEntries?.map((item) => item.entryId)).toEqual([
      'workflow_agent:wf_1:t2',
      'workflow_agent:wf_1:t3',
    ]);
    expect(headline.truncated).toEqual({ reason: 'entry_limit', omittedCount: 1 });
  });

  it('keeps an ambiguous entry in the roster instead of filing it as finished history', () => {
    // `unknown` is not terminal, so a terminal-history cap can never drop a row that may still be
    // working.
    const headline = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 2_000,
      entries: [entry({ entryId: 'workflow_agent:wf_1:amb', status: 'unknown' })],
      recentEntriesLimit: 0,
    });

    expect(headline.activeEntries.map((item) => item.entryId)).toEqual(['workflow_agent:wf_1:amb']);
    expect(headline.recentEntries).toBeUndefined();
  });
});

describe('agent-activity headline ordering', () => {
  it('orders active work by escalation, then identity — never by progress timestamp', () => {
    const entries = [
      entry({ entryId: 'workflow_agent:wf_1:z-running', status: 'running', updatedAt: 9_999 }),
      entry({ entryId: 'workflow_agent:wf_1:a-queued', status: 'queued', updatedAt: 9_998 }),
      entry({ entryId: 'workflow_agent:wf_1:m-waiting', status: 'waiting', updatedAt: 1 }),
      entry({ entryId: 'workflow_agent:wf_1:b-running', status: 'running', updatedAt: 2 }),
    ];

    expect(sortActiveAgentActivityEntries(entries).map((item) => item.entryId)).toEqual([
      'workflow_agent:wf_1:m-waiting',
      'workflow_agent:wf_1:b-running',
      'workflow_agent:wf_1:z-running',
      'workflow_agent:wf_1:a-queued',
    ]);
  });

  it('does not reorder the active list when only a progress timestamp moves', () => {
    // The badge and the popover are read while the work runs. An `updatedAt`-ordered active list
    // reshuffles under the reader on every tick.
    const before = [
      entry({ entryId: 'workflow_agent:wf_1:a', status: 'running', updatedAt: 1_000 }),
      entry({ entryId: 'workflow_agent:wf_1:b', status: 'running', updatedAt: 1_001 }),
    ];
    const after = [
      entry({ entryId: 'workflow_agent:wf_1:a', status: 'running', updatedAt: 1_000 }),
      entry({ entryId: 'workflow_agent:wf_1:b', status: 'running', updatedAt: 9_999_999 }),
    ];

    expect(sortActiveAgentActivityEntries(after).map((item) => item.entryId))
      .toEqual(sortActiveAgentActivityEntries(before).map((item) => item.entryId));
  });

  it('is a total order, so two clients given the same entries pick the same primary', () => {
    const entries = [
      entry({ entryId: 'workflow_agent:wf_1:b', status: 'running' }),
      entry({ entryId: 'workflow_agent:wf_1:a', status: 'running' }),
    ];
    const reversed = [...entries].reverse();

    expect(resolvePrimaryAgentActivityEntryId(entries))
      .toBe(resolvePrimaryAgentActivityEntryId(reversed));
    expect(resolvePrimaryAgentActivityEntryId(entries)).toBe('workflow_agent:wf_1:a');
    expect(resolvePrimaryAgentActivityEntryId([])).toBeNull();
  });

  it('reports a null primary when every entry has finished', () => {
    const headline = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 2_000,
      entries: [entry({ status: 'succeeded' })],
    });
    expect(headline.primaryEntryId).toBeNull();
    expect(headline.activeEntries).toEqual([]);
  });
});

describe('agent-activity headline projection', () => {
  it('drops detail a caller attached, at the producer chokepoint', () => {
    const detailed = {
      ...entry(),
      summary: 'a whole result',
      resultPreview: 'lots of text',
      tokensUsed: 12_345,
    } as unknown as SessionAgentActivityEntryV1;

    const headline = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 2_000,
      entries: [detailed],
    });

    expect(Object.keys(headline.activeEntries[0]!).sort()).toEqual([
      'entryId',
      'kind',
      'status',
      'title',
      'updatedAt',
    ]);
  });

  it('never fabricates a start it was not given', () => {
    const headline = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 2_000,
      entries: [entry({ updatedAt: 1_500 })],
    });
    expect(headline.activeEntries[0]).not.toHaveProperty('startedAt');
  });
});

describe('agent-activity headline reading', () => {
  it('reads a headline an older producer wrote without the optional fields', () => {
    // Every field a later build added is optional, and this is the shape a producer that predates
    // them emits. A reader that required any of them would empty the roster on every such session.
    const parsed = parseSessionAgentActivityHeadlineV1({
      v: 1,
      backendId: 'claude',
      updatedAt: 1_000,
      activeEntries: [{
        entryId: 'workflow_agent:wf_1:a1',
        kind: 'workflow_agent',
        title: 'Audit the corridor',
        status: 'running',
        updatedAt: 1_000,
      }],
    });

    expect(parsed?.activeEntries).toHaveLength(1);
    expect(parsed?.recentEntries).toBeUndefined();
    expect(parsed?.truncated).toBeUndefined();
    expect(parsed?.primaryEntryId).toBeUndefined();
    expect(parsed?.activeEntries[0]).not.toHaveProperty('startedAt');
  });

  it('keeps the entries it can read when a newer producer sends a kind it cannot', () => {
    // A whole-array parse would take the ENTIRE roster to null on the first entry from a newer
    // producer, turning a forward-compatible addition into a regression for every older client.
    const parsed = parseSessionAgentActivityHeadlineV1({
      v: 1,
      backendId: 'claude',
      updatedAt: 1_000,
      activeEntries: [
        { entryId: 'background_task:t1', kind: 'background_task', title: 'From the future', status: 'running', updatedAt: 1_000 },
        entry({ entryId: 'workflow_agent:wf_1:a1' }),
      ],
    });

    expect(parsed?.activeEntries.map((item) => item.entryId)).toEqual(['workflow_agent:wf_1:a1']);
    // A parse drop is NOT a producer bound; reporting it as one would claim a decision the producer
    // never made.
    expect(parsed?.truncated).toBeUndefined();
  });

  it('preserves a sidechain id a predecessor producer published', () => {
    // No producer in this repository writes it yet, but `../remote-dev` does, and a strip-by-default
    // schema without the field would silently discard the only thing that makes such a row openable.
    const parsed = parseSessionAgentActivityHeadlineV1({
      v: 1,
      backendId: 'claude',
      updatedAt: 1_000,
      activeEntries: [{ ...entry(), sidechainId: 'toolu_01ABC' }],
    });
    expect(parsed?.activeEntries[0]?.sidechainId).toBe('toolu_01ABC');
  });

  it('returns null rather than throwing for anything that is not a v1 headline', () => {
    expect(parseSessionAgentActivityHeadlineV1(undefined)).toBeNull();
    expect(parseSessionAgentActivityHeadlineV1({ v: 2, backendId: 'claude', updatedAt: 1, activeEntries: [] })).toBeNull();
    expect(parseSessionAgentActivityHeadlineV1('nonsense')).toBeNull();
  });

  it('reads null from metadata written by a producer that predates the key', () => {
    // The state of every session on an older daemon. It must degrade to "no roster published", not
    // to a thrown read.
    expect(readSessionAgentActivityHeadlineFromMetadata({
      sessionWorkflowActivityHeadlineV1: { v: 1, backendId: 'claude', updatedAt: 1, activeRuns: [] },
    })).toBeNull();
    expect(readSessionAgentActivityHeadlineFromMetadata(null)).toBeNull();
    expect(readSessionAgentActivityHeadlineFromMetadata({
      [SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]: buildSessionAgentActivityHeadline({
        backendId: 'claude',
        updatedAt: 1_000,
        entries: [entry()],
      }),
    })?.activeEntries).toHaveLength(1);
  });
});

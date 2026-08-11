import { describe, expect, it } from 'vitest';

import type { SessionAgentActivityEntryV1 } from './agentActivityEntryV1.js';
import {
  SESSION_AGENT_ACTIVITY_RECENT_ENTRIES_LIMIT,
  buildSessionAgentActivityHeadline,
  resolvePrimaryAgentActivityEntryId,
  sortActiveAgentActivityEntries,
} from './agentActivityHeadlineBuild.js';
import {
  SessionAgentActivityHeadlineV1Schema,
  parseSessionAgentActivityHeadlineV1,
} from './agentActivityHeadlineV1.js';

function entry(overrides: Partial<SessionAgentActivityEntryV1> & { entryId: string }): SessionAgentActivityEntryV1 {
  return {
    kind: 'workflow_run',
    title: `run ${overrides.entryId}`,
    status: 'running',
    updatedAt: 1000,
    ...overrides,
  };
}

describe('buildSessionAgentActivityHeadline', () => {
  it('keeps every live entry and never caps the active side', () => {
    const entries = Array.from({ length: 30 }, (_, index) => entry({ entryId: `a_${index}`, updatedAt: 1000 + index }));
    const headline = buildSessionAgentActivityHeadline({ backendId: 'claude', updatedAt: 5000, entries });
    expect(headline.activeEntries).toHaveLength(30);
    expect(headline.truncated).toBeUndefined();
  });

  it('bounds terminal history to the recent-entries limit and records what it dropped', () => {
    const finished = Array.from({ length: SESSION_AGENT_ACTIVITY_RECENT_ENTRIES_LIMIT + 6 }, (_, index) => entry({
      entryId: `t_${String(index).padStart(3, '0')}`,
      status: 'succeeded',
      updatedAt: 1000 + index,
    }));
    const headline = buildSessionAgentActivityHeadline({ backendId: 'claude', updatedAt: 5000, entries: finished });
    expect(headline.activeEntries).toHaveLength(0);
    expect(headline.recentEntries).toHaveLength(SESSION_AGENT_ACTIVITY_RECENT_ENTRIES_LIMIT);
    expect(headline.truncated).toEqual({ reason: 'entry_limit', omittedCount: 6 });
    // Newest outcome first.
    expect(headline.recentEntries?.[0]?.entryId).toBe(`t_${String(finished.length - 1).padStart(3, '0')}`);
  });

  it('orders active entries by escalation, not by progress: a ticking updatedAt never reshuffles the roster', () => {
    const headline = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 5000,
      entries: [
        entry({ entryId: 'e_running_new', status: 'running', updatedAt: 9000 }),
        entry({ entryId: 'e_queued', status: 'queued', updatedAt: 8000 }),
        entry({ entryId: 'e_waiting', status: 'waiting', updatedAt: 1 }),
        entry({ entryId: 'e_running_old', status: 'running', updatedAt: 2 }),
      ],
    });
    expect(headline.activeEntries.map((item) => item.entryId)).toEqual([
      'e_waiting',
      'e_running_new',
      'e_running_old',
      'e_queued',
    ]);
    expect(headline.primaryEntryId).toBe('e_waiting');
  });

  it('keeps an `unknown` entry live: an ambiguous entry is never bounded away as history', () => {
    const headline = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 5000,
      recentEntriesLimit: 0,
      entries: [entry({ entryId: 'e_unknown', status: 'unknown' })],
    });
    expect(headline.activeEntries.map((item) => item.entryId)).toEqual(['e_unknown']);
    expect(headline.recentEntries).toBeUndefined();
  });

  it('returns a null primary when nothing is live', () => {
    const headline = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 5000,
      entries: [entry({ entryId: 'done', status: 'succeeded' })],
    });
    expect(headline.primaryEntryId).toBeNull();
    expect(headline.activeEntries).toHaveLength(0);
  });

  /**
   * D-8: a terminal row whose `startedAt` was back-filled from its finish timestamp renders a 16 s
   * run as `0:00`. The builder must publish the absence rather than a plausible number.
   */
  it('never fabricates startedAt from a finish or evidence timestamp (D-8)', () => {
    const headline = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 5000,
      entries: [
        entry({ entryId: 'no_start', status: 'succeeded', updatedAt: 4000 }),
        entry({ entryId: 'real_start', status: 'running', startedAt: 3000 }),
      ],
    });
    expect(headline.recentEntries?.[0]).not.toHaveProperty('startedAt');
    expect(headline.activeEntries[0]?.startedAt).toBe(3000);
  });

  it('projects detail out of the headline at the producer chokepoint', () => {
    const leaky = {
      ...entry({ entryId: 'wf_1' }),
      transcript: [{ role: 'assistant', text: 'secret' }],
      resultPreview: 'leaked preview',
    } as unknown as SessionAgentActivityEntryV1;
    const headline = buildSessionAgentActivityHeadline({ backendId: 'claude', updatedAt: 5000, entries: [leaky] });
    const built = headline.activeEntries[0]!;
    expect(built).not.toHaveProperty('transcript');
    expect(built).not.toHaveProperty('resultPreview');
    expect(SessionAgentActivityHeadlineV1Schema.safeParse(headline).success).toBe(true);
  });

  it('carries the optional agentId only when the producer has one', () => {
    const withAgent = buildSessionAgentActivityHeadline({ backendId: 'claude', agentId: 'claude', updatedAt: 1, entries: [] });
    const withoutAgent = buildSessionAgentActivityHeadline({ backendId: 'claude', updatedAt: 1, entries: [] });
    expect(withAgent.agentId).toBe('claude');
    expect(withoutAgent).not.toHaveProperty('agentId');
  });
});

describe('sortActiveAgentActivityEntries / resolvePrimaryAgentActivityEntryId', () => {
  it('is a total order: equal status falls back to ascending entryId', () => {
    const entries = [entry({ entryId: 'b' }), entry({ entryId: 'a' })];
    expect(sortActiveAgentActivityEntries(entries).map((item) => item.entryId)).toEqual(['a', 'b']);
    expect(resolvePrimaryAgentActivityEntryId(entries)).toBe('a');
  });

  it('returns a null primary for an empty active set', () => {
    expect(resolvePrimaryAgentActivityEntryId([])).toBeNull();
  });
});

describe('SessionAgentActivityHeadlineV1Schema', () => {
  it('round-trips a built headline and strips unknown top-level keys', () => {
    const headline = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 5000,
      entries: [entry({ entryId: 'wf_1' })],
    });
    const parsed = SessionAgentActivityHeadlineV1Schema.parse({ ...headline, sessionSecret: 'leak' });
    expect(parsed).not.toHaveProperty('sessionSecret');
    expect(parsed.activeEntries[0]?.entryId).toBe('wf_1');
  });

  it('rejects a headline without its version marker or backend id', () => {
    const headline = buildSessionAgentActivityHeadline({ backendId: 'claude', updatedAt: 1, entries: [] });
    const { v, ...withoutVersion } = headline;
    void v;
    const { backendId, ...withoutBackend } = headline;
    void backendId;
    expect(SessionAgentActivityHeadlineV1Schema.safeParse(withoutVersion).success).toBe(false);
    expect(SessionAgentActivityHeadlineV1Schema.safeParse(withoutBackend).success).toBe(false);
  });
});

describe('parseSessionAgentActivityHeadlineV1', () => {
  it('returns null instead of throwing for anything that is not a v1 headline', () => {
    for (const value of [undefined, null, 'headline', 42, [], {}, { v: 2, backendId: 'claude', updatedAt: 1, activeEntries: [] }]) {
      expect(parseSessionAgentActivityHeadlineV1(value)).toBeNull();
    }
  });

  /**
   * Forward compatibility across the version skew this program creates on purpose: Phase 5 adds
   * `background_task` to the kind union. A client that predates it must keep showing the roster it
   * can understand instead of losing the whole headline to one unreadable row.
   */
  it('drops an entry whose kind or status this build does not know, and keeps the rest', () => {
    const headline = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 5000,
      entries: [entry({ entryId: 'known' }), entry({ entryId: 'known_done', status: 'succeeded' })],
    });
    const fromNewerProducer = {
      ...headline,
      activeEntries: [
        ...headline.activeEntries,
        { ...entry({ entryId: 'future_kind' }), kind: 'background_task' },
        { ...entry({ entryId: 'future_status' }), status: 'hibernating' },
      ],
      recentEntries: [
        ...(headline.recentEntries ?? []),
        { ...entry({ entryId: 'future_done', status: 'succeeded' }), kind: 'background_task' },
      ],
    };

    const parsed = parseSessionAgentActivityHeadlineV1(fromNewerProducer);
    expect(parsed?.activeEntries.map((item) => item.entryId)).toEqual(['known']);
    expect(parsed?.recentEntries?.map((item) => item.entryId)).toEqual(['known_done']);
  });

  it('keeps the envelope when every entry is unreadable rather than reporting no activity source', () => {
    const parsed = parseSessionAgentActivityHeadlineV1({
      v: 1,
      backendId: 'claude',
      updatedAt: 5000,
      primaryEntryId: 'future',
      activeEntries: [{ entryId: 'future', kind: 'background_task', title: 't', status: 'running', updatedAt: 1 }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.activeEntries).toEqual([]);
  });

  it('does not turn dropped entries into a truncation claim', () => {
    const parsed = parseSessionAgentActivityHeadlineV1({
      v: 1,
      backendId: 'claude',
      updatedAt: 5000,
      activeEntries: [{ entryId: 'future', kind: 'background_task', title: 't', status: 'running', updatedAt: 1 }],
    });
    expect(parsed?.truncated).toBeUndefined();
  });
});

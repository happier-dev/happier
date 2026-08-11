import { describe, expect, it } from 'vitest';

import {
  SESSION_AGENT_ACTIVITY_ENTRY_TITLE_MAX,
  SessionAgentActivityEntryV1Schema,
  projectAgentActivityEntry,
  resolveAgentActivityEntryActivePriority,
  type SessionAgentActivityEntryV1,
} from './agentActivityEntryV1.js';
import {
  AGENT_ACTIVITY_STATUSES_V1,
  isInProgressAgentActivityStatus,
  isTerminalAgentActivityStatus,
} from './agentActivityStatusV1.js';

function entry(overrides: Partial<SessionAgentActivityEntryV1> = {}): SessionAgentActivityEntryV1 {
  return {
    entryId: 'workflow_run:wf_1',
    kind: 'workflow_run',
    title: 'Refactor the parser',
    status: 'running',
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('SessionAgentActivityEntryV1Schema', () => {
  it('accepts the minimal entry: identity, kind, title, status and an evidence timestamp', () => {
    expect(SessionAgentActivityEntryV1Schema.safeParse(entry()).success).toBe(true);
  });

  it('rejects a blank identity, a blank title and a blank optional id', () => {
    expect(SessionAgentActivityEntryV1Schema.safeParse(entry({ entryId: '  ' })).success).toBe(false);
    expect(SessionAgentActivityEntryV1Schema.safeParse(entry({ title: '   ' })).success).toBe(false);
    expect(SessionAgentActivityEntryV1Schema.safeParse(entry({ sidechainId: '' })).success).toBe(false);
    expect(SessionAgentActivityEntryV1Schema.safeParse(entry({ runId: '' })).success).toBe(false);
    expect(SessionAgentActivityEntryV1Schema.safeParse(entry({ parentId: '' })).success).toBe(false);
  });

  it('rejects a kind that has no proven writer yet (PLAN 5.1 item 11)', () => {
    for (const kind of ['subagent', 'execution_run', 'agent_team_member', 'background_task', 'scheduled_run']) {
      expect(SessionAgentActivityEntryV1Schema.safeParse(entry({ kind: kind as never })).success).toBe(false);
    }
  });

  it('rejects a status outside the protocol vocabulary', () => {
    expect(SessionAgentActivityEntryV1Schema.safeParse(entry({ status: 'timeout' as never })).success).toBe(false);
    expect(SessionAgentActivityEntryV1Schema.safeParse(entry({ status: 'paused' as never })).success).toBe(false);
  });

  it('bounds the title so one entry cannot dominate the session-metadata payload', () => {
    const atMax = 'x'.repeat(SESSION_AGENT_ACTIVITY_ENTRY_TITLE_MAX);
    expect(SessionAgentActivityEntryV1Schema.safeParse(entry({ title: atMax })).success).toBe(true);
    expect(SessionAgentActivityEntryV1Schema.safeParse(entry({ title: `${atMax}x` })).success).toBe(false);
  });

  it('keeps startedAt optional: an unknown start is absent, never zero (D-8)', () => {
    const parsed = SessionAgentActivityEntryV1Schema.parse(entry());
    expect(parsed).not.toHaveProperty('startedAt');
    expect(SessionAgentActivityEntryV1Schema.safeParse(entry({ startedAt: 1_699_999_000_000 })).success).toBe(true);
  });

  /**
   * The freshness half of the pointer contract.
   *
   * A pointer that cannot say WHICH version of the record it points at forces every consumer to
   * choose between refetching forever and never refetching at all. The consumer that hydrates
   * `activity/workflow_run.v1` chose the latter, so a run hydrated once and then froze while it kept
   * looking live.
   *
   * OPTIONAL and additive on purpose: a released producer that predates the field omits it, and a
   * reader must still work against that producer — which is the case live today.
   */
  it('accepts a record revision, and still accepts an entry from a producer that has none', () => {
    expect(SessionAgentActivityEntryV1Schema.safeParse(entry({ recordRevision: '7' })).success).toBe(true);
    const withoutRevision = SessionAgentActivityEntryV1Schema.parse(entry());
    expect(withoutRevision).not.toHaveProperty('recordRevision');
  });

  it('rejects a blank record revision: absent is a state, empty is a producer bug', () => {
    expect(SessionAgentActivityEntryV1Schema.safeParse(entry({ recordRevision: '   ' })).success).toBe(false);
  });

  it('strips transcript, preview and payload detail on parse — the headline is a pointer, not a record', () => {
    const parsed = SessionAgentActivityEntryV1Schema.parse({
      ...entry(),
      transcript: [{ role: 'assistant', text: 'secret' }],
      resultPreview: 'leaked preview',
      summary: 'leaked summary',
      tokensUsed: 4096,
      messages: ['leak'],
    });
    expect(parsed).not.toHaveProperty('transcript');
    expect(parsed).not.toHaveProperty('resultPreview');
    expect(parsed).not.toHaveProperty('summary');
    expect(parsed).not.toHaveProperty('tokensUsed');
    expect(parsed).not.toHaveProperty('messages');
    expect(parsed.entryId).toBe('workflow_run:wf_1');
  });
});

describe('projectAgentActivityEntry', () => {
  it('drops detail the producer never should have attached', () => {
    const projected = projectAgentActivityEntry({
      ...entry(),
      resultPreview: 'leaked preview',
      transcript: ['leak'],
    } as unknown as SessionAgentActivityEntryV1);
    expect(projected).not.toHaveProperty('resultPreview');
    expect(projected).not.toHaveProperty('transcript');
    expect(SessionAgentActivityEntryV1Schema.safeParse(projected).success).toBe(true);
  });

  it('omits absent optionals instead of writing undefined keys', () => {
    const projected = projectAgentActivityEntry(entry());
    expect(Object.keys(projected).sort()).toEqual(['entryId', 'kind', 'status', 'title', 'updatedAt']);
  });

  it('carries the optional identity pointers through unchanged', () => {
    const projected = projectAgentActivityEntry(entry({
      kind: 'workflow_agent',
      startedAt: 10,
      sidechainId: 'sc_1',
      runId: 'wf_1',
      parentId: 'workflow_run:wf_1',
    }));
    expect(projected).toMatchObject({ startedAt: 10, sidechainId: 'sc_1', runId: 'wf_1', parentId: 'workflow_run:wf_1' });
  });

  it('carries a record revision through, and omits it for a producer that has none', () => {
    expect(projectAgentActivityEntry(entry({ recordRevision: '7' }))).toMatchObject({ recordRevision: '7' });
    expect(projectAgentActivityEntry(entry())).not.toHaveProperty('recordRevision');
  });

  it('clamps an over-long title so the producer cannot emit an entry its own schema rejects', () => {
    const projected = projectAgentActivityEntry(entry({ title: 'y'.repeat(SESSION_AGENT_ACTIVITY_ENTRY_TITLE_MAX + 50) }));
    expect(projected.title).toHaveLength(SESSION_AGENT_ACTIVITY_ENTRY_TITLE_MAX);
    expect(SessionAgentActivityEntryV1Schema.safeParse(projected).success).toBe(true);
  });
});

describe('isTerminalAgentActivityStatus', () => {
  it('is true only for the four statuses backed by terminal evidence (4.9.3)', () => {
    const terminal = AGENT_ACTIVITY_STATUSES_V1.filter((status) => isTerminalAgentActivityStatus(status));
    expect(terminal).toEqual(['succeeded', 'failed', 'timedOut', 'cancelled']);
  });

  it('treats `unknown` as NOT terminal so an ambiguous entry is never bounded out of the headline', () => {
    expect(isTerminalAgentActivityStatus('unknown')).toBe(false);
  });

  /**
   * The sibling predicate's own suite pins that every status is in progress, terminal or explicitly
   * ambiguous. That is an OR, so it still passes if a status becomes BOTH — which would let one
   * entry be bounded away as history while a clock keeps counting on it. This closes that half.
   */
  it('never classifies a status as both in progress and terminal', () => {
    const both = AGENT_ACTIVITY_STATUSES_V1.filter((status) => (
      isInProgressAgentActivityStatus(status) && isTerminalAgentActivityStatus(status)
    ));
    expect(both).toEqual([]);
  });
});

describe('resolveAgentActivityEntryActivePriority', () => {
  it('escalates the human-blocked status above every other live status', () => {
    const order = (['unknown', 'queued', 'starting', 'running', 'blocked', 'waiting'] as const)
      .map((status) => ({ status, priority: resolveAgentActivityEntryActivePriority(entry({ status })) }))
      .sort((left, right) => left.priority - right.priority)
      .map((item) => item.status);
    expect(order).toEqual(['waiting', 'blocked', 'running', 'starting', 'queued', 'unknown']);
  });

  it('sorts terminal statuses last, so a mixed array never buries a live entry', () => {
    const live = resolveAgentActivityEntryActivePriority(entry({ status: 'unknown' }));
    for (const status of ['succeeded', 'failed', 'timedOut', 'cancelled'] as const) {
      expect(resolveAgentActivityEntryActivePriority(entry({ status }))).toBeGreaterThan(live);
    }
  });
});

import { describe, expect, it } from 'vitest';

import {
  AGENT_ACTIVITY_STATUSES_V1,
  AgentActivityStatusV1Schema,
  isInProgressAgentActivityStatus,
  isTerminalAgentActivityStatus,
} from './agentActivityStatusV1.js';

describe('AgentActivityStatusV1 vocabulary', () => {
  it('freezes the ten presentation statuses in their declared order', () => {
    expect(AGENT_ACTIVITY_STATUSES_V1).toEqual([
      'queued',
      'starting',
      'running',
      'waiting',
      'blocked',
      'succeeded',
      'failed',
      'timedOut',
      'cancelled',
      'unknown',
    ]);
  });

  it('publishes the same vocabulary through the schema', () => {
    expect(AgentActivityStatusV1Schema.options).toEqual([...AGENT_ACTIVITY_STATUSES_V1]);
  });

  it.each([...AGENT_ACTIVITY_STATUSES_V1])('parses %s', (status) => {
    expect(AgentActivityStatusV1Schema.parse(status)).toBe(status);
  });

  // Each rejected value is a status a source enum uses today; the plan folds them into an
  // existing member rather than growing the vocabulary (PLAN §4.2 "Deliberately not created").
  it.each([
    'paused',
    'terminated',
    'expired',
    'claimed',
    'permission_pending',
    'permission_blocked',
    'active',
    'complete',
    'stopped',
    'timeout',
    'pending',
  ])('rejects the non-member %s', (candidate) => {
    expect(AgentActivityStatusV1Schema.safeParse(candidate).success).toBe(false);
  });

  it('contains no duplicate members', () => {
    expect(new Set(AGENT_ACTIVITY_STATUSES_V1).size).toBe(AGENT_ACTIVITY_STATUSES_V1.length);
  });
});

describe('isInProgressAgentActivityStatus', () => {
  it.each(['queued', 'starting', 'running', 'waiting', 'blocked'] as const)(
    'reports %s as still working, so its clock may keep counting',
    (status) => {
      expect(isInProgressAgentActivityStatus(status)).toBe(true);
    },
  );

  it.each(['succeeded', 'failed', 'timedOut', 'cancelled', 'unknown'] as const)(
    'reports %s as no longer working, so no clock may claim it is',
    (status) => {
      expect(isInProgressAgentActivityStatus(status)).toBe(false);
    },
  );

  // The gap is the point: `unknown` is neither, and a predicate defined as the negation of the
  // other would put a running clock back on an ambiguous row.
  it('is not the negation of isTerminalAgentActivityStatus', () => {
    expect(isInProgressAgentActivityStatus('unknown')).toBe(false);
    expect(isTerminalAgentActivityStatus('unknown')).toBe(false);

    const bothFalse = AGENT_ACTIVITY_STATUSES_V1.filter((status) => (
      !isInProgressAgentActivityStatus(status) && !isTerminalAgentActivityStatus(status)
    ));
    expect(bothFalse).toEqual(['unknown']);
  });

  it('classifies every member, so a new status cannot slip through unclassified', () => {
    for (const status of AGENT_ACTIVITY_STATUSES_V1) {
      expect(
        isInProgressAgentActivityStatus(status) || isTerminalAgentActivityStatus(status) || status === 'unknown',
        `${status} must be in progress, terminal, or explicitly ambiguous`,
      ).toBe(true);
    }
  });
});

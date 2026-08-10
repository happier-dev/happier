import { describe, expect, it } from 'vitest';

import {
  AGENT_ACTIVITY_STATUSES_V1,
  AgentActivityStatusV1Schema,
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

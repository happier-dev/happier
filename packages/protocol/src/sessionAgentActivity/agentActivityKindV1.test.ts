import { describe, expect, it } from 'vitest';

import {
  AGENT_ACTIVITY_KINDS_V1,
  AgentActivityKindV1Schema,
} from './agentActivityKindV1.js';

describe('AgentActivityKindV1 membership', () => {
  it('ships only the kinds with a proven live writer today', () => {
    // PLAN §5.1 item 11 / §3.2: membership is decided by producers, not by design intent.
    // `activity/workflow_run.v1` is published today by
    // apps/cli/src/session/systemRecords/activity/**, and its snapshot carries both the run and
    // its agents — so both kinds have a writer. Nothing else does yet.
    expect(AGENT_ACTIVITY_KINDS_V1).toEqual(['workflow_run', 'workflow_agent']);
    expect(AgentActivityKindV1Schema.options).toEqual([...AGENT_ACTIVITY_KINDS_V1]);
  });

  it.each([
    // Lands in P4-B, only once its observation source is evidenced.
    'subagent',
    // Lands in P4-B, only once its observation source is evidenced.
    'execution_run',
    // Does NOT land unless P4-B proves a writer.
    'agent_team_member',
    // Lands with its producer in Phase 5, not before.
    'background_task',
    // Rejected outright: automations are excluded (PLAN N-9).
    'scheduled_run',
    // Awareness-only classification bucket; no union member (PLAN §4.9.2).
    'monitor',
  ])('rejects %s until its producer lands in the same change', (candidate) => {
    expect(AgentActivityKindV1Schema.safeParse(candidate).success).toBe(false);
  });

  it('contains no duplicate members', () => {
    expect(new Set(AGENT_ACTIVITY_KINDS_V1).size).toBe(AGENT_ACTIVITY_KINDS_V1.length);
  });
});

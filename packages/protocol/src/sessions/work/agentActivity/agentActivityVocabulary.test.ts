import { describe, expect, it } from 'vitest';

import {
  AGENT_ACTIVITY_STATUSES_V1,
  isInProgressAgentActivityStatus,
  isTerminalAgentActivityStatus,
  type AgentActivityStatusV1,
} from './agentActivityStatusV1.js';
import { AGENT_ACTIVITY_TONES_V1, resolveAgentActivityTone } from './agentActivityToneV1.js';
import { AGENT_ACTIVITY_KINDS_V1, type AgentActivityKindV1 } from './agentActivityKindV1.js';

describe('agent-activity status vocabulary', () => {
  it('pins the ladder from admission to outcome', () => {
    // Hand-written: the order is the contract (surfaces group by it), so deriving it asserts nothing.
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

  it('gives every status exactly one tone', () => {
    // The compile-time half is the `never` arm in `resolveAgentActivityTone`: a status added to the
    // union without a tone fails to build at the owner. This is the runtime half — no status may
    // resolve to something outside the tone vocabulary.
    for (const status of AGENT_ACTIVITY_STATUSES_V1) {
      expect(AGENT_ACTIVITY_TONES_V1).toContain(resolveAgentActivityTone(status));
    }
  });

  it('never paints a stop as danger, and never paints a timeout as success', () => {
    expect(resolveAgentActivityTone('cancelled')).toBe('neutral');
    expect(resolveAgentActivityTone('timedOut')).toBe('danger');
    expect(resolveAgentActivityTone('waiting')).toBe('attention');
  });

  it('treats waiting as in progress and unknown as neither in progress nor terminal', () => {
    // `waiting` still claims the work is happening — a person is the blocker, and how long they
    // have been the blocker is the datum that makes someone act.
    expect(isInProgressAgentActivityStatus('waiting')).toBe(true);
    expect(isTerminalAgentActivityStatus('waiting')).toBe(false);

    // `unknown` answers false to BOTH. The two predicates are deliberately not each other's
    // negation: "we have no outcome" and "it is still going" are different claims, and an ambiguous
    // entry supports neither. Calling it terminal would let a terminal-history cap drop a row that
    // may still be working.
    expect(isInProgressAgentActivityStatus('unknown')).toBe(false);
    expect(isTerminalAgentActivityStatus('unknown')).toBe(false);
  });

  it('keeps the two predicates mutually exclusive and jointly non-exhaustive', () => {
    const bothTrue: AgentActivityStatusV1[] = [];
    const neither: AgentActivityStatusV1[] = [];
    for (const status of AGENT_ACTIVITY_STATUSES_V1) {
      const inProgress = isInProgressAgentActivityStatus(status);
      const terminal = isTerminalAgentActivityStatus(status);
      if (inProgress && terminal) bothTrue.push(status);
      if (!inProgress && !terminal) neither.push(status);
    }
    expect(bothTrue).toEqual([]);
    expect(neither).toEqual(['unknown']);
  });
});

describe('agent-activity kind vocabulary', () => {
  /**
   * MEMBERSHIP IS DECIDED BY PRODUCERS. A kind with no live writer is a dormant branch every
   * consumer must carry forever, so each member names the producer that publishes it. Adding a kind
   * without adding its producer here fails, which is the whole point of the row.
   */
  const PRODUCER_BY_KIND: Record<AgentActivityKindV1, string> = {
    workflow_run:
      'packages/plugins/claude/src/agent/workflowRecords/agentActivityHeadlineProjection.ts'
      + ' (projectWorkflowRunAgentActivityEntries, run entry)',
    workflow_agent:
      'packages/plugins/claude/src/agent/workflowRecords/agentActivityHeadlineProjection.ts'
      + ' (projectWorkflowRunAgentActivityEntries, agent entries)',
  };

  it('ships only kinds that have a live writer in this repository', () => {
    expect([...AGENT_ACTIVITY_KINDS_V1].sort()).toEqual(Object.keys(PRODUCER_BY_KIND).sort());
    for (const kind of AGENT_ACTIVITY_KINDS_V1) {
      expect(PRODUCER_BY_KIND[kind]).toMatch(/\.ts /u);
    }
  });

  it('does not carry a kind whose observation source this repository does not have', () => {
    // `subagent`, `execution_run`, `agent_team_member` and `background_task` are all reachable
    // concepts here, but none has a producer that writes an agent-activity entry today. They enter
    // the union in the change that lands their writer, never before it.
    for (const speculative of ['subagent', 'execution_run', 'agent_team_member', 'background_task']) {
      expect(AGENT_ACTIVITY_KINDS_V1 as readonly string[]).not.toContain(speculative);
    }
  });
});

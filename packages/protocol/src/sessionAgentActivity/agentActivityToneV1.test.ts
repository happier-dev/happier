import { describe, expect, it } from 'vitest';

import {
  AGENT_ACTIVITY_STATUSES_V1,
  type AgentActivityStatusV1,
} from './agentActivityStatusV1.js';
import {
  AGENT_ACTIVITY_TONES_V1,
  AgentActivityToneV1Schema,
  resolveAgentActivityTone,
  type AgentActivityToneV1,
} from './agentActivityToneV1.js';

/**
 * The full mapping is written out by hand so the table itself is the contract: a status added to
 * `AGENT_ACTIVITY_STATUSES_V1` without a tone decision fails the domain-coverage assertion below,
 * and a silently re-toned status fails its own row.
 */
const EXPECTED_TONE_BY_STATUS: Readonly<Record<AgentActivityStatusV1, AgentActivityToneV1>> = {
  queued: 'pending',
  starting: 'pending',
  blocked: 'pending',
  running: 'live',
  waiting: 'attention',
  succeeded: 'success',
  failed: 'danger',
  timedOut: 'danger',
  cancelled: 'neutral',
  unknown: 'neutral',
};

describe('resolveAgentActivityTone', () => {
  it('freezes the six tones', () => {
    expect(AGENT_ACTIVITY_TONES_V1).toEqual([
      'pending',
      'live',
      'attention',
      'success',
      'danger',
      'neutral',
    ]);
    expect(AgentActivityToneV1Schema.options).toEqual([...AGENT_ACTIVITY_TONES_V1]);
  });

  it('covers exactly the status vocabulary — no status without a tone decision', () => {
    expect(Object.keys(EXPECTED_TONE_BY_STATUS).sort()).toEqual(
      [...AGENT_ACTIVITY_STATUSES_V1].sort(),
    );
  });

  it.each(AGENT_ACTIVITY_STATUSES_V1.map((status) => [status, EXPECTED_TONE_BY_STATUS[status]]))(
    'maps %s to %s',
    (status, tone) => {
      expect(resolveAgentActivityTone(status as AgentActivityStatusV1)).toBe(tone);
    },
  );

  it('produces every declared tone from at least one status — no dead tone', () => {
    const produced = new Set(AGENT_ACTIVITY_STATUSES_V1.map((status) => resolveAgentActivityTone(status)));
    expect([...produced].sort()).toEqual([...AGENT_ACTIVITY_TONES_V1].sort());
  });

  it('never paints a cancelled run as danger', () => {
    // PLAN §4.2: cancelled is user- or system-stopped and must NEVER read as a failure.
    expect(resolveAgentActivityTone('cancelled')).not.toBe('danger');
  });

  it('separates human-blocking from dependency-blocking', () => {
    // `waiting` is the only status that escalates; `blocked` waits on a sibling, not a person.
    expect(resolveAgentActivityTone('waiting')).toBe('attention');
    expect(resolveAgentActivityTone('blocked')).not.toBe('attention');
  });
});

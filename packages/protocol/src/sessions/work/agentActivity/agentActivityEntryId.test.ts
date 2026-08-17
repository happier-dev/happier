import { describe, expect, it } from 'vitest';

import {
  buildAgentActivityEntryId,
  parseAgentActivityEntryId,
  resolveAgentActivityEntryAgentHandle,
} from './agentActivityEntryId.js';

/**
 * The spellings below are hand-written literals, and that is the whole value of this file.
 *
 * The producer projection and every consumer that merges a locally derived roster into the published
 * headline import `buildAgentActivityEntryId`. A consumer that instead built `${runId}/${agentId}`
 * would union the two sets by id, find no match, and render every agent twice — with every schema
 * valid and every other test green. Deriving the expected value from the builder would assert
 * nothing; only a literal pins the wire spelling.
 */
describe('agent-activity entry ids', () => {
  it('spells a run id and an agent id exactly one way', () => {
    expect(buildAgentActivityEntryId({ kind: 'workflow_run', runId: 'wf_1' }))
      .toBe('workflow_run:wf_1');
    expect(buildAgentActivityEntryId({ kind: 'workflow_agent', runId: 'wf_1', agentId: 'a1' }))
      .toBe('workflow_agent:wf_1:a1');
  });

  it('namespaces an agent by its run, because a provider agent id repeats across runs', () => {
    // Observed in a recorded two-run workflow: the same `workflow-agent:1` label appears in BOTH
    // runs. Without the run namespace these two collapse into one row.
    const first = buildAgentActivityEntryId({ kind: 'workflow_agent', runId: 'wf_1', agentId: 'workflow-agent:1' });
    const second = buildAgentActivityEntryId({ kind: 'workflow_agent', runId: 'wf_2', agentId: 'workflow-agent:1' });
    expect(first).not.toBe(second);
  });

  it('round-trips components that genuinely contain the separator', () => {
    // Both of these are real production values: a synthesized run id is literally
    // `implicit:agent-activity`, and a journal fallback agent id is literally `workflow-agent:1`.
    const entryId = buildAgentActivityEntryId({
      kind: 'workflow_agent',
      runId: 'implicit:agent-activity',
      agentId: 'workflow-agent:1',
    });
    expect(entryId).toBe('workflow_agent:implicit%3Aagent-activity:workflow-agent%3A1');
    expect(parseAgentActivityEntryId(entryId)).toEqual({
      kind: 'workflow_agent',
      runId: 'implicit:agent-activity',
      agentId: 'workflow-agent:1',
    });
  });

  it('keeps the escape reversible when a component contains a percent sign', () => {
    const entryId = buildAgentActivityEntryId({ kind: 'workflow_run', runId: 'a%3Ab' });
    expect(parseAgentActivityEntryId(entryId)).toEqual({ kind: 'workflow_run', runId: 'a%3Ab' });
  });

  it('refuses to mint an id from an empty component instead of minting a colliding one', () => {
    expect(() => buildAgentActivityEntryId({ kind: 'workflow_run', runId: '   ' })).toThrow(/runId/u);
  });

  it('returns null — never throws — for an id shape this build does not know', () => {
    // A client one release behind a producer publishing a new kind must degrade to "I cannot join
    // this entry", not to a crash and not to an empty roster.
    expect(parseAgentActivityEntryId('background_task:t1')).toBeNull();
    expect(parseAgentActivityEntryId('workflow_agent:wf_1')).toBeNull();
    expect(parseAgentActivityEntryId('workflow_run:wf_1:extra')).toBeNull();
    expect(parseAgentActivityEntryId('')).toBeNull();
  });

  it('exposes the agent handle for agents and withholds it for runs', () => {
    // The handle is the ONLY identifier both sides can independently produce, so the merge joins on
    // it. A run is the box its agents sit in — handing back its run id would let it join onto an
    // unrelated local row.
    expect(resolveAgentActivityEntryAgentHandle('workflow_agent:wf_1:a1')).toBe('a1');
    expect(resolveAgentActivityEntryAgentHandle('workflow_run:wf_1')).toBeNull();
    expect(resolveAgentActivityEntryAgentHandle('not-an-entry-id')).toBeNull();
  });
});

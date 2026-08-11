import { describe, expect, it } from 'vitest';

import {
  buildAgentActivityEntryId,
  parseAgentActivityEntryId,
  resolveAgentActivityEntryAgentHandle,
} from './agentActivityEntryId.js';

describe('agent-activity entry ids', () => {
  // THE ANTI-DRIFT LOCK. These literals are hand-written rather than derived from the builder, for
  // the same reason the metadata-key parity test hand-writes its key: the failure this guards is a
  // producer and a consumer spelling one unit of work two ways, and a test that asks the builder
  // what it produces cannot see that. If a change to the builder makes these fail, the change is a
  // wire-format change to an id that already sits in published session metadata and in every
  // client's merge key — it needs a compatibility decision, not a test update.
  describe('the wire spelling', () => {
    it('spells a workflow run id exactly', () => {
      expect(buildAgentActivityEntryId({ kind: 'workflow_run', runId: 'wf_1' }))
        .toBe('workflow_run:wf_1');
    });

    it('spells a workflow agent id exactly', () => {
      expect(buildAgentActivityEntryId({ kind: 'workflow_agent', runId: 'wf_1', agentId: 'a1' }))
        .toBe('workflow_agent:wf_1:a1');
    });
  });

  describe('round trip', () => {
    it('parses a run id back to its ref', () => {
      expect(parseAgentActivityEntryId('workflow_run:wf_1'))
        .toEqual({ kind: 'workflow_run', runId: 'wf_1' });
    });

    it('parses an agent id back to its ref', () => {
      expect(parseAgentActivityEntryId('workflow_agent:wf_1:toolu_01'))
        .toEqual({ kind: 'workflow_agent', runId: 'wf_1', agentId: 'toolu_01' });
    });

    // Both variable components contain the separator in production, so this is the shape most agent
    // entries actually carry — not an edge case. The run the CLI synthesizes for plain subagents is
    // literally `implicit:agent-activity`, and a workflow journal's fallback agent id is literally
    // `workflow-agent:1` (OBSERVED in the recorded concurrent-workflow fixture). A naive
    // `split(':')` parse reads this as run `implicit`, agent `agent-activity`, which joins every
    // subagent of every implicit run onto one bogus key.
    it('round trips components that contain the separator', () => {
      const ref = {
        kind: 'workflow_agent',
        runId: 'implicit:agent-activity',
        agentId: 'workflow-agent:1',
      } as const;
      const entryId = buildAgentActivityEntryId(ref);

      expect(entryId).toBe('workflow_agent:implicit%3Aagent-activity:workflow-agent%3A1');
      expect(parseAgentActivityEntryId(entryId)).toEqual(ref);
    });

    // The escape must be reversible, or an id containing a literal `%3A` decodes to a colon and two
    // different agents collapse onto one row.
    it('round trips a component that contains the escape sequence itself', () => {
      const ref = { kind: 'workflow_run', runId: 'run%3Aone' } as const;
      const entryId = buildAgentActivityEntryId(ref);

      expect(entryId).toBe('workflow_run:run%253Aone');
      expect(parseAgentActivityEntryId(entryId)).toEqual(ref);
      expect(parseAgentActivityEntryId(entryId)).not.toEqual({
        kind: 'workflow_run',
        runId: 'run:one',
      });
    });

    it('returns null for an id this build cannot read', () => {
      expect(parseAgentActivityEntryId('background_task:task_1')).toBeNull();
      expect(parseAgentActivityEntryId('workflow_agent:wf_1')).toBeNull();
      expect(parseAgentActivityEntryId('workflow_run:')).toBeNull();
      expect(parseAgentActivityEntryId('')).toBeNull();
      // Not written by this builder, which escapes every component: guessing would be worse.
      expect(parseAgentActivityEntryId('workflow_run:a:b')).toBeNull();
    });
  });

  describe('the cross-source join handle', () => {
    // The whole point of the handle: the CLI names an agent by the SDK tool-use id it saw, the UI
    // names the same agent by the transcript tool call / sidechain id it saw. Those are the same
    // string, and the entry ids around it are not.
    it('is the agent id of a workflow agent, whatever run it belongs to', () => {
      const inImplicitRun = buildAgentActivityEntryId({
        kind: 'workflow_agent',
        runId: 'implicit:agent-activity',
        agentId: 'toolu_shared',
      });
      const inExplicitRun = buildAgentActivityEntryId({
        kind: 'workflow_agent',
        runId: 'toolu_workflow_7',
        agentId: 'toolu_shared',
      });

      expect(resolveAgentActivityEntryAgentHandle(inImplicitRun)).toBe('toolu_shared');
      expect(resolveAgentActivityEntryAgentHandle(inExplicitRun)).toBe('toolu_shared');
      expect(inImplicitRun).not.toBe(inExplicitRun);
    });

    // A run is the box, not the work. Returning its run id here would let a run join onto a local
    // execution-run row that has nothing to do with it.
    it('is null for a run, and for an unreadable id', () => {
      expect(resolveAgentActivityEntryAgentHandle('workflow_run:wf_1')).toBeNull();
      expect(resolveAgentActivityEntryAgentHandle('background_task:task_1')).toBeNull();
    });
  });

  // A blank component has no honest id, and one that reached metadata would be a row nothing can be
  // joined to. Failing at the producer is the only place that is cheap.
  it('refuses to mint an id from a blank component', () => {
    expect(() => buildAgentActivityEntryId({ kind: 'workflow_run', runId: '  ' })).toThrow();
    expect(() => buildAgentActivityEntryId({
      kind: 'workflow_agent',
      runId: 'wf_1',
      agentId: '',
    })).toThrow();
  });
});

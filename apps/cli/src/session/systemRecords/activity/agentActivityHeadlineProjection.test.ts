import { describe, expect, it } from 'vitest';

import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  SessionAgentActivityEntryV1Schema,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import { projectWorkflowRunAgentActivityEntries } from './agentActivityHeadlineProjection';

function runSnapshot(overrides: Partial<SessionWorkflowRunSnapshotV1> = {}): SessionWorkflowRunSnapshotV1 {
  return {
    v: 1,
    projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    runId: 'wf_1',
    backendId: 'claude',
    title: 'Refactor the parser',
    status: 'active',
    recordRevision: '4',
    updatedAt: 1_000,
    totalAgents: 1,
    completedAgents: 0,
    phases: [],
    agents: [],
    ...overrides,
  };
}

describe('projectWorkflowRunAgentActivityEntries — record freshness', () => {
  /**
   * The run entry is the one a consumer hydrates `activity/workflow_run.v1` from, so it is the one
   * that has to say which version of that record it points at. Without this the only consumer that
   * hydrates the record had no invalidation signal on the unified path and froze after one fetch.
   */
  it('stamps the run entry with the revision of the record it points at', () => {
    const [runEntry] = projectWorkflowRunAgentActivityEntries(runSnapshot({ recordRevision: '4' }));
    expect(runEntry).toMatchObject({ entryId: 'workflow_run:wf_1', runId: 'wf_1', recordRevision: '4' });
    expect(SessionAgentActivityEntryV1Schema.safeParse(runEntry).success).toBe(true);
  });

  it('advances the stamped revision with the record, so a progressing run invalidates its own cache', () => {
    const first = projectWorkflowRunAgentActivityEntries(runSnapshot({ recordRevision: '4' }))[0];
    const second = projectWorkflowRunAgentActivityEntries(runSnapshot({ recordRevision: '5' }))[0];
    expect(first?.recordRevision).toBe('4');
    expect(second?.recordRevision).toBe('5');
  });

  /**
   * An agent has no durable record of its own — it lives inside the run's — so stamping it with the
   * run's revision would publish a second freshness authority for one record. Its detail arrives
   * when the run is hydrated, keyed by the run entry above.
   */
  it('leaves agent entries unstamped: they point at no record of their own', () => {
    const entries = projectWorkflowRunAgentActivityEntries(runSnapshot({
      agents: [{ id: 'agent_a', title: 'live agent', status: 'active', updatedAt: 1_000 }],
    }));
    const agentEntry = entries.find((entry) => entry.kind === 'workflow_agent');
    expect(agentEntry).toBeDefined();
    expect(agentEntry).not.toHaveProperty('recordRevision');
  });
});

/**
 * The open target. A workflow agent's transcript is imported as a sidechain, and the ONLY way a
 * client can find it is the id the record carries — a sidechain has no owning tool call to route
 * through (a run has one `Workflow` call and many agents), so the entry either names it or the row
 * is unopenable.
 */
describe('projectWorkflowRunAgentActivityEntries — sidechain target', () => {
  it('carries each agent’s own sidechain id onto its headline entry', () => {
    const entries = projectWorkflowRunAgentActivityEntries(runSnapshot({
      totalAgents: 2,
      agents: [
        { id: 'a1', title: 'lane one', status: 'active', updatedAt: 1_000, sidechainId: 'workflow_agent_sidechain:toolu_wf:a1' },
        { id: 'a2', title: 'lane two', status: 'active', updatedAt: 1_000, sidechainId: 'workflow_agent_sidechain:toolu_wf:a2' },
      ],
    }));

    const agentEntries = entries.filter((entry) => entry.kind === 'workflow_agent');
    expect(agentEntries.map((entry) => entry.sidechainId)).toEqual([
      'workflow_agent_sidechain:toolu_wf:a1',
      'workflow_agent_sidechain:toolu_wf:a2',
    ]);
    for (const entry of agentEntries) {
      expect(SessionAgentActivityEntryV1Schema.safeParse(entry).success).toBe(true);
    }
  });

  /**
   * The live case today, and the one that must not regress: every released producer omits this
   * field. A reader that treats its absence as anything other than "no target" would make every
   * existing workflow agent row either broken or falsely pressable.
   */
  it('omits the field entirely when the producer proved no sidechain', () => {
    const entries = projectWorkflowRunAgentActivityEntries(runSnapshot({
      agents: [{ id: 'a1', title: 'lane one', status: 'active', updatedAt: 1_000 }],
    }));

    const agentEntry = entries.find((entry) => entry.kind === 'workflow_agent');
    expect(agentEntry).not.toHaveProperty('sidechainId');
    expect(SessionAgentActivityEntryV1Schema.safeParse(agentEntry).success).toBe(true);
  });

  it('never puts a sidechain id on the run entry: a run is a box, not a transcript', () => {
    const [runEntry] = projectWorkflowRunAgentActivityEntries(runSnapshot({
      agents: [{ id: 'a1', title: 'lane one', status: 'active', updatedAt: 1_000, sidechainId: 'workflow_agent_sidechain:toolu_wf:a1' }],
    }));

    expect(runEntry).not.toHaveProperty('sidechainId');
  });
});

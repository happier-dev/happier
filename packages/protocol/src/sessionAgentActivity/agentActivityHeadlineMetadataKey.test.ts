import { describe, expect, it } from 'vitest';

import {
  SessionWorkflowActivityHeadlineV1Schema,
  buildSessionWorkflowActivityHeadline,
  type SessionWorkflowRunHeadlineV1,
} from '../sessionWorkflowActivity/index.js';
import { buildSessionAgentActivityHeadline } from './agentActivityHeadlineBuild.js';
import { readSessionAgentActivityHeadlineFromMetadata } from './agentActivityHeadlineV1.js';

/**
 * Cross-repo metadata-key parity lock, mirroring
 * `apps/ui/sources/components/sessions/workState/sessionWorkflowActivityMetadataKey.test.ts`.
 *
 * The unified agent-activity headline is published into session metadata under the EXACT key
 * `sessionAgentActivityHeadlineV1` in BOTH remote-dev and `../dev`. The literals below are written
 * out by hand on purpose: importing the constants would make this test rename itself alongside a
 * rename and lock nothing.
 *
 * The second literal is just as load-bearing. PLAN §5.2 is an EXPAND-only step — the workflow key
 * keeps its name, its shape and its own parity lock, and removing it is out of scope — so both
 * literals are pinned here and the four skew directions are exercised against them.
 */
const CROSS_REPO_AGENT_HEADLINE_METADATA_KEY = 'sessionAgentActivityHeadlineV1';
const CROSS_REPO_WORKFLOW_HEADLINE_METADATA_KEY = 'sessionWorkflowActivityHeadlineV1';

function readWorkflowHeadlineLikeAnOldClient(metadata: Record<string, unknown>) {
  // Byte-for-byte what `readSessionWorkflowActivityHeadlineFromMetadata` does in apps/ui, restated
  // here because `packages/protocol` cannot import from an app.
  const parsed = SessionWorkflowActivityHeadlineV1Schema.safeParse(metadata[CROSS_REPO_WORKFLOW_HEADLINE_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

function workflowRun(runId: string): SessionWorkflowRunHeadlineV1 {
  return {
    runId,
    title: `run ${runId}`,
    status: 'active',
    updatedAt: 1000,
    recordRevision: '1',
    recordUpdatedAt: 1000,
    totalAgents: 2,
    completedAgents: 1,
  };
}

function newCliWorkflowHeadline() {
  return buildSessionWorkflowActivityHeadline({ backendId: 'claude', updatedAt: 2000, runs: [workflowRun('wf_1')] });
}

function newCliAgentHeadline() {
  return buildSessionAgentActivityHeadline({
    backendId: 'claude',
    updatedAt: 2000,
    entries: [
      { entryId: 'workflow_run:wf_1', kind: 'workflow_run', title: 'run wf_1', status: 'running', updatedAt: 2000 },
      { entryId: 'workflow_agent:wf_1:a1', kind: 'workflow_agent', title: 'Research', status: 'waiting', updatedAt: 2000, runId: 'wf_1', parentId: 'workflow_run:wf_1' },
    ],
  });
}

describe('agent-activity headline metadata-key parity', () => {
  it('reads the headline from the exact cross-repo metadata key written by both repos', () => {
    const metadata = { [CROSS_REPO_AGENT_HEADLINE_METADATA_KEY]: newCliAgentHeadline() };
    const read = readSessionAgentActivityHeadlineFromMetadata(metadata);
    expect(read).not.toBeNull();
    expect(read?.primaryEntryId).toBe('workflow_agent:wf_1:a1');
    expect(read?.activeEntries.map((entry) => entry.entryId)).toEqual([
      'workflow_agent:wf_1:a1',
      'workflow_run:wf_1',
    ]);
  });

  it('does not read a headline published under any other key', () => {
    const headline = newCliAgentHeadline();
    expect(readSessionAgentActivityHeadlineFromMetadata({ agentActivityHeadline: headline })).toBeNull();
    expect(readSessionAgentActivityHeadlineFromMetadata({ sessionAgentActivityHeadline: headline })).toBeNull();
    expect(readSessionAgentActivityHeadlineFromMetadata({ sessionAgentActivityHeadlineV2: headline })).toBeNull();
  });

  it('reads nothing out of a metadata value that is not a record', () => {
    for (const metadata of [undefined, null, 'metadata', 7, []]) {
      expect(readSessionAgentActivityHeadlineFromMetadata(metadata)).toBeNull();
    }
  });
});

/** PLAN §5.2 — the four reachable skew directions, one discriminating test each. */
describe('agent-activity headline compatibility (PLAN 5.2)', () => {
  it('old client <- new CLI: the workflow key keeps its name and shape beside the new one', () => {
    const metadata: Record<string, unknown> = {
      [CROSS_REPO_WORKFLOW_HEADLINE_METADATA_KEY]: newCliWorkflowHeadline(),
      [CROSS_REPO_AGENT_HEADLINE_METADATA_KEY]: newCliAgentHeadline(),
    };
    const workflow = readWorkflowHeadlineLikeAnOldClient(metadata);
    expect(workflow).not.toBeNull();
    expect(workflow?.activeRuns[0]?.runId).toBe('wf_1');
    expect(workflow?.primaryRunId).toBe('wf_1');
    // An old client has no reader for the new key and must not be affected by its presence.
    expect(workflow).toEqual(newCliWorkflowHeadline());
  });

  it('new client <- old CLI: the new key is absent, so the reader degrades to null and never throws', () => {
    const metadata: Record<string, unknown> = {
      [CROSS_REPO_WORKFLOW_HEADLINE_METADATA_KEY]: newCliWorkflowHeadline(),
    };
    expect(() => readSessionAgentActivityHeadlineFromMetadata(metadata)).not.toThrow();
    expect(readSessionAgentActivityHeadlineFromMetadata(metadata)).toBeNull();
    // The fallback source an old-CLI client keeps using is still intact.
    expect(readWorkflowHeadlineLikeAnOldClient(metadata)).not.toBeNull();
  });

  it('new client <- old CLI: a corrupt or foreign value under the new key degrades, it does not throw', () => {
    for (const corrupt of ['{}', 0, [], { v: 1 }, { v: 1, backendId: '', updatedAt: 1, activeEntries: [] }]) {
      const metadata = { [CROSS_REPO_AGENT_HEADLINE_METADATA_KEY]: corrupt };
      expect(() => readSessionAgentActivityHeadlineFromMetadata(metadata)).not.toThrow();
      expect(readSessionAgentActivityHeadlineFromMetadata(metadata)).toBeNull();
    }
  });

  it('new client <- new CLI: both keys are readable from one metadata payload', () => {
    const metadata: Record<string, unknown> = {
      [CROSS_REPO_WORKFLOW_HEADLINE_METADATA_KEY]: newCliWorkflowHeadline(),
      [CROSS_REPO_AGENT_HEADLINE_METADATA_KEY]: newCliAgentHeadline(),
    };
    expect(readSessionAgentActivityHeadlineFromMetadata(metadata)?.activeEntries).toHaveLength(2);
    expect(readWorkflowHeadlineLikeAnOldClient(metadata)?.activeRuns).toHaveLength(1);
  });

  it('dev <-> remote-dev: a headline serialised by the other repo survives a JSON round trip', () => {
    const wire = JSON.parse(JSON.stringify({
      [CROSS_REPO_AGENT_HEADLINE_METADATA_KEY]: newCliAgentHeadline(),
    })) as Record<string, unknown>;
    expect(readSessionAgentActivityHeadlineFromMetadata(wire)?.activeEntries.map((entry) => entry.entryId)).toEqual([
      'workflow_agent:wf_1:a1',
      'workflow_run:wf_1',
    ]);
  });
});

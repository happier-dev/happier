import { describe, expect, it } from 'vitest';

import {
  SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY,
  buildAgentActivityEntryId,
  buildSessionAgentActivityHeadline,
  buildSessionWorkflowActivityHeadline,
  type SessionWorkflowRunHeadlineV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';

import { pruneLegacyClaudeAsyncAgentWorkflowGhostsFromMetadata } from './legacyClaudeWorkflowActivityRepair';

/**
 * The legacy ghost repair must prune BOTH activity headline keys.
 *
 * The publisher writes them together precisely so they can never describe different worlds; a repair
 * that cleans one of them would reintroduce the divergence at startup, and the agent-activity key is
 * the one the roster renders — so the ghosts would come back visibly while the workflow card looked
 * clean.
 */

function ghostRun(runId: string): SessionWorkflowRunHeadlineV1 {
  return {
    runId,
    title: 'Workflow',
    status: 'active',
    workflowToolUseId: runId,
    updatedAt: 1000,
    recordRevision: '1',
    recordUpdatedAt: 1000,
    totalAgents: 0,
    completedAgents: 0,
  };
}

function realRun(runId: string): SessionWorkflowRunHeadlineV1 {
  return { ...ghostRun(runId), title: 'Real workflow', totalAgents: 2, completedAgents: 1 };
}

function metadataWithHeadlines(runs: readonly SessionWorkflowRunHeadlineV1[]): Metadata {
  return {
    path: '/x',
    host: 'h',
    homeDir: '/home/tester',
    happyHomeDir: '/home/tester/.happier',
    happyLibDir: '/home/tester/.happier/lib',
    happyToolsDir: '/home/tester/.happier/tools',
    sessionWorkflowActivityHeadlineV1: buildSessionWorkflowActivityHeadline({
      backendId: 'claude',
      updatedAt: 1000,
      runs,
    }),
    [SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]: buildSessionAgentActivityHeadline({
      backendId: 'claude',
      updatedAt: 1000,
      entries: runs.map((run) => ({
        // Through the shared builder, never a template: a fixture that spelled an entry id itself
        // would keep passing after the producer's spelling changed, which is the divergence the
        // one builder exists to make impossible.
        entryId: buildAgentActivityEntryId({ kind: 'workflow_run', runId: run.runId }),
        kind: 'workflow_run' as const,
        title: run.title,
        status: 'running' as const,
        updatedAt: run.updatedAt,
        runId: run.runId,
      })),
    }),
  };
}

describe('pruneLegacyClaudeAsyncAgentWorkflowGhostsFromMetadata', () => {
  it('prunes the same ghost runs out of the agent-activity headline, not only the workflow one', () => {
    const metadata = metadataWithHeadlines([
      ghostRun('toolu_ghost_1'),
      ghostRun('toolu_ghost_2'),
      realRun('toolu_real'),
    ]);

    const repaired = pruneLegacyClaudeAsyncAgentWorkflowGhostsFromMetadata(metadata, () => 5000) as Record<string, unknown>;

    const workflow = repaired.sessionWorkflowActivityHeadlineV1 as { activeRuns: { runId: string }[] };
    expect(workflow.activeRuns.map((run) => run.runId)).toEqual(['toolu_real']);

    const agentActivity = repaired[SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY] as {
      activeEntries: { entryId: string }[];
      primaryEntryId: string | null;
      updatedAt: number;
    };
    expect(agentActivity.activeEntries.map((entry) => entry.entryId)).toEqual(['workflow_run:toolu_real']);
    expect(agentActivity.primaryEntryId).toBe('workflow_run:toolu_real');
    expect(agentActivity.updatedAt).toBe(5000);
  });

  it('leaves both headlines untouched when there are not enough ghosts to be sure', () => {
    const metadata = metadataWithHeadlines([ghostRun('toolu_ghost_1'), realRun('toolu_real')]);
    expect(pruneLegacyClaudeAsyncAgentWorkflowGhostsFromMetadata(metadata, () => 5000)).toBe(metadata);
  });
});

import {
  buildAgentActivityEntryId,
  buildSessionAgentActivityHeadline,
  buildSessionWorkflowActivityHeadline,
  type SessionAgentActivityEntryV1,
  type SessionWorkflowRunHeadlineV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  collectStartupReconcileCandidates,
  resolveStartupReconcileTargets,
} from './workflowActivityStartupReconcile';

function headlineRun(overrides: Partial<SessionWorkflowRunHeadlineV1> & { runId: string }): SessionWorkflowRunHeadlineV1 {
  return {
    title: `run ${overrides.runId}`,
    status: 'active',
    updatedAt: 1000,
    recordRevision: '1',
    recordUpdatedAt: 1000,
    totalAgents: 17,
    completedAgents: 3,
    ...overrides,
  };
}

function agentEntry(params: Readonly<{
  runId: string;
  agentId: string;
  title: string;
  status: SessionAgentActivityEntryV1['status'];
  updatedAt: number;
  startedAt?: number;
  sidechainId?: string;
}>): SessionAgentActivityEntryV1 {
  return {
    entryId: buildAgentActivityEntryId({ kind: 'workflow_agent', runId: params.runId, agentId: params.agentId }),
    kind: 'workflow_agent',
    title: params.title,
    status: params.status,
    updatedAt: params.updatedAt,
    runId: params.runId,
    parentId: buildAgentActivityEntryId({ kind: 'workflow_run', runId: params.runId }),
    ...(params.startedAt !== undefined ? { startedAt: params.startedAt } : {}),
    ...(params.sidechainId !== undefined ? { sidechainId: params.sidechainId } : {}),
  };
}

describe('workflowActivityStartupReconcile', () => {
  it('selects only non-terminal runs not re-observed by the restarted process', () => {
    const candidates = collectStartupReconcileCandidates(buildSessionWorkflowActivityHeadline({
      backendId: 'claude',
      updatedAt: 2000,
      runs: [
        headlineRun({ runId: 'wf_resumed' }),
        headlineRun({ runId: 'wf_crashed', workflowToolUseId: 'toolu_crashed' }),
        headlineRun({ runId: 'wf_done', status: 'complete' }),
      ],
    }));

    expect(resolveStartupReconcileTargets(candidates, new Set(['wf_resumed']))).toEqual([{
      runId: 'wf_crashed',
      title: 'run wf_crashed',
      workflowToolUseId: 'toolu_crashed',
      totalAgents: 17,
      completedAgents: 3,
    }]);
  });

  /**
   * The crash residue the user actually sees is a ROSTER of agents, not a run count.
   *
   * A run can reach a terminal status in the published workflow headline while individual agents
   * are still non-terminal in the agent-activity headline published beside it — a process killed
   * between the two states leaves exactly that. Reading only `activeRuns` then captures zero
   * candidates (the observed `captured 0 candidate(s)` line), nothing republishes, and the orphaned
   * agent rows keep spinning across every later restart.
   */
  it('captures a run whose own status is terminal but whose agents were left running', () => {
    const candidates = collectStartupReconcileCandidates(
      buildSessionWorkflowActivityHeadline({
        backendId: 'claude',
        updatedAt: 2000,
        runs: [headlineRun({ runId: 'wf_done', status: 'complete', workflowToolUseId: 'toolu_done' })],
      }),
      buildSessionAgentActivityHeadline({
        backendId: 'claude',
        updatedAt: 2000,
        entries: [
          agentEntry({ runId: 'wf_done', agentId: 'a1', title: 'ATTACK R1', status: 'running', updatedAt: 1_500, startedAt: 1_200, sidechainId: 'sc-1' }),
          agentEntry({ runId: 'wf_done', agentId: 'a2', title: 'ATTACK R2', status: 'running', updatedAt: 1_600 }),
          agentEntry({ runId: 'wf_done', agentId: 'a3', title: 'ATTACK R3', status: 'succeeded', updatedAt: 1_400 }),
        ],
      }),
    );

    expect(candidates).toEqual([{
      runId: 'wf_done',
      title: 'run wf_done',
      workflowToolUseId: 'toolu_done',
      totalAgents: 17,
      completedAgents: 3,
      runTerminalStatus: 'complete',
      orphanAgents: [
        { agentId: 'a1', title: 'ATTACK R1', updatedAt: 1_500, startedAt: 1_200, sidechainId: 'sc-1' },
        { agentId: 'a2', title: 'ATTACK R2', updatedAt: 1_600 },
      ],
    }]);
  });

  it('attaches orphaned agents to the run candidate the workflow headline already produced', () => {
    const candidates = collectStartupReconcileCandidates(
      buildSessionWorkflowActivityHeadline({
        backendId: 'claude',
        updatedAt: 2000,
        runs: [headlineRun({ runId: 'wf_crashed' })],
      }),
      buildSessionAgentActivityHeadline({
        backendId: 'claude',
        updatedAt: 2000,
        entries: [agentEntry({ runId: 'wf_crashed', agentId: 'a1', title: 'lane one', status: 'running', updatedAt: 1_500 })],
      }),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      runId: 'wf_crashed',
      orphanAgents: [{ agentId: 'a1', title: 'lane one', updatedAt: 1_500 }],
    });
    expect(candidates[0]).not.toHaveProperty('runTerminalStatus');
  });

  /**
   * The workflow headline bounds its terminal history; the roster never bounds live entries. A run
   * that finished long enough ago to age out of `recentRuns` can therefore still own agent rows, and
   * the card rebuilt for it must not be headed by a raw run id.
   */
  it('names a run that aged out of the workflow headline from the roster it left behind', () => {
    const candidates = collectStartupReconcileCandidates(
      buildSessionWorkflowActivityHeadline({ backendId: 'claude', updatedAt: 2000, runs: [] }),
      buildSessionAgentActivityHeadline({
        backendId: 'claude',
        updatedAt: 2000,
        entries: [
          {
            entryId: buildAgentActivityEntryId({ kind: 'workflow_run', runId: 'wf_aged_out' }),
            kind: 'workflow_run',
            title: 'composer target shape pressure test',
            status: 'succeeded',
            updatedAt: 1_900,
            runId: 'wf_aged_out',
          },
          agentEntry({ runId: 'wf_aged_out', agentId: 'a1', title: 'ATTACK R1', status: 'running', updatedAt: 1_500 }),
        ],
      }),
    );

    expect(candidates).toEqual([{
      runId: 'wf_aged_out',
      title: 'composer target shape pressure test',
      totalAgents: 0,
      completedAgents: 0,
      orphanAgents: [{ agentId: 'a1', title: 'ATTACK R1', updatedAt: 1_500 }],
    }]);
  });

  it('ignores a live agent whose run this process has already re-observed', () => {
    const candidates = collectStartupReconcileCandidates(
      buildSessionWorkflowActivityHeadline({
        backendId: 'claude',
        updatedAt: 2000,
        runs: [headlineRun({ runId: 'wf_resumed', status: 'complete' })],
      }),
      buildSessionAgentActivityHeadline({
        backendId: 'claude',
        updatedAt: 2000,
        entries: [agentEntry({ runId: 'wf_resumed', agentId: 'a1', title: 'lane one', status: 'running', updatedAt: 1_500 })],
      }),
    );

    expect(resolveStartupReconcileTargets(candidates, new Set(['wf_resumed']))).toEqual([]);
  });
});

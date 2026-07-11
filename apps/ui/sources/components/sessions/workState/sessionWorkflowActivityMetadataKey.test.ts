import { buildSessionWorkflowActivityHeadline, type SessionWorkflowRunHeadlineV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { readSessionWorkflowActivityHeadlineFromMetadata } from './sessionWorkflowActivityPresentation';

/**
 * Cross-repo metadata-key parity lock (DW2).
 *
 * The compact workflow headline is published into session metadata under the EXACT key
 * `sessionWorkflowActivityHeadlineV1` in BOTH remote-dev and ../dev, even though ../dev's internal
 * session-state field id may differ. This test pins that literal so a future rename here cannot
 * silently break cross-repo compatibility: a headline written by remote-dev must be readable here
 * and vice versa.
 */
const CROSS_REPO_WORKFLOW_HEADLINE_METADATA_KEY = 'sessionWorkflowActivityHeadlineV1';

function headlineRun(overrides: Partial<SessionWorkflowRunHeadlineV1> & { runId: string }): SessionWorkflowRunHeadlineV1 {
  return {
    title: `run ${overrides.runId}`,
    status: 'active',
    updatedAt: 1000,
    recordRevision: '1',
    recordUpdatedAt: 1000,
    totalAgents: 2,
    completedAgents: 1,
    ...overrides,
  };
}

describe('workflow headline metadata-key parity', () => {
  it('reads the headline from the exact cross-repo metadata key written by both repos', () => {
    const headline = buildSessionWorkflowActivityHeadline({
      backendId: 'claude',
      updatedAt: 2000,
      runs: [headlineRun({ runId: 'wf_1' })],
    });
    // Simulate the metadata shape published by the CLI/plugin publisher in EITHER repo.
    const metadata = { [CROSS_REPO_WORKFLOW_HEADLINE_METADATA_KEY]: headline };

    const read = readSessionWorkflowActivityHeadlineFromMetadata(metadata);
    expect(read).not.toBeNull();
    expect(read?.activeRuns[0]?.runId).toBe('wf_1');
    expect(read?.primaryRunId).toBe('wf_1');
  });

  it('does not read a headline published under any other key', () => {
    const headline = buildSessionWorkflowActivityHeadline({
      backendId: 'claude',
      updatedAt: 2000,
      runs: [headlineRun({ runId: 'wf_1' })],
    });
    expect(readSessionWorkflowActivityHeadlineFromMetadata({ workflowHeadline: headline })).toBeNull();
    expect(readSessionWorkflowActivityHeadlineFromMetadata({ runtimeWorkflowHeadline: headline })).toBeNull();
  });
});

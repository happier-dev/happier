import { describe, expect, it, vi } from 'vitest';

import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import type { WorkflowRunCollectionRow } from './useWorkflowRunCollection';
import { projectWorkflowRunsNow } from './workflowRunsNow';

vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

/** A collection row as `useWorkflowRunCollection` projects it: the status comes from the one Work status owner. */
function row(summary: WorkflowRunSummaryV1): WorkflowRunCollectionRow {
  return {
    key: summary.id,
    title: summary.id,
    route: { pathname: `/workflows/runs/${summary.id}` } as never,
    run: { id: summary.id, summary } as never,
    facts: {
      workflows: undefined,
      results: summary.state,
      startedBy: undefined,
      projects: undefined,
    },
    date: { key: 'd', title: 'Today' },
    project: { key: 'p', title: 'p' },
    workflow: { key: 'w', title: 'Queue' },
    result: null,
    status: resolveWorkStatusTone({
      kind: 'workflow_run',
      facts: readWorkflowRunWorkStatusFacts(summary),
    }),
    startedBy: null,
    setUpBy: null,
    subject: null,
    createdAt: Date.parse(summary.createdAt),
  };
}

describe('projectWorkflowRunsNow', () => {
  it('leads with the runs that need the person and counts working runs per Machine, parked runs apart', () => {
    const asks = row(
      createWorkflowRunSummaryFixture({
        id: 'asks',
        machineId: 'nl-1',
        attentionRequired: true,
        invocationAttentionRequired: true,
      }),
    );
    const working = row(
      createWorkflowRunSummaryFixture({ id: 'working', machineId: 'nl-1' }),
    );
    const second = row(
      createWorkflowRunSummaryFixture({ id: 'second', machineId: 'nl-2' }),
    );
    const third = row(
      createWorkflowRunSummaryFixture({ id: 'third', machineId: 'nl-2' }),
    );
    const done = row(
      createWorkflowRunSummaryFixture({
        id: 'done',
        machineId: 'nl-3',
        state: 'succeeded',
        finishedAt: '2026-09-08T10:10:00.000Z',
      }),
    );

    const now = projectWorkflowRunsNow([asks, working, second, third, done], { complete: true });

    expect(now.needsYou.map((r) => r.key)).toEqual(['asks']);
    // A settled run holds no slot, so its Machine is not listed; a parked ask is counted apart from working runs.
    expect(now.machines).toEqual([
      { machineId: 'nl-2', working: 2, parked: 0 },
      { machineId: 'nl-1', working: 1, parked: 1 },
    ]);
    expect(now.workingCount).toBe(3);
  });

  it('keeps the same projection object when an unrelated settled row is added', () => {
    const working = row(
      createWorkflowRunSummaryFixture({ id: 'working', machineId: 'nl-1' }),
    );
    const done = row(
      createWorkflowRunSummaryFixture({
        id: 'done',
        state: 'succeeded',
        finishedAt: '2026-09-08T10:10:00.000Z',
      }),
    );
    const first = projectWorkflowRunsNow([working], { complete: true });
    expect(projectWorkflowRunsNow([working, done], { complete: true }, first)).toBe(first);
  });

  it('says its counts cover only the loaded runs while older runs remain unloaded', () => {
    const working = row(
      createWorkflowRunSummaryFixture({ id: 'working', machineId: 'nl-1' }),
    );
    const done = row(
      createWorkflowRunSummaryFixture({
        id: 'done',
        state: 'succeeded',
        finishedAt: '2026-09-08T10:10:00.000Z',
      }),
    );
    const complete = projectWorkflowRunsNow([working, done], { complete: true });
    expect(complete.counted).toEqual({ kind: 'all' });
    // Paging can still reveal an older working run, so the reader is told which runs were counted.
    const partial = projectWorkflowRunsNow([working, done], { complete: false }, complete);
    expect(partial).not.toBe(complete);
    expect(partial.counted).toEqual({ kind: 'loaded', loadedCount: 2 });
    expect(partial.workingCount).toBe(1);
  });
});

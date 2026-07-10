import { describe, expect, it } from 'vitest';

import {
  SESSION_WORKFLOW_ACTIVITY_RECENT_RUNS_LIMIT,
  SessionWorkflowActivityHeadlineV1Schema,
  SessionWorkflowRunHeadlineV1Schema,
  boundRecentWorkflowRunHeadlines,
  buildSessionWorkflowActivityHeadline,
  resolvePrimaryWorkflowRunId,
  sortActiveWorkflowRunHeadlines,
  type SessionWorkflowRunHeadlineV1,
  type SessionWorkflowRunStatusV1,
} from './index.js';

function headlineRun(overrides: Partial<SessionWorkflowRunHeadlineV1> & { runId: string; status: SessionWorkflowRunStatusV1 }): SessionWorkflowRunHeadlineV1 {
  return {
    title: `run ${overrides.runId}`,
    updatedAt: 1000,
    recordRevision: '1',
    recordUpdatedAt: 1000,
    totalAgents: 1,
    completedAgents: 0,
    ...overrides,
  };
}

describe('SessionWorkflowRunHeadlineV1Schema', () => {
  it('requires recordRevision and recordUpdatedAt', () => {
    const base = headlineRun({ runId: 'wf_1', status: 'active' });
    expect(SessionWorkflowRunHeadlineV1Schema.safeParse(base).success).toBe(true);
    const { recordRevision, ...withoutRevision } = base;
    void recordRevision;
    expect(SessionWorkflowRunHeadlineV1Schema.safeParse(withoutRevision).success).toBe(false);
    expect(SessionWorkflowRunHeadlineV1Schema.safeParse({
      ...base,
      recordRevision: 'rev-1',
    }).success).toBe(false);
    const { recordUpdatedAt, ...withoutRecordUpdatedAt } = base;
    void recordUpdatedAt;
    expect(SessionWorkflowRunHeadlineV1Schema.safeParse(withoutRecordUpdatedAt).success).toBe(false);
  });

  it('validates a count-only headline with no phase/agent/preview detail fields', () => {
    const parsed = SessionWorkflowActivityHeadlineV1Schema.safeParse({
      v: 1,
      backendId: 'claude',
      updatedAt: 2000,
      primaryRunId: 'wf_1',
      activeRuns: [headlineRun({ runId: 'wf_1', status: 'active' })],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('buildSessionWorkflowActivityHeadline', () => {
  it('keeps every active run and never caps activeRuns', () => {
    const runs = Array.from({ length: 12 }, (_, i) => headlineRun({ runId: `wf_${i}`, status: 'active', updatedAt: 1000 + i }));
    const headline = buildSessionWorkflowActivityHeadline({ backendId: 'claude', updatedAt: 5000, runs });
    expect(headline.activeRuns).toHaveLength(12);
    expect(headline.truncated).toBeUndefined();
  });

  it('bounds recentRuns to the terminal-history limit and records the omitted count', () => {
    const terminal = Array.from({ length: 8 }, (_, i) => headlineRun({ runId: `wf_${i}`, status: 'complete', updatedAt: 1000 + i }));
    const headline = buildSessionWorkflowActivityHeadline({ backendId: 'claude', updatedAt: 5000, runs: terminal });
    expect(headline.activeRuns).toHaveLength(0);
    expect(headline.recentRuns).toHaveLength(SESSION_WORKFLOW_ACTIVITY_RECENT_RUNS_LIMIT);
    expect(headline.truncated).toEqual({ reason: 'run_limit', omittedCount: 8 - SESSION_WORKFLOW_ACTIVITY_RECENT_RUNS_LIMIT });
    // newest terminal runs are kept.
    expect(headline.recentRuns?.[0]?.runId).toBe('wf_7');
  });

  it('derives primaryRunId deterministically: blocked > active > unknown, then a stable runId tie-break', () => {
    const runs = [
      headlineRun({ runId: 'wf_active_old', status: 'active', updatedAt: 100 }),
      headlineRun({ runId: 'wf_unknown', status: 'unknown', updatedAt: 9000 }),
      headlineRun({ runId: 'wf_blocked', status: 'blocked', updatedAt: 50 }),
      headlineRun({ runId: 'wf_active_new_b', status: 'active', updatedAt: 500 }),
      headlineRun({ runId: 'wf_active_new_a', status: 'active', updatedAt: 500 }),
    ];
    const headline = buildSessionWorkflowActivityHeadline({ backendId: 'claude', updatedAt: 5000, runs });
    expect(headline.primaryRunId).toBe('wf_blocked');
    expect(headline.activeRuns.map((r) => r.runId)).toEqual([
      'wf_blocked',
      'wf_active_new_a',
      'wf_active_new_b',
      'wf_active_old',
      'wf_unknown',
    ]);
  });

  it('returns primaryRunId null when there are no active runs', () => {
    const runs = [headlineRun({ runId: 'wf_done', status: 'complete', updatedAt: 100 })];
    const headline = buildSessionWorkflowActivityHeadline({ backendId: 'claude', updatedAt: 5000, runs });
    expect(headline.primaryRunId).toBeNull();
    expect(headline.activeRuns).toHaveLength(0);
  });

  it('projects each run to count-only fields, stripping any leaked workflow detail (F1)', () => {
    const leaky = {
      ...headlineRun({ runId: 'wf_1', status: 'active' }),
      phases: [{ id: 'p1', title: 'Research' }],
      agents: [{ id: 'a1', resultPreview: 'secret detail' }],
      resultPreview: 'leaked preview',
    } as unknown as SessionWorkflowRunHeadlineV1;
    const headline = buildSessionWorkflowActivityHeadline({ backendId: 'claude', updatedAt: 5000, runs: [leaky] });
    const run = headline.activeRuns[0]!;
    expect(run).not.toHaveProperty('phases');
    expect(run).not.toHaveProperty('agents');
    expect(run).not.toHaveProperty('resultPreview');
    expect(run.runId).toBe('wf_1');
    expect(run.totalAgents).toBe(1);
  });

  it('preserves the interrupted status reason in the terminal headline', () => {
    const headline = buildSessionWorkflowActivityHeadline({
      backendId: 'claude',
      updatedAt: 5000,
      runs: [headlineRun({
        runId: 'wf_interrupted',
        status: 'stopped',
        statusReason: 'interrupted',
      })],
    });

    expect(headline.recentRuns?.[0]).toMatchObject({
      runId: 'wf_interrupted',
      status: 'stopped',
      statusReason: 'interrupted',
    });
    expect(SessionWorkflowActivityHeadlineV1Schema.safeParse(headline).success).toBe(true);
  });
});

describe('SessionWorkflowRunHeadlineV1Schema detail stripping (F1)', () => {
  it('strips unknown detail keys on parse instead of passing them through', () => {
    const parsed = SessionWorkflowRunHeadlineV1Schema.parse({
      ...headlineRun({ runId: 'wf_1', status: 'active' }),
      phases: [{ id: 'p1' }],
      resultPreview: 'leak',
    });
    expect(parsed).not.toHaveProperty('phases');
    expect(parsed).not.toHaveProperty('resultPreview');
  });
});

describe('sortActiveWorkflowRunHeadlines / resolvePrimaryWorkflowRunId', () => {
  it('orders blocked first, then active, then unknown', () => {
    const runs = [
      headlineRun({ runId: 'b', status: 'active', updatedAt: 1 }),
      headlineRun({ runId: 'a', status: 'blocked', updatedAt: 1 }),
    ];
    expect(sortActiveWorkflowRunHeadlines(runs).map((r) => r.runId)).toEqual(['a', 'b']);
    expect(resolvePrimaryWorkflowRunId(runs)).toBe('a');
  });

  it('does not reorder active runs when only updatedAt changes', () => {
    const runs = [
      headlineRun({ runId: 'a', status: 'active', updatedAt: 1 }),
      headlineRun({ runId: 'b', status: 'active', updatedAt: 999 }),
    ];
    expect(sortActiveWorkflowRunHeadlines(runs).map((r) => r.runId)).toEqual(['a', 'b']);
    expect(resolvePrimaryWorkflowRunId(runs)).toBe('a');
  });

  it('returns null primary for empty active set', () => {
    expect(resolvePrimaryWorkflowRunId([])).toBeNull();
  });
});

describe('boundRecentWorkflowRunHeadlines', () => {
  it('does not mark truncation when within limit', () => {
    const terminal = [headlineRun({ runId: 'x', status: 'complete', updatedAt: 1 })];
    const { recentRuns, truncated } = boundRecentWorkflowRunHeadlines(terminal);
    expect(recentRuns).toHaveLength(1);
    expect(truncated).toBeUndefined();
  });
});

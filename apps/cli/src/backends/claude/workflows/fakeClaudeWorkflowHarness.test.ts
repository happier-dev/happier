import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';

// The T2 fake-Claude workflow scenario builder lives in the shared tests package next to the
// fake-Claude CLI harness. Importing it HERE (where the real CWF2 tracker + CWF3 source live) proves
// the harness output drives the REAL wired normalizer — not a parallel parser — for every preset the
// e2e (T4) and real-session QA depend on. No internal behavior is mocked: the only injected functions
// are the durable-record/headline boundary writes.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildWorkflowSpec, LONG_PREVIEW } = require('../../../../../../packages/tests/src/fixtures/fake-claude-workflow-transcript.cjs') as {
  buildWorkflowSpec: (preset: string) => { runs: Array<{ toolUseId: string; taskId: string; title: string; records: Array<Record<string, unknown>> }> };
  LONG_PREVIEW: string;
};

import { createClaudeWorkflowActivityTracker } from './claudeWorkflowActivityTracker';
import type { SessionActivityHeadlineBundle } from '@/session/systemRecords/activity/publishWorkflowActivitySnapshot';
import { createClaudeWorkflowActivitySource as createProductionClaudeWorkflowActivitySource } from './claudeWorkflowActivitySource';
function createClaudeWorkflowActivitySource(params: Parameters<typeof createProductionClaudeWorkflowActivitySource>[0]) {
  return createProductionClaudeWorkflowActivitySource(params);
}

const SESSION_ID = 'fake-claude-session-1';

/** Stamp builder records with the live session id, exactly as the harness does before appending. */
function stampedRecords(preset: string): Array<Record<string, unknown>> {
  const spec = buildWorkflowSpec(preset);
  // Interleave round-robin to mirror the harness's concurrent emit ordering.
  const queues = spec.runs.map((run) => [...run.records]);
  const out: Array<Record<string, unknown>> = [];
  let remaining = queues.reduce((sum, q) => sum + q.length, 0);
  let uuid = 0;
  while (remaining > 0) {
    for (const queue of queues) {
      const record = queue.shift();
      if (!record) continue;
      remaining -= 1;
      out.push({ ...record, session_id: SESSION_ID, uuid: `uuid_${uuid++}` });
    }
  }
  return out;
}

function driveTracker(preset: string): ReadonlyMap<string, SessionWorkflowRunSnapshotV1> {
  const tracker = createClaudeWorkflowActivityTracker({
    backendId: 'claude',
    agentId: 'claude',
    getCurrentClaudeSessionId: () => SESSION_ID,
  });
  let now = 1_000;
  for (const record of stampedRecords(preset)) {
    tracker.observe(record, { updatedAt: now });
    now += 1;
  }
  return tracker.getRunSnapshotMap();
}

describe('fake Claude workflow harness builder drives the real CWF2 tracker', () => {
  it('success preset: three ordered phases, all agents complete, run completes', () => {
    const runs = driveTracker('success');
    expect(runs.size).toBe(1);
    const run = [...runs.values()][0]!;
    expect(run.status).toBe('complete');
    expect(run.workflowToolUseId).toBe('toolu_wf_success');
    expect(run.phases.map((p) => p.title)).toEqual(['Research', 'Implementation', 'Review']);
    expect(run.totalAgents).toBe(6);
    expect(run.completedAgents).toBe(6);
    expect(run.failedAgents).toBeUndefined();
  });

  it('progress preset: stays active with mixed running/done agents and one phase', () => {
    const runs = driveTracker('progress');
    const run = [...runs.values()][0]!;
    expect(run.status).toBe('active');
    expect(run.phases.map((p) => p.title)).toEqual(['Research']);
    expect(run.totalAgents).toBe(2);
    expect(run.completedAgents).toBe(1);
    const running = run.agents.filter((a) => a.status === 'active');
    expect(running).toHaveLength(1);
  });

  it('failure preset: a failed agent maps to a failed run status', () => {
    const runs = driveTracker('failure');
    const run = [...runs.values()][0]!;
    expect(run.status).toBe('failed');
    expect(run.failedAgents).toBe(1);
    expect(run.agents.some((a) => a.status === 'failed')).toBe(true);
  });

  it('stopped preset: maps to a cancelled run status', () => {
    const runs = driveTracker('stopped');
    const run = [...runs.values()][0]!;
    expect(run.status).toBe('cancelled');
  });

  it('no-phase preset: flat run with agents but no phase rows', () => {
    const runs = driveTracker('no-phase');
    const run = [...runs.values()][0]!;
    expect(run.phases).toHaveLength(0);
    expect(run.totalAgents).toBe(2);
    expect(run.completedAgents).toBe(2);
  });

  it('long-preview preset: a long result preview survives as a single agent field', () => {
    const runs = driveTracker('long-preview');
    const run = [...runs.values()][0]!;
    const agent = run.agents.find((a) => a.resultPreview);
    expect(agent?.resultPreview).toBe(LONG_PREVIEW);
    expect((agent?.resultPreview ?? '').length).toBeGreaterThan(500);
  });

  it('concurrent preset: TWO distinct runs, never merged, with isolated agents and statuses', () => {
    const runs = driveTracker('concurrent');
    expect(runs.size).toBe(2);
    const alpha = runs.get('toolu_wf_a')!;
    const beta = runs.get('toolu_wf_b')!;
    expect(alpha.title).toBe('workflow-alpha');
    expect(beta.title).toBe('workflow-beta');
    // Agent ids are run-local; isolation is proven by distinct per-run rows/statuses, not by global ids.
    expect(alpha.agents.map((a) => [a.id, a.title, a.status])).toEqual([
      ['workflow-agent:1', 'alpha_search', 'complete'],
      ['workflow-agent:2', 'alpha_coder', 'complete'],
    ]);
    expect(beta.agents.map((a) => [a.id, a.title, a.status])).toEqual([
      ['workflow-agent:1', 'beta_coder', 'complete'],
      ['workflow-agent:2', 'beta_tester', 'failed'],
    ]);
    expect(alpha.status).toBe('complete');
    expect(beta.status).toBe('failed');
    expect(beta.failedAgents).toBe(1);
  });
});

describe('fake Claude workflow harness builder drives the real CWF3 source + CWF4 filter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('publishes two distinct durable records + a headline with both active/terminal runs for the concurrent preset', async () => {
    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const headlines: Array<{ activeRuns: ReadonlyArray<{ runId: string }>; recentRuns?: ReadonlyArray<{ runId: string }> }> = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => SESSION_ID,
      commitRecord: async (snapshot) => { committed.push(snapshot); },
      writeHeadlines: (bundle) => { headlines.push(bundle.workflow as never); },
      debounceMs: 50,
    });

    for (const record of stampedRecords('concurrent')) {
      source.observeTranscriptMessage(record);
    }
    await source.flush();

    const committedRunIds = new Set(committed.map((s) => s.runId));
    expect(committedRunIds.has('toolu_wf_a')).toBe(true);
    expect(committedRunIds.has('toolu_wf_b')).toBe(true);

    const lastHeadline = headlines.at(-1)!;
    const headlineRunIds = new Set([
      ...lastHeadline.activeRuns.map((r) => r.runId),
      ...(lastHeadline.recentRuns ?? []).map((r) => r.runId),
    ]);
    expect(headlineRunIds.has('toolu_wf_a')).toBe(true);
    expect(headlineRunIds.has('toolu_wf_b')).toBe(true);

    source.dispose();
  });

  it('names every agent of the concurrent preset in the unified headline, so a cold open needs no transcript', async () => {
    const bundles: SessionActivityHeadlineBundle[] = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => SESSION_ID,
      commitRecord: async () => {},
      writeHeadlines: (bundle) => { bundles.push(bundle); },
      debounceMs: 50,
    });

    for (const record of stampedRecords('concurrent')) {
      source.observeTranscriptMessage(record);
    }
    await source.flush();

    const agentActivity = bundles.at(-1)!.agentActivity;
    const entries = [...agentActivity.activeEntries, ...(agentActivity.recentEntries ?? [])];
    // Both runs AND all four of their agents are addressable from metadata alone — the count-only
    // workflow headline can name none of them (R-3).
    expect(entries.filter((entry) => entry.kind === 'workflow_run').map((entry) => entry.entryId).sort()).toEqual([
      'workflow_run:toolu_wf_a',
      'workflow_run:toolu_wf_b',
    ]);
    expect(entries.filter((entry) => entry.kind === 'workflow_agent').map((entry) => [entry.title, entry.status, entry.parentId]))
      .toEqual(expect.arrayContaining([
        ['alpha_search', 'succeeded', 'workflow_run:toolu_wf_a'],
        ['alpha_coder', 'succeeded', 'workflow_run:toolu_wf_a'],
        ['beta_coder', 'succeeded', 'workflow_run:toolu_wf_b'],
        ['beta_tester', 'failed', 'workflow_run:toolu_wf_b'],
      ]));

    source.dispose();
  });

  it('marks workflow-owned agent ids so the CWF4 work-state filter suppresses duplicate rows', () => {
    const tracker = createClaudeWorkflowActivityTracker({
      backendId: 'claude',
      getCurrentClaudeSessionId: () => SESSION_ID,
    });
    let now = 1_000;
    for (const record of stampedRecords('success')) {
      tracker.observe(record, { updatedAt: now });
      now += 1;
    }
    const owned = tracker.getWorkflowOwnedAgentToolUseIds();
    // Every workflow agent id must be marked owned (CWF4 hook intersects these with work-state rows).
    for (const id of ['agent_1', 'agent_2', 'agent_3', 'agent_4', 'agent_5', 'agent_6']) {
      expect(owned.has(id)).toBe(true);
    }
  });
});

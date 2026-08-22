import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createClaudeWorkflowActivityTracker } from './tracker.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function loadFixtureLines(name: string): unknown[] {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/**
 * CWF2 tracker tests. The tracker folds raw Claude transcript values (the same raw channel the
 * goal source observes) into a per-run `Map<runId>` and emits provider-agnostic
 * `SessionWorkflowRunSnapshotV1` outputs. Two concurrent `Workflow` runs must never merge.
 */

function workflowToolUse(params: Readonly<{ id: string; name: string; sessionId?: string; uuid?: string }>) {
  return {
    type: 'assistant',
    session_id: params.sessionId ?? 'claude-session-1',
    uuid: params.uuid ?? `uuid-${params.id}`,
    message: {
      content: [{
        type: 'tool_use',
        id: params.id,
        name: 'Workflow',
        input: { script: `export const meta = { name: '${params.name}' }` },
      }],
    },
  };
}

function workflowLaunch(params: Readonly<{
  toolUseId: string;
  taskId: string;
  providerRunId: string;
  sessionId?: string;
}>) {
  return {
    type: 'user',
    session_id: params.sessionId ?? 'claude-session-1',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: params.toolUseId,
        is_error: false,
        content: 'Workflow launched in background.',
      }],
    },
    toolUseResult: {
      status: 'async_launched',
      taskType: 'local_workflow',
      taskId: params.taskId,
      runId: params.providerRunId,
    },
  };
}

function successfulWorkflowTaskStop(taskId: string, sessionId = 'claude-session-1') {
  return {
    type: 'user',
    session_id: sessionId,
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_task_stop',
        is_error: false,
        content: `Successfully stopped task: ${taskId}`,
      }],
    },
    toolUseResult: {
      message: `Successfully stopped task: ${taskId}`,
      task_id: taskId,
      task_type: 'local_workflow',
    },
  };
}

function workflowToolUseWithScript(params: Readonly<{ id: string; script: string; sessionId?: string; uuid?: string }>) {
  return {
    type: 'assistant',
    session_id: params.sessionId ?? 'claude-session-1',
    uuid: params.uuid ?? `uuid-${params.id}`,
    message: {
      content: [{
        type: 'tool_use',
        id: params.id,
        name: 'Workflow',
        input: { script: params.script },
      }],
    },
  };
}

function taskProgress(params: Readonly<{
  toolUseId: string;
  taskId?: string;
  taskType?: string;
  workflowProgress?: unknown[];
  usage?: Record<string, unknown>;
  summary?: string;
  sessionId?: string;
  uuid?: string;
}>) {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: params.taskId ?? 'w1',
    tool_use_id: params.toolUseId,
    task_type: params.taskType ?? 'local_workflow',
    session_id: params.sessionId ?? 'claude-session-1',
    ...(params.summary ? { summary: params.summary } : {}),
    ...(params.usage ? { usage: params.usage } : {}),
    ...(params.workflowProgress ? { workflow_progress: params.workflowProgress } : {}),
    uuid: params.uuid ?? 'uuid-progress',
  };
}

function taskStarted(params: Readonly<{ toolUseId: string; taskId?: string; taskType?: string; sessionId?: string; uuid?: string }>) {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: params.taskId ?? 'w1',
    tool_use_id: params.toolUseId,
    task_type: params.taskType ?? 'local_workflow',
    description: 'work',
    session_id: params.sessionId ?? 'claude-session-1',
    uuid: params.uuid ?? 'uuid-started',
  };
}

function taskUpdatedCompleted(params: Readonly<{ taskId?: string; sessionId?: string; uuid?: string }>) {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: params.taskId ?? 'w1',
    patch: { status: 'completed', end_time: 1780015779522 },
    session_id: params.sessionId ?? 'claude-session-1',
    uuid: params.uuid ?? 'uuid-updated',
  };
}

function workflowJournal(params: Readonly<{
  workflowToolUseId: string;
  type: 'started' | 'result';
  key: string;
  agentId: string;
  result?: unknown;
  sessionId?: string;
}>) {
  return {
    type: 'happier_workflow_journal',
    workflowToolUseId: params.workflowToolUseId,
    sourceSessionId: params.sessionId ?? 'claude-session-1',
    entry: {
      type: params.type,
      key: params.key,
      agentId: params.agentId,
      ...(params.type === 'result' ? { result: params.result } : {}),
    },
  };
}

function taskNotification(params: Readonly<{
  toolUseId: string;
  taskId?: string;
  status?: string;
  summary?: string;
  result?: string;
  sessionId?: string;
}>) {
  const taskId = params.taskId ?? 'wtxrlsrvj';
  const status = params.status ?? 'completed';
  const summary = params.summary ?? 'Dynamic workflow "test" completed';
  const result = params.result ?? '{"subsystemsAnalyzed":8}';
  return {
    type: 'user',
    session_id: params.sessionId ?? 'claude-session-1',
    message: {
      content: [{
        type: 'text',
        text: `<task-notification><task-id>${taskId}</task-id><tool-use-id>${params.toolUseId}</tool-use-id><status>${status}</status><summary>${summary}</summary><result>${result}</result></task-notification>`,
      }],
    },
  };
}

function subagentTask(params: Readonly<{ id: string; description: string; parentToolUseId?: string; sessionId?: string; uuid?: string }>) {
  return {
    type: 'assistant',
    session_id: params.sessionId ?? 'claude-session-1',
    ...(params.parentToolUseId ? { parent_tool_use_id: params.parentToolUseId } : {}),
    uuid: params.uuid ?? `uuid-${params.id}`,
    message: {
      content: [{
        type: 'tool_use',
        id: params.id,
        name: 'Task',
        input: { description: params.description, subagent_type: 'general-purpose' },
      }],
    },
  };
}

describe('createClaudeWorkflowActivityTracker', () => {
  it('starts an explicit workflow run from a Workflow tool-use and reports it started', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude', agentId: 'claude' });
    const obs = tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'ship-feature' }), { updatedAt: 1000 });

    expect(obs.startedRunIds).toEqual(['toolu_wf']);
    expect(obs.changedRunIds).toEqual(['toolu_wf']);

    const snapshot = tracker.getRunSnapshot('toolu_wf');
    expect(snapshot?.runId).toBe('toolu_wf');
    expect(snapshot?.workflowToolUseId).toBe('toolu_wf');
    expect(snapshot?.title).toBe('ship-feature');
    expect(snapshot?.status).toBe('active');
    expect(snapshot?.backendId).toBe('claude');
  });

  it('keeps one run when Claude reattaches the same provider Workflow through a new tool/task identity', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });

    tracker.observe(workflowToolUse({ id: 'toolu_initial', name: 'workflow-name' }), { updatedAt: 1_000 });
    tracker.observe(workflowLaunch({
      toolUseId: 'toolu_initial',
      taskId: 'task-initial',
      providerRunId: 'workflow-provider-run',
    }), { updatedAt: 1_100 });

    tracker.observe(workflowToolUse({ id: 'toolu_resume', name: 'workflow-name' }), { updatedAt: 2_000 });
    const reattached = tracker.observe(workflowLaunch({
      toolUseId: 'toolu_resume',
      taskId: 'task-resume',
      providerRunId: 'workflow-provider-run',
    }), { updatedAt: 2_100 });

    expect([...tracker.getRunSnapshotMap().keys()]).toEqual(['toolu_initial']);
    expect(reattached.changedRunIds).toContain('toolu_resume');
    expect(reattached.providerTaskActivities).toContainEqual({
      type: 'terminal',
      sessionId: 'claude-session-1',
      taskId: 'task-initial',
    });

    const terminal = tracker.observe(taskNotification({
      toolUseId: 'toolu_resume',
      taskId: 'task-resume',
    }), { updatedAt: 3_000 });
    expect(terminal.terminalRunIds).toEqual(['toolu_initial']);
    expect(tracker.getRunSnapshot('toolu_initial')?.status).toBe('complete');
  });

  it('terminalizes the correlated Workflow task after an exact successful TaskStop result', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'workflow-name' }), { updatedAt: 1_000 });
    tracker.observe(workflowLaunch({
      toolUseId: 'toolu_wf',
      taskId: 'workflow-task-1',
      providerRunId: 'workflow-provider-run',
    }), { updatedAt: 1_100 });

    const stopped = tracker.observe(successfulWorkflowTaskStop('workflow-task-1'), { updatedAt: 2_000 });

    expect(stopped.terminalRunIds).toEqual(['toolu_wf']);
    expect(stopped.providerTaskActivities).toContainEqual({
      type: 'terminal',
      terminalStatus: 'stopped',
      sessionId: 'claude-session-1',
      taskId: 'workflow-task-1',
    });
    expect(tracker.getRunSnapshot('toolu_wf')?.status).toBe('cancelled');
  });

  it('builds ordered phases and phase-membered agents from workflow_progress, including a failed agent', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'ship-feature' }), { updatedAt: 1000 });
    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      usage: { total_tokens: 120500, tool_uses: 14, duration_ms: 18750 },
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Research' },
        { type: 'workflow_phase', index: 2, title: 'Implementation' },
        { type: 'workflow_phase', index: 3, title: 'Review' },
        { type: 'workflow_agent', agentId: 'agent_1', label: 'web_search', phaseIndex: 1, phaseTitle: 'Research', state: 'done', tokens: 9000, toolCalls: 2, durationMs: 1100, resultPreview: 'Found prior art.' },
        { type: 'workflow_agent', agentId: 'agent_2', label: 'doc_reader', phaseIndex: 1, phaseTitle: 'Research', state: 'done', tokens: 11000 },
        { type: 'workflow_agent', agentId: 'agent_3', label: 'coder', phaseIndex: 2, phaseTitle: 'Implementation', state: 'done', tokens: 42000 },
        { type: 'workflow_agent', agentId: 'agent_4', label: 'refactorer', phaseIndex: 2, phaseTitle: 'Implementation', state: 'done' },
        { type: 'workflow_agent', agentId: 'agent_5', label: 'reviewer', phaseIndex: 3, phaseTitle: 'Review', state: 'done' },
        { type: 'workflow_agent', agentId: 'agent_6', label: 'tester', phaseIndex: 3, phaseTitle: 'Review', state: 'failed', resultPreview: '2 tests failed.' },
      ],
    }), { updatedAt: 2000 });

    const snapshot = tracker.getRunSnapshot('toolu_wf');
    expect(snapshot?.phases.map((p) => p.title)).toEqual(['Research', 'Implementation', 'Review']);
    expect(snapshot?.phases[0]?.agentIds).toEqual(['agent_1', 'agent_2']);
    expect(snapshot?.agents).toHaveLength(6);
    expect(snapshot?.totalAgents).toBe(6);
    expect(snapshot?.completedAgents).toBe(5);
    expect(snapshot?.failedAgents).toBe(1);
    expect(snapshot?.tokensUsed).toBe(120500);
    expect(snapshot?.toolCalls).toBe(14);
    expect(snapshot?.agents.find((a) => a.id === 'agent_6')?.status).toBe('failed');
    expect(snapshot?.agents.find((a) => a.id === 'agent_1')?.resultPreview).toBe('Found prior art.');
  });

  it('merges provisional index-keyed agents with later Claude agentId progress rows', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'ship-feature' }), { updatedAt: 1000 });

    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Research' },
        { type: 'workflow_agent', index: 1, label: 'researcher', phaseIndex: 1, state: 'running' },
      ],
    }), { updatedAt: 2000 });
    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Research' },
        {
          type: 'workflow_agent',
          index: 1,
          agentId: 'claude-agent-concrete',
          label: 'researcher',
          phaseIndex: 1,
          state: 'done',
          resultPreview: 'finished',
        },
      ],
    }), { updatedAt: 3000 });

    const snapshot = tracker.getRunSnapshot('toolu_wf');
    expect(snapshot?.agents).toHaveLength(1);
    expect(snapshot?.agents[0]).toMatchObject({
      id: 'workflow-agent:1',
      vendorRef: 'claude-agent-concrete',
      status: 'complete',
      resultPreview: 'finished',
    });
    expect(snapshot?.phases[0]?.agentIds).toEqual(['workflow-agent:1']);
  });

  it('files one row per agent when the live stream and the sidecar journal name it differently', () => {
    // The live `task_progress` stream keys an agent by POSITION (`workflow-agent:<n>`) while the
    // sidecar journal keys the same agent by its concrete hex id. Both feed this one tracker, so
    // left alone every agent of every journal-backed run was filed twice — one row `running`
    // forever beside the row that actually finished.
    //
    // The row identity that already exists wins and the other name joins it as `vendorRef`: dev's
    // agent id is what `buildAgentActivityEntryId` publishes and what the client merges on, so
    // renaming a row that is already on screen would remount it and split its handle.
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUseWithScript({
      id: 'toolu_wf',
      script: `
export const meta = { name: 'audit', phases: [{ title: 'Investigate' }] }
phase('Investigate')
await parallel([agent('Read the docs', { label: 'docs', phase: 'Investigate' })])
`,
    }), { updatedAt: 1000 });
    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Investigate' },
        { type: 'workflow_agent', index: 1, label: 'docs', agentId: 'ada15d97cdea9c7fd', phaseIndex: 1, state: 'running' },
      ],
    }), { updatedAt: 2000 });
    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'started',
      key: 'v2:first',
      agentId: 'ada15d97cdea9c7fd',
    }), { updatedAt: 2100 });

    const snapshot = tracker.getRunSnapshot('toolu_wf');
    expect(snapshot?.agents).toHaveLength(1);
    expect(snapshot?.agents[0]).toMatchObject({
      id: 'workflow-agent:1',
      vendorRef: 'ada15d97cdea9c7fd',
    });
    expect(snapshot?.phases.find((p) => p.title === 'Investigate')?.agentIds).toEqual(['workflow-agent:1']);
  });

  it('folds a positional row into the concrete row the journal filed first', () => {
    // Arrival order is not guaranteed. When the journal named the agent first, ITS id is the row
    // identity and the later positional fact joins it — still one row, still no rename.
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUseWithScript({
      id: 'toolu_wf',
      script: `
export const meta = { name: 'audit', phases: [{ title: 'Investigate' }] }
phase('Investigate')
await parallel([agent('Read the docs', { label: 'docs', phase: 'Investigate' })])
`,
    }), { updatedAt: 1000 });
    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'started',
      key: 'v2:first',
      agentId: 'ada15d97cdea9c7fd',
    }), { updatedAt: 2000 });
    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_agent', index: 1, label: 'docs', agentId: 'ada15d97cdea9c7fd', state: 'done' },
      ],
    }), { updatedAt: 2100 });

    const snapshot = tracker.getRunSnapshot('toolu_wf');
    expect(snapshot?.agents).toHaveLength(1);
    expect(snapshot?.agents[0]).toMatchObject({
      id: 'ada15d97cdea9c7fd',
      status: 'complete',
    });
  });

  it('does not reopen terminal agents from stale progress for the same attempt', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'ship-feature' }), { updatedAt: 1000 });
    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_agent', index: 1, label: 'researcher', state: 'done', resultPreview: 'finished', attempt: 1 },
      ],
    }), { updatedAt: 2000 });

    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_agent', index: 1, label: 'researcher', state: 'progress', attempt: 1 },
      ],
    }), { updatedAt: 3000 });

    expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({
      id: 'workflow-agent:1',
      status: 'complete',
      resultPreview: 'finished',
    });
  });

  it('allows a newer retry attempt to reopen a terminal agent', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'ship-feature' }), { updatedAt: 1000 });
    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_agent', index: 1, label: 'researcher', state: 'done', resultPreview: 'old attempt', attempt: 1 },
      ],
    }), { updatedAt: 2000 });

    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_agent', index: 1, label: 'researcher', state: 'running', attempt: 2 },
      ],
    }), { updatedAt: 3000 });

    expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({
      id: 'workflow-agent:1',
      status: 'active',
    });
  });

  it('marks the run complete on a terminal task_updated and reports terminal/status change', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'ship-feature' }), { updatedAt: 1000 });
    // task_started carries BOTH tool_use_id and task_id, linking the run's provider task id.
    tracker.observe(taskStarted({ toolUseId: 'toolu_wf', taskId: 'w1' }), { updatedAt: 1500 });
    // Terminal task_updated carries only task_id; it must route back via the learned link.
    const obs = tracker.observe(taskUpdatedCompleted({}), { updatedAt: 3000 });

    expect(obs.terminalRunIds).toEqual(['toolu_wf']);
    expect(obs.statusChangedRunIds).toEqual(['toolu_wf']);
    expect(tracker.getRunSnapshot('toolu_wf')?.status).toBe('complete');
    expect(tracker.getRunSnapshot('toolu_wf')?.completedAt).toBe(1780015779522);
  });

  it('marks the run complete on a task_notification user message routed by its tool-use id', () => {
    const tracker = createClaudeWorkflowActivityTracker({
      backendId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
    });
    const start = tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'research' }), { updatedAt: 100 });
    expect(start.startedRunIds).toContain('toolu_wf');
    expect(tracker.getRunSnapshot('toolu_wf')?.status).toBe('active');

    const done = tracker.observe(
      taskNotification({ toolUseId: 'toolu_wf', summary: 'Done', result: '{"subsystemsAnalyzed":8}' }),
      { updatedAt: 200 },
    );

    expect(done.terminalRunIds).toContain('toolu_wf');
    expect(done.statusChangedRunIds).toContain('toolu_wf');
    expect(tracker.getRunSnapshot('toolu_wf')?.status).toBe('complete');
  });

  it('does not create or complete a run from a task_notification with no matching run', () => {
    const tracker = createClaudeWorkflowActivityTracker({
      backendId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
    });
    const obs = tracker.observe(taskNotification({ toolUseId: 'toolu_unknown' }), { updatedAt: 100 });
    expect(obs.changedRunIds).toEqual([]);
    expect(obs.startedRunIds).toEqual([]);
    expect(obs.terminalRunIds).toEqual([]);
    expect(tracker.getRunSnapshotMap().size).toBe(0);
  });

  it('keeps two concurrent Workflow runs fully isolated (no merged phases/agents)', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_a', name: 'run-a' }), { updatedAt: 1000 });
    tracker.observe(workflowToolUse({ id: 'toolu_b', name: 'run-b' }), { updatedAt: 1001 });

    tracker.observe(taskProgress({
      toolUseId: 'toolu_a',
      taskId: 'wa',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'A-Phase' },
        { type: 'workflow_agent', agentId: 'shared_agent', label: 'agent', phaseIndex: 1, state: 'running' },
      ],
    }), { updatedAt: 2000 });
    tracker.observe(taskProgress({
      toolUseId: 'toolu_b',
      taskId: 'wb',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'B-Phase' },
        { type: 'workflow_agent', agentId: 'shared_agent', label: 'agent', phaseIndex: 1, state: 'done' },
      ],
    }), { updatedAt: 2001 });

    const a = tracker.getRunSnapshot('toolu_a');
    const b = tracker.getRunSnapshot('toolu_b');
    expect(a?.phases.map((p) => p.title)).toEqual(['A-Phase']);
    expect(b?.phases.map((p) => p.title)).toEqual(['B-Phase']);
    // Same provider agent id in two runs must not collide: each run owns its own agent row.
    expect(a?.agents.find((x) => x.id === 'shared_agent')?.status).toBe('active');
    expect(b?.agents.find((x) => x.id === 'shared_agent')?.status).toBe('complete');
    expect(a?.totalAgents).toBe(1);
    expect(b?.totalAgents).toBe(1);
  });

  it('routes a child subagent to its explicit parent Workflow via parent_tool_use_id even when another run is newer', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_a', name: 'run-a' }), { updatedAt: 1000 });
    tracker.observe(workflowToolUse({ id: 'toolu_b', name: 'run-b' }), { updatedAt: 2000 });

    // A child subagent whose parent is run A, arriving while run B is newer.
    tracker.observe(subagentTask({ id: 'child_1', description: 'do work', parentToolUseId: 'toolu_a' }), { updatedAt: 3000 });

    const a = tracker.getRunSnapshot('toolu_a');
    const b = tracker.getRunSnapshot('toolu_b');
    expect(a?.agents.some((x) => x.id === 'child_1')).toBe(true);
    expect(b?.agents.some((x) => x.id === 'child_1')).toBe(false);
  });

  it('does NOT promote a single plain subagent into a workflow run', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    const obs = tracker.observe(subagentTask({ id: 'toolu_task', description: 'summarize' }), { updatedAt: 1000 });
    expect(obs.changedRunIds).toEqual([]);
    expect(tracker.getRunSnapshotMap().size).toBe(0);
  });

  it('promotes >=2 correlated plain subagents into one implicit "Agent activity" run', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(subagentTask({ id: 'task_1', description: 'first' }), { updatedAt: 1000 });
    const obs = tracker.observe(subagentTask({ id: 'task_2', description: 'second' }), { updatedAt: 1001 });

    expect(obs.startedRunIds.length).toBe(1);
    const implicitRunId = obs.startedRunIds[0];
    const run = tracker.getRunSnapshot(implicitRunId);
    expect(run?.title).toBe('Agent activity');
    expect(run?.agents.map((a) => a.id).sort()).toEqual(['task_1', 'task_2']);
    expect(run?.totalAgents).toBe(2);
  });

  it('lets an explicit Workflow win: a later parent_tool_use_id migrates implicit child agents to the explicit run', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    // Two plain subagents form an implicit run.
    tracker.observe(subagentTask({ id: 'task_1', description: 'first' }), { updatedAt: 1000 });
    tracker.observe(subagentTask({ id: 'task_2', description: 'second' }), { updatedAt: 1001 });
    const implicitRunId = tracker.getRunSnapshotMap().keys().next().value as string;
    expect(tracker.getRunSnapshot(implicitRunId)?.agents).toHaveLength(2);

    // An explicit Workflow appears, then a child progress event proves task_1 belongs to it.
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'real-workflow' }), { updatedAt: 2000 });
    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      taskId: 'w1',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Phase' },
        { type: 'workflow_agent', agentId: 'task_1', label: 'first', phaseIndex: 1, state: 'running' },
      ],
    }), { updatedAt: 3000 });

    const explicit = tracker.getRunSnapshot('toolu_wf');
    expect(explicit?.agents.some((a) => a.id === 'task_1')).toBe(true);
    // The implicit run must no longer double-own task_1.
    const implicit = tracker.getRunSnapshot(implicitRunId);
    expect(implicit?.agents.some((a) => a.id === 'task_1')).toBe(false);
  });

  it('treats phases[] as authoritative over a conflicting agent phaseTitle', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'wf' }), { updatedAt: 1000 });
    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Canonical Phase' },
        { type: 'workflow_agent', agentId: 'a1', label: 'a', phaseIndex: 1, phaseTitle: 'Stale Title', state: 'running' },
      ],
    }), { updatedAt: 2000 });

    const snapshot = tracker.getRunSnapshot('toolu_wf');
    const agent = snapshot?.agents.find((a) => a.id === 'a1');
    // The agent still records its raw phaseTitle, but resolution favors the phase row title.
    expect(snapshot?.phases[0]?.title).toBe('Canonical Phase');
    expect(agent?.phaseIndex).toBe(1);
  });

  it('maps sidecar journal agents to Workflow script phases and labels in unified transcript mode', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUseWithScript({
      id: 'toolu_wf',
      script: `
export const meta = {
  name: 'transcript-nav-plan-audit',
  phases: [
    { title: 'Investigate' },
    { title: 'Assess' },
  ],
}

phase('Investigate')
await parallel([
  agent('Read shadcn docs', { label: 'shadcn-docs', phase: 'Investigate' }),
  agent('Check pins', { label: 'pin-ux', phase: 'Investigate' }),
])

phase('Assess')
await parallel([
  agent('Critique architecture', { label: 'architecture-feasibility', phase: 'Assess' }),
])
`,
    }), { updatedAt: 1000 });

    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'started',
      key: 'v2:first',
      agentId: 'ada15d97cdea9c7fd',
    }), { updatedAt: 1100 });
    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'started',
      key: 'v2:second',
      agentId: 'a2b7b902e76418dba',
    }), { updatedAt: 1101 });

    let snapshot = tracker.getRunSnapshot('toolu_wf');
    expect(snapshot?.phases.find((p) => p.title === 'Investigate')?.agentIds).toEqual([
      'ada15d97cdea9c7fd',
      'a2b7b902e76418dba',
    ]);
    expect(snapshot?.phases.find((p) => p.title === 'Assess')?.agentIds).toEqual([]);
    expect(snapshot?.agents.map((agent) => [agent.id, agent.title, agent.phaseTitle])).toEqual([
      ['ada15d97cdea9c7fd', 'shadcn-docs', 'Investigate'],
      ['a2b7b902e76418dba', 'pin-ux', 'Investigate'],
    ]);

    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'result',
      key: 'v2:first',
      agentId: 'ada15d97cdea9c7fd',
      result: {
        lane: 'shadcn-docs',
        summary: 'The shadcn chat components expose useful scroll concepts.',
      },
    }), { updatedAt: 1200 });

    snapshot = tracker.getRunSnapshot('toolu_wf');
    const completed = snapshot?.agents.find((agent) => agent.id === 'ada15d97cdea9c7fd');
    expect(completed).toMatchObject({
      title: 'shadcn-docs',
      status: 'complete',
      phaseTitle: 'Investigate',
      summary: 'The shadcn chat components expose useful scroll concepts.',
      resultPreview: 'The shadcn chat components expose useful scroll concepts.',
    });
  });

  it('rejects events from a foreign Claude source session', () => {
    const tracker = createClaudeWorkflowActivityTracker({
      backendId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
    });
    const obs = tracker.observe(workflowToolUse({ id: 'toolu_foreign', name: 'x', sessionId: 'other-session' }), { updatedAt: 1000 });
    expect(obs.changedRunIds).toEqual([]);
    expect(tracker.getRunSnapshotMap().size).toBe(0);
  });

  it('rejects persisted camelCase sessionId workflow events from a foreign Claude source session', () => {
    const tracker = createClaudeWorkflowActivityTracker({
      backendId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
    });
    const obs = tracker.observe({
      type: 'assistant',
      sessionId: 'other-session',
      uuid: 'uuid-foreign-camel',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_foreign_camel',
          name: 'Workflow',
          input: { script: "export const meta = { name: 'foreign' }" },
        }],
      },
    }, { updatedAt: 1000 });

    expect(obs.changedRunIds).toEqual([]);
    expect(tracker.getRunSnapshotMap().size).toBe(0);
  });

  it('drives the real dynamic-workflow fixture end to end into one complete run snapshot', () => {
    const tracker = createClaudeWorkflowActivityTracker({
      backendId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
    });
    let updatedAt = 1000;
    for (const value of loadFixtureLines('dynamic-workflow-three-phases.jsonl')) {
      tracker.observe(value, { updatedAt: updatedAt++ });
    }
    const map = tracker.getRunSnapshotMap();
    expect(map.size).toBe(1);
    const run = tracker.getRunSnapshot('toolu_wf');
    expect(run?.status).toBe('complete');
    expect(run?.workflowToolUseId).toBe('toolu_wf');
    expect(run?.phases.map((p) => p.title)).toEqual(['Research', 'Implementation', 'Review']);
    expect(run?.agents).toHaveLength(6);
    expect(run?.totalAgents).toBe(6);
    expect(run?.completedAgents).toBe(5);
    expect(run?.failedAgents).toBe(1);
    expect(run?.tokensUsed).toBe(120500);
    expect(run?.toolCalls).toBe(14);
  });

  it('does not fabricate a workflow from the real plain-task fixture (single subagent)', () => {
    const tracker = createClaudeWorkflowActivityTracker({
      backendId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-2',
    });
    let updatedAt = 1000;
    for (const value of loadFixtureLines('plain-task-no-workflow-progress.jsonl')) {
      tracker.observe(value, { updatedAt: updatedAt++ });
    }
    expect(tracker.getRunSnapshotMap().size).toBe(0);
  });

  it('reports material changes without owning committed recordRevision values', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'wf' }), { updatedAt: 1000 });
    const progress = () => taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'P' },
        { type: 'workflow_agent', agentId: 'a1', label: 'a', phaseIndex: 1, state: 'running', tokens: 10 },
      ],
    });
    const firstObs = tracker.observe(progress(), { updatedAt: 2000 });
    const rev1 = tracker.getRunSnapshot('toolu_wf')?.recordRevision;
    const duplicateObs = tracker.observe(progress(), { updatedAt: 2500 });
    const rev2 = tracker.getRunSnapshot('toolu_wf')?.recordRevision;
    expect(firstObs.changedRunIds).toEqual(['toolu_wf']);
    expect(duplicateObs.changedRunIds).toEqual([]);
    expect(rev1).toBe('0');
    expect(rev2).toBe('0');
  });

  it('reconciles an unobserved crash-residue run to stopped/interrupted with preserved counts', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    const observation = tracker.reconcileInterruptedRunFromHeadline({
      runId: 'wf_stale',
      title: 'Big workflow',
      workflowToolUseId: 'toolu_stale',
      totalAgents: 17,
      completedAgents: 3,
      failedAgents: 2,
      blockedAgents: 1,
    }, { updatedAt: 5000 });

    expect(observation).toMatchObject({
      changedRunIds: ['wf_stale'],
      startedRunIds: [],
      terminalRunIds: ['wf_stale'],
      statusChangedRunIds: ['wf_stale'],
    });
    expect(tracker.getRunSnapshot('wf_stale')).toMatchObject({
      status: 'stopped',
      statusReason: 'interrupted',
      totalAgents: 17,
      completedAgents: 3,
      failedAgents: 2,
      blockedAgents: 1,
      workflowToolUseId: 'toolu_stale',
    });
  });

  it('does not reconcile a run already observed by the fresh tracker', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_live', name: 'live' }), { updatedAt: 1000 });

    expect(tracker.reconcileInterruptedRunFromHeadline({
      runId: 'toolu_live',
      title: 'live',
      totalAgents: 2,
      completedAgents: 0,
    }, { updatedAt: 5000 }).changedRunIds).toEqual([]);
    expect(tracker.getRunSnapshot('toolu_live')).toMatchObject({ status: 'active' });
  });

  it('resolves the agents of a run it reconciles as interrupted', () => {
    // Crash recovery was run-scoped while the surface is agent-scoped: the run went `stopped` and
    // every agent inside it stayed `active` forever, so the roster kept spinning on work whose
    // process is gone.
    // Replay, not live: the transcript the dead process left behind rebuilds the run and its agents
    // in this process, which never saw any of it happen.
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'ship-feature' }), { updatedAt: 1000, live: false });
    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_agent', index: 1, label: 'researcher', state: 'running' },
        { type: 'workflow_agent', index: 2, label: 'reviewer', state: 'done' },
      ],
    }), { updatedAt: 2000, live: false });

    tracker.reconcileInterruptedRunFromHeadline({
      runId: 'toolu_wf',
      title: 'ship-feature',
      totalAgents: 2,
      completedAgents: 1,
    }, { updatedAt: 5000 });

    const snapshot = tracker.getRunSnapshot('toolu_wf');
    expect(snapshot).toMatchObject({ status: 'stopped', statusReason: 'interrupted' });
    expect(snapshot?.agents.map((a) => a.status)).toEqual(['cancelled', 'complete']);
  });

  it('rebuilds the agents a dead process published but this one never observed', () => {
    // The workflow headline carries agent COUNTS only, so a run rebuilt from it alone could name no
    // agent at all — the roster showed a stopped run with nothing in it. The agent-activity headline
    // does carry identities, and carrying them back is what lets an orphaned agent be REPLACED with
    // a truthful ending instead of vanishing from the session's history.
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });

    tracker.reconcileInterruptedRunFromHeadline({
      runId: 'wf_stale',
      title: 'Big workflow',
      workflowToolUseId: 'toolu_stale',
      totalAgents: 2,
      completedAgents: 0,
      orphanAgents: [
        { agentId: 'workflow-agent:1', title: 'researcher', updatedAt: 4_000, startedAt: 3_000 },
        { agentId: 'workflow-agent:2', title: 'reviewer', updatedAt: 4_100 },
      ],
    }, { updatedAt: 5000 });

    const snapshot = tracker.getRunSnapshot('wf_stale');
    expect(snapshot).toMatchObject({ status: 'stopped', statusReason: 'interrupted' });
    expect(snapshot?.agents).toHaveLength(2);
    expect(snapshot?.agents[0]).toMatchObject({
      id: 'workflow-agent:1',
      title: 'researcher',
      status: 'cancelled',
      startedAt: 3_000,
    });
    // The agent's own last evidence, not the moment recovery ran: stamping the sweep clock here
    // would inflate every rebuilt row's elapsed time by however long the session was down.
    expect(snapshot?.agents[0]?.updatedAt).toBe(4_000);
    expect(snapshot?.agents[1]).toMatchObject({ id: 'workflow-agent:2', status: 'cancelled' });
  });
});

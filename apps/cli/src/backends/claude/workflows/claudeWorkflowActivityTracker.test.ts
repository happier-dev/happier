import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createClaudeWorkflowActivityTracker } from './claudeWorkflowActivityTracker';

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

function workflowLaunch(params: Readonly<{
  toolUseId: string;
  taskId: string;
  providerRunId: string;
  sessionId?: string;
}>) {
  return {
    type: 'user',
    session_id: params.sessionId ?? 'claude-session-1',
    uuid: `uuid-launch-${params.toolUseId}`,
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: params.toolUseId,
        is_error: false,
        content: `Workflow launched in background. Task ID: ${params.taskId}\nRun ID: ${params.providerRunId}`,
      }],
    },
    toolUseResult: {
      status: 'async_launched',
      taskId: params.taskId,
      taskType: 'local_workflow',
      workflowName: 'workflow-name',
      runId: params.providerRunId,
    },
  };
}

function successfulWorkflowTaskStop(taskId: string, sessionId = 'claude-session-1') {
  return {
    type: 'user',
    session_id: sessionId,
    uuid: `uuid-stop-${taskId}`,
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: `toolu-stop-${taskId}`,
        is_error: false,
        content: `{"message":"Successfully stopped task: ${taskId}","task_id":"${taskId}","task_type":"local_workflow"}`,
      }],
    },
    toolUseResult: {
      message: `Successfully stopped task: ${taskId} (Workflow title)`,
      task_id: taskId,
      task_type: 'local_workflow',
    },
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

/**
 * The `tool_result` Claude persists for a `Task` tool-use. This is the ONLY terminal evidence a
 * synchronous subagent emits — backgrounded ones additionally emit `task_notification`.
 */
function subagentToolResult(params: Readonly<{
  toolUseId: string;
  isError?: boolean;
  sessionId?: string;
  uuid?: string;
}>) {
  return {
    type: 'user',
    session_id: params.sessionId ?? 'claude-session-1',
    uuid: params.uuid ?? `uuid-result-${params.toolUseId}`,
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: params.toolUseId,
        is_error: params.isError === true,
        content: [{ type: 'text', text: 'done' }],
      }],
    },
    toolUseResult: {
      content: [{ type: 'text', text: 'done' }],
      totalDurationMs: 1234,
    },
  };
}

describe('createClaudeWorkflowActivityTracker', () => {
  it('reconciles a crash-residue run while leaving a live re-observed run untouched', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'wf_resumed', name: 'resumed' }), { updatedAt: 900 });
    expect(tracker.reconcileInterruptedRunFromHeadline({
      runId: 'wf_resumed',
      title: 'resumed',
      totalAgents: 1,
      completedAgents: 0,
    }, { updatedAt: 1_000 }).changedRunIds).toEqual([]);

    expect(tracker.reconcileInterruptedRunFromHeadline({
      runId: 'wf_crashed',
      title: 'crashed',
      workflowToolUseId: 'toolu_crashed',
      totalAgents: 4,
      completedAgents: 2,
    }, { updatedAt: 1_000 }).terminalRunIds).toEqual(['wf_crashed']);
    expect(tracker.getRunSnapshot('wf_crashed')).toMatchObject({
      status: 'stopped',
      statusReason: 'interrupted',
      totalAgents: 4,
      completedAgents: 2,
    });
  });

  it('republishes an exact historically reconstructed terminal run during stale-headline reconciliation', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'workflow-name' }), {
      updatedAt: 1_000,
      live: false,
    });
    tracker.observe(workflowLaunch({
      toolUseId: 'toolu_wf',
      taskId: 'workflow-task-1',
      providerRunId: 'wf-provider-run',
    }), {
      updatedAt: 1_100,
      live: false,
    });
    tracker.observe(successfulWorkflowTaskStop('workflow-task-1'), {
      updatedAt: 1_200,
      live: false,
    });

    expect(tracker.reconcileInterruptedRunFromHeadline({
      runId: 'toolu_wf',
      title: 'workflow-name',
      workflowToolUseId: 'toolu_wf',
      totalAgents: 9,
      completedAgents: 0,
    }, { updatedAt: 2_000 })).toEqual({
      changedRunIds: ['toolu_wf'],
      startedRunIds: [],
      terminalRunIds: ['toolu_wf'],
      statusChangedRunIds: ['toolu_wf'],
    });
    expect(tracker.getRunSnapshot('toolu_wf')?.status).toBe('cancelled');
  });

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

  it('keeps one workflow run when Claude reattaches the same provider run through a new tool/task identity', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });

    tracker.observe(workflowToolUse({ id: 'toolu_initial', name: 'workflow-name' }), { updatedAt: 1_000 });
    tracker.observe(workflowLaunch({
      toolUseId: 'toolu_initial',
      taskId: 'task-initial',
      providerRunId: 'wf-provider-run',
    }), { updatedAt: 1_100 });

    tracker.observe(workflowToolUse({ id: 'toolu_resume', name: 'workflow-name' }), { updatedAt: 2_000 });
    const reattached = tracker.observe(workflowLaunch({
      toolUseId: 'toolu_resume',
      taskId: 'task-resume',
      providerRunId: 'wf-provider-run',
    }), { updatedAt: 2_100 });

    expect([...tracker.getRunSnapshotMap().keys()]).toEqual(['toolu_initial']);
    expect(reattached.changedRunIds).toEqual(['toolu_resume']);
    expect(reattached.providerTaskActivities).toContainEqual({
      type: 'terminal',
      sessionId: 'claude-session-1',
      taskId: 'task-initial',
      rememberIfUnknown: true,
    });

    tracker.observe(workflowToolUse({ id: 'toolu_resume', name: 'workflow-name' }), { updatedAt: 2_200 });
    expect([...tracker.getRunSnapshotMap().keys()]).toEqual(['toolu_initial']);

    const terminal = tracker.observe(taskNotification({
      toolUseId: 'toolu_resume',
      taskId: 'task-resume',
    }), { updatedAt: 3_000 });
    expect(terminal.terminalRunIds).toEqual(['toolu_initial']);
    expect(tracker.getRunSnapshot('toolu_initial')?.status).toBe('complete');
  });

  it('drops a stale headline candidate whose tool identity is an alias of the same provider run', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_initial', name: 'workflow-name' }), {
      updatedAt: 1_000,
      live: false,
    });
    tracker.observe(workflowLaunch({
      toolUseId: 'toolu_initial',
      taskId: 'task-initial',
      providerRunId: 'wf-provider-run',
    }), {
      updatedAt: 1_100,
      live: false,
    });
    tracker.observe(workflowToolUse({ id: 'toolu_resume', name: 'workflow-name' }), {
      updatedAt: 2_000,
      live: false,
    });
    tracker.observe(workflowLaunch({
      toolUseId: 'toolu_resume',
      taskId: 'task-resume',
      providerRunId: 'wf-provider-run',
    }), {
      updatedAt: 2_100,
      live: false,
    });

    expect(tracker.reconcileInterruptedRunFromHeadline({
      runId: 'toolu_resume',
      title: 'workflow-name',
      workflowToolUseId: 'toolu_resume',
      totalAgents: 0,
      completedAgents: 0,
    }, { updatedAt: 3_000 })).toEqual({
      changedRunIds: ['toolu_resume'],
      startedRunIds: [],
      terminalRunIds: [],
      statusChangedRunIds: [],
    });
    expect(tracker.getRunSnapshotMap().has('toolu_resume')).toBe(false);
  });

  it('terminalizes the exact correlated workflow task after a successful native TaskStop result', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'workflow-name' }), { updatedAt: 1_000 });
    tracker.observe(workflowLaunch({
      toolUseId: 'toolu_wf',
      taskId: 'workflow-task-1',
      providerRunId: 'wf-provider-run',
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

  it('merges provisional index-only workflow agents with later concrete agent ids', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'smoke' }), { updatedAt: 1000 });

    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Read' },
        { type: 'workflow_agent', index: 1, label: 'echo ALPHA', phaseIndex: 1, state: 'running' },
        { type: 'workflow_agent', index: 2, label: 'echo BRAVO', phaseIndex: 1, state: 'running' },
        { type: 'workflow_agent', index: 1, agentId: 'agent_alpha_12345', label: 'echo ALPHA', phaseIndex: 1, state: 'done', attempt: 1 },
        { type: 'workflow_agent', index: 2, agentId: 'agent_bravo_12345', label: 'echo BRAVO', phaseIndex: 1, state: 'done', attempt: 1 },
      ],
    }), { updatedAt: 2000 });

    const snapshot = tracker.getRunSnapshot('toolu_wf');
    expect(snapshot?.totalAgents).toBe(2);
    expect(snapshot?.completedAgents).toBe(2);
    expect(snapshot?.phases[0]?.agentIds).toEqual(['workflow-agent:1', 'workflow-agent:2']);
    expect(snapshot?.agents.map((agent) => [agent.id, agent.vendorRef, agent.status])).toEqual([
      ['workflow-agent:1', 'agent_alpha_12345', 'complete'],
      ['workflow-agent:2', 'agent_bravo_12345', 'complete'],
    ]);
    expect([...tracker.getWorkflowOwnedAgentToolUseIds()].sort()).toEqual([
      'agent_alpha_12345',
      'agent_bravo_12345',
      'workflow-agent:1',
      'workflow-agent:2',
    ]);
  });

  it('does not reopen a terminal workflow agent from stale active progress without a newer attempt', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'wf' }), { updatedAt: 1000 });

    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'P' },
        { type: 'workflow_agent', index: 1, agentId: 'agent_1', label: 'worker', phaseIndex: 1, state: 'done', attempt: 1 },
      ],
    }), { updatedAt: 2000 });
    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_agent', index: 1, agentId: 'agent_1', label: 'worker', phaseIndex: 1, state: 'running', attempt: 1 },
      ],
    }), { updatedAt: 3000 });

    expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]?.status).toBe('complete');
    expect(tracker.getRunSnapshot('toolu_wf')?.completedAgents).toBe(1);
  });

  it('reopens a terminal workflow agent when a strictly newer attempt starts', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'wf' }), { updatedAt: 1000 });

    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_agent', index: 1, agentId: 'agent_1', label: 'worker', state: 'done', attempt: 1 },
      ],
    }), { updatedAt: 2000 });
    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_agent', index: 1, agentId: 'agent_1', label: 'worker', state: 'running', attempt: 2 },
      ],
    }), { updatedAt: 3000 });

    expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]?.status).toBe('active');
    expect(tracker.getRunSnapshot('toolu_wf')?.completedAgents).toBe(0);
  });

  it('clears stale terminal detail when a newer retry attempt reopens a workflow agent', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'wf' }), { updatedAt: 1000 });

    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        {
          type: 'workflow_agent',
          index: 1,
          agentId: 'agent_1',
          label: 'worker',
          state: 'done',
          resultPreview: 'old terminal result',
          summary: 'old terminal summary',
          completedAt: 2500,
          attempt: 1,
        },
      ],
    }), { updatedAt: 2000 });
    tracker.observe(taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_agent', index: 1, agentId: 'agent_1', label: 'worker', state: 'running', attempt: 2 },
      ],
    }), { updatedAt: 3000 });

    const reopened = tracker.getRunSnapshot('toolu_wf')?.agents[0];
    expect(reopened).toMatchObject({ id: 'workflow-agent:1', status: 'active' });
    expect(reopened).not.toHaveProperty('resultPreview');
    expect(reopened).not.toHaveProperty('summary');
    expect(reopened).not.toHaveProperty('completedAt');
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

  it('closes a plain subagent on its Task tool_result (the only terminal evidence a synchronous subagent emits)', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(subagentTask({ id: 'task_1', description: 'first' }), { updatedAt: 1000 });
    tracker.observe(subagentTask({ id: 'task_2', description: 'second' }), { updatedAt: 1001 });

    const completed = tracker.observe(subagentToolResult({ toolUseId: 'task_1' }), { updatedAt: 2000 });
    expect(completed.changedRunIds).toContain('implicit:agent-activity');
    const afterFirst = tracker.getRunSnapshot('implicit:agent-activity');
    expect(afterFirst?.agents.find((agent) => agent.id === 'task_1')?.status).toBe('complete');
    expect(afterFirst?.completedAgents).toBe(1);
    // The run is still working while a sibling is live.
    expect(afterFirst?.status).toBe('active');

    tracker.observe(subagentToolResult({ toolUseId: 'task_2', isError: true }), { updatedAt: 3000 });
    const afterBoth = tracker.getRunSnapshot('implicit:agent-activity');
    expect(afterBoth?.agents.find((agent) => agent.id === 'task_2')?.status).toBe('failed');
    // Every agent terminal => the synthesized run is terminal too; it must not claim liveness forever.
    expect(afterBoth?.status).toBe('failed');
  });

  it('closes an explicit workflow child launched as a Task when its tool_result arrives', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'wf' }), { updatedAt: 1000 });
    tracker.observe(subagentTask({ id: 'child_1', description: 'child', parentToolUseId: 'toolu_wf' }), { updatedAt: 1100 });

    tracker.observe(subagentToolResult({ toolUseId: 'child_1' }), { updatedAt: 2000 });
    const run = tracker.getRunSnapshot('toolu_wf');
    expect(run?.agents.find((agent) => agent.id === 'child_1')?.status).toBe('complete');
    // An explicit run's own status stays owned by its workflow lifecycle events, never by a child result.
    expect(run?.status).toBe('active');
  });

  it('ignores a tool_result whose tool-use id is not a known subagent', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(subagentTask({ id: 'task_1', description: 'first' }), { updatedAt: 1000 });
    tracker.observe(subagentTask({ id: 'task_2', description: 'second' }), { updatedAt: 1001 });

    const observation = tracker.observe(subagentToolResult({ toolUseId: 'toolu_unrelated' }), { updatedAt: 2000 });
    expect(observation.changedRunIds).toEqual([]);
    const run = tracker.getRunSnapshot('implicit:agent-activity');
    expect(run?.agents.every((agent) => agent.status === 'active')).toBe(true);
  });

  it('keeps a single plain subagent unpromoted but remembers its terminal result for a later promotion', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(subagentTask({ id: 'task_1', description: 'first' }), { updatedAt: 1000 });
    expect(tracker.observe(subagentToolResult({ toolUseId: 'task_1' }), { updatedAt: 1500 }).changedRunIds).toEqual([]);
    expect(tracker.getRunSnapshotMap().size).toBe(0);

    tracker.observe(subagentTask({ id: 'task_2', description: 'second' }), { updatedAt: 2000 });
    const run = tracker.getRunSnapshot('implicit:agent-activity');
    expect(run?.agents.find((agent) => agent.id === 'task_1')?.status).toBe('complete');
    expect(run?.agents.find((agent) => agent.id === 'task_2')?.status).toBe('active');
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

  it('maps sidecar journal agents to Workflow script phases without showing opaque pending ids', () => {
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
    // RULING-13: a `started` entry is `{type,key,agentId}` — nothing in it can be attributed to a
    // declared label, so neither a label nor a phase is asserted. The ordinal is the honest answer.
    expect(snapshot?.agents.map((agent) => [agent.id, agent.title, agent.phaseTitle])).toEqual([
      ['ada15d97cdea9c7fd', 'Workflow agent 1', undefined],
      ['a2b7b902e76418dba', 'Workflow agent 2', undefined],
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

  it('never wears another lane label when journal arrival order differs from script label order (RULING-13)', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUseWithScript({
      id: 'toolu_wf',
      script: `
phase('Investigate')
await parallel([
  agent('First prompt', { label: 'first', phase: 'Investigate' }),
  agent('Second prompt', { label: 'second', phase: 'Investigate' }),
  agent('Third prompt', { label: 'third', phase: 'Investigate' }),
])

phase('Assess')
await parallel([
  agent('Critic prompt', { label: 'critic', phase: 'Assess' }),
])
`,
    }), { updatedAt: 1000 });

    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'started',
      key: 'v2:third-key',
      agentId: 'opaque-third',
    }), { updatedAt: 1100 });
    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'started',
      key: 'v2:first-key',
      agentId: 'opaque-first',
    }), { updatedAt: 1101 });
    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'started',
      key: 'v2:second-key',
      agentId: 'opaque-second',
    }), { updatedAt: 1102 });
    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'started',
      key: 'v2:critic-key',
      agentId: 'opaque-critic',
    }), { updatedAt: 1103 });

    let snapshot = tracker.getRunSnapshot('toolu_wf');
    // Script text order is first,second,third,critic; the journal delivered third,first,second,critic.
    // Zipping labels onto agents by arrival order gave 4 of 6 agents ANOTHER lane's name in a real
    // production run. A wrong name actively misleads, so no label is asserted without an identity
    // match — the stable ordinal is what a `started` entry can actually prove.
    expect(snapshot?.agents.map((agent) => [agent.id, agent.title])).toEqual([
      ['opaque-third', 'Workflow agent 1'],
      ['opaque-first', 'Workflow agent 2'],
      ['opaque-second', 'Workflow agent 3'],
      ['opaque-critic', 'Workflow agent 4'],
    ]);
    expect(snapshot?.agents.map((agent) => agent.title)).not.toContain('first');

    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'result',
      key: 'v2:third-key',
      agentId: 'opaque-third',
      result: { lane: 'third', summary: 'Finished third lane.' },
    }), { updatedAt: 1200 });

    snapshot = tracker.getRunSnapshot('toolu_wf');
    expect(snapshot?.agents.find((agent) => agent.id === 'opaque-third')).toMatchObject({
      title: 'third',
      status: 'complete',
      phaseTitle: 'Investigate',
      resultPreview: 'Finished third lane.',
    });
  });

  it('never displays a raw agent id for a terminal-arriving opaque journal fact (W-7)', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    // No script labels => no journal spec => the ordinal is the only fallback.
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
    // A `result` entry whose result carries no lane/label/message => the parser falls back to the
    // raw agentId as the title. This arrives already-terminal (status complete).
    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'result',
      key: 'v2:only',
      agentId: 'a36519ccc5c401aeb',
      result: {},
    }), { updatedAt: 1100 });

    const agent = tracker.getRunSnapshot('toolu_wf')?.agents[0];
    expect(agent?.status).toBe('complete');
    expect(agent?.title).toBe('Workflow agent 1');
    expect(agent?.title).not.toBe('a36519ccc5c401aeb');
  });

  it('does not borrow a declared script label for an opaque terminal fact it cannot attribute (RULING-13)', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUseWithScript({
      id: 'toolu_wf',
      script: `
phase('Investigate')
await parallel([
  agent('Read the docs', { label: 'doc-reader', phase: 'Investigate' }),
])
`,
    }), { updatedAt: 1000 });
    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'result',
      key: 'v2:only',
      agentId: 'b7c2raw',
      result: {},
    }), { updatedAt: 1100 });

    // One declared label and one agent LOOKS unambiguous, but the run can gain a second agent at
    // any time and the first would already be wearing spec 0's name. There is no derivable identity
    // between a journal key/agent id and a script label, so none is asserted.
    const agent = tracker.getRunSnapshot('toolu_wf')?.agents[0];
    expect(agent?.title).toBe('Workflow agent 1');
    expect(agent?.title).not.toBe('b7c2raw');
  });

  it('adopts a declared label only when the agent names it itself, and takes its phase with it', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUseWithScript({
      id: 'toolu_wf',
      script: `
phase('Investigate')
await parallel([
  agent('Read the docs', { label: 'doc-reader', phase: 'Investigate' }),
  agent('Check pins', { label: 'pin-ux', phase: 'Investigate' }),
])
`,
    }), { updatedAt: 1000 });
    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'result',
      key: 'v2:only',
      agentId: 'b7c2raw',
      // `lane` IS the agent naming itself; matching it to a declared label is identity, not position.
      result: { lane: 'pin-ux' },
    }), { updatedAt: 1100 });

    expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({
      title: 'pin-ux',
      phaseTitle: 'Investigate',
    });
  });

  it('keeps a genuine journal result title (lane) rather than substituting a placeholder (W-7)', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
    tracker.observe(workflowJournal({
      workflowToolUseId: 'toolu_wf',
      type: 'result',
      key: 'v2:only',
      agentId: 'rawid',
      result: { lane: 'auth-module', summary: 'done' },
    }), { updatedAt: 1100 });

    expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]?.title).toBe('auth-module');
  });

  it('keeps the ordinal fallback stable across re-observations (W-7)', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
    tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1100 });
    tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k2', agentId: 'raw-2' }), { updatedAt: 1101 });
    expect(tracker.getRunSnapshot('toolu_wf')?.agents.map((a) => a.title)).toEqual(['Workflow agent 1', 'Workflow agent 2']);

    // Re-observe the same started facts: ordinals must not drift.
    tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1200 });
    tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k2', agentId: 'raw-2' }), { updatedAt: 1201 });
    expect(tracker.getRunSnapshot('toolu_wf')?.agents.map((a) => a.title)).toEqual(['Workflow agent 1', 'Workflow agent 2']);
  });

  describe('agent sidecar profile (the agent transcript beside the journal)', () => {
    const agentProfile = (params: Readonly<{
      workflowToolUseId: string;
      agentId: string;
      prompt?: string;
      model?: string;
      sidechainId?: string;
      startedAt?: number;
      endedByApiError?: boolean;
      endedAt?: number;
      sessionId?: string;
    }>) => ({
      type: 'happier_workflow_agent_profile',
      workflowToolUseId: params.workflowToolUseId,
      agentId: params.agentId,
      sourceSessionId: params.sessionId ?? 'claude-session-1',
      ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.sidechainId !== undefined ? { sidechainId: params.sidechainId } : {}),
      ...(params.startedAt !== undefined ? { startedAt: params.startedAt } : {}),
      ...(params.endedByApiError !== undefined ? { endedByApiError: params.endedByApiError } : {}),
      ...(params.endedAt !== undefined ? { endedAt: params.endedAt } : {}),
    });

    /**
     * The open target reaches the record, and it reaches the RIGHT agent.
     *
     * Every agent of a run shares one `Workflow` tool call, so an import that leaked across agents
     * would show one of them the others' transcript. These assert the id lands per agent and never
     * on an agent that had none.
     */
    it('carries each agent’s imported sidechain onto its own snapshot, and only its own', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1100 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k2', agentId: 'raw-2' }), { updatedAt: 1101 });

      tracker.observe(agentProfile({
        workflowToolUseId: 'toolu_wf',
        agentId: 'raw-1',
        sidechainId: 'workflow_agent_sidechain:toolu_wf:raw-1',
      }), { updatedAt: 1150 });

      const agents = tracker.getRunSnapshot('toolu_wf')?.agents ?? [];
      expect(agents[0]).toMatchObject({ id: 'raw-1', sidechainId: 'workflow_agent_sidechain:toolu_wf:raw-1' });
      expect(agents[1]).not.toHaveProperty('sidechainId');
    });

    it('accepts a profile that proves only the import — an unnamed agent still becomes openable', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1100 });

      tracker.observe(agentProfile({
        workflowToolUseId: 'toolu_wf',
        agentId: 'raw-1',
        sidechainId: 'workflow_agent_sidechain:toolu_wf:raw-1',
      }), { updatedAt: 1150 });

      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({
        title: 'Workflow agent 1',
        sidechainId: 'workflow_agent_sidechain:toolu_wf:raw-1',
      });
    });

    it('remembers an import proven before the agent’s journal entry arrives', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(agentProfile({
        workflowToolUseId: 'toolu_wf',
        agentId: 'raw-1',
        sidechainId: 'workflow_agent_sidechain:toolu_wf:raw-1',
      }), { updatedAt: 1050 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1100 });

      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]?.sidechainId)
        .toBe('workflow_agent_sidechain:toolu_wf:raw-1');
    });

    it('replaces the ordinal of a RUNNING agent with the lane its own prompt declares, and carries its model', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1100 });
      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]?.title).toBe('Workflow agent 1');

      tracker.observe(agentProfile({
        workflowToolUseId: 'toolu_wf',
        agentId: 'raw-1',
        prompt: '## Program context\nblah\n\n# LANE CLI-1 — the tracker tells the truth\nbody',
        model: 'opus',
      }), { updatedAt: 1150 });

      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({
        id: 'raw-1',
        title: 'LANE CLI-1 — the tracker tells the truth',
        status: 'active',
        model: 'opus',
      });
    });

    it('names an agent whose profile is read before its journal entry arrives', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(agentProfile({
        workflowToolUseId: 'toolu_wf',
        agentId: 'raw-1',
        prompt: 'UNIT A — archaeology',
      }), { updatedAt: 1050 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1100 });

      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]?.title).toBe('UNIT A — archaeology');
    });

    /**
     * The pre-journal path is a supported contract, and a sidecar proves FOUR things — a name, a
     * model, an import, a start, and a death. The two above pin the first three; these pin the rest,
     * so a memo cannot quietly carry half of what was already observed.
     *
     * (Measured: over the real 144-agent session `15a64b1f`, 154 of 154 profile emissions arrive
     * AFTER the agent is on the roster, because the follower dispatches the journal wrapper
     * synchronously before its async sidecar read. These pin the contract, not a live defect.)
     */
    it('applies the start the agent’s own transcript proved before its journal entry arrived', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(agentProfile({ workflowToolUseId: 'toolu_wf', agentId: 'raw-1', startedAt: 4200 }), { updatedAt: 4500 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 5000 });

      // A memo that forgot the start would date the row from 5000 — the moment we happened to look.
      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]?.startedAt).toBe(4200);
    });

    it('resolves an agent whose transcript was proven dead before its journal entry arrived', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(agentProfile({
        workflowToolUseId: 'toolu_wf',
        agentId: 'raw-1',
        endedByApiError: true,
        endedAt: 4321,
      }), { updatedAt: 4500 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 5000 });

      // A stop, never a failure (RULING-14), at the last instant the file evidences — a `started`
      // line replayed after the transcript ended is not evidence the agent is running.
      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({
        status: 'cancelled',
        completedAt: 4321,
      });
      expect(tracker.getRunSnapshot('toolu_wf')?.status).toBe('active');
    });

    it('still lets an agent that reports its own outcome keep it after a death was proven first', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(agentProfile({
        workflowToolUseId: 'toolu_wf',
        agentId: 'raw-1',
        endedByApiError: true,
        endedAt: 4321,
      }), { updatedAt: 4500 });
      tracker.observe(workflowJournal({
        workflowToolUseId: 'toolu_wf',
        type: 'result',
        key: 'k1',
        agentId: 'raw-1',
        result: { lane: 'finished-lane' },
      }), { updatedAt: 5000 });

      // The self-report rule survives the reordering: applying a remembered death unconditionally
      // would overwrite an outcome the agent published for itself.
      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({
        title: 'finished-lane',
        status: 'complete',
        completedAt: 5000,
      });
    });

    it('never overrides the name the agent gave itself in its own result', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(workflowJournal({
        workflowToolUseId: 'toolu_wf',
        type: 'result',
        key: 'k1',
        agentId: 'raw-1',
        result: { lane: 'auth-module' },
      }), { updatedAt: 1100 });
      tracker.observe(agentProfile({
        workflowToolUseId: 'toolu_wf',
        agentId: 'raw-1',
        prompt: 'LANE something-else',
      }), { updatedAt: 1150 });

      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]?.title).toBe('auth-module');
    });

    it('creates no agent for a profile whose run is unknown', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      const obs = tracker.observe(agentProfile({ workflowToolUseId: 'toolu_unknown', agentId: 'raw-1', prompt: 'LANE x' }), { updatedAt: 1000 });
      expect(obs.changedRunIds).toEqual([]);
      expect(tracker.getRunSnapshotMap().size).toBe(0);
    });

    /**
     * The agent's own transcript carries its true start; the journal does not carry one at all, so
     * `startedAt` is otherwise the moment the CLI happened to notice. An EARLIER proven start is
     * strictly better evidence, and moving the start backwards can only lengthen an elapsed figure
     * towards the truth — the rule the later-stamp case below protects runs the other way.
     */
    it('prefers the start the agent’s own transcript records over the moment we noticed it', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 5000 });
      tracker.observe(agentProfile({ workflowToolUseId: 'toolu_wf', agentId: 'raw-1', startedAt: 4200 }), { updatedAt: 5100 });

      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]?.startedAt).toBe(4200);
    });

    it('never lets a later stamp shrink an elapsed figure already on screen', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1100 });
      tracker.observe(agentProfile({ workflowToolUseId: 'toolu_wf', agentId: 'raw-1', startedAt: 4200 }), { updatedAt: 5100 });

      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]?.startedAt).toBe(1100);
    });

    /**
     * The case neither a stop nor a resume can reach: the process is alive, the run is still open,
     * and one agent died of a terminal API error whose proof is the last record of a file the CLI
     * already reads. Measured over the 140 real sidecar transcripts of session `15a64b1f`: 12 carry
     * an `isApiErrorMessage` record and in 12 of 12 it is the FINAL record — the error is the end of
     * that agent's transcript, never something it recovered from.
     */
    it('resolves an agent whose own transcript ends in a terminal API error', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1100 });
      tracker.observe(agentProfile({
        workflowToolUseId: 'toolu_wf',
        agentId: 'raw-1',
        endedByApiError: true,
        endedAt: 4321,
      }), { updatedAt: 9000 });

      // A stop, never a failure (RULING-14), ending at the last instant the file evidences.
      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({
        status: 'cancelled',
        completedAt: 4321,
      });
      // The run is NOT closed by one dead child — an explicit run's status is its own lifecycle's.
      expect(tracker.getRunSnapshot('toolu_wf')?.status).toBe('active');
    });

    /**
     * A swept row and a proven death are not equal evidence. The sweep can only say "the last thing
     * we saw of this agent was its journal line"; the transcript says exactly when the agent stopped.
     * When both land — the real ordering, since the sidecar is read after the run's own events — the
     * proven instant wins, or the row reports the moment we looked as the moment it died.
     */
    it('replaces a swept end with the instant the transcript proves', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(taskStarted({ toolUseId: 'toolu_wf' }), { updatedAt: 1010 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1100 });
      tracker.observe(taskUpdatedCompleted({}), { updatedAt: 3000 });
      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({ status: 'cancelled', completedAt: 1100 });

      tracker.observe(agentProfile({
        workflowToolUseId: 'toolu_wf',
        agentId: 'raw-1',
        endedByApiError: true,
        endedAt: 2222,
      }), { updatedAt: 9000 });

      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({ status: 'cancelled', completedAt: 2222 });
    });

    it('does not overwrite an agent that already reported its own outcome', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(workflowJournal({
        workflowToolUseId: 'toolu_wf',
        type: 'result',
        key: 'k1',
        agentId: 'raw-1',
        result: { lane: 'finished-lane' },
      }), { updatedAt: 1100 });
      tracker.observe(agentProfile({
        workflowToolUseId: 'toolu_wf',
        agentId: 'raw-1',
        endedByApiError: true,
        endedAt: 4321,
      }), { updatedAt: 9000 });

      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({ status: 'complete', completedAt: 1100 });
    });

    it('creates no agent from a death observation alone', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(agentProfile({
        workflowToolUseId: 'toolu_wf',
        agentId: 'never-seen',
        endedByApiError: true,
        endedAt: 4321,
      }), { updatedAt: 9000 });

      // Reading a file is not evidence of a lifecycle transition for an agent nothing announced.
      expect(tracker.getRunSnapshot('toolu_wf')?.agents).toEqual([]);
    });
  });

  describe('agent start time (the elapsed-time slot)', () => {
    it('records when a live agent was first observed', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1100 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 5000 });

      // First observation wins: a later re-observation must not push the clock forward and shrink
      // the elapsed time the user reads.
      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]?.startedAt).toBe(1100);
    });

    it('leaves the start time blank for an agent first seen already finished', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(workflowJournal({
        workflowToolUseId: 'toolu_wf',
        type: 'result',
        key: 'k1',
        agentId: 'raw-1',
        result: { lane: 'late' },
      }), { updatedAt: 1100 });

      // We never saw it run, so we do not know when it started. An invented elapsed figure is worse
      // than a blank one.
      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]?.startedAt).toBeUndefined();
    });

    it('records a start time for a plain subagent promoted into the implicit run', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(subagentTask({ id: 'toolu_a', description: 'a' }), { updatedAt: 1000 });
      tracker.observe(subagentTask({ id: 'toolu_b', description: 'b' }), { updatedAt: 1200 });

      const agents = tracker.getRunSnapshot('implicit:agent-activity')?.agents ?? [];
      expect(agents.map((agent) => [agent.id, agent.startedAt])).toEqual([
        ['toolu_a', 1000],
        ['toolu_b', 1200],
      ]);
    });

    /**
     * A buffered subagent enters its run already terminal, so the create-time default (which fires
     * only for a live agent) leaves the slot blank. But this one WAS observed alive — the tracker
     * itself watched it start while it waited below the promotion threshold — so the blank is a
     * dropped observation, not an unknowable one. The rule above is not relaxed: nothing is
     * invented here, the instant we already saw is carried.
     */
    it('carries the observed start time of a buffered subagent that finished before promotion', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(subagentTask({ id: 'task_1', description: 'first' }), { updatedAt: 1000 });
      tracker.observe(subagentToolResult({ toolUseId: 'task_1' }), { updatedAt: 1500 });
      tracker.observe(subagentTask({ id: 'task_2', description: 'second' }), { updatedAt: 2000 });

      const agents = tracker.getRunSnapshot('implicit:agent-activity')?.agents ?? [];
      expect(agents.find((agent) => agent.id === 'task_1')?.status).toBe('complete');
      expect(agents.find((agent) => agent.id === 'task_1')?.startedAt).toBe(1000);
      // The live sibling that triggered the promotion is unaffected.
      expect(agents.find((agent) => agent.id === 'task_2')?.startedAt).toBe(2000);
    });

    /**
     * The raw transcript channel is NOT key-deduplicated the way `onMessage` is
     * (`sessionScanner.processSessionJsonValue` observes the raw value before `processedMessageKeys`
     * is consulted), and every observation is stamped with `Date.now()` rather than the line's own
     * time. So one `Task` line can reach the buffer twice — on a re-read, a resumed follow, or a
     * replay pass over content the live pass also sees.
     *
     * Re-observing a start we already buffered teaches us nothing, and treating it as new evidence
     * loses two things at once: the first-observation start time (shrinking the elapsed figure) and
     * the recorded outcome, which resurrects a finished subagent as `active` — the exact resurrection
     * the buffer's own contract says it exists to prevent.
     */
    it('ignores a replayed start for a subagent already buffered, keeping its outcome and its first start', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(subagentTask({ id: 'task_1', description: 'first' }), { updatedAt: 1000 });
      tracker.observe(subagentToolResult({ toolUseId: 'task_1' }), { updatedAt: 1500 });
      tracker.observe(subagentTask({ id: 'task_1', description: 'first' }), { updatedAt: 1800 });
      tracker.observe(subagentTask({ id: 'task_2', description: 'second' }), { updatedAt: 2000 });

      const run = tracker.getRunSnapshot('implicit:agent-activity');
      const replayed = run?.agents.find((agent) => agent.id === 'task_1');
      expect(replayed?.status).toBe('complete');
      expect(replayed?.startedAt).toBe(1000);
      // A duplicate is not a second agent, and the run still has one live member.
      expect(run?.totalAgents).toBe(2);
      expect(run?.completedAgents).toBe(1);
    });

    /**
     * The other half of the slot. `startedAt` alone renders nothing on a finished row: the row asks
     * for an interval, and a journal `result` carries no timestamp of its own, so the instant we
     * OBSERVED the terminal transition is the only end this channel can supply.
     */
    it('records when a finished agent finished, so a completed row can show a duration', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1100 });
      tracker.observe(workflowJournal({
        workflowToolUseId: 'toolu_wf',
        type: 'result',
        key: 'k1',
        agentId: 'raw-1',
        result: { lane: 'W29' },
      }), { updatedAt: 5000 });

      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({
        status: 'complete',
        startedAt: 1100,
        completedAt: 5000,
      });
    });

    it('records the end of a plain subagent closed by its own tool_result', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(subagentTask({ id: 'task_1', description: 'first' }), { updatedAt: 1000 });
      tracker.observe(subagentTask({ id: 'task_2', description: 'second' }), { updatedAt: 1200 });
      tracker.observe(subagentToolResult({ toolUseId: 'task_1' }), { updatedAt: 4000 });

      const agents = tracker.getRunSnapshot('implicit:agent-activity')?.agents ?? [];
      expect(agents.find((agent) => agent.id === 'task_1')).toMatchObject({ startedAt: 1000, completedAt: 4000 });
      // The live sibling has no end, and none is invented for it.
      expect(agents.find((agent) => agent.id === 'task_2')?.completedAt).toBeUndefined();
    });
  });

  /**
   * A run that is over holds no running work.
   *
   * The journal is the only per-agent terminal channel a workflow agent has, and it is silent for
   * the ~19% of agents cut off mid-flight (measured across 33 real sidecar journals: 134 `started`,
   * 109 `result`). Those agents used to keep `active` forever inside a `complete` run, and because
   * the UI counter deliberately attributes a member only to a LIVE run, each one was promoted to a
   * loose "subagent working" — nine of them in the reported screenshot. The input was poisoned, not
   * the counter, so the resolution belongs here.
   *
   * This is NOT RULING-14: that triggers on process death, this triggers on run completion inside a
   * living process. Two observations, one shared helper.
   */
  describe('run completion resolves the agents the run left behind', () => {
    it('cancels every agent still mid-flight when the run reaches a terminal status', () => {
      // The real wave-25 shape: four agents, ONE journal `result`, three `started`-only.
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'aau-wave-25' }), { updatedAt: 1000 });
      tracker.observe(taskStarted({ toolUseId: 'toolu_wf' }), { updatedAt: 1010 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1100 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k2', agentId: 'raw-2' }), { updatedAt: 1200 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k3', agentId: 'raw-3' }), { updatedAt: 1300 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k4', agentId: 'raw-4' }), { updatedAt: 1400 });
      tracker.observe(workflowJournal({
        workflowToolUseId: 'toolu_wf',
        type: 'result',
        key: 'k3',
        agentId: 'raw-3',
        result: { lane: 'W25-SEAMS' },
      }), { updatedAt: 2000 });

      tracker.observe(taskUpdatedCompleted({}), { updatedAt: 3000 });

      const snapshot = tracker.getRunSnapshot('toolu_wf');
      expect(snapshot?.status).toBe('complete');
      expect(snapshot?.agents.map((agent) => [agent.id, agent.status, agent.completedAt])).toEqual([
        // Cut off, not failed (RULING-14's vocabulary one level down), and each stops at the last
        // instant we actually have evidence for rather than at the run's end.
        ['raw-1', 'cancelled', 1100],
        ['raw-2', 'cancelled', 1200],
        ['raw-3', 'complete', 2000],
        ['raw-4', 'cancelled', 1400],
      ]);
      expect(snapshot?.agents.some((agent) => agent.status === 'failed')).toBe(false);
      expect(snapshot?.agents.every((agent) => agent.updatedAt === 3000 || agent.id === 'raw-3')).toBe(true);
    });

    it('leaves a run whose agents all reported results exactly as they were (wave-22 control)', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'aau-wave-22' }), { updatedAt: 1000 });
      tracker.observe(taskStarted({ toolUseId: 'toolu_wf' }), { updatedAt: 1010 });
      for (const [index, agentId] of ['raw-1', 'raw-2'].entries()) {
        tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: `k${index}`, agentId }), { updatedAt: 1100 + index });
        tracker.observe(workflowJournal({
          workflowToolUseId: 'toolu_wf',
          type: 'result',
          key: `k${index}`,
          agentId,
          result: { lane: `W22-${index}` },
        }), { updatedAt: 2100 + index });
      }

      tracker.observe(taskUpdatedCompleted({}), { updatedAt: 3000 });

      expect(tracker.getRunSnapshot('toolu_wf')?.agents.map((agent) => [agent.status, agent.completedAt, agent.updatedAt])).toEqual([
        ['complete', 2100, 2100],
        ['complete', 2101, 2101],
      ]);
    });

    /**
     * The completion sweep runs once, at the transition — but the journal follower keeps draining
     * for a grace window after it, and a resumed process reads the sidecar only after replaying the
     * whole transcript. Both deliver `started` entries for a run that has already finished.
     *
     * Measured on the real session: replaying its 3 064 records through this tracker leaves 37 of 39
     * runs terminal BEFORE the sidecar journals are drained, so this is the ordering that actually
     * occurs, not a hypothetical. An explicit run's status never reopens (nothing in this file moves
     * a terminal explicit run back to `active`), so an agent arriving inside one is not running.
     */
    it('resolves an agent whose journal entry lands after its run already finished', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(taskStarted({ toolUseId: 'toolu_wf' }), { updatedAt: 1150 });
      tracker.observe(taskUpdatedCompleted({}), { updatedAt: 1200 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-late' }), { updatedAt: 1300 });

      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({
        id: 'raw-late',
        status: 'cancelled',
        completedAt: 1300,
      });
    });

    /**
     * The synthesized implicit run is the deliberate exception: it has no lifecycle of its own, so
     * it is closed BY its agents — and it must reopen when new work joins it, or the very next plain
     * subagent becomes a live row inside a finished card, which is the same lie from the other side.
     */
    it('reopens the implicit run when a new subagent joins it after it closed', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(subagentTask({ id: 'task_1', description: 'first' }), { updatedAt: 1000 });
      tracker.observe(subagentTask({ id: 'task_2', description: 'second' }), { updatedAt: 1100 });
      tracker.observe(subagentToolResult({ toolUseId: 'task_1' }), { updatedAt: 1200 });
      tracker.observe(subagentToolResult({ toolUseId: 'task_2' }), { updatedAt: 1300 });
      expect(tracker.getRunSnapshot('implicit:agent-activity')?.status).toBe('complete');

      tracker.observe(subagentTask({ id: 'task_3', description: 'third' }), { updatedAt: 1400 });

      const snapshot = tracker.getRunSnapshot('implicit:agent-activity');
      expect(snapshot?.status).toBe('active');
      expect(snapshot?.agents.find((agent) => agent.id === 'task_3')?.status).toBe('active');
      expect(snapshot?.completedAt).toBeUndefined();
    });

    it('resolves the agents of a run reconciled from a stale headline, so no live row hangs under a stopped run', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'interrupted' }), { updatedAt: 1000, live: false });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), {
        updatedAt: 1100,
        live: false,
      });

      tracker.reconcileInterruptedRunFromHeadline({
        runId: 'toolu_wf',
        title: 'interrupted',
        workflowToolUseId: 'toolu_wf',
        totalAgents: 1,
        completedAgents: 0,
      }, { updatedAt: 9000 });

      const snapshot = tracker.getRunSnapshot('toolu_wf');
      expect(snapshot).toMatchObject({ status: 'stopped', statusReason: 'interrupted' });
      expect(snapshot?.agents.map((agent) => [agent.status, agent.completedAt])).toEqual([['cancelled', 1100]]);
    });
  });

  describe('finalizeInterruptedActivityOnShutdown (RULING-14: terminal state on process death)', () => {
    it('resolves a run and its live agents when the process that owned them goes away', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-1' }), { updatedAt: 1100 });
      tracker.observe(workflowJournal({
        workflowToolUseId: 'toolu_wf',
        type: 'result',
        key: 'k2',
        agentId: 'raw-2',
        result: { lane: 'done-lane' },
      }), { updatedAt: 1200 });

      const observation = tracker.finalizeInterruptedActivityOnShutdown({ updatedAt: 9000 });
      expect(observation.changedRunIds).toEqual(['toolu_wf']);
      expect(observation.terminalRunIds).toEqual(['toolu_wf']);

      const snapshot = tracker.getRunSnapshot('toolu_wf');
      // A crash is a stop, never a failure — the run contract already ruled that; agents inherit it.
      expect(snapshot).toMatchObject({ status: 'stopped', statusReason: 'interrupted', completedAt: 9000 });
      expect(snapshot?.agents.map((agent) => [agent.id, agent.status, agent.completedAt])).toEqual([
        // The live agent stops at the last instant we have evidence for, not at the teardown instant.
        ['raw-1', 'cancelled', 1100],
        // An agent that already finished keeps its own outcome, and the instant it reported it.
        ['raw-2', 'complete', 1200],
      ]);
      expect(snapshot?.agents.every((agent) => agent.status !== 'failed')).toBe(true);
    });

    /**
     * The two sweeps must not fight. A finished run's agents are resolved when the run finishes —
     * including the late journal arrivals the follower delivers during its grace drain — so by the
     * time the process dies there is nothing of that run left to touch, and shutdown reports no
     * change for it rather than re-stamping settled rows with the teardown instant.
     */
    it('leaves a finished run alone: its agents were already resolved when it finished', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(taskStarted({ toolUseId: 'toolu_wf' }), { updatedAt: 1150 });
      tracker.observe(taskUpdatedCompleted({}), { updatedAt: 1200 });
      tracker.observe(workflowJournal({ workflowToolUseId: 'toolu_wf', type: 'started', key: 'k1', agentId: 'raw-late' }), { updatedAt: 1300 });
      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({ status: 'cancelled', completedAt: 1300 });

      const observation = tracker.finalizeInterruptedActivityOnShutdown({ updatedAt: 9000 });
      expect(observation.changedRunIds).toEqual([]);
      expect(tracker.getRunSnapshot('toolu_wf')?.agents[0]).toMatchObject({ status: 'cancelled', completedAt: 1300, updatedAt: 1300 });
    });

    it('changes nothing when every run and agent already reached a terminal state', () => {
      const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
      tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'plain' }), { updatedAt: 1000 });
      tracker.observe(workflowJournal({
        workflowToolUseId: 'toolu_wf',
        type: 'result',
        key: 'k1',
        agentId: 'raw-1',
        result: { lane: 'done' },
      }), { updatedAt: 1100 });
      tracker.observe(taskStarted({ toolUseId: 'toolu_wf' }), { updatedAt: 1150 });
      tracker.observe(taskUpdatedCompleted({}), { updatedAt: 1200 });

      const observation = tracker.finalizeInterruptedActivityOnShutdown({ updatedAt: 9000 });
      expect(observation.changedRunIds).toEqual([]);
      expect(tracker.getRunSnapshot('toolu_wf')).toMatchObject({ status: 'complete' });
      expect(tracker.getRunSnapshot('toolu_wf')?.statusReason).toBeUndefined();
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

  it('rejects persisted JSONL workflow anchors from a foreign camelCase source session', () => {
    const tracker = createClaudeWorkflowActivityTracker({
      backendId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
    });

    const obs = tracker.observe({
      type: 'assistant',
      sessionId: 'other-session',
      uuid: 'uuid-foreign',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_foreign',
          name: 'Workflow',
          input: { script: "meta: { name: 'foreign' }" },
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

  it('does not report a duplicate normalized progress snapshot as changed', () => {
    const tracker = createClaudeWorkflowActivityTracker({ backendId: 'claude' });
    tracker.observe(workflowToolUse({ id: 'toolu_wf', name: 'wf' }), { updatedAt: 1000 });
    const progress = () => taskProgress({
      toolUseId: 'toolu_wf',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'P' },
        { type: 'workflow_agent', agentId: 'a1', label: 'a', phaseIndex: 1, state: 'running', tokens: 10 },
      ],
    });
    tracker.observe(progress(), { updatedAt: 2000 });
    const obs = tracker.observe(progress(), { updatedAt: 2500 });
    expect(obs.changedRunIds).toEqual([]);
  });
});

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
});

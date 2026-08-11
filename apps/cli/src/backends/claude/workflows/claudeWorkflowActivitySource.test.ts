import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { SessionWorkflowActivityHeadlineV1, SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';
import { createClaudeWorkflowActivitySource as createProductionClaudeWorkflowActivitySource } from './claudeWorkflowActivitySource';
function createClaudeWorkflowActivitySource(
  params: Parameters<typeof createProductionClaudeWorkflowActivitySource>[0],
) {
  return createProductionClaudeWorkflowActivitySource(params);
}

function workflowToolUse(id: string, name: string, sessionId = 'claude-session-1') {
  return {
    type: 'assistant',
    session_id: sessionId,
    uuid: `uuid-${id}`,
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Workflow',
          input: { script: `export const meta = { name: '${name}', phases: [{ title: 'Verify' }] }` },
        },
      ],
    },
  };
}

function workflowLaunchResult(toolUseId: string, transcriptDir: string, sessionId = 'claude-session-1') {
  return {
    type: 'user',
    sessionId,
    uuid: `uuid-launch-${toolUseId}`,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Workflow launched in background.\nTranscript dir: ${transcriptDir}`,
          is_error: false,
        },
      ],
    },
    toolUseResult: {
      status: 'async_launched',
      taskId: 'workflow-task-1',
      taskType: 'local_workflow',
      workflowName: 'sidecar-wf',
      runId: 'wf_sidecar',
      transcriptDir,
    },
  };
}

function workflowLaunchWithIdentity(params: Readonly<{
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
        content: `Workflow launched in background. Task ID: ${params.taskId}\nRun ID: ${params.providerRunId}`,
        is_error: false,
      }],
    },
    toolUseResult: {
      status: 'async_launched',
      taskId: params.taskId,
      taskType: 'local_workflow',
      workflowName: 'sidecar-wf',
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
        content: `{"message":"Successfully stopped task: ${taskId}","task_id":"${taskId}","task_type":"local_workflow"}`,
        is_error: false,
      }],
    },
    toolUseResult: {
      message: `Successfully stopped task: ${taskId} (Workflow title)`,
      task_id: taskId,
      task_type: 'local_workflow',
    },
  };
}

function workflowFailedResult(toolUseId: string, sessionId = 'claude-session-1') {
  return {
    type: 'user',
    session_id: sessionId,
    uuid: `uuid-failed-${toolUseId}`,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content:
            '<tool_use_error>Invalid workflow script: Script parse error: Unexpected token (226:0).</tool_use_error>',
          is_error: true,
        },
      ],
    },
  };
}

function agentAsyncLaunchResult(toolUseId: string, sessionId = 'claude-session-1') {
  return {
    type: 'user',
    session_id: sessionId,
    uuid: `uuid-agent-launch-${toolUseId}`,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [
            {
              type: 'text',
              text:
                "Async agent launched successfully.\nagentId: a92c3cece749417e2 (internal ID - do not mention to user.)",
            },
          ],
          is_error: false,
        },
      ],
    },
    toolUseResult: {
      status: 'async_launched',
      agentId: 'a92c3cece749417e2',
    },
  };
}

function terminalUpdate(taskId = 'w1', sessionId = 'claude-session-1', status = 'completed') {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: taskId,
    patch: { status, end_time: 9999 },
    session_id: sessionId,
    uuid: 'uuid-term',
  };
}

function taskStarted(toolUseId: string, taskId = 'w1', sessionId = 'claude-session-1') {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    task_type: 'local_workflow',
    description: 'work',
    session_id: sessionId,
    uuid: 'uuid-started',
  };
}

describe('createClaudeWorkflowActivitySource', () => {
  const tempDirs: string[] = [];

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function setup() {
    const committed: string[] = [];
    const headlines: unknown[] = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async (s) => { committed.push(s.runId); },
      writeHeadlines: (bundle) => { headlines.push(bundle.workflow); },
      debounceMs: 300,
    });
    return { committed, headlines, source };
  }

  it('publishes a run record + headline immediately on a Workflow start', async () => {
    const { committed, headlines, source } = setup();
    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    await vi.advanceTimersByTimeAsync(0);
    expect(committed).toContain('toolu_wf');
    expect(headlines).toHaveLength(1);
  });

  it('publishes immediately on a terminal transition', async () => {
    const { committed, source } = setup();
    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    source.observeTranscriptMessage(taskStarted('toolu_wf'));
    await vi.advanceTimersByTimeAsync(0);
    committed.length = 0;
    source.observeTranscriptMessage(terminalUpdate());
    await vi.advanceTimersByTimeAsync(0);
    expect(committed).toContain('toolu_wf');
  });

  it('keeps one durable workflow card across provider-run reattachment and publishes exact provider-task terminals', async () => {
    const headlines: SessionWorkflowActivityHeadlineV1[] = [];
    const providerTaskActivities: unknown[] = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async () => {},
      writeHeadlines: (bundle) => { headlines.push(bundle.workflow); },
      onProviderTaskActivity: async (activity) => { providerTaskActivities.push(activity); },
      debounceMs: 0,
    });

    source.observeTranscriptMessage(workflowToolUse('toolu_initial', 'sidecar-wf'));
    source.observeTranscriptMessage(workflowLaunchWithIdentity({
      toolUseId: 'toolu_initial',
      taskId: 'task-initial',
      providerRunId: 'wf-provider-run',
    }));
    await source.flush();

    source.observeTranscriptMessage(workflowToolUse('toolu_resume', 'sidecar-wf'));
    source.observeTranscriptMessage(workflowLaunchWithIdentity({
      toolUseId: 'toolu_resume',
      taskId: 'task-resume',
      providerRunId: 'wf-provider-run',
    }));
    await source.flush();

    expect(headlines.at(-1)?.activeRuns).toHaveLength(1);
    expect(headlines.at(-1)?.activeRuns[0]?.runId).toBe('toolu_initial');
    expect(providerTaskActivities).toContainEqual({
      type: 'terminal',
      sessionId: 'claude-session-1',
      taskId: 'task-initial',
      rememberIfUnknown: true,
    });

    source.observeTranscriptMessage(successfulWorkflowTaskStop('task-resume'));
    await source.flush();
    expect(headlines.at(-1)?.activeRuns).toEqual([]);
    expect(headlines.at(-1)?.recentRuns?.[0]?.status).toBe('cancelled');
    expect(providerTaskActivities).toContainEqual({
      type: 'terminal',
      terminalStatus: 'stopped',
      sessionId: 'claude-session-1',
      taskId: 'task-resume',
    });

    source.dispose();
  });

  it('does not publish provider-task activity from historical workflow replay', async () => {
    const providerTaskActivities: unknown[] = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async () => {},
      writeHeadlines: () => {},
      onProviderTaskActivity: async (activity) => { providerTaskActivities.push(activity); },
      debounceMs: 0,
    });

    source.observeTranscriptMessage(
      workflowToolUse('toolu_wf', 'sidecar-wf'),
      { historicalReplay: true },
    );
    source.observeTranscriptMessage(
      workflowLaunchWithIdentity({
        toolUseId: 'toolu_wf',
        taskId: 'task-1',
        providerRunId: 'wf-provider-run',
      }),
      { historicalReplay: true },
    );
    source.observeTranscriptMessage(
      successfulWorkflowTaskStop('task-1'),
      { historicalReplay: true },
    );
    await source.flush();

    expect(providerTaskActivities).toEqual([]);
    source.dispose();
  });

  it('terminalizes a failed Workflow tool result so it leaves active workflow headlines', async () => {
    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const headlines: SessionWorkflowActivityHeadlineV1[] = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async (snapshot) => { committed.push(snapshot); },
      writeHeadlines: (bundle) => { headlines.push(bundle.workflow); },
      debounceMs: 300,
    });

    source.observeTranscriptMessage(workflowToolUse('toolu_failed_wf', 'failed-wf'));
    await vi.advanceTimersByTimeAsync(0);
    source.observeTranscriptMessage(workflowFailedResult('toolu_failed_wf'));
    await vi.advanceTimersByTimeAsync(0);

    expect(committed.at(-1)).toEqual(expect.objectContaining({
      runId: 'toolu_failed_wf',
      status: 'failed',
      totalAgents: 0,
      completedAgents: 0,
    }));
    expect(headlines.at(-1)?.activeRuns.map((run) => run.runId)).not.toContain('toolu_failed_wf');
    expect(headlines.at(-1)?.recentRuns?.map((run) => run.runId)).toContain('toolu_failed_wf');

    source.dispose();
  });

  it('does not publish workflow records or headlines for async Agent launches', async () => {
    const { committed, headlines, source } = setup();
    source.observeTranscriptMessage(agentAsyncLaunchResult('toolu_agent'));
    await vi.advanceTimersByTimeAsync(0);

    expect(committed).toEqual([]);
    expect(headlines).toEqual([]);

    source.dispose();
  });

  it('ignores non-workflow transcript noise', async () => {
    const { committed, source } = setup();
    source.observeTranscriptMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    await vi.advanceTimersByTimeAsync(300);
    expect(committed).toHaveLength(0);
  });

  it('rejects foreign-session workflow events', async () => {
    const { committed, source } = setup();
    source.observeTranscriptMessage(workflowToolUse('toolu_x', 'wf', 'other-session'));
    await vi.advanceTimersByTimeAsync(0);
    expect(committed).toHaveLength(0);
  });

  it('exposes workflow-owned agent ids for the CWF4 work-state filter', async () => {
    const { source } = setup();
    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    source.observeTranscriptMessage({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'w1',
      tool_use_id: 'toolu_wf',
      task_type: 'local_workflow',
      session_id: 'claude-session-1',
      workflow_progress: [
        { type: 'workflow_phase', index: 1, title: 'P' },
        { type: 'workflow_agent', agentId: 'agent_1', label: 'a', phaseIndex: 1, state: 'running' },
      ],
      uuid: 'uuid-prog',
    });
    expect(source.getWorkflowOwnedAgentToolUseIds().has('agent_1')).toBe(true);
    expect(source.isWorkflowOwnedTaskReference({ toolUseId: 'toolu_wf' })).toBe(true);
    expect(source.isWorkflowOwnedTaskReference({ taskId: 'w1' })).toBe(true);
    expect(source.isWorkflowOwnedTaskReference({ taskId: 'plain-task' })).toBe(false);
  });

  it('flush() drains pending progress writes', async () => {
    const committed: string[] = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async (s) => { committed.push(s.runId); },
      writeHeadlines: () => {},
      debounceMs: 5000,
    });
    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    await vi.advanceTimersByTimeAsync(0);
    committed.length = 0;
    // A progress-only update is debounced; flush forces it out.
    source.observeTranscriptMessage(taskStarted('toolu_wf'));
    source.observeTranscriptMessage({
      type: 'system', subtype: 'task_progress', task_id: 'w1', tool_use_id: 'toolu_wf',
      task_type: 'local_workflow', session_id: 'claude-session-1',
      usage: { total_tokens: 50 }, uuid: 'p2',
    });
    await source.flush();
    expect(committed).toContain('toolu_wf');
  });

  it('resolves live runs and agents when the process that owned them shuts down (RULING-14)', async () => {
    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async (snapshot) => { committed.push(snapshot); },
      writeHeadlines: () => {},
      debounceMs: 300,
    });

    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'shutdown-wf'));
    source.observeTranscriptMessage({
      type: 'happier_workflow_journal',
      workflowToolUseId: 'toolu_wf',
      sourceSessionId: 'claude-session-1',
      entry: { type: 'started', key: 'k1', agentId: 'agent_live' },
    });
    await source.flush();
    committed.length = 0;

    source.finalizeInterruptedActivityOnShutdown();
    await source.flush();

    const snapshot = committed.at(-1);
    expect(snapshot).toMatchObject({ runId: 'toolu_wf', status: 'stopped', statusReason: 'interrupted' });
    expect(snapshot?.agents.map((agent) => agent.status)).toEqual(['cancelled']);

    source.dispose();
  });

  it('hydrates unified Workflow launch results from the sidecar journal', async () => {
    const transcriptDir = await mkdtemp(join(tmpdir(), 'happier-workflow-sidecar-'));
    tempDirs.push(transcriptDir);
    await writeFile(join(transcriptDir, 'journal.jsonl'), [
      JSON.stringify({ type: 'started', key: 'lane-1', agentId: 'agent_alpha' }),
      JSON.stringify({ type: 'started', key: 'lane-2', agentId: 'agent_beta' }),
      JSON.stringify({
        type: 'result',
        key: 'lane-1',
        agentId: 'agent_alpha',
        result: { lane: 'alpha-review', verdict: 'plan_correct', summary: 'Alpha lane finished.' },
      }),
    ].join('\n') + '\n');

    const committed: SessionWorkflowRunSnapshotV1[] = [];
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-session-1',
      commitRecord: async (snapshot) => { committed.push(snapshot); },
      writeHeadlines: () => {},
      debounceMs: 300,
    });

    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'sidecar-wf'));
    await vi.advanceTimersByTimeAsync(0);
    committed.length = 0;

    source.observeTranscriptMessage(workflowLaunchResult('toolu_wf', transcriptDir));
    await source.flush();

    const snapshot = committed.at(-1);
    expect(snapshot?.runId).toBe('toolu_wf');
    expect(snapshot?.phases.map((phase) => phase.title)).toEqual(['Verify']);
    expect(snapshot?.phases[0]?.agentIds).toEqual(['agent_alpha', 'agent_beta']);
    expect(snapshot?.totalAgents).toBe(2);
    expect(snapshot?.completedAgents).toBe(1);
    expect(snapshot?.agents.map((agent) => ({ id: agent.id, title: agent.title, status: agent.status }))).toEqual([
      { id: 'agent_alpha', title: 'alpha-review', status: 'complete' },
      { id: 'agent_beta', title: 'Workflow agent 2', status: 'active' },
    ]);
    expect(snapshot?.agents[0]?.resultPreview).toContain('Alpha lane finished.');

    source.dispose();
  });
});

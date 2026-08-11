import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';

import { createClaudeWorkflowActivitySource as createProductionClaudeWorkflowActivitySource } from './claudeWorkflowActivitySource';
function createClaudeWorkflowActivitySource(params: Parameters<typeof createProductionClaudeWorkflowActivitySource>[0]) {
  return createProductionClaudeWorkflowActivitySource(params);
}
import { routeClaudeSdkMessageToWorkflowSource } from './routeClaudeSdkMessageToWorkflowSource';

/**
 * The EMPIRICAL agent-SDK `--output-format stream-json` shapes (see the audit probe): a `Workflow`
 * tool-use anchor on an `assistant` message, then `system` lifecycle messages carrying the rich
 * `workflow_progress[]` and the terminal `task_notification`.
 */
const SESSION_ID = 'claude-session-1';

function workflowAnchor() {
  return {
    type: 'assistant',
    session_id: SESSION_ID,
    uuid: 'uuid-anchor',
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { script: "meta: { name: 'ship-feature' }" } },
      ],
    },
  };
}

function taskStarted() {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: 'w1',
    tool_use_id: 'toolu_wf',
    task_type: 'local_workflow',
    workflow_name: 'ship-feature',
    session_id: SESSION_ID,
    uuid: 'uuid-started',
  };
}

function taskProgressWithWorkflowProgress() {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: 'w1',
    tool_use_id: 'toolu_wf',
    task_type: 'local_workflow',
    session_id: SESSION_ID,
    usage: { total_tokens: 120500, tool_uses: 14, duration_ms: 18750 },
    workflow_progress: [
      { type: 'workflow_phase', index: 1, title: 'Research' },
      { type: 'workflow_phase', index: 2, title: 'Implementation' },
      { type: 'workflow_agent', agentId: 'agent_1', label: 'web_search', phaseIndex: 1, phaseTitle: 'Research', state: 'done', tokens: 9000 },
      { type: 'workflow_agent', agentId: 'agent_2', label: 'coder', phaseIndex: 2, phaseTitle: 'Implementation', state: 'running', tokens: 4200 },
    ],
    uuid: 'uuid-progress',
  };
}

function taskNotificationCompleted() {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'w1',
    tool_use_id: 'toolu_wf',
    status: 'completed',
    output_file: '/tmp/out.md',
    summary: 'Done',
    session_id: SESSION_ID,
    uuid: 'uuid-notification',
  };
}

describe('routeClaudeSdkMessageToWorkflowSource', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup() {
    const committed: SessionWorkflowRunSnapshotV1[] = [];
    // commitRecord / writeHeadlines are the durable-record + metadata write BOUNDARIES; the source
    // itself (tracker + correlation parser) is real internal logic exercised end-to-end here.
    const source = createClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => SESSION_ID,
      commitRecord: async (snapshot) => { committed.push(snapshot); },
      writeHeadlines: () => {},
      debounceMs: 300,
    });
    return { committed, source };
  }

  it('feeds the agent-SDK system stream so task_progress builds phases/agents and task_notification flips terminal', async () => {
    const { committed, source } = setup();
    const route = (message: unknown) => routeClaudeSdkMessageToWorkflowSource({
      message,
      runnerKind: 'agentSdk',
      workflowActivitySource: source,
    });

    route(workflowAnchor());
    route(taskStarted());
    route(taskProgressWithWorkflowProgress());
    await source.flush();

    const progressSnapshot = committed.at(-1);
    expect(progressSnapshot?.runId).toBe('toolu_wf');
    expect(progressSnapshot?.phases.map((phase) => phase.title)).toEqual(['Research', 'Implementation']);
    expect(progressSnapshot?.agents.map((agent) => agent.id).sort()).toEqual(['agent_1', 'agent_2']);
    expect(progressSnapshot?.status).toBe('active');
    expect(source.isWorkflowOwnedProviderTaskId('w1')).toBe(true);

    committed.length = 0;
    route(taskNotificationCompleted());
    await source.flush();

    const terminalSnapshot = committed.at(-1);
    expect(terminalSnapshot?.runId).toBe('toolu_wf');
    expect(terminalSnapshot?.status).toBe('complete');
  });

  it('does NOT feed the source for the unified runner (null kind) — that runner uses the raw channel, so onMessage would double-feed', async () => {
    const { committed, source } = setup();
    const route = (message: unknown) => routeClaudeSdkMessageToWorkflowSource({
      message,
      runnerKind: null,
      workflowActivitySource: source,
    });

    route(workflowAnchor());
    route(taskStarted());
    route(taskProgressWithWorkflowProgress());
    await source.flush();

    expect(committed).toHaveLength(0);
  });

  it('is a no-op when no workflow source is wired (no credentials yet)', () => {
    expect(() => routeClaudeSdkMessageToWorkflowSource({
      message: workflowAnchor(),
      runnerKind: 'agentSdk',
      workflowActivitySource: null,
    })).not.toThrow();
  });
});

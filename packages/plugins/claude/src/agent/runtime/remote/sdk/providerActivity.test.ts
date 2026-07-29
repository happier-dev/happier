import { describe, expect, it, vi } from 'vitest';
import {
  createClaudeProviderActivityLedger,
  isClaudeProviderActivityHookObservationLoss,
  readClaudeProviderTaskActivity,
} from './providerActivity.js';
import * as providerActivityModule from './providerActivity.js';

describe('Claude provider task lifecycle', () => {
  it('separates strict activity evidence from task-id-only operational interrupt evidence', () => {
    const normalize = (providerActivityModule as Record<string, unknown>).normalizeClaudeProviderTaskEvent;
    expect(normalize).toBeTypeOf('function');
    if (typeof normalize !== 'function') return;

    expect(normalize({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-without-session',
      task_type: 'local_agent',
    })).toEqual({
      activity: null,
      interruptTarget: { type: 'active', taskId: 'task-without-session' },
    });
    expect(normalize({
      type: 'user',
      toolUseResult: { status: 'async_launched', agentId: 'async-agent' },
    })).toEqual({
      activity: null,
      interruptTarget: { type: 'active', taskId: 'async-agent' },
    });
    expect(normalize({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'task-without-session',
      patch: { status: 'running' },
    })).toEqual({
      activity: null,
      interruptTarget: { type: 'active', taskId: 'task-without-session' },
    });
    expect(normalize({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'task-without-session',
      patch: { status: 'killed' },
    })).toEqual({
      activity: null,
      interruptTarget: { type: 'terminal', taskId: 'task-without-session' },
    });
  });

  it('recognizes only exact current-session non-success responses for Activity hooks', () => {
    for (const [hookEvent, outcome] of [
      ['PostToolUse', 'error'],
      ['SubagentStart', 'cancelled'],
      ['SubagentStop', 'error'],
    ] as const) {
      expect(isClaudeProviderActivityHookObservationLoss({
        type: 'system',
        subtype: 'hook_response',
        hook_name: `${hookEvent}:probe`,
        hook_event: hookEvent,
        outcome,
        exit_code: 41,
        output: '',
        stdout: '',
        stderr: '',
        session_id: 'current-session',
        uuid: `hook-${hookEvent}`,
      }, 'current-session')).toBe(true);
    }

    for (const row of [
      { type: 'system', subtype: 'hook_response', hook_event: 'PostToolUse', outcome: 'success', session_id: 'current-session' },
      { type: 'system', subtype: 'hook_response', hook_event: 'SessionStart', outcome: 'error', session_id: 'current-session' },
      { type: 'system', subtype: 'hook_response', hook_event: 'PostToolUse', outcome: 'error', session_id: 'other-session' },
      { type: 'system', subtype: 'hook_response', hook_event: 'PostToolUse', outcome: 'unknown', session_id: 'current-session' },
      { type: 'system', subtype: 'hook_response', hook_event: 'PostToolUse', outcome: 'error', session_id: 'current-session', isReplay: true },
      { type: 'system', subtype: 'init', hook_event: 'PostToolUse', outcome: 'error', session_id: 'current-session' },
    ]) {
      expect(isClaudeProviderActivityHookObservationLoss(row, 'current-session')).toBe(false);
    }
    expect(isClaudeProviderActivityHookObservationLoss({
      type: 'system', subtype: 'hook_response', hook_event: 'PostToolUse', outcome: 'error', session_id: 'current-session',
    }, null)).toBe(false);
  });

  it('accepts the exact typed lifecycle status grammar', () => {
    expect(readClaudeProviderTaskActivity({
      type: 'system', subtype: 'task_started', session_id: ' s1 ', task_id: ' t1 ',
      task_type: 'local_workflow',
    })).toEqual({ type: 'started', admission: 'launch', sessionId: 's1', taskId: 't1' });
    expect(readClaudeProviderTaskActivity({
      type: 'system', subtype: 'task_progress', session_id: 's1', task_id: 't1',
    })).toEqual({ type: 'progress', sessionId: 's1', taskId: 't1' });
    for (const status of ['completed', 'failed', 'stopped']) {
      expect(readClaudeProviderTaskActivity({
        type: 'system', subtype: 'task_notification', session_id: 's1', task_id: 't1', status,
      })).toEqual({ type: 'terminal', terminalStatus: status, sessionId: 's1', taskId: 't1' });
    }
    for (const [status, terminalStatus] of [
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['killed', 'stopped'],
    ] as const) {
      expect(readClaudeProviderTaskActivity({
        type: 'system', subtype: 'task_updated', session_id: 's1', task_id: 't1', patch: { status },
      })).toEqual({ type: 'terminal', terminalStatus, sessionId: 's1', taskId: 't1' });
    }
  });

  it('admits only confirmed main-chain asynchronous Agent launches and exact SendMessage resumes', () => {
    expect(readClaudeProviderTaskActivity({
      hook_event_name: 'PostToolUse',
      session_id: ' s1 ',
      tool_name: 'Agent',
      tool_input: { description: 'defaults to background' },
      tool_response: { status: 'async_launched', agentId: ' local-1 ' },
    })).toEqual({
      type: 'started', admission: 'launch', sessionId: 's1', taskId: 'local-1',
    });
    expect(readClaudeProviderTaskActivity({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Agent',
      tool_input: { run_in_background: false },
      tool_response: { status: 'async_launched', isAsync: false, agentId: 'local-2' },
    })).toEqual({
      type: 'started', admission: 'launch', sessionId: 's1', taskId: 'local-2',
    });
    expect(readClaudeProviderTaskActivity({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Agent',
      tool_response: { status: 'remote_launched', taskId: 'remote-1' },
    })).toEqual({
      type: 'started', admission: 'launch', sessionId: 's1', taskId: 'remote-1',
    });
    expect(readClaudeProviderTaskActivity({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Workflow',
      tool_response: { status: 'async_launched', taskId: 'workflow-1', taskType: 'local_workflow' },
    })).toEqual({
      type: 'started', admission: 'launch', sessionId: 's1', taskId: 'workflow-1',
    });
    expect(readClaudeProviderTaskActivity({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'SendMessage',
      tool_response: { resumedAgentId: 'local-1' },
    })).toEqual({
      type: 'started', admission: 'resume', sessionId: 's1', taskId: 'local-1',
    });

    for (const row of [
      {
        hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent',
        tool_response: { status: 'async_launched', agentId: 'intent-only' },
      },
      {
        hook_event_name: 'PostToolUse', session_id: 's1', agent_id: 'sidechain', tool_name: 'Agent',
        tool_response: { status: 'async_launched', agentId: 'sidechain-launch' },
      },
      {
        hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Agent',
        tool_response: { status: 'completed', agentId: 'foreground' },
      },
      {
        hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'SendMessage',
        tool_response: { status: 'failed', resumedAgentId: 'failed-resume' },
      },
      {
        hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Workflow',
        tool_response: { status: 'async_launched', task_id: 'unproven-workflow-alias' },
      },
    ]) {
      expect(readClaudeProviderTaskActivity(row)).toBeNull();
    }
  });

  it('uses exact hook terminals and requires matching nested terminal TaskOutput evidence', () => {
    expect(readClaudeProviderTaskActivity({
      hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'agent-1',
    })).toEqual({ type: 'progress', sessionId: 's1', taskId: 'agent-1' });
    expect(readClaudeProviderTaskActivity({
      hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'agent-1',
    })).toEqual({ type: 'terminal', terminalStatus: 'stopped', sessionId: 's1', taskId: 'agent-1' });

    const taskOutput = (inputTaskId: string, nestedTaskId: string, status: string) => ({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'TaskOutput',
      tool_input: { task_id: inputTaskId, block: false },
      tool_response: {
        retrieval_status: 'success',
        task: { task_id: nestedTaskId, status },
      },
    });
    expect(readClaudeProviderTaskActivity(taskOutput('agent-1', 'agent-1', 'running'))).toBeNull();
    expect(readClaudeProviderTaskActivity(taskOutput('agent-1', 'sibling', 'completed'))).toBeNull();
    expect(readClaudeProviderTaskActivity({
      ...taskOutput('agent-1', 'agent-1', 'completed'),
      tool_response: {
        retrieval_status: 'timeout',
        task: { task_id: 'agent-1', status: 'completed' },
      },
    })).toBeNull();
    for (const status of ['completed', 'failed', 'stopped', 'killed']) {
      expect(readClaudeProviderTaskActivity(taskOutput('agent-1', 'agent-1', status))).toEqual({
        type: 'terminal',
        terminalStatus: status === 'killed' ? 'stopped' : status,
        sessionId: 's1',
        taskId: 'agent-1',
      });
    }

    expect(readClaudeProviderTaskActivity({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'TaskStop',
      tool_input: { task_id: 'agent-1' },
      tool_response: {
        task_id: 'agent-1',
        task_type: 'local_agent',
        message: 'Successfully stopped task: agent-1',
      },
    })).toBeNull();
    expect(readClaudeProviderTaskActivity({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'TaskStop',
      tool_input: { task_id: 'agent-1' },
      tool_response: { task_id: 'agent-1', status: 'stopped' },
    })).toEqual({
      type: 'terminal', terminalStatus: 'stopped', sessionId: 's1', taskId: 'agent-1',
    });
  });

  it('terminalizes only the exact admitted sidechain on StopFailure', () => {
    const ledger = createClaudeProviderActivityLedger();
    for (const taskId of ['failed-agent', 'sibling-agent']) {
      const launch = readClaudeProviderTaskActivity({
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: 'Agent',
        tool_response: { status: 'async_launched', agentId: taskId },
      });
      if (!launch) throw new Error('expected exact async Agent launch');
      expect(ledger.apply(launch)).toBe(true);
    }

    const stopFailure = readClaudeProviderTaskActivity({
      hook_event_name: 'StopFailure',
      session_id: 's1',
      agent_id: ' failed-agent ',
      error: 'authentication_failed',
    });
    expect(stopFailure).toEqual({
      type: 'terminal',
      terminalStatus: 'failed',
      sessionId: 's1',
      taskId: 'failed-agent',
    });
    if (!stopFailure) throw new Error('expected exact sidechain StopFailure');
    expect(ledger.apply(stopFailure)).toBe(true);
    expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });
    expect(ledger.getActiveProviderTasks()).toEqual([{
      sessionId: 's1',
      taskId: 'sibling-agent',
    }]);

    const siblingStopFailure = readClaudeProviderTaskActivity({
      hook_event_name: 'StopFailure',
      session_id: 's1',
      agent_id: 'sibling-agent',
      error: 'authentication_failed',
    });
    if (!siblingStopFailure) throw new Error('expected exact sibling StopFailure');
    expect(ledger.apply(siblingStopFailure)).toBe(true);
    expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });

    for (const malformed of [
      { hook_event_name: 'StopFailure', session_id: 's1', error: 'authentication_failed' },
      { hook_event_name: 'StopFailure', session_id: 's1', agent_id: '   ' },
      { hook_event_name: 'StopFailure', session_id: 's1', task_id: 'not-a-sidechain-identity' },
    ]) {
      expect(readClaudeProviderTaskActivity(malformed)).toBeNull();
    }
  });

  it('keeps local/remote Agent typed starts inert while retaining proven Workflow background starts', () => {
    for (const taskType of ['local_agent', 'remote_agent', 'subagent', 'unknown_kind']) {
      expect(readClaudeProviderTaskActivity({
        type: 'system', subtype: 'task_started', session_id: 's1', task_id: 'agent-1', task_type: taskType,
      })).toBeNull();
    }
    expect(readClaudeProviderTaskActivity({
      type: 'system', subtype: 'task_started', session_id: 's1', task_id: 'workflow-1', task_type: 'local_workflow',
    })).toEqual({ type: 'started', admission: 'launch', sessionId: 's1', taskId: 'workflow-1' });
    expect(readClaudeProviderTaskActivity({
      type: 'system', subtype: 'task_progress', session_id: 's1', task_id: 'agent-1', task_type: 'local_agent',
    })).toEqual({ type: 'progress', sessionId: 's1', taskId: 'agent-1' });
  });

  it('rejects transcript, tool-result, Stop, and broadened status aliases', () => {
    expect(readClaudeProviderTaskActivity({ type: 'user', toolUseResult: { backgroundTaskId: 't1' } })).toBeNull();
    expect(readClaudeProviderTaskActivity({ type: 'queue-operation', content: '<task-notification />' })).toBeNull();
    expect(readClaudeProviderTaskActivity({ hook_event_name: 'Stop', background_tasks: [] })).toBeNull();
    expect(readClaudeProviderTaskActivity({
      type: 'system', subtype: 'task_notification', session_id: 's1', task_id: 't1', status: 'succeeded',
    })).toBeNull();
    expect(readClaudeProviderTaskActivity({
      type: 'system', subtype: 'task_notification', session_id: 's1', task_id: 't1', status: 'killed',
    })).toBeNull();
    for (const status of ['pending', 'running', 'cancelled', 'succeeded']) {
      expect(readClaudeProviderTaskActivity({
        type: 'system', subtype: 'task_updated', session_id: 's1', task_id: 't1', patch: { status },
      })).toBeNull();
    }
    expect(readClaudeProviderTaskActivity({
      type: 'system', subtype: 'task_updated', session_id: 's1', task_id: 't1', patch: { status: 'stopped' },
    })).toBeNull();
    expect(readClaudeProviderTaskActivity({
      type: 'system',
      subtype: 'task_updated',
      session_id: 's1',
      task_id: 't1',
      status: 'completed',
    })).toBeNull();
  });
});

describe('createClaudeProviderActivityLedger', () => {
  it('starts idle and keeps unknown progress inert', () => {
    const snapshots: unknown[] = [];
    const ledger = createClaudeProviderActivityLedger({
      onSnapshotChanged: (snapshot) => snapshots.push(snapshot),
    });

    expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
    expect(ledger.apply({ type: 'progress', sessionId: 's1', taskId: 't1' })).toBe(false);
    expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
    expect(snapshots).toEqual([]);
  });

  it('consumes terminal-before-launch confirmation without public active and lets an exact resume re-admit', () => {
    const ledger = createClaudeProviderActivityLedger();

    expect(ledger.apply({ type: 'terminal', sessionId: 's1', taskId: 'agent-1' })).toBe(false);
    expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
    expect(ledger.apply({
      type: 'started', admission: 'launch', sessionId: 's1', taskId: 'agent-1',
    })).toBe(false);
    expect(ledger.apply({
      type: 'started', admission: 'launch', sessionId: 's1', taskId: 'agent-1',
    })).toBe(false);
    expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });

    expect(ledger.apply({
      type: 'started', admission: 'resume', sessionId: 's1', taskId: 'agent-1',
    })).toBe(true);
    expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });
  });

  it('keeps active-terminal suppression private until exact successful resume without affecting a sibling', () => {
    const ledger = createClaudeProviderActivityLedger();
    const readRequiredActivity = (row: unknown) => {
      const activity = readClaudeProviderTaskActivity(row);
      if (!activity) throw new Error('expected exact provider task activity');
      return activity;
    };
    const hookLaunch = {
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Agent',
      tool_response: { status: 'async_launched', agentId: 'same' },
    };

    expect(ledger.apply(readRequiredActivity(hookLaunch))).toBe(true);
    expect(ledger.apply({ type: 'started', admission: 'launch', sessionId: 's1', taskId: 'other' })).toBe(true);
    expect(ledger.apply({ type: 'started', admission: 'launch', sessionId: 's2', taskId: 'sibling' })).toBe(true);
    expect(ledger.apply(readRequiredActivity({
      type: 'system',
      subtype: 'task_notification',
      session_id: 's1',
      task_id: 'same',
      status: 'stopped',
    }))).toBe(true);
    expect(ledger.getActiveProviderTasks()).toEqual([
      { sessionId: 's1', taskId: 'other' },
      { sessionId: 's2', taskId: 'sibling' },
    ]);

    expect(ledger.apply(readRequiredActivity(hookLaunch))).toBe(false);
    expect(ledger.apply(readRequiredActivity({
      type: 'system',
      subtype: 'task_started',
      session_id: 's1',
      task_id: 'same',
      task_type: 'local_workflow',
    }))).toBe(false);
    expect(readClaudeProviderTaskActivity({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'SendMessage',
      tool_response: { status: 'failed', resumedAgentId: 'same' },
    })).toBeNull();
    expect(ledger.getActiveProviderTasks()).toEqual([
      { sessionId: 's1', taskId: 'other' },
      { sessionId: 's2', taskId: 'sibling' },
    ]);

    expect(ledger.apply(readRequiredActivity({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'SendMessage',
      tool_response: { resumedAgentId: 'same' },
    }))).toBe(true);
    expect(ledger.getActiveProviderTasks()).toEqual([
      { sessionId: 's1', taskId: 'same' },
      { sessionId: 's1', taskId: 'other' },
      { sessionId: 's2', taskId: 'sibling' },
    ]);
  });

  it('keeps known task truth after observation loss and becomes unknown when the last exact task ends', () => {
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 's1', taskId: 't1' });

    ledger.noteObservationLost();
    expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });

    ledger.apply({ type: 'terminal', sessionId: 's1', taskId: 't1' });
    expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });
  });

  it('becomes unknown when observation is lost without known task keys', () => {
    const ledger = createClaudeProviderActivityLedger();
    ledger.noteObservationLost();
    expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });
  });

  it('keys by session/task tuple and removes only the exact sibling', () => {
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 's1', taskId: 'same' });
    ledger.apply({ type: 'started', sessionId: 's2', taskId: 'same' });
    ledger.apply({ type: 'terminal', sessionId: 's1', taskId: 'same' });
    expect(ledger.getActiveProviderTasks()).toEqual([{ sessionId: 's2', taskId: 'same' }]);
  });

  it('deduplicates aliases and never expires silent affirmative truth', () => {
    vi.useFakeTimers();
    try {
      const ledger = createClaudeProviderActivityLedger();
      ledger.apply({ type: 'started', sessionId: 's1', taskId: 'workflow' });
      ledger.apply({ type: 'progress', sessionId: 's1', taskId: 'workflow' });
      vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
      expect(ledger.getActiveProviderTaskCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes update/notification terminal aliases idempotent in either order without clearing a sibling session', () => {
    const terminalRows = [
      {
        type: 'system',
        subtype: 'task_updated',
        session_id: 's1',
        task_id: 'same',
        patch: { status: 'killed' },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: 's1',
        task_id: 'same',
        status: 'stopped',
      },
    ];
    for (const rows of [terminalRows, [...terminalRows].reverse()]) {
      const ledger = createClaudeProviderActivityLedger();
      ledger.apply({ type: 'started', sessionId: 's1', taskId: 'same' });
      ledger.apply({ type: 'started', sessionId: 's2', taskId: 'same' });
      const [first, second] = rows.map(readClaudeProviderTaskActivity);
      if (!first || !second) throw new Error('expected exact terminal activity');

      expect(ledger.apply(first)).toBe(true);
      expect(ledger.apply(second)).toBe(false);
      expect(ledger.getActiveProviderTasks()).toEqual([{ sessionId: 's2', taskId: 'same' }]);
    }
  });
});

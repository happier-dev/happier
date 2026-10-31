import { describe, expect, it, vi } from 'vitest';
import {
  createClaudeProviderActivityLedger,
  isClaudeProviderActivityHookObservationLoss,
  readClaudeProviderTaskActivity,
} from './providerActivity.js';
import * as providerActivityModule from './providerActivity.js';

describe('Claude provider task lifecycle', () => {
  it('retires a complete query observation without inventing process exit or clearing other unknown evidence', () => {
    const ledger = createClaudeProviderActivityLedger();
    const query = {}, baseline = {};
    ledger.registerOwner(query);
    ledger.noteSourceBaselinePending(baseline);
    ledger.completeQueryObservation(query);
    ledger.noteObservationLost(query);
    expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });
    ledger.noteSourceBaselineComplete(baseline);
    expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
    // Completed observation does not release the query's physical shutdown obligation.
    expect(ledger.getRegisteredQueryOwners()).toContain(query);
    expect(ledger.apply({ type: 'started', admission: 'launch', sessionId: 's1', taskId: 'late' }, query)).toBe(false);
    ledger.noteProviderStopped(query);
    expect(ledger.getRegisteredQueryOwners()).not.toContain(query);

    const lost = {};
    ledger.registerOwner(lost);
    ledger.noteObservationLost(lost);
    ledger.completeQueryObservation(lost);
    expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });
  });

  it('retains unfinished background work when the foreground query completes', () => {
    const ledger = createClaudeProviderActivityLedger(), query = {};
    ledger.registerOwner(query);
    ledger.apply({ type: 'started', admission: 'launch', sessionId: 's1', taskId: 'child' }, query);
    ledger.completeQueryObservation(query);
    expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });
    ledger.noteObservationLost(query);
    ledger.completeQueryObservation(query);
    expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });
    expect(ledger.getActiveProviderTasks()).toEqual([{ sessionId: 's1', taskId: 'child' }]);
  });

  it('retains ambiguous startup membership as unobserved without downgrading fresh executions', () => {
    const ledger = createClaudeProviderActivityLedger();
    const ambiguous = { type: 'started' as const, admission: 'launch' as const,
      sessionId: 's1', taskId: 'ambiguous', confirmsActivity: false as const };
    ledger.apply(ambiguous);
    expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });
    expect(ledger.getActiveProviderTasks()).toEqual([{ sessionId: 's1', taskId: 'ambiguous' }]);
    ledger.apply({ type: 'started', admission: 'launch', sessionId: 's1', taskId: 'fresh' });
    expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });
    ledger.apply({ ...ambiguous, taskId: 'fresh' });
    expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });
    ledger.apply({ type: 'terminal', sessionId: 's1', taskId: 'ambiguous', terminalStatus: 'completed' });
    ledger.apply({ type: 'terminal', sessionId: 's1', taskId: 'fresh', terminalStatus: 'completed' });
    expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
  });

  it('distinguishes background membership from an identity remembered only by a terminal outcome', () => {
    const ledger = createClaudeProviderActivityLedger();
    const apply = (value: unknown) => { const activity = readClaudeProviderTaskActivity(value); if (activity) ledger.apply(activity); };
    const complete = (taskId: string) => apply({ type: 'attachment', sessionId: 's1', attachment: { type: 'task_status', taskId, taskType: 'local_agent', status: 'completed' } });
    const start = (agentId: string) => apply({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: agentId });
    complete('foreground'); start('foreground');
    expect(ledger.getActiveProviderTaskCount()).toBe(0);
    complete('fast-background');
    apply({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Agent', tool_response: { status: 'async_launched', agentId: 'fast-background' } });
    expect(ledger.getActiveProviderTaskCount()).toBe(0);
    start('fast-background');
    expect(ledger.getActiveProviderTaskCount()).toBe(1);
    complete('fast-background'); start('fast-background');
    expect(ledger.getActiveProviderTaskCount()).toBe(1);
    apply({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'SendMessage', tool_response: { success: true, resumedAgentId: 'foreground' } });
    expect(ledger.getActiveProviderTaskCount()).toBe(2);
  });

  it('rejects unmarked user and queue XML while retaining authoritative native terminal-before-launch ordering', () => {
    const content = '<task-notification><task-id>known</task-id><status>completed</status></task-notification>';
    const user = { type: 'user', sessionId: 's1', message: { content } };
    expect(readClaudeProviderTaskActivity(user)).toBeNull();
    expect(readClaudeProviderTaskActivity({ type: 'queue-operation', operation: 'enqueue', sessionId: 's1', content })).toBeNull();
    const terminal = readClaudeProviderTaskActivity({ ...user, origin: { kind: 'task-notification' } });
    expect(terminal?.type).toBe('terminal');
    const ledger = createClaudeProviderActivityLedger();
    if (terminal) ledger.apply(terminal);
    ledger.apply({ type: 'started', admission: 'launch', sessionId: 's1', taskId: 'known' });
    expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
  });

  it('rejects failed async hook acknowledgement while keeping the exact launch alias', () => {
    const hook = { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Agent',
      tool_use_id: 'launch', tool_response: { status: 'async_launched', agentId: 'native-a' } };
    expect(readClaudeProviderTaskActivity({ ...hook, tool_response: { ...hook.tool_response, success: false } })).toBeNull();
    expect(readClaudeProviderTaskActivity(hook)).toEqual({ type: 'started', admission: 'launch', sessionId: 's1', taskId: 'native-a' });
  });

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

  it('keeps vetoable stops active and re-admits only an already known SubagentStart', () => {
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 's1', taskId: 'a1' });
    const apply = (value: unknown) => { const activity = readClaudeProviderTaskActivity(value); if (activity) ledger.apply(activity); };
    apply({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1' });
    expect(ledger.getActiveProviderTaskCount()).toBe(1);
    ledger.apply({ type: 'terminal', sessionId: 's1', taskId: 'a1', terminalStatus: 'completed' });
    apply({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1' });
    apply({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'unknown' });
    expect(ledger.getActiveProviderTasks()).toEqual([{ sessionId: 's1', taskId: 'a1' }]);
  });

  it('reads native task-status and delivered terminal evidence while handback only reports progress', () => {
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 's1', taskId: 'a1' });
    const apply = (value: unknown) => { const activity = readClaudeProviderTaskActivity(value); if (activity) ledger.apply(activity); return activity; };
    expect(apply({ type: 'user', sessionId: 's1', origin: { kind: 'peer', from: 'a1', senderTaskId: 'a1', handback: true } })).toEqual({ type: 'progress', confirmsActivity: false, sessionId: 's1', taskId: 'a1' });
    expect(ledger.getActiveProviderTaskCount()).toBe(1);
    expect(apply({ type: 'attachment', sessionId: 's1', attachment: { type: 'task_status', taskId: 'a1', status: 'completed', taskType: 'local_agent' } })).toEqual({ type: 'terminal', sessionId: 's1', taskId: 'a1', terminalStatus: 'completed' });
    expect(ledger.getActiveProviderTaskCount()).toBe(0);
    ledger.apply({ type: 'started', admission: 'resume', sessionId: 's1', taskId: 'a1' });
    apply({ type: 'attachment', sessionId: 's1', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification><task-id>a1</task-id><status>completed</status></task-notification>' } });
    expect(ledger.getActiveProviderTaskCount()).toBe(0);
  });

  it('rejects bare queued XML for known and unknown tasks without poisoning future admission', () => {
    const ledger = createClaudeProviderActivityLedger();
    const xml = (operation: string, taskId: string) => ({ type: 'queue-operation', operation, sessionId: 's1',
      content: `<task-notification><task-id>${taskId}</task-id><status>completed</status></task-notification>` });
    ledger.apply({ type: 'started', sessionId: 's1', taskId: 'known' });
    const remove = readClaudeProviderTaskActivity(xml('remove', 'known'));
    if (remove) ledger.apply(remove);
    expect(ledger.getActiveProviderTaskCount()).toBe(1);
    const unknown = readClaudeProviderTaskActivity(xml('enqueue', 'future'));
    if (unknown) ledger.apply(unknown);
    ledger.apply({ type: 'started', sessionId: 's1', taskId: 'future' });
    expect(ledger.getActiveProviderTaskCount()).toBe(2);
    const known = readClaudeProviderTaskActivity(xml('enqueue', 'known'));
    expect(known).toBeNull();
    expect(ledger.getActiveProviderTaskCount()).toBe(2);
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
    // Claude minted the session id, so its bytes survive verbatim and stay
    // comparable to the live provider session; the task id is Happier's own
    // identifier and keeps its canonicalization.
    expect(readClaudeProviderTaskActivity({
      type: 'system', subtype: 'task_started', session_id: ' s1 ', task_id: ' t1 ',
      task_type: 'local_workflow',
    })).toEqual({ type: 'started', admission: 'launch', sessionId: ' s1 ', taskId: 't1' });
    expect(readClaudeProviderTaskActivity({
      type: 'system', subtype: 'task_progress', session_id: 's1', task_id: 't1',
    })).toEqual({ type: 'progress', sessionId: 's1', taskId: 't1', source: 'system-task-progress' });
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
      type: 'started', admission: 'launch', sessionId: ' s1 ', taskId: 'local-1',
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
    expect(readClaudeProviderTaskActivity({
      hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Workflow',
      tool_response: { status: 'async_launched', task_id: 'workflow-native-alias' },
    })).toEqual({ type: 'started', admission: 'launch', sessionId: 's1', taskId: 'workflow-native-alias' });

    for (const row of [
      {
        hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent',
        tool_response: { status: 'async_launched', agentId: 'intent-only' },
      },
      {
        hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Agent',
        tool_response: { status: 'completed', agentId: 'foreground' },
      },
      {
        hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'SendMessage',
        tool_response: { status: 'failed', resumedAgentId: 'failed-resume' },
      },
    ]) {
      expect(readClaudeProviderTaskActivity(row)).toBeNull();
    }
  });

  it('keeps stop candidates distinct from matching settled TaskOutput evidence', () => {
    expect(readClaudeProviderTaskActivity({
      hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'agent-1',
    })).toEqual({ type: 'started', admission: 'known-resume', sessionId: 's1', taskId: 'agent-1' });
    expect(readClaudeProviderTaskActivity({
      hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'agent-1',
    })).toEqual({ type: 'progress', sessionId: 's1', taskId: 'agent-1' });

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
    })).toEqual({ type: 'progress', sessionId: 's1', taskId: 'agent-1', source: 'system-task-progress' });
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
  it('preserves whole-provider stop through delayed observation loss and unscoped native facts', () => {
    const ledger = createClaudeProviderActivityLedger();
    const launch = { type: 'started' as const, admission: 'launch' as const, sessionId: 's1', taskId: 'child' };
    ledger.apply(launch);
    expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });
    ledger.noteProviderStopped();
    expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
    ledger.noteObservationLost();
    expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
    expect(ledger.apply({ ...launch, admission: 'known-resume' })).toBe(false);
    expect(ledger.apply({ ...launch, taskId: 'late-child' })).toBe(false);
    expect(ledger.getActiveProviderTasks()).toEqual([]);
    expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
    // A new native runtime owns a fresh ledger; late facts cannot restart the stopped runtime.
    const nextRuntime = createClaudeProviderActivityLedger();
    expect(nextRuntime.apply(launch)).toBe(true);
    expect(nextRuntime.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });
  });

  it.each(['transcript', 'hook', 'child-hook'] as const)(
    'settles only the explicitly cancelled resumed child through %s evidence',
    (surface) => {
      const ledger = createClaudeProviderActivityLedger();
      const apply = (row: unknown) => {
        const activity = readClaudeProviderTaskActivity(row);
        if (activity) ledger.apply(activity);
        return activity;
      };
      const response = {
        success: false,
        message: "Agent cancelled-child was stopped by the user and won't be resumed. Treat its work as cancelled; only launch a new agent if the user explicitly asks.",
      };
      apply({
        hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Agent',
        tool_response: { status: 'async_launched', agentId: 'cancelled-child' },
      });
      apply({ type: 'system', subtype: 'task_notification', session_id: 's1',
        task_id: 'cancelled-child', status: 'failed' });
      apply({ type: 'user', sessionId: 's1',
        toolUseResult: { success: true, resumedAgentId: 'cancelled-child' } });
      ledger.apply({ type: 'started', admission: 'launch', sessionId: 's1', taskId: 'sibling' });
      expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 2 });
      const stopped = surface === 'transcript'
        ? { type: 'user', sessionId: 's1', toolUseResult: response,
          message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'send-1', content: JSON.stringify(response) },
          ] } }
        : { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'SendMessage',
          tool_input: { to: 'cancelled-child', message: 'continue' }, tool_response: response,
          ...(surface === 'child-hook' ? { agent_id: 'sibling' } : {}) };
      expect(apply(stopped)).toEqual({
        type: 'terminal', terminalStatus: 'stopped', sessionId: 's1', taskId: 'cancelled-child',
      });
      expect(ledger.getActiveProviderTasks()).toEqual([{ sessionId: 's1', taskId: 'sibling' }]);
      apply({ type: 'system', subtype: 'task_notification', session_id: 's1',
        task_id: 'sibling', status: 'completed' });
      expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
    },
  );

  it('keeps copied cancellation text and unrelated SendMessage failures inert', () => {
    const response = { success: false,
      message: "Agent child was stopped by the user and won't be resumed." };
    for (const row of [
      { type: 'user', sessionId: 's1', message: { content: JSON.stringify(response) } },
      { type: 'user', sessionId: 's1', toolUseResult: response },
      { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash',
        tool_input: { to: 'child' }, tool_response: response },
      { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'SendMessage',
        tool_input: { to: 'other' }, tool_response: response },
      { type: 'user', sessionId: 's1', hook_event_name: 'PostToolUse', tool_name: 'SendMessage',
        tool_input: { to: 'other' }, tool_response: response, toolUseResult: response,
        message: { content: [{ type: 'tool_result', tool_use_id: 'send-1', content: JSON.stringify(response) }] } },
      { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'SendMessage',
        tool_input: { to: 'child' }, tool_response: { success: false, message: 'Request timed out' } },
    ]) expect(readClaudeProviderTaskActivity(row)).toBeNull();
  });

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

  it('projects observer loss as unknown while retaining exact task identities for reconciliation', () => {
    const snapshots: unknown[] = [];
    const ledger = createClaudeProviderActivityLedger({ onSnapshotChanged: (snapshot) => snapshots.push(snapshot) });
    ledger.apply({ type: 'started', sessionId: 's1', taskId: 't1' });
    ledger.apply({ type: 'started', sessionId: 's1', taskId: 't2' });

    ledger.noteObservationLost();
    expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });
    expect(snapshots.at(-1)).toEqual({ state: 'unknown', activeCount: 0 });
    expect(ledger.getActiveProviderTasks()).toEqual([
      { sessionId: 's1', taskId: 't1' }, { sessionId: 's1', taskId: 't2' },
    ]);

    const handback = readClaudeProviderTaskActivity({
      type: 'user', sessionId: 's1',
      origin: { kind: 'peer', from: 't1', senderTaskId: 't1', handback: true },
    });
    if (!handback) throw new Error('expected native handback report delivery');
    expect(ledger.apply(handback)).toBe(false);
    expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });

    // A live exact task observation establishes only that task, not the residue's sibling.
    expect(ledger.apply({ type: 'progress', sessionId: 's1', taskId: 'unknown' })).toBe(false);
    expect(ledger.apply({ type: 'progress', sessionId: 's1', taskId: 't1' })).toBe(true);
    expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });
    ledger.apply({ type: 'terminal', sessionId: 's1', taskId: 't1' });
    expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });

    // A duplicate launch confirmation is fresh exact evidence without reopening a terminal task.
    expect(ledger.apply({ type: 'started', sessionId: 's1', taskId: 't2' })).toBe(true);
    expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });
    ledger.apply({ type: 'terminal', sessionId: 's1', taskId: 't2' });
    expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });
    expect(ledger.apply({ type: 'progress', sessionId: 's1', taskId: 't2' })).toBe(false);
    expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });
  });

  it('becomes unknown when observation is lost without known task keys', () => {
    const ledger = createClaudeProviderActivityLedger();
    ledger.noteObservationLost();
    expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });
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
      const [first, second] = rows.map(row => readClaudeProviderTaskActivity(row));
      if (!first || !second) throw new Error('expected exact terminal activity');

      expect(ledger.apply(first)).toBe(true);
      expect(ledger.apply(second)).toBe(false);
      expect(ledger.getActiveProviderTasks()).toEqual([{ sessionId: 's2', taskId: 'same' }]);
    }
  });
  it.each(['terminal', 'progress', 'resume'] as const)(
    'requires physical owner evidence for an owned task %s', (evidence) => {
      const ledger = createClaudeProviderActivityLedger();
      const queryA = {};
      const queryB = {};
      const task = { sessionId: 'native-owner', taskId: 'same-task' };
      ledger.registerOwner(queryA);
      ledger.registerOwner(queryB);
      ledger.apply({ ...task, type: 'started', admission: 'launch' }, queryA);
      ledger.apply({ ...task, type: 'started', admission: 'resume' }, queryB);
      if (evidence === 'terminal') {
        expect(ledger.apply({ ...task, type: 'terminal', terminalStatus: 'completed' })).toBe(false);
        expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });
      } else if (evidence === 'progress') {
        ledger.noteObservationLost(queryB);
        expect(ledger.apply({ ...task, type: 'progress' })).toBe(false);
        expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });
      } else {
        ledger.noteProviderStopped(queryA);
        ledger.noteProviderStopped(queryB);
        expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
        expect(ledger.apply({ ...task, type: 'started', admission: 'known-resume' })).toBe(false);
        expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
        const queryC = {};
        ledger.registerOwner(queryC);
        expect(ledger.apply({ ...task, type: 'started', admission: 'resume' }, queryC)).toBe(true);
        expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });
      }
    },
  );

  it.each(['none', 'query', 'unowned', 'history'] as const)(
    'releases only the completed source-baseline observation (%s remains)', remaining => {
      const ledger = createClaudeProviderActivityLedger();
      const baseline = {};
      const query = {};
      ledger.noteSourceBaselinePending(baseline);
      if (remaining === 'query') {
        ledger.registerOwner(query);
        ledger.noteObservationLost(query);
      } else if (remaining === 'unowned') {
        ledger.apply({ type: 'started', sessionId: 'local-terminal', taskId: 'unowned' });
        ledger.noteObservationLost();
      } else if (remaining === 'history') {
        ledger.noteObservationLost();
      }
      expect(ledger.getSnapshot()).toEqual({ state: 'unknown', activeCount: 0 });
      ledger.noteSourceBaselineComplete(baseline);
      expect(ledger.getSnapshot()).toEqual({ state: remaining === 'none' ? 'idle' : 'unknown', activeCount: 0 });
      if (remaining === 'unowned') {
        expect(ledger.getActiveProviderTasks()).toEqual([{ sessionId: 'local-terminal', taskId: 'unowned' }]);
      }
    },
  );


  describe('Agents awaiting their own background children (Claude Code 2.1.302 rows)', () => {
    type Ledger = ReturnType<typeof createClaudeProviderActivityLedger>;
    const sdkRowApplier = (ledger: Ledger, ownerScope?: object) => (row: Record<string, unknown>) => {
      const activity = readClaudeProviderTaskActivity({ type: 'system', session_id: 's1', ...row });
      if (activity) ledger.apply(activity, ownerScope);
    };
    const startAgent = (apply: (row: Record<string, unknown>) => void, taskId: string, parent?: string) => apply({
      subtype: 'task_started', task_id: taskId, task_type: 'local_agent', is_backgrounded: true,
      ...(parent ? { owned_by_subagent: true, parent_task_id: parent } : {}),
    });
    const startShell = (apply: (row: Record<string, unknown>) => void, taskId: string, parent: string) => apply({
      subtype: 'task_started', task_id: taskId, task_type: 'local_bash', is_backgrounded: true,
      owned_by_subagent: true, parent_task_id: parent,
    });
    const stop = (apply: (row: Record<string, unknown>) => void, taskId: string) => {
      apply({ subtype: 'task_updated', task_id: taskId, patch: { status: 'completed' } });
      apply({ subtype: 'task_notification', task_id: taskId, status: 'completed' });
    };
    const isActive = (ledger: Ledger, taskId: string) => ledger.hasProviderTask({ sessionId: 's1', taskId });

    it('keeps an Agent that stopped with live children resumable only by its own typed progress', () => {
      const ledger = createClaudeProviderActivityLedger();
      const query = {};
      ledger.registerOwner(query);
      const apply = sdkRowApplier(ledger, query);
      startAgent(apply, 'agent-1');
      startShell(apply, 'bash-1', 'agent-1');
      expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 2 });

      stop(apply, 'agent-1');
      expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });
      const subagentStop = readClaudeProviderTaskActivity({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'agent-1' });
      expect(subagentStop).not.toBeNull();
      if (subagentStop) ledger.apply(subagentStop, query);
      expect(isActive(ledger, 'agent-1')).toBe(false);

      apply({ subtype: 'task_notification', task_id: 'bash-1', status: 'completed' });
      // Not counted, but the query must keep observing so the Agent's wake is read.
      expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
      expect(ledger.hasUnsettledProviderTasks(query)).toBe(true);
      ledger.completeQueryObservation(query);
      apply({ subtype: 'task_progress', task_id: 'agent-1' });
      expect(ledger.getSnapshot()).toEqual({ state: 'active', activeCount: 1 });

      stop(apply, 'agent-1');
      expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
      expect(ledger.hasUnsettledProviderTasks(query)).toBe(false);
      apply({ subtype: 'task_progress', task_id: 'agent-1' });
      expect(isActive(ledger, 'agent-1')).toBe(false);
    });

    it.each([
      ['failed', { subtype: 'task_notification', task_id: 'agent-1', status: 'failed' }],
      ['killed', { subtype: 'task_updated', task_id: 'agent-1', patch: { status: 'killed' } }],
    ])('does not let a %s Agent with live children wake or hold observation', (_status, terminalRow) => {
      const ledger = createClaudeProviderActivityLedger();
      const apply = sdkRowApplier(ledger);
      startAgent(apply, 'agent-1');
      startShell(apply, 'bash-1', 'agent-1');
      apply(terminalRow);
      apply({ subtype: 'task_notification', task_id: 'bash-1', status: 'completed' });
      expect(ledger.hasUnsettledProviderTasks()).toBe(false);
      apply({ subtype: 'task_progress', task_id: 'agent-1' });
      expect(isActive(ledger, 'agent-1')).toBe(false);
    });

    it.each([
      ['failed', { type: 'system', subtype: 'task_notification', task_id: 'agent-1', status: 'failed' }],
      ['killed', { type: 'system', subtype: 'task_updated', task_id: 'agent-1', patch: { status: 'killed' } }],
      ['TaskStop', {
        hook_event_name: 'PostToolUse', tool_name: 'TaskStop',
        tool_input: { task_id: 'agent-1' }, tool_response: { task_id: 'agent-1', status: 'stopped' },
      }],
      ['completed TaskStop', {
        hook_event_name: 'PostToolUse', tool_name: 'TaskStop',
        tool_input: { task_id: 'agent-1' }, tool_response: { task_id: 'agent-1', status: 'completed' },
      }],
      ['StopFailure', { hook_event_name: 'StopFailure', agent_id: 'agent-1' }],
    ])('settles an awaiting Agent after %s evidence', (_label, terminalRow) => {
      const ledger = createClaudeProviderActivityLedger();
      const query = {};
      ledger.registerOwner(query);
      const apply = sdkRowApplier(ledger, query);
      startAgent(apply, 'agent-1');
      startShell(apply, 'bash-1', 'agent-1');
      stop(apply, 'agent-1');
      const terminal = readClaudeProviderTaskActivity({ session_id: 's1', ...terminalRow });
      if (!terminal) throw new Error('expected terminal evidence');
      ledger.apply(terminal, query);
      apply({ subtype: 'task_notification', task_id: 'bash-1', status: 'completed' });
      expect(ledger.hasUnsettledProviderTasks(query)).toBe(false);
      apply({ subtype: 'task_progress', task_id: 'agent-1' });
      expect(isActive(ledger, 'agent-1')).toBe(false);
    });

    it.each(['typed', 'TaskOutput'])('preserves an Agent wake after %s completion and completed TaskOutput aliases', (firstCompletion) => {
      const ledger = createClaudeProviderActivityLedger();
      const query = {};
      ledger.registerOwner(query);
      const apply = sdkRowApplier(ledger, query);
      startAgent(apply, 'agent-1');
      startShell(apply, 'bash-1', 'agent-1');
      const output = readClaudeProviderTaskActivity({
        hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'TaskOutput',
        tool_input: { task_id: 'agent-1' },
        tool_response: { retrieval_status: 'success', task: { task_id: 'agent-1', status: 'completed' } },
      });
      if (!output) throw new Error('expected completed TaskOutput evidence');
      if (firstCompletion === 'TaskOutput') ledger.apply(output, query);
      else stop(apply, 'agent-1');
      ledger.apply(output, query);
      stop(apply, 'agent-1');
      apply({ subtype: 'task_notification', task_id: 'bash-1', status: 'completed' });
      apply({ subtype: 'task_progress', task_id: 'agent-1' });
      expect(isActive(ledger, 'agent-1')).toBe(true);
    });

    it('requires the awaiting Agent\'s query owner to settle or reactivate it', () => {
      const ledger = createClaudeProviderActivityLedger();
      const query = {};
      const otherQuery = {};
      ledger.registerOwner(query);
      ledger.registerOwner(otherQuery);
      const apply = sdkRowApplier(ledger, query);
      startAgent(apply, 'agent-1');
      startShell(apply, 'bash-1', 'agent-1');
      stop(apply, 'agent-1');
      ledger.apply({ type: 'terminal', terminalStatus: 'stopped', sessionId: 's1', taskId: 'agent-1' }, otherQuery);
      apply({ subtype: 'task_notification', task_id: 'bash-1', status: 'completed' });
      const progress = readClaudeProviderTaskActivity({
        type: 'system', subtype: 'task_progress', session_id: 's1', task_id: 'agent-1',
      });
      if (!progress) throw new Error('expected typed progress');
      ledger.apply(progress, otherQuery);
      expect(isActive(ledger, 'agent-1')).toBe(false);
      ledger.apply(progress, query);
      expect(isActive(ledger, 'agent-1')).toBe(true);
    });

    it('keeps an Agent resumable while a nested Agent it owns still waits on or resumes its own work', () => {
      const nested = () => {
        const ledger = createClaudeProviderActivityLedger();
        const apply = sdkRowApplier(ledger);
        startAgent(apply, 'agent-a');
        startAgent(apply, 'agent-b', 'agent-a');
        startShell(apply, 'bash-b', 'agent-b');
        return { ledger, apply };
      };

      const waiting = nested();
      stop(waiting.apply, 'agent-b');
      stop(waiting.apply, 'agent-a');
      waiting.apply({ subtype: 'task_notification', task_id: 'bash-b', status: 'completed' });
      waiting.apply({ subtype: 'task_progress', task_id: 'agent-b' });
      stop(waiting.apply, 'agent-b');
      waiting.apply({ subtype: 'task_progress', task_id: 'agent-a' });
      expect(isActive(waiting.ledger, 'agent-a')).toBe(true);

      const resumed = nested();
      stop(resumed.apply, 'agent-b');
      resumed.apply({ subtype: 'task_notification', task_id: 'bash-b', status: 'completed' });
      resumed.apply({ subtype: 'task_progress', task_id: 'agent-b' });
      stop(resumed.apply, 'agent-a');
      stop(resumed.apply, 'agent-b');
      resumed.apply({ subtype: 'task_progress', task_id: 'agent-a' });
      expect(isActive(resumed.ledger, 'agent-a')).toBe(true);
    });

    it('keeps the parent link when the typed child launch follows an earlier hook launch', () => {
      const ledger = createClaudeProviderActivityLedger();
      const apply = sdkRowApplier(ledger);
      startAgent(apply, 'agent-a');
      ledger.apply({ type: 'started', admission: 'launch', sessionId: 's1', taskId: 'agent-b' });
      startAgent(apply, 'agent-b', 'agent-a');
      apply({ subtype: 'task_notification', task_id: 'agent-a', status: 'completed' });
      apply({ subtype: 'task_notification', task_id: 'agent-b', status: 'completed' });
      apply({ subtype: 'task_progress', task_id: 'agent-a' });
      expect(isActive(ledger, 'agent-a')).toBe(true);
    });

    it('releases an awaiting Agent when its provider stops', () => {
      const ledger = createClaudeProviderActivityLedger();
      const query = {};
      ledger.registerOwner(query);
      const apply = sdkRowApplier(ledger, query);
      startAgent(apply, 'agent-1');
      startShell(apply, 'bash-1', 'agent-1');
      stop(apply, 'agent-1');
      ledger.noteProviderStopped(query);
      expect(ledger.hasUnsettledProviderTasks(query)).toBe(false);
      expect(ledger.getSnapshot()).toEqual({ state: 'idle', activeCount: 0 });
    });
  });
});

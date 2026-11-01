import { describe, expect, it, vi } from 'vitest';

import { createLocalTurnLifecycleController, type LocalTurnLifecycleSnapshot } from '@/agent/localControl/turnLifecycle';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { TurnStallNotice } from '@/agent/runtime/session/turn/stallWatch';
import { GENERIC_CONTINUATION_RESUME_PROMPT } from '@/daemon/connectedServices/continuation/continuationResumePrompt';
import type {
  SessionRuntimeActivityContribution,
  SessionRuntimeActivityContributionHandle,
} from '@/session/runtimeActivity/types';
import { createClaudeProviderActivityLedger } from '../providerActivity/createClaudeProviderActivityLedger';
import { createClaudeProviderRuntimeActivityAdapter } from '../providerActivity/createClaudeProviderRuntimeActivityAdapter';
import type { ClaudeWorkflowTaskReference } from '../workflows/claudeWorkflowTaskReference';
import type { RawJSONLines } from '../types';
import { createClaudeLocalLifecycleTracker } from './claudeLocalLifecycleTracker';

describe('createClaudeLocalLifecycleTracker', () => {
  it('uses live raw rows and main hooks for silence without counting presentation replay or foreign rows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const notices: TurnStallNotice[] = [];
    const turn = createSessionTurnLifecycle({
      sessionId: 'happier-session', enqueueSessionTurn: async () => {},
      turnStallWarnMs: 100, onTurnStallNotice: notice => notices.push(notice),
    });
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const tracker = createClaudeLocalLifecycleTracker({
      lifecycle, onProviderEvent: () => turn.observeProviderTurnEvent(),
      readProviderSessionId: () => 'native-main',
    });
    try {
      await turn.beginTurn({ provider: 'claude' });
      await vi.advanceTimersByTimeAsync(75);
      tracker.observeLiveProviderActivityRow({ type: 'attachment', sessionId: 'native-main' }, 'native-main');
      await vi.advanceTimersByTimeAsync(75);
      tracker.observeHook({ hook_event_name: 'PostToolUse', session_id: 'native-main', tool_name: 'Bash' });
      await vi.advanceTimersByTimeAsync(75);
      tracker.observeTranscript({ type: 'assistant', uuid: 'old', sessionId: 'native-main', message: { content: [] } });
      tracker.observeLiveProviderActivityRow({ type: 'attachment', sessionId: 'foreign' }, 'native-main');
      tracker.observeLiveProviderActivityRow({ type: 'attachment', sessionId: 'native-main', isReplay: true }, 'native-main');
      tracker.observeLiveProviderActivityRow({ type: 'attachment', sessionId: 'native-main', isSidechain: true }, 'native-main');
      tracker.observeLiveProviderActivityRow({ type: 'attachment', sessionId: 'native-main', parent_tool_use_id: 'child' }, 'native-main');
      tracker.observeHook({ hook_event_name: 'PostToolUse', session_id: 'native-main', agent_id: 'child', tool_name: 'Bash' });
      tracker.observeHook({ hook_event_name: 'PermissionRequestCompleted', session_id: 'native-main' });
      tracker.observeHook({ hook_event_name: 'PostToolUse', session_id: 'stale-native-session' });
      await vi.advanceTimersByTimeAsync(24);
      expect(notices).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(notices).toMatchObject([{ lastEventAgeMs: 100 }]);
      tracker.observeHook({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'native-next' });
      await vi.advanceTimersByTimeAsync(100);
      expect(notices).toHaveLength(2);
    } finally {
      await turn.completeTurn({ provider: 'claude' });
      lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it('retains task custody when only the local wrapper exit was observed', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const ledger = createClaudeProviderActivityLedger();
    const reports: SessionRuntimeActivityContribution[] = [];
    const adapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger,
      contributionHandle: { report: async value => { reports.push(value); },
        markUnknown: async () => { reports.push({ state: 'unknown', activeCount: 0 }); }, dispose: async () => {} } });
    await adapter.activateObservation('local-observer');
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle, providerActivityLedger: ledger, runtimeActivityAdapter: adapter });
    tracker.observeHook({ hook_event_name: 'PostToolUse', session_id: 'local-session', tool_name: 'Agent',
      tool_response: { status: 'async_launched', agentId: 'owned-task' } });
    await vi.waitFor(() => expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 }));
    tracker.observeProcessExit();
    await vi.waitFor(() => expect(reports.at(-1)).toEqual({ state: 'unknown', activeCount: 0 }));
    expect(ledger.hasActiveProviderTasks()).toBe(true);
    tracker.observeProcessExit({ providerStopped: true });
    await vi.waitFor(() => expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 }));
    expect(ledger.hasActiveProviderTasks()).toBe(false);
    lifecycle.dispose();
  });
  it('keeps presentation replay inert and uses only exact-session live JSONL for provider Activity', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const reports: SessionRuntimeActivityContribution[] = [];
    const handle = {
      report: vi.fn(async (contribution: SessionRuntimeActivityContribution) => { reports.push(contribution); }),
      markUnknown: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } satisfies SessionRuntimeActivityContributionHandle;
    const providerActivityLedger = createClaudeProviderActivityLedger();
    const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({
      contributionHandle: handle,
      providerActivityLedger,
    });
    await runtimeActivityAdapter.activateObservation('test-observer-installed');
    reports.splice(0);
    const tracker = createClaudeLocalLifecycleTracker({
      lifecycle,
      runtimeActivityAdapter,
      providerActivityLedger,
    });

    const started = {
      type: 'system',
      subtype: 'task_started',
      session_id: 'provider-session',
      task_id: 'agent_target',
      task_type: 'local_bash',
    } as unknown as RawJSONLines;
    tracker.observeTranscript(started);
    await Promise.resolve();
    expect(reports).toEqual([]);

    tracker.observeLiveProviderActivityRow(started, 'wrong-session');
    await Promise.resolve();
    expect(reports).toEqual([]);

    tracker.observeLiveProviderActivityRow(started, 'provider-session');
    await vi.waitFor(() => expect(reports).toEqual([{
      state: 'active',
      activeCount: 1,
    }]));

    tracker.observeLiveProviderActivityRow({
      type: 'queue-operation',
      operation: 'enqueue',
      content: '<task-notification><task-id>unknown-sibling</task-id></task-notification>',
    } as unknown as RawJSONLines, 'provider-session');
    expect(reports).toHaveLength(1);
    expect(handle.markUnknown).not.toHaveBeenCalled();

    tracker.observeLiveProviderActivityRow({
      type: 'user',
      origin: { kind: 'task-notification' },
      sessionId: 'provider-session',
      message: { content: [
        '<task-notification>',
        '<task-id>agent_target</task-id>',
        '<status>completed</status>',
        '</task-notification>',
      ].join('') },
    } as unknown as RawJSONLines, 'provider-session');
    await vi.waitFor(() => expect(reports).toHaveLength(2));
    expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
    expect(handle.markUnknown).not.toHaveBeenCalled();
    expect(providerActivityLedger.hasActiveProviderTasks()).toBe(false);

    tracker.observeProcessExit({ providerStopped: true });
    await Promise.resolve();
    expect(providerActivityLedger.hasActiveProviderTasks()).toBe(false);
    expect(reports).toHaveLength(2);
    expect(handle.markUnknown).not.toHaveBeenCalled();
    expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
    lifecycle.dispose();
  });

  it('keeps provider tasks through transcript observation loss and abandons them when the process exits', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const handle = {
      report: vi.fn(async () => {}),
      markUnknown: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } satisfies SessionRuntimeActivityContributionHandle;
    const providerActivityLedger = createClaudeProviderActivityLedger();
    const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({
      contributionHandle: handle,
      providerActivityLedger,
    });
    await runtimeActivityAdapter.activateObservation('test-observer-installed');
    const tracker = createClaudeLocalLifecycleTracker({
      lifecycle,
      runtimeActivityAdapter,
      providerActivityLedger,
    });
    tracker.observeLiveProviderActivityRow({
      type: 'system',
      subtype: 'task_started',
      session_id: 'provider-session',
      task_id: 'background-task',
      task_type: 'local_bash',
    } as unknown as RawJSONLines, 'provider-session');
    await vi.waitFor(() => expect(providerActivityLedger.hasActiveProviderTasks()).toBe(true));

    // Losing the transcript feed does not stop the Claude process, so its task may still run.
    tracker.handleProviderActivityObservationLoss('jsonl_observation_lost');
    await vi.waitFor(() => expect(handle.markUnknown).toHaveBeenCalledOnce());
    expect(providerActivityLedger.hasActiveProviderTasks()).toBe(true);

    tracker.observeProcessExit({ providerStopped: true });
    await vi.waitFor(() => expect(providerActivityLedger.hasActiveProviderTasks()).toBe(false));
    lifecycle.dispose();
  });

  it('routes authenticated Agent hook evidence through the one provider ledger', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const reports: SessionRuntimeActivityContribution[] = [];
    const providerActivityLedger = createClaudeProviderActivityLedger();
    const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({
      providerActivityLedger,
      contributionHandle: {
        report: vi.fn(async (value) => { reports.push(value); }),
        markUnknown: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      },
    });
    await runtimeActivityAdapter.activateObservation('test-observer-installed');
    reports.splice(0);
    const tracker = createClaudeLocalLifecycleTracker({
      lifecycle,
      runtimeActivityAdapter,
      providerActivityLedger,
    });

    tracker.observeHook({
      hook_event_name: 'PostToolUse',
      session_id: 'provider-session',
      tool_name: 'Agent',
      tool_response: { status: 'async_launched', agentId: 'agent-1' },
    });
    await vi.waitFor(() => expect(reports).toEqual([{ state: 'active', activeCount: 1 }]));

    tracker.observeHook({
      hook_event_name: 'PostToolUse',
      session_id: 'provider-session',
      tool_name: 'TaskOutput',
      tool_input: { task_id: 'agent-1' },
      tool_response: {
        retrieval_status: 'success',
        task: { task_id: 'agent-1', status: 'running' },
      },
    });
    await Promise.resolve();
    expect(reports).toHaveLength(1);

    tracker.observeHook({
      hook_event_name: 'SubagentStop',
      session_id: 'provider-session',
      agent_id: 'agent-1',
    });
    await Promise.resolve();
    expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
    tracker.observeLiveProviderActivityRow({
      type: 'user', origin: { kind: 'task-notification' }, sessionId: 'provider-session',
      message: { content: '<task-notification><task-id>agent-1</task-id><status>completed</status></task-notification>' },
    } as unknown as RawJSONLines, 'provider-session');
    await vi.waitFor(() => expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 }));
    lifecycle.dispose();
  });

  it('translates lifecycle hooks and transcript continuation into safe handoff timing', async () => {
    vi.useFakeTimers();
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 500 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const waiting = lifecycle.waitForSafeRemoteHandoff();

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'Stop', stop_hook_active: false });
    await vi.advanceTimersByTimeAsync(499);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    tracker.observeTranscript({
      type: 'user',
      uuid: 'feedback',
      isMeta: true,
      message: { content: [{ type: 'text', text: 'Stop hook feedback:\nContinue.' }] },
    } as any);
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(settled).toBe(false);

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'Stop', stop_hook_active: true });
    await vi.advanceTimersByTimeAsync(500);

    await expect(waiting).resolves.toMatchObject({ lastTerminalReason: 'completed' });
    lifecycle.dispose();
    vi.useRealTimers();
  });

  it('does not convert a meta continuation no-op transcript pair into a completed provider turn', () => {
    const observed: LocalTurnLifecycleSnapshot[] = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (snapshot) => {
        observed.push(snapshot);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'meta-continuation-prompt',
      isMeta: true,
      message: {
        role: 'user',
        content: GENERIC_CONTINUATION_RESUME_PROMPT,
      },
    } satisfies RawJSONLines);
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'synthetic-no-response',
      model: '<synthetic>',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'No response requested.' }],
      },
    } satisfies RawJSONLines);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: false,
      waitingForQuiescence: false,
    });
    expect(observed).toEqual([]);
    lifecycle.dispose();
  });

  it('treats StopFailure, transcript interruption, SessionEnd, and process exit as terminal boundaries', async () => {
    const failure = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const failureTracker = createClaudeLocalLifecycleTracker({ lifecycle: failure });
    failureTracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const failureWait = failure.waitForSafeRemoteHandoff();
    failureTracker.observeHook({ session_id: 'sid', hook_event_name: 'StopFailure' });
    await expect(failureWait).resolves.toMatchObject({ lastTerminalReason: 'failed' });
    failure.dispose();

    const interrupted = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const interruptedTracker = createClaudeLocalLifecycleTracker({ lifecycle: interrupted });
    interruptedTracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const interruptedWait = interrupted.waitForSafeRemoteHandoff();
    interruptedTracker.observeTranscript({
      type: 'user',
      uuid: 'interrupt',
      message: { content: '[Request interrupted by user]' },
    } as any);
    await expect(interruptedWait).resolves.toMatchObject({ lastTerminalReason: 'aborted' });
    interrupted.dispose();

    const ended = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const endedTracker = createClaudeLocalLifecycleTracker({ lifecycle: ended });
    endedTracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const endedWait = ended.waitForSafeRemoteHandoff();
    endedTracker.observeHook({ session_id: 'sid', hook_event_name: 'SessionEnd', reason: 'other' });
    await expect(endedWait).resolves.toMatchObject({ lastTerminalReason: 'session-ended' });
    ended.dispose();

    const exited = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const exitedTracker = createClaudeLocalLifecycleTracker({ lifecycle: exited });
    exitedTracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const exitedWait = exited.waitForSafeRemoteHandoff();
    exitedTracker.observeProcessExit();
    await expect(exitedWait).resolves.toMatchObject({ lastTerminalReason: 'process-exited' });
    exited.dispose();
  });

  it('preserves official and legacy StopFailure error discriminators on terminal lifecycle events', async () => {
    const observedDetails: Array<string | undefined> = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (_snapshot, event) => {
        if (event.type === 'turn_terminal') observedDetails.push(event.detail);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      error_type: 'legacy_should_not_win',
    } as any);
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'StopFailure',
      error_type: 'rate_limit',
    } as any);

    expect(observedDetails).toEqual(['rate_limit', 'rate_limit']);
    lifecycle.dispose();
  });

  it('completes the foreground turn while async Agent background tasks are still running', async () => {
    const observedSnapshots: LocalTurnLifecycleSnapshot[] = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (snapshot) => {
        observedSnapshots.push(snapshot);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-2',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_2' },
    } as any);

    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'yielded-while-agents-run',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Agents are running.' }] },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'agent-1-completed',
      origin: { kind: 'task-notification' },
      message: { content: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>' },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'agent-2-completed',
      origin: { kind: 'task-notification' },
      message: { content: '<task-notification><task-id>agent_2</task-id><status>completed</status></task-notification>' },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    expect(observedSnapshots.some((snapshot) => snapshot.terminal && snapshot.lastTerminalReason === 'completed')).toBe(true);
    lifecycle.dispose();
  });

  it('does not suppress a foreground completion candidate solely because detached provider tasks remain active', () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-detached-agent',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'foreground-answer-complete',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Foreground answer is ready.' }] },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('clears detached task notification activity without emitting a continuation turn', () => {
    const observedEvents: string[] = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (_snapshot, event) => {
        observedEvents.push(`${event.type}:${event.source}`);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-detached-agent',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);
    tracker.observeTranscript({
      type: 'user',
      uuid: 'agent-completed',
      origin: { kind: 'task-notification', taskId: 'agent_1', status: 'completed' },
      message: { content: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>' },
    } as any);
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'foreground-answer-complete',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Foreground answer is ready.' }] },
    } as any);

    expect(observedEvents).not.toContain('continuation_detected:claude_transcript_task_notification');
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('does not reopen a completed foreground turn for detached task notifications or generic lifecycle presence', () => {
    const observedEvents: string[] = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (_snapshot, event) => {
        observedEvents.push(`${event.type}:${event.source}`);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'Stop', background_tasks: [] });
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'late-agent-completed',
      origin: { kind: 'task-notification', taskId: 'agent_1', status: 'completed' },
      message: { content: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>' },
    } as any);
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'SessionStart' });
    tracker.observeProcessExit();

    expect(observedEvents).not.toContain('continuation_detected:claude_transcript_task_notification');
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('does not treat a hook-originated task notification as a new foreground prompt', () => {
    const observedEvents: string[] = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (_snapshot, event) => {
        observedEvents.push(`${event.type}:${event.source}`);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'Stop', background_tasks: [] });
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    observedEvents.length = 0;

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'UserPromptSubmit',
      prompt: [
        '<task-notification>',
        '<task-id>agent_1</task-id>',
        '<tool-use-id>toolu_1</tool-use-id>',
        '<status>completed</status>',
        '</task-notification>',
      ].join('\n'),
    });

    expect(observedEvents).toEqual([]);
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('opens exactly one foreground turn when Claude reacts to a live primary task notification', () => {
    const observedEvents: string[] = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (_snapshot, event) => {
        observedEvents.push(`${event.type}:${event.source}`);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'Stop', background_tasks: [] });
    observedEvents.length = 0;

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'notification-prompt',
      prompt: [
        '<task-notification>',
        '<task-id>agent_1</task-id>',
        '<tool-use-id>toolu_1</tool-use-id>',
        '<status>completed</status>',
        '</task-notification>',
      ].join('\n'),
    });
    expect(observedEvents).toEqual([]);

    tracker.observeTranscript({
      type: 'user',
      uuid: 'notification-row',
      promptId: 'notification-prompt',
      sessionId: 'sid',
      isSidechain: false,
      origin: { kind: 'task-notification' },
      message: {
        content: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>',
      },
    } as any);
    expect(observedEvents).toEqual([]);

    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'wrong-session-reaction',
      parentUuid: 'notification-row',
      session_id: 'other-session',
      isSidechain: false,
      message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'wrong-tool' }] },
    } as any);
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'replayed-reaction',
      parentUuid: 'notification-row',
      session_id: 'sid',
      isSidechain: false,
      isReplay: true,
      message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'replayed-tool' }] },
    } as any);
    expect(observedEvents).toEqual([]);

    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'reaction-row',
      parentUuid: 'notification-row',
      session_id: 'sid',
      isSidechain: false,
      message: {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }],
      },
    } as any);
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'PostToolUse',
      tool_use_id: 'toolu_2',
    });

    expect(observedEvents.filter((event) => event.startsWith('turn_started:'))).toEqual([
      'turn_started:claude_task_notification_reaction_assistant',
    ]);
    expect(lifecycle.snapshot()).toMatchObject({
      active: true,
      terminal: false,
    });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'Stop', background_tasks: [] });
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('keeps an active Claude turn running across provider auto compact boundaries', () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'system',
      uuid: 'auto-compact-boundary',
      subtype: 'compact_boundary',
      compactMetadata: { trigger: 'auto' },
      session_id: 'sid-after-compact',
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: true,
      terminal: false,
      waitingForQuiescence: false,
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'tool-result-after-auto-compact',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
      },
    } as any);
    expect(lifecycle.snapshot()).toMatchObject({
      active: true,
      terminal: false,
    });

    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'summary-complete',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done after compact.' }] },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('ignores sidechain-attributed hooks for the primary turn lifecycle', () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    // A subagent prompt does not start a primary turn.
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'UserPromptSubmit',
      agent_id: 'agent_sidechain_1',
      agent_type: 'general-purpose',
    });
    expect(lifecycle.snapshot()).toMatchObject({ active: false, terminal: false });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    expect(lifecycle.snapshot()).toMatchObject({ active: true, terminal: false });

    // Live incident 2026-06-12 (session cmq8171…): subagent auth StopFailures must not
    // fail the primary turn while the main agent keeps working.
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'StopFailure',
      agent_id: 'agent_sidechain_1',
      agent_type: 'general-purpose',
      error: 'authentication_failed',
    } as any);
    expect(lifecycle.snapshot()).toMatchObject({ active: true, terminal: false });

    // A subagent Stop does not complete the primary turn.
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      agent_id: 'agent_sidechain_1',
      background_tasks: [],
    });
    expect(lifecycle.snapshot()).toMatchObject({ active: true, terminal: false });

    // A subagent SessionEnd does not end the primary turn.
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'SessionEnd',
      agent_id: 'agent_sidechain_1',
      reason: 'other',
    });
    expect(lifecycle.snapshot()).toMatchObject({ active: true, terminal: false });

    // Main-agent terminal evidence still terminalizes (control).
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'StopFailure' });
    expect(lifecycle.snapshot()).toMatchObject({ terminal: true, lastTerminalReason: 'failed' });
    lifecycle.dispose();
  });

  it('ignores sidechain Stop while detached provider activity remains separate from foreground completion', () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      agent_id: 'agent_sidechain_1',
      background_tasks: [],
    });

    // The sidechain Stop is ignored, and the detached agent ledger must not
    // suppress the foreground completion once the primary assistant result lands.
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'yielded-while-agents-run',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Agent is running.' }] },
    } as any);
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      background_tasks: [],
    });
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('treats Stop with no background tasks as completion after async Agent launches', async () => {
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      background_tasks: [],
    });

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });
});

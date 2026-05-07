import { describe, expect, it, vi } from 'vitest';

import { createLocalTurnLifecycleController } from '@/agent/localControl/turnLifecycle';
import { createClaudeLocalLifecycleTracker } from './claudeLocalLifecycleTracker';

describe('createClaudeLocalLifecycleTracker', () => {
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
});

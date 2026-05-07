import type {
  LocalTurnLifecycleController,
  LocalTurnLifecycleEvent,
} from '@/agent/localControl/turnLifecycle';
import type { RawJSONLines } from '@/backends/claude/types';
import type { SessionHookData } from '../utils/startHookServer';
import { readClaudeTranscriptTurnSignal } from './readClaudeTranscriptTurnSignal';

function readHookEventName(data: SessionHookData): string {
  const raw = data.hook_event_name ?? data.hookEventName;
  return typeof raw === 'string' ? raw : '';
}

function hookToLifecycleEvent(data: SessionHookData): LocalTurnLifecycleEvent | null {
  const hookEventName = readHookEventName(data);
  if (hookEventName === 'UserPromptSubmit') {
    return { type: 'turn_started', providerTurnId: null, source: 'claude_hook_user_prompt_submit' };
  }
  if (hookEventName === 'Stop') {
    return { type: 'completion_candidate', providerTurnId: null, source: 'claude_hook_stop' };
  }
  if (hookEventName === 'StopFailure') {
    return {
      type: 'turn_terminal',
      providerTurnId: null,
      reason: 'failed',
      source: 'claude_hook_stop_failure',
    };
  }
  if (hookEventName === 'SessionEnd') {
    return { type: 'session_ended', source: 'claude_hook_session_end' };
  }
  return null;
}

export function createClaudeLocalLifecycleTracker(opts: Readonly<{
  lifecycle: LocalTurnLifecycleController;
}>) {
  const observe = (event: LocalTurnLifecycleEvent | null): void => {
    if (!event) return;
    opts.lifecycle.observe(event);
  };

  return {
    observeHook(data: SessionHookData): void {
      observe(hookToLifecycleEvent(data));
    },
    observeTranscript(message: RawJSONLines): void {
      observe(readClaudeTranscriptTurnSignal(message));
    },
    observeProcessExit(): void {
      const snapshot = opts.lifecycle.snapshot();
      if (!snapshot.active || snapshot.terminal) return;
      opts.lifecycle.observe({
        type: 'turn_terminal',
        providerTurnId: snapshot.providerTurnId,
        reason: 'process-exited',
        source: 'claude_local_process_exit',
      });
    },
  };
}

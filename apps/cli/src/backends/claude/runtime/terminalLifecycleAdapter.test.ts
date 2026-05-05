import { describe, expect, it } from 'vitest';

import {
  mapClaudeHookEventToTerminalLifecycleObservation,
  mapClaudeTranscriptEventToTerminalLifecycleObservation,
} from './terminalLifecycleAdapter';

describe('Claude terminal lifecycle adapter', () => {
  it('treats Stop hooks as completion candidates only', () => {
    expect(mapClaudeHookEventToTerminalLifecycleObservation({
      agentId: 'claude',
      eventName: 'Stop',
      turnId: 'claude-turn',
    })).toEqual({
      type: 'completion_candidate',
      agentId: 'claude',
      turnId: 'claude-turn',
      source: 'hook',
    });
  });

  it('maps StopFailure hooks to failed terminal boundaries', () => {
    expect(mapClaudeHookEventToTerminalLifecycleObservation({
      agentId: 'claude',
      eventName: 'StopFailure',
      turnId: 'claude-turn',
      detail: 'hook failed',
    })).toEqual({
      type: 'turn_failed',
      agentId: 'claude',
      turnId: 'claude-turn',
      reason: 'stop_failure_hook',
      detail: 'hook failed',
      source: 'hook',
    });
  });

  it('invalidates Claude completion candidates when stop-hook feedback continues the turn', () => {
    expect(mapClaudeTranscriptEventToTerminalLifecycleObservation({
      agentId: 'claude',
      kind: 'stop_hook_feedback',
      turnId: 'claude-turn',
    })).toEqual({
      type: 'completion_candidate_invalidated',
      agentId: 'claude',
      turnId: 'claude-turn',
      reason: 'stop_hook_feedback',
    });
  });

  it('maps interrupted transcript rows to user interrupts', () => {
    expect(mapClaudeTranscriptEventToTerminalLifecycleObservation({
      agentId: 'claude',
      kind: 'text',
      text: '[Request interrupted by user]',
      turnId: 'claude-turn',
    })).toEqual({
      type: 'turn_aborted',
      agentId: 'claude',
      turnId: 'claude-turn',
      reason: 'user_interrupt',
      detail: '[Request interrupted by user]',
      source: 'transcript',
    });
  });
});

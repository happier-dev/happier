import { describe, expect, it } from 'vitest';

import { mapRuntimeMessageToTerminalLifecycleObservation } from './runtimeMessageObservationAdapter';

describe('mapRuntimeMessageToTerminalLifecycleObservation', () => {
  it('maps task_started to a normalized prompt-submitted observation', () => {
    expect(mapRuntimeMessageToTerminalLifecycleObservation({
      agentId: 'codex',
      message: { type: 'task_started', id: 'turn-1' },
    })).toEqual({
      type: 'prompt_submitted',
      agentId: 'codex',
      turnId: 'turn-1',
      source: 'lifecycle_event',
    });
  });

  it('maps task_complete to a normalized completed observation', () => {
    expect(mapRuntimeMessageToTerminalLifecycleObservation({
      agentId: 'claude',
      message: { type: 'task_complete', id: 'turn-2' },
    })).toEqual({
      type: 'turn_completed',
      agentId: 'claude',
      turnId: 'turn-2',
      source: 'lifecycle_event',
    });
  });

  it('maps interrupted turn_aborted messages to user interrupts', () => {
    expect(mapRuntimeMessageToTerminalLifecycleObservation({
      agentId: 'codex',
      message: { type: 'turn_aborted', id: 'turn-3', reason: 'interrupted' },
    })).toEqual({
      type: 'turn_aborted',
      agentId: 'codex',
      turnId: 'turn-3',
      reason: 'user_interrupt',
      detail: 'interrupted',
      source: 'lifecycle_event',
    });
  });

  it('ignores non-lifecycle runtime messages', () => {
    expect(mapRuntimeMessageToTerminalLifecycleObservation({
      agentId: 'codex',
      message: { type: 'agent_message', message: 'hello' },
    })).toBeNull();
  });
});

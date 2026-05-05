import { describe, expect, it } from 'vitest';

import { mapCodexRuntimeMessageToTerminalLifecycleObservation } from './terminalLifecycleAdapter';

describe('mapCodexRuntimeMessageToTerminalLifecycleObservation', () => {
  it('uses Codex rollout task completion as the terminal finalizer', () => {
    expect(mapCodexRuntimeMessageToTerminalLifecycleObservation({
      agentId: 'codex',
      message: { type: 'task_complete', id: 'codex-turn' },
    })).toEqual({
      type: 'turn_completed',
      agentId: 'codex',
      turnId: 'codex-turn',
      source: 'lifecycle_event',
    });
  });

  it('maps Codex abort lifecycle messages without provider identity fields', () => {
    expect(mapCodexRuntimeMessageToTerminalLifecycleObservation({
      agentId: 'codex',
      message: { type: 'turn_aborted', id: 'codex-turn', detail: 'interrupted' },
    })).toEqual({
      type: 'turn_aborted',
      agentId: 'codex',
      turnId: 'codex-turn',
      reason: 'user_interrupt',
      detail: 'interrupted',
      source: 'lifecycle_event',
    });
  });
});

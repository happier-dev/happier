import { describe, expect, it } from 'vitest';

import {
  createOpenCodeForegroundToolTracker,
  type OpenCodeToolPart,
} from './createOpenCodeForegroundToolTracker.js';

function runningToolPart(callId: string, sessionId = 'ses-1'): OpenCodeToolPart {
  return {
    sessionID: sessionId,
    callID: callId,
    tool: 'bash',
    messageID: `msg-${callId}`,
    state: { status: 'running' },
  };
}

describe('createOpenCodeForegroundToolTracker generation awareness', () => {
  it('stamps live observations with the current generation key', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    tracker.setObservedGenerationKey('gen-A');
    tracker.observeToolPart({ part: runningToolPart('call-1'), source: 'live' });

    const state = tracker.getProviderWorkState();
    expect(state.active).toBe(true);
    if (state.active) {
      expect(state.activeToolCalls[0]?.observedGenerationKey).toBe('gen-A');
    }
  });

  it('treats current-generation work as live and orphaned work as not live', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    tracker.setObservedGenerationKey('gen-A');
    tracker.observeToolPart({ part: runningToolPart('call-1'), source: 'live' });

    // Same generation: live.
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-A')).toBe(true);
    // A different (replaced) generation orphans the gen-A work.
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-B')).toBe(false);
    // hasActiveProviderWork is generation-agnostic (still reports presence).
    expect(tracker.hasActiveProviderWork()).toBe(true);
  });

  it('counts un-stamped work (observed before any generation) as live to avoid false orphaning', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    // No setObservedGenerationKey: the record carries no generation stamp.
    tracker.observeToolPart({ part: runningToolPart('call-1'), source: 'live' });

    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-A')).toBe(true);
  });

  it('clearActiveWork without a generation drops all work', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    tracker.setObservedGenerationKey('gen-A');
    tracker.observeToolPart({ part: runningToolPart('call-1'), source: 'live' });
    tracker.observeToolPart({ part: runningToolPart('call-2'), source: 'live' });

    const cleared = tracker.clearActiveWork({ reason: 'managed_server_generation_replaced' });
    expect(cleared.active).toBe(true);
    if (cleared.active) expect(cleared.activeToolCallCount).toBe(2);
    expect(tracker.hasActiveProviderWork()).toBe(false);
  });

  it('clearActiveWork with a generation keeps current-generation work and drops orphaned work', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    tracker.setObservedGenerationKey('gen-A');
    tracker.observeToolPart({ part: runningToolPart('orphan'), source: 'live' });
    // Advance the generation, then observe new current-generation work.
    tracker.setObservedGenerationKey('gen-B');
    tracker.observeToolPart({ part: runningToolPart('current'), source: 'live' });

    const cleared = tracker.clearActiveWork({
      reason: 'managed_server_generation_replaced',
      generationKey: 'gen-B',
    });
    // Only the gen-A orphan is cleared.
    expect(cleared.active).toBe(true);
    if (cleared.active) {
      expect(cleared.activeToolCallCount).toBe(1);
      expect(cleared.activeToolCalls[0]?.callId).toBe('orphan');
    }
    // gen-B work survives.
    expect(tracker.hasActiveProviderWork()).toBe(true);
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-B')).toBe(true);
  });

  it('re-stamps surviving work to a new generation when re-observed', () => {
    const tracker = createOpenCodeForegroundToolTracker();
    tracker.setObservedGenerationKey('gen-A');
    tracker.observeToolPart({ part: runningToolPart('call-1'), source: 'live' });
    // Generation advances; the same call is re-observed (survived the replacement).
    tracker.setObservedGenerationKey('gen-B');
    tracker.observeToolPart({ part: runningToolPart('call-1'), source: 'live' });

    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-B')).toBe(true);
    expect(tracker.hasActiveProviderWorkNotOrphanedByGeneration('gen-A')).toBe(false);
  });
});

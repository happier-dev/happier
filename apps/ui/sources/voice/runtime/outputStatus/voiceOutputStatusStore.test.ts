import { describe, expect, it, vi } from 'vitest';

import { createVoiceOutputStatusStore } from './voiceOutputStatusStore';

describe('voice output status store', () => {
  it('projects display-only status and clears it only for the matching terminal turn', () => {
    const store = createVoiceOutputStatusStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.show({ sessionId: 'session-1', turnId: 'turn-1', statusId: 'status-1', text: 'Checking' });
    expect(store.getSnapshot()).toEqual({
      scope: 'turn',
      sessionId: 'session-1',
      turnId: 'turn-1',
      statusId: 'status-1',
      text: 'Checking',
    });
    store.clear({ sessionId: 'session-1', turnId: 'turn-other' });
    expect(store.getSnapshot()?.text).toBe('Checking');
    store.clear({ sessionId: 'session-1', turnId: 'turn-1' });
    expect(store.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not leak a status across sessions', () => {
    const store = createVoiceOutputStatusStore();
    store.show({ sessionId: 'session-1', turnId: 'turn-1', statusId: 'status-1', text: 'Private status' });
    expect(store.readForSession('session-2')).toBeNull();
    expect(store.readForSession('session-1')?.text).toBe('Private status');
  });

  it('owns attempt-scoped display status without inventing a turn id', () => {
    const store = createVoiceOutputStatusStore();
    store.showAttempt({
      sessionId: 'session-1',
      attemptId: 12,
      statusId: 'codex_v3_conversational_transcript_unavailable',
      text: 'Conversational transcript unavailable',
    });

    expect(store.getSnapshot()).toEqual({
      scope: 'attempt',
      sessionId: 'session-1',
      attemptId: 12,
      statusId: 'codex_v3_conversational_transcript_unavailable',
      text: 'Conversational transcript unavailable',
    });
    expect(store.getSnapshot()).not.toHaveProperty('turnId');

    store.clear({ sessionId: 'session-1', turnId: '12' });
    expect(store.getSnapshot()).not.toBeNull();
    store.clearAttemptForSession('session-1');
    expect(store.getSnapshot()).toBeNull();
  });
});

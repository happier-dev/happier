import { describe, expect, it, vi } from 'vitest';

describe('voiceSessionStore subscriptions', () => {
  it('does not notify external-store subscribers when setVoiceSessionSnapshot receives an identical snapshot', async () => {
    vi.resetModules();

    const { setVoiceSessionSnapshot, subscribeToVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const snap = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected' as const,
      mode: 'idle' as const,
      canStop: true,
    };

    setVoiceSessionSnapshot(snap);
    const listener = vi.fn();
    const unsubscribe = subscribeToVoiceSessionSnapshot(listener);

    try {
      setVoiceSessionSnapshot({ ...snap });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

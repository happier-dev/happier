import { describe, expect, it, vi } from 'vitest';

type LocalVoiceState = Readonly<{ status: string; sessionId: string | null; error: unknown }>;

const toggleLocalVoiceTurn = vi.fn(async () => {});
const stopLocalVoiceSession = vi.fn(async () => {});
const getLocalVoiceState = vi.fn<() => LocalVoiceState>(() => ({ status: 'idle', sessionId: null, error: null }));

vi.mock('@/voice/local/localVoiceEngine', () => ({
  toggleLocalVoiceTurn,
  stopLocalVoiceSession,
  getLocalVoiceState,
}));

describe('local direct voice adapter', () => {
  it('maps idle+sessionId to connected so the status bar can remain stoppable', async () => {
    getLocalVoiceState.mockReturnValueOnce({ status: 'idle', sessionId: 's1', error: null });
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    expect(adapter.getSnapshot()).toEqual({
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });
  });

  it('delegates toggle to local voice engine', async () => {
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });
    expect(toggleLocalVoiceTurn).toHaveBeenCalledWith('s1');
  });

  it('stop stops the local voice session', async () => {
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    await adapter.stop({ sessionId: 's1' });
    expect(stopLocalVoiceSession).toHaveBeenCalledTimes(1);
  });
});

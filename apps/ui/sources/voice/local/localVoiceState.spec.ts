import { describe, expect, it, vi } from 'vitest';

describe('localVoiceState', () => {
  it('treats padded session ids as the same recording session when idling unless recording', async () => {
    vi.resetModules();
    const { getLocalVoiceState, patchLocalVoiceState, setIdleStateUnlessRecording } = await import('./localVoiceState');

    patchLocalVoiceState({ status: 'recording', sessionId: 'session-1', error: null });
    setIdleStateUnlessRecording(' session-1 ');

    expect(getLocalVoiceState()).toMatchObject({ status: 'recording', sessionId: 'session-1', error: null });
  });
});

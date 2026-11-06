import { describe, expect, it } from 'vitest';
import { createSpokenActionConfirmation } from './spokenActionConfirmation';

const actionId = 'notifications.webhooks.remove' as const;
const operation = (channelId: string, actionRequestId = 'remove-webhook') => ({
  actionId, actionRequestId,
  normalizedInput: { channelId },
  summary: `Remove notification webhook ${channelId}.`,
});

describe('live carrier spoken Action read-back binding', () => {
  it('admits the exact operation only after its captured speech drain, once', () => {
    const carrier = createSpokenActionConfirmation();
    const request = operation('channel-one');
    carrier.prepare(request);
    const speech = carrier.readPending();
    expect(carrier.completeReadBack(speech)).toBe(true);
    expect(carrier.completeReadBack(speech)).toBe(false);
    expect(carrier.readPending()).toBeNull();
  });

  it('replaces a changed operation and never lets an older speech drain confirm its replacement', () => {
    const carrier = createSpokenActionConfirmation();
    const first = operation('channel-one');
    carrier.prepare(first);
    const oldSpeech = carrier.readPending();
    const second = operation('channel-two', 'remove-other-webhook');
    carrier.prepare(second);
    expect(carrier.completeReadBack(oldSpeech)).toBe(false);
    expect(carrier.readPending()?.operation).toEqual(second);
    expect(carrier.completeReadBack(carrier.readPending())).toBe(true);
  });

  it('discards pending playback at call end', () => {
    const carrier = createSpokenActionConfirmation();
    const request = operation('channel-one');
    carrier.prepare(request);
    const speech = carrier.readPending();
    carrier.clear();
    expect(carrier.completeReadBack(speech)).toBe(false);
    expect(carrier.readPending()).toBeNull();
  });

  it('retires the one binding with the actual call lifetime without publishing speech progress to React', async () => {
    const { setVoiceSessionSnapshot, resetVoiceSessionStoreForTests, getVoiceSessionSpokenActionConfirmation,
      useVoiceSessionStore } = await import('@/voice/session/voiceSessionStore');
    resetVoiceSessionStoreForTests();
    try {
      setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'person-call',
        status: 'connected', mode: 'listening', canStop: true });
      const carrier = getVoiceSessionSpokenActionConfirmation();
      expect(carrier).not.toBeNull();
      if (!carrier) throw new Error('Missing live call');
      let publications = 0;
      const unsubscribe = useVoiceSessionStore.subscribe(() => { publications++; });
      try {
        carrier.prepare(operation('channel-one'));
        carrier.completeReadBack(carrier.readPending());
        expect(publications).toBe(0);
      } finally { unsubscribe(); }
      setVoiceSessionSnapshot({ adapterId: null, sessionId: null,
        status: 'disconnected', mode: 'idle', canStop: false });
      expect(carrier.readPending()).toBeNull();
      expect(getVoiceSessionSpokenActionConfirmation()).toBeNull();
      setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'person-call',
        status: 'connected', mode: 'listening', canStop: true });
      expect(getVoiceSessionSpokenActionConfirmation()).not.toBe(carrier);
      expect(getVoiceSessionSpokenActionConfirmation()?.readPending()).toBeNull();
    } finally { resetVoiceSessionStoreForTests(); }
  });
});

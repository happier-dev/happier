import { describe, expect, it } from 'vitest';
import { createSpokenActionConfirmation } from './spokenActionConfirmation';
import {
  setVoiceSessionSnapshot,
  resetVoiceSessionStoreForTests,
  getVoiceSessionSpokenActionConfirmation,
  useVoiceSessionStore,
} from '@/voice/session/voiceSessionStore';

describe('live carrier spoken Action read-back binding', () => {
  it('admits the exact operation only after its captured speech drain, once', () => {
    const carrier = createSpokenActionConfirmation();
    carrier.prepare();
    const speech = carrier.readPending();
    expect(carrier.completeReadBack(speech)).toBe(true);
    expect(carrier.completeReadBack(speech)).toBe(false);
    expect(carrier.readPending()).toBeNull();
  });

  it('replaces a changed operation and never lets an older speech drain confirm its replacement', () => {
    const carrier = createSpokenActionConfirmation();
    carrier.prepare();
    const oldSpeech = carrier.readPending();
    carrier.prepare();
    expect(carrier.completeReadBack(oldSpeech)).toBe(false);
    expect(carrier.readPending()).not.toBe(oldSpeech);
    expect(carrier.completeReadBack(carrier.readPending())).toBe(true);
  });

  it('discards pending playback at call end', () => {
    const carrier = createSpokenActionConfirmation();
    carrier.prepare();
    const speech = carrier.readPending();
    carrier.clear();
    expect(carrier.completeReadBack(speech)).toBe(false);
    expect(carrier.readPending()).toBeNull();
  });

  it('retires the one binding with the actual call lifetime without publishing speech progress to React', () => {
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
        carrier.prepare();
        carrier.completeReadBack(carrier.readPending());
        expect(publications).toBe(0);
      } finally { unsubscribe(); }
      carrier.prepare();
      const endingSpeech = carrier.readPending();
      expect(endingSpeech).not.toBeNull();
      setVoiceSessionSnapshot({ adapterId: null, sessionId: null,
        status: 'disconnected', mode: 'idle', canStop: false });
      expect(carrier.readPending()).toBeNull();
      expect(carrier.completeReadBack(endingSpeech)).toBe(false);
      expect(getVoiceSessionSpokenActionConfirmation()).toBeNull();
      setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'person-call',
        status: 'connected', mode: 'listening', canStop: true });
      expect(getVoiceSessionSpokenActionConfirmation()).not.toBe(carrier);
      expect(getVoiceSessionSpokenActionConfirmation()?.readPending()).toBeNull();
    } finally { resetVoiceSessionStoreForTests(); }
  });
});

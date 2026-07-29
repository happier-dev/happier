import { describe, expect, it } from 'vitest';

import { resolveVoiceBrowserTranscriptExpectation } from './voiceBrowserTranscriptExpectation';

describe('resolveVoiceBrowserTranscriptExpectation', () => {
  it('uses manifest signals for a known fixture and accepts one robust model term', () => {
    const expectation = resolveVoiceBrowserTranscriptExpectation({
      fixturePath: '/fixtures/long.wav',
      metadata: { expectedTranscriptSubstrings: ['summarize', 'failing checks', 'confirmation'] },
      explicitSignal: null,
    });

    expect(expectation.matches('I will wait for CONFIRMATION.')).toBe(true);
    expect(expectation.matches('unrelated generated words')).toBe(false);
  });

  it('requires an explicit signal for an unknown custom fixture', () => {
    expect(() => resolveVoiceBrowserTranscriptExpectation({
      fixturePath: '/custom/voice.wav',
      metadata: null,
      explicitSignal: null,
    })).toThrow('HAPPIER_E2E_VOICE_EXPECTED_TRANSCRIPT_SIGNAL');

    const expectation = resolveVoiceBrowserTranscriptExpectation({
      fixturePath: '/custom/voice.wav',
      metadata: null,
      explicitSignal: 'custom phrase',
    });
    expect(expectation.matches('A CUSTOM phrase was projected.')).toBe(true);
    expect(expectation.matches('different text')).toBe(false);
  });
});

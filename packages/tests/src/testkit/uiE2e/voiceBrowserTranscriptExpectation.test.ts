import { describe, expect, it } from 'vitest';

import {
  resolveVoiceBrowserFixtureRun,
  resolveVoiceBrowserTranscriptExpectation,
} from './voiceBrowserTranscriptExpectation';

describe('resolveVoiceBrowserTranscriptExpectation', () => {
  it('requires every manifest signal for a known fixture', () => {
    const expectation = resolveVoiceBrowserTranscriptExpectation({
      fixturePath: '/fixtures/long.wav',
      metadata: { expectedTranscriptSubstrings: ['summarize', 'failing checks', 'confirmation'] },
      explicitSignal: null,
    });

    expect(expectation.matches('I will summarize the failing checks before confirmation.')).toBe(true);
    expect(expectation.matches('I will wait for CONFIRMATION.')).toBe(false);
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

  it('keeps an explicit-signal custom WAV runnable without claiming a Dictation stop window', () => {
    const fixture = resolveVoiceBrowserFixtureRun({
      fixturePath: '/custom/voice.wav',
      metadata: null,
      durationMs: 3_000,
      explicitSignal: 'custom phrase',
    });

    expect(fixture.captureDurationMs).toBe(4_000);
    expect(fixture.dictationStopTargetMs).toBeNull();
    expect(fixture.transcriptExpectation.matches('A custom phrase was projected.')).toBe(true);
  });

  it('derives a Dictation stop target only from a known terminal-silence timeline', () => {
    const fixture = resolveVoiceBrowserFixtureRun({
      fixturePath: '/fixtures/long.wav',
      metadata: {
        durationMs: 3_000,
        expectedTranscriptSubstrings: ['custom phrase'],
        timelineMs: [
          { kind: 'speech', start: 0, end: 2_000 },
          { kind: 'silence', start: 2_000, end: 3_000 },
        ],
      },
      durationMs: 99_000,
      explicitSignal: null,
    });

    expect(fixture.dictationStopTargetMs).toBe(2_500);
  });
});

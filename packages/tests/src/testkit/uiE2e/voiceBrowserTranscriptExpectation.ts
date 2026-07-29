import {
  normalizeVoiceFixtureTranscript,
  type VoiceFixtureMetadata,
} from '../voice/voiceFixture';

export type VoiceBrowserTranscriptExpectation = Readonly<{
  signals: readonly string[];
  matches: (transcript: string) => boolean;
}>;

export function resolveVoiceBrowserTranscriptExpectation(params: Readonly<{
  fixturePath: string;
  metadata: Pick<VoiceFixtureMetadata, 'expectedTranscriptSubstrings'> | null;
  explicitSignal: string | null | undefined;
}>): VoiceBrowserTranscriptExpectation {
  const explicitSignal = params.explicitSignal?.trim() ?? '';
  const signals = params.metadata
    ? params.metadata.expectedTranscriptSubstrings
    : explicitSignal
      ? [explicitSignal]
      : [];
  if (signals.length === 0) {
    throw new Error(
      `unknown Voice WAV fixture requires HAPPIER_E2E_VOICE_EXPECTED_TRANSCRIPT_SIGNAL: ${params.fixturePath}`,
    );
  }
  const normalizedSignals = signals.map(normalizeVoiceFixtureTranscript);
  return Object.freeze({
    signals: Object.freeze([...signals]),
    matches: (transcript) => {
      const normalizedTranscript = normalizeVoiceFixtureTranscript(transcript);
      return normalizedSignals.some((signal) => signal.length > 0 && normalizedTranscript.includes(signal));
    },
  });
}

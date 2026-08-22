import {
  normalizeVoiceFixtureTranscript,
  type VoiceFixtureMetadata,
} from '../voice/voiceFixture';

export type VoiceBrowserTranscriptExpectation = Readonly<{
  signals: readonly string[];
  matches: (transcript: string) => boolean;
}>;

export type VoiceBrowserFixtureRun = Readonly<{
  transcriptExpectation: VoiceBrowserTranscriptExpectation;
  durationMs: number;
  captureDurationMs: number;
  dictationStopTargetMs: number | null;
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
      return normalizedSignals.every((signal) => signal.length > 0 && normalizedTranscript.includes(signal));
    },
  });
}

export function resolveVoiceBrowserFixtureRun(params: Readonly<{
  fixturePath: string;
  metadata: Pick<VoiceFixtureMetadata, 'durationMs' | 'expectedTranscriptSubstrings' | 'timelineMs'> | null;
  durationMs: number;
  explicitSignal: string | null | undefined;
}>): VoiceBrowserFixtureRun {
  const transcriptExpectation = resolveVoiceBrowserTranscriptExpectation(params);
  const durationMs = params.metadata?.durationMs ?? params.durationMs;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`voice fixture duration unavailable: ${params.fixturePath}`);
  }
  const dictationStopTargetMs = params.metadata
    ? (() => {
        const terminalWindow = params.metadata.timelineMs.at(-1);
        if (
          terminalWindow?.kind !== 'silence'
          || terminalWindow.end !== durationMs
          || terminalWindow.end - terminalWindow.start < 500
        ) {
          throw new Error(`voice dictation fixture terminal silence invalid: ${params.fixturePath}`);
        }
        const target = terminalWindow.start + Math.floor((terminalWindow.end - terminalWindow.start) / 2);
        if (target <= 0) {
          throw new Error(`voice dictation fixture stop window unavailable: ${params.fixturePath}`);
        }
        return target;
      })()
    : null;
  return Object.freeze({
    transcriptExpectation,
    durationMs,
    captureDurationMs: durationMs + 1_000,
    dictationStopTargetMs,
  });
}

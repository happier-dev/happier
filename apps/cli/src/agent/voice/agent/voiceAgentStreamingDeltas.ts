import { fitVoiceAgentOutputTextV1, ingestVoiceAgentOutputEventV1, resolveVoiceAgentOutputSpeechSegmentLength } from '@happier-dev/protocol/voice/outputEvents';
import type { VoiceAgentOutputTurnV1 } from '@happier-dev/protocol';

type VoiceOutputDeltaEvent = Readonly<{
  t: 'voice_output';
  output: Readonly<{
    v: 1;
    kind: 'speech_segment';
    turnId: string;
    seq: number;
    segmentId: string;
    text: string;
  }>;
}>;

type VoiceStreamingOutputState = Readonly<{
  done: boolean;
  outputSpeechBuffer: string;
  outputSpeechText: string;
  outputBudget: VoiceAgentOutputTurnV1;
  outputIncomplete: boolean;
  targetChars?: number;
  events: unknown[];
  id: string;
  outputSeq: number;
  outputSegmentIndex: number;
  onEventsChanged?: () => void;
}>;

type VoiceStreamingOutputPatch = (next: Readonly<{
  outputSpeechBuffer?: string;
  outputSpeechText?: string;
  outputBudget?: VoiceAgentOutputTurnV1;
  outputIncomplete?: boolean;
  outputSeq?: number;
  outputSegmentIndex?: number;
}>) => void;

function appendSpeechText(stream: VoiceStreamingOutputState, patch: VoiceStreamingOutputPatch, text: string): void {
  if (stream.outputIncomplete) return;
  patch({ outputSpeechBuffer: `${stream.outputSpeechBuffer}${text}` });
}

export function flushVoiceAgentStreamingSpeech(
  stream: VoiceStreamingOutputState,
  patch: VoiceStreamingOutputPatch,
  force = false,
): void {
  while (stream.outputSpeechBuffer) {
    const segmentLength = resolveVoiceAgentOutputSpeechSegmentLength(stream.outputSpeechBuffer, { force, firstSegment: stream.outputSegmentIndex === 0, targetChars: stream.targetChars });
    if (segmentLength === 0) return;
    const candidateText = stream.outputSpeechBuffer.slice(0, segmentLength);
    const candidate = {
      v: 1,
      kind: 'speech_segment',
      turnId: stream.id,
      seq: stream.outputSeq,
      segmentId: `${stream.id}:segment:${stream.outputSegmentIndex}`,
      text: candidateText,
    } satisfies VoiceOutputDeltaEvent['output'];
    const text = fitVoiceAgentOutputTextV1(stream.outputBudget, candidate, stream.outputSpeechText);
    const incomplete = text.length < candidateText.length;
    if (!text) {
      patch({ outputSpeechBuffer: '', outputIncomplete: true });
      return;
    }
    const output = { ...candidate, text };
    stream.events.push({ t: 'voice_output', output } satisfies VoiceOutputDeltaEvent);
    patch({
      outputSpeechBuffer: incomplete ? '' : stream.outputSpeechBuffer.slice(segmentLength),
      outputSpeechText: `${stream.outputSpeechText}${text}`,
      outputBudget: ingestVoiceAgentOutputEventV1(stream.outputBudget, output).state,
      outputIncomplete: incomplete,
      outputSeq: stream.outputSeq + 1,
      outputSegmentIndex: stream.outputSegmentIndex + 1,
    });
    stream.onEventsChanged?.();
  }
}

export function finalizeVoiceAgentStreamingSpeech(
  stream: VoiceStreamingOutputState,
  patch: VoiceStreamingOutputPatch,
): void {
  flushVoiceAgentStreamingSpeech(stream, patch, true);
}

export function ingestVoiceAgentStreamingDelta(
  stream: VoiceStreamingOutputState,
  patch: VoiceStreamingOutputPatch,
  textDelta: string,
): void {
  if (stream.done) return;
  appendSpeechText(stream, patch, textDelta);
  flushVoiceAgentStreamingSpeech(stream, patch);
}

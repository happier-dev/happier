import { VOICE_ACTIONS_BLOCK } from '@happier-dev/protocol';

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

const TARGET_SPEECH_SEGMENT_CHARS = 320;
const MAX_SPEECH_SEGMENT_CHARS = 1_024;
const MAX_STREAMED_SPEECH_CHARS = 65_536;

type VoiceStreamingOutputState = Readonly<{
  done: boolean;
  suppressActionDeltas: boolean;
  deltaHold: string;
  outputSpeechBuffer: string;
  outputSpeechChars: number;
  events: unknown[];
  id: string;
  outputSeq: number;
  outputSegmentIndex: number;
}>;

type VoiceStreamingOutputPatch = (next: Readonly<{
  suppressActionDeltas?: boolean;
  deltaHold?: string;
  outputSpeechBuffer?: string;
  outputSpeechChars?: number;
  outputSeq?: number;
  outputSegmentIndex?: number;
}>) => void;

function resolveSegmentLength(buffer: string, force: boolean): number {
  if (force) return Math.min(buffer.length, MAX_SPEECH_SEGMENT_CHARS);
  if (buffer.length < TARGET_SPEECH_SEGMENT_CHARS) return 0;
  const scanEnd = Math.min(buffer.length, MAX_SPEECH_SEGMENT_CHARS);
  for (let index = scanEnd - 1; index >= TARGET_SPEECH_SEGMENT_CHARS - 1; index -= 1) {
    if (/\s|[.!?;,:]/.test(buffer[index]!)) return index + 1;
  }
  return scanEnd === MAX_SPEECH_SEGMENT_CHARS ? scanEnd : 0;
}

function appendSpeechText(stream: VoiceStreamingOutputState, patch: VoiceStreamingOutputPatch, text: string): void {
  const remaining = Math.max(0, MAX_STREAMED_SPEECH_CHARS - stream.outputSpeechChars - stream.outputSpeechBuffer.length);
  if (remaining === 0) return;
  patch({ outputSpeechBuffer: `${stream.outputSpeechBuffer}${text.slice(0, remaining)}` });
}

export function flushVoiceAgentStreamingSpeech(
  stream: VoiceStreamingOutputState,
  patch: VoiceStreamingOutputPatch,
  force = false,
): void {
  while (stream.outputSpeechBuffer) {
    const segmentLength = resolveSegmentLength(stream.outputSpeechBuffer, force);
    if (segmentLength === 0) return;
    const text = stream.outputSpeechBuffer.slice(0, segmentLength);
    stream.events.push({
      t: 'voice_output',
      output: {
        v: 1,
        kind: 'speech_segment',
        turnId: stream.id,
        seq: stream.outputSeq,
        segmentId: `${stream.id}:segment:${stream.outputSegmentIndex}`,
        text,
      },
    } satisfies VoiceOutputDeltaEvent);
    patch({
      outputSpeechBuffer: stream.outputSpeechBuffer.slice(segmentLength),
      outputSpeechChars: stream.outputSpeechChars + text.length,
      outputSeq: stream.outputSeq + 1,
      outputSegmentIndex: stream.outputSegmentIndex + 1,
    });
  }
}

export function finalizeVoiceAgentStreamingSpeech(
  stream: VoiceStreamingOutputState,
  patch: VoiceStreamingOutputPatch,
): void {
  if (!stream.suppressActionDeltas && stream.deltaHold) appendSpeechText(stream, patch, stream.deltaHold);
  patch({ deltaHold: '' });
  flushVoiceAgentStreamingSpeech(stream, patch, true);
}

export function ingestVoiceAgentStreamingDelta(
  stream: VoiceStreamingOutputState,
  patch: VoiceStreamingOutputPatch,
  textDelta: string,
): void {
  if (stream.done) return;
  if (stream.suppressActionDeltas) return;

  const startTag = VOICE_ACTIONS_BLOCK.startTag;
  const maxHold = Math.max(0, startTag.length - 1);
  const combined = `${stream.deltaHold}${textDelta}`;
  const tagIndex = combined.indexOf(startTag);
  if (tagIndex >= 0) {
    const emit = combined.slice(0, tagIndex);
    if (emit) {
      appendSpeechText(stream, patch, emit);
    }
    flushVoiceAgentStreamingSpeech(stream, patch, true);
    patch({ deltaHold: '', suppressActionDeltas: true });
    return;
  }

  const safeLen = Math.max(0, combined.length - maxHold);
  const emit = combined.slice(0, safeLen);
  const nextHold = combined.slice(safeLen);
  patch({ deltaHold: nextHold });
  if (emit) {
    appendSpeechText(stream, patch, emit);
    flushVoiceAgentStreamingSpeech(stream, patch);
  }
}

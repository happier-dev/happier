import {
  VoiceAgentOutputEventV1Schema,
  VoiceAssistantActionSchema,
  type VoiceAgentOutputEventV1,
} from '@happier-dev/protocol';

import type { VoiceAgentTurnStreamEvent } from './types';

const TARGET_SEGMENT_CHARS = 320;
const MAX_SEGMENT_CHARS = 1_024;
const MAX_SPEECH_CHARS = 65_536;

export function createLegacyVoiceOutputAdapter(input: Readonly<{ streamId: string }>): Readonly<{
  ingest(sourceCursor: number, event: VoiceAgentTurnStreamEvent): readonly VoiceAgentOutputEventV1[];
}> {
  const streamId = String(input.streamId).trim();
  // Exercise the protocol id validator once without fabricating a second id policy.
  VoiceAgentOutputEventV1Schema.parse({
    v: 1,
    kind: 'turn_cancelled',
    turnId: streamId,
    seq: 0,
  });
  let highestSourceCursor = -1;
  let nextSeq = 0;
  let terminal = false;
  let mode: 'unknown' | 'legacy' | 'native' = 'unknown';
  let speechBuffer = '';
  let speechChars = 0;
  let segmentIndex = 0;

  const emit = <T extends VoiceAgentOutputEventV1>(event: T): T => {
    const parsed = VoiceAgentOutputEventV1Schema.parse(event);
    nextSeq += 1;
    return parsed as T;
  };

  const flushSpeech = (force: boolean): VoiceAgentOutputEventV1[] => {
    const output: VoiceAgentOutputEventV1[] = [];
    while (speechBuffer) {
      let length = Math.min(speechBuffer.length, MAX_SEGMENT_CHARS);
      if (!force) {
        if (speechBuffer.length < TARGET_SEGMENT_CHARS) break;
        let boundary = 0;
        for (let index = length - 1; index >= TARGET_SEGMENT_CHARS - 1; index -= 1) {
          if (/\s|[.!?;,:]/.test(speechBuffer[index]!)) {
            boundary = index + 1;
            break;
          }
        }
        if (boundary > 0) length = boundary;
        else if (speechBuffer.length < MAX_SEGMENT_CHARS) break;
      }
      const text = speechBuffer.slice(0, length);
      speechBuffer = speechBuffer.slice(length);
      speechChars += text.length;
      output.push(emit({
        v: 1,
        kind: 'speech_segment',
        turnId: streamId,
        seq: nextSeq,
        segmentId: `${streamId}:legacy:segment:${segmentIndex}`,
        text,
      }));
      segmentIndex += 1;
    }
    return output;
  };

  return Object.freeze({
    ingest(sourceCursor, event) {
      if (terminal) return [];
      if (!Number.isSafeInteger(sourceCursor) || sourceCursor < 0) {
        throw new Error('voice_output_legacy_cursor_invalid');
      }
      if (sourceCursor <= highestSourceCursor) return [];
      highestSourceCursor = sourceCursor;

      if (event.t === 'voice_output') {
        if (mode === 'legacy') throw new Error('voice_output_mixed_stream');
        mode = 'native';
        const output = VoiceAgentOutputEventV1Schema.parse(event.output);
        if (output.turnId !== streamId || output.seq !== nextSeq) {
          throw new Error('voice_output_native_sequence_invalid');
        }
        nextSeq += 1;
        if (output.kind === 'turn_final' || output.kind === 'turn_cancelled') terminal = true;
        return [output];
      }

      if (event.t === 'delta') {
        if (mode === 'native') throw new Error('voice_output_mixed_stream');
        mode = 'legacy';
        if (!event.textDelta) return [];
        const remaining = Math.max(0, MAX_SPEECH_CHARS - speechChars - speechBuffer.length);
        speechBuffer += event.textDelta.slice(0, remaining);
        return flushSpeech(false);
      }
      if (event.t === 'done') {
        if (mode === 'native') throw new Error('voice_output_mixed_stream');
        mode = 'legacy';
        terminal = true;
        const output = flushSpeech(true);
        for (const [actionIndex, actionRaw] of (event.actions ?? []).entries()) {
          const action = VoiceAssistantActionSchema.safeParse(actionRaw);
          if (!action.success) continue;
          output.push(emit({
            v: 1,
            kind: 'side_effect',
            turnId: streamId,
            seq: nextSeq,
            effectId: `${streamId}:legacy:${sourceCursor}:${actionIndex}`,
            action: action.data,
          }));
        }
        output.push(emit({
          v: 1,
          kind: 'turn_final',
          turnId: streamId,
          seq: nextSeq,
          text: event.assistantText.slice(0, MAX_SPEECH_CHARS),
        }));
        return output;
      }
      if (event.t === 'cancelled') {
        speechBuffer = '';
        terminal = true;
        return [emit({
          v: 1,
          kind: 'turn_cancelled',
          turnId: streamId,
          seq: nextSeq,
        })];
      }
      return [];
    },
  });
}

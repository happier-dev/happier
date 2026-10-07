import { VoiceAgentOutputEventV1Schema, resolveVoiceAgentOutputSpeechSegmentLength, VOICE_OUTPUT_INCOMPLETE_TEXT, canAppendVoiceAgentOutputEventsV1, createVoiceAgentOutputTurnV1, fitVoiceAgentOutputTextV1, ingestVoiceAgentOutputEventV1, type VoiceAgentOutputEventV1 } from '@happier-dev/protocol/voice/outputEvents';
import { VoiceAssistantActionSchema } from '@happier-dev/protocol/voice/actions';

import type { VoiceAgentTurnStreamEvent } from './types';

export function createLegacyVoiceOutputAdapter(input: Readonly<{ streamId: string; speechSegmentTargetChars?: number }>): Readonly<{
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
  let speechText = '';
  let incomplete = false;
  let budget = createVoiceAgentOutputTurnV1(streamId);
  let segmentIndex = 0;

  const emit = <T extends VoiceAgentOutputEventV1>(event: T): T => {
    const parsed = VoiceAgentOutputEventV1Schema.parse(event);
    budget = ingestVoiceAgentOutputEventV1(budget, parsed).state;
    nextSeq += 1;
    return parsed as T;
  };

  const flushSpeech = (force: boolean): VoiceAgentOutputEventV1[] => {
    const output: VoiceAgentOutputEventV1[] = [];
    while (speechBuffer) {
      const length = resolveVoiceAgentOutputSpeechSegmentLength(speechBuffer, {
        force, firstSegment: segmentIndex === 0, targetChars: input.speechSegmentTargetChars,
      });
      if (length === 0) break;
      const candidate = {
        v: 1,
        kind: 'speech_segment',
        turnId: streamId,
        seq: nextSeq,
        segmentId: `${streamId}:legacy:segment:${segmentIndex}`,
        text: speechBuffer.slice(0, length),
      } as const;
      const text = fitVoiceAgentOutputTextV1(budget, candidate, speechText);
      incomplete = text.length < candidate.text.length;
      speechBuffer = incomplete ? '' : speechBuffer.slice(length);
      if (!text) break;
      speechText += text;
      output.push(emit({ ...candidate, text }));
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
        // Native sequence, turn, terminal, and stable-id semantics belong to the
        // Protocol ingest owner. This adapter only validates the wire shape and
        // translates the legacy delta/done form.
        return [output];
      }

      if (event.t === 'delta') {
        if (mode === 'native') throw new Error('voice_output_mixed_stream');
        mode = 'legacy';
        if (!event.textDelta) return [];
        if (incomplete) return [];
        speechBuffer += event.textDelta;
        return flushSpeech(false);
      }
      if (event.t === 'done') {
        if (mode === 'native') throw new Error('voice_output_mixed_stream');
        mode = 'legacy';
        terminal = true;
        const output = flushSpeech(true);
        const finalCandidate = {
          v: 1, kind: 'turn_final', turnId: streamId, seq: nextSeq, text: event.assistantText,
        } as const;
        let finalText = fitVoiceAgentOutputTextV1(budget, finalCandidate, '', VOICE_OUTPUT_INCOMPLETE_TEXT);
        if (finalText.length < event.assistantText.length) incomplete = true;
        if (incomplete && speechText && !finalText.startsWith(speechText.trimEnd())) finalText = speechText.trimEnd();
        for (const [actionIndex, actionRaw] of (event.actions ?? []).entries()) {
          const action = VoiceAssistantActionSchema.safeParse(actionRaw);
          if (!action.success) continue;
          const effect = {
            v: 1,
            kind: 'side_effect',
            turnId: streamId,
            seq: nextSeq,
            effectId: `${streamId}:legacy:${sourceCursor}:${actionIndex}`,
            action: action.data,
          } as const;
          if (!canAppendVoiceAgentOutputEventsV1(budget, [
            effect, { ...finalCandidate, seq: nextSeq + 1, text: `${finalText}${VOICE_OUTPUT_INCOMPLETE_TEXT}` },
          ]) || !canAppendVoiceAgentOutputEventsV1(budget, [
            effect, { ...finalCandidate, seq: nextSeq + 1, text: `${speechText.trimEnd()}${VOICE_OUTPUT_INCOMPLETE_TEXT}` },
          ])) {
            incomplete = true;
            if (speechText && !finalText.startsWith(speechText.trimEnd())) finalText = speechText.trimEnd();
            break;
          }
          output.push(emit(effect));
        }
        output.push(emit({
          v: 1,
          kind: 'turn_final',
          turnId: streamId,
          seq: nextSeq,
          text: `${finalText}${incomplete ? VOICE_OUTPUT_INCOMPLETE_TEXT : ''}`,
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

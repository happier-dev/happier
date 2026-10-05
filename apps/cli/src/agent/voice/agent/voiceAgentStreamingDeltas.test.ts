import { describe, expect, it } from 'vitest';
import { createVoiceAgentOutputTurnV1 } from '@happier-dev/protocol';

import { finalizeVoiceAgentStreamingSpeech, ingestVoiceAgentStreamingDelta } from './voiceAgentStreamingDeltas';

function createStream() {
  return {
    done: false,
    suppressActionDeltas: false,
    deltaHold: '',
    outputSpeechBuffer: '',
    outputSpeechText: '',
    outputBudget: createVoiceAgentOutputTurnV1('turn-1'),
    outputIncomplete: false,
    events: [] as any[],
    id: 'turn-1',
    outputSeq: 0,
    outputSegmentIndex: 0,
  };
}

function patchStream(stream: ReturnType<typeof createStream>) {
  return (patch: Partial<typeof stream>) => Object.assign(stream, patch);
}

describe('voice agent streaming speech segmentation', () => {
  it('coalesces token-sized deltas into bounded stable segments below the per-turn event budget', () => {
    const stream = createStream();
    const patch = patchStream(stream);
    const expected = `${'word '.repeat(10_000)}done.`;
    for (const character of expected) ingestVoiceAgentStreamingDelta(stream, patch, character);
    finalizeVoiceAgentStreamingSpeech(stream, patch);

    const segments = stream.events.map((event) => event.output);
    expect(segments.length).toBeLessThanOrEqual(256);
    expect(segments.every((event) => event.kind === 'speech_segment' && event.text.length <= 1_024)).toBe(true);
    expect(segments.map((event) => event.text).join('')).toBe(expected);
    expect(segments.map((event) => event.seq)).toEqual(segments.map((_, index) => index));
  });

  it('never emits the canonical action block even when its start tag is split across deltas', () => {
    const stream = createStream();
    const patch = patchStream(stream);
    for (const delta of ['Speak this. <voice_', 'actions>{"actions":[]}</voice_actions>']) {
      ingestVoiceAgentStreamingDelta(stream, patch, delta);
    }
    finalizeVoiceAgentStreamingSpeech(stream, patch);

    expect(stream.events.map((event) => event.output.text).join('')).toBe('Speak this. ');
    expect(stream.suppressActionDeltas).toBe(true);
  });
  it('emits a useful first sentence before completion and filters split action tags', () => {
    const stream = {
      done: false, suppressActionDeltas: false, deltaHold: '', outputSpeechBuffer: '',
      outputSpeechText: '', outputBudget: createVoiceAgentOutputTurnV1('turn'), outputIncomplete: false,
      events: [] as unknown[], id: 'turn', outputSeq: 0, outputSegmentIndex: 0,
    };
    const patch = (next: Partial<typeof stream>) => Object.assign(stream, next);
    ingestVoiceAgentStreamingDelta(stream, patch, 'Open index.');
    expect(stream.events).toEqual([]);
    ingestVoiceAgentStreamingDelta(stream, patch, 'ts at https://example.com at 10:30. ');
    expect(stream.events).toEqual([expect.objectContaining({ output: expect.objectContaining({
      text: 'Open index.ts at https://example.com at 10:30.', kind: 'speech_segment',
    }) })]);
    ingestVoiceAgentStreamingDelta(stream, patch, '<voice_act');
    ingestVoiceAgentStreamingDelta(stream, patch, 'ions>{"actions":[]}</voice_actions>');
    finalizeVoiceAgentStreamingSpeech(stream, patch);
    const speech = stream.events.map((event) => (event as { output: { text: string } }).output.text).join('');
    expect(speech.trim()).toBe('Open index.ts at https://example.com at 10:30.');
  });
});

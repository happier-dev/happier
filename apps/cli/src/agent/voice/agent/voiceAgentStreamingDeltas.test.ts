import { describe, expect, it } from 'vitest';
import { createVoiceAgentOutputTurnV1 } from '@happier-dev/protocol';
import { VoiceAgentSpeechSegmentEventV1Schema } from '@happier-dev/protocol/voice/outputEvents';

import { finalizeVoiceAgentStreamingSpeech, ingestVoiceAgentStreamingDelta } from './voiceAgentStreamingDeltas';

type StreamingState = Parameters<typeof ingestVoiceAgentStreamingDelta>[0];

function createStream(): StreamingState {
  return {
    done: false,
    outputSpeechBuffer: '',
    outputSpeechText: '',
    outputBudget: createVoiceAgentOutputTurnV1('turn-1'),
    outputIncomplete: false,
    events: [],
    id: 'turn-1',
    outputSeq: 0,
    outputSegmentIndex: 0,
  };
}

function speechSegments(stream: StreamingState) {
  return stream.events.map((event) => {
    expect(event).toMatchObject({ t: 'voice_output' });
    return VoiceAgentSpeechSegmentEventV1Schema.parse(
      typeof event === 'object' && event !== null && 'output' in event ? event.output : undefined,
    );
  });
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

    const segments = speechSegments(stream);
    expect(segments.length).toBeLessThanOrEqual(256);
    expect(segments.every((event) => event.kind === 'speech_segment' && event.text.length <= 1_024)).toBe(true);
    expect(segments.map((event) => event.text).join('')).toBe(expected);
    expect(segments.map((event) => event.seq)).toEqual(segments.map((_, index) => index));
  });

  it('preserves literal legacy Action markers split across deltas', () => {
    const stream = createStream();
    const patch = patchStream(stream);
    for (const delta of ['Speak this. <voice_', 'actions>{"actions":[]}</voice_actions>']) {
      ingestVoiceAgentStreamingDelta(stream, patch, delta);
    }
    finalizeVoiceAgentStreamingSpeech(stream, patch);

    expect(speechSegments(stream).map((event) => event.text).join('')).toBe('Speak this. <voice_actions>{"actions":[]}</voice_actions>');
  });
  it('emits a useful first sentence before completion and preserves remaining literal text', () => {
    const stream = createStream();
    const patch = patchStream(stream);
    ingestVoiceAgentStreamingDelta(stream, patch, 'Open index.');
    expect(stream.events).toEqual([]);
    ingestVoiceAgentStreamingDelta(stream, patch, 'ts at https://example.com at 10:30. ');
    expect(stream.events).toEqual([expect.objectContaining({ output: expect.objectContaining({
      text: 'Open index.ts at https://example.com at 10:30.', kind: 'speech_segment',
    }) })]);
    ingestVoiceAgentStreamingDelta(stream, patch, '<voice_act');
    ingestVoiceAgentStreamingDelta(stream, patch, 'ions>{"actions":[]}</voice_actions>');
    finalizeVoiceAgentStreamingSpeech(stream, patch);
    const speech = speechSegments(stream).map((event) => event.text).join('');
    expect(speech).toBe('Open index.ts at https://example.com at 10:30. <voice_actions>{"actions":[]}</voice_actions>');
  });
});

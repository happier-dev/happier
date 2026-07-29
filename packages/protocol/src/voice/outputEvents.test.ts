import { describe, expect, it } from 'vitest';

import {
  VoiceAgentOutputEventV1Schema,
  createVoiceAgentOutputTurnV1,
  ingestVoiceAgentOutputEventV1,
} from './outputEvents.js';

describe('VoiceAgentOutputEventV1', () => {
  it('accepts the four provider-neutral output channels and rejects unbounded identifiers/text', () => {
    const events = [
      { v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: 0, segmentId: 'seg-1', text: 'Hello' },
      { v: 1, kind: 'display_status', turnId: 'turn-1', seq: 1, statusId: 'status-1', text: 'Checking…' },
      { v: 1, kind: 'side_effect', turnId: 'turn-1', seq: 2, effectId: 'effect-1', action: { t: 'sendSessionMessage', args: { message: 'Do it' } } },
      { v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 3, text: 'Hello' },
    ];

    for (const event of events) expect(VoiceAgentOutputEventV1Schema.safeParse(event).success).toBe(true);
    expect(VoiceAgentOutputEventV1Schema.safeParse({ ...events[0], segmentId: 'x'.repeat(129) }).success).toBe(false);
    expect(VoiceAgentOutputEventV1Schema.safeParse({ ...events[1], text: 'x'.repeat(1025) }).success).toBe(false);
    expect(VoiceAgentOutputEventV1Schema.safeParse({ ...events[3], text: 'x'.repeat(65_537) }).success).toBe(false);
  });

  it('routes each channel once, deduplicates stable ids, and never turns status into speech or transcript', () => {
    let state = createVoiceAgentOutputTurnV1('turn-1');
    const speech = { v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: 0, segmentId: 'seg-1', text: 'Hello' } as const;
    const status = { v: 1, kind: 'display_status', turnId: 'turn-1', seq: 1, statusId: 'status-1', text: 'Working' } as const;
    const final = { v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 2, text: 'Hello world' } as const;

    let result = ingestVoiceAgentOutputEventV1(state, speech);
    state = result.state;
    expect(result.effects).toEqual([{ kind: 'speak', segmentId: 'seg-1', text: 'Hello' }]);
    result = ingestVoiceAgentOutputEventV1(state, speech);
    expect(result.effects).toEqual([]);

    result = ingestVoiceAgentOutputEventV1(state, status);
    state = result.state;
    expect(result.effects).toEqual([{ kind: 'display_status', statusId: 'status-1', text: 'Working' }]);
    result = ingestVoiceAgentOutputEventV1(state, final);
    expect(result.effects).toEqual([{ kind: 'persist_final', text: 'Hello world' }]);
  });

  it('derives one fallback speech segment only when a final arrives before any speech', () => {
    const event = { v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 0, text: 'Only final' } as const;
    const result = ingestVoiceAgentOutputEventV1(createVoiceAgentOutputTurnV1('turn-1'), event);
    expect(result.effects).toEqual([
      { kind: 'speak', segmentId: 'turn-1:final', text: 'Only final' },
      { kind: 'persist_final', text: 'Only final' },
    ]);
  });

  it('makes cancellation terminal and fails closed on another turn or non-monotonic sequence', () => {
    let state = createVoiceAgentOutputTurnV1('turn-1');
    let result = ingestVoiceAgentOutputEventV1(state, {
      v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: 0, segmentId: 'seg-1', text: 'Hello',
    });
    state = result.state;
    result = ingestVoiceAgentOutputEventV1(state, { v: 1, kind: 'turn_cancelled', turnId: 'turn-1', seq: 1 });
    state = result.state;
    expect(result.effects).toEqual([{ kind: 'cancel_turn' }]);
    expect(ingestVoiceAgentOutputEventV1(state, { v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 2, text: 'Late' }).effects).toEqual([]);
    expect(() => ingestVoiceAgentOutputEventV1(createVoiceAgentOutputTurnV1('turn-1'), {
      v: 1, kind: 'turn_final', turnId: 'other', seq: 0, text: 'Wrong',
    })).toThrow('voice_output_turn_mismatch');
    expect(() => ingestVoiceAgentOutputEventV1(state, {
      v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: 0, segmentId: 'seg-2', text: 'Old',
    })).not.toThrow();
  });

  it('makes finalization terminal so replayed finals and late side effects cannot double-persist or execute', () => {
    let result = ingestVoiceAgentOutputEventV1(createVoiceAgentOutputTurnV1('turn-1'), {
      v: 1, kind: 'side_effect', turnId: 'turn-1', seq: 0, effectId: 'effect-1',
      action: { t: 'sendSessionMessage', args: { message: 'Do it' } },
    });
    expect(result.effects).toHaveLength(1);
    result = ingestVoiceAgentOutputEventV1(result.state, {
      v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 1, text: 'Done',
    });
    expect(result.effects).toEqual([
      { kind: 'speak', segmentId: 'turn-1:final', text: 'Done' },
      { kind: 'persist_final', text: 'Done' },
    ]);
    const finalized = result.state;
    expect(ingestVoiceAgentOutputEventV1(finalized, {
      v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 1, text: 'Done',
    }).effects).toEqual([]);
    expect(ingestVoiceAgentOutputEventV1(finalized, {
      v: 1, kind: 'side_effect', turnId: 'turn-1', seq: 2, effectId: 'effect-late',
      action: { t: 'sendSessionMessage', args: { message: 'Run twice' } },
    }).effects).toEqual([]);
  });

});

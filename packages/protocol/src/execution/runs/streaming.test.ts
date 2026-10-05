import { describe, expect, it } from 'vitest';

import {
  ExecutionRunTurnStreamStartRequestSchema,
  ExecutionRunTurnStreamStartV2RequestSchema,
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
  ExecutionRunUserTranscriptCommitRequestSchema,
} from '../../index.js';

describe('execution run streaming schemas', () => {
  it('accepts omitted latency policy and validates the existing speech preference range', () => {
    const request = { runId: 'run-1', message: 'hello' };
    expect(ExecutionRunTurnStreamStartRequestSchema.parse(request).speechSegmentTargetChars).toBeUndefined();
    for (const speechSegmentTargetChars of [32, 120, 2000]) {
      expect(ExecutionRunTurnStreamStartRequestSchema.parse({ ...request, speechSegmentTargetChars })
        .speechSegmentTargetChars).toBe(speechSegmentTargetChars);
    }
    for (const speechSegmentTargetChars of [null, '120', 31, 2001, 120.5]) {
      expect(ExecutionRunTurnStreamStartRequestSchema.safeParse({ ...request, speechSegmentTargetChars }).success).toBe(false);
    }
  });
  it('parses start response', () => {
    const parsed = ExecutionRunTurnStreamStartResponseSchema.parse({ streamId: 'stream-1' });
    expect(parsed.streamId).toBe('stream-1');
  });

  it('preserves an opaque pending local id in v2 persist and explicit commit requests', () => {
    const localId = ' opaque-local-id ';

    expect(ExecutionRunTurnStreamStartV2RequestSchema.parse({
      runId: 'run-1',
      message: 'hello',
      userTranscript: { mode: 'persist', localId },
    }).userTranscript).toEqual({ mode: 'persist', localId });
    expect(ExecutionRunUserTranscriptCommitRequestSchema.parse({
      runId: 'run-1',
      message: 'hello',
      localId,
    }).localId).toBe(localId);
  });

  it('requires an explicit persist or suppress user-transcript directive for v2 starts', () => {
    expect(ExecutionRunTurnStreamStartV2RequestSchema.parse({
      runId: 'run-1',
      message: 'tool follow-up',
      userTranscript: { mode: 'suppress' },
    }).userTranscript).toEqual({ mode: 'suppress' });
    expect(ExecutionRunTurnStreamStartV2RequestSchema.safeParse({
      runId: 'run-1',
      message: 'hello',
    }).success).toBe(false);
  });

  it('parses read response with deltas + done actions', () => {
    const parsed = ExecutionRunTurnStreamReadResponseSchema.parse({
      streamId: 'stream-1',
      events: [
        { t: 'delta', textDelta: 'hello ' },
        { t: 'delta', textDelta: 'world' },
        { t: 'done', assistantText: 'hello world', actions: [{ t: 'sendSessionMessage', args: { message: 'do X' } }] },
      ],
      nextCursor: 3,
      done: true,
    });
    expect(parsed.done).toBe(true);
    expect(parsed.events[2]).toEqual(
      expect.objectContaining({ t: 'done', assistantText: 'hello world' }),
    );
  });

  it('parses a terminal cancelled event without requiring assistant output', () => {
    const parsed = ExecutionRunTurnStreamReadResponseSchema.parse({
      streamId: 'stream-cancelled',
      events: [{ t: 'cancelled' }],
      nextCursor: 1,
      done: true,
    });

    expect(parsed).toEqual({
      streamId: 'stream-cancelled',
      events: [{ t: 'cancelled' }],
      nextCursor: 1,
      done: true,
    });
  });

  it('carries the canonical voice-output union without flattening channel meaning into generic text', () => {
    const parsed = ExecutionRunTurnStreamReadResponseSchema.parse({
      streamId: 'stream-voice',
      events: [{
        t: 'voice_output',
        output: { v: 1, kind: 'turn_final', turnId: 'stream-voice', seq: 0, text: 'final' },
      }],
      nextCursor: 1,
      done: true,
    });
    expect(parsed.events[0]).toMatchObject({ t: 'voice_output', output: { kind: 'turn_final' } });
  });
});

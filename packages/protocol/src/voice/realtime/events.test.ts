import { describe, expect, it } from 'vitest';

import {
  VoiceRealtimeToolCallV1Schema,
  VoiceRealtimeToolResultV1Schema,
  VoiceTranscriptCanonicalEventV1Schema,
} from './events';

describe('canonical realtime voice events', () => {
  it('accepts stable transcript updates, finals, and replay provenance', () => {
    expect(VoiceTranscriptCanonicalEventV1Schema.parse({
      v: 1,
      type: 'voice.transcript.updated',
      epoch: 2,
      sequence: 7,
      revision: 3,
      eventId: 'evt-7',
      itemId: 'item-user-1',
      role: 'user',
      text: 'corrected cumulative text',
      provenance: 'replay',
    })).toMatchObject({ itemId: 'item-user-1', provenance: 'replay' });

    expect(VoiceTranscriptCanonicalEventV1Schema.parse({
      v: 1,
      type: 'voice.transcript.final',
      epoch: 2,
      sequence: 8,
      revision: 4,
      eventId: 'evt-8',
      itemId: 'item-user-1',
      role: 'user',
      text: 'corrected cumulative text',
      provenance: 'live',
    })).toMatchObject({ type: 'voice.transcript.final' });

    expect(VoiceTranscriptCanonicalEventV1Schema.parse({
      v: 1,
      type: 'voice.transcript.corrected',
      epoch: 2,
      sequence: 9,
      revision: 5,
      eventId: 'evt-9',
      itemId: 'item-user-1',
      role: 'user',
      text: 'provider-corrected final text',
      provenance: 'live',
    })).toMatchObject({ type: 'voice.transcript.corrected', revision: 5 });
  });

  it('rejects missing stable identity and non-JSON tool values', () => {
    expect(VoiceTranscriptCanonicalEventV1Schema.safeParse({
      v: 1,
      type: 'voice.transcript.final',
      epoch: 0,
      sequence: 1,
      revision: 1,
      eventId: '',
      itemId: '',
      role: 'assistant',
      text: 'hello',
      provenance: 'live',
    }).success).toBe(false);

    expect(VoiceRealtimeToolCallV1Schema.safeParse({
      v: 1,
      responseId: 'response-1',
      callId: 'call-1',
      toolName: 'sessionList',
      order: 0,
      arguments: () => undefined,
    }).success).toBe(false);
  });

  it('rejects rather than normalizes whitespace around opaque provider identities', () => {
    const transcript = {
      v: 1 as const,
      type: 'voice.transcript.final' as const,
      epoch: 0,
      sequence: 1,
      revision: 1,
      eventId: ' event-1',
      itemId: 'item-1',
      role: 'assistant' as const,
      text: 'hello',
      provenance: 'live' as const,
    };
    expect(VoiceTranscriptCanonicalEventV1Schema.safeParse(transcript).success).toBe(false);
    expect(VoiceRealtimeToolCallV1Schema.safeParse({
      v: 1,
      responseId: 'response-1 ',
      callId: 'call-1',
      toolName: 'sessionList',
      order: 0,
      arguments: {},
    }).success).toBe(false);
  });

  it('rejects opaque identities containing unpaired UTF-16 surrogates', () => {
    for (const malformedIdentity of ['item-\uD800', 'item-\uDC00']) {
      expect(VoiceTranscriptCanonicalEventV1Schema.safeParse({
        v: 1,
        type: 'voice.transcript.final',
        epoch: 0,
        sequence: 1,
        revision: 1,
        eventId: `${malformedIdentity}:final`,
        itemId: malformedIdentity,
        role: 'assistant',
        text: 'must remain inert',
        provenance: 'live',
      }).success).toBe(false);
    }
  });

  it('bounds nested provider JSON depth, collection width, and string size', () => {
    let deeplyNested: unknown = 'leaf';
    for (let depth = 0; depth < 20; depth += 1) deeplyNested = { next: deeplyNested };

    const base = {
      v: 1 as const,
      responseId: 'response-1',
      callId: 'call-1',
      toolName: 'listMachines',
      order: 0,
    };
    expect(VoiceRealtimeToolCallV1Schema.safeParse({ ...base, arguments: deeplyNested }).success).toBe(false);
    expect(VoiceRealtimeToolCallV1Schema.safeParse({
      ...base,
      arguments: Array.from({ length: 257 }, () => null),
    }).success).toBe(false);
    expect(VoiceRealtimeToolCallV1Schema.safeParse({
      ...base,
      arguments: 'x'.repeat(64 * 1024 + 1),
    }).success).toBe(false);
  });

  it('bounds provider-neutral tool calls and terminal results', () => {
    const call = VoiceRealtimeToolCallV1Schema.parse({
      v: 1,
      responseId: 'response-1',
      callId: 'call-1',
      toolName: 'sessionList',
      order: 0,
      arguments: { limit: 5 },
    });
    expect(call.arguments).toEqual({ limit: 5 });

    expect(VoiceRealtimeToolResultV1Schema.parse({
      v: 1,
      responseId: 'response-1',
      callId: 'call-1',
      toolName: 'sessionList',
      order: 0,
      status: 'success',
      output: { ok: true },
    })).toMatchObject({ status: 'success' });
    expect(VoiceRealtimeToolResultV1Schema.safeParse({
      v: 1,
      responseId: 'response-1',
      callId: 'call-1',
      toolName: 'sessionList',
      order: 0,
      status: 'denied',
      output: { leaked: true },
    }).success).toBe(false);
  });

  it('rejects unsafe integer ordering fields that cannot preserve exact event identity', () => {
    expect(VoiceTranscriptCanonicalEventV1Schema.safeParse({
      v: 1,
      type: 'voice.transcript.updated',
      epoch: Number.MAX_SAFE_INTEGER + 1,
      sequence: 1,
      revision: 1,
      eventId: 'event-1',
      itemId: 'item-1',
      role: 'user',
      text: 'hello',
      provenance: 'live',
    }).success).toBe(false);
    expect(VoiceRealtimeToolCallV1Schema.safeParse({
      v: 1,
      responseId: 'response-1',
      callId: 'call-1',
      toolName: 'sessionList',
      order: Number.MAX_SAFE_INTEGER + 1,
      arguments: {},
    }).success).toBe(false);
  });
});

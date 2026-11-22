import { describe, expect, it } from 'vitest';

import { VoiceTranscriptCanonicalEventV1Schema } from '@happier-dev/plugin-sdk/voice/client';

import { createElevenLabsEventMapper } from './eventMapper.js';

describe('createElevenLabsEventMapper', () => {
  it('maps exact provider event identity into stable final transcript items', () => {
    const mapper = createElevenLabsEventMapper();
    mapper.beginConversation();

    expect(mapper.map({ event_id: 17, role: 'user', source: 'user', message: 'hello' })).toEqual({
      v: 1,
      type: 'voice.transcript.final',
      epoch: 1,
      sequence: 1,
      revision: 1,
      eventId: 'elevenlabs:user:message:17:1',
      itemId: 'elevenlabs:user:message:17',
      role: 'user',
      text: 'hello',
      provenance: 'live',
    });
  });

  it('drops transcript messages without stable provider event identity', () => {
    const mapper = createElevenLabsEventMapper();
    mapper.beginConversation();

    expect(mapper.map({ role: 'user', source: 'user', message: 'hello' })).toBeNull();
  });

  it('omits empty user utterances and silence placeholders before publishing transcript items', () => {
    const mapper = createElevenLabsEventMapper();
    mapper.beginConversation();

    // RUN1111-R2 persisted user "..." rows (seq309/310) as real speech.
    for (const message of ['', '  ', '...', '  ...  ']) {
      expect(mapper.map({ event_id: 136, role: 'user', source: 'user', message })).toBeNull();
    }
    expect(mapper.map({ event_id: 136, role: 'user', source: 'user', message: 'Wait... what?' }))
      .toMatchObject({ type: 'voice.transcript.final', sequence: 1, revision: 1, role: 'user', text: 'Wait... what?' });
    expect(mapper.map({ event_id: 137, role: 'agent', source: 'ai', message: '...' }))
      .toMatchObject({ type: 'voice.transcript.final', sequence: 2, role: 'assistant', text: '...' });
  });

  it('publishes both speakers on a shared provider event ID and corrects only the assistant', () => {
    const mapper = createElevenLabsEventMapper();
    mapper.beginConversation();
    // P3 wire capture (wizard/curtain turn), through the SDK's onMessage shape.
    const user = { event_id: 88, role: 'user', source: 'user', message: 'Who vanished behind the curtain?' };
    const assistant = { event_id: 88, role: 'agent', source: 'ai', message: 'The wizard vanished behind the curtain.' };
    const userFinal = mapper.map(user);
    const assistantFinal = mapper.map(assistant);
    expect(userFinal).toMatchObject({
      type: 'voice.transcript.final', role: 'user', sequence: 1, revision: 1, text: user.message,
    });
    expect(assistantFinal).toMatchObject({
      type: 'voice.transcript.final', role: 'assistant', sequence: 2, revision: 1, text: assistant.message,
    });
    expect(assistantFinal?.itemId).not.toBe(userFinal?.itemId);
    expect(assistantFinal?.eventId).not.toBe(userFinal?.eventId);
    expect(mapper.map(assistant)).toBeNull();

    // Exercise an interruption using the correction envelope and the same turn ID.
    const correction = {
      type: 'agent_response_correction',
      agent_response_correction_event: {
        original_agent_response: assistant.message,
        corrected_agent_response: 'The wizard vanished.',
        event_id: 88,
      },
    };
    const corrected = mapper.map(correction);
    expect(corrected).toMatchObject({
      type: 'voice.transcript.corrected',
      epoch: 1,
      sequence: 3,
      revision: 2,
      itemId: assistantFinal?.itemId,
      role: 'assistant',
      text: 'The wizard vanished.',
    });
    expect(corrected?.eventId).not.toBe(assistantFinal?.eventId);
    expect(mapper.map(correction)).toBeNull();
    expect(mapper.map(user)).toBeNull();
  });

  it('refuses a provider identity too long to become a canonical transcript identity', () => {
    const mapper = createElevenLabsEventMapper();
    mapper.beginConversation();

    // Exercise the longer role at the accepted provider-ID bound.
    expect(mapper.map({
      event_id: 'e'.repeat(300),
      role: 'agent',
      source: 'ai',
      message: 'hello',
    })).toBeNull();

    const longest = mapper.map({
      event_id: 'e'.repeat(200),
      role: 'agent',
      source: 'ai',
      message: 'hello',
    });
    expect(longest).not.toBeNull();
    expect(VoiceTranscriptCanonicalEventV1Schema.safeParse(longest).success).toBe(true);
  });

  it('keeps the idle reply on a shared event ID without publishing the silence placeholder', () => {
    const mapper = createElevenLabsEventMapper();
    mapper.beginConversation();

    // P3 wire capture (idle turn).
    expect(mapper.map({ event_id: 151, role: 'user', source: 'user', message: '...' })).toBeNull();
    const idleReply = { event_id: 151, role: 'agent', source: 'ai', message: 'Are you still there?' };
    expect(mapper.map(idleReply)).toMatchObject({
      type: 'voice.transcript.final', role: 'assistant', sequence: 1, revision: 1, text: idleReply.message,
    });
    expect(mapper.map(idleReply)).toBeNull();
  });

  it('starts a fresh epoch for a replacement conversation', () => {
    const mapper = createElevenLabsEventMapper();
    mapper.beginConversation();
    mapper.map({ event_id: 1, role: 'user', source: 'user', message: 'first' });
    mapper.beginConversation();
    expect(mapper.map({ event_id: 1, role: 'user', source: 'user', message: 'second' })).toEqual(
      expect.objectContaining({ epoch: 2, sequence: 1, revision: 1 }),
    );
  });
});

import { describe, expect, it } from 'vitest';

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
      eventId: 'elevenlabs:message:17:1',
      itemId: 'elevenlabs:message:17',
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

  it('maps a changed replay of the same provider item as a typed correction and drops exact duplicates', () => {
    const mapper = createElevenLabsEventMapper();
    mapper.beginConversation();
    const first = { event_id: 9, role: 'agent', source: 'ai', message: 'old answer' };
    expect(mapper.map(first)?.type).toBe('voice.transcript.final');
    expect(mapper.map(first)).toBeNull();

    expect(mapper.map({ ...first, message: 'corrected answer' })).toEqual(expect.objectContaining({
      type: 'voice.transcript.corrected',
      epoch: 1,
      sequence: 2,
      revision: 2,
      eventId: 'elevenlabs:message:9:2',
      itemId: 'elevenlabs:message:9',
      role: 'assistant',
      text: 'corrected answer',
    }));
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

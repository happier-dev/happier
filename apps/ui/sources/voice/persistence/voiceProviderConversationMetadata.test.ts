import { describe, expect, it } from 'vitest';

import {
  readVoiceProviderConversationMetadata,
  writeVoiceProviderConversationMetadata,
} from './voiceProviderConversationMetadata';

describe('voice provider conversation metadata', () => {
  it('round-trips a canonical qualified external provider identity', () => {
    const providerId = 'acme.synthetic-voice/conversation';
    const metadata = writeVoiceProviderConversationMetadata(
      { retained: true },
      { providerId, state: { conversationId: 'external-conversation-1' }, updatedAt: 15 },
    );

    expect(metadata).toMatchObject({
      retained: true,
      voiceProviderConversationsV1: {
        v: 1,
        providers: {
          [providerId]: {
            conversationId: 'external-conversation-1',
            updatedAt: 15,
          },
        },
      },
    });
    expect(readVoiceProviderConversationMetadata(metadata, providerId)).toEqual({
      conversationId: 'external-conversation-1',
      updatedAt: 15,
    });
  });

  it('round-trips provider-owned resumable identity without overwriting siblings', () => {
    const first = writeVoiceProviderConversationMetadata(
      { retained: true },
      { providerId: 'realtime_grok', state: { conversationId: 'conversation-1' }, updatedAt: 10 },
    );
    const second = writeVoiceProviderConversationMetadata(
      first,
      { providerId: 'realtime_other', state: { conversationId: 'conversation-2' }, updatedAt: 20 },
    );

    expect(readVoiceProviderConversationMetadata(second, 'realtime_grok')).toEqual({
      conversationId: 'conversation-1',
      updatedAt: 10,
    });
    expect(second).toMatchObject({ retained: true });
  });

  it('clears only the requested provider and removes an empty envelope', () => {
    const metadata = {
      retained: true,
      voiceProviderConversationsV1: {
        v: 1,
        providers: {
          realtime_grok: { conversationId: 'conversation-1', updatedAt: 10 },
          realtime_other: { conversationId: 'conversation-2', updatedAt: 20 },
        },
      },
    };

    const oneLeft = writeVoiceProviderConversationMetadata(metadata, {
      providerId: 'realtime_grok', state: null, updatedAt: 30,
    });
    expect(readVoiceProviderConversationMetadata(oneLeft, 'realtime_grok')).toBeNull();
    expect(readVoiceProviderConversationMetadata(oneLeft, 'realtime_other')?.conversationId).toBe('conversation-2');

    const empty = writeVoiceProviderConversationMetadata(oneLeft, {
      providerId: 'realtime_other', state: null, updatedAt: 40,
    });
    expect(empty).toEqual({ retained: true });
  });

  it('fails closed for unsafe provider keys and malformed persisted identities', () => {
    const oversizedProviderId = `acme.synthetic-voice/${'a'.repeat(256)}`;

    expect(() => writeVoiceProviderConversationMetadata({}, {
      providerId: '__proto__', state: { conversationId: 'conversation-1' }, updatedAt: 10,
    })).toThrow('invalid_voice_provider_id');
    expect(() => writeVoiceProviderConversationMetadata({}, {
      providerId: 'acme.synthetic-voice/', state: { conversationId: 'conversation-1' }, updatedAt: 10,
    })).toThrow('invalid_voice_provider_id');
    expect(() => writeVoiceProviderConversationMetadata({}, {
      providerId: oversizedProviderId, state: { conversationId: 'conversation-1' }, updatedAt: 10,
    })).toThrow('invalid_voice_provider_id');
    expect(readVoiceProviderConversationMetadata({
      voiceProviderConversationsV1: {
        v: 1,
        providers: {
          realtime_grok: { conversationId: '', updatedAt: 10 },
          'acme.synthetic-voice/': { conversationId: 'malformed', updatedAt: 10 },
          [oversizedProviderId]: { conversationId: 'oversized', updatedAt: 10 },
        },
      },
    }, 'realtime_grok')).toBeNull();
    expect(readVoiceProviderConversationMetadata({
      voiceProviderConversationsV1: {
        v: 1,
        providers: {
          'acme.synthetic-voice/': { conversationId: 'malformed', updatedAt: 10 },
          [oversizedProviderId]: { conversationId: 'oversized', updatedAt: 10 },
        },
      },
    }, 'acme.synthetic-voice/')).toBeNull();
    expect(readVoiceProviderConversationMetadata({
      voiceProviderConversationsV1: {
        v: 1,
        providers: {
          [oversizedProviderId]: { conversationId: 'oversized', updatedAt: 10 },
        },
      },
    }, oversizedProviderId)).toBeNull();
  });
});

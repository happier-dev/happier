import { describe, expect, it } from 'vitest';

import {
  AGENT_THREAD_TEXT_CONVERSATION_TURN_ORIGIN_V1,
  ConversationTurnOriginV1Schema,
  REALTIME_CONVERSATION_VOICE_TURN_ORIGIN_V1,
  readConversationTurnOriginV1FromMessageMeta,
} from '../../index.js';

describe('ConversationTurnOriginV1', () => {
  it('accepts the two canonical interaction origins and rejects mixed channel/modality shapes', () => {
    expect(ConversationTurnOriginV1Schema.parse({
      ...REALTIME_CONVERSATION_VOICE_TURN_ORIGIN_V1,
      source: {
        pluginId: 'happier.codex',
        contributionId: 'realtime-codex',
      },
    })).toEqual({
      v: 1,
      channel: 'realtime_conversation',
      modality: 'voice',
      source: {
        pluginId: 'happier.codex',
        contributionId: 'realtime-codex',
      },
    });
    expect(ConversationTurnOriginV1Schema.parse(
      AGENT_THREAD_TEXT_CONVERSATION_TURN_ORIGIN_V1,
    )).toEqual({
      v: 1,
      channel: 'agent_thread',
      modality: 'text',
    });
    expect(ConversationTurnOriginV1Schema.safeParse({
      v: 1,
      channel: 'agent_thread',
      modality: 'voice',
    }).success).toBe(false);
  });

  it('defaults an absent field to legacy Agent/text while rejecting a malformed explicit field', () => {
    expect(readConversationTurnOriginV1FromMessageMeta(undefined)).toEqual(
      AGENT_THREAD_TEXT_CONVERSATION_TURN_ORIGIN_V1,
    );
    expect(readConversationTurnOriginV1FromMessageMeta({
      happier: {
        kind: 'conversation_turn.v1',
        payload: { v: 1 },
        conversationTurnOriginV1: REALTIME_CONVERSATION_VOICE_TURN_ORIGIN_V1,
      },
    })).toEqual(REALTIME_CONVERSATION_VOICE_TURN_ORIGIN_V1);
    expect(readConversationTurnOriginV1FromMessageMeta({
      happier: {
        kind: 'conversation_turn.v1',
        payload: { v: 1 },
        conversationTurnOriginV1: {
          v: 1,
          channel: 'realtime_conversation',
          modality: 'text',
        },
      },
    })).toBeNull();
  });

  it.each([
    ['happier.voice.elevenlabs', 'realtime_elevenlabs'],
    ['happier.voice.google', 'google_gemini'],
    ['happier.voice.google', 'google_cloud'],
  ] as const)(
    'rejects legacy Voice source %s/%s in stored provenance',
    (pluginId, contributionId) => {
      const historicalOrigin = {
        v: 1,
        channel: 'realtime_conversation',
        modality: 'voice',
        source: { pluginId, contributionId },
      } as const;

      expect(readConversationTurnOriginV1FromMessageMeta({
        happier: {
          kind: 'conversation_turn.v1',
          payload: { v: 1 },
          conversationTurnOriginV1: historicalOrigin,
        },
      })).toBeNull();
    },
  );

  it('passes canonical and unknown valid identities through while rejecting unowned predecessor ids', () => {
    const readSource = (source: Readonly<{ pluginId: string; contributionId: string }>) =>
      readConversationTurnOriginV1FromMessageMeta({
        happier: {
          kind: 'conversation_turn.v1',
          payload: { v: 1 },
          conversationTurnOriginV1: {
            v: 1,
            channel: 'realtime_conversation',
            modality: 'voice',
            source,
          },
        },
      })?.source;

    expect(readSource({
      pluginId: 'happier.voice.openai',
      contributionId: 'realtime-openai',
    })).toEqual({
      pluginId: 'happier.voice.openai',
      contributionId: 'realtime-openai',
    });
    expect(readSource({
      pluginId: 'acme.voice',
      contributionId: 'unknown-conversation',
    })).toEqual({
      pluginId: 'acme.voice',
      contributionId: 'unknown-conversation',
    });
    expect(readSource({
      pluginId: 'acme.voice',
      contributionId: 'unqualified_source',
    })).toBeUndefined();
    expect(readSource({
      pluginId: 'happier.agent.openai-compat',
      contributionId: 'openai_compat',
    })).toBeUndefined();
  });

  it('does not apply Voice predecessor normalization to Agent-thread provenance', () => {
    expect(readConversationTurnOriginV1FromMessageMeta({
      happier: {
        kind: 'conversation_turn.v1',
        payload: { v: 1 },
        conversationTurnOriginV1: {
          v: 1,
          channel: 'agent_thread',
          modality: 'text',
          source: {
            pluginId: 'happier.agent.codex',
            contributionId: 'realtime_codex',
          },
        },
      },
    })).toBeNull();
  });
});

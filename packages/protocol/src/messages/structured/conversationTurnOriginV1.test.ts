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
});

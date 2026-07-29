import { describe, expect, it } from 'vitest';

import { extractSemanticTranscriptItemFromDecryptedPayload } from './extractSemanticTranscriptItem';

describe('extractSemanticTranscriptItemFromDecryptedPayload', () => {
  it('decodes current native ACP text rows without treating the type discriminator as text', () => {
    const result = extractSemanticTranscriptItemFromDecryptedPayload({
      index: 0,
      row: {
        id: 'row-native-text',
        createdAt: 1,
        messageRole: 'unknown',
      },
      options: {
        mode: 'transcript',
        transcriptRoles: ['assistant'],
      },
      decrypted: {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'agent',
          data: {
            type: 'text',
            text: 'CODEX_LUNA_LOW_READY',
          },
        },
      },
    });

    expect(result.item).toMatchObject({
      id: 'row-native-text',
      role: 'assistant',
      semanticRole: 'assistant',
      kind: 'assistant_message',
      provider: 'agent',
      text: 'CODEX_LUNA_LOW_READY',
    });
  });

  it('honors user text roles and rejects system text from semantic transcript output', () => {
    const extract = (role: string) => extractSemanticTranscriptItemFromDecryptedPayload({
      index: 0,
      row: {
        id: `row-${role}`,
        createdAt: 1,
        messageRole: 'unknown',
      },
      options: {
        mode: 'transcript',
        transcriptRoles: ['user', 'assistant'],
      },
      decrypted: {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'agent',
          data: {
            type: 'text',
            role,
            text: `${role} text`,
          },
        },
      },
    });

    expect(extract('user').item).toMatchObject({
      role: 'user',
      semanticRole: 'user',
      kind: 'user_message',
      text: 'user text',
    });
    expect(extract('system').item).toBeNull();
  });

  it('rejects malformed ACP text bodies without inventing visible text', () => {
    const result = extractSemanticTranscriptItemFromDecryptedPayload({
      index: 0,
      row: {
        id: 'row-malformed-text',
        createdAt: 1,
        messageRole: 'unknown',
      },
      options: {
        mode: 'transcript',
        transcriptRoles: ['user', 'assistant'],
      },
      decrypted: {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'agent',
          data: {
            type: 'text',
            text: { unexpected: 'value' },
          },
        },
      },
    });

    expect(result.item).toBeNull();
  });

  it('keeps the released ACP provider/message storage shape readable', () => {
    const result = extractSemanticTranscriptItemFromDecryptedPayload({
      index: 0,
      row: {
        id: 'row-released-message',
        createdAt: 1,
        messageRole: 'agent',
      },
      options: {
        mode: 'transcript',
        transcriptRoles: ['assistant'],
      },
      decrypted: {
        role: 'agent',
        content: {
          type: 'acp',
          provider: 'opencode',
          data: {
            type: 'message',
            message: 'released provider text',
          },
        },
      },
    });

    expect(result.item).toMatchObject({
      role: 'assistant',
      semanticRole: 'assistant',
      kind: 'assistant_message',
      provider: 'opencode',
      text: 'released provider text',
    });
  });

  it('extracts assistant text from agent_message body rows', () => {
    const result = extractSemanticTranscriptItemFromDecryptedPayload({
      index: 0,
      row: {
        id: 'row-1',
        createdAt: 1,
        messageRole: 'agent',
      },
      options: {
        mode: 'transcript',
        transcriptRoles: ['assistant'],
      },
      decrypted: {
        role: 'agent',
        content: {
          type: 'codex',
          data: {
            type: 'agent_message',
            text: 'codex semantic text',
          },
        },
      },
    });

    expect(result.item).toMatchObject({
      id: 'row-1',
      role: 'assistant',
      semanticRole: 'assistant',
      kind: 'assistant_message',
      provider: 'codex',
      text: 'codex semantic text',
    });
  });

  it('preserves Codex agent_message user-role overrides from nested body rows', () => {
    const result = extractSemanticTranscriptItemFromDecryptedPayload({
      index: 0,
      row: {
        id: 'row-user',
        createdAt: 1,
        messageRole: 'agent',
      },
      options: {
        mode: 'transcript',
        transcriptRoles: ['user', 'assistant'],
      },
      decrypted: {
        role: 'agent',
        content: {
          type: 'codex',
          data: {
            type: 'agent_message',
            role: 'user',
            text: 'codex nested user text',
          },
        },
      },
    });

    expect(result.item).toMatchObject({
      id: 'row-user',
      role: 'user',
      semanticRole: 'user',
      kind: 'user_message',
      provider: 'codex',
      text: 'codex nested user text',
    });
  });

  it('exposes explicit realtime provenance while defaulting released rows to Agent text', () => {
    const extract = (meta: unknown) => extractSemanticTranscriptItemFromDecryptedPayload({
      index: 0,
      row: {
        id: 'row-provenance',
        createdAt: 1,
        messageRole: 'user',
      },
      options: {
        mode: 'transcript',
        transcriptRoles: ['user'],
      },
      decrypted: {
        role: 'user',
        content: {
          type: 'text',
          text: 'semantic text',
        },
        meta,
      },
    });

    expect(extract(undefined).item?.origin).toEqual({
      v: 1,
      channel: 'agent_thread',
      modality: 'text',
    });
    expect(extract({
      happier: {
        kind: 'conversation_turn.v1',
        payload: { v: 1 },
        conversationTurnOriginV1: {
          v: 1,
          channel: 'realtime_conversation',
          modality: 'voice',
        },
      },
    }).item?.origin).toEqual({
      v: 1,
      channel: 'realtime_conversation',
      modality: 'voice',
    });
  });
});

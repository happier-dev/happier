import { describe, expect, it } from 'vitest';

import { extractSemanticTranscriptItemFromDecryptedPayload } from './extractSemanticTranscriptItem';

describe('extractSemanticTranscriptItemFromDecryptedPayload', () => {
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
});

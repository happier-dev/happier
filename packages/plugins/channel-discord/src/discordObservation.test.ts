import { describe, expect, it } from 'vitest';

import { ConversationNormalizedIngressV1Schema } from '@happier-dev/channels-protocol/v1';

import { parseDiscordMessageDispatch } from './discordMessage.js';
import { mapDiscordMessageToSocketIngress } from './discordObservation.js';

const context = {
  botUserId: 'bot-1',
  applicationId: 'application-1',
  botRoleIds: [],
  messageContentIntentEnabled: true,
} as const;

function message(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: 'message-1',
    timestamp: '2024-01-02T03:04:05.000Z',
    content: 'hello',
    type: 0,
    author: { id: 'user-1', bot: false },
    ...overrides,
  };
}

describe('Discord Gateway observation mapping', () => {
  it('maps an admitted Discord message into strict full-text socket ingress without turning receive progress into a core checkpoint', () => {
    const parsed = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({ mentions: [{ id: 'bot-1' }] }),
      channel: { kind: 'thread', channelId: 'thread-1', parentChannelId: 'channel-1' },
      context,
    });
    const ingress = mapDiscordMessageToSocketIngress({ parsed });

    expect(ingress).toEqual({
      kind: 'fullText',
      observation: {
        v: 1,
        occurrenceId: 'discord:message:message-1',
        occurredAt: Date.parse('2024-01-02T03:04:05.000Z'),
        transport: { kind: 'socket' },
        endpoint: {
          kind: 'thread',
          audience: 'shared',
          id: 'discord:channel:thread-1',
          parentId: 'discord:channel:channel-1',
        },
        actor: {
          principalId: 'discord:user:user-1',
          kind: 'human',
          isIntegrationSelf: false,
        },
        message: {
          id: 'message-1',
          text: 'hello',
          addressingEvidence: 'directIntegrationMention',
          contentProvenance: 'original',
          providerTimestamp: Date.parse('2024-01-02T03:04:05.000Z'),
        },
      },
    });
    expect(ingress).not.toHaveProperty('checkpointTransition');
    expect(ConversationNormalizedIngressV1Schema.parse(ingress)).toEqual(ingress);
  });

  it('keeps non-ingress Discord events out of the core observation action', () => {
    const parsed = parseDiscordMessageDispatch({
      event: 'MESSAGE_DELETE',
      payload: message(),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context,
    });

    expect(mapDiscordMessageToSocketIngress({ parsed })).toBeNull();
  });

  it('maps authenticated unsupported Discord content to a bodyless socket refusal', () => {
    const parsed = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({
        content: 'private attachment caption',
        attachments: [{ id: 'attachment-1' }],
        mentions: [{ id: 'bot-1' }],
      }),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context,
    });
    const ingress = mapDiscordMessageToSocketIngress({ parsed });

    expect(ingress).toMatchObject({
      kind: 'routableNonAdmission',
      reason: 'unsupportedContent',
      shell: {
        occurrenceId: 'discord:message:message-1',
        transport: { kind: 'socket' },
        endpoint: { id: 'discord:channel:channel-1' },
        message: { id: 'message-1', addressingEvidence: 'directIntegrationMention' },
      },
    });
    expect(ingress).not.toHaveProperty('shell.streamKey');
    expect(ingress).not.toHaveProperty('shell.message.text');
    expect(ConversationNormalizedIngressV1Schema.parse(ingress)).toEqual(ingress);
  });

  it('retains an unsupported edit revision in the strict bodyless socket refusal', () => {
    const parsed = parseDiscordMessageDispatch({
      event: 'MESSAGE_UPDATE',
      payload: message({
        edited_timestamp: '2024-01-02T03:05:05.000Z',
        referenced_message: { author: { id: 'bot-1' } },
        message_reference: { message_id: 'bot-message-1' },
        type: 19,
      }),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context,
    });
    const ingress = mapDiscordMessageToSocketIngress({ parsed });

    expect(ingress).toMatchObject({
      kind: 'routableNonAdmission',
      reason: 'unsupportedEdit',
      shell: {
        message: {
          id: 'message-1',
          revision: '2024-01-02T03:05:05.000Z',
          addressingEvidence: 'replyToIntegration',
          replyToMessageId: 'bot-message-1',
        },
      },
    });
    expect(ConversationNormalizedIngressV1Schema.parse(ingress)).toEqual(ingress);
  });
});

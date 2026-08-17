import { describe, expect, it } from 'vitest';

import { MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES } from '@happier-dev/channels-protocol/v1';

import { parseDiscordMessageDispatch } from './discordMessage.js';

const context = {
  botUserId: 'bot-1',
  applicationId: 'application-1',
  botRoleIds: ['role-1'],
  messageContentIntentEnabled: true,
} as const;

function message(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: 'message-1',
    timestamp: '2024-01-02T03:04:05.000Z',
    content: 'hello',
    type: 0,
    author: { id: 'user-1', username: 'Ada', bot: false },
    ...overrides,
  };
}

describe('Discord message parser', () => {
  it('uses immutable message/webhook identity so overlap sessions produce one occurrence without trusting display names', () => {
    const payload = message({
      author: { id: 'displayed-user-1', username: 'Happier Bot', bot: false },
      webhook_id: 'webhook-1',
    });
    const input = {
      event: 'MESSAGE_CREATE' as const,
      payload,
      channel: { kind: 'shared' as const, channelId: 'channel-1' },
      context,
    };

    const first = parseDiscordMessageDispatch(input);
    const overlap = parseDiscordMessageDispatch(input);
    expect(first).toMatchObject({
      kind: 'message',
      occurrenceId: 'discord:message:message-1',
      endpoint: { kind: 'shared', audience: 'shared', id: 'discord:channel:channel-1' },
      actor: {
        principalId: 'discord:webhook:webhook-1',
        kind: 'integration',
        isIntegrationSelf: false,
      },
      message: { addressingEvidence: 'none' },
    });
    expect(overlap).toMatchObject({ kind: 'message', occurrenceId: 'discord:message:message-1' });
  });

  it('keeps DMs available without Message Content but limits shared no-intent traffic to direct bot mentions', () => {
    const noContentIntent = { ...context, messageContentIntentEnabled: false };
    const dm = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message(),
      channel: { kind: 'direct', channelId: 'dm-1' },
      context: noContentIntent,
    });
    const directMention = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({ mentions: [{ id: 'bot-1' }] }),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context: noContentIntent,
    });
    const roleMention = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({ mention_roles: ['role-1'] }),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context: noContentIntent,
    });

    expect(dm).toMatchObject({
      kind: 'message',
      endpoint: { audience: 'direct' },
      message: { addressingEvidence: 'none' },
    });
    expect(directMention).toMatchObject({
      kind: 'message',
      endpoint: { audience: 'shared' },
      message: { addressingEvidence: 'directIntegrationMention' },
    });
    expect(roleMention).toMatchObject({
      kind: 'routableNonAdmission',
      reason: 'unsupportedContent',
      endpoint: { audience: 'shared' },
      message: { addressingEvidence: 'integrationRoleMention' },
    });
  });

  it('preserves thread parent identity and recognizes role/reply addressing only with immutable evidence', () => {
    const roleMention = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({ mention_roles: ['role-1'] }),
      channel: { kind: 'thread', channelId: 'thread-1', parentChannelId: 'parent-1' },
      context,
    });
    const reply = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({
        type: 19,
        message_reference: { message_id: 'bot-message-1' },
        referenced_message: { author: { id: 'bot-1', bot: true } },
      }),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context,
    });

    expect(roleMention).toMatchObject({
      kind: 'message',
      endpoint: {
        kind: 'thread',
        audience: 'shared',
        id: 'discord:channel:thread-1',
        parentId: 'discord:channel:parent-1',
      },
      message: { addressingEvidence: 'integrationRoleMention' },
    });
    expect(reply).toMatchObject({
      kind: 'message',
      message: {
        addressingEvidence: 'replyToIntegration',
        replyToMessageId: 'bot-message-1',
      },
    });
  });

  it('requires actual Discord reply semantics before retaining reply correlation or treating a referenced bot message as integration-addressed', () => {
    const notAReply = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({
        type: 0,
        message_reference: { message_id: 'bot-message-1' },
        referenced_message: { author: { id: 'bot-1', bot: true } },
      }),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context,
    });

    expect(notAReply).toMatchObject({
      kind: 'message',
      message: { addressingEvidence: 'none' },
    });
    expect(notAReply).not.toHaveProperty('message.replyToMessageId');
  });

  it('retains a genuine reply correlation without upgrading a human reply into integration evidence', () => {
    const replyToHuman = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({
        type: 19,
        message_reference: { message_id: 'human-message-1' },
        referenced_message: { author: { id: 'user-2', bot: false } },
      }),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context,
    });

    expect(replyToHuman).toMatchObject({
      kind: 'message',
      message: {
        addressingEvidence: 'none',
        replyToMessageId: 'human-message-1',
      },
    });
  });

  it('requires a reply message id before emitting reply-to-integration evidence', () => {
    const replyWithoutCorrelation = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({
        type: 19,
        message_reference: {},
        referenced_message: { application_id: 'application-1' },
      }),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context,
    });

    expect(replyWithoutCorrelation).toMatchObject({
      kind: 'message',
      message: { addressingEvidence: 'none' },
    });
    expect(replyWithoutCorrelation).not.toHaveProperty('message.replyToMessageId');
  });

  it('keeps only genuinely unroutable deletes out of ingress while preserving authenticated bodyless refusals', () => {
    expect(parseDiscordMessageDispatch({
      event: 'MESSAGE_UPDATE',
      payload: message({ edited_timestamp: '2024-01-02T03:05:05.000Z' }),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context,
    })).toMatchObject({
      kind: 'routableNonAdmission',
      reason: 'unsupportedEdit',
      occurrenceId: 'discord:message:message-1:edit:2024-01-02T03:05:05.000Z',
      message: { id: 'message-1', revision: '2024-01-02T03:05:05.000Z' },
    });
    expect(parseDiscordMessageDispatch({
      event: 'MESSAGE_DELETE',
      payload: message(),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context,
    })).toEqual({ kind: 'notIngress', reason: 'delete' });
    expect(parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({ type: 7 }),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context,
    })).toMatchObject({ kind: 'routableNonAdmission', reason: 'unsupportedContent' });
    expect(parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({ content: '', attachments: [{ id: 'attachment-1' }] }),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context,
    })).toMatchObject({ kind: 'routableNonAdmission', reason: 'unsupportedContent' });
  });

  it('withholds a text body that exceeds the public ingress bound while retaining its authenticated routing shell', () => {
    const parsed = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({ content: 'x'.repeat(MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES + 1) }),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context,
    });

    expect(parsed).toMatchObject({
      kind: 'routableNonAdmission',
      reason: 'messageTooLarge',
      occurrenceId: 'discord:message:message-1',
      endpoint: { id: 'discord:channel:channel-1' },
      message: { id: 'message-1' },
    });
    expect(parsed).not.toHaveProperty('message.text');
  });
});

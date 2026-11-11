import { describe, expect, it } from 'vitest';
import { createConversationAttachmentIdV1 } from '@happier-dev/channels-protocol/v1';

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
  it('retains the guild nickname as sender presentation without changing identity', () => {
    expect(parseDiscordMessageDispatch({ event: 'MESSAGE_CREATE', context,
      channel: { kind: 'shared', channelId: 'channel-1' },
      payload: message({ member: { nick: 'Countess Ada' }, author: { id: 'user-1', username: 'ada', global_name: 'Ada Lovelace' } }),
    })).toMatchObject({ actor: { principalId: 'discord:user:user-1', label: 'Countess Ada' } });
  });
  it.each(['caption', ''])('projects attachment metadata with content %j without retaining signed URLs', (content) => {
    const parsed = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({ content, attachments: [{
        id: 'file-1', filename: 'lead.pdf', size: 25_000_000,
        url: 'https://cdn.discordapp.com/attachments/channel-1/file-1/lead.pdf?ex=expired',
      }] }),
      channel: { kind: 'shared', channelId: 'channel-1' }, context,
    });
    expect(parsed).toMatchObject({ kind: 'message', message: { text: content, attachments: [{
      attachmentId: createConversationAttachmentIdV1('discord', ['channel-1', 'message-1', 'file-1']), name: 'lead.pdf',
      mediaType: 'application/octet-stream', byteLength: 25_000_000,
    }] } });
    expect(JSON.stringify(parsed)).not.toContain('https:');
  });

  it('ignores embeds accompanying native files while retaining the existing embed-only refusal', () => {
    const input = { event: 'MESSAGE_CREATE' as const, channel: { kind: 'shared' as const, channelId: 'channel-1' }, context };
    expect(parseDiscordMessageDispatch({ ...input, payload: message({ embeds: [{ title: 'preview' }] }) }))
      .toMatchObject({ kind: 'routableNonAdmission', reason: 'unsupportedContent' });
    expect(parseDiscordMessageDispatch({ ...input, payload: message({ embeds: [{ title: 'preview' }], attachments: [{
      id: 'file-1', filename: 'lead.pdf', size: 3,
      url: 'https://cdn.discordapp.com/attachments/channel-1/file-1/lead.pdf',
    }] }) })).toMatchObject({ kind: 'message', message: { text: 'hello', attachments: [{ name: 'lead.pdf' }] } });
  });

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

  it('decodes one forwarded snapshot body without trusting nested targeting or identity evidence', () => {
    const forwarded = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({
        content: 'outer transport shell',
        author: { id: 'outer-user', bot: false },
        message_reference: { type: 1, message_id: 'source-1', channel_id: 'source-channel' },
        message_snapshots: [{
          message: {
            type: 0,
            content: '/danger <@bot-1>',
            embeds: [],
            attachments: [],
            mentions: [{ id: 'bot-1' }],
            mention_roles: ['role-1'],
          },
        }],
      }),
      channel: { kind: 'shared', channelId: 'outer-channel' },
      context,
    });

    expect(forwarded).toMatchObject({
      kind: 'message',
      endpoint: { id: 'discord:channel:outer-channel' },
      actor: { principalId: 'discord:user:outer-user', kind: 'human' },
      message: {
        text: '/danger <@bot-1>',
        contentProvenance: 'forwarded',
        addressingEvidence: 'none',
      },
    });

    expect(parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({
        content: 'outer transport shell',
        author: { id: 'outer-user', bot: false },
        message_reference: { type: 1, message_id: 'source-1', channel_id: 'source-channel' },
        message_snapshots: [{
          message: {
            type: 0,
            content: '/danger <@bot-1>',
            embeds: [],
            attachments: [],
            mentions: [{ id: 'bot-1' }],
            mention_roles: ['role-1'],
          },
        }],
      }),
      channel: { kind: 'shared', channelId: 'outer-channel' },
      context: { ...context, messageContentIntentEnabled: false },
    })).toMatchObject({
      kind: 'routableNonAdmission',
      reason: 'unsupportedContent',
      message: { addressingEvidence: 'none', contentProvenance: 'forwarded' },
    });
  });

  it('rejects malformed, multiple, or media-bearing forwarded snapshots as unsupported content', () => {
    const cases = [
      { message_reference: { type: 1 }, message_snapshots: [] },
      {
        message_reference: { type: 1 },
        message_snapshots: [
          { message: { type: 0, content: 'one', embeds: [], attachments: [] } },
          { message: { type: 0, content: 'two', embeds: [], attachments: [] } },
        ],
      },
      {
        message_reference: { type: 1 },
        message_snapshots: [{ message: { type: 0, content: 'image', embeds: [{ title: 'unsupported' }], attachments: [] } }],
      },
      {
        message_reference: { type: 1 },
        message_snapshots: [{ message: { type: 0, content: 'file', embeds: [], attachments: [{ id: 'file-1' }] } }],
      },
      {
        message_reference: { type: 0 },
        message_snapshots: [{ message: { type: 0, content: 'not a forward', embeds: [], attachments: [] } }],
      },
    ];

    for (const forwardedFields of cases) {
      expect(parseDiscordMessageDispatch({
        event: 'MESSAGE_CREATE',
        payload: message(forwardedFields),
        channel: { kind: 'shared', channelId: 'channel-1' },
        context,
      })).toMatchObject({
        kind: 'routableNonAdmission',
        reason: 'unsupportedContent',
        message: { contentProvenance: 'forwarded' },
      });
    }
  });

  it('preserves authenticated bodyless refusals for unsupported messages', () => {
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

  it('preserves provider text beyond the former generic ingress ceiling', () => {
    const parsed = parseDiscordMessageDispatch({
      event: 'MESSAGE_CREATE',
      payload: message({ content: 'x'.repeat(65536 + 1) }),
      channel: { kind: 'shared', channelId: 'channel-1' },
      context,
    });

    expect(parsed).toMatchObject({
      kind: 'message',
      occurrenceId: 'discord:message:message-1',
      endpoint: { id: 'discord:channel:channel-1' },
      message: { id: 'message-1', text: 'x'.repeat(65536 + 1) },
    });
  });
});

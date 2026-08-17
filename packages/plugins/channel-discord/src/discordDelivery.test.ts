import { describe, expect, it } from 'vitest';
import { MAX_CONVERSATION_RETRY_AFTER_MS } from '@happier-dev/channels-protocol/v1';

import {
  DISCORD_MESSAGE_MAXIMUM_CODE_POINTS,
  DISCORD_MESSAGE_NONCE_MAXIMUM_CODE_POINTS,
  DISCORD_SUPPRESS_EMBEDS_FLAG,
  chunkDiscordMessage,
  classifyDiscordDeliveryResponse,
  createDiscordMessagePayloads,
} from './discordDelivery.js';

describe('Discord delivery adapter', () => {
  it('chunks at Discord’s content bound without splitting a Unicode code point and suppresses accidental mentions', async () => {
    const content = `${'a'.repeat(DISCORD_MESSAGE_MAXIMUM_CODE_POINTS - 1)}😀x`;

    expect(chunkDiscordMessage(content)).toEqual([
      `${'a'.repeat(DISCORD_MESSAGE_MAXIMUM_CODE_POINTS - 1)}😀`,
      'x',
    ]);
    expect(await createDiscordMessagePayloads({
      content,
      suppressEmbeds: true,
      replyToMessageId: 'upstream-1',
      noncePrefix: 'delivery-1',
    })).toEqual([
      {
        content: `${'a'.repeat(DISCORD_MESSAGE_MAXIMUM_CODE_POINTS - 1)}😀`,
        allowed_mentions: { parse: [] },
        flags: DISCORD_SUPPRESS_EMBEDS_FLAG,
        message_reference: { message_id: 'upstream-1', fail_if_not_exists: false },
        nonce: expect.any(String),
        enforce_nonce: true,
      },
      {
        content: 'x',
        allowed_mentions: { parse: [] },
        flags: DISCORD_SUPPRESS_EMBEDS_FLAG,
        message_reference: { message_id: 'upstream-1', fail_if_not_exists: false },
        nonce: expect.any(String),
        enforce_nonce: true,
      },
    ]);
  });

  it('uses an enforced bounded nonce for every nonblank delivery key', async () => {
    expect(await createDiscordMessagePayloads({
      content: 'A bounded message',
      suppressEmbeds: false,
      noncePrefix: 'delivery-1',
    })).toEqual([
      {
        content: 'A bounded message',
        allowed_mentions: { parse: [] },
        nonce: expect.any(String),
        enforce_nonce: true,
      },
    ]);

    expect(await createDiscordMessagePayloads({
      content: 'A bounded message',
      suppressEmbeds: false,
      noncePrefix: 'x'.repeat(23),
    })).toEqual([
      {
        content: 'A bounded message',
        allowed_mentions: { parse: [] },
        nonce: expect.any(String),
        enforce_nonce: true,
      },
    ]);

    expect(await createDiscordMessagePayloads({
      content: 'A bounded message',
      suppressEmbeds: false,
      noncePrefix: 'x'.repeat(24),
    })).toEqual([
      {
        content: 'A bounded message',
        allowed_mentions: { parse: [] },
        nonce: expect.any(String),
        enforce_nonce: true,
      },
    ]);
  });

  it('derives a bounded enforced nonce from the complete opaque delivery key for every chunk', async () => {
    const sharedPrefix = `channels:delivery:v1:${'a'.repeat(42)}`;
    const firstDeliveryKey = `${sharedPrefix}1`;
    const secondDeliveryKey = `${sharedPrefix}2`;
    expect(firstDeliveryKey).toHaveLength(64);

    const first = await createDiscordMessagePayloads({
      content: 'a'.repeat(DISCORD_MESSAGE_MAXIMUM_CODE_POINTS + 1),
      suppressEmbeds: false,
      noncePrefix: firstDeliveryKey,
    });
    const repeated = await createDiscordMessagePayloads({
      content: 'A bounded message',
      suppressEmbeds: false,
      noncePrefix: firstDeliveryKey,
    });
    const whitespaceDistinct = await createDiscordMessagePayloads({
      content: 'A bounded message',
      suppressEmbeds: false,
      noncePrefix: ` ${firstDeliveryKey}`,
    });
    const distinct = await createDiscordMessagePayloads({
      content: 'A bounded message',
      suppressEmbeds: false,
      noncePrefix: secondDeliveryKey,
    });

    const firstChunkNonce = first[0]?.nonce;
    const secondChunkNonce = first[1]?.nonce;
    const repeatedNonce = repeated[0]?.nonce;
    const whitespaceDistinctNonce = whitespaceDistinct[0]?.nonce;
    const distinctNonce = distinct[0]?.nonce;
    expect(first[0]?.enforce_nonce).toBe(true);
    expect(first[1]?.enforce_nonce).toBe(true);
    expect(firstChunkNonce).toEqual(expect.any(String));
    expect(secondChunkNonce).toEqual(expect.any(String));
    expect(repeatedNonce).toEqual(expect.any(String));
    expect(whitespaceDistinctNonce).toEqual(expect.any(String));
    expect(distinctNonce).toEqual(expect.any(String));
    if (
      typeof firstChunkNonce !== 'string'
      || typeof secondChunkNonce !== 'string'
      || typeof repeatedNonce !== 'string'
      || typeof whitespaceDistinctNonce !== 'string'
      || typeof distinctNonce !== 'string'
    ) {
      throw new Error('Expected every Discord delivery chunk to receive an enforced nonce.');
    }

    expect(Array.from(firstChunkNonce)).toHaveLength(DISCORD_MESSAGE_NONCE_MAXIMUM_CODE_POINTS);
    expect(Array.from(secondChunkNonce)).toHaveLength(DISCORD_MESSAGE_NONCE_MAXIMUM_CODE_POINTS);
    expect(firstChunkNonce).toBe(repeatedNonce);
    expect(firstChunkNonce).not.toBe(secondChunkNonce);
    expect(firstChunkNonce).not.toBe(whitespaceDistinctNonce);
    expect(firstChunkNonce).not.toBe(distinctNonce);
    expect(firstChunkNonce).not.toContain(firstDeliveryKey);
  });

  it('returns archive recovery only for Discord’s exact archived-thread evidence', () => {
    const archived = { status: 403, body: { code: 50_083, message: 'Thread is archived' } };

    expect(classifyDiscordDeliveryResponse({ ...archived, canManageThreads: false })).toEqual({
      kind: 'endpointArchived',
      recovery: 'ownerMustUnarchiveOrRebind',
    });
    expect(classifyDiscordDeliveryResponse({ ...archived, canManageThreads: true })).toEqual({
      kind: 'endpointArchived',
      recovery: 'unarchiveAndRetry',
    });

    expect(classifyDiscordDeliveryResponse({
      status: 403,
      body: { code: 50_013, message: 'Missing Permissions' },
      canManageThreads: true,
    })).toEqual({
      kind: 'notSent',
      retry: 'never',
      diagnostic: 'Missing Permissions',
    });
    expect(classifyDiscordDeliveryResponse({
      status: 403,
      body: { code: 42, message: 'Thread is archived' },
      canManageThreads: true,
    })).toEqual({
      kind: 'notSent',
      retry: 'never',
      diagnostic: 'Thread is archived',
    });
    expect(classifyDiscordDeliveryResponse({
      status: 429,
      body: { code: 50_083, retry_after: 2.5, message: 'You are being rate limited.' },
      canManageThreads: true,
    })).toEqual({
      kind: 'notSent',
      retry: 'after',
      retryAfterMs: 2_500,
      diagnostic: 'You are being rate limited.',
    });
    expect(classifyDiscordDeliveryResponse({
      status: 0,
      body: { code: 50_083, message: 'Thread is archived' },
      canManageThreads: true,
    })).toEqual({ kind: 'outcomeUnknown' });
    expect(classifyDiscordDeliveryResponse({
      status: 503,
      body: { code: 50_083, message: 'Thread is archived' },
      canManageThreads: true,
    })).toEqual({ kind: 'outcomeUnknown' });
  });

  it('accepts a successful direct send even when Discord auto-unarchives and classifies rate-limits and ambiguity truthfully', () => {
    expect(classifyDiscordDeliveryResponse({
      status: 200,
      body: { id: 'message-1', channel_id: 'thread-1' },
      canManageThreads: false,
    })).toEqual({ kind: 'sent', messageId: 'message-1', channelId: 'thread-1' });
    expect(classifyDiscordDeliveryResponse({
      status: 429,
      body: { retry_after: 2.5, message: 'You are being rate limited.' },
      canManageThreads: false,
    })).toEqual({
      kind: 'notSent',
      retry: 'after',
      retryAfterMs: 2_500,
      diagnostic: 'You are being rate limited.',
    });
    expect(classifyDiscordDeliveryResponse({
      status: 429,
      body: { retry_after: (MAX_CONVERSATION_RETRY_AFTER_MS / 1_000) + 1 },
      canManageThreads: false,
    })).toEqual({
      kind: 'notSent',
      retry: 'after',
      retryAfterMs: MAX_CONVERSATION_RETRY_AFTER_MS,
    });
    expect(classifyDiscordDeliveryResponse({
      status: 0,
      body: null,
      canManageThreads: false,
    })).toEqual({ kind: 'outcomeUnknown' });
  });
});

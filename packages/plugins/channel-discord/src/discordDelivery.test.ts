import { describe, expect, it } from 'vitest';

import {
  DISCORD_MESSAGE_MAXIMUM_CODE_POINTS,
  DISCORD_MESSAGE_NONCE_MAXIMUM_CODE_POINTS,
  DISCORD_SUPPRESS_EMBEDS_FLAG,
  classifyDiscordDeliveryResponse,
  createDiscordMessagePayload,
} from './discordDelivery.js';

describe('Discord delivery adapter', () => {
  it('composes one native message without changing core content or enabling accidental mentions', async () => {
    const content = `${'a'.repeat(DISCORD_MESSAGE_MAXIMUM_CODE_POINTS - 1)}😀`;
    expect(await createDiscordMessagePayload({
      content,
      suppressEmbeds: true,
      replyToMessageId: 'upstream-1',
      deliveryKey: 'delivery-1',
    })).toEqual({
      content,
      allowed_mentions: { parse: [] },
      flags: DISCORD_SUPPRESS_EMBEDS_FLAG,
      message_reference: { message_id: 'upstream-1', fail_if_not_exists: false },
      nonce: expect.any(String),
      enforce_nonce: true,
    });
  });

  it('uses an enforced bounded nonce for every nonblank delivery key', async () => {
    expect(await createDiscordMessagePayload({
      content: 'A bounded message',
      suppressEmbeds: false,
      deliveryKey: 'delivery-1',
    })).toEqual({
      content: 'A bounded message',
      allowed_mentions: { parse: [] },
      nonce: expect.any(String),
      enforce_nonce: true,
    });

    expect(await createDiscordMessagePayload({
      content: 'A bounded message',
      suppressEmbeds: false,
      deliveryKey: 'x'.repeat(23),
    })).toEqual({
      content: 'A bounded message',
      allowed_mentions: { parse: [] },
      nonce: expect.any(String),
      enforce_nonce: true,
    });

    expect(await createDiscordMessagePayload({
      content: 'A bounded message',
      suppressEmbeds: false,
      deliveryKey: 'x'.repeat(24),
    })).toEqual({
      content: 'A bounded message',
      allowed_mentions: { parse: [] },
      nonce: expect.any(String),
      enforce_nonce: true,
    });
  });

  it('derives a bounded enforced nonce from each complete opaque core delivery key', async () => {
    const sharedPrefix = `channels:delivery:v1:${'a'.repeat(42)}`;
    const firstDeliveryKey = `${sharedPrefix}1`;
    const secondDeliveryKey = `${sharedPrefix}2`;
    expect(firstDeliveryKey).toHaveLength(64);

    const first = await createDiscordMessagePayload({
      content: 'A bounded message',
      suppressEmbeds: false,
      deliveryKey: firstDeliveryKey,
    });
    const repeated = await createDiscordMessagePayload({
      content: 'A bounded message',
      suppressEmbeds: false,
      deliveryKey: firstDeliveryKey,
    });
    const whitespaceDistinct = await createDiscordMessagePayload({
      content: 'A bounded message',
      suppressEmbeds: false,
      deliveryKey: ` ${firstDeliveryKey}`,
    });
    const distinct = await createDiscordMessagePayload({
      content: 'A bounded message',
      suppressEmbeds: false,
      deliveryKey: secondDeliveryKey,
    });

    const firstNonce = first.nonce;
    const repeatedNonce = repeated.nonce;
    const whitespaceDistinctNonce = whitespaceDistinct.nonce;
    const distinctNonce = distinct.nonce;
    expect(first.enforce_nonce).toBe(true);
    expect(firstNonce).toEqual(expect.any(String));
    expect(repeatedNonce).toEqual(expect.any(String));
    expect(whitespaceDistinctNonce).toEqual(expect.any(String));
    expect(distinctNonce).toEqual(expect.any(String));
    if (
      typeof firstNonce !== 'string'
      || typeof repeatedNonce !== 'string'
      || typeof whitespaceDistinctNonce !== 'string'
      || typeof distinctNonce !== 'string'
    ) {
      throw new Error('Expected every Discord delivery to receive an enforced nonce.');
    }

    expect(Array.from(firstNonce)).toHaveLength(DISCORD_MESSAGE_NONCE_MAXIMUM_CODE_POINTS);
    expect(firstNonce).toBe(repeatedNonce);
    expect(firstNonce).not.toBe(whitespaceDistinctNonce);
    expect(firstNonce).not.toBe(distinctNonce);
    expect(firstNonce).not.toContain(firstDeliveryKey);
  });

  it('returns archive recovery only for Discord’s exact archived-thread evidence', () => {
    const archived = { status: 403, body: { code: 50_083, message: 'Thread is archived' } };

    expect(classifyDiscordDeliveryResponse({ ...archived })).toEqual({
      kind: 'endpointArchived',
      recovery: 'ownerMustUnarchiveOrRebind',
    });

    expect(classifyDiscordDeliveryResponse({
      status: 403,
      body: { code: 50_013, message: 'Missing Permissions' },
    })).toEqual({
      kind: 'notSent',
      retry: 'never',
      diagnostic: 'Missing Permissions',
    });
    expect(classifyDiscordDeliveryResponse({
      status: 403,
      body: { code: 42, message: 'Thread is archived' },
    })).toEqual({
      kind: 'notSent',
      retry: 'never',
      diagnostic: 'Thread is archived',
    });
    expect(classifyDiscordDeliveryResponse({
      status: 429,
      body: { code: 50_083, retry_after: 2.5, message: 'You are being rate limited.' },
    })).toEqual({
      kind: 'notSent',
      retry: 'after',
      retryAfterMs: 2_500,
      diagnostic: 'You are being rate limited.',
    });
    expect(classifyDiscordDeliveryResponse({
      status: 0,
      body: { code: 50_083, message: 'Thread is archived' },
    })).toEqual({ kind: 'outcomeUnknown' });
    expect(classifyDiscordDeliveryResponse({
      status: 503,
      body: { code: 50_083, message: 'Thread is archived' },
    })).toEqual({ kind: 'outcomeUnknown' });
  });

  it('accepts a successful direct send even when Discord auto-unarchives and classifies rate-limits and ambiguity truthfully', () => {
    expect(classifyDiscordDeliveryResponse({
      status: 200,
      body: { id: 'message-1', channel_id: 'thread-1' },
    })).toEqual({ kind: 'sent', messageId: 'message-1', channelId: 'thread-1' });
    expect(classifyDiscordDeliveryResponse({
      status: 429,
      body: { retry_after: 2.5, message: 'You are being rate limited.' },
    })).toEqual({
      kind: 'notSent',
      retry: 'after',
      retryAfterMs: 2_500,
      diagnostic: 'You are being rate limited.',
    });
    expect(classifyDiscordDeliveryResponse({
      status: 429,
      body: { retry_after: 86_401 },
    })).toEqual({
      kind: 'notSent',
      retry: 'after',
      retryAfterMs: 86_401_000,
    });
    expect(classifyDiscordDeliveryResponse({
      status: 0,
      body: null,
    })).toEqual({ kind: 'outcomeUnknown' });
  });
});

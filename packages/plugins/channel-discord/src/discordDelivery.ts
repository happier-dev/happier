import { MAX_CONVERSATION_RETRY_AFTER_MS, type ConversationDeliveryInputV1, type ConversationDeliveryResultV1,
  type ConversationResolvedEndpointV1 } from '@happier-dev/channels-protocol/v1';
import type { DiscordBotApi } from './discordApi.js';
import { createDiscordChannelEndpointId } from './discordPluginConstants.js';

export const DISCORD_MESSAGE_MAXIMUM_CODE_POINTS = 2_000;
export const DISCORD_MESSAGE_NONCE_MAXIMUM_CODE_POINTS = 25;
export const DISCORD_THREAD_NAME_MAXIMUM_CODE_POINTS = 100;
export const DISCORD_SUPPRESS_EMBEDS_FLAG = 1 << 2;
const DISCORD_DELIVERY_NONCE_DOMAIN = 'happier.discord.delivery-nonce.v1';
const UTF8 = new TextEncoder();

export type DiscordMessageCreatePayload = Readonly<{
  content: string;
  allowed_mentions: Readonly<{ parse: readonly [] }>;
  flags?: number;
  message_reference?: Readonly<{ message_id: string; fail_if_not_exists: false }>;
  nonce?: string;
  enforce_nonce?: true;
}>;

export type DiscordDeliveryResult =
  | Readonly<{ kind: 'sent'; messageId: string; channelId: string }>
  | Readonly<{ kind: 'endpointArchived'; recovery: 'ownerMustUnarchiveOrRebind' }>
  | Readonly<{
      kind: 'notSent';
      retry: 'safe' | 'after' | 'never';
      retryAfterMs?: number;
      diagnostic?: string;
    }>
  | Readonly<{ kind: 'outcomeUnknown' }>;

export type DiscordNonArchivedDeliveryResult = Exclude<
  DiscordDeliveryResult,
  Readonly<{ kind: 'endpointArchived'; recovery: 'ownerMustUnarchiveOrRebind' }>
>;

function requireNonEmpty(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function stableArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function encodeUnpaddedBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

export function boundedDiscordRetryAfterMs(body: unknown): number | undefined {
  const retryAfterSeconds = typeof body === 'object' && body !== null && !Array.isArray(body)
    && typeof (body as Readonly<Record<string, unknown>>).retry_after === 'number'
    && Number.isFinite((body as Readonly<Record<string, unknown>>).retry_after)
    && (body as Readonly<Record<string, number>>).retry_after >= 0
    ? (body as Readonly<Record<string, number>>).retry_after
    : null;
  return retryAfterSeconds === null
    ? undefined
    : Math.min(MAX_CONVERSATION_RETRY_AFTER_MS, Math.floor(retryAfterSeconds * 1_000));
}

async function discordNonceForDelivery(deliveryKey: string | undefined): Promise<string | undefined> {
  if (deliveryKey === undefined) return undefined;
  // Discord's Create Message endpoint accepts nonce strings only up to 25
  // characters. Hash the complete opaque custody key in
  // a provider-specific domain: truncating the raw key would alias distinct
  // delivery obligations, while this 150-bit base64url value remains bounded.
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('Web Crypto is required for Discord delivery nonces.');
  // Retain the existing single-message nonce encoding for the custody key.
  const input = `${DISCORD_DELIVERY_NONCE_DOMAIN}:${JSON.stringify([deliveryKey, 0])}`;
  const digest = await subtle.digest('SHA-256', stableArrayBuffer(UTF8.encode(input)));
  return encodeUnpaddedBase64Url(new Uint8Array(digest)).slice(0, DISCORD_MESSAGE_NONCE_MAXIMUM_CODE_POINTS);
}

export async function createDiscordMessagePayload(input: Readonly<{
  content: string;
  suppressEmbeds: boolean;
  replyToMessageId?: string;
  deliveryKey?: string;
}>): Promise<DiscordMessageCreatePayload> {
  if (!input.content) throw new Error('Discord message content is required.');
  const replyToMessageId = input.replyToMessageId === undefined
    ? undefined
    : requireNonEmpty(input.replyToMessageId, 'Discord reply message ID');
  const deliveryKey = input.deliveryKey === undefined
    ? undefined
    : requireNonEmpty(input.deliveryKey, 'Discord delivery key');
  const nonce = await discordNonceForDelivery(deliveryKey);
  return {
    content: input.content,
    allowed_mentions: { parse: [] },
    ...(input.suppressEmbeds ? { flags: DISCORD_SUPPRESS_EMBEDS_FLAG } : {}),
    ...(replyToMessageId === undefined
      ? {}
      : { message_reference: { message_id: replyToMessageId, fail_if_not_exists: false } }),
    ...(nonce === undefined ? {} : { nonce, enforce_nonce: true }),
  };
}

export function classifyDiscordNonArchivedDeliveryResponse(_input: Readonly<{
  status: number;
  body: unknown;
}>): DiscordNonArchivedDeliveryResult {
  const input = _input;
  if (!Number.isSafeInteger(input.status) || input.status < 0) return { kind: 'outcomeUnknown' };
  if (input.status === 0) return { kind: 'outcomeUnknown' };

  const body = typeof input.body === 'object' && input.body !== null && !Array.isArray(input.body)
    ? input.body as Readonly<Record<string, unknown>>
    : null;
  if (input.status >= 200 && input.status < 300) {
    const messageId = body && typeof body.id === 'string' && body.id.trim() ? body.id : null;
    const channelId = body && typeof body.channel_id === 'string' && body.channel_id.trim() ? body.channel_id : null;
    return messageId && channelId
      ? { kind: 'sent', messageId, channelId }
      : { kind: 'outcomeUnknown' };
  }
  return classifyDiscordDeliveryFailureResponse(input);
}

/** Shared no-effect/ambiguous classification for Create Message and Create Thread. */
export function classifyDiscordDeliveryFailureResponse(input: Readonly<{
  status: number; body: unknown;
}>): Exclude<DiscordNonArchivedDeliveryResult, { kind: 'sent' }> {
  if (!Number.isSafeInteger(input.status) || input.status <= 0) return { kind: 'outcomeUnknown' };
  const body = typeof input.body === 'object' && input.body !== null && !Array.isArray(input.body)
    ? input.body as Readonly<Record<string, unknown>> : null;
  const diagnostic = body && typeof body.message === 'string' && body.message.trim() ? body.message : undefined;
  if (input.status === 429) {
    const retryAfterMs = boundedDiscordRetryAfterMs(input.body);
    return retryAfterMs === undefined
      ? { kind: 'notSent', retry: 'safe', ...(diagnostic ? { diagnostic } : {}) }
      : {
          kind: 'notSent',
          retry: 'after',
          retryAfterMs,
          ...(diagnostic ? { diagnostic } : {}),
        };
  }
  if (input.status >= 500) {
    return { kind: 'outcomeUnknown' };
  }
  return { kind: 'notSent', retry: 'never', ...(diagnostic ? { diagnostic } : {}) };
}

function resolveDeliveryResult(result: DiscordDeliveryResult): ConversationDeliveryResultV1 {
  switch (result.kind) {
    case 'sent': return { kind: 'delivered', providerMessageIds: [result.messageId] };
    case 'endpointArchived': return { kind: 'endpointArchived', recovery: result.recovery };
    case 'notSent': return { kind: 'notDelivered', retry: result.retry,
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) };
    case 'outcomeUnknown': return result;
  }
}

/** One native message sender, including the first message of a new public thread. */
export async function deliverDiscordText(input: Readonly<{
  api: DiscordBotApi; request: ConversationDeliveryInputV1;
  channelId: string; payload: DiscordMessageCreatePayload; signal: AbortSignal;
}>): Promise<ConversationDeliveryResultV1> {
  let channelId = input.channelId;
  let endpoint: ConversationResolvedEndpointV1 | undefined;
  if (input.request.newThread !== undefined) {
    if (input.request.replyContext !== undefined) return { kind: 'notDelivered', retry: 'never' };
    const name = Array.from(input.request.newThread.subject.trim()).slice(0, DISCORD_THREAD_NAME_MAXIMUM_CODE_POINTS).join('');
    let created: Awaited<ReturnType<DiscordBotApi['createThread']>>;
    try {
      created = await input.api.createThread({ channelId, name }, { signal: input.signal });
    } catch {
      return { kind: 'outcomeUnknown' };
    }
    if (created.kind === 'outcomeUnknown') return created;
    if (created.kind === 'notSent') return resolveDeliveryResult(created);
    channelId = created.channelId;
    endpoint = { kind: 'thread', audience: 'shared', id: createDiscordChannelEndpointId(channelId), parentId: input.request.endpoint.id };
    if (input.signal.aborted) return { kind: 'outcomeUnknown', endpoint };
  }
  let result: DiscordDeliveryResult;
  try {
    // A normal send may auto-unarchive. Exact native refusal alone requests
    // recovery; no speculative PATCH or unverified MANAGE_THREADS permission.
    result = await input.api.sendMessage({ channelId, payload: input.payload }, { signal: input.signal });
  } catch {
    return { kind: 'outcomeUnknown', ...(endpoint === undefined ? {} : { endpoint }) };
  }
  const delivered = resolveDeliveryResult(result);
  return endpoint === undefined ? delivered
    : delivered.kind === 'delivered' ? { ...delivered, endpoint } : { kind: 'outcomeUnknown', endpoint };
}

export function classifyDiscordDeliveryResponse(_input: Readonly<{
  status: number;
  body: unknown;

}>): DiscordDeliveryResult {
  const input = _input;
  const body = typeof input.body === 'object' && input.body !== null && !Array.isArray(input.body)
    ? input.body as Readonly<Record<string, unknown>>
    : null;

  // Discord's exact archived-thread code is the only archive recovery signal.
  // A successful direct send remains successful if Discord auto-unarchives it.
  if (
    Number.isSafeInteger(input.status)
    && input.status >= 400
    && input.status < 500
    && input.status !== 429
    && body?.code === 50_083
  ) {
    return {
      kind: 'endpointArchived',
      recovery: 'ownerMustUnarchiveOrRebind',
    };
  }

  return classifyDiscordNonArchivedDeliveryResponse(input);
}

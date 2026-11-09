import type {
  ConversationObservationAddressingEvidenceV1,
  ConversationResolvedEndpointV1,
  ConversationMessageAttachmentV1,
} from '@happier-dev/channels-protocol/v1';
import { createConversationAttachmentIdV1 } from '@happier-dev/channels-protocol/v1';

import { createDiscordChannelEndpointId } from './discordPluginConstants.js';

export type DiscordChannelAddress = Readonly<{
  kind: 'direct' | 'shared' | 'thread';
  channelId: string;
  parentChannelId?: string;
}>;

export type DiscordMessageParseContext = Readonly<{
  botUserId: string;
  applicationId: string;
  botRoleIds: readonly string[];
  messageContentIntentEnabled: boolean;
}>;

/**
 * The provider-owned classifier projects only the shared contract's
 * authenticated message evidence; endpoint audience remains a separate fact.
 */
export type DiscordMessageAddressing = ConversationObservationAddressingEvidenceV1;

type DiscordInboundMessageRoutingEvidence = Readonly<{
  occurrenceId: string;
  endpoint: ConversationResolvedEndpointV1;
  actor: Readonly<{
    principalId: string | null;
    kind: 'human' | 'integration' | 'bot' | 'unknown';
    isIntegrationSelf: boolean;
  }>;
  message: Readonly<{
    id: string;
    revision?: string;
    replyToMessageId?: string;
    addressingEvidence: DiscordMessageAddressing;
    contentProvenance: 'original' | 'forwarded' | 'viaBot';
    providerTimestamp: number;
  }>;
}>;

export type DiscordInboundMessageEvidence = DiscordInboundMessageRoutingEvidence & Readonly<{
  kind: 'message';
  message: DiscordInboundMessageRoutingEvidence['message'] & Readonly<{
    text: string;
    attachments?: readonly ConversationMessageAttachmentV1[];
  }>;
}>;

export type DiscordRoutableNonAdmissionEvidence = DiscordInboundMessageRoutingEvidence & Readonly<{
  kind: 'routableNonAdmission';
  reason: 'unsupportedContent' | 'unsupportedEdit';
}>;

export type DiscordMessageParseResult =
  | DiscordInboundMessageEvidence
  | DiscordRoutableNonAdmissionEvidence
  | Readonly<{
      kind: 'notIngress';
      reason:
        | 'invalidPayload';
    }>;

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export type DiscordNativeAttachment = Readonly<{
  id: string;
  name: string;
  mediaType: string;
  byteLength: number;
  url: string;
}>;

/** Shared native metadata codec for Gateway observations and renewed REST reads. */
export function readDiscordNativeAttachments(value: unknown): readonly DiscordNativeAttachment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const attachments: DiscordNativeAttachment[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const id = readNonEmptyString(raw.id);
    const name = readNonEmptyString(raw.filename);
    const url = readNonEmptyString(raw.url);
    const byteLength = readNonNegativeInteger(raw.size);
    if (id === null || name === null || url === null || byteLength === null || seen.has(id)) return null;
    const mediaType = raw.content_type === undefined
      ? 'application/octet-stream'
      : readNonEmptyString(raw.content_type);
    if (mediaType === null) return null;
    seen.add(id);
    attachments.push({ id, name, url, mediaType, byteLength });
  }
  return attachments;
}

function hasEntries(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.length > 0;
}

type DiscordForwardedSnapshotBody =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'supported'; content: string }>
  | Readonly<{ kind: 'unsupported' }>;

const DISCORD_SNAPSHOT_MESSAGE_KEYS = new Set([
  'type',
  'content',
  'embeds',
  'attachments',
  'timestamp',
  'edited_timestamp',
  'flags',
  'mentions',
  'mention_roles',
  'stickers',
  'sticker_items',
  'components',
]);

function readForwardedSnapshotBody(payload: JsonRecord): DiscordForwardedSnapshotBody {
  if (!Object.hasOwn(payload, 'message_snapshots')) return { kind: 'none' };
  const reference = isRecord(payload.message_reference) ? payload.message_reference : null;
  const snapshots = Array.isArray(payload.message_snapshots) ? payload.message_snapshots : null;
  if (
    reference?.type !== 1
    || readNonEmptyString(reference.message_id) === null
    || readNonEmptyString(reference.channel_id) === null
    || snapshots?.length !== 1
  ) return { kind: 'unsupported' };

  const snapshot = isRecord(snapshots[0]) ? snapshots[0] : null;
  if (snapshot === null || Object.keys(snapshot).length !== 1 || !isRecord(snapshot.message)) {
    return { kind: 'unsupported' };
  }
  const message = snapshot.message;
  if (Object.keys(message).some((key) => !DISCORD_SNAPSHOT_MESSAGE_KEYS.has(key))) {
    return { kind: 'unsupported' };
  }
  const messageType = readNonNegativeInteger(message.type);
  const supportedMessageTypes = messageType === 0 || messageType === 19 || messageType === 20 || messageType === 23;
  if (
    !supportedMessageTypes
    || typeof message.content !== 'string'
    || !Array.isArray(message.embeds)
    || !Array.isArray(message.attachments)
    || (message.mentions !== undefined && !Array.isArray(message.mentions))
    || (message.mention_roles !== undefined && !Array.isArray(message.mention_roles))
    || (message.stickers !== undefined && !Array.isArray(message.stickers))
    || (message.sticker_items !== undefined && !Array.isArray(message.sticker_items))
    || (message.components !== undefined && !Array.isArray(message.components))
    || (message.flags !== undefined && readNonNegativeInteger(message.flags) === null)
    || (message.timestamp !== undefined && readNonEmptyString(message.timestamp) === null)
    || (message.edited_timestamp !== undefined
      && message.edited_timestamp !== null
      && readNonEmptyString(message.edited_timestamp) === null)
  ) return { kind: 'unsupported' };
  if (hasEntries(message.attachments) || hasEntries(message.embeds)) return { kind: 'unsupported' };
  return message.content ? { kind: 'supported', content: message.content } : { kind: 'unsupported' };
}

function includesString(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.some((entry) => entry === expected);
}

function includesMention(value: unknown, expectedId: string): boolean {
  return Array.isArray(value) && value.some((entry) => isRecord(entry) && entry.id === expectedId);
}

function messageReplyToBot(
  payload: JsonRecord,
  context: DiscordMessageParseContext,
  messageType: number,
  replyToMessageId: string | null,
): boolean {
  if (messageType !== 19 || replyToMessageId === null) return false;
  const reference = isRecord(payload.message_reference) ? payload.message_reference : null;
  const referenced = isRecord(payload.referenced_message) ? payload.referenced_message : null;
  if (!reference || !referenced) return false;
  const author = isRecord(referenced.author) ? referenced.author : null;
  return author?.id === context.botUserId
    || readNonEmptyString(referenced.application_id) === context.applicationId;
}

function readReplyMessageId(payload: JsonRecord, messageType: number): string | null {
  if (messageType !== 19) return null;
  const reference = isRecord(payload.message_reference) ? payload.message_reference : null;
  return reference ? readNonEmptyString(reference.message_id) : null;
}

function readActor(payload: JsonRecord, context: DiscordMessageParseContext): DiscordInboundMessageEvidence['actor'] {
  const webhookId = readNonEmptyString(payload.webhook_id);
  const applicationId = readNonEmptyString(payload.application_id);
  const author = isRecord(payload.author) ? payload.author : null;
  const authorId = author ? readNonEmptyString(author.id) : null;

  if (webhookId) {
    return {
      principalId: `discord:webhook:${webhookId}`,
      kind: 'integration',
      isIntegrationSelf: applicationId === context.applicationId,
    };
  }
  if (applicationId) {
    return {
      principalId: `discord:application:${applicationId}`,
      kind: 'integration',
      isIntegrationSelf: applicationId === context.applicationId,
    };
  }
  if (!authorId) return { principalId: null, kind: 'unknown', isIntegrationSelf: false };
  if (author?.bot === true) {
    return {
      principalId: `discord:user:${authorId}`,
      kind: 'bot',
      isIntegrationSelf: authorId === context.botUserId,
    };
  }
  return { principalId: `discord:user:${authorId}`, kind: 'human', isIntegrationSelf: false };
}

function endpointForChannel(channel: DiscordChannelAddress): ConversationResolvedEndpointV1 | null {
  const channelId = readNonEmptyString(channel.channelId);
  if (!channelId) return null;
  if (channel.kind === 'direct') {
    return {
      kind: 'direct',
      audience: 'direct',
      id: createDiscordChannelEndpointId(channelId),
    };
  }
  if (channel.kind === 'shared') {
    return {
      kind: 'shared',
      audience: 'shared',
      id: createDiscordChannelEndpointId(channelId),
    };
  }
  const parentChannelId = readNonEmptyString(channel.parentChannelId);
  if (!parentChannelId) return null;
  return {
    kind: 'thread',
    audience: 'shared',
    id: createDiscordChannelEndpointId(channelId),
    parentId: createDiscordChannelEndpointId(parentChannelId),
  };
}

function addressingForMessage(
  payload: JsonRecord,
  context: DiscordMessageParseContext,
  messageType: number,
  replyToMessageId: string | null,
): DiscordMessageAddressing {
  if (includesMention(payload.mentions, context.botUserId)) return 'directIntegrationMention';
  if (context.botRoleIds.some((roleId) => includesString(payload.mention_roles, roleId))) return 'integrationRoleMention';
  if (messageReplyToBot(payload, context, messageType, replyToMessageId)) return 'replyToIntegration';
  return 'none';
}

function isAllowedWithoutMessageContent(
  endpoint: ConversationResolvedEndpointV1,
  addressingEvidence: DiscordMessageAddressing,
): boolean {
  return endpoint.audience === 'direct' || addressingEvidence === 'directIntegrationMention';
}

export function parseDiscordMessageDispatch(input: Readonly<{
  event: 'MESSAGE_CREATE' | 'MESSAGE_UPDATE';
  payload: unknown;
  channel: DiscordChannelAddress;
  context: DiscordMessageParseContext;
}>): DiscordMessageParseResult {
  if (!isRecord(input.payload)) return { kind: 'notIngress', reason: 'invalidPayload' };

  const payload = input.payload;
  const endpoint = endpointForChannel(input.channel);
  const messageId = readNonEmptyString(payload.id);
  const timestamp = readNonEmptyString(payload.timestamp);
  const providerTimestamp = timestamp === null ? Number.NaN : Date.parse(timestamp);
  const messageType = payload.type === undefined ? 0 : readNonNegativeInteger(payload.type);
  if (!endpoint || !messageId || !Number.isSafeInteger(providerTimestamp) || providerTimestamp < 0 || messageType === null) {
    return { kind: 'notIngress', reason: 'invalidPayload' };
  }

  const replyToMessageId = readReplyMessageId(payload, messageType);
  const addressingEvidence = addressingForMessage(
    payload,
    input.context,
    messageType,
    replyToMessageId,
  );
  const editedTimestamp = readNonEmptyString(payload.edited_timestamp);
  const revision = editedTimestamp !== null && Number.isSafeInteger(Date.parse(editedTimestamp))
    ? editedTimestamp
    : undefined;
  const forwardedSnapshot = readForwardedSnapshotBody(payload);
  const contentProvenance = forwardedSnapshot.kind !== 'none'
    ? 'forwarded'
    : readNonEmptyString(payload.application_id) !== null
      ? 'viaBot'
      : 'original';
  const routingEvidence: DiscordInboundMessageRoutingEvidence = {
    occurrenceId: `discord:message:${messageId}`,
    endpoint,
    actor: readActor(payload, input.context),
    message: {
      id: messageId,
      ...(revision === undefined ? {} : { revision }),
      ...(replyToMessageId === null ? {} : { replyToMessageId }),
      addressingEvidence,
      contentProvenance,
      providerTimestamp,
    },
  };

  if (input.event === 'MESSAGE_UPDATE') {
    if (revision === undefined) return { kind: 'notIngress', reason: 'invalidPayload' };
    return {
      ...routingEvidence,
      kind: 'routableNonAdmission',
      occurrenceId: `discord:message:${messageId}:edit:${revision}`,
      reason: 'unsupportedEdit',
    };
  }
  if (messageType !== 0 && messageType !== 19) {
    return { ...routingEvidence, kind: 'routableNonAdmission', reason: 'unsupportedContent' };
  }
  const attachments = readDiscordNativeAttachments(payload.attachments);
  if (
    forwardedSnapshot.kind === 'unsupported'
    || attachments === null
    || (attachments.length === 0 && hasEntries(payload.embeds))
  ) {
    return { ...routingEvidence, kind: 'routableNonAdmission', reason: 'unsupportedContent' };
  }
  const content = forwardedSnapshot.kind === 'supported'
    ? forwardedSnapshot.content
    : typeof payload.content === 'string'
      ? payload.content
      : null;
  if (
    content === null
    || (!content && attachments.length === 0)
    || (!input.context.messageContentIntentEnabled && !isAllowedWithoutMessageContent(endpoint, addressingEvidence))
  ) {
    return { ...routingEvidence, kind: 'routableNonAdmission', reason: 'unsupportedContent' };
  }

  return {
    ...routingEvidence,
    kind: 'message',
    message: {
      text: content,
      ...(attachments.length === 0 ? {} : { attachments: attachments.map(attachment => ({
        attachmentId: createConversationAttachmentIdV1('discord', [input.channel.channelId, messageId, attachment.id]),
        name: attachment.name,
        mediaType: attachment.mediaType,
        byteLength: attachment.byteLength,
      })) }),
      ...routingEvidence.message,
    },
  };
}

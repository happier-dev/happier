import type {
  ConversationObservationAddressingEvidenceV1,
  ConversationResolvedEndpointV1,
} from '@happier-dev/channels-protocol/v1';
import { MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES } from '@happier-dev/channels-protocol/v1';

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
  }>;
}>;

export type DiscordRoutableNonAdmissionEvidence = DiscordInboundMessageRoutingEvidence & Readonly<{
  kind: 'routableNonAdmission';
  reason: 'messageTooLarge' | 'unsupportedContent' | 'unsupportedEdit';
}>;

export type DiscordMessageParseResult =
  | DiscordInboundMessageEvidence
  | DiscordRoutableNonAdmissionEvidence
  | Readonly<{
      kind: 'notIngress';
      reason:
        | 'delete'
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

function hasEntries(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function exceedsIngressTextLimit(text: string): boolean {
  return new TextEncoder().encode(text).byteLength > MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES;
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
      id: `discord:channel:${channelId}`,
    };
  }
  if (channel.kind === 'shared') {
    return {
      kind: 'shared',
      audience: 'shared',
      id: `discord:channel:${channelId}`,
    };
  }
  const parentChannelId = readNonEmptyString(channel.parentChannelId);
  if (!parentChannelId) return null;
  return {
    kind: 'thread',
    audience: 'shared',
    id: `discord:channel:${channelId}`,
    parentId: `discord:channel:${parentChannelId}`,
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
  event: 'MESSAGE_CREATE' | 'MESSAGE_UPDATE' | 'MESSAGE_DELETE';
  payload: unknown;
  channel: DiscordChannelAddress;
  context: DiscordMessageParseContext;
}>): DiscordMessageParseResult {
  if (input.event === 'MESSAGE_DELETE') return { kind: 'notIngress', reason: 'delete' };
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
  const contentProvenance = hasEntries(payload.message_snapshots)
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
  if (hasEntries(payload.attachments) || hasEntries(payload.embeds)) {
    return { ...routingEvidence, kind: 'routableNonAdmission', reason: 'unsupportedContent' };
  }
  const content = typeof payload.content === 'string' ? payload.content : null;
  if (
    !content
    || (!input.context.messageContentIntentEnabled && !isAllowedWithoutMessageContent(endpoint, addressingEvidence))
  ) {
    return { ...routingEvidence, kind: 'routableNonAdmission', reason: 'unsupportedContent' };
  }
  if (exceedsIngressTextLimit(content)) {
    return { ...routingEvidence, kind: 'routableNonAdmission', reason: 'messageTooLarge' };
  }

  return {
    ...routingEvidence,
    kind: 'message',
    message: {
      text: content,
      ...routingEvidence.message,
    },
  };
}

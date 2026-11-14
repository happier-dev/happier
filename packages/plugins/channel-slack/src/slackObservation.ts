import { createConversationAttachmentIdV1, ConversationNormalizedIngressV1Schema, type ConversationIngressAutomationEventCandidateV1, type ConversationMessageAttachmentV1, type ConversationNormalizedIngressV1 } from '@happier-dev/channels-protocol/v1';
import type { SlackChannel, SlackIdentity } from './slackApi.js';
import { createSlackChannelEndpointId, createSlackEndpointIdentity, createSlackPrincipalId, readSlackEndpointId,
  SLACK_PLUGIN_ID, SLACK_AUTOMATION_MESSAGE_EVENT_ID, SLACK_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
  createSlackAutomationMessageSourceInstanceId } from './slackPluginConstants.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+$/.test(value);
}

/** The candidate shares Channels custody; own deliveries and bodyless revisions never arm work. */
export function createSlackAutomationEventCandidate(input: Readonly<{
  identity: SlackIdentity; observation: ConversationNormalizedIngressV1; originalText?: string;
}>): ConversationIngressAutomationEventCandidateV1 | null {
  if (input.observation.kind !== 'fullText' || input.observation.observation.actor.isIntegrationSelf) return null;
  const { endpoint, actor, message } = input.observation.observation;
  const selected = readSlackEndpointId(endpoint.id);
  if (selected === null || (endpoint.kind !== 'direct' && endpoint.kind !== 'shared' && endpoint.kind !== 'thread')) return null;
  const text = input.originalText ?? message.text;
  return {
    eventRef: { pluginId: SLACK_PLUGIN_ID, localId: SLACK_AUTOMATION_MESSAGE_EVENT_ID },
    sourceInstanceId: createSlackAutomationMessageSourceInstanceId({ ...input.identity, channelId: selected.channelId }),
    sourceContractVersion: SLACK_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
    payload: { teamId: input.identity.teamId, channelId: selected.channelId, channelKind: endpoint.kind,
      messageId: message.id, text, actorKind: actor.kind, addressingEvidence: message.addressingEvidence,
      ...(actor.principalId === null ? {} : { actorPrincipalId: actor.principalId }),
      ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
    },
  };
}

/** Authenticated Socket Mode Events API evidence; no receive cursor or checkpoint. */
export function mapSlackEventToIngress(input: Readonly<{ payload: unknown; identity: SlackIdentity; channel: SlackChannel }>): ConversationNormalizedIngressV1 | null {
  const { payload, identity, channel } = input;
  if (!isRecord(payload) || payload.type !== 'event_callback'
    || payload.team_id !== identity.teamId || payload.api_app_id !== identity.appId
    || typeof payload.event_id !== 'string' || !payload.event_id || !isRecord(payload.event)) return null;
  const event = payload.event;
  if ((event.type !== 'message' && event.type !== 'app_mention') || event.channel !== channel.id) return null;
  if (event.subtype === 'message_deleted') return null;
  const edited = event.subtype === 'message_changed';
  if (!edited && event.subtype !== undefined
    && event.subtype !== 'bot_message' && event.subtype !== 'file_share' && event.subtype !== 'thread_broadcast') return null;
  const message = edited && isRecord(event.message) ? event.message : event;
  if (!timestamp(message.ts)) return null;
  const providerTimestamp = Math.floor(Number(message.ts) * 1_000);
  if (!Number.isSafeInteger(providerTimestamp)) return null;
  const user = typeof message.user === 'string' && message.user ? message.user : null;
  const bot = typeof message.bot_id === 'string' && message.bot_id ? message.bot_id : null;
  const isIntegrationSelf = user === identity.botUserId || bot === identity.botId;
  const kind = isIntegrationSelf ? 'integration' : bot !== null || message.subtype === 'bot_message' ? 'bot' : user !== null ? 'human' : 'unknown';
  const threadTs = timestamp(message.thread_ts) && message.thread_ts !== message.ts ? message.thread_ts : undefined;
  const revision = edited && isRecord(message.edited) && timestamp(message.edited.ts)
    ? message.edited.ts : edited && timestamp(event.event_ts) ? event.event_ts : undefined;
  if (edited && revision === undefined) return null;
  const shell = {
    v: 1,
    // message and app_mention can describe the same native post with different
    // event IDs. Edits remain separate, bodyless revision occurrences.
    occurrenceId: edited ? `slack:${identity.teamId}:event:${payload.event_id}`
      : `${createSlackChannelEndpointId(identity.teamId, channel.id)}:message:${message.ts}`,
    occurredAt: providerTimestamp,
    transport: { kind: 'socket' },
    endpoint: createSlackEndpointIdentity(identity, channel, threadTs),
    actor: { principalId: user === null ? null : createSlackPrincipalId(identity.teamId, user), kind, isIntegrationSelf },
    message: {
      id: message.ts,
      ...(revision === undefined ? {} : { revision }),
      ...(threadTs === undefined ? {} : { replyToMessageId: threadTs }),
      // A thread root is not proof that its author was this integration.
      addressingEvidence: typeof message.text === 'string' && message.text.includes(`<@${identity.botUserId}>`)
        ? 'directIntegrationMention' : 'none',
      contentProvenance: 'original',
      providerTimestamp,
    },
  };
  const attachments: ConversationMessageAttachmentV1[] = [];
  const files: unknown = message.files ?? [];
  let validFiles = Array.isArray(files);
  if (Array.isArray(files)) for (const file of files) {
    if (!isRecord(file) || typeof file.id !== 'string' || !/^[A-Z0-9]+$/.test(file.id)
      || typeof file.name !== 'string' || !file.name.trim()
      || typeof file.mimetype !== 'string' || !file.mimetype.trim()
      || (file.size !== undefined && (typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0))) {
      validFiles = false;
      break;
    }
    attachments.push({
      attachmentId: createConversationAttachmentIdV1('slack', [identity.teamId, channel.id, message.ts, file.id]),
      name: file.name, mediaType: file.mimetype,
      ...(typeof file.size === 'number' ? { byteLength: file.size } : {}),
    });
  }
  const unsupported = !validFiles
    || (Array.isArray(message.attachments) && message.attachments.length > 0)
    || typeof message.text !== 'string' || (!message.text.trim() && attachments.length === 0);
  // Decode only Slack's native leading bot address. Channels owns command
  // grammar and policy; embedded/other-user mentions remain message content.
  let text = message.text;
  if (typeof text === 'string') {
    const addressed = text.trimStart();
    const mention = `<@${identity.botUserId}>`;
    if (addressed.startsWith(mention) && /\s/u.test(addressed.charAt(mention.length))) {
      text = addressed.slice(mention.length).trimStart();
    }
  }
  const parsed = ConversationNormalizedIngressV1Schema.safeParse(edited
    ? { kind: 'routableNonAdmission', shell, reason: 'unsupportedEdit' }
    : unsupported ? { kind: 'routableNonAdmission', shell, reason: 'unsupportedContent' }
      : { kind: 'fullText', observation: { ...shell, message: { ...shell.message, text, ...(attachments.length ? { attachments } : {}) } } });
  return parsed.success ? parsed.data : null;
}

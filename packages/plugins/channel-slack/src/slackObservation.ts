import { ConversationNormalizedIngressV1Schema, type ConversationNormalizedIngressV1 } from '@happier-dev/channels-protocol/v1';
import type { SlackChannel, SlackIdentity } from './slackApi.js';
import { createSlackChannelEndpointId, createSlackEndpointIdentity, createSlackPrincipalId } from './slackPluginConstants.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+$/.test(value);
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
  const unsupported = (Array.isArray(message.files) && message.files.length > 0)
    || (Array.isArray(message.attachments) && message.attachments.length > 0)
    || typeof message.text !== 'string' || !message.text.trim();
  const parsed = ConversationNormalizedIngressV1Schema.safeParse(edited
    ? { kind: 'routableNonAdmission', shell, reason: 'unsupportedEdit' }
    : unsupported ? { kind: 'routableNonAdmission', shell, reason: 'unsupportedContent' }
      : { kind: 'fullText', observation: { ...shell, message: { ...shell.message, text: message.text } } });
  return parsed.success ? parsed.data : null;
}

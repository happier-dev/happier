import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { QualifiedConnectedAccountRefSchema, type ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { createProtocolStoredReadSchema, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import {
  ConversationAttachmentFetchInputV1Schema, ConversationAttachmentFetchResultV1Schema,
  encodeConversationAttachmentBytesV1, readConversationAttachmentIdV1, type ConversationAttachmentFetchResultV1,
  assertConversationChannelsCoreCallerV1, areConversationEndpointIdentitiesEqual, classifyConversationProviderMaterializationFailureV1,
  ConversationConnectionTestInputV1Schema, ConversationConnectionTestResultV1Schema,
  ConversationDeliveryInputV1Schema, ConversationDeliveryResultV1Schema,
  ConversationEndpointResolveInputV1Schema, ConversationEndpointResolveResultV1Schema,
  ConversationPrincipalResolveInputV1Schema, ConversationPrincipalResolveResultV1Schema, ConversationProviderSetupResultV1Schema,
  type ConversationProviderFailureV1, type ConversationProviderSetupResultV1, type ConversationConnectionTestResultV1,
  type ConversationDeliveryResultV1, type ConversationEndpointResolveResultV1, type ConversationPrincipalResolveResultV1,
  type ConversationResolvedEndpointV1,
} from '@happier-dev/channels-protocol/v1';
import { createSlackApi, type SlackChannel, type SlackCredentials, type SlackIdentity } from './slackApi.js';
import { createSlackMessagePayload, SLACK_MAX_MESSAGE_CODE_POINTS } from './slackDelivery.js';
import { verifySlackSocketIdentity } from './slackSocketWorker.js';
import {
  SLACK_PLUGIN_ID, SLACK_CONNECTED_ACCOUNT_ID, SLACK_CREDENTIAL_PURPOSE,
  SLACK_BOT_TOKEN_ENVIRONMENT_KEY, SLACK_APP_TOKEN_ENVIRONMENT_KEY,
  createSlackEndpointIdentity, createSlackPrincipalId, readSlackEndpointId,
} from './slackPluginConstants.js';

export const SLACK_SETUP_INPUT_PROTOCOL_SCHEMA = defineProtocolObject({ credentialRef: QualifiedConnectedAccountRefSchema }, { policy: 'closed' });
const storedConfiguration = createProtocolStoredReadSchema(defineProtocolObject({
  teamId: defineProtocolString({ minLength: 1, pattern: '^[A-Z0-9]+$' }),
  appId: defineProtocolString({ minLength: 1, pattern: '^[A-Z0-9]+$' }),
  botUserId: defineProtocolString({ minLength: 1, pattern: '^[A-Z0-9]+$' }),
  botId: defineProtocolString({ minLength: 1, pattern: '^[A-Z0-9]+$' }),
  label: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' }));
type ConnectionInput = Readonly<{ providerConnectionKey: string; providerConfigVersion: number; providerConfig: unknown; credentialRef: ConnectedAccountRef | null }>;
function connectionKey(identity: SlackIdentity): string { return `slack:team:${identity.teamId}:app:${identity.appId}`; }
function invalidConfiguration(): ConversationProviderFailureV1 {
  return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Slack did not confirm the selected connection identity or destination.' };
}
function isSlackCredential(ref: ConnectedAccountRef | null): ref is ConnectedAccountRef {
  return ref !== null && ref.service.pluginId === SLACK_PLUGIN_ID && ref.service.localId === SLACK_CONNECTED_ACCOUNT_ID;
}

/** The Action and socket supervisor consume one stored identity/credential contract. */
export function readSlackConnectionConfiguration(input: ConnectionInput): SlackIdentity | ConversationProviderFailureV1 {
  if (!isSlackCredential(input.credentialRef)) return { kind: 'notReady', reason: 'credentialInvalid' };
  const parsed = storedConfiguration.safeParse(input.providerConfig);
  if (input.providerConfigVersion !== 1 || !parsed.success || input.providerConnectionKey !== connectionKey(parsed.data)) return invalidConfiguration();
  return parsed.data;
}

export async function materializeExactSlackCredentials(
  context: Pick<PluginInvocationContext, 'services' | 'signal'>,
  credentialRef: ConnectedAccountRef,
): Promise<SlackCredentials | ConversationProviderFailureV1> {
  try {
    const materialized = await context.services.connectedAccounts.materialize(SLACK_CREDENTIAL_PURPOSE,
      { kind: 'environment', keys: [SLACK_BOT_TOKEN_ENVIRONMENT_KEY, SLACK_APP_TOKEN_ENVIRONMENT_KEY] },
      { signal: context.signal, expectedAccount: credentialRef });
    context.signal.throwIfAborted();
    const botToken = materialized.kind === 'environment' ? materialized.env[SLACK_BOT_TOKEN_ENVIRONMENT_KEY]?.trim() : undefined;
    const appToken = materialized.kind === 'environment' ? materialized.env[SLACK_APP_TOKEN_ENVIRONMENT_KEY]?.trim() : undefined;
    if (!botToken?.startsWith('xoxb-') || !appToken?.startsWith('xapp-')) return { kind: 'notReady', reason: 'credentialInvalid' };
    return { botToken, appToken };
  } catch (error) {
    return classifyConversationProviderMaterializationFailureV1(error, context.signal, 'The selected Slack account could not be materialized.');
  }
}

async function exactApi(context: PluginInvocationContext, credentialRef: ConnectedAccountRef) {
  const credentials = await materializeExactSlackCredentials(context, credentialRef);
  return 'kind' in credentials ? credentials : createSlackApi({ credentials, http: context.services.http });
}
async function readyConnection(context: PluginInvocationContext, input: ConnectionInput, verifyIdentity = false) {
  const config = readSlackConnectionConfiguration(input);
  if ('kind' in config) return config;
  if (!input.credentialRef) return invalidConfiguration();
  const api = await exactApi(context, input.credentialRef);
  if ('kind' in api) return api;
  if (!verifyIdentity) return { api, identity: config };
  const identity = await api.getIdentity({ signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in identity) return identity;
  if (identity.teamId !== config.teamId || identity.appId !== config.appId || identity.botUserId !== config.botUserId || identity.botId !== config.botId) return invalidConfiguration();
  return { api, identity };
}
function assertCore(context: PluginInvocationContext): void {
  assertConversationChannelsCoreCallerV1(context, { code: 'slack_channels_core_caller_required', message: 'Slack provider operations require the Channels core caller.' });
}
function endpointFor(identity: SlackIdentity, channel: SlackChannel, threadTs?: string): ConversationResolvedEndpointV1 {
  const endpoint = createSlackEndpointIdentity(identity, channel, threadTs);
  const label = channel.name ?? channel.id;
  return threadTs === undefined ? { ...endpoint, label }
    : { ...endpoint, label: `${label} · ${threadTs}`, parentLabel: label };
}

export async function setupSlackChannels(input: unknown, context: PluginInvocationContext): Promise<ConversationProviderSetupResultV1> {
  assertCore(context);
  const { credentialRef } = SLACK_SETUP_INPUT_PROTOCOL_SCHEMA.parse(input);
  if (!isSlackCredential(credentialRef)) throw new PluginError({ code: 'slack_setup_credential_invalid', message: 'Select a Slack bot Connected Account.' });
  const api = await exactApi(context, credentialRef);
  if ('kind' in api) throw new PluginError({ code: `slack_bot_${api.reason}`, message: api.diagnostic ?? 'Slack credentials are unavailable.' });
  const identity = await api.getIdentity({ signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in identity) throw new PluginError({ code: `slack_bot_${identity.reason}`, message: identity.diagnostic ?? 'Slack identity could not be verified.' });
  const socketFailure = await verifySlackSocketIdentity({ api, identity, webSockets: context.services.http, signal: context.signal });
  context.signal.throwIfAborted();
  if (socketFailure) throw new PluginError({ code: `slack_socket_${socketFailure.reason}`, message: socketFailure.diagnostic ?? 'Slack Socket Mode could not be verified.' });
  return ConversationProviderSetupResultV1Schema.parse({
    v: 1, credentialRef, providerConnectionKey: connectionKey(identity), providerConfigVersion: 1, providerConfig: identity,
    integrationPrincipal: { id: createSlackPrincipalId(identity.teamId, identity.botUserId), label: identity.label },
    supportedTransports: ['socket'], recommendedTransport: 'socket', overlapSafety: 'safe', replayContinuity: 'sessionBound',
    outboundTextLimit: { maximum: SLACK_MAX_MESSAGE_CODE_POINTS, unit: 'unicodeCodePoints', formatting: 'preservesNativeUnits' },
    setupGuidance: { externalUrl: 'https://api.slack.com/apps',
      requiredPermissionsLabel: 'Enable Socket Mode and message events; bot: chat:write, files:read, users:read, conversation read/history scopes; app token: connections:write. Invite the bot to each conversation.',
      steps: [
        { title: 'Create a Slack app in the workspace that will own this connection', externalUrl: 'https://api.slack.com/apps' },
        { title: 'Enable Socket Mode for the app', externalUrl: 'https://docs.slack.dev/apis/events-api/using-socket-mode/' },
        { title: 'Generate an app-level token with the connections:write scope',
          externalUrl: 'https://docs.slack.dev/reference/scopes/connections.write/',
          copyableValues: [{ label: 'App-level token scope', value: 'connections:write' }] },
        { title: 'Configure bot scopes and subscribe to message events', externalUrl: 'https://docs.slack.dev/reference/app-manifest/',
          copyableValues: [
            { label: 'Bot scopes', value: 'chat:write, files:read, users:read, channels:read, channels:history, groups:read, groups:history, im:read, im:history, mpim:read, mpim:history' },
            { label: 'Bot events', value: 'message.channels, message.groups, message.im, message.mpim' },
          ] },
        { title: 'Install the app, invite its bot to each conversation, and save the bot and app-level tokens in a Slack Bot Connected Account' },
      ],
    },
  });
}

export async function testSlackConnection(input: unknown, context: PluginInvocationContext): Promise<ConversationConnectionTestResultV1> {
  assertCore(context);
  const request = ConversationConnectionTestInputV1Schema.parse(input);
  if (request.selectedTransport !== 'socket') return { kind: 'notReady', reason: 'unsupported' };
  const ready = await readyConnection(context, request, true);
  if ('kind' in ready) return ready;
  const failure = await verifySlackSocketIdentity({ api: ready.api, identity: ready.identity, webSockets: context.services.http, signal: context.signal });
  context.signal.throwIfAborted();
  return failure ?? ConversationConnectionTestResultV1Schema.parse({ kind: 'ready', providerConnectionKey: connectionKey(ready.identity),
    integrationPrincipal: { id: createSlackPrincipalId(ready.identity.teamId, ready.identity.botUserId), label: ready.identity.label } });
}

export async function resolveSlackEndpoint(input: unknown, context: PluginInvocationContext): Promise<ConversationEndpointResolveResultV1> {
  assertCore(context);
  const request = ConversationEndpointResolveInputV1Schema.parse(input);
  const ready = await readyConnection(context, request);
  if ('kind' in ready) return ready;
  const query = request.query.trim();
  const selected = readSlackEndpointId(query);
  const channelId = selected?.channelId ?? (/^[CDG][A-Z0-9]+$/.test(query) ? query : null);
  if (!channelId || (selected && selected.teamId !== ready.identity.teamId)) return { kind: 'resolved', candidates: [] };
  const channel = await ready.api.getChannel(channelId, { signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in channel) return channel;
  if (channel.id !== channelId) return invalidConfiguration();
  let threadTs = selected?.threadTs;
  if (threadTs) {
    const root = await ready.api.getThreadRoot(channelId, threadTs, { signal: context.signal });
    context.signal.throwIfAborted();
    if ('kind' in root) return root;
    threadTs = root.threadTs;
  }
  const endpoint = endpointFor(ready.identity, channel, threadTs);
  return ConversationEndpointResolveResultV1Schema.parse({ kind: 'resolved', candidates: request.kinds && !request.kinds.includes(endpoint.kind) ? [] : [endpoint] });
}

export async function resolveSlackPrincipal(input: unknown, context: PluginInvocationContext): Promise<ConversationPrincipalResolveResultV1> {
  assertCore(context);
  const request = ConversationPrincipalResolveInputV1Schema.parse(input);
  const ready = await readyConnection(context, request);
  if ('kind' in ready) return ready;
  const endpoint = readSlackEndpointId(request.endpoint.id);
  if (!endpoint || endpoint.teamId !== ready.identity.teamId) return invalidConfiguration();
  const query = request.query.trim();
  const qualified = /^slack:([A-Z0-9]+):user:([UW][A-Z0-9]+)$/.exec(query);
  const userId = qualified?.[2] ?? (/^[UW][A-Z0-9]+$/.test(query) ? query : null);
  if (!userId || (qualified && qualified[1] !== ready.identity.teamId)) return { kind: 'resolved', candidates: [] };
  const user = await ready.api.getUser(userId, { signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in user) return user;
  return ConversationPrincipalResolveResultV1Schema.parse({ kind: 'resolved', candidates: user.id !== userId || user.teamId !== ready.identity.teamId || user.deleted ? [] : [{
    id: createSlackPrincipalId(ready.identity.teamId, user.id), label: user.label,
    kind: user.id === ready.identity.botUserId ? 'integration' : user.isBot ? 'bot' : 'human',
  }] });
}

function preSendFailure(failure: ConversationProviderFailureV1): ConversationDeliveryResultV1 {
  if (failure.reason === 'rateLimited' && failure.retryAfterMs !== undefined) return { kind: 'notDelivered', retry: 'after', retryAfterMs: failure.retryAfterMs };
  return { kind: 'notDelivered', retry: failure.reason === 'credentialInvalid' || failure.reason === 'permissionMissing' || failure.reason === 'invalidConfiguration' ? 'never' : 'safe' };
}
export async function deliverSlackMessage(input: unknown, context: PluginInvocationContext): Promise<ConversationDeliveryResultV1> {
  assertCore(context);
  const request = ConversationDeliveryInputV1Schema.parse(input);
  if (request.newThread !== undefined) return { kind: 'notReady', reason: 'unsupported' };
  if (context.signal.aborted) return { kind: 'notDelivered', retry: 'safe' };
  const ready = await readyConnection(context, request);
  if ('kind' in ready) return preSendFailure(ready);
  const selected = readSlackEndpointId(request.endpoint.id);
  if (!selected || selected.teamId !== ready.identity.teamId) return { kind: 'notDelivered', retry: 'never' };
  const channel = await ready.api.getChannel(selected.channelId, { signal: context.signal });
  if (context.signal.aborted) return { kind: 'notDelivered', retry: 'safe' };
  if ('kind' in channel) return preSendFailure(channel);
  if (!areConversationEndpointIdentitiesEqual(endpointFor(ready.identity, channel, selected.threadTs), request.endpoint)) return { kind: 'notDelivered', retry: 'never' };
  if (channel.isArchived) return { kind: 'endpointArchived', recovery: 'ownerMustUnarchiveOrRebind' };
  const reply = request.replyContext;
  const requestedThread = reply && 'threadId' in reply ? reply.threadId : undefined;
  const replyTo = reply && 'replyToMessageId' in reply ? reply.replyToMessageId : undefined;
  if (requestedThread !== undefined && requestedThread !== selected.threadTs && requestedThread !== request.endpoint.id) return { kind: 'notDelivered', retry: 'never' };
  const threadTs = selected.threadTs ?? replyTo;
  if (threadTs !== undefined && !/^\d+\.\d+$/.test(threadTs)) return { kind: 'notDelivered', retry: 'never' };
  let payload;
  try { payload = createSlackMessagePayload({ channelId: selected.channelId, text: request.content.text,
    ...(threadTs === undefined ? {} : { threadTs }), linkPreviewPolicy: request.linkPreviewPolicy }); }
  catch { return { kind: 'notDelivered', retry: 'never' }; }
  if (context.signal.aborted) return { kind: 'notDelivered', retry: 'safe' };
  return ConversationDeliveryResultV1Schema.parse(await ready.api.postMessage(payload, { signal: context.signal }));
}

/** Uses the admitted connection and native file IDs; Channels owns materialization and failures. */
export async function fetchSlackAttachments(input: unknown, context: PluginInvocationContext): Promise<ConversationAttachmentFetchResultV1> {
  assertCore(context);
  const request = ConversationAttachmentFetchInputV1Schema.parse(input);
  const ready = await readyConnection(context, request);
  if ('kind' in ready) return ready;
  const references: { attachmentId: string; fileId: string }[] = [];
  for (const attachmentId of request.attachmentIds) {
    const parts = readConversationAttachmentIdV1(attachmentId, 'slack');
    if (parts?.length !== 4 || parts[0] !== ready.identity.teamId
      || typeof parts[1] !== 'string' || !/^[A-Z0-9]+$/.test(parts[1])
      || parts[2] !== request.messageId || typeof parts[3] !== 'string' || !/^[A-Z0-9]+$/.test(parts[3])) {
      return { kind: 'notReady', reason: 'unsupported', diagnostic: 'Slack attachment does not belong to this workspace and message.' };
    }
    references.push({ attachmentId, fileId: parts[3] });
  }
  const attachments: { attachmentId: string; base64: string }[] = [];
  for (const reference of references) {
    const result = await ready.api.downloadFile(reference.fileId, { signal: context.signal });
    context.signal.throwIfAborted();
    if (result.kind === 'notReady') return result;
    attachments.push({ attachmentId: reference.attachmentId, base64: encodeConversationAttachmentBytesV1(result.bytes) });
  }
  return ConversationAttachmentFetchResultV1Schema.parse({ kind: 'fetched', attachments });
}

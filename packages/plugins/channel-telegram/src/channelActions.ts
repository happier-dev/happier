import {
  CONVERSATION_CORE_PLUGIN_ID_V1,
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  ConversationAttachmentFetchInputV1Schema,
  ConversationAttachmentFetchResultV1Schema,
  createConversationAttachmentIdV1,
  readConversationAttachmentIdV1,
  encodeConversationAttachmentBytesV1,
  ConversationConnectionTestInputV1Schema,
  classifyConversationProviderMaterializationFailureV1,
  ConversationConnectionTestResultV1Schema,
  ConversationDeliveryInputV1Schema,
  ConversationDeliveryResultV1Schema,
  ConversationEndpointResolveInputV1Schema,
  ConversationEndpointResolveResultV1Schema,
  ConversationPollInputV1Schema,
  ConversationPollResultV1Schema,
  ConversationProviderConnectionInputV1Schema,
  ConversationProviderSetupOutcomeV1Schema,
  ConversationProviderSetupRemediationResultV1Schema,
  ConversationProviderSetupResultV1Schema,
  ConversationProviderConnectionsSnapshotV1Schema,
  hasCurrentConversationProviderConnectionV1,
  type ConversationConnectionTestResultV1,
  type ConversationAttachmentFetchResultV1,
  type ConversationAuthenticatedObservationShellV1,
  type ConversationDeliveryInputV1,
  type ConversationDeliveryResultV1,
  type ConversationEndpointResolveInputV1,
  type ConversationEndpointResolveResultV1,
  type ConversationNormalizedIngressV1,
  type ConversationIngressObservedEntryV1,
  type ConversationPollInputV1,
  type ConversationPollResultV1,
  type ConversationProviderConnectionInputV1,
  type ConversationProviderFailureV1,
  type ConversationProviderSetupOutcomeV1,
  type ConversationProviderSetupResultV1,
  type ConversationProviderSetupRemediationResultV1,
  type ConversationBindingInputModeV1,
  type ConversationResolvedEndpointV1,
} from '@happier-dev/channels-protocol/v1';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { sendTelegramText } from './telegramDelivery.js';
import {
  QualifiedConnectedAccountRefSchema,
  type ConnectedAccountRef,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginEventAutomationSetupResultV1 } from '@happier-dev/plugin-sdk/events';
import {
  createProtocolStoredReadSchema,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';

import {
  createTelegramBotApi,
  isTelegramUpdateOffset,
  TELEGRAM_MAX_GET_UPDATES_LIMIT,
  TELEGRAM_MAX_LONG_POLL_TIMEOUT_SECONDS,
  TELEGRAM_MAX_TOPIC_NAME_CODE_POINTS,
  type TelegramBotApi,
  type TelegramBotIdentity,
  type TelegramChat,
  type TelegramGetUpdatesResult,
  type TelegramIncomingMessage,
  type TelegramIncomingAttachment,
  type TelegramUpdate,
  TELEGRAM_MAX_MESSAGE_CODE_POINTS,
} from './telegramBotApi.js';
import {
  buildTelegramChatEventSourceSetupResult,
  createTelegramAutomationEventCandidate,
  projectTelegramAutomationSourceConnectionStatus,
  throwTelegramAutomationSetupInvalid,
} from './automationEvents.js';
import { assertTelegramChannelsCoreCaller } from './channelsCoreCaller.js';
import {
  TELEGRAM_BOT_CONNECTED_ACCOUNT_ID,
  TELEGRAM_BOT_CREDENTIAL_PURPOSE,
  TELEGRAM_BOT_TOKEN_ENVIRONMENT_KEY,
  TELEGRAM_CHANNEL_PLUGIN_ID,
} from './constants.js';

const TELEGRAM_CONNECTION_KEY_PREFIX = 'telegram-bot:';
// Telegram documents getUpdates retention as no more than 24 hours. An old
// cursor triggers inspection; age alone is not evidence of lost updates.
const TELEGRAM_UPDATE_RETENTION_MS = 24 * 60 * 60 * 1_000;
// After a week without new updates, Telegram may randomize update_id.
// https://core.telegram.org/bots/api#update
const TELEGRAM_UPDATE_SEQUENCE_IDLE_MS = 7 * TELEGRAM_UPDATE_RETENTION_MS;

type TelegramSetupInput = Readonly<{
  credentialRef: ConnectedAccountRef;
}>;
type ReadyTelegramConnection = Readonly<{
  api: TelegramBotApi;
  identity: TelegramBotIdentity;
}>;
type TelegramCheckpoint = Readonly<{
  v: 1;
  offset: string;
  caughtUpAtMs: number;
}>;
const storedTelegramCheckpointSchema = createProtocolStoredReadSchema(defineProtocolObject({
  v: defineProtocolLiteral(1),
  offset: defineProtocolString(),
  caughtUpAtMs: defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, { policy: 'closed' }));
type ConversationPollHistoryGapResultV1 = Extract<ConversationPollResultV1, {
  kind: 'historyGap';
}>;
type ConversationUnsupportedEditIngressV1 = Extract<ConversationNormalizedIngressV1, {
  kind: 'routableNonAdmission';
  reason: 'unsupportedEdit';
}>;
type TelegramPollingPrerequisite =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'requiresRemediation' }>
  | Readonly<{ kind: 'notReady'; failure: ConversationProviderFailureV1 }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The manifest declares this exact input and the host rejects anything else
 * before the handler runs, so this is the typed read of an already-admitted
 * value — not a second validator that can disagree with the declaration.
 */
export const TELEGRAM_SETUP_INPUT_PROTOCOL_SCHEMA = defineProtocolObject({
  credentialRef: QualifiedConnectedAccountRefSchema,
}, { policy: 'closed' });

function readSetupInput(input: unknown): TelegramSetupInput {
  return TELEGRAM_SETUP_INPUT_PROTOCOL_SCHEMA.parse(input);
}

function isTelegramCredential(credentialRef: ConnectedAccountRef | null): credentialRef is ConnectedAccountRef {
  return credentialRef !== null
    && credentialRef.service.pluginId === TELEGRAM_CHANNEL_PLUGIN_ID
    && credentialRef.service.localId === TELEGRAM_BOT_CONNECTED_ACCOUNT_ID;
}



function readFailure(result: TelegramGetUpdatesResult): ConversationProviderFailureV1 {
  if (result.kind === 'providerConflict') {
    return {
      kind: 'notReady',
      reason: 'providerConflict',
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
      diagnostic: result.diagnostic,
    };
  }
  if (result.kind === 'updates') {
    return {
      kind: 'notReady',
      reason: 'invalidConfiguration',
      diagnostic: 'Telegram returned update data where a provider identity response was required.',
    };
  }
  return {
    kind: 'notReady',
    reason: result.reason,
    ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
    ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
  };
}

function invalidConfiguration(diagnostic: string): ConversationProviderFailureV1 {
  return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic };
}

function historyGap(diagnostic: string): ConversationPollHistoryGapResultV1 {
  return { kind: 'historyGap', reason: 'providerHistoryUnavailable', diagnostic };
}

function readTelegramCheckpoint(
  value: ConversationPollInputV1['checkpoint'],
): TelegramCheckpoint | null | ConversationPollHistoryGapResultV1 {
  if (value === null) return null;
  const parsed = storedTelegramCheckpointSchema.safeParse(value);
  if (!parsed.success || !isTelegramUpdateOffset(parsed.data.offset)) {
    return historyGap('The persisted Telegram offset is invalid.');
  }
  return parsed.data;
}

function checkpointNeedsQueueInspection(checkpoint: TelegramCheckpoint, nowMs: number): boolean {
  return checkpoint.caughtUpAtMs > nowMs
    || nowMs - checkpoint.caughtUpAtMs >= TELEGRAM_UPDATE_RETENTION_MS;
}

function parseConnectionKey(providerConnectionKey: string): string | null {
  if (!providerConnectionKey.startsWith(TELEGRAM_CONNECTION_KEY_PREFIX)) return null;
  const identity = providerConnectionKey.slice(TELEGRAM_CONNECTION_KEY_PREFIX.length);
  return /^[0-9]+$/.test(identity) ? identity : null;
}

function readConnectionConfig(input: ConversationProviderConnectionInputV1): ConversationProviderFailureV1 | null {
  if (input.providerConfigVersion !== 1 || !isRecord(input.providerConfig)) {
    return invalidConfiguration('Telegram Channel connection configuration is unsupported.');
  }
  if (
    !isNonEmptyString(input.providerConfig.botUsername)
    || typeof input.providerConfig.canReadAllGroupMessages !== 'boolean'
    || parseConnectionKey(input.providerConnectionKey) === null
  ) {
    return invalidConfiguration('Telegram Channel connection configuration is invalid.');
  }
  if (!isTelegramCredential(input.credentialRef)) {
    return { kind: 'notReady', reason: 'credentialInvalid', diagnostic: 'A Telegram bot Connected Account is required.' };
  }
  return null;
}

async function finalizeTelegramPollResult(
  request: ConversationPollInputV1,
  result: ConversationPollResultV1,
  context: PluginInvocationContext,
): Promise<ConversationPollResultV1> {
  const botId = parseConnectionKey(request.providerConnectionKey);
  if (botId === null) return result;
  await projectTelegramAutomationSourceConnectionStatus({
    botId,
    status: result.kind === 'historyGap'
      ? 'historyGap'
      : result.kind === 'notReady'
        ? 'reconnecting'
        : 'ready',
  }, context);
  return result;
}

async function createExactTelegramBotApi(
  context: PluginInvocationContext,
  credentialRef: ConnectedAccountRef,
): Promise<TelegramBotApi | ConversationProviderFailureV1> {
  try {
    const materialized = await context.services.connectedAccounts.materialize(
      TELEGRAM_BOT_CREDENTIAL_PURPOSE,
      { kind: 'environment', keys: [TELEGRAM_BOT_TOKEN_ENVIRONMENT_KEY] },
      // The target-Action host bound this operation to the selected ref. The
      // plugin may only compare that current host-owned binding.
      { signal: context.signal, expectedAccount: credentialRef },
    );
    context.signal.throwIfAborted();
    const token = materialized.kind === 'environment'
      ? materialized.env[TELEGRAM_BOT_TOKEN_ENVIRONMENT_KEY]?.trim()
      : undefined;
    if (!token) {
      return { kind: 'notReady', reason: 'credentialInvalid', diagnostic: 'The Telegram bot token is unavailable.' };
    }
    return createTelegramBotApi({ token, http: context.services.http });
  } catch (error) {
    return classifyConversationProviderMaterializationFailureV1(error, context.signal,
      'The selected Telegram bot account could not be materialized.');
  }
}

async function connectionApi(
  context: PluginInvocationContext,
  input: ConversationProviderConnectionInputV1,
): Promise<TelegramBotApi | ConversationProviderFailureV1> {
  const invalid = readConnectionConfig(input);
  if (invalid) return invalid;
  return await createExactTelegramBotApi(context, input.credentialRef!);
}

async function readConnectionIdentity(
  api: TelegramBotApi,
  input: ConversationProviderConnectionInputV1,
  signal: AbortSignal,
): Promise<TelegramBotIdentity | ConversationProviderFailureV1> {
  const identity = await api.getMe({ signal });
  signal.throwIfAborted();
  if ('kind' in identity) return readFailure(identity);
  const configuredIdentity = parseConnectionKey(input.providerConnectionKey);
  if (configuredIdentity !== identity.id) {
    return invalidConfiguration('The selected Telegram bot no longer matches this Channel connection.');
  }
  return identity;
}

async function readyConnection(
  context: PluginInvocationContext,
  input: ConversationProviderConnectionInputV1,
): Promise<ReadyTelegramConnection | ConversationProviderFailureV1> {
  const api = await connectionApi(context, input);
  if ('kind' in api) return api;
  const identity = await readConnectionIdentity(api, input, context.signal);
  if ('kind' in identity) return identity;
  return { api, identity };
}

/**
 * `getUpdates` and a configured webhook are mutually exclusive at Telegram.
 * Setup presents the existing remediation Action; saved-connection tests use
 * this same prerequisite so they cannot clear that blocked-polling truth.
 */
async function inspectTelegramPollingPrerequisite(
  api: TelegramBotApi,
  signal: AbortSignal,
): Promise<TelegramPollingPrerequisite> {
  const webhook = await api.getWebhookInfo({ signal });
  signal.throwIfAborted();
  if ('kind' in webhook) return { kind: 'notReady', failure: readFailure(webhook) };
  return webhook.url.trim().length > 0
    ? { kind: 'requiresRemediation' }
    : { kind: 'ready' };
}

function endpointFromChat(
  message: Pick<TelegramIncomingMessage, 'chatId' | 'chatType' | 'messageThreadId' | 'isTopicMessage'>,
  label?: string | null,
): ConversationResolvedEndpointV1 | null {
  if (
    message.isTopicMessage
    && message.messageThreadId !== null
    && (message.chatType === 'private' || message.chatType === 'supergroup')
  ) {
    return {
      kind: 'thread',
      audience: message.chatType === 'private' ? 'direct' : 'shared',
      id: `${message.chatId}:${message.messageThreadId}`,
      parentId: message.chatId,
      ...(label ? { parentLabel: label } : {}),
    };
  }
  if (message.chatType === 'private') {
    return { kind: 'direct', audience: 'direct', id: message.chatId, ...(label ? { label } : {}) };
  }
  if (message.chatType === 'group' || message.chatType === 'supergroup') {
    return { kind: 'shared', audience: 'shared', id: message.chatId, ...(label ? { label } : {}) };
  }
  return null;
}

type TelegramMessageAddressing =
  | Readonly<{ addressingEvidence: 'none' | 'directIntegrationMention' }>
  | Readonly<{ addressingEvidence: 'replyToIntegration'; replyToMessageId: string }>;

const telegramTextEncoder = new TextEncoder();

function addressingFromMessage(message: TelegramIncomingMessage, identity: TelegramBotIdentity): TelegramMessageAddressing {
  const username = `@${identity.username}`.toLocaleLowerCase('en-US');
  const hasDirectIntegrationMention = message.textEntities.some((entity) => (
    (entity.type === 'text_mention' && entity.userId === identity.id)
    || (entity.type === 'mention' && entity.text.toLocaleLowerCase('en-US') === username)
  ));
  if (hasDirectIntegrationMention) return { addressingEvidence: 'directIntegrationMention' };
  if (message.replyToSenderId === identity.id && message.replyToMessageId !== null) {
    return { addressingEvidence: 'replyToIntegration', replyToMessageId: message.replyToMessageId };
  }
  return { addressingEvidence: 'none' };
}

/**
 * Telegram addresses group commands as `/command@BotUsername`. Only the
 * provider can authenticate that suffix because only it owns the `bot_command`
 * entity and the current bot identity. Core still owns the command grammar;
 * this boundary removes only Telegram's addressed-command suffix.
 */
function commandTextFromMessage(message: TelegramIncomingMessage, identity: TelegramBotIdentity): string | null {
  if (message.text === null) return null;
  const entity = message.textEntities.find((candidate) => candidate.type === 'bot_command' && candidate.offset === 0);
  if (entity === undefined) return message.text;
  const match = /^(\/[A-Za-z0-9_]+)@([A-Za-z0-9_]{5,32})$/u.exec(entity.text);
  if (match === null || match[2]?.toLocaleLowerCase('en-US') !== identity.username.toLocaleLowerCase('en-US')) {
    return message.text;
  }
  return `${match[1]}${message.text.slice(entity.text.length)}`;
}

function normalizedIngressFromUpdate(
  update: TelegramUpdate,
  identity: TelegramBotIdentity,
): ConversationNormalizedIngressV1 | null {
  if (update.message === null) return null;
  const message = update.message;
  const endpoint = endpointFromChat(message);
  if (endpoint === null) return null;
  const addressing = addressingFromMessage(message, identity);
  const envelope = {
    v: 1,
    occurrenceId: `telegram:update:${update.updateId}`,
    occurredAt: message.sentAtMs,
    transport: { kind: 'poll', providerDeliveryId: update.updateId },
    endpoint,
    actor: {
      principalId: message.senderId,
      ...(message.senderId === null ? {} : { label: message.senderId }),
      kind: message.senderId === null ? 'unknown' : (message.senderIsBot ? 'bot' : 'human'),
      isIntegrationSelf: message.senderId === identity.id,
    },
  } satisfies Omit<ConversationAuthenticatedObservationShellV1, 'message'>;
  const contentProvenance: ConversationAuthenticatedObservationShellV1['message']['contentProvenance'] =
    message.forwarded ? 'forwarded' : (message.viaBotId === null ? 'original' : 'viaBot');
  const messageFacts = {
      id: message.messageId,
      ...addressing,
      contentProvenance,
      providerTimestamp: message.sentAtMs,
  };
  if (update.kind === 'editedMessage') {
    const revision = message.editedAtMs;
    if (revision === null) return null;
    const shell: ConversationUnsupportedEditIngressV1['shell'] = {
      ...envelope,
      message: { ...messageFacts, revision: String(revision) },
    };
    return { kind: 'routableNonAdmission', shell, reason: 'unsupportedEdit' };
  }
  const shell: ConversationAuthenticatedObservationShellV1 = { ...envelope, message: messageFacts };
  const commandText = commandTextFromMessage(message, identity);
  if (commandText === null && message.attachments.length === 0) {
    return { kind: 'routableNonAdmission', shell, reason: 'unsupportedContent' };
  }
  return {
    kind: 'fullText',
    observation: {
      ...shell,
      message: { ...shell.message, text: commandText ?? '',
        ...(message.attachments.length === 0 ? {} : { attachments: message.attachments.map(file => ({
          attachmentId: telegramAttachmentId(identity.id, message.messageId, file),
          name: file.name, mediaType: file.mediaType,
          ...(file.byteLength === undefined ? {} : { byteLength: file.byteLength }),
        })) }),
      },
    },
  };
}

function telegramAttachmentId(botId: string, messageId: string, file: TelegramIncomingAttachment): string {
  return createConversationAttachmentIdV1('telegram', [botId, messageId, file.fileId, file.byteLength ?? null]);
}

function readTelegramAttachmentId(value: string, botId: string, messageId: string): Readonly<{ fileId: string; byteLength?: number }> | null {
  const decoded = readConversationAttachmentIdV1(value, 'telegram');
  if (decoded === null || decoded.length !== 4 || decoded[0] !== botId || decoded[1] !== messageId
    || typeof decoded[2] !== 'string' || !decoded[2]
    || (decoded[3] !== null && (typeof decoded[3] !== 'number' || !Number.isSafeInteger(decoded[3]) || decoded[3] < 0))) return null;
  return { fileId: decoded[2], ...(decoded[3] === null ? {} : { byteLength: decoded[3] }) };
}

/** Materialization only: stable native file IDs outlive Telegram's temporary download paths. */
export async function fetchTelegramAttachments(input: unknown, context: PluginInvocationContext): Promise<ConversationAttachmentFetchResultV1> {
  assertTelegramChannelsCoreCaller(context);
  context.signal.throwIfAborted();
  const request = ConversationAttachmentFetchInputV1Schema.parse(input);
  const api = await connectionApi(context, request);
  if ('kind' in api) return api;
  const botId = parseConnectionKey(request.providerConnectionKey)!;
  const files = request.attachmentIds.map(id => readTelegramAttachmentId(id, botId, request.messageId));
  if (files.some(file => file === null)) return { kind: 'notReady', reason: 'unsupported', diagnostic: 'The Telegram attachment does not belong to this bot and message.' };
  const attachments: { attachmentId: string; base64: string }[] = [];
  for (const [index, file] of files.entries()) {
    if (file === null) throw new Error('Validated Telegram attachment is missing');
    const result = await api.downloadFile(file, { signal: context.signal });
    context.signal.throwIfAborted();
    if (result.kind !== 'downloaded') return ConversationAttachmentFetchResultV1Schema.parse(result);
    attachments.push({ attachmentId: request.attachmentIds[index]!, base64: encodeConversationAttachmentBytesV1(result.bytes) });
  }
  return ConversationAttachmentFetchResultV1Schema.parse({ kind: 'fetched', attachments });
}

type TelegramEndpointAddress = Readonly<{
  chatId: string;
  messageThreadId?: string;
}>;

function parseCanonicalTelegramThreadIdentity(value: string): TelegramEndpointAddress | null {
  const match = /^(-?[0-9]+):([0-9]+)$/.exec(value);
  if (match === null) return null;
  const chatId = Number(match[1]);
  const messageThreadId = Number(match[2]);
  if (
    !Number.isSafeInteger(chatId)
    || chatId === 0
    || String(chatId) !== match[1]
    || !Number.isSafeInteger(messageThreadId)
    || messageThreadId <= 0
    || String(messageThreadId) !== match[2]
  ) {
    return null;
  }
  return { chatId: match[1], messageThreadId: match[2] };
}

function telegramEndpointAddress(endpoint: ConversationResolvedEndpointV1): TelegramEndpointAddress | null {
  if (endpoint.kind === 'direct' || endpoint.kind === 'shared') return { chatId: endpoint.id };
  if (endpoint.kind !== 'thread' || !endpoint.parentId) return null;
  const address = parseCanonicalTelegramThreadIdentity(endpoint.id);
  return address !== null && endpoint.parentId === address.chatId ? address : null;
}

async function chatSupportsTopics(
  chat: TelegramChat,
  api: TelegramBotApi,
  input: ConversationProviderConnectionInputV1,
  signal: AbortSignal,
): Promise<boolean | ConversationProviderFailureV1> {
  if (chat.type === 'supergroup') return chat.isForum;
  if (chat.type !== 'private') return false;
  // Private topics depend on a live bot capability, unlike forum topology
  // returned by getChat or ordinary destinations' stored bot identity.
  const identity = await readConnectionIdentity(api, input, signal);
  return 'kind' in identity ? identity : identity.hasTopicsEnabled;
}

function endpointMatches(endpoint: ConversationResolvedEndpointV1, chat: TelegramChat, supportsTopics: boolean): boolean {
  const audience = chat.type === 'private'
    ? 'direct'
    : (chat.type === 'group' || chat.type === 'supergroup' ? 'shared' : null);
  if (audience === null || endpoint.audience !== audience) return false;
  const address = telegramEndpointAddress(endpoint);
  return address?.chatId === chat.id
    && ((endpoint.kind === 'direct' && chat.type === 'private')
      || (endpoint.kind === 'shared' && (chat.type === 'group' || chat.type === 'supergroup'))
      || (endpoint.kind === 'thread' && supportsTopics
        && (chat.type !== 'supergroup' || address.messageThreadId !== '1')));
}

function preSendFailureResult(result: ConversationProviderFailureV1): ConversationDeliveryResultV1 {
  if (result.reason === 'rateLimited' && result.retryAfterMs !== undefined) {
    return { kind: 'notDelivered', retry: 'after', retryAfterMs: result.retryAfterMs };
  }
  if (
    result.reason === 'credentialInvalid'
    || result.reason === 'permissionMissing'
    || result.reason === 'invalidConfiguration'
  ) {
    return { kind: 'notDelivered', retry: 'never' };
  }
  // No outbound side effect has started, so transient provider uncertainty is
  // safe to retry. A rate limit without an authoritative delay remains safe.
  return { kind: 'notDelivered', retry: 'safe' };
}

/**
 * Telegram's group privacy mode is the platform's own delivery decision: with
 * it enabled the Bot API withholds ordinary group and supergroup messages and
 * delivers only commands, mentions, and replies to this bot.
 * `allAllowedMessages` is therefore a promise Telegram will not keep.
 *
 * BotFather can flip that switch at any time, long after setup. Setup states
 * this capability once and the connection test restates the CURRENT value, so
 * both roles read it from this single owner and cannot disagree about what the
 * same authenticated bot can deliver.
 */
function telegramSharedEndpointInputModes(
  identity: TelegramBotIdentity,
): readonly ConversationBindingInputModeV1[] {
  return identity.canReadAllGroupMessages
    ? ['directMentionsOnly', 'addressedMessages', 'allAllowedMessages']
    : ['directMentionsOnly', 'addressedMessages'];
}

/** Static provider-authored guide shared by cold setup presentation and verified preparation. */
export const TELEGRAM_SETUP_GUIDANCE: NonNullable<ConversationProviderSetupResultV1['setupGuidance']> = {
  externalUrl: 'https://t.me/BotFather',
  requiredPermissionsLabel: 'Create a bot with BotFather and store its token in a Telegram Bot Connected Account.',
  steps: [
    { title: 'Open the verified BotFather in Telegram', externalUrl: 'https://t.me/BotFather' },
    { title: 'Create your bot and follow BotFather’s name and username prompts',
      externalUrl: 'https://core.telegram.org/bots/tutorial#obtain-your-bot-token',
      copyableValues: [{ label: 'BotFather command', value: '/newbot' }] },
    { title: 'Paste the bot token into a Telegram Bot Connected Account, then select it and test the connection' },
    { title: 'Only for workflow-started conversations: in a forum group, make the bot an administrator with Manage Topics' },
  ],
};

export async function setupTelegramChannels(
  input: unknown,
  context: PluginInvocationContext,
): Promise<ConversationProviderSetupOutcomeV1> {
  assertTelegramChannelsCoreCaller(context);
  const setupInput = readSetupInput(input);
  if (!isTelegramCredential(setupInput.credentialRef)) {
    throw new PluginError({
      code: 'telegram_setup_credential_invalid',
      message: 'Telegram setup requires a Telegram bot Connected Account.',
    });
  }
  const api = await createExactTelegramBotApi(context, setupInput.credentialRef);
  if ('kind' in api) {
    throw new PluginError({ code: `telegram_bot_${api.reason}`, message: api.diagnostic ?? 'Telegram is unavailable.' });
  }
  const identity = await api.getMe({ signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in identity) {
    const failure = readFailure(identity);
    throw new PluginError({ code: `telegram_bot_${failure.reason}`, message: failure.diagnostic ?? 'Telegram is unavailable.' });
  }
  const pollingPrerequisite = await inspectTelegramPollingPrerequisite(api, context.signal);
  if (pollingPrerequisite.kind === 'notReady') {
    const failure = pollingPrerequisite.failure;
    throw new PluginError({ code: `telegram_bot_${failure.reason}`, message: failure.diagnostic ?? 'Telegram is unavailable.' });
  }
  if (pollingPrerequisite.kind === 'requiresRemediation') {
    return ConversationProviderSetupOutcomeV1Schema.parse({
      kind: 'requiresRemediation',
    });
  }
  return ConversationProviderSetupResultV1Schema.parse({
    v: 1,
    credentialRef: setupInput.credentialRef,
    providerConnectionKey: `${TELEGRAM_CONNECTION_KEY_PREFIX}${identity.id}`,
    providerConfigVersion: 1,
    providerConfig: {
      botUsername: identity.username,
      canReadAllGroupMessages: identity.canReadAllGroupMessages,
    },
    integrationPrincipal: { id: identity.id, label: identity.displayName },
    supportedTransports: ['checkpointedPull'],
    recommendedTransport: 'checkpointedPull',
    overlapSafety: 'providerExclusive',
    replayContinuity: 'checkpointed',
    outboundTextLimit: { maximum: TELEGRAM_MAX_MESSAGE_CODE_POINTS, unit: 'unicodeCodePoints', formatting: 'preservesNativeUnits' },
    // The authenticated delivery truth travels with the connection instead of
    // being discarded into the opaque provider configuration.
    sharedEndpointInputModes: telegramSharedEndpointInputModes(identity),
    setupGuidance: TELEGRAM_SETUP_GUIDANCE,
    pairingDeepLinkTemplate: `https://t.me/${identity.username}?start={{token}}`,
  });
}

/**
 * The optional provider remediation role is the sole Telegram mutation path
 * for a webhook that blocks polling setup. Its Action declaration carries the
 * host-rendered confirmation; this handler only runs after the host admits
 * that present-user intent and revalidates the selected Connected Account.
 */
export async function remediateTelegramWebhook(
  input: unknown,
  context: PluginInvocationContext,
): Promise<ConversationProviderSetupRemediationResultV1> {
  assertTelegramChannelsCoreCaller(context);
  // A retired host invocation must not even materialize credentials, let alone
  // dispatch a remote delete. The host also carries cancellation through the
  // request itself once it has admitted this Action.
  context.signal.throwIfAborted();
  const setupInput = readSetupInput(input);
  if (!isTelegramCredential(setupInput.credentialRef)) {
    throw new PluginError({
      code: 'telegram_setup_credential_invalid',
      message: 'Telegram setup remediation requires a Telegram bot Connected Account.',
    });
  }
  const api = await createExactTelegramBotApi(context, setupInput.credentialRef);
  if ('kind' in api) return ConversationProviderSetupRemediationResultV1Schema.parse(api);

  const result = await api.deleteWebhook({ signal: context.signal });
  context.signal.throwIfAborted();
  if (result.kind === 'deleted') {
    return ConversationProviderSetupRemediationResultV1Schema.parse({ kind: 'remediated' });
  }
  if (result.kind === 'outcomeUnknown') {
    return ConversationProviderSetupRemediationResultV1Schema.parse({ kind: 'outcomeUnknown' });
  }
  return ConversationProviderSetupRemediationResultV1Schema.parse(readFailure(result));
}

export async function testTelegramConnection(input: unknown, context: PluginInvocationContext): Promise<ConversationConnectionTestResultV1> {
  assertTelegramChannelsCoreCaller(context);
  const connection = ConversationConnectionTestInputV1Schema.parse(input);
  if (connection.selectedTransport !== 'checkpointedPull') {
    return ConversationConnectionTestResultV1Schema.parse({
      kind: 'notReady',
      reason: 'unsupported',
      diagnostic: 'Telegram Channels supports checkpointed polling only.',
    });
  }
  const ready = await readyConnection(context, connection);
  if ('kind' in ready) return ready;
  const pollingPrerequisite = await inspectTelegramPollingPrerequisite(ready.api, context.signal);
  if (pollingPrerequisite.kind === 'notReady') return pollingPrerequisite.failure;
  if (pollingPrerequisite.kind === 'requiresRemediation') {
    return ConversationConnectionTestResultV1Schema.parse({
      kind: 'notReady',
      reason: 'invalidConfiguration',
      diagnostic: 'Telegram has an active webhook. Remove it before using checkpointed polling.',
    });
  }
  return ConversationConnectionTestResultV1Schema.parse({
    kind: 'ready',
    integrationPrincipal: { id: ready.identity.id, label: ready.identity.displayName },
    providerConnectionKey: `${TELEGRAM_CONNECTION_KEY_PREFIX}${ready.identity.id}`,
    // Re-authenticated on every probe. Group privacy can be narrowed after
    // setup, and a saved shared binding that promised ordinary messages would
    // otherwise stay apparently ready while observing nothing at all.
    sharedEndpointInputModes: telegramSharedEndpointInputModes(ready.identity),
  });
}

export async function resolveTelegramEndpoint(input: unknown, context: PluginInvocationContext): Promise<ConversationEndpointResolveResultV1> {
  assertTelegramChannelsCoreCaller(context);
  const request = ConversationEndpointResolveInputV1Schema.parse(input);
  const query = request.query.trim();
  const threadAddress = parseCanonicalTelegramThreadIdentity(query);
  // getChat accepts exact IDs or public @usernames, not display-name search.
  if (threadAddress === null && !/^-?[0-9]+$/.test(query) && !/^@[a-z0-9_]+$/i.test(query)) {
    return {
      kind: 'notReady',
      reason: 'unsupported',
      diagnostic: 'Telegram cannot search chats by name. Enter a numeric chat ID, a public @username, or chatId:topicId for a topic.',
    };
  }
  const api = await connectionApi(context, request);
  if ('kind' in api) return api;
  const chat = await api.getChat({
    chatId: threadAddress?.chatId ?? query,
  }, { signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in chat) return readFailure(chat);
  if (threadAddress !== null) {
    const supportsTopics = await chatSupportsTopics(chat, api, request, context.signal);
    if (typeof supportsTopics !== 'boolean') return supportsTopics;
    if (!supportsTopics) return { kind: 'resolved', candidates: [] };
  }
  const candidate = endpointFromChat({
    chatId: chat.id,
    chatType: chat.type,
    messageThreadId: threadAddress?.messageThreadId ?? null,
    // General has no is_topic_message in Telegram's updates and is our parent
    // endpoint, including when its conventional ID is entered explicitly.
    isTopicMessage: threadAddress !== null && (chat.type !== 'supergroup' || threadAddress.messageThreadId !== '1'),
  }, chat.label);
  return ConversationEndpointResolveResultV1Schema.parse({
    kind: 'resolved',
    candidates: candidate === null || (request.kinds && !request.kinds.includes(candidate.kind)) ? [] : [candidate],
  });
}

/**
 * Resolves the chosen Telegram chat into the immutable Automation Event source
 * facts. It is invoked from the Automation composer, never from the Channels
 * ingress, and performs no observation of its own.
 */
export async function setupTelegramChatEventSource(
  input: unknown,
  context: PluginInvocationContext,
): Promise<PluginEventAutomationSetupResultV1> {
  if (!isRecord(input) || !isNonEmptyString(input.chatId) || !isRecord(input.credentialRef)) {
    throwTelegramAutomationSetupInvalid();
  }
  const credentialRef = input.credentialRef as unknown as ConnectedAccountRef;
  const api = await createExactTelegramBotApi(context, credentialRef);
  if ('kind' in api) {
    throw new PluginError({
      code: 'telegram_automation_source_unavailable',
      message: 'The selected Telegram bot is unavailable.',
    });
  }
  const identity = await api.getMe({ signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in identity) {
    throw new PluginError({
      code: 'telegram_automation_source_unavailable',
      message: 'The selected Telegram bot is unavailable.',
    });
  }
  let currentConnections: unknown;
  try {
    currentConnections = await context.services.actions.execute(
      {
        pluginId: CONVERSATION_CORE_PLUGIN_ID_V1,
        localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
      },
      {},
      { signal: context.signal },
    );
  } catch (error) {
    context.signal.throwIfAborted();
    throw new PluginError({
      code: 'telegram_automation_channels_connection_unavailable',
      message: 'Happier could not verify the Telegram Channels connection. Try again after Channels is available.',
      retryable: true,
      remediation: { kind: 'retry' },
    }, { cause: error });
  }
  const connections = ConversationProviderConnectionsSnapshotV1Schema.safeParse(currentConnections);
  if (!connections.success) {
    throw new PluginError({
      code: 'telegram_automation_channels_connection_unavailable',
      message: 'Happier could not verify the Telegram Channels connection. Try again after Channels is available.',
      retryable: true,
      remediation: { kind: 'retry' },
    });
  }
  const hasCurrentConnection = hasCurrentConversationProviderConnectionV1({
    connections: connections.data,
    providerConnectionKey: `${TELEGRAM_CONNECTION_KEY_PREFIX}${identity.id}`,
    credentialRef,
  });
  if (!hasCurrentConnection) {
    throw new PluginError({
      code: 'telegram_automation_channels_connection_required',
      message: 'Set up and enable this Telegram bot in Channels before watching one of its chats.',
      remediation: {
        kind: 'openSettings',
        path: '/settings/plugins/happier.channels/connections',
      },
    });
  }
  const chat = await api.getChat({ chatId: input.chatId }, { signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in chat) {
    throw new PluginError({
      code: 'telegram_automation_chat_not_found',
      message: 'The selected Telegram chat could not be resolved for this bot.',
    });
  }
  if (chat.type === 'channel') {
    throw new PluginError({
      code: 'telegram_automation_chat_type_unsupported',
      message: 'Telegram channel posts are not supported as Workflow message sources.',
    });
  }
  return buildTelegramChatEventSourceSetupResult({
    botId: identity.id,
    chatId: chat.id,
    label: chat.label,
  });
}

export async function pollTelegramObservations(input: unknown, context: PluginInvocationContext): Promise<ConversationPollResultV1> {
  assertTelegramChannelsCoreCaller(context);
  const request = ConversationPollInputV1Schema.parse(input);
  context.signal.throwIfAborted();
  const invalid = readConnectionConfig(request);
  if (invalid) return finalizeTelegramPollResult(request, invalid, context);
  const checkpoint = readTelegramCheckpoint(request.checkpoint);
  if (checkpoint !== null && 'kind' in checkpoint) return finalizeTelegramPollResult(request, checkpoint, context);
  const nowMs = Date.now();
  const ready = await readyConnection(context, request);
  if ('kind' in ready) return finalizeTelegramPollResult(request, ready, context);
  // A successful empty read cannot prove the update sequence stayed the same.
  // Once continuity is uncertain, offset zero inspects without acknowledging
  // a lower randomized sequence. The saved offset still selects new updates.
  const inspectQueue = checkpoint !== null && checkpointNeedsQueueInspection(checkpoint, nowMs);
  const timeoutSeconds = Math.min(TELEGRAM_MAX_LONG_POLL_TIMEOUT_SECONDS, Math.ceil(request.waitMs / 1_000));
  let poll = await ready.api.getUpdates({
    offset: inspectQueue ? '0' : checkpoint?.offset ?? '-1',
    initialBaseline: checkpoint === null,
    limit: inspectQueue ? TELEGRAM_MAX_GET_UPDATES_LIMIT : request.limit,
    timeoutSeconds,
  }, { signal: context.signal });
  context.signal.throwIfAborted();
  if (poll.kind !== 'updates') return finalizeTelegramPollResult(request, readFailure(poll), context);
  if (inspectQueue && checkpoint !== null) {
    if (nowMs - checkpoint.caughtUpAtMs >= TELEGRAM_UPDATE_SEQUENCE_IDLE_MS
      && poll.updates.length > 0
      && poll.updates.every(update => Number(update.updateId) < Number(checkpoint.offset) - 1)) {
      return finalizeTelegramPollResult(request, historyGap(
        'Telegram started a new update sequence.',
      ), context);
    }
    const updates = poll.updates.filter(update => Number(update.updateId) >= Number(checkpoint.offset)).slice(0, request.limit);
    if (updates.length === 0 && poll.updates.some(update => Number(update.updateId) === Number(checkpoint.offset) - 1)) {
      // A legacy full page may still await acknowledgement. Its last committed
      // update proves this is the saved sequence; acknowledge it to see beyond.
      poll = await ready.api.getUpdates({ offset: checkpoint.offset, limit: request.limit, timeoutSeconds }, { signal: context.signal });
      context.signal.throwIfAborted();
      if (poll.kind !== 'updates') return finalizeTelegramPollResult(request, readFailure(poll), context);
    } else {
      const last = updates.at(-1);
      poll = { kind: 'updates', updates, checkpointAfter: last === undefined ? checkpoint.offset : String(Number(last.updateId) + 1) };
    }
  }
  // Preserve the existing idle anchor until a native update actually arrives.
  const caughtUpAtMs = checkpoint !== null && poll.updates.length === 0 ? checkpoint.caughtUpAtMs : Date.now();
  const observations: ConversationIngressObservedEntryV1[] = [];
  if (checkpoint !== null) {
    for (const update of poll.updates) {
      const observation = normalizedIngressFromUpdate(update, ready.identity);
      if (observation !== null) {
        observations.push({
          observation,
          eventCandidate: createTelegramAutomationEventCandidate({
            identity: ready.identity,
            update,
            observation,
          }),
        });
      }
    }
  }
  const checkpointAfterBatch = {
    v: 1,
    offset: poll.checkpointAfter,
    caughtUpAtMs,
  };
  if (observations.length === 0) {
    return finalizeTelegramPollResult(
      request,
      ConversationPollResultV1Schema.parse({ kind: 'checkpointOnly', checkpointAfterBatch }),
      context,
    );
  }
  return finalizeTelegramPollResult(request, ConversationPollResultV1Schema.parse({
    kind: 'batch',
    // Telegram's documented `offset: -1` discards every earlier update and
    // returns the tail only to establish the first durable core checkpoint.
    // That tail is baseline evidence, never a historical Channel admission.
    observations,
    checkpointAfterBatch,
  }), context);
}

export async function deliverTelegramMessage(input: unknown, context: PluginInvocationContext): Promise<ConversationDeliveryResultV1> {
  assertTelegramChannelsCoreCaller(context);
  const request = ConversationDeliveryInputV1Schema.parse(input);
  if (request.newThread !== undefined && (request.endpoint.kind !== 'shared' || request.endpoint.audience !== 'shared')) {
    return { kind: 'notReady', reason: 'unsupported' };
  }
  const api = await connectionApi(context, request);
  if ('kind' in api) return preSendFailureResult(api);
  const address = telegramEndpointAddress(request.endpoint);
  if (address === null) return { kind: 'notDelivered', retry: 'never' };
  const { chatId, messageThreadId } = address;
  const requestedThreadId = request.replyContext !== undefined && 'threadId' in request.replyContext
    ? request.replyContext.threadId
    : undefined;
  if (
    (messageThreadId === undefined && requestedThreadId !== undefined)
    || (messageThreadId !== undefined
      && requestedThreadId !== undefined
      && requestedThreadId !== messageThreadId
      && requestedThreadId !== request.endpoint.id)
  ) {
    return { kind: 'notDelivered', retry: 'never' };
  }
  const chat = await api.getChat({ chatId }, { signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in chat) return preSendFailureResult(readFailure(chat));
  const supportsTopics = request.endpoint.kind === 'thread'
    ? await chatSupportsTopics(chat, api, request, context.signal) : false;
  if (typeof supportsTopics !== 'boolean') return preSendFailureResult(supportsTopics);
  if (!endpointMatches(request.endpoint, chat, supportsTopics)) return { kind: 'notDelivered', retry: 'never' };
  if (context.signal.aborted) return { kind: 'notDelivered', retry: 'safe' };
  if (request.newThread !== undefined) {
    if (chat.type !== 'supergroup' || !chat.isForum || request.replyContext !== undefined) {
      return { kind: 'notReady', reason: 'unsupported' };
    }
    // Only the native topic title is shortened; the complete text goes through
    // the existing Channels splitter and native send owner.
    const name = Array.from(request.newThread.subject.trim()).slice(0, TELEGRAM_MAX_TOPIC_NAME_CODE_POINTS).join('');
    let created: Awaited<ReturnType<TelegramBotApi['createForumTopic']>>;
    try {
      created = await api.createForumTopic({ chatId, name }, { signal: context.signal });
    } catch {
      return { kind: 'outcomeUnknown' };
    }
    if (created.kind === 'outcomeUnknown') return created;
    if (created.kind === 'notSent') return { kind: 'notDelivered', retry: created.retry,
      ...(created.retryAfterMs === undefined ? {} : { retryAfterMs: created.retryAfterMs }) };
    const endpoint: ConversationResolvedEndpointV1 = {
      kind: 'thread', audience: 'shared', id: `${chatId}:${created.messageThreadId}`, parentId: chatId,
    };
    if (context.signal.aborted) return { kind: 'outcomeUnknown', endpoint };
    const result = await sendTelegramText({ api, request, chatId,
      messageThreadId: created.messageThreadId, signal: context.signal });
    return result.kind === 'delivered' ? { ...result, endpoint } : { kind: 'outcomeUnknown', endpoint };
  }
  return await sendTelegramText({ api, request, chatId, messageThreadId, signal: context.signal });
}

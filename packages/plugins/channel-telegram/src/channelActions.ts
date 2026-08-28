import {
  CONVERSATION_CORE_PLUGIN_ID_V1,
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES,
  ConversationConnectionTestInputV1Schema,
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
  type ConversationProviderSetupRemediationResultV1,
  type ConversationBindingInputModeV1,
  type ConversationResolvedEndpointV1,
} from '@happier-dev/channels-protocol/v1';
import { isPluginError, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  QualifiedConnectedAccountRefSchema,
  type ConnectedAccountRef,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginEventAutomationSetupResultV1 } from '@happier-dev/plugin-sdk/events';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';

import {
  createTelegramBotApi,
  isTelegramUpdateOffset,
  splitTelegramPlainText,
  TELEGRAM_MAX_LONG_POLL_TIMEOUT_SECONDS,
  type TelegramBotApi,
  type TelegramBotIdentity,
  type TelegramGetUpdatesResult,
  type TelegramIncomingMessage,
  type TelegramUpdate,
  TELEGRAM_MAX_MESSAGE_CODE_POINTS,
} from './telegramBotApi.js';
import {
  buildTelegramChatEventSourceSetupResult,
  createTelegramAutomationEventCandidate,
  throwTelegramAutomationSetupInvalid,
} from './automationEvents.js';
import { assertTelegramChannelsCoreCaller } from './channelsCoreCaller.js';
import {
  TELEGRAM_BOT_CONNECTED_ACCOUNT_ID,
  TELEGRAM_BOT_CREDENTIAL_PURPOSE,
  TELEGRAM_BOT_TOKEN_ENVIRONMENT_KEY,
} from './constants.js';

const TELEGRAM_CHANNEL_PLUGIN_ID = 'happier.channel.telegram';
const TELEGRAM_CONNECTION_KEY_PREFIX = 'telegram-bot:';
// Telegram documents getUpdates retention as no more than 24 hours. This only
// records provider evidence in an opaque checkpoint; core owns the resulting
// history-gap status, reset, and persisted checkpoint transition.
const TELEGRAM_UPDATE_RETENTION_MS = 24 * 60 * 60 * 1_000;

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
type ConversationPollHistoryGapResultV1 = Extract<ConversationPollResultV1, {
  kind: 'historyGap';
}>;
type ConversationUnsupportedEditIngressV1 = Extract<ConversationNormalizedIngressV1, {
  kind: 'routableNonAdmission';
  reason: 'unsupportedEdit';
}>;

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

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new Error('Telegram Channel provider operation was cancelled.');
}

function materializationFailure(error: unknown): ConversationProviderFailureV1 {
  if (isPluginError(error)) {
    // The exact-account host uses this refusal when the invocation generation
    // is no longer current. It cannot become an independent delivery retry.
    if (error.code === 'plugin_final_generation_retired') throw error;
    // The host's unavailable Connected Accounts service has not reached
    // Telegram. Its default error is non-retryable, so retain the known
    // no-effect delivery boundary rather than treating it as bad credentials.
    if (error.retryable || error.code === 'plugin_service_unavailable') {
      return { kind: 'notReady', reason: 'network' };
    }
    return {
      kind: 'notReady',
      reason: 'credentialInvalid',
      diagnostic: 'The selected Telegram bot account could not be materialized.',
    };
  }
  // No Telegram request began, so an unclassified materializer failure is
  // still safe for the delivery owner to retry.
  return { kind: 'notReady', reason: 'network' };
}

function readFailure(result: TelegramGetUpdatesResult): ConversationProviderFailureV1 {
  if (result.kind === 'providerConflict') {
    return { kind: 'notReady', reason: 'providerConflict', diagnostic: result.diagnostic };
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
  if (
    !isRecord(value)
    || Object.keys(value).length !== 3
    || !Object.hasOwn(value, 'v')
    || !Object.hasOwn(value, 'offset')
    || !Object.hasOwn(value, 'caughtUpAtMs')
    || value.v !== 1
    || typeof value.offset !== 'string'
    || !isTelegramUpdateOffset(value.offset)
    || typeof value.caughtUpAtMs !== 'number'
    || !Number.isSafeInteger(value.caughtUpAtMs)
    || value.caughtUpAtMs < 0
  ) {
    return historyGap('The persisted Telegram checkpoint cannot be safely continued; an authenticated baseline reset is required.');
  }
  return {
    v: 1,
    offset: value.offset,
    caughtUpAtMs: value.caughtUpAtMs,
  };
}

function checkpointHistoryGap(checkpoint: TelegramCheckpoint, nowMs: number): ConversationPollHistoryGapResultV1 | null {
  if (
    checkpoint.caughtUpAtMs > nowMs
    || nowMs - checkpoint.caughtUpAtMs >= TELEGRAM_UPDATE_RETENTION_MS
  ) {
    return historyGap('Telegram can no longer prove continuity from the committed checkpoint; an authenticated baseline reset is required.');
  }
  return null;
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
    throwIfAborted(context.signal);
    const token = materialized.kind === 'environment'
      ? materialized.env[TELEGRAM_BOT_TOKEN_ENVIRONMENT_KEY]?.trim()
      : undefined;
    if (!token) {
      return { kind: 'notReady', reason: 'credentialInvalid', diagnostic: 'The Telegram bot token is unavailable.' };
    }
    return createTelegramBotApi({ token, http: context.services.http });
  } catch (error) {
    if (context.signal.aborted) throw error;
    return materializationFailure(error);
  }
}

async function readyConnection(
  context: PluginInvocationContext,
  input: ConversationProviderConnectionInputV1,
): Promise<ReadyTelegramConnection | ConversationProviderFailureV1> {
  const invalid = readConnectionConfig(input);
  if (invalid) return invalid;
  const api = await createExactTelegramBotApi(context, input.credentialRef!);
  if ('kind' in api) return api;
  const identity = await api.getMe({ signal: context.signal });
  throwIfAborted(context.signal);
  if ('kind' in identity) return readFailure(identity);
  const configuredIdentity = parseConnectionKey(input.providerConnectionKey);
  if (configuredIdentity !== identity.id) {
    return invalidConfiguration('The selected Telegram bot no longer matches this Channel connection.');
  }
  return { api, identity };
}

function endpointFromChat(
  message: Pick<TelegramIncomingMessage, 'chatId' | 'chatType' | 'messageThreadId'>,
  label?: string | null,
): ConversationResolvedEndpointV1 | null {
  if (
    message.messageThreadId !== null
    && (message.chatType === 'private' || message.chatType === 'group' || message.chatType === 'supergroup')
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
  if (message.text === null) {
    return { kind: 'routableNonAdmission', shell, reason: 'unsupportedContent' };
  }
  if (telegramTextEncoder.encode(message.text).byteLength > MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES) {
    return { kind: 'routableNonAdmission', shell, reason: 'messageTooLarge' };
  }
  return {
    kind: 'fullText',
    observation: {
      ...shell,
      message: { ...shell.message, text: message.text },
    },
  };
}

type TelegramEndpointAddress = Readonly<{
  chatId: string;
  messageThreadId?: string;
}>;

function telegramEndpointAddress(endpoint: ConversationResolvedEndpointV1): TelegramEndpointAddress | null {
  if (endpoint.kind === 'direct' || endpoint.kind === 'shared') return { chatId: endpoint.id };
  if (endpoint.kind !== 'thread' || !endpoint.parentId) return null;
  const [chatId, messageThreadId, ...remainder] = endpoint.id.split(':');
  if (!chatId || !messageThreadId || remainder.length !== 0 || endpoint.parentId !== chatId) return null;
  return { chatId, messageThreadId };
}

function endpointMatches(endpoint: ConversationResolvedEndpointV1, chat: Awaited<ReturnType<TelegramBotApi['getChat']>>): boolean {
  if ('kind' in chat) return false;
  const audience = chat.type === 'private'
    ? 'direct'
    : (chat.type === 'group' || chat.type === 'supergroup' ? 'shared' : null);
  if (audience === null || endpoint.audience !== audience) return false;
  const address = telegramEndpointAddress(endpoint);
  return address?.chatId === chat.id
    && ((endpoint.kind === 'direct' && chat.type === 'private')
      || (endpoint.kind === 'shared' && (chat.type === 'group' || chat.type === 'supergroup'))
      || (endpoint.kind === 'thread' && (chat.type === 'private' || chat.type === 'group' || chat.type === 'supergroup')));
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

function retryResult(result: Extract<Awaited<ReturnType<TelegramBotApi['sendMessage']>>, { kind: 'notSent' }>): ConversationDeliveryResultV1 {
  return {
    kind: 'notDelivered',
    retry: result.retry,
    ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
  };
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
  throwIfAborted(context.signal);
  if ('kind' in identity) {
    const failure = readFailure(identity);
    throw new PluginError({ code: `telegram_bot_${failure.reason}`, message: failure.diagnostic ?? 'Telegram is unavailable.' });
  }
  const webhook = await api.getWebhookInfo({ signal: context.signal });
  throwIfAborted(context.signal);
  if ('kind' in webhook) {
    const failure = readFailure(webhook);
    throw new PluginError({ code: `telegram_bot_${failure.reason}`, message: failure.diagnostic ?? 'Telegram is unavailable.' });
  }
  if (webhook.url.trim().length > 0) {
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
    outboundTextLimit: { maximum: TELEGRAM_MAX_MESSAGE_CODE_POINTS, unit: 'unicodeCodePoints' },
    // The authenticated delivery truth travels with the connection instead of
    // being discarded into the opaque provider configuration.
    sharedEndpointInputModes: telegramSharedEndpointInputModes(identity),
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
  throwIfAborted(context.signal);
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
  throwIfAborted(context.signal);
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
  const ready = await readyConnection(context, request);
  if ('kind' in ready) return ready;
  const chat = await ready.api.getChat({ chatId: request.query }, { signal: context.signal });
  throwIfAborted(context.signal);
  if ('kind' in chat) return readFailure(chat);
  const candidate = endpointFromChat({ chatId: chat.id, chatType: chat.type, messageThreadId: null }, chat.label);
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
  throwIfAborted(context.signal);
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
    throwIfAborted(context.signal);
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
  throwIfAborted(context.signal);
  if ('kind' in chat) {
    throw new PluginError({
      code: 'telegram_automation_chat_not_found',
      message: 'The selected Telegram chat could not be resolved for this bot.',
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
  throwIfAborted(context.signal);
  const invalid = readConnectionConfig(request);
  if (invalid) return invalid;
  const checkpoint = readTelegramCheckpoint(request.checkpoint);
  if (checkpoint !== null && 'kind' in checkpoint) return checkpoint;
  if (checkpoint !== null) {
    // Anchor retention before materializing credentials or making provider
    // effects, so an already-expired checkpoint cannot enter a new poll.
    const continuityFailure = checkpointHistoryGap(checkpoint, Date.now());
    if (continuityFailure) return continuityFailure;
  }
  const ready = await readyConnection(context, request);
  if ('kind' in ready) return ready;
  const poll = await ready.api.getUpdates({
    offset: checkpoint?.offset ?? '-1',
    initialBaseline: checkpoint === null,
    limit: request.limit,
    timeoutSeconds: Math.min(TELEGRAM_MAX_LONG_POLL_TIMEOUT_SECONDS, Math.ceil(request.waitMs / 1_000)),
  }, { signal: context.signal });
  throwIfAborted(context.signal);
  if (poll.kind !== 'updates') return readFailure(poll);
  // An underfull page proves Telegram had no further update at this point. A
  // full page proves only forward progress, so it must retain the prior proof
  // until a later underfull page catches up.
  const caughtUpAtMs = checkpoint === null || poll.updates.length < request.limit
    ? Date.now()
    : checkpoint.caughtUpAtMs;
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
    return ConversationPollResultV1Schema.parse({ kind: 'checkpointOnly', checkpointAfterBatch });
  }
  return ConversationPollResultV1Schema.parse({
    kind: 'batch',
    // Telegram's documented `offset: -1` discards every earlier update and
    // returns the tail only to establish the first durable core checkpoint.
    // That tail is baseline evidence, never a historical Channel admission.
    observations,
    checkpointAfterBatch,
  });
}

export async function deliverTelegramMessage(input: unknown, context: PluginInvocationContext): Promise<ConversationDeliveryResultV1> {
  assertTelegramChannelsCoreCaller(context);
  const request = ConversationDeliveryInputV1Schema.parse(input);
  const ready = await readyConnection(context, request);
  if ('kind' in ready) return preSendFailureResult(ready);
  const address = telegramEndpointAddress(request.endpoint);
  if (address === null) return { kind: 'notDelivered', retry: 'never' };
  const { chatId, messageThreadId } = address;
  const requestedThreadId = request.replyContext !== undefined && 'threadId' in request.replyContext
    ? request.replyContext.threadId
    : undefined;
  const replyToMessageId = request.replyContext !== undefined && 'replyToMessageId' in request.replyContext
    ? request.replyContext.replyToMessageId
    : undefined;
  if (
    (messageThreadId === undefined && requestedThreadId !== undefined)
    || (messageThreadId !== undefined
      && requestedThreadId !== undefined
      && requestedThreadId !== messageThreadId)
  ) {
    return { kind: 'notDelivered', retry: 'never' };
  }
  const chat = await ready.api.getChat({ chatId }, { signal: context.signal });
  throwIfAborted(context.signal);
  if ('kind' in chat) return preSendFailureResult(readFailure(chat));
  if (!endpointMatches(request.endpoint, chat)) return { kind: 'notDelivered', retry: 'never' };
  const chunks = splitTelegramPlainText(request.content);
  if (chunks === null || chunks.length === 0) return { kind: 'notDelivered', retry: 'never' };
  const providerMessageIds: string[] = [];
  for (const [index, text] of chunks.entries()) {
    if (context.signal.aborted) {
      if (providerMessageIds.length === 0) return { kind: 'notDelivered', retry: 'safe' };
      return ConversationDeliveryResultV1Schema.parse({
        kind: 'partial',
        providerMessageIds,
        failedChunk: index,
        retrySafe: false,
      });
    }
    let result: Awaited<ReturnType<TelegramBotApi['sendMessage']>>;
    try {
      result = await ready.api.sendMessage({
        chatId,
        text,
        suppressLinkPreview: request.linkPreviewPolicy === 'suppress',
        ...(index === 0 && replyToMessageId !== undefined
          ? { replyToMessageId }
          : {}),
        ...(messageThreadId === undefined ? {} : { messageThreadId }),
      }, { signal: context.signal });
    } catch {
      // A cancellation or transport loss after an outbound request began has no
      // proof of absence. Preserve every accepted chunk and force custody to
      // resolve the rest as ambiguous instead of dispatching again.
      return ConversationDeliveryResultV1Schema.parse({
        kind: 'outcomeUnknown',
        ...(providerMessageIds.length === 0 ? {} : { providerMessageIds }),
      });
    }
    if (result.kind === 'sent') {
      providerMessageIds.push(result.messageId);
      continue;
    }
    if (result.kind === 'outcomeUnknown') {
      return ConversationDeliveryResultV1Schema.parse({
        kind: 'outcomeUnknown',
        ...(providerMessageIds.length === 0 ? {} : { providerMessageIds }),
      });
    }
    if (providerMessageIds.length === 0) return retryResult(result);
    return ConversationDeliveryResultV1Schema.parse({
      kind: 'partial',
      providerMessageIds,
      failedChunk: index,
      retrySafe: false,
    });
  }
  return ConversationDeliveryResultV1Schema.parse({ kind: 'delivered', providerMessageIds });
}

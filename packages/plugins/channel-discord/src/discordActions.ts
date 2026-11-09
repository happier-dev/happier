import {
  assertConversationChannelsCoreCallerV1,
  ConversationAttachmentFetchInputV1Schema,
  ConversationAttachmentFetchResultV1Schema,
  encodeConversationAttachmentBytesV1,
  readConversationAttachmentIdV1,
  ConversationConnectionTestInputV1Schema,
  classifyConversationProviderMaterializationFailureV1,
  ConversationConnectionTestResultV1Schema,
  ConversationDeliveryInputV1Schema,
  ConversationEndpointResolveInputV1Schema,
  ConversationEndpointResolveResultV1Schema,
  ConversationProviderConnectionInputV1Schema,
  ConversationProviderSetupResultV1Schema,
  type ConversationConnectionTestResultV1,
  type ConversationAttachmentFetchResultV1,
  type ConversationDeliveryResultV1,
  type ConversationEndpointResolveResultV1,
  type ConversationProviderFailureV1,
  type ConversationProviderSetupResultV1,
} from '@happier-dev/channels-protocol/v1';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  QualifiedConnectedAccountRefSchema,
  type ConnectedAccountRef,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { createProtocolStoredReadSchema, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

import { createDiscordBotApi, type DiscordApiFailure, type DiscordBotApi } from './discordApi.js';
import {
  createDiscordMessagePayload,
  deliverDiscordText,
  type DiscordMessageCreatePayload,
} from './discordDelivery.js';
import {
  resolveDiscordEndpointCandidates,
  type DiscordKnownChannel,
} from './discordEndpointResolution.js';
import {
  createDiscordSetupResult,
  DISCORD_REQUIRED_PERMISSIONS,
  verifyDiscordEndpointPermissions,
} from './discordSetup.js';
import {
  DISCORD_BOT_CONNECTED_ACCOUNT_ID,
  DISCORD_BOT_CREDENTIAL_PURPOSE,
  DISCORD_BOT_TOKEN_ENVIRONMENT_KEY,
  DISCORD_PLUGIN_ID,
  readDiscordChannelEndpointId,
} from './discordPluginConstants.js';

const DISCORD_CONNECTION_KEY_PREFIX = 'discord:application:';

type DiscordSetupInput = Readonly<{ credentialRef: ConnectedAccountRef }>;
type ReadyDiscordConnection = Readonly<{
  api: DiscordBotApi;
  identity: DiscordConnectionConfiguration & Readonly<{ botLabel?: string }>;
}>;
export type DiscordConnectionConfiguration = Readonly<{
  applicationId: string;
  botUserId: string;
}>;
const storedDiscordConnectionConfigSchema = createProtocolStoredReadSchema(defineProtocolObject({
  applicationId: defineProtocolString(),
  botUserId: defineProtocolString(),
  inviteUrl: defineProtocolString().optional(),
}, { policy: 'closed' }));

export function assertDiscordChannelsCoreCaller(context: PluginInvocationContext): void {
  assertConversationChannelsCoreCallerV1(context, {
    code: 'discord_channels_core_caller_required',
    message: 'Discord Channel provider operations must be invoked by the Channels core plugin.',
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The manifest declares this exact input and the host rejects anything else
 * before the handler runs, so this is the typed read of an already-admitted
 * value — not a second validator that can disagree with the declaration.
 */
export const DISCORD_SETUP_INPUT_PROTOCOL_SCHEMA = defineProtocolObject({
  credentialRef: QualifiedConnectedAccountRefSchema,
}, { policy: 'closed' });

function readSetupInput(input: unknown): DiscordSetupInput {
  return DISCORD_SETUP_INPUT_PROTOCOL_SCHEMA.parse(input);
}

function isDiscordCredential(credentialRef: ConnectedAccountRef | null): credentialRef is ConnectedAccountRef {
  return credentialRef !== null
    && credentialRef.service.pluginId === DISCORD_PLUGIN_ID
    && credentialRef.service.localId === DISCORD_BOT_CONNECTED_ACCOUNT_ID;
}



function failureFromApi(result: DiscordApiFailure): ConversationProviderFailureV1 {
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

function parseConnectionKey(providerConnectionKey: string): string | null {
  if (!providerConnectionKey.startsWith(DISCORD_CONNECTION_KEY_PREFIX)) return null;
  const applicationId = providerConnectionKey.slice(DISCORD_CONNECTION_KEY_PREFIX.length).trim();
  return applicationId || null;
}

function readConnectionConfig(input: Readonly<{
  providerConnectionKey: string;
  providerConfigVersion: number;
  providerConfig: unknown;
  credentialRef: ConnectedAccountRef | null;
}>): ConversationProviderFailureV1 | null {
  if (input.providerConfigVersion !== 1 || !isRecord(input.providerConfig)) {
    return invalidConfiguration('Discord Channel connection configuration is unsupported.');
  }
  const parsed = storedDiscordConnectionConfigSchema.safeParse(input.providerConfig);
  if (!parsed.success) return invalidConfiguration('Discord Channel connection configuration is invalid.');
  const config = parsed.data;
  if (
    !nonEmptyString(config.applicationId)
    || !nonEmptyString(config.botUserId)
    || (config.inviteUrl !== undefined && !nonEmptyString(config.inviteUrl))
    || input.providerConnectionKey !== `${DISCORD_CONNECTION_KEY_PREFIX}${config.applicationId}`
  ) {
    return invalidConfiguration('Discord Channel connection configuration is invalid.');
  }
  if (!isDiscordCredential(input.credentialRef)) {
    return { kind: 'notReady', reason: 'credentialInvalid', diagnostic: 'A Discord bot Connected Account is required.' };
  }
  return null;
}

/**
 * Reuses the action owner’s stored connection/credential validation for the
 * Gateway background worker. It exposes only immutable Discord identity facts,
 * never a Channels binding or mutable policy selection.
 */
export function readDiscordConnectionConfiguration(input: Readonly<{
  providerConnectionKey: string;
  providerConfigVersion: number;
  providerConfig: unknown;
  credentialRef: ConnectedAccountRef | null;
}>): DiscordConnectionConfiguration | ConversationProviderFailureV1 {
  const failure = readConnectionConfig(input);
  if (failure) return failure;
  const config = input.providerConfig as Readonly<{ applicationId: string; botUserId: string }>;
  return { applicationId: config.applicationId, botUserId: config.botUserId };
}

export async function materializeExactDiscordBotToken(
  context: Pick<PluginInvocationContext, 'signal' | 'services'>,
  credentialRef: ConnectedAccountRef,
): Promise<string | ConversationProviderFailureV1> {
  try {
    const materialized = await context.services.connectedAccounts.materialize(
      DISCORD_BOT_CREDENTIAL_PURPOSE,
      { kind: 'environment', keys: [DISCORD_BOT_TOKEN_ENVIRONMENT_KEY] },
      // The target-Action host bound this operation to the selected ref. The
      // plugin may only compare that current host-owned binding.
      { signal: context.signal, expectedAccount: credentialRef },
    );
    context.signal.throwIfAborted();
    const token = materialized.kind === 'environment'
      ? materialized.env[DISCORD_BOT_TOKEN_ENVIRONMENT_KEY]?.trim()
      : undefined;
    if (!token) {
      return { kind: 'notReady', reason: 'credentialInvalid', diagnostic: 'The Discord bot token is unavailable.' };
    }
    return token;
  } catch (error) {
    return classifyConversationProviderMaterializationFailureV1(error, context.signal,
      'The selected Discord bot account could not be materialized.');
  }
}

async function createExactDiscordBotApi(
  context: PluginInvocationContext,
  credentialRef: ConnectedAccountRef,
): Promise<DiscordBotApi | ConversationProviderFailureV1> {
  const token = await materializeExactDiscordBotToken(context, credentialRef);
  return typeof token === 'string'
    ? createDiscordBotApi({ token, http: context.services.http })
    : token;
}

async function readyConnection(
  context: PluginInvocationContext,
  input: Readonly<{
    providerConnectionKey: string;
    providerConfigVersion: number;
    providerConfig: unknown;
    credentialRef: ConnectedAccountRef | null;
  }>,
  verifyIdentity = false,
): Promise<ReadyDiscordConnection | ConversationProviderFailureV1> {
  const config = readDiscordConnectionConfiguration(input);
  if ('kind' in config) return config;
  const api = await createExactDiscordBotApi(context, input.credentialRef!);
  if ('kind' in api) return api;
  if (!verifyIdentity) return { api, identity: config };
  const identity = await api.getIdentity({ signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in identity) return failureFromApi(identity);
  if (
    parseConnectionKey(input.providerConnectionKey) !== identity.applicationId
    || config.applicationId !== identity.applicationId
    || config.botUserId !== identity.botUserId
  ) {
    return invalidConfiguration('The selected Discord bot no longer matches this Channel connection.');
  }
  return { api, identity };
}

function permissionLabels(permissionIds: readonly string[]): string {
  const labels = permissionIds.map((permissionId) => (
    DISCORD_REQUIRED_PERMISSIONS.find((permission) => permission.id === permissionId)?.label
  ));
  if (labels.some((label) => label === undefined)) return 'the required Discord permissions';
  const definedLabels = labels as string[];
  if (definedLabels.length <= 1) return definedLabels[0] ?? 'the required Discord permissions';
  if (definedLabels.length === 2) return `${definedLabels[0]} and ${definedLabels[1]}`;
  return `${definedLabels.slice(0, -1).join(', ')}, and ${definedLabels.at(-1)}`;
}

function isDiscordApiFailure(value: unknown): value is DiscordApiFailure {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'notReady';
}

async function verifyCurrentDiscordEndpointPermissions(input: Readonly<{
  api: DiscordBotApi;
  botUserId: string;
  channel: DiscordKnownChannel;
  signal: AbortSignal;
}>): Promise<ConversationProviderFailureV1 | null> {
  if (input.channel.kind === 'direct') return null;
  if (input.channel.kind !== 'shared' && input.channel.kind !== 'thread') {
    return invalidConfiguration('Discord returned an unsupported channel kind for this target.');
  }
  let permissionChannel: DiscordKnownChannel | DiscordApiFailure | null;
  if (input.channel.kind === 'thread') {
    const parentChannelId = input.channel.parentChannelId;
    if (parentChannelId === undefined) {
      return invalidConfiguration('Discord did not return a parent channel for this thread target.');
    }
    permissionChannel = await input.api.getChannel({ channelId: parentChannelId }, { signal: input.signal });
  } else {
    permissionChannel = input.channel;
  }
  input.signal.throwIfAborted();
  if (permissionChannel === null) {
    return invalidConfiguration('Discord did not confirm the current parent channel for this target.');
  }
  if (permissionChannel.kind === 'notReady') return failureFromApi(permissionChannel);
  if (permissionChannel.kind !== 'shared' && permissionChannel.kind !== 'permissionParent') {
    return invalidConfiguration('Discord did not confirm a permission-bearing shared channel for this target.');
  }
  const guildId = input.channel.guildId;
  if (
    guildId === undefined
    || permissionChannel.guildId === undefined
    || permissionChannel.guildId !== guildId
    || permissionChannel.permissionOverwrites === undefined
  ) {
    return invalidConfiguration('Discord did not return current guild permission evidence for this target.');
  }

  const member = await input.api.getGuildMember(
    { guildId, userId: input.botUserId },
    { signal: input.signal },
  );
  input.signal.throwIfAborted();
  if (member === null) {
    return {
      kind: 'notReady',
      reason: 'permissionMissing',
      diagnostic: 'Discord did not confirm the current bot as a member of this target guild.',
    };
  }
  if ('kind' in member) return failureFromApi(member);

  const roles = await input.api.getGuildRoles({ guildId }, { signal: input.signal });
  input.signal.throwIfAborted();
  if (isDiscordApiFailure(roles)) return failureFromApi(roles);
  const verification = verifyDiscordEndpointPermissions({
    endpointKind: input.channel.kind,
    guildId,
    botUserId: input.botUserId,
    botRoleIds: member.roleIds,
    guildRoles: roles,
    permissionOverwrites: permissionChannel.permissionOverwrites,
  });
  if (verification.kind === 'verified') return null;
  if (verification.kind === 'invalidEvidence') {
    return invalidConfiguration('Discord returned inconsistent current target permission evidence.');
  }
  return {
    kind: 'notReady',
    reason: 'permissionMissing',
    diagnostic: `Discord cannot currently ${permissionLabels(verification.permissionIds)} in this target.`,
  };
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

function resolveEndpointLookupFailure(result: DiscordApiFailure): ConversationDeliveryResultV1 {
  if (result.reason === 'network') return { kind: 'notDelivered', retry: 'safe' };
  if (result.reason === 'rateLimited' && result.retryAfterMs !== undefined) {
    return { kind: 'notDelivered', retry: 'after', retryAfterMs: result.retryAfterMs };
  }
  if (result.reason === 'rateLimited') return { kind: 'notDelivered', retry: 'safe' };
  return { kind: 'notDelivered', retry: 'never' };
}

export async function setupDiscordChannels(
  input: unknown,
  context: PluginInvocationContext,
): Promise<ConversationProviderSetupResultV1> {
  assertDiscordChannelsCoreCaller(context);
  const setupInput = readSetupInput(input);
  if (!isDiscordCredential(setupInput.credentialRef)) {
    throw new PluginError({
      code: 'discord_setup_credential_invalid',
      message: 'Discord setup requires a Discord bot Connected Account.',
    });
  }
  const api = await createExactDiscordBotApi(context, setupInput.credentialRef);
  if ('kind' in api) {
    throw new PluginError({ code: `discord_bot_${api.reason}`, message: api.diagnostic ?? 'Discord is unavailable.' });
  }
  const identity = await api.getIdentity({ signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in identity) {
    const failure = failureFromApi(identity);
    throw new PluginError({ code: `discord_bot_${failure.reason}`, message: failure.diagnostic ?? 'Discord is unavailable.' });
  }
  // Gateway Bot is the current authority for the Identify session-start
  // budget and URL. Setup does not persist this transient transport fact, but
  // it verifies that a selected bot can obtain it before core creates a socket
  // connection that would otherwise fail only in the background service.
  const gateway = await api.getGatewayBot({ signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in gateway) {
    const failure = failureFromApi(gateway);
    throw new PluginError({ code: `discord_gateway_${failure.reason}`, message: failure.diagnostic ?? 'Discord Gateway is unavailable.' });
  }
  return ConversationProviderSetupResultV1Schema.parse(createDiscordSetupResult(identity, setupInput.credentialRef));
}

export async function testDiscordConnection(input: unknown, context: PluginInvocationContext): Promise<ConversationConnectionTestResultV1> {
  assertDiscordChannelsCoreCaller(context);
  const connection = ConversationConnectionTestInputV1Schema.parse(input);
  if (connection.selectedTransport !== 'socket') {
    return ConversationConnectionTestResultV1Schema.parse({
      kind: 'notReady',
      reason: 'unsupported',
      diagnostic: 'Discord Channels supports socket transport only.',
    });
  }
  const ready = await readyConnection(context, connection, true);
  if ('kind' in ready) return ready;
  const gateway = await ready.api.getGatewayBot({ signal: context.signal });
  context.signal.throwIfAborted();
  if ('kind' in gateway) return failureFromApi(gateway);
  return ConversationConnectionTestResultV1Schema.parse({
    kind: 'ready',
    integrationPrincipal: { id: `discord:bot:${ready.identity.botUserId}`, label: ready.identity.botLabel },
    providerConnectionKey: `${DISCORD_CONNECTION_KEY_PREFIX}${ready.identity.applicationId}`,
  });
}

export async function resolveDiscordEndpoint(input: unknown, context: PluginInvocationContext): Promise<ConversationEndpointResolveResultV1> {
  assertDiscordChannelsCoreCaller(context);
  const request = ConversationEndpointResolveInputV1Schema.parse(input);
  const ready = await readyConnection(context, request);
  if ('kind' in ready) return ready;
  const channelId = request.query.trim();
  // A direct-message user identifier must never be guessed into a new Discord
  // DM. Only an existing channel returned by Discord becomes a candidate.
  if (!/^[0-9]+$/.test(channelId)) {
    return ConversationEndpointResolveResultV1Schema.parse({ kind: 'resolved', candidates: [] });
  }
  const channel = await ready.api.getChannel({ channelId }, { signal: context.signal });
  context.signal.throwIfAborted();
  if (channel?.kind === 'notReady') return failureFromApi(channel);
  if (channel !== null) {
    const permissionFailure = await verifyCurrentDiscordEndpointPermissions({
      api: ready.api,
      botUserId: ready.identity.botUserId,
      channel,
      signal: context.signal,
    });
    if (permissionFailure !== null) return ConversationEndpointResolveResultV1Schema.parse(permissionFailure);
  }
  return ConversationEndpointResolveResultV1Schema.parse({
    kind: 'resolved',
    candidates: channel === null ? [] : resolveDiscordEndpointCandidates({
      query: request.query,
      knownChannels: [channel],
      ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
    }),
  });
}

export async function deliverDiscordMessage(input: unknown, context: PluginInvocationContext): Promise<ConversationDeliveryResultV1> {
  assertDiscordChannelsCoreCaller(context);
  const request = ConversationDeliveryInputV1Schema.parse(input);
  if (request.newThread !== undefined && (request.endpoint.kind !== 'shared' || request.endpoint.audience !== 'shared')) {
    return { kind: 'notReady', reason: 'unsupported' };
  }
  const ready = await readyConnection(context, request);
  if ('kind' in ready) return preSendFailureResult(ready);
  const channelId = readDiscordChannelEndpointId(request.endpoint.id);
  if (!channelId) return { kind: 'notDelivered', retry: 'never' };
  const endpointThreadId = request.endpoint.kind === 'thread' ? channelId : undefined;
  const requestedThreadId = request.replyContext !== undefined && 'threadId' in request.replyContext
    ? request.replyContext.threadId
    : undefined;
  const replyToMessageId = request.replyContext !== undefined && 'replyToMessageId' in request.replyContext
    ? request.replyContext.replyToMessageId
    : undefined;
  if (
    (endpointThreadId === undefined && requestedThreadId !== undefined)
    || (endpointThreadId !== undefined
      && requestedThreadId !== undefined
      && requestedThreadId !== endpointThreadId
      && requestedThreadId !== request.endpoint.id)
  ) {
    return { kind: 'notDelivered', retry: 'never' };
  }
  let payload: DiscordMessageCreatePayload;
  try {
    payload = await createDiscordMessagePayload({
      content: request.content.text,
      suppressEmbeds: request.linkPreviewPolicy === 'suppress',
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      deliveryKey: request.deliveryKey,
    });
  } catch {
    return { kind: 'notDelivered', retry: 'safe' };
  }
  if (context.signal.aborted) return { kind: 'notDelivered', retry: 'safe' };
  let currentChannel: Awaited<ReturnType<typeof ready.api.getChannel>>;
  try {
    currentChannel = await ready.api.getChannel({ channelId }, { signal: context.signal });
  } catch (error) {
    if (!context.signal.aborted) throw error;
    return { kind: 'notDelivered', retry: 'safe' };
  }
  if (context.signal.aborted) return { kind: 'notDelivered', retry: 'safe' };
  if (currentChannel !== null && currentChannel.kind === 'notReady') {
    return resolveEndpointLookupFailure(currentChannel);
  }
  const currentEndpoint = currentChannel === null
    ? undefined
    : resolveDiscordEndpointCandidates({ query: channelId, knownChannels: [currentChannel] })[0];
  if (
    currentEndpoint === undefined
    || currentEndpoint.kind !== request.endpoint.kind
    || currentEndpoint.audience !== request.endpoint.audience
    || currentEndpoint.id !== request.endpoint.id
    || currentEndpoint.parentId !== request.endpoint.parentId
  ) {
    return { kind: 'notDelivered', retry: 'never' };
  }
  return await deliverDiscordText({ api: ready.api, request, channelId, payload, signal: context.signal });
}

/** Fetch live bytes only when the core attachment owner consumes an admitted descriptor. */
export async function fetchDiscordAttachment(input: unknown, context: PluginInvocationContext): Promise<ConversationAttachmentFetchResultV1> {
  assertDiscordChannelsCoreCaller(context);
  const request = ConversationAttachmentFetchInputV1Schema.parse(input);
  const references: { attachmentId: string; channelId: string; nativeAttachmentId: string }[] = [];
  for (const attachmentId of request.attachmentIds) {
    const parts = readConversationAttachmentIdV1(attachmentId, 'discord');
    if (parts?.length !== 3 || !nonEmptyString(parts[0]) || parts[1] !== request.messageId || !nonEmptyString(parts[2])) {
      return { kind: 'notReady', reason: 'unsupported', diagnostic: 'Discord attachment does not belong to this message.' };
    }
    references.push({ attachmentId, channelId: parts[0], nativeAttachmentId: parts[2] });
  }
  const channelId = references[0]!.channelId;
  if (references.some(reference => reference.channelId !== channelId)) {
    return { kind: 'notReady', reason: 'unsupported', diagnostic: 'Discord attachments must belong to one native message.' };
  }
  const ready = await readyConnection(context, request);
  if ('kind' in ready) return ready;
  const native = await ready.api.getMessageAttachments({ channelId, messageId: request.messageId }, { signal: context.signal });
  context.signal.throwIfAborted();
  if (native === null) return { kind: 'notReady', reason: 'unsupported', diagnostic: 'Discord message is no longer available.' };
  if ('kind' in native) return failureFromApi(native);
  const attachments: { attachmentId: string; base64: string }[] = [];
  for (const reference of references) {
    const attachment = native.find(candidate => candidate.id === reference.nativeAttachmentId);
    if (attachment === undefined) return { kind: 'notReady', reason: 'unsupported', diagnostic: 'Discord attachment is no longer part of this message.' };
    const downloaded = await ready.api.downloadAttachment({ channelId, attachment }, { signal: context.signal });
    context.signal.throwIfAborted();
    if (downloaded.kind === 'notReady') return failureFromApi(downloaded);
    attachments.push({ attachmentId: reference.attachmentId, base64: encodeConversationAttachmentBytesV1(downloaded.bytes) });
  }
  return ConversationAttachmentFetchResultV1Schema.parse({ kind: 'fetched', attachments });
}

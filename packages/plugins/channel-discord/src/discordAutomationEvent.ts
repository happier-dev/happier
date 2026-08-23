import type { ConversationNormalizedIngressV1 } from '@happier-dev/channels-protocol/v1';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginEventAutomationSetupResultV1 } from '@happier-dev/plugin-sdk/events';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import { createDiscordBotApi } from './discordApi.js';
import { materializeExactDiscordBotToken } from './discordActions.js';
import {
  DISCORD_BOT_CONNECTED_ACCOUNT_ID,
  DISCORD_BOT_CREDENTIAL_PURPOSE,
  DISCORD_PLUGIN_ID,
  readDiscordChannelEndpointId,
} from './discordPluginConstants.js';

export { DISCORD_PLUGIN_ID } from './discordPluginConstants.js';

/**
 * WITHHELD DECLARATION — this module's Event is deliberately absent from
 * `plugin.ts`, so the plugin projects no automation-eligible Event. Everything
 * below stays as the observer's work in progress.
 *
 * Why it was withheld. This provider persists nothing: the Gateway session id
 * and last dispatch sequence live in one `startDiscordGatewaySocket` local
 * (`discordGateway.ts`), and neither the supervisor nor the worker writes any
 * storage. So a `checkpointedPull` observer here has no position to resume
 * from, and an admission that fails after process loss or a plugin reload
 * silently loses the Automation Run. `durablePush` is not merely unimplemented
 * but structurally unrepresentable: the `Automation_trigger_arm_check`
 * constraint added by migration `20260816231000_add_event_automations_v1`
 * requires `triggerObservationTransport = 'durablePush' AND
 * triggerWebhookEndpointId IS NOT NULL`, and a Gateway socket has no webhook
 * endpoint. Neither declared transport honestly describes this observer.
 *
 * Stated precisely: `checkpointedPull` carries no written durable-cursor
 * obligation — the term appears nowhere in `docs/` or `apps/docs/content/`, so
 * the declaration broke no written contract. What was actually false was a
 * code comment that promised Gateway replay would cover a failed admission.
 *
 * The funded follow-up is a real history-capable observer, and Discord already
 * supports one: `GET /channels/{id}/messages?after=` returns history, and
 * `createDiscordBotApi` (`discordApi.ts`) is the existing REST owner to extend.
 * Such an observer needs, at minimum:
 *   - a durable checkpoint keyed by the DEFINITION-scoped identity approved as
 *     `r0.39` — (automationId, eventRef, sourceSelectorId) — exactly as
 *     `createGithubAutomationEventCheckpointRowId`
 *     (`packages/plugins/scm-github/src/observations/githubAutomationEventCheckpoint.ts`)
 *     already forms it. NOT a cursor per (applicationId, channelId): the
 *     source-instance identity that
 *     `createDiscordAutomationMessageSourceInstanceId` forms is shared by every
 *     Automation watching the same channel, so one shared cursor would let each
 *     of them advance past the others' unobserved messages;
 *   - REST-verifiable history as the sole checkpoint authority. Gateway
 *     dispatches are low-latency HINTS ONLY: a live event may advance nothing
 *     the REST read has not confirmed, because the socket's session id and last
 *     dispatch sequence are process-local and unrecoverable after a reload;
 *   - reconnect backfill from that checkpoint, since Gateway RESUME covers only
 *     the in-process window;
 *   - dedupe between backfilled and live messages (the stable `occurrenceId`
 *     the host already keys occurrences by is the join);
 *   - Discord REST rate-limit handling for the backfill reads;
 *   - explicit history-gap semantics when the checkpoint falls outside what
 *     Discord will still return, reported through the Event's history-gap reset
 *     Action.
 *
 * To resume: re-add the `events` entry to `plugin.ts` using the ids and schemas
 * exported here, once that observer exists, then restore the two call sites
 * `discordGatewaySupervisor.ts` gives up while the Event is withheld — the
 * per-tick `createDiscordAutomationEventSourceIndex().refresh(...)` in `run`
 * and the full-text `admit(...)` fan-out inside `admitObservation`. They are
 * withdrawn rather than left dormant because the host builds an
 * adopted-definition owner only for a manifest-declared automation-eligible
 * Event (`resolveExecutablePluginRuntimeRegistry.ts`), so while this Event is
 * withheld every `automation.event.sources.list` fails with
 * `automation_event_adopted_definitions_unavailable` — once per reconciliation
 * tick, on every Machine. `discordAutomationEventAdmission.ts` and its tests
 * keep the index itself intact, and `automationEventDiscordSource.fixture.test.ts`
 * in `apps/cli` still drives the whole vertical end to end and is the harness
 * that proves the re-declared Event.
 */
export const DISCORD_AUTOMATION_MESSAGE_EVENT_ID = 'automation/channel-message-observed-v1';
export const DISCORD_AUTOMATION_MESSAGE_SETUP_ACTION_ID = 'automation/setup-channel-message-source-v1';
export const DISCORD_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION = 1;

/**
 * Discord's own message-content ceiling (2,000 code points, 4,000 with Nitro).
 * The Automation payload projection is bounded by the provider limit it
 * carries rather than by the host's much larger generic payload envelope, so
 * a future Discord change is visible as explicit incompleteness instead of a
 * rejected admission.
 */
export const DISCORD_MESSAGE_CONTENT_MAX_CODE_POINTS = 4_000;

/** The one ingress arm that carries readable message content. */
export type DiscordFullTextObservationV1 = Extract<
  ConversationNormalizedIngressV1,
  Readonly<{ kind: 'fullText' }>
>['observation'];

export type DiscordAutomationMessageSourceConfigV1 = Readonly<{
  v: 1;
  applicationId: string;
  channelId: string;
}>;

export type DiscordAutomationMessagePayloadV1 = Readonly<{
  v: 1;
  channelId: string;
  channelKind: 'direct' | 'shared' | 'thread';
  parentChannelId?: string;
  messageId: string;
  text: string;
  textTruncated: boolean;
  addressingEvidence: 'directIntegrationMention' | 'integrationRoleMention' | 'replyToIntegration' | 'none';
  contentProvenance: 'original' | 'forwarded' | 'viaBot';
  actorKind: 'human' | 'integration' | 'bot' | 'unknown';
  actorPrincipalId?: string;
  replyToMessageId?: string;
}>;

const DISCORD_SNOWFLAKE_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[0-9]+$',
} as const satisfies PluginJsonSchema;

/**
 * Private source facts the canonical Automation writer persists. The bot
 * application is part of the source identity so a second Discord application
 * on the same Account can never admit another application's channel.
 */
export const DISCORD_AUTOMATION_MESSAGE_SOURCE_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    applicationId: DISCORD_SNOWFLAKE_SCHEMA,
    channelId: DISCORD_SNOWFLAKE_SCHEMA,
  },
  required: ['v', 'applicationId', 'channelId'],
} satisfies PluginJsonSchema;

export const DISCORD_AUTOMATION_MESSAGE_SETUP_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    credentialRef: QualifiedConnectedAccountRefJsonSchema,
    channelId: DISCORD_SNOWFLAKE_SCHEMA,
  },
  required: ['credentialRef', 'channelId'],
} satisfies PluginJsonSchema;

export const DISCORD_AUTOMATION_MESSAGE_SETUP_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    sourceInstanceId: { type: 'string', minLength: 1, maxLength: 512 },
    sourceContractVersion: {
      type: 'integer',
      const: DISCORD_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
    },
    sourceConfig: DISCORD_AUTOMATION_MESSAGE_SOURCE_CONFIG_SCHEMA,
    displayLabel: { type: 'string', minLength: 1, maxLength: 256 },
  },
  required: ['v', 'sourceInstanceId', 'sourceContractVersion', 'sourceConfig', 'displayLabel'],
} satisfies PluginJsonSchema;

/**
 * Every leaf is a bounded scalar so the host's `eq`/`in` Automation filter can
 * address it: a user narrows the same Event to direct mentions, to human
 * authors, or to one channel without the provider inventing per-variant Events.
 */
export const DISCORD_AUTOMATION_MESSAGE_PAYLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    channelId: DISCORD_SNOWFLAKE_SCHEMA,
    channelKind: { type: 'string', enum: ['direct', 'shared', 'thread'] },
    parentChannelId: DISCORD_SNOWFLAKE_SCHEMA,
    messageId: DISCORD_SNOWFLAKE_SCHEMA,
    text: { type: 'string', maxLength: DISCORD_MESSAGE_CONTENT_MAX_CODE_POINTS },
    textTruncated: { type: 'boolean' },
    addressingEvidence: {
      type: 'string',
      enum: ['directIntegrationMention', 'integrationRoleMention', 'replyToIntegration', 'none'],
    },
    contentProvenance: { type: 'string', enum: ['original', 'forwarded', 'viaBot'] },
    actorKind: { type: 'string', enum: ['human', 'integration', 'bot', 'unknown'] },
    actorPrincipalId: { type: 'string', minLength: 1, maxLength: 256 },
    replyToMessageId: DISCORD_SNOWFLAKE_SCHEMA,
  },
  required: [
    'v',
    'channelId',
    'channelKind',
    'messageId',
    'text',
    'textTruncated',
    'addressingEvidence',
    'contentProvenance',
    'actorKind',
  ],
} satisfies PluginJsonSchema;

export const DISCORD_AUTOMATION_MESSAGE_SETUP_INPUT_HINTS = {
  title: {
    key: 'discord.automation.messageSource.setup.title',
    fallback: 'Watch a Discord channel',
  },
  description: {
    key: 'discord.automation.messageSource.setup.description',
    fallback: 'Choose the Discord bot and the channel whose messages should start this Automation.',
  },
  submitLabel: {
    key: 'discord.automation.messageSource.setup.submit',
    fallback: 'Watch channel',
  },
  fields: [{
    path: 'credentialRef',
    title: {
      key: 'discord.automation.messageSource.setup.credential',
      fallback: 'Discord bot account',
    },
    description: {
      key: 'discord.automation.messageSource.setup.credential.description',
      fallback: 'Choose the existing Discord bot Connected Account; bot tokens are never entered here.',
    },
    widget: 'select',
    connectedAccountOptions: true,
    required: true,
    requireExplicitSelection: true,
  }, {
    path: 'channelId',
    title: {
      key: 'discord.automation.messageSource.setup.channel',
      fallback: 'Channel ID',
    },
    description: {
      key: 'discord.automation.messageSource.setup.channel.description',
      fallback: 'Enter the Discord channel ID the bot can already read.',
    },
    placeholder: '123456789012345678',
    widget: 'text',
    required: true,
  }],
} as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSnowflake(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9]{1,64}$/u.test(value) ? value : null;
}

export function parseDiscordAutomationMessageSourceConfig(
  value: unknown,
): DiscordAutomationMessageSourceConfigV1 | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const applicationId = readSnowflake(value.applicationId);
  const channelId = readSnowflake(value.channelId);
  if (applicationId === null || channelId === null) return null;
  return Object.freeze({ v: 1, applicationId, channelId });
}

export function createDiscordAutomationMessageSourceInstanceId(
  config: DiscordAutomationMessageSourceConfigV1,
): string {
  return `discord:application:${config.applicationId}:channel:${config.channelId}`;
}

/**
 * Projects the exact normalized ingress the Gateway already produced for
 * Channels into this Event's payload. Only a full-text observation becomes an
 * Automation occurrence: a `routableNonAdmission` shell carries no message
 * content, so it cannot answer what a user's Automation prompt would read.
 */
export function createDiscordAutomationMessagePayload(input: Readonly<{
  observation: DiscordFullTextObservationV1;
}>): DiscordAutomationMessagePayloadV1 | null {
  const { observation } = input;
  const channelId = readDiscordChannelEndpointId(observation.endpoint.id);
  if (channelId === null) return null;
  const channelKind = observation.endpoint.kind;
  if (channelKind !== 'direct' && channelKind !== 'shared' && channelKind !== 'thread') {
    // The shared endpoint union spans every Channels provider. Only Discord's
    // own three conversation kinds can reach this provider's Gateway.
    return null;
  }
  const parentEndpointId = 'parentId' in observation.endpoint ? observation.endpoint.parentId : undefined;
  const parentChannelId = typeof parentEndpointId === 'string'
    ? readDiscordChannelEndpointId(parentEndpointId)
    : null;
  const codePoints = Array.from(observation.message.text);
  const textTruncated = codePoints.length > DISCORD_MESSAGE_CONTENT_MAX_CODE_POINTS;
  return Object.freeze({
    v: 1,
    channelId,
    channelKind,
    ...(parentChannelId === null ? {} : { parentChannelId }),
    messageId: observation.message.id,
    text: textTruncated
      ? codePoints.slice(0, DISCORD_MESSAGE_CONTENT_MAX_CODE_POINTS).join('')
      : observation.message.text,
    textTruncated,
    addressingEvidence: observation.message.addressingEvidence,
    contentProvenance: observation.message.contentProvenance,
    actorKind: observation.actor.kind,
    // An unauthored actor has no principal at all; `actorKind: 'unknown'` is
    // the filterable fact rather than a null leaf the host filter cannot address.
    ...(observation.actor.principalId === null
      ? {}
      : { actorPrincipalId: observation.actor.principalId }),
    ...(observation.message.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: observation.message.replyToMessageId }),
  });
}

function isDiscordCredentialRef(value: unknown): value is ConnectedAccountRef {
  if (!isRecord(value) || !isRecord(value.service)) return false;
  return value.service.pluginId === DISCORD_PLUGIN_ID
    && value.service.localId === DISCORD_BOT_CONNECTED_ACCOUNT_ID
    && typeof value.accountId === 'string'
    && value.accountId.trim().length > 0;
}

/**
 * The Automation composer's create arm. It resolves the selected channel with
 * the exact bound bot account and returns immutable source facts; it never
 * persists a token and never guesses a channel Discord did not return.
 */
export async function setupDiscordAutomationMessageSource(
  input: unknown,
  context: PluginInvocationContext,
): Promise<PluginEventAutomationSetupResultV1> {
  if (!isRecord(input) || !isDiscordCredentialRef(input.credentialRef)) {
    throw new PluginError({
      code: 'discord_automation_source_credential_invalid',
      message: 'A Discord Automation Event source requires a Discord bot Connected Account.',
    });
  }
  const channelId = readSnowflake(input.channelId);
  if (channelId === null) {
    throw new PluginError({
      code: 'discord_automation_source_channel_invalid',
      message: 'A Discord channel ID is a decimal snowflake.',
    });
  }
  const token = await materializeExactDiscordBotToken(context, input.credentialRef);
  if (typeof token !== 'string') {
    throw new PluginError({
      code: `discord_bot_${token.reason}`,
      message: token.diagnostic ?? 'The Discord bot account is unavailable.',
    });
  }
  const api = createDiscordBotApi({ token, http: context.services.http });
  const identity = await api.getIdentity({ signal: context.signal });
  if ('kind' in identity) {
    throw new PluginError({
      code: `discord_bot_${identity.reason}`,
      message: identity.diagnostic ?? 'Discord is unavailable.',
    });
  }
  const channel = await api.getChannel({ channelId }, { signal: context.signal });
  if (channel !== null && 'kind' in channel && channel.kind === 'notReady') {
    throw new PluginError({
      code: `discord_channel_${channel.reason}`,
      message: channel.diagnostic ?? 'Discord did not return the selected channel.',
    });
  }
  if (channel === null) {
    throw new PluginError({
      code: 'discord_automation_source_channel_unavailable',
      message: 'The selected Discord bot cannot see that channel.',
    });
  }
  const sourceConfig: DiscordAutomationMessageSourceConfigV1 = Object.freeze({
    v: 1,
    applicationId: identity.applicationId,
    channelId: channel.channelId,
  });
  const label = channel.label?.trim();
  return {
    v: 1,
    sourceInstanceId: createDiscordAutomationMessageSourceInstanceId(sourceConfig),
    sourceContractVersion: DISCORD_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
    sourceConfig,
    displayLabel: label ? `#${label}` : `Discord channel ${channel.channelId}`,
  };
}

export const DISCORD_AUTOMATION_MESSAGE_SETUP_HOST_ACCESS = Object.freeze([
  'discord-rest',
  DISCORD_BOT_CREDENTIAL_PURPOSE,
]);

import {
  type ConversationIngressAutomationEventCandidateV1,
  ConversationProviderAutomationEventAdmitInputV1Schema,
  type ConversationProviderAutomationEventAdmitResultV1,
  type ConversationNormalizedIngressV1,
} from '@happier-dev/channels-protocol/v1';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  admitCheckpointedPluginEventObservationV1,
  createPluginEventAutomationSetupResultV1JsonSchema,
  PluginEventAutomationSetupResultV1Schema,
  type PluginEventAutomationSetupResultV1,
} from '@happier-dev/plugin-sdk/events';

import {
  TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID,
  TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
} from './constants.js';
import { assertTelegramChannelsCoreCaller } from './channelsCoreCaller.js';
import type { TelegramBotIdentity, TelegramUpdate } from './telegramBotApi.js';

/**
 * The persisted source facts. The bot is identified by its immutable Telegram
 * id rather than by a credential reference, because the observing poll already
 * holds the exact authenticated bot identity for the Channel connection it is
 * running. Nothing here is a credential.
 */
export const TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    botId: { type: 'string', minLength: 1, maxLength: 64 },
    chatId: { type: 'string', minLength: 1, maxLength: 64 },
  },
  required: ['v', 'botId', 'chatId'],
} as const satisfies PluginJsonSchema;

export const TELEGRAM_AUTOMATION_MESSAGE_PAYLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chatId: { type: 'string', minLength: 1, maxLength: 64 },
    chatType: { type: 'string', enum: ['private', 'group', 'supergroup', 'channel'] },
    messageId: { type: 'string', minLength: 1, maxLength: 64 },
    text: { type: 'string', maxLength: 8192 },
    senderId: { type: 'string', maxLength: 64 },
    senderIsBot: { type: 'boolean' },
  },
  required: ['chatId', 'chatType', 'messageId', 'text', 'senderIsBot'],
} as const satisfies PluginJsonSchema;

export const TELEGRAM_AUTOMATION_MESSAGE_SETUP_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    credentialRef: QualifiedConnectedAccountRefJsonSchema,
    chatId: { type: 'string', minLength: 1, maxLength: 64 },
  },
  required: ['credentialRef', 'chatId'],
} as const satisfies PluginJsonSchema;

export const TELEGRAM_AUTOMATION_MESSAGE_SETUP_RESULT_SCHEMA =
  createPluginEventAutomationSetupResultV1JsonSchema(
    TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
    TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONFIG_SCHEMA,
  );

type TelegramAutomationSourceConfig = Readonly<{ botId: string; chatId: string }>;

export function buildTelegramAutomationSourceInstanceId(input: TelegramAutomationSourceConfig): string {
  return `telegram:chat:${input.botId}:${input.chatId}`;
}

/**
 * Resolves the operator-entered chat into the immutable source facts the
 * canonical Automation definition writer persists. It owns no Automation
 * state and performs no observation.
 */
export async function buildTelegramChatEventSourceSetupResult(input: Readonly<{
  botId: string;
  chatId: string;
  label: string | null;
}>): Promise<PluginEventAutomationSetupResultV1> {
  const sourceConfig = Object.freeze({ v: 1 as const, botId: input.botId, chatId: input.chatId });
  return PluginEventAutomationSetupResultV1Schema.parse({
    v: 1,
    sourceInstanceId: buildTelegramAutomationSourceInstanceId(sourceConfig),
    sourceContractVersion: TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
    sourceConfig,
    displayLabel: input.label?.trim() || `Chat ${input.chatId}`,
  });
}

/**
 * One Event candidate that travels with the matching Channels ingress. It is
 * only evidence: Channels persists, retries, and checkpoint-covers it before
 * this provider's stateless admission Action can run.
 */
export function createTelegramAutomationEventCandidate(input: Readonly<{
  identity: TelegramBotIdentity;
  update: TelegramUpdate;
  observation: ConversationNormalizedIngressV1;
}>): ConversationIngressAutomationEventCandidateV1 | null {
  if (
    input.observation.kind !== 'fullText'
    || input.update.kind !== 'message'
    || input.update.message === null
    || input.update.message.senderId === input.identity.id
    || input.observation.observation.occurrenceId !== `telegram:update:${input.update.updateId}`
  ) return null;
  const message = input.update.message;
  return {
    eventRef: {
      pluginId: 'happier.channel.telegram',
      localId: TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID,
    },
    sourceInstanceId: buildTelegramAutomationSourceInstanceId({
      botId: input.identity.id,
      chatId: message.chatId,
    }),
    sourceContractVersion: TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
    payload: {
      chatId: message.chatId,
      chatType: message.chatType,
      messageId: message.messageId,
      text: input.observation.observation.message.text,
      ...(message.senderId === null ? {} : { senderId: message.senderId }),
      senderIsBot: message.senderIsBot,
    },
  };
}

/**
 * Stateless bridge for a frozen Channels Event obligation. It only resolves
 * current matching Automation definitions and invokes their host admission;
 * Channels remains the sole observer, retry, currentness, and checkpoint owner.
 */
export async function admitTelegramAutomationEvent(
  input: unknown,
  context: PluginInvocationContext,
): Promise<ConversationProviderAutomationEventAdmitResultV1> {
  assertTelegramChannelsCoreCaller(context);
  const request = ConversationProviderAutomationEventAdmitInputV1Schema.parse(input);
  return admitCheckpointedPluginEventObservationV1({
    eventRef: request.candidate.eventRef,
    sourceInstanceId: request.candidate.sourceInstanceId,
    sourceContractVersion: request.candidate.sourceContractVersion,
    occurrenceId: request.occurrenceId,
    occurredAt: request.occurredAt,
    observationReceivedAt: request.observationReceivedAt,
    observedDelta: request.observedDelta,
    payload: request.candidate.payload,
  }, context);
}

export function throwTelegramAutomationSetupInvalid(): never {
  throw new PluginError({
    code: 'telegram_automation_source_input_invalid',
    message: 'The Telegram Automation Event source input is invalid.',
  });
}

import {
  ConversationProvidersContributionProtocolV1,
} from '@happier-dev/channels-protocol/v1';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import { telegramConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import {
  TELEGRAM_AUTOMATION_MESSAGE_SETUP_ACTION_ID,
  TELEGRAM_BOT_CONNECTED_ACCOUNT_ID,
  TELEGRAM_BOT_CREDENTIAL_PURPOSE,
  TELEGRAM_CHANNEL_ACTION_IDS,
  TELEGRAM_CHANNEL_PROVIDER_CONTRIBUTION_ID,
} from './constants.js';
import {
  TELEGRAM_AUTOMATION_MESSAGE_SETUP_INPUT_SCHEMA,
  TELEGRAM_AUTOMATION_MESSAGE_SETUP_RESULT_SCHEMA,
} from './automationEvents.js';
import {
  deliverTelegramMessage,
  pollTelegramObservations,
  setupTelegramChatEventSource,
  remediateTelegramWebhook,
  resolveTelegramEndpoint,
  setupTelegramChannels,
  testTelegramConnection,
  TELEGRAM_SETUP_INPUT_PROTOCOL_SCHEMA,
} from './channelActions.js';
import { TELEGRAM_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

const providers = ConversationProvidersContributionProtocolV1;

/**
 * The Channels provider protocol leaves `setup` and `setupRemediation` input
 * contributor-defined, so this plugin declares the shape. Both roles need
 * exactly the selected bot account and both handlers read the same
 * declaration, so the manifest the host enforces and the value the handler
 * receives cannot drift apart.
 */
const TELEGRAM_CREDENTIAL_REF_INPUT_SCHEMA: PluginJsonSchema =
  TELEGRAM_SETUP_INPUT_PROTOCOL_SCHEMA.jsonSchema;

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.channel.telegram',
  version: '0.0.0',
  displayName: 'Telegram Channels',
  description: 'Connects Telegram bot conversations to Happier Channels.',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [
      {
        id: 'telegram-bot-api',
        capability: 'network',
        reason: 'Verify the selected Telegram bot and inspect its polling transport through the Bot API.',
        scope: {
          targets: [{ kind: 'fixedOrigin', origin: 'https://api.telegram.org' }],
          methods: ['POST'],
        },
      },
      {
        id: TELEGRAM_BOT_CREDENTIAL_PURPOSE,
        capability: 'connectedAccounts',
        reason: 'Materialize the selected Telegram bot token only for Bot API calls.',
        scope: {
          serviceRefs: [TELEGRAM_BOT_CONNECTED_ACCOUNT_ID],
          operations: ['select', 'use'],
          materializationKinds: ['environment'],
        },
      },
    ],
    optional: [],
  },
  ui: {
    translations: TELEGRAM_UI_TRANSLATION_BUNDLES,
  },
  connectedAccountDescriptors: {
    [TELEGRAM_BOT_CONNECTED_ACCOUNT_ID]: {
      declaration: {
        title: 'Telegram bot',
        description: 'Telegram bot account used for Channel setup and delivery.',
        authentication: {
          defaultModeId: 'bot-token',
          modes: [
            {
              id: 'bot-token',
              kind: 'manual',
              title: 'Bot token',
              outcomeReconciliation: 'none',
              fields: [
                {
                  id: 'token',
                  title: 'Bot token',
                  description: 'Token issued by Telegram BotFather for this bot.',
                  schema: { type: 'string', minLength: 1 },
                  secret: true,
                },
              ],
            },
          ],
        },
      },
      runtime: telegramConnectedAccountRuntime,
    },
  },
  actions: {
    [TELEGRAM_CHANNEL_ACTION_IDS.setup]: {
      title: 'Set up Telegram Channels',
      execution: { target: 'daemon' },
      inputSchema: TELEGRAM_CREDENTIAL_REF_INPUT_SCHEMA,
      resultSchema: providers.operations.setup.declaration.resultSchema.jsonSchema,
      scopes: ['global'],
      // Core owns the present-user setup flow and persistence. This provider
      // returns only setup facts, so direct UI invocation would strand them.
      surfaces: providers.operations.setup.declaration.surfaces,
      hostAccess: ['telegram-bot-api', TELEGRAM_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: TELEGRAM_BOT_CREDENTIAL_PURPOSE,
      }],
      dangerLevel: providers.operations.setup.declaration.dangerLevel,
      inputHints: {
        title: { key: 'channels.telegram.setup.title', fallback: 'Set up Telegram Channels' },
        description: {
          key: 'channels.telegram.setup.description',
          fallback: 'Select the Connected Account for the Telegram bot to verify.',
        },
        submitLabel: { key: 'channels.telegram.setup.submit', fallback: 'Verify bot' },
        fields: [
          {
            path: 'credentialRef',
            title: { key: 'channels.telegram.setup.credential', fallback: 'Telegram bot account' },
            description: {
              key: 'channels.telegram.setup.credential.description',
              fallback: 'Choose the existing Telegram bot Connected Account; bot tokens are never entered here.',
            },
            widget: 'select',
            connectedAccountOptions: true,
            required: true,
          },
        ],
      },
      run: setupTelegramChannels,
    },
    [TELEGRAM_CHANNEL_ACTION_IDS.setupRemediation]: {
      title: 'Remove Telegram webhook',
      execution: { target: 'daemon' },
      description: 'Remove the selected bot’s webhook so Happier can use checkpointed polling.',
      inputSchema: TELEGRAM_CREDENTIAL_REF_INPUT_SCHEMA,
      resultSchema: providers.operations.setupRemediation.declaration.resultSchema.jsonSchema,
      scopes: ['global'],
      surfaces: providers.operations.setupRemediation.declaration.surfaces,
      hostAccess: ['telegram-bot-api', TELEGRAM_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: TELEGRAM_BOT_CREDENTIAL_PURPOSE,
      }],
      dangerLevel: providers.operations.setupRemediation.declaration.dangerLevel,
      confirmation: {
        title: 'Remove Telegram webhook?',
        body: 'Telegram will stop delivering new updates to the current webhook. Pending updates will not be discarded.',
        confirmLabel: 'Remove webhook',
      },
      inputHints: {
        title: { key: 'channels.telegram.remediation.title', fallback: 'Remove Telegram webhook' },
        description: {
          key: 'channels.telegram.remediation.description',
          fallback: 'Select the Telegram bot whose webhook you want to remove.',
        },
        submitLabel: { key: 'channels.telegram.remediation.submit', fallback: 'Continue' },
        fields: [
          {
            path: 'credentialRef',
            title: { key: 'channels.telegram.remediation.credential', fallback: 'Telegram bot account' },
            description: {
              key: 'channels.telegram.remediation.credential.description',
              fallback: 'Choose the existing Telegram bot Connected Account; bot tokens are never entered here.',
            },
            widget: 'select',
            connectedAccountOptions: true,
            required: true,
          },
        ],
      },
      run: remediateTelegramWebhook,
    },
    [TELEGRAM_CHANNEL_ACTION_IDS.connectionTest]: {
      title: 'Test Telegram Channel connection',
      execution: { target: 'daemon' },
      inputSchema: providers.operations.connectionTest.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.connectionTest.declaration.resultSchema.jsonSchema,
      scopes: ['global'],
      surfaces: providers.operations.connectionTest.declaration.surfaces,
      hostAccess: ['telegram-bot-api', TELEGRAM_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: TELEGRAM_BOT_CREDENTIAL_PURPOSE,
      }],
      dangerLevel: providers.operations.connectionTest.declaration.dangerLevel,
      run: testTelegramConnection,
    },
    [TELEGRAM_CHANNEL_ACTION_IDS.endpointResolve]: {
      title: 'Resolve Telegram Channel destination',
      execution: { target: 'daemon' },
      inputSchema: providers.operations.endpointResolve.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.endpointResolve.declaration.resultSchema.jsonSchema,
      scopes: ['global'],
      surfaces: providers.operations.endpointResolve.declaration.surfaces,
      hostAccess: ['telegram-bot-api', TELEGRAM_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: TELEGRAM_BOT_CREDENTIAL_PURPOSE,
      }],
      dangerLevel: providers.operations.endpointResolve.declaration.dangerLevel,
      run: resolveTelegramEndpoint,
    },
    [TELEGRAM_CHANNEL_ACTION_IDS.observationsPoll]: {
      title: 'Poll Telegram Channel observations',
      execution: { target: 'daemon' },
      inputSchema: providers.operations.observationsPoll.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.observationsPoll.declaration.resultSchema.jsonSchema,
      scopes: ['global'],
      surfaces: providers.operations.observationsPoll.declaration.surfaces,
      hostAccess: ['telegram-bot-api', TELEGRAM_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: TELEGRAM_BOT_CREDENTIAL_PURPOSE,
      }],
      dangerLevel: providers.operations.observationsPoll.declaration.dangerLevel,
      run: pollTelegramObservations,
    },
    [TELEGRAM_CHANNEL_ACTION_IDS.messageDeliver]: {
      title: 'Deliver a Telegram Channel message',
      execution: { target: 'daemon' },
      inputSchema: providers.operations.messageDeliver.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.messageDeliver.declaration.resultSchema.jsonSchema,
      scopes: ['global'],
      surfaces: providers.operations.messageDeliver.declaration.surfaces,
      hostAccess: ['telegram-bot-api', TELEGRAM_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: TELEGRAM_BOT_CREDENTIAL_PURPOSE,
      }],
      dangerLevel: providers.operations.messageDeliver.declaration.dangerLevel,
      run: deliverTelegramMessage,
    },
    // The Automation Event this Action resolves a source for is WITHHELD from
    // this manifest; the withheld-declaration note below owns why and what a
    // durable observation needs. The Action stays declared so the retained
    // admission work keeps its one registered entry point, and it is reachable
    // only from the `plugin` surface — the composer reaches a setup Action only
    // through an eligible Event, so nothing user-facing offers an Automation
    // that cannot exist.
    [TELEGRAM_AUTOMATION_MESSAGE_SETUP_ACTION_ID]: {
      title: 'Choose a Telegram chat to watch',
      description: 'Resolves a Telegram chat to immutable source facts for an Automation Event.',
      execution: { target: 'daemon' },
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: TELEGRAM_AUTOMATION_MESSAGE_SETUP_INPUT_SCHEMA,
      resultSchema: TELEGRAM_AUTOMATION_MESSAGE_SETUP_RESULT_SCHEMA,
      hostAccess: ['telegram-bot-api', TELEGRAM_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: TELEGRAM_BOT_CREDENTIAL_PURPOSE,
      }],
      inputHints: {
        title: { key: 'channels.telegram.automation.setup.title', fallback: 'Choose a Telegram chat to watch' },
        description: {
          key: 'channels.telegram.automation.setup.description',
          fallback: 'Pick the Telegram bot and the chat whose messages should start this Automation.',
        },
        submitLabel: { key: 'channels.telegram.automation.setup.submit', fallback: 'Use this chat' },
        fields: [
          {
            path: 'credentialRef',
            title: { key: 'channels.telegram.automation.setup.credential', fallback: 'Telegram bot account' },
            widget: 'select',
            connectedAccountOptions: true,
            required: true,
          },
          {
            path: 'chatId',
            title: { key: 'channels.telegram.automation.setup.chat', fallback: 'Chat ID' },
            widget: 'text',
            description: {
              key: 'channels.telegram.automation.setup.chat.description',
              fallback: 'The numeric Telegram chat id, or an @channelusername the bot can reach.',
            },
            required: true,
          },
        ],
      },
      run: setupTelegramChatEventSource,
    },
  },
  // This provider declares no Event. Its `automation/chat-message-v1` Automation
  // Event declaration is WITHHELD (product decision, 2026-08-20), so no
  // Automation can arm a Telegram chat source.
  //
  // Telegram `getUpdates` is single-consumer: one `offset` confirms and
  // discards every earlier update for every reader of the bot. The admission in
  // `automationEvents.ts` would run inline inside that shared cycle with no
  // durable obligation, so a catalog or admission outage could only choose
  // between losing occurrences and stalling Channel delivery for every user of
  // the bot. `pollTelegramObservations` therefore reaches no Automation
  // authority at all while this Event is withheld.
  //
  // Before this is declared, the occurrence must become a durable obligation in
  // the SAME ingress store the canonical Channels owner already uses
  // (`packages/plugins/channels/src/ingress.ts`: `retryDueIngressObligationValue`,
  // `blockedIngressObligationValue`, `MAX_CONVERSATION_DELIVERY_ATTEMPTS`,
  // `unsettled`/`checkpointSafe`), persisted BEFORE the shared offset advances —
  // one shared single-consumer lifecycle, no second `getUpdates` consumer, no
  // provider-local replay ledger, no new store. The implementation stays whole
  // on disk in `automationEvents.ts`; re-declaring the Event restores its one
  // call site in `pollTelegramObservations`.
  contributesTo: {
    'happier.channels': {
      providers: {
        [TELEGRAM_CHANNEL_PROVIDER_CONTRIBUTION_ID]: providers.contribute({
          operations: {
            setup: providers.operations.setup.bind(TELEGRAM_CHANNEL_ACTION_IDS.setup),
            setupRemediation: providers.operations.setupRemediation.bind(
              TELEGRAM_CHANNEL_ACTION_IDS.setupRemediation,
            ),
            connectionTest: providers.operations.connectionTest.bind(TELEGRAM_CHANNEL_ACTION_IDS.connectionTest),
            endpointResolve: providers.operations.endpointResolve.bind(TELEGRAM_CHANNEL_ACTION_IDS.endpointResolve),
            observationsPoll: providers.operations.observationsPoll.bind(TELEGRAM_CHANNEL_ACTION_IDS.observationsPoll),
            messageDeliver: providers.operations.messageDeliver.bind(TELEGRAM_CHANNEL_ACTION_IDS.messageDeliver),
          },
        }),
      },
    },
  },
});

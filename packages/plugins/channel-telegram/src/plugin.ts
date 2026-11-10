import { setupTelegramNotificationDestination, sendTelegramNotification } from './channelActions.js';
import {
  ConversationProvidersContributionProtocolV1,
  CONVERSATION_CORE_PLUGIN_ID_V1,
} from '@happier-dev/channels-protocol/v1';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import { telegramConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import {
  TELEGRAM_AUTOMATION_MESSAGE_ADMIT_ACTION_ID,
  TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID,
  TELEGRAM_AUTOMATION_MESSAGE_SETUP_ACTION_ID,
  TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
  TELEGRAM_BOT_CONNECTED_ACCOUNT_ID,
  TELEGRAM_BOT_CREDENTIAL_PURPOSE,
  TELEGRAM_BRAND_RESOURCE_ID,
  TELEGRAM_CHANNEL_ACTION_IDS,
  TELEGRAM_CHANNEL_PLUGIN_ID,
  TELEGRAM_CHANNEL_PROVIDER_CONTRIBUTION_ID,
} from './constants.js';
import {
  admitTelegramAutomationEvent,
  TELEGRAM_AUTOMATION_MESSAGE_PAYLOAD_SCHEMA,
  TELEGRAM_AUTOMATION_MESSAGE_SETUP_INPUT_HINTS,
  TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONFIG_SCHEMA,
  TELEGRAM_AUTOMATION_MESSAGE_SETUP_INPUT_SCHEMA,
  TELEGRAM_AUTOMATION_MESSAGE_SETUP_RESULT_SCHEMA,
} from './automationEvents.js';
import {
  deliverTelegramMessage,
  fetchTelegramAttachments,
  pollTelegramObservations,
  setupTelegramChatEventSource,
  remediateTelegramWebhook,
  resolveTelegramEndpoint,
  setupTelegramChannels,
  testTelegramConnection,
  TELEGRAM_SETUP_INPUT_PROTOCOL_SCHEMA,
  TELEGRAM_SETUP_GUIDANCE,
} from './channelActions.js';


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
  id: TELEGRAM_CHANNEL_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Telegram Channels',
  description: 'Connects Telegram bot conversations to Happier Channels.',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  brand: { iconResourceId: TELEGRAM_BRAND_RESOURCE_ID },
  hostAccess: {
    required: [
      {
        id: 'telegram-bot-api',
        capability: 'network',
        reason: 'Verify the selected Telegram bot and inspect its polling transport through the Bot API.',
        scope: {
          targets: [{ kind: 'fixedOrigin', origin: 'https://api.telegram.org' }],
          methods: ['POST', 'GET'],
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
  resources: {
    [TELEGRAM_BRAND_RESOURCE_ID]: {
      kind: 'asset',
      path: 'assets/brand.png',
      contentType: 'image/png',
    },
    "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
    "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
    "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
    "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
    "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
    "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
    "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
    "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
    "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
    "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
    "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
    "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
  },
  ui: {
    translations: [
      { locale: "en", resourceId: "i18n-en" },
      { locale: "de", resourceId: "i18n-de" },
      { locale: "ru", resourceId: "i18n-ru" },
      { locale: "pl", resourceId: "i18n-pl" },
      { locale: "es", resourceId: "i18n-es" },
      { locale: "fr", resourceId: "i18n-fr" },
      { locale: "it", resourceId: "i18n-it" },
      { locale: "pt", resourceId: "i18n-pt" },
      { locale: "ca", resourceId: "i18n-ca" },
      { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
      { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
      { locale: "ja", resourceId: "i18n-ja" },
    ],
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
              setup: {
                url: 'https://t.me/BotFather',
                checklist: ['Open Telegram BotFather and send /newbot to create a bot, or select an existing bot.', 'Copy the bot API token issued by BotFather and paste it here.'],
                createKeyTitle: 'Open Telegram BotFather',
              },
              credentialOrigin: 'authentication',
              directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
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
  notificationChannels: { alerts: { declaration: { title: 'Telegram', kind: 'plugin', metadata: { destinationSetup: { pluginId: TELEGRAM_CHANNEL_PLUGIN_ID, localId: TELEGRAM_CHANNEL_ACTION_IDS.notificationSetup } } }, sender: sendTelegramNotification } },
  actions: {
    [TELEGRAM_CHANNEL_ACTION_IDS.notificationSetup]: {
      title: 'Choose Telegram notification destination',
      surfaces: providers.operations.notificationDestinationSetup.declaration.surfaces,
      dangerLevel: providers.operations.notificationDestinationSetup.declaration.dangerLevel,
      inputSchema: providers.operations.notificationDestinationSetup.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.notificationDestinationSetup.declaration.resultSchema.jsonSchema,
      hostAccess: ['telegram-bot-api', TELEGRAM_BOT_CREDENTIAL_PURPOSE],
      run: setupTelegramNotificationDestination,
    },
    [TELEGRAM_CHANNEL_ACTION_IDS.setup]: {
      title: 'Set up Telegram Channels',
      description: 'Verifies the selected Telegram bot for Channels setup.',
      inputSchema: TELEGRAM_CREDENTIAL_REF_INPUT_SCHEMA,
      resultSchema: providers.operations.setup.declaration.resultSchema.jsonSchema,
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
      description: 'Remove the selected bot’s webhook so Happier can use checkpointed polling.',
      inputSchema: TELEGRAM_CREDENTIAL_REF_INPUT_SCHEMA,
      resultSchema: providers.operations.setupRemediation.declaration.resultSchema.jsonSchema,
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
      description: 'Tests the selected Telegram Channel connection.',
      inputSchema: providers.operations.connectionTest.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.connectionTest.declaration.resultSchema.jsonSchema,
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
      title: 'Resolve Telegram chat destination',
      description: 'Resolves a Telegram direct chat, group, supergroup, or topic for delivery; broadcast channels are unsupported.',
      inputSchema: providers.operations.endpointResolve.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.endpointResolve.declaration.resultSchema.jsonSchema,
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
      description: 'Polls the selected Telegram bot for new Channel observations.',
      inputSchema: providers.operations.observationsPoll.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.observationsPoll.declaration.resultSchema.jsonSchema,
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
      description: 'Delivers a message to the selected Telegram Channel destination.',
      inputSchema: providers.operations.messageDeliver.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.messageDeliver.declaration.resultSchema.jsonSchema,
      surfaces: providers.operations.messageDeliver.declaration.surfaces,
      hostAccess: ['telegram-bot-api', TELEGRAM_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: TELEGRAM_BOT_CREDENTIAL_PURPOSE,
      }],
      dangerLevel: providers.operations.messageDeliver.declaration.dangerLevel,
      run: deliverTelegramMessage,
    },
    [TELEGRAM_CHANNEL_ACTION_IDS.attachmentFetch]: {
      title: 'Fetch Telegram Channel attachments',
      description: 'Downloads admitted Telegram attachments when a Session materializes them.',
      inputSchema: providers.operations.attachmentFetch.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.attachmentFetch.declaration.resultSchema.jsonSchema,
      surfaces: providers.operations.attachmentFetch.declaration.surfaces,
      hostAccess: ['telegram-bot-api', TELEGRAM_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: TELEGRAM_BOT_CREDENTIAL_PURPOSE }],
      dangerLevel: providers.operations.attachmentFetch.declaration.dangerLevel,
      run: fetchTelegramAttachments,
    },
    [TELEGRAM_AUTOMATION_MESSAGE_SETUP_ACTION_ID]: {
      title: 'Choose a Telegram chat to watch',
      description: 'Resolves a Telegram chat to immutable source facts for a Workflow Event.',
      surfaces: ['plugin'],
      inputSchema: TELEGRAM_AUTOMATION_MESSAGE_SETUP_INPUT_SCHEMA,
      resultSchema: TELEGRAM_AUTOMATION_MESSAGE_SETUP_RESULT_SCHEMA,
      hostAccess: ['telegram-bot-api', TELEGRAM_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: TELEGRAM_BOT_CREDENTIAL_PURPOSE,
      }],
      inputHints: TELEGRAM_AUTOMATION_MESSAGE_SETUP_INPUT_HINTS,
      run: setupTelegramChatEventSource,
    },
    [TELEGRAM_AUTOMATION_MESSAGE_ADMIT_ACTION_ID]: {
      title: 'Admit Telegram Workflow Event',
      description: 'Admits one frozen Telegram Workflow Event obligation through the current source definitions.',
      surfaces: providers.operations.automationEventAdmit.declaration.surfaces,
      dangerLevel: providers.operations.automationEventAdmit.declaration.dangerLevel,
      inputSchema: providers.operations.automationEventAdmit.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.automationEventAdmit.declaration.resultSchema.jsonSchema,
      run: admitTelegramAutomationEvent,
    },
  },
  events: {
    [TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID]: {
      declaration: {
        kind: 'event',
        title: 'Telegram chat message',
        description: 'A Telegram chat message observed through the selected Channels poll.',
        payloadSchema: TELEGRAM_AUTOMATION_MESSAGE_PAYLOAD_SCHEMA,
        automation: {
          v: 1,
          eligible: true,
          source: {
            sourceContractVersion: TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
            supportedObservationTransports: ['checkpointedPull'],
            sourceConfigSchema: TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONFIG_SCHEMA,
            setupActionRef: {
              pluginId: TELEGRAM_CHANNEL_PLUGIN_ID,
              localId: TELEGRAM_AUTOMATION_MESSAGE_SETUP_ACTION_ID,
            },
          },
        },
      },
    },
  },
  contributesTo: {
    [CONVERSATION_CORE_PLUGIN_ID_V1]: {
      providers: {
        [TELEGRAM_CHANNEL_PROVIDER_CONTRIBUTION_ID]: providers.contribute({
          descriptor: { v: 1, displayName: 'Telegram', setupGuidance: TELEGRAM_SETUP_GUIDANCE },
          operations: {
            setup: providers.operations.setup.bind(TELEGRAM_CHANNEL_ACTION_IDS.setup),
            setupRemediation: providers.operations.setupRemediation.bind(
              TELEGRAM_CHANNEL_ACTION_IDS.setupRemediation,
            ),
            notificationDestinationSetup: providers.operations.notificationDestinationSetup.bind(TELEGRAM_CHANNEL_ACTION_IDS.notificationSetup),
      connectionTest: providers.operations.connectionTest.bind(TELEGRAM_CHANNEL_ACTION_IDS.connectionTest),
            endpointResolve: providers.operations.endpointResolve.bind(TELEGRAM_CHANNEL_ACTION_IDS.endpointResolve),
            observationsPoll: providers.operations.observationsPoll.bind(TELEGRAM_CHANNEL_ACTION_IDS.observationsPoll),
            automationEventAdmit: providers.operations.automationEventAdmit.bind(
              TELEGRAM_AUTOMATION_MESSAGE_ADMIT_ACTION_ID,
            ),
            messageDeliver: providers.operations.messageDeliver.bind(TELEGRAM_CHANNEL_ACTION_IDS.messageDeliver),
            attachmentFetch: providers.operations.attachmentFetch.bind(TELEGRAM_CHANNEL_ACTION_IDS.attachmentFetch),
          },
        }),
      },
    },
  },
});

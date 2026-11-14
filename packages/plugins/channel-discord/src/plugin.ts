import { setupDiscordNotificationDestination, sendDiscordNotification } from './discordActions.js';
import { definePlugin, type DefinedPlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ActionContract } from '@happier-dev/plugin-sdk/actions';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
  ConversationProviderConnectionReconciliationSnapshotV1JsonSchema,
  ConversationProviderConnectionReconciliationSnapshotV1Schema,
  ConversationProvidersContributionProtocolV1,
} from '@happier-dev/channels-protocol/v1';

import { discordConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import {
  DISCORD_BOT_CONNECTED_ACCOUNT_ID,
  DISCORD_BOT_CREDENTIAL_PURPOSE,
  DISCORD_BRAND_RESOURCE_ID,
  DISCORD_CHANNEL_ACTION_IDS,
  DISCORD_GATEWAY_BACKGROUND_SERVICE_ID,
  DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID,
  DISCORD_PLUGIN_ID,
} from './discordPluginConstants.js';
import {
  deliverDiscordMessage,
  fetchDiscordAttachment,
  resolveDiscordEndpoint,
  setupDiscordChannels,
  testDiscordConnection,
  DISCORD_SETUP_INPUT_PROTOCOL_SCHEMA,
} from './discordActions.js';
import {
  createDiscordGatewaySupervisor,
  type DiscordGatewaySupervisor,
} from './discordGatewaySupervisor.js';
import {
  DISCORD_AUTOMATION_MESSAGE_ADMIT_ACTION_ID,
  DISCORD_AUTOMATION_MESSAGE_EVENT_ID,
  DISCORD_AUTOMATION_MESSAGE_PAYLOAD_SCHEMA,
  DISCORD_AUTOMATION_MESSAGE_SOURCE_CONFIG_SCHEMA,
  DISCORD_AUTOMATION_MESSAGE_SETUP_ACTION_ID,
  DISCORD_AUTOMATION_MESSAGE_SETUP_HOST_ACCESS,
  DISCORD_AUTOMATION_MESSAGE_SETUP_INPUT_HINTS,
  DISCORD_AUTOMATION_MESSAGE_SETUP_INPUT_SCHEMA,
  DISCORD_AUTOMATION_MESSAGE_SETUP_RESULT_SCHEMA,
  DISCORD_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
  setupDiscordAutomationMessageSource,
} from './discordAutomationEvent.js';
import { admitDiscordAutomationEvent } from './discordAutomationEventAdmission.js';


const discordProviderProtocol = ConversationProvidersContributionProtocolV1;
const discordProviderOperations = discordProviderProtocol.operations;

const connectionTestOperation = discordProviderOperations.connectionTest;
const endpointResolveOperation = discordProviderOperations.endpointResolve;
const messageDeliverOperation = discordProviderOperations.messageDeliver;
const attachmentFetchOperation = discordProviderOperations.attachmentFetch;
const automationEventAdmitOperation = discordProviderOperations.automationEventAdmit;

/**
 * The setup handler reads the same declaration, so the manifest the host
 * enforces and the value that handler receives cannot drift apart.
 */
const DISCORD_SETUP_INPUT_SCHEMA: PluginJsonSchema = DISCORD_SETUP_INPUT_PROTOCOL_SCHEMA.jsonSchema;

/**
 * The Gateway worker receives the canonical core reconciliation union. Its
 * exact Account binding is still manifest-owned, so expose only that shared
 * nullable leaf at an object root and retain the complete union below it.
 */
const DISCORD_GATEWAY_WORKER_ATTEMPT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    credentialRef: {
      anyOf: [QualifiedConnectedAccountRefJsonSchema, { type: 'null' }],
    },
  },
  required: ['credentialRef'],
  allOf: [ConversationProviderConnectionReconciliationSnapshotV1JsonSchema],
} satisfies PluginJsonSchema;

type DiscordGatewayActivationBindings = Readonly<{
  run: DiscordGatewaySupervisor['run'];
  invalidateConnections(): void;
  runWorkerAttempt: (
    input: unknown,
    context: Parameters<DiscordGatewaySupervisor['runWorkerAttempt']>[1],
  ) => Promise<void>;
  setup(): () => Promise<void>;
}>;

/**
 * definePlugin registers role and background callbacks before setup. These
 * closures retain one activation-local supervisor without giving the module a
 * second lifecycle owner or allowing a stale cleanup to clear a replacement.
 */
function createDiscordGatewayActivationBindings(): DiscordGatewayActivationBindings {
  let currentSupervisor: DiscordGatewaySupervisor | null = null;

  const requireCurrentSupervisor = (): DiscordGatewaySupervisor => {
    if (currentSupervisor === null) {
      throw new Error('Discord Gateway supervisor is not active.');
    }
    return currentSupervisor;
  };

  return Object.freeze({
    invalidateConnections() {
      currentSupervisor?.invalidateConnections();
    },
    async run(context) {
      await requireCurrentSupervisor().run(context);
    },
    async runWorkerAttempt(input, context) {
      await requireCurrentSupervisor().runWorkerAttempt(
        ConversationProviderConnectionReconciliationSnapshotV1Schema.parse(input),
        context,
      );
    },
    setup() {
      if (currentSupervisor !== null) {
        throw new Error('Discord Gateway supervisor is already active.');
      }
      const supervisor = createDiscordGatewaySupervisor();
      currentSupervisor = supervisor;
      return async () => {
        try {
          await supervisor.dispose();
        } finally {
          if (currentSupervisor === supervisor) currentSupervisor = null;
        }
      };
    },
  });
}

function createDiscordPlugin() {
  const gatewayActivationBindings = createDiscordGatewayActivationBindings();

  return definePlugin({
  id: DISCORD_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Discord Channels',
  description: 'Connects Discord conversations to Happier Channels.',
  activation: { events: [], configuration: { accountCollections: [{ pluginId: 'happier.channels', collectionId: 'channel-state' }] } },
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  brand: { iconResourceId: DISCORD_BRAND_RESOURCE_ID },
  hostAccess: {
    required: [
      {
        id: 'discord-rest',
        capability: 'network',
        reason: 'Verify Discord application identity and send messages through Discord REST.',
        scope: {
          targets: [{ kind: 'fixedOrigin', origin: 'https://discord.com' }],
          // The REST codec issues GET reads and POST sends only; it never
          // PATCHes (archived threads rely on the core-owned recovery outcome).
          methods: ['GET', 'POST'],
        },
      },
      {
        id: 'discord-attachments',
        capability: 'network',
        reason: 'Download admitted Discord files from refreshed native attachment URLs.',
        scope: {
          targets: [{ kind: 'fixedOrigin', origin: 'https://cdn.discordapp.com' }],
          methods: ['GET'],
        },
      },
      {
        id: 'discord-gateway',
        capability: 'network.client',
        reason: 'Maintain the selected Discord Gateway connection for authenticated conversation events.',
        scope: {
          targets: [{ kind: 'httpsHostSuffix', hostSuffix: 'discord.gg' }],
          transports: ['websocket'],
        },
      },
      {
        id: DISCORD_BOT_CREDENTIAL_PURPOSE,
        capability: 'connectedAccounts',
        reason: 'Materialize only the exact selected Discord bot token for REST and Gateway calls.',
        scope: {
          serviceRefs: [DISCORD_BOT_CONNECTED_ACCOUNT_ID],
          operations: ['select', 'use'],
          materializationKinds: ['environment'],
        },
      },
    ],
    optional: [],
  },
  resources: {
    [DISCORD_BRAND_RESOURCE_ID]: {
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
    [DISCORD_BOT_CONNECTED_ACCOUNT_ID]: {
      declaration: {
        title: 'Discord bot',
        description: 'Discord bot account used for Channel setup, delivery, and Gateway observation.',
        authentication: {
          defaultModeId: 'bot-token',
          modes: [
            {
              id: 'bot-token',
              kind: 'manual',
              setup: {
                url: 'https://discord.com/developers/applications',
                checklist: ['Create or select an application in the [Discord Developer Portal] and open its Bot settings.', 'Copy its bot token; if it is no longer visible, Reset Token creates a replacement and invalidates the old token.', 'Paste the bot token here.'],
                createKeyTitle: 'Open Discord applications',
              },
              credentialOrigin: 'authentication',
              directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
              title: 'Bot token',
              outcomeReconciliation: 'none',
              fields: [
                {
                  id: 'token',
                  title: 'Bot token',
                  description: 'Token issued by the Discord Developer Portal for this bot.',
                  schema: { type: 'string', minLength: 1 },
                  secret: true,
                },
              ],
            },
          ],
        },
      },
      runtime: discordConnectedAccountRuntime,
    },
  },
  notificationChannels: { alerts: { declaration: { title: 'Discord', kind: 'plugin', metadata: { destinationSetup: { pluginId: DISCORD_PLUGIN_ID, localId: DISCORD_CHANNEL_ACTION_IDS.notificationSetup } } }, sender: sendDiscordNotification } },
  actions: {
    [DISCORD_CHANNEL_ACTION_IDS.notificationSetup]: {
      title: 'Choose Discord notification destination',
      surfaces: discordProviderOperations.notificationDestinationSetup.declaration.surfaces,
      dangerLevel: discordProviderOperations.notificationDestinationSetup.declaration.dangerLevel,
      inputSchema: discordProviderOperations.notificationDestinationSetup.declaration.input.schema.jsonSchema,
      resultSchema: discordProviderOperations.notificationDestinationSetup.declaration.resultSchema.jsonSchema,
      hostAccess: ['discord-rest', DISCORD_BOT_CREDENTIAL_PURPOSE],
      run: setupDiscordNotificationDestination,
    },
    [DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID]: {
      title: 'Run Discord Gateway worker attempt',
      description: 'Runs one Discord Gateway worker attempt.',
      surfaces: ['plugin'],
      inputSchema: DISCORD_GATEWAY_WORKER_ATTEMPT_INPUT_SCHEMA,
      hostAccess: ['discord-rest', 'discord-gateway', DISCORD_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: DISCORD_BOT_CREDENTIAL_PURPOSE,
      }],
      run: gatewayActivationBindings.runWorkerAttempt,
    },
    [DISCORD_AUTOMATION_MESSAGE_SETUP_ACTION_ID]: {
      title: 'Watch a Discord channel for Workflows',
      description: 'Resolves a Discord channel to immutable source facts for a Workflow Event.',
      surfaces: ['ui', 'plugin'],
      inputSchema: DISCORD_AUTOMATION_MESSAGE_SETUP_INPUT_SCHEMA,
      inputHints: DISCORD_AUTOMATION_MESSAGE_SETUP_INPUT_HINTS,
      resultSchema: DISCORD_AUTOMATION_MESSAGE_SETUP_RESULT_SCHEMA,
      hostAccess: [...DISCORD_AUTOMATION_MESSAGE_SETUP_HOST_ACCESS],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: DISCORD_BOT_CREDENTIAL_PURPOSE,
      }],
      run: setupDiscordAutomationMessageSource,
    },
    [DISCORD_AUTOMATION_MESSAGE_ADMIT_ACTION_ID]: {
      title: 'Admit Discord Workflow Event',
      description: 'Admits one frozen Discord Workflow Event obligation through the current source definitions.',
      surfaces: automationEventAdmitOperation.declaration.surfaces,
      dangerLevel: automationEventAdmitOperation.declaration.dangerLevel,
      inputSchema: automationEventAdmitOperation.declaration.input.schema.jsonSchema,
      resultSchema: automationEventAdmitOperation.declaration.resultSchema.jsonSchema,
      run: admitDiscordAutomationEvent,
    },
    [DISCORD_CHANNEL_ACTION_IDS.setup]: {
      title: 'Set up Discord Channels',
      description: 'Verifies the selected Discord bot for Channels setup.',
      surfaces: discordProviderOperations.setup.declaration.surfaces,
      dangerLevel: discordProviderOperations.setup.declaration.dangerLevel,
      inputSchema: DISCORD_SETUP_INPUT_SCHEMA,
      resultSchema: discordProviderOperations.setup.declaration.resultSchema.jsonSchema,
      hostAccess: ['discord-rest', DISCORD_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: DISCORD_BOT_CREDENTIAL_PURPOSE,
      }],
      inputHints: {
        title: { key: 'channels.discord.setup.title', fallback: 'Set up Discord Channels' },
        description: {
          key: 'channels.discord.setup.description',
          fallback: 'Select the Connected Account for the Discord bot to verify.',
        },
        submitLabel: { key: 'channels.discord.setup.submit', fallback: 'Verify bot' },
        fields: [{
          path: 'credentialRef',
          title: { key: 'channels.discord.setup.credential', fallback: 'Discord bot account' },
          description: {
            key: 'channels.discord.setup.credential.description',
            fallback: 'Choose the existing Discord bot Connected Account; bot tokens are never entered here.',
          },
          widget: 'select',
          connectedAccountOptions: true,
          required: true,
        }],
      },
      run: setupDiscordChannels,
    },
    [DISCORD_CHANNEL_ACTION_IDS.connectionTest]: {
      title: 'Test Discord connection',
      description: 'Tests the selected Discord Channel connection.',
      surfaces: connectionTestOperation.declaration.surfaces,
      dangerLevel: connectionTestOperation.declaration.dangerLevel,
      inputSchema: connectionTestOperation.declaration.input.schema.jsonSchema,
      resultSchema: connectionTestOperation.declaration.resultSchema.jsonSchema,
      hostAccess: ['discord-rest', DISCORD_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: DISCORD_BOT_CREDENTIAL_PURPOSE,
      }],
      run: testDiscordConnection,
    },
    [DISCORD_CHANNEL_ACTION_IDS.endpointResolve]: {
      title: 'Resolve Discord destination',
      description: 'Resolves a Discord channel destination for delivery.',
      surfaces: endpointResolveOperation.declaration.surfaces,
      dangerLevel: endpointResolveOperation.declaration.dangerLevel,
      inputSchema: endpointResolveOperation.declaration.input.schema.jsonSchema,
      resultSchema: endpointResolveOperation.declaration.resultSchema.jsonSchema,
      hostAccess: ['discord-rest', DISCORD_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: DISCORD_BOT_CREDENTIAL_PURPOSE,
      }],
      run: resolveDiscordEndpoint,
    },
    [DISCORD_CHANNEL_ACTION_IDS.messageDeliver]: {
      title: 'Deliver Discord message',
      description: 'Delivers a message to the selected Discord destination.',
      surfaces: messageDeliverOperation.declaration.surfaces,
      dangerLevel: messageDeliverOperation.declaration.dangerLevel,
      inputSchema: messageDeliverOperation.declaration.input.schema.jsonSchema,
      resultSchema: messageDeliverOperation.declaration.resultSchema.jsonSchema,
      hostAccess: ['discord-rest', DISCORD_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: DISCORD_BOT_CREDENTIAL_PURPOSE,
      }],
      run: deliverDiscordMessage,
    },
    [DISCORD_CHANNEL_ACTION_IDS.attachmentFetch]: {
      title: 'Fetch Discord attachments',
      description: 'Fetches native files for an admitted Discord message at Session materialization.',
      surfaces: attachmentFetchOperation.declaration.surfaces,
      dangerLevel: attachmentFetchOperation.declaration.dangerLevel,
      inputSchema: attachmentFetchOperation.declaration.input.schema.jsonSchema,
      resultSchema: attachmentFetchOperation.declaration.resultSchema.jsonSchema,
      hostAccess: ['discord-rest', 'discord-attachments', DISCORD_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: DISCORD_BOT_CREDENTIAL_PURPOSE }],
      run: fetchDiscordAttachment,
    },
  },
  events: {
    'connections-invalidated-v1': {
      declaration: {
        kind: 'subscription',
        target: {
          kind: 'plugin',
          event: { pluginId: 'happier.channels', localId: 'connections-invalidated-v1' },
        },
      },
      handler: (_event, context) => {
        context.services.logger.info('[Discord Gateway] Connections invalidated', { phase: 'connectionsInvalidated' });
        gatewayActivationBindings.invalidateConnections();
      },
    },
    [DISCORD_AUTOMATION_MESSAGE_EVENT_ID]: {
      declaration: {
        kind: 'event',
        title: 'Discord channel message',
        description: 'A Discord channel message observed through the selected Channels Gateway.',
        payloadSchema: DISCORD_AUTOMATION_MESSAGE_PAYLOAD_SCHEMA,
        automation: {
          v: 1,
          eligible: true,
          source: {
            sourceContractVersion: DISCORD_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
            // Discord observes through its own long-lived Gateway session. It
            // has no ordered provider pull checkpoint, so `checkpointedPull`
            // would falsely claim checkpoint coverage the Gateway cannot
            // deliver (an unresumable session reports a history gap).
            supportedObservationTransports: ['socket'],
            sourceConfigSchema: DISCORD_AUTOMATION_MESSAGE_SOURCE_CONFIG_SCHEMA,
            setupActionRef: {
              pluginId: DISCORD_PLUGIN_ID,
              localId: DISCORD_AUTOMATION_MESSAGE_SETUP_ACTION_ID,
            },
          },
        },
      },
    },
  },
  // Machine roles (P03-MACHINE-ROLES §4.4): the gateway supervisor is part of Work intake.
  machineRoles: { intake: { title: 'Discord Channels', description: 'Discord gateway ingress on this Machine.', partOf: 'intake',
    backgroundServices: [DISCORD_GATEWAY_BACKGROUND_SERVICE_ID] } },
  backgroundServices: [{
    declaration: {
      id: DISCORD_GATEWAY_BACKGROUND_SERVICE_ID,
      title: 'Discord Gateway supervisor',
    },
    runner: gatewayActivationBindings.run,
  }],
  contributesTo: {
    'happier.channels': {
      providers: {
        'discord-provider': discordProviderProtocol.contribute({
          descriptor: { v: 1, displayName: 'Discord' },
          operations: {
            setup: discordProviderOperations.setup.bind(DISCORD_CHANNEL_ACTION_IDS.setup),
            notificationDestinationSetup: discordProviderOperations.notificationDestinationSetup.bind(DISCORD_CHANNEL_ACTION_IDS.notificationSetup),
      connectionTest: discordProviderOperations.connectionTest.bind(DISCORD_CHANNEL_ACTION_IDS.connectionTest),
            endpointResolve: discordProviderOperations.endpointResolve.bind(DISCORD_CHANNEL_ACTION_IDS.endpointResolve),
            automationEventAdmit: discordProviderOperations.automationEventAdmit.bind(
              DISCORD_AUTOMATION_MESSAGE_ADMIT_ACTION_ID,
            ),
            messageDeliver: discordProviderOperations.messageDeliver.bind(DISCORD_CHANNEL_ACTION_IDS.messageDeliver),
            attachmentFetch: attachmentFetchOperation.bind(DISCORD_CHANNEL_ACTION_IDS.attachmentFetch),
          },
        }),
      },
    },
  },
    setup: () => gatewayActivationBindings.setup(),
  });
}

export const discordPlugin: DefinedPlugin<
  string,
  Readonly<Record<string, ActionContract>>,
  Readonly<Record<string, readonly unknown[]>>
> = createDiscordPlugin();

export const { manifest: PLUGIN_MANIFEST, activate } = discordPlugin;

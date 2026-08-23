import { definePlugin, type DefinedPlugin } from '@happier-dev/plugin-sdk';
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
  DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID,
  DISCORD_PLUGIN_ID,
} from './discordPluginConstants.js';
import {
  deliverDiscordMessage,
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
  DISCORD_AUTOMATION_MESSAGE_SETUP_ACTION_ID,
  DISCORD_AUTOMATION_MESSAGE_SETUP_HOST_ACCESS,
  DISCORD_AUTOMATION_MESSAGE_SETUP_INPUT_HINTS,
  DISCORD_AUTOMATION_MESSAGE_SETUP_INPUT_SCHEMA,
  DISCORD_AUTOMATION_MESSAGE_SETUP_RESULT_SCHEMA,
  setupDiscordAutomationMessageSource,
} from './discordAutomationEvent.js';
import { DISCORD_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

const discordProviderProtocol = ConversationProvidersContributionProtocolV1;
const discordProviderOperations = discordProviderProtocol.operations;

const connectionTestOperation = discordProviderOperations.connectionTest;
const endpointResolveOperation = discordProviderOperations.endpointResolve;
const messageDeliverOperation = discordProviderOperations.messageDeliver;
const connectionStopOperation = discordProviderOperations.connectionStop;

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
  runWorkerAttempt: (
    input: unknown,
    context: Parameters<DiscordGatewaySupervisor['runWorkerAttempt']>[1],
  ) => Promise<void>;
  stop: DiscordGatewaySupervisor['stop'];
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
    async run(context) {
      await requireCurrentSupervisor().run(context);
    },
    async runWorkerAttempt(input, context) {
      await requireCurrentSupervisor().runWorkerAttempt(
        ConversationProviderConnectionReconciliationSnapshotV1Schema.parse(input),
        context,
      );
    },
    async stop(input, context) {
      return await requireCurrentSupervisor().stop(input, context);
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
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  brand: { iconResourceId: DISCORD_BRAND_RESOURCE_ID },
  hostAccess: {
    required: [
      {
        id: 'discord-rest',
        capability: 'network',
        reason: 'Verify Discord application identity and send messages through Discord REST.',
        scope: {
          targets: [{ kind: 'fixedOrigin', origin: 'https://discord.com' }],
          methods: ['GET', 'POST', 'PATCH'],
        },
      },
      {
        id: 'discord-gateway',
        capability: 'network.client',
        reason: 'Maintain the selected Discord Gateway connection for authenticated conversation events.',
        scope: {
          targets: [{ kind: 'fixedOrigin', origin: 'https://gateway.discord.gg' }],
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
  },
  ui: {
    translations: DISCORD_UI_TRANSLATION_BUNDLES,
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
  actions: {
    [DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID]: {
      title: 'Run Discord Gateway worker attempt',
      execution: { target: 'daemon' },
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: DISCORD_GATEWAY_WORKER_ATTEMPT_INPUT_SCHEMA,
      hostAccess: ['discord-rest', 'discord-gateway', DISCORD_BOT_CREDENTIAL_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: DISCORD_BOT_CREDENTIAL_PURPOSE,
      }],
      run: gatewayActivationBindings.runWorkerAttempt,
    },
    // The Automation Event this Action resolves a source for is WITHHELD from
    // this manifest; the withheld-declaration note in
    // `discordAutomationEvent.ts` owns why and what a real observer needs. The
    // Action stays declared so the retained observer work keeps its one
    // registered entry point, and it is reachable only from the `plugin`
    // surface, so nothing user-facing offers an Automation that cannot exist.
    [DISCORD_AUTOMATION_MESSAGE_SETUP_ACTION_ID]: {
      title: 'Watch a Discord channel for Automations',
      description: 'Resolves a Discord channel to immutable source facts for an Automation Event.',
      execution: { target: 'daemon' },
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
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
    [DISCORD_CHANNEL_ACTION_IDS.setup]: {
      title: 'Set up Discord Channels',
      execution: { target: 'daemon' },
      scopes: ['global'],
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
      execution: { target: 'daemon' },
      scopes: ['global'],
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
      execution: { target: 'daemon' },
      scopes: ['global'],
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
      execution: { target: 'daemon' },
      scopes: ['global'],
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
    [DISCORD_CHANNEL_ACTION_IDS.connectionStop]: {
      title: 'Stop Discord Gateway connection',
      execution: { target: 'daemon' },
      scopes: ['global'],
      surfaces: connectionStopOperation.declaration.surfaces,
      dangerLevel: connectionStopOperation.declaration.dangerLevel,
      inputSchema: connectionStopOperation.declaration.input.schema.jsonSchema,
      resultSchema: connectionStopOperation.declaration.resultSchema.jsonSchema,
      hostAccess: ['discord-gateway', 'discord-rest', DISCORD_BOT_CREDENTIAL_PURPOSE],
      run: gatewayActivationBindings.stop,
    },
  },
  // This provider declares no Event. Its Automation Event declaration is
  // WITHHELD; `discordAutomationEvent.ts` owns the note that says why and what
  // a real history-capable observer needs before it can be declared again.
  backgroundServices: [{
    declaration: {
      id: 'gateway-supervisor',
      title: 'Discord Gateway supervisor',
    },
    runner: gatewayActivationBindings.run,
  }],
  contributesTo: {
    'happier.channels': {
      providers: {
        'discord-provider': discordProviderProtocol.contribute({
          operations: {
            setup: discordProviderOperations.setup.bind(DISCORD_CHANNEL_ACTION_IDS.setup),
            connectionTest: discordProviderOperations.connectionTest.bind(DISCORD_CHANNEL_ACTION_IDS.connectionTest),
            endpointResolve: discordProviderOperations.endpointResolve.bind(DISCORD_CHANNEL_ACTION_IDS.endpointResolve),
            messageDeliver: discordProviderOperations.messageDeliver.bind(DISCORD_CHANNEL_ACTION_IDS.messageDeliver),
            connectionStop: discordProviderOperations.connectionStop.bind(DISCORD_CHANNEL_ACTION_IDS.connectionStop),
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

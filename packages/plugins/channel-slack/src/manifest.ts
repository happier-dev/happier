import { definePlugin, type DefinedPlugin } from '@happier-dev/plugin-sdk';
import type { ActionContract } from '@happier-dev/plugin-sdk/actions';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1, QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
  ConversationProvidersContributionProtocolV1,
  ConversationProviderConnectionReconciliationSnapshotV1JsonSchema,
  ConversationProviderConnectionReconciliationSnapshotV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { slackConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import {
  setupSlackChannels, testSlackConnection, resolveSlackEndpoint, resolveSlackPrincipal, deliverSlackMessage,
  SLACK_SETUP_INPUT_PROTOCOL_SCHEMA,
} from './slackActions.js';
import { createSlackSocketSupervisor } from './slackSocketSupervisor.js';
import {
  SLACK_PLUGIN_ID, SLACK_CHANNEL_PROVIDER_CONTRIBUTION_ID, SLACK_CHANNEL_ACTION_IDS,
  SLACK_CONNECTED_ACCOUNT_ID, SLACK_CREDENTIAL_PURPOSE,
  SLACK_SOCKET_BACKGROUND_SERVICE_ID, SLACK_SOCKET_WORKER_ATTEMPT_ACTION_ID,
} from './slackPluginConstants.js';

const protocol = ConversationProvidersContributionProtocolV1;
const roles = protocol.operations;
const workerInputSchema = {
  type: 'object', properties: { credentialRef: { anyOf: [QualifiedConnectedAccountRefJsonSchema, { type: 'null' }] } },
  required: ['credentialRef'], allOf: [ConversationProviderConnectionReconciliationSnapshotV1JsonSchema],
} satisfies PluginJsonSchema;
const webAccess = ['slack-web-api', SLACK_CREDENTIAL_PURPOSE];
const socketAccess = [...webAccess, 'slack-socket-mode'];
const credentialBindings = [{ path: 'credentialRef', purpose: SLACK_CREDENTIAL_PURPOSE }];
type Supervisor = ReturnType<typeof createSlackSocketSupervisor>;

function createSlackPlugin() {
  let supervisor: Supervisor | null = null;
  function current(): Supervisor {
    if (!supervisor) throw new Error('Slack Socket Mode supervisor is not active.');
    return supervisor;
  }
  return definePlugin({
    id: SLACK_PLUGIN_ID, version: '0.0.0', displayName: 'Slack Channels',
    description: 'Connects Slack conversations to Happier Channels.',
    engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
    entrypoints: { daemon: './.happier-plugin/daemon.js' },
    hostAccess: { required: [
      { id: 'slack-web-api', capability: 'network', reason: 'Verify Slack identities and conversations and send messages through the Web API.',
        scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://slack.com' }], methods: ['GET', 'POST'] } },
      { id: 'slack-socket-mode', capability: 'network.client', reason: 'Receive Slack conversation events over authenticated outbound Socket Mode.',
        scope: { targets: [{ kind: 'httpsHostSuffix', hostSuffix: 'slack.com' }], transports: ['websocket'] } },
      { id: SLACK_CREDENTIAL_PURPOSE, capability: 'connectedAccounts', reason: 'Use only the exact selected Slack bot and app tokens.',
        scope: { serviceRefs: [SLACK_CONNECTED_ACCOUNT_ID], operations: ['select', 'use'], materializationKinds: ['environment'] } },
    ], optional: [] },
    connectedAccountDescriptors: {
      [SLACK_CONNECTED_ACCOUNT_ID]: {
        declaration: {
          title: 'Slack bot', description: 'Bot and app-level credentials for one Slack workspace using Socket Mode.',
          authentication: { defaultModeId: 'bot-tokens', modes: [{ id: 'bot-tokens', kind: 'manual',
            title: 'Bot and app tokens', outcomeReconciliation: 'none',
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            fields: [
              { id: 'botToken', title: 'Bot token', description: 'Install the app and copy its xoxb- bot token. See https://api.slack.com/apps for the app configuration.',
                schema: { type: 'string', minLength: 1 }, secret: true },
              { id: 'appToken', title: 'App-level token', description: 'Generate an xapp- token with connections:write and enable Socket Mode for the same app.',
                schema: { type: 'string', minLength: 1 }, secret: true },
            ],
      setup: {
              url: 'https://api.slack.com/apps',
              checklist: ['Create or select your Slack app, add the bot scopes and event subscriptions you need, and install it to your workspace.', 'Copy its Bot User OAuth Token from OAuth & Permissions.', 'Enable Socket Mode and generate an app-level token with connections:write for the same app, then paste both tokens here.'],
              createKeyTitle: 'Open Slack apps',
            },
          }] },
        }, runtime: slackConnectedAccountRuntime,
      },
    },
    actions: {
      [SLACK_CHANNEL_ACTION_IDS.setup]: {
        title: 'Set up Slack Channels', description: 'Verify the selected Slack bot and Socket Mode app before creating a connection.',
        surfaces: roles.setup.declaration.surfaces, dangerLevel: roles.setup.declaration.dangerLevel,
        inputSchema: SLACK_SETUP_INPUT_PROTOCOL_SCHEMA.jsonSchema, resultSchema: roles.setup.declaration.resultSchema.jsonSchema,
        hostAccess: socketAccess, connectedAccountPurposeBindings: credentialBindings,
        inputHints: { title: 'Set up Slack Channels', description: 'Choose the Connected Account containing both tokens for the same Slack app.', submitLabel: 'Verify Slack app',
          fields: [{ path: 'credentialRef', title: 'Slack bot account', description: 'The bot token and app-level token stay in Connected Accounts.',
            widget: 'select', connectedAccountOptions: true, required: true }] },
        run: setupSlackChannels,
      },
      [SLACK_CHANNEL_ACTION_IDS.connectionTest]: {
        title: 'Test Slack connection', description: 'Verify current bot identity and Socket Mode app correspondence.',
        surfaces: roles.connectionTest.declaration.surfaces, dangerLevel: roles.connectionTest.declaration.dangerLevel,
        inputSchema: roles.connectionTest.declaration.input.schema.jsonSchema, resultSchema: roles.connectionTest.declaration.resultSchema.jsonSchema,
        hostAccess: socketAccess, connectedAccountPurposeBindings: credentialBindings, run: testSlackConnection,
      },
      [SLACK_CHANNEL_ACTION_IDS.endpointResolve]: {
        title: 'Resolve Slack conversation', description: 'Resolve a channel ID or workspace-qualified Channel thread ID.',
        surfaces: roles.endpointResolve.declaration.surfaces, dangerLevel: roles.endpointResolve.declaration.dangerLevel,
        inputSchema: roles.endpointResolve.declaration.input.schema.jsonSchema, resultSchema: roles.endpointResolve.declaration.resultSchema.jsonSchema,
        hostAccess: webAccess, connectedAccountPurposeBindings: credentialBindings, run: resolveSlackEndpoint,
      },
      [SLACK_CHANNEL_ACTION_IDS.principalResolve]: {
        title: 'Resolve Slack user', description: 'Resolve an exact Slack user ID through the authenticated workspace API.',
        surfaces: roles.principalResolve.declaration.surfaces, dangerLevel: roles.principalResolve.declaration.dangerLevel,
        inputSchema: roles.principalResolve.declaration.input.schema.jsonSchema, resultSchema: roles.principalResolve.declaration.resultSchema.jsonSchema,
        hostAccess: webAccess, connectedAccountPurposeBindings: credentialBindings, run: resolveSlackPrincipal,
      },
      [SLACK_CHANNEL_ACTION_IDS.messageDeliver]: {
        title: 'Deliver Slack message', description: 'Send one core-sized text chunk to its exact Slack conversation or thread.',
        surfaces: roles.messageDeliver.declaration.surfaces, dangerLevel: roles.messageDeliver.declaration.dangerLevel,
        inputSchema: roles.messageDeliver.declaration.input.schema.jsonSchema, resultSchema: roles.messageDeliver.declaration.resultSchema.jsonSchema,
        hostAccess: webAccess, connectedAccountPurposeBindings: credentialBindings, run: deliverSlackMessage,
      },
      [SLACK_CHANNEL_ACTION_IDS.connectionStop]: {
        title: 'Stop Slack Socket Mode', description: 'Stop the exact selected Slack observer through its current supervisor.',
        surfaces: roles.connectionStop.declaration.surfaces, dangerLevel: roles.connectionStop.declaration.dangerLevel,
        inputSchema: roles.connectionStop.declaration.input.schema.jsonSchema, resultSchema: roles.connectionStop.declaration.resultSchema.jsonSchema,
        run: (input, context) => current().stop(input, context),
      },
      [SLACK_SOCKET_WORKER_ATTEMPT_ACTION_ID]: {
        title: 'Run Slack Socket Mode worker', description: 'Run one observer attempt with the exact Connected Account binding.',
        surfaces: ['plugin'], inputSchema: workerInputSchema, hostAccess: socketAccess, connectedAccountPurposeBindings: credentialBindings,
        run: (input, context) => current().runWorkerAttempt(ConversationProviderConnectionReconciliationSnapshotV1Schema.parse(input), context),
      },
    },
    events: {
      'connections-invalidated-v1': { declaration: { kind: 'subscription', target: { kind: 'plugin',
        event: { pluginId: 'happier.channels', localId: 'connections-invalidated-v1' } } }, handler: () => supervisor?.invalidateConnections() },
    },
    backgroundServices: [{ declaration: { id: SLACK_SOCKET_BACKGROUND_SERVICE_ID, title: 'Slack Socket Mode supervisor' }, runner: context => current().run(context) }],
    contributesTo: { 'happier.channels': { providers: { [SLACK_CHANNEL_PROVIDER_CONTRIBUTION_ID]: protocol.contribute({ descriptor: { v: 1, displayName: 'Slack' }, operations: {
      setup: roles.setup.bind(SLACK_CHANNEL_ACTION_IDS.setup), connectionTest: roles.connectionTest.bind(SLACK_CHANNEL_ACTION_IDS.connectionTest),
      endpointResolve: roles.endpointResolve.bind(SLACK_CHANNEL_ACTION_IDS.endpointResolve), principalResolve: roles.principalResolve.bind(SLACK_CHANNEL_ACTION_IDS.principalResolve),
      messageDeliver: roles.messageDeliver.bind(SLACK_CHANNEL_ACTION_IDS.messageDeliver), connectionStop: roles.connectionStop.bind(SLACK_CHANNEL_ACTION_IDS.connectionStop),
    } }) } } },
    setup() {
      if (supervisor) throw new Error('Slack Socket Mode supervisor is already active.');
      const next = createSlackSocketSupervisor();
      supervisor = next;
      return async () => { try { await next.dispose(); } finally { if (supervisor === next) supervisor = null; } };
    },
  });
}
export const slackPlugin: DefinedPlugin<string, Readonly<Record<string, ActionContract>>, Readonly<Record<string, readonly unknown[]>>> = createSlackPlugin();
export const { manifest: PLUGIN_MANIFEST, activate } = slackPlugin;
export const manifest = PLUGIN_MANIFEST;

import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  ConversationProviderSetupResultV1Schema,
  ConversationProvidersContributionProtocolV1,
} from '@happier-dev/channels-protocol/v1';

const roles = ConversationProvidersContributionProtocolV1.operations;

const actionIds = {
  setup: 'acme/connect',
  connectionTest: 'acme/check-connection',
  messageDeliver: 'acme/send-message',
  connectionStop: 'acme/stop-socket',
} as const;

const plugin = definePlugin({
  id: 'examples.operation-only-channel-provider',
  version: '0.1.0',
  displayName: 'Acme Chat Provider',
  actions: {
    [actionIds.setup]: {
      title: 'Connect Acme Chat',
      scopes: ['global'],
      execution: { target: 'daemon' },
      inputSchema: { type: 'object', additionalProperties: false },
      resultSchema: roles.setup.declaration.resultSchema.jsonSchema,
      surfaces: roles.setup.declaration.surfaces,
      dangerLevel: roles.setup.declaration.dangerLevel,
      run: async () => ConversationProviderSetupResultV1Schema.parse({
        v: 1,
        credentialRef: null,
        providerConnectionKey: 'acme:example-bot',
        providerConfigVersion: 1,
        providerConfig: {},
        integrationPrincipal: { id: 'acme:example-bot' },
        supportedTransports: ['socket'],
        recommendedTransport: 'socket',
        overlapSafety: 'safe',
        replayContinuity: 'sessionBound',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
      }),
    },
    [actionIds.connectionTest]: {
      title: 'Check Acme Chat',
      scopes: ['global'],
      execution: { target: 'daemon' },
      inputSchema: roles.connectionTest.declaration.input.schema.jsonSchema,
      resultSchema: roles.connectionTest.declaration.resultSchema.jsonSchema,
      surfaces: roles.connectionTest.declaration.surfaces,
      dangerLevel: roles.connectionTest.declaration.dangerLevel,
      run: async () => ({
        kind: 'ready',
        integrationPrincipal: { id: 'acme:example-bot' },
        providerConnectionKey: 'acme:example-bot',
      }),
    },
    [actionIds.messageDeliver]: {
      title: 'Send Acme Chat message',
      scopes: ['global'],
      execution: { target: 'daemon' },
      inputSchema: roles.messageDeliver.declaration.input.schema.jsonSchema,
      resultSchema: roles.messageDeliver.declaration.resultSchema.jsonSchema,
      surfaces: roles.messageDeliver.declaration.surfaces,
      dangerLevel: roles.messageDeliver.declaration.dangerLevel,
      run: async () => ({ kind: 'delivered', providerMessageIds: [] }),
    },
    [actionIds.connectionStop]: {
      title: 'Stop Acme Chat socket',
      scopes: ['global'],
      execution: { target: 'daemon' },
      inputSchema: roles.connectionStop.declaration.input.schema.jsonSchema,
      resultSchema: roles.connectionStop.declaration.resultSchema.jsonSchema,
      surfaces: roles.connectionStop.declaration.surfaces,
      dangerLevel: roles.connectionStop.declaration.dangerLevel,
      run: async () => ({ kind: 'stopped' }),
    },
  },
  contributesTo: {
    'happier.channels': {
      providers: {
        acme: ConversationProvidersContributionProtocolV1.contribute({
          operations: {
            setup: roles.setup.bind(actionIds.setup),
            connectionTest: roles.connectionTest.bind(actionIds.connectionTest),
            messageDeliver: roles.messageDeliver.bind(actionIds.messageDeliver),
            connectionStop: roles.connectionStop.bind(actionIds.connectionStop),
          },
        }),
      },
    },
  },
});

export const { manifest, activate } = plugin;

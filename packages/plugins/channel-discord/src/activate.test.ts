import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { assertConversationProviderContributionV1 } from '@happier-dev/channels-protocol/testing/v1';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import {
  DISCORD_BOT_CREDENTIAL_PURPOSE,
  DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID,
} from './discordPluginConstants.js';
import { DISCORD_BOT_CONNECTED_ACCOUNT_ID, PLUGIN_MANIFEST } from './manifest.js';

const DISCORD_CHANNEL_ACTION_IDS = Object.freeze({
  setup: 'discord/prepare-bot',
  connectionTest: 'discord/inspect-connection',
  endpointResolve: 'discord/choose-channel',
  messageDeliver: 'discord/post-message',
  connectionStop: 'discord/halt-gateway',
});

const DISCORD_CHANNEL_PROVIDER_OPERATIONS = Object.freeze({
  setup: DISCORD_CHANNEL_ACTION_IDS.setup,
  connectionTest: DISCORD_CHANNEL_ACTION_IDS.connectionTest,
  endpointResolve: DISCORD_CHANNEL_ACTION_IDS.endpointResolve,
  messageDeliver: DISCORD_CHANNEL_ACTION_IDS.messageDeliver,
  connectionStop: DISCORD_CHANNEL_ACTION_IDS.connectionStop,
});

const discordBotAccount = Object.freeze({
  service: Object.freeze({
    pluginId: 'happier.channel.discord',
    localId: DISCORD_BOT_CONNECTED_ACCOUNT_ID,
  }),
  accountId: 'bot:discord-bot-1',
});

const discordSetupInput = Object.freeze({ credentialRef: discordBotAccount });

function discordResponse(value: unknown): Readonly<{
  status: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}> {
  return {
    status: 200,
    finalUrl: 'https://discord.com/api/v10/',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function providerActionContext(input: Readonly<{
  callerPluginId: string;
  materialize: PluginInvocationContext['services']['connectedAccounts']['materialize'];
  request: PluginInvocationContext['services']['http']['request'];
}>): PluginInvocationContext {
  return {
    plugin: { id: 'happier.channel.discord', version: '0.0.0' },
    contribution: {
      id: DISCORD_CHANNEL_ACTION_IDS.setup,
      qualifiedId: `happier.channel.discord/actions/${DISCORD_CHANNEL_ACTION_IDS.setup}`,
    },
    surface: 'plugin',
    caller: {
      kind: 'plugin',
      pluginId: input.callerPluginId,
      contribution: {
        id: 'connection-setup-v1',
        qualifiedId: `${input.callerPluginId}/actions/connection-setup-v1`,
      },
      materialization: {
        pluginId: input.callerPluginId,
        machineId: 'machine-1',
        materializationId: 'caller-materialization-1',
      },
    },
    signal: new AbortController().signal,
    services: {
      connectedAccounts: { materialize: input.materialize },
      http: { request: input.request },
    } as PluginInvocationContext['services'],
  };
}

describe('Discord Channel plugin activation', () => {
  it('serializes one socket provider contribution through arbitrary local Actions', async () => {
    assertConversationProviderContributionV1(PLUGIN_MANIFEST);
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions).toEqual([{
        id: 'discord-provider',
        target: { pluginId: 'happier.channels', pointId: 'providers' },
        protocol: { id: 'happier.channels/providers', version: 1 },
        operations: DISCORD_CHANNEL_PROVIDER_OPERATIONS,
      }]);
      expect(testkit.registrations()).toEqual([
        { family: 'actions', localId: DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID },
        ...Object.values(DISCORD_CHANNEL_ACTION_IDS).map((localId) => ({ family: 'actions' as const, localId })),
        { family: 'backgroundServices', localId: 'gateway-supervisor' },
        { family: 'connectedAccountDescriptors', localId: DISCORD_BOT_CONNECTED_ACCOUNT_ID },
      ]);

      const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));
      for (const localId of Object.values(DISCORD_CHANNEL_ACTION_IDS).filter(
        (localId) => localId !== DISCORD_CHANNEL_ACTION_IDS.messageDeliver
          && localId !== DISCORD_CHANNEL_ACTION_IDS.connectionStop,
      )) {
        expect(actions.get(localId)?.dangerLevel).toBe('safe');
      }
      expect(actions.get(DISCORD_CHANNEL_ACTION_IDS.messageDeliver)?.dangerLevel).toBe('writesRemote');
      expect(actions.get(DISCORD_CHANNEL_ACTION_IDS.connectionStop)?.dangerLevel).toBe('writesRemote');
      expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions?.[0]?.operations)
        .not.toHaveProperty('observationsPoll');
      expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions?.[0]?.operations)
        .not.toHaveProperty('deliveryReconcile');
    } finally {
      await testkit.dispose();
    }
  });

  it('rejects a second activation until the exact Gateway supervisor is disposed', async () => {
    const first = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      await expect(createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } }))
        .rejects.toThrow('Discord Gateway supervisor is already active.');
    } finally {
      await first.dispose();
    }

    const restarted = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    await restarted.dispose();
  });

  it('registers its one Connected Account runtime, declared provider Actions, and the manifest-owned Gateway background service', async () => {
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      expect(testkit.registrations()).toEqual([
        { family: 'actions', localId: DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID },
        { family: 'actions', localId: DISCORD_CHANNEL_ACTION_IDS.setup },
        { family: 'actions', localId: DISCORD_CHANNEL_ACTION_IDS.connectionTest },
        { family: 'actions', localId: DISCORD_CHANNEL_ACTION_IDS.endpointResolve },
        { family: 'actions', localId: DISCORD_CHANNEL_ACTION_IDS.messageDeliver },
        { family: 'actions', localId: DISCORD_CHANNEL_ACTION_IDS.connectionStop },
        { family: 'backgroundServices', localId: 'gateway-supervisor' },
        { family: 'connectedAccountDescriptors', localId: DISCORD_BOT_CONNECTED_ACCOUNT_ID },
      ]);

      const setup = PLUGIN_MANIFEST.contributes.actions.find(
        ({ id }) => id === DISCORD_CHANNEL_ACTION_IDS.setup,
      );
      expect(setup).toMatchObject({
        surfaces: ['plugin'],
        hostAccess: ['discord-rest', DISCORD_BOT_CREDENTIAL_PURPOSE],
        inputHints: {
          fields: [{
            path: 'credentialRef',
            widget: 'select',
            connectedAccountOptions: true,
            required: true,
          }],
        },
      });
      expect(setup?.inputHints?.fields).not.toContainEqual(expect.objectContaining({ widget: 'secret' }));
      expect(PLUGIN_MANIFEST.hostAccess.required.filter(({ capability }) => capability === 'connectedAccounts'))
        .toEqual([expect.objectContaining({
          id: DISCORD_BOT_CREDENTIAL_PURPOSE,
          scope: {
            serviceRefs: [DISCORD_BOT_CONNECTED_ACCOUNT_ID],
            operations: ['select', 'use'],
            materializationKinds: ['environment'],
          },
        })]);
    } finally {
      await testkit.dispose();
    }
  });

  it('rejects a wrong host-stamped plugin caller before credential materialization or Discord I/O while accepting Channels', async () => {
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const setup = testkit.registration('actions', DISCORD_CHANNEL_ACTION_IDS.setup);
      if (!setup) throw new Error('Expected the Discord setup Action registration');

      const deniedMaterialize = vi.fn();
      const deniedRequest = vi.fn();
      await expect(setup(discordSetupInput, providerActionContext({
        callerPluginId: 'happier.channel.other',
        materialize: deniedMaterialize,
        request: deniedRequest,
      }))).rejects.toMatchObject({ code: 'discord_channels_core_caller_required' });
      expect(deniedMaterialize).not.toHaveBeenCalled();
      expect(deniedRequest).not.toHaveBeenCalled();

      const authorizedMaterialize = vi.fn(async () => ({
        kind: 'environment' as const,
        env: { DISCORD_BOT_TOKEN: 'bot-token' },
      }));
      const authorizedRequest = vi.fn(async (request: Readonly<{ url: string }>) => {
        if (request.url.endsWith('/oauth2/applications/@me')) {
          return discordResponse({ id: 'application-1', name: 'Happier Discord' });
        }
        if (request.url.endsWith('/users/@me')) {
          return discordResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        }
        if (request.url.endsWith('/gateway/bot')) {
          return discordResponse({
            url: 'wss://gateway.discord.gg',
            session_start_limit: {
              total: 1_000,
              remaining: 999,
              reset_after: 86_400_000,
              max_concurrency: 1,
            },
          });
        }
        throw new Error(`Unexpected Discord request: ${request.url}`);
      });
      await expect(setup(discordSetupInput, providerActionContext({
        callerPluginId: 'happier.channels',
        materialize: authorizedMaterialize,
        request: authorizedRequest,
      }))).resolves.toMatchObject({
        credentialRef: discordBotAccount,
        providerConnectionKey: 'discord:application:application-1',
        integrationPrincipal: { id: 'discord:bot:discord-bot-1', label: 'Happier' },
      });
      expect(authorizedMaterialize).toHaveBeenCalledTimes(1);
      expect(authorizedRequest).toHaveBeenCalledTimes(3);
    } finally {
      await testkit.dispose();
    }
  });
});

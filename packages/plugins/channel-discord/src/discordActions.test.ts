import { describe, expect, it, vi } from 'vitest';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { MAX_CONVERSATION_RETRY_AFTER_MS } from '@happier-dev/channels-protocol/v1';

import {
  deliverDiscordMessage,
  readDiscordConnectionConfiguration,
  resolveDiscordEndpoint,
  setupDiscordChannels,
  testDiscordConnection,
} from './discordActions.js';
import { setupDiscordAutomationMessageSource } from './discordAutomationEvent.js';
import {
  DISCORD_BOT_CONNECTED_ACCOUNT_ID,
  DISCORD_BOT_CREDENTIAL_PURPOSE,
  DISCORD_BOT_TOKEN_ENVIRONMENT_KEY,
} from './discordPluginConstants.js';

const credentialRef = {
  service: {
    pluginId: 'happier.channel.discord',
    localId: DISCORD_BOT_CONNECTED_ACCOUNT_ID,
  },
  accountId: 'bot:discord-bot-1',
} as const;

function jsonResponse(value: unknown, status = 200): Readonly<{
  status: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}> {
  return {
    status,
    finalUrl: 'https://discord.com/api/v10/',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function channelsCallerContext(input: Readonly<{
  request: (request: Readonly<{
    url: string;
    method?: string;
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array;
  }>) => Promise<ReturnType<typeof jsonResponse>>;
  materialize?: () => Promise<Readonly<{
    kind: 'environment';
    env: Readonly<Record<string, string>>;
  }>>;
  signal?: AbortSignal;
  execute?: PluginInvocationContext['services']['actions']['execute'];
}>) {
  const controller = new AbortController();
  const materialize = vi.fn(input.materialize ?? (async () => ({
    kind: 'environment' as const,
    env: { [DISCORD_BOT_TOKEN_ENVIRONMENT_KEY]: 'bot-token' },
  })));
  const context = {
    plugin: { id: 'happier.channel.discord', version: '0.0.0' },
    contribution: { id: 'channels/setup-v1', qualifiedId: 'happier.channel.discord/actions/channels/setup-v1' },
    surface: 'plugin' as const,
    caller: {
      kind: 'plugin' as const,
      pluginId: 'happier.channels',
      contribution: { id: 'provider-setup', qualifiedId: 'happier.channels/actions/provider-setup' },
      materialization: {
        machineId: 'discord-actions-fixture-machine',
        materializationId: 'discord-actions-fixture-materialization',
        pluginId: 'happier.channels',
      },
    },
    signal: input.signal ?? controller.signal,
    // These Actions consume exactly two host boundaries; the remaining host
    // services are stamped by the runtime and never read here.
    services: {
      connectedAccounts: { materialize },
      http: {
        async request(request: Parameters<typeof input.request>[0]) {
          return await input.request(request);
        },
      },
      actions: { execute: input.execute ?? vi.fn() },
    } as unknown as PluginInvocationContext['services'],
  } satisfies PluginInvocationContext;
  return { context, materialize };
}

describe('Discord Channels provider Actions', () => {
  it('requires a current Channels connection for the selected bot before arming an Event source', async () => {
    const { context } = channelsCallerContext({
      async request(request) {
        if (request.url.endsWith('/oauth2/applications/@me')) {
          return jsonResponse({ id: 'application-1', name: 'Happier Discord' });
        }
        if (request.url.endsWith('/users/@me')) {
          return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        }
        if (request.url.endsWith('/channels/4242')) {
          return jsonResponse({ id: '4242', type: 0, name: 'general' });
        }
        throw new Error(`Unexpected Discord request: ${request.url}`);
      },
      execute: vi.fn(async (action: unknown) => {
        if (typeof action === 'object' && action !== null && 'localId' in action
          && action.localId === 'provider/connections-list-v1') return {};
        throw new Error('Unexpected Action');
      }) as PluginInvocationContext['services']['actions']['execute'],
    });

    await expect(setupDiscordAutomationMessageSource(
      { credentialRef, channelId: '4242' },
      context,
    )).rejects.toMatchObject({
      code: 'discord_automation_channels_connection_required',
      remediation: {
        kind: 'openSettings',
        path: '/settings/plugins/happier.channels/connections',
      },
    });
  });

  it('arms an Event source through the exact enabled Channels connection', async () => {
    const execute = vi.fn(async (action: unknown) => {
      if (typeof action === 'object' && action !== null && 'localId' in action
        && action.localId === 'provider/connections-list-v1') {
        return {
          'discord-connection-1': {
            v: 1,
            connectionId: 'discord-connection-1',
            providerConnectionKey: 'discord:application:application-1',
            providerConfigVersion: 1,
            providerConfig: { applicationId: 'application-1', botUserId: 'discord-bot-1' },
            credentialRef,
            authorityEpoch: 1,
            enabled: true,
            deletionState: 'none',
            requiresFullSharedMessageContent: false,
          },
        };
      }
      throw new Error('Unexpected Action');
    });
    const { context } = channelsCallerContext({
      async request(request) {
        if (request.url.endsWith('/oauth2/applications/@me')) {
          return jsonResponse({ id: 'application-1', name: 'Happier Discord' });
        }
        if (request.url.endsWith('/users/@me')) {
          return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        }
        if (request.url.endsWith('/channels/4242')) {
          return jsonResponse({ id: '4242', type: 0, name: 'general' });
        }
        throw new Error(`Unexpected Discord request: ${request.url}`);
      },
      execute: execute as PluginInvocationContext['services']['actions']['execute'],
    });

    await expect(setupDiscordAutomationMessageSource(
      { credentialRef, channelId: '4242' },
      context,
    )).resolves.toMatchObject({
      sourceInstanceId: 'discord:application:application-1:channel:4242',
      sourceConfig: { v: 1, applicationId: 'application-1', channelId: '4242' },
      displayLabel: '#general',
    });
  });

  it('rejects a connection whose replay-scope key is not its exact setup-derived Discord application key', () => {
    for (const providerConnectionKey of [
      'discord:application:application-other',
      'discord:application:application-1 ',
    ]) {
      expect(readDiscordConnectionConfiguration({
        providerConnectionKey,
        providerConfigVersion: 1,
        providerConfig: {
          applicationId: 'application-1',
          botUserId: 'discord-bot-1',
          inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=274877975552',
        },
        credentialRef,
      })).toEqual({
        kind: 'notReady',
        reason: 'invalidConfiguration',
        diagnostic: 'Discord Channel connection configuration is invalid.',
      });
    }
  });

  it('returns typed selected-transport unavailability before materializing a Discord credential', async () => {
    const { context, materialize } = channelsCallerContext({
      async request() {
        throw new Error('The unsupported transport must not make a Discord request.');
      },
    });

    await expect(testDiscordConnection({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1,
      providerConfig: {
        applicationId: 'application-1',
        botUserId: 'discord-bot-1',
      },
      credentialRef,
      selectedTransport: 'checkpointedPull',
    }, context as Parameters<typeof testDiscordConnection>[1])).resolves.toEqual({
      kind: 'notReady',
      reason: 'unsupported',
      diagnostic: 'Discord Channels supports socket transport only.',
    });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('rechecks the selected socket gateway prerequisite during connection test', async () => {
    const requests: string[] = [];
    const { context } = channelsCallerContext({
      async request(request) {
        requests.push(request.url);
        if (request.url.endsWith('/oauth2/applications/@me')) {
          return jsonResponse({ id: 'application-1', name: 'Happier Discord' });
        }
        if (request.url.endsWith('/users/@me')) {
          return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        }
        if (request.url.endsWith('/gateway/bot')) {
          return jsonResponse({
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
      },
    });

    await expect(testDiscordConnection({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1,
      providerConfig: {
        applicationId: 'application-1',
        botUserId: 'discord-bot-1',
      },
      credentialRef,
      selectedTransport: 'socket',
    }, context as Parameters<typeof testDiscordConnection>[1])).resolves.toEqual({
      kind: 'ready',
      integrationPrincipal: { id: 'discord:bot:discord-bot-1', label: 'Happier' },
      providerConnectionKey: 'discord:application:application-1',
    });
    expect(requests).toEqual([
      'https://discord.com/api/v10/oauth2/applications/@me',
      'https://discord.com/api/v10/users/@me',
      'https://discord.com/api/v10/gateway/bot',
    ]);
  });

  it('materializes the exact selected bot account before verifying its immutable application and bot identities', async () => {
    const requests: Array<Readonly<{ url: string; headers?: Readonly<Record<string, string>> }>> = [];
    const { context, materialize } = channelsCallerContext({
      async request(request) {
        requests.push(request);
        if (request.url.endsWith('/oauth2/applications/@me')) {
          return jsonResponse({ id: 'application-1', name: 'Happier Discord' });
        }
        if (request.url.endsWith('/users/@me')) {
          return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        }
        if (request.url.endsWith('/gateway/bot')) {
          return jsonResponse({
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
      },
    });

    await expect(setupDiscordChannels({ credentialRef }, context as Parameters<typeof setupDiscordChannels>[1]))
      .resolves.toMatchObject({
        credentialRef,
        providerConnectionKey: 'discord:application:application-1',
        providerConfig: {
          applicationId: 'application-1',
          botUserId: 'discord-bot-1',
          inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=274877975552',
        },
        integrationPrincipal: { id: 'discord:bot:discord-bot-1', label: 'Happier' },
        supportedTransports: ['socket'],
        replayContinuity: 'sessionBound',
      });

    expect(materialize).toHaveBeenCalledWith(
      DISCORD_BOT_CREDENTIAL_PURPOSE,
      { kind: 'environment', keys: [DISCORD_BOT_TOKEN_ENVIRONMENT_KEY] },
      { signal: context.signal, expectedAccount: credentialRef },
    );
    expect(requests).toEqual([
      expect.objectContaining({
        url: 'https://discord.com/api/v10/oauth2/applications/@me',
        headers: {
          authorization: 'Bot bot-token',
          'user-agent': 'DiscordBot (https://happier.dev, 0.0.0)',
        },
      }),
      expect.objectContaining({
        url: 'https://discord.com/api/v10/users/@me',
        headers: {
          authorization: 'Bot bot-token',
          'user-agent': 'DiscordBot (https://happier.dev, 0.0.0)',
        },
      }),
      expect.objectContaining({
        url: 'https://discord.com/api/v10/gateway/bot',
        headers: {
          authorization: 'Bot bot-token',
          'user-agent': 'DiscordBot (https://happier.dev, 0.0.0)',
        },
      }),
    ]);
  });

  it('classifies exact Connected Account materialization failures before any Discord delivery effect', async () => {
    for (const scenario of [
      {
        name: 'retryable materialization failure',
        error: new PluginError({
          code: 'plugin_connected_account_runtime_unavailable',
          message: 'The Connected Account runtime is temporarily unavailable.',
          retryable: true,
        }),
        expected: { kind: 'notDelivered' as const, retry: 'safe' as const },
      },
      {
        name: 'unavailable Connected Account service',
        error: new PluginError({
          code: 'plugin_service_unavailable',
          message: 'The Connected Accounts service is unavailable for this invocation.',
        }),
        expected: { kind: 'notDelivered' as const, retry: 'safe' as const },
      },
      {
        name: 'permanent Connected Account authorization refusal',
        error: new PluginError({
          code: 'plugin_host_access_operation_denied',
          message: 'The selected Connected Account is not authorized for this use.',
        }),
        expected: { kind: 'notDelivered' as const, retry: 'never' as const },
      },
    ]) {
      const materialize = vi.fn(async () => {
        throw scenario.error;
      });
      const requests = vi.fn(async () => {
        throw new Error('Discord I/O must not start after materialization fails.');
      });
      const { context } = channelsCallerContext({ request: requests, materialize });

      await expect(deliverDiscordMessage({
        v: 1,
        connectionId: 'connection-1',
        providerConnectionKey: 'discord:application:application-1',
        providerConfigVersion: 1,
        providerConfig: { applicationId: 'application-1', botUserId: 'discord-bot-1' },
        credentialRef,
        endpoint: { kind: 'direct', audience: 'direct', id: 'discord:channel:channel-1' },
        content: 'reply',
        deliveryKey: `delivery-materialize-${scenario.name}`,
        mentionPolicy: 'suppress',
        linkPreviewPolicy: 'suppress',
      }, context as Parameters<typeof deliverDiscordMessage>[1])).resolves.toEqual(scenario.expected);

      expect(materialize).toHaveBeenCalledOnce();
      expect(requests).not.toHaveBeenCalled();
    }
  });

  it('propagates cancellation and currentness from exact Connected Account materialization before Discord delivery', async () => {
    for (const scenario of [
      {
        name: 'cancellation',
        error: new Error('The delivery invocation was cancelled.'),
        aborted: true,
      },
      {
        name: 'currentness',
        error: new PluginError({
          code: 'plugin_final_generation_retired',
          message: 'The Connected Account generation is no longer current.',
        }),
        aborted: false,
      },
    ]) {
      const controller = new AbortController();
      const materialize = vi.fn(async () => {
        if (scenario.aborted) controller.abort(scenario.error);
        throw scenario.error;
      });
      const requests = vi.fn(async () => {
        throw new Error('Discord I/O must not start after materialization is cancelled or retired.');
      });
      const { context } = channelsCallerContext({ request: requests, materialize, signal: controller.signal });

      await expect(deliverDiscordMessage({
        v: 1,
        connectionId: 'connection-1',
        providerConnectionKey: 'discord:application:application-1',
        providerConfigVersion: 1,
        providerConfig: { applicationId: 'application-1', botUserId: 'discord-bot-1' },
        credentialRef,
        endpoint: { kind: 'direct', audience: 'direct', id: 'discord:channel:channel-1' },
        content: 'reply',
        deliveryKey: `delivery-materialize-${scenario.name}`,
        mentionPolicy: 'suppress',
        linkPreviewPolicy: 'suppress',
      }, context as Parameters<typeof deliverDiscordMessage>[1])).rejects.toBe(scenario.error);

      expect(materialize).toHaveBeenCalledOnce();
      expect(requests).not.toHaveBeenCalled();
    }
  });

  it('keeps no-effect Discord identity failures retryable before a message POST', async () => {
    for (const scenario of [
      {
        name: 'network',
        response: jsonResponse({ message: 'Discord is unavailable' }, 500),
        expected: { kind: 'notDelivered' as const, retry: 'safe' as const },
      },
      {
        name: 'rate limited',
        response: jsonResponse({ message: 'Slow down', retry_after: 2 }, 429),
        expected: { kind: 'notDelivered' as const, retry: 'after' as const, retryAfterMs: 2_000 },
      },
      {
        name: 'rate limit beyond the protocol bound',
        response: jsonResponse({ retry_after: (MAX_CONVERSATION_RETRY_AFTER_MS / 1_000) + 1 }, 429),
        expected: {
          kind: 'notDelivered' as const,
          retry: 'after' as const,
          retryAfterMs: MAX_CONVERSATION_RETRY_AFTER_MS,
        },
      },
    ]) {
      const requests: Array<Readonly<{ url: string; method?: string }>> = [];
      const { context } = channelsCallerContext({
        async request(request) {
          requests.push(request);
          if (request.url.endsWith('/oauth2/applications/@me')) return scenario.response;
          throw new Error(`Unexpected Discord request: ${request.url}`);
        },
      });

      await expect(deliverDiscordMessage({
        v: 1,
        connectionId: 'connection-1',
        providerConnectionKey: 'discord:application:application-1',
        providerConfigVersion: 1,
        providerConfig: { applicationId: 'application-1', botUserId: 'discord-bot-1' },
        credentialRef,
        endpoint: { kind: 'direct', audience: 'direct', id: 'discord:channel:channel-1' },
        content: 'reply',
        deliveryKey: `delivery-identity-${scenario.name}`,
        mentionPolicy: 'suppress',
        linkPreviewPolicy: 'suppress',
      }, context as Parameters<typeof deliverDiscordMessage>[1])).resolves.toEqual(scenario.expected);

      expect(requests.filter((request) => request.method === 'POST' && request.url.endsWith('/messages'))).toEqual([]);
    }
  });

  it('refuses a guild endpoint before it can become a resolved target when the current bot lacks required effective permissions', async () => {
    const requests: Array<Readonly<{ url: string; method?: string }>> = [];
    const { context } = channelsCallerContext({
      async request(request) {
        requests.push(request);
        if (request.url.endsWith('/oauth2/applications/@me')) return jsonResponse({ id: 'application-1' });
        if (request.url.endsWith('/users/@me')) return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        if (request.url.endsWith('/channels/123')) {
          return jsonResponse({
            id: '123',
            type: 0,
            guild_id: 'guild-1',
            permission_overwrites: [],
          });
        }
        if (request.url.endsWith('/guilds/guild-1/members/discord-bot-1')) {
          return jsonResponse({ user: { id: 'discord-bot-1' }, roles: [] });
        }
        if (request.url.endsWith('/guilds/guild-1/roles')) {
          return jsonResponse([{ id: 'guild-1', permissions: '1024' }]);
        }
        throw new Error(`Unexpected Discord request: ${request.url}`);
      },
    });

    await expect(resolveDiscordEndpoint({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1,
      providerConfig: {
        applicationId: 'application-1',
        botUserId: 'discord-bot-1',
        inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=274877975552',
      },
      credentialRef,
      query: '123',
      kinds: ['shared'],
    }, context as Parameters<typeof resolveDiscordEndpoint>[1])).resolves.toEqual({
      kind: 'notReady',
      reason: 'permissionMissing',
      diagnostic: 'Discord cannot currently Send Messages and Read Message History in this target.',
    });
    expect(requests.map(({ url, method }) => ({ url, method }))).toEqual([
      expect.objectContaining({ url: 'https://discord.com/api/v10/oauth2/applications/@me', method: 'GET' }),
      expect.objectContaining({ url: 'https://discord.com/api/v10/users/@me', method: 'GET' }),
      expect.objectContaining({ url: 'https://discord.com/api/v10/channels/123', method: 'GET' }),
      expect.objectContaining({ url: 'https://discord.com/api/v10/guilds/guild-1/members/discord-bot-1', method: 'GET' }),
      expect.objectContaining({ url: 'https://discord.com/api/v10/guilds/guild-1/roles', method: 'GET' }),
    ]);
  });

  it('verifies a thread through its parent permission overwrites and uses Send Messages in Threads instead of Send Messages', async () => {
    const requests: string[] = [];
    const { context } = channelsCallerContext({
      async request(request) {
        requests.push(request.url);
        if (request.url.endsWith('/oauth2/applications/@me')) return jsonResponse({ id: 'application-1' });
        if (request.url.endsWith('/users/@me')) return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        if (request.url.endsWith('/channels/101')) {
          return jsonResponse({ id: '101', type: 11, guild_id: 'guild-1', parent_id: '102' });
        }
        if (request.url.endsWith('/channels/102')) {
          return jsonResponse({ id: '102', type: 0, guild_id: 'guild-1', permission_overwrites: [] });
        }
        if (request.url.endsWith('/guilds/guild-1/members/discord-bot-1')) {
          return jsonResponse({ user: { id: 'discord-bot-1' }, roles: [] });
        }
        if (request.url.endsWith('/guilds/guild-1/roles')) {
          // View Channels + Send Messages in Threads + Read Message History;
          // regular Send Messages is intentionally absent.
          return jsonResponse([{ id: 'guild-1', permissions: '274877973504' }]);
        }
        throw new Error(`Unexpected Discord request: ${request.url}`);
      },
    });

    await expect(resolveDiscordEndpoint({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1,
      providerConfig: {
        applicationId: 'application-1',
        botUserId: 'discord-bot-1',
        inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=274877975552',
      },
      credentialRef,
      query: '101',
      kinds: ['thread'],
    }, context as Parameters<typeof resolveDiscordEndpoint>[1])).resolves.toEqual({
      kind: 'resolved',
      candidates: [{
        kind: 'thread',
        audience: 'shared',
        id: 'discord:channel:101',
        parentId: 'discord:channel:102',
      }],
    });
    expect(requests).toEqual([
      'https://discord.com/api/v10/oauth2/applications/@me',
      'https://discord.com/api/v10/users/@me',
      'https://discord.com/api/v10/channels/101',
      'https://discord.com/api/v10/channels/102',
      'https://discord.com/api/v10/guilds/guild-1/members/discord-bot-1',
      'https://discord.com/api/v10/guilds/guild-1/roles',
    ]);
  });

  it('applies current channel overwrites after current bot-role permissions before resolving a shared target', async () => {
    const { context } = channelsCallerContext({
      async request(request) {
        if (request.url.endsWith('/oauth2/applications/@me')) return jsonResponse({ id: 'application-1' });
        if (request.url.endsWith('/users/@me')) return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        if (request.url.endsWith('/channels/456')) {
          return jsonResponse({
            id: '456',
            type: 0,
            guild_id: 'guild-1',
            permission_overwrites: [{ id: 'guild-1', type: 0, allow: '0', deny: '2048' }],
          });
        }
        if (request.url.endsWith('/guilds/guild-1/members/discord-bot-1')) {
          return jsonResponse({ user: { id: 'discord-bot-1' }, roles: [] });
        }
        if (request.url.endsWith('/guilds/guild-1/roles')) {
          return jsonResponse([{ id: 'guild-1', permissions: '274877975552' }]);
        }
        throw new Error(`Unexpected Discord request: ${request.url}`);
      },
    });

    await expect(resolveDiscordEndpoint({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1,
      providerConfig: {
        applicationId: 'application-1',
        botUserId: 'discord-bot-1',
        inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=274877975552',
      },
      credentialRef,
      query: '456',
      kinds: ['shared'],
    }, context as Parameters<typeof resolveDiscordEndpoint>[1])).resolves.toEqual({
      kind: 'notReady',
      reason: 'permissionMissing',
      diagnostic: 'Discord cannot currently Send Messages in this target.',
    });
  });

  it('maps only Discord archive evidence to endpointArchived after an exact-account send', async () => {
    const deliveryKey = `channels:delivery:v1:${'a'.repeat(43)}`;
    const requests: Array<Readonly<{
      url: string;
      method?: string;
      headers?: Readonly<Record<string, string>>;
      body?: Uint8Array;
    }>> = [];
    const { context } = channelsCallerContext({
      async request(request) {
        requests.push(request);
        if (request.url.endsWith('/oauth2/applications/@me')) return jsonResponse({ id: 'application-1' });
        if (request.url.endsWith('/users/@me')) return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        if (request.url.endsWith('/channels/channel-1')) {
          return jsonResponse({ id: 'channel-1', type: 11, parent_id: 'parent-1' });
        }
        if (request.url.endsWith('/channels/channel-1/messages')) {
          return jsonResponse({ code: 50_083, message: 'Thread is archived' }, 403);
        }
        throw new Error(`Unexpected Discord request: ${request.url}`);
      },
    });

    await expect(deliverDiscordMessage({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1,
      providerConfig: {
        applicationId: 'application-1',
        botUserId: 'discord-bot-1',
        inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=274877975552',
      },
      credentialRef,
      endpoint: {
        kind: 'thread',
        audience: 'shared',
        id: 'discord:channel:channel-1',
        parentId: 'discord:channel:parent-1',
      },
      content: 'Hello <@123>',
      deliveryKey,
      replyContext: { replyToMessageId: 'message-1' },
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    }, context as Parameters<typeof deliverDiscordMessage>[1])).resolves.toEqual({
      kind: 'endpointArchived',
      recovery: 'ownerMustUnarchiveOrRebind',
    });

    const send = requests.at(-1);
    expect(send).toMatchObject({
      method: 'POST',
      url: 'https://discord.com/api/v10/channels/channel-1/messages',
      headers: {
        authorization: 'Bot bot-token',
        'user-agent': 'DiscordBot (https://happier.dev, 0.0.0)',
        'content-type': 'application/json',
      },
    });
    const payload = JSON.parse(new TextDecoder().decode(send?.body));
    expect(payload).toEqual({
      content: 'Hello <@123>',
      allowed_mentions: { parse: [] },
      flags: 4,
      message_reference: { message_id: 'message-1', fail_if_not_exists: false },
      nonce: expect.any(String),
      enforce_nonce: true,
    });
    expect(Array.from(payload.nonce)).toHaveLength(25);
    expect(payload.nonce).not.toContain(deliveryKey);
  });

  it('retains a later received POST 5xx as outcomeUnknown without resuming a chunked delivery', async () => {
    let postCount = 0;
    const { context } = channelsCallerContext({
      async request(request) {
        if (request.url.endsWith('/oauth2/applications/@me')) return jsonResponse({ id: 'application-1' });
        if (request.url.endsWith('/users/@me')) return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        if (request.url.endsWith('/channels/channel-1')) return jsonResponse({ id: 'channel-1', type: 0 });
        if (request.url.endsWith('/channels/channel-1/messages')) {
          postCount += 1;
          return postCount === 1
            ? jsonResponse({ id: 'message-1', channel_id: 'channel-1' })
            : jsonResponse({ message: 'Discord is unavailable' }, 503);
        }
        throw new Error(`Unexpected Discord request: ${request.url}`);
      },
    });

    await expect(deliverDiscordMessage({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1,
      providerConfig: {
        applicationId: 'application-1',
        botUserId: 'discord-bot-1',
        inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=274877975552',
      },
      credentialRef,
      endpoint: { kind: 'shared', audience: 'shared', id: 'discord:channel:channel-1' },
      content: 'a'.repeat(2_001),
      deliveryKey: 'delivery-later-post-5xx',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'providerDefault',
    }, context as Parameters<typeof deliverDiscordMessage>[1])).resolves.toEqual({
      kind: 'outcomeUnknown',
      providerMessageIds: ['message-1'],
    });

    expect(postCount).toBe(2);
  });

  it('retains accepted chunks as partial when cancellation wins before a later chunk POST', async () => {
    const controller = new AbortController();
    let postCount = 0;
    const { context } = channelsCallerContext({
      signal: controller.signal,
      async request(request) {
        if (request.url.endsWith('/oauth2/applications/@me')) return jsonResponse({ id: 'application-1' });
        if (request.url.endsWith('/users/@me')) return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        if (request.url.endsWith('/channels/channel-1')) {
          if (postCount === 1) controller.abort();
          return jsonResponse({ id: 'channel-1', type: 0 });
        }
        if (request.url.endsWith('/channels/channel-1/messages')) {
          postCount += 1;
          return jsonResponse({ id: 'message-1', channel_id: 'channel-1' });
        }
        throw new Error(`Unexpected Discord request: ${request.url}`);
      },
    });

    await expect(deliverDiscordMessage({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1,
      providerConfig: {
        applicationId: 'application-1',
        botUserId: 'discord-bot-1',
        inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=274877975552',
      },
      credentialRef,
      endpoint: { kind: 'shared', audience: 'shared', id: 'discord:channel:channel-1' },
      content: 'a'.repeat(2_001),
      deliveryKey: 'delivery-cancelled-after-first-chunk',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'providerDefault',
    }, context as Parameters<typeof deliverDiscordMessage>[1])).resolves.toEqual({
      kind: 'partial',
      providerMessageIds: ['message-1'],
      failedChunk: 1,
      retrySafe: false,
    });

    expect(postCount).toBe(1);
  });

  it('does not post when Discord no longer confirms frozen topology and keeps a lookup network failure safely retryable', async () => {
    const requests: Array<Readonly<{
      url: string;
      method?: string;
      headers?: Readonly<Record<string, string>>;
      body?: Uint8Array;
    }>> = [];
    const { context } = channelsCallerContext({
      async request(request) {
        requests.push(request);
        if (request.url.endsWith('/oauth2/applications/@me')) return jsonResponse({ id: 'application-1' });
        if (request.url.endsWith('/users/@me')) return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        if (request.url.endsWith('/channels/direct-1')) return jsonResponse({ id: 'direct-1', type: 0 });
        if (request.url.endsWith('/channels/thread-1')) return jsonResponse({ id: 'thread-1', type: 11, parent_id: 'parent-current' });
        if (request.url.endsWith('/channels/network-1')) return jsonResponse({ message: 'Discord is unavailable' }, 500);
        if (request.url.endsWith('/messages')) return jsonResponse({ id: 'must-not-send' });
        throw new Error(`Unexpected Discord request: ${request.url}`);
      },
    });
    const connection = {
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1,
      providerConfig: {
        applicationId: 'application-1',
        botUserId: 'discord-bot-1',
        inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=274877975552',
      },
      credentialRef,
      content: 'Hello',
      mentionPolicy: 'suppress' as const,
      linkPreviewPolicy: 'providerDefault' as const,
    };

    await expect(deliverDiscordMessage({
      ...connection,
      deliveryKey: 'delivery-direct',
      endpoint: { kind: 'direct', audience: 'direct', id: 'discord:channel:direct-1' },
    }, context as Parameters<typeof deliverDiscordMessage>[1])).resolves.toEqual({ kind: 'notDelivered', retry: 'never' });
    await expect(deliverDiscordMessage({
      ...connection,
      deliveryKey: 'delivery-thread',
      endpoint: {
        kind: 'thread',
        audience: 'shared',
        id: 'discord:channel:thread-1',
        parentId: 'discord:channel:parent-frozen',
      },
    }, context as Parameters<typeof deliverDiscordMessage>[1])).resolves.toEqual({ kind: 'notDelivered', retry: 'never' });
    await expect(deliverDiscordMessage({
      ...connection,
      deliveryKey: 'delivery-network',
      endpoint: { kind: 'direct', audience: 'direct', id: 'discord:channel:network-1' },
    }, context as Parameters<typeof deliverDiscordMessage>[1])).resolves.toEqual({ kind: 'notDelivered', retry: 'safe' });

    expect(requests.filter((request) => request.method === 'POST' && request.url.endsWith('/messages'))).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN_MANIFEST, activate } from './plugin.js';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { ConversationAttachmentFetchResultV1Schema, createConversationAttachmentIdV1, MAX_CONVERSATION_RESOLUTION_CANDIDATES } from '@happier-dev/channels-protocol/v1';

import {
  deliverDiscordMessage,
  fetchDiscordAttachment,
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
    invokedAtMs: 1_700_000_000_000,
    caller: {
      kind: 'plugin' as const,
      pluginId: 'happier.channels',
      occurrenceId: 'channels-generation-1',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'channels-generation-1', installSource: 'npm' },
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
  it('delivers a registered host notification through the saved connection without a Channels Action caller', async () => {
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const sender = kit.registration('notificationChannels', 'alerts');
      expect(sender).toBeTypeOf('function');
      const connection = { v: 1, connectionId: 'connection-1', providerConnectionKey: 'discord:application:application-1',
        providerConfigVersion: 1, providerConfig: { applicationId: 'application-1', botUserId: 'discord-bot-1' }, credentialRef };
      const effects: unknown[] = [];
      const b = channelsCallerContext({ execute: vi.fn(async () => ({ [connection.connectionId]: { ...connection,
        authorityEpoch: 1, enabled: true, deletionState: 'none', requiresFullSharedMessageContent: false } })),
        request: async input => {
          if (input.method === 'POST') { effects.push(JSON.parse(new TextDecoder().decode(input.body))); return jsonResponse({ id: 'message-1', channel_id: 'channel-1' }); }
          return jsonResponse({ id: 'channel-1', type: 0, name: 'Alerts' });
        } });
      const request = { clientRequestId: 'health-test', deliveryId: 'health-test', channelId: 'happier.channel.discord/alerts',
        title: 'App needs attention', body: 'A saved health check failed.', destination: { connectionId: 'connection-1',
          endpoint: { kind: 'shared', audience: 'shared', id: 'discord:channel:channel-1' } } };
      expect(await sender!(request, { ...b.context, caller: undefined })).toMatchObject({ status: 'accepted' });
      expect(effects).toMatchObject([{ content: 'App needs attention\nA saved health check failed.', allowed_mentions: { parse: [] } }]);
    } finally { await kit.dispose(); }
  });
  it.each(['sent', 'createRejected', 'createUnknown', 'cancelAfterCreate', 'sendRejected', 'sendUnknown'] as const)(
    'starts one public thread under the router parent and retains create evidence (%s)', async outcome => {
      const effects: { path: string; body: unknown }[] = [];
      const controller = new AbortController();
      const { context } = channelsCallerContext({ signal: controller.signal, async request(input) {
        const path = new URL(input.url).pathname;
        if (path.endsWith('/oauth2/applications/@me')) return jsonResponse({ id: 'application-1' });
        if (path.endsWith('/users/@me')) return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        if (path.endsWith('/channels/parent-1')) return jsonResponse({ id: 'parent-1', type: 0, name: 'QA' });
        effects.push({ path, body: JSON.parse(new TextDecoder().decode(input.body)) });
        if (path.endsWith('/channels/parent-1/threads')) {
          if (outcome === 'createRejected') return jsonResponse({ retry_after: 9 }, 429);
          if (outcome === 'createUnknown') throw new Error('response lost after create');
          if (outcome === 'cancelAfterCreate') controller.abort();
          return jsonResponse({ id: 'thread-1', type: 11, parent_id: 'parent-1', name: 'Brief' }, 201);
        }
        if (path.endsWith('/channels/thread-1/messages')) {
          if (outcome === 'sendUnknown') throw new Error('response lost after send');
          return outcome === 'sendRejected' ? jsonResponse({ code: 50013, message: 'Missing Permissions' }, 403)
            : jsonResponse({ id: 'message-1', channel_id: 'thread-1' });
        }
        throw new Error('Unexpected Discord effect');
      } });
      const result = await deliverDiscordMessage({
        v: 1, connectionId: 'connection-1', providerConnectionKey: 'discord:application:application-1',
        providerConfigVersion: 1, providerConfig: { applicationId: 'application-1', botUserId: 'discord-bot-1' }, credentialRef,
        endpoint: { kind: 'shared', audience: 'shared', id: 'discord:channel:parent-1' },
        content: { text: 'Hello @everyone', html: '<p>Not sent</p>' }, deliveryKey: 'start-1',
        newThread: { recipients: ['principal-1'], subject: 'Brief' },  linkPreviewPolicy: 'suppress',
      }, context);
      const endpoint = { kind: 'thread', audience: 'shared', id: 'discord:channel:thread-1', parentId: 'discord:channel:parent-1' };
      expect(result).toEqual(outcome === 'sent'
        ? { kind: 'delivered', providerMessageIds: ['message-1'], endpoint }
        : outcome === 'createRejected' ? { kind: 'notDelivered', retry: 'after', retryAfterMs: 9000 }
        : outcome === 'createUnknown' ? { kind: 'outcomeUnknown' }
        : { kind: 'outcomeUnknown', endpoint });
      expect(effects[0]).toEqual({ path: '/api/v10/channels/parent-1/threads', body: { name: 'Brief', type: 11 } });
      const sentMessage = outcome !== 'createUnknown' && outcome !== 'createRejected' && outcome !== 'cancelAfterCreate';
      expect(effects).toHaveLength(sentMessage ? 2 : 1);
      if (sentMessage) expect(effects[1]).toMatchObject({
        path: '/api/v10/channels/thread-1/messages', body: {
          content: 'Hello @everyone', allowed_mentions: { parse: [] }, flags: 4, enforce_nonce: true,
        },
      });
    },
  );
  const attachmentInput = {
    v: 1, connectionId: 'connection-1', providerConnectionKey: 'discord:application:application-1',
    providerConfigVersion: 1, providerConfig: { applicationId: 'application-1', botUserId: 'discord-bot-1' }, credentialRef,
    messageId: 'message-1', attachmentIds: [createConversationAttachmentIdV1('discord', ['channel-1', 'message-1', 'file-1'])],
  };
  const freshAttachment = {
    id: 'file-1', filename: 'lead.pdf', content_type: 'application/pdf', size: 3,
    url: 'https://cdn.discordapp.com/attachments/channel-1/file-1/lead.pdf?ex=renewed',
  };
  function attachmentContext(options: Readonly<{
    attachment?: Readonly<Record<string, unknown>>;
    messageId?: string;
    channelId?: string;
    downloadStatus?: number;
    downloadError?: Error;
    messageError?: Error;
    onDownload?: () => void;
    signal?: AbortSignal;
  }> = {}) {
    const request = vi.fn(async (request: Parameters<Parameters<typeof channelsCallerContext>[0]['request']>[0]) => {
      if (request.url.endsWith('/oauth2/applications/@me')) return jsonResponse({ id: 'application-1' });
      if (request.url.endsWith('/users/@me')) return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
      if (request.url.endsWith('/channels/channel-1/messages/message-1')) {
        if (options.messageError) throw options.messageError;
        return jsonResponse({
          id: options.messageId ?? 'message-1', channel_id: options.channelId ?? 'channel-1',
          attachments: [options.attachment ?? freshAttachment],
        });
      }
      options.onDownload?.();
      if (options.downloadError) throw options.downloadError;
      return { status: options.downloadStatus ?? 200, finalUrl: request.url, headers: {}, body: Uint8Array.of(0, 128, 255) };
    });
    return { request, ...channelsCallerContext({ request, signal: options.signal }) };
  }

  it('renews the native message URL at consumption and returns schema-valid bytes without CDN credentials', async () => {
    const { context, request } = attachmentContext();
    const result = await fetchDiscordAttachment(attachmentInput, context);
    expect(ConversationAttachmentFetchResultV1Schema.parse(result)).toEqual({ kind: 'fetched', attachments: [{
      attachmentId: attachmentInput.attachmentIds[0], base64: 'AID/',
    }] });
    expect(request.mock.calls.map(([request]) => request.url)).toContain('https://discord.com/api/v10/channels/channel-1/messages/message-1');
    const download = request.mock.calls.at(-1)?.[0];
    expect(download).toMatchObject({ url: freshAttachment.url, method: 'GET', redirect: 'error' });
    expect(download?.headers ?? {}).not.toHaveProperty('authorization');
    expect(download).not.toHaveProperty('timeoutMs');
  });

  it.each([
    'https://evil.example/attachments/channel-1/file-1/lead.pdf',
    'http://cdn.discordapp.com/attachments/channel-1/file-1/lead.pdf',
    'https://cdn.discordapp.com@evil.example/attachments/channel-1/file-1/lead.pdf',
    'https://token@cdn.discordapp.com/attachments/channel-1/file-1/lead.pdf',
    'https://cdn.discordapp.com/attachments/another-channel/file-1/lead.pdf',
    'https://cdn.discordapp.com/attachments/channel-1/another-file/lead.pdf',
  ])('refuses untrusted or mismatched native CDN URL %s without fetching it', async (url) => {
    const onDownload = vi.fn();
    const { context } = attachmentContext({ attachment: { ...freshAttachment, url }, onDownload });
    await expect(fetchDiscordAttachment(attachmentInput, context)).resolves.toMatchObject({ kind: 'notReady', reason: 'unsupported' });
    expect(onDownload).not.toHaveBeenCalled();
  });

  it.each([403, 404])('returns typed unavailable when the renewed download expires or disappears (%i)', async (downloadStatus) => {
    const { context } = attachmentContext({ downloadStatus });
    await expect(fetchDiscordAttachment(attachmentInput, context)).resolves.toMatchObject({
      kind: 'notReady', reason: downloadStatus === 403 ? 'permissionMissing' : 'unsupported',
    });
  });

  it.each([{ messageId: 'other' }, { channelId: 'other' }, { attachment: { ...freshAttachment, id: 'other' } }])(
    'refuses files belonging to a different native message, channel or attachment', async (options) => {
      const onDownload = vi.fn();
      const { context } = attachmentContext({ ...options, onDownload });
      await expect(fetchDiscordAttachment(attachmentInput, context)).resolves.toMatchObject({ kind: 'notReady' });
      expect(onDownload).not.toHaveBeenCalled();
    },
  );

  it('refuses non-core callers and foreign credentials before credential or HTTP I/O', async () => {
    const { context, request, materialize } = attachmentContext();
    await expect(fetchDiscordAttachment({}, { ...context, surface: 'cli' })).rejects.toMatchObject({ code: 'discord_channels_core_caller_required' });
    await expect(fetchDiscordAttachment({ ...attachmentInput, credentialRef: {
      ...credentialRef, service: { ...credentialRef.service, pluginId: 'other.plugin' },
    } }, context)).resolves.toMatchObject({ kind: 'notReady', reason: 'credentialInvalid' });
    expect(materialize).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'retired'] as const)('propagates %s during the CDN boundary', async (kind) => {
    const controller = new AbortController();
    const error = kind === 'retired'
      ? new PluginError({ code: 'plugin_final_generation_retired', message: 'Retired' })
      : new Error('Cancelled');
    const { context } = attachmentContext({ signal: controller.signal, downloadError: error,
      onDownload: () => { if (kind === 'cancel') controller.abort(error); } });
    await expect(fetchDiscordAttachment(attachmentInput, context)).rejects.toBe(error);
  });

  it('propagates host generation retirement during the renewed message read', async () => {
    const error = new PluginError({ code: 'plugin_final_generation_retired', message: 'Retired' });
    const { context } = attachmentContext({ messageError: error });
    await expect(fetchDiscordAttachment(attachmentInput, context)).rejects.toBe(error);
  });

  it('refuses unsupported new threads before any Discord request', async () => {
    const request = vi.fn(async () => { throw new Error('Unsupported starts must not call Discord'); });
    const { context } = channelsCallerContext({ request });
    await expect(deliverDiscordMessage({
      v: 1, connectionId: 'connection-1', providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1, providerConfig: { applicationId: 'application-1', botUserId: 'discord-bot-1' }, credentialRef,
      endpoint: { kind: 'direct', audience: 'direct', id: 'discord:channel:direct-1' },
      content: { text: 'Brief', html: '<p>Brief</p>' }, deliveryKey: 'start-1',
      newThread: { recipients: ['principal-1'], subject: 'Brief' },
       linkPreviewPolicy: 'suppress',
    }, context)).resolves.toEqual({ kind: 'notReady', reason: 'unsupported' });
    expect(request).not.toHaveBeenCalled();
  });
  it('reads retained connection identity while ignoring retired provider configuration fields', () => {
    const retained = {
      providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1,
      providerConfig: { applicationId: 'application-1', botUserId: 'discord-bot-1', retiredBotAlias: 'old' },
      credentialRef,
    };
    expect(readDiscordConnectionConfiguration(retained)).toEqual({
      applicationId: 'application-1', botUserId: 'discord-bot-1',
    });
    expect(readDiscordConnectionConfiguration({
      ...retained, providerConfig: { ...retained.providerConfig, applicationId: '' },
    })).toMatchObject({ kind: 'notReady', reason: 'invalidConfiguration' });
    expect(readDiscordConnectionConfiguration({
      ...retained, credentialRef: { ...credentialRef, service: { ...credentialRef.service, pluginId: 'other.plugin' } },
    })).toMatchObject({ kind: 'notReady', reason: 'credentialInvalid' });
  });

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

  it.each([0, 86_400_000])('rechecks the selected socket gateway prerequisite with reset_after %i during connection test', async (resetAfterMs) => {
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
              reset_after: resetAfterMs,
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

  it.each([0, 86_400_000])('materializes the exact selected bot account before verifying its identities with reset_after %i', async (resetAfterMs) => {
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
              reset_after: resetAfterMs,
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
          inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=309237713920',
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
        content: { text: 'reply' },
        deliveryKey: `delivery-materialize-${scenario.name}`,

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
        content: { text: 'reply' },
        deliveryKey: `delivery-materialize-${scenario.name}`,

        linkPreviewPolicy: 'suppress',
      }, context as Parameters<typeof deliverDiscordMessage>[1])).rejects.toBe(scenario.error);

      expect(materialize).toHaveBeenCalledOnce();
      expect(requests).not.toHaveBeenCalled();
    }
  });

  it('keeps no-effect Discord destination lookup failures retryable before a message POST', async () => {
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
        response: jsonResponse({ retry_after: 86_401 }, 429),
        expected: {
          kind: 'notDelivered' as const,
          retry: 'after' as const,
          retryAfterMs: 86_401_000,
        },
      },
    ]) {
      const requests: Array<Readonly<{ url: string; method?: string }>> = [];
      const { context } = channelsCallerContext({
        async request(request) {
          requests.push(request);
          if (request.url.endsWith('/channels/channel-1')) return scenario.response;
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
        content: { text: 'reply' },
        deliveryKey: `delivery-identity-${scenario.name}`,

        linkPreviewPolicy: 'suppress',
      }, context as Parameters<typeof deliverDiscordMessage>[1])).resolves.toEqual(scenario.expected);

      expect(requests.filter((request) => request.method === 'POST' && request.url.endsWith('/messages'))).toEqual([]);
    }
  });

  it('finds named guild channels and active threads without guessing a DM or returning an inaccessible match', async () => {
    const requests: string[] = [];
    const { context } = channelsCallerContext({ async request(input) {
      const url = new URL(input.url);
      requests.push(url.pathname);
      if (url.pathname.endsWith('/users/@me/guilds')) return jsonResponse([{ id: 'guild-1' }]);
      if (url.pathname.endsWith('/guilds/guild-1/channels')) return jsonResponse([
        { id: '101', type: 0, name: 'QA-general', permission_overwrites: [] },
        { id: '102', type: 0, name: 'QA-private', permission_overwrites: [{ id: 'guild-1', type: 0, allow: '0', deny: '1024' }] },
        { id: '103', type: 2, name: 'QA-voice' },
        { id: '104', type: 0, name: 'other', permission_overwrites: [] },
      ]);
      if (url.pathname.endsWith('/guilds/guild-1/threads/active')) return jsonResponse({
        threads: [{ id: '105', type: 11, name: 'QA-review', parent_id: '104' }], members: [],
      });
      if (url.pathname.endsWith('/channels/104')) return jsonResponse({ id: '104', type: 0, guild_id: 'guild-1', name: 'other', permission_overwrites: [] });
      if (url.pathname.endsWith('/guilds/guild-1/members/discord-bot-1')) return jsonResponse({ user: { id: 'discord-bot-1' }, roles: [] });
      if (url.pathname.endsWith('/guilds/guild-1/roles')) return jsonResponse([{ id: 'guild-1', permissions: '274877975552' }]);
      throw new Error(`Unexpected Discord request: ${url.pathname}`);
    } });
    await expect(resolveDiscordEndpoint({
      v: 1, connectionId: 'connection-1', providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1, providerConfig: { applicationId: 'application-1', botUserId: 'discord-bot-1' },
      credentialRef, query: 'qA', kinds: ['shared', 'thread'],
    }, context)).resolves.toEqual({ kind: 'resolved', candidates: [
      { kind: 'shared', audience: 'shared', id: 'discord:channel:101', label: 'QA-general' },
      { kind: 'thread', audience: 'shared', id: 'discord:channel:105', parentId: 'discord:channel:104', label: 'QA-review', parentLabel: 'other' },
    ] });
    expect(requests.some(path => path.endsWith('/users/@me/channels'))).toBe(false);
    expect(requests.some(path => path.endsWith('/channels/103'))).toBe(false);
  });

  it('surfaces name-discovery rate limits instead of reporting an empty search', async () => {
    const { context } = channelsCallerContext({ request: async () => jsonResponse({ retry_after: 3 }, 429) });
    await expect(resolveDiscordEndpoint({
      v: 1, connectionId: 'connection-1', providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1, providerConfig: { applicationId: 'application-1', botUserId: 'discord-bot-1' },
      credentialRef, query: 'review', kinds: ['thread'],
    }, context)).resolves.toMatchObject({ kind: 'notReady', reason: 'rateLimited', retryAfterMs: 3000 });
  });

  it.each([MAX_CONVERSATION_RESOLUTION_CANDIDATES, MAX_CONVERSATION_RESOLUTION_CANDIDATES + 1])(
    'handles %i name matches at the existing endpoint-result boundary', async count => {
      const { context } = channelsCallerContext({ async request(input) {
        const path = new URL(input.url).pathname;
        if (path.endsWith('/users/@me/guilds')) return jsonResponse([{ id: 'guild-1' }]);
        if (path.endsWith('/guilds/guild-1/channels')) return jsonResponse(Array.from({ length: count }, (_, index) => ({
          id: String(index + 1), type: 0, name: `QA-${index}`, permission_overwrites: [],
        })));
        if (path.endsWith('/members/discord-bot-1')) return jsonResponse({ user: { id: 'discord-bot-1' }, roles: [] });
        if (path.endsWith('/roles')) return jsonResponse([{ id: 'guild-1', permissions: '274877975552' }]);
        throw new Error(`Unexpected Discord request: ${path}`);
      } });
      const result = await resolveDiscordEndpoint({
        v: 1, connectionId: 'connection-1', providerConnectionKey: 'discord:application:application-1',
        providerConfigVersion: 1, providerConfig: { applicationId: 'application-1', botUserId: 'discord-bot-1' },
        credentialRef, query: 'QA', kinds: ['shared'],
      }, context);
      if (count > MAX_CONVERSATION_RESOLUTION_CANDIDATES) {
        expect(result).toMatchObject({ kind: 'notReady', reason: 'unsupported', diagnostic: expect.any(String) });
      } else {
        expect(result.kind).toBe('resolved');
        if (result.kind === 'resolved') expect(result.candidates).toHaveLength(count);
      }
    },
  );

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
      'https://discord.com/api/v10/channels/101',
      'https://discord.com/api/v10/channels/102',
      'https://discord.com/api/v10/guilds/guild-1/members/discord-bot-1',
      'https://discord.com/api/v10/guilds/guild-1/roles',
    ]);
  });

  it.each([15, 16])('inherits thread permissions from a type %i parent without exposing the parent as a target', async (parentType) => {
    const { context } = channelsCallerContext({
      async request(request) {
        if (request.url.endsWith('/oauth2/applications/@me')) return jsonResponse({ id: 'application-1' });
        if (request.url.endsWith('/users/@me')) return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        if (request.url.endsWith('/channels/101')) {
          return jsonResponse({ id: '101', type: 11, guild_id: 'guild-1', parent_id: '102' });
        }
        if (request.url.endsWith('/channels/102')) {
          return jsonResponse({ id: '102', type: parentType, guild_id: 'guild-1', permission_overwrites: [] });
        }
        if (request.url.endsWith('/guilds/guild-1/members/discord-bot-1')) {
          return jsonResponse({ user: { id: 'discord-bot-1' }, roles: [] });
        }
        if (request.url.endsWith('/guilds/guild-1/roles')) {
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

  it.each([undefined, 0, 1])('keeps each core chunk %s reply reference and maps only exact Discord archive evidence', async (chunkIndex) => {
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
      content: { text: 'Hello <@123>' },
      deliveryKey,
      ...(chunkIndex === undefined ? {} : { chunkIndex }),
      replyContext: { replyToMessageId: 'message-1' },

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

  it('does not split a core delivery when Discord refuses its oversized content', async () => {
    let postCount = 0;
    let identityReads = 0;
    const postedContents: string[] = [];
    const { context } = channelsCallerContext({
      async request(request) {
        if (request.url.endsWith('/oauth2/applications/@me')) { identityReads += 1; return jsonResponse({ id: 'application-1' }); }
        if (request.url.endsWith('/users/@me')) { identityReads += 1; return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true }); }
        if (request.url.endsWith('/channels/channel-1')) return jsonResponse({ id: 'channel-1', type: 0 });
        if (request.url.endsWith('/channels/channel-1/messages')) {
          postCount += 1;
          const payload = JSON.parse(new TextDecoder().decode(request.body)) as { content: string };
          postedContents.push(payload.content);
          return Array.from(payload.content).length > 2_000
            ? jsonResponse({ message: 'Invalid Form Body' }, 400)
            : jsonResponse({ id: `message-${postCount}`, channel_id: 'channel-1' });
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
      content: { text: 'a'.repeat(2_001) },
      deliveryKey: 'delivery-later-post-5xx',

      linkPreviewPolicy: 'providerDefault',
    }, context as Parameters<typeof deliverDiscordMessage>[1])).resolves.toEqual({
      kind: 'notDelivered',
      retry: 'never',
    });

    expect(postCount).toBe(1);
    expect(identityReads).toBe(0);
    expect(postedContents).toEqual(['a'.repeat(2_001)]);
    await expect(deliverDiscordMessage({
      v: 1, connectionId: 'connection-1', providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1, providerConfig: { applicationId: 'application-1', botUserId: 'discord-bot-1' }, credentialRef,
      endpoint: { kind: 'shared', audience: 'shared', id: 'discord:channel:channel-1' },
      content: { text: 'A normal message' }, deliveryKey: 'ordinary-admitted-identity', linkPreviewPolicy: 'suppress',
    }, context)).resolves.toEqual({ kind: 'delivered', providerMessageIds: ['message-2'] });
    expect(postCount).toBe(2);
    expect(identityReads).toBe(0);
  });

  it('keeps cancellation before the native message POST safely retryable', async () => {
    const controller = new AbortController();
    let postCount = 0;
    const { context } = channelsCallerContext({
      signal: controller.signal,
      async request(request) {
        if (request.url.endsWith('/oauth2/applications/@me')) return jsonResponse({ id: 'application-1' });
        if (request.url.endsWith('/users/@me')) return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        if (request.url.endsWith('/channels/channel-1')) {
          controller.abort();
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
      content: { text: 'a'.repeat(2_000) },
      deliveryKey: 'delivery-cancelled-before-post',

      linkPreviewPolicy: 'providerDefault',
    }, context as Parameters<typeof deliverDiscordMessage>[1])).resolves.toEqual({
      kind: 'notDelivered',
      retry: 'safe',
    });

    expect(postCount).toBe(0);
  });

  it.each(['serverFailure', 'cancelledAfterPost'] as const)('keeps %s after the native POST ambiguous without resending', async (failure) => {
    const controller = new AbortController();
    let postCount = 0;
    const { context } = channelsCallerContext({
      signal: controller.signal,
      async request(request) {
        if (request.url.endsWith('/oauth2/applications/@me')) return jsonResponse({ id: 'application-1' });
        if (request.url.endsWith('/users/@me')) return jsonResponse({ id: 'discord-bot-1', username: 'Happier', bot: true });
        if (request.url.endsWith('/channels/channel-1')) return jsonResponse({ id: 'channel-1', type: 0 });
        if (request.url.endsWith('/channels/channel-1/messages')) {
          postCount += 1;
          if (failure === 'cancelledAfterPost') {
            const error = new Error('delivery retired after POST');
            controller.abort(error);
            throw error;
          }
          return jsonResponse({ message: 'Discord is unavailable' }, 503);
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
      content: { text: 'one core chunk' },
      deliveryKey: `delivery-${failure}`,

      linkPreviewPolicy: 'providerDefault',
    }, context)).resolves.toEqual({ kind: 'outcomeUnknown' });
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
      content: { text: 'Hello' },

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

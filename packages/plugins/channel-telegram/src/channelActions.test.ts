import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN_MANIFEST, activate } from './plugin.js';

/** The exact published request input, so recorded calls keep their real shape. */
type TelegramHttpRequestInput =
  Parameters<PluginInvocationContext['services']['http']['request']>[0];

import {
  deliverTelegramMessage,
  fetchTelegramAttachments,
  pollTelegramObservations,
  remediateTelegramWebhook,
  resolveTelegramEndpoint,
  testTelegramConnection,
} from './channelActions.js';
import { TELEGRAM_BOT_CREDENTIAL_PURPOSE } from './constants.js';

const telegramAccount = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.channel.telegram', localId: 'telegram-bot' }),
  accountId: 'bot:123',
});

const connection = Object.freeze({
  v: 1 as const,
  connectionId: 'connection-1',
  providerConnectionKey: 'telegram-bot:123',
  providerConfigVersion: 1 as const,
  providerConfig: Object.freeze({ botUsername: 'HappierBot', canReadAllGroupMessages: false }),
  credentialRef: telegramAccount,
});

function response(value: unknown): Readonly<{
  status: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}> {
  return {
    status: 200,
    finalUrl: 'https://api.telegram.org/',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function coreContext(
  http: Pick<PluginInvocationContext['services']['http'], 'request'>,
  options: Readonly<{
    signal?: AbortSignal;
    materialize?: PluginInvocationContext['services']['connectedAccounts']['materialize'];
    /** The real runtime always provides host Actions; tests may observe them. */
    executeAction?: PluginInvocationContext['services']['actions']['execute'];
  }> = {},
): PluginInvocationContext {
  return {
    plugin: { id: 'happier.channel.telegram', version: '0.0.0' },
    contribution: { id: 'test', qualifiedId: 'happier.channel.telegram/actions/test' },
    surface: 'plugin',
    caller: {
      kind: 'plugin',
      pluginId: 'happier.channels',
      contribution: { id: 'test', qualifiedId: 'happier.channels/actions/test' },
      occurrenceId: 'telegram-channel-actions-fixture-generation',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'telegram-channel-actions-fixture-generation', installSource: 'npm' },
      materialization: {
        machineId: 'telegram-channel-actions-fixture-machine',
        materializationId: 'telegram-channel-actions-fixture-materialization',
        pluginId: 'happier.channels',
      },
    },
    invokedAtMs: 1_700_000_000_000,
    signal: options.signal ?? new AbortController().signal,
    services: {
      connectedAccounts: {
        materialize: options.materialize ?? vi.fn(async () => ({
          kind: 'environment' as const,
          env: { TELEGRAM_BOT_TOKEN: '123:bot-token' },
        })),
      },
      http,
      actions: {
        execute: options.executeAction ?? vi.fn(async (actionId: string) => {
          if (actionId === 'automation.event.sources.list') {
            return { kind: 'page', definitions: [], nextCursor: null, revision: '1' };
          }
          throw new Error(`unexpected host action ${actionId}`);
        }),
      },
    } as unknown as PluginInvocationContext['services'],
  };
}

function botIdentity() {
  return {
    ok: true,
    result: {
      id: 123,
      is_bot: true,
      first_name: 'Happier Bot',
      username: 'HappierBot',
      can_read_all_group_messages: false,
      has_topics_enabled: true,
    },
  };
}

describe('Telegram Channel provider actions', () => {
  it('delivers a registered host notification through the saved connection without a Channels Action caller', async () => {
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const sender = kit.registration('notificationChannels', 'alerts');
      expect(sender).toBeTypeOf('function');
      const effects: unknown[] = [];
      const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => {
        if (input.url.endsWith('/getChat')) return response({ ok: true, result: { id: 456, type: 'private' } });
        if (input.url.endsWith('/sendMessage')) { effects.push(JSON.parse(new TextDecoder().decode(input.body))); return response({ ok: true, result: { message_id: 88 } }); }
        throw new Error('Unexpected Telegram notification request');
      }) };
      const context = coreContext(http, { executeAction: vi.fn(async () => ({ [connection.connectionId]: { ...connection,
        authorityEpoch: 1, enabled: true, deletionState: 'none', requiresFullSharedMessageContent: false } })) });
      const request = { clientRequestId: 'health-test', deliveryId: 'health-test', channelId: 'happier.channel.telegram/alerts',
        title: 'App needs attention', body: 'A saved health check failed.', destination: { connectionId: 'connection-1',
          endpoint: { kind: 'direct', audience: 'direct', id: '456' } } };
      expect(await sender!(request, { ...context, caller: undefined })).toMatchObject({ status: 'accepted' });
      expect(effects).toMatchObject([{ chat_id: '456', text: 'App needs attention\nA saved health check failed.' }]);
    } finally { await kit.dispose(); }
  });
  it('resolves and sends an ordinary destination without repeating bot identity acquisition', async () => {
    const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => {
      if (input.url.endsWith('/getMe')) return response(botIdentity());
      if (input.url.endsWith('/getChat')) return response({ ok: true, result: { id: 456, type: 'private' } });
      if (input.url.endsWith('/sendMessage')) return response({ ok: true, result: { message_id: 88 } });
      throw new Error(`Unexpected Telegram request: ${input.url}`);
    }) };
    await expect(resolveTelegramEndpoint({ ...connection, query: '456' }, coreContext(http)))
      .resolves.toMatchObject({ kind: 'resolved', candidates: [{ kind: 'direct', id: '456' }] });
    await expect(deliverTelegramMessage({ ...connection, endpoint: { kind: 'direct', audience: 'direct', id: '456' },
      content: { text: 'hello' }, deliveryKey: 'ordinary-identity-read', linkPreviewPolicy: 'suppress' }, coreContext(http)))
      .resolves.toEqual({ kind: 'delivered', providerMessageIds: ['88'] });
    expect(http.request.mock.calls.filter(([request]) => request.url.endsWith('/getMe'))).toHaveLength(0);
  });

  it('fetches a descriptor after observation using fresh HTTP state and refuses message and credential mismatches', async () => {
    const observed = await pollTelegramObservations({ ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() }, limit: 10, waitMs: 0,
    }, coreContext({ async request(input) { return response(input.url.endsWith('/getMe') ? botIdentity() : {
      ok: true, result: [{ update_id: 42, message: {
        message_id: 2, date: 1700000000, chat: { id: 456, type: 'private' },
        from: { id: 789, is_bot: false }, caption: '@HappierBot inspect',
        caption_entities: [{ type: 'mention', offset: 0, length: 11 }],
        document: { file_id: 'native-file', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 5 },
      } }],
    }); } }));
    if (observed.kind !== 'batch') throw new Error('Expected attachment observation');
    const ingress = observed.observations[0]?.observation;
    if (ingress?.kind !== 'fullText') throw new Error('Expected full attachment ingress');
    expect(ingress.observation.message.addressingEvidence).toBe('directIntegrationMention');
    const attachmentId = ingress.observation.message.attachments?.[0]?.attachmentId;
    if (!attachmentId) throw new Error('Expected durable attachment ID');
    const request = { ...connection, messageId: '2', attachmentIds: [attachmentId] };
    const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => {
      if (input.url.endsWith('/getMe')) return response(botIdentity());
      if (input.url.endsWith('/getFile')) return response({ ok: true, result: { file_id: 'native-file', file_path: 'documents/file.txt', file_size: 5 } });
      return { ...response(null), finalUrl: input.url, body: new TextEncoder().encode('hello') };
    }) };
    await expect(fetchTelegramAttachments(request, coreContext(http))).resolves.toEqual({ kind: 'fetched', attachments: [{ attachmentId, base64: 'aGVsbG8=' }] });
    expect(http.request.mock.calls.filter(([input]) => input.url.endsWith('/getMe'))).toHaveLength(0);
    expect(http.request.mock.calls.some(([input]) => input.method === 'GET')).toBe(true);
    http.request.mockClear();
    await expect(fetchTelegramAttachments({ ...request, messageId: '3' }, coreContext(http))).resolves.toMatchObject({ kind: 'notReady', reason: 'unsupported' });
    expect(http.request).not.toHaveBeenCalled();
    http.request.mockClear();
    await expect(fetchTelegramAttachments({ ...request, providerConnectionKey: 'telegram-bot:999' }, coreContext(http))).resolves.toMatchObject({ kind: 'notReady', reason: 'unsupported' });
    expect(http.request).not.toHaveBeenCalled();
  });

  it('refuses cancelled attachment materialization before credential use or HTTP', async () => {
    const controller = new AbortController();
    const reason = new Error('attachment dispatch retired');
    controller.abort(reason);
    const materialize = vi.fn();
    const http = { request: vi.fn() };
    await expect(fetchTelegramAttachments({ ...connection, messageId: '2', attachmentIds: ['opaque'] },
      coreContext(http, { signal: controller.signal, materialize }))).rejects.toBe(reason);
    expect(materialize).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('admits an attachment-only update with durable descriptors and caption addressing without fetching bytes', async () => {
    const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => response(
      input.url.endsWith('/getMe') ? botIdentity() : { ok: true, result: [{ update_id: 42, message: {
        message_id: 2, date: 1700000000, chat: { id: 456, type: 'private' },
        from: { id: 789, is_bot: false },
        document: { file_id: 'native-file', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 12 },
      } }] },
    )) };
    const result = await pollTelegramObservations({ ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() }, limit: 10, waitMs: 0,
    }, coreContext(http));
    expect(result).toMatchObject({ kind: 'batch', observations: [{ observation: {
      kind: 'fullText', observation: { message: { id: '2', text: '', attachments: [{
        attachmentId: expect.any(String), name: 'notes.txt', mediaType: 'text/plain', byteLength: 12,
      }] } },
    } }] });
    expect(http.request.mock.calls.every(([request]) => !request.url.includes('/getFile') && request.method !== 'GET')).toBe(true);
  });

  it.each([
    { kind: 'direct', audience: 'direct', id: '456' },
    { kind: 'thread', audience: 'shared', id: '-100456:17', parentId: '-100456' },
  ] as const)('refuses unsupported new threads at a $kind destination before any Telegram request', async endpoint => {
    const http = { request: vi.fn(async () => { throw new Error('Unsupported starts must not call Telegram'); }) };
    await expect(deliverTelegramMessage({
      ...connection, endpoint,
      content: { text: 'Brief', html: '<p>Brief</p>' }, deliveryKey: 'start-1',
      newThread: { recipients: ['456'], subject: 'Brief' },
       linkPreviewPolicy: 'suppress',
    }, coreContext(http))).resolves.toEqual({ kind: 'notReady', reason: 'unsupported' });
    expect(http.request).not.toHaveBeenCalled();
  });

  it.each(['sent', 'createRejected', 'createUnknown', 'cancelAfterCreate', 'sendRejected', 'sendUnknown'] as const)(
    'starts one forum topic with the text alternative and retains create evidence (%s)', async outcome => {
      const effects: { method: string; body: Record<string, unknown> }[] = [];
      const controller = new AbortController();
      const http = { async request(input: TelegramHttpRequestInput) {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        if (input.url.endsWith('/getChat')) return response({ ok: true, result: {
          id: -100456, type: 'supergroup', title: 'QA', is_forum: true,
        } });
        const method = input.url.split('/').at(-1)!;
        effects.push({ method, body: JSON.parse(new TextDecoder().decode(input.body)) });
        if (method === 'createForumTopic') {
          if (outcome === 'createUnknown') throw new Error('response lost after create');
          if (outcome === 'createRejected') return response({ ok: false, error_code: 429,
            description: 'Wait', parameters: { retry_after: 10 } });
          if (outcome === 'cancelAfterCreate') controller.abort(new Error('caller cancelled'));
          return response({ ok: true, result: { message_thread_id: 17, name: 'Brief' } });
        }
        if (method === 'sendMessage') {
          if (outcome === 'sendUnknown') throw new Error('response lost after send');
          return outcome === 'sendRejected'
            ? response({ ok: false, error_code: 429, description: 'Wait', parameters: { retry_after: 10 } })
            : response({ ok: true, result: { message_id: 71 } });
        }
        throw new Error('Unexpected Telegram effect');
      } };
      const result = await deliverTelegramMessage({ ...connection,
        endpoint: { kind: 'shared', audience: 'shared', id: '-100456' },
        content: { text: 'Hello @all', html: '<p>Not sent</p>' }, deliveryKey: 'start-1',
        newThread: { recipients: ['456'], subject: 'Brief' },
         linkPreviewPolicy: 'suppress',
      }, coreContext(http, { signal: controller.signal }));
      const endpoint = { kind: 'thread', audience: 'shared', id: '-100456:17', parentId: '-100456', label: 'Brief', parentLabel: 'QA' };
      expect(result).toEqual(outcome === 'sent'
        ? { kind: 'delivered', providerMessageIds: ['71'], endpoint }
        : outcome === 'createUnknown' ? { kind: 'outcomeUnknown' }
        : outcome === 'createRejected' ? { kind: 'notDelivered', retry: 'after', retryAfterMs: 10_000 }
        : { kind: 'outcomeUnknown', endpoint });
      expect(effects[0]).toEqual({ method: 'createForumTopic', body: { chat_id: '-100456', name: 'Brief' } });
      expect(effects.slice(1)).toEqual(['createUnknown', 'createRejected', 'cancelAfterCreate'].includes(outcome) ? [] : [{ method: 'sendMessage', body: {
        chat_id: '-100456', message_thread_id: 17, text: 'Hello ＠all', link_preview_options: { is_disabled: true },
      } }]);
    },
  );

  it('refuses a non-forum shared parent without creating a topic or sending text', async () => {
    const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => {
      if (input.url.endsWith('/getMe')) return response(botIdentity());
      if (input.url.endsWith('/getChat')) return response({ ok: true, result: { id: -100456, type: 'supergroup', is_forum: false } });
      throw new Error('No native effect is allowed');
    }) };
    await expect(deliverTelegramMessage({ ...connection, endpoint: { kind: 'shared', audience: 'shared', id: '-100456' },
      content: { text: 'Brief' }, deliveryKey: 'start-1', newThread: { recipients: ['456'], subject: 'Brief' },
       linkPreviewPolicy: 'suppress',
    }, coreContext(http))).resolves.toEqual({ kind: 'notReady', reason: 'unsupported' });
    expect(http.request.mock.calls.every(([input]) => input.url.endsWith('/getMe') || input.url.endsWith('/getChat'))).toBe(true);
  });
  it('deletes a conflicting webhook only through the exact selected bot account without dropping pending updates', async () => {
    const materialize = vi.fn(async () => ({
      kind: 'environment' as const,
      env: { TELEGRAM_BOT_TOKEN: '123:bot-token' },
    }));
    const http = {
      request: vi.fn(async (_input: TelegramHttpRequestInput) => response({ ok: true, result: true })),
    };

    await expect(remediateTelegramWebhook({ credentialRef: telegramAccount }, coreContext(http, { materialize })))
      .resolves.toEqual({ kind: 'remediated' });
    expect(materialize).toHaveBeenCalledWith(
      TELEGRAM_BOT_CREDENTIAL_PURPOSE,
      { kind: 'environment', keys: ['TELEGRAM_BOT_TOKEN'] },
      expect.objectContaining({ expectedAccount: telegramAccount }),
    );
    expect(http.request).toHaveBeenCalledOnce();
    const request = http.request.mock.calls[0]?.[0];
    expect(request?.url).toMatch(/\/deleteWebhook$/u);
    // Telegram defaults `drop_pending_updates` to false when omitted. The
    // confirmed remediation must not discard valid user messages.
    expect(request?.body).toBeUndefined();
  });

  it('does not begin a webhook remediation after its host lifetime is cancelled', async () => {
    const controller = new AbortController();
    const aborted = new Error('provider contribution retired');
    controller.abort(aborted);
    const materialize = vi.fn();
    const http = { request: vi.fn() };

    await expect(remediateTelegramWebhook(
      { credentialRef: telegramAccount },
      coreContext(http, { signal: controller.signal, materialize }),
    )).rejects.toBe(aborted);
    expect(materialize).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('does not claim a failed-response webhook delete was absent', async () => {
    const http = {
      request: vi.fn(async () => {
        throw new Error('connection reset after deleteWebhook write');
      }),
    };

    await expect(remediateTelegramWebhook(
      { credentialRef: telegramAccount },
      coreContext(http),
    )).resolves.toEqual({ kind: 'outcomeUnknown' });
    expect(http.request).toHaveBeenCalledOnce();
  });

  it('returns typed selected-transport unavailability before making a Telegram request', async () => {
    const http = {
      request: vi.fn(async () => {
        throw new Error('The unsupported transport must not make a Telegram request.');
      }),
    };

    await expect(testTelegramConnection({ ...connection, selectedTransport: 'socket' }, coreContext(http)))
      .resolves.toEqual({
        kind: 'notReady',
        reason: 'unsupported',
        diagnostic: 'Telegram Channels supports checkpointed polling only.',
      });
    expect(http.request).not.toHaveBeenCalled();
  });

  it('restates the CURRENT shared-endpoint delivery capability on every connection test', async () => {
    // BotFather group privacy is re-enabled after setup: identity is unchanged,
    // but ordinary supergroup messages stop arriving. The RETAINED connection
    // config still carries the wider capability setup observed, so a probe that
    // echoed it would report the stale truth and leave the stranded
    // `allAllowedMessages` binding apparently ready. Only a re-authenticated
    // `getMe` can answer this, so the two sources are deliberately opposed here.
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getWebhookInfo')
          ? { ok: true, result: { url: '', pending_update_count: 0 } }
          : botIdentity(),
      )),
    };

    await expect(testTelegramConnection(
      {
        ...connection,
        providerConfig: { botUsername: 'HappierBot', canReadAllGroupMessages: true },
        selectedTransport: 'checkpointedPull',
      },
      coreContext(http),
    )).resolves.toEqual({
      kind: 'ready',
      integrationPrincipal: { id: '123', label: 'Happier Bot' },
      providerConnectionKey: 'telegram-bot:123',
      sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
    });
  });

  it('restates the widened capability when Telegram group privacy is off', async () => {
    // The positive twin of the narrowing case, opposed the other way: the
    // retained config still says privacy was ON at setup while the current bot
    // may read every group message. A probe that echoed the retained value
    // would keep withholding `allAllowedMessages` the platform now delivers.
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getWebhookInfo')
          ? { ok: true, result: { url: '', pending_update_count: 0 } }
          : {
              ok: true,
              result: { ...botIdentity().result, can_read_all_group_messages: true },
            },
      )),
    };

    await expect(testTelegramConnection(
      { ...connection, selectedTransport: 'checkpointedPull' },
      coreContext(http),
    )).resolves.toMatchObject({
      kind: 'ready',
      sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages', 'allAllowedMessages'],
    });
  });

  it('does not report a saved polling connection ready while a webhook owns Telegram updates', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        if (input.url.endsWith('/getWebhookInfo')) {
          return response({ ok: true, result: { url: 'https://other.example/telegram', pending_update_count: 2 } });
        }
        throw new Error(`Unexpected Telegram request: ${input.url}`);
      }),
    };

    await expect(testTelegramConnection(
      { ...connection, selectedTransport: 'checkpointedPull' },
      coreContext(http),
    )).resolves.toEqual({
      kind: 'notReady',
      reason: 'invalidConfiguration',
      diagnostic: 'Telegram has an active webhook. Remove it before using checkpointed polling.',
    });
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it.each(['qa', '@qa group', '@'])('explains an unsupported Telegram chat query without looking it up (%s)', async (query) => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => input.url.endsWith('/getMe')
        ? response(botIdentity())
        : response({ ok: false, error_code: 400, description: 'Bad Request: chat not found' })),
    };

    await expect(resolveTelegramEndpoint({ ...connection, query }, coreContext(http)))
      .resolves.toMatchObject({ kind: 'notReady', reason: 'unsupported', diagnostic: expect.any(String) });
    expect(http.request).not.toHaveBeenCalled();
  });

  it.each(['-100456', '@qa_group'])('resolves an exact Telegram chat identifier (%s)', async (query) => {
    const http = {
      async request(input: TelegramHttpRequestInput) {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        expect(JSON.parse(new TextDecoder().decode(input.body))).toEqual({ chat_id: query });
        return response({ ok: true, result: { id: -100456, type: 'supergroup', title: 'QA group' } });
      },
    };

    await expect(resolveTelegramEndpoint({ ...connection, query }, coreContext(http)))
      .resolves.toMatchObject({ kind: 'resolved', candidates: [{ kind: 'shared', id: '-100456' }] });
  });

  it('resolves an observed Telegram topic identity through its authenticated parent chat', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        if (input.url.endsWith('/getChat')) {
          expect(JSON.parse(new TextDecoder().decode(input.body))).toEqual({ chat_id: '-100456' });
          return response({ ok: true, result: { id: -100456, type: 'supergroup', title: 'Deploys', is_forum: true } });
        }
        throw new Error(`Unexpected Telegram request: ${input.url}`);
      }),
    };

    await expect(resolveTelegramEndpoint({
      ...connection,
      query: '-100456:17',
      kinds: ['thread'],
    }, coreContext(http))).resolves.toEqual({
      kind: 'resolved',
      candidates: [{
        kind: 'thread',
        audience: 'shared',
        id: '-100456:17',
        parentId: '-100456',
        parentLabel: 'Deploys',
      }],
    });
  });

  it('establishes a no-history baseline without admitting the retained Telegram update', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe')
          ? botIdentity()
          : {
              ok: true,
              result: [{
                update_id: 99,
                message: {
                  message_id: 1,
                  date: 1_700_000_000,
                  chat: { id: 456, type: 'private' },
                  from: { id: 789, is_bot: false },
                  text: 'old message',
                },
              }],
            },
      )),
    };
    const context = coreContext(http);

    await expect(pollTelegramObservations({
      ...connection,
      checkpoint: null,
      limit: 1,
      waitMs: 0,
    }, context)).resolves.toMatchObject({
      kind: 'checkpointOnly',
      checkpointAfterBatch: {
        v: 1,
        offset: '100',
        caughtUpAtMs: expect.any(Number),
      },
    });
    expect(context.services.connectedAccounts.materialize).toHaveBeenCalledWith(
      TELEGRAM_BOT_CREDENTIAL_PURPOSE,
      { kind: 'environment', keys: ['TELEGRAM_BOT_TOKEN'] },
      expect.objectContaining({ expectedAccount: telegramAccount }),
    );
    const getUpdates = http.request.mock.calls.find(([input]) => input.url.endsWith('/getUpdates'))?.[0];
    expect(JSON.parse(new TextDecoder().decode(getUpdates?.body))).toMatchObject({ offset: -1, timeout: 0 });
  });

  it('normalizes routable Telegram refusals without their body and checkpoints only genuinely unroutable updates', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe')
          ? botIdentity()
          : {
              ok: true,
              result: [
                {
                  update_id: 42,
                  edited_message: {
                    message_id: 1,
                    date: 1_700_000_000,
                    edit_date: 1_700_000_100,
                    chat: { id: 456, type: 'private' },
                    from: { id: 789, is_bot: false },
                    text: 'edited',
                  },
                },
                {
                  update_id: 43,
                  message: {
                    message_id: 2,
                    date: 1_700_000_001,
                    chat: { id: 456, type: 'private' },
                    from: { id: 789, is_bot: false },
                    new_chat_members: [{ id: 800, is_bot: false }],
                  },
                },
                {
                  update_id: 44,
                  message: {
                    message_id: 3,
                    date: 1_700_000_002,
                    chat: { id: 456, type: 'private' },
                    from: { id: 789, is_bot: false },
                    photo: [{ file_id: 'photo-1' }],
                  },
                },
                { update_id: 45, callback_query: { id: 'callback-1' } },
                {
                  update_id: 46,
                  message: {
                  message_id: 4,
                  date: 1_700_000_003,
                  chat: { id: 456, type: 'private' },
                  from: { id: 123, is_bot: true },
                  forward_origin: { type: 'user' },
                  text: 'eligible',
                  },
                },
                {
                  update_id: 47,
                  message: {
                    message_id: 5,
                    date: 1_700_000_004,
                    chat: { id: 456, type: 'private' },
                    from: { id: 789, is_bot: false },
                    text: 'x'.repeat(65536 + 1),
                  },
                },
              ],
            },
      )),
    };

    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, coreContext(http));

    expect(result).toMatchObject({
      kind: 'batch',
      observations: [
        {
          observation: {
            kind: 'routableNonAdmission',
            reason: 'unsupportedEdit',
            shell: {
              occurrenceId: 'telegram:update:42',
              endpoint: { kind: 'direct', audience: 'direct', id: '456' },
              actor: { principalId: '789', kind: 'human', isIntegrationSelf: false },
              message: { id: '1', revision: '1700000100000' },
            },
          },
        },
        {
          observation: {
            kind: 'routableNonAdmission',
            reason: 'unsupportedContent',
            shell: { occurrenceId: 'telegram:update:43', message: { id: '2' } },
          },
        },
        {
          observation: {
            kind: 'routableNonAdmission',
            reason: 'unsupportedContent',
            shell: { occurrenceId: 'telegram:update:44', message: { id: '3' } },
          },
        },
        {
          observation: {
            kind: 'fullText',
            observation: {
              occurrenceId: 'telegram:update:46',
              endpoint: { kind: 'direct', audience: 'direct', id: '456' },
              actor: { principalId: '123', kind: 'bot', isIntegrationSelf: true },
              message: {
                id: '4',
                text: 'eligible',
                addressingEvidence: 'none',
                contentProvenance: 'forwarded',
              },
            },
          },
        },
        {
          observation: {
            kind: 'fullText',
            observation: { occurrenceId: 'telegram:update:47', message: { id: '5', text: 'x'.repeat(65536 + 1) } },
          },
        },
      ],
      checkpointAfterBatch: {
        v: 1,
        offset: '48',
        caughtUpAtMs: expect.any(Number),
      },
    });
    if (result.kind !== 'batch') throw new Error('Expected a Telegram poll batch.');
    for (const entry of result.observations) {
      const ingress = entry.observation;
      if (ingress.kind === 'routableNonAdmission') {
        expect(ingress.shell.message).not.toHaveProperty('text');
      }
    }
  });

  it('does not invent an immutable revision for an edited Telegram update without edit_date', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe')
          ? botIdentity()
          : {
              ok: true,
              result: [{
                update_id: 42,
                edited_message: {
                  message_id: 1,
                  date: 1_700_000_000,
                  chat: { id: 456, type: 'private' },
                  from: { id: 789, is_bot: false },
                  text: 'edited without immutable revision evidence',
                },
              }],
            },
      )),
    };

    await expect(pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, coreContext(http))).resolves.toMatchObject({
      kind: 'checkpointOnly',
      checkpointAfterBatch: { v: 1, offset: '43', caughtUpAtMs: expect.any(Number) },
    });
  });

  it.each([
    { type: 'supergroup', isForum: false, threadId: 11 },
    { type: 'supergroup', isForum: true, threadId: null },
    // General is not an is_topic_message, including replies with a thread ID.
    { type: 'supergroup', isForum: true, threadId: 1 },
    { type: 'supergroup', isForum: true, threadId: 11 },
    { type: 'private', isForum: false, threadId: 11 },
  ])('keeps an ordinary reply on its parent chat ($type, forum=$isForum, thread=$threadId)', async ({ type, isForum, threadId }) => {
    const chatId = type === 'private' ? 456 : -100456;
    const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => {
      if (input.url.endsWith('/getMe')) return response(botIdentity());
      if (input.url.endsWith('/getUpdates')) return response({ ok: true, result: [{ update_id: 42, message: {
        message_id: 8, ...(threadId === null ? {} : { message_thread_id: threadId }), date: 1_700_000_000,
        chat: { id: chatId, type, ...(isForum ? { is_forum: true } : {}) },
        from: { id: 789, is_bot: false }, text: 'ordinary reply',
        reply_to_message: { message_id: 7, from: { id: 123, is_bot: true } },
      } }] });
      if (input.url.endsWith('/getChat')) return response({ ok: true, result: { id: chatId, type, is_forum: isForum } });
      if (input.url.endsWith('/sendMessage')) return response({ ok: true, result: { message_id: 88 } });
      throw new Error(`Unexpected Telegram request: ${input.url}`);
    }) };
    const context = coreContext(http);
    const result = await pollTelegramObservations({ ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() }, limit: 10, waitMs: 0,
    }, context);
    if (result.kind !== 'batch' || result.observations[0]?.observation.kind !== 'fullText') throw new Error('Expected the reply.');
    const observation = result.observations[0].observation.observation;
    expect(observation).toMatchObject({
      endpoint: { kind: type === 'private' ? 'direct' : 'shared', id: String(chatId) },
      message: { addressingEvidence: 'replyToIntegration', replyToMessageId: '7' },
    });
    await expect(deliverTelegramMessage({ ...connection, endpoint: observation.endpoint, content: { text: 'answer' },
      deliveryKey: 'ordinary-reply', replyContext: { replyToMessageId: observation.message.id },
       linkPreviewPolicy: 'suppress',
    }, context)).resolves.toMatchObject({ kind: 'delivered' });
    const sent = http.request.mock.calls.find(([input]) => input.url.endsWith('/sendMessage'))?.[0];
    expect(JSON.parse(new TextDecoder().decode(sent?.body))).toEqual({
      chat_id: String(chatId), text: 'answer', reply_parameters: { message_id: 8 }, link_preview_options: { is_disabled: true },
    });
  });

  it('normalizes a private-chat topic as a thread endpoint instead of its parent DM', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        if (input.url.endsWith('/getUpdates')) {
          return response({
            ok: true,
            result: [{
              update_id: 42,
              message: {
                message_id: 1,
                message_thread_id: 17,
                is_topic_message: true,
                date: 1_700_000_000,
                chat: { id: 456, type: 'private' },
                from: { id: 789, is_bot: false },
                text: 'private topic',
              },
            }],
          });
        }
        throw new Error(`Unexpected Telegram request: ${input.url}`);
      }),
    };

    await expect(pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 2,
      waitMs: 0,
    }, coreContext(http))).resolves.toMatchObject({
      observations: [{
        observation: {
          kind: 'fullText',
          observation: { endpoint: { kind: 'thread', audience: 'direct', id: '456:17', parentId: '456' } },
        },
      }],
    });
  });

  it('keeps one bot-wide checkpoint across routed Telegram endpoints without an observation cursor identity', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        if (input.url.endsWith('/getUpdates')) {
          return response({
            ok: true,
            result: [
              {
                update_id: 42,
                message: {
                  message_id: 1,
                  date: 1_700_000_000,
                  chat: { id: 456, type: 'private' },
                  from: { id: 789, is_bot: false },
                  text: 'direct chat',
                },
              },
              {
                update_id: 43,
                message: {
                  message_id: 2,
                  message_thread_id: 17,
                  is_topic_message: true,
                  date: 1_700_000_001,
                  chat: { id: -100456, type: 'supergroup', is_forum: true },
                  from: { id: 789, is_bot: false },
                  text: 'shared topic',
                },
              },
            ],
          });
        }
        throw new Error(`Unexpected Telegram request: ${input.url}`);
      }),
    };

    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, coreContext(http));

    expect(result).toMatchObject({
      kind: 'batch',
      observations: [
        { observation: { kind: 'fullText', observation: { endpoint: { kind: 'direct', id: '456' } } } },
        { observation: { kind: 'fullText', observation: { endpoint: { kind: 'thread', id: '-100456:17', parentId: '-100456' } } } },
      ],
      checkpointAfterBatch: { v: 1, offset: '44', caughtUpAtMs: expect.any(Number) },
    });
    if (result.kind !== 'batch') throw new Error('Expected a Telegram poll batch.');
    for (const entry of result.observations) {
      const ingress = entry.observation;
      const evidence = ingress.kind === 'fullText' ? ingress.observation : ingress.shell;
      expect(evidence).not.toHaveProperty('streamKey');
    }
    expect(result).not.toHaveProperty('checkpointStreamKey');
  });

  it('uses the immutable bot queue key to reject a poll for another Telegram bot before reading updates', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        throw new Error(`Unexpected Telegram request: ${input.url}`);
      }),
    };

    await expect(pollTelegramObservations({
      ...connection,
      providerConnectionKey: 'telegram-bot:456',
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, coreContext(http))).resolves.toEqual({
      kind: 'notReady',
      reason: 'invalidConfiguration',
      diagnostic: 'The selected Telegram bot no longer matches this Channel connection.',
    });
    expect(http.request.mock.calls.some(([input]) => input.url.endsWith('/getUpdates'))).toBe(false);
  });

  it('projects only authenticated Telegram entity and reply facts as addressing evidence', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe')
          ? botIdentity()
          : {
              ok: true,
              result: [
                {
                  update_id: 42,
                  message: {
                    message_id: 1,
                    date: 1_700_000_000,
                    chat: { id: -100456, type: 'supergroup' },
                    from: { id: 789, is_bot: false },
                    text: '@HappierBot structured username mention',
                    entities: [{ type: 'mention', offset: 0, length: 11 }],
                  },
                },
                {
                  update_id: 43,
                  message: {
                    message_id: 2,
                    date: 1_700_000_001,
                    chat: { id: -100456, type: 'supergroup' },
                    from: { id: 789, is_bot: false },
                    text: '@HappierBot rendered text alone',
                  },
                },
                {
                  update_id: 44,
                  message: {
                    message_id: 3,
                    date: 1_700_000_002,
                    chat: { id: -100456, type: 'supergroup' },
                    from: { id: 789, is_bot: false },
                    text: 'Happier Bot',
                    entities: [{ type: 'text_mention', offset: 0, length: 11, user: { id: 123 } }],
                  },
                },
                {
                  update_id: 45,
                  message: {
                    message_id: 4,
                    date: 1_700_000_003,
                    chat: { id: -100456, type: 'supergroup' },
                    from: { id: 789, is_bot: false },
                    text: 'reply to bot',
                    reply_to_message: { message_id: 90, from: { id: 123, is_bot: true } },
                  },
                },
                {
                  update_id: 46,
                  message: {
                    message_id: 5,
                    date: 1_700_000_004,
                    chat: { id: -100456, type: 'supergroup' },
                    from: { id: 789, is_bot: false },
                    text: 'reply to a human',
                    reply_to_message: { message_id: 91, from: { id: 456, is_bot: false } },
                  },
                },
                {
                  update_id: 47,
                  message: {
                    message_id: 6,
                    date: 1_700_000_005,
                    chat: { id: -100456, type: 'supergroup' },
                    from: { id: 789, is_bot: false },
                    text: 'Ada Lovelace',
                    entities: [{ type: 'text_mention', offset: 0, length: 12, user: { id: 456 } }],
                  },
                },
                {
                  update_id: 48,
                  message: {
                    message_id: 7,
                    date: 1_700_000_006,
                    chat: { id: -100456, type: 'supergroup' },
                    from: { id: 789, is_bot: false },
                    text: '@HappierBot mention wins over reply',
                    entities: [{ type: 'mention', offset: 0, length: 11 }],
                    reply_to_message: { message_id: 92, from: { id: 123, is_bot: true } },
                  },
                },
                {
                  update_id: 49,
                  message: {
                    message_id: 8,
                    date: 1_700_000_007,
                    chat: { id: -100456, type: 'supergroup' },
                    from: { id: 789, is_bot: false },
                    text: 'reply with missing bot marker',
                    reply_to_message: { message_id: 93, from: { id: 123 } },
                  },
                },
                {
                  update_id: 50,
                  message: {
                    message_id: 9,
                    date: 1_700_000_008,
                    chat: { id: -100456, type: 'supergroup' },
                    from: { id: 789, is_bot: false },
                    text: 'reply with malformed bot marker',
                    reply_to_message: { message_id: 94, from: { id: 123, is_bot: 'true' } },
                  },
                },
              ],
            },
      )),
    };

    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, coreContext(http));

    expect(result).toMatchObject({ kind: 'batch' });
    if (result.kind !== 'batch') throw new Error('Expected a Telegram poll batch.');
    const observations = new Map(result.observations.flatMap(({ observation: ingress }) => (
      ingress.kind === 'fullText'
        ? [[ingress.observation.occurrenceId, ingress.observation] as const]
        : []
    )));
    expect(observations.get('telegram:update:42')).toMatchObject({
      endpoint: { kind: 'shared', audience: 'shared', id: '-100456' },
      message: { addressingEvidence: 'directIntegrationMention' },
    });
    expect(observations.get('telegram:update:43')?.message).toMatchObject({ addressingEvidence: 'none' });
    expect(observations.get('telegram:update:44')?.message).toMatchObject({ addressingEvidence: 'directIntegrationMention' });
    expect(observations.get('telegram:update:45')?.message).toMatchObject({
      addressingEvidence: 'replyToIntegration',
      replyToMessageId: '90',
    });
    expect(observations.get('telegram:update:46')?.message).toMatchObject({ addressingEvidence: 'none' });
    expect(observations.get('telegram:update:46')?.message).not.toHaveProperty('replyToMessageId');
    expect(observations.get('telegram:update:47')?.message).toMatchObject({ addressingEvidence: 'none' });
    expect(observations.get('telegram:update:48')?.message).toMatchObject({ addressingEvidence: 'directIntegrationMention' });
    expect(observations.get('telegram:update:48')?.message).not.toHaveProperty('replyToMessageId');
    expect(observations.get('telegram:update:49')?.message).toMatchObject({ addressingEvidence: 'none' });
    expect(observations.get('telegram:update:49')?.message).not.toHaveProperty('replyToMessageId');
    expect(observations.get('telegram:update:50')?.message).toMatchObject({ addressingEvidence: 'none' });
    expect(observations.get('telegram:update:50')?.message).not.toHaveProperty('replyToMessageId');
  });

  it.each([
    ['/pair@HappierBot ABCD2345', '/pair ABCD2345'],
    ['/start@happierbot ABCD2345', '/start ABCD2345'],
    ['/allow@HAPPIERBOT request-1 session', '/allow request-1 session'],
  ])('normalizes an offset-zero command for the authenticated bot while retaining raw provider evidence', async (rawText, commandText) => {
    const commandLength = rawText.indexOf(' ');
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe')
          ? botIdentity()
          : {
              ok: true,
              result: [{
                update_id: 42,
                message: {
                  message_id: 1,
                  date: 1_700_000_000,
                  chat: { id: 456, type: 'private' },
                  from: { id: 789, is_bot: false },
                  text: rawText,
                  entities: [{ type: 'bot_command', offset: 0, length: commandLength }],
                },
              }],
            },
      )),
    };

    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, coreContext(http));

    expect(result).toMatchObject({
      kind: 'batch',
      observations: [{
        observation: { kind: 'fullText', observation: { message: { text: commandText } } },
        eventCandidate: { payload: { text: rawText } },
      }],
    });
  });

  it.each([
    {
      text: '/start@AnotherBot ABCD2345',
      entities: [{ type: 'bot_command', offset: 0, length: 17 }],
    },
    {
      text: 'note /start@HappierBot ABCD2345',
      entities: [{ type: 'bot_command', offset: 5, length: 17 }],
    },
  ])('does not grant command authority to a wrong-bot or nonzero Telegram command entity', async ({ text, entities }) => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe')
          ? botIdentity()
          : {
              ok: true,
              result: [{
                update_id: 42,
                message: {
                  message_id: 1,
                  date: 1_700_000_000,
                  chat: { id: 456, type: 'private' },
                  from: { id: 789, is_bot: false },
                  text,
                  entities,
                },
              }],
            },
      )),
    };

    await expect(pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, coreContext(http))).resolves.toMatchObject({
      kind: 'batch',
      observations: [{ observation: { kind: 'fullText', observation: { message: { text } } } }],
    });
  });

  it.each([
    { type: 'group', id: -456, forum: false, privateTopics: false },
    { type: 'supergroup', id: -100456, forum: false, privateTopics: false },
    { type: 'private', id: 456, forum: false, privateTopics: false },
  ])('refuses an ordinary reply thread retained or manually entered on a chat without topics ($type)', async ({ type, id, forum, privateTopics }) => {
    const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => {
      if (input.url.endsWith('/getMe')) return response({ ...botIdentity(), result: { ...botIdentity().result, has_topics_enabled: privateTopics } });
      if (input.url.endsWith('/getChat')) return response({ ok: true, result: { id, type, is_forum: forum } });
      if (input.url.endsWith('/sendMessage')) return response({ ok: true, result: { message_id: 88 } });
      throw new Error(`Unexpected Telegram request: ${input.url}`);
    }) };
    await expect(resolveTelegramEndpoint({ ...connection, query: `${id}:17` }, coreContext(http)))
      .resolves.toMatchObject({ kind: 'resolved', candidates: [] });
    await expect(deliverTelegramMessage({ ...connection,
      endpoint: { kind: 'thread', audience: type === 'private' ? 'direct' : 'shared', id: `${id}:17`, parentId: String(id) },
      content: { text: 'not a topic' }, deliveryKey: 'invalid-topic',  linkPreviewPolicy: 'suppress',
    }, coreContext(http))).resolves.toEqual({ kind: 'notDelivered', retry: 'never' });
    expect(http.request.mock.calls.some(([input]) => input.url.endsWith('/sendMessage'))).toBe(false);
    expect(http.request.mock.calls.filter(([input]) => input.url.endsWith('/getMe'))).toHaveLength(type === 'private' ? 2 : 0);
  });

  it.each([
    { type: 'supergroup', id: -100456, topic: false },
    { type: 'supergroup', id: -100456, topic: true },
    { type: 'private', id: 456, topic: true },
  ])('suppresses username mentions at the native Unicode limit for ordinary reply and topic deliveries ($type, topic=$topic)', async ({ type, id, topic }) => {
    const suffix = ' @SomeActualUsername @OtherUser';
    const text = `${'😀'.repeat(4096 - Array.from(suffix).length)}${suffix}`;
    const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => {
      if (input.url.endsWith('/getMe')) return response(botIdentity());
      if (input.url.endsWith('/getChat')) return response({ ok: true, result: { id, type, is_forum: type === 'supergroup' } });
      if (input.url.endsWith('/sendMessage')) return response({ ok: true, result: { message_id: 88 } });
      throw new Error(`Unexpected Telegram request: ${input.url}`);
    }) };
    await expect(deliverTelegramMessage({ ...connection,
      endpoint: topic ? { kind: 'thread', audience: type === 'private' ? 'direct' : 'shared', id: `${id}:17`, parentId: String(id) }
        : { kind: 'shared', audience: 'shared', id: String(id) },
      content: { text }, deliveryKey: 'mention-suppression', replyContext: { replyToMessageId: '7' },
       linkPreviewPolicy: 'suppress',
    }, coreContext(http))).resolves.toMatchObject({ kind: 'delivered' });
    const sent = http.request.mock.calls.find(([input]) => input.url.endsWith('/sendMessage'))?.[0];
    const body = JSON.parse(new TextDecoder().decode(sent?.body));
    expect(body).toEqual({ chat_id: String(id), text: text.replaceAll('@', '＠'),
      ...(topic ? { message_thread_id: 17 } : {}),
      reply_parameters: { message_id: 7 }, link_preview_options: { is_disabled: true } });
    expect(Array.from(body.text)).toHaveLength(4096);
  });

  it.each([undefined, '17', '456:17'])('delivers a private-chat thread endpoint with thread relation %s', async (threadId) => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        if (input.url.endsWith('/getChat')) {
          return response({ ok: true, result: { id: 456, type: 'private', first_name: 'Ada' } });
        }
        if (input.url.endsWith('/sendMessage')) return response({ ok: true, result: { message_id: 88 } });
        throw new Error(`Unexpected Telegram request: ${input.url}`);
      }),
    };

    await expect(deliverTelegramMessage({
      ...connection,
      endpoint: { kind: 'thread', audience: 'direct', id: '456:17', parentId: '456' },
      content: { text: 'topic reply' },
      deliveryKey: 'delivery-1',
      ...(threadId === undefined ? {} : { replyContext: { threadId, replyToMessageId: '7' } }),

      linkPreviewPolicy: 'suppress',
    }, coreContext(http))).resolves.toEqual({ kind: 'delivered', providerMessageIds: ['88'] });
    expect(http.request.mock.calls.filter(([input]) => input.url.endsWith('/getMe'))).toHaveLength(1);

    const sendMessage = http.request.mock.calls.find(([input]) => input.url.endsWith('/sendMessage'))?.[0];
    expect(JSON.parse(new TextDecoder().decode(sendMessage?.body))).toMatchObject({
      chat_id: '456',
      message_thread_id: 17,
      ...(threadId === undefined ? {} : { reply_parameters: { message_id: 7 } }),
    });
  });

  it.each([undefined, 0, 1])('keeps thread addressing while replying only on the first core chunk %s', async (chunkIndex) => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        if (input.url.endsWith('/getChat')) {
          return response({ ok: true, result: { id: 456, type: 'private', first_name: 'Ada' } });
        }
        if (input.url.endsWith('/sendMessage')) return response({ ok: true, result: { message_id: 88 } });
        throw new Error(`Unexpected Telegram request: ${input.url}`);
      }),
    };

    await expect(deliverTelegramMessage({
      ...connection,
      endpoint: { kind: 'thread', audience: 'direct', id: '456:17', parentId: '456' },
      content: { text: 'one core chunk' },
      deliveryKey: 'delivery-1',
      ...(chunkIndex === undefined ? {} : { chunkIndex }),
      replyContext: { threadId: '17', replyToMessageId: '7' },

      linkPreviewPolicy: 'suppress',
    }, coreContext(http))).resolves.toEqual({ kind: 'delivered', providerMessageIds: ['88'] });

    const sends = http.request.mock.calls.filter(([input]) => input.url.endsWith('/sendMessage'));
    expect(sends).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(sends[0]?.[0].body))).toEqual({
      chat_id: '456',
      text: 'one core chunk',
      message_thread_id: 17,
      link_preview_options: { is_disabled: true },
      ...((chunkIndex ?? 0) === 0 ? { reply_parameters: { message_id: 7 } } : {}),
    });
  });

  it('refuses thread endpoints whose audience disagrees with authenticated chat topology', async () => {
    for (const { endpoint, chat } of [
      {
        endpoint: { kind: 'thread' as const, audience: 'shared' as const, id: '456:17', parentId: '456' },
        chat: { id: 456, type: 'private', first_name: 'Ada' },
      },
      {
        endpoint: { kind: 'thread' as const, audience: 'direct' as const, id: '-100456:17', parentId: '-100456' },
        chat: { id: -100456, type: 'supergroup', title: 'Team' },
      },
    ]) {
      const http = {
        request: vi.fn(async (input: TelegramHttpRequestInput) => {
          if (input.url.endsWith('/getMe')) return response(botIdentity());
          if (input.url.endsWith('/getChat')) return response({ ok: true, result: chat });
          if (input.url.endsWith('/sendMessage')) return response({ ok: true, result: { message_id: 88 } });
          throw new Error(`Unexpected Telegram request: ${input.url}`);
        }),
      };

      await expect(deliverTelegramMessage({
        ...connection,
        endpoint,
        content: { text: 'wrong audience' },
        deliveryKey: `delivery-${endpoint.id}`,

        linkPreviewPolicy: 'suppress',
      }, coreContext(http))).resolves.toEqual({ kind: 'notDelivered', retry: 'never' });

      expect(http.request.mock.calls.some(([input]) => input.url.endsWith('/sendMessage'))).toBe(false);
    }
  });

  it('refuses a malformed thread endpoint identity instead of truncating it into a different Telegram topic', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        if (input.url.endsWith('/getChat')) {
          return response({ ok: true, result: { id: 456, type: 'private', first_name: 'Ada' } });
        }
        if (input.url.endsWith('/sendMessage')) {
          return response({ ok: true, result: { message_id: 88 } });
        }
        throw new Error(`Unexpected Telegram request: ${input.url}`);
      }),
    };

    await expect(deliverTelegramMessage({
      ...connection,
      endpoint: { kind: 'thread', audience: 'direct', id: '456:17:extra', parentId: '456' },
      content: { text: 'must not be redirected' },
      deliveryKey: 'delivery-malformed-thread',

      linkPreviewPolicy: 'suppress',
    }, coreContext(http))).resolves.toEqual({ kind: 'notDelivered', retry: 'never' });

    expect(http.request.mock.calls.some(([input]) => input.url.endsWith('/sendMessage'))).toBe(false);
  });

  it('preserves pre-send Telegram API retry classification without dispatching a message', async () => {
    for (const scenario of [
      {
        name: 'getMe rate limit',
        request: async (input: TelegramHttpRequestInput) => {
          if (input.url.endsWith('/getChat')) return response({ ok: true, result: { id: 456, type: 'private' } });
          if (input.url.endsWith('/getMe')) {
            return response({
              ok: false,
              error_code: 429,
              description: 'Too Many Requests',
              parameters: { retry_after: 3 },
            });
          }
          throw new Error(`Unexpected Telegram request: ${input.url}`);
        },
        expected: { kind: 'notDelivered' as const, retry: 'after' as const, retryAfterMs: 3_000 },
      },
      {
        name: 'getMe transport failure',
        request: async (input: TelegramHttpRequestInput) => {
          if (input.url.endsWith('/getChat')) return response({ ok: true, result: { id: 456, type: 'private' } });
          if (input.url.endsWith('/getMe')) throw new Error('connection reset');
          throw new Error(`Unexpected Telegram request: ${input.url}`);
        },
        expected: { kind: 'notDelivered' as const, retry: 'safe' as const },
      },
      {
        name: 'getChat rate limit',
        request: async (input: TelegramHttpRequestInput) => {
          if (input.url.endsWith('/getMe')) return response(botIdentity());
          if (input.url.endsWith('/getChat')) {
            return response({
              ok: false,
              error_code: 429,
              description: 'Too Many Requests',
              parameters: { retry_after: 3 },
            });
          }
          throw new Error(`Unexpected Telegram request: ${input.url}`);
        },
        expected: { kind: 'notDelivered' as const, retry: 'after' as const, retryAfterMs: 3_000 },
      },
      {
        name: 'getChat rate limit without a retry hint',
        request: async (input: TelegramHttpRequestInput) => {
          if (input.url.endsWith('/getMe')) return response(botIdentity());
          if (input.url.endsWith('/getChat')) {
            return response({
              ok: false,
              error_code: 429,
              description: 'Too Many Requests',
            });
          }
          throw new Error(`Unexpected Telegram request: ${input.url}`);
        },
        expected: { kind: 'notDelivered' as const, retry: 'safe' as const },
      },
      {
        name: 'getChat transport failure',
        request: async (input: TelegramHttpRequestInput) => {
          if (input.url.endsWith('/getMe')) return response(botIdentity());
          if (input.url.endsWith('/getChat')) throw new Error('connection reset');
          throw new Error(`Unexpected Telegram request: ${input.url}`);
        },
        expected: { kind: 'notDelivered' as const, retry: 'safe' as const },
      },
      {
        name: 'getChat invalid target',
        request: async (input: TelegramHttpRequestInput) => {
          if (input.url.endsWith('/getMe')) return response(botIdentity());
          if (input.url.endsWith('/getChat')) {
            return response({
              ok: false,
              error_code: 400,
              description: 'Bad Request: chat not found',
            });
          }
          throw new Error(`Unexpected Telegram request: ${input.url}`);
        },
        expected: { kind: 'notDelivered' as const, retry: 'never' as const },
      },
      {
        name: 'getChat permission denial',
        request: async (input: TelegramHttpRequestInput) => {
          if (input.url.endsWith('/getMe')) return response(botIdentity());
          if (input.url.endsWith('/getChat')) {
            return response({ ok: false, error_code: 403, description: 'Forbidden' });
          }
          throw new Error(`Unexpected Telegram request: ${input.url}`);
        },
        expected: { kind: 'notDelivered' as const, retry: 'never' as const },
      },
    ]) {
      const http = { request: vi.fn(scenario.request) };
      await expect(deliverTelegramMessage({
        ...connection,
        endpoint: scenario.name.startsWith('getMe')
          ? { kind: 'thread', audience: 'direct', id: '456:17', parentId: '456' }
          : { kind: 'direct', audience: 'direct', id: '456' },
        content: { text: 'reply' },
        deliveryKey: `delivery-${scenario.name}`,

        linkPreviewPolicy: 'suppress',
      }, coreContext(http))).resolves.toEqual(scenario.expected);
      expect(http.request.mock.calls.some(([input]) => input.url.endsWith('/sendMessage'))).toBe(false);
    }
  });

  it('classifies exact Connected Account materialization before any Telegram delivery effect', async () => {
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
      const http = { request: vi.fn() };

      await expect(deliverTelegramMessage({
        ...connection,
        endpoint: { kind: 'direct', audience: 'direct', id: '456' },
        content: { text: 'reply' },
        deliveryKey: `delivery-materialize-${scenario.name}`,

        linkPreviewPolicy: 'suppress',
      }, coreContext(http, { materialize }))).resolves.toEqual(scenario.expected);

      expect(materialize).toHaveBeenCalledOnce();
      expect(http.request).not.toHaveBeenCalled();
    }
  });

  it('propagates cancellation and currentness from exact Connected Account materialization before Telegram delivery', async () => {
    const cancellationController = new AbortController();
    const cancellation = new Error('The delivery invocation was cancelled.');
    for (const scenario of [
      {
        name: 'cancellation',
        error: cancellation,
        signal: cancellationController.signal,
        beforeFailure: () => cancellationController.abort(cancellation),
      },
      {
        name: 'currentness',
        error: new PluginError({
          code: 'plugin_final_generation_retired',
          message: 'The Connected Account generation is no longer current.',
        }),
        signal: new AbortController().signal,
        beforeFailure: undefined,
      },
    ]) {
      const materialize = vi.fn(async () => {
        scenario.beforeFailure?.();
        throw scenario.error;
      });
      const http = { request: vi.fn() };

      await expect(deliverTelegramMessage({
        ...connection,
        endpoint: { kind: 'direct', audience: 'direct', id: '456' },
        content: { text: 'reply' },
        deliveryKey: `delivery-materialize-${scenario.name}`,

        linkPreviewPolicy: 'suppress',
      }, coreContext(http, { signal: scenario.signal, materialize }))).rejects.toBe(scenario.error);

      expect(materialize).toHaveBeenCalledOnce();
      expect(http.request).not.toHaveBeenCalled();
    }
  });

  it('preserves sender-chat text with an unattributable actor instead of inventing a sender identity', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe')
          ? botIdentity()
          : {
              ok: true,
              result: [
                {
                  update_id: 42,
                  message: {
                    message_id: 1,
                    date: 1_700_000_000,
                    chat: { id: -100456, type: 'supergroup' },
                    sender_chat: { id: -100789, type: 'channel', title: 'Announcements' },
                    from: { id: 123, is_bot: true },
                    text: 'compatibility fake sender',
                  },
                },
                {
                  update_id: 43,
                  message: {
                    message_id: 2,
                    date: 1_700_000_001,
                    chat: { id: -100456, type: 'supergroup' },
                    sender_chat: { id: -100790, type: 'channel', title: 'Announcements' },
                    text: 'sender chat only',
                  },
                },
              ],
            },
      )),
    };

    await expect(pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, coreContext(http))).resolves.toMatchObject({
      kind: 'batch',
      observations: [
        {
          observation: {
            kind: 'fullText',
            observation: {
              occurrenceId: 'telegram:update:42',
              actor: { principalId: null, kind: 'unknown', isIntegrationSelf: false },
              message: { text: 'compatibility fake sender' },
            },
          },
        },
        {
          observation: {
            kind: 'fullText',
            observation: {
              occurrenceId: 'telegram:update:43',
              actor: { principalId: null, kind: 'unknown', isIntegrationSelf: false },
              message: { text: 'sender chat only' },
            },
          },
        },
      ],
    });
  });

  it('fails closed to unknown actors when Telegram from.is_bot is missing or malformed', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe')
          ? botIdentity()
          : {
              ok: true,
              result: [
                {
                  update_id: 42,
                  message: {
                    message_id: 1,
                    date: 1_700_000_000,
                    chat: { id: 456, type: 'private' },
                    from: { id: 789 },
                    text: 'missing bot marker',
                  },
                },
                {
                  update_id: 43,
                  message: {
                    message_id: 2,
                    date: 1_700_000_001,
                    chat: { id: 456, type: 'private' },
                    from: { id: 790, is_bot: 'false' },
                    text: 'malformed bot marker',
                  },
                },
              ],
            },
      )),
    };

    await expect(pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, coreContext(http))).resolves.toMatchObject({
      kind: 'batch',
      observations: [
        {
          observation: {
            kind: 'fullText',
            observation: {
              occurrenceId: 'telegram:update:42',
              actor: { principalId: null, kind: 'unknown', isIntegrationSelf: false },
            },
          },
        },
        {
          observation: {
            kind: 'fullText',
            observation: {
              occurrenceId: 'telegram:update:43',
              actor: { principalId: null, kind: 'unknown', isIntegrationSelf: false },
            },
          },
        },
      ],
    });
  });

  it('preserves automatic-forward provenance without trusting Telegram’s compatibility sender', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe')
          ? botIdentity()
          : {
              ok: true,
              result: [{
                update_id: 42,
                message: {
                  message_id: 1,
                  date: 1_700_000_000,
                  chat: { id: -100456, type: 'supergroup' },
                  sender_chat: { id: -100789, type: 'channel', title: 'Announcements' },
                  from: { id: 123, is_bot: true },
                  is_automatic_forward: true,
                  text: 'linked channel post',
                },
              }],
            },
      )),
    };

    await expect(pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, coreContext(http))).resolves.toMatchObject({
      kind: 'batch',
      observations: [{
        observation: {
          kind: 'fullText',
          observation: {
            occurrenceId: 'telegram:update:42',
            actor: { principalId: null, kind: 'unknown', isIntegrationSelf: false },
            message: { contentProvenance: 'forwarded', text: 'linked channel post' },
          },
        },
      }],
    });
  });

  it('uses the caller-supplied committed checkpoint instead of remembering an uncommitted returned offset', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe')
          ? botIdentity()
          : {
              ok: true,
              result: [{
                update_id: 42,
                message: {
                  message_id: 1,
                  date: 1_700_000_000,
                  chat: { id: 456, type: 'private' },
                  from: { id: 789, is_bot: false },
                  text: 'repeatable until core commits',
                },
              }],
            },
      )),
    };
    const committedCheckpoint = { v: 1, offset: '42', caughtUpAtMs: Date.now(), retiredOffsetHint: '999' } as const;

    const first = await pollTelegramObservations({
      ...connection,
      checkpoint: committedCheckpoint,
      limit: 1,
      waitMs: 0,
    }, coreContext(http));
    const replay = await pollTelegramObservations({
      ...connection,
      checkpoint: committedCheckpoint,
      limit: 1,
      waitMs: 0,
    }, coreContext(http));

    expect(first).toMatchObject({
      checkpointAfterBatch: { v: 1, offset: '43', caughtUpAtMs: expect.any(Number) },
    });
    expect(replay).toMatchObject({
      checkpointAfterBatch: { v: 1, offset: '43', caughtUpAtMs: expect.any(Number) },
    });
    const offsets = http.request.mock.calls
      .filter(([input]) => input.url.endsWith('/getUpdates'))
      .map(([input]) => JSON.parse(new TextDecoder().decode(input.body)).offset);
    expect(offsets).toEqual([42, 42]);
  });

  it('renews checkpoint freshness on a full page and keeps draining past Telegram retention', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    try {
      const caughtUpAtMs = Date.now() - 86_399_000;
      const http = {
        request: vi.fn(async (input: TelegramHttpRequestInput) => response(
          input.url.endsWith('/getMe')
            ? botIdentity()
            : {
                ok: true,
                result: [{
                  update_id: 42,
                  message: {
                    message_id: 1,
                    date: 1_700_000_000,
                    chat: { id: 456, type: 'private' },
                    from: { id: 789, is_bot: false },
                    text: 'still draining',
                  },
                }],
              },
        )),
      };

      await expect(pollTelegramObservations({
        ...connection,
        checkpoint: { v: 1, offset: '42', caughtUpAtMs },
        limit: 1,
        waitMs: 0,
      }, coreContext(http))).resolves.toMatchObject({
        checkpointAfterBatch: { v: 1, offset: '43', caughtUpAtMs: Date.now() },
      });

      vi.advanceTimersByTime(1_000);
      const retryHttp = { request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe') ? botIdentity() : { ok: true, result: [] },
      )) };
      const retryContext = coreContext(retryHttp);
      const idle = await pollTelegramObservations({
        ...connection,
        checkpoint: { v: 1, offset: '43', caughtUpAtMs },
        limit: 1,
        waitMs: 0,
      }, retryContext);
      expect(idle).toMatchObject({
        kind: 'checkpointOnly',
        checkpointAfterBatch: { v: 1, offset: '43', caughtUpAtMs },
      });
      expect(idle).not.toHaveProperty('notice');
      const updateRequests = retryHttp.request.mock.calls.filter(([input]) => input.url.endsWith('/getUpdates'));
      expect(updateRequests).toHaveLength(1);
      expect(JSON.parse(new TextDecoder().decode(updateRequests[0]?.[0].body)).offset).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews a caught-up proof when an underfull page proves Telegram is caught up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    try {
      const http = {
        request: vi.fn(async (input: TelegramHttpRequestInput) => response(
          input.url.endsWith('/getMe')
            ? botIdentity()
            : {
                ok: true,
                result: [{
                  update_id: 42,
                  message: {
                    message_id: 1,
                    date: 1_700_000_000,
                    chat: { id: 456, type: 'private' },
                    from: { id: 789, is_bot: false },
                    text: 'caught up',
                  },
                }],
              },
        )),
      };

      await expect(pollTelegramObservations({
        ...connection,
        checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() - 60_000 },
        limit: 2,
        waitMs: 0,
      }, coreContext(http))).resolves.toMatchObject({
        checkpointAfterBatch: { v: 1, offset: '43', caughtUpAtMs: Date.now() },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an invalid or unsupported legacy checkpoint for core automatic baseline recovery before provider effects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    try {
      for (const checkpoint of [
        { v: 1, offset: '-1', caughtUpAtMs: Date.now(), retiredOffsetHint: '42' },
        { v: 1, offset: '42', caughtUpAtMs: -1, retiredOffsetHint: '42' },
        { v: 1, offset: '42', observedAtMs: Date.now() },
        '42',
      ]) {
        const http = { request: vi.fn() };
        const context = coreContext(http);

        await expect(pollTelegramObservations({
          ...connection,
          checkpoint,
          limit: 1,
          waitMs: 0,
        }, context)).resolves.toMatchObject({
          kind: 'historyGap',
          reason: 'providerHistoryUnavailable',
          diagnostic: expect.any(String),
        });
        expect(context.services.connectedAccounts.materialize).not.toHaveBeenCalled();
        expect(http.request).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues a valid Telegram offset without a gap notice when only its caught-up clock is in the future', async () => {
    const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => response(
      input.url.endsWith('/getMe') ? botIdentity() : { ok: true, result: [] },
    )) };
    const result = await pollTelegramObservations({ ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() + 60_000 }, limit: 10, waitMs: 0,
    }, coreContext(http));
    expect(result).toMatchObject({ kind: 'checkpointOnly',
      checkpointAfterBatch: { offset: '42' },
    });
    expect(result).not.toHaveProperty('notice');
    const updates = http.request.mock.calls.filter(([input]) => input.url.endsWith('/getUpdates'));
    expect(updates).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(updates[0]?.[0].body)).offset).toBe(0);
  });

  it('proves a replaced Telegram sequence with one nondestructive queue read after a week offline', async () => {
    const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => response(
      input.url.endsWith('/getMe') ? botIdentity() : { ok: true, result: [{ update_id: 12, message: {
        message_id: 1, date: 1_700_000_000, chat: { id: 456, type: 'private' },
        from: { id: 789, is_bot: false }, text: 'existing item from a replaced sequence',
      } }] },
    )) };
    await expect(pollTelegramObservations({ ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() - 7 * 86_400_000 }, limit: 10, waitMs: 0,
    }, coreContext(http))).resolves.toMatchObject({ kind: 'historyGap', reason: 'providerHistoryUnavailable', diagnostic: expect.any(String) });
    const updates = http.request.mock.calls.filter(([input]) => input.url.endsWith('/getUpdates'));
    expect(updates).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(updates[0]?.[0].body))).toMatchObject({ offset: 0, limit: 100, timeout: 0 });
  });

  it('preserves a legacy full pending page when its old caught-up proof is more than a week old', async () => {
    const checkpoint = { v: 1, offset: '142', caughtUpAtMs: Date.now() - 7 * 86_400_000 };
    const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => {
      if (input.url.endsWith('/getMe')) return response(botIdentity());
      const offset = JSON.parse(new TextDecoder().decode(input.body)).offset;
      return response({ ok: true, result: offset === 0
        ? Array.from({ length: 100 }, (_, index) => ({ update_id: 42 + index }))
        : [{ update_id: 142, message: { message_id: 2, date: 1_700_000_000,
          chat: { id: 456, type: 'private' }, from: { id: 789, is_bot: false }, text: 'new current input' } }],
      });
    }) };
    const result = await pollTelegramObservations({ ...connection, checkpoint, limit: 1, waitMs: 0 }, coreContext(http));
    expect(result).toMatchObject({ kind: 'batch', checkpointAfterBatch: { offset: '143' } });
    expect(result).not.toHaveProperty('notice');
    const updates = http.request.mock.calls.filter(([input]) => input.url.endsWith('/getUpdates'));
    expect(updates.map(([input]) => JSON.parse(new TextDecoder().decode(input.body)).offset)).toEqual([0, 142]);
  });

  it('keeps a week-old logical offset and idle anchor while empty polling stays nondestructive', async () => {
    const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => response(
      input.url.endsWith('/getMe') ? botIdentity() : { ok: true, result: [] },
    )) };
    const first = await pollTelegramObservations({ ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() - 7 * 86_400_000 }, limit: 10, waitMs: 0,
    }, coreContext(http));
    expect(first).toMatchObject({ kind: 'checkpointOnly', checkpointAfterBatch: { offset: '42' } });
    expect(first).not.toHaveProperty('notice');
    if (first.kind !== 'checkpointOnly') throw new Error('Expected successful checkpoint refresh');
    await pollTelegramObservations({ ...connection, checkpoint: first.checkpointAfterBatch, limit: 10, waitMs: 0 }, coreContext(http));
    const updates = http.request.mock.calls.filter(([input]) => input.url.endsWith('/getUpdates'));
    expect(updates.map(([input]) => JSON.parse(new TextDecoder().decode(input.body)).offset)).toEqual([0, 0]);
  });

  it('continues an aged logical offset while filtering old queue items and respecting the core batch size', async () => {
    const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => response(
      input.url.endsWith('/getMe') ? botIdentity() : { ok: true, result: [41, 42, 43].map(update_id => ({ update_id,
        message: { message_id: update_id, date: 1_700_000_000, chat: { id: 456, type: 'private' },
          from: { id: 789, is_bot: false }, text: `message ${update_id}` },
      })) },
    )) };
    const result = await pollTelegramObservations({ ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() - 86_400_000 }, limit: 1, waitMs: 0,
    }, coreContext(http));
    expect(result).toMatchObject({ kind: 'batch', checkpointAfterBatch: { offset: '43' } });
    expect(result).not.toHaveProperty('notice');
    if (result.kind !== 'batch') throw new Error('Expected current native update');
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      observation: { kind: 'fullText', observation: { occurrenceId: 'telegram:update:42' } },
    });
    const updates = http.request.mock.calls.filter(([input]) => input.url.endsWith('/getUpdates'));
    expect(updates).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(updates[0]?.[0].body))).toMatchObject({ offset: 0, limit: 100 });
  });

  it('keeps valid old-cursor catch-up quiet even when allowed update types leave a sequence hole', async () => {
    let nextId = 42;
    const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => response(
      input.url.endsWith('/getMe') ? botIdentity() : { ok: true, result: [{ update_id: nextId, message: {
        message_id: nextId, date: 1_700_000_000, chat: { id: 456, type: 'private' },
        from: { id: 789, is_bot: false }, text: 'retained update',
      } }] },
    )) };
    const checkpoint = { v: 1, offset: '42', caughtUpAtMs: Date.now() - 86_400_000 };
    const healthy = await pollTelegramObservations({ ...connection, checkpoint, limit: 10, waitMs: 0 }, coreContext(http));
    expect(healthy).toMatchObject({ kind: 'batch', checkpointAfterBatch: { offset: '43' } });
    expect(healthy).not.toHaveProperty('notice');
    nextId = 44;
    const filtered = await pollTelegramObservations({ ...connection, checkpoint, limit: 10, waitMs: 0 }, coreContext(http));
    expect(filtered).toMatchObject({ kind: 'batch', checkpointAfterBatch: { offset: '45' } });
    expect(filtered).not.toHaveProperty('notice');
    if (filtered.kind !== 'batch') throw new Error('Expected retained input after a filtered update');
    const continued = await pollTelegramObservations({ ...connection, checkpoint: filtered.checkpointAfterBatch, limit: 10, waitMs: 0 }, coreContext(http));
    expect(continued).not.toHaveProperty('notice');
  });

  it('detects a lower native sequence after a week of successful empty polls without acknowledging the new update', async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse('2026-08-10T12:00:00.000Z');
    vi.setSystemTime(startedAt);
    try {
      let queued: { update_id: number }[] = [];
      const http = { request: vi.fn(async (input: TelegramHttpRequestInput) => {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        const { offset, limit } = JSON.parse(new TextDecoder().decode(input.body));
        // Model Telegram's destructive acknowledgement at the real network
        // boundary: a stale positive offset would erase the randomized ID.
        if (offset > 0) queued = queued.filter(update => update.update_id >= offset);
        return response({ ok: true, result: queued.slice(0, limit) });
      }) };
      let checkpoint: unknown = { v: 1, offset: '42', caughtUpAtMs: startedAt };
      for (let day = 1; day <= 7; day += 1) {
        vi.setSystemTime(startedAt + day * 86_400_000);
        const result = await pollTelegramObservations({ ...connection, checkpoint, limit: 10, waitMs: 0 }, coreContext(http));
        expect(result.kind).toBe('checkpointOnly');
        if (result.kind !== 'checkpointOnly') throw new Error('Expected idle polling');
        checkpoint = result.checkpointAfterBatch;
      }
      queued = [{ update_id: 12 }];
      await expect(pollTelegramObservations({ ...connection, checkpoint, limit: 10, waitMs: 0 }, coreContext(http)))
        .resolves.toMatchObject({ kind: 'historyGap', reason: 'providerHistoryUnavailable' });
      expect(queued).toEqual([{ update_id: 12 }]);
      const updates = http.request.mock.calls.filter(([input]) => input.url.endsWith('/getUpdates'));
      expect(updates).toHaveLength(8);
      expect(updates.map(([input]) => JSON.parse(new TextDecoder().decode(input.body)).offset)).toEqual(Array(8).fill(0));
    } finally { vi.useRealTimers(); }
  });

  it('projects idle-ready, reconnecting, and history-gap poll facts only to matching current Automation sources', async () => {
    const reports: unknown[] = [];
    const executeAction = vi.fn(async (actionId: string, input: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        return {
          kind: 'page',
          revision: '17',
          definitions: [
            {
              automationId: '11111111-1111-4111-8111-111111111111',
              triggerId: 'telegram-current',
              triggerRevision: 3,
              eventRef: { pluginId: 'happier.channel.telegram', localId: 'automation/chat-message-v1' },
              sourceInstanceId: 'telegram:chat:123:456',
              sourceSelectorId: '22222222-2222-4222-8222-222222222222',
              sourceContractVersion: 1,
              sourceConfig: { v: 1, botId: '123', chatId: '456' },
              observationTransport: {
                kind: 'checkpointedPull',
                watcherMaterializationRef: {
                  pluginId: 'happier.channel.telegram',
                  machineId: 'machine-1',
                  materializationId: 'materialization-1',
                },
              },
              filter: null,
              maximumObservationAgeMs: null,
            },
            {
              automationId: '33333333-3333-4333-8333-333333333333',
              triggerId: 'telegram-other-connection',
              triggerRevision: 2,
              eventRef: { pluginId: 'happier.channel.telegram', localId: 'automation/chat-message-v1' },
              sourceInstanceId: 'telegram:chat:999:456',
              sourceSelectorId: '44444444-4444-4444-8444-444444444444',
              sourceContractVersion: 1,
              sourceConfig: { v: 1, botId: '999', chatId: '456' },
              observationTransport: {
                kind: 'checkpointedPull',
                watcherMaterializationRef: {
                  pluginId: 'happier.channel.telegram',
                  machineId: 'machine-1',
                  materializationId: 'materialization-1',
                },
              },
              filter: null,
              maximumObservationAgeMs: null,
            },
          ],
          nextCursor: null,
        };
      }
      if (actionId === 'automation.event.source.status.report') {
        reports.push(input);
        return {};
      }
      throw new Error(`unexpected host action ${actionId}`);
    });
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe') ? botIdentity() : { ok: true, result: [] },
      )),
    };

    await expect(pollTelegramObservations({
      ...connection,
      checkpoint: null,
      limit: 10,
      waitMs: 0,
    }, coreContext(http, {
      executeAction: executeAction as unknown as PluginInvocationContext['services']['actions']['execute'],
    }))).resolves.toMatchObject({ kind: 'checkpointOnly' });
    await expect(pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '-1', caughtUpAtMs: 0 },
      limit: 10,
      waitMs: 0,
    }, coreContext({ request: vi.fn() }, {
      executeAction: executeAction as unknown as PluginInvocationContext['services']['actions']['execute'],
    }))).resolves.toMatchObject({ kind: 'historyGap' });
    await expect(pollTelegramObservations({
      ...connection,
      providerConfig: { botUsername: '', canReadAllGroupMessages: false },
      checkpoint: null,
      limit: 10,
      waitMs: 0,
    }, coreContext({ request: vi.fn() }, {
      executeAction: executeAction as unknown as PluginInvocationContext['services']['actions']['execute'],
    }))).resolves.toMatchObject({ kind: 'notReady' });

    expect(reports).toEqual([
      expect.objectContaining({ kind: 'catalogReconciliation', scope: { kind: 'checkpointedPull' }, observedRevision: '17' }),
      expect.objectContaining({ kind: 'source', triggerId: 'telegram-current', state: 'observing', code: 'none' }),
      expect.objectContaining({ kind: 'catalogReconciliation', scope: { kind: 'checkpointedPull' }, observedRevision: '17' }),
      expect.objectContaining({ kind: 'source', triggerId: 'telegram-current', state: 'attention', code: 'historyGap' }),
      expect.objectContaining({ kind: 'catalogReconciliation', scope: { kind: 'checkpointedPull' }, observedRevision: '17' }),
      expect.objectContaining({ kind: 'source', triggerId: 'telegram-current', state: 'backingOff', code: 'admissionUnavailable' }),
    ]);
  });

  it('emits one Event candidate with the observed ingress without reaching Automation directly', async () => {
    const executeAction = vi.fn(async (actionId: string) => {
      throw new PluginError({
        code: 'automation_event_adopted_definitions_unavailable',
        message: actionId,
      });
    });
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe') ? botIdentity() : {
          ok: true,
          result: [{
            update_id: 42,
            message: {
              message_id: 1,
              date: 1_700_000_000,
              chat: { id: 456, type: 'private' },
              from: { id: 789, is_bot: false },
              text: 'hello',
            },
          }],
        },
      )),
    };

    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '41', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, coreContext(http, { executeAction }));

    expect(result).toMatchObject({
      kind: 'batch',
      observations: [{
        observation: {
          kind: 'fullText',
          observation: { occurrenceId: 'telegram:update:42' },
        },
        eventCandidate: {
          eventRef: {
            pluginId: 'happier.channel.telegram',
            localId: 'automation/chat-message-v1',
          },
          sourceInstanceId: 'telegram:chat:123:456',
          sourceContractVersion: 1,
          payload: {
            chatId: '456',
            chatType: 'private',
            messageId: '1',
            text: 'hello',
            senderId: '789',
            senderIsBot: false,
          },
        },
      }],
      checkpointAfterBatch: { v: 1, offset: '43' },
    });
    // The poller may reconcile its current source catalog for connection
    // health, but it still never admits this ingress directly to Automation.
    expect(executeAction).toHaveBeenCalledWith(
      'automation.event.sources.list',
      { transport: { kind: 'checkpointedPull' } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('bounds a core maximum wait to Telegram’s server long-poll limit without a local HTTP deadline', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => response(
        input.url.endsWith('/getMe') ? botIdentity() : { ok: true, result: [] },
      )),
    };

    await expect(pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 1,
      waitMs: 60_000,
    }, coreContext(http))).resolves.toMatchObject({
      kind: 'checkpointOnly',
      checkpointAfterBatch: { v: 1, offset: '42' },
    });
    const getUpdates = http.request.mock.calls.find(([input]) => input.url.endsWith('/getUpdates'))?.[0];
    expect(JSON.parse(new TextDecoder().decode(getUpdates?.body))).toMatchObject({ timeout: 50 });
    expect(getUpdates?.timeoutMs).toBeUndefined();
  });

  it('does not rewrite an aborted outbound Telegram call as a safe retry', async () => {
    const controller = new AbortController();
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        if (input.url.endsWith('/getChat')) {
          return response({ ok: true, result: { id: 456, type: 'private', first_name: 'Ada' } });
        }
        const cancelled = new Error('delivery retired');
        controller.abort(cancelled);
        throw cancelled;
      }),
    };
    const context = coreContext(http);
    Object.defineProperty(context, 'signal', { value: controller.signal });

    await expect(deliverTelegramMessage({
      ...connection,
      endpoint: { kind: 'direct', audience: 'direct', id: '456' },
      content: { text: 'reply' },
      deliveryKey: 'delivery-1',

      linkPreviewPolicy: 'suppress',
    }, context)).resolves.toEqual({ kind: 'outcomeUnknown' });
  });
});

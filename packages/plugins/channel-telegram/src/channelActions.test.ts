import { MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES } from '@happier-dev/channels-protocol/v1';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

/** The exact published request input, so recorded calls keep their real shape. */
type TelegramHttpRequestInput =
  Parameters<PluginInvocationContext['services']['http']['request']>[0];

import {
  deliverTelegramMessage,
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
    },
  };
}

describe('Telegram Channel provider actions', () => {
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
      request: vi.fn(async () => response(botIdentity())),
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
      request: vi.fn(async () => response({
        ok: true,
        result: { ...botIdentity().result, can_read_all_group_messages: true },
      })),
    };

    await expect(testTelegramConnection(
      { ...connection, selectedTransport: 'checkpointedPull' },
      coreContext(http),
    )).resolves.toMatchObject({
      kind: 'ready',
      sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages', 'allAllowedMessages'],
    });
  });

  it('resolves an observed Telegram topic identity through its authenticated parent chat', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        if (input.url.endsWith('/getChat')) {
          expect(JSON.parse(new TextDecoder().decode(input.body))).toEqual({ chat_id: '-100456' });
          return response({ ok: true, result: { id: -100456, type: 'supergroup', title: 'Deploys' } });
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
                    text: 'x'.repeat(MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES + 1),
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
            kind: 'routableNonAdmission',
            reason: 'messageTooLarge',
            shell: { occurrenceId: 'telegram:update:47', message: { id: '5' } },
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
                  date: 1_700_000_001,
                  chat: { id: -100456, type: 'supergroup' },
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

  it('delivers a private-chat thread endpoint with its Telegram message thread ID', async () => {
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
      content: 'topic reply',
      deliveryKey: 'delivery-1',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    }, coreContext(http))).resolves.toEqual({ kind: 'delivered', providerMessageIds: ['88'] });

    const sendMessage = http.request.mock.calls.find(([input]) => input.url.endsWith('/sendMessage'))?.[0];
    expect(JSON.parse(new TextDecoder().decode(sendMessage?.body))).toMatchObject({
      chat_id: '456',
      message_thread_id: 17,
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
        content: 'wrong audience',
        deliveryKey: `delivery-${endpoint.id}`,
        mentionPolicy: 'suppress',
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
      content: 'must not be redirected',
      deliveryKey: 'delivery-malformed-thread',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    }, coreContext(http))).resolves.toEqual({ kind: 'notDelivered', retry: 'never' });

    expect(http.request.mock.calls.some(([input]) => input.url.endsWith('/sendMessage'))).toBe(false);
  });

  it('preserves pre-send Telegram API retry classification without dispatching a message', async () => {
    for (const scenario of [
      {
        name: 'getMe rate limit',
        request: async (input: TelegramHttpRequestInput) => {
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
        endpoint: { kind: 'direct', audience: 'direct', id: '456' },
        content: 'reply',
        deliveryKey: `delivery-${scenario.name}`,
        mentionPolicy: 'suppress',
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
        content: 'reply',
        deliveryKey: `delivery-materialize-${scenario.name}`,
        mentionPolicy: 'suppress',
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
        content: 'reply',
        deliveryKey: `delivery-materialize-${scenario.name}`,
        mentionPolicy: 'suppress',
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
    const committedCheckpoint = { v: 1, offset: '42', caughtUpAtMs: Date.now() } as const;

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
      checkpointAfterBatch: { v: 1, offset: '43', caughtUpAtMs: committedCheckpoint.caughtUpAtMs },
    });
    expect(replay).toMatchObject({
      checkpointAfterBatch: { v: 1, offset: '43', caughtUpAtMs: committedCheckpoint.caughtUpAtMs },
    });
    const offsets = http.request.mock.calls
      .filter(([input]) => input.url.endsWith('/getUpdates'))
      .map(([input]) => JSON.parse(new TextDecoder().decode(input.body)).offset);
    expect(offsets).toEqual([42, 42]);
  });

  it('does not renew a caught-up proof while a limit-one page leaves Telegram backlog', async () => {
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
        checkpointAfterBatch: { v: 1, offset: '43', caughtUpAtMs },
      });

      vi.advanceTimersByTime(1_000);
      const retryHttp = { request: vi.fn() };
      const retryContext = coreContext(retryHttp);
      await expect(pollTelegramObservations({
        ...connection,
        checkpoint: { v: 1, offset: '43', caughtUpAtMs },
        limit: 1,
        waitMs: 0,
      }, retryContext)).resolves.toMatchObject({
        kind: 'historyGap',
        reason: 'providerHistoryUnavailable',
        diagnostic: expect.any(String),
      });
      expect(retryContext.services.connectedAccounts.materialize).not.toHaveBeenCalled();
      expect(retryHttp.request).not.toHaveBeenCalled();
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

  it('reports an expired, superseded, or unsupported legacy checkpoint as history-gap attention before materialization or Telegram effects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    try {
      for (const checkpoint of [
        { v: 1, offset: '42', caughtUpAtMs: Date.now() - 86_400_000 },
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
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: 0 },
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

  it('bounds a core maximum wait to Telegram’s long-poll limit while preserving a longer HTTP deadline', async () => {
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
    expect(getUpdates?.timeoutMs).toBe(60_000);
  });

  it('retains accepted chunk evidence when a later Telegram delivery cannot be safely retried', async () => {
    const http = {
      request: vi.fn(async (input: TelegramHttpRequestInput) => {
        if (input.url.endsWith('/getMe')) return response(botIdentity());
        if (input.url.endsWith('/getChat')) {
          return response({ ok: true, result: { id: 456, type: 'private', first_name: 'Ada' } });
        }
        if (http.request.mock.calls.filter(([request]) => request.url.endsWith('/sendMessage')).length === 1) {
          return response({ ok: true, result: { message_id: 70 } });
        }
        return response({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests',
          parameters: { retry_after: 3 },
        });
      }),
    };

    await expect(deliverTelegramMessage({
      ...connection,
      endpoint: { kind: 'direct', audience: 'direct', id: '456' },
      content: `${'a'.repeat(4_096)}b`,
      deliveryKey: 'delivery-1',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    }, coreContext(http))).resolves.toEqual({
      kind: 'partial',
      providerMessageIds: ['70'],
      failedChunk: 1,
      retrySafe: false,
    });
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
      content: 'reply',
      deliveryKey: 'delivery-1',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    }, context)).resolves.toEqual({ kind: 'outcomeUnknown' });
  });
});

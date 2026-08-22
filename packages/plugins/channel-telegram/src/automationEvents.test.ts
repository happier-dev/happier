import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { pollTelegramObservations, setupTelegramChatEventSource } from './channelActions.js';
import { TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID } from './constants.js';

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

function response(value: unknown) {
  return {
    status: 200,
    finalUrl: 'https://api.telegram.org/',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

const botIdentity = {
  ok: true,
  result: { id: 123, is_bot: true, first_name: 'Happier Bot', username: 'HappierBot' },
};

function armedDefinition(chatId: string) {
  return {
    automationId: '11111111-1111-4111-8111-111111111111',
    templateVersion: 1,
    eventRef: { pluginId: 'happier.channel.telegram', localId: TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID },
    sourceInstanceId: `telegram:chat:123:${chatId}`,
    sourceSelectorId: '22222222-2222-4222-8222-222222222222',
    sourceContractVersion: 1,
    sourceConfig: { v: 1, botId: '123', chatId },
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
  };
}

function context(
  http: Pick<PluginInvocationContext['services']['http'], 'request'>,
  execute: unknown,
): PluginInvocationContext {
  return {
    plugin: { id: 'happier.channel.telegram', version: '0.0.0' },
    contribution: { id: 'test', qualifiedId: 'happier.channel.telegram/actions/test' },
    surface: 'plugin',
    caller: {
      kind: 'plugin',
      pluginId: 'happier.channels',
      contribution: { id: 'test', qualifiedId: 'happier.channels/actions/test' },
    },
    signal: new AbortController().signal,
    services: {
      connectedAccounts: {
        materialize: vi.fn(async () => ({
          kind: 'environment' as const,
          env: { TELEGRAM_BOT_TOKEN: '123:bot-token' },
        })),
      },
      http,
      actions: { execute },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginInvocationContext['services'],
  };
}

function pollHttp(updates: readonly unknown[]) {
  return {
    request: vi.fn(async (input: Readonly<{ url: string }>) => response(
      input.url.includes('/getMe') ? botIdentity : { ok: true, result: updates },
    )),
  };
}

const chatMessage = {
  update_id: 51,
  message: {
    message_id: 9,
    date: 1_700_000_008,
    chat: { id: -100456, type: 'supergroup' },
    from: { id: 789, is_bot: false },
    text: 'deploy the site',
  },
};

describe('Telegram Automation Event source', () => {
  it('admits an Automation Event occurrence for a real observed message through the existing Channels poll', async () => {
    const admitted: unknown[] = [];
    const execute = vi.fn(async (actionId: string, input: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', definitions: [armedDefinition('-100456')], nextCursor: null, revision: '7' };
      }
      if (actionId === 'automation.event.admit') {
        admitted.push(input);
        return { results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }] };
      }
      throw new Error(`unexpected ${actionId}`);
    });

    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, context(pollHttp([chatMessage]), execute));

    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({
      eventRef: { pluginId: 'happier.channel.telegram', localId: TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID },
      occurrenceId: 'telegram:update:51',
      payload: { chatId: '-100456', chatType: 'supergroup', text: 'deploy the site', senderId: '789' },
      definitions: [{ automationId: '11111111-1111-4111-8111-111111111111', templateVersion: 1 }],
    });
    // The Channel observation for the same update is still delivered: the one
    // poll continues to serve both consumers.
    expect(result).toMatchObject({ kind: 'batch' });
    expect(result.checkpointAfterBatch.offset).toBe('52');
  });

  it('does not admit an occurrence for a chat no Automation watches', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', definitions: [armedDefinition('-999')], nextCursor: null, revision: '7' };
      }
      throw new Error(`unexpected ${actionId}`);
    });
    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, context(pollHttp([chatMessage]), execute));
    expect(execute.mock.calls.every(([id]) => id === 'automation.event.sources.list')).toBe(true);
    expect(result).toMatchObject({ kind: 'batch' });
  });

  it('withholds the shared checkpoint past an occurrence that was not admitted checkpoint-safely', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', definitions: [armedDefinition('-100456')], nextCursor: null, revision: '7' };
      }
      return { results: [{ kind: 'blocked', reason: 'capacity', checkpointSafe: false }] };
    });
    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, context(pollHttp([chatMessage]), execute));
    // Telegram's `offset` confirms updates for every reader, so the batch must
    // stop before the unadmitted update instead of discarding it.
    expect(result.checkpointAfterBatch.offset).toBe('51');
    expect(result).toMatchObject({ kind: 'checkpointOnly' });
  });

  it('does not admit an edit, because the Channels ingress already refuses edits as content', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', definitions: [armedDefinition('-100456')], nextCursor: null, revision: '7' };
      }
      throw new Error('an edit must not be admitted as a new occurrence');
    });
    await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, context(pollHttp([{
      update_id: 51,
      edited_message: { ...chatMessage.message, edit_date: 1_700_000_009 },
    }]), execute));
    expect(execute.mock.calls.map(([id]) => id)).not.toContain('automation.event.admit');
  });

  it('does not admit this bot\'s own message, so a replying Automation cannot retrigger itself', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', definitions: [armedDefinition('-100456')], nextCursor: null, revision: '7' };
      }
      throw new Error('the integration self must not be admitted');
    });
    await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, context(pollHttp([{
      update_id: 51,
      message: { ...chatMessage.message, from: { id: 123, is_bot: true } },
    }]), execute));
    expect(execute.mock.calls.map(([id]) => id)).not.toContain('automation.event.admit');
  });

  it('never admits from the baseline poll that discards Telegram history', async () => {
    const execute = vi.fn(async () => {
      throw new Error('baseline must not reach the Automation host actions');
    });
    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: null,
      limit: 10,
      waitMs: 0,
    }, context(pollHttp([chatMessage]), execute));
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'checkpointOnly' });
  });

  it('resolves a chat into immutable source facts for the Automation composer', async () => {
    const http = {
      request: vi.fn(async (input: Readonly<{ url: string }>) => response(
        input.url.includes('/getMe')
          ? botIdentity
          : { ok: true, result: { id: -100456, type: 'supergroup', title: 'Deploys' } },
      )),
    };
    const result = await setupTelegramChatEventSource(
      { credentialRef: telegramAccount, chatId: '-100456' },
      context(http, vi.fn()),
    );
    expect(result).toMatchObject({
      v: 1,
      sourceInstanceId: 'telegram:chat:123:-100456',
      sourceContractVersion: 1,
      sourceConfig: { v: 1, botId: '123', chatId: '-100456' },
      displayLabel: 'Deploys',
    });
  });

  it('never fails the shipped Channels poll when the Automation catalog cannot be read', async () => {
    // The one poll serves both consumers, and a failing provider poll Action is
    // recorded by the Channels ingress as a non-retryable blocked connection on
    // the first attempt. An Automation-side failure must never reach it.
    const execute = vi.fn(async () => {
      throw new PluginError({
        code: 'automation_event_adopted_definitions_unavailable',
        message: 'automation_event_adopted_definitions_unavailable',
      });
    });
    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, context(pollHttp([chatMessage]), execute));
    // The Automation catalog is a separate authority whose unavailability is
    // unbounded. Holding the shared single-consumer offset for it would stop
    // Channel delivery for this bot entirely, so the batch is consumed and the
    // occurrence is the bounded loss.
    expect(result).toMatchObject({ kind: 'batch' });
    expect(result.checkpointAfterBatch.offset).toBe('52');
  });

  it('still delivers Channel observations when a catalog page read tears mid-scan', async () => {
    const execute = vi.fn(async () => ({ kind: 'cursorStale' }));
    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, context(pollHttp([chatMessage]), execute));
    expect(result).toMatchObject({ kind: 'batch' });
    expect(result.checkpointAfterBatch.offset).toBe('52');
  });

  it('still delivers Channel observations when the admission call itself fails', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', definitions: [armedDefinition('-100456')], nextCursor: null, revision: '7' };
      }
      throw new PluginError({
        code: 'automation_event_host_evidence_unavailable',
        message: 'automation_event_host_evidence_unavailable',
      });
    });
    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, context(pollHttp([chatMessage]), execute));
    expect(result).toMatchObject({ kind: 'batch' });
    expect(result.checkpointAfterBatch.offset).toBe('52');
  });

  it('exhausts the whole source catalog cursor chain instead of truncating it at a page ceiling', async () => {
    // The armed source sits past the former eight-page ceiling. Truncating the
    // scan reported "no armed source", which let the shared single-consumer
    // offset advance and silently discarded this Automation's occurrence.
    const lastPage = 12;
    const admitted: unknown[] = [];
    let page = 0;
    const execute = vi.fn(async (actionId: string, input: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        page += 1;
        expect(input).toMatchObject(
          page === 1 ? { transport: { kind: 'checkpointedPull' } } : { cursor: `page-${page - 1}` },
        );
        return page < lastPage
          ? { kind: 'page', definitions: [], nextCursor: `page-${page}`, revision: '7' }
          : { kind: 'page', definitions: [armedDefinition('-100456')], nextCursor: null, revision: '7' };
      }
      if (actionId === 'automation.event.admit') {
        admitted.push(input);
        return { results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }] };
      }
      throw new Error(`unexpected ${actionId}`);
    });

    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, context(pollHttp([chatMessage]), execute));

    expect(page).toBe(lastPage);
    expect(admitted).toHaveLength(1);
    expect(result).toMatchObject({ kind: 'batch' });
    expect(result.checkpointAfterBatch.offset).toBe('52');
  });

  it('delivers Channel observations normally on a host with no Automation Event producer', async () => {
    // `unsupported_action` proves this host has no Automation Event producer at
    // all, so no Telegram source can be armed and nothing can be lost by
    // consuming the batch.
    const execute = vi.fn(async () => {
      throw new PluginError({ code: 'unsupported_action', message: 'unsupported_action' });
    });
    const result = await pollTelegramObservations({
      ...connection,
      checkpoint: { v: 1, offset: '42', caughtUpAtMs: Date.now() },
      limit: 10,
      waitMs: 0,
    }, context(pollHttp([chatMessage]), execute));
    expect(result).toMatchObject({ kind: 'batch' });
    expect(result.checkpointAfterBatch.offset).toBe('52');
  });

});

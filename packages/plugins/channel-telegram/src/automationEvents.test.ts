import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { admitTelegramAutomationOccurrences } from './automationEvents.js';
import { setupTelegramChatEventSource } from './channelActions.js';
import { TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID } from './constants.js';
import type { TelegramBotIdentity, TelegramIncomingMessage, TelegramUpdate } from './telegramBotApi.js';

const telegramAccount = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.channel.telegram', localId: 'telegram-bot' }),
  accountId: 'bot:123',
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

const identity: TelegramBotIdentity = Object.freeze({
  id: '123',
  username: 'HappierBot',
  displayName: 'Happier Bot',
  canReadAllGroupMessages: false,
});

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

function message(overrides: Partial<TelegramIncomingMessage> = {}): TelegramIncomingMessage {
  return {
    messageId: '9',
    chatId: '-100456',
    chatType: 'supergroup',
    messageThreadId: null,
    senderId: '789',
    senderIsBot: false,
    senderIsChat: false,
    text: 'deploy the site',
    textEntities: [],
    replyToMessageId: null,
    replyToSenderId: null,
    forwarded: false,
    viaBotId: null,
    sentAtMs: 1_700_000_008_000,
    editedAtMs: null,
    ...overrides,
  };
}

function update(overrides: Partial<TelegramUpdate> = {}): TelegramUpdate {
  return { updateId: '51', kind: 'message', message: message(), ...overrides };
}

const noHttp = { request: vi.fn(async () => response({ ok: true, result: [] })) };

/**
 * The Telegram Automation Event is WITHHELD from `plugin.ts`, so this retained
 * admission has no live call site (see the resume note in
 * `automationEvents.ts`). These tests therefore drive the retained entry point
 * itself, which is exactly what a re-declared Event restores.
 */
describe('Telegram Automation Event source', () => {
  it('admits an occurrence for a real observed message in an armed chat', async () => {
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

    const outcome = await admitTelegramAutomationOccurrences({
      context: context(noHttp, execute),
      identity,
      updates: [update()],
      observationReceivedAt: 1_700_000_009_000,
    });

    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({
      eventRef: { pluginId: 'happier.channel.telegram', localId: TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID },
      occurrenceId: 'telegram:update:51',
      payload: { chatId: '-100456', chatType: 'supergroup', text: 'deploy the site', senderId: '789' },
      definitions: [{ automationId: '11111111-1111-4111-8111-111111111111', templateVersion: 1 }],
    });
    expect(outcome).toEqual({ stopBeforeUpdateId: null, admittedCount: 1 });
  });

  it('does not admit an occurrence for a chat no Automation watches', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', definitions: [armedDefinition('-999')], nextCursor: null, revision: '7' };
      }
      throw new Error(`unexpected ${actionId}`);
    });
    const outcome = await admitTelegramAutomationOccurrences({
      context: context(noHttp, execute),
      identity,
      updates: [update()],
      observationReceivedAt: 1_700_000_009_000,
    });
    expect(execute.mock.calls.map(([id]) => id)).toEqual(['automation.event.sources.list']);
    expect(outcome).toEqual({ stopBeforeUpdateId: null, admittedCount: 0 });
  });

  it('withholds the shared checkpoint past an occurrence that was not admitted checkpoint-safely', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', definitions: [armedDefinition('-100456')], nextCursor: null, revision: '7' };
      }
      return { results: [{ kind: 'blocked', reason: 'capacity', checkpointSafe: false }] };
    });
    // Telegram's `offset` confirms updates for every reader, so the caller must
    // be told to stop before the unadmitted update instead of discarding it.
    await expect(admitTelegramAutomationOccurrences({
      context: context(noHttp, execute),
      identity,
      updates: [update()],
      observationReceivedAt: 1_700_000_009_000,
    })).resolves.toEqual({ stopBeforeUpdateId: '51', admittedCount: 0 });
  });

  it('does not admit an edit, because the Channels ingress already refuses edits as content', async () => {
    const execute = vi.fn(async () => {
      throw new Error('an edit must not reach the Automation catalog');
    });
    await expect(admitTelegramAutomationOccurrences({
      context: context(noHttp, execute),
      identity,
      updates: [update({ kind: 'editedMessage', message: message({ editedAtMs: 1_700_000_009_000 }) })],
      observationReceivedAt: 1_700_000_009_000,
    })).resolves.toEqual({ stopBeforeUpdateId: null, admittedCount: 0 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not admit this bot\'s own message, so a replying Automation cannot retrigger itself', async () => {
    const execute = vi.fn(async () => {
      throw new Error('the integration self must not reach the Automation catalog');
    });
    await expect(admitTelegramAutomationOccurrences({
      context: context(noHttp, execute),
      identity,
      updates: [update({ message: message({ senderId: '123', senderIsBot: true }) })],
      observationReceivedAt: 1_700_000_009_000,
    })).resolves.toEqual({ stopBeforeUpdateId: null, admittedCount: 0 });
    expect(execute).not.toHaveBeenCalled();
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

  it('never withholds the shared checkpoint when the Automation catalog cannot be read', async () => {
    // The Automation catalog is a separate authority whose unavailability is
    // unbounded. Holding the shared single-consumer offset for it would stop
    // Channel delivery for this bot entirely, so the occurrence is the bounded
    // loss and the caller is free to consume the batch.
    const execute = vi.fn(async () => {
      throw new PluginError({
        code: 'automation_event_adopted_definitions_unavailable',
        message: 'automation_event_adopted_definitions_unavailable',
      });
    });
    await expect(admitTelegramAutomationOccurrences({
      context: context(noHttp, execute),
      identity,
      updates: [update()],
      observationReceivedAt: 1_700_000_009_000,
    })).resolves.toEqual({ stopBeforeUpdateId: null, admittedCount: 0 });
  });

  it('never withholds the shared checkpoint when a catalog page read tears mid-scan', async () => {
    const execute = vi.fn(async () => ({ kind: 'cursorStale' }));
    await expect(admitTelegramAutomationOccurrences({
      context: context(noHttp, execute),
      identity,
      updates: [update()],
      observationReceivedAt: 1_700_000_009_000,
    })).resolves.toEqual({ stopBeforeUpdateId: null, admittedCount: 0 });
  });

  it('never withholds the shared checkpoint when the admission call itself fails', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', definitions: [armedDefinition('-100456')], nextCursor: null, revision: '7' };
      }
      throw new PluginError({
        code: 'automation_event_host_evidence_unavailable',
        message: 'automation_event_host_evidence_unavailable',
      });
    });
    await expect(admitTelegramAutomationOccurrences({
      context: context(noHttp, execute),
      identity,
      updates: [update()],
      observationReceivedAt: 1_700_000_009_000,
    })).resolves.toEqual({ stopBeforeUpdateId: null, admittedCount: 0 });
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

    const outcome = await admitTelegramAutomationOccurrences({
      context: context(noHttp, execute),
      identity,
      updates: [update()],
      observationReceivedAt: 1_700_000_009_000,
    });

    expect(page).toBe(lastPage);
    expect(admitted).toHaveLength(1);
    expect(outcome).toEqual({ stopBeforeUpdateId: null, admittedCount: 1 });
  });

  it('treats a host with no Automation Event producer as proof nothing could be armed', async () => {
    // `unsupported_action` proves this host has no Automation Event producer at
    // all, so no Telegram source can be armed and nothing can be lost.
    const warn = vi.fn();
    const execute = vi.fn(async () => {
      throw new PluginError({ code: 'unsupported_action', message: 'unsupported_action' });
    });
    const invocation = context(noHttp, execute);
    (invocation.services as unknown as { logger: { warn: typeof warn } }).logger.warn = warn;
    await expect(admitTelegramAutomationOccurrences({
      context: invocation,
      identity,
      updates: [update()],
      observationReceivedAt: 1_700_000_009_000,
    })).resolves.toEqual({ stopBeforeUpdateId: null, admittedCount: 0 });
    // `absent` proves nothing could be armed, so it must not be reported as an
    // unevaluated occurrence loss.
    expect(warn.mock.calls.map(([event]) => event))
      .not.toContain('telegram_automation_event.occurrences_unevaluated');
  });
});

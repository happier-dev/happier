import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { admitTelegramAutomationEvent } from './automationEvents.js';
import { setupTelegramChatEventSource } from './channelActions.js';
import { TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID } from './constants.js';

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
      materialization: {
        machineId: 'telegram-automation-events-fixture-machine',
        materializationId: 'telegram-automation-events-fixture-materialization',
        pluginId: 'happier.channels',
      },
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

const noHttp = { request: vi.fn(async () => response({ ok: true, result: [] })) };

function admissionInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    connectionId: 'telegram-connection-1',
    candidate: {
      eventRef: {
        pluginId: 'happier.channel.telegram',
        localId: TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID,
      },
      sourceInstanceId: 'telegram:chat:123:-100456',
      sourceContractVersion: 1,
      payload: {
        chatId: '-100456',
        chatType: 'supergroup',
        messageId: '9',
        text: 'deploy the site',
        senderId: '789',
        senderIsBot: false,
      },
    },
    occurrenceId: 'telegram:update:51',
    occurredAt: 1_700_000_008_000,
    observationReceivedAt: 1_700_000_009_000,
    ...overrides,
  };
}

describe('Telegram Automation Event source', () => {
  it('admits a frozen Channels Event obligation to the matching current source', async () => {
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

    const outcome = await admitTelegramAutomationEvent(admissionInput(), context(noHttp, execute));

    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({
      eventRef: { pluginId: 'happier.channel.telegram', localId: TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID },
      occurrenceId: 'telegram:update:51',
      payload: { chatId: '-100456', chatType: 'supergroup', text: 'deploy the site', senderId: '789' },
      definitions: [{ automationId: '11111111-1111-4111-8111-111111111111', templateVersion: 1 }],
    });
    expect(outcome).toEqual({ kind: 'checkpointSafe' });
  });

  it('settles safely without an admission when no current source matches the frozen candidate', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', definitions: [armedDefinition('-999')], nextCursor: null, revision: '7' };
      }
      throw new Error(`unexpected ${actionId}`);
    });
    const outcome = await admitTelegramAutomationEvent(admissionInput(), context(noHttp, execute));
    expect(execute.mock.calls.map(([id]) => id)).toEqual(['automation.event.sources.list']);
    expect(outcome).toEqual({ kind: 'checkpointSafe' });
  });

  it('returns unsettled when the Automation admission is not checkpoint-safe', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', definitions: [armedDefinition('-100456')], nextCursor: null, revision: '7' };
      }
      return { results: [{ kind: 'blocked', reason: 'capacity', checkpointSafe: false }] };
    });
    await expect(admitTelegramAutomationEvent(admissionInput(), context(noHttp, execute)))
      .resolves.toEqual({ kind: 'unsettled' });
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

  it('returns unsettled when it cannot read the current source catalog', async () => {
    const execute = vi.fn(async () => {
      throw new PluginError({
        code: 'automation_event_adopted_definitions_unavailable',
        message: 'automation_event_adopted_definitions_unavailable',
      });
    });
    await expect(admitTelegramAutomationEvent(admissionInput(), context(noHttp, execute)))
      .resolves.toEqual({ kind: 'unsettled' });
  });
});

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  DISCORD_AUTOMATION_MESSAGE_EVENT_ID,
  DISCORD_PLUGIN_ID,
} from './discordAutomationEvent.js';
import { admitDiscordAutomationEvent } from './discordAutomationEventAdmission.js';

const SOURCE_SELECTOR_ID = '3f5b6d0e-1c4a-4d2b-9f77-2a0c4e6b8d91';
const EVENT_REF = { pluginId: DISCORD_PLUGIN_ID, localId: DISCORD_AUTOMATION_MESSAGE_EVENT_ID };

function sourceDefinition(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    automationId: 'automation-discord-1',
    templateVersion: 2,
    eventRef: EVENT_REF,
    sourceInstanceId: 'discord:application:123:channel:4242',
    sourceSelectorId: SOURCE_SELECTOR_ID,
    sourceContractVersion: 1,
    sourceConfig: { v: 1, applicationId: '123', channelId: '4242' },
    observationTransport: { kind: 'checkpointedPull' },
    filter: null,
    maximumObservationAgeMs: null,
    ...overrides,
  };
}

function admissionInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    connectionId: 'discord-connection-1',
    candidate: {
      eventRef: EVENT_REF,
      sourceInstanceId: 'discord:application:123:channel:4242',
      sourceContractVersion: 1,
      payload: {
        v: 1,
        channelId: '4242',
        channelKind: 'shared',
        messageId: '9001',
        text: 'ship it',
        textTruncated: false,
        addressingEvidence: 'directIntegrationMention',
        contentProvenance: 'original',
        actorKind: 'human',
        actorPrincipalId: 'discord:user:77',
      },
    },
    occurrenceId: 'discord:message:9001',
    occurredAt: 1_725_000_000_000,
    observationReceivedAt: 1_725_000_000_100,
    ...overrides,
  };
}

function createContext(
  execute: ReturnType<typeof vi.fn>,
  signal: AbortSignal = new AbortController().signal,
): PluginInvocationContext {
  return {
    plugin: { id: DISCORD_PLUGIN_ID, version: '0.0.0' },
    contribution: { id: 'test', qualifiedId: `${DISCORD_PLUGIN_ID}/actions/test` },
    surface: 'plugin',
    caller: {
      kind: 'plugin',
      pluginId: 'happier.channels',
      contribution: { id: 'test', qualifiedId: 'happier.channels/actions/test' },
      materialization: {
        machineId: 'discord-automation-events-fixture-machine',
        materializationId: 'discord-automation-events-fixture-materialization',
        pluginId: 'happier.channels',
      },
    },
    signal,
    services: {
      actions: { execute },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginInvocationContext['services'],
  };
}

describe('Discord Automation Event admission bridge', () => {
  it('admits a frozen Channels Event obligation to the exact current source', async () => {
    const admitted: unknown[] = [];
    const execute = vi.fn(async (actionId: string, input: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        return {
          kind: 'page',
          revision: '7',
          definitions: [
            sourceDefinition(),
            sourceDefinition({
              automationId: 'automation-discord-2',
              sourceSelectorId: '5a1b6d0e-1c4a-4d2b-9f77-2a0c4e6b8d92',
            }),
            sourceDefinition({ sourceContractVersion: 2 }),
            sourceDefinition({ sourceInstanceId: 'discord:application:123:channel:5555' }),
            sourceDefinition({
              eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/repository-event-v1' },
            }),
          ],
          nextCursor: null,
        };
      }
      if (actionId === 'automation.event.admit') {
        admitted.push(input);
        return { results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }] };
      }
      throw new Error(`unexpected ${actionId}`);
    });

    const outcome = await admitDiscordAutomationEvent(admissionInput(), createContext(execute));

    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toEqual({
      eventRef: EVENT_REF,
      occurrenceId: 'discord:message:9001',
      occurredAt: 1_725_000_000_000,
      observationReceivedAt: 1_725_000_000_100,
      payload: admissionInput().candidate.payload,
      definitions: [
        { automationId: 'automation-discord-1', templateVersion: 2, sourceSelectorId: SOURCE_SELECTOR_ID },
        {
          automationId: 'automation-discord-2',
          templateVersion: 2,
          sourceSelectorId: '5a1b6d0e-1c4a-4d2b-9f77-2a0c4e6b8d92',
        },
      ],
    });
    expect(outcome).toEqual({ kind: 'checkpointSafe' });
  });

  it('settles safely without an admission when no current source matches the frozen candidate', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', revision: '7', definitions: [sourceDefinition({ sourceContractVersion: 2 })], nextCursor: null };
      }
      throw new Error(`unexpected ${actionId}`);
    });

    await expect(admitDiscordAutomationEvent(admissionInput(), createContext(execute)))
      .resolves.toEqual({ kind: 'checkpointSafe' });
    expect(execute.mock.calls.map(([actionId]) => actionId)).toEqual(['automation.event.sources.list']);
  });

  it('returns unsettled when the Automation admission is not checkpoint-safe', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', revision: '7', definitions: [sourceDefinition()], nextCursor: null };
      }
      return { results: [{ kind: 'blocked', reason: 'capacity', checkpointSafe: false }] };
    });

    await expect(admitDiscordAutomationEvent(admissionInput(), createContext(execute)))
      .resolves.toEqual({ kind: 'unsettled' });
  });

  it('re-reads the current source catalog for each obligation instead of retaining a provider-local index', async () => {
    let listCount = 0;
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        listCount += 1;
        return {
          kind: 'page',
          revision: String(listCount),
          definitions: listCount === 1 ? [sourceDefinition()] : [],
          nextCursor: null,
        };
      }
      return { results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }] };
    });
    const context = createContext(execute);

    await expect(admitDiscordAutomationEvent(admissionInput(), context)).resolves.toEqual({ kind: 'checkpointSafe' });
    await expect(admitDiscordAutomationEvent(admissionInput({ occurrenceId: 'discord:message:9002' }), context))
      .resolves.toEqual({ kind: 'checkpointSafe' });

    expect(execute.mock.calls.map(([actionId]) => actionId)).toEqual([
      'automation.event.sources.list',
      'automation.event.admit',
      'automation.event.sources.list',
    ]);
  });

  it('returns unsettled when the current source catalog is unavailable', async () => {
    const execute = vi.fn(async () => {
      throw new Error('Automation catalog unavailable');
    });

    await expect(admitDiscordAutomationEvent(admissionInput(), createContext(execute)))
      .resolves.toEqual({ kind: 'unsettled' });
  });

  it('preserves Channels cancellation before it begins a provider admission', async () => {
    const controller = new AbortController();
    const cancellation = new Error('Channels obligation cancelled');
    controller.abort(cancellation);
    const execute = vi.fn(async () => ({ kind: 'page', revision: '7', definitions: [], nextCursor: null }));

    await expect(admitDiscordAutomationEvent(admissionInput(), createContext(execute, controller.signal)))
      .rejects.toBe(cancellation);
    expect(execute).not.toHaveBeenCalled();
  });
});

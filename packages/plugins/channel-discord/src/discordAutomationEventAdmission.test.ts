import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  DISCORD_AUTOMATION_MESSAGE_EVENT_ID,
  DISCORD_PLUGIN_ID,
  type DiscordFullTextObservationV1,
} from './discordAutomationEvent.js';
import { createDiscordAutomationEventSourceIndex } from './discordAutomationEventAdmission.js';

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

function observation(channelId = '4242'): DiscordFullTextObservationV1 {
  return {
    v: 1,
    occurrenceId: `discord:message:9001`,
    occurredAt: 1_725_000_000_000,
    transport: { kind: 'socket' },
    endpoint: { kind: 'shared', audience: 'shared', id: `discord:channel:${channelId}` },
    actor: { principalId: 'discord:user:77', kind: 'human', isIntegrationSelf: false },
    message: {
      id: '9001',
      addressingEvidence: 'directIntegrationMention',
      contentProvenance: 'original',
      providerTimestamp: 1_725_000_000_000,
      text: 'ship it',
    },
  } as DiscordFullTextObservationV1;
}

function createContext(execute: ReturnType<typeof vi.fn>) {
  return {
    signal: new AbortController().signal,
    services: { actions: { execute }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
  } as unknown as Pick<PluginInvocationContext, 'services' | 'signal'>;
}

describe('Discord Automation Event source index', () => {
  it('admits one observed message to every adopted source watching that application channel', async () => {
    const execute = vi.fn(async (actionId: unknown) => {
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
            // Another plugin's source must never be admitted by Discord.
            sourceDefinition({
              eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/repository-event-v1' },
              sourceConfig: { v: 1, repositoryId: '1' },
            }),
            // Another Discord application on the same Account.
            sourceDefinition({
              automationId: 'automation-discord-3',
              sourceConfig: { v: 1, applicationId: '999', channelId: '4242' },
            }),
          ],
          nextCursor: null,
        };
      }
      return { results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }] };
    });
    const context = createContext(execute);
    const index = createDiscordAutomationEventSourceIndex();
    await index.refresh(context);
    await index.admit({ applicationId: '123', observation: observation() }, context);

    const admissions = execute.mock.calls.filter(([actionId]) => actionId === 'automation.event.admit');
    expect(admissions).toHaveLength(1);
    expect(admissions[0]?.[1]).toMatchObject({
      eventRef: EVENT_REF,
      occurrenceId: 'discord:message:9001',
      occurredAt: 1_725_000_000_000,
      payload: { channelId: '4242', messageId: '9001', text: 'ship it', actorKind: 'human' },
      definitions: [
        { automationId: 'automation-discord-1', templateVersion: 2, sourceSelectorId: SOURCE_SELECTOR_ID },
        {
          automationId: 'automation-discord-2',
          templateVersion: 2,
          sourceSelectorId: '5a1b6d0e-1c4a-4d2b-9f77-2a0c4e6b8d92',
        },
      ],
    });
  });

  it('does not reach the host when no adopted source watches the observed channel', async () => {
    const execute = vi.fn(async (actionId: unknown) => (actionId === 'automation.event.sources.list'
      ? { kind: 'page', revision: '7', definitions: [sourceDefinition()], nextCursor: null }
      : { results: [] }));
    const context = createContext(execute);
    const index = createDiscordAutomationEventSourceIndex();
    await index.refresh(context);
    await index.admit({ applicationId: '123', observation: observation('5555') }, context);
    expect(execute.mock.calls.filter(([actionId]) => actionId === 'automation.event.admit')).toEqual([]);
  });

  it('never propagates an Automation admission failure into the Channels ingress path', async () => {
    const execute = vi.fn(async (actionId: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', revision: '7', definitions: [sourceDefinition()], nextCursor: null };
      }
      throw new Error('automation host is unavailable');
    });
    const context = createContext(execute);
    const index = createDiscordAutomationEventSourceIndex();
    await index.refresh(context);
    await expect(index.admit({ applicationId: '123', observation: observation() }, context))
      .resolves.toBeUndefined();
  });

  it('records a checkpoint-unsafe outcome as a dropped occurrence, because this observer holds no cursor', async () => {
    // The real guarantee, established by execution: a `blocked` outcome asks
    // the observer to retry from its stored position, and this provider has
    // none. Nothing is persisted and nothing is queued — the occurrence is
    // dropped unless the same Gateway session happens to redeliver it.
    const execute = vi.fn(async (actionId: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        return { kind: 'page', revision: '7', definitions: [sourceDefinition()], nextCursor: null };
      }
      return { results: [{ kind: 'blocked', reason: 'capacity', checkpointSafe: false }] };
    });
    const context = createContext(execute);
    const index = createDiscordAutomationEventSourceIndex();
    await index.refresh(context);

    await index.admit({ applicationId: '123', observation: observation() }, context);

    expect(context.services.logger.warn).toHaveBeenCalledWith(
      'discord_automation_event.occurrence_dropped',
      {
        occurrenceId: 'discord:message:9001',
        outcomes: [{ kind: 'blocked', reason: 'capacity', checkpointSafe: false }],
      },
    );
    // No re-admission is attempted and no cursor is written: the only Actions
    // this index ever calls are the source list and the admission itself.
    expect(execute.mock.calls.map(([actionId]) => actionId)).toEqual([
      'automation.event.sources.list',
      'automation.event.admit',
    ]);
  });

  it('re-lists after the host reports a stale definition instead of admitting against it again', async () => {
    let listCalls = 0;
    const execute = vi.fn(async (actionId: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        listCalls += 1;
        return { kind: 'page', revision: String(listCalls), definitions: [sourceDefinition()], nextCursor: null };
      }
      return { results: [{ kind: 'refreshDefinition', reason: 'definitionStale', checkpointSafe: false }] };
    });
    const context = createContext(execute);
    const index = createDiscordAutomationEventSourceIndex();
    await index.refresh(context);
    expect(listCalls).toBe(1);
    await index.admit({ applicationId: '123', observation: observation() }, context);
    // A stale definition invalidates the known revision, so the next refresh
    // must re-list rather than short-circuit on `unchanged`.
    await index.refresh(context);
    expect(listCalls).toBe(2);
    expect(execute.mock.calls.filter(([actionId]) => actionId === 'automation.event.sources.list').at(-1)?.[1])
      .not.toHaveProperty('knownRevision');
  });
});

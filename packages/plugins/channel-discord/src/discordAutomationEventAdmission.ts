import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

import {
  DISCORD_AUTOMATION_MESSAGE_EVENT_ID,
  DISCORD_PLUGIN_ID,
  createDiscordAutomationMessagePayload,
  parseDiscordAutomationMessageSourceConfig,
  type DiscordFullTextObservationV1,
} from './discordAutomationEvent.js';

type AutomationEventSourcesListResultV1 = PluginActionResultById['automation.event.sources.list'];
type AutomationEventSourceDefinitionV1 = Extract<
  AutomationEventSourcesListResultV1,
  Readonly<{ kind: 'page' }>
>['definitions'][number];
type AutomationEventAdmitInputV1 = PluginActionInputById['automation.event.admit'];
type AutomationEventAdmitSelectorV1 = AutomationEventAdmitInputV1['definitions'][number];

/**
 * The Automation-facing half of one plugin invocation. Both the background
 * reconciliation loop and the Gateway worker Action satisfy it, so the index
 * needs no second lifecycle owner of its own.
 */
export type DiscordAutomationInvocationContext = Pick<PluginInvocationContext, 'services' | 'signal'>;

export type DiscordAutomationEventSourceIndex = Readonly<{
  /** Re-reads the adopted checkpointed-pull sources this Machine watches. */
  refresh(context: DiscordAutomationInvocationContext): Promise<void>;
  /** Admits one already-normalized Gateway observation to every matching source. */
  admit(
    input: Readonly<{ applicationId: string; observation: DiscordFullTextObservationV1 }>,
    context: DiscordAutomationInvocationContext,
  ): Promise<void>;
}>;

function watchKey(applicationId: string, channelId: string): string {
  return `${applicationId}\n${channelId}`;
}

function isDiscordMessageEventDefinition(definition: AutomationEventSourceDefinitionV1): boolean {
  return definition.eventRef.pluginId === DISCORD_PLUGIN_ID
    && definition.eventRef.localId === DISCORD_AUTOMATION_MESSAGE_EVENT_ID;
}

function toSelector(definition: AutomationEventSourceDefinitionV1): AutomationEventAdmitSelectorV1 {
  return {
    automationId: definition.automationId,
    templateVersion: definition.templateVersion,
    sourceSelectorId: definition.sourceSelectorId,
  };
}

/**
 * Discord observation is a live Gateway session this provider already owns for
 * Channels. The Automation Event reuses that exact ingress: the index only
 * resolves which adopted sources a normalized observation belongs to and hands
 * it to the canonical host admission Action. It stores no message, no cursor,
 * and no provider state, so it can never become a second observation owner.
 *
 * The Event declaration this index serves is currently WITHHELD from the
 * manifest — see the withheld-declaration note in `discordAutomationEvent.ts`
 * — precisely because storing no cursor is not honest for either declared
 * observation transport. Until it is re-declared the host reports no adopted
 * Discord source, so this index resolves nothing and admits nothing.
 */
export function createDiscordAutomationEventSourceIndex(): DiscordAutomationEventSourceIndex {
  let definitionsByWatchKey = new Map<string, readonly AutomationEventSourceDefinitionV1[]>();
  let knownRevision: string | null = null;

  const readPages = async (
    context: DiscordAutomationInvocationContext,
  ): Promise<readonly AutomationEventSourceDefinitionV1[] | 'unchanged'> => {
    const collected: AutomationEventSourceDefinitionV1[] = [];
    let cursor: string | undefined;
    let revision: string | null = null;
    for (;;) {
      context.signal.throwIfAborted();
      const result = await context.services.actions.execute(
        'automation.event.sources.list',
        {
          transport: { kind: 'checkpointedPull' },
          ...(cursor === undefined ? {} : { cursor }),
          ...(cursor === undefined && knownRevision !== null ? { knownRevision } : {}),
        },
        { signal: context.signal },
      );
      if (result.kind === 'unchanged') return 'unchanged';
      if (result.kind === 'cursorStale') {
        // A catalog that moved mid-page invalidates the partial read. Keep the
        // last complete adopted set and force a clean re-list next tick rather
        // than blinding the socket on a transient catalog write.
        knownRevision = null;
        return 'unchanged';
      }
      revision = result.revision;
      collected.push(...result.definitions.filter(isDiscordMessageEventDefinition));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    knownRevision = revision;
    return collected;
  };

  return Object.freeze({
    async refresh(context) {
      let definitions: readonly AutomationEventSourceDefinitionV1[] | 'unchanged';
      try {
        definitions = await readPages(context);
      } catch (error) {
        // The Automation catalog is a separate authority from the Gateway. A
        // read failure — including a retired generation's abort — leaves the
        // last adopted set in place and lets the supervisor's own reconciliation
        // decide the socket's fate. This consumer never ends the loop.
        if (!context.signal.aborted) {
          context.services.logger.warn('discord_automation_event.sources_unavailable', {
            reason: error instanceof Error ? error.message : 'unknown',
          });
        }
        return;
      }
      if (definitions === 'unchanged') return;
      const next = new Map<string, AutomationEventSourceDefinitionV1[]>();
      for (const definition of definitions) {
        const config = parseDiscordAutomationMessageSourceConfig(definition.sourceConfig);
        if (config === null) continue;
        const key = watchKey(config.applicationId, config.channelId);
        const bucket = next.get(key) ?? [];
        bucket.push(definition);
        next.set(key, bucket);
      }
      definitionsByWatchKey = new Map(
        [...next].map(([key, bucket]) => [key, Object.freeze(bucket)] as const),
      );
    },

    async admit(input, context) {
      const payload = createDiscordAutomationMessagePayload({ observation: input.observation });
      if (payload === null) return;
      const matches = definitionsByWatchKey.get(watchKey(input.applicationId, payload.channelId));
      if (matches === undefined || matches.length === 0) return;
      const admission: AutomationEventAdmitInputV1 = {
        eventRef: { pluginId: DISCORD_PLUGIN_ID, localId: DISCORD_AUTOMATION_MESSAGE_EVENT_ID },
        occurrenceId: input.observation.occurrenceId,
        occurredAt: input.observation.occurredAt,
        observationReceivedAt: Date.now(),
        payload,
        definitions: matches.map(toSelector),
      };
      try {
        const result = await context.services.actions.execute(
          'automation.event.admit',
          admission,
          { signal: context.signal },
        );
        if (result.results.some((item) => item.kind === 'refreshDefinition')) {
          // The host says an adopted definition no longer describes this
          // source. Drop the known revision so the next reconciliation
          // re-reads the catalog instead of trusting the stale entry.
          knownRevision = null;
        }
        const unsafe = result.results.filter((item) => !item.checkpointSafe);
        if (unsafe.length > 0) {
          // A checkpoint-unsafe outcome asks the observer to retry from its
          // stored position. This provider observes a live Gateway stream and
          // owns no durable cursor, so there is no position to retry from: the
          // in-process Gateway RESUME window may redeliver the event, but a
          // process loss or plugin reload will not, and the occurrence is then
          // dropped. Record that plainly rather than implying a replay — this
          // exact hole is why the Event declaration is withheld, and closing it
          // is the follow-up described in `discordAutomationEvent.ts`.
          context.services.logger.warn('discord_automation_event.occurrence_dropped', {
            occurrenceId: admission.occurrenceId,
            outcomes: unsafe,
          });
        }
        context.services.logger.info('discord_automation_event.admitted', {
          occurrenceId: admission.occurrenceId,
          results: result.results,
        });
      } catch (error) {
        // Automation admission is a strictly additive consumer of the Channels
        // ingress. Its failure — including a teardown abort — must never close
        // the Gateway socket or discard the Channels observation that shares
        // this dispatch. The occurrence identity is stable, so a redelivery
        // inside the Gateway RESUME window is deduplicated by the host; a
        // process loss or plugin reload has no durable cursor to resume from,
        // so this occurrence is dropped.
        if (!context.signal.aborted) {
          context.services.logger.warn('discord_automation_event.admission_failed', {
            occurrenceId: admission.occurrenceId,
            reason: error instanceof Error ? error.message : 'unknown',
          });
        }
      }
    },
  });
}

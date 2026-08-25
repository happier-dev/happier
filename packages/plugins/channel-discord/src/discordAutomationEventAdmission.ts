import {
  ConversationProviderAutomationEventAdmitInputV1Schema,
  type ConversationProviderAutomationEventAdmitResultV1,
} from '@happier-dev/channels-protocol/v1';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

import { assertDiscordChannelsCoreCaller } from './discordActions.js';

type SourcesListResult = PluginActionResultById['automation.event.sources.list'];
type SourceDefinition = Extract<SourcesListResult, Readonly<{ kind: 'page' }>>['definitions'][number];
type AdmitInput = PluginActionInputById['automation.event.admit'];

async function readCurrentSourceDefinitions(
  context: PluginInvocationContext,
): Promise<readonly SourceDefinition[] | null> {
  const definitions: SourceDefinition[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let revision: string | null = null;
  for (;;) {
    context.signal.throwIfAborted();
    const request: PluginActionInputById['automation.event.sources.list'] = {
      transport: { kind: 'checkpointedPull' },
      ...(cursor === undefined ? {} : { cursor }),
    };
    let result: SourcesListResult;
    try {
      result = await context.services.actions.execute(
        'automation.event.sources.list',
        request,
        { signal: context.signal },
      );
    } catch (error) {
      if (context.signal.aborted) throw error;
      return null;
    }
    context.signal.throwIfAborted();
    if (result.kind !== 'page' || (revision !== null && result.revision !== revision)) {
      return null;
    }
    revision ??= result.revision;
    definitions.push(...result.definitions);
    if (result.nextCursor === null) return definitions;
    if (seenCursors.has(result.nextCursor)) return null;
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
}

/**
 * Stateless bridge for one frozen Channels Event obligation. It re-reads the
 * current matching Automation definitions and invokes their host admission;
 * Channels remains the only observation, retry, currentness, and checkpoint
 * owner.
 */
export async function admitDiscordAutomationEvent(
  input: unknown,
  context: PluginInvocationContext,
): Promise<ConversationProviderAutomationEventAdmitResultV1> {
  assertDiscordChannelsCoreCaller(context);
  const request = ConversationProviderAutomationEventAdmitInputV1Schema.parse(input);
  const definitions = await readCurrentSourceDefinitions(context);
  if (definitions === null) return { kind: 'unsettled' };
  const matchingDefinitions = definitions.filter((definition) => (
    definition.eventRef.pluginId === request.candidate.eventRef.pluginId
    && definition.eventRef.localId === request.candidate.eventRef.localId
    && definition.sourceInstanceId === request.candidate.sourceInstanceId
    && definition.sourceContractVersion === request.candidate.sourceContractVersion
  ));
  if (matchingDefinitions.length === 0) return { kind: 'checkpointSafe' };
  const admission: AdmitInput = {
    eventRef: request.candidate.eventRef,
    occurrenceId: request.occurrenceId,
    occurredAt: request.occurredAt,
    observationReceivedAt: request.observationReceivedAt,
    payload: request.candidate.payload,
    definitions: matchingDefinitions.map((definition) => ({
      automationId: definition.automationId,
      templateVersion: definition.templateVersion,
      sourceSelectorId: definition.sourceSelectorId,
    })),
  };
  try {
    const admitted = await context.services.actions.execute(
      'automation.event.admit',
      admission,
      { signal: context.signal },
    );
    context.signal.throwIfAborted();
    return admitted.results.every((result) => result.checkpointSafe)
      ? { kind: 'checkpointSafe' }
      : { kind: 'unsettled' };
  } catch (error) {
    if (context.signal.aborted) throw error;
    return { kind: 'unsettled' };
  }
}

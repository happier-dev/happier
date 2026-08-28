import {
  ConversationProviderAutomationEventAdmitInputV1Schema,
  type ConversationProviderAutomationEventAdmitResultV1,
} from '@happier-dev/channels-protocol/v1';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { admitCheckpointedPluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';

import { assertDiscordChannelsCoreCaller } from './discordActions.js';

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
  return admitCheckpointedPluginEventObservationV1({
    eventRef: request.candidate.eventRef,
    sourceInstanceId: request.candidate.sourceInstanceId,
    sourceContractVersion: request.candidate.sourceContractVersion,
    occurrenceId: request.occurrenceId,
    occurredAt: request.occurredAt,
    observationReceivedAt: request.observationReceivedAt,
    observedDelta: request.observedDelta,
    payload: request.candidate.payload,
  }, context);
}

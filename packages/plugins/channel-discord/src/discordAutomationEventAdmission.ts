import {
  ConversationProviderAutomationEventAdmitInputV1Schema,
  type ConversationProviderAutomationEventAdmitResultV1,
} from '@happier-dev/channels-protocol/v1';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { admitSessionSocketPluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';

import { assertDiscordChannelsCoreCaller } from './discordActions.js';

/**
 * Stateless bridge for one frozen Channels Event obligation. It re-reads the
 * current matching Automation definitions and invokes their host admission;
 * Channels remains the only observation, retry, and currentness owner, and the
 * provider-owned Gateway session carries the provider-side receive truth. This
 * source has no ordered pull checkpoint, so admission runs under the truthful
 * session-socket scope; an unsettled result remains with incumbent Channels
 * custody, while the Gateway itself promises no replay or checkpoint.
 */
export async function admitDiscordAutomationEvent(
  input: unknown,
  context: PluginInvocationContext,
): Promise<ConversationProviderAutomationEventAdmitResultV1> {
  assertDiscordChannelsCoreCaller(context);
  const request = ConversationProviderAutomationEventAdmitInputV1Schema.parse(input);
  return admitSessionSocketPluginEventObservationV1({
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

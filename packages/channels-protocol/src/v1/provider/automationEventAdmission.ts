import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
    admitCheckpointedPluginEventObservationV1,
    admitSessionSocketPluginEventObservationV1,
} from '@happier-dev/plugin-sdk/events';

import {
    ConversationProviderAutomationEventAdmitInputV1Schema,
    type ConversationProviderAutomationEventAdmitResultV1,
} from './automationEvents.js';

/**
 * Stateless admission of a frozen Channels obligation through the SDK owner.
 * The provider verifies its Channels caller before entering this bridge and
 * names its actual transport; Channels retains retry and checkpoint custody.
 */
export async function admitConversationProviderAutomationEventV1(
    input: unknown,
    context: PluginInvocationContext,
    transport: 'checkpointedPull' | 'socket',
): Promise<ConversationProviderAutomationEventAdmitResultV1> {
    const request = ConversationProviderAutomationEventAdmitInputV1Schema.parse(input);
    const admit = transport === 'checkpointedPull'
        ? admitCheckpointedPluginEventObservationV1
        : admitSessionSocketPluginEventObservationV1;
    const disposition = await admit({
        ...request.candidate,
        occurrenceId: request.occurrenceId,
        occurredAt: request.occurredAt,
        observationReceivedAt: request.observationReceivedAt,
        observedDelta: request.observedDelta,
    }, context);
    return { kind: disposition.kind };
}

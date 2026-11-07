import { areConversationEndpointIdentitiesEqual, type ConversationResolvedEndpointV1 } from '@happier-dev/channels-protocol/v1';

/** A thread belongs to its exact endpoint or its same-audience parent conversation. */
export function matchesConversationBindingEndpoint(binding: ConversationResolvedEndpointV1, observed: ConversationResolvedEndpointV1): boolean {
  return areConversationEndpointIdentitiesEqual(binding, observed)
    || (observed.kind === 'thread' && observed.parentId === binding.id && observed.audience === binding.audience);
}

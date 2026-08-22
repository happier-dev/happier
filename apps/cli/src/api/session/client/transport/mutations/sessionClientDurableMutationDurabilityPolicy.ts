import { getSessionStateFieldDescriptor } from '@happier-dev/agents';

import {
    SESSION_CLIENT_DURABLE_MUTATION_DELIVERY_CLASSIFICATION,
    type SessionClientDurableMutationDeliveryClassification,
} from './sessionClientDurableMutationClassification';
import type { QueuedSessionClientDurableMutation } from './sessionClientDurableMutationTypes';

export function isAuthoritativeSessionClientDurableMutationKind(
    kind: string,
): kind is 'session_turn_mutation' | 'session_end' | 'voice_agent_transcript_turn' {
    return kind === 'session_turn_mutation'
        || kind === 'session_end'
        || kind === 'voice_agent_transcript_turn';
}

export function isAuthoritativeSessionClientDurableMutation(
    mutation: QueuedSessionClientDurableMutation,
): boolean {
    return isAuthoritativeSessionClientDurableMutationKind(mutation.kind);
}

export function shouldDeadLetterSessionClientDurableMutation(
    mutation: QueuedSessionClientDurableMutation,
): boolean {
    return resolveSessionClientDurableMutationDeliveryClass(mutation) !== 'durable_required';
}

export function resolveSessionClientDurableMutationDeliveryClass(
    mutation: QueuedSessionClientDurableMutation,
): SessionClientDurableMutationDeliveryClassification {
    if (mutation.kind === 'registered_session_state_field') {
        return getSessionStateFieldDescriptor(mutation.payload.fieldId).deliveryClass;
    }
    if (mutation.kind === 'transcript_message_append' || mutation.kind === 'voice_agent_transcript_turn') {
        return SESSION_CLIENT_DURABLE_MUTATION_DELIVERY_CLASSIFICATION.transcript_message_append;
    }
    if (mutation.kind === 'session_end') {
        return SESSION_CLIENT_DURABLE_MUTATION_DELIVERY_CLASSIFICATION.session_end;
    }
    return SESSION_CLIENT_DURABLE_MUTATION_DELIVERY_CLASSIFICATION.primary_turn_runtime_projection;
}

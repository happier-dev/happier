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
    if (
        mutation.kind === 'registered_session_state_field'
        && mutation.payload.fieldId === 'runtime.usageLimitRecovery'
        && mutation.payload.source === 'daemon'
        && mutation.payload.deliveryClass === 'durable_required'
    ) {
        return false;
    }
    return !isAuthoritativeSessionClientDurableMutation(mutation);
}

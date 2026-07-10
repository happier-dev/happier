import type { QueuedSessionClientDurableMutation } from './sessionClientDurableMutationTypes';

export function isAuthoritativeSessionClientDurableMutationKind(
    kind: string,
): kind is 'session_turn_mutation' | 'session_end' {
    return kind === 'session_turn_mutation' || kind === 'session_end';
}

export function isAuthoritativeSessionClientDurableMutation(
    mutation: QueuedSessionClientDurableMutation,
): boolean {
    return isAuthoritativeSessionClientDurableMutationKind(mutation.kind);
}

export function shouldDeadLetterSessionClientDurableMutation(
    mutation: QueuedSessionClientDurableMutation,
): boolean {
    return !isAuthoritativeSessionClientDurableMutation(mutation);
}

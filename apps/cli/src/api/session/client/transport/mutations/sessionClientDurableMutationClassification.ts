export type SessionClientDurableMutationDeliveryClassification =
    | 'durable_required'
    | 'durable_best_effort'
    | 'ephemeral_drop_ok';

export type SessionClientDurableMutationFactType =
    | 'transcript_message_append'
    | 'primary_turn_runtime_projection'
    | 'session_end'
    | 'usage_observation'
    | 'registered_session_state_field'
    | 'keep_alive_presence'
    | 'ephemeral_agent_message';

/**
 * Delivery classification for session-scoped facts.
 * durable_required facts affect runtime recovery or user-visible state and must be retried/persisted.
 * durable_best_effort facts may use fallback transports but are not required for recovery.
 * ephemeral_drop_ok facts are transient presence/stream hints and must not be persisted.
 */
export const SESSION_CLIENT_DURABLE_MUTATION_DELIVERY_CLASSIFICATION:
Readonly<Record<SessionClientDurableMutationFactType, SessionClientDurableMutationDeliveryClassification>> = {
    transcript_message_append: 'durable_required',
    primary_turn_runtime_projection: 'durable_required',
    session_end: 'durable_required',
    usage_observation: 'durable_best_effort',
    registered_session_state_field: 'durable_required',
    keep_alive_presence: 'ephemeral_drop_ok',
    ephemeral_agent_message: 'ephemeral_drop_ok',
};

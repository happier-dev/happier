import type {
  ConversationBindingManagementRow,
  ConversationConnectionManagementRow,
} from './accountLocalBindingPolicy.js';

/**
 * Why one Session-bound conversation currently needs its owner.
 *
 * Every member is a persisted Account fact the canonical binding, connection,
 * and transcript-frontier owners already publish. Nothing here is a new status
 * store, a second health model, or a speculative reason with no producer: an
 * entry exists only where a reader can read the state that produces it, and
 * remediation delegates to an incumbent owner.
 */
export type ConversationSessionBindingAttentionReasonV1 =
  | 'connectionUnavailable'
  | 'providerCredentialInvalid'
  | 'providerPermissionMissing'
  | 'providerConfigurationInvalid'
  | 'connectionDeleting'
  | 'connectionDisabled'
  | 'bindingDisabled'
  | 'transcriptHistoryGap';

export type ConversationSessionBindingAttentionV1 = Readonly<{
  bindingId: string;
  reason: ConversationSessionBindingAttentionReasonV1;
  bindingRevision?: number;
  frontierRevision?: number;
}>;

/** The widest `{"bindingId":…,"reason":…}` entry this projection can serialize. */
export const MAX_CONVERSATION_SESSION_BINDING_ATTENTION_ENTRY_BYTES = 240;

const ATTENTION_REASONS: ReadonlySet<string> = new Set<ConversationSessionBindingAttentionReasonV1>([
  'connectionUnavailable',
  'providerCredentialInvalid',
  'providerPermissionMissing',
  'providerConfigurationInvalid',
  'connectionDeleting',
  'connectionDisabled',
  'bindingDisabled',
  'transcriptHistoryGap',
]);

export function isConversationSessionBindingAttentionReason(
  value: unknown,
): value is ConversationSessionBindingAttentionReasonV1 {
  return typeof value === 'string' && ATTENTION_REASONS.has(value);
}

/**
 * The ONE Session-scoped attention decision, shared by the Resource that
 * publishes the Composer badge and by the Session destination that explains
 * it. Both therefore describe the same conversation with the same reason, and
 * neither re-derives health from a private rule.
 *
 * Reasons are ordered by what actually blocks delivery first: a connection
 * that cannot run at all makes its bindings' own policy irrelevant, so
 * reporting the binding instead would send the owner to the wrong control.
 *
 * A binding already being deleted is deliberately NOT attention. Its removal
 * is the outcome the owner asked for, and there is no control left to offer.
 */
export function projectConversationSessionBindingAttention(input: Readonly<{
  binding: Pick<
    ConversationBindingManagementRow,
    'bindingId' | 'connectionId' | 'enabled' | 'deletionState'
  >;
  connection: Pick<
    ConversationConnectionManagementRow,
    'enabled' | 'deletionState' | 'attention'
  > | undefined;
  transcriptHistoryGap?: boolean;
}>): ConversationSessionBindingAttentionV1 | null {
  const { binding, connection } = input;
  if (binding.deletionState !== 'none') return null;
  const attention = (
    reason: ConversationSessionBindingAttentionReasonV1,
  ): ConversationSessionBindingAttentionV1 => Object.freeze({
    bindingId: binding.bindingId,
    reason,
  });
  if (connection === undefined) return attention('connectionUnavailable');
  const readiness = connection.attention.providerReadiness;
  if (readiness !== null) return attention(readiness.code);
  if (connection.deletionState !== 'none') return attention('connectionDeleting');
  if (!connection.enabled) return attention('connectionDisabled');
  if (!binding.enabled) return attention('bindingDisabled');
  if (input.transcriptHistoryGap === true) return attention('transcriptHistoryGap');
  return null;
}

/** Project every Session binding's attention against its current connection. */
export function projectConversationSessionBindingAttentions(input: Readonly<{
  bindings: readonly Pick<
    ConversationBindingManagementRow,
    'bindingId' | 'connectionId' | 'enabled' | 'deletionState' | 'revision'
  >[];
  connectionsById: ReadonlyMap<string, Pick<
    ConversationConnectionManagementRow,
    'enabled' | 'deletionState' | 'attention'
  >>;
  transcriptHistoryGapBindingIds?: ReadonlySet<string>;
  transcriptHistoryGapFrontierRevisions?: ReadonlyMap<string, number>;
}>): readonly ConversationSessionBindingAttentionV1[] {
  return Object.freeze(input.bindings.flatMap((binding) => {
    const projected = projectConversationSessionBindingAttention({
      binding,
      connection: input.connectionsById.get(binding.connectionId),
      transcriptHistoryGap: input.transcriptHistoryGapBindingIds?.has(binding.bindingId),
    });
    if (projected === null) return [];
    return projected.reason === 'transcriptHistoryGap'
      ? [{
        ...projected,
        bindingRevision: binding.revision,
        frontierRevision: input.transcriptHistoryGapFrontierRevisions?.get(binding.bindingId),
      }]
      : [projected];
  }));
}

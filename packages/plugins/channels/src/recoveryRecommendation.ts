import {
  CONVERSATION_CORE_PLUGIN_ID_V1,
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1 as actions,
  type ConversationBindingReadInputV1,
  type ConversationBindingSetEnabledInputV1,
  type ConversationConnectionDeleteInputV1,
  type ConversationConnectionListInputV1Schema,
  type ConversationConnectionPollRetryInputV1,
  type ConversationConnectionRetestInputV1,
  type ConversationConnectionUpdateInputV1,
  type ConversationDeliveryAttentionInputV1Schema,
  type ConversationDeliveryReadInputV1Schema,
  type ConversationDeliveryResolveInputV1,
  type ConversationIngressRetryInputV1,
  type ConversationRecommendedRecoveryV1,
  type ConversationStreamNoticeDismissInputV1,
} from '@happier-dev/channels-protocol/v1';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginActionInputById } from '@happier-dev/plugin-sdk/actions';
import type { ConversationConnectionManagementRow, ConversationBindingManagementRow, ConversationIngressAttentionRow } from './accountLocalBindingPolicy.js';

/** Recommendations consume native evidence; they never grant mutation authority. */
export function recommendConversationRecovery(
  localId: string, input: JsonValue, reason: string, unavailableReason?: string,
): ConversationRecommendedRecoveryV1 {
  return { action: { pluginId: CONVERSATION_CORE_PLUGIN_ID_V1, localId }, input, reason,
    ...(unavailableReason === undefined ? {} : { unavailableReason }) };
}

export function recommendConversationConnectionRecovery(row: ConversationConnectionManagementRow, credentialRef?: JsonValue): ConversationRecommendedRecoveryV1 | null {
  const connection = { connectionId: row.connectionId } satisfies ConversationConnectionRetestInputV1 & ConversationConnectionPollRetryInputV1;
  if (row.deletionState !== 'none') return recommendConversationRecovery(actions.connectionDelete,
    { connectionId: row.connectionId, expectedRevision: row.revision } satisfies ConversationConnectionDeleteInputV1, 'connectionDeleting',
    row.deletionState === 'finalizingDelete' ? 'cleanupInProgress' : undefined);
  if (row.attention.providerReadiness?.code === 'providerCredentialInvalid') {
    const account = QualifiedConnectedAccountRefSchema.safeParse(credentialRef);
    if (account.success) {
      const input = { account: account.data, machineId: row.selectedMachineId } satisfies PluginActionInputById['connectedServices.authentication.beginReconnect'];
      return { action: 'connectedServices.authentication.beginReconnect', input, reason: 'providerCredentialInvalid' };
    }
    // The raw retained-row projection may already have resolved this reference.
    // Later conflict/delivery projections reuse it without reading credentials.
    if (row.recommendedRecovery?.action === 'connectedServices.authentication.beginReconnect') return row.recommendedRecovery;
  }
  if (row.attention.providerReadiness !== null) return recommendConversationRecovery(actions.connectionRetest, connection,
    row.attention.providerReadiness.code);
  if (!row.enabled) return recommendConversationRecovery(actions.connectionUpdate,
    { connectionId: row.connectionId, expectedRevision: row.revision, enabled: true } satisfies ConversationConnectionUpdateInputV1, 'connectionDisabled');
  if (row.attention.pollFailure?.phase === 'blocked') return recommendConversationRecovery(actions.connectionPollRetry, connection, 'pollBlocked');
  if (row.attention.pollFailure?.phase === 'retryDue') return recommendConversationRecovery(actions.connectionList, {} satisfies ReturnType<typeof ConversationConnectionListInputV1Schema.parse>, 'retryScheduled');
  const delivery = row.attention.outwardDelivery;
  if (delivery && Object.values(delivery).some(Boolean)) return recommendConversationRecovery(actions.deliveryAttention,
    { connectionId: row.connectionId } satisfies ReturnType<typeof ConversationDeliveryAttentionInputV1Schema.parse>, 'deliveryAttention');
  if (row.attention.historyGap !== null) return recommendConversationRecovery(actions.streamNoticeDismiss,
    { connectionId: row.connectionId, expectedRevision: row.revision } satisfies ConversationStreamNoticeDismissInputV1, 'historyGap');
  return null;
}

export function recommendConversationBindingRecovery(row: ConversationBindingManagementRow): ConversationRecommendedRecoveryV1 | null {
  if (row.deletionState !== 'none') return recommendConversationRecovery(actions.bindingRead,
    { bindingId: row.bindingId } satisfies ConversationBindingReadInputV1, 'bindingDeleting');
  if (!row.enabled) return recommendConversationRecovery(actions.bindingSetEnabled,
    { bindingId: row.bindingId, expectedRevision: row.revision, enabled: true } satisfies ConversationBindingSetEnabledInputV1, 'bindingDisabled');
  return null;
}

export function recommendConversationIngressRecovery(row: ConversationIngressAttentionRow): ConversationRecommendedRecoveryV1 | null {
  if (row.kind === 'blocked') return recommendConversationRecovery(actions.ingressRetry,
    { obligationId: row.obligationId, expectedRevision: row.revision } satisfies ConversationIngressRetryInputV1, 'ingressBlocked');
  if (row.category === 'recoverable') return recommendConversationRecovery(row.bindingId ? actions.bindingRead : actions.connectionList,
    row.bindingId ? { bindingId: row.bindingId } satisfies ConversationBindingReadInputV1 : {} satisfies ReturnType<typeof ConversationConnectionListInputV1Schema.parse>, row.reason ?? 'ingressAttention');
  return null;
}

export function recommendConversationDeliveryRecovery(row: Readonly<{
  custodyId: string; revision: number; state: string;
}>): ConversationRecommendedRecoveryV1 | null {
  const exact = { custodyId: row.custodyId, expectedRevision: row.revision } satisfies Omit<ConversationDeliveryResolveInputV1, 'resolution'>;
  if (row.state === 'partial' || row.state === 'outcomeUnknown') return recommendConversationRecovery(actions.deliveryResolve,
    exact, row.state, 'ownerDecisionRequired');
  if (row.state === 'archiveRecoverable') return null;
  if (row.state === 'ready' || row.state === 'retryDue' || row.state === 'attempting' || row.state === 'notDelivered') {
    return recommendConversationRecovery(actions.deliveryRead, { custodyId: row.custodyId } satisfies ReturnType<typeof ConversationDeliveryReadInputV1Schema.parse>, row.state);
  }
  return null;
}

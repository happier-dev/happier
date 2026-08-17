import type {
  ConversationReconciliationConnectionStateV1,
} from '../src/reconciliation.js';

export function assertDeletingConnectionEnabledInvariant(
  state: ConversationReconciliationConnectionStateV1,
): void {
  if (state.deletionState === 'pendingStopReconciliation') {
    const enabled: false = state.enabled;
    void enabled;
  }
  if (state.deletionState === 'finalizingDelete') {
    const enabled: false = state.enabled;
    void enabled;
  }
}

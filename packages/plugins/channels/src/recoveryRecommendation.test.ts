import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_CORE_PLUGIN_ID_V1,
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1 as actions,
  ConversationBindingManagementRowV1Schema,
  ConversationConnectionManagementRowV1Schema,
  ConversationIngressAttentionResultV1Schema,
  type ConversationRecommendedRecoveryV1,
} from '@happier-dev/channels-protocol/v1';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { PLUGIN_MANIFEST } from './manifest.js';
import {
  recommendConversationBindingRecovery,
  recommendConversationConnectionRecovery,
  recommendConversationDeliveryRecovery,
  recommendConversationIngressRecovery,
  recommendConversationRecovery,
} from './recoveryRecommendation.js';

function acceptsRecommendation(recovery: ConversationRecommendedRecoveryV1 | null): boolean {
  if (!recovery || typeof recovery.action === 'string') throw new Error('Expected Channels recovery');
  const { pluginId, localId } = recovery.action;
  expect(pluginId).toBe(CONVERSATION_CORE_PLUGIN_ID_V1);
  const declaration = PLUGIN_MANIFEST.contributes?.actions?.find(action => action.id === localId);
  if (!declaration?.inputSchema) throw new Error(`Missing Action schema: ${localId}`);
  return isValidPluginJsonSchemaValue(compilePluginJsonSchema(declaration.inputSchema), recovery.input);
}

const connection = ConversationConnectionManagementRowV1Schema.parse({
  connectionId: 'connection-1', revision: 4, authorityEpoch: 3,
  providerPluginId: 'test.channel.read', selectedMachineId: 'machine-1', selectedTransport: 'checkpointedPull',
  enabled: true, deletionState: 'none', attention: {
    historyGap: null, providerReadiness: null, ingressConflict: null, pollFailure: null,
    bestEffortBeforeDurableAdmission: false, oldTransportStopUnconfirmed: false,
    endpointRetargetOwed: false, acceptedPossibleLoss: false,
    outwardDelivery: { retryDue: false, notDelivered: false, partial: false, outcomeUnknown: false, archiveRecovery: false },
  },
});

describe('Channels recovery operands use their registered Action contracts', () => {
  it.each([
    { ...connection, deletionState: 'pendingStopReconciliation' as const },
    { ...connection, deletionState: 'finalizingDelete' as const },
    { ...connection, enabled: false },
    { ...connection, attention: { ...connection.attention, providerReadiness: { code: 'providerPermissionMissing' as const } } },
    { ...connection, attention: { ...connection.attention, pollFailure: {
      phase: 'blocked' as const, attemptCount: 1, retryNotBeforeMs: null,
      evidence: { kind: 'provider' as const, reason: 'network' as const },
    } } },
    { ...connection, attention: { ...connection.attention, pollFailure: {
      phase: 'retryDue' as const, attemptCount: 1, retryNotBeforeMs: 100,
      evidence: { kind: 'provider' as const, reason: 'network' as const },
    } } },
    { ...connection, attention: { ...connection.attention,
      outwardDelivery: { ...connection.attention.outwardDelivery, notDelivered: true } } },
    { ...connection, attention: { ...connection.attention,
      historyGap: { reportedAt: 100, reason: 'providerHistoryUnavailable' as const } } },
  ])('produces schema-valid connection guidance for %j', row => {
    expect(acceptsRecommendation(recommendConversationConnectionRecovery(row))).toBe(true);
  });

  it('produces schema-valid binding and ingress recovery guidance', () => {
    const binding = ConversationBindingManagementRowV1Schema.parse({
      bindingId: 'binding-1', revision: 2, connectionId: 'connection-1', endpoint: { audience: 'direct' },
      target: { kind: 'session', summary: 'session-1' }, inputMode: 'allAllowedMessages',
      deliveryMode: 'repliesOnly', approval: { kind: 'off' }, enabled: false, deletionState: 'none',
    });
    for (const row of [binding, { ...binding, deletionState: 'finalizingDelete' as const }]) {
      expect(acceptsRecommendation(recommendConversationBindingRecovery(row))).toBe(true);
    }
    const { obligations } = ConversationIngressAttentionResultV1Schema.parse({ obligations: [
      { kind: 'blocked', obligationId: 'i'.repeat(43), revision: 2,
        connectionId: 'connection-1', attemptCount: 1, updatedAt: 100 },
      { kind: 'terminal', obligationId: 'i'.repeat(43), revision: 2,
        connectionId: 'connection-1', bindingId: 'binding-1', updatedAt: 100, category: 'recoverable' },
      { kind: 'terminal', obligationId: 'i'.repeat(43), revision: 2,
        connectionId: 'connection-1', updatedAt: 100, category: 'recoverable' },
    ] });
    for (const row of obligations) expect(acceptsRecommendation(recommendConversationIngressRecovery(row))).toBe(true);
  });

  it.each(['ready', 'retryDue', 'attempting', 'notDelivered'])('produces schema-valid delivery guidance for %s', state => {
    expect(acceptsRecommendation(recommendConversationDeliveryRecovery({ custodyId: 'd'.repeat(43), revision: 2, state }))).toBe(true);
  });

  it.each(['partial', 'outcomeUnknown'])('requires an owner decision before resolving %s delivery', state => {
    const recovery = recommendConversationDeliveryRecovery({ custodyId: 'd'.repeat(43), revision: 2, state });
    expect(recovery?.unavailableReason).toBe('ownerDecisionRequired');
    expect(acceptsRecommendation(recovery)).toBe(false);
    if (!recovery || typeof recovery.input !== 'object' || recovery.input === null || Array.isArray(recovery.input)) throw new Error('Missing delivery operands');
    for (const resolution of ['accepted', 'discarded']) {
      expect(acceptsRecommendation({ ...recovery, input: { ...recovery.input, resolution } })).toBe(true);
    }
  });

  it.each(['accountStateUnavailable', 'setupSelectionRequired'])('keeps create guidance unavailable until %s is resolved', unavailableReason => {
    const recovery = recommendConversationRecovery(actions.connectionCreate, {}, 'createOutcomeUnknown', unavailableReason);
    expect(recovery.unavailableReason).toBe(unavailableReason);
    expect(acceptsRecommendation(recovery)).toBe(false);
  });

  it('does not invent recovery for settled rows', () => {
    expect(recommendConversationConnectionRecovery(connection)).toBeNull();
    expect(recommendConversationDeliveryRecovery({ custodyId: 'd'.repeat(43), revision: 2, state: 'archiveRecoverable' })).toBeNull();
  });
});

import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/plugin-sdk/actions';
import type { ConversationProviderConnectionStopInputV1 } from '@happier-dev/channels-protocol/v1';

import {
  CHANNEL_STATE_RECORD_KIND,
  type PersistedConversationProviderContributionSelection,
} from '../collections.js';
import type {
  ConversationCheckpointedPollInvocationBasisV1,
  ConversationConnectionHistoryGapV1,
  ConversationConnectionOverlapSafetyV1,
  ConversationConnectionPollFailureV1,
  ConversationConnectionProviderReadinessV1,
  ConversationPendingOldTransportStopV1,
} from '../connectionLifecycle.js';

type ConnectionTransportFixture =
  | Readonly<{ kind: 'checkpointedPull' }>
  | Readonly<{ kind: 'socket' }>
  | Readonly<{
    kind: 'durablePush';
    webhookContributionRef: Readonly<{ pluginId: string; localId: string }>;
    webhookEndpointId: string;
    webhookSourceInstanceId: string;
  }>;

/**
 * The explicit persisted authority for a current connection fixture. Tests
 * that vary transfer/delete/currentness/generation/credentials must provide a
 * distinct authority value rather than letting a fixture infer installed
 * provider state.
 */
export type ConversationConnectionFixtureAuthority = Readonly<{
  providerPluginId: string;
  providerContributionSelection: PersistedConversationProviderContributionSelection;
  providerSetupInput: JsonValue;
  credentialRef: ConversationProviderConnectionStopInputV1['credentialRef'];
  transportOrigin: PluginMachineExecutionOriginV1;
  providerConnectionKey: ConversationProviderConnectionStopInputV1['providerConnectionKey'];
  providerConfig: ConversationProviderConnectionStopInputV1['providerConfig'];
  routingIdentityKey: string;
  integrationPrincipal: Readonly<{ id: string; label?: string }>;
  authorityEpoch: number;
}>;

export type CurrentConversationConnectionFixture = Readonly<{
  id: string;
  'record-kind': 'connection';
  v: 1;
  'connection-id': string;
  'created-at': number;
  'updated-at': number;
  payload: Readonly<{
    providerPluginId: string;
    providerContributionSelection: PersistedConversationProviderContributionSelection;
    providerSetupInput: JsonValue;
    credentialRef: ConversationProviderConnectionStopInputV1['credentialRef'];
    transportOrigin: PluginMachineExecutionOriginV1;
    transport: ConnectionTransportFixture;
    overlapSafety: ConversationConnectionOverlapSafetyV1;
    replayContinuity: 'checkpointed' | 'sessionBound' | 'none';
    outboundTextLimit: Readonly<{
      maximum: number;
      unit: 'unicodeCodePoints' | 'utf8Bytes';
    }>;
    pairingDeepLinkTemplate?: string;
    providerConnectionKey: ConversationProviderConnectionStopInputV1['providerConnectionKey'];
    providerConfigVersion: 1;
    providerConfig: ConversationProviderConnectionStopInputV1['providerConfig'];
    routingIdentityKey: string;
    integrationPrincipal: Readonly<{ id: string; label?: string }>;
    authorityEpoch: number;
    enabled: boolean;
    deletionState: 'none' | 'pendingStopReconciliation' | 'finalizingDelete';
    pendingOldTransportStop: ConversationPendingOldTransportStopV1 | null;
    historyGap: ConversationConnectionHistoryGapV1 | null;
    providerReadiness: ConversationConnectionProviderReadinessV1;
    pollFailure: ConversationConnectionPollFailureV1 | null;
    maximumObservationAgeMs: number;
  }>;
}>;

export function createCurrentConversationConnectionFixture(input: Readonly<{
  connectionId: string;
  authority: ConversationConnectionFixtureAuthority;
  createdAt?: number;
  updatedAt?: number;
  transport?: ConnectionTransportFixture;
  overlapSafety?: ConversationConnectionOverlapSafetyV1;
  replayContinuity?: 'checkpointed' | 'sessionBound' | 'none';
  outboundTextLimit?: Readonly<{
    maximum: number;
    unit: 'unicodeCodePoints' | 'utf8Bytes';
  }>;
  pairingDeepLinkTemplate?: string;
  enabled?: boolean;
  deletionState?: 'none' | 'pendingStopReconciliation' | 'finalizingDelete';
  pendingOldTransportStop?: ConversationPendingOldTransportStopV1 | null;
  historyGap?: ConversationConnectionHistoryGapV1 | null;
  providerReadiness?: ConversationConnectionProviderReadinessV1;
  pollFailure?: ConversationConnectionPollFailureV1 | null;
  maximumObservationAgeMs?: number;
}>): CurrentConversationConnectionFixture {
  const updatedAt = input.updatedAt ?? input.createdAt ?? 1;
  return {
    id: input.connectionId,
    'record-kind': CHANNEL_STATE_RECORD_KIND.connection,
    v: 1,
    'connection-id': input.connectionId,
    'created-at': input.createdAt ?? 1,
    'updated-at': updatedAt,
    payload: {
      providerPluginId: input.authority.providerPluginId,
      providerContributionSelection: input.authority.providerContributionSelection,
      providerSetupInput: input.authority.providerSetupInput,
      credentialRef: input.authority.credentialRef,
      transportOrigin: input.authority.transportOrigin,
      transport: input.transport ?? { kind: 'checkpointedPull' },
      overlapSafety: input.overlapSafety ?? 'safe',
      replayContinuity: input.replayContinuity ?? 'checkpointed',
      outboundTextLimit: input.outboundTextLimit ?? { maximum: 4_096, unit: 'unicodeCodePoints' },
      ...(input.pairingDeepLinkTemplate === undefined
        ? {}
        : { pairingDeepLinkTemplate: input.pairingDeepLinkTemplate }),
      providerConnectionKey: input.authority.providerConnectionKey,
      providerConfigVersion: 1,
      providerConfig: input.authority.providerConfig,
      routingIdentityKey: input.authority.routingIdentityKey,
      integrationPrincipal: input.authority.integrationPrincipal,
      authorityEpoch: input.authority.authorityEpoch,
      enabled: input.enabled ?? true,
      deletionState: input.deletionState ?? 'none',
      pendingOldTransportStop: input.pendingOldTransportStop ?? null,
      historyGap: input.historyGap ?? null,
      providerReadiness: input.providerReadiness ?? null,
      pollFailure: input.pollFailure ?? null,
      maximumObservationAgeMs: input.maximumObservationAgeMs ?? 60_000,
    },
  };
}

/**
 * A frozen old-transport custody fixture. The caller supplies the exact old
 * authority and must name the exact predecessor poll basis and authority epoch
 * at which its request was frozen.
 */
export function createCurrentConversationPendingOldTransportStopFixture(input: Readonly<{
  connectionId: string;
  authority: ConversationConnectionFixtureAuthority;
  predecessorCheckpointedPollInvocation: ConversationCheckpointedPollInvocationBasisV1;
  authorityEpoch: number;
  reason: 'transfer' | 'delete';
  overlapSafety: ConversationConnectionOverlapSafetyV1;
  acceptedPossibleLoss?: boolean;
}>): ConversationPendingOldTransportStopV1 {
  return {
    predecessorCheckpointedPollInvocation: input.predecessorCheckpointedPollInvocation,
    transportOrigin: input.authority.transportOrigin,
    providerContributionSelection: input.authority.providerContributionSelection,
    stopRequest: {
      v: 1,
      connectionId: input.connectionId,
      providerConnectionKey: input.authority.providerConnectionKey,
      providerConfigVersion: 1,
      providerConfig: input.authority.providerConfig,
      credentialRef: input.authority.credentialRef,
      authorityEpoch: input.authorityEpoch,
      reason: input.reason,
    },
    overlapSafety: input.overlapSafety,
    acceptedPossibleLoss: input.acceptedPossibleLoss ?? false,
  };
}

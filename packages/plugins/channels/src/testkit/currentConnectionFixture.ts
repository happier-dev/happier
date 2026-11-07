import type { PluginMachineExecutionOriginV1 } from '@happier-dev/plugin-sdk/actions';
import { getConversationConnectionTransportOrigin, type ConversationPendingProviderStopV1 } from '../connectionLifecycle.js';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { withChannelStateDeleteFinalizationDueAt } from '../collectionMigrations.js';
import type {
  ConversationBindingInputModeV1,
  ConversationOutboundTextLimitV1,
  ConversationProviderConnectionStopInputV1,
  ConversationTransportKindV1,
} from '@happier-dev/channels-protocol/v1';

import {
  CHANNEL_STATE_RECORD_KIND,
  type PersistedConversationProviderContributionSelection,
} from '../collections.js';
import type {
  ConversationCheckpointedPollInvocationBasisV1,
  ConversationConnectionHistoryGapV1,
  ConversationConnectionTransportOriginV1,
  ConversationConnectionOverlapSafetyV1,
  ConversationConnectionPollFailureV1,
  ConversationConnectionProviderReadinessV1,
  ConversationPendingEndpointRetargetV1,
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
export type ConversationConnectionFixtureAuthority<
  TOrigin extends ConversationConnectionTransportOriginV1 | PluginMachineExecutionOriginV1 = ConversationConnectionTransportOriginV1 | PluginMachineExecutionOriginV1,
> = Readonly<{
  providerPluginId: string;
  providerContributionSelection: PersistedConversationProviderContributionSelection;
  providerSetupInput: JsonValue;
  credentialRef: ConversationProviderConnectionStopInputV1['credentialRef'];
  transportOrigin: TOrigin;
  providerConnectionKey: ConversationProviderConnectionStopInputV1['providerConnectionKey'];
  providerConfig: ConversationProviderConnectionStopInputV1['providerConfig'];
  routingIdentityKey: string;
  integrationPrincipal: Readonly<{ id: string; label?: string }>;
  authorityEpoch: number;
}>;

export type CurrentConversationConnectionFixture<
  TOrigin extends ConversationConnectionTransportOriginV1 | PluginMachineExecutionOriginV1 = ConversationConnectionTransportOriginV1 | PluginMachineExecutionOriginV1,
> = Readonly<{
  id: string;
  'record-kind': 'connection';
  v: 1;
  'connection-id': string;
  'created-at': number;
  'updated-at': number;
  payload: Readonly<{
    configurationRevision: number;
    providerPluginId: string;
    providerContributionSelection: PersistedConversationProviderContributionSelection;
    providerSetupInput: JsonValue;
    credentialRef: ConversationProviderConnectionStopInputV1['credentialRef'];
    transportOrigin: TOrigin;
    transport: ConnectionTransportFixture;
    overlapSafety: ConversationConnectionOverlapSafetyV1;
    replayContinuity: 'checkpointed' | 'sessionBound' | 'none';
    outboundTextLimit: ConversationOutboundTextLimitV1;
    pairingDeepLinkTemplate?: string;
    sharedEndpointInputModes?: readonly ConversationBindingInputModeV1[];
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
  }>;
}>;

export function createCurrentConversationConnectionFixture<TOrigin extends ConversationConnectionTransportOriginV1 | PluginMachineExecutionOriginV1>(input: Readonly<{
  connectionId: string;
  authority: ConversationConnectionFixtureAuthority<TOrigin>;
  createdAt?: number;
  updatedAt?: number;
  transport?: ConnectionTransportFixture;
  overlapSafety?: ConversationConnectionOverlapSafetyV1;
  replayContinuity?: 'checkpointed' | 'sessionBound' | 'none';
  outboundTextLimit?: ConversationOutboundTextLimitV1;
  pairingDeepLinkTemplate?: string;
  sharedEndpointInputModes?: readonly ConversationBindingInputModeV1[];
  enabled?: boolean;
  deletionState?: 'none' | 'pendingStopReconciliation' | 'finalizingDelete';
  pendingOldTransportStop?: ConversationPendingOldTransportStopV1 | null;
  historyGap?: ConversationConnectionHistoryGapV1 | null;
  providerReadiness?: ConversationConnectionProviderReadinessV1;
  pollFailure?: ConversationConnectionPollFailureV1 | null;
  configurationRevision?: number;
}>): CurrentConversationConnectionFixture<ConversationConnectionTransportOriginV1> {
  const updatedAt = input.updatedAt ?? input.createdAt ?? 1;
  const pending = input.pendingOldTransportStop;
  const transport = input.transport;
  const origin = input.authority.transportOrigin;
  // Older test inputs may describe endpoint custody with predecessor fields.
  // The current fixture always emits the consumed V8 endpoint-intent arm.
  const pendingOldTransportStop = pending !== undefined && pending !== null && !('kind' in pending)
    && pending.predecessorTransportKind === 'durablePush' && pending.endpointRetarget === 'pending'
    ? (() => {
      if (transport?.kind !== 'durablePush' || !('materializationRef' in origin)) throw new Error('Endpoint fixture requires its exact desired materialization.');
      return { kind: 'endpointRetarget' as const, webhookEndpointId: transport.webhookEndpointId,
        webhookContributionRef: transport.webhookContributionRef, webhookSourceInstanceId: transport.webhookSourceInstanceId,
        targetMaterialization: origin.materializationRef, transferAuthorityEpoch: input.authority.authorityEpoch };
    })()
    : pending ?? null;
  const value: CurrentConversationConnectionFixture<ConversationConnectionTransportOriginV1> = {
    id: input.connectionId,
    'record-kind': CHANNEL_STATE_RECORD_KIND.connection,
    v: 1,
    'connection-id': input.connectionId,
    'created-at': input.createdAt ?? 1,
    'updated-at': updatedAt,
    payload: {
      configurationRevision: input.configurationRevision ?? 1,
      providerPluginId: input.authority.providerPluginId,
      providerContributionSelection: input.authority.providerContributionSelection,
      providerSetupInput: input.authority.providerSetupInput,
      credentialRef: input.authority.credentialRef,
      transportOrigin: fixturePlacement(input.authority.transportOrigin),
      transport: input.transport ?? { kind: 'checkpointedPull' },
      overlapSafety: input.overlapSafety ?? 'safe',
      replayContinuity: input.replayContinuity ?? 'checkpointed',
      outboundTextLimit: input.outboundTextLimit ?? { maximum: 4_096, unit: 'unicodeCodePoints' },
      ...(input.pairingDeepLinkTemplate === undefined
        ? {}
        : { pairingDeepLinkTemplate: input.pairingDeepLinkTemplate }),
      ...(input.sharedEndpointInputModes === undefined
        ? {}
        : { sharedEndpointInputModes: input.sharedEndpointInputModes }),
      providerConnectionKey: input.authority.providerConnectionKey,
      providerConfigVersion: 1,
      providerConfig: input.authority.providerConfig,
      routingIdentityKey: input.authority.routingIdentityKey,
      integrationPrincipal: input.authority.integrationPrincipal,
      authorityEpoch: input.authority.authorityEpoch,
      enabled: input.enabled ?? true,
      deletionState: input.deletionState ?? 'none',
      pendingOldTransportStop,
      historyGap: input.historyGap ?? null,
      providerReadiness: input.providerReadiness ?? null,
      pollFailure: input.pollFailure ?? null,
    },
  };
  return { ...withChannelStateDeleteFinalizationDueAt(value), ...value };
}

/**
 * Models retained predecessor rows using the exact original authority, poll
 * basis and request reason. Current delete and transfer producers omit it.
 */
export function createCurrentConversationPendingOldTransportStopFixture<
  TReason extends 'transfer' | 'delete',
>(input: Readonly<{
  connectionId: string;
  authority: ConversationConnectionFixtureAuthority;
  predecessorCheckpointedPollInvocation: Omit<ConversationCheckpointedPollInvocationBasisV1, 'transportOrigin'> & { transportOrigin: ConversationConnectionTransportOriginV1 | PluginMachineExecutionOriginV1 };
  authorityEpoch: number;
  reason: TReason;
  predecessorTransportKind: ConversationTransportKindV1;
  endpointRetarget?: ConversationPendingEndpointRetargetV1;
  overlapSafety: ConversationPendingProviderStopV1['overlapSafety'];
  acceptedPossibleLoss?: boolean;
}>): Omit<ConversationPendingProviderStopV1, 'stopRequest'> & Readonly<{
  stopRequest: Omit<ConversationPendingProviderStopV1['stopRequest'], 'reason'>
    & Readonly<{ reason: TReason }>;
}> {
  return {
    predecessorCheckpointedPollInvocation: { ...input.predecessorCheckpointedPollInvocation, transportOrigin: fixturePlacement(input.predecessorCheckpointedPollInvocation.transportOrigin) },
    transportOrigin: fixturePlacement(input.authority.transportOrigin),
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
    predecessorTransportKind: input.predecessorTransportKind,
    endpointRetarget: input.endpointRetarget ?? 'notRequired',
    overlapSafety: input.overlapSafety,
    acceptedPossibleLoss: input.acceptedPossibleLoss ?? false,
  };
}

function fixturePlacement(origin: ConversationConnectionTransportOriginV1 | PluginMachineExecutionOriginV1): ConversationConnectionTransportOriginV1 {
  return 'machineId' in origin ? origin : getConversationConnectionTransportOrigin(origin);
}

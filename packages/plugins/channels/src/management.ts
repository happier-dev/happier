import {
  PluginError,
  arePluginMachineExecutionOriginsEqual,
  type JsonValue,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import type {
  AdmittedTargetedOperationExecutionHandle,
  PluginActionResultById,
  PluginMachineExecutionOriginV1,
} from '@happier-dev/plugin-sdk/actions';
import {
  ConversationBindingCreateInputV1Schema,
  ConversationBindingDeleteInputV1Schema,
  ConversationBindingReadInputV1Schema,
  ConversationBindingReadResultV1Schema,
  ConversationBindingResolveInputV1Schema,
  ConversationBindingSetEnabledInputV1Schema,
  ConversationBindingTargetRotateInputV1Schema,
  ConversationBindingUpdateInputV1Schema,
  ConversationConnectionCreateInputV1Schema,
  ConversationConnectionDeleteInputV1Schema,
  ConversationConnectionPollRetryInputV1Schema,
  ConversationConnectionPrepareInputV1Schema,
  ConversationConnectionSetEnabledInputV1Schema,
  ConversationConnectionTestResultV1Schema,
  ConversationConnectionTransferInputV1Schema,
  ConversationConnectionUpdateInputV1Schema,
  ConversationDeliveryResolveInputV1Schema,
  ConversationEndpointResolveInputV1Schema,
  ConversationEndpointResolveResultV1Schema,
  ConversationPairingCancelInputV1Schema,
  ConversationPairingCreateInputV1Schema,
  ConversationPairingFinalizeInputV1Schema,
  ConversationProviderConnectionStopInputV1Schema,
  ConversationProviderConnectionStopResultV1Schema,
  ConversationProviderSetupOutcomeV1Schema,
  ConversationPrincipalResolveInputV1Schema,
  ConversationPrincipalResolveResultV1Schema,
  ConversationTransportFactReportInputV1Schema,
  MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
  areConversationEndpointIdentitiesEqual,
  hasCanonicalConversationResolutionCandidateOrderV1,
  type ConversationBindingCreateResultV1,
  type ConversationBindingCreateInputV1,
  type ConversationBindingDeleteInputV1,
  type ConversationBindingDeleteResultV1,
  type ConversationBindingMutationResultV1,
  type ConversationBindingReadInputV1,
  type ConversationBindingReadResultV1,
  type ConversationBindingResolveInputV1,
  type ConversationBindingResolveResultV1,
  type ConversationBindingSetEnabledInputV1,
  type ConversationBindingTargetRotateInputV1,
  type ConversationBindingUpdateInputV1,
  type ConversationBindingUpdateResultV1,
  type ConversationConnectionCreateInputV1,
  type ConversationConnectionDeleteInputV1,
  type ConversationConnectionPollRetryInputV1,
  type ConversationConnectionTransferInputV1,
  type ConversationConnectionTransferResultV1,
  type ConversationProviderConnectionStopInputV1,
  type ConversationConnectionPrepareInputV1,
  type ConversationConnectionPrepareResultV1,
  type ConversationConnectionSetEnabledInputV1,
  type ConversationConnectionUpdateInputV1,
  type ConversationDeliveryResolveInputV1,
  type ConversationPairingCancelInputV1,
  type ConversationPairingCreateInputV1,
  type ConversationPairingFinalizeInputV1,
  type ConversationProviderSetupOutcomeV1,
  type ConversationProviderSetupRemediationV1,
  type ConversationProviderSetupResultV1,
  type ConversationConnectionHistoryGapFactV1,
  type ConversationBindingInputModeV1,
  type ConversationBindingTargetMutationV1,
  type ConversationBindingTargetV1,
  type ConversationBindingV1,
  type ConversationResolvedEndpointV1,
  type ConversationResolvedPrincipalV1,
  type ConversationTransportFactReportResultV1,
} from '@happier-dev/channels-protocol/v1';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_FIXED_ROW_ID,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
  isCanonicalChannelStateRecordIdentity,
} from './collections.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import {
  abandonConversationConnectionStop,
  confirmConversationConnectionStop,
  hasAcceptedConversationTransferLoss,
  recordConversationConnectionHistoryGap,
  recordConversationConnectionProviderReadiness,
  setConversationConnectionEnabled,
  startConversationConnectionDelete,
  startConversationConnectionTransfer,
  transitionConversationConnection,
  type ConversationConnectionAbandonResultV1,
  type ConversationCheckpointedPollInvocationBasisV1,
  type ConversationConnectionEnabledResultV1,
  type ConversationConnectionLifecycleStateV1,
  type ConversationConnectionStopConfirmationResultV1,
  type ConversationDeleteStopRequestV1,
  type ConversationPendingOldTransportStopV1,
  type ConversationTransferStopRequestV1,
} from './connectionLifecycle.js';
import { hasCurrentConversationTransportCaller } from './reconciliation.js';
import {
  transitionConversationBinding,
  type ConversationBindingStateV1,
} from './bindingTransition.js';
import {
  assertConversationApprovalPolicyCanPersist,
  isChannelStateJsonRecord as isJsonRecord,
  ownChannelStateValue as own,
  readConversationBindingManagementRows,
  readConversationIngressAttentionPage,
  readConversationBindingUpdateRow,
  readConversationConnectionUpdateRow,
  mutateConversationConnectionLifecycleInAccountCollection,
  setConversationBindingEnabledInAccountCollection,
  updateConversationBindingPolicyInAccountCollection,
  updateConversationConnectionInAccountCollection,
  withConversationBindingPolicy,
  withConversationConnectionLifecycle,
  type ChannelStateJsonRecord as JsonRecord,
  type ChannelStateRow as StateRow,
  type ConversationBindingUpdateRow,
  type ConversationConnectionUpdateRow,
} from './accountLocalBindingPolicy.js';
import {
  createConversationPairingManager,
  type ConversationPairingCancelResult,
  type ConversationAutomationTargetNotVerifiedResult,
  type ConversationPairingBindingWriteInput,
  type ConversationPairingBindingWriteResult,
} from './pairing.js';
import {
  encodeUnpaddedBase64Url,
  importHmacSha256Key,
  signLengthPrefixedUtf8HmacSha256Base64Url,
  tryDecodeBase64Url,
} from './privateRowIdentity.js';
import {
  createConversationSessionProjectionFrontierRow,
  createConversationSessionProjectionFrontierRowId,
  readConversationSessionProjectionNoHistoryBaseline,
} from './sessionProjection.js';
import {
  deriveConversationSessionRotationRowId,
  prepareConversationIngressObligationForBindingDeletion,
  hasConversationCheckpointedPullBaseline,
  prepareConversationCheckpointTransferFence,
  prepareConversationIngressObligationForConnectionDeletion,
} from './ingress.js';
import {
  resolveConversationOutwardDeliveryCustodyInAccountCollection,
  settleConversationOutwardDeliveriesForBindingDeletion,
  settleConversationOutwardDeliveriesForConnectionDeletion,
} from './outwardDelivery.js';
import {
  readCurrentProviderContributionForPersistedSelection,
  readCurrentProviderContributionWitnessForPersistedSelection,
  readSelectedCurrentProviderContribution,
  type CurrentProviderContributionWitness,
} from './providerContributions.js';

const MAX_CREATE_ID_ATTEMPTS = 4;

export {
  readConversationBindingManagementRows,
  readConversationIngressAttentionPage,
  setConversationBindingEnabledInAccountCollection,
  updateConversationBindingPolicyInAccountCollection,
  updateConversationConnectionInAccountCollection,
};

type ConnectionTransportOrigin = Awaited<
  ReturnType<PluginInvocationContext['services']['actions']['executeAdmittedTargetedOperationWithExecutionOrigin']>
>['executionOrigin'];
type ConversationConnectionCreateResult =
  | Readonly<{ kind: 'created'; connectionId: string }>
  | Readonly<{ kind: 'rejoined'; connectionId: string }>
  | Extract<ProviderConnectionPreparation, Readonly<{ kind: 'notReady' }>>;
type ConversationConnectionTransferResult = ConversationConnectionTransferResultV1;
type ConversationConnectionSetupAndTestInput = Pick<
  ConversationConnectionCreateInputV1,
  'providerSetupInput' | 'credentialRef' | 'selectedTransport'
>;
type CurrentProvider = Readonly<{
  pluginId: string;
  setup: AdmittedTargetedOperationExecutionHandle;
  connectionTest: AdmittedTargetedOperationExecutionHandle;
  observationsPoll: AdmittedTargetedOperationExecutionHandle | undefined;
  connectionStop: AdmittedTargetedOperationExecutionHandle | undefined;
}>;
type ConversationConnectionUpdateResult = Readonly<{
  kind: 'updated' | 'unchanged';
  connectionId: string;
  revision: number;
  authorityEpoch: number;
}>;
type ConversationConnectionPollRetryResult = Readonly<{
  kind: 'retryScheduled';
  connectionId: string;
  revision: number;
  authorityEpoch: number;
}>;
type ConversationDeliveryResolveResult = Readonly<{
  kind: 'resolved';
  custodyId: string;
  revision: number;
  resolution: 'accepted' | 'discarded';
}>;
type ConversationConnectionDeleteResult = Readonly<{
  kind: 'deletePending' | 'deleteFinalizing' | 'rejoined';
  connectionId: string;
  revision: number;
  authorityEpoch: number;
  acceptedPossibleLoss: boolean;
}>;
type ConversationBindingUpdateResult = ConversationBindingUpdateResultV1;
type ConversationBindingCreateResult = ConversationBindingCreateResultV1;
type ConversationBindingTargetMutationResult =
  | ConversationBindingUpdateResult
  | ConversationAutomationTargetNotVerifiedResult;
export type ConversationPairingManager = ReturnType<typeof createConversationPairingManager>;
type ProviderConnectionPreparation =
  | Extract<ReturnType<typeof ConversationConnectionTestResultV1Schema.parse>, Readonly<{ kind: 'notReady' }>>
  | Readonly<{
    kind: 'ready';
    setup: ConversationProviderSetupResultV1;
    transportOrigin: ConnectionTransportOrigin;
  }>;
type ProviderConnectionSetup =
  | ConversationProviderSetupRemediationV1
  | Extract<ProviderConnectionPreparation, Readonly<{ kind: 'ready' }>>;
type ConversationStorageContext = Pick<PluginInvocationContext, 'services' | 'signal'>;
type ChannelStateCollection = ReturnType<PluginAccountStorageScope['collection']>;
type ChannelStateBatchMutation = Parameters<ChannelStateCollection['batch']>[0][number];
type BindingResolutionProvider = CurrentProviderContributionWitness;
type ConversationBindingEndpointSelection = ConversationBindingCreateInputV1['endpointSelection'];
type ConversationBindingResolutionUnavailable = Extract<
  ConversationBindingResolveResultV1,
  Readonly<{ kind: 'unavailable' }>
>;
type ConversationBindingResolutionStale = Extract<
  ConversationBindingResolveResultV1,
  Readonly<{ kind: 'stale' }>
>;
type BindingResolutionConnection = Readonly<{
  kind: 'current';
  connection: ConversationConnectionUpdateRow;
}>;
type BindingResolutionConnectionRead =
  | BindingResolutionConnection
  | ConversationBindingResolutionUnavailable
  | ConversationBindingResolutionStale;
type BindingResolutionTerminal = Exclude<
  ConversationBindingResolveResultV1,
  Readonly<{ kind: 'endpointCandidates' }> | Readonly<{ kind: 'principalCandidates' }>
>;
type BindingEndpointCandidates = Readonly<{
  kind: 'endpointCandidates';
  candidates: readonly ConversationResolvedEndpointV1[];
  witness: BindingResolutionProvider;
}>;
type BindingEndpointResolution = BindingResolutionTerminal | BindingEndpointCandidates;
type BindingPrincipalCandidates = Readonly<{
  kind: 'principalCandidates';
  candidates: readonly ConversationResolvedPrincipalV1[];
  witness: BindingResolutionProvider;
}>;
type BindingPrincipalResolution = BindingResolutionTerminal | BindingPrincipalCandidates;
type BindingResolutionCurrent = BindingResolutionConnection & Readonly<{
  provider: BindingResolutionProvider;
}>;
type BindingAudienceResolution = BindingResolutionTerminal | Readonly<{
  kind: 'ready';
  endpoint: ConversationResolvedEndpointV1;
  allowedPrincipalIds: readonly string[];
  witness: BindingResolutionProvider;
}>;

function pluginError(code: string, message: string, retryable = false): PluginError {
  return new PluginError({ code, message, retryable });
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw pluginError(
    'channels_connection_create_cancelled',
    'Conversation connection setup was cancelled before its Account mutation completed.',
    true,
  );
}

function freezeTransportOrigin(origin: ConnectionTransportOrigin): ConnectionTransportOrigin {
  return Object.freeze({
    serverIdentityId: origin.serverIdentityId,
    materializationRef: Object.freeze({
      pluginId: origin.materializationRef.pluginId,
      machineId: origin.materializationRef.machineId,
      materializationId: origin.materializationRef.materializationId,
    }),
  });
}

/** Maps public action-schema rejection onto the existing stable plugin error codes. */
function readAdmittedActionInput<T>(
  input: JsonValue,
  schema: Readonly<{ parse(value: unknown): T }>,
  code: string,
  message: string,
): T {
  try {
    return schema.parse(input);
  } catch (cause) {
    throw new PluginError({ code, message }, { cause });
  }
}

function readAdmittedConnectionPrepareInput(input: JsonValue): ConversationConnectionPrepareInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationConnectionPrepareInputV1Schema,
    'channels_connection_prepare_input_invalid',
    'Connection preparation input was not admitted by its strict contract.',
  );
}

function readAdmittedConnectionCreateInput(input: JsonValue): ConversationConnectionCreateInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationConnectionCreateInputV1Schema,
    'channels_connection_create_input_invalid',
    'Connection creation input was not admitted by its strict contract.',
  );
}

function readAdmittedConnectionTransferInput(input: JsonValue): ConversationConnectionTransferInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationConnectionTransferInputV1Schema,
    'channels_connection_transfer_input_invalid',
    'Connection transfer input was not admitted by its strict contract.',
  );
}

function readAdmittedConnectionUpdateInput(input: JsonValue): ConversationConnectionUpdateInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationConnectionUpdateInputV1Schema,
    'channels_connection_update_input_invalid',
    'Connection update input was not admitted by its strict contract.',
  );
}

function readAdmittedConnectionSetEnabledInput(input: JsonValue): ConversationConnectionSetEnabledInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationConnectionSetEnabledInputV1Schema,
    'channels_connection_set_enabled_input_invalid',
    'Connection enablement input was not admitted by its strict contract.',
  );
}

/** The present-user retry remains one exact blocked-row CAS; it never invokes a provider. */
function readAdmittedConnectionPollRetryInput(input: JsonValue): ConversationConnectionPollRetryInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationConnectionPollRetryInputV1Schema,
    'channels_connection_poll_retry_input_invalid',
    'Connection poll retry input was not admitted by its strict contract.',
  );
}

function readAdmittedConnectionDeleteInput(input: JsonValue): ConversationConnectionDeleteInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationConnectionDeleteInputV1Schema,
    'channels_connection_delete_input_invalid',
    'Connection deletion input was not admitted by its strict contract.',
  );
}

function readAdmittedConversationDeliveryResolveInput(input: JsonValue): ConversationDeliveryResolveInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationDeliveryResolveInputV1Schema,
    'channels_delivery_resolve_input_invalid',
    'Delivery resolution input was not admitted by its strict contract.',
  );
}

function readAdmittedBindingSetEnabledInput(input: JsonValue): ConversationBindingSetEnabledInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationBindingSetEnabledInputV1Schema,
    'channels_binding_set_enabled_input_invalid',
    'Binding enablement input was not admitted by its strict contract.',
  );
}

function readAdmittedBindingCreateInput(input: JsonValue): ConversationBindingCreateInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationBindingCreateInputV1Schema,
    'channels_binding_create_input_invalid',
    'Binding creation input was not admitted by its strict contract.',
  );
}

function readAdmittedBindingReadInput(input: JsonValue): ConversationBindingReadInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationBindingReadInputV1Schema,
    'channels_binding_read_input_invalid',
    'Binding read input was not admitted by its strict contract.',
  );
}

function assertBindingPrincipalSelectionIdsAreUnique(
  principalSelection: Readonly<{ selected: readonly Readonly<{ id: string }>[] }>,
  operation: 'channels_binding_create' | 'channels_binding_update',
): void {
  const ids = new Set<string>();
  for (const principal of principalSelection.selected) {
    if (ids.has(principal.id)) {
      throw pluginError(
        `${operation}_principal_selection_invalid`,
        'Binding principal selections must not repeat an immutable principal ID.',
      );
    }
    ids.add(principal.id);
  }
}

function readAdmittedBindingDeleteInput(input: JsonValue): ConversationBindingDeleteInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationBindingDeleteInputV1Schema,
    'channels_binding_delete_input_invalid',
    'Binding deletion input was not admitted by its strict contract.',
  );
}

function readAdmittedBindingResolveInput(input: JsonValue): ConversationBindingResolveInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationBindingResolveInputV1Schema,
    'channels_binding_resolve_input_invalid',
    'Binding resolution input was not admitted by its strict contract.',
  );
}

function readAdmittedBindingUpdateInput(input: JsonValue): ConversationBindingUpdateInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationBindingUpdateInputV1Schema,
    'channels_binding_update_input_invalid',
    'Binding update input was not admitted by its strict contract.',
  );
}

function readAdmittedBindingTargetRotateInput(input: JsonValue): ConversationBindingTargetRotateInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationBindingTargetRotateInputV1Schema,
    'channels_binding_target_rotate_input_invalid',
    'Binding target rotation input was not admitted by its strict contract.',
  );
}

function readAdmittedPairingCreateInput(input: JsonValue): ConversationPairingCreateInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationPairingCreateInputV1Schema,
    'channels_pairing_create_input_invalid',
    'Pairing creation input was not admitted by its strict contract.',
  );
}

function readAdmittedPairingFinalizeInput(input: JsonValue): ConversationPairingFinalizeInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationPairingFinalizeInputV1Schema,
    'channels_pairing_finalize_input_invalid',
    'Pairing finalization input was not admitted by its strict contract.',
  );
}

function readAdmittedPairingCancelInput(input: JsonValue): ConversationPairingCancelInputV1 {
  return readAdmittedActionInput(
    input,
    ConversationPairingCancelInputV1Schema,
    'channels_pairing_cancel_input_invalid',
    'Pairing cancellation input must select exactly one unfinished pairing item.',
  );
}

function bindingResolutionUnavailable(
  reason: ConversationBindingResolutionUnavailable['reason'],
): ConversationBindingResolutionUnavailable {
  return { kind: 'unavailable', reason };
}

function bindingResolutionStale(): ConversationBindingResolutionStale {
  return { kind: 'stale' };
}

/** Reads one exact current connection revision before a provider resolver can run. */
async function readCurrentBindingResolutionConnection(input: Readonly<{
  collection: ChannelStateCollection;
  connectionId: string;
  expectedConnectionRevision: number;
  signal: AbortSignal;
}>): Promise<BindingResolutionConnectionRead> {
  assertNotAborted(input.signal);
  const row = await input.collection.get(input.connectionId, { signal: input.signal });
  assertNotAborted(input.signal);
  if (row === null) return bindingResolutionUnavailable('connectionNotFound');
  if (row.revision !== input.expectedConnectionRevision) return bindingResolutionStale();
  const connection = readConversationConnectionUpdateRow({
    row,
    connectionId: input.connectionId,
  });
  if (connection.lifecycle.deletionState !== 'none') {
    return bindingResolutionUnavailable('connectionDeleting');
  }
  return { kind: 'current', connection };
}

/** The provider is sourced only from the current admission snapshot, never a stored Action handle. */
async function readCurrentBindingResolutionProvider(input: Readonly<{
  context: PluginInvocationContext;
  connection: ConversationConnectionUpdateRow;
}>): Promise<BindingResolutionProvider | null> {
  try {
    return await readCurrentProviderContributionWitnessForPersistedSelection({
      context: {
        targetedContributions: input.context.services.targetedContributions,
        signal: input.context.signal,
      },
      providerPluginId: input.connection.providerPluginId,
      providerContributionSelection: input.connection.providerContributionSelection,
    });
  } catch {
    assertNotAborted(input.context.signal);
    return null;
  }
}

function readBindingResolutionAction(
  provider: BindingResolutionProvider,
  role: 'endpointResolve' | 'principalResolve',
): AdmittedTargetedOperationExecutionHandle | undefined {
  return role === 'endpointResolve'
    ? provider.contribution.operations.endpointResolve
    : provider.contribution.operations.principalResolve;
}

function areAdmittedTargetedOperationIdentitiesEqual(
  left: AdmittedTargetedOperationExecutionHandle | undefined,
  right: AdmittedTargetedOperationExecutionHandle | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.identity.target.pluginId === right.identity.target.pluginId
    && left.identity.point.pointId === right.identity.point.pointId
    && left.identity.point.protocol.id === right.identity.point.protocol.id
    && left.identity.point.protocol.version === right.identity.point.protocol.version
    && left.identity.contributor.pluginId === right.identity.contributor.pluginId
    && left.identity.contributor.contributionId === right.identity.contributor.contributionId
    && left.identity.contributor.immutableGenerationId === right.identity.contributor.immutableGenerationId
    && left.identity.role === right.identity.role;
}

function isSameBindingResolutionProvider(input: Readonly<{
  before: BindingResolutionProvider;
  after: BindingResolutionProvider;
}>): boolean {
  return input.before.targetGeneration === input.after.targetGeneration
    && input.before.contribution.contributor.pluginId === input.after.contribution.contributor.pluginId
    && input.before.contribution.contributor.contributionId === input.after.contribution.contributor.contributionId
    && input.before.contribution.contributor.immutableGenerationId
      === input.after.contribution.contributor.immutableGenerationId
    && areAdmittedTargetedOperationIdentitiesEqual(
      readBindingResolutionAction(input.before, 'endpointResolve'),
      readBindingResolutionAction(input.after, 'endpointResolve'),
    )
    && areAdmittedTargetedOperationIdentitiesEqual(
      readBindingResolutionAction(input.before, 'principalResolve'),
      readBindingResolutionAction(input.after, 'principalResolve'),
    );
}

function readEndpointResolveRequest(input: Readonly<{
  connectionId: string;
  connection: ConversationConnectionUpdateRow;
  query: string;
  kinds: ConversationBindingEndpointSelection['kinds'];
}>): ReturnType<typeof ConversationEndpointResolveInputV1Schema.parse> {
  try {
    return ConversationEndpointResolveInputV1Schema.parse({
      v: 1,
      connectionId: input.connectionId,
      providerConnectionKey: own(input.connection.payload, 'providerConnectionKey'),
      providerConfigVersion: own(input.connection.payload, 'providerConfigVersion'),
      providerConfig: own(input.connection.payload, 'providerConfig'),
      credentialRef: own(input.connection.payload, 'credentialRef'),
      query: input.query,
      ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
    });
  } catch (cause) {
    throw new PluginError({
      code: 'channels_binding_resolution_connection_corrupt',
      message: 'Binding resolution could not read the retained provider connection details.',
    }, { cause });
  }
}

function readPrincipalResolveRequest(input: Readonly<{
  connectionId: string;
  connection: ConversationConnectionUpdateRow;
  endpoint: ConversationResolvedEndpointV1;
  query: string;
}>): ReturnType<typeof ConversationPrincipalResolveInputV1Schema.parse> {
  try {
    return ConversationPrincipalResolveInputV1Schema.parse({
      v: 1,
      connectionId: input.connectionId,
      providerConnectionKey: own(input.connection.payload, 'providerConnectionKey'),
      providerConfigVersion: own(input.connection.payload, 'providerConfigVersion'),
      providerConfig: own(input.connection.payload, 'providerConfig'),
      credentialRef: own(input.connection.payload, 'credentialRef'),
      endpoint: input.endpoint,
      query: input.query,
    });
  } catch (cause) {
    throw new PluginError({
      code: 'channels_binding_resolution_connection_corrupt',
      message: 'Binding resolution could not read the retained provider connection details.',
    }, { cause });
  }
}

function readEndpointResolveResult(value: unknown): ReturnType<typeof ConversationEndpointResolveResultV1Schema.parse> {
  try {
    const result = ConversationEndpointResolveResultV1Schema.parse(value);
    if (result.kind === 'resolved'
      && !hasCanonicalConversationResolutionCandidateOrderV1(result.candidates)) {
      throw new Error('Provider endpoint resolution candidates are not canonically ordered.');
    }
    return result;
  } catch (cause) {
    throw new PluginError({
      code: 'channels_binding_endpoint_resolve_result_invalid',
      message: 'Provider endpoint resolution did not return its strict result.',
    }, { cause });
  }
}

function readPrincipalResolveResult(value: unknown): ReturnType<typeof ConversationPrincipalResolveResultV1Schema.parse> {
  try {
    const result = ConversationPrincipalResolveResultV1Schema.parse(value);
    if (result.kind === 'resolved'
      && !hasCanonicalConversationResolutionCandidateOrderV1(result.candidates)) {
      throw new Error('Provider principal resolution candidates are not canonically ordered.');
    }
    return result;
  } catch (cause) {
    throw new PluginError({
      code: 'channels_binding_principal_resolve_result_invalid',
      message: 'Provider principal resolution did not return its strict result.',
    }, { cause });
  }
}

/**
 * Re-read the connection after a provider effect. Any relation change is
 * stale; a provider disappearance remains an explicitly bounded unavailability.
 */
async function rereadBindingResolutionAfterProviderEffect(input: Readonly<{
  collection: ChannelStateCollection;
  connectionId: string;
  expectedConnectionRevision: number;
  context: PluginInvocationContext;
  providerBefore: BindingResolutionProvider;
}>): Promise<BindingResolutionCurrent | ConversationBindingResolutionUnavailable | ConversationBindingResolutionStale> {
  const connectionRead = await readCurrentBindingResolutionConnection({
    collection: input.collection,
    connectionId: input.connectionId,
    expectedConnectionRevision: input.expectedConnectionRevision,
    signal: input.context.signal,
  });
  if (connectionRead.kind !== 'current') return bindingResolutionStale();
  const providerAfter = await readCurrentBindingResolutionProvider({
    context: input.context,
    connection: connectionRead.connection,
  });
  if (providerAfter === null) return bindingResolutionUnavailable('providerUnavailable');
  if (!isSameBindingResolutionProvider({
    before: input.providerBefore,
    after: providerAfter,
  })) return bindingResolutionStale();
  return { ...connectionRead, provider: providerAfter };
}

/** Executes the current endpoint resolver through the connection's exact admitted origin. */
async function resolveBindingEndpointCandidates(input: Readonly<{
  connectionId: string;
  expectedConnectionRevision: number;
  query: string;
  kinds: ConversationBindingEndpointSelection['kinds'];
  context: PluginInvocationContext;
}>): Promise<BindingEndpointResolution> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const connectionRead = await readCurrentBindingResolutionConnection({
    collection,
    connectionId: input.connectionId,
    expectedConnectionRevision: input.expectedConnectionRevision,
    signal: input.context.signal,
  });
  if (connectionRead.kind !== 'current') return connectionRead;

  const provider = await readCurrentBindingResolutionProvider({
    context: input.context,
    connection: connectionRead.connection,
  });
  if (provider === null) return bindingResolutionUnavailable('providerUnavailable');
  const endpointResolve = readBindingResolutionAction(provider, 'endpointResolve');
  if (endpointResolve === undefined) return bindingResolutionUnavailable('endpointResolveUnsupported');

  const execution = await input.context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    endpointResolve,
    readEndpointResolveRequest({
      connectionId: input.connectionId,
      connection: connectionRead.connection,
      query: input.query,
      kinds: input.kinds,
    }),
    {
      signal: input.context.signal,
      expectedExecutionOrigin: connectionRead.connection.transportOrigin,
    },
  );
  assertNotAborted(input.context.signal);

  const reread = await rereadBindingResolutionAfterProviderEffect({
    collection,
    connectionId: input.connectionId,
    expectedConnectionRevision: input.expectedConnectionRevision,
    context: input.context,
    providerBefore: provider,
  });
  if (reread.kind !== 'current') return reread;

  const result = readEndpointResolveResult(execution.result);
  return result.kind === 'notReady'
    ? result
    : { kind: 'endpointCandidates', candidates: result.candidates, witness: reread.provider };
}

/** Resolves principals only after the caller's endpoint selection is freshly re-proven. */
async function resolveBindingPrincipalCandidates(input: Readonly<{
  connectionId: string;
  expectedConnectionRevision: number;
  endpointSelection: ConversationBindingEndpointSelection;
  query: string;
  context: PluginInvocationContext;
}>): Promise<BindingPrincipalResolution> {
  const endpointResolution = await resolveBindingEndpointCandidates({
    connectionId: input.connectionId,
    expectedConnectionRevision: input.expectedConnectionRevision,
    query: input.endpointSelection.query,
    kinds: input.endpointSelection.kinds,
    context: input.context,
  });
  if (endpointResolution.kind !== 'endpointCandidates') return endpointResolution;
  const endpoint = endpointResolution.candidates.find((candidate) => (
    areConversationEndpointIdentitiesEqual(candidate, input.endpointSelection.selected)
  ));
  if (endpoint === undefined) return bindingResolutionStale();

  return await resolveBindingPrincipalCandidatesForEndpoint({
    connectionId: input.connectionId,
    expectedConnectionRevision: input.expectedConnectionRevision,
    endpoint,
    witness: endpointResolution.witness,
    query: input.query,
    context: input.context,
  });
}

/** Uses an endpoint proven immediately before this provider effect. */
async function resolveBindingPrincipalCandidatesForEndpoint(input: Readonly<{
  connectionId: string;
  expectedConnectionRevision: number;
  endpoint: ConversationResolvedEndpointV1;
  witness: BindingResolutionProvider;
  query: string;
  context: PluginInvocationContext;
}>): Promise<BindingPrincipalResolution> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const connectionRead = await readCurrentBindingResolutionConnection({
    collection,
    connectionId: input.connectionId,
    expectedConnectionRevision: input.expectedConnectionRevision,
    signal: input.context.signal,
  });
  if (connectionRead.kind !== 'current') return connectionRead;
  const provider = await readCurrentBindingResolutionProvider({
    context: input.context,
    connection: connectionRead.connection,
  });
  if (provider === null) return bindingResolutionUnavailable('providerUnavailable');
  if (!isSameBindingResolutionProvider({ before: input.witness, after: provider })) {
    return bindingResolutionStale();
  }
  const principalResolve = readBindingResolutionAction(provider, 'principalResolve');
  if (principalResolve === undefined) return bindingResolutionUnavailable('principalResolveUnsupported');

  const execution = await input.context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    principalResolve,
    readPrincipalResolveRequest({
      connectionId: input.connectionId,
      connection: connectionRead.connection,
      endpoint: input.endpoint,
      query: input.query,
    }),
    {
      signal: input.context.signal,
      expectedExecutionOrigin: connectionRead.connection.transportOrigin,
    },
  );
  assertNotAborted(input.context.signal);

  const reread = await rereadBindingResolutionAfterProviderEffect({
    collection,
    connectionId: input.connectionId,
    expectedConnectionRevision: input.expectedConnectionRevision,
    context: input.context,
    providerBefore: provider,
  });
  if (reread.kind !== 'current') return reread;

  const result = readPrincipalResolveResult(execution.result);
  return result.kind === 'notReady'
    ? result
    : { kind: 'principalCandidates', candidates: result.candidates, witness: reread.provider };
}

/**
 * One persisted audience must be selected from the exact current provider
 * candidates. The selection is never treated as a durable provider identity.
 */
async function resolveBindingAudienceSelection(input: Readonly<{
  connectionId: string;
  audienceSelection: NonNullable<ConversationBindingUpdateInputV1['audienceSelection']>;
  context: PluginInvocationContext;
}>): Promise<BindingAudienceResolution> {
  assertBindingPrincipalSelectionIdsAreUnique(
    input.audienceSelection.principalSelection,
    'channels_binding_update',
  );
  const endpointResolution = await resolveBindingEndpointCandidates({
    connectionId: input.connectionId,
    expectedConnectionRevision: input.audienceSelection.expectedConnectionRevision,
    query: input.audienceSelection.endpointSelection.query,
    kinds: input.audienceSelection.endpointSelection.kinds,
    context: input.context,
  });
  if (endpointResolution.kind !== 'endpointCandidates') return endpointResolution;
  const endpoint = endpointResolution.candidates.find((candidate) => (
    areConversationEndpointIdentitiesEqual(
      candidate,
      input.audienceSelection.endpointSelection.selected,
    )
  ));
  if (endpoint === undefined) return bindingResolutionStale();

  const principalResolution = await resolveBindingPrincipalCandidatesForEndpoint({
    connectionId: input.connectionId,
    expectedConnectionRevision: input.audienceSelection.expectedConnectionRevision,
    endpoint,
    witness: endpointResolution.witness,
    query: input.audienceSelection.principalSelection.query,
    context: input.context,
  });
  if (principalResolution.kind !== 'principalCandidates') return principalResolution;
  const allowedPrincipalIds: string[] = [];
  for (const selection of input.audienceSelection.principalSelection.selected) {
    const principal = principalResolution.candidates.find((candidate) => (
      candidate.id === selection.id && candidate.kind === selection.kind
    ));
    if (principal === undefined) return bindingResolutionStale();
    allowedPrincipalIds.push(principal.id);
  }
  return {
    kind: 'ready',
    endpoint,
    allowedPrincipalIds,
    witness: principalResolution.witness,
  };
}

/** Read-only binding setup resolution; private provider connection facts never leave this owner. */
export async function resolveConversationBindingForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationBindingResolveResultV1> {
  const resolveInput = readAdmittedBindingResolveInput(input);
  if (resolveInput.kind === 'endpoint') {
    const resolution = await resolveBindingEndpointCandidates({
      connectionId: resolveInput.connectionId,
      expectedConnectionRevision: resolveInput.expectedConnectionRevision,
      query: resolveInput.query,
      kinds: resolveInput.kinds,
      context,
    });
    return resolution.kind === 'endpointCandidates'
      ? { kind: 'endpointCandidates', candidates: [...resolution.candidates] }
      : resolution;
  }
  const resolution = await resolveBindingPrincipalCandidates({
    connectionId: resolveInput.connectionId,
    expectedConnectionRevision: resolveInput.expectedConnectionRevision,
    endpointSelection: resolveInput.endpointSelection,
    query: resolveInput.query,
    context,
  });
  return resolution.kind === 'principalCandidates'
    ? { kind: 'principalCandidates', candidates: [...resolution.candidates] }
    : resolution;
}

/**
 * Exact retained-binding reader for editor state. A row is not hidden merely
 * because it is finalizing; only an actually absent row is not found.
 */
export async function readConversationBindingForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationBindingReadResultV1> {
  const readInput = readAdmittedBindingReadInput(input);
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(readInput.bindingId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) return { kind: 'notFound' };
  try {
    const current = readConversationBindingUpdateRow({ row, bindingId: readInput.bindingId });
    return ConversationBindingReadResultV1Schema.parse({
      kind: 'ready',
      revision: row.revision,
      binding: current.binding,
    });
  } catch (cause) {
    throw new PluginError({
      code: 'channels_binding_read_corrupt',
      message: 'Binding read target is not a complete valid retained binding.',
    }, { cause });
  }
}

function createDeleteStopRequest(input: Readonly<{
  connectionId: string;
  payload: JsonRecord;
  authorityEpoch: number;
}>): ConversationDeleteStopRequestV1 {
  try {
    const parsed = ConversationProviderConnectionStopInputV1Schema.parse({
      v: 1,
      connectionId: input.connectionId,
      providerConnectionKey: own(input.payload, 'providerConnectionKey'),
      providerConfigVersion: own(input.payload, 'providerConfigVersion'),
      providerConfig: own(input.payload, 'providerConfig'),
      credentialRef: own(input.payload, 'credentialRef'),
      authorityEpoch: input.authorityEpoch,
      reason: 'delete',
    });
    if (parsed.reason !== 'delete') {
      throw new Error('Delete stop request was not admitted as a delete.');
    }
    return { ...parsed, reason: 'delete' };
  } catch (cause) {
    throw new PluginError({
      code: 'channels_connection_delete_corrupt',
      message: 'Connection deletion cannot produce its canonical frozen stop request.',
    }, { cause });
  }
}

function createTransferStopRequest(input: Readonly<{
  connectionId: string;
  payload: JsonRecord;
  authorityEpoch: number;
}>): ConversationTransferStopRequestV1 {
  try {
    const parsed = ConversationProviderConnectionStopInputV1Schema.parse({
      v: 1,
      connectionId: input.connectionId,
      providerConnectionKey: own(input.payload, 'providerConnectionKey'),
      providerConfigVersion: own(input.payload, 'providerConfigVersion'),
      providerConfig: own(input.payload, 'providerConfig'),
      credentialRef: own(input.payload, 'credentialRef'),
      authorityEpoch: input.authorityEpoch,
      reason: 'transfer',
    });
    if (parsed.reason !== 'transfer') {
      throw new Error('Transfer stop request was not admitted as a transfer.');
    }
    return { ...parsed, reason: 'transfer' };
  } catch (cause) {
    throw new PluginError({
      code: 'channels_connection_transfer_corrupt',
      message: 'Connection transfer cannot produce its canonical frozen old-stop request.',
    }, { cause });
  }
}

function hasSamePersistedProviderContributionSelection(input: Readonly<{
  persisted: ConversationConnectionUpdateRow['providerContributionSelection'];
  requested: ConversationConnectionTransferInputV1['providerSelection'];
}>): boolean {
  return input.persisted.contributionId === input.requested.contributor.contributionId
    && input.persisted.immutableGenerationId === input.requested.contributor.immutableGenerationId;
}

function readTransferTransportKind(current: ConversationConnectionUpdateRow): 'checkpointedPull' | 'socket' {
  const transport = own(current.payload, 'transport');
  if (!isJsonRecord(transport)
    || (transport.kind !== 'checkpointedPull' && transport.kind !== 'socket')) {
    throw pluginError(
      'channels_connection_transfer_transport_unsupported',
      'Connection transfer supports only the existing checkpointed-pull and socket transports.',
    );
  }
  return transport.kind;
}

function readTransferImmutableConnectionIdentity(current: ConversationConnectionUpdateRow): Readonly<{
  providerConnectionKey: string;
  integrationPrincipalId: string;
}> {
  const providerConnectionKey = own(current.payload, 'providerConnectionKey');
  const integrationPrincipal = own(current.payload, 'integrationPrincipal');
  if (typeof providerConnectionKey !== 'string'
    || !isJsonRecord(integrationPrincipal)
    || typeof integrationPrincipal.id !== 'string') {
    throw pluginError(
      'channels_connection_transfer_corrupt',
      'Connection transfer could not read the retained immutable provider identity.',
    );
  }
  return { providerConnectionKey, integrationPrincipalId: integrationPrincipal.id };
}

function isRequestedTransferAlreadyCurrent(input: Readonly<{
  current: ConversationConnectionUpdateRow;
  transferInput: ConversationConnectionTransferInputV1;
}>): boolean {
  const transport = own(input.current.payload, 'transport');
  return input.current.lifecycle.deletionState === 'none'
    && input.current.providerPluginId === input.transferInput.providerSelection.contributor.pluginId
    && hasSamePersistedProviderContributionSelection({
      persisted: input.current.providerContributionSelection,
      requested: input.transferInput.providerSelection,
    })
    && pluginJsonValuesEqual(input.current.providerSetupInput, input.transferInput.providerSetupInput)
    && own(input.current.payload, 'credentialRef') !== undefined
    && pluginJsonValuesEqual(
      own(input.current.payload, 'credentialRef')!,
      input.transferInput.credentialRef,
    )
    && isJsonRecord(transport)
    && transport.kind === input.transferInput.selectedTransport;
}

/** A lost transfer response may rejoin only the one immediate committed transfer CAS. */
function isImmediateLostTransferCommit(input: Readonly<{
  row: StateRow;
  current: ConversationConnectionUpdateRow;
  transferInput: ConversationConnectionTransferInputV1;
}>): boolean {
  const pending = input.current.lifecycle.pendingOldTransportStop;
  return input.transferInput.expectedRevision < Number.MAX_SAFE_INTEGER
    && input.row.revision === input.transferInput.expectedRevision + 1
    && isRequestedTransferAlreadyCurrent({
      current: input.current,
      transferInput: input.transferInput,
    })
    && pending !== null
    && pending.stopRequest.reason === 'transfer'
    && pending.stopRequest.connectionId === input.transferInput.connectionId
    && pending.stopRequest.authorityEpoch === input.current.lifecycle.authorityEpoch;
}

function assertTransferStartAccepted(input: ReturnType<typeof startConversationConnectionTransfer>): Extract<
  ReturnType<typeof startConversationConnectionTransfer>,
  Readonly<{ kind: 'transferPendingOldStop' }>
> {
  if (input.kind === 'transferPendingOldStop') return input;
  switch (input.code) {
    case 'deleteInProgress':
      throw pluginError(
        'channels_connection_transfer_delete_in_progress',
        'Connection transfer cannot replace a connection while deletion is in progress.',
        true,
      );
    case 'oldTransportStopPending':
      throw pluginError(
        'channels_connection_transfer_old_transport_stop_pending',
        'Connection transfer is blocked by unresolved old-transport stop custody.',
        true,
      );
    case 'authorityEpochExhausted':
      throw pluginError(
        'channels_connection_transfer_authority_epoch_exhausted',
        'Connection transfer cannot advance this connection authority further.',
      );
    case 'stopRequestInvalid':
      throw pluginError(
        'channels_connection_transfer_stop_request_invalid',
        'Connection transfer could not freeze its exact old-stop request.',
      );
  }
}

/** Verifies the current retained facts still reproduce the one frozen stop request. */
function hasExactCurrentStopRequest(input: Readonly<{
  connectionId: string;
  payload: JsonRecord;
  authorityEpoch: number;
  pendingOldTransportStop: ConversationPendingOldTransportStopV1;
}>): boolean {
  const { stopRequest } = input.pendingOldTransportStop;
  if (stopRequest.reason !== 'delete') return false;
  const current = createDeleteStopRequest({
    connectionId: input.connectionId,
    payload: input.payload,
    authorityEpoch: input.authorityEpoch,
  });
  return current.v === stopRequest.v
    && current.connectionId === stopRequest.connectionId
    && current.providerConnectionKey === stopRequest.providerConnectionKey
    && current.providerConfigVersion === stopRequest.providerConfigVersion
    && pluginJsonValuesEqual(current.providerConfig, stopRequest.providerConfig)
    && pluginJsonValuesEqual(current.credentialRef, stopRequest.credentialRef)
    && current.authorityEpoch === stopRequest.authorityEpoch
    && current.reason === stopRequest.reason;
}

function sameStringSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameConversationBindingTarget(
  left: ConversationBindingTargetV1,
  right: ConversationBindingTargetV1,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'automation' && right.kind === 'automation') {
    return left.automationId === right.automationId
      && left.templateVersion === right.templateVersion
      && left.policy.resultDelivery === right.policy.resultDelivery;
  }
  if (left.kind !== 'session' || right.kind !== 'session') return false;
  if (left.sessionId !== right.sessionId
    || left.policy.deliveryMode !== right.policy.deliveryMode
    || left.policy.permissionCeiling !== right.policy.permissionCeiling
    || left.policy.approvals.kind !== right.policy.approvals.kind
    || left.policy.newSession.kind !== right.policy.newSession.kind) {
    return false;
  }
  if (left.policy.approvals.kind === 'enabled'
    && right.policy.approvals.kind === 'enabled'
    && (left.policy.approvals.maximumScope !== right.policy.approvals.maximumScope
      || !sameOptionalStringSequence(left.policy.approvals.principalIds, right.policy.approvals.principalIds))) {
    return false;
  }
  if (left.policy.newSession.kind === 'enabled'
    && right.policy.newSession.kind === 'enabled'
    && (!sameOptionalStringSequence(left.policy.newSession.principalIds, right.policy.newSession.principalIds)
      || !pluginJsonValuesEqual(left.policy.newSession.recipe, right.policy.newSession.recipe))) {
    return false;
  }
  return true;
}

function sameOptionalStringSequence(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : sameStringSequence(left, right);
}

function samePairingBinding(left: ConversationBindingV1, right: ConversationBindingV1): boolean {
  return left.v === right.v
    && left.id === right.id
    && left.connectionId === right.connectionId
    && areConversationEndpointIdentitiesEqual(left.endpoint, right.endpoint)
    && left.endpoint.label === right.endpoint.label
    && left.endpoint.parentLabel === right.endpoint.parentLabel
    && sameConversationBindingTarget(left.target, right.target)
    && sameStringSequence(left.allowedPrincipalIds, right.allowedPrincipalIds)
    && left.allowBotSenders === right.allowBotSenders
    && left.inputMode === right.inputMode
    && left.inboundDebounceMs === right.inboundDebounceMs
    && left.linkPreviewPolicy === right.linkPreviewPolicy
    && left.senderFeedback === right.senderFeedback
    && left.authorityEpoch === right.authorityEpoch
    && left.enabled === right.enabled
    && left.deletionState === right.deletionState;
}

function projectConversationBinding(input: Readonly<{
  row: StateRow;
  bindingId: string;
}>): ConversationBindingV1 {
  const current = readConversationBindingUpdateRow(input);
  const createdAt = own(input.row.value, CHANNEL_STATE_FIELD.createdAt);
  const updatedAt = own(input.row.value, CHANNEL_STATE_FIELD.updatedAt);
  if (own(input.row.value, CHANNEL_STATE_FIELD.version) !== 1
    || typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0
    || typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw pluginError('channels_pairing_binding_corrupt', 'Pairing binding row has invalid immutable metadata.');
  }
  return current.binding;
}

function readPairingConnectionFacts(current: ConversationConnectionUpdateRow): Readonly<{
  materialization: ConnectionTransportOrigin['materializationRef'];
  destinationLabel: string;
  pairingDeepLinkTemplate?: string;
}> {
  const integrationPrincipal = own(current.payload, 'integrationPrincipal');
  const pairingDeepLinkTemplate = own(current.payload, 'pairingDeepLinkTemplate');
  const integrationPrincipalId = isJsonRecord(integrationPrincipal)
    ? own(integrationPrincipal, 'id')
    : undefined;
  if (!isJsonRecord(integrationPrincipal) || typeof integrationPrincipalId !== 'string'
    || (pairingDeepLinkTemplate !== undefined && typeof pairingDeepLinkTemplate !== 'string')) {
    throw pluginError('channels_pairing_connection_corrupt', 'Pairing connection is missing authenticated provider facts.');
  }
  const label = own(integrationPrincipal, 'label');
  return {
    materialization: {
      pluginId: current.transportOrigin.materializationRef.pluginId,
      machineId: current.transportOrigin.materializationRef.machineId,
      materializationId: current.transportOrigin.materializationRef.materializationId,
    },
    destinationLabel: typeof label === 'string' ? label : integrationPrincipalId,
    ...(pairingDeepLinkTemplate === undefined ? {} : { pairingDeepLinkTemplate }),
  };
}

async function assertPairingCheckpointedPullBaseline(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  connection: ConversationConnectionUpdateRow;
}>): Promise<void> {
  const transport = own(input.connection.payload, 'transport');
  const replayContinuity = own(input.connection.payload, 'replayContinuity');
  const transportKind = isJsonRecord(transport) ? own(transport, 'kind') : undefined;
  if (
    (transportKind !== 'checkpointedPull' && transportKind !== 'socket' && transportKind !== 'durablePush')
    || (replayContinuity !== 'checkpointed' && replayContinuity !== 'sessionBound' && replayContinuity !== 'none')
  ) {
    throw pluginError('channels_pairing_connection_corrupt', 'Pairing connection has an invalid replay transport.');
  }
  if (transportKind !== 'checkpointedPull' || replayContinuity !== 'checkpointed') return;
  if (
    input.connection.lifecycle.historyGap !== null
    || !(await hasConversationCheckpointedPullBaseline({
      context: input.context,
      connectionId: input.connectionId,
      routingIdentityKey: input.connection.routingIdentityKey,
    }))
  ) {
    throw pluginError(
      'channels_pairing_connection_baseline_pending',
      'Pairing waits for the selected poll transport to establish its no-history baseline.',
      true,
    );
  }
}

/** The host-stamped generic Action is the sole Automation target and result-delivery verifier in Channels. */
async function verifyAutomationBindingTarget(
  target: Extract<ConversationBindingTargetMutationV1, Readonly<{ kind: 'automation' }>>,
  context: PluginInvocationContext,
): Promise<PluginActionResultById['automation.conversation.target.verify']> {
  const verification: PluginActionResultById['automation.conversation.target.verify'] = await context.services.actions.execute(
    'automation.conversation.target.verify',
    {
      automationId: target.automationId,
      expectedTemplateVersion: target.expectedTemplateVersion,
      ...(target.policy.resultDelivery === 'finalResult'
        ? { resultDelivery: 'finalResult' as const }
        : {}),
    },
    { signal: context.signal },
  );
  assertNotAborted(context.signal);
  return verification;
}

/**
 * Automation owns target currentness and final-result eligibility. Channels
 * passes the exact target preconditions through the host-stamped generic Action
 * and persists only its returned current version.
 */
async function resolveBindingTargetForPersistence(
  target: ConversationBindingTargetMutationV1,
  context: PluginInvocationContext,
): Promise<ConversationBindingTargetV1 | ConversationAutomationTargetNotVerifiedResult> {
  if (target.kind === 'session') {
    assertConversationApprovalPolicyCanPersist(target);
    return target;
  }
  const verification = await verifyAutomationBindingTarget(target, context);
  if (verification.kind === 'notVerified') return verification;
  return {
    kind: 'automation',
    automationId: target.automationId,
    templateVersion: verification.templateVersion,
    policy: target.policy,
  };
}

/** Early pairing verification is feedback only; finalization must reverify. */
async function verifyPairingTargetForFeedback(
  target: ConversationBindingTargetMutationV1,
  context: PluginInvocationContext,
): Promise<ConversationAutomationTargetNotVerifiedResult | null> {
  if (target.kind === 'session') return null;
  const verification = await verifyAutomationBindingTarget(target, context);
  return verification.kind === 'notVerified' ? verification : null;
}

type ConversationBindingRowCreateInput = Readonly<{
  bindingId: string;
  connectionId: string;
  endpoint: ConversationResolvedEndpointV1;
  target: ConversationBindingTargetV1;
  allowedPrincipalIds: readonly string[];
  allowBotSenders: boolean;
  inputMode: ConversationBindingInputModeV1;
  inboundDebounceMs: number;
  linkPreviewPolicy: ConversationBindingV1['linkPreviewPolicy'];
  senderFeedback: ConversationBindingV1['senderFeedback'];
  enabled: boolean;
}>;

/** One canonical row projection backs ordinary binding creation and pairing finalization. */
function createConversationBindingRow(input: ConversationBindingRowCreateInput): Readonly<{
  row: JsonRecord;
  binding: ConversationBindingV1;
}> {
  const now = Date.now();
  const binding: ConversationBindingV1 = {
    v: 1,
    id: input.bindingId,
    connectionId: input.connectionId,
    endpoint: input.endpoint,
    target: input.target,
    allowedPrincipalIds: [...input.allowedPrincipalIds],
    allowBotSenders: input.allowBotSenders,
    inputMode: input.inputMode,
    inboundDebounceMs: input.inboundDebounceMs,
    linkPreviewPolicy: input.linkPreviewPolicy,
    senderFeedback: input.senderFeedback,
    authorityEpoch: 1,
    enabled: input.enabled,
    deletionState: 'none',
    createdAt: now,
    updatedAt: now,
  };
  return {
    binding,
    row: {
      [CHANNEL_STATE_FIELD.id]: binding.id,
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.binding,
      [CHANNEL_STATE_FIELD.version]: binding.v,
      [CHANNEL_STATE_FIELD.connectionId]: binding.connectionId,
      [CHANNEL_STATE_FIELD.bindingId]: binding.id,
      [CHANNEL_STATE_FIELD.createdAt]: binding.createdAt,
      [CHANNEL_STATE_FIELD.updatedAt]: binding.updatedAt,
      payload: {
        endpoint: binding.endpoint,
        target: binding.target,
        allowedPrincipalIds: binding.allowedPrincipalIds,
        allowBotSenders: binding.allowBotSenders,
        inputMode: binding.inputMode,
        inboundDebounceMs: binding.inboundDebounceMs,
        linkPreviewPolicy: binding.linkPreviewPolicy,
        senderFeedback: binding.senderFeedback,
        authorityEpoch: binding.authorityEpoch,
        enabled: binding.enabled,
        deletionState: binding.deletionState,
      },
    },
  };
}

/** New rows validate their mutable policy through the same canonical transition as updates. */
function assertNewConversationBindingCanPersist(binding: ConversationBindingV1): void {
  const validation = transitionConversationBinding({
    current: binding,
    requested: {
      connectionId: binding.connectionId,
      endpoint: binding.endpoint,
      target: binding.target,
      allowedPrincipalIds: binding.allowedPrincipalIds,
      allowBotSenders: binding.allowBotSenders,
      inputMode: binding.inputMode,
      inboundDebounceMs: binding.inboundDebounceMs,
      linkPreviewPolicy: binding.linkPreviewPolicy,
      senderFeedback: binding.senderFeedback,
      enabled: binding.enabled,
    },
  });
  if (validation.kind !== 'rejected') return;
  if (validation.code === 'duplicateAllowedPrincipal') {
    throw pluginError(
      'channels_binding_create_duplicate_allowed_principal',
      'Binding creation requires each allowed principal to be unique.',
    );
  }
  throw pluginError('channels_binding_create_corrupt', 'Binding creation could not preserve the canonical binding relation.');
}

/**
 * Session targets begin at the closed public transcript tail. The caller places
 * this row in its existing binding CAS, so there is never a live target without
 * a matching no-history frontier.
 */
async function createSessionProjectionFrontierForBinding(input: Readonly<{
  bindingId: string;
  target: ConversationBindingTargetV1;
  context: PluginInvocationContext;
}>): Promise<JsonRecord | null> {
  if (input.target.kind !== 'session') return null;
  const baseline = await readConversationSessionProjectionNoHistoryBaseline({
    actions: input.context.services.actions,
    sessionId: input.target.sessionId,
    signal: input.context.signal,
  });
  assertNotAborted(input.context.signal);
  if (baseline.kind !== 'ready') {
    const retryable = baseline.kind === 'retry' || baseline.kind === 'unavailable';
    throw pluginError(
      'channels_binding_session_projection_baseline_unavailable',
      'The Session transcript tail could not be established before binding it to a Conversation Channel.',
      retryable,
    );
  }
  return createConversationSessionProjectionFrontierRow({
    bindingId: input.bindingId,
    targetSessionId: input.target.sessionId,
    transcriptCursor: baseline.transcriptCursor,
    lastScannedSeq: baseline.lastScannedSeq,
    revision: 1,
    now: Date.now(),
  });
}

function didSessionProjectionTargetChange(
  previous: ConversationBindingTargetV1,
  next: ConversationBindingTargetV1,
): boolean {
  return next.kind === 'session'
    && (previous.kind !== 'session' || previous.sessionId !== next.sessionId);
}

function sameMaterialization(
  left: ConnectionTransportOrigin['materializationRef'],
  right: ConversationPairingBindingWriteInput['materialization'],
): boolean {
  return left.pluginId === right.pluginId
    && left.machineId === right.machineId
    && left.materializationId === right.materializationId;
}

function createPairingBindingCandidate(
  input: ConversationPairingBindingWriteInput,
  target: ConversationBindingTargetV1,
) {
  return createConversationBindingRow({
    bindingId: input.bindingId,
    connectionId: input.connectionId,
    endpoint: input.endpoint,
    target,
    allowedPrincipalIds: [input.principalId],
    allowBotSenders: false,
    inputMode: input.endpoint.audience === 'direct' ? 'allAllowedMessages' : 'directMentionsOnly',
    inboundDebounceMs: 750,
    linkPreviewPolicy: 'suppress',
    senderFeedback: 'off',
    enabled: input.enabled,
  });
}

async function writeConversationPairingBinding(
  input: ConversationPairingBindingWriteInput,
  context: PluginInvocationContext,
): Promise<ConversationPairingBindingWriteResult> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const connectionRow = await collection.get(input.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (connectionRow === null || connectionRow.revision !== input.expectedConnectionRevision) {
    return { kind: 'staleConnectionRevision' };
  }
  const connection = readConversationConnectionUpdateRow({ row: connectionRow, connectionId: input.connectionId });
  if (connection.lifecycle.deletionState !== 'none') return { kind: 'staleConnectionRevision' };
  if (!sameMaterialization(connection.transportOrigin.materializationRef, input.materialization)) {
    return { kind: 'wrongMaterialization' };
  }
  // Pairing proposals freeze only a caller precondition. Recheck it after the
  // proposal claim and current connection/materialization checks, immediately
  // before the guarded Account write.
  const target = await resolveBindingTargetForPersistence(input.target, context);
  if (target.kind === 'notVerified') {
    if (input.target.kind !== 'automation') return target;
    // A prior attempt may have committed before its response was lost. The
    // verifier still runs on every finalize attempt, but later target drift
    // cannot hide an already-created row that exactly matches the frozen
    // proposal and its previously verified template version.
    const existing = await collection.get(input.bindingId, { signal: context.signal });
    assertNotAborted(context.signal);
    if (existing === null) return target;
    const rejoined = projectConversationBinding({ row: existing, bindingId: input.bindingId });
    const expected = createPairingBindingCandidate(input, {
      kind: 'automation',
      automationId: input.target.automationId,
      templateVersion: input.target.expectedTemplateVersion,
      policy: input.target.policy,
    });
    return samePairingBinding(rejoined, expected.binding)
      ? { kind: 'rejoined', binding: rejoined }
      : target;
  }
  const candidate = createPairingBindingCandidate(input, target);
  // Pairing is another binding-creation path. Validate the candidate through
  // the same cross-field policy owner before it creates a frontier or writes.
  assertNewConversationBindingCanPersist(candidate.binding);
  const projectionFrontier = await createSessionProjectionFrontierForBinding({
    bindingId: candidate.binding.id,
    target: candidate.binding.target,
    context,
  });
  const result = await collection.batch([
    { kind: 'assert', rowId: input.connectionId, expectedRevision: input.expectedConnectionRevision },
    { kind: 'put', value: candidate.row, expectedRevision: 'absent' },
    ...(projectionFrontier === null
      ? []
      : [{ kind: 'put' as const, value: projectionFrontier, expectedRevision: 'absent' as const }]),
  ], { signal: context.signal });
  assertNotAborted(context.signal);
  if (result.status === 'updated') return { kind: 'created', binding: candidate.binding };

  const existing = await collection.get(input.bindingId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (existing === null) return { kind: 'conflict' };
  const rejoined = projectConversationBinding({ row: existing, bindingId: input.bindingId });
  return samePairingBinding(rejoined, candidate.binding)
    ? { kind: 'rejoined', binding: rejoined }
    : { kind: 'conflict' };
}

export function createConversationPairingManagementHandlers(pairing: ConversationPairingManager) {
  return {
    async create(input: JsonValue, context: PluginInvocationContext) {
      const createInput = readAdmittedPairingCreateInput(input);
      // This is only early user feedback. The frozen mutation deliberately
      // remains unchanged so finalization must reverify after its proposal
      // claim and currentness checks.
      const targetFeedback = await verifyPairingTargetForFeedback(createInput.target, context);
      if (targetFeedback !== null) return targetFeedback;
      const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
      assertNotAborted(context.signal);
      const connectionRow = await collection.get(createInput.connectionId, { signal: context.signal });
      assertNotAborted(context.signal);
      if (connectionRow === null) {
        throw pluginError('channels_pairing_connection_not_found', 'Pairing connection does not exist.');
      }
      if (connectionRow.revision !== createInput.expectedConnectionRevision) {
        throw pluginError('channels_pairing_connection_conflict', 'Pairing creation requires the current connection revision.', true);
      }
      const connection = readConversationConnectionUpdateRow({
        row: connectionRow,
        connectionId: createInput.connectionId,
      });
      if (connection.lifecycle.deletionState !== 'none') {
        throw pluginError('channels_pairing_connection_delete_in_progress', 'Pairing cannot begin while its connection deletion is in progress.');
      }
      await assertPairingCheckpointedPullBaseline({
        context,
        connectionId: createInput.connectionId,
        connection,
      });
      const facts = readPairingConnectionFacts(connection);
      return pairing.createChallenge({
        connectionId: createInput.connectionId,
        expectedConnectionRevision: createInput.expectedConnectionRevision,
        materialization: facts.materialization,
        destinationLabel: facts.destinationLabel,
        ...(facts.pairingDeepLinkTemplate === undefined
          ? {}
          : { pairingDeepLinkTemplate: facts.pairingDeepLinkTemplate }),
        target: createInput.target,
      });
    },

    async finalize(input: JsonValue, context: PluginInvocationContext) {
      const finalizeInput = readAdmittedPairingFinalizeInput(input);
      return await pairing.finalize(
        finalizeInput,
        async (writeInput) => await writeConversationPairingBinding(writeInput, context),
      );
    },

    async cancel(input: JsonValue, _context: PluginInvocationContext): Promise<ConversationPairingCancelResult> {
      const cancelInput = readAdmittedPairingCancelInput(input);
      return 'challengeId' in cancelInput
        ? pairing.cancelChallenge(cancelInput)
        : pairing.cancelProposal(cancelInput);
    },
  };
}

function base64UrlBytes(value: string): Uint8Array {
  const decoded = tryDecodeBase64Url(value);
  if (decoded === null) {
    throw pluginError('channels_connection_identity_key_corrupt', 'Connection identity key is not valid base64url data.');
  }
  return decoded;
}

function randomBase64Url(byteLength: number): string {
  if (globalThis.crypto?.getRandomValues === undefined) {
    throw pluginError('channels_connection_crypto_unavailable', 'The runtime cannot generate a private Channel identity.');
  }
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return encodeUnpaddedBase64Url(bytes);
}

function randomBytes(byteLength: number): Uint8Array {
  if (globalThis.crypto?.getRandomValues === undefined) {
    throw pluginError('channels_pairing_crypto_unavailable', 'The runtime cannot generate a private pairing identity.');
  }
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** One activated manager is shared by present-user pairing Actions and ingress. */
export function createConversationPairingManagerForActivation(): ConversationPairingManager {
  return createConversationPairingManager({
    generationId: `pairing-${randomBase64Url(18)}`,
    now: () => Date.now(),
    randomBytes,
    createId: (kind) => `${kind}-${randomBase64Url(18)}`,
  });
}

function createConnectionId(): string {
  return `connection-${randomBase64Url(18)}`;
}

function createBindingId(): string {
  return `binding-${randomBase64Url(18)}`;
}

async function deriveReservationRowId(input: Readonly<{
  connectionIdentityKey: string;
  providerPluginId: string;
  providerConnectionKey: string;
  signal: AbortSignal;
}>): Promise<string> {
  assertNotAborted(input.signal);
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw pluginError('channels_connection_crypto_unavailable', 'The runtime cannot derive a private Channel reservation identity.');
  }
  const keyBytes = base64UrlBytes(input.connectionIdentityKey);
  if (keyBytes.byteLength !== 32) {
    throw pluginError('channels_connection_identity_key_corrupt', 'Connection identity key has the wrong byte length.');
  }
  const key = await importHmacSha256Key(subtle, keyBytes);
  assertNotAborted(input.signal);
  const reservationRowId = await signLengthPrefixedUtf8HmacSha256Base64Url({
    subtle,
    key,
    parts: [
      'channels:connection-reservation:v1',
      input.providerPluginId,
      input.providerConnectionKey,
    ],
  });
  assertNotAborted(input.signal);
  return reservationRowId;
}

function readConnectionIdentityKey(row: StateRow): string {
  const value = row.value;
  const payload = own(value, 'payload');
  if (row.rowId !== CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey
    || value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.connectionIdentityKey
    || !isJsonRecord(payload)
    || typeof payload.connectionIdentityKey !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(payload.connectionIdentityKey)) {
    throw pluginError('channels_connection_identity_key_corrupt', 'Connection identity key state is malformed.');
  }
  return payload.connectionIdentityKey;
}

async function readExistingConnectionIdentityKey(context: ConversationStorageContext): Promise<string | null> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const existing = await collection.get(CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey, { signal: context.signal });
  assertNotAborted(context.signal);
  return existing === null ? null : readConnectionIdentityKey(existing);
}

async function ensureConnectionIdentityKey(context: PluginInvocationContext): Promise<string> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const existing = await readExistingConnectionIdentityKey(context);
  if (existing !== null) return existing;

  const now = Date.now();
  const candidate = randomBase64Url(32);
  const row = {
    [CHANNEL_STATE_FIELD.id]: CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey,
    [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.connectionIdentityKey,
    [CHANNEL_STATE_FIELD.version]: 1,
    [CHANNEL_STATE_FIELD.createdAt]: now,
    [CHANNEL_STATE_FIELD.updatedAt]: now,
    payload: { connectionIdentityKey: candidate },
  } satisfies JsonRecord;
  try {
    await collection.put(row, { expectedRevision: 'absent', signal: context.signal });
    assertNotAborted(context.signal);
    return candidate;
  } catch (error) {
    assertNotAborted(context.signal);
    if (error instanceof PluginError && error.code === 'collection_quota_incompatible') {
      throw error;
    }
    const rejoined = await collection.get(CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey, { signal: context.signal });
    assertNotAborted(context.signal);
    if (rejoined !== null) return readConnectionIdentityKey(rejoined);
    throw new PluginError({
      code: 'channels_connection_identity_key_unavailable',
      message: 'Connection identity key creation did not settle and could not be re-read.',
      retryable: true,
    }, { cause: error });
  }
}

function readReservationConnectionId(input: Readonly<{
  row: StateRow;
  reservationRowId: string;
  providerPluginId: string;
  providerConnectionKey: string;
  integrationPrincipalId: string;
}>): string {
  const value = input.row.value;
  const payload = own(value, 'payload');
  const connectionId = value[CHANNEL_STATE_FIELD.connectionId];
  if (input.row.rowId !== input.reservationRowId
    || value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.connectionReservation
    || typeof connectionId !== 'string'
    || !isJsonRecord(payload)
    || payload.providerPluginId !== input.providerPluginId
    || payload.providerConnectionKey !== input.providerConnectionKey
    || payload.integrationPrincipalId !== input.integrationPrincipalId) {
    throw pluginError('channels_connection_reservation_corrupt', 'Connection identity reservation does not match setup identity.');
  }
  return connectionId;
}

function assertRejoinedConnection(input: Readonly<{
  row: StateRow | null;
  connectionId: string;
  providerPluginId: string;
  providerConnectionKey: string;
  integrationPrincipalId: string;
}>): void {
  if (input.row === null) {
    throw pluginError('channels_connection_reservation_corrupt', 'Connection identity reservation has no retained connection row.');
  }
  const value = input.row.value;
  const payload = own(value, 'payload');
  if (!isCanonicalChannelStateRecordIdentity({
    rowId: input.row.rowId,
    recordKind: CHANNEL_STATE_RECORD_KIND.connection,
    connectionId: input.connectionId,
  })
    || value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.connection
    || !isJsonRecord(payload)
    || payload.providerPluginId !== input.providerPluginId
    || payload.providerConnectionKey !== input.providerConnectionKey
    || !isJsonRecord(payload.integrationPrincipal)
    || payload.integrationPrincipal.id !== input.integrationPrincipalId) {
    throw pluginError('channels_connection_reservation_corrupt', 'Retained connection row does not match its immutable reservation.');
  }
}

async function readExistingReservation(input: Readonly<{
  context: PluginInvocationContext;
  reservationRowId: string;
  providerPluginId: string;
  providerConnectionKey: string;
  integrationPrincipalId: string;
}>): Promise<string | null> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const reservation = await collection.get(input.reservationRowId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (reservation === null) return null;
  const connectionId = readReservationConnectionId({
    row: reservation,
    reservationRowId: input.reservationRowId,
    providerPluginId: input.providerPluginId,
    providerConnectionKey: input.providerConnectionKey,
    integrationPrincipalId: input.integrationPrincipalId,
  });
  const connection = await collection.get(connectionId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  assertRejoinedConnection({
    row: connection,
    connectionId,
    providerPluginId: input.providerPluginId,
    providerConnectionKey: input.providerConnectionKey,
    integrationPrincipalId: input.integrationPrincipalId,
  });
  return connectionId;
}

async function findExistingConnection(input: Readonly<{
  context: PluginInvocationContext;
  createInput: ConversationConnectionCreateInputV1;
  providerPluginId: string;
  setup: ConversationProviderSetupResultV1;
}>): Promise<string | null> {
  const connectionIdentityKey = await readExistingConnectionIdentityKey(input.context);
  if (connectionIdentityKey === null) return null;
  const reservationRowId = await deriveReservationRowId({
    connectionIdentityKey,
    providerPluginId: input.providerPluginId,
    providerConnectionKey: input.setup.providerConnectionKey,
    signal: input.context.signal,
  });
  return await readExistingReservation({
    context: input.context,
    reservationRowId,
    providerPluginId: input.providerPluginId,
    providerConnectionKey: input.setup.providerConnectionKey,
    integrationPrincipalId: input.setup.integrationPrincipal.id,
  });
}

function connectionRows(input: Readonly<{
  connectionId: string;
  reservationRowId: string;
  createInput: ConversationConnectionCreateInputV1;
  providerPluginId: string;
  setup: ConversationProviderSetupResultV1;
  transportOrigin: ConnectionTransportOrigin;
  now: number;
}>): readonly [JsonRecord, JsonRecord] {
  if (input.providerPluginId !== input.createInput.providerSelection.contributor.pluginId) {
    throw pluginError(
      'channels_connection_provider_selection_mismatch',
      'The current provider must retain the exact selected contribution plugin identity before persistence.',
    );
  }
  const transport: JsonRecord = { kind: input.createInput.selectedTransport };
  const connection = {
    [CHANNEL_STATE_FIELD.id]: input.connectionId,
    [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.connection,
    [CHANNEL_STATE_FIELD.version]: 1,
    [CHANNEL_STATE_FIELD.connectionId]: input.connectionId,
    [CHANNEL_STATE_FIELD.createdAt]: input.now,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      providerPluginId: input.providerPluginId,
      providerContributionSelection: {
        contributionId: input.createInput.providerSelection.contributor.contributionId,
        immutableGenerationId: input.createInput.providerSelection.contributor.immutableGenerationId,
      },
      providerSetupInput: input.createInput.providerSetupInput,
      credentialRef: input.createInput.credentialRef,
      transportOrigin: input.transportOrigin,
      transport,
      overlapSafety: input.setup.overlapSafety,
      replayContinuity: input.setup.replayContinuity,
      outboundTextLimit: input.setup.outboundTextLimit,
      ...(input.setup.pairingDeepLinkTemplate === undefined
        ? {}
        : { pairingDeepLinkTemplate: input.setup.pairingDeepLinkTemplate }),
      providerConnectionKey: input.setup.providerConnectionKey,
      providerConfigVersion: input.setup.providerConfigVersion,
      providerConfig: input.setup.providerConfig,
      routingIdentityKey: randomBase64Url(32),
      integrationPrincipal: input.setup.integrationPrincipal,
      authorityEpoch: 1,
      enabled: true,
      deletionState: 'none',
      pendingOldTransportStop: null,
      historyGap: null,
      providerReadiness: null,
      pollFailure: null,
      maximumObservationAgeMs: input.createInput.maximumObservationAgeMs,
    },
  } satisfies JsonRecord;
  const reservation = {
    [CHANNEL_STATE_FIELD.id]: input.reservationRowId,
    [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.connectionReservation,
    [CHANNEL_STATE_FIELD.version]: 1,
    [CHANNEL_STATE_FIELD.connectionId]: input.connectionId,
    [CHANNEL_STATE_FIELD.createdAt]: input.now,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      providerPluginId: input.providerPluginId,
      providerConnectionKey: input.setup.providerConnectionKey,
      integrationPrincipalId: input.setup.integrationPrincipal.id,
    },
  } satisfies JsonRecord;
  return [reservation, connection];
}

async function createOrRejoinConnection(input: Readonly<{
  context: PluginInvocationContext;
  createInput: ConversationConnectionCreateInputV1;
  providerPluginId: string;
  setup: ConversationProviderSetupResultV1;
  transportOrigin: ConnectionTransportOrigin;
}>): Promise<Extract<ConversationConnectionCreateResult, Readonly<{ kind: 'created' | 'rejoined' }>>> {
  const connectionIdentityKey = await ensureConnectionIdentityKey(input.context);
  const reservationRowId = await deriveReservationRowId({
    connectionIdentityKey,
    providerPluginId: input.providerPluginId,
    providerConnectionKey: input.setup.providerConnectionKey,
    signal: input.context.signal,
  });
  const existing = await readExistingReservation({
    context: input.context,
    reservationRowId,
    providerPluginId: input.providerPluginId,
    providerConnectionKey: input.setup.providerConnectionKey,
    integrationPrincipalId: input.setup.integrationPrincipal.id,
  });
  if (existing !== null) return { kind: 'rejoined', connectionId: existing };

  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  for (let attempt = 0; attempt < MAX_CREATE_ID_ATTEMPTS; attempt += 1) {
    assertNotAborted(input.context.signal);
    const connectionId = createConnectionId();
    const [reservation, connection] = connectionRows({
      connectionId,
      reservationRowId,
      createInput: input.createInput,
      providerPluginId: input.providerPluginId,
      setup: input.setup,
      transportOrigin: input.transportOrigin,
      now: Date.now(),
    });
    const result = await collection.batch([
      { kind: 'put', value: reservation, expectedRevision: 'absent' },
      { kind: 'put', value: connection, expectedRevision: 'absent' },
    ], { signal: input.context.signal });
    assertNotAborted(input.context.signal);
    if (result.status === 'updated') return { kind: 'created', connectionId };

    let reservationTombstoneRevision: number | undefined;
    for (const conflict of result.conflicts) {
      const revision = conflict.revision;
      if (conflict.rowId !== reservationRowId
        || conflict.deleted !== true
        || typeof revision !== 'number'
        || !Number.isSafeInteger(revision)
        || revision < 1) continue;
      reservationTombstoneRevision = revision;
      break;
    }
    if (reservationTombstoneRevision !== undefined) {
      // A generic Data tombstone still owns uniqueness during its offline-writer
      // window. Reuse only that opaque reservation row at its exact revision;
      // the accompanying connection remains a fresh absent row, so no retired
      // routing identity or dependent binding can be resurrected.
      const recreated = await collection.batch([
        { kind: 'put', value: reservation, expectedRevision: reservationTombstoneRevision },
        { kind: 'put', value: connection, expectedRevision: 'absent' },
      ], { signal: input.context.signal });
      assertNotAborted(input.context.signal);
      if (recreated.status === 'updated') return { kind: 'created', connectionId };
    }

    const rejoined = await readExistingReservation({
      context: input.context,
      reservationRowId,
      providerPluginId: input.providerPluginId,
      providerConnectionKey: input.setup.providerConnectionKey,
      integrationPrincipalId: input.setup.integrationPrincipal.id,
    });
    if (rejoined !== null) return { kind: 'rejoined', connectionId: rejoined };
  }
  throw pluginError(
    'channels_connection_create_conflict',
    'Connection setup repeatedly conflicted before an authoritative connection could be created or re-read.',
    true,
  );
}

function parseProviderSetupOutcome(value: unknown): ConversationProviderSetupOutcomeV1 {
  try {
    return ConversationProviderSetupOutcomeV1Schema.parse(value);
  } catch (cause) {
    throw new PluginError({
      code: 'channels_connection_setup_result_invalid',
      message: 'Provider setup returned an invalid Connection setup result.',
    }, { cause });
  }
}

function providerFromSelectedContribution(input: Awaited<
  ReturnType<typeof readSelectedCurrentProviderContribution>
>): CurrentProvider {
  return {
    pluginId: input.contributor.pluginId,
    setup: input.operations.setup,
    connectionTest: input.operations.connectionTest,
    observationsPoll: input.operations.observationsPoll,
    connectionStop: input.operations.connectionStop,
  };
}

async function readCurrentSelectedProvider(input: Readonly<{
  context: PluginInvocationContext;
  selection: ConversationConnectionPrepareInputV1['providerSelection'];
}>): Promise<CurrentProvider> {
  return providerFromSelectedContribution(await readSelectedCurrentProviderContribution({
    context: {
      targetedContributions: input.context.services.targetedContributions,
      signal: input.context.signal,
    },
    selection: input.selection,
  }));
}

function assertProviderExecutionOrigin(input: Readonly<{
  provider: CurrentProvider;
  executionOrigin: ConnectionTransportOrigin;
  operation: 'setup' | 'connectionTest';
}>): void {
  if (input.executionOrigin.materializationRef.pluginId === input.provider.pluginId) return;
  throw pluginError(
    'channels_connection_execution_origin_provider_mismatch',
    `The selected provider ${input.operation} Action settled under another plugin's materialization.`,
  );
}

function assertProviderSetupTransportFacts(
  setup: ConversationProviderSetupResultV1,
): void {
  const hasDurablePush = setup.supportedTransports.includes('durablePush');
  if (!setup.supportedTransports.includes(setup.recommendedTransport)) {
    throw pluginError(
      'channels_connection_setup_result_invalid',
      'Provider setup recommended a transport it did not declare as supported.',
    );
  }
  if (hasDurablePush && (
    setup.overlapSafety !== 'safe'
    || setup.replayContinuity !== 'none'
    || setup.webhookContributionRef === undefined
  )) {
    throw pluginError(
      'channels_connection_setup_result_invalid',
      'Durable-push setup requires safe overlap, no replay continuity, and a webhook contribution.',
    );
  }
  if (!hasDurablePush && setup.webhookContributionRef !== undefined) {
    throw pluginError(
      'channels_connection_setup_result_invalid',
      'Provider setup may declare a webhook contribution only for durable push.',
    );
  }
}

async function runProviderSetup(input: Readonly<{
  context: PluginInvocationContext;
  provider: CurrentProvider;
  providerSetupInput: JsonValue;
  credentialRef: ConversationConnectionPrepareInputV1['credentialRef'];
}>): Promise<ProviderConnectionSetup> {
  assertNotAborted(input.context.signal);
  const setupExecution = await input.context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    input.provider.setup,
    input.providerSetupInput,
    {
      signal: input.context.signal,
      // The UI selector returned this exact outer reference separately from
      // the stripped provider input. A carrier-bound targeted Action may only
      // reconstruct that same reference before the provider parser runs.
      expectedSelectedConnectedAccountRef: input.credentialRef,
    },
  );
  const outcome = parseProviderSetupOutcome(setupExecution.result);
  assertNotAborted(input.context.signal);
  if ('kind' in outcome) return outcome;
  assertProviderSetupTransportFacts(outcome);
  if (!pluginJsonValuesEqual(outcome.credentialRef, input.credentialRef)) {
    throw pluginError(
      'channels_connection_credential_mismatch',
      'Provider setup did not echo the exact selected Connected Account reference.',
    );
  }
  if (outcome.webhookContributionRef !== undefined
    && outcome.webhookContributionRef.pluginId !== input.provider.pluginId) {
    throw pluginError(
      'channels_connection_webhook_contribution_mismatch',
      'Provider setup returned a webhook contribution owned by another plugin.',
    );
  }
  const setupTransportOrigin = freezeTransportOrigin(setupExecution.executionOrigin);
  assertProviderExecutionOrigin({
    provider: input.provider,
    executionOrigin: setupTransportOrigin,
    operation: 'setup',
  });
  assertNotAborted(input.context.signal);
  return { kind: 'ready', setup: outcome, transportOrigin: setupTransportOrigin };
}

/**
 * A selected non-durable transport must retain its matching lifecycle role
 * before setup can create external state. The selected current contribution is
 * the only role-map authority; setup output cannot manufacture a missing role.
 */
function assertSelectedTransportRoleAvailable(input: Readonly<{
  provider: CurrentProvider;
  selectedTransport: ConversationConnectionCreateInputV1['selectedTransport'];
}>): void {
  const requiredOperation = input.selectedTransport === 'socket' ? 'connectionStop' : 'observationsPoll';
  const operation = input.selectedTransport === 'socket'
    ? input.provider.connectionStop
    : input.provider.observationsPoll;
  if (operation !== undefined) return;
  throw new PluginError({
    code: 'channels_connection_transport_role_unavailable',
    message: `The selected ${input.selectedTransport} transport requires the current provider ${requiredOperation} role.`,
    details: {
      selectedTransport: input.selectedTransport,
      requiredOperation,
    },
  });
}

async function runProviderSetupAndTest(input: Readonly<{
  context: PluginInvocationContext;
  setupInput: ConversationConnectionSetupAndTestInput;
  provider: CurrentProvider;
  connectionIdForTest: string;
}>): Promise<ProviderConnectionPreparation> {
  assertSelectedTransportRoleAvailable({
    provider: input.provider,
    selectedTransport: input.setupInput.selectedTransport,
  });
  const prepared = await runProviderSetup({
    context: input.context,
    provider: input.provider,
    providerSetupInput: input.setupInput.providerSetupInput,
    credentialRef: input.setupInput.credentialRef,
  });
  if (prepared.kind === 'requiresRemediation') {
    throw pluginError(
      'channels_connection_setup_requires_remediation',
      'Provider setup requires remediation before connection creation.',
    );
  }
  if (!prepared.setup.supportedTransports.includes(input.setupInput.selectedTransport)) {
    return { kind: 'notReady', reason: 'unsupported' };
  }
  // Setup and connection test are separate provider effects. Preserve the
  // invocation cancellation boundary between them so a completed setup cannot
  // start a later test after its owner has withdrawn authority.
  assertNotAborted(input.context.signal);
  const testExecution = await input.context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    input.provider.connectionTest,
    {
      v: 1,
      connectionId: input.connectionIdForTest,
      providerConnectionKey: prepared.setup.providerConnectionKey,
      providerConfigVersion: prepared.setup.providerConfigVersion,
      providerConfig: prepared.setup.providerConfig,
      credentialRef: input.setupInput.credentialRef,
      selectedTransport: input.setupInput.selectedTransport,
    },
    { signal: input.context.signal },
  );
  let testResult: ReturnType<typeof ConversationConnectionTestResultV1Schema.parse>;
  try {
    testResult = ConversationConnectionTestResultV1Schema.parse(testExecution.result);
  } catch (cause) {
    throw new PluginError({
      code: 'channels_connection_test_result_invalid',
      message: 'Provider connection test returned an invalid result.',
    }, { cause });
  }
  assertNotAborted(input.context.signal);
  const testTransportOrigin = freezeTransportOrigin(testExecution.executionOrigin);
  assertProviderExecutionOrigin({
    provider: input.provider,
    executionOrigin: testTransportOrigin,
    operation: 'connectionTest',
  });
  if (!arePluginMachineExecutionOriginsEqual(prepared.transportOrigin, testTransportOrigin)) {
    throw pluginError(
      'channels_connection_execution_origin_mismatch',
      'Provider setup and connection test did not settle at the same current execution origin.',
    );
  }
  if (testResult.kind === 'notReady') return testResult;
  if (testResult.providerConnectionKey !== prepared.setup.providerConnectionKey
    || testResult.integrationPrincipal.id !== prepared.setup.integrationPrincipal.id) {
    throw pluginError(
      'channels_connection_test_identity_mismatch',
      'Provider setup and connection test disagreed about immutable connection identity.',
    );
  }
  return prepared;
}

/**
 * C2's non-persisting preparation owner. It observes provider setup only and
 * projects safe transport facts without allocating or retaining connection state.
 */
export async function prepareConversationConnectionForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionPrepareResultV1> {
  const prepareInput = readAdmittedConnectionPrepareInput(input);
  const provider = await readCurrentSelectedProvider({
    context,
    selection: prepareInput.providerSelection,
  });
  const prepared = await runProviderSetup({
    context,
    provider,
    providerSetupInput: prepareInput.providerSetupInput,
    credentialRef: prepareInput.credentialRef,
  });
  if (prepared.kind === 'requiresRemediation') return prepared;
  return {
    kind: 'ready',
    supportedTransports: prepared.setup.supportedTransports,
    recommendedTransport: prepared.setup.recommendedTransport,
    overlapSafety: prepared.setup.overlapSafety,
    replayContinuity: prepared.setup.replayContinuity,
    outboundTextLimit: prepared.setup.outboundTextLimit,
    ...(prepared.setup.integrationPrincipal.label === undefined
      ? {}
      : { destinationLabel: prepared.setup.integrationPrincipal.label }),
  };
}

/** One retained-row CAS owner for the lifecycle-only management operations. */
async function mutateConversationConnectionLifecycle(input: Readonly<{
  connectionId: string;
  expectedRevision: number;
  operation: 'channels_connection_update' | 'channels_connection_set_enabled';
  transition: (
    current: ConversationConnectionLifecycleStateV1,
    now: number,
  ) => ConversationConnectionEnabledResultV1;
}>, context: PluginInvocationContext): Promise<ConversationConnectionUpdateResult> {
  return await mutateConversationConnectionLifecycleInAccountCollection({
    collection: requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION),
    ...input,
    signal: context.signal,
    assertCurrent: () => assertNotAborted(context.signal),
  });
}

/**
 * C2's in-place connection policy owner. It changes only Account-local
 * lifecycle fields in the retained row and never re-runs setup, pairing, or
 * transport materialization for ordinary policy edits.
 */
export async function updateConversationConnectionForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionUpdateResult> {
  const updateInput = readAdmittedConnectionUpdateInput(input);
  return await mutateConversationConnectionLifecycle({
    connectionId: updateInput.connectionId,
    expectedRevision: updateInput.expectedRevision,
    operation: 'channels_connection_update',
    transition: (current, now) => transitionConversationConnection({
      current,
      requested: {
        enabled: updateInput.enabled,
        maximumObservationAgeMs: updateInput.maximumObservationAgeMs,
      },
      now,
    }),
  }, context);
}

/**
 * The narrow enable/disable Action uses the same lifecycle CAS as ordinary
 * policy edits but cannot carry a freshness-policy or provider mutation.
 */
export async function setConversationConnectionEnabledForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionUpdateResult> {
  const setEnabledInput = readAdmittedConnectionSetEnabledInput(input);
  const result = await mutateConversationConnectionLifecycle({
    connectionId: setEnabledInput.connectionId,
    expectedRevision: setEnabledInput.expectedRevision,
    operation: 'channels_connection_set_enabled',
    transition: (current) => setConversationConnectionEnabled({
      current,
      enabled: setEnabledInput.enabled,
    }),
  }, context);
  if (setEnabledInput.enabled || result.kind !== 'updated') return result;

  // Direct Account-local callers end at the shared CAS above. The mounted
  // Action alone owns this best-effort online effect, and only after rereading
  // the exact persisted revision that the lifecycle owner just committed.
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const row = await collection.get(setEnabledInput.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null || row.revision !== result.revision) return result;
  const current = readConversationConnectionUpdateRow({ row, connectionId: setEnabledInput.connectionId });
  const transport = own(current.payload, 'transport');
  if (!isJsonRecord(transport) || transport.kind !== 'socket'
    || current.lifecycle.enabled
    || current.lifecycle.deletionState !== 'none'
    || current.lifecycle.pendingOldTransportStop !== null
    || current.lifecycle.authorityEpoch !== result.authorityEpoch
    || current.transportOrigin.materializationRef.pluginId !== current.providerPluginId) {
    return result;
  }
  const provider = await readCurrentProviderContributionForPersistedSelection({
    context: {
      targetedContributions: context.services.targetedContributions,
      signal: context.signal,
    },
    providerPluginId: current.providerPluginId,
    providerContributionSelection: current.providerContributionSelection,
  }).catch((cause) => {
    if (context.signal.aborted) throw cause;
    return undefined;
  });
  const stop = provider?.operations.connectionStop;
  if (stop === undefined) return result;
  let stopRequest: ConversationProviderConnectionStopInputV1;
  try {
    stopRequest = ConversationProviderConnectionStopInputV1Schema.parse({
      v: 1,
      connectionId: setEnabledInput.connectionId,
      providerConnectionKey: own(current.payload, 'providerConnectionKey'),
      providerConfigVersion: own(current.payload, 'providerConfigVersion'),
      providerConfig: own(current.payload, 'providerConfig'),
      credentialRef: own(current.payload, 'credentialRef'),
      authorityEpoch: current.lifecycle.authorityEpoch,
      reason: 'disable',
    });
  } catch {
    return result;
  }
  try {
    await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(stop, stopRequest, {
      signal: context.signal,
      expectedExecutionOrigin: current.transportOrigin,
    });
    assertNotAborted(context.signal);
  } catch (cause) {
    if (context.signal.aborted) throw cause;
  }
  return result;
}

/**
 * A blocked provider poll can be retried only by the user holding the exact
 * current connection revision and authority epoch. This clears no other
 * lifecycle field and deliberately performs no provider Action.
 */
export async function retryConversationConnectionPollForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionPollRetryResult> {
  const request = readAdmittedConnectionPollRetryInput(input);
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(request.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null || row.revision !== request.expectedRevision) {
    throw pluginError(
      'channels_connection_poll_retry_conflict',
      'The blocked connection poll state changed before retry.',
      true,
    );
  }
  const current = readConversationConnectionUpdateRow({ row, connectionId: request.connectionId });
  if (
    current.lifecycle.authorityEpoch !== request.authorityEpoch
    || current.lifecycle.pollFailure?.phase !== 'blocked'
  ) {
    throw pluginError(
      'channels_connection_poll_retry_conflict',
      'The blocked connection poll state changed before retry.',
      true,
    );
  }
  const value = withConversationConnectionLifecycle({
    row,
    current,
    lifecycle: {
      ...current.lifecycle,
      pollFailure: null,
    },
  });
  let persistedRevision: number | undefined;
  try {
    const result = await collection.batch([
      { kind: 'put', value, expectedRevision: row.revision },
    ], { signal: context.signal });
    assertNotAborted(context.signal);
    if (result.status === 'conflict') {
      throw pluginError(
        'channels_connection_poll_retry_conflict',
        'The blocked connection poll state changed before retry.',
        true,
      );
    }
    persistedRevision = result.results.find((entry) => (
      entry.rowId === request.connectionId && entry.deleted === false
    ))?.revision;
  } catch (cause) {
    assertNotAborted(context.signal);
    if (cause instanceof PluginError) throw cause;
  }
  if (persistedRevision !== undefined) {
    return {
      kind: 'retryScheduled',
      connectionId: request.connectionId,
      revision: persistedRevision,
      authorityEpoch: request.authorityEpoch,
    };
  }
  const reread = await collection.get(request.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (reread !== null) {
    const settled = readConversationConnectionUpdateRow({ row: reread, connectionId: request.connectionId });
    if (
      settled.lifecycle.authorityEpoch === request.authorityEpoch
      && settled.lifecycle.pollFailure === null
    ) {
      return {
        kind: 'retryScheduled',
        connectionId: request.connectionId,
        revision: reread.revision,
        authorityEpoch: request.authorityEpoch,
      };
    }
  }
  throw pluginError(
    'channels_connection_poll_retry_result_invalid',
    'The connection poll retry did not return or retain its cleared row.',
    true,
  );
}

async function persistConversationConnectionLifecycle(input: Readonly<{
  collection: ChannelStateCollection;
  row: StateRow;
  current: ConversationConnectionUpdateRow;
  lifecycle: ConversationConnectionLifecycleStateV1;
  operation: string;
}>, context: PluginInvocationContext): Promise<number> {
  const result = await input.collection.batch([
    {
      kind: 'put',
      value: withConversationConnectionLifecycle({
        row: input.row,
        current: input.current,
        lifecycle: input.lifecycle,
      }),
      expectedRevision: input.row.revision,
    },
  ], { signal: context.signal });
  assertNotAborted(context.signal);
  if (result.status === 'conflict') {
    throw pluginError(
      `${input.operation}_conflict`,
      'Connection stop custody lost its retained-row compare-and-swap.',
      true,
    );
  }
  const persisted = result.results.find((entry) => (
    entry.rowId === input.row.rowId && entry.deleted === false
  ));
  if (persisted === undefined) {
    throw pluginError(
      `${input.operation}_result_invalid`,
      'Connection stop custody did not return its retained row result.',
      true,
    );
  }
  return persisted.revision;
}

function deleteResult(input: Readonly<{
  kind: ConversationConnectionDeleteResult['kind'];
  connectionId: string;
  revision: number;
  lifecycle: ConversationConnectionLifecycleStateV1;
  acceptedPossibleLoss?: boolean;
}>): ConversationConnectionDeleteResult {
  return {
    kind: input.kind,
    connectionId: input.connectionId,
    revision: input.revision,
    authorityEpoch: input.lifecycle.authorityEpoch,
    acceptedPossibleLoss: input.acceptedPossibleLoss
      ?? (input.lifecycle.pendingOldTransportStop?.acceptedPossibleLoss === true),
  };
}

/**
 * The generic Actions owner enforces the frozen origin before target-handler
 * admission and again after it settles. This consumer never selects or
 * compares a replacement target locally.
 */
async function executeFrozenOldTransportStop(input: Readonly<{
  context: PluginInvocationContext;
  pendingOldTransportStop: ConversationPendingOldTransportStopV1;
}>): Promise<ReturnType<typeof ConversationProviderConnectionStopResultV1Schema.parse>> {
  const provider = await readCurrentProviderContributionForPersistedSelection({
    context: {
      targetedContributions: input.context.services.targetedContributions,
      signal: input.context.signal,
    },
    // A retained connection can already point at a replacement contribution.
    // Deferred stop custody is instead exactly the frozen old origin and
    // contributor/generation selection.
    providerPluginId: input.pendingOldTransportStop.transportOrigin.materializationRef.pluginId,
    providerContributionSelection: input.pendingOldTransportStop.providerContributionSelection,
  });
  const stop = provider.operations.connectionStop;
  if (stop === undefined) {
    throw pluginError(
      'channels_connection_stop_unavailable',
      'The current provider contribution does not support stopping this connection transport.',
      true,
    );
  }
  const execution = await input.context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    stop,
    input.pendingOldTransportStop.stopRequest,
    {
      signal: input.context.signal,
      expectedExecutionOrigin: input.pendingOldTransportStop.transportOrigin,
    },
  );
  assertNotAborted(input.context.signal);
  try {
    return ConversationProviderConnectionStopResultV1Schema.parse(execution.result);
  } catch (cause) {
    throw new PluginError({
      code: 'channels_connection_stop_result_invalid',
      message: 'Provider stop did not return its strict connection-stop result.',
    }, { cause });
  }
}

/**
 * The old-stop slot fences the effect only while it remains the exact current
 * Account authority. Re-read it immediately before generic Action admission;
 * the generic owner then validates the frozen execution origin at invocation.
 */
async function readCurrentFrozenOldTransportStopForEffect(input: Readonly<{
  collection: ChannelStateCollection;
  connectionId: string;
  pendingRevision: number;
}>, context: PluginInvocationContext): Promise<Readonly<{
  pendingOldTransportStop: ConversationPendingOldTransportStopV1;
  lifecycle: ConversationConnectionLifecycleStateV1;
}>> {
  const row = await input.collection.get(input.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null || row.revision !== input.pendingRevision) {
    throw pluginError(
      'channels_connection_delete_stop_currentness_conflict',
      'Connection old-stop authority changed before the provider effect could start.',
      true,
    );
  }
  const current = readConversationConnectionUpdateRow({ row, connectionId: input.connectionId });
  const pendingOldTransportStop = current.lifecycle.pendingOldTransportStop;
  if (
    pendingOldTransportStop === null
    || pendingOldTransportStop.acceptedPossibleLoss
    || pendingOldTransportStop.stopRequest.reason !== 'delete'
    || pendingOldTransportStop.stopRequest.authorityEpoch !== current.lifecycle.authorityEpoch
    || current.providerPluginId !== pendingOldTransportStop.transportOrigin.materializationRef.pluginId
  ) {
    throw pluginError(
      'channels_connection_delete_stop_currentness_conflict',
      'Connection old-stop authority is no longer current for a provider effect.',
      true,
    );
  }
  return {
    pendingOldTransportStop,
    lifecycle: current.lifecycle,
  };
}

/**
 * A successful old-provider result proves nothing once the pending row has
 * changed. Re-read that exact row revision before advancing the lifecycle.
 */
async function settleCurrentConnectionStopProof(input: Readonly<{
  collection: ChannelStateCollection;
  connectionId: string;
  pendingRevision: number;
  frozenStopRequest: ConversationPendingOldTransportStopV1['stopRequest'];
}>, context: PluginInvocationContext): Promise<Readonly<{
  kind: 'deleteFinalizing';
  revision: number;
  lifecycle: ConversationConnectionLifecycleStateV1;
}>> {
  const row = await input.collection.get(input.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null || row.revision !== input.pendingRevision) {
    throw pluginError(
      'channels_connection_delete_stop_settlement_conflict',
      'Connection stop proof no longer matches the current retained pending row.',
      true,
    );
  }
  const current = readConversationConnectionUpdateRow({ row, connectionId: input.connectionId });
  const transition = confirmConversationConnectionStop({
    current: current.lifecycle,
    reportedAuthorityEpoch: input.frozenStopRequest.authorityEpoch,
  });
  if (transition.kind !== 'deleteFinalizing') {
    throw pluginError(
      'channels_connection_delete_stop_settlement_stale',
      'Connection stop proof no longer matches its current lifecycle custody.',
      true,
    );
  }
  const revision = await persistConversationConnectionLifecycle({
    collection: input.collection,
    row,
    current,
    lifecycle: transition.connection,
    operation: 'channels_connection_delete_stop_settlement',
  }, context);
  return {
    kind: transition.kind,
    revision,
    lifecycle: transition.connection,
  };
}

/**
 * Delete first durably fences admission and freezes the old stop request. The
 * subsequent physical stop can only run through the generic expected-origin
 * precondition; without that owner this Action leaves reconciliation pending.
 */
export async function deleteConversationConnectionForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionDeleteResult> {
  const deleteInput = readAdmittedConnectionDeleteInput(input);
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(deleteInput.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) {
    throw pluginError('channels_connection_delete_not_found', 'Connection deletion target does not exist.');
  }
  if (row.revision !== deleteInput.expectedRevision) {
    throw pluginError(
      'channels_connection_delete_conflict',
      'Connection deletion requires the current retained row revision.',
      true,
    );
  }
  const current = readConversationConnectionUpdateRow({ row, connectionId: deleteInput.connectionId });
  if (current.lifecycle.deletionState === 'finalizingDelete') {
    return deleteResult({
      kind: 'rejoined',
      connectionId: deleteInput.connectionId,
      revision: row.revision,
      lifecycle: current.lifecycle,
    });
  }
  if (current.lifecycle.deletionState === 'pendingStopReconciliation') {
    const frozen = current.lifecycle.pendingOldTransportStop;
    if (frozen === null || frozen.stopRequest.reason !== 'delete') {
      throw pluginError('channels_connection_delete_corrupt', 'Pending connection deletion lost its exact old-stop custody.');
    }
    return deleteResult({
      kind: 'rejoined',
      connectionId: deleteInput.connectionId,
      revision: row.revision,
      lifecycle: current.lifecycle,
    });
  }

  let pending = current.lifecycle;
  let pendingRevision = row.revision;
  if (current.lifecycle.deletionState === 'none') {
    const start = startConversationConnectionDelete({
      current: current.lifecycle,
      pendingOldTransportStop: {
        predecessorCheckpointedPollInvocation: {
          connectionRevision: row.revision,
          authorityEpoch: current.lifecycle.authorityEpoch,
          transportOrigin: current.transportOrigin,
        },
        transportOrigin: current.transportOrigin,
        providerContributionSelection: current.providerContributionSelection,
        stopRequest: createDeleteStopRequest({
          connectionId: deleteInput.connectionId,
          payload: current.payload,
          authorityEpoch: current.lifecycle.authorityEpoch + 1,
        }),
      },
    });
    if (start.kind === 'rejected') {
      if (start.code === 'authorityEpochExhausted') {
        throw pluginError('channels_connection_delete_authority_epoch_exhausted', 'Connection authority cannot advance further.');
      }
      if (start.code === 'oldTransportStopPending') {
        throw pluginError('channels_connection_delete_old_transport_stop_pending', 'Connection replacement already retains unresolved old-stop custody.', true);
      }
      throw pluginError('channels_connection_delete_stop_request_invalid', 'Connection deletion could not freeze its exact stop request.');
    }
    if (start.kind === 'rejoined') {
      return deleteResult({
        kind: 'rejoined',
        connectionId: deleteInput.connectionId,
        revision: row.revision,
        lifecycle: start.connection,
      });
    }
    pending = start.connection;
    pendingRevision = await persistConversationConnectionLifecycle({
      collection,
      row,
      current,
      lifecycle: pending,
      operation: 'channels_connection_delete',
    }, context);
  }

  const frozen = pending.pendingOldTransportStop;
  if (frozen === null || frozen.stopRequest.reason !== 'delete') {
    throw pluginError('channels_connection_delete_corrupt', 'Pending connection deletion lost its exact old-stop custody.');
  }
  const transport = own(current.payload, 'transport');
  if (isJsonRecord(transport) && transport.kind === 'checkpointedPull') {
    // Checkpointed pulls have no provider-local consumer to stop. The one core
    // poll supervisor observes the fenced row become ineligible after any
    // in-flight poll returns, then settles this exact durable custody itself.
    return deleteResult({
      kind: 'deletePending',
      connectionId: deleteInput.connectionId,
      revision: pendingRevision,
      lifecycle: pending,
    });
  }
  const currentStop = await readCurrentFrozenOldTransportStopForEffect({
    collection,
    connectionId: deleteInput.connectionId,
    pendingRevision,
  }, context);
  const stopResult = await executeFrozenOldTransportStop({
    context,
    pendingOldTransportStop: currentStop.pendingOldTransportStop,
  });
  if (stopResult.kind === 'pending') {
    return deleteResult({
      kind: 'deletePending',
      connectionId: deleteInput.connectionId,
      revision: pendingRevision,
      lifecycle: currentStop.lifecycle,
    });
  }
  if (stopResult.kind === 'notReady') {
    throw pluginError(
      'channels_connection_stop_not_ready',
      'Provider stop did not confirm the old transport has stopped.',
      stopResult.retryAfterMs !== undefined,
    );
  }
  const settled = await settleCurrentConnectionStopProof({
    collection,
    connectionId: deleteInput.connectionId,
    pendingRevision,
    frozenStopRequest: currentStop.pendingOldTransportStop.stopRequest,
  }, context);
  return deleteResult({
    kind: 'deleteFinalizing',
    connectionId: deleteInput.connectionId,
    revision: settled.revision,
    lifecycle: settled.lifecycle,
  });
}

/**
 * Explicit present-user escape from unrecoverable old-stop custody. Delete
 * advances to finalization; transfer retains its frozen slot as accepted-loss
 * disclosure. Neither path writes physical-stop proof or a history-gap fact.
 */
export async function abandonConversationConnectionForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionDeleteResult> {
  const abandonInput = readAdmittedConnectionDeleteInput(input);
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(abandonInput.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) {
    throw pluginError('channels_connection_abandon_not_found', 'Connection abandon target does not exist.');
  }
  const current = readConversationConnectionUpdateRow({ row, connectionId: abandonInput.connectionId });
  if (row.revision !== abandonInput.expectedRevision) {
    const pending = current.lifecycle.pendingOldTransportStop;
    const isImmediateAcceptedTransferRetry = abandonInput.expectedRevision < Number.MAX_SAFE_INTEGER
      && row.revision === abandonInput.expectedRevision + 1
      && hasAcceptedConversationTransferLoss(current.lifecycle)
      && pending !== null
      && pending.stopRequest.connectionId === abandonInput.connectionId
      && pending.stopRequest.authorityEpoch < Number.MAX_SAFE_INTEGER
      && current.lifecycle.authorityEpoch === pending.stopRequest.authorityEpoch + 1;
    if (isImmediateAcceptedTransferRetry) {
      return deleteResult({
        kind: 'rejoined',
        connectionId: abandonInput.connectionId,
        revision: row.revision,
        lifecycle: current.lifecycle,
      });
    }
    throw pluginError(
      'channels_connection_abandon_conflict',
      'Connection abandon requires the current retained row revision.',
      true,
    );
  }
  const pending = current.lifecycle.pendingOldTransportStop;
  if (pending?.stopRequest.connectionId !== abandonInput.connectionId) {
    throw pluginError(
      'channels_connection_abandon_not_pending',
      'Connection abandon requires an exact pending old-transport stop request.',
    );
  }
  const transition: ConversationConnectionAbandonResultV1 = abandonConversationConnectionStop({
    current: current.lifecycle,
  });
  if (transition.kind === 'staleAuthority') {
    if (pending?.stopRequest.reason === 'transfer' && pending.acceptedPossibleLoss) {
      throw pluginError(
        'channels_connection_abandon_conflict',
        'Connection abandon retained an incoherent accepted transfer marker.',
        true,
      );
    }
    throw pluginError('channels_connection_abandon_not_pending', 'Connection abandon requires an exact pending old-transport stop request.');
  }
  if (transition.kind === 'rejected') {
    throw pluginError('channels_connection_abandon_authority_epoch_exhausted', 'Connection authority cannot advance further.');
  }
  if (transition.kind === 'rejoined') {
    return deleteResult({
      kind: 'rejoined',
      connectionId: abandonInput.connectionId,
      revision: row.revision,
      lifecycle: transition.connection,
    });
  }
  const revision = await persistConversationConnectionLifecycle({
    collection,
    row,
    current,
    lifecycle: transition.connection,
    operation: 'channels_connection_abandon',
  }, context);
  return deleteResult({
    kind: transition.kind === 'transferAbandoned' ? 'rejoined' : 'deleteFinalizing',
    connectionId: abandonInput.connectionId,
    revision,
    lifecycle: transition.connection,
    acceptedPossibleLoss: transition.kind === 'transferAbandoned' ? true : undefined,
  });
}

/**
 * Provider transport facts are caller-proven by the shared reconciliation
 * predicate and can settle only the still-current frozen delete request.
 */
export async function reportConversationTransportFactForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationTransportFactReportResultV1> {
  let report: ReturnType<typeof ConversationTransportFactReportInputV1Schema.parse>;
  try {
    report = ConversationTransportFactReportInputV1Schema.parse(input);
  } catch (cause) {
    throw new PluginError({
      code: 'channels_transport_fact_input_invalid',
      message: 'Transport fact input was not admitted by its strict contract.',
    }, { cause });
  }
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(report.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) return { kind: 'staleAuthority' };
  const current = readConversationConnectionUpdateRow({ row, connectionId: report.connectionId });

  if (report.fact.kind === 'historyGap') {
    if (!hasCurrentConversationTransportCaller({
      caller: context.caller,
      providerPluginId: current.providerPluginId,
      transportOrigin: current.transportOrigin,
    })) {
      return { kind: 'staleAuthority' };
    }
    const transition = recordConversationConnectionHistoryGap({
      current: current.lifecycle,
      reportedAuthorityEpoch: report.authorityEpoch,
      reportedAt: Date.now(),
      fact: report.fact,
    });
    if (transition.kind === 'staleAuthority') return { kind: 'staleAuthority' };
    if (transition.kind === 'rejoined') return { kind: 'rejoined' };
    await persistConversationConnectionLifecycle({
      collection,
      row,
      current,
      lifecycle: transition.connection,
      operation: 'channels_transport_fact',
    }, context);
    return { kind: 'recorded' };
  }

  if (report.fact.kind === 'providerReadiness') {
    if (!hasCurrentConversationTransportCaller({
      caller: context.caller,
      providerPluginId: current.providerPluginId,
      transportOrigin: current.transportOrigin,
    })) {
      return { kind: 'staleAuthority' };
    }
    const transition = recordConversationConnectionProviderReadiness({
      current: current.lifecycle,
      reportedAuthorityEpoch: report.authorityEpoch,
      fact: report.fact,
    });
    if (transition.kind === 'staleAuthority') return { kind: 'staleAuthority' };
    if (transition.kind === 'rejoined') return { kind: 'rejoined' };
    await persistConversationConnectionLifecycle({
      collection,
      row,
      current,
      lifecycle: transition.connection,
      operation: 'channels_transport_fact',
    }, context);
    return { kind: 'recorded' };
  }

  const pending = current.lifecycle.pendingOldTransportStop;
  if (pending === null
    || !hasCurrentConversationTransportCaller({
      caller: context.caller,
      providerPluginId: current.providerPluginId,
      transportOrigin: pending.transportOrigin,
    })
    || (pending.stopRequest.reason === 'delete' && !hasExactCurrentStopRequest({
      connectionId: report.connectionId,
      payload: current.payload,
      authorityEpoch: current.lifecycle.authorityEpoch,
      pendingOldTransportStop: pending,
    }))
    || (pending.stopRequest.reason === 'transfer'
      && pending.stopRequest.connectionId !== report.connectionId)) {
    return { kind: 'staleAuthority' };
  }
  const transition: ConversationConnectionStopConfirmationResultV1 = confirmConversationConnectionStop({
    current: current.lifecycle,
    reportedAuthorityEpoch: report.authorityEpoch,
  });
  if (transition.kind === 'staleAuthority') return { kind: 'staleAuthority' };
  await persistConversationConnectionLifecycle({
    collection,
    row,
    current,
    lifecycle: transition.connection,
    operation: 'channels_transport_fact',
  }, context);
  return transition.kind === 'deleteFinalizing'
    ? { kind: 'deleteFinalizing' }
    : { kind: 'recorded' };
}

/**
 * The selected core poller reports a provider-proven history discontinuity
 * through the same lifecycle transition as a current provider transport. It
 * is intentionally not an Action: the poller already holds only the exact
 * host execution origin returned by the provider Action, and the connection
 * row remains the one authority for the resulting guarded write.
 */
export async function recordConversationCheckpointedPollHistoryGapForInvocation(input: Readonly<{
  connectionId: string;
  expectedRevision: number;
  authorityEpoch: number;
  executionOrigin: PluginMachineExecutionOriginV1;
  fact: Extract<ConversationConnectionHistoryGapFactV1, Readonly<{
    reason: 'providerHistoryUnavailable';
  }>>;
}>, context: PluginInvocationContext): Promise<'recorded' | 'rejoined' | 'staleAuthority'> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(input.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null || row.revision !== input.expectedRevision) return 'staleAuthority';
  const current = readConversationConnectionUpdateRow({ row, connectionId: input.connectionId });
  const transport = own(current.payload, 'transport');
  if (
    !isJsonRecord(transport)
    || transport.kind !== 'checkpointedPull'
    || current.providerPluginId !== input.executionOrigin.materializationRef.pluginId
    || !arePluginMachineExecutionOriginsEqual(current.transportOrigin, input.executionOrigin)
  ) return 'staleAuthority';

  const transition = recordConversationConnectionHistoryGap({
    current: current.lifecycle,
    reportedAuthorityEpoch: input.authorityEpoch,
    reportedAt: Date.now(),
    fact: input.fact,
  });
  if (transition.kind === 'staleAuthority') return 'staleAuthority';
  if (transition.kind === 'rejoined') return 'rejoined';
  await persistConversationConnectionLifecycle({
    collection,
    row,
    current,
    lifecycle: transition.connection,
    operation: 'channels_checkpointed_poll_history_gap',
  }, context);
  return 'recorded';
}

/**
 * The core checkpointed-poll supervisor owns quiescence for poll transports:
 * once it has observed the row ineligible, no provider socket-stop Action is
 * needed or permitted. A captured old poll matches the immutable predecessor
 * facts frozen in its custody slot, while the final CAS still targets the
 * row reread at settlement; unrelated retained-row writes are not proof loss.
 * The same retained delete custody still has to match exactly before the
 * lifecycle may advance to finalization.
 */
export async function confirmConversationCheckpointedPollStopForInvocation(input: Readonly<{
  connectionId: string;
  capturedInvocation?: ConversationCheckpointedPollInvocationBasisV1;
  frozenStopRequest?: ConversationPendingOldTransportStopV1['stopRequest'];
}>, context: PluginInvocationContext): Promise<'deleteFinalizing' | 'transportStopConfirmed' | 'ineligible'> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(input.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) return 'ineligible';

  const current = readConversationConnectionUpdateRow({ row, connectionId: input.connectionId });
  const transport = own(current.payload, 'transport');
  const pending = current.lifecycle.pendingOldTransportStop;
  const captured = input.capturedInvocation;
  const predecessor = pending?.predecessorCheckpointedPollInvocation;
  const hasCapturedProof = captured !== undefined
    && input.frozenStopRequest !== undefined
    && Number.isSafeInteger(captured.connectionRevision)
    && captured.connectionRevision >= 1
    && Number.isSafeInteger(captured.authorityEpoch)
    && captured.authorityEpoch >= 1
    && pending !== null
    && predecessor !== undefined
    && captured.connectionRevision === predecessor.connectionRevision
    && captured.authorityEpoch === predecessor.authorityEpoch
    && arePluginMachineExecutionOriginsEqual(captured.transportOrigin, predecessor.transportOrigin)
    && pending.stopRequest.authorityEpoch === predecessor.authorityEpoch + 1
    && arePluginMachineExecutionOriginsEqual(pending.transportOrigin, predecessor.transportOrigin)
    && pluginJsonValuesEqual(pending.stopRequest, input.frozenStopRequest);
  const hasFreshDeleteProof = captured === undefined
    && input.frozenStopRequest === undefined
    && isJsonRecord(transport)
    && transport.kind === 'checkpointedPull'
    && pending !== null
    && pending.stopRequest.reason === 'delete'
    && pending.overlapSafety === current.lifecycle.overlapSafety
    && current.providerPluginId === current.transportOrigin.materializationRef.pluginId
    && arePluginMachineExecutionOriginsEqual(current.transportOrigin, pending.transportOrigin)
    && hasExactCurrentStopRequest({
      connectionId: input.connectionId,
      payload: current.payload,
      authorityEpoch: current.lifecycle.authorityEpoch,
      pendingOldTransportStop: pending,
    });
  if (
    pending === null
    || pending.acceptedPossibleLoss
    || current.providerPluginId !== pending.transportOrigin.materializationRef.pluginId
    || (!hasCapturedProof && !hasFreshDeleteProof)
  ) return 'ineligible';

  const transition = confirmConversationConnectionStop({
    current: current.lifecycle,
    reportedAuthorityEpoch: pending.stopRequest.authorityEpoch,
  });
  if (transition.kind !== 'deleteFinalizing' && transition.kind !== 'transportStopConfirmed') {
    return 'ineligible';
  }
  await persistConversationConnectionLifecycle({
    collection,
    row,
    current,
    lifecycle: transition.connection,
    operation: 'channels_checkpointed_poll_stop_settlement',
  }, context);
  return transition.kind;
}

/**
 * A provider-exclusive checkpointed replacement has one additional, narrow
 * proof path: a successful replacement poll means the provider has admitted
 * the replacement as its exclusive observer. The caller supplies that success
 * only for a strict batch/checkpoint result; this lifecycle owner still
 * requires the exact current replacement row and clears only the existing
 * transfer custody slot in its one guarded write.
 */
export async function settleConversationProviderExclusiveCheckpointedPollReplacementForInvocation(input: Readonly<{
  connectionId: string;
  expectedRevision: number;
  authorityEpoch: number;
  executionOrigin: PluginMachineExecutionOriginV1;
}>, context: PluginInvocationContext): Promise<
  | Readonly<{ kind: 'settled'; revision: number }>
  | Readonly<{ kind: 'notApplicable' }>
  | Readonly<{ kind: 'staleAuthority' }>
> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(input.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null || row.revision !== input.expectedRevision) return { kind: 'staleAuthority' };

  const current = readConversationConnectionUpdateRow({ row, connectionId: input.connectionId });
  const transport = own(current.payload, 'transport');
  const replayContinuity = own(current.payload, 'replayContinuity');
  if (
    current.lifecycle.authorityEpoch !== input.authorityEpoch
    || !current.lifecycle.enabled
    || current.lifecycle.deletionState !== 'none'
    || !isJsonRecord(transport)
    || transport.kind !== 'checkpointedPull'
    || replayContinuity !== 'checkpointed'
    || current.providerPluginId !== input.executionOrigin.materializationRef.pluginId
    || !arePluginMachineExecutionOriginsEqual(current.transportOrigin, input.executionOrigin)
  ) return { kind: 'staleAuthority' };

  const pending = current.lifecycle.pendingOldTransportStop;
  if (
    pending === null
    || pending.acceptedPossibleLoss
    || pending.stopRequest.reason !== 'transfer'
    || pending.overlapSafety !== 'providerExclusive'
    || pending.stopRequest.authorityEpoch !== current.lifecycle.authorityEpoch
    || current.providerPluginId !== pending.transportOrigin.materializationRef.pluginId
  ) return { kind: 'notApplicable' };

  const transition = confirmConversationConnectionStop({
    current: current.lifecycle,
    reportedAuthorityEpoch: pending.stopRequest.authorityEpoch,
  });
  if (transition.kind !== 'transportStopConfirmed') return { kind: 'notApplicable' };

  try {
    const revision = await persistConversationConnectionLifecycle({
      collection,
      row,
      current,
      lifecycle: transition.connection,
      operation: 'channels_provider_exclusive_checkpointed_poll_replacement_settlement',
    }, context);
    return { kind: 'settled', revision };
  } catch (cause) {
    if (
      cause instanceof PluginError
      && cause.code === 'channels_provider_exclusive_checkpointed_poll_replacement_settlement_conflict'
    ) return { kind: 'staleAuthority' };
    throw cause;
  }
}

const MAX_CONNECTION_DELETE_RELATION_ROWS = 32;

function stateRowFromCollectionRow(row: Readonly<{
  rowId: string;
  revision: number;
  value: JsonValue;
}>): StateRow | undefined {
  return isJsonRecord(row.value)
    ? { rowId: row.rowId, revision: row.revision, value: row.value }
    : undefined;
}

function hasExactStateRowIdentity(input: Readonly<{
  row: StateRow;
  recordKind: string;
  connectionId?: string;
  bindingId?: string;
}>): boolean {
  return own(input.row.value, CHANNEL_STATE_FIELD.id) === input.row.rowId
    && own(input.row.value, CHANNEL_STATE_FIELD.recordKind) === input.recordKind
    && (input.connectionId === undefined
      || own(input.row.value, CHANNEL_STATE_FIELD.connectionId) === input.connectionId)
    && (input.bindingId === undefined
      || own(input.row.value, CHANNEL_STATE_FIELD.bindingId) === input.bindingId);
}

function finalizingDeleteIsAuthorized(current: ConversationConnectionUpdateRow): boolean {
  const pending = current.lifecycle.pendingOldTransportStop;
  return current.lifecycle.deletionState === 'finalizingDelete'
    && !current.lifecycle.enabled
    && (pending === null || (
      pending.acceptedPossibleLoss
      && pending.stopRequest.reason === 'delete'
    ));
}

function readFinalizingReservationIdentity(current: ConversationConnectionUpdateRow): Readonly<{
  providerConnectionKey: string;
  integrationPrincipalId: string;
}> {
  const providerConnectionKey = own(current.payload, 'providerConnectionKey');
  const integrationPrincipal = own(current.payload, 'integrationPrincipal');
  const integrationPrincipalId = isJsonRecord(integrationPrincipal)
    ? own(integrationPrincipal, 'id')
    : undefined;
  if (typeof providerConnectionKey !== 'string' || typeof integrationPrincipalId !== 'string') {
    throw pluginError(
      'channels_connection_finalizer_identity_corrupt',
      'A finalizing connection has no canonical immutable reservation identity.',
    );
  }
  return { providerConnectionKey, integrationPrincipalId };
}

/** Validates and tombstones the deterministic binding-owned projection rows. */
async function appendFinalizingBindingArtifacts(input: Readonly<{
  collection: ChannelStateCollection;
  context: ConversationStorageContext;
  connectionId: string;
  routingIdentityKey: string;
  bindingRow: StateRow;
  mutations: ChannelStateBatchMutation[];
}>): Promise<boolean> {
  const binding = readConversationBindingUpdateRow({
    row: input.bindingRow,
    bindingId: input.bindingRow.rowId,
  });
  if (binding.binding.connectionId !== input.connectionId) return false;

  const frontierRowId = createConversationSessionProjectionFrontierRowId(input.bindingRow.rowId);
  const frontier = await input.collection.get(frontierRowId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (frontier !== null) {
    const frontierRow = stateRowFromCollectionRow(frontier);
    if (frontierRow === undefined || !hasExactStateRowIdentity({
      row: frontierRow,
      recordKind: CHANNEL_STATE_RECORD_KIND.projectionFrontier,
      bindingId: input.bindingRow.rowId,
    })) return false;
    input.mutations.push({
      kind: 'delete',
      rowId: frontierRow.rowId,
      expectedRevision: frontierRow.revision,
    });
  }

  const rotationRowId = await deriveConversationSessionRotationRowId({
    routingIdentityKey: input.routingIdentityKey,
    connectionId: input.connectionId,
    bindingId: input.bindingRow.rowId,
  });
  const rotation = await input.collection.get(rotationRowId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (rotation !== null) {
    const rotationRow = stateRowFromCollectionRow(rotation);
    if (rotationRow === undefined || !hasExactStateRowIdentity({
      row: rotationRow,
      recordKind: CHANNEL_STATE_RECORD_KIND.sessionRotation,
      bindingId: input.bindingRow.rowId,
    })) return false;
    input.mutations.push({
      kind: 'delete',
      rowId: rotationRow.rowId,
      expectedRevision: rotationRow.revision,
    });
  }

  return true;
}

/** Connection finalization owns the parent binding tombstone after its artifacts. */
async function appendFinalizingBindingDependents(input: Readonly<{
  collection: ChannelStateCollection;
  context: ConversationStorageContext;
  connectionId: string;
  routingIdentityKey: string;
  bindingRow: StateRow;
  mutations: ChannelStateBatchMutation[];
}>): Promise<boolean> {
  if (!(await appendFinalizingBindingArtifacts(input))) return false;
  input.mutations.push({
    kind: 'delete',
    rowId: input.bindingRow.rowId,
    expectedRevision: input.bindingRow.revision,
  });
  return true;
}

async function finalizeConversationConnectionDelete(input: Readonly<{
  connectionId: string;
  context: ConversationStorageContext;
}>): Promise<void> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const connectionStored = await collection.get(input.connectionId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (connectionStored === null) return;
  const connectionRow = stateRowFromCollectionRow(connectionStored);
  if (connectionRow === undefined) return;
  const current = readConversationConnectionUpdateRow({ row: connectionRow, connectionId: input.connectionId });
  if (!finalizingDeleteIsAuthorized(current)) return;

  const reservationIdentity = readFinalizingReservationIdentity(current);
  const connectionIdentityKey = await readExistingConnectionIdentityKey(input.context);
  if (connectionIdentityKey === null) return;
  const reservationRowId = await deriveReservationRowId({
    connectionIdentityKey,
    providerPluginId: current.providerPluginId,
    providerConnectionKey: reservationIdentity.providerConnectionKey,
    signal: input.context.signal,
  });
  const reservationStored = await collection.get(reservationRowId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (reservationStored === null) return;
  const reservationRow = stateRowFromCollectionRow(reservationStored);
  if (reservationRow === undefined || readReservationConnectionId({
    row: reservationRow,
    reservationRowId,
    providerPluginId: current.providerPluginId,
    providerConnectionKey: reservationIdentity.providerConnectionKey,
    integrationPrincipalId: reservationIdentity.integrationPrincipalId,
  }) !== input.connectionId) return;

  const custody = await settleConversationOutwardDeliveriesForConnectionDeletion({
    stateCollection: collection,
    deliveriesCollection: requireChannelsAccountStorage(input.context).collection(CHANNEL_DELIVERIES_COLLECTION),
    connectionId: input.connectionId,
    signal: input.context.signal,
    now: Date.now,
  });
  if (custody.kind !== 'settled') return;

  const relationPage = await collection.query({
    index: CHANNEL_STATE_INDEX_ID.byConnectionBinding,
    prefix: [input.connectionId],
    // Bound relation cleanup must see every binding-scoped ingress obligation
    // before it reaches the unbound checkpoint/census rows. Otherwise a full
    // first page can remove a census while a later attempting/blocked
    // obligation still needs its immutable ingress evidence.
    order: 'desc',
    limit: MAX_CONNECTION_DELETE_RELATION_ROWS,
  }, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  const mutations: ChannelStateBatchMutation[] = [{
    kind: 'assert',
    rowId: connectionRow.rowId,
    expectedRevision: connectionRow.revision,
  }];
  let hasDependentMutation = false;

  for (const stored of relationPage.rows) {
    const row = stateRowFromCollectionRow(stored);
    if (row === undefined) return;
    const recordKind = own(row.value, CHANNEL_STATE_FIELD.recordKind);
    if (recordKind === CHANNEL_STATE_RECORD_KIND.connection) {
      if (row.rowId !== connectionRow.rowId || row.revision !== connectionRow.revision) return;
      continue;
    }
    if (recordKind === CHANNEL_STATE_RECORD_KIND.connectionReservation) {
      if (row.rowId !== reservationRow.rowId || row.revision !== reservationRow.revision) return;
      if (readReservationConnectionId({
        row,
        reservationRowId,
        providerPluginId: current.providerPluginId,
        providerConnectionKey: reservationIdentity.providerConnectionKey,
        integrationPrincipalId: reservationIdentity.integrationPrincipalId,
      }) !== input.connectionId) return;
      continue;
    }
    if (recordKind === CHANNEL_STATE_RECORD_KIND.binding) {
      const appended = await appendFinalizingBindingDependents({
        collection,
        context: input.context,
        connectionId: input.connectionId,
        routingIdentityKey: current.routingIdentityKey,
        bindingRow: row,
        mutations,
      });
      if (!appended) return;
      hasDependentMutation = true;
      continue;
    }
    if (recordKind === CHANNEL_STATE_RECORD_KIND.ingressObligation) {
      const settlement = prepareConversationIngressObligationForConnectionDeletion({
        rowId: row.rowId,
        revision: row.revision,
        value: row.value,
        now: Date.now(),
      });
      if (settlement.kind === 'invalid'
        || settlement.connectionId !== input.connectionId) return;
      if (settlement.kind === 'blocked') return;
      if (settlement.kind === 'readyToSettle') {
        mutations.push({ kind: 'put', value: settlement.value, expectedRevision: row.revision });
      } else {
        mutations.push({ kind: 'delete', rowId: row.rowId, expectedRevision: row.revision });
      }
      hasDependentMutation = true;
      continue;
    }
    if ((recordKind === CHANNEL_STATE_RECORD_KIND.checkpoint
      || recordKind === CHANNEL_STATE_RECORD_KIND.ingressCensus)
      && hasExactStateRowIdentity({ row, recordKind, connectionId: input.connectionId })) {
      mutations.push({ kind: 'delete', rowId: row.rowId, expectedRevision: row.revision });
      hasDependentMutation = true;
      continue;
    }
    // A relation from this connection to any unknown/malformed live row must
    // remain visible for repair rather than being silently orphaned by delete.
    return;
  }

  if (hasDependentMutation) {
    const result = await collection.batch(mutations, { signal: input.context.signal });
    if (result.status === 'conflict') return;
    return;
  }
  if (relationPage.nextCursor !== undefined) return;

  const finalDelete = await collection.batch([
    { kind: 'delete', rowId: connectionRow.rowId, expectedRevision: connectionRow.revision },
    { kind: 'delete', rowId: reservationRow.rowId, expectedRevision: reservationRow.revision },
  ], { signal: input.context.signal });
  if (finalDelete.status === 'conflict') return;
}

function finalizingBindingDeleteIsAuthorized(current: ConversationBindingUpdateRow): boolean {
  return current.binding.deletionState === 'finalizingDelete' && !current.binding.enabled;
}

/**
 * Binding deletion is a direct authority cut. The retained finalizing row is
 * the sole recovery fact while incumbent ingress and outward custody finish;
 * it does not create another queue, cursor, or finalizer wake.
 */
async function finalizeConversationBindingDelete(input: Readonly<{
  bindingId: string;
  context: ConversationStorageContext;
}>): Promise<void> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const bindingStored = await collection.get(input.bindingId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (bindingStored === null) return;
  const bindingRow = stateRowFromCollectionRow(bindingStored);
  if (bindingRow === undefined) return;
  const current = readConversationBindingUpdateRow({ row: bindingRow, bindingId: input.bindingId });
  if (!finalizingBindingDeleteIsAuthorized(current)) return;

  // Connection deletion remains the parent cleanup owner. A pending or
  // finalizing parent must consume this binding through its own bounded page,
  // rather than two finalizers racing the same relation rows.
  const connectionStored = await collection.get(current.binding.connectionId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (connectionStored === null) return;
  const connectionRow = stateRowFromCollectionRow(connectionStored);
  if (connectionRow === undefined) return;
  const connection = readConversationConnectionUpdateRow({
    row: connectionRow,
    connectionId: current.binding.connectionId,
  });
  if (connection.lifecycle.deletionState !== 'none') return;

  const custody = await settleConversationOutwardDeliveriesForBindingDeletion({
    stateCollection: collection,
    deliveriesCollection: requireChannelsAccountStorage(input.context).collection(CHANNEL_DELIVERIES_COLLECTION),
    connectionId: current.binding.connectionId,
    bindingId: input.bindingId,
    signal: input.context.signal,
    now: Date.now,
  });
  if (custody.kind !== 'settled') return;

  const relationPage = await collection.query({
    index: CHANNEL_STATE_INDEX_ID.byConnectionBinding,
    prefix: [current.binding.connectionId, input.bindingId],
    order: 'desc',
    limit: MAX_CONNECTION_DELETE_RELATION_ROWS,
  }, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  const mutations: ChannelStateBatchMutation[] = [];
  let hasDependentMutation = false;
  for (const stored of relationPage.rows) {
    const row = stateRowFromCollectionRow(stored);
    if (row === undefined) return;
    const recordKind = own(row.value, CHANNEL_STATE_FIELD.recordKind);
    if (recordKind === CHANNEL_STATE_RECORD_KIND.binding) {
      if (!hasExactStateRowIdentity({
        row,
        recordKind: CHANNEL_STATE_RECORD_KIND.binding,
        connectionId: current.binding.connectionId,
        bindingId: input.bindingId,
      }) || row.rowId !== bindingRow.rowId || row.revision !== bindingRow.revision) return;
      continue;
    }
    if (recordKind === CHANNEL_STATE_RECORD_KIND.ingressObligation) {
      const settlement = prepareConversationIngressObligationForBindingDeletion({
        rowId: row.rowId,
        revision: row.revision,
        value: row.value,
        now: Date.now(),
      });
      if (settlement.kind === 'invalid'
        || settlement.connectionId !== current.binding.connectionId
        || settlement.bindingId !== input.bindingId) return;
      if (settlement.kind === 'blocked') return;
      if (settlement.kind === 'readyToSettle') {
        mutations.push({ kind: 'put', value: settlement.value, expectedRevision: row.revision });
      } else {
        // Ingress terminal evidence is a derived no-effect state. It is no
        // longer a live binding dependency; externally observable delivery
        // evidence remains retained in channelDeliveries above.
        mutations.push({ kind: 'delete', rowId: row.rowId, expectedRevision: row.revision });
      }
      hasDependentMutation = true;
      continue;
    }
    // This relation index is binding/ingress-only. A new or malformed member
    // must remain visible for repair instead of being orphaned by deletion.
    return;
  }
  if (hasDependentMutation) {
    // Dependent cleanup still needs the binding authority fence, but terminal
    // deletion uses its own expected revision as the one mutation for that
    // row. Collection batches reject an assert and delete for the same row.
    mutations.unshift({
      kind: 'assert',
      rowId: bindingRow.rowId,
      expectedRevision: bindingRow.revision,
    });
    const result = await collection.batch(mutations, { signal: input.context.signal });
    if (result.status === 'conflict') return;
    return;
  }
  if (relationPage.nextCursor !== undefined) return;

  if (!(await appendFinalizingBindingArtifacts({
    collection,
    context: input.context,
    connectionId: current.binding.connectionId,
    routingIdentityKey: connection.routingIdentityKey,
    bindingRow,
    mutations,
  }))) return;
  mutations.push({
    kind: 'delete',
    rowId: bindingRow.rowId,
    expectedRevision: bindingRow.revision,
  });
  const finalDelete = await collection.batch(mutations, { signal: input.context.signal });
  if (finalDelete.status === 'conflict') return;
}

/**
 * The existing outward-delivery wake owns delete finalization after it has
 * observed custody. There is no persisted cursor: each bounded page deletes
 * its own dependents, and a crash or conflict resumes from current rows.
 */
export async function finalizeConversationConnectionDeletesForInvocation(
  context: ConversationStorageContext,
): Promise<void> {
  if (context.signal.aborted) return;
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  let finalizationFailed = false;
  let connectionPage: Awaited<ReturnType<ChannelStateCollection['query']>> | undefined;
  try {
    connectionPage = await collection.query({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.connection],
      order: 'asc',
      limit: MAX_CONNECTION_DELETE_RELATION_ROWS,
    }, { signal: context.signal });
  } catch {
    // Binding finalization is independently enumerable from the same existing
    // bounded census, so an unavailable connection page must not manufacture
    // a second recovery mechanism or starve already-finalizing bindings.
    finalizationFailed = true;
  }
  if (connectionPage !== undefined) {
    for (const stored of connectionPage.rows) {
      if (context.signal.aborted) return;
      const row = stateRowFromCollectionRow(stored);
      if (row === undefined || row.value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.connection) {
        continue;
      }
      const connectionId = own(row.value, CHANNEL_STATE_FIELD.connectionId);
      if (typeof connectionId !== 'string') continue;
      try {
        const current = readConversationConnectionUpdateRow({ row, connectionId });
        if (!finalizingDeleteIsAuthorized(current)) continue;
        await finalizeConversationConnectionDelete({ connectionId, context });
      } catch {
        // Retain the canonical rows untouched; the next existing wake re-reads
        // them rather than treating an unavailable or malformed row as deleted.
        finalizationFailed = true;
      }
    }
  }
  if (context.signal.aborted) return;

  let bindingPage: Awaited<ReturnType<ChannelStateCollection['query']>> | undefined;
  try {
    bindingPage = await collection.query({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.binding],
      order: 'asc',
      // Binding quota is itself the established bounded census. Reading it in
      // one page makes every retained finalizing row rejoin without adding a
      // cursor, scanner, or separate cleanup scheduler.
      limit: MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
    }, { signal: context.signal });
  } catch {
    finalizationFailed = true;
  }
  if (bindingPage !== undefined) {
    for (const stored of bindingPage.rows) {
      if (context.signal.aborted) return;
      const row = stateRowFromCollectionRow(stored);
      if (row === undefined || row.value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.binding) {
        continue;
      }
      const bindingId = own(row.value, CHANNEL_STATE_FIELD.bindingId);
      if (typeof bindingId !== 'string' || bindingId !== row.rowId) continue;
      try {
        const current = readConversationBindingUpdateRow({ row, bindingId });
        if (!finalizingBindingDeleteIsAuthorized(current)) continue;
        await finalizeConversationBindingDelete({ bindingId, context });
      } catch {
        // Retain the canonical rows untouched; the next existing wake re-reads
        // them rather than treating an unavailable or malformed row as deleted.
        finalizationFailed = true;
      }
    }
  }
  if (context.signal.aborted) return;
  if (finalizationFailed) throw new Error('Channels delete finalization failed.');
}

/** Creates one binding only after the target owner has verified its current Automation version. */
export async function createConversationBindingForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationBindingCreateResult> {
  const createInput = readAdmittedBindingCreateInput(input);
  assertBindingPrincipalSelectionIdsAreUnique(
    createInput.principalSelection,
    'channels_binding_create',
  );
  const endpointResolution = await resolveBindingEndpointCandidates({
    connectionId: createInput.connectionId,
    expectedConnectionRevision: createInput.expectedConnectionRevision,
    query: createInput.endpointSelection.query,
    kinds: createInput.endpointSelection.kinds,
    context,
  });
  if (endpointResolution.kind !== 'endpointCandidates') return endpointResolution;
  const endpoint = endpointResolution.candidates.find((candidate) => (
    areConversationEndpointIdentitiesEqual(candidate, createInput.endpointSelection.selected)
  ));
  if (endpoint === undefined) return bindingResolutionStale();

  const principalResolution = await resolveBindingPrincipalCandidatesForEndpoint({
    connectionId: createInput.connectionId,
    expectedConnectionRevision: createInput.expectedConnectionRevision,
    endpoint,
    witness: endpointResolution.witness,
    query: createInput.principalSelection.query,
    context,
  });
  if (principalResolution.kind !== 'principalCandidates') return principalResolution;
  const allowedPrincipalIds: string[] = [];
  for (const selection of createInput.principalSelection.selected) {
    const principal = principalResolution.candidates.find((candidate) => (
      candidate.id === selection.id && candidate.kind === selection.kind
    ));
    if (principal === undefined) return bindingResolutionStale();
    allowedPrincipalIds.push(principal.id);
  }

  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const createCandidate = (target: ConversationBindingTargetV1) => createConversationBindingRow({
    bindingId: createBindingId(),
    connectionId: createInput.connectionId,
    endpoint,
    target,
    allowedPrincipalIds,
    allowBotSenders: createInput.allowBotSenders ?? false,
    inputMode: createInput.inputMode
      ?? (endpoint.audience === 'direct' ? 'allAllowedMessages' : 'directMentionsOnly'),
    inboundDebounceMs: createInput.inboundDebounceMs ?? 750,
    linkPreviewPolicy: createInput.linkPreviewPolicy ?? 'suppress',
    senderFeedback: createInput.senderFeedback ?? 'off',
    enabled: createInput.enabled ?? false,
  });

  let candidate: ReturnType<typeof createCandidate>;
  let projectionFrontier: Awaited<ReturnType<typeof createSessionProjectionFrontierForBinding>> = null;
  if (createInput.target.kind === 'automation') {
    const target = await resolveBindingTargetForPersistence(createInput.target, context);
    if (target.kind === 'notVerified') return target;
    // The Automation verifier is an external boundary. Reuse the incumbent
    // resolver witness check so its result cannot persist after either the
    // connection or selected provider contribution ceases to be current.
    const finalCurrent = await rereadBindingResolutionAfterProviderEffect({
      collection,
      connectionId: createInput.connectionId,
      expectedConnectionRevision: createInput.expectedConnectionRevision,
      context,
      providerBefore: principalResolution.witness,
    });
    if (finalCurrent.kind !== 'current') return finalCurrent;
    candidate = createCandidate(target);
  } else {
    const target = await resolveBindingTargetForPersistence(createInput.target, context);
    if (target.kind === 'notVerified') return target;
    candidate = createCandidate(target);
    projectionFrontier = await createSessionProjectionFrontierForBinding({
      bindingId: candidate.binding.id,
      target: candidate.binding.target,
      context,
    });
    const finalCurrent = await rereadBindingResolutionAfterProviderEffect({
      collection,
      connectionId: createInput.connectionId,
      expectedConnectionRevision: createInput.expectedConnectionRevision,
      context,
      providerBefore: principalResolution.witness,
    });
    if (finalCurrent.kind !== 'current') return finalCurrent;
  }
  assertNewConversationBindingCanPersist(candidate.binding);
  const result = await collection.batch([
    { kind: 'assert', rowId: createInput.connectionId, expectedRevision: createInput.expectedConnectionRevision },
    { kind: 'put', value: candidate.row, expectedRevision: 'absent' },
    ...(projectionFrontier === null
      ? []
      : [{ kind: 'put' as const, value: projectionFrontier, expectedRevision: 'absent' as const }]),
  ], { signal: context.signal });
  assertNotAborted(context.signal);
  if (result.status === 'conflict') {
    throw pluginError(
      'channels_binding_create_conflict',
      'Binding creation lost its current connection or unique binding-row compare-and-swap.',
      true,
    );
  }
  return { kind: 'created', binding: candidate.binding };
}

/** All existing-binding writes share one transition, verifier, and atomic persistence owner. */
async function mutateConversationBinding(
  updateInput: ConversationBindingTargetRotateInputV1,
  context: PluginInvocationContext,
  operation: 'channels_binding_target_rotate',
): Promise<ConversationBindingTargetMutationResult>;
async function mutateConversationBinding(
  updateInput: ConversationBindingUpdateInputV1,
  context: PluginInvocationContext,
  operation: 'channels_binding_update',
): Promise<ConversationBindingMutationResultV1>;
async function mutateConversationBinding(
  updateInput: ConversationBindingUpdateInputV1 | ConversationBindingTargetRotateInputV1,
  context: PluginInvocationContext,
  operation: 'channels_binding_update' | 'channels_binding_target_rotate',
): Promise<ConversationBindingMutationResultV1> {
  const policyUpdate = operation === 'channels_binding_update'
    ? updateInput as ConversationBindingUpdateInputV1
    : undefined;
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(updateInput.bindingId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) {
    throw pluginError(`${operation}_not_found`, 'Binding mutation target does not exist.');
  }
  if (row.revision !== updateInput.expectedRevision) {
    throw pluginError(
      `${operation}_conflict`,
      'Binding mutation requires the current retained row revision.',
      true,
    );
  }

  const current = readConversationBindingUpdateRow({ row, bindingId: updateInput.bindingId });
  if (current.binding.deletionState !== 'none') {
    throw pluginError(
      `${operation}_delete_in_progress`,
      'Binding mutation cannot change while binding deletion cleanup is in progress.',
    );
  }
  const connectionRow = await collection.get(current.binding.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (connectionRow === null) {
    throw pluginError(`${operation}_connection_not_found`, 'Binding mutation owner connection does not exist.');
  }
  const connection = readConversationConnectionUpdateRow({
    row: connectionRow,
    connectionId: current.binding.connectionId,
  });
  if (connection.lifecycle.deletionState !== 'none') {
    throw pluginError(`${operation}_connection_delete_in_progress`, 'Binding mutation cannot change while its connection deletion is in progress.');
  }

  let audience: BindingAudienceResolution | null = null;
  const audienceSelection = policyUpdate?.audienceSelection;
  if (audienceSelection !== undefined) {
    if (connectionRow.revision !== audienceSelection.expectedConnectionRevision) {
      return bindingResolutionStale();
    }
    audience = await resolveBindingAudienceSelection({
      connectionId: current.binding.connectionId,
      audienceSelection,
      context,
    });
    if (audience.kind !== 'ready') return audience;
  }

  let target = current.binding.target;
  if (updateInput.target !== undefined) {
    const verifiedTarget = await resolveBindingTargetForPersistence(updateInput.target, context);
    if (verifiedTarget.kind === 'notVerified') return verifiedTarget;
    target = verifiedTarget;
  }
  const transition = transitionConversationBinding({
    current: current.binding,
    requested: {
      ...current.binding,
      endpoint: audience?.endpoint ?? current.binding.endpoint,
      target,
      allowedPrincipalIds: audience?.allowedPrincipalIds ?? current.binding.allowedPrincipalIds,
      allowBotSenders: policyUpdate?.allowBotSenders ?? current.binding.allowBotSenders,
      inputMode: policyUpdate?.inputMode ?? current.binding.inputMode,
      inboundDebounceMs: policyUpdate?.inboundDebounceMs ?? current.binding.inboundDebounceMs,
      linkPreviewPolicy: policyUpdate?.linkPreviewPolicy ?? current.binding.linkPreviewPolicy,
      senderFeedback: policyUpdate?.senderFeedback ?? current.binding.senderFeedback,
      enabled: policyUpdate?.enabled ?? current.binding.enabled,
    },
  });
  if (transition.kind === 'rejected') {
    if (transition.code === 'authorityEpochExhausted') {
      throw pluginError(`${operation}_authority_epoch_exhausted`, 'Binding authority cannot advance further.');
    }
    throw pluginError(`${operation}_corrupt`, 'Binding mutation could not preserve the canonical binding relation.');
  }
  if (transition.kind === 'unchanged') {
    return {
      kind: 'unchanged',
      bindingId: updateInput.bindingId,
      revision: row.revision,
      authorityEpoch: transition.binding.authorityEpoch,
    };
  }

  // A legacy persisted enabled policy may be read and projected as unavailable,
  // but an ordinary update must not re-persist it around C5's target gate.
  assertConversationApprovalPolicyCanPersist(transition.binding.target);

  const next = withConversationBindingPolicy({
    row,
    current,
    binding: transition.binding,
    updatedAt: Date.now(),
  });
  const projectionFrontier = didSessionProjectionTargetChange(
    current.binding.target,
    transition.binding.target,
  )
    ? await createSessionProjectionFrontierForBinding({
      bindingId: updateInput.bindingId,
      target: transition.binding.target,
      context,
    })
    : null;
  let projectionFrontierExpectedRevision: number | 'absent' = 'absent';
  if (projectionFrontier !== null) {
    const existingFrontier = await collection.get(
      createConversationSessionProjectionFrontierRowId(updateInput.bindingId),
      { signal: context.signal },
    );
    assertNotAborted(context.signal);
    projectionFrontierExpectedRevision = existingFrontier?.revision ?? 'absent';
  }
  if (audience !== null) {
    // A resolver witness ceases to authorize persistence when a subsequent
    // Automation verification or Session-baseline effect changes its current
    // connection or provider contribution.
    const finalCurrent = await rereadBindingResolutionAfterProviderEffect({
      collection,
      connectionId: current.binding.connectionId,
      expectedConnectionRevision: connectionRow.revision,
      context,
      providerBefore: audience.witness,
    });
    if (finalCurrent.kind !== 'current') return finalCurrent;
  }
  const result = await collection.batch([
    {
      kind: 'assert',
      rowId: current.binding.connectionId,
      expectedRevision: connectionRow.revision,
    },
    { kind: 'put', value: next, expectedRevision: row.revision },
    ...(projectionFrontier === null
      ? []
      : [{
        kind: 'put' as const,
        value: projectionFrontier,
        expectedRevision: projectionFrontierExpectedRevision,
      }]),
  ], { signal: context.signal });
  assertNotAborted(context.signal);
  if (result.status === 'conflict') {
    throw pluginError(
      `${operation}_conflict`,
      'Binding mutation lost its retained-row compare-and-swap.',
      true,
    );
  }
  const persisted = result.results.find((entry) => (
    entry.rowId === updateInput.bindingId && entry.deleted === false
  ));
  if (persisted === undefined) {
    throw pluginError(
      `${operation}_result_invalid`,
      'Binding mutation batch did not return its retained row result.',
      true,
    );
  }
  return {
    kind: 'updated',
    bindingId: updateInput.bindingId,
    revision: persisted.revision,
    authorityEpoch: transition.binding.authorityEpoch,
  };
}

export async function updateConversationBindingForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationBindingMutationResultV1> {
  return await mutateConversationBinding(
    readAdmittedBindingUpdateInput(input),
    context,
    'channels_binding_update',
  );
}

/** A narrow target-only mutation shares the same currentness and persistence owner. */
export async function rotateConversationBindingTargetForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationBindingTargetMutationResult> {
  const rotateInput = readAdmittedBindingTargetRotateInput(input);
  return await mutateConversationBinding(rotateInput, context, 'channels_binding_target_rotate');
}

/** The narrow enable/disable Action uses the same canonical binding mutation owner. */
export async function setConversationBindingEnabledForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationBindingUpdateResult> {
  const setEnabledInput = readAdmittedBindingSetEnabledInput(input);
  return await setConversationBindingEnabledInAccountCollection({
    collection: requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION),
    ...setEnabledInput,
    signal: context.signal,
    assertCurrent: () => assertNotAborted(context.signal),
  });
}

/**
 * The one binding-delete owner first revokes all future binding authority in
 * the retained row. Cleanup remains with the incumbent bounded wake so a
 * response-loss retry can rejoin without inventing a second finalizer path.
 */
export async function deleteConversationBindingForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationBindingDeleteResultV1> {
  const deleteInput = readAdmittedBindingDeleteInput(input);
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(deleteInput.bindingId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) return { kind: 'deleted' };

  const current = readConversationBindingUpdateRow({ row, bindingId: deleteInput.bindingId });
  if (current.binding.deletionState === 'finalizingDelete') {
    return { kind: 'deletionPending' };
  }
  if (row.revision !== deleteInput.expectedRevision) {
    throw pluginError(
      'channels_binding_delete_conflict',
      'Binding deletion requires the current retained row revision.',
      true,
    );
  }
  if (current.binding.authorityEpoch >= Number.MAX_SAFE_INTEGER) {
    throw pluginError(
      'channels_binding_delete_authority_epoch_exhausted',
      'Binding deletion cannot advance its authority epoch further.',
    );
  }

  const result = await collection.batch([{
    kind: 'put',
    value: {
      ...row.value,
      [CHANNEL_STATE_FIELD.updatedAt]: Date.now(),
      payload: {
        ...current.payload,
        enabled: false,
        authorityEpoch: current.binding.authorityEpoch + 1,
        deletionState: 'finalizingDelete',
      },
    },
    expectedRevision: row.revision,
  }], { signal: context.signal });
  assertNotAborted(context.signal);
  if (result.status === 'conflict') {
    throw pluginError(
      'channels_binding_delete_conflict',
      'Binding deletion lost its retained-row compare-and-swap.',
      true,
    );
  }
  return { kind: 'deletionPending' };
}

/**
 * A mounted present-user Action settles only the exact current ambiguous
 * custody row. It intentionally does not reopen route authority or invoke a
 * provider: resolution is needed even while connection cleanup is pending.
 */
export async function resolveConversationDeliveryForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationDeliveryResolveResult> {
  const resolution = readAdmittedConversationDeliveryResolveInput(input);
  return await resolveConversationOutwardDeliveryCustodyInAccountCollection({
    stateCollection: requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION),
    deliveriesCollection: requireChannelsAccountStorage(context).collection(CHANNEL_DELIVERIES_COLLECTION),
    ...resolution,
    signal: context.signal,
  });
}

/** C2's final persistence owner for public non-durable connection creation. */
export async function createConversationConnectionForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionCreateResult> {
  const createInput = readAdmittedConnectionCreateInput(input);
  const provider = await readCurrentSelectedProvider({
    context,
    selection: createInput.providerSelection,
  });
  const prepared = await runProviderSetupAndTest({
    context,
    setupInput: createInput,
    provider,
    connectionIdForTest: createConnectionId(),
  });
  if (prepared.kind === 'notReady') return prepared;

  // Setup/test is an external boundary. Re-resolve the caller's exact admitted
  // selection before either rejoining a retained identity or mutating storage;
  // a retired contributor never receives a durable outcome from stale setup.
  const providerForPersistence = await readCurrentSelectedProvider({
    context,
    selection: createInput.providerSelection,
  });
  if (providerForPersistence.pluginId !== provider.pluginId) {
    throw pluginError(
      'channels_connection_provider_currentness_changed',
      'The selected provider changed before connection persistence.',
      true,
    );
  }
  const existing = await findExistingConnection({
    context,
    createInput,
    providerPluginId: providerForPersistence.pluginId,
    setup: prepared.setup,
  });
  if (existing !== null) return { kind: 'rejoined', connectionId: existing };

  return await createOrRejoinConnection({
    context,
    createInput,
    providerPluginId: providerForPersistence.pluginId,
    setup: prepared.setup,
    transportOrigin: prepared.transportOrigin,
  });
}

function assertTransferProviderPluginIdentity(input: Readonly<{
  current: ConversationConnectionUpdateRow;
  providerPluginId: string;
}>): void {
  if (input.current.providerPluginId !== input.providerPluginId) {
    throw pluginError(
      'channels_connection_transfer_identity_mismatch',
      'Connection transfer cannot change the retained provider plugin identity; create a new connection instead.',
    );
  }
  if (input.current.transportOrigin.materializationRef.pluginId !== input.current.providerPluginId) {
    throw pluginError(
      'channels_connection_transfer_corrupt',
      'Connection transfer found a retained provider origin that does not match its provider identity.',
    );
  }
}

function assertTransferImmutableConnectionIdentity(input: Readonly<{
  current: ConversationConnectionUpdateRow;
  setup: ConversationProviderSetupResultV1;
}>): void {
  const incumbent = readTransferImmutableConnectionIdentity(input.current);
  if (incumbent.providerConnectionKey !== input.setup.providerConnectionKey
    || incumbent.integrationPrincipalId !== input.setup.integrationPrincipal.id) {
    throw pluginError(
      'channels_connection_transfer_identity_mismatch',
      'Connection transfer changed immutable provider identity; create a new connection instead.',
    );
  }
}

function isCheckpointCompatibleTransfer(input: Readonly<{
  current: ConversationConnectionUpdateRow;
  oldTransport: 'checkpointedPull' | 'socket';
  transferInput: ConversationConnectionTransferInputV1;
  provider: CurrentProvider;
  setup: ConversationProviderSetupResultV1;
}>): boolean {
  return input.oldTransport === 'checkpointedPull'
    && input.transferInput.selectedTransport === 'checkpointedPull'
    && input.current.lifecycle.historyGap === null
    && input.current.providerPluginId === input.provider.pluginId
    && hasSamePersistedProviderContributionSelection({
      persisted: input.current.providerContributionSelection,
      requested: input.transferInput.providerSelection,
    })
    && own(input.current.payload, 'providerConfigVersion') === input.setup.providerConfigVersion
    && own(input.current.payload, 'replayContinuity') === 'checkpointed'
    && input.setup.replayContinuity === 'checkpointed'
    // Equality of the retained selection and requested immutable generation
    // makes this one exact current role the incumbent and replacement poll ABI.
    && input.provider.observationsPoll !== undefined;
}

function transferConnectionValue(input: Readonly<{
  row: StateRow;
  current: ConversationConnectionUpdateRow;
  transferInput: ConversationConnectionTransferInputV1;
  providerPluginId: string;
  prepared: Extract<ProviderConnectionPreparation, Readonly<{ kind: 'ready' }>>;
  lifecycle: ConversationConnectionLifecycleStateV1;
  now: number;
}>): JsonRecord {
  const { pairingDeepLinkTemplate: _oldPairingDeepLinkTemplate, ...payloadWithoutPairingTemplate } = input.current.payload;
  const replacementCurrent: ConversationConnectionUpdateRow = {
    ...input.current,
    payload: {
      ...payloadWithoutPairingTemplate,
      providerPluginId: input.providerPluginId,
      providerContributionSelection: {
        contributionId: input.transferInput.providerSelection.contributor.contributionId,
        immutableGenerationId: input.transferInput.providerSelection.contributor.immutableGenerationId,
      },
      providerSetupInput: input.transferInput.providerSetupInput,
      credentialRef: input.transferInput.credentialRef,
      transportOrigin: input.prepared.transportOrigin,
      transport: { kind: input.transferInput.selectedTransport },
      overlapSafety: input.prepared.setup.overlapSafety,
      replayContinuity: input.prepared.setup.replayContinuity,
      outboundTextLimit: input.prepared.setup.outboundTextLimit,
      ...(input.prepared.setup.pairingDeepLinkTemplate === undefined
        ? {}
        : { pairingDeepLinkTemplate: input.prepared.setup.pairingDeepLinkTemplate }),
      providerConnectionKey: input.prepared.setup.providerConnectionKey,
      providerConfigVersion: input.prepared.setup.providerConfigVersion,
      providerConfig: input.prepared.setup.providerConfig,
      integrationPrincipal: input.prepared.setup.integrationPrincipal,
    },
    providerPluginId: input.providerPluginId,
    providerContributionSelection: {
      contributionId: input.transferInput.providerSelection.contributor.contributionId,
      immutableGenerationId: input.transferInput.providerSelection.contributor.immutableGenerationId,
    },
    providerSetupInput: input.transferInput.providerSetupInput,
    transportOrigin: input.prepared.transportOrigin,
  };
  return withConversationConnectionLifecycle({
    row: input.row,
    current: replacementCurrent,
    lifecycle: input.lifecycle,
    updatedAt: input.now,
  });
}

/**
 * Replaces one exact retained connection authority without assigning a second
 * owner to provider setup, checkpoint progress, or old-transport stop custody.
 */
export async function transferConversationConnectionForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionTransferResult> {
  const transferInput = readAdmittedConnectionTransferInput(input);
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(transferInput.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) {
    throw pluginError('channels_connection_transfer_not_found', 'Connection transfer target does not exist.');
  }
  const current = readConversationConnectionUpdateRow({ row, connectionId: transferInput.connectionId });
  if (row.revision !== transferInput.expectedRevision) {
    if (isImmediateLostTransferCommit({ row, current, transferInput })) {
      return {
        kind: 'rejoined',
        connectionId: transferInput.connectionId,
        revision: row.revision,
        authorityEpoch: current.lifecycle.authorityEpoch,
      };
    }
    throw pluginError(
      'channels_connection_transfer_conflict',
      'Connection transfer requires the current retained row revision.',
      true,
    );
  }
  const initialFrozenOldStopRequest = createTransferStopRequest({
    connectionId: transferInput.connectionId,
    payload: current.payload,
    authorityEpoch: current.lifecycle.authorityEpoch + 1,
  });
  // This pure preflight rejects delete/pending custody before selected setup or
  // test can touch the provider. Final lifecycle facts are recomputed after
  // provider setup is admitted below.
  assertTransferStartAccepted(startConversationConnectionTransfer({
    current: current.lifecycle,
    pendingOldTransportStop: {
      predecessorCheckpointedPollInvocation: {
        connectionRevision: row.revision,
        authorityEpoch: current.lifecycle.authorityEpoch,
        transportOrigin: current.transportOrigin,
      },
      transportOrigin: current.transportOrigin,
      providerContributionSelection: current.providerContributionSelection,
      stopRequest: initialFrozenOldStopRequest,
    },
    replacement: {
      enabled: current.lifecycle.enabled,
      overlapSafety: current.lifecycle.overlapSafety,
      historyGap: current.lifecycle.historyGap,
    },
  }));

  const provider = await readCurrentSelectedProvider({
    context,
    selection: transferInput.providerSelection,
  });
  // Provider plugin identity is immutable across a transfer. Reject it before
  // setup so this Action cannot become a covert new-connection path.
  assertTransferProviderPluginIdentity({
    current,
    providerPluginId: provider.pluginId,
  });
  const prepared = await runProviderSetupAndTest({
    context,
    setupInput: transferInput,
    provider,
    connectionIdForTest: transferInput.connectionId,
  });
  if (prepared.kind === 'notReady') return prepared;
  // Setup/test are external effects. Every result path, including changed-origin
  // transfer, must re-read the exact incumbent before a later checkpoint or
  // retained-row CAS can act on the pre-effect authority.
  const postSetupRow = await collection.get(transferInput.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (postSetupRow === null) {
    throw pluginError(
      'channels_connection_transfer_conflict',
      'Connection transfer lost its retained-row currentness during provider setup.',
      true,
    );
  }
  const postSetupCurrent = readConversationConnectionUpdateRow({
    row: postSetupRow,
    connectionId: transferInput.connectionId,
  });
  if (postSetupRow.revision !== transferInput.expectedRevision) {
    if (isImmediateLostTransferCommit({
      row: postSetupRow,
      current: postSetupCurrent,
      transferInput,
    })) {
      return {
        kind: 'rejoined',
        connectionId: transferInput.connectionId,
        revision: postSetupRow.revision,
        authorityEpoch: postSetupCurrent.lifecycle.authorityEpoch,
      };
    }
    throw pluginError(
      'channels_connection_transfer_conflict',
      'Connection transfer lost its retained-row currentness during provider setup.',
      true,
    );
  }
  assertTransferImmutableConnectionIdentity({ current: postSetupCurrent, setup: prepared.setup });
  if (isRequestedTransferAlreadyCurrent({ current: postSetupCurrent, transferInput })
    && arePluginMachineExecutionOriginsEqual(postSetupCurrent.transportOrigin, prepared.transportOrigin)) {
    return {
      kind: 'rejoined',
      connectionId: transferInput.connectionId,
      revision: postSetupRow.revision,
      authorityEpoch: postSetupCurrent.lifecycle.authorityEpoch,
    };
  }

  const incumbentRow = postSetupRow;
  const incumbent = postSetupCurrent;
  const oldTransport = readTransferTransportKind(incumbent);
  const frozenOldStopRequest = createTransferStopRequest({
    connectionId: transferInput.connectionId,
    payload: incumbent.payload,
    authorityEpoch: incumbent.lifecycle.authorityEpoch + 1,
  });

  const checkpointCompatible = isCheckpointCompatibleTransfer({
    current: incumbent,
    oldTransport,
    transferInput,
    provider,
    setup: prepared.setup,
  });
  const now = Date.now();
  const checkpointFence = checkpointCompatible
    ? await prepareConversationCheckpointTransferFence({
      context,
      connectionId: transferInput.connectionId,
      routingIdentityKey: incumbent.routingIdentityKey,
      currentAuthorityEpoch: incumbent.lifecycle.authorityEpoch,
      nextAuthorityEpoch: incumbent.lifecycle.authorityEpoch + 1,
      now,
    })
    : undefined;
  const historyGap = checkpointFence === undefined
    ? incumbent.lifecycle.historyGap ?? { reportedAt: now, reason: 'providerHistoryUnavailable' as const }
    : null;
  const lifecycleStart = assertTransferStartAccepted(startConversationConnectionTransfer({
    current: incumbent.lifecycle,
    pendingOldTransportStop: {
      predecessorCheckpointedPollInvocation: {
        connectionRevision: incumbentRow.revision,
        authorityEpoch: incumbent.lifecycle.authorityEpoch,
        transportOrigin: incumbent.transportOrigin,
      },
      transportOrigin: incumbent.transportOrigin,
      providerContributionSelection: incumbent.providerContributionSelection,
      stopRequest: frozenOldStopRequest,
    },
    replacement: {
      enabled: incumbent.lifecycle.enabled,
      overlapSafety: prepared.setup.overlapSafety,
      historyGap,
    },
  }));

  // The selected immutable contributor is re-read after every external or
  // storage boundary; only that exact current generation may receive a write.
  const providerForPersistence = await readCurrentSelectedProvider({
    context,
    selection: transferInput.providerSelection,
  });
  if (providerForPersistence.pluginId !== provider.pluginId) {
    throw pluginError(
      'channels_connection_transfer_provider_currentness_changed',
      'The selected provider changed before connection transfer persistence.',
      true,
    );
  }
  assertTransferProviderPluginIdentity({ current: incumbent, providerPluginId: providerForPersistence.pluginId });
  assertTransferImmutableConnectionIdentity({ current: incumbent, setup: prepared.setup });

  const mutations: ChannelStateBatchMutation[] = [{
    kind: 'put',
    value: transferConnectionValue({
      row: incumbentRow,
      current: incumbent,
      transferInput,
      providerPluginId: providerForPersistence.pluginId,
      prepared,
      lifecycle: lifecycleStart.connection,
      now,
    }),
    expectedRevision: incumbentRow.revision,
  }];
  if (checkpointFence !== undefined) {
    mutations.push({
      kind: 'put',
      value: checkpointFence.value,
      expectedRevision: checkpointFence.expectedRevision,
    });
  }
  const result = await collection.batch(mutations, { signal: context.signal });
  assertNotAborted(context.signal);
  if (result.status === 'conflict') {
    throw pluginError(
      'channels_connection_transfer_conflict',
      'Connection transfer lost its retained-row compare-and-swap.',
      true,
    );
  }
  const persisted = result.results.find((entry) => (
    entry.rowId === transferInput.connectionId && entry.deleted === false
  ));
  if (persisted === undefined) {
    throw pluginError(
      'channels_connection_transfer_result_invalid',
      'Connection transfer did not return its retained connection result.',
      true,
    );
  }
  return {
    kind: 'transferPendingOldStop',
    connectionId: transferInput.connectionId,
    revision: persisted.revision,
    authorityEpoch: lifecycleStart.connection.authorityEpoch,
  };
}

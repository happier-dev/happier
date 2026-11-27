import {
  isPluginError,
  readPluginErrorRequestIdV1,
  PluginError,
  getPluginMachineExecutionOriginRef,
  type JsonValue,
  type PluginMachineMaterializationRefV1,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import { SessionAcceptedWorkspaceV1Schema, SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import { normalizeScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import { readSessionPullRequestBindingRows, readSessionPullRequestLinks } from './sessionPullRequestBindings.js';
import { persistConversationBindingCreation } from './bindingCreation.js';
import { selectSessionPullRequestRelations } from './sessionPullRequestRelations.js';
export { observeSessionPullRequestBindingAction } from './sessionPullRequestRelations.js';
import { parseSessionPullRequestUrl, sessionPullRequestUrl, type SessionPullRequestProvider } from './sessionPullRequestProvider.js';
import { archiveSessionPullRequestWatchAfterMerge } from './sessionPullRequestWatchLifecycle.js';
import { resolveSessionPullRequestFixResolutionProgress } from './sessionPullRequestWatchProgress.js';
import { arePluginMachineExecutionRoutingsEqual, isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import type {
  AdmittedTargetedOperationExecutionHandle,
  PluginActionResultById,
  PluginMachineExecutionOriginV1,
  PluginMachineExecutionRoutingV1,
} from '@happier-dev/plugin-sdk/actions';
import {
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  ConversationBindingReadResultV1Schema,
  type ConversationPairingReadInputV1,
  type ConversationPairingReadResultV1,
  ConversationSessionProjectionNoticeDismissResultV1Schema,
  isConversationConnectionCreateSelectableTransportV1,
  conversationConnectionWebhookSourceInstanceIdV1,
  ConversationConnectionTestInputV1Schema,
  ConversationConnectionTestResultV1Schema,
  ConversationEndpointResolveInputV1Schema,
  ConversationEndpointResolveResultV1Schema,
  ConversationProviderSetupOutcomeV1Schema,
  ConversationProviderSetupRemediationResultV1Schema,
  ConversationPrincipalResolveInputV1Schema,
  ConversationPrincipalResolveResultV1Schema,
  SessionPullRequestBindingInputV1Schema,
  SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_REF_V1,
  SessionPullRequestLinkCompletionResultV1Schema,
  type SessionPullRequestLinkCompletionFailureV1,
  type SessionPullRequestLinkCompletionInputV1,
  resolveSessionPullRequestLinksV1,
  type SessionPullRequestBindingResultV1,
  areConversationEndpointIdentitiesEqual,
  conversationBindingPolicyForOmittedFieldsV1,
  conversationThreadRouterAllowedPrincipalIdsV1,
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
  type ConversationBindingUpdateInputV1,
  type ConversationBindingUpdateResultV1,
  type ConversationConnectionCreateResultV1,
  type ConversationConnectionCreateInputV1,
  type ConversationConnectionDeleteInputV1,
  type ConversationConnectionPollRetryInputV1,
  type ConversationConnectionRetestInputV1,
  type ConversationConnectionRetestResultV1,
  type ConversationConnectionTestInputV1,
  type ConversationConnectionTransferInputV1,
  type ConversationConnectionTransferResultV1,
  type ConversationConnectionPrepareInputV1,
  type ConversationConnectionPrepareResultV1,
  type ConversationConnectionSetupRemediateInputV1,
  type ConversationProviderSetupRemediationResultV1,
  type ConversationSessionProjectionNoticeDismissInputV1,
  type ConversationSessionProjectionNoticeDismissResultV1,
  type ConversationConnectionUpdateInputV1,
  type ConversationTransportFactReportInputV1,
  type ConversationDeliveryResolveInputV1,
  type ConversationPairingCancelInputV1,
  type ConversationPairingCreateInputV1,
  type ConversationPairingFinalizeInputV1,
  type ConversationProviderSetupOutcomeV1,
  type ConversationProviderSetupRemediationV1,
  type ConversationProviderSetupResultV1,
  type ConversationConnectionHistoryGapFactV1,
  type ConversationBindingInputModeV1,
  type ConversationBindingTargetV1,
  type ConversationBindingV1,
  type ConversationSessionBindingTargetV1,
  type ConversationResolvedEndpointV1,
  type ConversationResolvedPrincipalV1,
  type ConversationTransportFactReportResultV1,
  type ConversationTransportKindV1,
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
import {
  assertConversationConnectionWebhookEndpointCorrespondence,
  buildConversationConnectionEndpointRequiredResult,
  CONVERSATION_CONNECTION_WEBHOOK_ENDPOINT_ENSURE_SETUP_V1,
  mintConversationConnectionWebhookEndpointAttemptIdentity,
  readCanonicalConversationWebhookEndpointId,
  convergeConversationConnectionWebhookEndpointTarget,
} from './connectionWebhookEndpoint.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { createConversationDiscussionProjectionFrontierRow } from './discussionProjection.js';
import {
  getConversationConnectionTransportOrigin,
  getConversationConnectionExecutionRouting,
  getSelfStampedPluginCallerExecutionOrigin,
  areConversationConnectionTransportOriginsEqual,
  CONVERSATION_CONNECTION_ORIGIN_MISMATCH,
  recordConversationConnectionHistoryGap,
  recordConversationConnectionProviderReadiness,
  startConversationConnectionDelete,
  startConversationConnectionTransfer,
  transitionConversationConnection,
  type ConversationConnectionEnabledResultV1,
  type ConversationConnectionLifecycleStateV1,
  type ConversationConnectionTransportOriginV1,
} from './connectionLifecycle.js';
import {
  hasCurrentConversationTransportCaller,
  hasCurrentConversationExecutionPlacement,
  isConversationConnectionPlacedForInvocation,
  readConversationBindingInputModesNoLongerDeliverable,
} from './reconciliation.js';
import {
  transitionConversationBinding,
  revokeConversationBindingPrincipals,
} from './bindingTransition.js';
import {
  isChannelStateJsonRecord as isJsonRecord,
  asChannelStateRow,
  ownChannelStateValue as own,
  readConversationBindingManagementRows,
  readConversationIngressAttentionPage,
  readConversationBindingUpdateRow,
  withConversationBindingPolicy,
  readConversationConnectionSharedEndpointInputModes,
  readConversationConnectionUpdateRow,
  isCurrentConversationConnectionForBinding,
  assertConversationBindingInputModeIsDeliverable,
  assertConversationBindingMutationCanPersist,
  commitConversationBindingMutation,
  mutateConversationConnectionLifecycleInAccountCollection,
  setConversationBindingEnabledInAccountCollection,
  updateConversationBindingPolicyInAccountCollection,
  updateConversationConnectionInAccountCollection,
  withConversationConnectionLifecycle,
  type ChannelStateJsonRecord as JsonRecord,
  type ChannelStateRow as StateRow,
  type ConversationBindingUpdateRow,
  type ConversationConnectionUpdateRow,
} from './accountLocalBindingPolicy.js';
import { withChannelStateDeleteFinalizationDueAt, withChannelStateSessionIdentity } from './collectionMigrations.js';
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
  dismissConversationSessionProjectionNotice,
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
  isConversationSenderConfiguredForEndpoint,
  recordConversationConnectionReceiveFailureForInvocation,
} from './ingress.js';
import {
  resolveConversationOutwardDeliveryCustodyInAccountCollection,
  type ConversationDeliveryResolutionDecision,
  settleConversationOutwardDeliveriesForBindingDeletion,
  settleConversationOutwardDeliveriesForConnectionDeletion,
} from './outwardDelivery.js';
import {
  readCurrentProviderContributionForPersistedSelection,
  readSelectedCurrentProviderContribution,
  readSessionPullRequestProvider,
} from './providerContributions.js';
import { recommendConversationRecovery } from './recoveryRecommendation.js';

export {
  readConversationBindingManagementRows,
  readConversationIngressAttentionPage,
  setConversationBindingEnabledInAccountCollection,
  updateConversationBindingPolicyInAccountCollection,
  updateConversationConnectionInAccountCollection,
};

type ConnectionTransportOrigin = ConversationConnectionTransportOriginV1;
type ConversationConnectionEndpointRequiredResult = Extract<
  ConversationConnectionCreateResultV1,
  Readonly<{ kind: 'endpointRequired' }>
>;
type ConversationConnectionCreateResult =
  | Readonly<{ kind: 'created'; connectionId: string }>
  | Readonly<{ kind: 'rejoined'; connectionId: string }>
  | ConversationConnectionEndpointRequiredResult
  | Extract<ProviderConnectionPreparation, Readonly<{ kind: 'notReady' }>>;
/** The endpoint facts a durable-push continuation writes into the connection row. */
type ConversationConnectionWebhookEndpoint = Readonly<{
  webhookContributionRef: Readonly<{ pluginId: string; localId: string }>;
  webhookEndpointId: string;
  webhookSourceInstanceId: string;
}>;
type ConversationConnectionTransferResult = ConversationConnectionTransferResultV1;
type ConversationConnectionSetupAndTestInput = Pick<
  ConversationConnectionCreateInputV1,
  'providerSelection' | 'providerSetupInput' | 'credentialRef' | 'selectedTransport'
>;
type CurrentProvider = Readonly<{
  pluginId: string;
  setup: AdmittedTargetedOperationExecutionHandle;
  setupRemediation: AdmittedTargetedOperationExecutionHandle | undefined;
  connectionTest: AdmittedTargetedOperationExecutionHandle;
  observationsPoll: AdmittedTargetedOperationExecutionHandle | undefined;
  endpointResolve: AdmittedTargetedOperationExecutionHandle | undefined;
  principalResolve: AdmittedTargetedOperationExecutionHandle | undefined;
}>;
type PersistedConversationConnection = Readonly<{
  kind: 'created' | 'rejoined';
  connectionId: string;
  connectionRow: StateRow;
}>;
type PreparedConversationConnectionResult =
  | Exclude<ConversationConnectionCreateResult, Readonly<{ kind: 'created' | 'rejoined' }>>
  | PersistedConversationConnection;
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
  resolution: ConversationDeliveryResolutionDecision;
}>;
type ConversationConnectionDeleteResult = Readonly<{
  kind: 'deleteFinalizing' | 'rejoined';
  connectionId: string;
  revision: number;
  authorityEpoch: number;
  acceptedPossibleLoss: false;
}>;
type ConversationBindingUpdateResult = ConversationBindingUpdateResultV1;
type ConversationBindingCreateResult = ConversationBindingCreateResultV1;
export type ConversationPairingManager = ReturnType<typeof createConversationPairingManager>;
type ProviderConnectionPreparation =
  | Extract<ReturnType<typeof ConversationConnectionTestResultV1Schema.parse>, Readonly<{ kind: 'notReady' }>>
  | Readonly<{
    kind: 'ready';
    setup: ConversationProviderSetupResultV1;
    transportOrigin: PluginMachineExecutionOriginV1;
  }>;
type ProviderConnectionTestRefusal = Extract<ProviderConnectionPreparation, { kind: 'notReady' }>;

const prLinkConnectionTestRemedies = {
  credentialInvalid: 'Reconnect the repository account in Connected Accounts, then link the existing pull request to this Session.',
  permissionMissing: 'Give the connected account access to read repository comments, then link the existing pull request to this Session.',
  network: 'Check that the Session Machine can reach the repository provider, then link the existing pull request to this Session.',
  rateLimited: 'Wait for the repository provider’s rate limit to reset, then link the existing pull request to this Session.',
  providerConflict: 'Resolve the conflicting integration with the repository provider, then link the existing pull request to this Session.',
  unsupported: 'Use a repository connection that supports comment polling, then link the existing pull request to this Session.',
  invalidConfiguration: 'Verify that the connected account can access this repository, then link the existing pull request to this Session.',
} satisfies Record<ProviderConnectionTestRefusal['reason'], string>;

function refuseSessionPullRequestConnection(
  context: PluginInvocationContext,
  stage: 'test' | 'retain' | 'bind',
  reason?: ProviderConnectionTestRefusal['reason'],
): PluginError {
  const code = 'channels_pr_link_connection_not_ready';
  const requestId = context.requestId ?? context.invocationId;
  const remedy = reason === undefined ? 'Link the existing pull request to this Session again.' : prLinkConnectionTestRemedies[reason];
  const details = { ...(reason === undefined ? {} : { reason }), ...(requestId === undefined ? {} : { requestId }) };
  context.services.logger.warn('[Channels] PR link connection unavailable', { code, stage, ...details });
  return new PluginError({ code, message: remedy, retryable: true, details: { ...details, remedy } });
}

type ProviderConnectionSetup =
  | ConversationProviderSetupRemediationV1
  | Readonly<{
    kind: 'ready';
    setup: ConversationProviderSetupResultV1;
    transportOrigin: PluginMachineExecutionOriginV1;
  }>;
type ConversationStorageContext = Pick<PluginInvocationContext, 'services' | 'signal'>;
type ChannelStateCollection = ReturnType<PluginAccountStorageScope['collection']>;
type ChannelStateBatchMutation = Parameters<ChannelStateCollection['batch']>[0][number];
type BindingResolutionProvider = Awaited<ReturnType<typeof readCurrentProviderContributionForPersistedSelection>>;
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
  row: StateRow;
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
  sharedEndpointInputModes?: readonly ConversationBindingInputModeV1[];
}>;
type BindingEndpointResolution = BindingResolutionTerminal | BindingEndpointCandidates;
type BindingPrincipalCandidates = Readonly<{
  kind: 'principalCandidates';
  candidates: readonly ConversationResolvedPrincipalV1[];
}>;
type BindingPrincipalResolution = BindingResolutionTerminal | BindingPrincipalCandidates;
type BindingEndpointSelectionResolution = BindingResolutionTerminal | Readonly<{
  kind: 'endpointSelected';
  endpoint: ConversationResolvedEndpointV1;
  /** The provider-authenticated shared-endpoint delivery truth for this connection. */
  sharedEndpointInputModes?: readonly ConversationBindingInputModeV1[];
}>;
type BindingAudienceResolution = BindingResolutionTerminal | Readonly<{
  kind: 'ready';
  endpoint: ConversationResolvedEndpointV1;
  allowedPrincipalIds: readonly string[];
  /** The provider-authenticated shared-endpoint delivery truth for this connection. */
  sharedEndpointInputModes?: readonly ConversationBindingInputModeV1[];
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

/**
 * The host admits each Action's strict schema before invoking its handler.
 * Preserve the runtime's generic JSON signature without repeating structural
 * parsing inside every Action owner.
 */
function admittedActionInput<T>(input: JsonValue): T {
  return input as T;
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
  expectedConnection: number | ConversationConnectionUpdateRow;
  signal: AbortSignal;
}>): Promise<BindingResolutionConnectionRead> {
  assertNotAborted(input.signal);
  const row = await input.collection.get(input.connectionId, { signal: input.signal });
  assertNotAborted(input.signal);
  if (row === null) return bindingResolutionUnavailable('connectionNotFound');
  return admitBindingResolutionConnection({ ...input, row });
}

/** A rejoined row is admitted once; a new row comes from the write result. */
function admitBindingResolutionConnection(input: Readonly<{
  row: StateRow;
  connectionId: string;
  expectedConnection?: number | ConversationConnectionUpdateRow;
}>): BindingResolutionConnectionRead {
  const connection = readConversationConnectionUpdateRow({
    row: input.row,
    connectionId: input.connectionId,
  });
  if (input.expectedConnection !== undefined
    && !isCurrentConversationConnectionForBinding(connection, input.expectedConnection)) return bindingResolutionStale();
  if (connection.lifecycle.deletionState !== 'none') {
    return bindingResolutionUnavailable('connectionDeleting');
  }
  return { kind: 'current', connection, row: input.row };
}

/** The provider is sourced only from the current admission snapshot, never a stored Action handle. */
async function readCurrentBindingResolutionProvider(input: Readonly<{
  context: PluginInvocationContext;
  connection: ConversationConnectionUpdateRow;
}>): Promise<BindingResolutionProvider | null> {
  try {
    return await readCurrentProviderContributionForPersistedSelection({
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
    ? provider.operations.endpointResolve
    : provider.operations.principalResolve;
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
 * Re-read connection authority and the admitted provider after an observation.
 * The contribution owner follows the same stable provider identity across reloads.
 */
async function rereadBindingResolutionAfterProviderEffect(input: Readonly<{
  collection: ChannelStateCollection;
  connectionId: string;
  expectedConnection: number | ConversationConnectionUpdateRow;
  context: PluginInvocationContext;
}>): Promise<BindingResolutionConnectionRead> {
  const connectionRead = await readCurrentBindingResolutionConnection({
    collection: input.collection,
    connectionId: input.connectionId,
    expectedConnection: input.expectedConnection,
    signal: input.context.signal,
  });
  if (connectionRead.kind !== 'current') return bindingResolutionStale();
  const providerAfter = await readCurrentBindingResolutionProvider({
    context: input.context,
    connection: connectionRead.connection,
  });
  if (providerAfter === null) return bindingResolutionUnavailable('providerUnavailable');
  return connectionRead;
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
    expectedConnection: input.expectedConnectionRevision,
    signal: input.context.signal,
  });
  if (connectionRead.kind !== 'current') return connectionRead;

  const provider = await readCurrentBindingResolutionProvider({
    context: input.context,
    connection: connectionRead.connection,
  });
  if (provider === null) return bindingResolutionUnavailable('providerUnavailable');
  const endpointResolve = readBindingResolutionAction(provider, 'endpointResolve');
  const resolution = await resolveBindingEndpointCandidatesForConnection({
    ...input, connection: connectionRead.connection, endpointResolve,
  });
  if (resolution.kind === 'unavailable') return resolution;
  const reread = await rereadBindingResolutionAfterProviderEffect({
    collection,
    connectionId: input.connectionId,
    expectedConnection: input.expectedConnectionRevision,
    context: input.context,
  });
  return reread.kind === 'current' ? resolution : reread;
}

/** Endpoint acquisition consumes a request-local admitted connection/provider. */
async function resolveBindingEndpointCandidatesForConnection(input: Readonly<{
  connectionId: string;
  connection: ConversationConnectionUpdateRow;
  endpointResolve: AdmittedTargetedOperationExecutionHandle | undefined;
  query: string;
  kinds: ConversationBindingEndpointSelection['kinds'];
  context: PluginInvocationContext;
}>): Promise<BindingEndpointResolution> {
  if (input.endpointResolve === undefined) return bindingResolutionUnavailable('endpointResolveUnsupported');
  const execution = await input.context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    input.endpointResolve,
    readEndpointResolveRequest({
      connectionId: input.connectionId,
      connection: input.connection,
      query: input.query,
      kinds: input.kinds,
    }),
    {
      signal: input.context.signal,
      expectedExecutionRouting: getConversationConnectionExecutionRouting(input.connection.transportOrigin, input.connection.providerPluginId),
    },
  );
  assertNotAborted(input.context.signal);

  const result = readEndpointResolveResult(execution.result);
  if (result.kind === 'notReady') return result;
  const sharedEndpointInputModes = readConversationConnectionSharedEndpointInputModes(
    input.connection.payload,
  );
  return {
    kind: 'endpointCandidates',
    candidates: result.candidates,
    ...(sharedEndpointInputModes === undefined ? {} : { sharedEndpointInputModes }),
  };
}

/** Resolves principals only after the caller's endpoint selection is freshly re-proven. */
async function resolveBindingPrincipalCandidates(input: Readonly<{
  connectionId: string;
  expectedConnectionRevision: number;
  endpointSelection: ConversationBindingEndpointSelection;
  query: string;
  context: PluginInvocationContext;
}>): Promise<BindingPrincipalResolution> {
  const endpointResolution = await resolveBindingEndpointSelection({
    connectionId: input.connectionId,
    expectedConnectionRevision: input.expectedConnectionRevision,
    endpointSelection: input.endpointSelection,
    context: input.context,
  });
  if (endpointResolution.kind !== 'endpointSelected') return endpointResolution;

  return await resolveBindingPrincipalCandidatesForEndpoint({
    connectionId: input.connectionId,
    expectedConnectionRevision: input.expectedConnectionRevision,
    endpoint: endpointResolution.endpoint,
    query: input.query,
    context: input.context,
  });
}

/** Uses an endpoint proven immediately before this provider effect. */
async function resolveBindingPrincipalCandidatesForEndpoint(input: Readonly<{
  connectionId: string;
  expectedConnectionRevision: number;
  endpoint: ConversationResolvedEndpointV1;
  query: string;
  context: PluginInvocationContext;
}>): Promise<BindingPrincipalResolution> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const connectionRead = await readCurrentBindingResolutionConnection({
    collection,
    connectionId: input.connectionId,
    expectedConnection: input.expectedConnectionRevision,
    signal: input.context.signal,
  });
  if (connectionRead.kind !== 'current') return connectionRead;
  const provider = await readCurrentBindingResolutionProvider({
    context: input.context,
    connection: connectionRead.connection,
  });
  if (provider === null) return bindingResolutionUnavailable('providerUnavailable');
  const principalResolve = readBindingResolutionAction(provider, 'principalResolve');
  const resolution = await resolveBindingPrincipalCandidatesForConnection({
    ...input, connection: connectionRead.connection, principalResolve,
  });
  if (resolution.kind === 'unavailable') return resolution;
  const reread = await rereadBindingResolutionAfterProviderEffect({
    collection,
    connectionId: input.connectionId,
    expectedConnection: input.expectedConnectionRevision,
    context: input.context,
  });
  return reread.kind === 'current' ? resolution : reread;
}

/** Principal acquisition consumes the endpoint and connection already admitted. */
async function resolveBindingPrincipalCandidatesForConnection(input: Readonly<{
  connectionId: string;
  connection: ConversationConnectionUpdateRow;
  principalResolve: AdmittedTargetedOperationExecutionHandle | undefined;
  endpoint: ConversationResolvedEndpointV1;
  query: string;
  context: PluginInvocationContext;
}>): Promise<BindingPrincipalResolution> {
  if (input.principalResolve === undefined) return bindingResolutionUnavailable('principalResolveUnsupported');
  const execution = await input.context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    input.principalResolve,
    readPrincipalResolveRequest({
      connectionId: input.connectionId,
      connection: input.connection,
      endpoint: input.endpoint,
      query: input.query,
    }),
    {
      signal: input.context.signal,
      expectedExecutionRouting: getConversationConnectionExecutionRouting(input.connection.transportOrigin, input.connection.providerPluginId),
    },
  );
  assertNotAborted(input.context.signal);

  const result = readPrincipalResolveResult(execution.result);
  return result.kind === 'notReady'
    ? result
    : { kind: 'principalCandidates', candidates: result.candidates };
}

/**
 * One persisted audience must be selected from the exact current provider
 * candidates. The selection is never treated as a durable provider identity.
 *
 * Every caller that needs the caller's chosen endpoint — binding create,
 * binding update, principal resolution, and pairing create — reaches it
 * through this one resolver; the operation only names which error domain a
 * rejected selection belongs to.
 */
async function resolveBindingEndpointSelection(input: Readonly<{
  connectionId: string;
  expectedConnectionRevision: number;
  endpointSelection: ConversationBindingEndpointSelection;
  context: PluginInvocationContext;
}>): Promise<BindingEndpointSelectionResolution> {
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
  return {
    kind: 'endpointSelected',
    endpoint,
    ...(endpointResolution.sharedEndpointInputModes === undefined
      ? {}
      : { sharedEndpointInputModes: endpointResolution.sharedEndpointInputModes }),
  };
}

async function resolveBindingAudienceSelection(input: Readonly<{
  connectionId: string;
  expectedConnectionRevision: number;
  endpointSelection: NonNullable<
    ConversationBindingUpdateInputV1['audienceSelection']
  >['endpointSelection'];
  principalSelection: NonNullable<
    ConversationBindingUpdateInputV1['audienceSelection']
  >['principalSelection'];
  operation: 'channels_binding_create' | 'channels_binding_update';
  context: PluginInvocationContext;
}>): Promise<BindingAudienceResolution> {
  assertBindingPrincipalSelectionIdsAreUnique(input.principalSelection, input.operation);
  const endpointResolution = await resolveBindingEndpointSelection({
    connectionId: input.connectionId,
    expectedConnectionRevision: input.expectedConnectionRevision,
    endpointSelection: input.endpointSelection,
    context: input.context,
  });
  if (endpointResolution.kind !== 'endpointSelected') return endpointResolution;
  const endpoint = endpointResolution.endpoint;

  const resolutions = new Map<string, Extract<BindingPrincipalResolution, { kind: 'principalCandidates' }>>();
  const allowedPrincipalIds: string[] = [];
  for (const selection of input.principalSelection.selected) {
    const query = selection.query ?? input.principalSelection.query;
    let principalResolution = resolutions.get(query);
    if (principalResolution === undefined) {
      const resolution = await resolveBindingPrincipalCandidatesForEndpoint({
        connectionId: input.connectionId,
        expectedConnectionRevision: input.expectedConnectionRevision,
        endpoint,
        query,
        context: input.context,
      });
      if (resolution.kind !== 'principalCandidates') return resolution;
      principalResolution = resolution;
      resolutions.set(query, resolution);
    }
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
    ...(endpointResolution.sharedEndpointInputModes === undefined
      ? {}
      : { sharedEndpointInputModes: endpointResolution.sharedEndpointInputModes }),
  };
}

/** Read-only binding setup resolution; private provider connection facts never leave this owner. */
export async function resolveConversationBindingForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationBindingResolveResultV1> {
  const resolveInput = admittedActionInput<ConversationBindingResolveInputV1>(input);
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
  const readInput = admittedActionInput<ConversationBindingReadInputV1>(input);
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  if ('automationId' in readInput) {
    const { bindings } = await readConversationBindingManagementRows({ collection,
      automationId: readInput.automationId, signal: context.signal });
    return ConversationBindingReadResultV1Schema.parse({ kind: 'automationAssociation',
      automationId: readInput.automationId, association: bindings.length === 0 ? 'absent' : 'bound' });
  }
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
    if (isPluginError(cause) && cause.code === 'channels_binding_target_unavailable') throw cause;
    throw new PluginError({
      code: 'channels_binding_read_corrupt',
      message: 'Binding read target is not a complete valid retained binding.',
    }, { cause });
  }
}



function hasSamePersistedProviderContributionSelection(input: Readonly<{
  persisted: ConversationConnectionUpdateRow['providerContributionSelection'];
  requested: ConversationConnectionTransferInputV1['providerSelection'];
}>): boolean {
  return input.persisted.contributionId === input.requested.contributor.contributionId;
}

/**
 * The one reader of a saved connection's live transport kind. It answers only
 * for the row as it stands: once a transfer commits, the retired transport is
 * owned by the frozen custody slot's `predecessorTransportKind`, never by a
 * second read of this replaced field.
 */
function readConnectionTransportKind(
  current: ConversationConnectionUpdateRow,
  unsupported: Readonly<{ code: string; message: string }>,
): ConversationTransportKindV1 {
  const transport = own(current.payload, 'transport');
  if (!isJsonRecord(transport)
    || (transport.kind !== 'checkpointedPull'
      && transport.kind !== 'socket'
      && transport.kind !== 'durablePush')) {
    throw pluginError(unsupported.code, unsupported.message);
  }
  return transport.kind;
}

function readTransferTransportKind(
  current: ConversationConnectionUpdateRow,
): ConversationTransportKindV1 {
  return readConnectionTransportKind(current, {
    code: 'channels_connection_transfer_transport_unsupported',
    message: 'Connection transfer found an unsupported retained transport.',
  });
}

/** Reads the exact generic endpoint facts retained on a durable-push row. */
function readDurablePushTransferEndpoint(input: Readonly<{
  current: ConversationConnectionUpdateRow;
  connectionId: string;
}>): ConversationConnectionWebhookEndpoint {
  const transport = own(input.current.payload, 'transport');
  if (!isJsonRecord(transport) || transport.kind !== 'durablePush') {
    throw pluginError(
      'channels_connection_transfer_transport_unsupported',
      'Connection transfer expected a retained durable-push transport.',
    );
  }
  const contribution = own(transport, 'webhookContributionRef');
  const webhookEndpointId = own(transport, 'webhookEndpointId');
  const webhookSourceInstanceId = own(transport, 'webhookSourceInstanceId');
  if (!isJsonRecord(contribution)
    || typeof contribution.pluginId !== 'string'
    || typeof contribution.localId !== 'string'
    || typeof webhookEndpointId !== 'string'
    || typeof webhookSourceInstanceId !== 'string'
    || webhookSourceInstanceId !== conversationConnectionWebhookSourceInstanceIdV1(input.connectionId)) {
    throw pluginError(
      'channels_connection_transfer_corrupt',
      'The retained durable-push connection is missing its exact endpoint correspondence facts.',
    );
  }
  return {
    webhookContributionRef: { pluginId: contribution.pluginId, localId: contribution.localId },
    webhookEndpointId,
    webhookSourceInstanceId,
  };
}

/**
 * The one reader of a saved connection's immutable provider identity.
 *
 * Transfer, delete finalization, and retest all decide against the same two
 * persisted facts — `providerConnectionKey` and `integrationPrincipal.id` — and
 * only their operation-scoped corrupt-row error identity differs. Keeping one
 * reader is what stops a caller from comparing a subset of the tuple.
 */
function readImmutableConnectionIdentity(
  current: ConversationConnectionUpdateRow,
  corrupt: Readonly<{ code: string; message: string }>,
): Readonly<{
  providerConnectionKey: string;
  integrationPrincipalId: string;
}> {
  const providerConnectionKey = own(current.payload, 'providerConnectionKey');
  const integrationPrincipal = own(current.payload, 'integrationPrincipal');
  const integrationPrincipalId = isJsonRecord(integrationPrincipal)
    ? own(integrationPrincipal, 'id')
    : undefined;
  if (typeof providerConnectionKey !== 'string' || typeof integrationPrincipalId !== 'string') {
    throw pluginError(corrupt.code, corrupt.message);
  }
  return { providerConnectionKey, integrationPrincipalId };
}

function readTransferImmutableConnectionIdentity(current: ConversationConnectionUpdateRow): Readonly<{
  providerConnectionKey: string;
  integrationPrincipalId: string;
}> {
  return readImmutableConnectionIdentity(current, {
    code: 'channels_connection_transfer_corrupt',
    message: 'Connection transfer could not read the retained immutable provider identity.',
  });
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
    && transport.kind === input.transferInput.selectedTransport
    && (
      input.transferInput.selectedTransport !== 'durablePush'
      // A durable-push→durable-push transfer keeps its retained endpoint and
      // is refused an endpoint continuation, so only a request that carries
      // one has an endpoint identity to compare.
      || input.transferInput.endpointContinuation === undefined
      || own(transport, 'webhookEndpointId')
        === input.transferInput.endpointContinuation.webhookEndpointId
    );
}

function assertTransferStartAccepted(input: ReturnType<typeof startConversationConnectionTransfer>): Extract<
  ReturnType<typeof startConversationConnectionTransfer>, Readonly<{ kind: 'transferred' }>
> {
  if (input.kind === 'transferred') return input;
  throw pluginError(
    input.code === 'deleteInProgress' ? 'channels_connection_transfer_delete_in_progress' : 'channels_connection_transfer_authority_epoch_exhausted',
    input.code === 'deleteInProgress'
      ? 'Connection transfer cannot replace a connection while deletion is in progress.'
      : 'Connection transfer cannot advance this connection authority further.',
    input.code === 'deleteInProgress',
  );
}

function sameStringSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameConversationBindingTarget(
  left: ConversationBindingTargetV1,
  right: ConversationBindingTargetV1,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'threadRouter' && right.kind === 'threadRouter') return pluginJsonValuesEqual(left, right);
  if (left.kind === 'discussion' && right.kind === 'discussion') return left.discussionId === right.discussionId;
  if (left.kind === 'automation' && right.kind === 'automation') {
    return left.automationId === right.automationId
      && pluginJsonValuesEqual(left.scopedTrigger ?? null, right.scopedTrigger ?? null)
      && left.policy.resultDelivery === right.policy.resultDelivery;
  }
  if (left.kind !== 'session' || right.kind !== 'session') return false;
  if (left.sessionId !== right.sessionId
    || !pluginJsonValuesEqual(left.pullRequestLink ?? null, right.pullRequestLink ?? null)
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
  executionOrigin: PluginMachineExecutionRoutingV1;
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
    executionOrigin: getConversationConnectionExecutionRouting(current.transportOrigin, current.providerPluginId),
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
    !(await hasConversationCheckpointedPullBaseline({
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
  target: Extract<ConversationBindingTargetV1, Readonly<{ kind: 'automation' }>>,
  context: PluginInvocationContext,
): Promise<PluginActionResultById['automation.conversation.target.verify']> {
  const verification = await context.services.actions.execute(
    'automation.conversation.target.verify',
    {
      automationId: target.automationId,
      ...(target.scopedTrigger === undefined ? {} : { scopedTrigger: {
        sessionId: target.scopedTrigger.sessionId,
        triggerId: target.scopedTrigger.triggerId,
        triggerRevision: target.scopedTrigger.triggerRevision,
        triggerKind: target.scopedTrigger.triggerKind,
        pullRequest: target.scopedTrigger.pullRequest,
      } }),
      ...(target.policy.resultDelivery === 'finalResult'
        ? { resultDelivery: 'finalResult' as const }
        : {}),
    },
    { signal: context.signal },
  );
  assertNotAborted(context.signal);
  // A policy deferral means Automation never verified this target. It is not a
  // verdict, so it must not be recorded as `notVerified` with a reason the
  // owner did not give; the binding write fails closed and retryable instead.
  if (isPluginActionApprovalRequestCreated(verification)) {
    throw pluginError(
      'channels_automation_target_verification_unavailable',
      'The Workflow target could not be verified for this conversation binding.',
      true,
    );
  }
  return verification;
}

/**
 * Automation owns target currentness and final-result eligibility. Channels
 * asks the host-stamped generic Action immediately before persistence and keeps
 * only the stable Automation identity plus result-delivery policy.
 */
async function resolveBindingTargetForPersistence(
  target: ConversationBindingTargetV1,
  context: PluginInvocationContext,
  resolvedPrincipalIds?: readonly string[],
): Promise<ConversationBindingTargetV1 | ConversationAutomationTargetNotVerifiedResult> {
  if (target.kind === 'threadRouter' && (resolvedPrincipalIds === undefined
    || conversationThreadRouterAllowedPrincipalIdsV1(target).some((id) => !resolvedPrincipalIds.includes(id)))) {
    throw pluginError('channels_router_principal_not_resolved', 'Every router group member must be resolved for this connection before persistence.');
  }
  if (target.kind !== 'automation') return target;
  // A conversation binding is an additional invocation source for an
  // Automation the Account already owns: several bindings may name the same
  // target, so persistence only asks whether that target is still current.
  const verification = await verifyAutomationBindingTarget(target, context);
  if (verification.kind === 'notVerified') return verification;
  return {
    kind: 'automation',
    automationId: target.automationId,
    policy: target.policy,
    ...(target.scopedTrigger === undefined ? {} : { scopedTrigger: target.scopedTrigger }),
  };
}

/** Early pairing verification is feedback only; finalization must reverify. */
async function verifyPairingTargetForFeedback(
  target: ConversationBindingTargetV1,
  context: PluginInvocationContext,
): Promise<ConversationAutomationTargetNotVerifiedResult | null> {
  if (target.kind === 'session' || target.kind === 'discussion') return null;
  if (target.kind === 'threadRouter') {
    assertPairingRouterBootstrapTarget(target);
    return null;
  }
  const verification = await verifyAutomationBindingTarget(target, context);
  return verification.kind === 'notVerified' ? verification : null;
}

/** Empty membership exists only in a frozen pairing draft, never in a saved router. */
function assertPairingRouterBootstrapTarget(
  target: Extract<ConversationBindingTargetV1, { kind: 'threadRouter' }>,
): void {
  if (target.principalGroups.length !== 1 || target.principalGroups[0]?.principalIds.length !== 0) {
    throw pluginError(
      'channels_pairing_router_bootstrap_invalid',
      'Router pairing requires exactly one named group with no supplied members.',
    );
  }
}

type ConversationBindingRowCreateInput = Readonly<{
  bindingId: string;
  parentBindingId?: string;
  automaticTriggerId?: string;
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
    ...(input.parentBindingId === undefined ? {} : { parentBindingId: input.parentBindingId }),
    endpoint: input.endpoint,
    target: input.target,
    allowedPrincipalIds: input.target.kind === 'threadRouter' ? conversationThreadRouterAllowedPrincipalIdsV1(input.target) : [...input.allowedPrincipalIds],
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
    row: withChannelStateSessionIdentity({
      [CHANNEL_STATE_FIELD.id]: binding.id,
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.binding,
      [CHANNEL_STATE_FIELD.version]: binding.v,
      [CHANNEL_STATE_FIELD.connectionId]: binding.connectionId,
      [CHANNEL_STATE_FIELD.bindingId]: binding.id,
      [CHANNEL_STATE_FIELD.createdAt]: binding.createdAt,
      [CHANNEL_STATE_FIELD.updatedAt]: binding.updatedAt,
      payload: {
        ...(binding.parentBindingId === undefined ? {} : { parentBindingId: binding.parentBindingId }),
        ...(input.automaticTriggerId === undefined ? {} : { automaticTriggerId: input.automaticTriggerId }),
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
    }, binding.target),
  };
}

/** New rows validate their mutable policy through the same canonical transition as updates. */
function assertNewConversationBindingCanPersist(binding: ConversationBindingV1): void {
  const validation = transitionConversationBinding({
    current: binding,
    requested: {
      connectionId: binding.connectionId,
      ...(binding.parentBindingId === undefined ? {} : { parentBindingId: binding.parentBindingId }),
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
  if (validation.code === 'routerGroupNotFound') throw pluginError('channels_router_group_not_found', 'A route must name a configured principal group or any.');
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
  if (input.target.kind === 'discussion') {
    const baseline = await input.context.services.actions.execute('discussion.read', {
      discussionId: input.target.discussionId, limit: 1,
    }, { signal: input.context.signal });
    if (isPluginActionApprovalRequestCreated(baseline)) throw pluginError(
      'channels_binding_discussion_projection_baseline_unavailable', 'The Discussion read is awaiting approval.', true);
    return createConversationDiscussionProjectionFrontierRow({ bindingId: input.bindingId,
      targetDiscussionId: input.target.discussionId, lastScannedSeq: baseline.messageSeq, now: Date.now() });
  }
  if (input.target.kind !== 'session') return null;
  const baseline = await readConversationSessionProjectionNoHistoryBaseline({
    actions: input.context.services.actions,
    sessionId: input.target.sessionId,
    signal: input.context.signal,
  });
  assertNotAborted(input.context.signal);
  if (baseline.kind !== 'ready') {
    throw new PluginError({
      code: baseline.kind === 'unavailable' && baseline.actionErrorCode !== undefined
        ? baseline.actionErrorCode : 'channels_binding_session_projection_baseline_unavailable',
      message: 'The Session transcript tail could not be established before binding it to a Conversation Channel.',
      retryable: baseline.kind === 'retry' || (baseline.kind === 'unavailable' && baseline.retryable === true),
      details: { reason: baseline.reason },
    });
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
  if (next.kind === 'discussion') return previous.kind !== 'discussion' || previous.discussionId !== next.discussionId;
  return next.kind === 'session'
    && (previous.kind !== 'session' || previous.sessionId !== next.sessionId);
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
    ...conversationBindingPolicyForOmittedFieldsV1(input.endpoint.audience),
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
  if (connectionRow === null) {
    return { kind: 'staleConnectionRevision' };
  }
  const connection = readConversationConnectionUpdateRow({ row: connectionRow, connectionId: input.connectionId });
  if (connection.lifecycle.authorityEpoch !== input.expectedConnectionAuthorityEpoch) return { kind: 'staleConnectionRevision' };
  if (connection.lifecycle.deletionState !== 'none') return { kind: 'staleConnectionRevision' };
  if (!arePluginMachineExecutionRoutingsEqual(
    getConversationConnectionExecutionRouting(connection.transportOrigin, connection.providerPluginId),
    input.executionOrigin,
  )) {
    return { kind: 'wrongMaterialization' };
  }
  // Pairing proposals freeze only a caller precondition. Recheck it after the
  // proposal claim and current connection/materialization checks, immediately
  // before the guarded Account write.
  let provedTarget = input.target;
  if (provedTarget.kind === 'threadRouter') {
    assertPairingRouterBootstrapTarget(provedTarget);
    provedTarget = {
      ...provedTarget,
      principalGroups: provedTarget.principalGroups.map(group => ({ ...group, principalIds: [input.principalId] })),
    };
  }
  const target = await resolveBindingTargetForPersistence(provedTarget, context, [input.principalId]);
  if (target.kind === 'notVerified') {
    if (input.target.kind !== 'automation') return target;
    // A prior attempt may have committed before its response was lost. The
    // verifier still runs on every finalize attempt, but later target removal
    // cannot hide an already-created row that exactly matches the frozen
    // proposal and stable Automation identity.
    const existing = await collection.get(input.bindingId, { signal: context.signal });
    assertNotAborted(context.signal);
    if (existing === null) return target;
    const rejoined = projectConversationBinding({ row: existing, bindingId: input.bindingId });
    const expected = createPairingBindingCandidate(input, {
      kind: 'automation',
      automationId: input.target.automationId,
      policy: input.target.policy,
      ...(input.target.scopedTrigger === undefined ? {} : { scopedTrigger: input.target.scopedTrigger }),
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
  const finalRow = await collection.get(input.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (finalRow === null) return { kind: 'staleConnectionRevision' };
  const finalCurrent = readConversationConnectionUpdateRow({ row: finalRow, connectionId: input.connectionId });
  if (finalCurrent.lifecycle.authorityEpoch !== input.expectedConnectionAuthorityEpoch
    || finalCurrent.lifecycle.deletionState !== 'none') return { kind: 'staleConnectionRevision' };
  if (!arePluginMachineExecutionRoutingsEqual(
    getConversationConnectionExecutionRouting(finalCurrent.transportOrigin, finalCurrent.providerPluginId),
    input.executionOrigin,
  )) return { kind: 'wrongMaterialization' };
  const result = await collection.batch([
    { kind: 'assert', rowId: input.connectionId, expectedRevision: finalRow.revision },
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
    async read(input: JsonValue, context: PluginInvocationContext): Promise<ConversationPairingReadResultV1> {
      const request = admittedActionInput<ConversationPairingReadInputV1>(input);
      const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
      assertNotAborted(context.signal);
      const row = await collection.get(request.connectionId, { signal: context.signal });
      assertNotAborted(context.signal);
      if (row === null) return { kind: 'unavailable' };
      readConversationConnectionUpdateRow({ row, connectionId: request.connectionId });
      // The manager projects both Resource and Action reads. Exact Account
      // membership is proven by one row read, without enumerating connections.
      const projection = pairing.readManagementProjection(new Set([request.connectionId]), request.challengeId);
      if (projection.generationId !== request.generationId) return { kind: 'restarted' };
      if (projection.challenges.length === 0 && projection.proposals.length === 0) return { kind: 'unavailable' };
      return { kind: 'ready', pairing: projection };
    },

    async create(input: JsonValue, context: PluginInvocationContext) {
      const createInput = admittedActionInput<ConversationPairingCreateInputV1>(input);
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
      const connection = readConversationConnectionUpdateRow({ row: connectionRow, connectionId: createInput.connectionId });
      if (connection.configurationRevision !== createInput.expectedConnectionRevision) {
        throw pluginError('channels_pairing_connection_conflict', 'Pairing creation requires the current connection revision.', true);
      }
      if (connection.lifecycle.deletionState !== 'none') {
        throw pluginError('channels_pairing_connection_delete_in_progress', 'Pairing cannot begin while its connection deletion is in progress.');
      }
      await assertPairingCheckpointedPullBaseline({
        context,
        connectionId: createInput.connectionId,
        connection,
      });
      const facts = readPairingConnectionFacts(connection);
      // The destination is proven through the same resolver every other
      // persisting owner uses, so the challenge freezes a provider-
      // authenticated endpoint instead of a caller-asserted identity.
      const destination = await resolveBindingEndpointSelection({
        connectionId: createInput.connectionId,
        expectedConnectionRevision: createInput.expectedConnectionRevision,
        endpointSelection: createInput.endpointSelection,
        context,
      });
      if (destination.kind !== 'endpointSelected') {
        throw pluginError(
          'channels_pairing_endpoint_unavailable',
          'The selected conversation is not a current provider destination for this connection.',
          destination.kind === 'notReady',
        );
      }
      let proofEndpoint: ConversationResolvedEndpointV1 | undefined;
      if (createInput.proofEndpointSelection !== undefined) {
        const proof = await resolveBindingEndpointSelection({
          connectionId: createInput.connectionId,
          expectedConnectionRevision: createInput.expectedConnectionRevision,
          endpointSelection: createInput.proofEndpointSelection,
          context,
        });
        if (proof.kind !== 'endpointSelected') {
          throw pluginError(
            'channels_pairing_proof_endpoint_unavailable',
            'The proof location must resolve on the same current connection and provider as the destination.',
            true,
          );
        }
        if (destination.endpoint.audience !== 'shared' || proof.endpoint.audience !== 'shared'
          || (!areConversationEndpointIdentitiesEqual(destination.endpoint, proof.endpoint)
            && !(createInput.target.kind === 'threadRouter'
              && proof.endpoint.kind === 'thread'
              && proof.endpoint.parentId === destination.endpoint.id))) {
          throw pluginError(
            'channels_pairing_proof_endpoint_mismatch',
            'Shared proof must use the selected destination or, for a router, one authenticated child thread.',
          );
        }
        proofEndpoint = proof.endpoint;
      }
      const result = pairing.createChallenge({
        connectionId: createInput.connectionId,

        expectedConnectionAuthorityEpoch: connection.lifecycle.authorityEpoch,
        pairingRequestId: createInput.pairingRequestId,
        executionOrigin: facts.executionOrigin,
        destinationLabel: facts.destinationLabel,
        ...(facts.pairingDeepLinkTemplate === undefined
          ? {}
          : { pairingDeepLinkTemplate: facts.pairingDeepLinkTemplate }),
        endpoint: destination.endpoint,
        ...(proofEndpoint === undefined ? {} : { proofEndpoint }),
        target: createInput.target,
      });
      context.services.logger.info('[Channels] Pairing challenge created', {
        phase: 'pairingCreated', connectionId: createInput.connectionId, resultKind: result.kind,
        requiresFullSharedMessageContent: pairing.requiresFullSharedMessageContent(createInput.connectionId),
        ...(result.kind === 'created' ? {
          generationId: result.generationId, challengeId: result.challengeId, expiresAt: result.expiresAt,
        } : {}),
      });
      return result;
    },

    async finalize(input: JsonValue, context: PluginInvocationContext) {
      const finalizeInput = admittedActionInput<ConversationPairingFinalizeInputV1>(input);
      return await pairing.finalize(
        finalizeInput,
        async (writeInput) => await writeConversationPairingBinding(writeInput, context),
      );
    },

    async cancel(input: JsonValue, context: PluginInvocationContext): Promise<ConversationPairingCancelResult> {
      const cancelInput = admittedActionInput<ConversationPairingCancelInputV1>(input);
      // Pairing memory outlives an Account change, so an opaque item ID is not
      // by itself authority over it. The connection the item is attached to is
      // the Account partition every other pairing entry already proves; resolve
      // it and require the current Account's Collection to still own that row
      // before the one mutation owner may act. A retired Account's item is
      // reported exactly like an unknown one so cancellation stays non-oracular.
      const pending = pairing.readPendingConnectionId(cancelInput);
      if (pending.kind !== 'pending') return { kind: 'notCancelled', reason: pending.kind };
      const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
      assertNotAborted(context.signal);
      const connectionRow = await collection.get(pending.connectionId, { signal: context.signal });
      assertNotAborted(context.signal);
      if (connectionRow === null) return { kind: 'notCancelled', reason: 'unavailable' };
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
    if (isPluginError(error) && error.code === 'collection_quota_incompatible') {
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

function readConnectionReservation(input: Readonly<{
  row: StateRow;
  reservationRowId: string;
  providerPluginId: string;
  providerConnectionKey: string;
  integrationPrincipalId?: string;
}>): Readonly<{ connectionId: string; integrationPrincipalId: string }> {
  const value = input.row.value;
  const payload = own(value, 'payload');
  const connectionId = value[CHANNEL_STATE_FIELD.connectionId];
  if (input.row.rowId !== input.reservationRowId
    || value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.connectionReservation
    || typeof connectionId !== 'string'
    || !isJsonRecord(payload)
    || payload.providerPluginId !== input.providerPluginId
    || payload.providerConnectionKey !== input.providerConnectionKey
    || typeof payload.integrationPrincipalId !== 'string'
    || payload.integrationPrincipalId.length === 0
    || (input.integrationPrincipalId !== undefined && payload.integrationPrincipalId !== input.integrationPrincipalId)) {
    throw pluginError('channels_connection_reservation_corrupt', 'Connection identity reservation does not match setup identity.');
  }
  return { connectionId, integrationPrincipalId: payload.integrationPrincipalId };
}

function assertRejoinedConnection(input: Readonly<{
  row: StateRow | null;
  connectionId: string;
  providerPluginId: string;
  providerConnectionKey: string;
  integrationPrincipalId: string;
}>): StateRow {
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
  return input.row;
}

const CONNECTION_RESERVED_CODE = 'channels_connection_reserved_by_another_connection';

async function readExistingReservation(input: Readonly<{
  context: PluginInvocationContext;
  reservationRowId: string;
  providerPluginId: string;
  providerConnectionKey: string;
  integrationPrincipalId: string;
}>): Promise<StateRow | null> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const reservation = await collection.get(input.reservationRowId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (reservation === null) return null;
  const retained = readConnectionReservation({
    row: reservation,
    reservationRowId: input.reservationRowId,
    providerPluginId: input.providerPluginId,
    providerConnectionKey: input.providerConnectionKey,
  });
  const connection = await collection.get(retained.connectionId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  const row = assertRejoinedConnection({
    row: connection,
    ...retained,
    providerPluginId: input.providerPluginId,
    providerConnectionKey: input.providerConnectionKey,
  });
  if (retained.integrationPrincipalId !== input.integrationPrincipalId) {
    throw new PluginError({
      code: CONNECTION_RESERVED_CODE,
      message: 'This provider resource already has a connection using a different integration account. Open Channels Connections and use the integration account on the existing connection.',
      details: { recommendedRecovery: recommendConversationRecovery(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionList, {}, 'connectionReservedByAnotherPrincipal',
      ) },
    });
  }
  return row;
}

async function findExistingConnection(input: Readonly<{
  context: PluginInvocationContext;
  createInput: ConversationConnectionCreateInputV1;
  providerPluginId: string;
  setup: ConversationProviderSetupResultV1;
}>): Promise<StateRow | null> {
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

function providerDeclaredConnectionCapabilities(setup: ConversationProviderSetupResultV1) {
  return {
    ...(setup.outboundTextLimit === undefined ? {} : { outboundTextLimit: setup.outboundTextLimit }),
  };
}

function withProviderDeclaredConnectionCapabilities(payload: JsonRecord, setup: ConversationProviderSetupResultV1): JsonRecord {
  const { outboundTextLimit: _oldLimit, ...retained } = payload;
  return { ...retained, ...providerDeclaredConnectionCapabilities(setup) };
}

function connectionRows(input: Readonly<{
  connectionId: string;
  reservationRowId: string;
  createInput: ConversationConnectionCreateInputV1;
  providerPluginId: string;
  setup: ConversationProviderSetupResultV1;
  transportOrigin: ConnectionTransportOrigin;
  webhookEndpoint?: ConversationConnectionWebhookEndpoint;
  now: number;
}>): readonly [JsonRecord, JsonRecord] {
  if (input.providerPluginId !== input.createInput.providerSelection.contributor.pluginId) {
    throw pluginError(
      'channels_connection_provider_selection_mismatch',
      'The current provider must retain the exact selected contribution plugin identity before persistence.',
    );
  }
  // A durable-push row carries the exact ensured endpoint facts; every other
  // transport keeps its previous record shape.
  const transport: JsonRecord = input.webhookEndpoint === undefined
    ? { kind: input.createInput.selectedTransport }
    : {
      kind: 'durablePush',
      webhookContributionRef: {
        pluginId: input.webhookEndpoint.webhookContributionRef.pluginId,
        localId: input.webhookEndpoint.webhookContributionRef.localId,
      },
      webhookEndpointId: input.webhookEndpoint.webhookEndpointId,
      webhookSourceInstanceId: input.webhookEndpoint.webhookSourceInstanceId,
    };
  const connection = {
    [CHANNEL_STATE_FIELD.id]: input.connectionId,
    [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.connection,
    [CHANNEL_STATE_FIELD.version]: 1,
    [CHANNEL_STATE_FIELD.connectionId]: input.connectionId,
    [CHANNEL_STATE_FIELD.createdAt]: input.now,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      configurationRevision: 1,
      providerPluginId: input.providerPluginId,
      providerContributionSelection: {
        contributionId: input.createInput.providerSelection.contributor.contributionId,
      },
      providerSetupInput: input.createInput.providerSetupInput,
      credentialRef: input.createInput.credentialRef,
      transportOrigin: input.transportOrigin,
      transport,
      overlapSafety: input.setup.overlapSafety,
      replayContinuity: input.setup.replayContinuity,
      ...providerDeclaredConnectionCapabilities(input.setup),
      // The provider-authenticated shared-endpoint delivery truth. It is a
      // Channels fact rather than opaque provider configuration because the
      // binding policy owner and the surface that offers that policy both
      // decide from it.
      ...(input.setup.sharedEndpointInputModes === undefined
        ? {}
        : { sharedEndpointInputModes: [...input.setup.sharedEndpointInputModes] }),
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
      // Live transports start at the authenticated connection's native horizon.
      // Pull transports publish this fact atomically with their first cursor.
      historyGap: input.createInput.selectedTransport === 'checkpointedPull' ? null
        : { reason: 'providerHistoryUnavailable', reportedAt: input.now },
      providerReadiness: null,
      pollFailure: null,
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

/*
 * One authoritative create attempt owns the outcome: canonical reservation
 * create, tombstone reuse at its exact revision, and the authoritative reread.
 * Losing that race surfaces the existing retryable conflict to the caller's
 * own retry path instead of an unowned local attempt count. The connection ID
 * is the one preallocated identity for the whole create journey: it already
 * fed the provider connection-test correlation and, for durable push, the
 * endpoint source instance, and it is the ID this batch persists or a later
 * exact rejoin observes.
 */
async function createOrRejoinConnection(input: Readonly<{
  context: PluginInvocationContext;
  createInput: ConversationConnectionCreateInputV1;
  providerPluginId: string;
  setup: ConversationProviderSetupResultV1;
  transportOrigin: ConnectionTransportOrigin;
  connectionId: string;
  webhookEndpoint?: ConversationConnectionWebhookEndpoint;
}>): Promise<PersistedConversationConnection> {
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
  if (existing !== null) return { kind: 'rejoined', connectionId: existing.rowId, connectionRow: existing };

  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(input.context.signal);
  const connectionId = input.connectionId;
  const [reservation, connection] = connectionRows({
    connectionId,
    reservationRowId,
    createInput: input.createInput,
    providerPluginId: input.providerPluginId,
    setup: input.setup,
    transportOrigin: input.transportOrigin,
    ...(input.webhookEndpoint === undefined ? {} : { webhookEndpoint: input.webhookEndpoint }),
    now: Date.now(),
  });
  try {
    const result = await collection.batch([
      { kind: 'put', value: reservation, expectedRevision: 'absent' },
      { kind: 'put', value: connection, expectedRevision: 'absent' },
    ], { signal: input.context.signal });
    assertNotAborted(input.context.signal);
    if (result.status === 'updated') return {
      kind: 'created', connectionId,
      connectionRow: {
        rowId: connectionId,
        value: connection,
        revision: result.results.find(entry => entry.rowId === connectionId)!.revision,
      },
    };

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
      if (recreated.status === 'updated') return {
        kind: 'created', connectionId,
        connectionRow: {
          rowId: connectionId,
          value: connection,
          revision: recreated.results.find(entry => entry.rowId === connectionId)!.revision,
        },
      };
    }

    const rejoined = await readExistingReservation({
      context: input.context,
      reservationRowId,
      providerPluginId: input.providerPluginId,
      providerConnectionKey: input.setup.providerConnectionKey,
      integrationPrincipalId: input.setup.integrationPrincipal.id,
    });
    if (rejoined !== null) return { kind: 'rejoined', connectionId: rejoined.rowId, connectionRow: rejoined };
    throw pluginError(
      'channels_connection_create_conflict',
      'Connection setup conflicted before an authoritative connection could be created or re-read.',
      true,
    );
  } catch (error) {
    if (!isPluginError(error) || error.code !== 'plugin_collection_outcome_unknown' || input.context.signal.aborted) throw error;
    // The Collection host cannot acknowledge an uncertain write. This domain
    // can instead adopt its immutable reservation, exactly as a later Create
    // invocation does. Absence never proves rollback; a new owner decision may
    // retry only through this same atomic reservation-plus-connection CAS.
    let existing: StateRow | null;
    try {
      existing = await readExistingReservation({
        context: input.context, reservationRowId, providerPluginId: input.providerPluginId,
        providerConnectionKey: input.setup.providerConnectionKey, integrationPrincipalId: input.setup.integrationPrincipal.id,
      });
    } catch (readError) {
      if (isPluginError(readError) && (readError.code === 'channels_connection_reservation_corrupt'
        || readError.code === CONNECTION_RESERVED_CODE)) throw readError;
      throw new PluginError({ code: error.code, message: error.message,
        details: { recommendedRecovery: recommendConversationRecovery('connection/create-v1', {}, 'createOutcomeUnknown', 'accountStateUnavailable') },
      }, { cause: error });
    }
    if (existing !== null) return { kind: 'rejoined', connectionId: existing.rowId, connectionRow: existing };
    throw new PluginError({ code: error.code, message: error.message, retryable: true,
      details: { recommendedRecovery: recommendConversationRecovery('connection/create-v1', {}, 'createOutcomeUnknown', 'setupSelectionRequired') },
    }, { cause: error });
  }
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
    setupRemediation: input.operations.setupRemediation,
    connectionTest: input.operations.connectionTest,
    observationsPoll: input.operations.observationsPoll,
    endpointResolve: input.operations.endpointResolve,
    principalResolve: input.operations.principalResolve,
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
  executionOrigin: PluginMachineExecutionOriginV1;
  operation: 'setup' | 'setupRemediation' | 'connectionTest';
}>): void {
  const ref = getPluginMachineExecutionOriginRef(input.executionOrigin);
  if (ref.pluginId === input.provider.pluginId) return;
  throw pluginError(
    'channels_connection_execution_origin_provider_mismatch',
    `The selected provider ${input.operation} Action settled under another plugin's execution origin.`,
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
  expectedExecutionRouting?: PluginMachineExecutionRoutingV1;
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
      ...(input.expectedExecutionRouting === undefined ? {} : { expectedExecutionRouting: input.expectedExecutionRouting }),
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
  const setupTransportOrigin = setupExecution.executionOrigin;
  assertProviderExecutionOrigin({
    provider: input.provider,
    executionOrigin: setupTransportOrigin,
    operation: 'setup',
  });
  assertNotAborted(input.context.signal);
  return { kind: 'ready', setup: outcome, transportOrigin: setupTransportOrigin };
}

/**
 * Checkpointed pull requires its receive role before setup can create external
 * state. Socket workers observe desired lifecycle naturally; durable push uses
 * the generic webhook owner. Neither requires a provider stop operation.
 */
function assertSelectedTransportRoleAvailable(input: Readonly<{
  provider: CurrentProvider;
  selectedTransport: ConversationConnectionCreateInputV1['selectedTransport'];
}>): void {
  if (input.selectedTransport !== 'checkpointedPull' || input.provider.observationsPoll !== undefined) return;
  throw new PluginError({
    code: 'channels_connection_transport_role_unavailable',
    message: 'The selected checkpointedPull transport requires the current provider observationsPoll role.',
    details: {
      selectedTransport: input.selectedTransport,
      requiredOperation: 'observationsPoll',
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
  const currentProvider = await readCurrentSelectedProvider({
    context: input.context,
    selection: input.setupInput.providerSelection,
  });
  return await runProviderConnectionTest({ ...input, provider: currentProvider, prepared });
}

/** The same admitted setup feeds the test, including native PR attachment. */
async function runProviderConnectionTest(input: Readonly<{
  context: PluginInvocationContext;
  setupInput: ConversationConnectionSetupAndTestInput;
  provider: CurrentProvider;
  connectionIdForTest: string;
  prepared: Extract<ProviderConnectionSetup, { kind: 'ready' }>;
}>): Promise<ProviderConnectionPreparation> {
  const { prepared } = input;
  const transportOrigin = prepared.transportOrigin;
  if (!prepared.setup.supportedTransports.includes(input.setupInput.selectedTransport)) {
    return { kind: 'notReady', reason: 'unsupported' };
  }
  // Setup and connection test are separate provider effects. Preserve the
  // invocation cancellation boundary between them so a completed setup cannot
  // start a later test after its owner has withdrawn authority.
  assertNotAborted(input.context.signal);
  const currentProvider = input.provider;
  const testExecution = await input.context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    currentProvider.connectionTest,
    {
      v: 1,
      connectionId: input.connectionIdForTest,
      providerConnectionKey: prepared.setup.providerConnectionKey,
      providerConfigVersion: prepared.setup.providerConfigVersion,
      providerConfig: prepared.setup.providerConfig,
      credentialRef: input.setupInput.credentialRef,
      selectedTransport: input.setupInput.selectedTransport,
    },
    { signal: input.context.signal,
      expectedExecutionRouting: getConversationConnectionExecutionRouting(getConversationConnectionTransportOrigin(transportOrigin), currentProvider.pluginId) },
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
  const testTransportOrigin = testExecution.executionOrigin;
  // The host's expectedExecutionRouting admission above checks Home, Machine
  // and plugin; the former post-test comparison checked only Home/Machine.
  if (testResult.kind === 'notReady') return testResult;
  return { ...prepared, transportOrigin: testTransportOrigin };
}

function projectConnectionPrepareTransportSelection(
  setup: ConversationProviderSetupResultV1,
): Readonly<{
  supportedTransports: readonly ConversationConnectionCreateInputV1['selectedTransport'][];
  recommendedTransport: ConversationConnectionCreateInputV1['selectedTransport'];
}> {
  const supportedTransports = setup.supportedTransports.filter(
    isConversationConnectionCreateSelectableTransportV1,
  );
  const fallbackTransport = supportedTransports[0];
  if (fallbackTransport === undefined) {
    throw pluginError(
      'channels_connection_transport_unavailable',
      'Provider setup does not support a transport current connection creation can select.',
    );
  }
  return {
    supportedTransports,
    recommendedTransport: isConversationConnectionCreateSelectableTransportV1(setup.recommendedTransport)
      ? setup.recommendedTransport
      : fallbackTransport,
  };
}

/**
 * C2's non-persisting preparation owner. It observes provider setup only and
 * projects safe transport facts without allocating or retaining connection state.
 */
export async function prepareConversationConnectionForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionPrepareResultV1> {
  const prepareInput = admittedActionInput<ConversationConnectionPrepareInputV1>(input);
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
  const transportSelection = projectConnectionPrepareTransportSelection(prepared.setup);
  return {
    kind: 'ready',
    ...transportSelection,
    overlapSafety: prepared.setup.overlapSafety,
    replayContinuity: prepared.setup.replayContinuity,
    ...providerDeclaredConnectionCapabilities(prepared.setup),
    ...(prepared.setup.sharedEndpointInputModes === undefined
      ? {}
      : { sharedEndpointInputModes: prepared.setup.sharedEndpointInputModes }),
    ...(prepared.setup.setupGuidance === undefined
      ? {}
      : { setupGuidance: prepared.setup.setupGuidance }),
    ...(prepared.setup.integrationPrincipal.label === undefined
      ? {}
      : { destinationLabel: prepared.setup.integrationPrincipal.label }),
  };
}

/** The selected provider owns the repair; Channels owns its public intent. */
export async function remediateConversationConnectionSetupForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationProviderSetupRemediationResultV1> {
  const remediationInput = admittedActionInput<ConversationConnectionSetupRemediateInputV1>(input);
  const provider = await readCurrentSelectedProvider({ context, selection: remediationInput.providerSelection });
  if (provider.setupRemediation === undefined) {
    throw pluginError('channels_connection_setup_remediation_unavailable', 'The selected provider has no current setup remediation operation.');
  }
  assertNotAborted(context.signal);
  const execution = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    provider.setupRemediation,
    remediationInput.providerRemediationInput,
    { signal: context.signal, expectedSelectedConnectedAccountRef: remediationInput.credentialRef },
  );
  assertNotAborted(context.signal);
  assertProviderExecutionOrigin({ provider, executionOrigin: execution.executionOrigin, operation: 'setupRemediation' });
  return ConversationProviderSetupRemediationResultV1Schema.parse(execution.result);
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
  const updateInput = admittedActionInput<ConversationConnectionUpdateInputV1>(input);
  return await mutateConversationConnectionLifecycle({
    connectionId: updateInput.connectionId,
    expectedRevision: updateInput.expectedRevision,
    operation: 'channels_connection_update',
    transition: (current) => transitionConversationConnection({
      current,
      requested: {
        enabled: updateInput.enabled,
      },
    }),
  }, context);
}

/**
 * Make the current failure due for the existing supervisor. Successful
 * receive settlement clears its evidence after the work actually completes.
 */
export async function retryConversationConnectionPollForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionPollRetryResult> {
  const request = admittedActionInput<ConversationConnectionPollRetryInputV1>(input);
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(request.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) {
    throw pluginError(
      'channels_connection_poll_retry_conflict',
      'The connection poll state changed before retry.',
      true,
    );
  }
  const current = readConversationConnectionUpdateRow({ row, connectionId: request.connectionId });
  const failure = current.lifecycle.pollFailure;
  const retryNotBeforeMs = 0;
  if (failure === null || (failure.phase === 'retryDue' && failure.retryNotBeforeMs === retryNotBeforeMs)) {
    return { kind: 'retryScheduled', connectionId: request.connectionId, revision: current.configurationRevision, authorityEpoch: current.lifecycle.authorityEpoch };
  }
  const pollFailure = { ...failure, phase: 'retryDue' as const, retryNotBeforeMs };
  const value = withConversationConnectionLifecycle({
    row,
    current,
    lifecycle: {
      ...current.lifecycle,
      pollFailure,
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
        'The connection poll state changed before retry.',
        true,
      );
    }
    persistedRevision = result.results.find((entry) => (
      entry.rowId === request.connectionId && entry.deleted === false
    ))?.revision;
  } catch (cause) {
    assertNotAborted(context.signal);
    if (isPluginError(cause)) throw cause;
  }
  if (persistedRevision !== undefined) {
    return {
      kind: 'retryScheduled',
      connectionId: request.connectionId,
      revision: current.configurationRevision,
      authorityEpoch: current.lifecycle.authorityEpoch,
    };
  }
  const reread = await collection.get(request.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (reread !== null) {
    const settled = readConversationConnectionUpdateRow({ row: reread, connectionId: request.connectionId });
    if (
      settled.lifecycle.authorityEpoch === current.lifecycle.authorityEpoch
      && (settled.lifecycle.pollFailure === null || pluginJsonValuesEqual(settled.lifecycle.pollFailure, pollFailure))
    ) {
      return {
        kind: 'retryScheduled',
        connectionId: request.connectionId,
        revision: settled.configurationRevision,
        authorityEpoch: settled.lifecycle.authorityEpoch,
      };
    }
  }
  throw pluginError(
    'channels_connection_poll_retry_result_invalid',
    'The connection poll retry did not return or retain its scheduled retry.',
    true,
  );
}

/**
 * Re-runs the provider's own connection test against the connection the user
 * already saved, so a connection that failed after creation has an exit other
 * than delete-and-recreate.
 *
 * It is a re-observation, not a second health system: the request is composed
 * entirely from retained facts and pinned to the frozen transport origin, a
 * still-failing provider probe returns its shared failure vocabulary. A host
 * origin refusal and a ready probe settle evidence through the connection
 * lifecycle owner. A successful probe re-observes provider-declared capabilities
 * through the existing safe setup owner at that same origin.
 */
export async function retestConversationConnectionForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionRetestResultV1> {
  const requestedConnection = admittedActionInput<ConversationConnectionRetestInputV1>(input);
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(requestedConnection.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) {
    throw conversationConnectionRetestConflict();
  }
  const current = readConversationConnectionUpdateRow({ row, connectionId: requestedConnection.connectionId });
  // The current saved connection supplies the worker generation; no list
  // version supplied by the caller can make this observation stale.
  const request = { connectionId: requestedConnection.connectionId, authorityEpoch: current.lifecycle.authorityEpoch };
  // Deleting and disabled connections have no current transport to re-observe.
  // Retained predecessor stop slots are inert, not transport eligibility.
  if (current.lifecycle.deletionState !== 'none'
    || !current.lifecycle.enabled) {
    throw conversationConnectionRetestConflict();
  }
  const transport = own(current.payload, 'transport');
  if (!isJsonRecord(transport) || typeof transport.kind !== 'string') {
    throw pluginError(
      'channels_connection_retest_corrupt',
      'Connection retest target has an invalid persisted transport.',
    );
  }
  const provider = await readCurrentProviderContributionForPersistedSelection({
    context: {
      targetedContributions: context.services.targetedContributions,
      signal: context.signal,
    },
    providerPluginId: current.providerPluginId,
    providerContributionSelection: current.providerContributionSelection,
  });
  // `connectionTest` is a `required: true` role on the Channels provider point,
  // so an admitted contribution always carries it; there is no absent case to
  // branch on here.
  const connectionTest = provider.operations.connectionTest;
  let testRequest: ConversationConnectionTestInputV1;
  try {
    testRequest = ConversationConnectionTestInputV1Schema.parse({
      v: 1,
      connectionId: request.connectionId,
      providerConnectionKey: own(current.payload, 'providerConnectionKey'),
      providerConfigVersion: own(current.payload, 'providerConfigVersion'),
      providerConfig: own(current.payload, 'providerConfig'),
      credentialRef: own(current.payload, 'credentialRef'),
      selectedTransport: transport.kind,
    });
  } catch (cause) {
    throw new PluginError({
      code: 'channels_connection_retest_corrupt',
      message: 'Connection retest could not read the retained provider connection details.',
    }, { cause });
  }
  async function retainOriginRefusal(
    cause: unknown,
    snapshot: Readonly<{ row: StateRow; current: ConversationConnectionUpdateRow }>,
  ): Promise<never> {
    if (isPluginError(cause) && cause.code === CONVERSATION_CONNECTION_ORIGIN_MISMATCH && !context.signal.aborted) {
      const transition = recordConversationConnectionProviderReadiness({
        current: snapshot.current.lifecycle,
        reportedAuthorityEpoch: request.authorityEpoch,
        fact: {
          kind: 'providerReadiness',
          status: 'attention',
          code: 'providerConfigurationInvalid',
          diagnostic: cause.code,
        },
      });
      if (transition.kind === 'recorded') {
        try {
          await persistConversationConnectionLifecycle({
            collection,
            ...snapshot,
            lifecycle: transition.connection,
            operation: 'channels_connection_retest',
          }, context);
        } catch (error) {
          context.services.logger.warn('[Channels] Could not retain the Retest origin refusal', {
            connectionId: request.connectionId,
            ...(isPluginError(error) ? { code: error.code } : {}),
          });
        }
      }
    }
    throw cause;
  }

  const execution = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    connectionTest,
    testRequest,
    { signal: context.signal, expectedExecutionRouting: getConversationConnectionExecutionRouting(current.transportOrigin, current.providerPluginId) },
  ).catch(cause => retainOriginRefusal(cause, { row, current }));
  assertNotAborted(context.signal);
  let testResult: ReturnType<typeof ConversationConnectionTestResultV1Schema.parse>;
  try {
    testResult = ConversationConnectionTestResultV1Schema.parse(execution.result);
  } catch (cause) {
    throw new PluginError({
      code: 'channels_connection_test_result_invalid',
      message: 'Provider connection test returned an invalid result.',
    }, { cause });
  }
  // A transient provider refusal is the answer, not a new retained verdict.
  // Only the connection's transport may supersede retained attention.
  if (testResult.kind === 'notReady') {
    await rereadConversationConnectionRetestAuthority({
      collection,
      request,
      context,
    });
    return testResult;
  }
  // Immutable connection identity is the whole tuple, exactly as create and
  // transfer compare it. A credential that still answers for the saved provider
  // connection key but now resolves to a different integration principal is a
  // different destination, and clearing readiness for it would silently rebind
  // the saved connection to someone else's account.
  const retainedIdentity = readImmutableConnectionIdentity(current, {
    code: 'channels_connection_retest_corrupt',
    message: 'Connection retest could not read the retained provider connection details.',
  });
  if (testResult.providerConnectionKey !== retainedIdentity.providerConnectionKey
    || testResult.integrationPrincipal.id !== retainedIdentity.integrationPrincipalId) {
    await rereadConversationConnectionRetestAuthority({
      collection,
      request,
      context,
    });
    throw pluginError(
      'channels_connection_test_identity_mismatch',
      'Provider connection test disagreed about immutable connection identity.',
    );
  }
  // Connection-test readiness alone carries no outbound limit or freshness
  // recommendation. Re-observe those through the same safe setup-result owner
  // used by create/transfer, pinned to this saved transport and credential.
  // No identity, configuration, transport, or user-selected freshness is replaced.
  const beforeSetup = await rereadConversationConnectionRetestAuthority({ collection, request, context });
  const prepared = await runProviderSetup({
    context,
    provider: providerFromSelectedContribution(beforeSetup.provider),
    providerSetupInput: current.providerSetupInput,
    credentialRef: testRequest.credentialRef,
    expectedExecutionRouting: getConversationConnectionExecutionRouting(current.transportOrigin, current.providerPluginId),
  }).catch(cause => retainOriginRefusal(cause, { row: beforeSetup.row, current: beforeSetup.current }));
  if (prepared.kind === 'requiresRemediation') {
    throw pluginError('channels_connection_setup_requires_remediation', 'Provider setup requires remediation before connection retest.');
  }
  if (prepared.setup.providerConnectionKey !== retainedIdentity.providerConnectionKey
    || prepared.setup.integrationPrincipal.id !== retainedIdentity.integrationPrincipalId) {
    throw pluginError('channels_connection_test_identity_mismatch', 'Provider setup disagreed about immutable connection identity during retest.');
  }
  // Identity alone is not readiness. A platform can narrow what an unchanged
  // integration is allowed to deliver — re-enabling a Telegram bot's BotFather
  // group privacy stops ordinary supergroup messages outright — and a saved
  // shared binding that promised those messages then observes nothing at all.
  // The probe restates the CURRENT capability, so the retained promise is
  // compared against it here rather than being cleared by a stale one.
  const unsatisfiable = await readConversationBindingInputModesNoLongerDeliverable({
    context,
    connectionId: request.connectionId,
    sharedEndpointInputModes: testResult.sharedEndpointInputModes,
  });
  assertNotAborted(context.signal);
  const reread = await rereadConversationConnectionRetestAuthority({
    collection,
    request,
    context,
  });
  const readinessFact: Parameters<
    typeof recordConversationConnectionProviderReadiness
  >[0]['fact'] = unsatisfiable.length === 0
    ? { kind: 'providerReadiness', status: 'ready' }
    : {
      kind: 'providerReadiness',
      status: 'attention',
      code: 'providerPermissionMissing',
      diagnostic: `This integration can no longer deliver ${unsatisfiable.join(', ')} for shared conversations, so saved bindings that use it receive nothing.`,
    };
  const transition = recordConversationConnectionProviderReadiness({
    current: reread.current.lifecycle,
    reportedAuthorityEpoch: request.authorityEpoch,
    fact: readinessFact,
  });
  if (transition.kind === 'staleAuthority') throw conversationConnectionRetestConflict();
  if (readinessFact.status === 'attention') {
    if (transition.kind === 'recorded') {
      await persistConversationConnectionLifecycle({
        collection,
        row: reread.row,
        current: reread.current,
        lifecycle: transition.connection,
        operation: 'channels_connection_retest',
      }, context);
    }
    return {
      kind: 'notReady',
      reason: 'permissionMissing',
      diagnostic: readinessFact.diagnostic,
    };
  }
  const refreshedCurrent = {
    ...reread.current,
    payload: withProviderDeclaredConnectionCapabilities(reread.current.payload, prepared.setup),
  };
  const persisted = transition.kind === 'rejoined'
    && pluginJsonValuesEqual(refreshedCurrent.payload, reread.current.payload)
    ? { configurationRevision: reread.current.configurationRevision }
    : await persistConversationConnectionLifecycle({
      collection,
      row: reread.row,
      current: refreshedCurrent,
      lifecycle: transition.kind === 'rejoined' ? reread.current.lifecycle : transition.connection,
      operation: 'channels_connection_retest',
    }, context);
  return {
    kind: 'ready',
    connectionId: request.connectionId,
    revision: persisted.configurationRevision,
    authorityEpoch: request.authorityEpoch,
  };
}

async function rereadConversationConnectionRetestAuthority(input: Readonly<{
  collection: ChannelStateCollection;
  request: Readonly<{ connectionId: string; authorityEpoch: number }>;
  context: PluginInvocationContext;
}>): Promise<Readonly<{
  row: StateRow;
  current: ConversationConnectionUpdateRow;
  provider: BindingResolutionProvider;
}>> {
  const row = await input.collection.get(input.request.connectionId, {
    signal: input.context.signal,
  });
  assertNotAborted(input.context.signal);
  if (row === null) {
    throw conversationConnectionRetestConflict();
  }
  const current = readConversationConnectionUpdateRow({
    row,
    connectionId: input.request.connectionId,
  });
  if (current.lifecycle.authorityEpoch !== input.request.authorityEpoch
    || current.lifecycle.deletionState !== 'none'
    || !current.lifecycle.enabled) {
    throw conversationConnectionRetestConflict();
  }
  let providerAfter: BindingResolutionProvider;
  try {
    providerAfter = await readCurrentProviderContributionForPersistedSelection({
      context: {
        targetedContributions: input.context.services.targetedContributions,
        signal: input.context.signal,
      },
      providerPluginId: current.providerPluginId,
      providerContributionSelection: current.providerContributionSelection,
    });
  } catch (cause) {
    if (input.context.signal.aborted) throw cause;
    throw conversationConnectionRetestConflict();
  }
  return { row, current, provider: providerAfter };
}

function conversationConnectionRetestConflict(): PluginError {
  return pluginError(
    'channels_connection_retest_conflict',
    'The saved connection changed before its retest could observe the current provider.',
    true,
  );
}

export async function persistConversationConnectionLifecycle(input: Readonly<{
  collection: ChannelStateCollection;
  row: StateRow;
  current: ConversationConnectionUpdateRow;
  lifecycle: ConversationConnectionLifecycleStateV1;
  operation: string;
}>, context: PluginInvocationContext): Promise<Readonly<{ revision: number; configurationRevision: number }>> {
  const value = withConversationConnectionLifecycle({ row: input.row, current: input.current, lifecycle: input.lifecycle });
  const result = await input.collection.batch([
    {
      kind: 'put',
      value,
      expectedRevision: input.row.revision,
    },
  ], { signal: context.signal });
  assertNotAborted(context.signal);
  if (result.status === 'conflict') {
    throw pluginError(
      `${input.operation}_conflict`,
      'Connection lifecycle lost its retained-row compare-and-swap.',
      true,
    );
  }
  const persisted = result.results.find((entry) => (
    entry.rowId === input.row.rowId && entry.deleted === false
  ));
  if (persisted === undefined) {
    throw pluginError(
      `${input.operation}_result_invalid`,
      'Connection lifecycle did not return its retained row result.',
      true,
    );
  }
  return { revision: persisted.revision, configurationRevision: value.payload.configurationRevision };
}

function deleteResult(input: Readonly<{
  kind: ConversationConnectionDeleteResult['kind'];
  connectionId: string;
  revision: number;
  lifecycle: ConversationConnectionLifecycleStateV1;
}>): ConversationConnectionDeleteResult {
  return {
    kind: input.kind,
    connectionId: input.connectionId,
    revision: input.revision,
    authorityEpoch: input.lifecycle.authorityEpoch,
    acceptedPossibleLoss: false,
  };
}

/**
 * Delete withdraws admission once. The existing finalizer owns dependent
 * cleanup; unreachable workers owe no proof before that cleanup can proceed.
 */
export async function deleteConversationConnectionForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionDeleteResult> {
  const deleteInput = admittedActionInput<ConversationConnectionDeleteInputV1>(input);
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  assertNotAborted(context.signal);
  const row = await collection.get(deleteInput.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) {
    throw pluginError('channels_connection_delete_not_found', 'Connection deletion target does not exist.');
  }
  const current = readConversationConnectionUpdateRow({ row, connectionId: deleteInput.connectionId });
  if (current.configurationRevision !== deleteInput.expectedRevision) {
    throw pluginError('channels_connection_delete_conflict', 'Connection deletion requires the current retained row revision.', true);
  }
  const transition = startConversationConnectionDelete({ current: current.lifecycle });
  if (transition.kind === 'rejected') {
    throw pluginError('channels_connection_delete_authority_epoch_exhausted', 'Connection authority cannot advance further.');
  }
  if (transition.kind === 'rejoined') {
    return deleteResult({ kind: 'rejoined', connectionId: deleteInput.connectionId,
      revision: current.configurationRevision, lifecycle: transition.connection });
  }
  const persisted = await persistConversationConnectionLifecycle({
    collection, row, current, lifecycle: transition.connection, operation: 'channels_connection_delete',
  }, context);
  return deleteResult({ kind: 'deleteFinalizing', connectionId: deleteInput.connectionId,
    revision: persisted.configurationRevision, lifecycle: transition.connection });
}

/**
 * Provider readiness and history facts use the current connection generation.
 * Retained stopped facts are readable but no longer settle lifecycle state.
 */
export async function reportConversationTransportFactForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationTransportFactReportResultV1> {
  const report = admittedActionInput<ConversationTransportFactReportInputV1>(input);
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
    if (report.senderEligibility !== undefined) {
      if (report.authorityEpoch !== current.lifecycle.authorityEpoch) return { kind: 'staleAuthority' };
      if (!current.lifecycle.enabled || current.lifecycle.deletionState !== 'none'
        || !await isConversationSenderConfiguredForEndpoint({ context, connectionId: report.connectionId,
          ...report.senderEligibility })) return { kind: 'notEligible' };
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

// A retained stopped fact grants no cleanup or transfer authority.
  return { kind: 'staleAuthority' };
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
    || current.providerPluginId !== getPluginMachineExecutionOriginRef(input.executionOrigin).pluginId
    || !areConversationConnectionTransportOriginsEqual(current.transportOrigin, getConversationConnectionTransportOrigin(input.executionOrigin))
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
 * How many relation rows one delete-finalization page inspects.
 *
 * It is derived from the atomic mutation batch that page produces, not chosen:
 * a binding row can contribute at most three mutations (its projection
 * frontier, its session rotation, and the binding itself), and the connection
 * page adds one leading `assert`, so `32 * 3 + 1 = 97` stays inside the
 * hundred-operation Collection batch bound. Raising this number without
 * re-deriving that arithmetic produces a batch the Collection rejects.
 */
const MAX_CONNECTION_DELETE_RELATION_ROWS = 32;

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
  return current.lifecycle.deletionState === 'finalizingDelete'
    && !current.lifecycle.enabled;
}

function readFinalizingReservationIdentity(current: ConversationConnectionUpdateRow): Readonly<{
  providerConnectionKey: string;
  integrationPrincipalId: string;
}> {
  return readImmutableConnectionIdentity(current, {
    code: 'channels_connection_finalizer_identity_corrupt',
    message: 'A finalizing connection has no canonical immutable reservation identity.',
  });
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
    const frontierRow = asChannelStateRow(frontier);
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
    const rotationRow = asChannelStateRow(rotation);
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
  observePendingIngress?: (rowId: string) => void;
}>): Promise<true | void> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const connectionStored = await collection.get(input.connectionId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (connectionStored === null) return;
  const connectionRow = asChannelStateRow(connectionStored);
  if (connectionRow === undefined) return;
  const current = readConversationConnectionUpdateRow({ row: connectionRow, connectionId: input.connectionId });
  if (!finalizingDeleteIsAuthorized(current)) return;
  if (!await hasCurrentConversationExecutionPlacement(input.context, current.transportOrigin)) return;

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
  const reservationRow = asChannelStateRow(reservationStored);
  if (reservationRow === undefined || readConnectionReservation({
    row: reservationRow,
    reservationRowId,
    providerPluginId: current.providerPluginId,
    providerConnectionKey: reservationIdentity.providerConnectionKey,
    integrationPrincipalId: reservationIdentity.integrationPrincipalId,
  }).connectionId !== input.connectionId) return;

  const custody = await settleConversationOutwardDeliveriesForConnectionDeletion({
    stateCollection: collection,
    deliveriesCollection: requireChannelsAccountStorage(input.context).collection(CHANNEL_DELIVERIES_COLLECTION),
    connectionId: input.connectionId,
    signal: input.context.signal,
    now: Date.now,
  });
  if (custody.kind !== 'settled') return;

  const relationPage = await collection.query({
    index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
    prefix: [input.connectionId],
    // Bound relation cleanup must see every binding-scoped ingress obligation
    // before it reaches the unbound checkpoint/census rows. Otherwise a full
    // first page can remove a census while a later attempting/blocked
    // obligation still needs its immutable ingress evidence. `binding-id` stays
    // the second V2 field with the same null sentinel, so descending order
    // still yields every bound row before the unbound ones; the added
    // `record-kind`/`attention` fields only order rows inside an already equal
    // binding-id group, which this loop never assigns authority to.
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
    const row = asChannelStateRow(stored);
    if (row === undefined) return;
    const recordKind = own(row.value, CHANNEL_STATE_FIELD.recordKind);
    if (recordKind === CHANNEL_STATE_RECORD_KIND.connection) {
      if (row.rowId !== connectionRow.rowId || row.revision !== connectionRow.revision) return;
      continue;
    }
    if (recordKind === CHANNEL_STATE_RECORD_KIND.connectionReservation) {
      if (row.rowId !== reservationRow.rowId || row.revision !== reservationRow.revision) return;
      if (readConnectionReservation({
        row,
        reservationRowId,
        providerPluginId: current.providerPluginId,
        providerConnectionKey: reservationIdentity.providerConnectionKey,
        integrationPrincipalId: reservationIdentity.integrationPrincipalId,
      }).connectionId !== input.connectionId) return;
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
      if (settlement.kind === 'blocked') {
        input.observePendingIngress?.(row.rowId);
        return;
      }
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
    return true;
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
 * the sole recovery fact while incumbent ingress and outward custody finish.
 * Cleanup only mutates Account data; the background caller owns placement.
 */
async function finalizeConversationBindingDelete(input: Readonly<{
  bindingId: string;
  context: ConversationStorageContext;
  observePendingIngress?: (rowId: string) => void;
}>): Promise<true | void> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const bindingStored = await collection.get(input.bindingId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (bindingStored === null) return;
  const bindingRow = asChannelStateRow(bindingStored);
  if (bindingRow === undefined) return;
  const current = readConversationBindingUpdateRow({ row: bindingRow, bindingId: input.bindingId });
  if (!finalizingBindingDeleteIsAuthorized(current)) return;

  // Connection deletion remains the parent cleanup owner. A pending or
  // finalizing parent must consume this binding through its own bounded page,
  // rather than two finalizers racing the same relation rows.
  const connectionStored = await collection.get(current.binding.connectionId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (connectionStored === null) return;
  const connectionRow = asChannelStateRow(connectionStored);
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
    index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
    prefix: [current.binding.connectionId, input.bindingId],
    order: 'desc',
    limit: MAX_CONNECTION_DELETE_RELATION_ROWS,
  }, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  const mutations: ChannelStateBatchMutation[] = [];
  let hasDependentMutation = false;
  for (const stored of relationPage.rows) {
    const row = asChannelStateRow(stored);
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
      if (settlement.kind === 'blocked') {
        input.observePendingIngress?.(row.rowId);
        return;
      }
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
    return true;
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
 * A successful dependent page returns continuation to that same runner:
 * ingress/checkpoint writes do not emit its structural binding watch.
 */
export async function finalizeConversationConnectionDeletesForInvocation(
  context: ConversationStorageContext,
  observePendingIngress?: (rowId: string) => void,
): Promise<boolean> {
  if (context.signal.aborted) return false;
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  let continueFinalization = false;
  let finalizationFailed = false;
  let finalizationPluginFailure: unknown;
  const recordFinalizationFailure = (error: unknown): void => {
    finalizationFailed = true;
    if (finalizationPluginFailure === undefined && isPluginError(error)) {
      finalizationPluginFailure = error;
    }
  };
  let connectionCursor: string | undefined;
  do {
    let connectionPage: Awaited<ReturnType<ChannelStateCollection['query']>> | undefined;
    try {
      connectionPage = await collection.query({
        index: CHANNEL_STATE_INDEX_ID.byIngressDue,
        prefix: [CHANNEL_STATE_RECORD_KIND.connection],
        range: { lower: 0 },
        order: 'asc',
        limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
        ...(connectionCursor === undefined ? {} : { cursor: connectionCursor }),
      }, { signal: context.signal });
    } catch (error) {
      // Binding finalization is independently selectable from the same existing
      // due-work index, so an unavailable connection page must not manufacture
      // a second recovery mechanism or starve already-finalizing bindings.
      recordFinalizationFailure(error);
    }
    if (connectionPage === undefined) break;
    {
      for (const stored of connectionPage.rows) {
        if (context.signal.aborted) return false;
        const row = asChannelStateRow(stored);
        if (row === undefined || row.value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.connection) {
          continue;
        }
        const connectionId = own(row.value, CHANNEL_STATE_FIELD.connectionId);
        if (typeof connectionId !== 'string') continue;
        try {
          const current = readConversationConnectionUpdateRow({ row, connectionId });
          if (!finalizingDeleteIsAuthorized(current)) continue;
          if (await finalizeConversationConnectionDelete({ connectionId, context, observePendingIngress })) continueFinalization = true;
        } catch (error) {
          // Retain the canonical rows untouched; the next existing wake re-reads
          // them rather than treating an unavailable or malformed row as deleted.
          recordFinalizationFailure(error);
        }
      }
    }
    connectionCursor = connectionPage.nextCursor;
  } while (connectionCursor !== undefined);
  if (context.signal.aborted) return false;

  // Only finalizing bindings have a numeric due key. The keyset cursor is
  // loop-local: finalization owns no persisted cursor or cleanup scheduler. A crash
  // or conflict simply resumes from current rows on the next wake.
  let bindingCursor: string | undefined;
  for (;;) {
    if (context.signal.aborted) return false;
    let bindingPage: Awaited<ReturnType<ChannelStateCollection['query']>> | undefined;
    try {
      bindingPage = await collection.query({
        index: CHANNEL_STATE_INDEX_ID.byIngressDue,
        prefix: [CHANNEL_STATE_RECORD_KIND.binding],
        range: { lower: 0 },
        order: 'asc',
        limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
        ...(bindingCursor === undefined ? {} : { cursor: bindingCursor }),
      }, { signal: context.signal });
    } catch (error) {
      recordFinalizationFailure(error);
    }
    if (bindingPage === undefined) break;
    for (const stored of bindingPage.rows) {
      if (context.signal.aborted) return false;
      const row = asChannelStateRow(stored);
      if (row === undefined || row.value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.binding) {
        continue;
      }
      const bindingId = own(row.value, CHANNEL_STATE_FIELD.bindingId);
      if (typeof bindingId !== 'string' || bindingId !== row.rowId) continue;
      try {
        const current = readConversationBindingUpdateRow({ row, bindingId });
        if (!finalizingBindingDeleteIsAuthorized(current)) continue;
        if (!await isConversationConnectionPlacedForInvocation(context, current.binding.connectionId)) continue;
        if (await finalizeConversationBindingDelete({ bindingId, context, observePendingIngress })) continueFinalization = true;
      } catch (error) {
        // Retain the canonical rows untouched; the next existing wake re-reads
        // them rather than treating an unavailable or malformed row as deleted.
        recordFinalizationFailure(error);
      }
    }
    bindingCursor = bindingPage.nextCursor;
    if (bindingCursor === undefined) break;
  }
  if (context.signal.aborted) return false;
  if (finalizationPluginFailure !== undefined) throw finalizationPluginFailure;
  if (finalizationFailed) throw new Error('Channels delete finalization failed.');
  return continueFinalization;
}

export type ConversationThreadBindingCreateResult =
  | Readonly<{ kind: 'created'; binding: ConversationBindingV1; revision: number }>
  | Readonly<{ kind: 'stale' }>
  | Readonly<{ kind: 'unavailable'; reason: 'routerNotFound' | 'routerDisabled' | 'connectionNotFound' | 'connectionDeleting' }>;

/** Ingress and settled starts share the normal binding/frontier writer and its guarded batch. */
export async function createConversationThreadBindingForInvocation(input: Readonly<{
  routerBindingId: string;
  expectedRouterRevision: number;
  expectedConnectionRevision: number;
  endpoint: ConversationResolvedEndpointV1;
  sessionId: string;
  allowedPrincipalIds: readonly string[];
  policy: ConversationSessionBindingTargetV1['policy'];
  /** Private Session-owner birth evidence, never an authorable binding field. */
  inboundBirthMessageId?: string;
}>, context: PluginInvocationContext): Promise<ConversationThreadBindingCreateResult> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const routerRow = await collection.get(input.routerBindingId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (routerRow === null) return { kind: 'unavailable', reason: 'routerNotFound' };
  const router = readConversationBindingUpdateRow({ row: routerRow, bindingId: input.routerBindingId }).binding;
  if (router.target.kind !== 'threadRouter' || router.deletionState !== 'none') return { kind: 'unavailable', reason: 'routerDisabled' };
  if (input.endpoint.kind !== 'thread' || input.endpoint.parentId !== router.endpoint.id) {
    throw pluginError('channels_thread_binding_endpoint_mismatch', 'A thread binding must belong to its router endpoint.');
  }
  const connectionRow = await collection.get(router.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (connectionRow === null) return { kind: 'unavailable', reason: 'connectionNotFound' };
  const connection = readConversationConnectionUpdateRow({ row: connectionRow, connectionId: router.connectionId });
  if (connection.lifecycle.deletionState !== 'none') return { kind: 'unavailable', reason: 'connectionDeleting' };
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw pluginError('channels_connection_crypto_unavailable', 'The runtime cannot derive a private thread identity.');
  const key = await importHmacSha256Key(subtle, base64UrlBytes(connection.routingIdentityKey));
  const bindingId = `binding-thread-${await signLengthPrefixedUtf8HmacSha256Base64Url({
    subtle, key, parts: ['channels:thread-binding:v1', router.id, input.endpoint.kind, input.endpoint.audience, input.endpoint.id, input.endpoint.parentId ?? ''],
  })}`;
  const rejoin = async (): Promise<Extract<ConversationThreadBindingCreateResult, { kind: 'created' }> | null> => {
    const retained = await collection.get(bindingId, { signal: context.signal });
    assertNotAborted(context.signal);
    if (retained === null) return null;
    const binding = readConversationBindingUpdateRow({ row: retained, bindingId }).binding;
    if (binding.parentBindingId !== router.id || binding.target.kind !== 'session' || binding.target.sessionId !== input.sessionId
      || !areConversationEndpointIdentitiesEqual(binding.endpoint, input.endpoint)) {
      throw pluginError('channels_thread_binding_conflict', 'The retained thread binding has different target authority.');
    }
    return { kind: 'created', binding, revision: retained.revision };
  };
  const existing = await rejoin();
  if (existing !== null) return existing;
  if (routerRow.revision !== input.expectedRouterRevision || connectionRow.revision !== input.expectedConnectionRevision) return { kind: 'stale' };
  // Revocation owns policy narrowing: an explicit empty approver or /new set
  // becomes off, while an omitted set continues to inherit this child audience.
  const parentAudience = [...new Set([...conversationThreadRouterAllowedPrincipalIdsV1(router.target), ...input.allowedPrincipalIds])];
  const narrowed = revokeConversationBindingPrincipals({
    allowedPrincipalIds: parentAudience,
    target: { kind: 'session', sessionId: input.sessionId, policy: input.policy },
    revokedPrincipalIds: parentAudience.filter((id) => !input.allowedPrincipalIds.includes(id)),
  });
  if (narrowed.kind !== 'revoked') throw pluginError('channels_thread_binding_audience_invalid', 'A thread binding requires an admitted audience.');
  const candidate = createConversationBindingRow({
    bindingId, parentBindingId: router.id, connectionId: router.connectionId,
    endpoint: input.endpoint, target: narrowed.target, allowedPrincipalIds: input.allowedPrincipalIds,
    allowBotSenders: router.allowBotSenders,
    inboundDebounceMs: router.inboundDebounceMs,
    linkPreviewPolicy: router.linkPreviewPolicy,
    senderFeedback: router.senderFeedback,
    inputMode: router.inputMode, enabled: true,
  });
  let candidateRow = candidate.row;
  if (input.inboundBirthMessageId !== undefined) {
    const payload = candidate.row.payload;
    if (!isJsonRecord(payload)) throw pluginError('channels_thread_binding_payload_invalid', 'The thread binding payload is unavailable.');
    candidateRow = { ...candidate.row, payload: { ...payload, inboundBirthMessageId: input.inboundBirthMessageId } };
  }
  assertNewConversationBindingCanPersist(candidate.binding);
  assertConversationBindingInputModeIsDeliverable({
    audience: candidate.binding.endpoint.audience,
    inputMode: candidate.binding.inputMode,
    sharedEndpointInputModes: readConversationConnectionSharedEndpointInputModes(connection.payload),
    operation: 'channels_binding_create',
  });
  const frontier = await createSessionProjectionFrontierForBinding({ bindingId, target: candidate.binding.target, context });
  const frontierId = createConversationSessionProjectionFrontierRowId(bindingId);
  const result = await persistConversationBindingCreation({
    collection,
    guards: [
      { kind: 'assert', rowId: router.connectionId, expectedRevision: input.expectedConnectionRevision },
      { kind: 'assert', rowId: router.id, expectedRevision: input.expectedRouterRevision },
    ],
    rows: [{ rowId: bindingId, value: candidateRow }, ...(frontier === null ? [] : [{ rowId: frontierId, value: frontier }])],
    signal: context.signal,
    assertNotAborted: () => assertNotAborted(context.signal),
  });
  if (result.status !== 'conflict') {
    const revision = result.results.find((entry) => entry.rowId === bindingId && !entry.deleted)?.revision;
    if (revision === undefined) throw pluginError('channels_thread_binding_result_invalid', 'The thread binding batch omitted its retained row result.', true);
    return { kind: 'created', binding: candidate.binding, revision };
  }
  if (result.conflicts.some((entry) => entry.rowId === router.id || entry.rowId === router.connectionId)) return { kind: 'stale' };
  return await rejoin() ?? { kind: 'stale' };
}

/** Creates one binding only after the target owner has verified its current Automation version. */
export async function createConversationBindingForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationBindingCreateResult> {
  const createInput = admittedActionInput<ConversationBindingCreateInputV1>(input);
  const audience = await resolveBindingAudienceSelection({
    connectionId: createInput.connectionId,
    expectedConnectionRevision: createInput.expectedConnectionRevision,
    endpointSelection: createInput.endpointSelection,
    principalSelection: createInput.principalSelection,
    operation: 'channels_binding_create',
    context,
  });
  if (audience.kind !== 'ready') return audience;
  return await createConversationBindingWithAudience(createInput, createInput.expectedConnectionRevision, audience, context);
}

/** Private continuation: the invoking journey already admitted this audience. */
async function createConversationBindingWithAudience(
  createInput: Omit<ConversationBindingCreateInputV1, 'endpointSelection' | 'principalSelection' | 'expectedConnectionRevision'>
    & Readonly<{ automaticTriggerId?: string }>,
  expectedConnection: number | ConversationConnectionUpdateRow,
  audience: Extract<BindingAudienceResolution, { kind: 'ready' }>,
  context: PluginInvocationContext,
): Promise<ConversationBindingCreateResult> {
  const { endpoint, allowedPrincipalIds } = audience;
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const connectionCurrentness = { collection, connectionId: createInput.connectionId, expectedConnection, context };
  // The binding identity is minted before verification so the Automation owner
  // can answer for this exact binding rather than for the target alone.
  const scopedIdentity = createInput.target.kind === 'automation'
    ? createInput.target.scopedTrigger
    : createInput.target.kind !== 'session' || createInput.target.pullRequestLink === undefined ? undefined : { sessionId: createInput.target.sessionId, pullRequest: createInput.target.pullRequestLink };
  const scopedBindingIdentity = scopedIdentity === undefined ? undefined : JSON.stringify([
    createInput.connectionId, endpoint.kind, endpoint.audience, endpoint.id, endpoint.parentId ?? null,
    scopedIdentity.sessionId, scopedIdentity.pullRequest.repository, scopedIdentity.pullRequest.number,
    'triggerId' in scopedIdentity ? scopedIdentity.triggerId : null,
  ]);
  const newBindingId = scopedBindingIdentity === undefined ? createBindingId() : `binding-pr-${encodeUnpaddedBase64Url(new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scopedBindingIdentity)),
  ))}`;
  let resolvedTarget: ConversationBindingTargetV1 | undefined;
  if (scopedIdentity !== undefined) {
    let retained = await collection.get(newBindingId, { signal: context.signal });
    if (retained !== null) {
      const current = readConversationBindingUpdateRow({ row: retained, bindingId: newBindingId });
      if (sameConversationBindingTarget(current.binding.target, createInput.target)
        && finalizingBindingDeleteIsAuthorized(current)) {
        const target = await resolveBindingTargetForPersistence(createInput.target, context, allowedPrincipalIds);
        if (target.kind === 'notVerified') return target;
        resolvedTarget = target;
        // Explicit reattachment may finish Account-only cleanup on another
        // Machine. Old custody still decides whether deletion can complete.
        await finalizeConversationBindingDelete({ bindingId: newBindingId, context });
        retained = await collection.get(newBindingId, { signal: context.signal });
      }
    }
    if (retained !== null) {
      const current = readConversationBindingUpdateRow({ row: retained, bindingId: newBindingId });
      const oldScope = current.binding.target.kind === 'automation' ? current.binding.target.scopedTrigger : undefined;
      const newScope = createInput.target.kind === 'automation' ? createInput.target.scopedTrigger : undefined;
      const scopeRevisionAdvances = current.binding.target.kind === 'automation' && createInput.target.kind === 'automation'
        && current.binding.target.automationId === createInput.target.automationId && oldScope !== undefined && newScope !== undefined
        && oldScope.sessionId === newScope.sessionId && oldScope.triggerId === newScope.triggerId
        && pluginJsonValuesEqual(oldScope.pullRequest, newScope.pullRequest) && newScope.triggerRevision > oldScope.triggerRevision;
      const sameTarget = sameConversationBindingTarget(current.binding.target, createInput.target);
      if ((sameTarget || scopeRevisionAdvances) && current.binding.deletionState === 'none') {
        if (scopeRevisionAdvances || (createInput.enabled !== undefined && createInput.enabled !== current.binding.enabled)) {
          const updated = await updateConversationBindingForInvocation({
            bindingId: newBindingId, expectedRevision: retained.revision,
            target: createInput.target, enabled: createInput.enabled ?? current.binding.enabled,
          }, context);
          if (!('bindingId' in updated)) return updated;
          const saved = await collection.get(newBindingId, { signal: context.signal });
          if (saved === null) throw pluginError('channels_binding_create_conflict', 'The updated PR binding became unavailable.', true);
          return { kind: 'created', binding: readConversationBindingUpdateRow({ row: saved, bindingId: newBindingId }).binding };
        }
        const target = resolvedTarget ?? await resolveBindingTargetForPersistence(createInput.target, context);
        if (target.kind === 'notVerified') return target;
        const currentness = await rereadBindingResolutionAfterProviderEffect(connectionCurrentness);
        if (currentness.kind !== 'current') return currentness;
        return { kind: 'created', binding: current.binding };
      }
      throw pluginError('channels_binding_create_conflict', 'The PR binding identity already has different target authority.', true);
    }
  }
  const defaults = conversationBindingPolicyForOmittedFieldsV1(endpoint.audience);
  const inputMode = createInput.inputMode ?? defaults.inputMode;
  assertConversationBindingInputModeIsDeliverable({
    audience: endpoint.audience,
    inputMode,
    sharedEndpointInputModes: audience.sharedEndpointInputModes,
    operation: 'channels_binding_create',
  });
  const createCandidate = (target: ConversationBindingTargetV1) => createConversationBindingRow({
    bindingId: newBindingId,
    ...(createInput.automaticTriggerId === undefined ? {} : { automaticTriggerId: createInput.automaticTriggerId }),
    connectionId: createInput.connectionId,
    endpoint,
    target,
    allowedPrincipalIds,
    allowBotSenders: createInput.allowBotSenders ?? defaults.allowBotSenders,
    inputMode,
    inboundDebounceMs: createInput.inboundDebounceMs ?? defaults.inboundDebounceMs,
    linkPreviewPolicy: createInput.linkPreviewPolicy ?? defaults.linkPreviewPolicy,
    senderFeedback: createInput.senderFeedback ?? defaults.senderFeedback,
    enabled: createInput.enabled ?? defaults.enabled,
  });

  let candidate: ReturnType<typeof createCandidate>;
  let connectionRowForPersistence: StateRow;
  let projectionFrontier: Awaited<ReturnType<typeof createSessionProjectionFrontierForBinding>> = null;
  if (createInput.target.kind === 'automation') {
    const target = resolvedTarget ?? await resolveBindingTargetForPersistence(createInput.target, context, allowedPrincipalIds);
    if (target.kind === 'notVerified') return target;
    // The Automation verifier is an external boundary. Re-read connection
    // authority and resolve the current stable provider before persistence.
    const finalCurrent = await rereadBindingResolutionAfterProviderEffect(connectionCurrentness);
    if (finalCurrent.kind !== 'current') return finalCurrent;
    connectionRowForPersistence = finalCurrent.row;
    candidate = createCandidate(target);
  } else {
    const target = resolvedTarget ?? await resolveBindingTargetForPersistence(createInput.target, context, allowedPrincipalIds);
    if (target.kind === 'notVerified') return target;
    candidate = createCandidate(target);
    projectionFrontier = await createSessionProjectionFrontierForBinding({
      bindingId: candidate.binding.id,
      target: candidate.binding.target,
      context,
    });
    const finalCurrent = await rereadBindingResolutionAfterProviderEffect(connectionCurrentness);
    if (finalCurrent.kind !== 'current') return finalCurrent;
    connectionRowForPersistence = finalCurrent.row;
  }
  assertNewConversationBindingCanPersist(candidate.binding);
  const rows = [{ rowId: newBindingId, value: candidate.row },
    ...(projectionFrontier === null ? [] : [{ rowId: createConversationSessionProjectionFrontierRowId(newBindingId), value: projectionFrontier }])];
  for (;;) {
    const result = await persistConversationBindingCreation({
      collection,
      guards: [candidate.binding.enabled
        ? { kind: 'put', value: connectionRowForPersistence.value, expectedRevision: connectionRowForPersistence.revision }
        : { kind: 'assert', rowId: createInput.connectionId, expectedRevision: connectionRowForPersistence.revision }],
      rows,
      signal: context.signal,
      assertNotAborted: () => assertNotAborted(context.signal),
    });
    if (result.status !== 'conflict') return { kind: 'created', binding: candidate.binding };
    if (scopedIdentity !== undefined) {
      const retained = await collection.get(newBindingId, { signal: context.signal });
      if (retained !== null) {
        const current = readConversationBindingUpdateRow({ row: retained, bindingId: newBindingId });
        if (sameConversationBindingTarget(current.binding.target, candidate.binding.target) && current.binding.deletionState === 'none') {
          return { kind: 'created', binding: current.binding };
        }
      } else if (typeof expectedConnection !== 'number' && result.conflicts.length === 1) {
        const [conflict] = result.conflicts;
        if (conflict?.rowId === createInput.connectionId && !conflict.deleted
          && conflict.revision !== null && conflict.revision > connectionRowForPersistence.revision) {
          // Poll settlement can advance the physical row after attach's final
          // read. Keep the admitted target, identities and Session frontier,
          // and retry only under the same connection configuration authority.
          const current = await readCurrentBindingResolutionConnection({
            ...connectionCurrentness, signal: context.signal,
          });
          if (current.kind !== 'current') return current;
          if (current.row.revision >= conflict.revision) {
            connectionRowForPersistence = current.row;
            continue;
          }
        }
      }
    }
    throw pluginError(
      'channels_binding_create_conflict',
      'Binding creation lost its current connection or unique binding-row compare-and-swap.',
      true,
    );
  }
}

async function readSessionPullRequestBindings(sessionId: string, context: PluginInvocationContext): Promise<Array<{ row: StateRow; binding: ConversationBindingV1 }>> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  return readSessionPullRequestBindingRows({ collection, sessionId, signal: context.signal });
}

/** The incumbent poll refreshes retained PR links; the existing Account Actions own settlement. */
export async function refreshSessionPullRequestBindingsForInvocation(input: Readonly<{
  provider: SessionPullRequestProvider;
  connectionRow: StateRow;
  bindingRows: readonly StateRow[];
  checkpointRow?: StateRow;
  endpoints: readonly ConversationResolvedEndpointV1[];
}>, context: PluginInvocationContext): Promise<Readonly<{ connectionRow: StateRow; bindingRows: readonly StateRow[] }>> {
  const changes = input.bindingRows.flatMap(row => {
    const current = readConversationBindingUpdateRow({ row, bindingId: row.rowId });
    const binding = current.binding;
    if (binding.connectionId !== input.connectionRow.rowId || binding.deletionState !== 'none'
      || binding.endpoint.kind !== 'githubPullRequest') return [];
    const sessionId = binding.target.kind === 'session' ? binding.target.sessionId
      : binding.target.kind === 'automation' ? binding.target.scopedTrigger?.sessionId : undefined;
    const pr = binding.target.kind === 'session' ? binding.target.pullRequestLink
      : binding.target.kind === 'automation' ? binding.target.scopedTrigger?.pullRequest : undefined;
    if (sessionId === undefined || pr === undefined) return [];
    let latest = binding.endpoint;
    let currentObservation = false;
    for (const observed of input.endpoints) {
      if (observed.kind !== 'githubPullRequest' || observed.pullRequestState === undefined
        || !areConversationEndpointIdentitiesEqual(binding.endpoint, observed)
        || observed.pullRequest?.repository !== pr?.repository || observed.pullRequest?.number !== pr?.number
        || observed.pullRequestState.observedAt < (latest.pullRequestState?.observedAt ?? -1)) continue;
      latest = observed;
      currentObservation = true;
    }
    if (latest.pullRequestState === undefined) return [];
    const pullRequest = binding.endpoint.pullRequest?.repository === pr.repository && binding.endpoint.pullRequest.number === pr.number
      ? binding.endpoint.pullRequest : latest.pullRequest;
    const stopDirectWatch = binding.target.kind === 'session' && binding.enabled
      && (latest.pullRequestState.state === 'merged' || latest.pullRequestState.state === 'closed');
    let target = binding.target;
    if (currentObservation && target.kind === 'session' && target.pullRequestWatch?.progress !== undefined && latest.pullRequestState.state === 'open') {
      const progress = resolveSessionPullRequestFixResolutionProgress(target.pullRequestWatch.progress, latest.pullRequestState.fixResolution);
      if (progress !== target.pullRequestWatch.progress) target = { ...target,
        pullRequestWatch: { ...target.pullRequestWatch, progress } };
    }
    if (target.kind === 'session' && target.pullRequestWatch?.progress?.activeRound !== undefined
      && (latest.pullRequestState.state === 'merged' || latest.pullRequestState.state === 'closed')) {
      const { activeRound: _endedRound, pendingSequenceEnd: _endedSequence, ...progress } = target.pullRequestWatch.progress;
      target = { ...target, pullRequestWatch: { ...target.pullRequestWatch, progress } };
    }
    const previousResolution = binding.endpoint.pullRequestState?.fixResolution;
    const resolution = latest.pullRequestState.fixResolution;
    const pullRequestState = latest.pullRequestState.state === binding.endpoint.pullRequestState?.state
      && resolution?.headRevision === previousResolution?.headRevision && resolution?.resolved === previousResolution?.resolved
      && resolution?.incomplete === previousResolution?.incomplete
      ? binding.endpoint.pullRequestState : latest.pullRequestState;
    if (pullRequestState === binding.endpoint.pullRequestState && pullRequest === binding.endpoint.pullRequest && !stopDirectWatch
      && target === binding.target) return [];
    const endpoint = pullRequestState === binding.endpoint.pullRequestState && pullRequest === binding.endpoint.pullRequest
      ? binding.endpoint : { ...binding.endpoint, pullRequest, pullRequestState };
    return [{ row, current, sessionId, binding: { ...binding, endpoint, target, enabled: stopDirectWatch ? false : binding.enabled } }];
  });
  if (changes.length === 0) return { connectionRow: input.connectionRow, bindingRows: input.bindingRows };
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  // A captured provider result must not settle private Session state after a
  // newer binding mutation won while that provider read was in flight.
  for (const change of changes) {
    const retained = await collection.get(change.row.rowId, { signal: context.signal });
    if (retained === null || retained.revision !== change.row.revision) {
      throw pluginError('channels_pr_observation_conflict', 'PR observation lost its retained binding revision.', true);
    }
  }
  // Settlement belongs to the whole Session, including retained links whose
  // native observations are owned by another connection.
  const current = (await Promise.all([...new Set(changes.map(change => change.sessionId))]
    .map(sessionId => readSessionPullRequestBindings(sessionId, context)))).flat();
  const changesById = new Map(changes.map(change => [change.binding.id, change]));
  const next = current.map(entry => changesById.get(entry.binding.id) ?? entry);
  const before = new Map(resolveSessionPullRequestLinksV1(current.map(entry => entry.binding), input.provider).map(row => [row.sessionId, row.pullRequestLinks]));
  for (const { sessionId, pullRequestLinks } of resolveSessionPullRequestLinksV1(next.map(entry => entry.binding), input.provider)) {
    const terminal = (link: typeof pullRequestLinks[number]) => link.state === 'merged' || link.state === 'closed';
    // Standing belongs to a Session. Closing one PR must never hide its other open/unknown PRs.
    if (!pullRequestLinks.every(terminal) || before.get(sessionId)?.every(terminal)) continue;
    for (const [id, value] of [
      ['session.read_state.set', { sessionId, state: 'read' }],
      ['session.attention.set', { sessionId, standing: false }],
    ] as const) {
      const result = await context.services.actions.execute(id, value, { signal: context.signal });
      if (isPluginActionApprovalRequestCreated(result)) throw pluginError('channels_pr_settlement_not_applied', 'PR settlement requires an Account Action decision.', true);
    }
  }
  let connectionRow = input.connectionRow;
  const refreshedBindings = new Map<string, StateRow>();
  for (const change of changes) {
    const updatedAt = Date.now();
    const result = await commitConversationBindingMutation({ collection, row: change.row,
      current: change.current,
      connectionRow, binding: change.binding,
      ...(input.checkpointRow === undefined ? {} : { additionalMutations: [{ kind: 'assert' as const, rowId: input.checkpointRow.rowId, expectedRevision: input.checkpointRow.revision }] }),
      updatedAt, signal: context.signal });
    if (result.kind !== 'updated') throw pluginError('channels_pr_observation_conflict', 'PR observation lost its retained binding revision.', true);
    connectionRow = { ...connectionRow, revision: result.connectionRevision };
    refreshedBindings.set(change.row.rowId, { ...change.row, revision: result.revision,
      value: withConversationBindingPolicy({ row: change.row, current: change.current,
        binding: change.binding, updatedAt }) });
  }
  const archiveCandidates = new Map<string, string>();
  for (const change of changes) {
    const target = change.binding.target;
    if (target.kind !== 'session' || target.pullRequestWatch?.policy.archiveAfterMerge !== true
      || target.pullRequestWatch.policy.mode === 'off' || change.binding.endpoint.kind !== 'githubPullRequest'
      || change.binding.endpoint.pullRequestState?.state !== 'merged'
      || (change.current.binding.endpoint.kind === 'githubPullRequest'
        && change.current.binding.endpoint.pullRequestState?.state === 'merged')) continue;
    archiveCandidates.set(change.sessionId, change.binding.id);
  }
  for (const [sessionId, bindingId] of archiveCandidates) {
    try {
      await archiveSessionPullRequestWatchAfterMerge({ sessionId, bindingId, provider: input.provider }, context);
    } catch (error) {
      // This optional one-shot consequence cannot retry an uncertain archive
      // or suppress the provider's terminal status/checkpoint. Explicit Archive
      // remains available through the existing Session lifecycle owner.
      context.services.logger.warn('[Channels] optional PR merge archive could not complete', {
        sessionId, ...(isPluginError(error) ? { code: error.code } : {}),
      });
    }
  }
  return { connectionRow, bindingRows: input.bindingRows.map(row => refreshedBindings.get(row.rowId) ?? row) };
}

async function disableSessionPullRequestTriggerBindings(input: Readonly<{
  sessionId: string; triggerId?: string; triggerRevision?: number; exceptBindingId?: string; automationId?: string;
}>, context: PluginInvocationContext): Promise<void> {
  let retainedTriggerIds: Set<string> | undefined;
  for (const { row, binding } of await readSessionPullRequestBindings(input.sessionId, context)) {
    if (!binding.enabled || binding.id === input.exceptBindingId || binding.target.kind !== 'automation') continue;
    const scope = binding.target.scopedTrigger;
    if (scope === undefined || (input.triggerId !== undefined && scope.triggerId !== input.triggerId)) continue;
    if (input.triggerRevision !== undefined && scope.triggerRevision > input.triggerRevision) continue;
    if (input.automationId !== undefined) {
      const payload = own(row.value, 'payload');
      if (binding.target.automationId !== input.automationId
        || !isJsonRecord(payload) || own(payload, 'automaticTriggerId') !== scope.triggerId) continue;
      if (retainedTriggerIds === undefined) {
        // The invoking surface supplies the selector. The Workflow owner supplies deletion evidence.
        const listed = await context.services.actions.execute('workflow.trigger.list', {
          lifetimeSession: { sessionId: input.sessionId },
        }, { signal: context.signal });
        if (isPluginActionApprovalRequestCreated(listed) || listed.lifetimeSession?.sessionId !== input.sessionId) {
          throw pluginError('channels_pr_link_session_not_verified', 'Could not verify the current Workflow triggers for this Session.');
        }
        const set = listed.sets.find(item => item.automationId === input.automationId);
        retainedTriggerIds = new Set(set?.triggers.map(trigger => trigger.id));
      }
      if (retainedTriggerIds.has(scope.triggerId)) continue;
    }
    await setConversationBindingEnabledForInvocation({ bindingId: binding.id, expectedRevision: row.revision, enabled: false }, context);
  }
}

/** Optional one-shot presentation after an explicit link has already committed. */
async function completeSessionPullRequestLink(
  input: SessionPullRequestLinkCompletionInputV1,
  context: PluginInvocationContext,
): Promise<SessionPullRequestLinkCompletionFailureV1[]> {
  const failures: SessionPullRequestLinkCompletionFailureV1[] = [];
  const reportUnavailable = (failure?: SessionPullRequestLinkCompletionFailureV1, contributor?: Readonly<{ pluginId: string; contributionId: string }>) => {
    if (failure !== undefined) failures.push(failure);
    try {
      context.services.logger.warn('[Channels] optional PR link completion could not complete', {
        sessionId: input.session.sessionId,
        ...(contributor ? { pluginId: contributor.pluginId, contributionId: contributor.contributionId } : {}),
        ...failure,
      });
    } catch {
      // Even an unavailable diagnostic sink cannot undo the acknowledged link.
    }
  };
  const readFailure = (error: unknown): SessionPullRequestLinkCompletionFailureV1 | undefined => {
    if (!isPluginError(error)) return undefined;
    const requestId = readPluginErrorRequestIdV1(error);
    return { code: error.code, ...(requestId === undefined ? {} : { requestId }) };
  };
  try {
    context.signal.throwIfAborted();
    const observation = context.services.targetedContributions.observeForSelf(
      SESSION_PULL_REQUEST_LINK_COMPLETIONS_CONTRIBUTION_POINT_REF_V1,
      { onInvalidated: () => {} },
    );
    try {
      const snapshot = await observation.readCurrent({ signal: context.signal });
      for (const contribution of snapshot.contributions) {
        if (context.signal.aborted) break;
        try {
          const result = SessionPullRequestLinkCompletionResultV1Schema.parse(
            await context.services.actions.executeAdmittedTargetedOperation(contribution.operations.complete, input, {
              signal: context.signal,
            }),
          );
          if (result.kind === 'unavailable') reportUnavailable(result.failure, contribution.contributor);
        } catch (error) {
          // The original opaque operation still owns currentness, caller and
          // approval. A held or uncertain completion is never replayed here.
          reportUnavailable(readFailure(error), contribution.contributor);
        }
      }
    } finally {
      await observation.dispose();
    }
  } catch (error) {
    reportUnavailable(readFailure(error));
  }
  return failures;
}

/** Session/PR links are projections of the incumbent binding rows, never a second store. */
export async function manageSessionPullRequestBindingForInvocation(input: JsonValue, context: PluginInvocationContext): Promise<SessionPullRequestBindingResultV1> {
  const parsed = SessionPullRequestBindingInputV1Schema.parse(input);
  if (parsed.kind === 'readRelations') return (await selectSessionPullRequestRelations(parsed, context)).result;
  const sessionId = SessionIdSchema.parse(parsed.sessionId);
  let selected = parsed.kind === 'attach' && ('pullRequestUrl' in parsed || 'pullRequestUrls' in parsed)
    ? await readSessionPullRequestProvider({ targetedContributions: context.services.targetedContributions, signal: context.signal }) : undefined;
  function resolveRequest() {
    if (parsed.kind !== 'attach') return { ...parsed, sessionId };
    const pullRequests = 'pullRequest' in parsed ? [parsed.pullRequest] : 'pullRequests' in parsed ? parsed.pullRequests
      : ('pullRequestUrl' in parsed ? [parsed.pullRequestUrl] : parsed.pullRequestUrls).map(url => {
        const target = parseSessionPullRequestUrl(selected!.contribution.descriptor.pullRequests!, url);
        if (target === null) throw pluginError('channels_pr_link_url_invalid', 'The URL must identify one supported pull request.');
        return { repository: target.repository, number: target.number };
      });
    return { kind: 'attach' as const, sessionId, credentialRef: parsed.credentialRef,
      expectedRepositoryId: parsed.expectedRepositoryId, target: 'target' in parsed ? parsed.target : undefined,
      bulk: 'pullRequests' in parsed || 'pullRequestUrls' in parsed, pullRequests, pullRequest: pullRequests[0]! };
  }
  const request = resolveRequest();
  // The canonical Action reader retains the invoking caller's Session scope;
  // Account collection access by itself does not authorize this Session.
  const session = await context.services.actions.execute('session.transcript.get', {
    sessionId, projection: 'externalShareableV1', limit: 1,
  }, { signal: context.signal });
  if (isPluginActionApprovalRequestCreated(session) || session.sessionId !== sessionId || session.projection !== 'externalShareableV1') {
    throw pluginError('channels_pr_link_session_not_verified', 'The calling principal could not read the requested Session.');
  }
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  if (request.kind !== 'attach') {
    if (request.kind === 'unlink') {
      const bindings = await readSessionPullRequestBindings(request.sessionId, context);
      const pullRequestOf = (binding: ConversationBindingV1) => binding.target.kind === 'session' ? binding.target.pullRequestLink
        : binding.target.kind === 'automation' ? binding.target.scopedTrigger?.pullRequest : undefined;
      const relationKey = (binding: ConversationBindingV1) => JSON.stringify([binding.connectionId, pullRequestOf(binding)]);
      const selectedRelations = new Set<string>();
      if ('states' in request) {
        if (bindings.length === 0) return { kind: 'removed' };
        const { contribution } = await readSessionPullRequestProvider({ targetedContributions: context.services.targetedContributions, signal: context.signal });
        const links = resolveSessionPullRequestLinksV1(bindings.map(({ binding }) => binding), contribution.descriptor.pullRequests!)
          .find(link => link.sessionId === request.sessionId)?.pullRequestLinks ?? [];
        const selectedPullRequests = new Set(links.filter(link => request.states.includes(link.state ?? 'unknown'))
          .map(link => JSON.stringify([link.repository, link.number])));
        for (const { binding } of bindings) {
          const pr = pullRequestOf(binding)!;
          if (selectedPullRequests.has(JSON.stringify([pr.repository, pr.number]))) selectedRelations.add(relationKey(binding));
        }
      } else {
        const operands = 'bindings' in request ? request.bindings : [request];
        // Verify the complete explicit selection before the first local mutation.
        for (const operand of operands) {
          const selected = bindings.find(({ binding }) => binding.id === operand.bindingId);
          if (selected === undefined) {
            const row = await collection.get(operand.bindingId, { signal: context.signal });
            if (row !== null) {
              const { binding } = readConversationBindingUpdateRow({ row, bindingId: operand.bindingId });
              const targetSessionId = binding.target.kind === 'session' ? binding.target.sessionId : binding.target.kind === 'automation' ? binding.target.scopedTrigger?.sessionId : undefined;
              if (targetSessionId !== request.sessionId || binding.deletionState === 'none') throw pluginError('channels_pr_link_binding_not_verified', 'The binding does not identify this Session’s retained PR link.');
            }
            continue;
          }
          if (selected.row.revision !== operand.expectedRevision) throw pluginError('channels_pr_link_conflict', 'The retained PR link revision changed.', true);
          selectedRelations.add(relationKey(selected.binding));
        }
      }
      for (const candidate of bindings) {
        if (!selectedRelations.has(relationKey(candidate.binding))) continue;
        // Revocation is the canonical unlink fact. Its incumbent bounded wake
        // owns physical cleanup; no new finalizer or provider write is added.
        await deleteConversationBindingForInvocation({ bindingId: candidate.binding.id, expectedRevision: candidate.row.revision }, context);
      }
      return { kind: 'removed' };
    }
    if (request.kind === 'removeTrigger') {
      await disableSessionPullRequestTriggerBindings(request, context);
      return { kind: 'removed' };
    }
    return readSessionPullRequestLinks(request.sessionId, context);
  }
  const status = await context.services.actions.execute('session.status.get', {
    sessionId: request.sessionId, includeAcceptedWorkspace: true,
  }, { signal: context.signal });
  selected ??= await readSessionPullRequestProvider({ targetedContributions: context.services.targetedContributions, signal: context.signal });
  const providerSelection = selected!.selection;
  const provider = providerFromSelectedContribution(selected!.contribution);
  const native = selected!.contribution.descriptor.pullRequests!;
  const requestedRepository = normalizeScmHostingRepositoryIdentity({
    kind: native.repositoryKind, deployment: native.deployment, repository: request.pullRequest.repository,
  });
  // The optional host read projection is external to this plugin. Admit its
  // closed authority shape before using it, including with an older host.
  const acceptedWorkspace = isPluginActionApprovalRequestCreated(status) || !('session' in status)
    ? null : SessionAcceptedWorkspaceV1Schema.safeParse(status.acceptedWorkspace);
  if (isPluginActionApprovalRequestCreated(status) || !('session' in status)
    || status.session.id !== request.sessionId || acceptedWorkspace?.success !== true
    || request.pullRequests.some(pr => !sameScmHostingRepositoryIdentity(normalizeScmHostingRepositoryIdentity(acceptedWorkspace.data.repository),
      normalizeScmHostingRepositoryIdentity({ kind: native.repositoryKind, deployment: native.deployment, repository: pr.repository })))) {
    throw pluginError('channels_pr_link_checkout_not_verified', 'The pull request repository does not match the Session’s accepted checkout.');
  }
  const sourceOrigin = request.credentialRef === null ? getSelfStampedPluginCallerExecutionOrigin(context.caller) : undefined;
  if (request.credentialRef === null && (sourceOrigin === undefined || context.caller?.kind !== 'plugin' || context.caller.pluginId !== provider.pluginId)) {
    throw pluginError('channels_pr_link_native_origin_unavailable', 'Native PR attach requires the admitted provider source placement.');
  }
  assertSelectedTransportRoleAvailable({ provider, selectedTransport: 'checkpointedPull' });
  // Admit the native credential and source once; private continuations consume
  // these facts without another setup or a public-input bypass.
  const nativeSetup = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(provider.setup, {
    repository: request.pullRequest.repository, ...(request.credentialRef === undefined ? {} : { credentialRef: request.credentialRef }),
  }, { signal: context.signal, ...(request.credentialRef === undefined ? {} : { expectedSelectedConnectedAccountRef: request.credentialRef }),
    ...(sourceOrigin === undefined ? {} : { expectedExecutionRouting: getConversationConnectionExecutionRouting(getConversationConnectionTransportOrigin(sourceOrigin), provider.pluginId) }) });
  const setup = ConversationProviderSetupOutcomeV1Schema.parse(nativeSetup.result);
  if ('kind' in setup) throw pluginError('channels_pr_link_provider_not_ready', 'The selected native SCM account is not ready to attach this PR.', true);
  assertProviderSetupTransportFacts(setup);
  assertProviderExecutionOrigin({ provider, executionOrigin: nativeSetup.executionOrigin, operation: 'setup' });
  if (request.credentialRef !== undefined && !pluginJsonValuesEqual(request.credentialRef, setup.credentialRef)) throw pluginError('channels_pr_link_credential_mismatch', 'The provider did not authenticate the exact configured credential.');
  if (request.expectedRepositoryId !== undefined && setup.providerConnectionKey !== `${native.repositoryConnectionKeyPrefix}${request.expectedRepositoryId}`) throw pluginError('channels_pr_link_repository_mismatch', 'The authenticated repository does not match the immutable source identity.');
  const createInput: ConversationConnectionCreateInputV1 = { providerSelection, providerSetupInput: { repository: request.pullRequest.repository, credentialRef: setup.credentialRef }, credentialRef: setup.credentialRef, selectedTransport: 'checkpointedPull' };
  const connectionIdForTest = createConnectionId();
  const prepared = await runProviderConnectionTest({ context, setupInput: createInput, provider, connectionIdForTest,
    prepared: { kind: 'ready', setup, transportOrigin: nativeSetup.executionOrigin } });
  if (prepared.kind !== 'ready') throw refuseSessionPullRequestConnection(context, 'test', prepared.reason);
  const connectionResult = await persistPreparedConversationConnection(createInput, provider, prepared, connectionIdForTest, context);
  if (connectionResult.kind !== 'created' && connectionResult.kind !== 'rejoined') throw refuseSessionPullRequestConnection(context, 'retain');
  const connectionId = connectionResult.connectionId;
  const connectionAdmission = admitBindingResolutionConnection({ row: connectionResult.connectionRow, connectionId });
  if (connectionAdmission.kind !== 'current') throw refuseSessionPullRequestConnection(context, 'retain');
  const connection = connectionAdmission.connection;
  // Rejoin retains the connection's transport placement and credential. These
  // one-shot reads consume this attach's authenticated setup, never persist it.
  const resolutionConnection: ConversationConnectionUpdateRow = {
    ...connection,
    transportOrigin: getConversationConnectionTransportOrigin(prepared.transportOrigin),
    payload: {
      ...connection.payload,
      providerConnectionKey: prepared.setup.providerConnectionKey,
      providerConfigVersion: prepared.setup.providerConfigVersion,
      providerConfig: prepared.setup.providerConfig,
      credentialRef: prepared.setup.credentialRef,
    },
  };
  const retainedBindings = (await readSessionPullRequestBindings(request.sessionId, context)).map(({ binding }) => binding);
  const bindingsById = new Map(retainedBindings.map(binding => [binding.id, binding]));
  const attachedBindingIds: string[] = [];
  // Admission proved that every operand has this one repository identity.
  // The PR number therefore deduplicates aliases as well as identical operands.
  for (const number of new Set(request.pullRequests.map(pr => pr.number))) {
    const pullRequest = { repository: request.pullRequest.repository, number };
    const query = sessionPullRequestUrl(native, pullRequest);
    const endpoints = await resolveBindingEndpointCandidatesForConnection({ connectionId, connection: resolutionConnection, endpointResolve: provider.endpointResolve, query, kinds: ['githubPullRequest'], context });
    if (endpoints.kind !== 'endpointCandidates' || endpoints.candidates.length !== 1 || endpoints.candidates[0]?.kind !== 'githubPullRequest') throw pluginError('channels_pr_link_endpoint_unavailable', 'The exact PR endpoint is unavailable.', true);
    const endpoint = endpoints.candidates[0];
    if (request.expectedRepositoryId !== undefined && endpoint.parentId !== request.expectedRepositoryId) throw pluginError('channels_pr_link_repository_mismatch', 'The authenticated PR endpoint does not match the immutable source repository.');
    if (endpoint.pullRequest === undefined) throw pluginError('channels_pr_link_endpoint_identity_missing', 'The provider did not authenticate the PR identity.');
    if (endpoint.pullRequest.number !== pullRequest.number
      || !sameScmHostingRepositoryIdentity(normalizeScmHostingRepositoryIdentity({
        kind: native.repositoryKind, deployment: native.deployment, repository: endpoint.pullRequest.repository,
      }), requestedRepository)) throw pluginError('channels_pr_link_endpoint_identity_mismatch', 'The authenticated PR endpoint does not match the requested PR.');
    const principalQuery = setup.integrationPrincipal.label ?? setup.integrationPrincipal.id;
    const principals = await resolveBindingPrincipalCandidatesForConnection({ connectionId, connection: resolutionConnection, principalResolve: provider.principalResolve, endpoint, query: principalQuery, context });
    if (principals.kind !== 'principalCandidates') throw pluginError('channels_pr_link_principal_unavailable', 'The native SCM principal is unavailable.', true);
    const principal = principals.candidates.find((candidate) => candidate.id === setup.integrationPrincipal.id);
    if (principal === undefined) throw pluginError('channels_pr_link_principal_unavailable', 'The provider did not authenticate the selected SCM principal.', true);
    // Attaching membership must not replace a retained Watch's policy or turn
    // it off. The same canonical creation/rejoin owner still proves authority.
    const retained = request.target === undefined ? retainedBindings
      .find(binding => binding.connectionId === connectionId && binding.target.kind === 'session'
        && areConversationEndpointIdentitiesEqual(binding.endpoint, endpoint)
        && pluginJsonValuesEqual(binding.target.pullRequestLink, endpoint.pullRequest)) : undefined;
    const target: ConversationBindingTargetV1 = retained?.target ?? (request.target === undefined ? {
      kind: 'session', sessionId: request.sessionId, pullRequestLink: endpoint.pullRequest,
      policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } },
    } : {
      kind: 'automation', automationId: request.target.automationId, policy: { resultDelivery: 'none' },
      scopedTrigger: { sessionId: request.sessionId, triggerId: request.target.triggerId, triggerRevision: request.target.triggerRevision, triggerKind: request.target.triggerKind, principalPolicy: 'repositoryWriters', pullRequest: endpoint.pullRequest },
    });
    const binding = await createConversationBindingWithAudience({
      connectionId, target, allowBotSenders: principal.kind === 'bot',
      inputMode: 'allAllowedMessages', inboundDebounceMs: 0, enabled: retained?.enabled ?? request.target !== undefined,
      ...(request.target?.origin === 'automatic' ? { automaticTriggerId: request.target.triggerId } : {}),
    }, connection, {
      kind: 'ready', endpoint, allowedPrincipalIds: [principal.id],
      ...(endpoints.sharedEndpointInputModes === undefined ? {} : { sharedEndpointInputModes: endpoints.sharedEndpointInputModes }),
    }, context);
    if (binding.kind === 'stale') {
      throw refuseSessionPullRequestConnection(context, 'bind');
    }
    if (binding.kind === 'unavailable' && binding.reason === 'providerUnavailable') {
      throw pluginError('channels_pr_link_provider_not_ready', 'The selected PR conversation provider became unavailable during attachment.', true);
    }
    if (binding.kind !== 'created') throw pluginError('channels_pr_link_binding_not_ready', 'The PR binding could not be attached.', true);
    if (request.target !== undefined) await disableSessionPullRequestTriggerBindings({ sessionId: request.sessionId, triggerId: request.target.triggerId, triggerRevision: request.target.triggerRevision, exceptBindingId: binding.binding.id }, context);
    bindingsById.set(binding.binding.id, binding.binding);
    attachedBindingIds.push(binding.binding.id);
  }
  const failures = await completeSessionPullRequestLink({ v: 1, session: {
    serverId: acceptedWorkspace.data.checkout.serverId, sessionId: request.sessionId,
  } }, context);
  const completion = failures.length === 0 ? {} : { completionFailures: failures };
  if (!request.bulk) return { kind: 'attached', bindingId: attachedBindingIds[0]!, ...completion };
  const projection = resolveSessionPullRequestLinksV1([...bindingsById.values()], native)
    .find(link => link.sessionId === request.sessionId)!;
  return { kind: 'links', ...projection, ...completion };
}

/** All existing-binding writes share one transition, verifier, and atomic persistence owner. */
async function mutateConversationBinding(
  updateInput: ConversationBindingSetEnabledInputV1,
  context: PluginInvocationContext,
  operation: 'channels_binding_set_enabled',
): Promise<
  | ConversationBindingUpdateResultV1
  | Extract<ConversationBindingMutationResultV1, Readonly<{ kind: 'notVerified' }>>
>;
async function mutateConversationBinding(
  updateInput: ConversationBindingUpdateInputV1,
  context: PluginInvocationContext,
  operation?: 'channels_binding_update',
): Promise<ConversationBindingMutationResultV1>;
async function mutateConversationBinding(
  updateInput: ConversationBindingUpdateInputV1,
  context: PluginInvocationContext,
  operation: 'channels_binding_update' | 'channels_binding_set_enabled' = 'channels_binding_update',
): Promise<ConversationBindingMutationResultV1> {
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
  const audienceSelection = updateInput.audienceSelection;
  if (audienceSelection !== undefined) {
    if (connection.configurationRevision !== audienceSelection.expectedConnectionRevision) {
      return bindingResolutionStale();
    }
    audience = await resolveBindingAudienceSelection({
      connectionId: current.binding.connectionId,
      expectedConnectionRevision: audienceSelection.expectedConnectionRevision,
      endpointSelection: audienceSelection.endpointSelection,
      principalSelection: audienceSelection.principalSelection,
      operation: 'channels_binding_update',
      context,
    });
    if (audience.kind !== 'ready') return audience;
  }

  const requestedInputMode = updateInput.inputMode ?? current.binding.inputMode;
  const requestedEndpoint = audience?.endpoint ?? current.binding.endpoint;
  let target = current.binding.target;
  if (
    updateInput.target !== undefined
    || (audience !== null && current.binding.target.kind === 'threadRouter')
    || (
      updateInput.enabled === true
      && !current.binding.enabled
      && current.binding.target.kind === 'automation'
    )
  ) {
    const verifiedTarget = await resolveBindingTargetForPersistence(
      updateInput.target ?? current.binding.target,
      context,
      audience?.allowedPrincipalIds ?? current.binding.allowedPrincipalIds,
    );
    if (verifiedTarget.kind === 'notVerified') {
      if (operation === 'channels_binding_set_enabled') {
        throw pluginError(
          `${operation}_target_not_verified`,
          'The retained Workflow target is not currently eligible for this binding.',
        );
      }
      return verifiedTarget;
    }
    target = verifiedTarget;
  }
  const transition = transitionConversationBinding({
    current: current.binding,
    requested: {
      ...current.binding,
      endpoint: requestedEndpoint,
      target,
      allowedPrincipalIds: audience?.allowedPrincipalIds ?? current.binding.allowedPrincipalIds,
      allowBotSenders: updateInput.allowBotSenders ?? current.binding.allowBotSenders,
      inputMode: requestedInputMode,
      inboundDebounceMs: updateInput.inboundDebounceMs ?? current.binding.inboundDebounceMs,
      linkPreviewPolicy: updateInput.linkPreviewPolicy ?? current.binding.linkPreviewPolicy,
      senderFeedback: updateInput.senderFeedback ?? current.binding.senderFeedback,
      enabled: updateInput.enabled ?? current.binding.enabled,
    },
  });
  assertConversationBindingMutationCanPersist(transition, connection.payload, operation);
  if (transition.kind === 'unchanged') {
    return {
      kind: 'unchanged',
      bindingId: updateInput.bindingId,
      revision: row.revision,
      authorityEpoch: transition.binding.authorityEpoch,
    };
  }

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
  let connectionRowForPersistence: StateRow;
  if (audience !== null) {
    // Re-read connection authority and the current stable provider after
    // Automation verification or Session-baseline reads.
    const finalCurrent = await rereadBindingResolutionAfterProviderEffect({
      collection,
      connectionId: current.binding.connectionId,
      expectedConnection: connection.configurationRevision,
      context,
    });
    if (finalCurrent.kind !== 'current') return finalCurrent;
    connectionRowForPersistence = finalCurrent.row;
  } else {
    const finalCurrent = await readCurrentBindingResolutionConnection({
      collection,
      connectionId: current.binding.connectionId,
      expectedConnection: connection.configurationRevision,
      signal: context.signal,
    });
    if (finalCurrent.kind !== 'current') {
      throw pluginError(`${operation}_conflict`, 'Binding mutation requires the current connection configuration.', true);
    }
    connectionRowForPersistence = finalCurrent.row;
  }
  const result = await commitConversationBindingMutation({
    collection,
    row,
    current,
    connectionRow: connectionRowForPersistence,
    binding: transition.binding,
    updatedAt: Date.now(),
    additionalMutations: projectionFrontier === null
      ? []
      : [{
        kind: 'put' as const,
        value: projectionFrontier,
        expectedRevision: projectionFrontierExpectedRevision,
      }],
    signal: context.signal,
    assertCurrent: () => assertNotAborted(context.signal),
  });
  if (result.kind === 'conflict') {
    throw pluginError(
      `${operation}_conflict`,
      'Binding mutation lost its retained-row compare-and-swap.',
      true,
    );
  }
  if (result.kind === 'invalidResult') {
    throw pluginError(
      `${operation}_result_invalid`,
      'Binding mutation batch did not return its retained row result.',
      true,
    );
  }
  return {
    kind: 'updated',
    bindingId: updateInput.bindingId,
    revision: result.revision,
    authorityEpoch: transition.binding.authorityEpoch,
  };
}

export async function updateConversationBindingForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationBindingMutationResultV1> {
  const updateInput = admittedActionInput<ConversationBindingUpdateInputV1>(input);
  return await mutateConversationBinding(updateInput, context);
}

/** The narrow enable/disable Action uses the same canonical binding mutation owner. */
export async function setConversationBindingEnabledForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationBindingUpdateResult> {
  const setEnabledInput = admittedActionInput<ConversationBindingSetEnabledInputV1>(input);
  const result = await mutateConversationBinding(
    setEnabledInput,
    context,
    'channels_binding_set_enabled',
  );
  if (result.kind === 'notVerified') {
    throw pluginError(
      'channels_binding_set_enabled_target_not_verified',
      'The retained Workflow target is not currently eligible for this binding.',
    );
  }
  return result;
}

/** Dismisses one exact recovered Session transcript notice without moving its cursor. */
export async function dismissConversationSessionProjectionNoticeForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationSessionProjectionNoticeDismissResultV1> {
  const request = admittedActionInput<ConversationSessionProjectionNoticeDismissInputV1>(input);
  const dismissed = await dismissConversationSessionProjectionNotice({
    stateCollection: requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION),
    bindingId: request.bindingId,
    expectedBindingRevision: request.expectedBindingRevision,
    expectedFrontierRevision: request.expectedFrontierRevision,
    signal: context.signal,
    now: Date.now(),
  });
  return ConversationSessionProjectionNoticeDismissResultV1Schema.parse({
    kind: 'noticeDismissed',
    bindingId: request.bindingId,
    bindingRevision: dismissed.bindingRevision,
    frontierRevision: dismissed.frontierRevision,
  });
}

/**
 * The one binding-delete owner first revokes all future binding authority in
 * the retained row. The incumbent bounded wake and explicit reattachment
 * consume the same cleanup owner without reviving retained work.
 */
export async function deleteConversationBindingForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationBindingDeleteResultV1> {
  const deleteInput = admittedActionInput<ConversationBindingDeleteInputV1>(input);
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

  let demandConnectionRow: StateRow | undefined;
  if (current.binding.enabled) {
    const storedConnection = await collection.get(
      current.binding.connectionId,
      { signal: context.signal },
    );
    assertNotAborted(context.signal);
    if (storedConnection === null) {
      throw pluginError(
        'channels_binding_delete_connection_not_found',
        'Binding deletion owner connection does not exist.',
      );
    }
    demandConnectionRow = asChannelStateRow(storedConnection);
    if (demandConnectionRow === undefined) {
      throw pluginError(
        'channels_binding_delete_connection_corrupt',
        'Binding deletion owner connection is not canonical.',
      );
    }
    readConversationConnectionUpdateRow({
      row: demandConnectionRow,
      connectionId: current.binding.connectionId,
    });
  }

  const result = await collection.batch([
    ...(demandConnectionRow === undefined
      ? []
      : [{
        kind: 'put' as const,
        value: demandConnectionRow.value,
        expectedRevision: demandConnectionRow.revision,
      }]),
    {
      kind: 'put',
      value: withChannelStateDeleteFinalizationDueAt(withChannelStateSessionIdentity({
        ...row.value,
        [CHANNEL_STATE_FIELD.updatedAt]: Date.now(),
        payload: {
          ...current.payload,
          enabled: false,
          authorityEpoch: current.binding.authorityEpoch + 1,
          deletionState: 'finalizingDelete',
        },
      }, current.binding.target)),
      expectedRevision: row.revision,
    },
  ], { signal: context.signal });
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
  const resolution = admittedActionInput<ConversationDeliveryResolveInputV1>(input);
  return await resolveConversationOutwardDeliveryCustodyInAccountCollection({
    stateCollection: requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION),
    deliveriesCollection: requireChannelsAccountStorage(context).collection(CHANNEL_DELIVERIES_COLLECTION),
    ...resolution,
    signal: context.signal,
    async assertExecutionPlacement(connectionId) {
      if (!await isConversationConnectionPlacedForInvocation(context, connectionId)) {
        throw pluginError('channels_delivery_resolve_unavailable', 'Delivery resolution requires the connection placement to be available.', true);
      }
    },
  });
}

/**
 * The one connection-creation owner. Non-durable transports keep their exact
 * previous persistence shape. A durable-push selection runs the strict
 * two-call journey: the first call returns the preallocated final identity
 * plus the generic endpoint-ensure facts, and the continuation proves
 * host-derived correspondence before the incumbent reservation and connection
 * rows are written or rejoined.
 */
export async function createConversationConnectionForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionCreateResult> {
  const createInput = admittedActionInput<ConversationConnectionCreateInputV1>(input);
  const provider = await readCurrentSelectedProvider({
    context,
    selection: createInput.providerSelection,
  });
  // The preallocated ID is the one final connection identity for this whole
  // create journey. It feeds the provider connection-test correlation and,
  // for durable push, the endpoint source instance, and it is the ID the
  // Account batch persists or a later exact rejoin observes — setup never
  // mints a second identity after the endpoint exists.
  const connectionId = createInput.endpointContinuation === undefined
    ? createConnectionId()
    : createInput.endpointContinuation.connectionId;
  const prepared = await runProviderSetupAndTest({
    context,
    setupInput: createInput,
    provider,
    connectionIdForTest: connectionId,
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
  const result = await persistPreparedConversationConnection(createInput, providerForPersistence, prepared, connectionId, context);
  // The row is private continuation data, never a public Action result.
  return 'connectionRow' in result ? { kind: result.kind, connectionId: result.connectionId } : result;
}

/** One persistence owner for public creation and the admitted PR journey. */
async function persistPreparedConversationConnection(
  createInput: ConversationConnectionCreateInputV1,
  provider: CurrentProvider,
  prepared: Extract<ProviderConnectionPreparation, { kind: 'ready' }>,
  connectionId: string,
  context: PluginInvocationContext,
): Promise<PreparedConversationConnectionResult> {
  // Any existing exact connection rejoins before the endpoint journey can
  // ensure anything new; uniqueness stays the one identity authority. The
  // durable-push continuation is the one exception: it re-runs this same
  // uniqueness lookup itself so a retained connection rejoins only with the
  // exact endpoint it was created with, and anything else fails closed.
  const isDurablePushContinuation = createInput.selectedTransport === 'durablePush'
    && createInput.endpointContinuation !== undefined;
  if (!isDurablePushContinuation) {
    const existing = await findExistingConnection({
      context,
      createInput,
      providerPluginId: provider.pluginId,
      setup: prepared.setup,
    });
    if (existing !== null) return { kind: 'rejoined', connectionId: existing.rowId, connectionRow: existing };
  }

  if (createInput.selectedTransport === 'durablePush') {
    if (createInput.endpointContinuation === undefined) {
      return await prepareEndpointRequiredConnectionJourney({
        connectionId,
        setup: prepared.setup,
        transportOrigin: prepared.transportOrigin,
      });
    }
    return await continueDurablePushConnectionCreation({
      context,
      createInput,
      connectionId,
      providerPluginId: provider.pluginId,
      setup: prepared.setup,
      transportOrigin: prepared.transportOrigin,
      continuation: createInput.endpointContinuation,
    });
  }
  if (createInput.endpointContinuation !== undefined) {
    throw pluginError(
      'channels_connection_create_endpoint_continuation_invalid',
      'Only a durable-push connection creation continues after the webhook endpoint is ensured.',
      true,
    );
  }

  return await createOrRejoinConnection({
    context,
    createInput,
    providerPluginId: provider.pluginId,
    setup: prepared.setup,
    transportOrigin: getConversationConnectionTransportOrigin(prepared.transportOrigin),
    connectionId,
  });
}

/** The declared webhook contribution a durable-push setup must carry. */
function readDurablePushWebhookContribution(
  setup: ConversationProviderSetupResultV1,
): Readonly<{ pluginId: string; localId: string }> {
  const webhookContribution = setup.webhookContributionRef;
  if (webhookContribution === undefined) {
    throw pluginError(
      'channels_connection_webhook_contribution_missing',
      'Durable-push setup did not declare its generic webhook contribution.',
    );
  }
  return webhookContribution;
}

/** Generic webhook endpoints are addressed by an installed materialization. */
function readWebhookTargetMaterialization(origin: PluginMachineExecutionOriginV1): PluginMachineMaterializationRefV1 {
  if ('materializationRef' in origin) return origin.materializationRef;
  throw pluginError(
    'channels_connection_webhook_materialization_unavailable',
    'The webhook endpoint owner requires an installed target materialization.',
  );
}

/**
 * The first durable-push call of a create or transfer journey. It persists
 * nothing and holds no transaction: it returns the journey's final connection
 * identity (preallocated for create, the incumbent identity for transfer)
 * plus the exact generic endpoint-ensure facts, and the present-user UI
 * performs the endpoint effect through the existing host Action.
 */
async function prepareEndpointRequiredConnectionJourney(input: Readonly<{
  connectionId: string;
  setup: ConversationProviderSetupResultV1;
  transportOrigin: PluginMachineExecutionOriginV1;
}>): Promise<ConversationConnectionEndpointRequiredResult> {
  const attempt = mintConversationConnectionWebhookEndpointAttemptIdentity({
    connectionId: input.connectionId,
  });
  return buildConversationConnectionEndpointRequiredResult({
    attempt,
    facts: {
      connectionId: input.connectionId,
      webhookContribution: readDurablePushWebhookContribution(input.setup),
      targetMaterialization: readWebhookTargetMaterialization(input.transportOrigin),
    },
    webhookEndpointSetup: CONVERSATION_CONNECTION_WEBHOOK_ENDPOINT_ENSURE_SETUP_V1,
  });
}

/** Reads the endpoint identity a retained durable-push connection carries. */
async function readExistingDurablePushConnectionEndpoint(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
}>): Promise<Readonly<{ webhookEndpointId: string; webhookSourceInstanceId: string }> | null> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const row = await collection.get(input.connectionId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (row === null) return null;
  const current = readConversationConnectionUpdateRow({ row, connectionId: input.connectionId });
  const transport = own(current.payload, 'transport');
  if (!isJsonRecord(transport) || transport.kind !== 'durablePush') return null;
  const webhookEndpointId = own(transport, 'webhookEndpointId');
  const webhookSourceInstanceId = own(transport, 'webhookSourceInstanceId');
  if (typeof webhookEndpointId !== 'string' || typeof webhookSourceInstanceId !== 'string') {
    throw pluginError(
      'channels_connection_create_corrupt',
      'Retained durable-push connection is missing its endpoint correspondence facts.',
    );
  }
  return { webhookEndpointId, webhookSourceInstanceId };
}

/**
 * Admits a durable-push rejoin only when the incumbent connection retained
 * the exact endpoint and derived source instance from this continuation. This
 * check is required both before the reservation batch and after its conflict
 * path: another creator may install the incumbent between those two points.
 */
async function assertDurablePushConnectionRejoinEndpoint(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  webhookEndpointId: string;
  webhookSourceInstanceId: string;
}>): Promise<void> {
  const retainedEndpoint = await readExistingDurablePushConnectionEndpoint({
    context: input.context,
    connectionId: input.connectionId,
  });
  if (retainedEndpoint === null
    || retainedEndpoint.webhookEndpointId !== input.webhookEndpointId
    || retainedEndpoint.webhookSourceInstanceId !== input.webhookSourceInstanceId) {
    throw pluginError(
      'channels_connection_create_endpoint_mismatch',
      'The retained connection was created with a different webhook endpoint.',
    );
  }
}

/**
 * The durable-push continuation. Setup, credential echo, test, uniqueness,
 * and currentness are re-run exactly as in the first call; the endpoint ID is
 * admitted through its canonical owner parser; and only a current host-derived
 * ready correspondence result admits the incumbent reservation-plus-connection
 * batch. A lost response rejoins the same connection and endpoint; a
 * mismatched attempt or endpoint fails closed without any Channel write.
 */
async function continueDurablePushConnectionCreation(input: Readonly<{
  context: PluginInvocationContext;
  createInput: ConversationConnectionCreateInputV1;
  connectionId: string;
  providerPluginId: string;
  setup: ConversationProviderSetupResultV1;
  transportOrigin: PluginMachineExecutionOriginV1;
  continuation: NonNullable<ConversationConnectionCreateInputV1['endpointContinuation']>;
}>): Promise<PersistedConversationConnection> {
  const continuation = input.continuation;
  const webhookEndpointId = readCanonicalConversationWebhookEndpointId(
    continuation.webhookEndpointId,
  );
  const sourceInstanceId = conversationConnectionWebhookSourceInstanceIdV1(input.connectionId);

  // Correspondence is host-derived only. No UI- or provider-asserted
  // correspondence fact participates; only a current ready result admits a
  // rejoin or the connection batch below.
  await assertConversationConnectionWebhookEndpointCorrespondence({
    context: input.context,
    webhookEndpointId,
    webhookContribution: readDurablePushWebhookContribution(input.setup),
    targetMaterialization: readWebhookTargetMaterialization(input.transportOrigin),
    sourceInstanceId,
  });
  assertNotAborted(input.context.signal);

  // A lost continuation response rejoins the exact committed connection with
  // the exact endpoint it was created with; any other retained endpoint
  // belongs to a different setup attempt and fails closed. The currentness,
  // setup, test, and correspondence checks above deliberately run first.
  const existing = await findExistingConnection({
    context: input.context,
    createInput: input.createInput,
    providerPluginId: input.providerPluginId,
    setup: input.setup,
  });
  if (existing !== null) {
    await assertDurablePushConnectionRejoinEndpoint({
      context: input.context,
      connectionId: existing.rowId,
      webhookEndpointId,
      webhookSourceInstanceId: sourceInstanceId,
    });
    return { kind: 'rejoined', connectionId: existing.rowId, connectionRow: existing };
  }

  const outcome = await createOrRejoinConnection({
    context: input.context,
    createInput: input.createInput,
    providerPluginId: input.providerPluginId,
    setup: input.setup,
    transportOrigin: getConversationConnectionTransportOrigin(input.transportOrigin),
    connectionId: input.connectionId,
    webhookEndpoint: {
      webhookContributionRef: readDurablePushWebhookContribution(input.setup),
      webhookEndpointId,
      webhookSourceInstanceId: sourceInstanceId,
    },
  });
  if (outcome.kind === 'rejoined') {
    // The shared reservation owner may observe an incumbent that won after
    // the pre-check above, either before its batch or through the conflict
    // reread. Re-admit that raced rejoin against the exact continuation facts
    // before returning it as this attempt's outcome.
    await assertDurablePushConnectionRejoinEndpoint({
      context: input.context,
      connectionId: outcome.connectionId,
      webhookEndpointId,
      webhookSourceInstanceId: sourceInstanceId,
    });
  }
  return outcome;
}

/**
 * Admits the endpoint continuation of a transfer converting onto durable
 * push. The retained connection has no endpoint to retarget, so the generic
 * webhook owner must already correspond to the exact replacement
 * materialization before the transfer CAS can use it.
 */
async function admitDurablePushTransferEndpointContinuation(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  setup: ConversationProviderSetupResultV1;
  transportOrigin: PluginMachineExecutionOriginV1;
  continuation: NonNullable<ConversationConnectionTransferInputV1['endpointContinuation']>;
}>): Promise<ConversationConnectionWebhookEndpoint> {
  if (input.continuation.connectionId !== input.connectionId) {
    throw pluginError(
      'channels_connection_transfer_endpoint_mismatch',
      'The endpoint continuation does not belong to this connection transfer.',
    );
  }
  const webhookEndpointId = readCanonicalConversationWebhookEndpointId(
    input.continuation.webhookEndpointId,
  );
  const webhookContribution = readDurablePushWebhookContribution(input.setup);
  await assertConversationConnectionWebhookEndpointCorrespondence({
    context: input.context,
    webhookEndpointId,
    webhookContribution,
    targetMaterialization: readWebhookTargetMaterialization(input.transportOrigin),
    sourceInstanceId: conversationConnectionWebhookSourceInstanceIdV1(input.connectionId),
  });
  assertNotAborted(input.context.signal);
  return {
    webhookContributionRef: webhookContribution,
    webhookEndpointId,
    webhookSourceInstanceId: conversationConnectionWebhookSourceInstanceIdV1(input.connectionId),
  };
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
  oldTransport: 'checkpointedPull' | 'socket' | 'durablePush';
  transferInput: ConversationConnectionTransferInputV1;
  provider: CurrentProvider;
  setup: ConversationProviderSetupResultV1;
}>): boolean {
  return input.oldTransport === 'checkpointedPull'
    && input.transferInput.selectedTransport === 'checkpointedPull'
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
  webhookEndpoint?: ConversationConnectionWebhookEndpoint;
  lifecycle: ConversationConnectionLifecycleStateV1;
  now: number;
}>): ReturnType<typeof withConversationConnectionLifecycle> {
  const {
    pairingDeepLinkTemplate: _oldPairingDeepLinkTemplate,
    outboundTextLimit: _oldOutboundTextLimit,
    // The replacement provider re-authenticates its own shared-endpoint
    // delivery truth. Retaining the predecessor's would leave the surface and
    // the binding writer deciding from a capability nothing proved.
    sharedEndpointInputModes: _oldSharedEndpointInputModes,
    ...payloadWithoutPairingTemplate
  } = input.current.payload;
  const replacementCurrent: ConversationConnectionUpdateRow = {
    ...input.current,
    payload: {
      ...payloadWithoutPairingTemplate,
      providerPluginId: input.providerPluginId,
      providerContributionSelection: {
        contributionId: input.transferInput.providerSelection.contributor.contributionId,
      },
      providerSetupInput: input.transferInput.providerSetupInput,
      credentialRef: input.transferInput.credentialRef,
      transportOrigin: getConversationConnectionTransportOrigin(input.prepared.transportOrigin),
      transport: input.webhookEndpoint === undefined
        ? { kind: input.transferInput.selectedTransport }
        : {
          kind: 'durablePush',
          webhookContributionRef: {
            pluginId: input.webhookEndpoint.webhookContributionRef.pluginId,
            localId: input.webhookEndpoint.webhookContributionRef.localId,
          },
          webhookEndpointId: input.webhookEndpoint.webhookEndpointId,
          webhookSourceInstanceId: input.webhookEndpoint.webhookSourceInstanceId,
        },
      overlapSafety: input.prepared.setup.overlapSafety,
      replayContinuity: input.prepared.setup.replayContinuity,
      ...providerDeclaredConnectionCapabilities(input.prepared.setup),
      ...(input.prepared.setup.sharedEndpointInputModes === undefined
        ? {}
        : { sharedEndpointInputModes: [...input.prepared.setup.sharedEndpointInputModes] }),
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
    },
    providerSetupInput: input.transferInput.providerSetupInput,
    transportOrigin: getConversationConnectionTransportOrigin(input.prepared.transportOrigin),
  };
  return withConversationConnectionLifecycle({
    row: input.row,
    current: replacementCurrent,
    lifecycle: input.lifecycle,
    updatedAt: input.now,
  });
}

/** Converges the endpoint from the connection's current desired placement. */
export async function convergeConversationConnectionEndpointForInvocation(
  input: Readonly<{ connectionId: string }>,
  context: PluginInvocationContext,
): Promise<boolean> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const row = await collection.get(input.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) return false;
  const current = readConversationConnectionUpdateRow({ row, connectionId: input.connectionId });
  if (current.lifecycle.deletionState !== 'none' || readTransferTransportKind(current) !== 'durablePush') return false;
  // A policy refusal belongs to the existing visible recovery fact. Only its
  // owner Retry or a changed connection can re-admit this work.
  if (current.lifecycle.pollFailure?.phase === 'blocked') return true;
  const endpoint = readDurablePushTransferEndpoint({ current, connectionId: input.connectionId });
  try {
    await convergeConversationConnectionWebhookEndpointTarget({
      context,
      transferAuthorityEpoch: current.lifecycle.authorityEpoch,
      webhookEndpointId: readCanonicalConversationWebhookEndpointId(endpoint.webhookEndpointId),
      webhookContribution: endpoint.webhookContributionRef,
      sourceInstanceId: endpoint.webhookSourceInstanceId,
      nextTargetRouting: current.transportOrigin,
    });
  } catch (cause) {
    assertNotAborted(context.signal);
    await recordConversationConnectionReceiveFailureForInvocation({ row, cause }, context);
    throw cause;
  }
  assertNotAborted(context.signal);
  if (current.lifecycle.pollFailure !== null) {
    await persistConversationConnectionLifecycle({
      collection, row, current,
      lifecycle: { ...current.lifecycle, pollFailure: null },
      operation: 'channels_connection_transfer_endpoint_retarget',
    }, context);
  }
  return true;
}

async function convergeCommittedConversationConnectionEndpoint(
  connectionId: string,
  context: PluginInvocationContext,
): Promise<void> {
  try {
    await convergeConversationConnectionEndpointForInvocation({ connectionId }, context);
  } catch (cause) {
    assertNotAborted(context.signal);
    // Desired placement already committed. Its existing receive-recovery
    // fact remains visible, and the supervisor owns the next eligible retry.
    context.services.logger.warn('[Channels] endpoint convergence deferred', {
      connectionId, ...(isPluginError(cause) ? { code: cause.code } : {}),
    });
  }
}

/**
 * Runs the one selected-provider preparation every transfer decision needs and
 * rereads the retained row behind it.
 *
 * Setup and connection test are external effects, so no row observation taken
 * before them survives. The ordinary transfer and the settled-rejoin decision
 * both read the incumbent through this single owner rather than keeping their
 * own pre-effect view of it.
 */
async function prepareTransferProviderAndRereadRetainedRow(input: Readonly<{
  collection: ChannelStateCollection;
  transferInput: ConversationConnectionTransferInputV1;
  basis: ConversationConnectionUpdateRow;
}>, context: PluginInvocationContext): Promise<
  | Readonly<{ kind: 'notReady'; result: ConversationConnectionTransferResult }>
  | Readonly<{
    kind: 'prepared';
    provider: CurrentProvider;
    prepared: Extract<ProviderConnectionPreparation, Readonly<{ kind: 'ready' }>>;
    row: StateRow;
    current: ConversationConnectionUpdateRow;
  }>
> {
  const provider = await readCurrentSelectedProvider({
    context,
    selection: input.transferInput.providerSelection,
  });
  // Provider plugin identity is immutable across a transfer. Reject it before
  // setup so this Action cannot become a covert new-connection path.
  assertTransferProviderPluginIdentity({
    current: input.basis,
    providerPluginId: provider.pluginId,
  });
  const prepared = await runProviderSetupAndTest({
    context,
    setupInput: input.transferInput,
    provider,
    connectionIdForTest: input.transferInput.connectionId,
  });
  if (prepared.kind === 'notReady') return { kind: 'notReady', result: prepared };
  const row = await input.collection.get(input.transferInput.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) {
    throw pluginError(
      'channels_connection_transfer_conflict',
      'Connection transfer lost its retained-row currentness during provider setup.',
      true,
    );
  }
  return {
    kind: 'prepared',
    provider,
    prepared,
    row,
    current: readConversationConnectionUpdateRow({ row, connectionId: input.transferInput.connectionId }),
  };
}

/** Replaces desired placement/credential and advances the one worker generation. */
export async function transferConversationConnectionForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionTransferResult> {
  const transferInput = admittedActionInput<ConversationConnectionTransferInputV1>(input);
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const row = await collection.get(transferInput.connectionId, { signal: context.signal });
  assertNotAborted(context.signal);
  if (row === null) throw pluginError('channels_connection_transfer_not_found', 'Connection transfer target does not exist.');
  const current = readConversationConnectionUpdateRow({ row, connectionId: transferInput.connectionId });
  const startsAtRequestedRevision = current.configurationRevision === transferInput.expectedRevision;
  const preparation = await prepareTransferProviderAndRereadRetainedRow({ collection, transferInput, basis: current }, context);
  if (preparation.kind === 'notReady') return preparation.result;
  const { provider, prepared, row: incumbentRow, current: incumbent } = preparation;
  assertTransferImmutableConnectionIdentity({ current: incumbent, setup: prepared.setup });
  const authorityChangedDuringSetup = incumbent.lifecycle.authorityEpoch !== current.lifecycle.authorityEpoch;
  if (!authorityChangedDuringSetup && isRequestedTransferAlreadyCurrent({ current: incumbent, transferInput })
    && areConversationConnectionTransportOriginsEqual(incumbent.transportOrigin, getConversationConnectionTransportOrigin(prepared.transportOrigin))) {
    if (transferInput.selectedTransport === 'durablePush') await convergeCommittedConversationConnectionEndpoint(transferInput.connectionId, context);
    return { kind: startsAtRequestedRevision ? 'rejoined' : 'transferred', connectionId: transferInput.connectionId,
      revision: incumbent.configurationRevision, authorityEpoch: incumbent.lifecycle.authorityEpoch };
  }
  if (!startsAtRequestedRevision || incumbent.configurationRevision !== transferInput.expectedRevision || authorityChangedDuringSetup) {
    throw pluginError('channels_connection_transfer_conflict', 'Connection transfer requires the current retained row revision.', true);
  }
  const oldTransport = readTransferTransportKind(incumbent);
  if (transferInput.endpointContinuation !== undefined
    && (oldTransport === 'durablePush' || transferInput.selectedTransport !== 'durablePush')) {
    throw pluginError('channels_connection_transfer_endpoint_mismatch', 'Only a transfer from a non-webhook transport onto durable push accepts an endpoint continuation.');
  }
  const unsatisfiable = await readConversationBindingInputModesNoLongerDeliverable({ context,
    connectionId: transferInput.connectionId, sharedEndpointInputModes: prepared.setup.sharedEndpointInputModes });
  assertNotAborted(context.signal);
  if (unsatisfiable.length > 0) return { kind: 'notReady', reason: 'permissionMissing',
    diagnostic: `The replacement integration cannot deliver ${unsatisfiable.join(', ')} for shared conversations, which saved bindings on this connection require.` };
  const now = Date.now();
  const checkpointFence = isCheckpointCompatibleTransfer({ current: incumbent, oldTransport, transferInput,
    provider, setup: prepared.setup }) ? await prepareConversationCheckpointTransferFence({ context,
      connectionId: transferInput.connectionId, routingIdentityKey: incumbent.routingIdentityKey,
      currentAuthorityEpoch: incumbent.lifecycle.authorityEpoch, nextAuthorityEpoch: incumbent.lifecycle.authorityEpoch + 1, now }) : undefined;
  const historyGap = incumbent.lifecycle.historyGap ?? (checkpointFence === undefined
    ? { reportedAt: now, reason: 'providerHistoryUnavailable' as const } : null);
  const lifecycle = assertTransferStartAccepted(startConversationConnectionTransfer({ current: incumbent.lifecycle,
    replacement: { enabled: incumbent.lifecycle.enabled, overlapSafety: prepared.setup.overlapSafety, historyGap } })).connection;
  if (transferInput.selectedTransport === 'durablePush' && oldTransport !== 'durablePush' && transferInput.endpointContinuation === undefined) {
    return await prepareEndpointRequiredConnectionJourney({ connectionId: transferInput.connectionId,
      setup: prepared.setup, transportOrigin: prepared.transportOrigin });
  }
  let webhookEndpoint: ConversationConnectionWebhookEndpoint | undefined;
  if (transferInput.selectedTransport === 'durablePush') {
    webhookEndpoint = oldTransport === 'durablePush'
      ? readDurablePushTransferEndpoint({ current: incumbent, connectionId: transferInput.connectionId })
      : await admitDurablePushTransferEndpointContinuation({ context, connectionId: transferInput.connectionId,
        setup: prepared.setup, transportOrigin: prepared.transportOrigin, continuation: transferInput.endpointContinuation! });
  }
  const providerForPersistence = await readCurrentSelectedProvider({ context, selection: transferInput.providerSelection });
  if (providerForPersistence.pluginId !== provider.pluginId) {
    throw pluginError('channels_connection_transfer_provider_currentness_changed', 'The selected provider changed before connection transfer persistence.', true);
  }
  assertTransferProviderPluginIdentity({ current: incumbent, providerPluginId: providerForPersistence.pluginId });
  const value = transferConnectionValue({ row: incumbentRow, current: incumbent, transferInput,
    providerPluginId: providerForPersistence.pluginId, prepared, webhookEndpoint, lifecycle, now });
  const mutations: ChannelStateBatchMutation[] = [{ kind: 'put', value, expectedRevision: incumbentRow.revision }];
  if (checkpointFence !== undefined) mutations.push({ kind: 'put', value: checkpointFence.value,
    expectedRevision: checkpointFence.expectedRevision });
  const result = await collection.batch(mutations, { signal: context.signal });
  assertNotAborted(context.signal);
  if (result.status === 'conflict') throw pluginError('channels_connection_transfer_conflict', 'Connection transfer lost its retained-row compare-and-swap.', true);
  if (!result.results.some(entry => entry.rowId === transferInput.connectionId && entry.deleted === false)) {
    throw pluginError('channels_connection_transfer_result_invalid', 'Connection transfer did not return its retained connection result.', true);
  }
  if (transferInput.selectedTransport === 'durablePush') await convergeCommittedConversationConnectionEndpoint(transferInput.connectionId, context);
  return { kind: 'transferred', connectionId: transferInput.connectionId,
    revision: value.payload.configurationRevision, authorityEpoch: lifecycle.authorityEpoch };
}

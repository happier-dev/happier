import * as React from 'react';
import { useConversationProviderDisplayName, useConversationProviderDisplayNameResolver } from './providerDisplayName.js';
import { useSessionCandidatePages, type SessionCandidate as BindingCreateSessionCandidate } from './useSessionCandidatePages.js';
import { pluginUiTargetedContributionOperationKey } from '@happier-dev/plugin-sdk/ui';
import type { AgentPermissionIntentV1 } from '@happier-dev/plugin-sdk/sessions';
import type {
  PluginActionInputById,
  PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';
import { readActionInputOptionValue } from '@happier-dev/plugin-sdk/actions';
import type {
  PluginUiActionExecutionOptions,
  SurfaceContext,
  RenderContext,
  ResourceContent,
  SelectActionInputRequest,
  SelectActionInputResult,
} from '@happier-dev/plugin-sdk/ui';
import {
  Action,
  Banner,
  Badge,
  BrandMark,
  Button,
  EmptyState,
  ErrorState,
  Form,
  FreshnessLine,
  Heading,
  Icon,
  IconButton,
  CountedDisclosureItem,
  Item,
  ItemGroup,
  CodeBlock,
  Link,
  List,
  LoadingState,
  Menu,
  Metadata,
  PaneHeaderContent,
  PageHeader,
  QRCode,
  Row,
  Screen,
  ScrollArea,
  Stack,
  Status,
  Step,
  type ListSectionData,
  Text,
  Tabs,
  defineUiSurface,
  type PluginActionExecution,
  type PluginUiFocusTarget,
  useExecutePluginAction,
  useLivePluginResource,
  usePluginBrandDisplayNameResolver,
  usePluginHostApi,
  usePluginTheme,
  usePluginTranslation,
  usePluginUiFocusTarget,
  useSessionState,
  useSessionStates,
  useSurfaceContext,
  useWidgetPresentation,
  type PluginUiResourceSnapshot,
  type SessionStateReadV1,
  SetupSteps,
} from '@happier-dev/plugin-ui';
import {
  usePluginUiDataClient,
  type PluginUiAccountCollectionForDefinition,
} from '@happier-dev/plugin-ui';
import {
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  CONVERSATION_CONNECTION_SELECTABLE_TRANSPORTS_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1,
  ConversationBindingCreateInputV1Schema,
  ConversationBindingCreateResultV1Schema,
  ConversationBindingMutationResultV1Schema,
  ConversationBindingReadResultV1Schema,
  ConversationBindingResolveInputV1Schema,
  ConversationBindingResolveResultV1Schema,
  ConversationBindingTargetV1Schema,
  ConversationBindingUpdateInputV1Schema,
  ConversationConnectionCreateResultV1Schema,
  isConversationConnectionSelectableTransportV1,
  ConversationConnectionPrepareResultV1Schema,
  ConversationConnectionRetestResultV1Schema,
  ConversationProviderSetupRemediationResultV1Schema,
  ConversationConnectionTransferInputV1Schema,
  ConversationConnectionTransferResultV1Schema,
  ConversationPairingCancelInputV1Schema,
  ConversationPairingCancelResultV1Schema,
  ConversationPairingCreateInputV1Schema,
  ConversationPairingCreateResultV1Schema,
  ConversationPairingFinalizeInputV1Schema,
  ConversationPairingFinalizeResultV1Schema,
  ConversationPairingResourceV1Schema,
  conversationBindingInputModesForEndpointV1,
  conversationBindingPolicyForOmittedFieldsV1,
  conversationSessionBindingDeliveryModeForOmittedFieldV1,
  CONVERSATION_CORE_PLUGIN_ID_V1,
  MAX_CONVERSATION_OBSERVATION_AGE_MS,
  DEFAULT_CONVERSATION_OBSERVATION_AGE_MS,
  MIN_CONVERSATION_OBSERVATION_AGE_MS,
  type ConversationBindingTargetV1,
  type ConversationBindingV1,
  type ConversationProviderFailureV1,
  type ConversationThreadRouterBindingTargetV1,
  type ConversationBindingReadResultV1,
  type ConversationConnectionCreateInputV1,
  type ConversationConnectionPrepareResultV1,
  type ConversationConnectionEndpointRequiredResultV1,
  type ConversationConnectionWebhookEndpointSetupRequiredResultV1,
  type ConversationPairingResourceV1,
  type ConversationResolvedEndpointV1,
  ConversationSessionLastDeliveryV1Schema,
  type ConversationSessionLastDeliveryV1,
  type ConversationSessionLastDeliveryOutcomeV1,
  ConversationDeliveryReadResultV1Schema,
  ConversationStartResultV1Schema,
} from '@happier-dev/channels-protocol/v1';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
} from '../collections.js';
import {
  readConversationBindingManagementRows,
  readConversationBindingPolicyFromAccountCollection,
  readConversationConnectionManagementRows,
  readConversationIngressAttentionPage,
  setConversationBindingEnabledInAccountCollection,
  updateConversationBindingPolicyInAccountCollection,
  updateConversationConnectionInAccountCollection,
  type ConversationBindingEnablementResult,
  type ConversationBindingManagementRow,
  type ConversationBindingPolicyReadResult,
  type ConversationConnectionManagementRow,
  type ConversationConnectionLifecycleMutationResult,
  type ConversationIngressAttentionRow,
} from '../accountLocalBindingPolicy.js';
import {
  readConversationConnectionPollFailureAttention,
  type ConversationConnectionPollFailureAttentionV1,
} from '../connectionPollFailure.js';
import {
  readConversationOutwardDeliveryConnectionAttention,
  readConversationOutwardDeliveryResolutionPage,
  resolveConversationOutwardDeliveryCustodyInAccountCollection,
  type ConversationDeliveryResolutionDecision,
  type ConversationOutwardDeliveryResolutionRow,
} from '../outwardDelivery.js';
import {
  CHANNELS_PAGE_VIEW_ID,
  CHANNELS_SESSION_CONVERSATIONS_RESOURCE_ID,
  CHANNELS_SESSION_CONVERSATIONS_VIEW_ID,
  CHANNELS_SETTINGS_PAGE_ID,
} from '../sessionSurfaceIds.js';
import {
  isConversationSessionBindingAttentionReason,
  type ConversationSessionBindingAttentionReasonV1,
  type ConversationSessionBindingAttentionV1,
} from '../sessionBindingAttention.js';
import {
  type BindingDeliveryMode,
  type BindingEndpointAudience,
  type BindingInputMode,
  type BindingSessionDeliveryMode,
  type BindingTargetKind,
  CHANNELS_BINDINGS_RESOURCE,
  CHANNELS_CONNECTIONS_RESOURCE,
  type ChannelDeliveriesCollection,
  type ChannelStateCollection,
  type ChannelsBinding,
  type ChannelsConnection,
  type ConnectionHistoryGapReason,
  type ConnectionProviderReadiness,
  type ConnectionTransport,
  type ParsedBindings,
  type ParsedConnections,
  type ResourcePresentation,
  type Translate,
  bindingEndpointLabel,
  bindingRowLabel,
  connectionLabel,
  channelsStatusNeedsYou,
  connectionStatus,
  isBindingInputMode,
  isHostMethodCurrentlyUnavailable,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isRecord,
  isValidObservationAge,
  parseBindingsResource,
  parseBindingsValue,
  parseConnectionsResource,
  providerReadinessLabel,
  shortRowIdentity,
  useAccountLocalBindingRows,
  useAccountLocalConnectionRows,
  useReplacedAccountCollectionScope,
  buildChannelsConversationIndex,
  channelsConversationActivity,
  formatConversationTime,
  useConversationSessionStates,
  readChannelsPageLocation,
  resolveChannelsConversationReadState,
  type ChannelsConversationActivity,
  type ChannelsConversationIndexRow,
} from './conversationRows.js';
import { selectChannelsRouterThreadSessionState, type ChannelsRouterThreadSessionState } from './conversationSessionState.js';
import {
  bindingPermissionIntentLabel,
  bindingPermissionIntentOptions,
  parseBindingPermissionIntent,
} from './permissionIntentOptions.js';


const CHANNELS_PAIRING_RESOURCE = {
  pluginId: CONVERSATION_CORE_PLUGIN_ID_V1,
  localId: 'pairing-v1',
} as const;

const CHANNELS_SESSION_CONVERSATIONS_RESOURCE = {
  pluginId: CONVERSATION_CORE_PLUGIN_ID_V1,
  localId: CHANNELS_SESSION_CONVERSATIONS_RESOURCE_ID,
} as const;

const MILLISECONDS_PER_SECOND = 1_000;
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND;
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;
const OBSERVATION_AGE_PRESETS_MS = Object.freeze([
  MILLISECONDS_PER_MINUTE,
  5 * MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_DAY,
  7 * MILLISECONDS_PER_DAY,
  30 * MILLISECONDS_PER_DAY,
]);
const INBOUND_GROUPING_PRESETS_MS = Object.freeze([0, 250, 500, 750, 1_000, 2_000, 5_000]);


/** One decoded Session-conversation Resource, consumed by both visible rows and attention. */
type ParsedSessionConversations = Readonly<{
  bindings: ParsedBindings;
  attention: readonly ConversationSessionBindingAttentionV1[];
  /** The newest outward delivery custody row per binding (optional sibling; absent from older daemons). */
  lastDeliveries: ReadonlyMap<string, ConversationSessionLastDeliveryV1>;
}>;

const NO_LAST_DELIVERIES: ReadonlyMap<string, ConversationSessionLastDeliveryV1> = new Map();

/** Each entry is validated on its own and a malformed one is omitted, as attention entries are. */
function parseSessionLastDeliveries(decoded: unknown): ReadonlyMap<string, ConversationSessionLastDeliveryV1> {
  if (!isRecord(decoded) || !Array.isArray(decoded.lastDeliveries)) return NO_LAST_DELIVERIES;
  const entries = new Map<string, ConversationSessionLastDeliveryV1>();
  for (const candidate of decoded.lastDeliveries) {
    const parsed = ConversationSessionLastDeliveryV1Schema.safeParse(candidate);
    if (parsed.success) entries.set(parsed.data.bindingId, parsed.data);
  }
  return entries;
}

type ParsedPairing =
  | Readonly<{ kind: 'ready'; pairing: ConversationPairingResourceV1 }>
  | Readonly<{ kind: 'invalid'; reason: 'contentType' | 'invalidJson' | 'shape' }>;


type ProviderTargetedOperation = Extract<SelectActionInputRequest, Readonly<{ operation: unknown }>>['operation'];
type ProviderSetupOperation = ProviderTargetedOperation;
type ProviderSetupRemediationOperation = ProviderTargetedOperation;
type SubmittedProviderSetupSelection = Extract<SelectActionInputResult, Readonly<{ kind: 'submitted' }>>;
type SubmittedProviderSetupRemediationSelection = SubmittedProviderSetupSelection;
type SelectedProviderSetupActionInput = NonNullable<PluginUiActionExecutionOptions['selectedActionInput']>;
type SelectedProviderSetupRemediationActionInput = Readonly<{
  operation: ProviderSetupRemediationOperation;
  result: SubmittedProviderSetupRemediationSelection;
}>;
type ConnectionCreateTransport = ConversationConnectionCreateInputV1['selectedTransport'];
type PreparedConnectionSetup = Readonly<{
  operationKey: string;
  providerSelection: SubmittedProviderSetupSelection['selection'];
  providerSetupInput: SubmittedProviderSetupSelection['input'];
  credentialRef: Extract<
    SubmittedProviderSetupSelection['connectedAccount'],
    Readonly<{ kind: 'selected' }>
  >['ref'] | null;
  supportedTransports: readonly ConnectionCreateTransport[];
  selectedTransport: ConnectionCreateTransport;
  maximumObservationAgeMs: string;
  presentation: PreparedConnectionPresentation;
  setupGuidance?: PreparedConnectionReady['setupGuidance'];
}>;
type PreparedConnectionReady = Extract<ConversationConnectionPrepareResultV1, Readonly<{ kind: 'ready' }>>;
type PreparedConnectionPresentation = Readonly<{
  providerDisplayName: string;
  connectedAccountLabel: string | null;
  machineDisplayName: string | null;
  destinationLabel?: string;
  overlapSafety: PreparedConnectionReady['overlapSafety'];
  replayContinuity: PreparedConnectionReady['replayContinuity'];
  outboundTextLimit: PreparedConnectionReady['outboundTextLimit'];
}>;
type ProviderSetupFormDraft = Readonly<{
  operationKey: string;
  input: SubmittedProviderSetupSelection['input'];
}>;
/**
 * The durable-push continuation the mounted surface relays between the two
 * `connection/create-v1` calls. Every field is core-minted; the surface only
 * passes the generic ensure facts to the existing host Action and echoes the
 * returned endpoint ID and attempt identity back to the core, which re-proves
 * correspondence itself.
 */
type ConnectionEndpointContinuation = Readonly<{
  connectionId: string;
  webhookEndpointId?: string;
  endpointEnsureInput: PluginActionInputById['plugin.webhook.endpoint.ensure'];
}>;
type EndpointSetupPresentation = ConversationConnectionWebhookEndpointSetupRequiredResultV1;
type ProviderSetupFeedback =
  | 'ready'
  | 'requiresRemediation'
  | 'remediationUnavailable'
  | 'remediationFailed'
  | 'remediationOutcomeUnknown'
  | 'selectionUnavailable'
  | 'preparationUnavailable'
  | 'preparationOutcomeUnknown'
  | 'creationUnavailable'
  | 'creationFailed'
  | 'creationOutcomeUnknown'
  | 'endpointEnsureOutcomeUnknown'
  | 'endpointEnsureFailed'
  | 'endpointSetupRequired';

/**
 * The mounted host snapshot is the only provider-discovery owner. In
 * particular, provider-local Action ids are deliberately opaque here: the
 * exact admitted operation is passed straight back to the host input selector.
 */
function isSameProviderContributionOperation(
  left: ProviderTargetedOperation,
  right: ProviderTargetedOperation,
): boolean {
  return left.point.pointId === right.point.pointId
    && left.point.protocol.id === right.point.protocol.id
    && left.point.protocol.version === right.point.protocol.version
    && left.contributor.pluginId === right.contributor.pluginId
    && left.contributor.contributionId === right.contributor.contributionId
    && left.contributor.occurrenceId === right.contributor.occurrenceId;
}

function currentProviderOperationsForRole(
  targetedContributions: SurfaceContext['targetedContributions'],
  targetPluginId: string,
  role: 'setup' | 'setupRemediation',
  providerPluginId?: string,
  selectedContribution?: ProviderTargetedOperation,
): readonly ProviderTargetedOperation[] {
  if (targetedContributions === undefined || targetedContributions.target.pluginId !== targetPluginId) return [];
  const point = targetedContributions.points.find(
    (candidate) => candidate.pointId === CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
  );
  const protocol = point?.protocols.find((candidate) => (
    candidate.protocol.id === CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1
    && candidate.protocol.version === CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1
  ));
  if (protocol === undefined) return [];
  return protocol.contributions.flatMap((contribution) => {
    if (providerPluginId !== undefined && contribution.contributor.pluginId !== providerPluginId) return [];
    return contribution.operations.filter((operation) => (
      operation.contributor.pluginId === contribution.contributor.pluginId
      && operation.contributor.contributionId === contribution.contributor.contributionId
      && operation.contributor.occurrenceId === contribution.contributor.occurrenceId
      && operation.role === role
      && operation.point.pointId === CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1
      && operation.point.protocol.id === CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1
      && operation.point.protocol.version === CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1
      && (selectedContribution === undefined
        || isSameProviderContributionOperation(operation, selectedContribution))
    ));
  });
}

function currentProviderSetupOperations(
  targetedContributions: SurfaceContext['targetedContributions'],
  targetPluginId: string,
  providerPluginId?: string,
): readonly ProviderSetupOperation[] {
  return currentProviderOperationsForRole(
    targetedContributions,
    targetPluginId,
    'setup',
    providerPluginId,
  );
}

function currentProviderSetupRemediationOperations(
  targetedContributions: SurfaceContext['targetedContributions'],
  targetPluginId: string,
  selectedSetupOperation: ProviderSetupOperation,
): readonly ProviderSetupRemediationOperation[] {
  return currentProviderOperationsForRole(
    targetedContributions,
    targetPluginId,
    'setupRemediation',
    undefined,
    selectedSetupOperation,
  );
}

type BindingEnablementInput = Readonly<{
  bindingId: string;
  expectedRevision: number;
  enabled: boolean;
}>;
type BindingEnablementOperation = Readonly<{
  execution: PluginActionExecution;
  execute(input: BindingEnablementInput): Promise<PluginActionExecution>;
  reset(): void;
}>;
type BindingPolicyInput = Readonly<{
  bindingId: string;
  expectedRevision: number;
  /** Session only: the one target arm an unreachable machine can still decide. */
  target?: ConversationBindingTargetV1;
  /** Senders withdrawn from the retained audience; admitting one stays online-only. */
  revokedPrincipalIds?: readonly string[];
  allowBotSenders: boolean;
  inputMode: BindingInputMode;
  inboundDebounceMs: number;
  linkPreviewPolicy: 'suppress' | 'providerDefault';
  senderFeedback: 'off' | 'eligibleRefusals';
  enabled: boolean;
}>;
type BindingPolicyOperation = Readonly<{
  execution: PluginActionExecution;
  execute(input: BindingPolicyInput): Promise<PluginActionExecution>;
  reset(): void;
}>;
type BindingEnablementFailure = Readonly<{
  bindingId: string;
  code: string;
}>;
type BindingDeleteInput = Readonly<{
  bindingId: string;
  expectedRevision: number;
}>;
type BindingDeleteOperation = Readonly<{
  execution: PluginActionExecution;
  execute(input: BindingDeleteInput): Promise<PluginActionExecution>;
  reset(): void;
}>;
type ConnectionPolicyInput = Readonly<{
  connectionId: string;
  expectedRevision: number;
  enabled: boolean;
  maximumObservationAgeMs: number;
}>;
type ConnectionPolicyOperation = Readonly<{
  execution: PluginActionExecution;
  execute(input: ConnectionPolicyInput): Promise<PluginActionExecution>;
  reset(): void;
}>;
type DeliveryResolveInput = Readonly<{
  custodyId: string;
  expectedRevision: number;
  resolution: ConversationDeliveryResolutionDecision;
}>;
type DeliveryResolveOperation = Readonly<{
  execution: PluginActionExecution;
  execute(input: DeliveryResolveInput): Promise<PluginActionExecution>;
  reset(): void;
}>;
type DeliveryResolutionReadState = Readonly<{
  rows?: readonly ConversationOutwardDeliveryResolutionRow[];
  nextCursor?: string;
  resource: ResourcePresentation;
}>;
type IngressAttentionReadState = Readonly<{
  rows?: readonly ConversationIngressAttentionRow[];
  nextCursor?: string;
  resource: ResourcePresentation;
}>;

function ingressAttentionRowId(row: ConversationIngressAttentionRow): string {
  return row.obligationId;
}

function ingressTerminalAttentionLabel(
  row: Extract<ConversationIngressAttentionRow, { kind: 'terminal' }>,
  t: Translate,
): string {
  switch (row.reason) {
    case 'actorUnattributable':
      return t('plugins.channels.surface.ingressDropUnverifiedSender', 'Dropped because the sender could not be verified.');
    case 'actorNotAllowed':
      return t('plugins.channels.surface.ingressDropSenderNotAllowed', 'Dropped because the sender is not allowed.');
    case 'botSenderDisabled':
      return t('plugins.channels.surface.ingressDropAutomatedSender', 'Dropped because automated senders are not allowed.');
    default:
      return t(
        row.category === 'recoverable'
          ? 'plugins.channels.surface.ingressAttentionTerminalRecoverable'
          : 'plugins.channels.surface.ingressAttentionTerminal',
        row.category === 'recoverable'
          ? 'An incoming message is waiting for its connection or target to be reachable again.'
          : 'An incoming message was not accepted.',
      );
  }
}

const DELIVERY_RESOLUTION_INITIAL_STATE: DeliveryResolutionReadState = Object.freeze({
  resource: Object.freeze({
    pending: 'initial',
    freshness: 'unknown',
    subscription: 'unsupported',
  }),
});

const INGRESS_ATTENTION_INITIAL_STATE: IngressAttentionReadState = Object.freeze({
  resource: Object.freeze({
    pending: 'initial',
    freshness: 'unknown',
    subscription: 'unsupported',
  }),
});


function parseSessionConversationAttention(
  decoded: unknown,
): readonly ConversationSessionBindingAttentionV1[] {
  if (!isRecord(decoded) || !Array.isArray(decoded.attention)) return [];
  const entries: ConversationSessionBindingAttentionV1[] = [];
  for (const candidate of decoded.attention) {
    if (!isRecord(candidate)) continue;
    const bindingId = candidate.bindingId;
    const reason = candidate.reason;
    if (!isNonEmptyString(bindingId) || !isConversationSessionBindingAttentionReason(reason)) continue;
    if (reason === 'transcriptHistoryGap') {
      if (!Number.isSafeInteger(candidate.bindingRevision)
        || typeof candidate.bindingRevision !== 'number'
        || candidate.bindingRevision < 1
        || !Number.isSafeInteger(candidate.frontierRevision)
        || typeof candidate.frontierRevision !== 'number'
        || candidate.frontierRevision < 1) continue;
      entries.push({
        bindingId,
        reason,
        bindingRevision: candidate.bindingRevision,
        frontierRevision: candidate.frontierRevision,
      });
      continue;
    }
    entries.push({ bindingId, reason });
  }
  return entries;
}

/**
 * The one Session-conversation boundary parse.
 *
 * Rows and attention are two consumers of the same Resource snapshot, so they
 * must share its one UTF-8 decode and JSON parse. Their validation remains
 * independently fail-closed: malformed attention is omitted exactly as before,
 * while malformed bindings still refuse the whole visible list.
 */
function parseSessionConversationsResource(resource: ResourceContent): ParsedSessionConversations {
  if (resource.contentType !== 'application/json') {
    return { bindings: { kind: 'invalid', reason: 'contentType' }, attention: [], lastDeliveries: NO_LAST_DELIVERIES };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(resource.bytes));
  } catch {
    return { bindings: { kind: 'invalid', reason: 'invalidJson' }, attention: [], lastDeliveries: NO_LAST_DELIVERIES };
  }
  return {
    bindings: parseBindingsValue(decoded),
    attention: parseSessionConversationAttention(decoded),
    lastDeliveries: parseSessionLastDeliveries(decoded),
  };
}

/** The strict protocol schema is the sole parser for the pairing owner projection. */
function parsePairingResource(resource: ResourceContent): ParsedPairing {
  if (resource.contentType !== 'application/json') {
    return { kind: 'invalid', reason: 'contentType' };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(resource.bytes));
  } catch {
    return { kind: 'invalid', reason: 'invalidJson' };
  }
  const parsed = ConversationPairingResourceV1Schema.safeParse(decoded);
  return parsed.success
    ? { kind: 'ready', pairing: parsed.data }
    : { kind: 'invalid', reason: 'shape' };
}

type DeliveryResolutionPageRequest = Readonly<{
  cursor?: string;
  append: boolean;
  sequence: number;
}>;
type IngressAttentionPageRequest = Readonly<{
  cursor?: string;
  append: boolean;
  sequence: number;
}>;

/**
 * Mounted UI keeps only the current presentation of the canonical direct
 * Account page reader. It does not own a delivery cache, summary, or writer.
 */
function useDeliveryResolutionRows(input: Readonly<{
  collection: ChannelDeliveriesCollection;
  connectionId: string;
  signal: AbortSignal;
}>): Readonly<DeliveryResolutionReadState & {
  refresh: () => void;
  loadMore: () => void;
}> {
  const [request, setRequest] = React.useState<DeliveryResolutionPageRequest>({
    append: false,
    sequence: 0,
  });
  const [state, setState] = React.useState<DeliveryResolutionReadState>(
    DELIVERY_RESOLUTION_INITIAL_STATE,
  );
  if (useReplacedAccountCollectionScope([input.collection])) {
    // The retained cursor addresses the replaced Collection, so the successor
    // is read from its first page rather than continued mid-scan.
    setRequest({ append: false, sequence: 0 });
    setState(DELIVERY_RESOLUTION_INITIAL_STATE);
  }

  React.useEffect(() => {
    let retired = false;
    setState((previous) => {
      const hasLastKnownGood = previous.rows !== undefined;
      return {
        ...(hasLastKnownGood ? { rows: previous.rows } : {}),
        ...(hasLastKnownGood && previous.nextCursor !== undefined
          ? { nextCursor: previous.nextCursor }
          : {}),
        resource: {
          pending: hasLastKnownGood ? 'refresh' : 'initial',
          freshness: hasLastKnownGood ? 'stale' : 'unknown',
          subscription: 'unsupported',
        },
      };
    });

    void readConversationOutwardDeliveryResolutionPage({
      deliveriesCollection: input.collection,
      connectionId: input.connectionId,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      limit: 50,
      signal: input.signal,
    }).then(
      (page) => {
        if (retired || input.signal.aborted) return;
        setState((previous) => {
          const existing = request.append ? previous.rows ?? [] : [];
          const existingCustodyIds = new Set(existing.map((row) => row.custodyId));
          const rows = request.append
            ? [...existing, ...page.rows.filter((row) => !existingCustodyIds.has(row.custodyId))]
            : page.rows;
          return {
            rows,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            resource: {
              pending: 'idle',
              freshness: 'fresh',
              subscription: 'unsupported',
            },
          };
        });
      },
      () => {
        if (retired || input.signal.aborted) return;
        setState((previous) => {
          const hasLastKnownGood = previous.rows !== undefined;
          return {
            ...(hasLastKnownGood ? { rows: previous.rows } : {}),
            ...(hasLastKnownGood && previous.nextCursor !== undefined
              ? { nextCursor: previous.nextCursor }
              : {}),
            resource: {
              pending: 'idle',
              freshness: hasLastKnownGood ? 'stale' : 'unknown',
              subscription: 'unsupported',
              // Data can contain transport diagnostics. This UI owns only a
              // stable recovery state, not those diagnostic details.
              error: { message: 'Delivery resolution details could not be read.' },
            },
          };
        });
      },
    );

    return () => {
      retired = true;
    };
  }, [input.collection, input.connectionId, input.signal, request]);

  const refresh = React.useCallback(() => {
    setRequest((current) => ({
      append: false,
      sequence: current.sequence + 1,
    }));
  }, []);
  const loadMore = React.useCallback(() => {
    if (state.resource.pending !== 'idle' || state.nextCursor === undefined) return;
    setRequest((current) => ({
      append: true,
      cursor: state.nextCursor,
      sequence: current.sequence + 1,
    }));
  }, [state.nextCursor, state.resource.pending]);
  return React.useMemo(() => ({ ...state, refresh, loadMore }), [loadMore, refresh, state]);
}

/**
 * This presentation state is deliberately only a view of the canonical
 * `channelState.byAttention` page. It neither scans per connection nor becomes
 * an ingress lifecycle owner, cache, or writer.
 */
function useIngressAttentionRows(input: Readonly<{
  collection: ChannelStateCollection;
  signal: AbortSignal;
}>): Readonly<IngressAttentionReadState & {
  refresh: () => void;
  loadMore: () => void;
}> {
  const [request, setRequest] = React.useState<IngressAttentionPageRequest>({
    append: false,
    sequence: 0,
  });
  const [state, setState] = React.useState<IngressAttentionReadState>(
    INGRESS_ATTENTION_INITIAL_STATE,
  );
  if (useReplacedAccountCollectionScope([input.collection])) {
    // The retained cursor addresses the replaced Collection, so the successor
    // is read from its first page rather than continued mid-scan.
    setRequest({ append: false, sequence: 0 });
    setState(INGRESS_ATTENTION_INITIAL_STATE);
  }

  React.useEffect(() => {
    let retired = false;
    setState((previous) => {
      const hasLastKnownGood = previous.rows !== undefined;
      return {
        ...(hasLastKnownGood ? { rows: previous.rows } : {}),
        ...(hasLastKnownGood && previous.nextCursor !== undefined
          ? { nextCursor: previous.nextCursor }
          : {}),
        resource: {
          pending: hasLastKnownGood ? 'refresh' : 'initial',
          freshness: hasLastKnownGood ? 'stale' : 'unknown',
          subscription: 'unsupported',
        },
      };
    });

    void readConversationIngressAttentionPage({
      collection: input.collection,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      limit: 50,
      signal: input.signal,
    }).then(
      (page) => {
        if (retired || input.signal.aborted) return;
        setState((previous) => {
          const existing = request.append ? previous.rows ?? [] : [];
          const existingRowIds = new Set(existing.map(ingressAttentionRowId));
          const rows = request.append
            ? [...existing, ...page.obligations.filter((row) => !existingRowIds.has(ingressAttentionRowId(row)))]
            : page.obligations;
          return {
            rows,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            resource: {
              pending: 'idle',
              freshness: 'fresh',
              subscription: 'unsupported',
            },
          };
        });
      },
      () => {
        if (retired || input.signal.aborted) return;
        setState((previous) => {
          const hasLastKnownGood = previous.rows !== undefined;
          return {
            ...(hasLastKnownGood ? { rows: previous.rows } : {}),
            ...(hasLastKnownGood && previous.nextCursor !== undefined
              ? { nextCursor: previous.nextCursor }
              : {}),
            resource: {
              pending: 'idle',
              freshness: hasLastKnownGood ? 'stale' : 'unknown',
              subscription: 'unsupported',
              error: { message: 'Ingress attention details could not be read.' },
            },
          };
        });
      },
    );

    return () => {
      retired = true;
    };
  }, [input.collection, input.signal, request]);

  const refresh = React.useCallback(() => {
    setRequest((current) => ({
      append: false,
      sequence: current.sequence + 1,
    }));
  }, []);
  const loadMore = React.useCallback(() => {
    if (state.resource.pending !== 'idle' || state.nextCursor === undefined) return;
    setRequest((current) => ({
      append: true,
      cursor: state.nextCursor,
      sequence: current.sequence + 1,
    }));
  }, [state.nextCursor, state.resource.pending]);
  return React.useMemo(() => ({ ...state, refresh, loadMore }), [loadMore, refresh, state]);
}

function directBindingWriteFailure(error: unknown): PluginActionExecution {
  const candidate = error !== null && typeof error === 'object'
    ? error as Readonly<{ code?: unknown; retryable?: unknown }>
    : undefined;
  const code = typeof candidate?.code === 'string'
    ? candidate.code
    : 'plugin_collection_mutation_failed';
  // A direct Data request can be cancelled after it has crossed the mutation
  // boundary. Treat that ambiguity exactly like the host Action helper: the
  // user must reread before another binding write is admitted.
  if (code === 'timeout'
    || code === 'aborted'
    || code === 'plugin_collection_cancelled'
    || code === 'channels_binding_set_enabled_cancelled') {
    return {
      status: 'outcomeUnknown',
      code,
      message: 'The binding change may have reached the Account.',
    };
  }
  return {
    status: 'error',
    code,
    message: 'The binding change did not complete.',
    retryable: candidate?.retryable === true,
  };
}

type AccountLocalMutationOperation<TInput> = Readonly<{
  execution: PluginActionExecution;
  execute(write: TInput): Promise<PluginActionExecution>;
  reset(): void;
}>;

/**
 * The one direct-Data mutation lifecycle in this surface. It is the offline
 * counterpart of the canonical Action lifecycle, not a second Channel writer:
 * every caller supplies a shared transition/parser/CAS owner as `commit`, and
 * the list deliberately waits for the direct Account reread before it changes.
 */
function useAccountLocalMutation<TInput, TResult extends Readonly<{ kind: string }>>(
  input: Readonly<{
    signal: AbortSignal;
    onCommitted: () => void;
    commit: (write: TInput, signal: AbortSignal) => Promise<TResult | null>;
    describeFailure: (error: unknown) => PluginActionExecution;
  }>,
): AccountLocalMutationOperation<TInput> {
  const [execution, setExecution] = React.useState<PluginActionExecution>({ status: 'idle' });
  const pendingRef = React.useRef(false);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const execute = React.useCallback(async (write: TInput): Promise<PluginActionExecution> => {
    if (pendingRef.current) return { status: 'pending' };
    pendingRef.current = true;
    setExecution({ status: 'pending' });
    let settled: PluginActionExecution;
    try {
      const result = await input.commit(write, input.signal);
      settled = result === null ? { status: 'idle' } : { status: 'success', result };
      if (result !== null && result.kind !== 'unchanged' && !input.signal.aborted) input.onCommitted();
    } catch (error) {
      settled = input.describeFailure(error);
    }
    pendingRef.current = false;
    if (mountedRef.current && !input.signal.aborted) setExecution(settled);
    return settled;
  }, [input.commit, input.describeFailure, input.onCommitted, input.signal]);

  const reset = React.useCallback(() => {
    if (!pendingRef.current) setExecution({ status: 'idle' });
  }, []);

  return React.useMemo(() => ({ execution, execute, reset }), [execute, execution, reset]);
}

function useAccountLocalBindingEnablement(input: Readonly<{
  collection: ChannelStateCollection;
  signal: AbortSignal;
  onCommitted: () => void;
}>): BindingEnablementOperation {
  const { collection } = input;
  const commit = React.useCallback(async (
    write: BindingEnablementInput,
    signal: AbortSignal,
  ): Promise<ConversationBindingEnablementResult> => (
    await setConversationBindingEnabledInAccountCollection({ collection, ...write, signal })
  ), [collection]);
  return useAccountLocalMutation({
    signal: input.signal,
    onCommitted: input.onCommitted,
    commit,
    describeFailure: directBindingWriteFailure,
  });
}

/**
 * The Account-decidable binding-policy counterpart of the online update Action.
 * It deliberately carries no endpoint, principal, or target field: those need
 * current provider or Automation authority and stay unavailable offline.
 */
function useAccountLocalBindingPolicy(input: Readonly<{
  collection: ChannelStateCollection;
  signal: AbortSignal;
  onCommitted: () => void;
}>): BindingPolicyOperation {
  const { collection } = input;
  const host = usePluginHostApi();
  const t = usePluginTranslation();
  const commit = React.useCallback(async (
    write: BindingPolicyInput,
    signal: AbortSignal,
  ): Promise<ConversationBindingEnablementResult | null> => {
    if (!await host.confirm(t('plugins.channels.surface.bindingEditSave', 'Save binding'), {
      action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate,
      signal,
    })) return null;
    return await updateConversationBindingPolicyInAccountCollection({ collection, ...write, signal });
  }, [collection, host, t]);
  return useAccountLocalMutation({
    signal: input.signal,
    onCommitted: input.onCommitted,
    commit,
    describeFailure: directBindingWriteFailure,
  });
}

function directConnectionWriteFailure(error: unknown): PluginActionExecution {
  const candidate = error !== null && typeof error === 'object'
    ? error as Readonly<{ code?: unknown; retryable?: unknown }>
    : undefined;
  const code = typeof candidate?.code === 'string'
    ? candidate.code
    : 'plugin_collection_mutation_failed';
  // A direct Data request can cross its mutation boundary before cancellation.
  // Keep the same explicit-reread discipline as the online Action helper.
  if (code === 'timeout'
    || code === 'aborted'
    || code === 'plugin_collection_cancelled'
    || code === 'channels_connection_update_cancelled') {
    return {
      status: 'outcomeUnknown',
      code,
      message: 'The connection policy change may have reached the Account.',
    };
  }
  return {
    status: 'error',
    code,
    message: 'The connection policy change did not complete.',
    retryable: candidate?.retryable === true,
  };
}

/** The direct-Data counterpart of the complete online connection policy Action. */
function useAccountLocalConnectionPolicy(input: Readonly<{
  collection: ChannelStateCollection;
  signal: AbortSignal;
  onCommitted: () => void;
}>): ConnectionPolicyOperation {
  const { collection } = input;
  const commit = React.useCallback(async (
    write: ConnectionPolicyInput,
    signal: AbortSignal,
  ): Promise<ConversationConnectionLifecycleMutationResult> => (
    await updateConversationConnectionInAccountCollection({ collection, ...write, signal })
  ), [collection]);
  return useAccountLocalMutation({
    signal: input.signal,
    onCommitted: input.onCommitted,
    commit,
    describeFailure: directConnectionWriteFailure,
  });
}

function directDeliveryResolveFailure(error: unknown): PluginActionExecution {
  const candidate = error !== null && typeof error === 'object'
    ? error as Readonly<{ code?: unknown; retryable?: unknown }>
    : undefined;
  const code = typeof candidate?.code === 'string'
    ? candidate.code
    : 'plugin_collection_mutation_failed';
  if (code === 'timeout'
    || code === 'aborted'
    || code === 'plugin_collection_cancelled') {
    return {
      status: 'outcomeUnknown',
      code,
      message: 'The delivery decision may have reached the Account.',
    };
  }
  return {
    status: 'error',
    code,
    message: 'The delivery decision did not complete.',
    retryable: candidate?.retryable === true,
  };
}

/**
 * The direct-Data counterpart of the delivery-resolution Action. Resolution is
 * explicitly provider-independent - the mounted Action itself performs no
 * provider call - so a cold offline Account can settle its own never-expiring
 * ambiguity through the same custody CAS owner.
 */
function useAccountLocalDeliveryResolution(input: Readonly<{
  stateCollection: ChannelStateCollection;
  deliveriesCollection: ChannelDeliveriesCollection;
  signal: AbortSignal;
  onCommitted: () => void;
}>): DeliveryResolveOperation {
  const { deliveriesCollection, stateCollection } = input;
  const commit = React.useCallback(async (
    write: DeliveryResolveInput,
    signal: AbortSignal,
  ) => (
    await resolveConversationOutwardDeliveryCustodyInAccountCollection({
      stateCollection,
      deliveriesCollection,
      ...write,
      signal,
    })
  ), [deliveriesCollection, stateCollection]);
  return useAccountLocalMutation({
    signal: input.signal,
    onCommitted: input.onCommitted,
    commit,
    describeFailure: directDeliveryResolveFailure,
  });
}

function transportLabel(transport: ConnectionTransport, t: Translate): string {
  if (transport === 'checkpointedPull') {
    return t('plugins.channels.surface.transportCheckpointedPull', 'Checkpointed pull');
  }
  if (transport === 'socket') {
    return t('plugins.channels.surface.transportSocket', 'Live socket');
  }
  return t('plugins.channels.surface.transportDurablePush', 'Durable push');
}

function transportOutcomeLabel(transport: ConnectionTransport, t: Translate): string {
  if (transport === 'checkpointedPull') {
    return t('plugins.channels.surface.transportCheckpointedPullOutcome', 'Keeps up after reconnecting');
  }
  if (transport === 'socket') {
    return t('plugins.channels.surface.transportSocketOutcome', 'Receives messages while this machine is online');
  }
  return t('plugins.channels.surface.transportDurablePushOutcome', 'Receives messages even while this machine is offline');
}

function connectionPolicyOutcome(
  presentation: PreparedConnectionPresentation,
  t: Translate,
): string {
  const overlap = presentation.overlapSafety === 'safe'
    ? t('plugins.channels.surface.connectionReviewOverlapSafe', 'Switching delivery methods is designed to avoid duplicate provider delivery.')
    : presentation.overlapSafety === 'providerExclusive'
      ? t('plugins.channels.surface.connectionReviewOverlapExclusive', 'The provider permits only one active delivery method, so switching may briefly pause incoming messages.')
      : t('plugins.channels.surface.connectionReviewOverlapDestructive', 'Changing delivery methods replaces the provider setup and can interrupt incoming messages.');
  const replay = presentation.replayContinuity === 'checkpointed'
    ? t('plugins.channels.surface.connectionReviewReplayCheckpointed', 'After an interruption, Happier can continue from its saved position.')
    : presentation.replayContinuity === 'sessionBound'
      ? t('plugins.channels.surface.connectionReviewReplaySession', 'Continuity lasts only while the selected machine process remains available.')
      : t('plugins.channels.surface.connectionReviewReplayNone', 'Messages sent during an interruption may not be recoverable.');
  return `${overlap} ${replay}`;
}

function ConnectionPreparationReview(props: Readonly<{
  presentation: PreparedConnectionPresentation;
  accountEncryptionMode: 'plain' | 'e2ee';
  testID: string;
  t: Translate;
}>): React.ReactElement {
  const unavailable = props.t('plugins.channels.surface.summaryUnavailable', 'Unavailable');
  // One framed key/value group: each fact a row with its value in the meta column. The transport is
  // chosen (and stated) by the control that follows the review, so it is not repeated here.
  const facts = [
    { key: 'provider', label: props.t('plugins.channels.surface.provider', 'Provider'), value: props.presentation.providerDisplayName },
    { key: 'account', label: props.t('plugins.channels.surface.connectionAccount', 'Connected Account'), value: props.presentation.connectedAccountLabel ?? unavailable },
    { key: 'machine', label: props.t('plugins.channels.surface.selectedMachineSummary', 'Runs on your selected machine'), value: props.presentation.machineDisplayName ?? unavailable },
    { key: 'destination', label: props.t('plugins.channels.surface.bindingCreateConversation', 'Destination'), value: props.presentation.destinationLabel ?? unavailable },
  ];
  return (
    <Stack gap="small" testID={props.testID}>
      <ItemGroup title={props.t('plugins.channels.surface.connectionReviewTitle', 'Review connection')}>
        {facts.map((fact) => (
          <Item key={fact.key} testID={`${props.testID}-${fact.key}`} title={fact.label} detail={fact.value} />
        ))}
        <Item
          testID={`${props.testID}-continuity`}
          title={props.t('plugins.channels.surface.connectionReviewContinuity', 'Continuity')}
          subtitle={connectionPolicyOutcome(props.presentation, props.t)}
        />
      </ItemGroup>
      <Banner
        tone="secondary"
        title={props.accountEncryptionMode === 'plain'
          ? props.t(
            'plugins.channels.surface.bindingCreatePrivacyPlain',
            'Storage and privacy: Channel configuration, binding policy, provider-derived identities, and externally bridged Session content use the documented server, database, and backup visibility of their canonical plain Account/Session owners.',
          )
          : props.t(
            'plugins.channels.surface.bindingCreatePrivacyE2ee',
            'Storage and privacy: in persisted Happier Account data, private fields remain inside canonical encrypted envelopes and only the bounded routing/index projection is server-readable.',
          )}
        description={props.t(
          'plugins.channels.surface.bindingCreatePrivacyTransit',
          'The connected provider always sees this conversation. Deliveries that arrive through a Happier-hosted webhook endpoint also pass through the Happier server, which reads and verifies the raw provider request before sealing it.',
        )}
      />
    </Stack>
  );
}

function formatObservationAge(value: number, t: Translate): string {
  const units = [
    [MILLISECONDS_PER_DAY, 'plugins.channels.surface.day', 'plugins.channels.surface.days', 'day', 'days'],
    [MILLISECONDS_PER_HOUR, 'plugins.channels.surface.hour', 'plugins.channels.surface.hours', 'hour', 'hours'],
    [MILLISECONDS_PER_MINUTE, 'plugins.channels.surface.minute', 'plugins.channels.surface.minutes', 'minute', 'minutes'],
  ] as const;
  for (const [milliseconds, singularKey, pluralKey, singularFallback, pluralFallback] of units) {
    if (value % milliseconds !== 0) continue;
    const quantity = value / milliseconds;
    return `${quantity.toLocaleString()} ${quantity === 1
      ? t(singularKey, singularFallback)
      : t(pluralKey, pluralFallback)}`;
  }
  const seconds = value / MILLISECONDS_PER_SECOND;
  const secondsText = seconds.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return `${secondsText} ${seconds === 1
    ? t('plugins.channels.surface.second', 'second')
    : t('plugins.channels.surface.seconds', 'seconds')}`;
}

function durationPresetOptions(
  presets: readonly number[],
  currentValue: string,
  t: Translate,
): readonly Readonly<{ value: string; label: string }>[] {
  const current = Number(currentValue);
  const values = Number.isInteger(current) && current >= 0
    ? [...new Set([...presets, current])].sort((left, right) => left - right)
    : presets;
  return values.map((value) => ({ value: String(value), label: formatObservationAge(value, t) }));
}

function parseResourceErrorMessage(
  reason: Extract<ParsedConnections | ParsedBindings, { kind: 'invalid' }>['reason'],
  t: Translate,
  subject: 'binding' | 'connection' = 'connection',
): string {
  if (subject === 'binding') {
    if (reason === 'contentType') {
      return t('plugins.channels.surface.bindingsResourceContentTypeInvalid', 'The binding Resource did not return JSON.');
    }
    if (reason === 'invalidJson') {
      return t('plugins.channels.surface.bindingsResourceInvalidJson', 'The binding Resource could not be read.');
    }
    if (reason === 'shape') {
      return t('plugins.channels.surface.bindingsResourceShapeInvalid', 'The binding Resource has an unexpected shape.');
    }
    return t('plugins.channels.surface.bindingsResourceBindingInvalid', 'The binding Resource contains an invalid binding.');
  }
  if (reason === 'contentType') {
    return t('plugins.channels.surface.resourceContentTypeInvalid', 'The connection Resource did not return JSON.');
  }
  if (reason === 'invalidJson') {
    return t('plugins.channels.surface.resourceInvalidJson', 'The connection Resource could not be read.');
  }
  if (reason === 'shape') {
    return t('plugins.channels.surface.resourceShapeInvalid', 'The connection Resource has an unexpected shape.');
  }
  return t('plugins.channels.surface.resourceConnectionInvalid', 'The connection Resource contains an invalid connection.');
}



/**
 * The saved enablement policy, stated on its own.
 *
 * It cannot share the row's single status accessory with runtime health: any
 * observed attention takes that accessory, and a person reading "Polling needs
 * attention" would have no way to see that they themselves paused this
 * connection.
 */
function connectionPolicyLabel(connection: ChannelsConnection, t: Translate): string {
  return connection.enabled
    ? t('plugins.channels.surface.enabled', 'Enabled')
    : t('plugins.channels.surface.connectionPaused', 'Paused');
}

/**
 * Collapsed summaries must separate policy from runtime placement: the
 * selected machine is a saved policy fact, while these Resource-observed
 * attention states already prove the runtime placement is not currently
 * healthy. Nothing here invents or persists health.
 */
function connectionMachinePlacementLabel(connection: ChannelsConnection, t: Translate): string {
  if (connection.attention.endpointRetargetOwed) {
    return t('plugins.channels.surface.machinePlacementRetargetOwed', 'Delivery still points at the previous machine');
  }
  if (connection.attention.oldTransportStopUnconfirmed) {
    return t('plugins.channels.surface.machinePlacementStopUnconfirmed', 'Previous machine stop unconfirmed');
  }
  if (connection.attention.pollFailure?.phase === 'blocked') {
    return t('plugins.channels.surface.machinePlacementPollBlocked', 'Selected machine is not receiving messages');
  }
  // Placement is where the connection is assigned. Only an enabled connection
  // is actually running there, so a paused one is never described as running.
  return connection.enabled
    ? t('plugins.channels.surface.selectedMachineSummary', 'Runs on your selected machine')
    : t('plugins.channels.surface.machinePlacementPausedAssigned', 'Assigned to your selected machine');
}


/**
 * The Resource retains canonical storage order. The settings index uses the
 * existing status presentation to keep connections needing attention visible
 * before the alphabetized, user-facing labels.
 */
function connectionAttentionRank(connection: ChannelsConnection, t: Translate): number {
  const tone = connectionStatus(connection, t).tone;
  if (tone === 'danger') return 0;
  if (channelsStatusNeedsYou(tone)) return 1;
  return 2;
}

function sortConnectionsForDisplay(
  connections: readonly ChannelsConnection[],
  t: Translate,
): readonly ChannelsConnection[] {
  return [...connections].sort((left, right) => {
    const attentionDifference = connectionAttentionRank(left, t) - connectionAttentionRank(right, t);
    if (attentionDifference !== 0) return attentionDifference;
    const labelDifference = (left.integrationPrincipalLabel ?? '').localeCompare(right.integrationPrincipalLabel ?? '');
    return labelDifference !== 0
      ? labelDifference
      : left.connectionId.localeCompare(right.connectionId);
  });
}

type BindingPresentation = Readonly<{
  binding: ChannelsBinding;
  connection?: ChannelsConnection;
}>;

/**
 * The connection (integration account) a binding delivers through, as its own
 * labeled fact. A provider can serve several accounts, so the row states which
 * one it targets alongside the provider brand.
 */
function bindingConnectionAccountSummary(
  connection: ChannelsConnection | undefined,
  t: Translate,
): string | undefined {
  const principalLabel = connection?.integrationPrincipalLabel?.trim();
  if (principalLabel === undefined || principalLabel === '') return undefined;
  return `${t('plugins.channels.surface.connectionAccount', 'Account')}: ${principalLabel}`;
}

function bindingAudienceLabel(audience: BindingEndpointAudience, t: Translate): string {
  return audience === 'direct'
    ? t('plugins.channels.surface.bindingAudienceDirect', 'Direct conversation')
    : t('plugins.channels.surface.bindingAudienceShared', 'Shared conversation');
}

function bindingTargetKindLabel(kind: BindingTargetKind, t: Translate): string {
  if (kind === 'threadRouter') return t('plugins.channels.surface.bindingTargetThreadRouter', 'New sessions per thread');
  if (kind === 'discussion') return t('plugins.channels.surface.bindingTargetDiscussion', 'Discussion');
  return kind === 'session'
    ? t('plugins.channels.surface.bindingTargetSession', 'Session')
    : t('plugins.channels.surface.bindingTargetAutomation', 'Automation');
}

function bindingInputModeLabel(mode: BindingInputMode, t: Translate): string {
  if (mode === 'directMentionsOnly') {
    return t('plugins.channels.surface.bindingInputDirectMentionsOnly', 'Direct mentions only');
  }
  if (mode === 'addressedMessages') {
    return t('plugins.channels.surface.bindingInputAddressedMessages', 'Addressed messages');
  }
  return t('plugins.channels.surface.bindingInputAllAllowedMessages', 'All allowed messages');
}

function bindingDeliveryModeLabel(mode: BindingDeliveryMode, t: Translate): string {
  if (mode === 'repliesOnly') {
    return t('plugins.channels.surface.bindingDeliveryRepliesOnly', 'Replies only');
  }
  if (mode === 'mirrorSession') {
    return t('plugins.channels.surface.bindingDeliveryMirrorSession', 'Mirror Session');
  }
  if (mode === 'finalResult') {
    return t('plugins.channels.surface.bindingDeliveryFinalResult', 'Final result');
  }
  return t('plugins.channels.surface.bindingDeliveryNone', 'No external result');
}

function bindingCreateLinkPreviewPolicyLabel(value: string, t: Translate): string {
  return value === 'providerDefault'
    ? t('plugins.channels.surface.bindingCreateLinkPreviewProviderDefault', 'Provider default')
    : t('plugins.channels.surface.bindingCreateLinkPreviewSuppress', 'Suppress previews');
}

function bindingCreateSenderFeedbackLabel(value: string, t: Translate): string {
  return value === 'eligibleRefusals'
    ? t('plugins.channels.surface.bindingCreateSenderFeedbackRefusals', 'Eligible refusals')
    : t('plugins.channels.surface.bindingCreateSenderFeedbackOff', 'Off');
}

function bindingEnabledLabel(enabled: boolean, t: Translate): string {
  return enabled
    ? t('plugins.channels.surface.enabled', 'Enabled')
    : t('plugins.channels.surface.disabled', 'Disabled');
}

function bindingApprovalDescription(binding: ChannelsBinding, t: Translate): string | undefined {
  if (binding.approval.kind !== 'enabled') return undefined;
  return binding.approval.maximumScope === 'request'
    ? t(
      'plugins.channels.surface.bindingApprovalEnabledRequest',
      'Approvers in this conversation can answer one permission request at a time with /allow or /deny.',
    )
    : t(
      'plugins.channels.surface.bindingApprovalEnabledSession',
      'Approvers in this conversation can answer permission requests with /allow or /deny, up to Session scope.',
    );
}

function bindingStatus(presentation: BindingPresentation, t: Translate) {
  if (presentation.binding.deletionState === 'finalizingDelete') {
    return {
      tone: 'warning' as const,
      label: t('plugins.channels.surface.deleteFinalizing', 'Deletion cleanup in progress'),
    };
  }
  if (presentation.connection === undefined) {
    return {
      tone: 'warning' as const,
      label: t('plugins.channels.surface.bindingConnectionUnavailable', 'Connection details are unavailable'),
    };
  }
  const connection = connectionStatus(presentation.connection, t);
  if (connection.tone !== 'secondary') return connection;
  return presentation.binding.enabled
    ? { tone: 'secondary' as const, label: t('plugins.channels.surface.enabled', 'Enabled') }
    : { tone: 'neutral' as const, label: t('plugins.channels.surface.disabled', 'Disabled') };
}

function bindingMachineSummary(connection: ChannelsConnection | undefined, t: Translate): string {
  return connection === undefined
    ? t('plugins.channels.surface.bindingConnectionUnavailable', 'Connection details are unavailable')
    : connectionMachinePlacementLabel(connection, t);
}

function bindingTargetSummary(binding: ChannelsBinding, t: Translate): string {
  // A router's summary is its kind marker, never a name the reader should see.
  if (binding.target.kind === 'threadRouter') return bindingTargetKindLabel(binding.target.kind, t);
  return `${bindingTargetKindLabel(binding.target.kind, t)}: ${binding.target.summary}`;
}

function bindingDetail(presentation: BindingPresentation, t: Translate): string {
  const { binding } = presentation;
  const approvalDescription = bindingApprovalDescription(binding, t);
  return [
    bindingTargetSummary(binding, t),
    bindingAudienceLabel(binding.endpoint.audience, t),
    bindingInputModeLabel(binding.inputMode, t),
    bindingDeliveryModeLabel(binding.deliveryMode, t),
    ...(approvalDescription === undefined ? [] : [approvalDescription]),
    bindingMachineSummary(presentation.connection, t),
    bindingEnabledLabel(binding.enabled, t),
    bindingStatus(presentation, t).label,
  ].join(' · ');
}

function bindingAttentionRank(presentation: BindingPresentation, t: Translate): number {
  const tone = bindingStatus(presentation, t).tone;
  if (tone === 'danger') return 0;
  if (channelsStatusNeedsYou(tone)) return 1;
  return 2;
}

function sortBindingsForDisplay(
  bindings: readonly BindingPresentation[],
  t: Translate,
): readonly BindingPresentation[] {
  return [...bindings].sort((left, right) => {
    const attentionDifference = bindingAttentionRank(left, t) - bindingAttentionRank(right, t);
    if (attentionDifference !== 0) return attentionDifference;
    const labelDifference = bindingEndpointLabel(left.binding, t).localeCompare(bindingEndpointLabel(right.binding, t));
    return labelDifference !== 0
      ? labelDifference
      : left.binding.bindingId.localeCompare(right.binding.bindingId);
  });
}

function buildBindingPresentations(
  bindings: readonly ChannelsBinding[],
  connections: readonly ChannelsConnection[],
  t: Translate,
): readonly BindingPresentation[] {
  const connectionById = new Map(connections.map((connection) => [connection.connectionId, connection]));
  return sortBindingsForDisplay(bindings.map((binding) => ({
    binding,
    ...(connectionById.get(binding.connectionId) === undefined
      ? {}
      : { connection: connectionById.get(binding.connectionId) }),
  })), t);
}

function bestEffortBeforeDurableAdmissionDescription(t: Translate): string {
  return t(
    'plugins.channels.surface.bestEffortBeforeDurableAdmissionDescription',
    'Messages received through this live connection can be lost before Happier records their admission.',
  );
}

function oldTransportStopUnconfirmedDescription(t: Translate): string {
  return t(
    'plugins.channels.surface.oldTransportStopUnconfirmedDescription',
    'Happier has not confirmed that the previous transport stopped. New connection authority is protected while reconciliation continues.',
  );
}

function endpointRetargetOwedDescription(t: Translate): string {
  return t(
    'plugins.channels.surface.endpointRetargetOwedDescription',
    'This connection moved to another machine, but the endpoint that receives its messages has not been pointed there yet. Nothing is lost while it waits — repair it to finish the move.',
  );
}

function acceptedPossibleLossDescription(t: Translate): string {
  return t(
    'plugins.channels.surface.acceptedPossibleLossDescription',
    'Deletion cleanup can continue because you accepted possible message loss; Happier has not claimed the old transport stopped.',
  );
}

function historyGapReasonDescription(reason: ConnectionHistoryGapReason, t: Translate): string {
  if (reason === 'applicationAdmissionLost') {
    return t(
      'plugins.channels.surface.historyGapApplicationAdmissionLostDescription',
      'Happier could not confirm the admission of some received messages.',
    );
  }
  return t(
    'plugins.channels.surface.historyGapProviderHistoryUnavailableDescription',
    'The integration provider could not confirm the complete message history for this connection.',
  );
}

/** A moment a person reads back (a reported gap, when a delivery was queued): date and time. */
function formatEventTime(atMs: number, t: Translate): string {
  const date = new Date(atMs);
  if (!Number.isFinite(date.getTime())) {
    return t('plugins.channels.surface.historyGapUnknownReportedAt', 'at an unknown time');
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return t('plugins.channels.surface.historyGapUnknownReportedAt', 'at an unknown time');
  }
}

function historyGapDescription(
  historyGap: NonNullable<ChannelsConnection['attention']['historyGap']>,
  t: Translate,
): string {
  return `${historyGapReasonDescription(historyGap.reason, t)} ${t(
    'plugins.channels.surface.historyGapReportedAt',
    'Reported',
  )} ${formatEventTime(historyGap.reportedAt, t)}.`;
}

function providerReadinessDescription(
  providerReadiness: NonNullable<ConnectionProviderReadiness>,
  t: Translate,
): string {
  if (providerReadiness.diagnostic !== undefined) return providerReadiness.diagnostic;
  if (providerReadiness.code === 'providerPermissionMissing') {
    return t(
      'plugins.channels.surface.providerPermissionMissingDescription',
      'The provider reports that a required remote permission is unavailable for this connection.',
    );
  }
  if (providerReadiness.code === 'providerCredentialInvalid') {
    return t(
      'plugins.channels.surface.providerCredentialInvalidDescription',
      'The provider rejected the Connected Account credential this connection uses. Replace or resynchronize it to restore the connection.',
    );
  }
  return t(
    'plugins.channels.surface.providerConfigurationInvalidDescription',
    'The provider reports that its remote configuration is not valid for this connection.',
  );
}

function ingressOccurrenceConflictDescription(t: Translate): string {
  return t(
    'plugins.channels.surface.ingressOccurrenceConflictDescription',
    'Happier received contradictory evidence for one incoming occurrence. It will not retry or advance this connection; delete the connection to remove the retained conflict.',
  );
}

function deliveryRetryDueDescription(t: Translate): string {
  return t(
    'plugins.channels.surface.deliveryRetryDueDescription',
    'Happier has not sent one message yet and will retry it when the saved connection policy remains current.',
  );
}

function deliveryNotDeliveredDescription(t: Translate): string {
  return t(
    'plugins.channels.surface.deliveryNotDeliveredDescription',
    'Happier confirmed that one message was not delivered.',
  );
}

function deliveryPartialDescription(t: Translate): string {
  return t(
    'plugins.channels.surface.deliveryPartialDescription',
    'Happier could not complete one message delivery, so its final effect needs attention.',
  );
}

function deliveryOutcomeUnknownDescription(t: Translate): string {
  return t(
    'plugins.channels.surface.deliveryOutcomeUnknownDescription',
    'Happier cannot confirm whether one message delivery completed. It will not resend it automatically.',
  );
}

function pollRetryDueDescription(t: Translate): string {
  return t(
    'plugins.channels.surface.pollRetryDueDescription',
    'Happier will retry this connection automatically.',
  );
}

function pollBlockedDescription(connection: ChannelsConnection, t: Translate): string {
  const evidence = connection.attention.pollFailure?.evidence;
  if (evidence?.kind === 'action' && evidence.message) return evidence.message;
  if (evidence?.kind === 'action' && evidence.code === 'plugin_action_caller_unavailable') {
    return t(
      'plugins.channels.surface.pollCallerUnavailableDescription',
      'Reload the integration on the selected machine, then retry polling.',
    );
  }
  return t(
    'plugins.channels.surface.pollBlockedDescription',
    'Happier stopped retrying this connection poll. Retry polling after reviewing the current connection policy.',
  );
}

function connectionContinuityDescriptions(connection: ChannelsConnection, t: Translate): readonly string[] {
  const descriptions: string[] = [];
  if (connection.attention.bestEffortBeforeDurableAdmission) {
    descriptions.push(bestEffortBeforeDurableAdmissionDescription(t));
  }
  if (connection.attention.historyGap !== null) {
    descriptions.push(historyGapDescription(connection.attention.historyGap, t));
  }
  if (connection.attention.providerReadiness !== null) {
    descriptions.push(providerReadinessDescription(connection.attention.providerReadiness, t));
  }
  if (connection.attention.ingressConflict !== null) {
    descriptions.push(ingressOccurrenceConflictDescription(t));
  }
  if (connection.attention.endpointRetargetOwed) {
    descriptions.push(endpointRetargetOwedDescription(t));
  } else if (connection.attention.oldTransportStopUnconfirmed) {
    descriptions.push(oldTransportStopUnconfirmedDescription(t));
  }
  if (connection.attention.acceptedPossibleLoss) {
    descriptions.push(acceptedPossibleLossDescription(t));
  }
  if (connection.attention.ingressConflict === null && connection.attention.pollFailure?.phase === 'retryDue') {
    descriptions.push(pollRetryDueDescription(t));
  }
  if (connection.attention.ingressConflict === null && connection.attention.pollFailure?.phase === 'blocked') {
    descriptions.push(pollBlockedDescription(connection, t));
  }
  if (connection.attention.outwardDelivery.retryDue) {
    descriptions.push(deliveryRetryDueDescription(t));
  }
  if (connection.attention.outwardDelivery.notDelivered) {
    descriptions.push(deliveryNotDeliveredDescription(t));
  }
  if (connection.attention.outwardDelivery.partial) {
    descriptions.push(deliveryPartialDescription(t));
  }
  if (connection.attention.outwardDelivery.outcomeUnknown) {
    descriptions.push(deliveryOutcomeUnknownDescription(t));
  }
  return descriptions;
}

/**
 * The one route from a rejected credential to the owner that can replace it.
 *
 * Connected Services owns every Connected Account credential, so this surface
 * hands over rather than growing a second place to re-enter one. The handoff is
 * the provider-neutral overview the public Host API already exposes: Channels
 * names no service, no Connected Account id, and never touches the credential.
 * Hosts that do not serve the method simply do not advertise it, and the
 * disclosure stays a plain explanation.
 */
function ConnectedAccountsHandoffAction(props: Readonly<{
  t: Translate;
}>): React.ReactElement | null {
  const hostApi = usePluginHostApi();
  const [unavailable, setUnavailable] = React.useState(false);
  const open = React.useCallback(() => {
    setUnavailable(false);
    void hostApi.openConnectedAccounts().catch(() => { setUnavailable(true); });
  }, [hostApi]);
  if (!hostApi.version().methods.includes('openConnectedAccounts')) return null;
  return (
    <Stack gap="small">
      <Button
        testID="channels-provider-credential-invalid-open-connected-accounts"
        title={props.t(
          'plugins.channels.surface.providerCredentialInvalidOpenConnectedAccounts',
          'Open Connected Services',
        )}
        onPress={open}
      />
      {unavailable ? (
        <Status
          testID="channels-provider-credential-invalid-open-connected-accounts-unavailable"
          tone="warning"
          label={props.t(
            'plugins.channels.surface.providerCredentialInvalidOpenConnectedAccountsUnavailable',
            'Connected Services could not be opened here. Open Settings to review this Connected Account.',
          )}
        />
      ) : null}
    </Stack>
  );
}

function ConnectionContinuityDisclosures(props: Readonly<{
  connection: ChannelsConnection;
  t: Translate;
}>): React.ReactElement | null {
  const historyGap = props.connection.attention.historyGap;
  const providerReadiness = props.connection.attention.providerReadiness;
  const ingressConflict = props.connection.attention.ingressConflict;
  const hasBestEffortBeforeDurableAdmission = props.connection.attention.bestEffortBeforeDurableAdmission;
  const hasOldTransportStopUnconfirmed = props.connection.attention.oldTransportStopUnconfirmed;
  const endpointRetargetOwed = props.connection.attention.endpointRetargetOwed;
  const acceptedPossibleLoss = props.connection.attention.acceptedPossibleLoss;
  const pollFailure = props.connection.attention.pollFailure;
  const outwardDelivery = props.connection.attention.outwardDelivery;
  if (!hasBestEffortBeforeDurableAdmission
    && historyGap === null
    && providerReadiness === null
    && ingressConflict === null
    && !hasOldTransportStopUnconfirmed
    && pollFailure === null
    && !outwardDelivery.retryDue
    && !outwardDelivery.notDelivered
    && !outwardDelivery.partial
    && !outwardDelivery.outcomeUnknown) return null;

  return (
    <Stack gap="small">
      {hasBestEffortBeforeDurableAdmission ? (
        <Banner
          testID="channels-best-effort-before-durable-admission"
          tone="warning"
          title={props.t(
            'plugins.channels.surface.bestEffortBeforeDurableAdmissionTitle',
            'Live messages are not durable until Happier admits them',
          )}
          description={bestEffortBeforeDurableAdmissionDescription(props.t)}
        />
      ) : null}
      {historyGap !== null ? (
        <Banner
          testID="channels-history-gap-disclosure"
          tone="danger"
          title={props.t('plugins.channels.surface.historyGapTitle', 'Conversation history may be incomplete')}
          description={historyGapDescription(historyGap, props.t)}
        />
      ) : null}
      {providerReadiness !== null ? (
        <Banner
          testID="channels-provider-readiness-disclosure"
          tone="warning"
          title={providerReadinessLabel(providerReadiness, props.t)}
          description={providerReadinessDescription(providerReadiness, props.t)}
          action={providerReadiness.code === 'providerCredentialInvalid'
            ? <ConnectedAccountsHandoffAction t={props.t} />
            : undefined}
        />
      ) : null}
      {ingressConflict !== null ? (
        <Banner
          testID="channels-ingress-occurrence-conflict-disclosure"
          tone="danger"
          title={props.t(
            'plugins.channels.surface.ingressOccurrenceConflictTitle',
            'Incoming occurrence conflict needs attention',
          )}
          description={ingressOccurrenceConflictDescription(props.t)}
        />
      ) : null}
      {endpointRetargetOwed ? (
        <Banner
          testID="channels-connection-endpoint-retarget-owed"
          tone="warning"
          title={props.t(
            'plugins.channels.surface.endpointRetargetOwedTitle',
            'Message delivery still points at the previous machine',
          )}
          description={endpointRetargetOwedDescription(props.t)}
        />
      ) : null}
      {hasOldTransportStopUnconfirmed && !endpointRetargetOwed ? (
        <Banner
          testID="channels-old-transport-stop-unconfirmed"
          tone={acceptedPossibleLoss ? 'danger' : 'warning'}
          title={acceptedPossibleLoss
            ? props.t('plugins.channels.surface.acceptedPossibleLossTitle', 'Possible message loss was accepted')
            : props.t('plugins.channels.surface.oldTransportStopUnconfirmedTitle', 'Previous transport may still be running')}
          description={acceptedPossibleLoss
            ? acceptedPossibleLossDescription(props.t)
            : oldTransportStopUnconfirmedDescription(props.t)}
        />
      ) : null}
      {ingressConflict === null && pollFailure?.phase === 'retryDue' ? (
        <Banner
          testID="channels-poll-retry-due-disclosure"
          tone="warning"
          title={props.t('plugins.channels.surface.pollRetryDueTitle', 'Conversation polling will retry')}
          description={pollRetryDueDescription(props.t)}
        />
      ) : null}
      {ingressConflict === null && pollFailure?.phase === 'blocked' ? (
        <Banner
          testID="channels-poll-blocked-disclosure"
          tone="warning"
          title={props.t('plugins.channels.surface.pollBlockedTitle', 'Conversation polling needs attention')}
          description={pollBlockedDescription(props.connection, props.t)}
        />
      ) : null}
      {outwardDelivery.retryDue ? (
        <Banner
          testID="channels-delivery-retry-due-disclosure"
          tone="warning"
          title={props.t('plugins.channels.surface.deliveryRetryDueTitle', 'A message delivery is waiting to retry')}
          description={deliveryRetryDueDescription(props.t)}
        />
      ) : null}
      {outwardDelivery.notDelivered ? (
        <Banner
          testID="channels-delivery-not-delivered-disclosure"
          tone="warning"
          title={props.t('plugins.channels.surface.deliveryNotDeliveredTitle', 'A message delivery was not sent')}
          description={deliveryNotDeliveredDescription(props.t)}
        />
      ) : null}
      {outwardDelivery.partial ? (
        <Banner
          testID="channels-delivery-partial-disclosure"
          tone="danger"
          title={props.t('plugins.channels.surface.deliveryPartialTitle', 'A message delivery was only partly sent')}
          description={deliveryPartialDescription(props.t)}
        />
      ) : null}
      {outwardDelivery.outcomeUnknown ? (
        <Banner
          testID="channels-delivery-outcome-unknown-disclosure"
          tone="danger"
          title={props.t('plugins.channels.surface.deliveryOutcomeUnknownTitle', 'A message delivery needs confirmation')}
          description={deliveryOutcomeUnknownDescription(props.t)}
        />
      ) : null}
    </Stack>
  );
}

function validObservationAge(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return isValidObservationAge(parsed) ? parsed : undefined;
}

/**
 * The one predicate behind `ResourceFreshnessNotice`. A caller that has to
 * reserve layout for the notice asks here instead of restating the rule, so
 * there is never a second opinion about whether the Resource has something to
 * disclose.
 */
function resourceFreshnessNoticeApplies(resource: ResourcePresentation): boolean {
  // Unknown freshness has no retained read to describe. Its ordinary error
  // state already explains the failure and offers recovery.
  if (resource.freshness === 'unknown') return false;
  // A requested reread marks retained values stale while pending; that alone
  // is ordinary refresh work, not a degraded-content notice.
  return (resource.freshness === 'stale' && resource.pending !== 'refresh')
    || resource.error !== undefined
    || resource.subscription === 'ended';
}

function ResourceFreshnessNotice(props: Readonly<{
  resource: ResourcePresentation;
  onRefresh: () => void;
  t: Translate;
  subject?: 'binding' | 'connection';
  testIDPrefix?: string;
}>): React.ReactElement | null {
  if (!resourceFreshnessNoticeApplies(props.resource)) return null;
  const subject = props.subject ?? 'connection';
  const testIDPrefix = props.testIDPrefix ?? 'channels-resource';
  const bindingSubject = subject === 'binding';
  const stale = props.resource.freshness === 'stale' || props.resource.error !== undefined;
  const refreshing = props.resource.pending === 'refresh';
  const reason = refreshing
    ? bindingSubject
      ? props.t('plugins.channels.surface.bindingsRefreshing', 'Refreshing binding details')
      : props.t('plugins.channels.surface.refreshing', 'Refreshing connection details')
    : stale
      ? bindingSubject
        ? props.t('plugins.channels.surface.bindingsStaleTitle', 'Showing last known binding details')
        : props.t('plugins.channels.surface.staleTitle', 'Showing last known connection details')
      : bindingSubject
        ? props.t('plugins.channels.surface.bindingsLiveUpdatesEndedTitle', 'Live binding updates are unavailable')
        : props.t('plugins.channels.surface.liveUpdatesEndedTitle', 'Live updates are unavailable');
  return <FreshnessLine
    testID={`${testIDPrefix}-${refreshing ? 'refreshing' : stale ? 'stale' : 'live-updates-ended'}`}
    reason={reason}
    busy={refreshing}
    tone="warning"
    action={refreshing ? undefined : { label: props.t('plugins.channels.surface.tryAgain', 'Try again'), onPress: props.onRefresh }}
  />;
}

/**
 * One presentation for "what you are editing changed underneath you".
 *
 * The binding editor and the connection policy editor state the same fact and
 * offer the same explicit Reload, so they share this owner instead of growing
 * two similar-but-different banners with drifting copy and affordances.
 */
function SourceChangedWhileEditingNotice(props: Readonly<{
  title: string;
  description: string;
  onReload: () => void;
  t: Translate;
  testID?: string;
  reloadTestID?: string;
}>): React.ReactElement {
  return (
    <Banner
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      tone="warning"
      title={props.title}
      description={props.description}
      action={(
        <Action.Refresh
          {...(props.reloadTestID === undefined ? {} : { testID: props.reloadTestID })}
          title={props.t('plugins.channels.surface.reload', 'Reload')}
          onRefresh={props.onReload}
        />
      )}
    />
  );
}

function BindingEnablementFailureNotice(props: Readonly<{
  failure: BindingEnablementFailure;
  t: Translate;
  testID?: string;
}>): React.ReactElement {
  const quotaIncompatible = props.failure.code === 'collection_quota_incompatible';
  return (
    <Banner
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      tone="danger"
      title={props.t(
        'plugins.channels.surface.bindingEnableFailedTitle',
        'Could not update binding enablement',
      )}
      description={quotaIncompatible
        ? props.t(
          'plugins.channels.surface.bindingEnableQuotaIncompatibleDescription',
          'This binding could not be enabled because the Account collection quota is incompatible. Ask an administrator to make the Account collection quota compatible, then refresh and try again.',
        )
        : props.t(
          'plugins.channels.surface.bindingEnableFailedDescription',
          'Refresh binding details before trying again.',
        )}
    />
  );
}

/**
 * The Channels page's navigation: every move goes through the host's
 * destination owner. Opening a conversation pushes, so Back returns to where
 * the reader was (the list on a phone, the previous conversation beside the
 * column); a page-internal step replaces the location instead.
 */
function useChannelsPageNavigation(): Readonly<{
  openConversation: (bindingId: string) => void;
  openRoot: () => void;
  openLink: () => void;
  showConversation: (bindingId: string) => void;
  openSettings: () => void;
  openSession?: (sessionId: string) => Promise<boolean>;
}> {
  const hostApi = usePluginHostApi();
  const methods = hostApi.version().methods;
  const canReplace = methods.includes('replacePageLocation');
  const canExecute = methods.includes('executeAction');
  return React.useMemo(() => ({
    openConversation: (bindingId: string) => {
      void hostApi.openSurface(CHANNELS_PAGE_VIEW_ID, undefined, { subPath: bindingId }).catch(() => undefined);
    },
    openRoot: () => {
      void hostApi.openSurface(CHANNELS_PAGE_VIEW_ID, undefined, { subPath: '' }).catch(() => undefined);
    },
    openLink: () => {
      void hostApi.openSurface(CHANNELS_PAGE_VIEW_ID, undefined, { subPath: 'link' }).catch(() => undefined);
    },
    // A conversation the page itself just produced (a finished link or pairing)
    // replaces the page-internal step, so Back does not return to a finished flow.
    showConversation: (bindingId: string) => {
      if (canReplace) {
        void hostApi.replacePageLocation(bindingId).catch(() => undefined);
        return;
      }
      void hostApi.openSurface(CHANNELS_PAGE_VIEW_ID, undefined, { subPath: bindingId }).catch(() => undefined);
    },
    openSettings: () => {
      void hostApi.openSurface(CHANNELS_SETTINGS_PAGE_ID).catch(() => undefined);
    },
    // Channels adds no Session-open API: it asks the incumbent `session.open`
    // Action for the exact Session id the binding targets.
    ...(canExecute ? {
      openSession: async (sessionId: string) => {
        try {
          await hostApi.executeAction('session.open', { sessionId });
          return true;
        } catch {
          return false;
        }
      },
    } : {}),
  }), [canExecute, canReplace, hostApi]);
}

function bindingApprovalSummary(binding: ChannelsBinding, t: Translate): string | undefined {
  if (binding.approval.kind === 'notApplicable') return undefined;
  if (binding.approval.kind === 'off') return t('plugins.channels.page.approvalsOff', 'Off');
  return binding.approval.maximumScope === 'request'
    ? t('plugins.channels.page.approvalsRequest', 'One request at a time')
    : t('plugins.channels.page.approvalsSession', 'Up to the whole session');
}

/** Where this conversation's messages go and what comes back, in one line. */
function conversationNote(binding: ChannelsBinding, t: Translate): string {
  if (binding.target.kind === 'automation') {
    return binding.deliveryMode === 'finalResult'
      ? t('plugins.channels.page.noteAutomationResult', 'Messages from this conversation start a run of the automation; its final result comes back here.')
      : t('plugins.channels.page.noteAutomation', 'Messages from this conversation start a run of the automation; nothing is sent back.');
  }
  if (binding.deliveryMode === 'mirrorSession') {
    return t('plugins.channels.page.noteMirror', 'Messages from this conversation appear in the session’s transcript, and the session’s messages are mirrored back here.');
  }
  if (binding.deliveryMode === 'none') {
    return t('plugins.channels.page.noteNone', 'Messages from this conversation appear in the session’s transcript; nothing is sent back.');
  }
  return t('plugins.channels.page.noteReplies', 'Messages from this conversation appear in the session’s transcript; the agent’s replies go back here.');
}

/**
 * What the conversation talks to (lab C1 "Talks to"). A Session's title is the
 * canonical Session read; the raw target id stands in only while no title is
 * readable.
 */
function ConversationTargetSection(props: Readonly<{
  binding: ChannelsBinding;
  mutationLocked: boolean;
  onLinkAnother?: () => void;
  openSession?: (sessionId: string) => Promise<boolean>;
  t: Translate;
}>): React.ReactElement {
  const { binding, t } = props;
  const isSession = binding.target.kind === 'session';
  // The summary is a bounded display projection; the Session is read and opened by its exact id.
  const sessionId = isSession ? binding.target.sessionId : undefined;
  const session = useSessionState(sessionId ?? null);
  const [openFailed, setOpenFailed] = React.useState(false);
  const [opening, setOpening] = React.useState(false);
  const title = isSession
    ? session.state?.title ?? binding.target.summary
    : binding.target.summary;
  const openSession = props.openSession;
  return (
    <ItemGroup
      testID="channels-page-target"
      title={isSession
        ? t('plugins.channels.page.talksTo', 'Talks to')
        : t('plugins.channels.page.startsRunOf', 'Starts a run of')}
    >
      <Item
        title={title}
        titleNumberOfLines={1}
        subtitle={openFailed
          ? t('plugins.channels.page.sessionOpenFailed', 'This session could not be opened.')
          : bindingTargetKindLabel(binding.target.kind, t)}
        {...(openFailed ? { detailTone: 'warning' as const } : {})}
        accessoryOutsidePressable
        accessoryWraps
        accessory={(
          <Row gap="small">
            {isSession && props.onLinkAnother !== undefined ? (
              <Button
                testID="channels-page-link-another"
                variant="plain"
                title={t('plugins.channels.page.linkAnotherSession', 'Link another session')}
                disabled={props.mutationLocked}
                onPress={props.onLinkAnother}
              />
            ) : null}
            {sessionId !== undefined && openSession !== undefined ? (
              <Button
                testID="channels-page-open-session"
                variant="secondary"
                title={t('plugins.channels.page.openSession', 'Open session')}
                busy={opening}
                disabled={opening}
                onPress={() => {
                  setOpening(true);
                  setOpenFailed(false);
                  void openSession(sessionId).then((opened) => {
                    setOpening(false);
                    setOpenFailed(!opened);
                  });
                }}
              />
            ) : null}
          </Row>
        )}
      />
    </ItemGroup>
  );
}

type BindingDetailState =
  | Readonly<{ kind: 'loading' }>
  /** This host cannot run the read at all, so only a reachable machine can answer it. */
  | Readonly<{ kind: 'unavailable' }>
  /** The read ran and failed (or found nothing); `message` is the host's sentence when it wrote one. */
  | Readonly<{ kind: 'error'; message?: string; retry: () => void }>
  | Readonly<{ kind: 'ready'; binding: ConversationBindingReadReady['binding'] }>;

type ConversationBindingReadReady = Extract<ConversationBindingReadResultV1, { kind: 'ready' }>;

/**
 * A binding's exact private detail (routes, allowed senders), read once per
 * revision through the incumbent read Action. `bindingId: null` reads nothing.
 * Each settlement keeps its own meaning: in flight is loading, a refusal or a
 * missing binding is an error the reader can retry, and only a host that cannot
 * run the read is unavailable.
 */
function useBindingDetail(bindingId: string | null, revision: number): BindingDetailState {
  const hostApi = usePluginHostApi();
  const readAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead);
  const canRead = hostApi.version().methods.includes('executeAction');
  const [attempt, setAttempt] = React.useState(0);
  const retry = React.useCallback(() => setAttempt((current) => current + 1), []);
  const [state, setState] = React.useState<BindingDetailState>(canRead ? { kind: 'loading' } : { kind: 'unavailable' });
  const execute = readAction.execute;
  React.useEffect(() => {
    if (!canRead || bindingId === null) return;
    let cancelled = false;
    setState((current) => current.kind === 'error' ? { kind: 'loading' } : current);
    void execute({ bindingId }).then((settled) => {
      if (cancelled) return;
      // A withdrawn mount or an overlapping read is still in flight.
      if (settled.status === 'pending' || settled.status === 'idle') return;
      if (settled.status !== 'success') {
        setState({ kind: 'error', message: settled.message, retry });
        return;
      }
      const detail = ConversationBindingReadResultV1Schema.safeParse(settled.result);
      setState(detail.success && detail.data.kind === 'ready'
        ? { kind: 'ready', binding: detail.data.binding }
        : { kind: 'error', retry });
    }).catch(() => {
      if (!cancelled) setState({ kind: 'error', retry });
    });
    return () => { cancelled = true; };
    // The summary revision is the reread trigger after an edit elsewhere.
  }, [attempt, bindingId, canRead, execute, retry, revision]);
  return state;
}

type RouterDetailState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'unavailable' }>
  | Extract<BindingDetailState, { kind: 'error' }>
  | Readonly<{ kind: 'ready'; target: ConversationThreadRouterBindingTargetV1 }>;

/** The router's exact private detail, projected from the page's one binding read. */
function routerDetailOf(detail: BindingDetailState): RouterDetailState {
  if (detail.kind !== 'ready') return detail;
  return detail.binding.target.kind === 'threadRouter'
    ? { kind: 'ready', target: detail.binding.target }
    : { kind: 'unavailable' };
}

/**
 * A router conversation (plan §3.1–3.2): how new threads are routed, the
 * threads it has started, and starting a new conversation with a sender group.
 */
function RouterThreadsSection(props: Readonly<{
  binding: ChannelsBinding;
  detail: RouterDetailState;
  threadChildren: readonly BindingPresentation[];
  mutationLocked: boolean;
  onOpenThread: (bindingId: string) => void;
  t: Translate;
}>): React.ReactElement {
  const { binding, detail, t } = props;
  const summarizeRecipe = useRouterRecipeSummary(t);
  const [starting, setStarting] = React.useState(false);
  // The bounded viewport keeps a long mailbox cheap; "Show all" lets the page
  // carry every thread once the reader asks for them.
  const [showingAll, setShowingAll] = React.useState(false);
  const [listClipped, setListClipped] = React.useState(false);
  const onOpenThread = props.onOpenThread;
  const groups = detail.kind === 'ready' ? detail.target.principalGroups : undefined;
  // Each thread is its own Session: one read follows them all, for the reply time, unread and Work facts
  // its row speaks. The router itself borrows none of it.
  const threadSessionIds = React.useMemo(() => props.threadChildren.flatMap((child) => (
    child.binding.target.kind === 'session' && child.binding.target.sessionId !== undefined ? [child.binding.target.sessionId] : []
  )), [props.threadChildren]);
  const threadSessions = useSessionStates(threadSessionIds, { select: selectChannelsRouterThreadSessionState }).sessions;
  const renderThread = React.useCallback((child: BindingPresentation) => (
    <RouterThreadRow
      binding={child.binding}
      groups={groups}
      session={child.binding.target.sessionId === undefined ? undefined : threadSessions.get(child.binding.target.sessionId)}
      onOpenThread={onOpenThread}
      t={t}
    />
  ), [groups, onOpenThread, t, threadSessions]);
  const threadCount = props.threadChildren.length;
  // A mailbox reads latest first: threads with a reply lead by its time; the rest keep the provider's
  // named threads ahead of older unnamed ones.
  const threads = React.useMemo(() => {
    const latestAt = (child: BindingPresentation): number | undefined => {
      const sessionId = child.binding.target.sessionId;
      const preview = sessionId === undefined ? undefined : channelsConversationActivity(threadSessions.get(sessionId))?.preview;
      return preview?.kind === 'ready' ? preview.createdAt : undefined;
    };
    const dated = props.threadChildren
      .flatMap((child) => {
        const at = latestAt(child);
        return at === undefined ? [] : [{ child, at }];
      })
      .sort((left, right) => right.at - left.at)
      .map(({ child }) => child);
    const undated = props.threadChildren.filter((child) => latestAt(child) === undefined);
    return [
      ...dated,
      ...undated.filter((child) => hasEndpointLabel(child.binding)),
      ...undated.filter((child) => !hasEndpointLabel(child.binding)),
    ];
  }, [props.threadChildren, threadSessions]);
  return (
    <Stack gap="large">
      <ItemGroup
        testID="channels-page-router-routes"
        title={t('plugins.channels.page.routerRoutes', 'How new threads start')}
        description={t('plugins.channels.page.routerRoutesDescription', 'The first route that matches a new thread decides which session starts. Mail that matches no route is dropped.')}
      >
        {detail.kind === 'ready' ? (
          detail.target.routes.length === 0 ? (
            <Item
              title={t('plugins.channels.page.routerNoRoutes', 'No routes yet')}
              subtitle={t('plugins.channels.page.routerNoRoutesDescription', 'Every new thread is dropped until you add a route. Edit this conversation to add one.')}
              detailTone="warning"
            />
          ) : detail.target.routes.map((route, index) => (
            <Item
              key={route.id}
              title={`${index + 1}. ${routerRouteConditionLabel(route.when, t)}`}
              subtitle={summarizeRecipe(route.recipe)}
            />
          ))
        ) : detail.kind === 'error' ? (
          <Item
            testID="channels-page-router-routes-error"
            title={t('plugins.channels.page.routerRoutesFailed', 'Couldn\u2019t read the routes')}
            subtitle={detail.message ?? t('plugins.channels.page.routerRoutesFailedDescription', 'Your threads below are unaffected. Try again in a moment.')}
            accessoryOutsidePressable
            accessory={(
              <Action.Refresh
                testID="channels-page-router-routes-retry"
                title={t('plugins.channels.surface.retry', 'Retry')}
                onRefresh={detail.retry}
              />
            )}
          />
        ) : (
          <Item
            title={detail.kind === 'loading'
              ? t('plugins.channels.page.routerRoutesLoading', 'Reading routes…')
              : t('plugins.channels.page.routerRoutesUnavailable', 'Routes are shown when your selected machine is reachable')}
          />
        )}
      </ItemGroup>

      {starting && detail.kind === 'ready' ? (
        <ConversationStartForm
          routerBindingId={binding.bindingId}
          groups={detail.target.principalGroups}
          threadCount={props.threadChildren.length}
          onClose={() => setStarting(false)}
          t={t}
        />
      ) : null}

      <ItemGroup
        testID="channels-page-router-threads"
        // A populated list leads with its count; the short action then stays
        // on the title line on a phone instead of floating above the rows.
        title={threadCount === 0
          ? t('plugins.channels.page.routerThreads', 'Threads')
          : threadCount === 1
            ? t('plugins.channels.page.routerThreadsCountOne', '1 thread')
            : t('plugins.channels.page.routerThreadsCount', '{count} threads', { count: threadCount })}
        {...(threadCount === 0 ? {
          description: t('plugins.channels.page.routerThreadsDescription', 'Each thread has its own session and only hears from the person who started it.'),
        } : {})}
        action={starting ? undefined : (
          <Button
            testID={`channels-router-start-${binding.bindingId}`}
            variant="plain"
            title={t('plugins.channels.page.routerStartShort', 'New thread')}
            accessibilityLabel={t('plugins.channels.page.routerStart', 'Start a conversation')}
            disabled={props.mutationLocked || detail.kind !== 'ready' || !binding.enabled}
            onPress={() => setStarting(true)}
          />
        )}
      >
        {props.threadChildren.length === 0 ? (
          <Item
            title={t('plugins.channels.page.routerNoThreads', 'No threads yet')}
            subtitle={t('plugins.channels.page.routerNoThreadsDescription', 'A thread appears here when an allowed sender writes in, or when you start one.')}
          />
        ) : (
          // Thread bindings are retained until someone deletes them, so a
          // long-lived mailbox can hold any number of them: the shared List
          // mounts only the rows in its viewport (REV-D-06).
          <Stack
            onLayout={(event) => {
              // Rows past the viewport exist only when the list fills its bound.
              const clipped = event.nativeEvent.layout.height >= EMBEDDED_LIST_VIEWPORT_PX - 1;
              setListClipped((current) => current || clipped);
            }}
          >
            <List<BindingPresentation>
              testID="channels-router-thread-list"
              accessibilityLabel={t('plugins.channels.page.routerThreads', 'Threads')}
              items={threads}
              keyForItem={routerThreadKey}
              renderItem={renderThread}
              {...(showingAll ? {} : { style: { maxHeight: EMBEDDED_LIST_VIEWPORT_PX } })}
              {...(listClipped ? {
                footer: (
                  <Row justify="center">
                    <Button
                      testID="channels-router-threads-show-all"
                      variant="plain"
                      title={showingAll
                        ? t('plugins.channels.page.routerThreadsShowFewer', 'Show fewer')
                        : t('plugins.channels.page.routerThreadsShowAll', 'Show all {count} threads', { count: threadCount })}
                      onPress={() => setShowingAll((current) => !current)}
                    />
                  </Row>
                ),
              } : {})}
            />
          </Stack>
        )}
      </ItemGroup>
    </Stack>
  );
}

/**
 * One thread a router started. A person tells threads apart by subject, so the
 * row leads with the provider's full thread label (an email subject) from the
 * thread's own read, and falls back to the Session's title for threads labelled
 * before providers sent one. The second line says who wrote in and by which
 * sender group; the trailing column says the one fact that changes: paused,
 * Work that needs the reader, else the latest reply's own time, in the accent
 * tone while it is unread. Reading the list never marks a thread read.
 * Only mounted rows read their sender, so a long thread list stays cheap.
 */
function RouterThreadRow(props: Readonly<{
  binding: ChannelsBinding;
  /** The router's sender groups, once its detail is read; a sender's group names the route it came in by. */
  groups: readonly ThreadRouterPrincipalGroup[] | undefined;
  session: SessionStateReadV1<ChannelsRouterThreadSessionState> | undefined;
  onOpenThread: (bindingId: string) => void;
  t: Translate;
}>): React.ReactElement {
  const { binding, groups, onOpenThread, t } = props;
  const { locale } = useSurfaceContext();
  const detail = useBindingDetail(binding.bindingId, binding.revision);
  const senders = detail.kind === 'ready' ? detail.binding.allowedPrincipalIds : [];
  const senderGroups = groups === undefined
    ? []
    : groups.filter((group) => senders.some((sender) => group.principalIds.includes(sender))).map((group) => group.id);
  const byline = [
    senders.length === 0
      ? undefined
      : senders.length === 1
        ? senders[0]!
        : t('plugins.channels.page.threadSenders', '{sender} and {count} more', { sender: senders[0]!, count: senders.length - 1 }),
    senderGroups.length === 0 ? undefined : senderGroups.join(', '),
  ].filter((part): part is string => part !== undefined).join(' · ');
  // The index carries a bounded label; the thread's own read has the subject whole, and the row
  // truncates it at its real width.
  const fullLabel = detail.kind === 'ready'
    ? (detail.binding.endpoint.label ?? detail.binding.endpoint.parentLabel)?.trim()
    : undefined;
  const sessionTitle = props.session?.status === 'ready' ? props.session.state?.title : undefined;
  const title = fullLabel !== undefined && fullLabel !== ''
    ? fullLabel
    : hasEndpointLabel(binding)
      ? bindingEndpointLabel(binding, t)
      : sessionTitle ?? bindingEndpointLabel(binding, t);
  const activity = channelsConversationActivity(props.session);
  const trailing = conversationRowTrailing({
    paused: !binding.enabled,
    deleting: binding.deletionState !== 'none',
    activity,
    locale,
    t,
  });
  return (
    <List.Item
      testID={`channels-router-thread-${binding.bindingId}`}
      title={title}
      titleNumberOfLines={1}
      // Reserved while the sender is read, so the row keeps its height.
      subtitle={byline === '' ? '\u00a0' : byline}
      subtitleNumberOfLines={1}
      {...(trailing.detail === undefined ? {} : { detail: trailing.detail })}
      {...(trailing.detailTone === undefined ? {} : { detailTone: trailing.detailTone })}
      accessibilityLabel={[
        title,
        ...(byline === '' ? [] : [byline]),
        ...(activity?.unread === true ? [t('plugins.channels.page.activityUnread', 'Unread')] : []),
        ...(trailing.detail === undefined ? [] : [trailing.detail]),
      ].join(', ')}
      onPress={() => onOpenThread(binding.bindingId)}
    />
  );
}

/**
 * The viewport of a list that sits inside a page section (thread rows, target
 * candidates): rows scroll inside it, so only the visible ones mount.
 */
const EMBEDDED_LIST_VIEWPORT_PX = 320;

function hasEndpointLabel(binding: ChannelsBinding): boolean {
  return (binding.endpoint.label?.trim() ?? '') !== '';
}

function routerThreadKey(child: BindingPresentation): string {
  return child.binding.bindingId;
}

type ConversationStartStatus =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'failed'; message?: string }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{
    kind: 'accepted';
    custodyId: string;
    /** The custody owner's own delivery outcome; absent until the first read settles. */
    outcome?: ConversationSessionLastDeliveryOutcomeV1;
    readFailed: boolean;
  }>;

/**
 * Starting a conversation (plan §3.2) through the incumbent
 * `conversation/start-v1` Action: the audience is one of the router's groups,
 * and replies come back to the chosen session. A successful Action only means
 * the delivery custody accepted the message; what happened to it afterwards is
 * read from that custody through `delivery/read-v1`, never assumed.
 */
function ConversationStartForm(props: Readonly<{
  routerBindingId: string;
  groups: ConversationThreadRouterBindingTargetV1['principalGroups'];
  /** The router's thread count: a new thread is the cue to reread the delivery. */
  threadCount: number;
  onClose: () => void;
  t: Translate;
}>): React.ReactElement {
  const { t } = props;
  const startAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.conversationStart);
  const deliveryRead = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryRead);
  const sessionPages = useSessionCandidatePages();
  const [groupId, setGroupId] = React.useState(props.groups[0]?.id ?? '');
  const [subject, setSubject] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [sessionId, setSessionId] = React.useState<string | undefined>();
  const [status, setStatus] = React.useState<ConversationStartStatus>({ kind: 'idle' });
  const loadSessions = sessionPages.load;
  React.useEffect(() => {
    void loadSessions();
  }, [loadSessions]);
  const sessions = sessionPages.candidates;
  React.useEffect(() => {
    setSessionId((current) => current ?? sessions[0]?.id);
  }, [sessions]);

  const executeRead = deliveryRead.execute;
  const custodyId = status.kind === 'accepted' ? status.custodyId : undefined;
  const readDelivery = React.useCallback(() => {
    if (custodyId === undefined) return;
    void executeRead({ custodyId }).then((settled) => {
      const parsed = settled.status === 'success'
        ? ConversationDeliveryReadResultV1Schema.safeParse(settled.result)
        : undefined;
      setStatus((current) => {
        if (current.kind !== 'accepted' || current.custodyId !== custodyId) return current;
        if (parsed?.success && parsed.data.kind === 'ready') {
          return { ...current, outcome: parsed.data.delivery.lastOutcome, readFailed: false };
        }
        return { ...current, readFailed: true };
      });
    }).catch(() => {
      setStatus((current) => (current.kind === 'accepted' && current.custodyId === custodyId
        ? { ...current, readFailed: true }
        : current));
    });
  }, [custodyId, executeRead]);
  // Read once on acceptance, then again whenever the router gains a thread:
  // the child binding is created only after the custody owner saw delivery.
  React.useEffect(() => {
    readDelivery();
  }, [readDelivery, props.threadCount]);

  const pending = startAction.execution.status === 'pending';
  const accepted = status.kind === 'accepted';
  const locked = pending || accepted;
  const ready = groupId !== '' && subject.trim() !== '' && message.trim() !== '' && sessionId !== undefined;
  const audience = props.groups.find((group) => group.id === groupId);
  const sessionOptions = sessions.map((session) => ({ value: session.id, label: session.label }));
  const reading = deliveryRead.execution.status === 'pending';
  return (
    <Stack gap="medium" testID="channels-router-start-form">
      <ItemGroup
        title={t('plugins.channels.page.routerStart', 'Start a conversation')}
        description={t('plugins.channels.page.routerStartDescription', 'Sends a new message to everyone in a group. Their replies come back to the session you choose.')}
      >
        <Item
          title={t('plugins.channels.page.routerStartAudience', 'To')}
          subtitle={audience === undefined || audience.principalIds.length === 0
            ? t('plugins.channels.page.routerStartAudienceEmpty', 'Nobody is in this group yet')
            : audience.principalIds.join(', ')}
          fieldAccessory
          accessoryOutsidePressable
          accessory={(
            <Form.Select
              testID="channels-router-start-audience"
              presentation="field"
              label={t('plugins.channels.page.routerStartAudience', 'To')}
              options={props.groups.map((group) => ({
                value: group.id,
                label: group.principalIds.length === 1
                  ? t('plugins.channels.page.routerStartAudienceOptionOne', '{group} (1 person)', { group: group.id })
                  : t('plugins.channels.page.routerStartAudienceOption', '{group} ({count} people)', {
                    group: group.id,
                    count: group.principalIds.length,
                  }),
              }))}
              value={groupId}
              disabled={locked}
              onChange={(value) => {
                const selected = readActionInputOptionValue(value);
                if (typeof selected === 'string') setGroupId(selected);
              }}
            />
          )}
        />
        <Item
          title={t('plugins.channels.page.routerStartSession', 'Replies go to')}
          subtitle={sessionPages.unavailable
            ? t('plugins.channels.page.routerStartSessionsFailed', 'Could not load your sessions')
            : !sessionPages.loaded
              ? t('plugins.channels.page.routerStartSessionsLoading', 'Loading your sessions…')
              : sessions.length === 0
                ? t('plugins.channels.page.routerStartNoSessions', 'Replies need a session to go to. Start one, then come back.')
                : t('plugins.channels.page.routerStartSessionDescription', 'This session answers when someone replies.')}
          fieldAccessory
          accessoryOutsidePressable
          accessory={sessionPages.unavailable ? (
            <Action.Refresh
              testID="channels-router-start-sessions-retry"
              title={t('plugins.channels.surface.retry', 'Retry')}
              onRefresh={() => { void sessionPages.retry(); }}
            />
          ) : (
            <Form.Select
              testID="channels-router-start-session"
              presentation="field"
              label={t('plugins.channels.page.routerStartSession', 'Replies go to')}
              options={sessionOptions}
              value={sessionId ?? ''}
              disabled={locked || sessions.length === 0}
              onChange={(value) => {
                const selected = readActionInputOptionValue(value);
                if (typeof selected === 'string') setSessionId(selected);
              }}
            />
          )}
        />
        {sessionPages.nextCursor === undefined || sessionPages.unavailable ? null : (
          <Item
            testID="channels-router-start-sessions-more"
            title={t('plugins.channels.surface.bindingCreateSessionLoadMore', 'Show more Sessions')}
            busy={sessionPages.loading}
            disabled={locked || sessionPages.loading}
            onPress={() => { void sessionPages.load(sessionPages.nextCursor); }}
          />
        )}
      </ItemGroup>
      {/* The message itself, as labelled rows on one sheet: the subject a
          person scans in their inbox, then the body beneath it. */}
      <ItemGroup testID="channels-router-start-message" surface="sheet">
        <Item
          title={t('plugins.channels.page.routerStartSubject', 'Subject')}
          accessoryBelow
          accessoryOutsidePressable
          accessory={(
            <Form.TextField
              testID="channels-router-start-subject"
              presentation="field"
              label={t('plugins.channels.page.routerStartSubject', 'Subject')}
              value={subject}
              disabled={locked}
              onChange={setSubject}
            />
          )}
        />
        <Item
          title={t('plugins.channels.page.routerStartMessage', 'Message')}
          accessoryBelow
          accessoryOutsidePressable
          accessory={(
            <Form.TextField
              testID="channels-router-start-message-body"
              presentation="field"
              label={t('plugins.channels.page.routerStartMessage', 'Message')}
              value={message}
              multiline
              disabled={locked}
              onChange={setMessage}
            />
          )}
        />
      </ItemGroup>
      <Stack gap="medium">
        <ConversationStartStatusLine status={status} reading={reading} onReread={readDelivery} t={t} />
        <Row gap="small">
          {accepted ? null : (
            <Button
              testID="channels-router-start-send"
              variant="primary"
              title={t('plugins.channels.page.routerStartSend', 'Send')}
              busy={pending}
              disabled={!ready || pending}
              onPress={() => {
                if (!ready || sessionId === undefined) return;
                setStatus({ kind: 'idle' });
                void startAction.execute({
                  routerBindingId: props.routerBindingId,
                  audienceGroupId: groupId,
                  subject: subject.trim(),
                  content: { text: message },
                  sessionId,
                }).then((settled) => {
                  if (settled.status === 'success') {
                    const result = ConversationStartResultV1Schema.safeParse(settled.result);
                    setStatus(result.success
                      ? { kind: 'accepted', custodyId: result.data.custodyId, readFailed: false }
                      : { kind: 'unknown' });
                    return;
                  }
                  setStatus(settled.status === 'outcomeUnknown' ? { kind: 'unknown' }
                    : { kind: 'failed', ...(settled.status === 'error' ? { message: settled.message } : {}) });
                }).catch(() => setStatus({ kind: 'failed' }));
              }}
            />
          )}
          <Button
            testID="channels-router-start-close"
            variant={accepted ? 'secondary' : 'plain'}
            title={accepted ? t('plugins.channels.page.done', 'Done') : t('plugins.channels.surface.cancel', 'Cancel')}
            disabled={pending}
            onPress={props.onClose}
          />
        </Row>
      </Stack>
    </Stack>
  );
}

/**
 * One line for where a started conversation stands. Acceptance is never
 * "sent": only the custody owner's `delivered` outcome is.
 */
function ConversationStartStatusLine(props: Readonly<{
  status: ConversationStartStatus;
  reading: boolean;
  onReread: () => void;
  t: Translate;
}>): React.ReactElement | null {
  const { status, t } = props;
  const reread = (
    <Action.Refresh
      testID="channels-router-start-status-refresh"
      title={t('plugins.channels.surface.refresh', 'Refresh')}
      onRefresh={props.onReread}
    />
  );
  if (status.kind === 'idle') return null;
  if (status.kind === 'failed') {
    return (
      <Banner
        testID="channels-router-start-status"
        tone="danger"
        title={t('plugins.channels.page.routerStartUnknown', 'It is not yet known whether the message was sent. Check the bot’s delivery attention before sending again.')}
        description={status.message}
      />
    );
  }
  if (status.kind === 'unknown') {
    return (
      <Banner
        testID="channels-router-start-status"
        tone="warning"
        title={t('plugins.channels.page.routerStartUnknown', 'It is not yet known whether the message was sent. Check the bot’s delivery attention before sending again.')}
      />
    );
  }
  if (status.outcome === 'delivered') {
    return (
      <Banner
        testID="channels-router-start-status"
        tone="neutral"
        title={t('plugins.channels.page.routerStartDelivered', 'Sent. Replies come back to the session you chose.')}
      />
    );
  }
  if (status.outcome === 'notDelivered') {
    return (
      <Banner
        testID="channels-router-start-status"
        tone="danger"
        title={t('plugins.channels.page.routerStartNotDelivered', 'The message could not be delivered')}
        description={t('plugins.channels.page.routerStartNotDeliveredDescription', 'Nothing reached the group. Check the bot, then start the conversation again.')}
      />
    );
  }
  if (status.outcome === 'unknown') {
    return (
      <Banner
        testID="channels-router-start-status"
        tone="warning"
        title={t('plugins.channels.page.routerStartOutcomeUnknown', 'It is not known whether the message arrived')}
        description={t('plugins.channels.page.routerStartOutcomeUnknownDescription', 'Happier will not send it again on its own. Decide what happened in the bot’s delivery attention.')}
      />
    );
  }
  return (
    <Banner
      testID="channels-router-start-status"
      tone="neutral"
      title={status.readFailed
        ? t('plugins.channels.page.routerStartQueuedUnread', 'Queued. Its delivery could not be checked just now.')
        : t('plugins.channels.page.routerStartQueued', 'Queued. It is sent as soon as the bot can reach the mailbox.')}
      action={props.reading ? undefined : reread}
    />
  );
}

/**
 * The identity a conversation's editor names itself with: the page's own mark and
 * address, so editing reads as a focused state of that page rather than a form below it.
 */
type ConversationEditIdentity = Readonly<{
  leading?: React.ReactElement;
  meta: NonNullable<React.ComponentProps<typeof PageHeader>['meta']>;
}>;

const ConversationEditIdentityContext = React.createContext<ConversationEditIdentity | null>(null);

/**
 * The editing state's page header: "Edit conversation" with the conversation's mark
 * and address, and the editor's one commit pair on the right, where page-level
 * actions go.
 */
function ConversationEditPageHeader(props: Readonly<{
  actions?: React.ReactElement;
  focusTarget?: PluginUiFocusTarget;
  t: Translate;
}>): React.ReactElement {
  const identity = React.useContext(ConversationEditIdentityContext);
  return (
    <PageHeader
      testID="channels-binding-edit-header"
      title={props.t('plugins.channels.page.editTitle', 'Edit conversation')}
      description={props.t(
        'plugins.channels.page.editDescription',
        'Who can write in, and how new threads start. Nothing changes until you review and save.',
      )}
      {...(identity?.leading === undefined ? {} : { leading: identity.leading })}
      {...(identity === null ? {} : { meta: identity.meta })}
      {...(props.focusTarget === undefined ? {} : { focusTarget: props.focusTarget })}
      {...(props.actions === undefined ? {} : { actions: props.actions })}
    />
  );
}

/**
 * One linked conversation (lab C1): identity, what it talks to, the one cause
 * that needs the reader, where its messages go, its settings as a summary with
 * Edit, its bot, and Pause / Unlink last. Every mutation here is the page's
 * own enablement and delete operation; editing is the incumbent draft → review
 * → save journey, never inline switches that would bypass review.
 */
function ConversationDetail(props: Readonly<{
  presentation: BindingPresentation;
  /** Thread bindings this router created; empty for every other target. */
  threadChildren?: readonly BindingPresentation[];
  execution: PluginActionExecution;
  deleteOperation?: BindingDeleteOperation;
  activeBindingId: string | undefined;
  activeDeletedBindingId: string | undefined;
  outcomeUnknownBindingId: string | undefined;
  outcomeUnknownDeletedBindingId: string | undefined;
  enablementFailure?: BindingEnablementFailure;
  onSetEnabled: (binding: ChannelsBinding, enabled: boolean) => Promise<void>;
  onDelete?: (binding: ChannelsBinding) => Promise<void>;
  onEdit?: (binding: ChannelsBinding, focusTarget: PluginUiFocusTarget, intent?: 'target') => void;
  editContent?: React.ReactElement;
  onUnknownOutcomeRefresh: () => void;
  onUnknownDeleteOutcomeRefresh: () => void;
  connectionTest?: Readonly<{ resource: ResourcePresentation; onRefresh: () => void }>;
  t: Translate;
}>): React.ReactElement {
  const { binding, connection } = props.presentation;
  const t = props.t;
  const navigation = useChannelsPageNavigation();
  const providerPluginId = connection?.providerPluginId;
  const providerDisplayName = useConversationProviderDisplayName(providerPluginId)
    ?? t('plugins.channels.surface.providerFallback', 'Integration provider');
  const editFocusTarget = usePluginUiFocusTarget();
  const enablementFailure = props.enablementFailure?.bindingId === binding.bindingId
    ? props.enablementFailure
    : undefined;
  const enablementOutcomeUnknown = props.execution.status === 'outcomeUnknown';
  const deleteExecution = props.deleteOperation?.execution;
  const deleteOutcomeUnknown = deleteExecution?.status === 'outcomeUnknown';
  const enablementBusy = props.execution.status === 'pending' && props.activeBindingId === binding.bindingId;
  const deleteBusy = deleteExecution?.status === 'pending' && props.activeDeletedBindingId === binding.bindingId;
  const mutationLocked = props.execution.status === 'pending'
    || enablementOutcomeUnknown
    || deleteExecution?.status === 'pending'
    || deleteOutcomeUnknown;
  const deleting = binding.deletionState !== 'none';
  const enablementUnavailable = deleting || mutationLocked;
  const deleteUnavailable = deleting || mutationLocked;
  const needsUnknownEnablementRefresh = enablementOutcomeUnknown
    && props.outcomeUnknownBindingId === binding.bindingId;
  const needsUnknownDeleteRefresh = deleteOutcomeUnknown
    && props.outcomeUnknownDeletedBindingId === binding.bindingId;
  const botStatus = connection === undefined ? undefined : connectionStatus(connection, t);
  const botNeedsYou = botStatus !== undefined && channelsStatusNeedsYou(botStatus.tone);
  const approvalSummary = bindingApprovalSummary(binding, t);
  const unknownEnablementDescription = t(
    'plugins.channels.surface.bindingSaveUnknownDescription',
    'The change may already be saved. Refresh binding details before changing it again.',
  );
  const unknownDeleteDescription = t(
    'plugins.channels.surface.bindingDeleteUnknownDescription',
    'The deletion request may already be saved. Refresh binding details before deciding what to do next.',
  );
  const editing = props.editContent !== undefined;
  const isRouter = binding.target.kind === 'threadRouter';
  // One exact read serves a router (its routes and groups) and a thread a
  // router started (the people on it, whom its header names).
  const isThread = binding.parentBindingId !== undefined;
  const bindingDetail = useBindingDetail(isRouter || isThread ? binding.bindingId : null, binding.revision);
  const routerDetail = routerDetailOf(bindingDetail);
  const threadPeople = isThread && bindingDetail.kind === 'ready' ? bindingDetail.binding.allowedPrincipalIds : [];
  const routerGroupIds = routerDetail.kind === 'ready' ? routerDetail.target.principalGroups.map((group) => group.id) : [];
  const audienceMeta = isRouter
    ? routerGroupIds.length === 0
      ? undefined
      : t('plugins.channels.page.routerAudience', 'Senders in {groups}', { groups: formatConjunction(routerGroupIds) })
    : threadPeople.length === 1
    ? t('plugins.channels.page.threadFrom', 'From {sender}', { sender: threadPeople[0]! })
    : threadPeople.length > 1
      ? t('plugins.channels.page.threadWith', 'With {sender} and {count} more', { sender: threadPeople[0]!, count: threadPeople.length - 1 })
      : binding.endpoint.audience === 'direct'
        ? t('plugins.channels.page.onlyYou', 'Only you')
        : t('plugins.channels.page.sharedConversation', 'Shared conversation');
  // The one cause that needs the reader. A router's threads run long, so its
  // cause leads the page instead of waiting below every thread.
  const attentionBanner = deleting ? (
        <Banner
          testID={`channels-binding-deleting-${binding.bindingId}`}
          tone="warning"
          title={t('plugins.channels.surface.deleteFinalizing', 'Deletion cleanup in progress')}
          description={t('plugins.channels.page.deletingDescription', 'This conversation is being unlinked. The bot stays connected.')}
        />
      ) : botNeedsYou && botStatus !== undefined ? (
        <Banner
          testID={`channels-binding-bot-attention-${binding.bindingId}`}
          tone="warning"
          title={botStatus.label}
          description={t(
            'plugins.channels.page.botAttentionDescription',
            'This is about the bot, so it affects every conversation it serves. Fix it in the bot’s settings.',
          )}
          action={(
            <Button
              variant="secondary"
              title={t('plugins.channels.page.manageBot', 'Manage bot')}
              onPress={navigation.openSettings}
            />
          )}
        />
      ) : !binding.enabled ? (
        <Banner
          testID={`channels-binding-paused-${binding.bindingId}`}
          tone="neutral"
          title={t('plugins.channels.column.paused', 'Paused')}
          description={t(
            'plugins.channels.page.pausedDescription',
            'Nothing comes in and nothing is sent back. A newly linked conversation starts paused: check who can talk to it and what it sends back, then turn it on.',
          )}
          action={(
            <Button
              testID={`channels-binding-turn-on-${binding.bindingId}`}
              variant="primary"
              title={t('plugins.channels.page.turnOn', 'Turn on')}
              busy={enablementBusy}
              disabled={enablementUnavailable}
              onPress={() => { void props.onSetEnabled(binding, true); }}
            />
          )}
        />
      ) : null;

  const brandMark = providerPluginId === undefined ? undefined : (
    <BrandMark
      pluginId={providerPluginId}
      size="medium"
      externallyLabelled
      testID={`channels-provider-brand-binding-${binding.bindingId}`}
    />
  );
  const endpointLabel = bindingEndpointLabel(binding, t);
  const editIdentity: ConversationEditIdentity = {
    ...(brandMark === undefined ? {} : { leading: brandMark }),
    meta: [
      { key: 'conversation', text: endpointLabel },
      ...(providerPluginId === undefined ? [] : [{ key: 'provider', text: providerDisplayName }]),
    ],
  };

  // Editing is its own focused state of the page: the editor replaces the overview,
  // the bot and the stop operations, under its own header with one commit pair.
  if (editing) {
    return (
      <Stack gap="large" testID={`channels-binding-${binding.bindingId}`}>
        <ConversationEditIdentityContext.Provider value={editIdentity}>
          {props.editContent}
        </ConversationEditIdentityContext.Provider>
      </Stack>
    );
  }

  return (
    <Stack gap="large" testID={`channels-binding-${binding.bindingId}`}>
      <PageHeader
        title={endpointLabel}
        leading={brandMark}
        meta={[
          ...(providerPluginId === undefined ? [] : [{ key: 'provider', text: providerDisplayName }]),
          // A mailbox bot is named by the address the title already shows: say it once.
          ...(connection === undefined || connectionLabel(connection) === bindingEndpointLabel(binding, t)
            ? []
            : [{ key: 'bot', text: connectionLabel(connection) }]),
          ...(audienceMeta === undefined ? [] : [{ key: 'audience', text: audienceMeta }]),
        ]}
      />

      {isRouter ? attentionBanner : null}

      {isRouter ? (
        <RouterThreadsSection
          binding={binding}
          detail={routerDetail}
          threadChildren={props.threadChildren ?? []}
          mutationLocked={mutationLocked || deleting}
          onOpenThread={navigation.openConversation}
          t={t}
        />
      ) : <ConversationTargetSection
        binding={binding}
        mutationLocked={mutationLocked || deleting}
        {...(props.onEdit === undefined || deleting ? {} : {
          onLinkAnother: () => props.onEdit?.(binding, editFocusTarget, 'target'),
        })}
        {...(navigation.openSession === undefined ? {} : { openSession: navigation.openSession })}
        t={t}
      />}

      {isRouter ? null : attentionBanner}

      {/* A router's routes and threads already say where its mail goes. */}
      {isRouter ? null : (
        <Row gap="small" align="center">
          <Icon name="conversations" size="small" tone="muted" />
          <Text testID="channels-page-note" tone="secondary" value={conversationNote(binding, t)} />
        </Row>
      )}

      <ItemGroup
        testID="channels-page-conversation"
        title={t('plugins.channels.page.conversation', 'Conversation')}
        action={props.onEdit === undefined || deleting ? undefined : (
          <Button
            testID={`channels-binding-edit-${binding.bindingId}`}
            variant="plain"
            title={t('plugins.channels.page.edit', 'Edit')}
            accessibilityLabel={t('plugins.channels.surface.bindingEdit', 'Edit binding')}
            focusTarget={editFocusTarget}
            disabled={mutationLocked}
            onPress={() => props.onEdit?.(binding, editFocusTarget)}
          />
        )}
      >
        <Item title={t('plugins.channels.page.listensTo', 'Listens to')} detail={bindingInputModeLabel(binding.inputMode, t)} />
        {/* Each thread a router starts replies through its own policy. */}
        {isRouter ? null : (
          <Item title={t('plugins.channels.page.sendsBack', 'Sends back')} detail={bindingDeliveryModeLabel(binding.deliveryMode, t)} />
        )}
        {approvalSummary === undefined ? null : (
          <Item title={t('plugins.channels.page.approvals', 'Approvals from this conversation')} detail={approvalSummary} />
        )}
      </ItemGroup>

      <ConversationBotSection
        {...(connection === undefined ? {} : { connection })}
        attentionShownAbove={!deleting && botNeedsYou}
        {...(props.connectionTest === undefined ? {} : { connectionTest: props.connectionTest })}
        onManage={navigation.openSettings}
        t={t}
      />

      <ItemGroup
        testID="channels-page-stop"
        title={binding.enabled
          ? t('plugins.channels.page.pauseOrUnlink', 'Pause or unlink')
          : t('plugins.channels.page.unlinkSection', 'Unlink')}
      >
        {binding.enabled ? (
          <Item
            title={t('plugins.channels.page.pause', 'Pause')}
            subtitle={t('plugins.channels.page.pauseDescription', 'Stop taking messages in and sending replies. Nothing is deleted.')}
            accessoryOutsidePressable
            accessory={(
              <Button
                testID={`channels-binding-pause-${binding.bindingId}`}
                variant="secondary"
                title={enablementBusy ? t('plugins.channels.surface.saving', 'Saving…') : t('plugins.channels.page.pause', 'Pause')}
                busy={enablementBusy}
                disabled={enablementUnavailable}
                onPress={() => { void props.onSetEnabled(binding, false); }}
              />
            )}
          />
        ) : null}
        {props.onDelete === undefined ? null : (
          <Item
            title={t('plugins.channels.page.unlink', 'Unlink')}
            tone="danger"
            subtitle={binding.target.kind === 'threadRouter'
              ? t('plugins.channels.page.unlinkRouterDescription', 'New threads stop starting sessions. Sessions already started keep their own threads. The bot stays connected.')
              : binding.target.kind === 'automation'
                ? t('plugins.channels.page.unlinkAutomationDescription', 'The automation stops hearing from this conversation. The bot stays connected.')
                : t('plugins.channels.page.unlinkSessionDescription', 'The session stops hearing from this conversation. The bot stays connected.')}
            accessoryOutsidePressable
            accessory={(
              <Button
                testID={`channels-binding-delete-${binding.bindingId}`}
                variant="secondary"
                title={deleteBusy
                  ? t('plugins.channels.page.unlinking', 'Unlinking…')
                  : t('plugins.channels.page.unlinkAction', 'Unlink…')}
                busy={deleteBusy}
                disabled={deleteUnavailable}
                onPress={() => { void props.onDelete?.(binding); }}
              />
            )}
          />
        )}
      </ItemGroup>

      {needsUnknownEnablementRefresh ? (
        <Banner
          testID={`channels-binding-outcome-unknown-${binding.bindingId}`}
          tone="warning"
          title={t('plugins.channels.surface.bindingSaveUnknownTitle', 'Could not confirm the binding change')}
          description={unknownEnablementDescription}
          action={(
            <Action.Refresh
              testID={`channels-binding-outcome-unknown-reconcile-${binding.bindingId}`}
              title={t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={props.onUnknownOutcomeRefresh}
            />
          )}
        />
      ) : null}
      {needsUnknownDeleteRefresh ? (
        <Banner
          testID={`channels-binding-delete-outcome-unknown-${binding.bindingId}`}
          tone="warning"
          title={t('plugins.channels.surface.bindingDeleteUnknownTitle', 'Could not confirm binding deletion')}
          description={unknownDeleteDescription}
          action={(
            <Action.Refresh
              testID={`channels-binding-delete-outcome-unknown-reconcile-${binding.bindingId}`}
              title={t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={props.onUnknownDeleteOutcomeRefresh}
            />
          )}
        />
      ) : null}
      {enablementFailure === undefined ? null : (
        <BindingEnablementFailureNotice
          failure={enablementFailure}
          t={t}
          testID={`channels-binding-enable-error-${binding.bindingId}`}
        />
      )}
      {props.activeDeletedBindingId === binding.bindingId && deleteExecution?.status === 'error' ? (
        <Banner
          testID={`channels-binding-delete-error-${binding.bindingId}`}
          tone="danger"
          title={t('plugins.channels.page.unlinkFailedTitle', 'Could not unlink this conversation')}
          description={t(
            'plugins.channels.surface.bindingDeleteFailedDescription',
            'Refresh binding details before trying again.',
          )}
          action={(
            <Action.Refresh
              title={t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={props.onUnknownDeleteOutcomeRefresh}
            />
          )}
        />
      ) : null}
    </Stack>
  );
}

/** The conversation's bot: its state in words, Test, and the way to its settings. */
function ConversationBotSection(props: Readonly<{
  connection?: ChannelsConnection;
  connectionTest?: Readonly<{ resource: ResourcePresentation; onRefresh: () => void }>;
  /** The page's banner already says what the bot needs; the row then states facts only. */
  attentionShownAbove: boolean;
  onManage: () => void;
  t: Translate;
}>): React.ReactElement {
  return props.connection !== undefined && props.connectionTest !== undefined ? (
    <TestableConversationBotSection
      connection={props.connection}
      connectionTest={props.connectionTest}
      attentionShownAbove={props.attentionShownAbove}
      onManage={props.onManage}
      t={props.t}
    />
  ) : (
    <ConversationBotGroup {...props} />
  );
}

function TestableConversationBotSection(props: Readonly<{
  connection: ChannelsConnection;
  connectionTest: Readonly<{ resource: ResourcePresentation; onRefresh: () => void }>;
  attentionShownAbove: boolean;
  onManage: () => void;
  t: Translate;
}>): React.ReactElement {
  const retest = useConnectionRetest({
    connection: props.connection,
    resource: props.connectionTest.resource,
    onRefresh: props.connectionTest.onRefresh,
    t: props.t,
  });
  return (
    <>
      <ConversationBotGroup
        connection={props.connection}
        attentionShownAbove={props.attentionShownAbove}
        onManage={props.onManage}
        t={props.t}
        {...(retest.retestable ? {
          test: (
            <Button
              testID="channels-page-bot-test"
              variant="secondary"
              title={retest.busy
                ? props.t('plugins.channels.surface.connectionRetesting', 'Testing connection…')
                : props.t('plugins.channels.page.test', 'Test')}
              accessibilityLabel={props.t('plugins.channels.surface.connectionRetest', 'Test connection')}
              busy={retest.busy}
              disabled={retest.busy || retest.outcomeUnknown}
              onPress={retest.retest}
            />
          ),
        } : {})}
      />
      {retest.retestable ? retest.feedback : null}
    </>
  );
}

function ConversationBotGroup(props: Readonly<{
  connection?: ChannelsConnection;
  attentionShownAbove: boolean;
  test?: React.ReactElement;
  onManage: () => void;
  t: Translate;
}>): React.ReactElement {
  const { connection, t } = props;
  const status = connection === undefined ? undefined : connectionStatus(connection, t);
  const needsYou = status !== undefined && channelsStatusNeedsYou(status.tone);
  // The page's banner is the one place a bot problem speaks, with its next action. While it shows,
  // this row states facts only: which bot, and where it is assigned.
  const factsOnly = needsYou && props.attentionShownAbove;
  return (
    <ItemGroup testID="channels-page-bot" title={t('plugins.channels.page.bot', 'Bot')}>
      <Item
        title={connection === undefined
          ? t('plugins.channels.surface.bindingConnectionUnavailable', 'Connection details are unavailable')
          : connectionLabel(connection)}
        {...(connection === undefined || status === undefined ? {} : {
          subtitle: factsOnly
            ? t('plugins.channels.surface.machinePlacementPausedAssigned', 'Assigned to your selected machine')
            : `${status.label} · ${connectionMachinePlacementLabel(connection, t)}`,
        })}
        {...(needsYou && !factsOnly && status !== undefined ? { tone: status.tone } : {})}
        {...(connection === undefined ? {} : {
          icon: <BrandMark pluginId={connection.providerPluginId} size="small" externallyLabelled />,
        })}
        {...(props.test === undefined ? {} : { accessory: props.test, accessoryOutsidePressable: true })}
      />
      <Item
        testID="channels-page-manage-bot"
        title={t('plugins.channels.page.manageBot', 'Manage bot')}
        subtitle={t('plugins.channels.page.manageBotDescription', 'Credential, machine, transfer and delete, in Settings.')}
        onPress={props.onManage}
      />
    </ItemGroup>
  );
}

/**
 * The page with nothing linked yet: no bot at all (lab E1), or a bot and no
 * conversation (lab E2). Each says what Channels is for and offers the one
 * next step.
 */
/** "sales, questions and brief" in the reader's locale. */
function formatConjunction(names: readonly string[]): string {
  try {
    return new Intl.ListFormat(undefined, { type: 'conjunction', style: 'long' }).format(names);
  } catch {
    return names.join(', ');
  }
}

/** "Telegram, Discord or Email" in the reader's locale. */
function formatProviderNameList(names: readonly string[]): string {
  try {
    return new Intl.ListFormat(undefined, { type: 'disjunction', style: 'long' }).format(names);
  } catch {
    return names.join(', ');
  }
}

/**
 * The names of the conversation providers installed for this surface, so
 * invitations never name a fixed list and a new provider (email) is never left out.
 */
function useInstalledProviderNames(): readonly string[] {
  const surface = useSurfaceContext();
  const resolveProviderName = useConversationProviderDisplayNameResolver();
  return React.useMemo(() => {
    const contributions = surface.targetedContributions;
    const operations = contributions === undefined
      ? []
      : currentProviderSetupOperations(contributions, contributions.target.pluginId);
    const names = [...new Set(operations.map((operation) => operation.contributor.pluginId))]
      .map((pluginId) => resolveProviderName(pluginId))
      .filter((name): name is string => typeof name === 'string' && name.trim() !== '');
    return [...new Set(names)];
  }, [resolveProviderName, surface.targetedContributions]);
}

function ConversationsEmptyPage(props: Readonly<{
  connections: readonly ChannelsConnection[];
  onConnectBot: () => void;
  onLink: () => void;
  t: Translate;
}>): React.ReactElement {
  const { t } = props;
  const providerNames = useInstalledProviderNames();
  const bots = props.connections.filter((connection) => connection.deletionState === 'none');
  if (bots.length === 0) {
    return (
      <EmptyState
        testID="channels-page-no-bots"
        layout="page"
        icon="conversations"
        title={providerNames.length === 0
          ? t('plugins.channels.page.noBotsTitleGeneric', 'Talk to your sessions from the apps your team already uses')
          : t('plugins.channels.page.noBotsTitleProviders', 'Talk to your sessions from {providers}', {
            providers: formatProviderNameList(providerNames),
          })}
        description={t(
          'plugins.channels.page.noBotsLinkDescription',
          'Link a chat, a mailbox, a channel or an issue to a session. People there can ask the agent for help and get its replies, without installing Happier.',
        )}
        action={(
          <Button
            testID="channels-page-connect-bot"
            variant="primary"
            title={t('plugins.channels.page.connectBot', 'Connect a bot')}
            onPress={props.onConnectBot}
          />
        )}
      />
    );
  }
  return (
    <Stack gap="large" testID="channels-page-no-conversations">
      <EmptyState
        layout="page"
        icon="conversations"
        title={t('plugins.channels.page.noConversationsTitle', 'Link a conversation to a session')}
        description={bots.length === 1
          ? t('plugins.channels.page.noConversationsOneBot', '{bot} is connected. Choose a chat and the session it should talk to.', {
            bot: connectionLabel(bots[0]!),
          })
          : t('plugins.channels.page.noConversationsDescription', 'Your bots are connected. Choose a chat and the session it should talk to.')}
        action={(
          <Button
            testID="channels-page-link"
            variant="primary"
            title={t('plugins.channels.column.link', 'Link a conversation')}
            onPress={props.onLink}
          />
        )}
      />
      <Stack gap="small">
        <Step marker={{ kind: 'number', value: 1 }} title={t('plugins.channels.page.linkStepConversation', 'Choose the conversation and who may talk in it.')} />
        {/* A pairing code is not a step every provider has: the link journey asks for one only when the
            provider requires it (a mailbox already knows who wrote), so the overview never promises it. */}
        <Step marker={{ kind: 'number', value: 2 }} title={t('plugins.channels.page.linkStepTarget', 'Choose the session, review, and turn it on.')} />
      </Stack>
    </Stack>
  );
}

/**
 * The page's own list of conversations — what a phone shows at the page root,
 * where no column stands beside the page. It reads the same index the column
 * reads.
 */
function ConversationsIndexPage(props: Readonly<{
  presentations: readonly BindingPresentation[];
  connections: readonly ChannelsConnection[];
  onOpen: (bindingId: string) => void;
  onLink?: () => void;
  t: Translate;
}>): React.ReactElement {
  const { t } = props;
  const resolveProviderName = useConversationProviderDisplayNameResolver();
  const providerName = React.useCallback(
    (providerPluginId: string) => resolveProviderName(providerPluginId)
      ?? t('plugins.channels.surface.providerFallback', 'Integration provider'),
    [resolveProviderName, t],
  );
  const bindings = React.useMemo(
    () => props.presentations.map((presentation) => presentation.binding),
    [props.presentations],
  );
  const sessionStates = useConversationSessionStates(bindings);
  const { locale } = useSurfaceContext();
  const groups = React.useMemo(() => buildChannelsConversationIndex({
    bindings,
    connections: props.connections,
    providerName,
    t,
    sessionStates,
  }), [bindings, props.connections, providerName, sessionStates, t]);
  return (
    <Stack gap="large" testID="channels-page-index">
      <PageHeader
        title={t('plugins.channels.page.title', 'Channels')}
        description={t('plugins.channels.page.description', 'Chats, mailboxes and issues that talk to your sessions.')}
        {...(props.onLink === undefined ? {} : {
          actions: (
            <Button
              testID="channels-page-link"
              variant="secondary"
              title={t('plugins.channels.column.link', 'Link a conversation')}
              onPress={props.onLink}
            />
          ),
        })}
      />
      {groups.map((group) => (
        <ItemGroup
          key={group.key}
          title={group.connection !== undefined
            ? connectionLabel(group.connection)
            : group.providerPluginId !== undefined
              ? providerName(group.providerPluginId)
              : t('plugins.channels.column.otherGroup', 'Other conversations')}
          {...(group.botAttention === undefined ? {} : { description: group.botAttention.label })}
        >
          {group.rows.map((row) => {
            const line = conversationIndexRowLine(row, locale, t);
            return (
              <Item
                key={row.binding.bindingId}
                testID={`channels-page-row-${row.binding.bindingId}`}
                title={row.title}
                titleNumberOfLines={1}
                subtitle={line.subtitle}
                subtitleNumberOfLines={1}
                {...(line.detail === undefined ? {} : { detail: line.detail })}
                {...(line.detailTone === undefined ? {} : { detailTone: line.detailTone })}
                accessibilityLabel={line.accessibilityLabel}
                {...(row.connection === undefined ? {} : {
                  icon: <BrandMark pluginId={row.connection.providerPluginId} size="small" externallyLabelled />,
                })}
                onPress={() => props.onOpen(row.binding.bindingId)}
              />
            );
          })}
        </ItemGroup>
      ))}
    </Stack>
  );
}

/**
 * A conversation row's second line and trailing column. The second line is the
 * Session's latest shareable reply when the host read one (or its explicit empty
 * and hidden answers), otherwise what the conversation talks to. The trailing
 * column speaks one fact: a paused or deleting binding, else Work that needs the
 * reader, else the reply's own time, in the accent tone while it is unread.
 * Opening the page never marks anything read.
 */
function conversationIndexRowLine(
  row: ChannelsConversationIndexRow,
  locale: string,
  t: Translate,
): Readonly<{ subtitle: string; detail?: string; detailTone?: 'attention' | 'danger' | 'accent'; accessibilityLabel: string }> {
  const activity = channelsConversationActivity(row.session);
  const preview = activity?.preview;
  const subtitle = preview?.kind === 'ready'
    ? preview.text
    : preview?.kind === 'empty'
      ? t('plugins.channels.page.activityEmpty', 'No replies yet')
      : preview?.kind === 'hidden'
        ? t('plugins.channels.page.activityHidden', 'Preview hidden')
        : bindingTargetKindLabel(row.binding.target.kind, t);
  const status = conversationRowTrailing({
    paused: row.status?.kind === 'paused',
    deleting: row.status?.kind === 'deleting',
    activity,
    locale,
    t,
  });
  const accessibilityLabel = [
    row.title,
    subtitle,
    ...(activity?.unread === true ? [t('plugins.channels.page.activityUnread', 'Unread')] : []),
    ...(status.detail === undefined ? [] : [status.detail]),
  ].join(', ');
  return { subtitle, ...status, accessibilityLabel };
}

/**
 * The one fact a conversation row's trailing column speaks, for the page index and a router's thread
 * rows alike: a paused or deleting binding, else Work that needs the reader, else the latest reply's
 * own time, in the accent tone while it is unread.
 */
function conversationRowTrailing(input: Readonly<{
  paused: boolean;
  deleting: boolean;
  activity: ChannelsConversationActivity | undefined;
  locale: string;
  t: Translate;
}>): Readonly<{ detail?: string; detailTone?: 'attention' | 'danger' | 'accent' }> {
  const { activity, t } = input;
  if (input.deleting) return { detail: t('plugins.channels.surface.deleteFinalizing', 'Deletion cleanup in progress') };
  if (input.paused) return { detail: t('plugins.channels.column.paused', 'Paused') };
  if (activity?.work !== undefined) {
    return { detail: activity.work.word, ...(activity.work.tone === 'neutral' ? {} : { detailTone: activity.work.tone }) };
  }
  const preview = activity?.preview;
  if (preview?.kind !== 'ready') return {};
  return {
    detail: formatConversationTime(preview.createdAt, input.locale),
    ...(activity?.unread === true ? { detailTone: 'accent' as const } : {}),
  };
}

function bindingPresentationKey(presentation: BindingPresentation): string {
  return presentation.binding.bindingId;
}

type BindingCreateResolveResult = ReturnType<typeof ConversationBindingResolveResultV1Schema.parse>;
type BindingCreateEndpointCandidate = Extract<
  BindingCreateResolveResult,
  Readonly<{ kind: 'endpointCandidates' }>
>['candidates'][number];
type BindingCreatePrincipalCandidate = Extract<
  BindingCreateResolveResult,
  Readonly<{ kind: 'principalCandidates' }>
>['candidates'][number];
type BindingCreateEndpointSelection = Extract<
  ReturnType<typeof ConversationBindingResolveInputV1Schema.parse>,
  Readonly<{ kind: 'principal' }>
>['endpointSelection'];
type BindingCreatePrincipalSelection = ReturnType<
  typeof ConversationBindingCreateInputV1Schema.parse
>['principalSelection'];
/**
 * Nonsecret Automation execution consequences projected by the canonical
 * `automation.conversation.targets.list` owner. Parsed at this boundary like
 * every other Action result the surface consumes; the Automation owner remains
 * the only authority over these facts.
 */
type BindingCreateAutomationExecution = Readonly<{
  targetType: 'new_session' | 'existing_session' | 'execution_run' | null;
  enabled: boolean;
}>;
type BindingCreateStage = 'closed' | 'endpoint' | 'principal' | 'target' | 'policies' | 'review';
type BindingCreateTarget =
  | Readonly<{ kind: 'session'; sessionId: string; label: string }>
  | Readonly<{ kind: 'threadRouter'; label: string }>
  | Readonly<{
    kind: 'automation';
    automationId: string;
    label: string;
    execution: BindingCreateAutomationExecution;
  }>;
type BindingCreateAutomationCandidate = Readonly<{
  automationId: string;
  label: string;
  execution: BindingCreateAutomationExecution;
}>;
type BindingCreateAutomationPage = Readonly<{
  candidates: readonly BindingCreateAutomationCandidate[];
  nextCursor?: string;
}>;
type BindingCreatePairingContext = Readonly<{
  generationId: string;
  challengeId: string;
  expiresAt: number;
}>;
type BindingCreateProofThread = Readonly<{
  selection: BindingCreateEndpointSelection;
  candidate: BindingCreateEndpointCandidate;
}>;
type BindingCreatePairingRequest = Readonly<{
  connectionId: string;
  expectedConnectionRevision: number;
  pairingRequestId: string;
}>;
type BindingCreateFeedback =
  | 'resolverUnavailable'
  | 'resolverStale'
  | 'resolverNotReady'
  | 'resolverRefused'
  | 'sessionUnavailable'
  | 'automationUnavailable'
  | 'newSessionUnavailable'
  | 'targetNotVerified'
  | 'targetResultDeliveryUnavailable'
  | 'createUnavailable'
  | 'pairingUnavailable'
  | 'pairingRouterBootstrapInvalid'
  | 'pairingProofMismatch'
  | 'pairingProofUnavailable'
  | 'created';

/** What a provider's not-ready resolver answer means for the person searching. */
type ResolverRefusal = Readonly<{ reason: ConversationProviderFailureV1['reason']; diagnostic?: string }>;

/**
 * Only an unreachable or rate-limited provider is worth waiting for. Every other not-ready reason is the
 * provider refusing this search (an address it can't look up, a setup it rejects), so the page says why,
 * in the provider's own words when it gave them, instead of asking the person to wait.
 */
function resolverRefusalOf(failure: ConversationProviderFailureV1): ResolverRefusal | undefined {
  if (failure.reason === 'network' || failure.reason === 'rateLimited') return undefined;
  return failure.diagnostic === undefined
    ? { reason: failure.reason }
    : { reason: failure.reason, diagnostic: failure.diagnostic };
}

function resolverRefusalCopy(refusal: ResolverRefusal, t: Translate): readonly [string, string] {
  if (refusal.reason === 'unsupported') {
    return [
      t('plugins.channels.surface.resolverUnsupportedTitle', 'Search for it another way'),
      refusal.diagnostic ?? t(
        'plugins.channels.surface.resolverUnsupportedDescription',
        'The provider can’t look up this kind of address. Enter it the way the provider names it.',
      ),
    ];
  }
  return [
    t('plugins.channels.surface.resolverRefusedTitle', 'The provider refused this search'),
    refusal.diagnostic ?? providerFailureReasonDescription(refusal.reason, t),
  ];
}

/** The pairing writer's typed refusals each name their own repair. */
function pairingCreateRefusalFeedback(code: string | undefined): BindingCreateFeedback {
  switch (code) {
    case 'channels_pairing_router_bootstrap_invalid':
      return 'pairingRouterBootstrapInvalid';
    case 'channels_pairing_proof_endpoint_mismatch':
      return 'pairingProofMismatch';
    case 'channels_pairing_proof_endpoint_unavailable':
      return 'pairingProofUnavailable';
    default:
      return 'createUnavailable';
  }
}

function bindingTargetVerificationFeedback(
  reason: string,
): 'targetNotVerified' | 'targetResultDeliveryUnavailable' {
  return reason === 'resultDeliveryUnsupported'
    ? 'targetResultDeliveryUnavailable'
    : 'targetNotVerified';
}

type BindingEditorDetail = Extract<
  ReturnType<typeof ConversationBindingReadResultV1Schema.parse>,
  Readonly<{ kind: 'ready' }>
>;
type BindingEditorStage = 'policies' | 'endpoint' | 'principal' | 'target' | 'review';
type BindingEditorAudienceResolution = 'none' | 'endpoint' | 'principal';
type BindingEditorFeedback =
  | 'readUnavailable'
  | 'notFound'
  | 'resolverUnavailable'
  | 'resolverStale'
  | 'resolverNotReady'
  | 'resolverRefused'
  | 'sessionUnavailable'
  | 'automationUnavailable'
  | 'newSessionUnavailable'
  | 'targetNotVerified'
  | 'targetResultDeliveryUnavailable'
  | 'updateUnavailable'
  | 'quotaIncompatible'
  | 'updated';
type BindingEditorAudienceSelection = Readonly<{
  expectedConnectionRevision: number;
  endpointSelection: BindingCreateEndpointSelection;
  principalSelection: BindingCreatePrincipalSelection;
}>;
type BindingEditorPrincipalCandidate = Readonly<{
  id: string;
  label?: string;
  kind: 'human' | 'bot';
}>;
type BindingEditorSessionTarget = Readonly<{
  kind: 'session';
  sessionId: string;
  policy: Readonly<{
    deliveryMode: 'repliesOnly' | 'mirrorSession';
    // The public Agent permission-intent vocabulary owns both editor drafts.
    permissionCeiling: AgentPermissionIntentV1;
    approvals: Readonly<
      | { kind: 'off' }
      | { kind: 'enabled'; maximumScope: 'request' | 'session'; principalIds?: readonly string[] }
    >;
    newSession: Readonly<
      | { kind: 'off' }
      | { kind: 'enabled'; principalIds?: readonly string[]; recipe: unknown }
    >;
  }>;
}>;
type BindingEditorAutomationTarget = Readonly<{
  kind: 'automation';
  automationId: string;
  policy: Readonly<{ resultDelivery: 'finalResult' | 'none' }>;
}>;
/** The router arm is edited whole: its groups and ordered routes are one precedence contract. */
type BindingEditorThreadRouterTarget = ConversationThreadRouterBindingTargetV1;
type BindingEditorDiscussionTarget = Extract<ConversationBindingTargetV1, Readonly<{ kind: 'discussion' }>>;
type BindingEditorTarget = BindingEditorSessionTarget | BindingEditorAutomationTarget | BindingEditorThreadRouterTarget | BindingEditorDiscussionTarget;
type BindingEditorDraft = Readonly<{
  target: BindingEditorTarget;
  targetChanged: boolean;
  /**
   * Turning approvals off is a temporary editor choice, not an instruction to
   * replace a named approval audience with every admitted principal when the
   * owner enables it again.
   */
  retainedApprovalPrincipalIds?: readonly string[];
  audienceSelection?: BindingEditorAudienceSelection;
  endpointLabel: string;
  allowedPrincipalIds: readonly string[];
  allowBotSenders: boolean;
  inputMode: BindingInputMode;
  inboundDebounceMs: string;
  linkPreviewPolicy: 'suppress' | 'providerDefault';
  senderFeedback: 'off' | 'eligibleRefusals';
  enabled: boolean;
}>;

function bindingEditorTargetFromBinding(binding: ConversationBindingV1): BindingEditorTarget {
  if (binding.target.kind === 'session') {
    return {
      kind: 'session',
      sessionId: binding.target.sessionId,
      policy: {
        deliveryMode: binding.target.policy.deliveryMode,
        permissionCeiling: binding.target.policy.permissionCeiling,
        approvals: binding.target.policy.approvals,
        newSession: binding.target.policy.newSession,
      },
    };
  }
  if (binding.target.kind === 'threadRouter' || binding.target.kind === 'discussion') return binding.target;
  return {
    kind: 'automation',
    automationId: binding.target.automationId,
    policy: binding.target.policy,
  };
}

/**
 * Both binding editors show the destination, admitted principals, execution
 * machine, permission scope and consequence. Action policy owns approval.
 */
function BindingEditConfirmationSummary(props: Readonly<{
  draft: BindingEditorDraft;
  connection: ChannelsConnection | undefined;
  t: Translate;
}>): React.ReactElement {
  const { draft, t } = props;
  const summarizeRecipe = useRouterRecipeSummary(t);
  return (
    <Stack gap="medium">
      <Metadata
        title={t('plugins.channels.surface.bindingEditSummary', 'Binding change summary')}
        entries={[
          { label: t('plugins.channels.surface.bindingCreateConversation', 'Conversation'), value: draft.endpointLabel },
          { label: t('plugins.channels.surface.bindingCreateAllowedSender', 'Allowed senders'), value: draft.allowedPrincipalIds.join(', ') },
          { label: t('plugins.channels.surface.bindingCreateTarget', 'Target'), value: bindingEditorTargetLabel(draft.target, t) },
          ...(draft.target.kind === 'session' ? [
            {
              label: t('plugins.channels.surface.bindingCreateDeliveryMode', 'Session delivery'),
              value: bindingDeliveryModeLabel(draft.target.policy.deliveryMode, t),
            },
            {
              label: t('plugins.channels.surface.bindingCreatePermissionCeiling', 'Permission ceiling'),
              value: bindingPermissionIntentLabel(draft.target.policy.permissionCeiling, t),
            },
          ] : draft.target.kind === 'discussion' ? [
            {
              label: t('plugins.channels.surface.bindingDiscussionDelivery', 'Discussion delivery'),
              value: bindingDeliveryModeLabel(draft.target.policy.deliveryMode, t),
            },
          ] : draft.target.kind === 'automation' ? [
            {
              label: t('plugins.channels.surface.bindingEditResultDelivery', 'Result delivery'),
              value: bindingDeliveryModeLabel(draft.target.policy.resultDelivery, t),
            },
          ] : [
            ...draft.target.principalGroups.map((group) => ({
              label: t('plugins.channels.surface.routerGroupSummaryLabel', 'Group {group}', { group: group.id }),
              value: group.principalIds.join(', '),
            })),
            ...draft.target.routes.map((route, index) => ({
              label: t('plugins.channels.surface.routerRouteSummaryLabel', 'Route {position}', { position: index + 1 }),
              value: routerRouteSummary(route, t, summarizeRecipe),
            })),
          ]),
          ...(draft.target.kind === 'session' ? [{
            label: t('plugins.channels.surface.bindingCreateApprovals', 'Approvals'),
            value: bindingApprovalAudienceLabel(draft.target, t),
          }] : []),
          {
            label: t('plugins.channels.surface.bindingCreateInputMode', 'Incoming messages'),
            value: bindingInputModeLabel(draft.inputMode, t),
          },
          { label: t('plugins.channels.surface.bindingEditDebounce', 'Message grouping delay'), value: draft.inboundDebounceMs },
          {
            label: t('plugins.channels.surface.bindingCreateLinkPreview', 'Link previews'),
            value: bindingCreateLinkPreviewPolicyLabel(draft.linkPreviewPolicy, t),
          },
          {
            label: t('plugins.channels.surface.bindingCreateSenderFeedback', 'Sender feedback'),
            value: bindingCreateSenderFeedbackLabel(draft.senderFeedback, t),
          },
          { label: t('plugins.channels.surface.bindingEditEnabled', 'Enable this binding'), value: bindingEnabledLabel(draft.enabled, t) },
        ]}
      />
      <Metadata
        title={t('plugins.channels.surface.technicalDetails', 'Technical details')}
        entries={[
          {
            label: t('plugins.channels.surface.selectedMachineId', 'Selected machine ID'),
            value: props.connection?.selectedMachineId
              ?? t('plugins.channels.surface.bindingCreateConnectionUnavailable', 'Connection unavailable'),
          },
        ]}
      />
    </Stack>
  );
}

/**
 * The one owner of the host round trip that turns "configure a new Session"
 * into a concrete spawn recipe. Every binding surface that offers the policy —
 * create, the daemon-backed editor, and the cold-offline editor — consumes this
 * instead of repeating the availability probe, in-flight fence, and failure
 * classification. It reaches only the host projection, never a provider.
 */
function useBindingNewSessionRecipeSelection(input: Readonly<{
  signal: AbortSignal;
  draft?: () => SelectActionInputRequest['draft'];
  /**
   * Read at press time, not at declaration time, so the one owner can sit above
   * the caller's own `actionLocked` computation while still refusing to start
   * while any other in-flight action holds the surface.
   */
  isLocked: () => boolean;
  onSelected: (draft: Extract<SelectActionInputResult, Readonly<{ kind: 'serverStartDraft' }>>['draft']) => void;
  onUnavailable: () => void;
  onStarted?: () => void;
}>): Readonly<{ available: boolean; pending: boolean; select: () => void }> {
  const hostApi = usePluginHostApi();
  const [pending, setPending] = React.useState(false);
  const inFlightRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const callbacksRef = React.useRef(input);
  callbacksRef.current = input;

  const select = React.useCallback(() => {
    const current = callbacksRef.current;
    if (current.isLocked() || current.signal.aborted || inFlightRef.current) return;
    if (!hostApi.version().methods.includes('selectActionInput')) {
      current.onUnavailable();
      return;
    }
    inFlightRef.current = true;
    setPending(true);
    current.onStarted?.();
    void (async () => {
      try {
        const draft = current.draft?.();
        const selected = await hostApi.selectActionInput({
          hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
          ...(draft === undefined ? {} : { draft }),
        }, { signal: current.signal });
        if (!mountedRef.current || current.signal.aborted || selected.kind === 'cancelled') return;
        if (selected.kind !== 'serverStartDraft') {
          callbacksRef.current.onUnavailable();
          return;
        }
        callbacksRef.current.onSelected(selected.draft);
      } catch {
        if (mountedRef.current && !current.signal.aborted) callbacksRef.current.onUnavailable();
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current && !current.signal.aborted) setPending(false);
      }
    })();
  }, [hostApi]);

  // The host installs `selectActionInput` only while its daemon-owned selection
  // path is actually available, so the FACTUAL installed set is the truthful
  // pre-press signal. Reading it here keeps one owner for both the offer and
  // the press; the surface does not build a local Session form or catalog.
  const available = hostApi.version().methods.includes('selectActionInput');

  return { available, pending, select };
}

/**
 * The Session-target policy an Account can decide on its own. It is one
 * component because the daemon-backed editor and the cold-offline editor offer
 * exactly the same set: `management.ts` returns a Session target from its
 * persistence resolver unchanged, so nothing here needs a reachable machine.
 */
function BindingSessionTargetPolicyRows(props: Readonly<{
  target: BindingEditorSessionTarget;
  admittedPrincipalIds: readonly string[];
  retainedApprovalPrincipalIds?: readonly string[];
  disabled: boolean;
  /** Whether the host can currently run its own new-Session selection. */
  configureNewSessionAvailable: boolean;
  onChange: (transform: (target: BindingEditorSessionTarget) => BindingEditorSessionTarget) => void;
  onRetainApprovalPrincipalIds: (principalIds: readonly string[] | undefined) => void;
  onConfigureNewSession: () => void;
  /** `whenEnabled` shows the /new row only while a retained grant can be turned off. */
  newSessionRow?: 'always' | 'whenEnabled';
  t: Translate;
}>): React.ReactElement {
  const approvalPrincipalIds = props.target.policy.approvals.kind === 'enabled'
    ? props.target.policy.approvals.principalIds
    : undefined;
  const deliveryLabel = props.t('plugins.channels.surface.bindingCreateDeliveryMode', 'Session delivery');
  const ceilingLabel = props.t('plugins.channels.surface.bindingCreatePermissionCeiling', 'Permission ceiling');
  const approvalsLabel = props.t('plugins.channels.surface.bindingCreateApprovals', 'Approvals');
  const scopeLabel = props.t('plugins.channels.surface.bindingCreateApprovalsScope', 'Maximum approval scope');
  const audienceLabel = props.t('plugins.channels.surface.bindingCreateApprovalsAudience', 'Approval audience');
  const newSessionLabel = props.t('plugins.channels.surface.bindingCreateNewSessionCommand', 'Allow /new');
  // One decision per row: a switch or a short segmented choice beside its
  // name, the five-way ceiling as a field. The rows join their owner's sheet
  // (the binding's own section, or the route that starts the Session).
  return (
    <>
      <Item title={deliveryLabel} accessoryWraps accessoryOutsidePressable accessory={(
      <Form.Select
        testID="channels-binding-target-delivery-mode"
        presentation="segmented"
        label={deliveryLabel}
        options={[
          { value: 'repliesOnly', label: props.t('plugins.channels.surface.bindingCreateRepliesOnly', 'Replies only') },
          { value: 'mirrorSession', label: props.t('plugins.channels.surface.bindingCreateMirrorSession', 'Mirror Session') },
        ]}
        value={props.target.policy.deliveryMode}
        disabled={props.disabled}
        onChange={(deliveryMode) => {
          if (deliveryMode !== 'repliesOnly' && deliveryMode !== 'mirrorSession') return;
          props.onChange((target) => ({
            ...target,
            policy: { ...target.policy, deliveryMode },
          }));
        }}
      />
      )} />
      <Item title={ceilingLabel} fieldAccessory accessoryOutsidePressable accessory={(
      <Form.Select
        testID="channels-binding-target-permission-ceiling"
        presentation="field"
        label={ceilingLabel}
        options={bindingPermissionIntentOptions(props.t)}
        value={props.target.policy.permissionCeiling}
        disabled={props.disabled}
        onChange={(value) => {
          const permissionCeiling = parseBindingPermissionIntent(value);
          if (permissionCeiling === null) return;
          props.onChange((target) => ({
            ...target,
            policy: { ...target.policy, permissionCeiling },
          }));
        }}
      />
      )} />
      <Item title={approvalsLabel} accessoryOutsidePressable accessory={(
      <Form.Toggle
        testID="channels-binding-target-approvals"
        label={approvalsLabel}
        value={props.target.policy.approvals.kind === 'enabled'}
        // Creating through the pairing fallback has no resolver-authenticated
        // admitted principal yet. Do not manufacture an "all" approval
        // audience from that absence.
        disabled={props.disabled || props.admittedPrincipalIds.length === 0}
        onChange={(enabled) => {
          const retainedPrincipalIds = props.target.policy.approvals.kind === 'enabled'
            ? props.target.policy.approvals.principalIds
            : props.retainedApprovalPrincipalIds;
          if (!enabled) props.onRetainApprovalPrincipalIds(retainedPrincipalIds);
          props.onChange((target) => ({
            ...target,
            policy: {
              ...target.policy,
              // Turning approvals on defaults to the narrower request scope;
              // Session scope stays an explicit second choice below. A named
              // audience remains named until its owner explicitly chooses all.
              approvals: enabled
                ? {
                  kind: 'enabled',
                  maximumScope: 'request',
                  ...(retainedPrincipalIds === undefined ? {} : { principalIds: retainedPrincipalIds }),
                }
                : { kind: 'off' },
            },
          }));
        }}
      />
      )} />
      {props.target.policy.approvals.kind === 'enabled'
        ? (
          <>
            <Item title={scopeLabel} accessoryWraps accessoryOutsidePressable accessory={(
            <Form.Select
              testID="channels-binding-target-approvals-scope"
              presentation="segmented"
              label={scopeLabel}
              options={[
                {
                  value: 'request',
                  label: props.t('plugins.channels.surface.bindingCreateApprovalsScopeRequest', 'This request'),
                },
                {
                  value: 'session',
                  label: props.t('plugins.channels.surface.bindingCreateApprovalsScopeSession', 'This Session'),
                },
              ]}
              value={props.target.policy.approvals.maximumScope}
              disabled={props.disabled}
              onChange={(maximumScope) => {
                if (maximumScope !== 'request' && maximumScope !== 'session') return;
                props.onChange((target) => ({
                  ...target,
                  policy: {
                    ...target.policy,
                    approvals: { ...target.policy.approvals, kind: 'enabled', maximumScope },
                  },
                }));
              }}
            />
            )} />
            <Item title={audienceLabel} accessoryWraps accessoryOutsidePressable accessory={(
            <Form.Select
              testID="channels-binding-target-approvals-audience"
              presentation="segmented"
              label={audienceLabel}
              options={[
                {
                  value: 'all',
                  label: props.t('plugins.channels.surface.bindingCreateApprovalsAudienceAll', 'All admitted principals'),
                },
                {
                  value: 'selected',
                  label: props.t('plugins.channels.surface.bindingCreateApprovalsAudienceSelected', 'Selected admitted principals'),
                },
              ]}
              value={props.target.policy.approvals.principalIds === undefined ? 'all' : 'selected'}
              disabled={props.disabled || props.admittedPrincipalIds.length === 0}
              onChange={(audience) => {
                if (audience === 'all') {
                  props.onRetainApprovalPrincipalIds(undefined);
                  props.onChange((target) => ({
                    ...target,
                    policy: {
                      ...target.policy,
                      approvals: {
                        kind: 'enabled',
                        maximumScope: target.policy.approvals.kind === 'enabled'
                          ? target.policy.approvals.maximumScope
                          : 'request',
                      },
                    },
                  }));
                  return;
                }
                if (audience !== 'selected') return;
                props.onChange((target) => ({
                  ...target,
                  policy: {
                    ...target.policy,
                    approvals: {
                      kind: 'enabled',
                      maximumScope: target.policy.approvals.kind === 'enabled'
                        ? target.policy.approvals.maximumScope
                        : 'request',
                      // The only available candidates are already admitted
                      // by this binding's authoritative audience.
                      principalIds: target.policy.approvals.kind === 'enabled'
                        && target.policy.approvals.principalIds !== undefined
                        ? target.policy.approvals.principalIds
                        : props.admittedPrincipalIds,
                    },
                  },
                }));
              }}
            />
            )} />
            {approvalPrincipalIds === undefined ? null : (
              <>
                {props.admittedPrincipalIds.map((principalId) => {
                  const selected = approvalPrincipalIds.includes(principalId);
                  const selectedCount = approvalPrincipalIds.length;
                  return (
                    <Item key={principalId} title={principalId} accessoryOutsidePressable accessory={(
                    <Form.Toggle
                      testID={`channels-binding-target-approvals-principal:${principalId}`}
                      label={principalId}
                      value={selected}
                      disabled={props.disabled || (selected && selectedCount <= 1)}
                      onChange={(nextSelected) => {
                        props.onChange((target) => {
                          if (target.policy.approvals.kind !== 'enabled'
                            || target.policy.approvals.principalIds === undefined) return target;
                          const principalIds = nextSelected
                            ? target.policy.approvals.principalIds.includes(principalId)
                              ? target.policy.approvals.principalIds
                              : [...target.policy.approvals.principalIds, principalId]
                            : target.policy.approvals.principalIds.filter((id) => id !== principalId);
                          return {
                            ...target,
                            policy: {
                              ...target.policy,
                              approvals: { ...target.policy.approvals, principalIds },
                            },
                          };
                        });
                      }}
                    />
                    )} />
                  );
                })}
              </>
            )}
          </>
        )
        : null}
      {/* A route's Session is configured by the route's own recipe, so a
          route offers only turning a retained /new grant off. */}
      {props.newSessionRow === 'whenEnabled' && props.target.policy.newSession.kind !== 'enabled' ? null : (
      <Item
        title={newSessionLabel}
        subtitle={props.t(
          'plugins.channels.surface.bindingCreateNewSessionCommandDescription',
          'Senders can start a fresh session by sending /new. You choose its recipe.',
        )}
        accessoryOutsidePressable
        accessory={(
      <Form.Toggle
        testID="channels-binding-target-configure-new-session"
        label={newSessionLabel}
        value={props.target.policy.newSession.kind === 'enabled'}
        // Turning an already-enabled recipe OFF is an Account-local policy edit
        // that needs nothing from the host, so only the ENABLE direction waits
        // on the host's own new-Session selection being available. Offering it
        // otherwise presents a control whose press can only report failure.
        disabled={props.disabled
          || (!props.configureNewSessionAvailable && props.target.policy.newSession.kind !== 'enabled')}
        onChange={(enabled) => {
          if (!enabled) {
            props.onChange((target) => ({
              ...target,
              policy: { ...target.policy, newSession: { kind: 'off' } },
            }));
            return;
          }
          props.onConfigureNewSession();
        }}
      />
      )} />
      )}
    </>
  );
}

function BindingSessionTargetPolicyControls(
  props: React.ComponentProps<typeof BindingSessionTargetPolicyRows>,
): React.ReactElement {
  return (
    <ItemGroup
      testID="channels-binding-target-policy"
      title={props.t('plugins.channels.surface.bindingEditTargetPolicy', 'Session target policy')}
    >
      <BindingSessionTargetPolicyRows {...props} />
    </ItemGroup>
  );
}

type ThreadRouterRoute = BindingEditorThreadRouterTarget['routes'][number];
type ThreadRouterPrincipalGroup = ConversationThreadRouterBindingTargetV1['principalGroups'][number];

type RecipeAgentNameResolver = (pluginId: string) => string | undefined;

function readRecipeRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

/**
 * A route's recipe as the reader names it: its Agent, model, folder and tool
 * confinement. It reads the Session spawn recipe (`agentTarget`,
 * `modelSelection`, `directory`) the Session owner validates, never ids.
 */
function routerRecipeSummary(recipe: unknown, t: Translate, resolveAgentName: RecipeAgentNameResolver): string {
  const record = readRecipeRecord(recipe);
  if (record === undefined) {
    return t('plugins.channels.surface.routerRecipeCustom', 'Custom session recipe');
  }
  const agentPluginId = readRecipeRecord(readRecipeRecord(record.agentTarget)?.identity)?.pluginId;
  const agent = typeof agentPluginId === 'string' ? resolveAgentName(agentPluginId) : undefined;
  const modelId = readRecipeRecord(readRecipeRecord(record.modelSelection)?.ref)?.modelId;
  const directory = readRecipeRecord(record.directory);
  const folder = directory?.kind === 'path' && typeof directory.path === 'string'
    ? directory.path.split(/[\\/]/).filter((part) => part !== '').pop()
    : undefined;
  const allowedTools = Array.isArray(record.allowedTools)
    ? record.allowedTools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  const tools = record.unlistedTools !== 'deny'
    ? undefined
    : allowedTools.length === 0
      ? t('plugins.channels.surface.routerRecipeNoTools', 'No tools')
      : allowedTools.length === 1
        ? t('plugins.channels.surface.routerRecipeOneTool', 'Only 1 tool')
        : t('plugins.channels.surface.routerRecipeListedTools', 'Only {count} tools', { count: allowedTools.length });
  const parts = [
    agent,
    typeof modelId === 'string' && modelId.trim() !== '' ? modelId.trim() : undefined,
    folder,
    tools,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0
    ? t('plugins.channels.surface.routerRecipeCustom', 'Custom session recipe')
    : parts.join(' · ');
}

/** The recipe summary bound to the mounted brand catalog, for Agent names. */
function useRouterRecipeSummary(t: Translate): (recipe: unknown) => string {
  const resolveAgentName = usePluginBrandDisplayNameResolver();
  return React.useCallback(
    (recipe: unknown) => routerRecipeSummary(recipe, t, resolveAgentName),
    [resolveAgentName, t],
  );
}

function routerRouteConditionLabel(when: ThreadRouterRoute['when'], t: Translate): string {
  const from = when.group === 'any'
    ? t('plugins.channels.surface.routerFromAnyone', 'Anyone allowed')
    : t('plugins.channels.surface.routerFromGroup', 'People in {group}', { group: when.group });
  if (when.forwarded === 'any') return from;
  return when.forwarded
    ? t('plugins.channels.surface.routerForwardedOnly', '{from}, forwarded mail', { from })
    : t('plugins.channels.surface.routerNotForwarded', '{from}, not forwarded', { from });
}

function routerRouteSummary(route: ThreadRouterRoute, t: Translate, summarizeRecipe: (recipe: unknown) => string): string {
  return `${routerRouteConditionLabel(route.when, t)} → ${summarizeRecipe(route.recipe)}`;
}

function nextRouterRouteId(routes: readonly ThreadRouterRoute[]): string {
  const taken = new Set(routes.map((route) => route.id));
  let index = routes.length + 1;
  while (taken.has(`route-${index}`)) index += 1;
  return `route-${index}`;
}

const ROUTER_ROUTE_DEFAULT_POLICY: ThreadRouterRoute['policy'] = Object.freeze({
  deliveryMode: 'repliesOnly',
  permissionCeiling: 'read-only',
  approvals: Object.freeze({ kind: 'off' as const }),
  newSession: Object.freeze({ kind: 'off' as const }),
});

/**
 * The router editor (plan §3.1): sender groups are the router's only sender
 * authority, and routes are an ordered precedence list whose first match
 * decides the recipe and Session policy of a new thread. Membership can only
 * be chosen from senders this binding already admits (re-resolving the
 * audience adds people), so a save never names an unresolved principal.
 */
function ThreadRouterControls(props: Readonly<{
  target: BindingEditorThreadRouterTarget;
  admittedPrincipalIds: readonly string[];
  /**
   * `pairing`: the router is set up through a pairing challenge. Its one group
   * stays empty until the person who pairs fills it at finalize, so the group
   * can be named but not given members or siblings here.
   */
  membership?: 'resolved' | 'pairing';
  disabled: boolean;
  signal: AbortSignal;
  onChange: (transform: (target: BindingEditorThreadRouterTarget) => BindingEditorThreadRouterTarget) => void;
  onRecipeUnavailable: () => void;
  t: Translate;
}>): React.ReactElement {
  const { target, t } = props;
  const summarizeRecipe = useRouterRecipeSummary(t);
  const [newGroupName, setNewGroupName] = React.useState('');
  const recipeRequestRef = React.useRef<number | 'new' | undefined>(undefined);
  const recipeSelection = useBindingNewSessionRecipeSelection({
    signal: props.signal,
    draft: () => {
      const request = recipeRequestRef.current;
      const recipe = typeof request === 'number' ? target.routes[request]?.recipe : undefined;
      return recipe === undefined ? undefined : { existingDraft: recipe };
    },
    isLocked: () => props.disabled,
    onUnavailable: props.onRecipeUnavailable,
    onSelected: (recipe) => {
      const request = recipeRequestRef.current;
      recipeRequestRef.current = undefined;
      props.onChange((current) => {
        if (request === 'new') {
          const firstGroup = current.principalGroups[0]?.id ?? 'any';
          return {
            ...current,
            routes: [...current.routes, {
              id: nextRouterRouteId(current.routes),
              when: { group: firstGroup, forwarded: 'any' },
              recipe: recipe as ThreadRouterRoute['recipe'],
              policy: ROUTER_ROUTE_DEFAULT_POLICY,
            }],
          };
        }
        if (request === undefined || current.routes[request] === undefined) return current;
        return {
          ...current,
          routes: current.routes.map((route, index) => index === request
            ? { ...route, recipe: recipe as ThreadRouterRoute['recipe'] }
            : route),
        };
      });
    },
  });
  const memberCandidates = [...new Set([
    ...props.admittedPrincipalIds,
    ...target.principalGroups.flatMap((group) => group.principalIds),
  ])];
  const updateRoute = (index: number, transform: (route: ThreadRouterRoute) => ThreadRouterRoute) => {
    props.onChange((current) => ({
      ...current,
      routes: current.routes.map((route, routeIndex) => routeIndex === index ? transform(route) : route),
    }));
  };
  const moveRoute = (index: number, offset: -1 | 1) => {
    props.onChange((current) => {
      const destination = index + offset;
      if (destination < 0 || destination >= current.routes.length) return current;
      const routes = [...current.routes];
      const [moved] = routes.splice(index, 1);
      if (moved === undefined) return current;
      routes.splice(destination, 0, moved);
      return { ...current, routes };
    });
  };
  const groupOptions = [
    { value: 'any', label: t('plugins.channels.surface.routerFromAnyone', 'Anyone allowed') },
    ...target.principalGroups.map((group) => ({ value: group.id, label: group.id })),
  ];
  const trimmedGroupName = newGroupName.trim();
  const groupNameTaken = target.principalGroups.some((group) => group.id === trimmedGroupName);
  const pairing = props.membership === 'pairing';
  const pairingGroup = pairing ? target.principalGroups[0] : undefined;
  const [pairingGroupName, setPairingGroupName] = React.useState(pairingGroup?.id ?? '');
  const renamePairingGroup = (next: string) => {
    setPairingGroupName(next);
    const name = next.trim();
    // `any` is the route wildcard, never a group name.
    if (name === '' || name === 'any') return;
    props.onChange((current) => {
      const previous = current.principalGroups[0]?.id;
      if (previous === undefined || previous === name) return current;
      return {
        ...current,
        principalGroups: current.principalGroups.map((group, index) => index === 0 ? { ...group, id: name } : group),
        routes: current.routes.map((route) => route.when.group === previous
          ? { ...route, when: { ...route.when, group: name } }
          : route),
      };
    });
  };

  return (
    <Stack gap="large">
      {pairingGroup === undefined ? null : (
        <ItemGroup
          testID="channels-router-groups"
          title={t('plugins.channels.surface.routerGroupTitle', 'Sender group')}
          description={t(
            'plugins.channels.surface.routerPairingGroupDescription',
            'Only people in this group can start a thread. The person who sends the pairing code joins it, and you see who that is before the router is turned on.',
          )}
        >
          <Item
            title={t('plugins.channels.surface.routerGroupNameLabel', 'Group name')}
            fieldAccessory
            accessoryOutsidePressable
            accessory={(
              <Form.TextField
                testID="channels-router-pairing-group-name"
                label={t('plugins.channels.surface.routerGroupNameLabel', 'Group name')}
                presentation="field"
                value={pairingGroupName}
                autoCapitalize="none"
                disabled={props.disabled}
                onChange={renamePairingGroup}
              />
            )}
          />
          <Item
            testID="channels-router-pairing-group-members"
            title={t('plugins.channels.surface.routerPairingGroupMembers', 'People')}
            subtitle={t('plugins.channels.surface.routerPairingGroupMembersValue', 'Whoever sends the pairing code')}
          />
        </ItemGroup>
      )}
      {pairing ? null : (
      <ItemGroup
        testID="channels-router-groups"
        surface="none"
        title={t('plugins.channels.surface.routerGroupsTitle', 'Sender groups')}
        description={t(
          'plugins.channels.surface.routerGroupsDescription',
          'Only people in a group can start a thread. Routes and new conversations address a group by name.',
        )}
      >
        <Stack gap="small">
        {target.principalGroups.map((group) => {
          const usedByRoutes = target.routes.flatMap((route, index) => route.when.group === group.id ? [index + 1] : []);
          const usedByRoute = usedByRoutes.length > 0;
          const lastGroup = target.principalGroups.length === 1;
          return (
            // One sheet per group: each allowed sender is a labelled switch row.
            <ItemGroup
              key={group.id}
              testID={`channels-router-group-${group.id}`}
              title={group.id}
              // Say why the group cannot go before the reader tries.
              {...(usedByRoute ? {
                description: usedByRoutes.length === 1
                  ? t('plugins.channels.surface.routerGroupUsedByRoute', 'Route {position} starts sessions for this group. Change that route to remove it.', { position: usedByRoutes[0]! })
                  : t('plugins.channels.surface.routerGroupUsedByRoutes', 'Routes {positions} start sessions for this group. Change them to remove it.', { positions: formatConjunction(usedByRoutes.map(String)) }),
              } : lastGroup ? {
                description: t('plugins.channels.surface.routerGroupLast', 'A router needs at least one sender group.'),
              } : {})}
              action={(
                <Button
                  testID={`channels-router-group-remove-${group.id}`}
                  variant="plain"
                  title={t('plugins.channels.surface.routerGroupRemove', 'Remove group')}
                  accessibilityLabel={t('plugins.channels.surface.routerGroupRemoveNamed', 'Remove group {group}', { group: group.id })}
                  disabled={props.disabled || usedByRoute || lastGroup}
                  onPress={() => props.onChange((current) => ({
                    ...current,
                    principalGroups: current.principalGroups.filter((candidate) => candidate.id !== group.id),
                  }))}
                />
              )}
            >
              {memberCandidates.map((principalId) => (
                <Item
                  key={principalId}
                  title={principalId}
                  accessoryOutsidePressable
                  accessory={(
                <Form.Toggle
                  label={principalId}
                  value={group.principalIds.includes(principalId)}
                  disabled={props.disabled}
                  onChange={(member) => props.onChange((current) => ({
                    ...current,
                    principalGroups: current.principalGroups.map((candidate) => candidate.id !== group.id
                      ? candidate
                      : {
                        ...candidate,
                        principalIds: member
                          ? [...candidate.principalIds.filter((id) => id !== principalId), principalId]
                          : candidate.principalIds.filter((id) => id !== principalId),
                      }),
                  }))}
                />
                  )}
                />
              ))}
            </ItemGroup>
          );
        })}
        <ItemGroup surface="sheet">
        <Item
          title={t('plugins.channels.surface.routerGroupName', 'New group name')}
          accessoryWraps
          accessoryOutsidePressable
          accessory={(
        <Row gap="small" align="center" wrap>
          <Form.TextField
            label={t('plugins.channels.surface.routerGroupName', 'New group name')}
            presentation="field"
            value={newGroupName}
            autoCapitalize="none"
            disabled={props.disabled}
            onChange={setNewGroupName}
          />
          <Button
            testID="channels-router-group-add"
            variant="secondary"
            title={t('plugins.channels.surface.routerGroupAdd', 'Add group')}
            disabled={props.disabled || trimmedGroupName === '' || trimmedGroupName === 'any' || groupNameTaken}
            onPress={() => {
              props.onChange((current) => ({
                ...current,
                principalGroups: [...current.principalGroups, { id: trimmedGroupName, principalIds: [] }],
              }));
              setNewGroupName('');
            }}
          />
        </Row>
          )}
        />
        </ItemGroup>
        </Stack>
      </ItemGroup>
      )}

      <ItemGroup
        testID="channels-router-routes"
        surface="none"
        title={t('plugins.channels.surface.routerRoutesTitle', 'Routes')}
        description={t(
          'plugins.channels.surface.routerRoutesDescription',
          'A new thread starts a session from the first route that matches it. A thread that matches no route is ignored.',
        )}
      >
        <Stack gap="small">
        {target.routes.map((route, index) => (
          <Stack key={route.id} gap="small" testID={`channels-router-route-${route.id}`}>
            <ItemGroup
              title={t('plugins.channels.surface.routerRouteSummaryLabel', 'Route {position}', { position: index + 1 })}
              action={(
            <Row gap="small" align="center">
              <Button
                variant="plain"
                title={t('plugins.channels.surface.routerRouteMoveUp', 'Move up')}
                accessibilityLabel={t('plugins.channels.surface.routerRouteMoveUpNamed', 'Move route {position} up', { position: index + 1 })}
                disabled={props.disabled || index === 0}
                onPress={() => moveRoute(index, -1)}
              />
              <Button
                variant="plain"
                title={t('plugins.channels.surface.routerRouteMoveDown', 'Move down')}
                accessibilityLabel={t('plugins.channels.surface.routerRouteMoveDownNamed', 'Move route {position} down', { position: index + 1 })}
                disabled={props.disabled || index === target.routes.length - 1}
                onPress={() => moveRoute(index, 1)}
              />
              <Button
                variant="plain"
                title={t('plugins.channels.surface.routerRouteRemove', 'Remove')}
                accessibilityLabel={t('plugins.channels.surface.routerRouteRemoveNamed', 'Remove route {position}', { position: index + 1 })}
                disabled={props.disabled}
                onPress={() => props.onChange((current) => ({
                  ...current,
                  routes: current.routes.filter((candidate) => candidate.id !== route.id),
                }))}
              />
            </Row>
              )}
            >
            <Item
              title={t('plugins.channels.surface.routerRouteFrom', 'From')}
              fieldAccessory
              accessoryOutsidePressable
              accessory={(
            <Form.Select
              presentation="field"
              label={t('plugins.channels.surface.routerRouteFrom', 'From')}
              options={groupOptions}
              value={route.when.group}
              disabled={props.disabled}
              onChange={(value) => {
                const group = readActionInputOptionValue(value);
                if (typeof group !== 'string') return;
                updateRoute(index, (current) => ({ ...current, when: { ...current.when, group } }));
              }}
            />
              )}
            />
            <Item
              title={t('plugins.channels.surface.routerRouteForwarded', 'Forwarded messages')}
              accessoryWraps
              accessoryOutsidePressable
              accessory={(
            <Form.Select
              presentation="segmented"
              label={t('plugins.channels.surface.routerRouteForwarded', 'Forwarded messages')}
              options={[
                { value: 'any', label: t('plugins.channels.surface.routerForwardedAny', 'Either') },
                { value: 'true', label: t('plugins.channels.surface.routerForwardedTrue', 'Only forwarded') },
                { value: 'false', label: t('plugins.channels.surface.routerForwardedFalse', 'Not forwarded') },
              ]}
              value={route.when.forwarded === 'any' ? 'any' : String(route.when.forwarded)}
              disabled={props.disabled}
              onChange={(value) => {
                const forwarded = value === 'true' ? true : value === 'false' ? false : 'any';
                updateRoute(index, (current) => ({ ...current, when: { ...current.when, forwarded } }));
              }}
            />
              )}
            />
            <Item
              title={t('plugins.channels.surface.routerRouteRecipe', 'Starts')}
              subtitle={summarizeRecipe(route.recipe)}
              accessoryOutsidePressable
              accessory={(
                <Button
                  variant="secondary"
                  title={t('plugins.channels.surface.routerRouteRecipeChoose', 'Choose recipe')}
                  busy={recipeSelection.pending && recipeRequestRef.current === index}
                  disabled={props.disabled || !recipeSelection.available || recipeSelection.pending}
                  onPress={() => {
                    recipeRequestRef.current = index;
                    recipeSelection.select();
                  }}
                />
              )}
            />
            <BindingSessionTargetPolicyRows
              newSessionRow="whenEnabled"
              target={{ kind: 'session', sessionId: route.id, policy: route.policy }}
              admittedPrincipalIds={route.when.group === 'any'
                ? memberCandidates
                : target.principalGroups.find((group) => group.id === route.when.group)?.principalIds ?? []}
              retainedApprovalPrincipalIds={undefined}
              disabled={props.disabled}
              configureNewSessionAvailable={false}
              onChange={(transform) => updateRoute(index, (current) => {
                const next = transform({ kind: 'session', sessionId: current.id, policy: current.policy });
                return next.kind === 'session' ? { ...current, policy: next.policy as ThreadRouterRoute['policy'] } : current;
              })}
              onRetainApprovalPrincipalIds={() => undefined}
              onConfigureNewSession={() => undefined}
              t={t}
            />
            </ItemGroup>
          </Stack>
        ))}
        <Button
          testID="channels-router-route-add"
          variant="secondary"
          title={t('plugins.channels.surface.routerRouteAdd', 'Add route')}
          busy={recipeSelection.pending && recipeRequestRef.current === 'new'}
          disabled={props.disabled || !recipeSelection.available || recipeSelection.pending}
          onPress={() => {
            recipeRequestRef.current = 'new';
            recipeSelection.select();
          }}
        />
        </Stack>
      </ItemGroup>
    </Stack>
  );
}

/** The one draft projection of an exact retained binding, online or offline. */
function bindingEditorDraftFromBinding(binding: ConversationBindingV1): BindingEditorDraft {
  const retainedApprovalPrincipalIds = binding.target.kind === 'session'
    && binding.target.policy.approvals.kind === 'enabled'
    ? binding.target.policy.approvals.principalIds
    : undefined;
  return {
    target: bindingEditorTargetFromBinding(binding),
    targetChanged: false,
    ...(retainedApprovalPrincipalIds === undefined ? {} : { retainedApprovalPrincipalIds }),
    endpointLabel: binding.endpoint.label ?? binding.endpoint.id,
    allowedPrincipalIds: binding.allowedPrincipalIds,
    allowBotSenders: binding.allowBotSenders,
    inputMode: binding.inputMode,
    inboundDebounceMs: String(binding.inboundDebounceMs),
    linkPreviewPolicy: binding.linkPreviewPolicy,
    senderFeedback: binding.senderFeedback,
    enabled: binding.enabled,
  };
}

function bindingEditorDraftFromDetail(
  detail: ReturnType<typeof ConversationBindingReadResultV1Schema.parse>,
): BindingEditorDraft {
  if (detail.kind !== 'ready') {
    throw new Error('Binding editor draft requires an exact ready binding detail.');
  }
  return bindingEditorDraftFromBinding(detail.binding);
}

function bindingEditorTargetLabel(target: BindingEditorTarget, t: Translate): string {
  if (target.kind === 'threadRouter') {
    return t('plugins.channels.surface.routerTargetSummary', '{routes} routes, {groups} sender groups', {
      routes: target.routes.length,
      groups: target.principalGroups.length,
    });
  }
  return target.kind === 'session'
    ? `${bindingTargetKindLabel(target.kind, t)}: ${target.sessionId}`
    : target.kind === 'discussion'
      ? `${bindingTargetKindLabel(target.kind, t)}: ${target.discussionId}`
    : `${bindingTargetKindLabel(target.kind, t)}: ${target.automationId}`;
}

function bindingApprovalAudienceLabel(target: BindingEditorTarget, t: Translate): string {
  if (target.kind !== 'session' || target.policy.approvals.kind === 'off') {
    return t('plugins.channels.surface.bindingCreateApprovalsOff', 'Off');
  }
  if (target.policy.approvals.principalIds === undefined) {
    return t('plugins.channels.surface.bindingCreateApprovalsAudienceAll', 'All admitted principals');
  }
  return t(
    'plugins.channels.surface.bindingCreateApprovalsAudienceSelectedSummary',
    'Selected admitted principals: {principals}',
    { principals: target.policy.approvals.principalIds.join(', ') },
  );
}

function bindingEditorDebounceMs(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return isNonNegativeSafeInteger(parsed)
    ? parsed
    : undefined;
}

function bindingEditorHasObservedPolicyClamp(
  requested: BindingEditorTarget | undefined,
  actual: ConversationBindingV1,
): boolean {
  if (requested?.kind !== 'session' || actual.target.kind !== 'session') return false;
  return requested.policy.permissionCeiling !== actual.target.policy.permissionCeiling
    || requested.policy.approvals.kind !== actual.target.policy.approvals.kind;
}

function isBindingEditorPrincipalCandidate(
  candidate: BindingCreatePrincipalCandidate,
): candidate is BindingEditorPrincipalCandidate {
  return candidate.kind === 'human' || candidate.kind === 'bot';
}

/**
 * A provider names some places only through their parent (a Telegram forum
 * topic carries its group's title). The label stays presentation; the
 * immutable id is the fallback when nothing better exists.
 */
function pairingPlaceLabel(endpoint: ConversationResolvedEndpointV1, t: Translate): string {
  if (endpoint.label !== undefined) return endpoint.label;
  if (endpoint.kind === 'thread' && endpoint.parentLabel !== undefined) {
    return t('plugins.channels.surface.pairingThreadInParent', 'A topic in {parent}', { parent: endpoint.parentLabel });
  }
  return endpoint.id;
}

function bindingCreateEndpointSelection(
  query: string,
  candidate: BindingCreateEndpointCandidate,
  kinds?: readonly ['thread'],
): BindingCreateEndpointSelection {
  // The resolver's display labels remain presentation-only. The guarded writer
  // receives the provider-authenticated identity and the exact query evidence,
  // including the kind filter the candidate was found under.
  if (kinds !== undefined) {
    return { ...bindingCreateEndpointSelection(query, candidate), kinds: [...kinds] };
  }
  const { kind, audience, id, parentId } = candidate;
  if (kind === 'direct') {
    return { query, selected: parentId === undefined ? { kind, audience, id } : { kind, audience, id, parentId } };
  }
  if (kind === 'shared') {
    return { query, selected: parentId === undefined ? { kind, audience, id } : { kind, audience, id, parentId } };
  }
  if (kind === 'thread') {
    return { query, selected: parentId === undefined ? { kind, audience, id } : { kind, audience, id, parentId } };
  }
  if (kind === 'githubIssue') {
    return { query, selected: parentId === undefined ? { kind, audience, id } : { kind, audience, id, parentId } };
  }
  return { query, selected: parentId === undefined ? { kind, audience, id } : { kind, audience, id, parentId } };
}

type BindingPrincipalChoice = Readonly<{ id: string; kind: string; label?: string }>;

/**
 * The allowed-sender choice for both the link journey and the conversation
 * editor: one multiple Select whose options are the senders already chosen
 * (kept from earlier searches, so each stays visible and can be unchecked)
 * followed by this search's other results.
 */
function BindingPrincipalChoices<Choice extends BindingPrincipalChoice>(props: Readonly<{
  testID: string;
  label: string;
  candidates: readonly Choice[];
  selected: readonly BindingPrincipalChoice[];
  disabled: boolean;
  onToggle: (choice: Choice) => void;
}>): React.ReactElement | null {
  const keyOf = (choice: BindingPrincipalChoice) => `${choice.kind}:${choice.id}`;
  const selectedKeys = new Set(props.selected.map(keyOf));
  const choices: readonly BindingPrincipalChoice[] = [
    ...props.selected,
    ...props.candidates.filter((candidate) => !selectedKeys.has(keyOf(candidate))),
  ];
  if (choices.length === 0) return null;
  return (
    <Form.Select
      testID={props.testID}
      label={props.label}
      multiple
      presentation="inline"
      disabled={props.disabled}
      options={choices.map((choice) => ({
        value: keyOf(choice),
        label: choice.label ?? choice.id,
        // A person's name leads; the address they write from is the fact that tells two apart.
        ...(choice.label !== undefined && choice.label !== choice.id ? { description: choice.id } : {}),
      }))}
      value={[...selectedKeys]}
      onChange={(next) => {
        const nextKeys = new Set(Array.isArray(next) ? next.map(String) : [String(next)]);
        const changed = choices.find((choice) => nextKeys.has(keyOf(choice)) !== selectedKeys.has(keyOf(choice)));
        if (changed === undefined) return;
        // A retained sender may not be in this search's results; it toggles off by its own identity.
        props.onToggle(props.candidates.find((entry) => keyOf(entry) === keyOf(changed)) ?? (changed as Choice));
      }}
    />
  );
}

function bindingCreatePrincipalSelection(
  query: string,
  candidate: BindingCreatePrincipalCandidate,
  previous?: BindingCreatePrincipalSelection,
): BindingCreatePrincipalSelection | undefined {
  if (candidate.kind !== 'human' && candidate.kind !== 'bot') return undefined;
  const selected = previous !== undefined && previous.selected.some((principal) => principal.id === candidate.id)
    ? previous.selected.filter((principal) => principal.id !== candidate.id)
    : [...(previous?.selected ?? []), {
      id: candidate.id,
      kind: candidate.kind,
      ...(previous === undefined || previous.query === query ? {} : { query }),
    }];
  if (selected.length === 0) return undefined;
  return {
    query: previous?.query ?? query,
    selected,
  };
}

function parseBindingCreateAutomationExecution(value: unknown): BindingCreateAutomationExecution | undefined {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return undefined;
  if (value.targetType !== null
    && value.targetType !== 'new_session'
    && value.targetType !== 'existing_session'
    && value.targetType !== 'execution_run') {
    return undefined;
  }
  return { targetType: value.targetType, enabled: value.enabled };
}

function bindingCreateAutomationEffectLabel(
  execution: BindingCreateAutomationExecution,
  t: Translate,
): string {
  if (execution.targetType === null) {
    return t(
      'plugins.channels.surface.bindingCreateAutomationEffectWorkflow',
      'A message from the allowed sender starts this Automation, which runs its configured workflow.',
    );
  }
  if (execution.targetType === 'new_session') {
    return t(
      'plugins.channels.surface.bindingCreateAutomationEffectNewSession',
      'A message from the allowed sender starts this Automation, which creates a new Session on its assigned machine.',
    );
  }
  if (execution.targetType === 'existing_session') {
    return t(
      'plugins.channels.surface.bindingCreateAutomationEffectExistingSession',
      'A message from the allowed sender starts this Automation, which sends work into the existing Session it targets.',
    );
  }
  return t(
    'plugins.channels.surface.bindingCreateAutomationEffectExecutionRun',
    'A message from the allowed sender starts this Automation, which runs its configured execution run on its assigned machine.',
  );
}

function parseBindingCreateAutomationPage(value: unknown): BindingCreateAutomationPage | undefined {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 100) return undefined;
  if (value.nextCursor !== null && !isNonEmptyString(value.nextCursor)) return undefined;
  const seen = new Set<string>();
  const candidates: BindingCreateAutomationCandidate[] = [];
  for (const entry of value.items) {
    if (!isRecord(entry)
      || !isNonEmptyString(entry.automationId)
      || !isNonEmptyString(entry.label)
      || seen.has(entry.automationId)) {
      continue;
    }
    // The delegated-authority disclosure is part of the target contract, so a
    // candidate without it is not offered rather than shown without it.
    const execution = parseBindingCreateAutomationExecution(entry.execution);
    if (execution === undefined) continue;
    seen.add(entry.automationId);
    candidates.push({
      automationId: entry.automationId,
      label: entry.label,
      execution,
    });
  }
  return {
    candidates,
    ...(value.nextCursor === null ? {} : { nextCursor: value.nextCursor }),
  };
}

/**
 * A step's one action row: Back leads, Cancel and the step's primary close it. A step whose
 * choice advances it (picking a conversation) has no primary.
 */
function BindingCreateStepActions(props: Readonly<{
  onBack?: () => void;
  onCancel: () => void;
  disabled: boolean;
  backDisabled?: boolean;
  primary?: React.ReactNode;
  t: Translate;
}>): React.ReactElement {
  return (
    <Row gap="small" align="center" justify="space-between" wrap testID="channels-binding-create-step-actions">
      {props.onBack === undefined ? <Stack /> : (
        <Button
          title={props.t('plugins.channels.surface.bindingCreateBack', 'Back')}
          variant="plain"
          disabled={props.disabled || props.backDisabled === true}
          onPress={props.onBack}
        />
      )}
      <Row gap="small" align="center">
        <Button
          title={props.t('plugins.channels.surface.bindingCreateCancel', 'Cancel')}
          variant={props.primary === undefined ? 'secondary' : 'plain'}
          disabled={props.disabled}
          onPress={props.onCancel}
        />
        {props.primary}
      </Row>
    </Row>
  );
}

/**
 * The remaining minutes and zero-padded seconds are facts; `m` and `s` are
 * English words. One bounded pattern key hands the abbreviations, their order
 * and their spacing to the locale, so a non-English reader is not shown
 * English units inside an otherwise translated pairing step.
 */
function formatPairingCountdown(remainingMs: number, t: Translate): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / MILLISECONDS_PER_SECOND));
  return t('plugins.channels.surface.bindingCreatePairingCountdown', '{minutes}m {seconds}s', {
    minutes: Math.floor(totalSeconds / 60),
    seconds: String(totalSeconds % 60).padStart(2, '0'),
  });
}

/**
 * Resource time is authoritative at read; this local timer only projects its
 * bounded remaining duration and the moment it reaches zero. The rendered
 * countdown never becomes a live-region announcement; the expiry transition it
 * reports is presented through the existing pairing Banner, which is the one
 * announcement owner for this surface.
 *
 * The daemon still owns real expiry. Reaching zero only stops offering a token,
 * link, and deep link the provider will no longer honour, so the person is not
 * left holding a challenge that silently cannot complete.
 */
function usePairingExpiryCountdown(input: Readonly<{
  expiresAt?: number;
  observedAt?: number;
  active: boolean;
  t: Translate;
}>): Readonly<{ countdown?: string; expired: boolean }> {
  const [remainingMs, setRemainingMs] = React.useState<number | undefined>();

  React.useEffect(() => {
    if (!input.active || input.expiresAt === undefined || input.observedAt === undefined) {
      setRemainingMs(undefined);
      return;
    }
    const initiallyRemainingMs = Math.max(0, input.expiresAt - input.observedAt);
    const startedAt = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const remaining = Math.max(0, initiallyRemainingMs - (Date.now() - startedAt));
      setRemainingMs(remaining);
      if (remaining > 0) timeout = setTimeout(update, Math.min(1_000, remaining));
    };
    update();
    return () => {
      if (timeout !== undefined) clearTimeout(timeout);
    };
  }, [input.active, input.expiresAt, input.observedAt]);

  if (remainingMs === undefined) return { expired: false };
  if (remainingMs <= 0) return { expired: true };
  return { countdown: formatPairingCountdown(remainingMs, input.t), expired: false };
}

/**
 * One client-generated opaque create-request key per pairing attempt. The
 * daemon rejoins the exact challenge this key created after a response loss,
 * and unknown-outcome recovery matches it exactly, so a second device's
 * superseding challenge can never be adopted by this device. The 128-bit
 * random identity uses the same platform capability as the daemon-side
 * pairing helpers; when it is unavailable the create is refused instead of
 * degrading to a guessable or colliding key.
 */
const PAIRING_REQUEST_ID_RANDOM_BYTES = 16;
function createPairingRequestId(): string | null {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.getRandomValues === undefined) return null;
  try {
    const bytes = new Uint8Array(PAIRING_REQUEST_ID_RANDOM_BYTES);
    cryptoRef.getRandomValues(bytes);
    let identity = '';
    for (const byte of bytes) identity += byte.toString(16).padStart(2, '0');
    return `pairing-request-${identity}`;
  } catch {
    // A present-but-unavailable runtime entropy source is the same typed
    // unavailability as an absent one; never fall back to time/counters.
    return null;
  }
}

/**
 * An ambiguous create is resolved only through a fresh manager projection.
 * Recovery matches the exact client-generated request key this create sent —
 * never merely a connection and revision — so the challenge this request
 * created is restored without adopting a challenge another device's create
 * superseded it with, and without making a binding decision or accepting a
 * proposal automatically.
 */
function BindingCreatePairingRecovery(props: Readonly<{
  connectionId: string;
  pairingRequestId: string;
  onRecovered: (pairing: BindingCreatePairingContext) => void;
  onNotFound: () => void;
  t: Translate;
}>): React.ReactElement {
  const { resource, refresh } = useLivePluginResource(CHANNELS_PAIRING_RESOURCE);
  const parsedResource = React.useMemo(
    () => (resource.value === undefined ? undefined : parsePairingResource(resource.value)),
    [resource.value],
  );
  const pairing = parsedResource?.kind === 'ready' ? parsedResource.pairing : undefined;
  const matchingChallenge = pairing?.challenges.find((challenge) => (
    challenge.connectionId === props.connectionId
    && challenge.pairingRequestId === props.pairingRequestId
  ));
  const recoveryStartedRef = React.useRef(false);
  const onReconciled = React.useCallback(() => {
    if (pairing !== undefined && matchingChallenge !== undefined) {
      props.onRecovered({
        generationId: pairing.generationId,
        challengeId: matchingChallenge.challengeId,
        expiresAt: matchingChallenge.expiresAt,
      });
      return;
    }
    props.onNotFound();
  }, [matchingChallenge, pairing, props]);
  const requestReread = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown: true,
    resource,
    onRefresh: refresh,
    onReconciled,
  });

  React.useEffect(() => {
    if (recoveryStartedRef.current) return;
    recoveryStartedRef.current = true;
    requestReread();
  }, [requestReread]);

  if (resource.value === undefined && resource.pending === 'initial') {
    return (
      <LoadingState
        title={props.t('plugins.channels.surface.bindingCreatePairingLoadingTitle', 'Loading pairing status')}
        description={props.t(
          'plugins.channels.surface.bindingCreatePairingLoadingDescription',
          'Reading the current pairing challenge from your selected machine.',
        )}
      />
    );
  }
  if (parsedResource?.kind === 'invalid') {
    return (
      <ErrorState
        title={props.t('plugins.channels.surface.bindingCreatePairingUnavailableTitle', 'Pairing status is unavailable')}
        description={props.t(
          'plugins.channels.surface.bindingCreatePairingInvalidDescription',
          'The pairing status returned an unexpected value. Refresh before trying again.',
        )}
        action={(
          <Action.Refresh
            title={props.t('plugins.channels.surface.bindingCreatePairingRefresh', 'Refresh pairing status')}
            onRefresh={requestReread}
          />
        )}
      />
    );
  }
  return (
    <Banner
      tone="warning"
      title={props.t('plugins.channels.surface.bindingCreatePairingUnknownTitle', 'Could not confirm the pairing change')}
      description={props.t(
        'plugins.channels.surface.bindingCreatePairingUnknownDescription',
        'Refreshing pairing status before another change can be made.',
      )}
      action={(
        <Action.Refresh
          title={props.t('plugins.channels.surface.bindingCreatePairingRefresh', 'Refresh pairing status')}
          onRefresh={requestReread}
        />
      )}
    />
  );
}

/**
 * A pairing handoff retains only the Action-issued identifiers and expiry.
 * The authenticated pairing Resource remains the current source for token,
 * deep link, proposal, endpoint presentation, and frozen finalize inputs.
 */
function BindingCreatePairingHandoff(props: Readonly<{
  pairing: BindingCreatePairingContext;
  signal: AbortSignal;
  onBindingsRefresh: () => void;
  /** Invoked with the finalize-returned binding id when review can continue. */
  onCompleted?: (bindingId: string) => void;
  onClose: () => void;
  t: Translate;
}>): React.ReactElement {
  const { resource, refresh } = useLivePluginResource(CHANNELS_PAIRING_RESOURCE);
  const finalizeAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize);
  const cancelAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCancel);
  const [feedback, setFeedback] = React.useState<
    | 'completed'
    | 'targetNotVerified'
    | 'targetResultDeliveryUnavailable'
    | 'expired'
    | 'restarted'
    | 'unavailable'
    | undefined
  >();
  /**
   * The binding id the finalize Action returned. Retaining it lets the
   * Review-and-enable action open the existing binding editor for exactly the
   * created row instead of merely closing the pairing view.
   */
  const [completedBindingId, setCompletedBindingId] = React.useState<string | undefined>();
  const mountedRef = React.useRef(true);
  const parsedResource = React.useMemo(
    () => (resource.value === undefined ? undefined : parsePairingResource(resource.value)),
    [resource.value],
  );
  const pairing = parsedResource?.kind === 'ready' ? parsedResource.pairing : undefined;
  const generationMatches = pairing?.generationId === props.pairing.generationId;
  const challenge = generationMatches
    ? pairing.challenges.find((candidate) => candidate.challengeId === props.pairing.challengeId)
    : undefined;
  const proposal = generationMatches
    ? pairing.proposals.find((candidate) => candidate.challengeId === props.pairing.challengeId)
    : undefined;
  const outcomeUnknown = finalizeAction.execution.status === 'outcomeUnknown'
    || cancelAction.execution.status === 'outcomeUnknown';
  const actionLocked = outcomeUnknown
    || finalizeAction.execution.status === 'pending'
    || cancelAction.execution.status === 'pending';
  const challengeExpiry = usePairingExpiryCountdown({
    expiresAt: challenge?.expiresAt,
    observedAt: pairing?.observedAt,
    active: challenge !== undefined && feedback !== 'completed',
    t: props.t,
  });

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const onOutcomeReconciled = React.useCallback(() => {
    finalizeAction.reset();
    cancelAction.reset();
  }, [cancelAction.reset, finalizeAction.reset]);
  const requestPairingReread = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown,
    resource,
    onRefresh: refresh,
    onReconciled: onOutcomeReconciled,
  });

  const finalizePairing = React.useCallback(async () => {
    if (pairing === undefined
      || proposal === undefined
      || proposal.state !== 'proposed'
      || actionLocked
      || props.signal.aborted) {
      return;
    }
    const parsedInput = ConversationPairingFinalizeInputV1Schema.safeParse({
      generationId: pairing.generationId,
      proposalId: proposal.proposalId,
      connectionId: proposal.connectionId,

      // The daemon owns this opaque proposal identifier. Reusing it is the
      // stable idempotency key; the UI never invents a second pairing key.
      finalizeIdempotencyKey: proposal.proposalId,
    });
    if (!parsedInput.success) {
      setFeedback('unavailable');
      return;
    }
    setFeedback(undefined);
    const settled = await finalizeAction.execute(parsedInput.data);
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status !== 'success') {
      if (settled.status === 'error') setFeedback('unavailable');
      return;
    }
    const result = ConversationPairingFinalizeResultV1Schema.safeParse(settled.result);
    if (!result.success) {
      setFeedback('unavailable');
      return;
    }
    if (result.data.kind === 'created' || result.data.kind === 'rejoined') {
      setCompletedBindingId(result.data.binding.id);
      setFeedback('completed');
      props.onBindingsRefresh();
      refresh();
      return;
    }
    if (result.data.kind === 'notVerified') {
      setFeedback(bindingTargetVerificationFeedback(result.data.reason));
      return;
    }
    setFeedback(result.data.kind === 'expired'
      ? 'expired'
      : result.data.kind === 'restarted'
        ? 'restarted'
        : 'unavailable');
    refresh();
  }, [actionLocked, finalizeAction, pairing, proposal, props, refresh]);

  const cancelPairing = React.useCallback(async () => {
    if (pairing === undefined || actionLocked || props.signal.aborted) return;
    const input = challenge === undefined
      ? proposal === undefined || proposal.state !== 'proposed'
        ? undefined
        : { generationId: pairing.generationId, proposalId: proposal.proposalId }
      : { generationId: pairing.generationId, challengeId: challenge.challengeId };
    if (input === undefined) return;
    const parsedInput = ConversationPairingCancelInputV1Schema.safeParse(input);
    if (!parsedInput.success) {
      setFeedback('unavailable');
      return;
    }
    setFeedback(undefined);
    const settled = await cancelAction.execute(parsedInput.data);
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status !== 'success') {
      if (settled.status === 'error') setFeedback('unavailable');
      return;
    }
    const result = ConversationPairingCancelResultV1Schema.safeParse(settled.result);
    if (!result.success) {
      setFeedback('unavailable');
      return;
    }
    if (result.data.kind === 'cancelled') {
      props.onClose();
      return;
    }
    if (result.data.reason === 'bindingCreated') {
      setFeedback('completed');
      props.onBindingsRefresh();
      refresh();
      return;
    }
    setFeedback(result.data.reason === 'restarted' ? 'restarted' : 'unavailable');
    refresh();
  }, [actionLocked, cancelAction, challenge, pairing, proposal, props, refresh]);

  const retryAction = (
    <Action.Refresh
      title={props.t('plugins.channels.surface.bindingCreatePairingRefresh', 'Refresh pairing status')}
      onRefresh={requestPairingReread}
    />
  );

  if (resource.value === undefined) {
    return resource.pending === 'initial' ? (
      <LoadingState
        title={props.t('plugins.channels.surface.bindingCreatePairingLoadingTitle', 'Loading pairing status')}
        description={props.t(
          'plugins.channels.surface.bindingCreatePairingLoadingDescription',
          'Reading the current pairing challenge from your selected machine.',
        )}
      />
    ) : (
      <ErrorState
        title={props.t('plugins.channels.surface.bindingCreatePairingUnavailableTitle', 'Pairing status is unavailable')}
        description={props.t(
          'plugins.channels.surface.bindingCreatePairingUnavailableDescription',
          'Refresh to read the current pairing status again.',
        )}
        action={retryAction}
      />
    );
  }
  if (parsedResource?.kind === 'invalid') {
    return (
      <ErrorState
        title={props.t('plugins.channels.surface.bindingCreatePairingUnavailableTitle', 'Pairing status is unavailable')}
        description={props.t(
          'plugins.channels.surface.bindingCreatePairingInvalidDescription',
          'The pairing status returned an unexpected value. Refresh before trying again.',
        )}
        action={retryAction}
      />
    );
  }
  if (!generationMatches) {
    return (
      <Stack gap="small">
        <Banner
          tone="warning"
          title={props.t('plugins.channels.surface.bindingCreatePairingRestartedTitle', 'Pairing restarted')}
          description={props.t(
            'plugins.channels.surface.bindingCreatePairingRestartedDescription',
            'The selected machine restarted before this pairing could be completed. Create a new pairing challenge.',
          )}
          action={retryAction}
        />
        <Button
          title={props.t('plugins.channels.surface.bindingCreatePairingClose', 'Close pairing')}
          variant="secondary"
          onPress={props.onClose}
        />
      </Stack>
    );
  }

  const feedbackContent = feedback === undefined ? null : feedback === 'completed' ? (
    <Status
      tone="secondary"
      label={props.t(
        'plugins.channels.surface.bindingCreatePairingCompletedPaused',
        'Conversation paired. The binding is saved paused until you review and enable it.',
      )}
    />
  ) : (
    <Banner
      tone="warning"
      title={feedback === 'targetResultDeliveryUnavailable'
        ? props.t(
          'plugins.channels.surface.bindingCreateResultDeliveryUnavailableTitle',
          'This Automation cannot return a final result',
        )
        : feedback === 'targetNotVerified'
        ? props.t('plugins.channels.surface.bindingCreateTargetNotVerifiedTitle', 'The selected target is no longer available')
        : feedback === 'expired'
          ? props.t('plugins.channels.surface.bindingCreatePairingExpiredTitle', 'Pairing expired')
          : feedback === 'restarted'
            ? props.t('plugins.channels.surface.bindingCreatePairingRestartedTitle', 'Pairing restarted')
            : props.t('plugins.channels.surface.bindingCreatePairingUnavailableTitle', 'Pairing status is unavailable')}
      description={feedback === 'targetResultDeliveryUnavailable'
        ? props.t(
          'plugins.channels.surface.bindingCreateResultDeliveryUnavailableDescription',
          'Choose "Do not reply" to save this binding. The Automation still runs; only the reply back to the conversation is unavailable.',
        )
        : feedback === 'targetNotVerified'
        ? props.t('plugins.channels.surface.bindingCreateTargetNotVerifiedDescription', 'Choose a current target before trying again.')
        : props.t(
          'plugins.channels.surface.bindingCreatePairingUnavailableDescription',
          'Refresh to read the current pairing status again.',
        )}
      action={retryAction}
    />
  );
  const unknownOutcome = outcomeUnknown ? (
    <Banner
      tone="warning"
      title={props.t('plugins.channels.surface.bindingCreatePairingUnknownTitle', 'Could not confirm the pairing change')}
      description={props.t(
        'plugins.channels.surface.bindingCreatePairingUnknownDescription',
        'Refresh the current pairing status before making another change.',
      )}
      action={retryAction}
    />
  ) : null;

  if (feedback === 'completed' || proposal?.state === 'finalized') {
    return (
      <Stack gap="small">
        {feedbackContent}
        <Button
          testID="channels-binding-create-pairing-review-enable"
          title={props.t('plugins.channels.surface.bindingCreatePairingReviewEnable', 'Review and enable')}
          onPress={() => {
            if (completedBindingId !== undefined && props.onCompleted !== undefined) {
              props.onCompleted(completedBindingId);
              return;
            }
            props.onClose();
          }}
        />
        <Button
          title={props.t('plugins.channels.surface.bindingCreatePairingClose', 'Close pairing')}
          variant="secondary"
          onPress={props.onClose}
        />
      </Stack>
    );
  }
  if (proposal?.state === 'finalizing') {
    return (
      <Stack gap="small">
        {unknownOutcome}
        <Status tone="neutral" label={props.t('plugins.channels.surface.bindingCreatePairingFinalizing', 'Pairing is being completed')} />
        {retryAction}
      </Stack>
    );
  }
  if (proposal?.state === 'proposed') {
    return (
      <Stack gap="small">
        {unknownOutcome}
        {feedbackContent}
        <Status tone="attention" label={props.t('plugins.channels.surface.bindingCreatePairingProposal', 'Pairing request received')} />
        {/*
          The proof names who sent the code and where, nothing more. In a shared
          place that is whoever posted it first, so the owner checks the person
          before finalizing. A private chat's title is that person's name.
        */}
        <Text
          tone="secondary"
          value={proposal.proofEndpoint.audience === 'shared'
            ? props.t(
              'plugins.channels.surface.bindingCreatePairingProposalShared',
              'This is whoever sent the code in {place}. Finalize only if it is the person you expect; otherwise cancel and start again.',
              { place: pairingPlaceLabel(proposal.proofEndpoint, props.t) },
            )
            : props.t(
              'plugins.channels.surface.bindingCreatePairingProposalPrivate',
              'This is who sent the code in a private message. Finalize only if it is the person you expect.',
            )}
        />
        <Metadata
          title={props.t('plugins.channels.surface.bindingCreatePairingProposalDetails', 'Pairing request')}
          entries={[
            {
              label: props.t('plugins.channels.surface.bindingCreatePairingSender', 'Sent by'),
              value: proposal.proofEndpoint.audience === 'direct' && proposal.endpointLabel !== null
                ? `${proposal.endpointLabel} (${proposal.principalId})`
                : proposal.principalId,
            },
            {
              label: props.t('plugins.channels.surface.bindingCreatePairingSentIn', 'Sent in'),
              value: proposal.proofEndpoint.audience === 'direct'
                ? props.t('plugins.channels.surface.bindingCreatePairingSentInPrivate', 'A private message')
                : pairingPlaceLabel(proposal.proofEndpoint, props.t),
            },
          ]}
        />
        <Button
          title={props.t('plugins.channels.surface.bindingCreatePairingFinalize', 'Finalize pairing')}
          busy={finalizeAction.execution.status === 'pending'}
          disabled={actionLocked}
          onPress={finalizePairing}
        />
        <Button
          title={props.t('plugins.channels.surface.bindingCreatePairingCancel', 'Cancel pairing')}
          variant="secondary"
          busy={cancelAction.execution.status === 'pending'}
          disabled={actionLocked}
          onPress={cancelPairing}
        />
        {retryAction}
      </Stack>
    );
  }
  // A challenge whose bounded lifetime has run out is expired here, without
  // waiting for a Resource reread: keeping the token, link, and deep link on
  // screen would keep offering a completion the provider will refuse.
  if (challenge !== undefined && !challengeExpiry.expired && challenge.proofEndpoint !== undefined) {
    // Shared proof: the code is posted where the destination's people can see
    // it. There is no private link or QR, because either would move the proof
    // somewhere the challenge does not accept.
    const place = pairingPlaceLabel(challenge.proofEndpoint, props.t);
    const command = `/pair ${challenge.manualToken}`;
    return (
      <Stack gap="small" testID="channels-binding-create-pairing-shared">
        {unknownOutcome}
        {feedbackContent}
        <Heading
          level={2}
          value={props.t('plugins.channels.surface.bindingCreatePairingSharedTitle', 'Send the code in {place}', { place })}
        />
        <Text
          tone="secondary"
          value={props.t(
            'plugins.channels.surface.bindingCreatePairingSharedDescription',
            'Post this as a new message, not as a reply. A code sent anywhere else is ignored.',
          )}
        />
        <Text testID="channels-binding-create-pairing-command" variant="code" selectable value={command} />
        {challengeExpiry.countdown === undefined ? null : (
          <Text
            testID="channels-binding-create-pairing-countdown"
            tone="secondary"
            value={`${props.t('plugins.channels.surface.bindingCreatePairingExpiresIn', 'Expires in')} ${challengeExpiry.countdown}`}
          />
        )}
        <Action.Copy
          title={props.t('plugins.channels.surface.bindingCreatePairingCopyCommand', 'Copy command')}
          value={command}
        />
        <Metadata
          title={props.t('plugins.channels.surface.bindingCreatePairingChallengeDetails', 'Pairing challenge')}
          entries={[
            {
              label: props.t('plugins.channels.surface.bindingCreateProofConnecting', 'Connecting'),
              value: challenge.destinationLabel,
            },
            {
              label: props.t('plugins.channels.surface.bindingCreateProofPlace', 'Send the code in'),
              value: place,
            },
          ]}
        />
        <Banner
          tone="secondary"
          title={props.t('plugins.channels.surface.bindingCreatePairingSharedRaceTitle', 'Anyone in {place} can see this code', { place })}
          description={props.t(
            'plugins.channels.surface.bindingCreatePairingSharedRaceDescription',
            'Whoever sends it first is proposed. You see who it was, and nothing is turned on until you approve them.',
          )}
        />
        <Status
          tone="neutral"
          label={props.t('plugins.channels.surface.bindingCreatePairingWaiting', 'Waiting for the code')}
        />
        <Button
          title={props.t('plugins.channels.surface.bindingCreatePairingCancel', 'Cancel pairing')}
          variant="secondary"
          busy={cancelAction.execution.status === 'pending'}
          disabled={actionLocked}
          onPress={cancelPairing}
        />
        {retryAction}
      </Stack>
    );
  }
  if (challenge !== undefined && !challengeExpiry.expired) {
    return (
      <Stack gap="small">
        {unknownOutcome}
        {feedbackContent}
        <Heading level={2} value={props.t('plugins.channels.surface.bindingCreatePairingChallengeTitle', 'Complete pairing')} />
        {challengeExpiry.countdown === undefined ? null : (
          <Text
            testID="channels-binding-create-pairing-countdown"
            tone="secondary"
            value={`${props.t('plugins.channels.surface.bindingCreatePairingExpiresIn', 'Expires in')} ${challengeExpiry.countdown}`}
          />
        )}
        {/*
          The QR encodes the exact Action-issued deep link. It is never the only
          representation: the token and link below stay copyable, so a host
          without the QR renderer loses no pairing capability.
        */}
        {challenge.deepLinkUrl === null ? null : (
          <QRCode
            testID="channels-binding-create-pairing-qr"
            data={challenge.deepLinkUrl}
            size={180}
          />
        )}
        <Metadata
          title={props.t('plugins.channels.surface.bindingCreatePairingChallengeDetails', 'Pairing challenge')}
          entries={[
            {
              label: props.t('plugins.channels.surface.bindingCreatePairingDestination', 'Destination'),
              value: challenge.destinationLabel,
            },
            {
              label: props.t('plugins.channels.surface.bindingCreatePairingToken', 'Pairing token'),
              value: challenge.manualToken,
            },
            ...(challenge.deepLinkUrl === null ? [] : [{
              label: props.t('plugins.channels.surface.bindingCreatePairingLink', 'Pairing link'),
              value: challenge.deepLinkUrl,
            }]),
          ]}
        />
        <Action.Copy
          title={props.t('plugins.channels.surface.bindingCreatePairingCopyToken', 'Copy pairing token')}
          value={challenge.manualToken}
        />
        {challenge.deepLinkUrl === null ? null : (
          <>
            <Action.Copy
              title={props.t('plugins.channels.surface.bindingCreatePairingCopyLink', 'Copy pairing link')}
              value={challenge.deepLinkUrl}
            />
            <Action.OpenExternal
              title={props.t('plugins.channels.surface.bindingCreatePairingOpenLink', 'Open pairing link')}
              url={challenge.deepLinkUrl}
            />
          </>
        )}
        <Button
          title={props.t('plugins.channels.surface.bindingCreatePairingCancel', 'Cancel pairing')}
          variant="secondary"
          busy={cancelAction.execution.status === 'pending'}
          disabled={actionLocked}
          onPress={cancelPairing}
        />
        {retryAction}
      </Stack>
    );
  }

  // The local transition and the observed Resource fact are the same expiry.
  // One Banner presents it, so the surface's existing announcement owner
  // announces the transition exactly once rather than on every countdown tick.
  const expired = challengeExpiry.expired
    || (pairing !== undefined && pairing.observedAt >= props.pairing.expiresAt);
  return (
    <Stack gap="small">
      {unknownOutcome}
      <Banner
        testID="channels-binding-create-pairing-expired"
        tone="warning"
        title={expired
          ? props.t('plugins.channels.surface.bindingCreatePairingExpiredTitle', 'Pairing expired')
          : props.t('plugins.channels.surface.bindingCreatePairingUnavailableTitle', 'Pairing status is unavailable')}
        description={expired
          ? props.t(
            'plugins.channels.surface.bindingCreatePairingExpiredDescription',
            'This pairing challenge expired before a request was received. Create a new challenge to try again.',
          )
          : props.t(
            'plugins.channels.surface.bindingCreatePairingUnavailableDescription',
            'Refresh to read the current pairing status again.',
          )}
        action={retryAction}
      />
      <Button
        title={props.t('plugins.channels.surface.bindingCreatePairingClose', 'Close pairing')}
        variant="secondary"
        onPress={props.onClose}
      />
    </Stack>
  );
}

function BindingCreateJourney(props: Readonly<{
  connections: readonly ChannelsConnection[];
  resource: ResourcePresentation;
  signal: AbortSignal;
  onRefresh: () => void;
  /** Invoked when a completed pairing returns its binding id for review. */
  onPairingCompleted?: (bindingId: string) => void;
  /** One request to open this journey with a just-created connection selected. */
  openRequest?: Readonly<{ connectionId: string; requestId: number }>;
  onOpenConsumed?: () => void;
  /** Invoked with the new binding id when a link completes without pairing. */
  onCreated?: (bindingId: string) => void;
  /** Offers the new conversation's page beside the "created" confirmation. */
  onOpenCreated?: (bindingId: string) => void;
  t: Translate;
}>): React.ReactElement {
  const hostApi = usePluginHostApi();
  const surface = useSurfaceContext();
  const summarizeRecipe = useRouterRecipeSummary(props.t);
  const [createdBindingId, setCreatedBindingId] = React.useState<string | undefined>();
  const resolveAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve);
  const createAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate);
  const pairingAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate);
  const sessionsAction = useSessionCandidatePages({
    signal: props.signal,
    isLocked: () => actionLocked,
    onStarted: () => setFeedback(undefined),
    onUnavailable: () => setFeedback('sessionUnavailable'),
  });
  const automationAction = useExecutePluginAction('automation.conversation.targets.list');
  const [stage, setStage] = React.useState<BindingCreateStage>('closed');
  const stageFocusTarget = usePluginUiFocusTarget();
  const openerFocusTarget = usePluginUiFocusTarget();
  const [connectionId, setConnectionId] = React.useState<string | undefined>();
  const [endpointQuery, setEndpointQuery] = React.useState('');
  const [endpointCandidates, setEndpointCandidates] = React.useState<readonly BindingCreateEndpointCandidate[]>([]);
  const [endpointSelection, setEndpointSelection] = React.useState<BindingCreateEndpointSelection | undefined>();
  const [endpointLabel, setEndpointLabel] = React.useState<string | undefined>();
  const [principalQuery, setPrincipalQuery] = React.useState('');
  const [principalCandidates, setPrincipalCandidates] = React.useState<readonly BindingCreatePrincipalCandidate[]>([]);
  const [principalSelection, setPrincipalSelection] = React.useState<BindingCreatePrincipalSelection | undefined>();
  // Names of the chosen senders, kept across searches so each stays visible and removable.
  const [principalLabels, setPrincipalLabels] = React.useState<Readonly<Record<string, string>>>({});
  const [pairingRequired, setPairingRequired] = React.useState(false);
  const [pairingContext, setPairingContext] = React.useState<BindingCreatePairingContext | undefined>();
  const [pairingCreateRequest, setPairingCreateRequest] = React.useState<BindingCreatePairingRequest | undefined>();
  // An optional thread of a shared router parent where the pairing code is
  // accepted instead of the parent itself. Unset means the parent.
  const [proofThread, setProofThread] = React.useState<BindingCreateProofThread | undefined>();
  const [proofLocationKind, setProofLocationKind] = React.useState<'destination' | 'thread' | 'private'>('destination');
  const [proofThreadQuery, setProofThreadQuery] = React.useState('');
  const [proofThreadCandidates, setProofThreadCandidates] = React.useState<
    readonly BindingCreateEndpointCandidate[] | undefined
  >();
  const {
    candidates: sessionCandidates,
    nextCursor: sessionNextCursor,
    load: loadSessions,
    reset: resetSessionPages,
  } = sessionsAction;
  const [automationCandidates, setAutomationCandidates] = React.useState<readonly BindingCreateAutomationCandidate[]>([]);
  const [automationNextCursor, setAutomationNextCursor] = React.useState<string | undefined>();
  const [target, setTarget] = React.useState<BindingCreateTarget | undefined>();
  // A router's groups and routes, edited by the same owner the router editor uses.
  const [routerDraft, setRouterDraft] = React.useState<ConversationThreadRouterBindingTargetV1 | undefined>();
  const [newSessionDraft, setNewSessionDraft] = React.useState<unknown>();
  const [allowBotSenders, setAllowBotSenders] = React.useState(false);
  const [inputModeOverride, setInputModeOverride] = React.useState<BindingInputMode | undefined>();
  const [deliveryModeOverride, setDeliveryModeOverride] = React.useState<BindingSessionDeliveryMode | undefined>();
  const [automationResultDelivery, setAutomationResultDelivery] = React.useState<'finalResult' | 'none'>('none');
  const [permissionCeiling, setPermissionCeiling] = React.useState<AgentPermissionIntentV1>('read-only');
  const [approvals, setApprovals] = React.useState<BindingEditorSessionTarget['policy']['approvals']>({ kind: 'off' });
  const [retainedApprovalPrincipalIds, setRetainedApprovalPrincipalIds] = React.useState<readonly string[] | undefined>();
  const [linkPreviewPolicy, setLinkPreviewPolicy] = React.useState('suppress');
  const [senderFeedback, setSenderFeedback] = React.useState('off');
  const [feedback, setFeedback] = React.useState<BindingCreateFeedback | undefined>();
  const [resolverRefusal, setResolverRefusal] = React.useState<ResolverRefusal | undefined>();
  const showResolverNotReady = React.useCallback((failure: ConversationProviderFailureV1) => {
    const refusal = resolverRefusalOf(failure);
    setResolverRefusal(refusal);
    setFeedback(refusal === undefined ? 'resolverNotReady' : 'resolverRefused');
  }, []);
  const mountedRef = React.useRef(true);
  const restoreOpenerFocusRef = React.useRef(false);
  const availableConnections = React.useMemo(
    () => props.connections.filter((connection) => connection.deletionState === 'none'),
    [props.connections],
  );
  const currentConnection = availableConnections.find((connection) => connection.connectionId === connectionId);
  const providerDisplayName = useConversationProviderDisplayName(currentConnection?.providerPluginId)
    ?? props.t('plugins.channels.surface.providerFallback', 'Integration provider');
  // The surface previews the binding the create writer will persist, so the
  // omitted-field policy comes from that one contract owner rather than a
  // second copy of the same rule.
  const endpointAudience: BindingEndpointAudience = endpointSelection?.selected.audience ?? 'shared';
  const defaultInputMode: BindingInputMode = conversationBindingPolicyForOmittedFieldsV1(
    endpointAudience,
  ).inputMode;
  // Session delivery has the same shape: the create contract requires a value,
  // so the audience-derived answer comes from the one protocol owner instead of
  // a literal that would silently mirror a whole Session into a group room.
  const defaultDeliveryMode = conversationSessionBindingDeliveryModeForOmittedFieldV1(endpointAudience);
  const deliveryMode = deliveryModeOverride ?? defaultDeliveryMode;
  // The create writer rejects an incoming message policy the connection's
  // integration cannot deliver, so the same protocol owner decides what this
  // step is allowed to offer.
  const deliverableInputModes = deliverableBindingInputModes({
    audience: endpointAudience,
    ...(currentConnection === undefined ? {} : { connection: currentConnection }),
  });
  const requestedInputMode = inputModeOverride ?? defaultInputMode;
  const inputMode = deliverableInputModes.includes(requestedInputMode)
    ? requestedInputMode
    : deliverableInputModes[0]!;
  const selectedPrincipalSummary = principalSelection === undefined
    ? props.t('plugins.channels.surface.bindingCreatePrincipalFallback', 'Person')
    : principalSelection.selected.map((principal) => {
      const label = principalLabels[principal.id];
      return label !== undefined && label !== principal.id ? `${label} (${principal.id})` : principal.id;
    }).join(', ');
  const admittedPrincipalIds = principalSelection?.selected.map((principal) => principal.id) ?? [];
  // A thread router needs a parent new threads can start under; a thread or an
  // issue is itself a leaf.
  const routerParentSelected = endpointSelection?.selected.kind === 'direct'
    || endpointSelection?.selected.kind === 'shared';
  // A shared destination is proved, by the owner's choice, either by a message
  // posted where its people can see it (the destination itself or, for a
  // router, one of its own threads) or by the private message to the bot. A
  // direct destination keeps the private proof path and its link, no choice.
  const sharedDestinationPairing = pairingRequired && endpointSelection?.selected.audience === 'shared';
  const sharedProof = sharedDestinationPairing && proofLocationKind !== 'private';
  const proofThreadsAvailable = sharedDestinationPairing && target?.kind === 'threadRouter' && routerParentSelected;
  const selectedProofThread = proofThreadsAvailable && proofLocationKind === 'thread' ? proofThread : undefined;
  // Choosing "one of its topics" is an optional step: until one is chosen the
  // challenge cannot be created, and switching back restores the default.
  const proofLocationIncomplete = proofThreadsAvailable && proofLocationKind === 'thread' && proofThread === undefined;
  const proofEndpointSelection = sharedProof ? selectedProofThread?.selection ?? endpointSelection : undefined;
  // Each place is named by its title; what happens there is its description.
  const proofDestinationHint = props.t(
    'plugins.channels.surface.bindingCreateProofDestinationHint',
    'Post it in {place} as a new message, not a reply',
    { place: endpointLabel ?? props.t('plugins.channels.surface.bindingCreateEndpointFallback', 'Conversation') },
  );
  const proofThreadHint = proofLocationKind === 'thread' && proofThread !== undefined
    ? pairingPlaceLabel(proofThread.candidate, props.t)
    : props.t('plugins.channels.surface.bindingCreateProofThreadNone', 'Find the topic or thread below');
  const proofPrivateHint = props.t(
    'plugins.channels.surface.bindingCreateProofPrivateHint',
    'Open a private chat from a link or QR code. Only you see the code.',
  );
  const bindingCreateOutcomeUnknown = createAction.execution.status === 'outcomeUnknown';
  const pairingCreateOutcomeUnknown = pairingAction.execution.status === 'outcomeUnknown';
  const newSessionRecipeSelection = useBindingNewSessionRecipeSelection({
    signal: props.signal,
    isLocked: () => actionLocked,
    onStarted: () => setFeedback(undefined),
    onUnavailable: () => setFeedback('newSessionUnavailable'),
    onSelected: (recipe) => setNewSessionDraft(recipe),
  });
  const actionLocked = bindingCreateOutcomeUnknown
    || pairingCreateOutcomeUnknown
    || resolveAction.execution.status === 'pending'
    || createAction.execution.status === 'pending'
    || pairingAction.execution.status === 'pending'
    || sessionsAction.execution.status === 'pending'
    || automationAction.execution.status === 'pending'
    || newSessionRecipeSelection.pending;

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (connectionId !== undefined && availableConnections.some((connection) => connection.connectionId === connectionId)) {
      return;
    }
    setConnectionId(availableConnections[0]?.connectionId);
  }, [availableConnections, connectionId]);

  // The logical target is public and platform-neutral; the mounted host alone
  // decides whether this retained surface is current and can move physical
  // focus. A closed journey deliberately has no active stage target.
  React.useEffect(() => {
    if (stage !== 'closed') stageFocusTarget.focus();
  }, [stage, stageFocusTarget]);

  React.useEffect(() => {
    if (stage !== 'closed' || !restoreOpenerFocusRef.current) return;
    restoreOpenerFocusRef.current = false;
    openerFocusTarget.focus();
  }, [openerFocusTarget, stage]);

  const resetJourney = React.useCallback(() => {
    setStage('closed');
    setEndpointQuery('');
    setEndpointCandidates([]);
    setEndpointSelection(undefined);
    setEndpointLabel(undefined);
    setPrincipalQuery('');
    setPrincipalCandidates([]);
    setPrincipalSelection(undefined);
    setPrincipalLabels({});
    setPairingRequired(false);
    setPairingContext(undefined);
    setPairingCreateRequest(undefined);
    setProofThread(undefined);
    setProofLocationKind('destination');
    setProofThreadQuery('');
    setProofThreadCandidates(undefined);
    resetSessionPages();
    setAutomationCandidates([]);
    setAutomationNextCursor(undefined);
    setTarget(undefined);
    setRouterDraft(undefined);
    setNewSessionDraft(undefined);
    setAllowBotSenders(false);
    setInputModeOverride(undefined);
    setDeliveryModeOverride(undefined);
    setPermissionCeiling('read-only');
    setApprovals({ kind: 'off' });
    setRetainedApprovalPrincipalIds(undefined);
    setLinkPreviewPolicy('suppress');
    setSenderFeedback('off');
    setFeedback(undefined);
  }, [resetSessionPages]);

  const cancelJourney = React.useCallback(() => {
    restoreOpenerFocusRef.current = true;
    resetJourney();
  }, [resetJourney]);

  // Compose, do not merge: the just-created connection already exists through
  // its own connection Action, and this only opens the incumbent journey with
  // it preselected. No second mutation, receipt, or transaction is created.
  const consumedOpenRequestRef = React.useRef<Readonly<{ connectionId: string; requestId: number }> | undefined>(undefined);
  React.useEffect(() => {
    const request = props.openRequest;
    if (request === undefined || consumedOpenRequestRef.current === request) return;
    if (!availableConnections.some((connection) => connection.connectionId === request.connectionId)) {
      // The refreshed connection snapshot has not reached this journey yet.
      // Stay pending; this effect reruns when the rows arrive.
      return;
    }
    consumedOpenRequestRef.current = request;
    resetJourney();
    setConnectionId(request.connectionId);
    setStage('endpoint');
    props.onOpenConsumed?.();
  }, [availableConnections, props.onOpenConsumed, props.openRequest, resetJourney]);

  const onBindingCreateOutcomeReconciled = React.useCallback(() => {
    createAction.reset();
    resetJourney();
  }, [createAction.reset, resetJourney]);
  const requestCreateOutcomeReread = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown: bindingCreateOutcomeUnknown,
    resource: props.resource,
    onRefresh: props.onRefresh,
    onReconciled: onBindingCreateOutcomeReconciled,
  });
  const onPairingCreateRecovered = React.useCallback((pairing: BindingCreatePairingContext) => {
    pairingAction.reset();
    setPairingCreateRequest(undefined);
    setPairingContext(pairing);
    setFeedback(undefined);
  }, [pairingAction.reset]);
  const onPairingCreateNotFound = React.useCallback(() => {
    pairingAction.reset();
    setPairingCreateRequest(undefined);
    setFeedback('pairingUnavailable');
  }, [pairingAction.reset]);

  const openJourney = React.useCallback(() => {
    if (actionLocked || pairingContext !== undefined || availableConnections.length === 0) return;
    resetJourney();
    setConnectionId((current) => (
      availableConnections.some((connection) => connection.connectionId === current)
        ? current
        : availableConnections[0]?.connectionId
    ));
    setStage('endpoint');
  }, [actionLocked, availableConnections, pairingContext, resetJourney]);

  const backToEndpoint = React.useCallback(() => {
    if (actionLocked) return;
    setFeedback(undefined);
    setStage('endpoint');
  }, [actionLocked]);

  const backToPrincipal = React.useCallback(() => {
    if (actionLocked) return;
    // Pairing is a resolver outcome for the current principal search, not a
    // durable target choice. Returning to that search leaves its query intact
    // while requiring the next resolution to establish pairing again. A router
    // draft seeded for either path no longer matches the next resolution.
    setPairingRequired(false);
    setPairingContext(undefined);
    setRouterDraft(undefined);
    setProofThread(undefined);
    setProofLocationKind('destination');
    setProofThreadQuery('');
    setProofThreadCandidates(undefined);
    setFeedback(undefined);
    setStage('principal');
  }, [actionLocked]);

  const backToTarget = React.useCallback(() => {
    if (actionLocked) return;
    setFeedback(undefined);
    setStage('target');
  }, [actionLocked]);

  const backToPolicies = React.useCallback(() => {
    if (actionLocked) return;
    setFeedback(undefined);
    setStage('policies');
  }, [actionLocked]);

  const onConnectionChange = React.useCallback((next: string) => {
    if (pairingContext !== undefined || !availableConnections.some((connection) => connection.connectionId === next)) return;
    setConnectionId(next);
    setEndpointCandidates([]);
    setEndpointSelection(undefined);
    setEndpointLabel(undefined);
    setPrincipalCandidates([]);
    setPrincipalSelection(undefined);
    setPrincipalLabels({});
    setPairingRequired(false);
    setProofThread(undefined);
    setProofLocationKind('destination');
    setProofThreadQuery('');
    setProofThreadCandidates(undefined);
    setAutomationCandidates([]);
    setAutomationNextCursor(undefined);
    setTarget(undefined);
    setRouterDraft(undefined);
    setNewSessionDraft(undefined);
    setInputModeOverride(undefined);
    setFeedback(undefined);
    setStage('endpoint');
  }, [availableConnections, pairingContext]);

  const searchEndpoints = React.useCallback(async () => {
    if (currentConnection === undefined || actionLocked || props.signal.aborted) return;
    const parsedInput = ConversationBindingResolveInputV1Schema.safeParse({
      kind: 'endpoint',
      connectionId: currentConnection.connectionId,
      expectedConnectionRevision: currentConnection.revision,
      query: endpointQuery,
    });
    if (!parsedInput.success) {
      setFeedback('resolverUnavailable');
      return;
    }
    setFeedback(undefined);
    setEndpointCandidates([]);
    const settled = await resolveAction.execute(parsedInput.data);
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status !== 'success') {
      if (settled.status === 'error') setFeedback('resolverUnavailable');
      return;
    }
    const result = ConversationBindingResolveResultV1Schema.safeParse(settled.result);
    if (!result.success) {
      setFeedback('resolverUnavailable');
    } else if (result.data.kind === 'endpointCandidates') {
      setEndpointCandidates(result.data.candidates);
    } else if (result.data.kind === 'stale') {
      setFeedback('resolverStale');
    } else if (result.data.kind === 'notReady') {
      showResolverNotReady(result.data);
    } else {
      setFeedback('resolverUnavailable');
    }
  }, [actionLocked, currentConnection, endpointQuery, props.signal, resolveAction, showResolverNotReady]);

  const searchPrincipals = React.useCallback(async () => {
    if (currentConnection === undefined
      || endpointSelection === undefined
      || actionLocked
      || props.signal.aborted) {
      return;
    }
    const parsedInput = ConversationBindingResolveInputV1Schema.safeParse({
      kind: 'principal',
      connectionId: currentConnection.connectionId,
      expectedConnectionRevision: currentConnection.revision,
      endpointSelection,
      query: principalQuery,
    });
    if (!parsedInput.success) {
      setFeedback('resolverUnavailable');
      return;
    }
    setFeedback(undefined);
    setPrincipalCandidates([]);
    const settled = await resolveAction.execute(parsedInput.data);
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status !== 'success') {
      if (settled.status === 'error') setFeedback('resolverUnavailable');
      return;
    }
    const result = ConversationBindingResolveResultV1Schema.safeParse(settled.result);
    if (!result.success) {
      setFeedback('resolverUnavailable');
    } else if (result.data.kind === 'principalCandidates') {
      setPrincipalCandidates(result.data.candidates);
    } else if (result.data.kind === 'unavailable'
      && result.data.reason === 'principalResolveUnsupported') {
      // Pairing is a narrowly authorized fallback only for the missing
      // principal-resolution role. All other resolver states stay factual.
      setPairingRequired(true);
      setStage('target');
    } else if (result.data.kind === 'stale') {
      setFeedback('resolverStale');
    } else if (result.data.kind === 'notReady') {
      showResolverNotReady(result.data);
    } else {
      setFeedback('resolverUnavailable');
    }
  }, [actionLocked, currentConnection, endpointSelection, principalQuery, props.signal, resolveAction, showResolverNotReady]);

  /**
   * A shared router parent may accept the pairing code in one of its own
   * threads. The same endpoint resolver finds it; only authenticated threads
   * of the selected parent are offered, which is exactly what the pairing
   * writer accepts.
   */
  const searchProofThreads = React.useCallback(async () => {
    if (currentConnection === undefined
      || endpointSelection === undefined
      || actionLocked
      || props.signal.aborted) {
      return;
    }
    const parsedInput = ConversationBindingResolveInputV1Schema.safeParse({
      kind: 'endpoint',
      connectionId: currentConnection.connectionId,
      expectedConnectionRevision: currentConnection.revision,
      query: proofThreadQuery,
      kinds: ['thread'],
    });
    if (!parsedInput.success) {
      setFeedback('resolverUnavailable');
      return;
    }
    setFeedback(undefined);
    setProofThreadCandidates(undefined);
    const settled = await resolveAction.execute(parsedInput.data);
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status !== 'success') {
      if (settled.status === 'error') setFeedback('resolverUnavailable');
      return;
    }
    const result = ConversationBindingResolveResultV1Schema.safeParse(settled.result);
    if (!result.success) {
      setFeedback('resolverUnavailable');
    } else if (result.data.kind === 'endpointCandidates') {
      const parentId = endpointSelection.selected.id;
      setProofThreadCandidates(result.data.candidates.filter((candidate) => (
        candidate.kind === 'thread' && candidate.parentId === parentId
      )));
    } else if (result.data.kind === 'stale') {
      setFeedback('resolverStale');
    } else if (result.data.kind === 'notReady') {
      showResolverNotReady(result.data);
    } else {
      setFeedback('resolverUnavailable');
    }
  }, [actionLocked, currentConnection, endpointSelection, proofThreadQuery, props.signal, resolveAction, showResolverNotReady]);

  const loadAutomationTargets = React.useCallback(async (cursor?: string) => {
    if (actionLocked || props.signal.aborted) return;
    setFeedback(undefined);
    const settled = await automationAction.execute({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status !== 'success') {
      setFeedback('automationUnavailable');
      return;
    }
    const page = parseBindingCreateAutomationPage(settled.result);
    if (page === undefined || (cursor === undefined && page.candidates.length === 0)) {
      setFeedback('automationUnavailable');
      return;
    }
    setAutomationCandidates((previous) => {
      if (cursor === undefined) return page.candidates;
      const seen = new Set(previous.map((candidate) => candidate.automationId));
      return [...previous, ...page.candidates.filter((candidate) => {
        if (seen.has(candidate.automationId)) return false;
        seen.add(candidate.automationId);
        return true;
      })];
    });
    setAutomationNextCursor(page.nextCursor);
  }, [actionLocked, automationAction, props.signal]);

  const continueFromPrincipal = React.useCallback(() => {
    if (principalSelection === undefined || actionLocked) return;
    setStage('target');
    void loadSessions();
  }, [actionLocked, loadSessions, principalSelection]);

  React.useEffect(() => {
    if (stage === 'target' && pairingRequired && sessionCandidates.length === 0) {
      void loadSessions();
    }
  }, [loadSessions, pairingRequired, sessionCandidates.length, stage]);

  const selectNewSessionRecipe = newSessionRecipeSelection.select;

  const createSessionTarget = React.useMemo<BindingEditorSessionTarget | undefined>(() => {
    if (target?.kind !== 'session') return undefined;
    return {
      kind: 'session',
      sessionId: target.sessionId,
      policy: {
        deliveryMode,
        permissionCeiling,
        approvals,
        newSession: newSessionDraft === undefined
          ? { kind: 'off' }
          : { kind: 'enabled', recipe: newSessionDraft },
      },
    };
  }, [approvals, deliveryMode, newSessionDraft, permissionCeiling, target]);
  const createApprovalAudienceValid = createSessionTarget?.policy.approvals.kind !== 'enabled'
    || createSessionTarget.policy.approvals.principalIds === undefined
    || createSessionTarget.policy.approvals.principalIds.every((principalId) => admittedPrincipalIds.includes(principalId));
  const updateCreateSessionTarget = React.useCallback((
    transform: (target: BindingEditorSessionTarget) => BindingEditorSessionTarget,
  ) => {
    if (createSessionTarget === undefined) return;
    const next = transform(createSessionTarget);
    setDeliveryModeOverride(next.policy.deliveryMode === defaultDeliveryMode ? undefined : next.policy.deliveryMode);
    setPermissionCeiling(next.policy.permissionCeiling);
    setApprovals(next.policy.approvals);
    setNewSessionDraft(next.policy.newSession.kind === 'enabled' ? next.policy.newSession.recipe : undefined);
  }, [createSessionTarget, defaultDeliveryMode]);
  const createTarget = React.useMemo(() => {
    if (target === undefined) return undefined;
    if (target.kind === 'automation') {
      return {
        kind: 'automation',
        automationId: target.automationId,
        policy: { resultDelivery: automationResultDelivery },
      };
    }
    if (target.kind === 'threadRouter') return routerDraft;
    return createSessionTarget;
  }, [automationResultDelivery, createSessionTarget, routerDraft, target]);

  const createBinding = React.useCallback(async () => {
    if (currentConnection === undefined
      || endpointSelection === undefined
      || principalSelection === undefined
      || createTarget === undefined
      || !createApprovalAudienceValid
      || actionLocked
      || props.signal.aborted) {
      return;
    }
    const parsedInput = ConversationBindingCreateInputV1Schema.safeParse({
      connectionId: currentConnection.connectionId,
      expectedConnectionRevision: currentConnection.revision,
      endpointSelection,
      principalSelection,
      target: createTarget,
      allowBotSenders,
      ...(inputModeOverride === undefined ? {} : { inputMode: inputModeOverride }),
      linkPreviewPolicy,
      senderFeedback,
      enabled: true,
    });
    if (!parsedInput.success) {
      setFeedback('createUnavailable');
      return;
    }
    setFeedback(undefined);
    const settled = await createAction.execute(parsedInput.data);
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status !== 'success') {
      if (settled.status === 'error') setFeedback('createUnavailable');
      return;
    }
    const result = ConversationBindingCreateResultV1Schema.safeParse(settled.result);
    if (!result.success || result.data.kind === 'unavailable' || result.data.kind === 'notReady') {
      setFeedback('createUnavailable');
    } else if (result.data.kind === 'stale') {
      setFeedback('resolverStale');
    } else if (result.data.kind === 'notVerified') {
      setFeedback(bindingTargetVerificationFeedback(result.data.reason));
    } else {
      // The Resource remains the only bindings-list projection owner.
      setFeedback('created');
      setCreatedBindingId(result.data.binding.id);
      props.onRefresh();
      props.onCreated?.(result.data.binding.id);
    }
  }, [
    actionLocked,
    allowBotSenders,
    createApprovalAudienceValid,
    createAction,
    createTarget,
    currentConnection,
    endpointSelection,
    inputModeOverride,
    linkPreviewPolicy,
    principalSelection,
    props.onRefresh,
    props.signal,
    senderFeedback,
  ]);

  const createPairing = React.useCallback(async () => {
    if (currentConnection === undefined
      || endpointSelection === undefined
      || createTarget === undefined
      || actionLocked
      || props.signal.aborted) {
      return;
    }
    const pairingRequestId = createPairingRequestId();
    if (pairingRequestId === null) {
      setFeedback('createUnavailable');
      return;
    }
    const parsedInput = ConversationPairingCreateInputV1Schema.safeParse({
      connectionId: currentConnection.connectionId,
      expectedConnectionRevision: currentConnection.revision,
      // The daemon rejoins this exact key after a response loss, and recovery
      // matches it instead of connection+revision, so a second device's
      // superseding challenge can never be adopted here.
      pairingRequestId,
      // Pairing binds the conversation chosen here. A direct one is proved in
      // a private message; a shared one where its people can see the code.
      endpointSelection,
      ...(proofEndpointSelection === undefined ? {} : { proofEndpointSelection }),
      target: createTarget,
    });
    if (!parsedInput.success) {
      setFeedback('createUnavailable');
      return;
    }
    setPairingCreateRequest({
      connectionId: parsedInput.data.connectionId,
      expectedConnectionRevision: parsedInput.data.expectedConnectionRevision,
      pairingRequestId: parsedInput.data.pairingRequestId,
    });
    setFeedback(undefined);
    const settled = await pairingAction.execute(parsedInput.data);
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status !== 'success') {
      if (settled.status === 'error') {
        setPairingCreateRequest(undefined);
        setFeedback(pairingCreateRefusalFeedback(settled.code));
      }
      return;
    }
    const result = ConversationPairingCreateResultV1Schema.safeParse(settled.result);
    if (!result.success) {
      setPairingCreateRequest(undefined);
      setFeedback('targetNotVerified');
      return;
    }
    if (result.data.kind === 'notVerified') {
      setPairingCreateRequest(undefined);
      setFeedback(bindingTargetVerificationFeedback(result.data.reason));
      return;
    }
    if (result.data.kind !== 'created') {
      setPairingCreateRequest(undefined);
      setFeedback('targetNotVerified');
      return;
    }
    setPairingCreateRequest(undefined);
    setPairingContext({
      generationId: result.data.generationId,
      challengeId: result.data.challengeId,
      expiresAt: result.data.expiresAt,
    });
  }, [actionLocked, createTarget, currentConnection, endpointSelection, pairingAction, proofEndpointSelection, props.signal]);

  const feedbackContent = (() => {
    if (bindingCreateOutcomeUnknown) {
      return (
        <Banner
          testID="channels-binding-create-outcome-unknown"
          tone="warning"
          title={props.t('plugins.channels.surface.bindingCreateUnknownTitle', 'Could not confirm binding creation')}
          description={props.t(
            'plugins.channels.surface.bindingCreateUnknownDescription',
            'The binding may already exist. Refresh its authoritative list before deciding what to do next.',
          )}
          action={(
            <Action.Refresh
              testID="channels-binding-create-outcome-unknown-refresh"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={requestCreateOutcomeReread}
            />
          )}
        />
      );
    }
    if (feedback === 'created') {
      const openCreated = props.onOpenCreated;
      return (
        <Stack gap="small">
          <Status tone="secondary" label={props.t('plugins.channels.surface.bindingCreateCreated', 'Binding created')} />
          {openCreated === undefined || createdBindingId === undefined ? null : (
            <Button
              testID="channels-binding-create-open-in-channels"
              variant="secondary"
              title={props.t('plugins.channels.surface.openInChannels', 'Open in Channels')}
              onPress={() => openCreated(createdBindingId)}
            />
          )}
        </Stack>
      );
    }
    if (feedback === undefined) return null;
    if (feedback === 'resolverRefused') {
      if (resolverRefusal === undefined) return null;
      const [refusedTitle, refusedDescription] = resolverRefusalCopy(resolverRefusal, props.t);
      return <Banner tone="warning" title={refusedTitle} description={refusedDescription} />;
    }
    const copy: Readonly<Record<Exclude<BindingCreateFeedback, 'created' | 'resolverRefused'>, readonly [string, string]>> = {
      resolverUnavailable: [
        props.t('plugins.channels.surface.bindingCreateUnavailableTitle', 'Binding setup is unavailable'),
        props.t('plugins.channels.surface.bindingCreateUnavailableDescription', 'Refresh connection details and try this selection again.'),
      ],
      resolverStale: [
        props.t('plugins.channels.surface.bindingCreateStaleTitle', 'The selected connection changed'),
        props.t('plugins.channels.surface.bindingCreateStaleDescription', 'Refresh binding details and make a new selection.'),
      ],
      resolverNotReady: [
        props.t('plugins.channels.surface.bindingCreateNotReadyTitle', 'Binding setup is not ready'),
        props.t('plugins.channels.surface.bindingCreateNotReadyDescription', 'Wait for the provider to become ready, then search again.'),
      ],
      sessionUnavailable: [
        props.t('plugins.channels.surface.bindingCreateSessionUnavailableTitle', 'Sessions are unavailable'),
        props.t('plugins.channels.surface.bindingCreateSessionUnavailableDescription', 'Refresh and try choosing a Session again.'),
      ],
      automationUnavailable: [
        props.t('plugins.channels.surface.bindingCreateAutomationUnavailableTitle', 'Automations are unavailable'),
        props.t('plugins.channels.surface.bindingCreateAutomationUnavailableDescription', 'Refresh and try choosing an Automation again.'),
      ],
      newSessionUnavailable: [
        props.t('plugins.channels.surface.bindingCreateNewSessionUnavailable', 'A new Session could not be configured'),
        props.t('plugins.channels.surface.bindingCreateNewSessionUnavailableDescription', 'The binding will continue to use the selected existing Session.'),
      ],
      targetNotVerified: [
        props.t('plugins.channels.surface.bindingCreateTargetNotVerifiedTitle', 'The selected target is no longer available'),
        props.t('plugins.channels.surface.bindingCreateTargetNotVerifiedDescription', 'Choose a current target before trying again.'),
      ],
      targetResultDeliveryUnavailable: [
        props.t(
          'plugins.channels.surface.bindingCreateResultDeliveryUnavailableTitle',
          'This Automation cannot return a final result',
        ),
        props.t(
          'plugins.channels.surface.bindingCreateResultDeliveryUnavailableDescription',
          'Choose "Do not reply" to save this binding. The Automation still runs; only the reply back to the conversation is unavailable.',
        ),
      ],
      createUnavailable: [
        props.t('plugins.channels.surface.bindingCreateUnavailableTitle', 'Could not create the binding'),
        props.t('plugins.channels.surface.bindingCreateUnavailableDescription', 'Refresh binding details and make a new selection.'),
      ],
      pairingUnavailable: [
        props.t('plugins.channels.surface.bindingCreatePairingUnavailableTitle', 'Pairing status is unavailable'),
        props.t(
          'plugins.channels.surface.bindingCreatePairingUnavailableDescription',
          'No current pairing challenge was found. Create a new challenge to try again.',
        ),
      ],
      pairingRouterBootstrapInvalid: [
        props.t('plugins.channels.surface.bindingCreatePairingRouterGroupTitle', 'Pairing needs one empty sender group'),
        props.t(
          'plugins.channels.surface.bindingCreatePairingRouterGroupDescription',
          'Go back to Policies and keep a single sender group. The person who pairs joins it; you can add groups after the router is set up.',
        ),
      ],
      pairingProofMismatch: [
        props.t('plugins.channels.surface.bindingCreatePairingProofMismatchTitle', 'The code can’t be accepted there'),
        props.t(
          'plugins.channels.surface.bindingCreatePairingProofMismatchDescription',
          'Choose the conversation you are connecting, or one of its own topics, then create the challenge again.',
        ),
      ],
      pairingProofUnavailable: [
        props.t('plugins.channels.surface.bindingCreatePairingProofUnavailableTitle', 'Couldn’t check where to send the code'),
        props.t(
          'plugins.channels.surface.bindingCreatePairingProofUnavailableDescription',
          'The connection or its provider isn’t reachable right now. Nothing was created; try again in a moment.',
        ),
      ],
    };
    const [title, description] = copy[feedback];
    return <Banner tone="warning" title={title} description={description} />;
  })();

  // Two bots can share a name across providers ("Happier QA Bot" on Discord and Telegram): each
  // option says which provider it talks through.
  const resolveConnectionProviderName = useConversationProviderDisplayNameResolver();
  const connectionOptions = availableConnections.map((connection) => {
    const providerName = resolveConnectionProviderName(connection.providerPluginId);
    return {
      value: connection.connectionId,
      label: connection.integrationPrincipalLabel
        ?? props.t('plugins.channels.surface.providerFallback', 'Conversation connection'),
      ...(providerName === undefined ? {} : { description: providerName }),
    };
  });

  return (
    <Stack gap="medium" testID="channels-binding-create">
      {/* A link needs a connection first: say so rather than offer a button that cannot succeed. */}
      {availableConnections.length === 0 || stage !== 'closed' ? null : (
        <Button
          testID="channels-binding-create-open"
          title={props.t('plugins.channels.surface.bindingCreateAction', 'Add binding')}
          variant="secondary"
          focusTarget={openerFocusTarget}
          disabled={actionLocked || pairingContext !== undefined}
          onPress={openJourney}
        />
      )}
      {availableConnections.length === 0 ? (
        <Text
          tone="secondary"
          value={props.t(
            'plugins.channels.surface.bindingCreateNoConnection',
            'Create an active conversation connection before adding a binding.',
          )}
        />
      ) : null}
      {stage === 'closed' ? feedbackContent : (
        <Stack gap="medium" testID="channels-binding-create-flow">
          {/* Each step's heading takes focus when the step opens, which names the step once. */}
          {availableConnections.length > 1 ? (
            <Form.Select
              testID="channels-binding-create-connection"
              label={props.t('plugins.channels.surface.bindingCreateConnection', 'Connection')}
              options={connectionOptions}
              value={connectionId}
              disabled={actionLocked || pairingContext !== undefined}
              onChange={(next) => {
                if (typeof next === 'string') onConnectionChange(next);
              }}
            />
          ) : null}
          {stage === 'endpoint' ? (
            <Stack gap="small">
              <Heading
                level={2}
                value={props.t('plugins.channels.surface.bindingCreateEndpoint', 'Choose a conversation')}
                focusTarget={stageFocusTarget}
              />
              <Row gap="small" align="flex-end">
                <Stack grow>
                  <Form.TextField
                    testID="channels-binding-create-endpoint-query"
                    label={props.t('plugins.channels.surface.bindingCreateEndpointQuery', 'Conversation search')}
                    value={endpointQuery}
                    onChange={setEndpointQuery}
                    disabled={actionLocked}
                  />
                </Stack>
                <Button
                  title={props.t('plugins.channels.surface.bindingCreateEndpointSearch', 'Search endpoints')}
                  variant="secondary"
                  busy={resolveAction.execution.status === 'pending'}
                  disabled={actionLocked || endpointQuery.trim() === ''}
                  onPress={searchEndpoints}
                />
              </Row>
              {endpointCandidates.length > 0 ? (
                <List accessibilityLabel={props.t('plugins.channels.surface.bindingCreateEndpointCandidates', 'Endpoint candidates')}>
                  {endpointCandidates.map((candidate) => (
                    <List.Item
                      key={`${candidate.kind}:${candidate.id}`}
                      title={candidate.label ?? props.t('plugins.channels.surface.bindingCreateEndpointFallback', 'Conversation')}
                      subtitle={candidate.parentLabel}
                      disabled={actionLocked}
                      onPress={() => {
                        setEndpointSelection(bindingCreateEndpointSelection(endpointQuery, candidate));
                        setEndpointLabel(candidate.label ?? props.t('plugins.channels.surface.bindingCreateEndpointFallback', 'Conversation'));
                        setPrincipalQuery('');
                        setPrincipalCandidates([]);
                        setPrincipalSelection(undefined);
                        setPrincipalLabels({});
                        setPairingRequired(false);
                        setProofThread(undefined);
                        setProofLocationKind('destination');
                        setProofThreadCandidates(undefined);
    setProofLocationKind('destination');
    setProofThreadQuery('');
    setProofThreadCandidates(undefined);
                        setAutomationCandidates([]);
                        setAutomationNextCursor(undefined);
                        setInputModeOverride(undefined);
                        setFeedback(undefined);
                        setStage('principal');
                      }}
                    />
                  ))}
                </List>
              ) : null}
              <BindingCreateStepActions
                disabled={actionLocked}
                onCancel={cancelJourney}
                t={props.t}
              />
            </Stack>
          ) : null}
          {stage === 'principal' ? (
            <Stack gap="small">
              <Heading
                level={2}
                value={props.t('plugins.channels.surface.bindingCreatePrincipal', 'Choose an allowed sender')}
                focusTarget={stageFocusTarget}
              />
              <Row gap="small" align="flex-end">
                <Stack grow>
                  <Form.TextField
                    testID="channels-binding-create-principal-query"
                    label={props.t('plugins.channels.surface.bindingCreatePrincipalQuery', 'People search')}
                    value={principalQuery}
                    onChange={setPrincipalQuery}
                    disabled={actionLocked}
                  />
                </Stack>
                <Button
                  title={props.t('plugins.channels.surface.bindingCreatePrincipalSearch', 'Search people')}
                  variant="secondary"
                  busy={resolveAction.execution.status === 'pending'}
                  disabled={actionLocked || principalQuery.trim() === ''}
                  onPress={searchPrincipals}
                />
              </Row>
              <BindingPrincipalChoices
                testID="channels-binding-create-principal-candidates"
                label={props.t('plugins.channels.surface.bindingCreatePrincipalCandidates', 'Allowed sender candidates')}
                candidates={principalCandidates.flatMap((candidate) => (
                  bindingCreatePrincipalSelection(principalQuery, candidate) === undefined ? [] : [candidate]
                ))}
                selected={(principalSelection?.selected ?? []).map((principal) => ({
                  id: principal.id,
                  kind: principal.kind,
                  ...(principalLabels[principal.id] === undefined ? {} : { label: principalLabels[principal.id] }),
                }))}
                disabled={actionLocked}
                onToggle={(candidate) => {
                  const next = bindingCreatePrincipalSelection(principalQuery, candidate, principalSelection);
                  setPrincipalSelection(next);
                  const label = candidate.label;
                  if (label !== undefined) setPrincipalLabels((current) => ({ ...current, [candidate.id]: label }));
                  setAllowBotSenders(next?.selected.some((principal) => principal.kind === 'bot') === true);
                  setFeedback(undefined);
                }}
              />
              <BindingCreateStepActions
                disabled={actionLocked}
                onBack={backToEndpoint}
                onCancel={cancelJourney}
                primary={(
                  <Button
                    title={props.t('plugins.channels.surface.bindingCreateContinue', 'Continue')}
                    disabled={actionLocked || principalSelection === undefined}
                    onPress={continueFromPrincipal}
                  />
                )}
                t={props.t}
              />
            </Stack>
          ) : null}
          {stage === 'target' ? (
            <Stack gap="small">
              <Heading
                level={2}
                value={props.t('plugins.channels.surface.bindingCreateTarget', 'Choose a target')}
                focusTarget={stageFocusTarget}
              />
              {pairingRequired ? (
                <Banner
                  tone="secondary"
                  title={props.t('plugins.channels.surface.bindingCreatePairingTitle', 'Pairing is required')}
                  description={props.t(
                    'plugins.channels.surface.bindingCreatePairingDescription',
                    'This provider cannot resolve individual senders. Create a pairing challenge for the selected target instead.',
                  )}
                />
              ) : null}
              {/*
                Any conversation new threads can start under may route them: a
                mailbox, a forum group or a channel, whether its people were
                resolved by the provider or will be proved by pairing.
              */}
              {!routerParentSelected ? null : (
                <ItemGroup
                  testID="channels-binding-create-router-option"
                  title={props.t('plugins.channels.surface.bindingCreateRouterTitle', 'A session for each thread')}
                  description={props.t(
                    'plugins.channels.surface.bindingCreateRouterDescription',
                    'Every new thread starts its own session, chosen by routes you set next.',
                  )}
                >
                  <Item
                    testID="channels-binding-target-router"
                    icon={<Icon name="conversations" />}
                    title={props.t('plugins.channels.surface.bindingCreateRouter', 'Route new threads')}
                    subtitle={pairingRequired
                      ? props.t(
                        'plugins.channels.surface.bindingCreateRouterPairingSubtitle',
                        'The person who pairs starts in one sender group',
                      )
                      : props.t(
                        'plugins.channels.surface.bindingCreateRouterSubtitle',
                        'Everyone you allowed starts in one sender group',
                      )}
                    disabled={actionLocked}
                    onPress={() => {
                      setTarget({
                        kind: 'threadRouter',
                        label: props.t('plugins.channels.surface.bindingCreateRouter', 'Route new threads'),
                      });
                      // A paired router starts with one named, empty group: the
                      // person who proves themselves fills it at finalize. No
                      // member is typed or guessed here.
                      setRouterDraft((current) => current ?? {
                        kind: 'threadRouter',
                        principalGroups: [{ id: 'senders', principalIds: pairingRequired ? [] : admittedPrincipalIds }],
                        routes: [],
                      });
                      setNewSessionDraft(undefined);
                      setStage('policies');
                    }}
                  />
                </ItemGroup>
              )}
              <BindingTargetCandidateList
                sessionCandidates={sessionCandidates}
                automationCandidates={automationCandidates}
                disabled={actionLocked}
                onSession={(candidate) => {
                  setTarget({ kind: 'session', sessionId: candidate.id, label: candidate.label });
                  setNewSessionDraft(undefined);
                  setStage('policies');
                }}
                onAutomation={(candidate) => {
                  setTarget({
                    kind: 'automation',
                    automationId: candidate.automationId,
                    label: candidate.label,
                    execution: candidate.execution,
                  });
                  setNewSessionDraft(undefined);
                  setStage('policies');
                }}
                t={props.t}
              />
              <Row gap="small" align="center" wrap>
                <Button
                  title={props.t('plugins.channels.surface.bindingCreateSessionReload', 'Reload Sessions')}
                  variant="plain"
                  busy={sessionsAction.execution.status === 'pending'}
                  disabled={actionLocked}
                  onPress={() => { void loadSessions(); }}
                />
                {sessionNextCursor === undefined ? null : (
                  <Button
                    title={props.t('plugins.channels.surface.bindingCreateSessionLoadMore', 'Show more Sessions')}
                    variant="plain"
                    busy={sessionsAction.execution.status === 'pending'}
                    disabled={actionLocked}
                    onPress={() => { void loadSessions(sessionNextCursor); }}
                  />
                )}
                {automationCandidates.length === 0 ? (
                  <Button
                    title={props.t('plugins.channels.surface.bindingCreateAutomationLoad', 'Show Automations')}
                    variant="secondary"
                    busy={automationAction.execution.status === 'pending'}
                    disabled={actionLocked}
                    onPress={() => { void loadAutomationTargets(); }}
                  />
                ) : null}
                {automationNextCursor === undefined ? null : (
                  <Button
                    title={props.t('plugins.channels.surface.bindingCreateAutomationLoadMore', 'Show more Automations')}
                    variant="plain"
                    busy={automationAction.execution.status === 'pending'}
                    disabled={actionLocked}
                    onPress={() => { void loadAutomationTargets(automationNextCursor); }}
                  />
                )}
              </Row>
              <BindingCreateStepActions
                disabled={actionLocked}
                onBack={backToPrincipal}
                onCancel={cancelJourney}
                t={props.t}
              />
            </Stack>
          ) : null}
          {stage === 'policies' && target !== undefined ? (
            <Stack gap="small">
              <Heading
                level={2}
                value={props.t('plugins.channels.surface.bindingCreatePolicies', 'Policies')}
                focusTarget={stageFocusTarget}
              />
              <BindingInputModeCapabilityNotice
                deliverableInputModes={deliverableInputModes}
                testID="channels-binding-create-input-mode-capability"
                t={props.t}
              />
              <Form.Select
                testID="channels-binding-create-input-mode"
                label={props.t('plugins.channels.surface.bindingCreateInputMode', 'Incoming messages')}
                options={bindingInputModeOptions(deliverableInputModes, props.t)}
                value={inputMode}
                disabled={actionLocked}
                onChange={(next) => {
                  if (isBindingInputMode(next) && deliverableInputModes.includes(next)) {
                    setInputModeOverride(next === defaultInputMode ? undefined : next);
                  }
                }}
              />
              {target.kind === 'session' ? (
                createSessionTarget === undefined ? null : (
                  <BindingSessionTargetPolicyControls
                    target={createSessionTarget}
                    admittedPrincipalIds={admittedPrincipalIds}
                    retainedApprovalPrincipalIds={retainedApprovalPrincipalIds}
                    disabled={actionLocked}
                    configureNewSessionAvailable={newSessionRecipeSelection.available}
                    onChange={updateCreateSessionTarget}
                    onRetainApprovalPrincipalIds={setRetainedApprovalPrincipalIds}
                    onConfigureNewSession={selectNewSessionRecipe}
                    t={props.t}
                  />
                )
              ) : null}
              {target.kind === 'threadRouter' && routerDraft !== undefined ? (
                <ThreadRouterControls
                  target={routerDraft}
                  admittedPrincipalIds={admittedPrincipalIds}
                  membership={pairingRequired ? 'pairing' : 'resolved'}
                  disabled={actionLocked}
                  signal={props.signal}
                  onChange={(transform) => setRouterDraft((current) => (current === undefined ? current : transform(current)))}
                  onRecipeUnavailable={() => setFeedback('newSessionUnavailable')}
                  t={props.t}
                />
              ) : null}
              {target.kind === 'automation' ? (
                <Form.Select
                  testID="channels-binding-create-automation-result-delivery"
                  label={props.t('plugins.channels.surface.bindingCreateAutomationDelivery', 'Automation result delivery')}
                  options={[
                    { value: 'none', label: bindingDeliveryModeLabel('none', props.t) },
                    { value: 'finalResult', label: bindingDeliveryModeLabel('finalResult', props.t) },
                  ]}
                  value={automationResultDelivery}
                  disabled={actionLocked}
                  onChange={(resultDelivery) => {
                    if (resultDelivery !== 'none' && resultDelivery !== 'finalResult') return;
                    setAutomationResultDelivery(resultDelivery);
                  }}
                />
              ) : null}
              <Form.Toggle
                testID="channels-binding-create-allow-bots"
                label={props.t('plugins.channels.surface.bindingCreateAllowBots', 'Allow bot senders')}
                value={allowBotSenders}
                disabled={actionLocked}
                onChange={setAllowBotSenders}
              />
              <Form.Select
                testID="channels-binding-create-link-preview"
                label={props.t('plugins.channels.surface.bindingCreateLinkPreview', 'Link previews')}
                options={[
                  { value: 'suppress', label: props.t('plugins.channels.surface.bindingCreateLinkPreviewSuppress', 'Suppress previews') },
                  { value: 'providerDefault', label: props.t('plugins.channels.surface.bindingCreateLinkPreviewProviderDefault', 'Provider default') },
                ]}
                value={linkPreviewPolicy}
                disabled={actionLocked}
                onChange={(next) => { if (typeof next === 'string') setLinkPreviewPolicy(next); }}
              />
              <Form.Select
                testID="channels-binding-create-sender-feedback"
                label={props.t('plugins.channels.surface.bindingCreateSenderFeedback', 'Sender feedback')}
                options={[
                  { value: 'off', label: props.t('plugins.channels.surface.bindingCreateSenderFeedbackOff', 'Off') },
                  { value: 'eligibleRefusals', label: props.t('plugins.channels.surface.bindingCreateSenderFeedbackRefusals', 'Eligible refusals') },
                ]}
                value={senderFeedback}
                disabled={actionLocked}
                onChange={(next) => { if (typeof next === 'string') setSenderFeedback(next); }}
              />
              <BindingCreateStepActions
                disabled={actionLocked}
                onBack={backToTarget}
                onCancel={cancelJourney}
                primary={(
                  <Button
                    title={props.t('plugins.channels.surface.bindingCreateReview', 'Review binding')}
                    disabled={actionLocked || !createApprovalAudienceValid}
                    onPress={() => setStage('review')}
                  />
                )}
                t={props.t}
              />
            </Stack>
          ) : null}
          {stage === 'review'
            && target !== undefined
            && pairingCreateOutcomeUnknown
            && pairingCreateRequest !== undefined ? (
              <BindingCreatePairingRecovery
                connectionId={pairingCreateRequest.connectionId}
                pairingRequestId={pairingCreateRequest.pairingRequestId}
                onRecovered={onPairingCreateRecovered}
                onNotFound={onPairingCreateNotFound}
                t={props.t}
              />
            ) : null}
          {stage === 'review'
            && target !== undefined
            && !pairingCreateOutcomeUnknown
            && pairingContext !== undefined ? (
            <BindingCreatePairingHandoff
              pairing={pairingContext}
              signal={props.signal}
              onBindingsRefresh={props.onRefresh}
              onCompleted={(bindingId) => {
                // The pairing view is finished: the returned binding continues
                // through the existing binding editor, which is the one owner
                // of reviewing and enabling a saved binding.
                resetJourney();
                props.onPairingCompleted?.(bindingId);
              }}
              onClose={cancelJourney}
              t={props.t}
            />
          ) : null}
          {stage === 'review'
            && target !== undefined
            && !pairingCreateOutcomeUnknown
            && pairingContext === undefined ? (
            <Stack gap="small">
              <Heading
                level={2}
                value={props.t('plugins.channels.surface.bindingCreateReview', 'Review binding')}
                focusTarget={stageFocusTarget}
              />
              {/*
                Shared proof: the conversation being connected and the place the
                code is posted are two facts, shown as two rows. The code is
                visible to everyone there, which the description says before
                the challenge exists.
              */}
              {!sharedDestinationPairing ? null : (
                <ItemGroup
                  testID="channels-binding-create-proof-location"
                  title={props.t('plugins.channels.surface.bindingCreateProofTitle', 'Where to send the code')}
                  description={props.t(
                    'plugins.channels.surface.bindingCreateProofChoiceDescription',
                    'Connecting {destination}. The pairing code proves who you are; you check who sent it before anything is turned on.',
                    { destination: endpointLabel ?? props.t('plugins.channels.surface.bindingCreateEndpointFallback', 'Conversation') },
                  )}
                  accessibilityRole="radiogroup"
                >
                  <Item
                    testID="channels-binding-create-proof-kind:destination"
                    accessibilityRole="radio"
                    selected={proofLocationKind === 'destination'}
                    disabled={actionLocked}
                    title={props.t('plugins.channels.surface.bindingCreateProofDestination', 'This conversation')}
                    accessibilityLabel={props.t('plugins.channels.surface.bindingCreateProofDestination', 'This conversation')}
                    subtitle={proofDestinationHint}
                    accessibilityHint={proofDestinationHint}
                    onPress={() => setProofLocationKind('destination')}
                  />
                  {!proofThreadsAvailable ? null : (
                    <Item
                      testID="channels-binding-create-proof-kind:thread"
                      accessibilityRole="radio"
                      selected={proofLocationKind === 'thread'}
                      disabled={actionLocked}
                      title={props.t('plugins.channels.surface.bindingCreateProofThread', 'One of its topics')}
                      accessibilityLabel={props.t('plugins.channels.surface.bindingCreateProofThread', 'One of its topics')}
                      subtitle={proofThreadHint}
                      accessibilityHint={proofThreadHint}
                      onPress={() => setProofLocationKind('thread')}
                    />
                  )}
                  <Item
                    testID="channels-binding-create-proof-kind:private"
                    accessibilityRole="radio"
                    selected={proofLocationKind === 'private'}
                    disabled={actionLocked}
                    title={props.t('plugins.channels.surface.bindingCreateProofPrivate', 'A private message to the bot')}
                    accessibilityLabel={props.t('plugins.channels.surface.bindingCreateProofPrivate', 'A private message to the bot')}
                    subtitle={proofPrivateHint}
                    accessibilityHint={proofPrivateHint}
                    onPress={() => setProofLocationKind('private')}
                  />
                </ItemGroup>
              )}
              {!proofThreadsAvailable || proofLocationKind !== 'thread' ? null : (
                <ItemGroup
                  testID="channels-binding-create-proof-thread"
                  title={props.t('plugins.channels.surface.bindingCreateProofThreadQuery', 'Topic or thread')}
                  description={props.t(
                    'plugins.channels.surface.bindingCreateProofThreadDescription',
                    'Search the topics and threads of {parent} by name or ID.',
                    { parent: endpointLabel ?? props.t('plugins.channels.surface.bindingCreateEndpointFallback', 'Conversation') },
                  )}
                >
                  <Item
                    title={props.t('plugins.channels.surface.bindingCreateProofThreadQuery', 'Topic or thread')}
                    accessoryWraps
                    accessoryOutsidePressable
                    accessory={(
                      <Row gap="small" align="center" wrap>
                        <Form.TextField
                          testID="channels-binding-create-proof-thread-query"
                          label={props.t('plugins.channels.surface.bindingCreateProofThreadQuery', 'Topic or thread')}
                          presentation="field"
                          value={proofThreadQuery}
                          autoCapitalize="none"
                          disabled={actionLocked}
                          onChange={setProofThreadQuery}
                        />
                        <Button
                          testID="channels-binding-create-proof-thread-search"
                          variant="secondary"
                          title={props.t('plugins.channels.surface.bindingCreateProofThreadSearch', 'Find')}
                          busy={resolveAction.execution.status === 'pending'}
                          disabled={actionLocked || proofThreadQuery.trim() === ''}
                          onPress={searchProofThreads}
                        />
                      </Row>
                    )}
                  />
                  {proofThreadCandidates === undefined
                    ? null
                    : proofThreadCandidates.length === 0 ? (
                      <Item
                        testID="channels-binding-create-proof-thread-empty"
                        subtitle={props.t(
                          'plugins.channels.surface.bindingCreateProofThreadEmpty',
                          'No topic or thread of {parent} matches. Search by its name or ID.',
                          { parent: endpointLabel ?? props.t('plugins.channels.surface.bindingCreateEndpointFallback', 'Conversation') },
                        )}
                      />
                    ) : proofThreadCandidates.map((candidate) => (
                      <Item
                        key={candidate.id}
                        testID={`channels-binding-create-proof-thread:${candidate.id}`}
                        title={pairingPlaceLabel(candidate, props.t)}
                        subtitle={candidate.id}
                        selected={proofThread?.candidate.id === candidate.id}
                        disabled={actionLocked}
                        onPress={() => {
                          setProofThread({
                            candidate,
                            selection: bindingCreateEndpointSelection(proofThreadQuery, candidate, ['thread']),
                          });
                          setFeedback(undefined);
                        }}
                      />
                    ))}
                </ItemGroup>
              )}
              {!sharedProof || proofLocationIncomplete ? null : (
                <Banner
                  testID="channels-binding-create-proof-race"
                  tone="secondary"
                  title={props.t(
                    'plugins.channels.surface.bindingCreatePairingSharedRaceTitle',
                    'Anyone in {place} can see this code',
                    { place: selectedProofThread === undefined
                      ? endpointLabel ?? props.t('plugins.channels.surface.bindingCreateEndpointFallback', 'Conversation')
                      : pairingPlaceLabel(selectedProofThread.candidate, props.t) },
                  )}
                  description={props.t(
                    'plugins.channels.surface.bindingCreatePairingSharedRaceDescription',
                    'Whoever sends it first is proposed. You see who it was, and nothing is turned on until you approve them.',
                  )}
                />
              )}
              <Banner
                testID="channels-binding-create-privacy-disclosure"
                tone="secondary"
                title={surface.accountEncryptionMode === 'plain'
                  ? props.t(
                    'plugins.channels.surface.bindingCreatePrivacyPlain',
                    'Storage and privacy: Channel configuration, binding policy, provider-derived identities, and externally bridged Session content use the documented server, database, and backup visibility of their canonical plain Account/Session owners.',
                  )
                  : props.t(
                    'plugins.channels.surface.bindingCreatePrivacyE2ee',
                    'Storage and privacy: in persisted Happier Account data, private fields remain inside canonical encrypted envelopes and only the bounded routing/index projection is server-readable.',
                  )}
                description={props.t(
                  'plugins.channels.surface.bindingCreatePrivacyTransit',
                  'The connected provider always sees this conversation. Deliveries that arrive through a Happier-hosted webhook endpoint also pass through the Happier server, which reads and verifies the raw provider request before sealing it.',
                )}
              />
              <Stack gap="medium" testID="channels-binding-create-summary">
                <Metadata
                  title={props.t('plugins.channels.surface.bindingCreateSummary', 'Binding summary')}
                  entries={[
                    {
                      label: props.t('plugins.channels.surface.provider', 'Provider'),
                      value: providerDisplayName,
                    },
                    ...(currentConnection === undefined ? [] : [{
                      label: props.t('plugins.channels.surface.transport', 'Transport'),
                      value: transportLabel(currentConnection.selectedTransport, props.t),
                    }]),
                    {
                      label: props.t('plugins.channels.surface.bindingCreateConversation', 'Conversation'),
                      value: endpointLabel ?? props.t('plugins.channels.surface.bindingCreateEndpointFallback', 'Conversation'),
                    },
                    {
                      label: props.t('plugins.channels.surface.bindingCreateAllowedSender', 'Allowed sender'),
                      value: pairingRequired
                        ? props.t('plugins.channels.surface.bindingCreatePairingRequiredSummary', 'Pairing challenge required')
                        : selectedPrincipalSummary,
                    },
                    {
                      label: props.t('plugins.channels.surface.bindingCreateTarget', 'Target'),
                      value: target.label,
                    },
                  ]}
                />
                <Metadata
                  title={props.t('plugins.channels.surface.technicalDetails', 'Technical details')}
                  entries={[
                    {
                      label: props.t('plugins.channels.surface.selectedMachineId', 'Selected machine ID'),
                      value: currentConnection?.selectedMachineId
                        ?? props.t('plugins.channels.surface.bindingCreateConnectionUnavailable', 'Connection unavailable'),
                    },
                  ]}
                />
                <Metadata
                  title={props.t('plugins.channels.surface.bindingCreatePolicySummary', 'Binding policy')}
                  entries={[
                    {
                      label: props.t('plugins.channels.surface.bindingCreateInputMode', 'Incoming messages'),
                      value: bindingInputModeLabel(inputMode, props.t),
                    },
                    ...(target.kind === 'session' ? [
                      {
                        label: props.t('plugins.channels.surface.bindingCreateDeliveryMode', 'Session delivery'),
                        value: bindingDeliveryModeLabel(deliveryMode, props.t),
                      },
                      {
                        label: props.t('plugins.channels.surface.bindingCreatePermissionCeiling', 'Permission ceiling'),
                        value: bindingPermissionIntentLabel(permissionCeiling, props.t),
                      },
                      {
                        label: props.t('plugins.channels.surface.bindingCreateApprovals', 'Approvals'),
                        value: createSessionTarget === undefined
                          ? props.t('plugins.channels.surface.bindingCreateApprovalsOff', 'Off')
                          : bindingApprovalAudienceLabel(createSessionTarget, props.t),
                      },
                      {
                        label: props.t('plugins.channels.surface.bindingCreateNewSessionCommand', 'Allow /new'),
                        value: newSessionDraft === undefined
                          ? props.t('plugins.channels.surface.bindingCreateNewSessionDisabled', 'Do not create a new Session')
                          : props.t('plugins.channels.surface.bindingCreateNewSessionEnabled', 'Create a new Session'),
                      },
                    ] : target.kind === 'threadRouter' ? [
                      {
                        label: props.t('plugins.channels.surface.routerGroupsTitle', 'Sender groups'),
                        value: (routerDraft?.principalGroups ?? [])
                          .map((group) => `${group.id} (${group.principalIds.length})`).join(', '),
                      },
                      {
                        label: props.t('plugins.channels.surface.routerRoutesTitle', 'Routes'),
                        value: routerDraft === undefined || routerDraft.routes.length === 0
                          ? props.t('plugins.channels.page.routerNoRoutes', 'No routes yet')
                          : routerDraft.routes.map((route) => routerRouteSummary(route, props.t, summarizeRecipe)).join('; '),
                      },
                    ] : [
                      {
                        label: props.t('plugins.channels.surface.bindingCreateAutomationDelivery', 'Automation result delivery'),
                        value: bindingDeliveryModeLabel(
                          automationResultDelivery,
                          props.t,
                        ),
                      },
                      // Binding an Automation delegates unattended execution to
                      // an external sender. Name that consequence and the
                      // Automation's own effect before the binding is created.
                      {
                        label: props.t('plugins.channels.surface.bindingCreateAutomationEffect', 'What an allowed sender starts'),
                        value: bindingCreateAutomationEffectLabel(target.execution, props.t),
                      },
                      {
                        label: props.t('plugins.channels.surface.bindingCreateAutomationState', 'Automation state'),
                        value: target.execution.enabled
                          ? props.t('plugins.channels.surface.bindingCreateAutomationEnabled', 'Enabled')
                          : props.t(
                            'plugins.channels.surface.bindingCreateAutomationDisabled',
                            'Disabled — messages will not run it until it is enabled',
                          ),
                      },
                      {
                        label: props.t('plugins.channels.surface.bindingCreateAutomationAuthority', 'Delegated authority'),
                        value: props.t(
                          'plugins.channels.surface.bindingCreateAutomationAuthorityValue',
                          'The Automation runs unattended with the permissions, tools, and outward effects its own definition grants. This binding does not narrow them.',
                        ),
                      },
                    ]),
                    {
                      label: props.t('plugins.channels.surface.bindingCreateAllowBots', 'Allow bot senders'),
                      value: allowBotSenders
                        ? props.t('plugins.channels.surface.bindingCreateAllowBotsAllowed', 'Allowed')
                        : props.t('plugins.channels.surface.bindingCreateAllowBotsBlocked', 'Blocked'),
                    },
                    {
                      label: props.t('plugins.channels.surface.bindingCreateLinkPreview', 'Link previews'),
                      value: bindingCreateLinkPreviewPolicyLabel(linkPreviewPolicy, props.t),
                    },
                    {
                      label: props.t('plugins.channels.surface.bindingCreateSenderFeedback', 'Sender feedback'),
                      value: bindingCreateSenderFeedbackLabel(senderFeedback, props.t),
                    },
                    ...(currentConnection?.selectedTransport === 'durablePush' ? [{
                      label: props.t('plugins.channels.surface.bindingCreateWebhookBoundary', 'Webhook trust boundary'),
                      value: props.t(
                        'plugins.channels.surface.bindingCreateWebhookBoundaryDurablePush',
                        'Uses this connection’s host-verified webhook endpoint. The Happier server receives and verifies each raw provider delivery before it is sealed.',
                      ),
                    }] : []),
                  ]}
                />
              </Stack>
              <BindingCreateStepActions
                disabled={actionLocked}
                backDisabled={feedback === 'created'}
                onBack={backToPolicies}
                onCancel={cancelJourney}
                primary={(
                  <Button
                    testID="channels-binding-create-submit"
                    title={pairingRequired
                      ? props.t('plugins.channels.surface.bindingCreatePairingConfirm', 'Create pairing challenge')
                      : props.t('plugins.channels.surface.bindingCreateConfirm', 'Link conversation')}
                    busy={createAction.execution.status === 'pending' || pairingAction.execution.status === 'pending'}
                    disabled={actionLocked || feedback === 'created' || (pairingRequired && proofLocationIncomplete)}
                    onPress={pairingRequired ? createPairing : createBinding}
                  />
                )}
                t={props.t}
              />
            </Stack>
          ) : null}
          {feedbackContent}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * The binding list is intentionally summary-only. This journey reads the
 * exact private row only after its owner selects Edit, then keeps the draft
 * inside the mounted editor until it is cancelled or confirmed.
 */
/**
 * The binding-policy facts that are decided entirely from the retained binding
 * row: no provider resolution, target verification, or transport call. This is
 * exactly the set the Account-local transition and CAS owner accepts, so the
 * daemon-backed editor and the cold-offline editor present one control set.
 */
type BindingPolicyFields = Readonly<{
  allowBotSenders: boolean;
  inputMode: BindingInputMode;
  inboundDebounceMs: string;
  linkPreviewPolicy: 'suppress' | 'providerDefault';
  senderFeedback: 'off' | 'eligibleRefusals';
  enabled: boolean;
}>;

const BINDING_INPUT_MODE_LABEL_KEY: Readonly<Record<BindingInputMode, Readonly<{ key: string; fallback: string }>>> = {
  directMentionsOnly: { key: 'plugins.channels.surface.bindingCreateInputDirect', fallback: 'Direct mentions only' },
  addressedMessages: { key: 'plugins.channels.surface.bindingCreateInputAddressed', fallback: 'Addressed messages' },
  allAllowedMessages: { key: 'plugins.channels.surface.bindingCreateInputAll', fallback: 'All allowed messages' },
};

/** One option list for every incoming-message chooser on this surface. */
function bindingInputModeOptions(
  modes: readonly BindingInputMode[],
  t: Translate,
): readonly Readonly<{ value: string; label: string }>[] {
  return modes.map((mode) => ({
    value: mode,
    label: t(BINDING_INPUT_MODE_LABEL_KEY[mode].key, BINDING_INPUT_MODE_LABEL_KEY[mode].fallback),
  }));
}

/**
 * What this connection's integration can actually deliver here, decided by the
 * one protocol owner the create/update writer also uses.
 */
function deliverableBindingInputModes(input: Readonly<{
  audience: BindingEndpointAudience;
  connection?: ChannelsConnection;
}>): readonly BindingInputMode[] {
  return conversationBindingInputModesForEndpointV1({
    audience: input.audience,
    ...(input.connection?.sharedEndpointInputModes === undefined
      ? {}
      : { sharedEndpointInputModes: input.connection.sharedEndpointInputModes }),
  });
}

/**
 * Says out loud that the integration itself withholds the missing policies, so
 * an absent option reads as a platform fact rather than a broken surface.
 */
function BindingInputModeCapabilityNotice(props: Readonly<{
  deliverableInputModes: readonly BindingInputMode[];
  testID?: string;
  t: Translate;
}>): React.ReactElement | null {
  if (props.deliverableInputModes.length >= 3) return null;
  return (
    <Text
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      tone="secondary"
      value={props.t(
        'plugins.channels.surface.bindingInputModeCapability',
        'This integration only delivers messages that address it in a shared conversation, so broader incoming message policies are unavailable.',
      )}
    />
  );
}

/**
 * How a conversation takes messages in, as one page section: one row per
 * decision, the control beside its name (a switch, a two-way segmented choice)
 * or beneath it (the described incoming-message choices, the grouping delay).
 */
function BindingPolicyControls(props: Readonly<{
  fields: BindingPolicyFields;
  disabled: boolean;
  botSendersLocked: boolean;
  debounceValid: boolean;
  deliverableInputModes: readonly BindingInputMode[];
  onChange: (update: (current: BindingPolicyFields) => BindingPolicyFields) => void;
  t: Translate;
}>): React.ReactElement {
  const { fields, onChange } = props;
  const enabledLabel = props.t('plugins.channels.surface.bindingEditEnabled', 'Enable this binding');
  const allowBotsLabel = props.t('plugins.channels.surface.bindingCreateAllowBots', 'Allow bot senders');
  const linkPreviewLabel = props.t('plugins.channels.surface.bindingCreateLinkPreview', 'Link previews');
  const senderFeedbackLabel = props.t('plugins.channels.surface.bindingCreateSenderFeedback', 'Sender feedback');
  const inputModeLabel = props.t('plugins.channels.surface.bindingCreateInputMode', 'Incoming messages');
  const debounceLabel = props.t('plugins.channels.surface.bindingEditDebounce', 'Message grouping delay');
  return (
    <ItemGroup
      testID="channels-binding-policy"
      title={props.t('plugins.channels.surface.bindingPolicySection', 'Messages')}
      description={props.t('plugins.channels.surface.bindingPolicySectionDescription', 'What this conversation takes in, and how it answers.')}
    >
      <Item
        title={enabledLabel}
        accessoryOutsidePressable
        accessory={(
          <Form.Toggle
            label={enabledLabel}
            value={fields.enabled}
            disabled={props.disabled}
            onChange={(enabled) => onChange((current) => ({ ...current, enabled }))}
          />
        )}
      />
      <Item
        title={allowBotsLabel}
        accessoryOutsidePressable
        accessory={(
          <Form.Toggle
            label={allowBotsLabel}
            value={fields.allowBotSenders}
            disabled={props.disabled || props.botSendersLocked}
            onChange={(allowBotSenders) => onChange((current) => ({ ...current, allowBotSenders }))}
          />
        )}
      />
      {/* Three long choices: a field that opens the shared menu (segments overflow a phone). */}
      <Item
        title={inputModeLabel}
        {...(props.deliverableInputModes.length >= 3 ? {} : {
          subtitle: props.t(
            'plugins.channels.surface.bindingInputModeCapability',
            'This integration only delivers messages that address it in a shared conversation, so broader incoming message policies are unavailable.',
          ),
        })}
        fieldAccessory
        accessoryOutsidePressable
        accessory={(
          <Form.Select
            testID="channels-binding-input-mode"
            presentation="field"
            label={inputModeLabel}
            options={bindingInputModeOptions(props.deliverableInputModes, props.t)}
            value={fields.inputMode}
            disabled={props.disabled}
            onChange={(inputMode) => {
              if (!isBindingInputMode(inputMode)) return;
              onChange((current) => ({ ...current, inputMode }));
            }}
          />
        )}
      />
      {/* Seven durations: a field that opens the shared menu. */}
      <Item
        title={debounceLabel}
        {...(props.debounceValid ? {} : {
          detail: props.t('plugins.channels.surface.bindingEditDebounceInvalid', 'Enter a whole number of milliseconds.'),
          detailTone: 'danger' as const,
        })}
        fieldAccessory
        accessoryOutsidePressable
        accessory={(
          <Form.Select
            testID="channels-binding-inbound-debounce"
            presentation="field"
            label={debounceLabel}
            options={durationPresetOptions(INBOUND_GROUPING_PRESETS_MS, fields.inboundDebounceMs, props.t).map((option) => (
              option.value === '0'
                ? { ...option, label: props.t('plugins.channels.surface.bindingEditDebounceNone', 'No delay') }
                : option
            ))}
            value={fields.inboundDebounceMs}
            disabled={props.disabled}
            onChange={(inboundDebounceMs) => {
              const selected = readActionInputOptionValue(inboundDebounceMs);
              if (typeof selected !== 'string') return;
              onChange((current) => ({ ...current, inboundDebounceMs: selected }));
            }}
          />
        )}
      />
      <Item
        title={linkPreviewLabel}
        accessoryWraps
        accessoryOutsidePressable
        accessory={(
          <Form.Select
            presentation="segmented"
            label={linkPreviewLabel}
            options={[
              { value: 'suppress', label: props.t('plugins.channels.surface.bindingCreateLinkPreviewSuppress', 'Suppress previews') },
              { value: 'providerDefault', label: props.t('plugins.channels.surface.bindingCreateLinkPreviewProviderDefault', 'Provider default') },
            ]}
            value={fields.linkPreviewPolicy}
            disabled={props.disabled}
            onChange={(linkPreviewPolicy) => {
              if (linkPreviewPolicy !== 'suppress' && linkPreviewPolicy !== 'providerDefault') return;
              onChange((current) => ({ ...current, linkPreviewPolicy }));
            }}
          />
        )}
      />
      <Item
        title={senderFeedbackLabel}
        accessoryWraps
        accessoryOutsidePressable
        accessory={(
          <Form.Select
            presentation="segmented"
            label={senderFeedbackLabel}
            options={[
              { value: 'off', label: props.t('plugins.channels.surface.bindingCreateSenderFeedbackOff', 'Off') },
              { value: 'eligibleRefusals', label: props.t('plugins.channels.surface.bindingCreateSenderFeedbackRefusals', 'Eligible refusals') },
            ]}
            value={fields.senderFeedback}
            disabled={props.disabled}
            onChange={(senderFeedback) => {
              if (senderFeedback !== 'off' && senderFeedback !== 'eligibleRefusals') return;
              onChange((current) => ({ ...current, senderFeedback }));
            }}
          />
        )}
      />
    </ItemGroup>
  );
}

function BindingEditJourney(props: Readonly<{
  bindingId: string;
  presentation?: BindingPresentation;
  connections: readonly ChannelsConnection[];
  resource: ResourcePresentation;
  signal: AbortSignal;
  onRefresh: () => void;
  onRefreshConnection: () => void;
  onClose: (restoreOriginFocus: boolean) => void;
  /** Open on the target step instead of the policy summary. */
  initialStage?: 'target';
  t: Translate;
}>): React.ReactElement {
  const hostApi = usePluginHostApi();
  const readAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead);
  const updateAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate);
  const resolveAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve);
  const sessionsAction = useSessionCandidatePages({
    signal: props.signal,
    isLocked: () => actionLocked,
    onStarted: () => setFeedback(undefined),
    onUnavailable: () => setFeedback('sessionUnavailable'),
  });
  const automationAction = useExecutePluginAction('automation.conversation.targets.list');
  const stageFocusTarget = usePluginUiFocusTarget();
  const feedbackFocusTarget = usePluginUiFocusTarget();
  const [detail, setDetail] = React.useState<BindingEditorDetail | undefined>();
  const [draft, setDraft] = React.useState<BindingEditorDraft | undefined>();
  const [stage, setStage] = React.useState<BindingEditorStage>('policies');
  const [detailPending, setDetailPending] = React.useState(true);
  const [feedback, setFeedback] = React.useState<BindingEditorFeedback | undefined>();
  const [resolverRefusal, setResolverRefusal] = React.useState<ResolverRefusal | undefined>();
  const showResolverNotReady = React.useCallback((failure: ConversationProviderFailureV1) => {
    const refusal = resolverRefusalOf(failure);
    setResolverRefusal(refusal);
    setFeedback(refusal === undefined ? 'resolverNotReady' : 'resolverRefused');
  }, []);
  const [outcomeUnknown, setOutcomeUnknown] = React.useState(false);
  const [requiresReresolution, setRequiresReresolution] = React.useState(false);
  const [readConnectionRevision, setReadConnectionRevision] = React.useState<number | undefined>();
  const [endpointQuery, setEndpointQuery] = React.useState('');
  const [endpointCandidates, setEndpointCandidates] = React.useState<readonly BindingCreateEndpointCandidate[]>([]);
  const [endpointSelection, setEndpointSelection] = React.useState<BindingCreateEndpointSelection | undefined>();
  const [endpointLabel, setEndpointLabel] = React.useState<string | undefined>();
  const [principalQuery, setPrincipalQuery] = React.useState('');
  const [principalCandidates, setPrincipalCandidates] = React.useState<readonly BindingCreatePrincipalCandidate[]>([]);
  const [selectedPrincipals, setSelectedPrincipals] = React.useState<readonly (BindingEditorPrincipalCandidate & Readonly<{ query: string }>)[]>([]);
  const [audienceResolution, setAudienceResolution] = React.useState<BindingEditorAudienceResolution>('none');
  const {
    candidates: sessionCandidates,
    nextCursor: sessionNextCursor,
    load: loadSessions,
  } = sessionsAction;
  const [automationCandidates, setAutomationCandidates] = React.useState<readonly BindingCreateAutomationCandidate[]>([]);
  const [automationNextCursor, setAutomationNextCursor] = React.useState<string | undefined>();
  const [reloadPhase, setReloadPhase] = React.useState<
    'waitingForExistingRead' | 'waitingForRequestedRead' | undefined
  >();
  const [savedPolicyClamped, setSavedPolicyClamped] = React.useState(false);
  const mountedRef = React.useRef(true);
  const initialReadStartedRef = React.useRef(false);
  const reloadSawResourceChangeRef = React.useRef(false);
  const submittingRef = React.useRef(false);

  const currentConnectionId = detail?.binding.connectionId ?? props.presentation?.binding.connectionId;
  const currentConnection = props.connections.find((connection) => connection.connectionId === currentConnectionId);
  const summaryChanged = detail !== undefined && (
    props.presentation === undefined || props.presentation.binding.revision !== detail.revision
  );
  const connectionChanged = detail !== undefined && readConnectionRevision !== undefined && (
    currentConnection === undefined || currentConnection.revision !== readConnectionRevision
  );
  const finalizingDelete = detail?.binding.deletionState === 'finalizingDelete'
    || props.presentation?.binding.deletionState === 'finalizingDelete';
  const providerControlsAvailable = currentConnection !== undefined
    && currentConnection.deletionState === 'none';
  const debounceMs = draft === undefined ? undefined : bindingEditorDebounceMs(draft.inboundDebounceMs);
  const selectedAudienceIncludesBot = draft?.audienceSelection?.principalSelection.selected.some((principal) => (
    principal.kind === 'bot'
  )) === true;
  // The edited binding's current destination decides every audience-derived
  // default this editor offers, including the delivery mode a retarget to a
  // Session has to name before the owner has expressed one.
  const editorEndpointAudience: BindingEndpointAudience = draft?.audienceSelection?.endpointSelection.selected.audience
    ?? detail?.binding.endpoint.audience
    ?? props.presentation?.binding.endpoint.audience
    ?? 'shared';
  const newSessionRecipeSelection = useBindingNewSessionRecipeSelection({
    signal: props.signal,
    isLocked: () => actionLocked || draft?.target.kind !== 'session',
    onStarted: () => setFeedback(undefined),
    onUnavailable: () => setFeedback('newSessionUnavailable'),
    onSelected: (recipe) => setDraft((current) => (current?.target.kind !== 'session' ? current : {
      ...current,
      targetChanged: true,
      target: {
        ...current.target,
        policy: {
          ...current.target.policy,
          newSession: { kind: 'enabled', recipe },
        },
      },
    })),
  });
  const actionLocked = detailPending
    || outcomeUnknown
    || updateAction.execution.status === 'pending'
    || updateAction.execution.status === 'outcomeUnknown'
    || resolveAction.execution.status === 'pending'
    || sessionsAction.execution.status === 'pending'
    || automationAction.execution.status === 'pending'
    || newSessionRecipeSelection.pending;
  const saveLocked = actionLocked
    || detail === undefined
    || draft === undefined
    || debounceMs === undefined
    || finalizingDelete
    || summaryChanged
    || connectionChanged
    || !providerControlsAvailable
    || requiresReresolution;

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const readDetail = React.useCallback(async (input: Readonly<{
    preserveDraft: boolean;
  }>): Promise<BindingEditorDetail | undefined> => {
    if (props.signal.aborted) return undefined;
    setDetailPending(true);
    try {
      const settled = await readAction.execute({ bindingId: props.bindingId });
      if (!mountedRef.current || props.signal.aborted) return undefined;
      if (settled.status !== 'success') {
        setDetailPending(false);
        setFeedback('readUnavailable');
        return undefined;
      }
      const parsed = ConversationBindingReadResultV1Schema.safeParse(settled.result);
      if (!parsed.success || parsed.data.kind === 'automationAssociation') {
        setDetailPending(false);
        setFeedback('readUnavailable');
        return undefined;
      }
      if (parsed.data.kind === 'notFound') {
        setDetailPending(false);
        setDetail(undefined);
        setFeedback('notFound');
        return undefined;
      }
      setDetailPending(false);
      setDetail(parsed.data);
      setReadConnectionRevision(currentConnection?.revision);
      setDraft((current) => input.preserveDraft && current !== undefined
        ? current
        : bindingEditorDraftFromDetail(parsed.data));
      setFeedback(undefined);
      return parsed.data;
    } catch {
      if (mountedRef.current && !props.signal.aborted) {
        setDetailPending(false);
        setFeedback('readUnavailable');
      }
      return undefined;
    }
  }, [currentConnection?.revision, props.bindingId, props.signal, readAction]);

  React.useEffect(() => {
    if (initialReadStartedRef.current) return;
    initialReadStartedRef.current = true;
    void readDetail({ preserveDraft: false });
  }, [readDetail]);

  React.useEffect(() => {
    if (detail === undefined) return;
    stageFocusTarget.focus();
  }, [detail, stage, stageFocusTarget]);

  React.useEffect(() => {
    if (feedback === undefined && !outcomeUnknown && !summaryChanged && !connectionChanged) return;
    feedbackFocusTarget.focus();
  }, [connectionChanged, feedback, feedbackFocusTarget, outcomeUnknown, summaryChanged]);

  React.useEffect(() => {
    if (!connectionChanged) return;
    setRequiresReresolution(true);
    setAudienceResolution('none');
    setEndpointSelection(undefined);
    setEndpointLabel(undefined);
    setEndpointCandidates([]);
    setPrincipalCandidates([]);
    setSelectedPrincipals([]);
  }, [connectionChanged]);

  const requestReload = React.useCallback(() => {
    if (detailPending
      || updateAction.execution.status === 'pending'
      || resolveAction.execution.status === 'pending'
      || sessionsAction.execution.status === 'pending'
      || automationAction.execution.status === 'pending'
      || newSessionRecipeSelection.pending
      || props.signal.aborted) {
      return;
    }
    reloadSawResourceChangeRef.current = false;
    props.onRefreshConnection();
    if (props.resource.pending !== 'idle') {
      setReloadPhase('waitingForExistingRead');
      return;
    }
    setReloadPhase('waitingForRequestedRead');
    props.onRefresh();
  }, [
    automationAction.execution.status,
    detailPending,
    newSessionRecipeSelection.pending,
    props.onRefreshConnection,
    props.onRefresh,
    props.resource.pending,
    props.signal,
    resolveAction.execution.status,
    sessionsAction.execution.status,
    updateAction.execution.status,
  ]);

  React.useEffect(() => {
    if (reloadPhase === undefined) return;
    if (reloadPhase === 'waitingForExistingRead') {
      if (props.resource.pending !== 'idle') return;
      reloadSawResourceChangeRef.current = false;
      setReloadPhase('waitingForRequestedRead');
      props.onRefresh();
      return;
    }
    if (props.resource.pending !== 'idle'
      || props.resource.freshness !== 'fresh'
      || props.resource.error !== undefined) {
      reloadSawResourceChangeRef.current = true;
      return;
    }
    if (!reloadSawResourceChangeRef.current) return;
    reloadSawResourceChangeRef.current = false;
    setReloadPhase(undefined);
    void readDetail({ preserveDraft: true }).then((nextDetail) => {
      if (nextDetail === undefined || !mountedRef.current) return;
      setOutcomeUnknown(false);
      updateAction.reset();
    });
  }, [props.onRefresh, props.resource.error, props.resource.freshness, props.resource.pending, readDetail, reloadPhase, updateAction]);

  const openEndpointReselection = React.useCallback(() => {
    if (actionLocked || !providerControlsAvailable) return;
    setEndpointQuery('');
    setEndpointCandidates([]);
    setEndpointSelection(undefined);
    setEndpointLabel(undefined);
    setPrincipalQuery('');
    setPrincipalCandidates([]);
    setSelectedPrincipals([]);
    setAudienceResolution('none');
    setDraft((current) => current === undefined ? current : {
      ...current,
      audienceSelection: undefined,
    });
    setRequiresReresolution(true);
    setFeedback(undefined);
    setStage('endpoint');
  }, [actionLocked, providerControlsAvailable]);

  const searchEndpoints = React.useCallback(async () => {
    if (currentConnection === undefined || actionLocked || endpointQuery.trim() === '' || props.signal.aborted) return;
    const input = ConversationBindingResolveInputV1Schema.safeParse({
      kind: 'endpoint',
      connectionId: currentConnection.connectionId,
      expectedConnectionRevision: currentConnection.revision,
      query: endpointQuery,
    });
    if (!input.success) {
      setFeedback('resolverUnavailable');
      return;
    }
    setFeedback(undefined);
    setEndpointCandidates([]);
    setAudienceResolution('none');
    const settled = await resolveAction.execute(input.data);
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status !== 'success') {
      if (settled.status === 'error') setFeedback('resolverUnavailable');
      return;
    }
    const result = ConversationBindingResolveResultV1Schema.safeParse(settled.result);
    if (!result.success || result.data.kind === 'unavailable') {
      setFeedback('resolverUnavailable');
      return;
    }
    if (result.data.kind === 'stale') {
      setRequiresReresolution(true);
      setAudienceResolution('none');
      setFeedback('resolverStale');
      return;
    }
    if (result.data.kind === 'notReady') {
      showResolverNotReady(result.data);
      return;
    }
    if (result.data.kind !== 'endpointCandidates') {
      setFeedback('resolverUnavailable');
      return;
    }
    setEndpointCandidates(result.data.candidates);
    setAudienceResolution('endpoint');
  }, [actionLocked, currentConnection, endpointQuery, props.signal, resolveAction, showResolverNotReady]);

  const searchPrincipals = React.useCallback(async () => {
    if (currentConnection === undefined
      || endpointSelection === undefined
      || audienceResolution === 'none'
      || actionLocked
      || principalQuery.trim() === ''
      || props.signal.aborted) {
      return;
    }
    const input = ConversationBindingResolveInputV1Schema.safeParse({
      kind: 'principal',
      connectionId: currentConnection.connectionId,
      expectedConnectionRevision: currentConnection.revision,
      endpointSelection,
      query: principalQuery,
    });
    if (!input.success) {
      setFeedback('resolverUnavailable');
      return;
    }
    setFeedback(undefined);
    setPrincipalCandidates([]);
    const settled = await resolveAction.execute(input.data);
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status !== 'success') {
      if (settled.status === 'error') setFeedback('resolverUnavailable');
      return;
    }
    const result = ConversationBindingResolveResultV1Schema.safeParse(settled.result);
    if (!result.success || result.data.kind === 'unavailable') {
      setFeedback('resolverUnavailable');
      return;
    }
    if (result.data.kind === 'stale') {
      setRequiresReresolution(true);
      setAudienceResolution('none');
      setFeedback('resolverStale');
      return;
    }
    if (result.data.kind === 'notReady') {
      showResolverNotReady(result.data);
      return;
    }
    if (result.data.kind !== 'principalCandidates') {
      setFeedback('resolverUnavailable');
      return;
    }
    setPrincipalCandidates(result.data.candidates);
    setAudienceResolution('principal');
  }, [actionLocked, audienceResolution, currentConnection, endpointSelection, principalQuery, props.signal, resolveAction, showResolverNotReady]);

  const applyAudienceSelection = React.useCallback(() => {
    const query = selectedPrincipals[0]?.query;
    if (currentConnection === undefined
      || endpointSelection === undefined
      || endpointLabel === undefined
      || query === undefined
      || audienceResolution !== 'principal'
      || actionLocked) {
      return;
    }
    const principalSelection = {
      query,
      selected: selectedPrincipals.map((principal) => ({
        id: principal.id, kind: principal.kind,
        ...(principal.query === query ? {} : { query: principal.query }),
      })),
    } as const;
    setDraft((current) => current === undefined ? current : {
      ...current,
      audienceSelection: {
        expectedConnectionRevision: currentConnection.revision,
        endpointSelection,
        principalSelection,
      },
      endpointLabel,
      allowedPrincipalIds: principalSelection.selected.map((principal) => principal.id),
      allowBotSenders: current.allowBotSenders || principalSelection.selected.some((principal) => principal.kind === 'bot'),
    });
    setRequiresReresolution(false);
    setFeedback(undefined);
    setStage('policies');
  }, [actionLocked, audienceResolution, currentConnection, endpointLabel, endpointSelection, selectedPrincipals]);

  // "Link another session" opens the editor on its target step, once its
  // detail has been read and while a target change is possible at all.
  const initialStageAppliedRef = React.useRef(false);
  React.useEffect(() => {
    if (props.initialStage !== 'target' || initialStageAppliedRef.current || detail === undefined) return;
    initialStageAppliedRef.current = true;
    if (!providerControlsAvailable || finalizingDelete) return;
    setStage('target');
    void loadSessions();
  }, [detail, finalizingDelete, loadSessions, props.initialStage, providerControlsAvailable]);

  const loadAutomationTargets = React.useCallback(async (cursor?: string) => {
    if (actionLocked || props.signal.aborted) return;
    setFeedback(undefined);
    const settled = await automationAction.execute({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status !== 'success') {
      setFeedback('automationUnavailable');
      return;
    }
    const page = parseBindingCreateAutomationPage(settled.result);
    if (page === undefined || (cursor === undefined && page.candidates.length === 0)) {
      setFeedback('automationUnavailable');
      return;
    }
    setAutomationCandidates((previous) => {
      if (cursor === undefined) return page.candidates;
      const seen = new Set(previous.map((candidate) => candidate.automationId));
      return [...previous, ...page.candidates.filter((candidate) => {
        if (seen.has(candidate.automationId)) return false;
        seen.add(candidate.automationId);
        return true;
      })];
    });
    setAutomationNextCursor(page.nextCursor);
  }, [actionLocked, automationAction, props.signal]);

  const selectNewSessionRecipe = newSessionRecipeSelection.select;

  const submit = React.useCallback(async () => {
    if (detail === undefined || draft === undefined || debounceMs === undefined || saveLocked || submittingRef.current) return;
    const input = ConversationBindingUpdateInputV1Schema.safeParse({
      bindingId: detail.binding.id,
      expectedRevision: detail.revision,
      ...(draft.targetChanged ? { target: draft.target } : {}),
      ...(draft.audienceSelection === undefined ? {} : { audienceSelection: draft.audienceSelection }),
      allowBotSenders: draft.allowBotSenders,
      inputMode: draft.inputMode,
      inboundDebounceMs: debounceMs,
      linkPreviewPolicy: draft.linkPreviewPolicy,
      senderFeedback: draft.senderFeedback,
      enabled: draft.enabled,
    });
    if (!input.success) {
      setFeedback('updateUnavailable');
      return;
    }
    submittingRef.current = true;
    setFeedback(undefined);
    setSavedPolicyClamped(false);
    try {
      const settled = await updateAction.execute(input.data);
      if (!mountedRef.current || props.signal.aborted) return;
      if (settled.status === 'outcomeUnknown') {
        setOutcomeUnknown(true);
        return;
      }
      if (settled.status !== 'success') {
        setFeedback(settled.status === 'error' && settled.code === 'collection_quota_incompatible'
          ? 'quotaIncompatible'
          : 'updateUnavailable');
        return;
      }
      const result = ConversationBindingMutationResultV1Schema.safeParse(settled.result);
      if (!result.success) {
        setFeedback('updateUnavailable');
        return;
      }
      if (result.data.kind === 'stale') {
        setRequiresReresolution(true);
        setFeedback('resolverStale');
        return;
      }
      if (result.data.kind === 'notVerified') {
        setFeedback(bindingTargetVerificationFeedback(result.data.reason));
        return;
      }
      if (result.data.kind === 'unavailable') {
        setFeedback('resolverUnavailable');
        return;
      }
      if (result.data.kind !== 'updated' && result.data.kind !== 'unchanged') {
        setFeedback('updateUnavailable');
        return;
      }
      const reread = await readDetail({ preserveDraft: true });
      if (reread === undefined) {
        setOutcomeUnknown(true);
        return;
      }
      setOutcomeUnknown(false);
      setSavedPolicyClamped(bindingEditorHasObservedPolicyClamp(
        draft.targetChanged ? draft.target : undefined,
        reread.binding,
      ));
      setFeedback('updated');
      props.onRefresh();
    } catch {
      if (mountedRef.current && !props.signal.aborted) setFeedback('updateUnavailable');
    } finally {
      submittingRef.current = false;
    }
  }, [debounceMs, detail, draft, props.onRefresh, props.signal, readDetail, saveLocked, updateAction]);

  const feedbackContent = (() => {
    if (outcomeUnknown) {
      return (
        <Banner
          tone="warning"
          title={props.t('plugins.channels.surface.bindingEditUnknownTitle', 'Could not confirm the binding update')}
          description={props.t(
            'plugins.channels.surface.bindingEditUnknownDescription',
            'The update may already be saved. Reload the current binding summary and its exact detail before changing it again.',
          )}
          action={<Action.Refresh title={props.t('plugins.channels.surface.reload', 'Reload')} onRefresh={requestReload} />}
        />
      );
    }
    if (feedback === undefined) return null;
    if (feedback === 'updated') {
      return <Status tone="secondary" label={props.t('plugins.channels.surface.bindingUpdated', 'Binding updated')} focusTarget={feedbackFocusTarget} />;
    }
    if (feedback === 'quotaIncompatible') {
      return (
        <Banner
          tone="danger"
          title={props.t('plugins.channels.surface.bindingEditQuotaIncompatibleTitle', 'Could not save this binding')}
          description={props.t(
            'plugins.channels.surface.bindingEditQuotaIncompatibleDescription',
            'The Account collection quota is incompatible. Ask an administrator to make the Account collection quota compatible, then reload this binding and try again.',
          )}
          action={<Action.Refresh title={props.t('plugins.channels.surface.reload', 'Reload')} onRefresh={requestReload} />}
        />
      );
    }
    if (feedback === 'resolverStale') {
      return (
        <Banner
          tone="warning"
          title={props.t('plugins.channels.surface.bindingEditResolverStaleTitle', 'The provider connection changed')}
          description={props.t(
            'plugins.channels.surface.bindingEditResolverStaleDescription',
            'Keep this draft, reload the connection, and re-resolve the conversation and senders before saving.',
          )}
          action={<Action.Refresh title={props.t('plugins.channels.surface.reload', 'Reload')} onRefresh={requestReload} />}
        />
      );
    }
    if (feedback === 'resolverRefused') {
      if (resolverRefusal === undefined) return null;
      const [refusedTitle, refusedDescription] = resolverRefusalCopy(resolverRefusal, props.t);
      return <Banner tone="warning" title={refusedTitle} description={refusedDescription} />;
    }
    const copy: Readonly<Record<Exclude<BindingEditorFeedback, 'updated' | 'quotaIncompatible' | 'resolverStale' | 'resolverRefused'>, readonly [string, string]>> = {
      readUnavailable: [
        props.t('plugins.channels.surface.bindingEditReadUnavailableTitle', 'Binding detail is unavailable'),
        props.t('plugins.channels.surface.bindingEditReadUnavailableDescription', 'Reload to read the current private binding policy before editing it.'),
      ],
      notFound: [
        props.t('plugins.channels.surface.bindingEditNotFoundTitle', 'This binding no longer exists'),
        props.t('plugins.channels.surface.bindingEditNotFoundDescription', 'Reload the bindings list before deciding what to do next.'),
      ],
      resolverUnavailable: [
        props.t('plugins.channels.surface.bindingEditResolverUnavailableTitle', 'Provider resolution is unavailable'),
        props.t('plugins.channels.surface.bindingEditResolverUnavailableDescription', 'Keep this draft, then reload the current connection before re-resolving the conversation and senders.'),
      ],
      resolverNotReady: [
        props.t('plugins.channels.surface.bindingEditResolverNotReadyTitle', 'Provider resolution is not ready'),
        props.t('plugins.channels.surface.bindingEditResolverNotReadyDescription', 'Wait for the provider to become ready, then re-resolve the conversation and senders.'),
      ],
      sessionUnavailable: [
        props.t('plugins.channels.surface.bindingEditSessionUnavailableTitle', 'Sessions are unavailable'),
        props.t('plugins.channels.surface.bindingEditSessionUnavailableDescription', 'Keep this draft and reload Sessions before choosing a target.'),
      ],
      automationUnavailable: [
        props.t('plugins.channels.surface.bindingEditAutomationUnavailableTitle', 'Automations are unavailable'),
        props.t('plugins.channels.surface.bindingEditAutomationUnavailableDescription', 'Keep this draft and reload Automations before choosing a target.'),
      ],
      newSessionUnavailable: [
        props.t('plugins.channels.surface.bindingEditNewSessionUnavailableTitle', 'A new Session could not be configured'),
        props.t('plugins.channels.surface.bindingEditNewSessionUnavailableDescription', 'The current target policy remains unchanged.'),
      ],
      targetNotVerified: [
        props.t('plugins.channels.surface.bindingEditTargetNotVerifiedTitle', 'The selected target is no longer available'),
        props.t('plugins.channels.surface.bindingEditTargetNotVerifiedDescription', 'Keep this draft and select a current target before saving.'),
      ],
      targetResultDeliveryUnavailable: [
        props.t(
          'plugins.channels.surface.bindingEditResultDeliveryUnavailableTitle',
          'This Automation cannot return a final result',
        ),
        props.t(
          'plugins.channels.surface.bindingEditResultDeliveryUnavailableDescription',
          'Keep this draft and choose "Do not reply" before saving. The Automation still runs; only the reply back to the conversation is unavailable.',
        ),
      ],
      updateUnavailable: [
        props.t('plugins.channels.surface.bindingEditUnavailableTitle', 'Could not save the binding'),
        props.t('plugins.channels.surface.bindingEditUnavailableDescription', 'Your draft is still here. Reload current details before trying again.'),
      ],
    };
    const [title, description] = copy[feedback];
    return <Status tone="warning" label={`${title}. ${description}`} focusTarget={feedbackFocusTarget} />;
  })();

  const currentSummaryNotice = summaryChanged ? (
    <SourceChangedWhileEditingNotice
      title={props.t('plugins.channels.surface.bindingEditSummaryChangedTitle', 'This binding changed while you were editing')}
      description={props.t(
        'plugins.channels.surface.bindingEditSummaryChangedDescription',
        'Your draft is retained, but saving is locked until you reload the current binding summary and exact detail.',
      )}
      onReload={requestReload}
      t={props.t}
    />
  ) : null;
  const connectionNotice = connectionChanged || !providerControlsAvailable ? (
    <SourceChangedWhileEditingNotice
      title={props.t('plugins.channels.surface.bindingEditConnectionChangedTitle', 'Current provider connection details are unavailable')}
      description={props.t(
        'plugins.channels.surface.bindingEditConnectionChangedDescription',
        'Your draft is retained. Reload the current connection and re-resolve provider-dependent choices before saving.',
      )}
      onReload={requestReload}
      t={props.t}
    />
  ) : null;

  if (detail === undefined) {
    return (
      <Stack gap="medium">
        <ConversationEditPageHeader focusTarget={stageFocusTarget} t={props.t} />
        {detailPending ? (
          <LoadingState
            title={props.t('plugins.channels.surface.bindingEditLoadingTitle', 'Loading binding detail')}
            description={props.t('plugins.channels.surface.bindingEditLoadingDescription', 'Reading the exact current binding policy.')}
          />
        ) : feedbackContent}
        <Stack gap="small">
          <Button
            title={props.t('plugins.channels.surface.reload', 'Reload')}
            variant="secondary"
            disabled={actionLocked}
            onPress={requestReload}
          />
          <Button
            title={props.t('plugins.channels.surface.cancel', 'Cancel')}
            variant="plain"
            onPress={() => props.onClose(true)}
          />
        </Stack>
      </Stack>
    );
  }

  const updateSessionTarget = (transform: (target: BindingEditorSessionTarget) => BindingEditorTarget) => {
    setDraft((current) => current?.target.kind !== 'session' ? current : {
      ...current,
      targetChanged: true,
      target: transform(current.target),
    });
  };
  const updateAutomationTarget = (transform: (target: BindingEditorAutomationTarget) => BindingEditorTarget) => {
    setDraft((current) => current?.target.kind !== 'automation' ? current : {
      ...current,
      targetChanged: true,
      target: transform(current.target),
    });
  };

  // One commit pair per state, in the page header: Review changes from the policies,
  // Save from the review. Sub-steps keep their own Back and Cancel beside their work.
  const headerActions = stage === 'policies' && draft !== undefined ? (
    <Row gap="small" align="center">
      <Button
        title={props.t('plugins.channels.surface.cancel', 'Cancel')}
        variant="plain"
        disabled={actionLocked && !outcomeUnknown}
        onPress={() => props.onClose(true)}
      />
      <Button
        testID="channels-binding-edit-review"
        title={props.t('plugins.channels.surface.bindingEditReview', 'Review changes')}
        variant="primary"
        disabled={actionLocked || finalizingDelete || debounceMs === undefined}
        onPress={() => setStage('review')}
      />
    </Row>
  ) : stage === 'review' && draft !== undefined ? (
    <Row gap="small" align="center">
      <Button
        title={props.t('plugins.channels.surface.bindingCreateBack', 'Back')}
        variant="plain"
        disabled={actionLocked && !outcomeUnknown}
        onPress={() => setStage('policies')}
      />
      <Button
        testID="channels-binding-edit-save"
        title={props.t('plugins.channels.surface.bindingEditSave', 'Save binding')}
        variant="primary"
        busy={updateAction.execution.status === 'pending' || detailPending}
        disabled={saveLocked || feedback === 'updated'}
        onPress={() => { void submit(); }}
      />
    </Row>
  ) : undefined;

  return (
    <Stack gap="medium">
      <ConversationEditPageHeader
        {...(stage === 'policies' ? { focusTarget: stageFocusTarget } : {})}
        {...(headerActions === undefined ? {} : { actions: headerActions })}
        t={props.t}
      />
      {/* The policies stage announces itself through the focused page title, and each
          sub-step through its focused heading. */}
      {finalizingDelete ? (
        <Banner
          tone="warning"
          title={props.t('plugins.channels.surface.deleteFinalizing', 'Deletion cleanup in progress')}
          description={props.t(
            'plugins.channels.surface.bindingEditFinalizingDescription',
            'This retained binding is read-only while deletion cleanup completes.',
          )}
        />
      ) : null}
      {currentSummaryNotice}
      {connectionNotice}
      {stage === 'policies' && draft !== undefined ? (
        <Stack gap="small">
          {/* Who this conversation is with, as one section: the same rows the
              page reads, with the re-resolve operation on its title line. */}
          <ItemGroup
            testID="channels-binding-edit-audience"
            title={props.t('plugins.channels.surface.bindingEditCurrentAudience', 'Current conversation and senders')}
            action={(
              <Button
                variant="plain"
                title={props.t('plugins.channels.surface.bindingEditAudienceChange', 'Change')}
                accessibilityLabel={props.t('plugins.channels.surface.bindingEditAudience', 'Re-resolve conversation and allowed senders')}
                disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
                onPress={openEndpointReselection}
              />
            )}
          >
            <Item
              title={props.t('plugins.channels.surface.bindingCreateConversation', 'Conversation')}
              detail={draft.endpointLabel}
            />
            <Item
              title={props.t('plugins.channels.surface.bindingEditAllowedSenders', 'Allowed senders')}
              subtitle={formatConjunction(draft.allowedPrincipalIds)}
            />
            {draft.target.kind === 'threadRouter' ? null : (
              <Item
                title={props.t('plugins.channels.surface.bindingCreateTarget', 'Target')}
                subtitle={bindingEditorTargetLabel(draft.target, props.t)}
                accessoryOutsidePressable
                accessory={(
                  <Button
                    variant="secondary"
                    title={props.t('plugins.channels.surface.bindingEditTarget', 'Change target')}
                    disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
                    onPress={() => {
                      setFeedback(undefined);
                      setStage('target');
                      void loadSessions();
                    }}
                  />
                )}
              />
            )}
          </ItemGroup>
          <BindingPolicyControls
            fields={draft}
            disabled={actionLocked || finalizingDelete}
            botSendersLocked={selectedAudienceIncludesBot}
            debounceValid={debounceMs !== undefined}
            deliverableInputModes={deliverableBindingInputModes({
              audience: editorEndpointAudience,
              ...(currentConnection === undefined ? {} : { connection: currentConnection }),
            })}
            onChange={(update) => setDraft((current) => (
              current === undefined ? current : { ...current, ...update(current) }
            ))}
            t={props.t}
          />
          {draft.target.kind === 'session' ? (
            <BindingSessionTargetPolicyControls
              target={draft.target}
              admittedPrincipalIds={draft.allowedPrincipalIds}
              retainedApprovalPrincipalIds={draft.retainedApprovalPrincipalIds}
              disabled={actionLocked || finalizingDelete}
              configureNewSessionAvailable={newSessionRecipeSelection.available}
              onChange={updateSessionTarget}
              onRetainApprovalPrincipalIds={(principalIds) => {
                setDraft((current) => current === undefined
                  ? current
                  : { ...current, retainedApprovalPrincipalIds: principalIds });
              }}
              onConfigureNewSession={selectNewSessionRecipe}
              t={props.t}
            />
          ) : draft.target.kind === 'threadRouter' ? (
            <ThreadRouterControls
              target={draft.target}
              admittedPrincipalIds={draft.allowedPrincipalIds}
              disabled={actionLocked || finalizingDelete}
              signal={props.signal}
              onChange={(transform) => setDraft((current) => current?.target.kind !== 'threadRouter' ? current : {
                ...current,
                targetChanged: true,
                target: transform(current.target),
              })}
              onRecipeUnavailable={() => setFeedback('newSessionUnavailable')}
              t={props.t}
            />
          ) : draft.target.kind === 'discussion' ? null : (
            <Stack gap="small">
              <Heading
                level={3}
                value={props.t('plugins.channels.surface.bindingEditAutomationPolicyTitle', 'Automation target policy')}
              />
              <Form.Select
                testID="channels-binding-edit-automation-result-delivery"
                label={props.t('plugins.channels.surface.bindingEditResultDelivery', 'Result delivery')}
                options={[
                  { value: 'none', label: bindingDeliveryModeLabel('none', props.t) },
                  { value: 'finalResult', label: bindingDeliveryModeLabel('finalResult', props.t) },
                ]}
                value={draft.target.policy.resultDelivery}
                disabled={actionLocked || finalizingDelete}
                onChange={(resultDelivery) => {
                  if (resultDelivery !== 'none' && resultDelivery !== 'finalResult') return;
                  updateAutomationTarget((target) => ({
                    ...target,
                    policy: { ...target.policy, resultDelivery },
                  }));
                }}
              />
            </Stack>
          )}
        </Stack>
      ) : null}
      {stage === 'endpoint' ? (
        <Stack gap="small">
          <Heading level={2} value={props.t('plugins.channels.surface.bindingCreateEndpoint', 'Choose a conversation')} focusTarget={stageFocusTarget} />
          <Text tone="secondary" value={props.t('plugins.channels.surface.bindingEditEndpointReselection', 'Search the current provider before changing this conversation.')} />
          <Form.TextField
            label={props.t('plugins.channels.surface.bindingCreateEndpointQuery', 'Conversation search')}
            value={endpointQuery}
            disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
            onChange={setEndpointQuery}
          />
          <Button
            title={props.t('plugins.channels.surface.bindingCreateEndpointSearch', 'Search endpoints')}
            busy={resolveAction.execution.status === 'pending'}
            disabled={actionLocked || !providerControlsAvailable || finalizingDelete || endpointQuery.trim() === ''}
            onPress={() => { void searchEndpoints(); }}
          />
          {endpointCandidates.length === 0 ? null : (
            <List accessibilityLabel={props.t('plugins.channels.surface.bindingCreateEndpointCandidates', 'Endpoint candidates')}>
              {endpointCandidates.map((candidate) => (
                <List.Item
                  key={`${candidate.kind}:${candidate.id}`}
                  title={candidate.label ?? candidate.id}
                  subtitle={candidate.parentLabel}
                  disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
                  onPress={() => {
                    setEndpointSelection(bindingCreateEndpointSelection(endpointQuery, candidate));
                    setEndpointLabel(candidate.label ?? candidate.id);
                    setPrincipalQuery('');
                    setPrincipalCandidates([]);
                    setSelectedPrincipals([]);
                    setAudienceResolution('endpoint');
                    setFeedback(undefined);
                    setStage('principal');
                  }}
                />
              ))}
            </List>
          )}
          <Stack gap="small">
            <Button title={props.t('plugins.channels.surface.bindingCreateBack', 'Back')} variant="plain" disabled={actionLocked} onPress={() => setStage('policies')} />
            <Button title={props.t('plugins.channels.surface.cancel', 'Cancel')} variant="plain" disabled={actionLocked && !outcomeUnknown} onPress={() => props.onClose(true)} />
          </Stack>
        </Stack>
      ) : null}
      {stage === 'principal' ? (
        <Stack gap="small">
          <Heading level={2} value={props.t('plugins.channels.surface.bindingCreatePrincipal', 'Choose allowed senders')} focusTarget={stageFocusTarget} />
          <Form.TextField
            label={props.t('plugins.channels.surface.bindingCreatePrincipalQuery', 'People search')}
            value={principalQuery}
            disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
            onChange={setPrincipalQuery}
          />
          <Button
            title={props.t('plugins.channels.surface.bindingCreatePrincipalSearch', 'Search people')}
            busy={resolveAction.execution.status === 'pending'}
            disabled={actionLocked || !providerControlsAvailable || finalizingDelete || principalQuery.trim() === ''}
            onPress={() => { void searchPrincipals(); }}
          />
          <BindingPrincipalChoices
            testID="channels-binding-edit-principal-candidates"
            label={props.t('plugins.channels.surface.bindingCreatePrincipalCandidates', 'Allowed sender candidates')}
            candidates={principalCandidates.filter(isBindingEditorPrincipalCandidate)}
            selected={selectedPrincipals}
            disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
            onToggle={(candidate) => {
              setSelectedPrincipals((current) => current.some((principal) => principal.id === candidate.id && principal.kind === candidate.kind)
                ? current.filter((principal) => !(principal.id === candidate.id && principal.kind === candidate.kind))
                : [...current, { ...candidate, query: principalQuery }]);
            }}
          />
          <Button
            title={props.t('plugins.channels.surface.bindingEditUseAudience', 'Use selected conversation and senders')}
            disabled={actionLocked || finalizingDelete || selectedPrincipals.length === 0}
            onPress={applyAudienceSelection}
          />
          <Stack gap="small">
            <Button title={props.t('plugins.channels.surface.bindingCreateBack', 'Back')} variant="plain" disabled={actionLocked} onPress={() => setStage('endpoint')} />
            <Button title={props.t('plugins.channels.surface.cancel', 'Cancel')} variant="plain" disabled={actionLocked && !outcomeUnknown} onPress={() => props.onClose(true)} />
          </Stack>
        </Stack>
      ) : null}
      {stage === 'target' && draft !== undefined ? (
        <Stack gap="small">
          <Heading level={2} value={props.t('plugins.channels.surface.bindingCreateTarget', 'Choose a target')} focusTarget={stageFocusTarget} />
          <Text tone="secondary" value={bindingEditorTargetLabel(draft.target, props.t)} />
          <BindingTargetCandidateList
            sessionCandidates={sessionCandidates}
            automationCandidates={automationCandidates}
            disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
            onSession={(candidate) => {
              setDraft((current) => {
                if (current === undefined) return current;
                const policy: BindingEditorSessionTarget['policy'] = current.target.kind === 'session'
                  ? current.target.policy
                  : {
                    deliveryMode: conversationSessionBindingDeliveryModeForOmittedFieldV1(
                      editorEndpointAudience,
                    ),
                    permissionCeiling: 'read-only',
                    approvals: { kind: 'off' as const },
                    newSession: { kind: 'off' as const },
                  };
                return {
                  ...current,
                  targetChanged: true,
                  target: { kind: 'session', sessionId: candidate.id, policy },
                };
              });
              setFeedback(undefined);
              setStage('policies');
            }}
            onAutomation={(candidate) => {
              setDraft((current) => current === undefined ? current : {
                ...current,
                targetChanged: true,
                target: {
                  kind: 'automation',
                  automationId: candidate.automationId,
                  policy: current.target.kind === 'automation'
                    ? current.target.policy
                    : { resultDelivery: 'none' },
                },
              });
              setFeedback(undefined);
              setStage('policies');
            }}
            t={props.t}
          />
          <Stack gap="small">
            <Button
              title={props.t('plugins.channels.surface.bindingCreateSessionReload', 'Reload Sessions')}
              variant="plain"
              busy={sessionsAction.execution.status === 'pending'}
              disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
              onPress={() => { void loadSessions(); }}
            />
            {sessionNextCursor === undefined ? null : (
              <Button
                title={props.t('plugins.channels.surface.bindingCreateSessionLoadMore', 'Show more Sessions')}
                variant="plain"
                busy={sessionsAction.execution.status === 'pending'}
                disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
                onPress={() => { void loadSessions(sessionNextCursor); }}
              />
            )}
            {automationCandidates.length === 0 ? (
              <Button
                title={props.t('plugins.channels.surface.bindingCreateAutomationLoad', 'Show Automations')}
                variant="secondary"
                busy={automationAction.execution.status === 'pending'}
                disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
                onPress={() => { void loadAutomationTargets(); }}
              />
            ) : null}
            {automationNextCursor === undefined ? null : (
              <Button
                title={props.t('plugins.channels.surface.bindingCreateAutomationLoadMore', 'Show more Automations')}
                variant="plain"
                busy={automationAction.execution.status === 'pending'}
                disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
                onPress={() => { void loadAutomationTargets(automationNextCursor); }}
              />
            )}
          </Stack>
          <Stack gap="small">
            <Button title={props.t('plugins.channels.surface.bindingCreateBack', 'Back')} variant="plain" disabled={actionLocked} onPress={() => setStage('policies')} />
            <Button title={props.t('plugins.channels.surface.cancel', 'Cancel')} variant="plain" disabled={actionLocked && !outcomeUnknown} onPress={() => props.onClose(true)} />
          </Stack>
        </Stack>
      ) : null}
      {stage === 'review' && draft !== undefined ? (
        <Stack gap="small">
          <Heading level={2} value={props.t('plugins.channels.surface.bindingEditReview', 'Review changes')} focusTarget={stageFocusTarget} />
          <BindingEditConfirmationSummary draft={draft} connection={currentConnection} t={props.t} />
          {savedPolicyClamped ? (
            <Banner
              tone="warning"
              title={props.t('plugins.channels.surface.bindingEditPolicyClampedTitle', 'Saved policy was clamped')}
              description={props.t(
                'plugins.channels.surface.bindingEditPolicyClampedDescription',
                'The authoritative reread shows that the current Session permission policy was narrowed. Review the saved policy before making another change.',
              )}
            />
          ) : null}
        </Stack>
      ) : null}
      {feedbackContent}
    </Stack>
  );
}

/**
 * Bindings and connections are separate daemon Resources and therefore separate
 * sections with independent availability. This is the binding section's own
 * state; a failure here must never take the connection section down with it.
 */
type BindingsSectionState =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'error'; description: string }>;

const BINDINGS_SECTION_READY: BindingsSectionState = Object.freeze({ kind: 'ready' });

type BindingsContentProps = Readonly<{
  presentations: readonly BindingPresentation[];
  resource: ResourcePresentation;
  onRefresh: () => void;
  operation: BindingEnablementOperation;
  deleteOperation?: BindingDeleteOperation;
  /** Where the page is: its root, the link flow, or one conversation. */
  location: ReturnType<typeof readChannelsPageLocation>;
  /** The Account's bots, for the conversation's Bot section and the empty states. */
  connections: readonly ChannelsConnection[];
  connectionsState: 'loading' | 'error' | 'ready';
  /** Present when this mount can run the connection test (the daemon serves it). */
  connectionTest?: Readonly<{ resource: ResourcePresentation; onRefresh: () => void }>;
  bindingCreateContent?: React.ReactElement;
  /** The editor for the binding the page is editing, rendered in place of its summary. */
  bindingEditContent?: Readonly<{ bindingId: string; content: React.ReactElement }>;
  onEdit?: (binding: ChannelsBinding, focusTarget: PluginUiFocusTarget, intent?: 'target') => void;
  savedPendingMachineReconciliation?: boolean;
  sectionState?: BindingsSectionState;
  t: Translate;
}>;

function BindingsContent(props: BindingsContentProps): React.ReactElement {
  const theme = usePluginTheme();
  const surface = useSurfaceContext();
  const { execution, execute, reset } = props.operation;
  const [activeBindingId, setActiveBindingId] = React.useState<string | undefined>();
  const [enablementFailure, setEnablementFailure] = React.useState<BindingEnablementFailure | undefined>();
  const [activeDeletedBindingId, setActiveDeletedBindingId] = React.useState<string | undefined>();
  const [outcomeUnknownBindingId, setOutcomeUnknownBindingId] = React.useState<string | undefined>();
  const [outcomeUnknownDeletedBindingId, setOutcomeUnknownDeletedBindingId] = React.useState<string | undefined>();
  const [outcomeUnknownReconciliationPhase, setOutcomeUnknownReconciliationPhase] = React.useState<
    'waitingForExistingRead' | 'waitingForRequestedRead' | undefined
  >();
  const sawOutcomeUnknownReconciliationRefresh = React.useRef(false);
  const bindingsState = props.sectionState ?? BINDINGS_SECTION_READY;
  const readState = resolveChannelsConversationReadState(bindingsState.kind, props.connectionsState);
  const sectionState: BindingsSectionState = bindingsState.kind === 'error' ? bindingsState
    : readState === 'error' ? { kind: 'error', description: props.t(
      'plugins.channels.surface.errorDescription',
      'Refresh to try reading the current Account connection policy again.',
    ) } : readState === 'loading' ? { kind: 'loading' } : BINDINGS_SECTION_READY;
  const sectionAvailable = sectionState.kind === 'ready';
  // A notice about one conversation speaks on that conversation's page; the
  // page-level copy is for a conversation the reader is not looking at.
  const shownBindingId = props.location.step === undefined ? props.location.bindingId : undefined;
  const isShown = (bindingId: string | undefined) => bindingId !== undefined
    && bindingId === shownBindingId
    && props.presentations.some((presentation) => presentation.binding.bindingId === bindingId);
  const outcomeUnknownBindingIsVisible = isShown(outcomeUnknownBindingId);
  const enablementFailureIsVisible = isShown(enablementFailure?.bindingId);

  const onSetEnabled = React.useCallback(async (binding: ChannelsBinding, enabled: boolean) => {
    if (binding.deletionState !== 'none'
      || execution.status === 'pending'
      || execution.status === 'outcomeUnknown'
      || props.deleteOperation?.execution.status === 'pending'
      || props.deleteOperation?.execution.status === 'outcomeUnknown') return;
    setEnablementFailure(undefined);
    setActiveBindingId(binding.bindingId);
    const settled = await execute({
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
      enabled,
    });
    setActiveBindingId(undefined);
    if (settled.status === 'outcomeUnknown') {
      setOutcomeUnknownBindingId(binding.bindingId);
      return;
    }
    if (settled.status === 'error') {
      setEnablementFailure({
        bindingId: binding.bindingId,
        code: settled.code,
      });
    }
    if (settled.status !== 'pending') {
      props.onRefresh();
    }
  }, [execute, execution.status, props.deleteOperation, props.onRefresh]);

  const onDelete = React.useCallback(async (binding: ChannelsBinding) => {
    const deleteOperation = props.deleteOperation;
    if (deleteOperation === undefined
      || binding.deletionState !== 'none'
      || execution.status === 'pending'
      || execution.status === 'outcomeUnknown'
      || deleteOperation.execution.status === 'pending'
      || deleteOperation.execution.status === 'outcomeUnknown') {
      return;
    }
    setActiveDeletedBindingId(binding.bindingId);
    const settled = await deleteOperation.execute({
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
    });
    if (settled.status === 'outcomeUnknown') {
      setOutcomeUnknownDeletedBindingId(binding.bindingId);
      return;
    }
    if (settled.status !== 'pending') props.onRefresh();
    if (settled.status !== 'error') setActiveDeletedBindingId(undefined);
  }, [execution.status, props.deleteOperation, props.onRefresh]);

  const requestOutcomeUnknownRefresh = React.useCallback(() => {
    if (execution.status !== 'outcomeUnknown') {
      props.onRefresh();
      return;
    }
    sawOutcomeUnknownReconciliationRefresh.current = false;
    if (props.resource.pending !== 'idle') {
      setOutcomeUnknownReconciliationPhase('waitingForExistingRead');
      return;
    }
    setOutcomeUnknownReconciliationPhase('waitingForRequestedRead');
    props.onRefresh();
  }, [execution.status, props.onRefresh, props.resource.pending]);

  React.useEffect(() => {
    if (outcomeUnknownReconciliationPhase === undefined) return;
    if (outcomeUnknownReconciliationPhase === 'waitingForExistingRead') {
      if (props.resource.pending !== 'idle') return;
      sawOutcomeUnknownReconciliationRefresh.current = false;
      setOutcomeUnknownReconciliationPhase('waitingForRequestedRead');
      props.onRefresh();
      return;
    }
    if (props.resource.pending !== 'idle'
      || props.resource.freshness !== 'fresh'
      || props.resource.error !== undefined) {
      sawOutcomeUnknownReconciliationRefresh.current = true;
      return;
    }
    if (!sawOutcomeUnknownReconciliationRefresh.current) return;
    sawOutcomeUnknownReconciliationRefresh.current = false;
    setOutcomeUnknownReconciliationPhase(undefined);
    setOutcomeUnknownBindingId(undefined);
    reset();
  }, [
    outcomeUnknownReconciliationPhase,
    props.onRefresh,
    props.resource.error,
    props.resource.freshness,
    props.resource.pending,
    reset,
  ]);

  const onDeleteOutcomeReconciled = React.useCallback(() => {
    setActiveDeletedBindingId(undefined);
    setOutcomeUnknownDeletedBindingId(undefined);
    props.deleteOperation?.reset();
  }, [props.deleteOperation]);
  const requestUnknownDeleteOutcomeRefresh = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown: props.deleteOperation?.execution.status === 'outcomeUnknown',
    resource: props.resource,
    onRefresh: props.onRefresh,
    onReconciled: onDeleteOutcomeReconciled,
  });

  const navigation = useChannelsPageNavigation();
  const selectedPresentation = props.location.bindingId === undefined
    ? undefined
    : props.presentations.find((presentation) => presentation.binding.bindingId === props.location.bindingId);
  const liveBots = props.connections.some((connection) => connection.deletionState === 'none');

  const sectionUnavailableContent = (() => {
    if (sectionState.kind === 'loading') {
      return (
        <LoadingState
          testID="channels-bindings-loading"
          title={props.t('plugins.channels.page.loadingTitle', 'Loading conversations')}
        />
      );
    }
    if (sectionState.kind === 'error') {
      return (
        <ErrorState
          testID="channels-bindings-error"
          title={props.t('plugins.channels.page.errorTitle', 'Conversations are unavailable')}
          description={sectionState.description}
          action={(
            <Action.Refresh
              testID="channels-bindings-retry"
              title={props.t('plugins.channels.surface.tryAgain', 'Try again')}
              onRefresh={props.onRefresh}
            />
          )}
        />
      );
    }
    return null;
  })();

  const body = (() => {
    if (props.location.step === 'link') {
      return (
        <Stack gap="large" testID="channels-page-link-flow">
          <PageHeader
            title={props.t('plugins.channels.column.link', 'Link a conversation')}
            description={props.t('plugins.channels.page.linkDescription', 'Choose a chat and the session it should talk to.')}
          />
          {sectionUnavailableContent ?? props.bindingCreateContent}
        </Stack>
      );
    }
    if (sectionUnavailableContent) return sectionUnavailableContent;
    if (props.location.bindingId !== undefined) {
      if (selectedPresentation === undefined) {
        return (
          <EmptyState
            testID="channels-page-not-found"
            layout="page"
            title={props.t('plugins.channels.page.notFoundTitle', 'This conversation is no longer linked')}
            description={props.t('plugins.channels.page.notFoundDescription', 'It was unlinked, or it belongs to another account.')}
            action={(
              <Button
                variant="secondary"
                title={props.t('plugins.channels.page.showAll', 'Show all conversations')}
                onPress={navigation.openRoot}
              />
            )}
          />
        );
      }
      const editContent = props.bindingEditContent?.bindingId === selectedPresentation.binding.bindingId
        ? props.bindingEditContent.content
        : undefined;
      return (
        <ConversationDetail
          presentation={selectedPresentation}
          threadChildren={props.presentations.filter((presentation) => (
            presentation.binding.parentBindingId === selectedPresentation.binding.bindingId
          ))}
          execution={execution}
          {...(props.deleteOperation === undefined ? {} : { deleteOperation: props.deleteOperation, onDelete })}
          activeBindingId={activeBindingId}
          activeDeletedBindingId={activeDeletedBindingId}
          outcomeUnknownBindingId={outcomeUnknownBindingId}
          outcomeUnknownDeletedBindingId={outcomeUnknownDeletedBindingId}
          {...(enablementFailure === undefined ? {} : { enablementFailure })}
          onSetEnabled={onSetEnabled}
          {...(props.onEdit === undefined ? {} : { onEdit: props.onEdit })}
          {...(editContent === undefined ? {} : { editContent })}
          onUnknownOutcomeRefresh={requestOutcomeUnknownRefresh}
          onUnknownDeleteOutcomeRefresh={requestUnknownDeleteOutcomeRefresh}
          {...(props.connectionTest === undefined ? {} : { connectionTest: props.connectionTest })}
          t={props.t}
        />
      );
    }
    if (props.presentations.length === 0) {
      return (
        <ConversationsEmptyPage
          connections={props.connections}
          onConnectBot={navigation.openSettings}
          onLink={navigation.openLink}
          t={props.t}
        />
      );
    }
    if (surface.page?.columnVisible === true) {
      return (
        <EmptyState
          testID="channels-page-no-selection"
          layout="page"
          title={props.t('plugins.channels.surface.bindingCreateEndpoint', 'Choose a conversation')}
          description={props.t('plugins.channels.page.description', 'Chats, mailboxes and issues that talk to your sessions.')}
        />
      );
    }
    return (
      <ConversationsIndexPage
        presentations={props.presentations}
        connections={props.connections}
        onOpen={navigation.openConversation}
        {...(liveBots && props.bindingCreateContent !== undefined ? { onLink: navigation.openLink } : {})}
        t={props.t}
      />
    );
  })();

  return (
    <Screen testID="channels-surface" safeArea>
      {/* The page column owns the side edge; a plugin-drawn gutter would sit a second edge beside the host's. */}
      <ScrollArea contentContainerStyle={{ paddingTop: theme.spacing.large, paddingBottom: theme.spacing.large * 2 }}>
        <Stack gap="large" testID="channels-bindings-content">
          {resourceFreshnessNoticeApplies(props.resource) ? (
            <ResourceFreshnessNotice
              resource={props.resource}
              onRefresh={props.onRefresh}
              subject="binding"
              testIDPrefix="channels-bindings-resource"
              t={props.t}
            />
          ) : null}
          {props.savedPendingMachineReconciliation ? (
            <Status
              testID="channels-binding-saved-pending-machine-reconciliation"
              tone="secondary"
              label={props.t(
                'plugins.channels.surface.savedPendingMachineReconciliation',
                'Saved to your Account. The selected machine will reconcile this policy when it is available.',
              )}
            />
          ) : null}
          {enablementFailure === undefined || enablementFailureIsVisible ? null : (
            <BindingEnablementFailureNotice
              failure={enablementFailure}
              t={props.t}
              testID="channels-binding-enable-error"
            />
          )}
          {execution.status === 'outcomeUnknown' && !outcomeUnknownBindingIsVisible ? (
            <Banner
              testID="channels-binding-outcome-unknown"
              tone="warning"
              title={props.t(
                'plugins.channels.surface.bindingSaveUnknownTitle',
                'Could not confirm the binding change',
              )}
              description={props.t(
                'plugins.channels.surface.bindingSaveUnknownDescription',
                'The change may already be saved. Refresh binding details before changing another binding.',
              )}
              action={(
                <Action.Refresh
                  testID="channels-binding-outcome-unknown-reconcile"
                  title={props.t('plugins.channels.surface.refresh', 'Refresh')}
                  onRefresh={requestOutcomeUnknownRefresh}
                />
              )}
            />
          ) : null}
          {body}
        </Stack>
      </ScrollArea>
    </Screen>
  );
}

/** The daemon-backed branch keeps Resources and Actions optional-but-real. */
type OnlineBindingsContentProps = Omit<
  BindingsContentProps,
  'operation' | 'bindingCreateContent' | 'bindingEditContent' | 'onEdit' | 'connectionTest'
> & Readonly<{
  signal: AbortSignal;
  connectionsResource: ResourcePresentation;
  onRefreshConnections: () => void;
}>;

/**
 * Which binding the page is editing, and how the editor was asked for. The
 * editor itself stays the incumbent draft → review → save journey.
 */
type BindingEditRequest = Readonly<{
  bindingId: string;
  originFocusTarget: PluginUiFocusTarget;
  /** Open the editor on its target step ("Link another session"). */
  intent?: 'target';
}>;

/**
 * The editing state of the Channels page, shared by its online and offline
 * branches: one request at a time, opened from the conversation or from the
 * page location (`<bindingId>/edit`, how a finished pairing in Settings hands
 * its new binding over for review), with focus returned to its opener.
 */
function usePageBindingEditor(location: BindingsContentProps['location']): Readonly<{
  editing: BindingEditRequest | undefined;
  openEditor: (binding: ChannelsBinding, originFocusTarget: PluginUiFocusTarget, intent?: 'target') => void;
  openEditorFor: (bindingId: string) => void;
  closeEditor: (restoreOriginFocus: boolean) => void;
}> {
  const [editing, setEditing] = React.useState<BindingEditRequest | undefined>();
  const restoreEditFocusRef = React.useRef<PluginUiFocusTarget | undefined>(undefined);
  // A finished pairing hands its binding over for review. The editor moves
  // focus itself once its detail read settles, so this origin target is a
  // placeholder whose restoration is a deliberate no-op.
  const handoffFocusTarget = usePluginUiFocusTarget();
  const consumedLocationRef = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (location.step !== 'edit' || location.bindingId === undefined) return;
    const key = `${location.bindingId}/edit`;
    if (consumedLocationRef.current === key) return;
    consumedLocationRef.current = key;
    setEditing({ bindingId: location.bindingId, originFocusTarget: handoffFocusTarget });
  }, [handoffFocusTarget, location.bindingId, location.step]);
  // Moving to another conversation abandons an editor aimed at the previous one.
  if (editing !== undefined && location.bindingId !== undefined && location.bindingId !== editing.bindingId) {
    setEditing(undefined);
  }
  const openEditor = React.useCallback((
    binding: ChannelsBinding,
    originFocusTarget: PluginUiFocusTarget,
    intent?: 'target',
  ) => {
    if (binding.deletionState !== 'none') return;
    setEditing({ bindingId: binding.bindingId, originFocusTarget, ...(intent === undefined ? {} : { intent }) });
  }, []);
  const openEditorFor = React.useCallback((bindingId: string) => {
    setEditing({ bindingId, originFocusTarget: handoffFocusTarget });
  }, [handoffFocusTarget]);
  const closeEditor = React.useCallback((restoreOriginFocus: boolean) => {
    setEditing((current) => {
      if (restoreOriginFocus) restoreEditFocusRef.current = current?.originFocusTarget;
      return undefined;
    });
  }, []);
  React.useEffect(() => {
    if (editing !== undefined || restoreEditFocusRef.current === undefined) return;
    const target = restoreEditFocusRef.current;
    restoreEditFocusRef.current = undefined;
    target.focus();
  }, [editing]);
  return { editing, openEditor, openEditorFor, closeEditor };
}

function OnlineBindingsContent({
  signal,
  connectionsResource,
  onRefreshConnections,
  ...bindingsProps
}: OnlineBindingsContentProps): React.ReactElement {
  const action = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled,
  );
  const deleteAction = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingDelete,
  );
  const navigation = useChannelsPageNavigation();
  const editor = usePageBindingEditor(bindingsProps.location);
  const operation = React.useMemo<BindingEnablementOperation>(() => ({
    execution: action.execution,
    execute: async (input) => await action.execute({
      bindingId: input.bindingId,
      expectedRevision: input.expectedRevision,
      enabled: input.enabled,
    }),
    reset: action.reset,
  }), [action.execute, action.execution, action.reset]);
  const deleteOperation = React.useMemo<BindingDeleteOperation>(() => ({
    execution: deleteAction.execution,
    execute: async (input) => await deleteAction.execute({
      bindingId: input.bindingId,
      expectedRevision: input.expectedRevision,
    }),
    reset: deleteAction.reset,
  }), [deleteAction.execute, deleteAction.execution, deleteAction.reset]);
  const { openEditorFor } = editor;
  const showConversation = navigation.showConversation;
  // The link flow ends on the conversation it made: a pairing continues into
  // review (the editor is the one owner of reviewing and turning on a saved
  // binding), a direct link simply shows its page.
  const onPairingCompleted = React.useCallback((bindingId: string) => {
    openEditorFor(bindingId);
    showConversation(bindingId);
  }, [openEditorFor, showConversation]);
  // The link step opens the journey at once: on the bot the location names (a session tab's "+"), else on the
  // first bot that can link.
  const linkableConnections = bindingsProps.connections.filter((connection) => connection.deletionState === 'none');
  const linkConnectionId = linkableConnections.find((connection) => (
    connection.connectionId === bindingsProps.location.connectionId
  ))?.connectionId ?? linkableConnections[0]?.connectionId;
  const linkRequest = React.useMemo(
    () => (bindingsProps.location.step === 'link' && linkConnectionId !== undefined
      ? { connectionId: linkConnectionId, requestId: 1 }
      : undefined),
    [bindingsProps.location.step, linkConnectionId],
  );
  const editingPresentation = editor.editing === undefined
    ? undefined
    : bindingsProps.presentations.find((presentation) => (
      presentation.binding.bindingId === editor.editing?.bindingId
    ));
  const connectionTest = React.useMemo(
    () => ({ resource: connectionsResource, onRefresh: onRefreshConnections }),
    [connectionsResource, onRefreshConnections],
  );
  return (
    <BindingsContent
      {...bindingsProps}
      operation={operation}
      deleteOperation={deleteOperation}
      connectionTest={connectionTest}
      bindingCreateContent={(
        <BindingCreateJourney
          connections={bindingsProps.connections}
          resource={bindingsProps.resource}
          signal={signal}
          onRefresh={bindingsProps.onRefresh}
          onPairingCompleted={onPairingCompleted}
          onCreated={showConversation}
          {...(linkRequest === undefined ? {} : { openRequest: linkRequest })}
          t={bindingsProps.t}
        />
      )}
      {...(editor.editing === undefined ? {} : {
        bindingEditContent: {
          bindingId: editor.editing.bindingId,
          content: (
            <BindingEditJourney
              // The editor reads its detail exactly once per opened binding. A
              // different binding is a different read, so it must be a different
              // editor rather than a retained draft aimed at the new row.
              key={`${editor.editing.bindingId}:${editor.editing.intent ?? 'policies'}`}
              bindingId={editor.editing.bindingId}
              presentation={editingPresentation}
              connections={bindingsProps.connections}
              resource={bindingsProps.resource}
              signal={signal}
              onRefresh={bindingsProps.onRefresh}
              onRefreshConnection={onRefreshConnections}
              onClose={editor.closeEditor}
              {...(editor.editing.intent === undefined ? {} : { initialStage: editor.editing.intent })}
              t={bindingsProps.t}
            />
          ),
        },
      })}
      onEdit={editor.openEditor}
    />
  );
}

type AccountLocalBindingEditorFeedback =
  | 'readUnavailable'
  | 'notFound'
  | 'newSessionUnavailable'
  | 'saveUnavailable'
  | 'updated';

/**
 * The cold-offline binding editor. It offers exactly the binding policy the
 * shared transition and CAS owner decides from the retained Account row —
 * including a Session target, which `management.ts` also persists without
 * reaching anyone — and deliberately offers no endpoint or principal
 * re-resolution, Automation target change, transport effect, custody
 * resolution, or delete: each of those needs current provider or Automation
 * authority that an unreachable machine cannot supply.
 */
type BindingTargetCandidateRow =
  | Readonly<{ kind: 'session'; candidate: BindingCreateSessionCandidate }>
  | Readonly<{ kind: 'automation'; candidate: BindingCreateAutomationCandidate }>;

/**
 * One bounded virtualized collection for the paged Session and Automation
 * target candidates. Accumulated pages previously mounted one static row per
 * candidate without bound; this owner keeps the mounted tree bounded while the
 * paging Actions and the target composition they feed stay unchanged.
 */
function BindingTargetCandidateList(props: Readonly<{
  sessionCandidates: readonly BindingCreateSessionCandidate[];
  automationCandidates: readonly BindingCreateAutomationCandidate[];
  disabled: boolean;
  onSession: (candidate: BindingCreateSessionCandidate) => void;
  onAutomation: (candidate: BindingCreateAutomationCandidate) => void;
  t: Translate;
}>): React.ReactElement {
  const sections = React.useMemo<readonly ListSectionData<BindingTargetCandidateRow>[]>(() => [
    {
      key: 'session',
      title: props.t('plugins.channels.surface.bindingCreateSession', 'Session'),
      data: props.sessionCandidates.map((candidate) => ({ kind: 'session' as const, candidate })),
    },
    {
      key: 'automation',
      title: props.t('plugins.channels.surface.bindingCreateAutomation', 'Automation'),
      data: props.automationCandidates.map((candidate) => ({ kind: 'automation' as const, candidate })),
    },
  ], [props.automationCandidates, props.sessionCandidates, props.t]);
  const renderItem = React.useCallback((row: BindingTargetCandidateRow) => (
    row.kind === 'session' ? (
      <List.Item
        testID={`channels-binding-target-session:${row.candidate.id}`}
        title={row.candidate.label}
        disabled={props.disabled}
        onPress={() => props.onSession(row.candidate)}
      />
    ) : (
      <List.Item
        testID={`channels-binding-target-automation:${row.candidate.automationId}`}
        title={row.candidate.label}
        disabled={props.disabled}
        onPress={() => props.onAutomation(row.candidate)}
      />
    )
  ), [props.disabled, props.onAutomation, props.onSession]);
  const targetSearchText = React.useCallback((row: BindingTargetCandidateRow) => ({ label: row.candidate.label }), []);
  return (
    <List
      sections={sections}
      keyForItem={(row) => row.kind === 'session'
        ? `session:${row.candidate.id}`
        : `automation:${row.candidate.automationId}`}
      renderItem={renderItem}
      search={{
        label: props.t('plugins.channels.surface.bindingCreateTargetSearch', 'Search loaded targets'),
        placeholder: props.t('plugins.channels.surface.bindingCreateTargetSearchPlaceholder', 'Search Sessions and Automations'),
        testID: 'channels-binding-target-search',
        text: targetSearchText,
      }}
      accessibilityLabel={props.t('plugins.channels.surface.bindingCreateTarget', 'Choose a target')}
      testID="channels-binding-target-candidates"
      style={{ height: EMBEDDED_LIST_VIEWPORT_PX }}
    />
  );
}

function AccountLocalBindingPolicyEditor(props: Readonly<{
  collection: ChannelStateCollection;
  bindingId: string;
  presentation?: BindingPresentation;
  signal: AbortSignal;
  onCommitted: () => void;
  onRefresh: () => void;
  onClose: (restoreOriginFocus: boolean) => void;
  t: Translate;
}>): React.ReactElement {
  const operation = useAccountLocalBindingPolicy({
    collection: props.collection,
    signal: props.signal,
    onCommitted: props.onCommitted,
  });
  const stageFocusTarget = usePluginUiFocusTarget();
  const feedbackFocusTarget = usePluginUiFocusTarget();
  const [detail, setDetail] = React.useState<Readonly<{
    revision: number;
    binding: ConversationBindingV1;
  }> | undefined>();
  const [draft, setDraft] = React.useState<BindingEditorDraft | undefined>();
  const [detailPending, setDetailPending] = React.useState(true);
  const [feedback, setFeedback] = React.useState<AccountLocalBindingEditorFeedback | undefined>();
  const mountedRef = React.useRef(true);
  const initialReadStartedRef = React.useRef(false);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const readDetail = React.useCallback(async (input: Readonly<{
    preserveDraft: boolean;
  }>): Promise<'ready' | 'notFound' | 'unavailable' | 'retired'> => {
    if (props.signal.aborted) return 'retired';
    setDetailPending(true);
    let result: ConversationBindingPolicyReadResult;
    try {
      result = await readConversationBindingPolicyFromAccountCollection({
        collection: props.collection,
        bindingId: props.bindingId,
        signal: props.signal,
      });
    } catch {
      if (!mountedRef.current || props.signal.aborted) return 'retired';
      setDetailPending(false);
      setFeedback('readUnavailable');
      return 'unavailable';
    }
    if (!mountedRef.current || props.signal.aborted) return 'retired';
    setDetailPending(false);
    if (result.kind === 'notFound') {
      setDetail(undefined);
      setFeedback('notFound');
      return 'notFound';
    }
    setDetail({ revision: result.revision, binding: result.binding });
    setDraft((current) => (input.preserveDraft && current !== undefined
      ? current
      : bindingEditorDraftFromBinding(result.binding)));
    setFeedback(undefined);
    return 'ready';
  }, [props.bindingId, props.collection, props.signal]);

  React.useEffect(() => {
    if (initialReadStartedRef.current) return;
    initialReadStartedRef.current = true;
    void readDetail({ preserveDraft: false });
  }, [readDetail]);

  React.useEffect(() => {
    if (detail === undefined) return;
    stageFocusTarget.focus();
  }, [detail, stageFocusTarget]);

  const outcomeUnknown = operation.execution.status === 'outcomeUnknown';
  const saving = operation.execution.status === 'pending';
  const debounceMs = draft === undefined ? undefined : bindingEditorDebounceMs(draft.inboundDebounceMs);
  const finalizingDelete = detail !== undefined && detail.binding.deletionState !== 'none';
  const summaryChanged = detail !== undefined
    && props.presentation !== undefined
    && props.presentation.binding.revision !== detail.revision;
  const newSessionRecipeSelection = useBindingNewSessionRecipeSelection({
    signal: props.signal,
    isLocked: () => actionLocked || draft?.target.kind !== 'session',
    onStarted: () => setFeedback(undefined),
    onUnavailable: () => setFeedback('newSessionUnavailable'),
    onSelected: (recipe) => setDraft((current) => (current?.target.kind !== 'session' ? current : {
      ...current,
      targetChanged: true,
      target: {
        ...current.target,
        policy: {
          ...current.target.policy,
          newSession: { kind: 'enabled', recipe },
        },
      },
    })),
  });
  const updateSessionTarget = (transform: (target: BindingEditorSessionTarget) => BindingEditorTarget) => {
    setDraft((current) => (current?.target.kind !== 'session' ? current : {
      ...current,
      targetChanged: true,
      target: transform(current.target),
    }));
  };
  const actionLocked = detailPending
    || saving
    || outcomeUnknown
    || newSessionRecipeSelection.pending;
  const saveLocked = actionLocked
    || detail === undefined
    || draft === undefined
    || debounceMs === undefined
    || finalizingDelete
    || summaryChanged;

  // Reload is the exit from an ambiguous outcome, so it must stay available
  // while that state is latched; only an in-flight read or write blocks it.
  const reloadLocked = detailPending || saving;
  const reload = React.useCallback(() => {
    if (reloadLocked) return;
    props.onRefresh();
    // Reload is the exit from an ambiguous outcome only when the exact reread
    // reaches the owner. An unavailable reread proves nothing about the
    // ambiguous write, so the outcome-unknown latch stays on and Save stays
    // locked against the retained bytes. An authoritative `notFound` cleared
    // the detail, so no second write is reachable there and the operation
    // state may retire with the surface.
    void readDetail({ preserveDraft: true }).then((outcome) => {
      if (!mountedRef.current) return;
      if (outcome !== 'ready' && outcome !== 'notFound') return;
      operation.reset();
    });
  }, [operation, props.onRefresh, readDetail, reloadLocked]);

  const submit = React.useCallback(async () => {
    if (saveLocked || detail === undefined || draft === undefined || debounceMs === undefined) return;
    // The protocol parser is the authority for the drafted target, exactly as
    // it is for the daemon-backed editor. A draft this surface cannot admit is
    // reported rather than silently dropped from the write.
    let target: ConversationBindingTargetV1 | undefined;
    if (draft.targetChanged && draft.target.kind === 'session') {
      const parsed = ConversationBindingTargetV1Schema.safeParse(draft.target);
      if (!parsed.success) {
        setFeedback('saveUnavailable');
        return;
      }
      target = parsed.data;
    }
    // Revocation is derived from the retained audience rather than tracked as a
    // second draft field, so the request can never name a sender this binding
    // did not already allow.
    const revokedPrincipalIds = detail.binding.allowedPrincipalIds.filter(
      (principalId) => !draft.allowedPrincipalIds.includes(principalId),
    );
    const settled = await operation.execute({
      bindingId: props.bindingId,
      expectedRevision: detail.revision,
      ...(target === undefined ? {} : { target }),
      ...(revokedPrincipalIds.length === 0 ? {} : { revokedPrincipalIds }),
      allowBotSenders: draft.allowBotSenders,
      inputMode: draft.inputMode,
      inboundDebounceMs: debounceMs,
      linkPreviewPolicy: draft.linkPreviewPolicy,
      senderFeedback: draft.senderFeedback,
      enabled: draft.enabled,
    });
    if (!mountedRef.current) return;
    if (settled.status === 'success') {
      props.onRefresh();
      // The saved confirmation is reported from the authoritative reread, so it
      // never claims a change the Account has not returned.
      if (await readDetail({ preserveDraft: false }) === 'ready' && mountedRef.current) {
        setFeedback('updated');
      }
      return;
    }
    if (settled.status === 'error') setFeedback('saveUnavailable');
  }, [debounceMs, detail, draft, operation, props.bindingId, props.onRefresh, readDetail, saveLocked]);

  const feedbackContent = (() => {
    if (outcomeUnknown) {
      return (
        <Banner
          testID="channels-account-local-binding-outcome-unknown"
          tone="warning"
          title={props.t('plugins.channels.surface.bindingEditUnknownTitle', 'Could not confirm the binding update')}
          description={props.t(
            'plugins.channels.surface.bindingSaveUnknownDescription',
            'The change may already be saved. Refresh binding details before changing it again.',
          )}
          action={<Action.Refresh title={props.t('plugins.channels.surface.reload', 'Reload')} onRefresh={reload} />}
        />
      );
    }
    if (feedback === undefined) return null;
    if (feedback === 'updated') {
      return (
        <Status
          testID="channels-account-local-binding-updated"
          tone="secondary"
          label={props.t('plugins.channels.surface.bindingUpdated', 'Binding updated')}
          focusTarget={feedbackFocusTarget}
        />
      );
    }
    const copy: Readonly<Record<Exclude<AccountLocalBindingEditorFeedback, 'updated'>, readonly [string, string]>> = {
      readUnavailable: [
        props.t('plugins.channels.surface.bindingEditReadUnavailableTitle', 'Binding detail is unavailable'),
        props.t('plugins.channels.surface.bindingEditReadUnavailableDescription', 'Reload to read the current private binding policy before editing it.'),
      ],
      notFound: [
        props.t('plugins.channels.surface.bindingEditNotFoundTitle', 'This binding no longer exists'),
        props.t('plugins.channels.surface.bindingEditNotFoundDescription', 'Reload the bindings list before deciding what to do next.'),
      ],
      newSessionUnavailable: [
        props.t('plugins.channels.surface.bindingEditNewSessionUnavailableTitle', 'Could not choose a new Session'),
        props.t('plugins.channels.surface.bindingEditNewSessionUnavailableDescription', 'The new-Session recipe picker is unavailable here. The rest of this binding policy can still be saved.'),
      ],
      saveUnavailable: [
        props.t('plugins.channels.surface.bindingEditUnavailableTitle', 'Could not save the binding'),
        props.t('plugins.channels.surface.bindingEditUnavailableDescription', 'Your draft is still here. Reload current details before trying again.'),
      ],
    };
    const [title, description] = copy[feedback];
    return (
      <Status
        testID="channels-account-local-binding-feedback"
        tone="warning"
        label={`${title}. ${description}`}
        focusTarget={feedbackFocusTarget}
      />
    );
  })();

  if (detail === undefined || draft === undefined) {
    return (
      <Stack testID="channels-account-local-binding-editor" gap="medium">
        <ConversationEditPageHeader focusTarget={stageFocusTarget} t={props.t} />
        {detailPending ? (
          <LoadingState
            title={props.t('plugins.channels.surface.bindingEditLoadingTitle', 'Loading binding detail')}
            description={props.t('plugins.channels.surface.bindingEditLoadingDescription', 'Reading the exact current binding policy.')}
          />
        ) : feedbackContent}
        <Stack gap="small">
          <Button
            title={props.t('plugins.channels.surface.reload', 'Reload')}
            variant="secondary"
            disabled={reloadLocked}
            onPress={reload}
          />
          <Button
            title={props.t('plugins.channels.surface.cancel', 'Cancel')}
            variant="plain"
            disabled={saving}
            onPress={() => props.onClose(true)}
          />
        </Stack>
      </Stack>
    );
  }

  return (
    <Stack testID="channels-account-local-binding-editor" gap="medium">
      <ConversationEditPageHeader
        focusTarget={stageFocusTarget}
        actions={(
          <Row gap="small" align="center">
            <Button
              title={props.t('plugins.channels.surface.cancel', 'Cancel')}
              variant="plain"
              disabled={saving}
              onPress={() => props.onClose(true)}
            />
            <Button
              testID="channels-account-local-binding-save"
              title={props.t('plugins.channels.surface.bindingEditSave', 'Save binding')}
              variant="primary"
              busy={saving}
              disabled={saveLocked}
              onPress={() => { void submit(); }}
            />
          </Row>
        )}
        t={props.t}
      />
      {finalizingDelete ? (
        <Banner
          tone="warning"
          title={props.t('plugins.channels.surface.deleteFinalizing', 'Deletion cleanup in progress')}
          description={props.t(
            'plugins.channels.surface.bindingEditFinalizingDescription',
            'This retained binding is read-only while deletion cleanup completes.',
          )}
        />
      ) : null}
      {summaryChanged ? (
        <Banner
          tone="warning"
          title={props.t('plugins.channels.surface.bindingEditSummaryChangedTitle', 'This binding changed while you were editing')}
          description={props.t(
            'plugins.channels.surface.bindingEditSummaryChangedDescription',
            'Your draft is retained, but saving is locked until you reload the current binding summary and exact detail.',
          )}
          action={<Action.Refresh title={props.t('plugins.channels.surface.reload', 'Reload')} onRefresh={reload} />}
        />
      ) : null}
      <Banner
        testID="channels-account-local-binding-provider-actions-unavailable"
        tone="secondary"
        title={props.t(
          'plugins.channels.surface.providerActionsUnavailableTitle',
          'Provider actions need your selected machine',
        )}
        description={props.t(
          'plugins.channels.surface.providerActionsUnavailableDescription',
          'This Account policy can be saved now. Provider recovery and delivery resolution remain unavailable until the selected machine can run the provider.',
        )}
      />
      <Metadata
        title={props.t('plugins.channels.surface.bindingEditCurrentAudience', 'Current conversation and senders')}
        entries={[
          {
            label: props.t('plugins.channels.surface.bindingCreateConversation', 'Conversation'),
            value: draft.endpointLabel,
          },
          {
            label: props.t('plugins.channels.surface.bindingCreateAllowedSender', 'Allowed senders'),
            value: draft.allowedPrincipalIds.join(', '),
          },
          {
            label: props.t('plugins.channels.surface.bindingCreateTarget', 'Target'),
            value: bindingEditorTargetLabel(draft.target, props.t),
          },
        ]}
      />
      {/*
        Withdrawing a sender is decidable from the retained binding alone, so
        it stays available while the machine is unreachable. Admitting one is
        not: only the provider resolver can prove a sender exists on the
        endpoint. The last remaining sender is never revocable — a binding with
        no audience cannot persist.
      */}
      <Stack testID="channels-account-local-binding-revocation" gap="small">
        {draft.allowedPrincipalIds.map((principalId) => (
          <Button
            key={principalId}
            testID={`channels-account-local-binding-revoke-${principalId}`}
            title={props.t(
              'plugins.channels.surface.bindingEditRevokeSender',
              'Revoke {principal}',
              { principal: principalId },
            )}
            variant="secondary"
            disabled={actionLocked || finalizingDelete || draft.allowedPrincipalIds.length <= 1}
            onPress={() => setDraft((current) => (current === undefined ? current : {
              ...current,
              allowedPrincipalIds: current.allowedPrincipalIds.filter((id) => id !== principalId),
            }))}
          />
        ))}
      </Stack>
      <BindingPolicyControls
        fields={draft}
        disabled={actionLocked || finalizingDelete}
        botSendersLocked={false}
        debounceValid={debounceMs !== undefined}
        deliverableInputModes={deliverableBindingInputModes({
          audience: detail?.binding.endpoint.audience
            ?? props.presentation?.binding.endpoint.audience
            ?? 'shared',
          ...(props.presentation?.connection === undefined
            ? {}
            : { connection: props.presentation.connection }),
        })}
        onChange={(update) => setDraft((current) => (
          current === undefined ? current : { ...current, ...update(current) }
        ))}
        t={props.t}
      />
      {/*
        A Session target is decided entirely from the Account, so the offline
        editor offers the same control set the daemon-backed editor does. An
        Automation target is intentionally absent here: only its Automation
        owner can verify current target eligibility before a rotation.
      */}
      {draft.target.kind === 'session' ? (
        <BindingSessionTargetPolicyControls
          target={draft.target}
          admittedPrincipalIds={draft.allowedPrincipalIds}
          retainedApprovalPrincipalIds={draft.retainedApprovalPrincipalIds}
          disabled={actionLocked || finalizingDelete}
          configureNewSessionAvailable={newSessionRecipeSelection.available}
          onChange={updateSessionTarget}
          onRetainApprovalPrincipalIds={(principalIds) => {
            setDraft((current) => current === undefined
              ? current
              : { ...current, retainedApprovalPrincipalIds: principalIds });
          }}
          onConfigureNewSession={newSessionRecipeSelection.select}
          t={props.t}
        />
      ) : draft.target.kind === 'threadRouter' ? (
        <Banner
          testID="channels-account-local-binding-router-target-unavailable"
          tone="secondary"
          title={props.t(
            'plugins.channels.surface.bindingEditRouterTargetOfflineTitle',
            'Route changes need your selected machine',
          )}
          description={props.t(
            'plugins.channels.surface.bindingEditRouterTargetOfflineDescription',
            'Sender groups must be checked with the integration before they are saved, so routes stay read-only until the selected machine is reachable.',
          )}
        />
      ) : draft.target.kind === 'discussion' ? null : (
        <Banner
          testID="channels-account-local-binding-automation-target-unavailable"
          tone="secondary"
          title={props.t(
            'plugins.channels.surface.bindingEditAutomationTargetOfflineTitle',
            'Automation target changes need your selected machine',
          )}
          description={props.t(
            'plugins.channels.surface.bindingEditAutomationTargetOfflineDescription',
            'Only the Automation owner can confirm current target eligibility, so this target stays read-only until the selected machine is reachable.',
          )}
        />
      )}
      <BindingEditConfirmationSummary
        draft={draft}
        connection={props.presentation?.connection}
        t={props.t}
      />
      {feedbackContent}
    </Stack>
  );
}

/**
 * Cold offline policy mode deliberately has no Resource or Action fallback.
 * It consumes only the mounted Account Data client and the shared Channels
 * parser/transition/CAS owner, so provider runtime availability cannot become
 * accidental authority over a saved Account policy.
 */
/**
 * The direct Account reading both Channels destinations use while the daemon
 * cannot serve them: the canonical Collection readers, with presentation-local
 * last-known-good rows only.
 */
function useAccountLocalChannels(signal: AbortSignal, t: Translate) {
  const dataClient = usePluginUiDataClient();
  const collection = React.useMemo(
    () => dataClient.collection(CHANNEL_STATE_COLLECTION),
    [dataClient],
  );
  const deliveriesCollection = React.useMemo(
    () => dataClient.collection(CHANNEL_DELIVERIES_COLLECTION),
    [dataClient],
  );
  const bindingsRead = useAccountLocalBindingRows(collection, signal);
  const connectionsRead = useAccountLocalConnectionRows({
    stateCollection: collection,
    deliveriesCollection,
    signal,
  });
  const sortedConnections = React.useMemo(
    () => sortConnectionsForDisplay(connectionsRead.connections ?? [], t),
    [connectionsRead.connections, t],
  );
  const presentations = React.useMemo(
    () => buildBindingPresentations(bindingsRead.bindings ?? [], sortedConnections, t),
    [bindingsRead.bindings, sortedConnections, t],
  );
  const connectionState: 'loading' | 'error' | 'ready' = connectionsRead.connections === undefined
    ? connectionsRead.resource.pending === 'initial' ? 'loading' : 'error'
    : 'ready';
  return {
    collection,
    deliveriesCollection,
    bindingsRead,
    connectionsRead,
    sortedConnections,
    presentations,
    connectionState,
  };
}

/** The Channels page while the daemon is unreachable: Account-local policy only. */
function AccountLocalChannelsPageSurface(props: Readonly<{
  signal: AbortSignal;
  subPath: string | undefined;
  machineUnavailableReason?: string;
}>): React.ReactElement {
  const t = usePluginTranslation();
  const navigation = useChannelsPageNavigation();
  const channels = useAccountLocalChannels(props.signal, t);
  const { collection, deliveriesCollection } = channels;
  const { bindings, resource, refresh } = channels.bindingsRead;
  const refreshConnections = channels.connectionsRead.refresh;
  const refreshPage = React.useCallback(() => {
    refresh();
    refreshConnections();
  }, [refresh, refreshConnections]);
  const location = React.useMemo(() => readChannelsPageLocation(props.subPath), [props.subPath]);
  const editor = usePageBindingEditor(location);
  const [savedPendingMachineReconciliation, setSavedPendingMachineReconciliation] = React.useState(false);
  if (useReplacedAccountCollectionScope([collection, deliveriesCollection])) {
    // An open editor and a pending-reconciliation notice both name rows in the
    // replaced Collection. Equal row IDs in the successor would otherwise aim
    // a retained draft at a different Account's policy.
    editor.closeEditor(false);
    setSavedPendingMachineReconciliation(false);
  }
  const onCommitted = React.useCallback(() => {
    setSavedPendingMachineReconciliation(true);
  }, []);
  const operation = useAccountLocalBindingEnablement({
    collection,
    signal: props.signal,
    onCommitted,
  });
  const editingPresentation = editor.editing === undefined
    ? undefined
    : channels.presentations.find((presentation) => (
      presentation.binding.bindingId === editor.editing?.bindingId
    ));
  const sectionState: BindingsSectionState = bindings !== undefined
    ? BINDINGS_SECTION_READY
    : resource.pending === 'initial'
      ? { kind: 'loading' }
      : {
        kind: 'error',
        description: t(
          'plugins.channels.surface.bindingsErrorDescription',
          'Refresh to try reading the current Account binding policy again.',
        ),
      };

  return (
    <BindingsContent
      presentations={channels.presentations}
      resource={resource}
      onRefresh={refreshPage}
      operation={operation}
      location={location}
      connections={channels.sortedConnections}
      connectionsState={channels.connectionState}
      bindingCreateContent={(
        <ErrorState
          testID="channels-link-unavailable"
          kind="unavailable"
          title={t('plugins.channels.surface.providerActionsUnavailableTitle', 'Provider actions need your selected machine')}
          description={props.machineUnavailableReason}
          action={<Button variant="secondary" title={t('plugins.channels.page.showAll', 'Show all conversations')} onPress={navigation.openRoot} />}
        />
      )}
      sectionState={sectionState}
      savedPendingMachineReconciliation={savedPendingMachineReconciliation}
      onEdit={editor.openEditor}
      {...(editor.editing === undefined ? {} : {
        bindingEditContent: {
          bindingId: editor.editing.bindingId,
          content: (
            <AccountLocalBindingPolicyEditor
              // The editor reads its detail exactly once per opened binding. A
              // different binding is a different read, so it must be a different
              // editor rather than a retained draft aimed at the new row.
              key={editor.editing.bindingId}
              collection={collection}
              bindingId={editor.editing.bindingId}
              presentation={editingPresentation}
              signal={props.signal}
              onCommitted={onCommitted}
              onRefresh={refresh}
              onClose={editor.closeEditor}
              t={t}
            />
          ),
        },
      })}
      t={t}
    />
  );
}

/** Settings → Connections while the daemon is unreachable: the bots' Account-local policy. */
function AccountLocalBindingsSurface(props: Readonly<{
  signal: AbortSignal;
}>): React.ReactElement {
  const t = usePluginTranslation();
  const theme = usePluginTheme();
  const channels = useAccountLocalChannels(props.signal, t);
  const { collection, deliveriesCollection } = channels;
  const refreshBindings = channels.bindingsRead.refresh;
  const refreshConnections = channels.connectionsRead.refresh;
  const [expandedConnectionId, setExpandedConnectionId] = React.useState<string | undefined>();
  const [savedPendingMachineReconciliation, setSavedPendingMachineReconciliation] = React.useState(false);
  if (useReplacedAccountCollectionScope([collection, deliveriesCollection])) {
    setExpandedConnectionId(undefined);
    setSavedPendingMachineReconciliation(false);
  }
  const onCommitted = React.useCallback(() => {
    setSavedPendingMachineReconciliation(true);
  }, []);
  const refreshConnectionPolicy = React.useCallback(() => {
    refreshConnections();
    refreshBindings();
  }, [refreshBindings, refreshConnections]);

  return (
    <Screen testID="channels-surface">
      <ScrollArea safeArea contentContainerStyle={{ flexGrow: 1 }}>
        <Stack gap="large" style={{ padding: theme.spacing.large }}>
          {savedPendingMachineReconciliation ? (
            <Status
              testID="channels-binding-saved-pending-machine-reconciliation"
              tone="secondary"
              label={t(
                'plugins.channels.surface.savedPendingMachineReconciliation',
                'Saved to your Account. The selected machine will reconcile this policy when it is available.',
              )}
            />
          ) : null}
          <IngressAttentionControls
            signal={props.signal}
            recoveryActionsAvailable={false}
            bindings={channels.bindingsRead.bindings}
            connections={channels.sortedConnections}
            t={t}
          />
          <ConnectionsContent
            connections={channels.sortedConnections}
            bindingPresentations={channels.presentations}
            connectionState={channels.connectionState}
            signal={props.signal}
            resource={channels.connectionsRead.resource}
            accountLocalPolicy={{ collection, deliveriesCollection, onCommitted }}
            expandedConnectionId={expandedConnectionId}
            onExpand={(connectionId) => {
              setExpandedConnectionId((current) => current === connectionId ? undefined : connectionId);
            }}
            onConnectionCreated={() => {}}
            onRefresh={refreshConnectionPolicy}
            t={t}
          />
        </Stack>
      </ScrollArea>
    </Screen>
  );
}

type ConnectionPolicyDraft = Readonly<{
  revision: number;
  enabled: boolean;
  maximumObservationAgeMs: string;
  /**
   * The exact saved policy this draft started from. It is the dirtiness
   * authority: without it a rebase cannot tell an untouched editor from one
   * holding work that has not been written yet.
   */
  base: Readonly<{ enabled: boolean; maximumObservationAgeMs: string }>;
}>;

function connectionPolicyDraft(connection: ChannelsConnection): ConnectionPolicyDraft {
  const base = Object.freeze({
    enabled: connection.enabled,
    maximumObservationAgeMs: String(connection.maximumObservationAgeMs),
  });
  return {
    revision: connection.revision,
    enabled: base.enabled,
    maximumObservationAgeMs: base.maximumObservationAgeMs,
    base,
  };
}

/**
 * Work a rebase would throw away.
 *
 * Two separate facts have to hold. An untouched editor has nothing to lose, so
 * it always rebases. An edited one still has nothing to lose when the incoming
 * policy already says exactly what the draft says — which is precisely the
 * revision the person's own successful save produced, and reporting that as a
 * change made elsewhere would be false.
 */
function connectionPolicyDraftHasUnsavedWork(
  draft: ConnectionPolicyDraft,
  connection: ChannelsConnection,
): boolean {
  const edited = draft.enabled !== draft.base.enabled
    || draft.maximumObservationAgeMs !== draft.base.maximumObservationAgeMs;
  return edited && (
    draft.enabled !== connection.enabled
    || draft.maximumObservationAgeMs !== String(connection.maximumObservationAgeMs)
  );
}

/**
 * A newer revision rebases an editor with no unsaved work silently — there is
 * nothing worth interrupting for. Otherwise the draft is kept and stays behind
 * that revision, which is exactly what `connectionPolicyDraftSourceChanged`
 * then discloses: saving against a revision the person never read would
 * overwrite the other writer's change.
 */
function currentConnectionPolicyDraft(
  draft: ConnectionPolicyDraft,
  connection: ChannelsConnection,
): ConnectionPolicyDraft {
  if (draft.revision === connection.revision) return draft;
  return connectionPolicyDraftHasUnsavedWork(draft, connection)
    ? draft
    : connectionPolicyDraft(connection);
}

function connectionPolicyDraftSourceChanged(
  draft: ConnectionPolicyDraft,
  connection: ChannelsConnection,
): boolean {
  return draft.revision !== connection.revision;
}

type UnknownOutcomeReconciliationPhase =
  | 'waitingForExistingRead'
  | 'waitingForRequestedRead';

/** Keep an ambiguous mutation locked until an explicit fresh Resource reread finishes. */
function useExplicitFreshRereadAfterUnknownOutcome(input: Readonly<{
  outcomeUnknown: boolean;
  resource: ResourcePresentation;
  onRefresh: () => void;
  onReconciled: () => void;
}>): () => void {
  const [phase, setPhase] = React.useState<UnknownOutcomeReconciliationPhase | undefined>();
  const sawRequestedRead = React.useRef(false);

  const requestRefresh = React.useCallback(() => {
    if (!input.outcomeUnknown) {
      input.onRefresh();
      return;
    }
    sawRequestedRead.current = false;
    if (input.resource.pending !== 'idle') {
      setPhase('waitingForExistingRead');
      return;
    }
    setPhase('waitingForRequestedRead');
    input.onRefresh();
  }, [input.onRefresh, input.outcomeUnknown, input.resource.pending]);

  React.useEffect(() => {
    if (phase === undefined) return;
    if (phase === 'waitingForExistingRead') {
      if (input.resource.pending !== 'idle') return;
      sawRequestedRead.current = false;
      setPhase('waitingForRequestedRead');
      input.onRefresh();
      return;
    }
    if (input.resource.pending !== 'idle'
      || input.resource.freshness !== 'fresh'
      || input.resource.error !== undefined) {
      sawRequestedRead.current = true;
      return;
    }
    if (!sawRequestedRead.current) return;
    sawRequestedRead.current = false;
    setPhase(undefined);
    input.onReconciled();
  }, [
    input.onReconciled,
    input.onRefresh,
    input.resource.error,
    input.resource.freshness,
    input.resource.pending,
    phase,
  ]);

  return requestRefresh;
}

/** One connection in the connections list: name, provider, where it runs, and its state when it needs the reader. */
function ConnectionListRow(props: Readonly<{
  connection: ChannelsConnection;
  expanded: boolean;
  showDivider?: boolean;
  onExpand: () => void;
  t: Translate;
}>): React.ReactElement {
  const status = connectionStatus(props.connection, props.t);
  const provider = useConversationProviderDisplayName(props.connection.providerPluginId)
    ?? props.t('plugins.channels.surface.providerFallback', 'Integration provider');
  const label = connectionLabel(props.connection);
  const continuityDescriptions = connectionContinuityDescriptions(props.connection, props.t);
  return (
      <List.Item
      testID={`channels-connection-${props.connection.connectionId}`}
      {...(props.showDivider === undefined ? {} : { showDivider: props.showDivider })}
      title={label}
      subtitle={provider}
      // A healthy row is quiet: it says where it runs, and only a paused policy is named. The transport
      // mechanism stays in the connection's detail.
      detail={[
        ...(props.connection.enabled ? [] : [connectionPolicyLabel(props.connection, props.t)]),
        connectionMachinePlacementLabel(props.connection, props.t),
      ].join(' · ')}
      icon={(
        <BrandMark
          pluginId={props.connection.providerPluginId}
          size="small"
          externallyLabelled
          testID={`channels-provider-brand-${props.connection.connectionId}`}
        />
      )}
      accessory={status.tone === 'secondary' || status.tone === 'neutral' ? undefined : (
        <Status
          testID={`channels-connection-status-${props.connection.connectionId}`}
          tone={status.tone}
          label={status.label}
        />
      )}
      accessibilityExpanded={props.expanded}
      accessibilityLabel={[
        `${label}.`,
        `${props.t('plugins.channels.surface.provider', 'Provider')}: ${provider}.`,
        // Policy and runtime placement reach a screen reader as the two
        // separate facts the sighted detail line states.
        `${connectionPolicyLabel(props.connection, props.t)}.`,
        `${connectionMachinePlacementLabel(props.connection, props.t)}.`,
        `${transportLabel(props.connection.selectedTransport, props.t)}.`,
        `${status.label}.`,
        ...continuityDescriptions,
      ].join(' ')}
      onPress={props.onExpand}
    />
  );
}

function ConnectionRow(props: Readonly<{
  connection: ChannelsConnection;
  expanded: boolean;
  onExpand: () => void;
  /** The list's sheet hairline below this row (the shared List decides it). */
  showDivider?: boolean;
  /** The page's binding reads, which name the conversation each undecided delivery belongs to. */
  bindings: readonly ChannelsBinding[];
  signal: AbortSignal;
  resource: ResourcePresentation;
  targetPluginId?: string;
  policyOperation?: ConnectionPolicyOperation;
  resolveOperation?: DeliveryResolveOperation;
  providerDependentOperationsAvailable?: boolean;
  onLifecycleSettled?: (connectionId: string) => void;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement {
  const theme = usePluginTheme();
  const [draft, setDraft] = React.useState(() => connectionPolicyDraft(props.connection));
  const updateAction = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate,
  );
  const policyExecution = props.policyOperation?.execution ?? updateAction.execution;
  const executePolicy = props.policyOperation?.execute ?? updateAction.execute;
  const resetPolicy = props.policyOperation?.reset ?? updateAction.reset;
  const providerDependentOperationsAvailable = props.providerDependentOperationsAvailable !== false;
  const mutationPendingRef = React.useRef(false);
  const currentDraft = currentConnectionPolicyDraft(draft, props.connection);
  const updateUnavailable = props.connection.deletionState !== 'none';
  const mutationOutcomeUnknown = policyExecution.status === 'outcomeUnknown';
  const provider = useConversationProviderDisplayName(props.connection.providerPluginId)
    ?? props.t('plugins.channels.surface.providerFallback', 'Integration provider');

  const sourceChanged = connectionPolicyDraftSourceChanged(currentDraft, props.connection);

  React.useEffect(() => {
    // Commit the rebase decision that render already made. A dirty editor is
    // returned unchanged here, so React bails out and the draft survives.
    setDraft((previous) => currentConnectionPolicyDraft(previous, props.connection));
  }, [props.connection]);

  const resetMutationExecution = React.useCallback(() => {
    mutationPendingRef.current = false;
    resetPolicy();
  }, [resetPolicy]);
  const requestRefresh = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown: mutationOutcomeUnknown,
    resource: props.resource,
    onRefresh: props.onRefresh,
    onReconciled: resetMutationExecution,
  });

  const onEnabledChange = React.useCallback((enabled: boolean) => {
    setDraft((previous) => ({
      ...currentConnectionPolicyDraft(previous, props.connection),
      enabled,
    }));
  }, [props.connection]);

  const onMaximumObservationAgeMsChange = React.useCallback((maximumObservationAgeMs: string) => {
    setDraft((previous) => ({
      ...currentConnectionPolicyDraft(previous, props.connection),
      maximumObservationAgeMs,
    }));
  }, [props.connection]);

  /**
   * The explicit way out of a source change: the retained draft is replaced by
   * the current saved policy, so the person reads what is actually stored
   * before deciding again. It also rereads the Resource, which is what makes a
   * still-newer revision visible immediately.
   */
  const reloadPolicyDraft = React.useCallback(() => {
    setDraft(connectionPolicyDraft(props.connection));
    requestRefresh();
  }, [props.connection, requestRefresh]);

  const save = React.useCallback(async (maximumObservationAgeMs: number) => {
    if (updateUnavailable || mutationOutcomeUnknown || sourceChanged || mutationPendingRef.current) return;
    mutationPendingRef.current = true;
    let outcomeUnknown = false;
    try {
      const settled = await executePolicy({
        connectionId: props.connection.connectionId,
        expectedRevision: props.connection.revision,
        enabled: currentDraft.enabled,
        maximumObservationAgeMs,
      });
      if (settled.status !== 'pending' && settled.status !== 'outcomeUnknown') {
        props.onRefresh();
      }
      outcomeUnknown = settled.status === 'outcomeUnknown';
    } finally {
      if (!outcomeUnknown) mutationPendingRef.current = false;
    }
  }, [
    currentDraft.enabled,
    mutationOutcomeUnknown,
    props.connection.connectionId,
    props.connection.revision,
    props.onRefresh,
    executePolicy,
    sourceChanged,
    updateUnavailable,
  ]);

  const recommendedControl = connectionRecoveryControlOf(props.connection.recommendedRecovery);
  const controlElements: ReadonlyArray<readonly [ConnectionRecoveryControl, React.ReactNode]> = [
    ['reconnect', recommendedControl === 'reconnect' && props.connection.recommendedRecovery ? (
      <ConnectionReconnectControl
        key="reconnect"
        recommendation={props.connection.recommendedRecovery}
        onRefresh={requestRefresh}
        t={props.t}
      />
    ) : null],
    ['transfer', providerDependentOperationsAvailable
      && props.targetPluginId !== undefined
      && isConversationConnectionSelectableTransportV1(props.connection.selectedTransport) ? (
        <ConnectionTransferControls
          key="transfer"
          connection={props.connection}
          signal={props.signal}
          targetPluginId={props.targetPluginId}
          resource={props.resource}
          onRefresh={requestRefresh}
          t={props.t}
        />
      ) : null],
    ['pollRetry', providerDependentOperationsAvailable ? (
      <ConnectionPollRetryControls
        key="pollRetry"
        connection={props.connection}
        resource={props.resource}
        onRefresh={requestRefresh}
        primary={recommendedControl === 'pollRetry'}
        t={props.t}
      />
    ) : null],
    // Re-probing needs the selected machine's provider, so it lives inside the
    // same provider-dependent gate every other provider effect uses.
    ['retest', providerDependentOperationsAvailable ? (
      <ConnectionRetestControls
        key="retest"
        connection={props.connection}
        resource={props.resource}
        onRefresh={requestRefresh}
        primary={recommendedControl === 'retest'}
        t={props.t}
      />
    ) : null],
    // Delivery resolution is deliberately outside the provider-dependent gate:
    // the resolution owner performs no provider call, so a cold offline Account
    // must still be able to clear ambiguity that would otherwise never expire.
    ['delivery', props.connection.attention.outwardDelivery.partial
      || props.connection.attention.outwardDelivery.outcomeUnknown
      || props.connection.attention.outwardDelivery.archiveRecovery ? (
        <ConnectionDeliveryResolutionControls
          key="delivery"
          connection={props.connection}
          bindings={props.bindings}
          signal={props.signal}
          resolveOperation={props.resolveOperation}
          onRefresh={requestRefresh}
          t={props.t}
        />
      ) : null],
    // Removing the connection is the one destructive control; it always comes last.
    ['lifecycle', providerDependentOperationsAvailable ? (
      <ConnectionLifecycleControls
        key="lifecycle"
        connection={props.connection}
        resource={props.resource}
        onSettled={props.onLifecycleSettled}
        onRefresh={requestRefresh}
        t={props.t}
      />
    ) : null],
  ];
  const recoveryControls = {
    recommended: controlElements.find(([control]) => control === recommendedControl)?.[1] ?? null,
    others: controlElements.filter(([control]) => control !== recommendedControl).map(([, element]) => element),
  };

  return (
    <>
      <ConnectionListRow
        connection={props.connection}
        expanded={props.expanded}
        {...(props.showDivider === undefined ? {} : { showDivider: props.showDivider })}
        onExpand={props.onExpand}
        t={props.t}
      />
      {props.expanded ? (
        // The detail follows its row as a region of the sheet, not as another item of the list: its
        // policy and decision sections are lists of their own.
        <Stack
          testID={`channels-connection-expanded-${props.connection.connectionId}`}
          gap="large"
          style={{ paddingHorizontal: theme.spacing.large, paddingVertical: theme.spacing.large }}
        >
          {/*
          The connection's one recommended recovery leads its detail, drawn by the
          existing control that owns that Action; the other repairs stay quiet below.
        */}
        {/* What needs the reader comes first, then its one recommended repair. */}
        <ConnectionContinuityDisclosures connection={props.connection} t={props.t} />
        {recoveryControls.recommended}
        <ConnectionPolicyEditor
          connection={props.connection}
          provider={provider}
          draft={currentDraft}
          execution={policyExecution}
          providerDependentOperationsAvailable={providerDependentOperationsAvailable}
          resource={props.resource}
          sourceChanged={sourceChanged}
          onEnabledChange={onEnabledChange}
          onMaximumObservationAgeMsChange={onMaximumObservationAgeMsChange}
          onRefresh={requestRefresh}
          onReload={reloadPolicyDraft}
          onSave={save}
          t={props.t}
        />
        {recoveryControls.others}
        </Stack>
      ) : null}
    </>
  );
}

type ConnectionRecoveryControl = 'reconnect' | 'transfer' | 'lifecycle' | 'pollRetry' | 'retest' | 'delivery';

/**
 * Which existing control carries a recommended recovery. The recommendation only
 * names an Action; the control that already owns that Action runs it, with its
 * own confirmation, outcome and reread. A recommendation without a control here
 * (resume, baseline, scheduled retry) is carried by the policy editor's own rows.
 */
function connectionRecoveryControlOf(
  recommendation: ChannelsConnection['recommendedRecovery'],
): ConnectionRecoveryControl | undefined {
  if (recommendation === undefined || recommendation === null) return undefined;
  if (typeof recommendation.action === 'string') {
    return recommendation.action === 'connectedServices.authentication.beginReconnect' ? 'reconnect' : undefined;
  }
  switch (recommendation.action.localId) {
    case CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer: return 'transfer';
    case CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete: return 'lifecycle';
    case CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry: return 'pollRetry';
    case CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionRetest: return 'retest';
    case CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryAttention: return 'delivery';
    default: return undefined;
  }
}

/**
 * Reconnecting an expired account is the host's own Connected Accounts flow; the
 * recommendation carries its exact account reference and machine, never a secret.
 */
function ConnectionReconnectControl(props: Readonly<{
  recommendation: NonNullable<ChannelsConnection['recommendedRecovery']>;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement {
  const reconnect = useExecutePluginAction('connectedServices.authentication.beginReconnect');
  const busy = reconnect.execution.status === 'pending';
  // The host Action admits this input against its own schema before anything runs.
  const input = props.recommendation.input as PluginActionInputById['connectedServices.authentication.beginReconnect'];
  return (
    <Stack testID="channels-connection-reconnect-controls" gap="small">
      <Button
        testID="channels-connection-reconnect"
        title={props.t('plugins.channels.surface.reconnectAccount', 'Reconnect account')}
        busy={busy}
        disabled={busy}
        onPress={async () => {
          const settled = await reconnect.execute(input);
          if (settled.status === 'success') props.onRefresh();
        }}
      />
      {reconnect.execution.status === 'error' ? (
        <Status tone="danger" label={reconnect.execution.message} />
      ) : null}
    </Stack>
  );
}

/**
 * Cold offline policy retains the same editor and currentness UX, but its
 * complete desired-state write goes straight to the admitted Account
 * Collection. Provider-dependent recovery and delivery controls remain
 * unavailable rather than becoming an Action fallback.
 */
function AccountLocalConnectionRow(props: Readonly<{
  showDivider?: boolean;
  collection: ChannelStateCollection;
  deliveriesCollection: ChannelDeliveriesCollection;
  connection: ChannelsConnection;
  bindings: readonly ChannelsBinding[];
  expanded: boolean;
  onExpand: () => void;
  signal: AbortSignal;
  resource: ResourcePresentation;
  onCommitted: () => void;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement {
  const policyOperation = useAccountLocalConnectionPolicy({
    collection: props.collection,
    signal: props.signal,
    onCommitted: props.onCommitted,
  });
  const resolveOperation = useAccountLocalDeliveryResolution({
    stateCollection: props.collection,
    deliveriesCollection: props.deliveriesCollection,
    signal: props.signal,
    onCommitted: props.onCommitted,
  });
  return (
    <ConnectionRow
      connection={props.connection}
      expanded={props.expanded}
      onExpand={props.onExpand}
      {...(props.showDivider === undefined ? {} : { showDivider: props.showDivider })}
      bindings={props.bindings}
      signal={props.signal}
      resource={props.resource}
      policyOperation={policyOperation}
      resolveOperation={resolveOperation}
      providerDependentOperationsAvailable={false}
      onRefresh={props.onRefresh}
      t={props.t}
    />
  );
}

function ConnectionPolicyEditor(props: Readonly<{
  connection: ChannelsConnection;
  provider: string;
  draft: ConnectionPolicyDraft;
  execution: PluginActionExecution;
  providerDependentOperationsAvailable: boolean;
  resource: ResourcePresentation;
  /** The saved policy advanced past the revision this draft was read from. */
  sourceChanged: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onMaximumObservationAgeMsChange: (maximumObservationAgeMs: string) => void;
  onRefresh: () => void;
  onReload: () => void;
  onSave: (maximumObservationAgeMs: number) => Promise<void>;
  t: Translate;
}>): React.ReactElement {
  const [validationIssue, setValidationIssue] = React.useState<string | undefined>();
  const updateUnavailable = props.connection.deletionState !== 'none';
  const outcomeUnknown = props.execution.status === 'outcomeUnknown';
  const saving = props.execution.status === 'pending';
  const mutationUnavailable = outcomeUnknown;
  const saveUnavailable = updateUnavailable || mutationUnavailable || props.sourceChanged;

  React.useEffect(() => {
    setValidationIssue(undefined);
  }, [props.connection.revision]);

  const save = React.useCallback(async () => {
    if (saveUnavailable) return;
    const parsedAge = validObservationAge(props.draft.maximumObservationAgeMs);
    if (parsedAge === undefined) {
      setValidationIssue(`${props.t(
        'plugins.channels.surface.observationAgeInvalid',
        'Enter a whole number from',
      )} ${formatObservationAge(MIN_CONVERSATION_OBSERVATION_AGE_MS, props.t)} ${props.t(
        'plugins.channels.surface.through',
        'through',
      )} ${formatObservationAge(MAX_CONVERSATION_OBSERVATION_AGE_MS, props.t)}.`);
      return;
    }

    setValidationIssue(undefined);
    await props.onSave(parsedAge);
  }, [props.draft.maximumObservationAgeMs, props.onSave, props.t, saveUnavailable]);

  const formDisabled = updateUnavailable || saving || mutationUnavailable;
  const enabledLabel = props.t('plugins.channels.surface.enabledPolicy', 'Enabled');
  const observationAgeLabel = props.t('plugins.channels.surface.maximumObservationAge', 'Maximum observation age');
  // The row above names the connection and its state; the detail starts with what needs the reader,
  // then the policy as settings rows, then the facts it runs on.
  return (
    <Stack testID="channels-connection-detail" gap="large">
      <ResourceFreshnessNotice resource={props.resource} onRefresh={props.onRefresh} t={props.t} />
      {props.sourceChanged ? (
        <SourceChangedWhileEditingNotice
          testID="channels-connection-source-changed"
          reloadTestID="channels-connection-source-changed-reload"
          title={props.t(
            'plugins.channels.surface.connectionSourceChangedTitle',
            'This connection changed while you were editing',
          )}
          description={props.t(
            'plugins.channels.surface.connectionSourceChangedDescription',
            'Your unsaved changes are still here, and saving is locked so they cannot overwrite the newer policy. Reload to replace them with the current connection policy.',
          )}
          onReload={props.onReload}
          t={props.t}
        />
      ) : null}
      {props.providerDependentOperationsAvailable ? (
        <ConnectionHistoryGapNoticeControls
          connection={props.connection}
          resource={props.resource}
          onRefresh={props.onRefresh}
          t={props.t}
        />
      ) : null}

      {updateUnavailable ? (
        <Banner
          testID="channels-connection-update-unavailable"
          tone="warning"
          title={props.t('plugins.channels.surface.updateUnavailableTitle', 'Editing is unavailable during deletion')}
          description={props.t(
            'plugins.channels.surface.updateUnavailableDescription',
            'This connection is reconciling its stop or deletion state. Refresh for its current status.',
          )}
          action={(
            <Action.Refresh
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={props.onRefresh}
            />
          )}
        />
      ) : null}

      {!props.providerDependentOperationsAvailable ? (
        <Banner
          testID="channels-connection-provider-actions-unavailable"
          tone="secondary"
          title={props.t(
            'plugins.channels.surface.providerActionsUnavailableTitle',
            'Provider actions need your selected machine',
          )}
          description={props.t(
            'plugins.channels.surface.providerActionsUnavailableDescription',
            'This Account policy can be saved now. Provider recovery and delivery resolution remain unavailable until the selected machine can run the provider.',
          )}
        />
      ) : null}

      <ItemGroup
        testID="channels-connection-policy"
        title={props.t('plugins.channels.surface.connectionPolicyTitle', 'Policy')}
        action={(
          <Action.Refresh
            testID="channels-detail-resource-refresh"
            title={props.t('plugins.channels.surface.refresh', 'Refresh')}
            onRefresh={props.onRefresh}
          />
        )}
      >
        <Item
          title={enabledLabel}
          subtitle={props.t(
            'plugins.channels.surface.enabledPolicyDescription',
            'Allow this integration to accept and deliver under its saved policy.',
          )}
          accessoryOutsidePressable
          accessory={(
            <Form.Toggle
              testID="channels-connection-enabled"
              label={enabledLabel}
              value={props.draft.enabled}
              onChange={props.onEnabledChange}
              disabled={formDisabled}
            />
          )}
        />
        <Item
          title={observationAgeLabel}
          subtitle={props.t(
            'plugins.channels.surface.maximumObservationAgeDescription',
            'Accept incoming observations no older than this limit.',
          )}
          fieldAccessory
          accessoryOutsidePressable
          accessory={(
            <Form.Select
              testID="channels-connection-observation-age"
              presentation="field"
              label={observationAgeLabel}
              options={durationPresetOptions(OBSERVATION_AGE_PRESETS_MS, props.draft.maximumObservationAgeMs, props.t)}
              value={props.draft.maximumObservationAgeMs}
              onChange={(next) => {
                const selected = readActionInputOptionValue(next);
                if (typeof selected !== 'string') return;
                props.onMaximumObservationAgeMsChange(selected);
                if (validationIssue !== undefined) setValidationIssue(undefined);
              }}
              disabled={formDisabled}
            />
          )}
        />
      </ItemGroup>
      {validationIssue !== undefined ? (
        <Status testID="channels-connection-observation-age-issue" tone="danger" label={validationIssue} />
      ) : null}

      {props.execution.status === 'success' ? (
        <Status
          testID="channels-save-outcome"
          tone="secondary"
          label={props.t(
            'plugins.channels.surface.saved',
            'Saved to your Account. The selected machine will reconcile this policy when it is available.',
          )}
        />
      ) : null}

      {props.execution.status === 'error' ? (
        <Banner
          testID="channels-save-error"
          tone="danger"
          title={props.t('plugins.channels.surface.saveFailedTitle', 'Could not save connection policy')}
          description={props.t(
            'plugins.channels.surface.saveFailedDescription',
            'The Account policy was not saved. Refresh connection details before trying again.',
          )}
        />
      ) : null}

      {props.execution.status === 'outcomeUnknown' ? (
        <Banner
          testID="channels-save-outcome-unknown"
          tone="warning"
          title={props.t('plugins.channels.surface.saveUnknownTitle', 'Could not confirm the save')}
          description={props.t(
            'plugins.channels.surface.saveUnknownDescription',
            'The update may already be saved. Refresh connection details before making another change.',
          )}
          action={(
            <Action.Refresh
              testID="channels-save-outcome-unknown-reconcile"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={props.onRefresh}
            />
          )}
        />
      ) : null}

      <Row>
        <Button
          testID="channels-connection-save"
          title={saving
            ? props.t('plugins.channels.surface.saving', 'Saving…')
            : props.t('plugins.channels.surface.save', 'Save changes')}
          busy={saving}
          disabled={saveUnavailable}
          onPress={save}
        />
      </Row>

      <Metadata
        title={props.t('plugins.channels.surface.connectionDetailsTitle', 'Details')}
        entries={[
          {
            label: props.t('plugins.channels.surface.provider', 'Provider'),
            value: props.provider,
          },
          {
            label: props.t('plugins.channels.surface.transport', 'Transport'),
            value: transportLabel(props.connection.selectedTransport, props.t),
          },
        ]}
      />
    </Stack>
  );
}

/**
 * The registered Action dismisses the notice without changing the provider
 * cursor or retained input. Polling owns automatic cursor recovery.
 */
function ConnectionHistoryGapNoticeControls(props: Readonly<{
  connection: ChannelsConnection;
  resource: ResourcePresentation;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement | null {
  const noticeAction = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamNoticeDismiss,
  );
  const historyGap = props.connection.attention.historyGap;
  const outcomeUnknown = noticeAction.execution.status === 'outcomeUnknown';
  const resourceCurrent = props.resource.pending === 'idle'
    && props.resource.freshness === 'fresh'
    && props.resource.error === undefined;
  const requestRefresh = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown,
    resource: props.resource,
    onRefresh: props.onRefresh,
    onReconciled: noticeAction.reset,
  });

  const dismissNotice = React.useCallback(async () => {
    if (historyGap === null
      || !resourceCurrent
      || noticeAction.execution.status === 'pending'
      || noticeAction.execution.status === 'outcomeUnknown') {
      return;
    }
    const settled = await noticeAction.execute({
      connectionId: props.connection.connectionId,
      expectedRevision: props.connection.revision,
    });
    if (settled.status === 'success') props.onRefresh();
  }, [
    noticeAction,
    historyGap,
    props.connection.connectionId,
    props.connection.revision,
    props.onRefresh,
    resourceCurrent,
  ]);

  if (historyGap === null) return null;

  const busy = noticeAction.execution.status === 'pending';
  const unavailable = !resourceCurrent || busy || outcomeUnknown;
  return (
    <Stack testID="channels-history-gap-notice-controls" gap="small">
      <Button
        testID="channels-history-gap-notice-dismiss"
        title={busy
          ? props.t('plugins.channels.surface.historyGapBaselineAccepting', 'Dismissing notice…')
          : props.t('plugins.channels.surface.historyGapBaselineAccept', 'Dismiss notice')}
        accessibilityLabel={props.t(
          'plugins.channels.surface.historyGapBaselineAccept',
          'Dismiss notice',
        )}
        busy={busy}
        disabled={unavailable}
        onPress={() => { void dismissNotice(); }}
      />
      {noticeAction.execution.status === 'error' ? (
        <Banner
          testID="channels-history-gap-notice-error"
          tone="danger"
          title={props.t(
            'plugins.channels.surface.historyGapBaselineFailedTitle',
            'Could not dismiss the notice',
          )}
          description={props.t(
            'plugins.channels.surface.historyGapBaselineFailedDescription',
            'The history notice remains. Refresh the connection before trying again.',
          )}
          action={(
            <Action.Refresh
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={props.onRefresh}
            />
          )}
        />
      ) : null}
      {outcomeUnknown ? (
        <Banner
          testID="channels-history-gap-notice-outcome-unknown"
          tone="warning"
          title={props.t(
            'plugins.channels.surface.historyGapBaselineUnknownTitle',
            'Could not confirm notice dismissal',
          )}
          description={props.t(
            'plugins.channels.surface.historyGapBaselineUnknownDescription',
            'The request may already have been applied. Refresh the current connection before trying again.',
          )}
          action={(
            <Action.Refresh
              testID="channels-history-gap-notice-outcome-unknown-reconcile"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={requestRefresh}
            />
          )}
        />
      ) : null}
    </Stack>
  );
}

/**
 * Destructive connection lifecycle decisions stay at the registered mounted
 * Actions. This surface supplies only the current row precondition and always
 * rereads the canonical Resource after a definite settlement.
 */
function ConnectionLifecycleControls(props: Readonly<{
  connection: ChannelsConnection;
  resource: ResourcePresentation;
  onSettled?: (connectionId: string) => void;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement | null {
  const deleteAction = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete,
  );
  // A retained predecessor pending row is recovered only by explicit Delete.
  const mayDelete = props.connection.deletionState !== 'finalizingDelete';
  const outcomeUnknown = deleteAction.execution.status === 'outcomeUnknown';
  const requestRefresh = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown,
    resource: props.resource,
    onRefresh: props.onRefresh,
    onReconciled: deleteAction.reset,
  });

  const execute = React.useCallback(async () => {
    if (!mayDelete
      || deleteAction.execution.status === 'pending'
      || deleteAction.execution.status === 'outcomeUnknown') {
      return;
    }
    const settled = await deleteAction.execute({
      connectionId: props.connection.connectionId,
      expectedRevision: props.connection.revision,
    });
    if (settled.status === 'success') {
      props.onSettled?.(props.connection.connectionId);
    }
    if (settled.status !== 'pending' && settled.status !== 'outcomeUnknown') {
      props.onRefresh();
    }
  }, [deleteAction, mayDelete, props.connection, props.onRefresh, props.onSettled]);

  if (!mayDelete) return null;

  const busy = deleteAction.execution.status === 'pending';
  const title = props.t('plugins.channels.surface.delete', 'Delete connection');
  return (
    <Stack testID="channels-connection-lifecycle-controls" gap="small">
      <Button
        testID="channels-connection-delete"
        variant="destructive"
        title={busy
          ? props.t('plugins.channels.surface.deleting', 'Deleting…')
          : title}
        accessibilityLabel={title}
        busy={busy}
        disabled={busy || outcomeUnknown}
        onPress={() => { void execute(); }}
      />
      {deleteAction.execution.status === 'error' ? (
        <Banner
          testID="channels-connection-lifecycle-error"
          tone="danger"
          title={props.t(
            'plugins.channels.surface.deleteFailedTitle',
            'Could not start connection deletion',
          )}
          description={props.t(
            'plugins.channels.surface.deleteFailedDescription',
            'Happier reread the current connection details. Review its status before trying again.',
          )}
          action={(
            <Action.Refresh
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={props.onRefresh}
            />
          )}
        />
      ) : null}
      {outcomeUnknown ? (
        <Banner
          testID="channels-connection-lifecycle-outcome-unknown"
          tone="warning"
          title={props.t(
            'plugins.channels.surface.deleteUnknownTitle',
            'Could not confirm the deletion request',
          )}
          description={props.t(
            'plugins.channels.surface.deleteUnknownDescription',
            'The request may already be saved. Refresh connection details before making another change.',
          )}
          action={(
            <Action.Refresh
              testID="channels-connection-lifecycle-outcome-unknown-reconcile"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={requestRefresh}
            />
          )}
        />
      ) : null}
    </Stack>
  );
}

function ConnectionTransferProviderButton(props: Readonly<{
  operation: ProviderSetupOperation;
  busy: boolean;
  disabled: boolean;
  onPress: (operation: ProviderSetupOperation) => Promise<void>;
  t: Translate;
}>): React.ReactElement {
  const providerDisplayName = useConversationProviderDisplayName(props.operation.contributor.pluginId)
    ?? props.t('plugins.channels.surface.providerFallback', 'Integration provider');
  const operationKey = pluginUiTargetedContributionOperationKey(props.operation);
  return (
    <Button
      testID={`channels-connection-transfer-provider-${operationKey}`}
      title={`${props.t('plugins.channels.surface.connectionTransferWith', 'Transfer with')} ${providerDisplayName}`}
      variant="secondary"
      busy={props.busy}
      disabled={props.disabled}
      onPress={() => { void props.onPress(props.operation); }}
    />
  );
}

/**
 * Origin and transport replacement stays at the registered transfer Action.
 * The mounted surface supplies only the current connection CAS precondition
 * and a host-issued provider setup selection; it never constructs an origin,
 * policy, identifier, or idempotency key of its own.
 */
function WebhookEndpointSetupInstructions(props: Readonly<{
  setup: EndpointSetupPresentation;
  testIDPrefix: string;
  description: string;
  t: Translate;
}>): React.ReactElement {
  return (
    <Stack gap="small" testID={`${props.testIDPrefix}-webhook-required`}>
      <Heading
        level={4}
        value={props.t('plugins.channels.surface.webhookEndpointSetupRequiredTitle', 'Finish webhook setup')}
      />
      <Text value={props.description} />
      <Metadata
        entries={[
          {
            label: props.t('plugins.channels.surface.webhookEndpointUrl', 'Webhook URL'),
            value: props.setup.publicUrl,
          },
          ...(props.setup.oneTimeGeneratedSecret === undefined
            ? [{
                label: props.t('plugins.channels.surface.webhookEndpointSecret', 'Webhook secret'),
                value: props.t(
                  'plugins.channels.surface.webhookEndpointSecretLost',
                  'This secret was already shown once. Rotate the endpoint credential to receive a new one.',
                ),
              }]
            : [{
                label: props.t(
                  'plugins.channels.surface.webhookEndpointSecretShownOnce',
                  'Webhook secret (shown once)',
                ),
                value: props.setup.oneTimeGeneratedSecret,
              }]),
        ]}
      />
      <Action.Copy
        testID={`${props.testIDPrefix}-webhook-url-copy`}
        title={props.t('plugins.channels.surface.webhookEndpointUrlCopy', 'Copy webhook URL')}
        value={props.setup.publicUrl}
      />
      {props.setup.oneTimeGeneratedSecret === undefined ? null : (
        <Action.Copy
          testID={`${props.testIDPrefix}-webhook-secret-copy`}
          title={props.t('plugins.channels.surface.webhookEndpointSecretCopy', 'Copy webhook secret')}
          value={props.setup.oneTimeGeneratedSecret}
        />
      )}
      <Text
        testID={`${props.testIDPrefix}-webhook-readiness`}
        tone="secondary"
        value={props.setup.readiness === 'credentialDisclosureLost'
          ? props.t(
            'plugins.channels.surface.webhookEndpointCredentialDisclosureLost',
            'The endpoint exists, but its one-time secret is no longer available here. Rotate its credential if needed.',
          )
          : props.t(
            'plugins.channels.surface.webhookEndpointAwaitingConfirmation',
            'Save this webhook with your provider, then continue so Happier can confirm delivery.',
          )}
      />
    </Stack>
  );
}

function ConnectionTransferControls(props: Readonly<{
  connection: ChannelsConnection;
  signal: AbortSignal;
  targetPluginId: string;
  resource: ResourcePresentation;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement | null {
  const hostApi = usePluginHostApi();
  const surface = useSurfaceContext();
  const resolveProviderDisplayName = useConversationProviderDisplayNameResolver();
  const prepareAction = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
  );
  const transferAction = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer,
  );
  const ensureEndpointAction = useExecutePluginAction('plugin.webhook.endpoint.ensure');
  const [open, setOpen] = React.useState(false);
  const [selectionPending, setSelectionPending] = React.useState(false);
  const [selectedOperationKey, setSelectedOperationKey] = React.useState<string | undefined>();
  const [selectedTransport, setSelectedTransport] = React.useState<ConnectionCreateTransport>(
    isConversationConnectionSelectableTransportV1(props.connection.selectedTransport)
      ? props.connection.selectedTransport
      : 'checkpointedPull',
  );
  const [selectionUnavailable, setSelectionUnavailable] = React.useState(false);
  const [preparedPresentation, setPreparedPresentation] = React.useState<PreparedConnectionPresentation | undefined>();
  const [transferFailed, setTransferFailed] = React.useState(false);
  const [endpointSetupRequired, setEndpointSetupRequired] = React.useState<EndpointSetupPresentation | undefined>();
  // The transfer form's two phases announce themselves through the same mounted
  // focus owner the binding wizards use: opening the form and returning to
  // provider selection move logical focus to the form heading, and choosing a
  // provider moves it to the transport phase's first control.
  const formHeadingFocusTarget = usePluginUiFocusTarget();
  const transportPhaseFocusTarget = usePluginUiFocusTarget();
  React.useEffect(() => {
    if (!open) return;
    if (selectedOperationKey !== undefined) transportPhaseFocusTarget.focus();
    else formHeadingFocusTarget.focus();
  }, [formHeadingFocusTarget, open, selectedOperationKey, transportPhaseFocusTarget]);
  const selectionPendingRef = React.useRef(false);
  const selectedProviderSetupActionInputRef = React.useRef<SelectedProviderSetupActionInput | undefined>(undefined);
  const selectedProviderSetupLifetimeRef = React.useRef<AbortController | undefined>(undefined);
  /**
   * The exact endpoint-ensure input the core minted for this attempt, retained
   * only while an ensure outcome is unknown. A deliberate second Confirm
   * replays these bytes — the same core-minted idempotency key — instead of
   * running the no-continuation transfer again and minting a second endpoint
   * attempt. The key is never derived here; its producer is the transfer result.
   */
  const retainedEndpointEnsureRef = React.useRef<ConnectionEndpointContinuation | undefined>(undefined);
  const retireSelectedProviderSetup = React.useCallback(() => {
    selectedProviderSetupLifetimeRef.current?.abort();
    selectedProviderSetupLifetimeRef.current = undefined;
    selectedProviderSetupActionInputRef.current = undefined;
    // A definite lifecycle ending or a form identity reset retires the retained
    // attempt together with the selection it belonged to.
    retainedEndpointEnsureRef.current = undefined;
  }, []);
  const mountedRef = React.useRef(true);
  const operations = React.useMemo(
    () => currentProviderSetupOperations(
      surface.targetedContributions,
      props.targetPluginId,
      props.connection.providerPluginId,
    ),
    [props.connection.providerPluginId, props.targetPluginId, surface.targetedContributions],
  );
  const supportsActionInputSelection = hostApi.version().methods.includes('selectActionInput');
  const transferBlocked = props.connection.deletionState !== 'none'
    || (props.connection.attention.oldTransportStopUnconfirmed
      && !props.connection.attention.acceptedPossibleLoss);
  const transferOutcomeUnknown = transferAction.execution.status === 'outcomeUnknown';
  // An ambiguous endpoint ensure admits only a deliberate second Confirm:
  // provider and transport identity stay frozen around the retained
  // core-minted idempotency key while that press rejoins the exact same ensure.
  const actionUnavailable = transferBlocked
    || selectionPending
    || prepareAction.execution.status === 'pending'
    || prepareAction.execution.status === 'outcomeUnknown'
    || transferAction.execution.status === 'pending'
    || transferOutcomeUnknown
    || ensureEndpointAction.execution.status === 'pending';
  const transferIdentityUnavailable = actionUnavailable
    || ensureEndpointAction.execution.status === 'outcomeUnknown';
  const defaultTransport = isConversationConnectionSelectableTransportV1(props.connection.selectedTransport)
    ? props.connection.selectedTransport
    : 'checkpointedPull';
  const transferTransports = CONVERSATION_CONNECTION_SELECTABLE_TRANSPORTS_V1;

  const openTransfer = React.useCallback(() => {
    if (actionUnavailable) return;
    retireSelectedProviderSetup();
    setSelectedOperationKey(undefined);
    setSelectedTransport(defaultTransport);
    setSelectionUnavailable(false);
    setPreparedPresentation(undefined);
    setTransferFailed(false);
    setEndpointSetupRequired(undefined);
    transferAction.reset();
    ensureEndpointAction.reset();
    setOpen(true);
  }, [actionUnavailable, defaultTransport, ensureEndpointAction.reset, retireSelectedProviderSetup, transferAction.reset]);

  const cancelTransfer = React.useCallback(() => {
    if (selectionPending
      || transferAction.execution.status === 'pending'
      || transferAction.execution.status === 'outcomeUnknown') {
      return;
    }
    retireSelectedProviderSetup();
    setSelectedOperationKey(undefined);
    setSelectedTransport(defaultTransport);
    setSelectionUnavailable(false);
    setPreparedPresentation(undefined);
    setTransferFailed(false);
    setEndpointSetupRequired(undefined);
    transferAction.reset();
    ensureEndpointAction.reset();
    setOpen(false);
  }, [
    defaultTransport,
    selectionPending,
    ensureEndpointAction.reset,
    retireSelectedProviderSetup,
    transferAction.execution.status,
    transferAction.reset,
  ]);

  const backToProviderSelection = React.useCallback(() => {
    if (selectionPending
      || transferAction.execution.status === 'pending'
      || transferAction.execution.status === 'outcomeUnknown') {
      return;
    }
    // Provider setup input is a transient host-issued settlement. Back keeps
    // the user-selected transport draft, but requires a fresh provider setup
    // selection before a terminal transfer can execute.
    retireSelectedProviderSetup();
    setSelectedOperationKey(undefined);
    setSelectionUnavailable(false);
    setPreparedPresentation(undefined);
    setTransferFailed(false);
    setEndpointSetupRequired(undefined);
    transferAction.reset();
    ensureEndpointAction.reset();
  }, [ensureEndpointAction.reset, retireSelectedProviderSetup, selectionPending, transferAction.execution.status, transferAction.reset]);

  const onTransferOutcomeReconciled = React.useCallback(() => {
    retireSelectedProviderSetup();
    setSelectedOperationKey(undefined);
    setSelectionUnavailable(false);
    setPreparedPresentation(undefined);
    setTransferFailed(false);
    setEndpointSetupRequired(undefined);
    transferAction.reset();
    ensureEndpointAction.reset();
  }, [ensureEndpointAction.reset, retireSelectedProviderSetup, transferAction.reset]);
  const requestRefresh = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown: transferOutcomeUnknown,
    resource: props.resource,
    onRefresh: props.onRefresh,
    onReconciled: onTransferOutcomeReconciled,
  });

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      retireSelectedProviderSetup();
    };
  }, [retireSelectedProviderSetup]);

  React.useEffect(() => {
    const clearSelection = () => retireSelectedProviderSetup();
    if (props.signal.aborted) clearSelection();
    else props.signal.addEventListener('abort', clearSelection, { once: true });
    return () => props.signal.removeEventListener('abort', clearSelection);
  }, [props.signal, retireSelectedProviderSetup]);

  React.useEffect(() => {
    const selected = selectedProviderSetupActionInputRef.current;
    if (selected === undefined) return;
    const operationKey = pluginUiTargetedContributionOperationKey(selected.operation);
    if (operations.some((operation) => pluginUiTargetedContributionOperationKey(operation) === operationKey)) return;
    // A host context/currentness revision withdrew the operation that supplied
    // this transient settlement, so it cannot reach the terminal Action.
    retireSelectedProviderSetup();
    setSelectedOperationKey(undefined);
    setPreparedPresentation(undefined);
    setSelectionUnavailable(true);
  }, [operations, retireSelectedProviderSetup]);

  const selectProvider = React.useCallback(async (operation: ProviderSetupOperation) => {
    if (props.signal.aborted
      || transferBlocked
      || selectionPendingRef.current
      || transferAction.execution.status === 'pending'
      || transferAction.execution.status === 'outcomeUnknown'
      || ensureEndpointAction.execution.status === 'pending'
      || ensureEndpointAction.execution.status === 'outcomeUnknown') {
      return;
    }
    selectionPendingRef.current = true;
    retireSelectedProviderSetup();
    if (mountedRef.current) {
      setSelectionPending(true);
      setSelectedOperationKey(undefined);
      setSelectionUnavailable(false);
      setTransferFailed(false);
      transferAction.reset();
    }
    try {
      let selection: SelectActionInputResult;
      try {
        const selectionLifetime = new AbortController();
        selectedProviderSetupLifetimeRef.current = selectionLifetime;
        selection = await hostApi.selectActionInput({ operation }, { signal: selectionLifetime.signal });
      } catch {
        retireSelectedProviderSetup();
        if (mountedRef.current && !props.signal.aborted) setSelectionUnavailable(true);
        return;
      }
      if (selection.kind !== 'submitted' || props.signal.aborted || !mountedRef.current) {
        retireSelectedProviderSetup();
        return;
      }
      selectedProviderSetupActionInputRef.current = { operation, result: selection };
      const selectedActionInput = { operation, result: selection };
      const preparedSettlement = await prepareAction.execute({
        providerSelection: selection.selection,
        providerSetupInput: selection.input,
        credentialRef: selection.connectedAccount.kind === 'selected'
          ? selection.connectedAccount.ref
          : null,
      }, { signal: props.signal, selectedActionInput });
      if (!mountedRef.current || props.signal.aborted) return;
      if (preparedSettlement.status !== 'success') {
        retireSelectedProviderSetup();
        setSelectionUnavailable(true);
        return;
      }
      const prepared = ConversationConnectionPrepareResultV1Schema.safeParse(preparedSettlement.result);
      if (!prepared.success || prepared.data.kind !== 'ready') {
        retireSelectedProviderSetup();
        setSelectionUnavailable(true);
        return;
      }
      setPreparedPresentation({
        providerDisplayName: resolveProviderDisplayName(operation.contributor.pluginId)
          ?? props.t('plugins.channels.surface.providerFallback', 'Integration provider'),
        connectedAccountLabel: selection.presentation.connectedAccountLabel,
        machineDisplayName: selection.presentation.machineDisplayName,
        ...(prepared.data.destinationLabel === undefined ? {} : { destinationLabel: prepared.data.destinationLabel }),
        overlapSafety: prepared.data.overlapSafety,
        replayContinuity: prepared.data.replayContinuity,
        outboundTextLimit: prepared.data.outboundTextLimit,
      });
      setSelectedOperationKey(pluginUiTargetedContributionOperationKey(operation));
    } finally {
      selectionPendingRef.current = false;
      if (mountedRef.current && !props.signal.aborted) setSelectionPending(false);
    }
  }, [ensureEndpointAction.execution.status, hostApi, prepareAction, props.signal, props.t, resolveProviderDisplayName, retireSelectedProviderSetup, transferAction, transferBlocked]);

  const transfer = React.useCallback(async () => {
    // An ambiguous endpoint ensure stays admitted here: the next deliberate
    // press re-enters the existing reset-and-rejoin block below with the same
    // retained ensure input. A definite transfer ambiguity still requires the
    // refresh/reread reconciliation before another press.
    if (props.signal.aborted
      || transferBlocked
      || selectionPendingRef.current
      || transferAction.execution.status === 'pending'
      || transferAction.execution.status === 'outcomeUnknown'
      || ensureEndpointAction.execution.status === 'pending') {
      return;
    }
    const selectedActionInput = selectedProviderSetupActionInputRef.current;
    if (selectedActionInput === undefined
      || selectedOperationKey === undefined
      || pluginUiTargetedContributionOperationKey(selectedActionInput.operation) !== selectedOperationKey
      || !operations.some((operation) => (
        pluginUiTargetedContributionOperationKey(operation) === selectedOperationKey
      ))) {
      setSelectionUnavailable(true);
      return;
    }
    const selection = selectedActionInput.result;
    const parsedInput = ConversationConnectionTransferInputV1Schema.safeParse({
      connectionId: props.connection.connectionId,
      expectedRevision: props.connection.revision,
      expectedAuthorityEpoch: props.connection.authorityEpoch,
      providerSelection: selection.selection,
      providerSetupInput: selection.input,
      credentialRef: selection.connectedAccount.kind === 'selected'
        ? selection.connectedAccount.ref
        : null,
      selectedTransport,
    });
    if (!parsedInput.success) {
      setSelectionUnavailable(true);
      return;
    }
    setSelectionUnavailable(false);
    setTransferFailed(false);
    setEndpointSetupRequired(undefined);
    // A retained attempt already created the connection and already carries the
    // core-minted endpoint key, so the no-continuation transfer is skipped
    // entirely: re-running it would mint a second endpoint attempt for the same
    // visible press.
    let retained = retainedEndpointEnsureRef.current;
    if (retained === undefined) {
      // One selected Connected Account remains purpose-bound to this mounted
      // transfer through provider setup, endpoint ensure, continuation, and a
      // response-loss rejoin. It is retired only after a definite terminal
      // outcome or explicit abandonment; no credential material enters plugin
      // state or the public transfer input.
      const settled = await transferAction.execute(parsedInput.data, {
        signal: props.signal,
        selectedActionInput,
      });
      if (!mountedRef.current || props.signal.aborted) return;
      if (settled.status !== 'success') {
        if (settled.status === 'error') setTransferFailed(true);
        return;
      }
      const result = ConversationConnectionTransferResultV1Schema.safeParse(settled.result);
      if (!result.success) {
        setTransferFailed(true);
        return;
      }
      if (result.data.kind === 'transferred'
        || result.data.kind === 'rejoined'
        || result.data.kind === 'transferPendingOldStop') {
        retireSelectedProviderSetup();
        setSelectedOperationKey(undefined);
        setTransferFailed(false);
        props.onRefresh();
        return;
      }
      if (result.data.kind !== 'endpointRequired') {
        setTransferFailed(true);
        return;
      }
      retained = {
        connectionId: result.data.connectionId,
        endpointEnsureInput: {
          webhookContribution: { ...result.data.webhookContribution },
          targetMaterialization: { ...result.data.targetMaterialization },
          sourceInstanceId: result.data.sourceInstanceId,
          setup: { ...result.data.webhookEndpointSetup },
          idempotencyKey: result.data.webhookEndpointIdempotencyKey,
        },
      };
      retainedEndpointEnsureRef.current = retained;
    }

    if (ensureEndpointAction.execution.status === 'outcomeUnknown') {
      ensureEndpointAction.reset();
    }
    const ensured = await ensureEndpointAction.execute(
      retained.endpointEnsureInput,
      { signal: props.signal },
    );
    if (!mountedRef.current || props.signal.aborted) return;
    if (ensured.status === 'outcomeUnknown') {
      // The endpoint may already exist. Keep the controller truthfully in its
      // unknown-outcome state and keep the retained input, so the next
      // deliberate press replays these exact bytes; no second endpoint attempt
      // is minted and no definite-failure presentation replaces the ambiguity.
      return;
    }
    if (ensured.status !== 'success') {
      // A definite ensure failure ends this attempt: the retained rejoin has
      // nothing left to reconcile and the next press starts a fresh transfer.
      retainedEndpointEnsureRef.current = undefined;
      setTransferFailed(true);
      return;
    }
    if (ensured.result.readiness === 'providerConfirmationRequired'
      || ensured.result.readiness === 'credentialDisclosureLost') {
      const setupRequired = ConversationConnectionCreateResultV1Schema.safeParse({
        kind: 'webhookEndpointSetupRequired',
        webhookEndpointId: ensured.result.webhookEndpointId,
        publicUrl: ensured.result.publicUrl,
        readiness: ensured.result.readiness,
        ...(ensured.result.oneTimeGeneratedSecret === undefined
          ? {}
          : { oneTimeGeneratedSecret: ensured.result.oneTimeGeneratedSecret }),
      });
      if (!setupRequired.success || setupRequired.data.kind !== 'webhookEndpointSetupRequired') {
        setTransferFailed(true);
        return;
      }
      setEndpointSetupRequired(setupRequired.data);
    }
    // The one selected Connected Account stays purpose-bound through the
    // continuation too. Dropping the carrier here would make the continuation
    // an unselected invocation of the same mounted transfer attempt.
    const continuationSettled = await transferAction.execute({
      ...parsedInput.data,
      endpointContinuation: {
        connectionId: retained.connectionId,
        webhookEndpointId: ensured.result.webhookEndpointId,
      },
    }, { signal: props.signal, selectedActionInput });
    if (!mountedRef.current || props.signal.aborted) return;
    if (continuationSettled.status !== 'success') {
      if (continuationSettled.status === 'error') setTransferFailed(true);
      return;
    }
    const continuation = ConversationConnectionTransferResultV1Schema.safeParse(continuationSettled.result);
    if (!continuation.success
      || (continuation.data.kind !== 'transferred'
        && continuation.data.kind !== 'rejoined'
        && continuation.data.kind !== 'transferPendingOldStop')) {
      setTransferFailed(true);
      return;
    }
    retireSelectedProviderSetup();
    setSelectedOperationKey(undefined);
    setTransferFailed(false);
    props.onRefresh();
  }, [
    ensureEndpointAction,
    operations,
    props.connection.connectionId,
    props.connection.revision,
    props.onRefresh,
    props.signal,
    retireSelectedProviderSetup,
    selectedOperationKey,
    selectedTransport,
    transferAction,
    transferBlocked,
  ]);

  if (!supportsActionInputSelection || operations.length === 0 || transferBlocked) return null;

  return (
    <Stack testID="channels-connection-transfer-controls" gap="small">
      <Button
        testID="channels-connection-transfer-open"
        title={props.t('plugins.channels.surface.connectionTransfer', 'Transfer connection')}
        variant="secondary"
        disabled={actionUnavailable}
        onPress={openTransfer}
      />
      {open ? (
        <Stack testID="channels-connection-transfer-form" gap="small">
          <Heading
            level={3}
            value={props.t('plugins.channels.surface.connectionTransferTitle', 'Transfer connection')}
            focusTarget={formHeadingFocusTarget}
          />
          <Text
            value={props.t(
              'plugins.channels.surface.connectionTransferDescription',
              'Choose the provider setup and transport that will replace this connection. Happier keeps the current connection identity and existing stop custody.',
            )}
          />
          <Button
            testID="channels-connection-transfer-cancel"
            title={props.t('plugins.channels.surface.connectionTransferCancel', 'Cancel transfer')}
            variant="plain"
            disabled={selectionPending
              || transferAction.execution.status === 'pending'
              || transferOutcomeUnknown}
            onPress={cancelTransfer}
          />
          {operations.map((operation) => {
            const operationKey = pluginUiTargetedContributionOperationKey(operation);
            return (
              <ConnectionTransferProviderButton
                key={operationKey}
                operation={operation}
                busy={selectionPending}
                disabled={transferIdentityUnavailable}
                onPress={selectProvider}
                t={props.t}
              />
            );
          })}
          {selectedOperationKey === undefined ? null : (
            <>
              {preparedPresentation === undefined ? null : (
                <ConnectionPreparationReview
                  presentation={preparedPresentation}
                  accountEncryptionMode={surface.accountEncryptionMode}
                  testID="channels-connection-transfer-review"
                  t={props.t}
                />
              )}
              <Button
                testID="channels-connection-transfer-back"
                title={props.t('plugins.channels.surface.back', 'Back')}
                variant="plain"
                disabled={selectionPending
                  || transferAction.execution.status === 'pending'
                  || transferOutcomeUnknown}
                onPress={backToProviderSelection}
              />
              <Form.Select
                testID="channels-connection-transfer-transport"
                label={props.t('plugins.channels.surface.transport', 'Transport')}
                options={transferTransports.map((transport) => ({
                  value: transport,
                  label: transportOutcomeLabel(transport, props.t),
                }))}
                value={selectedTransport}
                disabled={transferIdentityUnavailable}
                focusTarget={transportPhaseFocusTarget}
                onChange={(next) => {
                  if (!transferIdentityUnavailable
                    && isConversationConnectionSelectableTransportV1(next)) {
                    setSelectedTransport(next);
                  }
                }}
              />
              <Button
                testID="channels-connection-transfer-submit"
                title={transferAction.execution.status === 'pending'
                  ? props.t('plugins.channels.surface.connectionTransferring', 'Transferring…')
                  : props.t('plugins.channels.surface.connectionTransferConfirm', 'Confirm transfer')}
                busy={transferAction.execution.status === 'pending'}
                disabled={actionUnavailable}
                onPress={transfer}
              />
            </>
          )}
          {endpointSetupRequired === undefined ? null : (
            <WebhookEndpointSetupInstructions
              setup={endpointSetupRequired}
              testIDPrefix="channels-connection-transfer"
              description={props.t(
                'plugins.channels.surface.webhookEndpointTransferSetupRequiredDescription',
                'Add this endpoint to your provider. The transferred connection keeps this setup visible while provider delivery is confirmed.',
              )}
              t={props.t}
            />
          )}
          {selectionUnavailable ? (
            <Banner
              testID="channels-connection-transfer-selection-unavailable"
              tone="warning"
              title={props.t('plugins.channels.surface.connectionTransferUnavailableTitle', 'Connection transfer is unavailable')}
              description={props.t(
                'plugins.channels.surface.connectionTransferUnavailableDescription',
                'Refresh connection details and make a new provider selection before trying again.',
              )}
            />
          ) : null}
          {transferFailed ? (
            <Banner
              testID="channels-connection-transfer-result-failed"
              tone="warning"
              title={props.t('plugins.channels.surface.connectionTransferFailedTitle', 'Could not transfer the connection')}
              description={props.t(
                'plugins.channels.surface.connectionTransferResultFailedDescription',
                'The provider did not accept this replacement. Refresh connection details and make a new provider selection before trying again.',
              )}
            />
          ) : null}
          {transferAction.execution.status === 'error' ? (
            <Banner
              testID="channels-connection-transfer-error"
              tone="danger"
              title={props.t('plugins.channels.surface.connectionTransferFailedTitle', 'Could not transfer the connection')}
              description={props.t(
                'plugins.channels.surface.connectionTransferFailedDescription',
                'The connection was not changed. Refresh its current details before trying again.',
              )}
              action={(
                <Action.Refresh
                  title={props.t('plugins.channels.surface.refresh', 'Refresh')}
                  onRefresh={props.onRefresh}
                />
              )}
            />
          ) : null}
          {transferOutcomeUnknown ? (
            <Banner
              testID="channels-connection-transfer-outcome-unknown"
              tone="warning"
              title={props.t('plugins.channels.surface.connectionTransferUnknownTitle', 'Could not confirm connection transfer')}
              description={props.t(
                'plugins.channels.surface.connectionTransferUnknownDescription',
                'The connection may already be transferred. Refresh its authoritative details before deciding what to do next.',
              )}
              action={(
                <Action.Refresh
                  testID="channels-connection-transfer-outcome-unknown-reconcile"
                  title={props.t('plugins.channels.surface.refresh', 'Refresh')}
                  onRefresh={requestRefresh}
                />
              )}
            />
          ) : null}
          {ensureEndpointAction.execution.status === 'outcomeUnknown' ? (
            <Banner
              testID="channels-connection-transfer-endpoint-ensure-outcome-unknown"
              tone="warning"
              title={props.t(
                'plugins.channels.surface.connectionTransferEndpointEnsureUnknownTitle',
                'Could not confirm the endpoint change',
              )}
              description={props.t(
                'plugins.channels.surface.connectionTransferEndpointEnsureUnknownDescription',
                'The endpoint may already be configured. Press Confirm transfer again to rejoin the same endpoint attempt; nothing is created twice.',
              )}
            />
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}

/**
 * A blocked poll is the one connection-level recovery that clears existing
 * custody locally. The Action owns its exact revision/epoch CAS and never
 * invokes a provider from this management surface.
 */
function ConnectionPollRetryControls(props: Readonly<{
  connection: ChannelsConnection;
  resource: ResourcePresentation;
  onRefresh: () => void;
  /** The connection's one recommended recovery: drawn as the row's primary action. */
  primary?: boolean;
  t: Translate;
}>): React.ReactElement | null {
  const retryAction = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry,
  );
  const outcomeUnknown = retryAction.execution.status === 'outcomeUnknown';
  const requestRefresh = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown,
    resource: props.resource,
    onRefresh: props.onRefresh,
    onReconciled: retryAction.reset,
  });
  const retry = React.useCallback(async () => {
    if (props.connection.attention.ingressConflict !== null
      || props.connection.attention.pollFailure?.phase !== 'blocked'
      || retryAction.execution.status === 'pending'
      || retryAction.execution.status === 'outcomeUnknown') {
      return;
    }
    const settled = await retryAction.execute({
      connectionId: props.connection.connectionId,
      expectedRevision: props.connection.revision,
      authorityEpoch: props.connection.authorityEpoch,
    });
    if (settled.status !== 'pending' && settled.status !== 'outcomeUnknown') {
      props.onRefresh();
    }
  }, [props.connection, props.onRefresh, retryAction]);

  if (
    props.connection.attention.ingressConflict !== null
    || props.connection.attention.pollFailure?.phase !== 'blocked'
  ) return null;

  const busy = retryAction.execution.status === 'pending';
  return (
    <Stack testID="channels-poll-retry-controls" gap="small">
      <Button
        testID="channels-connection-poll-retry"
        variant={props.primary === true ? 'primary' : 'secondary'}
        title={busy
          ? props.t('plugins.channels.surface.pollRetrying', 'Retrying polling…')
          : props.t('plugins.channels.surface.pollRetry', 'Retry polling')}
        accessibilityLabel={props.t('plugins.channels.surface.pollRetry', 'Retry polling')}
        busy={busy}
        disabled={busy || outcomeUnknown}
        onPress={retry}
      />
      {retryAction.execution.status === 'error' ? (
        <Banner
          testID="channels-poll-retry-error"
          tone="warning"
          title={props.t('plugins.channels.surface.pollRetryFailedTitle', 'Could not retry polling')}
          description={retryAction.execution.message}
          action={(
            <Action.Refresh
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={props.onRefresh}
            />
          )}
        />
      ) : null}
      {outcomeUnknown ? (
        <Banner
          testID="channels-poll-retry-outcome-unknown"
          tone="warning"
          title={props.t('plugins.channels.surface.pollRetryUnknownTitle', 'Could not confirm the polling retry')}
          description={props.t(
            'plugins.channels.surface.pollRetryUnknownDescription',
            'The retry may already be scheduled. Refresh connection details before trying again.',
          )}
          action={(
            <Action.Refresh
              testID="channels-poll-retry-outcome-unknown-reconcile"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={requestRefresh}
            />
          )}
        />
      ) : null}
    </Stack>
  );
}

/**
 * The one recovery for a saved connection whose provider side went wrong after
 * creation. It re-runs the provider's own connection test through the
 * management Action and shows what came back, so the exit from a failed
 * connection is no longer delete-and-recreate. Eligibility, the probe, and the
 * readiness settlement all belong to that Action; this surface adds no second
 * health state of its own.
 */
type ConnectionRetestProps = Readonly<{
  connection: ChannelsConnection;
  resource: ResourcePresentation;
  onRefresh: () => void;
  /** The connection's one recommended recovery: drawn as the row's primary action. */
  primary?: boolean;
  t: Translate;
}>;

/**
 * The one connection test: its Action, its verdict and its reconciliation. The
 * Settings connection row and the Channels page's Bot section place its
 * control differently; both run exactly this.
 */
function useConnectionRetest(props: ConnectionRetestProps): Readonly<{
  retestable: boolean;
  busy: boolean;
  outcomeUnknown: boolean;
  retest: () => Promise<void>;
  feedback: React.ReactElement;
}> {
  const retestAction = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionRetest,
  );
  const outcomeUnknown = retestAction.execution.status === 'outcomeUnknown';
  const requestRefresh = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown,
    resource: props.resource,
    onRefresh: props.onRefresh,
    onReconciled: retestAction.reset,
  });
  const [verdict, setVerdict] = React.useState<
    | Readonly<{ kind: 'ready' }>
    | Readonly<{ kind: 'notReady'; reason: string; diagnostic?: string }>
    | undefined
  >();
  const retestable = props.connection.enabled
    && props.connection.deletionState === 'none'
    && !props.connection.attention.oldTransportStopUnconfirmed;
  const retest = React.useCallback(async () => {
    if (!retestable
      || retestAction.execution.status === 'pending'
      || retestAction.execution.status === 'outcomeUnknown') {
      return;
    }
    setVerdict(undefined);
    const settled = await retestAction.execute({
      connectionId: props.connection.connectionId,
      expectedRevision: props.connection.revision,
      authorityEpoch: props.connection.authorityEpoch,
    });
    if (settled.status === 'success') {
      const parsed = ConversationConnectionRetestResultV1Schema.safeParse(settled.result);
      setVerdict(parsed.success
        ? (parsed.data.kind === 'ready'
          ? { kind: 'ready' }
          : {
            kind: 'notReady',
            reason: parsed.data.reason,
            ...(parsed.data.diagnostic === undefined ? {} : { diagnostic: parsed.data.diagnostic }),
          })
        : undefined);
    }
    if (settled.status !== 'pending' && settled.status !== 'outcomeUnknown') {
      props.onRefresh();
    }
  }, [
    props.connection.authorityEpoch,
    props.connection.connectionId,
    props.connection.revision,
    props.onRefresh,
    retestable,
    retestAction,
  ]);

  const busy = retestAction.execution.status === 'pending';
  return {
    retestable,
    busy,
    outcomeUnknown,
    retest,
    feedback: (
      <>
        {verdict?.kind === 'ready' ? (
          <Banner
            testID="channels-connection-retest-ready"
            tone="secondary"
            title={props.t('plugins.channels.surface.connectionRetestReadyTitle', 'The connection is working')}
            description={props.t(
              'plugins.channels.surface.connectionRetestReadyDescription',
              'The integration provider answered this connection successfully.',
            )}
          />
        ) : null}
        {verdict?.kind === 'notReady' ? (
          <Banner
            testID="channels-connection-retest-not-ready"
            tone="warning"
            title={props.t('plugins.channels.surface.connectionRetestNotReadyTitle', 'The connection is still not working')}
            description={verdict.diagnostic ?? providerFailureReasonDescription(verdict.reason, props.t)}
          />
        ) : null}
        {retestAction.execution.status === 'error' ? (
          <Banner
            testID="channels-connection-retest-error"
            tone="warning"
            title={props.t('plugins.channels.surface.connectionRetestFailedTitle', 'Could not test the connection')}
            description={retestAction.execution.message}
            action={(
              <Action.Refresh
                title={props.t('plugins.channels.surface.refresh', 'Refresh')}
                onRefresh={props.onRefresh}
              />
            )}
          />
        ) : null}
        {outcomeUnknown ? (
          <Banner
            testID="channels-connection-retest-outcome-unknown"
            tone="warning"
            title={props.t('plugins.channels.surface.connectionRetestUnknownTitle', 'Could not confirm the connection test')}
            description={props.t(
              'plugins.channels.surface.connectionRetestUnknownDescription',
              'The test may already have run. Refresh connection details before trying again.',
            )}
            action={(
              <Action.Refresh
                testID="channels-connection-retest-outcome-unknown-reconcile"
                title={props.t('plugins.channels.surface.refresh', 'Refresh')}
                onRefresh={requestRefresh}
              />
            )}
          />
        ) : null}
      </>
    ),
  };
}

function ConnectionRetestControls(props: ConnectionRetestProps): React.ReactElement | null {
  const { retestable, busy, outcomeUnknown, retest, feedback } = useConnectionRetest(props);
  if (!retestable) return null;
  return (
    <Stack testID="channels-connection-retest-controls" gap="small">
      <Button
        testID="channels-connection-retest"
        variant={props.primary === true ? 'primary' : 'secondary'}
        title={busy
          ? props.t('plugins.channels.surface.connectionRetesting', 'Testing connection…')
          : props.t('plugins.channels.surface.connectionRetest', 'Test connection')}
        accessibilityLabel={props.t('plugins.channels.surface.connectionRetest', 'Test connection')}
        busy={busy}
        disabled={busy || outcomeUnknown}
        onPress={retest}
      />
      {feedback}
    </Stack>
  );
}

/**
 * The provider-neutral reason vocabulary the connection test already shares
 * with every other provider failure. It is projected here, never re-derived
 * into a Channels-local health verdict.
 */
function providerFailureReasonDescription(reason: string, t: Translate): string {
  switch (reason) {
    case 'credentialInvalid':
      return t(
        'plugins.channels.surface.providerFailureCredentialInvalid',
        'The provider rejected the saved credential for this connection.',
      );
    case 'permissionMissing':
      return t(
        'plugins.channels.surface.providerFailurePermissionMissing',
        'The provider reports that a required remote permission is unavailable.',
      );
    case 'rateLimited':
      return t(
        'plugins.channels.surface.providerFailureRateLimited',
        'The provider is rate limiting this connection right now.',
      );
    case 'providerConflict':
      return t(
        'plugins.channels.surface.providerFailureProviderConflict',
        'Another integration is already using this conversation on the provider.',
      );
    case 'unsupported':
      return t(
        'plugins.channels.surface.providerFailureUnsupported',
        'The provider no longer supports the transport this connection saved.',
      );
    case 'invalidConfiguration':
      return t(
        'plugins.channels.surface.providerFailureInvalidConfiguration',
        'The provider reports that its remote configuration is not valid for this connection.',
      );
    default:
      return t(
        'plugins.channels.surface.providerFailureNetwork',
        'The provider could not be reached for this connection.',
      );
  }
}

/**
 * The direct Account page exposes only the retained blocked lifecycle fact and
 * its exact revision. Retrying remains the ingress Action's responsibility:
 * this UI never reconstructs, replays, or dispatches the saved input itself.
 */
/** Whether the read recommends retrying this saved input, with every operand it needs. */
function ingressRetryRecommended(recommendation: ConversationIngressAttentionRow['recommendedRecovery']): boolean {
  return recommendation !== undefined
    && recommendation !== null
    && typeof recommendation.action !== 'string'
    && recommendation.action.localId === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.ingressRetry
    && recommendation.unavailableReason === undefined;
}

/** The conversation a saved input belongs to, named from the page's reads; never an id. */
function ingressAttentionConversationName(
  row: ConversationIngressAttentionRow,
  bindings: readonly ChannelsBinding[] | undefined,
  connections: readonly ChannelsConnection[],
  t: Translate,
): string {
  const bindingId = row.bindingId;
  // Until the binding read settles, a linked conversation is not yet known to be missing.
  if (bindingId !== undefined && bindings === undefined) {
    return t('plugins.channels.surface.bindingEndpointFallback', 'External conversation');
  }
  if (bindingId !== undefined && bindings !== undefined) {
    const binding = bindings.find((candidate) => candidate.bindingId === bindingId);
    return binding === undefined
      ? t('plugins.channels.surface.deliveryResolutionGroupUnlisted', 'A conversation not listed here')
      : bindingEndpointLabel(binding, t);
  }
  const connection = connections.find((candidate) => candidate.connectionId === row.connectionId);
  return connection === undefined
    ? t('plugins.channels.surface.deliveryResolutionGroupConnection', 'Outside linked conversations')
    : connectionLabel(connection);
}

function IngressAttentionControls(props: Readonly<{
  signal: AbortSignal;
  recoveryActionsAvailable: boolean;
  /** The page's binding and connection reads, which name the conversation each saved input belongs to; `undefined` while the binding read is pending. */
  bindings: readonly ChannelsBinding[] | undefined;
  connections: readonly ChannelsConnection[];
  t: Translate;
}>): React.ReactElement | null {
  const dataClient = usePluginUiDataClient();
  const collection = React.useMemo(
    () => dataClient.collection(CHANNEL_STATE_COLLECTION),
    [dataClient],
  );
  const attentionRows = useIngressAttentionRows({
    collection,
    signal: props.signal,
  });
  const retryAction = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.ingressRetry,
  );
  const [activeObligationId, setActiveObligationId] = React.useState<string | undefined>();
  const actionOutcomeUnknown = retryAction.execution.status === 'outcomeUnknown';
  const actionUnavailable = retryAction.execution.status === 'pending' || actionOutcomeUnknown;

  const retry = React.useCallback(async (row: Extract<ConversationIngressAttentionRow, { kind: 'blocked' }>) => {
    if (!props.recoveryActionsAvailable || actionUnavailable) return;
    setActiveObligationId(row.obligationId);
    let outcomeUnknown = false;
    try {
      const settled = await retryAction.execute({
        obligationId: row.obligationId,
        expectedRevision: row.revision,
      });
      outcomeUnknown = settled.status === 'outcomeUnknown';
      if (outcomeUnknown) return;
      if (settled.status !== 'pending') attentionRows.refresh();
    } finally {
      if (!outcomeUnknown) setActiveObligationId(undefined);
    }
  }, [actionUnavailable, attentionRows, props.recoveryActionsAvailable, retryAction.execute]);

  // Same canonical unknown-outcome owner as the delivery-resolution controls:
  // the reread must settle idle, fresh, and error-free before the ambiguity
  // lock clears; failed reads keep the typed recovery surface.
  const requestAttentionReread = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown: actionOutcomeUnknown,
    resource: attentionRows.resource,
    onRefresh: attentionRows.refresh,
    onReconciled: React.useCallback(() => {
      setActiveObligationId(undefined);
      retryAction.reset();
    }, [retryAction.reset]),
  });

  const rows = attentionRows.rows ?? [];
  const loading = attentionRows.resource.pending !== 'idle';
  const initialLoading = attentionRows.rows === undefined && loading;
  const canLoadMore = attentionRows.nextCursor !== undefined;
  // Healthy is quiet: the section appears only when an incoming message needs the reader.
  if (!initialLoading && rows.length === 0 && !canLoadMore && attentionRows.resource.error === undefined) {
    return null;
  }

  // One section like the rest of the page: each saved outcome is a row whose
  // tone says how bad it is, with Retry on the row that can still be retried.
  return (
    <Stack testID="channels-ingress-attention-controls" gap="small">
      <ItemGroup
        testID="channels-ingress-attention-section"
        title={props.t('plugins.channels.surface.ingressAttentionTitle', 'Incoming messages need attention')}
        description={props.t(
          'plugins.channels.surface.ingressAttentionDescription',
          'Review saved incoming-message outcomes. Retry is available only for inputs that stopped before Happier could finish admitting them.',
        )}
      >
        {initialLoading ? (
          <Item
            testID="channels-ingress-attention-loading"
            title={props.t('plugins.channels.surface.ingressAttentionLoading', 'Loading blocked inputs')}
            busy
          />
        ) : null}
        {!props.recoveryActionsAvailable && rows.some((row) => row.kind === 'blocked') ? (
          <Item
            testID="channels-ingress-attention-actions-unavailable"
            title={props.t(
              'plugins.channels.surface.ingressAttentionActionsUnavailable',
              'Connect the selected machine to retry these saved inputs.',
            )}
          />
        ) : null}
        {rows.map((row) => {
          const rowId = ingressAttentionRowId(row);
          const busy = row.kind === 'blocked'
            && retryAction.execution.status === 'pending'
            && activeObligationId === row.obligationId;
          const happened = row.kind === 'terminal'
              ? ingressTerminalAttentionLabel(row, props.t)
              : `${props.t(
                'plugins.channels.surface.ingressAttentionAttemptCountPrefix',
                'Retry stopped after',
              )} ${row.attemptCount} ${props.t(
                row.attemptCount === 1
                  ? 'plugins.channels.surface.ingressAttentionAttemptCountSingular'
                  : 'plugins.channels.surface.ingressAttentionAttemptCountPlural',
                row.attemptCount === 1 ? 'attempt' : 'attempts',
              )}`;
          // The same anatomy as the delivery decisions: the row names the conversation, says what
          // happened beneath it, and the time sits in the meta column. Retry appears only where the
          // read recommends it.
          const conversation = ingressAttentionConversationName(row, props.bindings, props.connections, props.t);
          const retryRecommended = row.kind === 'blocked'
            && props.recoveryActionsAvailable
            && ingressRetryRecommended(row.recommendedRecovery);
          return (
            <Item
              key={rowId}
              testID={`channels-ingress-attention-${rowId}`}
              title={conversation}
              subtitle={happened}
              detail={formatEventTime(row.updatedAt, props.t)}
              {...(row.kind === 'blocked' && retryRecommended ? {
                accessoryOutsidePressable: true,
                accessory: (
                  <Button
                    testID={`channels-ingress-attention-retry-${row.obligationId}`}
                    variant="secondary"
                    title={busy
                      ? props.t('plugins.channels.surface.ingressAttentionRetrying', 'Retrying saved input…')
                      : props.t('plugins.channels.surface.ingressAttentionRetry', 'Retry saved input')}
                    accessibilityLabel={`${props.t('plugins.channels.surface.ingressAttentionRetry', 'Retry saved input')} (${conversation})`}
                    busy={busy}
                    disabled={actionUnavailable}
                    onPress={() => retry(row)}
                  />
                ),
              } : {})}
            />
          );
        })}
        {canLoadMore ? (
          <Item
            testID="channels-ingress-attention-load-more"
            title={props.t('plugins.channels.surface.ingressAttentionLoadMore', 'Show more blocked inputs')}
            busy={loading}
            disabled={loading || actionUnavailable}
            onPress={attentionRows.loadMore}
          />
        ) : null}
      </ItemGroup>

      {attentionRows.resource.error !== undefined ? (
        <Banner
          testID="channels-ingress-attention-read-error"
          tone="warning"
          title={props.t('plugins.channels.surface.ingressAttentionReadFailedTitle', 'Could not read blocked inputs')}
          description={props.t(
            'plugins.channels.surface.ingressAttentionReadFailedDescription',
            'Refresh to see the current saved input recovery state.',
          )}
          action={(
            <Action.Refresh
              testID="channels-ingress-attention-read-retry"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={requestAttentionReread}
            />
          )}
        />
      ) : null}

      {retryAction.execution.status === 'error' ? (
        <Banner
          testID="channels-ingress-attention-error"
          tone="warning"
          title={props.t('plugins.channels.surface.ingressAttentionRetryFailedTitle', 'Could not retry the saved input')}
          description={props.t(
            'plugins.channels.surface.ingressAttentionRetryFailedDescription',
            'The blocked input may have changed. Refresh before trying again.',
          )}
          action={(
            <Action.Refresh
              testID="channels-ingress-attention-error-refresh"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={requestAttentionReread}
            />
          )}
        />
      ) : null}

      {actionOutcomeUnknown ? (
        <Banner
          testID="channels-ingress-attention-outcome-unknown"
          tone="warning"
          title={props.t(
            'plugins.channels.surface.ingressAttentionRetryUnknownTitle',
            'Could not confirm the saved input retry',
          )}
          description={props.t(
            'plugins.channels.surface.ingressAttentionRetryUnknownDescription',
            'The retry may already be scheduled. Refresh blocked input details before trying again.',
          )}
          action={(
            <Action.Refresh
              testID="channels-ingress-attention-outcome-unknown-reconcile"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={requestAttentionReread}
            />
          )}
        />
      ) : null}
    </Stack>
  );
}

type DeliveryDecisionState = ConversationOutwardDeliveryResolutionRow['state'];

const DELIVERY_DECISION_ORDER: readonly DeliveryDecisionState[] = ['outcomeUnknown', 'partial', 'archiveRecoverable'];

type DeliveryDecisionGroup = Readonly<{
  /** The conversation's binding, or `undefined` for deliveries the connection sent outside any linked conversation. */
  bindingId: string | undefined;
  title: string;
  rows: readonly ConversationOutwardDeliveryResolutionRow[];
}>;

/**
 * A connection's undecided deliveries, one group per conversation they belong to, named from the
 * binding reads the page already holds. Deliveries the connection sent outside any linked
 * conversation form one connection-level group last. Inside a group the reader takes unknown
 * outcomes, partial sends, then archived destinations, keeping the owner's read order per decision.
 */
function deliveryDecisionGroups(
  rows: readonly ConversationOutwardDeliveryResolutionRow[],
  bindings: readonly ChannelsBinding[],
  t: Translate,
): readonly DeliveryDecisionGroup[] {
  const bindingById = new Map(bindings.map((binding) => [binding.bindingId, binding]));
  const rowsByBinding = new Map<string | undefined, ConversationOutwardDeliveryResolutionRow[]>();
  for (const row of rows) {
    const bucket = rowsByBinding.get(row.bindingId);
    if (bucket === undefined) rowsByBinding.set(row.bindingId, [row]);
    else bucket.push(row);
  }
  const groupTitle = (bindingId: string | undefined): string => {
    if (bindingId === undefined) {
      return t('plugins.channels.surface.deliveryResolutionGroupConnection', 'Outside linked conversations');
    }
    const binding = bindingById.get(bindingId);
    return binding === undefined
      ? t('plugins.channels.surface.deliveryResolutionGroupUnlisted', 'A conversation not listed here')
      : bindingEndpointLabel(binding, t);
  };
  const groups = [...rowsByBinding.entries()].map(([bindingId, groupRows]) => ({
    bindingId,
    title: groupTitle(bindingId),
    rows: DELIVERY_DECISION_ORDER.flatMap((state) => groupRows.filter((row) => row.state === state)),
  }));
  return groups.sort((left, right) => {
    if (left.bindingId === undefined || right.bindingId === undefined) {
      return left.bindingId === right.bindingId ? 0 : left.bindingId === undefined ? 1 : -1;
    }
    return left.title.localeCompare(right.title) || left.bindingId.localeCompare(right.bindingId);
  });
}

/** What a conversation's deliveries need, counted per decision: "2 deliveries with an unknown outcome · 1 delivery partly sent". */
function deliveryDecisionGroupSummary(rows: readonly ConversationOutwardDeliveryResolutionRow[], t: Translate): string {
  return DELIVERY_DECISION_ORDER.flatMap((state) => {
    const count = rows.filter((row) => row.state === state).length;
    return count === 0 ? [] : [deliveryDecisionCountLabel(state, count, t)];
  }).join(' · ');
}

function deliveryDecisionCountLabel(state: DeliveryDecisionState, count: number, t: Translate): string {
  if (state === 'archiveRecoverable') {
    return count === 1
      ? t('plugins.channels.surface.deliveryResolutionGroupArchivedOne', '1 delivery to an archived destination')
      : t('plugins.channels.surface.deliveryResolutionGroupArchived', '{count} deliveries to archived destinations', { count });
  }
  if (state === 'partial') {
    return count === 1
      ? t('plugins.channels.surface.deliveryResolutionGroupPartialOne', '1 delivery partly sent')
      : t('plugins.channels.surface.deliveryResolutionGroupPartial', '{count} deliveries partly sent', { count });
  }
  return count === 1
    ? t('plugins.channels.surface.deliveryResolutionGroupUnknownOne', '1 delivery with an unknown outcome')
    : t('plugins.channels.surface.deliveryResolutionGroupUnknown', '{count} deliveries with an unknown outcome', { count });
}

/** The decision's cause and what each choice does, said where the choice is made. */
function deliveryDecisionExplanation(state: DeliveryDecisionState, t: Translate): string {
  if (state === 'archiveRecoverable') {
    return t(
      'plugins.channels.surface.deliveryResolutionArchivedExplanation',
      'The provider confirmed these were not sent because the destination is archived. Unarchive it, then send again.',
    );
  }
  return state === 'partial'
    ? t(
      'plugins.channels.surface.deliveryResolutionPartialExplanation',
      'Some parts reached the conversation before one failed. Accept keeps what arrived; discard records that the rest won’t be sent. Nothing is sent again either way.',
    )
    : t(
      'plugins.channels.surface.deliveryResolutionUnknownExplanation',
      'Happier lost the answer while sending, so this may have arrived. Accept it if it did, discard it if it didn’t. Nothing is sent again either way.',
    );
}

function deliveryDecisionStateLabel(state: DeliveryDecisionState, t: Translate): string {
  if (state === 'archiveRecoverable') {
    return t('plugins.channels.surface.deliveryResolutionArchived', 'Not sent: the destination is archived');
  }
  return state === 'partial'
    ? t('plugins.channels.surface.deliveryResolutionPartial', 'Partly sent')
    : t('plugins.channels.surface.deliveryResolutionOutcomeUnknown', 'Outcome unknown');
}

/**
 * This present-user surface intentionally offers only the two terminal
 * decisions the custody owner supports. It never reopens or resends the
 * retained delivery from the management client.
 */
function ConnectionDeliveryResolutionControls(props: Readonly<{
  connection: ChannelsConnection;
  /** The page's binding reads, which name each delivery's conversation. */
  bindings: readonly ChannelsBinding[];
  signal: AbortSignal;
  resolveOperation?: DeliveryResolveOperation;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement | null {
  const dataClient = usePluginUiDataClient();
  const collection = React.useMemo(
    () => dataClient.collection(CHANNEL_DELIVERIES_COLLECTION),
    [dataClient],
  );
  const deliveryRows = useDeliveryResolutionRows({
    collection,
    connectionId: props.connection.connectionId,
    signal: props.signal,
  });
  const resolveAction = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryResolve,
  );
  const action = props.resolveOperation ?? resolveAction;
  const [activeCustodyId, setActiveCustodyId] = React.useState<string | undefined>();
  // A started conversation whose send result was lost has no thread identity
  // yet: accepting it needs the thread the person confirmed was created.
  const [createdThreadIds, setCreatedThreadIds] = React.useState<Readonly<Record<string, string>>>({});
  const hasAmbiguousDelivery = props.connection.attention.outwardDelivery.partial
    || props.connection.attention.outwardDelivery.outcomeUnknown
    || props.connection.attention.outwardDelivery.archiveRecovery;
  const actionOutcomeUnknown = action.execution.status === 'outcomeUnknown';
  const actionUnavailable = action.execution.status === 'pending' || actionOutcomeUnknown;

  const resolve = React.useCallback(async (
    row: ConversationOutwardDeliveryResolutionRow,
    resolution: ConversationDeliveryResolutionDecision,
  ) => {
    if (actionUnavailable) return;
    setActiveCustodyId(row.custodyId);
    let outcomeUnknown = false;
    try {
      const createdThreadId = createdThreadIds[row.custodyId]?.trim() ?? '';
      const settled = await action.execute({
        custodyId: row.custodyId,
        expectedRevision: row.revision,
        resolution,
        ...(resolution === 'accepted' && row.createdThreadEndpointRequired !== undefined && createdThreadId !== ''
          ? {
            endpoint: {
              kind: 'thread' as const,
              audience: 'direct' as const,
              id: createdThreadId,
              parentId: row.createdThreadEndpointRequired.parentId,
            },
          }
          : {}),
      });
      outcomeUnknown = settled.status === 'outcomeUnknown';
      if (outcomeUnknown) {
        return;
      }
      if (settled.status !== 'pending') {
        deliveryRows.refresh();
        props.onRefresh();
      }
    } finally {
      if (!outcomeUnknown) setActiveCustodyId(undefined);
    }
  }, [action.execute, actionUnavailable, createdThreadIds, deliveryRows, props.onRefresh]);

  const reconcileDeliveryRows = React.useCallback(() => {
    deliveryRows.refresh();
    props.onRefresh();
  }, [deliveryRows, props.onRefresh]);
  // The canonical unknown-outcome owner owns the reread discipline: the
  // ambiguous decision stays locked until an explicit fresh delivery reread
  // settles idle, fresh, and error-free. A failed or offline reread never
  // reconciles - the uncertainty banner and its typed retry remain.
  const requestDeliveryReread = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown: actionOutcomeUnknown,
    resource: deliveryRows.resource,
    onRefresh: reconcileDeliveryRows,
    onReconciled: React.useCallback(() => {
      setActiveCustodyId(undefined);
      action.reset();
    }, [action.reset]),
  });

  if (!hasAmbiguousDelivery) return null;

  const rows = deliveryRows.rows ?? [];
  const singleDecisionKind = rows.length > 0 && new Set(rows.map((row) => row.state)).size === 1;
  const loading = deliveryRows.resource.pending !== 'idle';
  const initialLoading = deliveryRows.rows === undefined && loading;
  const canLoadMore = deliveryRows.nextCursor !== undefined;
  const unknownOutcomeDescription = props.t(
    'plugins.channels.surface.deliveryResolutionUnknownDescription',
    'The decision may already be saved. Refresh delivery details before making another choice.',
  );
  // The privacy-safe projection carries no content: a delivery's decision is named by when it was
  // queued, which is also what tells two rows' identical buttons apart.
  const deliveryRowName = (row: ConversationOutwardDeliveryResolutionRow): string =>
    props.t('plugins.channels.surface.deliveryResolutionRowName', 'Delivery sent {time}', {
      time: formatEventTime(row.createdAt, props.t),
    });
  return (
    <Stack testID="channels-delivery-resolution-controls" gap="small">
      <Heading
        level={3}
        value={props.t('plugins.channels.surface.deliveryResolutionTitle', 'Resolve delivery outcome')}
      />
      {singleDecisionKind ? null : (
        <Text
          value={props.t(
            'plugins.channels.surface.deliveryResolutionDescription',
            'Review each delivery that may already have had an external effect. Happier will not send it again automatically.',
          )}
        />
      )}

      {initialLoading ? (
        <Status
          testID="channels-delivery-resolution-loading"
          tone="neutral"
          label={props.t('plugins.channels.surface.deliveryResolutionLoading', 'Loading delivery details')}
          pulsing
        />
      ) : null}

      {deliveryRows.resource.error !== undefined ? (
        <Banner
          testID="channels-delivery-resolution-read-error"
          tone="warning"
          title={props.t('plugins.channels.surface.deliveryResolutionReadFailedTitle', 'Could not read delivery details')}
          description={props.t(
            'plugins.channels.surface.deliveryResolutionReadFailedDescription',
            'Refresh to see the current delivery decisions.',
          )}
          action={(
            <Action.Refresh
              testID="channels-delivery-resolution-read-retry"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={requestDeliveryReread}
            />
          )}
        />
      ) : null}

      {/* When every delivery needs the same decision, its count and what each choice does are said
          once here; the rows below then only name where and when each delivery went. */}
      {singleDecisionKind ? (
        <Stack gap="xsmall">
          <Text value={deliveryDecisionGroupSummary(rows, props.t)} />
          <Text tone="secondary" value={deliveryDecisionExplanation(rows[0]!.state, props.t)} />
        </Stack>
      ) : null}
      {(() => {
        // One list: each row names its conversation and when the delivery was sent, conversations in
        // name order with the connection-level deliveries last.
        const groups = deliveryDecisionGroups(rows, props.bindings, props.t);
        const renderRow = (
          row: ConversationOutwardDeliveryResolutionRow,
          index: number,
          conversation: string,
          mixed: boolean,
        ): React.ReactElement => {
          const busy = action.execution.status === 'pending' && activeCustodyId === row.custodyId;
          // The canonical recommendation names the decision and the exact revision it applies to;
          // a delivery without one has no decision to offer.
          const recommendation = row.recommendedRecovery ?? undefined;
          const accepted = row.acceptedPartCount === 0
            ? props.t('plugins.channels.surface.deliveryResolutionAcceptedNone', 'None confirmed')
            : row.acceptedPartCount === 1
              ? props.t('plugins.channels.surface.deliveryResolutionAcceptedOne', '1 part')
              : props.t('plugins.channels.surface.deliveryResolutionAcceptedCount', '{count} parts', { count: row.acceptedPartCount });
          const acceptedFact = `${props.t('plugins.channels.surface.deliveryResolutionAccepted', 'Already accepted')}: ${accepted}`;
          const sentAt = props.t('plugins.channels.surface.deliveryResolutionSentAt', 'Sent {time}', {
            time: formatEventTime(row.createdAt, props.t),
          });
          const facts = [
            sentAt,
            ...(mixed ? [deliveryDecisionStateLabel(row.state, props.t)] : []),
            ...(row.state === 'archiveRecoverable' || row.acceptedPartCount === 0 ? [] : [acceptedFact]),
            ...(row.failedChunk === undefined ? [] : [
              `${props.t('plugins.channels.surface.deliveryResolutionFailedPart', 'Failed part')}: ${props.t(
                'plugins.channels.surface.deliveryResolutionPartNumber', 'Part {number}', { number: row.failedChunk + 1 },
              )}`,
            ]),
          ].join(' · ');
          return (
            <CountedDisclosureItem
              key={row.custodyId}
              testID={`channels-delivery-resolution-${row.custodyId}`}
              title={conversation}
              subtitle={facts}
              showDivider={index > 0}
            >
              <Stack gap="small">
                {singleDecisionKind ? null : (
                  <Text tone="secondary" value={deliveryDecisionExplanation(row.state, props.t)} />
                )}
                {row.state === 'archiveRecoverable' || row.acceptedPartCount > 0 ? null : (
                  <Text tone="secondary" value={acceptedFact} />
                )}
                {recommendation === undefined || row.state === 'archiveRecoverable' ? null : (
                  <Stack gap="small">
                    {row.createdThreadEndpointRequired === undefined ? null : (
                      <Text
                        tone="secondary"
                        value={props.t(
                          'plugins.channels.surface.deliveryResolutionThreadIdDescription',
                          'This started a new conversation. If it arrived, enter the ID of the thread it created so replies reach the session. Without it, only Discard is possible.',
                        )}
                      />
                    )}
                    {row.createdThreadEndpointRequired === undefined ? null : (
                      <Form.TextField
                        testID={`channels-delivery-resolution-thread-${row.custodyId}`}
                        label={props.t('plugins.channels.surface.deliveryResolutionThreadId', 'Started thread ID')}
                        placeholder={props.t('plugins.channels.surface.deliveryResolutionThreadIdPlaceholder', 'For email, the sent message’s Message-ID')}
                        value={createdThreadIds[row.custodyId] ?? ''}
                        autoCapitalize="none"
                        autoCorrect={false}
                        disabled={actionUnavailable}
                        onChange={(value) => setCreatedThreadIds((current) => ({ ...current, [row.custodyId]: value }))}
                      />
                    )}
                    <Row gap="small" wrap>
                      <Button
                        testID={`channels-delivery-resolution-accept-${row.custodyId}`}
                        title={busy
                          ? props.t('plugins.channels.surface.deliveryResolutionAccepting', 'Accepting…')
                          : props.t('plugins.channels.surface.deliveryResolutionAccept', 'Accept as sent')}
                        accessibilityLabel={`${props.t(
                          'plugins.channels.surface.deliveryResolutionAccept',
                          'Accept as sent',
                        )} (${deliveryRowName(row)})`}
                        busy={busy}
                        disabled={actionUnavailable
                          || (row.createdThreadEndpointRequired !== undefined
                            && (createdThreadIds[row.custodyId]?.trim() ?? '') === '')}
                        onPress={() => resolve(row, 'accepted')}
                      />
                      <Button
                        testID={`channels-delivery-resolution-discard-${row.custodyId}`}
                        title={busy
                          ? props.t('plugins.channels.surface.deliveryResolutionDiscarding', 'Discarding…')
                          : props.t('plugins.channels.surface.deliveryResolutionDiscard', 'Discard delivery')}
                        variant="secondary"
                        accessibilityLabel={`${props.t(
                          'plugins.channels.surface.deliveryResolutionDiscard',
                          'Discard delivery',
                        )} (${deliveryRowName(row)})`}
                        busy={busy}
                        disabled={actionUnavailable}
                        onPress={() => resolve(row, 'discarded')}
                      />
                    </Row>
                  </Stack>
                )}
              </Stack>
            </CountedDisclosureItem>
          );
        };
        // Every row sits in the one list, so resolving a sibling never moves an open row elsewhere.
        const ordered = groups.flatMap((group) => group.rows.map((row) => ({ row, title: group.title })));
        return ordered.length === 0 ? null : (
          <ItemGroup testID="channels-delivery-resolution-list">
            {ordered.map(({ row, title }, index) => renderRow(row, index, title, !singleDecisionKind))}
          </ItemGroup>
        );
      })()}

      {!initialLoading && rows.length === 0 && !canLoadMore && deliveryRows.resource.error === undefined ? (
        <Status
          testID="channels-delivery-resolution-empty"
          tone="secondary"
          label={props.t(
            'plugins.channels.surface.deliveryResolutionEmpty',
            'No unresolved delivery decisions are currently available.',
          )}
        />
      ) : null}

      {canLoadMore ? (
        <Button
          testID="channels-delivery-resolution-load-more"
          title={props.t(
            'plugins.channels.surface.deliveryResolutionLoadMore',
            'Show more delivery decisions',
          )}
          variant="secondary"
          busy={loading}
          disabled={loading || actionUnavailable}
          onPress={deliveryRows.loadMore}
        />
      ) : null}

      {action.execution.status === 'error' ? (
        <Banner
          testID="channels-delivery-resolution-error"
          tone="danger"
          title={props.t('plugins.channels.surface.deliveryResolutionFailedTitle', 'Could not record the delivery decision')}
          description={props.t(
            'plugins.channels.surface.deliveryResolutionFailedDescription',
            'Refresh delivery details before trying again.',
          )}
          action={(
            <Action.Refresh
              testID="channels-delivery-resolution-error-refresh"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={requestDeliveryReread}
            />
          )}
        />
      ) : null}

      {actionOutcomeUnknown ? (
        <Banner
          testID="channels-delivery-resolution-outcome-unknown"
          tone="warning"
          title={props.t(
            'plugins.channels.surface.deliveryResolutionUnknownTitle',
            'Could not confirm the delivery decision',
          )}
          description={unknownOutcomeDescription}
          action={(
            <Action.Refresh
              testID="channels-delivery-resolution-outcome-unknown-reconcile"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={requestDeliveryReread}
            />
          )}
        />
      ) : null}
    </Stack>
  );
}

function ProviderSetupButton(props: Readonly<{
  operation: ProviderSetupOperation;
  busy: boolean;
  disabled: boolean;
  onPress: (operation: ProviderSetupOperation) => Promise<void>;
  t: Translate;
}>): React.ReactElement {
  const providerDisplayName = useConversationProviderDisplayName(props.operation.contributor.pluginId)
    ?? props.t('plugins.channels.surface.providerFallback', 'Integration provider');
  const testIdSuffix = `${props.operation.contributor.pluginId}-${props.operation.contributor.contributionId}`;
  // A navigation row: the provider's mark and name open its setup. The
  // accessible name keeps the verb the visible row leaves to the section title.
  return (
    <Item
      testID={`channels-provider-setup-${testIdSuffix}`}
      title={providerDisplayName}
      accessibilityRole="button"
      accessibilityLabel={`${props.t('plugins.channels.surface.providerSetupAction', 'Set up')} ${providerDisplayName}`}
      icon={(
        <BrandMark
          pluginId={props.operation.contributor.pluginId}
          size="small"
          externallyLabelled
          testID={`channels-provider-setup-brand-${testIdSuffix}`}
        />
      )}
      busy={props.busy}
      disabled={props.disabled}
      onPress={() => props.onPress(props.operation)}
    />
  );
}

/**
 * The public Channels intent retains the exact host-issued provider selection
 * carrier, just like prepare. The core resolves the current remediation role
 * and the host reconstructs its selected Connected Account input.
 */
function ProviderSetupRemediationExecution(props: Readonly<{
  selection: SelectedProviderSetupRemediationActionInput;
  signal: AbortSignal;
  onSettled: (settled: PluginActionExecution) => Promise<void>;
}>): React.ReactElement | null {
  const action = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionSetupRemediate);
  const startedRef = React.useRef(false);

  React.useEffect(() => {
    if (startedRef.current || props.signal.aborted) return;
    startedRef.current = true;
    const { result } = props.selection;
    void action.execute({
      providerSelection: result.selection,
      providerRemediationInput: result.input,
      credentialRef: result.connectedAccount.kind === 'selected' ? result.connectedAccount.ref : null,
    }, { signal: props.signal, selectedActionInput: props.selection }).then((settled) => {
      void props.onSettled(settled);
    });
  }, [action.execute, props.onSettled, props.selection, props.signal]);

  return null;
}

function ProviderSetupPicker(props: Readonly<{
  signal: AbortSignal;
  targetPluginId: string;
  resource: ResourcePresentation;
  onRefresh: () => void;
  onConnectionCreated: (connectionId: string) => void;
  t: Translate;
}>): React.ReactElement | null {
  const hostApi = usePluginHostApi();
  const surface = useSurfaceContext();
  const resolveProviderDisplayName = useConversationProviderDisplayNameResolver();
  const prepareAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare);
  const createAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate);
  // The incumbent generic present-user endpoint Action. The surface only
  // relays core-minted facts to it; the core re-proves correspondence itself
  // in the continuation, so no UI-asserted endpoint fact is ever authority.
  const ensureEndpointAction = useExecutePluginAction('plugin.webhook.endpoint.ensure');
  const [selectionPending, setSelectionPending] = React.useState(false);
  const [remediationSelectionPending, setRemediationSelectionPending] = React.useState(false);
  const [activeOperationKey, setActiveOperationKey] = React.useState<string | undefined>();
  const [feedback, setFeedback] = React.useState<ProviderSetupFeedback | undefined>();
  const [preparedConnection, setPreparedConnection] = React.useState<PreparedConnectionSetup | undefined>();
  const [providerSetupDraft, setProviderSetupDraft] = React.useState<ProviderSetupFormDraft | undefined>();
  const [endpointContinuation, setEndpointContinuation] = React.useState<
    ConnectionEndpointContinuation | undefined
  >();
  // Public endpoint facts are retained only for this mounted setup surface.
  // The one-time secret never enters a persisted connection, resource, or
  // history projection and disappears when this setup journey is discarded.
  const [endpointSetupRequired, setEndpointSetupRequired] = React.useState<
    EndpointSetupPresentation | undefined
  >();
  const [endpointEnsurePending, setEndpointEnsurePending] = React.useState(false);
  const [remediationSetupOperation, setRemediationSetupOperation] = React.useState<
    ProviderSetupOperation | undefined
  >();
  const [remediationSelection, setRemediationSelection] = React.useState<
    SelectedProviderSetupRemediationActionInput | undefined
  >();
  const [createValidationIssue, setCreateValidationIssue] = React.useState<string | undefined>();
  const selectionPendingRef = React.useRef(false);
  const remediationSelectionPendingRef = React.useRef(false);
  /**
   * The selected settlement is an in-memory host-issued fact. It is never
   * copied into the persisted prepare/create Action inputs or React state.
   */
  const selectedProviderSetupActionInputRef = React.useRef<SelectedProviderSetupActionInput | undefined>(undefined);
  const selectedProviderSetupLifetimeRef = React.useRef<AbortController | undefined>(undefined);
  const retireSelectedProviderSetup = React.useCallback(() => {
    selectedProviderSetupLifetimeRef.current?.abort();
    selectedProviderSetupLifetimeRef.current = undefined;
    selectedProviderSetupActionInputRef.current = undefined;
  }, []);
  const mountedRef = React.useRef(true);
  const operations = React.useMemo(
    () => currentProviderSetupOperations(surface.targetedContributions, props.targetPluginId),
    [props.targetPluginId, surface.targetedContributions],
  );
  const remediationOperations = React.useMemo(
    () => remediationSetupOperation === undefined
      ? []
      : currentProviderSetupRemediationOperations(
          surface.targetedContributions,
          props.targetPluginId,
          remediationSetupOperation,
        ),
    [props.targetPluginId, remediationSetupOperation, surface.targetedContributions],
  );
  const remediationOperation = remediationOperations.length === 1 ? remediationOperations[0] : undefined;
  const supportsActionInputSelection = hostApi.version().methods.includes('selectActionInput');
  const prepareOutcomeUnknown = prepareAction.execution.status === 'outcomeUnknown';
  const createOutcomeUnknown = createAction.execution.status === 'outcomeUnknown';
  const actionUnavailable = selectionPending
    || remediationSelectionPending
    || remediationSelection !== undefined
    || prepareAction.execution.status === 'pending'
    || prepareOutcomeUnknown
    || createAction.execution.status === 'pending'
    || (createOutcomeUnknown && endpointContinuation === undefined)
    || endpointEnsurePending
    || feedback === 'remediationOutcomeUnknown';

  const onPrepareOutcomeReconciled = React.useCallback(() => {
    prepareAction.reset();
    retireSelectedProviderSetup();
    setPreparedConnection(undefined);
    setCreateValidationIssue(undefined);
    setRemediationSetupOperation(undefined);
    setRemediationSelection(undefined);
    setEndpointContinuation(undefined);
    setEndpointSetupRequired(undefined);
    setFeedback(undefined);
  }, [prepareAction.reset, retireSelectedProviderSetup]);
  const requestPrepareOutcomeReread = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown: prepareOutcomeUnknown,
    resource: props.resource,
    onRefresh: props.onRefresh,
    onReconciled: onPrepareOutcomeReconciled,
  });
  const onCreateOutcomeReconciled = React.useCallback(() => {
    createAction.reset();
    retireSelectedProviderSetup();
    setPreparedConnection(undefined);
    setCreateValidationIssue(undefined);
    setRemediationSetupOperation(undefined);
    setRemediationSelection(undefined);
    setEndpointContinuation(undefined);
    setEndpointSetupRequired(undefined);
    setFeedback(undefined);
  }, [createAction.reset, retireSelectedProviderSetup]);
  const requestCreateOutcomeReread = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown: createOutcomeUnknown,
    resource: props.resource,
    onRefresh: props.onRefresh,
    onReconciled: onCreateOutcomeReconciled,
  });

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      retireSelectedProviderSetup();
    };
  }, [retireSelectedProviderSetup]);

  React.useEffect(() => {
    const clearSelection = () => retireSelectedProviderSetup();
    if (props.signal.aborted) clearSelection();
    else props.signal.addEventListener('abort', clearSelection, { once: true });
    return () => props.signal.removeEventListener('abort', clearSelection);
  }, [props.signal, retireSelectedProviderSetup]);

  React.useEffect(() => {
    const selected = selectedProviderSetupActionInputRef.current;
    if (selected !== undefined && !operations.some((operation) => (
      isSameProviderContributionOperation(operation, selected.operation)
    ))) {
      // A host context/currentness revision withdrew the operation that issued
      // this settlement. Its safe draft can remain, but it cannot be executed.
      retireSelectedProviderSetup();
      setPreparedConnection(undefined);
      setRemediationSetupOperation(undefined);
      setRemediationSelection(undefined);
      setEndpointContinuation(undefined);
      setEndpointSetupRequired(undefined);
      setFeedback('selectionUnavailable');
      return;
    }
    if (remediationSetupOperation !== undefined && !operations.some((operation) => (
      isSameProviderContributionOperation(operation, remediationSetupOperation)
    ))) {
      setRemediationSetupOperation(undefined);
      setRemediationSelection(undefined);
      setPreparedConnection(undefined);
      setEndpointContinuation(undefined);
      setEndpointSetupRequired(undefined);
      setFeedback('selectionUnavailable');
    }
  }, [operations, remediationSetupOperation, retireSelectedProviderSetup]);

  React.useEffect(() => {
    if (remediationSelection === undefined || remediationOperations.some((operation) => (
      isSameProviderContributionOperation(operation, remediationSelection.operation)
    ))) {
      return;
    }
    // The host will also reject a stale selection, but withdrawing it before
    // dispatch makes the UI's currentness contract explicit and avoids a
    // provider-side mutation attempt after a snapshot revision.
    setRemediationSelection(undefined);
    setFeedback('remediationUnavailable');
  }, [remediationOperations, remediationSelection]);

  const prepareSelectedProviderSetup = React.useCallback(async (
    selectedActionInput: SelectedProviderSetupActionInput,
  ) => {
    const { operation, result: selection } = selectedActionInput;
    const operationKey = pluginUiTargetedContributionOperationKey(operation);
    // The host selection is the sole Action authority. It deliberately
    // contributes only its sealed selection, opaque setup input, and selected
    // Connected Account reference to the canonical Channels prepare Action.
    const settled = await prepareAction.execute({
      providerSelection: selection.selection,
      providerSetupInput: selection.input,
      credentialRef: selection.connectedAccount.kind === 'selected'
        ? selection.connectedAccount.ref
        : null,
    }, { signal: props.signal, selectedActionInput });
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status === 'success') {
      const prepared = ConversationConnectionPrepareResultV1Schema.safeParse(settled.result);
      if (!prepared.success) {
        setRemediationSetupOperation(undefined);
        setEndpointContinuation(undefined);
        setEndpointSetupRequired(undefined);
        setFeedback('preparationUnavailable');
      } else if (prepared.data.kind === 'requiresRemediation') {
        setPreparedConnection(undefined);
        setRemediationSelection(undefined);
        setRemediationSetupOperation(operation);
        setEndpointContinuation(undefined);
        setEndpointSetupRequired(undefined);
        setFeedback('requiresRemediation');
      } else {
        const {
          supportedTransports,
          recommendedTransport: selectedTransport,
          destinationLabel,
          overlapSafety,
          replayContinuity,
          outboundTextLimit,
          recommendedMaximumObservationAgeMs,
          setupGuidance,
        } = prepared.data;
        setRemediationSetupOperation(undefined);
        if (selectedTransport === undefined) {
          setFeedback('creationUnavailable');
        } else {
          setPreparedConnection({
            operationKey,
            providerSelection: selection.selection,
            providerSetupInput: selection.input,
            credentialRef: selection.connectedAccount.kind === 'selected'
              ? selection.connectedAccount.ref
              : null,
            supportedTransports,
            selectedTransport,
            maximumObservationAgeMs: String(recommendedMaximumObservationAgeMs ?? DEFAULT_CONVERSATION_OBSERVATION_AGE_MS),
            presentation: {
              providerDisplayName: resolveProviderDisplayName(operation.contributor.pluginId)
                ?? props.t('plugins.channels.surface.providerFallback', 'Integration provider'),
              connectedAccountLabel: selection.presentation.connectedAccountLabel,
              machineDisplayName: selection.presentation.machineDisplayName,
              ...(destinationLabel === undefined ? {} : { destinationLabel }),
              overlapSafety,
              replayContinuity,
              outboundTextLimit,
            },
            ...(setupGuidance === undefined ? {} : { setupGuidance }),
          });
          setFeedback('ready');
        }
      }
    } else if (settled.status === 'outcomeUnknown') {
      setRemediationSetupOperation(undefined);
      setFeedback('preparationOutcomeUnknown');
    } else if (settled.status === 'error') {
      setRemediationSetupOperation(undefined);
      setFeedback('preparationUnavailable');
    }
  }, [prepareAction, props.signal, props.t, resolveProviderDisplayName]);

  const selectProvider = React.useCallback(async (operation: ProviderSetupOperation) => {
    if (props.signal.aborted
      || selectionPendingRef.current
      || remediationSelectionPendingRef.current
      || remediationSelection !== undefined
      || prepareAction.execution.status === 'pending'
      || prepareOutcomeUnknown
      || createAction.execution.status === 'pending'
      || (createAction.execution.status === 'outcomeUnknown' && endpointContinuation === undefined)
      || feedback === 'remediationOutcomeUnknown') {
      return;
    }
    const operationKey = pluginUiTargetedContributionOperationKey(operation);
    const currentProviderSetupDraft = providerSetupDraft;
    const draft = currentProviderSetupDraft !== undefined && currentProviderSetupDraft.operationKey === operationKey
      ? currentProviderSetupDraft.input
      : undefined;
    selectionPendingRef.current = true;
    if (mountedRef.current) {
      retireSelectedProviderSetup();
      setSelectionPending(true);
      setActiveOperationKey(operationKey);
      setFeedback(undefined);
      setPreparedConnection(undefined);
      setCreateValidationIssue(undefined);
      setRemediationSetupOperation(undefined);
      setRemediationSelection(undefined);
      setEndpointContinuation(undefined);
      setEndpointSetupRequired(undefined);
      createAction.reset();
    }
    const selectionLifetime = new AbortController();
    selectedProviderSetupLifetimeRef.current = selectionLifetime;
    try {
      let selection;
      try {
        selection = await hostApi.selectActionInput(
          { operation, ...(draft === undefined ? {} : { draft }) },
          { signal: selectionLifetime.signal },
        );
      } catch {
        if (mountedRef.current && !props.signal.aborted) {
          setFeedback('selectionUnavailable');
        }
        if (selectedProviderSetupLifetimeRef.current === selectionLifetime) {
          retireSelectedProviderSetup();
        }
        return;
      }
      if (selection.kind !== 'submitted' || props.signal.aborted || !mountedRef.current) {
        if (selectedProviderSetupLifetimeRef.current === selectionLifetime) {
          retireSelectedProviderSetup();
        }
        return;
      }

      const selectedActionInput: SelectedProviderSetupActionInput = {
        operation,
        result: selection,
      };
      selectedProviderSetupActionInputRef.current = selectedActionInput;

      // The generic selector excludes secret fields and separates the selected
      // Connected Account from its returned input. Keep that safe draft only
      // for the exact admitted contributor generation that supplied it.
      setProviderSetupDraft({ operationKey, input: selection.input });
      await prepareSelectedProviderSetup(selectedActionInput);
    } finally {
      selectionPendingRef.current = false;
      if (mountedRef.current && !props.signal.aborted) {
        setSelectionPending(false);
        setActiveOperationKey(undefined);
      }
    }
  }, [
    createAction,
    feedback,
    hostApi,
    prepareAction.execution.status,
    prepareOutcomeUnknown,
    prepareSelectedProviderSetup,
    props.signal,
    providerSetupDraft,
    remediationSelection,
    retireSelectedProviderSetup,
  ]);

  const selectProviderRemediation = React.useCallback(async () => {
    if (props.signal.aborted
      || remediationSelectionPendingRef.current
      || remediationSelection !== undefined
      || remediationOperation === undefined
      || actionUnavailable) {
      return;
    }
    remediationSelectionPendingRef.current = true;
    if (mountedRef.current) setRemediationSelectionPending(true);
    try {
      let selection;
      try {
        // This is deliberately a fresh selector invocation: a remediation
        // action owns its own input and Connected Account binding. Reusing the
        // setup Action's opaque input would turn one provider's input shape
        // into another Action's authority.
        selection = await hostApi.selectActionInput(
          { operation: remediationOperation },
          { signal: props.signal },
        );
      } catch {
        if (mountedRef.current && !props.signal.aborted) {
          setFeedback('remediationUnavailable');
        }
        return;
      }
      if (selection.kind !== 'submitted' || props.signal.aborted || !mountedRef.current) return;
      setRemediationSelection({ operation: remediationOperation, result: selection });
    } finally {
      remediationSelectionPendingRef.current = false;
      if (mountedRef.current && !props.signal.aborted) {
        setRemediationSelectionPending(false);
      }
    }
  }, [actionUnavailable, hostApi, props.signal, remediationOperation, remediationSelection]);

  const onProviderRemediationSettled = React.useCallback(async (settled: PluginActionExecution) => {
    if (!mountedRef.current || props.signal.aborted) return;
    setRemediationSelection(undefined);
    if (settled.status === 'outcomeUnknown') {
      setFeedback('remediationOutcomeUnknown');
      return;
    }
    if (settled.status !== 'success') {
      setFeedback('remediationFailed');
      return;
    }
    const result = ConversationProviderSetupRemediationResultV1Schema.safeParse(settled.result);
    if (!result.success) {
      setFeedback('remediationFailed');
      return;
    }
    if (result.data.kind === 'outcomeUnknown') {
      setFeedback('remediationOutcomeUnknown');
      return;
    }
    if (result.data.kind !== 'remediated') {
      setFeedback('remediationFailed');
      return;
    }
    const selectedSetup = selectedProviderSetupActionInputRef.current;
    if (selectedSetup === undefined
      || remediationSetupOperation === undefined
      || !isSameProviderContributionOperation(selectedSetup.operation, remediationSetupOperation)
      || !operations.some((operation) => isSameProviderContributionOperation(operation, selectedSetup.operation))) {
      setFeedback('selectionUnavailable');
      return;
    }
    // A confirmed remediation re-enters the existing prepare owner with the
    // exact original selection carrier. It does not synthesize a connection
    // or repeat the remote mutation itself.
    setFeedback(undefined);
    await prepareSelectedProviderSetup(selectedSetup);
  }, [operations, prepareSelectedProviderSetup, props.signal, remediationSetupOperation]);

  const recheckProviderSetupAfterUnknownRemediation = React.useCallback(async () => {
    if (props.signal.aborted || prepareAction.execution.status === 'pending') return;
    const selectedSetup = selectedProviderSetupActionInputRef.current;
    if (selectedSetup === undefined
      || remediationSetupOperation === undefined
      || !isSameProviderContributionOperation(selectedSetup.operation, remediationSetupOperation)
      || !operations.some((operation) => isSameProviderContributionOperation(operation, selectedSetup.operation))) {
      setFeedback('selectionUnavailable');
      return;
    }
    // This is an explicit safe reread through the canonical prepare Action;
    // it never replays the uncertain provider mutation.
    setFeedback(undefined);
    await prepareSelectedProviderSetup(selectedSetup);
  }, [operations, prepareAction.execution.status, prepareSelectedProviderSetup, props.signal, remediationSetupOperation]);

  const selectTransport = React.useCallback((next: string) => {
    if (next !== 'durablePush') {
      // An endpoint continuation belongs exclusively to durable-push. Keep
      // the setup surface truthful if the person switches transport before
      // completing that provider configuration.
      setEndpointContinuation(undefined);
      setEndpointSetupRequired(undefined);
      setFeedback(undefined);
    }
    setPreparedConnection((current) => {
      if (current === undefined) return current;
      const selectedTransport = current.supportedTransports.find((transport) => transport === next);
      if (selectedTransport === undefined) return current;
      return { ...current, selectedTransport };
    });
  }, []);

  const onObservationAgeChange = React.useCallback((maximumObservationAgeMs: string) => {
    setPreparedConnection((current) => (
      current === undefined ? current : { ...current, maximumObservationAgeMs }
    ));
    setCreateValidationIssue(undefined);
  }, []);

  const createConnection = React.useCallback(async () => {
    if (preparedConnection === undefined
      || props.signal.aborted
      || selectionPendingRef.current
      || prepareAction.execution.status === 'pending'
      || prepareOutcomeUnknown
      || createAction.execution.status === 'pending'
      || (createAction.execution.status === 'outcomeUnknown' && endpointContinuation === undefined)
      || endpointEnsurePending) {
      return;
    }
    const maximumObservationAgeMs = validObservationAge(preparedConnection.maximumObservationAgeMs);
    if (maximumObservationAgeMs === undefined) {
      setCreateValidationIssue(`${props.t(
        'plugins.channels.surface.observationAgeInvalid',
        'Enter a whole number within the allowed observation-age range.',
      )} ${props.t('plugins.channels.surface.observationAgeRange', 'Choose a value from')} ${formatObservationAge(
        MIN_CONVERSATION_OBSERVATION_AGE_MS,
        props.t,
      )} ${props.t('plugins.channels.surface.through', 'through')} ${formatObservationAge(
        MAX_CONVERSATION_OBSERVATION_AGE_MS,
        props.t,
      )}.`);
      return;
    }
    setCreateValidationIssue(undefined);
    const readSettledCreateResult = (
      settled: Extract<PluginActionExecution, Readonly<{ status: 'success' }>>,
    ): Readonly<{ kind: 'created' | 'rejoined'; connectionId: string }>
      | Readonly<{ kind: 'endpointRequired'; result: ConversationConnectionEndpointRequiredResultV1 }>
      | undefined => {
      const created = ConversationConnectionCreateResultV1Schema.safeParse(settled.result);
      if (!created.success) return undefined;
      if (created.data.kind === 'created' || created.data.kind === 'rejoined') {
        return { kind: created.data.kind, connectionId: created.data.connectionId };
      }
      if (created.data.kind === 'endpointRequired') {
        return { kind: 'endpointRequired', result: created.data };
      }
      return undefined;
    };
    const selectedActionInput = selectedProviderSetupActionInputRef.current;
    if (selectedActionInput === undefined
      || pluginUiTargetedContributionOperationKey(selectedActionInput.operation) !== preparedConnection.operationKey) {
      setPreparedConnection(undefined);
      setFeedback('selectionUnavailable');
      return;
    }
    const completeConnectionCreation = (outcome: Readonly<{ kind: 'created' | 'rejoined'; connectionId: string }>) => {
      retireSelectedProviderSetup();
      setEndpointContinuation(undefined);
      setEndpointSetupRequired(undefined);
      setPreparedConnection(undefined);
      setProviderSetupDraft(undefined);
      setFeedback(undefined);
      props.onConnectionCreated(outcome.connectionId);
    };

    // A newly ensured endpoint is not necessarily provider-ready yet. Keep
    // the generic owner’s URL/readiness/one-time credential in this mounted
    // setup surface so the person can configure the provider, then press
    // Create again to recheck the same endpoint and continue the exact
    // preallocated connection attempt. These facts never enter connection
    // persistence, resources, terminal output, or Run history.
    const retainEndpointSetupIfNeeded = (result: PluginActionResultById['plugin.webhook.endpoint.ensure']): boolean => {
      if (result.readiness === 'ready') {
        setEndpointSetupRequired(undefined);
        return false;
      }
      if (result.readiness !== 'providerConfirmationRequired'
        && result.readiness !== 'credentialDisclosureLost') {
        setFeedback('endpointEnsureFailed');
        return true;
      }
      const setupRequired = ConversationConnectionCreateResultV1Schema.safeParse({
        kind: 'webhookEndpointSetupRequired',
        webhookEndpointId: result.webhookEndpointId,
        publicUrl: result.publicUrl,
        readiness: result.readiness,
        ...(result.oneTimeGeneratedSecret === undefined
          ? {}
          : { oneTimeGeneratedSecret: result.oneTimeGeneratedSecret }),
      });
      if (!setupRequired.success || setupRequired.data.kind !== 'webhookEndpointSetupRequired') {
        setFeedback('endpointEnsureFailed');
        return true;
      }
      setEndpointSetupRequired(setupRequired.data);
      setFeedback('endpointSetupRequired');
      // Provider confirmation and credential disclosure are setup attention,
      // not correspondence failure. The generic endpoint owner has already
      // established the durable endpoint identity; continue the bounded
      // connection create/rejoin with that exact endpoint. Delivery readiness
      // remains visible in the setup surface and is owned by the webhook
      // lifecycle, rather than gating Channels persistence.
      return false;
    };

    // A durable-push attempt that already ensured its endpoint continues that
    // exact attempt: the same core-minted ensure key rejoins the same generic
    // endpoint, and the continuation rejoins or creates under the same
    // preallocated connection identity. No second endpoint is ever ensured
    // for one visible attempt.
    if (endpointContinuation !== undefined) {
      let continuedDraft = endpointContinuation;
      if (continuedDraft.webhookEndpointId === undefined || endpointSetupRequired !== undefined) {
        setEndpointEnsurePending(true);
        try {
          if (ensureEndpointAction.execution.status === 'outcomeUnknown') {
            // This retry is licensed by the exact retained idempotency key;
            // reset only the controller presentation, never the attempt.
            ensureEndpointAction.reset();
          }
          const ensured = await ensureEndpointAction.execute(continuedDraft.endpointEnsureInput, {
            signal: props.signal,
          });
          if (!mountedRef.current || props.signal.aborted) return;
          if (ensured.status === 'outcomeUnknown') {
            // Keep every byte of the exact core-minted ensure input. Retrying
            // uses the same generic idempotency key, so the endpoint owner can
            // rejoin the original effect instead of creating a second one.
            setEndpointContinuation(continuedDraft);
            setFeedback('endpointEnsureOutcomeUnknown');
            return;
          }
          if (ensured.status !== 'success') {
            setEndpointContinuation(continuedDraft);
            setFeedback('endpointEnsureFailed');
            return;
          }
          const ensuredDraft: ConnectionEndpointContinuation = {
            ...continuedDraft,
            webhookEndpointId: ensured.result.webhookEndpointId,
          };
          if (retainEndpointSetupIfNeeded(ensured.result)) {
            setEndpointContinuation(ensuredDraft);
            return;
          }
          continuedDraft = ensuredDraft;
          setEndpointContinuation(continuedDraft);
        } finally {
          if (mountedRef.current && !props.signal.aborted) setEndpointEnsurePending(false);
        }
      }
      const webhookEndpointId = continuedDraft.webhookEndpointId;
      if (webhookEndpointId === undefined) return;
      if (createAction.execution.status === 'outcomeUnknown') {
        // The continuation is itself idempotent at the preallocated
        // connection/endpoint pair. Reset the controller outcome before
        // dispatching those exact same bytes again.
        createAction.reset();
      }
      const settled = await createAction.execute({
        providerSelection: preparedConnection.providerSelection,
        providerSetupInput: preparedConnection.providerSetupInput,
        credentialRef: preparedConnection.credentialRef,
        selectedTransport: preparedConnection.selectedTransport,
        maximumObservationAgeMs,
        endpointContinuation: {
          connectionId: continuedDraft.connectionId,
          webhookEndpointId,
        },
      }, { signal: props.signal, selectedActionInput });
      if (!mountedRef.current || props.signal.aborted) return;
      if (settled.status === 'success') {
        const outcome = readSettledCreateResult(settled);
        if (outcome !== undefined && outcome.kind !== 'endpointRequired') {
          completeConnectionCreation(outcome);
          return;
        }
        setFeedback('creationFailed');
        return;
      }
      if (settled.status === 'outcomeUnknown') {
        setFeedback('creationOutcomeUnknown');
        return;
      }
      // A definite continuation failure keeps the exact attempt: retrying
      // continues it instead of ensuring another endpoint.
      setFeedback('creationFailed');
      return;
    }

    const createInput = {
      providerSelection: preparedConnection.providerSelection,
      providerSetupInput: preparedConnection.providerSetupInput,
      credentialRef: preparedConnection.credentialRef,
      selectedTransport: preparedConnection.selectedTransport,
      maximumObservationAgeMs,
    } as const;
    const executionOptions = {
      signal: props.signal,
      selectedActionInput,
      // Durable push may require endpoint setup and an exact same-request
      // continuation. Its selected Connected Account stays purpose-bound to
      // this mounted journey until a definite create/rejoin retires the
      // selection lifetime. Single-call transports keep the incumbent
      // terminal host consumption.
      ...(preparedConnection.selectedTransport === 'durablePush'
        ? {}
        : { consumeSelectedActionInput: true as const }),
    };
    const settled = await createAction.execute(createInput, executionOptions);
    if (preparedConnection.selectedTransport !== 'durablePush') {
      retireSelectedProviderSetup();
    }
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status === 'success') {
      const outcome = readSettledCreateResult(settled);
      if (outcome === undefined) {
        setFeedback('creationFailed');
        return;
      }
      if (outcome.kind !== 'endpointRequired') {
        completeConnectionCreation(outcome);
        return;
      }
      // Durable push: relay the exact core-minted ensure facts through the
      // incumbent generic present-user Action, then continue the same create
      // journey with the returned endpoint identity. The core — not this
      // surface — proves the endpoint correspondence.
      const draft: ConnectionEndpointContinuation = {
        connectionId: outcome.result.connectionId,
        endpointEnsureInput: {
          webhookContribution: { ...outcome.result.webhookContribution },
          targetMaterialization: { ...outcome.result.targetMaterialization },
          sourceInstanceId: outcome.result.sourceInstanceId,
          setup: { ...outcome.result.webhookEndpointSetup },
          idempotencyKey: outcome.result.webhookEndpointIdempotencyKey,
        },
      };
      setEndpointContinuation(draft);
      setCreateValidationIssue(undefined);
      setFeedback(undefined);
      setEndpointEnsurePending(true);
      try {
        const ensured = await ensureEndpointAction.execute(draft.endpointEnsureInput, {
          signal: props.signal,
        });
        if (!mountedRef.current || props.signal.aborted) return;
        if (ensured.status === 'outcomeUnknown') {
          // The endpoint may already exist. Preserve the exact stable ensure
          // input so the next press retries through the generic owner's one
          // idempotency system and rejoins instead of guessing or minting a
          // second endpoint attempt.
          setEndpointContinuation(draft);
          setFeedback('endpointEnsureOutcomeUnknown');
          return;
        }
        if (ensured.status !== 'success') {
          setEndpointContinuation(draft);
          setFeedback('endpointEnsureFailed');
          return;
        }
        const ensuredDraft: ConnectionEndpointContinuation = {
          ...draft,
          webhookEndpointId: ensured.result.webhookEndpointId,
        };
        if (retainEndpointSetupIfNeeded(ensured.result)) {
          setEndpointContinuation(ensuredDraft);
          return;
        }
        const continuedDraft = ensuredDraft;
        const webhookEndpointId = continuedDraft.webhookEndpointId;
        if (webhookEndpointId === undefined) {
          setFeedback('endpointEnsureFailed');
          setEndpointContinuation(continuedDraft);
          return;
        }
        setEndpointContinuation(continuedDraft);
        const continuationSettled = await createAction.execute({
          ...createInput,
          endpointContinuation: {
            connectionId: continuedDraft.connectionId,
            webhookEndpointId,
          },
        }, { signal: props.signal, selectedActionInput });
        if (!mountedRef.current || props.signal.aborted) return;
        if (continuationSettled.status === 'success') {
          const continuationOutcome = readSettledCreateResult(continuationSettled);
          if (continuationOutcome !== undefined && continuationOutcome.kind !== 'endpointRequired') {
            completeConnectionCreation(continuationOutcome);
            return;
          }
          setFeedback('creationFailed');
          return;
        }
        if (continuationSettled.status === 'outcomeUnknown') {
          setFeedback('creationOutcomeUnknown');
          return;
        }
        setFeedback('creationFailed');
        return;
      } finally {
        if (mountedRef.current && !props.signal.aborted) setEndpointEnsurePending(false);
      }
    }
    if (settled.status === 'outcomeUnknown') {
      setFeedback('creationOutcomeUnknown');
      return;
    }
    if (settled.status === 'error') {
      setFeedback('creationFailed');
    }
  }, [
    createAction,
    endpointContinuation,
    endpointSetupRequired,
    endpointEnsurePending,
    ensureEndpointAction,
    prepareAction.execution.status,
    prepareOutcomeUnknown,
    preparedConnection,
    props,
    retireSelectedProviderSetup,
  ]);

  // Zero admitted providers is a reachable Account state, not an error: a fresh
  // Account, a machine with no integration plugin enabled, or a host that
  // cannot present provider setup input all land here. Returning nothing left
  // the person on an empty page with no next step, so the provider-neutral
  // setup owner discloses which of those it is and what to do about it.
  if (!supportsActionInputSelection) {
    return (
      <EmptyState
        testID="channels-provider-setup-host-unsupported"
        title={props.t(
          'plugins.channels.surface.providerSetupHostUnsupportedTitle',
          'Conversation providers cannot be set up here',
        )}
        description={props.t(
          'plugins.channels.surface.providerSetupHostUnsupportedDescription',
          'This app cannot collect provider setup details. Open Conversation Channels from an app version that supports guided setup to add a connection.',
        )}
      />
    );
  }
  if (operations.length === 0) {
    return (
      <EmptyState
        testID="channels-provider-setup-none-available"
        title={props.t(
          'plugins.channels.surface.providerSetupNoneTitle',
          'No conversation providers are available',
        )}
        description={props.t(
          'plugins.channels.surface.providerSetupNoneDescription',
          'Install and enable a conversation integration plugin on your selected machine, then refresh to begin setup.',
        )}
        action={(
          <Action.Refresh
            testID="channels-provider-setup-none-refresh"
            title={props.t('plugins.channels.surface.refresh', 'Refresh')}
            onRefresh={props.onRefresh}
          />
        )}
      />
    );
  }

  return (
    <Stack gap="small" testID="channels-provider-setup-picker">
      <ItemGroup
        title={props.t('plugins.channels.surface.providerSetupTitle', 'Add a conversation provider')}
        description={props.t(
          'plugins.channels.surface.providerSetupDescription',
          'Choose an installed provider to begin setup.',
        )}
      >
        {operations.map((operation) => {
          const operationKey = pluginUiTargetedContributionOperationKey(operation);
          return (
            <ProviderSetupButton
              key={operationKey}
              operation={operation}
              busy={selectionPending && activeOperationKey === operationKey}
              disabled={actionUnavailable}
              onPress={selectProvider}
              t={props.t}
            />
          );
        })}
      </ItemGroup>
      {feedback === 'selectionUnavailable' ? (
        <Banner
          testID="channels-provider-setup-selection-unavailable"
          tone="warning"
          title={props.t('plugins.channels.surface.providerSetupUnavailableTitle', 'Provider setup is unavailable')}
          description={props.t(
            'plugins.channels.surface.providerSetupUnavailableDescription',
            'The available provider selection is no longer current. Refresh this page and try again.',
          )}
        />
      ) : null}
      {feedback === 'preparationUnavailable' ? (
        <Banner
          testID="channels-provider-setup-preparation-unavailable"
          tone="warning"
          title={props.t('plugins.channels.surface.providerPreparationUnavailableTitle', 'Could not prepare the provider')}
          description={prepareAction.execution.status === 'error' ? prepareAction.execution.message : props.t(
            'plugins.channels.surface.providerPreparationUnavailableDescription',
            'The provider did not return a usable setup result. Try again after refreshing this page.',
          )}
        />
      ) : null}
      {feedback === 'requiresRemediation' || feedback === 'remediationFailed' ? (
        <Stack gap="small">
          {/*
            The identity belongs to the element that carries the announcement,
            not to the layout wrapper around it. `Banner` is the one owner of
            this surface's alert semantics, so naming the wrapper instead left
            the remediation disclosure identifiable but not verifiably
            announced — and put this region out of step with every sibling
            banner below, which is named on the Banner itself.
          */}
          <Banner
            testID="channels-provider-setup-remediation"
            tone="warning"
            title={props.t('plugins.channels.surface.providerSetupRemediationTitle', 'Finish provider setup')}
            description={props.t(
              'plugins.channels.surface.providerSetupRemediationDescription',
              'Finish the provider setup before creating a connection.',
            )}
          />
          {feedback === 'remediationFailed' ? (
            <Banner
              testID="channels-provider-setup-remediation-failed"
              tone="warning"
              title={props.t(
                'plugins.channels.surface.providerSetupRemediationFailedTitle',
                'Could not finish provider setup',
              )}
              description={props.t(
                'plugins.channels.surface.providerSetupRemediationFailedDescription',
                'The provider did not confirm the setup change. You can try again after checking its configuration.',
              )}
            />
          ) : null}
          {remediationOperation === undefined ? (
            <Banner
              testID="channels-provider-setup-remediation-unavailable"
              tone="warning"
              title={props.t(
                'plugins.channels.surface.providerSetupRemediationUnavailableTitle',
                'Provider setup needs attention',
              )}
              description={props.t(
                'plugins.channels.surface.providerSetupRemediationUnavailableDescription',
                'This provider has no current setup action for the required change. Refresh and choose the provider again.',
              )}
            />
          ) : (
            <Button
              testID="channels-provider-setup-remediation-action"
              title={props.t('plugins.channels.surface.providerSetupRemediationAction', 'Resolve provider setup')}
              busy={remediationSelectionPending || remediationSelection !== undefined}
              disabled={actionUnavailable}
              onPress={selectProviderRemediation}
            />
          )}
        </Stack>
      ) : null}
      {feedback === 'remediationOutcomeUnknown' ? (
        <Banner
          testID="channels-provider-setup-remediation-outcome-unknown"
          tone="warning"
          title={props.t(
            'plugins.channels.surface.providerSetupRemediationUnknownTitle',
            'Could not confirm provider setup remediation',
          )}
          description={props.t(
            'plugins.channels.surface.providerSetupRemediationUnknownDescription',
            'The provider change may already have completed. Check provider setup again before trying another change.',
          )}
          action={(
            <Action.Refresh
              testID="channels-provider-setup-remediation-outcome-unknown-recheck"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={recheckProviderSetupAfterUnknownRemediation}
            />
          )}
        />
      ) : null}
      {remediationSelection !== undefined ? (
        <ProviderSetupRemediationExecution
          selection={remediationSelection}
          signal={props.signal}
          onSettled={onProviderRemediationSettled}
        />
      ) : null}
      {/* Once the setup is prepared, the review below says it is ready. */}
      {feedback === 'ready' && preparedConnection === undefined ? (
        <Status
          testID="channels-provider-setup-ready"
          tone="secondary"
          label={props.t(
            'plugins.channels.surface.providerSetupReady',
            'Provider setup is ready. Choose a supported transport and create the connection.',
          )}
        />
      ) : null}
      {preparedConnection !== undefined ? (
        <Stack gap="small" testID="channels-provider-setup-connection-form">
          <ConnectionPreparationReview
            presentation={preparedConnection.presentation}
            accountEncryptionMode={surface.accountEncryptionMode}
            testID="channels-provider-setup-review"
            t={props.t}
          />
          {preparedConnection.setupGuidance === undefined ? null : (
            <ProviderSetupGuidanceSteps
              guidance={preparedConnection.setupGuidance}
              providerDisplayName={preparedConnection.presentation.providerDisplayName}
              disabled={actionUnavailable}
              t={props.t}
            />
          )}
          {/* The two choices the person makes, as one settings sheet: a transport that has no
              alternative is stated, not offered as a field. */}
          <ItemGroup testID="channels-provider-setup-choices">
            {preparedConnection.supportedTransports.length > 1 ? (
              <Item
                title={props.t('plugins.channels.surface.transport', 'Transport')}
                subtitle={props.t(
                  'plugins.channels.surface.providerSetupTransportDescription',
                  'Choose how Happier will receive conversation updates from this provider.',
                )}
                fieldAccessory
                accessoryOutsidePressable
                accessory={(
                  <Form.Select
                    testID="channels-provider-setup-transport"
                    presentation="field"
                    label={props.t('plugins.channels.surface.transport', 'Transport')}
                    options={preparedConnection.supportedTransports.map((transport) => ({
                      value: transport,
                      label: transportOutcomeLabel(transport, props.t),
                      testID: `channels-provider-setup-transport-${transport}`,
                    }))}
                    value={preparedConnection.selectedTransport}
                    onChange={(next) => {
                      if (typeof next === 'string') selectTransport(next);
                    }}
                    disabled={actionUnavailable}
                  />
                )}
              />
            ) : (
              <Item
                testID="channels-provider-setup-transport"
                title={props.t('plugins.channels.surface.transport', 'Transport')}
                detail={transportOutcomeLabel(preparedConnection.selectedTransport, props.t)}
              />
            )}
            <Item
              title={props.t('plugins.channels.surface.maximumObservationAge', 'Maximum observation age')}
              subtitle={props.t(
                'plugins.channels.surface.maximumObservationAgeDescription',
                'Accept incoming observations no older than this limit.',
              )}
              fieldAccessory
              accessoryOutsidePressable
              accessory={(
                <Form.Select
                  testID="channels-provider-setup-observation-age"
                  presentation="field"
                  label={props.t('plugins.channels.surface.maximumObservationAge', 'Maximum observation age')}
                  options={durationPresetOptions(
                    OBSERVATION_AGE_PRESETS_MS,
                    preparedConnection.maximumObservationAgeMs,
                    props.t,
                  )}
                  value={preparedConnection.maximumObservationAgeMs}
                  onChange={(next) => {
                    const selected = readActionInputOptionValue(next);
                    if (typeof selected === 'string') onObservationAgeChange(selected);
                  }}
                  disabled={actionUnavailable}
                />
              )}
            />
          </ItemGroup>
          {createValidationIssue === undefined ? null : (
            <Status testID="channels-provider-setup-observation-age-issue" tone="danger" label={createValidationIssue} />
          )}
          <Button
            testID="channels-provider-setup-create"
            title={createAction.execution.status === 'pending'
              ? props.t('plugins.channels.surface.providerCreating', 'Creating connection…')
              : props.t('plugins.channels.surface.providerCreate', 'Create connection')}
            busy={createAction.execution.status === 'pending'}
            disabled={actionUnavailable}
            onPress={createConnection}
          />
        </Stack>
      ) : null}
      {endpointSetupRequired !== undefined ? (
        <WebhookEndpointSetupInstructions
          setup={endpointSetupRequired}
          testIDPrefix="channels-provider-setup"
          description={props.t(
            'plugins.channels.surface.webhookEndpointSetupRequiredDescription',
            'Add this endpoint to your provider, then press Create connection again to verify it.',
          )}
          t={props.t}
        />
      ) : null}
      {feedback === 'creationUnavailable' ? (
        <Banner
          testID="channels-provider-setup-creation-unavailable"
          tone="warning"
          title={props.t('plugins.channels.surface.providerCreationUnavailableTitle', 'No supported connection transport is available')}
          description={props.t(
            'plugins.channels.surface.providerCreationUnavailableDescription',
            'This provider setup cannot create a connection on this server. Refresh the page before trying again.',
          )}
        />
      ) : null}
      {feedback === 'creationFailed' ? (
        <Banner
          testID="channels-provider-setup-creation-failed"
          tone="warning"
          title={props.t('plugins.channels.surface.providerCreationFailedTitle', 'Could not create the connection')}
          description={props.t(
            'plugins.channels.surface.providerCreationFailedDescription',
            'The connection was not saved. Review the setup and try again.',
          )}
        />
      ) : null}
      {feedback === 'endpointEnsureFailed' ? (
        <Banner
          testID="channels-provider-setup-endpoint-ensure-failed"
          tone="warning"
          title={props.t(
            'plugins.channels.surface.providerEndpointEnsureFailedTitle',
            'Could not prepare the webhook endpoint',
          )}
          description={props.t(
            'plugins.channels.surface.providerEndpointEnsureFailedDescription',
            'Durable push needs a webhook endpoint before the connection can be saved. Try creating the connection again.',
          )}
        />
      ) : null}
      {feedback === 'endpointEnsureOutcomeUnknown' ? (
        <Banner
          testID="channels-provider-setup-endpoint-ensure-outcome-unknown"
          tone="warning"
          title={props.t(
            'plugins.channels.surface.providerEndpointEnsureUnknownTitle',
            'Could not confirm the webhook endpoint',
          )}
          description={props.t(
            'plugins.channels.surface.providerEndpointEnsureUnknownDescription',
            'The endpoint may already exist. Retry Create connection to rejoin this exact setup attempt.',
          )}
        />
      ) : null}
      {feedback === 'creationOutcomeUnknown' ? (
        <Banner
          testID="channels-provider-setup-creation-outcome-unknown"
          tone="warning"
          title={props.t('plugins.channels.surface.providerCreationUnknownTitle', 'Could not confirm connection creation')}
          description={endpointContinuation === undefined
            ? props.t(
              'plugins.channels.surface.providerCreationUnknownDescription',
              'A connection may already be saved. Refresh connection details before trying again.',
            )
            : props.t(
              'plugins.channels.surface.providerCreationRetryUnknownDescription',
              'The connection may already be saved. Retry Create connection to rejoin this exact setup attempt.',
            )}
          action={endpointContinuation === undefined ? (
            <Action.Refresh
              testID="channels-provider-setup-creation-outcome-unknown-reconcile"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={requestCreateOutcomeReread}
            />
          ) : undefined}
        />
      ) : null}
      {feedback === 'preparationOutcomeUnknown' ? (
        <Banner
          testID="channels-provider-setup-outcome-unknown"
          tone="warning"
          title={props.t('plugins.channels.surface.providerSetupUnknownTitle', 'Could not confirm provider setup')}
          description={props.t(
            'plugins.channels.surface.providerSetupUnknownDescription',
            'Refresh this page before trying provider setup again.',
          )}
          action={(
            <Action.Refresh
              testID="channels-provider-setup-outcome-unknown-reconcile"
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={requestPrepareOutcomeReread}
            />
          )}
        />
      ) : null}
    </Stack>
  );
}

/**
 * The provider's own setup, as numbered steps. A provider that authored `steps` is shown exactly those,
 * in its order: each with its official link and one copy control per value pasted on the provider's side.
 * A provider without steps keeps the summary: open its page and grant what it asks for. Both end with the
 * connection's existing Test control (`connection/test`).
 */
function ProviderSetupGuidanceSteps(props: Readonly<{
  guidance: NonNullable<PreparedConnectionSetup['setupGuidance']>;
  providerDisplayName: string;
  disabled: boolean;
  t: Translate;
}>): React.ReactElement {
  const { guidance, providerDisplayName, t } = props;
  const openTitle = t('plugins.channels.surface.setupGuidanceOpen', 'Open {provider}', { provider: providerDisplayName });
  const hostOf = (url: string): string | undefined => {
    try {
      return new URL(url).host;
    } catch {
      return undefined;
    }
  };
  const verifyStep = {
    key: 'verify',
    title: t('plugins.channels.surface.setupGuidanceVerify', 'Create and test the connection'),
    detail: t(
      'plugins.channels.surface.setupGuidanceVerifyDetail',
      'Create it below. Then Test connection checks that Happier can reach {provider} with it.',
      { provider: providerDisplayName },
    ),
  };
  const providerSteps = guidance.steps?.map((step, index) => {
    const host = step.externalUrl === undefined ? undefined : hostOf(step.externalUrl);
    const openStepTitle = host === undefined
      ? t('plugins.channels.surface.setupGuidanceOpenStep', 'Open page')
      : t('plugins.channels.surface.setupGuidanceOpenHost', 'Open {host}', { host });
    return {
      key: `provider-${index}`,
      title: step.title,
      ...(step.copyableValues === undefined ? {} : {
        body: (
          <Stack gap="xsmall">
            {step.copyableValues.map((copyable) => (
              <CodeBlock
                key={copyable.label}
                code={copyable.value}
                copyLabel={t('plugins.channels.surface.setupGuidanceCopyValue', 'Copy {label}', { label: copyable.label })}
              />
            ))}
          </Stack>
        ),
      }),
      ...(step.externalUrl === undefined ? {} : {
        action: (
          <Link
            testID={`channels-provider-setup-guidance-link-${index}`}
            title={openStepTitle}
            url={step.externalUrl}
            disabled={props.disabled}
          />
        ),
      }),
    };
  });
  const summaryHost = hostOf(guidance.externalUrl);
  const summarySteps = [
    {
      key: 'open',
      title: openTitle,
      ...(summaryHost === undefined ? {} : { detail: summaryHost }),
      body: (
        <Action.Copy
          title={t('plugins.channels.surface.setupGuidanceCopyLink', 'Copy link')}
          value={guidance.externalUrl}
        />
      ),
      action: (
        <Link
          testID="channels-provider-setup-guidance-link"
          title={openTitle}
          url={guidance.externalUrl}
          disabled={props.disabled}
        />
      ),
    },
    {
      key: 'grant',
      title: t('plugins.channels.surface.setupGuidanceGrant', 'Grant what it asks for'),
      detail: guidance.requiredPermissionsLabel,
      action: (
        <Action.Copy
          title={t('plugins.channels.surface.setupGuidanceCopyPermissions', 'Copy permissions')}
          value={guidance.requiredPermissionsLabel}
        />
      ),
    },
  ];
  return (
    <Stack gap="small" testID="channels-provider-setup-guidance">
      <Heading
        level={4}
        value={t('plugins.channels.surface.providerSetupRemediationTitle', 'Finish provider setup')}
      />
      <SetupSteps steps={[...(providerSteps ?? summarySteps), verifyStep]} />
    </Stack>
  );
}

function ConnectionsContent(props: Readonly<{
  connections: readonly ChannelsConnection[];
  /** The page's linked conversations; delivery decisions are grouped and named by them. */
  bindingPresentations: readonly BindingPresentation[];
  connectionState: 'ready' | 'loading' | 'error';
  signal: AbortSignal;
  targetPluginId?: string;
  resource: ResourcePresentation;
  accountLocalPolicy?: Readonly<{
    collection: ChannelStateCollection;
    deliveriesCollection: ChannelDeliveriesCollection;
    onCommitted: () => void;
  }>;
  expandedConnectionId: string | undefined;
  onExpand: (connectionId: string) => void;
  onConnectionCreated: (connectionId: string) => void;
  /** The connection this surface just created, while its direct next step is pending. */
  createdConnectionId?: string;
  onContinueCreatedConnection?: (connectionId: string) => void;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement {
  const [pendingDeletedConnectionId, setPendingDeletedConnectionId] = React.useState<string | undefined>();
  const [announceDeletedConnection, setAnnounceDeletedConnection] = React.useState(false);
  const bindings = React.useMemo(
    () => props.bindingPresentations.map((presentation) => presentation.binding),
    [props.bindingPresentations],
  );
  const expandedConnection = props.expandedConnectionId === undefined
    ? undefined
    : props.connections.find((connection) => connection.connectionId === props.expandedConnectionId);
  const hasExpandedConnection = expandedConnection !== undefined;
  const onLifecycleSettled = React.useCallback((connectionId: string) => {
    setPendingDeletedConnectionId(connectionId);
    setAnnounceDeletedConnection(false);
  }, []);
  const renderConnectionRow = (connection: ChannelsConnection) => (
    props.accountLocalPolicy === undefined ? (
      <ConnectionRow
        key={connection.connectionId}
        connection={connection}
        bindings={bindings}
        expanded={connection.connectionId === props.expandedConnectionId}
        signal={props.signal}
        resource={props.resource}
        targetPluginId={props.targetPluginId}
        onLifecycleSettled={onLifecycleSettled}
        onExpand={() => props.onExpand(connection.connectionId)}
        onRefresh={props.onRefresh}
        t={props.t}
      />
    ) : (
      <AccountLocalConnectionRow
        key={connection.connectionId}
        collection={props.accountLocalPolicy.collection}
        deliveriesCollection={props.accountLocalPolicy.deliveriesCollection}
        connection={connection}
        bindings={bindings}
        expanded={connection.connectionId === props.expandedConnectionId}
        signal={props.signal}
        resource={props.resource}
        onCommitted={props.accountLocalPolicy.onCommitted}
        onExpand={() => props.onExpand(connection.connectionId)}
        onRefresh={props.onRefresh}
        t={props.t}
      />
    )
  );

  React.useEffect(() => {
    if (pendingDeletedConnectionId === undefined
      || props.resource.pending !== 'idle'
      || props.resource.freshness !== 'fresh'
      || props.resource.error !== undefined
      || props.connections.some((connection) => connection.connectionId === pendingDeletedConnectionId)) {
      return;
    }
    setPendingDeletedConnectionId(undefined);
    setAnnounceDeletedConnection(true);
  }, [pendingDeletedConnectionId, props.connections, props.resource]);

  // The page's identity leads: the Account's connections (or the quiet line
  // saying there are none), with Refresh as the section's one compact action;
  // the providers that add a connection follow as rows.
  return (
    <Stack gap="large">
      <ItemGroup
        testID="channels-connections-section"
        // Connections sit on one sheet like the providers below; the loading,
        // error and empty states keep their own presentation on the page.
        surface={props.connectionState === 'ready' && props.connections.length > 0 ? 'sheet' : 'none'}
        title={props.t('plugins.channels.surface.connections', 'Conversation connections')}
        action={hasExpandedConnection ? undefined : (
          <Action.Refresh
            testID="channels-resource-refresh"
            title={props.t('plugins.channels.surface.refresh', 'Refresh')}
            onRefresh={props.onRefresh}
          />
        )}
      >
        <Stack gap="medium">
          {announceDeletedConnection ? (
            <Status
              testID="channels-connection-deleted-announcement"
              tone="secondary"
              label={props.t('plugins.channels.surface.connectionDeleted', 'Connection deleted.')}
            />
          ) : null}
          {hasExpandedConnection ? null : (
            <ResourceFreshnessNotice resource={props.resource} onRefresh={props.onRefresh} t={props.t} />
          )}
          {props.connectionState === 'loading' ? (
            <LoadingState
              testID="channels-connections-loading"
              title={props.t('plugins.channels.surface.loadingTitle', 'Loading conversation connections')}
              description={props.t(
                'plugins.channels.surface.loadingDescription',
                'Reading the current connection policy from your Account.',
              )}
            />
          ) : props.connectionState === 'error' ? (
            <ErrorState
              testID="channels-connections-error"
              title={props.t('plugins.channels.surface.errorTitle', 'Connection details are unavailable')}
              description={props.t(
                'plugins.channels.surface.errorDescription',
                'Refresh to try reading the current Account connection policy again.',
              )}
              action={(
                <Action.Refresh
                  testID="channels-connections-retry"
                  title={props.t('plugins.channels.surface.tryAgain', 'Try again')}
                  onRefresh={props.onRefresh}
                />
              )}
            />
          ) : props.connections.length === 0 ? (
            <EmptyState
              testID="channels-connections-empty"
              layout="line"
              title={props.t('plugins.channels.surface.emptyTitle', 'No conversation connections yet')}
              description={props.t(
                'plugins.channels.surface.emptyDescription',
                'Connections created for this Account will appear here.',
              )}
            />
          ) : (
            <List
              accessibilityLabel={props.t('plugins.channels.surface.connections', 'Conversation connections')}
              testID="channels-connections-list"
            >
              {props.connections.map(renderConnectionRow)}
            </List>
          )}
        </Stack>
      </ItemGroup>

      {/*
        First setup must not dead-end after the connection exists. The two
        domain Actions stay separate; this composes their UI journeys with one
        direct next step that opens the incumbent binding-create journey with
        the just-created connection selected.
      */}
      {props.createdConnectionId === undefined || props.onContinueCreatedConnection === undefined ? null : (
        <Stack gap="small" testID="channels-connection-created-continue">
          <Status
            testID="channels-connection-created-continue-status"
            tone="secondary"
            label={props.t(
              'plugins.channels.surface.connectionCreatedAwaitingBinding',
              'Connection created. Add the conversation it should deliver to.',
            )}
          />
          <Button
            testID="channels-connection-created-continue-open"
            title={props.t('plugins.channels.surface.bindingCreateAction', 'Link a conversation')}
            onPress={() => {
              if (props.createdConnectionId !== undefined) {
                props.onContinueCreatedConnection?.(props.createdConnectionId);
              }
            }}
          />
        </Stack>
      )}

      {props.targetPluginId === undefined ? null : (
        <ProviderSetupPicker
          signal={props.signal}
          targetPluginId={props.targetPluginId}
          resource={props.resource}
          onRefresh={props.onRefresh}
          onConnectionCreated={props.onConnectionCreated}
          t={props.t}
        />
      )}
    </Stack>
  );
}

/**
 * The daemon-served reading both Channels destinations share: the two live
 * Account Resources, parsed once, with each section's own availability.
 */
const EMPTY_CHANNELS_BINDINGS: readonly ChannelsBinding[] = Object.freeze([]);

function useDaemonChannelsResources(t: Translate) {
  const { resource: bindingsResource, refresh: refreshBindings } = useLivePluginResource(CHANNELS_BINDINGS_RESOURCE);
  const { resource, refresh } = useLivePluginResource(CHANNELS_CONNECTIONS_RESOURCE);
  const parsedBindings = React.useMemo(
    () => (bindingsResource.value === undefined ? undefined : parseBindingsResource(bindingsResource.value)),
    [bindingsResource.value],
  );
  const parsedConnections = React.useMemo(
    () => (resource.value === undefined ? undefined : parseConnectionsResource(resource.value)),
    [resource.value],
  );
  const connections = React.useMemo(
    () => sortConnectionsForDisplay(parsedConnections?.kind === 'ready' ? parsedConnections.connections : [], t),
    [parsedConnections, t],
  );
  const bindings = parsedBindings?.kind === 'ready' ? parsedBindings.bindings : EMPTY_CHANNELS_BINDINGS;
  const presentations = React.useMemo(
    () => buildBindingPresentations(bindings, connections, t),
    [bindings, connections, t],
  );
  const connectionsResource = React.useMemo<ResourcePresentation>(() => ({
    pending: resource.pending,
    freshness: resource.freshness,
    subscription: resource.subscription,
    ...(resource.error === undefined ? {} : { error: resource.error }),
  }), [resource.error, resource.freshness, resource.pending, resource.subscription]);
  const bindingsResourcePresentation = React.useMemo<ResourcePresentation>(() => ({
    pending: bindingsResource.pending,
    freshness: bindingsResource.freshness,
    subscription: bindingsResource.subscription,
    ...(bindingsResource.error === undefined ? {} : { error: bindingsResource.error }),
  }), [bindingsResource.error, bindingsResource.freshness, bindingsResource.pending, bindingsResource.subscription]);
  const connectionState: 'loading' | 'error' | 'ready' = resource.value === undefined || parsedConnections?.kind === 'invalid'
    ? resource.pending === 'initial' ? 'loading' : 'error'
    : 'ready';
  // Each section owns its own availability. A binding Resource failure leaves
  // connection management, provider setup, and ingress recovery reachable.
  const bindingsSectionState: BindingsSectionState = parsedBindings?.kind === 'invalid'
    ? { kind: 'error', description: parseResourceErrorMessage(parsedBindings.reason, t, 'binding') }
    : bindingsResource.value !== undefined
      ? BINDINGS_SECTION_READY
      : bindingsResource.pending === 'initial'
        ? { kind: 'loading' }
        : {
          kind: 'error',
          description: t(
            'plugins.channels.surface.bindingsErrorDescription',
            'Refresh to try reading the current Account binding policy again.',
          ),
        };
  return {
    connections,
    bindings,
    presentations,
    connectionsResource,
    bindingsResource: bindingsResourcePresentation,
    connectionState,
    bindingsSectionState,
    refreshBindings,
    refreshConnections: refresh,
  };
}

/**
 * Settings → Conversation Channels → Connections: the Account's bots. It keeps
 * connecting and managing a bot, connection-level recovery, and linking a
 * conversation (with its pairing step). Each linked conversation is managed on
 * the Channels page, which a finished link opens.
 */
function DaemonChannelsSurface(props: Readonly<{
  signal: AbortSignal;
  targetPluginId: string;
}>): React.ReactElement {
  const t = usePluginTranslation();
  const theme = usePluginTheme();
  const hostApi = usePluginHostApi();
  const channels = useDaemonChannelsResources(t);
  const refresh = channels.refreshConnections;
  const [expandedConnectionId, setExpandedConnectionId] = React.useState<string | undefined>();
  const [pendingBindingConnectionId, setPendingBindingConnectionId] = React.useState<string | undefined>();
  const [bindingCreateRequest, setBindingCreateRequest] = React.useState<
    Readonly<{ connectionId: string; requestId: number }> | undefined
  >();
  const onConnectionCreated = React.useCallback((connectionId: string) => {
    setExpandedConnectionId(connectionId);
    setPendingBindingConnectionId(connectionId);
    refresh();
  }, [refresh]);
  // The connection and binding Actions stay separate domain mutations; this
  // only composes their existing UI journeys: one direct next step that opens
  // the incumbent binding-create journey with the new connection selected.
  const onContinueCreatedConnection = React.useCallback((connectionId: string) => {
    setBindingCreateRequest((current) => ({
      connectionId,
      requestId: (current?.requestId ?? 0) + 1,
    }));
  }, []);
  const onBindingCreateOpened = React.useCallback(() => {
    setBindingCreateRequest(undefined);
    setPendingBindingConnectionId(undefined);
  }, []);
  const openConversation = React.useCallback((subPath: string) => {
    void hostApi.openSurface(CHANNELS_PAGE_VIEW_ID, undefined, { subPath }).catch(() => undefined);
  }, [hostApi]);
  // A finished pairing continues into review on the conversation's page, the
  // one owner of reviewing and turning on a saved binding.
  const onPairingCompleted = React.useCallback((bindingId: string) => {
    openConversation(`${bindingId}/edit`);
  }, [openConversation]);
  // A router's threads are part of its one linked conversation, not more of them.
  const bindingCount = channels.presentations.filter((presentation) => presentation.binding.parentBindingId === undefined).length;

  return (
    <Screen testID="channels-surface" safeArea>
      <ScrollArea contentContainerStyle={{ padding: theme.spacing.large, paddingBottom: theme.spacing.large * 2 }}>
        <Stack gap="large" testID="channels-settings-content">
          <Stack gap="small">
            <Heading level={1} value={t('plugins.channels.surface.title', 'Conversation Channels')} />
            <Text
              value={t(
                'plugins.channels.settings.description',
                'Each connection is one bot, used by every conversation linked through it. Linked conversations are managed in Channels.',
              )}
            />
          </Stack>
          <ConnectionsContent
            connections={channels.connections}
            bindingPresentations={channels.presentations}
            connectionState={channels.connectionState}
            signal={props.signal}
            targetPluginId={props.targetPluginId}
            resource={channels.connectionsResource}
            expandedConnectionId={expandedConnectionId}
            onExpand={(connectionId) => {
              setExpandedConnectionId((current) => current === connectionId ? undefined : connectionId);
            }}
            onConnectionCreated={onConnectionCreated}
            createdConnectionId={pendingBindingConnectionId}
            onContinueCreatedConnection={onContinueCreatedConnection}
            onRefresh={refresh}
            t={t}
          />
          <ItemGroup
            testID="channels-settings-conversations"
            surface="none"
            title={t('plugins.channels.settings.conversations', 'Linked conversations')}
            // Never claim "none" before the linked conversations are read.
            description={channels.bindingsSectionState.kind === 'loading'
              ? t('plugins.channels.settings.conversationsLoading', 'Reading your linked conversations…')
              : channels.bindingsSectionState.kind === 'error'
              ? channels.bindingsSectionState.description
              : bindingCount === 0
              ? t('plugins.channels.settings.conversationsNone', 'No conversation is linked yet.')
              : bindingCount === 1
              ? t('plugins.channels.settings.conversationsCountOne', '1 linked conversation. Pause, edit or unlink it in Channels.')
              : t('plugins.channels.settings.conversationsCount', '{count} linked conversations. Pause, edit or unlink them in Channels.', { count: bindingCount })}
            action={(
              <Button
                testID="channels-settings-open-channels"
                variant="secondary"
                title={t('plugins.channels.settings.openChannels', 'Open Channels')}
                onPress={() => openConversation('')}
              />
            )}
          >
            {channels.bindingsSectionState.kind === 'ready' ? (
              <BindingCreateJourney
                connections={channels.connections}
                resource={channels.bindingsResource}
                signal={props.signal}
                onRefresh={channels.refreshBindings}
                onPairingCompleted={onPairingCompleted}
                onOpenCreated={openConversation}
                openRequest={bindingCreateRequest}
                onOpenConsumed={onBindingCreateOpened}
                t={t}
              />
            ) : null}
          </ItemGroup>
          <IngressAttentionControls
            signal={props.signal}
            recoveryActionsAvailable
            bindings={channels.bindingsSectionState.kind === 'ready' ? channels.bindings : undefined}
            connections={channels.connections}
            t={t}
          />
        </Stack>
      </ScrollArea>
    </Screen>
  );
}

/** The Channels page served by the daemon: every conversation, and its editing. */
function DaemonChannelsPageSurface(props: Readonly<{
  signal: AbortSignal;
  subPath: string | undefined;
}>): React.ReactElement {
  const t = usePluginTranslation();
  const channels = useDaemonChannelsResources(t);
  const refreshBindings = channels.refreshBindings;
  const refreshConnections = channels.refreshConnections;
  const refreshPage = React.useCallback(() => {
    refreshBindings();
    refreshConnections();
  }, [refreshBindings, refreshConnections]);
  const location = React.useMemo(() => readChannelsPageLocation(props.subPath), [props.subPath]);
  return (
    <OnlineBindingsContent
      presentations={channels.presentations}
      resource={channels.bindingsResource}
      sectionState={channels.bindingsSectionState}
      onRefresh={refreshPage}
      location={location}
      connections={channels.connections}
      connectionsState={channels.connectionState}
      connectionsResource={channels.connectionsResource}
      onRefreshConnections={channels.refreshConnections}
      signal={props.signal}
      t={t}
    />
  );
}

function sessionBindingAttentionTitle(
  reason: ConversationSessionBindingAttentionReasonV1,
  t: Translate,
): string {
  switch (reason) {
    case 'connectionUnavailable':
      return t(
        'plugins.channels.session.attentionConnectionUnavailable',
        'This conversation has no current integration connection',
      );
    case 'providerCredentialInvalid':
      return t(
        'plugins.channels.surface.providerCredentialInvalid',
        'Connected Account credential needs attention',
      );
    case 'providerPermissionMissing':
      return t(
        'plugins.channels.surface.providerPermissionMissing',
        'Provider permission needs attention',
      );
    case 'providerConfigurationInvalid':
      return t(
        'plugins.channels.surface.providerConfigurationInvalid',
        'Provider configuration needs attention',
      );
    case 'connectionDeleting':
      return t(
        'plugins.channels.session.attentionConnectionDeleting',
        'This conversation’s connection is being deleted',
      );
    case 'connectionDisabled':
      return t(
        'plugins.channels.session.attentionConnectionDisabled',
        'This conversation’s connection is turned off',
      );
    case 'bindingDisabled':
      return t(
        'plugins.channels.session.attentionBindingDisabled',
        'This conversation is paused',
      );
    case 'transcriptHistoryGap':
      return t(
        'plugins.channels.session.attentionTranscriptHistoryGap',
        'This conversation needs a new transcript baseline',
      );
  }
}

/**
 * The session tab's ways into the Channels page, the one owner of the link journey and of everything a
 * conversation can be set to: this conversation (`subPath: bindingId`), or the link journey, optionally on
 * one bot (`link/<connectionId>`).
 */
function useOpenChannelsPage(): Readonly<{
  open: (subPath: string) => Promise<boolean>;
}> {
  const hostApi = usePluginHostApi();
  return React.useMemo(() => ({
    open: async (subPath: string) => {
      try {
        await hostApi.openSurface({
          pluginId: CONVERSATION_CORE_PLUGIN_ID_V1,
          localId: CHANNELS_PAGE_VIEW_ID,
        }, undefined, { subPath });
        return true;
      } catch {
        return false;
      }
    },
  }), [hostApi]);
}

/**
 * The Session tab's exit to this conversation on the Channels page, where its policy is edited.
 * Pause, Resume and Unlink are the page's own actions and sit beside it in the open row.
 */
function OpenInChannelsAction(props: Readonly<{
  bindingId: string;
  variant?: 'secondary' | 'plain';
  testID?: string;
  t: Translate;
}>): React.ReactElement {
  const page = useOpenChannelsPage();
  const [unavailable, setUnavailable] = React.useState(false);
  const open = React.useCallback(() => {
    setUnavailable(false);
    void page.open(props.bindingId).then((opened) => { if (!opened) setUnavailable(true); });
  }, [page, props.bindingId]);
  return (
    <Stack gap="small">
      <Button
        testID={props.testID ?? `channels-session-conversation-open:${props.bindingId}`}
        variant={props.variant ?? 'plain'}
        title={props.t('plugins.channels.session.openInChannels', 'Open in Channels')}
        onPress={open}
      />
      {unavailable ? (
        <Status
          testID={`channels-session-conversation-open-unavailable:${props.bindingId}`}
          tone="warning"
          label={props.t(
            'plugins.channels.session.openInChannelsUnavailable',
            'Channels could not be opened here. Open Channels from the sidebar to review this conversation.',
          )}
        />
      ) : null}
    </Stack>
  );
}

function SessionProjectionNoticeDismissAction(props: Readonly<{
  attention: ConversationSessionBindingAttentionV1;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement {
  const action = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.sessionProjectionNoticeDismiss,
  );
  const busy = action.execution.status === 'pending';
  const accept = React.useCallback(async () => {
    if (props.attention.reason !== 'transcriptHistoryGap'
      || props.attention.bindingRevision === undefined
      || props.attention.frontierRevision === undefined
      || busy) return;
    const settled = await action.execute({
      bindingId: props.attention.bindingId,
      expectedBindingRevision: props.attention.bindingRevision,
      expectedFrontierRevision: props.attention.frontierRevision,
    });
    if (settled.status === 'success') props.onRefresh();
  }, [action, busy, props]);
  return (
    <Stack gap="small">
      <Button
        testID={`channels-session-transcript-notice-dismiss:${props.attention.bindingId}`}
        variant="secondary"
        title={busy
          ? props.t('plugins.channels.surface.historyGapBaselineAccepting', 'Dismissing notice…')
          : props.t('plugins.channels.surface.historyGapBaselineAccept', 'Dismiss notice')}
        accessibilityLabel={props.t(
          'plugins.channels.surface.historyGapBaselineAccept',
          'Dismiss notice',
        )}
        busy={busy}
        disabled={busy || action.execution.status === 'outcomeUnknown'}
        onPress={() => { void accept(); }}
      />
      {action.execution.status === 'error' || action.execution.status === 'outcomeUnknown' ? (
        <Status
          tone="warning"
          label={props.t(
            'plugins.channels.surface.historyGapBaselineUnknownTitle',
            'Could not confirm notice dismissal',
          )}
          action={<Action.Refresh title={props.t('plugins.channels.surface.refresh', 'Refresh')} onRefresh={props.onRefresh} />}
        />
      ) : null}
    </Stack>
  );
}

/*
 * The Session tab (plugin tabs round 2, lab `plugin-tabs` X1 / XP / XL / XE / ST).
 *
 * The conversations bound to THIS Session, grouped by what they are doing — Needs you, Live, Paused, the
 * Agents roster's grammar — so the state is said once per group and the rows carry identity only: the
 * provider's mark, the conversation, and "Provider · bot". Only a needs-you row speaks: its cause and its
 * one recovery. Pressing a row opens it in place with what it hears and gets, and the page's own actions
 * (Pause / Resume, Open in Channels, Unlink): the same writers the Channels page calls with the same
 * revision, so there is no second mutation path. The header "+" opens Channels' link journey on a bot.
 */

type SessionConversationGroup = 'need' | 'live' | 'paused';

type SessionConversationRowModel = Readonly<{
  presentation: BindingPresentation;
  attention?: ConversationSessionBindingAttentionV1;
  lastDelivery?: ConversationSessionLastDeliveryV1;
  group: SessionConversationGroup;
}>;

/** A deliberately paused binding is Paused, never Needs you; every other attention reason needs the person. */
function sessionConversationGroup(
  binding: ChannelsBinding,
  attention: ConversationSessionBindingAttentionV1 | undefined,
): SessionConversationGroup {
  if (attention !== undefined && attention.reason !== 'bindingDisabled') return 'need';
  return binding.enabled && attention?.reason !== 'bindingDisabled' ? 'live' : 'paused';
}

function buildSessionConversationSections(
  presentations: readonly BindingPresentation[],
  attentionByBindingId: ReadonlyMap<string, ConversationSessionBindingAttentionV1>,
  lastDeliveries: ReadonlyMap<string, ConversationSessionLastDeliveryV1>,
  t: Translate,
): readonly ListSectionData<SessionConversationRowModel>[] {
  const groups: Record<SessionConversationGroup, SessionConversationRowModel[]> = { need: [], live: [], paused: [] };
  for (const presentation of presentations) {
    const attention = attentionByBindingId.get(presentation.binding.bindingId);
    const lastDelivery = lastDeliveries.get(presentation.binding.bindingId);
    const group = sessionConversationGroup(presentation.binding, attention);
    groups[group].push({
      presentation,
      group,
      ...(attention === undefined ? {} : { attention }),
      ...(lastDelivery === undefined ? {} : { lastDelivery }),
    });
  }
  const titles: Record<SessionConversationGroup, string> = {
    need: t('plugins.channels.session.groupNeedsYou', 'Needs you'),
    live: t('plugins.channels.session.groupLive', 'Live'),
    paused: t('plugins.channels.session.groupPaused', 'Paused'),
  };
  return (['need', 'live', 'paused'] as const)
    .filter((group) => groups[group].length > 0)
    .map((group) => ({ key: group, title: titles[group], count: groups[group].length, data: groups[group] }));
}

function sessionConversationRowKey(row: SessionConversationRowModel): string {
  return row.presentation.binding.bindingId;
}

/** Pause / Resume and Unlink: the Channels page's own writers, at the revision the tab already holds. */
function SessionConversationActions(props: Readonly<{
  row: SessionConversationRowModel;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement {
  const { t } = props;
  const { binding } = props.row.presentation;
  const title = bindingEndpointLabel(binding, t);
  const setEnabled = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled);
  const remove = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingDelete);
  const paused = props.row.group === 'paused';
  const toggle = React.useCallback(async () => {
    const settled = await setEnabled.execute({
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
      enabled: paused,
    });
    if (settled.status === 'success') props.onRefresh();
  }, [binding.bindingId, binding.revision, paused, props, setEnabled]);
  const unlink = React.useCallback(async () => {
    const settled = await remove.execute({ bindingId: binding.bindingId, expectedRevision: binding.revision });
    if (settled.status === 'success') props.onRefresh();
  }, [binding.bindingId, binding.revision, props, remove]);
  const failed = setEnabled.execution.status === 'error' || setEnabled.execution.status === 'outcomeUnknown'
    || remove.execution.status === 'error' || remove.execution.status === 'outcomeUnknown';

  return (
    <Stack gap="small">
      <Row gap="small" align="center">
        <Button
          testID={`channels-session-conversation-${paused ? 'resume' : 'pause'}:${binding.bindingId}`}
          variant={paused ? 'primary' : 'secondary'}
          title={paused
            ? t('plugins.channels.session.resume', 'Resume')
            : t('plugins.channels.session.pause', 'Pause')}
          busy={setEnabled.execution.status === 'pending'}
          onPress={() => toggle()}
        />
        <OpenInChannelsAction
          bindingId={binding.bindingId}
          testID={`channels-session-conversation-peek-open:${binding.bindingId}`}
          t={t}
        />
        <Stack style={{ flex: 1 }} />
        <Button
          testID={`channels-session-conversation-unlink:${binding.bindingId}`}
          variant="plain"
          title={t('plugins.channels.session.unlink', 'Unlink')}
          accessibilityLabel={t('plugins.channels.session.unlinkNamed', 'Unlink {name}', { name: title })}
          busy={remove.execution.status === 'pending'}
          onPress={() => { void unlink(); }}
        />
      </Row>
      {failed ? (
        <Status
          tone="warning"
          label={t(
            'plugins.channels.session.actionFailed',
            'That didn’t go through. Refresh and try again, or change it in Channels.',
          )}
          action={<Action.Refresh title={t('plugins.channels.surface.refresh', 'Refresh')} onRefresh={props.onRefresh} />}
        />
      ) : null}
    </Stack>
  );
}

/** What the conversation is to this session, in words: calm label/value pairs, then its actions. */
function SessionConversationPeek(props: Readonly<{
  row: SessionConversationRowModel;
  offline: boolean;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement {
  const { t } = props;
  const { binding, connection } = props.row.presentation;
  const { locale } = useSurfaceContext();
  const approvals = bindingApprovalSummary(binding, t);
  const lastDelivery = props.row.lastDelivery;
  const entries = [
    { label: t('plugins.channels.session.hears', 'Hears'), value: bindingInputModeLabel(binding.inputMode, t) },
    { label: t('plugins.channels.session.gets', 'Gets'), value: bindingDeliveryModeLabel(binding.deliveryMode, t) },
    ...(approvals === undefined ? [] : [{ label: t('plugins.channels.session.approvals', 'Approvals'), value: approvals }]),
    ...(connection === undefined ? [] : [{
      label: t('plugins.channels.session.bot', 'Bot'),
      value: `${connectionLabel(connection)} · ${connectionStatus(connection, t).label}`,
      ...(channelsStatusNeedsYou(connectionStatus(connection, t).tone) ? { tone: connectionStatus(connection, t).tone } : {}),
    }]),
    ...(lastDelivery === undefined ? [] : [{
      label: t('plugins.channels.session.lastReply', 'Last reply'),
      value: lastDelivery.outcome === 'notDelivered'
        ? t('plugins.channels.session.lastReplyNotDelivered', 'Not delivered · {time}', { time: formatConversationTime(lastDelivery.atMs, locale) })
        : lastDelivery.outcome === 'pending'
          ? t('plugins.channels.session.lastReplySending', 'Sending · {time}', { time: formatConversationTime(lastDelivery.atMs, locale) })
          : formatConversationTime(lastDelivery.atMs, locale),
      ...(lastDelivery.outcome === 'notDelivered' ? { tone: 'warning' as const } : {}),
    }]),
  ];
  return (
    <Stack gap="medium" testID={`channels-session-conversation-peek:${binding.bindingId}`}>
      <Metadata entries={entries} />
      {props.offline ? (
        <OpenInChannelsAction bindingId={binding.bindingId} variant="secondary" testID={`channels-session-conversation-peek-open:${binding.bindingId}`} t={t} />
      ) : (
        <SessionConversationActions row={props.row} onRefresh={props.onRefresh} t={t} />
      )}
    </Stack>
  );
}

function SessionConversationRow(props: Readonly<{
  row: SessionConversationRowModel;
  expanded: boolean;
  offline: boolean;
  onToggle: (bindingId: string) => void;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement {
  const { t, row } = props;
  const { binding, connection } = row.presentation;
  const resolveProviderDisplayName = useConversationProviderDisplayNameResolver();
  const title = bindingEndpointLabel(binding, t);
  const subtitle = connection === undefined
    ? bindingAudienceLabel(binding.endpoint.audience, t)
    : `${resolveProviderDisplayName(connection.providerPluginId) ?? t('plugins.channels.surface.providerFallback', 'Integration provider')} · ${connectionLabel(connection)}`;
  const attention = row.group === 'need' ? row.attention : undefined;
  const { locale } = useSurfaceContext();
  // The trailing time is the latest reply sent (lab XA); a paused conversation shows none.
  const lastReply = row.group === 'paused' || row.lastDelivery === undefined
    ? undefined
    : formatConversationTime(row.lastDelivery.atMs, locale);
  return (
    <List.Item
      testID={`channels-session-conversation:${binding.bindingId}`}
      {...(lastReply === undefined ? {} : { detail: lastReply })}
      title={title}
      titleNumberOfLines={1}
      subtitle={subtitle}
      subtitleNumberOfLines={1}
      accessibilityLabel={title}
      accessibilityHint={attention === undefined ? subtitle : `${subtitle}. ${sessionBindingAttentionTitle(attention.reason, t)}`}
      icon={connection === undefined
        ? <Icon name="conversations" size="small" tone="secondary" />
        : <BrandMark pluginId={connection.providerPluginId} size="small" externallyLabelled />}
      onPress={() => { props.onToggle(binding.bindingId); }}
      expanded={props.expanded}
      expandedContent={<SessionConversationPeek row={row} offline={props.offline} onRefresh={props.onRefresh} t={t} />}
    >
      {attention === undefined ? null : (
        <Stack gap="small" testID={`channels-session-conversation-attention:${binding.bindingId}`}>
          <Row gap="xsmall" align="center">
            <Icon name="warning" size="small" tone="warning" />
            <Text variant="micro" tone="warning" value={sessionBindingAttentionTitle(attention.reason, t)} />
          </Row>
          {attention.reason === 'transcriptHistoryGap'
            ? <SessionProjectionNoticeDismissAction attention={attention} onRefresh={props.onRefresh} t={t} />
            : <OpenInChannelsAction bindingId={binding.bindingId} variant="secondary" t={t} />}
        </Stack>
      )}
    </List.Item>
  );
}

/** The header "+": Channels' own link journey, on the bot the person picks (skipped when there is one). */
function SessionConversationLinkControl(props: Readonly<{
  connections: readonly ChannelsConnection[] | null;
  t: Translate;
}>): React.ReactElement {
  const { t } = props;
  const page = useOpenChannelsPage();
  const [open, setOpen] = React.useState(false);
  const resolveProviderDisplayName = useConversationProviderDisplayNameResolver();
  const bots = (props.connections ?? []).filter((connection) => connection.deletionState === 'none');
  const label = t('plugins.channels.session.link', 'Link a conversation');
  if (props.connections === null || bots.length <= 1) {
    const subPath = bots.length === 1 ? `link/${bots[0]!.connectionId}` : 'link';
    return (
      <IconButton
        testID="channels-session-conversations-link"
        accessibilityLabel={label}
        icon={<Icon name="add" size="medium" tone="neutral" />}
        onPress={() => { void page.open(subPath); }}
      />
    );
  }
  return (
    <Menu
      testID="channels-session-conversations-link"
      open={open}
      onOpenChange={setOpen}
      trigger={label}
      triggerIcon="add"
      triggerAccessibilityLabel={label}
      items={[
        ...bots.map((connection) => ({
          id: `bot:${connection.connectionId}`,
          label: connectionLabel(connection),
          subtitle: resolveProviderDisplayName(connection.providerPluginId) ?? t('plugins.channels.surface.providerFallback', 'Integration provider'),
        })),
        { id: 'open-channels', label: t('plugins.channels.session.openChannels', 'Open Channels') },
      ]}
      onSelect={(id) => {
        setOpen(false);
        void page.open(id.startsWith('bot:') ? `link/${id.slice('bot:'.length)}` : '');
      }}
    />
  );
}

/** Retained rows at full strength under one freshness line (pane-states), never a banner over them. */
function SessionConversationsFreshness(props: Readonly<{
  resource: ResourcePresentation;
  offline: boolean;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement | null {
  const { t, resource } = props;
  const prefix = 'channels-session-conversations-resource';
  if (props.offline) {
    return (
      <FreshnessLine
        testID={`${prefix}-offline`}
        tone="warning"
        reason={t(
          'plugins.channels.session.offlineReason',
          'Channels isn’t reachable. Names and pauses are from your account; bots and actions come back with it.',
        )}
        action={{ label: t('plugins.channels.surface.tryAgain', 'Try again'), onPress: props.onRefresh }}
      />
    );
  }
  if (!resourceFreshnessNoticeApplies(resource)) return null;
  if (resource.pending === 'refresh') {
    return (
      <FreshnessLine
        testID={`${prefix}-refreshing`}
        busy
        reason={t('plugins.channels.session.refreshing', 'Refreshing…')}
      />
    );
  }
  const stale = resource.freshness === 'stale' || resource.error !== undefined;
  return (
    <FreshnessLine
      testID={stale ? `${prefix}-stale` : `${prefix}-live-updates-ended`}
      tone="warning"
      reason={stale
        ? t('plugins.channels.session.staleReason', 'Showing the last known conversations')
        : t('plugins.channels.session.liveUpdatesEndedReason', 'Live updates stopped')}
      action={{
        label: stale ? t('plugins.channels.surface.tryAgain', 'Try again') : t('plugins.channels.surface.refresh', 'Refresh'),
        onPress: props.onRefresh,
      }}
    />
  );
}

function SessionConversationsEmpty(props: Readonly<{
  connections: readonly ChannelsConnection[] | null;
  t: Translate;
}>): React.ReactElement {
  const { t } = props;
  const page = useOpenChannelsPage();
  const providerNames = useInstalledProviderNames();
  const bots = (props.connections ?? []).filter((connection) => connection.deletionState === 'none');
  return (
    <EmptyState
      testID="channels-session-conversations-empty"
      icon="conversations"
      title={providerNames.length === 0
        ? t('plugins.channels.session.emptyInviteTitle', 'Talk to this session from your chats')
        : t('plugins.channels.session.emptyInviteTitleProviders', 'Talk to this session from {providers}', {
          providers: formatProviderNameList(providerNames),
        })}
      description={t(
        'plugins.channels.session.emptyInviteLinkDescription',
        'Link a chat, a mailbox, a channel or an issue to this session. Messages arrive here, and replies go back.',
      )}
      action={(
        <Button
          testID="channels-session-conversations-empty-link"
          variant="primary"
          title={t('plugins.channels.session.link', 'Link a conversation')}
          onPress={() => { void page.open(bots.length === 1 ? `link/${bots[0]!.connectionId}` : 'link'); }}
        />
      )}
    />
  );
}

/** The tab itself: one composition for the daemon read and the Account-local read. */
function SessionConversationsTab(props: Readonly<{
  presentations: readonly BindingPresentation[];
  attentionByBindingId: ReadonlyMap<string, ConversationSessionBindingAttentionV1>;
  lastDeliveries: ReadonlyMap<string, ConversationSessionLastDeliveryV1>;
  /** `null` while the bots are not known (the Account-local read). */
  connections: readonly ChannelsConnection[] | null;
  resource: ResourcePresentation;
  offline: boolean;
  onRefresh: () => void;
}>): React.ReactElement {
  const t = usePluginTranslation();
  const bodyHeight = useWidgetPresentation()?.geometry?.height;
  const { presentations, attentionByBindingId } = props;
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const onToggle = React.useCallback((bindingId: string) => {
    setExpandedId((current) => (current === bindingId ? null : bindingId));
  }, []);
  const sections = React.useMemo(
    () => buildSessionConversationSections(presentations, attentionByBindingId, props.lastDeliveries, t),
    [attentionByBindingId, presentations, props.lastDeliveries, t],
  );
  const needsYou = sections.find((section) => section.key === 'need')?.count ?? 0;
  const headerActions = React.useMemo(
    () => <SessionConversationLinkControl connections={props.connections} t={t} />,
    [props.connections, t],
  );
  const header = (
    <PaneHeaderContent
      line={needsYou > 0 ? [{ text: t('plugins.channels.session.needsYouCount', '{count} needs you', { count: needsYou }), attention: true }] : []}
      actions={headerActions}
    />
  );
  if (presentations.length === 0) {
    return (
      <Screen testID="channels-session-conversations" safeArea style={bodyHeight === undefined ? undefined : { height: bodyHeight }}>
        {header}
        <SessionConversationsEmpty connections={props.connections} t={t} />
      </Screen>
    );
  }
  return (
    <Screen testID="channels-session-conversations" safeArea style={bodyHeight === undefined ? undefined : { height: bodyHeight }}>
      {header}
      <List<SessionConversationRowModel>
        sections={sections}
        keyForItem={sessionConversationRowKey}
        accessibilityLabel={t('plugins.channels.session.title', 'External conversations')}
        testID="channels-session-conversations-list"
        style={{ flex: 1 }}
        header={<SessionConversationsFreshness resource={props.resource} offline={props.offline} onRefresh={props.onRefresh} t={t} />}
        renderItem={(row) => (
          <SessionConversationRow
            row={row}
            expanded={expandedId === row.presentation.binding.bindingId}
            offline={props.offline}
            onToggle={onToggle}
            onRefresh={props.onRefresh}
            t={t}
          />
        )}
      />
    </Screen>
  );
}

const NO_ATTENTION: ReadonlyMap<string, ConversationSessionBindingAttentionV1> = new Map();

function SessionConversationsSurface(props: Readonly<{
  sessionId: string;
}>): React.ReactElement {
  const t = usePluginTranslation();
  const { resource, refresh } = useLivePluginResource(CHANNELS_SESSION_CONVERSATIONS_RESOURCE);
  const { resource: connectionsResource } = useLivePluginResource(CHANNELS_CONNECTIONS_RESOURCE);
  const sessionConversations = React.useMemo(
    () => (resource.value === undefined ? undefined : parseSessionConversationsResource(resource.value)),
    [resource.value],
  );
  const parsed = sessionConversations?.bindings;
  const parsedConnections = React.useMemo(
    () => (connectionsResource.value === undefined
      ? undefined
      : parseConnectionsResource(connectionsResource.value)),
    [connectionsResource.value],
  );
  const connections = parsedConnections?.kind === 'ready' ? parsedConnections.connections : null;
  const presentations = React.useMemo(() => buildBindingPresentations(
    parsed?.kind === 'ready' ? parsed.bindings : [],
    connections ?? [],
    t,
  ), [connections, parsed, t]);
  const attentionByBindingId = React.useMemo(() => new Map(
    (sessionConversations?.attention ?? []).map((entry) => [entry.bindingId, entry] as const),
  ), [sessionConversations]);

  if (parsed === undefined && resource.pending === 'initial') {
    return (
      <LoadingState
        testID="channels-session-conversations-loading"
        rows={3}
        title={t('plugins.channels.session.loadingTitle', 'Loading external conversations')}
      />
    );
  }
  if (parsed === undefined || parsed.kind === 'invalid') {
    return (
      <ErrorState
        testID="channels-session-conversations-error"
        kind="unavailable"
        title={t('plugins.channels.session.errorTitle', 'External conversations are unavailable')}
        description={parsed === undefined
          ? undefined
          : parseResourceErrorMessage(parsed.reason, t, 'binding')}
        action={(
          <Action.Refresh
            title={t('plugins.channels.surface.tryAgain', 'Try again')}
            onRefresh={refresh}
          />
        )}
      />
    );
  }
  return (
    <SessionConversationsTab
      presentations={presentations}
      attentionByBindingId={attentionByBindingId}
      lastDeliveries={sessionConversations?.lastDeliveries ?? NO_LAST_DELIVERIES}
      connections={connections}
      resource={resource}
      offline={false}
      onRefresh={refresh}
    />
  );
}

/**
 * The same tab from the Account-local rows while the daemon Resource is unreachable: names, audience and
 * pause stay; bots, causes and actions wait for Channels (lab ST, machine offline).
 */
function AccountLocalSessionConversationsSurface(props: Readonly<{
  sessionId: string;
  signal: AbortSignal;
}>): React.ReactElement {
  const t = usePluginTranslation();
  const dataClient = usePluginUiDataClient();
  const collection = React.useMemo(() => dataClient.collection(CHANNEL_STATE_COLLECTION), [dataClient]);
  const { bindings, resource, refresh } = useAccountLocalBindingRows(collection, props.signal, props.sessionId);
  const presentations = React.useMemo(
    () => buildBindingPresentations(bindings ?? [], [], t),
    [bindings, t],
  );

  if (bindings === undefined && resource.pending === 'initial') {
    return <LoadingState testID="channels-session-conversations-loading" rows={3} title={t('plugins.channels.session.loadingTitle', 'Loading external conversations')} />;
  }
  if (bindings === undefined) {
    return <ErrorState
      testID="channels-session-conversations-error"
      kind="unavailable"
      title={t('plugins.channels.session.errorTitle', 'External conversations are unavailable')}
      action={<Action.Refresh title={t('plugins.channels.surface.tryAgain', 'Try again')} onRefresh={refresh} />}
    />;
  }
  return (
    <SessionConversationsTab
      presentations={presentations}
      attentionByBindingId={NO_ATTENTION}
      lastDeliveries={NO_LAST_DELIVERIES}
      connections={null}
      resource={resource}
      offline
      onRefresh={refresh}
    />
  );
}

function SessionConversationsAvailabilitySurface(props: Readonly<{
  sessionId: string;
  signal: AbortSignal;
}>): React.ReactElement {
  const { resource } = useLivePluginResource(CHANNELS_SESSION_CONVERSATIONS_RESOURCE);
  return isHostMethodCurrentlyUnavailable(resource.error)
    ? <AccountLocalSessionConversationsSurface sessionId={props.sessionId} signal={props.signal} />
    : <SessionConversationsSurface sessionId={props.sessionId} />;
}


/**
 * Settings presentation for a mount that CAN serve daemon Resources.
 *
 * Structural capability answers “could this mount ever read a Resource”;
 * it cannot answer “can it right now”. This component consumes the second,
 * current fact from the canonical Resource owner — the same shared entry the
 * daemon surface below reads, so observing it costs no extra read — and hands
 * an actual outage the direct Account-Collection editor the offline vertical
 * exists for. Keeping the subscription HERE is what preserves recovery: the
 * store's own watch retry re-establishes and re-reads when the daemon returns,
 * which would stop if the only subscriber unmounted with the daemon surface.
 */
function ChannelsAccountSettingsSurface(props: Readonly<{
  signal: AbortSignal;
  targetPluginId: string;
}>): React.ReactElement {
  const { resource } = useLivePluginResource(CHANNELS_BINDINGS_RESOURCE);
  if (isHostMethodCurrentlyUnavailable(resource.error)) {
    return <AccountLocalBindingsSurface signal={props.signal} />;
  }
  return <DaemonChannelsSurface signal={props.signal} targetPluginId={props.targetPluginId} />;
}

/**
 * Resource availability has two distinct facts and this branch reads both.
 * `version().methods` is the mount's permanent structural contract, so a mount
 * that never installs `readResource` consumes the direct Account-local policy
 * vertical immediately. A mount that does install it may still be unable to
 * serve it right now; that current fact belongs to the call, and
 * `ChannelsAccountSettingsSurface` owns it.
 *
 * The mount is read BEFORE that capability branch: the Session destination and
 * the Settings page are two destinations of one artifact, and the Account-local
 * settings vertical is not a truthful fallback for a Session mount.
 */
/** The Channels page's own outage demotion, the same one Settings uses. */
function ChannelsPageAvailabilitySurface(props: Readonly<{
  signal: AbortSignal;
  subPath: string | undefined;
}>): React.ReactElement {
  const { resource } = useLivePluginResource(CHANNELS_BINDINGS_RESOURCE);
  return isHostMethodCurrentlyUnavailable(resource.error)
    ? <AccountLocalChannelsPageSurface signal={props.signal} subPath={props.subPath} machineUnavailableReason={resource.error?.message} />
    : <DaemonChannelsPageSurface signal={props.signal} subPath={props.subPath} />;
}

export function ChannelsSurface(context: RenderContext): React.ReactElement {
  const target = context.surface.target;
  if (
    context.surface.mount.kind === 'destination'
    && context.surface.mount.destination.localId === CHANNELS_PAGE_VIEW_ID
  ) {
    return context.hostApi.version().methods.includes('readResource')
      ? <ChannelsPageAvailabilitySurface signal={context.signal} subPath={context.subPath} />
      : <AccountLocalChannelsPageSurface signal={context.signal} subPath={context.subPath} />;
  }
  const isSessionConversationsMount = context.surface.mount.kind === 'destination'
    ? context.surface.mount.destination.localId === CHANNELS_SESSION_CONVERSATIONS_VIEW_ID
    : context.surface.mount.kind === 'embedded'
      && context.surface.mount.role === 'widget';
  if (
    isSessionConversationsMount
    && target.kind === 'session'
  ) {
    return context.hostApi.version().methods.includes('readResource')
      ? <SessionConversationsAvailabilitySurface sessionId={target.sessionId} signal={context.signal} />
      : <AccountLocalSessionConversationsSurface sessionId={target.sessionId} signal={context.signal} />;
  }
  if (!context.hostApi.version().methods.includes('readResource')) {
    return <AccountLocalBindingsSurface signal={context.signal} />;
  }
  return (
    <ChannelsAccountSettingsSurface
      signal={context.signal}
      targetPluginId={context.plugin.id}
    />
  );
}

export const renderSurface = defineUiSurface(ChannelsSurface);

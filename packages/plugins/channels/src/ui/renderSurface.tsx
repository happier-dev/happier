import * as React from 'react';
import { pluginUiTargetedContributionOperationKey } from '@happier-dev/plugin-sdk/ui';
import type { AgentPermissionIntentV1 } from '@happier-dev/plugin-sdk/sessions';
import type {
  PluginActionInputById,
  PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';
import { readActionInputOptionValue } from '@happier-dev/plugin-sdk/actions';
import type {
  PluginUiActionExecutionOptions,
  PluginUiTargetedContributionsV1,
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
  Item,
  ItemGroup,
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
  usePluginBrandDisplayName,
  usePluginBrandDisplayNameResolver,
  usePluginHostApi,
  usePluginTheme,
  usePluginTranslation,
  usePluginUiFocusTarget,
  useSessionState,
  useSurfaceContext,
  useWidgetPresentation,
  type PluginUiResourceSnapshot,
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
  CONVERSATION_OBSERVATION_AGE_MS_FOR_OMITTED_FIELD_V1,
  MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
  MAX_CONVERSATION_INBOUND_DEBOUNCE_MS,
  MAX_CONVERSATION_OBSERVATION_AGE_MS,
  MIN_CONVERSATION_OBSERVATION_AGE_MS,
  type ConversationBindingTargetV1,
  type ConversationBindingV1,
  type ConversationConnectionCreateInputV1,
  type ConversationConnectionPrepareResultV1,
  type ConversationConnectionEndpointRequiredResultV1,
  type ConversationConnectionWebhookEndpointSetupRequiredResultV1,
  type ConversationPairingResourceV1,
  ConversationSessionLastDeliveryV1Schema,
  type ConversationSessionLastDeliveryV1,
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
  readChannelsPageLocation,
} from './conversationRows.js';
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
  setupGuidance?: Readonly<{
    externalUrl: string;
    requiredPermissionsLabel: string;
  }>;
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
  targetedContributions: PluginUiTargetedContributionsV1,
  targetPluginId: string,
  role: 'setup' | 'setupRemediation',
  providerPluginId?: string,
  selectedContribution?: ProviderTargetedOperation,
): readonly ProviderTargetedOperation[] {
  if (targetedContributions.target.pluginId !== targetPluginId) return [];
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
  targetedContributions: PluginUiTargetedContributionsV1,
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
  targetedContributions: PluginUiTargetedContributionsV1,
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
  return row.kind === 'occurrenceConflict' ? row.censusId : row.obligationId;
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
    commit: (write: TInput, signal: AbortSignal) => Promise<TResult>;
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
      settled = { status: 'success', result };
      if (result.kind !== 'unchanged' && !input.signal.aborted) input.onCommitted();
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
  const commit = React.useCallback(async (
    write: BindingPolicyInput,
    signal: AbortSignal,
  ): Promise<ConversationBindingEnablementResult> => (
    await updateConversationBindingPolicyInAccountCollection({ collection, ...write, signal })
  ), [collection]);
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
  selectedTransport: ConnectionCreateTransport;
  accountEncryptionMode: 'plain' | 'e2ee';
  testID: string;
  t: Translate;
}>): React.ReactElement {
  const unavailable = props.t('plugins.channels.surface.summaryUnavailable', 'Unavailable');
  return (
    <Stack gap="small" testID={props.testID}>
      <Heading level={4} value={props.t('plugins.channels.surface.connectionReviewTitle', 'Review connection')} />
      <Metadata
        title={props.t('plugins.channels.surface.connectionReviewSummary', 'Connection summary')}
        entries={[
          { label: props.t('plugins.channels.surface.provider', 'Provider'), value: props.presentation.providerDisplayName },
          { label: props.t('plugins.channels.surface.connectionAccount', 'Connected Account'), value: props.presentation.connectedAccountLabel ?? unavailable },
          { label: props.t('plugins.channels.surface.selectedMachineSummary', 'Runs on your selected machine'), value: props.presentation.machineDisplayName ?? unavailable },
          { label: props.t('plugins.channels.surface.bindingCreateConversation', 'Destination'), value: props.presentation.destinationLabel ?? unavailable },
          { label: props.t('plugins.channels.surface.transport', 'Transport'), value: transportOutcomeLabel(props.selectedTransport, props.t) },
          { label: props.t('plugins.channels.surface.connectionReviewContinuity', 'Continuity'), value: connectionPolicyOutcome(props.presentation, props.t) },
        ]}
      />
      <Banner
        tone="info"
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
  if (tone === 'warning') return 1;
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
  if (connection.tone !== 'success') return connection;
  return presentation.binding.enabled
    ? { tone: 'success' as const, label: t('plugins.channels.surface.enabled', 'Enabled') }
    : { tone: 'neutral' as const, label: t('plugins.channels.surface.disabled', 'Disabled') };
}

function bindingMachineSummary(connection: ChannelsConnection | undefined, t: Translate): string {
  return connection === undefined
    ? t('plugins.channels.surface.bindingConnectionUnavailable', 'Connection details are unavailable')
    : connectionMachinePlacementLabel(connection, t);
}

function bindingTargetSummary(binding: ChannelsBinding, t: Translate): string {
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
  if (tone === 'warning') return 1;
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

function formatHistoryGapReportedAt(reportedAt: number, t: Translate): string {
  const date = new Date(reportedAt);
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
  )} ${formatHistoryGapReportedAt(historyGap.reportedAt, t)}.`;
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

function pollBlockedDescription(t: Translate): string {
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
    descriptions.push(pollBlockedDescription(t));
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
          description={pollBlockedDescription(props.t)}
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

type DestructiveConfirmation = Readonly<{
  open: boolean;
  openerFocusTarget: PluginUiFocusTarget;
  confirmationFocusTarget: PluginUiFocusTarget;
  /** Open the confirmation and move logical focus into it. */
  request: () => void;
  /** User-driven cancel or confirm: close it and return focus to its opener. */
  dismiss: () => void;
  /** State-driven close, such as the confirmed subject changing underneath. */
  close: () => void;
}>;

/**
 * The one destructive-confirmation focus contract in this surface: opening a
 * confirmation transfers logical focus into it, and cancelling or confirming
 * returns focus to the control that opened it. A confirmation closed because
 * its subject changed underneath is not a user dismissal and does not move
 * focus.
 */
function useDestructiveConfirmation(): DestructiveConfirmation {
  const openerFocusTarget = usePluginUiFocusTarget();
  const confirmationFocusTarget = usePluginUiFocusTarget();
  const [open, setOpen] = React.useState(false);
  const restoreOpenerFocusRef = React.useRef(false);

  React.useEffect(() => {
    if (open) {
      confirmationFocusTarget.focus();
      return;
    }
    if (!restoreOpenerFocusRef.current) return;
    restoreOpenerFocusRef.current = false;
    openerFocusTarget.focus();
  }, [confirmationFocusTarget, open, openerFocusTarget]);

  const request = React.useCallback(() => { setOpen(true); }, []);
  const dismiss = React.useCallback(() => {
    restoreOpenerFocusRef.current = true;
    setOpen(false);
  }, []);
  const close = React.useCallback(() => {
    restoreOpenerFocusRef.current = false;
    setOpen(false);
  }, []);

  return React.useMemo(() => ({
    open,
    openerFocusTarget,
    confirmationFocusTarget,
    request,
    dismiss,
    close,
  }), [close, confirmationFocusTarget, dismiss, open, openerFocusTarget, request]);
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
  const session = useSessionState(isSession ? binding.target.summary : null);
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
            {isSession && openSession !== undefined ? (
              <Button
                testID="channels-page-open-session"
                variant="secondary"
                title={t('plugins.channels.page.openSession', 'Open session')}
                busy={opening}
                disabled={opening}
                onPress={() => {
                  setOpening(true);
                  setOpenFailed(false);
                  void openSession(binding.target.summary).then((opened) => {
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

/**
 * One linked conversation (lab C1): identity, what it talks to, the one cause
 * that needs the reader, where its messages go, its settings as a summary with
 * Edit, its bot, and Pause / Unlink last. Every mutation here is the page's
 * own enablement and delete operation; editing is the incumbent draft → review
 * → save journey, never inline switches that would bypass review.
 */
function ConversationDetail(props: Readonly<{
  presentation: BindingPresentation;
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
  const providerDisplayName = usePluginBrandDisplayName(providerPluginId)
    ?? t('plugins.channels.surface.providerFallback', 'Integration provider');
  const editFocusTarget = usePluginUiFocusTarget();
  const deleteConfirmation = useDestructiveConfirmation();
  const enablementFailure = props.enablementFailure?.bindingId === binding.bindingId
    ? props.enablementFailure
    : undefined;
  const enablementOutcomeUnknown = props.execution.status === 'outcomeUnknown';
  const deleteExecution = props.deleteOperation?.execution;
  const deleteOutcomeUnknown = deleteExecution?.status === 'outcomeUnknown';
  const enablementBusy = props.execution.status === 'pending' && props.activeBindingId === binding.bindingId;
  const deleteBusy = deleteExecution?.status === 'pending' && props.activeDeletedBindingId === binding.bindingId;
  const { close: closeDeleteConfirmation } = deleteConfirmation;
  React.useEffect(() => {
    closeDeleteConfirmation();
  }, [binding.bindingId, binding.deletionState, binding.revision, closeDeleteConfirmation]);

  const mutationLocked = deleteConfirmation.open
    || props.execution.status === 'pending'
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
  const botNeedsYou = botStatus !== undefined && (botStatus.tone === 'warning' || botStatus.tone === 'danger');
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

  return (
    <Stack gap="large" testID={`channels-binding-${binding.bindingId}`}>
      <PageHeader
        title={bindingEndpointLabel(binding, t)}
        leading={providerPluginId === undefined ? undefined : (
          <BrandMark
            pluginId={providerPluginId}
            size="medium"
            externallyLabelled
            testID={`channels-provider-brand-binding-${binding.bindingId}`}
          />
        )}
        meta={[
          ...(providerPluginId === undefined ? [] : [{ key: 'provider', text: providerDisplayName }]),
          ...(connection === undefined ? [] : [{ key: 'bot', text: connectionLabel(connection) }]),
          { key: 'audience', text: binding.endpoint.audience === 'direct'
            ? t('plugins.channels.page.onlyYou', 'Only you')
            : t('plugins.channels.page.sharedConversation', 'Shared conversation') },
        ]}
      />

      <ConversationTargetSection
        binding={binding}
        mutationLocked={mutationLocked || deleting}
        {...(props.onEdit === undefined || deleting || editing ? {} : {
          onLinkAnother: () => props.onEdit?.(binding, editFocusTarget, 'target'),
        })}
        {...(navigation.openSession === undefined ? {} : { openSession: navigation.openSession })}
        t={t}
      />

      {deleting ? (
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
      ) : null}

      <Row gap="small" align="center">
        <Icon name="conversations" size="small" tone="muted" />
        <Text testID="channels-page-note" tone="secondary" value={conversationNote(binding, t)} />
      </Row>

      {editing ? props.editContent : (
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
          <Item title={t('plugins.channels.page.sendsBack', 'Sends back')} detail={bindingDeliveryModeLabel(binding.deliveryMode, t)} />
          {approvalSummary === undefined ? null : (
            <Item title={t('plugins.channels.page.approvals', 'Approvals from this conversation')} detail={approvalSummary} />
          )}
        </ItemGroup>
      )}

      <ConversationBotSection
        {...(connection === undefined ? {} : { connection })}
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
            subtitle={binding.target.kind === 'automation'
              ? t('plugins.channels.page.unlinkAutomationDescription', 'The automation stops hearing from this conversation. The bot stays connected.')
              : t('plugins.channels.page.unlinkSessionDescription', 'The session stops hearing from this conversation. The bot stays connected.')}
            accessoryOutsidePressable
            accessory={deleteConfirmation.open ? undefined : (
              <Button
                testID={`channels-binding-delete-${binding.bindingId}`}
                variant="secondary"
                title={deleteBusy
                  ? t('plugins.channels.page.unlinking', 'Unlinking…')
                  : t('plugins.channels.page.unlinkAction', 'Unlink…')}
                busy={deleteBusy}
                disabled={deleteUnavailable}
                focusTarget={deleteConfirmation.openerFocusTarget}
                onPress={deleteConfirmation.request}
              />
            )}
          />
        )}
      </ItemGroup>

      {deleteConfirmation.open ? (
        <Stack gap="small" testID={`channels-binding-delete-confirmation-${binding.bindingId}`}>
          <Banner
            tone="danger"
            title={t('plugins.channels.page.unlinkConfirmTitle', 'Unlink this conversation?')}
            description={t(
              'plugins.channels.page.unlinkConfirmDescription',
              'Messages from it stop reaching the session, and its settings are removed. The bot stays connected, and you can link the conversation again later.',
            )}
          />
          <Row gap="small">
            <Button
              testID={`channels-binding-delete-confirm-${binding.bindingId}`}
              variant="primary"
              title={t('plugins.channels.page.unlinkConfirm', 'Unlink')}
              disabled={deleteBusy || deleteOutcomeUnknown}
              focusTarget={deleteConfirmation.confirmationFocusTarget}
              onPress={() => {
                deleteConfirmation.dismiss();
                void props.onDelete?.(binding);
              }}
            />
            <Button
              title={t('plugins.channels.surface.cancel', 'Cancel')}
              variant="plain"
              disabled={deleteBusy || deleteOutcomeUnknown}
              onPress={deleteConfirmation.dismiss}
            />
          </Row>
        </Stack>
      ) : null}

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
  onManage: () => void;
  t: Translate;
}>): React.ReactElement {
  return props.connection !== undefined && props.connectionTest !== undefined ? (
    <TestableConversationBotSection
      connection={props.connection}
      connectionTest={props.connectionTest}
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
  test?: React.ReactElement;
  onManage: () => void;
  t: Translate;
}>): React.ReactElement {
  const { connection, t } = props;
  const status = connection === undefined ? undefined : connectionStatus(connection, t);
  const needsYou = status !== undefined && (status.tone === 'warning' || status.tone === 'danger');
  return (
    <ItemGroup testID="channels-page-bot" title={t('plugins.channels.page.bot', 'Bot')}>
      <Item
        title={connection === undefined
          ? t('plugins.channels.surface.bindingConnectionUnavailable', 'Connection details are unavailable')
          : connectionLabel(connection)}
        {...(connection === undefined || status === undefined ? {} : {
          subtitle: `${status.label} · ${connectionMachinePlacementLabel(connection, t)}`,
        })}
        {...(needsYou ? { tone: 'warning' as const } : {})}
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
function ConversationsEmptyPage(props: Readonly<{
  connections: readonly ChannelsConnection[];
  onConnectBot: () => void;
  onLink: () => void;
  t: Translate;
}>): React.ReactElement {
  const { t } = props;
  const bots = props.connections.filter((connection) => connection.deletionState === 'none');
  if (bots.length === 0) {
    return (
      <EmptyState
        testID="channels-page-no-bots"
        layout="page"
        icon="conversations"
        title={t('plugins.channels.page.noBotsTitle', 'Talk to your sessions from Telegram, Discord or GitHub')}
        description={t(
          'plugins.channels.page.noBotsDescription',
          'Link a chat, a channel or an issue to a session. People there can ask the agent for help and get its replies, without installing Happier. You’ll need a bot token or a GitHub account.',
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
        <Step marker={{ kind: 'number', value: 2 }} title={t('plugins.channels.page.linkStepPairing', 'Send the pairing code to the bot in a private message, to prove it’s you.')} />
        <Step marker={{ kind: 'number', value: 3 }} title={t('plugins.channels.page.linkStepTarget', 'Choose the session, review, and turn it on.')} />
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
  const resolveProviderName = usePluginBrandDisplayNameResolver();
  const providerName = React.useCallback(
    (providerPluginId: string) => resolveProviderName(providerPluginId)
      ?? t('plugins.channels.surface.providerFallback', 'Integration provider'),
    [resolveProviderName, t],
  );
  const groups = React.useMemo(() => buildChannelsConversationIndex({
    bindings: props.presentations.map((presentation) => presentation.binding),
    connections: props.connections,
    providerName,
    t,
  }), [props.connections, props.presentations, providerName, t]);
  return (
    <Stack gap="large" testID="channels-page-index">
      <PageHeader
        title={t('plugins.channels.page.title', 'Channels')}
        description={t('plugins.channels.page.description', 'Conversations in Telegram, Discord and GitHub that talk to your sessions.')}
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
          {group.rows.map((row) => (
            <Item
              key={row.binding.bindingId}
              testID={`channels-page-row-${row.binding.bindingId}`}
              title={row.title}
              titleNumberOfLines={1}
              subtitle={bindingTargetKindLabel(row.binding.target.kind, t)}
              {...(row.status?.kind === 'paused' ? { detail: t('plugins.channels.column.paused', 'Paused') } : {})}
              {...(row.status?.kind === 'deleting' ? {
                detail: t('plugins.channels.surface.deleteFinalizing', 'Deletion cleanup in progress'),
              } : {})}
              {...(row.connection === undefined ? {} : {
                icon: <BrandMark pluginId={row.connection.providerPluginId} size="small" externallyLabelled />,
              })}
              onPress={() => props.onOpen(row.binding.bindingId)}
            />
          ))}
        </ItemGroup>
      ))}
    </Stack>
  );
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
type BindingCreateActiveStage = Exclude<BindingCreateStage, 'closed'>;
type BindingCreateTarget =
  | Readonly<{ kind: 'session'; sessionId: string; label: string }>
  | Readonly<{
    kind: 'automation';
    automationId: string;
    label: string;
    execution: BindingCreateAutomationExecution;
  }>;
type BindingCreateSessionCandidate = Readonly<{ id: string; label: string }>;
type BindingCreateSessionPage = Readonly<{
  candidates: readonly BindingCreateSessionCandidate[];
  nextCursor?: string;
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
type BindingCreatePairingRequest = Readonly<{
  connectionId: string;
  expectedConnectionRevision: number;
  pairingRequestId: string;
}>;
type BindingCreateFeedback =
  | 'resolverUnavailable'
  | 'resolverStale'
  | 'resolverNotReady'
  | 'sessionUnavailable'
  | 'automationUnavailable'
  | 'newSessionUnavailable'
  | 'targetNotVerified'
  | 'targetResultDeliveryUnavailable'
  | 'createUnavailable'
  | 'pairingUnavailable'
  | 'created';

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
  principalSelection: Readonly<{
    query: string;
    selected: readonly Readonly<{ id: string; kind: 'human' | 'bot' }>[];
  }>;
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
type BindingEditorTarget = BindingEditorSessionTarget | BindingEditorAutomationTarget;
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
  return {
    kind: 'automation',
    automationId: binding.target.automationId,
    policy: binding.target.policy,
  };
}

/** Outgoing-message admission breadth; a higher rank admits more senders. */
const BINDING_INPUT_MODE_BREADTH: Readonly<Record<BindingInputMode, number>> = Object.freeze({
  directMentionsOnly: 0,
  addressedMessages: 1,
  allAllowedMessages: 2,
});

/**
 * The ONE authority comparison for binding edits, so a widening change can
 * never pass one editor unconfirmed while the other requires confirmation.
 *
 * The cold-offline editor consults it to decide when its draft must pass the
 * shared confirmation boundary; the daemon-backed editor routes every change
 * through that boundary, which confirms a superset of what this comparison
 * requires.
 *
 * A change widens authority unless every changed fact is a provable pure
 * narrowing (fewer senders, a smaller audience, a pause). Facts this surface
 * cannot rank — in particular any permission-ceiling change — are confirmed
 * rather than classified here, so the safer question is always asked.
 */
function bindingEditWidensAuthority(previous: BindingEditorDraft, next: BindingEditorDraft): boolean {
  if (!previous.enabled && next.enabled) return true;
  if (!previous.allowBotSenders && next.allowBotSenders) return true;
  if (BINDING_INPUT_MODE_BREADTH[next.inputMode] > BINDING_INPUT_MODE_BREADTH[previous.inputMode]) return true;
  if (next.allowedPrincipalIds.some((principalId) => (
    !previous.allowedPrincipalIds.includes(principalId)
  ))) return true;
  if (previous.target.kind !== next.target.kind) return true;
  if (previous.target.kind === 'session' && next.target.kind === 'session') {
    const previousPolicy = previous.target.policy;
    const nextPolicy = next.target.policy;
    if (previousPolicy.deliveryMode === 'repliesOnly' && nextPolicy.deliveryMode === 'mirrorSession') return true;
    if (previousPolicy.permissionCeiling !== nextPolicy.permissionCeiling) return true;
    if (previousPolicy.approvals.kind === 'off' && nextPolicy.approvals.kind === 'enabled') return true;
    if (previousPolicy.approvals.kind === 'enabled' && nextPolicy.approvals.kind === 'enabled') {
      if (previousPolicy.approvals.maximumScope === 'request'
        && nextPolicy.approvals.maximumScope === 'session') return true;
      const previousApprovalIds = previousPolicy.approvals.principalIds;
      if (previousApprovalIds !== undefined
        && nextPolicy.approvals.principalIds?.some((principalId) => (
          !previousApprovalIds.includes(principalId)
        ))) return true;
    }
    if (previousPolicy.newSession.kind === 'off' && nextPolicy.newSession.kind === 'enabled') return true;
    return false;
  }
  if (previous.target.kind === 'automation' && next.target.kind === 'automation') {
    return previous.target.policy.resultDelivery === 'none'
      && next.target.policy.resultDelivery === 'finalResult';
  }
  return false;
}

/**
 * The one confirmation boundary both binding editors present before a widening
 * change is saved: destination, admitted principals, execution machine,
 * permission scope, and consequence. The create journey's review summary is
 * the same presentation for a new binding.
 */
function BindingEditConfirmationSummary(props: Readonly<{
  draft: BindingEditorDraft;
  connection: ChannelsConnection | undefined;
  t: Translate;
}>): React.ReactElement {
  const { draft, t } = props;
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
          ] : [
            {
              label: t('plugins.channels.surface.bindingEditResultDelivery', 'Result delivery'),
              value: bindingDeliveryModeLabel(draft.target.policy.resultDelivery, t),
            },
          ]),
          {
            label: t('plugins.channels.surface.bindingCreateApprovals', 'Approvals'),
            value: bindingApprovalAudienceLabel(draft.target, t),
          },
          {
            label: t('plugins.channels.surface.bindingCreateInputMode', 'Incoming messages'),
            value: bindingInputModeLabel(draft.inputMode, t),
          },
          { label: t('plugins.channels.surface.bindingEditDebounce', 'Inbound debounce (ms)'), value: draft.inboundDebounceMs },
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
        const selected = await hostApi.selectActionInput({
          hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
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
function BindingSessionTargetPolicyControls(props: Readonly<{
  target: BindingEditorSessionTarget;
  admittedPrincipalIds: readonly string[];
  retainedApprovalPrincipalIds?: readonly string[];
  disabled: boolean;
  /** Whether the host can currently run its own new-Session selection. */
  configureNewSessionAvailable: boolean;
  onChange: (transform: (target: BindingEditorSessionTarget) => BindingEditorSessionTarget) => void;
  onRetainApprovalPrincipalIds: (principalIds: readonly string[] | undefined) => void;
  onConfigureNewSession: () => void;
  t: Translate;
}>): React.ReactElement {
  const approvalPrincipalIds = props.target.policy.approvals.kind === 'enabled'
    ? props.target.policy.approvals.principalIds
    : undefined;
  return (
    <Stack gap="small">
      <Heading level={3} value={props.t('plugins.channels.surface.bindingEditTargetPolicy', 'Session target policy')} />
      <Form.Select
        testID="channels-binding-target-delivery-mode"
        label={props.t('plugins.channels.surface.bindingCreateDeliveryMode', 'Session delivery')}
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
      <Form.Select
        testID="channels-binding-target-permission-ceiling"
        label={props.t('plugins.channels.surface.bindingCreatePermissionCeiling', 'Permission ceiling')}
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
      <Form.Toggle
        testID="channels-binding-target-approvals"
        label={props.t('plugins.channels.surface.bindingCreateApprovals', 'Approvals')}
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
      {props.target.policy.approvals.kind === 'enabled'
        ? (
          <>
            <Form.Select
              testID="channels-binding-target-approvals-scope"
              label={props.t('plugins.channels.surface.bindingCreateApprovalsScope', 'Maximum approval scope')}
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
            <Form.Select
              testID="channels-binding-target-approvals-audience"
              label={props.t('plugins.channels.surface.bindingCreateApprovalsAudience', 'Approval audience')}
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
            {approvalPrincipalIds === undefined ? null : (
              <Stack gap="small">
                {props.admittedPrincipalIds.map((principalId) => {
                  const selected = approvalPrincipalIds.includes(principalId);
                  const selectedCount = approvalPrincipalIds.length;
                  return (
                    <Form.Toggle
                      key={principalId}
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
                  );
                })}
              </Stack>
            )}
          </>
        )
        : null}
      <Form.Toggle
        testID="channels-binding-target-configure-new-session"
        label={props.t('plugins.channels.surface.bindingCreateConfigureNewSession', 'Configure a new Session')}
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
  return target.kind === 'session'
    ? `${bindingTargetKindLabel(target.kind, t)}: ${target.sessionId}`
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
  return isNonNegativeSafeInteger(parsed) && parsed <= MAX_CONVERSATION_INBOUND_DEBOUNCE_MS
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

function bindingCreateEndpointSelection(
  query: string,
  candidate: BindingCreateEndpointCandidate,
): BindingCreateEndpointSelection {
  // The resolver's display labels remain presentation-only. The guarded writer
  // receives the provider-authenticated identity and the exact query evidence.
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

function bindingCreatePrincipalSelection(
  query: string,
  candidate: BindingCreatePrincipalCandidate,
): BindingCreatePrincipalSelection | undefined {
  if (candidate.kind !== 'human' && candidate.kind !== 'bot') return undefined;
  return {
    query,
    selected: [{ id: candidate.id, kind: candidate.kind }],
  };
}

function parseBindingCreateSessionPage(value: unknown): BindingCreateSessionPage | undefined {
  if (!isRecord(value) || !Array.isArray(value.sessions) || value.sessions.length > 100) return undefined;
  if (value.nextCursor !== undefined && value.nextCursor !== null && !isNonEmptyString(value.nextCursor)) {
    return undefined;
  }
  const seen = new Set<string>();
  const candidates: BindingCreateSessionCandidate[] = [];
  for (const entry of value.sessions) {
    if (!isRecord(entry) || !isNonEmptyString(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    // Session titles are the only user-facing session fact this flow needs.
    // In particular, it never asks for or reads a transcript preview.
    candidates.push({
      id: entry.id,
      label: isNonEmptyString(entry.title) ? entry.title : 'Session',
    });
  }
  return {
    candidates,
    ...(isNonEmptyString(value.nextCursor) ? { nextCursor: value.nextCursor } : {}),
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

function bindingCreateStageTitle(stage: BindingCreateActiveStage, t: Translate): string {
  switch (stage) {
    case 'endpoint':
      return t('plugins.channels.surface.bindingCreateEndpoint', 'Choose a conversation');
    case 'principal':
      return t('plugins.channels.surface.bindingCreatePrincipal', 'Choose an allowed sender');
    case 'target':
      return t('plugins.channels.surface.bindingCreateTarget', 'Choose a target');
    case 'policies':
      return t('plugins.channels.surface.bindingCreatePolicies', 'Policies');
    case 'review':
      return t('plugins.channels.surface.bindingCreateReview', 'Review binding');
  }
}

function BindingCreateStepActions(props: Readonly<{
  onBack?: () => void;
  onCancel: () => void;
  disabled: boolean;
  backDisabled?: boolean;
  t: Translate;
}>): React.ReactElement {
  return (
    <Stack gap="small" testID="channels-binding-create-step-actions">
      {props.onBack === undefined ? null : (
        <Button
          title={props.t('plugins.channels.surface.bindingCreateBack', 'Back')}
          variant="plain"
          disabled={props.disabled || props.backDisabled === true}
          onPress={props.onBack}
        />
      )}
      <Button
        title={props.t('plugins.channels.surface.bindingCreateCancel', 'Cancel')}
        variant="secondary"
        disabled={props.disabled}
        onPress={props.onCancel}
      />
    </Stack>
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
      expectedConnectionRevision: proposal.expectedConnectionRevision,
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
      tone="success"
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
        <Status tone="info" label={props.t('plugins.channels.surface.bindingCreatePairingFinalizing', 'Pairing is being completed')} />
        {retryAction}
      </Stack>
    );
  }
  if (proposal?.state === 'proposed') {
    return (
      <Stack gap="small">
        {unknownOutcome}
        {feedbackContent}
        <Status tone="info" label={props.t('plugins.channels.surface.bindingCreatePairingProposal', 'Pairing request received')} />
        <Metadata
          title={props.t('plugins.channels.surface.bindingCreatePairingProposalDetails', 'Pairing request')}
          entries={[
            {
              label: props.t('plugins.channels.surface.bindingCreatePairingEndpoint', 'External conversation'),
              value: proposal.endpointLabel
                ?? props.t('plugins.channels.surface.bindingCreateEndpointFallback', 'Conversation'),
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
  if (challenge !== undefined && !challengeExpiry.expired) {
    return (
      <Stack gap="small">
        {unknownOutcome}
        {feedbackContent}
        <Heading level={2} value={props.t('plugins.channels.surface.bindingCreatePairingChallengeTitle', 'Complete pairing')} />
        {challengeExpiry.countdown === undefined ? null : (
          <Text
            testID="channels-binding-create-pairing-countdown"
            tone="info"
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
            {
              label: props.t('plugins.channels.surface.bindingCreatePairingAttempts', 'Attempts remaining'),
              value: String(challenge.attemptsRemaining),
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
  const [createdBindingId, setCreatedBindingId] = React.useState<string | undefined>();
  const resolveAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve);
  const createAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate);
  const pairingAction = useExecutePluginAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate);
  const sessionsAction = useExecutePluginAction('session.list');
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
  const [principalLabel, setPrincipalLabel] = React.useState<string | undefined>();
  const [pairingRequired, setPairingRequired] = React.useState(false);
  const [pairingContext, setPairingContext] = React.useState<BindingCreatePairingContext | undefined>();
  const [pairingCreateRequest, setPairingCreateRequest] = React.useState<BindingCreatePairingRequest | undefined>();
  const [sessionCandidates, setSessionCandidates] = React.useState<readonly BindingCreateSessionCandidate[]>([]);
  const [sessionNextCursor, setSessionNextCursor] = React.useState<string | undefined>();
  const [automationCandidates, setAutomationCandidates] = React.useState<readonly BindingCreateAutomationCandidate[]>([]);
  const [automationNextCursor, setAutomationNextCursor] = React.useState<string | undefined>();
  const [target, setTarget] = React.useState<BindingCreateTarget | undefined>();
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
  const mountedRef = React.useRef(true);
  const restoreOpenerFocusRef = React.useRef(false);
  const availableConnections = React.useMemo(
    () => props.connections.filter((connection) => connection.deletionState === 'none'),
    [props.connections],
  );
  const currentConnection = availableConnections.find((connection) => connection.connectionId === connectionId);
  const providerDisplayName = usePluginBrandDisplayName(currentConnection?.providerPluginId)
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
    : principalSelection.selected.map((principal, index) => (
      index === 0 && principalLabel !== undefined && principalLabel !== principal.id
        ? `${principalLabel} (${principal.id})`
        : principal.id
    )).join(', ');
  const admittedPrincipalIds = principalSelection?.selected.map((principal) => principal.id) ?? [];
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
    setPrincipalLabel(undefined);
    setPairingRequired(false);
    setPairingContext(undefined);
    setPairingCreateRequest(undefined);
    setSessionCandidates([]);
    setSessionNextCursor(undefined);
    setAutomationCandidates([]);
    setAutomationNextCursor(undefined);
    setTarget(undefined);
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
  }, []);

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
    // while requiring the next resolution to establish pairing again.
    setPairingRequired(false);
    setPairingContext(undefined);
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
    setPrincipalLabel(undefined);
    setPairingRequired(false);
    setAutomationCandidates([]);
    setAutomationNextCursor(undefined);
    setTarget(undefined);
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
      setFeedback('resolverNotReady');
    } else {
      setFeedback('resolverUnavailable');
    }
  }, [actionLocked, currentConnection, endpointQuery, props.signal, resolveAction]);

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
      setFeedback('resolverNotReady');
    } else {
      setFeedback('resolverUnavailable');
    }
  }, [actionLocked, currentConnection, endpointSelection, principalQuery, props.signal, resolveAction]);

  const loadSessions = React.useCallback(async (cursor?: string) => {
    if (actionLocked || props.signal.aborted) return;
    setFeedback(undefined);
    const settled = await sessionsAction.execute({
      limit: 100,
      includeLastMessagePreview: false,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status !== 'success') {
      setFeedback('sessionUnavailable');
      return;
    }
    const page = parseBindingCreateSessionPage(settled.result);
    if (page === undefined || (cursor === undefined && page.candidates.length === 0)) {
      setFeedback('sessionUnavailable');
      return;
    }
    setSessionCandidates((previous) => {
      if (cursor === undefined) return page.candidates;
      const seen = new Set(previous.map((candidate) => candidate.id));
      return [...previous, ...page.candidates.filter((candidate) => {
        if (seen.has(candidate.id)) return false;
        seen.add(candidate.id);
        return true;
      })];
    });
    setSessionNextCursor(page.nextCursor);
  }, [actionLocked, props.signal, sessionsAction]);

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
    return createSessionTarget;
  }, [automationResultDelivery, createSessionTarget, target]);

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
      // Pairing proves the person through a private message, but it binds the
      // conversation this person chose here.
      endpointSelection,
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
        setFeedback('createUnavailable');
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
  }, [actionLocked, createTarget, currentConnection, endpointSelection, pairingAction, props.signal]);

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
          <Status tone="success" label={props.t('plugins.channels.surface.bindingCreateCreated', 'Binding created')} />
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
    const copy: Readonly<Record<Exclude<BindingCreateFeedback, 'created'>, readonly [string, string]>> = {
      resolverUnavailable: [
        props.t('plugins.channels.surface.bindingCreateUnavailableTitle', 'Binding setup is unavailable'),
        props.t('plugins.channels.surface.bindingCreateUnavailableDescription', 'Refresh connection details and try this selection again.'),
      ],
      resolverStale: [
        props.t('plugins.channels.surface.bindingCreateStaleTitle', 'The selected connection changed'),
        props.t('plugins.channels.surface.bindingCreateStaleDescription', 'Refresh binding details and make a new selection.'),
      ],
      resolverNotReady: [
        props.t('plugins.channels.surface.bindingCreateUnavailableTitle', 'Binding setup is not ready'),
        props.t('plugins.channels.surface.bindingCreateUnavailableDescription', 'Wait for the provider to become ready, then refresh this page.'),
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
    };
    const [title, description] = copy[feedback];
    return <Banner tone="warning" title={title} description={description} />;
  })();

  const connectionOptions = availableConnections.map((connection) => ({
    value: connection.connectionId,
    label: connection.integrationPrincipalLabel
      ?? props.t('plugins.channels.surface.providerFallback', 'Conversation connection'),
  }));

  return (
    <Stack gap="medium" testID="channels-binding-create">
      <Button
        testID="channels-binding-create-open"
        title={props.t('plugins.channels.surface.bindingCreateAction', 'Add binding')}
        variant="secondary"
        focusTarget={openerFocusTarget}
        disabled={actionLocked || pairingContext !== undefined || availableConnections.length === 0}
        onPress={openJourney}
      />
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
          <Status
            testID="channels-binding-create-stage"
            tone="info"
            label={`${props.t('plugins.channels.surface.bindingCreateCurrentStep', 'Current step')}: ${bindingCreateStageTitle(stage, props.t)}`}
          />
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
              <Form.TextField
                testID="channels-binding-create-endpoint-query"
                label={props.t('plugins.channels.surface.bindingCreateEndpointQuery', 'Conversation search')}
                value={endpointQuery}
                onChange={setEndpointQuery}
                disabled={actionLocked}
              />
              <Button
                title={props.t('plugins.channels.surface.bindingCreateEndpointSearch', 'Search endpoints')}
                busy={resolveAction.execution.status === 'pending'}
                disabled={actionLocked || endpointQuery.trim() === ''}
                onPress={searchEndpoints}
              />
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
                        setPrincipalLabel(undefined);
                        setPairingRequired(false);
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
              <Form.TextField
                testID="channels-binding-create-principal-query"
                label={props.t('plugins.channels.surface.bindingCreatePrincipalQuery', 'People search')}
                value={principalQuery}
                onChange={setPrincipalQuery}
                disabled={actionLocked}
              />
              <Button
                title={props.t('plugins.channels.surface.bindingCreatePrincipalSearch', 'Search people')}
                busy={resolveAction.execution.status === 'pending'}
                disabled={actionLocked || principalQuery.trim() === ''}
                onPress={searchPrincipals}
              />
              {principalCandidates.length > 0 ? (
                <ItemGroup
                  accessibilityRole="radiogroup"
                  accessibilityLabel={props.t('plugins.channels.surface.bindingCreatePrincipalCandidates', 'Allowed sender candidates')}
                >
                  {principalCandidates.flatMap((candidate) => {
                    const selection = bindingCreatePrincipalSelection(principalQuery, candidate);
                    if (selection === undefined) return [];
                    return [(
                      <List.Item
                        key={candidate.id}
                        title={candidate.label ?? props.t('plugins.channels.surface.bindingCreatePrincipalFallback', 'Person')}
                        accessibilityRole="radio"
                        selected={principalSelection?.selected.some((principal) => (
                          principal.id === candidate.id && principal.kind === candidate.kind
                        )) === true}
                        disabled={actionLocked}
                        onPress={() => {
                          setPrincipalSelection(selection);
                          setPrincipalLabel(candidate.label ?? candidate.id);
                          setAllowBotSenders(candidate.kind === 'bot');
                          setFeedback(undefined);
                        }}
                      />
                    )];
                  })}
                </ItemGroup>
              ) : null}
              <Button
                title={props.t('plugins.channels.surface.bindingCreateContinue', 'Continue')}
                disabled={actionLocked || principalSelection === undefined}
                onPress={continueFromPrincipal}
              />
              <BindingCreateStepActions
                disabled={actionLocked}
                onBack={backToEndpoint}
                onCancel={cancelJourney}
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
                  tone="info"
                  title={props.t('plugins.channels.surface.bindingCreatePairingTitle', 'Pairing is required')}
                  description={props.t(
                    'plugins.channels.surface.bindingCreatePairingDescription',
                    'This provider cannot resolve individual senders. Create a pairing challenge for the selected target instead.',
                  )}
                />
              ) : null}
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
              <Stack gap="small">
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
              </Stack>
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
              <Button
                title={props.t('plugins.channels.surface.bindingCreateReview', 'Review binding')}
                disabled={actionLocked || !createApprovalAudienceValid}
                onPress={() => setStage('review')}
              />
              <BindingCreateStepActions
                disabled={actionLocked}
                onBack={backToTarget}
                onCancel={cancelJourney}
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
              <Banner
                testID="channels-binding-create-privacy-disclosure"
                tone="info"
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
                        label: props.t('plugins.channels.surface.bindingCreateConfigureNewSession', 'Configure a new Session'),
                        value: newSessionDraft === undefined
                          ? props.t('plugins.channels.surface.bindingCreateNewSessionDisabled', 'Do not create a new Session')
                          : props.t('plugins.channels.surface.bindingCreateNewSessionEnabled', 'Create a new Session'),
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
              <Button
                testID="channels-binding-create-submit"
                title={pairingRequired
                  ? props.t('plugins.channels.surface.bindingCreatePairingConfirm', 'Create pairing challenge')
                  : props.t('plugins.channels.surface.bindingCreateConfirm', 'Create binding')}
                busy={createAction.execution.status === 'pending' || pairingAction.execution.status === 'pending'}
                disabled={actionLocked || feedback === 'created'}
                onPress={pairingRequired ? createPairing : createBinding}
              />
              <BindingCreateStepActions
                disabled={actionLocked}
                backDisabled={feedback === 'created'}
                onBack={backToPolicies}
                onCancel={cancelJourney}
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
  return (
    <>
      <Form.Toggle
        label={props.t('plugins.channels.surface.bindingEditEnabled', 'Enable this binding')}
        value={fields.enabled}
        disabled={props.disabled}
        onChange={(enabled) => onChange((current) => ({ ...current, enabled }))}
      />
      <Form.Toggle
        label={props.t('plugins.channels.surface.bindingCreateAllowBots', 'Allow bot senders')}
        value={fields.allowBotSenders}
        disabled={props.disabled || props.botSendersLocked}
        onChange={(allowBotSenders) => onChange((current) => ({ ...current, allowBotSenders }))}
      />
      <BindingInputModeCapabilityNotice
        deliverableInputModes={props.deliverableInputModes}
        testID="channels-binding-input-mode-capability"
        t={props.t}
      />
      <Form.Select
        label={props.t('plugins.channels.surface.bindingCreateInputMode', 'Incoming messages')}
        options={bindingInputModeOptions(props.deliverableInputModes, props.t)}
        value={fields.inputMode}
        disabled={props.disabled}
        onChange={(inputMode) => {
          if (!isBindingInputMode(inputMode)) return;
          onChange((current) => ({ ...current, inputMode }));
        }}
      />
      <Form.Select
        testID="channels-binding-inbound-debounce"
        label={props.t('plugins.channels.surface.bindingEditDebounce', 'Message grouping delay')}
        options={durationPresetOptions(INBOUND_GROUPING_PRESETS_MS, fields.inboundDebounceMs, props.t)}
        value={fields.inboundDebounceMs}
        disabled={props.disabled}
        onChange={(inboundDebounceMs) => {
          const selected = readActionInputOptionValue(inboundDebounceMs);
          if (typeof selected !== 'string') return;
          onChange((current) => ({ ...current, inboundDebounceMs: selected }));
        }}
      />
      {props.debounceValid ? null : (
        <Text
          tone="danger"
          value={props.t(
            'plugins.channels.surface.bindingEditDebounceInvalid',
            `Enter a whole number from 0 to ${MAX_CONVERSATION_INBOUND_DEBOUNCE_MS}.`,
          )}
        />
      )}
      <Form.Select
        label={props.t('plugins.channels.surface.bindingCreateLinkPreview', 'Link previews')}
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
      <Form.Select
        label={props.t('plugins.channels.surface.bindingCreateSenderFeedback', 'Sender feedback')}
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
    </>
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
  const sessionsAction = useExecutePluginAction('session.list');
  const automationAction = useExecutePluginAction('automation.conversation.targets.list');
  const stageFocusTarget = usePluginUiFocusTarget();
  const feedbackFocusTarget = usePluginUiFocusTarget();
  const [detail, setDetail] = React.useState<BindingEditorDetail | undefined>();
  const [draft, setDraft] = React.useState<BindingEditorDraft | undefined>();
  const [stage, setStage] = React.useState<BindingEditorStage>('policies');
  const [detailPending, setDetailPending] = React.useState(true);
  const [feedback, setFeedback] = React.useState<BindingEditorFeedback | undefined>();
  const [outcomeUnknown, setOutcomeUnknown] = React.useState(false);
  const [requiresReresolution, setRequiresReresolution] = React.useState(false);
  const [readConnectionRevision, setReadConnectionRevision] = React.useState<number | undefined>();
  const [endpointQuery, setEndpointQuery] = React.useState('');
  const [endpointCandidates, setEndpointCandidates] = React.useState<readonly BindingCreateEndpointCandidate[]>([]);
  const [endpointSelection, setEndpointSelection] = React.useState<BindingCreateEndpointSelection | undefined>();
  const [endpointLabel, setEndpointLabel] = React.useState<string | undefined>();
  const [principalQuery, setPrincipalQuery] = React.useState('');
  const [principalCandidates, setPrincipalCandidates] = React.useState<readonly BindingCreatePrincipalCandidate[]>([]);
  const [selectedPrincipals, setSelectedPrincipals] = React.useState<readonly BindingEditorPrincipalCandidate[]>([]);
  const [audienceResolution, setAudienceResolution] = React.useState<BindingEditorAudienceResolution>('none');
  const [sessionCandidates, setSessionCandidates] = React.useState<readonly BindingCreateSessionCandidate[]>([]);
  const [sessionNextCursor, setSessionNextCursor] = React.useState<string | undefined>();
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
      setFeedback('resolverNotReady');
      return;
    }
    if (result.data.kind !== 'endpointCandidates') {
      setFeedback('resolverUnavailable');
      return;
    }
    setEndpointCandidates(result.data.candidates);
    setAudienceResolution('endpoint');
  }, [actionLocked, currentConnection, endpointQuery, props.signal, resolveAction]);

  const searchPrincipals = React.useCallback(async () => {
    if (currentConnection === undefined
      || endpointSelection === undefined
      || audienceResolution !== 'endpoint'
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
    setSelectedPrincipals([]);
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
      setFeedback('resolverNotReady');
      return;
    }
    if (result.data.kind !== 'principalCandidates') {
      setFeedback('resolverUnavailable');
      return;
    }
    setPrincipalCandidates(result.data.candidates);
    setAudienceResolution('principal');
  }, [actionLocked, audienceResolution, currentConnection, endpointSelection, principalQuery, props.signal, resolveAction]);

  const applyAudienceSelection = React.useCallback(() => {
    if (currentConnection === undefined
      || endpointSelection === undefined
      || endpointLabel === undefined
      || selectedPrincipals.length === 0
      || audienceResolution !== 'principal'
      || actionLocked) {
      return;
    }
    const principalSelection = {
      query: principalQuery,
      selected: selectedPrincipals.map((principal) => ({ id: principal.id, kind: principal.kind })),
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
  }, [actionLocked, audienceResolution, currentConnection, endpointLabel, endpointSelection, principalQuery, selectedPrincipals]);

  const loadSessions = React.useCallback(async (cursor?: string) => {
    if (actionLocked || props.signal.aborted) return;
    setFeedback(undefined);
    const settled = await sessionsAction.execute({
      limit: 100,
      includeLastMessagePreview: false,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!mountedRef.current || props.signal.aborted) return;
    if (settled.status !== 'success') {
      setFeedback('sessionUnavailable');
      return;
    }
    const page = parseBindingCreateSessionPage(settled.result);
    if (page === undefined || (cursor === undefined && page.candidates.length === 0)) {
      setFeedback('sessionUnavailable');
      return;
    }
    setSessionCandidates((previous) => {
      if (cursor === undefined) return page.candidates;
      const seen = new Set(previous.map((candidate) => candidate.id));
      return [...previous, ...page.candidates.filter((candidate) => {
        if (seen.has(candidate.id)) return false;
        seen.add(candidate.id);
        return true;
      })];
    });
    setSessionNextCursor(page.nextCursor);
  }, [actionLocked, props.signal, sessionsAction]);

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
      return <Status tone="success" label={props.t('plugins.channels.surface.bindingUpdated', 'Binding updated')} focusTarget={feedbackFocusTarget} />;
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
    const copy: Readonly<Record<Exclude<BindingEditorFeedback, 'updated' | 'quotaIncompatible' | 'resolverStale'>, readonly [string, string]>> = {
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
        <Heading level={2} value={props.t('plugins.channels.surface.bindingEdit', 'Edit binding')} focusTarget={stageFocusTarget} />
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

  return (
    <Stack gap="medium">
      <Status
        tone="info"
        label={`${props.t('plugins.channels.surface.bindingEditCurrentStep', 'Current step')}: ${stage === 'policies'
          ? props.t('plugins.channels.surface.bindingEdit', 'Edit binding')
          : stage === 'endpoint'
            ? props.t('plugins.channels.surface.bindingCreateEndpoint', 'Choose a conversation')
            : stage === 'principal'
              ? props.t('plugins.channels.surface.bindingCreatePrincipal', 'Choose allowed senders')
              : stage === 'target'
                ? props.t('plugins.channels.surface.bindingCreateTarget', 'Choose a target')
                : props.t('plugins.channels.surface.bindingEditReview', 'Review changes')}`}
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
      {currentSummaryNotice}
      {connectionNotice}
      {stage === 'policies' && draft !== undefined ? (
        <Stack gap="small">
          <Heading level={2} value={props.t('plugins.channels.surface.bindingEdit', 'Edit binding')} focusTarget={stageFocusTarget} />
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
          <Button
            title={props.t('plugins.channels.surface.bindingEditAudience', 'Re-resolve conversation and allowed senders')}
            variant="secondary"
            disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
            onPress={openEndpointReselection}
          />
          <Button
            title={props.t('plugins.channels.surface.bindingEditTarget', 'Change target')}
            variant="secondary"
            disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
            onPress={() => {
              setFeedback(undefined);
              setStage('target');
              void loadSessions();
            }}
          />
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
          ) : (
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
          <Button
            title={props.t('plugins.channels.surface.bindingEditReview', 'Review changes')}
            disabled={actionLocked || finalizingDelete || debounceMs === undefined}
            onPress={() => setStage('review')}
          />
          <Button
            title={props.t('plugins.channels.surface.cancel', 'Cancel')}
            variant="plain"
            disabled={actionLocked && !outcomeUnknown}
            onPress={() => props.onClose(true)}
          />
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
          {principalCandidates.length === 0 ? null : (
            <Stack gap="small">
              {principalCandidates.filter(isBindingEditorPrincipalCandidate).map((candidate) => {
                const selected = selectedPrincipals.some((principal) => (
                  principal.id === candidate.id && principal.kind === candidate.kind
                ));
                return (
                  <Form.Toggle
                    key={`${candidate.kind}:${candidate.id}`}
                    label={candidate.label ?? candidate.id}
                    value={selected}
                    disabled={actionLocked || !providerControlsAvailable || finalizingDelete}
                    onChange={(nextSelected) => {
                      setSelectedPrincipals((current) => nextSelected
                        ? current.some((principal) => principal.id === candidate.id && principal.kind === candidate.kind)
                          ? current
                          : [...current, candidate]
                        : current.filter((principal) => !(principal.id === candidate.id && principal.kind === candidate.kind)));
                    }}
                  />
                );
              })}
            </Stack>
          )}
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
          <Button
            title={props.t('plugins.channels.surface.bindingEditSave', 'Save binding')}
            busy={updateAction.execution.status === 'pending' || detailPending}
            disabled={saveLocked || feedback === 'updated'}
            onPress={() => { void submit(); }}
          />
          <Stack gap="small">
            <Button
              title={props.t('plugins.channels.surface.bindingCreateBack', 'Back')}
              variant="plain"
              disabled={actionLocked && !outcomeUnknown}
              onPress={() => setStage('policies')}
            />
            <Button
              title={props.t('plugins.channels.surface.cancel', 'Cancel')}
              variant="plain"
              disabled={actionLocked && !outcomeUnknown}
              onPress={() => props.onClose(true)}
            />
          </Stack>
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
  const sectionState = props.sectionState ?? BINDINGS_SECTION_READY;
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

  const body = (() => {
    if (props.location.step === 'link') {
      return (
        <Stack gap="large" testID="channels-page-link-flow">
          <PageHeader
            title={props.t('plugins.channels.column.link', 'Link a conversation')}
            description={props.t('plugins.channels.page.linkDescription', 'Choose a chat and the session it should talk to.')}
          />
          {sectionAvailable ? props.bindingCreateContent : null}
        </Stack>
      );
    }
    if (sectionState.kind === 'loading') {
      return (
        <LoadingState
          testID="channels-bindings-loading"
          title={props.t('plugins.channels.page.loadingTitle', 'Loading conversations')}
          description={props.t(
            'plugins.channels.surface.bindingsLoadingDescription',
            'Reading the current binding policy from your Account.',
          )}
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
      if (props.connectionsState === 'loading') {
        return <LoadingState testID="channels-bindings-loading" title={props.t('plugins.channels.page.loadingTitle', 'Loading conversations')} />;
      }
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
          description={props.t('plugins.channels.page.description', 'Conversations in Telegram, Discord and GitHub that talk to your sessions.')}
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
      <ScrollArea contentContainerStyle={{ padding: theme.spacing.large, paddingBottom: theme.spacing.large * 2 }}>
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
              tone="info"
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
  const filterTarget = React.useCallback((row: BindingTargetCandidateRow, query: string) => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return normalizedQuery === ''
      || row.candidate.label.toLocaleLowerCase().includes(normalizedQuery);
  }, []);
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
        filter: filterTarget,
      }}
      accessibilityLabel={props.t('plugins.channels.surface.bindingCreateTarget', 'Choose a target')}
      testID="channels-binding-target-candidates"
      style={{ height: 320 }}
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
  const [reviewing, setReviewing] = React.useState(false);
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

  // The same authority comparison the daemon-backed editor consults decides
  // when a draft must pass the shared confirmation boundary. A provable pure
  // narrowing (or an unchanged draft) stays immediately savable — the offline
  // path never adds confirmation friction to reducing a binding's authority.
  const widensAuthority = detail !== undefined && draft !== undefined
    && bindingEditWidensAuthority(bindingEditorDraftFromBinding(detail.binding), draft);

  React.useEffect(() => {
    if (!reviewing) return;
    stageFocusTarget.focus();
  }, [reviewing, stageFocusTarget]);

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
      // never claims a change the Account has not returned. The editor also
      // leaves the review boundary: the change it summarized is saved.
      if (await readDetail({ preserveDraft: false }) === 'ready' && mountedRef.current) {
        setReviewing(false);
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
          tone="success"
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
        <Heading level={2} value={props.t('plugins.channels.surface.bindingEdit', 'Edit binding')} focusTarget={stageFocusTarget} />
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
      <Heading level={2} value={props.t('plugins.channels.surface.bindingEdit', 'Edit binding')} focusTarget={stageFocusTarget} />
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
        tone="info"
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
      ) : (
        <Banner
          testID="channels-account-local-binding-automation-target-unavailable"
          tone="info"
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
      {reviewing ? (
        <BindingEditConfirmationSummary
          draft={draft}
          connection={props.presentation?.connection}
          t={props.t}
        />
      ) : null}
      {reviewing ? (
        <Button
          testID="channels-account-local-binding-save"
          title={props.t('plugins.channels.surface.bindingEditSave', 'Save binding')}
          busy={saving}
          disabled={saveLocked}
          onPress={() => { void submit(); }}
        />
      ) : widensAuthority ? (
        <Button
          testID="channels-account-local-binding-review"
          title={props.t('plugins.channels.surface.bindingEditReview', 'Review changes')}
          disabled={actionLocked || finalizingDelete || debounceMs === undefined}
          onPress={() => setReviewing(true)}
        />
      ) : (
        <Button
          testID="channels-account-local-binding-save"
          title={props.t('plugins.channels.surface.bindingEditSave', 'Save binding')}
          busy={saving}
          disabled={saveLocked}
          onPress={() => { void submit(); }}
        />
      )}
      {reviewing ? (
        <Button
          title={props.t('plugins.channels.surface.bindingCreateBack', 'Back')}
          variant="plain"
          disabled={saving}
          onPress={() => setReviewing(false)}
        />
      ) : null}
      <Button
        title={props.t('plugins.channels.surface.cancel', 'Cancel')}
        variant="plain"
        disabled={saving}
        onPress={() => props.onClose(true)}
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
}>): React.ReactElement {
  const t = usePluginTranslation();
  const channels = useAccountLocalChannels(props.signal, t);
  const { collection, deliveriesCollection } = channels;
  const { bindings, resource, refresh } = channels.bindingsRead;
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
      onRefresh={refresh}
      operation={operation}
      location={location}
      connections={channels.sortedConnections}
      connectionsState={channels.connectionState}
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
              tone="info"
              label={t(
                'plugins.channels.surface.savedPendingMachineReconciliation',
                'Saved to your Account. The selected machine will reconcile this policy when it is available.',
              )}
            />
          ) : null}
          <IngressAttentionControls
            signal={props.signal}
            recoveryActionsAvailable={false}
            t={t}
          />
          <ConnectionsContent
            connections={channels.sortedConnections}
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

function ConnectionRow(props: Readonly<{
  connection: ChannelsConnection;
  expanded: boolean;
  signal: AbortSignal;
  resource: ResourcePresentation;
  targetPluginId?: string;
  policyOperation?: ConnectionPolicyOperation;
  resolveOperation?: DeliveryResolveOperation;
  providerDependentOperationsAvailable?: boolean;
  onLifecycleSettled?: (connectionId: string) => void;
  onExpand: () => void;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement {
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
  const status = connectionStatus(props.connection, props.t);
  const provider = usePluginBrandDisplayName(props.connection.providerPluginId)
    ?? props.t('plugins.channels.surface.providerFallback', 'Integration provider');
  const label = connectionLabel(props.connection);
  const continuityDescriptions = connectionContinuityDescriptions(props.connection, props.t);

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

  return (
    <>
      <List.Item
        testID={`channels-connection-${props.connection.connectionId}`}
        title={label}
        subtitle={`${props.t('plugins.channels.surface.provider', 'Provider')}: ${provider}`}
        detail={[
          connectionPolicyLabel(props.connection, props.t),
          connectionMachinePlacementLabel(props.connection, props.t),
          transportLabel(props.connection.selectedTransport, props.t),
        ].join(' · ')}
        icon={(
          <BrandMark
            pluginId={props.connection.providerPluginId}
            size="small"
            externallyLabelled
            testID={`channels-provider-brand-${props.connection.connectionId}`}
          />
        )}
        accessory={(
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
      {props.expanded ? (
        <List.Item>
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
          {providerDependentOperationsAvailable
            && props.targetPluginId !== undefined
            && isConversationConnectionSelectableTransportV1(props.connection.selectedTransport) ? (
            <ConnectionTransferControls
              connection={props.connection}
              signal={props.signal}
              targetPluginId={props.targetPluginId}
              resource={props.resource}
              onRefresh={requestRefresh}
              t={props.t}
            />
          ) : null}
          {providerDependentOperationsAvailable ? (
            <ConnectionLifecycleControls
              connection={props.connection}
              resource={props.resource}
              onSettled={props.onLifecycleSettled}
              onRefresh={requestRefresh}
              t={props.t}
            />
          ) : null}
          {providerDependentOperationsAvailable ? (
            <ConnectionPollRetryControls
              connection={props.connection}
              resource={props.resource}
              onRefresh={requestRefresh}
              t={props.t}
            />
          ) : null}
          {/*
            Re-probing needs the selected machine's provider, so it lives
            inside the same provider-dependent gate every other provider
            effect uses rather than inventing its own availability rule.
          */}
          {providerDependentOperationsAvailable ? (
            <ConnectionRetestControls
              connection={props.connection}
              resource={props.resource}
              onRefresh={requestRefresh}
              t={props.t}
            />
          ) : null}
          {/*
            Delivery resolution is deliberately outside the provider-dependent
            gate: the resolution owner performs no provider call, so a cold
            offline Account must still be able to clear ambiguity that would
            otherwise never expire.
          */}
          {props.connection.attention.outwardDelivery.partial
            || props.connection.attention.outwardDelivery.outcomeUnknown
            || props.connection.attention.outwardDelivery.archiveRecovery ? (
              <ConnectionDeliveryResolutionControls
                connection={props.connection}
                signal={props.signal}
                resolveOperation={props.resolveOperation}
                onRefresh={requestRefresh}
                t={props.t}
              />
            ) : null}
        </List.Item>
      ) : null}
    </>
  );
}

/**
 * Cold offline policy retains the same editor and currentness UX, but its
 * complete desired-state write goes straight to the admitted Account
 * Collection. Provider-dependent recovery and delivery controls remain
 * unavailable rather than becoming an Action fallback.
 */
function AccountLocalConnectionRow(props: Readonly<{
  collection: ChannelStateCollection;
  deliveriesCollection: ChannelDeliveriesCollection;
  connection: ChannelsConnection;
  expanded: boolean;
  signal: AbortSignal;
  resource: ResourcePresentation;
  onCommitted: () => void;
  onExpand: () => void;
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
      signal={props.signal}
      resource={props.resource}
      policyOperation={policyOperation}
      resolveOperation={resolveOperation}
      providerDependentOperationsAvailable={false}
      onExpand={props.onExpand}
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

  const status = connectionStatus(props.connection, props.t);
  const label = connectionLabel(props.connection);
  const observationAgeRange = `${formatObservationAge(MIN_CONVERSATION_OBSERVATION_AGE_MS, props.t)} ${props.t(
    'plugins.channels.surface.through',
    'through',
  )} ${formatObservationAge(MAX_CONVERSATION_OBSERVATION_AGE_MS, props.t)}`;
  return (
    <Stack testID="channels-connection-detail" gap="large">
      <Action.Refresh
        testID="channels-detail-resource-refresh"
        title={props.t('plugins.channels.surface.refresh', 'Refresh')}
        onRefresh={props.onRefresh}
      />

      <Stack gap="small">
        <Heading level={2} value={label} />
        <Text
          value={props.t(
            'plugins.channels.surface.integrationIdentity',
            'Integration identity and Account policy',
          )}
        />
        <Status tone={status.tone} label={status.label} />
      </Stack>

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
      <ConnectionContinuityDisclosures connection={props.connection} t={props.t} />
      {props.providerDependentOperationsAvailable ? (
        <ConnectionHistoryGapBaselineControls
          connection={props.connection}
          resource={props.resource}
          onRefresh={props.onRefresh}
          t={props.t}
        />
      ) : null}

      <Metadata
        title={props.t('plugins.channels.surface.currentPolicy', 'Current connection policy')}
        entries={[
          {
            label: props.t('plugins.channels.surface.provider', 'Provider'),
            value: props.provider,
          },
          {
            label: props.t('plugins.channels.surface.transport', 'Transport'),
            value: transportLabel(props.connection.selectedTransport, props.t),
          },
          {
            label: props.t('plugins.channels.surface.maximumObservationAge', 'Maximum observation age'),
            value: formatObservationAge(props.connection.maximumObservationAgeMs, props.t),
          },
        ]}
      />

      <Metadata
        title={props.t('plugins.channels.surface.technicalDetails', 'Technical details')}
        entries={[
          {
            label: props.t('plugins.channels.surface.selectedMachineId', 'Selected machine ID'),
            value: props.connection.selectedMachineId,
          },
        ]}
      />

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
          tone="info"
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

      <Form.Field
        label={props.t('plugins.channels.surface.enabledPolicy', 'Enabled')}
        description={props.t(
          'plugins.channels.surface.enabledPolicyDescription',
          'Allow this integration to accept and deliver under its saved policy.',
        )}
        disabled={updateUnavailable || saving || mutationUnavailable}
      >
        <Form.Toggle
          testID="channels-connection-enabled"
          label={props.t('plugins.channels.surface.enabledPolicy', 'Enabled')}
          value={props.draft.enabled}
          onChange={props.onEnabledChange}
          disabled={updateUnavailable || saving || mutationUnavailable}
        />
      </Form.Field>

      <Form.Field
        label={props.t('plugins.channels.surface.maximumObservationAge', 'Maximum observation age')}
        description={`${props.t(
          'plugins.channels.surface.maximumObservationAgeDescription',
          'Accept incoming observations no older than this limit.',
        )} ${props.t('plugins.channels.surface.observationAgeRange', 'Choose a value from')} ${observationAgeRange}.`}
        disabled={updateUnavailable || saving || mutationUnavailable}
        issue={validationIssue}
      >
        <Form.Select
          testID="channels-connection-observation-age"
          label={props.t(
            'plugins.channels.surface.maximumObservationAgeInput',
            'How long incoming messages stay eligible',
          )}
          options={durationPresetOptions(OBSERVATION_AGE_PRESETS_MS, props.draft.maximumObservationAgeMs, props.t)}
          value={props.draft.maximumObservationAgeMs}
          onChange={(next) => {
            const selected = readActionInputOptionValue(next);
            if (typeof selected !== 'string') return;
            props.onMaximumObservationAgeMsChange(selected);
            if (validationIssue !== undefined) setValidationIssue(undefined);
          }}
          disabled={updateUnavailable || saving || mutationUnavailable}
        />
      </Form.Field>

      {props.execution.status === 'success' ? (
        <Status
          testID="channels-save-outcome"
          tone="success"
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

      <Button
        testID="channels-connection-save"
        title={saving
          ? props.t('plugins.channels.surface.saving', 'Saving…')
          : props.t('plugins.channels.surface.save', 'Save changes')}
        busy={saving}
        disabled={saveUnavailable}
        onPress={save}
      />
    </Stack>
  );
}

/**
 * A history gap is durable source evidence, not something this surface can
 * repair. The registered Action owns the fresh row read, gap clearing, and
 * any provider baseline work; this control only submits its exact Resource
 * revision after an explicit owner decision.
 */
function ConnectionHistoryGapBaselineControls(props: Readonly<{
  connection: ChannelsConnection;
  resource: ResourcePresentation;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement | null {
  const baselineAction = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamBaselineAccept,
  );
  const confirmation = useDestructiveConfirmation();
  const historyGap = props.connection.attention.historyGap;
  const outcomeUnknown = baselineAction.execution.status === 'outcomeUnknown';
  const resourceCurrent = props.resource.pending === 'idle'
    && props.resource.freshness === 'fresh'
    && props.resource.error === undefined;
  const requestRefresh = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown,
    resource: props.resource,
    onRefresh: props.onRefresh,
    onReconciled: baselineAction.reset,
  });

  const { close: closeStaleConfirmation } = confirmation;
  React.useEffect(() => {
    closeStaleConfirmation();
  }, [
    closeStaleConfirmation,
    props.connection.authorityEpoch,
    props.connection.connectionId,
    props.connection.revision,
    historyGap?.reason,
    historyGap?.reportedAt,
  ]);

  const closeConfirmation = confirmation.dismiss;
  const acceptBaseline = React.useCallback(async () => {
    if (historyGap === null
      || !resourceCurrent
      || baselineAction.execution.status === 'pending'
      || baselineAction.execution.status === 'outcomeUnknown') {
      return;
    }
    closeConfirmation();
    const settled = await baselineAction.execute({
      connectionId: props.connection.connectionId,
      expectedRevision: props.connection.revision,
    });
    if (settled.status === 'success') props.onRefresh();
  }, [
    baselineAction,
    closeConfirmation,
    historyGap,
    props.connection.connectionId,
    props.connection.revision,
    props.onRefresh,
    resourceCurrent,
  ]);

  if (historyGap === null) return null;

  const busy = baselineAction.execution.status === 'pending';
  const unavailable = !resourceCurrent || busy || outcomeUnknown || confirmation.open;
  return (
    <Stack testID="channels-history-gap-baseline-controls" gap="small">
      <Button
        testID="channels-history-gap-baseline-accept"
        title={busy
          ? props.t('plugins.channels.surface.historyGapBaselineAccepting', 'Accepting new baseline…')
          : props.t('plugins.channels.surface.historyGapBaselineAccept', 'Accept new history baseline')}
        accessibilityLabel={props.t(
          'plugins.channels.surface.historyGapBaselineAccept',
          'Accept new history baseline',
        )}
        busy={busy}
        disabled={unavailable}
        focusTarget={confirmation.openerFocusTarget}
        onPress={confirmation.request}
      />
      {confirmation.open ? (
        <Stack testID="channels-history-gap-baseline-confirmation" gap="small">
          <Banner
            tone="danger"
            title={props.t(
              'plugins.channels.surface.historyGapBaselineConfirmTitle',
              'Accept a new conversation history baseline?',
            )}
            description={props.t(
              'plugins.channels.surface.historyGapBaselineConfirmDescription',
              'This resumes the saved connection from the provider’s current baseline without replaying unavailable history.',
            )}
          />
          <Button
            testID="channels-history-gap-baseline-confirm"
            title={props.t(
              'plugins.channels.surface.historyGapBaselineConfirm',
              'Confirm new history baseline',
            )}
            disabled={busy || outcomeUnknown || !resourceCurrent}
            focusTarget={confirmation.confirmationFocusTarget}
            onPress={() => { void acceptBaseline(); }}
          />
          <Button
            testID="channels-history-gap-baseline-cancel"
            title={props.t('plugins.channels.surface.cancel', 'Cancel')}
            variant="plain"
            disabled={busy || outcomeUnknown}
            onPress={closeConfirmation}
          />
        </Stack>
      ) : null}
      {baselineAction.execution.status === 'error' ? (
        <Banner
          testID="channels-history-gap-baseline-error"
          tone="danger"
          title={props.t(
            'plugins.channels.surface.historyGapBaselineFailedTitle',
            'Could not accept a new history baseline',
          )}
          description={props.t(
            'plugins.channels.surface.historyGapBaselineFailedDescription',
            'The history gap remains. Refresh the current connection before deciding what to do next.',
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
          testID="channels-history-gap-baseline-outcome-unknown"
          tone="warning"
          title={props.t(
            'plugins.channels.surface.historyGapBaselineUnknownTitle',
            'Could not confirm the history baseline request',
          )}
          description={props.t(
            'plugins.channels.surface.historyGapBaselineUnknownDescription',
            'The request may already have been applied. Refresh the current connection before trying again.',
          )}
          action={(
            <Action.Refresh
              testID="channels-history-gap-baseline-outcome-unknown-reconcile"
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
  const abandonAction = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon,
  );
  // An owed durable-push target move is repaired, never accepted as a loss:
  // the endpoint is still ours to move, and deleting the connection drops it
  // altogether, so both remain honest offers while it waits.
  const mayRepairEndpointRetarget = props.connection.attention.endpointRetargetOwed;
  const mayAbandon = props.connection.attention.oldTransportStopUnconfirmed
    && !props.connection.attention.acceptedPossibleLoss
    && !mayRepairEndpointRetarget;
  const mayDelete = props.connection.deletionState === 'none'
    && (!props.connection.attention.oldTransportStopUnconfirmed
      || props.connection.attention.acceptedPossibleLoss
      || mayRepairEndpointRetarget);
  const activeAction = mayAbandon ? abandonAction : deleteAction;
  const confirmation = useDestructiveConfirmation();
  const outcomeUnknown = activeAction.execution.status === 'outcomeUnknown';
  const requestRefresh = useExplicitFreshRereadAfterUnknownOutcome({
    outcomeUnknown,
    resource: props.resource,
    onRefresh: props.onRefresh,
    onReconciled: activeAction.reset,
  });

  const { close: closeStaleConfirmation } = confirmation;
  React.useEffect(() => {
    closeStaleConfirmation();
  }, [
    closeStaleConfirmation,
    mayAbandon,
    mayDelete,
    props.connection.authorityEpoch,
    props.connection.connectionId,
    props.connection.revision,
  ]);

  const execute = React.useCallback(async () => {
    if ((!mayAbandon && !mayDelete)
      || activeAction.execution.status === 'pending'
      || activeAction.execution.status === 'outcomeUnknown') {
      return;
    }
    const settled = await activeAction.execute({
      connectionId: props.connection.connectionId,
      expectedRevision: props.connection.revision,
    });
    if (settled.status === 'success') {
      props.onSettled?.(props.connection.connectionId);
    }
    if (settled.status !== 'pending' && settled.status !== 'outcomeUnknown') {
      props.onRefresh();
    }
  }, [activeAction, mayAbandon, mayDelete, props.connection, props.onRefresh, props.onSettled]);

  const { dismiss: dismissConfirmation } = confirmation;
  const confirm = React.useCallback(async () => {
    dismissConfirmation();
    await execute();
  }, [dismissConfirmation, execute]);

  const repairBusy = abandonAction.execution.status === 'pending';
  const repairEndpointRetarget = React.useCallback(async () => {
    if (!mayRepairEndpointRetarget
      || abandonAction.execution.status === 'pending'
      || abandonAction.execution.status === 'outcomeUnknown') {
      return;
    }
    const settled = await abandonAction.execute({
      connectionId: props.connection.connectionId,
      expectedRevision: props.connection.revision,
    });
    if (settled.status !== 'pending' && settled.status !== 'outcomeUnknown') {
      props.onRefresh();
    }
  }, [abandonAction, mayRepairEndpointRetarget, props.connection, props.onRefresh]);

  if (!mayAbandon && !mayDelete && !mayRepairEndpointRetarget) return null;

  const repairTitle = props.t(
    'plugins.channels.surface.repairEndpointRetarget',
    'Repair delivery target',
  );

  const busy = activeAction.execution.status === 'pending';
  const title = mayAbandon
    ? props.t('plugins.channels.surface.acceptPossibleLoss', 'Accept possible loss')
    : props.t('plugins.channels.surface.delete', 'Delete connection');
  const confirmationTitle = mayAbandon
    ? props.t('plugins.channels.surface.acceptPossibleLossConfirmTitle', 'Accept possible loss?')
    : props.t('plugins.channels.surface.connectionDeleteConfirmTitle', 'Delete this connection?');
  const confirmationDescription = mayAbandon
    ? props.t(
      'plugins.channels.surface.acceptPossibleLossConfirmDescription',
      'This allows the connection lifecycle to continue without claiming the old physical transport stopped.',
    )
    : props.t(
      'plugins.channels.surface.connectionDeleteConfirmDescription',
      'This disables the connection and waits for exact transport-stop proof before cleanup.',
    );
  return (
    <Stack testID="channels-connection-lifecycle-controls" gap="small">
      {mayRepairEndpointRetarget ? (
        <Button
          testID="channels-connection-repair-endpoint"
          title={repairBusy
            ? props.t('plugins.channels.surface.repairingEndpointRetarget', 'Repairing…')
            : repairTitle}
          accessibilityLabel={repairTitle}
          busy={repairBusy}
          disabled={repairBusy
            || abandonAction.execution.status === 'outcomeUnknown'
            || confirmation.open}
          onPress={() => { void repairEndpointRetarget(); }}
        />
      ) : null}
      {mayRepairEndpointRetarget && abandonAction.execution.status === 'error' ? (
        <Banner
          testID="channels-connection-endpoint-repair-error"
          tone="warning"
          title={props.t(
            'plugins.channels.surface.endpointRepairFailedTitle',
            'Could not move the delivery target yet',
          )}
          description={endpointRetargetOwedDescription(props.t)}
          action={(
            <Action.Refresh
              title={props.t('plugins.channels.surface.refresh', 'Refresh')}
              onRefresh={props.onRefresh}
            />
          )}
        />
      ) : null}
      <Button
        testID={mayAbandon ? 'channels-connection-accept-loss' : 'channels-connection-delete'}
        title={busy
          ? mayAbandon
            ? props.t('plugins.channels.surface.acceptingPossibleLoss', 'Accepting…')
            : props.t('plugins.channels.surface.deleting', 'Deleting…')
          : title}
        accessibilityLabel={title}
        busy={busy}
        disabled={busy || outcomeUnknown || confirmation.open}
        focusTarget={confirmation.openerFocusTarget}
        onPress={confirmation.request}
      />
      {confirmation.open ? (
        <Stack testID="channels-connection-lifecycle-confirmation" gap="small">
          <Banner
            tone="danger"
            title={confirmationTitle}
            description={confirmationDescription}
          />
          <Button
            testID={mayAbandon
              ? 'channels-connection-accept-loss-confirm'
              : 'channels-connection-delete-confirm'}
            title={mayAbandon
              ? props.t(
                'plugins.channels.surface.acceptPossibleLossConfirm',
                'Confirm accepting possible loss',
              )
              : props.t('plugins.channels.surface.connectionDeleteConfirm', 'Confirm deletion')}
            disabled={busy || outcomeUnknown}
            focusTarget={confirmation.confirmationFocusTarget}
            onPress={() => { void confirm(); }}
          />
          <Button
            title={props.t('plugins.channels.surface.cancel', 'Cancel')}
            variant="plain"
            disabled={busy || outcomeUnknown}
            onPress={confirmation.dismiss}
          />
        </Stack>
      ) : null}
      {activeAction.execution.status === 'error' ? (
        <Banner
          testID="channels-connection-lifecycle-error"
          tone="danger"
          title={props.t(
            mayAbandon
              ? 'plugins.channels.surface.acceptLossFailedTitle'
              : 'plugins.channels.surface.deleteFailedTitle',
            mayAbandon ? 'Could not accept possible loss' : 'Could not start connection deletion',
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
  const providerDisplayName = usePluginBrandDisplayName(props.operation.contributor.pluginId)
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
        tone="info"
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
  const resolveProviderDisplayName = usePluginBrandDisplayNameResolver();
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
                  selectedTransport={selectedTransport}
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
          description={props.t(
            'plugins.channels.surface.pollRetryFailedDescription',
            'The blocked poll state may have changed. Refresh connection details before trying again.',
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
            tone="success"
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
            description={props.t(
              'plugins.channels.surface.connectionRetestFailedDescription',
              'The saved connection may have changed. Refresh connection details before trying again.',
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
function IngressAttentionControls(props: Readonly<{
  signal: AbortSignal;
  recoveryActionsAvailable: boolean;
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
  if (!initialLoading && rows.length === 0 && !canLoadMore && attentionRows.resource.error === undefined) {
    return (
      <EmptyState
        testID="channels-ingress-attention-empty"
        title={props.t(
          'plugins.channels.surface.ingressAttentionEmptyTitle',
          'No incoming messages need attention',
        )}
        description={props.t(
          'plugins.channels.surface.ingressAttentionEmptyDescription',
          'Incoming messages that need your action will appear here.',
        )}
      />
    );
  }

  return (
    <Stack testID="channels-ingress-attention-controls" gap="small">
      <Heading
        level={3}
        value={props.t('plugins.channels.surface.ingressAttentionTitle', 'Incoming messages need attention')}
      />
      <Text
        value={props.t(
          'plugins.channels.surface.ingressAttentionDescription',
          'Review saved incoming-message outcomes. Retry is available only for inputs that stopped before Happier could finish admitting them.',
        )}
      />

      {initialLoading ? (
        <Status
          testID="channels-ingress-attention-loading"
          tone="info"
          label={props.t('plugins.channels.surface.ingressAttentionLoading', 'Loading blocked inputs')}
          pulsing
        />
      ) : null}

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

      {!props.recoveryActionsAvailable && rows.some((row) => row.kind === 'blocked') ? (
        <Status
          testID="channels-ingress-attention-actions-unavailable"
          tone="warning"
          label={props.t(
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
        return (
          <Stack
            key={rowId}
            testID={`channels-ingress-attention-${rowId}`}
            gap="small"
          >
            {row.kind === 'occurrenceConflict' ? (
              <Status
                tone="danger"
                label={props.t(
                  'plugins.channels.surface.ingressAttentionOccurrenceConflict',
                  'An incoming occurrence has contradictory evidence.',
                )}
              />
            ) : row.kind === 'terminal' ? (
              <Status
                tone="warning"
                label={props.t(
                  row.category === 'recoverable'
                    ? 'plugins.channels.surface.ingressAttentionTerminalRecoverable'
                    : 'plugins.channels.surface.ingressAttentionTerminal',
                  row.category === 'recoverable'
                    ? 'An incoming message is waiting for its connection or target to be reachable again.'
                    : 'An incoming message was not accepted.',
                )}
              />
            ) : (
              <Status
                tone="danger"
                label={`${props.t(
                  'plugins.channels.surface.ingressAttentionAttemptCountPrefix',
                  'Retry stopped after',
                )} ${row.attemptCount} ${props.t(
                  row.attemptCount === 1
                    ? 'plugins.channels.surface.ingressAttentionAttemptCountSingular'
                    : 'plugins.channels.surface.ingressAttentionAttemptCountPlural',
                  row.attemptCount === 1 ? 'attempt' : 'attempts',
                )}`}
              />
            )}
            {row.kind === 'blocked' && props.recoveryActionsAvailable ? (
              <Button
                testID={`channels-ingress-attention-retry-${row.obligationId}`}
                title={busy
                  ? props.t('plugins.channels.surface.ingressAttentionRetrying', 'Retrying saved input…')
                  : props.t('plugins.channels.surface.ingressAttentionRetry', 'Retry saved input')}
                accessibilityLabel={props.t('plugins.channels.surface.ingressAttentionRetry', 'Retry saved input')}
                busy={busy}
                disabled={actionUnavailable}
                onPress={() => retry(row)}
              />
            ) : null}
          </Stack>
        );
      })}

      {canLoadMore ? (
        <Button
          testID="channels-ingress-attention-load-more"
          title={props.t('plugins.channels.surface.ingressAttentionLoadMore', 'Show more blocked inputs')}
          variant="secondary"
          busy={loading}
          disabled={loading || actionUnavailable}
          onPress={attentionRows.loadMore}
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

/**
 * This present-user surface intentionally offers only the two terminal
 * decisions the custody owner supports. It never reopens or resends the
 * retained delivery from the management client.
 */
function ConnectionDeliveryResolutionControls(props: Readonly<{
  connection: ChannelsConnection;
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
      const settled = await action.execute({
        custodyId: row.custodyId,
        expectedRevision: row.revision,
        resolution,
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
  }, [action.execute, actionUnavailable, deliveryRows, props.onRefresh]);

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
  const loading = deliveryRows.resource.pending !== 'idle';
  const initialLoading = deliveryRows.rows === undefined && loading;
  const canLoadMore = deliveryRows.nextCursor !== undefined;
  const unknownOutcomeDescription = props.t(
    'plugins.channels.surface.deliveryResolutionUnknownDescription',
    'The decision may already be saved. Refresh delivery details before making another choice.',
  );
  // The privacy-safe delivery projection carries no endpoint or content label,
  // so each row's controls are named by the delivery's short custody identity;
  // two ambiguous deliveries otherwise present identical button names.
  const deliveryRowName = (custodyId: string): string =>
    `${props.t('plugins.channels.surface.deliveryResolutionTitle', 'Resolve delivery outcome')} — ${shortRowIdentity(custodyId)}`;
  return (
    <Stack testID="channels-delivery-resolution-controls" gap="small">
      <Heading
        level={3}
        value={props.t('plugins.channels.surface.deliveryResolutionTitle', 'Resolve delivery outcome')}
      />
      <Text
        value={props.t(
          'plugins.channels.surface.deliveryResolutionDescription',
          'Review each delivery that may already have had an external effect. Happier will not send it again automatically.',
        )}
      />

      {initialLoading ? (
        <Status
          testID="channels-delivery-resolution-loading"
          tone="info"
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

      {rows.map((row) => {
        const busy = action.execution.status === 'pending' && activeCustodyId === row.custodyId;
        // An archive-recoverable delivery is not ambiguous: the provider proved
        // it had no effect and reported that the owner may unarchive and retry.
        // It therefore offers the recovery decision instead of the two terminal
        // settlements, which exist only for a possible external effect.
        if (row.state === 'archiveRecoverable') {
          return (
            <Stack
              key={row.custodyId}
              testID={`channels-delivery-resolution-${row.custodyId}`}
              gap="small"
            >
              <Status
                tone="warning"
                label={props.t(
                  'plugins.channels.surface.deliveryResolutionArchived',
                  'Not sent: the destination is archived',
                )}
              />
              <Button
                testID={`channels-delivery-resolution-retry-${row.custodyId}`}
                title={busy
                  ? props.t('plugins.channels.surface.deliveryResolutionRetrying', 'Retrying…')
                  : props.t(
                    'plugins.channels.surface.deliveryResolutionRetryAfterUnarchive',
                    'Unarchived it — send again',
                  )}
                accessibilityLabel={`${props.t(
                  'plugins.channels.surface.deliveryResolutionRetryAfterUnarchive',
                  'Unarchived it — send again',
                )} (${deliveryRowName(row.custodyId)})`}                busy={busy}
                disabled={actionUnavailable}
                onPress={() => resolve(row, 'retryAfterUnarchive')}
              />
            </Stack>
          );
        }
        const label = row.state === 'partial'
          ? props.t('plugins.channels.surface.deliveryResolutionPartial', 'Partly sent')
          : props.t('plugins.channels.surface.deliveryResolutionOutcomeUnknown', 'Outcome unknown');
        return (
          <Stack
            key={row.custodyId}
            testID={`channels-delivery-resolution-${row.custodyId}`}
            gap="small"
          >
            <Status tone="danger" label={label} />
            <Button
              testID={`channels-delivery-resolution-accept-${row.custodyId}`}
              title={busy && activeCustodyId === row.custodyId
                ? props.t('plugins.channels.surface.deliveryResolutionAccepting', 'Accepting…')
                : props.t('plugins.channels.surface.deliveryResolutionAccept', 'Accept as sent')}
              accessibilityLabel={`${props.t(
                'plugins.channels.surface.deliveryResolutionAccept',
                'Accept as sent',
              )} (${deliveryRowName(row.custodyId)})`}
              busy={busy}
              disabled={actionUnavailable}
              onPress={() => resolve(row, 'accepted')}
            />
            <Button
              testID={`channels-delivery-resolution-discard-${row.custodyId}`}
              title={busy && activeCustodyId === row.custodyId
                ? props.t('plugins.channels.surface.deliveryResolutionDiscarding', 'Discarding…')
                : props.t('plugins.channels.surface.deliveryResolutionDiscard', 'Discard delivery')}
              variant="secondary"
              accessibilityLabel={`${props.t(
                'plugins.channels.surface.deliveryResolutionDiscard',
                'Discard delivery',
              )} (${deliveryRowName(row.custodyId)})`}
              busy={busy}
              disabled={actionUnavailable}
              onPress={() => resolve(row, 'discarded')}
            />
          </Stack>
        );
      })}

      {!initialLoading && rows.length === 0 && !canLoadMore && deliveryRows.resource.error === undefined ? (
        <Status
          testID="channels-delivery-resolution-empty"
          tone="info"
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
  const providerDisplayName = usePluginBrandDisplayName(props.operation.contributor.pluginId)
    ?? props.t('plugins.channels.surface.providerFallback', 'Integration provider');
  const testIdSuffix = `${props.operation.contributor.pluginId}-${props.operation.contributor.contributionId}`;
  return (
    <Button
      testID={`channels-provider-setup-${testIdSuffix}`}
      variant="secondary"
      title={`${props.t('plugins.channels.surface.providerSetupAction', 'Set up')} ${providerDisplayName}`}
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
 * A selected provider Action must be executed with its exact host-issued
 * Action object. The mounted client associates that object with the selected
 * Connected Account/currentness carrier; rebuilding a reference here would
 * lose that association and create a second authority path.
 */
function ProviderSetupRemediationExecution(props: Readonly<{
  selection: SelectedProviderSetupRemediationActionInput;
  signal: AbortSignal;
  onSettled: (settled: PluginActionExecution) => Promise<void>;
}>): React.ReactElement | null {
  const action = useExecutePluginAction(props.selection.result.action);
  const startedRef = React.useRef(false);

  React.useEffect(() => {
    if (startedRef.current || props.signal.aborted) return;
    startedRef.current = true;
    void action.execute(props.selection.result.input, { signal: props.signal }).then((settled) => {
      void props.onSettled(settled);
    });
  }, [action.execute, props.onSettled, props.selection.result.input, props.signal]);

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
  const resolveProviderDisplayName = usePluginBrandDisplayNameResolver();
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
            maximumObservationAgeMs: String(CONVERSATION_OBSERVATION_AGE_MS_FOR_OMITTED_FIELD_V1),
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
      <Heading
        level={3}
        value={props.t('plugins.channels.surface.providerSetupTitle', 'Add a conversation provider')}
      />
      <Text
        value={props.t(
          'plugins.channels.surface.providerSetupDescription',
          'Choose an installed provider to begin setup.',
        )}
      />
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
          description={props.t(
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
      {feedback === 'ready' ? (
        <Status
          testID="channels-provider-setup-ready"
          tone="success"
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
            selectedTransport={preparedConnection.selectedTransport}
            accountEncryptionMode={surface.accountEncryptionMode}
            testID="channels-provider-setup-review"
            t={props.t}
          />
          {preparedConnection.setupGuidance === undefined ? null : (
            <Stack gap="small" testID="channels-provider-setup-guidance">
              <Heading
                level={4}
                value={props.t(
                  'plugins.channels.surface.providerSetupRemediationTitle',
                  'Finish provider setup',
                )}
              />
              <Text value={preparedConnection.setupGuidance.requiredPermissionsLabel} />
              <Link
                testID="channels-provider-setup-guidance-link"
                title={props.t(
                  'plugins.channels.surface.providerSetupRemediationAction',
                  'Resolve provider setup',
                )}
                url={preparedConnection.setupGuidance.externalUrl}
                disabled={actionUnavailable}
              />
            </Stack>
          )}
          <Form.Field
            label={props.t('plugins.channels.surface.transport', 'Transport')}
            description={props.t(
              'plugins.channels.surface.providerSetupTransportDescription',
              'Choose how Happier will receive conversation updates from this provider.',
            )}
            disabled={actionUnavailable}
          >
            <Form.Select
              testID="channels-provider-setup-transport"
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
          </Form.Field>
          <Form.Field
            label={props.t('plugins.channels.surface.maximumObservationAge', 'Maximum observation age')}
            description={props.t(
              'plugins.channels.surface.maximumObservationAgeDescription',
              'Accept incoming observations no older than this limit.',
            )}
            disabled={actionUnavailable}
            issue={createValidationIssue}
          >
            <Form.Select
              testID="channels-provider-setup-observation-age"
              label={props.t(
                'plugins.channels.surface.maximumObservationAgeInput',
                'How long incoming messages stay eligible',
              )}
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
          </Form.Field>
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

function ConnectionsContent(props: Readonly<{
  connections: readonly ChannelsConnection[];
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
  const expandedConnection = props.expandedConnectionId === undefined
    ? undefined
    : props.connections.find((connection) => connection.connectionId === props.expandedConnectionId);
  const hasExpandedConnection = expandedConnection !== undefined;
  const onLifecycleSettled = React.useCallback((connectionId: string) => {
    setPendingDeletedConnectionId(connectionId);
    setAnnounceDeletedConnection(false);
  }, []);

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

  return (
    <Stack gap="large">
      <Heading level={2} value={props.t('plugins.channels.surface.connections', 'Conversation connections')} />
      {announceDeletedConnection ? (
        <Status
          testID="channels-connection-deleted-announcement"
          tone="success"
          label={props.t('plugins.channels.surface.connectionDeleted', 'Connection deleted.')}
        />
      ) : null}

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
            tone="success"
            label={props.t(
              'plugins.channels.surface.connectionCreatedAwaitingBinding',
              'Connection created. Add the conversation it should deliver to.',
            )}
          />
          <Button
            testID="channels-connection-created-continue-open"
            title={props.t('plugins.channels.surface.bindingCreateAction', 'Create binding')}
            onPress={() => {
              if (props.createdConnectionId !== undefined) {
                props.onContinueCreatedConnection?.(props.createdConnectionId);
              }
            }}
          />
        </Stack>
      )}

      {!hasExpandedConnection ? (
        <>
          <Action.Refresh
            testID="channels-resource-refresh"
            title={props.t('plugins.channels.surface.refresh', 'Refresh')}
            onRefresh={props.onRefresh}
          />
          <ResourceFreshnessNotice resource={props.resource} onRefresh={props.onRefresh} t={props.t} />
        </>
      ) : null}

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
          {props.connections.map((connection) => (
            props.accountLocalPolicy === undefined ? (
              <ConnectionRow
                key={connection.connectionId}
                connection={connection}
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
                expanded={connection.connectionId === props.expandedConnectionId}
                signal={props.signal}
                resource={props.resource}
                onCommitted={props.accountLocalPolicy.onCommitted}
                onExpand={() => props.onExpand(connection.connectionId)}
                onRefresh={props.onRefresh}
                t={props.t}
              />
            )
          ))}
        </List>
      )}
    </Stack>
  );
}

/**
 * The daemon-served reading both Channels destinations share: the two live
 * Account Resources, parsed once, with each section's own availability.
 */
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
  const presentations = React.useMemo(
    () => buildBindingPresentations(
      parsedBindings?.kind === 'ready' ? parsedBindings.bindings : [],
      connections,
      t,
    ),
    [connections, parsedBindings, t],
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
  const bindingCount = channels.presentations.length;

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
          <ItemGroup
            testID="channels-settings-conversations"
            surface="none"
            title={t('plugins.channels.settings.conversations', 'Linked conversations')}
            description={bindingCount === 0
              ? t('plugins.channels.settings.conversationsNone', 'No conversation is linked yet.')
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
            t={t}
          />
          <ConnectionsContent
            connections={channels.connections}
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
  const location = React.useMemo(() => readChannelsPageLocation(props.subPath), [props.subPath]);
  return (
    <OnlineBindingsContent
      presentations={channels.presentations}
      resource={channels.bindingsResource}
      sectionState={channels.bindingsSectionState}
      onRefresh={channels.refreshBindings}
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

function SessionProjectionGapRecoveryAction(props: Readonly<{
  attention: ConversationSessionBindingAttentionV1;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement {
  const action = useExecutePluginAction(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.sessionProjectionBaselineAccept,
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
        testID={`channels-session-transcript-baseline-accept:${props.attention.bindingId}`}
        variant="secondary"
        title={busy
          ? props.t('plugins.channels.session.transcriptBaselineAccepting', 'Accepting baseline…')
          : props.t('plugins.channels.session.continueFromHere', 'Continue from here')}
        accessibilityLabel={props.t(
          'plugins.channels.session.transcriptBaselineAccept',
          'Continue from current transcript',
        )}
        busy={busy}
        disabled={busy || action.execution.status === 'outcomeUnknown'}
        onPress={() => { void accept(); }}
      />
      {action.execution.status === 'error' || action.execution.status === 'outcomeUnknown' ? (
        <Status
          tone="warning"
          label={props.t(
            'plugins.channels.session.transcriptBaselineUnconfirmed',
            'Could not confirm the new transcript baseline',
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

/** A reply time as the pane says it: the time today, the weekday this week, else the date. */
function formatSessionReplyTime(atMs: number, locale: string, nowMs = Date.now()): string {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  if (at.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
  }
  if (nowMs - atMs < 6 * 86_400_000 && nowMs >= atMs) {
    return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(at);
  }
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(at);
}

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
  const [confirmingUnlink, setConfirmingUnlink] = React.useState(false);
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

  if (confirmingUnlink) {
    return (
      <Stack gap="small" testID={`channels-session-conversation-unlink-confirm:${binding.bindingId}`}>
        <Text
          variant="caption"
          tone="secondary"
          value={t(
            'plugins.channels.session.unlinkConfirm',
            '{name} stops talking to this session. The chat itself is not changed.',
            { name: title },
          )}
        />
        <Row gap="small" align="center">
          <Button
            variant="destructive"
            title={t('plugins.channels.session.unlink', 'Unlink')}
            busy={remove.execution.status === 'pending'}
            onPress={() => unlink()}
          />
          <Button
            variant="plain"
            title={t('plugins.channels.session.cancel', 'Cancel')}
            onPress={() => { setConfirmingUnlink(false); }}
          />
        </Row>
      </Stack>
    );
  }
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
          onPress={() => { setConfirmingUnlink(true); }}
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
      ...(connectionStatus(connection, t).tone === 'success' ? {} : { tone: 'warning' as const }),
    }]),
    ...(lastDelivery === undefined ? [] : [{
      label: t('plugins.channels.session.lastReply', 'Last reply'),
      value: lastDelivery.outcome === 'notDelivered'
        ? t('plugins.channels.session.lastReplyNotDelivered', 'Not delivered · {time}', { time: formatSessionReplyTime(lastDelivery.atMs, locale) })
        : lastDelivery.outcome === 'pending'
          ? t('plugins.channels.session.lastReplySending', 'Sending · {time}', { time: formatSessionReplyTime(lastDelivery.atMs, locale) })
          : formatSessionReplyTime(lastDelivery.atMs, locale),
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
  const resolveProviderDisplayName = usePluginBrandDisplayNameResolver();
  const title = bindingEndpointLabel(binding, t);
  const subtitle = connection === undefined
    ? bindingAudienceLabel(binding.endpoint.audience, t)
    : `${resolveProviderDisplayName(connection.providerPluginId) ?? t('plugins.channels.surface.providerFallback', 'Integration provider')} · ${connectionLabel(connection)}`;
  const attention = row.group === 'need' ? row.attention : undefined;
  const { locale } = useSurfaceContext();
  // The trailing time is the latest reply sent (lab XA); a paused conversation shows none.
  const lastReply = row.group === 'paused' || row.lastDelivery === undefined
    ? undefined
    : formatSessionReplyTime(row.lastDelivery.atMs, locale);
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
            <Text variant="caption" tone="warning" value={sessionBindingAttentionTitle(attention.reason, t)} />
          </Row>
          {attention.reason === 'transcriptHistoryGap'
            ? <SessionProjectionGapRecoveryAction attention={attention} onRefresh={props.onRefresh} t={t} />
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
  const resolveProviderDisplayName = usePluginBrandDisplayNameResolver();
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
  const bots = (props.connections ?? []).filter((connection) => connection.deletionState === 'none');
  return (
    <EmptyState
      testID="channels-session-conversations-empty"
      icon="conversations"
      title={t('plugins.channels.session.emptyInviteTitle', 'Talk to this session from your chats')}
      description={t(
        'plugins.channels.session.emptyInviteDescription',
        'Link a Telegram, Discord or GitHub conversation to this session. Messages arrive here, and replies go back.',
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
    ? <AccountLocalChannelsPageSurface signal={props.signal} subPath={props.subPath} />
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

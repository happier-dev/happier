import * as React from 'react';
import type { ResourceContent } from '@happier-dev/plugin-sdk/ui';
import {
  useLivePluginResource,
  usePluginUiDataClient,
  type PluginUiAccountCollectionForDefinition,
  type PluginUiResourceSnapshot,
} from '@happier-dev/plugin-ui';
import {
  CONVERSATION_CORE_PLUGIN_ID_V1,
  MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
  MAX_CONVERSATION_OBSERVATION_AGE_MS,
  MIN_CONVERSATION_OBSERVATION_AGE_MS,
  conversationSessionBindingDeliveryModeForOmittedFieldV1,
} from '@happier-dev/channels-protocol/v1';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
} from '../collections.js';
import {
  readConversationBindingManagementRows,
  readConversationConnectionManagementRows,
  type ConversationBindingManagementRow,
  type ConversationConnectionManagementRow,
} from '../accountLocalBindingPolicy.js';
import {
  readConversationConnectionPollFailureAttention,
  type ConversationConnectionPollFailureAttentionV1,
} from '../connectionPollFailure.js';
import { readConversationOutwardDeliveryConnectionAttention } from '../outwardDelivery.js';

/**
 * The Channels UI's one reading of its two Account-wide rows — conversation
 * bindings and bot connections — shared by every Channels artifact: the
 * Settings page, the Channels page, its column and its Home widget.
 *
 * It holds the Resource parsers, the direct Account-Collection readers for a
 * mount the daemon cannot serve, and the row labels and statuses every surface
 * shows, so the column, the widget and the page can never disagree about what
 * a row is called or whether it needs attention.
 */

export const CHANNELS_CONNECTIONS_RESOURCE = {
  pluginId: CONVERSATION_CORE_PLUGIN_ID_V1,
  localId: 'connections-v1',
} as const;

export const CHANNELS_BINDINGS_RESOURCE = {
  pluginId: CONVERSATION_CORE_PLUGIN_ID_V1,
  localId: 'bindings-v1',
} as const;

export type ConnectionTransport = ConversationConnectionManagementRow['selectedTransport'];
export type ConnectionDeletionState = ConversationConnectionManagementRow['deletionState'];
export type ConnectionHistoryGapReason = NonNullable<
  ConversationConnectionManagementRow['attention']['historyGap']
>['reason'];
export type ConnectionProviderReadiness = ConversationConnectionManagementRow['attention']['providerReadiness'];
export type ConnectionIngressConflict = ConversationConnectionManagementRow['attention']['ingressConflict'];
export type ConnectionPollFailure = ConversationConnectionPollFailureAttentionV1;
export type ConnectionOutwardDeliveryAttention = Readonly<{
  retryDue: boolean;
  notDelivered: boolean;
  partial: boolean;
  outcomeUnknown: boolean;
  archiveRecovery: boolean;
}>;

export type ChannelsConnection = Readonly<
  Omit<ConversationConnectionManagementRow, 'attention'>
  & Readonly<{
    attention: ConversationConnectionManagementRow['attention'] & Readonly<{
      outwardDelivery: ConnectionOutwardDeliveryAttention;
    }>;
  }>
>;

export type BindingEndpointAudience = ConversationBindingManagementRow['endpoint']['audience'];
export type BindingTargetKind = ConversationBindingManagementRow['target']['kind'];
export type BindingInputMode = ConversationBindingManagementRow['inputMode'];
export type BindingDeliveryMode = ConversationBindingManagementRow['deliveryMode'];
/** The delivery modes a Session target can actually carry, as the target contract declares them. */
export type BindingSessionDeliveryMode = ReturnType<typeof conversationSessionBindingDeliveryModeForOmittedFieldV1>;
export type BindingDeletionState = ConversationBindingManagementRow['deletionState'];
export type BindingApproval = ConversationBindingManagementRow['approval'];

export type ChannelsBinding = ConversationBindingManagementRow;

export type ParsedConnections =
  | Readonly<{ kind: 'ready'; connections: readonly ChannelsConnection[] }>
  | Readonly<{
    kind: 'invalid';
    reason: 'contentType' | 'invalidJson' | 'shape' | 'connection';
  }>;

export type ParsedBindings =
  | Readonly<{ kind: 'ready'; bindings: readonly ChannelsBinding[] }>
  | Readonly<{
    kind: 'invalid';
    reason: 'contentType' | 'invalidJson' | 'shape' | 'binding';
  }>;

/**
 * The mounted host's resolver, narrowed to the two arguments this surface
 * always supplies plus the canonical interpolation values. Unit words, order
 * and spacing therefore stay inside the translated message instead of being
 * concatenated here.
 */
export type Translate = (
  key: string,
  fallback: string,
  values?: Readonly<Record<string, string | number>>,
) => string;
export type ResourcePresentation = Readonly<{
  pending: 'idle' | 'initial' | 'refresh';
  freshness: 'unknown' | 'fresh' | 'stale';
  subscription: 'unsupported' | 'establishing' | 'live' | 'reconnecting' | 'ended';
  error?: Readonly<{ message: string }>;
}>;

export type ChannelStateCollection = PluginUiAccountCollectionForDefinition<typeof CHANNEL_STATE_COLLECTION>;
export type ChannelDeliveriesCollection = PluginUiAccountCollectionForDefinition<
  typeof CHANNEL_DELIVERIES_COLLECTION
>;

export type AccountLocalBindingReadState = Readonly<{
  bindings?: readonly ChannelsBinding[];
  resource: ResourcePresentation;
}>;
export type AccountLocalConnectionReadState = Readonly<{
  connections?: readonly ChannelsConnection[];
  resource: ResourcePresentation;
}>;

export const ACCOUNT_LOCAL_BINDING_INITIAL_STATE: AccountLocalBindingReadState = Object.freeze({
  resource: Object.freeze({
    pending: 'initial',
    freshness: 'unknown',
    subscription: 'unsupported',
  }),
});

export const ACCOUNT_LOCAL_CONNECTION_INITIAL_STATE: AccountLocalConnectionReadState = Object.freeze({
  resource: Object.freeze({
    pending: 'initial',
    freshness: 'unknown',
    subscription: 'unsupported',
  }),
});


export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isValidObservationAge(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= MIN_CONVERSATION_OBSERVATION_AGE_MS
    && value <= MAX_CONVERSATION_OBSERVATION_AGE_MS;
}

export function isConnectionTransport(value: unknown): value is ConnectionTransport {
  return value === 'checkpointedPull' || value === 'socket' || value === 'durablePush';
}

export function isConnectionDeletionState(value: unknown): value is ConnectionDeletionState {
  return value === 'none' || value === 'pendingStopReconciliation' || value === 'finalizingDelete';
}

export function isHistoryGapReason(value: unknown): value is ConnectionHistoryGapReason {
  return value === 'providerHistoryUnavailable' || value === 'applicationAdmissionLost';
}

export function parseHistoryGap(value: unknown): ChannelsConnection['attention']['historyGap'] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const reportedAt = value.reportedAt;
  const reason = value.reason;
  if (!isPositiveSafeInteger(reportedAt) || !isHistoryGapReason(reason)) return undefined;
  return { reportedAt, reason };
}

export function parseProviderReadiness(value: unknown): ConnectionProviderReadiness | undefined {
  // Older retained connection Resources predate this generic attention field.
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return undefined;
  const code = value.code;
  const diagnostic = value.diagnostic;
  if ((code !== 'providerPermissionMissing'
    && code !== 'providerConfigurationInvalid'
    && code !== 'providerCredentialInvalid')
    || (diagnostic !== undefined && !isNonEmptyString(diagnostic))) {
    return undefined;
  }
  return {
    code,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

export function parseIngressConflict(value: unknown): ConnectionIngressConflict | undefined {
  // Older Resources cannot derive this V2 census fact, so absence carries no
  // conflict rather than making the whole settings projection unusable.
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || value.kind !== 'occurrenceEvidenceMismatch' || Object.keys(value).length !== 1) {
    return undefined;
  }
  return { kind: 'occurrenceEvidenceMismatch' };
}

/** The Resource emits this derived custody field for every connection row. */
export function parseOutwardDeliveryAttention(value: unknown): ConnectionOutwardDeliveryAttention | undefined {
  if (!isRecord(value)
    || typeof value.retryDue !== 'boolean'
    || typeof value.notDelivered !== 'boolean'
    || typeof value.partial !== 'boolean'
    || typeof value.outcomeUnknown !== 'boolean') {
    return undefined;
  }
  return {
    retryDue: value.retryDue,
    notDelivered: value.notDelivered,
    partial: value.partial,
    outcomeUnknown: value.outcomeUnknown,
    // Tolerated as absent: a Resource produced before archive recovery was
    // surfaced simply offers no recoverable delivery.
    archiveRecovery: value.archiveRecovery === true,
  };
}

/**
 * The provider-authenticated shared-endpoint delivery truth, as projected.
 * `undefined` means the provider declared no restriction; an unrecognized
 * value fails the connection closed rather than silently widening the offer.
 */
export function parseSharedEndpointInputModes(
  value: unknown,
): readonly BindingInputMode[] | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return 'invalid';
  if (!value.every(isBindingInputMode)) return 'invalid';
  return value;
}

export function parseConnection(value: unknown): ChannelsConnection | undefined {
  if (!isRecord(value) || !isRecord(value.attention)) return undefined;
  const historyGap = parseHistoryGap(value.attention.historyGap);
  const providerReadiness = parseProviderReadiness(value.attention.providerReadiness);
  const ingressConflict = parseIngressConflict(value.attention.ingressConflict);
  const pollFailure = readConversationConnectionPollFailureAttention(value.attention.pollFailure);
  const outwardDelivery = parseOutwardDeliveryAttention(value.attention.outwardDelivery);
  const connectionId = value.connectionId;
  const revision = value.revision;
  const authorityEpoch = value.authorityEpoch;
  const providerPluginId = value.providerPluginId;
  const selectedMachineId = value.selectedMachineId;
  const selectedTransport = value.selectedTransport;
  const integrationPrincipalLabel = value.integrationPrincipalLabel;
  const enabled = value.enabled;
  const deletionState = value.deletionState;
  const maximumObservationAgeMs = value.maximumObservationAgeMs;
  const sharedEndpointInputModes = parseSharedEndpointInputModes(value.sharedEndpointInputModes);
  const bestEffortBeforeDurableAdmission = value.attention.bestEffortBeforeDurableAdmission;
  const oldTransportStopUnconfirmed = value.attention.oldTransportStopUnconfirmed;
  const endpointRetargetOwed = value.attention.endpointRetargetOwed;
  const acceptedPossibleLoss = value.attention.acceptedPossibleLoss;
  if (historyGap === undefined
    || providerReadiness === undefined
    || ingressConflict === undefined
    || pollFailure === undefined
    || outwardDelivery === undefined
    || !isNonEmptyString(connectionId)
    || !isPositiveSafeInteger(revision)
    || !isPositiveSafeInteger(authorityEpoch)
    || !isNonEmptyString(providerPluginId)
    || !isNonEmptyString(selectedMachineId)
    || !isConnectionTransport(selectedTransport)
    || !isConnectionDeletionState(deletionState)
    || !isValidObservationAge(maximumObservationAgeMs)
    || typeof enabled !== 'boolean'
    || typeof bestEffortBeforeDurableAdmission !== 'boolean'
    || typeof oldTransportStopUnconfirmed !== 'boolean'
    || typeof endpointRetargetOwed !== 'boolean'
    || typeof acceptedPossibleLoss !== 'boolean'
    || (acceptedPossibleLoss && !oldTransportStopUnconfirmed)
    || (endpointRetargetOwed && !oldTransportStopUnconfirmed)
    || sharedEndpointInputModes === 'invalid'
    || (integrationPrincipalLabel !== undefined && !isNonEmptyString(integrationPrincipalLabel))) {
    return undefined;
  }
  return {
    connectionId,
    revision,
    authorityEpoch,
    providerPluginId,
    selectedMachineId,
    selectedTransport,
    ...(integrationPrincipalLabel === undefined ? {} : { integrationPrincipalLabel }),
    ...(sharedEndpointInputModes === undefined ? {} : { sharedEndpointInputModes }),
    enabled,
    deletionState,
    maximumObservationAgeMs,
    attention: {
      historyGap,
      providerReadiness,
      ingressConflict,
      pollFailure,
      bestEffortBeforeDurableAdmission,
      oldTransportStopUnconfirmed,
      endpointRetargetOwed,
      acceptedPossibleLoss,
      outwardDelivery,
    },
  };
}

/** The Resource producer owns its row schema; this is a fail-closed UI boundary parser. */
export function parseConnectionsResource(resource: ResourceContent): ParsedConnections {
  if (resource.contentType !== 'application/json') {
    return { kind: 'invalid', reason: 'contentType' };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(resource.bytes));
  } catch {
    return { kind: 'invalid', reason: 'invalidJson' };
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.connections)) {
    return { kind: 'invalid', reason: 'shape' };
  }

  const connections: ChannelsConnection[] = [];
  for (const candidate of decoded.connections) {
    const connection = parseConnection(candidate);
    if (connection === undefined) return { kind: 'invalid', reason: 'connection' };
    connections.push(connection);
  }
  return { kind: 'ready', connections };
}

export function isBindingEndpointAudience(value: unknown): value is BindingEndpointAudience {
  return value === 'direct' || value === 'shared';
}

export function isBindingTargetKind(value: unknown): value is BindingTargetKind {
  return value === 'session' || value === 'automation';
}

export function isBindingInputMode(value: unknown): value is BindingInputMode {
  return value === 'directMentionsOnly' || value === 'addressedMessages' || value === 'allAllowedMessages';
}

export function isBindingDeliveryMode(value: unknown): value is BindingDeliveryMode {
  return value === 'repliesOnly'
    || value === 'mirrorSession'
    || value === 'finalResult'
    || value === 'none';
}

export function isBindingDeletionState(value: unknown): value is BindingDeletionState {
  return value === 'none' || value === 'finalizingDelete';
}

export function deliveryModeMatchesTarget(
  targetKind: BindingTargetKind,
  deliveryMode: BindingDeliveryMode,
): boolean {
  return targetKind === 'session'
    ? deliveryMode === 'repliesOnly' || deliveryMode === 'mirrorSession'
    : deliveryMode === 'finalResult' || deliveryMode === 'none';
}

export function parseBindingApproval(
  value: unknown,
  targetKind: BindingTargetKind,
): BindingApproval | undefined {
  if (!isRecord(value)) return undefined;
  if (targetKind === 'automation') {
    return value.kind === 'notApplicable' ? { kind: 'notApplicable' } : undefined;
  }
  if (value.kind === 'off') return { kind: 'off' };
  if (value.kind === 'enabled'
    && (value.maximumScope === 'request' || value.maximumScope === 'session')) {
    return { kind: 'enabled', maximumScope: value.maximumScope };
  }
  return undefined;
}

export function parseBinding(value: unknown): ChannelsBinding | undefined {
  if (!isRecord(value) || !isRecord(value.endpoint) || !isRecord(value.target)) return undefined;
  const bindingId = value.bindingId;
  const revision = value.revision;
  const connectionId = value.connectionId;
  const audience = value.endpoint.audience;
  const endpointLabel = value.endpoint.label;
  const targetKind = value.target.kind;
  const targetSummary = value.target.summary;
  const inputMode = value.inputMode;
  const deliveryMode = value.deliveryMode;
  const deletionState = value.deletionState;
  if (!isNonEmptyString(bindingId)
    || !isPositiveSafeInteger(revision)
    || !isNonEmptyString(connectionId)
    || !isBindingEndpointAudience(audience)
    || (endpointLabel !== undefined && typeof endpointLabel !== 'string')
    || !isBindingTargetKind(targetKind)
    || !isNonEmptyString(targetSummary)
    || !isBindingInputMode(inputMode)
    || !isBindingDeliveryMode(deliveryMode)
    || !isBindingDeletionState(deletionState)
    || !deliveryModeMatchesTarget(targetKind, deliveryMode)) {
    return undefined;
  }
  const approval = parseBindingApproval(value.approval, targetKind);
  const enabled = value.enabled;
  if (approval === undefined || typeof enabled !== 'boolean') return undefined;
  return {
    bindingId,
    revision,
    connectionId,
    endpoint: {
      audience,
      ...(endpointLabel === undefined ? {} : { label: endpointLabel }),
    },
    target: { kind: targetKind, summary: targetSummary },
    inputMode,
    deliveryMode,
    approval,
    enabled,
    deletionState,
  };
}

export function parseBindingsValue(decoded: unknown): ParsedBindings {
  if (!isRecord(decoded) || !Array.isArray(decoded.bindings)) {
    return { kind: 'invalid', reason: 'shape' };
  }
  if (decoded.bindings.length > MAX_CONVERSATION_BINDINGS_PER_ACCOUNT) {
    return { kind: 'invalid', reason: 'binding' };
  }

  const bindings: ChannelsBinding[] = [];
  for (const candidate of decoded.bindings) {
    const binding = parseBinding(candidate);
    if (binding === undefined) return { kind: 'invalid', reason: 'binding' };
    bindings.push(binding);
  }
  return { kind: 'ready', bindings };
}

/** The Resource producer owns its row schema; this is a fail-closed UI boundary parser. */
export function parseBindingsResource(resource: ResourceContent): ParsedBindings {
  if (resource.contentType !== 'application/json') {
    return { kind: 'invalid', reason: 'contentType' };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(resource.bytes));
  } catch {
    return { kind: 'invalid', reason: 'invalidJson' };
  }
  return parseBindingsValue(decoded);
}


/**
 * Report that the exact Account Collection handles a direct reader is bound to
 * have been replaced.
 *
 * The host rebuilds this surface's Data client — and with it every Collection
 * handle — when its Account lifetime is replaced, so a replacement handle names
 * a different Account scope. Last-known-good rows, cursors, and freshness
 * belong to the handle they were read from and must be dropped synchronously
 * during render rather than presented as the successor's stale answer while its
 * first read is pending or failing.
 *
 * This is a render-phase reset of state the readers already own. It is not a
 * second Collection reader, cache, epoch, or Account authority: the Data client
 * remains the sole owner of admission, Account lifetime, and cancellation.
 */
export function useReplacedAccountCollectionScope(scope: readonly unknown[]): boolean {
  const [boundScope, setBoundScope] = React.useState(scope);
  const replaced = boundScope.length !== scope.length
    || boundScope.some((handle, index) => handle !== scope[index]);
  if (replaced) setBoundScope(scope);
  return replaced;
}

/**
 * The direct Account client retains collection admission, Account lifetime,
 * cancellation, and the authenticated transport. This surface retains only
 * presentation-local last-known-good rows while a requested reread is in
 * flight; it never becomes a second Collection query/cache owner.
 */
export function useAccountLocalBindingRows(
  collection: ChannelStateCollection,
  signal: AbortSignal,
  sessionId?: string,
): Readonly<AccountLocalBindingReadState & { refresh: () => void }> {
  const [refreshRevision, setRefreshRevision] = React.useState(0);
  const [state, setState] = React.useState<AccountLocalBindingReadState>(
    ACCOUNT_LOCAL_BINDING_INITIAL_STATE,
  );
  // A kept-mounted Session destination can change target without changing the Account handle.
  // Never present the prior Session's retained rows while the new filter is loading.
  if (useReplacedAccountCollectionScope([collection, sessionId])) {
    setState(ACCOUNT_LOCAL_BINDING_INITIAL_STATE);
  }

  React.useEffect(() => {
    let retired = false;
    setState((previous) => {
      const hasLastKnownGood = previous.bindings !== undefined;
      return {
        ...(hasLastKnownGood ? { bindings: previous.bindings } : {}),
        resource: {
          pending: hasLastKnownGood ? 'refresh' : 'initial',
          freshness: hasLastKnownGood ? 'stale' : 'unknown',
          subscription: 'unsupported',
        },
      };
    });

    void readConversationBindingManagementRows({ collection, signal, sessionId }).then(
      (result) => {
        if (retired || signal.aborted) return;
        setState({
          bindings: result.bindings,
          resource: {
            pending: 'idle',
            freshness: 'fresh',
            subscription: 'unsupported',
          },
        });
      },
      () => {
        if (retired || signal.aborted) return;
        setState((previous) => {
          const hasLastKnownGood = previous.bindings !== undefined;
          return {
            ...(hasLastKnownGood ? { bindings: previous.bindings } : {}),
            resource: {
              pending: 'idle',
              freshness: hasLastKnownGood ? 'stale' : 'unknown',
              subscription: 'unsupported',
              // The underlying Data diagnostic can include transport facts.
              // This consumer exposes only its stable user-facing state.
              error: { message: 'Account-local binding policy could not be read.' },
            },
          };
        });
      },
    );

    return () => {
      retired = true;
    };
  }, [collection, refreshRevision, sessionId, signal]);

  const refresh = React.useCallback(() => {
    setRefreshRevision((current) => current + 1);
  }, []);
  return React.useMemo(() => ({ ...state, refresh }), [refresh, state]);
}

/**
 * The offline surface retains only its presentation-local last known good
 * projection. The canonical Collection reader and delivery-custody reader
 * retain all data authority; no Resource, cache, or summary row is invented.
 */
export function useAccountLocalConnectionRows(input: Readonly<{
  stateCollection: ChannelStateCollection;
  deliveriesCollection: ChannelDeliveriesCollection;
  signal: AbortSignal;
}>): Readonly<AccountLocalConnectionReadState & { refresh: () => void }> {
  const [refreshRevision, setRefreshRevision] = React.useState(0);
  const [state, setState] = React.useState<AccountLocalConnectionReadState>(
    ACCOUNT_LOCAL_CONNECTION_INITIAL_STATE,
  );
  if (useReplacedAccountCollectionScope([input.stateCollection, input.deliveriesCollection])) {
    setState(ACCOUNT_LOCAL_CONNECTION_INITIAL_STATE);
  }

  React.useEffect(() => {
    let retired = false;
    setState((previous) => {
      const hasLastKnownGood = previous.connections !== undefined;
      return {
        ...(hasLastKnownGood ? { connections: previous.connections } : {}),
        resource: {
          pending: hasLastKnownGood ? 'refresh' : 'initial',
          freshness: hasLastKnownGood ? 'stale' : 'unknown',
          subscription: 'unsupported',
        },
      };
    });

    void readConversationConnectionManagementRows({
      collection: input.stateCollection,
      signal: input.signal,
    }).then(async (result) => {
      if (retired || input.signal.aborted) return;
      const deliveryAttention = await readConversationOutwardDeliveryConnectionAttention({
        deliveriesCollection: input.deliveriesCollection,
        connectionIds: result.connections.map((connection) => connection.connectionId),
        signal: input.signal,
      });
      if (retired || input.signal.aborted) return;
      if (deliveryAttention.kind !== 'ready') throw new Error('Connection delivery attention is unavailable.');
      const connections: ChannelsConnection[] = result.connections.map((connection) => {
        const outwardDelivery = deliveryAttention.attentionByConnection.get(connection.connectionId);
        if (outwardDelivery === undefined) throw new Error('Connection delivery attention is incomplete.');
        return {
          ...connection,
          attention: {
            ...connection.attention,
            outwardDelivery,
          },
        };
      });
      setState({
        connections,
        resource: {
          pending: 'idle',
          freshness: 'fresh',
          subscription: 'unsupported',
        },
      });
    }).catch(() => {
      if (retired || input.signal.aborted) return;
      setState((previous) => {
        const hasLastKnownGood = previous.connections !== undefined;
        return {
          ...(hasLastKnownGood ? { connections: previous.connections } : {}),
          resource: {
            pending: 'idle',
            freshness: hasLastKnownGood ? 'stale' : 'unknown',
            subscription: 'unsupported',
            error: { message: 'Account-local connection policy could not be read.' },
          },
        };
      });
    });

    return () => {
      retired = true;
    };
  }, [input.deliveriesCollection, input.signal, input.stateCollection, refreshRevision]);

  const refresh = React.useCallback(() => {
    setRefreshRevision((current) => current + 1);
  }, []);
  return React.useMemo(() => ({ ...state, refresh }), [refresh, state]);
}

/**
 * The collapsed connection row's name: the integration account label when the
 * provider supplies one, otherwise the connection's short identity instead of
 * repeating the provider name that the subtitle already states (two unlabeled
 * connections of one provider would otherwise be indistinguishable).
 */
export function connectionLabel(connection: ChannelsConnection): string {
  const principalLabel = connection.integrationPrincipalLabel?.trim();
  return principalLabel !== undefined && principalLabel !== ''
    ? principalLabel
    : shortRowIdentity(connection.connectionId);
}

export function providerReadinessLabel(
  providerReadiness: NonNullable<ConnectionProviderReadiness>,
  t: Translate,
): string {
  if (providerReadiness.code === 'providerPermissionMissing') {
    return t('plugins.channels.surface.providerPermissionMissing', 'Provider permission needs attention');
  }
  if (providerReadiness.code === 'providerCredentialInvalid') {
    return t('plugins.channels.surface.providerCredentialInvalid', 'Connected Account credential needs attention');
  }
  return t('plugins.channels.surface.providerConfigurationInvalid', 'Provider configuration needs attention');
}

/**
 * The bot's one status line, in the shared status vocabulary: what the reader must act on is
 * `attention`, a failure `danger`, healthy is quiet. `warning` stays only for system-owned
 * in-flight or retrying states and disclosures (deletion cleanup, a pending retry, best-effort
 * admission): cautions, not requests of the reader.
 */
export function connectionStatus(connection: ChannelsConnection, t: Translate) {
  if (connection.deletionState === 'pendingStopReconciliation') {
    return { tone: 'warning' as const, label: t('plugins.channels.surface.stopPending', 'Stop reconciliation pending') };
  }
  if (connection.deletionState === 'finalizingDelete') {
    return { tone: 'warning' as const, label: t('plugins.channels.surface.deleteFinalizing', 'Deletion cleanup in progress') };
  }
  if (connection.attention.historyGap !== null) {
    return { tone: 'danger' as const, label: t('plugins.channels.surface.historyGap', 'History gap needs attention') };
  }
  if (connection.attention.ingressConflict !== null) {
    return { tone: 'danger' as const, label: t('plugins.channels.surface.ingressOccurrenceConflict', 'Incoming occurrence conflict needs attention') };
  }
  if (connection.attention.providerReadiness !== null) {
    return { tone: 'attention' as const, label: providerReadinessLabel(connection.attention.providerReadiness, t) };
  }
  if (connection.attention.endpointRetargetOwed) {
    return { tone: 'attention' as const, label: t('plugins.channels.surface.endpointRetargetOwed', 'Delivery target needs repair') };
  }
  if (connection.attention.oldTransportStopUnconfirmed) {
    return { tone: 'warning' as const, label: t('plugins.channels.surface.oldTransportStopUnconfirmed', 'Old transport stop is unconfirmed') };
  }
  if (connection.attention.pollFailure?.phase === 'blocked') {
    return { tone: 'attention' as const, label: t('plugins.channels.surface.pollBlocked', 'Polling needs attention') };
  }
  if (connection.attention.pollFailure?.phase === 'retryDue') {
    return { tone: 'warning' as const, label: t('plugins.channels.surface.pollRetryDue', 'Polling will retry') };
  }
  if (connection.attention.outwardDelivery.outcomeUnknown) {
    return { tone: 'danger' as const, label: t('plugins.channels.surface.deliveryOutcomeUnknown', 'Delivery outcome needs attention') };
  }
  if (connection.attention.outwardDelivery.partial) {
    return { tone: 'danger' as const, label: t('plugins.channels.surface.deliveryPartial', 'Delivery was only partly sent') };
  }
  if (connection.attention.outwardDelivery.notDelivered) {
    return { tone: 'attention' as const, label: t('plugins.channels.surface.deliveryNotDelivered', 'Delivery was not sent') };
  }
  if (connection.attention.outwardDelivery.retryDue) {
    return { tone: 'warning' as const, label: t('plugins.channels.surface.deliveryRetryDue', 'Delivery is waiting to retry') };
  }
  // A paused connection is not delivering, so the live-admission disclosure
  // below has nothing to warn about; the pause itself is reported as policy.
  if (!connection.enabled) {
    return {
      tone: 'neutral' as const,
      label: t('plugins.channels.surface.connectionNoAttention', 'Nothing needs attention'),
    };
  }
  if (connection.attention.bestEffortBeforeDurableAdmission) {
    return { tone: 'warning' as const, label: t('plugins.channels.surface.bestEffort', 'Best effort before durable admission') };
  }
  return {
    tone: 'secondary' as const,
    label: t('plugins.channels.surface.connectionNoAttention', 'Nothing needs attention'),
  };
}

/** Whether a status tone asks the reader to look: needs-you, a caution or a failure. */
export function channelsStatusNeedsYou(tone: string): boolean {
  return tone === 'attention' || tone === 'warning' || tone === 'danger';
}

export function bindingEndpointLabel(binding: ChannelsBinding, t: Translate): string {
  const label = binding.endpoint.label?.trim();
  return label === undefined || label === ''
    ? t('plugins.channels.surface.bindingEndpointFallback', 'External conversation')
    : label;
}

/**
 * A collapsed row without any provider-derived human label still names itself:
 * the stable row identity is shortened to its discriminating head so two
 * unlabeled rows stay distinguishable in text and to a screen reader. This is
 * a presentation shortening only; every mutation keeps using the full id.
 */
export function shortRowIdentity(id: string): string {
  const tail = id.slice(id.lastIndexOf('-') + 1);
  return tail.length <= 8 ? tail : tail.slice(0, 8);
}

/**
 * The collapsed binding row's name: the provider endpoint label when one
 * exists, otherwise the binding's short identity instead of a generic word
 * that would read identically on every unlabeled row.
 */
export function bindingRowLabel(binding: ChannelsBinding): string {
  const label = binding.endpoint.label?.trim();
  return label === undefined || label === ''
    ? shortRowIdentity(binding.bindingId)
    : label;
}

/**
 * The host refuses a structurally installed but currently unreachable method
 * with this exact diagnostic (`hostApi.ts` `assertInstalled`). It is the ONE
 * current-availability fact a plugin can observe: `version().methods` is the
 * mount's stable structural contract by design, so a daemon that goes away
 * after mount is only ever reported per call.
 *
 * A generic `unavailable` is deliberately NOT enough. The same public code also
 * carries an undeclared Resource and other daemon-side refusals, and treating
 * those as an outage would silently demote a reachable mount to the offline
 * editor instead of reporting the real failure.
 */
export const HOST_METHOD_UNAVAILABLE_DIAGNOSTIC_PREFIX = 'host_api_method_unavailable:';

export function isHostMethodCurrentlyUnavailable(
  error: PluginUiResourceSnapshot['error'],
): boolean {
  return error?.diagnostics?.some((diagnostic) => (
    diagnostic.startsWith(HOST_METHOD_UNAVAILABLE_DIAGNOSTIC_PREFIX)
  )) === true;
}

/** What a conversation row says at its end: only a state, never activity. */
export type ChannelsConversationRowStatus =
  | Readonly<{ kind: 'paused' }>
  | Readonly<{ kind: 'deleting' }>;

export type ChannelsConversationIndexRow = Readonly<{
  binding: ChannelsBinding;
  connection?: ChannelsConnection;
  title: string;
  status?: ChannelsConversationRowStatus;
}>;

export type ChannelsConversationIndexGroup = Readonly<{
  key: string;
  /** The provider the group's bot belongs to; absent when the bot is not readable. */
  providerPluginId?: string;
  /** Set when one provider has several bots: the group names its bot instead. */
  connection?: ChannelsConnection;
  /**
   * The bot's own cause, spoken once on the group rather than on every row it
   * affects (lab A1: one message per cause).
   */
  botAttention?: Readonly<{ label: string }>;
  rows: readonly ChannelsConversationIndexRow[];
}>;

function connectionNeedsAttention(connection: ChannelsConnection, t: Translate): Readonly<{ label: string }> | undefined {
  const status = connectionStatus(connection, t);
  return channelsStatusNeedsYou(status.tone) ? { label: status.label } : undefined;
}

function conversationRowStatus(binding: ChannelsBinding): ChannelsConversationRowStatus | undefined {
  if (binding.deletionState !== 'none') return { kind: 'deleting' };
  return binding.enabled ? undefined : { kind: 'paused' };
}

/**
 * The one index of linked conversations, grouped by the provider of the bot
 * each one talks through — the Channels column, the page's own list on a
 * phone and the Home widget all read it.
 *
 * A group is a provider while it has one bot; with two bots of one provider
 * each bot becomes its own group, named for the bot. Groups follow the
 * provider's display name and rows their conversation name, so the order is
 * stable across reads and never jumps when a state changes.
 */
export function buildChannelsConversationIndex(input: Readonly<{
  bindings: readonly ChannelsBinding[];
  connections: readonly ChannelsConnection[];
  providerName: (providerPluginId: string) => string;
  t: Translate;
}>): readonly ChannelsConversationIndexGroup[] {
  const connectionById = new Map(input.connections.map((connection) => [connection.connectionId, connection]));
  const botsByProvider = new Map<string, Set<string>>();
  for (const binding of input.bindings) {
    const connection = connectionById.get(binding.connectionId);
    if (connection === undefined) continue;
    const bots = botsByProvider.get(connection.providerPluginId) ?? new Set<string>();
    bots.add(connection.connectionId);
    botsByProvider.set(connection.providerPluginId, bots);
  }
  const groups = new Map<string, {
    key: string;
    sortName: string;
    providerPluginId?: string;
    connection?: ChannelsConnection;
    botAttention?: Readonly<{ label: string }>;
    rows: ChannelsConversationIndexRow[];
  }>();
  for (const binding of input.bindings) {
    const connection = connectionById.get(binding.connectionId);
    const perBot = connection !== undefined && (botsByProvider.get(connection.providerPluginId)?.size ?? 0) > 1;
    const key = connection === undefined
      ? 'unknown'
      : perBot ? `bot:${connection.connectionId}` : `provider:${connection.providerPluginId}`;
    let group = groups.get(key);
    if (group === undefined) {
      const providerName = connection === undefined ? '' : input.providerName(connection.providerPluginId);
      group = {
        key,
        sortName: connection === undefined
          ? '￿'
          : perBot ? `${providerName}\u0000${connectionLabel(connection)}` : providerName,
        ...(connection === undefined ? {} : { providerPluginId: connection.providerPluginId }),
        ...(perBot && connection !== undefined ? { connection } : {}),
        rows: [],
      };
      groups.set(key, group);
    }
    if (connection !== undefined && group.botAttention === undefined) {
      const attention = connectionNeedsAttention(connection, input.t);
      if (attention !== undefined) group.botAttention = attention;
    }
    const status = conversationRowStatus(binding);
    group.rows.push({
      binding,
      ...(connection === undefined ? {} : { connection }),
      title: bindingRowLabel(binding),
      ...(status === undefined ? {} : { status }),
    });
  }
  return [...groups.values()]
    .sort((left, right) => left.sortName.localeCompare(right.sortName))
    .map(({ sortName: _sortName, rows, ...group }) => ({
      ...group,
      rows: rows.sort((left, right) => (
        left.title.localeCompare(right.title) || left.binding.bindingId.localeCompare(right.binding.bindingId)
      )),
    }));
}

/**
 * The binding a Channels page location names. The location is the binding id,
 * optionally followed by one page-internal step (`<bindingId>/edit`), or the
 * link journey, optionally on one bot (`link/<connectionId>`: a session tab's
 * "+" lets the person pick the bot before the page opens).
 */
export function readChannelsPageLocation(subPath: string | undefined): Readonly<{
  bindingId?: string;
  step?: 'edit' | 'link';
  connectionId?: string;
}> {
  if (subPath === undefined || subPath === '') return {};
  if (subPath === 'link') return { step: 'link' };
  if (subPath.startsWith('link/')) {
    const connectionId = subPath.slice('link/'.length);
    return connectionId === '' || connectionId.includes('/') ? { step: 'link' } : { step: 'link', connectionId };
  }
  const [bindingId, step] = subPath.split('/');
  if (bindingId === undefined || bindingId === '') return {};
  return step === 'edit' ? { bindingId, step: 'edit' } : { bindingId };
}

/** One read of the Account's conversations and bots, whichever owner served it. */
export type ChannelsConversationSnapshot = Readonly<{
  state: 'loading' | 'error' | 'ready';
  bindings: readonly ChannelsBinding[];
  connections: readonly ChannelsConnection[];
  refresh: () => void;
}>;

const NO_BINDINGS: readonly ChannelsBinding[] = Object.freeze([]);
const NO_CONNECTIONS: readonly ChannelsConnection[] = Object.freeze([]);

/**
 * The daemon-served read: the same two live Resources the Settings and
 * Channels pages read, so a pause or an unlink made on the page reaches the
 * column and the widget through the Resource watch, with no timer.
 * `unavailable` is the one current-availability fact a mount can observe; a
 * caller hands that outage to {@link useAccountConversationSnapshot}.
 */
export function useDaemonConversationSnapshot(): Readonly<{
  snapshot: ChannelsConversationSnapshot;
  unavailable: boolean;
}> {
  const bindingsRead = useLivePluginResource(CHANNELS_BINDINGS_RESOURCE);
  const connectionsRead = useLivePluginResource(CHANNELS_CONNECTIONS_RESOURCE);
  const bindingsValue = bindingsRead.resource.value;
  const connectionsValue = connectionsRead.resource.value;
  const parsedBindings = React.useMemo(
    () => (bindingsValue === undefined ? undefined : parseBindingsResource(bindingsValue)),
    [bindingsValue],
  );
  const parsedConnections = React.useMemo(
    () => (connectionsValue === undefined ? undefined : parseConnectionsResource(connectionsValue)),
    [connectionsValue],
  );
  const refreshBindings = bindingsRead.refresh;
  const refreshConnections = connectionsRead.refresh;
  const refresh = React.useCallback(() => {
    refreshBindings();
    refreshConnections();
  }, [refreshBindings, refreshConnections]);
  const state: ChannelsConversationSnapshot['state'] = parsedBindings?.kind === 'ready' && parsedConnections?.kind === 'ready'
    ? 'ready'
    : parsedBindings?.kind === 'invalid' || parsedConnections?.kind === 'invalid'
      || (bindingsValue === undefined && bindingsRead.resource.pending !== 'initial')
      || (connectionsValue === undefined && connectionsRead.resource.pending !== 'initial')
      ? 'error'
      : 'loading';
  const bindings = parsedBindings?.kind === 'ready' ? parsedBindings.bindings : NO_BINDINGS;
  const connections = parsedConnections?.kind === 'ready' ? parsedConnections.connections : NO_CONNECTIONS;
  const snapshot = React.useMemo<ChannelsConversationSnapshot>(
    () => ({ state, bindings, connections, refresh }),
    [bindings, connections, refresh, state],
  );
  return {
    snapshot,
    unavailable: isHostMethodCurrentlyUnavailable(bindingsRead.resource.error)
      || isHostMethodCurrentlyUnavailable(connectionsRead.resource.error),
  };
}

/**
 * The direct Account read for a mount the daemon cannot serve: the same
 * canonical Collection readers the offline Settings page uses. It reads once
 * per mount and on `refresh`.
 */
export function useAccountConversationSnapshot(signal: AbortSignal): ChannelsConversationSnapshot {
  const dataClient = usePluginUiDataClient();
  const stateCollection = React.useMemo(() => dataClient.collection(CHANNEL_STATE_COLLECTION), [dataClient]);
  const deliveriesCollection = React.useMemo(() => dataClient.collection(CHANNEL_DELIVERIES_COLLECTION), [dataClient]);
  const bindingsRead = useAccountLocalBindingRows(stateCollection, signal);
  const connectionsRead = useAccountLocalConnectionRows({ stateCollection, deliveriesCollection, signal });
  const refreshBindings = bindingsRead.refresh;
  const refreshConnections = connectionsRead.refresh;
  const refresh = React.useCallback(() => {
    refreshBindings();
    refreshConnections();
  }, [refreshBindings, refreshConnections]);
  const state: ChannelsConversationSnapshot['state'] = bindingsRead.bindings !== undefined && connectionsRead.connections !== undefined
    ? 'ready'
    : bindingsRead.resource.pending === 'initial' || connectionsRead.resource.pending === 'initial'
      ? 'loading'
      : 'error';
  const bindings = bindingsRead.bindings ?? NO_BINDINGS;
  const connections = connectionsRead.connections ?? NO_CONNECTIONS;
  return React.useMemo(
    () => ({ state, bindings, connections, refresh }),
    [bindings, connections, refresh, state],
  );
}

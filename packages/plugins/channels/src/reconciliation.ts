import {
  arePluginMachineMaterializationRefsEqual,
  PluginError,
  type JsonValue,
  type PluginInvocationCaller,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import type {
  ConversationEndpointAudienceV1,
  ConversationProviderConnectionReadInputV1,
  ConversationProviderConnectionReadResultV1,
  ConversationProviderConnectionReconciliationSnapshotV1,
  ConversationProviderConnectionsListInputV1,
  ConversationProviderConnectionsSnapshotV1,
  ConversationTransportKindV1,
} from '@happier-dev/channels-protocol/v1';
import {
  isConversationBindingInputModeDeliverableV1,
  MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
  MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
} from '@happier-dev/channels-protocol/v1';

import type { ConversationBindingInputModeV1 } from '@happier-dev/channels-protocol/v1';
import {
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import {
  hasUnsettledDestructiveOldTransportStop,
  isSelfStampedPluginCaller,
} from './connectionLifecycle.js';

/*
 * Keep the two Account-backed projections on one observed Account revision.
 * The single authoritative pass fails closed under continuous mutation by
 * surfacing the existing retryable outcome instead of publishing a
 * connection/binding combination that never existed.
 */
type ReconciliationCollectionRead = Readonly<{
  values: readonly JsonValue[];
  changeCursor: number;
}>;

function reconciliationSnapshotChangedError(): PluginError {
  return new PluginError({
    code: 'channels_reconciliation_snapshot_changed',
    message: 'Channel reconciliation state changed during its authoritative read.',
    retryable: true,
  });
}

type PluginCaller = Extract<PluginInvocationCaller, Readonly<{ kind: 'plugin' }>>;

type WithoutConnectionIdentity<T> = T extends unknown
  ? Omit<T, 'connectionId' | 'v'>
  : never;

type ChannelStateConnectionRecordV1 = Readonly<{
  'record-kind': typeof CHANNEL_STATE_RECORD_KIND.connection;
  'connection-id': string;
  v: 1;
  payload: WithoutConnectionIdentity<ConversationReconciliationConnectionStateV1>;
}>;

type ChannelStateBindingRecordV1 = Readonly<{
  'record-kind': typeof CHANNEL_STATE_RECORD_KIND.binding;
  'connection-id': string;
  payload: Readonly<{
    enabled: boolean;
    endpoint: Readonly<{ audience: ConversationEndpointAudienceV1 }>;
    inputMode: ConversationBindingInputModeV1;
  }>;
}>;

/**
 * The current persisted connection row facts needed for reconciliation. Its
 * transport origin is input authority only: it is checked against the
 * host-stamped caller and never copied into a provider-facing snapshot.
 */
type WithoutReconciliationDemand<T> = T extends unknown
  ? Omit<T, 'requiresFullSharedMessageContent'>
  : never;

export type ConversationReconciliationConnectionStateV1 =
  WithoutReconciliationDemand<ConversationProviderConnectionReconciliationSnapshotV1> & Readonly<{
    providerPluginId: string;
    overlapSafety: 'safe' | 'providerExclusive' | 'destructive';
    transport: Readonly<{ kind: ConversationTransportKindV1 }>;
    transportOrigin: Readonly<{
      materializationRef: PluginCaller['materialization'];
    }>;
    historyGap: JsonValue | null;
    pendingOldTransportStop: Readonly<{
      overlapSafety: 'safe' | 'providerExclusive' | 'destructive';
      acceptedPossibleLoss: boolean;
      stopRequest: Readonly<{
        reason: 'transfer' | 'delete';
        authorityEpoch: number;
      }>;
    }> | null;
  }>;

/**
 * Minimal current binding policy needed by the core to derive reconciliation
 * demand. It is private input to this owner, not a provider-facing binding or
 * audience projection and is never persisted as the derived result.
 */
export type ConversationReconciliationBindingPolicyStateV1 = Readonly<{
  connectionId: string;
  enabled: boolean;
  endpointAudience: ConversationEndpointAudienceV1;
  inputMode: ConversationBindingInputModeV1;
}>;

/**
 * The one caller-proven materialization predicate shared by reconciliation
 * projections and provider transport facts. It deliberately checks only the
 * provenance that a host-stamped plugin caller can carry; execution-origin
 * equality for outbound Action dispatch remains the generic SDK owner.
 */
export function hasCurrentConversationTransportCaller(input: Readonly<{
  caller: PluginInvocationCaller | undefined;
  providerPluginId: string;
  transportOrigin: ConversationReconciliationConnectionStateV1['transportOrigin'];
}>): boolean {
  return isSelfStampedPluginCaller(input.caller)
    && input.caller.pluginId === input.providerPluginId
    && arePluginMachineMaterializationRefsEqual(
      input.caller.materialization,
      input.transportOrigin.materializationRef,
    );
}

/**
 * The input modes an enabled binding of this connection still promises that the
 * provider's CURRENT authenticated capability can no longer deliver.
 *
 * One core-owned answer for every caller that must decide whether a saved
 * policy is still honourable: the retest that re-observes an existing
 * connection and the transfer that replaces its credential. Deliverability
 * itself stays at the single protocol owner the binding writer and the surface
 * already share, so a person can never be told three different things about the
 * same promise. An empty result means every enabled binding is still
 * satisfiable.
 */
function bindingInputModesNoLongerDeliverable(input: Readonly<{
  connectionId: string;
  bindingPolicies: readonly ConversationReconciliationBindingPolicyStateV1[];
  sharedEndpointInputModes: readonly ConversationBindingInputModeV1[];
}>): readonly ConversationBindingInputModeV1[] {
  const unsatisfiable: ConversationBindingInputModeV1[] = [];
  for (const binding of input.bindingPolicies) {
    if (binding.connectionId !== input.connectionId || !binding.enabled) continue;
    if (isConversationBindingInputModeDeliverableV1({
      audience: binding.endpointAudience,
      inputMode: binding.inputMode,
      sharedEndpointInputModes: input.sharedEndpointInputModes,
    })) continue;
    if (!unsatisfiable.includes(binding.inputMode)) unsatisfiable.push(binding.inputMode);
  }
  return unsatisfiable;
}

/**
 * The one core-owned answer to "can this connection's saved bindings still be
 * delivered by the capability the provider proves right now?", for the two
 * callers that re-observe an existing connection: the present-user retest and
 * the credential transfer.
 *
 * Bindings are read through the same bounded Account index and the same row
 * projection the reconciliation snapshot already uses, so this adds no second
 * binding reader or index.
 */
export async function readConversationBindingInputModesNoLongerDeliverable(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  sharedEndpointInputModes: readonly ConversationBindingInputModeV1[] | undefined;
}>): Promise<readonly ConversationBindingInputModeV1[]> {
  // A provider that declares no shared-endpoint restriction can deliver every
  // mode by definition, so there is nothing to compare and no binding read to
  // pay for. This is the same rule the protocol deliverability owner applies;
  // stating it here keeps the read off the common path without a second answer.
  if (input.sharedEndpointInputModes === undefined) return [];
  const read = await readCollectionValuesByKind({
    context: input.context,
    kind: CHANNEL_STATE_RECORD_KIND.binding,
    limit: MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
  });
  return bindingInputModesNoLongerDeliverable({
    connectionId: input.connectionId,
    bindingPolicies: read.values.flatMap((value) => {
      const binding = bindingPolicyFromCollectionValue(value);
      return binding === undefined ? [] : [binding];
    }),
    sharedEndpointInputModes: input.sharedEndpointInputModes,
  });
}

function requiresFullSharedMessageContent(
  connectionId: string,
  bindingPolicies: readonly ConversationReconciliationBindingPolicyStateV1[],
): boolean {
  return bindingPolicies.some((binding) => (
    binding.connectionId === connectionId
    && binding.enabled
    && binding.endpointAudience === 'shared'
    && (binding.inputMode === 'addressedMessages' || binding.inputMode === 'allAllowedMessages')
  ));
}

/**
 * The sole list/read projection gate. The persisted current row and the
 * immediate host-stamped caller must carry the exact same materialization;
 * output deliberately retains neither transport nor provenance authority.
 *
 * Eligibility does not depend on the connection's persisted transport kind:
 * every truthful kind (checkpointedPull, socket, durablePush) is listable so
 * providers such as Telegram observe their own checkpointed-pull connection
 * through source setup. Caller materialization, history-gap custody, and
 * destructive-replacement exclusions remain the authority gates.
 */
function projectReconciliationSnapshotForCaller(
  connection: ConversationReconciliationConnectionStateV1,
  caller: PluginInvocationCaller | undefined,
  bindingPolicies: readonly ConversationReconciliationBindingPolicyStateV1[],
): ConversationProviderConnectionReconciliationSnapshotV1 | undefined {
  if (
    // The lifecycle owner records an incompatible replacement's gap before the
    // replacement becomes visible to ordinary reconciliation.
    connection.historyGap !== null
    // A `none` deletion state with a pending old stop is the Collection
    // lifecycle's transfer-only shape. Destructive replacements cannot start
    // reconciliation until that exact custody is proven or explicitly accepted.
    || hasUnsettledDestructiveOldTransportStop(connection)
    || !hasCurrentConversationTransportCaller({
      caller,
      providerPluginId: connection.providerPluginId,
      transportOrigin: connection.transportOrigin,
    })
  ) return undefined;

  const derivedDemand = requiresFullSharedMessageContent(
    connection.connectionId,
    bindingPolicies,
  );
  if (connection.deletionState === 'none') return {
    v: connection.v,
    connectionId: connection.connectionId,
    providerConnectionKey: connection.providerConnectionKey,
    providerConfigVersion: connection.providerConfigVersion,
    providerConfig: connection.providerConfig,
    credentialRef: connection.credentialRef,
    authorityEpoch: connection.authorityEpoch,
    enabled: connection.enabled,
    deletionState: 'none',
    requiresFullSharedMessageContent: derivedDemand,
  };
  return {
    v: connection.v,
    connectionId: connection.connectionId,
    providerConnectionKey: connection.providerConnectionKey,
    providerConfigVersion: connection.providerConfigVersion,
    providerConfig: connection.providerConfig,
    credentialRef: connection.credentialRef,
    authorityEpoch: connection.authorityEpoch,
    enabled: false,
    deletionState: connection.deletionState,
    requiresFullSharedMessageContent: derivedDemand,
  };
}

function reconciliationSnapshotMap(
  snapshots: readonly ConversationProviderConnectionReconciliationSnapshotV1[],
): ConversationProviderConnectionsSnapshotV1 {
  if (snapshots.length > MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT) {
    throw new Error('Channel reconciliation snapshot exceeds the connection limit.');
  }
  const result = Object.create(null) as Record<
    string,
    ConversationProviderConnectionReconciliationSnapshotV1
  >;
  for (const snapshot of snapshots) {
    if (typeof snapshot.connectionId !== 'string' || Object.hasOwn(result, snapshot.connectionId)) {
      throw new Error('Channel reconciliation snapshot must have one exact key per connection ID.');
    }
    Object.defineProperty(result, snapshot.connectionId, {
      value: snapshot,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return result;
}

function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Account Collections validate the full manifest schema before this core
 * receives a row. These narrowings only select the two reconciliation families
 * and deliberately do not introduce a second persisted-row parser.
 */
function connectionStateFromCollectionValue(
  value: JsonValue,
): ConversationReconciliationConnectionStateV1 | undefined {
  if (
    !isJsonRecord(value)
    || value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.connection
  ) return undefined;
  const row = value as unknown as ChannelStateConnectionRecordV1;
  return {
    ...row.payload,
    connectionId: row['connection-id'],
    v: row.v,
  };
}

function bindingPolicyFromCollectionValue(
  value: JsonValue,
): ConversationReconciliationBindingPolicyStateV1 | undefined {
  if (
    !isJsonRecord(value)
    || value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.binding
  ) return undefined;
  const row = value as unknown as ChannelStateBindingRecordV1;
  return {
    connectionId: row['connection-id'],
    enabled: row.payload.enabled,
    endpointAudience: row.payload.endpoint.audience,
    inputMode: row.payload.inputMode,
  };
}

async function readCollectionValuesByKind(input: Readonly<{
  context: PluginInvocationContext;
  kind: typeof CHANNEL_STATE_RECORD_KIND.connection | typeof CHANNEL_STATE_RECORD_KIND.binding;
  limit: number;
}>): Promise<ReconciliationCollectionRead> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const values: JsonValue[] = [];
  let cursor: string | undefined;
  let observedCursor: number | undefined;

  for (;;) {
    const remaining = input.limit - values.length;
    if (remaining <= 0) {
      throw new Error(`Channel reconciliation ${input.kind} rows exceed the account limit.`);
    }
    const page = await collection.query({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [input.kind],
      order: 'asc',
      limit: Math.min(remaining, PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1),
      ...(cursor === undefined ? {} : { cursor }),
    }, { signal: input.context.signal });
    if (observedCursor !== undefined && page.changeCursor !== observedCursor) {
      throw reconciliationSnapshotChangedError();
    }
    observedCursor = page.changeCursor;
    values.push(...page.rows.map((row) => row.value));
    if (values.length > input.limit) {
      throw new Error(`Channel reconciliation ${input.kind} rows exceed the account limit.`);
    }
    if (page.nextCursor === undefined) {
      return { values, changeCursor: page.changeCursor };
    }
    cursor = page.nextCursor;
  }
}

async function readCurrentReconciliationState(
  context: PluginInvocationContext,
): Promise<Readonly<{
  connections: readonly ConversationReconciliationConnectionStateV1[];
  bindingPolicies: readonly ConversationReconciliationBindingPolicyStateV1[];
}>> {
  // One authoritative pass owns the answer. Cursor movement during the read —
  // within either scan or between the two — surfaces the existing retryable
  // outcome to the operation/supervisor retry owners instead of an unowned
  // local attempt count masking the contention.
  const [connectionRead, bindingRead] = await Promise.all([
    readCollectionValuesByKind({
      context,
      kind: CHANNEL_STATE_RECORD_KIND.connection,
      limit: MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
    }),
    readCollectionValuesByKind({
      context,
      kind: CHANNEL_STATE_RECORD_KIND.binding,
      limit: MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
    }),
  ]);
  if (connectionRead.changeCursor !== bindingRead.changeCursor) {
    throw reconciliationSnapshotChangedError();
  }
  return {
    connections: connectionRead.values.flatMap((value) => {
      const connection = connectionStateFromCollectionValue(value);
      return connection === undefined ? [] : [connection];
    }),
    bindingPolicies: bindingRead.values.flatMap((value) => {
      const binding = bindingPolicyFromCollectionValue(value);
      return binding === undefined ? [] : [binding];
    }),
  };
}

export function listConversationProviderConnectionsForCaller(input: Readonly<{
  caller: PluginInvocationCaller | undefined;
  connections: readonly ConversationReconciliationConnectionStateV1[];
  bindingPolicies: readonly ConversationReconciliationBindingPolicyStateV1[];
}>): ConversationProviderConnectionsSnapshotV1 {
  const snapshots: ConversationProviderConnectionReconciliationSnapshotV1[] = [];
  for (const connection of input.connections) {
    const snapshot = projectReconciliationSnapshotForCaller(
      connection,
      input.caller,
      input.bindingPolicies,
    );
    if (snapshot !== undefined) snapshots.push(snapshot);
  }
  return reconciliationSnapshotMap(snapshots);
}

/**
 * An empty result intentionally conflates missing and caller-ineligible rows so a
 * provider cannot use this Action as a cross-materialization state oracle.
 */
export function readConversationProviderConnectionForCaller(input: Readonly<{
  caller: PluginInvocationCaller | undefined;
  connections: readonly ConversationReconciliationConnectionStateV1[];
  bindingPolicies: readonly ConversationReconciliationBindingPolicyStateV1[];
  connectionId: string;
}>): ConversationProviderConnectionReadResultV1 {
  const connection = input.connections.find((candidate) => candidate.connectionId === input.connectionId);
  if (connection === undefined) return reconciliationSnapshotMap([]);
  const snapshot = projectReconciliationSnapshotForCaller(
    connection,
    input.caller,
    input.bindingPolicies,
  );
  return snapshot === undefined ? reconciliationSnapshotMap([]) : reconciliationSnapshotMap([snapshot]);
}

/**
 * C1's Action handler reads the canonical Account Collection on demand. The
 * caller provenance is host-stamped context, never a mutable Action selector.
 */
export async function listConversationProviderConnectionsForInvocation(
  _input: ConversationProviderConnectionsListInputV1,
  context: PluginInvocationContext,
): Promise<ConversationProviderConnectionsSnapshotV1> {
  const { connections, bindingPolicies } = await readCurrentReconciliationState(context);
  return listConversationProviderConnectionsForCaller({
    caller: context.caller,
    connections,
    bindingPolicies,
  });
}

export async function readConversationProviderConnectionForInvocation(
  input: ConversationProviderConnectionReadInputV1,
  context: PluginInvocationContext,
): Promise<ConversationProviderConnectionReadResultV1> {
  const { connections, bindingPolicies } = await readCurrentReconciliationState(context);
  return readConversationProviderConnectionForCaller({
    caller: context.caller,
    connections,
    bindingPolicies,
    connectionId: input.connectionId,
  });
}

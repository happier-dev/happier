import * as React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1,
  MAX_CONVERSATION_OBSERVATION_AGE_MS,
  MIN_CONVERSATION_OBSERVATION_AGE_MS,
} from '@happier-dev/channels-protocol/v1';
import {
  PLUGIN_UI_HOST_API_VERSION_V1,
  PluginUiArtifactDigestV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import type {
  PluginAccountCollectionDefinition,
  PluginAccountCollectionValue,
  PluginCollectionMutation,
  PluginCollectionRow,
} from '@happier-dev/plugin-sdk/collections';
import type {
  PluginUiTargetedContributionsV1,
  ResourceSubscriptionEvent,
  SelectActionInputRequest,
  SelectActionInputResult,
  SurfaceContext,
} from '@happier-dev/plugin-sdk/ui';
import type {
  PluginUiAccountCollectionForDefinition,
  PluginUiDataClient,
} from '@happier-dev/plugin-ui/data';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_DELIVERIES_INDEX_ID,
  CHANNEL_DELIVERIES_RECORD_KIND,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from '../../../../../../packages/plugins/channels/src/collections';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  const { StyleSheet } = await import('react-native-web');
  return createReactNativeWebMock({
    Platform: { OS: 'web' },
    StyleSheet,
    // The virtualized list is the genuine rendering boundary for this mounted
    // surface test, so render its supplied rows rather than mocking item logic.
    FlatList: ({
      data,
      renderItem,
      keyExtractor,
      ListHeaderComponent,
      ListEmptyComponent,
      ListFooterComponent,
      ...props
    }: Readonly<{
      data?: readonly unknown[];
      renderItem: (input: Readonly<{ item: unknown; index: number }>) => React.ReactNode;
      keyExtractor?: (item: unknown, index: number) => string;
      ListHeaderComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    }>) => ReactModule.createElement(
      'FlatList',
      { ...props, data },
      ListHeaderComponent,
      ...(data ?? []).map((item: unknown, index: number) => ReactModule.createElement(
        ReactModule.Fragment,
        { key: keyExtractor ? keyExtractor(item, index) : String(index) },
        renderItem({ item, index }),
      )),
      (data?.length ?? 0) === 0 ? ListEmptyComponent : null,
      ListFooterComponent,
    ),
  });
});

const { flushHookEffects } = await import('@/dev/testkit');
const { createPluginSurfaceContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');
const { StyleSheet } = await import('react-native');

const CHANNELS_SETTINGS_VIEW = { id: 'connections', placement: 'settingsPage' } as const;
const CHANNELS_SETTINGS_MOUNT = {
  kind: 'destination',
  destination: { pluginId: 'happier.channels', localId: 'connections' },
  container: 'settingsPage',
} as const satisfies SurfaceContext['mount'];
const CHANNELS_CONNECTIONS_RESOURCE = {
  pluginId: 'happier.channels',
  localId: 'connections-v1',
} as const;
const CHANNELS_BINDINGS_RESOURCE = {
  pluginId: 'happier.channels',
  localId: 'bindings-v1',
} as const;

type ChannelsHostMethod =
  | 'executeAction'
  | 'readResource'
  | 'selectActionInput'
  | 'watchContext'
  | 'watchResource';
type ChannelStateValue = PluginAccountCollectionValue<typeof CHANNEL_STATE_COLLECTION>;
type ChannelStateRow = PluginCollectionRow<ChannelStateValue>;
type ChannelStateMutation = PluginCollectionMutation<ChannelStateValue>;
type ChannelStateCollection = PluginUiAccountCollectionForDefinition<typeof CHANNEL_STATE_COLLECTION>;
type ChannelStateCollectionPage = Awaited<ReturnType<ChannelStateCollection['query']>>;
type ChannelStateBatchResult = Awaited<ReturnType<ChannelStateCollection['batch']>>;
type ChannelDeliveriesValue = PluginAccountCollectionValue<typeof CHANNEL_DELIVERIES_COLLECTION>;
type ChannelDeliveriesRow = PluginCollectionRow<ChannelDeliveriesValue>;
type ChannelDeliveriesCollection = PluginUiAccountCollectionForDefinition<typeof CHANNEL_DELIVERIES_COLLECTION>;
type ChannelDeliveriesCollectionPage = Awaited<ReturnType<ChannelDeliveriesCollection['query']>>;

function createChannelsSettingsSurfaceContextFixture(
  overrides: Omit<Partial<SurfaceContext>, 'mount' | 'target'> = {},
): SurfaceContext {
  return createPluginSurfaceContextFixture({
    ...overrides,
    mount: CHANNELS_SETTINGS_MOUNT,
    target: { kind: 'app' },
  });
}

type ConnectionResourceRow = Readonly<{
  connectionId: string;
  revision: number;
  authorityEpoch: number;
  providerPluginId: string;
  selectedMachineId: string;
  selectedTransport: 'checkpointedPull' | 'socket' | 'durablePush';
  integrationPrincipalLabel?: string;
  enabled: boolean;
  deletionState: 'none' | 'pendingStopReconciliation' | 'finalizingDelete';
  maximumObservationAgeMs: number;
  attention: Readonly<{
    historyGap: Readonly<{
      reportedAt: number;
      reason: 'providerHistoryUnavailable' | 'applicationAdmissionLost';
    }> | null;
    bestEffortBeforeDurableAdmission: boolean;
    oldTransportStopUnconfirmed: boolean;
    acceptedPossibleLoss: boolean;
    pollFailure:
      | Readonly<{
        phase: 'retryDue';
        attemptCount: 1 | 2 | 3 | 4;
        retryNotBeforeMs: number;
        evidence: Readonly<
          | { kind: 'provider'; reason: string }
          | { kind: 'action'; code: string }
        >;
      }>
      | Readonly<{
        phase: 'blocked';
        attemptCount: 1 | 2 | 3 | 4 | 5;
        retryNotBeforeMs: null;
        evidence: Readonly<
          | { kind: 'provider'; reason: string }
          | { kind: 'action'; code: string }
        >;
      }>
      | null;
    outwardDelivery: Readonly<{
      retryDue: boolean;
      notDelivered: boolean;
      partial: boolean;
      outcomeUnknown: boolean;
    }>;
  }>;
}>;

type ConnectionResourceRowOverrides = Omit<Partial<ConnectionResourceRow>, 'attention'> & Readonly<{
  attention?: Partial<ConnectionResourceRow['attention']>;
}>;

type BindingResourceRow = Readonly<{
  bindingId: string;
  revision: number;
  connectionId: string;
  endpoint: Readonly<{
    label: string;
    audience: 'direct' | 'shared';
  }>;
  target: Readonly<{
    kind: 'session' | 'automation';
    summary: string;
  }>;
  inputMode: 'directMentionsOnly' | 'addressedMessages' | 'allAllowedMessages';
  deliveryMode: 'repliesOnly' | 'mirrorSession' | 'finalResult' | 'none';
  approval:
    | Readonly<{ kind: 'notApplicable' }>
    | Readonly<{ kind: 'off' }>
    | Readonly<{ kind: 'unavailable'; maximumScope: 'request' | 'session' }>;
  enabled: boolean;
  deletionState: 'none' | 'finalizingDelete';
}>;

type BindingResourceRowOverrides = Omit<Partial<BindingResourceRow>, 'endpoint' | 'target'> & Readonly<{
  endpoint?: Partial<BindingResourceRow['endpoint']>;
  target?: Partial<BindingResourceRow['target']>;
}>;

type ResourceInvalidationDigest = Extract<
  ResourceSubscriptionEvent,
  Readonly<{ kind: 'invalidated' }>
>['digest'];

function resourceDigest(digestCharacter: string): ResourceInvalidationDigest {
  return PluginUiArtifactDigestV1Schema.parse(`sha256:${digestCharacter.repeat(64)}`);
}

function connectionResourceContent(connections: readonly ConnectionResourceRow[], digestCharacter = 'c') {
  return {
    contentType: 'application/json',
    digest: resourceDigest(digestCharacter),
    bytes: new TextEncoder().encode(JSON.stringify({ connections })),
  };
}

function bindingResourceContent(bindings: readonly BindingResourceRow[], digestCharacter = 'b') {
  return {
    contentType: 'application/json',
    digest: resourceDigest(digestCharacter),
    bytes: new TextEncoder().encode(JSON.stringify({ bindings })),
  };
}

function channelsProviderTargetedContributions(): PluginUiTargetedContributionsV1 {
  const protocol = {
    id: CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1,
    version: CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1,
  } as const;
  const sharedSetupLocalId = 'arbitrary-provider-setup';
  const alphaContributor = {
    pluginId: 'example.channel.alpha',
    contributionId: 'provider',
    immutableGenerationId: 'alpha-generation-a',
  } as const;
  const betaContributor = {
    pluginId: 'example.channel.beta',
    contributionId: 'provider',
    immutableGenerationId: 'beta-generation-a',
  } as const;
  const setupOperation = (contributor: typeof alphaContributor | typeof betaContributor) => ({
    point: { pointId: CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1, protocol },
    contributor,
    role: 'setup',
    // Both contributors deliberately use the same arbitrary local Action ID.
    // The exact admitted operation, rather than this string, is the selector key.
    action: { pluginId: contributor.pluginId, localId: sharedSetupLocalId },
  });
  return {
    target: {
      pluginId: 'happier.channels',
      immutableGenerationId: 'channels-generation-a',
    },
    points: [{
      pointId: CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
      protocols: [{
        protocol,
        contributions: [{
          contributor: alphaContributor,
          protocol,
          operations: [setupOperation(alphaContributor)],
          surfaces: [],
        }, {
          contributor: betaContributor,
          protocol,
          operations: [setupOperation(betaContributor)],
          surfaces: [],
        }],
      }],
    }],
  };
}

function connectionFixture(overrides: ConnectionResourceRowOverrides = {}): ConnectionResourceRow {
  const { attention: attentionOverrides, ...connectionOverrides } = overrides;
  return {
    connectionId: 'connection-1',
    revision: 4,
    authorityEpoch: 2,
    providerPluginId: 'acme.channel.telegram',
    selectedMachineId: 'machine-1',
    selectedTransport: 'checkpointedPull',
    integrationPrincipalLabel: 'Happier Relay',
    enabled: true,
    deletionState: 'none',
    maximumObservationAgeMs: 120_000,
    attention: {
      historyGap: null,
      bestEffortBeforeDurableAdmission: false,
      oldTransportStopUnconfirmed: false,
      acceptedPossibleLoss: false,
      pollFailure: null,
      outwardDelivery: {
        retryDue: false,
        notDelivered: false,
        partial: false,
        outcomeUnknown: false,
      },
      ...attentionOverrides,
    },
    ...connectionOverrides,
  };
}

function connectionFixtures(count: number): readonly ConnectionResourceRow[] {
  return Array.from({ length: count }, (_, index) => connectionFixture({
    connectionId: `connection-${index + 1}`,
    revision: index + 1,
    providerPluginId: `acme.channel.integration-${index + 1}`,
    selectedMachineId: `machine-${index + 1}`,
    integrationPrincipalLabel: `Integration ${index + 1}`,
  }));
}

function bindingFixture(overrides: BindingResourceRowOverrides = {}): BindingResourceRow {
  const { endpoint: endpointOverrides, target: targetOverrides, ...bindingOverrides } = overrides;
  return {
    bindingId: 'binding-1',
    revision: 6,
    connectionId: 'connection-1',
    endpoint: {
      label: 'Support discussion',
      audience: 'shared',
      ...endpointOverrides,
    },
    target: {
      kind: 'session',
      summary: 'session-support',
      ...targetOverrides,
    },
    inputMode: 'addressedMessages',
    deliveryMode: 'mirrorSession',
    approval: { kind: 'off' },
    enabled: true,
    deletionState: 'none',
    ...bindingOverrides,
  };
}

function offlineConnectionStateRow(overrides: Readonly<{
  id?: string;
  revision?: number;
}> = {}): ChannelStateRow {
  const id = overrides.id ?? 'connection-offline-1';
  return {
    rowId: id,
    revision: overrides.revision ?? 4,
    value: {
      id,
      'record-kind': CHANNEL_STATE_RECORD_KIND.connection,
      v: 1,
      'connection-id': id,
      'created-at': 1_000,
      'updated-at': 1_000,
      payload: {
        providerPluginId: 'acme.channel.telegram',
        providerContributionSelection: {
          contributionId: 'provider-private',
          immutableGenerationId: 'provider-generation-private',
        },
        providerSetupInput: { authorizationCode: 'opaque-provider-setup-private' },
        credentialRef: null,
        transportOrigin: {
          serverIdentityId: 'server-identity-private',
          materializationRef: {
            pluginId: 'acme.channel.telegram',
            machineId: 'machine-private',
            materializationId: 'materialization-private',
          },
        },
        transport: { kind: 'socket' },
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        providerConnectionKey: 'connection-key-private',
        providerConfigVersion: 1,
        providerConfig: { token: 'provider-config-private' },
        routingIdentityKey: 'r'.repeat(43),
        integrationPrincipal: { id: 'bot-private', label: 'Support relay' },
        authorityEpoch: 2,
        enabled: true,
        deletionState: 'none',
        pendingOldTransportStop: null,
        historyGap: null,
        pollFailure: null,
        maximumObservationAgeMs: 60_000,
      },
    },
  };
}

function offlineBindingStateRow(overrides: Readonly<{
  id?: string;
  connectionId?: string;
  revision?: number;
  enabled?: boolean;
  approval?: 'enabled' | 'off';
}> = {}): ChannelStateRow {
  const id = overrides.id ?? 'binding-offline-1';
  const connectionId = overrides.connectionId ?? 'connection-offline-1';
  return {
    rowId: id,
    revision: overrides.revision ?? 6,
    value: {
      id,
      'record-kind': CHANNEL_STATE_RECORD_KIND.binding,
      v: 1,
      'connection-id': connectionId,
      'binding-id': id,
      'created-at': 1_000,
      'updated-at': 1_000,
      payload: {
        endpoint: {
          kind: 'shared',
          audience: 'shared',
          id: 'endpoint-private',
          label: 'Offline support conversation',
          parentId: 'endpoint-parent-private',
          parentLabel: 'Support',
        },
        target: {
          kind: 'session',
          sessionId: 'session-visible-summary',
          policy: {
            deliveryMode: 'mirrorSession',
            permissionCeiling: 'yolo',
            approvals: overrides.approval === 'off'
              ? { kind: 'off' }
              : {
                kind: 'enabled',
                maximumScope: 'session',
                principalIds: ['approval-principal-private'],
              },
            newSession: {
              kind: 'enabled',
              principalIds: ['new-session-principal-private'],
              recipe: { command: 'private-recipe' },
            },
          },
        },
        // The persisted policy owner rejects approval and /new principals that
        // are outside this binding allowlist. Keep this offline fixture
        // internally valid while preserving the no-disclosure assertions below.
        allowedPrincipalIds: [
          'allowed-principal-private',
          'approval-principal-private',
          'new-session-principal-private',
        ],
        allowBotSenders: false,
        inputMode: 'addressedMessages',
        inboundDebounceMs: 750,
        linkPreviewPolicy: 'suppress',
        senderFeedback: 'off',
        authorityEpoch: 3,
        enabled: overrides.enabled ?? true,
        deletionState: 'none',
      },
    },
  };
}

function ingressAttentionStateRow(overrides: Readonly<{
  id?: string;
  revision?: number;
  connectionId?: string;
  bindingId?: string;
  attemptCount?: number;
  updatedAt?: number;
}> = {}): ChannelStateRow {
  const id = overrides.id ?? 'I'.repeat(43);
  const connectionId = overrides.connectionId ?? 'connection-1';
  const bindingId = overrides.bindingId ?? 'binding-1';
  return {
    rowId: id,
    revision: overrides.revision ?? 7,
    value: {
      id,
      'record-kind': CHANNEL_STATE_RECORD_KIND.ingressObligation,
      v: 1,
      'connection-id': connectionId,
      'binding-id': bindingId,
      terminal: false,
      attention: true,
      'created-at': 1_700_000_000_000,
      'updated-at': overrides.updatedAt ?? 1_700_000_000_100,
      payload: {
        occurrenceIds: ['occurrence-private'],
        censusId: 'C'.repeat(43),
        target: {
          kind: 'session',
          sessionId: 'session-private',
          idempotencyKey: `channels:input:v1:${id}`,
          requestedPermissionCeiling: 'default',
        },
        sourceAuthority: {
          connectionAuthorityEpoch: 2,
          bindingRevision: 6,
          bindingAuthorityEpoch: 3,
        },
        lifecycle: {
          phase: 'blocked',
          attemptCount: overrides.attemptCount ?? 5,
          dueAt: null,
        },
        disposition: null,
        nonAdmission: null,
      },
    },
  };
}

function terminalIngressAttentionStateRow(overrides: Readonly<{
  id?: string;
  revision?: number;
  connectionId?: string;
  bindingId?: string;
  updatedAt?: number;
}> = {}): ChannelStateRow {
  const id = overrides.id ?? 'T'.repeat(43);
  const connectionId = overrides.connectionId ?? 'connection-1';
  const bindingId = overrides.bindingId ?? 'binding-1';
  return {
    rowId: id,
    revision: overrides.revision ?? 8,
    value: {
      id,
      'record-kind': CHANNEL_STATE_RECORD_KIND.ingressObligation,
      v: 1,
      'connection-id': connectionId,
      'binding-id': bindingId,
      terminal: true,
      attention: true,
      'created-at': 1_700_000_000_000,
      'updated-at': overrides.updatedAt ?? 1_700_000_000_100,
      payload: {
        occurrenceIds: ['occurrence-private'],
        censusId: 'C'.repeat(43),
        target: null,
        sourceAuthority: {
          connectionAuthorityEpoch: 2,
          bindingRevision: 6,
          bindingAuthorityEpoch: 3,
        },
        lifecycle: {
          phase: 'terminal',
          attemptCount: 0,
          dueAt: null,
        },
        disposition: 'rejected',
        nonAdmission: {
          reason: 'messageTooLarge',
          senderFeedbackEligible: true,
        },
      },
    },
  };
}

function createOfflineChannelsDataClient(input: Readonly<{
  rows: readonly ChannelStateRow[];
  queryFailure?: () => unknown;
  batchFailure?: () => unknown;
  batchFailureAfterCommit?: () => unknown;
}>) {
  const rows = new Map(input.rows.map((row) => [row.rowId, row]));
  const get = vi.fn(async (rowId: string): Promise<ChannelStateRow | null> => rows.get(rowId) ?? null);
  const query = vi.fn(async (request: Parameters<ChannelStateCollection['query']>[0]): Promise<ChannelStateCollectionPage> => {
    const failure = input.queryFailure?.();
    if (failure !== undefined) throw failure;
    if (request.index !== CHANNEL_STATE_INDEX_ID.byKind && request.index !== CHANNEL_STATE_INDEX_ID.byAttention) {
      throw new Error(`Unexpected direct Collection index: ${request.index}.`);
    }
    if (request.limit !== undefined && request.limit > 200) {
      throw new Error('Direct Collection query exceeded the Data-owned page limit.');
    }
    const matching = [...rows.values()]
      .filter((row) => (
        request.index === CHANNEL_STATE_INDEX_ID.byKind
          ? row.value['record-kind'] === request.prefix?.[0]
          : row.value.attention === request.prefix?.[0]
      ))
      .sort((left, right) => (
        request.index === CHANNEL_STATE_INDEX_ID.byAttention
          ? Number(right.value['updated-at']) - Number(left.value['updated-at'])
            || left.rowId.localeCompare(right.rowId)
          : left.rowId.localeCompare(right.rowId)
      ));
    const start = request.cursor === undefined
      ? 0
      : matching.findIndex((row) => row.rowId === request.cursor) + 1;
    const pageSize = request.limit ?? 50;
    const pageRows = matching.slice(Math.max(0, start), Math.max(0, start) + pageSize);
    const next = matching[Math.max(0, start) + pageSize];
    return {
      rows: pageRows,
      ...(next === undefined ? {} : { nextCursor: pageRows.at(-1)?.rowId }),
      changeCursor: 1,
    };
  });
  const deliveryQuery = vi.fn(async (
    request: Parameters<ChannelDeliveriesCollection['query']>[0],
  ): Promise<ChannelDeliveriesCollectionPage> => {
    if (request.index !== CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention) {
      throw new Error(`Unexpected direct delivery Collection index: ${request.index}.`);
    }
    if (request.limit !== undefined && request.limit > 200) {
      throw new Error('Direct delivery Collection query exceeded the Data-owned page limit.');
    }
    return { rows: [], changeCursor: 1 };
  });
  const batch = vi.fn(async (operations: readonly ChannelStateMutation[]): Promise<ChannelStateBatchResult> => {
    const failure = input.batchFailure?.();
    if (failure !== undefined) throw failure;
    for (const operation of operations) {
      const rowId = operation.kind === 'put' ? operation.value.id : operation.rowId;
      if (typeof rowId !== 'string') {
        throw new Error('Expected a direct Collection mutation row ID.');
      }
      const current = rows.get(rowId);
      const expectedRevision = operation.expectedRevision;
      const matches = expectedRevision === 'absent'
        ? current === undefined
        : current?.revision === expectedRevision;
      if (!matches) {
        throw new Error(`Expected exact direct CAS precondition for ${rowId}.`);
      }
    }
    const results = operations.flatMap((operation) => {
      if (operation.kind !== 'put') return [];
      const rowId = operation.value.id;
      if (typeof rowId !== 'string') {
        throw new Error('Expected a direct Collection put row ID.');
      }
      const current = rows.get(rowId);
      const updated: ChannelStateRow = {
        rowId,
        revision: (current?.revision ?? 0) + 1,
        value: operation.value,
      };
      rows.set(updated.rowId, updated);
      return [{ rowId: updated.rowId, revision: updated.revision, deleted: false as const }];
    });
    if (results.length === 0) throw new Error('Expected a direct Collection mutation.');
    const postCommitFailure = input.batchFailureAfterCommit?.();
    if (postCommitFailure !== undefined) throw postCommitFailure;
    return { status: 'updated', results, changeCursor: 2 };
  });
  const put = vi.fn(async (value: ChannelStateValue, options: Readonly<{
    expectedRevision: number | 'absent';
    signal?: AbortSignal;
  }>): Promise<ChannelStateRow> => {
    const result = await batch([{ kind: 'put', value, expectedRevision: options.expectedRevision }]);
    if (result.status !== 'updated') throw new Error('Expected a direct Collection put update result.');
    const persisted = result.results[0];
    if (!persisted || persisted.deleted) throw new Error('Expected a direct Collection put result.');
    const row: ChannelStateRow = { rowId: persisted.rowId, revision: persisted.revision, value };
    return row;
  });
  const remove = vi.fn(async (rowId: string, options: Readonly<{
    expectedRevision: number;
    signal?: AbortSignal;
  }>) => {
    const current = rows.get(rowId);
    if (current?.revision !== options.expectedRevision) throw new Error(`Expected exact direct delete CAS for ${rowId}.`);
    rows.delete(rowId);
    return { rowId, revision: current.revision + 1, deleted: true as const };
  });
  const collection = {
    get,
    put,
    delete: remove,
    query,
    batch,
  } satisfies ChannelStateCollection;
  const deliveriesCollection = { query: deliveryQuery };
  const client: PluginUiDataClient = {
    collection<TDefinition extends PluginAccountCollectionDefinition>(definition: TDefinition) {
      if (definition.id === CHANNEL_STATE_COLLECTION.id) {
        // The fixture exposes exactly one admitted state Collection; this generic
        // cast stays at the SDK boundary and cannot disguise a second state owner.
        return collection as unknown as PluginUiAccountCollectionForDefinition<TDefinition>;
      }
      if (definition.id === CHANNEL_DELIVERIES_COLLECTION.id) {
        // Delivery attention reads only the canonical owner index. The fixture
        // deliberately supplies no mutable delivery surface to this UI path.
        return deliveriesCollection as unknown as PluginUiAccountCollectionForDefinition<TDefinition>;
      }
      throw new Error('Unexpected direct Account Collection definition.');
    },
    async openCollectionQuery() {
      throw new Error('Channels offline policy uses direct Account Collection queries, not a server-readable UI query.');
    },
  };
  return { client, get, query, deliveryQuery, batch, rows };
}

function deliveryResolutionRow(input: Readonly<{
  custodyId: string;
  revision: number;
  state: 'partial' | 'outcomeUnknown';
}>): ChannelDeliveriesRow {
  const value: ChannelDeliveriesValue = {
    id: input.custodyId,
    'record-kind': CHANNEL_DELIVERIES_RECORD_KIND.outwardDelivery,
    v: 1,
    'connection-id': 'connection-1',
    terminal: true,
    attention: true,
    'created-at': 1_700_000_000_000,
    'updated-at': 1_700_000_000_100,
    payload: {
      source: { kind: 'controlResponse', controlId: 'delivery-resolution-private', controlKind: 'recovery' },
      routeAuthority: { connectionAuthorityEpoch: 4 },
      endpoint: { kind: 'direct', audience: 'direct', id: 'endpoint-private' },
      content: 'Private delivery body that must not reach the management surface.',
      deliveryKey: 'private-delivery-key',
      replyContext: null,
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
      state: input.state,
      attemptCount: 1,
      attemptId: null,
      startedAt: null,
      providerMessageIds: ['provider-message-private'],
      failedChunk: input.state === 'partial' ? 1 : null,
      archiveRecovery: null,
    },
  };
  return { rowId: input.custodyId, revision: input.revision, value };
}

function createDeliveryResolutionDataClient(input: Readonly<{
  rows: readonly ChannelDeliveriesRow[];
}>) {
  const rows = new Map(input.rows.map((row) => [row.rowId, row]));
  const resolvedCustodyIds = new Set<string>();
  const stateQuery = vi.fn(async (
    request: Parameters<ChannelStateCollection['query']>[0],
  ): Promise<ChannelStateCollectionPage> => {
    if (request.index !== CHANNEL_STATE_INDEX_ID.byAttention) {
      throw new Error(`Unexpected direct state Collection index: ${request.index}.`);
    }
    return { rows: [], changeCursor: 1 };
  });
  const query = vi.fn(async (
    request: Parameters<ChannelDeliveriesCollection['query']>[0],
  ): Promise<ChannelDeliveriesCollectionPage> => {
    if (request.index !== CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention) {
      throw new Error(`Unexpected direct delivery Collection index: ${request.index}.`);
    }
    if (request.prefix?.[0] !== 'connection-1') {
      throw new Error('Expected the delivery query to stay within the expanded connection.');
    }
    if (request.limit !== undefined && request.limit > 200) {
      throw new Error('Direct delivery query exceeded the Data-owned page limit.');
    }
    const matching = [...rows.values()]
      .filter((row) => !resolvedCustodyIds.has(row.rowId))
      .sort((left, right) => left.rowId.localeCompare(right.rowId));
    const start = request.cursor === undefined
      ? 0
      : matching.findIndex((row) => row.rowId === request.cursor) + 1;
    const pageSize = request.limit ?? 50;
    const pageRows = matching.slice(Math.max(0, start), Math.max(0, start) + pageSize);
    const next = matching[Math.max(0, start) + pageSize];
    return {
      rows: pageRows,
      ...(next === undefined ? {} : { nextCursor: pageRows.at(-1)?.rowId }),
      changeCursor: 1,
    };
  });
  const collection = {
    get: async (rowId: string) => rows.get(rowId) ?? null,
    put: async () => {
      throw new Error('Delivery-resolution UI reads direct Account rows; the Action owns the CAS write.');
    },
    delete: async () => {
      throw new Error('Delivery-resolution UI does not delete retained custody.');
    },
    query,
    batch: async () => {
      throw new Error('Delivery-resolution UI does not batch-mutate retained custody.');
    },
  } satisfies ChannelDeliveriesCollection;
  const stateCollection = {
    get: async () => null,
    put: async () => {
      throw new Error('Delivery-resolution UI does not mutate ingress custody directly.');
    },
    delete: async () => {
      throw new Error('Delivery-resolution UI does not delete ingress custody.');
    },
    query: stateQuery,
    batch: async () => {
      throw new Error('Delivery-resolution UI does not batch-mutate ingress custody.');
    },
  } satisfies ChannelStateCollection;
  const client: PluginUiDataClient = {
    collection<TDefinition extends PluginAccountCollectionDefinition>(definition: TDefinition) {
      if (definition.id === CHANNEL_STATE_COLLECTION.id) {
        return stateCollection as unknown as PluginUiAccountCollectionForDefinition<TDefinition>;
      }
      if (definition.id !== CHANNEL_DELIVERIES_COLLECTION.id) {
        throw new Error('Unexpected direct Account Collection definition.');
      }
      // The fixture exposes exactly the data boundary used by the resolution UI.
      return collection as unknown as PluginUiAccountCollectionForDefinition<TDefinition>;
    },
    async openCollectionQuery() {
      throw new Error('Delivery resolution uses the canonical direct Account Collection page reader.');
    },
  };
  return {
    client,
    query,
    stateQuery,
    markResolved(custodyId: string) {
      resolvedCustodyIds.add(custodyId);
    },
  };
}

function createChannelsHostApi(input: Readonly<{
  readResource: (resource: Readonly<{ pluginId: string; localId: string }>) => Promise<ReturnType<typeof connectionResourceContent>>;
  readBindingsResource?: () => Promise<ReturnType<typeof bindingResourceContent>>;
  executeAction?: (actionId: string, payload: unknown) => Promise<unknown>;
  selectActionInput?: (request: SelectActionInputRequest) => Promise<SelectActionInputResult>;
  methods?: readonly ChannelsHostMethod[];
}>) {
  const readResource = vi.fn(async (resource: Readonly<{ pluginId: string; localId: string }>) => (
    resource.localId === CHANNELS_BINDINGS_RESOURCE.localId
      ? await input.readBindingsResource?.() ?? bindingResourceContent([])
      : await input.readResource(resource)
  ));
  const executeAction = vi.fn(input.executeAction ?? (async () => ({ kind: 'updated' })));
  const selectActionInput = vi.fn(input.selectActionInput ?? (async () => ({ kind: 'cancelled' as const })));
  const resourceListeners = new Map<string, (event: ResourceSubscriptionEvent) => void>();
  const watchResource = vi.fn(async (
    resource: Readonly<{ localId?: unknown }>,
    listener: (event: ResourceSubscriptionEvent) => void,
  ) => {
    if (typeof resource.localId !== 'string') throw new Error('Expected a Resource local ID.');
    resourceListeners.set(resource.localId, listener);
    return {
      dispose: vi.fn(() => {
        resourceListeners.delete(resource.localId as string);
      }),
    };
  });
  return {
    hostApi: {
      version: () => ({
        apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
        wireVersion: 1,
        methods: input.methods ?? ['executeAction', 'readResource', 'watchContext', 'watchResource'] as const,
      }),
      context: vi.fn(async () => createChannelsSettingsSurfaceContextFixture()),
      watchContext: vi.fn(async () => ({ dispose: vi.fn() })),
      executeAction,
      selectActionInput,
      readResource,
      watchResource,
    },
    readResource,
    executeAction,
    selectActionInput,
    watchResource,
    invalidateResource: (
      digest: ResourceInvalidationDigest,
      resourceLocalId: typeof CHANNELS_CONNECTIONS_RESOURCE.localId | typeof CHANNELS_BINDINGS_RESOURCE.localId = (
        CHANNELS_CONNECTIONS_RESOURCE.localId
      ),
    ) => {
      const resourceListener = resourceListeners.get(resourceLocalId);
      if (resourceListener === undefined) throw new Error('Expected the Resource watch to be established.');
      resourceListener({
        version: 1,
        subscriptionId: 'channels-surface-test',
        kind: 'invalidated',
        digest,
      });
    },
  };
}

function findByTestId(node: ReactTestRenderer, testID: string) {
  return node.root.findAll((instance) => instance.props?.testID === testID);
}

function findPressableByTestId(node: ReactTestRenderer, testID: string) {
  const pressable = findByTestId(node, testID).find(
    (instance) => typeof instance.props?.onPress === 'function',
  );
  if (!pressable) throw new Error(`Expected an interactive control for ${testID}.`);
  return pressable;
}

function findTextFieldByTestId(node: ReactTestRenderer, testID: string) {
  const textField = findByTestId(node, testID).find(
    (instance) => typeof instance.props?.onChangeText === 'function',
  );
  if (!textField) throw new Error(`Expected a text field for ${testID}.`);
  return textField;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function renderedTestIds(node: ReactTestRenderer): readonly string[] {
  return node.root.findAll((instance) => typeof instance.props?.testID === 'string')
    .map((instance) => instance.props.testID as string);
}

function hasRenderedHostType(instance: ReactTestInstance, type: string): boolean {
  return String(instance.type) === type;
}

function hasRenderedAncestor(instance: ReactTestInstance, type: string): boolean {
  let ancestor = instance.parent;
  while (ancestor !== null) {
    if (hasRenderedHostType(ancestor, type)) return true;
    ancestor = ancestor.parent;
  }
  return false;
}

function safeAreaOwnerCount(node: ReactTestRenderer): number {
  return node.root.findAll((instance) => {
    const insets = instance.props?.safeAreaInsets;
    return insets !== undefined
      && insets !== null
      && typeof insets === 'object'
      && 'top' in insets
      && 'right' in insets
      && 'bottom' in insets
      && 'left' in insets;
  }).length;
}

async function renderChannelsSurface(
  hostApi: ReturnType<typeof createChannelsHostApi>['hostApi'],
  surface = createChannelsSettingsSurfaceContextFixture(),
  presentationHost?: unknown,
  dataClient?: PluginUiDataClient,
) {
  const { renderSurface } = await import('../../../../../../packages/plugins/channels/src/ui/renderSurface');
  const element = renderSurface({
    plugin: { id: 'happier.channels', version: '0.0.0' },
    view: CHANNELS_SETTINGS_VIEW,
    surface,
    hostApi,
    signal: new AbortController().signal,
  } as never);
  if (!React.isValidElement(element)) {
    throw new Error('Channels renderSurface must return a React element.');
  }
  const effectiveDataClient = dataClient ?? createOfflineChannelsDataClient({ rows: [] }).client;
  const privateBindings = {
    ...(presentationHost === undefined ? {} : { presentationHost }),
    dataClient: effectiveDataClient,
  };
  const mountedElement = Object.keys(privateBindings).length === 0
    ? element
    : React.cloneElement(element as React.ReactElement<Record<string, unknown>>, privateBindings);
  let rendered: ReactTestRenderer | undefined;
  await act(async () => {
    rendered = create(mountedElement);
  });
  await flushHookEffects();
  if (!rendered) throw new Error('Expected Channels surface to mount.');
  return rendered;
}

function createChannelsBrandPresentationHost(names: Readonly<Record<string, string>>) {
  const resolveBrandDisplayName = vi.fn((pluginId: string) => names[pluginId] ?? 'Unavailable');
  const renderBrandMark = vi.fn((input: Readonly<{
    pluginId: string;
    size?: 'small' | 'medium' | 'large';
    showName?: boolean;
    externallyLabelled?: boolean;
    testID?: string;
  }>) => React.createElement('ProviderBrandMark', {
    testID: input.testID,
    accessible: input.externallyLabelled !== true,
    ...(input.externallyLabelled === true
      ? {}
      : { accessibilityLabel: resolveBrandDisplayName(input.pluginId) }),
  }));
  return {
    presentationHost: {
      brand: { displayName: 'Conversation Channels' },
      resolveBrandDisplayName,
      renderBrandMark,
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderPopover: () => null,
      renderIcon: () => null,
    } as never,
    resolveBrandDisplayName,
    renderBrandMark,
  };
}

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
  vi.restoreAllMocks();
});

describe('Channels settings surface (real source, mounted)', () => {
  it('uses bindings as the default management index and joins their connection presentation', async () => {
    const connection = connectionFixture({
      attention: {
        outwardDelivery: {
          retryDue: true,
          notDelivered: false,
          partial: false,
          outcomeUnknown: false,
        },
      },
    });
    const binding = bindingFixture();
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection]),
      readBindingsResource: async () => bindingResourceContent([binding]),
    });

    renderer = await renderChannelsSurface(host.hostApi);

    expect(host.watchResource).toHaveBeenCalledWith(
      CHANNELS_BINDINGS_RESOURCE,
      expect.any(Function),
      expect.any(Object),
    );
    expect(host.readResource).toHaveBeenCalledWith(
      CHANNELS_BINDINGS_RESOURCE,
      expect.any(Object),
    );
    const bindingRow = findByTestId(renderer, 'channels-binding-binding-1')[0];
    if (!bindingRow) throw new Error('Expected the binding row to render.');
    expect(bindingRow.props.accessibilityLabel).toContain('Support discussion');
    expect(bindingRow.props.accessibilityLabel).toContain('Session: session-support');
    expect(bindingRow.props.accessibilityLabel).toContain('Runs on your selected machine');
    expect(bindingRow.props.accessibilityLabel).toContain('Delivery is waiting to retry');
    expect(bindingRow.props.accessibilityLabel).toContain('Enabled');
    expect(findByTestId(renderer, 'channels-bindings-list').length).toBeGreaterThan(0);
  });

  it('projects an unavailable Session approval scope without granting or exposing approval authority', async () => {
    const connection = connectionFixture();
    const unavailableApprovalBinding = bindingFixture({
      approval: { kind: 'unavailable', maximumScope: 'request' },
    });
    const automationBinding = bindingFixture({
      bindingId: 'binding-automation',
      target: { kind: 'automation', summary: 'automation-daily' },
      deliveryMode: 'finalResult',
      approval: { kind: 'notApplicable' },
    });
    const writableApprovalOffBinding = bindingFixture({
      bindingId: 'binding-approval-off',
      approval: { kind: 'off' },
    });
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection]),
      readBindingsResource: async () => bindingResourceContent([
        unavailableApprovalBinding,
        automationBinding,
        writableApprovalOffBinding,
      ]),
    });

    renderer = await renderChannelsSurface(host.hostApi);

    const unavailableRow = findByTestId(renderer, 'channels-binding-binding-1')[0];
    if (!unavailableRow) throw new Error('Expected the unavailable-approval binding row to render.');
    expect(unavailableRow.props.detail).toContain('Approval requests are unavailable for request scope.');
    expect(unavailableRow.props.detail).toContain('This saved policy does not authorize messages.');
    expect(unavailableRow.props.accessibilityLabel).toContain('Approval requests are unavailable for request scope.');
    expect(unavailableRow.props.accessibilityLabel).toContain('This saved policy does not authorize messages.');
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-1').props.disabled).toBe(true);

    const automationRow = findByTestId(renderer, 'channels-binding-binding-automation')[0];
    if (!automationRow) throw new Error('Expected the Automation binding row to render.');
    expect(automationRow.props.detail).not.toContain('Approval requests are unavailable');
    expect(automationRow.props.accessibilityLabel).not.toContain('Approval requests are unavailable');
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-approval-off').props.disabled).toBe(false);
    expect(host.executeAction).not.toHaveBeenCalled();
  });

  it('uses the binding row revision for the canonical enablement Action and rereads its Resource', async () => {
    const connection = connectionFixture();
    let binding = bindingFixture();
    let bindingDigestCharacter = 'b';
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection]),
      readBindingsResource: async () => bindingResourceContent([binding], bindingDigestCharacter),
      executeAction: async (actionId, payload) => {
        expect(actionId).toBe('binding/set-enabled-v1');
        expect(payload).toEqual({
          bindingId: binding.bindingId,
          expectedRevision: binding.revision,
          enabled: false,
        });
        binding = bindingFixture({ revision: 7, enabled: false });
        bindingDigestCharacter = 'd';
        return {
          kind: 'updated',
          bindingId: binding.bindingId,
          revision: binding.revision,
          authorityEpoch: 7,
        };
      },
    });

    renderer = await renderChannelsSurface(host.hostApi);
    const toggle = findPressableByTestId(renderer, 'channels-binding-enabled-binding-1');
    expect(toggle.props.accessibilityRole).toBe('switch');
    expect(toggle.props.checked).toBe(true);

    await act(async () => {
      toggle.props.onPress();
      await Promise.resolve();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledTimes(1);
    expect(host.readResource.mock.calls.filter(([resource]) => (
      (resource as Readonly<{ localId: string }>).localId === CHANNELS_BINDINGS_RESOURCE.localId
    )).length).toBeGreaterThanOrEqual(2);
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-1').props.checked).toBe(false);
  });

  it('reads and CAS-writes Account-local binding policy cold offline without invoking daemon Resources or Actions', async () => {
    const connection = offlineConnectionStateRow();
    const binding = offlineBindingStateRow({ approval: 'off' });
    const targetedContributions = channelsProviderTargetedContributions();
    const data = createOfflineChannelsDataClient({ rows: [connection, binding] });
    const host = createChannelsHostApi({
      methods: ['executeAction', 'selectActionInput', 'watchContext'],
      readResource: async () => {
        throw Object.assign(new Error('Daemon Resource must not run in cold offline Account policy mode.'), {
          code: 'unavailable',
        });
      },
      executeAction: async () => {
        throw Object.assign(new Error('Daemon Action must not replace Account-local policy CAS.'), {
          code: 'unavailable',
        });
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture({ targetedContributions }),
      undefined,
      data.client,
    );
    await flushHookEffects();

    expect(data.query).toHaveBeenCalledWith(
      expect.objectContaining({
        index: CHANNEL_STATE_INDEX_ID.byKind,
        prefix: [CHANNEL_STATE_RECORD_KIND.binding],
        order: 'asc',
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(host.readResource).not.toHaveBeenCalled();
    expect(host.watchResource).not.toHaveBeenCalled();
    expect(host.selectActionInput).not.toHaveBeenCalled();
    expect(findByTestId(renderer, 'channels-provider-setup-picker')).toHaveLength(0);
    const row = findByTestId(renderer, 'channels-binding-binding-offline-1')[0];
    if (!row) throw new Error('Expected the Account-local binding row to render offline.');
    expect(row.props.accessibilityLabel).toContain('Offline support conversation');
    expect(row.props.accessibilityLabel).toContain('Session: session-visible-summary');
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-offline-1').props.checked).toBe(true);

    const renderedBeforeWrite = JSON.stringify(renderer.toJSON());
    expect(renderedBeforeWrite).not.toContain('endpoint-private');
    expect(renderedBeforeWrite).not.toContain('allowed-principal-private');
    expect(renderedBeforeWrite).not.toContain('approval-principal-private');
    expect(renderedBeforeWrite).not.toContain('new-session-principal-private');
    expect(renderedBeforeWrite).not.toContain('private-recipe');
    expect(renderedBeforeWrite).not.toContain('provider-config-private');
    expect(renderedBeforeWrite).not.toContain('materialization-private');

    const directReadsBeforeWrite = data.query.mock.calls.length;
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-binding-enabled-binding-offline-1').props.onPress();
      await Promise.resolve();
    });
    await flushHookEffects();

    expect(host.executeAction).not.toHaveBeenCalled();
    expect(data.batch).toHaveBeenCalledWith([
      {
        kind: 'assert',
        rowId: connection.rowId,
        expectedRevision: connection.revision,
      },
      expect.objectContaining({
        kind: 'put',
        expectedRevision: binding.revision,
        value: expect.objectContaining({
          id: binding.rowId,
          'record-kind': CHANNEL_STATE_RECORD_KIND.binding,
          payload: expect.objectContaining({
            enabled: false,
            authorityEpoch: 4,
          }),
        }),
      }),
    ], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(data.query.mock.calls.length).toBeGreaterThan(directReadsBeforeWrite);
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-offline-1').props.checked).toBe(false);
    const savedPendingMachineReconciliation = findByTestId(
      renderer,
      'channels-binding-saved-pending-machine-reconciliation',
    )[0];
    expect(savedPendingMachineReconciliation?.props.label).toBe(
      'Saved to your Account. The selected machine will reconcile this policy when it is available.',
    );
  });

  it('reads and CAS-writes Account-local connection policy cold offline without invoking daemon Resources or Actions', async () => {
    const connection = offlineConnectionStateRow();
    const binding = offlineBindingStateRow();
    const data = createOfflineChannelsDataClient({ rows: [connection, binding] });
    const host = createChannelsHostApi({
      methods: ['executeAction', 'watchContext'],
      readResource: async () => {
        throw new Error('Cold offline connection policy must not invoke a daemon Resource.');
      },
      executeAction: async () => {
        throw new Error('Cold offline connection policy must not invoke a daemon Action.');
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture(),
      undefined,
      data.client,
    );
    await flushHookEffects();

    expect(data.query).toHaveBeenCalledWith(
      expect.objectContaining({
        index: CHANNEL_STATE_INDEX_ID.byKind,
        prefix: [CHANNEL_STATE_RECORD_KIND.connection],
        order: 'asc',
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-offline-1').props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-connection-provider-actions-unavailable').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'channels-connection-delete')).toHaveLength(0);
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-enabled').props.onPress();
      findTextFieldByTestId(renderer!, 'channels-connection-observation-age').props.onChangeText('120000');
    });
    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-connection-save').props.onPress();
    });
    await flushHookEffects();

    expect(host.readResource).not.toHaveBeenCalled();
    expect(host.executeAction).not.toHaveBeenCalled();
    expect(data.batch).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'put',
        expectedRevision: connection.revision,
        value: expect.objectContaining({
          id: connection.rowId,
          'record-kind': CHANNEL_STATE_RECORD_KIND.connection,
          payload: expect.objectContaining({
            enabled: false,
            authorityEpoch: 3,
            maximumObservationAgeMs: 120_000,
          }),
        }),
      }),
    ], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(findByTestId(renderer, 'channels-binding-saved-pending-machine-reconciliation').length).toBeGreaterThan(0);
  });

  it('paginates the bounded 256-row Account-local binding index through the Data-owned 200-row page ceiling', async () => {
    const connection = offlineConnectionStateRow();
    const bindings = Array.from({ length: 256 }, (_, index) => offlineBindingStateRow({
      id: `binding-offline-${String(index + 1).padStart(3, '0')}`,
      connectionId: connection.rowId,
    }));
    const data = createOfflineChannelsDataClient({ rows: [connection, ...bindings] });
    const host = createChannelsHostApi({
      methods: ['executeAction', 'watchContext'],
      readResource: async () => {
        throw new Error('Direct Account policy pagination must not invoke a daemon Resource.');
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture(),
      undefined,
      data.client,
    );
    await flushHookEffects();

    const bindingQueries = data.query.mock.calls.filter(([request]) => (
      request.prefix?.[0] === CHANNEL_STATE_RECORD_KIND.binding
    ));
    expect(bindingQueries.length).toBeGreaterThanOrEqual(2);
    expect(bindingQueries.every(([request]) => (
      request.index === CHANNEL_STATE_INDEX_ID.byKind
      && request.order === 'asc'
      && request.limit !== undefined
      && request.limit <= 200
    ))).toBe(true);
    expect(bindingQueries.some(([request]) => request.cursor !== undefined)).toBe(true);
    expect(findByTestId(renderer, 'channels-binding-binding-offline-001').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'channels-binding-binding-offline-256').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'channels-binding-enabled-binding-offline-256').length).toBeGreaterThan(0);
    const bindingRows = renderer.root.findAll((instance) => (
      typeof instance.props?.testID === 'string'
      && instance.props.testID.startsWith('channels-binding-binding-offline-')
    ));
    expect(new Set(bindingRows.map((instance) => instance.props.testID)).size).toBe(256);
    expect(host.readResource).not.toHaveBeenCalled();
  });

  it('keeps advertised daemon Resource failure distinct from Account-policy fallback while retaining direct ingress attention', async () => {
    const data = createOfflineChannelsDataClient({
      rows: [offlineConnectionStateRow(), offlineBindingStateRow()],
    });
    const diagnostic = 'daemon-only resource diagnostic must not reach Account policy UI';
    const host = createChannelsHostApi({
      readResource: async () => {
        throw Object.assign(new Error(diagnostic), { code: 'unavailable' });
      },
      readBindingsResource: async () => {
        throw Object.assign(new Error(diagnostic), { code: 'unavailable' });
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture(),
      undefined,
      data.client,
    );
    await flushHookEffects();

    expect(host.readResource).toHaveBeenCalled();
    expect(data.query).toHaveBeenCalledWith({
      index: CHANNEL_STATE_INDEX_ID.byAttention,
      prefix: [true],
      order: 'asc',
      limit: 50,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(data.query.mock.calls.every(([request]) => (
      request.index === CHANNEL_STATE_INDEX_ID.byAttention
    ))).toBe(true);
    expect(findByTestId(renderer, 'channels-bindings-error').length).toBeGreaterThan(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(diagnostic);
  });

  it('keeps direct blocked-ingress recovery available while the advertised binding Resource is unavailable', async () => {
    const obligationId = 'I'.repeat(43);
    const data = createOfflineChannelsDataClient({
      rows: [ingressAttentionStateRow({ id: obligationId, revision: 7 })],
    });
    const host = createChannelsHostApi({
      readResource: async () => {
        throw Object.assign(new Error('Binding Resource details are unavailable.'), { code: 'unavailable' });
      },
      readBindingsResource: async () => {
        throw Object.assign(new Error('Binding Resource details are unavailable.'), { code: 'unavailable' });
      },
      executeAction: async (actionId, payload) => {
        expect(actionId).toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.ingressRetry);
        expect(payload).toEqual({ obligationId, expectedRevision: 7 });
        return { kind: 'retryScheduled', obligationId, revision: 8 };
      },
    });

    renderer = await renderChannelsSurface(host.hostApi, undefined, undefined, data.client);
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-bindings-error').length).toBeGreaterThan(0);
    expect(data.query).toHaveBeenCalledWith({
      index: CHANNEL_STATE_INDEX_ID.byAttention,
      prefix: [true],
      order: 'asc',
      limit: 50,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(data.query.mock.calls.every(([request]) => (
      request.index === CHANNEL_STATE_INDEX_ID.byAttention
    ))).toBe(true);
    const resourceReadsBeforeRetry = host.readResource.mock.calls.length;
    await act(async () => {
      await findPressableByTestId(
        renderer!,
        `channels-ingress-attention-retry-${obligationId}`,
      ).props.onPress();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledTimes(1);
    expect(host.readResource.mock.calls.length).toBe(resourceReadsBeforeRetry);
  });

  it('retains Account-local binding last-known-good rows without disclosing direct Data diagnostics', async () => {
    const connection = offlineConnectionStateRow();
    const binding = offlineBindingStateRow();
    const diagnostic = 'secret Account Data endpoint=never-disclose';
    let queryFailure: unknown;
    const data = createOfflineChannelsDataClient({
      rows: [connection, binding],
      queryFailure: () => queryFailure,
    });
    const host = createChannelsHostApi({
      methods: ['executeAction', 'watchContext'],
      readResource: async () => {
        throw new Error('A cold offline Account policy read must not reach the daemon Resource.');
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture(),
      undefined,
      data.client,
    );
    queryFailure = Object.assign(new Error(diagnostic), { code: 'unavailable' });
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-bindings-resource-refresh').props.onPress();
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-binding-binding-offline-1').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'channels-bindings-resource-stale').length).toBeGreaterThan(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(diagnostic);
    expect(host.readResource).not.toHaveBeenCalled();

    queryFailure = undefined;
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-bindings-resource-retry').props.onPress();
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-bindings-resource-stale')).toHaveLength(0);
  });

  it('blocks a direct Account-local binding retry after an unknown mutation outcome until an explicit reread settles', async () => {
    const connection = offlineConnectionStateRow();
    const binding = offlineBindingStateRow({ approval: 'off' });
    let batchFailure: unknown = Object.assign(
      new Error('The binding change may have reached the Account.'),
      { code: 'channels_binding_set_enabled_cancelled' },
    );
    const data = createOfflineChannelsDataClient({
      rows: [connection, binding],
      batchFailure: () => batchFailure,
    });
    const host = createChannelsHostApi({
      methods: ['executeAction', 'watchContext'],
      readResource: async () => {
        throw new Error('A cold offline Account policy mutation must not reach the daemon Resource.');
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture(),
      undefined,
      data.client,
    );
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-binding-enabled-binding-offline-1').props.onPress();
      await Promise.resolve();
    });
    await flushHookEffects();

    expect(data.batch).toHaveBeenCalledTimes(1);
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-offline-1').props.disabled).toBe(true);
    const reconcile = findPressableByTestId(
      renderer,
      'channels-binding-outcome-unknown-reconcile-binding-offline-1',
    );
    const readsBeforeExplicitReread = data.query.mock.calls.length;
    batchFailure = undefined;
    await act(async () => {
      reconcile.props.onPress();
    });
    await flushHookEffects();

    expect(data.query.mock.calls.length).toBeGreaterThan(readsBeforeExplicitReread);
    expect(findByTestId(renderer, 'channels-binding-outcome-unknown-reconcile-binding-offline-1')).toHaveLength(0);
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-offline-1').props.disabled).toBe(false);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-binding-enabled-binding-offline-1').props.onPress();
      await Promise.resolve();
    });
    await flushHookEffects();

    expect(data.batch).toHaveBeenCalledTimes(2);
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-offline-1').props.checked).toBe(false);
    expect(host.readResource).not.toHaveBeenCalled();
  });

  it('requires an explicit reread after the direct Account writer loses a committed binding CAS response', async () => {
    const connection = offlineConnectionStateRow();
    const binding = offlineBindingStateRow({ approval: 'off' });
    let batchFailureAfterCommit: unknown = Object.assign(
      new Error('The direct Account mutation response was cancelled after commit.'),
      { code: 'plugin_collection_cancelled' },
    );
    const data = createOfflineChannelsDataClient({
      rows: [connection, binding],
      batchFailureAfterCommit: () => batchFailureAfterCommit,
    });
    const host = createChannelsHostApi({
      methods: ['executeAction', 'watchContext'],
      readResource: async () => {
        throw new Error('A cold offline Account policy mutation must not reach the daemon Resource.');
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture(),
      undefined,
      data.client,
    );
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-binding-enabled-binding-offline-1').props.onPress();
      await Promise.resolve();
    });
    await flushHookEffects();

    expect(data.rows.get(binding.rowId)).toMatchObject({
      revision: binding.revision + 1,
      value: {
        payload: { enabled: false, authorityEpoch: 4 },
      },
    });
    expect(host.executeAction).not.toHaveBeenCalled();
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-offline-1').props.disabled).toBe(true);
    const reconcile = findPressableByTestId(
      renderer,
      'channels-binding-outcome-unknown-reconcile-binding-offline-1',
    );
    const readsBeforeExplicitReread = data.query.mock.calls.length;
    batchFailureAfterCommit = undefined;
    await act(async () => {
      reconcile.props.onPress();
    });
    await flushHookEffects();

    expect(data.query.mock.calls.length).toBeGreaterThan(readsBeforeExplicitReread);
    expect(findByTestId(renderer, 'channels-binding-outcome-unknown-reconcile-binding-offline-1')).toHaveLength(0);
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-offline-1').props.checked).toBe(false);
    expect(host.readResource).not.toHaveBeenCalled();
  });

  it('requires an explicit reread after the direct Account writer loses a committed connection-policy CAS response', async () => {
    const connection = offlineConnectionStateRow();
    const binding = offlineBindingStateRow();
    let batchFailureAfterCommit: unknown = Object.assign(
      new Error('The direct Account mutation response was cancelled after commit.'),
      { code: 'plugin_collection_cancelled' },
    );
    const data = createOfflineChannelsDataClient({
      rows: [connection, binding],
      batchFailureAfterCommit: () => batchFailureAfterCommit,
    });
    const host = createChannelsHostApi({
      methods: ['executeAction', 'watchContext'],
      readResource: async () => {
        throw new Error('A cold offline Account policy mutation must not reach the daemon Resource.');
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture(),
      undefined,
      data.client,
    );
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-offline-1').props.onPress();
    });
    await flushHookEffects();
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-enabled').props.onPress();
      findTextFieldByTestId(renderer!, 'channels-connection-observation-age').props.onChangeText('120000');
    });
    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-connection-save').props.onPress();
    });
    await flushHookEffects();

    expect(data.rows.get(connection.rowId)).toMatchObject({
      revision: connection.revision + 1,
      value: {
        payload: {
          enabled: false,
          authorityEpoch: 3,
          maximumObservationAgeMs: 120_000,
        },
      },
    });
    expect(host.executeAction).not.toHaveBeenCalled();
    expect(findByTestId(renderer, 'channels-save-outcome-unknown').length).toBeGreaterThan(0);
    expect(findPressableByTestId(renderer, 'channels-connection-save').props.disabled).toBe(true);
    const reconcile = findPressableByTestId(renderer, 'channels-save-outcome-unknown-reconcile');
    const readsBeforeExplicitReread = data.query.mock.calls.length;
    batchFailureAfterCommit = undefined;
    await act(async () => {
      reconcile.props.onPress();
    });
    await flushHookEffects();

    expect(data.query.mock.calls.length).toBeGreaterThan(readsBeforeExplicitReread);
    expect(findByTestId(renderer, 'channels-save-outcome-unknown')).toHaveLength(0);
    expect(findPressableByTestId(renderer, 'channels-connection-enabled').props.checked).toBe(false);
    expect(findTextFieldByTestId(renderer, 'channels-connection-observation-age').props.value).toBe('120000');
    expect(host.readResource).not.toHaveBeenCalled();
  });

  it('retains binding last-known-good rows without disclosing Resource diagnostics', async () => {
    const connection = connectionFixture();
    const binding = bindingFixture();
    const diagnostic = 'secret: Account binding token=shh';
    let failBindingRefresh = false;
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection]),
      readBindingsResource: async () => {
        if (failBindingRefresh) {
          throw Object.assign(new Error(diagnostic), { code: 'plugin_resource_unavailable' });
        }
        return bindingResourceContent([binding]);
      },
    });

    renderer = await renderChannelsSurface(host.hostApi);
    failBindingRefresh = true;
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-bindings-resource-refresh').props.onPress();
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-binding-binding-1').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'channels-bindings-resource-stale').length).toBeGreaterThan(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(diagnostic);

    failBindingRefresh = false;
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-bindings-resource-retry').props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-bindings-resource-stale')).toHaveLength(0);
  });

  it('blocks binding resubmission after an unknown outcome until a requested fresh reread settles', async () => {
    const connection = connectionFixture();
    const binding = bindingFixture();
    let deferReconciliationRead = false;
    let resolveReconciliationRead: ((content: ReturnType<typeof bindingResourceContent>) => void) | undefined;
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection]),
      readBindingsResource: async () => {
        if (deferReconciliationRead) {
          deferReconciliationRead = false;
          return new Promise<ReturnType<typeof bindingResourceContent>>((resolve) => {
            resolveReconciliationRead = resolve;
          });
        }
        return bindingResourceContent([binding]);
      },
      executeAction: async () => {
        throw Object.assign(new Error('The binding update may have reached the Account.'), { code: 'timeout' });
      },
    });

    renderer = await renderChannelsSurface(host.hostApi);
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-binding-enabled-binding-1').props.onPress();
      await Promise.resolve();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledTimes(1);
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-1').props.disabled).toBe(true);
    const reconcile = findPressableByTestId(
      renderer,
      'channels-binding-outcome-unknown-reconcile-binding-1',
    );
    const readsBeforeExplicitRefresh = host.readResource.mock.calls.length;
    deferReconciliationRead = true;
    await act(async () => {
      reconcile.props.onPress();
    });
    await flushHookEffects();

    expect(host.readResource.mock.calls.length).toBeGreaterThan(readsBeforeExplicitRefresh);
    expect(resolveReconciliationRead).toBeDefined();
    await act(async () => {
      resolveReconciliationRead?.(bindingResourceContent([binding]));
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-binding-outcome-unknown-reconcile-binding-1')).toHaveLength(0);
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-1').props.disabled).toBe(false);
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-binding-enabled-binding-1').props.onPress();
      await Promise.resolve();
    });
    await flushHookEffects();
    expect(host.executeAction).toHaveBeenCalledTimes(2);
  });

  it('keeps unknown binding outcome reconciliation visible when a live reread removes that row', async () => {
    const connection = connectionFixture();
    const firstBinding = bindingFixture();
    const secondBinding = bindingFixture({
      bindingId: 'binding-2',
      endpoint: { label: 'Build discussion' },
    });
    let bindings: readonly BindingResourceRow[] = [firstBinding, secondBinding];
    let bindingDigestCharacter = 'b';
    let deferReconciliationRead = false;
    let resolveReconciliationRead: ((content: ReturnType<typeof bindingResourceContent>) => void) | undefined;
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection]),
      readBindingsResource: async () => {
        if (deferReconciliationRead) {
          deferReconciliationRead = false;
          return new Promise<ReturnType<typeof bindingResourceContent>>((resolve) => {
            resolveReconciliationRead = resolve;
          });
        }
        return bindingResourceContent(bindings, bindingDigestCharacter);
      },
      executeAction: async () => {
        throw Object.assign(new Error('The binding update may have reached the Account.'), { code: 'timeout' });
      },
    });

    renderer = await renderChannelsSurface(host.hostApi);
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-binding-enabled-binding-1').props.onPress();
      await Promise.resolve();
    });
    await flushHookEffects();

    bindings = [secondBinding];
    bindingDigestCharacter = 'd';
    await act(async () => {
      host.invalidateResource(
        resourceDigest(bindingDigestCharacter),
        CHANNELS_BINDINGS_RESOURCE.localId,
      );
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-binding-binding-1')).toHaveLength(0);
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-2').props.disabled).toBe(true);
    const reconcile = findPressableByTestId(renderer, 'channels-binding-outcome-unknown-reconcile');
    deferReconciliationRead = true;
    await act(async () => {
      reconcile.props.onPress();
    });
    await flushHookEffects();

    expect(resolveReconciliationRead).toBeDefined();
    await act(async () => {
      resolveReconciliationRead?.(bindingResourceContent(bindings, bindingDigestCharacter));
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-binding-outcome-unknown-reconcile')).toHaveLength(0);
    expect(findPressableByTestId(renderer, 'channels-binding-enabled-binding-2').props.disabled).toBe(false);
  });

  it('offers provider filters only when the joined binding rows span multiple provider types', async () => {
    const firstConnection = connectionFixture({
      providerPluginId: 'example.channel.alpha',
      integrationPrincipalLabel: 'Alpha Relay',
    });
    const firstBinding = bindingFixture();
    const singleProviderHost = createChannelsHostApi({
      readResource: async () => connectionResourceContent([firstConnection]),
      readBindingsResource: async () => bindingResourceContent([firstBinding]),
    });
    renderer = await renderChannelsSurface(singleProviderHost.hostApi);
    expect(findByTestId(renderer, 'channels-binding-provider-filters')).toHaveLength(0);

    act(() => renderer?.unmount());
    renderer = null;
    const secondConnection = connectionFixture({
      connectionId: 'connection-2',
      providerPluginId: 'example.channel.beta',
      integrationPrincipalLabel: 'Beta Relay',
    });
    const secondBinding = bindingFixture({
      bindingId: 'binding-2',
      connectionId: secondConnection.connectionId,
      endpoint: { label: 'Build discussion' },
    });
    const multiProviderHost = createChannelsHostApi({
      readResource: async () => connectionResourceContent([firstConnection, secondConnection]),
      readBindingsResource: async () => bindingResourceContent([firstBinding, secondBinding]),
    });
    renderer = await renderChannelsSurface(multiProviderHost.hostApi);

    expect(findByTestId(renderer, 'channels-binding-provider-filters').length).toBeGreaterThan(0);
    const allProviders = findPressableByTestId(renderer, 'channels-binding-provider-filters:all');
    expect(allProviders.props.accessibilityRole).toBe('tab');
    const alphaProviders = findPressableByTestId(
      renderer,
      'channels-binding-provider-filters:example.channel.alpha',
    );
    await act(async () => {
      alphaProviders.props.onPress();
    });
    await flushHookEffects();

    expect(alphaProviders.props.selected).toBe(true);
    expect(findByTestId(renderer, 'channels-binding-binding-1').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'channels-binding-binding-2')).toHaveLength(0);
  });

  it('projects admitted setup and existing binding brands through the installed plugin presentation', async () => {
    const targetedContributions = channelsProviderTargetedContributions();
    const alphaProviderId = 'example.channel.alpha';
    const betaProviderId = 'example.channel.beta';
    const alphaConnection = connectionFixture({
      connectionId: 'connection-alpha',
      providerPluginId: alphaProviderId,
      integrationPrincipalLabel: 'Zulu connection identity',
    });
    const duplicateAlphaConnection = connectionFixture({
      connectionId: 'connection-alpha-2',
      providerPluginId: alphaProviderId,
      integrationPrincipalLabel: 'Another Alpha connection',
    });
    const betaConnection = connectionFixture({
      connectionId: 'connection-beta',
      providerPluginId: betaProviderId,
      integrationPrincipalLabel: 'Alpha connection identity',
    });
    const host = createChannelsHostApi({
      methods: ['executeAction', 'readResource', 'selectActionInput', 'watchContext', 'watchResource'],
      readResource: async () => connectionResourceContent([
        betaConnection,
        duplicateAlphaConnection,
        alphaConnection,
      ]),
      readBindingsResource: async () => bindingResourceContent([
        bindingFixture({ bindingId: 'binding-alpha', connectionId: alphaConnection.connectionId }),
        bindingFixture({ bindingId: 'binding-alpha-2', connectionId: duplicateAlphaConnection.connectionId }),
        bindingFixture({ bindingId: 'binding-beta', connectionId: betaConnection.connectionId }),
      ]),
      selectActionInput: async () => ({ kind: 'cancelled' }),
    });
    const brands = createChannelsBrandPresentationHost({
      [alphaProviderId]: 'Alpha Provider',
      [betaProviderId]: 'Beta Provider',
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture({
        targetedContributions,
      }),
      brands.presentationHost,
    );

    const filterIds = [...new Set(renderedTestIds(renderer).filter((testID) => (
      testID.startsWith('channels-binding-provider-filters:')
    )))];
    expect(filterIds).toEqual([
      'channels-binding-provider-filters:all',
      `channels-binding-provider-filters:${alphaProviderId}`,
      `channels-binding-provider-filters:${betaProviderId}`,
    ]);
    const alphaTab = findPressableByTestId(renderer, `channels-binding-provider-filters:${alphaProviderId}`);
    const betaTab = findPressableByTestId(renderer, `channels-binding-provider-filters:${betaProviderId}`);
    expect(alphaTab.props.accessibilityLabel).toBe('Alpha Provider');
    expect(betaTab.props.accessibilityLabel).toBe('Beta Provider');
    expect(alphaTab.props.accessibilityLabel).not.toContain(alphaConnection.integrationPrincipalLabel);
    expect(betaTab.props.accessibilityLabel).not.toContain(betaConnection.integrationPrincipalLabel);
    expect(brands.resolveBrandDisplayName).toHaveBeenCalledWith(alphaProviderId);
    expect(brands.resolveBrandDisplayName).toHaveBeenCalledWith(betaProviderId);
    expect(findByTestId(renderer, `channels-provider-brand-filter-${alphaProviderId}`).some(
      (instance) => instance.props.accessible === false && instance.props.accessibilityLabel === undefined,
    )).toBe(true);
    expect(findByTestId(renderer, `channels-provider-brand-filter-${betaProviderId}`).some(
      (instance) => instance.props.accessible === false && instance.props.accessibilityLabel === undefined,
    )).toBe(true);
    expect(brands.renderBrandMark).toHaveBeenCalledWith({
      pluginId: alphaProviderId,
      size: 'small',
      showName: false,
      externallyLabelled: true,
      testID: `channels-provider-brand-filter-${alphaProviderId}`,
    });
    expect(brands.renderBrandMark).toHaveBeenCalledWith({
      pluginId: betaProviderId,
      size: 'small',
      showName: false,
      externallyLabelled: true,
      testID: `channels-provider-brand-filter-${betaProviderId}`,
    });

    const alphaBinding = findByTestId(renderer, 'channels-binding-binding-alpha')[0];
    const betaBinding = findByTestId(renderer, 'channels-binding-binding-beta')[0];
    expect(alphaBinding?.props.accessibilityLabel).toContain('Provider: Alpha Provider');
    expect(alphaBinding?.props.accessibilityLabel).not.toContain(alphaConnection.integrationPrincipalLabel);
    expect(betaBinding?.props.accessibilityLabel).toContain('Provider: Beta Provider');
    expect(betaBinding?.props.accessibilityLabel).not.toContain(betaConnection.integrationPrincipalLabel);
    expect(findByTestId(renderer, 'channels-provider-brand-binding-binding-alpha').some(
      (instance) => instance.props.accessible === false && instance.props.accessibilityLabel === undefined,
    )).toBe(true);
    expect(findByTestId(renderer, 'channels-provider-brand-binding-binding-beta').some(
      (instance) => instance.props.accessible === false && instance.props.accessibilityLabel === undefined,
    )).toBe(true);
    expect(brands.renderBrandMark).toHaveBeenCalledWith({
      pluginId: alphaProviderId,
      size: 'small',
      showName: false,
      externallyLabelled: true,
      testID: 'channels-provider-brand-binding-binding-alpha',
    });
    expect(brands.renderBrandMark).toHaveBeenCalledWith({
      pluginId: betaProviderId,
      size: 'small',
      showName: false,
      externallyLabelled: true,
      testID: 'channels-provider-brand-binding-binding-beta',
    });

    const alphaSetup = findPressableByTestId(
      renderer,
      'channels-provider-setup-example.channel.alpha-provider',
    );
    const betaSetup = findPressableByTestId(
      renderer,
      'channels-provider-setup-example.channel.beta-provider',
    );
    expect(alphaSetup.props.accessibilityLabel).toBe('Set up Alpha Provider');
    expect(betaSetup.props.accessibilityLabel).toBe('Set up Beta Provider');
    expect(findByTestId(renderer, 'channels-provider-setup-brand-example.channel.alpha-provider').some(
      (instance) => instance.props.accessible === false && instance.props.accessibilityLabel === undefined,
    )).toBe(true);
    expect(findByTestId(renderer, 'channels-provider-setup-brand-example.channel.beta-provider').some(
      (instance) => instance.props.accessible === false && instance.props.accessibilityLabel === undefined,
    )).toBe(true);
    expect(brands.renderBrandMark).toHaveBeenCalledWith({
      pluginId: alphaProviderId,
      size: 'small',
      showName: false,
      externallyLabelled: true,
      testID: 'channels-provider-setup-brand-example.channel.alpha-provider',
    });
    expect(brands.renderBrandMark).toHaveBeenCalledWith({
      pluginId: betaProviderId,
      size: 'small',
      showName: false,
      externallyLabelled: true,
      testID: 'channels-provider-setup-brand-example.channel.beta-provider',
    });

    await act(async () => {
      betaTab.props.onPress();
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-binding-binding-beta').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'channels-binding-binding-alpha')).toHaveLength(0);
    expect(findByTestId(renderer, 'channels-binding-binding-alpha-2')).toHaveLength(0);
  });

  it('uses one neutral, labelled filter fallback when no canonical provider presentation is mounted', async () => {
    const alphaProviderId = 'example.channel.alpha';
    const betaProviderId = 'example.channel.beta';
    const alphaConnection = connectionFixture({
      connectionId: 'connection-alpha',
      providerPluginId: alphaProviderId,
      integrationPrincipalLabel: 'Connection-only Alpha label',
    });
    const betaConnection = connectionFixture({
      connectionId: 'connection-beta',
      providerPluginId: betaProviderId,
      integrationPrincipalLabel: 'Connection-only Beta label',
    });
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([betaConnection, alphaConnection]),
      readBindingsResource: async () => bindingResourceContent([
        bindingFixture({ bindingId: 'binding-alpha', connectionId: alphaConnection.connectionId }),
        bindingFixture({ bindingId: 'binding-beta', connectionId: betaConnection.connectionId }),
      ]),
    });

    renderer = await renderChannelsSurface(host.hostApi);

    const alphaTab = findPressableByTestId(renderer, `channels-binding-provider-filters:${alphaProviderId}`);
    const betaTab = findPressableByTestId(renderer, `channels-binding-provider-filters:${betaProviderId}`);
    expect(alphaTab.props.accessibilityLabel).toBe('Integration provider');
    expect(betaTab.props.accessibilityLabel).toBe('Integration provider');
    expect(alphaTab.props.accessibilityLabel).not.toContain(alphaConnection.integrationPrincipalLabel);
    expect(betaTab.props.accessibilityLabel).not.toContain(betaConnection.integrationPrincipalLabel);
    expect(findByTestId(renderer, `channels-provider-brand-filter-${alphaProviderId}`).length).toBeGreaterThan(0);
    expect(findByTestId(renderer, `channels-provider-brand-filter-${betaProviderId}`).length).toBeGreaterThan(0);
  });

  it('keeps a representative maximum binding list virtualized with accessible enable controls', async () => {
    const connection = connectionFixture();
    const bindings = Array.from({ length: 256 }, (_unused, index) => bindingFixture({
      bindingId: `binding-${String(index + 1).padStart(3, '0')}`,
      revision: index + 1,
      endpoint: { label: `External discussion ${index + 1}` },
    }));
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection]),
      readBindingsResource: async () => bindingResourceContent(bindings),
    });

    renderer = await renderChannelsSurface(host.hostApi);

    const renderedBindingRows = new Set(renderedTestIds(renderer).filter((testID) => (
      /^channels-binding-binding-\d{3}$/u.test(testID)
    )));
    expect(renderedBindingRows.size).toBe(256);
    const virtualizedLists = renderer.root.findAll((instance) => (
      hasRenderedHostType(instance, 'FlatList') && instance.props?.testID === 'channels-bindings-list'
    ));
    expect(virtualizedLists.some((list) => (
      list.props.data?.length === 256 && !hasRenderedAncestor(list, 'ScrollView')
    ))).toBe(true);
    const firstToggle = findPressableByTestId(renderer, 'channels-binding-enabled-binding-001');
    expect(firstToggle.props.accessibilityRole).toBe('switch');
    expect(firstToggle.props.accessibilityLabel).toBe('Binding enabled');
    expect(firstToggle.props.checked).toBe(true);
  });

  it('uses the management Resource row and its revision for the canonical update action', async () => {
    const connection = connectionFixture();
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection]),
      executeAction: async (actionId, payload) => {
        expect(actionId).toBe('connection/update-v1');
        expect(payload).toEqual({
          connectionId: connection.connectionId,
          expectedRevision: connection.revision,
          enabled: false,
          maximumObservationAgeMs: 180_000,
        });
        return {
          kind: 'updated',
          connectionId: connection.connectionId,
          revision: 5,
          authorityEpoch: 2,
        };
      },
    });
    const brands = createChannelsBrandPresentationHost({
      [connection.providerPluginId]: 'Telegram Business',
    });

    renderer = await renderChannelsSurface(host.hostApi, undefined, brands.presentationHost);

    expect(host.watchResource).toHaveBeenCalledWith(
      CHANNELS_CONNECTIONS_RESOURCE,
      expect.any(Function),
      expect.any(Object),
    );
    expect(host.readResource).toHaveBeenCalledWith(
      CHANNELS_CONNECTIONS_RESOURCE,
      expect.any(Object),
    );
    const connectionRow = findPressableByTestId(renderer, 'channels-connection-connection-1');
    expect(connectionRow.props.accessibilityLabel).toContain('Telegram Business');
    expect(connectionRow.props.accessibilityLabel).not.toContain(connection.providerPluginId);
    expect(connectionRow.props.accessibilityLabel).not.toContain(connection.selectedMachineId);
    expect(connectionRow.props.accessibilityLabel).not.toContain(connection.selectedTransport);
    expect(findByTestId(renderer, 'channels-provider-monogram-connection-1')).toHaveLength(0);
    expect(findByTestId(renderer, 'channels-provider-brand-connection-1').some(
      (instance) => instance.props.accessible === false && instance.props.accessibilityLabel === undefined,
    )).toBe(true);
    expect(brands.renderBrandMark).toHaveBeenCalledWith({
      pluginId: connection.providerPluginId,
      size: 'small',
      showName: false,
      externallyLabelled: true,
      testID: 'channels-provider-brand-connection-1',
    });

    await act(async () => {
      connectionRow.props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-connection-connection-1').length).toBeGreaterThan(0);
    expect(findPressableByTestId(renderer, 'channels-connection-connection-1').props.accessibilityExpanded).toBe(true);
    expect(findByTestId(renderer, 'channels-connection-detail').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'channels-connection-back')).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(connection.providerPluginId);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-enabled').props.onPress();
      findTextFieldByTestId(renderer!, 'channels-connection-observation-age').props.onChangeText('180000');
    });
    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-connection-save').props.onPress();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledTimes(1);
    expect(host.readResource.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(findByTestId(renderer, 'channels-save-outcome').some(
      (instance) => instance.props?.accessibilityLiveRegion === 'polite',
    )).toBe(true);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-connection-detail')).toHaveLength(0);
    expect(findPressableByTestId(renderer, 'channels-connection-connection-1').props.accessibilityExpanded).toBe(false);
  });

  it('places an early selected connection form immediately after its row in a full list', async () => {
    const connections = connectionFixtures(32);
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent(connections),
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();

    const testIds = renderedTestIds(renderer);
    const selectedRow = testIds.indexOf('channels-connection-connection-1');
    const detail = testIds.indexOf('channels-connection-detail');
    const firstFormControl = testIds.indexOf('channels-connection-enabled');
    const nextRow = testIds.indexOf('channels-connection-connection-2');
    expect(selectedRow).toBeGreaterThanOrEqual(0);
    expect(detail).toBeGreaterThan(selectedRow);
    expect(firstFormControl).toBeGreaterThan(detail);
    expect(firstFormControl).toBeLessThan(nextRow);
    expect(findPressableByTestId(renderer, 'channels-connection-connection-1').props.accessibilityExpanded).toBe(true);
    expect(findByTestId(renderer, 'channels-connection-back')).toHaveLength(0);
    const detailHasListItemAncestor = findByTestId(renderer, 'channels-connection-detail').some((detailInstance) => {
      let ancestor = detailInstance.parent;
      while (ancestor !== null) {
        if (ancestor.props?.role === 'listitem') return true;
        ancestor = ancestor.parent;
      }
      return false;
    });
    expect(detailHasListItemAncestor).toBe(true);
  });

  it('sorts current attention before user-facing labels rather than Resource collection order', async () => {
    let connections = [
      connectionFixture({
        connectionId: 'connection-zulu',
        integrationPrincipalLabel: 'Zulu',
      }),
      connectionFixture({
        connectionId: 'connection-alpha',
        integrationPrincipalLabel: 'Alpha',
      }),
      connectionFixture({
        connectionId: 'connection-warning-zinnia',
        integrationPrincipalLabel: 'Zinnia',
        attention: { bestEffortBeforeDurableAdmission: true },
      }),
      connectionFixture({
        connectionId: 'connection-danger-bravo',
        integrationPrincipalLabel: 'Bravo',
        attention: {
          historyGap: {
            reportedAt: 1_700_000_000_000,
            reason: 'applicationAdmissionLost',
          },
        },
      }),
      connectionFixture({
        connectionId: 'connection-warning-charlie',
        integrationPrincipalLabel: 'Charlie',
        attention: { oldTransportStopUnconfirmed: true },
      }),
    ];
    let digestCharacter = 'c';
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent(connections, digestCharacter),
    });
    renderer = await renderChannelsSurface(host.hostApi);

    const rowOrder = [...new Set(renderedTestIds(renderer).filter(
      (testID) => testID.startsWith('channels-connection-') && !testID.startsWith('channels-connection-status-'),
    ))];
    expect(rowOrder).toEqual([
      'channels-connection-connection-danger-bravo',
      'channels-connection-connection-warning-charlie',
      'channels-connection-connection-warning-zinnia',
      'channels-connection-connection-alpha',
      'channels-connection-connection-zulu',
    ]);

    connections = [
      connectionFixture({
        connectionId: 'connection-zulu',
        integrationPrincipalLabel: 'Zulu',
      }),
      connectionFixture({
        connectionId: 'connection-alpha',
        integrationPrincipalLabel: 'Alpha',
        attention: {
          historyGap: {
            reportedAt: 1_700_000_000_000,
            reason: 'applicationAdmissionLost',
          },
        },
      }),
      connectionFixture({
        connectionId: 'connection-warning-zinnia',
        integrationPrincipalLabel: 'Zinnia',
        attention: { bestEffortBeforeDurableAdmission: true },
      }),
      connectionFixture({
        connectionId: 'connection-danger-bravo',
        integrationPrincipalLabel: 'Bravo',
      }),
      connectionFixture({
        connectionId: 'connection-warning-charlie',
        integrationPrincipalLabel: 'Charlie',
        attention: { oldTransportStopUnconfirmed: true },
      }),
    ];
    digestCharacter = 'd';
    await act(async () => {
      host.invalidateResource(resourceDigest(digestCharacter));
    });
    await flushHookEffects();

    const refreshedRowOrder = [...new Set(renderedTestIds(renderer).filter(
      (testID) => testID.startsWith('channels-connection-') && !testID.startsWith('channels-connection-status-'),
    ))];
    expect(refreshedRowOrder).toEqual([
      'channels-connection-connection-alpha',
      'channels-connection-connection-warning-charlie',
      'channels-connection-connection-warning-zinnia',
      'channels-connection-connection-danger-bravo',
      'channels-connection-connection-zulu',
    ]);
  });

  it('validates exact observation-age boundary neighbors before dispatching the update Action', async () => {
    const connection = connectionFixture();
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection]),
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();

    const field = () => findTextFieldByTestId(renderer!, 'channels-connection-observation-age');
    const save = () => findPressableByTestId(renderer!, 'channels-connection-save');

    await act(async () => {
      field().props.onChangeText(String(MIN_CONVERSATION_OBSERVATION_AGE_MS - 1));
    });
    await act(async () => {
      await save().props.onPress();
    });
    expect(host.executeAction).not.toHaveBeenCalled();

    await act(async () => {
      field().props.onChangeText(String(MIN_CONVERSATION_OBSERVATION_AGE_MS));
    });
    await act(async () => {
      await save().props.onPress();
    });
    await flushHookEffects();
    expect(host.executeAction).toHaveBeenLastCalledWith('connection/update-v1', {
      connectionId: connection.connectionId,
      expectedRevision: connection.revision,
      enabled: connection.enabled,
      maximumObservationAgeMs: MIN_CONVERSATION_OBSERVATION_AGE_MS,
    });

    await act(async () => {
      field().props.onChangeText(String(MAX_CONVERSATION_OBSERVATION_AGE_MS + 1));
    });
    await act(async () => {
      await save().props.onPress();
    });
    expect(host.executeAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      field().props.onChangeText(String(MAX_CONVERSATION_OBSERVATION_AGE_MS));
    });
    await act(async () => {
      await save().props.onPress();
    });
    await flushHookEffects();
    expect(host.executeAction).toHaveBeenLastCalledWith('connection/update-v1', {
      connectionId: connection.connectionId,
      expectedRevision: connection.revision,
      enabled: connection.enabled,
      maximumObservationAgeMs: MAX_CONVERSATION_OBSERVATION_AGE_MS,
    });
  });

  it('unlocks an unknown update only after a requested fresh reread, even when its digest is unchanged', async () => {
    const connection = connectionFixture();
    let deferReconciliationRead = false;
    let resolveReconciliationRead: ((content: ReturnType<typeof connectionResourceContent>) => void) | undefined;
    const host = createChannelsHostApi({
      readResource: async () => {
        if (deferReconciliationRead) {
          deferReconciliationRead = false;
          return new Promise<ReturnType<typeof connectionResourceContent>>((resolve) => {
            resolveReconciliationRead = resolve;
          });
        }
        return connectionResourceContent([connection]);
      },
      executeAction: async () => {
        throw Object.assign(new Error('The update may have reached the Account.'), { code: 'timeout' });
      },
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-connection-save').props.onPress();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledTimes(1);
    expect(findByTestId(renderer, 'channels-save-outcome-unknown').length).toBeGreaterThan(0);
    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-connection-save').props.onPress();
    });
    expect(host.executeAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-connection-detail')).toHaveLength(0);
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-save-outcome-unknown').length).toBeGreaterThan(0);
    expect(findPressableByTestId(renderer, 'channels-connection-save').props.disabled).toBe(true);

    const readsBeforeExplicitRefresh = host.readResource.mock.calls.length;
    deferReconciliationRead = true;
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-save-outcome-unknown-reconcile').props.onPress();
    });
    await flushHookEffects();

    expect(host.readResource.mock.calls.length).toBeGreaterThan(readsBeforeExplicitRefresh);
    expect(resolveReconciliationRead).toBeDefined();
    expect(findByTestId(renderer, 'channels-save-outcome-unknown').length).toBeGreaterThan(0);
    await act(async () => {
      resolveReconciliationRead?.(connectionResourceContent([connection]));
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-save-outcome-unknown')).toHaveLength(0);
    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-connection-save').props.onPress();
    });
    expect(host.executeAction).toHaveBeenCalledTimes(2);
  });

  it('arms one unknown-outcome reconciliation press from a stale Resource snapshot', async () => {
    const connection = connectionFixture();
    let failRefresh = false;
    let deferReconciliationRead = false;
    let resolveReconciliationRead: ((content: ReturnType<typeof connectionResourceContent>) => void) | undefined;
    const host = createChannelsHostApi({
      readResource: async () => {
        if (failRefresh) {
          throw Object.assign(new Error('stale diagnostic should not reach the surface'), {
            code: 'plugin_resource_unavailable',
          });
        }
        if (deferReconciliationRead) {
          deferReconciliationRead = false;
          return new Promise<ReturnType<typeof connectionResourceContent>>((resolve) => {
            resolveReconciliationRead = resolve;
          });
        }
        return connectionResourceContent([connection]);
      },
      executeAction: async () => {
        throw Object.assign(new Error('The update may have reached the Account.'), { code: 'timeout' });
      },
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    failRefresh = true;
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-detail-resource-refresh').props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-resource-stale').length).toBeGreaterThan(0);

    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-connection-save').props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-save-outcome-unknown').length).toBeGreaterThan(0);

    failRefresh = false;
    deferReconciliationRead = true;
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-save-outcome-unknown-reconcile').props.onPress();
    });
    await flushHookEffects();
    expect(resolveReconciliationRead).toBeDefined();
    expect(findByTestId(renderer, 'channels-save-outcome-unknown').length).toBeGreaterThan(0);
    await act(async () => {
      resolveReconciliationRead?.(connectionResourceContent([connection]));
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-save-outcome-unknown')).toHaveLength(0);
  });

  it('keeps an unknown update locked across a live revision until the user requests a reread', async () => {
    let connection = connectionFixture();
    let digestCharacter = 'c';
    let deferReconciliationRead = false;
    let resolveReconciliationRead: ((content: ReturnType<typeof connectionResourceContent>) => void) | undefined;
    const host = createChannelsHostApi({
      readResource: async () => {
        if (deferReconciliationRead) {
          deferReconciliationRead = false;
          return new Promise<ReturnType<typeof connectionResourceContent>>((resolve) => {
            resolveReconciliationRead = resolve;
          });
        }
        return connectionResourceContent([connection], digestCharacter);
      },
      executeAction: async () => {
        throw Object.assign(new Error('The update may have reached the Account.'), { code: 'timeout' });
      },
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-connection-save').props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-save-outcome-unknown').length).toBeGreaterThan(0);

    connection = connectionFixture({
      revision: 5,
      maximumObservationAgeMs: 240_000,
    });
    digestCharacter = 'd';
    await act(async () => {
      host.invalidateResource(resourceDigest(digestCharacter));
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-save-outcome-unknown').length).toBeGreaterThan(0);
    expect(findPressableByTestId(renderer, 'channels-connection-save').props.disabled).toBe(true);
    expect(findPressableByTestId(renderer, 'channels-connection-enabled').props.checked).toBe(true);
    expect(findTextFieldByTestId(renderer, 'channels-connection-observation-age').props.value).toBe('240000');

    deferReconciliationRead = true;
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-save-outcome-unknown-reconcile').props.onPress();
    });
    await flushHookEffects();
    expect(resolveReconciliationRead).toBeDefined();
    await act(async () => {
      resolveReconciliationRead?.(connectionResourceContent([connection], digestCharacter));
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-save-outcome-unknown')).toHaveLength(0);
  });

  it('preserves a connection policy draft when its row collapses and reopens', async () => {
    const connection = connectionFixture();
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection]),
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-enabled').props.onPress();
      findTextFieldByTestId(renderer!, 'channels-connection-observation-age').props.onChangeText('180000');
    });

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();

    expect(findPressableByTestId(renderer, 'channels-connection-enabled').props.checked).toBe(false);
    expect(findTextFieldByTestId(renderer, 'channels-connection-observation-age').props.value).toBe('180000');
  });

  it('reconciles a changed connection revision before a draft can be saved', async () => {
    let connection = connectionFixture();
    let digestCharacter = 'c';
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection], digestCharacter),
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-enabled').props.onPress();
      findTextFieldByTestId(renderer!, 'channels-connection-observation-age').props.onChangeText('180000');
    });

    connection = connectionFixture({
      revision: 5,
      maximumObservationAgeMs: 240_000,
    });
    digestCharacter = 'd';
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-detail-resource-refresh').props.onPress();
    });
    await flushHookEffects();

    expect(findPressableByTestId(renderer, 'channels-connection-enabled').props.checked).toBe(true);
    expect(findTextFieldByTestId(renderer, 'channels-connection-observation-age').props.value).toBe('240000');
    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-connection-save').props.onPress();
    });
    expect(host.executeAction).toHaveBeenLastCalledWith('connection/update-v1', {
      connectionId: connection.connectionId,
      expectedRevision: connection.revision,
      enabled: connection.enabled,
      maximumObservationAgeMs: connection.maximumObservationAgeMs,
    });
  });

  it('waits for the queued unknown-outcome reread when one Resource refresh is already pending', async () => {
    const connection = connectionFixture();
    let holdReads = false;
    const deferredReads: Array<(content: ReturnType<typeof connectionResourceContent>) => void> = [];
    const host = createChannelsHostApi({
      readResource: async () => {
        if (!holdReads) return connectionResourceContent([connection]);
        return new Promise<ReturnType<typeof connectionResourceContent>>((resolve) => {
          deferredReads.push(resolve);
        });
      },
      executeAction: async () => {
        throw Object.assign(new Error('The update may have reached the Account.'), { code: 'timeout' });
      },
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    holdReads = true;
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-detail-resource-refresh').props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-resource-refreshing').length).toBeGreaterThan(0);
    expect(deferredReads).toHaveLength(1);

    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-connection-save').props.onPress();
    });
    await flushHookEffects();
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-save-outcome-unknown-reconcile').props.onPress();
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-save-outcome-unknown').length).toBeGreaterThan(0);
    const resolvePreexistingRead = deferredReads.shift();
    if (!resolvePreexistingRead) throw new Error('Expected the preexisting Resource refresh.');
    await act(async () => {
      resolvePreexistingRead(connectionResourceContent([connection]));
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-save-outcome-unknown').length).toBeGreaterThan(0);
    expect(deferredReads).toHaveLength(1);
    const resolveRequestedRead = deferredReads.shift();
    if (!resolveRequestedRead) throw new Error('Expected the requested Resource reread.');
    await act(async () => {
      resolveRequestedRead(connectionResourceContent([connection]));
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-save-outcome-unknown')).toHaveLength(0);
  });

  it('retains a last-known-good list and offers a refresh after a Resource refresh error', async () => {
    const connection = connectionFixture();
    let failRefresh = false;
    const host = createChannelsHostApi({
      readResource: async () => {
        if (failRefresh) {
          throw Object.assign(new Error('The Account resource is temporarily unavailable.'), {
            code: 'plugin_resource_unavailable',
          });
        }
        return connectionResourceContent([connection]);
      },
    });

    renderer = await renderChannelsSurface(host.hostApi);
    failRefresh = true;

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-resource-refresh').props.onPress();
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-connection-connection-1').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'channels-resource-stale').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'channels-resource-retry').length).toBeGreaterThan(0);

    failRefresh = false;
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-resource-retry').props.onPress();
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-resource-stale')).toHaveLength(0);
  });

  it('does not disclose Resource error diagnostics in stale or unavailable states', async () => {
    const diagnostic = 'secret: account-token=shh; machine-id=machine-sensitive';
    const connection = connectionFixture();
    let failRefresh = false;
    const staleHost = createChannelsHostApi({
      readResource: async () => {
        if (failRefresh) {
          throw Object.assign(new Error(diagnostic), { code: 'plugin_resource_unavailable' });
        }
        return connectionResourceContent([connection]);
      },
    });
    renderer = await renderChannelsSurface(staleHost.hostApi);
    failRefresh = true;
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-resource-refresh').props.onPress();
    });
    await flushHookEffects();

    const staleOutput = JSON.stringify(renderer.toJSON());
    expect(staleOutput).toContain('Live connection updates are temporarily unavailable.');
    expect(staleOutput).not.toContain(diagnostic);

    act(() => renderer?.unmount());
    renderer = null;
    const unavailableHost = createChannelsHostApi({
      readResource: async () => {
        throw Object.assign(new Error(diagnostic), { code: 'plugin_resource_unavailable' });
      },
    });
    renderer = await renderChannelsSurface(unavailableHost.hostApi);

    const unavailableOutput = JSON.stringify(renderer.toJSON());
    expect(unavailableOutput).toContain('Refresh to try reading the current Account connection policy again.');
    expect(unavailableOutput).not.toContain(diagnostic);
  });

  it('keeps an empty Resource snapshot visible with its freshness notice after a refresh error', async () => {
    let failRefresh = false;
    const host = createChannelsHostApi({
      readResource: async () => {
        if (failRefresh) {
          throw Object.assign(new Error('The Account resource is temporarily unavailable.'), {
            code: 'plugin_resource_unavailable',
          });
        }
        return connectionResourceContent([]);
      },
    });
    renderer = await renderChannelsSurface(host.hostApi);

    expect(findByTestId(renderer, 'channels-connections-empty').length).toBeGreaterThan(0);
    failRefresh = true;
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-resource-refresh').props.onPress();
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-connections-empty').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'channels-resource-stale').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'channels-resource-retry').length).toBeGreaterThan(0);
  });

  it('opens only the exact admitted Channels setup Action through the host-owned input selector', async () => {
    const targetedContributions = channelsProviderTargetedContributions();
    const betaSetupOperation = targetedContributions.points[0]!
      .protocols[0]!
      .contributions[1]!
      .operations[0]!;
    const host = createChannelsHostApi({
      methods: ['executeAction', 'readResource', 'selectActionInput', 'watchContext', 'watchResource'],
      readResource: async () => connectionResourceContent([]),
      selectActionInput: async (request) => {
        // This must remain the exact mounted object, including beta's committed
        // contributor generation, even though alpha shares its local Action ID.
        if (!('operation' in request)) {
          throw new Error('Expected a targeted operation selection request.');
        }
        expect(request.operation).toBe(betaSetupOperation);
        return { kind: 'cancelled' };
      },
    });
    const brands = createChannelsBrandPresentationHost({
      'example.channel.alpha': 'Alpha Channels',
      'example.channel.beta': 'Beta Channels',
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture({
        targetedContributions,
      }),
      brands.presentationHost,
    );

    const betaPicker = findPressableByTestId(
      renderer,
      'channels-provider-setup-example.channel.beta-provider',
    );
    expect(betaPicker.props.accessibilityLabel).toBe('Set up Beta Channels');
    expect(findByTestId(renderer, 'channels-provider-setup-brand-example.channel.beta-provider').some(
      (instance) => instance.props.accessible === false && instance.props.accessibilityLabel === undefined,
    )).toBe(true);

    await act(async () => {
      await betaPicker.props.onPress();
    });
    await flushHookEffects();

    expect(host.selectActionInput).toHaveBeenCalledWith(
      { operation: betaSetupOperation },
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(host.executeAction).not.toHaveBeenCalled();
    expect(findByTestId(renderer, 'channels-provider-setup-selection-unavailable')).toHaveLength(0);
  });

  it('prepares a submitted provider through the host-stamped selection without Action authority', async () => {
    const targetedContributions = channelsProviderTargetedContributions();
    const betaSetupOperation = targetedContributions.points[0]!
      .protocols[0]!
      .contributions[1]!
      .operations[0]!;
    const selection = {
      target: targetedContributions.target,
      point: betaSetupOperation.point,
      contributor: betaSetupOperation.contributor,
    };
    const providerSetupInput = { authorizationCode: 'opaque-provider-input' };
    let preparedPayload: unknown;
    const host = createChannelsHostApi({
      methods: ['executeAction', 'readResource', 'selectActionInput', 'watchContext', 'watchResource'],
      readResource: async () => connectionResourceContent([]),
      selectActionInput: async (request) => {
        if (!('operation' in request)) {
          throw new Error('Expected a targeted operation selection request.');
        }
        expect(request.operation).toBe(betaSetupOperation);
        return {
          kind: 'submitted',
          action: betaSetupOperation.action,
          input: providerSetupInput,
          selection,
          connectedAccount: { kind: 'none' },
        };
      },
      executeAction: async (actionId, payload) => {
        expect(actionId).toBe('connection/prepare-v1');
        preparedPayload = payload;
        return { kind: 'ready' };
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture({
        targetedContributions,
      }),
    );

    await act(async () => {
      await findPressableByTestId(
        renderer!,
        'channels-provider-setup-example.channel.beta-provider',
      ).props.onPress();
    });
    await flushHookEffects();

    expect(host.selectActionInput).toHaveBeenCalledWith(
      { operation: betaSetupOperation },
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(host.executeAction).toHaveBeenCalledTimes(1);
    expect(preparedPayload).toEqual({
      providerSelection: selection,
      providerSetupInput,
      credentialRef: null,
    });
    if (!isRecord(preparedPayload)) {
      throw new Error('Expected the management prepare input to be an object.');
    }
    expect(preparedPayload.providerSelection).toBe(selection);
    expect(preparedPayload.providerSetupInput).toBe(providerSetupInput);
    expect(preparedPayload).not.toHaveProperty('action');
    expect(preparedPayload).not.toHaveProperty('localId');
    expect(preparedPayload).not.toHaveProperty('providerSetupAction');
  });

  it('unlocks an ambiguous provider preparation only after an explicit fresh Resource reread', async () => {
    const targetedContributions = channelsProviderTargetedContributions();
    const betaSetupOperation = targetedContributions.points[0]!
      .protocols[0]!
      .contributions[1]!
      .operations[0]!;
    const selection = {
      target: targetedContributions.target,
      point: betaSetupOperation.point,
      contributor: betaSetupOperation.contributor,
    };
    let deferReconciliationRead = false;
    let resolveReconciliationRead: ((content: ReturnType<typeof connectionResourceContent>) => void) | undefined;
    const host = createChannelsHostApi({
      methods: ['executeAction', 'readResource', 'selectActionInput', 'watchContext', 'watchResource'],
      readResource: async () => {
        if (deferReconciliationRead) {
          deferReconciliationRead = false;
          return new Promise<ReturnType<typeof connectionResourceContent>>((resolve) => {
            resolveReconciliationRead = resolve;
          });
        }
        return connectionResourceContent([]);
      },
      selectActionInput: async () => ({
        kind: 'submitted',
        action: betaSetupOperation.action,
        input: { authorizationCode: 'opaque-provider-input' },
        selection,
        connectedAccount: { kind: 'none' },
      }),
      executeAction: async () => {
        throw Object.assign(new Error('Provider preparation may have reached the selected provider.'), {
          code: 'timeout',
        });
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture({ targetedContributions }),
    );
    await act(async () => {
      await findPressableByTestId(
        renderer!,
        'channels-provider-setup-example.channel.beta-provider',
      ).props.onPress();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledTimes(1);
    expect(findPressableByTestId(
      renderer,
      'channels-provider-setup-example.channel.beta-provider',
    ).props.disabled).toBe(true);

    deferReconciliationRead = true;
    const reconcile = findPressableByTestId(
      renderer,
      'channels-provider-setup-outcome-unknown-reconcile',
    );
    await act(async () => {
      reconcile.props.onPress();
    });
    await flushHookEffects();

    expect(resolveReconciliationRead).toBeDefined();
    await act(async () => {
      resolveReconciliationRead?.(connectionResourceContent([], 'd'));
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-provider-setup-outcome-unknown')).toHaveLength(0);
    expect(findPressableByTestId(
      renderer,
      'channels-provider-setup-example.channel.beta-provider',
    ).props.disabled).toBe(false);
    await act(async () => {
      await findPressableByTestId(
        renderer!,
        'channels-provider-setup-example.channel.beta-provider',
      ).props.onPress();
    });
    expect(host.executeAction).toHaveBeenCalledTimes(2);
  });

  it('creates a non-durable connection only after preparation, using the exact selected transport and host selection', async () => {
    const targetedContributions = channelsProviderTargetedContributions();
    const betaSetupOperation = targetedContributions.points[0]!
      .protocols[0]!
      .contributions[1]!
      .operations[0]!;
    const selection = {
      target: targetedContributions.target,
      point: betaSetupOperation.point,
      contributor: betaSetupOperation.contributor,
    };
    const providerSetupInput = { authorizationCode: 'opaque-provider-input' };
    const credentialRef = {
      service: { pluginId: 'example.channel.beta', localId: 'account-service' },
      accountId: 'account-primary',
    };
    let connections: readonly ConnectionResourceRow[] = [];
    const host = createChannelsHostApi({
      methods: ['executeAction', 'readResource', 'selectActionInput', 'watchContext', 'watchResource'],
      readResource: async () => connectionResourceContent(connections, connections.length === 0 ? 'c' : 'd'),
      selectActionInput: async () => ({
        kind: 'submitted',
        action: betaSetupOperation.action,
        input: providerSetupInput,
        selection,
        connectedAccount: {
          kind: 'selected',
          fieldPath: '/credential',
          ref: credentialRef,
        },
      }),
      executeAction: async (actionId, payload) => {
        if (actionId === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
          expect(payload).toEqual({
            providerSelection: selection,
            providerSetupInput,
            credentialRef,
          });
          return {
            kind: 'ready',
            supportedTransports: ['checkpointedPull', 'socket', 'durablePush'],
            recommendedTransport: 'socket',
            overlapSafety: 'safe',
            replayContinuity: 'none',
            outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
            destinationLabel: 'Beta relay',
          };
        }
        expect(actionId).toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate);
        expect(payload).toEqual({
          providerSelection: selection,
          providerSetupInput,
          credentialRef,
          selectedTransport: 'checkpointedPull',
          maximumObservationAgeMs: MIN_CONVERSATION_OBSERVATION_AGE_MS,
        });
        if (!isRecord(payload)) throw new Error('Expected a connection-create input object.');
        expect(payload.providerSelection).toBe(selection);
        expect(payload.providerSetupInput).toBe(providerSetupInput);
        expect(payload.credentialRef).toBe(credentialRef);
        expect(payload).not.toHaveProperty('action');
        expect(payload).not.toHaveProperty('providerSetupAction');
        connections = [connectionFixture({
          connectionId: 'connection-created',
          revision: 1,
          authorityEpoch: 1,
          integrationPrincipalLabel: 'Beta relay',
        })];
        return { kind: 'created', connectionId: 'connection-created' };
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture({ targetedContributions }),
    );

    await act(async () => {
      await findPressableByTestId(
        renderer!,
        'channels-provider-setup-example.channel.beta-provider',
      ).props.onPress();
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-provider-setup-connection-form')).not.toHaveLength(0);
    expect(findByTestId(renderer, 'channels-provider-setup-transport-durablePush')).toHaveLength(0);
    await act(async () => {
      findPressableByTestId(
        renderer!,
        'channels-provider-setup-transport-checkpointedPull',
      ).props.onPress();
    });
    const readsBeforeCreate = host.readResource.mock.calls.length;
    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-provider-setup-create').props.onPress();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledTimes(2);
    expect(host.readResource.mock.calls.length).toBeGreaterThan(readsBeforeCreate);
    expect(findByTestId(renderer, 'channels-connection-connection-created')).not.toHaveLength(0);
    expect(findByTestId(renderer, 'channels-connection-detail')).not.toHaveLength(0);
  });

  it('locks an ambiguous connection creation until an explicit fresh Resource reread completes', async () => {
    const targetedContributions = channelsProviderTargetedContributions();
    const betaSetupOperation = targetedContributions.points[0]!
      .protocols[0]!
      .contributions[1]!
      .operations[0]!;
    const selection = {
      target: targetedContributions.target,
      point: betaSetupOperation.point,
      contributor: betaSetupOperation.contributor,
    };
    let deferReconciliationRead = false;
    let resolveReconciliationRead: ((content: ReturnType<typeof connectionResourceContent>) => void) | undefined;
    const host = createChannelsHostApi({
      methods: ['executeAction', 'readResource', 'selectActionInput', 'watchContext', 'watchResource'],
      readResource: async () => {
        if (deferReconciliationRead) {
          deferReconciliationRead = false;
          return new Promise<ReturnType<typeof connectionResourceContent>>((resolve) => {
            resolveReconciliationRead = resolve;
          });
        }
        return connectionResourceContent([]);
      },
      selectActionInput: async () => ({
        kind: 'submitted',
        action: betaSetupOperation.action,
        input: { authorizationCode: 'opaque-provider-input' },
        selection,
        connectedAccount: { kind: 'none' },
      }),
      executeAction: async (actionId) => {
        if (actionId === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
          return {
            kind: 'ready',
            supportedTransports: ['checkpointedPull'],
            recommendedTransport: 'checkpointedPull',
            overlapSafety: 'safe',
            replayContinuity: 'none',
            outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
          };
        }
        expect(actionId).toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate);
        throw Object.assign(new Error('Connection creation may have reached the Account.'), { code: 'timeout' });
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture({ targetedContributions }),
    );
    await act(async () => {
      await findPressableByTestId(
        renderer!,
        'channels-provider-setup-example.channel.beta-provider',
      ).props.onPress();
    });
    await flushHookEffects();

    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-provider-setup-create').props.onPress();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledTimes(2);
    expect(findPressableByTestId(renderer, 'channels-provider-setup-create').props.disabled).toBe(true);
    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-provider-setup-create').props.onPress();
    });
    expect(host.executeAction).toHaveBeenCalledTimes(2);

    deferReconciliationRead = true;
    const reconcile = findPressableByTestId(
      renderer,
      'channels-provider-setup-creation-outcome-unknown-reconcile',
    );
    await act(async () => {
      reconcile.props.onPress();
    });
    await flushHookEffects();

    expect(resolveReconciliationRead).toBeDefined();
    await act(async () => {
      resolveReconciliationRead?.(connectionResourceContent([], 'd'));
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-provider-setup-creation-outcome-unknown')).toHaveLength(0);
    expect(findByTestId(renderer, 'channels-provider-setup-connection-form')).toHaveLength(0);
  });

  it('passes the host-selected Connected Account unchanged into provider preparation', async () => {
    const targetedContributions = channelsProviderTargetedContributions();
    const betaSetupOperation = targetedContributions.points[0]!
      .protocols[0]!
      .contributions[1]!
      .operations[0]!;
    const selection = {
      target: targetedContributions.target,
      point: betaSetupOperation.point,
      contributor: betaSetupOperation.contributor,
    };
    const credentialRef = {
      service: { pluginId: 'example.channel.beta', localId: 'account-service' },
      accountId: 'account-primary',
    };
    const host = createChannelsHostApi({
      methods: ['executeAction', 'readResource', 'selectActionInput', 'watchContext', 'watchResource'],
      readResource: async () => connectionResourceContent([]),
      selectActionInput: async () => ({
        kind: 'submitted',
        action: betaSetupOperation.action,
        input: { authorizationCode: 'opaque-provider-input' },
        selection,
        connectedAccount: {
          kind: 'selected',
          fieldPath: '/credential',
          ref: credentialRef,
        },
      }),
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture({
        targetedContributions,
      }),
    );

    await act(async () => {
      await findPressableByTestId(
        renderer!,
        'channels-provider-setup-example.channel.beta-provider',
      ).props.onPress();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledWith(
      'connection/prepare-v1',
      {
        providerSelection: selection,
        providerSetupInput: { authorizationCode: 'opaque-provider-input' },
        credentialRef,
      },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        selectedActionInput: {
          operation: betaSetupOperation,
          result: expect.objectContaining({
            connectedAccount: { kind: 'selected', fieldPath: '/credential', ref: credentialRef },
            input: { authorizationCode: 'opaque-provider-input' },
            selection,
          }),
        },
      }),
    );
    const preparedPayload = host.executeAction.mock.calls[0]?.[1];
    if (!isRecord(preparedPayload)) {
      throw new Error('Expected the management prepare input to be an object.');
    }
    expect(preparedPayload.credentialRef).toBe(credentialRef);
  });

  it('renders core preparation remediation without creating a connection', async () => {
    const targetedContributions = channelsProviderTargetedContributions();
    const betaSetupOperation = targetedContributions.points[0]!
      .protocols[0]!
      .contributions[1]!
      .operations[0]!;
    const selection = {
      target: targetedContributions.target,
      point: betaSetupOperation.point,
      contributor: betaSetupOperation.contributor,
    };
    const host = createChannelsHostApi({
      methods: ['executeAction', 'readResource', 'selectActionInput', 'watchContext', 'watchResource'],
      readResource: async () => connectionResourceContent([]),
      selectActionInput: async () => ({
        kind: 'submitted',
        action: betaSetupOperation.action,
        input: { authorizationCode: 'opaque-provider-input' },
        selection,
        connectedAccount: { kind: 'none' },
      }),
      executeAction: async (actionId) => {
        expect(actionId).toBe('connection/prepare-v1');
        return { kind: 'requiresRemediation', remediation: 'telegramWebhookActive' };
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture({
        targetedContributions,
      }),
    );

    await act(async () => {
      await findPressableByTestId(
        renderer!,
        'channels-provider-setup-example.channel.beta-provider',
      ).props.onPress();
    });
    await flushHookEffects();

    const remediation = findByTestId(renderer, 'channels-provider-setup-remediation');
    expect(remediation.some((instance) => (
      instance.props?.role === 'alert' && instance.props?.accessibilityLiveRegion === 'assertive'
    ))).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('Finish the provider setup before creating a connection.');
    expect(host.executeAction).toHaveBeenCalledTimes(1);
    expect(host.executeAction).not.toHaveBeenCalledWith('connection/create-v1', expect.anything());
  });

  it('fails closed and visibly remediates when an admitted setup handle retires before selection', async () => {
    const targetedContributions = channelsProviderTargetedContributions();
    const betaSetupOperation = targetedContributions.points[0]!
      .protocols[0]!
      .contributions[1]!
      .operations[0]!;
    const diagnostic = 'provider generation retired; never render this host diagnostic';
    const host = createChannelsHostApi({
      methods: ['executeAction', 'readResource', 'selectActionInput', 'watchContext', 'watchResource'],
      readResource: async () => connectionResourceContent([]),
      selectActionInput: async () => {
        throw Object.assign(new Error(diagnostic), { code: 'stale_surface' });
      },
    });

    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture({
        targetedContributions,
      }),
    );

    await act(async () => {
      await findPressableByTestId(
        renderer!,
        'channels-provider-setup-example.channel.beta-provider',
      ).props.onPress();
    });
    await flushHookEffects();

    expect(host.selectActionInput).toHaveBeenCalledWith(
      { operation: betaSetupOperation },
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(host.executeAction).not.toHaveBeenCalled();
    const unavailable = findByTestId(renderer, 'channels-provider-setup-selection-unavailable');
    expect(unavailable.some((instance) => (
      instance.props?.role === 'alert' && instance.props?.accessibilityLiveRegion === 'assertive'
    ))).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(diagnostic);
  });

  it('renders explicit empty and unavailable states instead of a blank settings page', async () => {
    const emptyHost = createChannelsHostApi({
      readResource: async () => connectionResourceContent([]),
    });
    renderer = await renderChannelsSurface(emptyHost.hostApi);

    expect(findByTestId(renderer, 'channels-connections-empty').length).toBeGreaterThan(0);
    act(() => renderer?.unmount());
    renderer = null;

    const unavailableHost = createChannelsHostApi({
      readResource: async () => {
        throw Object.assign(new Error('The connections Resource is unavailable.'), {
          code: 'plugin_resource_unavailable',
        });
      },
    });
    renderer = await renderChannelsSurface(unavailableHost.hostApi);

    expect(findByTestId(renderer, 'channels-connections-error').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'channels-connections-retry').length).toBeGreaterThan(0);
  });

  it('shows a pending stop-reconciliation fact without treating it as transport quiescence', async () => {
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([
        connectionFixture({ deletionState: 'pendingStopReconciliation' }),
      ]),
    });

    renderer = await renderChannelsSurface(host.hostApi);

    expect(findByTestId(renderer, 'channels-connection-status-connection-1').length).toBeGreaterThan(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('Stop reconciliation pending');
  });

  it('discloses a scheduled poll retry without offering a duplicate manual retry', async () => {
    const diagnostic = 'provider action diagnostic that must not reach the Channels management surface';
    const connection = {
      ...connectionFixture(),
      attention: {
        ...connectionFixture().attention,
        pollFailure: {
          phase: 'retryDue' as const,
          attemptCount: 2 as const,
          retryNotBeforeMs: 1_700_000_000_000,
          evidence: {
            kind: 'action' as const,
            code: 'provider_transport_exploded',
            message: diagnostic,
          },
        },
      },
    } as ConnectionResourceRow;
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection]),
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();

    const disclosure = findByTestId(renderer, 'channels-poll-retry-due-disclosure');
    expect(disclosure.some((instance) => (
      instance.props?.role === 'alert' && instance.props?.accessibilityLiveRegion === 'assertive'
    ))).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('Happier will retry this connection automatically.');
    expect(JSON.stringify(renderer.toJSON())).not.toContain(diagnostic);
    expect(findByTestId(renderer, 'channels-connection-poll-retry')).toHaveLength(0);
    expect(host.executeAction).not.toHaveBeenCalled();
  });

  it('retries only the exact blocked poll state through the present-user Action and rereads the connection', async () => {
    let connection = connectionFixture({
      revision: 8,
      authorityEpoch: 5,
      attention: {
        pollFailure: {
          phase: 'blocked',
          attemptCount: 5,
          retryNotBeforeMs: null,
          evidence: { kind: 'provider', reason: 'credentialInvalid' },
        },
      },
    });
    let digestCharacter = 'c';
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection], digestCharacter),
      executeAction: async (actionId, payload) => {
        expect(actionId).toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry);
        expect(payload).toEqual({
          connectionId: 'connection-1',
          expectedRevision: 8,
          authorityEpoch: 5,
        });
        connection = connectionFixture({
          revision: 9,
          authorityEpoch: 5,
          attention: { pollFailure: null },
        });
        digestCharacter = 'd';
        return {
          kind: 'retryScheduled',
          connectionId: 'connection-1',
          revision: 9,
          authorityEpoch: 5,
        };
      },
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();

    const disclosure = findByTestId(renderer, 'channels-poll-blocked-disclosure');
    expect(disclosure.some((instance) => (
      instance.props?.role === 'alert' && instance.props?.accessibilityLiveRegion === 'assertive'
    ))).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('Conversation polling needs attention');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('credentialInvalid');
    const retry = findPressableByTestId(renderer, 'channels-connection-poll-retry');
    expect(retry.props.accessibilityLabel).toBe('Retry polling');

    const readsBeforeRetry = host.readResource.mock.calls.length;
    await act(async () => {
      await retry.props.onPress();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledTimes(1);
    expect(host.readResource.mock.calls.length).toBeGreaterThan(readsBeforeRetry);
    expect(findByTestId(renderer, 'channels-poll-blocked-disclosure')).toHaveLength(0);
    expect(findByTestId(renderer, 'channels-connection-poll-retry')).toHaveLength(0);
  });

  it('deletes an active connection through its canonical Action and rereads current lifecycle state', async () => {
    let connection = connectionFixture();
    let digestCharacter = 'c';
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection], digestCharacter),
      executeAction: async (actionId, payload) => {
        expect(actionId).toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete);
        expect(payload).toEqual({ connectionId: 'connection-1', expectedRevision: 4 });
        connection = connectionFixture({
          revision: 5,
          authorityEpoch: 3,
          enabled: false,
          deletionState: 'pendingStopReconciliation',
          attention: { oldTransportStopUnconfirmed: true },
        });
        digestCharacter = 'd';
        return {
          kind: 'deletePending',
          connectionId: 'connection-1',
          revision: 5,
          authorityEpoch: 3,
        };
      },
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-connection-detail').length).toBeGreaterThan(0);
    const readsBeforeDelete = host.readResource.mock.calls.length;
    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-connection-delete').props.onPress();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledTimes(1);
    expect(host.readResource.mock.calls.length).toBeGreaterThan(readsBeforeDelete);
    expect(findByTestId(renderer, 'channels-connection-delete')).toHaveLength(0);
    expect(findByTestId(renderer, 'channels-connection-accept-loss').length).toBeGreaterThan(0);
  });

  it('announces deletion once only after the post-Action Resource reread omits the connection', async () => {
    let connections: readonly ConnectionResourceRow[] = [connectionFixture()];
    let digestCharacter = 'c';
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent(connections, digestCharacter),
      executeAction: async (actionId, payload) => {
        expect(actionId).toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete);
        expect(payload).toEqual({ connectionId: 'connection-1', expectedRevision: 4 });
        connections = [];
        digestCharacter = 'd';
        return {
          kind: 'deleteFinalizing',
          connectionId: 'connection-1',
          revision: 5,
          authorityEpoch: 3,
        };
      },
    });
    renderer = await renderChannelsSurface(host.hostApi);
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-connection-deleted-announcement')).toHaveLength(0);

    await act(async () => {
      await findPressableByTestId(renderer!, 'channels-connection-delete').props.onPress();
    });
    await flushHookEffects();

    const announcements = findByTestId(renderer, 'channels-connection-deleted-announcement');
    expect(announcements.some((instance) => (
      instance.props?.role === 'status' && instance.props?.accessibilityLiveRegion === 'polite'
    ))).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('Connection deleted');
    expect(findByTestId(renderer, 'channels-connections-empty').length).toBeGreaterThan(0);
  });

  it('offers explicit accept-loss while pending deletion remains visibly and accessibly truthful', async () => {
    let pendingConnection = connectionFixture({
      revision: 7,
      deletionState: 'pendingStopReconciliation',
      attention: { oldTransportStopUnconfirmed: true },
    });
    let digestCharacter = 'c';
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([pendingConnection], digestCharacter),
      executeAction: async (actionId, payload) => {
        expect(actionId).toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon);
        expect(payload).toEqual({ connectionId: 'connection-1', expectedRevision: 7 });
        pendingConnection = connectionFixture({
          revision: 8,
          authorityEpoch: 3,
          enabled: false,
          deletionState: 'finalizingDelete',
          attention: {
            oldTransportStopUnconfirmed: true,
            acceptedPossibleLoss: true,
          },
        });
        digestCharacter = 'd';
        return {
          kind: 'deleteFinalizing',
          connectionId: 'connection-1',
          revision: 8,
          authorityEpoch: 3,
          acceptedPossibleLoss: true,
        };
      },
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-connection-delete')).toHaveLength(0);
    const acceptLoss = findPressableByTestId(renderer!, 'channels-connection-accept-loss');
    expect(findByTestId(renderer, 'channels-connection-update-unavailable').some((instance) => (
      instance.props?.role === 'alert' && instance.props?.accessibilityLiveRegion === 'assertive'
    ))).toBe(true);
    expect(findByTestId(renderer, 'channels-old-transport-stop-unconfirmed').some((instance) => (
      instance.props?.role === 'alert' && instance.props?.accessibilityLiveRegion === 'assertive'
    ))).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('Stop reconciliation pending');
    expect(JSON.stringify(renderer.toJSON())).toContain('Previous transport may still be running');

    await act(async () => {
      await acceptLoss.props.onPress();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledTimes(1);
    expect(findByTestId(renderer, 'channels-connection-accept-loss')).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('Possible message loss was accepted');
  });

  it('offers accept-loss for transfer custody and removes it after loss was accepted', async () => {
    const pendingTransfer = connectionFixture({
      revision: 7,
      attention: { oldTransportStopUnconfirmed: true },
    });
    const transferHost = createChannelsHostApi({
      readResource: async () => connectionResourceContent([pendingTransfer]),
    });
    renderer = await renderChannelsSurface(transferHost.hostApi);
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-connection-delete')).toHaveLength(0);
    expect(findByTestId(renderer, 'channels-connection-accept-loss').length).toBeGreaterThan(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('Previous transport may still be running');
    expect(transferHost.executeAction).not.toHaveBeenCalled();

    act(() => renderer?.unmount());
    renderer = null;
    const finalizingHost = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connectionFixture({
        deletionState: 'finalizingDelete',
        attention: {
          oldTransportStopUnconfirmed: true,
          acceptedPossibleLoss: true,
        },
      })]),
    });
    renderer = await renderChannelsSurface(finalizingHost.hostApi);
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-connection-delete')).toHaveLength(0);
    expect(findByTestId(renderer, 'channels-connection-accept-loss')).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('Deletion cleanup in progress');
    expect(JSON.stringify(renderer.toJSON())).toContain('Possible message loss was accepted');
    expect(finalizingHost.executeAction).not.toHaveBeenCalled();
  });

  it('collapses an absent finalized row and treats a recreated connection ID as a new identity', async () => {
    let connections: readonly ConnectionResourceRow[] = [connectionFixture({ connectionId: 'connection-old' })];
    let digestCharacter = 'c';
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent(connections, digestCharacter),
    });
    renderer = await renderChannelsSurface(host.hostApi);
    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-old').props.onPress();
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-connection-detail').length).toBeGreaterThan(0);

    connections = [];
    digestCharacter = 'd';
    await act(async () => {
      host.invalidateResource(resourceDigest(digestCharacter));
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-connection-detail')).toHaveLength(0);
    expect(findByTestId(renderer, 'channels-connections-empty').length).toBeGreaterThan(0);

    connections = [connectionFixture({ connectionId: 'connection-new', revision: 1 })];
    digestCharacter = 'e';
    await act(async () => {
      host.invalidateResource(resourceDigest(digestCharacter));
    });
    await flushHookEffects();
    expect(findByTestId(renderer, 'channels-connection-connection-new').length).toBeGreaterThan(0);
    expect(findPressableByTestId(renderer, 'channels-connection-connection-new').props.accessibilityExpanded).toBe(false);
    expect(findByTestId(renderer, 'channels-connection-detail')).toHaveLength(0);
  });

  it('keeps independent socket and history-gap continuity disclosures humanized and accessible', async () => {
    const reportedAt = 1_700_000_000_000;
    const connection = connectionFixture({
      selectedTransport: 'socket',
      attention: {
        historyGap: {
          reportedAt,
          reason: 'applicationAdmissionLost',
        },
        bestEffortBeforeDurableAdmission: true,
      },
    });
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection]),
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();

    const bestEffortDisclosure = findByTestId(renderer, 'channels-best-effort-before-durable-admission');
    const historyGapDisclosure = findByTestId(renderer, 'channels-history-gap-disclosure');
    expect(bestEffortDisclosure.length).toBeGreaterThan(0);
    expect(historyGapDisclosure.length).toBeGreaterThan(0);
    expect(bestEffortDisclosure.some((instance) => (
      instance.props?.role === 'alert' && instance.props?.accessibilityLiveRegion === 'assertive'
    ))).toBe(true);
    expect(historyGapDisclosure.some((instance) => (
      instance.props?.role === 'alert' && instance.props?.accessibilityLiveRegion === 'assertive'
    ))).toBe(true);

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('Messages received through this live connection can be lost before Happier records their admission.');
    expect(rendered).toContain('Happier could not confirm the admission of some received messages.');
    expect(rendered).toContain(new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(reportedAt)));
    expect(rendered).not.toContain('applicationAdmissionLost');
    expect(rendered).not.toContain(String(reportedAt));
  });

  it('pages blocked ingress custody directly and retries the exact saved obligation through the canonical Action', async () => {
    const obligationId = 'I'.repeat(43);
    const data = createOfflineChannelsDataClient({
      rows: [ingressAttentionStateRow({ id: obligationId, revision: 7, attemptCount: 5 })],
    });
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connectionFixture()]),
      executeAction: async (actionId, payload) => {
        expect(actionId).toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.ingressRetry);
        expect(payload).toEqual({
          obligationId,
          expectedRevision: 7,
        });
        return {
          kind: 'retryScheduled',
          obligationId,
          revision: 8,
        };
      },
    });
    renderer = await renderChannelsSurface(host.hostApi, undefined, undefined, data.client);
    await flushHookEffects();

    expect(data.query).toHaveBeenCalledWith({
      index: CHANNEL_STATE_INDEX_ID.byAttention,
      prefix: [true],
      order: 'asc',
      limit: 50,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(findByTestId(renderer, 'channels-ingress-attention-controls').length).toBeGreaterThan(0);
    const retry = findPressableByTestId(renderer, `channels-ingress-attention-retry-${obligationId}`);
    expect(retry.props.accessibilityLabel).toBe('Retry saved input');
    const resourceReadsBeforeRetry = host.readResource.mock.calls.length;
    const attentionReadsBeforeRetry = data.query.mock.calls.filter(([request]) => (
      request.index === CHANNEL_STATE_INDEX_ID.byAttention
    )).length;

    await act(async () => {
      await retry.props.onPress();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledTimes(1);
    expect(host.readResource.mock.calls.length).toBe(resourceReadsBeforeRetry);
    expect(data.query.mock.calls.filter(([request]) => (
      request.index === CHANNEL_STATE_INDEX_ID.byAttention
    )).length).toBeGreaterThan(attentionReadsBeforeRetry);
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('Incoming messages need attention');
    expect(rendered).toContain('Retry stopped after 5 attempts');
    expect(rendered).not.toContain('session-private');
    expect(rendered).not.toContain('occurrence-private');
  });

  it('keeps a blocked ingress retry locked after an unknown Action outcome until its direct attention reread settles', async () => {
    const obligationId = 'I'.repeat(43);
    const data = createOfflineChannelsDataClient({
      rows: [ingressAttentionStateRow({ id: obligationId, revision: 7 })],
    });
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connectionFixture()]),
      executeAction: async () => {
        throw Object.assign(new Error('The retry may already be scheduled.'), { code: 'aborted' });
      },
    });
    renderer = await renderChannelsSurface(host.hostApi, undefined, undefined, data.client);
    await flushHookEffects();

    await act(async () => {
      await findPressableByTestId(
        renderer!,
        `channels-ingress-attention-retry-${obligationId}`,
      ).props.onPress();
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-ingress-attention-outcome-unknown').length).toBeGreaterThan(0);
    expect(findPressableByTestId(
      renderer,
      `channels-ingress-attention-retry-${obligationId}`,
    ).props.disabled).toBe(true);
    await act(async () => {
      await findPressableByTestId(
        renderer!,
        `channels-ingress-attention-retry-${obligationId}`,
      ).props.onPress();
    });
    expect(host.executeAction).toHaveBeenCalledTimes(1);

    const attentionReadsBeforeReconciliation = data.query.mock.calls.filter(([request]) => (
      request.index === CHANNEL_STATE_INDEX_ID.byAttention
    )).length;
    await act(async () => {
      findPressableByTestId(
        renderer!,
        'channels-ingress-attention-outcome-unknown-reconcile',
      ).props.onPress();
    });
    await flushHookEffects();

    expect(data.query.mock.calls.filter(([request]) => (
      request.index === CHANNEL_STATE_INDEX_ID.byAttention
    )).length).toBeGreaterThan(attentionReadsBeforeReconciliation);
    expect(findByTestId(renderer, 'channels-ingress-attention-outcome-unknown')).toHaveLength(0);
    expect(findPressableByTestId(
      renderer,
      `channels-ingress-attention-retry-${obligationId}`,
    ).props.disabled).toBe(false);
  });

  it('surfaces terminal ingress attention without offering a retry or disclosing private refusal facts', async () => {
    const obligationId = 'T'.repeat(43);
    const data = createOfflineChannelsDataClient({
      rows: [terminalIngressAttentionStateRow({ id: obligationId, revision: 8 })],
    });
    const host = createChannelsHostApi({
      methods: ['executeAction', 'watchContext'],
      readResource: async () => {
        throw new Error('Terminal ingress attention does not use a daemon Resource offline.');
      },
    });
    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture(),
      undefined,
      data.client,
    );
    await flushHookEffects();

    expect(findByTestId(renderer, `channels-ingress-attention-${obligationId}`).length).toBeGreaterThan(0);
    expect(findByTestId(renderer, `channels-ingress-attention-retry-${obligationId}`)).toHaveLength(0);
    expect(findByTestId(renderer, 'channels-ingress-attention-actions-unavailable')).toHaveLength(0);
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('An incoming message was not accepted.');
    expect(rendered).not.toContain('messageTooLarge');
    expect(rendered).not.toContain('occurrence-private');
    expect(rendered).not.toContain('session-private');
    expect(host.executeAction).not.toHaveBeenCalled();
    expect(host.readResource).not.toHaveBeenCalled();
  });

  it('pages all blocked ingress custody and keeps its retry action unavailable in cold offline Account mode', async () => {
    const connection = offlineConnectionStateRow();
    const binding = offlineBindingStateRow({ connectionId: connection.rowId });
    const obligations = Array.from({ length: 51 }, (_, index) => ingressAttentionStateRow({
      id: `I${String(index + 1).padStart(42, '0')}`,
      connectionId: connection.rowId,
      bindingId: binding.rowId,
      updatedAt: 1_700_000_000_100 - index,
    }));
    const data = createOfflineChannelsDataClient({ rows: [connection, binding, ...obligations] });
    const host = createChannelsHostApi({
      methods: ['executeAction', 'watchContext'],
      readResource: async () => {
        throw new Error('Cold offline ingress custody must not use a daemon Resource.');
      },
      executeAction: async () => {
        throw new Error('Cold offline ingress custody must not invoke a daemon Action.');
      },
    });
    renderer = await renderChannelsSurface(
      host.hostApi,
      createChannelsSettingsSurfaceContextFixture(),
      undefined,
      data.client,
    );
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-ingress-attention-controls').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, `channels-ingress-attention-${obligations[0]!.rowId}`).length).toBeGreaterThan(0);
    expect(findByTestId(renderer, `channels-ingress-attention-${obligations[50]!.rowId}`)).toHaveLength(0);
    expect(findByTestId(renderer, `channels-ingress-attention-retry-${obligations[0]!.rowId}`)).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('Connect the selected machine to retry these saved inputs.');

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-ingress-attention-load-more').props.onPress();
    });
    await flushHookEffects();

    const attentionQueries = data.query.mock.calls.filter(([request]) => (
      request.index === CHANNEL_STATE_INDEX_ID.byAttention
    ));
    expect(attentionQueries).toHaveLength(2);
    expect(attentionQueries[1]?.[0]).toEqual(expect.objectContaining({
      cursor: obligations[49]!.rowId,
      limit: 50,
    }));
    expect(findByTestId(renderer, `channels-ingress-attention-${obligations[50]!.rowId}`).length).toBeGreaterThan(0);
    expect(host.readResource).not.toHaveBeenCalled();
    expect(host.executeAction).not.toHaveBeenCalled();
  });

  it('reports retained outward delivery retry and ambiguous custody without exposing provider delivery details', async () => {
    const deliveryData = createDeliveryResolutionDataClient({
      rows: [
        deliveryResolutionRow({ custodyId: 'P'.repeat(43), revision: 7, state: 'partial' }),
        deliveryResolutionRow({ custodyId: 'U'.repeat(43), revision: 8, state: 'outcomeUnknown' }),
      ],
    });
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connectionFixture({
        attention: {
          outwardDelivery: {
            retryDue: true,
            notDelivered: true,
            partial: true,
            outcomeUnknown: true,
          },
        },
      })]),
    });
    renderer = await renderChannelsSurface(host.hostApi, undefined, undefined, deliveryData.client);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();

    const disclosureIds = [
      'channels-delivery-retry-due-disclosure',
      'channels-delivery-not-delivered-disclosure',
      'channels-delivery-partial-disclosure',
      'channels-delivery-outcome-unknown-disclosure',
    ];
    for (const testID of disclosureIds) {
      const disclosure = findByTestId(renderer, testID);
      expect(disclosure.length).toBeGreaterThan(0);
      expect(disclosure.some((instance) => (
        instance.props?.role === 'alert' && instance.props?.accessibilityLiveRegion === 'assertive'
      ))).toBe(true);
    }

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('A message delivery is waiting to retry');
    expect(rendered).toContain('A message delivery was not sent');
    expect(rendered).toContain('A message delivery was only partly sent');
    expect(rendered).toContain('A message delivery needs confirmation');
    expect(rendered).toContain('It will not resend it automatically.');
    expect(rendered).not.toContain('message-1');
    expect(rendered).not.toContain('Private delivery body that must not reach the management surface.');
    expect(rendered).not.toContain('provider-message-private');
  });

  it('resolves an exact retained ambiguous custody row through the present-user Action and rereads both canonical views', async () => {
    const partialCustodyId = 'P'.repeat(43);
    const unknownCustodyId = 'U'.repeat(43);
    const deliveryData = createDeliveryResolutionDataClient({
      rows: [
        deliveryResolutionRow({ custodyId: partialCustodyId, revision: 7, state: 'partial' }),
        deliveryResolutionRow({ custodyId: unknownCustodyId, revision: 8, state: 'outcomeUnknown' }),
      ],
    });
    let connection = connectionFixture({
      attention: {
        outwardDelivery: {
          retryDue: false,
          notDelivered: false,
          partial: true,
          outcomeUnknown: true,
        },
      },
    });
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connection]),
      executeAction: async (actionId, payload) => {
        expect(actionId).toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryResolve);
        expect(payload).toEqual({
          custodyId: partialCustodyId,
          expectedRevision: 7,
          resolution: 'accepted',
        });
        deliveryData.markResolved(partialCustodyId);
        connection = connectionFixture({
          attention: {
            outwardDelivery: {
              retryDue: false,
              notDelivered: false,
              partial: false,
              outcomeUnknown: true,
            },
          },
        });
        return {
          kind: 'resolved',
          custodyId: partialCustodyId,
          revision: 8,
          resolution: 'accepted',
        };
      },
    });
    renderer = await renderChannelsSurface(host.hostApi, undefined, undefined, deliveryData.client);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();

    const accept = findPressableByTestId(
      renderer,
      `channels-delivery-resolution-accept-${partialCustodyId}`,
    );
    expect(findByTestId(
      renderer,
      `channels-delivery-resolution-accept-${partialCustodyId}`,
    ).some((instance) => (
      instance.props?.accessibilityRole === 'button'
        && instance.props?.accessibilityLabel === 'Accept as sent'
    ))).toBe(true);
    expect(findByTestId(
      renderer,
      `channels-delivery-resolution-discard-${unknownCustodyId}`,
    ).some((instance) => instance.props?.accessibilityRole === 'button')).toBe(true);

    const readsBeforeResolution = host.readResource.mock.calls.length;
    await act(async () => {
      await accept.props.onPress();
    });
    await flushHookEffects();

    expect(host.executeAction).toHaveBeenCalledTimes(1);
    expect(deliveryData.query).toHaveBeenCalledWith({
      index: CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention,
      prefix: ['connection-1'],
      order: 'asc',
      limit: 50,
    }, expect.any(Object));
    expect(host.readResource.mock.calls.length).toBeGreaterThan(readsBeforeResolution);
    expect(findByTestId(
      renderer,
      `channels-delivery-resolution-accept-${partialCustodyId}`,
    )).toHaveLength(0);
    expect(findPressableByTestId(
      renderer,
      `channels-delivery-resolution-accept-${unknownCustodyId}`,
    ).props.disabled).toBe(false);
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).not.toContain('Private delivery body that must not reach the management surface.');
    expect(rendered).not.toContain('provider-message-private');
  });

  it('keeps an aborted delivery decision locked until an explicit direct custody reread completes', async () => {
    const custodyId = 'P'.repeat(43);
    const deliveryData = createDeliveryResolutionDataClient({
      rows: [deliveryResolutionRow({ custodyId, revision: 7, state: 'partial' })],
    });
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connectionFixture({
        attention: {
          outwardDelivery: {
            retryDue: false,
            notDelivered: false,
            partial: true,
            outcomeUnknown: false,
          },
        },
      })]),
      executeAction: async () => {
        throw Object.assign(new Error('The delivery decision may have reached the Account.'), {
          code: 'aborted',
        });
      },
    });
    renderer = await renderChannelsSurface(host.hostApi, undefined, undefined, deliveryData.client);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();
    await act(async () => {
      await findPressableByTestId(
        renderer!,
        `channels-delivery-resolution-accept-${custodyId}`,
      ).props.onPress();
    });
    await flushHookEffects();

    expect(findByTestId(renderer, 'channels-delivery-resolution-outcome-unknown').length).toBeGreaterThan(0);
    expect(findPressableByTestId(
      renderer,
      `channels-delivery-resolution-accept-${custodyId}`,
    ).props.disabled).toBe(true);
    await act(async () => {
      await findPressableByTestId(
        renderer!,
        `channels-delivery-resolution-discard-${custodyId}`,
      ).props.onPress();
    });
    expect(host.executeAction).toHaveBeenCalledTimes(1);

    const readsBeforeReconciliation = deliveryData.query.mock.calls.length;
    await act(async () => {
      findPressableByTestId(
        renderer!,
        'channels-delivery-resolution-outcome-unknown-reconcile',
      ).props.onPress();
    });
    await flushHookEffects();

    expect(deliveryData.query.mock.calls.length).toBeGreaterThan(readsBeforeReconciliation);
    expect(findByTestId(renderer, 'channels-delivery-resolution-outcome-unknown')).toHaveLength(0);
    expect(findPressableByTestId(
      renderer,
      `channels-delivery-resolution-accept-${custodyId}`,
    ).props.disabled).toBe(false);
  });

  it('discloses accepted old-transport loss custody without exposing transport details', async () => {
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connectionFixture({
        attention: {
          oldTransportStopUnconfirmed: true,
          acceptedPossibleLoss: true,
        },
      })]),
    });
    renderer = await renderChannelsSurface(host.hostApi);

    await act(async () => {
      findPressableByTestId(renderer!, 'channels-connection-connection-1').props.onPress();
    });
    await flushHookEffects();

    const disclosure = findByTestId(renderer, 'channels-old-transport-stop-unconfirmed');
    expect(disclosure.length).toBeGreaterThan(0);
    expect(disclosure.some((instance) => (
      instance.props?.role === 'alert' && instance.props?.accessibilityLiveRegion === 'assertive'
    ))).toBe(true);

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('Possible message loss was accepted');
    expect(rendered).toContain('Happier has not claimed the old transport stopped.');
    expect(rendered).not.toContain('materializationId');
    expect(rendered).not.toContain('serverIdentityId');
  });

  it('assigns safe-area insets to exactly one layout owner in loading, error, invalid, and populated states', async () => {
    const populatedHost = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connectionFixture()]),
    });
    renderer = await renderChannelsSurface(populatedHost.hostApi);
    expect(safeAreaOwnerCount(renderer)).toBe(1);
    act(() => renderer?.unmount());
    renderer = null;

    const unavailableHost = createChannelsHostApi({
      readResource: async () => {
        throw new Error('Resource unavailable');
      },
    });
    renderer = await renderChannelsSurface(unavailableHost.hostApi);
    expect(findByTestId(renderer, 'channels-connections-error').length).toBeGreaterThan(0);
    expect(safeAreaOwnerCount(renderer)).toBe(1);
    act(() => renderer?.unmount());
    renderer = null;

    const invalidHost = createChannelsHostApi({
      readResource: async () => ({
        contentType: 'text/plain',
        digest: resourceDigest('i'),
        bytes: new TextEncoder().encode('not-json'),
      }),
    });
    renderer = await renderChannelsSurface(invalidHost.hostApi);
    expect(findByTestId(renderer, 'channels-connections-error').length).toBeGreaterThan(0);
    expect(safeAreaOwnerCount(renderer)).toBe(1);
    act(() => renderer?.unmount());
    renderer = null;

    const loadingHost = createChannelsHostApi({
      readResource: async () => new Promise<ReturnType<typeof connectionResourceContent>>(() => {}),
    });
    renderer = await renderChannelsSurface(loadingHost.hostApi);
    expect(findByTestId(renderer, 'channels-connections-loading').length).toBeGreaterThan(0);
    expect(safeAreaOwnerCount(renderer)).toBe(1);
  });

  it('preserves each nonzero safe-area inset before populated binding-index spacing on RNW', async () => {
    const safeAreaInsets = { top: 44, right: 7, bottom: 34, left: 9 } as const;
    const surface = createChannelsSettingsSurfaceContextFixture({
      safeAreaInsets,
    });
    const host = createChannelsHostApi({
      readResource: async () => connectionResourceContent([connectionFixture()]),
    });
    renderer = await renderChannelsSurface(host.hostApi, surface);

    expect(safeAreaOwnerCount(renderer)).toBe(1);
    const safeAreaOwners = renderer.root.findAll((instance) => instance.props?.safeAreaInsets !== undefined);
    expect(safeAreaOwners).toHaveLength(1);
    expect(safeAreaOwners[0]?.props.safeAreaInsets).toEqual(safeAreaInsets);
    const bindingLists = renderer.root.findAll((instance) => (
      hasRenderedHostType(instance, 'FlatList') && instance.props?.testID === 'channels-bindings-list'
    ));
    expect(bindingLists.some((list) => hasRenderedAncestor(list, 'ScrollView'))).toBe(false);
    expect(bindingLists.some((list) => (
      StyleSheet.flatten(list.props.contentContainerStyle).paddingBottom === surface.theme.spacing.large
    ))).toBe(true);
    expect(findByTestId(renderer, 'channels-bindings-content').some((content) => (
      StyleSheet.flatten(content.props.style).padding === surface.theme.spacing.large
    ))).toBe(true);
  });
});

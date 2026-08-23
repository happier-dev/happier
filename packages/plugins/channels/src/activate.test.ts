import {
  definePlugin,
  PluginError,
  type JsonValue,
  type PluginInvocationContext,
  type PluginServices,
} from '@happier-dev/plugin-sdk';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/plugin-sdk/actions';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
  type PluginManifest,
} from '@happier-dev/plugin-sdk/manifest';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import {
  createPluginTestkit,
  type PluginTestkit,
} from '@happier-dev/plugin-sdk/testing';
import type { PluginTargetedContributionSelectionV1 } from '@happier-dev/plugin-sdk/contributions';
import {
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1,
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  ConversationConnectionCreateResultV1Schema,
  ConversationConnectionIdV1Schema,
  ConversationProviderConnectionStopInputV1Schema,
  ConversationProvidersContributionProtocolV1,
  MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
} from '@happier-dev/channels-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_FIXED_ROW_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import {
  CHANNELS_PROVIDER_POINT_REF,
  PLUGIN_MANIFEST,
} from './manifest.js';
import { createConversationOutwardDeliveryCollectionStore } from './outwardDelivery.js';
import { declaredResourceMaxBytes, resourceText } from './testkit/resourceContract.js';
import { isChannelStateJsonRecord } from './accountLocalBindingPolicy.js';

/**
 * A contributed Action may legitimately answer nothing. These composition
 * cases forward the two projections they read, so require a real JSON answer
 * rather than widening the handler contract to accept `void`.
 */
function requiredActionResult(value: JsonValue | void, localId: string): JsonValue {
  if (value === undefined) {
    throw new Error(`Expected ${localId} to answer a JSON projection.`);
  }
  return value;
}

import {
  createCurrentConversationConnectionFixture,
  createCurrentConversationPendingOldTransportStopFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';

import { assertChannelsTestCollectionQueryLimit } from './testkit/collectionQueryBound.js';
const SOCKET_PROVIDER_ACTION_ID = {
  setup: 'fixture/initialize-socket',
  connectionTest: 'fixture/probe-socket',
  messageDeliver: 'fixture/deliver-socket-message',
  connectionStop: 'fixture/quiesce-socket',
} as const;
const SOCKET_PROVIDER_CONTRIBUTION_ID = 'socket-test-provider';
const socketProviderProtocol = ConversationProvidersContributionProtocolV1;
const socketProviderOperations = socketProviderProtocol.operations;
const SOCKET_PROVIDER_SETUP_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const;

/** A positive socket provider fixture: all socket prerequisites are declarative. */
const { manifest: PROVIDER_SOCKET_SETUP_TEST_MANIFEST } = definePlugin({
  id: 'happier.channel.socket-test',
  version: '0.0.0',
  displayName: 'Channels socket test provider',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  hostAccess: {
    required: [{
      id: 'socket-client',
      capability: 'network.client',
      reason: 'Maintain the selected test provider socket.',
      scope: {
        targets: [{ kind: 'fixedOrigin', origin: 'https://socket-test.example' }],
        transports: ['websocket'],
      },
    }],
    optional: [],
  },
  actions: {
    [SOCKET_PROVIDER_ACTION_ID.setup]: {
      title: 'Set up Channels socket test provider',
      execution: { target: 'daemon' },
      scopes: ['global'],
      inputSchema: SOCKET_PROVIDER_SETUP_INPUT_SCHEMA,
      resultSchema: socketProviderOperations.setup.declaration.resultSchema.jsonSchema,
      surfaces: socketProviderOperations.setup.declaration.surfaces,
      dangerLevel: socketProviderOperations.setup.declaration.dangerLevel,
      run: async () => ({
        v: 1,
        credentialRef: null,
        providerConnectionKey: 'socket:default',
        providerConfigVersion: 1,
        providerConfig: {},
        integrationPrincipal: { id: 'socket-default', label: 'Socket default' },
        supportedTransports: ['socket'],
        recommendedTransport: 'socket',
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 1, unit: 'unicodeCodePoints' },
      }),
    },
    [SOCKET_PROVIDER_ACTION_ID.connectionTest]: {
      title: 'Test Channels socket provider connection',
      execution: { target: 'daemon' },
      scopes: ['global'],
      inputSchema: socketProviderOperations.connectionTest.declaration.input.schema.jsonSchema,
      resultSchema: socketProviderOperations.connectionTest.declaration.resultSchema.jsonSchema,
      surfaces: socketProviderOperations.connectionTest.declaration.surfaces,
      dangerLevel: socketProviderOperations.connectionTest.declaration.dangerLevel,
      run: async () => ({ kind: 'ready' }),
    },
    [SOCKET_PROVIDER_ACTION_ID.messageDeliver]: {
      title: 'Deliver a Channels socket test message',
      execution: { target: 'daemon' },
      scopes: ['global'],
      inputSchema: socketProviderOperations.messageDeliver.declaration.input.schema.jsonSchema,
      resultSchema: socketProviderOperations.messageDeliver.declaration.resultSchema.jsonSchema,
      surfaces: socketProviderOperations.messageDeliver.declaration.surfaces,
      dangerLevel: socketProviderOperations.messageDeliver.declaration.dangerLevel,
      run: async () => ({ kind: 'delivered' }),
    },
    [SOCKET_PROVIDER_ACTION_ID.connectionStop]: {
      title: 'Stop Channels socket test provider connection',
      execution: { target: 'daemon' },
      scopes: ['global'],
      inputSchema: socketProviderOperations.connectionStop.declaration.input.schema.jsonSchema,
      resultSchema: socketProviderOperations.connectionStop.declaration.resultSchema.jsonSchema,
      surfaces: socketProviderOperations.connectionStop.declaration.surfaces,
      dangerLevel: socketProviderOperations.connectionStop.declaration.dangerLevel,
      hostAccess: ['socket-client'],
      run: async () => ({ kind: 'notRunning' }),
    },
  },
  backgroundServices: [{
    declaration: {
      id: 'socket-supervisor',
      title: 'Channels socket test supervisor',
    },
    runner: async () => {},
  }],
  contributesTo: {
    'happier.channels': {
      providers: {
        [SOCKET_PROVIDER_CONTRIBUTION_ID]: socketProviderProtocol.contribute({
          operations: {
            setup: socketProviderOperations.setup.bind(SOCKET_PROVIDER_ACTION_ID.setup),
            connectionTest: socketProviderOperations.connectionTest.bind(
              SOCKET_PROVIDER_ACTION_ID.connectionTest,
            ),
            messageDeliver: socketProviderOperations.messageDeliver.bind(
              SOCKET_PROVIDER_ACTION_ID.messageDeliver,
            ),
            connectionStop: socketProviderOperations.connectionStop.bind(
              SOCKET_PROVIDER_ACTION_ID.connectionStop,
            ),
          },
        }),
      },
    },
  },
});

const SOCKET_PROVIDER_RECONCILIATION_ACTION_ID = 'fixture/reconcile-current-connections';

/**
 * A second host view of the same admitted provider identity lets this composed
 * test exercise both directions of the public Action seam. Its synthetic
 * materialization is intentionally identical to the setup/test provider's.
 */
const PROVIDER_SOCKET_RECONCILIATION_TEST_MANIFEST = {
  schemaVersion: 2,
  id: PROVIDER_SOCKET_SETUP_TEST_MANIFEST.id,
  version: '0.0.0',
  displayName: 'Channels socket reconciliation caller',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  contributes: {
    actions: [{
      id: SOCKET_PROVIDER_RECONCILIATION_ACTION_ID,
      title: 'Read current Channels socket connections',
      execution: { target: 'daemon' },
      scopes: ['global'],
      surfaces: ['cli'],
      placementBindings: ['commandPalette'],
      dangerLevel: 'safe',
    }],
  },
} satisfies PluginManifest;

/** Reads the current generic fixture instead of reconstructing a provider snapshot. */
function targetedSocketProviderSelection(
  targetTestkit: PluginTestkit,
): PluginTargetedContributionSelectionV1 {
  const snapshot = targetTestkit.readTargetedContributionFixture(CHANNELS_PROVIDER_POINT_REF);
  const contribution = snapshot.contributions.find((candidate) => (
    candidate.contributor.pluginId === PROVIDER_SOCKET_SETUP_TEST_MANIFEST.id
    && candidate.contributor.contributionId === SOCKET_PROVIDER_CONTRIBUTION_ID
  ));
  if (contribution === undefined) {
    throw new Error('Expected the declared Channels socket provider contribution to be admitted.');
  }
  return Object.freeze({
    target: {
      pluginId: CHANNELS_PROVIDER_POINT_REF.targetPluginId,
      immutableGenerationId: snapshot.generation,
    },
    point: {
      pointId: CHANNELS_PROVIDER_POINT_REF.id,
      protocol: CHANNELS_PROVIDER_POINT_REF.protocol,
    },
    contributor: contribution.contributor,
  });
}

const PROVIDER_RECONCILIATION_TEST_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.channel.discord',
  version: '0.0.0',
  displayName: 'Discord Channels test provider',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  contributes: {
    actions: [{
      id: 'reconcile',
      title: 'Reconcile Channels core state',
      execution: { target: 'daemon' },
      scopes: ['global'],
      surfaces: ['cli'],
      placementBindings: ['commandPalette'],
      dangerLevel: 'safe',
    }],
  },
} satisfies PluginManifest;

const PROVIDER_TRANSPORT_REPORT_TEST_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.channel.transport-report-test',
  version: '0.0.0',
  displayName: 'Channels transport-report test provider',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  contributes: {
    actions: [{
      id: 'report-stop',
      title: 'Report a transport stop fact',
      execution: { target: 'daemon' },
      scopes: ['global'],
      surfaces: ['plugin'],
      placementBindings: ['commandPalette'],
      dangerLevel: 'safe',
    }],
  },
} satisfies PluginManifest;

type ReconciliationQueryRequest = Readonly<{
  prefix?: readonly unknown[];
  cursor?: string;
  limit?: number;
}>;

type ReconciliationQueryPage = Readonly<{
  rows: readonly Readonly<{ rowId: string; revision: number; value: unknown }>[];
  nextCursor?: string;
  changeCursor: number;
}>;

type ReconciliationQuery = (
  request: ReconciliationQueryRequest,
) => Promise<ReconciliationQueryPage>;

function reconciliationConnectionAuthority(
  connectionId: string,
  authorityEpoch = 4,
): ConversationConnectionFixtureAuthority {
  return {
    providerPluginId: PROVIDER_RECONCILIATION_TEST_MANIFEST.id,
    providerContributionSelection: {
      contributionId: 'discord-test-provider',
      immutableGenerationId: 'discord-test-generation',
    },
    providerSetupInput: { fixture: 'discord-reconciliation' },
    credentialRef: null,
    transportOrigin: {
      serverIdentityId: 'srv_account_one',
      materializationRef: {
        machineId: 'plugin-testkit-machine',
        materializationId: `plugin-testkit-${PROVIDER_RECONCILIATION_TEST_MANIFEST.id}`,
        pluginId: PROVIDER_RECONCILIATION_TEST_MANIFEST.id,
      },
    },
    providerConnectionKey: `discord:${connectionId}`,
    providerConfig: { applicationId: 'application-1' },
    routingIdentityKey: 'r'.repeat(43),
    integrationPrincipal: { id: 'discord-bot-1', label: 'Happier' },
    authorityEpoch,
  };
}

function reconciliationConnection(connectionId: string) {
  return createCurrentConversationConnectionFixture({
    connectionId,
    authority: reconciliationConnectionAuthority(connectionId),
    transport: { kind: 'socket' },
    overlapSafety: 'safe',
    replayContinuity: 'none',
    outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
    pairingDeepLinkTemplate: 'https://example.test/pair?token={{token}}',
  });
}

function socketConnectionForProvider(input: Readonly<{
  connectionId: string;
  providerPluginId: string;
  materializationId?: string;
  providerContributionSelection?: PluginTargetedContributionSelectionV1['contributor'];
}>) {
  const authority = {
    ...reconciliationConnectionAuthority(input.connectionId),
    providerPluginId: input.providerPluginId,
    providerContributionSelection: input.providerContributionSelection ?? {
      contributionId: SOCKET_PROVIDER_CONTRIBUTION_ID,
      immutableGenerationId: 'socket-test-generation',
    },
    providerSetupInput: { fixture: 'socket-reconciliation' },
    transportOrigin: {
      serverIdentityId: 'srv_plugin_testkit',
      materializationRef: {
        machineId: 'plugin-testkit-machine',
        materializationId: input.materializationId ?? `plugin-testkit-${input.providerPluginId}`,
        pluginId: input.providerPluginId,
      },
    },
  } satisfies ConversationConnectionFixtureAuthority;
  return createCurrentConversationConnectionFixture({
    connectionId: input.connectionId,
    authority,
    transport: { kind: 'socket' },
    overlapSafety: 'safe',
    replayContinuity: 'none',
    outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
    pairingDeepLinkTemplate: 'https://example.test/pair?token={{token}}',
  });
}

function connectionWithPendingTransfer(input: Readonly<{
  connectionId: string;
  acceptedPossibleLoss: boolean;
  authorityEpoch: number;
  stopAuthorityEpoch: number;
}>) {
  const oldAuthority = reconciliationConnectionAuthority(input.connectionId);
  const replacementAuthority = reconciliationConnectionAuthority(
    input.connectionId,
    input.authorityEpoch,
  );
  return createCurrentConversationConnectionFixture({
    connectionId: input.connectionId,
    authority: replacementAuthority,
    transport: { kind: 'checkpointedPull' },
    overlapSafety: 'safe',
    replayContinuity: 'checkpointed',
    outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
    pairingDeepLinkTemplate: 'https://example.test/pair?token={{token}}',
    pendingOldTransportStop: createCurrentConversationPendingOldTransportStopFixture({
      connectionId: input.connectionId,
      authority: oldAuthority,
      predecessorCheckpointedPollInvocation: {
        connectionRevision: 3,
        authorityEpoch: input.stopAuthorityEpoch - 1,
        transportOrigin: oldAuthority.transportOrigin,
      },
      authorityEpoch: input.stopAuthorityEpoch,
      reason: 'transfer',
      overlapSafety: 'safe',
      acceptedPossibleLoss: input.acceptedPossibleLoss,
    }),
  });
}

function reconciliationBinding(input: Readonly<{
  bindingId: string;
  connectionId: string;
  requiresFullSharedMessageContent?: boolean;
}>) {
  const requiresFullSharedMessageContent = input.requiresFullSharedMessageContent === true;
  return {
    id: input.bindingId,
    'record-kind': 'binding',
    'connection-id': input.connectionId,
    payload: {
      enabled: true,
      deletionState: 'none',
      endpoint: { audience: requiresFullSharedMessageContent ? 'shared' : 'direct' },
      inputMode: requiresFullSharedMessageContent ? 'allAllowedMessages' : 'directMentionsOnly',
    },
  };
}

function collectionRows<TValue extends Readonly<{ id: string }>>(values: readonly TValue[]) {
  return values.map((value, index) => ({ rowId: value.id, revision: index + 1, value }));
}

type MutableChannelStateValue = Readonly<Record<string, unknown>> & Readonly<{ id: string }>;
type MutableChannelStateRow = Readonly<{
  rowId: string;
  revision: number;
  value: MutableChannelStateValue;
  deleted?: boolean;
}>;
type MutableChannelStateMutation =
  | Readonly<{ kind: 'put'; value: MutableChannelStateValue; expectedRevision: number | 'absent' }>
  | Readonly<{ kind: 'delete'; rowId: string; expectedRevision: number }>
  | Readonly<{ kind: 'assert'; rowId: string; expectedRevision: number }>;

/**
 * Account storage is the one genuine state boundary for this composed test.
 * It preserves the Collection CAS/batch contract without mocking core logic.
 */
function createMutableChannelStateCollection(options: Readonly<{
  maxConnectionRows?: number;
  retainTombstones?: boolean;
  onConnectionQuery?: () => void;
  onGet?: (rowId: string) => void;
  onBeforeBatch?: (
    operations: readonly MutableChannelStateMutation[],
    rows: Map<string, MutableChannelStateRow>,
  ) => void;
  onUpdatedBatch?: (operations: readonly MutableChannelStateMutation[]) => void;
}> = {}) {
  const rows = new Map<string, MutableChannelStateRow>();
  const watchers = new Set<(event: Readonly<{ kind: 'changed'; changeCursor: number }>) => void>();
  let changeCursor = 0;

  function publishChange(): void {
    for (const watcher of watchers) watcher({ kind: 'changed', changeCursor });
  }

  function conflictFor(operation: MutableChannelStateMutation) {
    const rowId = operation.kind === 'put' ? operation.value.id : operation.rowId;
    const current = rows.get(rowId);
    const expectedRevision = operation.expectedRevision;
    if (expectedRevision === 'absent') return current === undefined;
    return current?.revision === expectedRevision
      && (operation.kind === 'put' || current.deleted !== true);
  }

  function rowFor(value: MutableChannelStateValue, revision: number): MutableChannelStateRow {
    return { rowId: value.id, revision, value };
  }

  return {
    rows,
    async get(rowId: string): Promise<MutableChannelStateRow | null> {
      options.onGet?.(rowId);
      const row = rows.get(rowId);
      return row?.deleted === true ? null : row ?? null;
    },
    async put(
      value: MutableChannelStateValue,
      options: Readonly<{ expectedRevision: number | 'absent' }>,
    ): Promise<MutableChannelStateRow> {
      const current = rows.get(value.id);
      if ((options.expectedRevision === 'absent' && current !== undefined)
        || (typeof options.expectedRevision === 'number' && current?.revision !== options.expectedRevision)) {
        throw new Error('collection conflict');
      }
      const next = rowFor(value, (current?.revision ?? 0) + 1);
      rows.set(value.id, next);
      changeCursor += 1;
      publishChange();
      return next;
    },
    async batch(operations: readonly MutableChannelStateMutation[]) {
      options.onBeforeBatch?.(operations, rows);
      const conflicts = operations.filter((operation) => !conflictFor(operation));
      if (conflicts.length > 0) {
        return {
          status: 'conflict' as const,
          conflicts: conflicts.map((operation) => ({
            rowId: operation.kind === 'put' ? operation.value.id : operation.rowId,
            revision: rows.get(operation.kind === 'put' ? operation.value.id : operation.rowId)?.revision ?? 0,
            deleted: rows.get(operation.kind === 'put' ? operation.value.id : operation.rowId)?.deleted === true,
          })),
        };
      }
      const results: Array<Readonly<{ rowId: string; revision: number; deleted: boolean }>> = [];
      const nextRows = new Map(rows);
      for (const operation of operations) {
        if (operation.kind === 'assert') continue;
        if (operation.kind === 'delete') {
          const current = nextRows.get(operation.rowId)!;
          if (options.retainTombstones === true) {
            nextRows.set(operation.rowId, { ...current, revision: current.revision + 1, deleted: true });
          } else {
            nextRows.delete(operation.rowId);
          }
          results.push({ rowId: operation.rowId, revision: current.revision + 1, deleted: true });
          continue;
        }
        const current = nextRows.get(operation.value.id);
        const next = rowFor(operation.value, (current?.revision ?? 0) + 1);
        nextRows.set(operation.value.id, next);
        results.push({ rowId: operation.value.id, revision: next.revision, deleted: false });
      }
      if (options.maxConnectionRows !== undefined
        && [...nextRows.values()].filter((row) => row.deleted !== true && row.value['record-kind'] === 'connection').length > options.maxConnectionRows) {
        throw new PluginError({
          code: 'collection_quota_exceeded',
          message: 'The generic Collection quota rejected this atomic mutation.',
        });
      }
      rows.clear();
      for (const [rowId, row] of nextRows) rows.set(rowId, row);
      changeCursor += 1;
      options.onUpdatedBatch?.(operations);
      publishChange();
      return { status: 'updated' as const, results, changeCursor };
    },
    async query(request: Readonly<{
      index: 'by-kind' | 'by-connection-binding-v2' | 'by-attention';
      prefix?: readonly (string | boolean | null)[];
      cursor?: string;
      limit?: number;
    }>) {
      assertChannelsTestCollectionQueryLimit(request.limit);
      const prefix = request.prefix?.[0];
      const matching = [...rows.values()]
        .filter((row) => {
          if (row.deleted === true) return false;
          if (prefix === undefined) return true;
          const value = row.value;
          if (request.index === 'by-kind') return value['record-kind'] === prefix;
          if (request.index === 'by-connection-binding-v2') {
            // The exact V2 tuple, not just its first member: a fake that
            // ignored `record-kind`/`attention` answered the bounded
            // conflict-eligibility probe with unrelated connection rows.
            const tuple = [
              value['connection-id'],
              value['binding-id'] ?? null,
              value['record-kind'],
              value.attention,
            ];
            return (request.prefix ?? []).every((member, index) => tuple[index] === member);
          }
          return value.attention === prefix;
        })
        .sort((left, right) => left.rowId.localeCompare(right.rowId));
      const start = request.cursor === undefined ? 0 : matching.findIndex((row) => row.rowId === request.cursor) + 1;
      const limit = request.limit ?? matching.length;
      const page = matching.slice(Math.max(0, start), Math.max(0, start) + limit);
      const next = matching[Math.max(0, start) + limit];
      if (request.index === 'by-kind' && prefix === 'connection') {
        options.onConnectionQuery?.();
      }
      return {
        rows: page,
        ...(next === undefined ? {} : { nextCursor: page.at(-1)?.rowId }),
        changeCursor,
      };
    },
    watch(
      _request: Readonly<{
        index: 'by-kind' | 'by-connection-binding-v2' | 'by-attention';
        prefix?: readonly string[];
      }>,
      listener: (event: Readonly<{ kind: 'changed'; changeCursor: number }>) => void,
    ) {
      watchers.add(listener);
      return { dispose: () => { watchers.delete(listener); } };
    },
  };
}

const NO_OUTWARD_DELIVERY_ATTENTION = {
  retryDue: false,
  notDelivered: false,
  partial: false,
  outcomeUnknown: false,
  archiveRecovery: false,
} as const;

function storageWithEmptyChannelDeliveries(
  stateCollection: ReturnType<typeof createMutableChannelStateCollection>,
): PluginServices['storage'] {
  const deliveriesCollection = {
    async query(request: Readonly<{ limit?: number }>) {
      assertChannelsTestCollectionQueryLimit(request.limit);
      return { rows: [], changeCursor: 0 };
    },
    watch() {
      return { dispose: () => {} };
    },
  };
  return {
    account: {
      collection(definition: Readonly<{ id: string }>) {
        return definition.id === CHANNEL_DELIVERIES_COLLECTION.id
          ? deliveriesCollection
          : stateCollection;
      },
    },
  } as unknown as PluginServices['storage'];
}

async function createProviderReconciliationAction(query: ReconciliationQuery) {
  const collection = { query };
  // Storage is the genuine host boundary; the provider reaches the core only
  // through the public Action dispatcher.
  const storage = {
    account: { collection: () => collection },
  } as unknown as PluginServices['storage'];
  const core = await createPluginTestkit({
    manifest: PLUGIN_MANIFEST,
    module: { activate },
    services: { storage },
  });
  const provider = await createPluginTestkit({
    manifest: PROVIDER_RECONCILIATION_TEST_MANIFEST,
    actionTargets: [core],
    module: {
      activate(api) {
        api.actions.register('reconcile', async (_input, context) => await context.services.actions.execute(
          {
            pluginId: PLUGIN_MANIFEST.id,
            localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
          },
          {},
        ));
      },
    },
  });
  return { core, provider };
}

describe('Channels core activation', () => {
  it('wires each canonical management declaration to its manifest Action and registered executor', async () => {
    const managementActionKeys = Object.keys(
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
    ) as Array<keyof typeof CONVERSATION_MANAGEMENT_ACTION_IDS_V1>;
    const declaredManagementActions = managementActionKeys.map((key) => ({
      id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1[key],
      declaration: CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1[key],
    }));

    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      for (const { id, declaration } of declaredManagementActions) {
        const manifestAction = (PLUGIN_MANIFEST.contributes?.actions ?? []).find(
          (action) => action.id === id,
        );
        if (!manifestAction) throw new Error(`Missing manifest Action '${id}'.`);
        expect(manifestAction.surfaces).toEqual(['cli', 'ui']);
        const serializedInputSchema = JSON.parse(JSON.stringify(declaration.inputSchema));
        const serializedResultSchema = JSON.parse(JSON.stringify(declaration.resultSchema));
        expect(serializedInputSchema).not.toBe(declaration.inputSchema);
        expect(serializedResultSchema).not.toBe(declaration.resultSchema);
        expect(manifestAction.inputSchema).toEqual(serializedInputSchema);
        expect(manifestAction.resultSchema).toEqual(serializedResultSchema);
        expect(activation.registration('actions', id)).toBeDefined();
        await expect(activation.invokeAction(id, null)).rejects.toMatchObject({
          code: 'plugin_action_input_schema_invalid',
        });
      }
    } finally {
      await activation.dispose();
    }
  });

  it('registers exactly the daemon contributions the manifest declares, in declaration order', async () => {
    // Generated activation binds one implementation per declaration, so the
    // registration list IS the manifest read back: a declaration whose handler,
    // Resource runtime or runner went missing cannot activate at all, and a
    // registration the manifest never declared has no declaration to come from.
    // Spelling the ids again here would only restate the manifest a second
    // time — what has to hold is that the two agree, family for family.
    const contributes = PLUGIN_MANIFEST.contributes ?? {};
    const expected = [
      ...(contributes.actions ?? []).map((action) => ({
        family: 'actions',
        localId: action.id,
      })),
      ...(contributes.backgroundServices ?? []).map((service) => ({
        family: 'backgroundServices',
        localId: service.id,
      })),
      ...(contributes.resources ?? [])
        .filter((resource) => resource.source === 'dynamic')
        .map((resource) => ({ family: 'resources', localId: resource.id })),
    ];

    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      // The four Resources and two supervisors are the ones this package owns;
      // asserting the counts keeps the derived list from passing vacuously if a
      // whole family disappeared from the manifest.
      expect(expected.filter((entry) => entry.family === 'actions')).toHaveLength(27);
      expect(expected.filter((entry) => entry.family === 'resources')).toHaveLength(4);
      expect(expected.filter((entry) => entry.family === 'backgroundServices')).toHaveLength(2);
      expect(activation.registrations()).toEqual(expected);
      expect(activation.registration('actions', CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList))
        .toBeDefined();
      expect(activation.registration('actions', CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate))
        .toBeDefined();
    } finally {
      await activation.dispose();
    }
  });

  it('round-trips a registered create through the Account Collection into caller-scoped list/read and rejoin', async () => {
    const collection = createMutableChannelStateCollection();
    const providerSetupInput = { installation: 'socket-round-trip' } as const;
    const providerSetup = {
      v: 1,
      credentialRef: null,
      providerConnectionKey: 'socket:round-trip',
      providerConfigVersion: 1,
      providerConfig: { installation: 'socket-round-trip' },
      integrationPrincipal: { id: 'socket-round-trip-principal', label: 'Socket round trip' },
      supportedTransports: ['socket'],
      recommendedTransport: 'socket',
      overlapSafety: 'safe',
      replayContinuity: 'none',
      outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
    } as const;
    const setupInputs: unknown[] = [];
    const connectionTestInputs: unknown[] = [];
    const setupProvider = await createPluginTestkit({
      manifest: PROVIDER_SOCKET_SETUP_TEST_MANIFEST,
      module: {
        activate(api) {
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.setup, async (input) => {
            setupInputs.push(input);
            return providerSetup;
          });
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.connectionTest, async (input) => {
            connectionTestInputs.push(input);
            return {
              kind: 'ready',
              integrationPrincipal: providerSetup.integrationPrincipal,
              providerConnectionKey: providerSetup.providerConnectionKey,
            };
          });
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.messageDeliver, async () => ({ kind: 'delivered' }));
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.connectionStop, async () => ({ kind: 'notRunning' }));
          api.backgroundServices.register('socket-supervisor', async () => {});
        },
      },
    });
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: {
        storage: storageWithEmptyChannelDeliveries(collection),
      },
      actionTargets: [setupProvider],
      targetedContributionContributors: [setupProvider],
    });
    const providerReader = await createPluginTestkit({
      manifest: PROVIDER_SOCKET_RECONCILIATION_TEST_MANIFEST,
      actionTargets: [core],
      module: {
        activate(api) {
          api.actions.register(SOCKET_PROVIDER_RECONCILIATION_ACTION_ID, async (input, context): Promise<JsonValue> => {
            const connectionId = isChannelStateJsonRecord(input)
              && typeof input.connectionId === 'string'
              ? input.connectionId
              : 'unresolved-before-create';
            const [list, read] = await Promise.all([
              context.services.actions.execute(
                {
                  pluginId: PLUGIN_MANIFEST.id,
                  localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
                },
                {},
              ),
              context.services.actions.execute(
                {
                  pluginId: PLUGIN_MANIFEST.id,
                  localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead,
                },
                { connectionId },
              ),
            ]);
            return {
              list: requiredActionResult(list, 'connectionsList'),
              read: requiredActionResult(read, 'connectionRead'),
            };
          });
        },
      },
    });
    const createInput = {
      providerSelection: targetedSocketProviderSelection(core),
      providerSetupInput,
      credentialRef: null,
      selectedTransport: 'socket',
      maximumObservationAgeMs: 60_000,
    } as const;

    try {
      await expect(providerReader.invokeAction(SOCKET_PROVIDER_RECONCILIATION_ACTION_ID, {}))
        .resolves.toEqual({ list: {}, read: {} });

      const created = ConversationConnectionCreateResultV1Schema.parse(await core.invokeAction(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
        createInput,
      ));
      expect(created.kind).toBe('created');
      if (created.kind !== 'created') throw new Error('Expected the first registered create to persist.');

      const expected = {
        [created.connectionId]: {
          v: 1,
          connectionId: created.connectionId,
          providerConnectionKey: providerSetup.providerConnectionKey,
          providerConfigVersion: providerSetup.providerConfigVersion,
          providerConfig: providerSetup.providerConfig,
          credentialRef: null,
          authorityEpoch: 1,
          enabled: true,
          deletionState: 'none',
          requiresFullSharedMessageContent: false,
        },
      };
      const connectionRead = await providerReader.invokeAction(
        SOCKET_PROVIDER_RECONCILIATION_ACTION_ID,
        { connectionId: created.connectionId },
      );
      expect(connectionRead).toEqual({ list: expected, read: expected });
      expect([...collection.rows.values()].filter((row) => (
        row.value['record-kind'] === CHANNEL_STATE_RECORD_KIND.connection
      ))).toHaveLength(1);
      expect([...collection.rows.values()].filter((row) => (
        row.value['record-kind'] === CHANNEL_STATE_RECORD_KIND.connectionReservation
      ))).toHaveLength(1);
      const persistedConnection = collection.rows.get(created.connectionId);

      const rejoined = ConversationConnectionCreateResultV1Schema.parse(await core.invokeAction(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
        createInput,
      ));
      expect(rejoined).toEqual({ kind: 'rejoined', connectionId: created.connectionId });
      expect(setupInputs).toEqual([providerSetupInput, providerSetupInput]);
      expect(connectionTestInputs).toEqual([
        expect.objectContaining({
          providerConnectionKey: providerSetup.providerConnectionKey,
          providerConfig: providerSetup.providerConfig,
          credentialRef: null,
          selectedTransport: 'socket',
        }),
        expect.objectContaining({
          providerConnectionKey: providerSetup.providerConnectionKey,
          providerConfig: providerSetup.providerConfig,
          credentialRef: null,
          selectedTransport: 'socket',
        }),
      ]);
      expect([...collection.rows.values()].filter((row) => (
        row.value['record-kind'] === CHANNEL_STATE_RECORD_KIND.connection
      ))).toHaveLength(1);
      expect(collection.rows.get(created.connectionId)).toBe(persistedConnection);
    } finally {
      await providerReader.dispose();
      await core.dispose();
      await setupProvider.dispose();
    }
  });

  it('resolves only the current retained partial custody through the present-user management Action', async () => {
    const connectionId = 'delivery-resolution-connection';
    const state = createMutableChannelStateCollection();
    const deliveries = createMutableChannelStateCollection();
    state.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: reconciliationConnection(connectionId),
    });
    const storage = {
      account: {
        collection(definition: Readonly<{ id: string }>) {
          return definition.id === CHANNEL_DELIVERIES_COLLECTION.id ? deliveries : state;
        },
      },
    } as unknown as PluginServices['storage'];
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage },
    });
    const signal = new AbortController().signal;
    const custody = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 1_700_000_000_000,
    });

    try {
      const created = await custody.ensure({
        connectionId,
        routeAuthority: { connectionAuthorityEpoch: 4 },
        source: { kind: 'controlResponse', controlId: 'delivery-resolution', controlKind: 'recovery' },
        endpoint: { kind: 'direct', audience: 'direct', id: 'conversation-private' },
        content: 'The private delivery body stays in custody.',
        deliveryKey: 'control:delivery-resolution',
        mentionPolicy: 'suppress',
        linkPreviewPolicy: 'suppress',
      });
      if (created.kind !== 'created') throw new Error('Expected retained delivery custody setup.');
      const partial = await custody.compareAndSwap({
        custodyId: created.record.custodyId,
        expectedRevision: created.record.revision,
        custody: {
          state: 'partial',
          attemptCount: 1,
          providerMessageIds: ['provider-message-private'],
          failedChunk: 1,
        },
      });
      if (partial.kind !== 'updated') throw new Error('Expected retained partial custody setup.');

      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryResolve, {
        custodyId: partial.record.custodyId,
        expectedRevision: partial.record.revision,
        resolution: 'accepted',
      })).resolves.toEqual({
        kind: 'resolved',
        custodyId: partial.record.custodyId,
        revision: partial.record.revision + 1,
        resolution: 'accepted',
      });
      expect(deliveries.rows.get(partial.record.custodyId)).toMatchObject({
        revision: partial.record.revision + 1,
        value: {
          payload: {
            state: 'resolvedAccepted',
            providerMessageIds: ['provider-message-private'],
            failedChunk: 1,
          },
          attention: false,
        },
      });
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryResolve, {
        custodyId: partial.record.custodyId,
        expectedRevision: partial.record.revision,
        resolution: 'discarded',
      })).rejects.toMatchObject({
        code: 'channels_delivery_resolve_conflict',
      });
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryResolve, {
        custodyId: partial.record.custodyId,
        expectedRevision: partial.record.revision + 1,
        resolution: 'discarded',
      })).rejects.toMatchObject({
        code: 'channels_delivery_resolve_not_resolvable',
      });
      const foreignCustodyId = 'F'.repeat(43);
      deliveries.rows.set(foreignCustodyId, {
        rowId: foreignCustodyId,
        revision: 1,
        value: {
          id: foreignCustodyId,
          'record-kind': 'not-outward-delivery',
        },
      });
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryResolve, {
        custodyId: foreignCustodyId,
        expectedRevision: 1,
        resolution: 'accepted',
      })).rejects.toMatchObject({
        code: 'channels_delivery_resolve_foreign',
      });
    } finally {
      await core.dispose();
    }
  });

  it('routes the registered Automation result Action into ready C4 custody without a provider effect', async () => {
    type StoredRow = Readonly<{
      rowId: string;
      revision: number;
      value: Record<string, unknown>;
    }>;
    const createCollection = () => {
      const rows = new Map<string, StoredRow>();
      const tombstones = new Set<string>();
      return {
        rows,
        async get(rowId: string): Promise<StoredRow | null> {
          return rows.get(rowId) ?? null;
        },
        async put(value: Record<string, unknown>, input: Readonly<{
          expectedRevision: number | 'absent';
        }>): Promise<StoredRow> {
          const rowId = value.id;
          if (typeof rowId !== 'string') throw new Error('expected collection row id');
          const previous = rows.get(rowId);
          if ((input.expectedRevision === 'absent' && (previous !== undefined || tombstones.has(rowId)))
            || (typeof input.expectedRevision === 'number'
              && previous?.revision !== input.expectedRevision)) {
            throw Object.assign(new Error('unexpected collection CAS conflict'), {
              code: 'plugin_collection_conflict',
            });
          }
          const row = { rowId, revision: (previous?.revision ?? 0) + 1, value };
          rows.set(rowId, row);
          return row;
        },
        async delete(rowId: string, input: Readonly<{ expectedRevision: number }>): Promise<void> {
          const previous = rows.get(rowId);
          if (previous?.revision !== input.expectedRevision) {
            throw Object.assign(new Error('unexpected collection CAS conflict'), {
              code: 'plugin_collection_conflict',
            });
          }
          rows.delete(rowId);
          tombstones.add(rowId);
        },
      };
    };
    const state = createCollection();
    const deliveries = createCollection();
    const automationResultAuthority = {
      providerPluginId: 'example.channel.provider',
      providerContributionSelection: {
        contributionId: 'automation-result-provider',
        immutableGenerationId: 'automation-result-generation',
      },
      providerSetupInput: { source: 'automation-result' },
      credentialRef: null,
      transportOrigin: {
        serverIdentityId: 'srv_account_one',
        materializationRef: {
          pluginId: 'example.channel.provider',
          machineId: 'machine-1',
          materializationId: 'provider-1',
        },
      },
      providerConnectionKey: 'provider-connection-1',
      providerConfig: { account: 'account-1' },
      routingIdentityKey: 'a'.repeat(43),
      integrationPrincipal: { id: 'provider:principal-1' },
      authorityEpoch: 4,
    } as const satisfies ConversationConnectionFixtureAuthority;
    await state.put(createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority: automationResultAuthority,
      transport: { kind: 'checkpointedPull' },
      overlapSafety: 'safe',
      replayContinuity: 'checkpointed',
      outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
    }), { expectedRevision: 'absent' });
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
        target: {
          kind: 'automation',
          automationId: 'automation-1',
          templateVersion: 3,
          policy: { resultDelivery: 'finalResult' },
        },
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 'absent' });
    // Storage is the genuine host boundary. The registered Action retains the
    // real Channels preparation and custody path underneath it.
    const storage = {
      account: {
        collection(definition: Readonly<{ id: string }>) {
          return definition.id === CHANNEL_DELIVERIES_COLLECTION.id ? deliveries : state;
        },
      },
    } as unknown as PluginServices['storage'];
    const source = {
      kind: 'automationResult',
      automationRunId: 'run-1',
      resultId: 'handoff-1',
      automationId: 'automation-1',
      templateVersion: 3,
      resultDelivery: 'finalResult',
    } as const;
    const context: PluginInvocationContext = {
      plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
      contribution: {
        id: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.automationResultDeliver,
        qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.automationResultDeliver}`,
      },
      surface: 'plugin',
      caller: {
        kind: 'automationRun',
        automationId: 'automation-1',
        runId: 'run-1',
        origin: 'conversation',
      },
      signal: new AbortController().signal,
      services: { storage } as unknown as PluginServices,
    };
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const handler = activation.registration(
        'actions',
        CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.automationResultDeliver,
      );
      expect(handler).toBeDefined();
      if (handler === undefined) return;

      const input = {
        v: 1,
        handoffId: 'handoff-1',
        runId: 'run-1',
        automationId: 'automation-1',
        source,
        result: { v: 1, kind: 'text', text: 'Completed.' },
        opaqueContext: {
          v: 1,
          kind: 'conversationAutomationResultDelivery',
          connectionId: 'connection-1',
          bindingId: 'binding-1',
          bindingRevision: 1,
          connectionAuthorityEpoch: 4,
          bindingAuthorityEpoch: 7,
          endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
          reply: { providerMessageId: 'message-1' },
          linkPreviewPolicy: 'suppress',
        },
      } as const;
      const first = await handler(input, context);
      expect(first).toEqual({
        kind: 'accepted',
        custodyId: expect.any(String),
      });
      await expect(handler(input, context)).resolves.toEqual(first);
      expect([...deliveries.rows.values()]).toHaveLength(1);
      const delivery = [...deliveries.rows.values()][0];
      expect(delivery?.value.payload).toMatchObject({
        source,
        content: 'Completed.',
        deliveryKey: 'automation:handoff-1',
        replyContext: { replyToMessageId: 'message-1' },
        state: 'ready',
      });
      if (delivery === undefined) throw new Error('Expected retained Automation result custody.');
      await deliveries.delete(delivery.rowId, { expectedRevision: delivery.revision });
      await expect(handler(input, context)).resolves.toEqual({ kind: 'retired' });
      expect([...deliveries.rows.values()]).toHaveLength(0);
    } finally {
      await activation.dispose();
    }
  });

  it('updates one retained connection through its guarded row CAS and lets the provider list/read projection reread only the current snapshot', async () => {
    const connectionId = 'connection-update-1';
    const updatedBatches: Array<readonly MutableChannelStateMutation[]> = [];
    let abortDuringConnectionGet: AbortController | null = null;
    let retireDuringConnectionGet = false;
    let supersedeConnectionUpdateDuringBatch = false;
    let retireCore: (() => void) | null = null;
    const collection = createMutableChannelStateCollection({
      onGet(rowId) {
        if (rowId !== connectionId) return;
        abortDuringConnectionGet?.abort();
        if (retireDuringConnectionGet) retireCore?.();
      },
      onBeforeBatch(operations, rows) {
        if (!supersedeConnectionUpdateDuringBatch || !operations.some((operation) => (
          operation.kind === 'put' && operation.value.id === connectionId
        ))) return;
        supersedeConnectionUpdateDuringBatch = false;
        const current = rows.get(connectionId);
        if (current === undefined) throw new Error('Expected the concurrent connection row.');
        rows.set(connectionId, { ...current, revision: current.revision + 1 });
      },
      onUpdatedBatch(operations) {
        updatedBatches.push(operations);
      },
    });
    const initial = reconciliationConnection(connectionId);
    const initialPayload = {
      ...initial.payload,
      historyGap: { reportedAt: 1_700_000_000_000, reason: 'providerHistoryUnavailable' as const },
    };
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: { ...initial, payload: initialPayload },
    });
    // This composed fixture exercises the state-row writer. Give the newly
    // observed, distinct delivery Collection its own host boundary rather than
    // pretending both manifest declarations share one watch stream.
    const deliveriesCollection = {
      async query(request: Readonly<{ limit?: number }>) {
        assertChannelsTestCollectionQueryLimit(request.limit);
        return { rows: [], changeCursor: 0 };
      },
      watch: () => ({ dispose: () => {} }),
    };
    const storage = {
      account: {
        collection: (definition: Readonly<{ id: string }>) => (
          definition.id === CHANNEL_DELIVERIES_COLLECTION.id ? deliveriesCollection : collection
        ),
      },
    } as unknown as PluginServices['storage'];
    const resourceAccountStorage = storage.account as PluginAccountStorageScope;
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage },
    });
    retireCore = () => { void core.dispose(); };
    const reconciler = await createPluginTestkit({
      manifest: PROVIDER_RECONCILIATION_TEST_MANIFEST,
      actionTargets: [core],
      module: {
        activate(api) {
          api.actions.register('reconcile', async (_input, context): Promise<JsonValue> => {
            const list = await context.services.actions.execute(
              { pluginId: PLUGIN_MANIFEST.id, localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList },
              {},
            );
            const read = await context.services.actions.execute(
              { pluginId: PLUGIN_MANIFEST.id, localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead },
              { connectionId },
            );
            return {
              list: requiredActionResult(list, 'connectionsList'),
              read: requiredActionResult(read, 'connectionRead'),
            };
          });
        },
      },
    });

    try {
      const resource = core.registration('resources', 'connections-v1');
      if (resource === undefined) throw new Error('Expected the connections-v1 dynamic Resource registration.');
      let invalidations = 0;
      const observation = resource.observe(
        () => { invalidations += 1; },
        {
          signal: new AbortController().signal,
          context: { kind: 'global' },
          accountStorage: resourceAccountStorage,
        },
      );
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate, {
        connectionId,
        expectedRevision: 4,
        enabled: false,
        maximumObservationAgeMs: 120_000,
      })).resolves.toEqual({
        kind: 'updated',
        connectionId,
        revision: 5,
        authorityEpoch: 5,
      });
      expect(updatedBatches).toEqual([[
        {
          kind: 'put',
          expectedRevision: 4,
          value: expect.objectContaining({
            id: connectionId,
            'record-kind': 'connection',
            'connection-id': connectionId,
            payload: expect.objectContaining({
              authorityEpoch: 5,
              enabled: false,
              historyGap: null,
              maximumObservationAgeMs: 120_000,
              observationAgeExpansionFloorOccurredAt: expect.any(Number),
            }),
          }),
        },
      ]]);
      const updated = collection.rows.get(connectionId);
      expect(updated?.revision).toBe(5);
      expect(updated?.value['updated-at']).toBeGreaterThan(1);
      const updatedPayload = updated?.value.payload;
      if (!isChannelStateJsonRecord(updatedPayload)) {
        throw new Error('Expected the updated connection row to carry a payload record.');
      }
      const observationAgeExpansionFloorOccurredAt = updatedPayload.observationAgeExpansionFloorOccurredAt;
      expect(observationAgeExpansionFloorOccurredAt).toEqual(expect.any(Number));
      expect(updated?.value.payload).toEqual({
        ...initialPayload,
        authorityEpoch: 5,
        enabled: false,
        historyGap: null,
        maximumObservationAgeMs: 120_000,
        observationAgeExpansionFloorOccurredAt,
      });
      expect(invalidations).toBe(2);
      await expect(resource.read({
        signal: new AbortController().signal,
        context: { kind: 'global' },
        accountStorage: resourceAccountStorage,
      })).resolves.toEqual(JSON.stringify({
        connections: [{
          connectionId,
          revision: 5,
          providerPluginId: initialPayload.providerPluginId,
          selectedMachineId: 'plugin-testkit-machine',
          selectedTransport: 'socket',
          integrationPrincipalLabel: 'Happier',
          authorityEpoch: 5,
          enabled: false,
          deletionState: 'none',
          maximumObservationAgeMs: 120_000,
          attention: {
            historyGap: null,
            providerReadiness: null,
            ingressConflict: null,
            pollFailure: null,
            bestEffortBeforeDurableAdmission: false,
            oldTransportStopUnconfirmed: false,
            acceptedPossibleLoss: false,
            outwardDelivery: NO_OUTWARD_DELIVERY_ATTENTION,
          },
        }],
      }));
      observation.dispose();

      const expectedSnapshot = {
        [connectionId]: {
          v: 1,
          connectionId,
          providerConnectionKey: initialPayload.providerConnectionKey,
          providerConfigVersion: 1,
          providerConfig: initialPayload.providerConfig,
          credentialRef: null,
          authorityEpoch: 5,
          enabled: false,
          deletionState: 'none',
          requiresFullSharedMessageContent: false,
        },
      };
      await expect(reconciler.invokeAction('reconcile', {})).resolves.toEqual({
        list: expectedSnapshot,
        read: expectedSnapshot,
      });

      const writeCountAfterSuccess = updatedBatches.length;
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate, {
        connectionId,
        expectedRevision: 5,
        enabled: false,
        maximumObservationAgeMs: 120_000,
      })).resolves.toEqual({
        kind: 'unchanged',
        connectionId,
        revision: 5,
        authorityEpoch: 5,
      });
      expect(updatedBatches).toHaveLength(writeCountAfterSuccess);
      expect(collection.rows.get(connectionId)?.revision).toBe(5);

      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate, {
        connectionId,
        expectedRevision: 4,
        enabled: true,
        maximumObservationAgeMs: 120_000,
      })).rejects.toMatchObject({
        code: 'channels_connection_update_conflict',
        retryable: true,
      });
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate, {
        connectionId,
        expectedRevision: 5,
        enabled: false,
        maximumObservationAgeMs: 30 * 86_400_000 + 1,
      })).rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
      expect(updatedBatches).toHaveLength(writeCountAfterSuccess);
      expect(collection.rows.get(connectionId)?.revision).toBe(5);

      const cancellation = new AbortController();
      abortDuringConnectionGet = cancellation;
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate, {
        connectionId,
        expectedRevision: 5,
        enabled: true,
        maximumObservationAgeMs: 120_000,
      }, { signal: cancellation.signal })).rejects.toMatchObject({ code: 'plugin_action_aborted' });
      abortDuringConnectionGet = null;
      expect(updatedBatches).toHaveLength(writeCountAfterSuccess);
      expect(collection.rows.get(connectionId)?.revision).toBe(5);

      supersedeConnectionUpdateDuringBatch = true;
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate, {
        connectionId,
        expectedRevision: 5,
        enabled: true,
        maximumObservationAgeMs: 120_000,
      })).rejects.toMatchObject({
        code: 'channels_connection_update_conflict',
        retryable: true,
      });
      expect(updatedBatches).toHaveLength(writeCountAfterSuccess);
      expect(collection.rows.get(connectionId)?.revision).toBe(6);

      retireDuringConnectionGet = true;
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate, {
        connectionId,
        expectedRevision: 6,
        enabled: true,
        maximumObservationAgeMs: 120_000,
      })).rejects.toMatchObject({ code: 'plugin_action_generation_retired' });
      retireDuringConnectionGet = false;
      expect(updatedBatches).toHaveLength(writeCountAfterSuccess);
      expect(collection.rows.get(connectionId)?.revision).toBe(6);
    } finally {
      await reconciler.dispose();
      await core.dispose();
    }
  });

  it('uses the generic exact-origin precondition before stopping an old transport and settles only its returned proof', async () => {
    const exactConnectionId = 'connection-delete-exact-origin';
    const mismatchConnectionId = 'connection-delete-mismatch-origin';
    const collection = createMutableChannelStateCollection();
    const stopInputs: ReturnType<typeof ConversationProviderConnectionStopInputV1Schema.parse>[] = [];
    const provider = await createPluginTestkit({
      manifest: PROVIDER_SOCKET_SETUP_TEST_MANIFEST,
      module: {
        activate(api) {
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.setup, async () => {
            throw new Error('The old-stop fixture must not set up a connection.');
          });
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.connectionTest, async () => {
            throw new Error('The old-stop fixture must not test a connection.');
          });
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.messageDeliver, async () => ({ kind: 'delivered' }));
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.connectionStop, async (input) => {
            stopInputs.push(ConversationProviderConnectionStopInputV1Schema.parse(input));
            return { kind: 'stopped' };
          });
          api.backgroundServices.register('socket-supervisor', async () => {});
        },
      },
    });
    const storage = {
      account: { collection: () => collection },
    } as unknown as PluginServices['storage'];
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: {
        storage,
      },
      actionTargets: [provider],
      targetedContributionContributors: [provider],
    });
    const providerContributionSelection = targetedSocketProviderSelection(core).contributor;
    const exact = socketConnectionForProvider({
      connectionId: exactConnectionId,
      providerPluginId: PROVIDER_SOCKET_SETUP_TEST_MANIFEST.id,
      providerContributionSelection,
    });
    const mismatch = socketConnectionForProvider({
      connectionId: mismatchConnectionId,
      providerPluginId: PROVIDER_SOCKET_SETUP_TEST_MANIFEST.id,
      materializationId: 'old-transport-materialization',
      providerContributionSelection,
    });
    collection.rows.set(exactConnectionId, { rowId: exactConnectionId, revision: 4, value: exact });
    collection.rows.set(mismatchConnectionId, { rowId: mismatchConnectionId, revision: 4, value: mismatch });

    try {
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete, {
        connectionId: mismatchConnectionId,
        expectedRevision: 4,
      })).rejects.toMatchObject({ code: 'plugin_action_execution_origin_mismatch' });
      expect(stopInputs).toEqual([]);
      expect(collection.rows.get(mismatchConnectionId)).toMatchObject({
        revision: 5,
        value: {
          payload: {
            authorityEpoch: 5,
            enabled: false,
            deletionState: 'pendingStopReconciliation',
            pendingOldTransportStop: {
              transportOrigin: mismatch.payload.transportOrigin,
              acceptedPossibleLoss: false,
            },
          },
        },
      });

      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete, {
        connectionId: exactConnectionId,
        expectedRevision: 4,
      })).resolves.toEqual({
        kind: 'deleteFinalizing',
        connectionId: exactConnectionId,
        revision: 6,
        authorityEpoch: 5,
        acceptedPossibleLoss: false,
      });
      expect(stopInputs).toEqual([{
        v: 1,
        connectionId: exactConnectionId,
        providerConnectionKey: `discord:${exactConnectionId}`,
        providerConfigVersion: 1,
        providerConfig: { applicationId: 'application-1' },
        credentialRef: null,
        authorityEpoch: 5,
        reason: 'delete',
      }]);
      expect(collection.rows.get(exactConnectionId)).toMatchObject({
        revision: 6,
        value: {
          payload: {
            authorityEpoch: 5,
            enabled: false,
            deletionState: 'finalizingDelete',
            pendingOldTransportStop: null,
          },
        },
      });
    } finally {
      await core.dispose();
      await provider.dispose();
    }
  });

  it('does not invoke an old delete transport after its retained authority advances', async () => {
    const connectionId = 'connection-delete-stop-currentness';
    let stopCalls = 0;
    let supersedePendingDelete = true;
    let collection!: ReturnType<typeof createMutableChannelStateCollection>;
    let connection!: ReturnType<typeof socketConnectionForProvider>;
    collection = createMutableChannelStateCollection({
      onUpdatedBatch(operations) {
        if (!supersedePendingDelete || !operations.some((operation) => (
          operation.kind === 'put' && operation.value.id === connectionId
        ))) return;
        supersedePendingDelete = false;
        collection.rows.set(connectionId, {
          rowId: connectionId,
          revision: 6,
          value: {
            ...connection,
            payload: {
              ...connection.payload,
              authorityEpoch: 6,
              enabled: false,
              deletionState: 'finalizingDelete',
              pendingOldTransportStop: {
                transportOrigin: connection.payload.transportOrigin,
                providerContributionSelection: connection.payload.providerContributionSelection,
                overlapSafety: connection.payload.overlapSafety,
                stopRequest: {
                  v: 1,
                  connectionId,
                  providerConnectionKey: connection.payload.providerConnectionKey,
                  providerConfigVersion: connection.payload.providerConfigVersion,
                  providerConfig: connection.payload.providerConfig,
                  credentialRef: connection.payload.credentialRef,
                  authorityEpoch: 5,
                  reason: 'delete',
                },
                acceptedPossibleLoss: true,
              },
              historyGap: null,
            },
          },
        });
      },
    });
    const provider = await createPluginTestkit({
      manifest: PROVIDER_SOCKET_SETUP_TEST_MANIFEST,
      module: {
        activate(api) {
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.setup, async () => {
            throw new Error('The currentness fixture must not set up a connection.');
          });
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.connectionTest, async () => {
            throw new Error('The currentness fixture must not test a connection.');
          });
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.messageDeliver, async () => ({ kind: 'delivered' }));
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.connectionStop, async () => {
            stopCalls += 1;
            return { kind: 'stopped' };
          });
          api.backgroundServices.register('socket-supervisor', async () => {});
        },
      },
    });
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: {
        storage: storageWithEmptyChannelDeliveries(collection),
      },
      actionTargets: [provider],
      targetedContributionContributors: [provider],
    });
    const socket = socketConnectionForProvider({
      connectionId,
      providerPluginId: PROVIDER_SOCKET_SETUP_TEST_MANIFEST.id,
      providerContributionSelection: targetedSocketProviderSelection(core).contributor,
    });
    connection = {
      ...socket,
      payload: {
        ...socket.payload,
        pollFailure: null,
      },
    };
    collection.rows.set(connectionId, { rowId: connectionId, revision: 4, value: connection });

    try {
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete, {
        connectionId,
        expectedRevision: 4,
      })).rejects.toMatchObject({
        code: 'channels_connection_delete_stop_currentness_conflict',
      });
      expect(stopCalls).toBe(0);
      expect(collection.rows.get(connectionId)).toMatchObject({
        revision: 6,
        value: {
          payload: {
            authorityEpoch: 6,
            deletionState: 'finalizingDelete',
            pendingOldTransportStop: { acceptedPossibleLoss: true },
          },
        },
      });
    } finally {
      await core.dispose();
      await provider.dispose();
    }
  });

  it('leaves a checkpointed deletion pending for core poll quiescence without calling provider connection-stop', async () => {
    const connectionId = 'connection-delete-checkpointed-core-quiescence';
    const collection = createMutableChannelStateCollection();
    const stopInputs: ReturnType<typeof ConversationProviderConnectionStopInputV1Schema.parse>[] = [];
    const provider = await createPluginTestkit({
      manifest: PROVIDER_SOCKET_SETUP_TEST_MANIFEST,
      module: {
        activate(api) {
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.setup, async () => {
            throw new Error('The checkpointed-delete fixture must not set up a connection.');
          });
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.connectionTest, async () => {
            throw new Error('The checkpointed-delete fixture must not test a connection.');
          });
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.messageDeliver, async () => ({ kind: 'delivered' }));
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.connectionStop, async (input) => {
            stopInputs.push(ConversationProviderConnectionStopInputV1Schema.parse(input));
            return { kind: 'stopped' };
          });
          api.backgroundServices.register('socket-supervisor', async () => {});
        },
      },
    });
    const storage = {
      account: { collection: () => collection },
    } as unknown as PluginServices['storage'];
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: {
        storage,
      },
      actionTargets: [provider],
      targetedContributionContributors: [provider],
    });
    const socket = socketConnectionForProvider({
      connectionId,
      providerPluginId: PROVIDER_SOCKET_SETUP_TEST_MANIFEST.id,
      providerContributionSelection: targetedSocketProviderSelection(core).contributor,
    });
    const connection = {
      ...socket,
      payload: {
        ...socket.payload,
        transport: { kind: 'checkpointedPull' as const },
        replayContinuity: 'checkpointed' as const,
      },
    };
    collection.rows.set(connectionId, { rowId: connectionId, revision: 4, value: connection });

    try {
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete, {
        connectionId,
        expectedRevision: 4,
      })).resolves.toEqual({
        kind: 'deletePending',
        connectionId,
        revision: 5,
        authorityEpoch: 5,
        acceptedPossibleLoss: false,
      });
      expect(stopInputs).toEqual([]);
      expect(collection.rows.get(connectionId)).toMatchObject({
        revision: 5,
        value: {
          payload: {
            authorityEpoch: 5,
            enabled: false,
            deletionState: 'pendingStopReconciliation',
            pendingOldTransportStop: expect.objectContaining({
              transportOrigin: connection.payload.transportOrigin,
              acceptedPossibleLoss: false,
            }),
          },
        },
      });
    } finally {
      await core.dispose();
      await provider.dispose();
    }
  });

  it('keeps a response-lost old-stop slot through reload until explicit accepted-loss abandonment', async () => {
    const connectionId = 'connection-delete-response-loss';
    const collection = createMutableChannelStateCollection();
    let stopCalls = 0;
    const provider = await createPluginTestkit({
      manifest: PROVIDER_SOCKET_SETUP_TEST_MANIFEST,
      module: {
        activate(api) {
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.setup, async () => {
            throw new Error('The response-loss fixture must not set up a connection.');
          });
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.connectionTest, async () => {
            throw new Error('The response-loss fixture must not test a connection.');
          });
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.messageDeliver, async () => ({ kind: 'delivered' }));
          api.actions.register(SOCKET_PROVIDER_ACTION_ID.connectionStop, async () => {
            stopCalls += 1;
            throw new PluginError({
              code: 'provider_stop_response_lost',
              message: 'The old transport may already have received the stop request.',
              retryable: true,
            });
          });
          api.backgroundServices.register('socket-supervisor', async () => {});
        },
      },
    });
    const storage = storageWithEmptyChannelDeliveries(collection);
    let core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: {
        storage,
      },
      actionTargets: [provider],
      targetedContributionContributors: [provider],
    });
    const connection = socketConnectionForProvider({
      connectionId,
      providerPluginId: PROVIDER_SOCKET_SETUP_TEST_MANIFEST.id,
      providerContributionSelection: targetedSocketProviderSelection(core).contributor,
    });
    collection.rows.set(connectionId, { rowId: connectionId, revision: 4, value: connection });

    try {
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete, {
        connectionId,
        expectedRevision: 4,
      })).rejects.toMatchObject({ code: 'provider_stop_response_lost' });
      expect(stopCalls).toBe(1);
      expect(collection.rows.get(connectionId)).toMatchObject({
        revision: 5,
        value: {
          payload: {
            authorityEpoch: 5,
            deletionState: 'pendingStopReconciliation',
            pendingOldTransportStop: { acceptedPossibleLoss: false },
          },
        },
      });

      await core.dispose();
      core = await createPluginTestkit({
        manifest: PLUGIN_MANIFEST,
        module: { activate },
        services: {
          storage,
        },
        actionTargets: [provider],
        targetedContributionContributors: [provider],
      });

      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete, {
        connectionId,
        expectedRevision: 5,
      })).resolves.toEqual({
        kind: 'rejoined',
        connectionId,
        revision: 5,
        authorityEpoch: 5,
        acceptedPossibleLoss: false,
      });
      expect(stopCalls).toBe(1);

      const resource = core.registration('resources', 'connections-v1');
      if (resource === undefined) throw new Error('Expected the connections-v1 dynamic Resource registration.');
      const pendingResource = resourceText(await resource.read({
        signal: new AbortController().signal,
        context: { kind: 'global' },
        accountStorage: storage.account as PluginAccountStorageScope,
      }));
      expect(JSON.parse(pendingResource)).toEqual({
        connections: [expect.objectContaining({
          connectionId,
          authorityEpoch: 5,
          attention: {
            historyGap: null,
            providerReadiness: null,
            pollFailure: null,
            ingressConflict: null,
            bestEffortBeforeDurableAdmission: false,
            oldTransportStopUnconfirmed: true,
            acceptedPossibleLoss: false,
            outwardDelivery: NO_OUTWARD_DELIVERY_ATTENTION,
          },
        })],
      });

      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon, {
        connectionId,
        expectedRevision: 5,
      })).resolves.toEqual({
        kind: 'deleteFinalizing',
        connectionId,
        revision: 6,
        authorityEpoch: 6,
        acceptedPossibleLoss: true,
      });
      expect(collection.rows.get(connectionId)).toMatchObject({
        revision: 6,
        value: {
          payload: {
            deletionState: 'finalizingDelete',
            pendingOldTransportStop: { acceptedPossibleLoss: true },
          },
        },
      });
      const acceptedResource = resourceText(await resource.read({
        signal: new AbortController().signal,
        context: { kind: 'global' },
        accountStorage: storage.account as PluginAccountStorageScope,
      }));
      expect(JSON.parse(acceptedResource)).toEqual({
        connections: [expect.objectContaining({
          connectionId,
          authorityEpoch: 6,
          attention: {
            historyGap: null,
            providerReadiness: null,
            pollFailure: null,
            ingressConflict: null,
            bestEffortBeforeDurableAdmission: false,
            oldTransportStopUnconfirmed: true,
            acceptedPossibleLoss: true,
            outwardDelivery: NO_OUTWARD_DELIVERY_ATTENTION,
          },
        })],
      });
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete, {
        connectionId,
        expectedRevision: 6,
      })).resolves.toEqual({
        kind: 'rejoined',
        connectionId,
        revision: 6,
        authorityEpoch: 6,
        acceptedPossibleLoss: true,
      });
      expect(stopCalls).toBe(1);
    } finally {
      await core.dispose();
      await provider.dispose();
    }
  });

  it('retains an accepted transfer slot through reload, rejoins exact retries without writes, and permits a later delete replacement', async () => {
    const connectionId = 'connection-transfer-accepted-loss';
    const updatedBatches: Array<readonly MutableChannelStateMutation[]> = [];
    const collection = createMutableChannelStateCollection({
      onUpdatedBatch(operations) {
        updatedBatches.push(operations);
      },
    });
    const pending = connectionWithPendingTransfer({
      connectionId,
      acceptedPossibleLoss: false,
      authorityEpoch: 4,
      stopAuthorityEpoch: 4,
    });
    const frozenStop = pending.payload.pendingOldTransportStop;
    collection.rows.set(connectionId, { rowId: connectionId, revision: 4, value: pending });
    const storage = storageWithEmptyChannelDeliveries(collection);
    let core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage },
    });

    try {
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon, {
        connectionId,
        expectedRevision: 4,
      })).resolves.toEqual({
        kind: 'rejoined',
        connectionId,
        revision: 5,
        authorityEpoch: 5,
        acceptedPossibleLoss: true,
      });
      expect(updatedBatches).toHaveLength(1);
      expect(collection.rows.get(connectionId)).toMatchObject({
        revision: 5,
        value: {
          payload: {
            authorityEpoch: 5,
            deletionState: 'none',
            pendingOldTransportStop: {
              ...frozenStop,
              acceptedPossibleLoss: true,
            },
          },
        },
      });

      await core.dispose();
      core = await createPluginTestkit({
        manifest: PLUGIN_MANIFEST,
        module: { activate },
        services: { storage },
      });

      const resource = core.registration('resources', 'connections-v1');
      if (resource === undefined) throw new Error('Expected the connections-v1 dynamic Resource registration.');
      const acceptedResource = resourceText(await resource.read({
        signal: new AbortController().signal,
        context: { kind: 'global' },
        accountStorage: storage.account as PluginAccountStorageScope,
      }));
      expect(JSON.parse(acceptedResource)).toEqual({
        connections: [expect.objectContaining({
          connectionId,
          revision: 5,
          authorityEpoch: 5,
          deletionState: 'none',
          attention: expect.objectContaining({
            oldTransportStopUnconfirmed: true,
            acceptedPossibleLoss: true,
          }),
        })],
      });

      for (const expectedRevision of [4, 5]) {
        await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon, {
          connectionId,
          expectedRevision,
        })).resolves.toEqual({
          kind: 'rejoined',
          connectionId,
          revision: 5,
          authorityEpoch: 5,
          acceptedPossibleLoss: true,
        });
      }
      expect(updatedBatches).toHaveLength(1);

      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate, {
        connectionId,
        expectedRevision: 5,
        enabled: true,
        maximumObservationAgeMs: 120_000,
      })).resolves.toEqual({
        kind: 'updated',
        connectionId,
        revision: 6,
        authorityEpoch: 5,
      });
      expect(collection.rows.get(connectionId)).toMatchObject({
        revision: 6,
        value: {
          payload: {
            pendingOldTransportStop: {
              ...frozenStop,
              acceptedPossibleLoss: true,
            },
          },
        },
      });
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon, {
        connectionId,
        expectedRevision: 4,
      })).rejects.toMatchObject({ code: 'channels_connection_abandon_conflict' });
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon, {
        connectionId,
        expectedRevision: 6,
      })).resolves.toEqual({
        kind: 'rejoined',
        connectionId,
        revision: 6,
        authorityEpoch: 5,
        acceptedPossibleLoss: true,
      });
      expect(updatedBatches).toHaveLength(2);

      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete, {
        connectionId,
        expectedRevision: 6,
      })).resolves.toEqual({
        kind: 'deletePending',
        connectionId,
        revision: 7,
        authorityEpoch: 6,
        acceptedPossibleLoss: false,
      });
      expect(collection.rows.get(connectionId)).toMatchObject({
        revision: 7,
        value: {
          payload: {
            authorityEpoch: 6,
            deletionState: 'pendingStopReconciliation',
            pendingOldTransportStop: {
              stopRequest: { reason: 'delete', authorityEpoch: 6 },
              acceptedPossibleLoss: false,
            },
          },
        },
      });
      expect(updatedBatches).toHaveLength(3);
    } finally {
      await core.dispose();
    }
  });

  it('rejects stale accepted-loss retries unless the retained transfer marker is the exact immediate successor', async () => {
    const collection = createMutableChannelStateCollection();
    const immediate = connectionWithPendingTransfer({
      connectionId: 'connection-transfer-stale-r-plus-two',
      acceptedPossibleLoss: true,
      authorityEpoch: 5,
      stopAuthorityEpoch: 4,
    });
    collection.rows.set(immediate.id, { rowId: immediate.id, revision: 6, value: immediate });

    const malformed = connectionWithPendingTransfer({
      connectionId: 'connection-transfer-stale-malformed',
      acceptedPossibleLoss: true,
      authorityEpoch: 4,
      stopAuthorityEpoch: 4,
    });
    collection.rows.set(malformed.id, { rowId: malformed.id, revision: 5, value: malformed });

    const differentBase = connectionWithPendingTransfer({
      connectionId: 'connection-transfer-stale-different',
      acceptedPossibleLoss: true,
      authorityEpoch: 5,
      stopAuthorityEpoch: 4,
    });
    const differentBaseStop = differentBase.payload.pendingOldTransportStop;
    if (differentBaseStop === null) {
      throw new Error('Expected the pending-transfer fixture to carry an accepted stop marker.');
    }
    const different = {
      ...differentBase,
      payload: {
        ...differentBase.payload,
        pendingOldTransportStop: {
          ...differentBaseStop,
          stopRequest: {
            ...differentBaseStop.stopRequest,
            connectionId: 'connection-other',
          },
        },
      },
    };
    collection.rows.set(different.id, { rowId: different.id, revision: 5, value: different });

    const deletingBase = reconciliationConnection('connection-transfer-stale-deleting');
    const deleting = {
      ...deletingBase,
      payload: {
        ...deletingBase.payload,
        authorityEpoch: 5,
        enabled: false,
        deletionState: 'finalizingDelete' as const,
        pendingOldTransportStop: {
          predecessorCheckpointedPollInvocation: {
            connectionRevision: 3,
            authorityEpoch: 3,
            transportOrigin: deletingBase.payload.transportOrigin,
          },
          transportOrigin: deletingBase.payload.transportOrigin,
          providerContributionSelection: deletingBase.payload.providerContributionSelection,
          overlapSafety: deletingBase.payload.overlapSafety,
          stopRequest: {
            v: 1 as const,
            connectionId: deletingBase.id,
            providerConnectionKey: deletingBase.payload.providerConnectionKey,
            providerConfigVersion: deletingBase.payload.providerConfigVersion,
            providerConfig: deletingBase.payload.providerConfig,
            credentialRef: deletingBase.payload.credentialRef,
            authorityEpoch: 4,
            reason: 'delete' as const,
          },
          acceptedPossibleLoss: true,
        },
      },
    };
    collection.rows.set(deleting.id, { rowId: deleting.id, revision: 5, value: deleting });

    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage: storageWithEmptyChannelDeliveries(collection) },
    });
    try {
      for (const connectionId of [immediate.id, malformed.id, different.id, deleting.id]) {
        await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon, {
          connectionId,
          expectedRevision: 4,
        })).rejects.toMatchObject({ code: 'channels_connection_abandon_conflict' });
      }
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon, {
        connectionId: malformed.id,
        expectedRevision: 5,
      })).rejects.toMatchObject({ code: 'channels_connection_abandon_conflict' });
    } finally {
      await core.dispose();
    }
  });

  it('lets concurrent abandon retries produce exactly one accepted transfer-marker write', async () => {
    const connectionId = 'connection-transfer-abandon-race';
    const updatedBatches: Array<readonly MutableChannelStateMutation[]> = [];
    const collection = createMutableChannelStateCollection({
      onUpdatedBatch(operations) {
        updatedBatches.push(operations);
      },
    });
    const pending = connectionWithPendingTransfer({
      connectionId,
      acceptedPossibleLoss: false,
      authorityEpoch: 4,
      stopAuthorityEpoch: 4,
    });
    collection.rows.set(connectionId, { rowId: connectionId, revision: 4, value: pending });

    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage: storageWithEmptyChannelDeliveries(collection) },
    });
    try {
      const outcomes = await Promise.allSettled([
        core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon, {
          connectionId,
          expectedRevision: 4,
        }),
        core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon, {
          connectionId,
          expectedRevision: 4,
        }),
      ]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(fulfilled.every((outcome) => (
        outcome.status === 'fulfilled'
        && JSON.stringify(outcome.value) === JSON.stringify({
          kind: 'rejoined',
          connectionId,
          revision: 5,
          authorityEpoch: 5,
          acceptedPossibleLoss: true,
        })
      ))).toBe(true);
      expect(rejected.every((outcome) => (
        outcome.status === 'rejected'
        && typeof outcome.reason === 'object'
        && outcome.reason !== null
        && 'code' in outcome.reason
        && outcome.reason.code === 'channels_connection_abandon_conflict'
      ))).toBe(true);
      expect(updatedBatches).toHaveLength(1);
      expect(collection.rows.get(connectionId)).toMatchObject({
        revision: 5,
        value: {
          payload: {
            authorityEpoch: 5,
            pendingOldTransportStop: { acceptedPossibleLoss: true },
          },
        },
      });
    } finally {
      await core.dispose();
    }
  });

  it('settles a retained old-stop slot only from the exact host-stamped transport reporter', async () => {
    const connectionId = 'connection-delete-reported-stop';
    const collection = createMutableChannelStateCollection();
    const current = socketConnectionForProvider({
      connectionId,
      providerPluginId: PROVIDER_TRANSPORT_REPORT_TEST_MANIFEST.id,
    });
    const stopRequest = {
      v: 1 as const,
      connectionId,
      providerConnectionKey: current.payload.providerConnectionKey,
      providerConfigVersion: current.payload.providerConfigVersion,
      providerConfig: current.payload.providerConfig,
      credentialRef: current.payload.credentialRef,
      authorityEpoch: 5,
      reason: 'delete' as const,
    };
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: {
        ...current,
        payload: {
          ...current.payload,
          authorityEpoch: 5,
          enabled: false,
          deletionState: 'pendingStopReconciliation',
          historyGap: null,
          pendingOldTransportStop: {
            predecessorCheckpointedPollInvocation: {
              connectionRevision: 3,
              authorityEpoch: 4,
              transportOrigin: current.payload.transportOrigin,
            },
            transportOrigin: current.payload.transportOrigin,
            providerContributionSelection: current.payload.providerContributionSelection,
            overlapSafety: current.payload.overlapSafety,
            stopRequest,
            acceptedPossibleLoss: false,
          },
        },
      },
    });
    const storage = {
      account: { collection: () => collection },
    } as unknown as PluginServices['storage'];
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage },
    });
    let materializationId = 'replacement-materialization';
    const reporter = await createPluginTestkit({
      manifest: PROVIDER_TRANSPORT_REPORT_TEST_MANIFEST,
      actionTargets: [core],
      resolveCurrentPluginMaterializationRef() {
        return {
          pluginId: PROVIDER_TRANSPORT_REPORT_TEST_MANIFEST.id,
          machineId: 'plugin-testkit-machine',
          materializationId,
        };
      },
      module: {
        activate(api) {
          api.actions.register('report-stop', async (input, context) => await context.services.actions.execute(
            {
              pluginId: PLUGIN_MANIFEST.id,
              localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport,
            },
            input,
          ));
        },
      },
    });
    const report = {
      connectionId,
      authorityEpoch: 5,
      fact: { kind: 'stopConfirmed' as const, reason: 'notRunningOnReconcile' as const },
    };

    try {
      await expect(reporter.invokeAction('report-stop', report)).resolves.toEqual({ kind: 'staleAuthority' });
      expect(collection.rows.get(connectionId)).toMatchObject({
        revision: 4,
        value: { payload: { deletionState: 'pendingStopReconciliation' } },
      });

      materializationId = `plugin-testkit-${PROVIDER_TRANSPORT_REPORT_TEST_MANIFEST.id}`;
      await expect(reporter.invokeAction('report-stop', report)).resolves.toEqual({ kind: 'deleteFinalizing' });
      expect(collection.rows.get(connectionId)).toMatchObject({
        revision: 5,
        value: {
          payload: {
            authorityEpoch: 5,
            deletionState: 'finalizingDelete',
            pendingOldTransportStop: null,
          },
        },
      });
    } finally {
      await reporter.dispose();
      await core.dispose();
    }
  });

  it('authenticates a transfer stop report against the frozen old origin after replacement commits', async () => {
    const connectionId = 'connection-transfer-reported-old-stop';
    const oldMaterializationId = 'transfer-old-materialization';
    const newMaterializationId = 'transfer-new-materialization';
    const collection = createMutableChannelStateCollection();
    const old = socketConnectionForProvider({
      connectionId,
      providerPluginId: PROVIDER_TRANSPORT_REPORT_TEST_MANIFEST.id,
      materializationId: oldMaterializationId,
    });
    const stopRequest = {
      v: 1 as const,
      connectionId,
      providerConnectionKey: old.payload.providerConnectionKey,
      providerConfigVersion: old.payload.providerConfigVersion,
      providerConfig: old.payload.providerConfig,
      credentialRef: old.payload.credentialRef,
      authorityEpoch: 5,
      reason: 'transfer' as const,
    };
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 5,
      value: {
        ...old,
        payload: {
          ...old.payload,
          transportOrigin: {
            ...old.payload.transportOrigin,
            materializationRef: {
              ...old.payload.transportOrigin.materializationRef,
              materializationId: newMaterializationId,
            },
          },
          providerConfig: { applicationId: 'application-after-transfer' },
          authorityEpoch: 5,
          pendingOldTransportStop: {
            predecessorCheckpointedPollInvocation: {
              connectionRevision: 4,
              authorityEpoch: 4,
              transportOrigin: old.payload.transportOrigin,
            },
            transportOrigin: old.payload.transportOrigin,
            providerContributionSelection: old.payload.providerContributionSelection,
            overlapSafety: old.payload.overlapSafety,
            stopRequest,
            acceptedPossibleLoss: false,
          },
        },
      },
    });
    const storage = {
      account: { collection: () => collection },
    } as unknown as PluginServices['storage'];
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage },
    });
    const reporter = await createPluginTestkit({
      manifest: PROVIDER_TRANSPORT_REPORT_TEST_MANIFEST,
      actionTargets: [core],
      resolveCurrentPluginMaterializationRef() {
        return {
          pluginId: PROVIDER_TRANSPORT_REPORT_TEST_MANIFEST.id,
          machineId: 'plugin-testkit-machine',
          materializationId: oldMaterializationId,
        };
      },
      module: {
        activate(api) {
          api.actions.register('report-stop', async (input, context) => await context.services.actions.execute(
            {
              pluginId: PLUGIN_MANIFEST.id,
              localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport,
            },
            input,
          ));
        },
      },
    });

    try {
      await expect(reporter.invokeAction('report-stop', {
        connectionId,
        authorityEpoch: 5,
        fact: { kind: 'stopConfirmed', reason: 'notRunningOnReconcile' },
      })).resolves.toEqual({ kind: 'recorded' });
      expect(collection.rows.get(connectionId)).toMatchObject({
        revision: 6,
        value: {
          payload: {
            transportOrigin: {
              materializationRef: { materializationId: newMaterializationId },
            },
            providerConfig: { applicationId: 'application-after-transfer' },
            authorityEpoch: 5,
            pendingOldTransportStop: null,
          },
        },
      });
    } finally {
      await reporter.dispose();
      await core.dispose();
    }
  });
  it('sets connection enablement through the lifecycle owner without reopening freshness policy', async () => {
    const connectionId = 'connection-set-enabled-1';
    const updatedBatches: Array<readonly MutableChannelStateMutation[]> = [];
    const collection = createMutableChannelStateCollection({
      onUpdatedBatch(operations) {
        updatedBatches.push(operations);
      },
    });
    const initial = reconciliationConnection(connectionId);
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: {
        ...initial,
        payload: {
          ...initial.payload,
          historyGap: { reportedAt: 1_700_000_000_000, reason: 'providerHistoryUnavailable' },
          maximumObservationAgeMs: 120_000,
        },
      },
    });
    const storage = {
      account: { collection: () => collection },
    } as unknown as PluginServices['storage'];
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage },
    });

    try {
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionSetEnabled, {
        connectionId,
        expectedRevision: 4,
        enabled: false,
      })).resolves.toEqual({
        kind: 'updated',
        connectionId,
        revision: 5,
        authorityEpoch: 5,
      });
      expect(updatedBatches).toEqual([[
        {
          kind: 'put',
          expectedRevision: 4,
          value: expect.objectContaining({
            id: connectionId,
            'record-kind': 'connection',
            'connection-id': connectionId,
            payload: expect.objectContaining({
              authorityEpoch: 5,
              enabled: false,
              historyGap: null,
              maximumObservationAgeMs: 120_000,
            }),
          }),
        },
      ]]);
      expect(collection.rows.get(connectionId)).toMatchObject({
        revision: 5,
        value: {
          payload: {
            authorityEpoch: 5,
            enabled: false,
            historyGap: null,
            maximumObservationAgeMs: 120_000,
          },
        },
      });
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionSetEnabled, {
        connectionId,
        expectedRevision: 5,
        enabled: false,
      })).resolves.toEqual({
        kind: 'unchanged',
        connectionId,
        revision: 5,
        authorityEpoch: 5,
      });
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionSetEnabled, {
        connectionId,
        expectedRevision: 4,
        enabled: true,
      })).rejects.toMatchObject({
        code: 'channels_connection_set_enabled_conflict',
        retryable: true,
      });
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionSetEnabled, {
        connectionId,
        expectedRevision: 5,
        enabled: true,
        maximumObservationAgeMs: 60_000,
      })).rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
    } finally {
      await core.dispose();
    }
  });

  it('rejects online connection policy writes while transfer stop custody retains the authority epoch', async () => {
    const connectionId = 'connection-policy-transfer-stop-pending';
    const old = reconciliationConnection(connectionId);
    const pending = {
      ...old,
      payload: {
        ...old.payload,
        authorityEpoch: 5,
        pendingOldTransportStop: {
          predecessorCheckpointedPollInvocation: {
            connectionRevision: 4,
            authorityEpoch: 4,
            transportOrigin: old.payload.transportOrigin,
          },
          transportOrigin: old.payload.transportOrigin,
          providerContributionSelection: old.payload.providerContributionSelection,
          overlapSafety: old.payload.overlapSafety,
          stopRequest: {
            v: 1,
            connectionId,
            providerConnectionKey: old.payload.providerConnectionKey,
            providerConfigVersion: old.payload.providerConfigVersion,
            providerConfig: old.payload.providerConfig,
            credentialRef: old.payload.credentialRef,
            authorityEpoch: 5,
            reason: 'transfer',
          },
          acceptedPossibleLoss: false,
        },
      },
    };
    const collection = createMutableChannelStateCollection();
    collection.rows.set(connectionId, { rowId: connectionId, revision: 5, value: pending });
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage: storageWithEmptyChannelDeliveries(collection) },
    });

    try {
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionSetEnabled, {
        connectionId,
        expectedRevision: 5,
        enabled: false,
      })).rejects.toMatchObject({
        code: 'channels_connection_set_enabled_old_transport_stop_pending',
      });
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate, {
        connectionId,
        expectedRevision: 5,
        enabled: true,
        maximumObservationAgeMs: 120_000,
      })).resolves.toEqual({
        kind: 'updated',
        connectionId,
        revision: 6,
        authorityEpoch: 5,
      });
      expect(collection.rows.get(connectionId)).toMatchObject({
        rowId: connectionId,
        revision: 6,
        value: {
          payload: {
            authorityEpoch: 5,
            enabled: true,
            maximumObservationAgeMs: 120_000,
            pendingOldTransportStop: pending.payload.pendingOldTransportStop,
          },
        },
      });
    } finally {
      await core.dispose();
    }
  });

  it('sets binding enablement through its guarded binding CAS and immediately changes provider demand', async () => {
    const connectionId = 'connection-binding-set-enabled-1';
    const bindingId = 'binding-set-enabled-1';
    const updatedBatches: Array<readonly MutableChannelStateMutation[]> = [];
    let supersedeConnectionDuringBindingBatch = false;
    const collection = createMutableChannelStateCollection({
      onUpdatedBatch(operations) {
        updatedBatches.push(operations);
      },
      onBeforeBatch(operations, rows) {
        if (!supersedeConnectionDuringBindingBatch || !operations.some((operation) => (
          operation.kind === 'put' && operation.value.id === bindingId
        ))) return;
        supersedeConnectionDuringBindingBatch = false;
        const current = rows.get(connectionId);
        if (current === undefined) throw new Error('Expected the owning connection row.');
        rows.set(connectionId, { ...current, revision: current.revision + 1 });
      },
    });
    const connection = reconciliationConnection(connectionId);
    const binding = {
      id: bindingId,
      'record-kind': 'binding',
      v: 1,
      'connection-id': connectionId,
      'binding-id': bindingId,
      'created-at': 1,
      'updated-at': 1,
      payload: {
        endpoint: { kind: 'shared', audience: 'shared', id: 'shared-1' },
        target: {
          kind: 'session',
          sessionId: 'session-1',
          policy: {
            deliveryMode: 'repliesOnly',
            permissionCeiling: 'yolo',
            approvals: { kind: 'off' },
            newSession: { kind: 'off' },
          },
        },
        allowedPrincipalIds: ['principal-ada'],
        allowBotSenders: false,
        inputMode: 'allAllowedMessages',
        inboundDebounceMs: 0,
        linkPreviewPolicy: 'suppress',
        senderFeedback: 'off',
        authorityEpoch: 6,
        enabled: true,
        deletionState: 'none',
      },
    };
    collection.rows.set(connectionId, { rowId: connectionId, revision: 4, value: connection });
    collection.rows.set(bindingId, { rowId: bindingId, revision: 6, value: binding });
    const storage = {
      account: { collection: () => collection },
    } as unknown as PluginServices['storage'];
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage },
    });
    const reconciler = await createPluginTestkit({
      manifest: PROVIDER_RECONCILIATION_TEST_MANIFEST,
      actionTargets: [core],
      module: {
        activate(api) {
          api.actions.register('reconcile', async (_input, context) => await context.services.actions.execute(
            { pluginId: PLUGIN_MANIFEST.id, localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList },
            {},
          ));
        },
      },
    });

    try {
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled, {
        bindingId,
        expectedRevision: 6,
        enabled: false,
      })).resolves.toEqual({
        kind: 'updated',
        bindingId,
        revision: 7,
        authorityEpoch: 7,
      });
      expect(updatedBatches).toEqual([[
        {
          kind: 'assert',
          rowId: connectionId,
          expectedRevision: 4,
        },
        {
          kind: 'put',
          expectedRevision: 6,
          value: expect.objectContaining({
            id: bindingId,
            'record-kind': 'binding',
            'connection-id': connectionId,
            'binding-id': bindingId,
            payload: expect.objectContaining({
              authorityEpoch: 7,
              enabled: false,
              inputMode: 'allAllowedMessages',
            }),
          }),
        },
      ]]);
      await expect(reconciler.invokeAction('reconcile', {})).resolves.toEqual({
        [connectionId]: expect.objectContaining({
          authorityEpoch: 4,
          enabled: true,
          requiresFullSharedMessageContent: false,
        }),
      });
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled, {
        bindingId,
        expectedRevision: 7,
        enabled: false,
      })).resolves.toEqual({
        kind: 'unchanged',
        bindingId,
        revision: 7,
        authorityEpoch: 7,
      });
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled, {
        bindingId,
        expectedRevision: 6,
        enabled: true,
      })).rejects.toMatchObject({
        code: 'channels_binding_set_enabled_conflict',
        retryable: true,
      });
      supersedeConnectionDuringBindingBatch = true;
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled, {
        bindingId,
        expectedRevision: 7,
        enabled: true,
      })).rejects.toMatchObject({
        code: 'channels_binding_set_enabled_conflict',
        retryable: true,
      });
      expect(collection.rows.get(bindingId)?.revision).toBe(7);
      expect(collection.rows.get(connectionId)?.revision).toBe(5);
      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled, {
        bindingId,
        expectedRevision: 7,
        enabled: true,
        connectionId,
      })).rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
    } finally {
      await reconciler.dispose();
      await core.dispose();
    }
  });

  it('invalidates and rereads the binding Resource after its exact-revision enablement Action', async () => {
    const connectionId = 'connection-binding-resource-roundtrip-1';
    const bindingId = 'binding-resource-roundtrip-1';
    const collection = createMutableChannelStateCollection();
    const connection = reconciliationConnection(connectionId);
    const binding = {
      id: bindingId,
      'record-kind': 'binding',
      v: 1,
      'connection-id': connectionId,
      'binding-id': bindingId,
      'created-at': 1,
      'updated-at': 1,
      payload: {
        endpoint: {
          kind: 'shared',
          audience: 'shared',
          id: 'support-room',
          label: 'Support room',
        },
        target: {
          kind: 'session',
          sessionId: 'session-support',
          policy: {
            deliveryMode: 'mirrorSession',
            permissionCeiling: 'yolo',
            approvals: { kind: 'off' },
            newSession: { kind: 'off' },
          },
        },
        allowedPrincipalIds: ['principal-ada'],
        allowBotSenders: false,
        inputMode: 'addressedMessages',
        inboundDebounceMs: 0,
        linkPreviewPolicy: 'suppress',
        senderFeedback: 'off',
        authorityEpoch: 6,
        enabled: true,
        deletionState: 'none',
      },
    };
    collection.rows.set(connectionId, { rowId: connectionId, revision: 4, value: connection });
    collection.rows.set(bindingId, { rowId: bindingId, revision: 6, value: binding });
    const storage = storageWithEmptyChannelDeliveries(collection);
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage },
    });

    try {
      const resource = core.registration('resources', 'bindings-v1');
      if (resource === undefined) throw new Error('Expected the bindings-v1 dynamic Resource registration.');
      const accountStorage = storage.account as PluginAccountStorageScope;
      const invalidation = vi.fn();
      const observation = resource.observe(invalidation, {
        signal: new AbortController().signal,
        context: { kind: 'global' },
        accountStorage,
      });
      await expect(resource.read({
        signal: new AbortController().signal,
        context: { kind: 'global' },
        accountStorage,
      })).resolves.toBe(JSON.stringify({
        bindings: [{
          bindingId,
          revision: 6,
          connectionId,
          endpoint: { audience: 'shared', label: 'Support room' },
          target: { kind: 'session', summary: 'session-support' },
          inputMode: 'addressedMessages',
          deliveryMode: 'mirrorSession',
          approval: { kind: 'off' },
          enabled: true,
          deletionState: 'none',
        }],
      }));

      await expect(core.invokeAction(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled, {
        bindingId,
        expectedRevision: 6,
        enabled: false,
      })).resolves.toEqual({
        kind: 'updated',
        bindingId,
        revision: 7,
        authorityEpoch: 7,
      });
      expect(invalidation).toHaveBeenCalledOnce();
      await expect(resource.read({
        signal: new AbortController().signal,
        context: { kind: 'global' },
        accountStorage,
      })).resolves.toBe(JSON.stringify({
        bindings: [{
          bindingId,
          revision: 7,
          connectionId,
          endpoint: { audience: 'shared', label: 'Support room' },
          target: { kind: 'session', summary: 'session-support' },
          inputMode: 'addressedMessages',
          deliveryMode: 'mirrorSession',
          approval: { kind: 'off' },
          enabled: false,
          deletionState: 'none',
        }],
      }));
      observation.dispose();
    } finally {
      await core.dispose();
    }
  });

  it('projects management-safe connection facts without credential or integration-principal identities', async () => {
    const collection = createMutableChannelStateCollection();
    const labeled = {
      ...reconciliationConnection('connection-principal-labeled'),
      payload: {
        ...reconciliationConnection('connection-principal-labeled').payload,
        providerConfig: { label: 'provider-label-must-not-be-projected' },
        credentialRef: {
          service: {
            pluginId: PROVIDER_RECONCILIATION_TEST_MANIFEST.id,
            localId: 'credential-ref-labeled-must-not-be-projected',
          },
          accountId: 'account-id-labeled-must-not-be-projected',
        },
        integrationPrincipal: {
          id: 'principal-id-labeled-must-not-be-projected',
          label: 'Visible integration label',
        },
        maximumObservationAgeMs: 120_000,
      },
    };
    const unlabeled = {
      ...reconciliationConnection('connection-principal-unlabeled'),
      payload: {
        ...reconciliationConnection('connection-principal-unlabeled').payload,
        providerConfig: { label: 'provider-label-must-not-be-projected' },
        integrationPrincipal: { id: 'principal-id-unlabeled-must-not-be-projected' },
      },
    };
    collection.rows.set(labeled.id, { rowId: labeled.id, revision: 1, value: labeled });
    collection.rows.set(unlabeled.id, { rowId: unlabeled.id, revision: 2, value: unlabeled });
    const storage = storageWithEmptyChannelDeliveries(collection);
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage },
    });

    try {
      const resource = core.registration('resources', 'connections-v1');
      if (resource === undefined) throw new Error('Expected the connections-v1 dynamic Resource registration.');
      const serialized = resourceText(await resource.read({
        signal: new AbortController().signal,
        context: { kind: 'global' },
        accountStorage: storage.account as PluginAccountStorageScope,
      }));
      expect(JSON.parse(serialized)).toEqual({
        connections: [
          {
            connectionId: labeled.id,
            revision: 1,
            providerPluginId: PROVIDER_RECONCILIATION_TEST_MANIFEST.id,
            selectedMachineId: 'plugin-testkit-machine',
            selectedTransport: 'socket',
            integrationPrincipalLabel: 'Visible integration label',
            authorityEpoch: 4,
            enabled: true,
            deletionState: 'none',
            maximumObservationAgeMs: 120_000,
            attention: {
              historyGap: null,
              providerReadiness: null,
              pollFailure: null,
              ingressConflict: null,
              bestEffortBeforeDurableAdmission: false,
              oldTransportStopUnconfirmed: false,
              acceptedPossibleLoss: false,
              outwardDelivery: NO_OUTWARD_DELIVERY_ATTENTION,
            },
          },
          {
            connectionId: unlabeled.id,
            revision: 2,
            providerPluginId: PROVIDER_RECONCILIATION_TEST_MANIFEST.id,
            selectedMachineId: 'plugin-testkit-machine',
            selectedTransport: 'socket',
            authorityEpoch: 4,
            enabled: true,
            deletionState: 'none',
            maximumObservationAgeMs: 60_000,
            attention: {
              historyGap: null,
              providerReadiness: null,
              pollFailure: null,
              ingressConflict: null,
              bestEffortBeforeDurableAdmission: false,
              oldTransportStopUnconfirmed: false,
              acceptedPossibleLoss: false,
              outwardDelivery: NO_OUTWARD_DELIVERY_ATTENTION,
            },
          },
        ],
      });
      expect(serialized).not.toContain('principal-id-labeled-must-not-be-projected');
      expect(serialized).not.toContain('principal-id-unlabeled-must-not-be-projected');
      expect(serialized).not.toContain('provider-label-must-not-be-projected');
      expect(serialized).not.toContain('credential-ref-labeled-must-not-be-projected');
      expect(serialized).not.toContain('account-id-labeled-must-not-be-projected');
    } finally {
      await core.dispose();
    }
  });

  it('keeps a schema-valid 32-row JSON-serialized projection at every canonical maximum within the declared connections Resource byte bound', async () => {
    const collection = createMutableChannelStateCollection();
    const maximumEscapedString = String.fromCharCode(0).repeat(256);
    const maximumMachineId = maximumEscapedString;
    const maximumPluginId = `a.${'p'.repeat(254)}`;
    const maximumContributionLocalId = 'l'.repeat(256);
    const hiddenCredentialAccountId = 'credential-account-resource-bound-must-not-be-projected';
    const hiddenPrincipalId = 'principal-id-resource-bound-must-not-be-projected';
    const hiddenProviderConnectionKey = 'provider-connection-key-resource-bound-must-not-be-projected';
    const hiddenProviderConfigMarker = 'provider-config-resource-bound-must-not-be-projected';
    const connections = Array.from({ length: MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT }, (_unused, index) => {
      const connectionId = Array.from({ length: 96 }, (_unusedBit, bit) => (
        bit < 5 && (index & (1 << bit)) !== 0 ? String.fromCharCode(92) : '"'
      )).join('');
      const connection = reconciliationConnection(connectionId);
      return {
        ...connection,
        payload: {
          ...connection.payload,
          providerPluginId: maximumPluginId,
          credentialRef: {
            service: {
              pluginId: maximumPluginId,
              localId: maximumContributionLocalId,
            },
            accountId: hiddenCredentialAccountId,
          },
          transportOrigin: {
            serverIdentityId: 'srv_account_one',
            materializationRef: {
              machineId: maximumMachineId,
              materializationId: 'materialization-resource-bound',
              pluginId: maximumPluginId,
            },
          },
          transport: { kind: 'checkpointedPull' as const },
          replayContinuity: 'checkpointed' as const,
          providerConnectionKey: hiddenProviderConnectionKey,
          providerConfig: { hiddenProviderConfigMarker },
          integrationPrincipal: {
            id: hiddenPrincipalId,
            label: maximumEscapedString,
          },
          enabled: false,
          deletionState: 'none' as const,
          historyGap: {
            reportedAt: Number.MAX_SAFE_INTEGER,
            reason: 'providerHistoryUnavailable' as const,
          },
          maximumObservationAgeMs: 30 * 86_400_000,
        },
      };
    });
    const validateChannelStateRow = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    expect(connections.every((connection) => (
      isValidPluginJsonSchemaValue(validateChannelStateRow, connection)
    ))).toBe(true);
    expect(connections.every((connection) => (
      ConversationConnectionIdV1Schema.safeParse(connection.id).success
    ))).toBe(true);
    expect(PluginMachineExecutionOriginV1Schema.safeParse(
      connections[0]!.payload.transportOrigin,
    ).success).toBe(true);
    expect(QualifiedConnectedAccountRefSchema.safeParse(
      connections[0]!.payload.credentialRef,
    ).success).toBe(true);
    const connectionsInResourceOrder = [...connections].sort(
      (left, right) => left.id.localeCompare(right.id),
    );
    for (const connection of connections) {
      collection.rows.set(connection.id, {
        rowId: connection.id,
        revision: Number.MAX_SAFE_INTEGER,
        value: connection,
      });
    }
    const storage = storageWithEmptyChannelDeliveries(collection);
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage },
    });

    try {
      const resource = core.registration('resources', 'connections-v1');
      if (resource === undefined) throw new Error('Expected the connections-v1 dynamic Resource registration.');
      const serialized = resourceText(await resource.read({
        signal: new AbortController().signal,
        context: { kind: 'global' },
        accountStorage: storage.account as PluginAccountStorageScope,
      }));
      expect(JSON.parse(serialized)).toEqual({
        connections: connectionsInResourceOrder.map((connection) => ({
          connectionId: connection.id,
          revision: Number.MAX_SAFE_INTEGER,
          providerPluginId: maximumPluginId,
          selectedMachineId: maximumMachineId,
          selectedTransport: 'checkpointedPull',
          integrationPrincipalLabel: maximumEscapedString,
          authorityEpoch: 4,
          enabled: false,
          deletionState: 'none',
          maximumObservationAgeMs: 30 * 86_400_000,
          attention: {
            historyGap: {
              reportedAt: Number.MAX_SAFE_INTEGER,
              reason: 'providerHistoryUnavailable',
            },
            providerReadiness: null,
            pollFailure: null,
            ingressConflict: null,
            bestEffortBeforeDurableAdmission: false,
            oldTransportStopUnconfirmed: false,
            acceptedPossibleLoss: false,
            outwardDelivery: NO_OUTWARD_DELIVERY_ATTENTION,
          },
        })),
      });
      expect(serialized).not.toContain(hiddenPrincipalId);
      expect(serialized).not.toContain(hiddenCredentialAccountId);
      expect(serialized).not.toContain(hiddenProviderConnectionKey);
      expect(serialized).not.toContain(hiddenProviderConfigMarker);
      const serializedBytes = new TextEncoder().encode(serialized).byteLength;
      expect(serializedBytes).toBeLessThanOrEqual(declaredResourceMaxBytes('connections-v1'));
    } finally {
      await core.dispose();
    }
  });


  it('reads caller-eligible current rows through the registered reconciliation Actions', async () => {
    const discordAuthority = {
      providerPluginId: 'happier.channel.discord',
      providerContributionSelection: {
        contributionId: 'discord-reconciliation-provider',
        immutableGenerationId: 'discord-reconciliation-generation',
      },
      providerSetupInput: { source: 'reconciliation' },
      credentialRef: {
        service: { pluginId: 'happier.channel.discord', localId: 'account' },
        accountId: 'account-1',
      },
      transportOrigin: {
        serverIdentityId: 'server-account-one',
        materializationRef: {
          machineId: 'machine-1',
          materializationId: 'discord-install-1',
          pluginId: 'happier.channel.discord',
        },
      },
      providerConnectionKey: 'discord:connection-1',
      providerConfig: { applicationId: 'application-1' },
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'discord-bot-1', label: 'Happier' },
      authorityEpoch: 4,
    } as const satisfies ConversationConnectionFixtureAuthority;
    const exactConnection = createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority: discordAuthority,
      transport: { kind: 'socket' },
      overlapSafety: 'safe',
      replayContinuity: 'none',
    });
    const samePluginDifferentMaterialization = {
      ...exactConnection,
      id: 'connection-2',
      'connection-id': 'connection-2',
      payload: {
        ...exactConnection.payload,
        providerConnectionKey: 'discord:connection-2',
        transportOrigin: {
          ...exactConnection.payload.transportOrigin,
          materializationRef: {
            ...exactConnection.payload.transportOrigin.materializationRef,
            materializationId: 'discord-install-2',
          },
        },
      },
    };
    const sharedBinding = {
      id: 'binding-1',
      'record-kind': 'binding',
      v: 1,
      'connection-id': exactConnection['connection-id'],
      'binding-id': 'binding-1',
      'created-at': 1,
      'updated-at': 1,
      payload: {
        endpoint: { kind: 'shared', audience: 'shared', id: 'shared-channel-1' },
        target: {
          kind: 'session',
          sessionId: 'session-1',
          policy: {
            deliveryMode: 'repliesOnly',
            permissionCeiling: 'default',
            approvals: { kind: 'off' },
            newSession: { kind: 'off' },
          },
        },
        allowedPrincipalIds: ['principal-1'],
        allowBotSenders: false,
        inputMode: 'allAllowedMessages',
        inboundDebounceMs: 0,
        linkPreviewPolicy: 'suppress',
        senderFeedback: 'off',
        authorityEpoch: 1,
        enabled: true,
        deletionState: 'none',
      },
    };
    const stateRows = [exactConnection, samePluginDifferentMaterialization, sharedBinding];
    const querySignals: AbortSignal[] = [];
    let connectionQueryCount = 0;
    let bindingQueryCount = 0;
    let forceSnapshotDrift = false;
    const collection = {
      async query(
        request: Readonly<{ prefix?: readonly unknown[]; limit?: number }>,
        options?: Readonly<{ signal?: AbortSignal }>,
      ) {
        assertChannelsTestCollectionQueryLimit(request.limit);
        if (options?.signal !== undefined) querySignals.push(options.signal);
        const kind = request.prefix?.[0];
        if (kind === 'connection') connectionQueryCount += 1;
        if (kind === 'binding') bindingQueryCount += 1;
        const firstConnectionRead = kind === 'connection' && connectionQueryCount === 1;
        return {
          rows: stateRows
            .filter((row) => row['record-kind'] === kind)
            .map((row) => firstConnectionRead && row.id === exactConnection.id
              ? { ...row, payload: { ...row.payload, enabled: false } }
              : row)
            .map((value, index) => ({ rowId: value.id, revision: index + 1, value })),
          changeCursor: forceSnapshotDrift
            ? (kind === 'connection' ? connectionQueryCount * 2 : bindingQueryCount * 2 + 1)
            : (firstConnectionRead ? 1 : 2),
        };
      },
    };
    // Storage is the genuine host boundary; the handler only reaches this
    // collection reader, so no internal Channels logic is substituted here.
    const storage = {
      account: { collection: () => collection },
    } as unknown as PluginServices['storage'];
    const context: PluginInvocationContext = {
      plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
      contribution: {
        id: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
        qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList}`,
      },
      surface: 'plugin',
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channel.discord',
        contribution: {
          id: 'channel-background',
          qualifiedId: 'happier.channel.discord/background/channel-background',
        },
        materialization: exactConnection.payload.transportOrigin.materializationRef,
      },
      signal: new AbortController().signal,
      services: { storage } as unknown as PluginServices,
    };
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const list = activation.registration(
        'actions',
        CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
      );
      const read = activation.registration(
        'actions',
        CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead,
      );

      expect(list).toBeDefined();
      expect(read).toBeDefined();
      if (list === undefined || read === undefined) return;

      const expected = {
        [exactConnection.id]: {
          v: 1,
          connectionId: exactConnection.id,
          providerConnectionKey: exactConnection.payload.providerConnectionKey,
          providerConfigVersion: 1,
          providerConfig: exactConnection.payload.providerConfig,
          credentialRef: exactConnection.payload.credentialRef,
          authorityEpoch: 4,
          enabled: true,
          deletionState: 'none',
          requiresFullSharedMessageContent: true,
        },
      };
      expect(await list({}, context)).toEqual(expected);
      expect(await read({ connectionId: exactConnection.id }, context)).toEqual(expected);
      expect(await read({ connectionId: samePluginDifferentMaterialization.id }, context)).toEqual({});
      expect(connectionQueryCount).toBe(4);
      expect(bindingQueryCount).toBe(4);
      expect(querySignals).toHaveLength(8);
      expect(querySignals.every((signal) => signal === context.signal)).toBe(true);

      forceSnapshotDrift = true;
      await expect(list({}, context)).rejects.toMatchObject({
        code: 'channels_reconciliation_snapshot_changed',
        retryable: true,
      });
      expect(connectionQueryCount).toBe(7);
      expect(bindingQueryCount).toBe(7);
    } finally {
      await activation.dispose();
    }
  });

  it('fails rather than following a cursor past the total eligible connection budget', async () => {
    const connections = Array.from(
      { length: 32 },
      (_value, index) => reconciliationConnection(`connection-${index}`),
    );
    const requests: ReconciliationQueryRequest[] = [];
    const { core, provider } = await createProviderReconciliationAction(async (request) => {
      requests.push(request);
      if (request.prefix?.[0] === 'connection') {
        if (request.cursor === undefined) {
          return {
            rows: collectionRows(connections),
            nextCursor: 'connection-overflow',
            changeCursor: 1,
          };
        }
        return {
          rows: collectionRows([reconciliationConnection('connection-32')]),
          changeCursor: 1,
        };
      }
      return { rows: [], changeCursor: 1 };
    });

    try {
      await expect(provider.invokeAction('reconcile', {})).rejects.toMatchObject({
        code: 'plugin_action_execution_failed',
      });
      expect(requests
        .filter((request) => request.prefix?.[0] === 'connection')
        .map(({ cursor, limit }) => ({ cursor, limit })))
        .toEqual([{ cursor: undefined, limit: 32 }]);
    } finally {
      await provider.dispose();
      await core.dispose();
    }
  });

  it('uses the total remaining binding budget across a cursor chain', async () => {
    const connection = reconciliationConnection('connection-1');
    const bindings = Array.from(
      { length: 256 },
      (_value, index) => reconciliationBinding({
        bindingId: `binding-${index}`,
        connectionId: connection.id,
        requiresFullSharedMessageContent: index === 255,
      }),
    );
    const requests: ReconciliationQueryRequest[] = [];
    const { core, provider } = await createProviderReconciliationAction(async (request) => {
      requests.push(request);
      if (request.prefix?.[0] === 'connection') {
        return { rows: collectionRows([connection]), changeCursor: 1 };
      }
      if (request.cursor === undefined) {
        return {
          rows: collectionRows(bindings.slice(0, 200)),
          nextCursor: 'bindings-after-200',
          changeCursor: 1,
        };
      }
      if (request.cursor === 'bindings-after-200') {
        return { rows: collectionRows(bindings.slice(200)), changeCursor: 1 };
      }
      return { rows: [], changeCursor: 1 };
    });

    try {
      await expect(provider.invokeAction('reconcile', {})).resolves.toMatchObject({
        [connection.id]: { requiresFullSharedMessageContent: true },
      });
      expect(requests
        .filter((request) => request.prefix?.[0] === 'binding')
        .map(({ cursor, limit }) => ({ cursor, limit })))
        .toEqual([
          { cursor: undefined, limit: 200 },
          { cursor: 'bindings-after-200', limit: 56 },
        ]);
    } finally {
      await provider.dispose();
      await core.dispose();
    }
  });

  it('fails rather than following a cursor past the total eligible binding budget', async () => {
    const connection = reconciliationConnection('connection-1');
    const bindings = Array.from(
      { length: 257 },
      (_value, index) => reconciliationBinding({
        bindingId: `binding-${index}`,
        connectionId: connection.id,
      }),
    );
    const requests: ReconciliationQueryRequest[] = [];
    const { core, provider } = await createProviderReconciliationAction(async (request) => {
      requests.push(request);
      if (request.prefix?.[0] === 'connection') {
        return { rows: collectionRows([connection]), changeCursor: 1 };
      }
      if (request.cursor === undefined) {
        return {
          rows: collectionRows(bindings.slice(0, 200)),
          nextCursor: 'bindings-after-200',
          changeCursor: 1,
        };
      }
      if (request.cursor === 'bindings-after-200') {
        return {
          rows: collectionRows(bindings.slice(200, 256)),
          nextCursor: 'binding-overflow',
          changeCursor: 1,
        };
      }
      return { rows: collectionRows(bindings.slice(256)), changeCursor: 1 };
    });

    try {
      await expect(provider.invokeAction('reconcile', {})).rejects.toMatchObject({
        code: 'plugin_action_execution_failed',
      });
      expect(requests
        .filter((request) => request.prefix?.[0] === 'binding')
        .map(({ cursor, limit }) => ({ cursor, limit })))
        .toEqual([
          { cursor: undefined, limit: 200 },
          { cursor: 'bindings-after-200', limit: 56 },
        ]);
    } finally {
      await provider.dispose();
      await core.dispose();
    }
  });

  it('composes provider Action calls with host-stamped current materialization', async () => {
    const providerActionAuthority = {
      providerPluginId: PROVIDER_RECONCILIATION_TEST_MANIFEST.id,
      providerContributionSelection: {
        contributionId: 'discord-test-provider',
        immutableGenerationId: 'discord-test-generation',
      },
      providerSetupInput: { source: 'reconciliation' },
      credentialRef: null,
      transportOrigin: {
        serverIdentityId: 'server-account-one',
        materializationRef: {
          machineId: 'plugin-testkit-machine',
          materializationId: `plugin-testkit-${PROVIDER_RECONCILIATION_TEST_MANIFEST.id}`,
          pluginId: PROVIDER_RECONCILIATION_TEST_MANIFEST.id,
        },
      },
      providerConnectionKey: 'discord:connection-1',
      providerConfig: { applicationId: 'application-1' },
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'discord-bot-1', label: 'Happier' },
      authorityEpoch: 4,
    } as const satisfies ConversationConnectionFixtureAuthority;
    const connection = createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority: providerActionAuthority,
      transport: { kind: 'socket' },
      overlapSafety: 'safe',
      replayContinuity: 'none',
    });
    const collection = {
      async query(request: Readonly<{ prefix?: readonly unknown[]; limit?: number }>) {
        assertChannelsTestCollectionQueryLimit(request.limit);
        return {
          rows: request.prefix?.[0] === 'connection'
            ? [{ rowId: connection.id, revision: 1, value: connection }]
            : [],
          changeCursor: 1,
        };
      },
    };
    // Storage remains the genuine host boundary; the provider Action reaches
    // the core only through the public testkit Action dispatcher.
    const storage = {
      account: { collection: () => collection },
    } as unknown as PluginServices['storage'];
    const core = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
      services: { storage },
    });
    const provider = await createPluginTestkit({
      manifest: PROVIDER_RECONCILIATION_TEST_MANIFEST,
      actionTargets: [core],
      module: {
        activate(api) {
          api.actions.register('reconcile', async (_input, context): Promise<JsonValue> => {
            const [list, read] = await Promise.all([
              context.services.actions.execute(
                {
                  pluginId: PLUGIN_MANIFEST.id,
                  localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
                },
                {},
              ),
              context.services.actions.execute(
                {
                  pluginId: PLUGIN_MANIFEST.id,
                  localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead,
                },
                { connectionId: connection.id },
              ),
            ]);
            return {
              list: requiredActionResult(list, 'connectionsList'),
              read: requiredActionResult(read, 'connectionRead'),
            };
          });
        },
      },
    });

    try {
      const expected = {
        [connection.id]: {
          v: 1,
          connectionId: connection.id,
          providerConnectionKey: connection.payload.providerConnectionKey,
          providerConfigVersion: 1,
          providerConfig: connection.payload.providerConfig,
          credentialRef: null,
          authorityEpoch: 4,
          enabled: true,
          deletionState: 'none',
          requiresFullSharedMessageContent: false,
        },
      };
      // `invokeAction` has no caller option: the public synthetic host stamps
      // the provider's current materialization before dispatching to core.
      expect(await provider.invokeAction('reconcile', {})).toEqual({ list: expected, read: expected });
    } finally {
      await provider.dispose();
      await core.dispose();
    }
  });
});

import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { CONNECTIONS_RESOURCE_RUNTIME } from './connectionsResource.js';
import { resourceText } from './testkit/resourceContract.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { parseConnection } from './ui/conversationRows.js';
import {
  createConversationOutwardDeliveryCollectionStore,
  type ConversationOutwardDeliveryObligation,
} from './outwardDelivery.js';
import {
  createCurrentConversationConnectionFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';

import { assertChannelsTestCollectionQueryLimit } from './testkit/collectionQueryBound.js';
class MemoryAccountCollection {
  readonly rows = new Map<string, Readonly<{
    rowId: string;
    revision: number;
    value: Record<string, unknown>;
  }>>();

  async get(rowId: string) {
    return this.rows.get(rowId) ?? null;
  }

  async put(value: Record<string, unknown>, input: Readonly<{
    expectedRevision: number | 'absent';
  }>) {
    const rowId = value.id;
    if (typeof rowId !== 'string') throw new Error('row id is required');
    const current = this.rows.get(rowId);
    if ((input.expectedRevision === 'absent' && current !== undefined)
      || (typeof input.expectedRevision === 'number'
        && (current === undefined || current.revision !== input.expectedRevision))) {
      throw new Error('conflict');
    }
    const row = { rowId, revision: (current?.revision ?? 0) + 1, value };
    this.rows.set(rowId, row);
    return row;
  }

  async query(request: Readonly<{
    index: string;
    prefix?: readonly unknown[];
    cursor?: string;
    limit?: number;
  }>) {
    assertChannelsTestCollectionQueryLimit(request.limit);
    const prefix = request.prefix ?? [];
    const matching = [...this.rows.values()]
      .filter((row) => {
        if (request.index === 'by-kind') return row.value['record-kind'] === prefix[0];
        if (request.index === 'by-owner-attention') return row.value['connection-id'] === prefix[0];
        if (request.index === CHANNEL_STATE_INDEX_ID.byConnectionBindingV2) {
          return row.value['connection-id'] === prefix[0]
            && (row.value['binding-id'] ?? null) === prefix[1]
            && row.value['record-kind'] === prefix[2]
            && row.value.attention === prefix[3];
        }
        return true;
      })
      .sort((left, right) => left.rowId.localeCompare(right.rowId));
    const start = request.cursor === undefined
      ? 0
      : matching.findIndex((row) => row.rowId === request.cursor) + 1;
    const limit = request.limit ?? matching.length;
    const rows = matching.slice(Math.max(0, start), Math.max(0, start) + limit);
    const next = matching[Math.max(0, start) + limit];
    return {
      rows,
      ...(next === undefined ? {} : { nextCursor: rows.at(-1)?.rowId }),
      changeCursor: 1,
    };
  }
}

function outwardDeliveryObligation(controlId: string): ConversationOutwardDeliveryObligation {
  return {
    connectionId: 'connection-1',
    routeAuthority: { connectionAuthorityEpoch: 1 },
    source: { kind: 'controlResponse', controlId, controlKind: 'refusal' },
    endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
    content: { text: 'A delivery result needs attention.' },
    deliveryKey: `delivery:${controlId}`,

    linkPreviewPolicy: 'suppress',
  };
}

function ingressConflictCensus(): Record<string, unknown> {
  return {
    id: 'ingress-census-conflict',
    'record-kind': CHANNEL_STATE_RECORD_KIND.ingressCensus,
    v: 1,
    'connection-id': 'connection-1',
    attention: true,
    'created-at': 100,
    'updated-at': 101,
    payload: {
      conflict: { kind: 'occurrenceEvidenceMismatch' },
      normalizedIngress: { privateBody: 'must-not-project' },
    },
  };
}

function createWatchableCollection() {
  let listener: (() => void) | undefined;
  const dispose = vi.fn(() => { listener = undefined; });
  return {
    watch: vi.fn((_request: unknown, next: () => void) => {
      listener = next;
      return { dispose };
    }),
    emit() {
      listener?.();
    },
    dispose,
  };
}

describe('Channels connections Resource invalidation', () => {
  it.each(['channel-state', 'channel-deliveries'] as const)(
    'projects the typed %s update requirement instead of an empty connections list', async collectionId => {
      const state = new MemoryAccountCollection();
      const deliveries = new MemoryAccountCollection();
      await state.put(createCurrentConversationConnectionFixture({ connectionId: 'connection-1', authority: {
        providerPluginId: 'example.channel.provider', providerContributionSelection: { contributionId: 'test-provider' },
        providerSetupInput: {}, credentialRef: null,
        transportOrigin: { serverIdentityId: 'srv_test', machineId: 'machine-1' },
        providerConnectionKey: 'provider-connection-1', providerConfig: {}, routingIdentityKey: 'a'.repeat(43),
        integrationPrincipal: { id: 'principal-1' }, authorityEpoch: 1,
      } }), { expectedRevision: 'absent' });
      const refused = collectionId === 'channel-state' ? state : deliveries;
      vi.spyOn(refused, 'query').mockRejectedValue(new PluginError({
        code: 'collection_update_required', retryable: false, message: 'private transport detail',
      }));
      const unavailableHost = () => { throw new Error('This Resource reads Account storage only.'); };
      const snapshot = JSON.parse(resourceText(await CONNECTIONS_RESOURCE_RUNTIME.read(createTestResourceInvocationContext({
        context: { kind: 'global' }, signal: new AbortController().signal,
        resources: { describe: unavailableHost, read: unavailableHost, watch: unavailableHost },
        readAction: unavailableHost, observeAction: unavailableHost,
        // The in-memory Collection is the persistent-storage boundary.
        accountStorage: { collection: (definition: { id: string }) => definition.id === 'channel-state' ? state : deliveries } as unknown as PluginAccountStorageScope,
      }))));
      expect(snapshot).toEqual({ status: {
        kind: 'updateRequired', code: 'collection_update_required', collectionId,
        retryable: false, recovery: 'updateHappierOnThisMachine',
      } });
    },
  );

  it('uses the shared Resource storage guard with the connections error identity', async () => {
    await expect(CONNECTIONS_RESOURCE_RUNTIME.read(createTestResourceInvocationContext({
      accountStorage: undefined,
      signal: new AbortController().signal,
    }))).rejects.toMatchObject({
      code: 'channels_connections_resource_account_storage_unavailable',
      message: 'The Channels connections Resource requires admitted Account storage.',
    });
  });

  it('projects retained delivery retry, partial, and unknown custody from the canonical rows without persisting connection health', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    const connectionAuthority = {
      providerPluginId: 'example.channel.provider',
      providerContributionSelection: {
        contributionId: 'connections-resource-provider',
      },
      providerSetupInput: { source: 'connections-resource' },
      credentialRef: null,
      transportOrigin: {
        serverIdentityId: 'srv_connections_resource',
        materializationRef: {
          pluginId: 'example.channel.provider',
          machineId: 'machine-1',
          materializationId: 'materialization-1',
        },
      },
      providerConnectionKey: 'provider-connection-1',
      providerConfig: { account: 'account-1' },
      routingIdentityKey: 'a'.repeat(43),
      integrationPrincipal: { id: 'provider-principal-1' },
      authorityEpoch: 7,
    } as const satisfies ConversationConnectionFixtureAuthority;
    const connection = createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority: connectionAuthority,
      transport: { kind: 'checkpointedPull' },
      replayContinuity: 'checkpointed',
      overlapSafety: 'safe',
      pollFailure: {
        phase: 'blocked',
        attemptCount: 2,
        retryNotBeforeMs: null,
        evidence: { kind: 'provider', reason: 'credentialInvalid', diagnostic: 'private provider detail' },
      },
    });
    await state.put(connection, { expectedRevision: 'absent' });
    await state.put(ingressConflictCensus(), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 100,
    });
    const retry = await store.ensure(outwardDeliveryObligation('retry'));
    const partial = await store.ensure(outwardDeliveryObligation('partial'));
    const unknown = await store.ensure(outwardDeliveryObligation('unknown'));
    if (retry.kind !== 'created' || partial.kind !== 'created' || unknown.kind !== 'created') {
      throw new Error('Expected the canonical custody rows to be created.');
    }
    await store.compareAndSwap({
      custodyId: retry.record.custodyId,
      expectedRevision: retry.record.revision,
      custody: {
        state: 'retryDue',
        attemptCount: 1,
        providerMessageIds: [],
        retryNotBefore: 200,
      },
    });
    await store.compareAndSwap({
      custodyId: partial.record.custodyId,
      expectedRevision: partial.record.revision,
      custody: {
        state: 'partial',
        attemptCount: 1,
        providerMessageIds: ['message-1'],
        failedChunk: 1,
      },
    });
    await store.compareAndSwap({
      custodyId: unknown.record.custodyId,
      expectedRevision: unknown.record.revision,
      custody: {
        state: 'outcomeUnknown',
        attemptCount: 1,
        providerMessageIds: [],
      },
    });

    const accountStorage = {
      collection(definition: Readonly<{ id: string }>) {
        return definition.id === CHANNEL_STATE_COLLECTION.id ? state : deliveries;
      },
    } as unknown as PluginAccountStorageScope;
    const serialized = await CONNECTIONS_RESOURCE_RUNTIME.read(createTestResourceInvocationContext({
      signal,
      context: { kind: 'global' },
      accountStorage,
    }));

    expect(JSON.parse(resourceText(serialized))).toEqual({
      connections: [expect.objectContaining({
        connectionId: 'connection-1',
        authorityEpoch: 7,
        attention: expect.objectContaining({
          pollFailure: {
            phase: 'blocked',
            attemptCount: 2,
            retryNotBeforeMs: null,
            evidence: { kind: 'provider', reason: 'credentialInvalid' },
          },
          ingressConflict: null,
          outwardDelivery: {
            retryDue: false,
            notDelivered: false,
            partial: true,
            outcomeUnknown: true,
            archiveRecovery: false,
          },
        }),
      })],
    });
    expect(serialized).not.toContain('must-not-project');

    // Real retained rows -> paged reader -> Resource -> UI reader, above the
    // former aggregate budget and thirty-day freshness ceiling.
    const validates = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    for (let index = 0; index < 512; index += 1) {
      const connectionId = `long-lived-connection-${index}`;
      const value = { ...connection, id: connectionId, 'connection-id': connectionId,
        payload: { ...connection.payload,
          } };
      expect(isValidPluginJsonSchemaValue(validates, value)).toBe(true);
      await state.put(value, { expectedRevision: 'absent' });
    }
    const largeProjection = resourceText(await CONNECTIONS_RESOURCE_RUNTIME.read(createTestResourceInvocationContext({
      signal, context: { kind: 'global' }, accountStorage,
    })));
    expect(new TextEncoder().encode(largeProjection).byteLength).toBeGreaterThan(196_608);
    const parsed: unknown = JSON.parse(largeProjection);
    if (parsed === null || typeof parsed !== 'object' || !('connections' in parsed) || !Array.isArray(parsed.connections)) {
      throw new Error('Expected a connection Resource projection.');
    }
    expect(parsed.connections).toHaveLength(513);
    expect(parsed.connections.map(parseConnection).every(value => value !== undefined)).toBe(true);
    for (const id of ['connections-v1', 'pairing-v1']) {
      const declared = PLUGIN_MANIFEST.contributes?.resources?.find(resource => resource.id === id);
      expect(declared).toBeDefined();
      expect(declared?.maxBytes).toBeUndefined();
    }
  });

  it('invalidates its current snapshot when retained outward custody settles without introducing an event broker', async () => {
    const state = createWatchableCollection();
    const deliveries = createWatchableCollection();
    const accountStorage = {
      collection(definition: Readonly<{ id: string }>) {
        return definition.id === CHANNEL_STATE_COLLECTION.id ? state : deliveries;
      },
    } as unknown as PluginAccountStorageScope;
    const invalidate = vi.fn();

    const observation = await CONNECTIONS_RESOURCE_RUNTIME.observe(invalidate, createTestResourceInvocationContext({
      signal: new AbortController().signal,
      context: { kind: 'global' },
      accountStorage,
    }));
    state.emit();
    deliveries.emit();
    expect(invalidate).toHaveBeenCalledTimes(2);

    await observation.dispose();
    state.emit();
    deliveries.emit();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(state.dispose).toHaveBeenCalledOnce();
    expect(deliveries.dispose).toHaveBeenCalledOnce();
    expect(deliveries.watch).toHaveBeenCalledWith({ kind: 'collection' }, expect.any(Function));
    expect(state.watch).toHaveBeenCalledWith({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.connection],
      order: 'asc',
    }, expect.any(Function));
  });
});

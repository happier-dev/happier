import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import {
  createConversationOutwardDeliveryCollectionStore,
  type ConversationOutwardDeliveryObligation,
} from './outwardDelivery.js';
import {
  createCurrentConversationConnectionFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';
import { TRANSCRIPT_ACTIVITIES_RESOURCE_RUNTIME } from './transcriptActivitiesResource.js';
import { resourceText } from './testkit/resourceContract.js';

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
    index?: string;
    prefix?: readonly string[];
    cursor?: string;
    limit?: number;
  }>) {
    assertChannelsTestCollectionQueryLimit(request.limit);
    const matching = [...this.rows.values()]
      .filter((row) => {
        if (request.index === 'by-kind') {
          return row.value['record-kind'] === request.prefix?.[0];
        }
        if (request.index === 'by-owner-attention') {
          return row.value['connection-id'] === request.prefix?.[0]
            && row.value['binding-id'] === request.prefix?.[1];
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

function sessionBindingRecord(bindingId: string, sessionId: string): Record<string, unknown> {
  return {
    id: bindingId,
    'record-kind': 'binding',
    v: 1,
    'connection-id': 'connection-1',
    'binding-id': bindingId,
    'created-at': 1,
    'updated-at': 1,
    payload: {
      endpoint: { kind: 'shared', audience: 'shared', id: 'endpoint-private' },
      target: {
        kind: 'session',
        sessionId,
        policy: {
          deliveryMode: 'mirrorSession',
          permissionCeiling: 'yolo',
          approvals: { kind: 'enabled', maximumScope: 'session', principalIds: ['principal-private'] },
          newSession: { kind: 'enabled', principalIds: ['principal-private'], recipe: { secret: 'recipe-private' } },
        },
      },
      allowedPrincipalIds: ['principal-private'],
      allowBotSenders: true,
      inputMode: 'addressedMessages',
      inboundDebounceMs: 4_000,
      linkPreviewPolicy: 'providerDefault',
      senderFeedback: 'eligibleRefusals',
      authorityEpoch: 7,
      enabled: true,
      deletionState: 'none',
    },
  };
}

function bindingDeliveryObligation(bindingId: string, controlId: string): ConversationOutwardDeliveryObligation {
  return {
    connectionId: 'connection-1',
    bindingId,
    routeAuthority: {
      connectionAuthorityEpoch: 4,
      bindingRevision: 1,
      bindingAuthorityEpoch: 7,
    },
    source: { kind: 'controlResponse', controlId, controlKind: 'recovery' },
    endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
    content: `Private delivery body for ${controlId}.`,
    deliveryKey: `delivery:${controlId}`,
    mentionPolicy: 'suppress',
    linkPreviewPolicy: 'suppress',
  };
}

function accountStorageFor(
  state: unknown,
  deliveries: unknown,
): PluginAccountStorageScope {
  return {
    collection(definition: Readonly<{ id: string }>) {
      return definition.id === CHANNEL_STATE_COLLECTION.id ? state : deliveries;
    },
  } as unknown as PluginAccountStorageScope;
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

describe('Channels transcript Activities Resource', () => {
  it('projects only the host Session binding\'s retained custody through the declared generic Resource', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    const authority = {
      providerPluginId: 'example.channel.provider',
      providerContributionSelection: {
        contributionId: 'transcript-test-provider',
        immutableGenerationId: 'transcript-test-generation',
      },
      providerSetupInput: { source: 'transcript-resource-test' },
      credentialRef: null,
      transportOrigin: {
        serverIdentityId: 'server-1',
        materializationRef: {
          pluginId: 'example.channel.provider',
          machineId: 'machine-1',
          materializationId: 'materialization-1',
        },
      },
      providerConnectionKey: 'provider-connection-1',
      providerConfig: { account: 'private' },
      routingIdentityKey: 'a'.repeat(43),
      integrationPrincipal: { id: 'transcript-resource-principal' },
      authorityEpoch: 4,
    } as const satisfies ConversationConnectionFixtureAuthority;
    await state.put(createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority,
      transport: { kind: 'checkpointedPull' },
      overlapSafety: 'safe',
      replayContinuity: 'checkpointed',
      outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
    }), { expectedRevision: 'absent' });
    const bindingA = sessionBindingRecord('binding-a', 'session-a');
    const bindingB = sessionBindingRecord('binding-b', 'session-b');
    await state.put(bindingA, { expectedRevision: 'absent' });
    await state.put(bindingB, { expectedRevision: 'absent' });

    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 100,
    });
    const forSessionA = await store.ensure(bindingDeliveryObligation('binding-a', 'session-a'));
    const forSessionB = await store.ensure(bindingDeliveryObligation('binding-b', 'session-b'));
    if (forSessionA.kind !== 'created' || forSessionB.kind !== 'created') {
      throw new Error('Expected canonical custody rows.');
    }
    const retry = await store.compareAndSwap({
      custodyId: forSessionA.record.custodyId,
      expectedRevision: forSessionA.record.revision,
      custody: { state: 'retryDue', attemptCount: 1, providerMessageIds: [], retryNotBefore: 200 },
    });
    const partial = await store.compareAndSwap({
      custodyId: forSessionB.record.custodyId,
      expectedRevision: forSessionB.record.revision,
      custody: { state: 'partial', attemptCount: 1, providerMessageIds: ['provider-private'], failedChunk: 1 },
    });
    if (retry.kind !== 'updated' || partial.kind !== 'updated') {
      throw new Error('Expected canonical custody state updates.');
    }

    const serialized = await TRANSCRIPT_ACTIVITIES_RESOURCE_RUNTIME.read({
      signal,
      context: { kind: 'session', sessionId: 'session-a' },
      accountStorage: accountStorageFor(state, deliveries),
    });

    expect(JSON.parse(resourceText(serialized))).toEqual({
      version: 1,
      activities: [{
        localActivityId: expect.stringMatching(/^delivery-[a-f0-9]{64}$/u),
        title: 'External delivery',
        phase: 'running',
        status: 'Delivery will retry',
        checklist: [],
        dismissible: false,
        actions: [],
      }],
    });
    expect(serialized).not.toContain('Private delivery body');
    expect(serialized).not.toContain('provider-private');
    expect(serialized).not.toContain('principal-private');
    expect(serialized).not.toContain('session-b');
  });

  it('requires a host-stamped Session context and invalidates only through existing Collections', () => {
    const state = createWatchableCollection();
    const deliveries = createWatchableCollection();
    const accountStorage = accountStorageFor(state, deliveries);
    const invalidate = vi.fn();

    expect(() => TRANSCRIPT_ACTIVITIES_RESOURCE_RUNTIME.observe(invalidate, {
      signal: new AbortController().signal,
      context: { kind: 'global' },
      accountStorage,
    })).toThrow(expect.objectContaining({
      code: 'channels_transcript_activities_resource_session_context_required',
    }));

    const observation = TRANSCRIPT_ACTIVITIES_RESOURCE_RUNTIME.observe(invalidate, {
      signal: new AbortController().signal,
      context: { kind: 'session', sessionId: 'session-a' },
      accountStorage,
    });
    state.emit();
    deliveries.emit();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(state.watch).toHaveBeenCalledWith({
      index: 'by-kind',
      prefix: [CHANNEL_STATE_RECORD_KIND.binding],
      order: 'asc',
    }, expect.any(Function));
    expect(deliveries.watch).toHaveBeenCalledWith({ kind: 'collection' }, expect.any(Function));

    observation.dispose();
    state.emit();
    deliveries.emit();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(state.dispose).toHaveBeenCalledOnce();
    expect(deliveries.dispose).toHaveBeenCalledOnce();
  });
});

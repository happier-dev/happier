import type {
  ConversationDeliveryResultV1,
  ConversationResolvedEndpointV1,
} from '@happier-dev/channels-protocol/v1';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/plugin-sdk/host/registration';
import type {
  TargetedContributionPointRef,
  TargetedContributionSnapshot,
  TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/plugin-sdk/actions';
import { MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1 } from '@happier-dev/plugin-sdk/resources';
import { describe, expect, it, vi } from 'vitest';

import { CHANNEL_DELIVERIES_COLLECTION } from './collections.js';
import {
  acceptConversationOutwardDeliveryReady,
  createConversationOutwardDeliveryCollectionAuthority,
  createConversationOutwardDeliveryCollectionScanner,
  createConversationOutwardDeliveryCollectionStore,
  deliverConversationSessionProjectionOutwardDelivery,
  deliverConversationOutwardDelivery,
  readConversationOutwardDeliveryConnectionAttention,
  readConversationOutwardDeliveryResolutionPage,
  redriveConversationOutwardDeliveryThroughProviderAction,
  reconcileConversationOutwardDeliveryAttempt,
  reconcileConversationOutwardDeliveryAttemptThroughProviderAction,
  readConversationOutwardDeliveryTranscriptActivities,
  prepareConversationOutwardDeliveryReady,
  resolveConversationOutwardDeliveryCustodyInAccountCollection,
  type ConversationOutwardDeliveryObligation,
  type ConversationOutwardDeliveryRecord,
  type ConversationOutwardDeliveryStore,
} from './outwardDelivery.js';
import {
  createCurrentConversationConnectionFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';

import { assertChannelsTestCollectionQueryLimit } from './testkit/collectionQueryBound.js';
const endpoint: ConversationResolvedEndpointV1 = {
  kind: 'direct',
  audience: 'direct',
  id: 'chat-1',
};

/** A syntactically valid opaque custody id whose retained row is unparsable. */
const corruptCustodyId = Buffer.alloc(32, 7).toString('base64url');

const providerTransportOrigin = {
  serverIdentityId: 'srv_account_one',
  materializationRef: {
    pluginId: 'example.channel.provider',
    machineId: 'machine-1',
    materializationId: 'provider-1',
  },
} as const;

function admittedProviderOperation(role: string) {
  return Object.freeze({
    identity: Object.freeze({
      target: Object.freeze({ pluginId: 'happier.channels' }),
      point: Object.freeze({
        pointId: 'providers',
        protocol: Object.freeze({ id: 'happier.channels/providers', version: 1 }),
      }),
      contributor: Object.freeze({
        pluginId: providerTransportOrigin.materializationRef.pluginId,
        contributionId: 'delivery-test-provider',
        immutableGenerationId: 'delivery-test-generation',
      }),
      role,
    }),
  });
}

const providerDeliveryAction = admittedProviderOperation('messageDeliver');
const providerDeliveryReconcileAction = admittedProviderOperation('deliveryReconcile');

/** The generic host has already admitted this provider contribution. */
function targetedProviderDeliveryContributions(): TargetedContributionsService {
  return Object.freeze({
    observeForSelf<TContribution>(
      _point: TargetedContributionPointRef<TContribution>,
      _options: Readonly<{ onInvalidated: () => void }>,
    ) {
      return Object.freeze({
        dispose() {},
        async readCurrent(): Promise<TargetedContributionSnapshot<TContribution>> {
          return {
            generation: 'channels-test-generation',
            contributions: [{
              contributor: {
                pluginId: providerTransportOrigin.materializationRef.pluginId,
                contributionId: 'delivery-test-provider',
                immutableGenerationId: 'delivery-test-generation',
              },
              protocol: { id: 'happier.channels/providers', version: 1 },
              operations: {
                messageDeliver: providerDeliveryAction,
                deliveryReconcile: providerDeliveryReconcileAction,
              },
            }] as unknown as readonly TContribution[],
          };
        },
      });
    },
  });
}

const sessionTarget = {
  kind: 'session',
  sessionId: 'session-1',
  policy: {
    deliveryMode: 'mirrorSession',
    permissionCeiling: 'read-only',
    approvals: { kind: 'off' },
    newSession: { kind: 'off' },
  },
} as const;

function providerConnectionRow() {
  const authority = {
    providerPluginId: providerTransportOrigin.materializationRef.pluginId,
    providerContributionSelection: {
      contributionId: 'delivery-test-provider',
      immutableGenerationId: 'delivery-test-generation',
    },
    providerSetupInput: { source: 'test' },
    credentialRef: null,
    transportOrigin: providerTransportOrigin,
    providerConnectionKey: 'provider-connection-1',
    providerConfig: { account: 'account-1' },
    routingIdentityKey: 'a'.repeat(43),
    integrationPrincipal: { id: 'provider:principal-1' },
    authorityEpoch: 4,
  } as const satisfies ConversationConnectionFixtureAuthority;
  return createCurrentConversationConnectionFixture({
    connectionId: 'connection-1',
    authority,
    transport: { kind: 'checkpointedPull' },
    overlapSafety: 'safe',
    replayContinuity: 'checkpointed',
    outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
  });
}

function sessionProjectionRecord(): ConversationOutwardDeliveryRecord {
  return {
    custodyId: 'session-projection-custody-1',
    revision: 1,
    createdAt: 0,
    obligation: {
      connectionId: 'connection-1',
      bindingId: 'binding-1',
      routeAuthority: {
        connectionAuthorityEpoch: 4,
        bindingRevision: 1,
        bindingAuthorityEpoch: 7,
      },
      source: {
        kind: 'sessionProjection',
        sessionId: 'session-1',
        semanticItemId: 'semantic-1',
      },
      endpoint,
      content: 'The final answer is ready.',
      deliveryKey: 'channels:delivery:v1:session-projection-custody-1',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    },
    custody: { state: 'ready', attemptCount: 0, providerMessageIds: [] },
  };
}

class MemoryDeliveryStore implements ConversationOutwardDeliveryStore {
  readonly events: string[] = [];
  readonly rows = new Map<string, ConversationOutwardDeliveryRecord>();
  lastEncodedRowBytes: number | undefined;

  async ensure(obligation: ConversationOutwardDeliveryObligation) {
    this.events.push('ensure');
    const custodyId = JSON.stringify([
      obligation.connectionId,
      obligation.bindingId ?? null,
      obligation.source,
    ]);
    const existing = this.rows.get(custodyId);
    if (existing) {
      return existing.obligation.deliveryKey === obligation.deliveryKey
        ? { kind: 'rejoined' as const, record: existing }
        : { kind: 'conflict' as const };
    }
    const record: ConversationOutwardDeliveryRecord = {
      custodyId,
      revision: 1,
      createdAt: 0,
      obligation,
      custody: { state: 'ready', attemptCount: 0, providerMessageIds: [] },
    };
    const encodedRowBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    this.lastEncodedRowBytes = encodedRowBytes;
    const maxRowEncodedBytes = CHANNEL_DELIVERIES_COLLECTION.quota?.maxRowEncodedBytes;
    if (maxRowEncodedBytes !== undefined && encodedRowBytes > maxRowEncodedBytes) {
      return { kind: 'invalid' as const, reason: 'rowTooLarge' as const };
    }
    this.rows.set(custodyId, record);
    return { kind: 'created' as const, record };
  }

  async compareAndSwap(input: Readonly<{
    custodyId: string;
    expectedRevision: number;
    custody: ConversationOutwardDeliveryRecord['custody'];
  }>) {
    this.events.push(`cas:${input.custody.state}`);
    const current = this.rows.get(input.custodyId);
    if (!current || current.revision !== input.expectedRevision) return { kind: 'conflict' as const };
    const record = { ...current, revision: current.revision + 1, custody: input.custody };
    const encodedRowBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    this.lastEncodedRowBytes = encodedRowBytes;
    const maxRowEncodedBytes = CHANNEL_DELIVERIES_COLLECTION.quota?.maxRowEncodedBytes;
    if (maxRowEncodedBytes !== undefined && encodedRowBytes > maxRowEncodedBytes) {
      return { kind: 'invalid' as const, reason: 'rowTooLarge' as const };
    }
    this.rows.set(input.custodyId, record);
    return { kind: 'updated' as const, record };
  }

  async retire(input: Readonly<{ custodyId: string; expectedRevision: number }>) {
    const current = this.rows.get(input.custodyId);
    if (current === undefined || current.revision !== input.expectedRevision) {
      return { kind: 'conflict' as const };
    }
    this.rows.delete(input.custodyId);
    return { kind: 'retired' as const };
  }
}

class MemoryAccountCollection {
  readonly rows = new Map<string, Readonly<{
    rowId: string;
    revision: number;
    value: Record<string, JsonValue>;
    deleted?: boolean;
  }>>();

  async get(rowId: string) {
    const row = this.rows.get(rowId);
    return row?.deleted === true ? null : row ?? null;
  }

  async put(value: Record<string, JsonValue>, input: Readonly<{
    expectedRevision: number | 'absent';
  }>) {
    const rowId = value.id;
    if (typeof rowId !== 'string') throw new Error('row id is required');
    const current = this.rows.get(rowId);
    if ((input.expectedRevision === 'absent' && current !== undefined)
      || (typeof input.expectedRevision === 'number'
        && (current === undefined
          || current.deleted === true
          || current.revision !== input.expectedRevision))) {
      throw Object.assign(new Error('conflict'), { code: 'plugin_collection_conflict' });
    }
    // Most custody tests predate the strict shared binding decoder and focus
    // on delivery state rather than reconstructing every persisted binding
    // field. Complete those positive binding fixtures at this storage seam so
    // they exercise the same canonical row shape as production without
    // duplicating a subtly different binding constructor in every test.
    const payload = value.payload;
    const storedValue = value['record-kind'] === 'binding'
      && typeof payload === 'object'
      && payload !== null
      && !Array.isArray(payload)
      ? {
        ...value,
        v: value.v ?? 1,
        'created-at': value['created-at'] ?? 0,
        'updated-at': value['updated-at'] ?? 0,
        payload: {
          allowedPrincipalIds: ['provider:principal-1'],
          allowBotSenders: false,
          inputMode: 'allAllowedMessages',
          inboundDebounceMs: 0,
          senderFeedback: 'off',
          ...payload,
        },
      }
      : value;
    const row = { rowId, revision: (current?.revision ?? 0) + 1, value: storedValue, deleted: false };
    this.rows.set(rowId, row);
    return row;
  }

  async delete(rowId: string, input: Readonly<{ expectedRevision: number }>) {
    const current = this.rows.get(rowId);
    if (current === undefined
      || current.deleted === true
      || current.revision !== input.expectedRevision) {
      throw Object.assign(new Error('conflict'), { code: 'plugin_collection_conflict' });
    }
    const row = { ...current, revision: current.revision + 1, deleted: true as const };
    this.rows.set(rowId, row);
    return { rowId, revision: row.revision, deleted: true as const };
  }

  async query(_request?: Readonly<{
    index?: string;
    prefix?: readonly (string | number | boolean | null)[];
    cursor?: string;
    limit?: number;
  }>) {
    assertChannelsTestCollectionQueryLimit(_request?.limit);
    return {
      rows: [...this.rows.values()].filter((row) => row.deleted !== true),
      changeCursor: 1,
    };
  }
}

class BindingIndexedAccountCollection extends MemoryAccountCollection {
  override async query(request?: Readonly<{
    index?: string;
    prefix?: readonly (string | number | boolean | null)[];
    cursor?: string;
    limit?: number;
  }>) {
    assertChannelsTestCollectionQueryLimit(request?.limit);
    const matching = [...this.rows.values()]
      .filter((row) => {
        if (request?.index !== 'by-owner-attention') return true;
        return row.value['connection-id'] === request.prefix?.[0]
          && row.value['binding-id'] === request.prefix?.[1];
      })
      .sort((left, right) => left.rowId.localeCompare(right.rowId));
    const start = request?.cursor === undefined
      ? 0
      : matching.findIndex((row) => row.rowId === request.cursor) + 1;
    const limit = request?.limit ?? matching.length;
    const rows = matching.slice(Math.max(start, 0), Math.max(start, 0) + limit);
    const next = matching[Math.max(start, 0) + limit];
    return {
      rows,
      ...(next === undefined ? {} : { nextCursor: rows.at(-1)?.rowId }),
      changeCursor: 1,
    };
  }
}

function obligation(): ConversationOutwardDeliveryObligation {
  return {
    connectionId: 'connection-1',
    bindingId: 'binding-1',
    routeAuthority: {
      connectionAuthorityEpoch: 4,
      bindingRevision: 1,
      bindingAuthorityEpoch: 7,
    },
    source: { kind: 'controlResponse', controlId: 'ingress-1', controlKind: 'newSession' },
    endpoint,
    content: 'Another /new command is already in progress.',
    deliveryKey: 'control:ingress-1',
    mentionPolicy: 'suppress',
    linkPreviewPolicy: 'suppress',
  };
}

function currentAuthority() {
  return {
    outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' as const },
    signal: new AbortController().signal,
    authority: {
      checkCurrentness: async () => ({ kind: 'current' as const }),
    },
  };
}

describe('Channels control-response outward custody', () => {
  it('projects only the selected binding\'s persisted delivery lifecycle into safe transcript Activity rows', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new BindingIndexedAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 100,
    });
    const forSessionA = await store.ensure({
      ...obligation(),
      source: { kind: 'controlResponse', controlId: 'session-a', controlKind: 'recovery' },
      content: 'Session A private delivery body.',
      deliveryKey: 'delivery-session-a',
    });
    const baseObligation = obligation();
    if (baseObligation.bindingId === undefined) {
      throw new Error('Expected a binding-routed control-response obligation.');
    }
    const forSessionB = await store.ensure({
      ...baseObligation,
      bindingId: 'binding-2',
      routeAuthority: baseObligation.routeAuthority,
      source: { kind: 'controlResponse', controlId: 'session-b', controlKind: 'recovery' },
      content: 'Session B private delivery body.',
      deliveryKey: 'delivery-session-b',
    });
    if (forSessionA.kind !== 'created' || forSessionB.kind !== 'created') {
      throw new Error('Expected canonical retained custody rows.');
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
      throw new Error('Expected canonical custody lifecycle updates.');
    }

    const snapshot = await readConversationOutwardDeliveryTranscriptActivities({
      deliveriesCollection: deliveries,
      signal,
      bindingTargets: [{ connectionId: 'connection-1', bindingId: 'binding-1' }],
    });

    expect(snapshot).toEqual({
      kind: 'ready',
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
    expect(JSON.stringify(snapshot)).not.toContain('private delivery body');
    expect(JSON.stringify(snapshot)).not.toContain('provider-private');
  });

  it('bounds the transcript Resource at the canonical public activity count', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new BindingIndexedAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 100,
    });

    for (let index = 0; index <= MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1; index += 1) {
      const created = await store.ensure({
        ...obligation(),
        source: {
          kind: 'controlResponse',
          controlId: `transcript-bound-${index}`,
          controlKind: 'recovery',
        },
        deliveryKey: `transcript-bound-${index}`,
      });
      if (created.kind !== 'created') throw new Error('Expected canonical retained custody row.');
    }

    const snapshot = await readConversationOutwardDeliveryTranscriptActivities({
      deliveriesCollection: deliveries,
      signal,
      bindingTargets: [{ connectionId: 'connection-1', bindingId: 'binding-1' }],
    });

    if (snapshot.kind !== 'ready') throw new Error('Expected transcript Activities Resource snapshot.');
    expect(snapshot.activities).toHaveLength(MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1);
  });

  it('keeps every readable delivery when one custody row in the same page cannot be parsed', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new BindingIndexedAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 100,
    });
    const readable = await store.ensure({
      ...obligation(),
      source: { kind: 'controlResponse', controlId: 'readable', controlKind: 'recovery' },
      content: 'Readable delivery body.',
      deliveryKey: 'delivery-readable',
    });
    if (readable.kind !== 'created') throw new Error('Expected canonical retained custody row.');
    // A retained row the canonical parser rejects, returned under the exact
    // binding-qualified owner index the reader queries.
    deliveries.rows.set(corruptCustodyId, {
      rowId: corruptCustodyId,
      revision: 1,
      value: {
        id: corruptCustodyId,
        'connection-id': 'connection-1',
        'binding-id': 'binding-1',
        custody: { state: 'not-a-custody-state' },
      },
    });

    const snapshot = await readConversationOutwardDeliveryTranscriptActivities({
      deliveriesCollection: deliveries,
      signal,
      bindingTargets: [{ connectionId: 'connection-1', bindingId: 'binding-1' }],
    });

    if (snapshot.kind !== 'ready') throw new Error('Expected a degraded but ready snapshot.');
    expect(snapshot.activities.map((activity) => activity.status).sort()).toEqual([
      'Delivery details could not be read',
      'Waiting to deliver',
    ]);
  });

  it('degrades one unparsable custody row to unknown attention for its own connection only', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 100,
    });
    const readable = await store.ensure({
      ...obligation(),
      source: { kind: 'controlResponse', controlId: 'attention-readable', controlKind: 'recovery' },
      content: 'Readable delivery body.',
      deliveryKey: 'delivery-attention-readable',
    });
    if (readable.kind !== 'created') throw new Error('Expected canonical retained custody row.');
    const retryDue = await store.compareAndSwap({
      custodyId: readable.record.custodyId,
      expectedRevision: readable.record.revision,
      custody: { state: 'retryDue', attemptCount: 1, providerMessageIds: [], retryNotBefore: 200 },
    });
    if (retryDue.kind !== 'updated') throw new Error('Expected canonical custody lifecycle update.');
    deliveries.rows.set(corruptCustodyId, {
      rowId: corruptCustodyId,
      revision: 1,
      value: {
        id: corruptCustodyId,
        'connection-id': 'connection-1',
        custody: { state: 'not-a-custody-state' },
      },
    });

    const attention = await readConversationOutwardDeliveryConnectionAttention({
      deliveriesCollection: deliveries as never,
      signal,
      connectionIds: ['connection-1'],
    });

    expect(attention).toEqual({
      kind: 'ready',
      attentionByConnection: new Map([['connection-1', {
        retryDue: true,
        notDelivered: false,
        partial: false,
        outcomeUnknown: true,
        archiveRecovery: false,
      }]]),
    });
  });

  it('reads binding-qualified transcript targets in canonical code-unit order', async () => {
    const queriedTargets: string[] = [];
    const signal = new AbortController().signal;

    const snapshot = await readConversationOutwardDeliveryTranscriptActivities({
      deliveriesCollection: {
        async query(request) {
          assertChannelsTestCollectionQueryLimit(request.limit);
          queriedTargets.push(request.prefix?.join('/') ?? '');
          return { rows: [], changeCursor: 1 };
        },
      },
      signal,
      bindingTargets: [
        { connectionId: 'connection-i', bindingId: 'binding-i' },
        { connectionId: 'connection-I', bindingId: 'binding-I' },
      ],
    });

    expect(snapshot).toEqual({ kind: 'ready', activities: [] });
    expect(queriedTargets).toEqual([
      'connection-I/binding-I',
      'connection-i/binding-i',
    ]);
  });

  it('enumerates only due or recovering nonterminal custody through the canonical deliveries collection parser', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 100,
    });
    const ready = await store.ensure({
      ...obligation(),
      source: { kind: 'controlResponse', controlId: 'ready-1', controlKind: 'pairing' },
      deliveryKey: 'delivery-ready-1',
    });
    const retryLater = await store.ensure({
      ...obligation(),
      source: { kind: 'controlResponse', controlId: 'retry-1', controlKind: 'pairing' },
      deliveryKey: 'delivery-retry-1',
    });
    const attempting = await store.ensure({
      ...obligation(),
      source: { kind: 'controlResponse', controlId: 'attempting-1', controlKind: 'pairing' },
      deliveryKey: 'delivery-attempting-1',
    });
    // `ensure` can also answer `retired`, which carries no record; require the
    // ensured shape positively so a fixture that stops producing one fails here.
    if ((ready.kind !== 'created' && ready.kind !== 'rejoined')
      || (retryLater.kind !== 'created' && retryLater.kind !== 'rejoined')
      || (attempting.kind !== 'created' && attempting.kind !== 'rejoined')) {
      throw new Error('expected custody fixtures');
    }
    await store.compareAndSwap({
      custodyId: retryLater.record.custodyId,
      expectedRevision: retryLater.record.revision,
      custody: { state: 'retryDue', attemptCount: 1, providerMessageIds: [], retryNotBefore: 101 },
    });
    await store.compareAndSwap({
      custodyId: attempting.record.custodyId,
      expectedRevision: attempting.record.revision,
      custody: {
        state: 'attempting',
        attemptCount: 1,
        attemptId: 'attempt-1',
        startedAt: 1,
        providerMessageIds: [],
      },
    });
    const scanner = createConversationOutwardDeliveryCollectionScanner({
      deliveriesCollection: deliveries as never,
      signal,
    });

    const scanned = await scanner.scan({ now: 100, limit: 10 });
    if (scanned.kind !== 'ready') throw new Error('expected delivery scan');
    expect(scanned.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        custodyId: ready.record.custodyId,
        custody: expect.objectContaining({ state: 'ready' }),
      }),
      expect.objectContaining({
        custodyId: attempting.record.custodyId,
        custody: expect.objectContaining({ state: 'attempting' }),
      }),
    ]));
    expect(scanned.records).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ custodyId: retryLater.record.custodyId }),
    ]));
  });

  it('CAS-claims a stale attempting delivery before optional provider reconciliation and never sends it again', async () => {
    const store = new MemoryDeliveryStore();
    const record: ConversationOutwardDeliveryRecord = {
      custodyId: 'stale-custody-1',
      revision: 1,
      createdAt: 0,
      obligation: obligation(),
      custody: {
        state: 'attempting',
        attemptCount: 1,
        attemptId: 'delivery-attempt-1',
        startedAt: 100,
        providerMessageIds: [],
      },
    };
    store.rows.set(record.custodyId, record);
    const reconcile = vi.fn(async () => ({
      kind: 'delivered' as const,
      providerMessageIds: ['provider-message-1'],
    }));

    await expect(reconcileConversationOutwardDeliveryAttempt({
      store,
      record,
      recoveryAttemptId: 'reconcile-attempt-1',
      staleAfterMs: 30,
      now: () => 130,
      signal: new AbortController().signal,
      authority: {
        checkCurrentness: async () => ({ kind: 'current' as const }),
      },
      reconcile,
    })).resolves.toEqual({
      kind: 'settled',
      custody: {
        state: 'delivered',
        attemptCount: 1,
        providerMessageIds: ['provider-message-1'],
      },
    });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(store.events).toEqual(['cas:attempting', 'cas:delivered']);
    expect(store.rows.get(record.custodyId)?.custody).toEqual({
      state: 'delivered',
      attemptCount: 1,
      providerMessageIds: ['provider-message-1'],
    });
  });

  it('redrives retained Session projection custody only through the current provider Action origin', async () => {
    const state = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint,
        target: sessionTarget,
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 'absent' });
    const store = new MemoryDeliveryStore();
    const record = sessionProjectionRecord();
    store.rows.set(record.custodyId, record);
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      _operation: unknown,
      _input: Readonly<Record<string, unknown>>,
      _options: Readonly<{ signal?: AbortSignal }>,
    ) => ({
      result: { kind: 'delivered', providerMessageIds: ['provider-message-1'] },
      executionOrigin: providerTransportOrigin,
    }));

    await expect(redriveConversationOutwardDeliveryThroughProviderAction({
      stateCollection: state as never,
      targetedContributions: targetedProviderDeliveryContributions(),
      store,
      record,
      attemptId: 'redrive-attempt-1',
      now: () => 100,
      signal: new AbortController().signal,
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as never,
    })).resolves.toEqual({
      kind: 'settled',
      custody: {
        state: 'delivered',
        attemptCount: 1,
        providerMessageIds: ['provider-message-1'],
      },
    });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledWith(
      providerDeliveryAction,
      expect.objectContaining({
        v: 1,
        connectionId: 'connection-1',
        providerConnectionKey: 'provider-connection-1',
        endpoint,
        deliveryKey: record.obligation.deliveryKey,
      }),
      expect.objectContaining({ expectedExecutionOrigin: providerTransportOrigin }),
    );
  });

  it('settles retained custody before provider I/O when the current provider limit has narrowed', async () => {
    const state = new MemoryAccountCollection();
    const connection = providerConnectionRow();
    await state.put({
      ...connection,
      payload: {
        ...connection.payload,
        outboundTextLimit: { maximum: 2, unit: 'unicodeCodePoints' },
      },
    }, { expectedRevision: 'absent' });
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint,
        target: sessionTarget,
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 'absent' });
    const store = new MemoryDeliveryStore();
    const existing = sessionProjectionRecord();
    const record: ConversationOutwardDeliveryRecord = {
      ...existing,
      obligation: {
        ...existing.obligation,
        content: 'x'.repeat(65),
      },
    };
    store.rows.set(record.custodyId, record);
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();

    await expect(redriveConversationOutwardDeliveryThroughProviderAction({
      stateCollection: state as never,
      targetedContributions: targetedProviderDeliveryContributions(),
      store,
      record,
      attemptId: 'redrive-attempt-narrowed-limit',
      now: () => 100,
      signal: new AbortController().signal,
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as never,
    })).resolves.toEqual({
      kind: 'settled',
      custody: {
        state: 'notDelivered',
        attemptCount: 0,
        providerMessageIds: [],
      },
    });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('constructs new Session projection custody from the canonical binding and its opaque delivery identity', async () => {
    const state = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint,
        target: sessionTarget,
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 'absent' });
    const store = new MemoryDeliveryStore();
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      _operation: unknown,
      _input: Readonly<Record<string, unknown>>,
      _options: Readonly<{ signal?: AbortSignal }>,
    ) => ({
      result: { kind: 'delivered', providerMessageIds: ['provider-message-1'] },
      executionOrigin: providerTransportOrigin,
    }));

    await expect(deliverConversationSessionProjectionOutwardDelivery({
      stateCollection: state as never,
      targetedContributions: targetedProviderDeliveryContributions(),
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as never,
      store,
      binding: {
        bindingId: 'binding-1',
        revision: 1,
        connectionId: 'connection-1',
        target: { sessionId: 'session-1', deliveryMode: 'mirrorSession' },
      },
      source: {
        kind: 'sessionProjection',
        sessionId: 'session-1',
        semanticItemId: 'semantic-2',
      },
      content: 'A new shareable reply.',
      attemptId: 'projection-attempt-1',
      now: () => 100,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: 'settled',
      custody: { state: 'delivered' },
    });

    const delivered = executeAdmittedTargetedOperationWithExecutionOrigin.mock.calls[0]?.[1];
    expect(delivered?.deliveryKey).toMatch(/^channels:delivery:v1:[A-Za-z0-9_-]{43}$/u);
    expect(store.rows.values().next().value?.obligation).toMatchObject({
      source: {
        kind: 'sessionProjection',
        sessionId: 'session-1',
        semanticItemId: 'semantic-2',
      },
      routeAuthority: {
        connectionAuthorityEpoch: 4,
        bindingRevision: 1,
        bindingAuthorityEpoch: 7,
      },
      linkPreviewPolicy: 'suppress',
    });
  });

  it('reconciles a stale Session projection attempt through the optional provider Action without resending it', async () => {
    const state = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint,
        target: sessionTarget,
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 'absent' });
    const store = new MemoryDeliveryStore();
    const record: ConversationOutwardDeliveryRecord = {
      ...sessionProjectionRecord(),
      custody: {
        state: 'attempting',
        attemptCount: 1,
        attemptId: 'lost-attempt-1',
        startedAt: 1,
        providerMessageIds: [],
      },
    };
    store.rows.set(record.custodyId, record);
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      _operation: unknown,
      _input: Readonly<Record<string, unknown>>,
      _options: Readonly<{ signal?: AbortSignal }>,
    ) => ({
      result: { kind: 'notDelivered', retry: 'safe' },
      executionOrigin: providerTransportOrigin,
    }));

    await expect(reconcileConversationOutwardDeliveryAttemptThroughProviderAction({
      stateCollection: state as never,
      targetedContributions: targetedProviderDeliveryContributions(),
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as never,
      store,
      record,
      recoveryAttemptId: 'recovery-attempt-1',
      staleAfterMs: 10,
      now: () => 100,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: 'settled',
      custody: { state: 'retryDue', attemptCount: 1 },
    });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledWith(
      providerDeliveryReconcileAction,
      expect.objectContaining({
        v: 1,
        connectionId: 'connection-1',
        endpoint,
        deliveryKey: record.obligation.deliveryKey,
      }),
      expect.objectContaining({ expectedExecutionOrigin: providerTransportOrigin }),
    );
  });

  it('settles a retained Session projection as unknown when the provider Action origin is not current', async () => {
    const state = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint,
        target: sessionTarget,
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 'absent' });
    const store = new MemoryDeliveryStore();
    const record = sessionProjectionRecord();
    store.rows.set(record.custodyId, record);
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      _operation: unknown,
      _input: Readonly<Record<string, unknown>>,
      _options: Readonly<{ signal?: AbortSignal }>,
    ) => ({
      result: { kind: 'delivered', providerMessageIds: ['provider-message-1'] },
      executionOrigin: {
        ...providerTransportOrigin,
        materializationRef: {
          ...providerTransportOrigin.materializationRef,
          materializationId: 'provider-replaced',
        },
      },
    }));

    await expect(redriveConversationOutwardDeliveryThroughProviderAction({
      stateCollection: state as never,
      targetedContributions: targetedProviderDeliveryContributions(),
      store,
      record,
      attemptId: 'redrive-attempt-origin-mismatch',
      now: () => 100,
      signal: new AbortController().signal,
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as never,
    })).resolves.toMatchObject({
      kind: 'settled',
      custody: { state: 'outcomeUnknown' },
    });
  });

  it('settles a generic host-proven no-handler failure as retry-safe without invoking the provider handler', async () => {
    const state = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint,
        target: sessionTarget,
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 'absent' });
    const store = new MemoryDeliveryStore();
    const record = sessionProjectionRecord();
    store.rows.set(record.custodyId, record);
    const providerHandler = vi.fn(async () => ({
      kind: 'delivered' as const,
      providerMessageIds: ['must-not-exist'],
    }));
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      _action: unknown,
      _input: unknown,
      options: Readonly<{ expectedExecutionOrigin?: PluginMachineExecutionOriginV1 }>,
    ) => {
      const currentExecutionOrigin = {
        ...providerTransportOrigin,
        materializationRef: {
          ...providerTransportOrigin.materializationRef,
          materializationId: 'provider-replaced-before-handler',
        },
      } as const;
      if (options.expectedExecutionOrigin?.materializationRef.materializationId
        !== currentExecutionOrigin.materializationRef.materializationId) {
        throw createPluginActionHandlerNotStartedError({
          code: 'plugin_action_handler_missing',
          message: 'No committed target handler exists',
        });
      }
      return {
        result: await providerHandler(),
        executionOrigin: currentExecutionOrigin,
      };
    });

    await expect(redriveConversationOutwardDeliveryThroughProviderAction({
      stateCollection: state as never,
      targetedContributions: targetedProviderDeliveryContributions(),
      store,
      record,
      attemptId: 'redrive-attempt-pre-handler-mismatch',
      now: () => 100,
      signal: new AbortController().signal,
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as never,
    })).resolves.toMatchObject({
      kind: 'settled',
      custody: { state: 'retryDue', attemptCount: 1, providerMessageIds: [] },
    });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
    expect(providerHandler).not.toHaveBeenCalled();
  });

  it('keeps a post-handler failure outcome-unknown even when its code resembles a pre-handler refusal', async () => {
    const state = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint,
        target: sessionTarget,
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 'absent' });
    const store = new MemoryDeliveryStore();
    const record = sessionProjectionRecord();
    store.rows.set(record.custodyId, record);
    const providerHandler = vi.fn(async () => ({
      kind: 'delivered' as const,
      providerMessageIds: ['provider-message-1'],
    }));
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => {
      await providerHandler();
      throw new PluginError({
        code: 'plugin_action_handler_missing',
        message: 'Transport failed after the provider handler started',
      });
    });

    await expect(redriveConversationOutwardDeliveryThroughProviderAction({
      stateCollection: state as never,
      targetedContributions: targetedProviderDeliveryContributions(),
      store,
      record,
      attemptId: 'redrive-attempt-post-handler-change',
      now: () => 100,
      signal: new AbortController().signal,
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as never,
    })).resolves.toMatchObject({
      kind: 'settled',
      custody: { state: 'outcomeUnknown', attemptCount: 1 },
    });

    expect(providerHandler).toHaveBeenCalledOnce();
  });

  it('suppresses a retained Session projection when its binding no longer targets that Session', async () => {
    const state = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint,
        target: { ...sessionTarget, sessionId: 'session-2' },
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 'absent' });
    const store = new MemoryDeliveryStore();
    const record = sessionProjectionRecord();
    store.rows.set(record.custodyId, record);
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();

    await expect(redriveConversationOutwardDeliveryThroughProviderAction({
      stateCollection: state as never,
      targetedContributions: targetedProviderDeliveryContributions(),
      store,
      record,
      attemptId: 'redrive-attempt-target-change',
      now: () => 100,
      signal: new AbortController().signal,
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as never,
    })).resolves.toMatchObject({
      kind: 'suppressed',
      reason: 'targetChanged',
      custody: { state: 'suppressed' },
    });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('rejects a connection-only obligation without its mandatory route-authority arm before custody', async () => {
    const store = new MemoryDeliveryStore();
    let providerCalls = 0;
    // Fixture boundary: this deliberately violates the public runtime contract.
    const missingConnectionAuthority = {
      connectionId: 'connection-1',
      source: { kind: 'controlResponse', controlId: 'pairing-1', controlKind: 'pairing' },
      endpoint,
      content: 'Your pairing request is ready.',
      deliveryKey: 'pairing:pairing-1',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    } as unknown as ConversationOutwardDeliveryObligation;

    await expect(deliverConversationOutwardDelivery({
      store,
      obligation: missingConnectionAuthority,
      attemptId: 'attempt-missing-connection-authority',
      now: () => 100,
      ...currentAuthority(),
      deliver: async () => {
        providerCalls += 1;
        return { kind: 'delivered', providerMessageIds: ['must-not-exist'] };
      },
    })).resolves.toEqual({ kind: 'notAttempted', reason: 'invalidObligation' });

    expect(store.events).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  it('rejects the retired nested Automation target route before custody', async () => {
    const store = new MemoryDeliveryStore();
    let providerCalls = 0;
    // Fixture boundary: this deliberately models the retired nested target shape.
    const nestedAutomationTarget = {
      connectionId: 'connection-1',
      bindingId: 'binding-1',
      routeAuthority: {
        connectionAuthorityEpoch: 4,
        bindingRevision: 1,
        bindingAuthorityEpoch: 7,
        automationTarget: {
          automationId: 'automation-1',
          resultDelivery: 'finalResult',
        },
      },
      source: {
        kind: 'automationResult',
        automationRunId: 'run-1',
        resultId: 'result-1',
        automationId: 'automation-1',
        resultDelivery: 'finalResult',
      },
      endpoint,
      content: 'The Automation completed.',
      deliveryKey: 'automation:result-1',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    } as unknown as ConversationOutwardDeliveryObligation;

    await expect(deliverConversationOutwardDelivery({
      store,
      obligation: nestedAutomationTarget,
      attemptId: 'attempt-retired-automation-target',
      now: () => 100,
      ...currentAuthority(),
      deliver: async () => {
        providerCalls += 1;
        return { kind: 'delivered', providerMessageIds: ['must-not-exist'] };
      },
    })).resolves.toEqual({ kind: 'notAttempted', reason: 'invalidObligation' });

    expect(store.events).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  it('uses the one Account Collection adapter to hide a closed source tuple behind a durable opaque custody row', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    // Fixture boundary: the adapter consumes only the SDK Collection methods.
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: new AbortController().signal,
      now: () => 100,
    });
    const projected: ConversationOutwardDeliveryObligation = {
      ...obligation(),
      deliveryKey: 'channels:delivery:v1:session-1:semantic-1',
      source: {
        kind: 'sessionProjection',
        sessionId: 'session-1',
        semanticItemId: 'semantic-1',
      },
    };

    const created = await store.ensure(projected);

    expect(created).toMatchObject({
      kind: 'created',
      record: {
        custody: { state: 'ready', attemptCount: 0, providerMessageIds: [] },
        obligation: projected,
      },
    });
    if (created.kind !== 'created') throw new Error('expected a created custody row');
    expect(created.record.custodyId).toBe('gFZKwyyN6WSQP136mLN0axhpLYeetMe42DfkRhR1BBs');
    expect(created.record.custodyId).not.toContain('semantic-1');
    expect(deliveries.rows.get(created.record.custodyId)?.value).toEqual({
      id: created.record.custodyId,
      'record-kind': 'outward-delivery',
      v: 1,
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      terminal: false,
      attention: false,
      'created-at': 100,
      'updated-at': 100,
      payload: {
        source: projected.source,
        routeAuthority: projected.routeAuthority,
        endpoint,
        content: projected.content,
        contentFingerprint: null,
        deliveryKey: projected.deliveryKey,
        replyContext: null,
        mentionPolicy: 'suppress',
        linkPreviewPolicy: 'suppress',
        state: 'ready',
        attemptCount: 0,
        attemptId: null,
        startedAt: null,
        providerMessageIds: [],
        failedChunk: null,
        archiveRecovery: null,
      },
    });

    await expect(store.ensure(projected)).resolves.toMatchObject({
      kind: 'rejoined',
      record: { custodyId: created.record.custodyId },
    });
    await expect(store.ensure({ ...projected, content: 'changed after first write' }))
      .resolves.toEqual({ kind: 'conflict' });

    const claimed = await store.compareAndSwap({
      custodyId: created.record.custodyId,
      expectedRevision: created.record.revision,
      custody: {
        state: 'attempting',
        attemptCount: 1,
        attemptId: 'attempt-1',
        startedAt: 101,
        providerMessageIds: [],
      },
    });
    expect(claimed).toMatchObject({
      kind: 'updated',
      record: {
        custodyId: created.record.custodyId,
        custody: {
          state: 'attempting',
          attemptCount: 1,
          attemptId: 'attempt-1',
          startedAt: 101,
        },
      },
    });
  });

  it('compacts a non-attention terminal body in the custody CAS while preserving exact idempotency', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: new AbortController().signal,
      now: () => 100,
    });
    const projected: ConversationOutwardDeliveryObligation = {
      ...obligation(),
      source: {
        kind: 'sessionProjection',
        sessionId: 'session-retention-1',
        semanticItemId: 'semantic-retention-1',
      },
      content: 'A terminal body that must not remain in durable custody.',
      deliveryKey: 'channels:delivery:v1:session-retention-1:semantic-retention-1',
    };
    let providerCalls = 0;
    const deliver = async ({ obligation: attempted }: Readonly<{
      obligation: ConversationOutwardDeliveryObligation;
      signal: AbortSignal;
    }>) => {
      providerCalls += 1;
      expect(attempted.content).toBe(projected.content);
      return { kind: 'delivered' as const, providerMessageIds: ['provider-terminal-1'] };
    };

    await expect(deliverConversationOutwardDelivery({
      store,
      obligation: projected,
      attemptId: 'attempt-terminal-1',
      now: () => 101,
      ...currentAuthority(),
      deliver,
    })).resolves.toMatchObject({
      kind: 'settled',
      custody: { state: 'delivered', providerMessageIds: ['provider-terminal-1'] },
    });

    const [stored] = [...deliveries.rows.values()];
    expect(stored?.value).toMatchObject({
      terminal: true,
      attention: false,
      payload: {
        state: 'delivered',
        content: null,
        contentFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      },
    });
    expect(JSON.stringify(stored?.value)).not.toContain(projected.content);
    const validateDeliveryRow = compilePluginJsonSchema(CHANNEL_DELIVERIES_COLLECTION.schema);
    expect(isValidPluginJsonSchemaValue(validateDeliveryRow, stored?.value)).toBe(true);

    await expect(deliverConversationOutwardDelivery({
      store,
      obligation: projected,
      attemptId: 'attempt-terminal-replay',
      now: () => 102,
      ...currentAuthority(),
      deliver,
    })).resolves.toMatchObject({ kind: 'settled', custody: { state: 'delivered' } });
    await expect(store.ensure({ ...projected, content: 'different retained body' }))
      .resolves.toEqual({ kind: 'conflict' });
    expect(providerCalls).toBe(1);
  });

  it('rejoins a delivered custody row after an ordinary binding edit, and still fences a live attempt', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: new AbortController().signal,
      now: () => 100,
    });
    const projected: ConversationOutwardDeliveryObligation = {
      ...obligation(),
      source: {
        kind: 'sessionProjection',
        sessionId: 'session-route-1',
        semanticItemId: 'semantic-route-1',
      },
      content: 'An assistant reply already delivered to the provider.',
      deliveryKey: 'channels:delivery:v1:session-route-1:semantic-route-1',
    };
    if (projected.bindingId === undefined) throw new Error('Expected a binding-routed obligation.');
    let providerCalls = 0;
    const deliver = async () => {
      providerCalls += 1;
      return { kind: 'delivered' as const, providerMessageIds: ['provider-route-1'] };
    };

    await expect(deliverConversationOutwardDelivery({
      store,
      obligation: projected,
      attemptId: 'attempt-route-1',
      now: () => 101,
      ...currentAuthority(),
      deliver,
    })).resolves.toMatchObject({ kind: 'settled', custody: { state: 'delivered' } });
    expect(providerCalls).toBe(1);

    // Frontier advancement lost its CAS to an ordinary binding edit, so the
    // next wake derives the same semantic source under a new binding revision.
    const afterBindingEdit: ConversationOutwardDeliveryObligation = {
      ...projected,
      endpoint: { ...projected.endpoint, id: 'retargeted-provider-destination' },
      linkPreviewPolicy: 'providerDefault',
      routeAuthority: {
        connectionAuthorityEpoch: projected.routeAuthority.connectionAuthorityEpoch,
        bindingRevision: projected.routeAuthority.bindingRevision + 1,
        bindingAuthorityEpoch: projected.routeAuthority.bindingAuthorityEpoch,
      },
    };
    await expect(store.ensure(afterBindingEdit)).resolves.toMatchObject({
      kind: 'rejoined',
      record: { custody: { state: 'delivered' } },
    });
    await expect(deliverConversationOutwardDelivery({
      store,
      obligation: afterBindingEdit,
      attemptId: 'attempt-route-after-edit',
      now: () => 102,
      ...currentAuthority(),
      deliver,
    })).resolves.toMatchObject({ kind: 'settled', custody: { state: 'delivered' } });
    expect(providerCalls).toBe(1);

    const live: ConversationOutwardDeliveryObligation = {
      ...projected,
      source: {
        kind: 'sessionProjection',
        sessionId: 'session-route-2',
        semanticItemId: 'semantic-route-2',
      },
      deliveryKey: 'channels:delivery:v1:session-route-2:semantic-route-2',
    };
    if (live.bindingId === undefined) throw new Error('Expected a binding-routed obligation.');
    const created = await store.ensure(live);
    if (created.kind !== 'created') throw new Error('expected a created custody row');
    // A non-terminal row keeps the exact route authority its attempt is fenced
    // by; only a settled row may rejoin across changed route metadata.
    await expect(store.ensure({
      ...live,
      endpoint: { ...live.endpoint, id: 'different-live-provider-destination' },
      linkPreviewPolicy: 'providerDefault',
      routeAuthority: {
        connectionAuthorityEpoch: live.routeAuthority.connectionAuthorityEpoch,
        bindingRevision: live.routeAuthority.bindingRevision + 1,
        bindingAuthorityEpoch: live.routeAuthority.bindingAuthorityEpoch,
      },
    })).resolves.toEqual({ kind: 'conflict' });
  });

  it('returns retired and performs no provider effect when deterministic custody was logically deleted', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: new AbortController().signal,
      now: () => 100,
    });
    const projected: ConversationOutwardDeliveryObligation = {
      ...obligation(),
      source: {
        kind: 'sessionProjection',
        sessionId: 'session-retired-1',
        semanticItemId: 'semantic-retired-1',
      },
      content: 'This replay must never reach the provider.',
      deliveryKey: 'channels:delivery:v1:session-retired-1:semantic-retired-1',
    };
    const created = await store.ensure(projected);
    if (created.kind !== 'created') throw new Error('Expected initial custody creation.');
    await deliveries.delete(created.record.custodyId, {
      expectedRevision: created.record.revision,
    });

    await expect(store.ensure(projected)).resolves.toEqual({ kind: 'retired' });
    await expect(store.ensure({
      ...projected,
      content: 'A contradictory late body must still not resurrect custody.',
    })).resolves.toEqual({ kind: 'retired' });
    const deliver = vi.fn(async () => ({
      kind: 'delivered' as const,
      providerMessageIds: ['must-not-exist'],
    }));
    await expect(deliverConversationOutwardDelivery({
      store,
      obligation: projected,
      attemptId: 'attempt-retired-replay',
      now: () => 101,
      ...currentAuthority(),
      deliver,
    })).resolves.toEqual({ kind: 'retired' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('selects unresolved attention rows directly instead of paging unrelated false-attention history', async () => {
    // Keyset fake for the declared `by-connection-attention` index, implementing
    // the canonical host query semantics proven by the Data owner's compound
    // binary-index contract: `prefix` fixes leading key components and
    // `range` bounds the next component, ascending nulls first.
    type KeyRow = Readonly<{
      rowId: string;
      revision: number;
      value: Readonly<Record<string, unknown>>;
    }>;
    type KeyComponent = string | boolean | null;
    const indexKey = (row: KeyRow): readonly KeyComponent[] => [
      row.value['connection-id'] as string,
      row.value.attention as boolean,
      (row.value['binding-id'] as string | null) ?? null,
      row.rowId,
    ];
    const compareComponent = (left: KeyComponent, right: KeyComponent): number => {
      if (left === null && right === null) return 0;
      if (left === null) return -1;
      if (right === null) return 1;
      if (typeof left === 'boolean' && typeof right === 'boolean') {
        return left === right ? 0 : left ? 1 : -1;
      }
      if (typeof left === 'string' && typeof right === 'string') {
        return left.localeCompare(right);
      }
      throw new Error('Index key component types diverged from the declared index');
    };
    const compareKeys = (
      left: readonly KeyComponent[],
      right: readonly KeyComponent[],
    ): number => {
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const compared = compareComponent(left[index] ?? null, right[index] ?? null);
        if (compared !== 0) return compared;
      }
      return 0;
    };
    const startsWith = (
      key: readonly KeyComponent[],
      prefix: readonly KeyComponent[],
    ): boolean => prefix.every((component, index) => compareComponent(key[index] ?? null, component) === 0);

    const makeKeysetCollection = () => {
      const rows = new Map<string, KeyRow>();
      return {
        rows,
        async put(value: Readonly<Record<string, unknown>>, request: Readonly<{ expectedRevision: number | 'absent' }>) {
          const rowId = String(value.id);
          const current = rows.get(rowId);
          const matches = request.expectedRevision === 'absent'
            ? current === undefined
            : current?.revision === request.expectedRevision;
          if (!matches) throw Object.assign(new Error('conflict'), { code: 'plugin_collection_conflict' });
          const row = { rowId, revision: current?.revision === undefined ? 1 : current.revision + 1, value };
          rows.set(rowId, row);
          return row;
        },
        async get(rowId: string) {
          return rows.get(rowId) ?? null;
        },
        async query(request: Readonly<{ index: string; prefix?: readonly KeyComponent[]; range?: Readonly<{ lower?: KeyComponent; upper?: KeyComponent }>; order?: string; cursor?: string; limit?: number }>) {
          assertChannelsTestCollectionQueryLimit(request.limit);
          if (request.index !== 'by-connection-attention') return { rows: [], changeCursor: 1 };
          const prefix = request.prefix ?? [];
          const selected = [...rows.values()]
            .map((row) => ({ row, key: indexKey(row) }))
            .filter(({ key }) => startsWith(key, prefix))
            .filter(({ key }) => {
              if (request.range === undefined) return true;
              const component = key[prefix.length] ?? null;
              if (request.range.lower !== undefined && compareComponent(component, request.range.lower) < 0) return false;
              if (request.range.upper !== undefined && compareComponent(component, request.range.upper) > 0) return false;
              return true;
            })
            .sort((left, right) => compareKeys(left.key, right.key));
          const cursorKey = request.cursor === undefined ? null : (JSON.parse(request.cursor) as readonly KeyComponent[]);
          const afterCursor = cursorKey === null
            ? selected
            : selected.filter(({ key }) => compareKeys(key, cursorKey) > 0);
          const limit = request.limit ?? afterCursor.length;
          const page = afterCursor.slice(0, limit);
          return {
            rows: page.map(({ row }) => row),
            ...(afterCursor.length > page.length && page.length > 0
              ? { nextCursor: JSON.stringify(page[page.length - 1]!.key) }
              : {}),
            changeCursor: 1,
          };
        },
      };
    };

    const state = new MemoryAccountCollection();
    const deliveries = makeKeysetCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: new AbortController().signal,
      now: () => 100,
    });
    const bindingObligation = obligation();
    if (bindingObligation.bindingId === undefined) {
      throw new Error('Attention-index fixture requires binding-qualified custody.');
    }

    // Many unrelated terminal (false-attention) rows across bindings whose
    // identifiers sort before and after the unresolved rows' binding, plus
    // false-attention rows inside the unresolved binding itself: under the
    // former bare-connection prefix every one of them precedes the first
    // unresolved row of the last binding.
    const unrelatedBindings = ['binding-aaa', 'binding-bbb', 'binding-zzz'] as const;
    const unrelatedCounts = { 'binding-aaa': 150, 'binding-bbb': 150, 'binding-zzz': 100 } as const;
    let unrelatedOrdinal = 0;
    for (const bindingId of unrelatedBindings) {
      for (let index = 0; index < unrelatedCounts[bindingId]; index += 1) {
        const created = await store.ensure({
          ...bindingObligation,
          bindingId,
          source: {
            kind: 'sessionProjection',
            sessionId: `session-history-${bindingId}-${index}`,
            semanticItemId: `semantic-history-${bindingId}-${index}`,
          },
          content: `Unrelated delivered history ${unrelatedOrdinal}`,
          deliveryKey: `history:${bindingId}:${index}`,
        });
        if (created.kind !== 'created') throw new Error('Expected unrelated history custody creation.');
        const delivered = await store.compareAndSwap({
          custodyId: created.record.custodyId,
          expectedRevision: created.record.revision,
          custody: {
            state: 'delivered',
            attemptCount: 1,
            providerMessageIds: [`provider-${unrelatedOrdinal}`],
          },
        });
        if (delivered.kind !== 'updated') throw new Error('Expected unrelated history settlement.');
        unrelatedOrdinal += 1;
      }
    }
    expect(unrelatedOrdinal).toBe(400);

    const unresolvedBindings = [
      { bindingId: 'binding-aaa', state: 'partial' as const, control: 'delivery-direct-partial-aaa' },
      { bindingId: 'binding-zzz', state: 'partial' as const, control: 'delivery-direct-partial-zzz' },
      { bindingId: 'binding-zzz', state: 'outcomeUnknown' as const, control: 'delivery-direct-unknown-zzz' },
    ];
    const unresolvedCustodyIds = new Set<string>();
    for (const unresolved of unresolvedBindings) {
      const created = await store.ensure({
        ...bindingObligation,
        bindingId: unresolved.bindingId,
        source: {
          kind: 'controlResponse',
          controlId: unresolved.control,
          controlKind: 'recovery',
        },
        content: `Private unresolved body ${unresolved.control}.`,
        deliveryKey: unresolved.control,
      });
      if (created.kind !== 'created') throw new Error('Expected unresolved custody creation.');
      const ambiguous = await store.compareAndSwap({
        custodyId: created.record.custodyId,
        expectedRevision: created.record.revision,
        custody: unresolved.state === 'partial'
          ? { state: 'partial', attemptCount: 1, providerMessageIds: ['provider-message-private'], failedChunk: 1 }
          : { state: 'outcomeUnknown', attemptCount: 1, providerMessageIds: ['provider-message-private'] },
      });
      if (ambiguous.kind !== 'updated') throw new Error('Expected unresolved custody settlement.');
      unresolvedCustodyIds.add(created.record.custodyId);
    }

    const query = vi.spyOn(deliveries, 'query');
    const firstPage = await readConversationOutwardDeliveryResolutionPage({
      deliveriesCollection: deliveries as never,
      connectionId: 'connection-1',
      limit: 50,
    });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      index: 'by-connection-attention',
      prefix: ['connection-1'],
      range: { lower: true, upper: true },
      order: 'asc',
      limit: 50,
    }), undefined);
    // The first page is exactly the unresolved set: none of the 400 unrelated
    // false-attention rows precedes or displaces it.
    expect(new Set(firstPage.rows.map((row) => row.custodyId))).toEqual(unresolvedCustodyIds);
    expect(firstPage.nextCursor).toBeUndefined();

    // The bounded region still pages when the caller asks for smaller pages.
    const firstSmall = await readConversationOutwardDeliveryResolutionPage({
      deliveriesCollection: deliveries as never,
      connectionId: 'connection-1',
      limit: 2,
    });
    expect(firstSmall.rows).toHaveLength(2);
    if (firstSmall.nextCursor === undefined) throw new Error('Expected a continuation cursor.');
    const secondSmall = await readConversationOutwardDeliveryResolutionPage({
      deliveriesCollection: deliveries as never,
      connectionId: 'connection-1',
      cursor: firstSmall.nextCursor,
      limit: 2,
    });
    const smallPageCustodyIds = [
      ...firstSmall.rows.map((row) => row.custodyId),
      ...secondSmall.rows.map((row) => row.custodyId),
    ];
    expect(new Set(smallPageCustodyIds)).toEqual(unresolvedCustodyIds);
    expect(new Set(smallPageCustodyIds).size).toBe(3);
    expect(secondSmall.nextCursor).toBeUndefined();
  });

  it('reads only exact ambiguous-custody CAS facts and resolves them through the canonical Collection row', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal: new AbortController().signal,
      now: () => 100,
    });
    const createdPartial = await store.ensure({
      ...obligation(),
      source: { kind: 'controlResponse', controlId: 'delivery-resolution-partial', controlKind: 'recovery' },
      content: 'Private partially-sent delivery body.',
      deliveryKey: 'delivery-resolution-partial',
    });
    const createdUnknown = await store.ensure({
      ...obligation(),
      source: { kind: 'controlResponse', controlId: 'delivery-resolution-unknown', controlKind: 'recovery' },
      content: 'Private unknown-outcome delivery body.',
      deliveryKey: 'delivery-resolution-unknown',
    });
    if (createdPartial.kind !== 'created' || createdUnknown.kind !== 'created') {
      throw new Error('Expected canonical ambiguous custody setup.');
    }
    const partial = await store.compareAndSwap({
      custodyId: createdPartial.record.custodyId,
      expectedRevision: createdPartial.record.revision,
      custody: {
        state: 'partial',
        attemptCount: 1,
        providerMessageIds: ['provider-message-private'],
        failedChunk: 1,
      },
    });
    const unknown = await store.compareAndSwap({
      custodyId: createdUnknown.record.custodyId,
      expectedRevision: createdUnknown.record.revision,
      custody: {
        state: 'outcomeUnknown',
        attemptCount: 1,
        providerMessageIds: ['provider-message-private'],
      },
    });
    if (partial.kind !== 'updated' || unknown.kind !== 'updated') {
      throw new Error('Expected canonical ambiguous custody setup.');
    }

    const query = vi.spyOn(deliveries, 'query');
    await expect(readConversationOutwardDeliveryResolutionPage({
      deliveriesCollection: deliveries as never,
      connectionId: 'connection-1',
      cursor: 'prior-page',
      limit: 500,
    })).resolves.toEqual({
      rows: [
        {
          custodyId: partial.record.custodyId,
          revision: partial.record.revision,
          state: 'partial',
        },
        {
          custodyId: unknown.record.custodyId,
          revision: unknown.record.revision,
          state: 'outcomeUnknown',
        },
      ],
    });
    expect(query).toHaveBeenCalledWith({
      index: 'by-connection-attention',
      prefix: ['connection-1'],
      // The connection/attention index makes attention the ranged component.
      range: { lower: true, upper: true },
      order: 'asc',
      cursor: 'prior-page',
      limit: 200,
    }, undefined);

    const page = await readConversationOutwardDeliveryResolutionPage({
      deliveriesCollection: deliveries as never,
      connectionId: 'connection-1',
    });
    expect(JSON.stringify(page)).not.toContain('Private partially-sent delivery body.');
    expect(JSON.stringify(page)).not.toContain('provider-message-private');

    vi.spyOn(deliveries, 'put').mockRejectedValueOnce(new PluginError({
      code: 'plugin_account_storage_unavailable',
      message: 'Account Collection transport failed after dispatch.',
      retryable: true,
    }));
    await expect(resolveConversationOutwardDeliveryCustodyInAccountCollection({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      custodyId: partial.record.custodyId,
      expectedRevision: partial.record.revision,
      resolution: 'accepted',
      now: () => 200,
    })).rejects.toMatchObject({
      code: 'aborted',
      retryable: true,
    });
    expect(deliveries.rows.get(partial.record.custodyId)?.value).toMatchObject({
      attention: true,
      payload: {
        state: 'partial',
        content: 'Private partially-sent delivery body.',
        contentFingerprint: null,
      },
    });

    vi.spyOn(deliveries, 'put').mockRejectedValueOnce({
      name: 'PluginError',
      code: 'plugin_collection_conflict',
      message: 'Collection mutation conflicted with a newer row revision.',
    });
    await expect(resolveConversationOutwardDeliveryCustodyInAccountCollection({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      custodyId: partial.record.custodyId,
      expectedRevision: partial.record.revision,
      resolution: 'accepted',
    })).rejects.toMatchObject({
      code: 'channels_delivery_resolve_conflict',
      retryable: true,
    });

    await expect(resolveConversationOutwardDeliveryCustodyInAccountCollection({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      custodyId: partial.record.custodyId,
      expectedRevision: partial.record.revision,
      resolution: 'accepted',
      now: () => 200,
    })).resolves.toEqual({
      kind: 'resolved',
      custodyId: partial.record.custodyId,
      revision: partial.record.revision + 1,
      resolution: 'accepted',
    });
    expect(deliveries.rows.get(partial.record.custodyId)?.value).toMatchObject({
      attention: false,
      terminal: true,
      'updated-at': 200,
      payload: {
        state: 'resolvedAccepted',
        content: null,
        contentFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        providerMessageIds: ['provider-message-private'],
        failedChunk: 1,
      },
    });
    expect(JSON.stringify(deliveries.rows.get(partial.record.custodyId)?.value))
      .not.toContain('Private partially-sent delivery body.');
    await expect(resolveConversationOutwardDeliveryCustodyInAccountCollection({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      custodyId: partial.record.custodyId,
      expectedRevision: partial.record.revision,
      resolution: 'discarded',
    })).rejects.toMatchObject({
      code: 'channels_delivery_resolve_conflict',
      retryable: true,
    });
    await expect(resolveConversationOutwardDeliveryCustodyInAccountCollection({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      custodyId: partial.record.custodyId,
      expectedRevision: partial.record.revision + 1,
      resolution: 'discarded',
    })).rejects.toMatchObject({ code: 'channels_delivery_resolve_not_resolvable' });

    await expect(resolveConversationOutwardDeliveryCustodyInAccountCollection({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      custodyId: unknown.record.custodyId,
      expectedRevision: unknown.record.revision,
      resolution: 'discarded',
    })).resolves.toEqual({
      kind: 'resolved',
      custodyId: unknown.record.custodyId,
      revision: unknown.record.revision + 1,
      resolution: 'discarded',
    });
    expect(deliveries.rows.get(unknown.record.custodyId)?.value).toMatchObject({
      attention: false,
      payload: {
        state: 'resolvedDiscarded',
        content: null,
        contentFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      },
    });

    const foreignCustodyId = 'F'.repeat(43);
    await deliveries.put({
      id: foreignCustodyId,
      'record-kind': 'foreign-row',
    }, { expectedRevision: 'absent' });
    await expect(resolveConversationOutwardDeliveryCustodyInAccountCollection({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      custodyId: foreignCustodyId,
      expectedRevision: 1,
      resolution: 'accepted',
    })).rejects.toMatchObject({ code: 'channels_delivery_resolve_foreign' });

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(resolveConversationOutwardDeliveryCustodyInAccountCollection({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      custodyId: unknown.record.custodyId,
      expectedRevision: unknown.record.revision + 1,
      resolution: 'accepted',
      signal: cancelled.signal,
    })).rejects.toMatchObject({
      // An already-dispatched Action abort has an unknown persistence outcome;
      // use the host client's canonical ambiguity code so the mounted UI locks
      // the decision until it rereads the retained row.
      code: 'aborted',
      retryable: true,
    });
  });

  it('offers and performs owner-led archive recovery through the one custody transition owner', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 100,
    });
    const recoverable = await store.ensure({
      ...obligation(),
      source: { kind: 'controlResponse', controlId: 'archived-thread', controlKind: 'recovery' },
      content: 'Archived destination delivery body.',
      deliveryKey: 'delivery-archived-thread',
    });
    const refused = await store.ensure({
      ...obligation(),
      source: { kind: 'controlResponse', controlId: 'plain-refusal', controlKind: 'recovery' },
      content: 'Plainly refused delivery body.',
      deliveryKey: 'delivery-plain-refusal',
    });
    if (recoverable.kind !== 'created' || refused.kind !== 'created') {
      throw new Error('Expected canonical retained custody rows.');
    }
    // Exactly the arm Discord reports for code 50083 when the bot may manage
    // threads; the neighbouring row is an ordinary terminal refusal.
    const archived = await store.compareAndSwap({
      custodyId: recoverable.record.custodyId,
      expectedRevision: recoverable.record.revision,
      custody: {
        state: 'notDelivered',
        attemptCount: 1,
        providerMessageIds: [],
        archiveRecovery: 'unarchiveAndRetry',
      },
    });
    const plain = await store.compareAndSwap({
      custodyId: refused.record.custodyId,
      expectedRevision: refused.record.revision,
      custody: { state: 'notDelivered', attemptCount: 3, providerMessageIds: [] },
    });
    if (archived.kind !== 'updated' || plain.kind !== 'updated') {
      throw new Error('Expected canonical custody lifecycle updates.');
    }

    const validateDeliveryRow = compilePluginJsonSchema(CHANNEL_DELIVERIES_COLLECTION.schema);
    const archivedStored = deliveries.rows.get(recoverable.record.custodyId)?.value;
    const plainStored = deliveries.rows.get(refused.record.custodyId)?.value;
    expect(archivedStored).toMatchObject({
      payload: {
        state: 'notDelivered',
        archiveRecovery: 'unarchiveAndRetry',
        content: 'Archived destination delivery body.',
      },
    });
    expect(plainStored).toMatchObject({
      payload: {
        state: 'notDelivered',
        archiveRecovery: null,
        content: null,
        contentFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      },
    });
    expect(isValidPluginJsonSchemaValue(validateDeliveryRow, archivedStored)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validateDeliveryRow, plainStored)).toBe(true);

    await expect(readConversationOutwardDeliveryConnectionAttention({
      deliveriesCollection: deliveries as never,
      signal,
      connectionIds: ['connection-1'],
    })).resolves.toEqual({
      kind: 'ready',
      attentionByConnection: new Map([['connection-1', {
        retryDue: false,
        notDelivered: true,
        partial: false,
        outcomeUnknown: false,
        archiveRecovery: true,
      }]]),
    });
    // Only the recoverable arm is offered; the plain refusal stays terminal.
    await expect(readConversationOutwardDeliveryResolutionPage({
      deliveriesCollection: deliveries as never,
      connectionId: 'connection-1',
      signal,
    })).resolves.toEqual({
      rows: [{
        custodyId: recoverable.record.custodyId,
        revision: archived.record.revision,
        state: 'archiveRecoverable',
      }],
    });

    await expect(resolveConversationOutwardDeliveryCustodyInAccountCollection({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      custodyId: recoverable.record.custodyId,
      expectedRevision: archived.record.revision,
      resolution: 'retryAfterUnarchive',
      signal,
      now: () => 500,
    })).resolves.toEqual({
      kind: 'resolved',
      custodyId: recoverable.record.custodyId,
      revision: archived.record.revision + 1,
      resolution: 'retryAfterUnarchive',
    });
    // The reopened obligation returns to the ordinary due scan, so the existing
    // supervisor sends it again with no new owner.
    const scanner = createConversationOutwardDeliveryCollectionScanner({
      deliveriesCollection: deliveries as never,
      signal,
    });
    const rescanned = await scanner.scan({ now: 600, limit: 10 });
    if (rescanned.kind !== 'ready') throw new Error('Expected a canonical delivery scan.');
    expect(rescanned.records).toEqual([expect.objectContaining({
      custodyId: recoverable.record.custodyId,
      custody: expect.objectContaining({ state: 'ready' }),
    })]);

    await expect(resolveConversationOutwardDeliveryCustodyInAccountCollection({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      custodyId: refused.record.custodyId,
      expectedRevision: plain.record.revision,
      resolution: 'retryAfterUnarchive',
      signal,
    })).rejects.toMatchObject({ code: 'channels_delivery_resolve_not_resolvable' });
  });

  it('compacts a terminal owner-must-rebind archive refusal through the real declared schema', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 100,
    });
    const blocked = await store.ensure({
      ...obligation(),
      source: { kind: 'controlResponse', controlId: 'unmanageable-archived-thread', controlKind: 'recovery' },
      content: 'A delivery body only rebinding can replace.',
      deliveryKey: 'delivery-unmanageable-archived-thread',
    });
    if (blocked.kind !== 'created') throw new Error('Expected a canonical retained custody row.');
    // Exactly the arm Discord reports for code 50083 when the bot cannot
    // manage threads: terminal, never retryable in place, still attention.
    const settled = await store.compareAndSwap({
      custodyId: blocked.record.custodyId,
      expectedRevision: blocked.record.revision,
      custody: {
        state: 'notDelivered',
        attemptCount: 1,
        providerMessageIds: [],
        archiveRecovery: 'ownerMustUnarchiveOrRebind',
      },
    });
    expect(settled).toMatchObject({ kind: 'updated' });

    const stored = deliveries.rows.get(blocked.record.custodyId)?.value;
    expect(stored).toMatchObject({
      terminal: true,
      attention: true,
      payload: {
        state: 'notDelivered',
        archiveRecovery: 'ownerMustUnarchiveOrRebind',
        content: null,
        contentFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      },
    });
    expect(JSON.stringify(stored)).not.toContain('A delivery body only rebinding can replace.');
    // The real compiled Collection schema is the production CAS gate: a row
    // the runtime compactor writes must be persistable, or the terminal
    // settlement can never commit.
    const validateDeliveryRow = compilePluginJsonSchema(CHANNEL_DELIVERIES_COLLECTION.schema);
    expect(isValidPluginJsonSchemaValue(validateDeliveryRow, stored)).toBe(true);
    // The recoverable arm still requires its body: the same compiled schema
    // refuses a body-free row an owner could still unarchive and resend, so
    // the body-free predicate cannot silently drop retry input.
    if (stored === undefined) throw new Error('Expected the settled custody row.');
    const storedPayload = stored.payload;
    if (storedPayload === null || Array.isArray(storedPayload) || typeof storedPayload !== 'object') {
      throw new Error('Expected the settled custody payload.');
    }
    expect(isValidPluginJsonSchemaValue(validateDeliveryRow, {
      ...stored,
      payload: { ...storedPayload, archiveRecovery: 'unarchiveAndRetry' },
    })).toBe(false);
  });

  it('preserves exact opaque custody IDs across connection, binding, and closed source arms', async () => {
    const cases: readonly Readonly<{
      name: string;
      obligation: ConversationOutwardDeliveryObligation;
      expectedCustodyId: string;
    }>[] = [
      {
        name: 'connection control response',
        obligation: {
          connectionId: 'connection-1',
          routeAuthority: { connectionAuthorityEpoch: 4 },
          source: { kind: 'controlResponse', controlId: 'control-connection', controlKind: 'pairing' },
          endpoint,
          content: 'Your pairing request is ready.',
          deliveryKey: 'control:connection',
          mentionPolicy: 'suppress',
          linkPreviewPolicy: 'suppress',
        },
        expectedCustodyId: 'nb9mAR3GL5O-YiIW5YggljJk_lM7nGUDsjXLwiUjtqg',
      },
      {
        name: 'binding session projection',
        obligation: {
          ...obligation(),
          source: { kind: 'sessionProjection', sessionId: 'session-1', semanticItemId: 'semantic-1' },
          deliveryKey: 'session:semantic-1',
        },
        expectedCustodyId: 'gFZKwyyN6WSQP136mLN0axhpLYeetMe42DfkRhR1BBs',
      },
      {
        name: 'binding Automation result',
        obligation: {
          ...obligation(),
          source: {
            kind: 'automationResult',
            automationRunId: 'run-1',
            resultId: 'result-1',
            automationId: 'automation-1',
            resultDelivery: 'finalResult',
          },
          deliveryKey: 'automation:result-1',
        },
        expectedCustodyId: 'Jklw4tPMNbOBzRe8a70FlCJuOansKJffLWAGGLHmA_Y',
      },
      {
        name: 'binding permission wait',
        obligation: {
          ...obligation(),
          source: { kind: 'permissionWait', sessionId: 'session-1', turnId: 'turn-1', requestId: 'request-1' },
          deliveryKey: 'permission:request-1',
        },
        expectedCustodyId: 'c8MeCXOekXeEWRp1KLM9u6c1bSlGa9V9gu_qlE4ZpiI',
      },
      {
        name: 'binding control response',
        obligation: obligation(),
        expectedCustodyId: 'nXwPg6BHzwZFbeg649sYzgPGW2FiWbiTEyEmahPAMKk',
      },
    ];

    for (const identityCase of cases) {
      const state = new MemoryAccountCollection();
      const deliveries = new MemoryAccountCollection();
      await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
      const store = createConversationOutwardDeliveryCollectionStore({
        stateCollection: state as never,
        deliveriesCollection: deliveries as never,
        signal: new AbortController().signal,
        now: () => 100,
      });

      await expect(store.ensure(identityCase.obligation)).resolves.toMatchObject({
        kind: 'created',
        record: { custodyId: identityCase.expectedCustodyId },
      });
    }
  });

  it('collapses malformed keys and unavailable crypto to connection corruption before a custody write', async () => {
    const ensure = async (routingIdentityKey: string) => {
      const state = new MemoryAccountCollection();
      const deliveries = new MemoryAccountCollection();
      const connection = providerConnectionRow();
      await state.put({
        ...connection,
        payload: { ...connection.payload, routingIdentityKey },
      }, { expectedRevision: 'absent' });
      const store = createConversationOutwardDeliveryCollectionStore({
        stateCollection: state as never,
        deliveriesCollection: deliveries as never,
        signal: new AbortController().signal,
      });
      return { result: await store.ensure(obligation()), deliveries };
    };

    const malformed = await ensure('not-base64url%');
    expect(malformed.result).toEqual({ kind: 'unavailable', reason: 'connectionCorrupt' });
    expect(malformed.deliveries.rows.size).toBe(0);

    vi.stubGlobal('crypto', undefined);
    try {
      const unavailableCrypto = await ensure('a'.repeat(43));
      expect(unavailableCrypto.result).toEqual({ kind: 'unavailable', reason: 'connectionCorrupt' });
      expect(unavailableCrypto.deliveries.rows.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lets the next storage read observe cancellation that arrives during outward hashing', async () => {
    const controller = new AbortController();
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    const importKey = vi.fn(async () => ({}) as CryptoKey);
    const sign = vi.fn(async () => {
      controller.abort();
      return new ArrayBuffer(32);
    });
    vi.stubGlobal('crypto', { subtle: { importKey, sign } });
    try {
      const store = createConversationOutwardDeliveryCollectionStore({
        stateCollection: state as never,
        deliveriesCollection: deliveries as never,
        signal: controller.signal,
      });

      await expect(store.ensure(obligation())).resolves.toEqual({
        kind: 'unavailable',
        reason: 'cancelled',
      });
      expect(importKey).toHaveBeenCalledOnce();
      expect(sign).toHaveBeenCalledOnce();
      expect(deliveries.rows).toEqual(new Map());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('accepts only a current prepared route into ready custody and leaves a disabled binding without a new delivery row', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint,
        target: sessionTarget,
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 100,
    });
    const projected: ConversationOutwardDeliveryObligation = {
      ...obligation(),
      deliveryKey: 'channels:delivery:v1:session-1:semantic-2',
      source: {
        kind: 'sessionProjection',
        sessionId: 'session-1',
        semanticItemId: 'semantic-2',
      },
    };
    const prepared = await prepareConversationOutwardDeliveryReady({
      stateCollection: state as never,
      signal,
      obligation: projected,
    });
    expect(prepared).toEqual({
      kind: 'ready',
      obligation: projected,
      outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
    });
    await expect(acceptConversationOutwardDeliveryReady({ store, prepared, signal }))
      .resolves.toMatchObject({ kind: 'accepted', custody: { state: 'ready' } });

    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: false,
        deletionState: 'none',
        endpoint,
        target: sessionTarget,
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 1 });
    const blocked = await prepareConversationOutwardDeliveryReady({
      stateCollection: state as never,
      signal,
      obligation: { ...projected, deliveryKey: 'channels:delivery:v1:session-1:semantic-3' },
    });

    expect(blocked).toEqual({ kind: 'suppressed', reason: 'bindingDisabled' });
    await expect(acceptConversationOutwardDeliveryReady({ store, prepared: blocked, signal }))
      .resolves.toEqual({ kind: 'suppressed', reason: 'bindingDisabled' });
    expect(deliveries.rows.size).toBe(1);
  });

  it('records provider-bound oversized ready admission as terminal no-effect custody before a provider can run', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    const connection = providerConnectionRow();
    await state.put({
      ...connection,
      payload: {
        ...connection.payload,
        outboundTextLimit: { maximum: 2, unit: 'unicodeCodePoints' },
      },
    }, { expectedRevision: 'absent' });
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint,
        target: sessionTarget,
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 'absent' });
    const signal = new AbortController().signal;
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 100,
    });
    const projected: ConversationOutwardDeliveryObligation = {
      ...obligation(),
      content: 'x'.repeat(65),
      deliveryKey: 'channels:delivery:v1:oversized-ready-custody',
      source: {
        kind: 'sessionProjection',
        sessionId: 'session-1',
        semanticItemId: 'oversized-ready-custody',
      },
    };

    const prepared = await prepareConversationOutwardDeliveryReady({
      stateCollection: state as never,
      signal,
      obligation: projected,
    });

    expect(prepared).toEqual({
      kind: 'ready',
      obligation: projected,
      outboundTextLimit: { maximum: 2, unit: 'unicodeCodePoints' },
      knownNoEffect: 'providerChunkLimitExceeded',
    });
    await expect(acceptConversationOutwardDeliveryReady({ store, prepared, signal }))
      .resolves.toMatchObject({
        kind: 'accepted',
        custody: { state: 'notDelivered', attemptCount: 0, providerMessageIds: [] },
      });
    expect([...deliveries.rows.values()][0]?.value).toMatchObject({
      terminal: true,
      attention: true,
      payload: {
        state: 'notDelivered',
        content: null,
        contentFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      },
    });
  });

  it('rechecks the mandatory connection-only route authority before ready custody', async () => {
    const state = new MemoryAccountCollection();
    const signal = new AbortController().signal;
    const connection = providerConnectionRow();
    await state.put(connection, { expectedRevision: 'absent' });
    const connectionOnly: ConversationOutwardDeliveryObligation = {
      connectionId: 'connection-1',
      routeAuthority: { connectionAuthorityEpoch: 4 },
      source: { kind: 'controlResponse', controlId: 'pairing-1', controlKind: 'pairing' },
      endpoint,
      content: 'Your pairing request is ready.',
      deliveryKey: 'pairing:pairing-1',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    };

    await expect(prepareConversationOutwardDeliveryReady({
      stateCollection: state as never,
      signal,
      obligation: connectionOnly,
    })).resolves.toMatchObject({ kind: 'ready' });

    await state.put({
      ...connection,
      payload: { ...connection.payload, authorityEpoch: 5 },
    }, { expectedRevision: 1 });
    await expect(prepareConversationOutwardDeliveryReady({
      stateCollection: state as never,
      signal,
      obligation: connectionOnly,
    })).resolves.toEqual({ kind: 'suppressed', reason: 'staleAuthority' });
  });

  it('fails closed before provider I/O when the current transport origin is not canonical', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    const signal = new AbortController().signal;
    const connection = providerConnectionRow();
    await state.put({
      ...connection,
      payload: {
        ...connection.payload,
        // Fixture boundary: this is deliberately not the host-owned origin schema.
        transportOrigin: {},
      },
    }, { expectedRevision: 'absent' });
    const store = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 100,
    });
    const authority = createConversationOutwardDeliveryCollectionAuthority({
      stateCollection: state as never,
    });
    const connectionOnly: ConversationOutwardDeliveryObligation = {
      connectionId: 'connection-1',
      routeAuthority: { connectionAuthorityEpoch: 4 },
      source: { kind: 'controlResponse', controlId: 'pairing-origin-1', controlKind: 'pairing' },
      endpoint,
      content: 'Your pairing request is ready.',
      deliveryKey: 'pairing:pairing-origin-1',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    };
    let providerCalls = 0;

    await expect(deliverConversationOutwardDelivery({
      store,
      obligation: connectionOnly,
      outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
      attemptId: 'attempt-malformed-current-origin',
      now: () => 100,
      signal,
      authority,
      deliver: async () => {
        providerCalls += 1;
        return { kind: 'delivered', providerMessageIds: ['must-not-exist'] };
      },
    })).resolves.toEqual({
      kind: 'notAttempted',
      reason: 'connectionCorrupt',
    });

    expect(providerCalls).toBe(0);
    expect(deliveries.rows.size).toBe(0);
  });

  it('rejects a malformed current connection before ready custody or provider delivery', async () => {
    const state = new MemoryAccountCollection();
    const store = new MemoryDeliveryStore();
    const connection = providerConnectionRow();
    // Fixture boundary: persisted current rows require this setup input even
    // though outward delivery does not consume its contents.
    const { providerSetupInput: _providerSetupInput, ...payloadWithoutSetupInput } = connection.payload;
    await state.put({
      ...connection,
      payload: payloadWithoutSetupInput,
    }, { expectedRevision: 'absent' });
    const connectionOnly: ConversationOutwardDeliveryObligation = {
      connectionId: 'connection-1',
      routeAuthority: { connectionAuthorityEpoch: 4 },
      source: { kind: 'controlResponse', controlId: 'pairing-malformed-connection', controlKind: 'pairing' },
      endpoint,
      content: 'Your pairing request is ready.',
      deliveryKey: 'pairing:malformed-connection',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    };
    const record: ConversationOutwardDeliveryRecord = {
      custodyId: 'malformed-connection-custody',
      revision: 1,
      createdAt: 0,
      obligation: connectionOnly,
      custody: { state: 'ready', attemptCount: 0, providerMessageIds: [] },
    };
    store.rows.set(record.custodyId, record);
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      _operation: unknown,
      _input: Readonly<Record<string, unknown>>,
      _options: Readonly<{ signal?: AbortSignal }>,
    ) => ({
      result: { kind: 'delivered', providerMessageIds: ['must-not-exist'] },
      executionOrigin: providerTransportOrigin,
    }));

    await expect(redriveConversationOutwardDeliveryThroughProviderAction({
      stateCollection: state as never,
      targetedContributions: targetedProviderDeliveryContributions(),
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as never,
      store,
      record,
      attemptId: 'attempt-malformed-current-connection',
      now: () => 100,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: 'suppressed',
      reason: 'currentnessUnavailable',
      custody: { state: 'suppressed' },
    });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    await expect(prepareConversationOutwardDeliveryReady({
      stateCollection: state as never,
      signal: new AbortController().signal,
      obligation: connectionOnly,
    })).resolves.toEqual({ kind: 'unavailable', reason: 'stateCorrupt' });
  });

  it('rechecks a durable Automation route after restart without treating a display-only binding revision as authority', async () => {
    const state = new MemoryAccountCollection();
    const deliveries = new MemoryAccountCollection();
    const signal = new AbortController().signal;
    const automationTarget = {
      kind: 'automation',
      automationId: 'automation-1',
      policy: { resultDelivery: 'finalResult' },
    } as const;
    await state.put(providerConnectionRow(), { expectedRevision: 'absent' });
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint,
        target: automationTarget,
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 'absent' });
    const obligationFor = (resultId: string): ConversationOutwardDeliveryObligation => ({
      connectionId: 'connection-1',
      bindingId: 'binding-1',
      routeAuthority: {
        connectionAuthorityEpoch: 4,
        bindingRevision: 1,
        bindingAuthorityEpoch: 7,
      },
      source: {
        kind: 'automationResult',
        automationRunId: 'run-1',
        resultId,
        automationId: 'automation-1',
        resultDelivery: 'finalResult',
      },
      endpoint,
      content: 'The Automation completed.',
      deliveryKey: `automation:${resultId}`,
      replyContext: { replyToMessageId: 'message-1' },
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    });
    const firstStore = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 100,
    });
    const first = await firstStore.ensure(obligationFor('handoff-display'));
    if (first.kind !== 'created') throw new Error('expected durable ready custody');

    // A display label increments the Collection revision but does not alter
    // endpoint identity or either semantic authority epoch.
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint: { ...endpoint, label: 'Operations' },
        target: automationTarget,
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 1 });
    await expect(prepareConversationOutwardDeliveryReady({
      stateCollection: state as never,
      signal,
      obligation: obligationFor('handoff-ready-revision'),
    })).resolves.toEqual({ kind: 'suppressed', reason: 'staleAuthority' });
    const restartedStore = createConversationOutwardDeliveryCollectionStore({
      stateCollection: state as never,
      deliveriesCollection: deliveries as never,
      signal,
      now: () => 101,
    });
    const restartedAuthority = createConversationOutwardDeliveryCollectionAuthority({
      stateCollection: state as never,
    });
    let delivered = 0;
    await expect(deliverConversationOutwardDelivery({
      store: restartedStore,
      obligation: obligationFor('handoff-display'),
      outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
      attemptId: 'attempt-display',
      now: () => 101,
      signal,
      authority: restartedAuthority,
      deliver: async () => {
        delivered += 1;
        return { kind: 'delivered', providerMessageIds: ['provider-message-1'] };
      },
    })).resolves.toMatchObject({ kind: 'settled', custody: { state: 'delivered' } });
    expect(delivered).toBe(1);

    const pending = await restartedStore.ensure(obligationFor('handoff-target'));
    if (pending.kind !== 'created') throw new Error('expected a second durable ready custody');
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 7,
        enabled: true,
        deletionState: 'none',
        endpoint: { ...endpoint, label: 'Operations' },
        target: { ...automationTarget, automationId: 'automation-2' },
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 2 });
    let providerCallsAfterTargetChange = 0;
    await expect(deliverConversationOutwardDelivery({
      store: restartedStore,
      obligation: obligationFor('handoff-target'),
      outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
      attemptId: 'attempt-target',
      now: () => 102,
      signal,
      authority: restartedAuthority,
      deliver: async () => {
        providerCallsAfterTargetChange += 1;
        return { kind: 'delivered', providerMessageIds: ['must-not-exist'] };
      },
    })).resolves.toMatchObject({ kind: 'suppressed', reason: 'targetChanged' });
    expect(providerCallsAfterTargetChange).toBe(0);

    const authorityChanged = await restartedStore.ensure(obligationFor('handoff-epoch'));
    if (authorityChanged.kind !== 'created') throw new Error('expected a third durable ready custody');
    await state.put({
      id: 'binding-1',
      'record-kind': 'binding',
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      payload: {
        authorityEpoch: 8,
        enabled: true,
        deletionState: 'none',
        endpoint: { ...endpoint, label: 'Operations' },
        target: automationTarget,
        linkPreviewPolicy: 'suppress',
      },
    }, { expectedRevision: 3 });
    await expect(restartedAuthority.checkCurrentness({
      record: authorityChanged.record,
      signal,
    })).resolves.toEqual({ kind: 'suppressed', reason: 'staleAuthority' });
  });

  it('uses the one custody path for a canonical Session projection source', async () => {
    const store = new MemoryDeliveryStore();
    const projected: ConversationOutwardDeliveryObligation = {
      ...obligation(),
      deliveryKey: 'session:session-1:semantic-1',
      source: {
        kind: 'sessionProjection',
        sessionId: 'session-1',
        semanticItemId: 'semantic-1',
      },
    };

    const result = await deliverConversationOutwardDelivery({
      store,
      obligation: projected,
      attemptId: 'attempt-1',
      now: () => 100,
      ...currentAuthority(),
      deliver: async ({ obligation: delivered }) => {
        expect(delivered.source).toEqual(projected.source);
        expect(store.rows.get(JSON.stringify([
          projected.connectionId,
          projected.bindingId ?? null,
          projected.source,
        ]))?.custody.state).toBe('attempting');
        return { kind: 'delivered', providerMessageIds: ['provider-message-1'] };
      },
    });

    expect(result).toMatchObject({ kind: 'settled', custody: { state: 'delivered' } });
    expect(store.events).toEqual(['ensure', 'cas:attempting', 'cas:delivered']);
  });

  it('records multibyte content beyond the feature UTF-8 ceiling as terminal attention custody without provider I/O', async () => {
    const store = new MemoryDeliveryStore();
    let providerCalls = 0;

    const result = await deliverConversationOutwardDelivery({
      store,
      obligation: {
        ...obligation(),
        content: '😀'.repeat(60_000),
      },
      attemptId: 'attempt-1',
      now: () => 100,
      ...currentAuthority(),
      deliver: async () => {
        providerCalls += 1;
        return { kind: 'delivered', providerMessageIds: ['must-not-exist'] };
      },
    });

    expect(result).toEqual({
      kind: 'settled',
      custody: {
        state: 'notDelivered',
        attemptCount: 0,
        providerMessageIds: [],
      },
    });
    expect(store.events).toEqual(['ensure', 'cas:notDelivered']);
    expect(providerCalls).toBe(0);
  });

  it('admits a complete encoded delivery row above the former 256 KiB quota', async () => {
    const store = new MemoryDeliveryStore();
    let providerCalls = 0;

    const result = await deliverConversationOutwardDelivery({
      store,
      obligation: {
        ...obligation(),
        content: '\\'.repeat(150_000),
      },
      attemptId: 'attempt-1',
      now: () => 100,
      ...currentAuthority(),
      outboundTextLimit: { maximum: 5_000, unit: 'unicodeCodePoints' },
      deliver: async () => {
        providerCalls += 1;
        return { kind: 'delivered', providerMessageIds: ['must-not-exist'] };
      },
    });

    expect(store.lastEncodedRowBytes).toBeGreaterThan(256 * 1024);
    expect(store.lastEncodedRowBytes).toBeLessThanOrEqual(512 * 1024);
    expect(result).toMatchObject({ kind: 'settled', custody: { state: 'delivered' } });
    expect(store.events).toEqual(['ensure', 'cas:attempting', 'cas:delivered']);
    expect(providerCalls).toBe(1);
  });

  it('records the provider-unit multiplied chunk ceiling as terminal attention custody', async () => {
    const store = new MemoryDeliveryStore();
    let providerCalls = 0;

    expect(await deliverConversationOutwardDelivery({
      store,
      obligation: { ...obligation(), content: 'x'.repeat(65) },
      attemptId: 'attempt-1',
      now: () => 100,
      ...currentAuthority(),
      outboundTextLimit: { maximum: 2, unit: 'unicodeCodePoints' },
      deliver: async () => {
        providerCalls += 1;
        return { kind: 'delivered', providerMessageIds: ['must-not-exist'] };
      },
    })).toEqual({
      kind: 'settled',
      custody: {
        state: 'notDelivered',
        attemptCount: 0,
        providerMessageIds: [],
      },
    });
    expect(store.events).toEqual(['ensure', 'cas:notDelivered']);
    expect(providerCalls).toBe(0);
  });

  it('re-reads canonical authority after claim and durably suppresses a disable race before provider I/O', async () => {
    const store = new MemoryDeliveryStore();
    const abort = new AbortController();
    let providerCalls = 0;

    const result = await deliverConversationOutwardDelivery({
      store,
      obligation: obligation(),
      attemptId: 'attempt-1',
      now: () => 100,
      ...currentAuthority(),
      signal: abort.signal,
      authority: {
        checkCurrentness: async () => {
          store.events.push('currentness:connectionDisabled');
          return { kind: 'suppressed', reason: 'connectionDisabled' };
        },
      },
      deliver: async () => {
        providerCalls += 1;
        store.events.push('provider');
        return { kind: 'delivered', providerMessageIds: ['must-not-exist'] };
      },
    });

    expect(providerCalls).toBe(0);
    expect(store.events).toEqual([
      'ensure',
      'cas:attempting',
      'currentness:connectionDisabled',
      'cas:suppressed',
    ]);
    expect(result).toEqual({
      kind: 'suppressed',
      reason: 'connectionDisabled',
      custody: {
        state: 'suppressed',
        attemptCount: 1,
        providerMessageIds: [],
      },
    });
  });

  it('settles cancellation that wins after the currentness read without crossing provider I/O', async () => {
    const store = new MemoryDeliveryStore();
    const abort = new AbortController();
    let providerCalls = 0;

    const result = await deliverConversationOutwardDelivery({
      store,
      obligation: obligation(),
      attemptId: 'attempt-1',
      now: () => 100,
      ...currentAuthority(),
      signal: abort.signal,
      authority: {
        checkCurrentness: async () => {
          store.events.push('currentness:current');
          abort.abort();
          return { kind: 'current' };
        },
      },
      deliver: async () => {
        providerCalls += 1;
        return { kind: 'delivered', providerMessageIds: ['must-not-exist'] };
      },
    });

    expect(result).toMatchObject({
      kind: 'suppressed',
      reason: 'cancelled',
      custody: { state: 'suppressed' },
    });
    expect(store.events).toEqual([
      'ensure',
      'cas:attempting',
      'currentness:current',
      'cas:suppressed',
    ]);
    expect(providerCalls).toBe(0);
  });

  it('durably creates the canonical obligation and wins CAS before provider I/O', async () => {
    const store = new MemoryDeliveryStore();
    const result = await deliverConversationOutwardDelivery({
      store,
      obligation: obligation(),
      attemptId: 'attempt-1',
      now: () => 100,
      ...currentAuthority(),
      deliver: async () => {
        store.events.push('provider');
        expect(store.rows.get(JSON.stringify([
          'connection-1',
          'binding-1',
          { kind: 'controlResponse', controlId: 'ingress-1', controlKind: 'newSession' },
        ]))?.custody.state).toBe('attempting');
        return { kind: 'delivered', providerMessageIds: ['provider-message-1'] };
      },
    });

    expect(store.events).toEqual(['ensure', 'cas:attempting', 'provider', 'cas:delivered']);
    expect(result).toMatchObject({ kind: 'settled', custody: { state: 'delivered' } });
  });

  it('allows only one concurrent CAS winner to call the provider', async () => {
    const store = new MemoryDeliveryStore();
    let providerCalls = 0;
    let release: (() => void) | undefined;
    const deliver = async (): Promise<ConversationDeliveryResultV1> => {
      providerCalls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return { kind: 'delivered', providerMessageIds: ['provider-message-1'] };
    };
    const first = deliverConversationOutwardDelivery({
      store,
      obligation: obligation(),
      attemptId: 'attempt-1',
      now: () => 100,
      ...currentAuthority(),
      deliver,
    });
    await Promise.resolve();
    const second = await deliverConversationOutwardDelivery({
      store,
      obligation: obligation(),
      attemptId: 'attempt-2',
      now: () => 101,
      ...currentAuthority(),
      deliver,
    });
    expect(second).toEqual({ kind: 'notAttempted', reason: 'attemptInProgress' });
    expect(providerCalls).toBe(1);
    release?.();
    await expect(first).resolves.toMatchObject({ kind: 'settled' });
  });

  it('settles a thrown provider boundary as outcome-unknown instead of retrying blindly', async () => {
    const store = new MemoryDeliveryStore();
    const result = await deliverConversationOutwardDelivery({
      store,
      obligation: obligation(),
      attemptId: 'attempt-1',
      now: () => 100,
      ...currentAuthority(),
      deliver: async () => {
        throw new Error('connection reset after request write');
      },
    });

    expect(result).toMatchObject({ kind: 'settled', custody: { state: 'outcomeUnknown' } });
    expect(store.rows.get(JSON.stringify([
      'connection-1',
      'binding-1',
      { kind: 'controlResponse', controlId: 'ingress-1', controlKind: 'newSession' },
    ]))?.custody.state).toBe('outcomeUnknown');
  });

  it('reports a post-provider CAS conflict as pending settlement, never as no attempt', async () => {
    const store = new MemoryDeliveryStore();
    const compareAndSwap = store.compareAndSwap.bind(store);
    let casCalls = 0;
    store.compareAndSwap = async (input) => {
      casCalls += 1;
      return casCalls === 1 ? compareAndSwap(input) : { kind: 'conflict' };
    };
    const providerResult = { kind: 'delivered', providerMessageIds: ['provider-message-1'] } as const;
    expect(await deliverConversationOutwardDelivery({
      store,
      obligation: obligation(),
      attemptId: 'attempt-1',
      now: () => 100,
      ...currentAuthority(),
      deliver: async () => providerResult,
    })).toEqual({
      kind: 'settlementPending',
      custody: {
        state: 'delivered',
        attemptCount: 1,
        providerMessageIds: ['provider-message-1'],
      },
      providerResult,
    });
  });

  it('never calls the provider when deterministic obligation identity conflicts', async () => {
    const store = new MemoryDeliveryStore();
    await store.ensure(obligation());
    let providerCalled = false;
    const conflicting = {
      ...obligation(),
      deliveryKey: 'different-control',
    };
    expect(await deliverConversationOutwardDelivery({
      store,
      obligation: conflicting,
      attemptId: 'attempt-1',
      now: () => 100,
      ...currentAuthority(),
      deliver: async () => {
        providerCalled = true;
        return { kind: 'delivered', providerMessageIds: [] };
      },
    })).toEqual({ kind: 'notAttempted', reason: 'obligationConflict' });
    expect(providerCalled).toBe(false);
  });
});

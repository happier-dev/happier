import type {
  ActionsService,
  PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';
import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { ConversationOutwardDeliveryResult } from './outwardDelivery.js';
import {
  acceptConversationSessionProjectionBaseline,
  createConversationSessionProjectionCollectionStore,
  createConversationSessionProjectionFrontierRow,
  readConversationSessionProjectionNoHistoryBaseline,
  projectConversationSessionTranscriptPage,
  type ConversationSessionProjectionFrontier,
  type ConversationSessionProjectionStore,
} from './sessionProjection.js';

type ProjectionBinding = Readonly<{
  bindingId: string;
  revision: number;
  connectionId: string;
  target: Readonly<{
    sessionId: string;
    deliveryMode: 'repliesOnly' | 'mirrorSession';
  }>;
}>;

function binding(deliveryMode: 'repliesOnly' | 'mirrorSession' = 'mirrorSession'): ProjectionBinding {
  return {
    bindingId: 'binding-1',
    revision: 7,
    connectionId: 'connection-1',
    target: { sessionId: 'session-1', deliveryMode },
  };
}

function frontier(): ConversationSessionProjectionFrontier {
  return {
    targetSessionId: 'session-1',
    transcriptCursor: '3',
    lastScannedSeq: 3,
    revision: 4,
  };
}

class MemoryProjectionStore implements ConversationSessionProjectionStore {
  readonly updates: Array<Readonly<{
    expectedBindingRevision: number;
    frontierRowId: string;
    expectedFrontierRowRevision: number;
    frontier: ConversationSessionProjectionFrontier;
  }>> = [];

  constructor(
    private readonly currentBinding: ProjectionBinding,
    private currentFrontier: ConversationSessionProjectionFrontier,
  ) {}

  async read() {
    return {
      kind: 'ready' as const,
      binding: this.currentBinding,
      frontier: this.currentFrontier,
      frontierRowId: 'frontier-1',
      frontierRowRevision: 4,
    };
  }

  async compareAndSwap(input: Readonly<{
    bindingId: string;
    expectedBindingRevision: number;
    frontierRowId: string;
    expectedFrontierRowRevision: number;
    frontier: ConversationSessionProjectionFrontier;
  }>) {
    if (input.bindingId !== this.currentBinding.bindingId
      || input.expectedBindingRevision !== this.currentBinding.revision
      || input.frontierRowId !== 'frontier-1'
      || input.expectedFrontierRowRevision !== 4) {
      return { kind: 'conflict' as const };
    }
    this.updates.push(input);
    this.currentFrontier = input.frontier;
    return { kind: 'updated' as const };
  }

  async recordHistoryGap() {
    return { kind: 'recorded' as const };
  }
}

class MemoryProjectionCollection {
  readonly rows = new Map<string, Readonly<{
    rowId: string;
    revision: number;
    value: Record<string, unknown>;
  }>>();

  async get(rowId: string) {
    return this.rows.get(rowId) ?? null;
  }

  async batch(operations: readonly Readonly<Record<string, unknown>>[]) {
    for (const operation of operations) {
      if (operation.kind !== 'assert') continue;
      const rowId = operation.rowId;
      const expectedRevision = operation.expectedRevision;
      const current = typeof rowId === 'string' ? this.rows.get(rowId) : undefined;
      if (typeof expectedRevision !== 'number' || current?.revision !== expectedRevision) {
        return {
          status: 'conflict' as const,
          conflicts: [{
            rowId: typeof rowId === 'string' ? rowId : '',
            revision: current?.revision ?? 0,
            deleted: false as const,
          }],
        };
      }
    }
    const results: Array<Readonly<{ rowId: string; revision: number; deleted: false }>> = [];
    for (const operation of operations) {
      if (operation.kind !== 'put' || operation.value === null || typeof operation.value !== 'object') continue;
      const value = operation.value as Record<string, unknown>;
      const rowId = value.id;
      const expectedRevision = operation.expectedRevision;
      const current = typeof rowId === 'string' ? this.rows.get(rowId) : undefined;
      if (typeof rowId !== 'string'
        || (expectedRevision === 'absent' ? current !== undefined : current?.revision !== expectedRevision)) {
        return {
          status: 'conflict' as const,
          conflicts: [{
            rowId: typeof rowId === 'string' ? rowId : '',
            revision: current?.revision ?? 0,
            deleted: false as const,
          }],
        };
      }
      const row = { rowId, revision: (current?.revision ?? 0) + 1, value };
      this.rows.set(rowId, row);
      results.push({ rowId, revision: row.revision, deleted: false });
    }
    return { status: 'updated' as const, results, changeCursor: 1 };
  }
}

function persistedProjectionBindingRow(input: Readonly<{
  revision?: number;
  deliveryMode?: 'repliesOnly' | 'mirrorSession';
}> = {}) {
  const revision = input.revision ?? 7;
  return {
    rowId: 'binding-1',
    revision,
    value: {
      id: 'binding-1',
      'record-kind': 'binding',
      v: 1,
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      'created-at': 100,
      'updated-at': 100,
      payload: {
        endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
        target: {
          kind: 'session',
          sessionId: 'session-1',
          policy: {
            deliveryMode: input.deliveryMode ?? 'mirrorSession',
            permissionCeiling: 'read-only',
            approvals: { kind: 'off' },
            newSession: { kind: 'off' },
          },
        },
        allowedPrincipalIds: ['person-1'],
        allowBotSenders: false,
        inputMode: 'allAllowedMessages',
        inboundDebounceMs: 750,
        linkPreviewPolicy: 'suppress',
        senderFeedback: 'off',
        authorityEpoch: 1,
        enabled: true,
        deletionState: 'none',
      },
    },
  };
}

function actions(result: PluginActionResultById['session.transcript.get']) {
  const execute = vi.fn(async () => result);
  // Fixture boundary: the projection only invokes the public Actions service.
  return { execute } as unknown as ActionsService & Readonly<{ execute: typeof execute }>;
}

function rejectingActions(error: unknown) {
  const execute = vi.fn(async () => {
    throw error;
  });
  // Fixture boundary: the projection only invokes the public Actions service.
  return { execute } as unknown as ActionsService & Readonly<{ execute: typeof execute }>;
}

function delivered(): ConversationOutwardDeliveryResult {
  return {
    kind: 'settled',
    custody: { state: 'delivered', attemptCount: 1, providerMessageIds: ['message-1'] },
  };
}

describe('Conversation Session mirror projection', () => {
  it('delivers only closed collaborator items in page order and advances its durable frontier after custody settles', async () => {
    const store = new MemoryProjectionStore(binding(), frontier());
    const actionService = actions({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-1',
      scannedThroughSeq: 7,
      nextCursor: '7',
      hasMore: false,
      items: [
        {
          kind: 'userText',
          sessionId: 'session-1',
          seq: 4,
          itemId: 'semantic-4',
          localId: 'local-4',
          text: 'echo this channel input nowhere',
          origin: {
            v: 1,
            producer: 'pluginSession',
            actor: 'collaborator',
            sourceAuthority: {
              mediatorPluginId: 'happier.channels',
              sourceRef: 'channels:binding:binding-1',
              sourceRevisionOrEpoch: '4:7',
            },
          },
        },
        {
          kind: 'userText',
          sessionId: 'session-1',
          seq: 5,
          itemId: 'semantic-5',
          localId: 'local-5',
          text: 'a collaborator wrote this',
          origin: { v: 1, producer: 'pluginSession', actor: 'collaborator' },
        },
        {
          kind: 'assistantText',
          sessionId: 'session-1',
          seq: 6,
          itemId: 'semantic-6',
          turnId: 'turn-6',
          final: 'completed',
          text: 'do not echo the reply to its source binding',
          consumedInputs: [{
            localId: 'local-4',
            origin: {
              v: 1,
              producer: 'pluginSession',
              actor: 'collaborator',
              sourceAuthority: {
                mediatorPluginId: 'happier.channels',
                sourceRef: 'channels:binding:binding-1',
                sourceRevisionOrEpoch: '4:7',
              },
            },
          }],
        },
        {
          kind: 'assistantText',
          sessionId: 'session-1',
          seq: 7,
          itemId: 'semantic-7',
          turnId: 'turn-7',
          final: 'completed',
          text: 'mirror this final collaborator reply',
          consumedInputs: [{
            localId: 'local-5',
            origin: { v: 1, producer: 'pluginSession', actor: 'collaborator' },
          }],
        },
      ],
    });
    const deliveredItems: string[] = [];
    const signal = new AbortController().signal;

    const result = await projectConversationSessionTranscriptPage({
      actions: actionService,
      store,
      bindingId: 'binding-1',
      signal,
      deliver: async ({ item, source }) => {
        deliveredItems.push(item.itemId);
        expect(source).toEqual({
          kind: 'sessionProjection',
          sessionId: 'session-1',
          semanticItemId: item.itemId,
        });
        return delivered();
      },
    });

    expect(actionService.execute).toHaveBeenCalledWith(
      'session.transcript.get',
      {
        sessionId: 'session-1',
        projection: 'externalShareableV1',
        cursor: '3',
        limit: 100,
      },
      { signal },
    );
    expect(deliveredItems).toEqual(['semantic-5', 'semantic-7']);
    expect(store.updates).toEqual([{
      bindingId: 'binding-1',
      expectedBindingRevision: 7,
      frontierRowId: 'frontier-1',
      expectedFrontierRowRevision: 4,
      frontier: {
        targetSessionId: 'session-1',
        transcriptCursor: '7',
        lastScannedSeq: 7,
        revision: 5,
      },
    }]);
    expect(result).toEqual({ kind: 'advanced', hasMore: false, deliveredItemCount: 2 });
  });

  it('does not advance across a delivery that is not durably terminal', async () => {
    const store = new MemoryProjectionStore(binding(), frontier());
    const actionService = actions({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-1',
      scannedThroughSeq: 5,
      nextCursor: '5',
      hasMore: false,
      items: [
        {
          kind: 'userText',
          sessionId: 'session-1',
          seq: 4,
          itemId: 'semantic-4',
          localId: 'local-4',
          text: 'first',
          origin: { v: 1, producer: 'pluginSession', actor: 'collaborator' },
        },
        {
          kind: 'userText',
          sessionId: 'session-1',
          seq: 5,
          itemId: 'semantic-5',
          localId: 'local-5',
          text: 'must wait',
          origin: { v: 1, producer: 'pluginSession', actor: 'collaborator' },
        },
      ],
    });
    const deliver = vi.fn(async () => (
      { kind: 'notAttempted', reason: 'notDue' } as const
    ));

    await expect(projectConversationSessionTranscriptPage({
      actions: actionService,
      store,
      bindingId: 'binding-1',
      signal: new AbortController().signal,
      deliver,
    })).resolves.toEqual({ kind: 'blocked', reason: 'deliveryPending', semanticItemId: 'semantic-4' });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.updates).toEqual([]);
  });

  it('advances the frontier when deterministic delivery custody was already retired', async () => {
    const store = new MemoryProjectionStore(binding(), frontier());
    const actionService = actions({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-1',
      scannedThroughSeq: 4,
      nextCursor: '4',
      hasMore: false,
      items: [{
        kind: 'userText',
        sessionId: 'session-1',
        seq: 4,
        itemId: 'semantic-retired',
        localId: 'local-retired',
        text: 'already delivered inside the recovery window',
        origin: { v: 1, producer: 'pluginSession', actor: 'collaborator' },
      }],
    });

    await expect(projectConversationSessionTranscriptPage({
      actions: actionService,
      store,
      bindingId: 'binding-1',
      signal: new AbortController().signal,
      deliver: async () => ({ kind: 'retired' }),
    })).resolves.toEqual({ kind: 'advanced', hasMore: false, deliveredItemCount: 1 });
    expect(store.updates).toHaveLength(1);
  });

  it('reports an invalid canonical cursor as a history gap without inventing a replacement cursor', async () => {
    const store = new MemoryProjectionStore(binding(), frontier());
    const actionService = rejectingActions(new PluginError({
      code: 'invalid_cursor',
      message: 'invalid_cursor',
    }));

    await expect(projectConversationSessionTranscriptPage({
      actions: actionService,
      store,
      bindingId: 'binding-1',
      signal: new AbortController().signal,
      deliver: async () => delivered(),
    })).resolves.toEqual({ kind: 'historyGap', reason: 'cursorRejected', disposition: 'recorded' });

    expect(store.updates).toEqual([]);
  });

  it('prioritizes caller cancellation over a raced transcript cursor rejection', async () => {
    const store = new MemoryProjectionStore(binding(), frontier());
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      controller.abort();
      throw new PluginError({ code: 'invalid_cursor', message: 'invalid_cursor' });
    });

    await expect(projectConversationSessionTranscriptPage({
      actions: { execute } as unknown as ActionsService,
      store,
      bindingId: 'binding-1',
      signal: controller.signal,
      deliver: async () => delivered(),
    })).resolves.toEqual({ kind: 'unavailable', reason: 'cancelled' });

    expect(store.updates).toEqual([]);
  });
});

describe('Conversation Session projection no-history baseline', () => {
  it('walks only the public external-shareable projection to its stable tail without projecting existing items', async () => {
    const signal = new AbortController().signal;
    const execute = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-new',
        scannedThroughSeq: 100,
        nextCursor: '100',
        hasMore: true,
        items: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-new',
        scannedThroughSeq: 104,
        nextCursor: '104',
        hasMore: false,
        items: [],
      });

    await expect(readConversationSessionProjectionNoHistoryBaseline({
      actions: { execute } as unknown as ActionsService,
      sessionId: 'session-new',
      signal,
    })).resolves.toEqual({
      kind: 'ready',
      transcriptCursor: '104',
      lastScannedSeq: 104,
    });

    expect(execute).toHaveBeenNthCalledWith(
      1,
      'session.transcript.get',
      { sessionId: 'session-new', projection: 'externalShareableV1', cursor: null, limit: 100 },
      { signal },
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      'session.transcript.get',
      { sessionId: 'session-new', projection: 'externalShareableV1', cursor: '100', limit: 100 },
      { signal },
    );
  });

  it('refuses to retarget from a non-advancing page rather than inventing a cursor', async () => {
    const execute = vi.fn(async () => ({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-new',
      scannedThroughSeq: 100,
      hasMore: true,
      items: [],
    }));

    await expect(readConversationSessionProjectionNoHistoryBaseline({
      actions: { execute } as unknown as ActionsService,
      sessionId: 'session-new',
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'retry', reason: 'publicationBarrier' });
  });

  it('rejects a terminal page that regresses the public projection frontier', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-new',
        scannedThroughSeq: 100,
        nextCursor: '100',
        hasMore: true,
        items: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-new',
        scannedThroughSeq: 90,
        nextCursor: '90',
        hasMore: false,
        items: [],
      });

    await expect(readConversationSessionProjectionNoHistoryBaseline({
      actions: { execute } as unknown as ActionsService,
      sessionId: 'session-new',
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'historyGap', reason: 'projectionMismatch' });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('accepts an empty initial terminal page as the no-history baseline', async () => {
    const execute = vi.fn(async () => ({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-new',
      scannedThroughSeq: 0,
      hasMore: false,
      items: [],
    }));

    await expect(readConversationSessionProjectionNoHistoryBaseline({
      actions: { execute } as unknown as ActionsService,
      sessionId: 'session-new',
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'ready',
      transcriptCursor: null,
      lastScannedSeq: 0,
    });
  });
});

describe('Conversation Session projection retained frontier', () => {
  it('accepts one exact persisted history gap at the current transcript tail', async () => {
    const collection = new MemoryProjectionCollection();
    collection.rows.set('binding-1', persistedProjectionBindingRow());
    const frontierRow = createConversationSessionProjectionFrontierRow({
      bindingId: 'binding-1',
      targetSessionId: 'session-1',
      transcriptCursor: { kind: 'historyGap', reason: 'cursorRejected', reportedAt: 100 },
      lastScannedSeq: 8,
      revision: 5,
      now: 100,
    });
    collection.rows.set(frontierRow.id, {
      rowId: frontierRow.id,
      revision: 3,
      value: frontierRow,
    });
    const actionService = actions({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-1',
      scannedThroughSeq: 12,
      nextCursor: '12',
      hasMore: false,
      items: [],
    });

    await expect(acceptConversationSessionProjectionBaseline({
      actions: actionService,
      stateCollection: collection as never,
      bindingId: 'binding-1',
      expectedBindingRevision: 7,
      expectedFrontierRevision: 3,
      signal: new AbortController().signal,
      now: 200,
    })).resolves.toEqual({ bindingRevision: 7, frontierRevision: 4 });
    expect(collection.rows.get(frontierRow.id)?.value).toMatchObject({
      payload: { transcriptCursor: '12', lastScannedSeq: 12, revision: 6 },
    });
  });

  it('reads the canonical binding/frontier pair and advances only with its binding-revision guard', async () => {
    const collection = new MemoryProjectionCollection();
    collection.rows.set('binding-1', persistedProjectionBindingRow());
    const initialFrontier = createConversationSessionProjectionFrontierRow({
      bindingId: 'binding-1',
      targetSessionId: 'session-1',
      transcriptCursor: '3',
      lastScannedSeq: 3,
      revision: 4,
      now: 100,
    });
    collection.rows.set(initialFrontier.id, {
      rowId: initialFrontier.id,
      revision: 4,
      value: initialFrontier,
    });
    const store = createConversationSessionProjectionCollectionStore({
      stateCollection: collection as never,
      signal: new AbortController().signal,
    });

    const current = await store.read({
      bindingId: 'binding-1',
      signal: new AbortController().signal,
    });

    expect(current).toMatchObject({
      kind: 'ready',
      binding: {
        bindingId: 'binding-1',
        revision: 7,
        connectionId: 'connection-1',
        target: { sessionId: 'session-1', deliveryMode: 'mirrorSession' },
      },
      frontier: {
        targetSessionId: 'session-1',
        transcriptCursor: '3',
        lastScannedSeq: 3,
        revision: 4,
      },
      frontierRowId: initialFrontier.id,
      frontierRowRevision: 4,
    });
    if (current.kind !== 'ready') throw new Error('expected retained projection state');

    await expect(store.compareAndSwap({
      bindingId: 'binding-1',
      expectedBindingRevision: 7,
      frontierRowId: current.frontierRowId,
      expectedFrontierRowRevision: 4,
      frontier: {
        targetSessionId: 'session-1',
        transcriptCursor: '4',
        lastScannedSeq: 4,
        revision: 5,
      },
    })).resolves.toEqual({ kind: 'updated' });

    await expect(store.compareAndSwap({
      bindingId: 'binding-1',
      expectedBindingRevision: 6,
      frontierRowId: current.frontierRowId,
      expectedFrontierRowRevision: 5,
      frontier: {
        targetSessionId: 'session-1',
        transcriptCursor: '5',
        lastScannedSeq: 5,
        revision: 6,
      },
    })).resolves.toEqual({ kind: 'conflict' });
  });

  it('fails closed when the canonical binding or frontier row is malformed', async () => {
    const collection = new MemoryProjectionCollection();
    const canonicalBinding = persistedProjectionBindingRow({
      revision: 1,
      deliveryMode: 'repliesOnly',
    });
    collection.rows.set('binding-1', {
      ...canonicalBinding,
      value: {
        ...canonicalBinding.value,
        payload: {
          ...canonicalBinding.value.payload,
          senderFeedback: 'not-a-policy',
        },
      },
    });
    const store = createConversationSessionProjectionCollectionStore({
      stateCollection: collection as never,
      signal: new AbortController().signal,
    });

    await expect(store.read({
      bindingId: 'binding-1',
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'bindingUnavailable' });

    const validBinding = collection.rows.get('binding-1');
    if (validBinding === undefined) throw new Error('expected binding fixture');
    collection.rows.set('binding-1', {
      ...validBinding,
      value: {
        ...validBinding.value,
        payload: {
          ...(validBinding.value.payload as Readonly<Record<string, unknown>>),
          senderFeedback: 'off',
        },
      },
    });
    const frontier = createConversationSessionProjectionFrontierRow({
      bindingId: 'binding-1',
      targetSessionId: 'session-1',
      transcriptCursor: null,
      lastScannedSeq: 0,
      revision: 1,
      now: 100,
    });
    collection.rows.set(frontier.id, {
      rowId: frontier.id,
      revision: 1,
      value: { ...frontier, 'created-at': 'not-a-timestamp' },
    });

    await expect(store.read({
      bindingId: 'binding-1',
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'frontierUnavailable' });
  });
});

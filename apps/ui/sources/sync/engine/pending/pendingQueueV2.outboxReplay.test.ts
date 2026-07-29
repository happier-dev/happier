import { beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { scopedSessionLocalStateKey } from '@/sync/domains/state/sessionLocalStateKeys';
import { loadPendingOutboxForSession, removePendingOutboxMessage, savePendingOutboxMessage } from '@/sync/domains/state/pendingOutboxPersistence';
import {
  deletePendingMessageV2,
  enqueuePendingMessageV2,
  replayPersistedPendingOutboxForSession,
  restoreDiscardedPendingMessageV2,
  sendPendingDeliveryAsNewV2,
  retryPendingOutboxOperationV2,
  setPendingMessageSendState,
} from './pendingQueueV2';
import { buildSession, createPendingQueueEncryption, resetPendingQueueState } from './pendingQueueV2.testHelpers';

function currentPendingAck(
  kind: 'enqueue' | 'steer_if_active' = 'enqueue',
  pending: Record<string, unknown> = {},
): Response {
  return Response.json({
    pending,
    requestedAction: { v: 1, kind },
  });
}

describe('pendingQueueV2 requested-action replay', () => {
  const outboxScope = { serverId: 'server-1', accountId: 'account-1' } as const;

  beforeEach(() => resetPendingQueueState());

  function rewritePersistedRow(params: Readonly<{
    sessionId: string;
    localId: string;
    operation?: string;
    requestBody?: string;
    rawRecord?: unknown;
  }>): void {
    const seedId = `seed-${params.sessionId}`;
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'quarantine' }, meta: {} };
    savePendingOutboxMessage({
      sessionId: params.sessionId, localId: seedId, createdAt: 1, text: 'quarantine', rawRecord,
      request: { v: 1, body: JSON.stringify({ seedId, localId: seedId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
    }, outboxScope);
    const persistence = getPersistenceStorage();
    const key = scopedSessionLocalStateKey('session-pending-outbox-v1', outboxScope);
    const parsed = JSON.parse(persistence.getString(key)!) as Record<string, Array<Record<string, unknown>>>;
    const row = parsed[params.sessionId]![0]!;
    row.localId = params.localId;
    row.request = {
      v: 1,
      body: params.requestBody ?? JSON.stringify({ localId: params.localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }),
    };
    if (params.operation !== undefined) row.operation = params.operation;
    if ('rawRecord' in params) row.rawRecord = params.rawRecord;
    persistence.set(key, JSON.stringify(parsed));
  }

  it('write-aheads the explicit requested action and reuses that frozen body', async () => {
    const sessionId = 's_action_outbox';
    storage.getState().applySessions([buildSession({ sessionId })]);
    const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 3 });
    let firstBody = '';

    const result = await enqueuePendingMessageV2({
      sessionId,
      text: 'steer when active',
      encryption,
      outboxScope,
      serverWireMode: 'pending_input_v1',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      request: async (_path, init) => {
        firstBody = String(init?.body ?? '');
        throw new TypeError('Failed to fetch');
      },
    });

    expect(result.accepted).toBe(false);
    expect(JSON.parse(firstBody)).toMatchObject({ requestedAction: { v: 1, kind: 'steer_if_active' } });
    let replayBody = '';
    await retryPendingOutboxOperationV2({
      sessionId,
      localId: result.localId,
      outboxScope,
      serverWireMode: 'pending_input_v1',
      request: async (_path, init) => {
        replayBody = String(init?.body ?? '');
        return currentPendingAck('steer_if_active', { localId: result.localId });
      },
    });
    expect(replayBody).toBe(firstBody);
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
  });

  it('retains current-server custody when a successful response omits the requested-action proof', async () => {
    const sessionId = 's_current_ack_missing_action';
    const localId = 'current-ack-missing-action';
    storage.getState().applySessions([buildSession({
      sessionId,
      overrides: { encryptionMode: 'plain' },
    })]);

    await expect(enqueuePendingMessageV2({
      sessionId,
      localId,
      text: 'retain without proof',
      encryption: await createPendingQueueEncryption({ sessionId }),
      outboxScope,
      serverWireMode: 'pending_input_v1',
      requestedAction: { v: 1, kind: 'enqueue' },
      request: async () => Response.json({ pending: {} }),
    })).resolves.toEqual({ localId, accepted: false });
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([
      expect.objectContaining({ localId, operation: 'enqueue' }),
    ]);
  });

  it('retains current-server custody when a non-terminal acknowledgement names another local id', async () => {
    const sessionId = 's_current_ack_wrong_identity';
    const localId = 'current-ack-local';
    storage.getState().applySessions([buildSession({
      sessionId,
      overrides: { encryptionMode: 'plain' },
    })]);

    await expect(enqueuePendingMessageV2({
      sessionId,
      localId,
      text: 'retain wrong acknowledgement identity',
      encryption: await createPendingQueueEncryption({ sessionId }),
      outboxScope,
      serverWireMode: 'pending_input_v1',
      requestedAction: { v: 1, kind: 'enqueue' },
      request: async () => currentPendingAck('enqueue', { localId: 'different-local' }),
    })).resolves.toEqual({ localId, accepted: false });
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([
      expect.objectContaining({ localId, operation: 'enqueue' }),
    ]);
  });

  it('retains response-loss custody when a terminal response proves another local id', async () => {
    const sessionId = 's_current_terminal_wrong_identity';
    const localId = 'current-terminal-local';
    storage.getState().applySessions([buildSession({
      sessionId,
      overrides: { encryptionMode: 'plain' },
    })]);

    await expect(enqueuePendingMessageV2({
      sessionId,
      localId,
      text: 'retain exact terminal identity',
      encryption: await createPendingQueueEncryption({ sessionId }),
      outboxScope,
      serverWireMode: 'pending_input_v1',
      requestedAction: { v: 1, kind: 'enqueue' },
      request: async () => Response.json({
        terminal: true,
        requestedAction: { v: 1, kind: 'enqueue' },
        message: { id: 'message-1', seq: 4, localId: 'different-local' },
      }),
    })).resolves.toEqual({ localId, accepted: false });
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([
      expect.objectContaining({ localId, operation: 'enqueue' }),
    ]);
  });

  it('re-serializes a frozen canonical body for the released-server boundary', async () => {
    const sessionId = 's_legacy_omission';
    const localId = 'legacy-local';
    const legacyBody = JSON.stringify({
      localId,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'legacy' } } },
      messageRole: 'user',
    });
    savePendingOutboxMessage({
      sessionId,
      localId,
      createdAt: 1,
      text: 'legacy',
      rawRecord: { role: 'user', content: { type: 'text', text: 'legacy' } },
      request: { v: 1, body: legacyBody },
    }, outboxScope);

    let replayBody = '';
    await retryPendingOutboxOperationV2({
      sessionId,
      localId,
      outboxScope,
      serverWireMode: 'released_server_v0_2_1',
      request: async (_path, init) => {
        replayBody = String(init?.body ?? '');
        return Response.json({
          didWrite: true,
          pending: {
            localId,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'legacy' } } },
            status: 'queued',
            position: 0,
            createdAt: 1,
            updatedAt: 1,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: 'account-1',
          },
          pendingCount: 1,
          pendingVersion: 1,
        });
      },
    });

    expect(JSON.parse(replayBody)).toEqual({
      localId,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'legacy' } } },
    });
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
  });

  it('retains custody while indeterminate and re-resolves the frozen body on retry', async () => {
    const sessionId = 's_indeterminate_retry';
    storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
    const request = vi.fn(async (_path: string, init?: RequestInit) => currentPendingAck('enqueue', {
      localId: JSON.parse(String(init?.body ?? '{}')).localId,
    }));
    const result = await enqueuePendingMessageV2({
      sessionId,
      text: 'hold then send',
      encryption: await createPendingQueueEncryption({ sessionId, seedByte: 8 }),
      outboxScope,
      serverWireMode: 'indeterminate',
      request,
    });

    expect(result.accepted).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toHaveLength(1);

    await expect(retryPendingOutboxOperationV2({
      sessionId,
      localId: result.localId,
      outboxScope,
      serverWireMode: 'pending_input_v1',
      request,
    })).resolves.toEqual({ accepted: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
  });

  it.each([
    ['malformed object', {}],
    ['assistant record', { role: 'assistant', content: { type: 'text', text: 'assistant' }, meta: {} }],
  ] as const)(
    'replays the exact frozen request with a safe projection fallback for a %s auxiliary record',
    async (_caseName, rawRecord) => {
      const sessionId = `s_invalid_aux_${_caseName.replaceAll(' ', '_')}`;
      const localId = `invalid-aux-${_caseName.replaceAll(' ', '-')}`;
      rewritePersistedRow({ sessionId, localId, rawRecord });

      expect(replayPersistedPendingOutboxForSession(sessionId, outboxScope)).toEqual([localId]);
      expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([
        expect.objectContaining({
          localId,
          operation: 'enqueue',
        }),
      ]);
      expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
        expect.objectContaining({
          localId,
          rawRecord: { role: 'user', content: { type: 'text', text: 'quarantine' }, meta: {} },
        }),
      ]);
      const frozenBody = loadPendingOutboxForSession(sessionId, outboxScope)[0]!.request.body;
      const request = vi.fn(async (_path: string, init?: RequestInit) => {
        expect(init?.body).toBe(frozenBody);
        return currentPendingAck('enqueue', { localId });
      });
      await expect(retryPendingOutboxOperationV2({
        sessionId, localId, outboxScope, serverWireMode: 'pending_input_v1', request,
      })).resolves.toEqual({ accepted: true });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves deterministic send-as-new identity with the server across response uncertainty', async () => {
    const sessionId = 's_send_as_new_response_loss';
    const localId = 'uncertain-original';
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'uncertain' }, meta: {} };
    storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
    storage.getState().upsertPendingMessage(sessionId, {
      id: localId, localId, createdAt: 1, updatedAt: 1, source: 'server_pending',
      deliveryStatus: 'accepted', pendingDeliveryStatus: 'blocked',
      pendingDeliveryBlockedReason: 'delivery_outcome_uncertain', text: 'uncertain', rawRecord,
    });
    const bodies: unknown[] = [];
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: 'response-lost' }), { status: 503 });
    });
    const params = {
      sessionId,
      pendingId: localId,
      encryption: await createPendingQueueEncryption({ sessionId }),
      outboxScope,
      request,
    };

    await expect(sendPendingDeliveryAsNewV2(params)).rejects.toThrow();
    await expect(sendPendingDeliveryAsNewV2(params)).rejects.toThrow();

    expect(bodies).toEqual([{}, {}]);
  });

  it('returns the server-owned send-as-new identity after refreshing pending state', async () => {
    const sessionId = 's_send_as_new_server_identity';
    const localId = 'uncertain-original';
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'uncertain' }, meta: {} };
    storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
    storage.getState().upsertPendingMessage(sessionId, {
      id: localId, localId, createdAt: 1, updatedAt: 1, source: 'server_pending',
      deliveryStatus: 'accepted', pendingDeliveryStatus: 'blocked',
      pendingDeliveryBlockedReason: 'delivery_outcome_uncertain', text: 'uncertain', rawRecord,
    });
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/delivery/send-as-new')) {
        expect(JSON.parse(String(init?.body))).toEqual({});
        return Response.json({ newLocalId: 'server-owned-replacement' });
      }
      if (path.endsWith('/pending?includeDiscarded=1')) {
        return Response.json({ pending: [] });
      }
      return new Response(null, { status: 404 });
    });

    await expect(sendPendingDeliveryAsNewV2({
      sessionId,
      pendingId: localId,
      encryption: await createPendingQueueEncryption({ sessionId }),
      outboxScope,
      request,
      isOutboxScopeCurrent: () => true,
    })).resolves.toBe('server-owned-replacement');
  });

  it('establishes visible external-handoff custody from a frozen row before a cold rejoin can settle', async () => {
    const sessionId = 's_invalid_aux_external_cold_rejoin';
    const localId = 'invalid-aux-external-cold-rejoin';
    const frozenRawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'frozen external' }, meta: {} };
    const frozenBody = JSON.stringify({
      localId,
      content: { t: 'plain', v: frozenRawRecord },
      messageRole: 'user',
      deliveryMode: 'external_handoff',
    });
    storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
    rewritePersistedRow({ sessionId, localId, requestBody: frozenBody, rawRecord: {} });

    let postStarted!: () => void;
    const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
    const methods: string[] = [];
    const request = async (_path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'POST') {
        expect(init?.body).toBe(frozenBody);
        postStarted();
        await postGate;
        return currentPendingAck('enqueue', { localId, deliveryStatus: { status: 'external_handoff' } });
      }
      return new Response(null, { status: 204 });
    };

    const rejoin = enqueuePendingMessageV2({
      sessionId,
      localId,
      text: 'caller text must not replace frozen custody',
      encryption: await createPendingQueueEncryption({ sessionId }),
      outboxScope,
      serverWireMode: 'pending_input_v1',
      request,
    });
    await postStartedGate;
    expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
      expect.objectContaining({
        localId,
        source: 'local_outbound',
        deliveryStatus: 'queued',
        text: 'frozen external',
        rawRecord: frozenRawRecord,
      }),
    ]);

    const deletion = deletePendingMessageV2({ sessionId, pendingId: localId, outboxScope, request });
    releasePost();
    await expect(rejoin).resolves.toMatchObject({ accepted: true, cancelled: true });
    await expect(deletion).resolves.toBeUndefined();

    expect(methods).toEqual(['POST', 'DELETE']);
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
    expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
      expect.objectContaining({
        localId,
        source: 'server_pending',
        deliveryStatus: 'accepted',
        pendingDeliveryStatus: 'external_handoff',
        text: 'frozen external',
      }),
    ]);
  });

  it('allocates a collision-safe diagnostic during quarantined direct rejoin', async () => {
    const sessionId = 's_quarantine_direct_rejoin_projection_collision';
    const localId = 'quarantine-direct-rejoin';
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'quarantined' }, meta: {} };
    storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
    savePendingOutboxMessage({
      sessionId, localId, createdAt: 1, text: 'quarantined', rawRecord,
      operation: 'future-operation' as never,
      request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
    }, outboxScope);
    replayPersistedPendingOutboxForSession(sessionId, outboxScope);
    const baseDiagnosticId = storage.getState().sessionPending[sessionId]?.messages[0]!.id;
    storage.getState().removePendingMessage(sessionId, baseDiagnosticId);
    storage.getState().upsertPendingMessage(sessionId, {
      id: baseDiagnosticId, localId: 'canonical-server-local', createdAt: 2, updatedAt: 2,
      source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
      text: 'canonical server', rawRecord,
    });
    let requestCount = 0;

    await expect(enqueuePendingMessageV2({
      sessionId, localId, text: 'must stay quarantined',
      encryption: await createPendingQueueEncryption({ sessionId }), outboxScope,
      serverWireMode: 'pending_input_v1',
      request: async () => {
        requestCount += 1;
        return Response.json({ pending: {} });
      },
    })).rejects.toThrow('Persisted pending outbox row is quarantined');

    expect(requestCount).toBe(0);
    expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
      expect.objectContaining({ id: baseDiagnosticId, source: 'server_pending', text: 'canonical server' }),
      expect.objectContaining({
        id: expect.not.stringMatching(new RegExp(`^${baseDiagnosticId}$`)),
        localId,
        source: 'local_outbound',
        pendingDeliveryStatus: 'blocked',
      }),
    ]);
  });

  it('creates current-scope cold-rejoin custody when another scope has a same-id server row', async () => {
    const sessionId = 's_cold_rejoin_other_scope_server';
    const localId = 'cold-rejoin-other-scope-server';
    const scopeA = outboxScope;
    const scopeB = { serverId: 'server-2', accountId: 'account-2' } as const;
    const frozenRawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'scope A frozen' }, meta: {} };
    const frozenBody = JSON.stringify({ localId, content: { t: 'plain', v: frozenRawRecord }, messageRole: 'user' });
    storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
    rewritePersistedRow({ sessionId, localId, requestBody: frozenBody, rawRecord: {} });
    storage.getState().upsertPendingMessage(sessionId, {
      id: localId, localId, createdAt: 2, updatedAt: 2,
      source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: scopeB,
      text: 'scope B canonical', rawRecord: frozenRawRecord,
    });
    let postStarted!: () => void;
    const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
    const request = async (_path: string, init?: RequestInit) => {
      expect(init?.body).toBe(frozenBody);
      postStarted();
      await postGate;
      return currentPendingAck('enqueue', { localId });
    };

    const rejoin = enqueuePendingMessageV2({
      sessionId, localId, text: 'scope A caller text',
      encryption: await createPendingQueueEncryption({ sessionId }), outboxScope: scopeA,
      serverWireMode: 'pending_input_v1', request,
    });
    await postStartedGate;

    expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
      expect.objectContaining({ id: localId, source: 'server_pending', pendingOutboxScope: scopeB }),
      expect.objectContaining({
        id: expect.not.stringMatching(new RegExp(`^${localId}$`)),
        localId,
        source: 'local_outbound',
        pendingOutboxScope: scopeA,
        deliveryStatus: 'queued',
      }),
    ]);
    releasePost();
    await expect(rejoin).resolves.toMatchObject({ accepted: true });
    expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
      expect.objectContaining({ id: localId, source: 'server_pending', pendingOutboxScope: scopeB }),
    ]);
  });

  it('replays normal custody without overwriting a same-id projection from another scope', () => {
    const sessionId = 's_replay_normal_cross_scope_collision';
    const localId = 'replay-normal-cross-scope';
    const scopeB = { serverId: 'server-2', accountId: 'account-2' } as const;
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'scope A' }, meta: {} };
    savePendingOutboxMessage({
      sessionId, localId, createdAt: 1, text: 'scope A', rawRecord,
      request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
    }, outboxScope);
    storage.getState().upsertPendingMessage(sessionId, {
      id: localId, localId, createdAt: 2, updatedAt: 2,
      source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: scopeB,
      text: 'scope B canonical', rawRecord,
    });

    expect(replayPersistedPendingOutboxForSession(sessionId, outboxScope)).toEqual([localId]);
    expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
      expect.objectContaining({ id: localId, source: 'server_pending', pendingOutboxScope: scopeB }),
      expect.objectContaining({
        id: expect.not.stringMatching(new RegExp(`^${localId}$`)),
        localId,
        source: 'local_outbound',
        pendingOutboxScope: outboxScope,
      }),
    ]);
  });

  it('does not auto-rearm failed same-scope custody on replay but permits explicit retry', async () => {
    const sessionId = 's_outbox_failed_replay';
    const localId = 'failed-replay-1';
    const rawRecord = {
      role: 'user' as const,
      content: { type: 'text' as const, text: 'retry only when asked' },
      meta: {},
    };
    savePendingOutboxMessage({
      sessionId,
      localId,
      createdAt: 42,
      text: 'retry only when asked',
      rawRecord,
      request: {
        v: 1,
        body: JSON.stringify({
          localId,
          content: { t: 'plain', v: rawRecord },
          messageRole: 'user',
        }),
      },
    }, outboxScope);

    expect(replayPersistedPendingOutboxForSession(sessionId, outboxScope)).toEqual([localId]);
    setPendingMessageSendState(sessionId, localId, 'failed', outboxScope);

    expect(replayPersistedPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
    expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
      expect.objectContaining({ localId, sendState: 'failed', pendingOutboxScope: outboxScope }),
    ]);

    setPendingMessageSendState(sessionId, localId, 'unconfirmed', outboxScope);
    const requests: string[] = [];
    await expect(retryPendingOutboxOperationV2({
      sessionId,
      localId,
      outboxScope,
      serverWireMode: 'pending_input_v1',
      request: async (path) => {
        requests.push(path);
        return currentPendingAck('enqueue', { localId });
      },
    })).resolves.toEqual({ accepted: true });

    expect(requests).toEqual([`/v2/sessions/${sessionId}/pending`]);
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
  });

  it.each(['pending', 'discarded'] as const)(
    'allocates a brand-new direct projection without colliding with a canonical %s ID',
    async (collection) => {
      const sessionId = `s_new_projection_${collection}_collision`;
      const localId = `new-projection-${collection}-collision`;
      const scopeB = { serverId: 'server-2', accountId: 'account-2' } as const;
      const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'canonical' }, meta: {} };
      storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
      if (collection === 'pending') {
        storage.getState().upsertPendingMessage(sessionId, {
          id: localId, localId, createdAt: 1, updatedAt: 1,
          source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: scopeB,
          text: 'canonical pending', rawRecord,
        });
      } else {
        storage.getState().applyPendingSnapshot(sessionId, {
          messages: [],
          discarded: [{
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: scopeB,
            text: 'canonical discarded', rawRecord, discardedAt: 2, discardedReason: 'manual',
          }],
        });
      }
      let postStarted!: () => void;
      const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
      let releasePost!: () => void;
      const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
      const enqueue = enqueuePendingMessageV2({
        sessionId, localId, text: 'new scope A',
        encryption: await createPendingQueueEncryption({ sessionId }), outboxScope,
        serverWireMode: 'pending_input_v1',
        request: async () => {
          postStarted();
          await postGate;
          return currentPendingAck('enqueue', { localId });
        },
      });
      await postStartedGate;

      const localProjection = storage.getState().sessionPending[sessionId]?.messages.find((message) =>
        message.localId === localId && message.pendingOutboxScope?.accountId === outboxScope.accountId);
      expect(localProjection).toMatchObject({ source: 'local_outbound', deliveryStatus: 'queued' });
      expect(localProjection?.id).not.toBe(localId);
      if (collection === 'pending') {
        expect(storage.getState().sessionPending[sessionId]?.messages).toContainEqual(expect.objectContaining({
          id: localId, source: 'server_pending', pendingOutboxScope: scopeB,
        }));
      } else {
        expect(storage.getState().sessionPending[sessionId]?.discarded).toContainEqual(expect.objectContaining({
          id: localId, source: 'server_pending', pendingOutboxScope: scopeB,
        }));
      }
      releasePost();
      await expect(enqueue).resolves.toMatchObject({ accepted: true });
    },
  );

  it.each(['replay', 'direct rejoin'] as const)(
    'keeps discarded mutation transportable across a quarantined diagnostic ID collision during %s',
    async (operation) => {
      const sessionId = `s_discarded_quarantine_collision_${operation.replace(' ', '_')}`;
      const localId = `discarded-quarantine-${operation.replace(' ', '-')}`;
      const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'quarantined' }, meta: {} };
      storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
      savePendingOutboxMessage({
        sessionId, localId, createdAt: 1, text: 'quarantined', rawRecord,
        operation: 'future-operation' as never,
        request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
      }, outboxScope);
      replayPersistedPendingOutboxForSession(sessionId, outboxScope);
      const baseDiagnosticId = storage.getState().sessionPending[sessionId]?.messages[0]!.id;
      storage.getState().applyPendingSnapshot(sessionId, {
        messages: [],
        discarded: [{
          id: baseDiagnosticId, localId: baseDiagnosticId, createdAt: 2, updatedAt: 2,
          source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
          text: 'canonical discarded', rawRecord, discardedAt: 3, discardedReason: 'manual',
        }],
      });

      if (operation === 'replay') {
        expect(replayPersistedPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
      } else {
        await expect(enqueuePendingMessageV2({
          sessionId, localId, text: 'still quarantined',
          encryption: await createPendingQueueEncryption({ sessionId }), outboxScope,
          serverWireMode: 'pending_input_v1', request: async () => Response.json({ pending: {} }),
        })).rejects.toThrow('Persisted pending outbox row is quarantined');
      }
      expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
        expect.objectContaining({
          id: expect.not.stringMatching(new RegExp(`^${baseDiagnosticId}$`)),
          localId,
          pendingDeliveryStatus: 'blocked',
        }),
      ]);
      expect(storage.getState().sessionPending[sessionId]?.discarded).toEqual([
        expect.objectContaining({ id: baseDiagnosticId, text: 'canonical discarded' }),
      ]);
      let requestCount = 0;
      await expect(restoreDiscardedPendingMessageV2({
        sessionId, pendingId: baseDiagnosticId,
        encryption: await createPendingQueueEncryption({ sessionId }), outboxScope,
        request: async (_path, init) => {
          requestCount += 1;
          return init?.method === 'POST'
            ? new Response(null, { status: 204 })
            : Response.json({ pending: [] });
        },
      })).resolves.toBeUndefined();
      expect(requestCount).toBe(2);
    },
  );

  it.each([undefined, 'external_handoff'] as const)(
    'treats a queued retry whose row settled concurrently as a no-op (%s)',
    async (pendingDeliveryStatus) => {
      const sessionId = `s_retry_settled_${pendingDeliveryStatus ?? 'ordinary'}`;
      const localId = 'settled-local';
      const blockerId = 'blocking-local';
      const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'settled' }, meta: {} };
      storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
      savePendingOutboxMessage({
        sessionId, localId, createdAt: 1, text: 'settled', rawRecord,
        request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
      }, outboxScope);
      storage.getState().upsertPendingMessage(sessionId, {
        id: localId, localId, createdAt: 1, updatedAt: 1, source: 'local_outbound',
        deliveryStatus: 'queued', sendState: 'unconfirmed', text: 'settled', rawRecord,
        pendingOutboxScope: outboxScope, pendingOutboxOperation: 'enqueue',
      });
      let blockerStarted!: () => void;
      const blockerStartedGate = new Promise<void>((resolve) => { blockerStarted = resolve; });
      let releaseBlocker!: () => void;
      const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
      const blocker = enqueuePendingMessageV2({
        sessionId, localId: blockerId, text: 'block',
        encryption: await createPendingQueueEncryption({ sessionId }), outboxScope,
        serverWireMode: 'pending_input_v1',
        request: async () => {
          blockerStarted();
          await blockerGate;
          return currentPendingAck('enqueue', { localId: blockerId });
        },
      });
      await blockerStartedGate;
      const retry = retryPendingOutboxOperationV2({
        sessionId, localId, outboxScope, serverWireMode: 'pending_input_v1',
        request: async () => { throw new Error('settled retry must not request'); },
      });
      removePendingOutboxMessage(sessionId, localId, outboxScope);
      const current = storage.getState().sessionPending[sessionId]?.messages.find((message) => message.localId === localId)!;
      storage.getState().upsertPendingMessage(sessionId, {
        ...current,
        deliveryStatus: 'accepted',
        pendingDeliveryStatus,
        pendingOutboxOperation: undefined,
        sendState: undefined,
      });
      releaseBlocker();

      await blocker;
      await expect(retry).resolves.toEqual({ accepted: true });
      expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
        expect.objectContaining({ localId: blockerId }),
      ]);
    },
  );

  it('retires an ordinary unscoped canonical row after confirmed cancellation without crossing custody boundaries', async () => {
    const sessionId = 's_cancel_unscoped_canonical_boundaries';
    const localId = 'cancel-unscoped-canonical';
    const otherScope = { serverId: 'server-2', accountId: 'account-2' } as const;
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'cancel' }, meta: {} };
    savePendingOutboxMessage({
      sessionId, localId, createdAt: 1, text: 'cancel', rawRecord, operation: 'cancel',
      request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
    }, outboxScope);
    storage.getState().upsertPendingMessage(sessionId, {
      id: 'ordinary-unscoped', localId, createdAt: 1, updatedAt: 1,
      source: 'server_pending', deliveryStatus: 'accepted', text: 'ordinary', rawRecord,
    });
    storage.getState().upsertPendingMessage(sessionId, {
      id: 'external-unscoped', localId, createdAt: 2, updatedAt: 2,
      source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'external_handoff',
      text: 'external', rawRecord,
    });
    storage.getState().upsertPendingMessage(sessionId, {
      id: 'quarantine-boundary', localId, createdAt: 3, updatedAt: 3,
      source: 'local_outbound', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
      pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'unknown',
      pendingDeliveryBlockedReasonRaw: 'unsupported_persisted_operation', text: 'diagnostic', rawRecord,
    });
    storage.getState().upsertPendingMessage(sessionId, {
      id: 'other-scope-boundary', localId, createdAt: 4, updatedAt: 4,
      source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: otherScope,
      text: 'other scope', rawRecord,
    });

    await expect(retryPendingOutboxOperationV2({
      sessionId, localId, outboxScope, serverWireMode: 'pending_input_v1',
      request: async () => new Response(null, { status: 204 }),
    })).resolves.toEqual({ accepted: true });

    expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.id)).toEqual([
      'external-unscoped',
      'quarantine-boundary',
      'other-scope-boundary',
    ]);
  });

  it('cleans only exact-scope local projections when a queued retry row vanished', async () => {
    const sessionId = 's_retry_settled_projection_cleanup';
    const localId = 'retry-settled-cleanup';
    const blockerId = 'retry-settled-blocker';
    const otherScope = { serverId: 'server-2', accountId: 'account-2' } as const;
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'settled' }, meta: {} };
    storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
    savePendingOutboxMessage({
      sessionId, localId, createdAt: 1, text: 'settled', rawRecord,
      request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
    }, outboxScope);
    storage.getState().upsertPendingMessage(sessionId, {
      id: localId, localId, createdAt: 1, updatedAt: 1,
      source: 'local_outbound', deliveryStatus: 'queued', pendingOutboxScope: outboxScope,
      pendingOutboxOperation: 'enqueue', sendState: 'unconfirmed', text: 'settled', rawRecord,
    });
    let blockerStarted!: () => void;
    const blockerStartedGate = new Promise<void>((resolve) => { blockerStarted = resolve; });
    let releaseBlocker!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blocker = enqueuePendingMessageV2({
      sessionId, localId: blockerId, text: 'block',
      encryption: await createPendingQueueEncryption({ sessionId }), outboxScope,
      serverWireMode: 'pending_input_v1',
      request: async () => {
        blockerStarted();
        await blockerGate;
        return currentPendingAck('enqueue', { localId: blockerId });
      },
    });
    await blockerStartedGate;
    const retryRequest = vi.fn(async () => currentPendingAck('enqueue', { localId }));
    const retry = retryPendingOutboxOperationV2({
      sessionId, localId, outboxScope, serverWireMode: 'pending_input_v1', request: retryRequest,
    });
    removePendingOutboxMessage(sessionId, localId, outboxScope);
    storage.getState().upsertPendingMessage(sessionId, {
      id: 'canonical-server', localId, createdAt: 2, updatedAt: 2,
      source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
      text: 'canonical server', rawRecord,
    });
    storage.getState().upsertPendingMessage(sessionId, {
      id: 'quarantine-diagnostic', localId, createdAt: 3, updatedAt: 3,
      source: 'local_outbound', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
      pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'unknown',
      pendingDeliveryBlockedReasonRaw: 'unsupported_persisted_operation', text: 'diagnostic', rawRecord,
    });
    storage.getState().upsertPendingMessage(sessionId, {
      id: 'other-scope', localId, createdAt: 4, updatedAt: 4,
      source: 'local_outbound', deliveryStatus: 'queued', pendingOutboxScope: otherScope,
      pendingOutboxOperation: 'enqueue', text: 'other scope', rawRecord,
    });
    releaseBlocker();

    await blocker;
    await expect(retry).resolves.toEqual({ accepted: true });
    expect(retryRequest).not.toHaveBeenCalled();
    expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.id)).toEqual([
      blockerId,
      'canonical-server',
      'quarantine-diagnostic',
      'other-scope',
    ]);
  });

  it('treats a queued direct rejoin whose captured row settled concurrently as a no-op', async () => {
    const sessionId = 's_direct_rejoin_settled';
    const localId = 'settled-direct';
    const blockerId = 'blocking-direct';
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'settled' }, meta: {} };
    storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
    savePendingOutboxMessage({
      sessionId, localId, createdAt: 1, text: 'settled', rawRecord,
      request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
    }, outboxScope);
    storage.getState().upsertPendingMessage(sessionId, {
      id: localId, localId, createdAt: 1, updatedAt: 1, source: 'local_outbound',
      deliveryStatus: 'queued', sendState: 'unconfirmed', text: 'settled', rawRecord,
      pendingOutboxScope: outboxScope, pendingOutboxOperation: 'enqueue',
    });
    let blockerStarted!: () => void;
    const blockerStartedGate = new Promise<void>((resolve) => { blockerStarted = resolve; });
    let releaseBlocker!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blocker = enqueuePendingMessageV2({
      sessionId, localId: blockerId, text: 'block',
      encryption: await createPendingQueueEncryption({ sessionId }), outboxScope,
      serverWireMode: 'pending_input_v1',
      request: async () => {
        blockerStarted();
        await blockerGate;
        return currentPendingAck('enqueue', { localId: blockerId });
      },
    });
    await blockerStartedGate;
    const request = vi.fn(async () => currentPendingAck('enqueue', { localId }));
    const rejoin = enqueuePendingMessageV2({
      sessionId, localId, text: 'must not replay captured custody',
      encryption: await createPendingQueueEncryption({ sessionId }), outboxScope,
      serverWireMode: 'pending_input_v1', request,
    });
    removePendingOutboxMessage(sessionId, localId, outboxScope);
    const current = storage.getState().sessionPending[sessionId]?.messages.find((message) => message.localId === localId)!;
    storage.getState().upsertPendingMessage(sessionId, {
      ...current, source: 'server_pending', deliveryStatus: 'accepted',
      pendingOutboxOperation: undefined, pendingOutboxScope: undefined, sendState: undefined,
    });
    releaseBlocker();

    await blocker;
    await expect(rejoin).resolves.toEqual({ localId, accepted: true, settled: true });
    expect(request).not.toHaveBeenCalled();
    expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
      expect.objectContaining({ localId, source: 'server_pending', deliveryStatus: 'accepted' }),
      expect.objectContaining({ localId: blockerId }),
    ]);
  });

  it('retires an exact-scope local projection when queued direct rejoin custody vanished', async () => {
    const sessionId = 's_direct_rejoin_vanished_local_custody';
    const localId = 'vanished-direct-local';
    const blockerId = 'blocking-vanished-direct';
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'vanished' }, meta: {} };
    storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
    savePendingOutboxMessage({
      sessionId, localId, createdAt: 1, text: 'vanished', rawRecord,
      request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
    }, outboxScope);
    storage.getState().upsertPendingMessage(sessionId, {
      id: localId, localId, createdAt: 1, updatedAt: 1, source: 'local_outbound',
      deliveryStatus: 'queued', sendState: 'unconfirmed', text: 'vanished', rawRecord,
      pendingOutboxScope: outboxScope, pendingOutboxOperation: 'enqueue',
    });
    let blockerStarted!: () => void;
    const blockerStartedGate = new Promise<void>((resolve) => { blockerStarted = resolve; });
    let releaseBlocker!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blocker = enqueuePendingMessageV2({
      sessionId, localId: blockerId, text: 'block',
      encryption: await createPendingQueueEncryption({ sessionId }), outboxScope,
      serverWireMode: 'pending_input_v1',
      request: async () => {
        blockerStarted();
        await blockerGate;
        return currentPendingAck('enqueue', { localId: blockerId });
      },
    });
    await blockerStartedGate;
    const request = vi.fn(async () => currentPendingAck('enqueue', { localId }));
    const rejoin = enqueuePendingMessageV2({
      sessionId, localId, text: 'must not resurrect vanished custody',
      encryption: await createPendingQueueEncryption({ sessionId }), outboxScope,
      serverWireMode: 'pending_input_v1', request,
    });
    removePendingOutboxMessage(sessionId, localId, outboxScope);
    releaseBlocker();

    await blocker;
    await expect(rejoin).resolves.toEqual({ localId, accepted: true, settled: true });
    expect(request).not.toHaveBeenCalled();
    expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
      expect.objectContaining({ localId: blockerId }),
    ]);
  });

  it.each(['direct rejoin', 'retry'] as const)(
    'keeps explicit unsupported persisted requested action in custody and never transports it during %s',
    async (operation) => {
      const sessionId = `s_unsupported_action_${operation.replace(' ', '_')}`;
      const localId = `unsupported-${operation.replace(' ', '-')}`;
      const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'unsupported' }, meta: {} };
      storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
      savePendingOutboxMessage({
        sessionId, localId, createdAt: 1, text: 'unsupported', rawRecord,
        request: { v: 1, body: JSON.stringify({
          localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user',
          requestedAction: { v: 999, kind: 'future_action' },
        }) },
      }, outboxScope);
      storage.getState().upsertPendingMessage(sessionId, {
        id: localId, localId, createdAt: 1, updatedAt: 1, source: 'local_outbound',
        deliveryStatus: 'queued', sendState: 'unconfirmed', text: 'unsupported', rawRecord,
        pendingOutboxScope: outboxScope, pendingOutboxOperation: 'enqueue',
        pendingRequestedActionMalformed: true,
      });
      const request = vi.fn(async () => Response.json({ pending: {} }));
      const result = operation === 'direct rejoin'
        ? enqueuePendingMessageV2({
          sessionId, localId, text: 'ignored', encryption: await createPendingQueueEncryption({ sessionId }),
          outboxScope, serverWireMode: 'pending_input_v1', request,
        })
        : retryPendingOutboxOperationV2({ sessionId, localId, outboxScope, serverWireMode: 'pending_input_v1', request });

      await expect(result).rejects.toThrow('Persisted pending requested action is unsupported');
      expect(request).not.toHaveBeenCalled();
      expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([
        expect.objectContaining({ localId, operation: 'enqueue' }),
      ]);
      expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
        expect.objectContaining({ localId, pendingRequestedActionMalformed: true }),
      ]);
    },
  );

  it.each(['.', '..'])('rejects replay retry dot segment %j before transport', async (localId) => {
    const request = vi.fn(async () => Response.json({ pending: {} }));
    await expect(retryPendingOutboxOperationV2({
      sessionId: 's_dot_retry', localId, outboxScope, serverWireMode: 'pending_input_v1', request,
    })).rejects.toThrow('Pending message ID is invalid');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported-operation', 'future-operation', 'unsupported_persisted_operation'],
    ['.', undefined, 'invalid_persisted_local_id'],
  ] as const)(
    'projects quarantined persisted custody for %s without scheduling or allowing transport',
    async (localId, operation, quarantineReason) => {
      const sessionId = `s_quarantine_${quarantineReason}`;
      rewritePersistedRow({ sessionId, localId, operation });

      expect(replayPersistedPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
      expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
        expect.objectContaining({
          localId,
          deliveryStatus: 'accepted',
          pendingDeliveryStatus: 'blocked',
          pendingDeliveryBlockedReasonRaw: quarantineReason,
          pendingOutboxScope: outboxScope,
        }),
      ]);
      const quarantineProjectionId = storage.getState().sessionPending[sessionId]?.messages[0]?.id;
      expect(quarantineProjectionId).toMatch(/^pending-outbox-quarantine:/);
      const request = vi.fn(async () => Response.json({ pending: [] }));
      await expect(retryPendingOutboxOperationV2({
        sessionId, localId, outboxScope, serverWireMode: 'pending_input_v1', request,
      })).rejects.toThrow(localId === '.' ? 'Pending message ID is invalid' : 'Persisted pending outbox row is quarantined');
      expect(request).not.toHaveBeenCalled();
      if (localId !== '.') {
        await expect(sendPendingDeliveryAsNewV2({
          sessionId,
          pendingId: localId,
          encryption: await createPendingQueueEncryption({ sessionId }),
          outboxScope,
          request,
        })).rejects.toThrow('Persisted pending outbox row is quarantined');
        expect(request).not.toHaveBeenCalled();
      }
      await expect(sendPendingDeliveryAsNewV2({
        sessionId,
        pendingId: quarantineProjectionId!,
        encryption: await createPendingQueueEncryption({ sessionId }),
        outboxScope,
        request,
      })).rejects.toThrow('Persisted pending outbox row is quarantined');
      expect(request).not.toHaveBeenCalled();
      expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([
        expect.objectContaining({ localId, operation: 'quarantined', quarantineReason }),
      ]);
    },
  );

  it('projects a malformed persisted envelope as durable terminal quarantine', async () => {
    const sessionId = 's_quarantine_invalid_envelope';
    const localId = 'invalid-envelope';
    rewritePersistedRow({ sessionId, localId, requestBody: '{' });

    expect(replayPersistedPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([
      expect.objectContaining({
        localId,
        operation: 'quarantined',
        quarantineReason: 'invalid_persisted_envelope',
      }),
    ]);
    expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
      expect.objectContaining({
        localId,
        deliveryStatus: 'accepted',
        pendingDeliveryStatus: 'blocked',
        pendingDeliveryBlockedReasonRaw: 'invalid_persisted_envelope',
      }),
    ]);
  });

  it('rejects an object-shaped but unsupported plain content envelope at the persistence owner', () => {
    const sessionId = 's_invalid_plain_content_envelope';
    const localId = 'invalid-plain-content';
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'invalid' }, meta: {} };

    expect(() => savePendingOutboxMessage({
      sessionId,
      localId,
      createdAt: 1,
      text: 'invalid',
      rawRecord,
      request: {
        v: 1,
        body: JSON.stringify({ localId, content: {}, messageRole: 'user' }),
      },
    }, outboxScope)).toThrow('Pending outbox request envelope is invalid');
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
  });

  it('rejects malformed content alongside ciphertext instead of treating it as encrypted-only', () => {
    const sessionId = 's_invalid_mixed_content_envelope';
    const localId = 'invalid-mixed-content';
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'invalid' }, meta: {} };

    expect(() => savePendingOutboxMessage({
      sessionId,
      localId,
      createdAt: 1,
      text: 'invalid',
      rawRecord,
      request: {
        v: 1,
        body: JSON.stringify({ localId, ciphertext: 'ciphertext', content: {}, messageRole: 'user' }),
      },
    }, outboxScope)).toThrow('Pending outbox request envelope is invalid');
  });

  it('preserves an identifiable persisted row with missing auxiliary rawRecord for exact replay', () => {
    const sessionId = 's_quarantine_missing_raw_record';
    const localId = 'missing-raw-record';
    rewritePersistedRow({ sessionId, localId, rawRecord: null });

    expect(replayPersistedPendingOutboxForSession(sessionId, outboxScope)).toEqual([localId]);
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([
      expect.objectContaining({
        localId,
        operation: 'enqueue',
        rawRecord: null,
      }),
    ]);
    expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
      expect.objectContaining({
        localId,
        text: 'quarantine',
        rawRecord: { role: 'user', content: { type: 'text', text: 'quarantine' }, meta: {} },
      }),
    ]);
  });

  it.each([
    ['missing createdAt', { createdAt: undefined }],
    ['invalid createdAt', { createdAt: 'yesterday' }],
    ['missing text', { text: undefined }],
    ['invalid text', { text: 42 }],
  ] as const)('preserves stable identity with %s using safe replay fallbacks', (_caseName, patch) => {
    const sessionId = `s_quarantine_${_caseName.replaceAll(' ', '_')}`;
    const localId = `stable-${_caseName.replaceAll(' ', '-')}`;
    rewritePersistedRow({ sessionId, localId });
    const persistence = getPersistenceStorage();
    const key = scopedSessionLocalStateKey('session-pending-outbox-v1', outboxScope);
    const parsed = JSON.parse(persistence.getString(key)!) as Record<string, Array<Record<string, unknown>>>;
    Object.assign(parsed[sessionId]![0]!, patch);
    persistence.set(key, JSON.stringify(parsed));

    expect(replayPersistedPendingOutboxForSession(sessionId, outboxScope)).toEqual([localId]);
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([
      expect.objectContaining({
        localId,
        createdAt: _caseName.includes('createdAt') ? 0 : 1,
        text: _caseName.includes('text') ? '' : 'quarantine',
        operation: 'enqueue',
      }),
    ]);
    expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
      expect.objectContaining({
        localId,
        createdAt: _caseName.includes('createdAt') ? 0 : 1,
        text: 'quarantine',
        rawRecord: expect.objectContaining({ role: 'user' }),
      }),
    ]);
  });

  it('retires same-scope persisted enqueue custody before scheduling replay for a server-owned row', () => {
    const sessionId = 's_replay_server_owned';
    const localId = 'server-owned-local';
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'server owned' }, meta: {} };
    savePendingOutboxMessage({
      sessionId, localId, createdAt: 1, text: 'server owned', rawRecord,
      request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
    }, outboxScope);
    storage.getState().upsertPendingMessage(sessionId, {
      id: localId, localId, createdAt: 1, updatedAt: 2,
      source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
      text: 'server owned', rawRecord,
    });

    expect(replayPersistedPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
    expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
      expect.objectContaining({ localId, source: 'server_pending' }),
    ]);
  });

  it('keeps same-scope persisted cancellation scheduled while its server row still exists', () => {
    const sessionId = 's_replay_server_owned_cancel';
    const localId = 'server-owned-cancel';
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'cancel' }, meta: {} };
    savePendingOutboxMessage({
      sessionId, localId, createdAt: 1, text: 'cancel', rawRecord, operation: 'cancel',
      request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
    }, outboxScope);
    storage.getState().upsertPendingMessage(sessionId, {
      id: localId, localId, createdAt: 1, updatedAt: 2,
      source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
      text: 'server owned', rawRecord,
    });

    expect(replayPersistedPendingOutboxForSession(sessionId, outboxScope)).toEqual([localId]);
    expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([
      expect.objectContaining({ localId, operation: 'cancel' }),
    ]);
  });

  it.each([undefined, 'external_handoff'] as const)(
    'retires ordinary custody but preserves external handoff after background cancellation succeeds (%s)',
    async (pendingDeliveryStatus) => {
      const sessionId = `s_background_cancel_${pendingDeliveryStatus ?? 'ordinary'}`;
      const localId = 'background-cancel';
      const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'cancel' }, meta: {} };
      savePendingOutboxMessage({
        sessionId, localId, createdAt: 1, text: 'cancel', rawRecord, operation: 'cancel',
        request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
      }, outboxScope);
      storage.getState().upsertPendingMessage(sessionId, {
        id: localId, localId, createdAt: 1, updatedAt: 1,
        source: 'server_pending', pendingDeliveryStatus, pendingOutboxScope: outboxScope, text: 'cancel', rawRecord,
      });

      await expect(retryPendingOutboxOperationV2({
        sessionId, localId, outboxScope, serverWireMode: 'pending_input_v1',
        request: async () => new Response(null, { status: 204 }),
      })).resolves.toEqual({ accepted: true });

      expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual(
        pendingDeliveryStatus === 'external_handoff'
          ? [expect.objectContaining({ localId, pendingDeliveryStatus: 'external_handoff' })]
          : [],
      );
    },
  );

});

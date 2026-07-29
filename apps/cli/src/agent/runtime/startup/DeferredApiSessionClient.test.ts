import { describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/testkit/async/deferred';
import { DeferredApiSessionClient } from './DeferredApiSessionClient';
import type { Metadata } from '@/api/types';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';

function createMetadataStub(overrides?: Partial<Metadata>): Metadata {
  return {
    path: '/tmp',
    host: 'host',
    homeDir: '/home',
    happyHomeDir: '/home/.happier',
    happyLibDir: '/home/.happier/lib',
    happyToolsDir: '/home/.happier/tools',
    ...overrides,
  };
}

describe('DeferredApiSessionClient', () => {
  it('replays the latest pre-attach presence before pending materialization wakes', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'pending',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const calls: string[] = [];

    deferred.keepAlive(false, 'local');
    deferred.keepAlive(true, 'remote');
    deferred.wakePendingMaterialization();

    await deferred.attach({
      keepAlive: (thinking: boolean, mode: 'local' | 'remote') => {
        calls.push(`presence:${thinking}:${mode}`);
      },
      wakePendingMaterialization: () => {
        calls.push('wake');
      },
    } as unknown as Parameters<DeferredApiSessionClient['attach']>[0]);

    expect(calls).toEqual(['presence:true:remote', 'wake']);
  });

  it('coalesces pre-attach wake debt and delegates future wakes directly', async () => {
    const deferred = new DeferredApiSessionClient({ placeholderSessionId: 'pending', limits: { maxEntries: 10, maxBytes: 10_000 } });
    const wakePendingMaterialization = vi.fn();
    deferred.wakePendingMaterialization();
    deferred.wakePendingMaterialization();
    await deferred.attach({ wakePendingMaterialization } as unknown as Parameters<DeferredApiSessionClient['attach']>[0]);
    expect(wakePendingMaterialization).toHaveBeenCalledTimes(1);
    deferred.wakePendingMaterialization();
    expect(wakePendingMaterialization).toHaveBeenCalledTimes(2);
  });

  it('drops pre-attach wake debt when cancelled', async () => {
    const deferred = new DeferredApiSessionClient({ placeholderSessionId: 'pending', limits: { maxEntries: 10, maxBytes: 10_000 } });
    const wakePendingMaterialization = vi.fn();
    const keepAlive = vi.fn();
    deferred.keepAlive(true, 'remote');
    deferred.wakePendingMaterialization();
    deferred.cancel();
    await deferred.attach({ keepAlive, wakePendingMaterialization } as unknown as Parameters<DeferredApiSessionClient['attach']>[0]);
    expect(keepAlive).not.toHaveBeenCalled();
    expect(wakePendingMaterialization).not.toHaveBeenCalled();
  });
  it('invokes registered RPC handlers locally before attach', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    deferred.rpcHandlerManager.registerHandler('example', async (params) => {
      return { ok: true, params };
    });

    await expect(deferred.rpcHandlerManager.invokeLocal('example', { a: 1 })).resolves.toEqual({
      ok: true,
      params: { a: 1 },
    });
  });

  it('delegates session control methods after attach', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn(),
      sendProviderMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendUserTextMessage: vi.fn(),
      onUserMessage: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => createMetadataStub()),
      fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => ({ intent: 'acceptEdits' as const, updatedAt: 12 })),
      waitForMetadataUpdate: vi.fn(async () => true),
      popPendingMessage: vi.fn(async () => true),
      peekPendingMessageQueueV2Count: vi.fn(async () => 3),
      discardPendingMessageQueueV2All: vi.fn(async () => 1),
      discardCommittedMessageLocalIds: vi.fn(async () => 2),
      sendSessionDeath: vi.fn(),
      setSessionRuntimeControls: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    const initialControls = {
      handleUserMessage: vi.fn(() => ({ handled: false as const })),
    } satisfies SessionRuntimeControls;
    deferred.setSessionRuntimeControls(initialControls);

    await deferred.attach(real);

    expect(real.setSessionRuntimeControls).toHaveBeenCalledWith(initialControls);

    await expect(deferred.waitForMetadataUpdate()).resolves.toBe(true);
    await expect(deferred.fetchLatestUserPermissionIntentFromTranscript({ take: 3 })).resolves.toEqual({
      intent: 'acceptEdits',
      updatedAt: 12,
    });
    await expect(deferred.popPendingMessage()).resolves.toBe(true);
    await expect(deferred.peekPendingMessageQueueV2Count()).resolves.toBe(3);
    await expect(deferred.discardPendingMessageQueueV2All({ reason: 'manual' })).resolves.toBe(1);
    await expect(deferred.discardCommittedMessageLocalIds({ localIds: ['a'], reason: 'manual' })).resolves.toBe(2);

    await deferred.flush();
    await deferred.close();

    const nextControls = {
      clearGoal: vi.fn(),
    } satisfies SessionRuntimeControls;
    deferred.setSessionRuntimeControls(nextControls);

    expect(real.waitForMetadataUpdate).toHaveBeenCalledTimes(1);
    expect(real.fetchLatestUserPermissionIntentFromTranscript).toHaveBeenCalledWith({ take: 3 });
    expect(real.popPendingMessage).toHaveBeenCalledTimes(1);
    expect(real.setSessionRuntimeControls).toHaveBeenLastCalledWith(nextControls);
    expect(real.flush).toHaveBeenCalledTimes(1);
    expect(real.close).toHaveBeenCalledTimes(1);
  });

  it('returns no transcript-derived permission intent before attach so fast-start stays non-blocking', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    await expect(deferred.fetchLatestUserPermissionIntentFromTranscript({ take: 5 })).resolves.toBeNull();
  });

  it('defers pending queue materialization before attach instead of reporting no pending work', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    await expect(deferred.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'deferred',
      reason: 'supervisor_offline',
    });
  });

  it('forwards pending provider custody reconciliation after attach without blocking startup before attach', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const reconciliationPort = deferred as unknown as Readonly<{
      reconcilePendingProviderInputCustodyBeforeMaterialization: () => Promise<boolean>;
    }>;

    await expect(
      reconciliationPort.reconcilePendingProviderInputCustodyBeforeMaterialization(),
    ).resolves.toBe(true);

    const reconcilePendingProviderInputCustodyBeforeMaterialization = vi.fn(async () => false);
    await deferred.attach({
      reconcilePendingProviderInputCustodyBeforeMaterialization,
    } as unknown as Parameters<DeferredApiSessionClient['attach']>[0]);

    await expect(
      reconciliationPort.reconcilePendingProviderInputCustodyBeforeMaterialization(),
    ).resolves.toBe(false);
    expect(reconcilePendingProviderInputCustodyBeforeMaterialization).toHaveBeenCalledTimes(1);
  });

  it('forwards user message handlers registered before attach', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    const handler = vi.fn();
    const onUserMessage = vi.fn();
    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn(),
      sendProviderMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendUserTextMessage: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => createMetadataStub()),
      waitForMetadataUpdate: vi.fn(async () => true),
      popPendingMessage: vi.fn(async () => true),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(),
      setSessionRuntimeControls: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onUserMessage,
    } as const;

    deferred.onUserMessage(handler);
    expect(onUserMessage).not.toHaveBeenCalled();

    await deferred.attach(real);

    expect(onUserMessage).toHaveBeenCalledWith(handler);
  });

  it('buffers provider dispatch and user message writes until attach then flushes', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    const calls: string[] = [];
    const providerMessages: unknown[] = [];
    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn(),
      sendProviderMessage: vi.fn((request: unknown) => {
        providerMessages.push(request);
        calls.push('provider');
      }),
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendUserTextMessage: vi.fn(() => {
        calls.push('user');
      }),
      onUserMessage: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => createMetadataStub()),
      waitForMetadataUpdate: vi.fn(async () => true),
      popPendingMessage: vi.fn(async () => true),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(),
      setSessionRuntimeControls: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    const legacyCodexDispatch = ['send', 'Codex', 'Message'].join('');
    const legacyClaudeDispatch = ['send', 'Claude', 'Session', 'Message'].join('');
    expect(legacyCodexDispatch in deferred).toBe(false);
    expect(legacyClaudeDispatch in deferred).toBe(false);
    expect('sendProviderMessage' in deferred).toBe(true);

    deferred.sendUserTextMessage('hi');
    deferred.sendProviderMessage({ body: { type: 'message', message: 'hello' }, meta: { source: 'startup-test' } });

    expect(calls).toEqual([]);
    await deferred.attach(real);
    expect(calls).toEqual(['user', 'provider']);
    expect(providerMessages).toEqual([
      { body: { type: 'message', message: 'hello' }, meta: { source: 'startup-test' } },
    ]);
  });

  it('rejects detached live sends while preserving buffered durable transcript writes', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    const calls: string[] = [];
    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn(),
      sendProviderMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendAgentMessageEphemeral: vi.fn((_provider: unknown, body: any) => {
        calls.push(`live:${String(body?.message ?? '')}`);
        return { accepted: true as const, epoch: 1 };
      }),
      sendAgentMessageCommitted: vi.fn(async (_provider: unknown, body: any) => {
        calls.push(`commit:${String(body?.message ?? '')}`);
      }),
      sendUserTextMessage: vi.fn(),
      onUserMessage: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => createMetadataStub()),
      waitForMetadataUpdate: vi.fn(async () => true),
      popPendingMessage: vi.fn(async () => true),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(),
      setSessionRuntimeControls: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    const liveOutcome = (deferred as any).sendAgentMessageEphemeral(
      'codex',
      { type: 'message', message: 'Hello' },
      { localId: 'segment-1', createdAt: 1, updatedAt: 2 },
    );
    const committedPromise = (deferred as any).sendAgentMessageCommitted(
      'codex',
      { type: 'message', message: 'Hello world' },
      { localId: 'segment-1' },
    );

    expect(liveOutcome).toEqual({
      accepted: false,
      epoch: 0,
      reason: 'transport_unavailable',
    });
    expect(calls).toEqual([]);

    await deferred.attach(real as any);
    await committedPromise;

    expect(calls).toEqual(['commit:Hello world']);
  });

  it('rejects failed buffered metadata writes while continuing later buffered calls', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    const events: unknown[] = [];
    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn((event: unknown) => {
        events.push(event);
      }),
      sendProviderMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendUserTextMessage: vi.fn(),
      onUserMessage: vi.fn(),
      updateMetadata: vi.fn(async () => {
        throw new Error('boom');
      }),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => createMetadataStub()),
      waitForMetadataUpdate: vi.fn(async () => true),
      popPendingMessage: vi.fn(async () => true),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(),
      setSessionRuntimeControls: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    const updatePromise = deferred.updateMetadata((metadata) => metadata) as Promise<void>;
    const updateFailure = expect(updatePromise).rejects.toThrow('boom');
    deferred.sendSessionEvent({ type: 'message', message: 'hi' });

    await expect(deferred.attach(real)).resolves.toBeUndefined();
    await updateFailure;
    expect(events.some((e: any) => e && typeof e === 'object' && (e as any).message === 'hi')).toBe(true);
  });

  it('serializes writes that occur during attach flush and makes attach idempotent', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 100, maxBytes: 10_000 },
    });

    const metadataGate = createDeferred<void>();

    const calls: string[] = [];
    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn((event: unknown) => {
        calls.push(`event:${String((event as any)?.id ?? '')}`);
      }),
      sendProviderMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendUserTextMessage: vi.fn(),
      onUserMessage: vi.fn(),
      updateMetadata: vi.fn(async () => {
        calls.push('metadata:start');
        await metadataGate.promise;
        calls.push('metadata:end');
      }),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => null),
      waitForMetadataUpdate: vi.fn(async () => false),
      popPendingMessage: vi.fn(async () => false),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(),
      setSessionRuntimeControls: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    const ignored = {
      sessionId: 'sess_ignored',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn(),
      sendProviderMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendUserTextMessage: vi.fn(),
      onUserMessage: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => null),
      waitForMetadataUpdate: vi.fn(async () => false),
      popPendingMessage: vi.fn(async () => false),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(),
      setSessionRuntimeControls: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    deferred.sendSessionEvent({ id: 'before' });
    deferred.updateMetadata((m) => m);

    const attach1 = deferred.attach(real);
    const attach2 = deferred.attach(ignored);

    let attach2Resolved = false;
    attach2.then(() => {
      attach2Resolved = true;
    });

    // Wait for updateMetadata flush to start and block.
    for (let i = 0; i < 50; i++) {
      if (calls.includes('metadata:start')) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(calls).toContain('metadata:start');
    expect(attach2Resolved).toBe(false);

    // This write happens while attach is still flushing.
    // It should be delivered after the buffered flush completes.
    deferred.sendSessionEvent({ id: 'during' });

    metadataGate.resolve(undefined);
    await attach1;
    await attach2;

    expect(calls).toEqual(['event:before', 'metadata:start', 'metadata:end', 'event:during']);
    expect(ignored.sendSessionEvent).toHaveBeenCalledTimes(0);
  });

  it('buffers calls until attach(), then flushes in order', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    const calls: string[] = [];

    const rpcHandlers: Array<{ method: string }> = [];
    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: {
        registerHandler: vi.fn((method: string) => {
          rpcHandlers.push({ method });
        }),
        invokeLocal: vi.fn(async () => ({})),
      },
      sendSessionEvent: vi.fn(() => {
        calls.push('event');
      }),
      sendProviderMessage: vi.fn(() => {
        calls.push('provider');
      }),
      sendAgentMessage: vi.fn(() => {
        calls.push('agent');
      }),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendUserTextMessage: vi.fn(),
      updateMetadata: vi.fn(() => {
        calls.push('metadata');
      }),
      updateAgentState: vi.fn(() => {
        calls.push('agentState');
      }),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => null),
      waitForMetadataUpdate: vi.fn(async () => false),
      popPendingMessage: vi.fn(async () => false),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(),
      setSessionRuntimeControls: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    // Register handlers + send events before attach.
    // These should not reach the real session yet.
    deferred.rpcHandlerManager.registerHandler('abort', async () => {});
    deferred.sendSessionEvent({ type: 'message' });
    deferred.sendProviderMessage({ body: { type: 'user' } });
    deferred.sendAgentMessage('claude', { type: 'message' });
    deferred.updateMetadata((m) => m);
    deferred.updateAgentState((s) => s);

    expect(calls).toEqual([]);
    expect(rpcHandlers.map((h) => h.method)).toEqual([]);

    await deferred.attach(real);

    expect(calls).toEqual(['event', 'provider', 'agent', 'metadata', 'agentState']);
    expect(rpcHandlers.map((h) => h.method)).toEqual(['abort']);
  });

  it('binds RPC handlers before attach preparation and drains delivery only after preparation settles', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const preparationGate = createDeferred<void>();
    const order: string[] = [];
    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: {
        registerHandler: vi.fn((method: string) => {
          order.push(`handler:${method}`);
        }),
        invokeLocal: vi.fn(async () => ({})),
      },
      sendSessionEvent: vi.fn((event: unknown) => {
        const type =
          event && typeof event === 'object' && 'type' in event
            ? String(event.type)
            : 'unknown';
        order.push(`delivery:${type}`);
      }),
      onUserMessage: vi.fn((handler: (data: unknown) => void) => {
        order.push('user-handler:bind');
        handler({ id: 'buffered-user-input' });
      }),
      keepAlive: vi.fn(() => {
        order.push('presence');
      }),
      wakePendingMaterialization: vi.fn(() => {
        order.push('wake');
      }),
    } as unknown as Parameters<DeferredApiSessionClient['attach']>[0];

    deferred.rpcHandlerManager.registerHandler('session.model.transition', async () => ({}));
    deferred.onUserMessage(() => {
      order.push('user-callback');
    });
    deferred.keepAlive(true, 'remote');
    deferred.wakePendingMaterialization();
    deferred.sendSessionEvent({ type: 'ready' });

    const attach = (
      deferred.attach as unknown as (
        target: Parameters<DeferredApiSessionClient['attach']>[0],
        options: Readonly<{
          beforeBufferedDrain(target: Parameters<DeferredApiSessionClient['attach']>[0]): Promise<void>;
        }>,
      ) => Promise<void>
    )(real, {
      beforeBufferedDrain: async () => {
        order.push('prepare:start');
        expect(order).toEqual([
          'handler:session.model.transition',
          'prepare:start',
        ]);
        await preparationGate.promise;
        order.push('prepare:end');
      },
    });

    await vi.waitFor(() => {
      expect(order).toContain('prepare:start');
    });
    expect(order).toEqual([
      'handler:session.model.transition',
      'prepare:start',
    ]);

    deferred.sendSessionEvent({ type: 'message', message: 'during preparation' });
    preparationGate.resolve(undefined);
    await attach;

    expect(order).toEqual([
      'handler:session.model.transition',
      'prepare:start',
      'prepare:end',
      'delivery:ready',
      'delivery:message',
      'user-handler:bind',
      'user-callback',
      'presence',
      'wake',
    ]);
  });

  it('accepts durable activity buffer custody immediately and preserves FIFO across a failed attach retry', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const mutationPort = deferred as unknown as Readonly<{
      enqueueRegisteredSessionStateFieldMutation(
        mutation: RegisteredSessionStateFieldMutationV1,
      ): Promise<void>;
    }>;
    const createMutation = (
      mutationId: string,
      state: 'idle' | 'active',
    ): RegisteredSessionStateFieldMutationV1 => ({
      v: 1,
      sessionId: 'sess_1',
      mutationId,
      fieldId: 'runtime.activity',
      deliveryClass: 'durable_best_effort',
      op: {
        kind: 'set',
        value: {
          state,
          activeCount: state === 'active' ? 1 : 0,
        },
      },
      source: 'runtime',
      observedAt: 1,
    });
    const first = createMutation('activity:first', 'idle');
    const second = createMutation('activity:second', 'active');

    await expect(
      mutationPort.enqueueRegisteredSessionStateFieldMutation(first),
    ).resolves.toBeUndefined();
    await expect(
      mutationPort.enqueueRegisteredSessionStateFieldMutation(second),
    ).resolves.toBeUndefined();

    const rejectedTargetEnqueue = vi.fn(async () => undefined);
    await expect(deferred.attach({
      sessionId: 'sess_rejected',
      rpcHandlerManager: {
        registerHandler: vi.fn(),
        invokeLocal: vi.fn(async () => ({})),
      },
      enqueueRegisteredSessionStateFieldMutation: rejectedTargetEnqueue,
    } as unknown as Parameters<DeferredApiSessionClient['attach']>[0], {
      beforeBufferedDrain: async () => {
        throw new Error('authority preparation rejected');
      },
    })).rejects.toThrow('authority preparation rejected');
    expect(rejectedTargetEnqueue).not.toHaveBeenCalled();

    const deliveredMutationIds: string[] = [];
    await deferred.attach({
      sessionId: 'sess_1',
      rpcHandlerManager: {
        registerHandler: vi.fn(),
        invokeLocal: vi.fn(async () => ({})),
      },
      enqueueRegisteredSessionStateFieldMutation: vi.fn(async (mutation) => {
        deliveredMutationIds.push(mutation.mutationId);
      }),
    } as unknown as Parameters<DeferredApiSessionClient['attach']>[0]);

    expect(deliveredMutationIds).toEqual([
      'activity:first',
      'activity:second',
    ]);

    const cancelled = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-2',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const cancelledPort = cancelled as unknown as typeof mutationPort;
    await expect(
      cancelledPort.enqueueRegisteredSessionStateFieldMutation(first),
    ).resolves.toBeUndefined();
    cancelled.cancel();
    const cancelledTargetEnqueue = vi.fn(async () => undefined);
    await cancelled.attach({
      sessionId: 'sess_cancelled',
      rpcHandlerManager: {
        registerHandler: vi.fn(),
        invokeLocal: vi.fn(async () => ({})),
      },
      enqueueRegisteredSessionStateFieldMutation: cancelledTargetEnqueue,
    } as unknown as Parameters<DeferredApiSessionClient['attach']>[0]);
    expect(cancelledTargetEnqueue).not.toHaveBeenCalled();
  });

  it('retains metadata and execution observers before attach without allowing reentrant delivery through the barrier', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const observerPort = deferred as unknown as Readonly<{
      on(eventName: 'metadata-updated', listener: () => void): unknown;
      off(eventName: 'metadata-updated', listener: () => void): unknown;
      subscribeExecutionRunActivitySnapshots(
        listener: (activeCount: number) => void,
      ): () => void;
    }>;
    const preparationGate = createDeferred<void>();
    const order: string[] = [];
    const metadataListener = () => {
      order.push('metadata');
    };
    observerPort.on('metadata-updated', metadataListener);
    const unsubscribeExecution = observerPort.subscribeExecutionRunActivitySnapshots(
      (activeCount) => {
        order.push(`execution:${activeCount}`);
        if (activeCount > 0) {
          deferred.sendSessionEvent({
            type: 'execution-observer-publication',
          });
        }
      },
    );
    expect(order).toEqual(['execution:0']);

    const metadataListeners = new Set<() => void>();
    const executionListeners = new Set<(activeCount: number) => void>();
    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: {
        registerHandler: vi.fn(),
        invokeLocal: vi.fn(async () => ({})),
      },
      on: vi.fn((_eventName: 'metadata-updated', listener: () => void) => {
        order.push('metadata:bind');
        metadataListeners.add(listener);
      }),
      off: vi.fn((_eventName: 'metadata-updated', listener: () => void) => {
        order.push('metadata:unbind');
        metadataListeners.delete(listener);
      }),
      subscribeExecutionRunActivitySnapshots: vi.fn(
        (listener: (activeCount: number) => void) => {
          order.push('execution:bind');
          executionListeners.add(listener);
          listener(2);
          return () => {
            order.push('execution:unbind');
            executionListeners.delete(listener);
          };
        },
      ),
      sendSessionEvent: vi.fn(() => {
        order.push('delivery');
      }),
    } as unknown as Parameters<DeferredApiSessionClient['attach']>[0];

    const attach = deferred.attach(real, {
      beforeBufferedDrain: async () => {
        order.push('prepare:start');
        for (const listener of metadataListeners) listener();
        await preparationGate.promise;
        order.push('prepare:end');
      },
    });
    await vi.waitFor(() => {
      expect(order).toContain('prepare:start');
    });
    expect(order).toEqual([
      'execution:0',
      'metadata:bind',
      'execution:bind',
      'execution:2',
      'prepare:start',
      'metadata',
    ]);
    expect(real.sendSessionEvent).not.toHaveBeenCalled();

    preparationGate.resolve(undefined);
    await attach;
    expect(order).toContain('prepare:end');
    expect(order.indexOf('delivery')).toBeGreaterThan(
      order.indexOf('prepare:end'),
    );

    observerPort.off('metadata-updated', metadataListener);
    unsubscribeExecution();
    expect(metadataListeners.size).toBe(0);
    expect(executionListeners.size).toBe(0);
  });

  it.each([
    {
      missingSupport: 'metadata listener binding',
      retainConsumer: (deferred: DeferredApiSessionClient) => {
        deferred.on('metadata-updated', () => undefined);
      },
      observerMethods: () => ({
        off: vi.fn(),
      }),
    },
    {
      missingSupport: 'metadata listener detachment',
      retainConsumer: (deferred: DeferredApiSessionClient) => {
        deferred.on('metadata-updated', () => undefined);
      },
      observerMethods: () => ({
        on: vi.fn(),
      }),
    },
    {
      missingSupport: 'execution activity snapshots',
      retainConsumer: (deferred: DeferredApiSessionClient) => {
        deferred.subscribeExecutionRunActivitySnapshots(() => undefined);
      },
      observerMethods: () => ({}),
    },
  ])(
    'fails attach closed when retained consumers lack $missingSupport support',
    async ({ retainConsumer, observerMethods }) => {
      const deferred = new DeferredApiSessionClient({
        placeholderSessionId: 'PID-1',
        limits: { maxEntries: 10, maxBytes: 10_000 },
      });
      retainConsumer(deferred);
      deferred.sendSessionEvent({ type: 'ready' });

      const sendSessionEvent = vi.fn();
      const beforeBufferedDrain = vi.fn();
      await expect(
        deferred.attach({
          sessionId: 'sess_1',
          rpcHandlerManager: {
            registerHandler: vi.fn(),
            invokeLocal: vi.fn(async () => ({})),
          },
          sendSessionEvent,
          ...observerMethods(),
        } as unknown as Parameters<DeferredApiSessionClient['attach']>[0], {
          beforeBufferedDrain,
        }),
      ).rejects.toThrow();

      expect(beforeBufferedDrain).not.toHaveBeenCalled();
      expect(sendSessionEvent).not.toHaveBeenCalled();
      expect(deferred.sessionId).toBe('PID-1');
    },
  );

  it('fails attach closed without draining buffered delivery when preparation rejects', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const sendSessionEvent = vi.fn();
    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: {
        registerHandler: vi.fn(),
        invokeLocal: vi.fn(async () => ({})),
      },
      sendSessionEvent,
    } as unknown as Parameters<DeferredApiSessionClient['attach']>[0];
    deferred.sendSessionEvent({ type: 'ready' });

    await expect(
      (
        deferred.attach as unknown as (
          target: Parameters<DeferredApiSessionClient['attach']>[0],
          options: Readonly<{
            beforeBufferedDrain(target: Parameters<DeferredApiSessionClient['attach']>[0]): Promise<void>;
          }>,
        ) => Promise<void>
      )(real, {
        beforeBufferedDrain: async () => {
          throw new Error('required snapshot refresh failed');
        },
      }),
    ).rejects.toThrow('required snapshot refresh failed');

    expect(sendSessionEvent).not.toHaveBeenCalled();
  });

  it('resolves updateMetadata promises after attach flush', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    let resolved = false;
    const promise = deferred.updateMetadata((m) => m) as Promise<void>;
    promise.then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn(),
      sendProviderMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendUserTextMessage: vi.fn(),
      onUserMessage: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => null),
      waitForMetadataUpdate: vi.fn(async () => false),
      popPendingMessage: vi.fn(async () => false),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(),
      setSessionRuntimeControls: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    await deferred.attach(real);
    await promise;

    expect(resolved).toBe(true);
    expect(real.updateMetadata).toHaveBeenCalledTimes(1);
  });

  it('drops oldest buffered entries when exceeding limits and reports overflow', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 2, maxBytes: 10_000 },
    });

    deferred.sendSessionEvent({ id: 1 });
    deferred.sendSessionEvent({ id: 2 });
    deferred.sendSessionEvent({ id: 3 });

    expect(deferred.getBufferStats()).toEqual(
      expect.objectContaining({
        entryCount: 2,
        overflowed: true,
      }),
    );

    const seen: unknown[] = [];
    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn((event: unknown) => {
        seen.push(event);
      }),
      sendProviderMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendUserTextMessage: vi.fn(),
      onUserMessage: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => null),
      waitForMetadataUpdate: vi.fn(async () => false),
      popPendingMessage: vi.fn(async () => false),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(),
      setSessionRuntimeControls: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    await deferred.attach(real);

    expect(seen.length).toBe(3);
    expect(seen[0]).toEqual(expect.objectContaining({ type: 'message' }));
    expect((seen[0] as any).message).toContain('startup-buffer-overflow');
    expect(seen.slice(1)).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it('emits a warning session event when buffered entries overflow before attach', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 1, maxBytes: 10_000 },
    });

    deferred.sendSessionEvent({ id: 1 });
    deferred.sendSessionEvent({ id: 2 });

    const seen: unknown[] = [];
    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn((event: unknown) => {
        seen.push(event);
      }),
      sendProviderMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendUserTextMessage: vi.fn(),
      onUserMessage: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => null),
      waitForMetadataUpdate: vi.fn(async () => false),
      popPendingMessage: vi.fn(async () => false),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(),
      setSessionRuntimeControls: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    await deferred.attach(real);

    // Warning event first, then the last retained event.
    expect(seen.length).toBe(2);
    expect(seen[0]).toEqual(
      expect.objectContaining({
        type: 'message',
      }),
    );
    expect((seen[0] as any).message).toContain('startup-buffer-overflow');
    expect(seen[1]).toEqual({ id: 2 });
  });

  it('cancels buffered writes and resolves pending update promises without attaching', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    const promise = deferred.updateMetadata((m) => m) as Promise<void>;
    deferred.cancel();

    await expect(promise).resolves.toBeUndefined();
    expect(deferred.getBufferStats().entryCount).toBe(0);
  });
});

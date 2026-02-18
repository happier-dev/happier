import { describe, expect, it, vi } from 'vitest';

import { DeferredApiSessionClient } from './DeferredApiSessionClient';
import type { Metadata } from '@/api/types';

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
  };
}

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
      sendClaudeSessionMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendCodexMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => createMetadataStub()),
      waitForMetadataUpdate: vi.fn(async () => true),
      popPendingMessage: vi.fn(async () => true),
      peekPendingMessageQueueV2Count: vi.fn(async () => 3),
      discardPendingMessageQueueV2All: vi.fn(async () => 1),
      discardCommittedMessageLocalIds: vi.fn(async () => 2),
      sendSessionDeath: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    await deferred.attach(real);

    await expect(deferred.waitForMetadataUpdate()).resolves.toBe(true);
    await expect(deferred.popPendingMessage()).resolves.toBe(true);
    await expect(deferred.peekPendingMessageQueueV2Count()).resolves.toBe(3);
    await expect(deferred.discardPendingMessageQueueV2All({ reason: 'manual' })).resolves.toBe(1);
    await expect(deferred.discardCommittedMessageLocalIds({ localIds: ['a'], reason: 'manual' })).resolves.toBe(2);

    deferred.sendSessionDeath();
    await deferred.flush();
    await deferred.close();

    expect(real.waitForMetadataUpdate).toHaveBeenCalledTimes(1);
    expect(real.popPendingMessage).toHaveBeenCalledTimes(1);
    expect(real.sendSessionDeath).toHaveBeenCalledTimes(1);
    expect(real.flush).toHaveBeenCalledTimes(1);
    expect(real.close).toHaveBeenCalledTimes(1);
  });

  it('buffers codex and user message writes until attach then flushes', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    const calls: string[] = [];
    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn(),
      sendClaudeSessionMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendCodexMessage: vi.fn(() => {
        calls.push('codex');
      }),
      sendUserTextMessage: vi.fn(() => {
        calls.push('user');
      }),
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
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    deferred.sendUserTextMessage('hi');
    deferred.sendCodexMessage({ type: 'message', message: 'hello' });

    expect(calls).toEqual([]);
    await deferred.attach(real);
    expect(calls).toEqual(['user', 'codex']);
  });

  it('flushes buffered calls best-effort when an early write fails (no hang, no abort)', async () => {
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
      sendClaudeSessionMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendCodexMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
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
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    const updatePromise = deferred.updateMetadata((metadata) => metadata) as Promise<void>;
    deferred.sendSessionEvent({ type: 'message', message: 'hi' });

    await expect(deferred.attach(real)).resolves.toBeUndefined();
    await expect(updatePromise).resolves.toBeUndefined();
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
      sendClaudeSessionMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendCodexMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
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
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    const ignored = {
      sessionId: 'sess_ignored',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn(),
      sendClaudeSessionMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendCodexMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
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
      sendClaudeSessionMessage: vi.fn(() => {
        calls.push('claude');
      }),
      sendAgentMessage: vi.fn(() => {
        calls.push('agent');
      }),
      sendCodexMessage: vi.fn(),
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
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as const;

    // Register handlers + send events before attach.
    // These should not reach the real session yet.
    deferred.rpcHandlerManager.registerHandler('abort', async () => {});
    deferred.sendSessionEvent({ type: 'message' });
    deferred.sendClaudeSessionMessage({ type: 'user' });
    deferred.sendAgentMessage('claude', { type: 'message' });
    deferred.updateMetadata((m) => m);
    deferred.updateAgentState((s) => s);

    expect(calls).toEqual([]);
    expect(rpcHandlers.map((h) => h.method)).toEqual([]);

    await deferred.attach(real);

    expect(calls).toEqual(['event', 'claude', 'agent', 'metadata', 'agentState']);
    expect(rpcHandlers.map((h) => h.method)).toEqual(['abort']);
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
      sendClaudeSessionMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendCodexMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
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
      sendClaudeSessionMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendCodexMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
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
      sendClaudeSessionMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendCodexMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
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

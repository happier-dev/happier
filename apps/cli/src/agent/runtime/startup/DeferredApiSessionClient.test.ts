import { describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/testkit/async/deferred';
import type { SessionRuntimeActivitySnapshotPublisher } from '@/session/runtimeActivity/types';
import { DeferredApiSessionClient, type DeferredApiSessionTarget } from './DeferredApiSessionClient';
import type { Metadata } from '@/api/types';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createClaudeUnifiedUserMessageHandler } from '@/backends/claude/startup/createClaudeUnifiedUserMessageHandler';

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
  it('buffers exact Claude transcript commits until the real session client attaches', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-claude-exact-commit',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const commit = vi.fn(async () => {});
    let settled = false;
    const pending = deferred.sendClaudeSessionMessageCommittedExact(
      { type: 'assistant', uuid: 'assistant-parent' },
      { importedFrom: 'live' },
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await deferred.attach({
      sessionId: 'session-claude-exact-commit',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendClaudeSessionMessageCommittedExact: commit,
    } as unknown as DeferredApiSessionTarget);

    await pending;
    expect(commit).toHaveBeenCalledExactlyOnceWith(
      { type: 'assistant', uuid: 'assistant-parent' },
      { importedFrom: 'live' },
    );
  });

  it('returns and exactly replays a typed non-success when a pre-attach Claude enqueue overflows', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-overflow-enqueue',
      limits: { maxEntries: 1, maxBytes: 10_000 },
    });
    registerSessionHandlers(deferred.startupRpcHandlerManager, process.cwd(), {
      sessionRuntimeControls: {
        handleUserMessage: createClaudeUnifiedUserMessageHandler({
          enqueueSessionUserMessage: (request) => deferred.enqueueSessionUserMessage(request),
        }),
      },
    });
    const request = { text: 'queued', localId: 'overflow-id', meta: {} };
    const pending = deferred.startupRpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, request);
    await vi.waitFor(() => {
      expect(deferred.getBufferStats().entryCount).toBe(1);
    });
    deferred.sendSessionEvent({ type: 'force-overflow' });

    const expected = {
      ok: false,
      status: 'unavailable',
      errorCode: 'session_user_message_startup_buffer_overflow',
      error: 'session_user_message_startup_buffer_overflow',
    };
    await expect(pending).resolves.toEqual(expected);
    await expect(deferred.startupRpcHandlerManager.invokeLocal(
      SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
      request,
    )).resolves.toEqual(expected);

    const enqueueSessionUserMessage = vi.fn(async () => {});
    await deferred.attach({
      sessionId: 'session-overflow-enqueue',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      enqueueSessionUserMessage,
    } as unknown as DeferredApiSessionTarget);
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
    expect(deferred.getBufferStats().entryCount).toBe(0);
  });

  it('returns and exactly replays a typed non-success when a pre-attach Claude enqueue is cancelled', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-cancel-enqueue',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    registerSessionHandlers(deferred.startupRpcHandlerManager, process.cwd(), {
      sessionRuntimeControls: {
        handleUserMessage: createClaudeUnifiedUserMessageHandler({
          enqueueSessionUserMessage: (request) => deferred.enqueueSessionUserMessage(request),
        }),
      },
    });
    const request = { text: 'queued', localId: 'cancel-id', meta: {} };
    const pending = deferred.startupRpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, request);
    await Promise.resolve();
    deferred.cancel();
    const expected = {
      ok: false,
      status: 'unavailable',
      errorCode: 'session_user_message_startup_cancelled',
      error: 'session_user_message_startup_cancelled',
    };
    await expect(pending).resolves.toEqual(expected);
    await expect(deferred.startupRpcHandlerManager.invokeLocal(
      SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
      request,
    )).resolves.toEqual(expected);
    expect(deferred.getBufferStats().entryCount).toBe(0);
  });

  it('returns and exactly replays a typed non-success when the pre-attach Claude enqueue fails during flush', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-flush-error-enqueue',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    registerSessionHandlers(deferred.startupRpcHandlerManager, process.cwd(), {
      sessionRuntimeControls: {
        handleUserMessage: createClaudeUnifiedUserMessageHandler({
          enqueueSessionUserMessage: (request) => deferred.enqueueSessionUserMessage(request),
        }),
      },
    });
    const request = { text: 'queued', localId: 'flush-error-id', meta: {} };
    const pending = deferred.startupRpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, request);
    await Promise.resolve();
    const enqueueSessionUserMessage = vi.fn(async () => {
      throw new Error('target enqueue failed');
    });
    await deferred.attach({
      sessionId: 'session-flush-error-enqueue',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      enqueueSessionUserMessage,
    } as unknown as DeferredApiSessionTarget);

    const expected = {
      ok: false,
      status: 'unavailable',
      errorCode: 'session_user_message_startup_flush_error',
      error: 'session_user_message_startup_flush_error',
    };
    await expect(pending).resolves.toEqual(expected);
    await expect(deferred.startupRpcHandlerManager.invokeLocal(
      SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
      request,
    )).resolves.toEqual(expected);
    expect(enqueueSessionUserMessage).toHaveBeenCalledExactlyOnceWith(request);
    expect(deferred.getBufferStats().entryCount).toBe(0);
  });

  it('preserves and exactly replays a typed recovery block through deferred Claude registration', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-recovery-block',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const target = {
      sessionId: 'session-recovery-block',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      enqueueSessionUserMessage: vi.fn(async () => ({
        recoveryBlocked: {
          status: 'waiting' as const,
          errorCode: 'session_user_message_recovery_pending',
        },
      })),
    } as unknown as DeferredApiSessionTarget;
    await deferred.attach(target);

    registerSessionHandlers(deferred.startupRpcHandlerManager, process.cwd(), {
      sessionRuntimeControls: {
        handleUserMessage: createClaudeUnifiedUserMessageHandler({
          enqueueSessionUserMessage: (request) => deferred.enqueueSessionUserMessage(request),
        }),
      },
    });
    const request = {
      text: 'retry',
      localId: 'exact-id',
      meta: {},
    };
    const expected = {
      ok: false,
      status: 'waiting',
      errorCode: 'session_user_message_recovery_pending',
      error: 'session_user_message_recovery_pending',
    };

    await expect(deferred.startupRpcHandlerManager.invokeLocal(
      SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
      request,
    )).resolves.toEqual(expected);
    await expect(deferred.startupRpcHandlerManager.invokeLocal(
      SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
      request,
    )).resolves.toEqual(expected);
    expect(target.enqueueSessionUserMessage).toHaveBeenCalledExactlyOnceWith({
      text: 'retry',
      localId: 'exact-id',
      meta: {},
    });
    await expect(deferred.enqueueSessionUserMessage(request)).resolves.toEqual({
      recoveryBlocked: {
        status: 'waiting',
        errorCode: 'session_user_message_recovery_pending',
      },
    });
  });
  it('exposes only the attached target snapshot publisher without fabricating or buffering Activity', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-target-activity',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const publisher: SessionRuntimeActivitySnapshotPublisher = {
      publish: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };

    expect(deferred.getRuntimeActivitySnapshotPublisher()).toBeNull();

    await deferred.attach({
      sessionId: 'session-target-activity',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      getRuntimeActivitySnapshotPublisher: () => publisher,
    } as unknown as DeferredApiSessionTarget);

    expect(deferred.getRuntimeActivitySnapshotPublisher()).toBe(publisher);
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(publisher.close).not.toHaveBeenCalled();
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

  it('keeps startup-only RPC handlers local without overwriting the attached canonical registry', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-startup-rpc',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const startupHandler = vi.fn(async () => ({ source: 'startup' }));
    deferred.startupRpcHandlerManager.registerHandler('session.goal.clear', startupHandler);

    await expect(
      deferred.startupRpcHandlerManager.invokeLocal('session.goal.clear', {}),
    ).resolves.toEqual({ source: 'startup' });

    const registerHandler = vi.fn();
    const invokeLocal = vi.fn(async () => ({ source: 'attached' }));
    await deferred.attach({
      sessionId: 'sess-startup-rpc',
      rpcHandlerManager: { registerHandler, invokeLocal },
    } as unknown as DeferredApiSessionTarget);

    expect(registerHandler).not.toHaveBeenCalledWith('session.goal.clear', startupHandler);
    await expect(
      deferred.startupRpcHandlerManager.invokeLocal('session.goal.clear', { attached: true }),
    ).resolves.toEqual({ source: 'startup' });
    expect(invokeLocal).not.toHaveBeenCalled();
    expect(startupHandler).toHaveBeenCalledTimes(2);
  });

  it('replays runtime-control registrations on attach and disposes the attached registration once', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-runtime-controls',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const setGoal = vi.fn(async () => ({ ok: true as const }));
    const clearGoal = vi.fn(async () => ({ ok: true as const }));
    const unregister = vi.fn();
    const registerSessionRuntimeControls = vi.fn(() => unregister);

    const dispose = deferred.registerSessionRuntimeControls({ setGoal, clearGoal });
    expect(registerSessionRuntimeControls).not.toHaveBeenCalled();

    await deferred.attach({
      sessionId: 'sess-runtime-controls',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      registerSessionRuntimeControls,
    } as unknown as DeferredApiSessionTarget);

    expect(registerSessionRuntimeControls).toHaveBeenCalledExactlyOnceWith({ setGoal, clearGoal });
    dispose();
    dispose();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('forwards runtime-control registrations made after attach', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-attached-runtime-controls',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const unregister = vi.fn();
    const registerSessionRuntimeControls = vi.fn(() => unregister);
    await deferred.attach({
      sessionId: 'sess-attached-runtime-controls',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      registerSessionRuntimeControls,
    } as unknown as DeferredApiSessionTarget);

    const clearGoal = vi.fn(async () => ({ ok: true as const }));
    const dispose = deferred.registerSessionRuntimeControls({ clearGoal });

    expect(registerSessionRuntimeControls).toHaveBeenCalledExactlyOnceWith({ clearGoal });
    dispose();
    expect(unregister).toHaveBeenCalledTimes(1);
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
      recordClaudeJsonlMessageConsumed: vi.fn(),
      setProviderOwnedUserMessageEchoClassifier: vi.fn(),
      fetchCommittedClaudeJsonlMessageBaseline: vi.fn(async () => ({ keys: new Set(['claude-jsonl:main:user:u1']), complete: true, oldestCoveredAtMs: null })),
      fetchRecentTranscriptTextItemsForAcpImport: vi.fn(async () => [{ role: 'user' as const, text: 'hello' }]),
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
      sendCodexMessage: vi.fn(),
      sendCodexMessageCommitted: vi.fn(async () => ({ seq: 1 })),
      sendUserTextMessage: vi.fn(),
      sendUserTextMessageCommitted: vi.fn(async () => {}),
      sendSessionEventCommitted: vi.fn(async () => ({ seq: 2 })),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => createMetadataStub()),
      waitForMetadataUpdate: vi.fn(async () => true),
      waitForPendingEligibilityUpdate: vi.fn(async () => true),
      popPendingMessage: vi.fn(async () => true),
      peekPendingMessageQueueV2Count: vi.fn(async () => 3),
      discardPendingMessageQueueV2All: vi.fn(async () => 1),
      discardCommittedMessageLocalIds: vi.fn(async () => 2),
      sendSessionDeath: vi.fn(),
      flush: vi.fn(async (_input?: unknown) => {}),
      close: vi.fn(async (_input?: unknown) => {}),
    } as const;

    const classifier = vi.fn(() => true);
    deferred.setProviderOwnedUserMessageEchoClassifier(classifier);

    await deferred.attach(real);

    await expect(deferred.waitForMetadataUpdate()).resolves.toBe(true);
    await expect(deferred.waitForPendingEligibilityUpdate()).resolves.toBe(true);
    await expect(deferred.popPendingMessage()).resolves.toBe(true);
    await expect(deferred.peekPendingMessageQueueV2Count({ reconcileWhenEmpty: 'skip' })).resolves.toBe(3);
    await expect(deferred.fetchCommittedClaudeJsonlMessageBaseline({ take: 1 })).resolves.toEqual(
      { keys: new Set(['claude-jsonl:main:user:u1']), complete: true, oldestCoveredAtMs: null },
    );
    await expect(deferred.fetchRecentTranscriptTextItemsForAcpImport({ take: 1 })).resolves.toEqual([
      { role: 'user', text: 'hello' },
    ]);
    await expect(deferred.discardPendingMessageQueueV2All({ reason: 'manual' })).resolves.toBe(1);
    await expect(deferred.discardCommittedMessageLocalIds({ localIds: ['a'], reason: 'manual' })).resolves.toBe(2);

    deferred.recordClaudeJsonlMessageConsumed({ type: 'user', uuid: 'u1' });
    await deferred.sendAgentMessageCommitted('codex', { type: 'text', text: 'agent' }, { localId: 'agent-1' });
    await deferred.sendCodexMessageCommitted({ type: 'tool-call', callId: 'call-1' }, { localId: 'codex-1' });
    await deferred.sendUserTextMessageCommitted('user', { localId: 'user-1' });
    await deferred.sendSessionEventCommitted({ type: 'context-compaction', phase: 'completed' }, { localId: 'event-1' });
    deferred.sendSessionDeath();
    await deferred.flush();
    await deferred.close();

    expect(real.waitForMetadataUpdate).toHaveBeenCalledTimes(1);
    expect(real.waitForPendingEligibilityUpdate).toHaveBeenCalledTimes(1);
    expect(real.peekPendingMessageQueueV2Count).toHaveBeenCalledWith({ reconcileWhenEmpty: 'skip' });
    expect(real.fetchCommittedClaudeJsonlMessageBaseline).toHaveBeenCalledWith({ take: 1 });
    expect(real.fetchRecentTranscriptTextItemsForAcpImport).toHaveBeenCalledWith({ take: 1 });
    expect(real.recordClaudeJsonlMessageConsumed).toHaveBeenCalledWith({ type: 'user', uuid: 'u1' }, undefined);
    expect(real.sendAgentMessageCommitted).toHaveBeenCalledExactlyOnceWith(
      'codex',
      { type: 'text', text: 'agent' },
      { localId: 'agent-1' },
    );
    expect(real.sendCodexMessageCommitted).toHaveBeenCalledExactlyOnceWith(
      { type: 'tool-call', callId: 'call-1' },
      { localId: 'codex-1' },
    );
    expect(real.sendUserTextMessageCommitted).toHaveBeenCalledExactlyOnceWith(
      'user',
      { localId: 'user-1' },
    );
    expect(real.sendSessionEventCommitted).toHaveBeenCalledExactlyOnceWith(
      { type: 'context-compaction', phase: 'completed' },
      { localId: 'event-1' },
    );
    expect(real.setProviderOwnedUserMessageEchoClassifier).toHaveBeenCalledWith(classifier);
    expect(real.popPendingMessage).toHaveBeenCalledTimes(1);
    expect(real.sendSessionDeath).toHaveBeenCalledTimes(1);
    expect(real.flush).toHaveBeenCalledTimes(1);
    expect(real.close).toHaveBeenCalledTimes(1);
  });

  it('delegates safe pending materialization after attach and defers before attach', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    await expect(deferred.materializeNextPendingMessageSafely()).resolves.toEqual({
      type: 'deferred',
      reason: 'supervisor_offline',
    });

    const real = {
      sessionId: 'sess_1',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn(),
      sendClaudeSessionMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
      sendCodexMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => createMetadataStub()),
      waitForMetadataUpdate: vi.fn(async () => true),
      materializeNextPendingMessageSafely: vi.fn(async () => ({
        type: 'deferred' as const,
        reason: 'supervisor_offline' as const,
      })),
      popPendingMessage: vi.fn(async () => true),
      peekPendingMessageQueueV2Count: vi.fn(async () => 3),
      discardPendingMessageQueueV2All: vi.fn(async () => 1),
      discardCommittedMessageLocalIds: vi.fn(async () => 2),
      sendSessionDeath: vi.fn(),
      flush: vi.fn(async (_input?: unknown) => {}),
      close: vi.fn(async (_input?: unknown) => {}),
    } as const;

    await deferred.attach(real);

    await expect(deferred.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'skip' })).resolves.toEqual({
      type: 'deferred',
      reason: 'supervisor_offline',
    });
    expect(real.materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'skip' });
  });

  it('coalesces pre-attach pending wakes and delegates through the public wake port', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-wake',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const wakePendingMaterialization = vi.fn();

    deferred.wakePendingMaterialization();
    deferred.wakePendingMaterialization();

    const real = {
      sessionId: 'sess_wake',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}), sendCodexMessage: vi.fn(), sendUserTextMessage: vi.fn(),
      updateMetadata: vi.fn(), updateAgentState: vi.fn(), keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => createMetadataStub()), waitForMetadataUpdate: vi.fn(async () => true),
      wakePendingMaterialization,
      popPendingMessage: vi.fn(async () => false), peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0), discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(), flush: vi.fn(async () => {}), close: vi.fn(async () => {}),
    } as const;

    await deferred.attach(real);
    expect(wakePendingMaterialization).toHaveBeenCalledTimes(1);
    deferred.wakePendingMaterialization();
    expect(wakePendingMaterialization).toHaveBeenCalledTimes(2);
  });


  it('drops unforwarded pending wake debt when cancelled', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-cancel-wake',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const wakePendingMaterialization = vi.fn();
    deferred.wakePendingMaterialization();
    deferred.cancel();

    await deferred.attach({
      sessionId: 'sess_cancelled', rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}), sendCodexMessage: vi.fn(), sendUserTextMessage: vi.fn(),
      updateMetadata: vi.fn(), updateAgentState: vi.fn(), keepAlive: vi.fn(), getMetadataSnapshot: vi.fn(() => null),
      waitForMetadataUpdate: vi.fn(async () => true), wakePendingMaterialization,
      popPendingMessage: vi.fn(async () => false), peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0), discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(), flush: vi.fn(async () => {}), close: vi.fn(async () => {}),
    });
    expect(wakePendingMaterialization).not.toHaveBeenCalled();
  });

  it('reports an attached target without pending materialization support as unavailable, not empty', async () => {
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const real = {
      sessionId: 'sess_legacy',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn(),
      sendClaudeSessionMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
      sendCodexMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => createMetadataStub()),
      waitForMetadataUpdate: vi.fn(async () => true),
      popPendingMessage: vi.fn(async () => false),
      peekPendingMessageQueueV2Count: vi.fn(async () => 1),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(),
      flush: vi.fn(async (_input?: unknown) => {}),
      close: vi.fn(async (_input?: unknown) => {}),
    } as const;

    await deferred.attach(real);

    await expect(deferred.materializeNextPendingMessageSafely()).resolves.toEqual({
      type: 'retryable_transport',
    });
    expect(real.peekPendingMessageQueueV2Count).not.toHaveBeenCalled();
    expect(real.popPendingMessage).not.toHaveBeenCalled();
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
      sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
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
      flush: vi.fn(async (_input?: unknown) => {}),
      close: vi.fn(async (_input?: unknown) => {}),
    } as const;

    deferred.sendUserTextMessage('hi');
    deferred.sendCodexMessage({ type: 'message', message: 'hello' });

    expect(calls).toEqual([]);
    await deferred.attach(real);
    expect(calls).toEqual(['user', 'codex']);
  });

  it('rejects failed buffered metadata writes without aborting later buffered writes', async () => {
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
      sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
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
      flush: vi.fn(async (_input?: unknown) => {}),
      close: vi.fn(async (_input?: unknown) => {}),
    } as const;

    const updatePromise = deferred.updateMetadata((metadata) => metadata) as Promise<void>;
    deferred.sendSessionEvent({ type: 'message', message: 'hi' });

    await expect(deferred.attach(real)).resolves.toBeUndefined();
    await expect(updatePromise).rejects.toThrow('boom');
    expect(events.some((e: any) => e && typeof e === 'object' && (e as any).message === 'hi')).toBe(true);
  });

  it('rejects failed buffered agent-state writes without aborting later buffered writes', async () => {
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
      sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
      sendCodexMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(async () => {
        throw new Error('agent-state-boom');
      }),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => createMetadataStub()),
      waitForMetadataUpdate: vi.fn(async () => true),
      popPendingMessage: vi.fn(async () => true),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(),
      flush: vi.fn(async (_input?: unknown) => {}),
      close: vi.fn(async (_input?: unknown) => {}),
    } as const;

    const updatePromise = deferred.updateAgentState((agentState) => agentState) as Promise<void>;
    deferred.sendSessionEvent({ type: 'message', message: 'hi' });

    await expect(deferred.attach(real)).resolves.toBeUndefined();
    await expect(updatePromise).rejects.toThrow('agent-state-boom');
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
      sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
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
      flush: vi.fn(async (_input?: unknown) => {}),
      close: vi.fn(async (_input?: unknown) => {}),
    } as const;

    const ignored = {
      sessionId: 'sess_ignored',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
      sendSessionEvent: vi.fn(),
      sendClaudeSessionMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
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
      flush: vi.fn(async (_input?: unknown) => {}),
      close: vi.fn(async (_input?: unknown) => {}),
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
      sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
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
      flush: vi.fn(async (_input?: unknown) => {}),
      close: vi.fn(async (_input?: unknown) => {}),
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
      sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
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
      flush: vi.fn(async (_input?: unknown) => {}),
      close: vi.fn(async (_input?: unknown) => {}),
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
      sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
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
      flush: vi.fn(async (_input?: unknown) => {}),
      close: vi.fn(async (_input?: unknown) => {}),
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
      sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
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
      flush: vi.fn(async (_input?: unknown) => {}),
      close: vi.fn(async (_input?: unknown) => {}),
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

  describe('sendAgentMessageCommitted forwarding', () => {
    function createRealTarget(overrides?: Partial<Record<string, any>>) {
      return {
        sessionId: 'sess_sac',
        rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn(async () => ({})) },
        sendSessionEvent: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendAgentMessageCommitted: vi.fn(async (_input?: unknown) => {}),
        sendCodexMessage: vi.fn(),
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
        flush: vi.fn(async (_input?: unknown) => {}),
        close: vi.fn(async (_input?: unknown) => {}),
        ...overrides,
      };
    }

    it('delegates sendAgentMessageCommitted to the attached target', async () => {
      const deferred = new DeferredApiSessionClient({
        placeholderSessionId: 'PID-sac',
        limits: { maxEntries: 10, maxBytes: 10_000 },
      });
      const real = createRealTarget();
      await deferred.attach(real as any);

      await deferred.sendAgentMessageCommitted(
        'claude',
        { type: 'message', message: 'hello' },
        { localId: 'local-1' },
      );

      expect(real.sendAgentMessageCommitted).toHaveBeenCalledTimes(1);
      expect(real.sendAgentMessageCommitted).toHaveBeenCalledWith(
        'claude',
        { type: 'message', message: 'hello' },
        { localId: 'local-1' },
      );
    });

    it('buffers sendAgentMessageCommitted calls made before attach and flushes them in order', async () => {
      const deferred = new DeferredApiSessionClient({
        placeholderSessionId: 'PID-sac',
        limits: { maxEntries: 10, maxBytes: 10_000 },
      });
      const order: string[] = [];
      const real = createRealTarget({
        sendAgentMessageCommitted: vi.fn(async (_p: unknown, _b: unknown, opts: { localId: string }) => {
          order.push(opts.localId);
        }),
      });

      const p1 = deferred.sendAgentMessageCommitted('claude', { type: 'message', message: 'a' }, { localId: 'first' });
      const p2 = deferred.sendAgentMessageCommitted('claude', { type: 'message', message: 'b' }, { localId: 'second' });

      expect(order).toEqual([]);
      await deferred.attach(real as any);
      await Promise.all([p1, p2]);

      expect(order).toEqual(['first', 'second']);
    });

    it('resolves buffered sendAgentMessageCommitted promises when the client is cancelled before attach', async () => {
      const deferred = new DeferredApiSessionClient({
        placeholderSessionId: 'PID-sac',
        limits: { maxEntries: 10, maxBytes: 10_000 },
      });

      const promise = deferred.sendAgentMessageCommitted(
        'claude',
        { type: 'message', message: 'x' },
        { localId: 'abc' },
      );
      deferred.cancel();

      await expect(promise).resolves.toBeUndefined();
    });
  });
});

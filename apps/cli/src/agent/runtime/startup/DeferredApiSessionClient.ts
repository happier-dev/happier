import type {
  DeferredSessionBufferEntry,
  DeferredSessionBufferDropReason,
  DeferredSessionBufferLimits,
  DeferredSessionBufferStats,
} from './deferredSessionBuffer';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerManagerLike } from '@/api/rpc/types';
import type { AgentState, Metadata } from '@/api/types';
import type {
  MaterializeNextPendingResult,
} from '@/api/session/sessionClientPort';
import type { PendingQueueReadOptions, PendingQueueReconcileWhenEmpty } from '@/api/session/pendingQueueReadPolicy';
import type { ProviderOwnedUserMessageEchoClassifier } from '@/api/session/providerOwnedUserMessageEcho';
import type { SessionRuntimeActivitySnapshotPublisher } from '@/session/runtimeActivity/types';
import type { SessionUserMessageEnqueueResult } from '@/rpc/handlers/sessionUserMessageSend';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { cloneCallableSessionRuntimeControls } from '@/api/session/sessionRuntimeControls';

export type DeferredApiSessionTarget = Readonly<{
  sessionId: string;
  rpcHandlerManager: RpcHandlerManagerLike;
  setSessionRuntimeControls?: (controls: SessionRuntimeControls | null) => void;
  registerSessionRuntimeControls?: (controls: Partial<SessionRuntimeControls> | null) => () => void;
  beginRuntimeTermination?: () => void;
  hasRuntimeTerminationStarted?: () => boolean;
  sendSessionEvent: (event: unknown, id?: string) => void;
  sendClaudeSessionMessage: (message: unknown, meta?: unknown) => void;
  sendClaudeSessionMessageCommittedExact?: (message: unknown, meta?: Record<string, unknown>) => Promise<void>;
  recordClaudeJsonlMessageConsumed?: (message: unknown, meta?: unknown) => void;
  setProviderOwnedUserMessageEchoClassifier?: (classifier: ProviderOwnedUserMessageEchoClassifier | null) => void;
  fetchCommittedClaudeJsonlMessageBaseline?: (opts?: { take?: number }) => Promise<import('@/backends/claude/utils/claudeJsonlMessageKey').CommittedClaudeJsonlMessageBaseline>;
  hasActiveCanonicalTurn?: () => boolean;
  fetchRecentTranscriptTextItemsForAcpImport?: (opts?: { take?: number }) => Promise<Array<{ role: 'user' | 'agent'; text: string }>>;
  sendAgentMessage: (provider: unknown, body: unknown, opts?: unknown) => void;
  sendAgentMessageCommitted: (
    provider: unknown,
    body: unknown,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<void>;
  sendCodexMessage: (body: unknown) => void;
  sendCodexMessageCommitted?: (body: unknown, opts: { localId: string }) => Promise<unknown>;
  sendUserTextMessage: (text: string, opts?: { localId?: string; meta?: Record<string, unknown> }) => void;
  sendUserTextMessageCommitted?: (
    text: string,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<void>;
  sendSessionEventCommitted?: (event: unknown, opts: { localId: string }) => Promise<unknown>;
  enqueueSessionUserMessage?: (params: Readonly<{
    text: string;
    localId?: string;
    meta?: Record<string, unknown>;
  }>) => Promise<SessionUserMessageEnqueueResult>;
  updateMetadata: (updater: (metadata: Metadata) => Metadata) => void | Promise<void>;
  updateAgentState: (updater: (state: AgentState) => AgentState) => void | Promise<void>;
  getRuntimeActivitySnapshotPublisher?: () => SessionRuntimeActivitySnapshotPublisher | null;
  keepAlive: (thinking: boolean, mode: 'local' | 'remote') => void;
  getMetadataSnapshot: () => Metadata | null;
  refreshSessionSnapshotFromServerBestEffort?: (opts?: { reason?: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  waitForPendingEligibilityUpdate?: (abortSignal?: AbortSignal) => Promise<boolean>;
  shouldAttemptPendingMaterialization?: () => boolean;
  reconcilePendingQueueState?: (opts?: { force?: boolean }) => Promise<boolean>;
  materializeNextPendingMessageSafely?: (opts?: {
    reconcileWhenEmpty?: PendingQueueReconcileWhenEmpty;
  }) => Promise<MaterializeNextPendingResult>;
  wakePendingMaterialization?: () => void;
  popPendingMessage: () => Promise<boolean>;
  peekPendingMessageQueueV2Count: (opts?: PendingQueueReadOptions) => Promise<number>;
  discardPendingMessageQueueV2All: (opts: { reason: 'switch_to_local' | 'manual' }) => Promise<number>;
  discardCommittedMessageLocalIds: (opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }) => Promise<number>;
  sendSessionDeath: () => void;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}>;

/**
 * Deferred session client that buffers writes until a real ApiSessionClient is available.
 *
 * NOTE: This file is intentionally introduced with placeholder behavior; it will be fully
 * implemented via TDD in follow-up commits.
 */
export class DeferredApiSessionClient {
  sessionId: string;
  private readonly limits: DeferredSessionBufferLimits;
  readonly rpcHandlerManager: RpcHandlerManagerLike;
  readonly startupRpcHandlerManager: RpcHandlerManagerLike;
  private readonly registeredHandlers = new Map<string, RpcHandler>();
  private readonly startupHandlers = new Map<string, RpcHandler>();
  private baseSessionRuntimeControls: Partial<SessionRuntimeControls> = {};
  private readonly sessionRuntimeControlRegistrations = new Set<{
    controls: Partial<SessionRuntimeControls>;
    targetDispose: (() => void) | null;
  }>();
  private target: DeferredApiSessionTarget | null = null;
  private attachPromise: Promise<void> | null = null;
  private flushInFlight: Promise<void> | null = null;
  private buffer: DeferredSessionBufferEntry<DeferredApiSessionTarget>[] = [];
  private bufferBytes = 0;
  private overflowed = false;
  private overflowWarningSent = false;
  private flushHadErrors = false;
  private flushErrorWarningSent = false;
  private cancelled = false;
  private runtimeTerminationStarted = false;
  private pendingWakeDebt = false;
  private providerOwnedUserMessageEchoClassifier: ProviderOwnedUserMessageEchoClassifier | null = null;
  private providerOwnedUserMessageEchoClassifierSet = false;

  constructor(opts: { placeholderSessionId: string; limits: DeferredSessionBufferLimits }) {
    this.sessionId = opts.placeholderSessionId;
    this.limits = opts.limits;
    this.rpcHandlerManager = {
      registerHandler: <TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>,
      ) => {
        this.registeredHandlers.set(method, handler as RpcHandler);
        const target = this.target;
        if (target) {
          target.rpcHandlerManager.registerHandler(method, handler);
        }
      },
      invokeLocal: async (method: string, params: unknown): Promise<unknown> => {
        const target = this.target;
        if (target) return await target.rpcHandlerManager.invokeLocal(method, params);
        const handler = this.registeredHandlers.get(method);
        if (!handler) {
          return { error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        }
        return await handler(params);
      },
    };
    this.startupRpcHandlerManager = {
      registerHandler: <TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>,
      ) => {
        this.startupHandlers.set(method, handler as RpcHandler);
      },
      invokeLocal: async (method: string, params: unknown): Promise<unknown> => {
        const handler = this.startupHandlers.get(method);
        if (!handler) {
          return { error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        }
        return await handler(params);
      },
    };
  }

  setSessionRuntimeControls(controls: SessionRuntimeControls | null): void {
    this.baseSessionRuntimeControls = cloneCallableSessionRuntimeControls(controls);
    this.target?.setSessionRuntimeControls?.(this.baseSessionRuntimeControls);
  }

  registerSessionRuntimeControls(controls: Partial<SessionRuntimeControls> | null): () => void {
    const copiedControls = cloneCallableSessionRuntimeControls(controls);
    if (Object.keys(copiedControls).length === 0) return () => {};

    const registration = {
      controls: copiedControls,
      targetDispose: this.target?.registerSessionRuntimeControls?.(copiedControls) ?? null,
    };
    this.sessionRuntimeControlRegistrations.add(registration);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.sessionRuntimeControlRegistrations.delete(registration);
      registration.targetDispose?.();
      registration.targetDispose = null;
    };
  }

  sendSessionEvent(_event: unknown, _id?: string): void {
    const target = this.target;
    if (target && !this.flushInFlight) {
      target.sendSessionEvent(_event, _id);
      return;
    }

    if (this.cancelled) {
      return;
    }
    this.pushBufferedCall((t) => t.sendSessionEvent(_event, _id), { hint: 'sendSessionEvent' });
  }

  sendClaudeSessionMessage(_message: unknown, _meta?: unknown): void {
    const target = this.target;
    if (target && !this.flushInFlight) {
      target.sendClaudeSessionMessage(_message, _meta);
      return;
    }

    if (this.cancelled) {
      return;
    }
    this.pushBufferedCall((t) => t.sendClaudeSessionMessage(_message, _meta), { hint: 'sendClaudeSessionMessage' });
  }

  sendClaudeSessionMessageCommittedExact(
    _message: unknown,
    _meta?: Record<string, unknown>,
  ): Promise<void> {
    return this.forwardCommittedCall(async (target) => {
      const commit = target.sendClaudeSessionMessageCommittedExact;
      if (!commit) {
        throw new Error('Attached session client does not support exact Claude transcript commits');
      }
      await commit.call(target, _message, _meta);
    }, 'sendClaudeSessionMessageCommittedExact');
  }

  hasActiveCanonicalTurn(): boolean {
    const target = this.target;
    // Unknown state before attach counts as ACTIVE so stale-turn recovery stays fail-closed.
    return target?.hasActiveCanonicalTurn?.() ?? true;
  }

  async fetchCommittedClaudeJsonlMessageBaseline(
    opts?: { take?: number },
  ): Promise<import('@/backends/claude/utils/claudeJsonlMessageKey').CommittedClaudeJsonlMessageBaseline> {
    const target = this.target;
    if (!target?.fetchCommittedClaudeJsonlMessageBaseline) {
      // Fail CLOSED (Lane N4): without an attached client the committed baseline is UNKNOWN,
      // not empty. Callers must not replay history as new on this signal.
      throw new Error('Session client is not ready to load the committed Claude JSONL baseline');
    }
    return target.fetchCommittedClaudeJsonlMessageBaseline(opts);
  }

  recordClaudeJsonlMessageConsumed(_message: unknown, _meta?: unknown): void {
    const target = this.target;
    if (target && !this.flushInFlight) {
      target.recordClaudeJsonlMessageConsumed?.(_message, _meta);
      return;
    }

    if (this.cancelled) {
      return;
    }
    this.pushBufferedCall((t) => t.recordClaudeJsonlMessageConsumed?.(_message, _meta), {
      hint: 'recordClaudeJsonlMessageConsumed',
    });
  }

  setProviderOwnedUserMessageEchoClassifier(classifier: ProviderOwnedUserMessageEchoClassifier | null): void {
    this.providerOwnedUserMessageEchoClassifier = classifier;
    this.providerOwnedUserMessageEchoClassifierSet = true;
    this.target?.setProviderOwnedUserMessageEchoClassifier?.(classifier);
  }

  async fetchRecentTranscriptTextItemsForAcpImport(opts?: { take?: number }): Promise<Array<{ role: 'user' | 'agent'; text: string }>> {
    const target = this.target;
    if (!target?.fetchRecentTranscriptTextItemsForAcpImport) {
      return [];
    }
    return target.fetchRecentTranscriptTextItemsForAcpImport(opts);
  }

  sendAgentMessage(_provider: unknown, _body: unknown, _opts?: unknown): void {
    const target = this.target;
    if (target && !this.flushInFlight) {
      target.sendAgentMessage(_provider, _body, _opts);
      return;
    }

    if (this.cancelled) {
      return;
    }
    this.pushBufferedCall((t) => t.sendAgentMessage(_provider, _body, _opts), { hint: 'sendAgentMessage' });
  }

  sendAgentMessageCommitted(
    _provider: unknown,
    _body: unknown,
    _opts: { localId: string; meta?: Record<string, unknown> },
  ): Promise<void> {
    return this.forwardCommittedCall(
      (target) => target.sendAgentMessageCommitted(_provider, _body, _opts),
      'sendAgentMessageCommitted',
    );
  }

  sendCodexMessage(_body: unknown): void {
    const target = this.target;
    if (target && !this.flushInFlight) {
      target.sendCodexMessage(_body);
      return;
    }

    if (this.cancelled) {
      return;
    }
    this.pushBufferedCall((t) => t.sendCodexMessage(_body), { hint: 'sendCodexMessage' });
  }

  sendCodexMessageCommitted(_body: unknown, _opts: { localId: string }): Promise<unknown> {
    return this.forwardCommittedCall(
      (target) => {
        if (!target.sendCodexMessageCommitted) {
          throw new Error('Attached session does not support committed Codex messages');
        }
        return target.sendCodexMessageCommitted(_body, _opts);
      },
      'sendCodexMessageCommitted',
    );
  }

  sendUserTextMessage(_text: string, _opts?: { localId?: string; meta?: Record<string, unknown> }): void {
    const target = this.target;
    if (target && !this.flushInFlight) {
      target.sendUserTextMessage(_text, _opts);
      return;
    }

    if (this.cancelled) {
      return;
    }
    this.pushBufferedCall((t) => t.sendUserTextMessage(_text, _opts), { hint: 'sendUserTextMessage' });
  }

  sendUserTextMessageCommitted(
    _text: string,
    _opts: { localId: string; meta?: Record<string, unknown> },
  ): Promise<void> {
    return this.forwardCommittedCall(
      (target) => {
        if (!target.sendUserTextMessageCommitted) {
          throw new Error('Attached session does not support committed user messages');
        }
        return target.sendUserTextMessageCommitted(_text, _opts);
      },
      'sendUserTextMessageCommitted',
    );
  }

  sendSessionEventCommitted(_event: unknown, _opts: { localId: string }): Promise<unknown> {
    return this.forwardCommittedCall(
      (target) => {
        if (!target.sendSessionEventCommitted) {
          throw new Error('Attached session does not support committed session events');
        }
        return target.sendSessionEventCommitted(_event, _opts);
      },
      'sendSessionEventCommitted',
    );
  }

  async enqueueSessionUserMessage(_params: Readonly<{
    text: string;
    localId?: string;
    meta?: Record<string, unknown>;
  }>): Promise<SessionUserMessageEnqueueResult> {
    const target = this.target;
    if (target && !this.flushInFlight) {
      if (typeof target.enqueueSessionUserMessage === 'function') {
        return await target.enqueueSessionUserMessage(_params);
      }
      target.sendUserTextMessage(_params.text, {
        localId: _params.localId,
        meta: _params.meta,
      });
      return;
    }

    const deferred = createDeferredPromise<SessionUserMessageEnqueueResult>();
    if (this.cancelled) {
      deferred.resolve(startupEnqueueUnavailable('cancelled'));
      return deferred.promise;
    }

    this.pushBufferedCall(
      async (t) => {
        if (typeof t.enqueueSessionUserMessage === 'function') {
          deferred.resolve(await t.enqueueSessionUserMessage(_params));
          return;
        }
        t.sendUserTextMessage(_params.text, {
          localId: _params.localId,
          meta: _params.meta,
        });
        deferred.resolve();
      },
      { hint: 'enqueueSessionUserMessage' },
      {
        onDrop: (reason) => deferred.resolve(startupEnqueueUnavailable(reason)),
        onError: () => deferred.resolve(startupEnqueueUnavailable('flush_error')),
      },
    );
    return deferred.promise;
  }

  updateMetadata(_updater: (metadata: Metadata) => Metadata): void | Promise<void> {
    const target = this.target;
    if (target && !this.flushInFlight) {
      return target.updateMetadata(_updater);
    }

    const deferred = createDeferredPromise<void>();
    if (this.cancelled) {
      deferred.resolve();
      return deferred.promise;
    }

    this.pushBufferedCall(
      async (t) => {
        await Promise.resolve(t.updateMetadata(_updater));
        deferred.resolve();
      },
      { hint: 'updateMetadata' },
      {
        onDrop: () => deferred.resolve(),
        onError: (error) => deferred.reject(error),
      },
    );
    return deferred.promise;
  }

  updateAgentState(_updater: (state: AgentState) => AgentState): void | Promise<void> {
    const target = this.target;
    if (target && !this.flushInFlight) {
      return target.updateAgentState(_updater);
    }

    const deferred = createDeferredPromise<void>();
    if (this.cancelled) {
      deferred.resolve();
      return deferred.promise;
    }

    this.pushBufferedCall(
      async (t) => {
        await Promise.resolve(t.updateAgentState(_updater));
        deferred.resolve();
      },
      { hint: 'updateAgentState' },
      {
        onDrop: () => deferred.resolve(),
        onError: (error) => deferred.reject(error),
      },
    );
    return deferred.promise;
  }

  keepAlive(_thinking: boolean, _mode: 'local' | 'remote'): void {
    const target = this.target;
    if (!target) return;
    target.keepAlive(_thinking, _mode);
  }

  getMetadataSnapshot(): Metadata | null {
    const target = this.target;
    if (!target) return null;
    return target.getMetadataSnapshot();
  }

  async refreshSessionSnapshotFromServerBestEffort(opts?: { reason?: 'connect' | 'waitForMetadataUpdate' }): Promise<void> {
    const target = this.target;
    if (target && !this.flushInFlight) {
      if (typeof target.refreshSessionSnapshotFromServerBestEffort === 'function') {
        await target.refreshSessionSnapshotFromServerBestEffort(opts);
      }
      return;
    }

    const deferred = createDeferredPromise<void>();
    if (this.cancelled) {
      deferred.resolve();
      return deferred.promise;
    }

    // Buffer the refresh until attach finishes so callers can reliably wait for a fresh snapshot
    // even when the session client is still in deferred startup mode.
    this.pushBufferedCall(
      async (t) => {
        if (typeof t.refreshSessionSnapshotFromServerBestEffort === 'function') {
          await t.refreshSessionSnapshotFromServerBestEffort(opts);
        }
        deferred.resolve();
      },
      { hint: 'refreshSessionSnapshotFromServerBestEffort' },
      { onDrop: () => deferred.resolve() },
    );
    return deferred.promise;
  }

  async waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean> {
    if (abortSignal?.aborted) return false;
    return await this.withAttachedTarget((t) => t.waitForMetadataUpdate(abortSignal), false);
  }

  async waitForPendingEligibilityUpdate(abortSignal?: AbortSignal): Promise<boolean> {
    if (abortSignal?.aborted) return false;
    return await this.withAttachedTarget(
      (t) => t.waitForPendingEligibilityUpdate?.(abortSignal) ?? Promise.resolve(false),
      false,
    );
  }

  shouldAttemptPendingMaterialization(): boolean {
    const target = this.target;
    if (!target || this.flushInFlight) return false;
    return target.shouldAttemptPendingMaterialization?.() ?? true;
  }

  async reconcilePendingQueueState(opts?: { force?: boolean }): Promise<boolean> {
    return await this.withAttachedTarget((t) => t.reconcilePendingQueueState?.(opts) ?? Promise.resolve(false), false);
  }

  async materializeNextPendingMessageSafely(opts?: {
    reconcileWhenEmpty?: PendingQueueReconcileWhenEmpty;
  }): Promise<MaterializeNextPendingResult> {
    return await this.withAttachedTarget(
      (t): Promise<MaterializeNextPendingResult> => t.materializeNextPendingMessageSafely?.(opts)
        ?? Promise.resolve({ type: 'retryable_transport' as const }),
      { type: 'deferred' as const, reason: 'supervisor_offline' as const },
    );
  }

  async popPendingMessage(): Promise<boolean> {
    return await this.withAttachedTarget((t) => t.popPendingMessage(), false);
  }

  async peekPendingMessageQueueV2Count(opts?: PendingQueueReadOptions): Promise<number> {
    return await this.withAttachedTarget((t) => t.peekPendingMessageQueueV2Count(opts), 0);
  }

  async discardPendingMessageQueueV2All(opts: { reason: 'switch_to_local' | 'manual' }): Promise<number> {
    return await this.withAttachedTarget((t) => t.discardPendingMessageQueueV2All(opts), 0);
  }

  async discardCommittedMessageLocalIds(opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }): Promise<number> {
    return await this.withAttachedTarget((t) => t.discardCommittedMessageLocalIds(opts), 0);
  }

  sendSessionDeath(): void {
    const target = this.target;
    if (target && !this.flushInFlight) {
      target.sendSessionDeath();
      return;
    }

    if (this.cancelled) {
      return;
    }
    this.pushBufferedCall((t) => t.sendSessionDeath(), { hint: 'sendSessionDeath' });
  }

  async flush(): Promise<void> {
    await this.withAttachedTarget((t) => t.flush(), undefined);
  }

  async close(): Promise<void> {
    await this.withAttachedTarget((t) => t.close(), undefined);
  }

  getRuntimeActivitySnapshotPublisher(): SessionRuntimeActivitySnapshotPublisher | null {
    return this.target?.getRuntimeActivitySnapshotPublisher?.() ?? null;
  }

  wakePendingMaterialization(): void {
    if (this.cancelled) return;
    if (this.target) {
      this.target.wakePendingMaterialization?.();
      return;
    }
    this.pendingWakeDebt = true;
  }

  attach(_real: DeferredApiSessionTarget): Promise<void> {
    const existingPromise = this.attachPromise;
    if (existingPromise) return existingPromise;

    if (this.cancelled) {
      this.attachPromise = Promise.resolve();
      return this.attachPromise;
    }

    if (this.runtimeTerminationStarted) {
      _real.beginRuntimeTermination?.();
    }

    this.target = _real;
    this.sessionId = _real.sessionId;

    for (const [method, handler] of this.registeredHandlers.entries()) {
      _real.rpcHandlerManager.registerHandler(method, handler);
    }

    _real.setSessionRuntimeControls?.(this.baseSessionRuntimeControls);
    for (const registration of this.sessionRuntimeControlRegistrations) {
      registration.targetDispose = _real.registerSessionRuntimeControls?.(registration.controls) ?? null;
    }

    if (this.pendingWakeDebt) {
      this.pendingWakeDebt = false;
      _real.wakePendingMaterialization?.();
    }

    if (this.providerOwnedUserMessageEchoClassifierSet) {
      _real.setProviderOwnedUserMessageEchoClassifier?.(this.providerOwnedUserMessageEchoClassifier);
    }

    this.flushInFlight = this.drainBufferedCallsUntilEmpty();
    this.attachPromise = (async () => {
      try {
        await this.flushInFlight;
        // A call can arrive after the first drain observes an empty buffer but before its
        // completion clears the attach fence. Drain that tail before making direct forwarding
        // observable; otherwise an exact startup dispatch can remain buffered forever.
        while (this.buffer.length > 0) {
          await this.drainBufferedCallsUntilEmpty();
        }
      } finally {
        this.flushInFlight = null;
      }
    })();
    return this.attachPromise;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.pendingWakeDebt = false;

    const entries = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;

    for (const entry of entries) {
      try {
        entry.onDrop?.('cancelled');
      } catch {
        // ignore
      }
    }
  }

  beginRuntimeTermination(): void {
    if (this.runtimeTerminationStarted) return;
    this.runtimeTerminationStarted = true;
    this.target?.beginRuntimeTermination?.();
    if (!this.target) this.cancel();
  }

  hasRuntimeTerminationStarted(): boolean {
    return this.runtimeTerminationStarted || this.target?.hasRuntimeTerminationStarted?.() === true;
  }

  getBufferStats(): DeferredSessionBufferStats {
    return {
      entryCount: this.buffer.length,
      approxBytes: this.bufferBytes,
      overflowed: this.overflowed,
    };
  }

  private async flushBufferedCalls(): Promise<void> {
    const target = this.target;
    if (!target) return;

    const entries = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;

    let hadError = false;
    for (const entry of entries) {
      try {
        await Promise.resolve(entry.flush(target));
      } catch (error) {
        hadError = true;
        try {
          if (entry.onError) entry.onError(error);
          else entry.onDrop?.('flush_error');
        } catch {
          // ignore
        }
      }
    }
    if (hadError) {
      this.flushHadErrors = true;
    }
  }

  private async drainBufferedCallsUntilEmpty(): Promise<void> {
    const target = this.target;
    if (!target) return;

    while (!this.cancelled) {
      if (this.overflowed && !this.overflowWarningSent) {
        this.overflowWarningSent = true;
        try {
          target.sendSessionEvent({
            type: 'message',
            message: '[startup-buffer-overflow] Buffered startup events were dropped due to memory limits.',
          });
        } catch {
          // ignore
        }
      }

      if (this.flushHadErrors && !this.flushErrorWarningSent) {
        this.flushErrorWarningSent = true;
        try {
          target.sendSessionEvent({
            type: 'message',
            message: '[startup-buffer-flush-error] Some buffered startup events failed to flush; continuing in best-effort mode.',
          });
        } catch {
          // ignore
        }
      }

      if (this.buffer.length === 0) return;
      await this.flushBufferedCalls();
    }
  }

  private async withAttachedTarget<T>(
    fn: (target: DeferredApiSessionTarget) => Promise<T> | T,
    fallback: T,
  ): Promise<T> {
    if (this.cancelled) return fallback;

    const target = this.target;
    if (target && !this.flushInFlight) {
      return await Promise.resolve(fn(target));
    }

    const inFlight = this.attachPromise;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // ignore
      }
    }

    const after = this.target;
    if (!after) return fallback;
    return await Promise.resolve(fn(after));
  }

  private forwardCommittedCall<TResult>(
    call: (target: DeferredApiSessionTarget) => Promise<TResult>,
    hint: string,
  ): Promise<TResult> {
    const target = this.target;
    if (target && !this.flushInFlight) {
      return call(target);
    }

    const deferred = createDeferredPromise<TResult>();
    if (this.cancelled) {
      deferred.resolve(undefined as TResult);
      return deferred.promise;
    }

    this.pushBufferedCall(
      async (attachedTarget) => {
        deferred.resolve(await call(attachedTarget));
      },
      { hint },
      {
        onDrop: () => deferred.resolve(undefined as TResult),
        onError: (error) => deferred.reject(error),
      },
    );
    return deferred.promise;
  }

  private pushBufferedCall(
    flush: (target: DeferredApiSessionTarget) => void | Promise<void>,
    opts: { hint: string },
    extra?: { onDrop?: (reason: DeferredSessionBufferDropReason) => void; onError?: (error: unknown) => void },
  ): void {
    const approxBytes = approxBytesForHint(opts.hint);
    this.buffer.push({ approxBytes, flush, onDrop: extra?.onDrop, onError: extra?.onError });
    this.bufferBytes += approxBytes;

    this.enforceBufferLimits();
  }

  private enforceBufferLimits(): void {
    const { maxEntries, maxBytes } = this.limits;

    while (this.buffer.length > maxEntries || this.bufferBytes > maxBytes) {
      const dropped = this.buffer.shift();
      if (!dropped) break;
      this.bufferBytes -= dropped.approxBytes;
      if (!this.overflowed) {
        this.overflowed = true;
      }
      try {
        dropped.onDrop?.('overflow');
      } catch {
        // ignore
      }
    }
  }
}

function startupEnqueueUnavailable(
  reason: DeferredSessionBufferDropReason,
): Exclude<SessionUserMessageEnqueueResult, void> {
  const errorCode = reason === 'cancelled'
    ? 'session_user_message_startup_cancelled'
    : reason === 'overflow'
      ? 'session_user_message_startup_buffer_overflow'
      : 'session_user_message_startup_flush_error';
  return {
    recoveryBlocked: {
      status: 'unavailable',
      errorCode,
    },
  };
}

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolveFn: ((value: T) => void) | null = null;
  let rejectFn: ((error: unknown) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
    reject: (error: unknown) => rejectFn?.(error),
  };
}

function approxBytesForHint(hint: string): number {
  // Conservative fixed estimate to avoid JSON.stringify overhead in hot paths.
  // This is only used for best-effort buffer limit enforcement.
  return 64 + hint.length;
}

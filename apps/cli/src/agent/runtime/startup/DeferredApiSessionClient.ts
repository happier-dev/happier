import type {
  DeferredSessionBufferEntry,
  DeferredSessionBufferLimits,
  DeferredSessionBufferStats,
} from './deferredSessionBuffer';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerManagerLike } from '@/api/rpc/types';
import type { AgentState, Metadata, UserMessage } from '@/api/types';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import type { PendingMaterializationActiveTurnPolicy } from '@/api/session/pendingMaterializationActiveTurnPolicy';
import type { PendingMaterializationDeliveryTiming } from '@/api/session/pendingQueueV2Transport';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type { ProviderTranscriptDispatchRequest } from '@/api/session/client/transcript/providerDispatch';

export type DeferredApiSessionTarget = Readonly<{
  sessionId: string;
  rpcHandlerManager: RpcHandlerManagerLike;
  sendSessionEvent: (event: unknown, id?: string) => void;
  sendProviderMessage: (request: ProviderTranscriptDispatchRequest) => void;
  sendAgentMessage: (provider: unknown, body: unknown, opts?: unknown) => void;
  sendAgentMessageEphemeral?: (provider: unknown, body: unknown, opts: unknown) => void | Promise<void>;
  sendAgentMessageEphemeralDelta?: (provider: unknown, body: unknown, opts: unknown) => void | Promise<void>;
  getEphemeralStreamConnectionEpoch?: () => number;
  enqueueAgentMessageCommitted?: (
    provider: unknown,
    body: unknown,
    opts: unknown,
  ) => Promise<Readonly<{ persisted: true; delivered: boolean }>>;
  sendAgentMessageCommitted: (provider: unknown, body: unknown, opts: unknown) => Promise<void>;
  sendUserTextMessage: (text: string, opts?: { localId?: string; meta?: Record<string, unknown> }) => void;
  onUserMessage?: (callback: (data: UserMessage) => boolean | void) => void;
  updateMetadata: (updater: (metadata: Metadata) => Metadata) => void | Promise<void>;
  updateAgentState: (updater: (state: AgentState) => AgentState) => void | Promise<void>;
  keepAlive: (thinking: boolean, mode: 'local' | 'remote') => void;
  getMetadataSnapshot: () => Metadata | null;
  fetchLatestUserPermissionIntentFromTranscript?: (
    opts?: { take?: number },
  ) => Promise<{ intent: import('@/api/types').PermissionMode; updatedAt: number } | null>;
  refreshSessionSnapshotFromServerBestEffort?: (opts?: { reason?: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  popPendingMessage: () => Promise<boolean>;
  shouldAttemptPendingMaterialization?: (opts?: {
    activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
  }) => boolean;
  reconcilePendingQueueState?: (opts?: { force?: boolean }) => Promise<boolean>;
  materializeNextPendingMessageSafely?: (opts?: {
    reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
    activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
    deliveryTiming?: PendingMaterializationDeliveryTiming;
  }) => Promise<MaterializeNextPendingResult>;
  peekPendingMessageQueueV2Count: () => Promise<number>;
  discardPendingMessageQueueV2All: (opts: { reason: 'switch_to_local' | 'manual' }) => Promise<number>;
  discardCommittedMessageLocalIds: (opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }) => Promise<number>;
  sendSessionDeath: () => void;
  setSessionRuntimeControls: (controls: SessionRuntimeControls | null) => void;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}>;

/**
 * Deferred session client that buffers writes until a real ApiSessionClient is available.
 */
export class DeferredApiSessionClient {
  sessionId: string;
  private readonly limits: DeferredSessionBufferLimits;
  readonly rpcHandlerManager: RpcHandlerManagerLike;
  private readonly registeredHandlers = new Map<string, RpcHandler>();
  private readonly userMessageHandlers: Array<(data: UserMessage) => boolean | void> = [];
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
  private attachWaiters: Array<(attached: boolean) => void> = [];
  private runtimeControlsSnapshot: SessionRuntimeControls | null | undefined;

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
        const handler = this.registeredHandlers.get(method);
        if (!handler) {
          return { error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        }
        return await handler(params);
      },
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

  sendProviderMessage(_request: ProviderTranscriptDispatchRequest): void {
    const target = this.target;
    if (target && !this.flushInFlight) {
      target.sendProviderMessage(_request);
      return;
    }

    if (this.cancelled) {
      return;
    }
    this.pushBufferedCall((t) => t.sendProviderMessage(_request), { hint: 'sendProviderMessage' });
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

  sendAgentMessageEphemeral(_provider: unknown, _body: unknown, _opts: unknown): void {
    const target = this.target;
    if (target && !this.flushInFlight) {
      target.sendAgentMessageEphemeral?.(_provider, _body, _opts);
      return;
    }

    if (this.cancelled) {
      return;
    }
    this.pushBufferedCall((t) => t.sendAgentMessageEphemeral?.(_provider, _body, _opts), { hint: 'sendAgentMessageEphemeral' });
  }

  sendAgentMessageEphemeralDelta(_provider: unknown, _body: unknown, _opts: unknown): void {
    const target = this.target;
    if (target && !this.flushInFlight) {
      target.sendAgentMessageEphemeralDelta?.(_provider, _body, _opts);
      return;
    }

    // Never buffer deltas: they carry partial appended text chained to live assembly state that no
    // receiver holds while we are detached. Receivers resync from the next full-snapshot checkpoint.
  }

  getEphemeralStreamConnectionEpoch(): number {
    return this.target?.getEphemeralStreamConnectionEpoch?.() ?? 0;
  }

  enqueueAgentMessageCommitted(
    _provider: unknown,
    _body: unknown,
    _opts: unknown,
  ): Promise<Readonly<{ persisted: true; delivered: boolean }>> {
    const target = this.target;
    if (target && !this.flushInFlight) {
      if (typeof target.enqueueAgentMessageCommitted === 'function') {
        return target.enqueueAgentMessageCommitted(_provider, _body, _opts);
      }
      return target
        .sendAgentMessageCommitted(_provider, _body, _opts)
        .then(() => ({ persisted: true as const, delivered: true }));
    }

    const deferred = createDeferredPromise<Readonly<{ persisted: true; delivered: boolean }>>();
    if (this.cancelled) {
      deferred.resolve({ persisted: true, delivered: false });
      return deferred.promise;
    }

    this.pushBufferedCall(
      async (t) => {
        if (typeof t.enqueueAgentMessageCommitted === 'function') {
          deferred.resolve(await t.enqueueAgentMessageCommitted(_provider, _body, _opts));
          return;
        }
        await t.sendAgentMessageCommitted(_provider, _body, _opts);
        deferred.resolve({ persisted: true, delivered: true });
      },
      { hint: 'enqueueAgentMessageCommitted' },
      { onDrop: () => deferred.resolve({ persisted: true, delivered: false }) },
    );
    return deferred.promise;
  }

  sendAgentMessageCommitted(_provider: unknown, _body: unknown, _opts: unknown): Promise<void> {
    const target = this.target;
    if (target && !this.flushInFlight) {
      return target.sendAgentMessageCommitted(_provider, _body, _opts);
    }

    const deferred = createDeferredPromise<void>();
    if (this.cancelled) {
      deferred.resolve();
      return deferred.promise;
    }

    this.pushBufferedCall(
      async (t) => {
        await t.sendAgentMessageCommitted(_provider, _body, _opts);
        deferred.resolve();
      },
      { hint: 'sendAgentMessageCommitted' },
      { onDrop: () => deferred.resolve() },
    );
    return deferred.promise;
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

  onUserMessage(callback: (data: UserMessage) => boolean | void): void {
    this.userMessageHandlers.push(callback);

    const target = this.target;
    if (target?.onUserMessage) {
      target.onUserMessage(callback);
    }
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

  async fetchLatestUserPermissionIntentFromTranscript(
    opts?: { take?: number },
  ): Promise<{ intent: import('@/api/types').PermissionMode; updatedAt: number } | null> {
    const target = this.target;
    if (target && !this.flushInFlight && typeof target.fetchLatestUserPermissionIntentFromTranscript === 'function') {
      return await Promise.resolve(target.fetchLatestUserPermissionIntentFromTranscript(opts));
    }

    return null;
  }

  async refreshSessionSnapshotFromServerBestEffort(opts?: { reason?: 'connect' | 'waitForMetadataUpdate' }): Promise<void> {
    const target = this.target;
    if (target && !this.flushInFlight) {
      if (typeof target.refreshSessionSnapshotFromServerBestEffort === 'function') {
        await target.refreshSessionSnapshotFromServerBestEffort(opts);
      }
      return;
    }

    if (!target && !this.attachPromise) {
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
    const target = this.target;
    if (target && !this.flushInFlight) {
      return await Promise.resolve(target.waitForMetadataUpdate(abortSignal));
    }

    const attached = await this.waitForAttach(abortSignal);
    if (!attached) {
      return false;
    }

    const attachedTarget = this.target;
    if (!attachedTarget) {
      return false;
    }
    return await Promise.resolve(attachedTarget.waitForMetadataUpdate(abortSignal));
  }

  async popPendingMessage(): Promise<boolean> {
    return await this.withAttachedTarget((t) => t.popPendingMessage(), false);
  }

  shouldAttemptPendingMaterialization(opts?: {
    activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
  }): boolean {
    return this.target?.shouldAttemptPendingMaterialization?.(opts) ?? true;
  }

  async reconcilePendingQueueState(opts?: { force?: boolean }): Promise<boolean> {
    return await this.withAttachedTarget((t) => t.reconcilePendingQueueState?.(opts) ?? Promise.resolve(false), false);
  }

  async materializeNextPendingMessageSafely(opts?: {
    reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
    activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
    deliveryTiming?: PendingMaterializationDeliveryTiming;
  }): Promise<MaterializeNextPendingResult> {
    const deferred = { type: 'deferred' as const, reason: 'supervisor_offline' as const };
    if (!this.target && !this.attachPromise) return deferred;
    return await this.withAttachedTarget(
      (t) => t.materializeNextPendingMessageSafely?.(opts) ?? Promise.resolve({ type: 'no_pending' as const }),
      deferred,
    );
  }

  async peekPendingMessageQueueV2Count(): Promise<number> {
    return await this.withAttachedTarget((t) => t.peekPendingMessageQueueV2Count(), 0);
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

  setSessionRuntimeControls(controls: SessionRuntimeControls | null): void {
    this.runtimeControlsSnapshot = controls;
    this.target?.setSessionRuntimeControls(controls);
  }

  async flush(): Promise<void> {
    await this.withAttachedTarget((t) => t.flush(), undefined);
  }

  async close(): Promise<void> {
    await this.withAttachedTarget((t) => t.close(), undefined);
  }

  attach(_real: DeferredApiSessionTarget): Promise<void> {
    const existingPromise = this.attachPromise;
    if (existingPromise) {
      return existingPromise;
    }

    if (this.cancelled) {
      this.attachPromise = Promise.resolve();
      return this.attachPromise;
    }

    this.target = _real;
    this.sessionId = _real.sessionId;

    for (const [method, handler] of this.registeredHandlers.entries()) {
      _real.rpcHandlerManager.registerHandler(method, handler);
    }
    for (const handler of this.userMessageHandlers) {
      _real.onUserMessage?.(handler);
    }
    if (this.runtimeControlsSnapshot !== undefined) {
      _real.setSessionRuntimeControls(this.runtimeControlsSnapshot);
    }

    this.flushInFlight = this.drainBufferedCallsUntilEmpty();
    this.attachPromise = this.flushInFlight.finally(() => {
      this.flushInFlight = null;
    });
    this.flushAttachWaiters(true);
    return this.attachPromise;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;

    const entries = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;

    for (const entry of entries) {
      try {
        entry.onDrop?.();
      } catch {
        // ignore
      }
    }

    this.flushAttachWaiters(false);
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
          else entry.onDrop?.();
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

  private async waitForAttach(abortSignal?: AbortSignal): Promise<boolean> {
    if (this.cancelled) return false;
    if (this.target) return true;
    if (abortSignal?.aborted) return false;

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (attached: boolean) => {
        if (settled) return;
        settled = true;
        abortSignal?.removeEventListener('abort', onAbort);
        resolve(attached);
      };
      const onAbort = () => finish(false);

      this.attachWaiters.push(finish);
      abortSignal?.addEventListener('abort', onAbort, { once: true });

      if (this.cancelled) {
        finish(false);
      } else if (this.target) {
        finish(true);
      } else if (abortSignal?.aborted) {
        finish(false);
      }
    });
  }

  private flushAttachWaiters(attached: boolean): void {
    const waiters = this.attachWaiters;
    this.attachWaiters = [];
    for (const waiter of waiters) {
      try {
        waiter(attached);
      } catch {
        // ignore
      }
    }
  }

  private pushBufferedCall(
    flush: (target: DeferredApiSessionTarget) => void | Promise<void>,
    opts: { hint: string },
    extra?: { onDrop?: () => void; onError?: (error: unknown) => void },
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
        dropped.onDrop?.();
      } catch {
        // ignore
      }
    }
  }
}

function createDeferredPromise<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolveFn: ((value: T) => void) | null = null;
  let rejectFn: ((reason?: unknown) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
    reject: (reason?: unknown) => rejectFn?.(reason),
  };
}

function approxBytesForHint(hint: string): number {
  // Conservative fixed estimate to avoid JSON.stringify overhead in hot paths.
  // This is only used for best-effort buffer limit enforcement.
  return 64 + hint.length;
}

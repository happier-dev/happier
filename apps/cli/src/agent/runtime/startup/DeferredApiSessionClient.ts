import type {
  DeferredSessionBufferEntry,
  DeferredSessionBufferLimits,
  DeferredSessionBufferStats,
} from './deferredSessionBuffer';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerManagerLike } from '@/api/rpc/types';
import type { AgentState, Metadata, UserMessage } from '@/api/types';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import type { PendingMaterializationDeliveryTiming } from '@/api/session/pendingQueueV2Transport';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type { ProviderTranscriptDispatchRequest } from '@/api/session/client/transcript/providerDispatch';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import {
  createEphemeralSendFailure,
  type EphemeralSendResult,
} from '@/api/session/client/transcript/ephemeralSendOutcome';

export type DeferredApiSessionTarget = Readonly<{
  sessionId: string;
  rpcHandlerManager: RpcHandlerManagerLike;
  sendSessionEvent: (event: unknown, id?: string) => void;
  sendProviderMessage: (request: ProviderTranscriptDispatchRequest) => void;
  sendAgentMessage: (provider: unknown, body: unknown, opts?: unknown) => void;
  sendAgentMessageEphemeral?: (provider: unknown, body: unknown, opts: unknown) => EphemeralSendResult;
  sendAgentMessageEphemeralDelta?: (provider: unknown, body: unknown, opts: unknown) => EphemeralSendResult;
  getEphemeralStreamConnectionEpoch?: () => number;
  enqueueAgentMessageCommitted?: (
    provider: unknown,
    body: unknown,
    opts: unknown,
  ) => Promise<Readonly<{ persisted: true; delivered: boolean }>>;
  sendAgentMessageCommitted: (provider: unknown, body: unknown, opts: unknown) => Promise<void>;
  sendUserTextMessage: (text: string, opts?: { localId?: string; meta?: Record<string, unknown> }) => void;
  onUserMessage?: (callback: (data: UserMessage) => boolean | void) => void;
  on?: (eventName: 'metadata-updated', listener: () => void) => unknown;
  off?: (eventName: 'metadata-updated', listener: () => void) => unknown;
  subscribeExecutionRunActivitySnapshots?: (
    listener: (activeCount: number) => void,
  ) => () => void;
  enqueueRegisteredSessionStateFieldMutation?: (
    mutation: RegisteredSessionStateFieldMutationV1,
  ) => void | Promise<void>;
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
  shouldAttemptPendingMaterialization?: () => boolean;
  reconcilePendingProviderInputCustodyBeforeMaterialization?: () => Promise<boolean>;
  reconcilePendingQueueState?: (opts?: { force?: boolean }) => Promise<boolean>;
  materializeNextPendingMessageSafely?: (opts?: {
    reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
    deliveryTiming?: PendingMaterializationDeliveryTiming;
  }) => Promise<MaterializeNextPendingResult>;
  wakePendingMaterialization?: () => void;
  peekPendingMessageQueueV2Count: () => Promise<number>;
  discardPendingMessageQueueV2All: (opts: { reason: 'switch_to_local' | 'manual' }) => Promise<number>;
  discardCommittedMessageLocalIds: (opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }) => Promise<number>;
  setSessionRuntimeControls: (controls: SessionRuntimeControls | null) => void;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}>;

export type DeferredApiSessionAttachOptions = Readonly<{
  beforeBufferedDrain?: (
    target: DeferredApiSessionTarget,
  ) => void | Promise<void>;
}>;

type DeferredExecutionRunActivitySubscription = {
  readonly listener: (activeCount: number) => void;
  unsubscribeTarget: (() => void) | null;
};

/**
 * Deferred session client that buffers writes until a real ApiSessionClient is available.
 */
export class DeferredApiSessionClient {
  sessionId: string;
  private readonly placeholderSessionId: string;
  private readonly limits: DeferredSessionBufferLimits;
  readonly rpcHandlerManager: RpcHandlerManagerLike;
  private readonly registeredHandlers = new Map<string, RpcHandler>();
  private readonly userMessageHandlers: Array<(data: UserMessage) => boolean | void> = [];
  private readonly metadataUpdatedHandlers = new Set<() => void>();
  private readonly boundMetadataUpdatedHandlers = new Set<() => void>();
  private readonly executionRunActivitySubscriptions =
    new Set<DeferredExecutionRunActivitySubscription>();
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
  private pendingPresence: Readonly<{ thinking: boolean; mode: 'local' | 'remote' }> | null = null;
  private pendingWakeDebt = false;
  private attachWaiters: Array<(attached: boolean) => void> = [];
  private runtimeControlsSnapshot: SessionRuntimeControls | null | undefined;

  constructor(opts: { placeholderSessionId: string; limits: DeferredSessionBufferLimits }) {
    this.sessionId = opts.placeholderSessionId;
    this.placeholderSessionId = opts.placeholderSessionId;
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

  sendAgentMessageEphemeral(_provider: unknown, _body: unknown, _opts: unknown): EphemeralSendResult {
    const target = this.target;
    if (target && !this.flushInFlight) {
      const send = target.sendAgentMessageEphemeral;
      return typeof send === 'function'
        ? send.call(target, _provider, _body, _opts)
        : createEphemeralSendFailure('transport_unavailable', target.getEphemeralStreamConnectionEpoch?.() ?? 0);
    }
    // Live state has one buffer/coalescer in the streamed transcript writer. Buffering here would
    // replay a stale snapshot after attach and race the writer's required recovery checkpoint.
    return createEphemeralSendFailure('transport_unavailable', this.getEphemeralStreamConnectionEpoch());
  }

  sendAgentMessageEphemeralDelta(_provider: unknown, _body: unknown, _opts: unknown): EphemeralSendResult {
    const target = this.target;
    if (target && !this.flushInFlight) {
      const send = target.sendAgentMessageEphemeralDelta;
      return typeof send === 'function'
        ? send.call(target, _provider, _body, _opts)
        : createEphemeralSendFailure('transport_unavailable', target.getEphemeralStreamConnectionEpoch?.() ?? 0);
    }

    // Never buffer deltas: they carry partial appended text chained to live assembly state that no
    // receiver holds while we are detached. Receivers resync from the next full-snapshot checkpoint.
    return createEphemeralSendFailure('transport_unavailable', this.getEphemeralStreamConnectionEpoch());
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
    if (target?.onUserMessage && !this.flushInFlight) {
      target.onUserMessage(callback);
    }
  }

  on(eventName: 'metadata-updated', listener: () => void): this {
    this.metadataUpdatedHandlers.add(listener);
    const target = this.target;
    if (target && !this.flushInFlight) {
      try {
        this.bindMetadataUpdatedHandler(target, listener);
      } catch (error) {
        this.metadataUpdatedHandlers.delete(listener);
        throw error;
      }
    }
    return this;
  }

  off(eventName: 'metadata-updated', listener: () => void): this {
    this.metadataUpdatedHandlers.delete(listener);
    if (this.boundMetadataUpdatedHandlers.delete(listener)) {
      this.target?.off?.(eventName, listener);
    }
    return this;
  }

  subscribeExecutionRunActivitySnapshots(
    listener: (activeCount: number) => void,
  ): () => void {
    const subscription: DeferredExecutionRunActivitySubscription = {
      listener,
      unsubscribeTarget: null,
    };
    this.executionRunActivitySubscriptions.add(subscription);

    const target = this.target;
    if (target && !this.flushInFlight) {
      try {
        this.bindExecutionRunActivitySubscription(target, subscription);
      } catch (error) {
        this.executionRunActivitySubscriptions.delete(subscription);
        throw error;
      }
    } else {
      listener(0);
    }

    return () => {
      if (!this.executionRunActivitySubscriptions.delete(subscription)) {
        return;
      }
      subscription.unsubscribeTarget?.();
      subscription.unsubscribeTarget = null;
    };
  }

  async enqueueRegisteredSessionStateFieldMutation(
    mutation: RegisteredSessionStateFieldMutationV1,
  ): Promise<void> {
    const target = this.target;
    if (target && !this.flushInFlight) {
      await this.enqueueRegisteredSessionStateFieldMutationOnTarget(
        target,
        mutation,
      );
      return;
    }

    if (this.cancelled) {
      return;
    }

    this.pushBufferedCall(
      (attachedTarget) =>
        this.enqueueRegisteredSessionStateFieldMutationOnTarget(
          attachedTarget,
          mutation,
        ),
      { hint: 'enqueueRegisteredSessionStateFieldMutation' },
    );
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
    if (target && !this.flushInFlight) {
      target.keepAlive(_thinking, _mode);
      return;
    }
    if (this.cancelled) return;
    this.pendingPresence = { thinking: _thinking, mode: _mode };
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

  shouldAttemptPendingMaterialization(): boolean {
    return this.target?.shouldAttemptPendingMaterialization?.() ?? true;
  }

  async reconcilePendingProviderInputCustodyBeforeMaterialization(): Promise<boolean> {
    return await this.withAttachedTarget(
      (target) => target.reconcilePendingProviderInputCustodyBeforeMaterialization?.() ?? Promise.resolve(true),
      true,
    );
  }

  async reconcilePendingQueueState(opts?: { force?: boolean }): Promise<boolean> {
    return await this.withAttachedTarget((t) => t.reconcilePendingQueueState?.(opts) ?? Promise.resolve(false), false);
  }

  async materializeNextPendingMessageSafely(opts?: {
    reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
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

  wakePendingMaterialization(): void {
    if (this.cancelled) return;
    const target = this.target;
    if (target && !this.flushInFlight) {
      target.wakePendingMaterialization?.();
      return;
    }
    this.pendingWakeDebt = true;
  }

  attach(
    _real: DeferredApiSessionTarget,
    options: DeferredApiSessionAttachOptions = {},
  ): Promise<void> {
    const existingPromise = this.attachPromise;
    if (existingPromise) {
      return existingPromise;
    }

    if (this.cancelled) {
      this.attachPromise = Promise.resolve();
      return this.attachPromise;
    }

    // Establish the delivery barrier before binding any real-session callback.
    // Some observer registrations synchronously publish their current snapshot.
    this.flushInFlight = Promise.resolve();
    this.target = _real;
    this.sessionId = _real.sessionId;

    const preparationAndDrain = Promise.resolve().then(async () => {
      this.assertRetainedTargetObserverSupport(_real);
      for (const [method, handler] of this.registeredHandlers.entries()) {
        _real.rpcHandlerManager.registerHandler(method, handler);
      }
      this.bindRetainedTargetObservers(_real);
      if (this.runtimeControlsSnapshot !== undefined) {
        _real.setSessionRuntimeControls(this.runtimeControlsSnapshot);
      }

      await options.beforeBufferedDrain?.(_real);
      if (this.cancelled) return;

      // Include observers registered while preparation was awaiting authority.
      this.bindRetainedTargetObservers(_real);
      await this.drainBufferedCallsUntilEmpty();
      if (this.cancelled) return;

      // Authority is established and the generic FIFO is empty. Release the
      // delivery barrier before user-input catch-up, presence, and pending wake.
      if (this.flushInFlight === preparationAndDrain) {
        this.flushInFlight = null;
      }
      for (const handler of this.userMessageHandlers) {
        _real.onUserMessage?.(handler);
      }
      const pendingPresence = this.pendingPresence;
      this.pendingPresence = null;
      if (pendingPresence) {
        _real.keepAlive(pendingPresence.thinking, pendingPresence.mode);
      }
      if (this.pendingWakeDebt) {
        this.pendingWakeDebt = false;
        _real.wakePendingMaterialization?.();
      }
    });
    this.flushInFlight = preparationAndDrain;
    const attachPromise = preparationAndDrain
      .then(() => {
        this.flushAttachWaiters(true);
      })
      .catch((error: unknown) => {
        this.detachRetainedTargetObservers(_real);
        if (this.target === _real) {
          this.target = null;
          this.sessionId = this.placeholderSessionId;
        }
        this.flushAttachWaiters(false);
        throw error;
      })
      .finally(() => {
        if (this.flushInFlight === preparationAndDrain) {
          this.flushInFlight = null;
        }
      });
    const retryableAttachPromise = attachPromise.catch((error: unknown) => {
      this.attachPromise = null;
      throw error;
    });
    this.attachPromise = retryableAttachPromise;
    return retryableAttachPromise;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.pendingPresence = null;
    this.pendingWakeDebt = false;
    const target = this.target;
    if (target) {
      this.detachRetainedTargetObservers(target);
    }

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

  private bindRetainedTargetObservers(target: DeferredApiSessionTarget): void {
    this.assertRetainedTargetObserverSupport(target);
    for (const listener of this.metadataUpdatedHandlers) {
      this.bindMetadataUpdatedHandler(target, listener);
    }
    for (const subscription of this.executionRunActivitySubscriptions) {
      this.bindExecutionRunActivitySubscription(target, subscription);
    }
  }

  private assertRetainedTargetObserverSupport(
    target: DeferredApiSessionTarget,
  ): void {
    if (
      this.metadataUpdatedHandlers.size > 0 &&
      (
        typeof target.on !== 'function' ||
        typeof target.off !== 'function'
      )
    ) {
      throw new Error(
        'Attached session target does not support metadata observer binding and detachment',
      );
    }
    if (
      this.executionRunActivitySubscriptions.size > 0 &&
      typeof target.subscribeExecutionRunActivitySnapshots !== 'function'
    ) {
      throw new Error(
        'Attached session target does not support execution activity snapshots',
      );
    }
  }

  private bindMetadataUpdatedHandler(
    target: DeferredApiSessionTarget,
    listener: () => void,
  ): void {
    if (this.boundMetadataUpdatedHandlers.has(listener)) {
      return;
    }
    if (
      typeof target.on !== 'function' ||
      typeof target.off !== 'function'
    ) {
      throw new Error(
        'Attached session target does not support metadata observer binding and detachment',
      );
    }

    this.boundMetadataUpdatedHandlers.add(listener);
    try {
      target.on('metadata-updated', listener);
    } catch (error) {
      this.boundMetadataUpdatedHandlers.delete(listener);
      throw error;
    }
  }

  private bindExecutionRunActivitySubscription(
    target: DeferredApiSessionTarget,
    subscription: DeferredExecutionRunActivitySubscription,
  ): void {
    if (subscription.unsubscribeTarget) {
      return;
    }
    if (typeof target.subscribeExecutionRunActivitySnapshots !== 'function') {
      throw new Error(
        'Attached session target does not support execution activity snapshots',
      );
    }

    const unsubscribeTarget =
      target.subscribeExecutionRunActivitySnapshots(subscription.listener);
    if (!this.executionRunActivitySubscriptions.has(subscription)) {
      unsubscribeTarget();
      return;
    }
    subscription.unsubscribeTarget = unsubscribeTarget;
  }

  private detachRetainedTargetObservers(target: DeferredApiSessionTarget): void {
    for (const listener of this.boundMetadataUpdatedHandlers) {
      target.off?.('metadata-updated', listener);
    }
    this.boundMetadataUpdatedHandlers.clear();

    for (const subscription of this.executionRunActivitySubscriptions) {
      subscription.unsubscribeTarget?.();
      subscription.unsubscribeTarget = null;
    }
  }

  private async enqueueRegisteredSessionStateFieldMutationOnTarget(
    target: DeferredApiSessionTarget,
    mutation: RegisteredSessionStateFieldMutationV1,
  ): Promise<void> {
    if (typeof target.enqueueRegisteredSessionStateFieldMutation !== 'function') {
      throw new Error(
        'Attached session target does not support registered session-state mutations',
      );
    }
    await target.enqueueRegisteredSessionStateFieldMutation(mutation);
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

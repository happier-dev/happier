import type {
  DeferredSessionBufferEntry,
  DeferredSessionBufferLimits,
  DeferredSessionBufferStats,
} from './deferredSessionBuffer';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerManagerLike } from '@/api/rpc/types';

export type DeferredApiSessionTarget = Readonly<{
  sessionId: string;
  rpcHandlerManager: RpcHandlerManagerLike;
  sendSessionEvent: (event: unknown, id?: string) => void;
  sendClaudeSessionMessage: (message: unknown, meta?: unknown) => void;
  sendAgentMessage: (provider: unknown, body: unknown, opts?: unknown) => void;
  sendCodexMessage: (body: unknown) => void;
  sendUserTextMessage: (text: string, opts?: { localId?: string; meta?: Record<string, unknown> }) => void;
  updateMetadata: (updater: (metadata: any) => any) => void | Promise<void>;
  updateAgentState: (updater: (state: any) => any) => void | Promise<void>;
  keepAlive: (thinking: boolean, mode: 'local' | 'remote') => void;
  getMetadataSnapshot: () => unknown;
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  popPendingMessage: () => Promise<boolean>;
  peekPendingMessageQueueV2Count: () => Promise<number>;
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
  private readonly registeredHandlers = new Map<string, RpcHandler>();
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

  updateMetadata(_updater: (metadata: any) => any): void | Promise<void> {
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
      { onDrop: () => deferred.resolve() },
    );
    return deferred.promise;
  }

  updateAgentState(_updater: (state: any) => any): void | Promise<void> {
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
      { onDrop: () => deferred.resolve() },
    );
    return deferred.promise;
  }

  keepAlive(_thinking: boolean, _mode: 'local' | 'remote'): void {
    const target = this.target;
    if (!target) return;
    target.keepAlive(_thinking, _mode);
  }

  getMetadataSnapshot(): unknown {
    const target = this.target;
    if (!target) return null;
    return target.getMetadataSnapshot();
  }

  async waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean> {
    if (abortSignal?.aborted) return false;
    return await this.withAttachedTarget((t) => t.waitForMetadataUpdate(abortSignal), false);
  }

  async popPendingMessage(): Promise<boolean> {
    return await this.withAttachedTarget((t) => t.popPendingMessage(), false);
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

  async flush(): Promise<void> {
    await this.withAttachedTarget((t) => t.flush(), undefined);
  }

  async close(): Promise<void> {
    await this.withAttachedTarget((t) => t.close(), undefined);
  }

  attach(_real: DeferredApiSessionTarget): Promise<void> {
    const existingPromise = this.attachPromise;
    if (existingPromise) return existingPromise;

    if (this.cancelled) {
      this.attachPromise = Promise.resolve();
      return this.attachPromise;
    }

    this.target = _real;
    this.sessionId = _real.sessionId;

    for (const [method, handler] of this.registeredHandlers.entries()) {
      _real.rpcHandlerManager.registerHandler(method, handler);
    }

    this.flushInFlight = this.drainBufferedCallsUntilEmpty();
    this.attachPromise = this.flushInFlight.finally(() => {
      this.flushInFlight = null;
    });
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
      } catch {
        hadError = true;
        try {
          entry.onDrop?.();
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

  private pushBufferedCall(
    flush: (target: DeferredApiSessionTarget) => void | Promise<void>,
    opts: { hint: string },
    extra?: { onDrop?: () => void },
  ): void {
    const approxBytes = approxBytesForHint(opts.hint);
    this.buffer.push({ approxBytes, flush, onDrop: extra?.onDrop });
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

function createDeferredPromise<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
  };
}

function approxBytesForHint(hint: string): number {
  // Conservative fixed estimate to avoid JSON.stringify overhead in hot paths.
  // This is only used for best-effort buffer limit enforcement.
  return 64 + hint.length;
}

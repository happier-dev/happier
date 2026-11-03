import { logger } from '@/ui/logger';

export type MessageQueueBatch<Mode, Message> = {
  message: Message;
  mode: Mode;
  isolate: boolean;
  hash: string;
};

type QueueItem<Mode, Message> = {
  message: Message;
  mode: Mode;
  modeHash: string;
  isolate: boolean;
  contextOnly?: true;
};

type MessageBatcher<Message> = (messages: Message[]) => Message;

function defaultStringBatcher(messages: unknown[]): string {
  if (!messages.every((value) => typeof value === 'string')) {
    throw new Error('MessageQueue2: non-string message without a custom batcher');
  }
  return (messages as string[]).join('\n');
}

/**
 * A mode-aware message queue that stores messages with their modes.
 * Returns consistent batches of messages with the same mode.
 */
export class MessageQueue2<Mode, Message = string> {
  public queue: Array<QueueItem<Mode, Message>> = []; // public for tests
  private waiter: ((hasMessages: boolean) => void) | null = null;
  private closed = false;
  private onMessageHandler: ((message: Message, mode: Mode) => void) | null = null;
  readonly modeHasher: (mode: Mode) => string;
  private readonly batcher: MessageBatcher<Message>;
  private readonly isContextOnly: (message: Message, mode: Mode) => boolean;
  private readonly withContext: (message: Message, context: Message[]) => Message;
  private lastWaitLogAt = 0;
  private lastAbortLogAt = 0;
  private readonly changeListeners = new Set<(collected?: MessageQueueBatch<Mode, Message>) => void>();

  subscribeChanges(listener: (collected?: MessageQueueBatch<Mode, Message>) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  private notifyChanged(collected?: MessageQueueBatch<Mode, Message>): void {
    for (const listener of this.changeListeners) listener(collected);
  }

  private notifyInserted(message: Message, mode: Mode, contextOnly: boolean): void {
    this.notifyChanged();
    if (contextOnly) return;
    this.onMessageHandler?.(message, mode);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(true);
    }
  }

  constructor(
    modeHasher: (mode: Mode) => string,
    opts?: {
      onMessageHandler?: ((message: Message, mode: Mode) => void) | null;
      batcher?: MessageBatcher<Message>;
      /** Retain information for the next real input; it must not trigger a turn. */
      isContextOnly?: (message: Message, mode: Mode) => boolean;
      withContext?: (message: Message, context: Message[]) => Message;
    },
  ) {
    this.modeHasher = modeHasher;
    this.onMessageHandler = opts?.onMessageHandler ?? null;
    this.batcher = opts?.batcher ?? (defaultStringBatcher as unknown as MessageBatcher<Message>);
    this.isContextOnly = opts?.isContextOnly ?? (() => false);
    this.withContext = opts?.withContext ?? ((message, context) => this.batcher([...context, message]));
    logger.debug('[MessageQueue2] Initialized');
  }

  setOnMessage(handler: ((message: Message, mode: Mode) => void) | null): void {
    this.onMessageHandler = handler;
  }

  getContextOnlyMessages(): readonly Message[] {
    return this.queue.filter(item => item.contextOnly).map(item => item.message);
  }

  push(message: Message, mode: Mode): void {
    if (this.closed) {
      throw new Error('Cannot push to closed queue');
    }

    const modeHash = this.modeHasher(mode);

    const contextOnly = this.isContextOnly(message, mode);
    this.queue.push({
      message,
      mode,
      modeHash,
      isolate: false,
      ...(contextOnly ? { contextOnly: true as const } : {}),
    });
    this.notifyInserted(message, mode, contextOnly);
  }

  pushImmediate(message: Message, mode: Mode): void {
    this.push(message, mode);
  }

  /**
   * Keep this prompt as its own delivery while retaining all already-admitted
   * peers. Structured input cannot be batched because each entry carries its
   * own dispatch-time context, but admitting it must not erase prior input.
   */
  pushIsolate(message: Message, mode: Mode): void {
    if (this.closed) {
      throw new Error('Cannot push to closed queue');
    }

    const modeHash = this.modeHasher(mode);

    const contextOnly = this.isContextOnly(message, mode);
    this.queue.push({
      message,
      mode,
      modeHash,
      isolate: true,
      ...(contextOnly ? { contextOnly: true as const } : {}),
    });
    this.notifyInserted(message, mode, contextOnly);
  }

  pushIsolateAndClear(message: Message, mode: Mode): void {
    if (this.closed) {
      throw new Error('Cannot push to closed queue');
    }

    const modeHash = this.modeHasher(mode);
    this.queue = this.queue.filter(item => item.contextOnly);

    const contextOnly = this.isContextOnly(message, mode);
    this.queue.push({
      message,
      mode,
      modeHash,
      isolate: true,
      ...(contextOnly ? { contextOnly: true as const } : {}),
    });
    this.notifyInserted(message, mode, contextOnly);
  }

  unshift(message: Message, mode: Mode): void {
    if (this.closed) {
      throw new Error('Cannot unshift to closed queue');
    }

    const modeHash = this.modeHasher(mode);

    const contextOnly = this.isContextOnly(message, mode);
    this.queue.unshift({
      message,
      mode,
      modeHash,
      isolate: false,
      ...(contextOnly ? { contextOnly: true as const } : {}),
    });
    this.notifyInserted(message, mode, contextOnly);
  }

  reset(): void {
    this.queue = [];
    this.closed = false;
    this.notifyChanged();

    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(false);
    }
  }

  close(): void {
    this.closed = true;
    this.notifyChanged();

    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(false);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  size(): number {
    return this.queue.reduce((size, item) => size + (item.contextOnly ? 0 : 1), 0);
  }

  hasMatching(predicate: (message: Message, mode: Mode) => boolean): boolean {
    return this.queue.some(item => predicate(item.message, item.mode));
  }

  discardMatching(predicate: (message: Message, mode: Mode) => boolean): number {
    const before = this.queue.length;
    this.queue = this.queue.filter((item) => !predicate(item.message, item.mode));
    if (before !== this.queue.length) this.notifyChanged();
    return before - this.queue.length;
  }

  /**
   * Wait for messages and return all messages with the same mode as a single batch.
   *
   * NOTE: This historically returned a string (joined by newlines). The method name is kept for
   * backwards compatibility with string queues.
   */
  async waitForMessagesAndGetAsString(abortSignal?: AbortSignal): Promise<MessageQueueBatch<Mode, Message> | null> {
    if (this.size() > 0) {
      return this.collectBatch();
    }

    if (this.closed || abortSignal?.aborted) {
      return null;
    }

    const hasMessages = await this.waitForMessages(abortSignal);
    if (!hasMessages) {
      return null;
    }

    return this.collectBatch();
  }

  async waitForMessagesSignal(abortSignal?: AbortSignal): Promise<boolean> {
    if (this.size() > 0) {
      return true;
    }
    if (this.closed || abortSignal?.aborted) {
      return false;
    }
    return await this.waitForMessages(abortSignal);
  }

  /**
   * Resolve once the queue holds more than `depth` messages, the queue is closed or reset, or
   * `abortSignal` aborts. Unlike `waitForMessagesSignal` this wait is edge-triggered, so it is
   * safe to await while messages are already queued: an admission park that must not consume
   * the queue sleeps on growth here instead of spinning on the level-triggered signal.
   *
   * Resolves `true` when the queue grew beyond `depth`, and `false` when it closed, reset, or
   * the signal aborted.
   */
  async waitForQueueGrowthBeyond(depth: number, abortSignal?: AbortSignal): Promise<boolean> {
    while (!abortSignal?.aborted) {
      if (this.size() > depth) {
        return true;
      }
      if (this.closed) {
        return false;
      }
      if (!(await this.waitForQueueMutation(abortSignal))) {
        return this.size() > depth;
      }
    }
    return false;
  }

  /**
   * One-shot wait for the next queue mutation (push, reset, close) without the
   * "already non-empty" short-circuit of `waitForMessages`. Shares the single-waiter slot.
   */
  private waitForQueueMutation(abortSignal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let abortHandler: (() => void) | null = null;

      const waiterFunc = (hasMessages: boolean) => {
        if (abortHandler && abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }
        resolve(hasMessages);
      };

      if (abortSignal) {
        abortHandler = () => {
          if (this.waiter === waiterFunc) {
            this.waiter = null;
          }
          resolve(false);
        };
        abortSignal.addEventListener('abort', abortHandler);
      }

      if (this.closed || abortSignal?.aborted) {
        if (abortHandler && abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }
        resolve(false);
        return;
      }

      if (this.waiter) {
        if (abortHandler && abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }
        reject(new Error('MessageQueue2 already has an active waiter'));
        return;
      }

      this.waiter = waiterFunc;
    });
  }

  private collectBatch(): MessageQueueBatch<Mode, Message> | null {
    if (this.size() === 0) {
      return null;
    }

    const context = this.queue.filter(item => item.contextOnly).map(item => item.message);
    // Context selection happens after collection. Keep originals available until
    // the consumer discards the exact identities represented in its final input.
    const firstItemIndex = this.queue.findIndex(item => !item.contextOnly);
    const firstItem = this.queue[firstItemIndex];
    const sameModeMessages: Message[] = [];
    const mode = firstItem.mode;
    const isolate = firstItem.isolate;
    const targetModeHash = firstItem.modeHash;

    if (firstItem.isolate) {
      const item = this.queue.splice(firstItemIndex, 1)[0];
      sameModeMessages.push(item.message);
    } else {
      let index = firstItemIndex;
      while (index < this.queue.length) {
        const item = this.queue[index];
        if (item.contextOnly) {
          index++;
          continue;
        }
        if (item.modeHash !== targetModeHash || item.isolate) break;
        this.queue.splice(index, 1);
        sameModeMessages.push(item.message);
      }
    }

    const combined = this.batcher(sameModeMessages);
    const combinedMessage = context.length === 0 ? combined : this.withContext(combined, context);
    const batch = {
      message: combinedMessage,
      mode,
      hash: targetModeHash,
      isolate,
    };
    this.notifyChanged(batch);
    return batch;
  }

  private waitForMessages(abortSignal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let abortHandler: (() => void) | null = null;

      const waiterFunc = (hasMessages: boolean) => {
        if (abortHandler && abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }
        resolve(hasMessages);
      };

      if (abortSignal) {
        abortHandler = () => {
          const reason = (abortSignal as any)?.reason;
          if (reason !== 'sessionProviderInputConsumer' && reason !== 'sessionProviderInputConsumer-meta-false') {
            const now = Date.now();
            if (now - this.lastAbortLogAt > 2000) {
              this.lastAbortLogAt = now;
              logger.debug('[MessageQueue2] Wait aborted');
            }
          }
          if (this.waiter === waiterFunc) {
            this.waiter = null;
          }
          resolve(false);
        };
        abortSignal.addEventListener('abort', abortHandler);
      }

      if (this.size() > 0) {
        if (abortHandler && abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }
        resolve(true);
        return;
      }

      if (this.closed || abortSignal?.aborted) {
        if (abortHandler && abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }
        resolve(false);
        return;
      }

      if (this.waiter) {
        if (abortHandler && abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }
        reject(new Error('MessageQueue2 already has an active waiter'));
        return;
      }

      this.waiter = waiterFunc;
      {
        const now = Date.now();
        if (now - this.lastWaitLogAt > 2000) {
          this.lastWaitLogAt = now;
          logger.debug('[MessageQueue2] Waiting for messages...');
        }
      }
    });
  }
}

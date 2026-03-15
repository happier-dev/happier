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
  private lastWaitLogAt = 0;
  private lastAbortLogAt = 0;

  constructor(
    modeHasher: (mode: Mode) => string,
    opts?: {
      onMessageHandler?: ((message: Message, mode: Mode) => void) | null;
      batcher?: MessageBatcher<Message>;
    },
  ) {
    this.modeHasher = modeHasher;
    this.onMessageHandler = opts?.onMessageHandler ?? null;
    this.batcher = opts?.batcher ?? (defaultStringBatcher as unknown as MessageBatcher<Message>);
    logger.debug('[MessageQueue2] Initialized');
  }

  setOnMessage(handler: ((message: Message, mode: Mode) => void) | null): void {
    this.onMessageHandler = handler;
  }

  push(message: Message, mode: Mode): void {
    if (this.closed) {
      throw new Error('Cannot push to closed queue');
    }

    const modeHash = this.modeHasher(mode);

    this.queue.push({
      message,
      mode,
      modeHash,
      isolate: false,
    });

    if (this.onMessageHandler) {
      this.onMessageHandler(message, mode);
    }

    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(true);
    }
  }

  pushImmediate(message: Message, mode: Mode): void {
    this.push(message, mode);
  }

  pushIsolateAndClear(message: Message, mode: Mode): void {
    if (this.closed) {
      throw new Error('Cannot push to closed queue');
    }

    const modeHash = this.modeHasher(mode);
    this.queue = [];

    this.queue.push({
      message,
      mode,
      modeHash,
      isolate: true,
    });

    if (this.onMessageHandler) {
      this.onMessageHandler(message, mode);
    }

    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(true);
    }
  }

  unshift(message: Message, mode: Mode): void {
    if (this.closed) {
      throw new Error('Cannot unshift to closed queue');
    }

    const modeHash = this.modeHasher(mode);

    this.queue.unshift({
      message,
      mode,
      modeHash,
      isolate: false,
    });

    if (this.onMessageHandler) {
      this.onMessageHandler(message, mode);
    }

    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(true);
    }
  }

  reset(): void {
    this.queue = [];
    this.closed = false;

    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(false);
    }
  }

  close(): void {
    this.closed = true;

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
    return this.queue.length;
  }

  /**
   * Wait for messages and return all messages with the same mode as a single batch.
   *
   * NOTE: This historically returned a string (joined by newlines). The method name is kept for
   * backwards compatibility with string queues.
   */
  async waitForMessagesAndGetAsString(abortSignal?: AbortSignal): Promise<MessageQueueBatch<Mode, Message> | null> {
    if (this.queue.length > 0) {
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
    if (this.queue.length > 0) {
      return true;
    }
    if (this.closed || abortSignal?.aborted) {
      return false;
    }
    return await this.waitForMessages(abortSignal);
  }

  private collectBatch(): MessageQueueBatch<Mode, Message> | null {
    if (this.queue.length === 0) {
      return null;
    }

    const firstItem = this.queue[0];
    const sameModeMessages: Message[] = [];
    const mode = firstItem.mode;
    const isolate = firstItem.isolate;
    const targetModeHash = firstItem.modeHash;

    if (firstItem.isolate) {
      const item = this.queue.shift()!;
      sameModeMessages.push(item.message);
    } else {
      while (this.queue.length > 0 && this.queue[0].modeHash === targetModeHash && !this.queue[0].isolate) {
        const item = this.queue.shift()!;
        sameModeMessages.push(item.message);
      }
    }

    const combinedMessage = this.batcher(sameModeMessages);

    return {
      message: combinedMessage,
      mode,
      hash: targetModeHash,
      isolate,
    };
  }

  private waitForMessages(abortSignal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let abortHandler: (() => void) | null = null;

      if (abortSignal) {
        abortHandler = () => {
          const reason = (abortSignal as any)?.reason;
          if (reason !== 'waitForMessagesOrPending') {
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

      const waiterFunc = (hasMessages: boolean) => {
        if (abortHandler && abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }
        resolve(hasMessages);
      };

      if (this.queue.length > 0) {
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

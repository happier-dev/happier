import { logger } from '@/ui/logger';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import type { PendingProviderAction } from '@happier-dev/protocol';

export type { PendingProviderAction } from '@happier-dev/protocol';

export type MessageQueueBatch<Mode, Message> = {
  message: Message;
  mode: Mode;
  isolate: boolean;
  hash: string;
  /**
   * Owed-delivery watermark attribution (A3-HIGH-1): max server user-row seq among the items
   * consumed into this batch, or null when none carried one. `userMessageLocalIds` carries the
   * same ownership proof for rows whose server seq is not known until the socket echo arrives.
   */
  maxUserMessageSeq: number | null;
  userMessageLocalIds: string[];
  providerAcceptancePending?: boolean;
  pendingProviderAction?: PendingProviderAction;
  pendingRequestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
  providerPromptMeta?: unknown;
};

type EnqueueMessageOptions = {
  userMessageSeq?: number | null;
  userMessageLocalId?: string | null;
  userMessageLocalIds?: readonly string[] | null;
  providerAcceptancePending?: boolean | null;
  pendingProviderAction?: PendingProviderAction;
  pendingRequestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
  /** Original input metadata consumed by the shared provider-prompt finalizer. */
  providerPromptMeta?: unknown;
};

type QueueItem<Mode, Message> = {
  message: Message;
  mode: Mode;
  modeHash: string;
  isolate: boolean;
  userMessageSeq: number | null;
  userMessageLocalIds: string[];
  providerAcceptancePending: boolean;
  pendingProviderAction?: PendingProviderAction;
  pendingRequestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
  providerPromptMeta?: unknown;
};

type MessageBatcher<Message> = (messages: Message[]) => Message;

function normalizeUserMessageSeq(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeUserMessageLocalIds(input?: {
  userMessageLocalId?: string | null;
  userMessageLocalIds?: readonly string[] | null;
}): string[] {
  const values = [
    ...(input?.userMessageLocalId ? [input.userMessageLocalId] : []),
    ...(input?.userMessageLocalIds ?? []),
  ];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const id = readNonBlankOpaqueIdentifier(value) ?? '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

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

  push(
    message: Message,
    mode: Mode,
    opts?: EnqueueMessageOptions,
  ): void {
    if (this.closed) {
      throw new Error('Cannot push to closed queue');
    }

    const modeHash = this.modeHasher(mode);

    this.queue.push({
      message,
      mode,
      modeHash,
      isolate: false,
      userMessageSeq: normalizeUserMessageSeq(opts?.userMessageSeq),
      userMessageLocalIds: normalizeUserMessageLocalIds(opts),
      providerAcceptancePending: opts?.providerAcceptancePending === true,
      ...(opts?.providerPromptMeta == null ? {} : { providerPromptMeta: opts.providerPromptMeta }),
      ...(opts?.pendingProviderAction ? { pendingProviderAction: opts.pendingProviderAction } : {}),
      ...(opts?.pendingRequestedAction ? { pendingRequestedAction: opts.pendingRequestedAction } : {}),
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

  pushIsolateAndClear(
    message: Message,
    mode: Mode,
    opts?: EnqueueMessageOptions,
  ): void {
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
      userMessageSeq: normalizeUserMessageSeq(opts?.userMessageSeq),
      userMessageLocalIds: normalizeUserMessageLocalIds(opts),
      providerAcceptancePending: opts?.providerAcceptancePending === true,
      ...(opts?.providerPromptMeta == null ? {} : { providerPromptMeta: opts.providerPromptMeta }),
      ...(opts?.pendingProviderAction ? { pendingProviderAction: opts.pendingProviderAction } : {}),
      ...(opts?.pendingRequestedAction ? { pendingRequestedAction: opts.pendingRequestedAction } : {}),
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

  unshift(
    message: Message,
    mode: Mode,
    opts?: EnqueueMessageOptions,
  ): void {
    if (this.closed) {
      throw new Error('Cannot unshift to closed queue');
    }

    const modeHash = this.modeHasher(mode);

    this.queue.unshift({
      message,
      mode,
      modeHash,
      isolate: false,
      userMessageSeq: normalizeUserMessageSeq(opts?.userMessageSeq),
      userMessageLocalIds: normalizeUserMessageLocalIds(opts),
      providerAcceptancePending: opts?.providerAcceptancePending === true,
      ...(opts?.providerPromptMeta == null ? {} : { providerPromptMeta: opts.providerPromptMeta }),
      ...(opts?.pendingProviderAction ? { pendingProviderAction: opts.pendingProviderAction } : {}),
      ...(opts?.pendingRequestedAction ? { pendingRequestedAction: opts.pendingRequestedAction } : {}),
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
    let maxUserMessageSeq: number | null = null;
    const userMessageLocalIdSet = new Set<string>();
    const userMessageLocalIds: string[] = [];
    let providerAcceptancePending = false;
    const pendingProviderAction = firstItem.pendingProviderAction;
    const consume = (item: QueueItem<Mode, Message>): void => {
      sameModeMessages.push(item.message);
      if (item.userMessageSeq !== null) {
        maxUserMessageSeq = Math.max(maxUserMessageSeq ?? -1, item.userMessageSeq);
      }
      for (const localId of item.userMessageLocalIds) {
        if (userMessageLocalIdSet.has(localId)) continue;
        userMessageLocalIdSet.add(localId);
        userMessageLocalIds.push(localId);
      }
      providerAcceptancePending = providerAcceptancePending || item.providerAcceptancePending;
    };

    if (firstItem.isolate || firstItem.pendingProviderAction || firstItem.providerAcceptancePending || firstItem.providerPromptMeta != null) {
      consume(this.queue.shift()!);
    } else {
      while (
        this.queue.length > 0
        && this.queue[0].modeHash === targetModeHash
        && !this.queue[0].isolate
        && !this.queue[0].providerAcceptancePending
        && this.queue[0].providerPromptMeta == null
        && this.queue[0].pendingProviderAction === pendingProviderAction
      ) {
        consume(this.queue.shift()!);
      }
    }

    const combinedMessage = this.batcher(sameModeMessages);

    return {
      message: combinedMessage,
      mode,
      hash: targetModeHash,
      isolate,
      maxUserMessageSeq,
      userMessageLocalIds,
      providerAcceptancePending,
      ...(firstItem.providerPromptMeta == null ? {} : { providerPromptMeta: firstItem.providerPromptMeta }),
      ...(pendingProviderAction ? { pendingProviderAction } : {}),
      ...(firstItem.pendingRequestedAction ? { pendingRequestedAction: firstItem.pendingRequestedAction } : {}),
    };
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
          if (reason !== 'sessionProviderInputConsumer') {
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

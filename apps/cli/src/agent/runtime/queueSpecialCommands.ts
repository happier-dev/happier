import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

export type SpecialCommandQueue<Mode, Message> = Pick<MessageQueue2<Mode, Message>,
  'push' | 'unshift' | 'pushIsolateAndClear'>;

type EnqueueOptions<Mode, Message> = NonNullable<Parameters<MessageQueue2<Mode, Message>['push']>[2]>;

/**
 * Push user input to a mode-aware queue, handling slash-style clear commands consistently.
 */
export function pushMessageToQueueWithSpecialCommands<Mode, Message>(opts: EnqueueOptions<Mode, Message> & {
  queue: SpecialCommandQueue<Mode, Message>;
  message: Message;
  text: string;
  mode: Mode;
  prioritize?: boolean;
}): void {
  const { queue, message, text, mode, prioritize, ...enqueueOptions } = opts;
  const special = parseSpecialCommand(text);
  const queueOptions = {
    ...enqueueOptions,
    userMessageSeq: opts.userMessageSeq ?? null,
    userMessageLocalId: opts.userMessageLocalId ?? null,
    userMessageLocalIds: opts.userMessageLocalIds ?? null,
    ...(opts.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
    ...(opts.pendingProviderAction ? { pendingProviderAction: opts.pendingProviderAction } : {}),
    ...(opts.pendingRequestedAction ? { pendingRequestedAction: opts.pendingRequestedAction } : {}),
  };
  if (special.type === 'clear') {
    queue.pushIsolateAndClear(message, mode, queueOptions);
    return;
  }
  if (prioritize) {
    queue.unshift(message, mode, queueOptions);
  } else {
    queue.push(message, mode, queueOptions);
  }
}

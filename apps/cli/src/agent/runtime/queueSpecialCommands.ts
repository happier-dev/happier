import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import type { SessionCompactResultV1 } from '@happier-dev/protocol/sessions/control/index';
import type { MessageQueue2 } from './modeMessageQueue';

export type SpecialCommandQueue<Mode, Message> = {
  push: (message: Message, mode: Mode) => void;
  pushIsolate: (message: Message, mode: Mode) => void;
  pushIsolateAndClear: (message: Message, mode: Mode) => void;
};

/**
 * Push user input to a mode-aware queue, handling slash-style clear commands consistently.
 */
export function pushMessageToQueueWithSpecialCommands<Mode, Message>(opts: {
  queue: SpecialCommandQueue<Mode, Message>;
  message: Message;
  text: string;
  mode: Mode;
  isolate?: boolean;
}): void {
  const special = parseSpecialCommand(opts.text);
  if (special.type === 'clear') {
    opts.queue.pushIsolateAndClear(opts.message, opts.mode);
    return;
  }
  if (special.type === 'compact' || opts.isolate) opts.queue.pushIsolate(opts.message, opts.mode);
  else opts.queue.push(opts.message, opts.mode);
}

export type ManualCompactionQueue<Mode, Message> = Readonly<{
  enqueue: (message: Message, mode: Mode) => SessionCompactResultV1;
  setRunning: (running: boolean) => void;
}>;

/** Shared admission for Action controls and materialized slash commands. */
export function createManualCompactionQueue<Mode, Message>(opts: {
  queue: SpecialCommandQueue<Mode, Message> & Pick<MessageQueue2<Mode, Message>, 'hasMatching'>;
  readText: (message: Message) => string;
  isAvailable: () => boolean;
}): ManualCompactionQueue<Mode, Message> {
  let running = false;
  return {
    enqueue: (message, mode) => {
      if (!opts.isAvailable()) return { status: 'unsupported' };
      if (running || opts.queue.hasMatching(item => parseSpecialCommand(opts.readText(item)).type === 'compact')) {
        return { status: 'already_pending' };
      }
      pushMessageToQueueWithSpecialCommands({ queue: opts.queue, message, text: opts.readText(message), mode });
      return { status: 'admitted' };
    },
    setRunning: value => { running = value; },
  };
}

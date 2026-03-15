import { parseSpecialCommand } from '@/cli/parsers/specialCommands';

export type SpecialCommandQueue<Mode, Message> = {
  push: (message: Message, mode: Mode) => void;
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
}): void {
  const special = parseSpecialCommand(opts.text);
  if (special.type === 'clear') {
    opts.queue.pushIsolateAndClear(opts.message, opts.mode);
    return;
  }
  opts.queue.push(opts.message, opts.mode);
}

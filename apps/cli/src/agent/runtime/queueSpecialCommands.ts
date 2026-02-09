import { parseSpecialCommand } from '@/cli/parsers/specialCommands';

export type SpecialCommandQueue<Mode> = {
  push: (message: string, mode: Mode) => void;
  pushIsolateAndClear: (message: string, mode: Mode) => void;
};

/**
 * Push user input to a mode-aware queue, handling slash-style clear commands consistently.
 */
export function pushTextToMessageQueueWithSpecialCommands<Mode>(opts: {
  queue: SpecialCommandQueue<Mode>;
  text: string;
  mode: Mode;
}): void {
  const special = parseSpecialCommand(opts.text);
  if (special.type === 'clear') {
    opts.queue.pushIsolateAndClear(opts.text, opts.mode);
    return;
  }
  opts.queue.push(opts.text, opts.mode);
}

import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

import { discardQueuedAndPendingForLocalSwitch } from '../discardQueuedAndPendingForLocalSwitch';

const terminal = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));

// Readline is the terminal boundary; the confirmation and discard policies stay real.
vi.mock('node:readline', () => ({
  createInterface: () => Object.assign(new EventEmitter(), {
    question: terminal.question,
    close: terminal.close,
  }),
}));

afterEach(() => vi.restoreAllMocks());

it.each(['prompt', 'pending-read', 'before-switch'] as const)(
  'cancels a local switch during %s without discarding messages',
  async phase => {
    const abort = new AbortController();
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const queued = [{ message: 'keep me', mode: { localId: 'queued-1' } }];
    const discarded: string[] = [];
    terminal.close.mockReset();
    terminal.question.mockReset().mockImplementation(() => abort.abort());
    if (phase === 'before-switch') abort.abort();

    try {
      const result = await discardQueuedAndPendingForLocalSwitch({
        queue: { queue: queued, size: () => queued.length, reset: () => { queued.length = 0; } },
        getServerPendingCount: async () => {
          if (phase === 'pending-read') abort.abort();
          return 1;
        },
        discardServerPending: async () => { discarded.push('server'); return 1; },
        markQueuedAsDiscarded: async () => { discarded.push('queued'); },
        sendStatusMessage: () => {},
        formatError: String,
        signal: abort.signal,
      });

      expect(result).toBe('cancelled');
      expect(queued).toHaveLength(1);
      expect(discarded).toEqual([]);
      if (phase === 'prompt') expect(terminal.close).toHaveBeenCalled();
      else expect(terminal.question).not.toHaveBeenCalled();
    } finally {
      if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  },
  2_000,
);

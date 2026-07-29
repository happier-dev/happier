import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

type StreamState = { finished: boolean };
const streamStates: StreamState[] = [];

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    createWriteStream: () => {
      const state: StreamState = { finished: false };
      streamStates.push(state);
      return new Writable({
        write(_chunk, _encoding, callback) {
          setTimeout(callback, 1);
        },
        final(callback) {
          setTimeout(() => {
            state.finished = true;
            callback();
          }, 60);
        },
      });
    },
  };
});

import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';

describe('providers: runLoggedCommand stream drain', () => {
  it('waits for log streams to finish before resolving', async () => {
    streamStates.length = 0;

    await runLoggedCommand({
      command: process.execPath,
      args: ['-e', "process.stdout.write('ok\\n'); process.stderr.write('warn\\n');"],
      cwd: process.cwd(),
      stdoutPath: '/tmp/run-logged-command-stdout.log',
      stderrPath: '/tmp/run-logged-command-stderr.log',
      timeoutMs: 10_000,
    });

    expect(streamStates.length).toBe(2);
    expect(streamStates.every((state) => state.finished)).toBe(true);
  });
});
